import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT,
  GoalDraftGeneratorService,
  parseGoalDraftSuggestion
} from '../src/agent/goals/goalDraftGenerator';

const validDraft = {
  version: 1,
  acceptanceCriteria: [
    { text: '界面可以创建 Goal', type: 'workspace_state', evidenceRequirement: '当前界面状态证据' },
    { text: '测试通过', type: 'validation', evidenceRequirement: '最后修改后的测试结果' }
  ],
  includeScope: ['./src/webview', '/absolute/rejected', '../escape'],
  excludeScope: ['out', 'file:///tmp/rejected'],
  requiredValidations: ['compile', 'test', 'unknown']
};

test('Goal draft generator strictly parses criteria and filters unsafe scope and unavailable validations', () => {
  const parsed = parseGoalDraftSuggestion(JSON.stringify(validDraft), ['compile']);
  assert.deepEqual(parsed.acceptanceCriteria.map((item) => item.type), ['workspace_state', 'validation']);
  assert.deepEqual(parsed.includeScope, ['src/webview']);
  assert.deepEqual(parsed.excludeScope, ['out']);
  assert.deepEqual(parsed.requiredValidations, ['compile']);
  assert.match(GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT, /does not authorize or perform any action/u);
});

test('Goal draft generator rejects malformed and incomplete responses', () => {
  for (const value of [
    'not json',
    JSON.stringify({ version: 1, acceptanceCriteria: [] }),
    JSON.stringify({ ...validDraft, extra: true }),
    JSON.stringify({ version: 1, acceptanceCriteria: [{ text: 'x', type: 'invalid', evidenceRequirement: 'e' }] }),
    JSON.stringify({ version: 1, acceptanceCriteria: [{ text: 'x', type: 'manual' }] })
  ]) {
    assert.throws(() => parseGoalDraftSuggestion(value, ['compile', 'lint', 'test']), /Goal draft generator/u);
  }
});

test('Goal draft generation is tool-free, cancelable, and reports usage as subagent work', async () => {
  let seen: { systemPrompt: string; userPrompt: string; maxOutputTokens?: number } | undefined;
  const service = new GoalDraftGeneratorService(async (input) => {
    seen = input;
    input.onUsage?.({
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, cacheHitTokens: 0, cacheMissTokens: 1 },
      cost: 0, currency: '', modelId: input.model.id, source: 'reviewer'
    });
    return JSON.stringify(validDraft);
  });
  let usageSource = '';
  const parsed = await service.generate({
    objective: '实现持久 Goal',
    availableValidations: ['compile', 'test'],
    model: { id: 'subagent', label: 'Subagent', provider: 'openai-compatible', sourceId: 'source' },
    sourceConfig: { sourceId: 'source', provider: 'openai-compatible', apiKey: 'key', baseUrl: 'https://example.test', supportsBilling: false },
    language: 'zh-CN',
    onUsage: (event) => { usageSource = event.source; }
  });
  assert.equal(parsed.acceptanceCriteria.length, 2);
  assert.equal(usageSource, 'subagent');
  assert.equal(seen?.systemPrompt, GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT);
  assert.equal(seen?.maxOutputTokens, 1_200);
  assert.doesNotMatch(seen?.userPrompt ?? '', /tools/u);
});

test('Goal draft generation forwards cancellation to the isolated model request', async () => {
  const controller = new AbortController();
  const service = new GoalDraftGeneratorService(async (input) => await new Promise<string>((_resolve, reject) => {
    input.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  }));
  const pending = service.generate({
    objective: '目标', availableValidations: [],
    model: { id: 'subagent', label: 'Subagent', provider: 'openai-compatible', sourceId: 'source' },
    sourceConfig: { sourceId: 'source', provider: 'openai-compatible', apiKey: 'key', baseUrl: 'https://example.test', supportsBilling: false },
    language: 'zh-CN', signal: controller.signal
  });
  controller.abort();
  await assert.rejects(pending, /cancelled/u);
});
