// Shared human channel authorization for REST and socket.io.
// Reads include a narrow manager oversight rule; writes require ordinary participant access.
// Threads inherit the current decision for their parent channel.
// The agent-plane boundary remains canAgentReadChannel in core.ts.
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { requireCap } from "./capabilities.js";
import { isUuid } from "./util.js";

/** Participant identity encoded by getOrCreateDM; null for malformed names. */
export function canonicalDmParticipantIds(name: string): [string, string] | null {
  const parts = name.split(":");
  if (parts.length !== 3 || parts[0] !== "dm" || !isUuid(parts[1]!) || !isUuid(parts[2]!) || parts[1] === parts[2]) return null;
  const ids = [parts[1]!, parts[2]!].sort() as [string, string];
  return name === `dm:${ids[0]}:${ids[1]}` ? ids : null;
}

/** Classify a canonical DM using current identities and membership rows. */
export function classifyAgentDm(
  serverId: string,
  channelName: string,
  members: Array<{ memberType: string; memberId: string }>,
  agents: Array<{ id: string; serverId: string; deletedAt: Date | null }>,
  users: Array<{ id: string }> = [],
): "regular" | "invalid" | "valid" {
  const pair = canonicalDmParticipantIds(channelName);
  if (!pair) return "invalid";

  const pairAgents = agents.filter((agent) => pair.includes(agent.id));
  const liveAgentIds = new Set(pairAgents
    .filter((agent) => agent.serverId === serverId && !agent.deletedAt)
    .map((agent) => agent.id));
  const userIds = new Set(users.filter((user) => pair.includes(user.id)).map((user) => user.id));

  if (pair.some((id) => (liveAgentIds.has(id) && userIds.has(id))
    || pairAgents.some((agent) => agent.id === id && !liveAgentIds.has(id)))) return "invalid";

  if (pair.every((id) => liveAgentIds.has(id))) {
    const exactMembers = members.length === 2
      && members.every((member) => member.memberType === "agent" && pair.includes(member.memberId))
      && pair.every((id) => members.some((member) => member.memberType === "agent" && member.memberId === id));
    return exactMembers ? "valid" : "invalid";
  }

  const roles = pair.map((id) => liveAgentIds.has(id) ? "agent" as const : userIds.has(id) ? "user" as const : null);
  if (roles.some((role) => role == null) || !roles.includes("user")) return "invalid";
  for (let i = 0; i < pair.length; i++) {
    const role = roles[i]!;
    const otherRole = role === "agent" ? "user" : "agent";
    if ((role === "agent" && !members.some((member) => member.memberType === role && member.memberId === pair[i]))
      || members.some((member) => member.memberType === otherRole && member.memberId === pair[i])) return "invalid";
  }
  return "regular";
}

async function agentDmState(
  serverId: string,
  channelName: string,
  members: Array<{ memberType: string; memberId: string }>,
): Promise<"regular" | "invalid" | "valid"> {
  const pair = canonicalDmParticipantIds(channelName);
  if (!pair) return "invalid";
  const agents = await db.select({ id: schema.agents.id, serverId: schema.agents.serverId, deletedAt: schema.agents.deletedAt })
    .from(schema.agents).where(inArray(schema.agents.id, pair));
  const users = await db.select({ id: schema.users.id }).from(schema.users).where(inArray(schema.users.id, pair));
  return classifyAgentDm(serverId, channelName, members, agents, users);
}

/** Does this channel inherit from a currently valid agent-to-agent DM? */
export async function isAgentDmAuditChannel(
  serverId: string,
  channelId: string,
  visited = new Set<string>(),
): Promise<boolean> {
  if (!isUuid(channelId) || visited.has(channelId)) return false;
  const channel = (await db.select().from(schema.channels).where(and(
    eq(schema.channels.id, channelId), eq(schema.channels.serverId, serverId),
  )))[0];
  if (!channel || channel.deletedAt) return false;
  if (channel.type === "thread") {
    if (!channel.parentMessageId) return false;
    const parent = (await db.select({ channelId: schema.messages.channelId }).from(schema.messages).where(and(
      eq(schema.messages.id, channel.parentMessageId), eq(schema.messages.serverId, serverId),
    )))[0];
    return parent ? isAgentDmAuditChannel(serverId, parent.channelId, new Set(visited).add(channelId)) : false;
  }
  if (channel.type !== "dm" || channel.parentMessageId) return false;
  const members = await db.select({ memberType: schema.channelMembers.memberType, memberId: schema.channelMembers.memberId })
    .from(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
  return await agentDmState(serverId, channel.name, members) === "valid";
}

async function canUserAccessChannel(
  serverId: string,
  channelId: string,
  userId: string,
  allowAgentDmAudit: boolean,
  visited = new Set<string>(),
): Promise<boolean> {
  if (!isUuid(channelId) || visited.has(channelId)) return false;
  const serverMember = (await db.select({ userId: schema.serverMembers.userId }).from(schema.serverMembers).where(and(
    eq(schema.serverMembers.serverId, serverId), eq(schema.serverMembers.userId, userId),
  )))[0];
  if (!serverMember) return false;
  const ch = (
    await db.select().from(schema.channels).where(and(eq(schema.channels.id, channelId), eq(schema.channels.serverId, serverId)))
  )[0];
  if (!ch || ch.deletedAt) return false;

  if (ch.type === "thread") {
    if (!ch.parentMessageId) return false;
    const parent = (await db.select({ channelId: schema.messages.channelId }).from(schema.messages).where(and(
      eq(schema.messages.id, ch.parentMessageId), eq(schema.messages.serverId, serverId),
    )))[0];
    return parent ? canUserAccessChannel(serverId, parent.channelId, userId, allowAgentDmAudit, new Set(visited).add(channelId)) : false;
  }
  if (ch.parentMessageId) return false;

  const canonicalPair = canonicalDmParticipantIds(ch.name);
  if (ch.type !== "dm" && canonicalPair) return false;
  let members: Array<{ memberType: string; memberId: string }> | null = null;
  if (ch.type === "dm") {
    members = await db.select({ memberType: schema.channelMembers.memberType, memberId: schema.channelMembers.memberId })
      .from(schema.channelMembers).where(eq(schema.channelMembers.channelId, channelId));
    const state = await agentDmState(serverId, ch.name, members);
    if (state === "valid") return allowAgentDmAudit && await requireCap(serverId, userId, "manageAgents");
    if (state === "invalid") return false;
    return !!canonicalPair?.includes(userId)
      && members.some((member) => member.memberType === "user" && member.memberId === userId);
  }

  const member = (await db.select({ memberId: schema.channelMembers.memberId }).from(schema.channelMembers).where(and(
    eq(schema.channelMembers.channelId, channelId),
    eq(schema.channelMembers.memberType, "user"),
    eq(schema.channelMembers.memberId, userId),
  )))[0];
  if (member) return true;
  if (ch.type === "channel") return true;

  return false;
}

/** Read access includes oversight of valid agent-to-agent DMs for manageAgents holders. */
export function canUserReadChannel(serverId: string, channelId: string, userId: string): Promise<boolean> {
  return canUserAccessChannel(serverId, channelId, userId, true);
}

/** Human channel-content writes use an explicit boundary, separate from read policy. */
export function canUserWriteChannel(serverId: string, channelId: string, userId: string): Promise<boolean> {
  return canUserAccessChannel(serverId, channelId, userId, false);
}
