import { and, asc, desc, eq, inArray, isNotNull, isNull, notInArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";

export interface AgentActivityItem {
  timestamp: number;
  kind: string;
  activity?: string | null;
  detail?: string | null;
  text?: string | null;
  toolName?: string | null;
  toolInput?: string | null;
}

export interface AgentActivityClaim {
  streamId: string;
  rows: (typeof schema.agentActivityLog.$inferSelect)[];
  items: AgentActivityItem[];
}

export const ACTIVITY_LOG_CAP = 500;

export function activityItem(row: typeof schema.agentActivityLog.$inferSelect): AgentActivityItem {
  return {
    timestamp: row.ts,
    kind: row.kind,
    activity: row.activity,
    detail: row.detail,
    text: row.text,
    toolName: row.toolName,
    toolInput: row.toolInput,
  };
}

export async function pruneAgentActivityLog(agentId: string): Promise<void> {
  const keep = db.select({ id: schema.agentActivityLog.id }).from(schema.agentActivityLog)
    .where(eq(schema.agentActivityLog.agentId, agentId)).orderBy(desc(schema.agentActivityLog.ts)).limit(ACTIVITY_LOG_CAP);
  await db.delete(schema.agentActivityLog).where(and(eq(schema.agentActivityLog.agentId, agentId), notInArray(schema.agentActivityLog.id, keep)));
}

export async function logActivity(serverId: string, agentId: string, e: any, ctx: { channelId?: string | null; streamId?: string | null; runSeq?: number | null } = {}): Promise<AgentActivityItem | null> {
  const kind = e.kind === "tool" ? "tool_start" : (e.kind || (e.toolName ? "tool_start" : "text"));
  const ts = Number(e.timestamp ?? Date.now());
  try {
    const [row] = await db.insert(schema.agentActivityLog).values({
      serverId, agentId, ts, kind,
      activity: e.activity ?? null, detail: e.detail ?? null, text: e.text ?? null,
      toolName: e.toolName ?? null, toolInput: e.toolInput ?? null,
      channelId: ctx.channelId ?? e.channelId ?? null,
      streamId: ctx.streamId ?? e.streamId ?? null,
      runSeq: ctx.runSeq ?? e.runSeq ?? null,
    }).returning();
    await pruneAgentActivityLog(agentId);
    return row ? activityItem(row) : null;
  } catch {
    return null; // observability must never block the agent runtime
  }
}

export async function startAgentActivityRun(serverId: string, agentId: string, channelId: string, streamId: string): Promise<AgentActivityItem> {
  const existing = (await db.select().from(schema.agentActivityLog).where(and(
    eq(schema.agentActivityLog.serverId, serverId),
    eq(schema.agentActivityLog.agentId, agentId),
    eq(schema.agentActivityLog.streamId, streamId),
  )).limit(1))[0];
  if (existing) return activityItem(existing);
  return (await logActivity(serverId, agentId, { kind: "status", activity: "working", detail: "turn", runSeq: 0 }, { channelId, streamId, runSeq: 0 }))
    ?? { timestamp: Date.now(), kind: "status", activity: "working", detail: "turn" };
}

export async function pendingActivityForStream(serverId: string, agentId: string, channelId: string, streamId: string): Promise<AgentActivityClaim> {
  const rows = await db.select().from(schema.agentActivityLog).where(and(
    eq(schema.agentActivityLog.serverId, serverId),
    eq(schema.agentActivityLog.agentId, agentId),
    eq(schema.agentActivityLog.channelId, channelId),
    eq(schema.agentActivityLog.streamId, streamId),
    isNull(schema.agentActivityLog.messageId),
  )).orderBy(asc(schema.agentActivityLog.runSeq), asc(schema.agentActivityLog.ts));
  return { streamId, rows, items: rows.map(activityItem) };
}

export async function claimPendingAgentActivity(serverId: string, agentId: string, channelId: string): Promise<AgentActivityClaim | null> {
  const latest = (await db.select({ streamId: schema.agentActivityLog.streamId }).from(schema.agentActivityLog).where(and(
    eq(schema.agentActivityLog.serverId, serverId),
    eq(schema.agentActivityLog.agentId, agentId),
    eq(schema.agentActivityLog.channelId, channelId),
    isNotNull(schema.agentActivityLog.streamId),
    isNull(schema.agentActivityLog.messageId),
  )).orderBy(desc(schema.agentActivityLog.ts)).limit(1))[0];
  if (latest?.streamId) return pendingActivityForStream(serverId, agentId, channelId, latest.streamId);

  // A run can emit two public messages back-to-back without an activity event between them.
  // Keep the second message on the same run by following the latest still-running segment.
  const running = (await db.select({ streamId: schema.messages.agentActivityStreamId }).from(schema.messages).where(and(
    eq(schema.messages.serverId, serverId),
    eq(schema.messages.channelId, channelId),
    eq(schema.messages.senderId, agentId),
    eq(schema.messages.agentActivityState, "running"),
    isNotNull(schema.messages.agentActivityStreamId),
  )).orderBy(desc(schema.messages.seq)).limit(1))[0];
  return running?.streamId ? pendingActivityForStream(serverId, agentId, channelId, running.streamId) : null;
}

export async function assignActivityRows(rows: (typeof schema.agentActivityLog.$inferSelect)[], messageId: string): Promise<void> {
  if (!rows.length) return;
  await db.update(schema.agentActivityLog).set({ messageId }).where(and(
    isNull(schema.agentActivityLog.messageId),
    inArray(schema.agentActivityLog.id, rows.map((row) => row.id)),
  ));
}
