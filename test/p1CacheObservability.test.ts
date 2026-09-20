import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import * as vscode from 'vscode';
import type { DeepSeekChatRequestBody } from '../src/agent/deepseek/types';
import type { OpenAiResponsesRequestBody } from '../src/agent/providers/responsesTypes';
import type { AnthropicMessagesRequestBody } from '../src/agent/providers/anthropicTypes';
import {
  createProviderCacheObservation,
  finalizeCacheObservationWithUsage
} from '../src/agent/cacheObservation';
import {
  createUsageLedgerRecords,
  createUsagePriceSnapshot,
  summarizeCacheDiagnostics
} from '../src/agent/usageLedger';
import { UsageLedgerStore } from '../src/agent/usageLedgerStore';
import { shouldRolloverForSoftContextPressure } from '../src/agent/contextEpoch';
import type { ProviderCacheObservation, ProviderUsageLedgerRecord, Usage } from '../src/shared/types';

const TOOL = {
  type: 'function' as const,
  function: {
    name: 'read',
    description: 'Read',
    parameters: { type: 'object' as const, properties: {}, additionalProperties: false }
  }
};

const USAGE: Usage = {
  promptTokens: 100_000,
  completionTokens: 1_000,
  totalTokens: 101_000,
  cacheHitTokens: 75_000,
  cacheMissTokens: 25_000,
  cacheDataStatus: 'reported'
};

function chatBody(messages: DeepSeekChatRequestBody['messages'], model = 'deepseek-v4-flash'): DeepSeekChatRequestBody {
  return { model, messages, tools: [TOOL], tool_choice: 'auto', stream: true, stream_options: { include_usage: true } };
}

function observation(input: {
  body: DeepSeekChatRequestBody | OpenAiResponsesRequestBody | AnthropicMessagesRequestBody;
  requestId: string;
  previous?: ProviderCacheObservation;
  source?: ProviderCacheObservation['source'];
  sourceId?: string;
  provider?: 'deepseek' | 'openai-responses' | 'anthropic-compatible';
  baseUrl?: string;
  estimatedPromptTokens?: number;
  attemptIndex?: number;
  epoch?: number;
  historyCompacted?: boolean;
}) {
  return createProviderCacheObservation({
    requestId: input.requestId,
    attemptIndex: input.attemptIndex ?? 0,
    source: input.source ?? 'executor',
    sourceId: input.sourceId ?? 'official',
    provider: input.provider ?? 'deepseek',
    baseUrl: input.baseUrl ?? 'https://api.deepseek.com',
    body: input.body,
    taskId: 'task-1',
    runId: 'run-1',
    contextEpochIndex: input.epoch ?? 0,
    requestProtocolVersion: 9,
    contextInstructions: 'PROJECT',
    estimatedPromptTokens: input.estimatedPromptTokens,
    previous: input.previous,
    historyCompacted: input.historyCompacted
  });
}

test('all three protocols derive content-free observations from their actual native projections', () => {
  const chat = observation({
    requestId: 'chat',
    body: chatBody([{ role: 'system', content: 'SYSTEM' }, { role: 'system', content: 'PROJECT' }, { role: 'user', content: 'hello' }])
  });
  const responses = observation({
    requestId: 'responses', provider: 'openai-responses', baseUrl: 'https://example.test/v1',
    body: {
      model: 'deepseek-v4-flash', stream: true, store: false,
      input: [{ role: 'system', content: 'SYSTEM' }, { role: 'system', content: 'PROJECT' }, { role: 'user', content: 'hello' }]
    }
  });
  const anthropic = observation({
    requestId: 'anthropic', provider: 'anthropic-compatible', baseUrl: 'https://api.anthropic.com',
    body: {
      model: 'deepseek-v4-flash', stream: true, max_tokens: 100,
      system: [{ type: 'text', text: 'SYSTEM' }, { type: 'text', text: 'PROJECT' }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }]
    }
  });
  for (const value of [chat, responses, anthropic]) {
    assert.match(value.cacheableProjection.hash, /^[a-f0-9]{64}$/u);
    assert.ok(value.system.byteLength > 0);
    assert.ok(value.contextInstructions.byteLength > 0);
    assert.ok(value.providerHistory.byteLength > 0);
    assert.equal(JSON.stringify(value).includes('hello'), false, 'prompt content is not persisted');
  }
});

