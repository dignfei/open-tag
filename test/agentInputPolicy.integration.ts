// Integration coverage for human management of an agent's input-source settings.
// Requires PostgreSQL on the worktree DATABASE_URL after `npm run db:push`.
// Run: JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx test/agentInputPolicy.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "../src/db/index.ts";
import { hashToken, signUser } from "../src/server/auth.ts";

process.env.OPEN_TAG_DIRECT_TURN_DEBOUNCE_MS = "30000";
const { createMessage, getOrCreateThread, parseMentions, resolveMessageId, setTaskStatus } = await import("../src/server/core.ts");
const { dispatchConversationTurn } = await import("../src/server/conversationTurnDispatch.ts");
const { fireReminder } = await import("../src/server/reminders.ts");
const { claimReplyCoordination, decideReply } = await import("../src/server/replyCoordination.ts");
const { handleApi } = await import("../src/server/routes-api/index.ts");
const { handleAgentApi } = await import("../src/server/routes-agent.ts");

const suffix = Date.now().toString(36);
let failures = 0;
const check = (label: string, condition: boolean) => {
  console.log(`  ${condition ? "✔" : "✗ FAIL"} ${label}`);
  if (!condition) failures++;
};

function request(options: { method: string; path: string; token: string; serverId?: string; agentId?: string; body?: unknown }): IncomingMessage {
  const encoded = options.body === undefined ? "" : JSON.stringify(options.body);
  const stream = Readable.from(encoded ? [Buffer.from(encoded)] : ([] as Buffer[]));
  const headers: Record<string, string> = {
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
  };
  if (options.serverId) headers["x-server-id"] = options.serverId;
  if (options.agentId) headers["x-agent-id"] = options.agentId;
  return Object.assign(stream, {
    method: options.method,
    url: options.path,
    headers,
  }) as unknown as IncomingMessage;
}

