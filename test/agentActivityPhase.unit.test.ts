import test from "node:test";
import assert from "node:assert/strict";
import { agentRunPhase } from "../web/src/AgentActivity.tsx";

test("a running message follows its own thinking and tool phases", () => {
  assert.equal(agentRunPhase([], "running"), "working", "a new run starts in working until richer Activity arrives");
  assert.equal(agentRunPhase([{ timestamp: 1, kind: "thinking", text: "Considering the request" }], "running"), "thinking");
  assert.equal(agentRunPhase([
    { timestamp: 1, kind: "thinking", text: "Considering the request" },
    { timestamp: 2, kind: "tool_start", toolName: "commandExecution" },
  ], "running"), "working");
  assert.equal(agentRunPhase([
    { timestamp: 1, kind: "tool_start", toolName: "commandExecution" },
    { timestamp: 2, kind: "text", text: "Reviewing the result" },
  ], "running"), "thinking");
});

test("explicit message Activity status wins over event shape", () => {
  assert.equal(agentRunPhase([{ timestamp: 1, kind: "status", activity: "thinking" }], "running"), "thinking");
  assert.equal(agentRunPhase([{ timestamp: 1, kind: "text", activity: "working" }], "running"), "working");
});

test("completion disappears while failure remains visible", () => {
  const working = [{ timestamp: 1, kind: "status", activity: "working" }];
  assert.equal(agentRunPhase(working, "handled"), null);
  assert.equal(agentRunPhase([...working, { timestamp: 2, kind: "status", activity: "online" }], "running"), null, "terminal runtime activity should clear the badge before the handled update arrives");
  assert.equal(agentRunPhase(working, "error"), "error");
  assert.equal(agentRunPhase([{ timestamp: 1, kind: "status", activity: "error" }], "running"), "error");
});
