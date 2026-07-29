import path from "node:path";
import { atomicWriteManagedFileSync } from "./stateFiles.js";

/** Atomically replace one daemon-managed runtime file below the agent state directory. */
export function writeRuntimeArtifact(stateDir: string, runtime: string, relativePath: string, content: string): string {
  const runtimeRoot = path.resolve(stateDir, ".runtime", runtime);
  const target = path.resolve(runtimeRoot, relativePath);
  if (target !== runtimeRoot && !target.startsWith(runtimeRoot + path.sep)) throw new Error("invalid runtime artifact path");
  const artifactPath = path.relative(path.resolve(stateDir), target);
  try { return atomicWriteManagedFileSync(stateDir, artifactPath, content); }
  catch (cause) {
    if (cause instanceof Error && cause.message === "invalid managed state path") throw new Error("invalid runtime artifact path", { cause });
    throw cause;
  }
}
