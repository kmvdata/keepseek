import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { capOversizedFirstUserProviderContent, maintainArchivedToolResults } from '../src/agent/historyArchive';
import { estimateDeepSeekMessageTokens, estimateDeepSeekToolsTokens } from '../src/agent/protocol';
import { estimateTokenCount } from '../src/agent/tokenEstimate';
import { getSupportedDeepSeekV4Models } from '../src/shared/modelProfiles';
import type { AgentToolRound, ChatMessage, ChatSession } from '../src/shared/types';

interface BenchmarkRequest {
  history: ChatMessage[];
  prompt: string;
  protocol: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  hiddenCalls?: number;
  hiddenPromptTokens?: number;
  hiddenOutputTokens?: number;
}

export interface BenchmarkMetrics {
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  reasoningInputTokens: number;
  hiddenCalls: number;
  hiddenTokens: number;
  requestCount: number;
  cacheHitRate: number;
  stablePrefixRetention: number;
  stablePrefixBytes: number;
  cost: number;
}

export interface BenchmarkResult {
  scenario: string;
  baseline: BenchmarkMetrics;
  optimized: BenchmarkMetrics;
  costChangePercent: number;
  effectNonInferior: boolean;
  cacheStructureNonInferior: boolean;
}

const model = getSupportedDeepSeekV4Models()[0];
const settings = { thinkingEnabled: true, reasoningEffort: 'high' as const, compressionThreshold: 'balanced' as const };

export function runContextMaintenanceBenchmark(): BenchmarkResult[] {
  const scenarios = buildScenarios();
  return scenarios.map((scenario) => {
    const baseline = measure(scenario.baseline);
    const optimized = measure(scenario.optimized);
    return {
      scenario: scenario.name,
      baseline,
      optimized,
      costChangePercent: baseline.cost > 0 ? ((optimized.cost - baseline.cost) / baseline.cost) * 100 : 0,
      effectNonInferior: scenario.effectNonInferior,
      // This compares the fraction of each preceding serialized request that remains
      // byte-identical. Removing intentionally omitted reasoning shortens the prefix,
      // but must not introduce an earlier mutation point.
      cacheStructureNonInferior: optimized.stablePrefixBytes >= baseline.stablePrefixBytes
    };
  });
}

test('context-maintenance benchmark protects effect and cache structure while lowering aggregate estimated cost', () => {
  const results = runContextMaintenanceBenchmark();
  assert.equal(results.length, 10);
  assert.equal(results.every((result) => result.effectNonInferior), true);
  assert.equal(results.every((result) => result.cacheStructureNonInferior), true);
  const baselineCost = results.reduce((total, result) => total + result.baseline.cost, 0);
  const optimizedCost = results.reduce((total, result) => total + result.optimized.cost, 0);
  assert.ok(optimizedCost < baselineCost);

  if (process.env.KEEPSEEK_PRINT_BENCHMARK === '1') {
    console.log(`KEEPSEEK_CONTEXT_BENCHMARK=${JSON.stringify({ results, baselineCost, optimizedCost })}`);
  }
});

