import * as path from 'node:path';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { DraftRun } from '../../shared/types';
import { createControlledEnvironment } from '../../runs/executionEnvironment';
import { findSensitiveEvidence } from '../approvalPolicy';
import { assertOperationPath } from './protectedTargets';
import { inspectLocalGitScope } from './localGitScope';
import { analyzeCommand } from './commandSemantics';
import { canonicalPath, isPathInside, joinUnresolvedPath } from './pathScope';
import { authorizationReason, type AuthorizationReason } from './reasons';

export interface CommandScope {
  externalUris: string[];
  cwd: string;
  executable?: string;
  paths: Array<{ uri: string; role: string; external: boolean }>;
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
  const paths: CommandScope['paths'] = [];
  const pathIdentities: unknown[] = [];
  const check = async (value: string, role: string) => {
    const write = role === 'write_path';
    assertOperationPath(value, write);
    let resolved: string;
    try { resolved = await canonicalPath(value); }
    catch {
      diagnostics.push(authorizationReason('path_resolution', value,
        'The path cannot be resolved reliably.', '无法可靠解析该路径。'));
      return;
    }
    assertOperationPath(resolved, write);
    const uri = vscode.Uri.file(resolved).toString();
    const outside = !roots.some(root => isPathInside(root, resolved));
    const info = await stat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (info && !info.isFile() && !info.isDirectory()) {
      throw new Error('The command targets a special filesystem object. / 命令指向特殊文件系统对象。');
    }
    paths.push({ uri, role, external: outside });
    pathIdentities.push(info && [info.dev, info.ino, info.mode, ...(role === 'script' ? [info.mtimeMs, info.ctimeMs, info.size] : [])]);
    if (outside) external.add(uri);
  };
  if (findSensitiveEvidence(JSON.stringify([run.spec.executable, run.spec.args, run.spec.env]))
    || parsed.arguments.some(argument => argument.role === 'inline_code'
      && /(?:^|[\s;&|])(?:sudo|doas|pkexec)(?:\s|$)|(?:^|[/~])\.(?:ssh|aws|gnupg|kube|codex)(?:[/\s]|$)|\/etc\/(?:shadow|sudoers)\b/iu.test(argument.value))
    || parsed.effects.some(effect => ['credential_access', 'privilege_escalation'].includes(effect))
    || (parsed.program === 'git' && parsed.arguments.some(argument => argument.role === 'subcommand' && argument.value === 'config')
      && run.spec.args.some(argument => ['--system', '--global'].includes(argument)))
    || run.spec.env.some(({ name }) => /^(?:LD_|DYLD_|NODE_OPTIONS$|BASH_ENV$|ENV$)|(?:^|_)(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIALS?)(?:_|$)/iu.test(name))) {
    throw new Error('Credential access, privilege escalation or unsafe execution environment. Nothing executed. / 操作涉及凭据、提权或高风险执行环境，尚未执行。');
  }
  await check(cwd, 'cwd');
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
    await check(joinUnresolvedPath(base, operand.value), operand.role);
  }
  const env = createControlledEnvironment(run.spec.env);
  const executable = await resolveExecutable(run.spec.executable, cwd, env);
  if (!executable?.trusted) diagnostics.push(authorizationReason('executable_identity', run.spec.executable,
    'The resolved executable is not a verified system command; its basename is not authority.',
    '解析后的可执行文件不是已核实的系统命令；文件名不能作为授权依据。'));
  // Explicit executable paths are also filesystem targets (PATH-selected system
  // binaries are runtime dependencies, not workspace operand grants).
  if (/[/\\]/u.test(run.spec.executable)) {
    if (!executable?.trusted) await check(joinUnresolvedPath(cwd, run.spec.executable), 'executable');
  }
  let gitFingerprint: string | undefined;
  const gitCommand = parsed.arguments.find(argument => argument.role === 'subcommand');
  if (executable?.trusted && !roots.some(root => isPathInside(root, executable.path)) && gitCommand && diagnostics.length === 1 && diagnostics[0].code === 'git_runtime' && !external.size) {
    const git = await inspectLocalGitScope({ executable: executable.path, cwd, roots, cwdChanges: gitCommand.cwdChanges,
      subcommand: gitCommand.value, env, noSigning: parsed.arguments.some(argument => argument.role === 'option' && argument.value === '--no-gpg-sign') });
    if ('fingerprint' in git) {
      if (paths.some(target => target.role === 'read_path' && !isPathInside(git.repository, vscode.Uri.parse(target.uri).fsPath))) {
        diagnostics[0] = { ...diagnostics[0], message: 'Git paths must stay inside this repository. / Git 路径必须位于当前仓库内。' };
      } else {
        gitFingerprint = git.fingerprint;
        diagnostics.pop();
        paths.push({ uri: vscode.Uri.file(git.repository).toString(), role: 'repository', external: false });
      }
    } else {
      diagnostics[0] = { ...diagnostics[0], message: git.reason };
      if (git.externalPath) await check(git.externalPath, 'repository');
    }
  }
  const externalUris = [...external].sort();
  if (!executable && process.platform !== 'win32') throw new Error('Executable cannot be resolved. Nothing executed. / 无法解析实际程序，尚未执行。');
  const fingerprint = createHash('sha256').update(JSON.stringify({
    version: 1, executable, env, roots, paths, pathIdentities, gitFingerprint, externalUris, diagnostics
  })).digest('hex');
  return { externalUris, paths, cwd: paths[0]?.uri ?? run.spec.cwdUri, executable: executable?.path, uncertain: diagnostics.length > 0, diagnostics,
    reasons: diagnostics.map(reason => reason.message), fingerprint };
}

