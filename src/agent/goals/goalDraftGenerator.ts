import { createHash } from 'node:crypto';
import type { ModelSourceConfigSnapshot } from '../../accounts/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { AgentProgressEvent, KeepseekModel, SafeNpmScript, UsageEvent } from '../../shared/types';
import { isRecord } from '../../shared/errors';
import { requestApprovalReviewText } from '../../approvals/oneShotTextRequest';
import {
  MAX_GOAL_OBJECTIVE_CHARACTERS,
  MAX_GOAL_PROPOSAL_WORK_ITEMS,
  type GoalCriterionType,
  type GoalDraftAssessmentV1,
  type GoalProposalDecisionV1,
  type GoalProposalV1,
  type GoalProposalWorkItemV1
} from './goalTypes';

const MAX_WORK_ITEM_TITLE_CHARACTERS = 240;
const MAX_WORK_ITEM_DETAIL_CHARACTERS = 1_500;
const MAX_CRITERION_FIELD_CHARACTERS = 2_000;
const MAX_CRITERIA_PER_WORK_ITEM = 8;
const MAX_SCOPE_ITEMS = 100;
const MAX_SCOPE_CHARACTERS = 512;
const MAX_TOTAL_PROPOSAL_CHARACTERS = 64_000;
const GOAL_DRAFT_MAX_OUTPUT_TOKENS = 4_000;

/** Compatibility name retained for callers that previously consumed the
 * criteria-only draft. The V1 proposal now includes candidate work items. */
export type GoalDraftSuggestionV1 = GoalProposalV1;

export const GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT = `You assess and prepare one conservative KeepSeek Goal proposal from one user objective.
Return exactly one JSON object and no markdown or commentary:
{"version":1,"verdict":"ready|needs_normalization","reason":"...","originalObjective":"...","normalizedObjective":"...","proposal":{"version":1,"objective":"...","workItems":[{"id":"work-1","title":"...","detail":"...","acceptanceCriteria":[{"id":"criterion-1","text":"...","type":"validation|workspace_state|artifact|manual","evidenceRequirement":"..."}],"dependsOn":[]}],"includeScope":["workspace/relative/path"],"excludeScope":["workspace/relative/path"],"requiredValidations":["compile|lint|test"]}}
Rules:
- originalObjective must exactly equal the supplied objective.
- Use verdict ready when the objective is already clear and testable; then normalizedObjective must exactly equal originalObjective.
- Use needs_normalization only to make the requested delivery explicit or remove harmless conversational ambiguity. Give a concrete non-empty reason.
- Normalization must preserve constraints, references, safety boundaries, and scope. Never invent facts, product scope, or architecture decisions, and never silently remove a user restriction.
- proposal.objective must exactly equal normalizedObjective. Assessment, reason, and objective differences are review-only and never create a Goal.
- Normally produce 4-8 independently reviewable work items; never produce more than 20.
- Prefer no more than 12 work items. Titles are at most 240 characters, details at most 1500, criterion fields at most 2000, scopes at most 512, and total JSON at most 64000 characters.
- Work-item and criterion ids use lowercase letters, digits, and hyphens, start with a letter or digit, contain at most 64 characters, are unique, and are not UUIDs.
- Every work item has 1-8 independently verifiable acceptance criteria. Dependencies reference work-item ids from this proposal only.
- Evidence types must use the exact English enum values shown above.
- Evidence requirements must say what durable evidence proves the criterion.
- Scope paths must be workspace-relative; never output an absolute path, URI, credential, timestamp, or runtime identifier.
- Use only validations listed as available. Do not invent commands.
- Do not add work that is not required by the objective.
- The proposal is only a review artifact; it does not create a Goal, approve side effects, modify files, or run commands.`;

export class GoalDraftGeneratorService {
  public constructor(
    private readonly requestText: typeof requestApprovalReviewText = requestApprovalReviewText
  ) {}

