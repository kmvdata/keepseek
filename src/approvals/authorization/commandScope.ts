import * as path from 'node:path';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { DraftRun } from '../../shared/types';
import { createControlledEnvironment } from '../../runs/executionEnvironment';
import { findSensitiveEvidence } from '../approvalPolicy';
import { assertOperationPath, isGitProjectSkillPath, isProtectedOperationPath } from './protectedTargets';
import type { GitRemoteScope } from './gitRemoteScope';
import { inspectLocalGitScope, type GitTagSnapshot } from './localGitScope';
import { analyzeCommand, isGitReleaseRef } from './commandSemantics';
import { canonicalPath, isPathInside, joinUnresolvedPath } from './pathScope';
import { authorizationReason, type AuthorizationReason } from './reasons';
import { assertCommandTarget, inspectVisibleCommandTargets } from './visibleCommandTargets';

export interface CommandScope {
  externalUris: string[];
  cwd: string;
  /** Effective Git cwd after validated global -C operands. */
  gitCwd?: string;
  gitBranchRef?: string;
  gitRemote?: GitRemoteScope;
  gitRepositoryIdentity?: string;
  gitTagSnapshot?: GitTagSnapshot;
  executable?: string;
  verifiedLauncher?: string;
  boundLauncher?: string;
  environment: NodeJS.ProcessEnv;
  environmentNames?: string[];
  /** The interpreter, on-disk entry and explicit argv paths were verified. The script runs with host privileges. */
  trustedProjectScript?: boolean;
  projectScriptLaunchPath?: string;
  paths: Array<{ uri: string; role: string; external: boolean }>;
  uncertain: boolean;
  reasons: string[];
  diagnostics: AuthorizationReason[];
  /** In-memory binding for exact grants; includes live resolution, never raw env values. */
  fingerprint: string;
}

