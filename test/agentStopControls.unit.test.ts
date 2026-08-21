import test from "node:test";
import assert from "node:assert/strict";
import { requestAgentStop } from "../web/src/lib/agentStop.ts";

test("concurrent stop requests for one agent share one API call", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const api = async () => { calls += 1; await gate; return { ok: true }; };

  const first = requestAgentStop(api, "agent-shared");
  const second = requestAgentStop(api, "agent-shared");
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);

  release();
  await Promise.all([first, second]);
});
