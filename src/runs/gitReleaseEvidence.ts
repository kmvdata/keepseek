import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { analyzeCommand, isGitReleaseRef } from '../approvals/authorization/commandSemantics';
import { findSensitiveEvidence } from '../approvals/approvalPolicy';
import { inspectDraftRunScope, type CommandScope } from '../approvals/authorization/commandScope';
import { checkDraftRunApprovalIdentity } from '../approvals/authorization/executionBoundary';
import type { DraftRun } from '../shared/types';
import type { GitRemoteLaunch } from './gitReleaseAuthorization';
import { prepareGitTransportEnvironment } from './gitTransportEnvironment';
import { gitReleaseIntent, gitTaskText, isGitInstructionQuotedOrExplanatory, taskNamesGitRef, type GitReleaseIntent } from './gitTaskIntent';

const git = promisify(execFile);
const oid = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
export interface GitReleaseRefEvidence {
  ref: string;
  object: string;
  peeled?: string;
}

export interface GitReleaseEvidence {
  kind: 'tag' | 'query' | 'push';
  repositoryUri: string;
  /** Binds new local tag evidence to the inspected metadata directory. */
  repositoryIdentity?: string;
  /** The transport binding is an opaque hash, not a credential or URL. */
  destinationHash?: string;
  refs: GitReleaseRefEvidence[];
  refsRequested?: string[];
  matchesPushDestination?: boolean;
  executed: boolean;
}

export function normalizeGitReleaseEvidence(value: unknown): GitReleaseEvidence | undefined {
  const v = value as Partial<GitReleaseEvidence> | undefined;
  if (!v || !['tag', 'query', 'push'].includes(v.kind ?? '') || typeof v.executed !== 'boolean'
    || typeof v.repositoryUri !== 'string' || !v.repositoryUri.startsWith('file:')
    || (v.repositoryIdentity !== undefined && (v.kind !== 'tag' || typeof v.repositoryIdentity !== 'string'
      || !/^[a-f0-9]{64}$/u.test(v.repositoryIdentity)))
    || (v.kind === 'tag' ? v.destinationHash !== undefined : !/^[a-f0-9]{64}$/u.test(v.destinationHash ?? ''))
    || !Array.isArray(v.refs) || v.refs.length > 2048 || !v.refs.every(ref => ref && typeof ref.ref === 'string'
      && isGitReleaseRef(ref.ref) && typeof ref.object === 'string' && oid.test(ref.object)
      && (ref.peeled === undefined || typeof ref.peeled === 'string' && oid.test(ref.peeled) && ref.peeled.length === ref.object.length))
    || !Array.isArray(v.refsRequested) || v.refsRequested.length > 128 || !v.refsRequested.every(ref => typeof ref === 'string'
      && (isGitReleaseRef(ref) || ['refs/tags/*', 'refs/heads/*'].includes(ref)))) return undefined;
  return { kind: v.kind!, repositoryUri: v.repositoryUri, destinationHash: v.destinationHash, refsRequested: [...v.refsRequested],
    ...(v.repositoryIdentity ? { repositoryIdentity: v.repositoryIdentity } : {}),
    ...(v.matchesPushDestination === true ? { matchesPushDestination: true } : {}),
    refs: v.refs.map(({ ref, object, peeled }) => peeled === undefined ? { ref, object } : { ref, object, peeled }), executed: v.executed };
}

export interface GitPushAttempt {
  repositoryUri: string;
  destinationHash: string;
  refs: string[];
}

export function normalizeGitPushAttempt(value: unknown): GitPushAttempt | undefined {
  const v = value as Partial<GitPushAttempt> | undefined;
  if (!v || typeof v.repositoryUri !== 'string' || !v.repositoryUri.startsWith('file:')
    || !/^[a-f0-9]{64}$/u.test(v.destinationHash ?? '') || !Array.isArray(v.refs)
    || !v.refs.length || v.refs.length > 128 || !v.refs.every(ref => typeof ref === 'string' && isGitReleaseRef(ref))) return undefined;
  return { repositoryUri: v.repositoryUri, destinationHash: v.destinationHash!, refs: [...v.refs] };
}

