export interface ProjectDirectoryEntry {
  name: string;
  path: string;
}

function comparable(path: string): string {
  return /^[A-Za-z]:[\\/]/.test(path) ? path.toLowerCase() : path;
}

function isWithin(rootPath: string, candidatePath: string): boolean {
  const root = comparable(rootPath);
  const candidate = comparable(candidatePath);
  if (candidate === root) return true;
  const trimmedRoot = root.replace(/[\\/]+$/, "");
  if (!trimmedRoot) return candidate.startsWith("/");
  return candidate.startsWith(trimmedRoot + "/") || candidate.startsWith(trimmedRoot + "\\");
}

export function projectPathBreadcrumbs(roots: ProjectDirectoryEntry[], currentPath: string): ProjectDirectoryEntry[] {
  const root = [...roots].sort((a, b) => b.path.length - a.path.length).find((entry) => isWithin(entry.path, currentPath));
  if (!root) return [{ name: currentPath, path: currentPath }];
  const separator = currentPath.includes("\\") && !currentPath.includes("/") ? "\\" : "/";
  const relative = separator === "\\"
    ? currentPath.slice(root.path.length).replace(/^\\+/, "")
    : currentPath.slice(root.path.length).replace(/^\/+/, "");
  if (!relative) return [root];
  let path = root.path.replace(/[\\/]+$/, "");
  return [root, ...relative.split(separator).filter(Boolean).map((name) => {
    path = `${path}${separator}${name}`;
    return { name, path };
  })];
}
