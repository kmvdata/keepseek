import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  analyzeModelSwitchImpact,
  isBackgroundModelSelectionLocked,
  ModelSelectionTransactionCoordinator
} from '../src/provider/modelSelection';
import {
  getProviderRequestLane,
  hasProviderNativeReplayFidelityRisk
} from '../src/agent/providerRequestProjection';
import type { ChatMessage, ChatSession, ContextUsageEstimate, KeepseekModel } from '../src/shared/types';

test('model selection transactions keep the running model and only retain the latest pending target', () => {
  const transactions = new ModelSelectionTransactionCoordinator();
  transactions.beginRun({ sourceId: 'source-a', modelId: 'model-a' });
  const first = transactions.beginRequest();
  assert.equal(transactions.queuePending({
    sourceId: 'source-b',
    modelId: 'model-b',
    requestedAt: '2026-08-25T00:00:00.000Z',
    confirmedRiskKeys: []
  }, first), true);
  const second = transactions.beginRequest();
  assert.equal(transactions.queuePending({
    sourceId: 'source-c',
    modelId: 'model-c',
    requestedAt: '2026-08-25T00:00:01.000Z',
    confirmedRiskKeys: ['context_compression_range']
  }, second), true);
  assert.equal(transactions.queuePending({
    sourceId: 'stale',
    modelId: 'stale',
    requestedAt: '2026-08-25T00:00:02.000Z',
    confirmedRiskKeys: []
  }, first), false);

  assert.deepEqual(transactions.getSnapshot().currentRun, { sourceId: 'source-a', modelId: 'model-a' });
  assert.equal(transactions.getSnapshot().pending?.modelId, 'model-c');
  assert.equal(transactions.finishRun()?.modelId, 'model-c');

  const cancel = transactions.beginRequest();
  transactions.clearPending(cancel);
  assert.equal(transactions.getSnapshot().pending, undefined);
});

test('all non-terminal background task stages lock model selection', () => {
  assert.equal(isBackgroundModelSelectionLocked('running'), true);
  assert.equal(isBackgroundModelSelectionLocked('waiting_for_apply'), true);
  assert.equal(isBackgroundModelSelectionLocked('waiting_for_authorization'), true);
  assert.equal(isBackgroundModelSelectionLocked('completed'), false);
  assert.equal(isBackgroundModelSelectionLocked('failed'), false);
  assert.equal(isBackgroundModelSelectionLocked('stopped'), false);
});

test('switch impact uses the target model window and only warns about cache lanes after a real request', () => {
  const targetModel: KeepseekModel = {
    id: 'small-model',
    label: 'Small model',
    provider: 'openai-compatible',
    sourceId: 'source-b',
    contextWindowTokens: 64_000,
    maxOutputTokens: 4_000
  };
  const session = createSession(true);
  const impact = analyzeModelSwitchImpact({
    session,
    targetModel,
    targetProvider: 'openai-compatible',
    targetSourceId: 'source-b',
    targetBaseUrl: 'https://b.example/v1',
    settings: {
      thinkingEnabled: true,
      reasoningEffort: 'high',
      compressionThreshold: 'balanced'
    },
    targetContextUsage: createUsage(64_000, 53_000)
  });

  assert.equal(impact.contextWindowTokens, 64_000);
  assert.equal(impact.usedPercent, 82.81);
  assert.ok(impact.confirmationRiskKeys.includes('context_compression_range'));
  assert.deepEqual(impact.cacheLaneChangeReasons, [
    'model_changed',
    'source_changed',
    'endpoint_lane_changed'
  ]);

  const coldImpact = analyzeModelSwitchImpact({
    ...{
      session: createSession(false),
      targetModel,
      targetProvider: 'openai-compatible' as const,
      targetSourceId: 'source-b',
      targetBaseUrl: 'https://b.example/v1',
      settings: {
        thinkingEnabled: true,
        reasoningEffort: 'high' as const,
        compressionThreshold: 'balanced' as const
      },
      targetContextUsage: createUsage(64_000, 10_000)
    }
  });
  assert.equal(coldImpact.cacheLaneChanged, false);
  assert.deepEqual(coldImpact.confirmationRiskKeys, []);
});

