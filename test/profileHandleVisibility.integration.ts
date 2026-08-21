// Integration coverage for workspace-scoped agent profile handle lookup.
// Requires dev infra: npm run infra (PostgreSQL :5433, Redis :6380).
// Run: npx tsx test/profileHandleVisibility.integration.ts
import "../src/env.ts";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db, schema } from "../src/db/index.ts";
import { hashToken } from "../src/server/auth.ts";
import { handleAgentApi } from "../src/server/routes-agent.ts";

const suffix = `${Date.now()}_${process.pid}`;
const senderToken = `sk_agent_test_profile_${suffix}`;
const twinName = `profile_twin_${suffix}`;
const localHumanName = `profile_local_${suffix}`;
const foreignHumanName = `profile_foreign_${suffix}`;
let primaryServerId = "";
let foreignServerId = "";
let primaryOwnerId = "";
let foreignOwnerId = "";
let localHumanId = "";
let senderId = "";
let failures = 0;

const check = (label: string, condition: boolean) => {
  console.log(`  ${condition ? "✔" : "✗ FAIL"} ${label}`);
  if (!condition) failures++;
};

function request(path: string): IncomingMessage {
  return Object.assign(Readable.from([] as Buffer[]), {
    method: "GET",
    url: path,
    headers: { authorization: `Bearer ${senderToken}`, "x-agent-id": senderId },
  }) as unknown as IncomingMessage;
}

function response() {
  let status = 0;
  let raw = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    writeHead(code: number) { status = code; this.statusCode = code; },
    end(data?: string | Buffer) { raw = data ? String(data) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  return { res, status: () => status, body: () => raw ? JSON.parse(raw) : {} };
}

async function profile(handle: string) {
  const path = `/agent-api/profile/show?handle=${encodeURIComponent(handle)}`;
  const out = response();
  await handleAgentApi(request(path), out.res, new URL(path, "http://localhost"), "GET");
  return { status: out.status(), body: out.body() };
}

async function setup() {
  const [primaryOwner] = await db.insert(schema.users).values({
    name: `profile_owner_${suffix}`,
    displayName: "Primary Owner",
    email: `profile_owner_${suffix}@test.local`,
  }).returning();
  primaryOwnerId = primaryOwner!.id;
  const [primaryServer] = await db.insert(schema.servers).values({ name: "Profile primary", slug: `profile-primary-${suffix}`, ownerId: primaryOwnerId }).returning();
  primaryServerId = primaryServer!.id;
  await db.insert(schema.serverMembers).values({ serverId: primaryServerId, userId: primaryOwnerId, role: "owner" });

  const [foreignOwner] = await db.insert(schema.users).values({
    name: foreignHumanName,
    displayName: "Foreign Human",
    email: `profile_foreign_${suffix}@test.local`,
  }).returning();
  foreignOwnerId = foreignOwner!.id;
  const [foreignServer] = await db.insert(schema.servers).values({ name: "Profile foreign", slug: `profile-foreign-${suffix}`, ownerId: foreignOwnerId }).returning();
  foreignServerId = foreignServer!.id;
  await db.insert(schema.serverMembers).values({ serverId: foreignServerId, userId: foreignOwnerId, role: "owner" });

  const [localHuman] = await db.insert(schema.users).values({
    name: localHumanName,
    displayName: "Local Human",
    email: `profile_local_${suffix}@test.local`,
  }).returning();
  localHumanId = localHuman!.id;
  await db.insert(schema.serverMembers).values({ serverId: primaryServerId, userId: localHumanId, role: "member" });

  const [sender] = await db.insert(schema.agents).values({
    serverId: primaryServerId,
    name: `profile_sender_${suffix}`,
    displayName: "Sender",
    agentTokenHash: hashToken(senderToken),
  }).returning();
  senderId = sender!.id;

  const [deletedForeignShadow] = await db.insert(schema.agents).values({
    serverId: primaryServerId,
    name: foreignHumanName,
    displayName: "Deleted Foreign Shadow",
  }).returning();
  await db.update(schema.agents).set({ deletedAt: new Date() }).where(eq(schema.agents.id, deletedForeignShadow!.id));

  const [deletedTwin] = await db.insert(schema.agents).values({ serverId: primaryServerId, name: twinName, displayName: "Deleted Twin" }).returning();
  await db.update(schema.agents).set({ deletedAt: new Date() }).where(eq(schema.agents.id, deletedTwin!.id));
  await db.insert(schema.agents).values({ serverId: primaryServerId, name: twinName, displayName: "Live Twin" });
  const [sameNamedHuman] = await db.insert(schema.users).values({
    name: twinName,
    displayName: "Same-named Human",
    email: `profile_twin_${suffix}@test.local`,
  }).returning();
  await db.insert(schema.serverMembers).values({ serverId: primaryServerId, userId: sameNamedHuman!.id, role: "member" });
}

async function cleanup() {
  for (const serverId of [primaryServerId, foreignServerId]) {
    if (!serverId) continue;
    await db.delete(schema.agents).where(eq(schema.agents.serverId, serverId));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, serverId));
    await db.delete(schema.servers).where(eq(schema.servers.id, serverId));
  }
  for (const name of [twinName, localHumanName, foreignHumanName, `profile_owner_${suffix}`]) {
    await db.delete(schema.users).where(eq(schema.users.name, name));
  }
}

async function main() {
  await setup();

  const foreign = await profile(foreignHumanName);
  check("a foreign human is not visible by handle", foreign.status === 404);

  const local = await profile(localHumanName);
  check("a workspace human is visible by handle", local.status === 200 && local.body.type === "user" && local.body.displayName === "Local Human");

  const twin = await profile(twinName);
  check("a live agent wins over deleted and human namesakes", twin.status === 200 && twin.body.type === "agent" && twin.body.displayName === "Live Twin");
}

main()
  .then(async () => { await cleanup(); process.exit(failures === 0 ? 0 : 1); })
  .catch(async (error) => {
    console.error(error);
    try { await cleanup(); } catch { /* best-effort cleanup */ }
    process.exit(1);
  });
