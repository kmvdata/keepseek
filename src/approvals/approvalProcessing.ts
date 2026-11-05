export type ApprovalTargetStatus = 'pending' | 'executed' | 'denied' | 'manual_required' | 'review_unavailable' | 'hard_blocked' | 'needs_authorization' | 'failed' | 'cancelled' | 'already_processed' | 'identity_mismatch' | 'missing' | 'needs_replan' | 'dependency_blocked' | 'external_authorization_required' | 'insufficient_launch_evidence';

export interface ApprovalDependency {
  targetId: string;
  label: string;
  reason?: string;
}

export interface DraftRunReplanResult {
  draftRunId: string;
  specHash: string;
  rootTaskId: string;
  executionSegmentId: string;
  phase: 'preflight';
  code: string;
  reason: string;
  executed: false;
  candidateArgs?: string[];
  dependsOn?: string;
}

export interface ApprovalProcessingState {
  version: 1 | 2;
  runId: string;
  rootTaskId: string;
  mode: 'delegate' | 'model_review';
  status: 'processing' | 'completed' | 'blocked' | 'waiting_user' | 'replanning' | 'stopped';
  targets: Array<{ id: string; kind: 'edit' | 'command'; status: ApprovalTargetStatus; reason?: string; failureCode?: string;
    dependency?: ApprovalDependency; replan?: DraftRunReplanResult }>;
  reason?: string;
  canResume?: boolean;
  /** Persist the bounded correction history across execution segments. */
  replanKeys?: string[];
  localGitCompletionRetried?: boolean;
  updatedAt: string;
}

interface ApprovalBatchTargets {
  runId: string;
  editIds: readonly string[];
  draftRunIds: readonly string[];
  localGitCompletionCheck?: boolean;
}

/** A settled batch is idempotent even if its drafts are delivered again. */
export function isCompletedApprovalBatch(prior: ApprovalProcessingState | undefined, batch: ApprovalBatchTargets): boolean {
  return prior?.runId === batch.runId && ['completed', 'stopped'].includes(prior.status)
    && prior.targets.length === batch.editIds.length + batch.draftRunIds.length
    && prior.targets.every(target => [...batch.editIds, ...batch.draftRunIds].includes(target.id));
}

/** Start a current delegate batch while retaining only its task-scoped history and hard decisions. */
export function createApprovalProcessing(batch: ApprovalBatchTargets, rootTaskId: string,
  prior?: ApprovalProcessingState, updatedAt = new Date().toISOString()): ApprovalProcessingState {
  const processing: ApprovalProcessingState = {
    version: 2, runId: batch.runId, rootTaskId, mode: 'delegate', status: 'processing', updatedAt,
    replanKeys: prior?.rootTaskId === rootTaskId ? [...(prior.replanKeys ?? [])] : [],
    localGitCompletionRetried: batch.localGitCompletionCheck || (prior?.rootTaskId === rootTaskId && prior.localGitCompletionRetried) || undefined,
    targets: [...batch.editIds.map(id => ({ id, kind: 'edit' as const, status: 'pending' as const })),
      ...batch.draftRunIds.map(id => ({ id, kind: 'command' as const, status: 'pending' as const }))]
  };
  if (prior?.runId === batch.runId) {
    for (const target of processing.targets) {
      const previous = prior.targets.find(item => item.id === target.id);
      if (previous && ['denied', 'hard_blocked'].includes(previous.status)) Object.assign(target, previous);
    }
  }
  return processing;
}

export function normalizeApprovalDependency(value: unknown): ApprovalDependency | undefined {
  const v = value as ApprovalDependency | undefined;
  if (!v || typeof v.targetId !== 'string' || typeof v.label !== 'string') return undefined;
  return { targetId: v.targetId, label: v.label.slice(0, 300), reason: approvalReason(v.reason) };
}

