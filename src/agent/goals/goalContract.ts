import { createHash } from 'node:crypto';
import type { SafeNpmScript } from '../../shared/types';
import { normalizeCostLimit, normalizeDuration } from '../executionPolicy';
import {
  GOAL_CONTRACT_VERSION,
  GOAL_CONTRACT_V2_VERSION,
  GOAL_REQUEST_PROTOCOL_VERSION,
  GOAL_TOOL_SCHEMA_VERSION,
  MAX_GOAL_OBJECTIVE_CHARACTERS,
  type GoalAcceptanceCriterionV1,
  type GoalBudgetV1,
  type GoalCompletionReviewerV1,
  type GoalContract,
  type GoalContractV1,
  type GoalContractV2,
  type GoalFrozenRuntimeV1
} from './goalTypes';
import { verifyGoalProposal } from './goalDraftGenerator';

export interface CreateGoalContractInput {
  objective: string;
  amendments?: string[];
  acceptanceCriteria?: Array<Partial<GoalAcceptanceCriterionV1> & Pick<GoalAcceptanceCriterionV1, 'text'>>;
  includeScope?: string[];
  excludeScope?: string[];
  requiredValidations?: SafeNpmScript[];
  budgets: Partial<GoalBudgetV1>;
  resumePolicy?: GoalContractV1['resumePolicy'];
  main: GoalFrozenRuntimeV1;
  completionReviewer: GoalCompletionReviewerV1;
}

export interface CreateGoalContractV2Input {
  decision: import('./goalTypes').GoalProposalDecisionV1;
  objective?: string;
  amendments?: string[];
  includeScope?: string[];
  excludeScope?: string[];
  requiredValidations?: SafeNpmScript[];
  budgets: Partial<GoalBudgetV1>;
  resumePolicy?: GoalContractV2['resumePolicy'];
  main: GoalFrozenRuntimeV1;
  completionReviewer: GoalCompletionReviewerV1;
}

export function createGoalContract(input: CreateGoalContractInput): GoalContractV1 {
  const objective = normalizeContractText(input.objective).trim();
  if (!objective) throw new Error('Goal objective is required.');
  if (objective.length > MAX_GOAL_OBJECTIVE_CHARACTERS) {
    throw new Error(`Goal objective exceeds ${MAX_GOAL_OBJECTIVE_CHARACTERS} characters.`);
  }
  assertNoRuntimePath(objective);
  const criteria = (input.acceptanceCriteria?.length ? input.acceptanceCriteria : [{
    text: `The requested outcome is implemented and verified: ${objective.slice(0, 240)}`,
    type: 'workspace_state' as const,
    evidenceRequirement: 'Current workspace state and verification evidence'
  }]).map((item, index) => normalizeCriterion(item, index));
  const provisional: Omit<GoalContractV1, 'canonicalHash'> = {
    version: GOAL_CONTRACT_VERSION,
    objective,
    amendments: (input.amendments ?? []).map((value) => normalizeContractText(value).trim()).filter(Boolean).map((value) => {
      assertNoRuntimePath(value);
      return value;
    }),
    acceptanceCriteria: criteria,
    includeScope: normalizeScopes(input.includeScope ?? []),
    excludeScope: normalizeScopes(input.excludeScope ?? []),
    requiredValidations: normalizeValidations(input.requiredValidations ?? []),
    completionPolicy: 'host_and_reviewer',
    budgets: {
      maxActiveExecutionMs: normalizeDuration(input.budgets.maxActiveExecutionMs),
      maxCost: normalizeCostLimit(input.budgets.maxCost),
      maxModelRequests: normalizeCount(input.budgets.maxModelRequests),
      maxCompletionReviews: normalizeCount(input.budgets.maxCompletionReviews)
    },
    resumePolicy: input.resumePolicy === 'auto_on_activation' ? 'auto_on_activation' : 'manual',
    main: normalizeRuntime(input.main),
    completionReviewer: normalizeReviewer(input.completionReviewer),
    requestProtocolVersion: GOAL_REQUEST_PROTOCOL_VERSION,
    toolSchemaVersion: GOAL_TOOL_SCHEMA_VERSION
  };
  return { ...provisional, canonicalHash: hashGoalContract(provisional) };
}

