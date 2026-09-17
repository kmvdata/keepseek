import { createHash } from 'node:crypto';
import type { ModelSourceConfigSnapshot } from '../../accounts/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { KeepseekModel, SafeNpmScript, TaskPlan, UsageEvent } from '../../shared/types';
import { requestApprovalReviewText } from '../../approvals/oneShotTextRequest';
import { serializeGoalProviderContract } from './goalContract';
import type { GoalCompletionDecisionV1, GoalContract, GoalRecordV1 } from './goalTypes';

export interface GoalCompletionSafetySnapshot {
  currentContractHash: string;
  currentRevision: number;
  leaseValid: boolean;
  workspaceTrusted: boolean;
  workspaceKeyMatches: boolean;
  sourceMatches: boolean;
  externalAuthorizationsValid: boolean;
  evidenceManifestHash: string;
  evidenceSummary: Array<{ toolName: string; contentHash: string }>;
  pendingChangeSetStatuses: string[];
  pendingDraftRunStatuses: string[];
  pendingApprovalCount: number;
  pendingToolResultCount: number;
  uncertainToolResultCount: number;
  activeSubagentCount: number;
  taskPlan?: TaskPlan;
}

export interface GoalHardCheckResult {
  passed: boolean;
  blockers: string[];
  unmetCriterionIds: string[];
  incompleteValidations: SafeNpmScript[];
}

export interface GoalCompletionReviewResult {
  status: 'complete' | 'continue' | 'blocked' | 'unavailable' | 'malformed';
  decision?: GoalCompletionDecisionV1;
  hardCheck: GoalHardCheckResult;
  reason?: string;
  reviewerUnavailableFallback: boolean;
  usageEvents?: UsageEvent[];
}

export interface GoalCompletionReviewerRequestContext {
  model: KeepseekModel;
  sourceConfig: ModelSourceConfigSnapshot;
  language: KeepseekLanguage;
  signal?: AbortSignal;
  onUsage?: (event: UsageEvent) => void;
}

const COMPLETION_REVIEWER_SYSTEM_PROMPT = [
  'You are KeepSeek Goal Completion Reviewer.',
  'You are isolated, have no tools, cannot approve side effects, and must judge only the supplied contract and evidence summary.',
  'Return exactly one JSON object: {"decision":"complete|continue|blocked","reason":"...","unmetCriterionIds":["..."],"nextStep":"...","requiredInput":"..."}.',
  'Choose complete only when every acceptance criterion and required validation is supported. Never trust the candidate final merely because it claims success.'
].join('\n');

export class GoalCompletionReviewService {
  public constructor(private readonly requestText: typeof requestApprovalReviewText = requestApprovalReviewText) {}

