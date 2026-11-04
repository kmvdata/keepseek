export type ApprovalTargetStatus = 'pending' | 'executed' | 'denied' | 'manual_required' | 'review_unavailable' | 'hard_blocked' | 'needs_authorization' | 'failed' | 'cancelled' | 'already_processed' | 'identity_mismatch' | 'missing' | 'needs_replan' | 'dependency_blocked';

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
  version: 1;
  runId: string;
  rootTaskId: string;
  mode: 'delegate' | 'model_review';
  status: 'processing' | 'completed' | 'blocked' | 'replanning';
  targets: Array<{ id: string; kind: 'edit' | 'command'; status: ApprovalTargetStatus; reason?: string;
    dependency?: ApprovalDependency; replan?: DraftRunReplanResult }>;
  reason?: string;
  canResume?: boolean;
  /** Persist the bounded correction history across execution segments. */
  replanKeys?: string[];
  localGitCompletionRetried?: boolean;
  updatedAt: string;
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
  if (v?.version !== 1 || typeof v.runId !== 'string' || typeof v.rootTaskId !== 'string'
    || !['delegate', 'model_review'].includes(v.mode) || !Array.isArray(v.targets)
    || !['processing', 'completed', 'blocked', 'replanning'].includes(v.status)) return undefined;
  const interrupted = v.status === 'processing' || v.status === 'replanning';
  const targets = v.targets.filter(t => t && typeof t.id === 'string' && ['edit', 'command'].includes(t.kind)
    && ['pending', 'executed', 'denied', 'manual_required', 'review_unavailable', 'hard_blocked', 'needs_authorization', 'failed', 'cancelled', 'already_processed', 'identity_mismatch', 'missing', 'needs_replan', 'dependency_blocked'].includes(t.status))
    .map(t => {
      const replan = normalizeDraftRunReplan(t.replan, t.id, v.runId);
      return { id: t.id, kind: t.kind, status: t.status === 'pending' ? 'cancelled' as const : t.status,
        reason: approvalReason(t.reason), dependency: normalizeApprovalDependency(t.dependency),
        replan: replan?.rootTaskId === v.rootTaskId ? replan : undefined };
    });
  return { version: 1, runId: v.runId, rootTaskId: v.rootTaskId, mode: v.mode,
    status: interrupted ? 'blocked' : v.status, targets,
    canResume: interrupted || v.canResume === true || undefined,
    localGitCompletionRetried: v.localGitCompletionRetried === true || undefined,
    replanKeys: Array.isArray(v.replanKeys) ? v.replanKeys.filter(key => typeof key === 'string' && /^[a-f0-9]{64}$/u.test(key)).slice(0, 2) : undefined,
    reason: interrupted ? 'Interrupted; explicitly resume processing. / 处理已中断，请明确恢复。' : approvalReason(v.reason),
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '' };
}
