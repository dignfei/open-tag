import { and, asc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { evaluateReplyIntent, type ReplyReason, type ReplySlot } from "./replyCoordinationPolicy.js";

export type ReplyAttention = "direct" | "dm" | "assigned" | "ambient";
export type ReplyRecipient = { agentId: string; attention: ReplyAttention };
type DecisionRow = typeof schema.agentMessageDecisions.$inferSelect;

const SLOT_STATUSES = ["active", "publishing", "consumed"];
const configuredSettleMs = Number(process.env.OPEN_TAG_REPLY_SETTLE_MS ?? 5000);
const REPLY_SETTLE_MS = Number.isFinite(configuredSettleMs) && configuredSettleMs >= 0 ? configuredSettleMs : 5000;

function conflictCode(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } };
  return x.code ?? x.cause?.code;
}

export async function ensureReplyRecipients(o: {
  serverId: string;
  channelId: string;
  messageId: string;
  recipients: ReplyRecipient[];
}): Promise<void> {
  if (!o.recipients.length) return;
  await db.insert(schema.agentMessageDecisions).values(o.recipients.map((r) => ({
    serverId: o.serverId,
    channelId: o.channelId,
    messageId: o.messageId,
    agentId: r.agentId,
    attention: r.attention,
  }))).onConflictDoNothing();

  const directed = o.recipients.filter((r) => r.attention !== "ambient");
  if (!directed.length) return;
  const existingPrimary = (await db.select({ agentId: schema.agentMessageDecisions.agentId })
    .from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, o.messageId),
      eq(schema.agentMessageDecisions.grantSlot, "primary"),
    )).limit(1))[0];
  let primaryAssigned = !!existingPrimary;
  for (const recipient of directed) {
    let slot: ReplySlot = primaryAssigned ? "directed" : "primary";
    try {
      const updated = await db.update(schema.agentMessageDecisions).set({
        grantSlot: slot,
        grantStatus: "active",
        grantedAt: new Date(),
        updatedAt: new Date(),
      }).where(and(
        eq(schema.agentMessageDecisions.messageId, o.messageId),
        eq(schema.agentMessageDecisions.agentId, recipient.agentId),
        eq(schema.agentMessageDecisions.grantStatus, "none"),
      )).returning({ agentId: schema.agentMessageDecisions.agentId });
      if (updated.length && slot === "primary") primaryAssigned = true;
    } catch (e) {
      if (conflictCode(e) !== "23505" || slot !== "primary") throw e;
      primaryAssigned = true;
      slot = "directed";
      await db.update(schema.agentMessageDecisions).set({
        grantSlot: slot, grantStatus: "active", grantedAt: new Date(), updatedAt: new Date(),
      }).where(and(
        eq(schema.agentMessageDecisions.messageId, o.messageId),
        eq(schema.agentMessageDecisions.agentId, recipient.agentId),
        eq(schema.agentMessageDecisions.grantStatus, "none"),
      ));
    }
  }

  const dmAgentIds = directed.filter((r) => r.attention === "dm").map((r) => r.agentId);
  if (dmAgentIds.length) {
    const now = new Date();
    await db.update(schema.agentMessageDecisions).set({
      decision: "accepted",
      reasonCode: "dm_auto_authorized",
      decidedAt: now,
      updatedAt: now,
    }).where(and(
      eq(schema.agentMessageDecisions.messageId, o.messageId),
      inArray(schema.agentMessageDecisions.agentId, dmAgentIds),
      eq(schema.agentMessageDecisions.attention, "dm"),
      eq(schema.agentMessageDecisions.decision, "pending"),
      eq(schema.agentMessageDecisions.grantStatus, "active"),
    ));
  }
}

export async function markReplyMessagesObserved(agentId: string, messageIds: string[]): Promise<Map<string, DecisionRow>> {
  if (!messageIds.length) return new Map();
  const now = new Date();
  await db.update(schema.agentMessageDecisions).set({ observedAt: now, updatedAt: now }).where(and(
    eq(schema.agentMessageDecisions.agentId, agentId),
    inArray(schema.agentMessageDecisions.messageId, messageIds),
    isNull(schema.agentMessageDecisions.observedAt),
  ));
  const rows = await db.select().from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.agentId, agentId),
    inArray(schema.agentMessageDecisions.messageId, messageIds),
  ));
  return new Map(rows.map((r) => [r.messageId, r]));
}

