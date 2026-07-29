import "../env.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "../db/index.js";
import { ensureReplyRecipients, finishReplyPublication, markReplyMessagesObserved, reserveReplyGrant } from "./replyCoordination.js";
import {
  activateConversationTurnDispatch,
  attachMessageToConversationTurn,
  canonicalReplyTriggerMessageId,
  claimCausalAgentWake,
  claimConversationTurnDispatch,
  conversationTurnForMessage,
  finishConversationTurnDispatch,
  renewConversationTurnDispatchLease,
  retryConversationTurnDispatch,
} from "./conversationTurns.js";
import { dispatchConversationTurn, prepareConversationTurnResponsibility, type ConversationTurnDispatchDeps, type DispatchMember } from "./conversationTurnDispatch.js";
import { acceptAgentDeliveryAck, rejectAgentDeliveryAck } from "./agentDeliveryAck.js";
import { DELIVERY_ADMISSION_CAPABILITY, registerDaemon, registerDaemonCapabilities, registerMachineConn, unregisterDaemon, unregisterMachineConn } from "./daemonHub.js";
import { handleConversationTurnDaemonTopologyChange } from "./conversationTurnRecovery.js";
import { commitAgentDeliveryAdmission, releaseAgentDeliveryAdmission } from "./agentDeliveryAdmission.js";
import type { WebSocket } from "ws";

after(async () => { await sql.end(); });

async function commitAndAcceptDelivery(deliveryId: string): Promise<boolean> {
  const separator = deliveryId.lastIndexOf(":");
  const turnId = deliveryId.slice(0, separator);
  const agentId = deliveryId.slice(separator + 1);
  const [turn] = await db.select({ triggerMessageId: schema.conversationTurns.triggerMessageId }).from(schema.conversationTurns)
    .where(eq(schema.conversationTurns.id, turnId)).limit(1);
  assert.ok(turn, `missing Turn for delivery ${deliveryId}`);
  await db.update(schema.agentMessageDecisions).set({ deliveryAdmittedAt: new Date(), updatedAt: new Date() }).where(and(
    eq(schema.agentMessageDecisions.messageId, turn.triggerMessageId),
    eq(schema.agentMessageDecisions.agentId, agentId),
  ));
  return acceptAgentDeliveryAck(deliveryId);
}

async function fixture(label: string) {
  const suffix = `${label}-${randomUUID().slice(0, 8)}`;
  const humans = await db.insert(schema.users).values(["alice", "bob"].map((name) => ({
    name: `${name}-${suffix}`, displayName: name, email: `${name}-${suffix}@test.invalid`,
  }))).returning();
  const [server] = await db.insert(schema.servers).values({ name: suffix, slug: suffix, ownerId: humans[0]!.id }).returning();
  const channels = await db.insert(schema.channels).values([
    { serverId: server!.id, name: `all-${suffix}`, type: "channel" },
    { serverId: server!.id, name: `thread-${suffix}`, type: "thread" },
    { serverId: server!.id, name: `dm-${suffix}`, type: "dm" },
  ]).returning();
  const agents = await db.insert(schema.agents).values(["codex", "codex2"].map((name) => ({
    serverId: server!.id, name: `${name}-${suffix}`, displayName: name,
  }))).returning();
  let seq = 9_300_000;
  const message = async (channelId: string, senderType: "user" | "agent", senderId: string, senderName: string, content: string, replyToMessageId?: string) =>
    (await db.insert(schema.messages).values({
      seq: ++seq, serverId: server!.id, channelId, senderType, senderId, senderName, content,
      replyToMessageId: replyToMessageId ?? null,
    }).returning())[0]!;
  const attach = async (m: typeof schema.messages.$inferSelect, boundaryKind: "ambient" | "direct" | "task" | "action", now: Date, replyToMessageId?: string, mergeDirect = false) =>
    attachMessageToConversationTurn({
      serverId: server!.id, channelId: m.channelId, senderType: m.senderType as "user" | "agent",
      senderId: m.senderId!, messageId: m.id, seq: m.seq, boundaryKind, now, replyToMessageId, mergeDirect,
    });
  const cleanup = async () => {
    const messageIds = (await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, server!.id))).map((m) => m.id);
    await db.delete(schema.causalEdges).where(eq(schema.causalEdges.serverId, server!.id));
    await db.delete(schema.agentMessageObservations).where(eq(schema.agentMessageObservations.serverId, server!.id));
    await db.delete(schema.agentActivityLog).where(eq(schema.agentActivityLog.serverId, server!.id));
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, server!.id));
    if (messageIds.length) await db.delete(schema.messageMentions).where(inArray(schema.messageMentions.messageId, messageIds));
    await db.delete(schema.messages).where(eq(schema.messages.serverId, server!.id));
    await db.delete(schema.conversationTurns).where(eq(schema.conversationTurns.serverId, server!.id));
    await db.delete(schema.channels).where(eq(schema.channels.serverId, server!.id));
    await db.delete(schema.agents).where(eq(schema.agents.serverId, server!.id));
    await db.delete(schema.servers).where(eq(schema.servers.id, server!.id));
    await db.delete(schema.users).where(inArray(schema.users.id, humans.map((u) => u.id)));
  };
  return { server: server!, humans, agents, channels, message, attach, cleanup };
}

