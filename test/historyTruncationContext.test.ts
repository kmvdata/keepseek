import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildProviderPayloadProjection, buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { createProviderCacheObservation, finalizeCacheObservationWithUsage } from '../src/agent/cacheObservation';
import { createHistorySummaryProvenance, historySummaryHash, reconcileTruncatedContext } from '../src/sessions/historyTruncationContext';
import { normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import type { ChatMessage, ChatSession, HistorySummary } from '../src/shared/types';

const NOW = '2026-11-06T00:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function message(id: string, role: 'user' | 'assistant', content = id): ChatMessage {
  return { id, role, content, createdAt: NOW };
}
function session(messages: ChatMessage[]): ChatSession {
  return { id: 'session', title: 'test', messages, createdAt: NOW, updatedAt: NOW, workspaceKey: 'workspace',
    workspaceName: 'workspace', workspaceFolders: [], isFavorite: false, contextInstructions: 'stable project context',
    requestProtocol: { version: 14, toolSchemaVersion: 14, serializationStrategy: 'provider-projection-v2',
      toolNames: ['keepseek_read_workspace_file_range', 'keepseek_list_workspace_files'], createdAt: NOW } };
}
function summary(id: string, messages: ChatMessage[]): HistorySummary {
  return { id, content: `${id} exact summary bytes`, coveredMessageIds: messages.map(m => m.id), createdAt: NOW,
    updatedAt: NOW, tokenEstimate: 20, version: 1, provenance: createHistorySummaryProvenance(messages) };
}

test('suffix truncation retains proven summaries and invalidates removed sources and contaminated dependency chains', () => {
  const messages = [message('u0', 'user'), message('a0', 'assistant'), message('u1', 'user'), message('a1', 'assistant')];
  const safe = summary('safe', [messages[1]]);
  const removed = summary('removed', [messages[3]]);
  const dependent = summary('dependent', [messages[1]]);
  dependent.provenance!.summaryHashes = { removed: historySummaryHash(removed) };
  const legacy = { ...summary('legacy', [messages[1]]), provenance: undefined };
  const state = session(messages);
  state.contextCompression = { version: 1, summaries: [safe, removed, dependent, legacy], protectedMessageIds: ['u0', 'u1'],
    protectionState: { version: 1, pendingMessageIds: ['a0', 'a1'], settledMessageIds: ['u0', 'u1'],
      settledFacts: [{ messageId: 'a0', status: 'done' }, { messageId: 'a1', status: 'done' }] },
    lastFailureReason: 'old projection failed', lastCompression: { version: 1, fingerprint: hash('old'), beforeTokens: 100,
      afterTokens: 99, netReleasedTokens: 1, durationMs: 1, protectedCount: 1, compressibleCount: 1, costKnown: false } };
  const bytes = JSON.stringify(messages.slice(0, 2));
  const result = reconcileTruncatedContext(state, messages.slice(0, 2));
  assert.deepEqual(state.contextCompression?.summaries, [safe]);
  assert.equal(state.contextCompression?.summaries[0], safe, 'summary bytes are reused, not regenerated');
  assert.deepEqual(result.summaryInvalidations, [
    { id: 'removed', reason: 'source_removed_or_changed' },
    { id: 'dependent', reason: 'summary_dependency_invalid' },
    { id: 'legacy', reason: 'source_unverified' }
  ]);
  assert.deepEqual(state.contextCompression?.protectedMessageIds, ['u0']);
  assert.deepEqual(state.contextCompression?.protectionState, { version: 1, pendingMessageIds: ['a0'],
    settledMessageIds: ['u0'], settledFacts: [{ messageId: 'a0', status: 'done' }] });
  assert.equal(state.contextCompression?.lastCompression, undefined);
  assert.equal(state.contextCompression?.lastFailureReason, undefined);
  assert.equal(JSON.stringify(messages.slice(0, 2)), bytes);
});

