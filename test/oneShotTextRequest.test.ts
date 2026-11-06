import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestOneShotText, buildOneShotTextProviderBody, type OneShotTextRequestInput } from '../src/agent/oneShotTextRequest';
import { ExecutionCostBudget, LogicalRunBudget, SharedUpstreamTokenBudget, normalizeLogicalRunBudgetLimits } from '../src/agent/executionPolicy';
import { normalizeUsageLedgerRecord, preferUsageLedgerRecord } from '../src/agent/usageLedger';
import type { ProviderUsageLedgerRecord } from '../src/shared/types';
import type { ModelSourceProvider } from '../src/accounts/types';

function capture(records: ProviderUsageLedgerRecord[]) {
  return (record: ProviderUsageLedgerRecord) => {
    const index = records.findIndex(previous => previous.requestId === record.requestId && previous.attemptIndex === record.attemptIndex);
    if (index < 0) records.push(record);
    else records[index] = preferUsageLedgerRecord(records[index], record);
  };
}

function input(provider: ModelSourceProvider = 'openai-compatible'): OneShotTextRequestInput {
  return {
    purpose: 'session_title', requestId: 'session_title_claim', language: 'en',
    model: { id: 'title-model', label: 'Title', provider, contextWindowTokens: 32768, maxOutputTokens: 8192 },
    sourceConfig: { sourceId: 'title-source', provider, apiKey: 'test', baseUrl: 'https://fixture.invalid/v1', supportsBilling: false },
    systemPrompt: 'Name the topic. Return JSON.', userPrompt: '{"messages":[{"role":"user","content":"Fix approval"}]}',
    taskCostBudget: new ExecutionCostBudget(0),
    taskRunBudget: new LogicalRunBudget(undefined, normalizeLogicalRunBudgetLimits({ maxModelRequests: 0, maxToolRounds: 0, maxToolCalls: 0, maxContinuations: 0, maxContextEpochRollovers: 0, maxUpstreamTokens: 0, maxTreeUpstreamTokens: 0, maxContinuationOutputTokens: 0, maxContinuationOutputChars: 0 })!, new SharedUpstreamTokenBudget(0, 0), 0)
  };
}
function reply(provider: ModelSourceProvider, finish = 'stop'): Response {
  const text = '{"decision":"set","title":"Approval fix"}';
  const events: object[] = provider === 'openai-responses' ? [{ type: finish === 'length' ? 'response.incomplete' : 'response.completed', response: {
    status: finish === 'length' ? 'incomplete' : 'completed', incomplete_details: finish === 'length' ? { reason: 'max_output_tokens' } : undefined,
    output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }],
    usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
  } }] : provider === 'anthropic-compatible' ? [
    { type: 'message_start', message: { id: 'm', role: 'assistant', usage: { input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: finish === 'length' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 20 } },
    { type: 'message_stop' }
  ] : [
    { choices: [{ delta: { content: text }, finish_reason: finish }] },
    { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
  ];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (provider === 'openai-responses' || provider === 'anthropic-compatible' ? '' : 'data: [DONE]\n\n'));
}

