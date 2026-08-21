// Real DB integration for live-only named channel target resolution.
// Run: npx tsx test/resolveTargetDeletedChannel.integration.ts
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { resolveTarget } from "../src/server/core.ts";

const run = Date.now();
const channelName = `target_${run}`;
let serverId = "";
let ownerId = "";
let senderId = "";
let failures = 0;

function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "✔" : "✗ FAIL"} ${label}`);
  if (!condition) failures++;
}

async function setup() {
  const [owner] = await db.insert(schema.users).values({
    name: `owner_${run}`,
    displayName: "Owner",
    email: `owner_${run}@test.local`,
  }).returning();
  ownerId = owner!.id;

  const [server] = await db.insert(schema.servers).values({
    name: "Target resolution test",
    slug: `target-resolution-${run}`,
    ownerId,
  }).returning();
  serverId = server!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });

  const [sender] = await db.insert(schema.agents).values({
    serverId,
    name: `sender_${run}`,
    displayName: "Sender",
  }).returning();
  senderId = sender!.id;
}

async function cleanup() {
  if (!serverId) return;
  const channels = await db.select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.serverId, serverId));
  for (const channel of channels) {
    await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, channel.id));
  }
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  await setup();
  const [deleted] = await db.insert(schema.channels).values({
    serverId,
    name: channelName,
    type: "channel",
    deletedAt: new Date(),
  }).returning();

  check("deleted channel name is rejected", await resolveTarget(serverId, `#${channelName}`, senderId) === null);
  check("deleted channel thread target is rejected", await resolveTarget(serverId, `#${channelName}:deadbeef`, senderId) === null);

  const [live] = await db.insert(schema.channels).values({ serverId, name: channelName, type: "channel" }).returning();
  const target = await resolveTarget(serverId, `#${channelName}`, senderId);
  check("live same-name channel resolves", target?.channelId === live!.id);
  check("deleted same-name channel stays hidden", target?.channelId !== deleted!.id);
}

main()
  .then(cleanup)
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch(async (error) => {
    console.error(error);
    try { await cleanup(); } catch { /* best effort */ }
    process.exit(1);
  });