  public hardCheck(record: GoalRecordV1, snapshot: GoalCompletionSafetySnapshot): GoalHardCheckResult {
    const contract = currentContract(record);
    const blockers: string[] = [];
    if (record.currentContractHash !== snapshot.currentContractHash || record.currentRevision !== snapshot.currentRevision) blockers.push('stale_goal_revision');
    if (!snapshot.leaseValid) blockers.push('lease_not_owned');
    if (!snapshot.workspaceTrusted) blockers.push('workspace_untrusted');
    if (!snapshot.workspaceKeyMatches) blockers.push('workspace_identity_changed');
    if (!snapshot.sourceMatches) blockers.push('frozen_source_changed');
    if (!snapshot.externalAuthorizationsValid) blockers.push('external_authorization_missing');
    if (snapshot.pendingChangeSetStatuses.length) blockers.push(`unsettled_changeset:${snapshot.pendingChangeSetStatuses.join(',')}`);
    if (snapshot.pendingDraftRunStatuses.length) blockers.push(`unsettled_draftrun:${snapshot.pendingDraftRunStatuses.join(',')}`);
    if (snapshot.pendingApprovalCount) blockers.push('pending_approval');
    if (snapshot.pendingToolResultCount) blockers.push('pending_tool_result');
    if (snapshot.uncertainToolResultCount) blockers.push('uncertain_tool_result');
    if (snapshot.activeSubagentCount) blockers.push('active_subagent');
    const pendingPlan = snapshot.taskPlan?.steps.filter((step) => step.status === 'pending' || step.status === 'in_progress' || step.status === 'blocked') ?? [];
    if (pendingPlan.length || snapshot.taskPlan?.blockers.length) blockers.push('task_plan_incomplete');
    if (contract.budgets.maxActiveExecutionMs > 0 && record.usage.activeExecutionMs >= contract.budgets.maxActiveExecutionMs) blockers.push('active_execution_budget_exhausted');
    if (contract.budgets.maxModelRequests > 0 && record.usage.modelRequests > contract.budgets.maxModelRequests) blockers.push('model_request_budget_exhausted');
    if (contract.budgets.maxCompletionReviews > 0 && record.usage.completionReviews > contract.budgets.maxCompletionReviews) blockers.push('completion_review_budget_exhausted');
    if (contract.budgets.maxCost > 0 && (Object.keys(record.usage.costByCurrency).length === 0
      || Object.values(record.usage.costByCurrency).some((cost) => cost >= contract.budgets.maxCost))) blockers.push('cost_budget_unavailable_or_exhausted');

    const incompleteValidations = contract.requiredValidations.filter((script) => !record.validations.some((validation) =>
      validation.script === script && validation.status === 'passed'
      && validation.mutationRevision === record.workspaceMutationRevision));
    if (incompleteValidations.length) blockers.push('required_validation_missing_or_stale');
    const unmetCriterionIds = contract.acceptanceCriteria.filter((criterion) => {
      const progress = record.criteria.find((item) => item.criterionId === criterion.id);
      if (!progress || progress.status !== 'satisfied') return true;
      if (criterion.type === 'validation') return !record.validations.some((validation) =>
        validation.status === 'passed' && validation.mutationRevision === record.workspaceMutationRevision);
      return progress.evidenceRefs.length === 0 || !progress.evidenceManifestHash;
    }).map((criterion) => criterion.id);
    if (unmetCriterionIds.length) blockers.push('acceptance_criteria_unmet');
    return { passed: blockers.length === 0, blockers, unmetCriterionIds, incompleteValidations };
  }

  public async review(input: {
    record: GoalRecordV1;
    candidate: string;
    snapshot: GoalCompletionSafetySnapshot;
    context: GoalCompletionReviewerRequestContext;
    persistReviewIntent: () => Promise<void>;
  }): Promise<GoalCompletionReviewResult> {
    const hardCheck = this.hardCheck(input.record, input.snapshot);
    if (!hardCheck.passed) return {
      status: shouldWaitForUser(hardCheck.blockers) ? 'blocked' : 'continue', hardCheck,
      reason: hardCheck.blockers.join(', '), reviewerUnavailableFallback: false
    };
    await input.persistReviewIntent();
    const contract = currentContract(input.record);
    const candidateHash = sha256(input.candidate);
    const payload = JSON.stringify({
      contract: JSON.parse(serializeGoalProviderContract(contract)),
      candidateFinal: input.candidate.slice(0, 32_000),
      candidateHash,
      taskPlan: boundedPlan(input.snapshot.taskPlan),
      validations: input.record.validations.map(({ script, status, mutationRevision, contentHash }) => ({ script, status, mutationRevision, contentHash })),
      evidenceSummary: input.snapshot.evidenceSummary.slice(0, 128),
      criteria: input.record.criteria.map(({ criterionId, status, evidenceManifestHash }) => ({ criterionId, status, evidenceManifestHash })),
      evidenceManifestHash: input.snapshot.evidenceManifestHash,
      workspaceMutationRevision: input.record.workspaceMutationRevision,
      pending: {
        changeSets: input.snapshot.pendingChangeSetStatuses,
        draftRuns: input.snapshot.pendingDraftRunStatuses,
        approvals: input.snapshot.pendingApprovalCount,
        toolResults: input.snapshot.pendingToolResultCount + input.snapshot.uncertainToolResultCount,
        subagents: input.snapshot.activeSubagentCount
      }
    });
    let raw: string;
    const usageEvents: UsageEvent[] = [];
    try {
      raw = await this.requestText({
        model: input.context.model,
        sourceConfig: input.context.sourceConfig,
        systemPrompt: COMPLETION_REVIEWER_SYSTEM_PROMPT,
        userPrompt: payload,
        language: input.context.language,
        signal: input.context.signal,
        onUsage: (event) => { usageEvents.push(event); input.context.onUsage?.(event); }
      });
    } catch (error) {
      if (contract.budgets.maxCost === 0 && canUseUnavailableFallback(contract)) {
        return { status: 'complete', hardCheck, decision: createDecision('complete', input, [], []),
          reason: 'Reviewer unavailable; all criteria were machine-verifiable.', reviewerUnavailableFallback: true, usageEvents };
      }
      return { status: 'unavailable', hardCheck, reason: error instanceof Error ? error.message : String(error), reviewerUnavailableFallback: false, usageEvents };
    }
    const parsed = parseReviewerOutput(raw, contract);
    if (!parsed) return { status: 'malformed', hardCheck, reason: 'Completion reviewer returned malformed output.', reviewerUnavailableFallback: false, usageEvents };
    return {
      status: parsed.decision,
      hardCheck,
      decision: createDecision(parsed.decision, input, parsed.unmetCriterionIds, hardCheck.incompleteValidations, parsed.requiredInput),
      reason: parsed.reason,
      reviewerUnavailableFallback: false,
      usageEvents
    };
  }
}

