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

async function waitForTurnDispatch(messageId: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const [turn] = await db.select({ state: schema.conversationTurns.state })
      .from(schema.messages)
      .innerJoin(schema.conversationTurns, eq(schema.conversationTurns.id, schema.messages.conversationTurnId))
      .where(eq(schema.messages.id, messageId));
    if (turn && ["dispatched", "blocked"].includes(turn.state)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Turn did not dispatch for message ${messageId}`);
}

test("real API: reconnect catch-up and reply coordination preserve their contracts", async () => {
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
  const [catchupAgent] = await db.insert(schema.agents).values({
    serverId: server!.id, machineId: machine!.id, name: `catchup-${suffix}`, displayName: `catchup-${suffix}`, runtime: "codex", status: "inactive",
  }).returning();
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
    const humanHeaders = { authorization: `Bearer ${signUser(user!.id)}`, "x-server-id": server!.id };
    const [catchupDm] = await db.insert(schema.channels).values({ serverId: server!.id, name: `dm:catchup-${suffix}`, type: "dm" }).returning();
    await db.insert(schema.channelMembers).values([
      { channelId: catchupDm!.id, memberType: "user", memberId: user!.id },
      { channelId: catchupDm!.id, memberType: "agent", memberId: catchupAgent!.id },
    ]);
    const offlineTrigger = await api(live.base, "POST", "/api/messages", humanHeaders, { channelId: catchupDm!.id, content: "offline backlog" });
    assert.equal(offlineTrigger.status, 200, JSON.stringify(offlineTrigger.body));
    const ambientOffline = await api(live.base, "POST", "/api/messages", humanHeaders, { channelId: channel!.id, content: "is anyone available?" });
    assert.equal(ambientOffline.status, 200, JSON.stringify(ambientOffline.body));
    let ambientOwnerAgentId: string | null = null;
    for (let i = 0; i < 50; i++) {
      const turns = await db.select({ messageId: schema.messages.id, state: schema.conversationTurns.state, ownerAgentId: schema.conversationTurns.ownerAgentId })
        .from(schema.messages)
        .innerJoin(schema.conversationTurns, eq(schema.conversationTurns.id, schema.messages.conversationTurnId))
        .where(inArray(schema.messages.id, [offlineTrigger.body.id, ambientOffline.body.id]));
      const ambientTurn = turns.find((turn) => turn.messageId === ambientOffline.body.id);
      if (turns.length === 2 && turns.every((turn) => turn.state === "blocked") && ambientTurn?.ownerAgentId) {
        ambientOwnerAgentId = ambientTurn.ownerAgentId;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ambientOwnerAgentId, `offline turns did not settle before reconnect: ${live.logs()}`);
    const ambientCatchupAgentIds: string[] = [];
    const committedCatchupAgentIds: string[] = [];
    daemonSocket = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`${live.base.replace("http", "ws")}/daemon/connect?key=${encodeURIComponent(machineKey)}`);
      const ready = JSON.stringify({ type: "ready", machineId: machine!.id, hostname: machine!.name, os: "test", runtimes: ["codex"], capabilities: ["delivery-admission-v2"], runningAgents: agents.map((a) => a.id), daemonVersion: "test" });
      const pendingDeliveries = new Map<string, any>();
      let acknowledged = false;
      let caughtUp = false;
      const timer = setTimeout(() => reject(new Error(`dummy daemon ready/catch-up timeout: ${live.logs()}`)), 3000);
      const finish = () => {
        if (!acknowledged || !caughtUp || ambientCatchupAgentIds.length < 1 || !committedCatchupAgentIds.includes(ambientOwnerAgentId!)) return;
        setTimeout(() => {
          clearTimeout(timer);
          resolve(ws);
        }, 100);
      };
      ws.on("open", () => ws.send(ready));
      ws.on("message", (data) => {
        const msg = JSON.parse(String(data));
        if (msg.type === "ready:ack") acknowledged = true;
        if (msg.type === "agent:start" && msg.agentId === catchupAgent!.id) caughtUp = true;
        if (msg.type === "agent:deliver" && agents.some((agent) => agent.id === msg.agentId)) ambientCatchupAgentIds.push(msg.agentId);
        if (msg.type === "agent:deliver" && msg.deliveryId) {
          pendingDeliveries.set(msg.deliveryId, msg);
          ws.send(JSON.stringify({ type: "agent:deliver:ready", agentId: msg.agentId, seq: msg.seq, deliveryId: msg.deliveryId }));
        }
        if (msg.type === "agent:deliver:admitted" && msg.deliveryId) {
          const delivery = pendingDeliveries.get(msg.deliveryId);
          if (delivery) {
            committedCatchupAgentIds.push(delivery.agentId);
            ws.send(JSON.stringify({ type: "agent:deliver:ack", agentId: delivery.agentId, seq: delivery.seq, deliveryId: delivery.deliveryId }));
          }
        }
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
        finish();
      });
      ws.on("error", reject);
    });
    assert.deepEqual(ambientCatchupAgentIds, [ambientOwnerAgentId], "reconnect wakes only the durable ambient owner once");
    const agentHeaders = (i: number) => ({ authorization: `Bearer ${tokens[i]!.token}`, "x-agent-id": agents[i]!.id });
    const ambientOwnerIndex = agents.findIndex((agent) => agent.id === ambientOwnerAgentId);
    assert.notEqual(ambientOwnerIndex, -1);
    const [ambientOwnerDecision] = await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, ambientOffline.body.id),
      eq(schema.agentMessageDecisions.agentId, ambientOwnerAgentId!),
    ));
    assert.deepEqual([ambientOwnerDecision?.grantSlot, ambientOwnerDecision?.grantStatus], ["primary", "active"], "offline fallback preserves a real primary grant");
    const ambientOwnerCheck = await api(live.base, "GET", "/agent-api/message/check", agentHeaders(ambientOwnerIndex));
    assert.equal(ambientOwnerCheck.status, 200, JSON.stringify(ambientOwnerCheck.body));
    assert.equal(ambientOwnerCheck.body.messages.some((message: any) => message.id === ambientOffline.body.id), true);
    const ambientReply = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(ambientOwnerIndex), {
      target: `#${channel!.name}`, replyTo: ambientOffline.body.id, content: "yes, I am here",
    });
    assert.equal(ambientReply.status, 200, JSON.stringify(ambientReply.body));
    const [completedOfflineTurn] = await db.select({ state: schema.conversationTurns.state, responsibilityState: schema.conversationTurns.responsibilityState })
      .from(schema.messages)
      .innerJoin(schema.conversationTurns, eq(schema.conversationTurns.id, schema.messages.conversationTurnId))
      .where(eq(schema.messages.id, ambientOffline.body.id));
    assert.deepEqual([completedOfflineTurn?.state, completedOfflineTurn?.responsibilityState], ["dispatched", "completed"], "offline blocked Turn reconciles after its eventual reply");

    const [dm] = await db.insert(schema.channels).values({ serverId: server!.id, name: `dm:${[user!.id, agents[0]!.id].sort().join(":")}`, type: "dm" }).returning();
    await db.insert(schema.channelMembers).values([
      { channelId: dm!.id, memberType: "user", memberId: user!.id },
      { channelId: dm!.id, memberType: "agent", memberId: agents[0]!.id },
    ]);
    const dmTrigger = await api(live.base, "POST", "/api/messages", humanHeaders, { channelId: dm!.id, content: "hi" });
    assert.equal(dmTrigger.status, 200, JSON.stringify(dmTrigger.body));
    const dmTriggerId = dmTrigger.body.id as string;
    await waitForTurnDispatch(dmTriggerId);
    const dmCheck = await api(live.base, "GET", "/agent-api/message/check", agentHeaders(0));
    assert.equal(dmCheck.status, 200, JSON.stringify(dmCheck.body));
    const dmCoordination = dmCheck.body.messages.find((m: any) => m.id === dmTriggerId)?.coordination;
    assert.deepEqual([dmCoordination?.attention, dmCoordination?.decision, dmCoordination?.grantSlot, dmCoordination?.grantStatus], ["dm", "accepted", "primary", "active"]);
    await db.update(schema.agentMessageDecisions).set({ decision: "pending", reasonCode: null, decidedAt: null }).where(eq(schema.agentMessageDecisions.messageId, dmTriggerId));
    const dmRecheck = await api(live.base, "GET", "/agent-api/message/check", agentHeaders(0));
    assert.equal(dmRecheck.status, 200);
    assert.equal(dmRecheck.body.messages.some((m: any) => m.id === dmTriggerId), false, "the legacy DM is already read");
    const [upgradedDm] = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, dmTriggerId));
    assert.deepEqual([upgradedDm?.decision, upgradedDm?.reasonCode, upgradedDm?.grantStatus], ["accepted", "dm_auto_authorized", "active"]);
    const dmReply = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), {
      target: `dm:@${user!.name}`, replyTo: dmTriggerId, content: "hello from codex",
    });
    assert.equal(dmReply.status, 200, JSON.stringify(dmReply.body));
    assert.equal(dmReply.body.replySlot, "primary");
    const [dmAudit] = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.messageId, dmTriggerId));
    assert.deepEqual([dmAudit?.decision, dmAudit?.grantStatus, dmAudit?.replyMessageId], ["published", "consumed", dmReply.body.id]);
    assert.equal(dmAudit?.reasonCode, "dm_auto_authorized");
    const duplicateDmReply = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), {
      target: `dm:@${user!.name}`, replyTo: dmTriggerId, content: "duplicate",
    });
    assert.equal(duplicateDmReply.status, 409);
    assert.equal(duplicateDmReply.body.code, "REPLY_GRANT_CONSUMED");

    const first = await api(live.base, "POST", "/api/messages", humanHeaders, { channelId: channel!.id, content: `write a joke @${tokens[0]!.name}` });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const triggerId = first.body.id as string;
    await waitForTurnDispatch(triggerId);

    const checks = await Promise.all(agents.map((_, i) => api(live.base, "GET", "/agent-api/message/check", agentHeaders(i))));
    for (const checked of checks) {
      assert.equal(checked.status, 200);
      assert.equal(checked.body.messages.some((m: any) => m.id === triggerId), true, JSON.stringify(checked.body));
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
    assert.equal(held.body.held, true, JSON.stringify(held.body));

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
    await waitForTurnDispatch(second.body.id);
    const refreshedDelegate = await api(live.base, "GET", "/agent-api/message/check", agentHeaders(1));
    assert.equal(refreshedDelegate.status, 200);
    let published = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(1), { target: `#${channel!.name}`, replyTo: triggerId, content: "delegated joke" });
    assert.equal(published.status, 200, JSON.stringify(published.body));
    // The earlier reconnect catch-up ambient message may belong to another randomly selected owner.
    // In that case it is intentionally absent from this agent's check but still triggers the send-time
    // freshness guard. Follow the public contract and submit the saved draft after reviewing the hold.
    if (published.body.held) {
      assert.equal(published.body.draft, true);
      published = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(1), { target: `#${channel!.name}`, replyTo: triggerId, sendDraft: true });
      assert.equal(published.status, 200, JSON.stringify(published.body));
    }
    assert.equal(published.body.replyTo, triggerId, JSON.stringify({ refreshedDelegate: refreshedDelegate.body, published: published.body }));
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
    await waitForTurnDispatch(multiId);
    const multiChecks = await Promise.all(agents.map((_, i) => api(live.base, "GET", "/agent-api/message/check", agentHeaders(i))));
    const multiCoordination = multiChecks.map((c) => c.body.messages.find((m: any) => m.id === multiId)?.coordination);
    assert.deepEqual(multiCoordination.map((c: any) => [c?.attention, c?.grantStatus, c?.grantSlot]), [
      ["direct", "active", "primary"], ["direct", "active", "directed"], ["ambient", "none", null],
    ]);
    const backendAttempt = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), {
      target: `#${channel!.name}`, replyTo: multiId, content: `backend answer; @${tokens[2]!.name} verify this`,
    });
    const backend = backendAttempt.body.held
      ? await api(live.base, "POST", "/agent-api/message/send", agentHeaders(0), { target: `#${channel!.name}`, replyTo: multiId, sendDraft: true })
      : backendAttempt;
    assert.equal(backend.status, 200, JSON.stringify(backend.body));
    await waitForTurnDispatch(backend.body.id);
    await api(live.base, "GET", "/agent-api/message/check", agentHeaders(1));
    const frontendAttempt = await api(live.base, "POST", "/agent-api/message/send", agentHeaders(1), {
      target: `#${channel!.name}`, replyTo: multiId, content: "frontend answer",
    });
    const frontend = frontendAttempt.body.held
      ? await api(live.base, "POST", "/agent-api/message/send", agentHeaders(1), { target: `#${channel!.name}`, replyTo: multiId, sendDraft: true })
      : frontendAttempt;
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
    await waitForTurnDispatch(taskId);
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