test('summary source mutation, absent dependencies and dependency cycles fail closed', () => {
  const retained = message('a', 'assistant');
  for (const kind of ['changed', 'missing', 'cycle'] as const) {
    const item = summary('s', [retained]);
    if (kind === 'changed') item.provenance!.messageHashes.a = hash('different');
    if (kind === 'missing') item.provenance!.summaryHashes.absent = hash('missing');
    if (kind === 'cycle') item.provenance!.summaryHashes.s = historySummaryHash(item);
    const state = session([retained]);
    state.contextCompression = { version: 1, protectedMessageIds: [], summaries: [item] };
    reconcileTruncatedContext(state, [retained]);
    assert.deepEqual(state.contextCompression.summaries, [], kind);
  }
});

test('dynamic context hash follows retained host snapshots; removed suffix hashes cannot suppress a new tail', () => {
  const first = message('u0', 'user'); first.dynamicContextHash = hash('retained context');
  const removed = message('u1', 'user'); removed.dynamicContextHash = hash('removed context');
  const state = session([first, removed]);
  state.requestProtocol!.lastDynamicContextHash = removed.dynamicContextHash;
  assert.equal(reconcileTruncatedContext(state, [first]).dynamicContextRefreshRequired, false);
  assert.equal(state.requestProtocol!.lastDynamicContextHash, first.dynamicContextHash);
  assert.equal(reconcileTruncatedContext(state, []).dynamicContextRefreshRequired, false);
  assert.equal(state.requestProtocol!.lastDynamicContextHash, hash(state.contextInstructions!));
  const legacy = message('legacy', 'user'); legacy.providerContent = 'prompt\n<keepseek-dynamic-context>legacy context</keepseek-dynamic-context>';
  assert.equal(reconcileTruncatedContext(state, [legacy]).dynamicContextRefreshRequired, true);
  assert.equal(state.requestProtocol!.lastDynamicContextHash, hash(state.contextInstructions!));
  assert.equal(reconcileTruncatedContext(state, [legacy, first]).dynamicContextRefreshRequired, false);
});

test('new host-only cache proofs survive normalization; malformed proofs are ignored', () => {
  const m = message('a', 'assistant'); m.dynamicContextHash = hash('context');
  const state = session([m]);
  state.contextCompression = { version: 1, protectedMessageIds: [], summaries: [summary('s', [m])] };
  const scope = { key: 'workspace', name: 'workspace', folderUris: [] };
  const loaded = normalizeStoredSessions({ sessions: [state] }, scope)[0];
  assert.equal(loaded.messages[0].dynamicContextHash, m.dynamicContextHash);
  assert.deepEqual(loaded.contextCompression?.summaries[0].provenance, state.contextCompression.summaries[0].provenance);
  const bad = structuredClone(state);
  bad.messages[0].dynamicContextHash = 'bad';
  bad.contextCompression!.summaries[0].provenance!.messageHashes.a = 'bad';
  const normalized = normalizeStoredSessions({ sessions: [bad] }, scope)[0];
  assert.equal(normalized.messages[0].dynamicContextHash, undefined);
  assert.equal(normalized.contextCompression?.summaries[0].provenance, undefined);
});

test('a summarized dynamic-context tail cannot suppress context missing from the replacement projection', () => {
  const messages = [message('u0', 'user'), message('a0', 'assistant'), message('u1', 'user'), message('a1', 'assistant')];
  messages[2].providerContent = 'u1\n<keepseek-dynamic-context>new context</keepseek-dynamic-context>';
  messages[2].dynamicContextHash = hash('new context');
  const state = session(messages);
  state.requestProtocol!.lastDynamicContextHash = messages[2].dynamicContextHash;
  state.contextCompression = { version: 1, summaries: [summary('dynamic', [messages[2]])], protectedMessageIds: [] };
  const result = reconcileTruncatedContext(state, messages);
  assert.equal(result.dynamicContextRefreshRequired, false);
  assert.equal(state.requestProtocol!.lastDynamicContextHash, hash(state.contextInstructions!),
    'the old latest user will cease to be latest once the replacement is appended');
  state.contextCompression.protectedMessageIds = ['u1'];
  reconcileTruncatedContext(state, messages);
  assert.equal(state.requestProtocol!.lastDynamicContextHash, messages[2].dynamicContextHash,
    'a durable protected source still appears in actual projection');
});

