import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { SubagentSettingsStore } from '../src/accounts/subagentSettingsStore';
import { AgentLoop, AgentRunner } from '../src/agent/runner';
import { estimateDeepSeekMessageTokens } from '../src/agent/protocol';
import { createContextUsageEstimateFromAnthropic, createContextUsageEstimateFromResponses } from '../src/agent/contextUsage';
import { createProviderClient } from '../src/agent/providers/factory';
import { SubagentRuntime } from '../src/agent/subagents/runtime';
import { SubagentStore } from '../src/agent/subagents/store';
import type { SubagentToolAdapter } from '../src/agent/subagents/types';
import { createUsageEvent } from '../src/agent/usageStats';
import type { AgentRequest, ContextUsageEstimate, SubagentHandoffEstimate, SubagentRunUsageSummary, UsageEvent } from '../src/shared/types';

const toolNames = ['keepseek_delegate_task', 'keepseek_delegate_parallel', 'keepseek_read_subagent_result'];
const calls = toolNames.map((name, index) => ({
  id: 'tool-' + index, type: 'function' as const,
  function: { name, arguments: JSON.stringify(index === 0 ? { task: 'Inspect a bounded surface.' }
    : index === 1 ? { tasks: [{ task: 'Inspect a different surface.' }] }
      : { subagentId: 'sa_child', offset: 100 }) }
}));

