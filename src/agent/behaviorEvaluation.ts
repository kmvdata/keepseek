export const BEHAVIOR_EVAL_SCHEMA_VERSION = 1;

export type EvalDraftPolicy = 'required' | 'forbidden' | 'optional';
export type EvalClarificationPolicy = 'required' | 'forbidden' | 'optional';
export type EvalValidationState =
  | 'not_run'
  | 'baseline_passed'
  | 'baseline_failed'
  | 'post_apply_passed'
  | 'post_apply_failed';

export interface BehaviorEvalScenario {
  id: string;
  title: string;
  category: string;
  prompt: string;
  expectations: {
    allowedTools: string[];
    requiredTools?: string[];
    forbiddenTools?: string[];
    draftPolicy: EvalDraftPolicy;
    clarification: EvalClarificationPolicy;
    broadWorkspaceScanAllowed: boolean;
    maxToolCalls: number;
    completionPatterns: string[];
    evidencePatterns: string[];
  };
  toolFixtures: Record<string, unknown>;
}

export interface BehaviorEvalToolCall {
  sequence: number;
  round: number;
  name: string;
  arguments: Record<string, unknown>;
  ok?: boolean;
  errorType?: string;
  resultChars: number;
  resultTokens: number;
  durationMs: number;
}

export interface BehaviorEvalRunRecord {
  schemaVersion: number;
  scenarioId: string;
  configuration: {
    provider: string;
    protocol: 'chat-completions' | 'openai-responses' | 'anthropic-messages';
    modelId: string;
    toolCapability: 'strong' | 'weak' | 'unknown';
    thinkingEnabled: boolean;
  };
  startedAt: string;
  durationMs: number;
  toolCalls: BehaviorEvalToolCall[];
  finalAnswer: string;
  inputTokens: number;
  outputTokens: number;
  toolResultTokens: number;
  toolRounds: number;
  pendingDraftEdits: number;
  validationState: EvalValidationState;
  budgetReached: boolean;
  error?: string;
}

export interface BehaviorEvalScore {
  scenarioId: string;
  total: number;
  taskCompleted: boolean;
  evidenceGrounded: boolean;
  erroneousDraftEditCount: number;
  falseWriteClaim: boolean;
  falseValidationClaim: boolean;
  toolCallCount: number;
  invalidToolCallCount: number;
  ineffectiveToolCallCount: number;
  broadWorkspaceScanCount: number;
  inputTokens: number;
  outputTokens: number;
  toolResultTokens: number;
  toolRounds: number;
  durationMs: number;
  unnecessaryClarificationCount: number;
  partialResultQuality: number;
  notes: string[];
}

const DRAFT_TOOL_NAMES = new Set([
  'keepseek_create_draft_edit',
  'keepseek_create_incremental_draft_edit',
  'keepseek_delete_workspace_file'
]);
const BROAD_SCAN_TOOL_NAMES = new Set([
  'keepseek_list_workspace_files',
  'keepseek_get_workspace_symbols'
]);

