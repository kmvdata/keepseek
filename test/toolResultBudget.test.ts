import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Script } from 'node:vm';
import { AgentRunner } from '../src/agent/runner';
import { canContinueBudgetInNewTurn, checkpointCopy, recoveryBlocker, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { shapeWorkspaceListingResult } from '../src/agent/toolResultShaping';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import { estimateDeepSeekMessageTokens } from '../src/agent/protocol';
import { getAgentRuntimeProfile } from '../src/shared/modelProfiles';
import { getVisibleMessages } from '../src/sessions/chatSessionStore';
import { getScript } from '../src/webview/script';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { createNoopInteractionTrace, InteractionTraceLogService, type InteractionTraceEvent } from '../src/agent/logging/interactionTrace';
import * as vscode from './stubs/vscode';
import type { AgentRequest, ChatMessage, RepairLoopState, RunDetailsSummary } from '../src/shared/types';

const files = Array.from({ length: 1842 }, (_, index) => ({
  path: `src/app/market/market-today-action/components/nested-directory/market-component-${index}.tsx`,
  label: `market-component-${index}.tsx`, workspaceFolder: 'signal_tracker', sizeBytes: 2000,
  size: '2 KB', extension: '.tsx'
}));
const listing = { ok: true, files, count: files.length, limit: 2000, truncated: false };

test('large listings are bounded, truthful, deterministic and give a scoped continuation path', () => {
  for (const key of ['files', 'entries']) {
    for (const pressure of [false, true]) {
      const input = { ok: true, [key]: files, count: files.length, truncated: false };
      const before = JSON.stringify(input);
      const output = shapeWorkspaceListingResult(input, pressure);
      const parsed = JSON.parse(output);
      assert.ok(output.length <= (pressure ? 6000 : 12000));
      assert.ok(parsed.count > 0 && parsed.count <= (pressure ? 50 : 100));
      assert.equal(parsed.count, parsed[key].length);
      assert.equal(parsed.totalListed, 1842);
      assert.equal(parsed.truncated, true);
      assert.match(parsed.hint, /keepseek_list_workspace_directory/u);
      assert.equal(JSON.stringify(input), before);
      assert.equal(shapeWorkspaceListingResult(input, pressure), output);
    }
  }
  for (const input of [{ ok: true, files: [], count: 0 }, { ok: true, files: [files[0]], count: 1, truncated: true },
    { ok: false, error: 'Not authorized' }]) {
    assert.equal(shapeWorkspaceListingResult(input, true), JSON.stringify(input));
  }
  const hugePath = { ok: true, files: [{ path: '中'.repeat(20_000) }] };
  assert.equal(JSON.parse(shapeWorkspaceListingResult(hugePath, false)).count, 0);
});

test('1842-file listing followed by search keeps running on the reported gateway model, with stable native prefixes', async () => {
  for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as const) {
    const result = await runScenario(provider);
    assert.equal(result.response.runDetails.budgetStopReason, undefined, provider);
    assert.equal(result.checkpoint.stopReason, 'completed', provider);
    assert.equal(result.searchCount, 1, provider);
    assert.equal(result.bodies.length, 3, provider);
    const content = result.response.toolRounds![0].toolResults[0].content;
    assert.equal(JSON.parse(content).truncated, true);
    assert.equal(JSON.parse(content).totalListed, 1842);
    assert.ok(result.bodies[1].includes(JSON.stringify(content)), 'sent bytes equal persisted bytes');
    assert.ok(result.bodies[2].includes(JSON.stringify(content)), 'older tool result never reshaped');
    const summary = JSON.parse(result.response.runDetails.toolCalls[0].resultSummary!);
    assert.equal(summary.truncated, true);
    assert.equal(summary.totalListed, 1842);
    for (let i = 1; i < result.bodies.length; i++) {
      const previous = JSON.parse(result.bodies[i - 1]);
      const next = JSON.parse(result.bodies[i]);
      assert.equal(JSON.stringify(next.tools), JSON.stringify(previous.tools));
      const key = provider === 'openai-responses' ? 'input' : 'messages';
      assert.deepEqual(next[key].slice(0, previous[key].length), previous[key], provider);
    }
  }
});

