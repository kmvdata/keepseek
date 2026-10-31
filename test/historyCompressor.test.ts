import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryCompressor, measureCompressionProjection } from '../src/agent/historyCompressor';
import { buildProviderPayloadProjection, buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { resolveProviderRequestBudget } from '../src/agent/requestBudget';
import type { ChatMessage, ChatSession, KeepseekModel } from '../src/shared/types';

test('compression measures the shared final payload with model provider fallback and learned capacity', () => {
  for (const provider of ['qwencloud', 'openai-responses', 'anthropic-compatible'] as const) {
    const input = { session: createSession(Array.from({ length: 30 }, (_, i) => createMessage(i, 'context '.repeat(30)))),
      prompt: 'current request', model: { ...createModel(1024000), provider, maxOutputTokens: 393192 },
      agentSettings: { thinkingEnabled: true, reasoningEffort: 'high' as const, compressionThreshold: 'balanced' as const }, contextFiles: [], language: 'en' as const,
      calibration: { learnedEffectiveWindowTokens: 800000, estimatorScale: 1.2, lastActualInputTokens: 500, lastEstimatedInputTokens: 400 } };
    const p = buildProviderRequestProjection({ ...input, history: input.session.messages });
    const body = buildProviderPayloadProjection({ modelId: input.model.id, provider, maxOutputTokens: p.runtimeProfile.maxTokens,
      messages: p.messages, tools: p.tools, native: p.responses ? { protocol: 'openai-responses', ...p.responses }
        : p.anthropic ? { protocol: 'anthropic-messages', ...p.anthropic } : undefined });
    const measured = measureCompressionProjection(input);
    assert.deepEqual(measured.body, body);
    assert.deepEqual(measured.budget, resolveProviderRequestBudget({ model: input.model, provider, body, calibration: input.calibration }));
    assert.equal(measured.budget.modelMaxOutputTokens, 393192);
    assert.equal(measured.budget.effectiveWindowTokens, 800000);
  }
});

test('cancellation during summary completion keeps audit history and does not adopt a summary', async () => {
  const controller = new AbortController();
  const compressor = new HistoryCompressor(async () => { controller.abort(); return 'small summary'; });
  const session = createSession(Array.from({ length: 30 }, (_, i) => createMessage(i, 'context '.repeat(300))));
  const original = JSON.stringify(session.messages);
  const result = await compressor.refresh({ session, prompt: 'current', model: createModel(200000),
    agentSettings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' }, contextFiles: [], language: 'en', signal: controller.signal,
    settings: { ...createCompressionSettings(), triggerRatio: 0.01, forceRatio: 0.02 } });
  assert.equal(result.reason, 'skipped');
  assert.deepEqual(result.state.summaries, []);
  assert.equal(JSON.stringify(session.messages), original);
});

test('context compression planning does not refresh below compact ratio', () => {
  const compressor = new HistoryCompressor(async () => 'unused');
  const session = createSession(Array.from({ length: 30 }, (_value, index) => createMessage(index, 'short')));

  const plan = compressor.planRefresh({
    session,
    prompt: 'current request',
    model: createModel(1_000_000),
    agentSettings: { thinkingEnabled: true, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [],
    language: 'en',
    settings: createCompressionSettings()
  });

  assert.equal(plan.mode, 'none');
  assert.equal(plan.reason, 'fresh_enough');
});

test('context compression planning uses synchronous refresh over force ratio', () => {
  const compressor = new HistoryCompressor(async () => 'unused');
  const session = createSession(Array.from({ length: 30 }, (_value, index) => (
    createMessage(index, 'large referenced context '.repeat(40))
  )));

  const plan = compressor.planRefresh({
    session,
    prompt: 'current request',
    model: createModel(800),
    agentSettings: { thinkingEnabled: true, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [],
    language: 'en',
    settings: createCompressionSettings()
  });

  assert.equal(plan.mode, 'sync');
  assert.equal(plan.reason, 'force_context_limit');
});

test('summary character cap covers only message ids actually included in the successful request', async () => {
  let capturedPrompt = '';
  const compressor = new HistoryCompressor(async (input) => {
    capturedPrompt = input.messages[1]?.content ?? '';
    return 'bounded summary';
  });
  const messages = Array.from({ length: 12 }, (_value, index) => createMessage(
    index,
    index === 0 || index >= 10 ? `small ${index}` : `${`payload-${index} `.repeat(5_000)}`
  ));
  const session = createSession(messages);
  const result = await compressor.refresh({
    session,
    prompt: 'current request',
    model: createModel(200_000),
    agentSettings: { thinkingEnabled: true, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [],
    language: 'en',
    sourceConfig: {
      sourceId: 'summary-source',
      provider: 'openai-compatible',
      apiKey: '',
      baseUrl: 'https://summary.example/v1',
      supportsBilling: false
    },
    settings: { ...createCompressionSettings(), keepRecentTurns: 1, triggerRatio: 0.01, forceRatio: 0.02 }
  });

  const createdSummary = result.state.summaries.at(-1);
  const covered = new Set(createdSummary?.coveredMessageIds ?? []);
  assert.equal(createdSummary?.modelId, 'test-model');
  assert.equal(createdSummary?.sourceId, 'summary-source');
  assert.equal(createdSummary?.provider, 'openai-compatible');
  assert.ok(covered.size > 0);
  assert.ok(covered.size < messages.length - 2);
  for (const message of messages) {
    assert.equal(covered.has(message.id), capturedPrompt.includes(`Message ${message.id}\n`));
  }
  const firstUncoveredCompressible = messages.slice(1, 10).find((message) => !covered.has(message.id));
  assert.ok(firstUncoveredCompressible, 'overflow messages must remain for a later batch');
});

test('summary failure never advances covered ids', async () => {
  const compressor = new HistoryCompressor(async () => {
    throw new Error('summary failed');
  });
  const messages = Array.from({ length: 12 }, (_value, index) => createMessage(index, `payload ${index} `.repeat(500)));
  const result = await compressor.refresh({
    session: createSession(messages),
    prompt: 'current request',
    model: createModel(200_000),
    agentSettings: { thinkingEnabled: true, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [],
    language: 'en',
    settings: { ...createCompressionSettings(), keepRecentTurns: 1, triggerRatio: 0.01, forceRatio: 0.02 }
  });

  assert.equal(result.reason, 'failed');
  assert.deepEqual(result.state.summaries, []);
});

test('new compression appends an immutable summary segment without rewriting the old one', async () => {
  const messages = Array.from({ length: 20 }, (_value, index) => createMessage(index, `payload ${index} `.repeat(300)));
  const session = createSession(messages);
  session.contextCompression = {
    version: 1,
    protectedMessageIds: [],
    summaries: [{
      id: 'summary-old',
      content: 'BYTE-STABLE OLD SUMMARY',
      coveredMessageIds: messages.slice(1, 8).map((message) => message.id),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tokenEstimate: 6,
      version: 1
    }]
  };
  const compressor = new HistoryCompressor(async () => 'NEW SUMMARY SEGMENT');
  const result = await compressor.refresh({
    session,
    prompt: 'current request',
    model: createModel(200_000),
    agentSettings: { thinkingEnabled: true, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [],
    language: 'en',
    settings: { ...createCompressionSettings(), keepRecentTurns: 1, triggerRatio: 0.01, forceRatio: 0.02 }
  });

  assert.equal(result.reason, 'updated');
  assert.equal(result.state.summaries.length, 2);
  assert.equal(result.state.summaries[0]?.id, 'summary-old');
  assert.equal(result.state.summaries[0]?.content, 'BYTE-STABLE OLD SUMMARY');
  assert.equal(result.state.summaries[1]?.content, 'NEW SUMMARY SEGMENT');
  assert.equal(result.state.summaries[1]?.coveredMessageIds.some((id) => (
    result.state.summaries[0]?.coveredMessageIds.includes(id)
  )), false);
});

test('summary completion budget never exceeds the model runtime output limit', async () => {
  let capturedMaxTokens = 0;
  const compressor = new HistoryCompressor(async (input) => {
    capturedMaxTokens = input.maxTokens;
    return 'bounded';
  });
  const messages = Array.from({ length: 12 }, (_value, index) => (
    createMessage(index, `payload ${index} `.repeat(500))
  ));
  const result = await compressor.refresh({
    session: createSession(messages),
    prompt: 'current request',
    model: { ...createModel(20_000), maxOutputTokens: 500 },
    agentSettings: { thinkingEnabled: true, reasoningEffort: 'max', compressionThreshold: 'balanced' },
    contextFiles: [],
    language: 'en',
    settings: { ...createCompressionSettings(), keepRecentTurns: 1, triggerRatio: 0.01, forceRatio: 0.02 }
  });

  assert.equal(result.reason, 'created');
  assert.equal(capturedMaxTokens, 500);
});

test('negative net summary gain retains audit and is not retried for the same final context', async () => {
  let calls = 0;
  const compressor = new HistoryCompressor(async () => { calls++; return 'Long useless summary '.repeat(5000); });
  const session = createSession(Array.from({ length: 30 }, (_, i) => createMessage(i, 'unchanged context '.repeat(20))));
  const before = JSON.stringify(session.messages);
  const input = { session, prompt: 'current request', model: { ...createModel(20000), maxOutputTokens: 15000 },
    agentSettings: { thinkingEnabled: false, reasoningEffort: 'high' as const, compressionThreshold: 'balanced' as const },
    contextFiles: [], language: 'en' as const,
    settings: { ...createCompressionSettings(), triggerRatio: 0.01, forceRatio: 0.02 } };
  const result = await compressor.refresh(input);
  assert.equal(result.failureReason, 'summary_no_net_gain');
  assert.ok(result.state.lastCompression!.netReleasedTokens < 0);
  session.contextCompression = result.state;
  assert.equal(compressor.planRefresh(input).mode, 'none');
  assert.equal((await compressor.refresh(input)).reason, 'skipped');
  assert.equal(calls, 1); assert.equal(JSON.stringify(session.messages), before);
  assert.equal(result.state.summaries.length, 0);
});

function createCompressionSettings() {
  return {
    keepRecentTurns: 2,
    softCompactRatio: 0.5,
    toolResultSnipRatio: 0.6,
    triggerRatio: 0.8,
    forceRatio: 0.9,
    summaryBudgetTokens: 1000
  };
}

function createSession(messages: ChatMessage[]): ChatSession {
  const now = new Date(0).toISOString();
  return {
    id: 'session-1',
    title: 'Compression Plan',
    messages,
    createdAt: now,
    updatedAt: now,
    workspaceKey: 'workspace:test',
    workspaceName: 'Test Workspace',
    workspaceFolders: [],
    isFavorite: false
  };
}

function createMessage(index: number, content: string): ChatMessage {
  return {
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `${content} ${index}`,
    createdAt: new Date(index * 1000).toISOString()
  };
}

function createModel(contextWindowTokens: number): KeepseekModel {
  return {
    id: 'test-model',
    label: 'Test Model',
    provider: 'test',
    contextWindowTokens
  };
}
