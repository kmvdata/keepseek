import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { AgentRunner } from '../src/agent/runner';
import { ExecutionCostBudget, LogicalBudgetExceededError } from '../src/agent/executionPolicy';
import { AgentInterruptedError, checkpointCopy, createRunCheckpoint, normalizeRunCheckpoint, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { normalizeDeepSeekUsage } from '../src/agent/usageStats';
import { normalizeUsageLedgerValue } from '../src/agent/usageLedger';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import type { AgentActivityInput, AgentRequest, ProviderUsageLedgerRecord } from '../src/shared/types';

function input(): AgentRequest {
  return {
    prompt: 'Inspect the workspace', contextFiles: [], history: [], language: 'en', requestProtocolVersion: 8,
    model: { id: 'model', label: 'Model', provider: 'openai-compatible', sourceId: 'source', contextWindowTokens: 128_000 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    sourceConfig: { sourceId: 'source', provider: 'openai-compatible', baseUrl: 'https://example.invalid', apiKey: '', supportsBilling: false }
  };
}
function reply(delta: Record<string, unknown>, finishReason: string, usage?: Record<string, number>): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finishReason }], usage })}\n\ndata: [DONE]\n\n`);
}
function partial(usage?: Record<string, number>): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'FAILED PARTIAL' }, finish_reason: null }], usage })}\n\n`);
}
async function fastRetries(work: () => Promise<void>): Promise<void> {
  const configuration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: <T>(key: string, fallback: T): T => key === 'requestRetryBaseMs' ? 0 as T : fallback,
    update: async () => undefined
  });
  try { await work(); } finally { vscode.workspace.getConfiguration = configuration; }
}

test('replays the frozen current model round without rerunning completed tool evidence or committing partial output', async () => fastRetries(async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  const statuses: AgentActivityInput[] = [];
  const records: ProviderUsageLedgerRecord[] = [];
  let checkpoint!: RunCheckpoint;
  let toolCount = 0;
  let roundStarts = 0;
  let resets = 0;
  const workspace = new WorkspaceToolService();
  workspace.listWorkspaceFiles = async () => { toolCount++; return '{"ok":true,"files":[]}'; };
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) return reply({ tool_calls: [{ index: 0, id: 'tool-one', type: 'function', function: { name: 'keepseek_list_workspace_files', arguments: '{}' } }] }, 'tool_calls');
    if (bodies.length === 2) return partial({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    return reply({ content: 'final answer' }, 'stop', { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
  }) as typeof fetch;
  try {
    const request = input();
    const history = JSON.stringify(request.history);
    const response = await new AgentRunner(workspace).run(request, {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); },
      onStatus: (status) => statuses.push(status), onUsageLedgerRecord: (record) => records.push(record),
      onModelRoundStart: () => { roundStarts++; }, onAttemptReset: () => { resets++; }
    });
    assert.equal(response.message, 'final answer');
    assert.equal(toolCount, 1);
    assert.equal(bodies.length, 3);
    assert.equal(bodies[1], bodies[2]);
    assert.ok(!bodies[2].includes('FAILED PARTIAL'));
    assert.equal(JSON.stringify(request.history), history);
    assert.equal(checkpoint.retries, 1);
    assert.equal(checkpoint.modelStepAttempts, 0);
    assert.equal(checkpoint.runBudget?.modelRequests, 3);
    assert.equal(checkpoint.state?.toolRounds.length, 1);
    assert.equal(roundStarts, 2);
    assert.equal(resets, 1);
    assert.equal(statuses.find((status) => status.phase === 'reconnecting')?.reconnectAttempt, 1);
    assert.equal(records.length, 3);
    assert.equal(records[1].usage?.totalTokens, 12, 'usage before an incomplete EOF is retained');
    assert.equal(records[2].usage?.totalTokens, 13);
    assert.notEqual(records[1].requestId, records[0].requestId);
    assert.equal(records[1].requestId, records[2].requestId);
    assert.equal(records[2].attemptIndex, 1);
  } finally { globalThis.fetch = originalFetch; }
}));

