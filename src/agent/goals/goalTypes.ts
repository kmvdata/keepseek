import type { ProviderReplayState, SafeNpmScript, TaskPlan } from '../../shared/types';
import type { RunCheckpoint } from '../runCheckpoint';
import type { GoalProviderReplayStateV1 } from './goalReplay';

export const GOAL_CONTRACT_VERSION = 1 as const;
export const GOAL_CONTRACT_V2_VERSION = 2 as const;
export const GOAL_RECORD_VERSION = 1 as const;
export const GOAL_REQUEST_PROTOCOL_VERSION = 10 as const;
export const GOAL_TOOL_SCHEMA_VERSION = 9 as const;
export const MAX_GOAL_OBJECTIVE_CHARACTERS = 20_000;
export const MAX_GOAL_PROPOSAL_WORK_ITEMS = 20;

export type GoalCriterionType = 'validation' | 'workspace_state' | 'artifact' | 'manual';

export interface GoalAcceptanceCriterionV1 {
  id: string;
  text: string;
  type: GoalCriterionType;
  evidenceRequirement: string;
}

export type GoalProposalCriterionV1 = GoalAcceptanceCriterionV1;

export interface GoalProposalWorkItemV1 {
  id: string;
  title: string;
  detail: string;
  acceptanceCriteria: GoalProposalCriterionV1[];
  dependsOn: string[];
}

/** Immutable, provider-generated candidate. Runtime ids, timestamps, local
 * paths, and user selection are deliberately excluded from its hash. */
export interface GoalProposalV1 {
  version: 1;
  objective: string;
  workItems: GoalProposalWorkItemV1[];
  includeScope: string[];
  excludeScope: string[];
  requiredValidations: SafeNpmScript[];
  proposalHash: string;
}

/** Ephemeral, pre-Goal assessment. It is kept only in Extension Host memory
 * and never enters GoalStore, ChatSession messages, or Provider replay. */
export interface GoalDraftAssessmentV1 {
  version: 1;
  verdict: 'ready' | 'needs_normalization';
  reason: string;
  originalObjective: string;
  normalizedObjective: string;
  proposal: GoalProposalV1;
}

export type GoalUiMode =
  | 'chat'
  | 'goal_armed'
  | 'proposal_generating'
  | 'proposal_review'
  | 'goal_active'
  | 'goal_terminal'
  | 'workspace_goal_elsewhere';

export interface GoalUiStateV1 {
  version: 1;
  mode: GoalUiMode;
  composerMode: boolean;
  activeSessionId: string;
  goalSessionId?: string;
}

export type GoalWorkItemSelection = 'selected' | 'unselected';

/** Host-only audit artifact. It is stored with the Goal snapshot and never
 * projected into Provider requests or Goal replay. */
export interface GoalProposalDecisionV1 {
  version: 1;
  proposal: GoalProposalV1;
  proposalHash: string;
  decisions: Array<{ workItemId: string; selection: GoalWorkItemSelection }>;
  decidedAt: string;
}

export interface GoalBudgetV1 {
  maxActiveExecutionMs: number;
  /** A single positive limit applies independently to every accounted currency. */
  maxCost: number;
  maxModelRequests: number;
  maxCompletionReviews: number;
}

export interface GoalFrozenRuntimeV1 {
  sourceId: string;
  modelId: string;
  provider: string;
  endpointHash: string;
  runtimeProfile: string;
}

export interface GoalCompletionReviewerV1 {
  mode: 'follow_subagent_model' | 'fixed';
  sourceId: string;
  modelId: string;
  provider: string;
  endpointHash: string;
}

export interface GoalContractV1 {
  version: typeof GOAL_CONTRACT_VERSION;
  objective: string;
  /** Append-only user amendments; the original objective is never rewritten. */
  amendments: string[];
  acceptanceCriteria: GoalAcceptanceCriterionV1[];
  includeScope: string[];
  excludeScope: string[];
  requiredValidations: SafeNpmScript[];
  completionPolicy: 'host_and_reviewer';
  budgets: GoalBudgetV1;
  resumePolicy: 'manual' | 'auto_on_activation';
  main: GoalFrozenRuntimeV1;
  completionReviewer: GoalCompletionReviewerV1;
  requestProtocolVersion: typeof GOAL_REQUEST_PROTOCOL_VERSION;
  toolSchemaVersion: typeof GOAL_TOOL_SCHEMA_VERSION;
  canonicalHash: string;
}

export interface GoalAcceptanceCriterionV2 extends GoalAcceptanceCriterionV1 {
  workItemId: string;
}