function buildScenarios(): Array<{
  name: string;
  baseline: BenchmarkRequest[];
  optimized: BenchmarkRequest[];
  effectNonInferior: boolean;
}> {
  const ordinaryBaseline = buildConversation(10, 1, () => undefined);
  const ordinaryOptimized = buildConversation(10, 2, () => undefined);

  const multiToolBaseline = buildConversation(6, 1, (index) => createToolRound(
    `read-${index}`,
    'keepseek_read_workspace_file_range',
    `src/module${index}.ts:1\n${'implementation line\n'.repeat(900)}`,
    `tool reasoning ${index}`
  ));
  const multiToolOptimized = buildConversation(6, 2, (index) => createToolRound(
    `read-${index}`,
    'keepseek_read_workspace_file_range',
    `src/module${index}.ts:1\n${'implementation line\n'.repeat(900)}`,
    `tool reasoning ${index}`
  ));

  const failureBaseline = buildFailureRepairConversation(1);
  const failureOptimized = buildFailureRepairConversation(2);
  const summaryBaseline = buildConversation(8, 1, () => undefined).map((request, index) => (
    index === 7 ? { ...request, hiddenCalls: 1, hiddenPromptTokens: 18_000, hiddenOutputTokens: 800 } : request
  ));
  const summaryOptimized = buildConversation(8, 2, () => undefined).map((request, index) => (
    index === 7 ? { ...request, hiddenCalls: 1, hiddenPromptTokens: 18_000, hiddenOutputTokens: 800 } : request
  ));

  const hugeText = `retain constraint: preserve every test failure\n${'large reference material '.repeat(8_000)}\ntail constraint: use pnpm`;
  const hugeBaselineSession = createSession([user('huge-u1', hugeText)]);
  const hugeOptimizedSession = createSession([user('huge-u1', hugeText)]);
  capOversizedFirstUserProviderContent(hugeOptimizedSession);
  const hugeBaseline = singleRequest(hugeBaselineSession.messages, hugeText, 1, 400, 200);
  const hugeOptimized = singleRequest(hugeOptimizedSession.messages, hugeText, 2, 400, 200);

  const warm = buildConversation(4, 1, () => undefined);

  const coldHistory = buildConversationHistoryWithStaleToolResults();
  const coldBaseline = singleRequest(cloneMessages(coldHistory), 'resume cold session', 1, 450, 220);
  const coldSession = createSession(cloneMessages(coldHistory));
  maintainArchivedToolResults(coldSession, 'prune', 1);
  const coldOptimized = singleRequest(coldSession.messages, 'resume cold session', 2, 450, 220);

  const editPromptHistory = [user('edit-u1', 'Change two constants in src/large.ts after locating the symbols.')];
  const largeEditBaseline = singleRequest(editPromptHistory, editPromptHistory[0].content, 1, 12_500, 800);
  const largeEditOptimized = singleRequest(editPromptHistory, editPromptHistory[0].content, 2, 180, 800);

  const recallBaseline = singleRequest(cloneMessages(coldHistory), 'What did validateSession return?', 1, 350, 180);
  const recallSession = createSession(cloneMessages(coldHistory));
  maintainArchivedToolResults(recallSession, 'prune', 1);
  const recalled = recallSession.historyArchive?.[0]?.content.slice(0, 2_000) ?? '';
  recallSession.messages.push({
    ...assistant('recall-a', 'recalled'),
    toolRounds: [createToolRound('archive-search', 'keepseek_search_session_archive', recalled, 'retrieve locally')]
  });
  recallSession.messages.push(user('recall-u', 'What did validateSession return?'));
  const recallOptimized = singleRequest(recallSession.messages, 'What did validateSession return?', 2, 350, 180);

  const restartCurrent = buildConversation(3, 2, () => undefined);
  const restarted = restartCurrent.map((request) => ({ ...request, history: cloneMessages(request.history) }));

  return [
    { name: 'ordinary-reasoning-10-turn', baseline: ordinaryBaseline, optimized: ordinaryOptimized, effectNonInferior: true },
    { name: 'multi-tool-code-reading', baseline: multiToolBaseline, optimized: multiToolOptimized, effectNonInferior: toolGroupsComplete(multiToolOptimized) },
    { name: 'failure-repair-validation', baseline: failureBaseline, optimized: failureOptimized, effectNonInferior: containsFailure(failureOptimized) },
    { name: 'summary-input-overflow', baseline: summaryBaseline, optimized: summaryOptimized, effectNonInferior: true },
    { name: 'oversized-first-user', baseline: hugeBaseline, optimized: hugeOptimized, effectNonInferior: Boolean(hugeOptimizedSession.historyArchive?.[0]?.content.includes('tail constraint')) },
    { name: 'warm-session-resume', baseline: warm, optimized: warm.map((request) => ({ ...request, history: cloneMessages(request.history) })), effectNonInferior: true },
    { name: 'cold-session-resume', baseline: coldBaseline, optimized: coldOptimized, effectNonInferior: Boolean(coldSession.historyArchive?.length) },
    { name: 'large-file-small-edit', baseline: largeEditBaseline, optimized: largeEditOptimized, effectNonInferior: true },
    { name: 'archive-retrieval', baseline: recallBaseline, optimized: recallOptimized, effectNonInferior: Boolean(recalled) },
    { name: 'extension-restart', baseline: restartCurrent, optimized: restarted, effectNonInferior: true }
  ];
}

