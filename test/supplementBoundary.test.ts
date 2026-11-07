import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AgentRunner } from '../src/agent/runner';
import { createRunCheckpoint, inheritTaskBudget, normalizeRunCheckpoint, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { READ_WORKSPACE_FILE_TOOL_NAME } from '../src/agent/protocol';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import type { ToolAuthorizationAdapter } from '../src/agent/tools/toolAuthorization';
import type { AgentRequest, AgentResponse, ChatMessage, AnthropicReplayContentBlock } from '../src/shared/types';
import type { ModelSourceProvider } from '../src/accounts/types';
import { normalizeUserTask, taskGoal } from '../src/sessions/userTask';
import { normalizeUserTaskBudgets, taskBudgetFromCheckpoint } from '../src/sessions/userTaskBudget';

const protocols: ModelSourceProvider[] = ['openai-compatible', 'openai-responses', 'anthropic-compatible'];
const allow: ToolAuthorizationAdapter = {
  createRunPolicy: runId => ({ runId, mediumRiskPolicy: 'ask', authorizedScopes: [], deniedScopes: [] }),
  authorize: async input => ({ allowed: true, toolName: input.toolName, riskLevel: 'low',
    scope: 'workspace_read', source: 'low_risk', requiresExplicitConfirmation: false })
};

for (const provider of protocols) {
  test(`${provider}: a durable supplement during a model request preserves the request and pairs undispatched calls`, async () => {
    let pending = false, requests = 0, reads = 0;
    const workspace = new WorkspaceToolService();
    workspace.readWorkspaceFile = async () => { reads++; return '{"ok":true,"content":"original"}'; };
    const runner = new AgentRunner(workspace, undefined, undefined, undefined, undefined, allow);
    const request = makeRequest(provider, () => pending);
    const bodies: string[] = [];
    let checkpoint: RunCheckpoint | undefined;
    const result = await withFetch(async (_url, init) => {
      requests++; bodies.push(String(init?.body)); pending = true;
      return toolResponse(provider, ['read-1', 'read-2']);
    }, () => runner.run(request, { onCheckpoint: async cp => { checkpoint = structuredClone(cp); } }));
    assert.equal(requests, 1);
    assert.equal(reads, 0);
    assert.equal(result.supplementBoundaryRequired, true);
    assert.equal(checkpoint?.stopReason, 'supplement_boundary');
    assert.equal(checkpoint?.status, 'interrupted');
    assert.equal(checkpoint?.taskId, 'segment-1');
    assert.equal(checkpoint?.state?.pending, undefined);
    assert.equal(result.toolRounds?.[0].toolCalls.length, 2);
    assert.deepEqual(result.toolRounds?.[0].toolResults.map(item => JSON.parse(item.content).errorType),
      ['supplement_pending', 'supplement_pending']);
    assert.equal(bodies[0].includes('not-yet-incorporated-supplement'), false);
    assertNativePairs(provider, result, ['read-1', 'read-2']);
    assert.equal(normalizeRunCheckpoint(checkpoint)?.request.projectTaskIdentity?.rootTaskId, 'root-1');
  });

  test(`${provider}: an already dispatched read settles before the same-root boundary and remaining calls do not run`, async () => {
    let pending = false, reads = 0, requests = 0;
    const workspace = new WorkspaceToolService();
    workspace.readWorkspaceFile = async () => {
      reads++; pending = true;
      await new Promise<void>(resolve => setImmediate(resolve));
      return '{"ok":true,"content":"settled result"}';
    };
    const runner = new AgentRunner(workspace, undefined, undefined, undefined, undefined, allow);
    const request = makeRequest(provider, () => pending);
    let checkpoint: RunCheckpoint | undefined;
    const result = await withFetch(async () => { requests++; return toolResponse(provider, ['one', 'two']); },
      () => runner.run(request, { onCheckpoint: async cp => { checkpoint = structuredClone(cp); } }));
    assert.equal(reads, 1);
    assert.equal(requests, 1);
    assert.equal(result.supplementBoundaryRequired, true);
    assert.equal(JSON.parse(result.toolRounds![0].toolResults[0].content).ok, true);
    assert.equal(JSON.parse(result.toolRounds![0].toolResults[1].content).executed, false);
    assertNativePairs(provider, result, ['one', 'two']);
    const budget = taskBudgetFromCheckpoint(checkpoint!);
    assert.ok(budget.epoch?.evidenceRefs.length);
    assert.equal(normalizeUserTaskBudgets({ 'root-1': budget })['root-1'].epoch?.index, budget.epoch?.index);
    const nextRequest = makeRequest(provider, () => pending);
    nextRequest.projectTaskIdentity = { ...nextRequest.projectTaskIdentity!, segmentId: 'segment-2', generation: 2 };
    nextRequest.prompt = 'Read the file again with the new requirement.';
    nextRequest.history.push({ id: 'assistant-1', role: 'assistant', content: result.message, createdAt: '',
      toolRounds: result.toolRounds, providerReplay: result.providerReplay,
      userTask: { version: 1, id: 'root-1', originMessageId: 'origin', reason: 'user' } },
    { id: 'input-2', role: 'user', content: nextRequest.prompt, createdAt: '',
      userTask: { version: 1, id: 'root-1', originMessageId: 'origin', reason: 'supplement' } });
    const next = createRunCheckpoint(nextRequest, budget.maxExecutionMs, 'supplement', [], budget.maxCost);
    inheritTaskBudget(next, budget);
    assert.equal(next.taskId, 'segment-2');
    assert.deepEqual(next.inheritedEpoch?.evidenceRefs, budget.epoch?.evidenceRefs);
    assert.deepEqual(next.runBudget, budget.runBudget);
    assert.equal(next.usedMs, budget.usedMs);
    assert.equal(next.state, undefined);
    assert.equal(Object.hasOwn(next.request, 'hasPendingSupplement'), false);
    assert.equal(Object.hasOwn(next.request, 'taskRouter'), false);
    pending = false;
    const second = await withFetch(async () => toolResponse(provider, ['one', 'two']),
      () => runner.run({ ...nextRequest, checkpoint: next }));
    assert.equal(reads, 2, 'same Provider call id in a new segment cannot reuse another segment tool result');
    assert.equal(second.supplementBoundaryRequired, true);
  });
}

test('supplement is a normalized real-input identity and contributes to the original goal without rewriting history', () => {
  const origin: ChatMessage = { id: 'origin', role: 'user', content: 'Original goal', createdAt: '',
    userTask: { version: 1, id: 'root', originMessageId: 'origin', reason: 'user' } };
  const supplement: ChatMessage = { id: 'input-2', role: 'user', content: 'Also keep the cache stable', createdAt: '',
    userTask: { version: 1, id: 'root', originMessageId: 'origin', reason: 'supplement' } };
  const history = [origin, supplement], before = JSON.stringify(history);
  assert.equal(normalizeUserTask(supplement.userTask)?.reason, 'supplement');
  assert.equal(taskGoal(history, 'root'), 'Original goal\n\nAlso keep the cache stable');
  assert.equal(JSON.stringify(history), before);
});

function makeRequest(provider: ModelSourceProvider, hasPendingSupplement: () => boolean): AgentRequest {
  return { prompt: 'Read the original file.', model: { id: 'test-model', label: 'Test', provider,
    sourceId: 'fixture-source', contextWindowTokens: 64000, maxOutputTokens: 2000 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [], history: [{ id: 'origin', role: 'user', content: 'Read the original file.', createdAt: '',
      userTask: { version: 1, id: 'root-1', originMessageId: 'origin', reason: 'user' } }],
    requestProtocolVersion: 15, slimToolNames: [READ_WORKSPACE_FILE_TOOL_NAME], language: 'en', sessionId: 'session-1',
    approvalRootTaskId: 'root-1', projectTaskIdentity: { projectId: 'project', taskCardId: 'card',
      rootTaskId: 'root-1', segmentId: 'segment-1', generation: 1 }, hasPendingSupplement,
    sourceConfig: { sourceId: 'fixture-source', provider, baseUrl: 'https://fixture.invalid/v1',
      apiKey: 'fixture-key', supportsBilling: false } };
}

function toolResponse(provider: ModelSourceProvider, ids: string[]): Response {
  const calls = ids.map(id => ({ id, type: 'function', function: { name: READ_WORKSPACE_FILE_TOOL_NAME,
    arguments: JSON.stringify({ path: 'fixture.txt' }) } }));
  let data: string;
  if (provider === 'openai-responses') data = event({ type: 'response.completed', response: { status: 'completed',
    output: calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments })) } });
  else if (provider === 'anthropic-compatible') data = [
    event({ type: 'message_start', message: { usage: { input_tokens: 12 } } }),
    ...calls.flatMap((call, index) => [event({ type: 'content_block_start', index,
      content_block: { type: 'tool_use', id: call.id, name: call.function.name, input: {} } }),
    event({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: call.function.arguments } }),
    event({ type: 'content_block_stop', index })]),
    event({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 8 } }),
    event({ type: 'message_stop' })].join('');
  else data = event({ id: 'fixture-response', choices: [{ index: 0, delta: { role: 'assistant',
    content: '', tool_calls: calls.map((call, index) => ({ ...call, index })) }, finish_reason: 'tool_calls' }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }) + 'data: [DONE]\n\n';
  return new Response(data, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function event(value: { type?: string; [key: string]: unknown }): string {
  return `${value.type ? `event: ${value.type}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
}

function assertNativePairs(provider: ModelSourceProvider, result: AgentResponse, ids: string[]): void {
  if (provider === 'openai-responses') {
    assert.equal(result.providerReplay?.protocol, 'openai-responses');
    const replay = result.providerReplay as Extract<NonNullable<AgentResponse['providerReplay']>, { protocol: 'openai-responses' }>;
    assert.deepEqual(replay.items.filter(item => item.type === 'function_call_output').map(item => item.call_id), ids);
  } else if (provider === 'anthropic-compatible') {
    assert.equal(result.providerReplay?.protocol, 'anthropic-messages');
    const replay = result.providerReplay as Extract<NonNullable<AgentResponse['providerReplay']>, { protocol: 'anthropic-messages' }>;
    const blocks = replay.messages.flatMap<AnthropicReplayContentBlock>(message => message.content);
    assert.deepEqual(blocks.filter(block => block.type === 'tool_result').map(block => block.tool_use_id), ids);
  }
  assert.deepEqual(result.toolRounds![0].toolResults.map(item => item.toolCallId), ids);
}

async function withFetch<T>(fetch: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try { return await run(); } finally { globalThis.fetch = original; }
}