test("quiet windows are isolated by channel and exact human or agent sender", async () => {
  const f = await fixture("partition");
  try {
    const t0 = new Date("2026-07-24T00:00:00.000Z");
    const t1 = new Date(t0.getTime() + 100);
    const channel = f.channels[0]!;
    const alice1 = await f.message(channel.id, "user", f.humans[0]!.id, f.humans[0]!.name, "帮我查一下");
    const alice2 = await f.message(channel.id, "user", f.humans[0]!.id, f.humans[0]!.name, "看生产日志");
    const bob = await f.message(channel.id, "user", f.humans[1]!.id, f.humans[1]!.name, "我问另一个问题");
    const codex1 = await f.message(channel.id, "agent", f.agents[0]!.id, f.agents[0]!.name, "开始处理");
    const codex2 = await f.message(channel.id, "agent", f.agents[0]!.id, f.agents[0]!.name, "补充进度");
    const otherAgent = await f.message(channel.id, "agent", f.agents[1]!.id, f.agents[1]!.name, "独立结果");

    const a1 = await f.attach(alice1, "ambient", t0);
    const a2 = await f.attach(alice2, "ambient", t1);
    const b = await f.attach(bob, "ambient", t1);
    const c1 = await f.attach(codex1, "ambient", t0);
    const c2 = await f.attach(codex2, "ambient", t1);
    const other = await f.attach(otherAgent, "ambient", t1);

    assert.equal(a2.turn.id, a1.turn.id, "same human in the same channel merges");
    assert.notEqual(b.turn.id, a1.turn.id, "another human owns another quiet window");
    assert.equal(c2.turn.id, c1.turn.id, "same agent in the same channel merges");
    assert.notEqual(other.turn.id, c1.turn.id, "another agent owns another quiet window");
    assert.equal((await conversationTurnForMessage(alice2.id))?.id, a1.turn.id);
  } finally { await f.cleanup(); }
});

test("thread, DM, timeout, and explicit work boundaries never cross-merge", async () => {
  const f = await fixture("boundaries");
  try {
    const t0 = new Date("2026-07-24T00:00:00.000Z");
    const human = f.humans[0]!;
    const channelMessage = await f.message(f.channels[0]!.id, "user", human.id, human.name, "频道");
    const threadMessage = await f.message(f.channels[1]!.id, "user", human.id, human.name, "线程");
    const dmMessage = await f.message(f.channels[2]!.id, "user", human.id, human.name, "私信");
    const channelTurn = await f.attach(channelMessage, "ambient", t0);
    const threadTurn = await f.attach(threadMessage, "ambient", t0);
    const dmTurn = await f.attach(dmMessage, "ambient", t0);
    assert.equal(new Set([channelTurn.turn.id, threadTurn.turn.id, dmTurn.turn.id]).size, 3);

    const direct = await f.message(f.channels[0]!.id, "user", human.id, human.name, `@${f.agents[0]!.name} 处理`);
    const directTurn = await f.attach(direct, "direct", new Date(t0.getTime() + 100));
    assert.notEqual(directTurn.turn.id, channelTurn.turn.id, "incoming mention seals the ambient turn");
    assert.deepEqual(directTurn.sealedTurnIds, [channelTurn.turn.id]);
    const supplement = await f.message(f.channels[0]!.id, "user", human.id, human.name, "这里是补充");
    assert.equal((await f.attach(supplement, "ambient", new Date(t0.getTime() + 200))).turn.id, directTurn.turn.id);

    const expired = await f.message(f.channels[0]!.id, "user", human.id, human.name, "窗口之后的新问题");
    const expiredTurn = await f.attach(expired, "ambient", new Date(t0.getTime() + 5_000));
    assert.notEqual(expiredTurn.turn.id, directTurn.turn.id);
  } finally { await f.cleanup(); }
});

test("DM direct messages merge by sender while mention boundaries remain distinct", async () => {
  const f = await fixture("dm-window");
  try {
    const t0 = new Date("2026-07-24T00:00:00.000Z");
    const human = f.humans[0]!;
    const first = await f.message(f.channels[2]!.id, "user", human.id, human.name, "hello");
    const second = await f.message(f.channels[2]!.id, "user", human.id, human.name, "你在吗");
    const firstTurn = await f.attach(first, "direct", t0, undefined, true);
    const secondTurn = await f.attach(second, "direct", new Date(t0.getTime() + 100), undefined, true);
    assert.equal(secondTurn.turn.id, firstTurn.turn.id, "ordinary messages in the same DM share its direct quiet window");

    const rootMessage1 = await f.message(f.channels[0]!.id, "user", human.id, human.name, "root one");
    const rootMessage2 = await f.message(f.channels[0]!.id, "user", human.id, human.name, "root two");
    const root1 = await f.attach(rootMessage1, "direct", t0);
    const root2 = await f.attach(rootMessage2, "direct", new Date(t0.getTime() + 10));
    const source = f.agents[0]!;
    const reply1 = await f.message(f.channels[2]!.id, "agent", source.id, source.name, "reply one", rootMessage1.id);
    const reply2 = await f.message(f.channels[2]!.id, "agent", source.id, source.name, "reply two", rootMessage2.id);
    const agentTurn1 = await f.attach(reply1, "direct", new Date(t0.getTime() + 20), rootMessage1.id, true);
    const unrootedSupplement = await f.message(f.channels[2]!.id, "agent", source.id, source.name, "new unrooted work");
    const unrootedTurn = await f.attach(unrootedSupplement, "direct", new Date(t0.getTime() + 25), undefined, true);
    assert.notEqual(unrootedTurn.turn.id, agentTurn1.turn.id, "an unrooted agent DM cannot inherit the previous reply root");
    assert.equal(unrootedTurn.turn.causalDepth, 0);
    assert.equal(unrootedTurn.turn.causalRootId, unrootedTurn.turn.id);
    const agentTurn2 = await f.attach(reply2, "direct", new Date(t0.getTime() + 30), rootMessage2.id, true);
    assert.notEqual(root1.turn.causalRootId, root2.turn.causalRootId);
    assert.notEqual(agentTurn2.turn.id, agentTurn1.turn.id, "agent replies to different causal roots cannot share a DM Turn");
    assert.equal(agentTurn1.turn.causalRootId, root1.turn.causalRootId);
    assert.equal(agentTurn2.turn.causalRootId, root2.turn.causalRootId);

    const chainParentMessage = await f.message(f.channels[0]!.id, "agent", f.agents[1]!.id, f.agents[1]!.name, "chain parent", rootMessage1.id);
    const chainParent = await f.attach(chainParentMessage, "direct", new Date(t0.getTime() + 40), rootMessage1.id);
    const depthOneReply = await f.message(f.channels[2]!.id, "agent", source.id, source.name, "depth one again", rootMessage1.id);
    const depthOneTurn = await f.attach(depthOneReply, "direct", new Date(t0.getTime() + 45), rootMessage1.id, true);
    const depthTwoReply = await f.message(f.channels[2]!.id, "agent", source.id, source.name, "depth two", chainParentMessage.id);
    const depthTwoTurn = await f.attach(depthTwoReply, "direct", new Date(t0.getTime() + 50), chainParentMessage.id, true);
    assert.equal(depthTwoTurn.turn.causalRootId, depthOneTurn.turn.causalRootId);
    assert.equal(depthTwoTurn.turn.causalDepth, chainParent.turn.causalDepth + 1);
    assert.notEqual(depthTwoTurn.turn.id, depthOneTurn.turn.id, "same root at a different causal depth cannot inherit an earlier Turn depth");

    const mention1 = await f.message(f.channels[0]!.id, "user", human.id, human.name, "@codex one");
    const mention2 = await f.message(f.channels[0]!.id, "user", human.id, human.name, "@codex two");
    const mentionTurn1 = await f.attach(mention1, "direct", t0);
    const mentionTurn2 = await f.attach(mention2, "direct", new Date(t0.getTime() + 100));
    assert.notEqual(mentionTurn2.turn.id, mentionTurn1.turn.id, "two explicit work boundaries do not silently coalesce");
  } finally { await f.cleanup(); }
});