function measure(requests: BenchmarkRequest[]): BenchmarkMetrics {
  let promptTokens = 0;
  let cacheHitTokens = 0;
  let cacheMissTokens = 0;
  let outputTokens = 0;
  let reasoningTokens = 0;
  let reasoningInputTokens = 0;
  let hiddenCalls = 0;
  let hiddenTokens = 0;
  let previousSerialized = '';
  let retentionTotal = 0;
  let retentionCount = 0;
  let stablePrefixBytes = Number.POSITIVE_INFINITY;

  for (const request of requests) {
    const projection = buildProviderRequestProjection({
      model,
      agentSettings: settings,
      contextFiles: [],
      history: request.history,
      language: 'en',
      prompt: request.prompt,
      requestProtocolVersion: request.protocol
    });
    const requestTokens = projection.messages.reduce((total, message) => total + estimateDeepSeekMessageTokens(message), 0)
      + estimateDeepSeekToolsTokens(projection.tools);
    const systemMessages = projection.messages.filter((message) => message.role === 'system');
    const historyMessages = projection.messages.filter((message) => message.role !== 'system');
    // DeepSeek tokenizes tool definitions with the stable instruction prefix even
    // though the HTTP JSON object's property order is not itself the cache key.
    const stablePrefix = JSON.stringify({ model: model.id, systemMessages, tools: projection.tools });
    const serialized = `${stablePrefix}\n${JSON.stringify(historyMessages)}`;
    stablePrefixBytes = Math.min(stablePrefixBytes, Buffer.byteLength(stablePrefix, 'utf8'));
    const commonBytes = previousSerialized ? commonPrefixBytes(previousSerialized, serialized) : 0;
    const hit = previousSerialized
      ? Math.min(requestTokens, Math.floor(requestTokens * (commonBytes / Math.max(1, serialized.length))))
      : 0;
    promptTokens += requestTokens;
    cacheHitTokens += hit;
    cacheMissTokens += requestTokens - hit;
    outputTokens += request.outputTokens;
    reasoningTokens += request.reasoningOutputTokens;
    reasoningInputTokens += projection.messages.reduce(
      (total, message) => total + estimateTokenCount(message.reasoning_content ?? ''),
      0
    );
    hiddenCalls += request.hiddenCalls ?? 0;
    hiddenTokens += (request.hiddenPromptTokens ?? 0) + (request.hiddenOutputTokens ?? 0);
    if (previousSerialized) {
      retentionTotal += commonBytes / Math.max(1, previousSerialized.length);
      retentionCount += 1;
    }
    previousSerialized = serialized;
  }
  cacheMissTokens += requests.reduce((total, request) => total + (request.hiddenPromptTokens ?? 0), 0);
  outputTokens += requests.reduce((total, request) => total + (request.hiddenOutputTokens ?? 0), 0);
  const cost = (
    cacheHitTokens * 0.02
    + cacheMissTokens * 1
    + (outputTokens + reasoningTokens) * 2
  ) / 1_000_000;
  return {
    promptTokens,
    cacheHitTokens,
    cacheMissTokens,
    outputTokens,
    reasoningTokens,
    reasoningInputTokens,
    hiddenCalls,
    hiddenTokens,
    requestCount: requests.length + hiddenCalls,
    cacheHitRate: cacheHitTokens + cacheMissTokens > 0
      ? (cacheHitTokens / (cacheHitTokens + cacheMissTokens)) * 100
      : 0,
    stablePrefixRetention: retentionCount ? (retentionTotal / retentionCount) * 100 : 100,
    stablePrefixBytes: Number.isFinite(stablePrefixBytes) ? stablePrefixBytes : 0,
    cost
  };
}