test('append-only native history proves a strict byte prefix even though the whole history hash changes', () => {
  const first = observation({
    requestId: 'one', estimatedPromptTokens: 76_000,
    body: chatBody([{ role: 'system', content: 'SYSTEM' }, { role: 'system', content: 'PROJECT' }, { role: 'user', content: 'one' }])
  });
  const second = observation({
    requestId: 'two', previous: first, estimatedPromptTokens: 100_000,
    body: chatBody([
      { role: 'system', content: 'SYSTEM' }, { role: 'system', content: 'PROJECT' },
      { role: 'user', content: 'one' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'two' }
    ])
  });
  assert.notEqual(first.providerHistory.hash, second.providerHistory.hash);
  assert.equal(second.prefixRelation, 'strict_prefix');
  assert.equal(second.inheritsPreviousCacheablePrefix, true);
  assert.equal(second.reason, 'append_only_prefix_preserved');
  assert.equal(second.reusablePrefixTokensEstimate, 76_000);
});

test('the first changed local segment is deterministic for system, context, tools and history', () => {
  const baseBody = chatBody([
    { role: 'system', content: 'SYSTEM' }, { role: 'system', content: 'PROJECT' }, { role: 'user', content: 'one' }
  ]);
  const base = observation({ requestId: 'base', body: baseBody });
  const system = observation({ requestId: 'system', previous: base, body: chatBody([
    { role: 'system', content: 'SYSTEM-2' }, { role: 'system', content: 'PROJECT' }, { role: 'user', content: 'one' }
  ]) });
  const context = createProviderCacheObservation({
    requestId: 'context', attemptIndex: 0, source: 'executor', sourceId: 'official', provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com', body: chatBody([
      { role: 'system', content: 'SYSTEM' }, { role: 'system', content: 'PROJECT-2' }, { role: 'user', content: 'one' }
    ]), contextInstructions: 'PROJECT-2', requestProtocolVersion: 9, previous: base
  });
  const tools = observation({ requestId: 'tools', previous: base, body: {
    ...baseBody,
    tools: [{ ...TOOL, function: { ...TOOL.function, description: 'Changed' } }]
  } });
  const history = observation({ requestId: 'history', previous: base, body: chatBody([
    { role: 'system', content: 'SYSTEM' }, { role: 'system', content: 'PROJECT' }, { role: 'user', content: 'rewritten' }
  ]) });
  assert.deepEqual(
    [system.firstChangedSegment, context.firstChangedSegment, tools.firstChangedSegment, history.firstChangedSegment],
    ['system', 'context_instructions', 'tools', 'provider_history']
  );
  assert.equal(history.reason, 'unexpected_local_prefix_break');
});

test('wire model aliases remain separate cache lanes while sharing canonical identity', () => {
  const first = observation({ requestId: 'one', body: chatBody([{ role: 'user', content: 'one' }], 'deepseek-flash') });
  const second = observation({
    requestId: 'two', previous: first,
    body: chatBody([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }], 'deepseek-v4.1-flash')
  });
  assert.equal(first.canonicalModelIdentity, second.canonicalModelIdentity);
  assert.notEqual(first.laneKey, second.laneKey);
  assert.equal(second.reason, 'model_lane_changed');
  assert.equal(second.inheritsPreviousCacheablePrefix, false);
});

test('100K prompt with 76K reusable and 75K hit is healthy at about 98.7% reuse', () => {
  const first = observation({ requestId: 'one', estimatedPromptTokens: 76_000,
    body: chatBody([{ role: 'user', content: 'one' }]) });
  const second = observation({ requestId: 'two', previous: first, estimatedPromptTokens: 100_000,
    body: chatBody([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'answer' }]) });
  const snapshot = createUsagePriceSnapshot({
    originalModelId: 'deepseek-v4-flash', sourceId: 'official', provider: 'deepseek',
    protocol: 'chat-completions', supportsBilling: true, requestStartedAt: '2026-09-21T04:00:00.000Z'
  });
  const records = createUsageLedgerRecords({
    requestId: 'two', attempts: [snapshot], usage: USAGE, source: 'executor', cacheObservations: [second]
  });
  const metrics = summarizeCacheDiagnostics(records);
  assert.ok(Math.abs((metrics.rawHitRate ?? 0) - 75) < 0.01);
  assert.ok(Math.abs((metrics.expectedRawHitRateCeiling ?? 0) - 76) < 0.01);
  assert.ok(Math.abs((metrics.reuseEfficiency ?? 0) - 98.6842) < 0.01);
  assert.equal(metrics.healthyReusableRequestCount, 1);
  assert.equal(metrics.anomalousReusableRequestCount, 0);
});