test('six dispatches exhaust a round and Continue/restart cannot reset its reconnect allowance', async () => fastRetries(async () => {
  const originalFetch = globalThis.fetch;
  let dispatches = 0;
  let checkpoint!: RunCheckpoint;
  globalThis.fetch = (async () => { dispatches++; throw new TypeError('fetch failed'); }) as typeof fetch;
  const request = input();
  try {
    await assert.rejects(new AgentRunner().run(request, { onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); } }), /5 reconnects/u);
    assert.equal(dispatches, 6);
    assert.equal(checkpoint.modelStepAttempts, 6);
    assert.equal(checkpoint.modelStepRetries, 5);
    assert.equal(checkpoint.retries, 5);
    assert.equal(checkpoint.runBudget?.modelRequests, 6);
    const recovered = normalizeRunCheckpoint(checkpoint)!;
    assert.equal(recovered.modelStepAttempts, 6);
    await assert.rejects(new AgentRunner().run({ ...recovered.request, sourceConfig: request.sourceConfig, checkpoint: recovered }), /5 reconnects/u);
    assert.equal(dispatches, 6);
  } finally { globalThis.fetch = originalFetch; }
}));

test('cancellation during backoff persists consumed requests and resuming consumes the next reconnect', async () => fastRetries(async () => {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let checkpoint!: RunCheckpoint;
  let dispatches = 0;
  globalThis.fetch = (async () => { dispatches++; throw new TypeError('fetch failed'); }) as typeof fetch;
  const request = input();
  try {
    await assert.rejects(new AgentRunner().run({ ...request, signal: controller.signal }, {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); },
      onStatus: (status) => { if (status.phase === 'reconnecting') controller.abort(); }
    }));
    assert.equal(dispatches, 1);
    assert.equal(checkpoint.modelStepAttempts, 1);
    assert.equal(checkpoint.modelStepRetries, 0);
    globalThis.fetch = (async () => { dispatches++; return reply({ content: 'recovered' }, 'stop'); }) as typeof fetch;
    const recovered = normalizeRunCheckpoint(checkpoint)!;
    const response = await new AgentRunner().run({ ...recovered.request, sourceConfig: request.sourceConfig, checkpoint: recovered }, {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); }
    });
    assert.equal(response.message, 'recovered');
    assert.equal(dispatches, 2);
    assert.equal(checkpoint.retries, 1);
    assert.equal(checkpoint.runBudget?.modelRequests, 2);
  } finally { globalThis.fetch = originalFetch; }
}));

test('recovery fails closed if generation parameters changed after interruption', async () => fastRetries(async () => {
  const originalFetch = globalThis.fetch;
  let checkpoint!: RunCheckpoint;
  let sends = 0;
  const controller = new AbortController();
  const request = input();
  request.model.provider = 'qwencloud';
  request.sourceConfig = { ...request.sourceConfig!, provider: 'qwencloud', apiKey: 'test-key' };
  globalThis.fetch = (async () => { sends++; throw new TypeError('fetch failed'); }) as typeof fetch;
  try {
    await assert.rejects(new AgentRunner().run({ ...request, signal: controller.signal }, {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); },
      onStatus: (status) => { if (status.phase === 'reconnecting') controller.abort(); }
    }));
    checkpoint.request.settings.thinkingEnabled = true;
    await assert.rejects(new AgentRunner().run({ ...checkpoint.request, sourceConfig: request.sourceConfig, checkpoint }),
      (error: unknown) => error instanceof AgentInterruptedError && /exact recovery/u.test(error.message));
    assert.equal(sends, 1);
  } finally { globalThis.fetch = originalFetch; }
}));

test('checkpoint reconnect migration retains spent allowance and rejects malformed counts or hashes', () => {
  const cp = createRunCheckpoint(input(), 0, 'test', []);
  cp.modelStepRetries = 3;
  const normalized = normalizeRunCheckpoint(cp)!;
  assert.equal(normalized.modelStepAttempts, 4);
  assert.equal(normalized.modelStepRetries, 3);
  for (const modelStepAttempts of [-1, 1.5, 7, NaN]) assert.equal(normalizeRunCheckpoint({ ...cp, modelStepAttempts }), undefined);
  assert.equal(normalizeRunCheckpoint({ ...cp, modelStepRequestHash: 'broken' }), undefined);
});