export function coordinationHeader(row: DecisionRow | undefined): string {
  if (!row) return "";
  const grant = row.grantStatus === "active" ? row.grantSlot : null;
  return ` attention=${row.attention} decision=${row.decision} grant=${grant ?? "none"}`;
}

async function slotState(messageId: string): Promise<{ primaryState: "none" | "active" | "consumed"; supplementalTaken: boolean }> {
  const rows = await db.select({ slot: schema.agentMessageDecisions.grantSlot, status: schema.agentMessageDecisions.grantStatus })
    .from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, messageId),
      inArray(schema.agentMessageDecisions.grantStatus, SLOT_STATUSES),
    ));
  const primary = rows.find((r) => r.slot === "primary");
  return {
    primaryState: primary?.status === "consumed" || primary?.status === "publishing" ? "consumed" : primary ? "active" : "none",
    supplementalTaken: rows.some((r) => r.slot === "supplemental"),
  };
}

async function grantRequestedSlot(messageId: string, agentId: string, slot: ReplySlot): Promise<boolean> {
  try {
    const rows = await db.update(schema.agentMessageDecisions).set({
      grantSlot: slot,
      grantStatus: "active",
      grantedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.agentMessageDecisions.messageId, messageId),
      eq(schema.agentMessageDecisions.agentId, agentId),
      inArray(schema.agentMessageDecisions.grantStatus, ["none", "released"]),
    )).returning({ agentId: schema.agentMessageDecisions.agentId });
    return rows.length === 1;
  } catch (e) {
    if (conflictCode(e) === "23505") return false;
    throw e;
  }
}

export async function releaseUnavailableReplyGrant(messageId: string, agentId: string): Promise<void> {
  await db.update(schema.agentMessageDecisions).set({
    grantStatus: "released", reasonCode: "recipient_unavailable", updatedAt: new Date(),
  }).where(and(
    eq(schema.agentMessageDecisions.messageId, messageId),
    eq(schema.agentMessageDecisions.agentId, agentId),
    eq(schema.agentMessageDecisions.grantStatus, "active"),
  ));
}

async function promoteBetterFit(messageId: string): Promise<DecisionRow | null> {
  const candidates = await db.select().from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.messageId, messageId),
    eq(schema.agentMessageDecisions.decision, "requested"),
    eq(schema.agentMessageDecisions.reasonCode, "better_fit"),
    eq(schema.agentMessageDecisions.grantStatus, "none"),
  )).orderBy(asc(schema.agentMessageDecisions.decidedAt));
  for (const candidate of candidates) {
    if (await grantRequestedSlot(messageId, candidate.agentId, "primary")) {
      return (await db.select().from(schema.agentMessageDecisions).where(and(
        eq(schema.agentMessageDecisions.messageId, messageId),
        eq(schema.agentMessageDecisions.agentId, candidate.agentId),
      )))[0] ?? null;
    }
  }
  return null;
}

export type DecideResult = { ok: true; row: DecisionRow; promotedAgentId?: string; notifyAgentId?: string } | { ok: false; code: string };

