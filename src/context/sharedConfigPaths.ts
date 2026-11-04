import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';

export const MAX_SHARED_FILE_BYTES = 1_048_576;
export const MAX_SCOPE_DEPTH = 128;

export interface SharedConfigScope {
  cwd: vscode.Uri;
  root: vscode.Uri;
  chain: vscode.Uri[];
  trusted: boolean;
}

export function codexHomeUri(home = os.homedir(), configured = process.env.CODEX_HOME): vscode.Uri {
  if (configured && !path.isAbsolute(configured)) throw new Error('CODEX_HOME must be absolute / CODEX_HOME 必须是绝对路径');
  return vscode.Uri.file(configured || path.join(home, '.codex'));
}

export function userSkillsUri(home = os.homedir()): vscode.Uri {
  return vscode.Uri.file(path.join(home, '.agents', 'skills'));
}

export function projectSkillsUri(directory: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(directory, '.agents', 'skills');
}

export function uriInside(root: vscode.Uri, candidate: vscode.Uri): boolean {
  if (root.scheme !== candidate.scheme || root.authority !== candidate.authority) return false;
  if (root.scheme === 'file') {
    const relative = path.relative(root.fsPath, candidate.fsPath);
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
  }
  return candidate.path === root.path || candidate.path.startsWith(`${root.path.replace(/\/$/u, '')}/`);
}

/** The extension host owns these paths. Never map a virtual/remote URI to the local home. */
export async function canonicalUri(uri: vscode.Uri): Promise<vscode.Uri> {
  if (uri.scheme !== 'file') throw new Error('This filesystem cannot safely resolve shared configuration / 此文件系统无法安全解析共享配置');
  return vscode.Uri.file(await fs.realpath(uri.fsPath));
}

export async function assertRealPathInside(uri: vscode.Uri, boundaries: readonly vscode.Uri[]): Promise<vscode.Uri> {
  const real = await canonicalUri(uri);
  for (const boundary of boundaries) {
    try {
      if (uriInside(await canonicalUri(boundary), real)) return real;
    } catch { /* Missing roots do not authorize anything. */ }
  }
  throw new Error('Symlink target is outside the permitted source; exact external authorization required / 链接目标越界，需精确外部授权');
}

export function isMissingFile(error: unknown): boolean {
  const code = (error as { code?: string })?.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'FileNotFound';
}

export async function readSharedText(uri: vscode.Uri, boundaries: readonly vscode.Uri[], maxBytes = MAX_SHARED_FILE_BYTES): Promise<string | undefined> {
  try {
    const pinnedBoundaries = await Promise.all(boundaries.map(canonicalUri));
    const real = await assertRealPathInside(uri, boundaries);
    if (!pinnedBoundaries.some(boundary => uriInside(boundary, real))) throw new Error('Source boundary changed / 来源边界已变化');
    const handle = await fs.open(real.fsPath, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > maxBytes) throw new Error('Shared file exceeds size limit or is not a regular file / 共享文件过大或非普通文件');
      // Bounded read, even if a file grows between stat and read.
      const bytes = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
      let size = 0;
      while (size < bytes.length) {
        const result = await handle.read(bytes, size, bytes.length - size, size);
        if (!result.bytesRead) break;
        size += result.bytesRead;
      }
      const after = await handle.stat();
      const currentReal = await canonicalUri(uri);
      if (!pinnedBoundaries.some(boundary => uriInside(boundary, currentReal))) throw new Error('Source boundary changed / 来源边界已变化');
      const current = await fs.stat(currentReal.fsPath);
      if (size > maxBytes || size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
          || before.ino !== current.ino || before.dev !== current.dev) throw new Error('Shared resource changed during read / 共享资源读取期间发生变化');
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    } finally { await handle.close(); }
  } catch (error) {
    if (isMissingFile(error)) return undefined;
    throw error;
  }
}

export async function resolveSharedScope(options: {
  cwd?: vscode.Uri;
  folders?: readonly vscode.WorkspaceFolder[];
  trusted?: boolean;
} = {}): Promise<SharedConfigScope | undefined> {
  const folders = options.folders ?? vscode.workspace.workspaceFolders ?? [];
  const cwd = options.cwd ?? (folders.length === 1 ? folders[0].uri : undefined);
  if (!cwd) return undefined;
  if (!folders.some(folder => uriInside(folder.uri, cwd))) throw new Error('Select a task directory inside one workspace folder / 请选择工作区内的任务目录');
  const trusted = options.trusted ?? vscode.workspace.isTrusted;
  if (!trusted) return { cwd, root: cwd, chain: [cwd], trusted };
  const containingFolder = folders.find(folder => uriInside(folder.uri, cwd))!;
  const realCwd = await assertRealPathInside(cwd, [containingFolder.uri]);
  const ancestors: vscode.Uri[] = [];
  let current = realCwd;
  for (let depth = 0; depth < MAX_SCOPE_DEPTH; depth++) {
    ancestors.push(current);
    try {
      // Both a .git directory and a worktree .git file mark the root; never read git config.
      await fs.lstat(vscode.Uri.joinPath(current, '.git').fsPath);
      return { cwd: realCwd, root: current, chain: ancestors.reverse(), trusted };
    } catch (error) { if (!isMissingFile(error)) throw error; }
    const parent = vscode.Uri.file(path.dirname(current.fsPath));
    if (parent.toString() === current.toString()) return { cwd: realCwd, root: realCwd, chain: [realCwd], trusted };
    current = parent;
  }
  throw new Error('Task ancestry exceeds discovery limit / 任务目录层级超出扫描上限');
}