test('session title physical requests use isolated three-protocol bodies, small output and subagent usage', async () => {
  const original = globalThis.fetch;
  try {
    for (const provider of ['deepseek', 'qwencloud', 'openai-responses', 'anthropic-compatible'] as const) {
      const req = input(provider);
      const records: ProviderUsageLedgerRecord[] = [];
      const phases: string[] = [];
      let body: Record<string, unknown> = {};
      let calls = 0;
      globalThis.fetch = (async (_url, init) => { calls++; phases.push('fetch'); body = JSON.parse(String(init?.body)); return reply(provider); }) as typeof fetch;
      req.onUsageLedgerRecord = capture(records);
      req.onBudgetChanged = () => { phases.push('budget'); };
      assert.equal(await requestOneShotText(req), '{"decision":"set","title":"Approval fix"}');
      assert.equal(calls, 1);
      assert.equal(body[provider === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'], 256);
      assert.equal(body.tools, undefined);
      assert.equal(Boolean(body.thinking && (body.thinking as { type: string }).type !== 'disabled'), false);
      assert.equal(body.reasoning, undefined);
      assert.equal(body.include, undefined);
      if (provider === 'qwencloud') assert.equal(body.enable_thinking, false);
      if (provider === 'openai-responses') assert.deepEqual((body.input as Array<{ role: string }>).map(m => m.role), ['system', 'user']);
      else assert.deepEqual((body.messages as Array<{ role: string }>).map(m => m.role), provider === 'anthropic-compatible' ? ['user'] : ['system', 'user']);
      assert.equal(records.length, 1);
      assert.equal(records[0].purpose, 'session_title');
      assert.equal(records[0].source, 'subagent');
      assert.equal(records[0].requestId, 'session_title_claim');
      assert.equal(records[0].usage?.totalTokens, 120);
      assert.equal(records[0].requestBudget?.actualMaxOutputTokens, 256);
      assert.equal(normalizeUsageLedgerRecord(records[0])?.purpose, 'session_title');
      assert.equal(normalizeUsageLedgerRecord({ ...records[0], source: 'reviewer' })?.purpose, undefined);
      assert.equal(req.taskRunBudget!.state.modelRequests, 1);
      assert.equal(req.taskRunBudget!.state.upstreamTokens, 120);
      assert.deepEqual(phases, ['budget', 'fetch', 'budget']);
    }
  } finally { globalThis.fetch = original; }
});

test('title output limit never exceeds model capabilities or the auxiliary cap', () => {
  const small = input(); small.model.maxOutputTokens = 128;
  const body = buildOneShotTextProviderBody({ modelId: small.model.id, model: small.model, provider: 'openai-compatible', systemPrompt: 'x', userPrompt: 'y', maxOutputTokens: 256 });
  assert.equal('max_tokens' in body && body.max_tokens, 128);
});

test('title caching reuses the official Anthropic policy without changing compatible or approval payloads', async () => {
  const original = globalThis.fetch;
  const bodies: string[] = [];
  try {
    globalThis.fetch = (async (_url, init) => { bodies.push(String(init?.body)); return reply('anthropic-compatible'); }) as typeof fetch;
    const official = input('anthropic-compatible');
    official.sourceConfig = { ...official.sourceConfig, baseUrl: 'https://api.anthropic.com' };
    await requestOneShotText(official);
    await requestOneShotText(input('anthropic-compatible'));
    const repeat = input('anthropic-compatible');
    repeat.sourceConfig = { ...repeat.sourceConfig, baseUrl: 'https://api.anthropic.com' };
    repeat.requestId = 'another_host_token';
    await requestOneShotText(repeat);
    const approval = input('anthropic-compatible');
    approval.sourceConfig = { ...approval.sourceConfig, baseUrl: 'https://api.anthropic.com' };
    approval.purpose = 'approval_review';
    await requestOneShotText(approval);
    assert.deepEqual(JSON.parse(bodies[0]).cache_control, { type: 'ephemeral' });
    assert.equal(JSON.parse(bodies[1]).cache_control, undefined, 'unknown compatible gateways receive no unsupported cache hint');
    assert.equal(bodies[0], bodies[2], 'host request identities are absent from the model body and do not spoil a stable prefix');
    assert.equal(JSON.parse(bodies[3]).cache_control, undefined, 'existing approval reviewer payloads retain their previous policy');
  } finally { globalThis.fetch = original; }
});

test('title failures make no network retry and retain unknown attempt usage and budget', async () => {
  const original = globalThis.fetch;
  try {
    const req = input();
    const records: ProviderUsageLedgerRecord[] = [];
    req.onUsageLedgerRecord = capture(records);
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return new Response('{"error":{"message":"retry later"}}', { status: 429 }); }) as typeof fetch;
    await assert.rejects(requestOneShotText(req), /no usable response/u);
    assert.equal(calls, 1);
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'attempt_without_usage');
    assert.equal(records[0].usage, undefined);
    assert.equal(records[0].purpose, 'session_title');
    assert.equal(req.taskRunBudget!.state.modelRequests, 1);
    assert.ok(req.taskRunBudget!.state.upstreamTokens > 256);
  } finally { globalThis.fetch = original; }
});

