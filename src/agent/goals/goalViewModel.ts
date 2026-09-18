import type { ApprovalMode } from '../../shared/types';
import {
  isGoalTerminalStatus,
  type GoalUiStateV1,
  type GoalRecordV1,
  type GoalTraceSummaryV1,
  type GoalViewModelV2
} from './goalTypes';

export function createGoalUiState(input: {
  activeSessionId: string;
  composerMode: boolean;
  goal?: GoalRecordV1;
  proposalStatus?: 'idle' | 'generating' | 'ready' | 'error' | 'cancelled';
}): GoalUiStateV1 {
  const goalSessionId = input.goal?.sessionId;
  let mode: GoalUiStateV1['mode'];
  if (input.goal && goalSessionId !== input.activeSessionId) mode = 'workspace_goal_elsewhere';
  else if (input.goal) mode = isGoalTerminalStatus(input.goal.status) ? 'goal_terminal' : 'goal_active';
  else if (input.proposalStatus === 'generating') mode = 'proposal_generating';
  else if (input.proposalStatus) mode = 'proposal_review';
  else mode = input.composerMode ? 'goal_armed' : 'chat';
  return {
    version: 1,
    mode,
    composerMode: mode === 'workspace_goal_elsewhere' ? false : input.composerMode,
    activeSessionId: input.activeSessionId,
    ...(goalSessionId ? { goalSessionId } : {})
  };
}

export function createGoalViewModel(
  record: GoalRecordV1 | undefined,
  approvalMode: ApprovalMode,
  traces: readonly GoalTraceSummaryV1[] = []
): GoalViewModelV2 | undefined {
  if (!record) return undefined;
  const contract = record.revisions.find((revision) => revision.revision === record.currentRevision)?.contract;
  if (!contract) return undefined;
  const taskPlan = record.runCheckpoint?.taskPlan ?? record.candidateFinal?.taskPlan;
  const currentStep = taskPlan?.steps.find((step) => step.id === taskPlan.currentStepId)?.title;
  const currentActivity = currentStep
    ? { kind: 'task_plan_step' as const, text: currentStep }
    : (record.waitingReason || record.stopReason)
      ? { kind: 'goal_state' as const, text: record.waitingReason ?? record.stopReason! }
      : undefined;
  const workItems = contract.version === 2 ? contract.workItems.map((item) => {
    const progress = record.workItems?.find((entry) => entry.workItemId === item.id);
    return {
      id: item.id,
      title: item.title,
      detail: item.detail,
      selection: 'selected' as const,
      status: progress?.status ?? 'pending' as const,
      acceptanceCriterionIds: [...item.acceptanceCriterionIds],
      pauseReason: progress?.pauseReason
    };
  }) : [];
  return {
    version: 2,
    contractVersion: contract.version,
    id: record.id,
    status: record.status,
    objective: contract.objective,
    revision: record.currentRevision,
    workItems,
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
    currentStep,
    currentActivity,
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
    interruption: record.lastInterruption ? {
      reason: record.lastInterruption.reason,
      previousStatus: record.lastInterruption.previousStatus,
      uncertainSideEffect: record.lastInterruption.uncertainSideEffect
    } : undefined,
    traces: traces.slice(-100).map((trace) => ({ ...trace })),
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
  approvalMode: ApprovalMode,
  traces: readonly GoalTraceSummaryV1[] = []
): GoalViewModelV2 | null {
  return createGoalViewModel(record, approvalMode, traces) ?? null;
}
