// daemon control plane: WS /daemon/connect?key= (ServerToMachine / MachineToServer)
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { Server } from "node:http";
import { and, eq, isNull, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { BOOTSTRAP_KEY, hashToken, safeEqual } from "./auth.js";
import { conversationTurnDeliveryBlockReason, registerDaemon, registerDaemonCapabilities, unregisterDaemon, resolveDaemonRequest, registerMachineConn, unregisterMachineConn, isCurrentMachineConn } from "./daemonHub.js";
import { publish } from "./realtime.js";
import { createLogger } from "../log.js";
import { MACHINE_REJECTED_CODE } from "../daemonProtocol.js";
import { catchUpAgentsOnMachine } from "./reconnectCatchup.js";
import { markMachineAgentsOffline } from "./machineLiveness.js";
import { ACTIVITY_LOG_CAP, logActivity, pruneAgentActivityLog, startAgentActivityRun } from "./agentActivity.js";
import { finalizeAgentActivityRun } from "./core.js";
import { acceptAgentDeliveryAck, hasPendingAgentDelivery, noteAgentDeliveryPending, rejectAgentDeliveryAck } from "./agentDeliveryAck.js";
import { commitAgentDeliveryAdmission, ownsAgentDeliveryAdmission, releaseAgentDeliveryAdmission, type CommittedAgentDelivery } from "./agentDeliveryAdmission.js";
import { createWsFrameGate } from "./wsFrameGate.js";
import { handleConversationTurnDaemonTopologyChange, resumeConversationTurnsForMachine } from "./conversationTurnRecovery.js";

export { ACTIVITY_LOG_CAP, logActivity, pruneAgentActivityLog } from "./agentActivity.js";

const log = createLogger("server:ws");

export function attachWs(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "", "http://localhost");
    if (url.pathname !== "/daemon/connect") return; // pass through: /socket.io/ etc. are handled by socket.io's own upgrade handler
    const key = url.searchParams.get("key");
    if (!key) { socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => void onDaemon(ws, key));
  });
}

