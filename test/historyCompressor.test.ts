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
    contextFiles: [],
    language: 'en',
    settings: createCompressionSettings()
  });

  assert.equal(plan.mode, 'sync');
  assert.equal(plan.reason, 'force_context_limit');
});

function createCompressionSettings() {
  return {
    enabled: true,
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