export interface ReleaseVerification {
  pushAttempt?: GitPushAttempt;
  completed?: GitReleaseEvidence;
  beforeLaunch(): Promise<void>;
  verify(result: DraftRun): Promise<GitReleaseEvidence>;
}

/** Establish the task fact independently of a legacy, terminal `--verify`
 * proposal. The caller supplies the host-confirmed root-task run membership. */
export async function verifyBlockedGitTag(input: {
  run: DraftRun; prior: readonly DraftRun[]; rootTaskId: string; goal: string; signal: AbortSignal;
}): Promise<GitReleaseEvidence | undefined> {
  const { run, prior, rootTaskId, goal, signal } = input;
  const replan = run.replan;
  const diagnostic = run.capabilityDiagnostic ?? replan?.diagnostic;
  if (signal.aborted || run.status !== 'needs_replan' || run.executionStarted !== false || run.executionPhase !== 'not_dispatched'
    || run.startedAt || run.spec.restricted || run.historyInvalidationId || run.historyOriginUnverified
    || run.dependency || run.spec.prerequisites?.length || run.replacementDraftRunId
    || replan?.rootTaskId !== rootTaskId || replan.specHash !== run.specHash || replan.draftRunId !== run.id
    || replan.executionSegmentId !== run.agentRunId || replan.code !== diagnostic?.code
    || diagnostic?.code !== 'host_unsupported_option' || !diagnostic.blocking || diagnostic.started !== false
    || diagnostic.token !== '--verify') return undefined;
  const semantics = analyzeCommand(run.spec);
  const subcommand = semantics.arguments.find(arg => arg.role === 'subcommand');
  const query = semantics.gitLocalQuery;
  const revision = query?.revisions[0];
  if (subcommand?.value !== 'rev-parse' || query?.kind !== 'revision_parse' || query.revisions.length !== 1
    || diagnostic.argumentIndex !== subcommand.index + 1 || run.spec.args[subcommand.index + 1] !== '--verify'
    || !revision?.endsWith('^{commit}')) return undefined;
  const name = revision.slice(0, -'^{commit}'.length);
  if (/^(?:[a-f\d]{40}|[a-f\d]{64}|HEAD|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD)$/iu.test(name)
    || name.startsWith('refs/') && !name.startsWith('refs/tags/')) return undefined;
  const ref = name.startsWith('refs/tags/') ? name : `refs/tags/${name}`;
  const taskText = gitTaskText(goal);
  const intent = gitReleaseIntent(goal);
  if (!isGitReleaseRef(ref) || isGitInstructionQuotedOrExplanatory(taskText)
    || !taskNamesGitRef(intent, ref) && !intent.localTags.has(ref.slice('refs/tags/'.length))) return undefined;
  const taskRuns = prior.filter(candidate => candidate.id !== run.id && candidate.sessionId === run.sessionId
    && !candidate.historyInvalidationId && !candidate.historyOriginUnverified);
  const commits = taskRuns.flatMap(candidate => {
    const commit = candidate.gitCommitEvidence;
    return ['done', 'failed'].includes(candidate.status) && commit?.rootTaskId === rootTaskId
      && commit.outcome === 'verified' && oid.test(commit.head) ? [commit] : [];
  });
  if (!commits.length) return undefined;

  try {
    checkDraftRunApprovalIdentity(run);
    const scope = await inspectDraftRunScope(run, false, { ref, signal });
    const repositoryUri = scope.paths.find(target => target.role === 'repository' && !target.external)?.uri;
    const object = scope.gitTagSnapshot?.object;
    if (signal.aborted || scope.uncertain || scope.externalUris.length || !scope.verifiedLauncher || !scope.executable
      || !repositoryUri || !scope.gitRepositoryIdentity || !object || scope.gitTagSnapshot?.ref !== ref) return undefined;
    const heads = new Set(commits.filter(commit => commit.repositoryUri === repositoryUri).map(commit => commit.head));
    if (heads.size !== 1) return undefined;
    const [head] = heads;
    const verifyIndependently = /(?:独立|重新|再次|单独)(?:地)?(?:核验|验证|核对|查询|检查)|\b(?:re-?verify|independently|(?:fresh|independent) (?:check|verification))\b/iu.test(taskText);
    const recorded = taskRuns.filter(candidate => {
      const evidence = candidate.gitReleaseEvidence;
      return ['done', 'failed', 'no_changes'].includes(candidate.status) && evidence?.kind === 'tag' && evidence.repositoryUri === repositoryUri
        && evidence.refs.length === 1 && evidence.refsRequested?.length === 1 && evidence.refsRequested[0] === ref
        && evidence.refs[0].ref === ref && (evidence.refs[0].peeled ?? evidence.refs[0].object) === head;
    }).map(candidate => candidate.gitReleaseEvidence!);
    const sameObject = recorded.some(evidence => evidence.refs[0].object === object);
    if (verifyIndependently || scope.gitTagSnapshot.commit !== head || !recorded.some(evidence => evidence.refs[0].object === object
      && (!evidence.repositoryIdentity || evidence.repositoryIdentity === scope.gitRepositoryIdentity))) {
      checkDraftRunApprovalIdentity(run);
      const peeled = await peelLocalTag(object, args => readGit(scope.executable!, vscode.Uri.parse(repositoryUri).fsPath,
        { ...scope.environment, GIT_NO_LAZY_FETCH: '1' }, args, signal));
      if (peeled !== head || signal.aborted || recorded.length && !sameObject) return undefined;
      const current = await inspectDraftRunScope(run, false, { ref, signal });
      if (current.fingerprint !== scope.fingerprint || current.gitTagSnapshot?.object !== object
        || current.gitRepositoryIdentity !== scope.gitRepositoryIdentity) return undefined;
    }
    checkDraftRunApprovalIdentity(run);
    if (signal.aborted) return undefined;
    return { kind: 'tag', repositoryUri, repositoryIdentity: scope.gitRepositoryIdentity, refsRequested: [ref],
      refs: [head === object ? { ref, object } : { ref, object, peeled: head }], executed: false };
  } catch {
    return undefined;
  }
}

