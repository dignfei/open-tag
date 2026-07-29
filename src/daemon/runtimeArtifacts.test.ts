import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeRuntimeArtifact } from "./runtimeArtifacts.js";

test("managed runtime artifacts stay below the agent state directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-runtime-artifact-"));
  try {
    const file = writeRuntimeArtifact(root, "test", "instructions/prompt.md", "standing prompt\n");
    assert.equal(file, path.join(root, ".runtime", "test", "instructions", "prompt.md"));
    assert.equal(readFileSync(file, "utf8"), "standing prompt\n");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.throws(() => writeRuntimeArtifact(root, "test", "../../outside", "bad"), /invalid runtime artifact path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("managed runtime artifacts reject a symlinked parent directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-runtime-artifact-link-"));
  const outside = mkdtempSync(path.join(tmpdir(), "open-tag-runtime-artifact-outside-"));
  try {
    mkdirSync(path.join(root, ".runtime"));
    symlinkSync(outside, path.join(root, ".runtime", "test"), "dir");

    assert.throws(
      () => writeRuntimeArtifact(root, "test", "instructions/prompt.md", "escaped\n"),
      /symbolic link/,
    );
    assert.equal(existsSync(path.join(outside, "instructions", "prompt.md")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