test("continuous same-sender input cannot extend a Turn beyond its first-message max wait", async () => {
  const f = await fixture("max-wait");
  try {
    const t0 = new Date("2026-07-24T00:00:00.000Z");
    const human = f.humans[0]!;
    let firstTurnId = "";
    for (const offset of [0, 1_000, 2_000, 3_000, 4_000, 4_900]) {
      const message = await f.message(f.channels[0]!.id, "user", human.id, human.name, `part ${offset}`);
      const attached = await f.attach(message, "ambient", new Date(t0.getTime() + offset));
      firstTurnId ||= attached.turn.id;
      assert.equal(attached.turn.id, firstTurnId);
      assert.ok(attached.turn.dispatchAfter.getTime() <= t0.getTime() + 5_000);
    }
    const afterMax = await f.message(f.channels[0]!.id, "user", human.id, human.name, "new work after max wait");
    const next = await f.attach(afterMax, "ambient", new Date(t0.getTime() + 5_001));
    assert.notEqual(next.turn.id, firstTurnId);
  } finally { await f.cleanup(); }
});

test("concurrent same-sender writes converge on one turn and one canonical grant", async () => {
  const f = await fixture("concurrent");
  try {
    const at = new Date("2026-07-24T00:00:00.000Z");
    const human = f.humans[0]!;
    const messages = await Promise.all(Array.from({ length: 6 }, (_, i) =>
      f.message(f.channels[0]!.id, "user", human.id, human.name, `part ${i}`)));
    const attached = await Promise.all(messages.map((m) => f.attach(m, "ambient", at)));
    assert.equal(new Set(attached.map((x) => x.turn.id)).size, 1);
    const triggerId = attached[0]!.turn.triggerMessageId;
    const latestId = messages[messages.length - 1]!.id;
    assert.equal(await canonicalReplyTriggerMessageId(latestId), triggerId);

    await ensureReplyRecipients({
      serverId: f.server.id, channelId: f.channels[0]!.id, messageId: latestId,
      recipients: [{ agentId: f.agents[0]!.id, attention: "assigned" }],
    });
    const observed = await markReplyMessagesObserved(f.agents[0]!.id, messages.map((m) => m.id));
    assert.equal(observed.size, messages.length);
    assert.equal(new Set([...observed.values()].map((r) => r.messageId)).size, 1);
    const decisions = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, f.server.id));
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0]!.messageId, triggerId);
    assert.deepEqual([decisions[0]!.attention, decisions[0]!.grantSlot, decisions[0]!.grantStatus], ["assigned", "primary", "active"]);
  } finally { await f.cleanup(); }
});

test("agent work edges are bounded and do not repeatedly wake the same pair", async () => {
  const f = await fixture("causal");
  try {
    const at = new Date("2026-07-24T00:00:00.000Z");
    const humanMessage = await f.message(f.channels[0]!.id, "user", f.humans[0]!.id, f.humans[0]!.name, "root");
    const root = await f.attach(humanMessage, "direct", at);
    const agentMessage = await f.message(f.channels[0]!.id, "agent", f.agents[0]!.id, f.agents[0]!.name, `@${f.agents[1]!.name} work`);
    const child = await f.attach(agentMessage, "direct", new Date(at.getTime() + 10), humanMessage.id);
    assert.equal(child.turn.causalRootId, root.turn.id);
    assert.equal(child.turn.causalDepth, 1);
    const concurrent = await Promise.all(Array.from({ length: 8 }, () => claimCausalAgentWake(child.turn, f.agents[1]!.id)));
    assert.deepEqual(concurrent, Array(8).fill("accepted"), "same-parent concurrent recovery is idempotent admission");
    const sameParentEdges = await db.select({ outcome: schema.causalEdges.outcome }).from(schema.causalEdges)
      .where(eq(schema.causalEdges.parentTurnId, child.turn.id));
    assert.deepEqual(sameParentEdges, [{ outcome: "accepted" }], "same-parent unique-key races do not create false duplicate audit rows");
    assert.equal(await claimCausalAgentWake(child.turn, f.agents[0]!.id), "blocked_depth", "self wake is forbidden");
  } finally { await f.cleanup(); }
});