  public async generate(input: {
    objective: string;
    availableValidations: readonly SafeNpmScript[];
    model: KeepseekModel;
    sourceConfig: ModelSourceConfigSnapshot;
    language: KeepseekLanguage;
    signal?: AbortSignal;
    onUsage?: (event: UsageEvent) => void;
    onProgress?: (event: AgentProgressEvent) => void;
  }): Promise<GoalDraftAssessmentV1> {
    const objective = normalizeText(input.objective).trim();
    if (!objective) throw new Error('Goal objective is required.');
    if (objective.length > MAX_GOAL_OBJECTIVE_CHARACTERS) throw new Error('Goal objective is too long.');
    const available = input.availableValidations.filter(isSafeValidation);
    const raw = await this.requestText({
      model: input.model,
      sourceConfig: input.sourceConfig,
      systemPrompt: GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({ version: 1, objective, availableValidations: available }),
      language: input.language,
      signal: input.signal,
      maxOutputTokens: GOAL_DRAFT_MAX_OUTPUT_TOKENS,
      onDelta: input.onProgress,
      onUsage: (event) => input.onUsage?.({ ...event, source: 'subagent' })
    });
    return parseGoalDraftAssessment(raw, available, objective);
  }
}

export function parseGoalDraftAssessment(
  raw: string,
  availableValidations: readonly SafeNpmScript[],
  expectedOriginalObjective: string
): GoalDraftAssessmentV1 {
  const parsed = parseJsonObject(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !hasExactKeys(parsed, [
    'version', 'verdict', 'reason', 'originalObjective', 'normalizedObjective', 'proposal'
  ]) || (parsed.verdict !== 'ready' && parsed.verdict !== 'needs_normalization') || !isRecord(parsed.proposal)) {
    throw new Error('Goal draft generator returned an invalid assessment schema.');
  }
  const expected = normalizeText(expectedOriginalObjective).trim();
  const originalObjective = boundedText(parsed.originalObjective, MAX_GOAL_OBJECTIVE_CHARACTERS, 'original objective');
  if (originalObjective !== expected) throw new Error('Goal draft generator changed the original objective.');
  const normalizedObjective = boundedText(parsed.normalizedObjective, MAX_GOAL_OBJECTIVE_CHARACTERS, 'normalized objective');
  const reason = boundedText(parsed.reason, MAX_WORK_ITEM_DETAIL_CHARACTERS, 'assessment reason');
  assertSafeProposalText(originalObjective);
  assertSafeGeneratedText(normalizedObjective);
  assertSafeGeneratedText(reason);
  if (parsed.verdict === 'ready' && normalizedObjective !== originalObjective) {
    throw new Error('A ready Goal assessment must preserve the objective exactly.');
  }
  if (parsed.verdict === 'needs_normalization' && normalizedObjective === originalObjective) {
    throw new Error('A normalized Goal assessment must contain a changed objective.');
  }
  const proposal = parseGoalDraftSuggestion(JSON.stringify(parsed.proposal), availableValidations, normalizedObjective);
  return {
    version: 1,
    verdict: parsed.verdict,
    reason,
    originalObjective,
    normalizedObjective,
    proposal
  };
}

