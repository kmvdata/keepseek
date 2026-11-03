import * as path from 'node:path';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { DraftRun } from '../../shared/types';
import { createControlledEnvironment } from '../../runs/executionEnvironment';
import { analyzeCommand } from './commandSemantics';
import { canonicalPath, isPathInside, joinUnresolvedPath } from './pathScope';
import { authorizationReason, type AuthorizationReason } from './reasons';

export interface CommandScope {
  externalUris: string[];
  uncertain: boolean;
  reasons: string[];
  diagnostics: AuthorizationReason[];
  /** In-memory binding for exact grants; includes live resolution, never raw env values. */
  fingerprint: string;
}

export async function inspectDraftRunScope(run: Pick<DraftRun, 'spec'>): Promise<CommandScope> {
  const parsed = analyzeCommand(run.spec);
  const diagnostics = [...parsed.reasons];
  const roots = await Promise.all((vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file')
    .map(f => canonicalPath(f.uri.fsPath)));
  const cwd = vscode.Uri.parse(run.spec.cwdUri).fsPath;
  const external = new Set<string>();
  const resolvedPaths: string[] = [];
  const check = async (value: string) => {
    try {
      const resolved = await canonicalPath(value);
      resolvedPaths.push(resolved);
      if (!roots.some(root => isPathInside(root, resolved))) external.add(vscode.Uri.file(resolved).toString());
    } catch {
      diagnostics.push(authorizationReason('path_resolution', value,
        'The path cannot be resolved reliably.', '无法可靠解析该路径。'));
    }
  };
  await check(cwd);
  for (const operand of parsed.arguments) {
    if (!['read_path', 'write_path', 'cwd', 'repository', 'script'].includes(operand.role)) continue;
    if (operand.value === '-' || operand.value === '') continue;
    // Never reinterpret Windows drive/UNC paths as POSIX workspace filenames.
    if (process.platform !== 'win32' && /^(?:[A-Za-z]:|\\\\)/u.test(operand.value)) {
      diagnostics.push(authorizationReason('foreign_path', operand.value,
        'This platform cannot resolve the supplied Windows path.', '当前平台无法解析该 Windows 路径。'));
      continue;
    }
    if (process.platform !== 'win32' && operand.cwdChanges.some(value => /^(?:[A-Za-z]:|\\\\)/u.test(value))) {
      diagnostics.push(authorizationReason('foreign_path', operand.cwdChanges.join(', '),
        'This platform cannot resolve the supplied Windows working directory.', '当前平台无法解析该 Windows 工作目录。'));
      continue;
    }
    const base = joinUnresolvedPath(cwd, ...operand.cwdChanges.filter(Boolean));
    await check(joinUnresolvedPath(base, operand.value));
  }
  const env = createControlledEnvironment(run.spec.env);
  const executable = await resolveExecutable(run.spec.executable, cwd, env);
  if (!executable?.trusted) diagnostics.push(authorizationReason('executable_identity', run.spec.executable,
    'The resolved executable is not a verified system command; its basename is not authority.',
    '解析后的可执行文件不是已核实的系统命令；文件名不能作为授权依据。'));
  // Explicit executable paths are also filesystem targets (PATH-selected system
  // binaries are runtime dependencies, not workspace operand grants).
  if (/[/\\]/u.test(run.spec.executable)) {
    if (!executable?.trusted) await check(joinUnresolvedPath(cwd, run.spec.executable));
  }
  const externalUris = [...external].sort();
  const fingerprint = createHash('sha256').update(JSON.stringify({
    version: 1, executable, env, roots, resolvedPaths, externalUris, diagnostics
  })).digest('hex');
  return { externalUris, uncertain: diagnostics.length > 0, diagnostics,
    reasons: diagnostics.map(reason => reason.message), fingerprint };
}

/** Match spawn's POSIX PATH lookup, including relative/empty entries. Windows
 * search order/PATHEXT is deliberately not approximated; it requires a grant. */
async function resolveExecutable(executable: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{
  path: string; identity: string; trusted: boolean;
} | undefined> {
  if (process.platform === 'win32') return undefined;
  const candidates = executable.includes('/') ? [joinUnresolvedPath(cwd, executable)]
    : (env.PATH ?? '/usr/bin:/bin').split(path.delimiter).map(dir => joinUnresolvedPath(cwd, dir, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile()) continue;
      // OS-owned system locations or the running extension host binary only.
      // A workspace/PATH shim named `cat`/`git` never gains their authority.
      const systemRoots = await Promise.all(['/bin', '/usr/bin'].map(dir => realpath(dir)));
      const system = info.uid === 0 && (info.mode & 0o022) === 0
        && systemRoots.some(root => path.dirname(resolved) === root);
      const hostRuntime = resolved === await realpath(process.execPath);
      const matchingName = path.basename(resolved) === path.basename(executable);
      return { path: resolved, identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
        trusted: matchingName && (system || hostRuntime) };
    } catch { /* Continue PATH lookup as spawn does for absent/non-executable entries. */ }
  }
  return undefined;
}
