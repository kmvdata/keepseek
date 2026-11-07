import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AgentRunner } from '../src/agent/runner';
import { buildProviderPayloadProjection, buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { getAgentSystemPrompt } from '../src/agent/protocol';
import { createContextUsageEstimate } from '../src/agent/contextUsage';
import { createProviderCacheObservation } from '../src/agent/cacheObservation';
import { appendUsageLedgerRecord } from '../src/agent/usageLedger';
import type { ModelSourceProvider } from '../src/accounts/types';
import type { DeepSeekToolCall } from '../src/agent/deepseek/types';
import type { AgentRequest, ProviderUsageLedgerRecord } from '../src/shared/types';
import {
  executeTaskRouterTool, getProjectRouterSystemPrompt, normalizeProjectRouterRole,
  PROJECT_ROUTER_ROLE, PROJECT_ROUTER_TOOL_NAMES, type ProjectTaskRouterHost
} from '../src/agent/taskRouter';

const settings = { thinkingEnabled: false, reasoningEffort: 'high' as const, compressionThreshold: 'balanced' as const };

for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as ModelSourceProvider[]) {
  test(`Router fixed capability lane reaches actual ${provider} payload projection without changing Worker prefix`, () => {
    const input = { model: { id: 'fixture-model', label: 'Fixture', provider, contextWindowTokens: 32000, maxOutputTokens: 2000 },
      agentSettings: settings, contextFiles: [], history: [], language: 'en' as const,
      prompt: 'Compare the existing tasks, then create a bounded follow-up.', requestProtocolVersion: 15,
      sourceId: 'fixture-source', baseUrl: 'https://fixture.invalid/v1', provider };
    const before = buildProviderRequestProjection(input);
    const router = buildProviderRequestProjection({ ...input, agentRole: { ...PROJECT_ROUTER_ROLE },
      slimToolNames: ['keepseek_run_draft'], systemPrompt: 'Caller cannot turn Router into a file executor.' });
    const after = buildProviderRequestProjection(input);
    assert.deepEqual(after, before);
    assert.equal(after.messages[0]?.content, getAgentSystemPrompt({ language: 'en', requestProtocolVersion: 15 }));
    assert.equal(router.messages[0]?.content, getProjectRouterSystemPrompt('en'));
    assert.deepEqual(router.toolNames, [...PROJECT_ROUTER_TOOL_NAMES]);
    assert.deepEqual(router.tools.map(tool => tool.function.name), [...PROJECT_ROUTER_TOOL_NAMES]);
    const native = router.responses ? { protocol: 'openai-responses' as const,
      input: router.responses.input, tools: router.responses.tools }
      : router.anthropic ? { protocol: 'anthropic-messages' as const,
          system: router.anthropic.system, messages: router.anthropic.messages, tools: router.anthropic.tools }
        : undefined;
    const body = buildProviderPayloadProjection({ modelId: input.model.id, maxOutputTokens: 2000, provider,
      messages: router.messages, tools: router.tools, native });
    const bytes = JSON.stringify(body);
    assert.ok(bytes.includes('keepseek_tasks_create'));
    assert.ok(!bytes.includes('keepseek_run_draft'));
    assert.ok(!bytes.includes('keepseek_read_workspace'));
    const observation = { requestId: 'same-machine-fixture', attemptIndex: 0, sourceId: input.sourceId, provider,
      baseUrl: input.baseUrl, body, requestProtocolVersion: 15, estimatedPromptTokens: 100 };
    const routerLane = createProviderCacheObservation({ ...observation, source: 'router' });
    const workerLane = createProviderCacheObservation({ ...observation, source: 'executor' });
    assert.notEqual(routerLane.laneKey, workerLane.laneKey);
    assert.deepEqual(buildProviderRequestProjection({ ...input, agentRole: { ...PROJECT_ROUTER_ROLE }, includeTools: false }).tools, []);
    const estimate = createContextUsageEstimate({ ...input, agentRole: { ...PROJECT_ROUTER_ROLE }, messages: [] });
    assert.ok(estimate.breakdown.toolSchemaTokensEstimate > 0);
    assert.ok(estimate.usedTokensEstimate < createContextUsageEstimate({ ...input, messages: [] }).usedTokensEstimate);
  });
}

test('Router durable dispatch returns a handle without awaiting Worker execution and binds native idempotency', async () => {
  const committed: string[] = [];
  let workerFinished = false;
  const host = createHost();
  host.create = async input => {
    committed.push(input.requestId);
    return { taskCardId: 'task-a', sessionId: 'worker-a', status: 'queued' };
  };
  const context = { projectId: 'project', sessionId: 'router', inputId: 'input-1' };
  const call = makeCall('keepseek_tasks_create', { content: 'A real user task.' });
  assert.deepEqual(JSON.parse(await executeTaskRouterTool(call, host, context)), {
    ok: true, taskCardId: 'task-a', sessionId: 'worker-a', status: 'queued'
  });
  assert.deepEqual(committed, ['router:input-1:native-call']);
  assert.equal(workerFinished, false);
  workerFinished = true;
});

