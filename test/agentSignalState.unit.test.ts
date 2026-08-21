import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const wsSrc = fs.readFileSync(new URL("../src/server/ws.ts", import.meta.url), "utf8");
const socketSrc = fs.readFileSync(new URL("../src/server/socketio.ts", import.meta.url), "utf8");
const coreSrc = fs.readFileSync(new URL("../src/server/core.ts", import.meta.url), "utf8");
const turnDispatchSrc = fs.readFileSync(new URL("../src/server/conversationTurnDispatch.ts", import.meta.url), "utf8");

test("agent activity detail retains its channel authorization context", () => {
  assert.match(
    wsSrc,
    /publish\(serverId!?, \{ type: "agent", id: a\.id, name: a\.name, status: a\.status, activity: a\.activity, channelId: msg\.channelId, detail: msg\.detail \?\? "" \}\)/,
    "daemon activity should retain its source channel for delivery authorization",
  );
  assert.match(
    socketSrc,
    /room\.emit\("agent:activity", \{ agentId: event\.id, name: event\.name, status: event\.status, activity: event\.activity, detail: event\.channelId \? "" : \(event\.detail \?\? ""\) \}\)/,
    "workspace activity should omit detail derived from a channel",
  );
  assert.match(
    socketSrc,
    /case "trajectory": if \(event\.channelId\) await emitAuthorizedChannel\(srv, serverId, event\.channelId/,
    "channel trajectories should use per-channel authorization",
  );
});

test("agent wake delivery handles machine send failure after preview start", () => {
  assert.match(
    turnDispatchSrc,
    /const startSent = deps\.sendAgentStart\(input\.serverId, target, input\.member\.id, Boolean\(input\.turnId\)\);/,
    "message wake should check whether agent:start was actually sent",
  );
  assert.match(
    turnDispatchSrc,
    /deliverSent = startSent && deps\.sendAgentDeliver\(input\.serverId, target, \{/,
    "message wake should only deliver after a successful start send",
  );
  assert.match(
    turnDispatchSrc,
    /if \(deliverSent\) \{[\s\S]*?return "delivered";[\s\S]*?op: "error",[\s\S]*?text: "machine offline",[\s\S]*?await deps\.markAgentUnavailable\(input\.serverId, input\.member\.id, "machine offline"\);[\s\S]*?return "retryable_failure";/,
    "send failure should mark the agent unavailable and close the preview instead of leaving a stuck thinking card",
  );
});

test("agent lifecycle control awaits bound-machine ACK and preserves unbound fallback", () => {
  assert.match(
    coreSrc,
    /async function agentControlTarget\(serverId: string, agentId: string\)/,
    "stop/reset/profile sync should resolve the agent's bound machine separately from start config",
  );
  assert.match(
    coreSrc,
    /async function requestAgentControl\(serverId: string, target: AgentControlTarget, msg: Record<string, unknown>\): Promise<AgentControlResult> \{[\s\S]*?requestDaemonByMachine\(target\.machineId, msg, 30_000, \{[\s\S]*?serverId,[\s\S]*?capabilities:[\s\S]*?requestDaemon\(serverId, msg, 30_000, true\)[\s\S]*?response\?\.type !== "rpc:ack"/,
    "settled lifecycle controls should await one bound machine or the legacy unbound broadcast RPC",
  );
  assert.match(
    coreSrc,
    /if \(!a\.machineId\) \{[\s\S]*?if \(daemonCount\(serverId\) === 0\) return \{ ok: false, reason: "no daemon online" \};[\s\S]*?return \{ ok: true, machineId: null \};[\s\S]*?\}/,
    "legacy unbound agents should remain controllable through the broadcast daemon fallback",
  );
  assert.match(
    coreSrc,
    /await requestAgentControl\(serverId, target, \{ type: "agent:stop", agentId \}\)/,
    "stop should await the bound machine daemon",
  );
  assert.match(
    coreSrc,
    /await requestAgentControl\(serverId, target, \{ type: "agent:reset", agentId, wipeWorkspace, clearMemory \}\)/,
    "reset should await the bound machine daemon",
  );
  assert.match(
    coreSrc,
    /sendAgentControl\(serverId, target, \{ type: "agent:profile", agentId, displayName, description: description \?\? null \}\)/,
    "profile sync should target the bound machine daemon",
  );
});
