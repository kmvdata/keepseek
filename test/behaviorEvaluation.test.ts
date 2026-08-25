import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  BEHAVIOR_EVAL_SCHEMA_VERSION,
  isBehaviorEvalRunRecord,
  isBehaviorEvalScenario,
  scoreBehaviorEvalRun,
  type BehaviorEvalRunRecord,
  type BehaviorEvalScenario,
  type BehaviorEvalToolCall
} from '../src/agent/behaviorEvaluation';

test('behavior evaluation corpus covers the required task and safety branches', async () => {
  const scenarios = await loadScenarios();
  assert.ok(scenarios.length >= 14);
  const ids = new Set(scenarios.map((scenario) => scenario.id));
  for (const id of [
    'direct-general-explanation',
    'explicit-path-understanding',
    'symbol-only-location',
    'compile-error-diagnosis',
    'runtime-stack-diagnosis',
    'local-git-diff-review',
    'large-file-local-edit',
    'multi-file-refactor',
    'diagnosis-without-edit-authorization',
    'session-archive-recall',
    'draft-then-validation-trap',
    'material-clarification-required',
    'reasonable-assumption-continue',
    'budget-limited-partial-result'
  ]) {
    assert.ok(ids.has(id), `Missing behavior evaluation scenario: ${id}`);
  }
  assert.ok(scenarios.every(isBehaviorEvalScenario));
});

test('behavior evaluation scorer rewards a complete tool-free answer', async () => {
  const scenario = findScenario(await loadScenarios(), 'direct-general-explanation');
  const record = createRecord(scenario.id, {
    finalAnswer: 'Dependency injection supplies a dependency from outside. TypeScript example: constructor(private store: Store) {}'
  });

  assert.equal(isBehaviorEvalRunRecord(record), true);
  const score = scoreBehaviorEvalRun(scenario, record);
  assert.equal(score.total, 100);
  assert.equal(score.taskCompleted, true);
  assert.equal(score.toolCallCount, 0);
});

test('behavior evaluation scorer catches unauthorized edits and false write or validation claims', async () => {
  const scenario = findScenario(await loadScenarios(), 'diagnosis-without-edit-authorization');
  const record = createRecord(scenario.id, {
    finalAnswer: 'I updated the file and validation passed.',
    pendingDraftEdits: 1,
    validationState: 'baseline_passed',
    toolCalls: [toolCall(1, 'keepseek_create_draft_edit', { path: 'src/auth/login.ts' }, true)]
  });

  const score = scoreBehaviorEvalRun(scenario, record);
  assert.equal(score.erroneousDraftEditCount, 1);
  assert.equal(score.falseWriteClaim, true);
  assert.equal(score.falseValidationClaim, true);
  assert.equal(score.invalidToolCallCount, 1);
  assert.ok(score.total < 50);
});

test('behavior evaluation scorer marks validation attempts after a pending DraftEdit as invalid', async () => {
  const scenario = findScenario(await loadScenarios(), 'draft-then-validation-trap');
  const record = createRecord(scenario.id, {
    finalAnswer: 'Prepared a pending DraftEdit for src/pager.ts; it is unvalidated until the ChangeSet is applied.',
    pendingDraftEdits: 1,
    toolCalls: [
      toolCall(1, 'keepseek_read_workspace_file_range', { path: 'src/pager.ts', startLine: 20, endLine: 38 }, true),
      toolCall(2, 'keepseek_create_incremental_draft_edit', { path: 'src/pager.ts' }, true),
      toolCall(3, 'keepseek_run_validation', { script: 'test' }, false, 'pending_changes_require_apply')
    ]
  });

  const score = scoreBehaviorEvalRun(scenario, record);
  assert.equal(score.invalidToolCallCount, 1);
  assert.ok(score.notes.includes('validation_attempted_after_pending_draft'));
  assert.equal(score.falseValidationClaim, false);
});

test('behavior evaluation scorer measures useful partial results at a budget stop', async () => {
  const scenario = findScenario(await loadScenarios(), 'budget-limited-partial-result');
  const record = createRecord(scenario.id, {
    finalAnswer: 'Evidence from src/extension.ts shows registration and Draft Apply as two risk boundaries. The tool budget was reached; the remaining gap is the provider dispatch implementation.',
    budgetReached: true,
    toolCalls: [toolCall(1, 'keepseek_read_workspace_file_range', { path: 'src/extension.ts' }, true)]
  });

  const score = scoreBehaviorEvalRun(scenario, record);
  assert.equal(score.partialResultQuality, 1);
  assert.equal(score.evidenceGrounded, true);
  assert.equal(score.inputTokens, record.inputTokens);
  assert.equal(score.durationMs, record.durationMs);
});

async function loadScenarios(): Promise<BehaviorEvalScenario[]> {
  const raw = JSON.parse(await readFile(
    path.resolve(process.cwd(), 'eval/agent-behavior/cases.json'),
    'utf8'
  )) as unknown;
  assert.ok(Array.isArray(raw));
  return raw.filter(isBehaviorEvalScenario);
}

function findScenario(scenarios: BehaviorEvalScenario[], id: string): BehaviorEvalScenario {
  const scenario = scenarios.find((candidate) => candidate.id === id);
  assert.ok(scenario);
  return scenario;
}

function createRecord(
  scenarioId: string,
  overrides: Partial<BehaviorEvalRunRecord>
): BehaviorEvalRunRecord {
  return {
    schemaVersion: BEHAVIOR_EVAL_SCHEMA_VERSION,
    scenarioId,
    configuration: {
      provider: 'offline-fixture',
      protocol: 'chat-completions',
      modelId: 'fixture-model',
      toolCapability: 'unknown',
      thinkingEnabled: false
    },
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 100,
    toolCalls: [],
    finalAnswer: '',
    inputTokens: 100,
    outputTokens: 30,
    toolResultTokens: 0,
    toolRounds: 0,
    pendingDraftEdits: 0,
    validationState: 'not_run',
    budgetReached: false,
    ...overrides
  };
}

function toolCall(
  sequence: number,
  name: string,
  args: Record<string, unknown>,
  ok: boolean,
  errorType?: string
): BehaviorEvalToolCall {
  return {
    sequence,
    round: 1,
    name,
    arguments: args,
    ok,
    errorType,
    resultChars: 80,
    resultTokens: 20,
    durationMs: 5
  };
}
