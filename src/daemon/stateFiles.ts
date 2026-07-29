import { constants, lstatSync, mkdirSync, openSync, closeSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

function contained(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

function targetWithin(root: string, relativePath: string): string {
  const canonicalRoot = path.resolve(root);
  const target = path.resolve(canonicalRoot, relativePath || ".");
  if (!contained(canonicalRoot, target)) throw new Error("invalid managed state path");
  return target;
}

function pathParts(root: string, target: string): string[] {
  const relative = path.relative(path.resolve(root), target);
  return relative === "" ? [] : relative.split(path.sep);
}

function assertDirectory(stat: { isDirectory(): boolean; isSymbolicLink(): boolean }, dir: string): void {
  if (stat.isSymbolicLink()) throw new Error(`managed state path contains a symbolic link: ${dir}`);
  if (!stat.isDirectory()) throw new Error(`managed state path is not a directory: ${dir}`);
}

/** Create a directory below an existing trusted root without following symlink components. */
export function ensureManagedDirectorySync(root: string, relativePath: string): string {
  const canonicalRoot = path.resolve(root);
  assertDirectory(lstatSync(canonicalRoot), canonicalRoot);
  const target = targetWithin(canonicalRoot, relativePath);
  let current = canonicalRoot;
  for (const part of pathParts(canonicalRoot, target)) {
    current = path.join(current, part);
    try { mkdirSync(current, { mode: 0o700 }); }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    assertDirectory(lstatSync(current), current);
  }
  return target;
}

/** Async variant used by workspace and agent lifecycle operations. */
export async function ensureManagedDirectory(root: string, relativePath: string): Promise<string> {
  const canonicalRoot = path.resolve(root);
  assertDirectory(await lstat(canonicalRoot), canonicalRoot);
  const target = targetWithin(canonicalRoot, relativePath);
  let current = canonicalRoot;
  for (const part of pathParts(canonicalRoot, target)) {
    current = path.join(current, part);
    try { await mkdir(current, { mode: 0o700 }); }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    assertDirectory(await lstat(current), current);
  }
  return target;
}

/** Validate existing parent directories without creating them; used before destructive operations. */
export async function managedFilePath(root: string, relativePath: string): Promise<string> {
  const canonicalRoot = path.resolve(root);
  assertDirectory(await lstat(canonicalRoot), canonicalRoot);
  const target = targetWithin(canonicalRoot, relativePath);
  if (target === canonicalRoot) throw new Error("managed state file path cannot be the root directory");
  let current = canonicalRoot;
  for (const part of pathParts(canonicalRoot, path.dirname(target))) {
    current = path.join(current, part);
    assertDirectory(await lstat(current), current);
  }
  return target;
}

function tempPath(target: string): string {
  return `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
}

/** Atomically replace a managed file. A final symlink is replaced, never followed. */
export function atomicWriteManagedFileSync(root: string, relativePath: string, content: string, mode = 0o600): string {
  const target = targetWithin(root, relativePath);
  ensureManagedDirectorySync(root, path.relative(path.resolve(root), path.dirname(target)));
  const temp = tempPath(target);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    writeFileSync(fd, content, "utf8");
    closeSync(fd);
    fd = undefined;
    renameSync(temp, target);
  } catch (cause) {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
    try { rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw cause;
  }
  return target;
}

/** Async atomic replacement for MEMORY.md and workspace writes. */
export async function atomicWriteManagedFile(root: string, relativePath: string, content: string, mode = 0o600): Promise<string> {
  const target = targetWithin(root, relativePath);
  await ensureManagedDirectory(root, path.relative(path.resolve(root), path.dirname(target)));
  const temp = tempPath(target);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    await handle.writeFile(content, "utf8");
    await handle.close();
    handle = undefined;
    await rename(temp, target);
  } catch (cause) {
    if (handle) try { await handle.close(); } catch { /* best effort */ }
    try { await rm(temp, { force: true }); } catch { /* best effort */ }
    throw cause;
  }
  return target;
}

/** Read a regular file only when every path component resolves within the managed root. */
export async function readManagedFile(root: string, relativePath: string, maxBytes?: number): Promise<Buffer> {
  const canonicalRoot = await realpath(path.resolve(root));
  const rootStat = await lstat(path.resolve(root));
  assertDirectory(rootStat, path.resolve(root));
  const target = targetWithin(root, relativePath);
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink()) throw new Error(`managed state file is a symbolic link: ${target}`);
  if (!targetStat.isFile()) throw new Error(`managed state path is not a file: ${target}`);
  const canonicalTarget = await realpath(target);
  if (!contained(canonicalRoot, canonicalTarget)) throw new Error("managed state path escapes its root");
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (maxBytes !== undefined) {
      const openedStat = await handle.stat();
      if (openedStat.size > maxBytes) throw new Error(`file too large (${openedStat.size} bytes, max ${maxBytes})`);
    }
    return await handle.readFile();
  }
  finally { await handle.close(); }
}
