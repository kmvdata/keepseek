import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { GoalCompletionReviewService, type GoalCompletionSafetySnapshot } from '../src/agent/goals/goalCompletionReview';
import { hashGoalContract } from '../src/agent/goals/goalContract';
import {
  appendGoalContinuation,
  appendGoalHostControl,
  createGoalControlItem,
  createTerminalGoalReplay,
  normalizeGoalReplay
} from '../src/agent/goals/goalReplay';
import { endpointHash, normalizeRunCheckpoint, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import type { ChatMessage } from '../src/shared/types';
import type { GoalContract, GoalRecordV1 } from '../src/agent/goals/goalTypes';
import { contract, recordFor, v2Fixture } from './goalDomain.test';

describe('Goal replay', () => {
  test('appends candidate and deterministic control without touching ChatSession messages', () => {
    const checkpoint = checkpointFor('chat');
    const sessionMessages = [{ role: 'user', content: 'Goal: test' }];
    const control = createGoalControlItem({
      contractHash: 'contract', revision: 1, evidenceManifestHash: 'manifest', workspaceMutationRevision: 2,
      unmetCriterionIds: ['criterion-b', 'criterion-a'], incompleteValidations: ['test', 'compile'],
      taskPlan: { status: 'in_progress', currentStepId: 'step-1', blockers: ['b'] }, nextStep: 'satisfy_criterion:criterion-a'
    });
    const next = appendGoalContinuation({ checkpoint, candidateContent: 'Too early.', controlContent: control.content });
    assert.deepEqual(sessionMessages, [{ role: 'user', content: 'Goal: test' }]);
    assert.deepEqual(next.state?.messages.slice(-2), [
      { role: 'assistant', content: 'Too early.' }, { role: 'user', content: control.content }
    ]);
    assert.deepEqual(control.item.unmetCriterionIds, ['criterion-a', 'criterion-b']);
    assert.deepEqual(control.item.incompleteValidations, ['compile', 'test']);
  });

  test('persists host results once into each native protocol continuation', () => {
    const responses = appendGoalHostControl(checkpointFor('responses'), '{"result":"done"}');
    const anthropic = appendGoalHostControl(checkpointFor('anthropic'), '{"result":"done"}');
    assert.deepEqual(responses.state?.provider?.protocol === 'openai-responses'
      ? responses.state.provider.input.at(-1) : undefined, { role: 'user', content: '{"result":"done"}' });
    assert.deepEqual(anthropic.state?.provider?.protocol === 'anthropic-messages'
      ? anthropic.state.provider.messages.at(-1) : undefined,
    { role: 'user', content: [{ type: 'text', text: '{"result":"done"}' }] });
  });

  test('creates and hash-validates exact terminal replay for all three protocols', () => {
    for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
      const replay = createTerminalGoalReplay({ checkpoint: checkpointFor(protocol), contract: contract(), candidateContent: 'Final candidate.' });
      assert.deepEqual(normalizeGoalReplay(replay), replay);
      assert.equal(normalizeGoalReplay({ ...replay, bytesHash: 'tampered' }), undefined);
    }
  });

  test('uses terminal Goal replay as the exact next-turn anchor in all three Provider protocols', () => {
    for (const protocol of ['chat', 'responses', 'anthropic'] as const) {
      const baseUrl = protocol === 'responses' ? 'https://example.test/v1'
        : protocol === 'anthropic' ? 'https://example.test/anthropic' : 'https://example.test/chat';
      const provider = protocol === 'responses' ? 'openai-responses' as const
        : protocol === 'anthropic' ? 'anthropic-compatible' as const : 'openai-compatible' as const;
      const value = contract();
      value.main.sourceId = 'source';
      value.main.provider = provider;
      value.main.endpointHash = endpointHash(baseUrl);
      value.canonicalHash = hashGoalContract(value);
      const checkpoint = checkpointFor(protocol);
      checkpoint.goal!.contractHash = value.canonicalHash;
      const replay = createTerminalGoalReplay({ checkpoint, contract: value, candidateContent: 'Final candidate.' });
      const history: ChatMessage[] = [
        { id: 'goal-final', role: 'assistant', content: 'Final candidate.', createdAt: '2026-01-01T00:00:00.000Z', goalReplay: replay },
        { id: 'next-user', role: 'user', content: 'Next real user message.', createdAt: '2026-01-01T00:00:01.000Z' }
      ];
      const projection = buildProviderRequestProjection({
        model: { id: 'model', label: 'Model', sourceId: 'source', provider },
        agentSettings: settings(), contextFiles: [], history, language: 'en', prompt: 'Next real user message.',
        requestProtocolVersion: 10, provider, sourceId: 'source', baseUrl, includeTools: false
      });
      if (replay.protocol === 'chat-completions') {
        assert.deepEqual(projection.messages.slice(0, replay.messages.length), replay.messages);
        assert.equal(projection.messages.at(-1)?.content, 'Next real user message.');
      } else if (replay.protocol === 'openai-responses') {
        assert.deepEqual(projection.responses?.input.slice(0, replay.input.length), replay.input);
        assert.deepEqual(projection.responses?.input.at(-1), { role: 'user', content: 'Next real user message.' });
      } else {
        assert.deepEqual(projection.anthropic?.system, replay.system);
        assert.deepEqual(projection.anthropic?.messages.slice(0, replay.messages.length), replay.messages);
        assert.deepEqual(projection.anthropic?.messages.at(-1), {
          role: 'user', content: [{ type: 'text', text: 'Next real user message.' }]
        });
      }
    }
  });

  test('normalizes v1/v2 checkpoints and preserves bounded v3 Goal authority', () => {
    const v3 = checkpointFor('chat');
    v3.goal!.workItems = [{ version: 1, workItemId: 'work-1', status: 'blocked', acceptanceCriterionIds: ['criterion-1'] }];
    const normalized = normalizeRunCheckpoint(v3);
    assert.equal(normalized?.version, 3);
    assert.equal(normalized?.goal?.contractHash, 'contract');
    assert.equal(normalized?.status, 'interrupted');
    assert.deepEqual(normalized?.goal?.workItems, v3.goal?.workItems);
    const invalid = structuredClone(v3);
    invalid.goal!.workItems![0]!.status = 'running' as never;
    assert.equal(normalizeRunCheckpoint(invalid), undefined);
    for (const version of [1, 2] as const) {
      const legacy = { ...v3, version, goal: undefined };
      assert.equal(normalizeRunCheckpoint(legacy)?.version, 2);
    }
  });
});