test('parallel cost reservations, unknown attempts and restart cannot spend the same remaining ceiling', () => {
  const budget = new ExecutionCostBudget(1);
  const first = budget.reserve(0.6, '¥');
  assert.throws(() => budget.reserve(0.6, '¥'), LogicalBudgetExceededError);
  budget.settle(first);
  assert.deepEqual(budget.snapshot(), { '¥': 0.6 });
  const restored = new ExecutionCostBudget(1, budget.snapshot());
  assert.throws(() => restored.reserve(0.5, '¥'), LogicalBudgetExceededError);
  budget.settle(first, 0.1);
  budget.reserve(0.6, '¥');
  assert.ok(Math.abs(budget.snapshot()['¥'] - 0.7) < 1e-12);
});


test('reconnect allowance resets only alongside a durable complete model result', async () => fastRetries(async () => {
  const originalFetch = globalThis.fetch;
  const checkpoints: RunCheckpoint[] = [];
  globalThis.fetch = (async () => reply({ content: 'complete' }, 'stop', { prompt_tokens: 10, completion_tokens: 3 })) as typeof fetch;
  try {
    await new AgentRunner().run(input(), { onCheckpoint: async (next) => { checkpoints.push(checkpointCopy(next)); } });
    const dispatched = checkpoints.filter((cp) => (cp.runBudget?.modelRequests ?? 0) > 0);
    assert.ok(dispatched.some((cp) => cp.modelStepAttempts === 1 && !cp.state?.pending));
    for (const cp of dispatched) {
      if (cp.modelStepAttempts === 0) assert.equal(cp.state?.pending?.response.message.content, 'complete');
    }
  } finally { globalThis.fetch = originalFetch; }
}));

test('a failed in-flight length continuation restores the same request and its consumed continuation quota', async () => fastRetries(async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  let checkpoint!: RunCheckpoint;
  const controller = new AbortController();
  const request = input();
  request.executionLimits = { maxContinuations: 1, maxModelRequests: 8 };
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1 ? reply({ content: 'first-' }, 'length') : partial();
  }) as typeof fetch;
  try {
    await assert.rejects(new AgentRunner().run({ ...request, signal: controller.signal }, {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); },
      onStatus: (status) => { if (status.phase === 'reconnecting') controller.abort(); }
    }));
    assert.equal(checkpoint.state?.continuation?.inFlight, true);
    assert.equal(checkpoint.runBudget?.continuations, 1);
    assert.equal(checkpoint.modelStepAttempts, 1);
    globalThis.fetch = (async (_url, init) => { bodies.push(String(init?.body)); return reply({ content: 'second' }, 'stop'); }) as typeof fetch;
    const recovered = normalizeRunCheckpoint(checkpoint)!;
    const response = await new AgentRunner().run({ ...recovered.request, checkpoint: recovered, sourceConfig: request.sourceConfig }, {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); }
    });
    assert.equal(response.message, 'first-second');
    assert.equal(bodies.length, 3);
    assert.equal(bodies[1], bodies[2]);
    assert.equal(checkpoint.runBudget?.continuations, 1);
    assert.equal(checkpoint.runBudget?.modelRequests, 3);
    assert.equal(checkpoint.retries, 1);
  } finally { globalThis.fetch = originalFetch; }
}));

