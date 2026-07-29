// Unit test for daemonHub's machine-connection dedup invariant: one machine == at most one daemon ws in
// the broadcast map. Without this, a reconnect/orphan/accidental 2nd daemon on the same machine makes
// broadcastToDaemons deliver agent:start/agent:deliver to BOTH ws → each daemon spawns its own agent
// instance → double replies + double token spend (root-caused against the cctest incident, 2026-07-02).
// Run: npx tsx --test test/daemonHub.unit.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_CONTROL_ACK_CAPABILITY, DELIVERY_ADMISSION_CAPABILITY, PROJECT_BROWSER_CAPABILITY, PROJECT_DIRECTORY_CAPABILITY, agentControlBlockReason, conversationTurnDeliveryBlockReason, projectDirectoryBlockReason, registerDaemon, registerDaemonCapabilities, unregisterDaemon, registerMachineConn, unregisterMachineConn, broadcastToDaemons, isMachineConnected, sendToMachine, requestDaemon, requestDaemonByMachine, resolveDaemonRequest } from "../src/server/daemonHub.js";

// Minimal fake ws: readyState=OPEN(1), counts sends + close.
function fakeWs(): any {
  return { readyState: 1, sends: 0, sent: [] as string[], closed: false, send(data: string) { this.sends++; this.sent.push(data); }, close() { this.closed = true; } };
}

test("same machine: 2nd ws evicts 1st from broadcast + closes it (no double delivery)", () => {
  const sid = "s-dedup-" + Math.random().toString(36).slice(2);
  const ws1 = fakeWs(), ws2 = fakeWs();
  registerDaemon(ws1, sid);
  registerDaemon(ws2, sid);            // both in the daemons map now
  registerMachineConn("m1", ws1);
  registerMachineConn("m1", ws2);      // ws2 takes over → ws1 must be evicted + closed
  broadcastToDaemons(sid, { type: "agent:deliver" });
  assert.equal(ws2.sends, 1, "new ws receives the broadcast exactly once");
  assert.equal(ws1.sends, 0, "evicted ws receives nothing");
  assert.equal(ws1.closed, true, "evicted ws is closed so its daemon tears down");
  unregisterDaemon(ws2); unregisterMachineConn(ws2);
});

test("single ws: broadcast delivered once (regression guard)", () => {
  const sid = "s-single-" + Math.random().toString(36).slice(2);
  const ws = fakeWs();
  registerDaemon(ws, sid);
  registerMachineConn("m1", ws);
  broadcastToDaemons(sid, { type: "agent:deliver" });
  assert.equal(ws.sends, 1);
  unregisterDaemon(ws); unregisterMachineConn(ws);
});

test("multi-tenant: broadcast does not cross servers", () => {
  const a = "s-A-" + Math.random().toString(36).slice(2), b = "s-B-" + Math.random().toString(36).slice(2);
  const wsA = fakeWs(), wsB = fakeWs();
  registerDaemon(wsA, a); registerDaemon(wsB, b);
  registerMachineConn("mA", wsA); registerMachineConn("mB", wsB);
  broadcastToDaemons(a, { type: "x" });
  assert.equal(wsA.sends, 1);
  assert.equal(wsB.sends, 0, "server B's daemon must not receive server A's broadcast");
  unregisterDaemon(wsA); unregisterMachineConn(wsA);
  unregisterDaemon(wsB); unregisterMachineConn(wsB);
});

test("machine-targeted send only reaches the selected connected machine", () => {
  const sid = "s-target-" + Math.random().toString(36).slice(2);
  const wsA = fakeWs(), wsB = fakeWs();
  registerDaemon(wsA, sid); registerDaemon(wsB, sid);
  registerMachineConn("m-target-a", wsA); registerMachineConn("m-target-b", wsB);

  assert.equal(isMachineConnected("m-target-a"), true);
  assert.equal(sendToMachine("m-target-a", { type: "agent:start", agentId: "a1" }), true);
  assert.equal(wsA.sends, 1);
  assert.equal(wsB.sends, 0, "non-target machine must not receive targeted start");
  assert.match(wsA.sent[0]!, /"agentId":"a1"/);

  unregisterMachineConn(wsA);
  assert.equal(isMachineConnected("m-target-a"), false);
  assert.equal(sendToMachine("m-target-a", { type: "agent:start", agentId: "a1" }), false);

  unregisterDaemon(wsA);
  unregisterDaemon(wsB); unregisterMachineConn(wsB);
});

