import "../env.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "../db/index.js";
import { pub, redis, sub } from "../redis.js";
import { authorizePendingDmGrants, canAgentManageCoordinatedTask, checkReplyGrant, claimReplyCoordination, decideReply, ensureReplyRecipients, finishReplyPublication, markReplyMessagesObserved, reserveReplyGrant } from "./replyCoordination.js";
import { assignTask, createMessage, getOrCreateThread } from "./core.js";

after(async () => {
  await Promise.all([redis.quit(), pub.quit(), sub.quit()]);
  await sql.end();
});

async function fixture(label: string) {
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const [user] = await db.insert(schema.users).values({ name: `u-${suffix}`, displayName: "User", email: `${suffix}@test.invalid` }).returning();
  const [server] = await db.insert(schema.servers).values({ name: suffix, slug: suffix, ownerId: user!.id }).returning();
  const [channel] = await db.insert(schema.channels).values({ serverId: server!.id, name: `ch-${suffix}`, type: "channel" }).returning();
  const agents = await db.insert(schema.agents).values(["codex", "codex2", "worker"].map((name) => ({
    serverId: server!.id, name: `${name}-${suffix}`, displayName: name,
  }))).returning();
  await db.insert(schema.channelMembers).values([
    { channelId: channel!.id, memberType: "user", memberId: user!.id },
    ...agents.map((a) => ({ channelId: channel!.id, memberType: "agent", memberId: a.id })),
  ]);
  const makeMessage = async (seq: number) => (await db.insert(schema.messages).values({
    seq, serverId: server!.id, channelId: channel!.id, senderType: "user", senderId: user!.id,
    senderName: user!.name, content: `trigger ${seq}`,
  }).returning())[0]!;
  const cleanup = async () => {
    const channelIds = (await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, server!.id))).map((c) => c.id);
    const messageIds = (await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, server!.id))).map((m) => m.id);
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, server!.id));
    if (messageIds.length) await db.delete(schema.messageMentions).where(inArray(schema.messageMentions.messageId, messageIds));
    await db.delete(schema.messages).where(eq(schema.messages.serverId, server!.id));
    if (channelIds.length) await db.delete(schema.channelMembers).where(inArray(schema.channelMembers.channelId, channelIds));
    await db.delete(schema.channels).where(eq(schema.channels.serverId, server!.id));
    await db.delete(schema.agents).where(eq(schema.agents.serverId, server!.id));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, server!.id));
    await db.delete(schema.servers).where(eq(schema.servers.id, server!.id));
    await db.delete(schema.users).where(eq(schema.users.id, user!.id));
  };
  return { user: user!, server: server!, channel: channel!, agents, makeMessage, cleanup };
}

test("directed message is observed by all recipients but grants one primary", async () => {
  const f = await fixture("observe");
  try {
    const message = await f.makeMessage(9_100_001);
    const [codex, codex2, worker] = f.agents;
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: message.id, recipients: [
      { agentId: codex!.id, attention: "direct" },
      { agentId: codex2!.id, attention: "ambient" },
      { agentId: worker!.id, attention: "ambient" },
    ] });
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: message.id, recipients: [
      { agentId: codex!.id, attention: "direct" }, { agentId: codex2!.id, attention: "ambient" }, { agentId: worker!.id, attention: "ambient" },
    ] });
    for (const agent of f.agents) await markReplyMessagesObserved(agent.id, [message.id, message.id]);
    const rows = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, message.id));
    assert.equal(rows.length, 3, "reconnect/idempotent ensure must not duplicate recipients");
    assert.equal(rows.filter((r) => r.observedAt).length, 3);
    assert.deepEqual(rows.filter((r) => r.grantStatus === "active").map((r) => [r.agentId, r.grantSlot]), [[codex!.id, "primary"]]);
  } finally { await f.cleanup(); }
});

test("active addressed grants treat publication as implicit acceptance", async () => {
  const f = await fixture("implicit-accept");
  try {
    const [codex] = f.agents;
    for (const [offset, attention] of (["direct", "dm", "assigned"] as const).entries()) {
      const message = await f.makeMessage(9_100_030 + offset);
      await ensureReplyRecipients({
        serverId: f.server.id,
        channelId: f.channel.id,
        messageId: message.id,
        recipients: [{ agentId: codex!.id, attention }],
      });
      await markReplyMessagesObserved(codex!.id, [message.id]);

      assert.deepEqual(
        await reserveReplyGrant({ serverId: f.server.id, agentId: codex!.id, messageId: message.id, channelId: f.channel.id }),
        { ok: true, slot: "primary" },
      );
      const [row] = await db.select().from(schema.agentMessageDecisions).where(and(
        eq(schema.agentMessageDecisions.messageId, message.id),
        eq(schema.agentMessageDecisions.agentId, codex!.id),
      ));
      assert.equal(row?.decision, "accepted", `${attention} publication records an implicit accept`);
      assert.equal(row?.grantStatus, "publishing");
    }
  } finally { await f.cleanup(); }
});