test('Router never grants stop authorization from model text and fails closed on mismatched authority', async () => {
  const host = createHost();
  const context = { projectId: 'project', sessionId: 'router', inputId: 'input-1' };
  const call = makeCall('keepseek_tasks_stop', { taskCardId: 'task-a' });
  await assert.rejects(executeTaskRouterTool(call, host, context), /explicit user authorization/);
  const result = await executeTaskRouterTool(call, host, { ...context, authorizedStopTaskIds: ['task-a'] });
  assert.equal(JSON.parse(result).taskCardId, 'task-a');
  await assert.rejects(executeTaskRouterTool(call, host, { ...context, projectId: 'other' }), /mismatched/);
  await assert.rejects(executeTaskRouterTool(makeCall('keepseek_run_draft', {}), host, context), /non-task/);
  await assert.rejects(executeTaskRouterTool(makeCall('keepseek_tasks_create', { content: 'Task', approvalMode: 'delegate' }), host, context), /Unexpected/);
  await assert.rejects(executeTaskRouterTool(makeCall('keepseek_tasks_list', { limit: 1000 }), host, context), /bound/);
  await assert.rejects(executeTaskRouterTool(makeCall('keepseek_tasks_dependencies', { taskCardId: 'task-a', dependsOn: ['b', 'b'] }), host, context), /Duplicate/);
  await assert.rejects(executeTaskRouterTool(makeCall('keepseek_tasks_create', { content: 'Task', dependsOn: ['b', 'b'] }), host, context), /Duplicate/);
});

test('Router creates dependency-gated tasks in the same durable dispatch transaction', async () => {
  const host = createHost();
  let captured: unknown;
  host.create = async input => {
    captured = input;
    return { taskCardId: 'after-a', sessionId: 'worker-after-a', status: 'queued' };
  };
  await executeTaskRouterTool(makeCall('keepseek_tasks_create', { content: 'Verify A after it settles.', dependsOn: ['task-a'] }),
    host, { projectId: 'project', sessionId: 'router', inputId: 'input-1' });
  assert.deepEqual(captured, { content: 'Verify A after it settles.', title: undefined,
    dependsOn: ['task-a'], requestId: 'router:input-1:native-call' });
});

test('Router can stop only the exact target after a fresh Host UI authorization and cancellation still wins', async () => {
  const host = createHost();
  const controller = new AbortController();
  const waits: boolean[] = [];
  const context = { projectId: 'project', sessionId: 'router', inputId: 'input-1', signal: controller.signal, onWaiting: (waiting: boolean) => waits.push(waiting) };
  const confirmations: unknown[] = [], stops: string[] = [];
  host.stop = async input => { stops.push(input.taskCardId); return { taskCardId: input.taskCardId, sessionId: 'worker-a', status: 'cancelled' }; };
  host.requestStopAuthorization = async input => { confirmations.push(input); return false; };
  const call = makeCall('keepseek_tasks_stop', { taskCardId: 'task-a' });
  await assert.rejects(executeTaskRouterTool(call, host, context), /explicit user authorization/);
  assert.deepEqual(stops, []);
  host.requestStopAuthorization = async input => { confirmations.push(input); return true; };
  assert.equal(JSON.parse(await executeTaskRouterTool(call, host, context)).taskCardId, 'task-a');
  assert.deepEqual(stops, ['task-a']);
  assert.deepEqual(confirmations, [{ taskCardId: 'task-a', requestId: 'router:input-1:native-call' },
    { taskCardId: 'task-a', requestId: 'router:input-1:native-call' }]);
  host.requestStopAuthorization = async () => { controller.abort(); return true; };
  await assert.rejects(executeTaskRouterTool(call, host, context), /cancelled/);
  assert.deepEqual(stops, ['task-a']);
  assert.deepEqual(waits, [true, false, true, false, true, false], 'human wait always releases its clock boundary, including cancellation');
});

test('Router role survives canonical normalization and unknown toolsets cannot become Workers', () => {
  assert.deepEqual(normalizeProjectRouterRole(PROJECT_ROUTER_ROLE), PROJECT_ROUTER_ROLE);
  assert.equal(normalizeProjectRouterRole(undefined), undefined);
  assert.throws(() => normalizeProjectRouterRole({ kind: 'project-router', version: 2, toolSchemaVersion: 1 }), /Unsupported/);
  assert.throws(() => normalizeProjectRouterRole('router'), /Invalid/);
});

