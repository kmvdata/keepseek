import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { DraftRun } from '../shared/types';
import { analyzeCommand } from '../approvals/authorization/commandSemantics';
import { inspectDraftRunScope, type CommandScope } from '../approvals/authorization/commandScope';
import { createControlledEnvironment } from './executionEnvironment';

const execGit = promisify(execFile);
const maxPaths = 512;
const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;

export type LocalGitCommitEvidence = {
  rootTaskId: string;
  repositoryUri: string;
  previousHead: string | null;
  remainingStatus: string;
} & ({ outcome: 'no_changes'; executed: false } | {
  outcome: 'verified'; executed: true; head: string; message: string; files: string[];
});

interface CommitSnapshot {
  repositoryUri: string;
  executable: string;
  previousHead: string | null;
  branchRef: string | null;
  files: string[];
}

export interface LocalGitStageEvidence {
  repositoryUri: string;
  directoryUri: string;
  head: string | null;
  branchRef: string | null;
  indexHash: string;
}

export async function readLocalGitStage(run: DraftRun, scope: CommandScope, signal?: AbortSignal): Promise<LocalGitStageEvidence | undefined> {
  const location = getScopedGitLocation(scope);
  if (!location) return undefined;
  const read = (args: string[]) => readGit(run, location, args, signal);
  return { repositoryUri: location.repositoryUri, directoryUri: scope.gitCwd ?? scope.cwd, ...await readStageState(read) };
}

export function normalizeLocalGitStageEvidence(value: unknown): LocalGitStageEvidence | undefined {
  const v = value as Partial<LocalGitStageEvidence> | undefined;
  if (!v || typeof v.repositoryUri !== 'string' || !v.repositoryUri.startsWith('file:')
    || typeof v.directoryUri !== 'string' || !v.directoryUri.startsWith('file:')
    || (v.head !== null && !(typeof v.head === 'string' && objectId.test(v.head)))
    || (v.branchRef !== null && !(typeof v.branchRef === 'string' && v.branchRef.startsWith('refs/heads/')))
    || typeof v.indexHash !== 'string' || !/^[a-f0-9]{64}$/u.test(v.indexHash)) return undefined;
  return { repositoryUri: v.repositoryUri, directoryUri: v.directoryUri, head: v.head, branchRef: v.branchRef, indexHash: v.indexHash };
}