for (const provider of ['deepseek', 'openai-responses', 'anthropic-compatible'] as const) {
  for (const unchanged of [false, true]) {
    test(`${provider}: edit resend preserves actual retained payload/replay prefix (${unchanged ? 'unchanged' : 'edited'} prompt)`, () => {
      for (const cut of [0, 2, 4]) {
        const messages = [message('u0', 'user'), message('a0', 'assistant'), message('u1', 'user'),
          message('a1', 'assistant'), message('u2', 'user'), message('a2', 'assistant')];
        messages[0].expandedContent = 'expanded first';
        messages[0].providerContent = 'expanded first\n<keepseek-operation-results>retained result</keepseek-operation-results>';
        for (const m of messages.filter(m => m.role === 'assistant')) {
          m.toolRounds = [{ assistantContent: null, reasoningContent: 'exact reasoning', toolCalls: [{ id: `c-${m.id}`, type: 'function',
            function: { name: 'keepseek_list_workspace_files', arguments: '{}' } }], toolResults: [{ toolCallId: `c-${m.id}`, content: 'exact tool result' }] }];
          if (provider === 'openai-responses') m.providerReplay = { protocol: 'openai-responses', sourceId: 'source', baseUrl: 'https://example.test/v1',
            items: [{ type: 'reasoning', id: `r-${m.id}`, encrypted_content: 'opaque' },
              { type: 'function_call', call_id: `c-${m.id}`, name: 'keepseek_list_workspace_files', arguments: '{}' },
              { type: 'function_call_output', call_id: `c-${m.id}`, output: 'exact tool result' },
              { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.content }] }] };
          if (provider === 'anthropic-compatible') m.providerReplay = { protocol: 'anthropic-messages', sourceId: 'source', baseUrl: 'https://example.test/v1',
            messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'exact thinking', signature: 'opaque signature' },
              { type: 'tool_use', id: `c-${m.id}`, name: 'keepseek_list_workspace_files', input: {} }] },
              { role: 'user', content: [{ type: 'tool_result', tool_use_id: `c-${m.id}`, content: 'exact tool result' }] },
              { role: 'assistant', content: [{ type: 'text', text: m.content }] }] };
        }
        const state = session(messages);
        const before = payload(state, 'later', provider);
        const retained = messages.slice(0, cut);
        const retainedBytes = JSON.stringify(retained);
        reconcileTruncatedContext(state, retained);
        state.messages = [...retained, { ...message('new-id', 'user', unchanged ? messages[cut].content : 'edited prompt'),
          userTask: { version: 1, id: 'new-task', originMessageId: 'new-id', reason: 'user' }, dynamicContextHash: hash('new host metadata') }];
        const after = payload(state, state.messages.at(-1)!.content, provider);
        assert.equal(JSON.stringify(retained), retainedBytes);
        assert.equal(JSON.stringify(before.tools), JSON.stringify(after.tools));
        const oldItems = bodyItems(before);
        const newItems = bodyItems(after);
        assert.equal(JSON.stringify(oldItems.slice(0, newItems.length - 1)), JSON.stringify(newItems.slice(0, -1)),
          'actual retained native items, including system, context and atomic replay, are identical');
        assert.equal(JSON.stringify(after).includes('new-task'), false);
        assert.equal(JSON.stringify(after).includes('new host metadata'), false);
        assert.equal(JSON.stringify(after).includes('dynamicContextHash'), false);
        if ('system' in before && 'system' in after) assert.equal(JSON.stringify(before.system), JSON.stringify(after.system));
      }
    });
  }
}

