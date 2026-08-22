export const CHANNEL_DELETED_NOTICE_KIND = "channel_deleted" as const;

export interface ChannelDeletedNoticeMetadata {
  kind: typeof CHANNEL_DELETED_NOTICE_KIND;
  channelId: string;
  channelName: string;
  recipientAgentIds: string[];
}

export function channelDeletedNoticeMetadata(
  channelId: string,
  channelName: string,
  recipientAgentIds: string[],
): ChannelDeletedNoticeMetadata {
  return {
    kind: CHANNEL_DELETED_NOTICE_KIND,
    channelId,
    channelName,
    recipientAgentIds: [...new Set(recipientAgentIds)].sort(),
  };
}

export function channelDeletedNoticeForAgent(
  value: unknown,
  channelId: string,
  agentId: string,
): ChannelDeletedNoticeMetadata | null {
  if (!value || typeof value !== "object") return null;
  const metadata = value as Partial<ChannelDeletedNoticeMetadata>;
  if (metadata.kind !== CHANNEL_DELETED_NOTICE_KIND || metadata.channelId !== channelId) return null;
  if (typeof metadata.channelName !== "string") return null;
  if (!Array.isArray(metadata.recipientAgentIds) || !metadata.recipientAgentIds.every((id) => typeof id === "string")) return null;
  return metadata.recipientAgentIds.includes(agentId) ? metadata as ChannelDeletedNoticeMetadata : null;
}

export function channelDeletedNoticeContent(channelName: string): string {
  return `Channel #${channelName} was deleted. 频道 #${channelName} 已被删除。`;
}
