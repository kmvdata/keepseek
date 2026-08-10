import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decidePlannerRoute } from '../src/agent/plannerRoute';
import { resolveSubagentModel } from '../src/agent/subagent/modelResolver';
import { SubagentScheduler } from '../src/agent/subagent/scheduler';
import {
  READONLY_AGENT_TOOL_NAMES,
  type ReadonlyCompletionClient,
  SubagentRunner
} from '../src/agent/subagent/subagentRunner';
import { runReviewBestEffort } from '../src/agent/subagent/reviewSubagent';
import { AgentRunner } from '../src/agent/runner';
import { appendPlannerPlanToExecutorTurn } from '../src/agent/plannerPrompt';
import type { UsageEvent } from '../src/shared/types';
import type { DeepSeekClientConfig, DeepSeekClientRequest } from '../src/agent/deepseek/client';
import type { GitToolAdapter } from '../src/agent/tools/gitTools';
import type { SemanticToolAdapter } from '../src/agent/tools/semanticTools';
import type { ValidationToolAdapter } from '../src/agent/tools/validationTools';
import type { WorkspaceToolAdapter } from '../src/agent/tools/workspaceTools';

test('planner routing prioritizes plan-only markers and ignores quoted examples', () => {
  assert.deepEqual(decidePlannerRoute({
    prompt: '只规划方案，不要动手。',
    language: 'zh-CN',
    mode: 'explicit'
  }), { route: 'plan_only', reason: 'plan_only_marker' });
  assert.deepEqual(decidePlannerRoute({
    prompt: '先规划，然后直接完成实现。',
    language: 'zh-CN',
    mode: 'explicit'
  }), { route: 'plan_and_execute', reason: 'explicit_plan' });
  assert.deepEqual(decidePlannerRoute({
    prompt: '文档示例写成“只规划/不要执行”，请修正这个标点。',
    language: 'zh-CN',
    mode: 'explicit'
  }), { route: 'executor_only', reason: 'default' });
  assert.deepEqual(decidePlannerRoute({
    prompt: 'Rename the label `plan only` in this test fixture.',
    language: 'en',
    mode: 'explicit'
  }), { route: 'executor_only', reason: 'default' });
  assert.deepEqual(decidePlannerRoute({
    prompt: "Don't execute; just plan the migration.",
    language: 'en',
    mode: 'explicit'
  }), { route: 'plan_only', reason: 'plan_only_marker' });
});

test('auto planner routing uses deterministic complexity thresholds', () => {
  const prompt = [
    'Refactor the architecture across multiple files.',
    'Keep compatibility and add tests.'
  ].join('\n');
  assert.deepEqual(decidePlannerRoute({ prompt, language: 'en', mode: 'auto' }), {
    route: 'plan_and_execute',
    reason: 'auto_complexity'
  });
  assert.deepEqual(decidePlannerRoute({ prompt, language: 'en', mode: 'explicit' }), {
    route: 'executor_only',
    reason: 'default'
  });
});