test("DM grants are pre-authorized while channel recipients still decide", async () => {
  const f = await fixture("dm-authorized");
  try {
    const [codex, codex2, worker] = f.agents;
    const message = await f.makeMessage(9_100_033);
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: message.id, recipients: [
      { agentId: codex!.id, attention: "dm" },
      { agentId: codex2!.id, attention: "direct" },
      { agentId: worker!.id, attention: "ambient" },
    ] });
    const first = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, message.id));
    const dmRow = first.find((r) => r.agentId === codex!.id);
    assert.equal(dmRow?.decision, "accepted");
    assert.equal(dmRow?.reasonCode, "dm_auto_authorized");
    assert.ok(dmRow?.decidedAt);
    assert.equal(first.find((r) => r.agentId === codex2!.id)?.decision, "pending");
    assert.equal(first.find((r) => r.agentId === worker!.id)?.decision, "pending");

    await db.update(schema.agentMessageDecisions).set({ decision: "pending", decidedAt: null }).where(and(
      eq(schema.agentMessageDecisions.messageId, message.id),
      eq(schema.agentMessageDecisions.agentId, codex!.id),
    ));
    assert.equal(await authorizePendingDmGrants(codex!.id), 1);
    const [upgraded] = await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, message.id),
      eq(schema.agentMessageDecisions.agentId, codex!.id),
    ));
    assert.equal(upgraded?.decision, "accepted", "existing active pending DMs are upgraded on check");
    assert.equal(upgraded?.reasonCode, "dm_auto_authorized");
    assert.equal(await authorizePendingDmGrants(codex!.id), 0, "the upgrade is idempotent");
  } finally { await f.cleanup(); }
});

test("every explicit mention can accept one independent directed reply", async () => {
  const f = await fixture("multi-directed");
  try {
    const message = await f.makeMessage(9_100_010);
    const [codex, codex2, worker] = f.agents;
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: message.id, recipients: [
      { agentId: codex!.id, attention: "direct" },
      { agentId: codex2!.id, attention: "direct" },
      { agentId: worker!.id, attention: "direct" },
    ] });
    for (const agent of f.agents) await markReplyMessagesObserved(agent.id, [message.id]);

    const primary = await decideReply({ serverId: f.server.id, agentId: codex!.id, messageId: message.id, decision: "accept" });
    const contributor = await decideReply({ serverId: f.server.id, agentId: codex2!.id, messageId: message.id, decision: "accept" });
    const secondContributor = await decideReply({ serverId: f.server.id, agentId: worker!.id, messageId: message.id, decision: "accept" });
    assert.equal(primary.ok, true);
    assert.equal(contributor.ok, true);
    assert.equal(secondContributor.ok, true);
    if (primary.ok) assert.equal(primary.row.grantSlot, "primary");
    if (contributor.ok) assert.equal(contributor.row.grantSlot, "directed");
    if (secondContributor.ok) assert.equal(secondContributor.row.grantSlot, "directed");

    assert.deepEqual(await reserveReplyGrant({ serverId: f.server.id, agentId: codex!.id, messageId: message.id, channelId: f.channel.id }), { ok: true, slot: "primary" });
    assert.deepEqual(await reserveReplyGrant({ serverId: f.server.id, agentId: codex2!.id, messageId: message.id, channelId: f.channel.id }), { ok: true, slot: "directed" });
    assert.deepEqual(await reserveReplyGrant({ serverId: f.server.id, agentId: worker!.id, messageId: message.id, channelId: f.channel.id }), { ok: true, slot: "directed" });
    const [reply1] = await db.insert(schema.messages).values({
      seq: 9_100_011, serverId: f.server.id, channelId: f.channel.id, senderType: "agent", senderId: codex!.id,
      senderName: codex!.name, content: "backend", replyToMessageId: message.id, replyGrantSlot: "primary",
    }).returning();
    const [reply2] = await db.insert(schema.messages).values({
      seq: 9_100_012, serverId: f.server.id, channelId: f.channel.id, senderType: "agent", senderId: codex2!.id,
      senderName: codex2!.name, content: "frontend", replyToMessageId: message.id, replyGrantSlot: "directed",
    }).returning();
    const [reply3] = await db.insert(schema.messages).values({
      seq: 9_100_013, serverId: f.server.id, channelId: f.channel.id, senderType: "agent", senderId: worker!.id,
      senderName: worker!.name, content: "review", replyToMessageId: message.id, replyGrantSlot: "directed",
    }).returning();
    await finishReplyPublication({ messageId: message.id, agentId: codex!.id, replyMessageId: reply1!.id });
    await finishReplyPublication({ messageId: message.id, agentId: codex2!.id, replyMessageId: reply2!.id });
    await finishReplyPublication({ messageId: message.id, agentId: worker!.id, replyMessageId: reply3!.id });

    await assert.rejects(() => db.insert(schema.messages).values({
      seq: 9_100_014, serverId: f.server.id, channelId: f.channel.id, senderType: "agent", senderId: codex2!.id,
      senderName: codex2!.name, content: "duplicate frontend", replyToMessageId: message.id, replyGrantSlot: "directed",
    }), (e: any) => (e?.cause?.code ?? e?.code) === "23505");
  } finally { await f.cleanup(); }
});