test("reserved assignments affect load balancing and budget suppression is audited", async () => {
  const f = await fixture("load-audit");
  try {
    const at = new Date("2026-07-24T00:00:00.000Z");
    const channel = f.channels[0]!;
    const members: DispatchMember[] = [
      ...f.humans.map((human) => ({ type: "user" as const, id: human.id, name: human.name, displayName: human.displayName })),
      ...f.agents.map((agent) => ({ type: "agent" as const, id: agent.id, name: agent.name, displayName: agent.displayName })),
    ];
    const first = await f.message(channel.id, "user", f.humans[0]!.id, f.humans[0]!.name, "first ambient");
    const second = await f.message(channel.id, "user", f.humans[1]!.id, f.humans[1]!.name, "second ambient");
    const firstTurn = await f.attach(first, "ambient", at);
    const secondTurn = await f.attach(second, "ambient", at);
    await prepareConversationTurnResponsibility(firstTurn.turn, channel, members, []);
    await prepareConversationTurnResponsibility(secondTurn.turn, channel, members, []);
    const owners = await db.select({ id: schema.conversationTurns.id, owner: schema.conversationTurns.ownerAgentId })
      .from(schema.conversationTurns).where(inArray(schema.conversationTurns.id, [firstTurn.turn.id, secondTurn.turn.id]));
    assert.equal(new Set(owners.map((row) => row.owner)).size, 2, "reserved work must count before a second human Turn is assigned");

    const agentMessage = await f.message(channel.id, "agent", f.agents[0]!.id, f.agents[0]!.name, `@${f.agents[1]!.name} work`);
    const child = await f.attach(agentMessage, "direct", new Date(at.getTime() + 10), first.id);
    await db.update(schema.conversationTurns).set({ agentWakeCount: 6 }).where(eq(schema.conversationTurns.id, child.turn.causalRootId));
    assert.equal(await claimCausalAgentWake(child.turn, f.agents[1]!.id), "blocked_budget");
    const [audit] = await db.select().from(schema.causalEdges).where(and(
      eq(schema.causalEdges.parentTurnId, child.turn.id),
      eq(schema.causalEdges.outcome, "blocked_budget"),
    ));
    assert.ok(audit, "budget suppression must remain auditable");
  } finally { await f.cleanup(); }
});

test("agent DM replies complete for humans and agent-to-agent DMs consume the causal budget", async () => {
  const f = await fixture("causal-dm");
  try {
    const at = new Date("2026-07-24T00:00:00.000Z");
    const dm = f.channels[2]!;
    const source = f.agents[0]!;
    const target = f.agents[1]!;
    const human = f.humans[0]!;
    const member = (agent: typeof source): DispatchMember => ({
      type: "agent", id: agent.id, name: agent.name, displayName: agent.displayName,
    });
    let deliveries = 0;
    let members: DispatchMember[] = [member(source), { type: "user", id: human.id, name: human.name, displayName: human.displayName }];
    const deps: ConversationTurnDispatchDeps<{ ok: true }> = {
      channelMembers: async () => members,
      parseMentions: () => [],
      agentStartTarget: async () => ({ ok: true }),
      sendAgentStart: () => true,
      sendAgentDeliver: (_serverId, _target, message) => {
        deliveries++;
        queueMicrotask(() => void commitAndAcceptDelivery(String(message.deliveryId)));
        return true;
      },
      markAgentUnavailable: async () => {},
      finalizeAgentActivityRun: async () => {},
    };

    const humanRequest = await f.message(dm.id, "user", human.id, human.name, "start");
    const root = await f.attach(humanRequest, "direct", at);
    const humanReply = await f.message(dm.id, "agent", source.id, source.name, "reply to human");
    const humanReplyTurn = await f.attach(humanReply, "direct", new Date(at.getTime() + 1_000), humanRequest.id);
    await dispatchConversationTurn(humanReplyTurn.turn.id, deps);
    assert.equal((await conversationTurnForMessage(humanReply.id))?.responsibilityState, "completed");
    assert.equal(deliveries, 0, "an agent reply to a human does not manufacture a blocked delivery");

    members = [member(source), member(target)];
    const firstAgentDm = await f.message(dm.id, "agent", source.id, source.name, "agent DM work");
    const firstAgentTurn = await f.attach(firstAgentDm, "direct", new Date(at.getTime() + 2_000), humanRequest.id);
    assert.equal(firstAgentTurn.turn.causalRootId, root.turn.id);
    await dispatchConversationTurn(firstAgentTurn.turn.id, deps);
    assert.equal(deliveries, 1, "the first agent-to-agent DM is delivered");

    const repeatedAgentDm = await f.message(dm.id, "agent", source.id, source.name, "repeat same pair");
    const repeatedTurn = await f.attach(repeatedAgentDm, "direct", new Date(at.getTime() + 3_000), humanRequest.id);
    await dispatchConversationTurn(repeatedTurn.turn.id, deps);
    assert.equal(deliveries, 1, "the same source-target pair cannot re-wake within one causal root");
    const edges = await db.select({ outcome: schema.causalEdges.outcome }).from(schema.causalEdges)
      .where(eq(schema.causalEdges.rootTurnId, root.turn.id));
    assert.deepEqual(edges.map((edge) => edge.outcome).sort(), ["accepted", "duplicate"]);
  } finally { await f.cleanup(); }
});

test("a multi-recipient turn completes only after every granted reply settles", async () => {
  const f = await fixture("completion");
  try {
    const message = await f.message(f.channels[0]!.id, "user", f.humans[0]!.id, f.humans[0]!.name, "@codex @codex2 分别回答");
    const attached = await f.attach(message, "direct", new Date("2026-07-24T00:00:00.000Z"));
    await ensureReplyRecipients({
      serverId: f.server.id,
      channelId: f.channels[0]!.id,
      messageId: message.id,
      recipients: f.agents.map((agent) => ({ agentId: agent.id, attention: "direct" as const })),
    });
    const claimed = await claimConversationTurnDispatch(attached.turn.id, new Date("2026-07-24T00:00:01.000Z"));
    assert.ok(claimed);
    await finishConversationTurnDispatch(attached.turn.id, claimed.dispatchAttempts, f.agents[0]!.id, "delivered");

    assert.deepEqual(await reserveReplyGrant({ serverId: f.server.id, agentId: f.agents[1]!.id, messageId: message.id, channelId: f.channels[0]!.id }), { ok: true, slot: "directed" });
    const directedReply = await f.message(f.channels[0]!.id, "agent", f.agents[1]!.id, f.agents[1]!.name, "second perspective");
    await finishReplyPublication({ messageId: message.id, agentId: f.agents[1]!.id, replyMessageId: directedReply.id });
    assert.equal((await conversationTurnForMessage(message.id))?.responsibilityState, "delivered", "the primary grant is still active");

    assert.deepEqual(await reserveReplyGrant({ serverId: f.server.id, agentId: f.agents[0]!.id, messageId: message.id, channelId: f.channels[0]!.id }), { ok: true, slot: "primary" });
    const primaryReply = await f.message(f.channels[0]!.id, "agent", f.agents[0]!.id, f.agents[0]!.name, "primary perspective");
    await finishReplyPublication({ messageId: message.id, agentId: f.agents[0]!.id, replyMessageId: primaryReply.id });
    assert.equal((await conversationTurnForMessage(message.id))?.responsibilityState, "completed");
  } finally { await f.cleanup(); }
});