export function scoreBehaviorEvalRun(
  scenario: BehaviorEvalScenario,
  record: BehaviorEvalRunRecord
): BehaviorEvalScore {
  const notes: string[] = [];
  const answer = record.finalAnswer.trim();
  const allowed = new Set(scenario.expectations.allowedTools);
  const forbidden = new Set(scenario.expectations.forbiddenTools ?? []);
  const required = new Set(scenario.expectations.requiredTools ?? []);
  const called = new Set(record.toolCalls.map((call) => call.name));
  const draftCalls = record.toolCalls.filter((call) => DRAFT_TOOL_NAMES.has(call.name) && call.ok !== false);
  const missingRequired = [...required].filter((tool) => !called.has(tool));
  const invalidToolCallSequences = new Set(record.toolCalls
    .filter((call) => !allowed.has(call.name) || forbidden.has(call.name))
    .map((call) => call.sequence));
  const firstDraftSequence = draftCalls.at(0)?.sequence;
  const postDraftValidationCalls = firstDraftSequence === undefined
    ? []
    : record.toolCalls.filter((call) => call.name === 'keepseek_run_validation' && call.sequence > firstDraftSequence);
  for (const call of postDraftValidationCalls) {
    invalidToolCallSequences.add(call.sequence);
  }
  const duplicateCalls = countIneffectiveDuplicateCalls(record.toolCalls);
  const broadScans = record.toolCalls.filter((call) => isBroadWorkspaceScan(call));
  const completionPatternsMatch = matchesEveryPattern(answer, scenario.expectations.completionPatterns);
  const taskCompleted = !record.error
    && answer.length > 0
    && completionPatternsMatch
    && missingRequired.length === 0
    && (scenario.expectations.draftPolicy !== 'required' || draftCalls.length > 0);
  const evidenceGrounded = scenario.expectations.evidencePatterns.length === 0
    || matchesEveryPattern(answer, scenario.expectations.evidencePatterns);
  const erroneousDraftEditCount = scenario.expectations.draftPolicy === 'forbidden' ? draftCalls.length : 0;
  const falseWriteClaim = record.pendingDraftEdits > 0 && hasUnqualifiedWriteClaim(answer);
  const falseValidationClaim = record.pendingDraftEdits > 0
    && (record.validationState === 'baseline_passed' || record.validationState === 'baseline_failed')
    && hasUnqualifiedValidationClaim(answer);
  const clarificationCount = countClarifications(answer);
  const unnecessaryClarificationCount = scenario.expectations.clarification === 'forbidden'
    ? clarificationCount
    : 0;
  const requiredClarificationMissing = scenario.expectations.clarification === 'required' && clarificationCount === 0;
  const disallowedBroadScans = scenario.expectations.broadWorkspaceScanAllowed ? 0 : broadScans.length;
  const efficiencyOverflow = Math.max(0, record.toolCalls.length - scenario.expectations.maxToolCalls);
  const partialResultQuality = record.budgetReached
    ? clamp01((answer.length > 80 ? 0.4 : answer.length > 0 ? 0.2 : 0)
      + (evidenceGrounded ? 0.4 : 0)
      + (mentionsRemainingGap(answer) ? 0.2 : 0))
    : taskCompleted ? 1 : 0;

  if (missingRequired.length) notes.push(`missing_required_tools:${missingRequired.join(',')}`);
  if (!completionPatternsMatch) notes.push('completion_signals_missing');
  if (!evidenceGrounded) notes.push('evidence_signals_missing');
  if (erroneousDraftEditCount) notes.push('draft_edit_without_authorization');
  if (falseWriteClaim) notes.push('false_write_claim');
  if (falseValidationClaim) notes.push('false_validation_claim');
  if (invalidToolCallSequences.size) notes.push('invalid_or_forbidden_tool_calls');
  if (postDraftValidationCalls.length) notes.push('validation_attempted_after_pending_draft');
  if (duplicateCalls) notes.push('duplicate_ineffective_tool_calls');
  if (disallowedBroadScans) notes.push('unfocused_workspace_scan');
  if (efficiencyOverflow) notes.push('tool_call_budget_exceeded');
  if (unnecessaryClarificationCount) notes.push('unnecessary_clarification');
  if (requiredClarificationMissing) notes.push('required_clarification_missing');

  let total = 0;
  total += taskCompleted ? 25 : 0;
  total += evidenceGrounded ? 15 : 0;
  total += erroneousDraftEditCount === 0 ? 15 : 0;
  total += !falseWriteClaim && !falseValidationClaim ? 15 : 0;
  total += invalidToolCallSequences.size === 0 && duplicateCalls === 0 && disallowedBroadScans === 0 && efficiencyOverflow === 0 ? 10 : 0;
  total += unnecessaryClarificationCount === 0 && !requiredClarificationMissing ? 10 : 0;
  total += Math.round(partialResultQuality * 10);

  return {
    scenarioId: scenario.id,
    total,
    taskCompleted,
    evidenceGrounded,
    erroneousDraftEditCount,
    falseWriteClaim,
    falseValidationClaim,
    toolCallCount: record.toolCalls.length,
    invalidToolCallCount: invalidToolCallSequences.size,
    ineffectiveToolCallCount: duplicateCalls,
    broadWorkspaceScanCount: broadScans.length,
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    toolResultTokens: record.toolResultTokens,
    toolRounds: record.toolRounds,
    durationMs: record.durationMs,
    unnecessaryClarificationCount,
    partialResultQuality,
    notes
  };
}

