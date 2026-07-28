import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveWindowsCommand } from "./spawnSafe.js";

test("Windows command resolution honors case-insensitive Path and PathExt", () => {
  const candidates: string[] = [];
  const resolved = resolveWindowsCommand("claude", {
    cwd: "C:\\agents\\one",
    env: { Path: "C:\\tools;\"C:\\Program Files\\Node\"", PathExt: ".EXE;.CMD" },
  }, (candidate) => {
    candidates.push(candidate);
    return candidate === "C:\\Program Files\\Node\\claude.CMD";
  });

  assert.equal(resolved, "C:\\Program Files\\Node\\claude.CMD");
  assert.ok(candidates.includes("C:\\agents\\one\\claude.EXE"));
  assert.ok(candidates.includes("C:\\tools\\claude.CMD"));
});

test("Windows command resolution handles explicit relative paths and missing commands", () => {
  assert.equal(resolveWindowsCommand("bin\\hermes.cmd", { cwd: "C:\\workspace", env: {} }, (candidate) => {
    return candidate === "C:\\workspace\\bin\\hermes.cmd";
  }), "C:\\workspace\\bin\\hermes.cmd");

  assert.equal(resolveWindowsCommand("missing-runtime", {
    cwd: "C:\\workspace",
    env: { PATH: "C:\\empty", PATHEXT: ".EXE;.CMD" },
  }, () => false), null);
});