test("a reply completed while dispatch waits for ACK remains completed after finish", async () => {
  const f = await fixture("complete-before-ack");
  try {
    const at = new Date("2026-07-24T00:00:00.000Z");
    const channel = f.channels[0]!;
    const human = f.humans[0]!;
    const agent = f.agents[0]!;
    const request = await f.message(channel.id, "user", human.id, human.name, `@${agent.name} answer`);
    const attached = await f.attach(request, "direct", at);
    let deliveryId = "";
    let deliveryStarted!: () => void;
    const started = new Promise<void>((resolve) => { deliveryStarted = resolve; });
    const members: DispatchMember[] = [
      { type: "user", id: human.id, name: human.name, displayName: human.displayName },
      { type: "agent", id: agent.id, name: agent.name, displayName: agent.displayName },
    ];
    const deps: ConversationTurnDispatchDeps<{ ok: true }> = {
      channelMembers: async () => members,
      parseMentions: () => [members[1]!],
      agentStartTarget: async () => ({ ok: true }),
      sendAgentStart: () => true,
      sendAgentDeliver: (_serverId, _target, message) => {
        deliveryId = String(message.deliveryId);
        deliveryStarted();
        return true;
      },
      markAgentUnavailable: async () => {},
      finalizeAgentActivityRun: async () => {},
    };

    const dispatch = dispatchConversationTurn(attached.turn.id, deps);
    await started;
    const eagerActivity = await db.select({ id: schema.agentActivityLog.id }).from(schema.agentActivityLog).where(and(
      eq(schema.agentActivityLog.serverId, f.server.id),
      eq(schema.agentActivityLog.agentId, agent.id),
      eq(schema.agentActivityLog.streamId, `${request.id}:${agent.id}`),
    ));
    assert.equal(eagerActivity.length, 0, "dispatch admission must not masquerade as runtime Activity");
    assert.deepEqual(await reserveReplyGrant({ serverId: f.server.id, agentId: agent.id, messageId: request.id, channelId: channel.id }), { ok: true, slot: "primary" });
    const reply = await f.message(channel.id, "agent", agent.id, agent.name, "done");
    await finishReplyPublication({ messageId: request.id, agentId: agent.id, replyMessageId: reply.id });
    assert.equal((await conversationTurnForMessage(request.id))?.responsibilityState, "completed", "completion is visible before the transport ACK arrives");
    assert.equal(await commitAndAcceptDelivery(deliveryId), true);
    await dispatch;
    const settled = await conversationTurnForMessage(request.id);
    assert.deepEqual([settled?.state, settled?.responsibilityState], ["dispatched", "completed"]);
  } finally { await f.cleanup(); }
});

test("an outer failure after activation keeps the Turn and explicit grant visible", async () => {
  const f = await fixture("active-outer-failure");
  try {
    const channel = f.channels[0]!;
    const human = f.humans[0]!;
    const agent = f.agents[0]!;
    const request = await f.message(channel.id, "user", human.id, human.name, `@${agent.name} answer`);
    const attached = await f.attach(request, "direct", new Date("2026-07-24T00:00:00.000Z"));
    const agentMember: DispatchMember = { type: "agent", id: agent.id, name: agent.name, displayName: agent.displayName };
    const deps: ConversationTurnDispatchDeps<{ ok: true }> = {
      channelMembers: async () => [
        { type: "user", id: human.id, name: human.name, displayName: human.displayName },
        agentMember,
      ],
      parseMentions: () => [agentMember],
      agentStartTarget: async () => ({ ok: true }),
      sendAgentStart: () => true,
      sendAgentDeliver: () => { throw new Error("transport exploded after activation"); },
      markAgentUnavailable: async () => {},
      finalizeAgentActivityRun: async () => { throw new Error("activity storage unavailable"); },
    };

    await dispatchConversationTurn(attached.turn.id, deps);
    const current = (await conversationTurnForMessage(request.id))!;
    assert.deepEqual([current.state, current.responsibilityState], ["active", "active"], "post-activation failures must not regress to hidden ready state");
    const [decision] = await db.select({ grantStatus: schema.agentMessageDecisions.grantStatus })
      .from(schema.agentMessageDecisions).where(and(
        eq(schema.agentMessageDecisions.messageId, request.id),
        eq(schema.agentMessageDecisions.agentId, agent.id),
      ));
    assert.equal(decision?.grantStatus, "active");
  } finally { await f.cleanup(); }
});

