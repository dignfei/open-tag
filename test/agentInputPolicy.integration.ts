// Integration coverage for human management of an agent's input-source settings.
// Requires PostgreSQL on the worktree DATABASE_URL after `npm run db:push`.
// Run: JWT_SECRET=x DAEMON_BOOTSTRAP_KEY=y npx tsx test/agentInputPolicy.integration.ts
import "../src/env.js";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { eq, inArray } from "drizzle-orm";
import { db, schema, sql } from "../src/db/index.ts";
import { signUser } from "../src/server/auth.ts";
import { handleApi } from "../src/server/routes-api/index.ts";

const suffix = Date.now().toString(36);
let failures = 0;
const check = (label: string, condition: boolean) => {
  console.log(`  ${condition ? "✔" : "✗ FAIL"} ${label}`);
  if (!condition) failures++;
};

function request(options: { method: string; path: string; token: string; serverId: string; body?: object }): IncomingMessage {
  const encoded = options.body === undefined ? "" : JSON.stringify(options.body);
  const stream = Readable.from(encoded ? [Buffer.from(encoded)] : ([] as Buffer[]));
  return Object.assign(stream, {
    method: options.method,
    url: options.path,
    headers: {
      authorization: `Bearer ${options.token}`,
      "x-server-id": options.serverId,
      "content-type": "application/json",
    },
  }) as unknown as IncomingMessage;
}

function response(): { res: ServerResponse; status: () => number; body: () => any } {
  let status = 0;
  let body = "";
  const emitter = new EventEmitter();
  const res = Object.assign(emitter, {
    statusCode: 0,
    headersSent: false,
    setHeader() {},
    writeHead(code: number) { status = code; this.statusCode = code; },
    end(value?: string | Buffer) { body = value ? String(value) : ""; emitter.emit("finish"); },
  }) as unknown as ServerResponse;
  return { res, status: () => status, body: () => body ? JSON.parse(body) : null };
}

async function api(options: { method: string; path: string; token: string; serverId: string; body?: object }) {
  const output = response();
  await handleApi(request(options), output.res, new URL(options.path, "http://localhost"), options.method);
  return { status: output.status(), body: output.body() };
}

async function main() {
  const users = await db.insert(schema.users).values([
    { name: `policy-owner-${suffix}`, displayName: "Owner", email: `policy-owner-${suffix}@test.invalid` },
    { name: `policy-member-${suffix}`, displayName: "Member", email: `policy-member-${suffix}@test.invalid` },
  ]).returning();
  const owner = users[0]!;
  const member = users[1]!;
  const servers = await db.insert(schema.servers).values([
    { name: `Policy ${suffix}`, slug: `policy-${suffix}`, ownerId: owner.id },
    { name: `Foreign ${suffix}`, slug: `foreign-policy-${suffix}`, ownerId: owner.id },
  ]).returning();
  const server = servers[0]!;
  const foreignServer = servers[1]!;
  await db.insert(schema.serverMembers).values([
    { serverId: server.id, userId: owner.id, role: "owner" },
    { serverId: server.id, userId: member.id, role: "member" },
    { serverId: foreignServer.id, userId: owner.id, role: "owner" },
  ]);
  const localAgents = await db.insert(schema.agents).values([
    { serverId: server.id, name: `target-${suffix}`, displayName: "Target" },
    { serverId: server.id, name: `peer-${suffix}`, displayName: "Peer" },
    { serverId: server.id, name: `showcase-${suffix}`, displayName: "Showcase", creatorType: "system" },
    { serverId: server.id, name: `deleted-${suffix}`, displayName: "Deleted", deletedAt: new Date() },
  ]).returning();
  const target = localAgents[0]!;
  const peer = localAgents[1]!;
  const showcase = localAgents[2]!;
  const deleted = localAgents[3]!;
  const [foreign] = await db.insert(schema.agents).values({
    serverId: foreignServer.id, name: `foreign-${suffix}`, displayName: "Foreign",
  }).returning();
  const ownerToken = signUser(owner.id);
  const memberToken = signUser(member.id);
  const endpoint = `/api/agents/${target.id}`;

  try {
    const initial = await api({ method: "GET", path: endpoint, token: ownerToken, serverId: server.id });
    check("manager sees default input settings", initial.status === 200
      && initial.body.incomingMode === "open" && initial.body.commandWhitelist.length === 0);

    const hidden = await api({ method: "GET", path: endpoint, token: memberToken, serverId: server.id });
    check("ordinary member cannot inspect input settings", hidden.status === 200
      && !("incomingMode" in hidden.body) && !("commandWhitelist" in hidden.body));

    const forbidden = await api({
      method: "PATCH", path: endpoint, token: memberToken, serverId: server.id,
      body: { incomingMode: "sealed" },
    });
    check("ordinary member cannot change input settings", forbidden.status === 403);

    const invalidBodies = [
      { incomingMode: "sanitized" },
      { commandWhitelist: "all" },
      { commandWhitelist: ["not-an-id"] },
      { commandWhitelist: [peer.id, peer.id.toUpperCase()] },
      { commandWhitelist: [target.id] },
      { commandWhitelist: [showcase.id] },
      { commandWhitelist: [deleted.id] },
      { commandWhitelist: [foreign!.id] },
    ];
    for (const body of invalidBodies) {
      const result = await api({ method: "PATCH", path: endpoint, token: ownerToken, serverId: server.id, body });
      check(`invalid settings fail with 400 (${JSON.stringify(body)})`, result.status === 400);
    }

    const saved = await api({
      method: "PATCH", path: endpoint, token: ownerToken, serverId: server.id,
      body: { incomingMode: "sealed", commandWhitelist: [peer.id.toUpperCase()] },
    });
    check("manager saves a canonical same-workspace whitelist", saved.status === 200
      && saved.body.incomingMode === "sealed" && saved.body.commandWhitelist[0] === peer.id);
    const reloaded = await api({ method: "GET", path: endpoint, token: ownerToken, serverId: server.id });
    check("saved settings survive reload", reloaded.body.incomingMode === "sealed"
      && reloaded.body.commandWhitelist.length === 1 && reloaded.body.commandWhitelist[0] === peer.id);

    const stored = (await db.select().from(schema.agents).where(eq(schema.agents.id, target.id)))[0]!;
    check("rejected updates do not replace the saved policy", stored.incomingMode === "sealed"
      && stored.commandWhitelist.length === 1 && stored.commandWhitelist[0] === peer.id);
  } finally {
    await db.delete(schema.agents).where(inArray(schema.agents.serverId, [server.id, foreignServer.id]));
    await db.delete(schema.serverMembers).where(inArray(schema.serverMembers.serverId, [server.id, foreignServer.id]));
    await db.delete(schema.servers).where(inArray(schema.servers.id, [server.id, foreignServer.id]));
    await db.delete(schema.users).where(inArray(schema.users.id, users.map((user) => user.id)));
    await sql.end();
  }
}

main().then(() => {
  console.log(`\n${failures === 0 ? "ALL PASS ✅" : `${failures} CHECK(S) FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}).catch(async (error) => {
  console.error("ERROR:", error);
  try { await sql.end(); } catch { /* ignore cleanup failure */ }
  process.exit(1);
});