export function parseGoalDraftSuggestion(
  raw: string,
  availableValidations: readonly SafeNpmScript[],
  expectedObjective?: string
): GoalProposalV1 {
  const parsed = parseJsonObject(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !hasExactKeys(parsed, [
    'version', 'objective', 'workItems', 'includeScope', 'excludeScope', 'requiredValidations'
  ]) || !Array.isArray(parsed.workItems) || !Array.isArray(parsed.includeScope)
    || !Array.isArray(parsed.excludeScope) || !Array.isArray(parsed.requiredValidations)) {
    throw new Error('Goal draft generator returned an invalid proposal schema.');
  }
  const objective = boundedText(parsed.objective, MAX_GOAL_OBJECTIVE_CHARACTERS, 'objective');
  if (!objective || (expectedObjective !== undefined && objective !== normalizeText(expectedObjective).trim())) {
    throw new Error('Goal draft generator changed or omitted the objective.');
  }
  assertSafeProposalText(objective);
  if (parsed.workItems.length < 1 || parsed.workItems.length > MAX_GOAL_PROPOSAL_WORK_ITEMS) {
    throw new Error(`Goal draft generator must return 1-${MAX_GOAL_PROPOSAL_WORK_ITEMS} work items.`);
  }

  const seenWorkItemIds = new Set<string>();
  const seenCriterionIds = new Set<string>();
  const workItems = parsed.workItems.map((value) => parseWorkItem(value, seenWorkItemIds, seenCriterionIds));
  for (const workItem of workItems) {
    for (const dependency of workItem.dependsOn) {
      if (dependency === workItem.id || !seenWorkItemIds.has(dependency)) {
        throw new Error(`Goal draft generator returned an invalid dependency: ${dependency}.`);
      }
    }
  }
  assertAcyclicDependencies(workItems);
  const allowed = new Set(availableValidations.filter(isSafeValidation));
  const requiredValidations = strictStringArray(parsed.requiredValidations, 'requiredValidations', 3)
    .map((value) => {
      if (!isSafeValidation(value) || !allowed.has(value)) {
        throw new Error(`Goal draft generator returned an unavailable validation: ${value}.`);
      }
      return value;
    });
  assertUnique(requiredValidations, 'validation');
  const proposal = withoutProposalHash({
    version: 1,
    objective,
    workItems,
    includeScope: readScopes(parsed.includeScope),
    excludeScope: readScopes(parsed.excludeScope),
    requiredValidations
  });
  const serialized = JSON.stringify(proposal);
  if (serialized.length > MAX_TOTAL_PROPOSAL_CHARACTERS) {
    throw new Error(`Goal draft generator proposal exceeds ${MAX_TOTAL_PROPOSAL_CHARACTERS} characters.`);
  }
  return { ...proposal, proposalHash: hashSerialized(serialized) };
}

export function createConservativeGoalProposal(input: {
  objective: string;
  language: KeepseekLanguage;
  validation?: SafeNpmScript;
}): GoalProposalV1 {
  const objective = normalizeText(input.objective).trim();
  if (!objective) throw new Error('Goal objective is required.');
  if (objective.length > MAX_GOAL_OBJECTIVE_CHARACTERS) throw new Error('Goal objective is too long.');
  assertSafeProposalText(objective);
  const validation = input.validation;
  const proposal = withoutProposalHash({
    version: 1,
    objective,
    workItems: [{
      id: 'work-1',
      title: input.language === 'en' ? 'Deliver and verify the requested outcome' : '交付并验证请求结果',
      detail: input.language === 'en'
        ? 'Complete the reviewed objective and preserve all existing safety boundaries.'
        : '完成已审阅的目标，并保持现有安全边界。',
      acceptanceCriteria: [{
        id: 'criterion-1',
        text: validation
          ? (input.language === 'en' ? `${validation} passes after the last workspace change.` : `最后一次工作区修改后 ${validation} 验证通过。`)
          : (input.language === 'en' ? 'The requested outcome is implemented and verified.' : '请求的结果已经实现并验证。'),
        type: validation ? 'validation' : 'workspace_state',
        evidenceRequirement: validation
          ? (input.language === 'en' ? 'A current controlled validation result.' : '当前受控验证结果。')
          : (input.language === 'en' ? 'Current workspace state and verification evidence.' : '当前工作区状态和验证证据。')
      }],
      dependsOn: []
    }],
    includeScope: [],
    excludeScope: [],
    requiredValidations: validation ? [validation] : []
  });
  return { ...proposal, proposalHash: hashSerialized(JSON.stringify(proposal)) };
}

export function serializeGoalProposal(proposal: GoalProposalV1): string {
  const normalized = withoutProposalHash({
    version: 1,
    objective: normalizeText(proposal.objective),
    workItems: proposal.workItems.map((item) => ({
      id: item.id,
      title: normalizeText(item.title),
      detail: normalizeText(item.detail),
      acceptanceCriteria: item.acceptanceCriteria.map((criterion) => ({
        id: criterion.id,
        text: normalizeText(criterion.text),
        type: criterion.type,
        evidenceRequirement: normalizeText(criterion.evidenceRequirement)
      })),
      dependsOn: [...item.dependsOn]
    })),
    includeScope: [...proposal.includeScope],
    excludeScope: [...proposal.excludeScope],
    requiredValidations: [...proposal.requiredValidations]
  });
  return JSON.stringify(normalized);
}

