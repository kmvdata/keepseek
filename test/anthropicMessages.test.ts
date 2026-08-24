import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import {
  DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL,
  getDefaultModelSourceBaseUrl,
  getDefaultModelSourceName,
  ModelSourceStore,
  normalizeDiscoveredModels
} from '../src/accounts/accountStore';
import {
  createModelDiscoveryHeaders,
  discoverSourceModels,
  getSourceModelsEndpointUrl,
  parseSourceModelsResponse,
  probeSourceConnection
} from '../src/accounts/modelDiscovery';
import { createModelCatalog } from '../src/accounts/modelCatalog';
import { ModelSourceService } from '../src/accounts/modelSourceService';
import { isOfficialAnthropicSource } from '../src/accounts/sourceCapabilities';
import { MODEL_SOURCE_PROVIDERS } from '../src/accounts/types';
import {
  createContextUsageEstimate,
  createContextUsageEstimateFromAnthropic
} from '../src/agent/contextUsage';
import { HistoryCompressor } from '../src/agent/historyCompressor';
import {
  buildProviderRequestProjection,
  normalizeAnthropicMessagesLaneBaseUrl
} from '../src/agent/providerRequestProjection';
import { AnthropicMessagesClient, getAnthropicMessagesEndpointUrl } from '../src/agent/providers/anthropicMessagesClient';
import { AnthropicStreamParser } from '../src/agent/providers/anthropicStreamParser';
import type { AnthropicMessagesRequestBody } from '../src/agent/providers/anthropicTypes';
import { DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS } from '../src/agent/providers/anthropicTypes';
import { createProviderClient } from '../src/agent/providers/factory';
import { AgentRunner } from '../src/agent/runner';
import {
  getVisibleMessages,
  normalizeAnthropicMessagesReplay,
  normalizeProviderReplay,
  normalizeStoredSessions
} from '../src/sessions/chatSessionStore';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import type { AgentRequest, ChatMessage, KeepseekModel, ProviderReplayState } from '../src/shared/types';
import { getNewAccountDialogScript, getNewAccountDialogTemplate } from '../src/webview/input/newAccountDialog';
import { getInputScript } from '../src/webview/input/script';

const MODEL: KeepseekModel = {
  id: 'claude-test',
  label: 'Claude Test',
  provider: 'anthropic-compatible',
  sourceId: 'anthropic-source',
  contextWindowTokens: 200_000,
  maxOutputTokens: 16_000,
  anthropicCapabilities: {
    thinking: 'adaptive' as const,
    effort: ['high', 'max']
  }
};

const SETTINGS = {
  thinkingEnabled: true,
  reasoningEffort: 'high' as const,
  compressionThreshold: 'balanced' as const
};