export function hasExactCommandScope(scope: CommandScope, cwdUri: string, authorizedUris: ReadonlySet<string>): boolean {
  return scope.externalUris.every(uri => authorizedUris.has(uri)
    || (uri === scope.cwd && authorizedUris.has(cwdUri) && scope.paths.every(target => target.uri !== uri || target.role === 'cwd')));
}

/** Match spawn's POSIX PATH lookup, including relative/empty entries. Windows
 * search order/PATHEXT is deliberately not approximated; it requires a grant. */
export async function resolveExecutable(executable: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{
  path: string; identity: string; trusted: boolean;
} | undefined> {
  const windows = process.platform === 'win32';
  // Windows remains in the manual lane. Resolve an explicit filename or a
  // known executable extension to bind evidence without treating it as trusted.
  const filename = windows && !path.extname(executable) ? executable + '.exe' : executable;
  const candidates = (windows ? /[/\\]/u : /\//u).test(executable) ? [joinUnresolvedPath(cwd, filename)]
    : (env.PATH ?? (windows ? '' : '/usr/bin:/bin')).split(path.delimiter).map(dir => joinUnresolvedPath(cwd, dir, filename));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile()) continue;
      // OS-owned system locations or the running extension host binary only.
      // A workspace/PATH shim named `cat`/`git` never gains their authority.
      const systemRoots = windows ? [] : await Promise.all(['/bin', '/usr/bin'].map(dir => realpath(dir)));
      const system = info.uid === 0 && (info.mode & 0o022) === 0
        && systemRoots.some(root => path.dirname(resolved) === root);
      const packagedGit = process.platform === 'darwin' && path.basename(executable) === 'git'
        && /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/git\/[^/]+\/bin\/git$/u.test(resolved)
        && (info.uid === 0 || info.uid === process.getuid?.()) && (info.mode & 0o022) === 0;
      const hostRuntime = resolved === await realpath(process.execPath);
      const matchingName = path.basename(resolved) === path.basename(executable);
      return { path: resolved, identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
        trusted: !windows && matchingName && (system || packagedGit || hostRuntime) };
    } catch { /* Continue PATH lookup as spawn does for absent/non-executable entries. */ }
  }
  return undefined;
}
