import { and, asc, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { inputSenderAllowed } from "./agentInputPolicy.js";
import { evaluateReplyIntent, type ReplyReason, type ReplySlot } from "./replyCoordinationPolicy.js";
import { canonicalReplyTriggerMessageId, completeConversationTurnIfSettled } from "./conversationTurns.js";

export type ReplyAttention = "direct" | "dm" | "assigned" | "ambient";
export type ReplyRecipient = { agentId: string; attention: ReplyAttention };
type DecisionRow = typeof schema.agentMessageDecisions.$inferSelect;

const SLOT_STATUSES = ["active", "publishing", "consumed"];
const RESERVED_SLOT_STATUSES = ["reserved", ...SLOT_STATUSES];
const configuredSettleMs = Number(process.env.OPEN_TAG_REPLY_SETTLE_MS ?? 5000);
const REPLY_SETTLE_MS = Number.isFinite(configuredSettleMs) && configuredSettleMs >= 0 ? configuredSettleMs : 5000;

function conflictCode(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } };
  return x.code ?? x.cause?.code;
}

async function assignReplyRecipients(o: {
  serverId: string;
  channelId: string;
  messageId: string;
  recipients: ReplyRecipient[];
}, grantStatus: "reserved" | "active"): Promise<void> {
  o = { ...o, messageId: await canonicalReplyTriggerMessageId(o.messageId) };
  if (!o.recipients.length) return;
  await db.insert(schema.agentMessageDecisions).values(o.recipients.map((r) => ({
    serverId: o.serverId,
    channelId: o.channelId,
    messageId: o.messageId,
    agentId: r.agentId,
    attention: r.attention,
  }))).onConflictDoNothing();
  for (const recipient of o.recipients) {
    if (recipient.attention === "ambient") continue;
    await db.update(schema.agentMessageDecisions).set({ attention: recipient.attention, updatedAt: new Date() }).where(and(
      eq(schema.agentMessageDecisions.messageId, o.messageId),
      eq(schema.agentMessageDecisions.agentId, recipient.agentId),
      eq(schema.agentMessageDecisions.attention, "ambient"),
    ));
  }

  const directed = o.recipients.filter((r) => r.attention !== "ambient");
  if (!directed.length) return;
  if (grantStatus === "active") {
    await db.update(schema.agentMessageDecisions).set({
      grantStatus: "active",
      grantedAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.agentMessageDecisions.messageId, o.messageId),
      inArray(schema.agentMessageDecisions.agentId, directed.map((recipient) => recipient.agentId)),
      eq(schema.agentMessageDecisions.grantStatus, "reserved"),
      inArray(schema.agentMessageDecisions.decision, ["pending", "requested", "accepted"]),
    ));
  }
  const existingPrimary = (await db.select({ agentId: schema.agentMessageDecisions.agentId })
    .from(schema.agentMessageDecisions).where(and(
      eq(schema.agentMessageDecisions.messageId, o.messageId),
      eq(schema.agentMessageDecisions.grantSlot, "primary"),
      inArray(schema.agentMessageDecisions.grantStatus, RESERVED_SLOT_STATUSES),
    )).limit(1))[0];
  let primaryAssigned = !!existingPrimary;
  for (const recipient of directed) {
    let slot: ReplySlot = primaryAssigned ? "directed" : "primary";
    try {
      const updated = await db.update(schema.agentMessageDecisions).set({
        grantSlot: slot,
        grantStatus,
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
        grantSlot: slot, grantStatus, grantedAt: new Date(), updatedAt: new Date(),
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

export async function reserveReplyRecipients(o: {
  serverId: string;
  channelId: string;
  messageId: string;
  recipients: ReplyRecipient[];
}): Promise<void> {
  await assignReplyRecipients(o, "reserved");
}

export async function ensureReplyRecipients(o: {
  serverId: string;
  channelId: string;
  messageId: string;
  recipients: ReplyRecipient[];
}): Promise<void> {
  await assignReplyRecipients(o, "active");
}

export async function markReplyMessagesObserved(agentId: string, messageIds: string[]): Promise<Map<string, DecisionRow>> {
  if (!messageIds.length) return new Map();
  const originalIds = messageIds;
  const canonicalByOriginal = new Map<string, string>();
  for (const id of originalIds) canonicalByOriginal.set(id, await canonicalReplyTriggerMessageId(id));
  messageIds = [...new Set(canonicalByOriginal.values())];
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
  const byCanonical = new Map(rows.map((r) => [r.messageId, r]));
  return new Map(originalIds.flatMap((id) => {
    const row = byCanonical.get(canonicalByOriginal.get(id)!);
    return row ? [[id, row] as const] : [];
  }));
}

export async function authorizePendingDmGrants(agentId: string): Promise<number> {
  const now = new Date();
  const upgraded = await db.update(schema.agentMessageDecisions).set({
    decision: "accepted",
    reasonCode: "dm_auto_authorized",
    decidedAt: now,
    updatedAt: now,
  }).where(and(
    eq(schema.agentMessageDecisions.agentId, agentId),
    eq(schema.agentMessageDecisions.attention, "dm"),
    eq(schema.agentMessageDecisions.decision, "pending"),
    eq(schema.agentMessageDecisions.grantStatus, "active"),
  )).returning({ messageId: schema.agentMessageDecisions.messageId });
  return upgraded.length;
}

export function coordinationHeader(row: DecisionRow | undefined): string {
  if (!row) return "";
  const grant = row.grantStatus === "active" ? row.grantSlot : null;
  return ` attention=${row.attention} decision=${row.decision} grant=${grant ?? "none"} trigger=${row.messageId.slice(0, 8)}`;
}

export async function releaseUnavailableReplyGrant(messageId: string, agentId: string): Promise<void> {
  await db.update(schema.agentMessageDecisions).set({
    grantStatus: "released", reasonCode: "recipient_unavailable", updatedAt: new Date(),
  }).where(and(
    eq(schema.agentMessageDecisions.messageId, messageId),
    eq(schema.agentMessageDecisions.agentId, agentId),
    inArray(schema.agentMessageDecisions.grantStatus, ["reserved", "active"]),
  ));
}

async function promoteBetterFit(messageId: string, sourceAgentId: string): Promise<DecisionRow | null> {
  const candidates = await db.select().from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.messageId, messageId),
    eq(schema.agentMessageDecisions.decision, "requested"),
    eq(schema.agentMessageDecisions.reasonCode, "better_fit"),
    eq(schema.agentMessageDecisions.grantStatus, "none"),
  )).orderBy(asc(schema.agentMessageDecisions.decidedAt), asc(schema.agentMessageDecisions.agentId));
  for (const candidate of candidates) {
    const promoted = await db.transaction(async (tx) => {
      const current = (await tx.select().from(schema.agentMessageDecisions).where(and(
        eq(schema.agentMessageDecisions.messageId, messageId),
        eq(schema.agentMessageDecisions.agentId, candidate.agentId),
      )).for("update"))[0];
      if (current?.decision !== "requested" || current.reasonCode !== "better_fit" || current.grantStatus !== "none") return null;
      const target = (await tx.select().from(schema.agents).where(and(
        eq(schema.agents.id, current.agentId),
        eq(schema.agents.serverId, current.serverId),
        isNull(schema.agents.deletedAt),
      )).for("update"))[0];
      if (!target || !inputSenderAllowed(target, "agent", sourceAgentId)) return null;
      const [granted] = await tx.update(schema.agentMessageDecisions).set({
        grantSlot: "primary",
        grantStatus: "active",
        grantedAt: new Date(),
        delegatedByAgentId: sourceAgentId,
        updatedAt: new Date(),
      }).where(and(
        eq(schema.agentMessageDecisions.messageId, messageId),
        eq(schema.agentMessageDecisions.agentId, current.agentId),
        eq(schema.agentMessageDecisions.grantStatus, "none"),
      )).returning();
      return granted ?? null;
    }).catch((error) => conflictCode(error) === "23505" ? null : Promise.reject(error));
    if (promoted) return promoted;
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
  o = { ...o, messageId: await canonicalReplyTriggerMessageId(o.messageId) };
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
    return db.transaction(async (tx) => {
      const rows = await tx.select().from(schema.agentMessageDecisions).where(and(
        eq(schema.agentMessageDecisions.serverId, o.serverId),
        eq(schema.agentMessageDecisions.messageId, o.messageId),
      )).orderBy(asc(schema.agentMessageDecisions.agentId)).for("update");
      const owner = rows.find((candidate) => candidate.agentId === o.agentId);
      if (owner?.grantSlot !== "primary" || owner.grantStatus !== "active") {
        return { ok: false as const, code: "NOT_PRIMARY_OWNER" };
      }
      const target = rows.find((candidate) => candidate.agentId === o.delegateToAgentId
        && candidate.decision === "requested"
        && (candidate.reasonCode === "better_fit" || candidate.reasonCode === "handoff"));
      if (!target?.observedAt) return { ok: false as const, code: "DELEGATE_NOT_REQUESTED" };
      const targetPolicy = (await tx.select().from(schema.agents).where(and(
        eq(schema.agents.id, o.delegateToAgentId!),
        eq(schema.agents.serverId, o.serverId),
        isNull(schema.agents.deletedAt),
      )).for("update"))[0];
      if (!targetPolicy || !inputSenderAllowed(targetPolicy, "agent", o.agentId)) {
        return { ok: false as const, code: "INPUT_SOURCE_REJECTED" };
      }
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
    const ownedGrant = row.grantStatus === "active" || row.grantStatus === "reserved";
    const [updated] = await db.update(schema.agentMessageDecisions).set({
      decision: nextDecision,
      grantStatus: ownedGrant ? "released" : row.grantStatus,
      decidedAt: now,
      updatedAt: now,
    }).where(and(eq(schema.agentMessageDecisions.messageId, o.messageId), eq(schema.agentMessageDecisions.agentId, o.agentId))).returning();
    const promoted = ownedPrimary ? await promoteBetterFit(o.messageId, o.agentId) : null;
    await completeConversationTurnIfSettled(o.messageId);
    return { ok: true, row: updated!, promotedAgentId: promoted?.agentId };
  }

  const reason = o.reason!;
  try {
    return await db.transaction(async (tx): Promise<DecideResult> => {
      const rows = await tx.select().from(schema.agentMessageDecisions).where(and(
        eq(schema.agentMessageDecisions.serverId, o.serverId),
        eq(schema.agentMessageDecisions.messageId, o.messageId),
      )).orderBy(asc(schema.agentMessageDecisions.agentId)).for("update");
      const current = rows.find((candidate) => candidate.agentId === o.agentId);
      if (!current) return { ok: false, code: "MESSAGE_NOT_DELIVERED" };
      if (!current.observedAt) return { ok: false, code: "MESSAGE_NOT_OBSERVED" };
      if (current.grantStatus === "consumed") return { ok: false, code: "REPLY_GRANT_CONSUMED" };

      const primary = rows.find((candidate) => candidate.grantSlot === "primary" && SLOT_STATUSES.includes(candidate.grantStatus));
      const state = {
        primaryState: primary?.grantStatus === "consumed" || primary?.grantStatus === "publishing"
          ? "consumed" as const
          : primary ? "active" as const : "none" as const,
        supplementalTaken: rows.some((candidate) => candidate.grantSlot === "supplemental" && SLOT_STATUSES.includes(candidate.grantStatus)),
      };
      const outcome = evaluateReplyIntent({ reason, ...state });
      const owner = outcome.outcome === "pending"
        ? rows.find((candidate) => candidate.grantSlot === "primary" && candidate.grantStatus === "active" && candidate.agentId !== o.agentId)
        : undefined;
      if (owner) {
        const target = (await tx.select().from(schema.agents).where(and(
          eq(schema.agents.id, owner.agentId),
          eq(schema.agents.serverId, o.serverId),
          isNull(schema.agents.deletedAt),
        )).for("update"))[0];
        if (!target || !inputSenderAllowed(target, "agent", o.agentId)) {
          return { ok: false, code: "INPUT_SOURCE_REJECTED" };
        }
      }

      const [requested] = await tx.update(schema.agentMessageDecisions).set({
        decision: "requested", reasonCode: reason, summary: o.summary?.slice(0, 500) || null,
        decidedAt: now, updatedAt: now,
      }).where(and(
        eq(schema.agentMessageDecisions.messageId, o.messageId),
        eq(schema.agentMessageDecisions.agentId, o.agentId),
      )).returning();
      if (outcome.outcome === "grant") {
        const [granted] = await tx.update(schema.agentMessageDecisions).set({
          grantSlot: outcome.slot, grantStatus: "active", grantedAt: now, updatedAt: now,
        }).where(and(
          eq(schema.agentMessageDecisions.messageId, o.messageId),
          eq(schema.agentMessageDecisions.agentId, o.agentId),
          inArray(schema.agentMessageDecisions.grantStatus, ["none", "released"]),
        )).returning();
        if (!granted) return { ok: false, code: "REPLY_SLOT_TAKEN" };
        return { ok: true, row: granted };
      }
      if (outcome.outcome === "deny") {
        const [denied] = await tx.update(schema.agentMessageDecisions).set({ decision: "denied", updatedAt: now })
          .where(and(eq(schema.agentMessageDecisions.messageId, o.messageId), eq(schema.agentMessageDecisions.agentId, o.agentId))).returning();
        return { ok: false, code: outcome.code };
      }
      return { ok: true, row: requested!, notifyAgentId: owner?.agentId };
    });
  } catch (e) {
    if (conflictCode(e) === "23505") return { ok: false, code: "REPLY_SLOT_TAKEN" };
    throw e;
  }
}

export async function claimReplyCoordination(agentId: string): Promise<Array<{
  kind: "request" | "grant"; messageId: string; requesterAgentId: string; reasonCode: string; summary: string | null; channelId: string;
}>> {
  const owned = await db.select({ messageId: schema.agentMessageDecisions.messageId }).from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.agentId, agentId),
    eq(schema.agentMessageDecisions.grantSlot, "primary"),
    eq(schema.agentMessageDecisions.grantStatus, "active"),
  ));
  const pendingGrants = await db.select({ messageId: schema.agentMessageDecisions.messageId }).from(schema.agentMessageDecisions).where(and(
    eq(schema.agentMessageDecisions.agentId, agentId),
    eq(schema.agentMessageDecisions.grantSlot, "primary"),
    eq(schema.agentMessageDecisions.grantStatus, "active"),
    eq(schema.agentMessageDecisions.decision, "requested"),
    isNull(schema.agentMessageDecisions.grantNotifiedAt),
  ));
  const messageIds = [...new Set([...owned, ...pendingGrants].map((row) => row.messageId))];
  if (!messageIds.length) return [];
  const now = new Date();
  const claimed = await db.transaction(async (tx) => {
    const rows = await tx.select().from(schema.agentMessageDecisions)
      .where(inArray(schema.agentMessageDecisions.messageId, messageIds))
      .orderBy(asc(schema.agentMessageDecisions.messageId), asc(schema.agentMessageDecisions.agentId))
      .for("update");
    const target = (await tx.select().from(schema.agents).where(and(
      eq(schema.agents.id, agentId),
      isNull(schema.agents.deletedAt),
    )).for("update"))[0];
    if (!target) return { updates: [], settledMessageIds: [] as string[] };

    const activeOwned = new Set(rows.filter((row) => row.agentId === agentId
      && row.grantSlot === "primary" && row.grantStatus === "active").map((row) => row.messageId));
    const requests = rows.filter((row) => activeOwned.has(row.messageId)
      && row.agentId !== agentId
      && row.decision === "requested"
      && (row.reasonCode === "better_fit" || row.reasonCode === "handoff")
      && !row.ownerNotifiedAt)
      .sort((left, right) => (left.decidedAt?.getTime() ?? 0) - (right.decidedAt?.getTime() ?? 0));
    const grants = rows.filter((row) => row.agentId === agentId
      && row.grantSlot === "primary"
      && row.grantStatus === "active"
      && row.decision === "requested"
      && !row.grantNotifiedAt)
      .sort((left, right) => (left.grantedAt?.getTime() ?? 0) - (right.grantedAt?.getTime() ?? 0));
    const updates: Array<{
      kind: "request" | "grant"; messageId: string; requesterAgentId: string; reasonCode: string; summary: string | null; channelId: string;
    }> = [];
    const settledMessageIds = new Set<string>();

    for (const request of requests) {
      if (!inputSenderAllowed(target, "agent", request.agentId)) {
        await tx.update(schema.agentMessageDecisions).set({
          decision: "denied", reasonCode: "input_source_rejected", summary: null, updatedAt: now,
        }).where(and(
          eq(schema.agentMessageDecisions.messageId, request.messageId),
          eq(schema.agentMessageDecisions.agentId, request.agentId),
        ));
        settledMessageIds.add(request.messageId);
        continue;
      }
      await tx.update(schema.agentMessageDecisions).set({ ownerNotifiedAt: now, updatedAt: now }).where(and(
        eq(schema.agentMessageDecisions.messageId, request.messageId),
        eq(schema.agentMessageDecisions.agentId, request.agentId),
        isNull(schema.agentMessageDecisions.ownerNotifiedAt),
      ));
      updates.push({
        kind: "request", messageId: request.messageId, requesterAgentId: request.agentId,
        reasonCode: request.reasonCode!, summary: request.summary, channelId: request.channelId,
      });
    }

    for (const grant of grants) {
      const sourceAgentId = grant.delegatedByAgentId ?? grant.agentId;
      if (!inputSenderAllowed(target, "agent", sourceAgentId)) {
        await tx.update(schema.agentMessageDecisions).set({
          decision: "denied", reasonCode: "input_source_rejected", summary: null,
          grantStatus: "released", updatedAt: now,
        }).where(and(
          eq(schema.agentMessageDecisions.messageId, grant.messageId),
          eq(schema.agentMessageDecisions.agentId, grant.agentId),
          eq(schema.agentMessageDecisions.grantStatus, "active"),
        ));
        settledMessageIds.add(grant.messageId);
        continue;
      }
      await tx.update(schema.agentMessageDecisions).set({ grantNotifiedAt: now, updatedAt: now }).where(and(
        eq(schema.agentMessageDecisions.messageId, grant.messageId),
        eq(schema.agentMessageDecisions.agentId, grant.agentId),
        isNull(schema.agentMessageDecisions.grantNotifiedAt),
      ));
      updates.push({
        kind: "grant", messageId: grant.messageId, requesterAgentId: sourceAgentId,
        reasonCode: grant.reasonCode!, summary: grant.summary, channelId: grant.channelId,
      });
    }
    return { updates, settledMessageIds: [...settledMessageIds] };
  });
  for (const messageId of claimed.settledMessageIds) await completeConversationTurnIfSettled(messageId);
  return claimed.updates;
}

