// Connected local daemons (WS) → the serverId each one belongs to. core uses this to broadcast agent:start/deliver only to the daemons of that server.
// Each daemon connection is bound to one serverId by its machine key (/daemon/connect?key=); the server routes by connection and the daemon side just executes.
// (Connection contract verified stable across daemon versions.)
// Key to multi-tenant isolation: one machine connecting to multiple servers = multiple keys + multiple daemon processes; the server isolates by serverId so they never cross.
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { AGENT_CONTROL_ACK_CAPABILITY, DELIVERY_ADMISSION_CAPABILITY, PROJECT_BROWSER_CAPABILITY, PROJECT_DIRECTORY_CAPABILITY } from "../daemonProtocol.js";

export { AGENT_CONTROL_ACK_CAPABILITY, DELIVERY_ADMISSION_CAPABILITY, PROJECT_BROWSER_CAPABILITY, PROJECT_DIRECTORY_CAPABILITY } from "../daemonProtocol.js";

const daemons = new Map<WebSocket, string>(); // ws → the serverId this connection belongs to (registered by ws.ts after resolving the key)
const machineConns = new Map<string, WebSocket>(); // machineId → ws, so a request can target ONE specific machine's daemon (not a serverId-wide broadcast)
const daemonCapabilities = new Map<WebSocket, ReadonlySet<string>>();

export function registerDaemon(ws: WebSocket, serverId: string): void { daemons.set(ws, serverId); }
export function unregisterDaemon(ws: WebSocket): void { daemons.delete(ws); daemonCapabilities.delete(ws); }
export function registerDaemonCapabilities(ws: WebSocket, capabilities: unknown): void {
  const values = Array.isArray(capabilities) ? capabilities.filter((value): value is string => typeof value === "string") : [];
  daemonCapabilities.set(ws, new Set(values));
}
export function registerMachineConn(machineId: string, ws: WebSocket): void {
  const prev = machineConns.get(machineId);
  if (prev && prev !== ws) {
    // Same machine, new connection (reconnect / orphan / accidental 2nd daemon): evict the previous ws
    // from the broadcast map and close it. Without this, broadcastToDaemons delivers agent:start / agent:deliver
    // to BOTH ws → each daemon spawns its own agent instance → double replies + double token spend.
    daemons.delete(prev);
    daemonCapabilities.delete(prev);
    try { if (prev.readyState === 1) prev.close(); } catch { /* */ }
  }
  machineConns.set(machineId, ws);
}
export function unregisterMachineConn(ws: WebSocket): void { for (const [mid, w] of machineConns) if (w === ws) machineConns.delete(mid); }
export function isCurrentMachineConn(machineId: string, ws: WebSocket): boolean { return machineConns.get(machineId) === ws; }
export function isMachineConnected(machineId: string): boolean {
  const ws = machineConns.get(machineId);
  return !!ws && ws.readyState === 1;
}
export function daemonCount(serverId: string): number {
  let n = 0; for (const sid of daemons.values()) if (sid === serverId) n++; return n;
}

/**
 * Durable Turn delivery is safe only when the receiving daemon explicitly advertises that an
 * ACK means runtime admission. This gate is intentionally separate from lifecycle and legacy
 * message routing so a mixed-version rollout cannot silently weaken the new delivery contract.
 */
export function conversationTurnDeliveryBlockReason(serverId: string, machineId: string | null): string | null {
  if (machineId) {
    const ws = machineConns.get(machineId);
    if (!ws || ws.readyState !== 1 || daemons.get(ws) !== serverId) return "machine offline";
    if (!daemonCapabilities.get(ws)?.has(DELIVERY_ADMISSION_CAPABILITY)) {
      return `daemon missing capability: ${DELIVERY_ADMISSION_CAPABILITY}`;
    }
    return null;
  }

  const connected = [...daemons].filter(([ws, sid]) => sid === serverId && ws.readyState === 1).map(([ws]) => ws);
  if (connected.length !== 1) return `unbound durable delivery requires exactly one daemon (found ${connected.length})`;
  if (!daemonCapabilities.get(connected[0]!)?.has(DELIVERY_ADMISSION_CAPABILITY)) {
    return `daemon missing capability: ${DELIVERY_ADMISSION_CAPABILITY}`;
  }
  return null;
}

export function agentControlBlockReason(serverId: string, machineId: string | null): string | null {
  if (machineId) {
    const ws = machineConns.get(machineId);
    if (!ws || ws.readyState !== 1 || daemons.get(ws) !== serverId) return "machine offline";
    if (!daemonCapabilities.get(ws)?.has(AGENT_CONTROL_ACK_CAPABILITY)) {
      return `daemon missing capability: ${AGENT_CONTROL_ACK_CAPABILITY}`;
    }
    return null;
  }

  const connected = [...daemons].filter(([ws, sid]) => sid === serverId && ws.readyState === 1).map(([ws]) => ws);
  if (connected.length !== 1) return `unbound agent control requires exactly one daemon (found ${connected.length})`;
  if (!daemonCapabilities.get(connected[0]!)?.has(AGENT_CONTROL_ACK_CAPABILITY)) {
    return `daemon missing capability: ${AGENT_CONTROL_ACK_CAPABILITY}`;
  }
  return null;
}