export interface GoalWorkItemV2 {
  id: string;
  title: string;
  detail: string;
  acceptanceCriterionIds: string[];
  dependsOn: string[];
}

/** New Goals use V2. V1 remains byte-for-byte readable and serializable. */
export interface GoalContractV2 {
  version: typeof GOAL_CONTRACT_V2_VERSION;
  objective: string;
  amendments: string[];
  proposalHash: string;
  workItems: GoalWorkItemV2[];
  acceptanceCriteria: GoalAcceptanceCriterionV2[];
  includeScope: string[];
  excludeScope: string[];
  requiredValidations: SafeNpmScript[];
  completionPolicy: 'host_and_reviewer';
  budgets: GoalBudgetV1;
  resumePolicy: 'manual' | 'auto_on_activation';
  main: GoalFrozenRuntimeV1;
  completionReviewer: GoalCompletionReviewerV1;
  requestProtocolVersion: typeof GOAL_REQUEST_PROTOCOL_VERSION;
  toolSchemaVersion: typeof GOAL_TOOL_SCHEMA_VERSION;
  canonicalHash: string;
}

export type GoalContract = GoalContractV1 | GoalContractV2;

export interface GoalContractRevisionV1 {
  revision: number;
  contract: GoalContract;
  amendment?: string;
  createdAt: string;
}

export type GoalStatus =
  | 'preparing'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'waiting_for_apply'
  | 'waiting_for_authorization'
  | 'waiting_for_command'
  | 'waiting_for_user'
  | 'needs_attention'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'stopped';

export type GoalTerminalStatus = Extract<GoalStatus, 'completed' | 'failed' | 'stopped'>;

export interface GoalValidationRecordV1 {
  script: SafeNpmScript;
  status: 'passed' | 'failed' | 'interrupted';
  mutationRevision: number;
  evidenceRef?: string;
  contentHash?: string;
  completedAt: string;
}

export interface GoalCriterionProgressV1 {
  criterionId: string;
  status: 'pending' | 'satisfied' | 'blocked';
  evidenceRefs: string[];
  evidenceManifestHash?: string;
  detail?: string;
}

export interface GoalCompletionDecisionV1 {
  decision: 'complete' | 'continue' | 'blocked';
  goalHash: string;
  revision: number;
  candidateHash: string;
  evidenceManifestHash: string;
  mutationRevision: number;
  unmetCriterionIds: string[];
  incompleteValidations: SafeNpmScript[];
  requiredInput?: string;
  reviewedAt: string;
}

export interface GoalReplayCursorV1 {
  version: 1;
  protocol: 'chat-completions' | 'openai-responses' | 'anthropic-messages';
  itemCount: number;
  bytesHash: string;
  storageRef: string;
}

export interface GoalCheckpointStateV1 {
  version: 1;
  contractHash: string;
  revision: number;
  activeExecutionMs: number;
  costByCurrency: Record<string, number>;
  modelRequests: number;
  completionReviews: number;
  criteria: Array<{ id: string; status: GoalCriterionProgressV1['status']; evidenceManifestHash?: string }>;
  workItems?: GoalWorkItemProgressV1[];
  validationMutationRevision: number;
  replayCursor?: GoalReplayCursorV1;
  consumedResultKeys: string[];
  completionDecisionRef?: string;
}

export interface GoalWorkItemProgressV1 {
  version: 1;
  workItemId: string;
  status: TaskPlan['steps'][number]['status'];
  acceptanceCriterionIds: string[];
  detail?: string;
  /** Present only when host evidence can bind a Goal pause to this item. */
  pauseReason?: string;
}

export interface GoalSideEffectStateV1 {
  changeSetIds: string[];
  draftRunIds: string[];
  approvalIds: string[];
  pendingToolCallIds: string[];
  uncertainToolCallIds: string[];
  subagentIds: string[];
}

export interface GoalRequestIntentV1 {
  sequence: number;
  kind: 'initial' | 'continue' | 'resume' | 'completion_review' | 'side_effect';
  status: 'prepared' | 'dispatched' | 'settled' | 'cancelled' | 'uncertain';
  checkpointHash: string;
  idempotencyKey: string;
  createdAt: string;
}

export interface GoalRuntimeInterruptionV1 {
  runtimeId: string;
  previousStatus: GoalStatus;
  reason: 'extension_restart' | 'workspace_changed' | 'session_changed' | 'source_changed' | 'approval_mode_changed' | 'authorization_revoked';
  uncertainSideEffect: boolean;
  recordedAt: string;
}