test("bound durable delivery requires capability and an old daemon receives zero Turn frames", () => {
  const sid = "s-cap-bound-" + Math.random().toString(36).slice(2);
  const oldWs = fakeWs();
  registerDaemon(oldWs, sid);
  registerDaemonCapabilities(oldWs, ["agent:deliver"]);
  registerMachineConn("m-cap-old", oldWs);

  const reason = conversationTurnDeliveryBlockReason(sid, "m-cap-old");
  assert.match(reason ?? "", /delivery-admission-v2/);
  if (!reason) sendToMachine("m-cap-old", { type: "agent:deliver", turnId: "should-not-send" });
  assert.equal(oldWs.sends, 0, "the gate runs before agent:start or agent:deliver");

  registerDaemonCapabilities(oldWs, ["agent:deliver", DELIVERY_ADMISSION_CAPABILITY]);
  assert.equal(conversationTurnDeliveryBlockReason(sid, "m-cap-old"), null);
  unregisterDaemon(oldWs); unregisterMachineConn(oldWs);
});

test("unbound durable delivery requires exactly one capable daemon", () => {
  const sid = "s-cap-unbound-" + Math.random().toString(36).slice(2);
  assert.match(conversationTurnDeliveryBlockReason(sid, null) ?? "", /exactly one daemon \(found 0\)/);

  const ws1 = fakeWs();
  registerDaemon(ws1, sid); registerDaemonCapabilities(ws1, []);
  assert.match(conversationTurnDeliveryBlockReason(sid, null) ?? "", /delivery-admission-v2/);
  registerDaemonCapabilities(ws1, [DELIVERY_ADMISSION_CAPABILITY]);
  assert.equal(conversationTurnDeliveryBlockReason(sid, null), null);

  const ws2 = fakeWs();
  registerDaemon(ws2, sid); registerDaemonCapabilities(ws2, [DELIVERY_ADMISSION_CAPABILITY]);
  assert.match(conversationTurnDeliveryBlockReason(sid, null) ?? "", /exactly one daemon \(found 2\)/);
  unregisterDaemon(ws1); unregisterDaemon(ws2);
});

test("replaced machine connection cannot retain or erase the current capability state", () => {
  const sid = "s-cap-replace-" + Math.random().toString(36).slice(2);
  const oldWs = fakeWs(), currentWs = fakeWs();
  registerDaemon(oldWs, sid); registerDaemonCapabilities(oldWs, [DELIVERY_ADMISSION_CAPABILITY]); registerMachineConn("m-cap-replace", oldWs);
  registerDaemon(currentWs, sid); registerDaemonCapabilities(currentWs, []); registerMachineConn("m-cap-replace", currentWs);
  assert.equal(oldWs.closed, true);
  assert.match(conversationTurnDeliveryBlockReason(sid, "m-cap-replace") ?? "", /delivery-admission-v2/, "replacement uses only the current connection's capabilities");

  unregisterDaemon(oldWs); unregisterMachineConn(oldWs);
  assert.match(conversationTurnDeliveryBlockReason(sid, "m-cap-replace") ?? "", /delivery-admission-v2/, "stale close cleanup must not remove the current connection");
  registerDaemonCapabilities(currentWs, [DELIVERY_ADMISSION_CAPABILITY]);
  assert.equal(conversationTurnDeliveryBlockReason(sid, "m-cap-replace"), null);
  unregisterDaemon(currentWs); unregisterMachineConn(currentWs);
  assert.equal(isMachineConnected("m-cap-replace"), false);
});

test("agent control requires completion ACK capability before sending lifecycle RPCs", () => {
  const sid = "s-control-cap-" + Math.random().toString(36).slice(2);
  const ws = fakeWs();
  registerDaemon(ws, sid);
  registerMachineConn("m-control-cap", ws);
  registerDaemonCapabilities(ws, ["agent:reset"]);
  assert.match(agentControlBlockReason(sid, "m-control-cap") ?? "", /agent-control-ack-v1/);

  registerDaemonCapabilities(ws, ["agent:reset", AGENT_CONTROL_ACK_CAPABILITY]);
  assert.equal(agentControlBlockReason(sid, "m-control-cap"), null);
  unregisterDaemon(ws); unregisterMachineConn(ws);
});