test("task grants publish only in the task thread and reserve the claim for the primary", async () => {
  const f = await fixture("task-target");
  try {
    const [codex, codex2] = f.agents;
    const task = (await db.insert(schema.messages).values({
      seq: 9_100_015, serverId: f.server.id, channelId: f.channel.id, senderType: "user", senderId: f.user.id,
      senderName: f.user.name, content: "split task", taskStatus: "todo", taskNumber: 1,
    }).returning())[0]!;
    const thread = await getOrCreateThread(f.server.id, task.id, { type: "user", id: f.user.id });
    await db.update(schema.messages).set({ threadId: thread.id }).where(eq(schema.messages.id, task.id));
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: task.id, recipients: [
      { agentId: codex!.id, attention: "direct" }, { agentId: codex2!.id, attention: "direct" },
    ] });
    await markReplyMessagesObserved(codex!.id, [task.id]);
    await markReplyMessagesObserved(codex2!.id, [task.id]);
    await decideReply({ serverId: f.server.id, agentId: codex!.id, messageId: task.id, decision: "accept" });
    await decideReply({ serverId: f.server.id, agentId: codex2!.id, messageId: task.id, decision: "accept" });

    assert.deepEqual(await checkReplyGrant({ serverId: f.server.id, agentId: codex!.id, messageId: task.id, channelId: f.channel.id }), { ok: false, code: "REPLY_TARGET_MISMATCH" });
    assert.deepEqual(await checkReplyGrant({ serverId: f.server.id, agentId: codex!.id, messageId: task.id, channelId: thread.id }), { ok: true, slot: "primary" });
    assert.equal(await canAgentManageCoordinatedTask(task.id, codex!.id), true);
    assert.equal(await canAgentManageCoordinatedTask(task.id, codex2!.id), false);
  } finally { await f.cleanup(); }
});

