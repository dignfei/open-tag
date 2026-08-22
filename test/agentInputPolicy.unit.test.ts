import assert from "node:assert/strict";
import test from "node:test";
import { filterAgentInput, inputSenderAllowed, isIncomingMode } from "../src/server/agentInputPolicy.ts";

const targetId = "00000000-0000-4000-8000-000000000001";
const allowedId = "00000000-0000-4000-8000-000000000002";
const blockedId = "00000000-0000-4000-8000-000000000003";

test("accepts only supported incoming modes", () => {
  assert.equal(isIncomingMode("open"), true);
  assert.equal(isIncomingMode("sealed"), true);
  assert.equal(isIncomingMode("sanitized"), false);
  assert.equal(isIncomingMode(null), false);
});

test("open mode accepts every sender", () => {
  const target = { id: targetId, incomingMode: "open", commandWhitelist: [] };
  assert.equal(inputSenderAllowed(target, "agent", blockedId), true);
  assert.equal(inputSenderAllowed(target, "user", blockedId), true);
});

test("sealed mode accepts humans, system messages, self, and listed agents", () => {
  const target = { id: targetId, incomingMode: "sealed", commandWhitelist: [allowedId] };
  assert.equal(inputSenderAllowed(target, "user", blockedId), true);
  assert.equal(inputSenderAllowed(target, "system", null), true);
  assert.equal(inputSenderAllowed(target, "agent", targetId), true);
  assert.equal(inputSenderAllowed(target, "agent", allowedId), true);
});

test("sealed and unknown modes reject unlisted agent input", () => {
  assert.equal(inputSenderAllowed({ id: targetId, incomingMode: "sealed" }, "agent", blockedId), false);
  assert.equal(inputSenderAllowed({ id: targetId, incomingMode: "future" }, "agent", blockedId), false);
  assert.equal(inputSenderAllowed({ id: targetId, incomingMode: "sealed" }, "agent", null), false);
});

test("filtering preserves allowed message order without mutating the source", () => {
  const messages = [
    { senderType: "agent", senderId: blockedId, content: "blocked" },
    { senderType: "user", senderId: null, content: "human" },
    { senderType: "agent", senderId: allowedId, content: "listed" },
    { senderType: "agent", senderId: targetId, content: "self" },
  ];
  const filtered = filterAgentInput(
    { id: targetId, incomingMode: "sealed", commandWhitelist: [allowedId] },
    messages,
  );
  assert.deepEqual(filtered.map((message) => message.content), ["human", "listed", "self"]);
  assert.equal(messages.length, 4);
});
