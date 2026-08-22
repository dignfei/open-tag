import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { filterAgentInput, type AgentInputPolicy } from "./agentInputPolicy.js";

type InputMessage = { senderType: string; senderId: string | null };

export async function filterAgentInputView<T extends InputMessage>(
  target: AgentInputPolicy & { serverId: string },
  messages: T[],
): Promise<T[]> {
  if ((target.incomingMode ?? "open") === "open" || !messages.length) return messages;
  const systemActorIds = [...new Set(messages.flatMap((message) =>
    message.senderType === "system" && message.senderId ? [message.senderId] : []))];
  const humanActors = systemActorIds.length ? await db.select({ id: schema.serverMembers.userId })
    .from(schema.serverMembers)
    .where(and(
      eq(schema.serverMembers.serverId, target.serverId),
      inArray(schema.serverMembers.userId, systemActorIds),
    )) : [];
  const humanIds = new Set(humanActors.map((actor) => actor.id));
  const agentActorIds = new Set(systemActorIds.filter((id) => !humanIds.has(id)));
  return filterAgentInput(target, messages, agentActorIds);
}

export async function agentInputVisible<T extends InputMessage>(
  target: AgentInputPolicy & { serverId: string },
  message: T,
): Promise<boolean> {
  return (await filterAgentInputView(target, [message])).length === 1;
}