async function peelLocalTag(object: string, read: (args: string[]) => Promise<string>): Promise<string> {
  const peeled = (await read(['--no-replace-objects', 'rev-parse', '--verify', '--end-of-options', object + '^{commit}'])).trim();
  if (!oid.test(peeled)) throw new Error('The tag does not resolve to a commit. / 标签未解引用到提交。');
  return peeled;
}

export async function prepareGitRelease(input: {
  run: DraftRun; scope: CommandScope; intent: GitReleaseIntent; remote?: GitRemoteLaunch;
  prior: DraftRun[]; needsCommit: boolean; signal: AbortSignal; probeRemote?: boolean;
}): Promise<ReleaseVerification | undefined> {
  const { run, scope, intent, remote, prior, needsCommit, signal } = input;
  const semantics = analyzeCommand(run.spec);
  const tag = semantics.gitTagCreate;
  const command = remote?.gitRemote ?? semantics.gitRemote;
  if (!tag && !command) return undefined;
  const repositoryUri = scope.paths.find(target => target.role === 'repository' && !target.external)?.uri;
  if (!repositoryUri || !scope.executable) throw new Error('Git repository is unverified. / Git 仓库尚未核验。');
  const commit = prior.find(candidate => candidate.gitCommitEvidence?.repositoryUri === repositoryUri
    && candidate.gitCommitEvidence.outcome === 'verified')?.gitCommitEvidence;
  const commitHead = commit?.outcome === 'verified' ? commit.head : undefined;
  const localRead = (args: string[]) => readGit(scope.executable!, vscode.Uri.parse(repositoryUri).fsPath,
    { ...scope.environment, GIT_NO_LAZY_FETCH: '1' }, args, signal);
  const readRef = async (ref: string) => parseGitRefOutput(await localRead(
    ['for-each-ref', '--format=%(objectname)%09%(refname)', '--', ref]), [ref])[0];
  const localRef = async (ref: string): Promise<GitReleaseRefEvidence | undefined> => {
    const current = await readRef(ref);
    if (!current || !ref.startsWith('refs/tags/')) return current;
    const peeled = await peelLocalTag(current.object, localRead);
    if ((await readRef(ref))?.object !== current.object) {
      throw new Error('The local tag changed during verification. / 核验过程中本地标签已变化。');
    }
    return peeled === current.object ? current : { ...current, peeled };
  };
  const assertCommit = () => {
    if (needsCommit && !commitHead) throw new Error('A verified commit is required before this release operation. / 发布操作需要先核验本任务提交。');
  };

  if (tag) {
    const name = tag.ref.slice('refs/tags/'.length);
    if (!intent.tag || !(intent.localTags.size ? intent.localTags.has(name) : taskNamesGitRef(intent, tag.ref))) {
      throw new Error('The current task does not authorize this exact tag. / 当前任务未授权创建此确切标签。');
    }
    assertCommit();
    const target = (await localRead(['rev-parse', '--verify', 'HEAD^{commit}'])).trim();
    if (!oid.test(target) || (commitHead && commitHead !== target)
      || (tag.target && tag.target !== 'HEAD' && tag.target !== target)) {
      throw new Error('The tag target differs from the verified commit. / 标签目标与已核验提交不一致。');
    }
    const verifyTag = async (executed: boolean) => {
      const current = await localRef(tag.ref);
      if (!current) return undefined;
      if ((current.peeled ?? current.object) !== target) {
        throw new Error('The local tag already points to a different commit. / 本地标签已指向另一个提交。');
      }
      return { kind: 'tag' as const, repositoryUri, repositoryIdentity: scope.gitRepositoryIdentity,
        refsRequested: [tag.ref], refs: [current], executed };
    };
    const completed = await verifyTag(false);
    if (!completed && prior.some(candidate => candidate.startedAt && analyzeCommand(candidate.spec).gitTagCreate?.ref === tag.ref)) {
      throw new Error('A previous tag execution has an unresolved result. / 先前标签命令的结果尚未核实。');
    }
    return { completed, beforeLaunch: async () => {
      if (await readRef(tag.ref) || (await localRead(['rev-parse', '--verify', 'HEAD^{commit}'])).trim() !== target) {
        throw new Error('The local tag or its target changed before launch. / 启动前本地标签或目标已变化。');
      }
    }, verify: async result => {
      const evidence = await verifyTag(Boolean(result.startedAt));
      if (!evidence) throw new Error('The local tag was not found during verification. / 核验时未找到本地标签。');
      return evidence;
    } };
  }
  if (!command || !remote) return undefined;
  const destinationHash = remote.destinationHash;
  if (command.kind === 'query') {
    const requested = command.refs.length ? command.refs : ['refs/' + command.namespace + '/*'];
    return { beforeLaunch: async () => {}, verify: async result => {
      if (result.outputTruncated) throw new Error('The remote query output was truncated. / 远端查询输出已截断。');
      return { kind: 'query', repositoryUri, destinationHash, refsRequested: requested,
        refs: parseGitRefOutput(result.outputHead + result.outputTail, requested), executed: true,
        ...(scope.gitRemote?.matchesPushDestination === true ? { matchesPushDestination: true } : {}) };
    } };
  }

  assertCommit();
  if (intent.currentBranch && commit?.branchRef && commit.branchRef !== scope.gitBranchRef) {
    throw new Error('The checked-out branch changed after the task commit. / 本任务提交后，当前分支已发生变化。');
  }
  const expected = await Promise.all(command.refs.map(async ref => {
    const current = await localRef(ref);
    const isTaskTag = ref.startsWith('refs/tags/') && intent.tag
      && (intent.localTags.size ? intent.localTags.has(ref.slice('refs/tags/'.length)) : taskNamesGitRef(intent, ref));
    if (!current || !remote.sourceRefs.some(source => source.ref === ref && source.object === current.object)
      || (commitHead && (isTaskTag || ref === commit?.branchRef) && (current.peeled ?? current.object) !== commitHead)
      || (isTaskTag && !prior.some(candidate => candidate.gitReleaseEvidence?.kind === 'tag'
        && candidate.gitReleaseEvidence.repositoryUri === repositoryUri
        && (!candidate.gitReleaseEvidence.repositoryIdentity || candidate.gitReleaseEvidence.repositoryIdentity === scope.gitRepositoryIdentity)
        && sameRefs(candidate.gitReleaseEvidence.refs, [current])))) {
      throw new Error('A requested local ref is missing or differs from the verified release object. / 待推送本地引用缺失或与已核验发布对象不一致。');
    }
    return current;
  }));
  const beforeLaunch = async () => {
    const current = await Promise.all(command.refs.map(localRef));
    if (!sameRefs(current.filter(ref => ref !== undefined), expected)) {
      throw new Error('Local refs changed before push. / 推送前本地引用已变化。');
    }
  };
  // The proposed destination is known before consent. Verify local refs at
  // that stage, and leave destination probes to the authorized preparation.
  if (input.probeRemote === false) {
    return { beforeLaunch, verify: async () => {
      throw new Error('Remote verification requires an authorized destination. / 远端核验需要已授权的目的地。');
    } };
  }
  const readRemote = async () => {
    const args = ['ls-remote', '--', remote.destination, ...command.refs.flatMap(ref => ref.startsWith('refs/tags/') ? [ref, ref + '^{}'] : [ref])];
    const transport = await prepareGitTransportEnvironment({ env: remote.env, args,
      gitRemote: { kind: 'query', remote: command.remote, refs: command.refs } });
    try {
      return parseGitRefOutput(await readGit(remote.executable, transport.cwd, transport.env, args, signal), command.refs);
    } finally {
      await transport.dispose();
    }
  };
  const initial = await readRemote();
  const evidence = (executed: boolean): GitReleaseEvidence =>
    ({ kind: 'push', repositoryUri, destinationHash, refsRequested: command.refs, refs: expected, executed });
  const completed = sameRefs(initial, expected) ? evidence(false) : undefined;
  if (!completed && command.lease && initial.find(ref => ref.ref === command.lease?.ref)?.object !== command.lease.expected) {
    throw new Error('The remote ref differs from the requested lease. / 远端引用与请求的预期提交不一致。');
  }
  if (!completed && initial.some(remoteRef => remoteRef.ref.startsWith('refs/tags/')
    && !expected.some(local => local.ref === remoteRef.ref && local.object === remoteRef.object))) {
    throw new Error('The remote tag already points to a different object. / 远端标签已指向另一个对象。');
  }
  if (!completed && prior.some(candidate => {
    if (!candidate.startedAt) return false;
    const attempt = candidate.gitPushAttempt;
    if (attempt) return attempt.repositoryUri === repositoryUri && attempt.destinationHash === destinationHash
      && attempt.refs.some(ref => command.refs.includes(ref));
    const previous = analyzeCommand(candidate.spec).gitRemote;
    return candidate.spec.cwdUri === run.spec.cwdUri && previous?.kind === 'push'
      && (previous.currentBranch || previous.shortRef || previous.refs.some(ref => command.refs.includes(ref)));
  })) {
    throw new Error('A prior push has an unresolved result for this reference. / 该引用的先前推送结果尚未核实。');
  }
  return { completed, pushAttempt: { repositoryUri, destinationHash, refs: command.refs }, beforeLaunch, verify: async result => {
    const actual = await readRemote();
    if (!sameRefs(actual, expected)) {
      throw new Error(result.exitCode === 0
        ? 'Push exited successfully, but the exact remote refs did not verify. / 推送成功退出，但未能核实远端引用。'
        : result.error ?? 'Push failed and the expected objects are absent from the remote refs. / 推送失败，远端引用与预期对象不一致。');
    }
    return evidence(Boolean(result.startedAt));
  } };
}

