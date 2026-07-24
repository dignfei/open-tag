import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_CONVERSATION_TURN_MAX_WAIT_MS,
  DEFAULT_CONVERSATION_TURN_WINDOW_MS,
  MAX_CONVERSATION_TURN_WINDOW_MS,
  boundedConversationTurnDeadline,
  parseConversationTurnWindowMs,
} from "./conversationTurnPolicy.js";

test("production Turn window parsing rejects invalid values and caps excessive delay", () => {
  assert.equal(parseConversationTurnWindowMs(undefined), DEFAULT_CONVERSATION_TURN_WINDOW_MS);
  assert.equal(parseConversationTurnWindowMs("not-a-number"), DEFAULT_CONVERSATION_TURN_WINDOW_MS);
  assert.equal(parseConversationTurnWindowMs("Infinity"), DEFAULT_CONVERSATION_TURN_WINDOW_MS);
  assert.equal(parseConversationTurnWindowMs("-1"), DEFAULT_CONVERSATION_TURN_WINDOW_MS);
  assert.equal(parseConversationTurnWindowMs("800"), 800);
  assert.equal(parseConversationTurnWindowMs("60000"), MAX_CONVERSATION_TURN_WINDOW_MS);
});

test("Turn deadline keeps trailing debounce but never exceeds first-message max wait", () => {
  const createdAt = new Date("2026-07-24T00:00:00.000Z");
  const nearMax = new Date(createdAt.getTime() + DEFAULT_CONVERSATION_TURN_MAX_WAIT_MS - 100);
  assert.equal(
    boundedConversationTurnDeadline(nearMax, createdAt, 1_200).getTime(),
    createdAt.getTime() + DEFAULT_CONVERSATION_TURN_MAX_WAIT_MS,
  );
  assert.equal(
    boundedConversationTurnDeadline(new Date(createdAt.getTime() + 100), createdAt, 1_200).getTime(),
    createdAt.getTime() + 1_300,
  );
});
