import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { AccountStore } from '../src/accounts/accountStore';
import type { ActiveAccountConfigSnapshot } from '../src/accounts/types';
import { HistoryCompressor } from '../src/agent/historyCompressor';
import { AgentRunner } from '../src/agent/runner';
import type {
  DeepSeekChatRequestBody,
  DeepSeekFunctionTool,
  DeepSeekMessage,
  DeepSeekStreamResult
} from '../src/agent/deepseek/types';
import type {
  DeepSeekClientConfig,
  DeepSeekClientRequest,
  DeepSeekClientResult
} from '../src/agent/deepseek/client';
import type { ContextCompressionSettings } from '../src/shared/modelProfiles';
import type { AgentRequest } from '../src/shared/types';

interface TestRuntimeConfig {
  accountId: string;
  provider: 'deepseek' | 'openai-compatible';
  apiKey: string;
  baseUrl: string;
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
  deepSeekClient: CapturingClient;
  createChatCompletion(
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
  deepSeekClient: CapturingClient;
  completeSummary(input: {
    model: AgentRequest['model'];
    messages: DeepSeekMessage[];
    maxTokens: number;
    timeoutMs: number;
    language: AgentRequest['language'];
    usageSource: 'summary';
    accountConfig?: ActiveAccountConfigSnapshot;
  }): Promise<{ content: string }>;
}

class CapturingClient {
  public config: DeepSeekClientConfig | undefined;
  public request: DeepSeekClientRequest | undefined;

  public async createChatCompletion(
    config: DeepSeekClientConfig,
    request: DeepSeekClientRequest
  ): Promise<DeepSeekClientResult> {
    this.config = config;
    this.request = request;
    return {
      ok: true,
      message: { role: 'assistant', content: 'ok' },
      finishReason: 'stop',
      hadPartialOutput: true,
      retryable: false
    };
  }
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
  const runner = new AgentRunner() as unknown as RuntimeInvoker;
  const client = new CapturingClient();
  runner.deepSeekClient = client;

  await runner.createChatCompletion(
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

  const body = serializeBody(client.request?.body);
  assert.equal(body.model, 'vendor-reasoning-model');
  assert.equal('thinking' in body, false);
  assert.equal('reasoning_effort' in body, false);
  assert.equal(body.stream, true);
  assert.equal(body.tool_choice, 'auto');
  assert.deepEqual(body.tools, [TEST_TOOL]);
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.equal('reasoning_content' in messages[1], false);
});

test('main runtime resolves credentials from the active account store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-main-runtime-account-'));
  try {
    const globalStorageUri = vscode.Uri.file(dir);
    await new AccountStore(globalStorageUri).createAccount({
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
    assert.equal(runtime.accountId, 'compatible');
    assert.equal(runtime.provider, 'openai-compatible');
    assert.equal(runtime.apiKey, 'compatible-key');
    assert.equal(runtime.baseUrl, 'https://compatible.example/v1');
    assert.equal(runtime.maxTokens, 192_000, 'unknown models retain the conservative Flash profile');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main runtime uses the immutable per-run account snapshot', async () => {
  const runner = new AgentRunner() as unknown as RuntimeConfigInvoker;
  const request = createRequest('snapshot-model', 'openai-compatible');
  request.accountConfig = {
    accountId: 'snapshot-account',
    provider: 'openai-compatible',
    apiKey: 'snapshot-key',
    baseUrl: 'https://snapshot.example/v1'
  };

  const runtime = await runner.getRuntimeConfig(request);
  assert.equal(runtime.accountId, 'snapshot-account');
  assert.equal(runtime.provider, 'openai-compatible');
  assert.equal(runtime.apiKey, 'snapshot-key');
  assert.equal(runtime.baseUrl, 'https://snapshot.example/v1');
});

test('DeepSeek runtime preserves thinking and reasoning effort fields', async () => {
  const runner = new AgentRunner() as unknown as RuntimeInvoker;
  const client = new CapturingClient();
  runner.deepSeekClient = client;

  await runner.createChatCompletion(
    createRequest('deepseek-v4-pro', 'deepseek'),
    createRuntimeConfig('deepseek'),
    [{ role: 'assistant', content: null, reasoning_content: null, tool_calls: [] }],
    [],
    {}
  );

  const body = serializeBody(client.request?.body);
  assert.equal(body.model, 'deepseek-v4-pro');
  assert.deepEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.reasoning_effort, 'max');
  const messages = body.messages as Array<Record<string, unknown>>;
  assert.equal(Object.prototype.hasOwnProperty.call(messages[0], 'reasoning_content'), true);
  assert.equal(messages[0].reasoning_content, null);
});

test('context summaries resolve the same account storage and omit DeepSeek-only fields for compatible providers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-runtime-account-'));
  try {
    const globalStorageUri = vscode.Uri.file(dir);
    await new AccountStore(globalStorageUri).createAccount({
      id: 'compatible',
      provider: 'openai-compatible',
      name: 'Compatible',
      apiKey: 'compatible-key',
      baseUrl: 'https://compatible.example/v1'
    });
    const compressor = new HistoryCompressor(undefined, globalStorageUri) as unknown as SummaryInvoker;
    const client = new CapturingClient();
    compressor.deepSeekClient = client;

    await compressor.completeSummary({
      model: {
        id: 'summary-model',
        label: 'Summary Model',
        provider: 'openai-compatible'
      },
      messages: [{ role: 'user', content: 'summarize' }],
      maxTokens: 100,
      timeoutMs: 1_000,
      language: 'en',
      usageSource: 'summary'
    });

    const body = serializeBody(client.request?.body);
    assert.equal(client.config?.apiKey, 'compatible-key');
    assert.equal(client.config?.baseUrl, 'https://compatible.example/v1');
    assert.equal(body.model, 'summary-model');
    assert.equal('thinking' in body, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context summaries use the same immutable per-run account snapshot', async () => {
  const compressor = new HistoryCompressor() as unknown as SummaryInvoker;
  const client = new CapturingClient();
  compressor.deepSeekClient = client;
  const accountConfig: ActiveAccountConfigSnapshot = {
    accountId: 'snapshot-account',
    provider: 'openai-compatible',
    apiKey: 'snapshot-key',
    baseUrl: 'https://snapshot.example/v1'
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
    accountConfig
  });

  assert.equal(client.config?.apiKey, 'snapshot-key');
  assert.equal(client.config?.baseUrl, 'https://snapshot.example/v1');
  const body = serializeBody(client.request?.body);
  assert.equal(body.model, 'snapshot-model');
  assert.equal('thinking' in body, false);
});

function createRequest(modelId: string, provider: string): AgentRequest {
  return {
    model: {
      id: modelId,
      label: modelId,
      provider
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
    accountId: provider === 'deepseek' ? 'default' : 'compatible',
    provider,
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
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

function serializeBody(body: DeepSeekChatRequestBody | undefined): Record<string, unknown> {
  assert.ok(body);
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}
