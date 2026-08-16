// Real DB integration: resolveTarget must NOT resolve soft-deleted channels by #name.
// Agents remember #names from their own history; with the deletedAt filter missing they kept
// posting into an invisible zombie channel ~50min after soft-delete (live 2026-08-16 #实验频道).
// Deleted targets must return null so /agent-api/message/send surfaces TARGET_FAILED and the
// agent adapts, instead of burying conversation where the UI never shows it.
// Requires infra up: `npm run infra` (pg :5433, redis :6380). Run: npx tsx test/resolveTargetDeletedChannel.integration.ts
import { and, eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { resolveTarget } from "../src/server/core.ts";

const ts = Date.now();
const delName = `delch_${ts}`;
const liveName = `livech_${ts}`;
let serverId = "", ownerId = "", senderId = "";
let failures = 0;
const check = (label: string, cond: boolean) => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}`); if (!cond) failures++; };

async function setup() {
  const [u] = await db.insert(schema.users).values({ name: `owner_${ts}`, displayName: "Owner", email: `o_${ts}@t.local` }).returning();
  ownerId = u!.id;
  const [srv] = await db.insert(schema.servers).values({ name: "T", slug: `t-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  const [sender] = await db.insert(schema.agents).values({ serverId, name: `sender_${ts}`, displayName: "Sender" }).returning();
  senderId = sender!.id;

  const [del] = await db.insert(schema.channels).values({ serverId, name: delName, type: "channel" }).returning();
  await db.insert(schema.channelMembers).values({ channelId: del!.id, memberType: "agent", memberId: senderId });
  await db.update(schema.channels).set({ deletedAt: new Date() }).where(eq(schema.channels.id, del!.id));

  const [live] = await db.insert(schema.channels).values({ serverId, name: liveName, type: "channel" }).returning();
  await db.insert(schema.channelMembers).values({ channelId: live!.id, memberType: "agent", memberId: senderId });
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

  const gone = await resolveTarget(serverId, `#${delName}`, senderId);
  check("deleted channel is not addressable by #name", gone === null);

  const goneThread = await resolveTarget(serverId, `#${delName}:deadbeef`, senderId);
  check("deleted channel with thread suffix is not addressable", goneThread === null);

  const live = await resolveTarget(serverId, `#${liveName}`, senderId);
  check("live channel still resolves", live !== null);
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
