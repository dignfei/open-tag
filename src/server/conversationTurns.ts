import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, or, sql as dsql } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { createLogger } from "../log.js";
import {
  DEFAULT_CONVERSATION_TURN_MAX_WAIT_MS,
  boundedConversationTurnDeadline,
  parseConversationTurnWindowMs,
} from "./conversationTurnPolicy.js";

export type ConversationBoundaryKind = "ambient" | "direct" | "task" | "action";
type TurnRow = typeof schema.conversationTurns.$inferSelect;

const TURN_WINDOW_MS = parseConversationTurnWindowMs(process.env.OPEN_TAG_TURN_DEBOUNCE_MS);
const DIRECT_TURN_WINDOW_MS = parseConversationTurnWindowMs(process.env.OPEN_TAG_DIRECT_TURN_DEBOUNCE_MS, 800);
const TURN_MAX_WAIT_MS = parseConversationTurnWindowMs(process.env.OPEN_TAG_TURN_MAX_WAIT_MS, DEFAULT_CONVERSATION_TURN_MAX_WAIT_MS);
const DISPATCH_LEASE_MS = 30_000;
const RETRY_BASE_MS = 1_000;
const MAX_DISPATCH_ATTEMPTS = 3;
const MAX_AGENT_WAKE_DEPTH = 4;
const MAX_AGENT_WAKES_PER_ROOT = 6;
const RECOVERY_SWEEP_MS = 10_000;
const log = createLogger("server:turns");

function conflictCode(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } };
  return x.code ?? x.cause?.code;
}

async function databaseNow(): Promise<Date> {
  const rows = await db.execute(dsql<{ now: Date }>`select clock_timestamp() as now`);
  return new Date((rows[0] as { now: string | Date }).now);
}

function dispatchDelay(kind: ConversationBoundaryKind): number {
  if (kind === "task" || kind === "action") return 0;
  return kind === "direct" ? DIRECT_TURN_WINDOW_MS : TURN_WINDOW_MS;
}

export interface AttachMessageToTurnInput {
  serverId: string;
  channelId: string;
  senderType: "user" | "agent";
  senderId: string;
  messageId: string;
  seq: number;
  boundaryKind: ConversationBoundaryKind;
  replyToMessageId?: string | null;
  mergeDirect?: boolean;
  now?: Date;
}

export interface AttachedTurn {
  turn: TurnRow;
  sealedTurnIds: string[];
  merged: boolean;
}

