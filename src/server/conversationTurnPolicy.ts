export const DEFAULT_CONVERSATION_TURN_WINDOW_MS = 1_200;
export const DEFAULT_CONVERSATION_TURN_MAX_WAIT_MS = 5_000;
export const MAX_CONVERSATION_TURN_WINDOW_MS = 30_000;

/** Malformed configuration cannot disable or indefinitely delay Turn dispatch. */
export function parseConversationTurnWindowMs(raw: string | undefined, fallbackMs = DEFAULT_CONVERSATION_TURN_WINDOW_MS): number {
  const fallback = Math.min(Math.max(Math.trunc(fallbackMs), 0), MAX_CONVERSATION_TURN_WINDOW_MS);
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.trunc(parsed), MAX_CONVERSATION_TURN_WINDOW_MS);
}

/** Trailing debounce is capped from the first message so sustained input cannot starve a Turn forever. */
export function boundedConversationTurnDeadline(
  now: Date,
  createdAt: Date,
  delayMs: number,
  maxWaitMs = DEFAULT_CONVERSATION_TURN_MAX_WAIT_MS,
): Date {
  return new Date(Math.min(now.getTime() + delayMs, createdAt.getTime() + maxWaitMs));
}
