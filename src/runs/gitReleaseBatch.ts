import { analyzeCommand } from '../approvals/authorization/commandSemantics';
import { gitReleaseIntent, taskNamesGitRef, type GitReleaseIntent } from './gitTaskIntent';
import { isExplicitLocalCommitGoal } from './localGitCommit';
import type { GitReleaseEvidence } from './gitReleaseEvidence';
import type { DraftRun } from '../shared/types';

export function gitBatchKind(run: DraftRun | undefined) {
  if (!run) return undefined;
  const semantics = analyzeCommand(run.spec);
  if (semantics.program !== 'git') return undefined;
  if (semantics.gitRemote) return semantics.gitRemote.kind === 'query' ? 'remote_read' : 'push';
  if (semantics.gitTagQuery || semantics.gitTagQueryNeedsSort
    || semantics.gitLocalQuery && semantics.gitLocalQuery.kind !== 'log') return 'read';
  if (semantics.gitStage) return 'stage';
  if (semantics.gitCommit || semantics.gitReplan && semantics.gitReplan.code !== 'git_status_pager_override') return 'commit';
  if (semantics.gitTagCreate) return 'tag';
  const command = semantics.arguments.find(arg => arg.role === 'subcommand')?.value;
  if (semantics.effects.some(effect => ['workspace_write', 'git_mutation', 'arbitrary_code'].includes(effect))) return undefined;
  if (command === 'diff' && run.spec.args.some(arg => ['--staged', '--cached'].includes(arg))) return 'index';
  if (command === 'ls-remote') return 'remote_read';
  if (command && ['status', 'log', 'show', 'diff'].includes(command)) return 'read';
  return undefined;
}

export function gitReleasePrerequisite<T extends { id: string; kind: string }>(kind: ReturnType<typeof gitBatchKind>,
  blockers: T[], get: (id: string) => DraftRun | undefined): T | undefined {
  if (kind === 'read' || kind === 'remote_read') return undefined;
  return blockers.find(blocker => {
    if (blocker.kind !== 'command' || !kind) return true;
    const prior = gitBatchKind(get(blocker.id));
    // Stage/index/commit/tag/push check their own repository state. An
    // observational query failure provides no dependency on its own.
    if (prior === 'read' || prior === 'remote_read' || prior === 'index') return false;
    // A stage has no dependency on an earlier Git publication operation.
    if (kind === 'stage' && (prior === 'tag' || prior === 'push')) return false;
    return true;
  });
}

export function orderGitReleaseBatch(ids: readonly string[], get: (id: string) => DraftRun | undefined): string[] {
  const rank = { read: 0, remote_read: 0, stage: 1, index: 2, commit: 3, tag: 4, push: 5 };
  const result: string[] = [];
  let group: Array<{ id: string; rank: number }> = [];
  const appendGroup = () => {
    result.push(...group.sort((a, b) => a.rank - b.rank).map(item => item.id));
    group = [];
  };
  for (const id of ids) {
    const kind = gitBatchKind(get(id));
    if (kind) group.push({ id, rank: rank[kind] });
    else { appendGroup(); result.push(id); }
  }
  appendGroup();
  return result;
}

export function missingGitTaskOutcome(goal: string, getRuns: () => DraftRun[], rootTaskId: string,
  verifiedThisBatch: readonly GitReleaseEvidence[] = [], intent = gitReleaseIntent(goal)): 'commit' | 'tag' | 'push' | undefined {
  const needsCommit = isExplicitLocalCommitGoal(goal);
  if (!needsCommit && !intent.tag && !intent.push) return undefined;
  const runs = getRuns();
  const commits = runs.flatMap(run => run.gitCommitEvidence?.rootTaskId === rootTaskId ? [run.gitCommitEvidence] : []);
  const commit = commits.filter(item => item.outcome === 'verified').at(-1) ?? commits.at(-1);
  if (needsCommit && !commit) return 'commit';
  const repository = commit?.repositoryUri;
  const evidence = [...verifiedThisBatch, ...runs.flatMap(run => run.gitReleaseEvidence ? [run.gitReleaseEvidence] : [])]
    .filter(item => !repository || item.repositoryUri === repository);
  if (intent.tag) {
    const tags = (verifiedThisBatch.length ? verifiedThisBatch : evidence).flatMap(item => item.kind === 'tag'
      && (!repository || item.repositoryUri === repository) ? item.refs : [])
      .filter(ref => commit?.outcome !== 'verified' || (ref.peeled ?? ref.object) === commit.head);
    if (intent.localTags.size ? [...intent.localTags].some(name => !tags.some(ref => ref.ref === `refs/tags/${name}`))
      : !tags.some(ref => taskNamesGitRef(intent, ref.ref))) return 'tag';
  }
  if (intent.push) {
    const pushed = evidence.filter(item => item.kind === 'push').flatMap(item => item.refs);
    const exact = intent.pushTargets;
    if (!pushed.length) return 'push';
    if (exact) {
      const refs = new Set(pushed.map(ref => ref.ref));
      if ([...exact.tags].some(name => !refs.has('refs/tags/' + name))
        || [...exact.branches].some(name => !refs.has('refs/heads/' + name))
        || [...exact.shortRefs].some(name => !refs.has('refs/heads/' + name) && !refs.has('refs/tags/' + name))
        || exact.currentBranch && (commit?.branchRef ? !refs.has(commit.branchRef)
          : !pushed.some(ref => ref.ref.startsWith('refs/heads/')))) return 'push';
    } else if (intent.tags.size && !pushed.some(ref => taskNamesGitRef(intent, ref.ref))
      || intent.branch && !pushed.some(ref => ref.ref.startsWith('refs/heads/'))) return 'push';
  }
  return undefined;
}

export function checkGitRemotePrerequisite(intent: GitReleaseIntent, prior: DraftRun[], repositoryUri: string | undefined): void {
  const condition = intent.remoteCondition;
  if (!condition) return;
  const queries = prior.flatMap(run => run.gitReleaseEvidence?.kind === 'query' && run.gitReleaseEvidence.repositoryUri === repositoryUri
    && (!intent.push || run.gitReleaseEvidence.matchesPushDestination)
    ? [run.gitReleaseEvidence] : []);
  if (condition === 'reachable' && queries.length) return;
  if (condition === 'tag_absent' && intent.tags.size && queries.some(query =>
    [...intent.tags].every(tag => query.refsRequested?.some(ref => ref === 'refs/tags/*' || ref === 'refs/tags/' + tag))
    && !query.refs.some(ref => taskNamesGitRef(intent, ref.ref)))) return;
  throw new Error('The remote prerequisite for local Git writes has not been verified. / 本地 Git 写入所需的远端前置条件尚未核实。');
}