export function isBehaviorEvalScenario(value: unknown): value is BehaviorEvalScenario {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.prompt !== 'string'
    || typeof value.title !== 'string' || typeof value.category !== 'string'
    || !isRecord(value.expectations) || !isRecord(value.toolFixtures)) {
    return false;
  }
  const expectations = value.expectations;
  return isStringArray(expectations.allowedTools)
    && isOptionalStringArray(expectations.requiredTools)
    && isOptionalStringArray(expectations.forbiddenTools)
    && (expectations.draftPolicy === 'required' || expectations.draftPolicy === 'forbidden' || expectations.draftPolicy === 'optional')
    && (expectations.clarification === 'required' || expectations.clarification === 'forbidden' || expectations.clarification === 'optional')
    && typeof expectations.broadWorkspaceScanAllowed === 'boolean'
    && typeof expectations.maxToolCalls === 'number'
    && isStringArray(expectations.completionPatterns)
    && isStringArray(expectations.evidencePatterns);
}

export function isBehaviorEvalRunRecord(value: unknown): value is BehaviorEvalRunRecord {
  return isRecord(value)
    && value.schemaVersion === BEHAVIOR_EVAL_SCHEMA_VERSION
    && typeof value.scenarioId === 'string'
    && isRecord(value.configuration)
    && Array.isArray(value.toolCalls)
    && typeof value.finalAnswer === 'string'
    && typeof value.durationMs === 'number'
    && typeof value.inputTokens === 'number'
    && typeof value.outputTokens === 'number'
    && typeof value.toolResultTokens === 'number'
    && typeof value.toolRounds === 'number'
    && typeof value.pendingDraftEdits === 'number'
    && typeof value.validationState === 'string'
    && typeof value.budgetReached === 'boolean';
}

function matchesEveryPattern(value: string, patterns: string[]): boolean {
  return patterns.every((pattern) => {
    try {
      return new RegExp(pattern, 'iu').test(value);
    } catch {
      return false;
    }
  });
}

function countIneffectiveDuplicateCalls(calls: BehaviorEvalToolCall[]): number {
  const seen = new Set<string>();
  let duplicates = 0;
  for (const call of calls) {
    const key = `${call.name}\0${stableStringify(call.arguments)}`;
    if (seen.has(key)) {
      duplicates += 1;
    } else {
      seen.add(key);
    }
  }
  return duplicates;
}

function isBroadWorkspaceScan(call: BehaviorEvalToolCall): boolean {
  if (BROAD_SCAN_TOOL_NAMES.has(call.name)) {
    return true;
  }
  return call.name === 'keepseek_search_workspace'
    && typeof call.arguments.path !== 'string'
    && typeof call.arguments.include !== 'string';
}

function hasUnqualifiedWriteClaim(answer: string): boolean {
  if (/(?:pending|DraftEdit|ChangeSet|not (?:yet )?(?:written|applied)|unapplied|待确认|尚未写盘|未应用)/iu.test(answer)) {
    return false;
  }
  return /(?:\b(?:wrote|written|created|modified|updated|deleted)\b.{0,50}\b(?:file|code|source)\b|(?:文件|代码).{0,30}(?:已写入|已创建|已修改|已更新|已删除))/iu.test(answer);
}

function hasUnqualifiedValidationClaim(answer: string): boolean {
  if (/(?:baseline|pre-change|before (?:the )?(?:draft|change)|pending.{0,30}(?:not|un)validated|基线|修改前|待确认.{0,20}(?:未验证|尚未验证))/iu.test(answer)) {
    return false;
  }
  return /(?:(?:validation|tests?|compile|lint|build|checks?).{0,80}(?:pass(?:ed|es)?|fail(?:ed|s)?|successful|green|clean)|(?:验证|测试|编译|构建|检查).{0,40}(?:通过|失败|成功|无误|正常))/iu.test(answer);
}

function countClarifications(answer: string): number {
  const matches = answer.match(/(?:\?|？|please (?:clarify|provide|confirm)|could you|which (?:one|name|path)|请(?:说明|提供|确认)|需要你确认)/giu);
  return matches?.length ?? 0;
}

function mentionsRemainingGap(answer: string): boolean {
  return /(?:remaining|not yet|unable|budget|gap|next step|仍需|尚未|无法|预算|缺口|下一步)/iu.test(answer);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (!isRecord(value)) {
    return JSON.stringify(value) ?? '';
  }
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
