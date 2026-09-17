import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT,
  createConservativeGoalProposal,
  createGoalProposalDecision,
  GoalDraftGeneratorService,
  parseGoalDraftSuggestion,
  verifyGoalProposal
} from '../src/agent/goals/goalDraftGenerator';

const validDraft = {
  version: 1,
  objective: '实现持久 Goal',
  workItems: [
    {
      id: 'work-ui', title: '审阅界面', detail: '用户可以逐项选择候选工作项。', dependsOn: [],
      acceptanceCriteria: [{ id: 'criterion-ui', text: '界面可以审阅 Goal', type: 'workspace_state', evidenceRequirement: '当前界面状态证据' }]
    },
    {
      id: 'work-tests', title: '回归测试', detail: '验证实现保持安全边界。', dependsOn: ['work-ui'],
      acceptanceCriteria: [{ id: 'criterion-tests', text: '测试通过', type: 'validation', evidenceRequirement: '最后修改后的测试结果' }]
    }
  ],
  includeScope: ['./src/webview'],
  excludeScope: ['out'],
  requiredValidations: ['compile']
};

test('Goal proposal generator strictly parses work items, dependencies, scope, and hashes', () => {
  const parsed = parseGoalDraftSuggestion(JSON.stringify(validDraft), ['compile'], validDraft.objective);
  assert.deepEqual(parsed.workItems.map((item) => item.id), ['work-ui', 'work-tests']);
  assert.deepEqual(parsed.workItems[1]?.dependsOn, ['work-ui']);
  assert.deepEqual(parsed.includeScope, ['src/webview']);
  assert.deepEqual(parsed.requiredValidations, ['compile']);
  assert.equal(verifyGoalProposal(parsed), true);
  assert.match(GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT, /does not create a Goal/u);
  assert.match(GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT, /4-8/u);
});

test('Goal proposal parser rejects malformed JSON, unknown fields, duplicates, unsafe paths, and invalid dependencies', () => {
  const invalidValues = [
    'not json',
    JSON.stringify({ ...validDraft, extra: true }),
    JSON.stringify({ ...validDraft, workItems: [] }),
    JSON.stringify({ ...validDraft, workItems: [...validDraft.workItems, { ...validDraft.workItems[0] }] }),
    JSON.stringify({ ...validDraft, workItems: validDraft.workItems.map((item, index) => index ? { ...item, dependsOn: ['missing'] } : item) }),
    JSON.stringify({ ...validDraft, workItems: validDraft.workItems.map((item, index) => ({
      ...item, dependsOn: [index ? 'work-ui' : 'work-tests']
    })) }),
    JSON.stringify({ ...validDraft, includeScope: ['/Users/alice/private'] }),
    JSON.stringify({ ...validDraft, includeScope: ['x'.repeat(513)] }),
    JSON.stringify({ ...validDraft, workItems: validDraft.workItems.map((item, index) => index ? item : { ...item, detail: 'Read file:///tmp/private' }) }),
    JSON.stringify({ ...validDraft, workItems: validDraft.workItems.map((item, index) => index ? item : { ...item, detail: 'Created at 2026-09-17T01:02:03Z' }) }),
    JSON.stringify({ ...validDraft, workItems: validDraft.workItems.map((item, index) => index ? item : { ...item, id: '550e8400-e29b-41d4-a716-446655440000' }) }),
    JSON.stringify({ ...validDraft, requiredValidations: ['test'] }),
    JSON.stringify({ ...validDraft, workItems: Array.from({ length: 21 }, (_, index) => ({
      id: `work-${index}`, title: `Work ${index}`, detail: 'bounded', dependsOn: [],
      acceptanceCriteria: [{ id: `criterion-${index}`, text: 'done', type: 'workspace_state', evidenceRequirement: 'evidence' }]
    })) })
  ];
  for (const value of invalidValues) {
    assert.throws(() => parseGoalDraftSuggestion(value, ['compile'], validDraft.objective), /Goal/u);
  }
});

test('Goal proposal allows exactly twenty bounded work items and decision preserves selected/unselected audit', () => {
  const proposal = parseGoalDraftSuggestion(JSON.stringify({
    ...validDraft,
    workItems: Array.from({ length: 20 }, (_, index) => ({
      id: `work-${index}`, title: `Work ${index}`, detail: 'bounded', dependsOn: [],
      acceptanceCriteria: [{ id: `criterion-${index}`, text: 'done', type: 'workspace_state', evidenceRequirement: 'evidence' }]
    }))
  }), ['compile'], validDraft.objective);
  const decision = createGoalProposalDecision(proposal, ['work-0', 'work-2'], '2026-01-01T00:00:00.000Z');
  assert.equal(decision.decisions.filter((item) => item.selection === 'selected').length, 2);
  assert.equal(decision.decisions.filter((item) => item.selection === 'unselected').length, 18);
  assert.throws(() => createGoalProposalDecision(proposal, []), /At least one/u);
});

test('Goal proposal selection requires selected dependencies', () => {
  const proposal = parseGoalDraftSuggestion(JSON.stringify(validDraft), ['compile'], validDraft.objective);
  assert.throws(() => createGoalProposalDecision(proposal, ['work-tests']), /requires work-ui/u);
  assert.doesNotThrow(() => createGoalProposalDecision(proposal, ['work-ui', 'work-tests']));
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
    objective: validDraft.objective,
    availableValidations: ['compile', 'test'],
    model: { id: 'subagent', label: 'Subagent', provider: 'openai-compatible', sourceId: 'source' },
    sourceConfig: { sourceId: 'source', provider: 'openai-compatible', apiKey: 'key', baseUrl: 'https://example.test', supportsBilling: false },
    language: 'zh-CN',
    onUsage: (event) => { usageSource = event.source; }
  });
  assert.equal(parsed.workItems.length, 2);
  assert.equal(usageSource, 'subagent');
  assert.equal(seen?.systemPrompt, GOAL_DRAFT_GENERATOR_SYSTEM_PROMPT);
  assert.equal(seen?.maxOutputTokens, 4_000);
  assert.doesNotMatch(seen?.userPrompt ?? '', /tools/u);
});

test('Goal draft cancellation and conservative fallback remain available without creating a Goal', async () => {
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
  const fallback = createConservativeGoalProposal({ objective: '目标', language: 'zh-CN', validation: 'compile' });
  assert.equal(fallback.workItems.length, 1);
  assert.deepEqual(fallback.requiredValidations, ['compile']);
  assert.equal(verifyGoalProposal(fallback), true);
});
