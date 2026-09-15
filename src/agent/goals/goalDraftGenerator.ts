import type { ModelSourceConfigSnapshot } from '../../accounts/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { KeepseekModel, SafeNpmScript, UsageEvent } from '../../shared/types';
import { isRecord } from '../../shared/errors';
import { requestApprovalReviewText } from '../../approvals/oneShotTextRequest';
import type { GoalCriterionType } from './goalTypes';

const MAX_GENERATED_CRITERIA = 6;
const MAX_FIELD_CHARACTERS = 2_000;
const GOAL_DRAFT_MAX_OUTPUT_TOKENS = 1_200;

export interface GoalDraftSuggestionV1 {
  version: 1;
  acceptanceCriteria: Array<{
    text: string;
    type: GoalCriterionType;
    evidenceRequirement: string;
  }>;
  includeScope: string[];
  excludeScope: string[];
  requiredValidations: SafeNpmScript[];
}

export const GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT = `You prepare a conservative KeepSeek Goal form from one user objective.
Return exactly one JSON object and no markdown or commentary:
{"version":1,"acceptanceCriteria":[{"text":"...","type":"validation|workspace_state|artifact|manual","evidenceRequirement":"..."}],"includeScope":["workspace/relative/path"],"excludeScope":["workspace/relative/path"],"requiredValidations":["compile|lint|test"]}
Rules:
- Produce 1-6 independently verifiable acceptance criteria in the user's language.
- Evidence types must use the exact English enum values shown above.
- Evidence requirements must say what durable evidence proves the criterion.
- Scope paths must be workspace-relative; never output an absolute path, URI, credential, timestamp, or runtime identifier.
- Use only validations listed as available. Do not invent commands.
- Do not add work that is not required by the objective.
- The result only pre-fills a form; it does not authorize or perform any action.`;

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
  }): Promise<GoalDraftSuggestionV1> {
    const objective = input.objective.trim();
    if (!objective) throw new Error('Goal objective is required.');
    const available = input.availableValidations.filter(isSafeValidation);
    const raw = await this.requestText({
      model: input.model,
      sourceConfig: input.sourceConfig,
      systemPrompt: GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT,
      userPrompt: JSON.stringify({ version: 1, objective, availableValidations: available }),
      language: input.language,
      signal: input.signal,
      maxOutputTokens: GOAL_DRAFT_MAX_OUTPUT_TOKENS,
      onUsage: (event) => input.onUsage?.({ ...event, source: 'subagent' })
    });
    return parseGoalDraftSuggestion(raw, available);
  }
}

export function parseGoalDraftSuggestion(
  raw: string,
  availableValidations: readonly SafeNpmScript[]
): GoalDraftSuggestionV1 {
  const parsed = parseJsonObject(raw);
  if (!isRecord(parsed) || parsed.version !== 1 || !hasExactKeys(parsed, [
    'version', 'acceptanceCriteria', 'includeScope', 'excludeScope', 'requiredValidations'
  ]) || !Array.isArray(parsed.acceptanceCriteria) || !Array.isArray(parsed.includeScope)
    || !Array.isArray(parsed.excludeScope) || !Array.isArray(parsed.requiredValidations)) {
    throw new Error('Goal draft generator returned an invalid schema.');
  }
  if (parsed.acceptanceCriteria.length < 1 || parsed.acceptanceCriteria.length > MAX_GENERATED_CRITERIA) {
    throw new Error(`Goal draft generator must return 1-${MAX_GENERATED_CRITERIA} acceptance criteria.`);
  }
  const acceptanceCriteria = parsed.acceptanceCriteria.map((value) => {
    if (!isRecord(value) || !hasExactKeys(value, ['text', 'type', 'evidenceRequirement'])) {
      throw new Error('Goal draft generator returned an invalid criterion.');
    }
    const text = boundedText(value.text);
    const evidenceRequirement = boundedText(value.evidenceRequirement);
    const type = value.type;
    if (!text || !evidenceRequirement || !isCriterionType(type)) {
      throw new Error('Goal draft generator returned an incomplete criterion.');
    }
    return { text, type, evidenceRequirement };
  });
  const allowed = new Set(availableValidations.filter(isSafeValidation));
  const requiredValidations = readStringArray(parsed.requiredValidations)
    .filter(isSafeValidation)
    .filter((value, index, values) => allowed.has(value) && values.indexOf(value) === index);
  return {
    version: 1,
    acceptanceCriteria,
    includeScope: readScopes(parsed.includeScope),
    excludeScope: readScopes(parsed.excludeScope),
    requiredValidations
  };
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
  return readStringArray(value).map((item) => item.includes('://') ? '' : item.replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/'))
    .filter((item, index, values) => isWorkspaceRelativeScope(item) && values.indexOf(item) === index);
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => typeof item === 'string' ? boundedText(item) : '').filter(Boolean)
    : [];
}

function boundedText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\r\n?/gu, '\n').trim().slice(0, MAX_FIELD_CHARACTERS) : '';
}

function isWorkspaceRelativeScope(value: string): boolean {
  return Boolean(value) && !value.startsWith('/') && !/^[A-Za-z]:\//u.test(value)
    && !value.split('/').some((part) => part === '..') && !value.includes('://');
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