/** Attach one persisted message to a durable, sender-scoped quiet-window turn. */
export async function attachMessageToConversationTurn(input: AttachMessageToTurnInput): Promise<AttachedTurn> {
  const now = input.now ?? await databaseNow();
  const incomingBoundary = input.boundaryKind !== "ambient";

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const sealedTurnIds: string[] = [];
        let parentCausalContext: { rootId: string; depth: number } | null = null;
        if (input.senderType === "agent" && input.replyToMessageId) {
          const parentMessage = (await tx.select({ turnId: schema.messages.conversationTurnId }).from(schema.messages)
            .where(and(eq(schema.messages.id, input.replyToMessageId), eq(schema.messages.serverId, input.serverId))).limit(1))[0];
          if (parentMessage?.turnId) {
            const parent = (await tx.select({ causalRootId: schema.conversationTurns.causalRootId, causalDepth: schema.conversationTurns.causalDepth })
              .from(schema.conversationTurns).where(eq(schema.conversationTurns.id, parentMessage.turnId)).limit(1))[0];
            if (parent) parentCausalContext = { rootId: parent.causalRootId, depth: parent.causalDepth + 1 };
          }
        }
        const existing = (await tx.select().from(schema.conversationTurns).where(and(
          eq(schema.conversationTurns.serverId, input.serverId),
          eq(schema.conversationTurns.channelId, input.channelId),
          eq(schema.conversationTurns.senderType, input.senderType),
          eq(schema.conversationTurns.senderId, input.senderId),
          eq(schema.conversationTurns.state, "collecting"),
        )).orderBy(desc(schema.conversationTurns.createdAt)).limit(1))[0];
        const existingAnchor = existing ? (await tx.select({ replyToMessageId: schema.messages.replyToMessageId }).from(schema.messages)
          .where(eq(schema.messages.id, existing.anchorMessageId)).limit(1))[0] : null;

        // A new explicit work boundary seals the previous burst. A direct turn may still
        // absorb later plain-text supplements from the same sender until its quiet window.
        const sameCausalContext = input.senderType !== "agent"
          || (!input.replyToMessageId
            ? !existingAnchor?.replyToMessageId && existing?.causalDepth === 0 && existing.causalRootId === existing.id
            : !!parentCausalContext
            && existing?.causalRootId === parentCausalContext.rootId
            && existing.causalDepth === parentCausalContext.depth
            && existingAnchor?.replyToMessageId === input.replyToMessageId);
        const mergeDmDirect = !!input.mergeDirect && input.boundaryKind === "direct"
          && existing?.boundaryKind === "direct" && sameCausalContext;
        if (existing && (!incomingBoundary || mergeDmDirect) && existing.dispatchAfter.getTime() > now.getTime()) {
          const latestIsIncoming = input.seq >= existing.lastSeq;
          const [turn] = await tx.update(schema.conversationTurns).set({
            latestMessageId: latestIsIncoming ? input.messageId : existing.latestMessageId,
            lastSeq: Math.max(existing.lastSeq, input.seq),
            dispatchAfter: boundedConversationTurnDeadline(now, existing.createdAt, dispatchDelay(existing.boundaryKind as ConversationBoundaryKind), TURN_MAX_WAIT_MS),
            updatedAt: now,
          }).where(and(eq(schema.conversationTurns.id, existing.id), eq(schema.conversationTurns.state, "collecting"))).returning();
          if (turn) {
            await tx.update(schema.messages).set({ conversationTurnId: turn.id }).where(eq(schema.messages.id, input.messageId));
            return { turn, sealedTurnIds, merged: true };
          }
        }

        if (existing) {
          const sealed = await tx.update(schema.conversationTurns).set({ state: "ready", updatedAt: now })
            .where(and(eq(schema.conversationTurns.id, existing.id), eq(schema.conversationTurns.state, "collecting")))
            .returning({ id: schema.conversationTurns.id });
          if (sealed.length) sealedTurnIds.push(existing.id);
        }

        const turnId = randomUUID();
        const causalRootId = parentCausalContext?.rootId ?? turnId;
        const causalDepth = parentCausalContext?.depth ?? 0;

        const [turn] = await tx.insert(schema.conversationTurns).values({
          id: turnId,
          serverId: input.serverId,
          channelId: input.channelId,
          senderType: input.senderType,
          senderId: input.senderId,
          anchorMessageId: input.messageId,
          triggerMessageId: input.messageId,
          latestMessageId: input.messageId,
          firstSeq: input.seq,
          lastSeq: input.seq,
          boundaryKind: input.boundaryKind,
          state: "collecting",
          dispatchAfter: boundedConversationTurnDeadline(now, now, dispatchDelay(input.boundaryKind), TURN_MAX_WAIT_MS),
          causalRootId,
          causalDepth,
          createdAt: now,
          updatedAt: now,
        }).returning();
        await tx.update(schema.messages).set({ conversationTurnId: turn!.id }).where(eq(schema.messages.id, input.messageId));
        return { turn: turn!, sealedTurnIds, merged: false };
      });
    } catch (e) {
      if (conflictCode(e) !== "23505" || attempt === 3) throw e;
    }
  }
  throw new Error("conversation turn attach retry exhausted");
}

export async function canonicalReplyTriggerMessageId(messageId: string): Promise<string> {
  const row = (await db.select({ triggerMessageId: schema.conversationTurns.triggerMessageId })
    .from(schema.messages)
    .leftJoin(schema.conversationTurns, eq(schema.conversationTurns.id, schema.messages.conversationTurnId))
    .where(eq(schema.messages.id, messageId)).limit(1))[0];
  return row?.triggerMessageId ?? messageId;
}

