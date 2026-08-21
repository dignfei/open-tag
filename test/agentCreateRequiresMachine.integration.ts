// Integration test: POST /api/agents now requires a valid, same-tenant machineId.
// EXPECTED (goal contract):
//   [1] missing machineId → 400 "machineId required"
//   [2] empty-string machineId → 400 "machineId required"
//   [3] cross-tenant machineId (belongs to a different server) → 404 "machine not found" (existence-hiding,
//       consistent with this repo's other ownership pre-checks — see docs/authorization.md)
//   [4] bogus/nonexistent machineId → 404 "machine not found"
//   [5] valid, same-tenant machineId → 200, agent row persists with that machineId
//   [6] decomposed Unicode handle → 200, trimmed NFC name persists and NFD dm:@ resolves to that exact agent
//   [7] canonically equivalent Unicode handle → 409, no second row
// Requires infra up (npm run infra) + worktree .env. Run: npx tsx test/agentCreateRequiresMachine.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { signUser, hashToken, newKey } from "../src/server/auth.ts";
import { resolveTarget } from "../src/server/core.ts";
import { handleApi } from "../src/server/routes-api/index.ts";

const ts = Date.now();
let failures = 0;
const check = (label: string, cond: boolean, detail = "") => { console.log(`  ${cond ? "✔" : "✗ FAIL"} ${label}${detail ? `  — ${detail}` : ""}`); if (!cond) failures++; };

function makeReq(o: { method: string; path: string; token: string; serverId: string; body?: object }): IncomingMessage {
  const s = o.body ? JSON.stringify(o.body) : "";
  const r = Readable.from(s ? [Buffer.from(s)] : ([] as Buffer[]));
  return Object.assign(r, { method: o.method, url: o.path, headers: { authorization: `Bearer ${o.token}`, "x-server-id": o.serverId, "content-type": "application/json" } }) as unknown as IncomingMessage;
}
function makeRes() {
  let status = 0, body = "";
  const em = new EventEmitter();
  const res = Object.assign(em, { statusCode: 0, headersSent: false, setHeader() {}, writeHead(c: number) { status = c; this.statusCode = c; }, end(d?: string | Buffer) { body = d ? String(d) : ""; em.emit("finish"); } }) as unknown as ServerResponse;
  return { res, getStatus: () => status, getBody: () => body };
}
async function apiCall(o: { method: string; path: string; token: string; serverId: string; body?: object }) {
  const PORT = Number(process.env.PORT ?? 7777);
  const { res, getStatus, getBody } = makeRes();
  const url = new URL(o.path, `http://localhost:${PORT}`);
  try { await handleApi(makeReq(o), res, url, o.method); }
  catch (e: unknown) { res.writeHead(500); res.end(JSON.stringify({ error: "internal", detail: e instanceof Error ? e.message : String(e) })); }
  let parsed: unknown; try { parsed = JSON.parse(getBody()); } catch { parsed = getBody(); }
  return { status: getStatus(), body: parsed as any };
}

let serverId = "", ownerId = "", ownerToken = "";
let otherServerId = "", ownMachineId = "", otherMachineId = "";
const createdAgentIds: string[] = [];

async function insertMachine(sid: string, uid: string, name: string) {
  const key = newKey("sk_machine_");
  const [m] = await db.insert(schema.machines).values({ serverId: sid, userId: uid, name, apiKeyHash: hashToken(key), apiKeyPrefix: key.slice(0, 14), status: "offline", isComputer: false }).returning();
  return m!;
}
async function setup() {
  const [owner] = await db.insert(schema.users).values({ name: `own_acrm_${ts}`, displayName: "Owner", email: `own_acrm_${ts}@t.local` }).returning();
  ownerId = owner!.id; ownerToken = signUser(ownerId);
  const [srv] = await db.insert(schema.servers).values({ name: "T-acrm", slug: `t-acrm-${ts}`, ownerId }).returning();
  serverId = srv!.id;
  await db.insert(schema.serverMembers).values({ serverId, userId: ownerId, role: "owner" });
  const [all] = await db.insert(schema.channels).values({ serverId, name: "all", type: "channel" }).returning();
  void all;
  const om = await insertMachine(serverId, ownerId, `own_${ts}`);
  ownMachineId = om.id;
  // A second server owned by the same user, to prove tenant isolation on machineId.
  const [srv2] = await db.insert(schema.servers).values({ name: "T-acrm2", slug: `t-acrm2-${ts}`, ownerId }).returning();
  otherServerId = srv2!.id;
  await db.insert(schema.serverMembers).values({ serverId: otherServerId, userId: ownerId, role: "owner" });
  const other = await insertMachine(otherServerId, ownerId, `other_${ts}`);
  otherMachineId = other.id;
}
async function cleanup() {
  for (const id of createdAgentIds) await db.delete(schema.channelMembers).where(eq(schema.channelMembers.memberId, id)).catch(() => {});
  for (const sid of [serverId, otherServerId]) {
    await db.delete(schema.agents).where(eq(schema.agents.serverId, sid));
    await db.delete(schema.machines).where(eq(schema.machines.serverId, sid));
    await db.delete(schema.channels).where(eq(schema.channels.serverId, sid));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, sid));
    await db.delete(schema.servers).where(eq(schema.servers.id, sid));
  }
  await db.delete(schema.users).where(eq(schema.users.id, ownerId));
}

