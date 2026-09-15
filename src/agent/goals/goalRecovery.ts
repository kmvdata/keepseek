import { transitionGoal } from './goalStateMachine';
import { isGoalTerminalStatus, type GoalRecordV1, type GoalStatus } from './goalTypes';

export interface GoalRecoveryContext {
  runtimeId: string;
  workspaceKey: string;
  sessionId: string;
  sourceId: string;
  modelId: string;
  provider: string;
  endpointHash: string;
  workspaceTrusted: boolean;
  hasExternalAuthorizationRequirement: boolean;
  checkpointValid: boolean;
  hasUncertainChangeSet: boolean;
  hasUncertainDraftRun: boolean;
  hasUncertainToolResult: boolean;
  hasPendingApproval: boolean;
  canAcquireLease: boolean;
  autoResumeEnabled: boolean;
}

export interface GoalRecoveryResult {
  record: GoalRecordV1;
  autoResume: boolean;
  reason?: string;
}

/** Classifies persisted state without reviving any volatile approval, permit,
 * batch, authorization, or in-memory continuation. */
export function classifyGoalRecovery(record: GoalRecordV1, context: GoalRecoveryContext, now = new Date().toISOString()): GoalRecoveryResult {
  if (isGoalTerminalStatus(record.status)) return { record: structuredClone(record), autoResume: false };
  let next = structuredClone(record);
  const previousStatus = next.status;
  // V1 has no persisted file-watcher watermark. After a host gap we cannot
  // prove the workspace stayed unchanged, so old validation/completion proof
  // is conservatively invalidated before any manual or automatic resume.
  next.validations = [];
  next.completionDecision = undefined;
  next.criteria = next.criteria.map((criterion) => ({ ...criterion, status: 'pending', evidenceManifestHash: undefined }));
  if (next.status === 'running' || next.status === 'pausing') {
    next = transitionGoal(next, 'interrupted', { now, reason: 'KeepSeek Extension Host restarted.' });
  }
  const uncertain = context.hasUncertainChangeSet || context.hasUncertainDraftRun || context.hasUncertainToolResult;
  const mismatch = firstMismatch(record, context);
  const reason = uncertain
    ? 'A file, command, or tool result has an unknown terminal state and must be verified.'
    : mismatch;
  if (reason) {
    if (next.status !== 'needs_attention') next = transitionForRecovery(next, 'needs_attention', reason, now);
    next.lastInterruption = { runtimeId: context.runtimeId, previousStatus, reason: 'extension_restart', uncertainSideEffect: uncertain, recordedAt: now };
    return { record: next, autoResume: false, reason };
  }
  next.lastInterruption = { runtimeId: context.runtimeId, previousStatus, reason: 'extension_restart', uncertainSideEffect: false, recordedAt: now };
  const contract = next.revisions.find((revision) => revision.revision === next.currentRevision)!.contract;
  const autoResume = context.autoResumeEnabled && contract.resumePolicy === 'auto_on_activation' && context.canAcquireLease && !context.hasPendingApproval
    && !context.hasExternalAuthorizationRequirement;
  if (!autoResume && next.status !== 'interrupted' && next.status !== 'paused') {
    next = transitionForRecovery(next, 'interrupted', 'Manual Goal recovery is required.', now);
  }
  return { record: next, autoResume, reason: autoResume ? undefined : 'Manual Goal recovery is required.' };
}

function firstMismatch(record: GoalRecordV1, context: GoalRecoveryContext): string | undefined {
  const contract = record.revisions.find((revision) => revision.revision === record.currentRevision)?.contract;
  if (!contract) return 'The Goal contract revision is unavailable.';
  if (record.workspaceKey !== context.workspaceKey) return 'Workspace identity changed.';
  if (record.sessionId !== context.sessionId) return 'The Goal session changed.';
  if (!context.workspaceTrusted) return 'Workspace Trust is required.';
  if (!context.checkpointValid) return 'The Goal checkpoint cannot be verified.';
  if (contract.main.sourceId !== context.sourceId || contract.main.modelId !== context.modelId
    || contract.main.provider !== context.provider || contract.main.endpointHash !== context.endpointHash) return 'The frozen Goal model source changed.';
  if (!context.canAcquireLease) return 'The workspace Goal lease is held elsewhere or cannot be acquired.';
  return undefined;
}

function transitionForRecovery(record: GoalRecordV1, status: Extract<GoalStatus, 'interrupted' | 'needs_attention'>, reason: string, now: string): GoalRecordV1 {
  if (record.status === status) {
    const next = structuredClone(record); next.updatedAt = now; next.stopReason = reason; return next;
  }
  try { return transitionGoal(record, status, { now, reason }); }
  catch {
    const next = structuredClone(record); next.status = status; next.updatedAt = now; next.stopReason = reason; return next;
  }
}
