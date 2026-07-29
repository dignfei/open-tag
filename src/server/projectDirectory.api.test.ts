import "../env.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import WebSocket from "ws";
import { and, eq, inArray } from "drizzle-orm";
import { AGENT_CONTROL_ACK_CAPABILITY, PROJECT_BROWSER_CAPABILITY, PROJECT_DIRECTORY_CAPABILITY } from "../daemonProtocol.js";
import { db, schema, sql } from "../db/index.js";
import { hashToken, signUser } from "./auth.js";

let serverProcess: ChildProcess | null = null;
let daemonSocket: WebSocket | null = null;
after(async () => {
  daemonSocket?.close();
  if (serverProcess?.pid) serverProcess.kill("SIGTERM");
  await sql.end();
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => error ? reject(error) : resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

async function startServer(): Promise<{ base: string; logs: () => string }> {
  const port = await freePort();
  const chunks: string[] = [];
  serverProcess = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout?.on("data", (chunk) => chunks.push(String(chunk)));
  serverProcess.stderr?.on("data", (chunk) => chunks.push(String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (serverProcess.exitCode != null) throw new Error(`server exited ${serverProcess.exitCode}: ${chunks.join("")}`);
    try { if ((await fetch(`${base}/health`)).ok) return { base, logs: () => chunks.join("") }; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${chunks.join("")}`);
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, evidence: () => string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${evidence()}`);
}

test("real API: project binding resolves on the target daemon, starts canonically, and stays private", async () => {
  const suffix = randomUUID().slice(0, 8);
  const machineKey = `sk_machine_project_${suffix}`;
  const [owner] = await db.insert(schema.users).values({ name: `owner-${suffix}`, displayName: "Owner", email: `owner-${suffix}@api.test.invalid` }).returning();
  const [member] = await db.insert(schema.users).values({ name: `member-${suffix}`, displayName: "Member", email: `member-${suffix}@api.test.invalid` }).returning();
  const [server] = await db.insert(schema.servers).values({ name: `project-${suffix}`, slug: `project-${suffix}`, ownerId: owner!.id }).returning();
  await db.insert(schema.serverMembers).values([
    { serverId: server!.id, userId: owner!.id, role: "owner" },
    { serverId: server!.id, userId: member!.id, role: "member" },
  ]);
  const [machine] = await db.insert(schema.machines).values({
    serverId: server!.id, userId: owner!.id, name: `machine-${suffix}`,
    apiKeyHash: hashToken(machineKey), apiKeyPrefix: machineKey.slice(0, 14), runtimes: ["codex"], status: "offline",
  }).returning();
  const [foreignServer] = await db.insert(schema.servers).values({ name: `foreign-${suffix}`, slug: `foreign-${suffix}`, ownerId: owner!.id }).returning();
  await db.insert(schema.serverMembers).values({ serverId: foreignServer!.id, userId: owner!.id, role: "owner" });
  const [foreignMachine] = await db.insert(schema.machines).values({
    serverId: foreignServer!.id, userId: owner!.id, name: `foreign-machine-${suffix}`,
    apiKeyHash: hashToken(`sk_machine_foreign_${suffix}`), apiKeyPrefix: "sk_machine_for", status: "offline",
  }).returning();

  try {
    const live = await startServer();
    const frames: any[] = [];
    let stopMode: "ack" | "nack" = "nack";
    daemonSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${live.base.replace("http", "ws")}/daemon/connect?key=${encodeURIComponent(machineKey)}`);
      const timer = setTimeout(() => reject(new Error(`daemon ready timeout: ${live.logs()}`)), 3_000);
      socket.on("open", () => socket.send(JSON.stringify({
        type: "ready", machineId: machine!.id, hostname: machine!.name, os: "test", runtimes: ["codex"],
        capabilities: [AGENT_CONTROL_ACK_CAPABILITY, PROJECT_DIRECTORY_CAPABILITY, PROJECT_BROWSER_CAPABILITY], runningAgents: [], daemonVersion: "test",
      })));
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data));
        frames.push(frame);
        if (frame.type === "ready:ack") { clearTimeout(timer); resolve(socket); }
        if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
        if (frame.type === "project:resolve") {
          if (frame.path === "/invalid") socket.send(JSON.stringify({ type: "project:resolved", requestId: frame.requestId, error: "project directory does not exist" }));
          else socket.send(JSON.stringify({ type: "project:resolved", requestId: frame.requestId, projectPath: `/canonical${frame.path}` }));
        }
        if (frame.type === "project:browse") {
          if (frame.path === "/no-roots") socket.send(JSON.stringify({ type: "project:directories", requestId: frame.requestId, error: "raw daemon configuration detail", code: "project_roots_not_configured" }));
          else if (frame.path === "/oversized") socket.send(JSON.stringify({ type: "project:directories", requestId: frame.requestId, mode: "list", path: frame.path, directories: Array.from({ length: 201 }, (_, i) => ({ name: `d${i}`, path: `/d${i}` })), nextCursor: null, truncated: false }));
          else if (frame.path === "/malformed") socket.send(JSON.stringify({ type: "project:directories", requestId: frame.requestId, mode: "list", path: frame.path, directories: [{ name: 123, path: "/bad" }], nextCursor: null, truncated: false }));
          else if (frame.discover) socket.send(JSON.stringify({ type: "project:directories", requestId: frame.requestId, mode: "discover", path: frame.path ?? null, projects: [{ name: "project-a", path: "/shared/project-a", secret: "drop-me" }], nextCursor: null, truncated: false, leaked: true }));
          else if (frame.path) socket.send(JSON.stringify({ type: "project:directories", requestId: frame.requestId, mode: "list", path: frame.path, directories: [{ name: "child", path: `${frame.path}/child`, secret: "drop-me" }], nextCursor: null, truncated: false, leaked: true }));
          else socket.send(JSON.stringify({ type: "project:directories", requestId: frame.requestId, mode: "roots", roots: [{ name: "shared", path: "/shared", secret: "drop-me" }], nextCursor: null, truncated: false, leaked: true }));
        }
        if (frame.type === "agent:start") socket.send(JSON.stringify({ type: "rpc:ack", requestId: frame.requestId }));
        if (frame.type === "agent:stop") socket.send(JSON.stringify(stopMode === "ack"
          ? { type: "rpc:ack", requestId: frame.requestId }
          : { type: "rpc:nack", requestId: frame.requestId, error: "stop not confirmed" }));
      });
      socket.on("error", reject);
    });

    const ownerHeaders = { authorization: `Bearer ${signUser(owner!.id)}`, "x-server-id": server!.id, "content-type": "application/json" };
    const memberHeaders = { authorization: `Bearer ${signUser(member!.id)}`, "x-server-id": server!.id };

    const rootsResponse = await fetch(`${live.base}/api/servers/${server!.id}/machines/${machine!.id}/project-directories`, { headers: ownerHeaders });
    assert.equal(rootsResponse.status, 200);
    assert.deepEqual(await rootsResponse.json(), { mode: "roots", roots: [{ name: "shared", path: "/shared" }], nextCursor: null, truncated: false });
    const directoryEndpoint = `${live.base}/api/servers/${server!.id}/machines/${machine!.id}/project-directories`;
    const directoryQueryEndpoint = `${directoryEndpoint}/query`;
    const listResponse = await fetch(directoryQueryEndpoint, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ path: "/shared" }) });
    assert.equal(listResponse.status, 200);
    assert.deepEqual(await listResponse.json(), { mode: "list", path: "/shared", directories: [{ name: "child", path: "/shared/child" }], nextCursor: null, truncated: false });
    const discoverResponse = await fetch(directoryQueryEndpoint, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ discover: true }) });
    assert.equal(discoverResponse.status, 200);
    assert.deepEqual(await discoverResponse.json(), { mode: "discover", path: null, projects: [{ name: "project-a", path: "/shared/project-a" }], nextCursor: null, truncated: false });

    assert.equal((await fetch(`${live.base}/api/servers/${server!.id}/machines/${machine!.id}/project-directories`, { headers: memberHeaders })).status, 403);
    assert.equal((await fetch(`${live.base}/api/servers/${server!.id}/machines/not-a-uuid/project-directories`, { headers: ownerHeaders })).status, 404);
    assert.equal((await fetch(`${live.base}/api/servers/${server!.id}/machines/${foreignMachine!.id}/project-directories`, { headers: ownerHeaders })).status, 404);
    assert.equal((await fetch(`${directoryEndpoint}?path=${encodeURIComponent("/must-not-enter-access-logs")}`, { headers: ownerHeaders })).status, 400);
    assert.equal((await fetch(directoryQueryEndpoint, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ discover: "yes" }) })).status, 400);
    assert.equal((await fetch(directoryQueryEndpoint, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ cursor: 1 }) })).status, 400);
    assert.equal((await fetch(directoryQueryEndpoint, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ path: "/shared", padding: "x".repeat(9_000) }) })).status, 400);

    const noRootsResponse = await fetch(directoryQueryEndpoint, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ path: "/no-roots" }) });
    assert.equal(noRootsResponse.status, 409);
    assert.deepEqual(await noRootsResponse.json(), { error: "No project roots are shared by this daemon.", code: "project_roots_not_configured" });
    for (const badPath of ["/oversized", "/malformed"]) {
      const invalidResponse = await fetch(directoryQueryEndpoint, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ path: badPath }) });
      assert.equal(invalidResponse.status, 503);
      assert.deepEqual(await invalidResponse.json(), { error: "Project browser returned an invalid response.", code: "project_browser_unavailable" });
    }

    const [offlineMachine] = await db.insert(schema.machines).values({ serverId: server!.id, userId: owner!.id, name: `offline-${suffix}`, apiKeyHash: hashToken(`sk_machine_offline_${suffix}`), apiKeyPrefix: "sk_machine_off", status: "offline" }).returning();
    const offlineResponse = await fetch(`${live.base}/api/servers/${server!.id}/machines/${offlineMachine!.id}/project-directories`, { headers: ownerHeaders });
    assert.equal(offlineResponse.status, 503);
    assert.deepEqual(await offlineResponse.json(), { error: "Project browser is unavailable.", code: "project_browser_unavailable" });

    const invalidName = `invalid-${suffix}`;
    const invalid = await fetch(`${live.base}/api/agents`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ machineId: machine!.id, name: invalidName, runtime: "codex", projectPath: "/invalid" }) });
    assert.equal(invalid.status, 400);
    assert.equal((await db.select().from(schema.agents).where(and(eq(schema.agents.serverId, server!.id), eq(schema.agents.name, invalidName)))).length, 0);

    const agentName = `bound-${suffix}`;
    const createdResponse = await fetch(`${live.base}/api/agents`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ machineId: machine!.id, name: agentName, runtime: "codex", projectPath: "/project-a" }) });
    const created = await createdResponse.json() as any;
    assert.equal(createdResponse.status, 200, JSON.stringify(created));
    assert.equal(created.started, true);
    const start = await waitFor(() => frames.find((frame) => frame.type === "agent:start" && frame.agentId === created.id), () => JSON.stringify({ frames, logs: live.logs() }));
    assert.equal(start.config.projectPath, "/canonical/project-a");
    const [stored] = await db.select().from(schema.agents).where(eq(schema.agents.id, created.id));
    assert.equal(stored!.projectPath, "/canonical/project-a");
    assert.equal(stored!.status, "starting");

    const racingPatch = await fetch(`${live.base}/api/agents/${created.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ projectPath: "/must-not-win" }) });
    assert.equal(racingPatch.status, 409, "a start claim must prevent the persisted path from diverging from the runtime cwd");

    daemonSocket.send(JSON.stringify({ type: "agent:status", agentId: created.id, status: "inactive" }));
    await waitFor(async () => {
      const [row] = await db.select({ status: schema.agents.status }).from(schema.agents).where(eq(schema.agents.id, created.id));
      return row?.status === "inactive" ? row.status : undefined;
    }, () => live.logs());
    await db.update(schema.agents).set({ sessionId: "old-session" }).where(eq(schema.agents.id, created.id));
    const patchedResponse = await fetch(`${live.base}/api/agents/${created.id}`, { method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ projectPath: "/project-b" }) });
    const patched = await patchedResponse.json() as any;
    assert.equal(patchedResponse.status, 200, JSON.stringify(patched));
    assert.equal(patched.projectPath, "/canonical/project-b");
    assert.equal(patched.sessionCleared, true);
    const [changed] = await db.select().from(schema.agents).where(eq(schema.agents.id, created.id));
    assert.equal(changed!.sessionId, null);

    const ownerDetail = await (await fetch(`${live.base}/api/agents/${created.id}`, { headers: ownerHeaders })).json() as any;
    assert.equal(ownerDetail.projectPath, "/canonical/project-b");
    assert.equal("envVars" in ownerDetail, false);
    const memberDetail = await (await fetch(`${live.base}/api/agents/${created.id}`, { headers: memberHeaders })).json() as any;
    assert.equal(memberDetail.projectPath, null);
    assert.equal(memberDetail.projectBound, true);

    const memberSkills = await fetch(`${live.base}/api/agents/${created.id}/skills`, { headers: memberHeaders });
    assert.equal(memberSkills.status, 403, "project-local skill metadata is private to agent managers");

    const unsafeDelete = await fetch(`${live.base}/api/agents/${created.id}`, { method: "DELETE", headers: ownerHeaders });
    assert.equal(unsafeDelete.status, 503, "a bound agent remains manageable until stop is confirmed");
    assert.equal((await db.select().from(schema.agents).where(eq(schema.agents.id, created.id)))[0]!.deletedAt, null);
    stopMode = "ack";
    const safeDelete = await fetch(`${live.base}/api/agents/${created.id}`, { method: "DELETE", headers: ownerHeaders });
    assert.equal(safeDelete.status, 200);
    assert.ok((await db.select().from(schema.agents).where(eq(schema.agents.id, created.id)))[0]!.deletedAt instanceof Date);
  } finally {
    daemonSocket?.close(); daemonSocket = null;
    if (serverProcess?.pid) serverProcess.kill("SIGTERM"); serverProcess = null;
    await db.delete(schema.agents).where(eq(schema.agents.serverId, server!.id));
    await db.delete(schema.machines).where(eq(schema.machines.serverId, server!.id));
    await db.delete(schema.machines).where(eq(schema.machines.serverId, foreignServer!.id));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, server!.id));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, foreignServer!.id));
    await db.delete(schema.servers).where(eq(schema.servers.id, server!.id));
    await db.delete(schema.servers).where(eq(schema.servers.id, foreignServer!.id));
    await db.delete(schema.users).where(inArray(schema.users.id, [owner!.id, member!.id]));
  }
});