export async function conversationTurnForMessage(messageId: string): Promise<TurnRow | null> {
  const row = (await db.select({ turn: schema.conversationTurns })
    .from(schema.messages)
    .innerJoin(schema.conversationTurns, eq(schema.conversationTurns.id, schema.messages.conversationTurnId))
    .where(eq(schema.messages.id, messageId)).limit(1))[0];
  return row?.turn ?? null;
}

export async function messagesForConversationTurn(turnId: string) {
  return db.select().from(schema.messages).where(eq(schema.messages.conversationTurnId, turnId)).orderBy(asc(schema.messages.seq));
}

export async function claimConversationTurnDispatch(turnId: string, at = new Date()): Promise<TurnRow | null> {
  const leaseUntil = new Date(at.getTime() + DISPATCH_LEASE_MS);
  const [turn] = await db.update(schema.conversationTurns).set({
    // A retry of an already-visible fan-out stays visible while a fresh attempt is fenced.
    state: dsql`case when ${schema.conversationTurns.state} = 'active' then 'active' else 'dispatching' end`,
    dispatchLeaseUntil: leaseUntil,
    dispatchAttempts: dsql`${schema.conversationTurns.dispatchAttempts} + 1`,
    updatedAt: at,
  }).where(and(
    eq(schema.conversationTurns.id, turnId),
    or(
      eq(schema.conversationTurns.state, "ready"),
      and(eq(schema.conversationTurns.state, "collecting"), lte(schema.conversationTurns.dispatchAfter, at)),
      and(eq(schema.conversationTurns.state, "dispatching"), or(isNull(schema.conversationTurns.dispatchLeaseUntil), lte(schema.conversationTurns.dispatchLeaseUntil, at))),
      and(eq(schema.conversationTurns.state, "active"), or(isNull(schema.conversationTurns.dispatchLeaseUntil), lte(schema.conversationTurns.dispatchLeaseUntil, at))),
    ),
  )).returning();
  return turn ?? null;
}

/** Extend only the currently-owned attempt. A recovered attempt has a different fencing token. */
export async function renewConversationTurnDispatchLease(turnId: string, attempt: number, at = new Date()): Promise<boolean> {
  const renewed = await db.update(schema.conversationTurns).set({
    dispatchLeaseUntil: new Date(at.getTime() + DISPATCH_LEASE_MS),
    updatedAt: at,
  }).where(and(
    eq(schema.conversationTurns.id, turnId),
    eq(schema.conversationTurns.dispatchAttempts, attempt),
    inArray(schema.conversationTurns.state, ["dispatching", "active"]),
  )).returning({ id: schema.conversationTurns.id });
  return renewed.length === 1;
}

/** Grants are active and the complete Turn may now be observed, before any runtime wake can race a check. */
export async function activateConversationTurnDispatch(turnId: string, attempt: number, ownerAgentId: string | null): Promise<boolean> {
  const activated = await db.update(schema.conversationTurns).set({
    state: "active",
    ownerAgentId,
    responsibilityState: "active",
    updatedAt: new Date(),
  }).where(and(
    eq(schema.conversationTurns.id, turnId),
    eq(schema.conversationTurns.dispatchAttempts, attempt),
    inArray(schema.conversationTurns.state, ["dispatching", "active"]),
  )).returning({ id: schema.conversationTurns.id });
  return activated.length === 1;
}

export async function finishConversationTurnDispatch(turnId: string, attempt: number, ownerAgentId: string | null, outcome: "delivered" | "completed" | "blocked"): Promise<boolean> {
  const now = new Date();
  const finished = await db.update(schema.conversationTurns).set({
    state: dsql`case when ${schema.conversationTurns.responsibilityState} = 'completed' then 'dispatched' else ${outcome === "blocked" ? "blocked" : "dispatched"} end`,
    ownerAgentId,
    responsibilityState: dsql`case when ${schema.conversationTurns.responsibilityState} = 'completed' then 'completed' else ${outcome} end`,
    dispatchLeaseUntil: null,
    dispatchedAt: now,
    updatedAt: now,
  }).where(and(
    eq(schema.conversationTurns.id, turnId),
    eq(schema.conversationTurns.dispatchAttempts, attempt),
    inArray(schema.conversationTurns.state, ["dispatching", "active"]),
  )).returning({ id: schema.conversationTurns.id });
  return finished.length === 1;
}

