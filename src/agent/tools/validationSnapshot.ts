import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveExecutable } from '../../approvals/authorization/commandScope';
import { inspectInstalledNpmRuntime } from '../../approvals/authorization/packageLaunch';
import { installedLaunchPath } from '../../approvals/authorization/projectLaunchIdentity';
import { isPathInside } from '../../approvals/authorization/pathScope';
import { createBoundedReviewText, hashApprovalText, hashApprovalValue } from '../../approvals/approvalReviewHash';
import { findSensitiveEvidence, redactSensitiveReviewText } from '../../approvals/approvalPolicy';
import { createControlledEnvironment } from '../../runs/executionEnvironment';
import { getProjectExecutionMode, inspectProjectExecution } from '../../runs/projectExecutionIsolation';
import type { ApprovalMode, SafeNpmScript } from '../../shared/types';
import { hasValidationBlockingRisk } from './validationRisk';

const MAX_CONFIG_BYTES = 1_000_000;
const VALIDATION_CONFIG = /^(?:tsconfig(?:\.[\w.-]+)?\.json|jsconfig\.json|(?:eslint|vitest|vite|jest|babel|webpack|playwright|rollup|mocha)\.config\.[\w.-]+|\.(?:eslintrc|babelrc|mocharc)(?:\.[\w.-]+)?|bunfig\.toml)$/u;

export class ValidationUnavailableError extends Error {
  public constructor(public readonly reason: 'manifest_missing' | 'script_missing') {
    super(reason);
  }
}

export async function inspectValidationSnapshot(folder: vscode.WorkspaceFolder, script: SafeNpmScript, approvalMode?: ApprovalMode) {
  if (folder.uri.scheme !== 'file') throw new Error('Validation requires a local extension-host folder. / 验证需要扩展宿主上的本地目录。');
  const cwd = await realpath(folder.uri.fsPath);
  const statIfPresent = (name: string) => lstat(path.join(cwd, name)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    return undefined;
  });
  const readConfig = async (name: string) => {
    const target = path.join(cwd, name);
    const isDirty = (file: string) => vscode.workspace.textDocuments?.some(document => document.isDirty
      && document.uri.scheme === 'file' && document.uri.fsPath === file);
    if (isDirty(target) || isDirty(path.join(folder.uri.fsPath, name))) {
      throw new Error('Save the validation configuration before running it. / 请保存验证配置后再运行。');
    }
    const actual = await realpath(target).catch(async (error: NodeJS.ErrnoException) => {
      if (name === 'package.json' && error.code === 'ENOENT') {
        // A dangling symlink also fails realpath. Only an absent entry is inapplicable.
        await lstat(target).catch((statError: NodeJS.ErrnoException) => {
          if (statError.code === 'ENOENT') throw new ValidationUnavailableError('manifest_missing');
          throw statError;
        });
      }
      throw error;
    });
    const info = await lstat(target);
    if (isDirty(actual)) {
      throw new Error('Save the validation configuration before running it. / 请保存验证配置后再运行。');
    }
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_CONFIG_BYTES || !isPathInside(cwd, actual)) {
      throw new Error('Validation configuration is outside the trusted scope or too large. / 验证配置超出可信范围或过大。');
    }
    return await readFile(actual, 'utf8');
  };
  const manifest = await readConfig('package.json');
  const parsed = JSON.parse(manifest) as { scripts?: Record<string, unknown> } | null;
  const scripts = parsed?.scripts;
  const selected = scripts?.[script];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || (scripts !== undefined && (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)))
    || (selected !== undefined && typeof selected !== 'string')) {
    throw new Error('Invalid package.json validation configuration. / package.json 的验证配置无效。');
  }
  if (!selected?.trim()) throw new ValidationUnavailableError('script_missing');
  const names = ['pre' + script, script, 'post' + script];
  const entries = names.flatMap(name => typeof scripts?.[name] === 'string' ? [[name, scripts[name] as string] as const] : []);
  const isolated = approvalMode === 'delegate' && getProjectExecutionMode() === 'isolated';
  if (entries.some(([, definition]) => findSensitiveEvidence(definition) || (!isolated && hasValidationBlockingRisk(definition)))) {
    throw new Error('A validation or lifecycle script has a prohibited effect or contains sensitive material. / 验证或生命周期脚本包含受禁止的操作或敏感内容。');
  }
  const env = createControlledEnvironment([]);
  const useImageNpm = isolated && process.platform === 'win32';
  const { executable, argv, identity } = useImageNpm ? {
    executable: 'npm', argv: ['--userconfig=/dev/null', '--globalconfig=/dev/.keepseek-empty-npmrc', '--workspaces=false', 'run', script],
    identity: { runtime: 'container-npm', cliIdentity: undefined }
  } : await resolveHostNpmLaunch(cwd, script, env);
  const projectExecution = approvalMode === 'delegate'
    ? await inspectProjectExecution(cwd, cwd, executable, useImageNpm ? { containerCommand: 'npm' } : undefined)
    : undefined;
  if (projectExecution && isolated !== (projectExecution.kind !== 'host')) {
    throw new Error('Validation execution settings changed. / 验证执行设置已变化。');
  }
  const configNames = (await readdir(cwd)).filter(name => VALIDATION_CONFIG.test(name)).sort();
  const args = selected.trim().split(/\s+/u);
  if (args.length === 2 && args[0] === 'node' && args[1] === 'out-test/test/runTests.js'
    && await lstat(path.join(cwd, 'test/runTests.ts')).catch(() => undefined)) configNames.push('test/runTests.ts');
  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    const namedConfig = /^(?:--project|--config)=(.+)$/u.exec(arg)?.[1];
    const configArg = namedConfig ?? (['-p', '--project', '-c', '--config'].includes(arg) ? args[++i] : undefined);
    const config = configArg === '.' && !configNames.includes('tsconfig.json') ? undefined
      : configArg === '.' ? 'tsconfig.json' : configArg;
    if (!config || path.isAbsolute(config) || !isPathInside(cwd, path.resolve(cwd, config))) continue;
    // npm runs a shell script. A shell or custom tool can use -c/-p for something other than a file.
    let info = await statIfPresent(config);
    let configFile = config;
    if (info?.isDirectory() && (arg === '-p' || arg === '--project' || arg.startsWith('--project='))) {
      configFile = path.join(config, 'tsconfig.json');
      info = await statIfPresent(configFile);
    }
    if (info && !info.isDirectory() && !configNames.includes(configFile)) configNames.push(configFile);
  }
  if (configNames.length > 32) throw new Error('Too many validation configuration files to verify. / 验证配置文件过多，无法复核。');
  const configs = await Promise.all(configNames.map(async name => [name, hashApprovalText(await readConfig(name))]));
  const npmrc = await statIfPresent('.npmrc');
  if (npmrc?.isSymbolicLink() || (npmrc && !npmrc.isFile())) {
    throw new Error('Cannot verify the project npm configuration target. / 无法核实项目 npm 配置的目标。');
  }
  // The isolated environment confines script-shell and other npm project settings.
  // Bind the file to the reviewed launch without sharing npm tokens or configuration values.
  const npmrcIdentity = npmrc && (isolated ? hashApprovalText(await readConfig('.npmrc'))
    : [npmrc.dev, npmrc.ino, npmrc.size, npmrc.mtimeMs, npmrc.ctimeMs]);
  const cwdUri = folder.uri.toString();
  const scriptEvidence = JSON.stringify(entries);
  const evidence = createBoundedReviewText(redactSensitiveReviewText(scriptEvidence, 12_000));
  const evidenceTruncated = evidence.content !== scriptEvidence;
  const configFingerprint = hashApprovalValue({ cwd, entries, configs, npmrcIdentity, manifest: hashApprovalText(manifest) });
  const { cliIdentity, ...runtimeIdentity } = identity;
  const launchFacts = { cwdUri, configFingerprint, ...runtimeIdentity, argv, env, cliIdentity };
  const fingerprint = hashApprovalValue({ ...launchFacts, projectExecution: projectExecution?.fingerprint });
  return {
    cwd, cwdUri, executable, argv, env, fingerprint, projectExecution,
    historicalFingerprint: projectExecution?.kind === 'host' ? hashApprovalValue(launchFacts) : undefined,
    evidenceComplete: isolated || !npmrc,
    evidence: { ...evidence, totalChars: scriptEvidence.length, contentHash: hashApprovalText(scriptEvidence), truncated: evidenceTruncated },
    configNames
  };
}

