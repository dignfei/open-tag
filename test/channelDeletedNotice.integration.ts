// Real PostgreSQL + Redis integration for the channel-deletion agent notice.
// Run: JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx test/channelDeletedNotice.integration.ts
import "../src/env.js";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "../src/db/index.ts";
import { pub, redis, sub } from "../src/redis.ts";
import { hashToken, signUser } from "../src/server/auth.ts";
import { channelDeletedNoticeForAgent } from "../src/server/channelDeletionNotice.ts";
import { registerDaemon, unregisterDaemon } from "../src/server/daemonHub.ts";
import { handleAgentApi } from "../src/server/routes-agent.ts";
import { handleApi } from "../src/server/routes-api/index.ts";
import { nextSeq } from "../src/server/realtime.ts";

const suffix = `${Date.now()}_${process.pid}`;
const frames: Record<string, any>[] = [];
const fakeDaemon = {
  readyState: 1,
  send(data: string) { frames.push(JSON.parse(data)); },
} as any;
const agentTokens = [`sk_agent_delete_a_${suffix}`, `sk_agent_delete_b_${suffix}`];
const outsiderToken = `sk_agent_delete_outsider_${suffix}`;
let ownerId = "";
let memberId = "";
let foreignOwnerId = "";
let serverId = "";
let foreignServerId = "";
let channelId = "";
let protectedChannelId = "";
const agentIds: string[] = [];
let outsiderAgentId = "";

function request(method: string, path: string, headers: Record<string, string>): IncomingMessage {
  return Object.assign(Readable.from([] as Buffer[]), { method, url: path, headers }) as unknown as IncomingMessage;
}

