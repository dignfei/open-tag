import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { browseProjectDirectories, ProjectDirectoryError, resolveProjectDirectory } from "./projectDirectory.js";

function withRoots(roots: string[]): () => void {
  const before = process.env.OPEN_TAG_PROJECT_ROOTS;
  process.env.OPEN_TAG_PROJECT_ROOTS = JSON.stringify(roots);
  return () => {
    if (before === undefined) delete process.env.OPEN_TAG_PROJECT_ROOTS;
    else process.env.OPEN_TAG_PROJECT_ROOTS = before;
  };
}

test("project resolution is fail-closed, canonical, and cannot escape shared roots", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "open-tag-project-dir-"));
  const root = path.join(base, "shared");
  const outside = path.join(base, "outside");
  const project = path.join(root, "project");
  const link = path.join(root, "project-link");
  const escape = path.join(root, "escape");
  mkdirSync(project, { recursive: true });
  mkdirSync(outside);
  symlinkSync(project, link, "dir");
  symlinkSync(outside, escape, "dir");
  const restore = withRoots([root]);
  try {
    assert.equal(await resolveProjectDirectory(project), await realpath(project));
    assert.equal(await resolveProjectDirectory(`  ${link}  `), await realpath(project));
    await assert.rejects(resolveProjectDirectory("relative/project"), /absolute path/);
    await assert.rejects(resolveProjectDirectory(path.join(root, "missing")), /does not exist or is not accessible/);
    await assert.rejects(resolveProjectDirectory(path.join(outside, "missing")), /outside.*shared roots/);
    await assert.rejects(resolveProjectDirectory(escape), /resolves outside.*shared roots/);
    const file = path.join(root, "file.txt");
    writeFileSync(file, "not a directory");
    await assert.rejects(resolveProjectDirectory(file), /not a directory/);
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("outside existing and missing paths share the same pre-filesystem rejection oracle", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "open-tag-project-prefix-"));
  const root = path.join(base, "shared");
  const collision = path.join(base, "shared-evil");
  mkdirSync(root); mkdirSync(collision);
  const restore = withRoots([root]);
  const rejected = async (candidate: string) => {
    try { await resolveProjectDirectory(candidate); return null; }
    catch (error) { return error as ProjectDirectoryError; }
  };
  try {
    const existing = await rejected(collision);
    const missing = await rejected(path.join(base, "never-created"));
    assert.equal(existing?.code, "project_path_not_shared");
    assert.equal(missing?.code, "project_path_not_shared");
    assert.equal(existing?.message, missing?.message);
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("a configured root symlink returns canonical paths that resolve on the next roundtrip", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "open-tag-project-root-link-"));
  const actual = path.join(base, "actual");
  const alias = path.join(base, "alias");
  const child = path.join(actual, "child");
  mkdirSync(child, { recursive: true });
  symlinkSync(actual, alias, "dir");
  const restore = withRoots([alias]);
  try {
    const roots = await browseProjectDirectories({});
    assert.equal(roots.mode, "roots");
    const canonicalRoot = await realpath(actual);
    assert.equal(roots.roots[0]?.path, canonicalRoot);
    assert.equal(await resolveProjectDirectory(path.join(canonicalRoot, "child")), await realpath(child));
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("manual resolution rejects hidden and sensitive descendants unless they are explicitly shared roots", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "open-tag-project-sensitive-"));
  const home = path.join(base, "home");
  const ssh = path.join(home, ".ssh");
  const library = path.join(home, "Library");
  mkdirSync(ssh, { recursive: true });
  mkdirSync(library);
  let restore = withRoots([home]);
  try {
    await assert.rejects(resolveProjectDirectory(ssh), /outside.*shared roots/);
    await assert.rejects(resolveProjectDirectory(library), /outside.*shared roots/);
  } finally { restore(); }

  restore = withRoots([ssh]);
  try { assert.equal(await resolveProjectDirectory(ssh), await realpath(ssh)); }
  finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("project roots are mandatory and input bounds fail loudly", async () => {
  const before = process.env.OPEN_TAG_PROJECT_ROOTS;
  delete process.env.OPEN_TAG_PROJECT_ROOTS;
  try {
    await assert.rejects(resolveProjectDirectory("/tmp/project"), /no project roots are shared/);
    await assert.rejects(browseProjectDirectories({}), /no project roots are shared/);
  } finally {
    if (before !== undefined) process.env.OPEN_TAG_PROJECT_ROOTS = before;
  }
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-project-input-"));
  const restore = withRoots([root]);
  try {
    await assert.rejects(resolveProjectDirectory(""), /required/);
    await assert.rejects(resolveProjectDirectory(123), /required/);
    await assert.rejects(resolveProjectDirectory("/" + "x".repeat(4096)), /too long/);
    await assert.rejects(browseProjectDirectories({ cursor: -1 }), /cursor/);
    await assert.rejects(browseProjectDirectories({ limit: 201 }), /limit/);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});

test("root parsing accepts delimiter and JSON forms, deduplicates roots, and rejects invalid/unusable config", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "open-tag-project-root-config-"));
  const first = path.join(base, "first"), second = path.join(base, "second"), file = path.join(base, "file");
  mkdirSync(first); mkdirSync(second); writeFileSync(file, "not a directory");
  const before = process.env.OPEN_TAG_PROJECT_ROOTS;
  try {
    process.env.OPEN_TAG_PROJECT_ROOTS = `${first}${path.delimiter}${second}`;
    let roots = await browseProjectDirectories({});
    assert.equal(roots.mode, "roots"); assert.equal(roots.roots.length, 2);
    process.env.OPEN_TAG_PROJECT_ROOTS = JSON.stringify([first, first]);
    roots = await browseProjectDirectories({});
    assert.equal(roots.mode, "roots"); assert.equal(roots.roots.length, 1);
    process.env.OPEN_TAG_PROJECT_ROOTS = "[not-json";
    await assert.rejects(browseProjectDirectories({}), /invalid JSON/);
    process.env.OPEN_TAG_PROJECT_ROOTS = JSON.stringify([file]);
    await assert.rejects(browseProjectDirectories({}), /no configured project roots are accessible/);
  } finally {
    if (before === undefined) delete process.env.OPEN_TAG_PROJECT_ROOTS;
    else process.env.OPEN_TAG_PROJECT_ROOTS = before;
    rmSync(base, { recursive: true, force: true });
  }
});