export function createGoalContractV2(input: CreateGoalContractV2Input): GoalContractV2 {
  if (input.decision.version !== 1 || input.decision.proposalHash !== input.decision.proposal.proposalHash
    || !verifyGoalProposal(input.decision.proposal)) throw new Error('Goal proposal decision is invalid.');
  const selectedIds = new Set(input.decision.decisions
    .filter((decision) => decision.selection === 'selected').map((decision) => decision.workItemId));
  if (!selectedIds.size) throw new Error('At least one Goal work item must be selected.');
  const proposal = input.decision.proposal;
  if (input.decision.decisions.length !== proposal.workItems.length
    || input.decision.decisions.some((decision, index) => decision.workItemId !== proposal.workItems[index]?.id
      || (decision.selection !== 'selected' && decision.selection !== 'unselected'))) {
    throw new Error('Goal proposal decisions must preserve proposal order and completeness.');
  }
  const objective = normalizeContractText(input.objective ?? proposal.objective).trim();
  if (!objective || objective.length > MAX_GOAL_OBJECTIVE_CHARACTERS) throw new Error('Goal objective is invalid.');
  if (objective !== proposal.objective) throw new Error('Goal proposal objective cannot change during adoption.');
  assertNoRuntimePath(objective);
  const accepted = proposal.workItems.filter((item) => selectedIds.has(item.id));
  for (const item of accepted) {
    if (item.dependsOn.some((dependency) => !selectedIds.has(dependency))) {
      throw new Error(`Goal work item ${item.id} has an unselected dependency.`);
    }
  }
  const workItems = accepted.map((item) => {
    assertNoRuntimePath(item.title);
    assertNoRuntimePath(item.detail);
    return {
      id: requireStableId(item.id),
      title: normalizeContractText(item.title),
      detail: normalizeContractText(item.detail),
      acceptanceCriterionIds: item.acceptanceCriteria.map((criterion) => requireStableId(criterion.id)),
      dependsOn: [...item.dependsOn]
    };
  });
  const acceptanceCriteria = accepted.flatMap((item) => item.acceptanceCriteria.map((criterion) => {
    assertNoRuntimePath(criterion.text);
    assertNoRuntimePath(criterion.evidenceRequirement);
    return {
      id: requireStableId(criterion.id),
      workItemId: item.id,
      text: normalizeContractText(criterion.text),
      type: criterion.type,
      evidenceRequirement: normalizeContractText(criterion.evidenceRequirement)
    };
  }));
  const amendments = (input.amendments ?? []).map((value) => normalizeContractText(value).trim()).filter(Boolean);
  for (const amendment of amendments) assertNoRuntimePath(amendment);
  const provisional: Omit<GoalContractV2, 'canonicalHash'> = {
    version: GOAL_CONTRACT_V2_VERSION,
    objective,
    amendments,
    proposalHash: proposal.proposalHash,
    workItems,
    acceptanceCriteria,
    includeScope: normalizeScopes(input.includeScope ?? proposal.includeScope),
    excludeScope: normalizeScopes(input.excludeScope ?? proposal.excludeScope),
    requiredValidations: normalizeValidations(input.requiredValidations ?? proposal.requiredValidations),
    completionPolicy: 'host_and_reviewer',
    budgets: {
      maxActiveExecutionMs: normalizeDuration(input.budgets.maxActiveExecutionMs),
      maxCost: normalizeCostLimit(input.budgets.maxCost),
      maxModelRequests: normalizeCount(input.budgets.maxModelRequests),
      maxCompletionReviews: normalizeCount(input.budgets.maxCompletionReviews)
    },
    resumePolicy: input.resumePolicy === 'auto_on_activation' ? 'auto_on_activation' : 'manual',
    main: normalizeRuntime(input.main),
    completionReviewer: normalizeReviewer(input.completionReviewer),
    requestProtocolVersion: GOAL_REQUEST_PROTOCOL_VERSION,
    toolSchemaVersion: GOAL_TOOL_SCHEMA_VERSION
  };
  return { ...provisional, canonicalHash: hashGoalContract(provisional) };
}

