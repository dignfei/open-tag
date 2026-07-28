import { statSync } from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn, type SpawnOptions, type ChildProcess } from "node:child_process";
import { spawn as crossSpawn } from "cross-spawn";
import { applyResourceLimits } from "./resourceLimit.js";
import { createLogger } from "../log.js";

const log = createLogger("daemon:spawn");

type FileProbe = (candidate: string) => boolean;

function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

function realFile(candidate: string): boolean {
  try { return statSync(candidate).isFile(); } catch { return false; }
}

/** Resolve the exact Windows executable before cross-spawn can fall back to cmd.exe. */
export function resolveWindowsCommand(command: string, options: SpawnOptions, isFile: FileProbe = realFile): string | null {
  const env = options.env ?? process.env;
  const cwd = typeof options.cwd === "string" ? options.cwd : process.cwd();
  const hasPath = /[\\/]/.test(command);
  const rawPath = envValue(env, "PATH") ?? "";
  const directories = hasPath ? [""] : [cwd, ...rawPath.split(";")];
  const rawExtensions = envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  const extensions = path.win32.extname(command)
    ? [""]
    : ["", ...rawExtensions.split(";").filter(Boolean).map((extension) => extension.startsWith(".") ? extension : `.${extension}`)];

  for (const rawDirectory of directories) {
    const directory = rawDirectory.replace(/^"|"$/g, "") || cwd;
    const base = hasPath
      ? (path.win32.isAbsolute(command) ? command : path.win32.resolve(cwd, command))
      : path.win32.join(directory, command);
    for (const extension of extensions) {
      const candidate = base + extension;
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

export function spawnSafe(command: string, args: string[], options: SpawnOptions): ChildProcess {
  let child: ChildProcess;
  if (process.platform === "win32" && !options.shell) {
    const resolved = resolveWindowsCommand(command, options);
    // cross-spawn launches cmd.exe for an unresolved command, emitting a misleading
    // spawn event before it later converts exit 1 to ENOENT. Native spawn fails first.
    child = resolved ? crossSpawn(resolved, args, options) : nodeSpawn(command, args, options);
  } else {
    child = crossSpawn(command, args, options);
  }
  applyResourceLimits(child);
  log.debug("spawned", { pid: child.pid, cmd: command });
  return child;
}