test("multi-recipient dispatch keeps a NACKed explicit grant active and retries it without hiding the Turn", async () => {
  const f = await fixture("partial-ack");
  try {
    const at = new Date("2026-07-24T00:00:00.000Z");
    const channel = f.channels[0]!;
    const human = f.humans[0]!;
    const request = await f.message(channel.id, "user", human.id, human.name, "@codex @codex2 answer");
    const attached = await f.attach(request, "direct", at);
    const members: DispatchMember[] = [
      { type: "user", id: human.id, name: human.name, displayName: human.displayName },
      ...f.agents.map((agent) => ({ type: "agent" as const, id: agent.id, name: agent.name, displayName: agent.displayName })),
    ];
    const deliveries = new Map<string, string[]>();
    let retrying = false;
    let bothStarted!: () => void;
    const started = new Promise<void>((resolve) => { bothStarted = resolve; });
    const deps: ConversationTurnDispatchDeps<{ ok: true }> = {
      channelMembers: async () => members,
      parseMentions: () => members.filter((member) => member.type === "agent"),
      agentStartTarget: async () => ({ ok: true }),
      sendAgentStart: () => true,
      sendAgentDeliver: (_serverId, _target, message) => {
        const agentId = String(message.agentId);
        const ids = deliveries.get(agentId) ?? [];
        ids.push(String(message.deliveryId));
        deliveries.set(agentId, ids);
        if (deliveries.size === 2) bothStarted();
        if (retrying) queueMicrotask(() => void commitAndAcceptDelivery(String(message.deliveryId)));
        return true;
      },
      markAgentUnavailable: async () => {},
      finalizeAgentActivityRun: async () => {},
    };

    const dispatch = dispatchConversationTurn(attached.turn.id, deps);
    await started;
    assert.equal(deliveries.size, 2, "all directed recipients start in parallel within one lease");
    const admittedDeliveryId = deliveries.get(f.agents[0]!.id)?.[0];
    const rejectedDeliveryId = deliveries.get(f.agents[1]!.id)?.[0];
    assert.ok(admittedDeliveryId && rejectedDeliveryId);
    assert.equal(await commitAndAcceptDelivery(admittedDeliveryId), true);
    assert.equal(rejectAgentDeliveryAck(rejectedDeliveryId, undefined, undefined, "runtime rejected"), true);
    await dispatch;

    let settled = await conversationTurnForMessage(request.id);
    assert.deepEqual([settled?.state, settled?.responsibilityState], ["active", "active"], "partial failure keeps acknowledged work visible during recipient retry");
    const decisions = await db.select({ agentId: schema.agentMessageDecisions.agentId, grantStatus: schema.agentMessageDecisions.grantStatus })
      .from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, request.id));
    assert.equal(decisions.find((row) => row.agentId === f.agents[0]!.id)?.grantStatus, "active");
    assert.equal(decisions.find((row) => row.agentId === f.agents[1]!.id)?.grantStatus, "active", "an explicit mention is not silently discarded after NACK");

    await db.update(schema.conversationTurns).set({ dispatchLeaseUntil: new Date(0) }).where(eq(schema.conversationTurns.id, attached.turn.id));
    retrying = true;
    await dispatchConversationTurn(attached.turn.id, deps);
    settled = await conversationTurnForMessage(request.id);
    assert.deepEqual([settled?.state, settled?.responsibilityState, settled?.dispatchAttempts], ["dispatched", "delivered", 2]);
    const admittedIds = deliveries.get(f.agents[0]!.id)!;
    assert.equal(admittedIds.length, 1, "a recipient with a durable server-side admission is not executed again");
    const retriedIds = deliveries.get(f.agents[1]!.id)!;
    assert.equal(retriedIds.length, 2, "only the NACKed recipient is retried");
    assert.equal(new Set(retriedIds).size, 1, "recipient retries reuse the same deterministic delivery fence");
    const admissionRows = await db.select({ agentId: schema.agentMessageDecisions.agentId, admittedAt: schema.agentMessageDecisions.deliveryAdmittedAt })
      .from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, request.id));
    assert.equal(admissionRows.every((row) => row.admittedAt instanceof Date), true, "every directed recipient is durably admitted before the Turn settles");
  } finally { await f.cleanup(); }
});

test("multi-recipient capability preflight starts nobody until every mentioned agent is compatible", async () => {
  const f = await fixture("mixed-capability");
  try {
    const channel = f.channels[0]!;
    const human = f.humans[0]!;
    const request = await f.message(channel.id, "user", human.id, human.name, "@codex @codex2 answer");
    const attached = await f.attach(request, "direct", new Date("2026-07-24T00:00:00.000Z"));
    const agentMembers: DispatchMember[] = f.agents.map((agent) => ({
      type: "agent", id: agent.id, name: agent.name, displayName: agent.displayName,
    }));
    let starts = 0;
    let deliveries = 0;
    let preflightCalls = 0;
    let claimedStarts = 0;
    let preflightStarted!: () => void;
    let releasePreflight!: () => void;
    const started = new Promise<void>((resolve) => { preflightStarted = resolve; });
    const gate = new Promise<void>((resolve) => { releasePreflight = resolve; });
    const deps: ConversationTurnDispatchDeps<{ ok: true }> = {
      channelMembers: async () => [
        { type: "user", id: human.id, name: human.name, displayName: human.displayName },
        ...agentMembers,
      ],
      parseMentions: () => agentMembers,
      agentStartPreflight: async (_serverId, agentId) => {
        preflightCalls++;
        if (preflightCalls === agentMembers.length) preflightStarted();
        await gate;
        return agentId === f.agents[1]!.id
          ? { ok: false, reason: "daemon missing capability: delivery-admission-v2", retryable: false }
          : { ok: true };
      },
      agentStartTarget: async () => { claimedStarts++; return { ok: true }; },
      sendAgentStart: () => { starts++; return true; },
      sendAgentDeliver: () => { deliveries++; return true; },
      markAgentUnavailable: async () => {},
      finalizeAgentActivityRun: async () => {},
    };

    const dispatch = dispatchConversationTurn(attached.turn.id, deps);
    await started;
    try {
      const preflightTurn = (await conversationTurnForMessage(request.id))!;
      assert.equal(preflightTurn.state, "dispatching", "the Turn remains hidden until every recipient passes capability preflight");
      const preflightDecisions = await db.select({ grantStatus: schema.agentMessageDecisions.grantStatus })
        .from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, request.id));
      assert.deepEqual(preflightDecisions.map((row) => row.grantStatus).sort(), ["reserved", "reserved"], "preflight cannot expose active reply authority");
    } finally {
      releasePreflight();
    }
    await dispatch;
    const paused = (await conversationTurnForMessage(request.id))!;
    assert.deepEqual([paused.state, paused.responsibilityState, paused.dispatchAttempts], ["active", "active", 1]);
    assert.equal(paused.dispatchLeaseUntil?.toISOString(), "9999-12-31T23:59:59.999Z", "ordinary recovery cannot steal a capability-paused Turn");
    assert.deepEqual([starts, deliveries], [0, 0], "fan-out is all-or-paused before runtime side effects");
    assert.equal(claimedStarts, 0, "pure fan-out preflight cannot claim an agent as starting");
    const decisions = await db.select({ grantStatus: schema.agentMessageDecisions.grantStatus })
      .from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, request.id));
    assert.deepEqual(decisions.map((row) => row.grantStatus).sort(), ["active", "active"]);
  } finally { await f.cleanup(); }
});