export function serializeGoalContract(
  contract: Omit<GoalContractV1, 'canonicalHash'> | GoalContractV1 | Omit<GoalContractV2, 'canonicalHash'> | GoalContractV2
): string {
  if (contract.version === GOAL_CONTRACT_V2_VERSION) return serializeGoalContractV2(contract);
  return JSON.stringify({
    version: GOAL_CONTRACT_VERSION,
    objective: normalizeContractText(contract.objective),
    amendments: contract.amendments.map((value) => normalizeContractText(value)),
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      text: normalizeContractText(criterion.text),
      type: criterion.type,
      evidenceRequirement: normalizeContractText(criterion.evidenceRequirement)
    })),
    includeScope: [...contract.includeScope],
    excludeScope: [...contract.excludeScope],
    requiredValidations: [...contract.requiredValidations],
    completionPolicy: 'host_and_reviewer',
    budgets: {
      maxActiveExecutionMs: contract.budgets.maxActiveExecutionMs,
      maxCost: contract.budgets.maxCost,
      maxModelRequests: contract.budgets.maxModelRequests,
      maxCompletionReviews: contract.budgets.maxCompletionReviews
    },
    resumePolicy: contract.resumePolicy,
    main: {
      sourceId: contract.main.sourceId,
      modelId: contract.main.modelId,
      provider: contract.main.provider,
      endpointHash: contract.main.endpointHash,
      runtimeProfile: contract.main.runtimeProfile
    },
    completionReviewer: {
      mode: contract.completionReviewer.mode,
      sourceId: contract.completionReviewer.sourceId,
      modelId: contract.completionReviewer.modelId,
      provider: contract.completionReviewer.provider,
      endpointHash: contract.completionReviewer.endpointHash
    },
    requestProtocolVersion: GOAL_REQUEST_PROTOCOL_VERSION,
    toolSchemaVersion: GOAL_TOOL_SCHEMA_VERSION
  });
}

/** Dedicated export makes compatibility tests explicit without changing the
 * original V1 byte sequence. */
export function serializeGoalContractV1(contract: Omit<GoalContractV1, 'canonicalHash'> | GoalContractV1): string {
  return serializeGoalContract(contract);
}

export function serializeGoalContractV2(contract: Omit<GoalContractV2, 'canonicalHash'> | GoalContractV2): string {
  return JSON.stringify({
    version: GOAL_CONTRACT_V2_VERSION,
    objective: normalizeContractText(contract.objective),
    amendments: contract.amendments.map((value) => normalizeContractText(value)),
    proposalHash: contract.proposalHash,
    workItems: contract.workItems.map((item) => ({
      id: item.id,
      title: normalizeContractText(item.title),
      detail: normalizeContractText(item.detail),
      acceptanceCriterionIds: [...item.acceptanceCriterionIds],
      dependsOn: [...item.dependsOn]
    })),
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      workItemId: criterion.workItemId,
      text: normalizeContractText(criterion.text),
      type: criterion.type,
      evidenceRequirement: normalizeContractText(criterion.evidenceRequirement)
    })),
    includeScope: [...contract.includeScope],
    excludeScope: [...contract.excludeScope],
    requiredValidations: [...contract.requiredValidations],
    completionPolicy: 'host_and_reviewer',
    budgets: {
      maxActiveExecutionMs: contract.budgets.maxActiveExecutionMs,
      maxCost: contract.budgets.maxCost,
      maxModelRequests: contract.budgets.maxModelRequests,
      maxCompletionReviews: contract.budgets.maxCompletionReviews
    },
    resumePolicy: contract.resumePolicy,
    main: {
      sourceId: contract.main.sourceId,
      modelId: contract.main.modelId,
      provider: contract.main.provider,
      endpointHash: contract.main.endpointHash,
      runtimeProfile: contract.main.runtimeProfile
    },
    completionReviewer: {
      mode: contract.completionReviewer.mode,
      sourceId: contract.completionReviewer.sourceId,
      modelId: contract.completionReviewer.modelId,
      provider: contract.completionReviewer.provider,
      endpointHash: contract.completionReviewer.endpointHash
    },
    requestProtocolVersion: GOAL_REQUEST_PROTOCOL_VERSION,
    toolSchemaVersion: GOAL_TOOL_SCHEMA_VERSION
  });
}

export function hashGoalContract(
  contract: Omit<GoalContractV1, 'canonicalHash'> | GoalContractV1 | Omit<GoalContractV2, 'canonicalHash'> | GoalContractV2
): string {
  return createHash('sha256').update(serializeGoalContract(contract), 'utf8').digest('hex');
}

/** Provider-safe contract projection. Host-only source ids, endpoint hashes and
 * runtime profiles remain in the canonical stored contract and never enter a
 * model request. */