/** Project-bound starts must fail closed: old daemons ignore the extra config field but still ACK start. */
export function projectDirectoryBlockReason(serverId: string, machineId: string | null): string | null {
  if (!machineId) return "project directory requires a machine-bound agent";
  const ws = machineConns.get(machineId);
  if (!ws || ws.readyState !== 1 || daemons.get(ws) !== serverId) return "machine offline";
  if (!daemonCapabilities.get(ws)?.has(PROJECT_DIRECTORY_CAPABILITY)) return `daemon missing capability: ${PROJECT_DIRECTORY_CAPABILITY}`;
  return null;
}

export function broadcastToDaemons(serverId: string, msg: unknown): void {
  const data = JSON.stringify(msg);
  for (const [ws, sid] of daemons) {
    if (sid !== serverId) continue; // multi-tenant isolation: only send to this server's daemons, never cross to another server
    try { if (ws.readyState === 1) ws.send(data); } catch { /* ignore */ }
  }
}

type MachineSendRequirements = { serverId: string; capabilities?: readonly string[]; responseTypes?: readonly string[] };

function machineConnectionBlockReason(ws: WebSocket, requirements: MachineSendRequirements): string | null {
  if (daemons.get(ws) !== requirements.serverId) return "machine is connected to a different server";
  const capabilities = daemonCapabilities.get(ws);
  for (const capability of requirements.capabilities ?? []) {
    if (!capabilities?.has(capability)) return `daemon missing capability: ${capability}`;
  }
  return null;
}

export function sendToMachine(machineId: string, msg: unknown, requirements?: MachineSendRequirements): boolean {
  const ws = machineConns.get(machineId);
  if (!ws || ws.readyState !== 1) return false;
  // Validate and send against the same connection without yielding. A reconnect cannot swap an old
  // daemon in between the capability check and this send on the single-threaded event loop.
  if (requirements && machineConnectionBlockReason(ws, requirements)) return false;
  try { ws.send(JSON.stringify(msg)); return true; }
  catch { return false; }
}

// ── WS-RPC: send a request to this server's daemon and await the response carrying the same requestId (file tree/file content, etc.) ──
const pending = new Map<string, { resolve: (v: any) => void; timer: ReturnType<typeof setTimeout>; single?: boolean; nack?: { error?: string }; sourceWs?: WebSocket; responseTypes?: ReadonlySet<string> }>();
export function requestDaemon(serverId: string, msg: Record<string, unknown>, timeoutMs = 6000, singleResponse = false): Promise<any> {
  if (daemonCount(serverId) === 0) return Promise.resolve({ error: "no daemon online" });
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { const p = pending.get(requestId); pending.delete(requestId); resolve({ error: p?.nack?.error ?? "daemon timeout" }); }, timeoutMs);
    pending.set(requestId, { resolve, timer, single: singleResponse });
    broadcastToDaemons(serverId, { ...msg, requestId }); // if several machines on the same server receive it, resolveDaemonRequest keeps the first to arrive by requestId
  });
}
export function resolveDaemonRequest(requestId: string, data: unknown, sourceWs?: WebSocket): void {
  const p = pending.get(requestId);
  if (!p) return;
  // Machine-targeted requests are bound to the exact connection that received the frame. In
  // particular, directory metadata must not be forgeable by a second authenticated daemon.
  if (p.sourceWs && sourceWs !== p.sourceWs) return;
  const responseType = typeof (data as any)?.type === "string" ? (data as any).type as string : "";
  if (responseType !== "rpc:nack" && p.responseTypes && !p.responseTypes.has(responseType)) return;
  // rpc:nack = "this daemon predates the RPC type" (version skew, tech-debt I88). On a broadcast a newer
  // daemon may still answer properly, so don't let the NACK win the race — stash it and let the timeout
  // resolve with its reason instead of a generic "daemon timeout". Single-target requests have exactly one
  // possible responder, so a NACK there resolves immediately.
  if ((data as any)?.type === "rpc:nack" && !p.single) { p.nack = data as { error?: string }; return; }
  clearTimeout(p.timer); pending.delete(requestId); p.resolve(data);
}

// Like requestDaemon, but targets ONE machine's daemon (no broadcast) — used when a request is about a
// specific machine (e.g. probing that machine's installed-runtime models). Reuses the same pending-by-
// requestId machinery + resolveDaemonRequest. Resolves {error} if that machine's daemon isn't connected.
export function requestDaemonByMachine(machineId: string, msg: Record<string, unknown>, timeoutMs = 6000, requirements?: MachineSendRequirements): Promise<any> {
  const ws = machineConns.get(machineId);
  if (!ws || ws.readyState !== 1) return Promise.resolve({ error: "machine offline" });
  const blocked = requirements ? machineConnectionBlockReason(ws, requirements) : null;
  if (blocked) return Promise.resolve({ error: blocked });
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pending.delete(requestId); resolve({ error: "daemon timeout" }); }, timeoutMs);
    pending.set(requestId, { resolve, timer, single: true, sourceWs: ws, responseTypes: requirements?.responseTypes ? new Set(requirements.responseTypes) : undefined });
    try { ws.send(JSON.stringify({ ...msg, requestId })); }
    catch { clearTimeout(timer); pending.delete(requestId); resolve({ error: "send failed" }); }
  });
}