/** Mark responsibility complete only after every reply grant for this turn has settled. */
export async function completeConversationTurnIfSettled(messageId: string): Promise<void> {
  const canonicalMessageId = await canonicalReplyTriggerMessageId(messageId);
  const row = (await db.select({ turnId: schema.messages.conversationTurnId })
    .from(schema.messages)
    .where(eq(schema.messages.id, canonicalMessageId))
    .limit(1))[0];
  if (!row?.turnId) return;

  const outstanding = (await db.select({ agentId: schema.agentMessageDecisions.agentId })
    .from(schema.agentMessageDecisions)
    .where(and(
      eq(schema.agentMessageDecisions.messageId, canonicalMessageId),
      inArray(schema.agentMessageDecisions.grantStatus, ["reserved", "active", "publishing"]),
    ))
    .limit(1))[0];
  if (outstanding) return;

  const now = new Date();
  await db.update(schema.conversationTurns).set({
    state: "dispatched",
    responsibilityState: "completed",
    dispatchLeaseUntil: null,
    dispatchedAt: now,
    updatedAt: now,
  }).where(and(
    eq(schema.conversationTurns.id, row.turnId),
    inArray(schema.conversationTurns.state, ["active", "dispatched", "blocked"]),
  ));
}

export async function retryConversationTurnDispatch(turn: TurnRow, error: unknown): Promise<boolean> {
  const now = new Date();
  const terminal = turn.dispatchAttempts >= MAX_DISPATCH_ATTEMPTS;
  const retryAt = new Date(now.getTime() + RETRY_BASE_MS * Math.max(1, turn.dispatchAttempts));
  const retried = await db.update(schema.conversationTurns).set({
    state: terminal ? "blocked" : "ready",
    responsibilityState: terminal ? "blocked" : "pending",
    dispatchAfter: retryAt,
    dispatchLeaseUntil: null,
    updatedAt: now,
  }).where(and(
    eq(schema.conversationTurns.id, turn.id),
    eq(schema.conversationTurns.dispatchAttempts, turn.dispatchAttempts),
    inArray(schema.conversationTurns.state, ["dispatching", "active"]),
  )).returning({ id: schema.conversationTurns.id });
  if (!retried.length) return false;
  log.warn("turn dispatch failed", { turnId: turn.id, attempt: turn.dispatchAttempts, terminal, detail: String((error as Error)?.message ?? error) });
  if (!terminal) scheduleConversationTurn(turn.id, retryAt);
  return true;
}

/** Retry unresolved directed recipients without hiding or releasing already-active grants. */
export async function retryActiveConversationTurnDispatch(turn: TurnRow, error: unknown): Promise<boolean> {
  const now = new Date();
  const terminal = turn.dispatchAttempts >= MAX_DISPATCH_ATTEMPTS;
  const retryAt = new Date(now.getTime() + RETRY_BASE_MS * Math.max(1, turn.dispatchAttempts));
  const retried = await db.update(schema.conversationTurns).set({
    state: terminal ? "blocked" : "active",
    responsibilityState: terminal ? "blocked" : "active",
    dispatchAfter: retryAt,
    dispatchLeaseUntil: terminal ? null : retryAt,
    updatedAt: now,
  }).where(and(
    eq(schema.conversationTurns.id, turn.id),
    eq(schema.conversationTurns.dispatchAttempts, turn.dispatchAttempts),
    eq(schema.conversationTurns.state, "active"),
  )).returning({ id: schema.conversationTurns.id });
  if (!retried.length) return false;
  log.warn("active turn recipient delivery failed", { turnId: turn.id, attempt: turn.dispatchAttempts, terminal, detail: String((error as Error)?.message ?? error) });
  if (!terminal) scheduleConversationTurn(turn.id, retryAt);
  return true;
}