test('fixed-model resolution failures show the requested model, never an apparent parent-model fallback', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-missing-model-'));
  const summaries: SubagentRunUsageSummary[] = [];
  try {
    const uri = vscode.Uri.file(directory);
    await new SubagentSettingsStore(uri, 'test').save({ mode: 'fixed', sourceId: 'missing-account', modelId: 'fixed-child-model' });
    await new SubagentRuntime({ globalStorageUri: uri, workspaceKey: 'test', sourceStore: new ModelSourceStore(uri) })
      .delegateTask({ task: 'Research' }, { parentRequest: parentRequest(), parentRunId: 'root', language: 'en',
        onRunSummary: (summary) => summaries.push(summary) });
    assert.equal(summaries[0].sourceId, 'missing-account');
    assert.equal(summaries[0].modelId, 'fixed-child-model');
    assert.equal(summaries[0].status, 'failed');
    assert.equal(summaries[0].usage, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('root runner observes all three final accepted tool messages without changing Provider request bytes', async () => {
  const observed: SubagentHandoffEstimate[] = [];
  const estimates: ContextUsageEstimate[] = [];
  const baseline = await runParent({});
  const instrumented = await runParent({ onSubagentHandoffEstimate: (event) => observed.push(event), onUsageEstimate: (value) => estimates.push(value) });
  assert.deepEqual(instrumented.bodies, baseline.bodies);
  assert.equal(observed.length, 3);
  assert.deepEqual(observed.map((item) => item.kind), ['delegate', 'parallel', 'read-result']);
  const toolMessages = JSON.parse(instrumented.bodies[1]).messages.filter((message: { role: string }) => message.role === 'tool');
  assert.deepEqual(observed.map((item) => item.tokensEstimate), toolMessages.map(estimateDeepSeekMessageTokens));
  assert.ok(estimates.at(-1)!.breakdown.toolCallTokensEstimate > 0);
  assert.ok(estimates.at(-1)!.breakdown.toolResultTokensEstimate > 0, 'final Provider calibration preserves intermediate categories');
});

test('root runner does not count results rejected by the tool-token budget or context-window budget', async () => {
  for (const contentLength of [50_000, 400_000]) {
    const observed: SubagentHandoffEstimate[] = [];
    const result = await runParent({ onSubagentHandoffEstimate: (event) => observed.push(event) }, {
      result: JSON.stringify({ ok: true, result: '中'.repeat(contentLength) }), contextWindowTokens: 64_000
    });
    assert.equal(observed.length, 0);
    assert.match(JSON.stringify(result.response.toolRounds), /tool_result_budget_exhausted/u);
  }
});

test('nested runner results never enter the root handoff counter', async () => {
  const observed: SubagentHandoffEstimate[] = [];
  const result = await runParent({ onSubagentHandoffEstimate: (event) => observed.push(event) }, { nested: true });
  assert.equal(observed.length, 0);
  assert.equal(result.response.toolRounds?.[0].toolResults.length, 3);
});

test('Responses, Anthropic, and DSML handoffs use the final native context representation and keep requests byte-stable', async () => {
  for (const format of ['responses', 'anthropic', 'dsml'] as const) {
    const observed: SubagentHandoffEstimate[] = [];
    const baseline = await runParent({}, { format });
    const observedRun = await runParent({ onSubagentHandoffEstimate: (event) => observed.push(event) }, { format });
    assert.deepEqual(observedRun.bodies, baseline.bodies, format);
    assert.equal(observed.length, 3, format);
    const body = JSON.parse(observedRun.bodies[1]);
    let expected: number;
    if (format === 'responses') {
      const estimate = (input: typeof body.input) => createContextUsageEstimateFromResponses({
        model: parentRequest().model, input, outputReserveTokens: 0, safetyReserveTokens: 0
      }).usedTokensEstimate;
      expected = estimate(body.input) - estimate(body.input.filter((item: { type: string }) => item.type !== 'function_call_output'));
    } else if (format === 'anthropic') {
      const estimate = (messages: typeof body.messages) => createContextUsageEstimateFromAnthropic({
        model: parentRequest().model, system: body.system, messages, outputReserveTokens: 0, safetyReserveTokens: 0
      }).usedTokensEstimate;
      expected = estimate(body.messages) - estimate(body.messages.slice(0, -1));
    } else {
      const wrapper = body.messages.find((message: { role: string; content: string }) => message.role === 'user'
        && message.content.includes('KeepSeek executed the DSML tool requests'));
      assert.ok(wrapper);
      expected = estimateDeepSeekMessageTokens(wrapper);
    }
    assert.equal(observed.reduce((sum, event) => sum + event.tokensEstimate, 0), expected, format);
  }
});

test('failed Provider responses with usage are observed; unreported retry attempts are not invented usage', async () => {
  const client = createProviderClient('openai-compatible');
  const original = client.createModelResponse;
  const events: UsageEvent[] = [];
  client.createModelResponse = async () => ({ ok: false, hadPartialOutput: false, retryable: false,
    error: 'Failed after reporting usage', retryCount: 2,
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
  try {
    await assert.rejects(new AgentRunner().run(parentRequest(), { onUsage: (event) => events.push(event) }));
    assert.equal(events.length, 1);
    assert.equal(events[0].usage.totalTokens, 110);
    assert.equal(events[0].requestCount, 1);
    assert.equal(events[0].source, 'executor');
  } finally { client.createModelResponse = original; }
});

test('failed and stopped children retain earlier Provider usage, local estimates, and stored statistics', async () => {
  for (const status of ['failed', 'stopped'] as const) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-child-usage-'));
    const abort = new AbortController();
    const originalFetch = globalThis.fetch;
    const summaries: SubagentRunUsageSummary[] = [];
    const events: UsageEvent[] = [];
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        return sse({ tool_calls: [{ index: 0, id: 'internal-read', type: 'function', function: {
          name: 'keepseek_read_workspace_file_range', arguments: '{"path":"missing.ts","startLine":1,"endLine":10}'
        } }], reasoning_content: 'Private internal reasoning.' }, 'tool_calls');
      }
      if (status === 'stopped') { abort.abort(); }
      return new Response('provider stopped after billed work', { status: 400 });
    }) as typeof fetch;
    try {
      const uri = vscode.Uri.file(directory);
      const runtime = new SubagentRuntime({ globalStorageUri: uri, workspaceKey: 'test', sourceStore: new ModelSourceStore(uri) });
      const execution = await runtime.delegateTask({ task: 'PRIVATE child task', profile: 'research' }, {
        parentRequest: parentRequest(), parentRunId: 'root', language: 'en', signal: abort.signal,
        onRunSummary: (summary) => summaries.push(summary), onUsage: (event) => events.push(event)
      });
      assert.equal(JSON.parse(execution.content).errorType, 'subagent_' + status);
      assert.equal(summaries.length, 1);
      assert.equal(summaries[0].status, status);
      assert.equal(summaries[0].usage?.totalTokens, 110);
      assert.equal(summaries[0].usage?.requestCount, 1);
      assert.equal(summaries[0].usage?.unpricedRequestCount, 1);
      assert.equal(events[0].source, 'subagent');
      assert.ok(summaries[0].isolatedIntermediateTokensEstimate > 0);
      const stored = await new SubagentStore(uri, 'test').read('session-one', summaries[0].subagentId);
      assert.equal(stored?.metadata.stats?.usage?.totalTokens, 110);
      const page = await new SubagentStore(uri, 'test').readResultPage({ parentSessionId: 'session-one', subagentId: summaries[0].subagentId });
      assert.equal(page.usage, undefined, 'new statistics must not change the historic tool-result serializer');
      assert.equal(page.stats, undefined);
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('nested Provider events forward once but are not counted in both ancestor and descendant summaries', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-nested-usage-'));
  const originalRun = AgentLoop.prototype.run;
  const summaries: SubagentRunUsageSummary[] = [];
  const events: UsageEvent[] = [];
  const own = createUsageEvent({ usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110, cacheHitTokens: 50, cacheMissTokens: 50 },
    source: 'executor', sourceId: 'account-main', modelId: 'model-main', provider: 'openai-compatible', cost: 0, currency: '' });
  const nested = { ...own, source: 'subagent' as const, sourceId: 'account-child', modelId: 'model-child' };
  AgentLoop.prototype.run = async (_request, callbacks = {}) => {
    callbacks.onUsage?.(own);
    callbacks.onUsage?.(nested);
    throw new Error('Failure after nested work');
  };
  try {
    const uri = vscode.Uri.file(directory);
    const runtime = new SubagentRuntime({ globalStorageUri: uri, workspaceKey: 'test', sourceStore: new ModelSourceStore(uri) });
    await runtime.delegateTask({ task: 'Research' }, {
      parentRequest: parentRequest(), parentRunId: 'root', language: 'en',
      onRunSummary: (summary) => summaries.push(summary), onUsage: (event) => events.push(event)
    });
    assert.equal(summaries[0].usage?.totalTokens, 110);
    assert.equal(events.reduce((total, event) => total + event.usage.totalTokens, 0), 220);
    assert.equal(events.length, 2);
  } finally {
    AgentLoop.prototype.run = originalRun;
    await rm(directory, { recursive: true, force: true });
  }
});

test('child uses its last valid estimate, not the largest or invalid later sample', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-estimate-'));
  const originalRun = AgentLoop.prototype.run;
  const summaries: SubagentRunUsageSummary[] = [];
  AgentLoop.prototype.run = async (_request, callbacks = {}) => {
    for (const tokens of [100, 40, NaN]) {
      callbacks.onUsageEstimate?.({ breakdown: { toolCallTokensEstimate: tokens,
        toolResultTokensEstimate: tokens, reasoningTokensEstimate: tokens } } as ContextUsageEstimate);
    }
    throw new Error('Ended');
  };
  try {
    const uri = vscode.Uri.file(directory);
    await new SubagentRuntime({ globalStorageUri: uri, workspaceKey: 'test', sourceStore: new ModelSourceStore(uri) })
      .delegateTask({ task: 'Research' }, { parentRequest: parentRequest(), parentRunId: 'root', language: 'en',
        onRunSummary: (summary) => summaries.push(summary) });
    assert.equal(summaries[0].isolatedIntermediateTokensEstimate, 120);
  } finally {
    AgentLoop.prototype.run = originalRun;
    await rm(directory, { recursive: true, force: true });
  }
});

async function runParent(callbacks: Parameters<AgentRunner['run']>[1], options: {
  nested?: boolean; result?: string; contextWindowTokens?: number; format?: 'responses' | 'anthropic' | 'dsml';
} = {}) {
  const bodies: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    bodies.push(String(init?.body));
    if (options.format === 'responses' || options.format === 'anthropic') {
      return nativeSse(options.format, bodies.length === 1);
    }
    if (options.format === 'dsml' && bodies.length === 1) {
      const content = '<||DSML||tool_calls>' + calls.map((call) => '<||DSML||invoke name="' + call.function.name + '">'
        + Object.entries(JSON.parse(call.function.arguments)).map(([key, value]) => '<||DSML||parameter name="' + key
          + '" string="' + (typeof value === 'string') + '">' + (typeof value === 'string' ? value : JSON.stringify(value))
          + '</||DSML||parameter>').join('') + '</||DSML||invoke>').join('') + '</||DSML||tool_calls>';
      return sse({ content }, 'stop');
    }
    return bodies.length === 1
      ? sse({ tool_calls: calls.map((call, index) => ({ ...call, index })) }, 'tool_calls')
      : sse({ content: 'Done.' }, 'stop');
  }) as typeof fetch;
  const execution = { content: options.result ?? JSON.stringify({ ok: true, result: 'Compact result', subagentId: 'sa_child' }) };
  const adapter: SubagentToolAdapter = {
    delegateTask: async () => execution, delegateParallel: async () => execution, readResult: async () => execution
  };
  try {
    const request = parentRequest();
    if (options.format === 'responses' || options.format === 'anthropic') {
      const provider = options.format === 'responses' ? 'openai-responses' : 'anthropic-compatible';
      request.model.provider = provider;
      request.sourceConfig = { ...request.sourceConfig!, provider };
    }
    if (options.contextWindowTokens) { request.model.contextWindowTokens = options.contextWindowTokens; }
    if (options.nested) {
      request.subagentContext = { id: 'sa_ancestor', parentSessionId: 'session-one', parentRunId: 'parent', rootRunId: 'root',
        treeId: 'tree', depth: 1, profile: 'research', lane: 'research-read' };
    }
    const response = await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined, undefined, adapter).run(request, callbacks);
    return { response, bodies };
  } finally { globalThis.fetch = originalFetch; }
}

