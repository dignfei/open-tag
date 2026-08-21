// Shared channel read-access guard for the human REST plane.
// The agent-plane mirror is canAgentReadChannel in core.ts.
// The socket.io room-join check is canReadChannel in socketio.ts (private; not exported).
// All three follow the same logic: channel member OR public channel OR thread of a readable parent.
import { and, eq } from "drizzle-orm";
import { db, schema } from "../db/index.js";
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

/**
 * May this human user read (and write to) this channel?
 *
 * True when any of:
 *   • the user is a channel member (channelMembers row exists)
 *   • the channel is public (type="channel") — any server member may access it
 *   • the channel is a thread whose parent channel passes this same check (depth-1 recursion)
 *
 * False for private / DM channels the user is not a member of, and for channels that
 * belong to a different server (invariant 1 + invariant 3, docs/authorization.md).
 *
 * Enforces authorization.md invariant 3 (channel visibility) on the human REST plane.
 */
export async function canUserReadChannel(
  serverId: string,
  channelId: string,
  userId: string,
): Promise<boolean> {
  if (!isUuid(channelId)) return false; // a non-uuid can't name a channel; casting it into the uuid column would throw (→ 500) instead of refusing
  const member = (
    await db
      .select()
      .from(schema.channelMembers)
      .where(
        and(
          eq(schema.channelMembers.channelId, channelId),
          eq(schema.channelMembers.memberType, "user"),
          eq(schema.channelMembers.memberId, userId),
        ),
      )
  )[0];
  if (member) return true;

  const ch = (
    await db.select().from(schema.channels).where(eq(schema.channels.id, channelId))
  )[0];
  if (!ch || ch.serverId !== serverId || ch.deletedAt) return false;
  if (ch.type === "channel") return true; // public: any server member may read

  if (ch.parentMessageId) {
    // thread: visibility follows its parent message's channel (depth 1 — a parent channel is never itself a thread)
    const parent = (
      await db.select().from(schema.messages).where(eq(schema.messages.id, ch.parentMessageId))
    )[0];
    if (parent) return canUserReadChannel(serverId, parent.channelId, userId);
  }

  return false; // private / DM the user is not a member of
}