function sameRefs(actual: GitReleaseRefEvidence[], expected: GitReleaseRefEvidence[]): boolean {
  return actual.length === expected.length && expected.every(ref => actual.some(other =>
    other.ref === ref.ref && other.object === ref.object && other.peeled === ref.peeled));
}

export function parseGitRefOutput(output: string, requested: readonly string[]): GitReleaseRefEvidence[] {
  const refs = new Map<string, GitReleaseRefEvidence>();
  const peeled = new Map<string, string>();
  for (const line of output.split(/\r?\n/u)) {
    if (!line) continue;
    const [object, name, extra] = line.split('\t');
    if (extra !== undefined || !oid.test(object) || !name) throw new Error('Invalid Git ref response. / Git 引用查询响应无效。');
    const isPeeled = name.endsWith('^{}');
    const ref = isPeeled ? name.slice(0, -3) : name;
    if (!requested.some(value => value === ref || (value.endsWith('/*') && ref.startsWith(value.slice(0, -1))))) continue;
    if (!isGitReleaseRef(ref) || findSensitiveEvidence(ref) || (isPeeled ? peeled.has(ref) : refs.has(ref)) || refs.size >= 2048) {
      throw new Error('The Git ref response exceeded its verified scope. / Git 引用查询结果超出可核验范围。');
    }
    if (isPeeled) peeled.set(ref, object);
    else refs.set(ref, { ref, object });
  }
  for (const [ref, object] of peeled) {
    const base = refs.get(ref);
    if (!base) throw new Error('Git returned a peeled ref without a tag object. / Git 返回了缺少标签对象的解引用。');
    base.peeled = object;
  }
  return [...refs.values()];
}