test('tool-result budget and actual context-window exhaustion have distinct recoverable guidance and accurate summaries', async () => {
  for (const kind of ['tool-result', 'context-window'] as const) {
    const result = await runScenario('openai-compatible', kind);
    const reason = kind === 'tool-result' ? 'tool_result_budget_exhausted' : 'context_window_exhausted';
    assert.equal(result.response.runDetails.budgetStopReason, reason);
    assert.equal(result.checkpoint.status, 'blocked');
    assert.equal(result.checkpoint.stopReason, 'budget_exhausted');
    const summary = JSON.parse(result.response.runDetails.toolCalls[0].resultSummary!);
    assert.equal(summary.budgetReason, reason);
    assert.equal(summary.errorType, reason);
    const toolResult = JSON.parse(result.response.toolRounds![0].toolResults[0].content);
    assert.equal(toolResult.errorType, reason);
    const event = result.traceEvents.find((item) => item.type === 'tool_result' && item.budgetStopReason === reason)!;
    assert.equal(event.usedTokens, toolResult.usedTokens);
    assert.equal(event.nextTokens, toolResult.nextTokens);
    assert.equal(event.maxTokens, toolResult.maxTokens);
    assert.equal(summary.ok, false);
    assert.equal(result.response.runDetails.toolCalls[0].status, 'failed');
    assert.ok(summary.maxTokens > 0);
    assert.ok(summary.nextTokens > 0);
    assert.match(recoveryBlocker(result.checkpoint)!, /not an approval request/u);
    assert.equal(canContinueBudgetInNewTurn(result.checkpoint), true);
    // No automatic budget reset or model request; old task recovery stays blocked.
    await assert.rejects(new AgentRunner().run({ ...request(), checkpoint: result.checkpoint }), /not an approval request/u);
    const legacy = checkpointCopy(result.checkpoint);
    legacy.stopReason = 'waiting_for_user';
    const message = asMessage(legacy);
    const visible = getVisibleMessages([message])[0];
    assert.equal(visible.runState?.stopReason, 'budget_exhausted');
    assert.equal(visible.runState?.canResume, false);
    assert.equal(visible.runState?.canContinueInNewTurn, true);
    assert.equal(getVisibleMessages([message, { ...message, id: 'newer', runCheckpoint: undefined }])[0].runState?.canContinueInNewTurn, false);
    for (const field of ['backgroundRunId', 'subagentContext'] as const) {
      const scoped = checkpointCopy(legacy);
      Object.assign(scoped.request, { [field]: 'active' });
      assert.equal(canContinueBudgetInNewTurn(scoped), false);
    }
    legacy.stopReason = 'storage_failure';
    assert.equal(canContinueBudgetInNewTurn(legacy), false);
  }
});

test('preflight context overflow exposes the same code without sending an API request or offering unsafe recovery', async () => {
  const input = request();
  input.model.contextWindowTokens = 8000;
  input.model.maxOutputTokens = 1000;
  const events: InteractionTraceEvent[] = [];
  const details: RunDetailsSummary[] = [];
  let checkpoint!: RunCheckpoint;
  let requests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { requests++; throw new Error('Must not send an oversized request'); }) as typeof fetch;
  try {
    await assert.rejects(new AgentRunner(undefined, collectingTrace(events)).run(input, {
      onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); }, onRunDetails: (item) => details.push(item)
    }), { code: 'context_window_exhausted' });
    assert.equal(requests, 0);
    assert.equal(checkpoint.status, 'blocked');
    assert.equal(checkpoint.stopReason, 'budget_exhausted');
    assert.ok(recoveryBlocker(checkpoint));
    assert.equal(canContinueBudgetInNewTurn(checkpoint), false);
    assert.equal(details.at(-1)?.budgetStopReason, 'context_window_exhausted');
    assert.equal((events.find((item) => item.type === 'run_error')?.error as { code: string }).code, 'context_window_exhausted');
  } finally { globalThis.fetch = originalFetch; }
});

test('new-turn action uses ordinary sendPrompt, preserves repair state and never mutates the exhausted checkpoint', async () => {
  const { checkpoint } = await runScenario('openai-compatible', 'tool-result');
  const message = asMessage(checkpoint);
  const messages = [message];
  const repairLoop: RepairLoopState = { status: 'waiting_for_apply', iteration: 2, maxIterations: 2, pendingDraftEditIds: ['edit'] };
  const calls: unknown[][] = [];
  const provider = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    isBusy: false, isStartingRun: false, activeDraftRunId: undefined, language: 'zh-CN',
    selectedSourceId: 'gateway', selectedModelId: request().model.id, agentSettings: request().settings,
    sessionStore: { getActiveSession: () => ({ id: 'session', messages, repairLoop }) },
    repairLoopsBySession: new Map(), hasActiveBackgroundRun: () => false,
    sendPrompt: async (...args: unknown[]) => { calls.push(args); }
  }) as { continueAgentTaskInNewTurn(id: string): Promise<void>; isBusy: boolean };
  const original = JSON.stringify(checkpoint);
  await provider.continueAgentTaskInNewTurn('wrong-id');
  assert.equal(calls.length, 0);
  provider.isBusy = true;
  await provider.continueAgentTaskInNewTurn(message.id);
  assert.equal(calls.length, 0);
  provider.isBusy = false;
  await provider.continueAgentTaskInNewTurn(message.id);
  assert.equal(calls.length, 1);
  assert.match(String(calls[0][0]), /另行批准/u);
  assert.deepEqual(calls[0][4], { repairLoop, strictModelSelection: true });
  assert.equal(JSON.stringify(checkpoint), original);
  assert.equal(messages.length, 1, 'handler does not edit or replace history directly');
});

