import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";
import { nextSeq } from "./realtime.js";
import { channelDeletedNoticeContent, channelDeletedNoticeMetadata } from "./channelDeletionNotice.js";

export type ChannelDeletionResult =
  | { deleted: false }
  | {
    deleted: true;
    channelId: string;
    channelName: string;
    noticeId: string | null;
    noticeSeq: number | null;
    recipientAgentIds: string[];
  };

/** Soft-delete one live channel. Exactly one concurrent caller can win. */
export async function softDeleteChannelOnce(serverId: string, channelId: string): Promise<boolean> {
  const deleted = await db.update(schema.channels).set({ deletedAt: new Date() }).where(and(
    eq(schema.channels.id, channelId),
    eq(schema.channels.serverId, serverId),
    isNull(schema.channels.deletedAt),
  )).returning({ id: schema.channels.id });
  return deleted.length === 1;
}

/** Soft-delete once and persist the direct member-agent notice in the same transaction. */
export async function deleteChannelWithAgentNotice(
  serverId: string,
  channelId: string,
): Promise<ChannelDeletionResult> {
  const [candidate] = await db.select({ id: schema.channels.id }).from(schema.channels).where(and(
    eq(schema.channels.id, channelId),
    eq(schema.channels.serverId, serverId),
    isNull(schema.channels.deletedAt),
  ));
  if (!candidate) return { deleted: false };

  // Redis I/O must happen before the transaction can take the channel row lock.
  const seq = await nextSeq(serverId);
  return db.transaction(async (tx) => {
    const [channel] = await tx.update(schema.channels).set({ deletedAt: new Date() }).where(and(
      eq(schema.channels.id, channelId),
      eq(schema.channels.serverId, serverId),
      isNull(schema.channels.deletedAt),
    )).returning({ id: schema.channels.id, name: schema.channels.name });
    if (!channel) return { deleted: false };

    const recipients = await tx.select({ id: schema.agents.id }).from(schema.channelMembers)
      .innerJoin(schema.agents, and(
        eq(schema.agents.id, schema.channelMembers.memberId),
        eq(schema.agents.serverId, serverId),
        isNull(schema.agents.deletedAt),
      ))
      .where(and(
        eq(schema.channelMembers.channelId, channel.id),
        eq(schema.channelMembers.memberType, "agent"),
      ));
    const recipientAgentIds = [...new Set(recipients.map(({ id }) => id))].sort();
    if (!recipientAgentIds.length) {
      return {
        deleted: true,
        channelId: channel.id,
        channelName: channel.name,
        noticeId: null,
        noticeSeq: null,
        recipientAgentIds,
      };
    }

    const content = channelDeletedNoticeContent(channel.name);
    const [notice] = await tx.insert(schema.messages).values({
      seq,
      serverId,
      channelId: channel.id,
      senderType: "system",
      senderId: null,
      senderName: "system",
      messageType: "system",
      content,
      searchText: content,
      actionMetadata: channelDeletedNoticeMetadata(channel.id, channel.name, recipientAgentIds),
    }).returning({ id: schema.messages.id });
    if (!notice) throw new Error("channel deletion notice was not persisted");

    return {
      deleted: true,
      channelId: channel.id,
      channelName: channel.name,
      noticeId: notice.id,
      noticeSeq: seq,
      recipientAgentIds,
    };
  });
}
