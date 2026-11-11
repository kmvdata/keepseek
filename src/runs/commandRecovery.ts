import { createHash } from 'node:crypto';
import type { DraftRun } from '../shared/types';
import type { DraftRunReplanResult } from '../approvals/approvalProcessing';
import { analyzeCommandCapability } from '../approvals/authorization/commandCapability';

// A storage sanity bound, not a retry quota. Never truncate the root-cause
// ledger: forgetting an earlier key could grant another correction attempt.
export const MAX_COMMAND_RECOVERY_KEYS = 4_096;

export function isCommandRecoveryKeyList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= MAX_COMMAND_RECOVERY_KEYS
    && value.every(key => typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key));
}

/** Static diagnostics are observations, not permission. Only a current never-dispatched
 * proposal is eligible; restored records without this evidence cannot restart work. */
export function commandCapabilityReplan(run: DraftRun, rootTaskId: string): DraftRunReplanResult | undefined {
  if (run.replacementDraftRunId || run.historyInvalidationId || run.historyOriginUnverified || run.startedAt || run.executionStarted === true
    || !['pending', 'needs_replan'].includes(run.status)
    || run.executionStarted !== false || run.executionPhase !== 'not_dispatched') return undefined;
  const capability = analyzeCommandCapability(run.spec);
  const diagnostic = capability.diagnostics.find(item => item.blocking);
  if (!diagnostic) return undefined;
  return { draftRunId: run.id, specHash: run.specHash, rootTaskId, executionSegmentId: run.agentRunId,
    phase: 'capability', code: capability.semantics.gitTagQueryNeedsSort ? 'git_tag_sort_missing'
      : capability.semantics.gitReplan?.code ?? diagnostic.code,
    reason: capability.semantics.gitTagQueryNeedsSort
      ? 'Git tag --sort needs a value. Use a supported version sort. / Git tag --sort 缺少参数，请指定受支持的版本排序。'
      : capability.semantics.gitReplan?.message ?? diagnostic.reason, executed: false,
    candidateArgs: diagnostic.candidateArgs, diagnostic };
}

/** Intentionally excludes proposal IDs, reason text, argv spellings and candidate
 * suggestions: cosmetic changes cannot buy another attempt at the same root cause. */
export function commandRecoveryKey(run: DraftRun | undefined, result: Pick<DraftRunReplanResult, 'rootTaskId' | 'phase' | 'code'>): string {
  const parsed = run && analyzeCommandCapability(run.spec).semantics;
  return createHash('sha256').update(JSON.stringify([
    result.rootTaskId, run?.spec.cwdUri, run?.spec.executable, parsed?.program,
    parsed?.arguments.find(arg => arg.role === 'subcommand')?.value,
    result.phase, result.code, run?.spec.env
  ])).digest('hex');
}
