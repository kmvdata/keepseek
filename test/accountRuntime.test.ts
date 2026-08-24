import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import type { ModelSourceConfigSnapshot, ModelSourceProvider } from '../src/accounts/types';
import { HistoryCompressor } from '../src/agent/historyCompressor';
import { AgentRunner } from '../src/agent/runner';
import type {
  DeepSeekFunctionTool,
  DeepSeekMessage,
  DeepSeekStreamResult,
  DeepSeekUsage
} from '../src/agent/deepseek/types';
import type { ContextCompressionSettings } from '../src/shared/modelProfiles';
import type { AgentRequest } from '../src/shared/types';

interface TestRuntimeConfig {
  sourceId: string;
  provider: ModelSourceProvider;
  apiKey: string;
  baseUrl: string;
  supportsBilling: boolean;
  maxTokens: number;
  maxToolIterations: number;
  maxToolCalls: number;
  maxRunMs: number;
  toolResultTokenBudget: number;
  streamIdleTimeoutMs: number;
  temperature: number;
  topP: number;
  contextCompression: ContextCompressionSettings;
  maxRequestRetries: number;
  requestRetryBaseMs: number;
  maxValidationRuns: number;
  maxRepairIterations: number;
}

interface RuntimeInvoker {
  createModelResponse(
    request: AgentRequest,
    runtimeConfig: TestRuntimeConfig,
    messages: DeepSeekMessage[],
    tools: DeepSeekFunctionTool[],
    callbacks: Record<string, never>
  ): Promise<DeepSeekStreamResult>;
}

interface RuntimeConfigInvoker {
  getRuntimeConfig(request: AgentRequest): Promise<TestRuntimeConfig>;
}

interface SummaryInvoker {
  completeSummary(input: {
    model: AgentRequest['model'];
    messages: DeepSeekMessage[];
    maxTokens: number;
    timeoutMs: number;
    language: AgentRequest['language'];
    usageSource: 'summary';
    sourceConfig?: ModelSourceConfigSnapshot;
  }): Promise<{ content: string }>;
}

interface UsageInvoker {
  recordUpstreamUsage(
    usage: DeepSeekUsage,
    totals: {
      requestCount: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      cacheHitTokens: number;
      cacheMissTokens: number;
      reasoningTokens: number;
      cost: number;
      currency: string;
      records: UsageEvent[];
    },
    trace: ReturnType<typeof createNoopInteractionTrace>,
    requestId: string,
    modelId: string,
    supportsBilling: boolean,
    source: 'executor'
  ): UsageEvent | undefined;
}

interface CapturedRequest {
  url: string;
  body: string;
  authorization: string | undefined;
}

/** 替换全局 fetch 捕获上游请求，返回一段固定 SSE 流；返回恢复函数。 */
function mockFetchCapturing(
  captured: CapturedRequest[],
  content: string
): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1]
  ): Promise<Response> => {
    const headers = init?.headers as Record<string, string> | undefined;
    captured.push({
      url: String(input),
      body: typeof init?.body === 'string' ? init.body : '',
      authorization: headers?.Authorization
    });
    return new Response(createSseStream(content), {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' }
    });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
}

function createSseStream(content: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = `data: ${JSON.stringify({
    choices: [{ delta: { content }, finish_reason: 'stop' }]
  })}\n\ndata: [DONE]\n\n`;
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    }
  });
}

const BASE_COMPRESSION: ContextCompressionSettings = {
  keepRecentTurns: 1,
  softCompactRatio: 0.4,
  toolResultSnipRatio: 0.5,
  triggerRatio: 0.8,
  forceRatio: 0.92,
  summaryBudgetTokens: 1_000,
  summaryRequestTimeoutMs: 1_000
};

const TEST_TOOL: DeepSeekFunctionTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read a file',
    parameters: {
      type: 'object',
      properties: {}
    }
  }
};