function response(): { res: ServerResponse; status: () => number; body: () => any } {
  let status = 0;
  let body = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    writeHead(code: number) { status = code; this.statusCode = code; },
    end(value?: string | Buffer) { body = value ? String(value) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  return { res, status: () => status, body: () => body ? JSON.parse(body) : null };
}

async function api(options: { method: string; path: string; token: string; serverId: string; body?: unknown }) {
  const output = response();
  await handleApi(request(options), output.res, new URL(options.path, "http://localhost"), options.method);
  return { status: output.status(), body: output.body() };
}

async function agentApi(options: { method: string; path: string; token: string; agentId: string; body?: unknown }) {
  const output = response();
  await handleAgentApi(request(options), output.res, new URL(options.path, "http://localhost"), options.method);
  return { status: output.status(), body: output.body() };
}

async function main() {
  const targetToken = `sk_agent_policy_target_${suffix}`;
  const blockedToken = `sk_agent_policy_blocked_${suffix}`;
  const users = await db.insert(schema.users).values([
    { name: `policy-owner-${suffix}`, displayName: "Owner", email: `policy-owner-${suffix}@test.invalid` },
    { name: `policy-member-${suffix}`, displayName: "Member", email: `policy-member-${suffix}@test.invalid` },
  ]).returning();
  const owner = users[0]!;
  const member = users[1]!;
  const servers = await db.insert(schema.servers).values([
    { name: `Policy ${suffix}`, slug: `policy-${suffix}`, ownerId: owner.id },
    { name: `Foreign ${suffix}`, slug: `foreign-policy-${suffix}`, ownerId: owner.id },
  ]).returning();
  const server = servers[0]!;
  const foreignServer = servers[1]!;
  await db.insert(schema.serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
    { serverId: foreignServer.id, userId: owner.id, role: "owner" },
  ]);
  const localAgents = await db.insert(schema.agents).values([
    { serverId: server.id, name: `target-${suffix}`, displayName: "Target", agentTokenHash: hashToken(targetToken) },
    { serverId: server.id, name: `peer-${suffix}`, displayName: "Peer", description: `allowed-description-${suffix}` },
    { serverId: server.id, name: `blocked-${suffix}`, displayName: "Blocked", description: `blocked-description-${suffix}`, agentTokenHash: hashToken(blockedToken) },
    { serverId: server.id, name: `showcase-${suffix}`, displayName: "Showcase", creatorType: "system" },
    { serverId: server.id, name: `deleted-${suffix}`, displayName: "Deleted", deletedAt: new Date() },
  ]).returning();
  const target = localAgents[0]!;
  const peer = localAgents[1]!;
  const blocked = localAgents[2]!;
  const showcase = localAgents[3]!;
  const deleted = localAgents[4]!;
  const [foreign] = await db.insert(schema.agents).values({
    serverId: foreignServer.id, name: `foreign-${suffix}`, displayName: "Foreign",
  }).returning();
  const ownerToken = signUser(owner.id);
  const memberToken = signUser(member.id);
  const endpoint = `/api/agents/${target.id}`;

  try {
    const initial = await api({ method: "GET", path: endpoint, token: ownerToken, serverId: server.id });
    check("manager sees default input settings", initial.status === 200
      && initial.body.incomingMode === "open" && initial.body.commandWhitelist.length === 0);

    const hidden = await api({ method: "GET", path: endpoint, token: memberToken, serverId: server.id });
    check("ordinary member cannot inspect input settings", hidden.status === 200
      && !("incomingMode" in hidden.body) && !("commandWhitelist" in hidden.body));

    const deletedTarget = await api({
      method: "GET", path: `/api/agents/${deleted.id}`, token: ownerToken, serverId: server.id,
    });
    check("deleted agent settings are not readable", deletedTarget.status === 404);

    const forbidden = await api({
      method: "PATCH", path: endpoint, token: memberToken, serverId: server.id,
      body: { incomingMode: "sealed" },
    });
    check("ordinary member cannot change input settings", forbidden.status === 403);

    const nullPatch = await api({
      method: "PATCH", path: endpoint, token: ownerToken, serverId: server.id, body: null,
    });
    check("null settings body fails with 400", nullPatch.status === 400);

    const invalidBodies = [
      { incomingMode: "sanitized" },
      { commandWhitelist: "all" },
      { commandWhitelist: ["not-an-id"] },
      { commandWhitelist: [peer.id, peer.id.toUpperCase()] },
      { commandWhitelist: [target.id] },
      { commandWhitelist: [showcase.id] },
      { commandWhitelist: [deleted.id] },
      { commandWhitelist: [foreign!.id] },
    ];
    for (const body of invalidBodies) {
      const result = await api({ method: "PATCH", path: endpoint, token: ownerToken, serverId: server.id, body });
      check(`invalid settings fail with 400 (${JSON.stringify(body)})`, result.status === 400);
    }

    const saved = await api({
      method: "PATCH", path: endpoint, token: ownerToken, serverId: server.id,
      body: { incomingMode: "sealed", commandWhitelist: [peer.id.toUpperCase()] },
    });
    check("manager saves a canonical same-workspace whitelist", saved.status === 200
      && saved.body.incomingMode === "sealed" && saved.body.commandWhitelist[0] === peer.id);
    const reloaded = await api({ method: "GET", path: endpoint, token: ownerToken, serverId: server.id });
    check("saved settings survive reload", reloaded.body.incomingMode === "sealed"
      && reloaded.body.commandWhitelist.length === 1 && reloaded.body.commandWhitelist[0] === peer.id);

    const stored = (await db.select().from(schema.agents).where(eq(schema.agents.id, target.id)))[0]!;
    check("rejected updates do not replace the saved policy", stored.incomingMode === "sealed"
      && stored.commandWhitelist.length === 1 && stored.commandWhitelist[0] === peer.id);
    const protectedDirectory = await agentApi({
      method: "GET", path: "/agent-api/server/info", token: targetToken, agentId: target.id,
    });
    const directoryPeer = protectedDirectory.body.agents.find((entry: any) => entry.name === peer.name);
    const directoryBlocked = protectedDirectory.body.agents.find((entry: any) => entry.name === blocked.name);
    check("agent directory hides rejected profile text", protectedDirectory.status === 200
      && directoryPeer?.description === peer.description
      && directoryBlocked?.status === blocked.status
      && directoryBlocked?.description === null);
    const allowedProfile = await agentApi({
      method: "GET", path: `/agent-api/profile/show?handle=${peer.name}`,
      token: targetToken, agentId: target.id,
    });
    const blockedProfile = await agentApi({
      method: "GET", path: `/agent-api/profile/show?handle=${blocked.name}`,
      token: targetToken, agentId: target.id,
    });
    check("listed agent profile retains its text", allowedProfile.status === 200
      && allowedProfile.body.displayName === peer.displayName
      && allowedProfile.body.description === peer.description);
    check("rejected agent profile exposes stable metadata only", blockedProfile.status === 200
      && blockedProfile.body.name === blocked.name
      && blockedProfile.body.displayName === blocked.name
      && blockedProfile.body.description === null);

    const [autoJoinChannel] = await db.insert(schema.channels).values({
      serverId: server.id, name: `policy-join-${suffix}`, type: "channel",
    }).returning();
    await db.insert(schema.channelMembers).values({
      channelId: autoJoinChannel!.id, memberType: "agent", memberId: blocked.id,
    });
    const deniedJoinMessage = await createMessage({
      serverId: server.id, channelId: autoJoinChannel!.id, senderType: "agent", senderId: blocked.id,
      senderName: blocked.name, content: `@${target.name} cannot pull target in`,
    });
    const deniedMembership = await db.select().from(schema.channelMembers).where(and(
      eq(schema.channelMembers.channelId, autoJoinChannel!.id),
      eq(schema.channelMembers.memberType, "agent"),
      eq(schema.channelMembers.memberId, target.id),
    ));
    const deniedMention = await db.select().from(schema.messageMentions).where(and(
      eq(schema.messageMentions.messageId, deniedJoinMessage.id),
      eq(schema.messageMentions.mentionType, "agent"),
      eq(schema.messageMentions.mentionId, target.id),
    ));
    check("unlisted agent mention cannot add a sealed non-member", deniedMembership.length === 0
      && deniedMention.length === 0);

    const humanJoinMessage = await createMessage({
      serverId: server.id, channelId: autoJoinChannel!.id, senderType: "user", senderId: owner.id,
      senderName: owner.name, content: `@${target.name} human invitation`,
    });
    const humanMembership = (await db.select().from(schema.channelMembers).where(and(
      eq(schema.channelMembers.channelId, autoJoinChannel!.id),
      eq(schema.channelMembers.memberType, "agent"),
      eq(schema.channelMembers.memberId, target.id),
    )))[0];
    const humanMention = await db.select().from(schema.messageMentions).where(and(
      eq(schema.messageMentions.messageId, humanJoinMessage.id),
      eq(schema.messageMentions.mentionType, "agent"),
      eq(schema.messageMentions.mentionId, target.id),
    ));
    check("human mention still adds the target at the triggering watermark", humanMembership?.lastReadSeq === humanJoinMessage.seq - 1
      && humanMention.length === 1);

    const [channel] = await db.insert(schema.channels).values({
      serverId: server.id, name: `policy-turn-${suffix}`, type: "channel",
    }).returning();
    await db.insert(schema.channelMembers).values([target, peer, blocked].map((agent) => ({
      channelId: channel!.id, memberType: "agent", memberId: agent.id,
    })));
    const protectedMembers = await agentApi({
      method: "GET", path: `/agent-api/channel/members?channel=${encodeURIComponent(`#${channel!.name}`)}`,
      token: targetToken, agentId: target.id,
    });
    const memberPeer = protectedMembers.body.members.find((entry: any) => entry.name === peer.name);
    const memberBlocked = protectedMembers.body.members.find((entry: any) => entry.name === blocked.name);
    check("channel member list hides rejected display text", protectedMembers.status === 200
      && memberPeer?.displayName === peer.displayName
      && memberBlocked?.displayName === blocked.name);
    const blockedMessage = await createMessage({
      serverId: server.id, channelId: channel!.id, senderType: "agent", senderId: blocked.id,
      senderName: blocked.name, content: `@${target.name} blocked request`,
    });
    const blockedDecision = await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, blockedMessage.id),
      eq(schema.agentMessageDecisions.agentId, target.id),
    ));
    check("sealed target receives no responsibility from an unlisted agent", blockedDecision.length === 0);
    const persistedBlocked = (await db.select().from(schema.messages).where(eq(schema.messages.id, blockedMessage.id)))[0]!;
    await db.update(schema.conversationTurns).set({ dispatchAfter: new Date(0) })
      .where(eq(schema.conversationTurns.id, persistedBlocked.conversationTurnId!));
    let blockedStarts = 0;
    let blockedDeliveries = 0;
    const dispatchMembers = [target, peer, blocked].map((agent) => ({
      type: "agent" as const, id: agent.id, name: agent.name, displayName: agent.displayName,
    }));
    const reminderContent = `@${target.name} attributed reminder`;
    const [agentReminder] = await db.insert(schema.reminders).values({
      serverId: server.id,
      ownerType: "agent",
      ownerId: blocked.id,
      channelId: channel!.id,
      content: reminderContent,
      remindAt: new Date(0),
    }).returning();
    await fireReminder(agentReminder!);
    const attributedSystemMessage = (await db.select().from(schema.messages).where(and(
      eq(schema.messages.serverId, server.id),
      eq(schema.messages.senderType, "system"),
      eq(schema.messages.senderId, blocked.id),
      eq(schema.messages.content, `⏰ @${blocked.name} reminder: ${reminderContent}`),
    )))[0]!;
    check("agent reminder preserves its source identity", attributedSystemMessage.senderName === "reminder");
    const reminderDecisions = await db.select().from(schema.agentMessageDecisions)
      .where(eq(schema.agentMessageDecisions.messageId, attributedSystemMessage.id));
    check("attributed system delivery rejects blocked targets but keeps an explicit self reminder",
      !reminderDecisions.some((decision) => decision.agentId === target.id)
      && reminderDecisions.some((decision) => decision.agentId === blocked.id));
    await dispatchConversationTurn(persistedBlocked.conversationTurnId!, {
      channelMembers: async () => dispatchMembers,
      parseMentions,
      agentStartTarget: async () => { blockedStarts++; return { ok: true as const }; },
      agentStartPreflight: async () => ({ ok: true as const }),
      sendAgentStart: () => { blockedStarts++; return true; },
      sendAgentDeliver: () => { blockedDeliveries++; return true; },
      markAgentUnavailable: async () => {},
      finalizeAgentActivityRun: async () => {},
    });
    const dispatchedBlocked = (await db.select().from(schema.conversationTurns)
      .where(eq(schema.conversationTurns.id, persistedBlocked.conversationTurnId!)))[0]!;
    const blockedEdges = await db.select().from(schema.causalEdges).where(and(
      eq(schema.causalEdges.rootTurnId, persistedBlocked.conversationTurnId!),
      eq(schema.causalEdges.targetAgentId, target.id),
    ));
    check("dispatch completes a rejected command without starting or delivering", blockedStarts === 0
      && blockedDeliveries === 0 && blockedEdges.length === 0
      && dispatchedBlocked.state === "dispatched" && dispatchedBlocked.responsibilityState === "completed");
    const sealedCheck = await agentApi({
      method: "GET", path: "/agent-api/message/check", token: targetToken, agentId: target.id,
    });
    const blockedObservation = await db.select().from(schema.agentMessageObservations).where(and(
      eq(schema.agentMessageObservations.messageId, blockedMessage.id),
      eq(schema.agentMessageObservations.agentId, target.id),
    ));
    const targetCursor = (await db.select().from(schema.channelMembers).where(and(
      eq(schema.channelMembers.channelId, channel!.id),
      eq(schema.channelMembers.memberType, "agent"),
      eq(schema.channelMembers.memberId, target.id),
    )))[0]!;
    check("message check hides rejected agent input", sealedCheck.status === 200
      && !JSON.stringify(sealedCheck.body).includes("blocked request") && blockedObservation.length === 0);
    check("hidden stable input still advances the channel cursor", targetCursor.lastReadSeq >= blockedMessage.seq);

    const allowedMessage = await createMessage({
      serverId: server.id, channelId: channel!.id, senderType: "agent", senderId: peer.id,
      senderName: peer.name, content: `@${target.name} listed request`,
    });
    const allowedDecision = await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, allowedMessage.id),
      eq(schema.agentMessageDecisions.agentId, target.id),
    ));
    check("listed agent may reserve target responsibility", allowedDecision.length === 1);

    const humanMessage = await createMessage({
      serverId: server.id, channelId: channel!.id, senderType: "user", senderId: owner.id,
      senderName: owner.name, content: `@${target.name} human request`,
    });
    const humanDecision = await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, humanMessage.id),
      eq(schema.agentMessageDecisions.agentId, target.id),
    ));
    check("human input may reserve sealed target responsibility", humanDecision.length === 1);
    const protectedHistory = await agentApi({
      method: "GET",
      path: `/agent-api/message/read?channel=${encodeURIComponent(`#${channel!.name}`)}&limit=100`,
      token: targetToken,
      agentId: target.id,
    });
    const historyText = JSON.stringify(protectedHistory.body);
    check("message history omits rejected agent input", protectedHistory.status === 200
      && !historyText.includes("blocked request")
      && historyText.includes("listed request")
      && historyText.includes("human request"));
    check("protected id resolution hides rejected input", await resolveMessageId(server.id, blockedMessage.id, target.id) === null);
    check("protected id resolution keeps listed input addressable", await resolveMessageId(server.id, allowedMessage.id, target.id) === allowedMessage.id);
    const deniedResolve = await agentApi({
      method: "GET", path: `/agent-api/message/resolve?id=${blockedMessage.id.slice(0, 8)}`,
      token: targetToken, agentId: target.id,
    });
    const allowedResolve = await agentApi({
      method: "GET", path: `/agent-api/message/resolve?id=${allowedMessage.id.slice(0, 8)}`,
      token: targetToken, agentId: target.id,
    });
    check("message resolve hides rejected input with 404", deniedResolve.status === 404
      && !JSON.stringify(deniedResolve.body).includes("blocked request"));
    check("message resolve returns listed input", allowedResolve.status === 200
      && JSON.stringify(allowedResolve.body).includes("listed request"));

    const [blockedAttachment] = await db.insert(schema.attachments).values({
      serverId: server.id,
      channelId: channel!.id,
      messageId: blockedMessage.id,
      uploaderType: "agent",
      uploaderId: blocked.id,
      filename: "blocked.txt",
      mimeType: "text/plain",
      sizeBytes: 7,
      storageKey: "/not-read/blocked.txt",
    }).returning();
    const deniedAttachment = await agentApi({
      method: "GET", path: `/agent-api/attachment/view?id=${blockedAttachment!.id}`,
      token: targetToken, agentId: target.id,
    });
    check("attachment view hides rejected agent input", deniedAttachment.status === 404);

    const task = await createMessage({
      serverId: server.id, channelId: channel!.id, senderType: "agent", senderId: blocked.id,
      senderName: blocked.name, content: "protected task handoff", asTask: true,
    });
    const deniedAssignment = await agentApi({
      method: "POST", path: "/agent-api/task/assign", token: blockedToken, agentId: blocked.id,
      body: { messageId: task.id, to: target.name },
    });
    const deniedTask = (await db.select().from(schema.messages).where(eq(schema.messages.id, task.id)))[0]!;
    const deniedThreadMember = await db.select().from(schema.channelMembers).where(and(
      eq(schema.channelMembers.channelId, task.threadId!),
      eq(schema.channelMembers.memberType, "agent"),
      eq(schema.channelMembers.memberId, target.id),
    ));
    const deniedAudits = await db.select().from(schema.messages).where(and(
      eq(schema.messages.channelId, task.threadId!),
      eq(schema.messages.senderType, "system"),
    ));
    check("unlisted agent task handoff returns 403", deniedAssignment.status === 403);
    check("rejected handoff leaves the task and thread unchanged", deniedTask.taskAssigneeId === null
      && deniedTask.taskStatus === "todo" && deniedThreadMember.length === 0 && deniedAudits.length === 0);

    const allowBlocked = await api({
      method: "PATCH", path: endpoint, token: ownerToken, serverId: server.id,
      body: { commandWhitelist: [peer.id, blocked.id] },
    });
    check("manager can allow the task source", allowBlocked.status === 200);
    const allowedAssignment = await agentApi({
      method: "POST", path: "/agent-api/task/assign", token: blockedToken, agentId: blocked.id,
      body: { messageId: task.id, to: target.name },
    });
    const assignedTask = (await db.select().from(schema.messages).where(eq(schema.messages.id, task.id)))[0]!;
    const assignedThreadMember = await db.select().from(schema.channelMembers).where(and(
      eq(schema.channelMembers.channelId, task.threadId!),
      eq(schema.channelMembers.memberType, "agent"),
      eq(schema.channelMembers.memberId, target.id),
    ));
    const assignmentAudits = await db.select().from(schema.messages).where(and(
      eq(schema.messages.channelId, task.threadId!),
      eq(schema.messages.senderType, "system"),
    ));
    check("listed agent may hand off a real task", allowedAssignment.status === 200
      && assignedTask.taskAssigneeId === target.id && assignedTask.taskStatus === "in_progress"
      && assignedThreadMember.length === 1 && assignmentAudits.length === 1);
    await api({
      method: "PATCH", path: endpoint, token: ownerToken, serverId: server.id,
      body: { commandWhitelist: [peer.id] },
    });
    const auditsBeforeDeniedClaim = (await db.select().from(schema.messages).where(and(
      eq(schema.messages.channelId, task.threadId!),
      eq(schema.messages.senderType, "system"),
    ))).length;
    const deniedClaimByNumber = await agentApi({
      method: "POST", path: "/agent-api/task/claim", token: targetToken, agentId: target.id,
      body: { channel: `#${channel!.name}`, number: task.taskNumber },
    });
    const auditsAfterDeniedClaim = (await db.select().from(schema.messages).where(and(
      eq(schema.messages.channelId, task.threadId!),
      eq(schema.messages.senderType, "system"),
    ))).length;
    check("task claim by number hides rejected input", deniedClaimByNumber.status === 404
      && auditsAfterDeniedClaim === auditsBeforeDeniedClaim);
    const deniedUpdateByNumber = await agentApi({
      method: "POST", path: "/agent-api/task/update", token: targetToken, agentId: target.id,
      body: { channel: `#${channel!.name}`, number: task.taskNumber, status: "done" },
    });
    const taskAfterDeniedUpdate = (await db.select().from(schema.messages)
      .where(eq(schema.messages.id, task.id)))[0]!;
    check("task update by number hides rejected input", deniedUpdateByNumber.status === 404
      && taskAfterDeniedUpdate.taskStatus === "in_progress");
    const deniedAssignmentByNumber = await agentApi({
      method: "POST", path: "/agent-api/task/assign", token: targetToken, agentId: target.id,
      body: { channel: `#${channel!.name}`, number: task.taskNumber, to: peer.name },
    });
    const taskAfterDeniedAssignment = (await db.select().from(schema.messages)
      .where(eq(schema.messages.id, task.id)))[0]!;
    check("task assignment by number hides rejected input", deniedAssignmentByNumber.status === 404
      && taskAfterDeniedAssignment.taskAssigneeId === target.id);

    const blockedStatusTask = await createMessage({
      serverId: server.id, channelId: channel!.id, senderType: "agent", senderId: blocked.id,
      senderName: blocked.name, content: "protected status update", asTask: true,
    });
    await db.update(schema.messages).set({ taskAssigneeType: "agent", taskAssigneeId: target.id })
      .where(eq(schema.messages.id, blockedStatusTask.id));
    const statusUpdate = await setTaskStatus(server.id, blockedStatusTask.id, "in_review", {
      type: "agent", id: blocked.id,
    });
    const blockedStatusMembers = await db.select().from(schema.channelMembers).where(and(
      eq(schema.channelMembers.channelId, blockedStatusTask.threadId!),
      eq(schema.channelMembers.memberType, "agent"),
      eq(schema.channelMembers.memberId, target.id),
    ));
    const blockedStatusDecisions = await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.channelId, blockedStatusTask.threadId!),
      eq(schema.agentMessageDecisions.agentId, target.id),
    ));
    check("blocked task status source cannot wake the assignee", statusUpdate?.taskStatus === "in_review"
      && blockedStatusMembers.length === 0 && blockedStatusDecisions.length === 0);

    const coordinationMessage = await createMessage({
      serverId: server.id, channelId: channel!.id, senderType: "user", senderId: owner.id,
      senderName: owner.name, content: "coordination policy check",
    });
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, coordinationMessage.id));
    await db.insert(schema.agentMessageDecisions).values([
      {
        serverId: server.id, channelId: channel!.id, messageId: coordinationMessage.id,
        agentId: target.id, attention: "direct", observedAt: new Date(), grantSlot: "primary", grantStatus: "active",
      },
      {
        serverId: server.id, channelId: channel!.id, messageId: coordinationMessage.id,
        agentId: blocked.id, attention: "direct", observedAt: new Date(),
      },
    ]);
    const rejectedCoordination = await decideReply({
      serverId: server.id,
      agentId: blocked.id,
      messageId: coordinationMessage.id,
      decision: "request_reply",
      reason: "better_fit",
      summary: `blocked-coordination-${suffix}`,
    });
    const rejectedCoordinationRow = (await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, coordinationMessage.id),
      eq(schema.agentMessageDecisions.agentId, blocked.id),
    )))[0]!;
    check("sealed primary rejects a coordination request before persistence", !rejectedCoordination.ok
      && rejectedCoordination.code === "INPUT_SOURCE_REJECTED"
      && rejectedCoordinationRow.decision === "pending"
      && rejectedCoordinationRow.reasonCode === null
      && rejectedCoordinationRow.summary === null);
    const coordinationApiMessage = await createMessage({
      serverId: server.id, channelId: channel!.id, senderType: "user", senderId: owner.id,
      senderName: owner.name, content: "coordination API policy check",
    });
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, coordinationApiMessage.id));
    await db.insert(schema.agentMessageDecisions).values([
      {
        serverId: server.id, channelId: channel!.id, messageId: coordinationApiMessage.id,
        agentId: target.id, attention: "direct", observedAt: new Date(), grantSlot: "primary", grantStatus: "active",
      },
      {
        serverId: server.id, channelId: channel!.id, messageId: coordinationApiMessage.id,
        agentId: blocked.id, attention: "direct", observedAt: new Date(), deliveryAdmittedAt: new Date(),
      },
    ]);
    const rejectedCoordinationApi = await agentApi({
      method: "POST", path: "/agent-api/message/decide", token: blockedToken, agentId: blocked.id,
      body: {
        messageId: coordinationApiMessage.id,
        decision: "request_reply",
        reason: "better_fit",
        summary: `blocked-api-coordination-${suffix}`,
      },
    });
    const rejectedCoordinationApiRow = (await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, coordinationApiMessage.id),
      eq(schema.agentMessageDecisions.agentId, blocked.id),
    )))[0]!;
    check("reply decision API returns 403 without saving rejected input", rejectedCoordinationApi.status === 403
      && rejectedCoordinationApi.body.code === "INPUT_SOURCE_REJECTED"
      && rejectedCoordinationApiRow.decision === "pending"
      && rejectedCoordinationApiRow.summary === null);
    await db.update(schema.agentMessageDecisions).set({
      decision: "requested", reasonCode: "better_fit", summary: "prior request", decidedAt: new Date(),
    }).where(and(
      eq(schema.agentMessageDecisions.messageId, coordinationMessage.id),
      eq(schema.agentMessageDecisions.agentId, blocked.id),
    ));
    await db.update(schema.agents).set({ incomingMode: "sealed", commandWhitelist: [] })
      .where(eq(schema.agents.id, blocked.id));
    const rejectedDelegation = await decideReply({
      serverId: server.id,
      agentId: target.id,
      messageId: coordinationMessage.id,
      decision: "delegate",
      delegateToAgentId: blocked.id,
    });
    const delegationRows = await db.select().from(schema.agentMessageDecisions)
      .where(eq(schema.agentMessageDecisions.messageId, coordinationMessage.id));
    const delegationOwner = delegationRows.find((row) => row.agentId === target.id)!;
    const delegationTarget = delegationRows.find((row) => row.agentId === blocked.id)!;
    check("protected delegate target keeps coordination ownership unchanged", !rejectedDelegation.ok
      && rejectedDelegation.code === "INPUT_SOURCE_REJECTED"
      && delegationOwner.grantStatus === "active"
      && delegationOwner.decision === "pending"
      && delegationTarget.grantStatus === "none"
      && delegationTarget.delegatedByAgentId === null);
    await db.insert(schema.agentMessageDecisions).values({
      serverId: server.id,
      channelId: channel!.id,
      messageId: coordinationMessage.id,
      agentId: peer.id,
      attention: "direct",
      observedAt: new Date(),
      decision: "requested",
      reasonCode: "better_fit",
      summary: "allowed candidate",
      decidedAt: new Date(Date.now() + 1_000),
    });
    const promotedCoordination = await decideReply({
      serverId: server.id,
      agentId: target.id,
      messageId: coordinationMessage.id,
      decision: "no_action",
    });
    const promotionRows = await db.select().from(schema.agentMessageDecisions)
      .where(eq(schema.agentMessageDecisions.messageId, coordinationMessage.id));
    const blockedPromotion = promotionRows.find((row) => row.agentId === blocked.id)!;
    const allowedPromotion = promotionRows.find((row) => row.agentId === peer.id)!;
    check("primary release skips protected coordination candidates", promotedCoordination.ok
      && promotedCoordination.promotedAgentId === peer.id
      && blockedPromotion.grantStatus === "none"
      && allowedPromotion.grantStatus === "active"
      && allowedPromotion.delegatedByAgentId === target.id);
    await db.update(schema.agentMessageDecisions).set({ grantStatus: "released" }).where(and(
      eq(schema.agentMessageDecisions.messageId, coordinationMessage.id),
      eq(schema.agentMessageDecisions.agentId, peer.id),
    ));
    await db.update(schema.agentMessageDecisions).set({
      decision: "pending", reasonCode: null, summary: null,
      grantSlot: "primary", grantStatus: "active", delegatedByAgentId: null,
    }).where(and(
      eq(schema.agentMessageDecisions.messageId, coordinationMessage.id),
      eq(schema.agentMessageDecisions.agentId, target.id),
    ));
    const blockedCoordinationSummary = `legacy-blocked-${suffix}`;
    await db.update(schema.agentMessageDecisions).set({
      decision: "requested", reasonCode: "better_fit", summary: blockedCoordinationSummary,
      decidedAt: new Date(), ownerNotifiedAt: null,
    }).where(and(
      eq(schema.agentMessageDecisions.messageId, coordinationMessage.id),
      eq(schema.agentMessageDecisions.agentId, blocked.id),
    ));
    const protectedCoordinationInbox = await claimReplyCoordination(server.id, target.id);
    const cleanedRequest = (await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, coordinationMessage.id),
      eq(schema.agentMessageDecisions.agentId, blocked.id),
    )))[0]!;
    check("coordination inbox removes a newly rejected request", protectedCoordinationInbox.length === 0
      && cleanedRequest.decision === "denied"
      && cleanedRequest.summary === null
      && cleanedRequest.ownerNotifiedAt === null);

    await db.update(schema.agentMessageDecisions).set({
      decision: "requested", reasonCode: "better_fit", summary: blockedCoordinationSummary,
      grantStatus: "active", delegatedByAgentId: blocked.id, grantNotifiedAt: null,
    }).where(and(
      eq(schema.agentMessageDecisions.messageId, coordinationMessage.id),
      eq(schema.agentMessageDecisions.agentId, target.id),
    ));
    const protectedGrantInbox = await claimReplyCoordination(server.id, target.id);
    const cleanedGrant = (await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, coordinationMessage.id),
      eq(schema.agentMessageDecisions.agentId, target.id),
    )))[0]!;
    check("coordination inbox releases a newly rejected grant", protectedGrantInbox.length === 0
      && cleanedGrant.decision === "denied"
      && cleanedGrant.summary === null
      && cleanedGrant.grantStatus === "released"
      && cleanedGrant.grantNotifiedAt === null);
    const deniedThread = await agentApi({
      method: "GET", path: `/agent-api/thread/read?parent=${task.id.slice(0, 8)}`,
      token: targetToken, agentId: target.id,
    });
    check("thread read hides a rejected parent with 404", deniedThread.status === 404
      && !JSON.stringify(deniedThread.body).includes("protected task handoff"));
    const protectedSearch = await agentApi({
      method: "GET", path: `/agent-api/search?q=${encodeURIComponent("protected task handoff")}`,
      token: targetToken, agentId: target.id,
    });
    check("search omits rejected agent rows and attributed audits", protectedSearch.status === 200
      && protectedSearch.body.results.length === 0
      && !JSON.stringify(protectedSearch.body).includes("protected task handoff"));
    const humanTask = await createMessage({
      serverId: server.id, channelId: channel!.id, senderType: "user", senderId: owner.id,
      senderName: owner.name, content: "trusted human task", asTask: true,
    });
    const protectedTasks = await agentApi({
      method: "GET", path: `/agent-api/task/list?channel=${encodeURIComponent(`#${channel!.name}`)}`,
      token: targetToken, agentId: target.id,
    });
    const taskListText = JSON.stringify(protectedTasks.body);
    check("task list hides rejected agent tasks", protectedTasks.status === 200
      && !taskListText.includes("protected task handoff")
      && taskListText.includes(humanTask.content));

    const threadParent = await createMessage({
      serverId: server.id, channelId: channel!.id, senderType: "user", senderId: owner.id,
      senderName: owner.name, content: "trusted thread parent",
    });
    const thread = await getOrCreateThread(server.id, threadParent.id);
    const blockedReply = `blocked-thread-reply-${suffix}`;
    await createMessage({
      serverId: server.id, channelId: thread.id, senderType: "agent", senderId: blocked.id,
      senderName: blocked.name, content: blockedReply,
    });
    const trustedReply = `trusted-thread-reply-${suffix}`;
    await createMessage({
      serverId: server.id, channelId: thread.id, senderType: "user", senderId: owner.id,
      senderName: owner.name, content: trustedReply,
    });
    const protectedThread = await agentApi({
      method: "GET", path: `/agent-api/thread/read?parent=${threadParent.id.slice(0, 8)}`,
      token: targetToken, agentId: target.id,
    });
    const threadText = JSON.stringify(protectedThread.body);
    check("thread read filters rejected replies under an allowed parent", protectedThread.status === 200
      && threadText.includes("trusted thread parent") && threadText.includes(trustedReply)
      && !threadText.includes(blockedReply));

    const [freshnessChannel] = await db.insert(schema.channels).values({
      serverId: server.id, name: `policy-fresh-${suffix}`, type: "channel",
    }).returning();
    await db.insert(schema.channelMembers).values([target, blocked].map((agent) => ({
      channelId: freshnessChannel!.id, memberType: "agent", memberId: agent.id,
    })));
    const freshnessSentinel = `blocked-freshness-${suffix}`;
    await createMessage({
      serverId: server.id, channelId: freshnessChannel!.id, senderType: "agent", senderId: blocked.id,
      senderName: blocked.name, content: freshnessSentinel,
    });
    const freshnessSend = await agentApi({
      method: "POST", path: "/agent-api/message/send", token: targetToken, agentId: target.id,
      body: { target: `#${freshnessChannel!.name}`, content: "safe outgoing message" },
    });
    check("rejected input does not trigger or appear in freshness hold", freshnessSend.status === 200
      && freshnessSend.body.ok === true && freshnessSend.body.held === undefined
      && !JSON.stringify(freshnessSend.body).includes(freshnessSentinel));
  } finally {
    await db.delete(schema.reminders).where(eq(schema.reminders.serverId, server.id));
    await db.delete(schema.causalEdges).where(eq(schema.causalEdges.serverId, server.id));
    await db.delete(schema.agentMessageObservations).where(eq(schema.agentMessageObservations.serverId, server.id));
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, server.id));
    await db.delete(schema.attachments).where(eq(schema.attachments.serverId, server.id));
    const messageIds = (await db.select({ id: schema.messages.id }).from(schema.messages)
      .where(eq(schema.messages.serverId, server.id))).map((message) => message.id);
    if (messageIds.length) await db.delete(schema.messageMentions).where(inArray(schema.messageMentions.messageId, messageIds));
    await db.delete(schema.messages).where(eq(schema.messages.serverId, server.id));
    await db.delete(schema.conversationTurns).where(eq(schema.conversationTurns.serverId, server.id));
    const channelIds = (await db.select({ id: schema.channels.id }).from(schema.channels)
      .where(eq(schema.channels.serverId, server.id))).map((channel) => channel.id);
    if (channelIds.length) await db.delete(schema.channelMembers).where(inArray(schema.channelMembers.channelId, channelIds));
    await db.delete(schema.channels).where(eq(schema.channels.serverId, server.id));
    await db.delete(schema.agents).where(inArray(schema.agents.serverId, [server.id, foreignServer.id]));
    await db.delete(schema.serverMembers).where(inArray(schema.serverMembers.serverId, [server.id, foreignServer.id]));
    await db.delete(schema.servers).where(inArray(schema.servers.id, [server.id, foreignServer.id]));
    await db.delete(schema.users).where(inArray(schema.users.id, users.map((user) => user.id)));
    await sql.end();
  }
}

main().then(() => {
  console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}).catch(async (error) => {
  console.error("ERROR:", error);
  try { await sql.end(); } catch { /* ignore cleanup failure */ }
  process.exit(1);
});