test("mistaken mention transfers primary only after better_fit request", async () => {
  const f = await fixture("delegate");
  try {
    const message = await f.makeMessage(9_100_002);
    const [codex, codex2] = f.agents;
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: message.id, recipients: [
      { agentId: codex!.id, attention: "direct" }, { agentId: codex2!.id, attention: "ambient" },
    ] });
    await markReplyMessagesObserved(codex!.id, [message.id]);
    await markReplyMessagesObserved(codex2!.id, [message.id]);
    const request = await decideReply({ serverId: f.server.id, agentId: codex2!.id, messageId: message.id, decision: "request_reply", reason: "better_fit", summary: "humor specialist" });
    assert.equal(request.ok, true);
    if (request.ok) {
      assert.equal(request.row.grantStatus, "none");
      assert.equal(request.notifyAgentId, codex!.id);
    }
    const ownerUpdates = (await Promise.all([
      claimReplyCoordination(codex!.id),
      claimReplyCoordination(codex!.id),
    ])).flat();
    assert.deepEqual(ownerUpdates.map((u) => [u.kind, u.requesterAgentId, u.reasonCode]), [["request", codex2!.id, "better_fit"]]);
    assert.equal((await claimReplyCoordination(codex!.id)).length, 0);
    assert.deepEqual(await reserveReplyGrant({ serverId: f.server.id, agentId: codex2!.id, messageId: message.id, channelId: f.channel.id }), { ok: false, code: "REPLY_NOT_GRANTED" });
    const delegated = await decideReply({ serverId: f.server.id, agentId: codex!.id, messageId: message.id, decision: "delegate", delegateToAgentId: codex2!.id });
    assert.equal(delegated.ok, true);
    if (delegated.ok) assert.equal(delegated.promotedAgentId, codex2!.id);
    const granteeUpdates = await claimReplyCoordination(codex2!.id);
    assert.deepEqual(granteeUpdates.map((u) => [u.kind, u.messageId]), [["grant", message.id]]);
    const rows = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, message.id));
    assert.equal(rows.find((r) => r.agentId === codex!.id)?.grantStatus, "released");
    assert.equal(rows.find((r) => r.agentId === codex2!.id)?.grantStatus, "active");
    assert.equal(rows.filter((r) => r.grantStatus === "active" && r.grantSlot === "primary").length, 1);
  } finally { await f.cleanup(); }
});

test("pending better_fit blocks implicit primary acceptance and publication", async () => {
  const f = await fixture("settlement");
  try {
    const message = await f.makeMessage(9_100_020);
    const [codex, codex2] = f.agents;
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: message.id, recipients: [
      { agentId: codex!.id, attention: "direct" }, { agentId: codex2!.id, attention: "ambient" },
    ] });
    await markReplyMessagesObserved(codex!.id, [message.id]);
    await markReplyMessagesObserved(codex2!.id, [message.id]);
    await decideReply({ serverId: f.server.id, agentId: codex2!.id, messageId: message.id, decision: "request_reply", reason: "better_fit" });
    assert.deepEqual(await reserveReplyGrant({ serverId: f.server.id, agentId: codex!.id, messageId: message.id, channelId: f.channel.id }), { ok: false, code: "REPLY_COORDINATION_REQUIRED" });
  } finally { await f.cleanup(); }
});

test("a better_fit request arriving after publication reservation is denied", async () => {
  const f = await fixture("late-request");
  try {
    const message = await f.makeMessage(9_100_021);
    const [codex, codex2] = f.agents;
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: message.id, recipients: [
      { agentId: codex!.id, attention: "direct" }, { agentId: codex2!.id, attention: "ambient" },
    ] });
    await markReplyMessagesObserved(codex!.id, [message.id]);
    await markReplyMessagesObserved(codex2!.id, [message.id]);
    await decideReply({ serverId: f.server.id, agentId: codex!.id, messageId: message.id, decision: "accept" });
    await decideReply({ serverId: f.server.id, agentId: codex2!.id, messageId: message.id, decision: "no_action" });
    assert.deepEqual(await reserveReplyGrant({ serverId: f.server.id, agentId: codex!.id, messageId: message.id, channelId: f.channel.id }), { ok: true, slot: "primary" });
    assert.deepEqual(await decideReply({ serverId: f.server.id, agentId: codex2!.id, messageId: message.id, decision: "request_reply", reason: "better_fit" }), { ok: false, code: "PRIMARY_ALREADY_PUBLISHED" });
  } finally { await f.cleanup(); }
});

test("primary abstention promotes the oldest better_fit request", async () => {
  const f = await fixture("abstain");
  try {
    const message = await f.makeMessage(9_100_003);
    const [codex, codex2, worker] = f.agents;
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: message.id, recipients: [
      { agentId: codex!.id, attention: "direct" }, { agentId: codex2!.id, attention: "ambient" }, { agentId: worker!.id, attention: "ambient" },
    ] });
    for (const agent of f.agents) await markReplyMessagesObserved(agent.id, [message.id]);
    await decideReply({ serverId: f.server.id, agentId: codex2!.id, messageId: message.id, decision: "request_reply", reason: "better_fit" });
    await decideReply({ serverId: f.server.id, agentId: worker!.id, messageId: message.id, decision: "request_reply", reason: "better_fit" });
    const result = await decideReply({ serverId: f.server.id, agentId: codex!.id, messageId: message.id, decision: "abstain" });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.promotedAgentId, codex2!.id);
  } finally { await f.cleanup(); }
});

