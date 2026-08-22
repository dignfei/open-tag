// Integration coverage for human management of an agent's input-source settings.
// Requires PostgreSQL on the worktree DATABASE_URL after `npm run db:push`.
// Run: JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx test/agentInputPolicy.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "../src/db/index.ts";
import { signUser } from "../src/server/auth.ts";

process.env.OPEN_TAG_DIRECT_TURN_DEBOUNCE_MS = "30000";
const { createMessage, parseMentions } = await import("../src/server/core.ts");
const { dispatchConversationTurn } = await import("../src/server/conversationTurnDispatch.ts");
const { handleApi } = await import("../src/server/routes-api/index.ts");

const suffix = Date.now().toString(36);
let failures = 0;
const check = (label: string, condition: boolean) => {
  console.log(`  ${condition ? "✔" : "✗ FAIL"} ${label}`);
  if (!condition) failures++;
};

function request(options: { method: string; path: string; token: string; serverId: string; body?: object }): IncomingMessage {
  const encoded = options.body === undefined ? "" : JSON.stringify(options.body);
  const stream = Readable.from(encoded ? [Buffer.from(encoded)] : ([] as Buffer[]));
  return Object.assign(stream, {
    method: options.method,
    url: options.path,
    headers: {
      authorization: `Bearer ${options.token}`,
      "x-server-id": options.serverId,
      "content-type": "application/json",
    },
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

async function api(options: { method: string; path: string; token: string; serverId: string; body?: object }) {
  const output = response();
  await handleApi(request(options), output.res, new URL(options.path, "http://localhost"), options.method);
  return { status: output.status(), body: output.body() };
}

async function main() {
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
    { serverId: server.id, name: `target-${suffix}`, displayName: "Target" },
    { serverId: server.id, name: `peer-${suffix}`, displayName: "Peer" },
    { serverId: server.id, name: `blocked-${suffix}`, displayName: "Blocked" },
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

    const forbidden = await api({
      method: "PATCH", path: endpoint, token: memberToken, serverId: server.id,
      body: { incomingMode: "sealed" },
    });
    check("ordinary member cannot change input settings", forbidden.status === 403);

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
  } finally {
    await db.delete(schema.causalEdges).where(eq(schema.causalEdges.serverId, server.id));
    await db.delete(schema.agentMessageObservations).where(eq(schema.agentMessageObservations.serverId, server.id));
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, server.id));
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