function parentRequest(): AgentRequest {
  return {
    prompt: 'Investigate this bounded question.',
    model: { id: 'model-main', label: 'Main', sourceId: 'account-main', provider: 'openai-compatible', contextWindowTokens: 64_000, maxOutputTokens: 2_000 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    history: [], contextFiles: [], language: 'en', sessionId: 'session-one', requestProtocolVersion: 5,
    sourceConfig: { sourceId: 'account-main', provider: 'openai-compatible', baseUrl: 'https://provider.invalid/v1', apiKey: 'test-key', supportsBilling: false },
    executionLimits: { maxToolIterations: 2 }
  };
}

function sse(delta: object, finish_reason: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason }], usage: {
    prompt_tokens: 100, completion_tokens: 10, total_tokens: 110
  } })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function nativeSse(format: 'responses' | 'anthropic', toolTurn: boolean): Response {
  let events: object[];
  if (format === 'responses') {
    events = [{ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
      output: toolTurn ? calls.map((call) => ({ type: 'function_call', id: 'fc-' + call.id, call_id: call.id,
        name: call.function.name, arguments: call.function.arguments }))
        : [{ type: 'message', id: 'final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] }]
    } }];
  } else {
    events = [{ type: 'message_start', message: { usage: { input_tokens: 100 } } }];
    const blocks = toolTurn ? calls.map((call) => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) }))
      : [{ type: 'text', text: 'Done.' }];
    blocks.forEach((content_block, index) => events.push({ type: 'content_block_start', index, content_block }, { type: 'content_block_stop', index }));
    events.push({ type: 'message_delta', delta: { stop_reason: toolTurn ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } }, { type: 'message_stop' });
  }
  return new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
