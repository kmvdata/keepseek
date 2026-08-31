import './registerVscodeStub';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MODEL_SOURCE_PROVIDERS } from '../src/accounts/types';
import {
  getDefaultModelSourceBaseUrl,
  getDefaultModelSourceName
} from '../src/accounts/accountStore';
import { AgentRunner } from '../src/agent/runner';
import { HistoryCompressor } from '../src/agent/historyCompressor';
import {
  createContextUsageEstimate,
  createContextUsageEstimateFromResponses
} from '../src/agent/contextUsage';
import {
  buildProviderRequestProjection,
  normalizeOpenAiResponsesLaneBaseUrl,
  toOpenAiResponsesTools
} from '../src/agent/providerRequestProjection';
import { createProviderClient } from '../src/agent/providers/factory';
import {
  getOpenAiResponsesEndpointUrl,
  OpenAiResponsesClient
} from '../src/agent/providers/openAiResponsesClient';
import { ResponsesStreamParser } from '../src/agent/providers/responsesStreamParser';
import type {
  OpenAiResponsesItem,
  OpenAiResponsesRequestBody
} from '../src/agent/providers/responsesTypes';
import {
  getVisibleMessages,
  normalizeOpenAiResponsesReplay,
  normalizeStoredSessions
} from '../src/sessions/chatSessionStore';
import type { AgentRequest, ChatMessage } from '../src/shared/types';

const MODEL = {
  id: 'responses-model',
  label: 'Responses Model',
  provider: 'openai-responses',
  sourceId: 'responses-source',
  contextWindowTokens: 128_000
};

const SETTINGS = {
  thinkingEnabled: true,
  reasoningEffort: 'high' as const,
  compressionThreshold: 'balanced' as const
};