describe('Anthropic Messages compatible protocol', () => {
  let storageRoot = '';

  beforeEach(async () => {
    storageRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-anthropic-'));
  });

  afterEach(async () => {
    await rm(storageRoot, { recursive: true, force: true });
  });

  it('registers the fifth provider, defaults, isolated storage directory, factory, and UI translations', async () => {
    assert.deepEqual(MODEL_SOURCE_PROVIDERS, [
      'deepseek', 'ollama', 'openai-compatible', 'openai-responses', 'anthropic-compatible'
    ]);
    assert.equal(getDefaultModelSourceName('anthropic-compatible'), 'Anthropic compatible');
    assert.equal(getDefaultModelSourceBaseUrl('anthropic-compatible'), DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL);
    assert.ok(createProviderClient('anthropic-compatible') instanceof AnthropicMessagesClient);

    const store = new ModelSourceStore(vscode.Uri.file(storageRoot), { createId: () => 'anthropic-account' });
    await store.createSource({
      provider: 'anthropic-compatible', name: 'Claude', apiKey: 'secret'
    });
    const storedPath = path.join(storageRoot, 'accounts', 'anthropic-compatible', 'anthropic-account.json');
    const stored = JSON.parse(await readFile(storedPath, 'utf8')) as { provider: string; baseUrl: string };
    assert.equal(stored.provider, 'anthropic-compatible');
    assert.equal(stored.baseUrl, DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL);

    const dialog = getNewAccountDialogTemplate() + getNewAccountDialogScript();
    const settings = getInputScript();
    assert.match(dialog, /value="anthropic-compatible"/u);
    assert.match(dialog, /https:\/\/api\.anthropic\.com\/v1/u);
    assert.match(settings, /'anthropic-compatible'/u);
    assert.match(settings, /\['deepseek', 'ollama', 'openai-compatible', 'openai-responses', 'anthropic-compatible'\]/u);
    assert.equal(WEBVIEW_TRANSLATIONS['zh-CN'].anthropicMessagesCompatible, 'Anthropic compatible');
    assert.equal(WEBVIEW_TRANSLATIONS.en.anthropicMessagesCompatible, 'Anthropic compatible');
  });

  it('derives Messages and models endpoints without losing proxy prefixes or query strings', () => {
    assert.equal(
      getAnthropicMessagesEndpointUrl('https://api.anthropic.com/v1'),
      'https://api.anthropic.com/v1/messages'
    );
    assert.equal(
      getAnthropicMessagesEndpointUrl('https://proxy.example/anthropic/v1/messages/?tenant=a#fragment'),
      'https://proxy.example/anthropic/v1/messages?tenant=a'
    );
    assert.equal(
      getSourceModelsEndpointUrl('https://api.anthropic.com/v1', 'anthropic-compatible'),
      'https://api.anthropic.com/v1/models'
    );
    assert.equal(
      getSourceModelsEndpointUrl('https://proxy.example/anthropic/v1/messages?tenant=a#fragment', 'anthropic-compatible'),
      'https://proxy.example/anthropic/v1/models?tenant=a'
    );
    assert.equal(
      getSourceModelsEndpointUrl('https://proxy.example/anthropic/v1/models?tenant=a', 'anthropic-compatible'),
      'https://proxy.example/anthropic/v1/models?tenant=a'
    );
  });

  it('uses Anthropic authentication/version headers for discovery and streaming without Bearer auth', async () => {
    const discoveryHeaders = createModelDiscoveryHeaders('anthropic-compatible', 'anthropic-key');
    assert.deepEqual(discoveryHeaders, {
      Accept: 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': 'anthropic-key'
    });
    assert.equal('Authorization' in discoveryHeaders, false);

    let capturedUrl = '';
    let capturedHeaders: RequestInit['headers'];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedHeaders = init?.headers;
      return anthropicTextResponse('ok');
    }) as typeof fetch;
    try {
      const result = await new AnthropicMessagesClient().createModelResponse(clientConfig(), {
        body: minimalAnthropicBody(), language: 'en'
      });
      assert.equal(result.ok, true);
      assert.equal(capturedUrl, 'https://proxy.example/anthropic/v1/messages?tenant=a');
      assert.deepEqual(capturedHeaders, {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        'x-api-key': 'key'
      });
      assert.equal('Authorization' in (capturedHeaders as Record<string, string>), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('discovers display names, token limits and compact thinking capabilities while rejecting damaged metadata', async () => {
    const parsed = parseSourceModelsResponse({
      data: [{
        id: 'claude-a',
        display_name: 'Claude A',
        max_input_tokens: 200_000,
        max_tokens: 32_000,
        capabilities: {
          thinking: { modes: ['adaptive', 'enabled'] },
          effort: { levels: ['high', 'max'] }
        }
      }, {
        id: 'damaged',
        max_input_tokens: 0,
        max_tokens: Number.POSITIVE_INFINITY,
        capabilities: { thinking: { surprise: true }, effort: { levels: [12] } }
      }]
    }, 'anthropic-compatible');
    assert.deepEqual(parsed, [{
      id: 'claude-a',
      name: 'Claude A',
      contextWindowTokens: 200_000,
      maxOutputTokens: 32_000,
      anthropicCapabilities: { thinking: 'adaptive', effort: ['high', 'max'] }
    }, { id: 'damaged' }]);

    assert.deepEqual(normalizeDiscoveredModels([{
      id: 'saved',
      contextWindowTokens: -1,
      maxOutputTokens: 50_000_000,
      anthropicCapabilities: { thinking: 'unknown', effort: ['max', 'invalid', 'high'] }
    }]), [{
      id: 'saved',
      anthropicCapabilities: { effort: ['high', 'max'] }
    }]);

    const catalog = createModelCatalog([{
      id: 'source', name: 'Claude', provider: 'anthropic-compatible', apiKey: 'key',
      baseUrl: DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL, models: [], enabled: true,
      createdAt: 1, updatedAt: 1,
      modelCache: { models: parsed ?? [], fetchedAt: 1 }
    }]);
    assert.equal(catalog[0].contextWindowTokens, 200_000);
    assert.equal(catalog[0].maxOutputTokens, 32_000);
    assert.deepEqual(catalog[0].anthropicCapabilities, { thinking: 'adaptive', effort: ['high', 'max'] });
    assert.equal(catalog[0].supportsBilling, false);

    let requestHeaders: RequestInit['headers'];
    const cache = await discoverSourceModels({
      provider: 'anthropic-compatible', apiKey: 'key', baseUrl: DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL
    }, {
      now: 10,
      timeoutMs: 0,
      fetchImpl: async (_url, init) => {
        requestHeaders = init.headers;
        return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'claude-b' }] }) };
      }
    });
    assert.deepEqual(cache, { models: [{ id: 'claude-b' }], fetchedAt: 10 });
    assert.equal((requestHeaders as Record<string, string>)['x-api-key'], 'key');
  });

  it('requires a key only for the official host and reuses only the same provider/key/normalized URL', async () => {
    assert.equal(isOfficialAnthropicSource({
      provider: 'anthropic-compatible', baseUrl: 'https://api.anthropic.com/v1'
    }), true);
    assert.equal(isOfficialAnthropicSource({
      provider: 'anthropic-compatible', baseUrl: 'https://api.anthropic.com.example/v1'
    }), false);
    assert.equal((await probeSourceConnection({
      provider: 'anthropic-compatible', apiKey: '', baseUrl: DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL
    })).ok, false);

    const store = new ModelSourceStore(vscode.Uri.file(storageRoot));
    let probes = 0;
    const service = new ModelSourceService(
      store,
      async () => ({ status: 'failed' }),
      async () => { probes += 1; return { ok: true, status: 200 }; }
    );
    await assert.rejects(service.addModel({
      provider: 'anthropic-compatible', name: 'Official', apiKey: '', baseUrl: DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL
    }), /require.*API Key/iu);
    const first = await service.addModel({
      provider: 'anthropic-compatible', name: 'Gateway', apiKey: '', baseUrl: 'http://localhost:8080/anthropic/v1/'
    });
    const reused = await service.addModel({
      provider: 'anthropic-compatible', name: 'Gateway Alias', apiKey: '', baseUrl: 'http://localhost:8080/anthropic/v1'
    });
    const otherProtocol = await service.addModel({
      provider: 'openai-compatible', name: 'OpenAI Gateway', apiKey: '', baseUrl: 'http://localhost:8080/anthropic/v1'
    });
    assert.equal(reused.reusedSource, true);
    assert.equal(reused.source.id, first.source.id);
    assert.notEqual(otherProtocol.source.id, first.source.id);
    assert.equal(probes, 2);

    const manual = await service.addModel({
      sourceId: first.source.id,
      provider: 'anthropic-compatible',
      apiKey: '',
      baseUrl: first.source.baseUrl,
      modelId: 'manual-claude'
    });
    assert.deepEqual(manual.source.models, [{ id: 'manual-claude' }]);
    const saved = await service.saveSource({
      sourceId: first.source.id,
      name: 'Renamed Gateway',
      apiKey: '',
      baseUrl: first.source.baseUrl
    });
    assert.equal(saved.source.name, 'Renamed Gateway');
    assert.equal(saved.source.provider, 'anthropic-compatible');
    await assert.rejects(service.addModel({
      sourceId: first.source.id,
      provider: 'openai-compatible',
      apiKey: '',
      baseUrl: first.source.baseUrl,
      modelId: 'wrong-protocol'
    }), /protocol cannot be changed/iu);
    assert.equal((await store.deleteSource(first.source.id))?.provider, 'anthropic-compatible');
  });

  it('builds one stable authoritative projection with top-level system, exact providerContent, tools, and lane isolation', () => {
    const history: ChatMessage[] = [{
      id: 'u1', role: 'user', content: 'visible', expandedContent: 'expanded',
      providerContent: 'expanded\n\n<keepseek-dynamic-context>tail</keepseek-dynamic-context>',
      createdAt: '2026-01-01T00:00:00.000Z'
    }];
    const first = buildProjection(history);
    const second = buildProjection(history);
    assert.deepEqual(first.anthropic, second.anthropic);
    assert.ok((first.anthropic?.system.length ?? 0) > 0);
    assert.equal(first.anthropic?.messages.some((message) => message.role !== 'user' && message.role !== 'assistant'), false);
    assert.equal(first.anthropic?.messages.at(-1)?.content[0].type, 'text');
    assert.equal(readText(first.anthropic?.messages.at(-1)?.content[0]), history[0].providerContent);
    assert.deepEqual(first.anthropic?.tools.map((tool) => tool.name), first.tools.map((tool) => tool.function.name));
    assert.equal(first.anthropic?.tools[0].input_schema, first.tools[0].function.parameters);

    const nativeReplay = {
      protocol: 'anthropic-messages' as const,
      sourceId: 'anthropic-source',
      baseUrl: normalizeAnthropicMessagesLaneBaseUrl('https://proxy.example/anthropic/v1'),
      messages: [{
        role: 'assistant' as const,
        content: [
          { type: 'thinking' as const, thinking: 'private reasoning', signature: 'opaque-signature' },
          { type: 'redacted_thinking' as const, data: 'opaque-redaction' },
          { type: 'text' as const, text: 'visible assistant' }
        ]
      }]
    };
    const assistant: ChatMessage = {
      id: 'a1', role: 'assistant', content: 'visible assistant',
      createdAt: '2026-01-01T00:00:01.000Z', providerReplay: nativeReplay
    };
    const sameLane = buildProjection([...history, assistant]);
    assert.equal(JSON.stringify(sameLane.anthropic?.messages).includes('opaque-signature'), true);
    const otherLane = buildProviderRequestProjection({
      ...projectionInput([...history, assistant]), sourceId: 'other-source'
    });
    assert.equal(JSON.stringify(otherLane.anthropic?.messages).includes('opaque-signature'), false);
    assert.equal(JSON.stringify(otherLane.anthropic?.messages).includes('visible assistant'), true);

    const compressed = buildProviderRequestProjection({
      ...projectionInput([...history, assistant]),
      contextCompression: {
        version: 1,
        protectedMessageIds: [],
        summaries: [{
          id: 'summary', content: 'Earlier work.', coveredMessageIds: ['a1'],
          createdAt: '2026-01-01T00:00:02.000Z', updatedAt: '2026-01-01T00:00:02.000Z',
          tokenEstimate: 4, version: 1
        }]
      }
    });
    assert.equal(JSON.stringify(compressed.anthropic?.messages).includes('opaque-signature'), false);
  });

  it('parses arbitrary character chunks, CRLF, multiline data, pings, unknown events, thinking, signatures, redaction, tools and cache usage', async () => {
    const contentDeltas: string[] = [];
    const reasoningDeltas: string[] = [];
    const stream = [
      sse('message_start', { type: 'message_start', message: { usage: {
        input_tokens: 10, cache_creation_input_tokens: 4, cache_read_input_tokens: 6
      } } }, '\r\n'),
      sse('ping', { type: 'ping' }, '\r\n'),
      sse('future_event', { type: 'future_event', payload: true }, '\r\n'),
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }, '\r\n'),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'reason' } }, '\r\n'),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-sig' } }, '\r\n'),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }, '\r\n'),
      sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-data' } }, '\r\n'),
      sse('content_block_stop', { type: 'content_block_stop', index: 1 }, '\r\n'),
      sse('content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } }, '\r\n'),
      'event: content_block_delta\r\ndata: {"type":"content_block_delta","index":2,\r\ndata: "delta":{"type":"text_delta","text":"hello"}}\r\n\r\n',
      sse('content_block_stop', { type: 'content_block_stop', index: 2 }, '\r\n'),
      ...toolUseEvents(3, 'call-1', 'one', ['{"a"', ':1}'], '\r\n'),
      ...toolUseEvents(4, 'call-2', 'two', ['{"b":2}'], '\r\n'),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }, '\r\n'),
      sse('message_stop', { type: 'message_stop' }, '\r\n')
    ].join('');
    const result = await new AnthropicStreamParser().parse(
      streamFromCharacters(stream),
      'en',
      { onDelta: (event) => (event.type === 'reasoning' ? reasoningDeltas : contentDeltas).push(event.delta) }
    );
    assert.equal(contentDeltas.join(''), 'hello');
    assert.equal(reasoningDeltas.join(''), 'reason');
    assert.deepEqual(result.contentBlocks.slice(0, 3), [
      { type: 'thinking', thinking: 'reason', signature: 'opaque-sig' },
      { type: 'redacted_thinking', data: 'opaque-data' },
      { type: 'text', text: 'hello' }
    ]);
    assert.deepEqual(result.message.tool_calls?.map((call) => [call.id, call.function.name, call.function.arguments]), [
      ['call-1', 'one', '{"a":1}'], ['call-2', 'two', '{"b":2}']
    ]);
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.usage, {
      prompt_tokens: 20,
      completion_tokens: 7,
      total_tokens: 27,
      prompt_cache_hit_tokens: 6,
      prompt_cache_miss_tokens: 14,
      prompt_tokens_details: { cached_tokens: 6 }
    });
  });

  it('fails closed for stream errors, empty streams, malformed JSON, missing completion and unfinished tool input', async () => {
    await assert.rejects(parseAnthropicEvents([{ type: 'error', error: { message: 'overloaded' } }]), /overloaded/u);
    await assert.rejects(new AnthropicStreamParser().parse(emptyStream(), 'en', {}), /did not return any streaming events/u);
    await assert.rejects(new AnthropicStreamParser().parse(streamFromText('data: {bad}\n\n'), 'en', {}), /Cannot parse/u);
    await assert.rejects(parseAnthropicEvents([
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_stop', index: 0 }
    ]), /before the message completed/u);
    await assert.rejects(parseAnthropicEvents([
      { type: 'message_start', message: {} },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'tool', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"bad"' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
      { type: 'message_stop' }
    ]), /incomplete or invalid JSON/u);
    await assert.rejects(parseAnthropicEvents([
      { type: 'message_start', message: {} },
      { type: 'message_delta', delta: { stop_reason: 'model_context_window_exceeded' } },
      { type: 'message_stop' }
    ]), /context window was exceeded/u);
  });

  it('keeps shared abort, deadline, idle timeout and empty-stream retry behavior', async () => {
    const client = new AnthropicMessagesClient();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = abortingFetch();
      const externalAbort = new AbortController();
      externalAbort.abort();
      const aborted = await client.createModelResponse(clientConfig(), {
        body: minimalAnthropicBody(), language: 'en', signal: externalAbort.signal
      });
      assert.equal(aborted.failureKind, 'external_abort');

      globalThis.fetch = abortingFetch();
      const deadline = await client.createModelResponse(clientConfig(), {
        body: minimalAnthropicBody(), language: 'en', runDeadlineAt: Date.now() - 1
      });
      assert.equal(deadline.failureKind, 'run_time_limit');

      globalThis.fetch = abortingFetch();
      const idle = await client.createModelResponse({ ...clientConfig(), streamIdleTimeoutMs: 5 }, {
        body: minimalAnthropicBody(), language: 'en'
      });
      assert.equal(idle.failureKind, 'stream_idle_timeout');

      let attempts = 0;
      globalThis.fetch = (async () => {
        attempts += 1;
        return attempts === 1 ? new Response(emptyStream(), { status: 200 }) : anthropicTextResponse('retried');
      }) as typeof fetch;
      const retried = await client.createModelResponse({ ...clientConfig(), maxRequestRetries: 1 }, {
        body: minimalAnthropicBody(), language: 'en'
      });
      assert.equal(retried.ok, true);
      assert.equal(retried.retryCount, 1);
      assert.equal(retried.message?.content, 'retried');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs parallel native tool_use blocks through multiple Messages requests and preserves exact thinking replay order', async () => {
    const bodies: AnthropicMessagesRequestBody[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as AnthropicMessagesRequestBody);
      return bodies.length === 1 ? anthropicToolResponse() : anthropicTextResponse('done');
    }) as typeof fetch;
    try {
      const response = await new AgentRunner().run(createAgentRequest({ maxToolIterations: 2 }));
      assert.equal(response.message, 'done');
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0].max_tokens, 16_000);
      assert.deepEqual(bodies[0].thinking, { type: 'adaptive', display: 'summarized' });
      assert.equal('output_config' in bodies[0], false);
      assert.deepEqual(bodies[0].cache_control, { type: 'ephemeral' });
      assert.equal('stream_options' in bodies[0], false);
      assert.equal('reasoning_effort' in bodies[0], false);
      assert.equal('input' in bodies[0], false);
      assert.equal(JSON.stringify(bodies[0].tools), JSON.stringify(bodies[1].tools));

      const secondMessages = bodies[1].messages;
      const assistantIndex = secondMessages.findIndex((message) => message.role === 'assistant'
        && message.content.some((block) => block.type === 'tool_use'));
      assert.ok(assistantIndex >= 0);
      const assistant = secondMessages[assistantIndex];
      const resultMessage = secondMessages[assistantIndex + 1];
      assert.equal(assistant.role, 'assistant');
      assert.deepEqual(assistant.content.slice(0, 2), [
        { type: 'thinking', thinking: 'think exactly', signature: 'opaque-signature' },
        { type: 'redacted_thinking', data: 'opaque-redacted' }
      ]);
      assert.equal(resultMessage.role, 'user');
      assert.deepEqual(resultMessage.content.map((block) => block.type), ['tool_result', 'tool_result']);
      assert.deepEqual(resultMessage.content.map((block) => block.type === 'tool_result' ? block.tool_use_id : ''), ['call-1', 'call-2']);

      const replay = getAnthropicReplay(response.providerReplay);
      assert.deepEqual(replay.messages.map((message) => message.role), ['assistant', 'user', 'assistant']);
      assert.equal(JSON.stringify(replay.messages).includes('opaque-signature'), true);
      assert.equal(JSON.stringify(replay.messages).includes('opaque-redacted'), true);
      assert.equal(response.toolRounds?.[0]?.toolResults.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('freezes tools while switching tool_choice to none when the tool budget is exhausted', async () => {
    const bodies: AnthropicMessagesRequestBody[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as AnthropicMessagesRequestBody);
      return bodies.length === 1 ? anthropicToolResponse(false) : anthropicTextResponse('stopped');
    }) as typeof fetch;
    try {
      await new AgentRunner().run(createAgentRequest({ maxToolIterations: 1 }));
      assert.equal(bodies.length, 2);
      assert.deepEqual(bodies[0].tool_choice, { type: 'auto' });
      assert.deepEqual(bodies[1].tool_choice, { type: 'none' });
      assert.equal(JSON.stringify(bodies[0].tools), JSON.stringify(bodies[1].tools));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('continues length, pause_turn and partial failures with only safe native state', async () => {
    await exerciseContinuation('max_tokens', 'hel', (bodies) => {
      const second = bodies[1].messages;
      const assistantIndex = second.findIndex((message) => message.role === 'assistant');
      assert.ok(assistantIndex >= 0 && second[assistantIndex + 1]?.role === 'user');
    });
    await exerciseContinuation('pause_turn', 'paused ', (bodies) => {
      const second = bodies[1].messages;
      assert.equal(second.at(-1)?.role, 'assistant');
      assert.equal(second.some((message) => message.role === 'user'
        && message.content.some((block) => block.type === 'text' && block.text.startsWith('Continue the previous answer'))), false);
    });

    const bodies: AnthropicMessagesRequestBody[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as AnthropicMessagesRequestBody);
      if (bodies.length === 1) {
        const broken = [
          sse('message_start', { type: 'message_start', message: {} }),
          sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
          sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } }),
          'data: {broken}\n\n'
        ].join('');
        return new Response(streamFromText(broken), { status: 200 });
      }
      return anthropicTextResponse('lo');
    }) as typeof fetch;
    try {
      const response = await new AgentRunner().run(createAgentRequest());
      assert.equal(response.message, 'hello');
      assert.equal(bodies.length, 2);
      const second = bodies[1].messages;
      assert.equal(JSON.stringify(second).includes('opaque-signature'), false);
      assert.equal(second.some((message) => message.role === 'assistant'
        && message.content.some((block) => block.type === 'text' && block.text === 'hel')), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses capability-driven thinking, conservative manual output limits, and official-only prompt caching', async () => {
    const captures: AnthropicMessagesRequestBody[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      captures.push(JSON.parse(String(init?.body)) as AnthropicMessagesRequestBody);
      return anthropicTextResponse('ok');
    }) as typeof fetch;
    try {
      const adaptiveMax = createAgentRequest();
      adaptiveMax.settings = { ...adaptiveMax.settings, reasoningEffort: 'max' };
      await new AgentRunner().run(adaptiveMax);

      const enabled = createAgentRequest();
      enabled.model = {
        ...enabled.model,
        maxOutputTokens: 1_500,
        anthropicCapabilities: { thinking: 'enabled' }
      };
      await new AgentRunner().run(enabled);

      const unknownCustom = createAgentRequest();
      unknownCustom.model = {
        ...unknownCustom.model,
        maxOutputTokens: undefined,
        anthropicCapabilities: undefined
      };
      unknownCustom.sourceConfig = {
        ...unknownCustom.sourceConfig!,
        baseUrl: 'https://gateway.example/anthropic/v1'
      };
      await new AgentRunner().run(unknownCustom);

      assert.deepEqual(captures[0].thinking, { type: 'adaptive', display: 'summarized' });
      assert.deepEqual(captures[0].output_config, { effort: 'max' });
      assert.deepEqual(captures[0].cache_control, { type: 'ephemeral' });
      assert.deepEqual(captures[1].thinking, { type: 'enabled', budget_tokens: 1_499 });
      assert.equal(captures[1].max_tokens, 1_500);
      assert.equal('thinking' in captures[2], false);
      assert.equal('output_config' in captures[2], false);
      assert.equal('cache_control' in captures[2], false);
      assert.equal(captures[2].max_tokens, DEFAULT_ANTHROPIC_MAX_OUTPUT_TOKENS);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the selected Anthropic lane for summaries without tools or thinking', async () => {
    let capturedUrl = '';
    let capturedBody: AnthropicMessagesRequestBody | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as AnthropicMessagesRequestBody;
      return anthropicTextResponse('summary');
    }) as typeof fetch;
    try {
      const compressor = new HistoryCompressor() as unknown as {
        completeSummary(input: {
          model: typeof MODEL;
          messages: Array<{ role: 'system' | 'user'; content: string }>;
          maxTokens: number;
          timeoutMs: number;
          language: 'en';
          usageSource: 'summary';
          sourceConfig: AgentRequest['sourceConfig'];
        }): Promise<{ content: string }>;
      };
      const result = await compressor.completeSummary({
        model: MODEL,
        messages: [{ role: 'system', content: 'summarize' }, { role: 'user', content: 'history' }],
        maxTokens: 321,
        timeoutMs: 1_000,
        language: 'en',
        usageSource: 'summary',
        sourceConfig: createAgentRequest().sourceConfig
      });
      assert.equal(result.content, 'summary');
      assert.equal(capturedUrl, 'https://api.anthropic.com/v1/messages');
      assert.equal(capturedBody?.temperature, 0);
      assert.equal(capturedBody?.max_tokens, 321);
      assert.equal(capturedBody?.system[0].text, 'summarize');
      assert.equal(readText(capturedBody?.messages[0].content[0]), 'history');
      assert.equal('tools' in (capturedBody ?? {}), false);
      assert.equal('thinking' in (capturedBody ?? {}), false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the exact Anthropic projection for context usage and calibratable cache-inclusive prompt usage', () => {
    const history: ChatMessage[] = [{
      id: 'u', role: 'user', content: 'visible', expandedContent: 'expanded bytes',
      createdAt: '2026-01-01T00:00:00.000Z'
    }];
    const projection = buildProjection(history);
    assert.ok(projection.anthropic);
    const actual = createContextUsageEstimate({
      model: MODEL,
      agentSettings: SETTINGS,
      contextFiles: [],
      messages: history,
      language: 'en',
      prompt: 'visible',
      includeTools: true,
      outputReserveTokens: 0,
      requestProtocolVersion: 2,
      provider: 'anthropic-compatible',
      sourceId: 'anthropic-source',
      baseUrl: 'https://proxy.example/anthropic/v1'
    });
    const expected = createContextUsageEstimateFromAnthropic({
      model: MODEL,
      system: projection.anthropic.system,
      messages: projection.anthropic.messages,
      tools: projection.anthropic.tools
    });
    assert.equal(actual.usedTokensEstimate, expected.usedTokensEstimate);
    assert.equal(actual.breakdown.toolSchemaTokensEstimate, expected.breakdown.toolSchemaTokensEstimate);
  });

  it('normalizes replay atomically, enforces role/block/size limits, survives damaged sessions, and stays hidden from Webview state', () => {
    const valid = normalizeAnthropicMessagesReplay({
      protocol: 'anthropic-messages',
      sourceId: 'source',
      baseUrl: 'https://api.anthropic.com/v1/messages',
      messages: [{ role: 'assistant', content: [
        { type: 'thinking', thinking: 'reason', signature: 'signature' },
        { type: 'redacted_thinking', data: 'redacted' },
        { type: 'tool_use', id: 'call', name: 'read', input: { path: 'a' } }
      ] }, { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'call', content: 'ok' }
      ] }]
    });
    assert.equal(valid?.messages.length, 2);
    assert.deepEqual(normalizeProviderReplay(valid), valid);
    assert.equal(normalizeAnthropicMessagesReplay({
      ...valid,
      messages: [{ role: 'assistant', content: [{ type: 'tool_result', tool_use_id: 'call', content: 'bad role' }] }]
    }), undefined);
    assert.equal(normalizeAnthropicMessagesReplay({
      ...valid,
      messages: [{ role: 'assistant', content: [{ type: 'future_block', data: 'unknown' }] }]
    }), undefined);
    assert.equal(normalizeAnthropicMessagesReplay({
      ...valid,
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'x', signature: '' }] }]
    }), undefined);
    assert.equal(normalizeAnthropicMessagesReplay({
      ...valid,
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2_100_000) }] }]
    }), undefined);

    const sessions = normalizeStoredSessions({
      sessions: [{
        id: 'session', title: 'Anthropic',
        messages: [
          { id: 'a1', role: 'assistant', content: 'visible', createdAt: '2026-01-01T00:00:00.000Z', providerReplay: valid },
          { id: 'a2', role: 'assistant', content: 'still visible', createdAt: '2026-01-01T00:00:01.000Z', providerReplay: { protocol: 'anthropic-messages', messages: 'bad' } }
        ],
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
        workspaceKey: 'test', workspaceName: 'Test', workspaceFolders: [], isFavorite: false
      }]
    }, { key: 'test', name: 'Test', folderUris: [] });
    assert.deepEqual(sessions[0].messages[0].providerReplay, valid);
    assert.equal(sessions[0].messages[1].providerReplay, undefined);
    assert.equal(getVisibleMessages(sessions[0].messages)[0].providerReplay, undefined);

    const reloadedProjection = buildProviderRequestProjection({
      model: { ...MODEL, sourceId: 'source' },
      agentSettings: SETTINGS,
      contextFiles: [],
      history: [...sessions[0].messages, {
        id: 'u-next', role: 'user', content: 'continue', createdAt: '2026-01-01T00:00:02.000Z'
      }],
      language: 'en',
      prompt: 'continue',
      provider: 'anthropic-compatible',
      sourceId: 'source',
      baseUrl: 'https://api.anthropic.com/v1'
    });
    assert.equal(JSON.stringify(reloadedProjection.anthropic?.messages).includes('signature'), true);
  });
});

