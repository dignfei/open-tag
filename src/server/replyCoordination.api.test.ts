import "../env.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import WebSocket from "ws";
import { and, eq, inArray } from "drizzle-orm";
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
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      server.close((e) => e ? reject(e) : resolve(port));
    });
  });
}

async function startServer(): Promise<{ base: string; logs: () => string }> {
  const port = await freePort();
  const chunks: string[] = [];
  serverProcess = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stdout?.on("data", (c) => chunks.push(String(c)));
  serverProcess.stderr?.on("data", (c) => chunks.push(String(c)));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (serverProcess.exitCode != null) throw new Error(`server exited ${serverProcess.exitCode}: ${chunks.join("")}`);
    try { if ((await fetch(`${base}/health`)).ok) return { base, logs: () => chunks.join("") }; } catch { /* retry */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${chunks.join("")}`);
}

async function api(base: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(base + path, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, body: await response.json() as any };
}

test("real API: all agents observe a mistaken mention, only delegated agent publishes", async () => {
  const suffix = randomUUID().slice(0, 8);
  const tokens = ["codex", "codex2", "worker"].map((name) => ({ name: `${name}-${suffix}`, token: `sk_agent_test_${name}_${suffix}` }));
  const machineKey = `sk_machine_test_${suffix}`;
  const [user] = await db.insert(schema.users).values({ name: `human-${suffix}`, displayName: "Human", email: `${suffix}@api.test.invalid` }).returning();
  const [server] = await db.insert(schema.servers).values({ name: `api-${suffix}`, slug: `api-${suffix}`, ownerId: user!.id }).returning();
  await db.insert(schema.serverMembers).values({ serverId: server!.id, userId: user!.id, role: "owner" });
  const [machine] = await db.insert(schema.machines).values({
    serverId: server!.id, userId: user!.id, name: `machine-${suffix}`,
    apiKeyHash: hashToken(machineKey), apiKeyPrefix: machineKey.slice(0, 14), runtimes: ["codex"], status: "offline",
  }).returning();
  const [channel] = await db.insert(schema.channels).values({ serverId: server!.id, name: `all-${suffix}`, type: "channel" }).returning();
  const agents = await db.insert(schema.agents).values(tokens.map((t) => ({
    serverId: server!.id, machineId: machine!.id, name: t.name, displayName: t.name, agentTokenHash: hashToken(t.token), runtime: "codex", status: "active",
  }))).returning();
  await db.insert(schema.channelMembers).values([
    { channelId: channel!.id, memberType: "user", memberId: user!.id },
    ...agents.map((a) => ({ channelId: channel!.id, memberType: "agent", memberId: a.id })),
  ]);
  const cleanup = async () => {
    const channelIds = (await db.select({ id: schema.channels.id }).from(schema.channels).where(eq(schema.channels.serverId, server!.id))).map((c) => c.id);
    const ids = (await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, server!.id))).map((m) => m.id);
    await db.delete(schema.agentActivityLog).where(eq(schema.agentActivityLog.serverId, server!.id));
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, server!.id));
    if (ids.length) await db.delete(schema.messageMentions).where(inArray(schema.messageMentions.messageId, ids));
    await db.delete(schema.messages).where(eq(schema.messages.serverId, server!.id));
    if (channelIds.length) await db.delete(schema.channelMembers).where(inArray(schema.channelMembers.channelId, channelIds));
    await db.delete(schema.channels).where(eq(schema.channels.serverId, server!.id));
    await db.delete(schema.agents).where(eq(schema.agents.serverId, server!.id));
    await db.delete(schema.machines).where(eq(schema.machines.serverId, server!.id));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, server!.id));
    await db.delete(schema.servers).where(eq(schema.servers.id, server!.id));
    await db.delete(schema.users).where(eq(schema.users.id, user!.id));
  };

  try {
    const live = await startServer();
    daemonSocket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${live.base.replace("http", "ws")}/daemon/connect?key=${encodeURIComponent(machineKey)}`);
      const ready = JSON.stringify({ type: "ready", machineId: machine!.id, hostname: machine!.name, os: "test", runtimes: ["codex"], runningAgents: agents.map((a) => a.id), daemonVersion: "test" });
      let retry: NodeJS.Timeout | undefined;
      const timer = setTimeout(() => { if (retry) clearInterval(retry); reject(new Error(`dummy daemon ready timeout: ${live.logs()}`)); }, 3000);
      ws.on("open", () => { ws.send(ready); retry = setInterval(() => ws.send(ready), 100); });
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === "ready:ack") { clearTimeout(timer); if (retry) clearInterval(retry); resolve(ws); }
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      });
      ws.on("error", reject);
    });
    const humanHeaders = { authorization: `Bearer ${signUser(user!.id)}`, "x-server-id": server!.id };
    const agentHeaders = (i: number) => ({ authorization: `Bearer ${tokens[i]!.token}`, "x-agent-id": agents[i]!.id });
    const first = await api(live.base, "POST", "/api/messages", humanHeaders, { channelId: channel!.id, content: `write a joke @${tokens[0]!.name}` });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const triggerId = first.body.id as string;

    const checks = await Promise.all(agents.map((_, i) => api(live.base, "GET", "/agent-api/message/check", agentHeaders(i))));
    for (const checked of checks) {
      assert.equal(checked.status, 200);
      assert.equal(checked.body.messages.some((m: any) => m.id === triggerId), true);
    }
    const coordination = checks.map((c) => c.body.messages.find((m: any) => m.id === triggerId).coordination);
    assert.deepEqual(coordination.map((c: any) => [c.attention, c.grantStatus, c.grantSlot]), [
      ["direct", "active", "primary"], ["ambient", "none", null], ["ambient", "none", null],
    ]);

    const missingContext = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), { target: `#${channel!.name}`, content: "omitted trigger" });
    assert.equal(missingContext.status, 409);
    assert.equal(missingContext.body.code, "REPLY_CONTEXT_REQUIRED");
    const badTrigger = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), { target: `#${channel!.name}`, replyTo: "not-an-id", content: "bad trigger" });
    assert.equal(badTrigger.status, 404);
    assert.equal(badTrigger.body.code, "REPLY_TRIGGER_NOT_FOUND");
    const [otherChannel] = await db.insert(schema.channels).values({ serverId: server!.id, name: `other-${suffix}`, type: "channel" }).returning();
    const wrongTarget = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), { target: `#${otherChannel!.name}`, replyTo: triggerId, content: "wrong channel" });
    assert.equal(wrongTarget.status, 409);
    assert.equal(wrongTarget.body.code, "REPLY_TARGET_MISMATCH");
    const premature = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(1), { target: `#${channel!.name}`, replyTo: triggerId, content: "I should not escape" });
    assert.equal(premature.status, 409);
    assert.equal(premature.body.code, "REPLY_NOT_GRANTED");
    await api(live.base, "POST", "/agent-api/message/decide", agentHeaders(2), { messageId: triggerId, decision: "no_action" });

    const second = await api(live.base, "POST", "/api/messages", humanHeaders, { channelId: channel!.id, content: "new context arrived" });
    assert.equal(second.status, 200);
    const held = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), { target: `#${channel!.name}`, replyTo: triggerId, content: "stale owner draft" });
    assert.equal(held.status, 200);
    assert.equal(held.body.held, true);

    const request = await api(live.base, "POST", "/agent-api/message/decide", agentHeaders(1), { messageId: triggerId, decision: "request_reply", reason: "better_fit", summary: "humor specialist" });
    assert.equal(request.status, 200, JSON.stringify(request.body));
    assert.equal(request.body.grant, null);
    assert.equal(request.body.notifiedAgentId, agents[0]!.id);
    const ownerCoordination = await api(live.base, "GET", "/agent-api/message/check", agentHeaders(0));
    assert.equal(ownerCoordination.status, 200);
    assert.deepEqual(ownerCoordination.body.coordination.map((u: any) => [u.kind, u.requesterAgentId, u.reason]), [["request", agents[1]!.id, "better_fit"]]);
    const delegated = await api(live.base, "POST", "/agent-api/message/decide", agentHeaders(0), { messageId: triggerId, decision: "delegate", to: `@${tokens[1]!.name}` });
    assert.equal(delegated.status, 200, JSON.stringify(delegated.body));
    assert.equal(delegated.body.promotedAgentId, agents[1]!.id);
    const granteeCoordination = await api(live.base, "GET", "/agent-api/message/check", agentHeaders(1));
    assert.equal(granteeCoordination.status, 200);
    assert.deepEqual(granteeCoordination.body.coordination.map((u: any) => [u.kind, u.messageId, u.grant]), [["grant", triggerId, "primary"]]);
    const bypass = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), { target: `#${channel!.name}`, sendDraft: true });
    assert.equal(bypass.status, 409);
    assert.equal(bypass.body.code, "REPLY_NOT_GRANTED");
    const published = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(1), { target: `#${channel!.name}`, replyTo: triggerId, content: "delegated joke" });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    assert.equal(published.body.replyTo, triggerId);
    assert.equal(published.body.replySlot, "primary");

    const oldOwner = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), { target: `#${channel!.name}`, replyTo: triggerId, content: "duplicate" });
    assert.equal(oldOwner.status, 409);
    assert.equal(oldOwner.body.code, "REPLY_NOT_GRANTED");
    const replies = await db.select().from(schema.messages).where(and(eq(schema.messages.replyToMessageId, triggerId), eq(schema.messages.replyGrantSlot, "primary")));
    assert.equal(replies.length, 1);
    assert.equal(replies[0]!.senderId, agents[1]!.id);
    assert.equal(replies[0]!.content, "delegated joke");
    const audit = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, triggerId));
    assert.equal(audit.length, 3);
    assert.equal(audit.every((r) => !!r.observedAt), true);
    assert.deepEqual(audit.map((r) => r.decision).sort(), ["delegated", "no_action", "published"]);

    const multi = await api(live.base, "POST", "/api/messages", humanHeaders, {
      channelId: channel!.id,
      content: `separate answers @${tokens[0]!.name} backend and @${tokens[1]!.name} frontend`,
    });
    assert.equal(multi.status, 200, JSON.stringify(multi.body));
    const multiId = multi.body.id as string;
    const multiChecks = await Promise.all(agents.map((_, i) => api(live.base, "GET", "/agent-api/message/check", agentHeaders(i))));
    const multiCoordination = multiChecks.map((c) => c.body.messages.find((m: any) => m.id === multiId)?.coordination);
    assert.deepEqual(multiCoordination.map((c: any) => [c?.attention, c?.grantStatus, c?.grantSlot]), [
      ["direct", "active", "primary"], ["direct", "active", "directed"], ["ambient", "none", null],
    ]);
    for (const i of [0, 1]) {
      const accepted = await api(live.base, "POST", "/agent-api/message/decide", agentHeaders(i), { messageId: multiId, decision: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    }
    const backend = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), {
      target: `#${channel!.name}`, replyTo: multiId, content: `backend answer; @${tokens[2]!.name} verify this`,
    });
    assert.equal(backend.status, 200, JSON.stringify(backend.body));
    await api(live.base, "GET", "/agent-api/message/check", agentHeaders(1));
    const frontend = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(1), {
      target: `#${channel!.name}`, replyTo: multiId, content: "frontend answer",
    });
    assert.equal(frontend.status, 200, JSON.stringify(frontend.body));
    assert.equal(frontend.body.replySlot, "directed");
    const multiReplies = await db.select().from(schema.messages).where(eq(schema.messages.replyToMessageId, multiId));
    assert.deepEqual(multiReplies.map((m) => m.senderId).sort(), [agents[0]!.id, agents[1]!.id].sort());
    const contributorConversion = await api(live.base, "POST", "/agent-api/task/claim", agentHeaders(1), { messageId: multiId });
    assert.equal(contributorConversion.status, 409);
    assert.equal(contributorConversion.body.code, "TASK_RESERVED_FOR_PRIMARY");
    const contributorUpdateConversion = await api(live.base, "POST", "/agent-api/task/update", agentHeaders(1), { messageId: multiId, status: "done" });
    assert.equal(contributorUpdateConversion.status, 409);
    assert.equal(contributorUpdateConversion.body.code, "TASK_RESERVED_FOR_PRIMARY");
    const stillPlain = (await db.select({ taskStatus: schema.messages.taskStatus }).from(schema.messages).where(eq(schema.messages.id, multiId)))[0];
    assert.equal(stillPlain?.taskStatus, null);
    const workerCheck = await api(live.base, "GET", "/agent-api/message/check", agentHeaders(2));
    const agentMention = workerCheck.body.messages.find((m: any) => m.id === backend.body.id)?.coordination;
    assert.deepEqual([agentMention?.attention, agentMention?.grantSlot], ["direct", "primary"]);
    await api(live.base, "POST", "/agent-api/message/decide", agentHeaders(2), { messageId: backend.body.id, decision: "no_action" });

    const task = await api(live.base, "POST", "/api/messages", humanHeaders, {
      channelId: channel!.id, asTask: true,
      content: `split task @${tokens[0]!.name} backend and @${tokens[1]!.name} frontend`,
    });
    assert.equal(task.status, 200, JSON.stringify(task.body));
    const taskId = task.body.id as string;
    await Promise.all(agents.map((_, i) => api(live.base, "GET", "/agent-api/message/check", agentHeaders(i))));
    const contributorClaim = await api(live.base, "POST", "/agent-api/task/claim", agentHeaders(1), { messageId: taskId });
    assert.equal(contributorClaim.status, 409);
    assert.equal(contributorClaim.body.code, "TASK_RESERVED_FOR_PRIMARY");
    const contributorUpdate = await api(live.base, "POST", "/agent-api/task/update", agentHeaders(1), { messageId: taskId, status: "done" });
    assert.equal(contributorUpdate.status, 409);
    assert.equal(contributorUpdate.body.code, "TASK_RESERVED_FOR_PRIMARY");
    const contributorAssign = await api(live.base, "POST", "/agent-api/task/assign", agentHeaders(1), { messageId: taskId, to: tokens[1]!.name });
    assert.equal(contributorAssign.status, 409);
    assert.equal(contributorAssign.body.code, "TASK_RESERVED_FOR_PRIMARY");
    const ownerClaim = await api(live.base, "POST", "/agent-api/task/claim", agentHeaders(0), { messageId: taskId });
    assert.equal(ownerClaim.status, 200, JSON.stringify(ownerClaim.body));
    for (const i of [0, 1]) {
      const accepted = await api(live.base, "POST", "/agent-api/message/decide", agentHeaders(i), { messageId: taskId, decision: "accept" });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    }
    const wrongTaskTarget = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), {
      target: `#${channel!.name}`, replyTo: taskId, content: "wrong parent answer",
    });
    assert.equal(wrongTaskTarget.status, 409);
    assert.equal(wrongTaskTarget.body.code, "REPLY_TARGET_MISMATCH");
    const threadTarget = `thread:${taskId.slice(0, 8)}`;
    const taskBackend = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), {
      target: threadTarget, replyTo: taskId, content: "task backend result",
    });
    assert.equal(taskBackend.status, 200, JSON.stringify(taskBackend.body));
    const taskFrontendAttempt = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(1), {
      target: threadTarget, replyTo: taskId, content: "task frontend result",
    });
    assert.equal(taskFrontendAttempt.status, 200, JSON.stringify(taskFrontendAttempt.body));
    const taskFrontend = taskFrontendAttempt.body.held
      ? await api(live.base, "POST", "/agent-api/message/send", agentHeaders(1), { target: threadTarget, replyTo: taskId, sendDraft: true })
      : taskFrontendAttempt;
    assert.equal(taskFrontend.status, 200, JSON.stringify(taskFrontend.body));
    assert.equal(taskFrontend.body.replySlot, "directed");
    const taskRow = (await db.select().from(schema.messages).where(eq(schema.messages.id, taskId)))[0]!;
    const taskThreadReplies = await db.select().from(schema.messages).where(and(
      eq(schema.messages.channelId, taskRow.threadId!), eq(schema.messages.replyToMessageId, taskId),
    ));
    const taskParentReplies = await db.select().from(schema.messages).where(and(
      eq(schema.messages.channelId, channel!.id), eq(schema.messages.replyToMessageId, taskId),
    ));
    assert.equal(taskThreadReplies.length, 2);
    assert.equal(taskParentReplies.length, 0);
    assert.match(live.logs(), /message created/);
  } finally {
    daemonSocket?.close(); daemonSocket = null;
    if (serverProcess?.pid) { serverProcess.kill("SIGTERM"); serverProcess = null; }
    await cleanup();
  }
});