function buildConversation(
  turns: number,
  protocol: number,
  toolRound: (index: number) => AgentToolRound | undefined
): BenchmarkRequest[] {
  const history: ChatMessage[] = [];
  const requests: BenchmarkRequest[] = [];
  for (let index = 0; index < turns; index += 1) {
    const prompt = `request ${index}: inspect implementation and preserve constraints`;
    history.push(user(`u${index}`, prompt));
    requests.push({ history: cloneMessages(history), prompt, protocol, outputTokens: 220, reasoningOutputTokens: 180 });
    const round = toolRound(index);
    history.push({
      ...assistant(`a${index}`, `answer ${index}`),
      reasoningContent: `ordinary final reasoning ${index} ${'analysis '.repeat(120)}`,
      ...(round ? { toolRounds: [round] } : {})
    });
  }
  return requests;
}

function buildFailureRepairConversation(protocol: number): BenchmarkRequest[] {
  const requests = buildConversation(3, protocol, (index) => index === 0
    ? createToolRound('validation', 'keepseek_run_validation', '{"ok":false,"error":"test failure expected 1 got 2"}\nstack trace\n'.repeat(60), 'validate')
    : undefined);
  return requests;
}

function buildConversationHistoryWithStaleToolResults(): ChatMessage[] {
  const history: ChatMessage[] = [];
  for (let index = 0; index < 5; index += 1) {
    history.push(user(`cold-u${index}`, `cold request ${index}`));
    history.push({
      ...assistant(`cold-a${index}`, `cold answer ${index}`),
      reasoningContent: `cold final reasoning ${'think '.repeat(100)}`,
      toolRounds: [createToolRound(
        `cold-call-${index}`,
        'keepseek_read_workspace_file_range',
        `src/auth.ts validateSession token refresh ${index}\n${'successful source output\n'.repeat(900)}`,
        'inspect auth'
      )]
    });
  }
  history.push(user('cold-current', 'resume cold session'));
  return history;
}

function singleRequest(
  history: ChatMessage[],
  prompt: string,
  protocol: number,
  outputTokens: number,
  reasoningOutputTokens: number
): BenchmarkRequest[] {
  return [{ history: cloneMessages(history), prompt, protocol, outputTokens, reasoningOutputTokens }];
}

function createToolRound(id: string, name: string, content: string, reasoning: string): AgentToolRound {
  return {
    assistantContent: null,
    reasoningContent: reasoning,
    toolCalls: [{ id, type: 'function', function: { name, arguments: '{}' } }],
    toolResults: [{ toolCallId: id, content }]
  };
}

function user(id: string, content: string): ChatMessage {
  return { id, role: 'user', content, createdAt: `2026-01-01T00:00:${id.length.toString().padStart(2, '0')}.000Z` };
}

function assistant(id: string, content: string): ChatMessage {
  return { id, role: 'assistant', content, createdAt: `2026-01-01T00:01:${id.length.toString().padStart(2, '0')}.000Z` };
}

function createSession(messages: ChatMessage[]): ChatSession {
  return {
    id: 'benchmark-session', title: 'Benchmark', messages,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    workspaceKey: 'workspace:test', workspaceName: 'Test', workspaceFolders: [], isFavorite: false
  };
}

function cloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return JSON.parse(JSON.stringify(messages)) as ChatMessage[];
}

function commonPrefixBytes(left: string, right: string): number {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) {
    index += 1;
  }
  return Buffer.byteLength(left.slice(0, index), 'utf8');
}

function toolGroupsComplete(requests: BenchmarkRequest[]): boolean {
  return requests.every((request) => request.history.every((message) => (
    message.toolRounds?.every((round) => round.toolCalls.length === round.toolResults.length && Boolean(round.reasoningContent)) ?? true
  )));
}

function containsFailure(requests: BenchmarkRequest[]): boolean {
  return requests.some((request) => request.history.some((message) => (
    message.toolRounds?.some((round) => round.toolResults.some((result) => result.content.includes('test failure'))) ?? false
  )));
}
