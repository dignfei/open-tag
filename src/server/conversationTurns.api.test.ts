import "../env.js";
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import WebSocket from "ws";
import { and, asc, eq, inArray } from "drizzle-orm";
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
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(): Promise<{ base: string; logs: () => string }> {
  const port = await freePort();
  const chunks: string[] = [];
  serverProcess = spawn(process.execPath, ["--import", "tsx", "src/server/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      OPEN_TAG_TURN_DEBOUNCE_MS: "300",
      OPEN_TAG_DIRECT_TURN_DEBOUNCE_MS: "20",
      OPEN_TAG_REPLY_SETTLE_MS: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
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

async function api(base: string, method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() as any };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number, evidence: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for condition: ${evidence()}`);
}

test("real API: sender-scoped turns debounce once without merging different humans", async () => {
  const suffix = randomUUID().slice(0, 8);
  let secondaryDaemonSocket: WebSocket | null = null;
  const agentTokens = ["codex", "codex2"].map((name) => ({ name: `${name}-${suffix}`, token: `sk_agent_turn_${name}_${suffix}` }));
  const machineKey = `sk_machine_turn_${suffix}`;
  const humans = await db.insert(schema.users).values(["alice", "bob"].map((name) => ({
    name: `${name}-${suffix}`, displayName: name, email: `${name}-${suffix}@api.test.invalid`,
  }))).returning();
  const [server] = await db.insert(schema.servers).values({ name: `turn-${suffix}`, slug: `turn-${suffix}`, ownerId: humans[0]!.id }).returning();
  await db.insert(schema.serverMembers).values(humans.map((human, index) => ({ serverId: server!.id, userId: human.id, role: index === 0 ? "owner" : "member" })));
  const [machine] = await db.insert(schema.machines).values({
    serverId: server!.id, userId: humans[0]!.id, name: `machine-${suffix}`,
    apiKeyHash: hashToken(machineKey), apiKeyPrefix: machineKey.slice(0, 14), runtimes: ["codex"], status: "offline",
  }).returning();
  const [channel, dmChannel, raceChannel, bulkChannel, causalChannel] = await db.insert(schema.channels).values([
    { serverId: server!.id, name: `all-${suffix}`, type: "channel" },
    { serverId: server!.id, name: `dm-${suffix}`, type: "dm" },
    { serverId: server!.id, name: `race-${suffix}`, type: "channel" },
    { serverId: server!.id, name: `bulk-${suffix}`, type: "channel" },
    { serverId: server!.id, name: `causal-${suffix}`, type: "channel" },
  ]).returning();
  const channelIds = [channel!.id, dmChannel!.id, raceChannel!.id, bulkChannel!.id, causalChannel!.id];
  const agents = await db.insert(schema.agents).values(agentTokens.map((agent) => ({
    serverId: server!.id, machineId: machine!.id, name: agent.name, displayName: agent.name,
    agentTokenHash: hashToken(agent.token), runtime: "codex", status: "active",
  }))).returning();
  await db.insert(schema.channelMembers).values([
    ...humans.map((human) => ({ channelId: channel!.id, memberType: "user", memberId: human.id })),
    ...agents.map((agent) => ({ channelId: channel!.id, memberType: "agent", memberId: agent.id })),
    { channelId: dmChannel!.id, memberType: "user", memberId: humans[0]!.id },
    { channelId: dmChannel!.id, memberType: "agent", memberId: agents[0]!.id },
    { channelId: raceChannel!.id, memberType: "agent", memberId: agents[1]!.id },
    { channelId: bulkChannel!.id, memberType: "agent", memberId: agents[1]!.id },
    ...agents.map((agent) => ({ channelId: causalChannel!.id, memberType: "agent", memberId: agent.id })),
  ]);

  const cleanup = async () => {
    const messageIds = (await db.select({ id: schema.messages.id }).from(schema.messages).where(eq(schema.messages.serverId, server!.id))).map((m) => m.id);
    await db.delete(schema.causalEdges).where(eq(schema.causalEdges.serverId, server!.id));
    await db.delete(schema.agentActivityLog).where(eq(schema.agentActivityLog.serverId, server!.id));
    await db.delete(schema.agentMessageObservations).where(eq(schema.agentMessageObservations.serverId, server!.id));
    await db.delete(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, server!.id));
    if (messageIds.length) await db.delete(schema.messageMentions).where(inArray(schema.messageMentions.messageId, messageIds));
    await db.delete(schema.messages).where(eq(schema.messages.serverId, server!.id));
    await db.delete(schema.conversationTurns).where(eq(schema.conversationTurns.serverId, server!.id));
    await db.delete(schema.channelMembers).where(inArray(schema.channelMembers.channelId, channelIds));
    await db.delete(schema.channels).where(inArray(schema.channels.id, channelIds));
    await db.delete(schema.agents).where(eq(schema.agents.serverId, server!.id));
    await db.delete(schema.machines).where(eq(schema.machines.serverId, server!.id));
    await db.delete(schema.serverMembers).where(eq(schema.serverMembers.serverId, server!.id));
    await db.delete(schema.servers).where(eq(schema.servers.id, server!.id));
    await db.delete(schema.users).where(inArray(schema.users.id, humans.map((h) => h.id)));
  };

  try {
    const live = await startServer();
    const daemonMessages: any[] = [];
    let withholdNextTurnAck = false;
    let withheldDeliveryId: string | null = null;
    daemonSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${live.base.replace("http", "ws")}/daemon/connect?key=${encodeURIComponent(machineKey)}`);
      const timer = setTimeout(() => reject(new Error(`daemon ready timeout: ${live.logs()}`)), 3_000);
      socket.on("open", () => socket.send(JSON.stringify({
        type: "ready", machineId: machine!.id, hostname: machine!.name, os: "test", runtimes: ["codex"], capabilities: ["delivery-admission-v1"],
        runningAgents: agents.map((a) => a.id), daemonVersion: "test",
      })));
      socket.on("message", (data) => {
        const message = JSON.parse(String(data));
        daemonMessages.push(message);
        if (message.type === "ready:ack") { clearTimeout(timer); resolve(socket); }
        if (message.type === "agent:deliver" && message.deliveryId) {
          if (withholdNextTurnAck && !withheldDeliveryId) {
            withheldDeliveryId = message.deliveryId;
            withholdNextTurnAck = false;
          } else {
            socket.send(JSON.stringify({ type: "agent:deliver:ack", agentId: message.agentId, seq: message.seq, deliveryId: message.deliveryId }));
          }
        }
        if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      });
      socket.on("error", reject);
    });

    const headers = humans.map((human) => ({ authorization: `Bearer ${signUser(human.id)}`, "x-server-id": server!.id }));
    const alice1 = await api(live.base, "POST", "/api/messages", headers[0]!, { channelId: channel!.id, content: "帮我查一下" });
    const bob1 = await api(live.base, "POST", "/api/messages", headers[1]!, { channelId: channel!.id, content: "我有另一个问题" });
    const alice2 = await api(live.base, "POST", "/api/messages", headers[0]!, { channelId: channel!.id, content: "看看生产日志" });
    for (const result of [alice1, bob1, alice2]) assert.equal(result.status, 200, JSON.stringify(result.body));

    const agentHeaders = agents.map((agent, index) => ({ authorization: `Bearer ${agentTokens[index]!.token}`, "x-agent-id": agent.id }));
    const collectingTurnIds = (await db.select({ id: schema.conversationTurns.id }).from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.serverId, server!.id), eq(schema.conversationTurns.state, "collecting"),
    ))).map((turn) => turn.id);
    const collectingMessageIds = collectingTurnIds.length
      ? (await db.select({ id: schema.messages.id }).from(schema.messages).where(inArray(schema.messages.conversationTurnId, collectingTurnIds))).map((message) => message.id)
      : [];
    assert.ok(collectingMessageIds.length > 0, "the test must probe at least one still-collecting Turn");
    const earlyChecks = await Promise.all(agentHeaders.map((agentHeader) => api(live.base, "GET", "/agent-api/message/check", agentHeader)));
    assert.equal(earlyChecks.every((check) => check.status === 200), true);
    assert.equal(earlyChecks.flatMap((check) => check.body.messages).some((message: any) => collectingMessageIds.includes(message.id)), false, "collecting turns are not exposed as partial work");

    await waitFor(() => daemonMessages.filter((m) => m.type === "agent:deliver" && m.turnId).length === 2, 3_000, () => JSON.stringify({ daemonMessages, logs: live.logs() }));
    const turns = await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.serverId, server!.id)).orderBy(asc(schema.conversationTurns.createdAt));
    assert.equal(turns.length, 2, "Alice and Bob must own separate windows in one channel");
    const aliceTurn = turns.find((turn) => turn.senderId === humans[0]!.id)!;
    const bobTurn = turns.find((turn) => turn.senderId === humans[1]!.id)!;
    assert.equal(aliceTurn.firstSeq < aliceTurn.lastSeq, true, "Alice's two messages merge into one turn");
    assert.equal(bobTurn.firstSeq, bobTurn.lastSeq, "Bob's turn contains only Bob's message");
    assert.deepEqual(turns.map((turn) => [turn.state, turn.responsibilityState]), [["dispatched", "delivered"], ["dispatched", "delivered"]]);

    const deliveries = daemonMessages.filter((m) => m.type === "agent:deliver" && m.turnId);
    assert.equal(new Set(deliveries.map((m) => m.turnId)).size, 2);
    assert.deepEqual(deliveries.map((m) => m.turnMessageCount).sort(), [1, 2]);
    assert.ok(deliveries.every((m) => m.attention === "assigned"));
    const decisions = await db.select().from(schema.agentMessageDecisions).where(eq(schema.agentMessageDecisions.serverId, server!.id));
    assert.equal(decisions.length, 2, "one responsibility/grant ledger row per human turn");
    assert.deepEqual(decisions.map((row) => [row.attention, row.grantSlot, row.grantStatus]), [
      ["assigned", "primary", "active"], ["assigned", "primary", "active"],
    ]);

    const owner = agents.find((agent) => agent.id === aliceTurn.ownerAgentId)!;
    const ownerIndex = agents.findIndex((agent) => agent.id === owner.id);
    const ownerCheck = await api(live.base, "GET", "/agent-api/message/check", agentHeaders[ownerIndex]!);
    assert.equal(ownerCheck.status, 200, JSON.stringify(ownerCheck.body));
    const aliceMessages = ownerCheck.body.messages.filter((m: any) => m.id === alice1.body.id || m.id === alice2.body.id);
    assert.equal(aliceMessages.length, 2);
    assert.equal(new Set(aliceMessages.map((m: any) => m.coordination?.messageId)).size, 1, "both messages expose the same canonical Turn grant");
    assert.ok(aliceMessages.every((m: any) => m.coordination?.attention === "assigned" && m.coordination?.grantStatus === "active"));

    withholdNextTurnAck = true;
    const alice3 = await api(live.base, "POST", "/api/messages", headers[0]!, { channelId: channel!.id, content: "窗口后的新问题" });
    assert.equal(alice3.status, 200);
    await waitFor(async () => {
      if (!withheldDeliveryId || daemonMessages.filter((message) => message.deliveryId === withheldDeliveryId).length !== 2) return false;
      const [turn] = await db.select({ state: schema.conversationTurns.state }).from(schema.conversationTurns)
        .where(eq(schema.conversationTurns.triggerMessageId, alice3.body.id)).limit(1);
      return turn?.state === "dispatched";
    }, 7_000, () => JSON.stringify({ daemonMessages, logs: live.logs() }));
    assert.equal(new Set(daemonMessages.filter((message) => message.deliveryId === withheldDeliveryId).map((message) => message.deliveryId)).size, 1, "retry reuses the same deterministic delivery fence");
    const afterWindowTurns = await db.select().from(schema.conversationTurns).where(eq(schema.conversationTurns.serverId, server!.id));
    assert.equal(afterWindowTurns.length, 3, "same human starts a new turn after the prior window closes");
    assert.equal(afterWindowTurns.find((turn) => turn.triggerMessageId === alice3.body.id)?.state, "dispatched", "Turn settles only after the retry receives an ACK");

    withholdNextTurnAck = true;
    withheldDeliveryId = null;
    const causalSend = await api(live.base, "POST", "/agent-api/message/send", agentHeaders[0]!, {
      target: `#${causalChannel!.name}`,
      content: `@${agentTokens[1]!.name} 请接手检查这个问题`,
    });
    assert.equal(causalSend.status, 200, JSON.stringify(causalSend.body));
    await waitFor(
      () => !!withheldDeliveryId && daemonMessages.filter((message) => message.deliveryId === withheldDeliveryId).length === 2,
      7_000,
      () => JSON.stringify({ daemonMessages, logs: live.logs() }),
    );
    const [causalMessage] = await db.select({ turnId: schema.messages.conversationTurnId })
      .from(schema.messages).where(eq(schema.messages.id, causalSend.body.id));
    assert.ok(causalMessage?.turnId, "agent-authored mention must create a causal Turn");
    const causalRows = await db.select({ parentTurnId: schema.causalEdges.parentTurnId, outcome: schema.causalEdges.outcome })
      .from(schema.causalEdges).where(eq(schema.causalEdges.parentTurnId, causalMessage.turnId!));
    assert.deepEqual(causalRows, [{ parentTurnId: causalMessage.turnId, outcome: "accepted" }], "ACK retry for one causal Turn reuses its accepted edge instead of recording duplicate work");

    const targetIndex = 1;
    const drained = await api(live.base, "GET", "/agent-api/message/check", agentHeaders[targetIndex]!);
    assert.equal(drained.status, 200, JSON.stringify(drained.body));
    const aliceGap = await api(live.base, "POST", "/api/messages", headers[0]!, { channelId: channel!.id, content: "这条还在输入窗口里" });
    const bobStable = await api(live.base, "POST", "/api/messages", headers[1]!, {
      channelId: channel!.id,
      content: `@${agentTokens[targetIndex]!.name} 先处理我的紧急问题`,
    });
    assert.equal(aliceGap.status, 200);
    assert.equal(bobStable.status, 200);
    await waitFor(async () => {
      const rows = await db.select({ triggerMessageId: schema.conversationTurns.triggerMessageId, state: schema.conversationTurns.state })
        .from(schema.conversationTurns)
        .where(inArray(schema.conversationTurns.triggerMessageId, [aliceGap.body.id, bobStable.body.id]));
      const byTrigger = new Map(rows.map((row) => [row.triggerMessageId, row.state]));
      return byTrigger.get(aliceGap.body.id) === "collecting" && byTrigger.get(bobStable.body.id) === "dispatched";
    }, 250, () => JSON.stringify({ daemonMessages, logs: live.logs() }));

    const acrossGap = await api(live.base, "GET", "/agent-api/message/check", agentHeaders[targetIndex]!);
    assert.equal(acrossGap.status, 200, JSON.stringify(acrossGap.body));
    assert.equal(acrossGap.body.messages.some((message: any) => message.id === bobStable.body.id), true, "later stable sender Turn crosses an earlier collecting cursor gap");
    assert.equal(acrossGap.body.messages.some((message: any) => message.id === aliceGap.body.id), false, "earlier collecting Turn stays hidden");
    const repeatedAcrossGap = await api(live.base, "GET", "/agent-api/message/check", agentHeaders[targetIndex]!);
    assert.equal(repeatedAcrossGap.body.messages.some((message: any) => message.id === bobStable.body.id), false, "observed stable Turn is not repeated while the scalar cursor waits at the gap");

    await waitFor(async () => (await db.select({ state: schema.conversationTurns.state }).from(schema.conversationTurns)
      .where(eq(schema.conversationTurns.triggerMessageId, aliceGap.body.id)).limit(1))[0]?.state === "dispatched", 2_000, () => live.logs());
    const afterGapSettles = await api(live.base, "GET", "/agent-api/message/check", agentHeaders[targetIndex]!);
    const aliceGapDeliveries = [repeatedAcrossGap, afterGapSettles].flatMap((result) => result.body.messages)
      .filter((message: any) => message.id === aliceGap.body.id);
    assert.equal(aliceGapDeliveries.length, 1, "the previously collecting Turn becomes visible exactly once on the first check after dispatch");

    const dmResults = await Promise.all([
      api(live.base, "POST", "/api/messages", headers[0]!, { channelId: dmChannel!.id, content: "hello" }),
      api(live.base, "POST", "/api/messages", headers[0]!, { channelId: dmChannel!.id, content: "你在吗" }),
    ]);
    assert.equal(dmResults.every((result) => result.status === 200), true, JSON.stringify(dmResults));
    const dmRows = await db.select({ id: schema.messages.id, turnId: schema.messages.conversationTurnId })
      .from(schema.messages).where(inArray(schema.messages.id, dmResults.map((result) => result.body.id)));
    assert.equal(new Set(dmRows.map((row) => row.turnId)).size, 1, "real createMessage classification merges same-sender DM direct messages");

    const [raceMessage] = await db.insert(schema.messages).values({
      seq: 98_000_001, serverId: server!.id, channelId: raceChannel!.id, senderType: "user",
      senderId: humans[0]!.id, senderName: humans[0]!.name, content: "dispatch race",
    }).returning();
    const raceTurnId = randomUUID();
    await db.insert(schema.conversationTurns).values({
      id: raceTurnId, serverId: server!.id, channelId: raceChannel!.id, senderType: "user", senderId: humans[0]!.id,
      anchorMessageId: raceMessage!.id, triggerMessageId: raceMessage!.id, latestMessageId: raceMessage!.id,
      firstSeq: raceMessage!.seq, lastSeq: raceMessage!.seq, boundaryKind: "direct", state: "dispatching",
      dispatchAfter: new Date(), dispatchLeaseUntil: new Date(Date.now() + 30_000), causalRootId: raceTurnId,
      ownerAgentId: agents[targetIndex]!.id, responsibilityState: "assigned",
    });
    await db.update(schema.messages).set({ conversationTurnId: raceTurnId }).where(eq(schema.messages.id, raceMessage!.id));
    await db.insert(schema.agentMessageDecisions).values({
      serverId: server!.id, channelId: raceChannel!.id, messageId: raceMessage!.id, agentId: agents[targetIndex]!.id,
      attention: "assigned", grantSlot: "primary", grantStatus: "reserved",
    });
    const beforeActivation = await api(live.base, "GET", "/agent-api/message/check", agentHeaders[targetIndex]!);
    assert.equal(beforeActivation.body.messages.some((message: any) => message.id === raceMessage!.id), false, "dispatching+reserved remains hidden");
    const [stillReserved] = await db.select({ status: schema.agentMessageDecisions.grantStatus }).from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, raceMessage!.id), eq(schema.agentMessageDecisions.agentId, agents[targetIndex]!.id),
    ));
    assert.equal(stillReserved?.status, "reserved");
    await db.update(schema.agentMessageDecisions).set({ grantStatus: "active", grantedAt: new Date() }).where(and(
      eq(schema.agentMessageDecisions.messageId, raceMessage!.id), eq(schema.agentMessageDecisions.agentId, agents[targetIndex]!.id),
    ));
    await db.update(schema.conversationTurns).set({ state: "active", responsibilityState: "active" }).where(eq(schema.conversationTurns.id, raceTurnId));
    const afterActivation = await api(live.base, "GET", "/agent-api/message/check", agentHeaders[targetIndex]!);
    const visibleRace = afterActivation.body.messages.find((message: any) => message.id === raceMessage!.id);
    assert.equal(visibleRace?.coordination?.grantStatus, "active", "Turn is visible only after reply authority activates");

    const bulkMessages = await db.insert(schema.messages).values(Array.from({ length: 101 }, (_, index) => ({
      seq: 99_000_000 + index, serverId: server!.id, channelId: bulkChannel!.id, senderType: "user" as const,
      senderId: humans[1]!.id, senderName: humans[1]!.name, content: `bulk ${index}`,
    }))).returning();
    const bulkTurnId = randomUUID();
    await db.insert(schema.conversationTurns).values({
      id: bulkTurnId, serverId: server!.id, channelId: bulkChannel!.id, senderType: "user", senderId: humans[1]!.id,
      anchorMessageId: bulkMessages[0]!.id, triggerMessageId: bulkMessages[0]!.id, latestMessageId: bulkMessages[100]!.id,
      firstSeq: bulkMessages[0]!.seq, lastSeq: bulkMessages[100]!.seq, boundaryKind: "direct", state: "dispatched",
      dispatchAfter: new Date(), causalRootId: bulkTurnId, ownerAgentId: agents[targetIndex]!.id, responsibilityState: "delivered",
    });
    await db.update(schema.messages).set({ conversationTurnId: bulkTurnId }).where(inArray(schema.messages.id, bulkMessages.map((message) => message.id)));
    await db.insert(schema.agentMessageDecisions).values({
      serverId: server!.id, channelId: bulkChannel!.id, messageId: bulkMessages[0]!.id, agentId: agents[targetIndex]!.id,
      attention: "assigned", grantSlot: "primary", grantStatus: "active", grantedAt: new Date(),
    });
    const firstBulkPage = await api(live.base, "GET", "/agent-api/message/check", agentHeaders[targetIndex]!);
    assert.equal(firstBulkPage.body.messages.filter((message: any) => message.channelId === bulkChannel!.id).length, 100);
    const secondBulkPage = await api(live.base, "GET", "/agent-api/message/check", agentHeaders[targetIndex]!);
    assert.deepEqual(
      secondBulkPage.body.messages.filter((message: any) => message.channelId === bulkChannel!.id).map((message: any) => message.id),
      [bulkMessages[100]!.id],
      "per-message observation must not hide the remainder of a canonical Turn across the 100-row page",
    );

    await new Promise<void>((resolve) => {
      daemonSocket!.once("close", () => resolve());
      daemonSocket!.close();
    });
    await waitFor(async () => (await db.select({ status: schema.machines.status }).from(schema.machines)
      .where(eq(schema.machines.id, machine!.id)).limit(1))[0]?.status === "offline", 2_000, () => live.logs());

    const gatedAgentToken = `sk_agent_gate_${suffix}`;
    const [gatedAgent] = await db.insert(schema.agents).values({
      serverId: server!.id, machineId: machine!.id, name: `gate-${suffix}`, displayName: `gate-${suffix}`,
      agentTokenHash: hashToken(gatedAgentToken), runtime: "codex", status: "inactive",
    }).returning();
    const [gatedChannel] = await db.insert(schema.channels).values({ serverId: server!.id, name: `gate-${suffix}`, type: "channel" }).returning();
    channelIds.push(gatedChannel!.id);
    await db.insert(schema.channelMembers).values([
      { channelId: gatedChannel!.id, memberType: "user", memberId: humans[0]!.id },
      { channelId: gatedChannel!.id, memberType: "agent", memberId: gatedAgent!.id },
    ]);
    const gated = await api(live.base, "POST", "/api/messages", headers[0]!, {
      channelId: gatedChannel!.id,
      content: `@${gatedAgent!.name} 离线期间积压的 Turn`,
    });
    assert.equal(gated.status, 200, JSON.stringify(gated.body));
    await waitFor(async () => {
      const [turn] = await db.select({ state: schema.conversationTurns.state }).from(schema.conversationTurns)
        .where(eq(schema.conversationTurns.triggerMessageId, gated.body.id)).limit(1);
      return turn?.state === "active";
    }, 2_000, () => live.logs());

    const oldDaemonMessages: any[] = [];
    daemonSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${live.base.replace("http", "ws")}/daemon/connect?key=${encodeURIComponent(machineKey)}`);
      const timer = setTimeout(() => reject(new Error(`old daemon ready timeout: ${live.logs()}`)), 3_000);
      socket.on("open", () => socket.send(JSON.stringify({
        type: "ready", machineId: machine!.id, hostname: machine!.name, os: "test", runtimes: ["codex"],
        capabilities: ["agent:deliver"], runningAgents: [...agents.map((agent) => agent.id), gatedAgent!.id], daemonVersion: "old-test",
      })));
      socket.on("message", (data) => {
        const message = JSON.parse(String(data));
        oldDaemonMessages.push(message);
        if (message.type === "ready:ack") { clearTimeout(timer); resolve(socket); }
        if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      });
      socket.on("error", reject);
    });
    await waitFor(async () => {
      const [turn] = await db.select({
        state: schema.conversationTurns.state,
        dispatchAttempts: schema.conversationTurns.dispatchAttempts,
        dispatchLeaseUntil: schema.conversationTurns.dispatchLeaseUntil,
      })
        .from(schema.conversationTurns).where(eq(schema.conversationTurns.triggerMessageId, gated.body.id)).limit(1);
      return turn?.state === "active" && turn.dispatchLeaseUntil?.getUTCFullYear() === 9999;
    }, 3_000, () => JSON.stringify({ oldDaemonMessages, logs: live.logs() }));
    const [pausedTurn] = await db.select({ dispatchAttempts: schema.conversationTurns.dispatchAttempts })
      .from(schema.conversationTurns).where(eq(schema.conversationTurns.triggerMessageId, gated.body.id)).limit(1);
    const pausedAttempts = pausedTurn!.dispatchAttempts;

    const unboundToken = `sk_agent_unbound_${suffix}`;
    const [unboundAgent] = await db.insert(schema.agents).values({
      serverId: server!.id, machineId: null, name: `unbound-${suffix}`, displayName: `unbound-${suffix}`,
      agentTokenHash: hashToken(unboundToken), runtime: "codex", status: "inactive",
    }).returning();
    const [unboundChannel] = await db.insert(schema.channels).values({ serverId: server!.id, name: `unbound-${suffix}`, type: "channel" }).returning();
    channelIds.push(unboundChannel!.id);
    await db.insert(schema.channelMembers).values([
      { channelId: unboundChannel!.id, memberType: "user", memberId: humans[0]!.id },
      { channelId: unboundChannel!.id, memberType: "agent", memberId: unboundAgent!.id },
    ]);
    const unboundMessage = await api(live.base, "POST", "/api/messages", headers[0]!, {
      channelId: unboundChannel!.id,
      content: `@${unboundAgent!.name} 单 daemon 升级后应恢复`,
    });
    assert.equal(unboundMessage.status, 200, JSON.stringify(unboundMessage.body));
    await waitFor(async () => {
      const [turn] = await db.select({ state: schema.conversationTurns.state, dispatchAttempts: schema.conversationTurns.dispatchAttempts })
        .from(schema.conversationTurns).where(eq(schema.conversationTurns.triggerMessageId, unboundMessage.body.id)).limit(1);
      return turn?.state === "active" && turn.dispatchAttempts === 1;
    }, 2_000, () => live.logs());
    assert.equal(
      oldDaemonMessages.some((message) => message.agentId === gatedAgent!.id && (message.type === "agent:start" || message.type === "agent:deliver")),
      false,
      "old-daemon reconnect catch-up and retry both emit zero Turn wake/delivery frames for an unbound agent",
    );
    assert.equal(oldDaemonMessages.some((message) => message.agentId === unboundAgent!.id && (message.type === "agent:start" || message.type === "agent:deliver")), false);
    const gatedAgentHeaders = { authorization: `Bearer ${gatedAgentToken}`, "x-agent-id": gatedAgent!.id };
    const gatedCheck = await api(live.base, "GET", "/agent-api/message/check", gatedAgentHeaders);
    assert.equal(gatedCheck.status, 200, JSON.stringify(gatedCheck.body));
    assert.equal(gatedCheck.body.messages.some((message: any) => message.id === gated.body.id), false, "old daemon agent cannot pull the hidden Turn directly");
    assert.equal(gatedCheck.body.warnings?.[0]?.code, "DELIVERY_ADMISSION_REQUIRED");
    const gatedDecision = await api(live.base, "POST", "/agent-api/message/decide", gatedAgentHeaders, {
      messageId: gated.body.id,
      decision: "accept",
    });
    assert.equal(gatedDecision.status, 409, JSON.stringify(gatedDecision.body));
    assert.equal(gatedDecision.body.code, "DELIVERY_ADMISSION_REQUIRED");
    const gatedReply = await api(live.base, "POST", "/agent-api/message/send", gatedAgentHeaders, {
      target: `#${gatedChannel!.name}`,
      content: "不应发布",
      replyTo: gated.body.id,
    });
    assert.equal(gatedReply.status, 409, JSON.stringify(gatedReply.body));
    assert.equal(gatedReply.body.code, "DELIVERY_ADMISSION_REQUIRED");

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const [stillPaused] = await db.select({ state: schema.conversationTurns.state, dispatchAttempts: schema.conversationTurns.dispatchAttempts })
      .from(schema.conversationTurns).where(eq(schema.conversationTurns.triggerMessageId, gated.body.id)).limit(1);
    assert.deepEqual([stillPaused?.state, stillPaused?.dispatchAttempts], ["active", pausedAttempts], "old daemon does not burn retries while the Turn is capability-paused");

    await new Promise<void>((resolve) => {
      daemonSocket!.once("close", () => resolve());
      daemonSocket!.close();
    });
    const capableDaemonMessages: any[] = [];
    daemonSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${live.base.replace("http", "ws")}/daemon/connect?key=${encodeURIComponent(machineKey)}`);
      const timer = setTimeout(() => reject(new Error(`capable daemon ready timeout: ${live.logs()}`)), 3_000);
      socket.on("open", () => socket.send(JSON.stringify({
        type: "ready", machineId: machine!.id, hostname: machine!.name, os: "test", runtimes: ["codex"],
        capabilities: ["agent:deliver", "delivery-admission-v1"], runningAgents: [...agents.map((agent) => agent.id), gatedAgent!.id], daemonVersion: "new-test",
      })));
      socket.on("message", (data) => {
        const message = JSON.parse(String(data));
        capableDaemonMessages.push(message);
        if (message.type === "ready:ack") { clearTimeout(timer); resolve(socket); }
        if (message.type === "agent:deliver" && message.deliveryId) {
          socket.send(JSON.stringify({ type: "agent:deliver:ack", agentId: message.agentId, seq: message.seq, deliveryId: message.deliveryId }));
        }
        if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      });
      socket.on("error", reject);
    });
    await waitFor(async () => {
      const [turn] = await db.select({ state: schema.conversationTurns.state, dispatchAttempts: schema.conversationTurns.dispatchAttempts })
        .from(schema.conversationTurns).where(eq(schema.conversationTurns.triggerMessageId, gated.body.id)).limit(1);
      return turn?.state === "dispatched" && turn.dispatchAttempts === pausedAttempts + 1;
    }, 3_000, () => JSON.stringify({ capableDaemonMessages, logs: live.logs() }));
    const resumedDelivery = capableDaemonMessages.find((message) => message.type === "agent:deliver" && message.agentId === gatedAgent!.id);
    assert.equal(resumedDelivery?.deliveryId, `${(await db.select({ id: schema.conversationTurns.id }).from(schema.conversationTurns).where(eq(schema.conversationTurns.triggerMessageId, gated.body.id)).limit(1))[0]!.id}:${gatedAgent!.id}`);
    await waitFor(async () => {
      const [turn] = await db.select({ state: schema.conversationTurns.state, dispatchAttempts: schema.conversationTurns.dispatchAttempts })
        .from(schema.conversationTurns).where(eq(schema.conversationTurns.triggerMessageId, unboundMessage.body.id)).limit(1);
      return turn?.state === "dispatched" && turn.dispatchAttempts === 2;
    }, 3_000, () => JSON.stringify({ capableDaemonMessages, logs: live.logs() }));
    assert.ok(capableDaemonMessages.some((message) => message.type === "agent:deliver" && message.agentId === unboundAgent!.id && message.deliveryId), "exactly-one capable daemon resumes unbound Turn delivery");
    const resumedCheck = await api(live.base, "GET", "/agent-api/message/check", gatedAgentHeaders);
    assert.equal(resumedCheck.body.messages.some((message: any) => message.id === gated.body.id), true, "the sole capable daemon resumes and exposes the admitted unbound Turn");

    const [mixedVisibilityChannel] = await db.insert(schema.channels).values({
      serverId: server!.id, name: `mixed-visibility-${suffix}`, type: "channel",
    }).returning();
    channelIds.push(mixedVisibilityChannel!.id);
    await db.insert(schema.channelMembers).values([
      { channelId: mixedVisibilityChannel!.id, memberType: "user", memberId: humans[0]!.id },
      { channelId: mixedVisibilityChannel!.id, memberType: "agent", memberId: gatedAgent!.id },
    ]);
    const [pausedMessage] = await db.insert(schema.messages).values({
      seq: 199_000_000, serverId: server!.id, channelId: mixedVisibilityChannel!.id,
      senderType: "user", senderId: humans[0]!.id, senderName: humans[0]!.name,
      content: "mixed fleet must hide the whole turn",
    }).returning();
    const pausedTurnId = randomUUID();
    const pausedUntil = new Date("9999-12-31T23:59:59.999Z");
    await db.insert(schema.conversationTurns).values({
      id: pausedTurnId, serverId: server!.id, channelId: mixedVisibilityChannel!.id,
      senderType: "user", senderId: humans[0]!.id, anchorMessageId: pausedMessage!.id,
      triggerMessageId: pausedMessage!.id, latestMessageId: pausedMessage!.id,
      firstSeq: pausedMessage!.seq, lastSeq: pausedMessage!.seq, boundaryKind: "direct",
      state: "active", dispatchAfter: pausedUntil, dispatchLeaseUntil: pausedUntil,
      causalRootId: pausedTurnId, ownerAgentId: gatedAgent!.id, responsibilityState: "active",
    });
    await db.update(schema.messages).set({ conversationTurnId: pausedTurnId }).where(eq(schema.messages.id, pausedMessage!.id));
    await db.insert(schema.agentMessageDecisions).values({
      serverId: server!.id, channelId: mixedVisibilityChannel!.id, messageId: pausedMessage!.id,
      agentId: gatedAgent!.id, attention: "direct", grantSlot: "primary", grantStatus: "active", grantedAt: new Date(),
    });

    const capablePausedCheck = await api(live.base, "GET", "/agent-api/message/check", gatedAgentHeaders);
    assert.equal(capablePausedCheck.body.messages.some((message: any) => message.id === pausedMessage!.id), false, "one capable recipient cannot observe a Turn paused by another recipient's daemon");
    assert.equal(capablePausedCheck.body.warnings?.some((warning: any) => warning.code === "DELIVERY_ADMISSION_REQUIRED"), true);
    const capablePausedDecision = await api(live.base, "POST", "/agent-api/message/decide", gatedAgentHeaders, {
      messageId: pausedMessage!.id,
      decision: "accept",
    });
    assert.equal(capablePausedDecision.status, 409, JSON.stringify(capablePausedDecision.body));
    assert.equal(capablePausedDecision.body.code, "DELIVERY_ADMISSION_REQUIRED");

    await db.update(schema.conversationTurns).set({
      state: "dispatched", responsibilityState: "delivered", dispatchAfter: new Date(), dispatchLeaseUntil: null,
    }).where(eq(schema.conversationTurns.id, pausedTurnId));
    const capableResumedCheck = await api(live.base, "GET", "/agent-api/message/check", gatedAgentHeaders);
    assert.equal(capableResumedCheck.body.messages.some((message: any) => message.id === pausedMessage!.id), true, "the Turn becomes visible only after the fleet pause clears");

    const admittedAgentToken = `sk_agent_admitted_${suffix}`;
    const [admittedAgent] = await db.insert(schema.agents).values({
      serverId: server!.id, machineId: null, name: `admitted-${suffix}`, displayName: `admitted-${suffix}`,
      agentTokenHash: hashToken(admittedAgentToken), runtime: "codex", status: "active",
    }).returning();
    const [admittedChannel] = await db.insert(schema.channels).values({
      serverId: server!.id, name: `admitted-unbound-${suffix}`, type: "channel",
    }).returning();
    channelIds.push(admittedChannel!.id);
    await db.insert(schema.channelMembers).values([
      { channelId: admittedChannel!.id, memberType: "user", memberId: humans[0]!.id },
      { channelId: admittedChannel!.id, memberType: "agent", memberId: admittedAgent!.id },
    ]);
    const [admittedMessage] = await db.insert(schema.messages).values({
      seq: 199_000_001, serverId: server!.id, channelId: admittedChannel!.id,
      senderType: "user", senderId: humans[0]!.id, senderName: humans[0]!.name,
      content: "already admitted before topology expanded",
    }).returning();
    const admittedTurnId = randomUUID();
    await db.insert(schema.conversationTurns).values({
      id: admittedTurnId, serverId: server!.id, channelId: admittedChannel!.id,
      senderType: "user", senderId: humans[0]!.id, anchorMessageId: admittedMessage!.id,
      triggerMessageId: admittedMessage!.id, latestMessageId: admittedMessage!.id,
      firstSeq: admittedMessage!.seq, lastSeq: admittedMessage!.seq, boundaryKind: "direct",
      state: "active", dispatchAfter: new Date(), dispatchLeaseUntil: new Date(Date.now() + 30_000),
      causalRootId: admittedTurnId, ownerAgentId: admittedAgent!.id, responsibilityState: "active",
    });
    await db.update(schema.messages).set({ conversationTurnId: admittedTurnId }).where(eq(schema.messages.id, admittedMessage!.id));
    await db.insert(schema.agentMessageDecisions).values({
      serverId: server!.id, channelId: admittedChannel!.id, messageId: admittedMessage!.id,
      agentId: admittedAgent!.id, attention: "direct", grantSlot: "primary", grantStatus: "active",
      grantedAt: new Date(), deliveryAdmittedAt: new Date(),
    });

    const secondaryMachineKey = `sk_machine_secondary_${suffix}`;
    const [secondaryMachine] = await db.insert(schema.machines).values({
      serverId: server!.id, userId: humans[0]!.id, name: `secondary-${suffix}`,
      apiKeyHash: hashToken(secondaryMachineKey), apiKeyPrefix: secondaryMachineKey.slice(0, 14),
      runtimes: ["codex"], status: "offline",
    }).returning();
    secondaryDaemonSocket = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(`${live.base.replace("http", "ws")}/daemon/connect?key=${encodeURIComponent(secondaryMachineKey)}`);
      const timer = setTimeout(() => reject(new Error(`secondary daemon ready timeout: ${live.logs()}`)), 3_000);
      socket.on("open", () => socket.send(JSON.stringify({
        type: "ready", machineId: secondaryMachine!.id, hostname: secondaryMachine!.name, os: "test", runtimes: ["codex"],
        capabilities: ["agent:deliver", "delivery-admission-v1"], runningAgents: [], daemonVersion: "new-test",
      })));
      socket.on("message", (data) => {
        const message = JSON.parse(String(data));
        if (message.type === "ready:ack") { clearTimeout(timer); resolve(socket); }
        if (message.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
      });
      socket.on("error", reject);
    });

    const admittedAgentHeaders = { authorization: `Bearer ${admittedAgentToken}`, "x-agent-id": admittedAgent!.id };
    const admittedCheck = await api(live.base, "GET", "/agent-api/message/check", admittedAgentHeaders);
    assert.equal(admittedCheck.status, 200, JSON.stringify(admittedCheck.body));
    assert.equal(admittedCheck.body.messages.some((message: any) => message.id === admittedMessage!.id), true, "a 1-to-2 topology change cannot hide already-admitted unbound work");
    assert.deepEqual(admittedCheck.body.warnings, [], "already-admitted work is not reported as blocked by the new topology");
    const admittedDecision = await api(live.base, "POST", "/agent-api/message/decide", admittedAgentHeaders, {
      messageId: admittedMessage!.id,
      decision: "accept",
    });
    assert.equal(admittedDecision.status, 200, JSON.stringify(admittedDecision.body));
    const admittedReply = await api(live.base, "POST", "/agent-api/message/send", admittedAgentHeaders, {
      target: `#${admittedChannel!.name}`,
      content: "admitted work completed despite topology expansion",
      replyTo: admittedMessage!.id,
    });
    assert.equal(admittedReply.status, 200, JSON.stringify(admittedReply.body));
  } finally {
    secondaryDaemonSocket?.close();
    daemonSocket?.close();
    daemonSocket = null;
    if (serverProcess?.pid) {
      serverProcess.kill("SIGTERM");
      await new Promise((resolve) => serverProcess?.once("exit", resolve));
      serverProcess = null;
    }
    await cleanup();
  }
});
