import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHistoryProjection } from '../src/agent/historyProjection';
import type { ChatMessage, ContextCompressionState } from '../src/shared/types';

test('history projection uses summary, protected messages, and recent turns without full raw history', () => {
  const messages = Array.from({ length: 20 }, (_value, index): ChatMessage => ({
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    expandedContent: index === 2 ? `message ${index}\n\nexpanded file body`.repeat(200) : undefined,
    createdAt: new Date(index * 1000).toISOString()
  }));
  const contextCompression: ContextCompressionState = {
    version: 1,
    protectedMessageIds: [],
    summaries: [
      {
        id: 'summary-1',
        content: 'Earlier turns discussed setup decisions and files to reread.',
        coveredMessageIds: messages.slice(0, 16).map((message) => message.id),
        createdAt: new Date(20_000).toISOString(),
        updatedAt: new Date(20_000).toISOString(),
        tokenEstimate: 12,
        version: 1
      }
    ]
  };

  const projection = buildHistoryProjection({
    history: messages,
    prompt: 'current request',
    language: 'en',
    contextCompression,
    settings: {
      keepRecentTurns: 2,
      softCompactRatio: 0.5,
      toolResultSnipRatio: 0.6,
      triggerRatio: 0.8,
      forceRatio: 0.9,
      summaryBudgetTokens: 1000,
      summaryRequestTimeoutMs: 30_000
    }
  });

  assert.equal(projection.syntheticSystemMessages.length, 1);
  assert.equal(projection.metadata.usedSummary, true);
  assert.deepEqual(
    projection.history.map((message) => message.id),
    ['m0', 'm16', 'm17', 'm18', 'm19']
  );
  // m0..m15 are all covered by the summary, so nothing remains compressible.
  assert.deepEqual(projection.compressibleMessageIds, []);
  assert.equal(projection.history.find((message) => message.id === 'm2'), undefined);
});

test('history projection is append-only without a summary so the prefix never rewrites', () => {
  const messages = Array.from({ length: 20 }, (_value, index): ChatMessage => ({
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    expandedContent: index === 2 ? `message ${index}\n\nexpanded file body`.repeat(200) : undefined,
    createdAt: new Date(index * 1000).toISOString()
  }));

  const projection = buildHistoryProjection({
    history: messages,
    prompt: 'current request',
    language: 'en',
    contextCompression: undefined,
    settings: createProjectionSettings()
  });

  // Without a summary every message stays in the projection: the request prefix
  // only grows turn over turn and mid-history bytes never change (DeepSeek prefix
  // cache requires a byte-identical prefix from token 0).
  assert.deepEqual(
    projection.history.map((message) => message.id),
    messages.map((message) => message.id)
  );
  assert.deepEqual(projection.syntheticSystemMessages, []);
  // Window-external, unprotected, uncovered messages are compressible candidates.
  assert.deepEqual(
    projection.compressibleMessageIds,
    messages.slice(1, 16).map((message) => message.id)
  );
});

test('covered messages leave the projection; uncovered ones stay frozen with expandedContent', () => {  const messages = Array.from({ length: 20 }, (_value, index): ChatMessage => ({
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    expandedContent: index === 0 ? `message ${index}\n\nexpanded file body`.repeat(50) : undefined,
    createdAt: new Date(index * 1000).toISOString()
  }));
  const contextCompression: ContextCompressionState = {
    version: 1,
    protectedMessageIds: [],
    summaries: [
      {
        id: 'summary-1',
        content: 'Early turns discussed setup decisions.',
        coveredMessageIds: messages.slice(0, 6).map((message) => message.id),
        createdAt: new Date(6_000).toISOString(),
        updatedAt: new Date(6_000).toISOString(),
        tokenEstimate: 8,
        version: 1
      }
    ]
  };

  const projection = buildHistoryProjection({
    history: messages,
    prompt: 'current request',
    language: 'en',
    contextCompression,
    settings: createProjectionSettings()
  });

  // Covered non-protected messages (m1..m5) leave the projection; the protected
  // first user message (m0) and every uncovered message (m6..m19) stay.
  assert.deepEqual(
    projection.history.map((message) => message.id),
    ['m0', ...messages.slice(6).map((message) => message.id)]
  );
  // Protected messages outside the recent window keep their expandedContent: their
  // serialized bytes must never change between turns.
  const firstMessage = projection.history[0];
  assert.equal(firstMessage?.id, 'm0');
  assert.ok(firstMessage?.expandedContent?.includes('expanded file body'));
  // Uncovered window-external messages remain compressible for the next refresh.
  assert.deepEqual(
    projection.compressibleMessageIds,
    messages.slice(6, 16).map((message) => message.id)
  );
});

test('projection truncates to the recent tail when no summary exists and the budget cap is exceeded', () => {
  const messages = Array.from({ length: 20 }, (_value, index): ChatMessage => ({
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index} `.repeat(300),
    createdAt: new Date(index * 1000).toISOString()
  }));

  const projection = buildHistoryProjection({
    history: messages,
    prompt: 'current request',
    language: 'en',
    contextCompression: undefined,
    settings: createProjectionSettings(),
    maxProjectionTokens: 500
  });

  // Degraded-mode fallback: without a summary the projection would otherwise grow
  // without bound when compression refreshes keep failing, so it is capped to the
  // most recent messages. This is the rare failure path, not the append-only path.
  assert.ok(projection.history.length > 0);
  assert.ok(projection.history.length < messages.length);
  assert.equal(projection.history.at(-1)?.id, 'm19');

  // The cap only applies without a summary; with one, the projection stays full.
  const withSummary = buildHistoryProjection({
    history: messages,
    prompt: 'current request',
    language: 'en',
    contextCompression: {
      version: 1,
      protectedMessageIds: [],
      summaries: [{
        id: 'summary-1',
        content: 'Earlier turns summarized.',
        coveredMessageIds: [],
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        tokenEstimate: 5,
        version: 1
      }]
    },
    settings: createProjectionSettings(),
    maxProjectionTokens: 500
  });
  assert.equal(withSummary.history.length, messages.length);
});

function createProjectionSettings() {
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
