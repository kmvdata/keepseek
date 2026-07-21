import { execFile } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { WorkspaceToolAdapter } from './workspaceTools';

const DEFAULT_DIFF_MAX_CHARS = 100_000;
const MAX_DIFF_MAX_CHARS = 500_000;
const PATCH_MAX_CHARS = 200_000;
const GIT_PROCESS_MAX_BUFFER = 2_000_000;

interface GitResourceStateLike {
  resourceUri: vscode.Uri;
  type?: number;
}

interface GitRepositoryStateLike {
  HEAD?: {
    name?: string;
    commit?: string;
    upstream?: { name?: string; remote?: string };
    ahead?: number;
    behind?: number;
  };
  indexChanges?: GitResourceStateLike[];
  workingTreeChanges?: GitResourceStateLike[];
  mergeChanges?: GitResourceStateLike[];
  untrackedChanges?: GitResourceStateLike[];
}

interface GitRepositoryLike {
  rootUri: vscode.Uri;
  state: GitRepositoryStateLike;
  status(): Promise<void>;
  diff(cached?: boolean): Promise<string>;
  diffWithHEAD?(path?: string): Promise<string>;
  diffIndexWithHEAD?(path?: string): Promise<string>;
}

interface GitApiLike {
  repositories: GitRepositoryLike[];
}