test("twenty directed recipients fan out concurrently inside one fenced attempt", async () => {
  const f = await fixture("twenty-fanout");
  try {
    const extraAgents = await db.insert(schema.agents).values(Array.from({ length: 18 }, (_, index) => ({
      serverId: f.server.id,
      name: `extra-${index}-${randomUUID().slice(0, 8)}`,
      displayName: `extra-${index}`,
    }))).returning();
    const allAgents = [...f.agents, ...extraAgents];
    const human = f.humans[0]!;
    const channel = f.channels[0]!;
    const request = await f.message(channel.id, "user", human.id, human.name, "twenty perspectives");
    const attached = await f.attach(request, "direct", new Date("2026-07-24T00:00:00.000Z"));
    const agentMembers: DispatchMember[] = allAgents.map((agent) => ({
      type: "agent", id: agent.id, name: agent.name, displayName: agent.displayName,
    }));
    const members: DispatchMember[] = [
      { type: "user", id: human.id, name: human.name, displayName: human.displayName },
      ...agentMembers,
    ];
    const deliveryIds: string[] = [];
    let allStarted!: () => void;
    const started = new Promise<void>((resolve) => { allStarted = resolve; });
    const deps: ConversationTurnDispatchDeps<{ ok: true }> = {
      channelMembers: async () => members,
      parseMentions: () => agentMembers,
      agentStartTarget: async () => ({ ok: true }),
      sendAgentStart: () => true,
      sendAgentDeliver: (_serverId, _target, message) => {
        deliveryIds.push(String(message.deliveryId));
        if (deliveryIds.length === allAgents.length) allStarted();
        return true;
      },
      markAgentUnavailable: async () => {},
      finalizeAgentActivityRun: async () => {},
    };

    const dispatch = dispatchConversationTurn(attached.turn.id, deps);
    await Promise.race([
      started,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("fan-out was serialized behind ACK waits")), 1_000)),
    ]);
    assert.equal(deliveryIds.length, 20, "no recipient waits for a previous recipient ACK");
    for (const deliveryId of deliveryIds) assert.equal(await commitAndAcceptDelivery(deliveryId), true);
    await dispatch;
    const settled = (await conversationTurnForMessage(request.id))!;
    assert.deepEqual([settled.state, settled.responsibilityState, settled.dispatchAttempts], ["dispatched", "delivered", 1]);
    assert.equal(await claimConversationTurnDispatch(settled.id, new Date(Date.now() + 60_000)), null, "terminal Turn cannot be recovered into a second attempt");
    assert.equal(await finishConversationTurnDispatch(settled.id, 0, allAgents[0]!.id, "blocked"), false, "a stale attempt cannot overwrite the terminal result");
  } finally { await f.cleanup(); }
});

test("dispatch lease renewal and attempt fencing reject stale state transitions", async () => {
  const f = await fixture("attempt-fence");
  try {
    const t0 = new Date("2026-07-24T00:00:00.000Z");
    const request = await f.message(f.channels[0]!.id, "user", f.humans[0]!.id, f.humans[0]!.name, "work");
    const attached = await f.attach(request, "ambient", t0);
    const first = await claimConversationTurnDispatch(attached.turn.id, new Date(t0.getTime() + 2_000));
    assert.ok(first);
    assert.equal(await renewConversationTurnDispatchLease(first.id, first.dispatchAttempts, new Date(t0.getTime() + 27_000)), true);
    assert.equal(await claimConversationTurnDispatch(first.id, new Date(t0.getTime() + 33_000)), null, "renewal prevents recovery from stealing a live attempt");

    const second = await claimConversationTurnDispatch(first.id, new Date(t0.getTime() + 58_000));
    assert.ok(second);
    assert.equal(second.dispatchAttempts, first.dispatchAttempts + 1);
    assert.equal(await activateConversationTurnDispatch(first.id, first.dispatchAttempts, f.agents[0]!.id), false);
    assert.equal(await finishConversationTurnDispatch(first.id, first.dispatchAttempts, f.agents[0]!.id, "delivered"), false);
    assert.equal(await retryConversationTurnDispatch(first, new Error("stale failure")), false);
    let current = (await conversationTurnForMessage(request.id))!;
    assert.deepEqual([current.state, current.dispatchAttempts], ["dispatching", second.dispatchAttempts]);

    assert.equal(await activateConversationTurnDispatch(second.id, second.dispatchAttempts, f.agents[0]!.id), true);
    assert.equal(await finishConversationTurnDispatch(second.id, second.dispatchAttempts, f.agents[0]!.id, "delivered"), true);
    current = (await conversationTurnForMessage(request.id))!;
    assert.deepEqual([current.state, current.responsibilityState, current.dispatchAttempts], ["dispatched", "delivered", second.dispatchAttempts]);
  } finally { await f.cleanup(); }
});

