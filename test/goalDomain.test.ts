import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, test } from 'node:test';
import { parseGoalCommand } from '../src/agent/goals/goalCommand';
import {
  amendGoalContract,
  createGoalContract,
  formatGoalProviderTail,
  hashGoalContract,
  serializeGoalContract,
  serializeGoalProviderContract
} from '../src/agent/goals/goalContract';
import { canTransitionGoal, transitionGoal } from '../src/agent/goals/goalStateMachine';
import type { GoalContractV1, GoalRecordV1 } from '../src/agent/goals/goalTypes';
import { createGoalViewModel } from '../src/agent/goals/goalViewModel';
import { getAgentSystemPrompt, getAgentTools } from '../src/agent/protocol';

describe('Goal command and canonical contract', () => {
  test('strictly recognizes the exact command boundary without normalizing body bytes', () => {
    assert.equal(parseGoalCommand('  /GoAl\n修复 Ω\r\n第二行  ').recognized, true);
    const parsed = parseGoalCommand('  /GoAl\n修复 Ω\r\n第二行  ');
    assert.deepEqual(parsed.recognized && parsed.command, {
      kind: 'create', raw: '/GoAl\n修复 Ω\r\n第二行', objective: '修复 Ω\r\n第二行'
    });
    assert.deepEqual(parseGoalCommand('/goalkeeper fix'), { recognized: false, text: '/goalkeeper fix' });
    assert.deepEqual(parseGoalCommand('/goals'), { recognized: false, text: '/goals' });
    const empty = parseGoalCommand('/goal');
    const status = parseGoalCommand('/GOAL status');
    assert.equal(empty.recognized && empty.command.kind, 'status');
    assert.equal(status.recognized && status.command.kind, 'status');
  });

  test('rejects missing or extra reserved arguments and enforces the shared limit', () => {
    const amend = parseGoalCommand('/goal amend');
    const pause = parseGoalCommand('/goal pause later');
    const tooLong = parseGoalCommand(`/goal ${'x'.repeat(20_001)}`);
    assert.equal(amend.recognized && amend.command.kind, 'error');
    assert.equal(pause.recognized && pause.command.kind, 'error');
    assert.equal(tooLong.recognized && tooLong.command.kind, 'error');
    const unicode = parseGoalCommand('/goal amend 追加条件：保留🙂');
    assert.equal(unicode.recognized && unicode.command.kind === 'amend' && unicode.command.instruction, '追加条件：保留🙂');
  });

  test('serializes with stable field order, LF normalization, and a stable hash', () => {
    const first = contract({ objective: 'Line one\r\nLine two' });
    const second = contract({ objective: 'Line one\nLine two' });
    assert.equal(serializeGoalContract(first), serializeGoalContract(second));
    assert.equal(first.canonicalHash, second.canonicalHash);
    assert.equal(hashGoalContract(first), first.canonicalHash);
    assert.equal(createHash('sha256').update(serializeGoalContract(first), 'utf8').digest('hex'), first.canonicalHash);
  });

  test('keeps host runtime identity out of all provider-visible Goal bytes', () => {
    const value = contract();
    const provider = serializeGoalProviderContract(value);
    assert.match(provider, new RegExp(value.canonicalHash, 'u'));
    assert.doesNotMatch(provider, /source-550e8400-e29b-41d4-a716-446655440000/u);
    assert.doesNotMatch(provider, /runtime-profile-secret|endpoint-secret/u);
    assert.equal(formatGoalProviderTail(value).includes(provider), true);
    assert.throws(() => contract({ objective: 'Edit /Users/alice/private/file.ts' }), /absolute paths/u);
  });

  test('amendments preserve the original objective and invalidate the contract hash', () => {
    const original = contract();
    const amended = amendGoalContract(original, 'Also keep the public API stable.');
    assert.equal(amended.objective, original.objective);
    assert.deepEqual(amended.amendments, ['Also keep the public API stable.']);
    assert.notEqual(amended.canonicalHash, original.canonicalHash);
  });
});