export async function decideReply(o: {
  serverId: string;
  agentId: string;
  messageId: string;
  decision: "no_action" | "request_reply" | "accept" | "delegate" | "abstain";
  reason?: ReplyReason;
  summary?: string;
  delegateToAgentId?: string;
}): Promise<DecideResult> {
  const row = (await db.select().from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.serverId, o.serverId),
    eq(schema.agentMessageDecisions.messageId, o.messageId),
    eq(schema.agentMessageDecisions.agentId, o.agentId),
  )))[0];
  if (!row) return { ok: false, code: "MESSAGE_NOT_DELIVERED" };
  if (!row.observedAt) return { ok: false, code: "MESSAGE_NOT_OBSERVED" };
  if (row.grantStatus === "consumed") return { ok: false, code: "REPLY_GRANT_CONSUMED" };
  const now = new Date();

  if (o.decision === "accept") {
    if ((row.grantSlot !== "primary" && row.grantSlot !== "directed") || row.grantStatus !== "active") return { ok: false, code: "NOT_PRIMARY_OWNER" };
    if (row.grantSlot === "directed") {
      const [updated] = await db.update(schema.agentMessageDecisions).set({ decision: "accepted", decidedAt: now, updatedAt: now })
        .where(and(eq(schema.agentMessageDecisions.messageId, o.messageId), eq(schema.agentMessageDecisions.agentId, o.agentId))).returning();
      return { ok: true, row: updated! };
    }
    return db.transaction(async (tx) => {
      const [updated] = await tx.update(schema.agentMessageDecisions).set({ decision: "accepted", decidedAt: now, updatedAt: now })
        .where(and(eq(schema.agentMessageDecisions.messageId, o.messageId), eq(schema.agentMessageDecisions.agentId, o.agentId))).returning();
      await tx.update(schema.agentMessageDecisions).set({ decision: "denied", reasonCode: "primary_accepted", updatedAt: now }).where(and(
        eq(schema.agentMessageDecisions.messageId, o.messageId),
        ne(schema.agentMessageDecisions.agentId, o.agentId),
        eq(schema.agentMessageDecisions.decision, "requested"),
        or(eq(schema.agentMessageDecisions.reasonCode, "better_fit"), eq(schema.agentMessageDecisions.reasonCode, "handoff")),
      ));
      return { ok: true as const, row: updated! };
    });
  }

  if (o.decision === "delegate") {
    if (row.grantSlot !== "primary" || row.grantStatus !== "active") return { ok: false, code: "NOT_PRIMARY_OWNER" };
    if (!o.delegateToAgentId || o.delegateToAgentId === o.agentId) return { ok: false, code: "INVALID_DELEGATE_TARGET" };
    const target = (await db.select().from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.serverId, o.serverId),
      eq(schema.agentMessageDecisions.messageId, o.messageId),
      eq(schema.agentMessageDecisions.agentId, o.delegateToAgentId),
      eq(schema.agentMessageDecisions.decision, "requested"),
      or(eq(schema.agentMessageDecisions.reasonCode, "better_fit"), eq(schema.agentMessageDecisions.reasonCode, "handoff")),
    )))[0];
    if (!target?.observedAt) return { ok: false, code: "DELEGATE_NOT_REQUESTED" };
    return db.transaction(async (tx) => {
      await tx.update(schema.agentMessageDecisions).set({ decision: "delegated", grantStatus: "released", decidedAt: now, updatedAt: now })
        .where(and(eq(schema.agentMessageDecisions.messageId, o.messageId), eq(schema.agentMessageDecisions.agentId, o.agentId), eq(schema.agentMessageDecisions.grantStatus, "active")));
      const [granted] = await tx.update(schema.agentMessageDecisions).set({
        grantSlot: "primary", grantStatus: "active", grantedAt: now,
        delegatedByAgentId: o.agentId, updatedAt: now,
      }).where(and(
        eq(schema.agentMessageDecisions.messageId, o.messageId),
        eq(schema.agentMessageDecisions.agentId, o.delegateToAgentId!),
        eq(schema.agentMessageDecisions.grantStatus, "none"),
      )).returning();
      if (!granted) throw new Error("delegate target changed concurrently");
      return { ok: true as const, row: granted, promotedAgentId: granted.agentId };
    }).catch((e) => conflictCode(e) === "23505" ? ({ ok: false as const, code: "REPLY_SLOT_TAKEN" }) : Promise.reject(e));
  }

  if (o.decision === "no_action" || o.decision === "abstain") {
    const nextDecision = o.decision === "no_action" ? "no_action" : "abstained";
    const ownedPrimary = row.grantSlot === "primary" && row.grantStatus === "active";
    const ownedGrant = row.grantStatus === "active";
    const [updated] = await db.update(schema.agentMessageDecisions).set({
      decision: nextDecision,
      grantStatus: ownedGrant ? "released" : row.grantStatus,
      decidedAt: now,
      updatedAt: now,
    }).where(and(eq(schema.agentMessageDecisions.messageId, o.messageId), eq(schema.agentMessageDecisions.agentId, o.agentId))).returning();
    const promoted = ownedPrimary ? await promoteBetterFit(o.messageId) : null;
    return { ok: true, row: updated!, promotedAgentId: promoted?.agentId };
  }

  const reason = o.reason!;
  await db.update(schema.agentMessageDecisions).set({
    decision: "requested", reasonCode: reason, summary: o.summary?.slice(0, 500) || null,
    decidedAt: now, updatedAt: now,
  }).where(and(eq(schema.agentMessageDecisions.messageId, o.messageId), eq(schema.agentMessageDecisions.agentId, o.agentId)));
  const state = await slotState(o.messageId);
  const outcome = evaluateReplyIntent({ reason, ...state });
  if (outcome.outcome === "grant") {
    const granted = await grantRequestedSlot(o.messageId, o.agentId, outcome.slot);
    if (!granted) return { ok: false, code: "REPLY_SLOT_TAKEN" };
  } else if (outcome.outcome === "deny") {
    const [denied] = await db.update(schema.agentMessageDecisions).set({ decision: "denied", updatedAt: new Date() })
      .where(and(eq(schema.agentMessageDecisions.messageId, o.messageId), eq(schema.agentMessageDecisions.agentId, o.agentId))).returning();
    return { ok: false, code: outcome.code };
  }
  const updated = (await db.select().from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.messageId, o.messageId), eq(schema.agentMessageDecisions.agentId, o.agentId),
  )))[0]!;
  if (outcome.outcome === "pending") {
    const owner = (await db.select({ agentId: schema.agentMessageDecisions.agentId }).from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, o.messageId),
      eq(schema.agentMessageDecisions.grantSlot, "primary"),
      eq(schema.agentMessageDecisions.grantStatus, "active"),
      ne(schema.agentMessageDecisions.agentId, o.agentId),
    )))[0];
    return { ok: true, row: updated, notifyAgentId: owner?.agentId };
  }
  return { ok: true, row: updated };
}

