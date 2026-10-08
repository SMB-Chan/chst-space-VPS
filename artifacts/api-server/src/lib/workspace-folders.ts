import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * Folder-name derivation shared by the project registry and the file browser.
 * Both sides must agree on the mapping so deleting one side can find and
 * remove the other. This mirrors the historical normalization inside
 * createProjectFolder; changing it orphans existing folder/project pairs.
 */
export function projectNameToFolder(name: string): string {
  const safe = name
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .slice(0, 80);
  return safe || `project-${Date.now()}`;
}

function isMissingPathError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Resolve `relPath` under `rootDir` and make sure it stays inside the root
 * both lexically and after following symlinks. A symlink planted in the
 * workspace (by the OpenCode container, a cloned repository, or an agent)
 * must not let the API read or write files outside it, e.g.
 * /proc/self/environ. The deepest existing ancestor is checked so paths that
 * are about to be created are covered too.
 */
export function resolveInsideRoot(
  rootDir: string,
  relPath: string,
  message: string,
): string {
  const root = path.resolve(rootDir);
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(message);
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (err) {
    if (isMissingPathError(err)) return abs;
    throw err;
  }
  let probe = abs;
  for (;;) {
    let real: string;
    try {
      real = realpathSync(probe);
    } catch (err) {
      if (!isMissingPathError(err)) throw err;
      const parent = path.dirname(probe);
      if (parent === probe) return abs;
      probe = parent;
      continue;
    }
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new Error(message);
    }
    return abs;
  }
}
