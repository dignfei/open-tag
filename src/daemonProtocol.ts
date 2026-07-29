// Shared daemon ↔ server WebSocket control-plane protocol constants. Imported by BOTH src/server/ws.ts and
// src/daemon/connection.ts so the two planes can never drift on the wire contract. See ARCHITECTURE.md
// "Control plane is always the backbone".

// WS close code (RFC 6455 §7.4.2 private range 4000–4999) the server sends when it cannot authenticate or
// identify a machine: an unknown key, or a key whose machine row was deleted or rotated via …/reconnect.
// This is a permanent rejection, not a transient drop — retrying the same key can never succeed — so the
// daemon backs off to its cap and surfaces an actionable error instead of reconnecting once a second forever.
export const MACHINE_REJECTED_CODE = 4001;

// A daemon advertising this in its ready frame uses the two-phase ready/admitted barrier: the server
// durably opens the recipient inbox before the daemon writes the Turn notification into the runtime.
export const DELIVERY_ADMISSION_CAPABILITY = "delivery-admission-v2";

// A daemon advertising this capability acknowledges agent lifecycle RPCs only after the requested
// start/stop/reset operation has settled. Servers use it to avoid reporting a successful reset while
// workspace cleanup is still running on an older fire-and-forget daemon.
export const AGENT_CONTROL_ACK_CAPABILITY = "agent-control-ack-v1";
/** Daemon can canonicalize a machine-local project directory and separate runtime cwd from agent state. */
export const PROJECT_DIRECTORY_CAPABILITY = "project-directory-v2";
/** Daemon can expose an allowlisted, metadata-only project directory picker over machine-targeted RPC. */
export const PROJECT_BROWSER_CAPABILITY = "project-browser-v1";