export async function inspectDraftRunScope(run: Pick<DraftRun, 'spec'>, inspectRemote = false,
  tagSnapshot?: { ref: string; signal: AbortSignal }): Promise<CommandScope> {
  const parsed = analyzeCommand(run.spec);
  const diagnostics = [...parsed.reasons];
  const roots = await Promise.all((vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file')
    .map(f => canonicalPath(f.uri.fsPath)));
  const cwd = vscode.Uri.parse(run.spec.cwdUri).fsPath;
  const external = new Set<string>();
  const paths: CommandScope['paths'] = [];
  const pathIdentities: unknown[] = [];
  const gitSkillOperands: string[] = [];
  let localScript: string | undefined;
  const check = async (value: string, role: string, gitAddOperand = false) => {
    const write = role === 'write_path';
    const projectSkill = gitAddOperand && roots.some(root => isGitProjectSkillPath(root, value));
    if (!projectSkill || isProtectedOperationPath(value, write, true)) assertOperationPath(value, write);
    let resolved: string;
    try { resolved = await canonicalPath(value); }
    catch {
      diagnostics.push(authorizationReason('path_resolution', value,
        'The path cannot be resolved reliably.', '无法可靠解析该路径。'));
      return;
    }
    if (projectSkill) {
      if (!roots.some(root => isGitProjectSkillPath(root, resolved)) || isProtectedOperationPath(resolved, write, true)) {
        assertOperationPath(value, write);
      }
      gitSkillOperands.push(resolved);
    } else assertOperationPath(resolved, write);
    assertCommandTarget(resolved, write);
    const uri = vscode.Uri.file(resolved).toString();
    const outside = !roots.some(root => isPathInside(root, resolved));
    if ((write || role === 'script' || role === 'executable') && vscode.workspace.textDocuments?.some(document => document.isDirty && document.uri.scheme === 'file'
      && [resolved, value].some(target => isPathInside(path.resolve(target), path.resolve(document.uri.fsPath))))) {
      throw new Error('Command targets a dirty editor. Nothing executed. / 命令涉及未保存的编辑器，尚未执行。');
    }
    const info = await stat(resolved).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (info && !info.isFile() && !info.isDirectory()) {
      throw new Error('The command targets a special filesystem object. / 命令指向特殊文件系统对象。');
    }
    if (parsed.projectScript && role === 'script' && info?.isFile() && info.nlink === 1 && !outside) {
      localScript = resolved;
    }
    paths.push({ uri, role, external: outside });
    pathIdentities.push(info && [info.dev, info.ino, info.mode,
      ...(['script', 'write_path', 'executable'].includes(role) ? [info.mtimeMs, info.ctimeMs, info.size] : [])]);
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
  const visibleTargets = inspectVisibleCommandTargets(parsed);
  await check(cwd, 'cwd');
  const gitCommand = parsed.program === 'git' ? parsed.arguments.find(argument => argument.role === 'subcommand') : undefined;
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
    await check(joinUnresolvedPath(base, operand.value), operand.role, gitCommand?.value === 'add' && operand.role === 'read_path');
  }
  for (const target of visibleTargets) {
    if (process.platform !== 'win32' && /^(?:[A-Za-z]:|\\\\)/u.test(target.value)) {
      diagnostics.push(authorizationReason('foreign_path', target.value,
        'This platform cannot resolve the supplied Windows path.', '当前平台无法解析该 Windows 路径。'));
    } else {
      await check(joinUnresolvedPath(cwd, target.value), target.write ? 'write_path' : 'read_path');
    }
  }
  const env = createControlledEnvironment(run.spec.env);
  const executable = await resolveExecutable(run.spec.executable, cwd, env);
  if (executable && vscode.workspace.textDocuments?.some(document => document.isDirty && document.uri.scheme === 'file'
    && [executable.path, executable.launchPath].includes(path.resolve(document.uri.fsPath)))) {
    throw new Error('The launcher has unsaved changes. Nothing executed. / 启动程序有未保存的修改，尚未执行。');
  }
  if (!executable?.trusted) diagnostics.push(authorizationReason('executable_identity', run.spec.executable,
    'The resolved executable is not a verified system command; its basename is not authority.',
    '解析后的可执行文件不是已核实的系统命令；文件名不能作为授权依据。'));
  // Explicit executable paths are also filesystem targets (PATH-selected system
  // binaries are runtime dependencies, not workspace operand grants).
  if (/[/\\]/u.test(run.spec.executable)) {
    if (!executable?.trusted) {
      const selected = await resolveExecutable(path.basename(run.spec.executable), cwd, env);
      if (!executable || selected?.launchPath !== executable.launchPath) await check(joinUnresolvedPath(cwd, run.spec.executable), 'executable');
    }
  } else if (executable && !executable.trusted && roots.some(root => isPathInside(root, executable.launchPath))
    && !roots.some(root => isPathInside(root, executable.path))) {
    await check(executable.launchPath, 'executable');
  }
  let gitFingerprint: string | undefined;
  let gitCwd: string | undefined;
  let gitBranchRef: string | undefined;
  let gitRemote: GitRemoteScope | undefined;
  let gitRepositoryIdentity: string | undefined;
  let gitTagSnapshot: GitTagSnapshot | undefined;
  const gitRuntime = diagnostics.findIndex(item => item.code === 'git_runtime');
  const boundedGitOptions = gitCommand && ['status', 'diff', 'log', 'show'].includes(gitCommand.value);
  if (executable?.trusted && !roots.some(root => isPathInside(root, executable.path)) && gitCommand && gitRuntime >= 0
    && diagnostics.every(item => ['git_runtime', 'git_commit_argv', 'git_ref_mutation', 'missing_option_value'].includes(item.code)
      || (boundedGitOptions && item.code === 'unsupported_option'))
    && !external.size && (!parsed.gitRemote || inspectRemote)) {
    const git = await inspectLocalGitScope({ executable: executable.path, cwd, roots, cwdChanges: gitCommand.cwdChanges,
      subcommand: gitCommand.value, env, commitAll: parsed.gitCommit?.all,
      refMutation: parsed.gitRefMutation, remote: parsed.gitRemote,
      tagSnapshotRef: tagSnapshot?.ref.startsWith('refs/tags/') && isGitReleaseRef(tagSnapshot.ref) ? tagSnapshot.ref : undefined,
      signal: tagSnapshot?.signal,
      noOptionalLocks: parsed.arguments.some(argument => argument.index < gitCommand.index && argument.value === '--no-optional-locks'),
      noIndexRefresh: gitCommand.value === 'diff' && parsed.arguments.some(argument => argument.role === 'option'
        && argument.index > gitCommand.index && ['--cached', '--staged'].includes(argument.value)),
      addPathspecs: parsed.arguments.filter(argument => argument.role === 'read_path' && argument.index > gitCommand.index).map(argument => argument.value),
      addTracksOnly: parsed.arguments.some(argument => argument.role === 'option' && argument.index > gitCommand.index
        && ['-u', '--update'].includes(argument.value)),
      ambiguousRevisionOperands: gitCommand.value === 'log' ? parsed.arguments.filter(argument => argument.role === 'revision'
        && !/[~^]|\.\./u.test(argument.value)).map(argument => argument.value) : undefined });
    if ('fingerprint' in git) {
      // Git may interpret a bare ref-shaped operand as a path when it matches
      // the worktree or index. Preserve normal protected/external path checks
      // for those concrete targets without treating genuine refs as files.
      for (const target of git.revisionPaths ?? []) await check(target, 'read_path');
      if (paths.some(target => target.role === 'read_path' && !isPathInside(git.repository, vscode.Uri.parse(target.uri).fsPath))) {
        diagnostics[gitRuntime] = { ...diagnostics[gitRuntime], message: 'Git paths must stay inside this repository. / Git 路径必须位于当前仓库内。' };
      } else {
        if ((['add', 'commit'].includes(gitCommand.value) || parsed.gitRefMutation || parsed.gitRemote?.kind === 'push') && vscode.workspace.textDocuments?.some(document =>
          document.isDirty && document.uri.scheme === 'file' && isPathInside(git.repository, document.uri.fsPath))) {
          throw new Error('Save the dirty editors in this repository before running Git. Nothing executed. / 请先保存当前仓库中未保存的编辑器，原命令未启动。');
        }
        gitFingerprint = git.fingerprint;
        gitRemote = git.remote;
        gitRepositoryIdentity = git.repositoryIdentity;
        gitTagSnapshot = git.tagSnapshot;
        gitBranchRef = git.branchRef;
        gitCwd = vscode.Uri.file(git.cwd).toString();
        diagnostics.splice(gitRuntime, 1);
        paths.push({ uri: vscode.Uri.file(git.repository).toString(), role: 'repository', external: false });
      }
    } else {
      if (git.hardBlocked) throw new Error(git.reason);
      gitFingerprint = git.binding;
      diagnostics[gitRuntime] = { ...diagnostics[gitRuntime], message: git.reason };
      if (git.externalPath) await check(git.externalPath, 'repository');
    }
  }
  const verifiedRepository = paths.find(target => target.role === 'repository' && !target.external);
  if (gitSkillOperands.length && (!gitFingerprint || !verifiedRepository
    || gitSkillOperands.some(target => !isGitProjectSkillPath(vscode.Uri.parse(verifiedRepository.uri).fsPath, target)))) {
    throw new Error('Project skill paths require a verified local Git repository. Nothing executed. / 项目技能路径需通过本地 Git 仓库核验，原命令未启动。');
  }
  const externalUris = [...external].sort();
  const trustedProjectScript = Boolean(executable?.trusted && localScript && !externalUris.length
    && !roots.some(root => isPathInside(root, executable.path) || isPathInside(root, executable.launchPath))
    && diagnostics.every(item => item.code === 'script_execution')
    && roots.some(root => paths.every(target => isPathInside(root, vscode.Uri.parse(target.uri).fsPath))));
  // Python uses the launcher path to discover virtual environments and its
  // installation prefix. Keep that spelling after verifying its real target.
  const projectScriptLaunchPath = trustedProjectScript && /^python\d*$/u.test(parsed.program) ? executable?.launchPath : undefined;
  if (!executable && process.platform !== 'win32') throw new Error('Executable cannot be resolved. Nothing executed. / 无法解析实际程序，尚未执行。');
  const fingerprint = createHash('sha256').update(JSON.stringify({
    version: 1, executable, env, roots, paths, pathIdentities, gitFingerprint, gitCwd, externalUris, diagnostics, trustedProjectScript
  })).digest('hex');
  return { externalUris, paths, cwd: paths[0]?.uri ?? run.spec.cwdUri, gitCwd, gitBranchRef, gitRemote, gitRepositoryIdentity, gitTagSnapshot,
    executable: executable?.path, verifiedLauncher: executable?.trusted ? executable.launchPath : undefined,
    boundLauncher: executable?.launchPath, environment: env, environmentNames: Object.keys(env).sort(),
    trustedProjectScript, projectScriptLaunchPath, uncertain: diagnostics.length > 0, diagnostics,
    reasons: diagnostics.map(reason => reason.message), fingerprint };
}

export function hasExactCommandScope(scope: CommandScope, cwdUri: string, authorizedUris: ReadonlySet<string>): boolean {
  return scope.externalUris.every(uri => authorizedUris.has(uri)
    || (uri === scope.cwd && authorizedUris.has(cwdUri) && scope.paths.every(target => target.uri !== uri || target.role === 'cwd')));
}

/** Match POSIX PATH lookup, including relative/empty entries. On Windows,
 * bind an explicit filename or a PATH-selected .exe and spawn its full path. */
export async function resolveExecutable(executable: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{
  path: string; launchPath: string; identity: string; trusted: boolean;
} | undefined> {
  const windows = process.platform === 'win32';
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
      const name = path.basename(executable);
      const ownerControlled = (info.uid === 0 || info.uid === process.getuid?.()) && (info.mode & 0o022) === 0;
      const packagedGit = process.platform === 'darwin' && name === 'git'
        && /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/git\/[^/]+\/bin\/git$/u.test(resolved)
        && ownerControlled;
      const installedInterpreter = ownerControlled && isInstalledInterpreter(name, resolved, env.HOME, system, info.uid === 0);
      const hostRuntime = resolved === await realpath(process.execPath);
      const matchingName = path.basename(resolved) === name;
      const standardWindowsGit = windows && /^git(?:\.exe)?$/iu.test(name)
        && /^([a-z]:)\\Program Files(?: \(x86\))?\\Git\\(?:cmd|bin)\\git\.exe$/iu.test(resolved);
      return { path: resolved, launchPath: candidate, identity: `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`,
        trusted: standardWindowsGit || (!windows && (installedInterpreter || (matchingName && (system || packagedGit || hostRuntime)))) };
    } catch { /* Continue PATH lookup as spawn does for absent/non-executable entries. */ }
  }
  return undefined;
}

function isInstalledInterpreter(name: string, resolved: string, home: string | undefined, system: boolean, rootOwned: boolean): boolean {
  if (name === 'node') {
    return (rootOwned && resolved === '/usr/local/bin/node')
      || (process.platform === 'darwin' && /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/node(?:@\d+)?\/[^/]+\/bin\/node$/u.test(resolved));
  }
  if (!/^python\d*$/u.test(name) || !/^python\d+(?:\.\d+)*$/u.test(path.basename(resolved))) return false;
  if (system) return true;
  if (process.platform === 'darwin'
    && /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/python(?:@\d+(?:\.\d+)*)?\/[^/]+\/(?:Frameworks\/Python\.framework\/Versions\/[^/]+\/)?bin\/python\d+(?:\.\d+)*$/u.test(resolved)) return true;
  return Boolean(home && path.isAbsolute(home) && ['miniconda3', 'anaconda3', 'miniforge3'].some(distribution =>
    path.dirname(resolved) === path.join(home, distribution, 'bin')));
}
