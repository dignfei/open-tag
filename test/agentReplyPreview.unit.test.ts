import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  absorbPersistedAgentMessagePreview,
  agentReplyPreviewId,
  applyAgentReplyPreview,
  hasStreamingAgentReplyPreview,
  mergePersistedAgentMessageUpdate,
  tickAgentReplyPreviews,
  AGENT_REPLY_PREVIEW_DELAY_MS,
  AGENT_REPLY_PREVIEW_TYPE,
} from "../web/src/lib/agentReplyPreview.ts";
import type { Msg } from "../web/src/store.tsx";

const startEvent = {
  type: "agent:reply" as const,
  op: "start" as const,
  agentId: "agent-1",
  channelId: "chan-1",
  streamId: "stream-1",
  name: "Xiaos",
  entries: [{ timestamp: 1000, kind: "status", activity: "working", detail: "turn" }],
};

function realMessage(id: string, content: string, type = "chat"): Msg {
  return {
    id,
    seq: Number(id.replace(/\D/g, "")) || 1,
    channelId: "chan-1",
    senderType: "agent",
    senderId: "agent-1",
    senderName: "Xiaos",
    content,
    messageType: type,
    agentActivityStreamId: "stream-1",
    agentActivityState: type === "agent_activity_receipt" ? "handled" : "running",
    agentActivity: [],
  };
}

test("run start creates a delayed Activity placeholder without provisional public text", () => {
  const messages = applyAgentReplyPreview([], startEvent, undefined, 1000);
  assert.equal(messages.length, 1);
  assert.equal(messages[0]?.messageType, AGENT_REPLY_PREVIEW_TYPE);
  assert.equal(messages[0]?.content, "");
  assert.equal(messages[0]?.agentActivity?.length, 1);
  assert.equal((messages[0] as any).streamVisible, false);
  assert.equal((messages[0] as any).streamVisibleAt, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS);
  assert.equal(hasStreamingAgentReplyPreview(messages), true);

  const early = tickAgentReplyPreviews(messages, 0, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS - 1);
  assert.equal(early.changed, false);
  const visible = tickAgentReplyPreviews(messages, 0, 1000 + AGENT_REPLY_PREVIEW_DELAY_MS);
  assert.equal(visible.changed, true);
  assert.equal((visible.messages[0] as any).streamVisible, true);
});

test("activity events append to the matching run while legacy text deltas are ignored", () => {
  const started = applyAgentReplyPreview([], startEvent);
  const withTool = applyAgentReplyPreview(started, {
    ...startEvent,
    op: "activity",
    entries: [{ timestamp: 1100, kind: "tool_start", toolName: "commandExecution", toolInput: "open-tag message check" }],
  });
  assert.equal(withTool[0]?.agentActivity?.length, 2);
  const afterDelta = applyAgentReplyPreview(withTool, { ...startEvent, op: "delta", text: "this is runtime narration" });
  assert.equal(afterDelta, withTool);
  assert.equal(afterDelta[0]?.content, "");
});

test("a real public message replaces the placeholder without remounting or adding a continuation", () => {
  const started = applyAgentReplyPreview([], startEvent);
  const result = absorbPersistedAgentMessagePreview(started, realMessage("msg-1", "First public reply"));
  assert.equal(result.consumed, true);
  assert.deepEqual(result.messages.map((m) => m.id), ["msg-1"]);
  assert.equal((result.messages[0] as any).clientRenderKey, agentReplyPreviewId("agent-1", "stream-1"));
  assert.deepEqual(result.messages[0]?.agentActivity, startEvent.entries);
});

test("live activity moves onto the first public message instead of a tail placeholder", () => {
  const first = absorbPersistedAgentMessagePreview(applyAgentReplyPreview([], startEvent), realMessage("msg-1", "First"));
  const withActivity = applyAgentReplyPreview(first.messages, {
    ...startEvent,
    op: "activity",
    entries: [{ timestamp: 1200, kind: "text", text: "Preparing the second update" }],
  });
  assert.deepEqual(withActivity.map((m) => m.id), ["msg-1"]);
  assert.equal(withActivity[0]?.agentActivity?.at(-1)?.text, "Preparing the second update");
});