test('empty or partial usage stays unknown and never refunds token or positive cost reservations', async () => fastRetries(async () => {
  assert.equal(normalizeDeepSeekUsage({}), undefined);
  assert.equal(normalizeDeepSeekUsage({ prompt_tokens: 10 }), undefined);
  assert.equal(normalizeDeepSeekUsage({ prompt_tokens: 10, completion_tokens: NaN }), undefined);
  const originalFetch = globalThis.fetch;
  let checkpoint!: RunCheckpoint;
  const records: ProviderUsageLedgerRecord[] = [];
  const request = input();
  request.model = { id: 'deepseek-v4-flash', label: 'DeepSeek', provider: 'deepseek', sourceId: 'source', contextWindowTokens: 1_000_000, maxOutputTokens: 4_000 };
  request.sourceConfig = { ...request.sourceConfig!, provider: 'deepseek', apiKey: 'test', supportsBilling: true };
  request.executionLimits = { maxCost: 10 };
  globalThis.fetch = (async () => reply({ content: 'complete' }, 'stop', { prompt_tokens: 10 })) as typeof fetch;
  try {
    await new AgentRunner().run(request, {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); },
      onUsageLedgerRecord: (record) => records.push(record)
    });
    assert.ok((checkpoint.usedCostByCurrency?.['¥'] ?? 0) > 0);
    assert.ok((checkpoint.runBudget?.upstreamTokens ?? 0) > 10);
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'attempt_without_usage');
    assert.equal(records[0].usage, undefined);
    assert.deepEqual(records[0].observedUsage, { promptTokens: 10 });
    assert.equal(records[0].pricingStatus, 'unavailable');
    const normalized = normalizeUsageLedgerValue({ version: 1, records, legacyAggregate: false, incomplete: false });
    assert.equal(normalized?.records[0].observedUsage?.completionTokens, undefined);
    assert.deepEqual(normalized?.records[0].observedUsage, { promptTokens: 10 });
  } finally { globalThis.fetch = originalFetch; }
}));

test('unknown failed attempts cannot exceed the remaining cost ceiling by reconnecting', async () => fastRetries(async () => {
  const originalFetch = globalThis.fetch;
  let checkpoint!: RunCheckpoint;
  let sends = 0;
  const request = input();
  request.model = { id: 'deepseek-v4-flash', label: 'DeepSeek', provider: 'deepseek', sourceId: 'source', contextWindowTokens: 1_000_000, maxOutputTokens: 4_000 };
  request.sourceConfig = { ...request.sourceConfig!, provider: 'deepseek', apiKey: 'test', supportsBilling: true };
  request.executionLimits = { maxCost: 2.1 };
  globalThis.fetch = (async () => { sends++; throw new TypeError('fetch failed'); }) as typeof fetch;
  try {
    await assert.rejects(new AgentRunner().run(request, { onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); } }),
      (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'cost_limit');
    assert.ok(sends >= 1 && sends <= 2);
    assert.ok((checkpoint.usedCostByCurrency?.['¥'] ?? 0) > 0);
    assert.ok((checkpoint.usedCostByCurrency?.['¥'] ?? 0) <= 2.1);
    assert.equal(checkpoint.runBudget?.modelRequests, sends);
    const restored = normalizeRunCheckpoint(checkpoint)!;
    await assert.rejects(new AgentRunner().run({ ...restored.request, checkpoint: restored, sourceConfig: request.sourceConfig }));
    assert.equal(checkpoint.runBudget?.modelRequests, sends);
  } finally { globalThis.fetch = originalFetch; }
}));

test('a terminal response containing damaged DSML never executes a tool, commits replay, or retries a protocol error', async () => fastRetries(async () => {
  const originalFetch = globalThis.fetch;
  const workspace = new WorkspaceToolService();
  let sends = 0;
  let tools = 0;
  let resets = 0;
  let checkpoint!: RunCheckpoint;
  workspace.listWorkspaceFiles = async () => { tools++; return '{}'; };
  globalThis.fetch = (async () => {
    sends++;
    return reply({ content: '<||DSML||tool_calls><||DSML||invoke name="keepseek_list_workspace_files"></||DSML||tool_calls>' }, 'stop');
  }) as typeof fetch;
  try {
    await assert.rejects(new AgentRunner(workspace).run(input(), {
      onCheckpoint: async (next) => { checkpoint = checkpointCopy(next); },
      onAttemptReset: () => { resets++; }
    }), (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'provider_error');
    assert.equal(sends, 1);
    assert.equal(tools, 0);
    assert.equal(resets, 1);
    assert.equal(checkpoint.state?.toolRounds.length, 0);
    assert.equal(checkpoint.state?.pending, undefined);
    assert.equal(checkpoint.state?.completedReplay, undefined);
    assert.equal(checkpoint.modelStepAttempts, 1);
  } finally { globalThis.fetch = originalFetch; }
}));
