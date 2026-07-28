import type { Agent, AgentActivityItem, Msg } from "../store.tsx";

export interface AgentReplyEvent {
  type: "agent:reply";
  agentId: string;
  channelId: string;
  op: "start" | "activity" | "delta" | "done" | "error";
  streamId: string;
  name?: string;
  text?: string;
  entries?: AgentActivityItem[];
}

export const AGENT_REPLY_PREVIEW_TYPE = "agent_reply_preview";
export const AGENT_REPLY_STREAM_TICK_MS = 50;
export const AGENT_REPLY_PREVIEW_DELAY_MS = 700;
export const AGENT_REPLY_ENTER_DURATION_MS = 440;
export const AGENT_REPLY_THINKING_DELAY_MS = 0;
export const AGENT_REPLY_THINKING_SHIMMER_MS = 0;
export const AGENT_REPLY_FINAL_SETTLE_MS = 300;
export const AGENT_REPLY_CHARS_PER_TICK = 0;

export interface AgentReplyPreviewMsg extends Msg {
  clientRenderKey?: string;
  streamId: string;
  streamVisible?: boolean;
  streamVisibleAt?: number;
  streamDone?: boolean;
  streamError?: boolean;
}

export function agentReplyPreviewId(agentId: string, streamId: string): string {
  return `agent-reply:${agentId}:${streamId}`;
}

export function renderKeyForMessage(m: Msg): string {
  return (m as AgentReplyPreviewMsg).clientRenderKey || m.id;
}

function senderNameFor(e: AgentReplyEvent, agent?: Agent): string {
  return e.name || agent?.displayName || agent?.name || "Agent";
}

function matchesPreview(m: Msg, e: Pick<AgentReplyEvent, "agentId" | "channelId" | "streamId">): boolean {
  const preview = m as AgentReplyPreviewMsg;
  return m.messageType === AGENT_REPLY_PREVIEW_TYPE
    && m.senderId === e.agentId
    && m.channelId === e.channelId
    && preview.streamId === e.streamId;
}

function findStreamTargetIndex(messages: Msg[], e: Pick<AgentReplyEvent, "agentId" | "channelId" | "streamId">): number {
  const previewIdx = messages.findIndex((m) => matchesPreview(m, e));
  if (previewIdx >= 0) return previewIdx;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]!;
    if (m.senderType === "agent"
      && m.senderId === e.agentId
      && m.channelId === e.channelId
      && m.agentActivityStreamId === e.streamId
      && m.agentActivityState === "running") return i;
  }
  return -1;
}

export function applyAgentReplyPreview(messages: Msg[], e: AgentReplyEvent, agent?: Agent, now = Date.now()): Msg[] {
  if (!e.agentId || !e.channelId || !e.streamId) return messages;
  const idx = findStreamTargetIndex(messages, e);

  if (e.op === "activity") {
    if (idx < 0 || !e.entries?.length) return messages;
    return messages.map((m, i) => i === idx ? { ...m, agentActivity: [...(m.agentActivity ?? []), ...e.entries!] } : m);
  }
  // Legacy daemon deltas are deliberately ignored: runtime output is Activity, never provisional public message content.
  if (e.op === "delta") return messages;
  if (e.op === "done" || e.op === "error") {
    if (idx < 0) return messages;
    return messages.map((m, i) => i === idx ? {
      ...m,
      ...(m.messageType === AGENT_REPLY_PREVIEW_TYPE ? { streamDone: e.op === "done", streamError: e.op === "error" } : {}),
      agentActivityState: e.op === "error" ? "error" : "handled",
    } as AgentReplyPreviewMsg : m);
  }
  if (idx >= 0) {
    if (!e.entries?.length) return messages;
    return messages.map((m, i) => i === idx ? { ...m, agentActivity: [...(m.agentActivity ?? []), ...e.entries!] } : m);
  }
  if (e.op !== "start") return messages;

  const withoutSuperseded = messages.filter((m) => !(m.messageType === AGENT_REPLY_PREVIEW_TYPE && m.channelId === e.channelId && m.senderId === e.agentId));
  const preview: AgentReplyPreviewMsg = {
    id: agentReplyPreviewId(e.agentId, e.streamId),
    seq: Number.MAX_SAFE_INTEGER,
    channelId: e.channelId,
    senderType: "agent",
    senderId: e.agentId,
    senderName: senderNameFor(e, agent),
    content: "",
    messageType: AGENT_REPLY_PREVIEW_TYPE,
    createdAt: new Date().toISOString(),
    clientRenderKey: agentReplyPreviewId(e.agentId, e.streamId),
    streamId: e.streamId,
    streamVisible: false,
    streamVisibleAt: now + AGENT_REPLY_PREVIEW_DELAY_MS,
    agentActivity: e.entries ?? [],
    agentActivityState: "running",
  };
  return [...withoutSuperseded, preview];
}

export function dropAgentReplyPreviewsForMessage(messages: Msg[], msg: Msg): Msg[] {
  if (msg.senderType !== "agent" || !msg.senderId) return messages;
  return messages.filter((m) => !(m.messageType === AGENT_REPLY_PREVIEW_TYPE && m.channelId === msg.channelId && m.senderId === msg.senderId));
}

export function absorbPersistedAgentMessagePreview(messages: Msg[], msg: Msg): { messages: Msg[]; consumed: boolean } {
  if (msg.senderType !== "agent" || !msg.senderId) return { messages, consumed: false };
  const idx = messages.findIndex((m) => {
    if (m.messageType !== AGENT_REPLY_PREVIEW_TYPE || m.channelId !== msg.channelId || m.senderId !== msg.senderId) return false;
    return !msg.agentActivityStreamId || (m as AgentReplyPreviewMsg).streamId === msg.agentActivityStreamId;
  });
  if (idx < 0) return { messages, consumed: false };
  const preview = messages[idx] as AgentReplyPreviewMsg;
  const replacement: AgentReplyPreviewMsg = {
    ...msg,
    clientRenderKey: preview.clientRenderKey,
    streamId: preview.streamId,
    agentActivity: msg.agentActivity?.length ? msg.agentActivity : preview.agentActivity,
    agentActivityState: msg.agentActivityState ?? (msg.messageType === "agent_activity_receipt" ? "handled" : "running"),
  };
  return {
    consumed: true,
    messages: messages.map((m, i) => i === idx ? replacement : m),
  };
}

export function mergePersistedAgentMessageUpdate(messages: Msg[], msg: Msg): Msg[] {
  return messages.map((m) => m.id === msg.id ? { ...m, ...msg } : m);
}

export function hasStreamingAgentReplyPreview(messages: Msg[]): boolean {
  return messages.some((m) => m.messageType === AGENT_REPLY_PREVIEW_TYPE && !(m as AgentReplyPreviewMsg).streamVisible);
}

export function tickAgentReplyPreviews(messages: Msg[], _charsPerTick = 0, now = Date.now()): { messages: Msg[]; changed: boolean } {
  let changed = false;
  const next = messages.map((m) => {
    if (m.messageType !== AGENT_REPLY_PREVIEW_TYPE) return m;
    const preview = m as AgentReplyPreviewMsg;
    if (!preview.streamVisible && preview.streamVisibleAt && now >= preview.streamVisibleAt) {
      changed = true;
      return { ...preview, streamVisible: true } as AgentReplyPreviewMsg;
    }
    return m;
  });
  return { messages: next, changed };
}
