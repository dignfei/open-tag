// Real PostgreSQL integration for channel deletion compare-and-set behavior.
// Run: npx tsx test/channelDeleteIdempotency.integration.ts
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { db, schema, sql } from "../src/db/index.ts";
import { softDeleteChannelOnce } from "../src/server/channelDeletion.ts";

const runId = Date.now();
let userId = "";
let serverId = "";
let channelId = "";

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
}

async function cleanup(): Promise<void> {
  if (channelId) await db.delete(schema.channels).where(eq(schema.channels.id, channelId));
  if (serverId) await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
}

async function main(): Promise<void> {
  await setup();
  const outcomes = await Promise.all(Array.from(
    { length: 8 },
    () => softDeleteChannelOnce(serverId, channelId),
  ));
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(await softDeleteChannelOnce(serverId, channelId), false);
  const [channel] = await db.select({ deletedAt: schema.channels.deletedAt })
    .from(schema.channels).where(eq(schema.channels.id, channelId));
  assert.ok(channel?.deletedAt instanceof Date);
  console.log("channel deletion idempotency integration passed");
}

main()
  .then(async () => {
    await cleanup();
    await sql.end();
  })
  .catch(async (error) => {
    console.error(error);
    try { await cleanup(); } catch (cleanupError) { console.error(cleanupError); }
    await sql.end();
    process.exit(1);
  });