async function readGit(executable: string, cwd: string, env: NodeJS.ProcessEnv, args: string[], signal: AbortSignal): Promise<string> {
  try {
    const { stdout } = await git(executable, ['--no-pager', '--no-optional-locks', ...args],
      { cwd, env, signal, timeout: 10_000, maxBuffer: 512 * 1024, windowsHide: true });
    return stdout;
  } catch (error) {
    if (signal.aborted) throw new Error('Git verification was cancelled. / Git 核验已取消。');
    const failure = error as { stderr?: string; code?: string; killed?: boolean };
    throw new Error(gitTransportError(failure.stderr ?? '', 'query', Boolean(failure.killed || failure.code === 'ENOENT')));
  }
}

export function gitTransportError(stderr: string, kind: 'query' | 'push', unavailable = false): string {
  if (/permission denied \(|authentication failed|could not read username/iu.test(stderr)) {
    return 'Git transport authentication failed. / Git 传输认证失败。';
  }
  if (unavailable || /could not resolve|connection|host key verification failed/iu.test(stderr)) {
    return 'Git transport or launcher is unavailable. / Git 传输或启动程序不可用。';
  }
  if (/non-fast-forward|fetch first|already exists|stale info|cannot lock ref/iu.test(stderr)) {
    return 'The remote rejected a conflicting ref update. / 远端拒绝了存在冲突的引用更新。';
  }
  return kind === 'push' ? 'Git push failed. / Git 推送失败。' : 'Git verification query failed. / Git 核验查询失败。';
}