test("unbound capability-paused Turns resume on zero-to-one and two-to-one daemon topology changes", async () => {
  const f = await fixture("unbound-topology");
  const sockets: WebSocket[] = [];
  const fakeWs = (): WebSocket => ({ readyState: 1, send: () => {} }) as unknown as WebSocket;
  try {
    const channel = f.channels[0]!;
    const human = f.humans[0]!;
    const agent = f.agents[0]!;
    const pauseUnboundTurn = async (content: string) => {
      const message = await f.message(channel.id, "user", human.id, human.name, content);
      const attached = await f.attach(message, "direct", new Date());
      await ensureReplyRecipients({
        serverId: f.server.id, channelId: channel.id, messageId: message.id,
        recipients: [{ agentId: agent.id, attention: "direct" }],
      });
      const claimed = await claimConversationTurnDispatch(attached.turn.id, new Date(Date.now() + 1_000));
      assert.ok(claimed);
      assert.equal(await activateConversationTurnDispatch(claimed.id, claimed.dispatchAttempts, agent.id), true);
      const pausedUntil = new Date("9999-12-31T23:59:59.999Z");
      await db.update(schema.conversationTurns).set({ dispatchAfter: pausedUntil, dispatchLeaseUntil: pausedUntil })
        .where(eq(schema.conversationTurns.id, claimed.id));
      return claimed.id;
    };

    const zeroDaemonTurnId = await pauseUnboundTurn("resume after zero daemons");
    assert.equal(await handleConversationTurnDaemonTopologyChange(f.server.id), 0, "zero daemons cannot resume unbound delivery");
    const [stillPaused] = await db.select({ lease: schema.conversationTurns.dispatchLeaseUntil }).from(schema.conversationTurns)
      .where(eq(schema.conversationTurns.id, zeroDaemonTurnId));
    assert.equal(stillPaused?.lease?.getUTCFullYear(), 9999);

    const first = fakeWs();
    sockets.push(first);
    registerDaemon(first, f.server.id);
    registerDaemonCapabilities(first, [DELIVERY_ADMISSION_CAPABILITY]);
    assert.equal(await handleConversationTurnDaemonTopologyChange(f.server.id), 1, "first capable daemon resumes zero-daemon backlog");
    const [resumedFromZero] = await db.select({ lease: schema.conversationTurns.dispatchLeaseUntil }).from(schema.conversationTurns)
      .where(eq(schema.conversationTurns.id, zeroDaemonTurnId));
    assert.equal(resumedFromZero?.lease, null);

    const twoDaemonTurnId = await pauseUnboundTurn("resume after one of two daemons leaves");
    const second = fakeWs();
    sockets.push(second);
    registerDaemon(second, f.server.id);
    registerDaemonCapabilities(second, [DELIVERY_ADMISSION_CAPABILITY]);
    assert.equal(await handleConversationTurnDaemonTopologyChange(f.server.id), 0, "ambiguous two-daemon routing remains paused");
    unregisterDaemon(second);
    assert.equal(await handleConversationTurnDaemonTopologyChange(f.server.id), 1, "two-to-one transition resumes unbound delivery automatically");
    const [resumedFromTwo] = await db.select({ lease: schema.conversationTurns.dispatchLeaseUntil }).from(schema.conversationTurns)
      .where(eq(schema.conversationTurns.id, twoDaemonTurnId));
    assert.equal(resumedFromTwo?.lease, null);
  } finally {
    for (const socket of sockets) unregisterDaemon(socket);
    await f.cleanup();
  }
});

test("delivery commit is bound to the authenticated current machine and persists before admission response", async () => {
  const f = await fixture("delivery-commit");
  const sockets: WebSocket[] = [];
  const fakeWs = (): WebSocket => ({ readyState: 1, send: () => {}, close: () => {} }) as unknown as WebSocket;
  let machineIds: string[] = [];
  try {
    const machines = await db.insert(schema.machines).values(["owner", "other"].map((name) => ({
      serverId: f.server.id,
      userId: f.humans[0]!.id,
      name: `${name}-${randomUUID().slice(0, 8)}`,
      apiKeyHash: `hash-${randomUUID()}`,
      apiKeyPrefix: `prefix-${name}`,
    }))).returning();
    machineIds = machines.map((machine) => machine.id);
    const ownerMachine = machines[0]!;
    const otherMachine = machines[1]!;
    const agent = f.agents[0]!;
    await db.update(schema.agents).set({ machineId: ownerMachine.id }).where(eq(schema.agents.id, agent.id));

    const message = await f.message(f.channels[0]!.id, "user", f.humans[0]!.id, f.humans[0]!.name, "commit me");
    const attached = await f.attach(message, "direct", new Date());
    await ensureReplyRecipients({
      serverId: f.server.id, channelId: message.channelId, messageId: message.id,
      recipients: [{ agentId: agent.id, attention: "direct" }],
    });
    const deliveryId = `${attached.turn.id}:${agent.id}`;
    const ownerWs = fakeWs();
    const otherWs = fakeWs();
    sockets.push(ownerWs, otherWs);
    registerDaemon(ownerWs, f.server.id);
    registerDaemon(otherWs, f.server.id);
    registerMachineConn(ownerMachine.id, ownerWs);
    registerMachineConn(otherMachine.id, otherWs);

    const wrongMachine = await commitAgentDeliveryAdmission({
      ws: otherWs, serverId: f.server.id, machineId: otherMachine.id,
      deliveryId, agentId: agent.id, seq: message.seq,
    });
    assert.deepEqual(wrongMachine, { ok: false, error: "delivery machine does not own agent" });

    const committed = await commitAgentDeliveryAdmission({
      ws: ownerWs, serverId: f.server.id, machineId: ownerMachine.id,
      deliveryId, agentId: agent.id, seq: message.seq,
    });
    assert.equal(committed.ok, true);
    const [decision] = await db.select({ admittedAt: schema.agentMessageDecisions.deliveryAdmittedAt }).from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, message.id), eq(schema.agentMessageDecisions.agentId, agent.id),
    ));
    assert.ok(decision?.admittedAt, "commit returns only after durable recipient admission is visible");

    const replacementWs = fakeWs();
    sockets.push(replacementWs);
    registerDaemon(replacementWs, f.server.id);
    registerMachineConn(ownerMachine.id, replacementWs);
    const stale = await commitAgentDeliveryAdmission({
      ws: ownerWs, serverId: f.server.id, machineId: ownerMachine.id,
      deliveryId, agentId: agent.id, seq: message.seq,
    });
    assert.deepEqual(stale, { ok: false, error: "stale or unidentified machine connection" });

    if (committed.ok) await releaseAgentDeliveryAdmission(committed.delivery);
    const [released] = await db.select({ admittedAt: schema.agentMessageDecisions.deliveryAdmittedAt }).from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, message.id), eq(schema.agentMessageDecisions.agentId, agent.id),
    ));
    assert.equal(released?.admittedAt, null, "a failed in-flight delivery can be retried after release");
  } finally {
    for (const socket of sockets) { unregisterMachineConn(socket); unregisterDaemon(socket); }
    await db.update(schema.agents).set({ machineId: null }).where(eq(schema.agents.serverId, f.server.id));
    if (machineIds.length) await db.delete(schema.machines).where(inArray(schema.machines.id, machineIds));
    await f.cleanup();
  }
});
