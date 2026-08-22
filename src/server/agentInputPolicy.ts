import { isUuid } from "./util.js";

export const INCOMING_MODES = ["open", "sealed"] as const;
export const MAX_COMMAND_WHITELIST = 100;

export type IncomingMode = typeof INCOMING_MODES[number];

export interface AgentInputPolicy {
  id: string;
  incomingMode?: string | null;
  commandWhitelist?: string[] | null;
}

export type AgentInputPolicyPatch = {
  incomingMode?: IncomingMode;
  commandWhitelist?: string[];
};

export function isIncomingMode(value: unknown): value is IncomingMode {
  return typeof value === "string" && (INCOMING_MODES as readonly string[]).includes(value);
}

export function parseAgentInputPolicyPatch(
  body: Record<string, unknown>,
): { patch: AgentInputPolicyPatch } | { error: string } {
  const patch: AgentInputPolicyPatch = {};
  if (body.incomingMode !== undefined) {
    if (!isIncomingMode(body.incomingMode)) return { error: "incomingMode must be open or sealed" };
    patch.incomingMode = body.incomingMode;
  }
  if (body.commandWhitelist !== undefined) {
    if (!Array.isArray(body.commandWhitelist)) return { error: "commandWhitelist must be an array" };
    if (body.commandWhitelist.length > MAX_COMMAND_WHITELIST) {
      return { error: `commandWhitelist accepts at most ${MAX_COMMAND_WHITELIST} agents` };
    }
    if (!body.commandWhitelist.every((id) => typeof id === "string" && isUuid(id))) {
      return { error: "commandWhitelist must contain agent UUIDs" };
    }
    const normalized = body.commandWhitelist.map((id) => id.toLowerCase());
    if (new Set(normalized).size !== normalized.length) {
      return { error: "commandWhitelist must not contain duplicate agents" };
    }
    patch.commandWhitelist = normalized;
  }
  return { patch };
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