export function normalizeDraftRunReplan(value: unknown, id: string, segmentId: string, specHash?: string): DraftRunReplanResult | undefined {
  const v = value as DraftRunReplanResult | undefined;
  if (!v || v.draftRunId !== id || v.executionSegmentId !== segmentId
    || typeof v.specHash !== 'string' || (specHash !== undefined && specHash !== v.specHash)
    || typeof v.rootTaskId !== 'string' || typeof v.code !== 'string' || typeof v.reason !== 'string'
    || v.phase !== 'preflight' || v.executed !== false) return undefined;
  return { draftRunId: id, executionSegmentId: segmentId, specHash: v.specHash, rootTaskId: v.rootTaskId,
    phase: 'preflight', executed: false, code: v.code.slice(0, 100), reason: v.reason.slice(0, 2000),
    candidateArgs: Array.isArray(v.candidateArgs) && v.candidateArgs.every(arg => typeof arg === 'string')
      ? v.candidateArgs.slice(0, 16).map(arg => arg.slice(0, 300)) : undefined,
    dependsOn: typeof v.dependsOn === 'string' ? v.dependsOn : undefined };
}

function approvalReason(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, 2000) : undefined;
}

export function normalizeApprovalProcessing(value: unknown): ApprovalProcessingState | undefined {
  const v = value as ApprovalProcessingState | undefined;
  if ((v?.version !== 1 && v?.version !== 2) || typeof v.runId !== 'string' || typeof v.rootTaskId !== 'string'
    || !['delegate', 'model_review'].includes(v.mode) || !Array.isArray(v.targets)
    || !['processing', 'completed', 'blocked', 'waiting_user', 'replanning', 'stopped'].includes(v.status)) return undefined;
  const interrupted = v.status === 'processing' || v.status === 'replanning' || v.status === 'waiting_user';
  const stoppedDelegate = v.version === 1 && v.mode === 'delegate' && (interrupted || v.status === 'blocked' || v.status === 'stopped'
    || v.targets.some(target => target && ['manual_required', 'needs_authorization', 'review_unavailable'].includes(target.status)));
  const targets = v.targets.filter(t => t && typeof t.id === 'string' && ['edit', 'command'].includes(t.kind)
    && ['pending', 'executed', 'denied', 'manual_required', 'review_unavailable', 'hard_blocked', 'needs_authorization', 'failed', 'cancelled', 'already_processed', 'identity_mismatch', 'missing', 'needs_replan', 'dependency_blocked', 'external_authorization_required', 'insufficient_launch_evidence'].includes(t.status))
    .map(t => {
      const replan = normalizeDraftRunReplan(t.replan, t.id, v.runId);
      const status = t.status === 'pending' ? (stoppedDelegate && interrupted ? 'failed' : 'cancelled')
        : stoppedDelegate && t.status === 'manual_required' ? 'insufficient_launch_evidence'
        : stoppedDelegate && t.status === 'needs_authorization' ? 'external_authorization_required' : t.status;
      return { id: t.id, kind: t.kind, status,
        failureCode: typeof t.failureCode === 'string' && /^[a-z_]{1,64}$/u.test(t.failureCode) ? t.failureCode : undefined,
        reason: approvalReason(t.reason), dependency: normalizeApprovalDependency(t.dependency),
        replan: replan?.rootTaskId === v.rootTaskId ? replan : undefined };
    });
  return { version: v.version, runId: v.runId, rootTaskId: v.rootTaskId, mode: v.mode,
    status: stoppedDelegate ? 'stopped' : interrupted ? 'blocked' : v.status, targets,
    canResume: v.mode === 'delegate' && v.version === 2 && (interrupted || v.canResume === true)
      && !targets.some(target => ['denied', 'hard_blocked', 'identity_mismatch', 'missing', 'failed'].includes(target.status)) || undefined,
    localGitCompletionRetried: v.localGitCompletionRetried === true || undefined,
    replanKeys: Array.isArray(v.replanKeys) ? v.replanKeys.filter(key => typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key)).slice(0, 2) : undefined,
    reason: stoppedDelegate && interrupted ? 'Approval processing was interrupted. Restored drafts were not replayed. / 审批处理已中断，未重放恢复出的草稿。'
      : interrupted ? 'Interrupted; explicitly resume processing. / 处理已中断，请明确恢复。' : approvalReason(v.reason),
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '' };
}
