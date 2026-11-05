import type { ManualToolApproval } from './approvalReviewTypes';

/** Persisted for explanation/recovery only. Authority lives in the host callback. */
export interface ManualApprovalSnapshot extends ManualToolApproval {
  version: 1;
  rootTaskId: string;
  agentRunId: string;
  targetId: string;
  actionHash: string;
  scopeFingerprint?: string;
  status: 'waiting' | 'interrupted' | 'approved' | 'rejected' | 'cancelled';
}

export function normalizeManualApproval(value: unknown): ManualApprovalSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const v = value as ManualApprovalSnapshot;
  if (v.version !== 1 || ![v.id, v.sessionId, v.rootTaskId, v.agentRunId, v.targetId, v.actionHash]
    .every(item => typeof item === 'string' && item.length > 0)
    || !['waiting', 'interrupted', 'approved', 'rejected', 'cancelled'].includes(v.status)
    || typeof v.label !== 'string' || typeof v.reason !== 'string') return undefined;
  return { version: 1, id: v.id, sessionId: v.sessionId, rootTaskId: v.rootTaskId,
    agentRunId: v.agentRunId, targetId: v.targetId, actionHash: v.actionHash,
    scopeFingerprint: typeof v.scopeFingerprint === 'string' ? v.scopeFingerprint : undefined,
    label: v.label.slice(0, 8000), reason: v.reason.slice(0, 4000),
    priorReviewId: typeof v.priorReviewId === 'string' ? v.priorReviewId : undefined,
    // Never restore a runtime token, exact request or live queue from disk.
    status: v.status === 'waiting' ? 'interrupted' : v.status };
}