test('cold starts and controlled rollovers are excluded from the 95% health target', () => {
  const cold = observation({ requestId: 'cold', body: chatBody([{ role: 'user', content: 'one' }]) });
  const rollover = observation({ requestId: 'rollover', previous: cold, epoch: 1,
    body: chatBody([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }]) });
  assert.equal(cold.eligibleForHealthTarget, false);
  assert.equal(cold.reason, 'cold_start');
  assert.equal(rollover.reason, 'context_epoch_rollover');
  assert.equal(rollover.reasonCategory, 'controlled_boundary');
  assert.equal(rollover.eligibleForHealthTarget, false);
});

test('possible Provider eviction requires a proven stable prefix and reported cache data', () => {
  const first = observation({ requestId: 'one', estimatedPromptTokens: 80_000,
    body: chatBody([{ role: 'user', content: 'one' }]) });
  const stable = observation({ requestId: 'two', previous: first, estimatedPromptTokens: 100_000,
    body: chatBody([{ role: 'user', content: 'one' }, { role: 'assistant', content: 'two' }]) });
  const lowHit = finalizeCacheObservationWithUsage(stable, { ...USAGE, cacheHitTokens: 20_000, cacheMissTokens: 80_000 });
  assert.equal(lowHit.reason, 'provider_cache_eviction_possible');
  const unavailable = finalizeCacheObservationWithUsage(stable, {
    ...USAGE, cacheHitTokens: 0, cacheMissTokens: 0, cacheDataStatus: 'unavailable'
  });
  assert.equal(unavailable.reason, 'provider_cache_metrics_unavailable');
  assert.equal(unavailable.reuseEfficiencyRaw, undefined);
});

test('usage sources are isolated and retry attempts do not fabricate cache usage', () => {
  const base = observation({ requestId: 'base', source: 'executor', estimatedPromptTokens: 10_000,
    body: chatBody([{ role: 'user', content: 'base' }]) });
  const executor = observation({ requestId: 'executor', source: 'executor', previous: base, estimatedPromptTokens: 12_000,
    body: chatBody([{ role: 'user', content: 'base' }, { role: 'assistant', content: 'next' }]) });
  const reviewer = observation({ requestId: 'reviewer', source: 'reviewer',
    body: chatBody([{ role: 'system', content: 'review' }, { role: 'user', content: 'item' }]) });
  const retry = observation({ requestId: 'executor', source: 'executor', previous: executor, attemptIndex: 1,
    body: chatBody([{ role: 'user', content: 'base' }, { role: 'assistant', content: 'next' }]) });
  assert.equal(retry.prefixRelation, 'identical_retry');
  assert.equal(retry.inheritsPreviousCacheablePrefix, true);
  const snapshot = createUsagePriceSnapshot({ originalModelId: 'deepseek-v4-flash', sourceId: 'official',
    provider: 'deepseek', protocol: 'chat-completions', supportsBilling: true });
  const records = [
    ...createUsageLedgerRecords({ requestId: 'executor', attempts: [snapshot, snapshot], usage: {
      ...USAGE, promptTokens: 12_000, cacheHitTokens: 10_000, cacheMissTokens: 2_000
    }, source: 'executor', cacheObservations: [executor, retry] }),
    ...createUsageLedgerRecords({ requestId: 'reviewer', attempts: [snapshot], usage: {
      ...USAGE, promptTokens: 2_000, cacheHitTokens: 0, cacheMissTokens: 2_000
    }, source: 'reviewer', cacheObservations: [reviewer] })
  ];
  const metrics = summarizeCacheDiagnostics(records);
  assert.equal(metrics.bySource.length, 2);
  assert.equal(records.filter((record) => record.kind === 'usage_response').length, 2);
  assert.equal(records[0]?.kind, 'attempt_without_usage');
  assert.equal(records[0]?.usage, undefined);
});

test('Responses replay items and Anthropic thinking/tool blocks preserve append-only native prefixes', () => {
  const responses1 = observation({ requestId: 'r1', provider: 'openai-responses', body: {
    model: 'm', stream: true, store: false,
    input: [{ role: 'user', content: 'one' }, { type: 'function_call', id: 'x', call_id: 'c', name: 'read', arguments: '{}' }]
  } });
  const responses2 = observation({ requestId: 'r2', provider: 'openai-responses', previous: responses1, body: {
    model: 'm', stream: true, store: false,
    input: [
      { role: 'user', content: 'one' },
      { type: 'function_call', id: 'x', call_id: 'c', name: 'read', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c', output: 'result' }
    ]
  } });
  const anthropic1 = observation({ requestId: 'a1', provider: 'anthropic-compatible', body: {
    model: 'm', stream: true, max_tokens: 100, system: [], messages: [
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'think', signature: 'sig' },
        { type: 'tool_use', id: 'tool', name: 'read', input: {} }
      ] }
    ]
  } });
  const anthropic2 = observation({ requestId: 'a2', provider: 'anthropic-compatible', previous: anthropic1, body: {
    model: 'm', stream: true, max_tokens: 100, system: [], messages: [
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'think', signature: 'sig' },
        { type: 'tool_use', id: 'tool', name: 'read', input: {} }
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool', content: 'result' }] }
    ]
  } });
  assert.equal(responses2.prefixRelation, 'strict_prefix');
  assert.equal(anthropic2.prefixRelation, 'strict_prefix');
});