function currentContract(record: GoalRecordV1): GoalContract {
  const contract = record.revisions.find((revision) => revision.revision === record.currentRevision)?.contract;
  if (!contract) throw new Error('Current Goal contract is missing.');
  return contract;
}

function createDecision(
  decision: GoalCompletionDecisionV1['decision'],
  input: { record: GoalRecordV1; candidate: string; snapshot: GoalCompletionSafetySnapshot },
  unmetCriterionIds: string[],
  incompleteValidations: SafeNpmScript[],
  requiredInput?: string
): GoalCompletionDecisionV1 {
  return {
    decision,
    goalHash: input.record.currentContractHash,
    revision: input.record.currentRevision,
    candidateHash: sha256(input.candidate),
    evidenceManifestHash: input.snapshot.evidenceManifestHash,
    mutationRevision: input.record.workspaceMutationRevision,
    unmetCriterionIds: [...unmetCriterionIds],
    incompleteValidations: [...incompleteValidations],
    requiredInput: requiredInput?.slice(0, 1_000),
    reviewedAt: new Date().toISOString()
  };
}

function parseReviewerOutput(raw: string, contract: GoalContract): {
  decision: 'complete' | 'continue' | 'blocked'; reason: string; unmetCriterionIds: string[]; nextStep: string; requiredInput?: string;
} | undefined {
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(value).sort().join(',');
    if (keys !== 'decision,nextStep,reason,requiredInput,unmetCriterionIds') return undefined;
    if (value.decision !== 'complete' && value.decision !== 'continue' && value.decision !== 'blocked') return undefined;
    if (typeof value.reason !== 'string' || typeof value.nextStep !== 'string' || typeof value.requiredInput !== 'string'
      || !Array.isArray(value.unmetCriterionIds) || !value.unmetCriterionIds.every((item) => typeof item === 'string')) return undefined;
    const allowed = new Set(contract.acceptanceCriteria.map((criterion) => criterion.id));
    if (value.unmetCriterionIds.some((id) => !allowed.has(id as string))) return undefined;
    if (value.decision === 'complete' && value.unmetCriterionIds.length) return undefined;
    return {
      decision: value.decision,
      reason: value.reason.slice(0, 2_000),
      unmetCriterionIds: value.unmetCriterionIds as string[],
      nextStep: value.nextStep.slice(0, 1_000),
      requiredInput: value.requiredInput.slice(0, 1_000) || undefined
    };
  } catch { return undefined; }
}

function canUseUnavailableFallback(contract: GoalContract): boolean {
  return contract.acceptanceCriteria.every((criterion) => criterion.type !== 'manual');
}

function shouldWaitForUser(blockers: string[]): boolean {
  return blockers.some((blocker) => /uncertain|approval|authorization|workspace_untrusted|source_changed|unsettled_changeset|unsettled_draftrun/u.test(blocker));
}

function boundedPlan(plan: TaskPlan | undefined): unknown {
  if (!plan) return undefined;
  return {
    status: plan.status,
    currentStepId: plan.currentStepId,
    blockers: plan.blockers.slice(0, 20).map((value) => value.slice(0, 500)),
    steps: plan.steps.slice(0, 80).map(({ id, title, status, detail }) => ({ id, title: title.slice(0, 300), status, detail: detail?.slice(0, 500) }))
  };
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