export interface GoalLeaseBindingV1 {
  ownerId: string;
  fencingToken: number;
}

export interface GoalRecordV1 {
  version: typeof GOAL_RECORD_VERSION;
  /** Monotonic optimistic-concurrency revision for snapshots. Optional only
   * when reading early V1 records written before this field existed. */
  storageRevision?: number;
  id: string;
  workspaceKey: string;
  sessionId: string;
  initialPrompt: {
    visibleContent: string;
    expandedContent: string;
    providerContent: string;
  };
  /** Host-only exact authorization keys. Never included in contract/replay/view model. */
  requiredExternalAuthorizationUris: string[];
  status: GoalStatus;
  /** Present for V2 Goals only; complete selected/unselected audit stays host-side. */
  proposalDecision?: GoalProposalDecisionV1;
  revisions: GoalContractRevisionV1[];
  currentRevision: number;
  currentContractHash: string;
  usage: {
    activeExecutionMs: number;
    costByCurrency: Record<string, number>;
    modelRequests: number;
    mainModelRequests: number;
    auxiliaryModelRequests: number;
    completionReviews: number;
  };
  logicalTaskId?: string;
  runCheckpoint?: RunCheckpoint;
  assistantMessageId?: string;
  finalMessageId?: string;
  providerReplay?: ProviderReplayState;
  /** Atomically persisted terminal replay used by the next real user turn. */
  terminalReplay?: GoalProviderReplayStateV1;
  replayCursor?: GoalReplayCursorV1;
  workspaceMutationRevision: number;
  validations: GoalValidationRecordV1[];
  criteria: GoalCriterionProgressV1[];
  workItems?: GoalWorkItemProgressV1[];
  completionDecision?: GoalCompletionDecisionV1;
  candidateFinal?: {
    content: string;
    contentHash: string;
    reasoningContent?: string;
    taskPlan?: TaskPlan;
    providerReplay?: ProviderReplayState;
  };
  consumedResultKeys: string[];
  requestIntents: GoalRequestIntentV1[];
  lastInterruption?: GoalRuntimeInterruptionV1;
  journalShards: string[];
  nextJournalSequence: number;
  sideEffects: GoalSideEffectStateV1;
  lease?: GoalLeaseBindingV1;
  waitingReason?: string;
  stopReason?: string;
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface GoalJournalEventV1 {
  version: 1;
  sequence: number;
  goalId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface GoalViewModelV1 {
  version: 1;
  id: string;
  status: GoalStatus;
  objective: string;
  revision: number;
  criteria: Array<{ id: string; text: string; type: GoalCriterionType; status: GoalCriterionProgressV1['status']; detail?: string }>;
  requiredValidations: Array<{ script: SafeNpmScript; status: 'pending' | 'passed' | 'failed' | 'interrupted' }>;
  currentStep?: string;
  activeExecutionMs: number;
  maxActiveExecutionMs: number;
  modelRequests: number;
  maxModelRequests: number;
  completionReviews: number;
  maxCompletionReviews: number;
  costByCurrency: Record<string, number>;
  maxCost: number;
  modelId: string;
  approvalMode: string;
  resumePolicy: GoalContractV1['resumePolicy'];
  waitingReason?: string;
  stopReason?: string;
  canPause: boolean;
  canResume: boolean;
  canStop: boolean;
  canClear: boolean;
}

export interface GoalTraceSummaryV1 {
  id: string;
  kind: 'start' | 'resume' | 'attempt' | 'completion_review' | 'approval';
  attempt: number;
  createdAt: string;
  level: 'metadata' | 'request' | 'full';
}

export interface GoalViewModelV2 extends Omit<GoalViewModelV1, 'version'> {
  version: 2;
  contractVersion: GoalContract['version'];
  workItems: Array<{
    id: string;
    title: string;
    detail: string;
    selection: 'selected';
    status: GoalWorkItemProgressV1['status'];
    acceptanceCriterionIds: string[];
    pauseReason?: string;
  }>;
  currentActivity?: { kind: 'task_plan_step' | 'goal_state'; text: string };
  interruption?: Pick<GoalRuntimeInterruptionV1, 'reason' | 'previousStatus' | 'uncertainSideEffect'>;
  traces: GoalTraceSummaryV1[];
}

export type GoalViewModel = GoalViewModelV1 | GoalViewModelV2;

export function isGoalTerminalStatus(status: GoalStatus): status is GoalTerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

export function isGoalActiveStatus(status: GoalStatus): boolean {
  return !isGoalTerminalStatus(status);
}
