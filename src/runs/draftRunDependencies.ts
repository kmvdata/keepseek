import type { DraftRun } from '../shared/types';
import type { ApprovalDependency } from '../approvals/approvalProcessing';
import { analyzeCommand } from '../approvals/authorization/commandSemantics';
import { hasExactCommandScope, inspectDraftRunScope } from '../approvals/authorization/commandScope';
import { isPathInside } from '../approvals/authorization/pathScope';
import * as vscode from 'vscode';

export interface DraftRunDependencyDecision {
  allowed: boolean;
  code?: 'dependency_missing' | 'dependency_identity' | 'dependency_cycle' | 'dependency_unsettled' | 'dependency_condition' | 'dependency_stale';
  reason?: string;
  dependency?: ApprovalDependency;
}

/** Dependencies are immutable spec/hash inputs. They convey requirements, never authority.
 * Callers may supply the host's complete root-task membership to reuse earlier segments.
 * Without that membership only the current segment is eligible. Replacements require a
 * fresh proposal referencing the new hash; following a replacement link is forbidden. */
export function inspectDraftRunDependencies(run: DraftRun, get: (id: string) => DraftRun | undefined,
  allowedRunIds?: ReadonlySet<string>): DraftRunDependencyDecision {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  let examined = 0;
  const reject = (code: NonNullable<DraftRunDependencyDecision['code']>, targetId: string, reason: string): DraftRunDependencyDecision => ({
    allowed: false, code, reason, dependency: { targetId, label: targetId, reason }
  });
  if (allowedRunIds && !allowedRunIds.has(run.id)) return reject('dependency_identity', run.id,
    'The command is outside the current root task. / 命令不属于当前根任务。');
  const visit = (current: DraftRun): DraftRunDependencyDecision => {
    if (visiting.has(current.id) || ++examined > 128) return reject('dependency_cycle', current.id,
      'Command dependencies contain a cycle or exceed the finite plan limit. / 命令依赖包含循环或超出有限计划上限。');
    if (visited.has(current.id)) return { allowed: true };
    visiting.add(current.id);
    for (const reference of current.spec.prerequisites ?? []) {
      const prior = get(reference.draftRunId);
      if (!prior) return reject('dependency_missing', reference.draftRunId,
        'A required command record is missing. / 所需命令记录不存在。');
      if (prior.sessionId !== run.sessionId || prior.specHash !== reference.specHash
        || prior.historyInvalidationId || prior.historyOriginUnverified || prior.replacementDraftRunId
        || (allowedRunIds ? !allowedRunIds.has(prior.id) : prior.agentRunId !== run.agentRunId)) {
        return reject('dependency_identity', prior.id,
          'A dependency belongs to another task, changed, expired or was replaced. Prepare a new bound proposal. / 依赖属于其他任务、已变化、失效或被替代，请重新绑定并提案。');
      }
      const nested = visit(prior);
      if (!nested.allowed) return nested;
      if (prior.status !== 'done') return reject('dependency_unsettled', prior.id,
        'The required command has not completed successfully. / 所需命令尚未成功完成。');
      if (prior.gitQueryResult?.errorCode || prior.gitQueryResult?.kind === 'ancestor' && prior.gitQueryResult.predicate === false
        || reference.condition === 'predicate_true' && prior.gitQueryResult?.predicate !== true) {
        return reject('dependency_condition', prior.id,
          'The required fact is false or has not been verified. / 所需事实不成立或尚未核实。');
      }
    }
    visiting.delete(current.id);
    visited.add(current.id);
    return { allowed: true };
  };
  return visit(run);
}

/** Revalidate fact-producing query identities without re-running their user
 * commands. The existing scope fingerprint covers Git HEAD/ref identity,
 * repository metadata/configuration, executable, environment and paths. Legacy
 * query facts with no snapshot cannot authorize dependent execution. */
export async function inspectDraftRunDependencyFacts(run: DraftRun, get: (id: string) => DraftRun | undefined,
  allowedRunIds?: ReadonlySet<string>): Promise<DraftRunDependencyDecision> {
  const decision = inspectDraftRunDependencies(run, get, allowedRunIds);
  if (!decision.allowed) return decision;
  const visited = new Set<string>();
  const verify = async (current: DraftRun): Promise<DraftRunDependencyDecision> => {
    if (visited.has(current.id)) return { allowed: true };
    visited.add(current.id);
    for (const reference of current.spec.prerequisites ?? []) {
      const prior = get(reference.draftRunId);
      if (!prior) return inspectDraftRunDependencies(run, get, allowedRunIds);
      const nested = await verify(prior);
      if (!nested.allowed) return nested;
      if (!prior.gitQueryResult) continue;
      const reject = (): DraftRunDependencyDecision => {
        const reason = 'The required Git fact is stale or lacks a verified snapshot. Prepare a fresh query. / 所需 Git 事实已失效或缺少核实快照，请重新查询。';
        return { allowed: false, code: 'dependency_stale', reason,
          dependency: { targetId: prior.id, label: prior.id, reason } };
      };
      if (!prior.gitQueryResult.scopeFingerprint) return reject();
      try {
        const scope = await inspectDraftRunScope(prior);
        if (scope.uncertain || scope.fingerprint !== prior.gitQueryResult.scopeFingerprint) return reject();
      } catch { return reject(); }
    }
    return { allowed: true };
  };
  const facts = await verify(run);
  return facts.allowed ? inspectDraftRunDependencies(run, get, allowedRunIds) : facts;
}

