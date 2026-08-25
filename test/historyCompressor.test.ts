import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HistoryCompressor } from '../src/agent/historyCompressor';
import type { ChatMessage, ChatSession, KeepseekModel } from '../src/shared/types';

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
    model: createModel(2_000),
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
    model: createModel(2_000),
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
    model: createModel(2_000),
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

function createCompressionSettings() {
  return {
    keepRecentTurns: 2,
    softCompactRatio: 0.5,
    toolResultSnipRatio: 0.6,
    triggerRatio: 0.8,
    forceRatio: 0.9,
    summaryBudgetTokens: 1000,
    summaryRequestTimeoutMs: 30_000
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
