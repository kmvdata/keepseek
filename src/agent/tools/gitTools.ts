import { KEEPSEEK_CONFIGURATION_NAMESPACE } from '../../shared/identity';
import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { resolveExecutable } from '../../approvals/authorization/commandScope';
import { inspectLocalGitScope } from '../../approvals/authorization/localGitScope';
import { canonicalPath, isPathInside, joinUnresolvedPath } from '../../approvals/authorization/pathScope';
import { assertOperationPath } from '../../approvals/authorization/protectedTargets';
import { createControlledEnvironment } from '../../runs/executionEnvironment';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { WorkspaceToolAdapter } from './workspaceTools';

const DEFAULT_DIFF_MAX_CHARS = 100_000;
const MAX_DIFF_MAX_CHARS = 500_000;
const PATCH_MAX_CHARS = 200_000;
const GIT_PROCESS_MAX_BUFFER = 2_000_000;

interface GitReadContext {
  cwd: string;
  executable: string;
  env: NodeJS.ProcessEnv;
  repositoryRoot: string;
}

// Read-only Git CLI is the sole authority for repository state.
const gitReadSource = { source: 'git_cli' } as const;

export interface GitToolAdapter {
  getStatus(input: { workspaceFolder?: string }, language: KeepseekLanguage): Promise<string>;
  getCurrentBranch(input: { workspaceFolder?: string }, language: KeepseekLanguage): Promise<string>;
  getDiff(input: { workspaceFolder?: string; staged?: boolean; path?: string; maxChars?: number }, language: KeepseekLanguage): Promise<string>;
  createPatch(input: { workspaceFolder?: string; staged?: boolean; path?: string }, language: KeepseekLanguage): Promise<string>;
  suggestCommitMessage(input: { workspaceFolder?: string }, language: KeepseekLanguage): Promise<string>;
}

export class GitToolService implements GitToolAdapter {
  public constructor(private readonly workspaceTools: WorkspaceToolAdapter) {}

  public async getStatus(input: { workspaceFolder?: string }, language: KeepseekLanguage): Promise<string> {
    return await this.readStatus(input.workspaceFolder, language, false);
  }

  public async getCurrentBranch(input: { workspaceFolder?: string }, language: KeepseekLanguage): Promise<string> {
    return await this.readStatus(input.workspaceFolder, language, true);
  }

  private async readStatus(workspaceFolder: string | undefined, language: KeepseekLanguage, branchOnly: boolean): Promise<string> {
    const unavailable = getGitUnavailableError(language);
    if (unavailable) {
      return unavailable;
    }

    try {
      const root = requireWorkspaceRoot(workspaceFolder, language);
      const context = await resolveGitReadContext(root, 'status', language);
      const output = await runGit(context, ['status', '--porcelain=v2', '-z', '--branch', '--find-renames',
        branchOnly ? '--untracked-files=no' : '--untracked-files=all', '--', '.']);
      const { branch, changes } = parseGitStatus(output);
      return JSON.stringify({
        ok: true,
        ...gitReadSource,
        repositoryRoot: context.repositoryRoot,
        workspaceRoot: context.cwd,
        branch,
        ...(!branchOnly && { changes, count: changes.length })
      });
    } catch (error) {
      return JSON.stringify(createGitError(language, error));
    }
  }

  public async getDiff(
    input: { workspaceFolder?: string; staged?: boolean; path?: string; maxChars?: number },
    language: KeepseekLanguage
  ): Promise<string> {
    const unavailable = getGitUnavailableError(language);
    if (unavailable) {
      return unavailable;
    }
    return JSON.stringify(await this.readDiff(input, normalizeDiffLimit(input.maxChars), language));
  }