function projectionInput(history: ChatMessage[]) {
  return {
    model: MODEL,
    agentSettings: SETTINGS,
    contextFiles: [],
    history,
    language: 'en' as const,
    prompt: [...history].reverse().find((message) => message.role === 'user')?.content ?? 'visible',
    requestProtocolVersion: 2,
    provider: 'anthropic-compatible' as const,
    sourceId: 'anthropic-source',
    baseUrl: 'https://proxy.example/anthropic/v1',
    includeTools: true
  };
}

function buildProjection(history: ChatMessage[]) {
  return buildProviderRequestProjection(projectionInput(history));
}

function createAgentRequest(limits?: { maxToolIterations: number }): AgentRequest {
  const user: ChatMessage = {
    id: 'user-1', role: 'user', content: 'list files twice', createdAt: '2026-01-01T00:00:00.000Z'
  };
  return {
    prompt: user.content,
    model: MODEL,
    settings: SETTINGS,
    contextFiles: [],
    history: [user],
    language: 'en',
    sourceConfig: {
      sourceId: 'anthropic-source', provider: 'anthropic-compatible', apiKey: 'secret',
      baseUrl: DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL, supportsBilling: false
    },
    executionLimits: limits
  };
}

function minimalAnthropicBody(): AnthropicMessagesRequestBody {
  return {
    model: 'claude-test',
    system: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    stream: true,
    max_tokens: 100
  };
}