test('planner plan is appended only to the current executor user turn projection', () => {
  const history = [
    {
      id: 'user-old',
      role: 'user' as const,
      content: 'Earlier request',
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    {
      id: 'assistant-old',
      role: 'assistant' as const,
      content: 'Earlier answer',
      createdAt: '2026-01-01T00:00:01.000Z'
    },
    {
      id: 'user-current',
      role: 'user' as const,
      content: 'See <file>',
      expandedContent: 'See expanded file contents',
      createdAt: '2026-01-01T00:00:02.000Z'
    }
  ];
  const result = appendPlannerPlanToExecutorTurn({
    prompt: 'See expanded file contents',
    history,
    plan: '1. Make the bounded change.\n\n[plan]',
    language: 'en'
  });
  assert.equal(history[2]?.expandedContent, 'See expanded file contents');
  assert.equal(result.history[0], history[0]);
  assert.equal(result.history[1], history[1]);
  assert.equal(result.history[2]?.content, 'See <file>');
  assert.equal(result.history[2]?.expandedContent, result.prompt);
  assert.ok(result.prompt.startsWith('See expanded file contents\n\n'));
  assert.match(result.prompt, /Implementation plan from the planning model/u);
});

test('subagent model resolution follows priority and invalid fallback order', () => {
  const base = {
    taskType: 'security-review',
    overrides: { security_review: 'model-override' },
    defaultModel: 'model-default',
    executorModel: 'model-executor',
    supportedModelIds: ['model-explicit', 'model-override', 'model-default', 'model-executor']
  };
  assert.equal(resolveSubagentModel({ ...base, explicitModel: 'model-explicit' }), 'model-explicit');
  assert.equal(resolveSubagentModel({ ...base, explicitModel: 'invalid' }), 'model-override');
  assert.equal(resolveSubagentModel({
    ...base,
    explicitModel: 'invalid',
    overrides: { security_review: 'also-invalid' }
  }), 'model-default');
  assert.equal(resolveSubagentModel({
    ...base,
    explicitModel: 'invalid',
    overrides: { security_review: 'also-invalid' },
    defaultModel: 'still-invalid'
  }), 'model-executor');
});

test('planner read-only research stops at the configured tool-round budget', async () => {
  const requests: DeepSeekClientRequest[] = [];
  const client: ReadonlyCompletionClient = {
    createChatCompletion: async (_config: DeepSeekClientConfig, request: DeepSeekClientRequest) => {
      requests.push(request);
      if (requests.length === 1) {
        return {
          ok: true,
          hadPartialOutput: false,
          retryable: false,
          message: {
            content: '',
            tool_calls: [{
              id: 'call-1',
              type: 'function',
              function: { name: 'keepseek_list_workspace_files', arguments: '{}' }
            }]
          }
        };
      }
      return {
        ok: true,
        hadPartialOutput: false,
        retryable: false,
        finishReason: 'stop',
        message: { content: '# Plan\n\n1. Inspect.\n\n[plan]' }
      };
    }
  };
  let listCalls = 0;
  const runner = new SubagentRunner(
    {
      listWorkspaceFiles: async () => {
        listCalls += 1;
        return JSON.stringify({ ok: true, files: [] });
      }
    } as unknown as WorkspaceToolAdapter,
    {} as Pick<ValidationToolAdapter, 'readWorkspaceDiagnostics'>,
    {} as SemanticToolAdapter,
    {} as GitToolAdapter,
    client
  );

  const result = await runner.run({
    modelId: 'deepseek-v4-flash',
    messages: [
      { role: 'system', content: 'static' },
      { role: 'user', content: 'plan' }
    ],
    thinkingEnabled: true,
    reasoningEffort: 'high',
    maxToolRounds: 1,
    maxTokens: 512,
    maxDurationMs: 1_000,
    clientConfig: createClientConfig(),
    language: 'en'
  });

  assert.equal(listCalls, 1);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.body.tools, undefined);
  assert.match(String(requests[1]?.body.messages.at(-1)?.content), /budget is exhausted/u);
  assert.equal(result.researchSteps, 1);
  assert.equal(result.truncated, true);
});

test('planner and review schemas exclude edit, delete, and validation tools', () => {
  assert.equal(READONLY_AGENT_TOOL_NAMES.includes('keepseek_create_draft_edit'), false);
  assert.equal(READONLY_AGENT_TOOL_NAMES.includes('keepseek_delete_workspace_file'), false);
  assert.equal(READONLY_AGENT_TOOL_NAMES.includes('keepseek_run_validation'), false);
});