test("done settles the real message in place", () => {
  const absorbed = absorbPersistedAgentMessagePreview(applyAgentReplyPreview([], startEvent), realMessage("msg-1", "Done"));
  const finished = applyAgentReplyPreview(absorbed.messages, { ...startEvent, op: "done" });
  assert.deepEqual(finished.map((m) => m.id), ["msg-1"]);
  assert.equal(finished[0]?.agentActivityState, "handled");
  assert.equal((finished[0] as any).clientRenderKey, agentReplyPreviewId("agent-1", "stream-1"));
});

test("a no-message receipt replaces the placeholder and remains human-visible", () => {
  const started = applyAgentReplyPreview([], startEvent);
  const receipt = realMessage("receipt-1", "", "agent_activity_receipt");
  receipt.agentActivity = startEvent.entries;
  const result = absorbPersistedAgentMessagePreview(started, receipt);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0]?.id, "receipt-1");
  assert.equal(result.messages[0]?.messageType, "agent_activity_receipt");
  assert.equal(result.messages[0]?.content, "");
});

test("message updates merge finalized tail Activity into the persisted message", () => {
  const current = realMessage("msg-1", "Published");
  const updated = { ...current, agentActivityState: "handled" as const, agentActivity: [{ timestamp: 1300, kind: "status", activity: "online" }] };
  const merged = mergePersistedAgentMessageUpdate([current], updated);
  assert.equal(merged[0]?.agentActivityState, "handled");
  assert.equal(merged[0]?.agentActivity?.[0]?.activity, "online");
});

test("a loaded grouped receipt removes its current run preview", () => {
  const receipt = realMessage("receipt-1", "", "agent_activity_receipt");
  receipt.agentActivityState = "error";
  (receipt as any).clientRenderKey = agentReplyPreviewId("agent-1", "stream-1");
  const secondStart = { ...startEvent, streamId: "stream-2" };
  const withPreview = applyAgentReplyPreview([receipt], secondStart);
  assert.deepEqual(withPreview.map((m) => m.id), ["receipt-1", "agent-reply:agent-1:stream-2"]);
  const updated = {
    ...receipt,
    agentActivityStreamId: "stream-2",
    agentActivity: [{ timestamp: 1400, kind: "status", activity: "error" }],
  };

  const merged = mergePersistedAgentMessageUpdate(withPreview, updated);

  assert.deepEqual(merged.map((m) => m.id), ["receipt-1"]);
  assert.equal(merged[0]?.agentActivityStreamId, "stream-2");
  assert.equal(merged[0]?.agentActivity?.[0]?.timestamp, 1400);
  assert.equal((merged[0] as any).clientRenderKey, agentReplyPreviewId("agent-1", "stream-1"));
});

test("an unloaded grouped receipt removes its out-of-page preview", () => {
  const receipt = realMessage("receipt-1", "", "agent_activity_receipt");
  receipt.agentActivityState = "error";
  const secondStart = { ...startEvent, streamId: "stream-2" };
  const current = realMessage("msg-20", "Current page");
  const withPreview = applyAgentReplyPreview([current], secondStart);
  const updated = {
    ...receipt,
    agentActivityStreamId: "stream-2",
    agentActivity: [{ timestamp: 1400, kind: "status", activity: "error" }],
  };

  const merged = mergePersistedAgentMessageUpdate(withPreview, updated);

  assert.deepEqual(merged.map((m) => m.id), ["msg-20"]);
  assert.strictEqual(applyAgentReplyPreview(merged, { ...secondStart, op: "error" }), merged);
});

test("a public message update can recover a missing create event", () => {
  const secondStart = { ...startEvent, streamId: "stream-2" };
  const previewOnly = applyAgentReplyPreview([], secondStart);
  const updated = realMessage("msg-21", "Published");
  updated.agentActivityStreamId = "stream-2";

  const merged = mergePersistedAgentMessageUpdate(previewOnly, updated);

  assert.deepEqual(merged.map((m) => m.id), ["msg-21"]);
  assert.equal(merged[0]?.content, "Published");
  assert.equal((merged[0] as any).clientRenderKey, agentReplyPreviewId("agent-1", "stream-2"));
});

test("a late terminal event cannot restore an absorbed grouped preview", () => {
  const receipt = realMessage("receipt-1", "", "agent_activity_receipt");
  receipt.agentActivityState = "error";
  const secondStart = { ...startEvent, streamId: "stream-2" };
  const withPreview = applyAgentReplyPreview([receipt], secondStart);
  const updated = { ...receipt, agentActivityStreamId: "stream-2" };
  const merged = mergePersistedAgentMessageUpdate(withPreview, updated);

  assert.strictEqual(applyAgentReplyPreview(merged, { ...secondStart, op: "error" }), merged);
});