test('openai-compatible runtime sends the actual model id without DeepSeek-only parameters', async () => {
  const captured: CapturedRequest[] = [];
  const restore = mockFetchCapturing(captured, 'ok');
  try {
    const runner = new AgentRunner() as unknown as RuntimeInvoker;

    await runner.createModelResponse(
      createRequest('vendor-reasoning-model', 'openai-compatible'),
      createRuntimeConfig('openai-compatible'),
      [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: null,
          reasoning_content: null,
          tool_calls: [{
            id: 'call-1',
            type: 'function',
            function: { name: 'read_file', arguments: '{}' }
          }]
        },
        { role: 'tool', tool_call_id: 'call-1', content: 'result' }
      ],
      [TEST_TOOL],
      {}
    );

    assert.equal(captured.length, 1);
    const body = parseRequestBody(captured[0].body);
    assert.equal(body.model, 'vendor-reasoning-model');
    assert.equal('thinking' in body, false);
    assert.equal('reasoning_effort' in body, false);
    assert.equal(body.stream, true);
    assert.equal(body.tool_choice, 'auto');
    assert.deepEqual(body.tools, [TEST_TOOL]);
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal('reasoning_content' in messages[1], false);
  } finally {
    restore();
  }
});

test('main runtime resolves credentials from the model source bound to the selected model', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-main-runtime-account-'));
  try {
    const globalStorageUri = vscode.Uri.file(dir);
    await new ModelSourceStore(globalStorageUri).createSource({
      id: 'compatible',
      provider: 'openai-compatible',
      name: 'Compatible',
      apiKey: 'compatible-key',
      baseUrl: 'https://compatible.example/v1'
    });
    const runner = new AgentRunner(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      globalStorageUri
    ) as unknown as RuntimeConfigInvoker;

    const runtime = await runner.getRuntimeConfig(
      createRequest('vendor-model', 'openai-compatible')
    );
    assert.equal(runtime.sourceId, 'compatible');
    assert.equal(runtime.provider, 'openai-compatible');
    assert.equal(runtime.apiKey, 'compatible-key');
    assert.equal(runtime.baseUrl, 'https://compatible.example/v1');
    assert.equal(runtime.maxTokens, 192_000, 'unknown models retain the conservative Flash profile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main runtime uses the immutable per-run source snapshot', async () => {
  const runner = new AgentRunner() as unknown as RuntimeConfigInvoker;
  const request = createRequest('snapshot-model', 'openai-compatible');
  request.sourceConfig = {
    sourceId: 'snapshot-source',
    provider: 'openai-compatible',
    apiKey: 'snapshot-key',
    baseUrl: 'https://snapshot.example/v1',
    supportsBilling: false
  };

  const runtime = await runner.getRuntimeConfig(request);
  assert.equal(runtime.sourceId, 'snapshot-source');
  assert.equal(runtime.provider, 'openai-compatible');
  assert.equal(runtime.apiKey, 'snapshot-key');
  assert.equal(runtime.baseUrl, 'https://snapshot.example/v1');
});

test('Responses runtime uses its immutable non-billing source snapshot', async () => {
  const runner = new AgentRunner() as unknown as RuntimeConfigInvoker;
  const request = createRequest('responses-model', 'openai-responses');
  request.sourceConfig = Object.freeze({
    sourceId: 'responses-snapshot',
    provider: 'openai-responses',
    apiKey: 'responses-key',
    baseUrl: 'https://responses.example/v1',
    supportsBilling: false
  });

  const runtime = await runner.getRuntimeConfig(request);
  assert.equal(runtime.sourceId, 'responses-snapshot');
  assert.equal(runtime.provider, 'openai-responses');
  assert.equal(runtime.apiKey, 'responses-key');
  assert.equal(runtime.baseUrl, 'https://responses.example/v1');
  assert.equal(runtime.supportsBilling, false);
});

test('DeepSeek runtime preserves thinking and reasoning effort fields', async () => {
  const captured: CapturedRequest[] = [];
  const restore = mockFetchCapturing(captured, 'ok');
  try {
    const runner = new AgentRunner() as unknown as RuntimeInvoker;

    await runner.createModelResponse(
      createRequest('deepseek-v4-pro', 'deepseek'),
      createRuntimeConfig('deepseek'),
      [{ role: 'assistant', content: null, reasoning_content: null, tool_calls: [] }],
      [],
      {}
    );

    assert.equal(captured.length, 1);
    const body = parseRequestBody(captured[0].body);
    assert.equal(body.model, 'deepseek-v4-pro');
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'max');
    const messages = body.messages as Array<Record<string, unknown>>;
    assert.equal(Object.prototype.hasOwnProperty.call(messages[0], 'reasoning_content'), true);
    assert.equal(messages[0].reasoning_content, null);
  } finally {
    restore();
  }
});

test('context summaries resolve the selected source and omit DeepSeek-only fields for compatible providers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-runtime-account-'));
  try {
    const globalStorageUri = vscode.Uri.file(dir);
    await new ModelSourceStore(globalStorageUri).createSource({
      id: 'compatible',
      provider: 'openai-compatible',
      name: 'Compatible',
      apiKey: 'compatible-key',
      baseUrl: 'https://compatible.example/v1'
    });
    const captured: CapturedRequest[] = [];
    const restore = mockFetchCapturing(captured, 'ok');
    try {
      const compressor = new HistoryCompressor(undefined, globalStorageUri) as unknown as SummaryInvoker;

      await compressor.completeSummary({
        model: {
          id: 'summary-model',
          label: 'Summary Model',
          provider: 'openai-compatible',
          sourceId: 'compatible'
        },
        messages: [{ role: 'user', content: 'summarize' }],
        maxTokens: 100,
        timeoutMs: 1_000,
        language: 'en',
        usageSource: 'summary'
      });

      assert.equal(captured.length, 1);
      assert.equal(captured[0].authorization, 'Bearer compatible-key');
      const body = parseRequestBody(captured[0].body);
      assert.equal(body.model, 'summary-model');
      assert.equal('thinking' in body, false);
    } finally {
      restore();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context summaries use the same immutable per-run source snapshot', async () => {
  const captured: CapturedRequest[] = [];
  const restore = mockFetchCapturing(captured, 'ok');
  try {
    const compressor = new HistoryCompressor() as unknown as SummaryInvoker;
    const sourceConfig: ModelSourceConfigSnapshot = {
      sourceId: 'snapshot-source',
      provider: 'openai-compatible',
      apiKey: 'snapshot-key',
      baseUrl: 'https://snapshot.example/v1',
      supportsBilling: false
    };

    await compressor.completeSummary({
      model: {
        id: 'snapshot-model',
        label: 'Snapshot Model',
        provider: 'openai-compatible'
      },
      messages: [{ role: 'user', content: 'summarize' }],
      maxTokens: 100,
      timeoutMs: 1_000,
      language: 'en',
      usageSource: 'summary',
      sourceConfig
    });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].authorization, 'Bearer snapshot-key');
    const body = parseRequestBody(captured[0].body);
    assert.equal(body.model, 'snapshot-model');
    assert.equal('thinking' in body, false);
  } finally {
    restore();
  }
});

