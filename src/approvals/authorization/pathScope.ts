import * as path from 'node:path';
import { lstat, readlink, realpath } from 'node:fs/promises';
import * as vscode from 'vscode';

export function isPathInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Preserve symlink/.. traversal for the filesystem to resolve. path.resolve or
 * path.join would collapse it lexically and could hide a workspace escape. */
export function joinUnresolvedPath(base: string, ...parts: string[]): string {
  return parts.reduce((current, part) => path.isAbsolute(part) ? part : `${current}${path.sep}${part}`, base);
}

export async function canonicalPath(value: string, remainingLinks = 40): Promise<string> {
  if (remainingLinks <= 0) throw new Error('Too many symbolic links while resolving command scope.');
  const tail: string[] = [];
  let cursor = joinUnresolvedPath(process.cwd(), value);
  for (;;) {
    try { return path.join(await realpath(cursor), ...tail.reverse()); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      // realpath fails for a dangling link too. Preserve the link's target
      // instead of treating its spelling as an ordinary nonexistent child.
      const info = await lstat(cursor).catch((statError: NodeJS.ErrnoException) => {
        if (statError.code !== 'ENOENT') throw statError;
        return undefined;
      });
      if (info?.isSymbolicLink()) {
        return canonicalPath(joinUnresolvedPath(path.dirname(cursor), await readlink(cursor), ...tail.reverse()), remainingLinks - 1);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      tail.push(path.basename(cursor)); cursor = parent;
    }
  }
}

export async function findCanonicalWorkspaceFolder(cwdPath: string): Promise<{
  folder: vscode.WorkspaceFolder;
  realPath: string;
} | undefined> {
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const realRoot = await realpath(folder.uri.fsPath);
    if (isPathInside(realRoot, cwdPath)) return { folder, realPath: realRoot };
  }
  return undefined;
}
