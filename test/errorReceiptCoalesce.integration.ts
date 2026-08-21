// Real DB integration for grouping recent agent error receipts.
// Run: npx tsx test/errorReceiptCoalesce.integration.ts
import { and, asc, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { logActivity } from "../src/server/agentActivity.ts";
import { finalizeAgentActivityRun } from "../src/server/core.ts";

const run = `${Date.now()}_${process.pid}`;
let serverId = "";
let ownerId = "";
let agentId = "";
let otherAgentId = "";
let primaryChannelId = "";
let otherChannelId = "";
let failures = 0;

function check(label: string, condition: boolean) {
  console.log(`  ${condition ? "✔" : "✗ FAIL"} ${label}`);
  if (!condition) failures++;
}

async function setup() {
  const [owner] = await db.insert(schema.users).values({
    name: `error_owner_${run}`,
    displayName: "Owner",
    email: `error_owner_${run}@test.local`,
  }).returning();
  ownerId = owner!.id;

  const [server] = await db.insert(schema.servers).values({
    name: "Error receipt test",
    slug: `error-receipt-${run}`,
    ownerId,
  }).returning();
  serverId = server!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });

  const [agent, otherAgent] = await db.insert(schema.agents).values([
    { serverId, name: `error_agent_${run}`, displayName: "Error Agent" },
    { serverId, name: `other_agent_${run}`, displayName: "Other Agent" },
  ]).returning();
  agentId = agent!.id;
  otherAgentId = otherAgent!.id;

  const [primary, other] = await db.insert(schema.channels).values([
    { serverId, name: `errors_${run}`, type: "channel" },
    { serverId, name: `other_${run}`, type: "channel" },
  ]).returning();
  primaryChannelId = primary!.id;
  otherChannelId = other!.id;
}

async function cleanup() {
  if (!serverId) return;
  await db.delete(schema.agentActivityLog).where(eq(schema.agentActivityLog.serverId, serverId));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function finish(channelId: string, stream: string, state: "handled" | "error", actorId = agentId) {
  const streamId = `${stream}_${run}`;
  await logActivity(serverId, actorId, {
    kind: "status",
    activity: state,
    detail: stream,
  }, { channelId, streamId, runSeq: 1 });
  await finalizeAgentActivityRun(serverId, actorId, channelId, streamId, actorId === agentId ? "Error Agent" : "Other Agent", state);
  return streamId;
}

function receipts(channelId: string, actorId: string, state?: "handled" | "error") {
  const filters = [
    eq(schema.messages.channelId, channelId),
    eq(schema.messages.senderId, actorId),
    eq(schema.messages.messageType, "agent_activity_receipt"),
  ];
  if (state) filters.push(eq(schema.messages.agentActivityState, state));
  return db.select().from(schema.messages).where(and(...filters)).orderBy(asc(schema.messages.seq));
}

async function main() {
  await setup();

  await Promise.all([
    finish(primaryChannelId, "first-error", "error"),
    finish(primaryChannelId, "second-error", "error"),
    finish(primaryChannelId, "third-error", "error"),
  ]);
  let errors = await receipts(primaryChannelId, agentId, "error");
  check("concurrent recent errors share one receipt", errors.length === 1);
  check("the shared receipt retains every run", errors[0]?.agentActivity.length === 3);
  let activityRows = await db.select().from(schema.agentActivityLog).where(and(
    eq(schema.agentActivityLog.serverId, serverId),
    eq(schema.agentActivityLog.agentId, agentId),
    eq(schema.agentActivityLog.channelId, primaryChannelId),
  ));
  check("receipt owns every source activity row", activityRows.length === 3 && activityRows.every((row) => row.messageId === errors[0]?.id));

  const createdStreamId = errors[0]!.agentActivityStreamId!;
  await finalizeAgentActivityRun(serverId, agentId, primaryChannelId, createdStreamId, "Error Agent", "error");
  errors = await receipts(primaryChannelId, agentId, "error");
  check("repeated receipt finalization does not duplicate activity", errors.length === 1 && errors[0]?.agentActivity.length === 3);
  const receiptPosition = { id: errors[0]!.id, seq: errors[0]!.seq, createdAt: errors[0]!.createdAt.getTime() };

  const groupedStreamId = await finish(primaryChannelId, "grouped-error", "error");
  errors = await receipts(primaryChannelId, agentId, "error");
  activityRows = await db.select().from(schema.agentActivityLog).where(and(
    eq(schema.agentActivityLog.serverId, serverId),
    eq(schema.agentActivityLog.agentId, agentId),
    eq(schema.agentActivityLog.channelId, primaryChannelId),
  ));
  check("grouped receipt follows the latest stream", errors[0]?.agentActivityStreamId === groupedStreamId);
  check("grouping preserves the receipt timeline position", errors[0]?.id === receiptPosition.id && errors[0]?.seq === receiptPosition.seq && errors[0]?.createdAt.getTime() === receiptPosition.createdAt);
  check("grouped source activity stays bound to the receipt", errors[0]?.agentActivity.length === 4 && activityRows.length === 4 && activityRows.every((row) => row.messageId === errors[0]?.id));

  await finish(primaryChannelId, "handled", "handled");
  check("handled runs keep their own receipt", (await receipts(primaryChannelId, agentId)).length === 2);

  await finish(otherChannelId, "other-error", "error");
  check("another channel keeps its own error receipt", (await receipts(otherChannelId, agentId, "error")).length === 1);

  await finish(primaryChannelId, "other-agent-error", "error", otherAgentId);
  check("another agent keeps its own error receipt", (await receipts(primaryChannelId, otherAgentId, "error")).length === 1);

  await db.update(schema.messages)
    .set({ createdAt: new Date(Date.now() - 11 * 60 * 1000) })
    .where(eq(schema.messages.id, errors[0]!.id));
  await finish(primaryChannelId, "expired-error", "error");
  errors = await receipts(primaryChannelId, agentId, "error");
  check("an expired window starts a new receipt", errors.length === 2);
}

main()
  .then(cleanup)
  .then(() => process.exit(failures === 0 ? 0 : 1))
  .catch(async (error) => {
    console.error(error);
    try { await cleanup(); } catch { /* best effort */ }
    process.exit(1);
  });