describe('Goal completion hard checks and isolated reviewer', () => {
  test('does not treat a selected skipped work item as completed without acceptance evidence', () => {
    const fixture = v2Fixture('Verify skipped work item semantics.');
    const record = recordFor(contract());
    record.revisions = [{ revision: 1, contract: fixture.contract, createdAt: record.createdAt }];
    record.currentContractHash = fixture.contract.canonicalHash;
    record.proposalDecision = fixture.decision;
    record.criteria = [{ criterionId: 'criterion-selected', status: 'pending', evidenceRefs: [] }];
    record.workItems = [{ version: 1, workItemId: 'selected-work', status: 'skipped', acceptanceCriterionIds: ['criterion-selected'] }];
    const service = new GoalCompletionReviewService(async () => { throw new Error('must not review'); });
    const result = service.hardCheck(record, safety({ currentContractHash: fixture.contract.canonicalHash }));
    assert.equal(result.passed, false);
    assert.deepEqual(result.unmetCriterionIds, ['criterion-selected']);
  });

  test('blocks unsettled side effects, stale validation, active subagents, and stale bindings', () => {
    const record = completedEvidenceRecord();
    const service = new GoalCompletionReviewService(async () => { throw new Error('must not call reviewer'); });
    const result = service.hardCheck(record, safety({
      currentContractHash: 'stale', pendingChangeSetStatuses: ['edit:applying'],
      pendingDraftRunStatuses: ['run:running'], activeSubagentCount: 1
    }));
    assert.equal(result.passed, false);
    assert.ok(result.blockers.includes('stale_goal_revision'));
    assert.ok(result.blockers.some((item) => item.startsWith('unsettled_changeset')));
    assert.ok(result.blockers.includes('active_subagent'));
  });

  test('accepts strict complete, continue, and blocked reviewer results with binding hashes', async () => {
    const record = completedEvidenceRecord();
    for (const decision of ['complete', 'continue', 'blocked'] as const) {
      let persisted = false;
      const service = new GoalCompletionReviewService(async () => JSON.stringify({
        decision, reason: `${decision} reason`, unmetCriterionIds: decision === 'complete' ? [] : ['criterion-1'],
        nextStep: 'next', requiredInput: decision === 'blocked' ? 'user choice' : ''
      }));
      const result = await service.review({
        record, candidate: 'Candidate.', snapshot: safety(), context: reviewerContext(),
        persistReviewIntent: async () => { persisted = true; }
      });
      assert.equal(result.status, decision);
      assert.equal(persisted, true);
      assert.equal(result.decision?.candidateHash.length, 64);
      assert.equal(result.decision?.goalHash, record.currentContractHash);
    }
  });

  test('never trusts malformed output and only falls back when every criterion is machine-verifiable', async () => {
    const machine = completedEvidenceRecord();
    const malformed = new GoalCompletionReviewService(async () => '{"decision":"complete"}');
    assert.equal((await malformed.review({
      record: machine, candidate: 'Candidate.', snapshot: safety(), context: reviewerContext(), persistReviewIntent: async () => undefined
    })).status, 'malformed');

    const unavailable = new GoalCompletionReviewService(async () => { throw new Error('offline'); });
    assert.equal((await unavailable.review({
      record: machine, candidate: 'Candidate.', snapshot: safety(), context: reviewerContext(), persistReviewIntent: async () => undefined
    })).status, 'complete');

    const manual = completedEvidenceRecord();
    manual.revisions[0]!.contract.acceptanceCriteria[0]!.type = 'manual';
    assert.equal((await unavailable.review({
      record: manual, candidate: 'Candidate.', snapshot: safety(), context: reviewerContext(), persistReviewIntent: async () => undefined
    })).status, 'unavailable');

    const positiveCost = completedEvidenceRecord();
    const positiveContract = positiveCost.revisions[0]!.contract;
    positiveContract.budgets.maxCost = 1;
    positiveContract.canonicalHash = requireHash(positiveContract);
    positiveCost.currentContractHash = positiveContract.canonicalHash;
    positiveCost.usage.costByCurrency = { USD: 0.1 };
    assert.equal((await unavailable.review({
      record: positiveCost, candidate: 'Candidate.',
      snapshot: safety({ currentContractHash: positiveContract.canonicalHash }),
      context: reviewerContext(), persistReviewIntent: async () => undefined
    })).status, 'unavailable');
  });
});

