import { createHash } from 'node:crypto';
import type { SafeNpmScript } from '../../shared/types';
import { normalizeCostLimit, normalizeDuration } from '../executionPolicy';
import {
  GOAL_CONTRACT_VERSION,
  GOAL_REQUEST_PROTOCOL_VERSION,
  GOAL_TOOL_SCHEMA_VERSION,
  MAX_GOAL_OBJECTIVE_CHARACTERS,
  type GoalAcceptanceCriterionV1,
  type GoalBudgetV1,
  type GoalCompletionReviewerV1,
  type GoalContractV1,
  type GoalFrozenRuntimeV1
} from './goalTypes';

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

export function serializeGoalContract(contract: Omit<GoalContractV1, 'canonicalHash'> | GoalContractV1): string {
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

export function hashGoalContract(contract: Omit<GoalContractV1, 'canonicalHash'> | GoalContractV1): string {
  return createHash('sha256').update(serializeGoalContract(contract), 'utf8').digest('hex');
}

/** Provider-safe contract projection. Host-only source ids, endpoint hashes and
 * runtime profiles remain in the canonical stored contract and never enter a
 * model request. */
export function serializeGoalProviderContract(contract: GoalContractV1): string {
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

/** Provider-visible v10 tail. It is deterministic and contains only the
 * canonical contract; local Goal ids, timestamps, paths, and lease data stay host-side. */
export function formatGoalProviderTail(contract: GoalContractV1): string {
  return `\n\n<keepseek_goal_contract_v1>\n${serializeGoalProviderContract(contract)}\n</keepseek_goal_contract_v1>`;
}

export function verifyGoalContract(contract: GoalContractV1): boolean {
  return contract.version === GOAL_CONTRACT_VERSION
    && contract.requestProtocolVersion === GOAL_REQUEST_PROTOCOL_VERSION
    && contract.toolSchemaVersion === GOAL_TOOL_SCHEMA_VERSION
    && contract.canonicalHash === hashGoalContract(contract);
}

export function amendGoalContract(contract: GoalContractV1, instruction: string): GoalContractV1 {
  const amendment = normalizeContractText(instruction).trim();
  if (!amendment) throw new Error('Goal amendment is required.');
  if (amendment.length > MAX_GOAL_OBJECTIVE_CHARACTERS) throw new Error('Goal amendment is too long.');
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
