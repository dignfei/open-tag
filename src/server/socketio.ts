// Human-facing realtime over socket.io.
// Auth: the client handshake auth carries { token, serverId }; the server verifies the JWT +
// checks server membership → joins room server:<serverId> → emits "rooms:joined".
// Events: the server fans out named events like 42["message:new",payload] (see emitMapped).
import { Server as IOServer, type Socket } from "socket.io";
import type { Server } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { verifyUser } from "./auth.js";
import { canUserReadChannel } from "./channelAccess.js";
import { createLogger } from "../log.js";

const log = createLogger("server:io");
let io: IOServer | null = null;

/** Mirror the HTTP CORS whitelist for socket.io handshake/polling requests.
 *  ALLOWED_ORIGIN (comma-separated) gates which browser origins may connect.
 *  Dev fallback (unset): any localhost / 127.0.0.1 origin is allowed. */
function socketIoCorsOrigin(): string | ((origin: string | undefined, cb: (err: Error | null, ok: boolean) => void) => void) {
  const v = process.env.ALLOWED_ORIGIN?.trim();
  if (v) {
    const origins = new Set(v.split(",").map(s => s.trim()).filter(Boolean));
    return (origin, cb) => cb(null, !origin || origins.has(origin));
  }
  // Dev mode: allow localhost / 127.0.0.1 (any port) or no origin (same-origin, postman)
  return (origin, cb) => {
    const ok = !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    cb(ok ? null : new Error("CORS: origin not allowed"), ok);
  };
}

export function attachSocketIO(server: Server): void {
  io = new IOServer(server, { cors: { origin: socketIoCorsOrigin() }, path: "/socket.io/" });
  io.on("connection", async (socket: Socket) => {
    const auth = (socket.handshake.auth || {}) as { token?: string; serverId?: string };
    const uid = verifyUser(auth.token ?? null);
    const serverId = auth.serverId;
    if (!uid || !serverId) { socket.disconnect(true); return; }
    const mem = (await db.select().from(schema.serverMembers)
      .where(and(eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, uid))))[0];
    if (!mem) { socket.disconnect(true); return; }
    socket.data.uid = uid; socket.data.serverId = serverId;
    socket.join(`server:${serverId}`);
    // Channel isolation: join the channel:<id> room for every channel this user belongs to → content-bearing events only reach members, so private channels are not leaked to non-members
    const myChans = await db.select({ channelId: schema.channelMembers.channelId }).from(schema.channelMembers)
      .where(and(eq(schema.channelMembers.memberType, "user"), eq(schema.channelMembers.memberId, uid)));
    for (const c of myChans) socket.join(`channel:${c.channelId}`);
    socket.emit("rooms:joined");
    log.debug("socket connected", { uid, serverId, channels: myChans.length });
    // Mid-session join: client emits join:channel when it opens a channel/thread → server joins the room IFF the
    // user can read it (member / public channel / thread of a readable channel), so realtime tracks what you view.
    socket.on("join:channel", async (channelId: string) => {
      if (!channelId || typeof channelId !== "string") return;
      try {
        if (await canReadChannel(uid, serverId, channelId)) await socket.join(`channel:${channelId}`);
      } catch (error) {
        log.warn("realtime room authorization failed; join withheld", { uid, serverId, channelId, error: String(error) });
      }
    });
    socket.on("leave:channel", (channelId: string) => { if (typeof channelId === "string") socket.leave(`channel:${channelId}`); });
    socket.on("disconnect", (reason) => log.debug("socket disconnected", { uid, reason }));
  });
  log.info("socket.io attached", { path: "/socket.io/" });
}

// Reuse the REST read boundary so room joins and event-time revalidation cannot drift.
async function canReadChannel(uid: string, serverId: string, channelId: string): Promise<boolean> {
  return canUserReadChannel(serverId, channelId, uid);
}