  public async createPatch(
    input: { workspaceFolder?: string; staged?: boolean; path?: string },
    language: KeepseekLanguage
  ): Promise<string> {
    const unavailable = getGitUnavailableError(language);
    if (unavailable) {
      return unavailable;
    }
    const result = await this.readDiff(input, PATCH_MAX_CHARS, language);
    if (!result.ok) {
      return JSON.stringify(result);
    }
    if (result.truncated) {
      return JSON.stringify({
        ...result,
        patch: undefined,
        diff: undefined,
        preview: result.preview,
        error: language === 'en'
          ? 'The patch exceeds the safe output limit. Narrow it with path before generating patch content.'
          : '补丁超过安全输出上限。请先用 path 缩小范围，再生成补丁内容。'
      });
    }
    return JSON.stringify({
      ...result,
      diff: undefined,
      patch: result.diff,
      format: 'unified_diff',
      writtenToDisk: false
    });
  }

  public async suggestCommitMessage(
    input: { workspaceFolder?: string },
    language: KeepseekLanguage
  ): Promise<string> {
    const unavailable = getGitUnavailableError(language);
    if (unavailable) {
      return unavailable;
    }
    let diff = await this.readDiff({ workspaceFolder: input.workspaceFolder, staged: true }, DEFAULT_DIFF_MAX_CHARS, language);
    if (!diff.ok) {
      return JSON.stringify(diff);
    }
    let files = diff.summary?.files ?? [];
    if (!files.length) {
      diff = await this.readDiff({ workspaceFolder: input.workspaceFolder }, DEFAULT_DIFF_MAX_CHARS, language);
      if (!diff.ok) {
        return JSON.stringify(diff);
      }
      files = diff.summary?.files ?? [];
    }
    if (!files.length) {
      return JSON.stringify({
        ok: false,
        source: diff.source,
        error: language === 'en' ? 'No staged or unstaged Git changes were found.' : '未发现已暂存或未暂存的 Git 修改。'
      });
    }
    const type = inferCommitType(files);
    const scope = inferCommitScope(files);
    const subject = language === 'en'
      ? `update ${summarizeFilePurpose(files)}`
      : `更新${summarizeFilePurposeZh(files)}`;
    const conventional = `${type}${scope ? `(${scope})` : ''}: ${subject}`;
    return JSON.stringify({
      ok: true,
      source: diff.source,
      suggestion: conventional,
      alternatives: [
        conventional,
        `${type}: ${language === 'en' ? `update ${files.length} changed file(s)` : `更新 ${files.length} 个文件`}`
      ],
      basedOn: diff.summary,
      staged: diff.staged,
      committed: false
    });
  }

  private async readDiff(
    input: { workspaceFolder?: string; staged?: boolean; path?: string },
    limit: number,
    language: KeepseekLanguage
  ): Promise<GitDiffResult> {
    try {
      const root = requireWorkspaceRoot(input.workspaceFolder, language);
      const context = await resolveGitReadContext(root, 'diff', language);
      const relativePath = input.path ? await this.resolveWorkspaceRelativePath(input.path, root.uri, context.cwd) : undefined;
      const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-relative', '--find-renames', '--numstat', '-z', '--patch'];
      if (input.staged) {
        args.push('--cached');
      }
      const pathspec = ['--', relativePath ?? '.'];
      let output = await runGit(context, [...args, ...pathspec]);
      // For unmerged entries Git prints its combined patch before numstat.
      // Use the first parent explicitly so paths and content stay in one result.
      const conflictBaseline = !input.staged && /^diff --(?:cc|combined) /u.test(output) ? 'ours' : undefined;
      if (conflictBaseline) {
        output = await runGit(context, [...args, '--ours', ...pathspec]);
      }
      const { diff, summary } = parseGitDiff(output, context);
      const truncated = diff.length > limit;
      return {
        ok: true,
        ...gitReadSource,
        repositoryRoot: context.repositoryRoot,
        workspaceRoot: context.cwd,
        staged: input.staged === true,
        path: relativePath,
        conflictBaseline,
        diff: truncated ? undefined : diff,
        preview: truncated ? `${diff.slice(0, Math.min(limit, 20_000))}\n…` : undefined,
        summary,
        charCount: diff.length,
        limit,
        truncated,
        suggestion: truncated
          ? (language === 'en' ? 'Specify path to narrow the diff.' : '请指定 path 缩小 diff 范围。')
          : undefined
      };
    } catch (error) {
      return createGitError(language, error);
    }
  }

