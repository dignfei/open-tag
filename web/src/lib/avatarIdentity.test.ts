import assert from "node:assert/strict";
import test from "node:test";
import { avatarSeedFor } from "./avatarIdentity.js";

test("the same agent uses its display identity for persisted messages and live Activity", () => {
  const agent = { id: "agent-1", name: "dev-bot-2", displayName: "Dev Bot 2" };

  assert.equal(avatarSeedFor(agent, "dev-bot-2"), "Dev Bot 2");
  assert.equal(avatarSeedFor(agent, "Dev Bot 2"), "Dev Bot 2");
});

test("missing member data falls back to the persisted sender name", () => {
  assert.equal(avatarSeedFor(undefined, "removed-agent"), "removed-agent");
});