async function main() {
  await setup();

  console.log("\n[1] missing machineId → 400");
  const r1 = await apiCall({ method: "POST", path: "/api/agents", token: ownerToken, serverId, body: { name: `a1_${ts}` } });
  console.log(`     → status=${r1.status} body=${JSON.stringify(r1.body)}`);
  check("400 returned", r1.status === 400);
  check("error mentions machineId", /machineId/i.test(String(r1.body?.error)));

  console.log("\n[2] empty-string machineId → 400");
  const r2 = await apiCall({ method: "POST", path: "/api/agents", token: ownerToken, serverId, body: { name: `a2_${ts}`, machineId: "" } });
  console.log(`     → status=${r2.status} body=${JSON.stringify(r2.body)}`);
  check("400 returned", r2.status === 400);

  console.log("\n[3] cross-tenant machineId → 404 (tenant isolation)");
  const r3 = await apiCall({ method: "POST", path: "/api/agents", token: ownerToken, serverId, body: { name: `a3_${ts}`, machineId: otherMachineId } });
  console.log(`     → status=${r3.status} body=${JSON.stringify(r3.body)}`);
  check("404 returned", r3.status === 404);
  check("no agent row leaked into being created", !r3.body?.id);

  console.log("\n[4] bogus machineId → 404");
  const r4 = await apiCall({ method: "POST", path: "/api/agents", token: ownerToken, serverId, body: { name: `a4_${ts}`, machineId: "00000000-0000-0000-0000-000000000000" } });
  console.log(`     → status=${r4.status} body=${JSON.stringify(r4.body)}`);
  check("404 returned", r4.status === 404);

  console.log("\n[5] valid same-tenant machineId → 200, persisted");
  const r5 = await apiCall({ method: "POST", path: "/api/agents", token: ownerToken, serverId, body: { name: `a5_${ts}`, machineId: ownMachineId } });
  console.log(`     → status=${r5.status} body=${JSON.stringify(r5.body)}`);
  check("200 returned", r5.status === 200);
  check("response carries the created agent id", !!r5.body?.id);
  if (r5.body?.id) {
    createdAgentIds.push(r5.body.id);
    const row = (await db.select().from(schema.agents).where(eq(schema.agents.id, r5.body.id)))[0];
    check("DB row has machineId set", row?.machineId === ownMachineId, `machineId=${row?.machineId}`);
  }

  console.log("\n[6] decomposed Unicode handle → 200, trimmed NFC name persists and routes");
  const decomposedName = `E\u0301diteur-${ts}`;
  const normalizedName = `Éditeur-${ts}`;
  const r6 = await apiCall({ method: "POST", path: "/api/agents", token: ownerToken, serverId, body: { name: `  ${decomposedName}  `, machineId: ownMachineId } });
  console.log(`     → status=${r6.status} body=${JSON.stringify(r6.body)}`);
  check("200 returned", r6.status === 200);
  if (r6.body?.id) {
    createdAgentIds.push(r6.body.id);
    const row = (await db.select().from(schema.agents).where(eq(schema.agents.id, r6.body.id)))[0];
    check("Unicode name persists as trimmed NFC", row?.name === normalizedName, `name=${row?.name}`);
    if (r5.body?.id) {
      const target = await resolveTarget(serverId, `dm:@${decomposedName}`, r5.body.id);
      check("NFD dm:@name resolves", !!target);
      const dmMembers = target ? await db.select().from(schema.channelMembers).where(eq(schema.channelMembers.channelId, target.channelId)) : [];
      check("DM peer is the newly created Unicode agent", dmMembers.some((m) => m.memberType === "agent" && m.memberId === r6.body.id));
    }
  }

  console.log("\n[7] canonically equivalent Unicode handle → 409");
  const r7 = await apiCall({ method: "POST", path: "/api/agents", token: ownerToken, serverId, body: { name: normalizedName, machineId: ownMachineId } });
  console.log(`     → status=${r7.status} body=${JSON.stringify(r7.body)}`);
  check("409 returned", r7.status === 409);

  // Confirm none of the rejected attempts [1]-[4] actually created a row (no name collision leakage either).
  const leaked = await db.select().from(schema.agents).where(eq(schema.agents.serverId, serverId));
  check("only the [5]-[6] agents exist for this server", leaked.length === 2, `count=${leaked.length}`);
}

main()
  .catch((e) => { console.error("ERROR", e); failures++; })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup error", e));
    console.log(failures ? `\n✗ ${failures} check(s) failed` : "\n✓ all checks passed");
    await db.$client.end?.();
    process.exit(failures ? 1 : 0);
  });
