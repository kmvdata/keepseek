import { normalizeCommandCapabilityDiagnostic } from './authorization/commandCapability';
import { isCommandRecoveryKeyList } from '../runs/commandRecovery';
import type { ChatSession } from '../shared/types';
import type { HistoryTruncationScope } from '../sessions/historyTruncation';

export type ApprovalTargetStatus = 'pending' | 'executed' | 'denied' | 'manual_required' | 'review_unavailable' | 'paused' | 'hard_blocked' | 'needs_authorization' | 'failed' | 'cancelled' | 'already_processed' | 'identity_mismatch' | 'missing' | 'needs_replan' | 'dependency_blocked' | 'external_authorization_required' | 'insufficient_launch_evidence';

export interface ApprovalProcessingTarget {
  id: string;
  kind: 'edit' | 'command';
  status: ApprovalTargetStatus;
  reason?: string;
  failureCode?: string;
  dependency?: ApprovalDependency;
  replan?: DraftRunReplanResult;
  canResume?: boolean;
  reviewId?: string;
}

/** Runtime authority is revoked by the host before committing this projection change.
 * Original decisions remain in the review store; these fields only project current work. */
export function invalidateApprovalStateForHistory(session: Pick<ChatSession, 'id' | 'approvalProcessing' | 'pendingApproval' | 'pendingApprovals'>,
  scope: HistoryTruncationScope, removedTargetIds: readonly string[] = []): boolean {
  if (session.id !== scope.sessionId) return false;
  let changed = false;
  if (session.approvalProcessing && scope.removedSegmentIds.includes(session.approvalProcessing.runId)) {
    session.approvalProcessing = undefined;
    changed = true;
  } else if (session.approvalProcessing?.targets.some(target => removedTargetIds.includes(target.id))) {
    session.approvalProcessing.targets = session.approvalProcessing.targets.filter(target => !removedTargetIds.includes(target.id));
    if (!session.approvalProcessing.targets.length) session.approvalProcessing = undefined;
    changed = true;
  }
  if (session.pendingApproval && (scope.removedSegmentIds.includes(session.pendingApproval.agentRunId)
    || removedTargetIds.includes(session.pendingApproval.targetId))) {
    session.pendingApproval = undefined;
    changed = true;
  }
  if (session.pendingApprovals?.some(request => scope.removedSegmentIds.includes(request.agentRunId)
    || removedTargetIds.includes(request.targetId))) {
    session.pendingApprovals = session.pendingApprovals.filter(request => !scope.removedSegmentIds.includes(request.agentRunId)
      && !removedTargetIds.includes(request.targetId));
    changed = true;
  }
  return changed;
}

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
  phase: 'capability' | 'preflight';
  diagnostic?: import('./authorization/commandCapability').CommandCapabilityDiagnostic;
  code: string;
  reason: string;
  executed: false;
  candidateArgs?: string[];
  dependsOn?: string;
}

export interface ApprovalProcessingState {
  version: 2;
  runId: string;
  backgroundRunId?: string;
  rootTaskId: string;
  mode: 'delegate';
  status: 'processing' | 'completed' | 'blocked' | 'waiting_user' | 'paused' | 'replanning' | 'stopped';
  targets: ApprovalProcessingTarget[];
  reason?: string;
  canResume?: boolean;
  /** Start of a durable idle interval excluded from the active root budget. */
  pausedAt?: string;
  /** Legacy preflight audit and separate permission or failed-read recovery guards. */
  replanKeys?: string[];
  localGitCompletionRetried?: boolean;
  updatedAt: string;
}

