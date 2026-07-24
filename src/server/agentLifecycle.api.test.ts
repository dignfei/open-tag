import "../env.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import WebSocket from "ws";
import { eq, inArray } from "drizzle-orm";
import { AGENT_CONTROL_ACK_CAPABILITY } from "../daemonProtocol.js";
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

async function waitFor<T>(read: () => T | undefined, evidence: () => string): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out: ${evidence()}`);
}

test("real API: reset/restart waits for daemon completion ACK and reset errors fail loud", async () => {
  const suffix = randomUUID().slice(0, 8);
  const machineKey = `sk_machine_control_${suffix}`;
  const [user] = await db.insert(schema.users).values({ name: `owner-${suffix}`, displayName: "Owner", email: `owner-${suffix}@api.test.invalid` }).returning();
  const [server] = await db.insert(schema.servers).values({ name: `control-${suffix}`, slug: `control-${suffix}`, ownerId: user!.id }).returning();
  await db.insert(schema.serverMembers).values({ serverId: server!.id, userId: user!.id, role: "owner" });
  const [machine] = await db.insert(schema.machines).values({
    serverId: server!.id, userId: user!.id, name: `machine-${suffix}`,
    apiKeyHash: hashToken(machineKey), apiKeyPrefix: machineKey.slice(0, 14), runtimes: ["codex"], status: "offline",
  }).returning();
  const [agent] = await db.insert(schema.agents).values({
    serverId: server!.id, machineId: machine!.id, name: `agent-${suffix}`, displayName: "Agent", runtime: "codex", status: "active",
  }).returning();

  try {
    const live = await startServer();
    const frames: any[] = [];
    daemonSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${live.base.replace("http", "ws")}/daemon/connect?key=${encodeURIComponent(machineKey)}`);
      const timer = setTimeout(() => reject(new Error(`daemon ready timeout: ${live.logs()}`)), 3_000);
      socket.on("open", () => socket.send(JSON.stringify({
        type: "ready", machineId: machine!.id, hostname: machine!.name, os: "test", runtimes: ["codex"],
        capabilities: [AGENT_CONTROL_ACK_CAPABILITY], runningAgents: [agent!.id], daemonVersion: "test",
      })));
      socket.on("message", (data) => {
        const frame = JSON.parse(String(data));
        frames.push(frame);
        if (frame.type === "ready:ack") { clearTimeout(timer); resolve(socket); }
        if (frame.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      });
      socket.on("error", reject);
    });

    const headers = { authorization: `Bearer ${signUser(user!.id)}`, "x-server-id": server!.id, "content-type": "application/json" };
    let responseSettled = false;
    const restartResponse = fetch(`${live.base}/api/agents/${agent!.id}/reset`, {
      method: "POST", headers, body: JSON.stringify({ wipeWorkspace: true, restart: true }),
    }).then(async (response) => { responseSettled = true; return { status: response.status, body: await response.json() as any }; });

    const resetFrame = await waitFor(() => frames.find((frame) => frame.type === "agent:reset"), () => JSON.stringify({ frames, logs: live.logs() }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(frames.some((frame) => frame.type === "agent:start"), false, "restart must not start before reset ACK");
    assert.equal(responseSettled, false, "HTTP must remain pending while reset is unfinished");

    daemonSocket!.send(JSON.stringify({ type: "rpc:ack", requestId: resetFrame.requestId }));
    const startFrame = await waitFor(() => frames.find((frame) => frame.type === "agent:start"), () => JSON.stringify({ frames, logs: live.logs() }));
    assert.equal(responseSettled, false, "HTTP must remain pending while start is unfinished");
    daemonSocket!.send(JSON.stringify({ type: "rpc:ack", requestId: startFrame.requestId }));
    const restarted = await restartResponse;
    assert.equal(restarted.status, 200, JSON.stringify(restarted.body));

    const startsBeforeFailure = frames.filter((frame) => frame.type === "agent:start").length;
    const resetsBeforeFailure = frames.filter((frame) => frame.type === "agent:reset").length;
    const failedResponse = fetch(`${live.base}/api/agents/${agent!.id}/reset`, {
      method: "POST", headers, body: JSON.stringify({ clearMemory: true, restart: true }),
    });
    const failedReset = await waitFor(
      () => {
        const resets = frames.filter((frame) => frame.type === "agent:reset");
        return resets.length > resetsBeforeFailure ? resets.at(-1) : undefined;
      },
      () => JSON.stringify({ frames, logs: live.logs() }),
    );
    daemonSocket!.send(JSON.stringify({ type: "rpc:nack", requestId: failedReset.requestId, error: "memory reset failed" }));
    const failed = await failedResponse;
    assert.equal(failed.status, 503);
    assert.match(JSON.stringify(await failed.json()), /memory reset failed/);
    assert.equal(frames.filter((frame) => frame.type === "agent:start").length, startsBeforeFailure, "failed reset must not start the agent");
  } finally {
    daemonSocket?.close(); daemonSocket = null;
    if (serverProcess?.pid) serverProcess.kill("SIGTERM"); serverProcess = null;
    await db.delete(schema.agents).where(eq(schema.agents.serverId, server!.id));
    await db.delete(schema.machines).where(eq(schema.machines.serverId, server!.id));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, server!.id));
    await db.delete(schema.servers).where(eq(schema.servers.id, server!.id));
    await db.delete(schema.users).where(inArray(schema.users.id, [user!.id]));
  }
});