export function hashGoalProposal(proposal: GoalProposalV1): string {
  return hashSerialized(serializeGoalProposal(proposal));
}

export function verifyGoalProposal(proposal: GoalProposalV1): boolean {
  try {
    if (proposal.version !== 1 || proposal.proposalHash !== hashGoalProposal(proposal)) return false;
    const reparsed = parseGoalDraftSuggestion(
      serializeGoalProposal(proposal), proposal.requiredValidations, proposal.objective
    );
    return reparsed.proposalHash === proposal.proposalHash;
  } catch {
    return false;
  }
}

export function createGoalProposalDecision(
  proposal: GoalProposalV1,
  selectedWorkItemIds: readonly string[],
  decidedAt = new Date().toISOString()
): GoalProposalDecisionV1 {
  if (!verifyGoalProposal(proposal)) throw new Error('Goal proposal hash is invalid.');
  const selected = new Set(selectedWorkItemIds);
  if (!selected.size) throw new Error('At least one Goal work item must be selected.');
  const known = new Set(proposal.workItems.map((item) => item.id));
  if ([...selected].some((id) => !known.has(id))) throw new Error('Goal selection contains an unknown work item.');
  for (const item of proposal.workItems) {
    if (selected.has(item.id) && item.dependsOn.some((dependency) => !selected.has(dependency))) {
      throw new Error(`Selected Goal work item ${item.id} requires ${item.dependsOn.find((dependency) => !selected.has(dependency))}.`);
    }
  }
  return {
    version: 1,
    proposal: structuredClone(proposal),
    proposalHash: proposal.proposalHash,
    decisions: proposal.workItems.map((item) => ({
      workItemId: item.id,
      selection: selected.has(item.id) ? 'selected' : 'unselected'
    })),
    decidedAt
  };
}

function parseWorkItem(value: unknown, seenWorkItemIds: Set<string>, seenCriterionIds: Set<string>): GoalProposalWorkItemV1 {
  if (!isRecord(value) || !hasExactKeys(value, ['id', 'title', 'detail', 'acceptanceCriteria', 'dependsOn'])
    || !Array.isArray(value.acceptanceCriteria) || !Array.isArray(value.dependsOn)) {
    throw new Error('Goal draft generator returned an invalid work item.');
  }
  const id = stableId(value.id, 'work item');
  if (seenWorkItemIds.has(id)) throw new Error(`Goal draft generator returned duplicate work item id: ${id}.`);
  seenWorkItemIds.add(id);
  const title = boundedText(value.title, MAX_WORK_ITEM_TITLE_CHARACTERS, 'work item title');
  const detail = boundedText(value.detail, MAX_WORK_ITEM_DETAIL_CHARACTERS, 'work item detail');
  assertSafeGeneratedText(title);
  assertSafeGeneratedText(detail);
  if (value.acceptanceCriteria.length < 1 || value.acceptanceCriteria.length > MAX_CRITERIA_PER_WORK_ITEM) {
    throw new Error(`Goal work items require 1-${MAX_CRITERIA_PER_WORK_ITEM} acceptance criteria.`);
  }
  const acceptanceCriteria = value.acceptanceCriteria.map((criterion) => {
    if (!isRecord(criterion) || !hasExactKeys(criterion, ['id', 'text', 'type', 'evidenceRequirement'])) {
      throw new Error('Goal draft generator returned an invalid criterion.');
    }
    const criterionId = stableId(criterion.id, 'criterion');
    if (seenCriterionIds.has(criterionId)) throw new Error(`Goal draft generator returned duplicate criterion id: ${criterionId}.`);
    seenCriterionIds.add(criterionId);
    const text = boundedText(criterion.text, MAX_CRITERION_FIELD_CHARACTERS, 'criterion text');
    const evidenceRequirement = boundedText(criterion.evidenceRequirement, MAX_CRITERION_FIELD_CHARACTERS, 'evidence requirement');
    if (!isCriterionType(criterion.type)) throw new Error('Goal draft generator returned an invalid criterion type.');
    assertSafeGeneratedText(text);
    assertSafeGeneratedText(evidenceRequirement);
    return { id: criterionId, text, type: criterion.type, evidenceRequirement };
  });
  const dependsOn = strictStringArray(value.dependsOn, 'dependsOn', MAX_GOAL_PROPOSAL_WORK_ITEMS)
    .map((dependency) => stableId(dependency, 'dependency'));
  assertUnique(dependsOn, 'dependency');
  return { id, title, detail, acceptanceCriteria, dependsOn };
}

