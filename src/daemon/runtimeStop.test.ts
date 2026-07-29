import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Runtime, RuntimeCallbacks } from "./runtime.js";
import { copilotRuntime } from "./copilotRuntime.js";
import { cursorRuntime } from "./cursorRuntime.js";
import { hermesRuntime } from "./hermesRuntime.js";
import { kimiRuntime } from "./kimiRuntime.js";
import { opencodeRuntime } from "./opencodeRuntime.js";
import { piRuntime } from "./piRuntime.js";

const adapters: Array<{ command: string; runtime: Runtime }> = [
  { command: "copilot", runtime: copilotRuntime },
  { command: "cursor-agent", runtime: cursorRuntime },
  { command: "hermes", runtime: hermesRuntime },
  { command: "kimi", runtime: kimiRuntime },
  { command: "opencode", runtime: opencodeRuntime },
  { command: "pi", runtime: piRuntime },
];

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

function fakeCommand(binDir: string, command: string, body: string): void {
  const file = path.join(binDir, command);
  writeFileSync(file, `#!/bin/sh\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
}

function callbacks(admissions: Array<Error | undefined>, activities: string[], exits: Array<number | null>): RuntimeCallbacks {
  return {
    onSession: () => {},
    onInitialTurnAdmission: (error) => admissions.push(error),
    onActivity: (activity) => activities.push(activity),
    onTrajectory: () => {},
    onExit: (code) => exits.push(code),
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any,
  };
}

test("one-shot runtime stop waits for a live child exit and reports it exactly once", async (t) => {
  for (const adapter of adapters) await t.test(adapter.runtime.name, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `open-tag-${adapter.runtime.name}-stop-live-`));
    const binDir = path.join(root, "bin");
    const stateDir = path.join(root, "state");
    mkdirSync(binDir); mkdirSync(stateDir);
    fakeCommand(binDir, adapter.command, "exec /bin/sleep 30");
    const admissions: Array<Error | undefined> = [];
    const activities: string[] = [];
    const exits: Array<number | null> = [];
    try {
      const session = adapter.runtime.start({
        cwd: root, stateDir, env: { PATH: binDir, HOME: root }, systemPrompt: "system", initialPrompt: "start",
      }, callbacks(admissions, activities, exits));
      await waitFor(() => admissions.length === 1, `${adapter.runtime.name} initial admission`);
      assert.equal(admissions[0], undefined);
      assert.equal(exits.length, 0);
      session.stop();
      await waitFor(() => exits.length === 1, `${adapter.runtime.name} child exit`);
      session.stop();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(exits.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("one-shot runtime stop completes immediately after its turn process is already idle", async (t) => {
  for (const adapter of adapters) await t.test(adapter.runtime.name, async () => {
    const root = mkdtempSync(path.join(tmpdir(), `open-tag-${adapter.runtime.name}-stop-idle-`));
    const binDir = path.join(root, "bin");
    const stateDir = path.join(root, "state");
    mkdirSync(binDir); mkdirSync(stateDir);
    fakeCommand(binDir, adapter.command, "exit 0");
    const admissions: Array<Error | undefined> = [];
    const activities: string[] = [];
    const exits: Array<number | null> = [];
    try {
      const session = adapter.runtime.start({
        cwd: root, stateDir, env: { PATH: binDir, HOME: root }, systemPrompt: "system", initialPrompt: "start",
      }, callbacks(admissions, activities, exits));
      await waitFor(() => activities.includes("online"), `${adapter.runtime.name} idle state`);
      assert.equal(exits.length, 0, "clean one-shot turn exit keeps the reusable runtime session alive");
      session.stop();
      assert.deepEqual(exits, [0]);
      session.stop();
      assert.deepEqual(exits, [0]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
