// Integration coverage for reused agent handles in DM resolution.
// Requires dev infra: npm run infra (PostgreSQL :5433, Redis :6380).
// Run: npx tsx test/resolveTargetDeletedTwin.integration.ts
import "../src/env.ts";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { resolveTarget } from "../src/server/core.ts";

const suffix = `${Date.now()}_${process.pid}`;
const twinName = `é_twin_${suffix}`.normalize("NFC");
const twinTarget = twinName.normalize("NFD");
let serverId = "";
let ownerId = "";
let deletedTwinId = "";
let liveTwinId = "";
let senderId = "";
let priorityHumanId = "";
let priorityAgentId = "";
const priorityName = `priority_${suffix}`;
let failures = 0;

const check = (label: string, condition: boolean) => {
  console.log(`  ${condition ? "✔" : "✗ FAIL"} ${label}`);
  if (!condition) failures++;
};

async function setup() {
  const [owner] = await db.insert(schema.users).values({
    name: `owner_${suffix}`,
    displayName: "Owner",
    email: `owner_${suffix}@test.local`,
  }).returning();
  ownerId = owner!.id;

  const [server] = await db.insert(schema.servers).values({
    name: "Deleted handle test",
    slug: `deleted-handle-${suffix}`,
    ownerId,
  }).returning();
  serverId = server!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });

  const [priorityHuman] = await db.insert(schema.users).values({ name: priorityName, displayName: "Priority Human" }).returning();
  priorityHumanId = priorityHuman!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: priorityHumanId, role: "member" });
  const [priorityAgent] = await db.insert(schema.agents).values({ serverId, name: priorityName, displayName: "Priority Agent" }).returning();
  priorityAgentId = priorityAgent!.id;

  const [deletedTwin] = await db.insert(schema.agents).values({ serverId, name: twinName, displayName: "Deleted Twin" }).returning();
  deletedTwinId = deletedTwin!.id;
  await db.update(schema.agents).set({ deletedAt: new Date() }).where(eq(schema.agents.id, deletedTwinId));

  const [sender] = await db.insert(schema.agents).values({
    serverId,
    name: `sender_${suffix}`,
    displayName: "Sender",
  }).returning();
  senderId = sender!.id;

  const [zombieDm] = await db.insert(schema.channels).values({
    serverId,
    name: `dm:${[senderId, deletedTwinId].sort().join(":")}`,
    type: "dm",
  }).returning();
  await db.insert(schema.channelMembers).values([
    { channelId: zombieDm!.id, memberType: "agent", memberId: senderId },
    { channelId: zombieDm!.id, memberType: "agent", memberId: deletedTwinId },
  ]);
}

async function cleanup() {
  if (serverId) {
    const channels = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
    for (const channel of channels) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, channel.id));
    await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
    await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
    await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  }
  for (const userId of [priorityHumanId, ownerId]) {
    if (userId) await db.delete(schema.users).where(eq(schema.users.id, userId));
  }
}

async function main() {
  await setup();

  const deletedOnlyTarget = await resolveTarget(serverId, `dm:@${twinTarget}`, senderId);
  check("a deleted-only handle is not a dm target", deletedOnlyTarget === null);

  const [liveTwin] = await db.insert(schema.agents).values({ serverId, name: twinName, displayName: "Live Twin" }).returning();
  liveTwinId = liveTwin!.id;

  const target = await resolveTarget(serverId, `dm:@${twinTarget}`, senderId);
  check("dm target resolves", target !== null);
  const members = target
    ? await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, target.channelId))
    : [];
  check("dm target contains the live replacement", members.some((member) => member.memberId === liveTwinId));
  check("dm target excludes the deleted agent", !members.some((member) => member.memberId === deletedTwinId));

  const priorityTarget = await resolveTarget(serverId, `dm:@${priorityName}`, senderId);
  const priorityMembers = priorityTarget
    ? await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, priorityTarget.channelId))
    : [];
  check("a workspace human keeps priority over a same-named agent", priorityMembers.some((member) => member.memberId === priorityHumanId));
  check("the same-named agent is not selected when a workspace human matches", !priorityMembers.some((member) => member.memberId === priorityAgentId));
}

main()
  .then(async () => { await cleanup(); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (error) => {
    console.error(error);
    try { await cleanup(); } catch { /* best-effort cleanup */ }
    process.exit(1);
  });