function parseJsonObject(raw: string): unknown {
  const text = raw.trim();
  try { return JSON.parse(text); } catch {
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(text)?.[1];
    if (!fenced) throw new Error('Goal draft generator did not return valid JSON.');
    try { return JSON.parse(fenced); } catch { throw new Error('Goal draft generator did not return valid JSON.'); }
  }
}

function readScopes(value: unknown): string[] {
  const scopes = strictStringArray(value, 'scope', MAX_SCOPE_ITEMS, MAX_SCOPE_CHARACTERS)
    .map((item) => item.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/'));
  for (const scope of scopes) {
    if (!isWorkspaceRelativeScope(scope)) throw new Error(`Goal draft generator returned an unsafe scope: ${scope}.`);
  }
  assertUnique(scopes, 'scope');
  return scopes;
}

function strictStringArray(value: unknown, field: string, maxItems: number, maxCharacters = 128): string[] {
  if (!Array.isArray(value) || value.length > maxItems || value.some((item) =>
    typeof item !== 'string' || normalizeText(item).trim().length > maxCharacters)) {
    throw new Error(`Goal draft generator returned an invalid ${field} list.`);
  }
  return value.map((item) => normalizeText(item as string).trim());
}

function boundedText(value: unknown, limit: number, field: string): string {
  if (typeof value !== 'string') throw new Error(`Goal draft generator returned an invalid ${field}.`);
  const text = normalizeText(value).trim();
  if (!text || text.length > limit) throw new Error(`Goal draft generator returned an out-of-bounds ${field}.`);
  return text;
}

function stableId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(value)
    || /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error(`Goal draft generator returned an invalid ${field} id.`);
  }
  return value;
}

function isWorkspaceRelativeScope(value: string): boolean {
  return Boolean(value) && !value.startsWith('/') && !/^[A-Za-z]:\//u.test(value)
    && !value.split('/').some((part) => part === '..') && !value.includes('://');
}

function assertSafeProposalText(value: string): void {
  if (/(?:^|[\s"'(<])(?:[a-z][a-z0-9+.-]*:\/\/|\/(?:Users|home|private|tmp|var\/folders)\/|\/[A-Za-z0-9._-]+\/[A-Za-z0-9._~/-]+|[A-Za-z]:[\\/])/iu.test(value)) {
    throw new Error('Goal draft generator returned an absolute path or URI.');
  }
  if (/(?:api[_ -]?key|authorization|bearer|access[_ -]?token|password|client[_ -]?secret)\s*[:=]/iu.test(value)) {
    throw new Error('Goal draft generator returned credential-like content.');
  }
}

function assertSafeGeneratedText(value: string): void {
  assertSafeProposalText(value);
  if (/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})\b/u.test(value)
    || /\b[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\b/iu.test(value)) {
    throw new Error('Goal draft generator returned a timestamp or runtime identifier.');
  }
}

function isCriterionType(value: unknown): value is GoalCriterionType {
  return value === 'validation' || value === 'workspace_state' || value === 'artifact' || value === 'manual';
}

function isSafeValidation(value: unknown): value is SafeNpmScript {
  return value === 'compile' || value === 'lint' || value === 'test';
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Goal draft generator returned a duplicate ${label}.`);
}

function assertAcyclicDependencies(workItems: readonly GoalProposalWorkItemV1[]): void {
  const dependencies = new Map(workItems.map((item) => [item.id, item.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('Goal draft generator returned a cyclic work-item dependency.');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const item of workItems) visit(item.id);
}

function normalizeText(value: string): string { return value.replace(/\r\n?/gu, '\n'); }

function withoutProposalHash(value: Omit<GoalProposalV1, 'proposalHash'>): Omit<GoalProposalV1, 'proposalHash'> { return value; }

function hashSerialized(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
