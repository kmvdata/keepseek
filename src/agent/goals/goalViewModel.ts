import type { ApprovalMode } from '../../shared/types';
import { isGoalTerminalStatus, type GoalRecordV1, type GoalViewModelV1 } from './goalTypes';

export function createGoalViewModel(record: GoalRecordV1 | undefined, approvalMode: ApprovalMode): GoalViewModelV1 | undefined {
  if (!record) return undefined;
  const contract = record.revisions.find((revision) => revision.revision === record.currentRevision)?.contract;
  if (!contract) return undefined;
  const taskPlan = record.runCheckpoint?.taskPlan ?? record.candidateFinal?.taskPlan;
  return {
    version: 1,
    id: record.id,
    status: record.status,
    objective: contract.objective,
    revision: record.currentRevision,
    criteria: contract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      text: criterion.text,
      type: criterion.type,
      status: record.criteria.find((item) => item.criterionId === criterion.id)?.status ?? 'pending',
      detail: record.criteria.find((item) => item.criterionId === criterion.id)?.detail
    })),
    requiredValidations: contract.requiredValidations.map((script) => ({
      script,
      status: record.validations.filter((validation) => validation.script === script)
        .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0]?.status ?? 'pending'
    })),
    currentStep: taskPlan?.steps.find((step) => step.id === taskPlan.currentStepId)?.title,
    activeExecutionMs: record.usage.activeExecutionMs,
    maxActiveExecutionMs: contract.budgets.maxActiveExecutionMs,
    modelRequests: record.usage.modelRequests,
    maxModelRequests: contract.budgets.maxModelRequests,
    completionReviews: record.usage.completionReviews,
    maxCompletionReviews: contract.budgets.maxCompletionReviews,
    costByCurrency: { ...record.usage.costByCurrency },
    maxCost: contract.budgets.maxCost,
    modelId: contract.main.modelId,
    approvalMode,
    resumePolicy: contract.resumePolicy,
    waitingReason: record.waitingReason,
    stopReason: record.stopReason,
    canPause: record.status === 'running' || record.status === 'pausing',
    canResume: record.status === 'paused' || record.status === 'interrupted' || record.status === 'waiting_for_user' || record.status === 'needs_attention',
    canStop: !isGoalTerminalStatus(record.status),
    canClear: isGoalTerminalStatus(record.status)
  };
}

/** Webview state patches cross VS Code's message serialization boundary. An
 * explicit null is required to clear an earlier Goal; undefined properties may
 * be omitted by the transport and would leave stale client state behind. */
export function createGoalViewModelPayload(
  record: GoalRecordV1 | undefined,
  approvalMode: ApprovalMode
): GoalViewModelV1 | null {
  return createGoalViewModel(record, approvalMode) ?? null;
}
