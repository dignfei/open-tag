// Real PostgreSQL + Redis integration for channel deletion compare-and-set behavior.
// Run: JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx test/channelDeleteIdempotency.integration.ts
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db/index.ts";
import { pub, redis, sub } from "../src/redis.ts";
import { deleteChannelWithAgentNotice } from "../src/server/channelDeletion.ts";
import { channelDeletedNoticeForAgent } from "../src/server/channelDeletionNotice.ts";

const runId = Date.now();
let userId = "";
let serverId = "";
let channelId = "";
let memberAgentId = "";

async function setup(): Promise<void> {
  const [user] = await db.insert(schema.users).values({
    name: `delete_once_${runId}`,
    displayName: "Delete Once",
    email: `delete_once_${runId}@test.local`,
  }).returning();
  userId = user!.id;
  const [server] = await db.insert(schema.servers).values({
    name: "Delete once test",
    slug: `delete-once-${runId}`,
    ownerId: userId,
  }).returning();
  serverId = server!.id;
  const [channel] = await db.insert(schema.channels).values({
    serverId,
    name: `delete-once-${runId}`,
    type: "channel",
  }).returning();
  channelId = channel!.id;
  const [memberAgent, formerAgent] = await db.insert(schema.agents).values([
    { serverId, name: `delete_member_${runId}`, displayName: "Delete Member" },
    { serverId, name: `delete_former_${runId}`, displayName: "Delete Former", deletedAt: new Date() },
  ]).returning();
  memberAgentId = memberAgent!.id;
  await db.insert(schema.channelMembers).values([
    { channelId, memberType: "agent", memberId: memberAgentId },
    { channelId, memberType: "agent", memberId: formerAgent!.id },
  ]);
}

async function cleanup(): Promise<void> {
  if (channelId) {
    await db.delete(schema.messages).where(eq(schema.messages.channelId, channelId));
    await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
    await db.delete(schema.channels).where(eq(schema.channels.id, channelId));
  }
  if (serverId) await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  if (serverId) await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
}

async function main(): Promise<void> {
  await setup();
  const outcomes = await Promise.all(Array.from(
    { length: 8 },
    () => deleteChannelWithAgentNotice(serverId, channelId),
  ));
  assert.equal(outcomes.filter((outcome) => outcome.deleted).length, 1);
  const winner = outcomes.find((outcome) => outcome.deleted);
  assert.deepEqual(winner?.deleted && winner.recipientAgentIds, [memberAgentId]);
  assert.deepEqual(await deleteChannelWithAgentNotice(serverId, channelId), { deleted: false });
  const [channel] = await db.select({ deletedAt: schema.channels.deletedAt })
    .from(schema.channels).where(eq(schema.channels.id, channelId));
  assert.ok(channel?.deletedAt instanceof Date);
  const notices = await db.select().from(schema.messages).where(and(
    eq(schema.messages.channelId, channelId),
    eq(schema.messages.messageType, "system"),
  ));
  assert.equal(notices.length, 1);
  assert.ok(channelDeletedNoticeForAgent(notices[0]!.actionMetadata, channelId, memberAgentId));
  console.log("channel deletion idempotency integration passed");
}

main()
  .then(async () => {
    await cleanup();
    await Promise.all([redis.quit(), pub.quit(), sub.quit()]);
    await sql.end();
  })
  .catch(async (error) => {
    console.error(error);
    try { await cleanup(); } catch (cleanupError) { console.error(cleanupError); }
    try { await Promise.all([redis.quit(), pub.quit(), sub.quit()]); } catch (closeError) { console.error(closeError); }
    await sql.end();
    process.exit(1);
  });