/** Pause a preflighted Turn on a version-gated daemon without burning retry attempts. A capable
 * machine ready event re-schedules the same fenced Turn and deterministic delivery ids. The
 * dispatching -> active transition avoids any observable non-paused window during preflight. */
export async function pauseActiveConversationTurnDispatch(turn: TurnRow, error: unknown): Promise<boolean> {
  const pausedUntil = new Date("9999-12-31T23:59:59.999Z");
  const paused = await db.update(schema.conversationTurns).set({
    state: "active",
    responsibilityState: "active",
    dispatchAfter: pausedUntil,
    dispatchLeaseUntil: pausedUntil,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.conversationTurns.id, turn.id),
    eq(schema.conversationTurns.dispatchAttempts, turn.dispatchAttempts),
    inArray(schema.conversationTurns.state, ["dispatching", "active"]),
  )).returning({ id: schema.conversationTurns.id });
  if (!paused.length) return false;
  log.warn("active turn paused for daemon capability", { turnId: turn.id, attempt: turn.dispatchAttempts, detail: String((error as Error)?.message ?? error) });
  return true;
}

export async function recentConversationOwner(turn: TurnRow): Promise<string | null> {
  const leaseFloor = new Date(turn.createdAt.getTime() - 30 * 60_000);
  const row = (await db.select({ ownerAgentId: schema.conversationTurns.ownerAgentId })
    .from(schema.conversationTurns).where(and(
      eq(schema.conversationTurns.serverId, turn.serverId),
      eq(schema.conversationTurns.channelId, turn.channelId),
      eq(schema.conversationTurns.senderType, turn.senderType),
      eq(schema.conversationTurns.senderId, turn.senderId),
      lt(schema.conversationTurns.createdAt, turn.createdAt),
      inArray(schema.conversationTurns.state, ["active", "dispatched", "blocked"]),
      gte(schema.conversationTurns.createdAt, leaseFloor),
    )).orderBy(desc(schema.conversationTurns.createdAt)).limit(1))[0];
  return row?.ownerAgentId ?? null;
}

export type CausalWakeOutcome = "accepted" | "duplicate" | "blocked_budget" | "blocked_depth";