describe('Goal state and protocol boundary', () => {
  test('allows only explicit state transitions and makes duplicate transitions idempotent', () => {
    const record = recordFor(contract());
    assert.equal(canTransitionGoal('preparing', 'running'), true);
    assert.equal(canTransitionGoal('completed', 'running'), false);
    assert.equal(transitionGoal(record, 'preparing').status, 'preparing');
    const running = transitionGoal(record, 'running', { now: '2026-01-01T00:00:01.000Z' });
    const completed = transitionGoal(running, 'completed', { now: '2026-01-01T00:00:02.000Z' });
    assert.equal(completed.endedAt, '2026-01-01T00:00:02.000Z');
    assert.throws(() => transitionGoal(completed, 'running'), /Illegal Goal transition/u);
  });

  test('v10 changes neither v9 system prompt nor v9 tool schema bytes', () => {
    const frozen = [];
    for (let version = 1; version <= 9; version += 1) {
      frozen.push({
        version,
        en: getAgentSystemPrompt({ language: 'en', requestProtocolVersion: version }),
        zh: getAgentSystemPrompt({ language: 'zh-CN', requestProtocolVersion: version }),
        tools: getAgentTools({ requestProtocolVersion: version })
      });
    }
    assert.equal(
      createHash('sha256').update(JSON.stringify(frozen), 'utf8').digest('hex'),
      '824eafd15c1737998178513282c9a97afe316ea20537bdbcc58dc4e08c48ffa1'
    );
    for (const language of ['en', 'zh-CN'] as const) {
      assert.equal(
        getAgentSystemPrompt({ language, requestProtocolVersion: 10 }),
        getAgentSystemPrompt({ language, requestProtocolVersion: 9 })
      );
    }
    assert.equal(
      JSON.stringify(getAgentTools({ requestProtocolVersion: 10 })),
      JSON.stringify(getAgentTools({ requestProtocolVersion: 9 }))
    );
  });

  test('projects only bounded, user-facing Goal state into the Webview', () => {
    const record = recordFor(contract());
    record.requiredExternalAuthorizationUris = ['/Users/alice/private'];
    record.lease = { ownerId: 'lease-owner-secret', fencingToken: 42 };
    record.runCheckpoint = { hidden: 'checkpoint-secret' } as never;
    record.candidateFinal = {
      content: 'candidate-secret',
      contentHash: 'candidate-hash',
      providerReplay: { protocol: 'openai_responses', items: [{ type: 'reasoning', encrypted_content: 'reviewer-secret' }] } as never
    };
    const view = createGoalViewModel(record, 'ask');
    const bytes = JSON.stringify(view);
    assert.ok(view);
    assert.equal(view?.objective, contract().objective);
    assert.doesNotMatch(bytes, /Users\/alice|lease-owner-secret|checkpoint-secret|candidate-secret|reviewer-secret/u);
  });
});

export function contract(overrides: { objective?: string } = {}): GoalContractV1 {
  return createGoalContract({
    objective: overrides.objective ?? 'Implement and verify the persistent Goal.',
    acceptanceCriteria: [{ id: 'criterion-1', text: 'The Goal is implemented.', type: 'workspace_state', evidenceRequirement: 'Workspace evidence hash' }],
    includeScope: ['src'], excludeScope: ['src/generated'], requiredValidations: ['compile'],
    budgets: { maxActiveExecutionMs: 60_000, maxCost: 1, maxModelRequests: 10, maxCompletionReviews: 2 },
    resumePolicy: 'manual',
    main: {
      sourceId: 'source-550e8400-e29b-41d4-a716-446655440000', modelId: 'model', provider: 'openai-compatible',
      endpointHash: 'endpoint-secret', runtimeProfile: 'runtime-profile-secret'
    },
    completionReviewer: {
      mode: 'fixed', sourceId: 'review-source', modelId: 'review-model', provider: 'openai-compatible', endpointHash: 'review-endpoint'
    }
  });
}

export function recordFor(value: GoalContractV1): GoalRecordV1 {
  return {
    version: 1, id: 'goal-1', workspaceKey: 'workspace-1', sessionId: 'session-1',
    initialPrompt: { visibleContent: '/goal test', expandedContent: '/goal test', providerContent: '/goal test' },
    requiredExternalAuthorizationUris: [], status: 'preparing',
    revisions: [{ revision: 1, contract: value, createdAt: '2026-01-01T00:00:00.000Z' }],
    currentRevision: 1, currentContractHash: value.canonicalHash,
    usage: { activeExecutionMs: 0, costByCurrency: {}, modelRequests: 0, mainModelRequests: 0, auxiliaryModelRequests: 0, completionReviews: 0 },
    workspaceMutationRevision: 0, validations: [],
    criteria: value.acceptanceCriteria.map((criterion) => ({ criterionId: criterion.id, status: 'pending', evidenceRefs: [] })),
    consumedResultKeys: [], requestIntents: [], journalShards: [], nextJournalSequence: 1,
    sideEffects: { changeSetIds: [], draftRunIds: [], approvalIds: [], pendingToolCallIds: [], uncertainToolCallIds: [], subagentIds: [] },
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  };
}