function checkpointFor(protocol: 'chat' | 'responses' | 'anthropic'): RunCheckpoint {
  const provider = protocol === 'responses' ? {
    protocol: 'openai-responses' as const, input: [{ role: 'assistant' as const, content: 'Final candidate.' }],
    replayItems: [{ role: 'assistant' as const, content: 'Final candidate.' }], tools: [], sourceId: 'source', baseUrl: 'https://example.test'
  } : protocol === 'anthropic' ? {
    protocol: 'anthropic-messages' as const, system: [],
    messages: [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Final candidate.' }] }],
    replayMessages: [{ role: 'assistant' as const, content: [{ type: 'text' as const, text: 'Final candidate.' }] }],
    tools: [], sourceId: 'source', baseUrl: 'https://example.test'
  } : undefined;
  return {
    version: 3, taskId: 'task', attempt: 0, attemptIds: [], status: 'running', usedMs: 0, maxExecutionMs: 60_000,
    usedCostByCurrency: {}, maxCost: 1, limitSource: 'goal', modelRequests: 1, retries: 0,
    updatedAt: '2026-01-01T00:00:00.000Z', workspaceFolders: ['file:///workspace'],
    source: { sourceId: 'source', modelId: 'model', provider: 'openai-compatible', endpointHash: contract().main.endpointHash },
    request: { model: { id: 'model', label: 'Model' }, prompt: 'Goal: test', settings: settings(), contextFiles: [], history: [], language: 'en', sessionId: 'session' },
    goal: { version: 1, contractHash: 'contract', revision: 1, activeExecutionMs: 0, costByCurrency: {}, modelRequests: 1,
      completionReviews: 0, criteria: [], validationMutationRevision: 0, consumedResultKeys: [] },
    state: { messages: [{ role: 'user', content: 'Goal: test' }], provider, toolRounds: [], draftEdits: [], draftRuns: [],
      reasoningParts: [], turn: 1, toolCallCount: 0, validationRunCount: 0, toolResultTokens: 0,
      repairLoop: { status: 'idle', iteration: 0, maxIterations: 3, pendingDraftEditIds: [], validationFailures: [] } }
  } as unknown as RunCheckpoint;
}

function completedEvidenceRecord(): GoalRecordV1 {
  const value = contract();
  value.budgets.maxCost = 0;
  value.canonicalHash = requireHash(value);
  const record = recordFor(value);
  record.status = 'running';
  record.workspaceMutationRevision = 2;
  record.validations = [{ script: 'compile', status: 'passed', mutationRevision: 2, contentHash: 'validation', completedAt: '2026-01-01T00:00:00.000Z' }];
  record.criteria = [{ criterionId: 'criterion-1', status: 'satisfied', evidenceRefs: ['evidence:1'], evidenceManifestHash: 'manifest' }];
  record.candidateFinal = { content: 'Candidate.', contentHash: 'candidate' };
  return record;
}

function safety(overrides: Partial<GoalCompletionSafetySnapshot> = {}): GoalCompletionSafetySnapshot {
  return {
    currentContractHash: overrides.currentContractHash ?? completedEvidenceRecord().currentContractHash,
    currentRevision: 1, leaseValid: true, workspaceTrusted: true, workspaceKeyMatches: true, sourceMatches: true,
    externalAuthorizationsValid: true, evidenceManifestHash: 'manifest', evidenceSummary: [], pendingChangeSetStatuses: [], pendingDraftRunStatuses: [],
    pendingApprovalCount: 0, pendingToolResultCount: 0, uncertainToolResultCount: 0, activeSubagentCount: 0,
    taskPlan: { id: 'plan', runId: 'run', goal: 'goal', status: 'completed', steps: [], blockers: [], createdAt: 'x', updatedAt: 'x' },
    ...overrides
  };
}

function reviewerContext() {
  return {
    model: { id: 'review-model', label: 'Review Model', provider: 'openai-compatible' as const },
    sourceConfig: { sourceId: 'review-source', provider: 'openai-compatible' as const, apiKey: 'secret', baseUrl: 'https://example.test', supportsBilling: false },
    language: 'en' as const
  };
}

function settings() {
  return { thinkingEnabled: false, reasoningEffort: 'high' as const, compressionThreshold: 'balanced' as const,
    maxTokens: 1024, maxToolIterations: 5, maxToolCalls: 20, commandTimeoutMs: 60_000,
    contextCompressionEnabled: false, contextCompressionThreshold: 0.8, contextSummaryBudgetTokens: 1_000,
    contextRecentTurns: 4, contextForceRatio: 0.95 };
}

function requireHash(value: GoalContract): string {
  return hashGoalContract(value);
}