interface ApprovalBatchTargets {
  runId: string;
  backgroundRunId?: string;
  editIds: readonly string[];
  draftRunIds: readonly string[];
  localGitCompletionCheck?: boolean;
  resume?: boolean;
  resumeTargetId?: string;
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
    backgroundRunId: batch.backgroundRunId,
    replanKeys: prior?.rootTaskId === rootTaskId ? [...(prior.replanKeys ?? [])] : [],
    localGitCompletionRetried: batch.localGitCompletionCheck || (prior?.rootTaskId === rootTaskId && prior.localGitCompletionRetried) || undefined,
    targets: [...batch.editIds.map(id => ({ id, kind: 'edit' as const, status: 'pending' as const })),
      ...batch.draftRunIds.map(id => ({ id, kind: 'command' as const, status: 'pending' as const }))]
  };
  if (prior?.runId === batch.runId) {
    for (const target of processing.targets) {
      const previous = prior.targets.find(item => item.id === target.id);
      if (!previous) continue;
      if (['denied', 'hard_blocked'].includes(previous.status) || batch.resume && (
        ['executed', 'already_processed', 'failed', 'cancelled', 'missing', 'identity_mismatch'].includes(previous.status)
        || batch.resumeTargetId !== undefined && batch.resumeTargetId !== target.id && previous.status !== 'dependency_blocked')) {
        Object.assign(target, previous);
      } else if (batch.resume && previous.status === 'dependency_blocked') {
        target.dependency = previous.dependency;
        target.reason = previous.reason;
      }
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
    || !['capability', 'preflight'].includes(v.phase) || v.executed !== false) return undefined;
  return { draftRunId: id, executionSegmentId: segmentId, specHash: v.specHash, rootTaskId: v.rootTaskId,
    phase: v.phase, diagnostic: normalizeCommandCapabilityDiagnostic(v.diagnostic), executed: false, code: v.code.slice(0, 100), reason: v.reason.slice(0, 2000),
    candidateArgs: Array.isArray(v.candidateArgs) && v.candidateArgs.every(arg => typeof arg === 'string')
      ? v.candidateArgs.slice(0, 16).map(arg => arg.slice(0, 300)) : undefined,
    dependsOn: typeof v.dependsOn === 'string' ? v.dependsOn : undefined };
}

function approvalReason(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, 2000) : undefined;
}

export function normalizeApprovalProcessing(value: unknown): ApprovalProcessingState | undefined {
  const v = value as ApprovalProcessingState | undefined;
  if (v?.version !== 2 || typeof v.runId !== 'string' || typeof v.rootTaskId !== 'string'
    || v.mode !== 'delegate' || !Array.isArray(v.targets)
    || !['processing', 'completed', 'blocked', 'waiting_user', 'paused', 'replanning', 'stopped'].includes(v.status)
    || v.replanKeys !== undefined && !isCommandRecoveryKeyList(v.replanKeys)) return undefined;
  const interrupted = v.status === 'processing' || v.status === 'replanning' || v.status === 'waiting_user';
  const targets = v.targets.filter(t => t && typeof t.id === 'string' && ['edit', 'command'].includes(t.kind)
    && ['pending', 'executed', 'denied', 'manual_required', 'review_unavailable', 'paused', 'hard_blocked', 'needs_authorization', 'failed', 'cancelled', 'already_processed', 'identity_mismatch', 'missing', 'needs_replan', 'dependency_blocked', 'external_authorization_required', 'insufficient_launch_evidence'].includes(t.status))
    .map(t => {
      const replan = normalizeDraftRunReplan(t.replan, t.id, v.runId);
      const wasWaiting = t.status === 'pending' || t.status === 'manual_required';
      const status = wasWaiting ? 'paused' : t.status;
      return { id: t.id, kind: t.kind, status,
        failureCode: typeof t.failureCode === 'string' && /^[a-z_]{1,64}$/u.test(t.failureCode) ? t.failureCode : undefined,
        reason: approvalReason(t.reason), dependency: normalizeApprovalDependency(t.dependency),
        canResume: wasWaiting || t.canResume === true || undefined,
        reviewId: typeof t.reviewId === 'string' && t.reviewId.length <= 128 ? t.reviewId : undefined,
        replan: replan?.rootTaskId === v.rootTaskId ? replan : undefined };
    });
  return { version: v.version, runId: v.runId, rootTaskId: v.rootTaskId, mode: v.mode,
    backgroundRunId: typeof v.backgroundRunId === 'string' && v.backgroundRunId.length <= 128 ? v.backgroundRunId : undefined,
    status: interrupted ? v.status === 'replanning' ? 'blocked' : 'paused' : v.status, targets,
    canResume: targets.some(target => target.canResume)
      || (interrupted || v.canResume === true) && targets.some(target => ['needs_replan', 'dependency_blocked'].includes(target.status)) || undefined,
    localGitCompletionRetried: v.localGitCompletionRetried === true || undefined,
    replanKeys: v.replanKeys?.slice(),
    reason: interrupted ? 'Interrupted; explicitly resume processing. / 处理已中断，请明确恢复。' : approvalReason(v.reason),
    pausedAt: ['waiting_user', 'paused'].includes(v.status) && typeof v.pausedAt === 'string'
      && Number.isFinite(Date.parse(v.pausedAt)) ? v.pausedAt : undefined,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '' };
}