test("browser lists only safe directories with stable bounded pagination", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "open-tag-project-browse-"));
  const root = path.join(base, "shared");
  const outside = path.join(base, "outside");
  for (const name of ["alpha", "bravo", ".hidden", ".ssh", "Library", "node_modules"]) mkdirSync(path.join(root, name), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, path.join(root, "linked-outside"), "dir");
  const restore = withRoots([root]);
  try {
    const roots = await browseProjectDirectories({});
    const canonicalRoot = await realpath(root);
    assert.deepEqual(roots, { mode: "roots", roots: [{ name: "shared", path: canonicalRoot }], nextCursor: null, truncated: false });
    const first = await browseProjectDirectories({ path: root, limit: 1 });
    assert.deepEqual(first, { mode: "list", path: canonicalRoot, directories: [{ name: "alpha", path: await realpath(path.join(root, "alpha")) }], nextCursor: 1, truncated: true });
    const second = await browseProjectDirectories({ path: root, cursor: 1, limit: 10 });
    assert.deepEqual(second, { mode: "list", path: canonicalRoot, directories: [{ name: "bravo", path: await realpath(path.join(root, "bravo")) }], nextCursor: null, truncated: false });
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("discovery checks marker names only, skips symlinks and hidden trees, and is depth bounded", async () => {
  const base = mkdtempSync(path.join(tmpdir(), "open-tag-project-discover-"));
  const root = path.join(base, "shared");
  const first = path.join(root, "first");
  const nested = path.join(root, "group", "nested");
  const hidden = path.join(root, ".hidden-project");
  const outside = path.join(base, "outside-project");
  const depth4 = path.join(root, "d1", "d2", "d3", "d4");
  const depth5 = path.join(depth4, "d5");
  for (const directory of [first, nested, hidden, outside, depth5]) mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(first, "package.json"), "this content is irrelevant and intentionally invalid");
  mkdirSync(path.join(nested, ".git"));
  writeFileSync(path.join(hidden, "pyproject.toml"), "");
  writeFileSync(path.join(outside, "go.mod"), "");
  writeFileSync(path.join(depth4, "Cargo.toml"), "");
  writeFileSync(path.join(depth5, "go.mod"), "");
  symlinkSync(outside, path.join(root, "linked-project"), "dir");
  const restore = withRoots([root]);
  try {
    const result = await browseProjectDirectories({ discover: true, limit: 20 });
    assert.equal(result.mode, "discover");
    assert.deepEqual(result.projects.map((project) => project.path).sort(), await Promise.all([first, nested, depth4].map((directory) => realpath(directory))).then((paths) => paths.sort()));
    assert.equal(result.truncated, false);
  } finally {
    restore();
    rmSync(base, { recursive: true, force: true });
  }
});

test("discovery caps per-directory fanout, reports truncation, and rejects concurrent scans", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "open-tag-project-discover-bound-"));
  for (let i = 0; i < 501; i++) mkdirSync(path.join(root, `child-${String(i).padStart(3, "0")}`));
  const restore = withRoots([root]);
  try {
    const first = browseProjectDirectories({ discover: true, limit: 1 });
    const second = browseProjectDirectories({ discover: true, limit: 1 });
    const concurrent = await Promise.allSettled([first, second]);
    assert.equal(concurrent.filter((result) => result.status === "rejected" && result.reason instanceof ProjectDirectoryError && result.reason.code === "project_browser_busy").length, 1);
    const completed = concurrent.find((result): result is PromiseFulfilledResult<Awaited<typeof first>> => result.status === "fulfilled")!;
    assert.equal(completed.value.mode, "discover");
    assert.equal(completed.value.truncated, true);
  } finally {
    restore();
    rmSync(root, { recursive: true, force: true });
  }
});