interface GitExtensionLike {
  enabled: boolean;
  getAPI(version: 1): GitApiLike;
}

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
    const unavailable = getGitUnavailableError(language);
    if (unavailable) {
      return unavailable;
    }
    const root = findWorkspaceRoot(input.workspaceFolder);
    if (!root) {
      return createError(language, 'Open a workspace before reading Git status.', '请先打开工作区，再读取 Git 状态。');
    }
    const resolved = await this.resolveRepository(root);
    if (resolved.repository) {
      try {
        await resolved.repository.status();
        const state = resolved.repository.state;
        const changes = [
          ...serializeChangeGroup('staged', state.indexChanges),
          ...serializeChangeGroup('working_tree', state.workingTreeChanges),
          ...serializeChangeGroup('merge', state.mergeChanges),
          ...serializeChangeGroup('untracked', state.untrackedChanges)
        ];
        return JSON.stringify({
          ok: true,
          providerAvailable: true,
          fallback: false,
          repositoryRoot: resolved.repository.rootUri.fsPath,
          branch: serializeBranch(state.HEAD),
          changes,
          count: changes.length
        });
      } catch (error) {
        resolved.fallbackReason = `VS Code Git API status failed: ${formatError(error)}`;
      }
    }

    try {
      const output = await runGit(root.uri.fsPath, ['status', '--short', '--branch', '--untracked-files=all', '--', '.']);
      const lines = output.split(/\r?\n/u).filter(Boolean);
      return JSON.stringify({
        ok: true,
        providerAvailable: false,
        fallback: true,
        fallbackReason: resolved.fallbackReason,
        repositoryRoot: root.uri.fsPath,
        branchLine: lines[0]?.startsWith('##') ? lines.shift() : undefined,
        changes: lines.map((line) => ({ status: line.slice(0, 2), path: line.slice(3) })),
        count: lines.length
      });
    } catch (error) {
      return createGitError(language, resolved.fallbackReason, error);
    }
  }

  public async getCurrentBranch(input: { workspaceFolder?: string }, language: KeepseekLanguage): Promise<string> {
    const unavailable = getGitUnavailableError(language);
    if (unavailable) {
      return unavailable;
    }
    const root = findWorkspaceRoot(input.workspaceFolder);
    if (!root) {
      return createError(language, 'Open a workspace before reading the Git branch.', '请先打开工作区，再读取 Git 分支。');
    }
    const resolved = await this.resolveRepository(root);
    const head = resolved.repository?.state.HEAD;
    if (resolved.repository && head) {
      return JSON.stringify({
        ok: true,
        providerAvailable: true,
        fallback: false,
        repositoryRoot: resolved.repository.rootUri.fsPath,
        branch: serializeBranch(head)
      });
    }

    try {
      const [branch, commit, upstream] = await Promise.all([
        runGit(root.uri.fsPath, ['branch', '--show-current']),
        runGit(root.uri.fsPath, ['rev-parse', '--short', 'HEAD']),
        runGit(root.uri.fsPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']).catch(() => '')
      ]);
      return JSON.stringify({
        ok: true,
        providerAvailable: false,
        fallback: true,
        fallbackReason: resolved.fallbackReason,
        repositoryRoot: root.uri.fsPath,
        branch: { name: branch.trim() || undefined, commit: commit.trim() || undefined, upstream: upstream.trim() || undefined }
      });
    } catch (error) {
      return createGitError(language, resolved.fallbackReason, error);
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
    let diff = await this.readDiff({ workspaceFolder: input.workspaceFolder }, DEFAULT_DIFF_MAX_CHARS, language);
    if (!diff.ok) {
      return JSON.stringify(diff);
    }
    let files = diff.summary?.files ?? [];
    if (!files.length) {
      diff = await this.readDiff({ workspaceFolder: input.workspaceFolder, staged: true }, DEFAULT_DIFF_MAX_CHARS, language);
      files = diff.summary?.files ?? [];
    }
    if (!files.length) {
      return JSON.stringify({
        ok: false,
        providerAvailable: diff.providerAvailable,
        fallback: diff.fallback,
        fallbackReason: diff.fallbackReason,
        error: language === 'en' ? 'No unstaged Git changes were found.' : '没有发现未暂存的 Git 修改。'
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
      providerAvailable: diff.providerAvailable,
      fallback: diff.fallback,
      fallbackReason: diff.fallbackReason,
      suggestion: conventional,
      alternatives: [
        conventional,
        `${type}: ${language === 'en' ? `update ${files.length} changed file(s)` : `更新 ${files.length} 个文件`}`
      ],
      basedOn: diff.summary,
      committed: false
    });
  }

  private async readDiff(
    input: { workspaceFolder?: string; staged?: boolean; path?: string },
    limit: number,
    language: KeepseekLanguage
  ): Promise<Record<string, unknown> & { ok: boolean; diff?: string; preview?: string; truncated?: boolean; summary?: DiffSummary; providerAvailable?: boolean; fallback?: boolean; fallbackReason?: string }> {
    const root = findWorkspaceRoot(input.workspaceFolder);
    if (!root) {
      return JSON.parse(createError(language, 'Open a workspace before reading Git diff.', '请先打开工作区，再读取 Git diff。')) as { ok: false };
    }
    const relativePath = input.path ? this.resolveRepoRelativePath(input.path, root.uri) : undefined;
    const resolved = await this.resolveRepository(root);
    let diff: string | undefined;
    if (resolved.repository) {
      try {
        diff = input.staged
          ? await (resolved.repository.diffIndexWithHEAD?.(relativePath) ?? resolved.repository.diff(true))
          : await (resolved.repository.diffWithHEAD?.(relativePath) ?? resolved.repository.diff(false));
      } catch (error) {
        resolved.fallbackReason = `VS Code Git API diff failed: ${formatError(error)}`;
      }
    }

    let fallback = false;
    if (diff === undefined) {
      fallback = true;
      const args = ['diff'];
      if (input.staged) {
        args.push('--cached');
      }
      if (relativePath) {
        args.push('--', relativePath);
      } else {
        args.push('--', '.');
      }
      try {
        diff = await runGit(root.uri.fsPath, args);
      } catch (error) {
        return JSON.parse(createGitError(language, resolved.fallbackReason, error)) as { ok: false };
      }
    }

    const summary = summarizeDiff(diff);
    const truncated = diff.length > limit;
    return {
      ok: true,
      providerAvailable: !fallback,
      fallback,
      fallbackReason: fallback ? resolved.fallbackReason : undefined,
      repositoryRoot: root.uri.fsPath,
      staged: input.staged === true,
      path: relativePath,
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
  }

  private async resolveRepository(root: vscode.WorkspaceFolder): Promise<{ repository?: GitRepositoryLike; fallbackReason: string }> {
    const extension = vscode.extensions.getExtension<GitExtensionLike>('vscode.git');
    if (!extension) {
      return { fallbackReason: 'The built-in VS Code Git extension is unavailable.' };
    }
    try {
      const gitExtension = extension.isActive ? extension.exports : await extension.activate();
      if (!gitExtension?.enabled) {
        return { fallbackReason: 'The built-in VS Code Git extension is disabled.' };
      }
      const api = gitExtension.getAPI(1);
      const repository = api.repositories.find((candidate) => candidate.rootUri.toString() === root.uri.toString());
      const containingRepository = api.repositories.find((candidate) => isUriInside(root.uri, candidate.rootUri));
      return repository
        ? { repository, fallbackReason: '' }
        : {
            fallbackReason: containingRepository
              ? 'The Git repository contains a broader path than the workspace folder; KeepSeek uses a workspace-scoped read-only fallback.'
              : 'The VS Code Git extension has no repository for this workspace folder.'
          };
    } catch (error) {
      return { fallbackReason: `The VS Code Git extension could not be activated: ${formatError(error)}` };
    }
  }

  private resolveRepoRelativePath(rawPath: string, rootUri: vscode.Uri): string {
    const uri = /^file:/iu.test(rawPath) || path.isAbsolute(rawPath)
      ? this.workspaceTools.resolveTargetUri(rawPath)
      : vscode.Uri.joinPath(rootUri, ...rawPath.split(/[\\/]+/u).filter(Boolean));
    if (!isUriInside(uri, rootUri)) {
      throw new Error('Git path scope must stay inside the selected workspace folder.');
    }
    return path.relative(rootUri.fsPath, uri.fsPath).split(path.sep).join('/');
  }
}

interface DiffSummary {
  files: string[];
  fileCount: number;
  additions: number;
  deletions: number;
  hunks: number;
}

function summarizeDiff(diff: string): DiffSummary {
  const files = Array.from(new Set(Array.from(diff.matchAll(/^\+\+\+ b\/(.+)$/gmu), (match) => match[1]).filter(Boolean)));
  const lines = diff.split(/\r?\n/u);
  return {
    files,
    fileCount: files.length,
    additions: lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length,
    deletions: lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length,
    hunks: lines.filter((line) => line.startsWith('@@')).length
  };
}

function serializeChangeGroup(group: string, changes: GitResourceStateLike[] | undefined): Array<Record<string, unknown>> {
  return (changes ?? []).map((change) => ({
    group,
    path: vscode.workspace.asRelativePath(change.resourceUri, false),
    uri: change.resourceUri.toString(),
    status: change.type
  }));
}

function serializeBranch(head: GitRepositoryStateLike['HEAD']): Record<string, unknown> | undefined {
  if (!head) {
    return undefined;
  }
  return {
    name: head.name,
    commit: head.commit,
    upstream: head.upstream?.name,
    remote: head.upstream?.remote,
    ahead: head.ahead,
    behind: head.behind
  };
}

function findWorkspaceRoot(requested: string | undefined): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const target = requested?.trim();
  if (!target) {
    return folders[0];
  }
  return folders.find((folder) => folder.name === target || folder.uri.fsPath === target || folder.uri.toString() === target);
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

function isUriInside(uri: vscode.Uri, parent: vscode.Uri): boolean {
  const relative = path.relative(parent.fsPath, uri.fsPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: GIT_PROCESS_MAX_BUFFER,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }
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
  if (!vscode.workspace.getConfiguration('keepseek').get<boolean>('useGit', true)) {
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

function createGitError(language: KeepseekLanguage, fallbackReason: string | undefined, error: unknown): string {
  return JSON.stringify({
    ok: false,
    providerAvailable: false,
    fallback: true,
    fallbackReason,
    error: language === 'en'
      ? `Git read failed: ${formatError(error)}`
      : `Git 读取失败：${formatError(error)}`
  });
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
