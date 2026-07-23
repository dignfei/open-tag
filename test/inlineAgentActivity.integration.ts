// Real database verification for run -> message Activity ownership.
// Requires an isolated worktree database with `npm run db:push` applied.
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { logActivity, startAgentActivityRun } from "../src/server/agentActivity.ts";
import { createMessage, finalizeAgentActivityRun } from "../src/server/core.ts";

const stamp = Date.now();
let serverId = "";
let ownerId = "";
let agentId = "";
let channelId = "";
let failures = 0;

const check = (label: string, value: boolean) => {
  console.log(`  ${value ? "PASS" : "FAIL"} ${label}`);
  if (!value) failures++;
};

async function setup() {
  const [owner] = await db.insert(schema.users).values({ name: `activity_owner_${stamp}`, displayName: "Activity Owner", email: `activity_${stamp}@test.local` }).returning();
  ownerId = owner!.id;
  const [server] = await db.insert(schema.servers).values({ name: "Activity Test", slug: `activity-${stamp}`, ownerId }).returning();
  serverId = server!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  const [agent] = await db.insert(schema.agents).values({ serverId, name: `activity_agent_${stamp}`, displayName: "Activity Agent" }).returning();
  agentId = agent!.id;
  const [channel] = await db.insert(schema.channels).values({ serverId, name: `activity-${stamp}`, type: "channel" }).returning();
  channelId = channel!.id;
  await db.insert(schema.channelMembers).values([
    { channelId, memberType: "user", memberId: ownerId },
    { channelId, memberType: "agent", memberId: agentId },
  ]);
}

async function cleanup() {
  if (!serverId) return;
  await db.delete(schema.agentActivityLog).where(eq(schema.agentActivityLog.serverId, serverId));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  await setup();

  const streamId = `stream-${stamp}`;
  await startAgentActivityRun(serverId, agentId, channelId, streamId);
  await logActivity(serverId, agentId, { kind: "text", text: "Inspecting the request", timestamp: stamp + 1 }, { channelId, streamId, runSeq: 1 });

  const first = await createMessage({ serverId, channelId, senderType: "agent", senderId: agentId, senderName: "Activity Agent", content: "First public update" });
  const firstStored = (await db.select().from(schema.messages).where(eq(schema.messages.id, first.id)))[0]!;
  check("first public message claims the active run", firstStored.agentActivityStreamId === streamId);
  check("first public message owns the start and narration events", firstStored.agentActivity.length === 2);
  check("first public message remains running until the next boundary", firstStored.agentActivityState === "running");

  const second = await createMessage({ serverId, channelId, senderType: "agent", senderId: agentId, senderName: "Activity Agent", content: "Second public update" });
  const firstClosed = (await db.select().from(schema.messages).where(eq(schema.messages.id, first.id)))[0]!;
  const secondStored = (await db.select().from(schema.messages).where(eq(schema.messages.id, second.id)))[0]!;
  check("back-to-back public messages keep the same run without an intermediate event", secondStored.agentActivityStreamId === streamId);
  check("opening the second segment closes the first", firstClosed.agentActivityState === "handled");
  check("the second segment starts empty instead of duplicating earlier Activity", secondStored.agentActivity.length === 0);

  await logActivity(serverId, agentId, { kind: "tool", toolName: "commandExecution", toolInput: "open-tag message send", timestamp: stamp + 2 }, { channelId, streamId, runSeq: 2 });
  await finalizeAgentActivityRun(serverId, agentId, channelId, streamId, "Activity Agent", "handled");
  const secondFinal = (await db.select().from(schema.messages).where(eq(schema.messages.id, second.id)))[0]!;
  check("tail Activity is attached to the last public message", secondFinal.agentActivity.some((item) => item.toolName === "commandExecution"));
  check("finalization closes the last public segment", secondFinal.agentActivityState === "handled");

  const silentStream = `silent-${stamp}`;
  await startAgentActivityRun(serverId, agentId, channelId, silentStream);
  await logActivity(serverId, agentId, { kind: "text", text: "Checked; no public reply needed", timestamp: stamp + 3 }, { channelId, streamId: silentStream, runSeq: 1 });
  await finalizeAgentActivityRun(serverId, agentId, channelId, silentStream, "Activity Agent", "handled");
  const receipts = await db.select().from(schema.messages).where(eq(schema.messages.agentActivityStreamId, silentStream));
  check("a no-message run creates exactly one receipt", receipts.length === 1);
  check("the receipt has no fake public body", receipts[0]?.messageType === "agent_activity_receipt" && receipts[0]?.content === "");
  check("the receipt preserves the complete silent-run Activity", receipts[0]?.agentActivity.length === 2);
}

main()
  .then(cleanup)
  .then(() => { console.log(`\n${failures ? `${failures} CHECK(S) FAILED` : "ALL PASS"}`); process.exit(failures ? 1 : 0); })
  .catch(async (error) => { console.error(error); try { await cleanup(); } catch { /* cleanup best effort */ } process.exit(1); });