test('retained verified summary remains byte-identical in each native request; crossing summary is removed', () => {
  for (const provider of ['deepseek', 'openai-responses', 'anthropic-compatible'] as const) {
    const messages = [message('u0', 'user'), message('a0', 'assistant'), message('u1', 'user'), message('a1', 'assistant'), message('u2', 'user')];
    const state = session(messages);
    const safe = summary('safe', [messages[1]]);
    state.contextCompression = { version: 1, protectedMessageIds: [], summaries: [safe] };
    const before = payload(state, 'later', provider);
    reconcileTruncatedContext(state, messages.slice(0, 4));
    state.messages = [...messages.slice(0, 4), message('new', 'user', 'edited')];
    const after = payload(state, 'edited', provider);
    assert.equal(state.contextCompression.summaries[0], safe);
    assert.equal(JSON.stringify(bodyItems(before).slice(0, bodyItems(after).length - 1)), JSON.stringify(bodyItems(after).slice(0, -1)));
    if ('system' in before && 'system' in after) assert.equal(JSON.stringify(before.system), JSON.stringify(after.system));
    state.contextCompression.summaries.push(summary('crossing', [messages[3], messages[4]]));
    reconcileTruncatedContext(state, messages.slice(0, 4));
    assert.deepEqual(state.contextCompression.summaries, [safe]);
  }
});

test('edit boundary diagnostics preserve a proven stable prefix and retain actual upstream cache counts', () => {
  const context = 'stable project context '.repeat(300);
  const body = { model: 'deepseek-flash', messages: [{ role: 'system' as const, content: 'system' },
    { role: 'system' as const, content: context }, { role: 'user' as const, content: 'old user' }], stream: true as const };
  const base = { attemptIndex: 0, source: 'executor' as const, sourceId: 'source', provider: 'deepseek' as const,
    baseUrl: 'https://api.deepseek.com', contextInstructions: context, requestProtocolVersion: 14 };
  const previous = createProviderCacheObservation({ ...base, requestId: 'old', body });
  const observation = createProviderCacheObservation({ ...base, requestId: 'new', previous, historyRewriteReason: 'edit_user_prompt',
    body: { ...body, messages: [...body.messages.slice(0, 2), { role: 'user', content: 'edited' }] } });
  assert.equal(observation.reason, 'history_rewritten');
  assert.equal(observation.reasonCategory, 'controlled_boundary');
  assert.equal(observation.prefixRelation, 'broken', 'this describes full previous-prefix inheritance only');
  assert.ok(observation.reusablePrefixTokensEstimate > 0, 'unchanged system/context/tools are an exact independent proof');
  assert.equal(observation.eligibleForHealthTarget, false);
  const final = finalizeCacheObservationWithUsage(observation, { promptTokens: 3000, completionTokens: 10, totalTokens: 3010,
    cacheHitTokens: 2000, cacheMissTokens: 1000, cacheDataStatus: 'reported' });
  assert.equal(final.reason, 'history_rewritten');
  assert.ok((final.expectedRawHitRateCeiling ?? 0) > 0);
});

function payload(state: ChatSession, prompt: string, provider: 'deepseek' | 'openai-responses' | 'anthropic-compatible') {
  const p = buildProviderRequestProjection({ model: { id: 'test-model', label: 'model', provider, contextWindowTokens: 1_000_000 },
    agentSettings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [], contextInstructions: state.contextInstructions, history: state.messages, contextCompression: state.contextCompression,
    language: 'en', prompt, slimToolNames: state.requestProtocol?.toolNames, requestProtocolVersion: state.requestProtocol?.version,
    provider, sourceId: 'source', baseUrl: 'https://example.test/v1' });
  return buildProviderPayloadProjection({ modelId: 'test-model', maxOutputTokens: 4096, provider, messages: p.messages, tools: p.tools,
    native: p.responses ? { protocol: 'openai-responses', ...p.responses } : p.anthropic ? { protocol: 'anthropic-messages', ...p.anthropic } : undefined });
}
function bodyItems(body: ReturnType<typeof payload>): unknown[] {
  return 'input' in body ? body.input : body.messages;
}
