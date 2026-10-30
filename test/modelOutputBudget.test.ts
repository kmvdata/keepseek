import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from './stubs/vscode';
import { AgentRunner } from '../src/agent/runner';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import { createModelCatalog } from '../src/accounts/modelCatalog';
import { ModelSourceStore } from '../src/accounts/accountStore';
import type { ModelSourceProvider } from '../src/accounts/types';
import type { AgentRequest, ContextUsageEstimate, ProviderUsageLedgerRecord } from '../src/shared/types';
import { checkpointCopy, normalizeRunCheckpoint, recoveryBlocker, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { getAgentRuntimeProfile } from '../src/shared/modelProfiles';
import { requestApprovalReviewText } from '../src/approvals/oneShotTextRequest';
import { calculateOutputBudget } from '../src/shared/outputBudget';
import { applyProviderRequestBudget, resolveProviderRequestBudget } from '../src/agent/requestBudget';
import { HistoryCompressor } from '../src/agent/historyCompressor';
import { ExecutionCostBudget } from '../src/agent/executionPolicy';
import { StreamParser } from '../src/agent/providers/streamParser';
import { isContextTooLongError } from '../src/agent/toolResultAdmission';

// Protocol fixtures, not captured production logs. All requests traverse the
// actual catalog -> runner -> transport serializer -> parser -> checkpoint path.
function request(provider: ModelSourceProvider = 'qwencloud', maxOutputTokens = 393192, sourceId = 'source'): AgentRequest {
  const model = createModelCatalog([{
    id: sourceId, name: sourceId, provider, enabled: true, baseUrl: 'https://fixture.invalid', apiKey: 'fixture-only-key',
    models: [{ id: 'deepseek-v4.1-flash-1017', maxOutputTokens, contextWindowTokens: 1024000 }],
    createdAt: 1, updatedAt: 1
  }])[0];
  return {
    model, prompt: 'Inspect the workspace and explain.', contextFiles: [], history: [], language: 'en', requestProtocolVersion: 8,
    settings: { thinkingEnabled: true, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    sourceConfig: { sourceId, provider, baseUrl: 'https://fixture.invalid', apiKey: 'fixture-only-key', supportsBilling: false }
  };
}
function chat(delta: Record<string, unknown>, finish = 'stop', completion = 3): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: completion, total_tokens: 100 + completion } })}\n\ndata: [DONE]\n\n`);
}
const tool = { index: 0, id: 'call-one', type: 'function', function: { name: 'keepseek_list_workspace_files', arguments: '{}' } };
function reply(provider: ModelSourceProvider, stage: 'tool' | 'length' | 'stop' | 'truncated', text = 'answer'): Response {
  if (provider === 'openai-responses') {
    const isTool = stage === 'tool' || stage === 'truncated';
    const output: Array<Record<string, unknown>> = isTool
      ? [{ type: 'function_call', id: 'fc-one', call_id: 'call-one', name: tool.function.name, arguments: stage === 'truncated' ? '{' : '{}', status: stage === 'truncated' ? 'incomplete' : 'completed' }]
      : [{ type: 'message', id: 'm-one', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }];
    if (stage === 'truncated') output.unshift({ type: 'function_call', id: 'fc-complete', call_id: 'call-complete',
      name: tool.function.name, arguments: '{}', status: 'completed' });
    const limited = stage === 'length' || stage === 'truncated';
    return new Response(`data: ${JSON.stringify({ type: limited ? 'response.incomplete' : 'response.completed', response: {
      status: limited ? 'incomplete' : 'completed', output,
      incomplete_details: limited ? { reason: 'max_output_tokens' } : undefined,
      usage: { input_tokens: 100, output_tokens: 3, total_tokens: 103 }
    } })}\n\n`);
  }
  if (provider === 'anthropic-compatible') {
    const isTool = stage === 'tool' || stage === 'truncated';
    const events = [
      { type: 'message_start', message: { id: 'm-one', role: 'assistant', usage: { input_tokens: 100 } } },
      { type: 'content_block_start', index: 0, content_block: isTool
        ? { type: 'tool_use', id: 'call-one', name: tool.function.name, input: {} }
        : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: isTool
        ? { type: 'input_json_delta', partial_json: stage === 'truncated' ? '{' : '{}' }
        : { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: stage === 'tool' ? 'tool_use' : stage === 'stop' ? 'end_turn' : 'max_tokens' }, usage: { output_tokens: 3 } },
      { type: 'message_stop' }
    ];
    if (stage === 'truncated') events.splice(1, 0,
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call-complete', name: tool.function.name, input: {} } },
      { type: 'content_block_stop', index: 1 });
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''));
  }
  return stage === 'tool' ? chat({ tool_calls: [tool] }, 'tool_calls')
    : stage === 'truncated' ? chat({ tool_calls: [tool, { ...tool, index: 1, id: 'call-two', function: { ...tool.function, arguments: '{"path":' } }] }, 'length')
      : chat({ content: text }, stage);
}

for (const provider of ['qwencloud', 'openai-responses', 'anthropic-compatible'] as const) {
  for (const limit of [393192, 32768, 8192]) {
    test(`${provider}: source model ${limit} reaches tool, answer and continuation wire payloads`, async () => {
      const original = globalThis.fetch;
      const bodies: Array<Record<string, unknown>> = [];
      const estimates: ContextUsageEstimate[] = [];
      let calls = 0;
      const workspace = new WorkspaceToolService();
      workspace.listWorkspaceFiles = async () => { calls++; return '{"ok":true,"files":[]}'; };
      globalThis.fetch = (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return reply(provider, bodies.length === 1 ? 'tool' : bodies.length === 2 ? 'length' : 'stop', bodies.length === 2 ? 'First part. ' : 'Second part.');
      }) as typeof fetch;
      try {
        const result = await new AgentRunner(workspace).run(request(provider, limit), { onUsageEstimate: (estimate) => estimates.push(estimate) });
        assert.equal(calls, 1);
        assert.equal(bodies.length, 3);
        assert.equal(result.message, 'First part. Second part.');
        for (const body of bodies) assert.equal(body[provider === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'], limit);
        assert.equal(estimates.at(-1)?.breakdown.outputReserveTokensEstimate, limit);
        assert.ok(result.runDetails.outputBudgets?.every((budget) => budget.actualMaxOutputTokens === limit && budget.capabilitySource === 'manual'));
      } finally { globalThis.fetch = original; }
    });
  }

  test(`${provider}: length-truncated mixed tool batch executes zero tools and retains usage`, async () => {
    const original = globalThis.fetch;
    let count = 0;
    let tools = 0;
    let checkpoint!: RunCheckpoint;
    const ledger: ProviderUsageLedgerRecord[] = [];
    const workspace = new WorkspaceToolService();
    workspace.listWorkspaceFiles = async () => { tools++; return '{}'; };
    globalThis.fetch = (async () => { count++; return reply(provider, 'truncated'); }) as typeof fetch;
    try {
      await assert.rejects(new AgentRunner(workspace).run(request(provider), {
        onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); }, onUsageLedgerRecord: (record) => ledger.push(record)
      }), /Output length limit/u);
      assert.equal(count, 1, 'semantic truncation is not a network retry');
      assert.equal(tools, 0);
      assert.equal(checkpoint.stopReason, 'output_truncated');
      assert.equal(checkpoint.outputFailure?.toolsExecuted, 0);
      assert.equal(checkpoint.outputFailure?.budget.actualMaxOutputTokens, 393192);
      assert.equal(checkpoint.state?.pending, undefined);
      assert.equal(ledger[0]?.usage?.totalTokens, 103);
      assert.ok(normalizeRunCheckpoint(checkpoint)?.outputFailure);
    } finally { globalThis.fetch = original; }
  });
}

test('structured legacy truncation migrates budget before dispatch without resetting task usage', async () => {
  const original = globalThis.fetch;
  let checkpoint!: RunCheckpoint;
  const bodies: Array<Record<string, unknown>> = [];
  let migrationPersisted = false;
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (bodies.length === 1) return reply('qwencloud', 'truncated');
    assert.equal(migrationPersisted, true);
    return reply('qwencloud', 'stop');
  }) as typeof fetch;
  try {
    const old = request('qwencloud', 8192);
    await assert.rejects(new AgentRunner().run(old, { onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); } }), /Output length limit/u);
    const taskId = checkpoint.taskId;
    const priorTokens = checkpoint.runBudget!.upstreamTokens;
    checkpoint.outputBudgetPolicyVersion = 1;
    checkpoint.outputFailure!.budget.policyVersion = 1;
    checkpoint = normalizeRunCheckpoint(checkpoint)!;
    const current = request();
    await new AgentRunner().run({ ...checkpoint.request, model: current.model, sourceConfig: current.sourceConfig, checkpoint }, {
      onCheckpoint: async (cp) => {
        if (cp.outputBudgetMigrations?.length) migrationPersisted = true;
        checkpoint = checkpointCopy(cp);
      }
    });
    assert.equal(bodies[0].max_tokens, 8192);
    assert.equal(bodies[1].max_tokens, 393192);
    assert.equal(checkpoint.taskId, taskId);
    assert.equal(checkpoint.runBudget?.modelRequests, 2);
    assert.ok(checkpoint.runBudget!.upstreamTokens >= priorTokens);
    assert.equal(checkpoint.outputBudgetMigrations?.[0].reason, 'larger_budget');
    assert.notEqual(checkpoint.outputBudgetMigrations?.[0].oldRequestHash, checkpoint.outputBudgetMigrations?.[0].newRequestHash);
  } finally { globalThis.fetch = original; }
});

test('at model cap, Continue changes generation strategy once and refuses identical failures', async () => {
  const original = globalThis.fetch;
  let checkpoint!: RunCheckpoint;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url, init) => { bodies.push(String(init?.body)); return reply('qwencloud', 'truncated'); }) as typeof fetch;
  const sourceConfig = request().sourceConfig;
  const save = async (cp: RunCheckpoint) => { checkpoint = checkpointCopy(cp); };
  try {
    await assert.rejects(new AgentRunner().run(request(), { onCheckpoint: save }), /Output length limit/u);
    await assert.rejects(new AgentRunner().run({ ...checkpoint.request, checkpoint: normalizeRunCheckpoint(checkpoint), sourceConfig }, { onCheckpoint: save }), /Output length limit/u);
    assert.equal(bodies.length, 2);
    assert.notEqual(bodies[0], bodies[1]);
    assert.ok(bodies[1].includes('at most one small complete tool call'));
    assert.equal(checkpoint.runBudget?.modelRequests, 2);
    assert.match(recoveryBlocker(checkpoint)!, /decomposition/u);
    await assert.rejects(new AgentRunner().run({ ...checkpoint.request, checkpoint, sourceConfig }), /decomposition/u);
    assert.equal(bodies.length, 2);
    const damaged = checkpointCopy(checkpoint);
    damaged.outputFailure!.toolsExecuted = 1 as 0;
    assert.equal(normalizeRunCheckpoint(damaged), undefined);
  } finally { globalThis.fetch = original; }
});

test('ambiguous old failure is not permission to change a frozen request', async () => {
  const original = globalThis.fetch;
  let checkpoint!: RunCheckpoint;
  globalThis.fetch = (async () => reply('qwencloud', 'truncated')) as typeof fetch;
  try {
    await assert.rejects(new AgentRunner().run(request(), { onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); } }));
    checkpoint.outputFailure = undefined;
    checkpoint.outputBudgetPolicyVersion = 1;
    checkpoint.error = 'Incomplete tool response';
    assert.match(recoveryBlocker(normalizeRunCheckpoint(checkpoint)!)!, /no structured/u);
    checkpoint.modelStepRequestHash = undefined;
    assert.match(recoveryBlocker(normalizeRunCheckpoint(checkpoint)!)!, /no structured/u);
  } finally { globalThis.fetch = original; }
});

test('same wire model in different accounts and DeepSeek thinking profiles retain manual capability', () => {
  assert.equal(request('qwencloud', 32768, 'one').model.maxOutputTokens, 32768);
  assert.equal(request('qwencloud', 8192, 'two').model.maxOutputTokens, 8192);
  for (const thinkingEnabled of [false, true]) for (const reasoningEffort of ['high', 'max'] as const) {
    assert.equal(getAgentRuntimeProfile(request('deepseek').model, { thinkingEnabled, reasoningEffort }).maxTokens, 393192);
  }
});

test('account-scoped values and non-manual capability sources survive the complete transport path', async () => {
  const original = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url, init) => { sent.push(JSON.parse(String(init?.body))); return chat({ content: 'done' }); }) as typeof fetch;
  try {
    for (const [sourceId, limit] of [['account-one', 32768], ['account-two', 8192]] as const) {
      await new AgentRunner().run(request('qwencloud', limit, sourceId));
      assert.equal(sent.at(-1)?.max_tokens, limit);
    }
    assert.equal(sent[0].model, sent[1].model);
    for (const capability of ['discovered', 'built-in', 'fallback'] as const) {
      const provider = capability === 'built-in' ? 'deepseek' : 'openai-compatible';
      const baseUrl = capability === 'built-in' ? 'https://api.deepseek.com' : 'https://fixture.invalid';
      const models = createModelCatalog([{
        id: capability, name: capability, provider, baseUrl, apiKey: 'fixture-only-key', enabled: true, createdAt: 1, updatedAt: 1,
        models: capability === 'fallback' ? [{ id: 'unknown-fixture-model' }] : [],
        modelCache: capability === 'discovered' ? { fetchedAt: 1, models: [{ id: 'discovered-model', contextWindowTokens: 1024000, maxOutputTokens: 32768 }] } : undefined
      }]);
      const model = models[0];
      assert.equal(model.maxOutputSource, capability);
      const input = request();
      const result = await new AgentRunner().run({ ...input, model,
        sourceConfig: { ...input.sourceConfig!, provider, sourceId: capability, baseUrl } });
      assert.equal(sent.at(-1)?.max_tokens, model.maxOutputTokens);
      assert.equal(result.runDetails.outputBudgets?.at(-1)?.capabilitySource, capability);
    }
  } finally { globalThis.fetch = original; }
});

test('request-relative capacity has no percentage cap or illegal positive floor', () => {
  const full = calculateOutputBudget({ modelMaxOutputTokens: 393192, effectiveWindowTokens: 1024000, estimatedInputTokens: 20000 });
  assert.equal(full.actualMaxOutputTokens, 393192);
  const small = calculateOutputBudget({ modelMaxOutputTokens: 8192, effectiveWindowTokens: 1000, estimatedInputTokens: 100 });
  assert.equal(small.limitSource, 'context_remaining');
  assert.equal(small.actualMaxOutputTokens + small.inputBudgetTokens + small.safetyTokens, 1000);
  const req = request();
  const body = { model: req.model.id, messages: [{ role: 'user' as const, content: 'x'.repeat(5000) }], stream: true as const };
  const budget = resolveProviderRequestBudget({ model: { ...req.model, contextWindowTokens: 1000 }, provider: 'qwencloud', body });
  assert.equal(budget.actualMaxOutputTokens, 0);
  assert.throws(() => applyProviderRequestBudget(body, budget), /Context capacity/u);
  assert.equal(isContextTooLongError(new Error('max_tokens must be at most 8192; model context window maximum is 1024000')), false);
});

test('reviewer real transport uses its own model cap across all protocols', async () => {
  const original = globalThis.fetch;
  try {
    for (const provider of ['qwencloud', 'openai-responses', 'anthropic-compatible'] as const) {
      let body: Record<string, unknown> = {};
      globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return reply(provider, 'stop', '{"decision":"deny"}'); }) as typeof fetch;
      const req = request(provider, 32768, 'reviewer-source');
      await requestApprovalReviewText({ model: req.model, sourceConfig: req.sourceConfig!, systemPrompt: 'review', userPrompt: 'evidence', language: 'en' });
      assert.equal(body[provider === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'], 32768);
      assert.equal(body.tools, undefined);
    }
  } finally { globalThis.fetch = original; }
});

test('long continuation keeps full text beyond legacy token-times-four and cumulative limits', async () => {
  const originalFetch = globalThis.fetch;
  const originalConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({
    get: <T>(key: string, fallback: T): T => key === 'agent.maxContinuations' ? 3 as T : fallback,
    update: async () => undefined
  });
  let calls = 0;
  let checkpoint!: RunCheckpoint;
  const parts = ['Start. ', 'a'.repeat(40000), 'b'.repeat(40000), 'End.'];
  globalThis.fetch = (async () => { const index = calls++; return chat({ content: parts[index] }, index === 3 ? 'stop' : 'length'); }) as typeof fetch;
  try {
    const response = await new AgentRunner().run(request('qwencloud', 8192), { onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); } });
    assert.equal(response.message, parts.join(''));
    assert.equal(calls, 4);
    assert.equal(checkpoint.runBudget?.continuations, 3);
    assert.ok(checkpoint.runBudget!.continuationOutputChars > 32768);
    assert.ok(normalizeRunCheckpoint(checkpoint));
  } finally { globalThis.fetch = originalFetch; vscode.workspace.getConfiguration = originalConfiguration; }
});

test('semantic recovery reuses completed tool evidence and keeps the task counters', async () => {
  const original = globalThis.fetch;
  let checkpoint!: RunCheckpoint;
  let requests = 0;
  let executions = 0;
  const workspace = new WorkspaceToolService();
  workspace.listWorkspaceFiles = async () => { executions++; return '{"ok":true,"files":[]}'; };
  globalThis.fetch = (async () => { requests++; return reply('qwencloud', requests === 1 ? 'tool' : requests === 2 ? 'truncated' : 'stop'); }) as typeof fetch;
  const initial = request();
  const save = async (cp: RunCheckpoint) => { checkpoint = checkpointCopy(cp); };
  try {
    await assert.rejects(new AgentRunner(workspace).run(initial, { onCheckpoint: save }), /Output length limit/u);
    const before = checkpoint.runBudget!.upstreamTokens;
    const result = await new AgentRunner(workspace).run({ ...checkpoint.request, sourceConfig: initial.sourceConfig, checkpoint: normalizeRunCheckpoint(checkpoint) }, { onCheckpoint: save });
    assert.equal(result.message, 'answer');
    assert.equal(executions, 1);
    assert.equal(checkpoint.runBudget?.modelRequests, 3);
    assert.equal(checkpoint.state?.toolCallCount, 1);
    assert.ok(checkpoint.runBudget!.upstreamTokens >= before);
  } finally { globalThis.fetch = original; }
});

test('continuation compaction preserves all generated text and counts only one continuation', async () => {
  const original = globalThis.fetch;
  const text = 'generated text '.repeat(12000);
  let checkpoint!: RunCheckpoint;
  let ordinary = 0;
  let summaries = 0;
  const workspace = new WorkspaceToolService();
  workspace.listWorkspaceFiles = async () => '{"ok":true,"files":[]}';
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    if (JSON.stringify(body).includes('Create a concise semantic checkpoint')) { summaries++; return chat({ content: 'Saved evidence summary.' }); }
    ordinary++;
    if (ordinary === 1) return reply('qwencloud', 'tool');
    if (ordinary === 2) return chat({ content: text }, 'length');
    assert.ok(JSON.stringify(body).includes(text));
    assert.ok(body.max_tokens <= 32768 && body.max_tokens > 0);
    return chat({ content: 'End.' });
  }) as typeof fetch;
  try {
    const input = request('qwencloud', 32768);
    input.model.contextWindowTokens = 90000;
    const result = await new AgentRunner(workspace).run(input, { onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); } });
    assert.equal(result.message, text + 'End.');
    assert.equal(checkpoint.runBudget?.continuations, 1);
    assert.equal(summaries, 1);
    assert.ok(checkpoint.state?.epoch?.rollovers.some((r) => r.reason === 'length_continuation'));
    assert.ok(normalizeRunCheckpoint(checkpoint));
  } finally { globalThis.fetch = original; }
});

test('summary transport uses its own configured model across all protocols and records the admitted snapshot', async () => {
  const original = globalThis.fetch;
  try {
    for (const provider of ['qwencloud', 'openai-responses', 'anthropic-compatible'] as const) {
      let body: Record<string, unknown> = {};
      globalThis.fetch = (async (_url, init) => { body = JSON.parse(String(init?.body)); return reply(provider, 'stop', 'Short summary.'); }) as typeof fetch;
      const input = request(provider, 32768, 'summary-source');
      const messages = Array.from({ length: 20 }, (_, i) => ({ id: `message-${i}`, role: i % 2 ? 'assistant' as const : 'user' as const,
        content: `message ${i} ` + 'content '.repeat(100), createdAt: '2026-10-30T00:00:00Z' }));
      const result = await new HistoryCompressor().refresh({
        session: { id: 'summary', title: 'Summary', messages, createdAt: '2026-10-30T00:00:00Z', updatedAt: '2026-10-30T00:00:00Z',
          workspaceKey: 'workspace', workspaceName: 'workspace', workspaceFolders: [], isFavorite: false },
        model: input.model, sourceConfig: input.sourceConfig, agentSettings: input.settings, contextFiles: [], prompt: 'current', language: 'en',
        settings: { keepRecentTurns: 1, softCompactRatio: 0.001, toolResultSnipRatio: 0.002, triggerRatio: 0.003, forceRatio: 0.004, summaryBudgetTokens: 100 }
      });
      assert.equal(result.reason, 'created');
      assert.equal(body[provider === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'], 32768);
      assert.equal(result.usageLedgerRecords?.[0].requestBudget?.sourceId, 'summary-source');
      assert.equal(result.usageLedgerRecords?.[0].requestBudget?.actualMaxOutputTokens, 32768);
    }
  } finally { globalThis.fetch = original; }
});

test('reviewer cannot bypass a positive task cost limit on an unpriceable source', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return chat({ content: 'unused' }); }) as typeof fetch;
  try {
    const input = request();
    await assert.rejects(requestApprovalReviewText({ model: input.model, sourceConfig: input.sourceConfig!, systemPrompt: 'review',
      userPrompt: 'evidence', language: 'en', taskCostBudget: new ExecutionCostBudget(1) }), /cannot be priced/u);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test('truncated tools drain a bounded usage tail without returning any executable call', async () => {
  let usage: unknown;
  let cancelled = false;
  const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ ...tool, function: { ...tool.function, arguments: '{' } }] }, finish_reason: 'length' }] })}\n\n`
    + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 } })}\n\n`);
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); }, cancel() { cancelled = true; } });
  await assert.rejects(new StreamParser().parse(stream, 'en', {}, { tailTimeoutMs: 10, onProgress: (progress) => { usage = progress.usage; } }), /Output length limit/u);
  assert.equal(cancelled, true);
  assert.deepEqual(usage, { prompt_tokens: 10, completion_tokens: 8192, total_tokens: 8202 });
});

test('configuration changes affect the next model round while a network retry keeps frozen bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-output-config-'));
  const storageUri = vscode.Uri.file(directory) as unknown as import('vscode').Uri;
  const store = new ModelSourceStore(storageUri);
  const original = globalThis.fetch;
  const input = request('qwencloud', 8192);
  await store.createSource({ id: 'source', name: 'fixture', provider: 'qwencloud', baseUrl: 'https://fixture.invalid', apiKey: 'fixture-only-key',
    models: [{ id: input.model.id, maxOutputTokens: 8192, contextWindowTokens: 1024000 }] });
  const bodies: string[] = [];
  const workspace = new WorkspaceToolService();
  workspace.listWorkspaceFiles = async () => '{}';
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    if (bodies.length === 1) {
      await store.updateSource('source', { models: [{ id: input.model.id, maxOutputTokens: 32768, contextWindowTokens: 1024000 }] });
      return new Response('temporary', { status: 502 });
    }
    return reply('qwencloud', bodies.length === 2 ? 'tool' : 'stop');
  }) as typeof fetch;
  try {
    await new AgentRunner(workspace, undefined, undefined, undefined, undefined, undefined, storageUri).run(input);
    assert.equal(bodies[0], bodies[1]);
    assert.deepEqual(bodies.map((body) => JSON.parse(body).max_tokens), [8192, 8192, 32768]);
  } finally { globalThis.fetch = original; await rm(directory, { recursive: true, force: true }); }
});

test('standalone summaries do not spend outside a configured task cost ledger', async () => {
  const original = vscode.workspace.getConfiguration;
  const originalFetch = globalThis.fetch;
  let calls = 0;
  vscode.workspace.getConfiguration = () => ({ get: <T>(key: string, fallback: T): T => key === 'agent.maxCost' ? 1 as T : fallback,
    update: async () => undefined, inspect: () => undefined }) as ReturnType<typeof vscode.workspace.getConfiguration>;
  globalThis.fetch = (async () => { calls++; return chat({ content: 'unused' }); }) as typeof fetch;
  try {
    const input = request();
    const compressor = new HistoryCompressor() as unknown as { completeSummary(input: object): Promise<unknown> };
    await assert.rejects(compressor.completeSummary({ model: input.model, sourceConfig: input.sourceConfig, messages: [{ role: 'user', content: 'summarize' }],
      maxTokens: 100, language: 'en', usageSource: 'summary' }), /no shared task cost reservation/u);
    assert.equal(calls, 0);
  } finally { vscode.workspace.getConfiguration = original; globalThis.fetch = originalFetch; }
});
