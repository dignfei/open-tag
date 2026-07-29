import { opendir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_PATH_LENGTH = 4096;
const MAX_ROOTS = 32;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
const DISCOVER_MAX_DEPTH = 4;
const DISCOVER_MAX_VISITED = 1_000;
const MAX_DIRECTORY_ENTRIES = 2_000;
const DISCOVER_MAX_ENTRIES = 10_000;
const DISCOVER_MAX_CHILDREN_PER_DIRECTORY = 500;
const DISCOVER_DEADLINE_MS = 3_500;

const PROJECT_MARKERS = new Set([
  ".git", "package.json", "pyproject.toml", "Cargo.toml", "go.mod",
  "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "composer.json",
]);

// These directories either routinely contain credentials/system data or are dependency/build trees
// that make browsing noisy and expensive. Dot-directories are excluded separately.
const SENSITIVE_DIRECTORY_NAMES = new Set([
  "appdata", "library", "windows", "programdata", "system volume information", "$recycle.bin",
]);
const BROWSE_EXCLUDED_DIRECTORY_NAMES = new Set([
  ...SENSITIVE_DIRECTORY_NAMES, "node_modules", "vendor", "venv", "__pycache__", "target", "dist", "build",
]);

export type ProjectDirectoryEntry = { name: string; path: string };
export type ProjectDirectoryErrorCode =
  | "project_roots_not_configured"
  | "project_path_not_shared"
  | "invalid_project_path"
  | "invalid_query"
  | "project_browser_busy";

export class ProjectDirectoryError extends Error {
  constructor(public readonly code: ProjectDirectoryErrorCode, message: string) {
    super(message);
    this.name = "ProjectDirectoryError";
  }
}

type RootContext = { lexical: string; canonical: string };
let discoverInFlight = false;

function expandHome(value: string): string {
  return value === "~" ? os.homedir() : /^~[\\/]/.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
}

function normalizedAbsolute(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new ProjectDirectoryError("invalid_project_path", "project directory is required");
  if (value.length > MAX_PATH_LENGTH) throw new ProjectDirectoryError("invalid_project_path", "project directory is too long");
  const expanded = expandHome(value.trim());
  if (!path.isAbsolute(expanded)) throw new ProjectDirectoryError("invalid_project_path", "project directory must be an absolute path");
  return path.resolve(expanded);
}

function comparable(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function isWithin(candidate: string, root: string): boolean {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isAllowedDescendant(candidate: string, root: string): boolean {
  if (!isWithin(candidate, root)) return false;
  const relative = path.relative(root, candidate);
  // The configured root itself is explicit operator authorization even when its own basename is hidden
  // or sensitive. Hidden/sensitive components below that root remain unavailable to browse and resolve.
  return relative === "" || relative.split(path.sep).every((name) => !!name && !name.startsWith(".") && !SENSITIVE_DIRECTORY_NAMES.has(name.toLowerCase()));
}

function parseRootInputs(raw = process.env.OPEN_TAG_PROJECT_ROOTS): string[] {
  const value = raw?.trim();
  if (!value) return [];
  let inputs: unknown;
  if (value.startsWith("[")) {
    try { inputs = JSON.parse(value); }
    catch { throw new ProjectDirectoryError("project_roots_not_configured", "OPEN_TAG_PROJECT_ROOTS is invalid JSON"); }
    if (!Array.isArray(inputs) || inputs.some((item) => typeof item !== "string")) {
      throw new ProjectDirectoryError("project_roots_not_configured", "OPEN_TAG_PROJECT_ROOTS must be a JSON string array");
    }
  } else {
    inputs = value.split(path.delimiter);
  }
  const roots = [...new Set((inputs as string[]).map((item) => item.trim()).filter(Boolean))];
  if (roots.length > MAX_ROOTS) throw new ProjectDirectoryError("project_roots_not_configured", `OPEN_TAG_PROJECT_ROOTS supports at most ${MAX_ROOTS} roots`);
  try { return roots.map((root) => normalizedAbsolute(root)); }
  catch { throw new ProjectDirectoryError("project_roots_not_configured", "OPEN_TAG_PROJECT_ROOTS must contain absolute paths"); }
}

async function rootContexts(): Promise<RootContext[]> {
  const configured = parseRootInputs();
  if (!configured.length) throw new ProjectDirectoryError("project_roots_not_configured", "no project roots are shared by this daemon");
  const roots: RootContext[] = [];
  for (const lexical of configured) {
    try {
      const canonical = await realpath(lexical);
      if (!(await stat(canonical)).isDirectory()) continue;
      if (!roots.some((root) => comparable(root.canonical) === comparable(canonical))) roots.push({ lexical, canonical });
    } catch { /* An unusable configured root is not exposed. */ }
  }
  if (!roots.length) throw new ProjectDirectoryError("project_roots_not_configured", "no configured project roots are accessible");
  return roots;
}

async function canonicalSharedDirectory(input: unknown, roots: RootContext[]): Promise<string> {
  const lexical = normalizedAbsolute(input);
  // Do not touch the candidate path before this check. Canonical roots are included because a configured
  // root itself may be a symlink and browser responses intentionally return canonical paths.
  if (!roots.some((root) => isAllowedDescendant(lexical, root.lexical) || isAllowedDescendant(lexical, root.canonical))) {
    throw new ProjectDirectoryError("project_path_not_shared", "project directory is outside the daemon's shared roots");
  }
  let canonical: string;
  try { canonical = await realpath(lexical); }
  catch { throw new ProjectDirectoryError("invalid_project_path", "project directory does not exist or is not accessible"); }
  if (!roots.some((root) => isAllowedDescendant(canonical, root.canonical))) {
    throw new ProjectDirectoryError("project_path_not_shared", "project directory resolves outside the daemon's shared roots");
  }
  try {
    if (!(await stat(canonical)).isDirectory()) throw new ProjectDirectoryError("invalid_project_path", "project path is not a directory");
  } catch (cause) {
    if (cause instanceof ProjectDirectoryError) throw cause;
    throw new ProjectDirectoryError("invalid_project_path", "project directory does not exist or is not accessible");
  }
  return canonical;
}

function entryName(directoryPath: string): string {
  return path.basename(directoryPath) || directoryPath;
}

function isBrowsableName(name: string): boolean {
  return !!name && !name.startsWith(".") && !BROWSE_EXCLUDED_DIRECTORY_NAMES.has(name.toLowerCase());
}

function page<T>(items: T[], cursor: number, limit: number): { values: T[]; nextCursor: number | null; truncated: boolean } {
  const values = items.slice(cursor, cursor + limit);
  const truncated = cursor + values.length < items.length;
  return { values, nextCursor: truncated ? cursor + values.length : null, truncated };
}

function pagination(cursorInput: unknown, limitInput: unknown): { cursor: number; limit: number } {
  const cursor = cursorInput === undefined ? 0 : Number(cursorInput);
  const limit = limitInput === undefined ? DEFAULT_LIMIT : Number(limitInput);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > MAX_DIRECTORY_ENTRIES) {
    throw new ProjectDirectoryError("invalid_query", `cursor must be an integer between 0 and ${MAX_DIRECTORY_ENTRIES}`);
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new ProjectDirectoryError("invalid_query", `limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return { cursor, limit };
}

export type BrowseProjectDirectoriesRequest = {
  path?: unknown;
  discover?: boolean;
  cursor?: unknown;
  limit?: unknown;
};

export type BrowseProjectDirectoriesResult =
  | { mode: "roots"; roots: ProjectDirectoryEntry[]; nextCursor: number | null; truncated: boolean }
  | { mode: "list"; path: string; directories: ProjectDirectoryEntry[]; nextCursor: number | null; truncated: boolean }
  | { mode: "discover"; path: string | null; projects: ProjectDirectoryEntry[]; nextCursor: number | null; truncated: boolean };

/** Resolve a user-configured path on the daemon host within explicitly shared roots. */
export async function resolveProjectDirectory(input: unknown): Promise<string> {
  return canonicalSharedDirectory(input, await rootContexts());
}

/** List shared roots, lazily list one directory, or discover marker-bearing projects without reading file contents. */
export async function browseProjectDirectories(request: BrowseProjectDirectoriesRequest): Promise<BrowseProjectDirectoriesResult> {
  const roots = await rootContexts();
  const { cursor, limit } = pagination(request.cursor, request.limit);
  if (!request.discover && request.path === undefined) {
    const entries = roots.map((root) => ({ name: entryName(root.canonical), path: root.canonical })).sort((a, b) => a.path.localeCompare(b.path));
    const result = page(entries, cursor, limit);
    return { mode: "roots", roots: result.values, nextCursor: result.nextCursor, truncated: result.truncated };
  }

  if (!request.discover) {
    const canonical = await canonicalSharedDirectory(request.path, roots);
    const directories: ProjectDirectoryEntry[] = [];
    let scanned = 0;
    let bounded = false;
    const deadline = Date.now() + DISCOVER_DEADLINE_MS;
    try {
      const directory = await opendir(canonical);
      for await (const entry of directory) {
        if (++scanned > MAX_DIRECTORY_ENTRIES || Date.now() >= deadline) { bounded = true; break; }
        if (entry.isDirectory() && !entry.isSymbolicLink() && isBrowsableName(entry.name)) {
          directories.push({ name: entry.name, path: path.join(canonical, entry.name) });
        }
      }
    } catch { throw new ProjectDirectoryError("invalid_project_path", "project directory is not accessible"); }
    directories.sort((a, b) => a.name.localeCompare(b.name));
    const result = page(directories, cursor, limit);
    return { mode: "list", path: canonical, directories: result.values, nextCursor: result.nextCursor, truncated: bounded || result.truncated };
  }

  if (discoverInFlight) throw new ProjectDirectoryError("project_browser_busy", "project discovery is already running");
  discoverInFlight = true;
  try {
    const selectedPath = request.path === undefined ? null : await canonicalSharedDirectory(request.path, roots);
    const starts = selectedPath ? [selectedPath] : roots.map((root) => root.canonical);
    const queue = starts.map((directory) => ({ directory, depth: 0 }));
    const seen = new Set<string>();
    const projects: ProjectDirectoryEntry[] = [];
    const needed = cursor + limit + 1;
    const deadline = Date.now() + DISCOVER_DEADLINE_MS;
    let scannedEntries = 0;
    let bounded = false;

    while (queue.length && projects.length < needed) {
      if (seen.size >= DISCOVER_MAX_VISITED || scannedEntries >= DISCOVER_MAX_ENTRIES || Date.now() >= deadline) { bounded = true; break; }
      const current = queue.shift()!;
      const key = comparable(current.directory);
      if (seen.has(key)) continue;
      seen.add(key);
      let markerFound = false;
      const children: string[] = [];
      try {
        const directory = await opendir(current.directory);
        for await (const entry of directory) {
          scannedEntries++;
          if (scannedEntries > DISCOVER_MAX_ENTRIES || Date.now() >= deadline) { bounded = true; break; }
          if (PROJECT_MARKERS.has(entry.name)) markerFound = true;
          if (current.depth < DISCOVER_MAX_DEPTH && entry.isDirectory() && !entry.isSymbolicLink() && isBrowsableName(entry.name)) {
            if (children.length < DISCOVER_MAX_CHILDREN_PER_DIRECTORY) children.push(entry.name);
            else bounded = true;
          }
        }
      }
      catch { continue; }
      if (markerFound) projects.push({ name: entryName(current.directory), path: current.directory });
      if (current.depth >= DISCOVER_MAX_DEPTH) continue;
      children.sort((a, b) => a.localeCompare(b));
      for (const child of children) {
        if (queue.length + seen.size >= DISCOVER_MAX_VISITED) { bounded = true; break; }
        queue.push({ directory: path.join(current.directory, child), depth: current.depth + 1 });
      }
    }

    const values = projects.slice(cursor, cursor + limit);
    const truncated = bounded || projects.length > cursor + values.length || queue.length > 0;
    return {
      mode: "discover", path: selectedPath, projects: values,
      nextCursor: truncated && values.length ? cursor + values.length : null,
      truncated,
    };
  } finally {
    discoverInFlight = false;
  }
}
