import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
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

test("API failures are reported and permit a later retry", async () => {
  let calls = 0;
  const api = async () => (++calls === 1 ? { error: "daemon offline" } : { ok: true });

  await assert.rejects(requestAgentStop(api, "agent-response-failure"), /daemon offline/);
  await requestAgentStop(api, "agent-response-failure");
  assert.equal(calls, 2);
});

test("network failures release the pending stop request", async () => {
  let calls = 0;
  const api = async () => {
    calls += 1;
    if (calls === 1) throw new Error("network unavailable");
    return { ok: true };
  };

  await assert.rejects(requestAgentStop(api, "agent-network-failure"), /network unavailable/);
  await requestAgentStop(api, "agent-network-failure");
  assert.equal(calls, 2);
});

test("the shared stop control is permission-gated and reports pending failures", () => {
  const control = fs.readFileSync(new URL("../web/src/AgentStopButton.tsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");
  const en = JSON.parse(fs.readFileSync(new URL("../web/src/locales/en.json", import.meta.url), "utf8"));
  const zh = JSON.parse(fs.readFileSync(new URL("../web/src/locales/zh.json", import.meta.url), "utf8"));

  assert.match(control, /if \(!capabilities\.manageAgents\) return null/);
  assert.match(control, /await requestAgentStop\(api, agentId\)/);
  assert.match(control, /disabled=\{stopping\}/);
  assert.match(control, /aria-busy=\{stopping\}/);
  assert.match(control, /toast\.error\(t\("members\.stopFailedWithReason", \{ reason \}\)\)/);
  assert.match(styles, /\.agent-stop-btn:disabled\{[^}]*cursor:wait/);
  assert.equal(en.members.stopping, "Stopping…");
  assert.equal(zh.members.stopping, "正在停止…");
  assert.match(en.members.stopFailedWithReason, /\{\{reason\}\}/);
  assert.match(zh.members.stopFailedWithReason, /\{\{reason\}\}/);
});

test("activity disclosures offer stop only for an identified live agent", () => {
  const activity = fs.readFileSync(new URL("../web/src/AgentActivity.tsx", import.meta.url), "utf8");

  assert.match(activity, /agentId\?: string \| null/);
  assert.match(activity, /live && agentId \? <AgentStopButton agentId=\{agentId\}/);
});

test("the live sidebar offers a stop control for its primary agent", () => {
  const liveBar = fs.readFileSync(new URL("../web/src/views/LiveAgentBar.tsx", import.meta.url), "utf8");

  assert.match(liveBar, /<AgentStopButton key=\{primary\.id\} agentId=\{primary\.id\} className="live-bar__stop" \/>/);
  assert.doesNotMatch(liveBar, /\/api\/agents\/.*\/stop/);
});

test("the live sidebar offers stop controls for every listed agent", () => {
  const liveBar = fs.readFileSync(new URL("../web/src/views/LiveAgentBar.tsx", import.meta.url), "utf8");
  const styles = fs.readFileSync(new URL("../web/src/styles.css", import.meta.url), "utf8");

  assert.match(liveBar, /<div key=\{a\.id\} className="live-bar__pop-row">/);
  assert.match(liveBar, /<AgentStopButton agentId=\{a\.id\} className="live-bar__stop" \/>/);
  assert.match(styles, /\.live-bar__pop-row\{display:flex;align-items:center;gap:4px\}/);
});
