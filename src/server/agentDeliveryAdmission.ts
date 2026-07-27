import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { daemonCount, isCurrentMachineConn } from "./daemonHub.js";
import type { WebSocket } from "ws";

export interface CommittedAgentDelivery {
  deliveryId: string;
  messageId: string;
  agentId: string;
  seq: number;
}

export async function commitAgentDeliveryAdmission(input: {
  ws: WebSocket;
  serverId: string;
  machineId: string | null;
  deliveryId: unknown;
  agentId: unknown;
  seq: unknown;
}): Promise<{ ok: true; delivery: CommittedAgentDelivery } | { ok: false; error: string }> {
  if (!input.machineId || !isCurrentMachineConn(input.machineId, input.ws)) return { ok: false, error: "stale or unidentified machine connection" };
  if (typeof input.deliveryId !== "string" || typeof input.agentId !== "string") return { ok: false, error: "invalid delivery identity" };
  const separator = input.deliveryId.lastIndexOf(":");
  if (separator <= 0 || input.deliveryId.slice(separator + 1) !== input.agentId) return { ok: false, error: "delivery identity mismatch" };
  const turnId = input.deliveryId.slice(0, separator);

  const [turn] = await db.select({
    serverId: schema.conversationTurns.serverId,
    triggerMessageId: schema.conversationTurns.triggerMessageId,
    lastSeq: schema.conversationTurns.lastSeq,
  }).from(schema.conversationTurns).where(and(
    eq(schema.conversationTurns.id, turnId),
    eq(schema.conversationTurns.serverId, input.serverId),
  )).limit(1);
  if (!turn) return { ok: false, error: "delivery Turn not found" };
  if (typeof input.seq !== "number" || input.seq !== turn.lastSeq) return { ok: false, error: "delivery sequence mismatch" };

  const [agent] = await db.select({ machineId: schema.agents.machineId }).from(schema.agents).where(and(
    eq(schema.agents.id, input.agentId),
    eq(schema.agents.serverId, input.serverId),
  )).limit(1);
  if (!agent) return { ok: false, error: "delivery agent not found" };
  if (agent.machineId ? agent.machineId !== input.machineId : daemonCount(input.serverId) !== 1) {
    return { ok: false, error: "delivery machine does not own agent" };
  }

  const [decision] = await db.select({ messageId: schema.agentMessageDecisions.messageId }).from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.messageId, turn.triggerMessageId),
    eq(schema.agentMessageDecisions.agentId, input.agentId),
    eq(schema.agentMessageDecisions.serverId, input.serverId),
  )).limit(1);
  if (!decision) return { ok: false, error: "delivery recipient not found" };
  if (!isCurrentMachineConn(input.machineId, input.ws)) return { ok: false, error: "machine connection was replaced" };

  await db.update(schema.agentMessageDecisions).set({ deliveryAdmittedAt: new Date(), updatedAt: new Date() }).where(and(
    eq(schema.agentMessageDecisions.messageId, turn.triggerMessageId),
    eq(schema.agentMessageDecisions.agentId, input.agentId),
    isNull(schema.agentMessageDecisions.deliveryAdmittedAt),
  ));
  return { ok: true, delivery: { deliveryId: input.deliveryId, messageId: turn.triggerMessageId, agentId: input.agentId, seq: turn.lastSeq } };
}

export async function releaseAgentDeliveryAdmission(delivery: CommittedAgentDelivery): Promise<void> {
  await db.update(schema.agentMessageDecisions).set({ deliveryAdmittedAt: null, updatedAt: new Date() }).where(and(
    eq(schema.agentMessageDecisions.messageId, delivery.messageId),
    eq(schema.agentMessageDecisions.agentId, delivery.agentId),
    isNull(schema.agentMessageDecisions.replyMessageId),
  ));
}