test('read-only model usage is attributed and priced with its own model id', async () => {
  const events: UsageEvent[] = [];
  const client: ReadonlyCompletionClient = {
    createChatCompletion: async () => ({
      ok: true,
      hadPartialOutput: false,
      retryable: false,
      message: { content: 'No material issue.' },
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        prompt_cache_hit_tokens: 40,
        prompt_cache_miss_tokens: 60
      }
    })
  };
  const runner = new SubagentRunner(
    {} as WorkspaceToolAdapter,
    {} as Pick<ValidationToolAdapter, 'readWorkspaceDiagnostics'>,
    {} as SemanticToolAdapter,
    {} as GitToolAdapter,
    client
  );
  await runner.run({
    modelId: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'Review.' }],
    thinkingEnabled: true,
    reasoningEffort: 'high',
    maxToolRounds: 0,
    maxTokens: 512,
    maxDurationMs: 1_000,
    clientConfig: createClientConfig(),
    language: 'en',
    callbacks: { onUsage: (event) => events.push(event) }
  });
  assert.equal(events.length, 1);
  assert.equal(events[0]?.modelId, 'deepseek-v4-pro');
  assert.equal(events[0]?.cost, 0.000481);
});

test('plan-only planner failure returns a localized response instead of failing the run', async () => {
  const client: ReadonlyCompletionClient = {
    createChatCompletion: async () => ({
      ok: false,
      hadPartialOutput: false,
      retryable: false,
      error: 'planner unavailable'
    })
  };
  const workspaceTools = {} as WorkspaceToolAdapter;
  const validationTools = {} as ValidationToolAdapter;
  const semanticTools = {} as SemanticToolAdapter;
  const gitTools = {} as GitToolAdapter;
  const readonlyRunner = new SubagentRunner(
    workspaceTools,
    validationTools,
    semanticTools,
    gitTools,
    client
  );
  const runner = new AgentRunner(
    workspaceTools,
    undefined,
    validationTools,
    semanticTools,
    gitTools,
    undefined,
    readonlyRunner
  );
  const previousApiKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = 'test-key';
  try {
    const statuses: string[] = [];
    const response = await runner.run({
      prompt: '只规划，不要执行。',
      model: {
        id: 'deepseek-v4-flash',
        label: 'DeepSeek-V4-Flash',
        provider: 'deepseek',
        contextWindowTokens: 1_000_000
      },
      settings: {
        thinkingEnabled: true,
        reasoningEffort: 'high',
        compressionThreshold: 'balanced',
        plannerModelId: 'deepseek-v4-pro',
        plannerMode: 'explicit'
      },
      contextFiles: [],
      history: [{
        id: 'user-1',
        role: 'user',
        content: '只规划，不要执行。',
        createdAt: '2026-01-01T00:00:00.000Z'
      }],
      language: 'zh-CN'
    }, {
      onStatus: (status) => statuses.push(status.phase)
    });
    assert.match(response.message, /规划模型运行失败：planner unavailable/u);
    assert.deepEqual(response.draftEdits, []);
    assert.equal(response.plannerPlan, undefined);
    assert.ok(statuses.includes('planning'));
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY;
    } else {
      process.env.DEEPSEEK_API_KEY = previousApiKey;
    }
  }
});

test('review failure degrades to no review result', async () => {
  const result = await runReviewBestEffort(async () => {
    throw new Error('review unavailable');
  });
  assert.equal(result, undefined);
});

test('subagent scheduler queues regular work and rejects nested acquisition when saturated', async () => {
  const scheduler = new SubagentScheduler(1);
  let releaseFirst: (() => void) | undefined;
  const first = scheduler.run(async () => {
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    return 'first';
  });
  await Promise.resolve();
  assert.equal(scheduler.getActiveCount(), 1);
  await assert.rejects(
    scheduler.run(async () => 'nested', { nested: true }),
    /Nested subagent acquisition/u
  );
  const second = scheduler.run(async () => 'second');
  await Promise.resolve();
  releaseFirst?.();
  assert.equal(await first, 'first');
  assert.equal(await second, 'second');
  assert.equal(scheduler.getActiveCount(), 0);
});

function createClientConfig(): DeepSeekClientConfig {
  return {
    apiKey: 'test',
    baseUrl: 'https://example.test',
    streamIdleTimeoutMs: 0,
    maxRequestRetries: 0,
    requestRetryBaseMs: 0
  };
}