async function resolveHostNpmLaunch(cwd: string, script: SafeNpmScript, env: NodeJS.ProcessEnv) {
  const windows = process.platform === 'win32';
  const node = await resolveExecutable('node', cwd, env);
  const npm = await resolveExecutable(windows ? 'npm.cmd' : 'npm', cwd, env);
  const invalidLaunch = () => new Error('Cannot establish the npm and Node launch identity. / 无法确认 npm 和 Node 的启动身份。');
  if (!npm || !node?.trusted || [npm, node].some(program => isPathInside(cwd, program.path))
    || (env.PATH ?? '').split(path.delimiter).some(entry => !path.isAbsolute(entry))) throw invalidLaunch();
  // On Windows, use the pinned Node with npm's adjacent JS entry instead of a cmd.exe shim.
  const bundledCli = windows ? path.join(path.dirname(node.path), 'node_modules', 'npm', 'bin', 'npm-cli.js') : undefined;
  if (windows ? !await installedLaunchPath(node, env.USERPROFILE)
    || path.dirname(npm.path) !== path.dirname(node.path)
    || await realpath(path.dirname(npm.launchPath)) !== path.dirname(node.path)
    : !await inspectInstalledNpmRuntime(npm, env, node)) throw invalidLaunch();
  const windowsCli = bundledCli ? await realpath(bundledCli) : undefined;
  const cli = windowsCli ? await lstat(windowsCli) : undefined;
  if (windows && (!windowsCli || windowsCli !== bundledCli || !cli?.isFile())) throw invalidLaunch();
  const userConfig = windows ? path.join(path.dirname(node.path), 'NUL') : '/dev/null';
  // npm rejects a user and global config with the same filename.
  const globalConfig = windows ? path.join(cwd, 'NUL') : '/dev/.keepseek-empty-npmrc';
  if (!windows && await lstat(globalConfig).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  })) throw new Error('The isolated npm configuration path is unexpectedly occupied. / 隔离 npm 配置路径已被占用。');
  return {
    executable: windows ? node.path : npm.path,
    argv: [...(windowsCli ? [windowsCli] : []), '--userconfig=' + userConfig, '--globalconfig=' + globalConfig,
      '--prefix', cwd, '--workspaces=false', 'run', script],
    identity: { npm, node, cliIdentity: cli && [cli.dev, cli.ino, cli.size, cli.mtimeMs, cli.ctimeMs] }
  };
}

export type ValidationSnapshot = Awaited<ReturnType<typeof inspectValidationSnapshot>>;
