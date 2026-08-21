import { and, eq, isNull } from "drizzle-orm";
import { db, schema } from "../db/index.js";

/** Soft-delete one live channel. Exactly one concurrent caller can win. */
export async function softDeleteChannelOnce(serverId: string, channelId: string): Promise<boolean> {
  const deleted = await db.update(schema.channels).set({ deletedAt: new Date() }).where(and(
    eq(schema.channels.id, channelId),
    eq(schema.channels.serverId, serverId),
    isNull(schema.channels.deletedAt),
  )).returning({ id: schema.channels.id });
  return deleted.length === 1;
}
