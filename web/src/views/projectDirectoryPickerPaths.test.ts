import assert from "node:assert/strict";
import test from "node:test";
import { projectPathBreadcrumbs } from "./projectDirectoryPickerPaths.ts";

test("builds breadcrumbs below a POSIX filesystem root", () => {
  assert.deepEqual(projectPathBreadcrumbs([{ name: "Filesystem", path: "/" }], "/work/repo"), [
    { name: "Filesystem", path: "/" },
    { name: "work", path: "/work" },
    { name: "repo", path: "/work/repo" },
  ]);
});

test("builds breadcrumbs below a Windows drive root", () => {
  assert.deepEqual(projectPathBreadcrumbs([{ name: "C drive", path: "C:\\" }], "C:\\work\\repo"), [
    { name: "C drive", path: "C:\\" },
    { name: "work", path: "C:\\work" },
    { name: "repo", path: "C:\\work\\repo" },
  ]);
});

test("uses the most specific shared root", () => {
  assert.deepEqual(projectPathBreadcrumbs([
    { name: "Workspace", path: "/workspace" },
    { name: "Projects", path: "/workspace/projects" },
  ], "/workspace/projects/open-tag"), [
    { name: "Projects", path: "/workspace/projects" },
    { name: "open-tag", path: "/workspace/projects/open-tag" },
  ]);
});

test("preserves backslashes in POSIX directory names", () => {
  assert.deepEqual(projectPathBreadcrumbs([{ name: "Shared", path: "/shared" }], "/shared/foo\\bar"), [
    { name: "Shared", path: "/shared" },
    { name: "foo\\bar", path: "/shared/foo\\bar" },
  ]);
});

test("builds breadcrumbs below a Windows UNC root", () => {
  assert.deepEqual(projectPathBreadcrumbs([{ name: "Share", path: "\\\\server\\share\\" }], "\\\\server\\share\\team\\repo"), [
    { name: "Share", path: "\\\\server\\share\\" },
    { name: "team", path: "\\\\server\\share\\team" },
    { name: "repo", path: "\\\\server\\share\\team\\repo" },
  ]);
});