async function onDaemon(ws: WebSocket, key: string): Promise<void> {
  let serverId: string | null = null;
  let machineId: string | null = null;
  const frames = createWsFrameGate<RawData>();
  const committedDeliveries = new Map<string, CommittedAgentDelivery>();
  ws.on("message", (data) => frames.dispatch(data));
  if (safeEqual(key, BOOTSTRAP_KEY)) {
    serverId = (await db.select().from(schema.servers).where(eq(schema.servers.slug, "open-tag")))[0]?.id ?? null;
  } else {
    serverId = (await db.select().from(schema.machines).where(eq(schema.machines.apiKeyHash, hashToken(key))))[0]?.serverId ?? null;
  }
  if (!serverId) {
    // A missing sk_machine_* row is a permanent rejection (key deleted or never existed) → signal the daemon
    // to stop hammering and tell its operator. A missing bootstrap server row is a not-yet-seeded race, so a
    // plain close lets the daemon retry on its normal backoff once seeding completes.
    if (!safeEqual(key, BOOTSTRAP_KEY)) ws.close(MACHINE_REJECTED_CODE, "unknown or removed machine key");
    else ws.close();
    return;
  }
  registerDaemon(ws, serverId); // register by serverId → broadcastToDaemons only reaches this server's daemons (multi-tenant isolation, routed by connection)
  log.info("daemon connected", { serverId });
  const ping = setInterval(() => { try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* */ } }, 30000);

  frames.open(async (data) => {
    let msg: any; try { msg = JSON.parse(data.toString()); } catch { return; }
    try {
      if (msg.type === "ready") {
        const runningIds: string[] = Array.isArray(msg.runningAgents) ? msg.runningAgents : [];
        machineId = await onReady(serverId!, key, msg);
        registerDaemonCapabilities(ws, msg.capabilities);
        const alreadyCurrent = isCurrentMachineConn(machineId, ws);
        registerMachineConn(machineId, ws);
        try { ws.send(JSON.stringify({ type: "ready:ack", machineId })); } catch { /* */ }
        // The machine connection must be indexed before catch-up sends agent:start/deliver to it.
        void (async () => {
          if (!alreadyCurrent && !conversationTurnDeliveryBlockReason(serverId!, machineId)) {
            await resumeConversationTurnsForMachine(serverId!, machineId, false);
          }
          await handleConversationTurnDaemonTopologyChange(serverId!);
          await catchUpAgentsOnMachine(serverId!, machineId, runningIds);
        })().catch((e: any) => log.error("catch-up failed", { machineId, detail: String(e?.message ?? e) }));
      }
      else if (msg.type === "agent:status" || msg.type === "agent:activity") await onAgentUpdate(serverId!, msg);
      else if (msg.type === "agent:deliver:pending") noteAgentDeliveryPending(typeof msg.deliveryId === "string" ? msg.deliveryId : undefined);
      else if (msg.type === "agent:deliver:ready") {
        const deliveryId = typeof msg.deliveryId === "string" ? msg.deliveryId : undefined;
        if (!hasPendingAgentDelivery(deliveryId)) {
          ws.send(JSON.stringify({ type: "agent:deliver:rejected", deliveryId, error: "delivery is not pending" }));
        } else {
          const existing = deliveryId ? committedDeliveries.get(deliveryId) : undefined;
          const reusable = existing
            && existing.agentId === msg.agentId
            && existing.seq === msg.seq
            && !!machineId
            && isCurrentMachineConn(machineId, ws)
            && await ownsAgentDeliveryAdmission(existing);
          if (reusable) {
            ws.send(JSON.stringify({ type: "agent:deliver:admitted", deliveryId: existing.deliveryId }));
          } else {
            if (existing) committedDeliveries.delete(existing.deliveryId);
            const result = await commitAgentDeliveryAdmission({ ws, serverId: serverId!, machineId, deliveryId, agentId: msg.agentId, seq: msg.seq });
            if (result.ok) {
              committedDeliveries.set(result.delivery.deliveryId, result.delivery);
              ws.send(JSON.stringify({ type: "agent:deliver:admitted", deliveryId: result.delivery.deliveryId }));
            } else {
              ws.send(JSON.stringify({ type: "agent:deliver:rejected", deliveryId, error: result.error }));
            }
          }
        }
      }
      else if (msg.type === "agent:deliver:ack") {
        const delivery = typeof msg.deliveryId === "string" ? committedDeliveries.get(msg.deliveryId) : undefined;
        if (delivery && delivery.agentId === msg.agentId && delivery.seq === msg.seq) {
          committedDeliveries.delete(delivery.deliveryId);
          acceptAgentDeliveryAck(delivery.deliveryId, delivery.agentId, delivery.seq);
        }
      }
      else if (msg.type === "agent:deliver:nack") {
        const delivery = typeof msg.deliveryId === "string" ? committedDeliveries.get(msg.deliveryId) : undefined;
        if (delivery && delivery.agentId === msg.agentId && delivery.seq === msg.seq) {
          committedDeliveries.delete(delivery.deliveryId);
          await releaseAgentDeliveryAdmission(delivery);
          rejectAgentDeliveryAck(delivery.deliveryId, delivery.agentId, delivery.seq, typeof msg.error === "string" ? msg.error : undefined);
        }
      }
      else if (msg.type === "agent:session" && msg.agentId) { await db.update(schema.agents).set({ sessionId: msg.sessionId }).where(eq(schema.agents.id, msg.agentId)); await publish(serverId!, { type: "agent:session", agentId: msg.agentId, sessionId: msg.sessionId }); } // forward to the frontend
      else if (msg.type === "agent:trajectory" && msg.agentId) {
        const a = (await db.select().from(schema.agents).where(eq(schema.agents.id, msg.agentId)))[0];
        await publish(serverId!, { type: "trajectory", agentId: msg.agentId, channelId: msg.channelId, name: a?.name, entries: msg.entries ?? [] });
        const entries = [];
        for (const e of msg.entries ?? []) {
          const item = await logActivity(serverId!, msg.agentId, e, { channelId: msg.channelId, streamId: msg.streamId, runSeq: e.runSeq });
          if (item) entries.push(item);
        }
        if (msg.channelId && msg.streamId && entries.length) await publish(serverId!, { type: "agent:reply", agentId: msg.agentId, channelId: msg.channelId, streamId: msg.streamId, name: a?.displayName ?? a?.name, op: "activity", entries });
      }
      else if (msg.type === "agent:reply" && msg.agentId && msg.channelId && msg.streamId) {
        const a = (await db.select().from(schema.agents).where(eq(schema.agents.id, msg.agentId)))[0];
        if (msg.op === "start") await startAgentActivityRun(serverId!, msg.agentId, msg.channelId, msg.streamId);
        if (msg.op === "done" || msg.op === "error") await finalizeAgentActivityRun(serverId!, msg.agentId, msg.channelId, msg.streamId, msg.name ?? a?.displayName ?? a?.name ?? "Agent", msg.op === "error" ? "error" : "handled");
        await publish(serverId!, { type: "agent:reply", agentId: msg.agentId, channelId: msg.channelId, streamId: msg.streamId, name: msg.name ?? a?.displayName ?? a?.name, op: msg.op, text: msg.text ?? "" });
      }
      else if (msg.type === "pong" && machineId) {
        // Heartbeat: the daemon replies pong to our 30s ping. Keep lastHeartbeat fresh so the
        // liveness sweeper never offlines a live machine; if the sweeper raced ahead and offlined
        // us (e.g. a transient DB error aged the heartbeat), flip back online — the link is clearly up.
        const prev = (await db.select({ status: schema.machines.status }).from(schema.machines).where(eq(schema.machines.id, machineId)))[0];
        await db.update(schema.machines).set({ lastHeartbeat: new Date(), status: "online" }).where(eq(schema.machines.id, machineId));
        if (prev && prev.status !== "online") await publish(serverId!, { type: "machine", online: true, machineId });
      }
      else if ((msg.type === "workspace:file_tree" || msg.type === "workspace:file_content" || msg.type === "workspace:file_write" || msg.type === "workspace:file_delete" || msg.type === "skills:list" || msg.type === "project:resolved" || msg.type === "project:directories" || msg.type === "models" || msg.type === "agent:resource-budget" || msg.type === "rpc:ack" || msg.type === "rpc:nack") && msg.requestId) resolveDaemonRequest(msg.requestId, msg, ws);
    } catch (e: any) { log.error("ws handler error", { type: msg?.type, detail: String(e?.message ?? e) }); }
  });
  ws.on("close", async () => {
    clearInterval(ping);
    await Promise.all([...committedDeliveries.values()].map(releaseAgentDeliveryAdmission));
    committedDeliveries.clear();
    const wasCurrent = machineId ? isCurrentMachineConn(machineId, ws) : false;
    unregisterDaemon(ws); unregisterMachineConn(ws);
    if (serverId) await handleConversationTurnDaemonTopologyChange(serverId)
      .catch((e: any) => log.error("unbound Turn topology recovery failed", { serverId, detail: String(e?.message ?? e) }));
    // daemon disconnected → mark this machine offline (otherwise the list keeps showing it online)
    if (machineId && wasCurrent) {
      await db.update(schema.machines).set({ status: "offline" }).where(eq(schema.machines.id, machineId)).catch(() => {});
      await publish(serverId!, { type: "machine", online: false, machineId });
      await markMachineAgentsOffline(machineId).catch((e: any) => log.error("agent offline reconcile failed", { machineId, detail: String(e?.message ?? e) }));
    }
    log.info("daemon disconnected", { serverId, machineId });
  });
  ws.on("error", () => { /* close will follow */ });
}