export async function claimReplyCoordination(agentId: string): Promise<Array<{
  kind: "request" | "grant"; messageId: string; requesterAgentId: string; reasonCode: string; summary: string | null; channelId: string;
}>> {
  const owned = await db.select({ messageId: schema.agentMessageDecisions.messageId }).from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.agentId, agentId),
    eq(schema.agentMessageDecisions.grantSlot, "primary"),
    eq(schema.agentMessageDecisions.grantStatus, "active"),
  ));
  const now = new Date();
  const requests = owned.length ? await db.update(schema.agentMessageDecisions).set({ ownerNotifiedAt: now, updatedAt: now }).where(and(
      inArray(schema.agentMessageDecisions.messageId, owned.map((r) => r.messageId)),
      ne(schema.agentMessageDecisions.agentId, agentId),
      eq(schema.agentMessageDecisions.decision, "requested"),
      or(eq(schema.agentMessageDecisions.reasonCode, "better_fit"), eq(schema.agentMessageDecisions.reasonCode, "handoff")),
      isNull(schema.agentMessageDecisions.ownerNotifiedAt),
    )).returning() : [];
  const grants = await db.update(schema.agentMessageDecisions).set({ grantNotifiedAt: now, updatedAt: now }).where(and(
    eq(schema.agentMessageDecisions.agentId, agentId),
    eq(schema.agentMessageDecisions.grantSlot, "primary"),
    eq(schema.agentMessageDecisions.grantStatus, "active"),
    eq(schema.agentMessageDecisions.decision, "requested"),
    isNull(schema.agentMessageDecisions.grantNotifiedAt),
  )).returning();
  return [
    ...requests.sort((a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0)).map((r) => ({ kind: "request" as const, messageId: r.messageId, requesterAgentId: r.agentId, reasonCode: r.reasonCode!, summary: r.summary, channelId: r.channelId })),
    ...grants.sort((a, b) => (a.grantedAt?.getTime() ?? 0) - (b.grantedAt?.getTime() ?? 0)).map((r) => ({ kind: "grant" as const, messageId: r.messageId, requesterAgentId: r.agentId, reasonCode: r.reasonCode!, summary: r.summary, channelId: r.channelId })),
  ];
}

