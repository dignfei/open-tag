// Real DB integration: dm:@ resolution must skip soft-deleted same-named agents.
// A soft-deleted twin used to win the unordered name lookup in resolveTarget, so
// `dm:@name` delivered into the dead agent's DM and the live same-named agent never
// received anything (live 2026-08-16: 实验技能 → deleted twin of claude写作数学证明切片).
// Only non-deleted agents occupy workspace names (agents_name_uniq partial index).
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/resolveTargetDeletedTwin.integration.ts
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { resolveTarget } from "../src/server/core.ts";

const ts = Date.now();
const twinName = `twin_${ts}`;
let serverId = "", ownerId = "";
let twinOldId = "", twinNewId = "", senderId = "";
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function setup() {
  const [u] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });

  const [oldAg] = await db.insert(schema.agents).values({ serverId, name: twinName, displayName: "Twin Old" }).returning();
  twinOldId = oldAg!.id;
  await db.update(schema.agents).set({ deletedAt: new Date() }).where(eq(schema.agents.id, twinOldId)); // soft delete first…
  const [newAg] = await db.insert(schema.agents).values({ serverId, name: twinName, displayName: "Twin New" }).returning(); // …then live twin takes the name
  twinNewId = newAg!.id;
  const [sender] = await db.insert(schema.agents).values({ serverId, name: `sender_${ts}`, displayName: "Sender" }).returning();
  senderId = sender!.id;

  // Legacy zombie DM between sender and the DELETED twin (mirrors prod data shape)
  const [zombie] = await db.insert(schema.channels).values({ serverId, name: `dm:${[senderId, twinOldId].sort().join(":")}`, type: "dm" }).returning();
  await db.insert(schema.channelMembers).values([
    { channelId: zombie!.id, memberType: "agent", memberId: senderId },
    { channelId: zombie!.id, memberType: "agent", memberId: twinOldId },
  ]);
}

async function cleanup() {
  const chans = await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, serverId));
  for (const c of chans) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.channelId, c.id));
  await db.delete(schema.channels).where(eq(schema.channels.serverId, serverId));
  await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
  await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
  await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  await db.delete(schema.users).where(and(eq(schema.users.id, ownerId)));
}

async function main() {
  await setup();

  const tgt = await resolveTarget(serverId, `dm:@${twinName}`, senderId);
  check("dm:@ resolves despite a soft-deleted same-named twin", tgt !== null);

  const members = tgt
    ? await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, tgt.channelId))
    : [];
  const peerIds = members.filter((m) => m.memberId !== senderId).map((m) => m.memberId);
  check("resolved DM peers the LIVE twin, not the deleted one", peerIds.length === 1 && peerIds[0] === twinNewId);
  check("resolved DM is a fresh channel, not the zombie DM with the deleted twin", members.length === 2 && !members.some((m) => m.memberId === twinOldId));
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
