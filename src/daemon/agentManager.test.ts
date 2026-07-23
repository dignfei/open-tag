import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentManager, type AgentConfig } from "./agentManager.js";
import { ResourceBudget } from "./resourceBudget.js";
import type { Runtime, RuntimeCallbacks, StartOpts } from "./runtime.js";

const noPressureBudget = new ResourceBudget({ availableMemMB: () => 999999 });

const baseConfig = (agentId: string): AgentConfig => ({
  agentId,
  name: "agent",
  displayName: "Agent",
  description: "test agent",
  runtime: "fake",
  model: "default",
  serverUrl: "http://localhost:7777",
  serverId: "server-1",
  agentToken: "test-token",
});

test("deliver received during async start is consumed by the wake nudge, not re-delivered as a notice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  const sent: any[] = [];
  let initialPrompt: string | undefined;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(opts: StartOpts, cb: RuntimeCallbacks) {
      initialPrompt = opts.initialPrompt;
      cb.onSession("fake-session");
      return { deliver: (text) => delivered.push(text), stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager((msg) => sent.push(msg), {
      dataDir: root,
      binDir: root,
      deliverDebounceMs: 0,
      budget: noPressureBudget,
      runtimeResolver: () => fakeRuntime,
    });
    const start = mgr.start("agent-1", baseConfig("agent-1"));
    mgr.deliver("agent-1", "User", "dm:agent-1", true, { targetName: "dm:Agent", msgShort: "m1" });
    await start;
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The startup nudge itself drives the "check inbox" turn — the queued deliver
    // must not produce a second in-session notice (that caused double replies).
    assert.equal(delivered.length, 0);
    assert.match(initialPrompt ?? "", /open-tag message check/);
    // The reply preview still starts so the UI shows "agent is replying…".
    const previewStart = sent.find((m) => m?.type === "agent:reply" && m?.op === "start");
    assert.ok(previewStart, "expected an agent:reply start preview");
    assert.equal(previewStart.channelId, "dm:agent-1");
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deliver while the agent is running still produces a batched inbox notice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      cb.onSession("fake-session");
      return { deliver: (text) => delivered.push(text), stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager(() => {}, {
      dataDir: root,
      binDir: root,
      deliverDebounceMs: 0,
      budget: noPressureBudget,
      runtimeResolver: () => fakeRuntime,
    });
    await mgr.start("agent-1", baseConfig("agent-1"));
    mgr.deliver("agent-1", "User", "dm:agent-1", true, { targetName: "dm:Agent", msgShort: "m1" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(delivered.length, 1);
    assert.match(delivered[0]!, /inbox notice/);
    assert.match(delivered[0]!, /dm:Agent/);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("one-shot runtime start with pending delivery uses wake nudge without a second notice", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  const delivered: string[] = [];
  let initialPrompt: string | undefined;
  const fakeRuntime: Runtime = {
    name: "one-shot-test",
    oneShotWake: true,
    start(opts: StartOpts, cb: RuntimeCallbacks) {
      initialPrompt = opts.initialPrompt;
      cb.onSession("one-shot-session");
      return { deliver: (text) => delivered.push(text), stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager(() => {}, {
      dataDir: root,
      binDir: root,
      deliverDebounceMs: 3000,
      oneShotDeliverDebounceMs: 0,
      budget: noPressureBudget,
      runtimeResolver: () => fakeRuntime,
    });
    const config = { ...baseConfig("agent-2"), runtime: "one-shot-test", sessionId: "existing-session" };
    const start = mgr.start("agent-2", config);
    mgr.deliver("agent-2", "User", "dm:agent-2", true, { targetName: "dm:Agent", msgShort: "m2" });
    await start;
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.match(initialPrompt ?? "", /open-tag message check/);
    assert.match(initialPrompt ?? "", /open-tag message send/);
    assert.equal(delivered.length, 0);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent starts for the same agent are idempotent", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-agent-manager-"));
  let startCount = 0;
  const fakeRuntime: Runtime = {
    name: "fake",
    start(_opts: StartOpts, cb: RuntimeCallbacks) {
      startCount++;
      cb.onSession("fake-session");
      return { deliver: () => {}, stop: () => {} };
    },
  };

  try {
    const mgr = new AgentManager(() => {}, {
      dataDir: root,
      binDir: root,
      budget: noPressureBudget,
      runtimeResolver: () => fakeRuntime,
    });
    await Promise.all([
      mgr.start("agent-2", baseConfig("agent-2")),
      mgr.start("agent-2", baseConfig("agent-2")),
    ]);

    assert.equal(startCount, 1);
    mgr.stopAll();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