test('title truncation and unexpected tool calls reject after recording returned usage', async () => {
  const original = globalThis.fetch;
  try {
    for (const stage of ['length', 'tools'] as const) {
      const req = input();
      const records: ProviderUsageLedgerRecord[] = [];
      req.onUsageLedgerRecord = capture(records);
      globalThis.fetch = (async () => stage === 'length' ? reply('openai-compatible', 'length') : new Response(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '{}', tool_calls: [{ index: 0, id: 'x', type: 'function', function: { name: 'unexpected', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + '\n\n'
        + 'data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }) + '\n\ndata: [DONE]\n\n'
      )) as typeof fetch;
      await assert.rejects(requestOneShotText(req));
      assert.equal(records.length, 1);
      assert.equal(records[0].usage?.totalTokens, 120);
    }
  } finally { globalThis.fetch = original; }
});

test('title short timeout cancels transport and records its single unknown attempt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const original = globalThis.fetch;
  try {
    let dispatched!: () => void;
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    let signal: AbortSignal | undefined;
    globalThis.fetch = (async (_url, init) => { signal = init?.signal ?? undefined; dispatched(); return new Promise<Response>((_resolve, reject) => {
      signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
    }); }) as typeof fetch;
    const records: ProviderUsageLedgerRecord[] = [];
    const req = input(); req.onUsageLedgerRecord = capture(records);
    const pending = requestOneShotText(req);
    const rejected = assert.rejects(pending, error => (error as { reason: string }).reason === 'timeout');
    await started;
    t.mock.timers.tick(20_001);
    await rejected;
    assert.equal(signal?.aborted, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].kind, 'attempt_without_usage');
  } finally { globalThis.fetch = original; }
});

test('title positive cost, exhausted task budget and pre-cancellation prevent dispatch without fake attempts', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls++; return reply('openai-compatible'); }) as typeof fetch;
  try {
    const unpriced = input(); unpriced.taskCostBudget = new ExecutionCostBudget(1);
    await assert.rejects(requestOneShotText(unpriced), /cannot be priced/u);
    const exhausted = input(); exhausted.taskRunBudget!.limits.maxModelRequests = 1; exhausted.taskRunBudget!.state.modelRequests = 1;
    await assert.rejects(requestOneShotText(exhausted), /model_request_budget_exhausted/u);
    const cancelled = input(); cancelled.signal = AbortSignal.abort();
    const records: ProviderUsageLedgerRecord[] = []; cancelled.onUsageLedgerRecord = capture(records);
    await assert.rejects(requestOneShotText(cancelled), error => (error as { reason: string }).reason === 'cancelled');
    assert.equal(calls, 0);
    assert.equal(records.length, 0);
  } finally { globalThis.fetch = original; }
});

test('title usage updates the owning task cost even when its cost ceiling is unlimited', async () => {
  const original = globalThis.fetch;
  const req = input('deepseek');
  req.model.id = 'deepseek-v4-flash'; req.sourceConfig = { ...req.sourceConfig, supportsBilling: true };
  const records: ProviderUsageLedgerRecord[] = [];
  req.onUsageLedgerRecord = capture(records);
  globalThis.fetch = (async () => reply('deepseek')) as typeof fetch;
  try {
    await requestOneShotText(req);
    assert.ok(records[0].cost > 0);
    assert.equal(req.taskCostBudget!.snapshot()[records[0].currency], records[0].cost);
  } finally { globalThis.fetch = original; }
});

test('a failed title ledger write still settles task budgets and never repeats its Provider request', async () => {
  const original = globalThis.fetch;
  const req = input();
  let calls = 0;
  let budgetChanges = 0;
  req.onUsageLedgerRecord = record => { if (record.kind === 'usage_response') throw new Error('ledger unavailable'); };
  req.onBudgetChanged = () => { budgetChanges++; };
  globalThis.fetch = (async () => { calls++; return reply('openai-compatible'); }) as typeof fetch;
  try {
    await assert.rejects(requestOneShotText(req), /ledger unavailable/u);
    assert.equal(calls, 1);
    assert.equal(budgetChanges, 2);
    assert.equal(req.taskRunBudget!.state.modelRequests, 1);
    assert.equal(req.taskRunBudget!.state.upstreamTokens, 120);
  } finally { globalThis.fetch = original; }
});

test('title durable attempt intent precedes dispatch and a persistence failure cannot issue a POST', async () => {
  const original = globalThis.fetch;
  const req = input();
  let calls = 0;
  let intents = 0;
  req.onUsageLedgerRecord = record => {
    assert.equal(record.kind, 'attempt_without_usage');
    assert.equal(record.requestId, 'session_title_claim');
    intents++;
    throw new Error('attempt persistence unavailable');
  };
  globalThis.fetch = (async () => { calls++; return reply('openai-compatible'); }) as typeof fetch;
  try {
    await assert.rejects(requestOneShotText(req), /attempt persistence unavailable/u);
    assert.equal(calls, 0);
    assert.equal(intents, 2, 'cleanup may retry persisting the same unknown attempt without requesting the model');
  } finally { globalThis.fetch = original; }
});