test("ambient primary requests and publication reservations are race-safe", async () => {
  const f = await fixture("race");
  try {
    const message = await f.makeMessage(9_100_004);
    const [codex, codex2] = f.agents;
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: message.id, recipients: [
      { agentId: codex!.id, attention: "ambient" }, { agentId: codex2!.id, attention: "ambient" },
    ] });
    await markReplyMessagesObserved(codex!.id, [message.id]);
    await markReplyMessagesObserved(codex2!.id, [message.id]);
    const intents = await Promise.all([
      decideReply({ serverId: f.server.id, agentId: codex!.id, messageId: message.id, decision: "request_reply", reason: "ownership" }),
      decideReply({ serverId: f.server.id, agentId: codex2!.id, messageId: message.id, decision: "request_reply", reason: "ownership" }),
    ]);
    assert.equal(intents.filter((r) => r.ok).length, 1);
    const owner = (await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, message.id), eq(schema.agentMessageDecisions.grantStatus, "active"),
    )))[0]!;
    const reservations = await Promise.all([
      reserveReplyGrant({ serverId: f.server.id, agentId: owner.agentId, messageId: message.id, channelId: f.channel.id }),
      reserveReplyGrant({ serverId: f.server.id, agentId: owner.agentId, messageId: message.id, channelId: f.channel.id }),
    ]);
    assert.equal(reservations.filter((r) => r.ok).length, 1);
    const [reply] = await db.insert(schema.messages).values({
      seq: 9_100_005, serverId: f.server.id, channelId: f.channel.id, senderType: "agent", senderId: owner.agentId,
      senderName: "winner", content: "one reply", replyToMessageId: message.id, replyGrantSlot: "primary",
    }).returning();
    await finishReplyPublication({ messageId: message.id, agentId: owner.agentId, replyMessageId: reply!.id });
    assert.deepEqual(await reserveReplyGrant({ serverId: f.server.id, agentId: owner.agentId, messageId: message.id, channelId: f.channel.id }), { ok: false, code: "REPLY_GRANT_CONSUMED" });
    await assert.rejects(() => db.insert(schema.messages).values({
      seq: 9_100_006, serverId: f.server.id, channelId: f.channel.id, senderType: "agent", senderId: owner.agentId,
      senderName: "loser", content: "duplicate", replyToMessageId: message.id, replyGrantSlot: "primary",
    }), (e: any) => (e?.cause?.code ?? e?.code) === "23505");
  } finally { await f.cleanup(); }
});

test("supplemental grant is limited to evidence-bearing reasons and one slot", async () => {
  const f = await fixture("supplemental");
  try {
    const message = await f.makeMessage(9_100_007);
    const [codex, codex2, worker] = f.agents;
    await ensureReplyRecipients({ serverId: f.server.id, channelId: f.channel.id, messageId: message.id, recipients: [
      { agentId: codex!.id, attention: "direct" }, { agentId: codex2!.id, attention: "ambient" }, { agentId: worker!.id, attention: "ambient" },
    ] });
    for (const agent of f.agents) await markReplyMessagesObserved(agent.id, [message.id]);
    const correction = await decideReply({ serverId: f.server.id, agentId: codex2!.id, messageId: message.id, decision: "request_reply", reason: "correction" });
    assert.equal(correction.ok, true);
    if (correction.ok) assert.equal(correction.row.grantSlot, "supplemental");
    const duplicate = await decideReply({ serverId: f.server.id, agentId: worker!.id, messageId: message.id, decision: "request_reply", reason: "new_evidence" });
    assert.deepEqual(duplicate, { ok: false, code: "SUPPLEMENTAL_ALREADY_ASSIGNED" });
  } finally { await f.cleanup(); }
});