  private async resolveWorkspaceRelativePath(rawPath: string, rootUri: vscode.Uri, cwd: string): Promise<string> {
    const uri = /^file:/iu.test(rawPath) || path.isAbsolute(rawPath)
      ? this.workspaceTools.resolveTargetUri(rawPath)
      : undefined;
    const candidate = uri?.fsPath ?? joinUnresolvedPath(cwd, rawPath);
    const lexicalRoot = uri ? rootUri.fsPath : cwd;
    assertOperationPath(candidate);
    if ((uri && uri.scheme !== 'file') || !isPathInside(lexicalRoot, candidate)) {
      throw new Error('Git paths must stay inside the selected workspace folder. / Git 路径必须位于所选工作区文件夹内。');
    }
    const relative = path.relative(lexicalRoot, candidate);
    const canonical = await canonicalPath(candidate);
    assertOperationPath(canonical);
    if (!isPathInside(cwd, canonical) || canonical !== await canonicalPath(path.join(cwd, relative))) {
      throw new Error('The Git path resolves outside its verified scope. / Git 路径解析后超出已核实范围。');
    }
    return relative.split(path.sep).join('/') || '.';
  }
}

interface DiffSummary {
  files: string[];
  fileCount: number;
  additions: number;
  deletions: number;
  hunks: number;
}

type GitDiffResult = Record<string, unknown> & {
  ok: boolean;
  diff?: string;
  preview?: string;
  truncated?: boolean;
  summary?: DiffSummary;
  staged?: boolean;
  source?: 'git_cli';
};

interface GitStatusChange {
  path: string;
  originalPath?: string;
  status: string;
  indexStatus?: string;
  worktreeStatus?: string;
  groups: Array<'staged' | 'working_tree' | 'merge' | 'untracked'>;
}

function parseGitStatus(output: string) {
  const records = output.split('\0');
  if (records.pop() !== '') throw new Error('Invalid Git porcelain status output.');
  const branch: { name?: string; commit?: string; unborn?: boolean; detached?: boolean; upstream?: string; ahead?: number; behind?: number } = {};
  const changes: GitStatusChange[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.startsWith('# ')) {
      const [header] = record.slice(2).split(' ', 1);
      const value = record.slice(header.length + 3);
      if (header === 'branch.oid') {
        branch.unborn = value === '(initial)';
        if (!branch.unborn) branch.commit = value;
      } else if (header === 'branch.head') {
        branch.detached = value === '(detached)';
        if (!branch.detached) branch.name = value;
      } else if (header === 'branch.upstream') {
        branch.upstream = value;
      } else if (header === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/u.exec(value);
        if (match) {
          branch.ahead = Number(match[1]);
          branch.behind = Number(match[2]);
        }
      }
      continue;
    }
    if (record.startsWith('? ')) {
      changes.push({ path: record.slice(2), status: '??', groups: ['untracked'] });
      continue;
    }
    // Porcelain v2 records have a fixed prefix before the literal pathname.
    // Type 2 then carries the source pathname in the next NUL record.
    const type = record[0];
    const fieldCount = type === '1' ? 8 : type === '2' ? 9 : type === 'u' ? 10 : 0;
    const fields = record.split(' ', fieldCount);
    const xy = fields[1];
    const file = record.slice(fields.join(' ').length + 1);
    const originalPath = type === '2' ? records[++index] : undefined;
    if (fields.length !== fieldCount || xy?.length !== 2 || !file || (type === '2' && !originalPath)) {
      throw new Error('Invalid Git porcelain change record.');
    }
    const indexStatus = xy[0] === '.' ? undefined : xy[0];
    const worktreeStatus = xy[1] === '.' ? undefined : xy[1];
    const groups: GitStatusChange['groups'] = [];
    if (type === 'u') {
      groups.push('merge');
    } else {
      if (indexStatus) groups.push('staged');
      if (worktreeStatus) groups.push('working_tree');
    }
    changes.push({ path: file, originalPath, status: xy.replace(/\./gu, ' '), indexStatus, worktreeStatus, groups });
  }
  if (!branch.commit && !branch.unborn) throw new Error('Git status did not identify HEAD.');
  return { branch, changes };
}

