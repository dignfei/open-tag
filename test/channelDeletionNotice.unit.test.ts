import assert from "node:assert/strict";
import test from "node:test";
import {
  CHANNEL_DELETED_NOTICE_KIND,
  channelDeletedNoticeContent,
  channelDeletedNoticeForAgent,
  channelDeletedNoticeMetadata,
} from "../src/server/channelDeletionNotice.ts";

test("channel deletion metadata keeps a stable recipient set", () => {
  assert.deepEqual(channelDeletedNoticeMetadata("channel-id", "release-room", ["agent-b", "agent-a", "agent-b"]), {
    kind: CHANNEL_DELETED_NOTICE_KIND,
    channelId: "channel-id",
    channelName: "release-room",
    recipientAgentIds: ["agent-a", "agent-b"],
  });
});

test("channel deletion metadata is limited to the intended channel and recipient", () => {
  const metadata = channelDeletedNoticeMetadata("channel-id", "release-room", ["agent-a"]);
  assert.equal(channelDeletedNoticeForAgent(metadata, "channel-id", "agent-a"), metadata);
  assert.equal(channelDeletedNoticeForAgent(metadata, "other-channel", "agent-a"), null);
  assert.equal(channelDeletedNoticeForAgent(metadata, "channel-id", "agent-b"), null);
  assert.equal(channelDeletedNoticeForAgent({ ...metadata, kind: "other" }, "channel-id", "agent-a"), null);
  assert.equal(channelDeletedNoticeForAgent({ ...metadata, recipientAgentIds: [1] }, "channel-id", "agent-a"), null);
});

test("channel deletion copy is bilingual", () => {
  assert.equal(
    channelDeletedNoticeContent("release-room"),
    "Channel #release-room was deleted. 频道 #release-room 已被删除。",
  );
});