export function isExplicitLocalCommitGoal(goal: string): boolean {
  const text = goal.trim();
  if (/\b(?:do not|don't|never)\s+(?:(?:run|make)\s+)?(?:a\s+)?(?:`?git\s+)?commit\b|(?:不要|无需|禁止|暂不|不得|请勿|别)\s*(?:执行|进行|实际|做)?\s*(?:`?git\s+commit|提交)/iu.test(text)
    || /^(?:请\s*)?(?:解释|介绍|说明|分析)\s*`?git\s+commit\b|^(?:what|how|why)\b[^\n]{0,60}\bgit\s+commit\b|\bgit\s+commit\b[^\n]{0,30}(?:怎么用|是什么意思)/iu.test(text)) return false;
  return /^`?git\s+commit\b|\b(?:run|execute|use|make|create|perform|then)\b[^\n]{0,100}\bgit\s+commit\b|(?:执行|运行|使用|完成|然后|用)[^\n]{0,35}\bgit\s+commit\b|\bcommit\b.{0,90}\b(?:local(?:ly)?|changes?|repo(?:sitory)?|without pushing)\b|\bcommit\s+(?:everything|all|staged)\b|(?:提交到|提交至|本地提交|提交一次|一次提交|提交(?:代码|改动|变更|暂存))|生成.{0,30}提交.{0,16}(?:并|然后)提交/iu.test(text);
}

export function isSingleLocalCommitGoal(goal: string): boolean {
  return /\bgit\s+commit\s+-am\b|(?:一次|一个)(?:\s*本地)?(?:\s*Git)?\s*提交|提交一次|\b(?:one|single)\s+(?:local\s+)?(?:git\s+)?commit\b/iu.test(goal);
}

export function isStageThenCommitGoal(goal: string): boolean {
  return /\bgit\s+add\s+--all\s+\.(?=$|[\s`'",，。;；])/iu.test(goal) && /\bgit\s+commit\s+-am\b/iu.test(goal)
    && isExplicitLocalCommitGoal(goal);
}

export async function prepareLocalGitCommit(run: DraftRun, scope: CommandScope, rootTaskId: string, signal?: AbortSignal,
  stage?: LocalGitStageEvidence): Promise<
  { outcome: 'ready'; snapshot: CommitSnapshot } | { outcome: 'no_changes'; evidence: LocalGitCommitEvidence } | undefined
> {
  const command = analyzeCommand(run.spec).gitCommit;
  const location = getScopedGitLocation(scope);
  if (!command || !location) return undefined;
  const read = (args: string[]) => readGit(run, location, args, signal);
  // A successful symbolic-ref plus an absent branch ref is an unborn branch.
  // Other HEAD failures are errors, including a corrupt or ambiguous HEAD.
  const current = stage ? await readStageState(read) : undefined;
  if (stage && (!current || stage.repositoryUri !== location.repositoryUri || stage.head !== current.head
    || stage.branchRef !== current.branchRef || stage.indexHash !== current.indexHash)) {
    throw new Error('Git HEAD, branch or index changed after staging. Review the repository before committing. / 暂存后 Git HEAD、分支或索引已变化，请重新核对仓库。');
  }
  const previousHead = current ? current.head : await readHead(read);
  const branchRef = current ? current.branchRef : await readBranchRef(read, previousHead);
  const staged = await read(['diff', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z']);
  if (command.all && stage && await read(['diff', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z'])) {
    throw new Error('Tracked files changed after staging. Review the staged and unstaged changes before committing with -a. / 暂存后有跟踪文件发生变化。请先核对暂存与未暂存改动，再使用 -a 提交。');
  }
  // With -a, the effective diff is HEAD to tracked working-tree content,
  // including index additions. An unborn branch has no HEAD to diff against.
  const unstaged = command.all ? await read(['diff', ...(previousHead ? ['HEAD'] : []), '--name-only',
    '--no-renames', '--no-ext-diff', '--no-textconv', '-z']) : '';
  const files = [...new Set(gitPaths(command.all && previousHead ? unstaged : staged + unstaged))].sort();
  if (files.length > maxPaths) throw new Error('Too many commit paths to verify automatically. / 提交路径过多，无法自动核验。');
  const cwd = vscode.Uri.parse(stage?.directoryUri ?? scope.gitCwd ?? scope.cwd).fsPath;
  const prefix = relative(vscode.Uri.parse(location.repositoryUri).fsPath, cwd).split(sep).join('/');
  if (isAbsolute(prefix) || prefix === '..' || prefix.startsWith('../')
    || (prefix && files.some(file => !file.startsWith(prefix + '/')))) {
    throw new Error('The proposed commit includes paths outside its working directory. / 待提交内容包含工作目录之外的路径。');
  }
  if (!files.length) return { outcome: 'no_changes', evidence: { rootTaskId, repositoryUri: location.repositoryUri,
    previousHead, remainingStatus: await readRemainingStatus(read), outcome: 'no_changes', executed: false } };
  return { outcome: 'ready', snapshot: { ...location, previousHead, branchRef, files } };
}

function getScopedGitLocation(scope: CommandScope): Pick<CommitSnapshot, 'repositoryUri' | 'executable'> | undefined {
  const repository = scope.paths.find(target => target.role === 'repository' && !target.external);
  return repository && scope.executable && !scope.uncertain && !scope.externalUris.length
    ? { repositoryUri: repository.uri, executable: scope.executable } : undefined;
}

async function readStageState(read: (args: string[]) => Promise<string>): Promise<Pick<LocalGitStageEvidence, 'head' | 'branchRef' | 'indexHash'>> {
  const head = await readHead(read);
  const branchRef = await readBranchRef(read, head);
  const index = await read(['ls-files', '--stage', '-z']);
  return { head, branchRef, indexHash: createHash('sha256').update(index).digest('hex') };
}

export async function verifyLocalGitCommit(run: DraftRun, snapshot: CommitSnapshot, rootTaskId: string,
  signal?: AbortSignal): Promise<LocalGitCommitEvidence> {
  const scope = await inspectDraftRunScope(run);
  if (scope.uncertain || scope.externalUris.length || scope.executable !== snapshot.executable
    || !scope.paths.some(target => target.role === 'repository' && target.uri === snapshot.repositoryUri)) {
    throw new Error('Git repository identity or scope changed after execution. / Git 执行后仓库身份或范围已变化。');
  }
  const read = (args: string[]) => readGit(run, snapshot, args, signal);
  const [head, parents, message] = (await read(['show', '-s', '--no-show-signature', '--format=%H%x00%P%x00%B', 'HEAD'])).split('\0');
  if (!objectId.test(head) || head === snapshot.previousHead || parents !== (snapshot.previousHead ?? '') || !message?.trim()) {
    throw new Error('The new HEAD and parent do not establish the requested commit. / 新 HEAD 和父提交无法证明本次提交已完成。');
  }
  const files = gitPaths(await read(['diff-tree', '--root', '--no-commit-id', '--name-only', '--no-renames', '-r', '-z', head])).sort();
  if (JSON.stringify(files) !== JSON.stringify(snapshot.files)) {
    throw new Error('The committed paths differ from the verified candidate paths. / 实际提交路径与执行前核实的路径不一致。');
  }
  const remainingStatus = await readRemainingStatus(read);
  if (await readHead(read) !== head || await readBranchRef(read, head) !== snapshot.branchRef) {
    throw new Error('HEAD or branch changed during verification. / 核验过程中 HEAD 或分支已变化。');
  }
  return { rootTaskId, repositoryUri: snapshot.repositoryUri, previousHead: snapshot.previousHead,
    outcome: 'verified', executed: true, head, message: message.trimEnd(), files, remainingStatus };
}

export function normalizeLocalGitCommitEvidence(value: unknown): LocalGitCommitEvidence | undefined {
  const v = value as Partial<LocalGitCommitEvidence> | undefined;
  if (!v || typeof v.rootTaskId !== 'string' || !v.rootTaskId || typeof v.repositoryUri !== 'string'
    || !v.repositoryUri.startsWith('file:') || (v.previousHead !== null
      && !(typeof v.previousHead === 'string' && objectId.test(v.previousHead)))
    || typeof v.remainingStatus !== 'string' || Buffer.byteLength(v.remainingStatus) > 32 * 1024) return undefined;
  if (v.outcome === 'no_changes' && v.executed === false) return { outcome: v.outcome, executed: v.executed,
    rootTaskId: v.rootTaskId, repositoryUri: v.repositoryUri, previousHead: v.previousHead, remainingStatus: v.remainingStatus };
  if (v.outcome === 'verified' && v.executed === true && typeof v.head === 'string' && objectId.test(v.head)
    && typeof v.message === 'string' && Array.isArray(v.files) && v.files.length <= maxPaths
    && v.files.every(file => typeof file === 'string')) {
    return { outcome: v.outcome, executed: v.executed, rootTaskId: v.rootTaskId, repositoryUri: v.repositoryUri,
      previousHead: v.previousHead, head: v.head, message: v.message, files: [...v.files], remainingStatus: v.remainingStatus };
  }
  return undefined;
}

async function readRemainingStatus(read: (args: string[]) => Promise<string>): Promise<string> {
  const status = await read(['status', '--porcelain=v1', '--untracked-files=all', '-z']);
  if (Buffer.byteLength(status) > 32 * 1024) {
    throw new Error('The remaining Git status is too large to record safely. / 剩余 Git 状态过大，无法安全记录。');
  }
  return status;
}

async function readGit(run: DraftRun, location: Pick<CommitSnapshot, 'repositoryUri' | 'executable'>,
  args: string[], signal?: AbortSignal): Promise<string> {
  // Git diff can refresh the index independently of --no-optional-locks.
  const readOnlyDiff = args[0] === 'diff' ? ['-c', 'diff.autoRefreshIndex=false'] : [];
  const { stdout } = await execGit(location.executable, ['--no-pager', '--no-optional-locks', ...readOnlyDiff, ...args], {
    cwd: vscode.Uri.parse(location.repositoryUri).fsPath, env: createControlledEnvironment(run.spec.env),
    timeout: 5000, maxBuffer: 1024 * 1024, windowsHide: true, signal, encoding: 'buffer'
  });
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(stdout);
}

async function readHead(read: (args: string[]) => Promise<string>): Promise<string | null> {
  const head = await read(['rev-parse', '--verify', '--quiet', 'HEAD']).catch((error: NodeJS.ErrnoException) => {
    if (Number(error.code) !== 1) throw error;
    return '';
  });
  if (objectId.test(head.trim())) return head.trim();
  if (!head && (await read(['symbolic-ref', 'HEAD'])).trim().startsWith('refs/heads/')) return null;
  throw new Error('Git HEAD could not be verified. / 无法核实 Git HEAD。');
}

async function readBranchRef(read: (args: string[]) => Promise<string>, head: string | null): Promise<string | null> {
  return await read(['symbolic-ref', '--quiet', 'HEAD']).then(ref => {
    const branch = ref.trim();
    if (!branch.startsWith('refs/heads/')) throw new Error('Git branch ref could not be verified. / 无法核实 Git 分支引用。');
    return branch;
  }).catch((error: NodeJS.ErrnoException) => {
    if (Number(error.code) === 1 && head) return null;
    throw error;
  });
}

function gitPaths(value: string): string[] {
  if (!value) return [];
  if (!value.endsWith('\0')) {
    throw new Error('Git paths could not be decoded without loss. / 无法无损读取 Git 路径。');
  }
  return value.slice(0, -1).split('\0');
}