async function onReady(serverId: string, key: string, msg: any): Promise<string> {
  const hostname = msg.hostname ?? "unknown";
  // "Connect a machine": the machine key pre-creates a row, claimed by apiKeyHash (keeps the user-chosen machine name).
  // The bootstrap key is shared by multiple machines, so apiKeyHash collides → prefer claiming by the daemon's persisted stable machineId (persisted via ready:ack),
  // falling back to hostname (os.hostname() flips between .local and IP on macOS, so it can't be the sole key, otherwise a restart spawns an orphan machine).
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let existing: typeof schema.machines.$inferSelect | undefined;
  if (safeEqual(key, BOOTSTRAP_KEY)) {
    if (typeof msg.machineId === "string" && uuidRe.test(msg.machineId)) {
      existing = (await db.select().from(schema.machines).where(and(eq(schema.machines.serverId, serverId), eq(schema.machines.id, msg.machineId))))[0];
    }
    if (!existing) existing = (await db.select().from(schema.machines).where(and(eq(schema.machines.serverId, serverId), eq(schema.machines.name, hostname))))[0];
  } else {
    existing = (await db.select().from(schema.machines).where(eq(schema.machines.apiKeyHash, hashToken(key))))[0];
  }
  const vals = {
    serverId, name: existing?.name ?? hostname, hostname, os: msg.os ?? null, runtimes: (msg.runtimes ?? []) as string[],
    daemonVersion: msg.daemonVersion ?? null, status: "online", lastHeartbeat: new Date(),
    apiKeyHash: hashToken(key), apiKeyPrefix: key.slice(0, 14),
  };
  let machineId: string;
  if (existing) { await db.update(schema.machines).set(vals).where(eq(schema.machines.id, existing.id)); machineId = existing.id; }
  else {
    const owner = (await db.select().from(schema.servers).where(eq(schema.servers.id, serverId)))[0];
    const [ins] = await db.insert(schema.machines).values({ ...vals, userId: owner!.ownerId }).returning();
    machineId = ins!.id;
  }
  log.info("machine ready", { hostname, os: msg.os, runtimes: msg.runtimes ?? [], daemonVersion: msg.daemonVersion });
  await publish(serverId, { type: "machine", online: true, machineId, hostname, runtimes: msg.runtimes ?? [] }); // machineId in the machine:status payload
  // Reconcile both directions against the authenticated machine's process inventory. A live process may have
  // been marked inactive while its machine was disconnected; restoring active without touching its token keeps
  // the already-running process authenticated. Conversely, active/queued rows absent from the inventory are stale.
  const runningIds: string[] = Array.isArray(msg.runningAgents) ? msg.runningAgents : [];
  const onMachine = await db.select().from(schema.agents).where(and(eq(schema.agents.machineId, machineId), isNull(schema.agents.deletedAt)));
  for (const a of onMachine) {
    if (runningIds.includes(a.id)) {
      if (a.status !== "active") {
        await db.update(schema.agents).set({ status: "active" }).where(eq(schema.agents.id, a.id));
        await publish(serverId, { type: "agent", id: a.id, name: a.name, status: "active", activity: a.activity });
        log.info("reconciled reported running agent → active", { agentId: a.id, machineId });
      }
      continue;
    }
    if (a.status === "starting" || a.status === "active" || a.status === "queued") {
      await db.update(schema.agents).set({ status: "inactive", activity: "offline" }).where(eq(schema.agents.id, a.id));
      await publish(serverId, { type: "agent", id: a.id, name: a.name, status: "inactive", activity: "offline" });
      log.info("reconciled stale-active/queued agent → inactive", { agentId: a.id, machineId });
    }
  }
  return machineId;
}

async function onAgentUpdate(serverId: string, msg: any): Promise<void> {
  if (!msg.agentId) return;
  const patch: Record<string, unknown> = {};
  if (msg.type === "agent:status") patch.status = msg.status;
  if (msg.type === "agent:activity") patch.activity = msg.activity;
  await db.update(schema.agents).set(patch).where(eq(schema.agents.id, msg.agentId));
  const a = (await db.select().from(schema.agents).where(eq(schema.agents.id, msg.agentId)))[0];
  if (a) await publish(serverId, { type: "agent", id: a.id, name: a.name, status: a.status, activity: a.activity, channelId: msg.channelId, detail: msg.detail ?? "" });
  if (msg.type === "agent:activity") {
    const item = await logActivity(serverId, msg.agentId, { kind: "status", activity: msg.activity, detail: msg.detail, runSeq: msg.runSeq }, { channelId: msg.channelId, streamId: msg.streamId, runSeq: msg.runSeq });
    if (item && msg.channelId && msg.streamId) await publish(serverId, { type: "agent:reply", agentId: msg.agentId, channelId: msg.channelId, streamId: msg.streamId, name: a?.displayName ?? a?.name, op: "activity", entries: [item] });
  }
}