test('non-official sources record tokens but force cost and currency to empty values', () => {
  const runner = new AgentRunner() as unknown as UsageInvoker;
  const totals = {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    currency: '',
    records: [] as UsageEvent[]
  };
  const event = runner.recordUpstreamUsage(
    { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    totals,
    createNoopInteractionTrace(),
    'request-1',
    'deepseek-v4-flash',
    false,
    'executor'
  );
  assert.equal(event?.usage.totalTokens, 120);
  assert.equal(event?.cost, 0);
  assert.equal(event?.currency, '');
  assert.equal(totals.cost, 0);
});

function createRequest(modelId: string, provider: string): AgentRequest {
  return {
    model: {
      id: modelId,
      label: modelId,
      provider,
      sourceId: provider === 'deepseek' ? 'official' : 'compatible',
      supportsBilling: provider === 'deepseek'
    },
    settings: {
      thinkingEnabled: true,
      reasoningEffort: 'max',
      compressionThreshold: 'balanced'
    },
    language: 'en'
  } as AgentRequest;
}

function createRuntimeConfig(provider: TestRuntimeConfig['provider']): TestRuntimeConfig {
  return {
    sourceId: provider === 'deepseek' ? 'official' : 'compatible',
    provider,
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    supportsBilling: provider === 'deepseek',
    maxTokens: 1_000,
    maxToolIterations: 8,
    maxToolCalls: 24,
    maxRunMs: 60_000,
    toolResultTokenBudget: 10_000,
    streamIdleTimeoutMs: 0,
    temperature: 1,
    topP: 1,
    contextCompression: BASE_COMPRESSION,
    maxRequestRetries: 0,
    requestRetryBaseMs: 1,
    maxValidationRuns: 1,
    maxRepairIterations: 1
  };
}

function parseRequestBody(body: string): Record<string, unknown> {
  return JSON.parse(body) as Record<string, unknown>;
}

import type { UsageEvent } from '../src/shared/types';
import { createNoopInteractionTrace } from '../src/agent/logging/interactionTrace';