test("thread messages and task assignments stay observable with directed grants", async () => {
  const f = await fixture("thread-task");
  try {
    const [codex, codex2, worker] = f.agents;
    const parent = await f.makeMessage(9_100_008);
    const thread = await getOrCreateThread(f.server.id, parent.id, { type: "user", id: f.user.id });
    await db.insert(schema.channelMembers).values(f.agents.map((a) => ({ channelId: thread.id, memberType: "agent", memberId: a.id }))).onConflictDoNothing();
    const threadMessage = await createMessage({
      serverId: f.server.id, channelId: thread.id, senderType: "user", senderId: f.user.id,
      senderName: f.user.name, content: `thread question @${codex!.name}`,
    });
    await ensureReplyRecipients({ serverId: f.server.id, channelId: thread.id, messageId: threadMessage.id, recipients: [
      { agentId: codex2!.id, attention: "ambient" }, { agentId: worker!.id, attention: "ambient" },
    ] });
    const threadRows = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, threadMessage.id));
    assert.equal(threadRows.length, 3);
    assert.equal(threadRows.find((r) => r.agentId === codex!.id)?.grantSlot, "primary");
    assert.equal(threadRows.find((r) => r.agentId === codex!.id)?.grantStatus, "reserved", "responsibility stays reserved until Turn dispatch starts");
    assert.equal(threadRows.find((r) => r.agentId === codex2!.id)?.attention, "ambient");
    assert.equal(threadRows.find((r) => r.agentId === worker!.id)?.attention, "ambient");

    const task = (await db.insert(schema.messages).values({
      seq: 9_100_009, serverId: f.server.id, channelId: f.channel.id, senderType: "user", senderId: f.user.id,
      senderName: f.user.name, content: "make a task", taskStatus: "todo", taskNumber: 1,
    }).returning())[0]!;
    const assigned = await assignTask(f.server.id, task.id, codex2!.id, { type: "user", id: f.user.id });
    assert.equal(assigned?.taskAssigneeId, codex2!.id);
    const assignment = (await db.select().from(schema.messages).where(and(
      eq(schema.messages.serverId, f.server.id), eq(schema.messages.channelId, assigned!.threadId!), eq(schema.messages.senderType, "system"),
    ))).find((m) => m.content.includes("assigned"));
    assert.ok(assignment);
    const [decision] = await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, assignment!.id), eq(schema.agentMessageDecisions.agentId, codex2!.id),
    ));
    assert.equal(decision?.attention, "assigned");
    assert.equal(decision?.grantSlot, "primary");
    assert.equal(decision?.grantStatus, "released");
    await markReplyMessagesObserved(codex2!.id, [assignment!.id]);
    const reacquired = await decideReply({ serverId: f.server.id, agentId: codex2!.id, messageId: assignment!.id, decision: "request_reply", reason: "ownership" });
    assert.equal(reacquired.ok, true, "a reconnected assignee can reacquire a released provisional grant");
    const [observed] = await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, assignment!.id), eq(schema.agentMessageDecisions.agentId, codex2!.id),
    ));
    assert.ok(observed?.observedAt);
    assert.equal(observed?.grantStatus, "active");
  } finally { await f.cleanup(); }
});

test("multi-mention order chooses a primary plus directed contributors and a DM stays directly observable", async () => {
  const f = await fixture("multi-dm");
  try {
    const [codex, codex2, worker] = f.agents;
    const multi = await createMessage({
      serverId: f.server.id, channelId: f.channel.id, senderType: "user", senderId: f.user.id,
      senderName: f.user.name, content: `compare @${codex2!.name} and @${codex!.name}`,
    });
    const multiRows = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, multi.id));
    assert.equal(multiRows.find((r) => r.agentId === codex2!.id)?.grantSlot, "primary", "first explicit mention owns priority");
    assert.equal(multiRows.find((r) => r.agentId === codex2!.id)?.grantStatus, "reserved");
    assert.equal(multiRows.find((r) => r.agentId === codex!.id)?.attention, "direct");
    assert.equal(multiRows.find((r) => r.agentId === codex!.id)?.grantSlot, "directed");
    assert.equal(multiRows.find((r) => r.agentId === codex!.id)?.grantStatus, "reserved");
    assert.equal(multiRows.find((r) => r.agentId === worker!.id), undefined, "unmentioned observers create an ambient audit row only when they actually check");

    const [dm] = await db.insert(schema.channels).values({ serverId: f.server.id, name: `dm:${f.user.id}:${codex!.id}`, type: "dm" }).returning();
    await db.insert(schema.channelMembers).values([
      { channelId: dm!.id, memberType: "user", memberId: f.user.id },
      { channelId: dm!.id, memberType: "agent", memberId: codex!.id },
    ]);
    const dmMessage = await createMessage({
      serverId: f.server.id, channelId: dm!.id, senderType: "user", senderId: f.user.id,
      senderName: f.user.name, content: "private question",
    });
    const [dmDecision] = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, dmMessage.id));
    assert.equal(dmDecision?.attention, "dm");
    assert.equal(dmDecision?.grantSlot, "primary");
    assert.equal(dmDecision?.grantStatus, "reserved");
  } finally { await f.cleanup(); }
});