export function serializeGoalProviderContract(contract: GoalContract): string {
  if (contract.version === GOAL_CONTRACT_V2_VERSION) return serializeGoalProviderContractV2(contract);
  return JSON.stringify({
    version: GOAL_CONTRACT_VERSION,
    canonicalHash: contract.canonicalHash,
    objective: normalizeContractText(contract.objective),
    amendments: contract.amendments.map((value) => normalizeContractText(value)),
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      text: normalizeContractText(criterion.text),
      type: criterion.type,
      evidenceRequirement: normalizeContractText(criterion.evidenceRequirement)
    })),
    includeScope: [...contract.includeScope],
    excludeScope: [...contract.excludeScope],
    requiredValidations: [...contract.requiredValidations],
    completionPolicy: contract.completionPolicy,
    budgets: {
      maxActiveExecutionMs: contract.budgets.maxActiveExecutionMs,
      maxCost: contract.budgets.maxCost,
      maxModelRequests: contract.budgets.maxModelRequests,
      maxCompletionReviews: contract.budgets.maxCompletionReviews
    },
    requestProtocolVersion: contract.requestProtocolVersion,
    toolSchemaVersion: contract.toolSchemaVersion
  });
}

export function serializeGoalProviderContractV2(contract: GoalContractV2): string {
  return JSON.stringify({
    version: GOAL_CONTRACT_V2_VERSION,
    canonicalHash: contract.canonicalHash,
    objective: normalizeContractText(contract.objective),
    amendments: contract.amendments.map((value) => normalizeContractText(value)),
    proposalHash: contract.proposalHash,
    workItems: contract.workItems.map((item) => ({
      id: item.id,
      title: normalizeContractText(item.title),
      detail: normalizeContractText(item.detail),
      acceptanceCriterionIds: [...item.acceptanceCriterionIds],
      dependsOn: [...item.dependsOn]
    })),
    acceptanceCriteria: contract.acceptanceCriteria.map((criterion) => ({
      id: criterion.id,
      workItemId: criterion.workItemId,
      text: normalizeContractText(criterion.text),
      type: criterion.type,
      evidenceRequirement: normalizeContractText(criterion.evidenceRequirement)
    })),
    includeScope: [...contract.includeScope],
    excludeScope: [...contract.excludeScope],
    requiredValidations: [...contract.requiredValidations],
    completionPolicy: contract.completionPolicy,
    budgets: {
      maxActiveExecutionMs: contract.budgets.maxActiveExecutionMs,
      maxCost: contract.budgets.maxCost,
      maxModelRequests: contract.budgets.maxModelRequests,
      maxCompletionReviews: contract.budgets.maxCompletionReviews
    },
    requestProtocolVersion: contract.requestProtocolVersion,
    toolSchemaVersion: contract.toolSchemaVersion
  });
}

/** Provider-visible v10 tail. It is deterministic and contains only the
 * canonical contract; local Goal ids, timestamps, paths, and lease data stay host-side. */
export function formatGoalProviderTail(contract: GoalContract): string {
  const tag = contract.version === GOAL_CONTRACT_V2_VERSION ? 'keepseek_goal_contract_v2' : 'keepseek_goal_contract_v1';
  return `\n\n<${tag}>\n${serializeGoalProviderContract(contract)}\n</${tag}>`;
}

export function verifyGoalContract(contract: GoalContract): boolean {
  if (contract.version !== GOAL_CONTRACT_VERSION && contract.version !== GOAL_CONTRACT_V2_VERSION) return false;
  return contract.requestProtocolVersion === GOAL_REQUEST_PROTOCOL_VERSION
    && contract.toolSchemaVersion === GOAL_TOOL_SCHEMA_VERSION
    && contract.canonicalHash === hashGoalContract(contract);
}

export function amendGoalContract(contract: GoalContract, instruction: string): GoalContract {
  const amendment = normalizeContractText(instruction).trim();
  if (!amendment) throw new Error('Goal amendment is required.');
  if (amendment.length > MAX_GOAL_OBJECTIVE_CHARACTERS) throw new Error('Goal amendment is too long.');
  if (contract.version === GOAL_CONTRACT_V2_VERSION) {
    const provisional: Omit<GoalContractV2, 'canonicalHash'> = {
      version: GOAL_CONTRACT_V2_VERSION,
      objective: contract.objective,
      amendments: [...contract.amendments, amendment],
      proposalHash: contract.proposalHash,
      workItems: structuredClone(contract.workItems),
      acceptanceCriteria: structuredClone(contract.acceptanceCriteria),
      includeScope: [...contract.includeScope],
      excludeScope: [...contract.excludeScope],
      requiredValidations: [...contract.requiredValidations],
      completionPolicy: contract.completionPolicy,
      budgets: { ...contract.budgets },
      resumePolicy: contract.resumePolicy,
      main: { ...contract.main },
      completionReviewer: { ...contract.completionReviewer },
      requestProtocolVersion: contract.requestProtocolVersion,
      toolSchemaVersion: contract.toolSchemaVersion
    };
    return { ...provisional, canonicalHash: hashGoalContract(provisional) };
  }
  return createGoalContract({
    objective: contract.objective,
    amendments: [...contract.amendments, amendment],
    acceptanceCriteria: contract.acceptanceCriteria,
    includeScope: contract.includeScope,
    excludeScope: contract.excludeScope,
    requiredValidations: contract.requiredValidations,
    budgets: contract.budgets,
    resumePolicy: contract.resumePolicy,
    main: contract.main,
    completionReviewer: contract.completionReviewer
  });
}

