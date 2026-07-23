import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./prompt.js";

test("coordinated task grants are reserved for results, not acknowledgements", () => {
  const prompt = buildSystemPrompt({
    name: "codex",
    displayName: "Codex",
    agentId: "agent-1",
    serverId: "server-1",
    hostname: "host",
    os: "test",
    workspace: "/workspace",
  });

  assert.match(prompt, /the recorded `accept` decision is the acknowledgement/i);
  assert.match(prompt, /never spend its one-shot public grant on an acknowledgement, plan, intent, or progress update/i);
  assert.match(prompt, /single public reply is reserved for the completed result or a concrete blocker/i);
  assert.doesNotMatch(prompt, /when you get a task, acknowledge it and briefly outline your plan before starting/i);
});