test('provider-native replay warning matches projection lanes without flagging ordinary tool rounds', () => {
  const chatLane = getProviderRequestLane({
    provider: 'openai-compatible',
    sourceId: 'chat-source',
    baseUrl: 'https://chat.example/v1',
    modelId: 'chat-model'
  });
  const ordinaryToolRound: ChatMessage = {
    id: 'assistant-chat',
    role: 'assistant',
    content: 'Visible answer',
    createdAt: '2026-08-25T00:00:00.000Z',
    toolRounds: [{
      assistantContent: null,
      reasoningContent: null,
      toolCalls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }],
      toolResults: [{ toolCallId: 'call-1', content: 'result' }]
    }]
  };
  assert.equal(hasProviderNativeReplayFidelityRisk([ordinaryToolRound], chatLane), false);

  const responsesMessage: ChatMessage = {
    id: 'assistant-responses',
    role: 'assistant',
    content: 'Visible answer',
    createdAt: '2026-08-25T00:00:01.000Z',
    providerReplay: {
      protocol: 'openai-responses',
      sourceId: 'responses-source',
      baseUrl: 'https://responses.example/v1',
      items: [{ type: 'reasoning', id: 'reasoning-1' }]
    }
  };
  const sameResponsesLane = getProviderRequestLane({
    provider: 'openai-responses',
    sourceId: 'responses-source',
    baseUrl: 'https://responses.example/v1',
    modelId: 'responses-model'
  });
  assert.equal(hasProviderNativeReplayFidelityRisk([responsesMessage], sameResponsesLane), false);
  assert.equal(hasProviderNativeReplayFidelityRisk([responsesMessage], chatLane), true);
});

function createSession(withRequest: boolean): ChatSession {
  return {
    id: 'session',
    title: 'Session',
    messages: withRequest ? [{
      id: 'assistant',
      role: 'assistant',
      content: 'answer',
      createdAt: '2026-08-25T00:00:00.000Z',
      modelId: 'large-model'
    }] : [],
    requestProtocol: {
      version: 3,
      serializationStrategy: 'provider-projection-v2',
      toolSchemaVersion: 3,
      toolNames: [],
      modelId: 'large-model',
      sourceId: 'source-a',
      providerId: 'openai-compatible',
      baseUrl: 'https://a.example/v1',
      createdAt: '2026-08-25T00:00:00.000Z',
      lastProviderRequestAt: withRequest ? '2026-08-25T00:00:00.000Z' : undefined
    },
    createdAt: '2026-08-25T00:00:00.000Z',
    updatedAt: '2026-08-25T00:00:00.000Z',
    workspaceKey: 'workspace:test',
    workspaceName: 'Test',
    workspaceFolders: [],
    isFavorite: false
  };
}

function createUsage(maxTokens: number, usedTokens: number): ContextUsageEstimate {
  const usedPercent = Number(((usedTokens / maxTokens) * 100).toFixed(2));
  return {
    maxTokensEstimate: maxTokens,
    usedTokensEstimate: usedTokens,
    remainingTokensEstimate: Math.max(0, maxTokens - usedTokens),
    usedPercent,
    remainingPercent: Math.max(0, 100 - usedPercent),
    breakdown: {
      systemTokensEstimate: 1_000,
      contextFileTokensEstimate: 0,
      historyTokensEstimate: usedTokens - 1_000,
      inputTokensEstimate: 0,
      toolSchemaTokensEstimate: 0,
      toolCallTokensEstimate: 0,
      toolResultTokensEstimate: 0,
      reasoningTokensEstimate: 0,
      outputReserveTokensEstimate: 0,
      safetyReserveTokensEstimate: 0
    }
  };
}
