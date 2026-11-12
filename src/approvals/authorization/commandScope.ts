import * as path from 'node:path';
import { access, lstat, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import * as vscode from 'vscode';
import type { ApprovalMode, DraftRun } from '../../shared/types';
import { createControlledEnvironment } from '../../runs/executionEnvironment';
import { getProjectExecutionMode, inspectProjectExecution, isProjectExecutionEnvNameSupported,
  type ProjectExecutionBoundary } from '../../runs/projectExecutionIsolation';
import { findSensitiveEvidence } from '../approvalPolicy';
import { assertOperationPath, isGitProjectSkillPath, isProtectedOperationPath } from './protectedTargets';
import type { GitRemoteScope } from './gitRemoteScope';
import { inspectLocalGitScope, type GitTagSnapshot } from './localGitScope';
import { inspectPackageLaunch, parseLiteralLifecycleArgv } from './packageLaunch';
import { analyzeCommand, isGitReleaseRef, type CommandSemantics } from './commandSemantics';
import { isNodeProgram, isPythonProgram } from './projectLaunchArguments';
import { fileIdentity, hashRegularFile, inspectProjectExecutable, inspectPythonVenv, installedBunPath, installedInterpreter, installedLaunchPath,
  isNativeExecutable, type ResolvedExecutable } from './projectLaunchIdentity';
import { canonicalPath, isPathInside, joinUnresolvedPath } from './pathScope';
import { authorizationReason, type AuthorizationReason } from './reasons';
import { assertCommandTarget, inspectVisibleCommandTargets } from './visibleCommandTargets';

export interface CommandScope {
  semantics?: CommandSemantics;
  selectedProjectRoot?: string;
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
  projectExecution?: ProjectExecutionBoundary;
  projectExecutionUnavailable?: string;
  /** The launcher and visible scope are bound to an active, user-selected execution profile. */
  verifiedProjectCommand?: boolean;
  /** The interpreter, on-disk entry and explicit argv paths were verified. */
  trustedProjectScript?: boolean;
  projectScriptLaunchPath?: string;
  projectScriptEntryUri?: string;
  projectScriptEntryIdentity?: { sha256: string; sizeBytes: number };
  projectScriptEntryStat?: string;
  paths: Array<{ uri: string; role: string; external: boolean }>;
  uncertain: boolean;
  reasons: string[];
  diagnostics: AuthorizationReason[];
  /** Repository/operand evidence can be checked without reselecting a runner. */
  factsFingerprint: string;
  /** In-memory binding for exact grants; includes live resolution, never raw env values. */
  fingerprint: string;
}

/** Metadata mode binds an exact Git destination without opening its config. */
export type CommandRemoteInspection = boolean | 'metadata';

export async function inspectDraftRunScope(run: Pick<DraftRun, 'spec'>, inspectRemote: CommandRemoteInspection = false,
  tagSnapshot?: { ref: string; signal: AbortSignal }, allowUnresolvedLauncher = false, selectedProjectUri?: string,
  inspection: boolean | ApprovalMode = false): Promise<CommandScope> {
  const allowMissingCwd = inspection === true;
  const delegate = inspection === 'delegate';
  const parsed = analyzeCommand(run.spec);
  const usesProjectExecution = delegate && !parsed.gitRemote && !run.spec.restricted;
  const isolated = usesProjectExecution && getProjectExecutionMode() !== 'host';
  const diagnostics = [...parsed.reasons];
  const roots = await Promise.all((vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file')
    .map(f => canonicalPath(f.uri.fsPath)));
  const cwdUri = vscode.Uri.parse(run.spec.cwdUri);
  if (cwdUri.scheme !== 'file') throw new Error('Commands require a local working directory. / 命令需要本地工作目录。');
  const cwd = await (allowMissingCwd ? canonicalPath(cwdUri.fsPath) : realpath(cwdUri.fsPath));
  const cwdInfo = await stat(cwd).catch((error: NodeJS.ErrnoException) => {
    if (!allowMissingCwd || error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (cwdInfo && !cwdInfo.isDirectory()) throw new Error('Commands require a local working directory. / 命令需要本地工作目录。');
  const selected = selectedProjectUri && vscode.Uri.parse(selectedProjectUri);
  const selectedProjectRoot = selected
    ? selected.scheme === 'file' ? await realpath(selected.fsPath) : undefined
    : roots.filter(root => isPathInside(root, cwd)).sort((a, b) => b.length - a.length)[0];
  if (selected && (!selectedProjectRoot || !roots.some(root => isPathInside(root, selectedProjectRoot))
    || !(await stat(selectedProjectRoot)).isDirectory())) {
    throw new Error('The selected project root cannot be verified. / 无法核实当前选定的工程根目录。');
  }
  const projectLaunch = Boolean(parsed.projectScript || parsed.projectPackageScript || parsed.projectExecutable);
  const external = new Set<string>();
  const paths: CommandScope['paths'] = [];
  const pathIdentities: unknown[] = [];
  const checkedPaths = new Set<string>();
  const gitSkillOperands: string[] = [];
  let localScript: string | undefined;
  let scriptEntry: string | undefined;
  let projectScriptEntryIdentity: CommandScope['projectScriptEntryIdentity'];
  let projectScriptEntryStat: string | undefined;
  const check = async (value: string, role: string, gitAddOperand = false,
    knownEntry?: { fileIdentity: string; sha256: string }) => {
    const checkKey = JSON.stringify([value, role, gitAddOperand]);
    if (checkedPaths.has(checkKey)) return;
    checkedPaths.add(checkKey);
    const write = role === 'write_path';
    const projectSkill = gitAddOperand && roots.some(root => isGitProjectSkillPath(root, value));
    if (!projectSkill || isProtectedOperationPath(value, write, true)) assertOperationPath(value, write);
    let resolved: string;
    try { resolved = role === 'cwd' && value === cwdUri.fsPath ? cwd : await canonicalPath(value); }
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
    const outside = (projectLaunch || delegate) && selectedProjectRoot ? !isPathInside(selectedProjectRoot, resolved)
      : !roots.some(root => isPathInside(root, resolved));
    if ((write || ['script', 'executable', 'launcher_config', 'package_manifest', 'lifecycle_script'].includes(role))
      && vscode.workspace.textDocuments?.some(document => document.isDirty && document.uri.scheme === 'file'
      && [resolved, value].some(target => isPathInside(path.resolve(target), path.resolve(document.uri.fsPath))))) {
      throw new Error('Command targets a dirty editor. Nothing executed. / 命令涉及未保存的编辑器，尚未执行。');
    }
    const info = await (role === 'cwd' && resolved === cwd ? Promise.resolve(cwdInfo) : stat(resolved)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
    if (info && !info.isFile() && !info.isDirectory()) {
      throw new Error('The command targets a special filesystem object. / 命令指向特殊文件系统对象。');
    }
    if (role === 'script' && projectLaunch && info?.isFile() && info.nlink === 1) {
      scriptEntry = resolved;
      if (!outside) {
        localScript = resolved;
        projectScriptEntryStat = fileIdentity(info);
        if (knownEntry && knownEntry.fileIdentity !== projectScriptEntryStat) {
          throw new Error('The package entry changed during preflight. / 软件包脚本入口在预检期间已变化。');
        }
        projectScriptEntryIdentity = { sha256: knownEntry?.sha256 ?? await hashRegularFile(resolved, info), sizeBytes: info.size };
        pathIdentities.push(projectScriptEntryIdentity);
      }
    }
    paths.push({ uri, role, external: outside });
    pathIdentities.push(info && [info.dev, info.ino, info.mode,
      ...(['script', 'write_path', 'executable', 'package_manifest', 'lifecycle_script'].includes(role) ? [info.mtimeMs, info.ctimeMs, info.size] : [])]);
    if (outside) external.add(uri);
  };
  if (findSensitiveEvidence(JSON.stringify([run.spec.executable, run.spec.args, run.spec.env]))
    || parsed.arguments.some(argument => argument.role === 'inline_code'
      && /(?:^|[\s;&|])(?:sudo|doas|pkexec)(?:\s|$)|(?:^|[/~])\.(?:ssh|aws|gnupg|kube|codex)(?:[/\s]|$)|\/etc\/(?:shadow|sudoers)\b/iu.test(argument.value))
    || parsed.effects.some(effect => ['credential_access', 'privilege_escalation'].includes(effect))
    || (parsed.program === 'git' && parsed.arguments.some(argument => argument.role === 'subcommand' && argument.value === 'config')
      && run.spec.args.some(argument => ['--system', '--global'].includes(argument)))
    || run.spec.env.some(({ name }) => /^(?:LD_|DYLD_|NODE_OPTIONS$|BASH_ENV$|ENV$)|(?:^|_)(?:TOKEN|SECRET|PASSWORD|KEY|CREDENTIALS?)(?:_|$)/iu.test(name)
      || delegate && /^(?:GIT_|BASH_FUNC_|(?:PATH|PATHEXT|HOME|USERPROFILE|TMP|TEMP|TMPDIR|SYSTEMROOT|COMSPEC|WINDIR|NODE_PATH|PYTHONHOME|PYTHONPATH|RUBYOPT|PERL5OPT)$)/iu.test(name))) {
    throw new Error('Credential access, privilege escalation or unsafe execution environment. Nothing executed. / 操作涉及凭据、提权或高风险执行环境，尚未执行。');
  }
  const collectNetworkTarget = (value: string) => {
    if (!parsed.effects.includes('network')) parsed.effects.push('network');
    const targets = parsed.networkTargets ??= [];
    if (!targets.includes(value)) targets.push(value);
  };
  const visibleTargets = inspectVisibleCommandTargets(parsed, collectNetworkTarget, isolated);
  const projectOperandPath = (value: string) => /^file:/iu.test(value) ? fileURLToPath(value)
    : /^~[\\/]/u.test(value) ? joinUnresolvedPath(homedir(), value.slice(2)) : value;
  const genericOperands = parsed.reasons.some(item => item.code === 'unsupported_program');
  await check(cwdUri.fsPath, 'cwd');
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
    const value = projectLaunch && operand.role !== 'script' || genericOperands && /^file:\/\//iu.test(operand.value)
      ? projectOperandPath(operand.value) : operand.value;
    await check(joinUnresolvedPath(base, value), operand.role, gitCommand?.value === 'add' && operand.role === 'read_path');
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
  // The pinned Linux image owns PATH on Windows. A bare command may be
  // present there even when the Windows host only has a .cmd shim or no tool.
  const containerCommand = isolated && process.platform === 'win32' && !executable
    && /^[A-Za-z0-9][A-Za-z0-9_.+-]*$/u.test(run.spec.executable) ? run.spec.executable : undefined;
  const requestedLauncher = executable?.launchPath ?? containerCommand;
  if (executable && vscode.workspace.textDocuments?.some(document => document.isDirty && document.uri.scheme === 'file'
    && [executable.path, executable.launchPath].includes(path.resolve(document.uri.fsPath)))) {
    throw new Error('The launcher has unsaved changes. Nothing executed. / 启动程序有未保存的修改，尚未执行。');
  }
  const launchDirectory = executable && await realpath(path.dirname(executable.launchPath));
  const launchOutsideWorkspace = executable && launchDirectory && !roots.some(root =>
    isPathInside(root, executable.path) || isPathInside(root, launchDirectory));
  const installed = executable?.trusted && launchOutsideWorkspace
    && await installedLaunchPath(executable, env.HOME ?? env.USERPROFILE, launchDirectory);
  const venv = executable && selectedProjectRoot && !launchOutsideWorkspace && isPythonProgram(parsed.program)
    ? await inspectPythonVenv(executable, selectedProjectRoot, cwd, env, resolveExecutable) : undefined;
  if (venv) await check(venv.config, 'launcher_config');
  const packageLaunch = executable && launchOutsideWorkspace && selectedProjectRoot === cwd && parsed.projectPackageScript
    ? await inspectPackageLaunch(parsed.program, parsed.projectPackageScript.name, cwd, executable, env, resolveExecutable) : undefined;
  if (parsed.projectPackageScript && !packageLaunch) {
    // Bind a visible manifest even when the launcher or custom configuration
    // cannot qualify for the ordinary lane. This also retains symlink grants.
    const manifest = path.join(cwd, 'package.json');
    if (await lstat(manifest).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    })) await check(manifest, 'package_manifest');
  }
  if (packageLaunch) {
    await check(packageLaunch.manifest, 'script', false, packageLaunch);
    for (const definition of packageLaunch.lifecycle) {
      if (findSensitiveEvidence(definition)) {
        throw new Error('Package lifecycle contains sensitive material. / 软件包生命周期包含敏感信息。');
      }
      const targets = inspectVisibleCommandTargets({ program: 'sh', effects: ['arbitrary_code'], reasons: [],
        arguments: [{ index: 0, value: definition, role: 'inline_code', cwdChanges: [] }] }, collectNetworkTarget, isolated);
      for (const target of targets) await check(joinUnresolvedPath(cwd, target.value), target.write ? 'write_path' : 'read_path');
      const literal = parseLiteralLifecycleArgv(definition);
      if (literal) {
        const [launcher, ...argv] = literal;
        const lifecycle = analyzeCommand({ ...run.spec, executable: launcher, args: argv, env: [] });
        if (lifecycle.effects.includes('privilege_escalation') || lifecycle.effects.includes('credential_access')
          || /^(?:npm|pnpm|yarn|bun)$/u.test(lifecycle.program) && !lifecycle.projectScript && !lifecycle.projectPackageScript
            && argv.some(arg => /^(?:--global|--location=global|-[a-z]*g[a-z]*)(?:=|$)/u.test(arg) || arg === 'global')) {
          throw new Error('Protected package lifecycle effect. Nothing executed. / 软件包生命周期涉及受保护操作，尚未执行。');
        }
        for (const effect of lifecycle.effects) {
          if (['package_install', 'publish_or_deploy', 'network'].includes(effect) && !parsed.effects.includes(effect)) parsed.effects.push(effect);
        }
        if (lifecycle.projectScript || lifecycle.projectExecutable) {
          if (lifecycle.projectExecutable) await check(joinUnresolvedPath(cwd, launcher), 'lifecycle_script');
          for (const item of lifecycle.arguments) {
            if (item.role === 'script') await check(joinUnresolvedPath(cwd, item.value), 'lifecycle_script');
            else if (['read_path', 'write_path'].includes(item.role)) await check(joinUnresolvedPath(cwd, projectOperandPath(item.value)), item.role);
          }
          for (const item of inspectVisibleCommandTargets(lifecycle, undefined, isolated)) {
            await check(joinUnresolvedPath(cwd, item.value), item.write ? 'write_path' : 'read_path');
          }
        }
      }
    }
  }
  const custom = parsed.projectExecutable && executable && selectedProjectRoot && launchDirectory
    && [executable.path, launchDirectory].every(target => isPathInside(selectedProjectRoot, target))
    ? await inspectProjectExecutable(executable, cwd, env, resolveExecutable) : undefined;
  if (custom && executable) await check(executable.launchPath, 'script');
  if (parsed.projectExecutable && executable && selectedProjectRoot && launchDirectory && !custom
    && [executable.path, launchDirectory].every(target => isPathInside(selectedProjectRoot, target))) {
    diagnostics.push(authorizationReason('interpreter_identity', run.spec.executable,
      'The project executable has no verified native or script launcher.',
      '工程可执行文件没有已核实的原生启动器或脚本解释器。'));
  }
  if (parsed.networkTargets?.some(target => {
    try { return Boolean(new URL(target).password); } catch { return false; }
  })) throw new Error('A command network target contains credentials. Nothing executed. / 命令网络目标含有凭据，尚未执行。');
  const interpreterVerified = Boolean(installed || venv || packageLaunch || custom);
  if (!installed && !venv && !packageLaunch && !custom) diagnostics.push(authorizationReason('executable_identity', run.spec.executable,
    'The resolved executable is not a verified system command; its basename is not authority.',
    '解析后的可执行文件不是已核实的系统命令；文件名不能作为授权依据。'));
  // Explicit executable paths are also filesystem targets (PATH-selected system
  // binaries are runtime dependencies, not workspace operand grants).
  if (/[/\\]/u.test(run.spec.executable)) {
    if (!executable?.trusted && !venv && !packageLaunch && !custom) {
      const selected = await resolveExecutable(path.basename(run.spec.executable), cwd, env);
      if (!executable || selected?.launchPath !== executable.launchPath) await check(joinUnresolvedPath(cwd, run.spec.executable), 'executable');
    }
  } else if (executable && !executable.trusted && roots.some(root => isPathInside(root, executable.launchPath))
    && !roots.some(root => isPathInside(root, executable.path))) {
    await check(executable.launchPath, 'executable');
  }
  if ((parsed.projectScript || isNodeProgram(parsed.program) || isPythonProgram(parsed.program))
    && !interpreterVerified) diagnostics.push(authorizationReason('interpreter_identity', run.spec.executable,
    'The interpreter is not an installed runtime or verified project virtual environment.',
    '启动器并非已安装的运行时或已核实的项目虚拟环境。'));
  if (parsed.projectScript && !scriptEntry) diagnostics.push(authorizationReason('script_entry_unverified', '',
    'The supplied script is not an existing regular file with an exact launch identity.',
    '指定的脚本不是可以核实启动身份的现有常规文件。'));
  let gitFingerprint: string | undefined;
  let gitCwd: string | undefined;
  let gitBranchRef: string | undefined;
  let gitRemote: GitRemoteScope | undefined;
  let gitRepositoryIdentity: string | undefined;
  let gitTagSnapshot: GitTagSnapshot | undefined;
  const gitRuntime = diagnostics.findIndex(item => item.code === 'git_runtime');
  const boundedGitOptions = gitCommand && (delegate || ['status', 'diff', 'log', 'show'].includes(gitCommand.value));
  const exactStatusPager = delegate && parsed.gitReplan?.code === 'git_status_pager_override';
  if (executable && installed && gitCommand && gitRuntime >= 0
    && diagnostics.every(item => ['git_runtime', 'git_commit_argv', 'git_ref_mutation', 'missing_option_value'].includes(item.code)
      || (boundedGitOptions && item.code === 'unsupported_option') || (exactStatusPager && item.code === 'git_configuration'))
    && !external.size && (!parsed.gitRemote || inspectRemote)) {
    const git = await inspectLocalGitScope({ executable: executable.path, cwd,
      roots: delegate && selectedProjectRoot ? [selectedProjectRoot] : roots, cwdChanges: gitCommand.cwdChanges,
      subcommand: gitCommand.value, env, commitAll: parsed.gitCommit?.all,
      refMutation: parsed.gitRefMutation, remote: parsed.gitRemote, remoteMetadataOnly: inspectRemote === 'metadata',
      tagSnapshotRef: tagSnapshot?.ref.startsWith('refs/tags/') && isGitReleaseRef(tagSnapshot.ref) ? tagSnapshot.ref : undefined,
      signal: tagSnapshot?.signal,
      noOptionalLocks: parsed.arguments.some(argument => argument.index < gitCommand.index && argument.value === '--no-optional-locks'),
      noIndexRefresh: gitCommand.value === 'diff' && parsed.arguments.some(argument => argument.role === 'option'
        && argument.index > gitCommand.index && ['--cached', '--staged'].includes(argument.value)),
      includeLinkedWorktreeRefs: gitCommand.value === 'log' && parsed.arguments.some(argument => argument.role === 'option'
        && argument.index > gitCommand.index && argument.value === '--all'),
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
  let projectExecution: ProjectExecutionBoundary | undefined;
  let projectExecutionUnavailable: string | undefined;
  if (usesProjectExecution && requestedLauncher) {
    const projectCwd = selectedProjectRoot && isPathInside(selectedProjectRoot, cwd);
    const executionRoot = projectCwd ? selectedProjectRoot : isolated ? undefined : cwd;
    const unsupportedEnv = isolated && run.spec.env.find(entry => !isProjectExecutionEnvNameSupported(entry.name));
    if (!executionRoot || isolated && externalUris.length) {
      projectExecutionUnavailable = 'The current execution profile cannot cover the command\'s project paths. / 当前执行环境无法覆盖命令的工程路径。';
    } else if (unsupportedEnv) {
      projectExecutionUnavailable = `This isolation profile cannot pass the requested environment variable: ${unsupportedEnv.name}. / 当前隔离环境无法传递所请求的环境变量：${unsupportedEnv.name}。`;
    } else {
      const mightWrite = parsed.effects.some(effect => !['workspace_read', 'long_running'].includes(effect))
        || diagnostics.some(item => ['unsupported_program', 'unsupported_option', 'unsupported_pathspec', 'git_configuration', 'external_helper'].includes(item.code));
      if (mightWrite && vscode.workspace.textDocuments?.some(document => document.isDirty && document.uri.scheme === 'file'
        && isPathInside(executionRoot, document.uri.fsPath))) {
        throw new Error('Save the project\'s dirty editors before running a command with possible writes. / 命令可能写入文件，请先保存当前工程中的未保存编辑器。');
      }
      try { projectExecution = await inspectProjectExecution(executionRoot, cwd, requestedLauncher); }
      catch (error) {
        projectExecutionUnavailable = error instanceof Error ? error.message
          : 'Project execution boundary could not be verified. / 无法核实工程执行边界。';
      }
    }
  }
  const verifiedProjectCommand = Boolean(projectExecution && selectedProjectRoot && !externalUris.length);
  const boundLauncher = executable?.launchPath ?? (projectExecution?.kind === 'container' ? projectExecution.executable : undefined);
  const trustedProjectScript = Boolean(interpreterVerified && localScript && !externalUris.length
    && !parsed.networkTargets?.length && !parsed.effects.includes('network')
    && diagnostics.every(item => item.code === 'script_execution' || item.code === 'environment_override'
      && run.spec.env.every(({ name }) => /^(?:LANG|LC_ALL|LC_CTYPE|TERM|COLORTERM|CI|NO_COLOR|NODE_ENV|PYTHONDONTWRITEBYTECODE)$/u.test(name)))
    && selectedProjectRoot && paths.every(target => isPathInside(selectedProjectRoot, vscode.Uri.parse(target.uri).fsPath)));
  // Python uses the launcher path to discover virtual environments and its
  // installation prefix. Keep that spelling after verifying its real target.
  const projectScriptLaunchPath = executable && interpreterVerified && isPythonProgram(parsed.program) ? executable.launchPath : undefined;
  if (!executable && process.platform !== 'win32' && !allowUnresolvedLauncher) {
    throw new Error('Executable cannot be resolved. Nothing executed. / 无法解析实际程序，尚未执行。');
  }
  const factsFingerprint = createHash('sha256').update(JSON.stringify({
    version: 2, executable, env, roots, selectedProjectRoot, venv: venv?.fingerprint, packageRuntime: packageLaunch?.runtime, custom,
    paths, pathIdentities, gitFingerprint, gitCwd, externalUris, diagnostics, trustedProjectScript,
    argv: projectLaunch ? run.spec.args : undefined, networkTargets: parsed.networkTargets
  })).digest('hex');
  const fingerprint = projectExecution || projectExecutionUnavailable
    ? createHash('sha256').update(JSON.stringify([factsFingerprint, projectExecution?.fingerprint, projectExecutionUnavailable])).digest('hex')
    : factsFingerprint;
  return { semantics: parsed, selectedProjectRoot, externalUris, paths, cwd: paths[0]?.uri ?? run.spec.cwdUri,
    gitCwd, gitBranchRef, gitRemote, gitRepositoryIdentity, gitTagSnapshot,
    executable: executable?.path ?? boundLauncher, verifiedLauncher: installed || venv || packageLaunch || custom ? executable?.launchPath : undefined,
    boundLauncher, environment: env, environmentNames: Object.keys(env).sort(),
    projectExecution, projectExecutionUnavailable, verifiedProjectCommand,
    trustedProjectScript, projectScriptLaunchPath, projectScriptEntryUri: scriptEntry ? vscode.Uri.file(scriptEntry).toString() : undefined,
    projectScriptEntryIdentity, projectScriptEntryStat,
    uncertain: diagnostics.length > 0, diagnostics,
    reasons: diagnostics.map(reason => reason.message), factsFingerprint, fingerprint };
}
export function hasExactCommandScope(scope: CommandScope, cwdUri: string, authorizedUris: ReadonlySet<string>): boolean {
  return scope.externalUris.every(uri => authorizedUris.has(uri)
    || (uri === scope.cwd && authorizedUris.has(cwdUri) && scope.paths.every(target => target.uri !== uri || target.role === 'cwd')));
}

/** Match POSIX PATH lookup, including relative/empty entries. On Windows,
 * bind an explicit filename or a PATH-selected .exe and spawn its full path. */
export async function resolveExecutable(executable: string, cwd: string, env: NodeJS.ProcessEnv): Promise<ResolvedExecutable | undefined> {
  const windows = process.platform === 'win32';
  const filename = windows && (!path.extname(executable) || isPythonProgram(path.basename(executable))) ? executable + '.exe' : executable;
  const candidates = (windows ? /[/\\]/u : /\//u).test(executable) ? [joinUnresolvedPath(cwd, filename)]
    : (env.PATH ?? (windows ? '' : '/usr/bin:/bin')).split(path.delimiter).map(dir => joinUnresolvedPath(cwd, dir, filename));
  const systemRoots = windows ? [] : await Promise.all(['/bin', '/usr/bin'].map(dir => realpath(dir)));
  const hostExecutable = await realpath(process.execPath);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      const resolved = await realpath(candidate);
      const info = await stat(resolved);
      if (!info.isFile()) continue;
      // OS-owned system locations or the running extension host binary only.
      // A workspace/PATH shim named `cat`/`git` never gains their authority.
      const system = info.uid === 0 && (info.mode & 0o022) === 0
        && systemRoots.some(root => path.dirname(resolved) === root);
      const name = path.basename(executable).replace(/\.exe$/iu, '').toLowerCase();
      const ownerControlled = (info.uid === 0 || info.uid === process.getuid?.()) && (info.mode & 0o022) === 0;
      const packagedGit = process.platform === 'darwin' && name === 'git'
        && /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/git\/[^/]+\/bin\/git$/u.test(resolved)
        && ownerControlled;
      const hostRuntime = resolved === hostExecutable;
      const interpreter = isNodeProgram(name) || isPythonProgram(name) || name === 'bun';
      const trustedInterpreter = interpreter && (ownerControlled || windows)
        && (name === 'bun' ? installedBunPath(resolved, homedir(), system, info.uid === 0)
          : installedInterpreter(name, resolved, homedir(), system, info.uid === 0, hostRuntime))
        && await isNativeExecutable(resolved, info).catch(() => false);
      const matchingName = path.basename(resolved) === name;
      const standardWindowsGit = windows && /^git(?:\.exe)?$/iu.test(name)
        && /^([a-z]:)\\Program Files(?: \(x86\))?\\Git\\(?:cmd|bin)\\git\.exe$/iu.test(resolved);
      return { path: resolved, launchPath: candidate, identity: fileIdentity(info),
        trusted: standardWindowsGit || trustedInterpreter || (!windows && !interpreter && matchingName && (system || packagedGit || hostRuntime)) };
    } catch { /* Continue PATH lookup as spawn does for absent/non-executable entries. */ }
  }
  return undefined;
}
