import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveExecutable } from '../../approvals/authorization/commandScope';
import { isPathInside } from '../../approvals/authorization/pathScope';
import { createBoundedReviewText, hashApprovalText, hashApprovalValue } from '../../approvals/approvalReviewHash';
import { findSensitiveEvidence, redactSensitiveReviewText } from '../../approvals/approvalPolicy';
import { createControlledEnvironment } from '../../runs/executionEnvironment';
import type { SafeNpmScript } from '../../shared/types';
import { hasValidationBlockingRisk } from './validationRisk';

const MAX_CONFIG_BYTES = 1_000_000;
const VALIDATION_CONFIG = /^(?:tsconfig(?:\.[\w.-]+)?\.json|jsconfig\.json|(?:eslint|vitest|vite|jest|babel|webpack|playwright|rollup|mocha)\.config\.[\w.-]+|\.(?:eslintrc|babelrc|mocharc)(?:\.[\w.-]+)?|bunfig\.toml)$/u;

export class ValidationUnavailableError extends Error {
  public constructor(public readonly reason: 'manifest_missing' | 'script_missing') {
    super(reason);
  }
}

export async function inspectValidationSnapshot(folder: vscode.WorkspaceFolder, script: SafeNpmScript) {
  if (folder.uri.scheme !== 'file') throw new Error('Validation requires a local extension-host folder. / 验证需要扩展宿主上的本地目录。');
  const cwd = await realpath(folder.uri.fsPath);
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
  if (entries.some(([, definition]) => hasValidationBlockingRisk(definition) || findSensitiveEvidence(definition))) {
    throw new Error('A validation or lifecycle script has a prohibited effect or contains sensitive material. / 验证或生命周期脚本包含受禁止的操作或敏感内容。');
  }
  const env = createControlledEnvironment([]);
  const windows = process.platform === 'win32';
  const node = await resolveExecutable('node', cwd, env);
  const npm = await resolveExecutable(windows ? 'npm.cmd' : 'npm', cwd, env);
  // On Windows, launch the adjacent JS entry through the pinned node.exe
  // without handing argv to cmd.exe. Unsupported shim layouts fail closed.
  const windowsCli = windows && npm
    ? await realpath(path.join(path.dirname(npm.path), 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    : undefined;
  const cliInfo = windowsCli ? await lstat(windowsCli) : undefined;
  // npm is a runtime dependency. Reject project-local PATH shims and relative
  // PATH entries, which can silently change resolution after npm changes cwd.
  if (!npm || !node || [npm, node].some(program => isPathInside(cwd, program.path))
    || (windows && (!windowsCli || !cliInfo?.isFile() || isPathInside(cwd, windowsCli)))
    || (env.PATH ?? '').split(path.delimiter).some(entry => !path.isAbsolute(entry))) {
    throw new Error('Cannot establish the npm and Node launch identity. / 无法确认 npm 和 Node 的启动身份。');
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
    if (config && !path.isAbsolute(config) && isPathInside(cwd, path.resolve(cwd, config)) && !configNames.includes(config)) {
      configNames.push(config);
    }
  }
  if (configNames.length > 32) throw new Error('Too many validation configuration files to verify. / 验证配置文件过多，无法复核。');
  const configs = await Promise.all(configNames.map(async name => [name, hashApprovalText(await readConfig(name))]));
  const npmrc = await lstat(path.join(cwd, '.npmrc')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (npmrc?.isSymbolicLink() || (npmrc && !npmrc.isFile())) {
    throw new Error('Cannot verify the project npm configuration target. / 无法核实项目 npm 配置的目标。');
  }
  const npmrcIdentity = npmrc && [npmrc.dev, npmrc.ino, npmrc.size, npmrc.mtimeMs, npmrc.ctimeMs];
  const userConfig = windows ? path.join(path.dirname(node.path), 'NUL') : '/dev/null';
  // npm rejects a user and global config with the same filename.
  const globalConfig = windows ? path.join(cwd, 'NUL') : '/dev/.keepseek-empty-npmrc';
  if (!windows && await lstat(globalConfig).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  })) throw new Error('The isolated npm configuration path is unexpectedly occupied. / 隔离 npm 配置路径已被占用。');
  const executable = windows ? node.path : npm.path;
  const argv = [...(windowsCli ? [windowsCli] : []), '--userconfig=' + userConfig, '--globalconfig=' + globalConfig,
    '--prefix', cwd, '--workspaces=false', 'run', script];
  const cwdUri = folder.uri.toString();
  const scriptEvidence = JSON.stringify(entries);
  const evidence = createBoundedReviewText(redactSensitiveReviewText(scriptEvidence, 12_000));
  const evidenceComplete = evidence.content === scriptEvidence;
  const configFingerprint = hashApprovalValue({ cwd, entries, configs, npmrcIdentity, manifest: hashApprovalText(manifest) });
  const fingerprint = hashApprovalValue({ cwdUri, configFingerprint, npm, node, argv, env, cliIdentity: cliInfo && [cliInfo.dev, cliInfo.ino, cliInfo.size, cliInfo.mtimeMs, cliInfo.ctimeMs] });
  return {
    cwd, cwdUri, executable, argv, env, fingerprint,
    evidenceComplete: evidenceComplete && !npmrc,
    evidence: { ...evidence, truncated: !evidenceComplete },
    configNames
  };
}

export type ValidationSnapshot = Awaited<ReturnType<typeof inspectValidationSnapshot>>;