for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as const) {
  test(`real Runner dispatches Router tools through ${provider} transport and bills each physical request by role`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'keepseek-router-runner-'));
    const originalFetch = globalThis.fetch;
    const bodies: Array<Record<string, unknown>> = [];
    const ledger: ProviderUsageLedgerRecord[] = [];
    const mutations: string[] = [];
    const host = createHost();
    host.create = async input => {
      mutations.push(input.requestId);
      return { taskCardId: 'real-dispatch', sessionId: 'independent-worker', status: 'queued' };
    };
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return routerReply(provider, bodies.length === 1);
    }) as typeof fetch;
    try {
      const request: AgentRequest = {
        agentRole: { ...PROJECT_ROUTER_ROLE }, taskRouter: host,
        taskRouterContext: { projectId: 'project', sessionId: 'router-session', inputId: 'durable-input' },
        prompt: 'Create a task to review the documentation.', contextFiles: [], history: [], language: 'en',
        sessionId: 'router-session', requestProtocolVersion: 15,
        model: { id: 'router-fixture', label: 'Fixture', provider, sourceId: 'fixture', contextWindowTokens: 64000, maxOutputTokens: 2000 },
        settings, sourceConfig: { sourceId: 'fixture', provider, apiKey: 'test-key',
          baseUrl: 'https://fixture.invalid/v1', supportsBilling: false },
        executionLimits: { maxModelRequests: 4, maxToolIterations: 4, maxRunMs: 60000 }
      };
      const result = await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
        vscode.Uri.file(directory)).run(request, { onUsageLedgerRecord: record => {
          const merged = appendUsageLedgerRecord({ version: 1, records: ledger, incomplete: false, legacyAggregate: false }, record);
          ledger.splice(0, ledger.length, ...merged.records);
        } });
      assert.equal(result.message, 'Task queued.');
      assert.equal(bodies.length, 2, 'one semantic Router round has two physical requests around the tool dispatch');
      assert.deepEqual(mutations, ['router:durable-input:router-create']);
      assert.equal(JSON.stringify(bodies[0].tools), JSON.stringify(bodies[1].tools));
      assert.ok(JSON.stringify(bodies[1]).includes('real-dispatch'));
      assert.ok(!JSON.stringify(bodies[0].tools).includes('keepseek_run_draft'));
      assert.equal(result.toolRounds?.[0]?.toolResults.length, 1);
      assert.equal(ledger.length, 2);
      assert.ok(ledger.every(record => record.source === 'router'));
      if (provider === 'openai-responses') assert.equal(result.providerReplay?.protocol, 'openai-responses');
      if (provider === 'anthropic-compatible') assert.equal(result.providerReplay?.protocol, 'anthropic-messages');
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
}

function routerReply(provider: string, call: boolean): Response {
  const toolName = 'keepseek_tasks_create';
  const args = JSON.stringify({ content: 'Review the documentation.' });
  if (provider === 'openai-responses') {
    return new Response(`data: ${JSON.stringify({ type: 'response.completed', response: {
      status: 'completed', output: call
        ? [{ type: 'function_call', id: 'native-function', call_id: 'router-create', name: toolName, arguments: args }]
        : [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Task queued.' }] }],
      usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
    } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  }
  if (provider === 'anthropic-compatible') {
    const events: Array<Record<string, unknown>> = [
      { type: 'message_start', message: { usage: { input_tokens: 100 } } },
      { type: 'content_block_start', index: 0, content_block: call
        ? { type: 'tool_use', id: 'router-create', name: toolName, input: {} }
        : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: call
        ? { type: 'input_json_delta', partial_json: args }
        : { type: 'text_delta', text: 'Task queued.' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 10 } },
      { type: 'message_stop' }
    ];
    return new Response(events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'Content-Type': 'text/event-stream' } });
  }
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: call
    ? { tool_calls: [{ index: 0, id: 'router-create', type: 'function', function: { name: toolName, arguments: args } }] }
    : { content: 'Task queued.' }, finish_reason: call ? 'tool_calls' : 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
}

function makeCall(name: string, args: Record<string, unknown>): DeepSeekToolCall {
  return { id: 'native-call', type: 'function', function: { name, arguments: JSON.stringify(args) } };
}

function createHost(): ProjectTaskRouterHost {
  return {
    projectId: 'project',
    list: async () => ({ tasks: [] }),
    read: async () => ({ task: { taskCardId: 'task-a', sessionId: 'worker-a', title: 'A', status: 'running' } }),
    create: async () => ({ taskCardId: 'task-a', sessionId: 'worker-a', status: 'queued' }),
    deliver: async () => ({ inputId: 'input-a', status: 'durable' }),
    setDependencies: async input => ({ taskCardId: input.taskCardId, dependsOn: input.dependsOn }),
    stop: async input => ({ taskCardId: input.taskCardId, sessionId: 'worker-a', status: 'stopping' })
  };
}