test("project-bound starts require an explicitly capable current daemon", () => {
  const sid = "s-project-cap-" + Math.random().toString(36).slice(2);
  const ws = fakeWs();
  registerDaemon(ws, sid);
  registerMachineConn("m-project-cap", ws);
  registerDaemonCapabilities(ws, [AGENT_CONTROL_ACK_CAPABILITY]);
  assert.match(projectDirectoryBlockReason(sid, "m-project-cap") ?? "", /project-directory-v2/);
  registerDaemonCapabilities(ws, [AGENT_CONTROL_ACK_CAPABILITY, PROJECT_DIRECTORY_CAPABILITY]);
  assert.equal(projectDirectoryBlockReason(sid, "m-project-cap"), null);
  assert.match(projectDirectoryBlockReason(sid, null) ?? "", /machine-bound/);
  unregisterDaemon(ws); unregisterMachineConn(ws);
});

test("project browsing requires the separate browser capability", async () => {
  const sid = "s-browser-cap-" + Math.random().toString(36).slice(2);
  const ws = fakeWs();
  registerDaemon(ws, sid); registerMachineConn("m-browser-cap", ws);
  registerDaemonCapabilities(ws, [PROJECT_DIRECTORY_CAPABILITY]);
  const response = await requestDaemonByMachine("m-browser-cap", { type: "project:browse" }, 100, {
    serverId: sid, capabilities: [PROJECT_BROWSER_CAPABILITY], responseTypes: ["project:directories"],
  });
  assert.match(response.error, /project-browser-v1/);
  assert.equal(ws.sends, 0, "an old daemon receives no directory metadata request");
  unregisterDaemon(ws); unregisterMachineConn(ws);
});

test("capability requirements are checked on the exact replacement connection that receives a frame", async () => {
  const sid = "s-project-send-cap-" + Math.random().toString(36).slice(2);
  const capable = fakeWs(), replacement = fakeWs();
  registerDaemon(capable, sid); registerMachineConn("m-project-send-cap", capable);
  registerDaemonCapabilities(capable, [AGENT_CONTROL_ACK_CAPABILITY, PROJECT_DIRECTORY_CAPABILITY]);
  assert.equal(projectDirectoryBlockReason(sid, "m-project-send-cap"), null, "initial preflight sees capable daemon");

  registerDaemon(replacement, sid); registerMachineConn("m-project-send-cap", replacement);
  registerDaemonCapabilities(replacement, [AGENT_CONTROL_ACK_CAPABILITY]);
  assert.equal(sendToMachine("m-project-send-cap", { type: "agent:start" }, {
    serverId: sid, capabilities: [PROJECT_DIRECTORY_CAPABILITY],
  }), false);
  assert.equal(replacement.sends, 0, "replacement daemon receives no project-bound start without the capability");
  const response = await requestDaemonByMachine("m-project-send-cap", { type: "agent:start" }, 100, {
    serverId: sid, capabilities: [AGENT_CONTROL_ACK_CAPABILITY, PROJECT_DIRECTORY_CAPABILITY],
  });
  assert.match(response.error, /project-directory-v2/);
  assert.equal(replacement.sends, 0);

  unregisterDaemon(capable); unregisterMachineConn(capable);
  unregisterDaemon(replacement); unregisterMachineConn(replacement);
});

test("single-daemon lifecycle RPC remains pending until completion ACK and fails immediately on NACK", async () => {
  const sid = "s-control-rpc-" + Math.random().toString(36).slice(2);
  const ws = fakeWs();
  registerDaemon(ws, sid); registerMachineConn("m-control-rpc", ws);

  let settled = false;
  const reset = requestDaemon(sid, { type: "agent:reset", agentId: "a-control" }, 5_000, true).then((value) => { settled = true; return value; });
  const resetRequestId = sentRequestId(ws);
  await Promise.resolve();
  assert.equal(settled, false, "websocket send alone must not count as reset completion");
  resolveDaemonRequest(resetRequestId, { type: "rpc:ack", requestId: resetRequestId });
  assert.equal((await reset).type, "rpc:ack");

  ws.sent.length = 0;
  const failed = requestDaemon(sid, { type: "agent:reset", agentId: "a-control" }, 5_000, true);
  const failedRequestId = sentRequestId(ws);
  resolveDaemonRequest(failedRequestId, { type: "rpc:nack", requestId: failedRequestId, error: "workspace wipe failed" });
  assert.match((await failed).error, /workspace wipe failed/);
  unregisterDaemon(ws); unregisterMachineConn(ws);
});