function response() {
  let status = 0;
  let raw = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    writeHead(code: number) { status = code; this.statusCode = code; },
    end(data?: string | Buffer) { raw = data ? String(data) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  return { res, result: () => ({ status, body: raw ? JSON.parse(raw) : null }) };
}

async function humanDelete(userToken: string, targetId: string) {
  const path = `/api/channels/${targetId}`;
  const capture = response();
  await handleApi(request("DELETE", path, {
    authorization: `Bearer ${userToken}`,
    "x-server-id": serverId,
  }), capture.res, new URL(path, "http://localhost"), "DELETE");
  return capture.result();
}

async function agentCheck(agentId: string, token: string) {
  const path = "/agent-api/message/check";
  const capture = response();
  await handleAgentApi(request("GET", path, {
    authorization: `Bearer ${token}`,
    "x-agent-id": agentId,
  }), capture.res, new URL(path, "http://localhost"), "GET");
  return capture.result();
}

async function setup() {
  const [owner, member, foreignOwner] = await db.insert(schema.users).values([
    { name: `delete_owner_${suffix}`, displayName: "Delete Owner", email: `delete_owner_${suffix}@test.local` },
    { name: `delete_member_${suffix}`, displayName: "Delete Member", email: `delete_member_${suffix}@test.local` },
    { name: `delete_foreign_${suffix}`, displayName: "Delete Foreign", email: `delete_foreign_${suffix}@test.local` },
  ]).returning();
  ownerId = owner!.id;
  memberId = member!.id;
  foreignOwnerId = foreignOwner!.id;
  const [server, foreignServer] = await db.insert(schema.servers).values([
    { name: "Deletion notice", slug: `deletion-notice-${suffix}`, ownerId },
    { name: "Foreign deletion notice", slug: `foreign-deletion-notice-${suffix}`, ownerId: foreignOwnerId },
  ]).returning();
  serverId = server!.id;
  foreignServerId = foreignServer!.id;
  await db.insert(schema.serverMembers).values([
    { serverId, userId: ownerId, role: "owner" },
    { serverId, userId: memberId, role: "member" },
    { serverId: foreignServerId, userId: foreignOwnerId, role: "owner" },
  ]);

  const [first, second, outsider, former, foreign] = await db.insert(schema.agents).values([
    { serverId, name: `delete_agent_a_${suffix}`, displayName: "Delete Agent A", agentTokenHash: hashToken(agentTokens[0]!), status: "active" },
    { serverId, name: `delete_agent_b_${suffix}`, displayName: "Delete Agent B", agentTokenHash: hashToken(agentTokens[1]!), status: "active" },
    { serverId, name: `delete_outsider_${suffix}`, displayName: "Delete Outsider", agentTokenHash: hashToken(outsiderToken), status: "active" },
    { serverId, name: `delete_former_${suffix}`, displayName: "Delete Former", deletedAt: new Date() },
    { serverId: foreignServerId, name: `delete_foreign_agent_${suffix}`, displayName: "Delete Foreign Agent", status: "active" },
  ]).returning();
  agentIds.push(first!.id, second!.id);
  outsiderAgentId = outsider!.id;

  const [channel, protectedChannel] = await db.insert(schema.channels).values([
    { serverId, name: `release-room-${suffix}`, type: "channel" },
    { serverId, name: `protected-room-${suffix}`, type: "channel" },
  ]).returning();
  channelId = channel!.id;
  protectedChannelId = protectedChannel!.id;
  await db.insert(schema.channelMembers).values([
    ...agentIds.map((agentId) => ({ channelId, memberType: "agent", memberId: agentId })),
    { channelId, memberType: "agent", memberId: former!.id },
    { channelId, memberType: "agent", memberId: foreign!.id },
  ]);
  await db.insert(schema.messages).values({
    seq: await nextSeq(serverId),
    serverId,
    channelId,
    senderType: "user",
    senderId: ownerId,
    senderName: owner!.name,
    content: `history ${suffix}`,
  });
}

async function cleanup() {
  unregisterDaemon(fakeDaemon);
  const serverIds = [serverId, foreignServerId].filter(Boolean);
  if (serverIds.length) {
    await db.delete(schema.agentMessageObservations).where(inArray(schema.agentMessageObservations.serverId, serverIds));
    await db.delete(schema.agentMessageDecisions).where(inArray(schema.agentMessageDecisions.serverId, serverIds));
    await db.delete(schema.messages).where(inArray(schema.messages.serverId, serverIds));
    const channels = await db.select({ id: schema.channels.id }).from(schema.channels).where(inArray(schema.channels.serverId, serverIds));
    if (channels.length) await db.delete(schema.channelMembers).where(inArray(schema.channelMembers.channelId, channels.map(({ id }) => id)));
    await db.delete(schema.channels).where(inArray(schema.channels.serverId, serverIds));
    await db.delete(schema.agents).where(inArray(schema.agents.serverId, serverIds));
    await db.delete(schema.serverMembers).where(inArray(schema.serverMembers.serverId, serverIds));
    await db.delete(schema.servers).where(inArray(schema.servers.id, serverIds));
  }
  const userIds = [ownerId, memberId, foreignOwnerId].filter(Boolean);
  if (userIds.length) await db.delete(schema.users).where(inArray(schema.users.id, userIds));
}

async function closeClients() {
  await Promise.all([redis.quit(), pub.quit(), sub.quit()]);
  await sql.end();
}

async function main() {
  await setup();
  registerDaemon(fakeDaemon, serverId);
  const ownerToken = signUser(ownerId);
  const memberToken = signUser(memberId);

  const denied = await humanDelete(memberToken, protectedChannelId);
  assert.equal(denied.status, 403);
  assert.equal((await db.select().from(schema.channels).where(eq(schema.channels.id, protectedChannelId)))[0]?.deletedAt, null);

  const deletes = await Promise.all([
    humanDelete(ownerToken, channelId),
    humanDelete(ownerToken, channelId),
  ]);
  assert.deepEqual(deletes.map(({ status, body }) => [status, body]), [[200, { ok: true }], [200, { ok: true }]]);

  const notices = (await db.select().from(schema.messages).where(and(
    eq(schema.messages.channelId, channelId),
    eq(schema.messages.messageType, "system"),
  ))).filter((message) => channelDeletedNoticeForAgent(message.actionMetadata, channelId, agentIds[0]!));
  assert.equal(notices.length, 1);
  const notice = notices[0]!;
  const metadata = channelDeletedNoticeForAgent(notice.actionMetadata, channelId, agentIds[0]!)!;
  assert.deepEqual(metadata.recipientAgentIds, [...agentIds].sort());

  const deliveries = frames.filter(({ type }) => type === "agent:deliver");
  assert.deepEqual(deliveries.map(({ agentId }) => agentId).sort(), [...agentIds].sort());
  for (const delivery of deliveries) {
    assert.equal(delivery.attention, "lifecycle");
    assert.equal(delivery.seq, notice.seq);
    assert.equal(delivery.message, undefined);
    assert.equal(delivery.deliveryId, undefined);
    assert.equal(delivery.turnId, undefined);
  }
  const frameCount = frames.length;
  assert.equal((await humanDelete(ownerToken, channelId)).status, 200);
  assert.equal(frames.length, frameCount);

  await db.delete(schema.channelMembers).where(and(
    eq(schema.channelMembers.channelId, channelId),
    eq(schema.channelMembers.memberType, "agent"),
    eq(schema.channelMembers.memberId, agentIds[0]!),
  ));
  const racingChecks = await Promise.all([
    agentCheck(agentIds[0]!, agentTokens[0]!),
    agentCheck(agentIds[0]!, agentTokens[0]!),
  ]);
  assert.equal(racingChecks.flatMap(({ body }) => body.messages).filter(({ id }) => id === notice.id).length, 1);
  assert.ok(racingChecks.flatMap(({ body }) => body.messages).every(({ id }) => id === notice.id));

  const secondInbox = await agentCheck(agentIds[1]!, agentTokens[1]!);
  assert.deepEqual(secondInbox.body.messages.map(({ id }: { id: string }) => id), [notice.id]);
  assert.equal(secondInbox.body.messages[0].coordination, null);
  const [secondMembership] = await db.select({ lastReadSeq: schema.channelMembers.lastReadSeq }).from(schema.channelMembers).where(and(
    eq(schema.channelMembers.channelId, channelId),
    eq(schema.channelMembers.memberType, "agent"),
    eq(schema.channelMembers.memberId, agentIds[1]!),
  ));
  assert.equal(secondMembership?.lastReadSeq, notice.seq);
  assert.deepEqual((await agentCheck(agentIds[1]!, agentTokens[1]!)).body.messages, []);
  assert.deepEqual((await agentCheck(outsiderAgentId, outsiderToken)).body.messages, []);

  const decisions = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, notice.id));
  assert.deepEqual(decisions, []);
  const observations = await db.select().from(schema.agentMessageObservations).where(eq(schema.agentMessageObservations.messageId, notice.id));
  assert.deepEqual(observations.map(({ agentId }) => agentId).sort(), [...agentIds].sort());
  console.log("channel deletion notice integration passed");
}

main()
  .then(async () => { await cleanup(); await closeClients(); })
  .catch(async (error) => {
    console.error(error);
    try { await cleanup(); } catch (cleanupError) { console.error(cleanupError); }
    try { await closeClients(); } catch (closeError) { console.error(closeError); }
    process.exit(1);
  });
