import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_COMMAND_WHITELIST,
  filterAgentInput,
  inputSenderAllowed,
  isIncomingMode,
  parseAgentInputPolicyPatch,
} from "../src/server/agentInputPolicy.ts";

const targetId = "00000000-0000-4000-8000-000000000001";
const allowedId = "00000000-0000-4000-8000-000000000002";
const blockedId = "00000000-0000-4000-8000-000000000003";

test("accepts only supported incoming modes", () => {
  assert.equal(isIncomingMode("open"), true);
  assert.equal(isIncomingMode("sealed"), true);
  assert.equal(isIncomingMode("sanitized"), false);
  assert.equal(isIncomingMode(null), false);
});

test("validates and normalizes input policy updates", () => {
  assert.deepEqual(parseAgentInputPolicyPatch({ incomingMode: "sealed" }), { patch: { incomingMode: "sealed" } });
  assert.deepEqual(parseAgentInputPolicyPatch({ commandWhitelist: [allowedId.toUpperCase()] }), {
    patch: { commandWhitelist: [allowedId] },
  });
  assert.deepEqual(parseAgentInputPolicyPatch({ incomingMode: "sanitized" }), {
    error: "incomingMode must be open or sealed",
  });
  assert.deepEqual(parseAgentInputPolicyPatch({ commandWhitelist: "all" }), {
    error: "commandWhitelist must be an array",
  });
  assert.deepEqual(parseAgentInputPolicyPatch({ commandWhitelist: ["not-an-id"] }), {
    error: "commandWhitelist must contain agent UUIDs",
  });
  assert.deepEqual(parseAgentInputPolicyPatch({ commandWhitelist: [allowedId, allowedId.toUpperCase()] }), {
    error: "commandWhitelist must not contain duplicate agents",
  });
  assert.deepEqual(
    parseAgentInputPolicyPatch({ commandWhitelist: Array(MAX_COMMAND_WHITELIST + 1).fill(allowedId) }),
    { error: "commandWhitelist accepts at most 100 agents" },
  );
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

test("agent-attributed system rows inherit their actor's policy", () => {
  const messages = [
    { senderType: "system", senderId: blockedId, content: "blocked task title" },
    { senderType: "system", senderId: allowedId, content: "listed task update" },
    { senderType: "system", senderId: null, content: "platform notice" },
    { senderType: "system", senderId: "00000000-0000-4000-8000-000000000004", content: "human audit" },
  ];
  const filtered = filterAgentInput(
    { id: targetId, incomingMode: "sealed", commandWhitelist: [allowedId] },
    messages,
    new Set([blockedId, allowedId]),
  );
  assert.deepEqual(filtered.map((message) => message.content), ["listed task update", "platform notice", "human audit"]);
});