async function waitForReplySettlement(messageId: string, ownerAgentId: string): Promise<"settled" | "coordination_required"> {
  const [message] = await db.select({ createdAt: schema.messages.createdAt }).from(schema.messages).where(eq(schema.messages.id, messageId));
  const deadline = (message?.createdAt?.getTime() ?? Date.now()) + REPLY_SETTLE_MS;
  while (true) {
    const others = await db.select({ decision: schema.agentMessageDecisions.decision, reason: schema.agentMessageDecisions.reasonCode })
      .from(schema.agentMessageDecisions).where(and(
        eq(schema.agentMessageDecisions.messageId, messageId),
        ne(schema.agentMessageDecisions.agentId, ownerAgentId),
      ));
    if (others.some((r) => r.decision === "requested" && (r.reason === "better_fit" || r.reason === "handoff"))) return "coordination_required";
    if (!others.some((r) => r.decision === "pending") || Date.now() >= deadline) return "settled";
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, Math.max(1, deadline - Date.now()))));
  }
}

export async function reserveReplyGrant(o: { serverId: string; agentId: string; messageId: string; channelId: string }): Promise<
  { ok: true; slot: ReplySlot } | { ok: false; code: string }
> {
  const current = (await db.select().from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.serverId, o.serverId),
    eq(schema.agentMessageDecisions.messageId, o.messageId),
    eq(schema.agentMessageDecisions.agentId, o.agentId),
  )))[0];
  const targetChannelId = await canonicalReplyChannelId(o.messageId);
  if (targetChannelId !== o.channelId) return { ok: false, code: "REPLY_TARGET_MISMATCH" };
  if (current?.grantSlot === "primary" && await waitForReplySettlement(o.messageId, o.agentId) === "coordination_required") {
    return { ok: false, code: "REPLY_COORDINATION_REQUIRED" };
  }
  const now = new Date();
  const reservation = await db.transaction(async (tx) => {
    const [reserved] = await tx.update(schema.agentMessageDecisions).set({ grantStatus: "publishing", updatedAt: now }).where(and(
      eq(schema.agentMessageDecisions.serverId, o.serverId),
      eq(schema.agentMessageDecisions.messageId, o.messageId),
      eq(schema.agentMessageDecisions.agentId, o.agentId),
      eq(schema.agentMessageDecisions.grantStatus, "active"),
      or(
        eq(schema.agentMessageDecisions.decision, "accepted"),
        eq(schema.agentMessageDecisions.decision, "requested"),
        and(ne(schema.agentMessageDecisions.attention, "ambient"), eq(schema.agentMessageDecisions.decision, "pending")),
      ),
    )).returning({ slot: schema.agentMessageDecisions.grantSlot, decision: schema.agentMessageDecisions.decision });
    if (!reserved) return null;
    if (reserved.slot === "primary") {
      const pendingTransfer = (await tx.select({ agentId: schema.agentMessageDecisions.agentId }).from(schema.agentMessageDecisions).where(and(
        eq(schema.agentMessageDecisions.messageId, o.messageId),
        ne(schema.agentMessageDecisions.agentId, o.agentId),
        eq(schema.agentMessageDecisions.decision, "requested"),
        or(eq(schema.agentMessageDecisions.reasonCode, "better_fit"), eq(schema.agentMessageDecisions.reasonCode, "handoff")),
      )).limit(1))[0];
      if (pendingTransfer) {
        await tx.update(schema.agentMessageDecisions).set({ grantStatus: "active", updatedAt: new Date() }).where(and(
          eq(schema.agentMessageDecisions.messageId, o.messageId),
          eq(schema.agentMessageDecisions.agentId, o.agentId),
          eq(schema.agentMessageDecisions.grantStatus, "publishing"),
        ));
        return { blocked: true as const };
      }
    }
    if (reserved.decision === "pending") {
      await tx.update(schema.agentMessageDecisions).set({ decision: "accepted", decidedAt: now, updatedAt: now }).where(and(
        eq(schema.agentMessageDecisions.messageId, o.messageId),
        eq(schema.agentMessageDecisions.agentId, o.agentId),
        eq(schema.agentMessageDecisions.grantStatus, "publishing"),
        eq(schema.agentMessageDecisions.decision, "pending"),
      ));
    }
    return { blocked: false as const, slot: reserved.slot };
  });
  if (reservation?.blocked) return { ok: false, code: "REPLY_COORDINATION_REQUIRED" };
  if (reservation?.slot === "primary" || reservation?.slot === "directed" || reservation?.slot === "supplemental") return { ok: true, slot: reservation.slot };
  const row = (await db.select().from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.serverId, o.serverId),
    eq(schema.agentMessageDecisions.messageId, o.messageId),
    eq(schema.agentMessageDecisions.agentId, o.agentId),
  )))[0];
  if (!row) return { ok: false, code: "REPLY_NOT_GRANTED" };
  if (row.grantStatus === "consumed" || row.grantStatus === "publishing") return { ok: false, code: "REPLY_GRANT_CONSUMED" };
  return { ok: false, code: "REPLY_NOT_GRANTED" };
}

