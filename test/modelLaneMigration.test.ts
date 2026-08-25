import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModelSourceConfigSnapshot } from '../src/accounts/types';
import {
  buildProviderRequestProjection,
  CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION
} from '../src/agent/providerRequestProjection';
import { getCacheMissPossibleReasons } from '../src/agent/usageStats';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { ChatSession, KeepseekModel } from '../src/shared/types';

interface SessionToolResolver {
  resolveSessionToolNames(
    session: ChatSession,
    prompt: string,
    model: KeepseekModel,
    sourceConfig: ModelSourceConfigSnapshot
  ): string[];
}

test('a hot v2 session keeps its frozen schema until a cache-safe migration boundary', () => {
  const now = new Date().toISOString();
  const session: ChatSession = {
    id: 'session-hot-v2',
    title: 'Hot v2 lane',
    messages: [{ id: 'u1', role: 'user', content: 'first', createdAt: now }],
    requestProtocol: {
      version: 2,
      serializationStrategy: 'provider-projection-v2',
      toolSchemaVersion: 2,
      toolNames: ['keepseek_run_validation'],
      modelId: 'same-model',
      sourceId: 'source',
      providerId: 'openai-compatible',
      baseUrl: 'https://proxy.example/v1',
      createdAt: now,
      lastProviderRequestAt: now
    },
    createdAt: now,
    updatedAt: now,
    workspaceKey: 'workspace:test',
    workspaceName: 'Test',
    workspaceFolders: [],
    isFavorite: false
  };
  const model: KeepseekModel = {
    id: 'same-model',
    label: 'Same model',
    provider: 'openai-compatible',
    sourceId: 'source'
  };
  const sourceConfig: ModelSourceConfigSnapshot = {
    sourceId: 'source',
    provider: 'openai-compatible',
    apiKey: '',
    baseUrl: 'https://proxy.example/v1',
    supportsBilling: false
  };
  const resolver = Object.create(KeepseekChatViewProvider.prototype) as SessionToolResolver;

  assert.deepEqual(resolver.resolveSessionToolNames(session, 'next', model, sourceConfig), ['keepseek_run_validation']);
  assert.equal(session.requestProtocol?.version, 2);
  assert.equal(session.requestProtocol?.toolSchemaVersion, 2);
});

test('model changes migrate the cache lane while preserving semantic summaries', () => {
  const summary = {
    id: 'summary-1',
    content: 'Earlier implementation decisions.',
    coveredMessageIds: ['a1'],
    createdAt: '2026-01-01T00:00:02.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z',
    tokenEstimate: 8,
    modelId: 'old-model',
    version: 1
  };
  const session: ChatSession = {
    id: 'session-1',
    title: 'Lane migration',
    messages: [
      { id: 'u1', role: 'user', content: 'first', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'a1', role: 'assistant', content: 'answer', createdAt: '2026-01-01T00:00:01.000Z' },
      { id: 'u2', role: 'user', content: 'next', createdAt: '2026-01-01T00:00:03.000Z' }
    ],
    contextCompression: {
      version: 1,
      summaries: [summary],
      protectedMessageIds: []
    },
    requestProtocol: {
      version: 1,
      serializationStrategy: 'legacy-v1',
      toolSchemaVersion: 1,
      toolNames: ['keepseek_list_workspace_files'],
      modelId: 'old-model',
      sourceId: 'source',
      providerId: 'openai-compatible',
      baseUrl: 'https://proxy.example/v1',
      createdAt: '2026-01-01T00:00:00.000Z',
      lastProviderRequestAt: new Date().toISOString()
    },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: new Date().toISOString(),
    workspaceKey: 'workspace:test',
    workspaceName: 'Test',
    workspaceFolders: [],
    isFavorite: false
  };
  const model: KeepseekModel = {
    id: 'new-model',
    label: 'New model',
    provider: 'openai-compatible',
    sourceId: 'source'
  };
  const sourceConfig: ModelSourceConfigSnapshot = {
    sourceId: 'source',
    provider: 'openai-compatible',
    apiKey: '',
    baseUrl: 'https://proxy.example/v1',
    supportsBilling: false
  };
  const resolver = Object.create(KeepseekChatViewProvider.prototype) as SessionToolResolver;

  resolver.resolveSessionToolNames(session, 'next', model, sourceConfig);

  assert.equal(session.requestProtocol?.modelId, 'new-model');
  assert.equal(session.requestProtocol?.version, CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION);
  assert.strictEqual(session.contextCompression?.summaries[0], summary);
  assert.equal(session.contextCompression?.summaries[0]?.modelId, 'old-model');

  const projection = buildProviderRequestProjection({
    model,
    agentSettings: {
      thinkingEnabled: true,
      reasoningEffort: 'max',
      compressionThreshold: 'balanced'
    },
    contextFiles: [],
    history: session.messages,
    contextCompression: session.contextCompression,
    language: 'en',
    prompt: 'next',
    requestProtocolVersion: session.requestProtocol?.version,
    slimToolNames: session.requestProtocol?.toolNames,
    provider: 'openai-compatible',
    sourceId: 'source',
    baseUrl: sourceConfig.baseUrl
  });
  assert.equal(projection.historyProjection.metadata.usedSummary, true);
  assert.equal(projection.messages.some((message) => (
    message.role === 'system' && message.content?.includes(summary.content)
  )), true);

  const reasons = getCacheMissPossibleReasons({
    previousDiagnostics: {
      systemPromptHash: 'system',
      toolsSchemaHash: 'tools',
      historyPrefixHash: 'history',
      modelId: 'old-model',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    diagnostics: {
      systemPromptHash: 'system',
      toolsSchemaHash: 'tools',
      historyPrefixHash: 'history',
      modelId: 'new-model',
      updatedAt: '2026-01-01T00:00:01.000Z'
    },
    previousTurnUsage: undefined,
    currentTurnUsage: undefined
  });
  assert.deepEqual(reasons, ['model_changed']);
});