function normalizeCriterion(
  input: Partial<GoalAcceptanceCriterionV1> & Pick<GoalAcceptanceCriterionV1, 'text'>,
  index: number
): GoalAcceptanceCriterionV1 {
  const text = normalizeContractText(input.text).trim();
  if (!text) throw new Error('Goal acceptance criteria cannot be empty.');
  assertNoRuntimePath(text);
  assertNoRuntimePath(input.evidenceRequirement ?? '');
  const type = input.type === 'validation' || input.type === 'artifact' || input.type === 'manual'
    ? input.type : 'workspace_state';
  return {
    id: normalizeStableId(input.id) || `criterion-${index + 1}`,
    text,
    type,
    evidenceRequirement: normalizeContractText(input.evidenceRequirement ?? defaultEvidenceRequirement(type)).trim()
  };
}

function defaultEvidenceRequirement(type: GoalAcceptanceCriterionV1['type']): string {
  if (type === 'validation') return 'A required validation passed after the last relevant workspace mutation';
  if (type === 'artifact') return 'An artifact identity and content hash';
  if (type === 'manual') return 'Explicit user confirmation';
  return 'Current workspace-state evidence';
}

function normalizeScopes(values: string[]): string[] {
  return values.map((value) => normalizeContractText(value).trim()).filter(Boolean).map((value) => {
    const normalized = value.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/');
    if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)
      || normalized.split('/').some((part) => part === '..')) {
      throw new Error(`Goal scope must be workspace-relative: ${value}`);
    }
    return normalized;
  });
}

function normalizeValidations(values: SafeNpmScript[]): SafeNpmScript[] {
  const result: SafeNpmScript[] = [];
  for (const value of values) {
    if ((value === 'compile' || value === 'lint' || value === 'test') && !result.includes(value)) result.push(value);
  }
  return result;
}

function normalizeRuntime(value: GoalFrozenRuntimeV1): GoalFrozenRuntimeV1 {
  const result = {
    sourceId: value.sourceId.trim(), modelId: value.modelId.trim(), provider: value.provider.trim(),
    endpointHash: value.endpointHash.trim(), runtimeProfile: value.runtimeProfile.trim()
  };
  if (Object.values(result).some((item) => !item)) throw new Error('Goal main runtime is incomplete.');
  return result;
}

function normalizeReviewer(value: GoalCompletionReviewerV1): GoalCompletionReviewerV1 {
  const result = {
    mode: value.mode === 'fixed' ? 'fixed' as const : 'follow_subagent_model' as const,
    sourceId: value.sourceId.trim(), modelId: value.modelId.trim(), provider: value.provider.trim(), endpointHash: value.endpointHash.trim()
  };
  if (Object.values(result).some((item) => !item)) throw new Error('Goal completion reviewer is incomplete.');
  return result;
}

function normalizeStableId(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/iu.test(value.trim()) ? value.trim() : '';
}

function requireStableId(value: unknown): string {
  const normalized = normalizeStableId(value);
  if (!normalized) throw new Error('Goal work item or criterion id is invalid.');
  return normalized;
}

function normalizeCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

export function normalizeContractText(value: string): string {
  return value.replace(/\r\n?/gu, '\n');
}

function assertNoRuntimePath(value: string): void {
  if (/(?:^|[\s"'(<])(?:file:\/\/|\/(?:Users|home|private|tmp|var\/folders)\/|\/[A-Za-z0-9._-]+\/[A-Za-z0-9._~/-]+|[A-Za-z]:[\\/])/u.test(value)) {
    throw new Error('Goal contracts cannot contain local absolute paths; use a workspace-relative scope or file reference.');
  }
}
