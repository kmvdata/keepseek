export type ApprovalTargetStatus = 'pending' | 'executed' | 'denied' | 'needs_authorization' | 'failed' | 'cancelled' | 'already_processed' | 'identity_mismatch' | 'missing';
export interface ApprovalProcessingState {
  version: 1;
  runId: string;
  rootTaskId: string;
  mode: 'delegate' | 'model_review';
  status: 'processing' | 'completed' | 'blocked';
  targets: Array<{ id: string; kind: 'edit' | 'command'; status: ApprovalTargetStatus; reason?: string }>;
  reason?: string;
  updatedAt: string;
}
export function normalizeApprovalProcessing(value: unknown): ApprovalProcessingState | undefined {
  const v = value as ApprovalProcessingState | undefined;
  if (v?.version !== 1 || typeof v.runId !== 'string' || typeof v.rootTaskId !== 'string'
    || !['delegate', 'model_review'].includes(v.mode) || !Array.isArray(v.targets)
    || !['processing', 'completed', 'blocked'].includes(v.status)) return undefined;
  const targets = v.targets.filter(t => t && typeof t.id === 'string' && ['edit', 'command'].includes(t.kind)
    && ['pending', 'executed', 'denied', 'needs_authorization', 'failed', 'cancelled', 'already_processed', 'identity_mismatch', 'missing'].includes(t.status))
    .map(t => ({ id: t.id, kind: t.kind, status: t.status === 'pending' ? 'cancelled' as const : t.status,
      reason: typeof t.reason === 'string' ? t.reason.slice(0, 2000) : undefined }));
  return { version: 1, runId: v.runId, rootTaskId: v.rootTaskId, mode: v.mode,
    status: v.status === 'processing' ? 'blocked' : v.status, targets,
    reason: v.status === 'processing' ? 'Interrupted; explicitly resume processing. / 处理已中断，请明确恢复。' : typeof v.reason === 'string' ? v.reason.slice(0, 2000) : undefined,
    updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : '' };
}