test('soft-pressure hysteresis suppresses immediate post-rollover loops without masking real pressure', () => {
  assert.equal(shouldRolloverForSoftContextPressure({
    estimatedPromptTokens: 900, learnedEffectiveWindowTokens: 1_000, triggerRatio: 0.8, epochIndex: 1, turnsInEpoch: 1
  }), false);
  assert.equal(shouldRolloverForSoftContextPressure({
    estimatedPromptTokens: 900, learnedEffectiveWindowTokens: 1_000, triggerRatio: 0.8, epochIndex: 1, turnsInEpoch: 2
  }), true);
});

test('v1 inline ledger migration is idempotent, pageable and rebuilds after aggregate loss', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-usage-ledger-'));
  const store = new UsageLedgerStore(vscode.Uri.file(root) as unknown as import('vscode').Uri);
  const records = makeRecords(12);
  const session = {
    id: 'session-one', usageLedger: { version: 1 as const, records, legacyAggregate: false, incomplete: false }
  };
  const firstRef = await store.migrateInlineLedger(session);
  const secondRef = await store.migrateInlineLedger({ ...session, usageLedgerRef: firstRef });
  assert.deepEqual(secondRef, firstRef);
  const firstPage = await store.readPage(session.id, { limit: 5 });
  assert.equal(firstPage.records.length, 5);
  assert.ok(firstPage.nextCursor);
  const rebuilt = await store.rebuild(session.id);
  assert.equal(rebuilt.summary.providerAttemptCount, 12);
  assert.equal(rebuilt.summary.usageResponseCount, 12);
  assert.equal(rebuilt.summary.totalTokens, 144);
  assert.ok((rebuilt.summary.costByCurrency['¥'] ?? 0) > 0);
  await store.append(session.id, records[0]!);
  assert.equal((await store.readAll(session.id)).records.length, 12, 'request + attempt identity is idempotent');
});

test('10,000 ledger records use bounded bucket writes and one-pass paged reads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-usage-ledger-perf-'));
  const store = new UsageLedgerStore(vscode.Uri.file(root) as unknown as import('vscode').Uri);
  const records = makeRecords(10_000);
  const started = performance.now();
  const append = await store.appendMany('large-session', records);
  const page = await store.readPage('large-session', { limit: 333 });
  const all = await store.readAll('large-session');
  const rebuilt = await store.rebuild('large-session');
  const elapsedMs = performance.now() - started;
  assert.equal(append.appended, 10_000);
  assert.equal(page.records.length, 333);
  assert.equal(all.records.length, 10_000);
  assert.equal(rebuilt.summary.providerAttemptCount, 10_000);
  assert.equal(rebuilt.summary.totalTokens, 120_000);
  assert.ok(elapsedMs < 15_000, `10K ledger benchmark took ${elapsedMs.toFixed(0)}ms`);
});

test('Webview usage code has no endpoint identity, internal hash, prompt body or ledger record payload', async () => {
  const sources = await Promise.all([
    readFile(join(process.cwd(), 'src/webview/input/usage/formatters.ts'), 'utf8'),
    readFile(join(process.cwd(), 'src/webview/input/usage/script.ts'), 'utf8')
  ]);
  const code = sources.join('\n');
  for (const secretField of ['endpointLaneIdentity', 'laneKey', 'cacheableProjection', 'priceSnapshot']) {
    assert.equal(code.includes(secretField), false, secretField);
  }
});

function makeRecords(count: number): ProviderUsageLedgerRecord[] {
  const snapshot = createUsagePriceSnapshot({
    originalModelId: 'deepseek-v4-flash', sourceId: 'official', provider: 'deepseek',
    protocol: 'chat-completions', supportsBilling: true, requestStartedAt: '2026-09-21T04:00:00.000Z'
  });
  const records: ProviderUsageLedgerRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    records.push(...createUsageLedgerRecords({
      requestId: `request-${index}`, attempts: [snapshot], usage: {
        promptTokens: 10, completionTokens: 2, totalTokens: 12,
        cacheHitTokens: 8, cacheMissTokens: 2, cacheDataStatus: 'reported'
      }, source: index % 2 ? 'executor' : 'summary'
    }));
  }
  return records;
}