// ── rpc:nack semantics (tech-debt I88): a NACK from an outdated daemon must not win a broadcast race
// against a daemon that actually supports the RPC — it only upgrades the timeout error; a directed
// (single-target) NACK resolves immediately since no other responder exists. ──
const sentRequestId = (ws: any) => JSON.parse(ws.sent[0]!).requestId as string;

test("rpc:nack on a broadcast is held and upgrades the timeout error", async () => {
  const sid = "s-nack-" + Math.random().toString(36).slice(2);
  const ws = fakeWs();
  registerDaemon(ws, sid); registerMachineConn("m-nack-a", ws);
  const p = requestDaemon(sid, { type: "agent:workspace:write" }, 80);
  const rid = sentRequestId(ws);
  resolveDaemonRequest(rid, { type: "rpc:nack", requestId: rid, error: 'daemon 0.9.0 does not support "agent:workspace:write"' });
  const r = await p;
  assert.match(r.error, /does not support/, "timeout resolves with the NACK reason, not the generic timeout");
  unregisterDaemon(ws); unregisterMachineConn(ws);
});

test("rpc:nack on a broadcast: a real response arriving later still wins", async () => {
  const sid = "s-nack-" + Math.random().toString(36).slice(2);
  const ws = fakeWs();
  registerDaemon(ws, sid); registerMachineConn("m-nack-b", ws);
  const p = requestDaemon(sid, { type: "agent:workspace:read" }, 200);
  const rid = sentRequestId(ws);
  resolveDaemonRequest(rid, { type: "rpc:nack", requestId: rid, error: "too old" });
  resolveDaemonRequest(rid, { type: "workspace:file_content", requestId: rid, content: "hello" });
  const r = await p;
  assert.equal(r.content, "hello");
  assert.equal(r.error, undefined);
  unregisterDaemon(ws); unregisterMachineConn(ws);
});

test("rpc:nack on a directed (by-machine) request resolves immediately", async () => {
  const ws = fakeWs();
  registerMachineConn("m-nack-c", ws);
  const t0 = Date.now();
  const p = requestDaemonByMachine("m-nack-c", { type: "agent:workspace:write" }, 5000);
  const rid = sentRequestId(ws);
  resolveDaemonRequest(rid, { type: "rpc:nack", requestId: rid, error: "daemon dev does not support it" }, ws);
  const r = await p;
  assert.match(r.error, /does not support/);
  assert.ok(Date.now() - t0 < 1000, "did not wait out the 5s timeout");
  unregisterMachineConn(ws);
});

test("machine-targeted directory RPC ignores forged and mismatched responses", async () => {
  const sid = "s-browser-rpc-" + Math.random().toString(36).slice(2);
  const target = fakeWs(), attacker = fakeWs();
  registerDaemon(target, sid); registerDaemonCapabilities(target, [PROJECT_BROWSER_CAPABILITY]); registerMachineConn("m-browser-target", target);
  registerDaemon(attacker, sid); registerDaemonCapabilities(attacker, [PROJECT_BROWSER_CAPABILITY]); registerMachineConn("m-browser-attacker", attacker);

  let settled = false;
  const response = requestDaemonByMachine("m-browser-target", { type: "project:browse" }, 5_000, {
    serverId: sid, capabilities: [PROJECT_BROWSER_CAPABILITY], responseTypes: ["project:directories"],
  }).then((value) => { settled = true; return value; });
  const rid = sentRequestId(target);
  resolveDaemonRequest(rid, { type: "project:directories", requestId: rid, mode: "roots", roots: [] }, attacker);
  await Promise.resolve();
  assert.equal(settled, false, "a second authenticated daemon cannot resolve the target machine RPC");
  resolveDaemonRequest(rid, { type: "models", requestId: rid, models: ["forged"] }, target);
  await Promise.resolve();
  assert.equal(settled, false, "the target daemon cannot resolve a request with the wrong response type");
  resolveDaemonRequest(rid, { type: "project:directories", requestId: rid, mode: "roots", roots: [], nextCursor: null, truncated: false }, target);
  assert.equal((await response).type, "project:directories");

  unregisterDaemon(target); unregisterMachineConn(target);
  unregisterDaemon(attacker); unregisterMachineConn(attacker);
});