function parseGitDiff(output: string, context: GitReadContext): { diff: string; summary: DiffSummary } {
  const files = new Set<string>();
  let diff = '';
  let additions = 0;
  let deletions = 0;
  if (output) {
    // Git writes numstat and the patch from the same diff, with an empty
    // record between the NUL-delimited summary and the text patch.
    const end = output.indexOf('\0\0');
    if (end < 0) throw new Error('Invalid Git numstat output.');
    const records = output.slice(0, end).split('\0');
    diff = output.slice(end + 2);
    for (let index = 0; index < records.length; index += 1) {
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/u.exec(records[index]);
      if (!match) throw new Error('Invalid Git numstat record.');
      const [, added, deleted, file] = match;
      // A rename has an empty path followed by the original and new paths.
      if (!file) {
        assertDiffPath(records[++index], context);
        index += 1;
      }
      const target = file || records[index];
      assertDiffPath(target, context);
      files.add(target);
      if (added !== '-') additions += Number(added);
      if (deleted !== '-') deletions += Number(deleted);
    }
  }
  return {
    diff,
    summary: { files: [...files], fileCount: files.size, additions, deletions, hunks: (diff.match(/^@@+ /gmu) ?? []).length }
  };
}

function assertDiffPath(file: string | undefined, context: GitReadContext): void {
  if (!file || path.isAbsolute(file)) throw new Error('Invalid Git numstat pathname.');
  const target = path.join(context.repositoryRoot, file);
  if (!isPathInside(context.cwd, target)) throw new Error('Git diff contains paths outside its verified scope. / Git diff 包含超出已核实范围的路径。');
  assertOperationPath(target);
}

