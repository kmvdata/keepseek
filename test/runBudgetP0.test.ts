import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LogicalBudgetExceededError,
  LogicalRunBudget,
  SharedUpstreamTokenBudget,
  createLogicalRunBudgetState
} from '../src/agent/executionPolicy';
import { AgentRunner } from '../src/agent/runner';
import { checkpointCopy, normalizeRunCheckpoint, type RunCheckpoint } from '../src/agent/runCheckpoint';
import type { AgentRequest } from '../src/shared/types';

test('length continuation is bounded, persisted, and returns marked partial content', async () => {
  const bodies: string[] = [];
  let checkpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    return chatText('partial-', 'length', { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  }) as typeof fetch;
  try {
    const input = request();
    input.executionLimits = { maxContinuations: 1, maxModelRequests: 8 };
    const response = await new AgentRunner().run(input, {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); }
    });
    assert.equal(bodies.length, 2);
    assert.match(response.message, /Truncated because the automatic output\/continuation budget/u);
    assert.equal(checkpoint.runBudget?.continuations, 1);
    assert.equal(checkpoint.runBudget?.modelRequests, 2);
    assert.equal(checkpoint.runBudget?.promptTokens, 20);
    assert.equal(checkpoint.runBudget?.completionTokens, 10);
    assert.equal(response.runDetails.budgetStopReason, 'continuation_budget_exhausted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('physical retries share the model-request and conservative upstream-token budget', async () => {
  let attempts = 0;
  let checkpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts += 1;
    return new Response(JSON.stringify({ error: { message: 'retry' } }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    });
  }) as typeof fetch;
  try {
    const input = request();
    input.executionLimits = { maxModelRequests: 2, maxUpstreamTokens: 1_000_000 };
    const response = await new AgentRunner().run(input, {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); }
    });
    assert.equal(attempts, 2);
    assert.equal(checkpoint.runBudget?.modelRequests, 2);
    assert.ok((checkpoint.runBudget?.upstreamTokens ?? 0) > 0);
    assert.equal(response.runDetails.budgetStopReason, 'model_request_budget_exhausted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('estimated prompt plus output reserve is admitted before any Provider request', async () => {
  let attempts = 0;
  let checkpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    attempts += 1;
    return chatText('unexpected', 'stop');
  }) as typeof fetch;
  try {
    const input = request();
    input.executionLimits = { maxUpstreamTokens: 100, maxTreeUpstreamTokens: 200 };
    const response = await new AgentRunner().run(input, {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); }
    });
    assert.equal(attempts, 0);
    assert.equal(checkpoint.runBudget?.modelRequests, 0);
    assert.equal(response.runDetails.budgetStopReason, 'upstream_token_budget_exhausted');
    assert.match(response.message, /safety budget/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('checkpoint normalization migrates old counters and clamps malformed budget values', () => {
  const input = request();
  const raw = {
    version: 2,
    taskId: 'task',
    attempt: 1,
    attemptIds: [],
    status: 'interrupted',
    stopReason: 'extension_restart',
    usedMs: 25,
    maxExecutionMs: 900_000,
    limitSource: 'test',
    modelRequests: 4,
    retries: 1,
    updatedAt: new Date().toISOString(),
    request: { ...input, sourceConfig: undefined },
    source: { sourceId: 'source', modelId: 'model', provider: 'openai-compatible', endpointHash: 'hash' },
    workspaceFolders: [],
    state: {
      messages: [], toolRounds: [], draftEdits: [], draftRuns: [], reasoningParts: [], turn: 3,
      toolCallCount: 7, validationRunCount: 0, toolResultTokens: 0,
      repairLoop: { status: 'idle', iteration: 0, maxIterations: 2, pendingDraftEditIds: [] }
    }
  } as unknown as RunCheckpoint;
  const migrated = normalizeRunCheckpoint(raw);
  assert.equal(migrated?.runBudget?.modelRequests, 4);
  assert.equal(migrated?.runBudget?.toolRounds, 3);
  assert.equal(migrated?.runBudget?.toolCalls, 7);

  raw.stopReason = 'budget_exhausted';
  raw.state!.budgetStopReason = 'tool_iterations_exhausted';
  const legacyCapacity = normalizeRunCheckpoint(raw);
  assert.equal(legacyCapacity?.runBudget, undefined, 'legacy capacity stops remain eligible for epoch migration');
  raw.stopReason = 'extension_restart';
  raw.state!.budgetStopReason = undefined;

  raw.runBudget = createLogicalRunBudgetState({ modelRequests: -10, upstreamTokens: Number.NaN, finalizationAttempted: true });
  const normalized = normalizeRunCheckpoint(raw);
  assert.equal(normalized?.runBudget?.modelRequests, 0);
  assert.equal(normalized?.runBudget?.upstreamTokens, 0);
  assert.equal(normalized?.runBudget?.finalizationAttempted, true);
});

test('a restored finalization attempt cannot dispatch a second finalization request', async () => {
  let checkpoint!: RunCheckpoint;
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    calls += 1;
    return calls === 1
      ? chatTool('call-1', 'keepseek_list_workspace_files', '{}')
      : chatText('final', 'stop');
  }) as typeof fetch;
  try {
    const input = request();
    input.executionLimits = { maxToolIterations: 1, maxToolCalls: 1 };
    await new AgentRunner().run(input, { onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); } });
    assert.equal(calls, 2);
    assert.equal(checkpoint.runBudget?.finalizationAttempted, true);
    checkpoint.status = 'interrupted';
    checkpoint.stopReason = 'extension_restart';
    checkpoint.finalResponse = undefined;
    checkpoint.state!.pending = undefined;
    const resumed = {
      ...checkpoint.request,
      checkpoint,
      sourceConfig: input.sourceConfig
    } as AgentRequest;
    const response = await new AgentRunner().run(resumed);
    assert.equal(calls, 2, 'recovery must not dispatch another finalization');
    assert.equal(response.runDetails.budgetStopReason, 'tool_budget_exhausted');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('parallel child ledgers atomically share the stricter root tree token budget', () => {
  const tree = new SharedUpstreamTokenBudget(100, 0);
  const limits = {
    maxModelRequests: 12, maxToolRounds: 4, maxToolCalls: 8, maxContinuations: 1,
    maxContextEpochRollovers: 3, maxUpstreamTokens: 80, maxTreeUpstreamTokens: 100,
    maxContinuationOutputTokens: 8, maxContinuationOutputChars: 32
  };
  const first = new LogicalRunBudget(undefined, limits, tree, 300_000);
  const second = new LogicalRunBudget(undefined, limits, tree, 300_000);
  first.reservePhysicalRequest(40, 20);
  assert.throws(
    () => second.reservePhysicalRequest(30, 20),
    (error: unknown) => error instanceof LogicalBudgetExceededError
      && error.budgetReason === 'tree_upstream_token_budget_exhausted'
  );
  assert.equal(first.state.treeUpstreamTokens, 60);
  assert.equal(second.state.modelRequests, 0);

  const restoredChild = new LogicalRunBudget(createLogicalRunBudgetState({ treeUpstreamTokens: 90 }), limits, tree, 300_000);
  assert.equal(restoredChild.tree.usedTokens, 90, 'a newer child checkpoint repairs a stale parent tree snapshot');
});

