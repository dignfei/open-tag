// Regression for #163: a missing Codex binary must not crash the daemon process.
// Run: npx tsx --test src/daemon/codexRuntime.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildCodexArgs, codexRuntime } from "./codexRuntime.js";
import { AgentManager, type AgentConfig } from "./agentManager.js";
import { ResourceBudget } from "./resourceBudget.js";

const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;
// Full-suite parallelism can delay spawning the fake app-server well beyond one second.
// This guards the test harness only; the production delivery ACK timeout is unchanged.
const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for runtime callback");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

test("missing codex binary reports offline instead of crashing daemon", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-codex-missing-"));
  const events: { activity: string; detail?: string }[] = [];
  let exitCode: number | null | undefined;
  const admissions: Array<Error | undefined> = [];

  try {
    const session = codexRuntime.start({
      cwd: root,
      stateDir: root,
      env: { PATH: root },
      systemPrompt: "system",
      initialPrompt: "start",
    }, {
      onSession: () => {},
      onInitialTurnAdmission: (error) => admissions.push(error),
      onActivity: (activity, detail) => events.push({ activity, detail }),
      onTrajectory: () => {},
      onExit: (code) => { exitCode = code; },
      log,
    });
    const runningDelivery = assert.rejects(session.deliver("queued while codex is starting"));

    await new Promise((resolve) => setTimeout(resolve, 50));
    await runningDelivery;
    session.stop();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  assert.equal(exitCode, 1);
  assert.equal(admissions.length, 1);
  assert.ok(admissions[0] instanceof Error);
  assert.ok(
    events.some((e) => e.activity === "offline" && /codex not found/.test(e.detail ?? "")),
    "expected a visible offline activity for missing codex",
  );
});