function clientConfig() {
  return {
    apiKey: 'key',
    baseUrl: 'https://proxy.example/anthropic/v1?tenant=a',
    streamIdleTimeoutMs: 0,
    maxRequestRetries: 0,
    requestRetryBaseMs: 0
  };
}

function sse(event: string, data: Record<string, unknown>, newline = '\n'): string {
  return `event: ${event}${newline}data: ${JSON.stringify(data)}${newline}${newline}`;
}

function toolUseEvents(
  index: number,
  id: string,
  name: string,
  partials: string[],
  newline = '\n'
): string[] {
  return [
    sse('content_block_start', {
      type: 'content_block_start', index, content_block: { type: 'tool_use', id, name, input: {} }
    }, newline),
    ...partials.map((partialJson) => sse('content_block_delta', {
      type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: partialJson }
    }, newline)),
    sse('content_block_stop', { type: 'content_block_stop', index }, newline)
  ];
}

function anthropicTextResponse(
  text: string,
  stopReason: 'end_turn' | 'max_tokens' | 'pause_turn' = 'end_turn'
): Response {
  const stream = [
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 3 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 1 } }),
    sse('message_stop', { type: 'message_stop' })
  ].join('');
  return new Response(streamFromText(stream), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function anthropicToolResponse(includeRedacted = true): Response {
  const events = [
    sse('message_start', { type: 'message_start', message: { usage: { input_tokens: 10 } } }),
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'think exactly' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 })
  ];
  if (includeRedacted) {
    events.push(
      sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: 'opaque-redacted' } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 1 })
    );
  }
  events.push(
    ...toolUseEvents(2, 'call-1', 'keepseek_list_workspace_files', ['{}']),
    ...toolUseEvents(3, 'call-2', 'keepseek_list_workspace_files', ['{}']),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } }),
    sse('message_stop', { type: 'message_stop' })
  );
  return new Response(streamFromText(events.join('')), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function parseAnthropicEvents(events: Array<Record<string, unknown>>) {
  return await new AnthropicStreamParser().parse(
    streamFromText(events.map((event) => sse(String(event.type ?? ''), event)).join('')),
    'en',
    {}
  );
}

function readText(block: unknown): string | undefined {
  return typeof block === 'object' && block !== null && 'type' in block && block.type === 'text'
    && 'text' in block && typeof block.text === 'string'
    ? block.text
    : undefined;
}

function getAnthropicReplay(replay: ProviderReplayState | undefined) {
  if (replay?.protocol !== 'anthropic-messages') {
    assert.fail('Expected an Anthropic Messages replay.');
  }
  return replay;
}

function streamFromCharacters(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const character of Array.from(text)) controller.enqueue(encoder.encode(character));
      controller.close();
    }
  });
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
}

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.close(); } });
}

function abortingFetch(): typeof fetch {
  return (async (_input, init) => await new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const rejectAbort = () => reject(new DOMException('Aborted', 'AbortError'));
    if (signal?.aborted) {
      rejectAbort();
      return;
    }
    signal?.addEventListener('abort', rejectAbort, { once: true });
  })) as typeof fetch;
}

async function exerciseContinuation(
  stopReason: 'max_tokens' | 'pause_turn',
  firstText: string,
  assertBodies: (bodies: AnthropicMessagesRequestBody[]) => void
): Promise<void> {
  const bodies: AnthropicMessagesRequestBody[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input, init) => {
    bodies.push(JSON.parse(String(init?.body)) as AnthropicMessagesRequestBody);
    return bodies.length === 1
      ? anthropicTextResponse(firstText, stopReason)
      : anthropicTextResponse(stopReason === 'max_tokens' ? 'lo' : 'done');
  }) as typeof fetch;
  try {
    const response = await new AgentRunner().run(createAgentRequest());
    assert.equal(response.message, stopReason === 'max_tokens' ? 'hello' : 'paused done');
    assert.equal(bodies.length, 2);
    assertBodies(bodies);
  } finally {
    globalThis.fetch = originalFetch;
  }
}