/** Bound Agent-authored work mentions by root, depth, and directed-pair idempotency. */
export async function claimCausalAgentWake(turn: TurnRow, targetAgentId: string): Promise<CausalWakeOutcome> {
  if (turn.senderType !== "agent") return "accepted";
  const sourceAgentId = turn.senderId;
  if (sourceAgentId === targetAgentId || turn.causalDepth > MAX_AGENT_WAKE_DEPTH) {
    await db.insert(schema.causalEdges).values({
      serverId: turn.serverId, rootTurnId: turn.causalRootId, parentTurnId: turn.id,
      sourceAgentId, targetAgentId, depth: turn.causalDepth, outcome: "blocked_depth",
    });
    return "blocked_depth";
  }

  const existing = (await db.select({ id: schema.causalEdges.id, parentTurnId: schema.causalEdges.parentTurnId }).from(schema.causalEdges).where(and(
    eq(schema.causalEdges.rootTurnId, turn.causalRootId),
    eq(schema.causalEdges.sourceAgentId, sourceAgentId),
    eq(schema.causalEdges.targetAgentId, targetAgentId),
    eq(schema.causalEdges.outcome, "accepted"),
  )).limit(1))[0];
  if (existing) {
    if (existing.parentTurnId === turn.id) return "accepted";
    await db.insert(schema.causalEdges).values({
      serverId: turn.serverId, rootTurnId: turn.causalRootId, parentTurnId: turn.id,
      sourceAgentId, targetAgentId, depth: turn.causalDepth, outcome: "duplicate",
    });
    return "duplicate";
  }

  try {
    return await db.transaction(async (tx) => {
      const root = await tx.update(schema.conversationTurns).set({
        agentWakeCount: dsql`${schema.conversationTurns.agentWakeCount} + 1`, updatedAt: new Date(),
      }).where(and(
        eq(schema.conversationTurns.id, turn.causalRootId),
        lt(schema.conversationTurns.agentWakeCount, MAX_AGENT_WAKES_PER_ROOT),
      )).returning({ id: schema.conversationTurns.id });
      if (!root.length) {
        await tx.insert(schema.causalEdges).values({
          serverId: turn.serverId, rootTurnId: turn.causalRootId, parentTurnId: turn.id,
          sourceAgentId, targetAgentId, depth: turn.causalDepth, outcome: "blocked_budget",
        });
        return "blocked_budget" as const;
      }
      await tx.insert(schema.causalEdges).values({
        serverId: turn.serverId, rootTurnId: turn.causalRootId, parentTurnId: turn.id,
        sourceAgentId, targetAgentId, depth: turn.causalDepth, outcome: "accepted",
      });
      return "accepted" as const;
    });
  } catch (e) {
    if (conflictCode(e) !== "23505") throw e;
    const winner = (await db.select({ parentTurnId: schema.causalEdges.parentTurnId }).from(schema.causalEdges).where(and(
      eq(schema.causalEdges.rootTurnId, turn.causalRootId),
      eq(schema.causalEdges.sourceAgentId, sourceAgentId),
      eq(schema.causalEdges.targetAgentId, targetAgentId),
      eq(schema.causalEdges.outcome, "accepted"),
    )).limit(1))[0];
    if (!winner) throw e;
    if (winner.parentTurnId === turn.id) return "accepted";
    await db.insert(schema.causalEdges).values({
      serverId: turn.serverId, rootTurnId: turn.causalRootId, parentTurnId: turn.id,
      sourceAgentId, targetAgentId, depth: turn.causalDepth, outcome: "duplicate",
    });
    return "duplicate";
  }
}

type TurnDispatcher = (turnId: string) => Promise<void>;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
let dispatcher: TurnDispatcher | null = null;
let recoveryTimer: ReturnType<typeof setInterval> | null = null;

export function scheduleConversationTurn(turnId: string, dispatchAfter: Date): void {
  if (!dispatcher) return;
  const previous = timers.get(turnId);
  if (previous) clearTimeout(previous);
  const delay = Math.max(0, dispatchAfter.getTime() - Date.now());
  const timer = setTimeout(() => {
    timers.delete(turnId);
    void dispatcher?.(turnId).catch((e) => log.error("scheduled turn dispatch crashed", { turnId, detail: String((e as Error)?.message ?? e) }));
  }, delay);
  timer.unref?.();
  timers.set(turnId, timer);
}

async function scheduleRecoverableTurns(): Promise<void> {
  const now = new Date();
  const rows = await db.select().from(schema.conversationTurns).where(or(
    inArray(schema.conversationTurns.state, ["collecting", "ready"]),
    and(eq(schema.conversationTurns.state, "dispatching"), or(isNull(schema.conversationTurns.dispatchLeaseUntil), lte(schema.conversationTurns.dispatchLeaseUntil, now))),
    and(eq(schema.conversationTurns.state, "active"), or(isNull(schema.conversationTurns.dispatchLeaseUntil), lte(schema.conversationTurns.dispatchLeaseUntil, now))),
  ));
  for (const turn of rows) scheduleConversationTurn(turn.id, turn.state === "collecting" ? turn.dispatchAfter : now);
}

export async function startConversationTurnScheduler(run: TurnDispatcher): Promise<void> {
  dispatcher = run;
  await scheduleRecoverableTurns();
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = setInterval(() => void scheduleRecoverableTurns().catch((e) => log.error("turn recovery sweep failed", { detail: String((e as Error)?.message ?? e) })), RECOVERY_SWEEP_MS);
  recoveryTimer.unref?.();
}

export function stopConversationTurnSchedulerForTest(): void {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  if (recoveryTimer) clearInterval(recoveryTimer);
  recoveryTimer = null;
  dispatcher = null;
}
