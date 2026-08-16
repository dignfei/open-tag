// Real DB integration: an unexpected agent termination can fail many buffered turns at
// once; each used to burn a visible "needs attention" error receipt into the channel
// (live 2026-08-17 flood). finalizeAgentActivityRun now coalesces: at most one error
// receipt per agent+channel per 10-minute window, later failed runs merge into it.
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/errorReceiptCoalesce.integration.ts
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { finalizeAgentActivityRun } from "../src/server/core.ts";
import { logActivity } from "../src/server/agentActivity.ts";

const ts = Date.now();
let serverId = "", ownerId = "", agentId = "", chId = "";
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function setup() {
  const [u] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  const [ag] = await db.insert(schema.agents).values({ serverId, name: `crashy_${ts}`, displayName: "Crashy" }).returning();
  agentId = ag!.id;
  const [c] = await db.insert(schema.channels).values({ serverId, name: `flood_${ts}`, type: "channel" }).returning();
  chId = c!.id;
}

async function cleanup() {
  await db.delete(schema.agentActivityLog).where(eq(schema.agentActivityLog.serverId, serverId));
  await db.delete(schema.messages).where(eq(schema.messages.serverId, serverId));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

const receipts = () => db.select().from(schema.messages).where(and(
  eq(schema.messages.channelId, chId),
  eq(schema.messages.messageType, "agent_activity_receipt"),
));

async function main() {
  await setup();
  for (const s of ["s-a", "s-b", "s-c"]) {
    await logActivity(serverId, agentId, { kind: "status", activity: "error", detail: `crashed ${s}` }, { channelId: chId, streamId: `${s}-${ts}`, runSeq: 1 });
  }
  await finalizeAgentActivityRun(serverId, agentId, chId, `s-a-${ts}`, "Crashy", "error");
  check("first failed run creates a receipt", (await receipts()).length === 1);

  await finalizeAgentActivityRun(serverId, agentId, chId, `s-b-${ts}`, "Crashy", "error");
  await finalizeAgentActivityRun(serverId, agentId, chId, `s-c-${ts}`, "Crashy", "error");
  const rows = await receipts();
  check("crash flood coalesces into ONE receipt within the window", rows.length === 1);
  check("merged receipt carries all three runs' activity", (rows[0]?.agentActivity?.length ?? 0) === 3);
}

main()
  .then(cleanup)
  .then(() => {
    if (failures > 0) {
      console.log(`\n${failures} CHECK(S) FAILED ❌`);
    } else {
      console.log("\nALL PASS ✅");
    }
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (e) => { console.error("ERROR:", e); try { await cleanup(); } catch { /**/ } process.exit(1); });