describe('OpenAI Responses account protocol', () => {
  it('keeps Responses protocol defaults and factory dispatch in the expanded provider registry', () => {
    assert.deepEqual(MODEL_SOURCE_PROVIDERS, [
      'deepseek', 'kimi', 'glm', 'qwencloud', 'ollama', 'openai-compatible', 'openai-responses', 'anthropic-compatible'
    ]);
    assert.equal(getDefaultModelSourceName('openai-responses'), 'OpenAI Responses compatible');
    assert.equal(getDefaultModelSourceBaseUrl('openai-responses'), 'https://api.openai.com/v1');
    assert.ok(createProviderClient('openai-responses') instanceof OpenAiResponsesClient);
  });

  it('derives Responses endpoints without losing proxy prefixes or query strings', () => {
    assert.equal(
      getOpenAiResponsesEndpointUrl('https://api.openai.com/v1'),
      'https://api.openai.com/v1/responses'
    );
    assert.equal(
      getOpenAiResponsesEndpointUrl('https://proxy.example/tenant/v1/responses/?api-version=1#fragment'),
      'https://proxy.example/tenant/v1/responses?api-version=1'
    );
    assert.equal(
      getOpenAiResponsesEndpointUrl('https://proxy.example/tenant/v1/chat/completions?route=a'),
      'https://proxy.example/tenant/v1/responses?route=a'
    );
  });

  it('builds a stable native Item projection and flattens function tools', () => {
    const history: ChatMessage[] = [{
      id: 'u1',
      role: 'user',
      content: 'visible',
      expandedContent: 'expanded',
      providerContent: 'expanded\n\n<keepseek-dynamic-context>tail</keepseek-dynamic-context>',
      createdAt: '2026-01-01T00:00:00.000Z'
    }];
    const first = buildProjection(history);
    const second = buildProjection(history);
    assert.deepEqual(first.responses?.input, second.responses?.input);
    assert.equal(first.responses?.input.at(-1)?.content, history[0].providerContent);
    assert.equal(first.responses?.input.some((item) => item.content === history[0].content), false);
    assert.equal(first.responses?.tools.length, first.tools.length);
    assert.equal(first.responses?.tools[0]?.strict, true);
    assert.equal('function' in (first.responses?.tools[0] ?? {}), false);
    assert.equal(toOpenAiResponsesTools([{
      type: 'function',
      function: {
        name: 'legacy_tool',
        description: 'Legacy schema',
        parameters: { type: 'object', properties: {} }
      }
    }])[0].strict, false);

    const replayItem: OpenAiResponsesItem = {
      type: 'reasoning',
      id: 'rs_1',
      encrypted_content: 'opaque'
    };
    const replayMessage: OpenAiResponsesItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'visible assistant' }]
    };
    const assistant: ChatMessage = {
      id: 'a1',
      role: 'assistant',
      content: 'visible assistant',
      createdAt: '2026-01-01T00:00:01.000Z',
      providerReplay: {
        protocol: 'openai-responses',
        sourceId: 'responses-source',
        baseUrl: normalizeOpenAiResponsesLaneBaseUrl('https://proxy.example/v1'),
        items: [replayItem, replayMessage]
      }
    };
    const sameLane = buildProjection([...history, assistant]);
    assert.ok(sameLane.responses?.input.includes(replayItem));
    assert.equal(sameLane.responses?.input.some((item) => item.content === 'visible assistant'), false);
    const nextUser: ChatMessage = {
      id: 'u2',
      role: 'user',
      content: 'next',
      createdAt: '2026-01-01T00:00:02.000Z'
    };
    const nextTurn = buildProviderRequestProjection({
      ...projectionInput([...history, assistant, nextUser]),
      prompt: 'next'
    });
    assert.deepEqual(
      nextTurn.responses?.input.slice(0, sameLane.responses?.input.length),
      sameLane.responses?.input
    );

    const otherLane = buildProviderRequestProjection({
      ...projectionInput([...history, assistant]),
      sourceId: 'other-source'
    });
    assert.equal(otherLane.responses?.input.includes(replayItem), false);
    assert.equal(otherLane.responses?.input.some((item) => item.content === 'visible assistant'), true);

    const compressed = buildProviderRequestProjection({
      ...projectionInput([...history, assistant]),
      contextCompression: {
        version: 1,
        protectedMessageIds: [],
        summaries: [{
          id: 'summary',
          content: 'Earlier assistant work summarized.',
          coveredMessageIds: ['a1'],
          createdAt: '2026-01-01T00:00:02.000Z',
          updatedAt: '2026-01-01T00:00:02.000Z',
          tokenEstimate: 10,
          version: 1
        }]
      }
    });
    assert.equal(compressed.responses?.input.includes(replayItem), false);
  });

  it('uses the exact native projection for Responses context accounting', () => {
    const history: ChatMessage[] = [{
      id: 'u1',
      role: 'user',
      content: 'visible',
      expandedContent: 'expanded bytes',
      createdAt: '2026-01-01T00:00:00.000Z'
    }];
    const projection = buildProjection(history);
    assert.ok(projection.responses);
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
      provider: 'openai-responses',
      sourceId: 'responses-source',
      baseUrl: 'https://proxy.example/v1'
    });
    const expected = createContextUsageEstimateFromResponses({
      model: MODEL,
      input: projection.responses.input,
      tools: projection.responses.tools
    });
    assert.equal(actual.usedTokensEstimate, expected.usedTokensEstimate);
    assert.equal(actual.breakdown.toolSchemaTokensEstimate, expected.breakdown.toolSchemaTokensEstimate);
  });

  it('parses arbitrary chunk boundaries, reasoning summaries, refusal, usage, and incomplete length', async () => {
    const reasoning: string[] = [];
    const content: string[] = [];
    const completed = {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [{
          type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'refusal', refusal: 'Cannot comply.' }]
        }],
        usage: {
          input_tokens: 20,
          output_tokens: 6,
          total_tokens: 26,
          input_tokens_details: { cached_tokens: 8 },
          output_tokens_details: { reasoning_tokens: 4 }
        }
      }
    };
    const streamText = [
      `data: ${JSON.stringify({ type: 'response.reasoning_summary_text.delta', delta: 'summary' })}\r\n\r\n`,
      `data: ${JSON.stringify(completed)}\r\n\r\n`
    ].join('');
    const result = await new ResponsesStreamParser().parse(
      streamFromCharacters(streamText),
      'en',
      { onDelta: (event) => (event.type === 'reasoning' ? reasoning : content).push(event.delta) }
    );
    assert.equal(reasoning.join(''), 'summary');
    assert.equal(content.join(''), 'Cannot comply.');
    assert.equal(result.message.content, 'Cannot comply.');
    assert.equal(result.usage?.prompt_cache_hit_tokens, 8);
    assert.equal(result.usage?.prompt_cache_miss_tokens, 12);
    assert.equal(result.usage?.completion_tokens_details?.reasoning_tokens, 4);

    const incomplete = await parseEvents([{
      type: 'response.incomplete',
      response: {
        status: 'incomplete',
        incomplete_details: { reason: 'max_output_tokens' },
        output: [{
          type: 'message', role: 'assistant',
          content: [{ type: 'output_text', text: 'partial' }]
        }]
      }
    }]);
    assert.equal(incomplete.finishReason, 'length');
    assert.equal(incomplete.message.content, 'partial');
  });

  it('requires a terminal response before executing accumulated function arguments', async () => {
    const events = [
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc1', call_id: 'call-1', name: 'one', arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: '{"a"' },
      { type: 'response.function_call_arguments.delta', output_index: 0, item_id: 'fc1', delta: ':1}' },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc2', call_id: 'call-2', name: 'two', arguments: '' } },
      { type: 'response.function_call_arguments.done', output_index: 1, call_id: 'call-2', arguments: '{"b":2}' }
    ];
    await assert.rejects(parseEvents(events, true), /terminal response/u);
    events.push({ type: 'response.completed', response: { status: 'completed' } } as unknown as typeof events[number]);
    const result = await parseEvents(events, true);
    assert.equal(result.finishReason, 'tool_calls');
    assert.deepEqual(result.message.tool_calls?.map((call) => [call.id, call.function.name, call.function.arguments]), [
      ['call-1', 'one', '{"a":1}'],
      ['call-2', 'two', '{"b":2}']
    ]);
  });

  it('surfaces failed events and malformed JSON', async () => {
    await assert.rejects(
      parseEvents([{ type: 'response.failed', response: { status: 'failed', error: { message: 'upstream failed' } } }]),
      /upstream failed/u
    );
    await assert.rejects(
      new ResponsesStreamParser().parse(streamFromCharacters('data: {bad}\n\n'), 'en', {}),
      /Cannot parse/u
    );
    await assert.rejects(
      parseEvents([{ type: 'error', error: { message: 'event failed' } }]),
      /event failed/u
    );
    await assert.rejects(
      parseEvents([{
        type: 'response.incomplete',
        response: { incomplete_details: { reason: 'content_filter' }, output: [] }
      }]),
      /incomplete.*content_filter/u
    );
    await assert.rejects(
      new ResponsesStreamParser().parse(emptyStream(), 'en', {}),
      /did not return any streaming events/u
    );

    const multiLine = await new ResponsesStreamParser().parse(streamFromCharacters(
      'data: {"type":"response.output_text.done",\n' +
      'data: "text":"multi-line"}\n\n' +
      'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'
    ), 'en', {});
    assert.equal(multiLine.message.content, 'multi-line');
  });

  it('keeps shared abort, deadline, idle timeout, and empty-stream uncertainty behavior', async () => {
    const client = new OpenAiResponsesClient();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = abortingFetch();
      const externalAbort = new AbortController();
      externalAbort.abort();
      const aborted = await client.createModelResponse(clientConfig(), {
        body: minimalResponsesBody(),
        language: 'en',
        signal: externalAbort.signal
      });
      assert.equal(aborted.failureKind, 'external_abort');

      globalThis.fetch = abortingFetch();
      const deadline = await client.createModelResponse(clientConfig(), {
        body: minimalResponsesBody(),
        language: 'en',
        runDeadlineAt: Date.now() - 1
      });
      assert.equal(deadline.failureKind, 'run_time_limit');

      globalThis.fetch = abortingFetch();
      const idle = await client.createModelResponse({ ...clientConfig(), streamIdleTimeoutMs: 5 }, {
        body: minimalResponsesBody(),
        language: 'en'
      });
      assert.equal(idle.failureKind, 'stream_idle_timeout');

      let attempts = 0;
      globalThis.fetch = (async () => {
        attempts += 1;
        if (attempts === 1) {
          return new Response(emptyStream(), { status: 200 });
        }
        return completedResponse('retried');
      }) as typeof fetch;
      const retried = await client.createModelResponse({ ...clientConfig(), maxRequestRetries: 1 }, {
        body: minimalResponsesBody(),
        language: 'en'
      });
      assert.equal(retried.ok, false);
      assert.equal(retried.retryCount, 0);
      assert.equal(attempts, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('runs parallel function calls through two stateless /responses requests and persists replay order', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = bodies.length === 1
        ? {
            status: 'completed',
            output: [
              { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] },
              { type: 'function_call', id: 'fc_1', call_id: 'call-1', name: 'keepseek_list_workspace_files', arguments: '{}' },
              { type: 'function_call', id: 'fc_2', call_id: 'call-2', name: 'keepseek_list_workspace_files', arguments: '{}' }
            ],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 }
          }
        : {
            status: 'completed',
            output: [{
              type: 'message', id: 'msg_2', role: 'assistant', status: 'completed',
              content: [{ type: 'output_text', text: 'done' }]
            }],
            usage: { input_tokens: 140, output_tokens: 5, total_tokens: 145 }
          };
      return new Response(streamFromText(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`), {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' }
      });
    }) as typeof fetch;
    try {
      const request = createAgentRequest();
      request.settings = { ...request.settings, reasoningEffort: 'max' };
      request.model = {
        ...request.model,
        contextWindowTokens: 1_000_000,
        maxOutputTokens: 6_000
      };
      const response = await new AgentRunner().run(request);
      assert.equal(response.message, 'done');
      assert.equal(bodies.length, 2);
      const first = bodies[0];
      assert.equal(first.store, false);
      assert.ok(Array.isArray(first.input));
      assert.equal('messages' in first, false);
      assert.equal('max_tokens' in first, false);
      assert.equal('stream_options' in first, false);
      assert.equal('thinking' in first, false);
      assert.equal('previous_response_id' in first, false);
      assert.equal(first.max_output_tokens, 6_000);
      assert.deepEqual(first.include, ['reasoning.encrypted_content']);
      assert.deepEqual(first.reasoning, { effort: 'high' });
      const flatTool = (first.tools as Array<Record<string, unknown>>)[0];
      assert.equal(flatTool.type, 'function');
      assert.equal(typeof flatTool.name, 'string');
      assert.equal('function' in flatTool, false);

      const secondInput = bodies[1].input as OpenAiResponsesItem[];
      assert.equal(bodies[1].tool_choice, 'none');
      assert.deepEqual(bodies[1].tools, first.tools);
      const reasoningIndex = secondInput.findIndex((item) => item.type === 'reasoning');
      const callIndexes = ['call-1', 'call-2'].map((callId) => secondInput.findIndex((item) => item.call_id === callId && item.type === 'function_call'));
      const outputIndexes = ['call-1', 'call-2'].map((callId) => secondInput.findIndex((item) => item.call_id === callId && item.type === 'function_call_output'));
      assert.ok(reasoningIndex >= 0);
      assert.ok(callIndexes[0] < callIndexes[1]);
      assert.ok(callIndexes[1] < outputIndexes[0]);
      assert.ok(outputIndexes[0] < outputIndexes[1]);

      const replay = getResponsesReplay(response.providerReplay);
      assert.deepEqual(replay.items.map((item) => item.type), [
        'reasoning', 'function_call', 'function_call',
        'function_call_output', 'function_call_output', undefined, 'message'
      ]);
      assert.equal(replay.items[5].role, 'user');
      assert.equal(replay.sourceId, 'responses-source');
      assert.equal(replay.baseUrl, 'https://proxy.example/v1/responses');
      assert.equal(response.toolRounds?.[0]?.toolResults.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('replays native output before length continuation instructions', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return bodies.length === 1
        ? incompleteResponse('hel')
        : completedResponse('lo');
    }) as typeof fetch;
    try {
      const response = await new AgentRunner().run(createAgentRequest());
      assert.equal(response.message, 'hello');
      assert.equal(bodies.length, 2);
      const secondInput = bodies[1].input as OpenAiResponsesItem[];
      const nativeMessageIndex = secondInput.findIndex((item) => item.type === 'message');
      const instructionIndex = secondInput.findIndex((item) => item.role === 'user'
        && typeof item.content === 'string'
        && item.content.startsWith('Continue the previous answer'));
      assert.ok(nativeMessageIndex >= 0 && nativeMessageIndex < instructionIndex);
      assert.deepEqual(getResponsesReplay(response.providerReplay).items.map((item) => item.type), [
        'message', undefined, 'message'
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('interrupts a broken partial stream without silently issuing another request', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (bodies.length === 1) {
        const text = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'hel' })}\n\n`
          + 'data: {broken}\n\n';
        return new Response(streamFromText(text), { status: 200 });
      }
      return completedResponse('lo');
    }) as typeof fetch;
    try {
      await assert.rejects(new AgentRunner().run(createAgentRequest()), /Cannot parse/u);
      assert.equal(bodies.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('omits reasoning when thinking is disabled', async () => {
    let capturedBody: Record<string, unknown> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return completedResponse('done');
    }) as typeof fetch;
    try {
      const request = createAgentRequest();
      request.settings = { ...request.settings, thinkingEnabled: false };
      await new AgentRunner().run(request);
      assert.equal('reasoning' in capturedBody, false);
      assert.equal('include' in capturedBody, false);
      assert.equal('reasoning_effort' in capturedBody, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('uses the selected Responses lane for stateless context summaries', async () => {
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input, init) => {
      capturedUrl = String(input);
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const response = {
        status: 'completed',
        output: [{
          type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'summary' }]
        }]
      };
      return new Response(streamFromText(
        `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`
      ), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as typeof fetch;
    try {
      const compressor = new HistoryCompressor() as unknown as {
        completeSummary(input: {
          model: AgentRequest['model'];
          messages: Array<{ role: 'system' | 'user'; content: string }>;
          maxTokens: number;
          timeoutMs: number;
          language: 'en';
          usageSource: 'summary';
          sourceConfig: AgentRequest['sourceConfig'];
        }): Promise<{ content: string }>;
      };
      const result = await compressor.completeSummary({
        model: { ...MODEL, maxOutputTokens: 200 },
        messages: [{ role: 'system', content: 'summarize' }, { role: 'user', content: 'history' }],
        maxTokens: 321,
        timeoutMs: 1_000,
        language: 'en',
        usageSource: 'summary',
        sourceConfig: createAgentRequest().sourceConfig
      });
      assert.equal(result.content, 'summary');
      assert.equal(capturedUrl, 'https://proxy.example/v1/responses');
      assert.equal(capturedBody.store, false);
      assert.equal(capturedBody.max_output_tokens, 200);
      assert.ok(Array.isArray(capturedBody.input));
      assert.equal('messages' in capturedBody, false);
      assert.equal('tools' in capturedBody, false);
      assert.equal('reasoning' in capturedBody, false);
      assert.equal('thinking' in capturedBody, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('validates persisted replay atomically and drops unknown or oversized state', () => {
    const valid = normalizeOpenAiResponsesReplay({
      protocol: 'openai-responses',
      sourceId: 'source',
      baseUrl: 'https://example/v1/responses',
      items: [
        { type: 'reasoning', id: 'rs', encrypted_content: 'opaque' },
        { type: 'function_call', call_id: 'call', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call', output: 'ok' },
        {
          type: 'message', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'done' }]
        }
      ]
    });
    assert.equal(valid?.items.length, 4);
    assert.equal(normalizeOpenAiResponsesReplay({
      ...valid,
      items: [...(valid?.items ?? []), { type: 'web_search_call', id: 'unsupported' }]
    }), undefined);
    assert.equal(normalizeOpenAiResponsesReplay({
      ...valid,
      items: [{
        type: 'message', role: 'assistant',
        content: [{ type: 'output_image', image_url: 'unsupported' }]
      }]
    }), undefined);
    assert.equal(normalizeOpenAiResponsesReplay({
      ...valid,
      items: [{ type: 'reasoning', encrypted_content: 'x'.repeat(2_100_000) }]
    }), undefined);

    const sessions = normalizeStoredSessions({
      sessions: [{
        id: 'session',
        title: 'Responses',
        messages: [{
          id: 'assistant',
          role: 'assistant',
          content: 'visible',
          createdAt: '2026-01-01T00:00:00.000Z',
          providerReplay: valid
        }],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        workspaceKey: 'test',
        workspaceName: 'Test',
        workspaceFolders: [],
        isFavorite: false
      }]
    }, { key: 'test', name: 'Test', folderUris: [] });
    assert.deepEqual(sessions[0].messages[0].providerReplay, valid);
    assert.equal(getVisibleMessages(sessions[0].messages)[0].providerReplay, undefined);
  });
});

function projectionInput(history: ChatMessage[]) {
  return {
    model: MODEL,
    agentSettings: SETTINGS,
    contextFiles: [],
    history,
    language: 'en' as const,
    prompt: 'visible',
    requestProtocolVersion: 2,
    provider: 'openai-responses' as const,
    sourceId: 'responses-source',
    baseUrl: 'https://proxy.example/v1',
    includeTools: true
  };
}

function getResponsesReplay(replay: AgentRequest['history'][number]['providerReplay']) {
  if (replay?.protocol !== 'openai-responses') {
    assert.fail('Expected an OpenAI Responses replay.');
  }
  return replay;
}

function buildProjection(history: ChatMessage[]) {
  return buildProviderRequestProjection(projectionInput(history));
}

function createAgentRequest(): AgentRequest {
  const user: ChatMessage = {
    id: 'user-1',
    role: 'user',
    content: 'list files twice',
    createdAt: '2026-01-01T00:00:00.000Z'
  };
  return {
    prompt: 'list files twice',
    model: MODEL,
    settings: SETTINGS,
    contextFiles: [],
    history: [user],
    language: 'en',
    sourceConfig: {
      sourceId: 'responses-source',
      provider: 'openai-responses',
      apiKey: 'secret',
      baseUrl: 'https://proxy.example/v1',
      supportsBilling: false
    },
    executionLimits: { maxToolIterations: 1 }
  };
}

async function parseEvents(events: Array<Record<string, unknown>>, doneMarker = false) {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    + (doneMarker ? 'data: [DONE]\n\n' : '');
  return await new ResponsesStreamParser().parse(streamFromCharacters(text), 'en', {});
}

function streamFromCharacters(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const characters = Array.from(text);
  return new ReadableStream({
    start(controller) {
      for (const character of characters) {
        controller.enqueue(encoder.encode(character));
      }
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
  return new ReadableStream({
    start(controller) {
      controller.close();
    }
  });
}

function clientConfig() {
  return {
    apiKey: 'key',
    baseUrl: 'https://proxy.example/v1',
    streamIdleTimeoutMs: 0,
    maxRequestRetries: 0,
    requestRetryBaseMs: 0
  };
}

function minimalResponsesBody(): OpenAiResponsesRequestBody {
  return {
    model: 'responses-model',
    input: [{ role: 'user', content: 'hello' }],
    stream: true,
    store: false
  };
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

function completedResponse(text: string): Response {
  const response = {
    status: 'completed',
    output: [{
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text }]
    }]
  };
  return new Response(streamFromText(
    `data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`
  ), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function incompleteResponse(text: string): Response {
  const response = {
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [{
      type: 'message',
      role: 'assistant',
      status: 'incomplete',
      content: [{ type: 'output_text', text }]
    }]
  };
  return new Response(streamFromText(
    `data: ${JSON.stringify({ type: 'response.incomplete', response })}\n\n`
  ), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
