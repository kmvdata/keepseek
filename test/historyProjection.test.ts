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
      enabled: true,
      keepRecentTurns: 2,
      softCompactRatio: 0.5,
      toolResultSnipRatio: 0.6,
      triggerRatio: 0.8,
      forceRatio: 0.9,
      summaryBudgetTokens: 1000
    }
  });

  assert.equal(projection.useLegacyHistoryLimit, false);
  assert.equal(projection.syntheticSystemMessages.length, 1);
  assert.equal(projection.metadata.usedSummary, true);
  assert.deepEqual(
    projection.history.map((message) => message.id),
    ['m0', 'm16', 'm17', 'm18', 'm19']
  );
  assert.ok(projection.compressibleMessageIds.includes('m2'));
  assert.ok(!projection.compressibleMessageIds.includes('m16'));
  assert.equal(projection.history.find((message) => message.id === 'm2'), undefined);
});