test("initial admission rejects exactly once when Codex turn/start RPC rejects", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-codex-turn-reject-"));
  const executable = path.join(root, "codex");
  const admissions: Array<Error | undefined> = [];
  let session: ReturnType<typeof codexRuntime.start> | undefined;
  try {
    writeFileSync(executable, `#!${process.execPath}\nconst readline = require("node:readline");\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on("line", (line) => {\n  const request = JSON.parse(line);\n  if (request.id === undefined) return;\n  if (request.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));\n  else if (request.method === "thread/start") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-test" } } }));\n  else if (request.method === "turn/start") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "turn rejected" } }));\n});\n`);
    chmodSync(executable, 0o755);
    session = codexRuntime.start({ cwd: root, stateDir: root, env: { PATH: root }, systemPrompt: "system", initialPrompt: "start" }, {
      onSession: () => {},
      onInitialTurnAdmission: (error) => admissions.push(error),
      onActivity: () => {},
      onTrajectory: () => {},
      onExit: () => {},
      log,
    });

    await waitFor(() => admissions.length > 0);
    assert.equal(admissions.length, 1);
    assert.match(admissions[0]?.message ?? "", /turn rejected/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(admissions.length, 1, "RPC failure and process cleanup must not settle admission twice");
  } finally {
    session?.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("running Codex turn/start rejection NACKs, clears the fence, and executes the same-id retry", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-codex-running-retry-"));
  const executable = path.join(root, "codex");
  const agentId = "codex-running-retry";
  const turnCountFile = path.join(root, agentId, "turn-count");
  const config: AgentConfig = {
    agentId,
    name: "codex",
    displayName: "Codex",
    description: "test",
    runtime: "codex",
    model: "default",
    serverUrl: "http://localhost:7777",
    serverId: "server-1",
    agentToken: "test-token",
  };
  const mgr = new AgentManager(() => {}, {
    dataDir: root,
    binDir: root,
    deliverDebounceMs: 0,
    budget: new ResourceBudget({ availableMemMB: () => 999999 }),
    runtimeResolver: () => codexRuntime,
  });
  try {
    writeFileSync(executable, `#!${process.execPath}\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst readline = require("node:readline");\nlet turns = 0;\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on("line", (line) => {\n  const request = JSON.parse(line);\n  if (request.id === undefined) return;\n  if (request.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));\n  else if (request.method === "thread/start") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-test" } } }));\n  else if (request.method === "turn/start") {\n    turns += 1;\n    fs.writeFileSync(path.join(process.cwd(), "turn-count"), String(turns));\n    if (turns === 2) console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "running turn rejected" } }));\n    else {\n      console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-" + turns } } }));\n      console.log(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-test", turn: { status: "completed" } } }));\n    }\n  }\n});\n`);
    chmodSync(executable, 0o755);
    await mgr.start(agentId, config);
    await waitFor(() => {
      try { return Number(readFileSync(turnCountFile, "utf8")) >= 1; } catch { return false; }
    });

    const meta = { turnId: "turn-running", deliveryId: `turn-running:${agentId}` };
    const rejected = mgr.deliver(agentId, "Alice", "channel-1", false, meta);
    await assert.rejects(rejected, /running turn rejected/);

    const retry = mgr.deliver(agentId, "Alice", "channel-1", false, meta);
    assert.notEqual(retry, rejected, "a protocol-level NACK must clear the durable-id fence");
    await retry;
    await waitFor(() => {
      try { return Number(readFileSync(turnCountFile, "utf8")) >= 3; } catch { return false; }
    });
  } finally {
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});

test("buildCodexArgs pins the validated app-server defaults", () => {
  assert.deepEqual(buildCodexArgs(), [
    "app-server", "--listen", "stdio://",
    "-c", "web_search_mode=live",
    "-c", "approval_policy=never",
    "-c", "sandbox_mode=danger-full-access",
    "-c", "model_reasoning_summary=detailed",
  ]);
});

test("daemon spawn passes the default app-server args and IS_SANDBOX=1 to codex", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-codex-spawn-args-"));
  const executable = path.join(root, "codex");
  const dumpFile = path.join(root, "spawn-dump.json");
  const agentId = "codex-spawn-args";
  const config: AgentConfig = {
    agentId,
    name: "codex",
    displayName: "Codex",
    description: "test",
    runtime: "codex",
    model: "default",
    serverUrl: "http://localhost:7777",
    serverId: "server-1",
    agentToken: "test-token",
  };
  const mgr = new AgentManager(() => {}, {
    dataDir: root,
    binDir: root,
    deliverDebounceMs: 0,
    budget: new ResourceBudget({ availableMemMB: () => 999999 }),
    runtimeResolver: () => codexRuntime,
  });
  try {
    writeFileSync(executable, `#!${process.execPath}\nconst fs = require("node:fs");\nfs.writeFileSync(process.env.SPAWN_DUMP, JSON.stringify({ argv: process.argv.slice(2), isSandbox: process.env.IS_SANDBOX ?? null }));\nconst readline = require("node:readline");\nconst rl = readline.createInterface({ input: process.stdin });\nrl.on("line", (line) => {\n  const request = JSON.parse(line);\n  if (request.id === undefined) return;\n  if (request.method === "initialize") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));\n  else if (request.method === "thread/start") console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { thread: { id: "thread-args" } } }));\n  else if (request.method === "turn/start") {\n    console.log(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { turn: { id: "turn-args" } } }));\n    console.log(JSON.stringify({ jsonrpc: "2.0", method: "turn/completed", params: { threadId: "thread-args", turn: { status: "completed" } } }));\n  }\n});\n`);
    chmodSync(executable, 0o755);
    process.env.SPAWN_DUMP = dumpFile;
    await mgr.start(agentId, config);
    await waitFor(() => {
      try { return readFileSync(dumpFile, "utf8").length > 0; } catch { return false; }
    });
    const dump = JSON.parse(readFileSync(dumpFile, "utf8"));
    for (const value of [
      "web_search_mode=live",
      "approval_policy=never",
      "sandbox_mode=danger-full-access",
      "model_reasoning_summary=detailed",
    ]) {
      const i = dump.argv.indexOf(value);
      assert.ok(i > 0 && dump.argv[i - 1] === "-c", `expected spawn argv to contain -c ${value}`);
    }
    assert.equal(dump.isSandbox, "1", "daemon-spawned runtimes must see IS_SANDBOX=1 (claude root check)");
  } finally {
    delete process.env.SPAWN_DUMP;
    mgr.stopAll();
    rmSync(root, { recursive: true, force: true });
  }
});