test('tool and rollover counters remain whole-run limits after checkpoint restoration', () => {
  const restored = createLogicalRunBudgetState({
    toolRounds: 1,
    toolCalls: 2,
    contextEpochRollovers: 2,
    modelRequests: 3,
    deadlineAt: new Date(Date.now() + 60_000).toISOString()
  });
  const tree = new SharedUpstreamTokenBudget(1_000, 0);
  const budget = new LogicalRunBudget(restored, {
    maxModelRequests: 4, maxToolRounds: 2, maxToolCalls: 3, maxContinuations: 1,
    maxContextEpochRollovers: 3, maxUpstreamTokens: 1_000, maxTreeUpstreamTokens: 1_000,
    maxContinuationOutputTokens: 8, maxContinuationOutputChars: 32
  }, tree, 900_000);
  budget.recordToolRound();
  assert.equal(budget.tryRecordToolCall(), true);
  assert.equal(budget.canUseTools(), false);
  assert.equal(budget.tryRecordRollover(), true);
  assert.equal(budget.tryRecordRollover(), false);
  assert.equal(budget.state.toolRounds, 2);
  assert.equal(budget.state.toolCalls, 3);
  assert.equal(budget.state.contextEpochRollovers, 3);
  assert.equal(budget.state.deadlineAt, restored.deadlineAt);
});

test('one child cannot exceed its own physical request limit even with tree capacity remaining', () => {
  const tree = new SharedUpstreamTokenBudget(10_000, 0);
  const rootDeadline = Date.now() + 30_000;
  const child = new LogicalRunBudget(undefined, {
    maxModelRequests: 1, maxToolRounds: 2, maxToolCalls: 2, maxContinuations: 1,
    maxContextEpochRollovers: 1, maxUpstreamTokens: 5_000, maxTreeUpstreamTokens: 10_000,
    maxContinuationOutputTokens: 8, maxContinuationOutputChars: 32
  }, tree, 300_000, Date.now(), rootDeadline);
  assert.equal(child.deadlineAt, rootDeadline, 'the child inherits the stricter root deadline');
  child.reservePhysicalRequest(100, 100);
  assert.throws(
    () => child.reservePhysicalRequest(100, 100),
    (error: unknown) => error instanceof LogicalBudgetExceededError
      && error.budgetReason === 'model_request_budget_exhausted'
  );
  assert.equal(child.state.modelRequests, 1);
});

test('a checkpoint storage failure is reported once without recursively persisting again', async () => {
  let persists = 0;
  await assert.rejects(
    () => new AgentRunner().run(request(), {
      onCheckpoint: async () => { persists += 1; throw new Error('EACCES primary checkpoint'); }
    }),
    /EACCES primary checkpoint/u
  );
  assert.equal(persists, 1);
});

function request(): AgentRequest {
  return {
    prompt: 'Inspect the workspace',
    model: { id: 'model', label: 'Model', provider: 'openai-compatible', sourceId: 'source', contextWindowTokens: 128_000 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [], history: [], language: 'en', requestProtocolVersion: 8,
    sourceConfig: { sourceId: 'source', provider: 'openai-compatible', baseUrl: 'https://example.invalid', apiKey: '', supportsBilling: false }
  };
}

function chatText(content: string, finishReason: string, usage?: Record<string, number>): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: finishReason }], usage })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}

function chatTool(id: string, name: string, args: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' }
  });
}