function requireWorkspaceRoot(requested: string | undefined, language: KeepseekLanguage): vscode.WorkspaceFolder {
  const folders = (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file');
  if (!folders.length) {
    throw new Error(language === 'en' ? 'Open a local workspace before reading Git.' : '请先打开本地工作区，再读取 Git。');
  }
  if (!requested && folders.length === 1) return folders[0];
  const exact = folders.find(folder => folder.uri.fsPath === requested || folder.uri.toString() === requested);
  if (exact) return exact;
  const named = folders.filter(folder => folder.name === requested);
  if (named.length === 1) return named[0];
  throw new Error(language === 'en'
    ? 'Specify a unique workspaceFolder name, path or URI for this Git query.'
    : '请为本次 Git 查询指定唯一的 workspaceFolder 名称、路径或 URI。');
}

async function resolveGitReadContext(root: vscode.WorkspaceFolder, subcommand: 'status' | 'diff', language: KeepseekLanguage): Promise<GitReadContext> {
  const cwd = await realpath(root.uri.fsPath);
  assertOperationPath(cwd);
  // A selected subfolder can read its containing repository's metadata only
  // when the containing workspace is itself open. The query still uses cwd's pathspec.
  const containingRoots = await Promise.all((vscode.workspace.workspaceFolders ?? [])
    .filter(folder => folder.uri.scheme === 'file' && isPathInside(folder.uri.fsPath, root.uri.fsPath))
    .map(folder => realpath(folder.uri.fsPath).catch(() => undefined)));
  const boundary = containingRoots.reduce<string>((outer, candidate) =>
    candidate && candidate.length < outer.length && isPathInside(candidate, cwd) ? candidate : outer, cwd);
  const env = { ...createControlledEnvironment([]), GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
  const executable = await resolveExecutable('git', cwd, env);
  if (!executable?.trusted) {
    throw new Error(language === 'en' ? 'The Git executable could not be verified.' : '无法核实 Git 可执行文件。');
  }
  const scope = await inspectLocalGitScope({ executable: executable.path, cwd, roots: [boundary], cwdChanges: [], subcommand, env,
    noOptionalLocks: true, noIndexRefresh: subcommand === 'diff' });
  if ('reason' in scope) throw new Error(scope.reason);
  return { cwd, executable: executable.path, env, repositoryRoot: scope.repository };
}

function normalizeDiffLimit(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_DIFF_MAX_CHARS;
  }
  return Math.min(Math.max(Math.floor(value), 1_000), MAX_DIFF_MAX_CHARS);
}

function inferCommitType(files: string[]): string {
  if (files.every((file) => /(?:^|\/)(?:test|tests)\//u.test(file) || /\.(?:test|spec)\./u.test(file))) {
    return 'test';
  }
  if (files.every((file) => /\.(?:md|mdx|txt)$/iu.test(file))) {
    return 'docs';
  }
  if (files.some((file) => /(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/u.test(file))) {
    return 'chore';
  }
  return 'feat';
}

function inferCommitScope(files: string[]): string | undefined {
  const topLevels = Array.from(new Set(files.map((file) => file.split('/').filter(Boolean)[0]).filter(Boolean)));
  return topLevels.length === 1 ? topLevels[0]?.replace(/[^a-z0-9_-]/giu, '').toLowerCase() || undefined : undefined;
}

function summarizeFilePurpose(files: string[]): string {
  return files.length === 1 ? files[0] : `${files.length} files`;
}

function summarizeFilePurposeZh(files: string[]): string {
  return files.length === 1 ? files[0] : `${files.length} 个文件`;
}

async function runGit(context: GitReadContext, args: string[]): Promise<string> {
  if (!vscode.workspace.isTrusted) throw new Error('Workspace trust changed. / 工作区信任已变更。');
  const globalOptions = ['--no-pager', '--no-optional-locks', '--literal-pathspecs'];
  // Porcelain diff can refresh index stat entries despite no optional locks.
  if (args[0] === 'diff') globalOptions.push('-c', 'diff.autoRefreshIndex=false');
  return await new Promise((resolve, reject) => {
    execFile(context.executable, [...globalOptions, ...args], {
      cwd: context.cwd,
      encoding: 'utf8',
      maxBuffer: GIT_PROCESS_MAX_BUFFER,
      env: context.env,
      timeout: 10_000,
      shell: false,
      windowsHide: true
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(String(stderr || stdout || error.message).trim()));
        return;
      }
      resolve(String(stdout));
    });
  });
}

function createError(language: KeepseekLanguage, english: string, chinese: string): string {
  return JSON.stringify({ ok: false, error: language === 'en' ? english : chinese });
}

function getGitUnavailableError(language: KeepseekLanguage): string | undefined {
  if (!vscode.workspace.getConfiguration(KEEPSEEK_CONFIGURATION_NAMESPACE).get<boolean>('useGit', true)) {
    return createError(language, 'Git integration is disabled in KeepSeek settings.', 'KeepSeek 设置中已禁用 Git 集成。');
  }
  if (!vscode.workspace.isTrusted) {
    return createError(
      language,
      'Trust this workspace before KeepSeek starts a Git integration command.',
      '请先信任当前工作区，再让 KeepSeek 启动 Git 集成命令。'
    );
  }
  return undefined;
}

function createGitError(language: KeepseekLanguage, error: unknown): GitDiffResult {
  return {
    ok: false,
    ...gitReadSource,
    error: language === 'en'
      ? `Git read failed: ${formatError(error)}`
      : `Git 读取失败：${formatError(error)}`
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