async function waitForReplySettlement(messageId: string, ownerAgentId: string): Promise<"settled" | "coordination_required"> {
  const [owner] = await db.select({ grantedAt: schema.agentMessageDecisions.grantedAt })
    .from(schema.agentMessageDecisions)
    .where(and(
      eq(schema.agentMessageDecisions.messageId, messageId),
      eq(schema.agentMessageDecisions.agentId, ownerAgentId),
    ));
  const deadline = (owner?.grantedAt?.getTime() ?? Date.now()) + REPLY_SETTLE_MS;
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
  o = { ...o, messageId: await canonicalReplyTriggerMessageId(o.messageId) };
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
  o = { ...o, messageId: await canonicalReplyTriggerMessageId(o.messageId) };
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
  o = { ...o, messageId: await canonicalReplyTriggerMessageId(o.messageId) };
  await db.update(schema.agentMessageDecisions).set({
    decision: "published", grantStatus: "consumed", replyMessageId: o.replyMessageId,
    publishedAt: new Date(), updatedAt: new Date(),
  }).where(and(
    eq(schema.agentMessageDecisions.messageId, o.messageId),
    eq(schema.agentMessageDecisions.agentId, o.agentId),
    eq(schema.agentMessageDecisions.grantStatus, "publishing"),
  ));
  await completeConversationTurnIfSettled(o.messageId);
}

export async function releaseReplyReservation(messageId: string, agentId: string): Promise<void> {
  messageId = await canonicalReplyTriggerMessageId(messageId);
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
