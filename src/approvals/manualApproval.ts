import { redactSensitiveReviewText } from './approvalPolicy';
import { normalizeApprovalReviewState, type ApprovalReviewExactAction, type ManualToolApproval } from './approvalReviewTypes';

const MAX_MANUAL_APPROVALS = 64;
const RESOLUTION_REASONS = ['retry_requested', 'user_cancelled', 'session_changed', 'host_interrupted',
  'stale_request', 'mode_changed', 'storage_failed', 'user_approved', 'user_rejected', 'history_changed'];

/** Persisted for explanation/recovery only. Authority lives in the host callback. */
export interface ManualApprovalSnapshot extends ManualToolApproval {
  version: 1;
  rootTaskId: string;
  agentRunId: string;
  targetId: string;
  actionHash: string;
  scopeFingerprint?: string;
  policyVersion?: number;
  requestedAt?: string;
  decidedAt?: string;
  affectedTargets?: string[];
  status: 'waiting' | 'interrupted' | 'approved' | 'rejected' | 'cancelled';
}

export function normalizeManualApproval(value: unknown): ManualApprovalSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as ManualApprovalSnapshot;
  if (v.version !== 1 || ![v.id, v.sessionId, v.rootTaskId, v.agentRunId, v.targetId, v.actionHash]
    .every(item => typeof item === 'string' && item.length > 0)
    || !['waiting', 'interrupted', 'approved', 'rejected', 'cancelled'].includes(v.status)
    || typeof v.label !== 'string' || typeof v.reason !== 'string') return undefined;
  const interrupted = v.status === 'waiting';
  return { version: 1, id: v.id, sessionId: v.sessionId, rootTaskId: v.rootTaskId,
    agentRunId: v.agentRunId, targetId: v.targetId, actionHash: v.actionHash,
    scopeFingerprint: typeof v.scopeFingerprint === 'string' ? v.scopeFingerprint : undefined,
    label: v.label.slice(0, 8000), reason: v.reason.slice(0, 4000),
    priorReviewId: typeof v.priorReviewId === 'string' ? v.priorReviewId : undefined,
    policyVersion: Number.isSafeInteger(v.policyVersion) && v.policyVersion! > 0 ? v.policyVersion : undefined,
    requestedAt: normalizeTime(v.requestedAt), decidedAt: normalizeTime(v.decidedAt),
    risk: v.risk && ['low', 'medium', 'high', 'critical'].includes(v.risk) ? v.risk : undefined,
    reviewState: normalizeApprovalReviewState(v.reviewState),
    authorizationTargets: Array.isArray(v.authorizationTargets)
      ? v.authorizationTargets.filter(t => typeof t === 'string').slice(0, 32).map(t => t.slice(0, 800)) : undefined,
    affectedTargets: Array.isArray(v.affectedTargets)
      ? v.affectedTargets.filter(t => typeof t === 'string').slice(0, 32).map(t => t.slice(0, 800)) : undefined,
    resolutionReason: interrupted ? 'host_interrupted' : v.resolutionReason && RESOLUTION_REASONS.includes(v.resolutionReason) ? v.resolutionReason : undefined,
    // Persisted runtime identity is diagnostic only. Exact requests and live tokens stay in memory.
    runtimeId: typeof v.runtimeId === 'string' ? v.runtimeId.slice(0, 128) : undefined,
    status: interrupted ? 'interrupted' : v.status };
}

export function recordManualApproval(rows: readonly ManualApprovalSnapshot[] | undefined, snapshot: ManualApprovalSnapshot): ManualApprovalSnapshot[] {
  return [...(rows ?? []).filter(row => row.id !== snapshot.id), snapshot].slice(-MAX_MANUAL_APPROVALS);
}

export function normalizeManualApprovals(value: unknown, sessionId: string): ManualApprovalSnapshot[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rows = value.slice(-MAX_MANUAL_APPROVALS).map(normalizeManualApproval)
    .filter((row): row is ManualApprovalSnapshot => row !== undefined && row.sessionId === sessionId);
  return rows.length ? [...new Map(rows.map(row => [row.id, row])).values()] : undefined;
}

function normalizeTime(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** Command cards retain the draft; this preview omits content bodies and private review context. */
export function manualApprovalActionPreview(action: ApprovalReviewExactAction | undefined): unknown {
  if (!action) return undefined;
  return JSON.parse(JSON.stringify(action, (key, value: unknown) => {
    if (key === 'content' || key === 'effectAssessment') return undefined;
    return typeof value === 'string' ? redactSensitiveReviewText(value, 8000) : value;
  }));
}