/** A checked-false ancestor must not become permission for a later history write
 * merely because a proposal omits its explicit evidence gate. The caller passes
 * host-confirmed root-task members. Compare real repository identity rather than
 * cwd text, including -C/subdirectories; pure verified observations stay independent. */
export async function inspectGitAncestorPrerequisite(run: DraftRun, prior: readonly DraftRun[],
  authorizedUris: ReadonlySet<string> = new Set()): Promise<DraftRunDependencyDecision> {
  const candidates = prior.filter(item => item.id !== run.id && item.sessionId === run.sessionId
    && !item.historyInvalidationId && !item.historyOriginUnverified && item.status === 'done'
    && item.gitQueryResult?.kind === 'ancestor').slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt)).reverse();
  if (!candidates.length || await isIndependentDraftRunCheck(run, authorizedUris)) return { allowed: true };
  const actionScope = await inspectDraftRunScope(run).catch(() => undefined);
  const actionRepository = actionScope?.paths.find(item => item.role === 'repository')?.uri;
  for (const fact of candidates) {
    const scope = await inspectDraftRunScope(fact).catch(() => undefined);
    const repository = scope?.paths.find(item => item.role === 'repository')?.uri;
    if (actionRepository && repository && actionRepository !== repository) continue;
    const sameRepository = repository && (actionRepository ? actionRepository === repository
      : actionScope?.paths.some(item => ['cwd', 'write_path'].includes(item.role)
        && isPathInside(vscode.Uri.parse(repository).fsPath, vscode.Uri.parse(item.uri).fsPath)));
    if (!sameRepository && fact.spec.cwdUri !== run.spec.cwdUri) continue;
    const stale = !scope || scope.uncertain || !fact.gitQueryResult?.scopeFingerprint
      || fact.gitQueryResult.scopeFingerprint !== scope.fingerprint;
    if (fact.gitQueryResult?.predicate !== false && !stale) return { allowed: true };
    const reason = fact.gitQueryResult?.predicate === false
      ? 'The ancestor condition is false; dependent writes must wait for a verified plan. / 祖先条件不成立，后续写操作须等待核实后的计划。'
      : 'The ancestor fact changed or lacks a verified snapshot. Prepare a fresh query before writing. / 祖先事实已变化或缺少核实快照，写入前请重新查询。';
    return { allowed: false, code: stale && fact.gitQueryResult?.predicate !== false ? 'dependency_stale' : 'dependency_condition',
      reason, dependency: { targetId: fact.id, label: fact.spec.executable, reason } };
  }
  return { allowed: true };
}

/** Stable topological ordering changes only the order demanded by bound references.
 * Invalid/cyclic edges are left for the diagnostic validator, not silently removed. */
export function orderDraftRunDependencies(ids: readonly string[], get: (id: string) => DraftRun | undefined): string[] {
  const members = new Set(ids);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const result: string[] = [];
  let cycle = false;
  const append = (id: string) => {
    if (visiting.has(id)) { cycle = true; return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const reference of get(id)?.spec.prerequisites ?? []) {
      if (members.has(reference.draftRunId)) append(reference.draftRunId);
    }
    visiting.delete(id);
    visited.add(id);
    result.push(id);
  };
  for (const id of ids) append(id);
  return cycle ? [...ids] : result;
}

/** A command's name or model-provided "independent" label is insufficient. The
 * complete supported argv and live launcher/repository/path checks must agree.
 * This never creates a permit or bypasses normal approval and dispatch checks. */
export async function isIndependentDraftRunCheck(run: DraftRun, authorizedUris: ReadonlySet<string>): Promise<boolean> {
  if (run.dependency || run.spec.restricted || run.historyInvalidationId || run.historyOriginUnverified) return false;
  const parsed = analyzeCommand(run.spec);
  if (!parsed.effects.length || parsed.effects.some(effect => effect !== 'workspace_read')
    || parsed.reasons.some(reason => reason.code !== 'git_runtime')) return false;
  try {
    const scope = await inspectDraftRunScope(run);
    return Boolean(!scope.uncertain && scope.boundLauncher && scope.verifiedLauncher
      && hasExactCommandScope(scope, run.spec.cwdUri, authorizedUris));
  } catch { return false; }
}

/** Unknown or mutating predecessors may have changed every subsequent observation.
 * Separately verified readonly failures and explicit host no-start facts can be
 * isolated. Explicit prerequisite conditions remain checked independently. */
export async function canIsolateDraftRunFailure(run: DraftRun, prior: DraftRun[], authorizedUris: ReadonlySet<string>): Promise<boolean> {
  if (!await isIndependentDraftRunCheck(run, authorizedUris)) return false;
  for (const predecessor of prior) {
    // This is a host execution fact, not a claim that the rejected command was
    // safe. The next operation remains a separately checked readonly query.
    if (predecessor.executionStarted === false
      && (predecessor.executionPhase === 'not_dispatched' || predecessor.executionPhase === 'spawn_failed')) continue;
    if (!await isIndependentDraftRunCheck(predecessor, authorizedUris)) return false;
  }
  return true;
}
