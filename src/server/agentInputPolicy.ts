export const INCOMING_MODES = ["open", "sealed"] as const;

export type IncomingMode = typeof INCOMING_MODES[number];

export interface AgentInputPolicy {
  id: string;
  incomingMode?: string | null;
  commandWhitelist?: string[] | null;
}

export function isIncomingMode(value: unknown): value is IncomingMode {
  return typeof value === "string" && (INCOMING_MODES as readonly string[]).includes(value);
}

/** Whether raw input from this sender may enter the target agent's context. */
export function inputSenderAllowed(
  target: AgentInputPolicy,
  senderType: string,
  senderId: string | null | undefined,
): boolean {
  if (senderType !== "agent" || senderId === target.id) return true;
  if ((target.incomingMode ?? "open") === "open") return true;
  return !!senderId && Array.isArray(target.commandWhitelist) && target.commandWhitelist.includes(senderId);
}

export function filterAgentInput<T extends { senderType: string; senderId: string | null }>(
  target: AgentInputPolicy,
  messages: T[],
): T[] {
  if ((target.incomingMode ?? "open") === "open") return messages;
  return messages.filter((message) => inputSenderAllowed(target, message.senderType, message.senderId));
}
