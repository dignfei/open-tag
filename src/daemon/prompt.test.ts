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
    stateDir: "/state",
    projectDir: "/project",
  });

  assert.match(prompt, /the recorded `accept` decision is the acknowledgement/i);
  assert.match(prompt, /never spend its one-shot public grant on an acknowledgement, plan, intent, or progress update/i);
  assert.match(prompt, /single public reply is reserved for the completed result or a concrete blocker/i);
  assert.doesNotMatch(prompt, /when you get a task, acknowledge it and briefly outline your plan before starting/i);
});

test("conversation turns preserve ambient ownership without permitting duplicate replies", () => {
  const prompt = buildSystemPrompt({
    name: "codex",
    displayName: "Codex",
    agentId: "agent-1",
    serverId: "server-1",
    hostname: "host",
    os: "test",
    stateDir: "/state",
    projectDir: "/project",
  });

  assert.match(prompt, /`attention=assigned` means the server selected you as the accountable owner of an unmentioned human Turn/i);
  assert.match(prompt, /record one judgment per distinct canonical trigger/i);
  assert.match(prompt, /publish at most once for it/i);
  assert.match(prompt, /Another explicit mention owns `grant=directed`/i);
});