export async function checkReplyGrant(o: { serverId: string; agentId: string; messageId: string; channelId: string }): Promise<
  { ok: true; slot: ReplySlot } | { ok: false; code: string }
> {
  const row = (await db.select().from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.serverId, o.serverId),
    eq(schema.agentMessageDecisions.messageId, o.messageId),
    eq(schema.agentMessageDecisions.agentId, o.agentId),
  )))[0];
  if (!row) return { ok: false, code: "REPLY_NOT_GRANTED" };
  if (await canonicalReplyChannelId(o.messageId) !== o.channelId) return { ok: false, code: "REPLY_TARGET_MISMATCH" };
  if (row.grantStatus === "consumed" || row.grantStatus === "publishing") return { ok: false, code: "REPLY_GRANT_CONSUMED" };
  if (row.grantStatus === "active" && (row.grantSlot === "primary" || row.grantSlot === "directed" || row.grantSlot === "supplemental")) return { ok: true, slot: row.grantSlot };
  return { ok: false, code: "REPLY_NOT_GRANTED" };
}

export async function finishReplyPublication(o: { messageId: string; agentId: string; replyMessageId: string }): Promise<void> {
  await db.update(schema.agentMessageDecisions).set({
    decision: "published", grantStatus: "consumed", replyMessageId: o.replyMessageId,
    publishedAt: new Date(), updatedAt: new Date(),
  }).where(and(
    eq(schema.agentMessageDecisions.messageId, o.messageId),
    eq(schema.agentMessageDecisions.agentId, o.agentId),
    eq(schema.agentMessageDecisions.grantStatus, "publishing"),
  ));
}

export async function releaseReplyReservation(messageId: string, agentId: string): Promise<void> {
  await db.update(schema.agentMessageDecisions).set({ grantStatus: "active", updatedAt: new Date() }).where(and(
    eq(schema.agentMessageDecisions.messageId, messageId),
    eq(schema.agentMessageDecisions.agentId, agentId),
    eq(schema.agentMessageDecisions.grantStatus, "publishing"),
  ));
}

export async function hasOutstandingReplyDecision(agentId: string, channelId: string): Promise<boolean> {
  const row = (await db.select({ messageId: schema.agentMessageDecisions.messageId }).from(schema.agentMessageDecisions)
    .innerJoin(schema.messages, eq(schema.messages.id, schema.agentMessageDecisions.messageId)).where(and(
    eq(schema.agentMessageDecisions.agentId, agentId),
    or(
      eq(schema.agentMessageDecisions.channelId, channelId),
      and(isNotNull(schema.messages.taskStatus), eq(schema.messages.threadId, channelId)),
    ),
    ne(schema.agentMessageDecisions.grantStatus, "consumed"),
    or(
      inArray(schema.agentMessageDecisions.grantStatus, ["active", "publishing"]),
      inArray(schema.agentMessageDecisions.decision, ["pending", "requested", "accepted"]),
    ),
  )).limit(1))[0];
  return !!row;
}

async function canonicalReplyChannelId(messageId: string): Promise<string | null> {
  const trigger = (await db.select({
    channelId: schema.messages.channelId,
    threadId: schema.messages.threadId,
    taskStatus: schema.messages.taskStatus,
  }).from(schema.messages).where(eq(schema.messages.id, messageId)))[0];
  if (!trigger) return null;
  return trigger.taskStatus && trigger.threadId ? trigger.threadId : trigger.channelId;
}

export async function canAgentManageCoordinatedTask(messageId: string, agentId: string): Promise<boolean> {
  const owner = (await db.select({ agentId: schema.agentMessageDecisions.agentId })
    .from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, messageId),
      eq(schema.agentMessageDecisions.grantSlot, "primary"),
      inArray(schema.agentMessageDecisions.grantStatus, ["active", "publishing", "consumed"]),
    )).limit(1))[0];
  return !owner || owner.agentId === agentId;
}
