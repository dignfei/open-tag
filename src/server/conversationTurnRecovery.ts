import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { conversationTurnDeliveryBlockReason } from "./daemonHub.js";
import { scheduleConversationTurn } from "./conversationTurns.js";

const CAPABILITY_PAUSED_UNTIL = new Date("9999-12-31T23:59:59.999Z");

export function isConversationTurnCapabilityPaused(turn: { state: string; dispatchLeaseUntil: Date | null }): boolean {
  return turn.state === "active" && turn.dispatchLeaseUntil?.getTime() === CAPABILITY_PAUSED_UNTIL.getTime();
}

/** Resume capability-paused or terminal delivery-blocked Turns assigned to the newly capable machine. */
export async function resumeConversationTurnsForMachine(serverId: string, machineId: string, includeUnbound: boolean, at = new Date()): Promise<number> {
  const rows = await db.select({ id: schema.conversationTurns.id })
    .from(schema.conversationTurns)
    .innerJoin(schema.agentMessageDecisions, eq(schema.agentMessageDecisions.messageId, schema.conversationTurns.triggerMessageId))
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentMessageDecisions.agentId))
    .where(and(
      eq(schema.conversationTurns.serverId, serverId),
      or(
        and(eq(schema.conversationTurns.state, "active"), eq(schema.conversationTurns.dispatchLeaseUntil, CAPABILITY_PAUSED_UNTIL)),
        and(eq(schema.conversationTurns.state, "blocked"), isNull(schema.agentMessageDecisions.deliveryAdmittedAt)),
      ),
      includeUnbound ? or(eq(schema.agents.machineId, machineId), isNull(schema.agents.machineId)) : eq(schema.agents.machineId, machineId),
      inArray(schema.agentMessageDecisions.grantStatus, ["active", "publishing"]),
    ));
  const ids = [...new Set(rows.map((row) => row.id))];
  if (ids.length) await db.update(schema.conversationTurns).set({
    state: "active",
    responsibilityState: "active",
    dispatchAfter: at,
    dispatchLeaseUntil: null,
    updatedAt: at,
  }).where(and(
    inArray(schema.conversationTurns.id, ids),
    inArray(schema.conversationTurns.state, ["active", "blocked"]),
  ));
  for (const id of ids) scheduleConversationTurn(id, at);
  return ids.length;
}

/** Resume capability-paused or delivery-blocked unbound Turns only with one safe route. */
export async function handleConversationTurnDaemonTopologyChange(serverId: string, at = new Date()): Promise<number> {
  if (conversationTurnDeliveryBlockReason(serverId, null)) return 0;
  const rows = await db.select({ id: schema.conversationTurns.id })
    .from(schema.conversationTurns)
    .innerJoin(schema.agentMessageDecisions, eq(schema.agentMessageDecisions.messageId, schema.conversationTurns.triggerMessageId))
    .innerJoin(schema.agents, eq(schema.agents.id, schema.agentMessageDecisions.agentId))
    .where(and(
      eq(schema.conversationTurns.serverId, serverId),
      or(
        and(eq(schema.conversationTurns.state, "active"), eq(schema.conversationTurns.dispatchLeaseUntil, CAPABILITY_PAUSED_UNTIL)),
        and(eq(schema.conversationTurns.state, "blocked"), isNull(schema.agentMessageDecisions.deliveryAdmittedAt)),
      ),
      isNull(schema.agents.machineId),
      inArray(schema.agentMessageDecisions.grantStatus, ["active", "publishing"]),
    ));
  const ids = [...new Set(rows.map((row) => row.id))];
  if (ids.length) await db.update(schema.conversationTurns).set({
    state: "active",
    responsibilityState: "active",
    dispatchAfter: at,
    dispatchLeaseUntil: null,
    updatedAt: at,
  }).where(and(
    inArray(schema.conversationTurns.id, ids),
    inArray(schema.conversationTurns.state, ["active", "blocked"]),
  ));
  for (const id of ids) scheduleConversationTurn(id, at);
  return ids.length;
}