async function emitAuthorizedChannel(
  srv: IOServer,
  serverId: string,
  channelId: string,
  emissions: Array<[eventName: string, payload: unknown]>,
  candidateChannelIds = [channelId],
  includeServerCandidates = false,
): Promise<void> {
  const roomNames = [...new Set(candidateChannelIds)].map((id) => `channel:${id}`);
  const sockets = new Map<string, Awaited<ReturnType<typeof srv.fetchSockets>>[number]>();
  for (const roomName of roomNames) {
    try {
      for (const socket of await srv.in(roomName).fetchSockets()) sockets.set(socket.id, socket);
    } catch (error) {
      log.warn("realtime room lookup failed; event withheld", { serverId, channelId, roomName, error: String(error) });
    }
  }
  if (includeServerCandidates) {
    try {
      for (const socket of await srv.in(`server:${serverId}`).fetchSockets()) sockets.set(socket.id, socket);
    } catch (error) {
      log.warn("realtime server-room lookup failed; event withheld", { serverId, channelId, error: String(error) });
    }
  }
  await Promise.all([...sockets.values()].map(async (socket) => {
    const uid = typeof socket.data.uid === "string" ? socket.data.uid : "";
    let allowed = false;
    try {
      allowed = !!uid && socket.data.serverId === serverId && await canReadChannel(uid, serverId, channelId);
    } catch (error) {
      log.warn("realtime channel authorization failed; event withheld", { serverId, channelId, uid, error: String(error) });
    }
    if (!allowed) {
      await Promise.all(roomNames.map(async (roomName) => {
        try { await socket.leave(roomName); }
        catch (error) { log.warn("stale realtime room eviction failed", { serverId, channelId, uid, roomName, error: String(error) }); }
      }));
      return;
    }
    try { for (const [eventName, payload] of emissions) socket.emit(eventName, payload); }
    catch (error) { log.warn("realtime channel emit failed", { serverId, channelId, uid, error: String(error) }); }
  }));
}

// Internal event object → named realtime events. Content-bearing events (message/task) only fan out to channel:<channelId> rooms (members only),
// preventing private channel content from leaking to non-members; metadata / server-level events (agent/machine/thread:updated) fan out to server:<serverId>.
export async function emitMapped(serverId: string, event: any): Promise<void> {
  if (!io) return;
  const srv = io;                                                           // capture non-null (io is not narrowed inside the closure)
  const room = srv.to(`server:${serverId}`);                                // server-level (all members)
  switch (event?.type) {
    case "message": await emitAuthorizedChannel(srv, serverId, event.message.channelId, [["message:new", event.message]]); break;
    case "task": {
      if (event.op === "deleted") { await emitAuthorizedChannel(srv, serverId, event.channelId, [["task:deleted", { channelId: event.channelId, taskId: event.taskId }]]); break; }
      const t = event.task; // = serializeMsg(message), includes channelId
      const taskEvent: [string, unknown] = event.op === "created"
        ? ["task:created", { channelId: t.channelId, tasks: [t] }]
        : ["task:updated", { channelId: t.channelId, task: t }];
      await emitAuthorizedChannel(srv, serverId, t.channelId, [taskEvent, ["message:updated", t]]);
      break;
    }
    // Workspace status remains visible, but channel-derived detail and trajectories follow channel access.
    case "agent": room.emit("agent:activity", { agentId: event.id, name: event.name, status: event.status, activity: event.activity, detail: event.channelId ? "" : (event.detail ?? "") }); break;
    case "trajectory": if (event.channelId) await emitAuthorizedChannel(srv, serverId, event.channelId, [["agent:activity", { agentId: event.agentId, name: event.name, entries: event.entries }]], [event.channelId], true); break;
    case "agent:reply": await emitAuthorizedChannel(srv, serverId, event.channelId, [["agent:reply", event]]); break;
    case "message:updated": await emitAuthorizedChannel(srv, serverId, event.message.channelId, [["message:updated", event.message]]); break;
    case "thread:updated": if (event.parentChannelId) await emitAuthorizedChannel(srv, serverId, event.parentChannelId, [["thread:updated", { threadChannelId: event.threadChannelId, parentMessageId: event.parentMessageId, parentChannelId: event.parentChannelId, replyCount: event.replyCount, senderId: event.senderId, senderType: event.senderType }]], [event.parentChannelId, event.threadChannelId]); break;
    case "agent:created": room.emit("agent:created", event.agent); break;
    case "agent:deleted": room.emit("agent:deleted", { id: event.id }); break;
    case "machine": room.emit("machine:status", { machineId: event.machineId, status: event.online ? "online" : "offline", online: event.online, hostname: event.hostname, runtimes: event.runtimes }); break; // machine status payload: machineId + status ("online"/"offline")
    default: if (event?.type) room.emit(String(event.type), event);
  }
}