test("a grouped update absorbs a preview already marked terminal", () => {
  const receipt = realMessage("receipt-1", "", "agent_activity_receipt");
  receipt.agentActivityState = "error";
  const secondStart = { ...startEvent, streamId: "stream-2" };
  const previewOnly = applyAgentReplyPreview([], secondStart);
  const erroredFirst = applyAgentReplyPreview(previewOnly, { ...secondStart, op: "error" });
  const updated = { ...receipt, agentActivityStreamId: "stream-2" };

  const replaced = mergePersistedAgentMessageUpdate(erroredFirst, updated);

  assert.deepEqual(replaced.map((m) => m.id), ["receipt-1"]);
});

test("same-agent starts supersede stale runs but other agents and channels remain independent", () => {
  const first = applyAgentReplyPreview([], startEvent);
  const latest = applyAgentReplyPreview(first, { ...startEvent, streamId: "stream-2" });
  const otherAgent = applyAgentReplyPreview(latest, { ...startEvent, agentId: "agent-2", streamId: "stream-3" });
  const otherChannel = applyAgentReplyPreview(otherAgent, { ...startEvent, channelId: "chan-2", streamId: "stream-4" });
  assert.deepEqual(otherChannel.map((m) => m.id), [
    "agent-reply:agent-1:stream-2",
    "agent-reply:agent-2:stream-3",
    "agent-reply:agent-1:stream-4",
  ]);
});

test("channel and thread render the same Activity disclosure and no permanent Live Trace", () => {
  const chat = fs.readFileSync(new URL("../web/src/views/Chat.tsx", import.meta.url), "utf8");
  const layout = fs.readFileSync(new URL("../web/src/Layout.tsx", import.meta.url), "utf8");
  const activity = fs.readFileSync(new URL("../web/src/AgentActivity.tsx", import.meta.url), "utf8");
  assert.match(chat, /<AgentActivityDisclosure items=\{m\.agentActivity\}/);
  assert.match(chat, /message:updated/);
  assert.match(chat, /className=\{"agent-run"/);
  assert.match(chat, /receipt=\{!!preview\.streamDone \|\| !!preview\.streamError\} autoOpenWhenLive/, "only the pre-reply trace should open itself while live");
  assert.match(chat, /<AgentActivityDisclosure items=\{m\.agentActivity\} state=\{m\.agentActivityState\} receipt \/>/);
  assert.match(layout, /chatPanelOpen \? " has-panel"/);
  assert.doesNotMatch(chat + layout, /Agent Live Trace|agentLiveTrace|agentTraceHint/);
  assert.match(activity, /aria-expanded=\{open\}/);
  assert.match(activity, /useState\(autoOpenWhenLive && live\)/, "persisted message activity should mount collapsed even while its run continues");
  assert.match(activity, /commandExecution|toolName/);
});

test("daemon and server preserve the run context while runtime narration stays out of public text", () => {
  const daemon = fs.readFileSync(new URL("../src/daemon/agentManager.ts", import.meta.url), "utf8");
  const core = fs.readFileSync(new URL("../src/server/core.ts", import.meta.url), "utf8");
  const turnDispatch = fs.readFileSync(new URL("../src/server/conversationTurnDispatch.ts", import.meta.url), "utf8");
  const ws = fs.readFileSync(new URL("../src/server/ws.ts", import.meta.url), "utf8");
  const routes = fs.readFileSync(new URL("../src/server/routes-agent.ts", import.meta.url), "utf8");
  assert.match(daemon, /channelId: preview\?\.channelId, streamId: preview\?\.streamId/);
  assert.match(daemon, /runSeq: preview \? \+\+preview\.eventSeq : undefined/);
  assert.doesNotMatch(daemon, /sendReplyPreviewDelta/);
  assert.doesNotMatch(turnDispatch, /startAgentActivityRun/, "server dispatch must not create Activity before runtime admission");
  assert.match(ws, /msg\.op === "start"[\s\S]*startAgentActivityRun/, "runtime start remains the Activity creation boundary");
  assert.match(core, /agentActivityState: opts\.agentActivityState \?\? \(claimedActivity \? "running" : null\)/);
  assert.match(core, /for \(const segment of closedActivitySegments\)[\s\S]*type: "message:updated"/);
  assert.match(routes, /ne\(schema\.messages\.messageType, "agent_activity_receipt"\)/);
});