test('budget panel renders a new-turn button and keeps the native resume button separate', () => {
  const source = getScript();
  const start = source.indexOf('    function createRunStatePanel(message)');
  const end = source.indexOf('    function createRunDetailsPanel(message)', start);
  const render = new Script(source.slice(start, end) + '\ncreateRunStatePanel(message);');
  const element = () => ({ dataset: {}, children: [] as unknown[], append(...children: unknown[]) { this.children.push(...children); } });
  const runState = { status: 'blocked', stopReason: 'budget_exhausted', canResume: false, canContinueInNewTurn: true, blocker: 'Tool-result limit' };
  const panel = render.runInNewContext({ document: { createElement: element }, state: { isBusy: false }, t: (key: string) => key,
    message: { id: 'a', runState } });
  assert.ok(panel.children.some((child: { dataset?: { runAction?: string } }) => child.dataset?.runAction === 'continueTaskInNewTurn'));
  assert.ok(!panel.children.some((child: { dataset?: { runAction?: string } }) => child.dataset?.runAction === 'continueTask'));
  assert.match(source, /type: 'continueAgentTaskInNewTurn', messageId: runMessage.id/u);
});

async function runScenario(provider: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible',
  budget?: 'tool-result' | 'context-window') {
  const input = request();
  input.model.provider = provider;
  input.sourceConfig = { ...input.sourceConfig!, provider };
  if (budget === 'context-window') { input.model.contextWindowTokens = 32_000; input.model.maxOutputTokens = 1000; }
  const workspace = new WorkspaceToolService();
  let searchCount = 0;
  workspace.listWorkspaceFiles = async () => JSON.stringify(listing);
  workspace.searchWorkspace = async () => { searchCount++; return JSON.stringify({ ok: true, results: [{ path: 'src/app/market/page.tsx', matchLine: 'market-today-action' }], count: 1 }); };
  workspace.readWorkspaceFile = async () => JSON.stringify({ ok: true, path: 'large.ts', content: '中'.repeat(budget === 'context-window' ? 12_000 : 100_000) });
  if (!budget) {
    assert.ok(estimateDeepSeekMessageTokens({ role: 'tool', content: JSON.stringify(listing) })
      > getAgentRuntimeProfile(input.model, input.settings).toolResultTokenBudget, 'fixture reproduces the former failure');
  }
  const bodies: string[] = [];
  const traceEvents: InteractionTraceEvent[] = [];
  let checkpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    const step = bodies.length;
    const name = step === 1 ? budget ? 'keepseek_read_workspace_file' : 'keepseek_list_workspace_files' : 'keepseek_search_workspace';
    const args = step === 1 ? budget ? '{"path":"large.ts"}' : '{}' : '{"query":"market-today-action","maxResults":30}';
    return modelResponse(provider, step <= (budget ? 1 : 2) ? { name, args, id: 'call-' + step } : undefined);
  }) as typeof fetch;
  try {
    const response = await new AgentRunner(workspace, collectingTrace(traceEvents)).run(input, { onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); } });
    return { response, checkpoint, bodies, searchCount, traceEvents };
  } finally { globalThis.fetch = originalFetch; }
}

function collectingTrace(events: InteractionTraceEvent[]): InteractionTraceLogService {
  const service = new InteractionTraceLogService(vscode.Uri.file('/unused-trace-test') as unknown as import('vscode').Uri);
  service.createRunTrace = (sink) => {
    const trace = createNoopInteractionTrace(sink);
    const record = trace.record.bind(trace);
    trace.record = (event) => { events.push(event); record(event); };
    return trace;
  };
  return service;
}

function request(): AgentRequest {
  return { prompt: 'Connect the market-today-action page to data.', history: [], contextFiles: [], language: 'en', requestProtocolVersion: 5,
    model: { id: 'deepseek-v4-flash-0731', label: 'Flash', sourceId: 'gateway', provider: 'openai-compatible', contextWindowTokens: 1_000_000, maxOutputTokens: 2000 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    sourceConfig: { sourceId: 'gateway', provider: 'openai-compatible', apiKey: '', baseUrl: 'https://gateway.invalid/v1', supportsBilling: false },
    executionLimits: { maxToolIterations: 4 } };
}

function asMessage(cp: RunCheckpoint): ChatMessage {
  return { id: 'a', role: 'assistant', content: cp.finalResponse!.message, createdAt: cp.updatedAt, runCheckpoint: cp };
}

function modelResponse(provider: string, call?: { name: string; args: string; id: string }): Response {
  let events: unknown[];
  if (provider === 'openai-responses') {
    events = [{ type: 'response.completed', response: { status: 'completed', output: call
      ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.args }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done.' }] }] } }];
  } else if (provider === 'anthropic-compatible') {
    events = [{ type: 'message_start', message: {} }, { type: 'content_block_start', index: 0, content_block: call
      ? { type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.args) } : { type: 'text', text: 'Done.' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }];
  } else {
    events = [{ choices: [{ delta: call ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] }
      : { content: 'Done.' }, finish_reason: call ? 'tool_calls' : 'stop' }] }];
  }
  return new Response(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join('') + (provider === 'openai-compatible' ? 'data: [DONE]\n\n' : ''),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
