import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { createEpochSeed } from '../src/agent/contextEpoch';
import { AgentRunner } from '../src/agent/runner';
import { checkpointCopy, createRunCheckpoint, recoveryBlocker, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { buildPlanHandoffPrompt } from '../src/agent/handoffPrompt';
import { estimateTokenCount } from '../src/agent/tokenEstimate';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { ProjectQueueService } from '../src/sessions/queue/queueService';
import type { AgentRequest, AgentResponse } from '../src/shared/types';
import * as vscode from './stubs/vscode';

interface ProbeHost {
  initializeAfterWebviewReady(): Promise<void>;
  handleMessage(message: unknown): Promise<void>;
  views: Set<unknown>;
  language: 'zh-CN' | 'en';
  agentRunner: AgentRunner;
  interactionSnapshot(revision: number): unknown;
}
const readFileTool = 'keepseek_read_workspace_file_range';
const evidenceTool = 'keepseek_read_evidence';
const draftTool = 'keepseek_create_draft_edit';
type ToolCall = { name: string; args: Record<string, unknown> };
type Payload = { tool_choice?: string; tools: Array<{ function: { name: string } }>; messages: Array<{ role: string; content?: string | null; tool_call_id?: string }> };
interface Sample { payload: Payload; answer: string | ToolCall; estimatedTokens: number }
function fakeStream(answer: string | ToolCall, id: string): Response {
  const delta = typeof answer === 'string' ? { role: 'assistant', content: answer } : {
    role: 'assistant', tool_calls: [{ index: 0, id, type: 'function', function: { name: answer.name, arguments: JSON.stringify(answer.args) } }]
  };
  const choice = { choices: [{ index: 0, delta, finish_reason: typeof answer === 'string' ? 'stop' : 'tool_calls' }] };
  return new Response('data: ' + JSON.stringify(choice) + '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } });
}

interface RunCapture { request: AgentRequest; checkpoint?: RunCheckpoint; response?: AgentResponse; firstDraftAt?: number }
async function startProbe(t: TestContext, count: number) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'keepseek-epoch-probe-')));
  const project = path.join(root, 'fixture');
  await mkdir(project);
  const fixture = vscode.Uri.file(project);
  const values = Array.from({ length: count }, (_, i) => ({ file: 'source' + i + '.ts', symbol: 'probeValue' + i, value: 73 + i * 11 }));
  for (const item of values) await writeFile(path.join(project, item.file), 'export const ' + item.symbol + ' = ' + item.value + ';\n');
  const uri = vscode.Uri.file(path.join(root, 'state'));
  const originalFolders = vscode.workspace.workspaceFolders;
  const prevWindow = { ...vscode.window };
  const originalAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  vscode.workspace.workspaceFolders = [{ uri: fixture, name: 'fixture' }];
  const notices: string[] = [];
  Object.assign(vscode, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async (s: string) => { notices.push(s); },
    showErrorMessage: async (s: string) => { notices.push(s); }
  });
  const storage = new GlobalSessionStorage(uri as never);
  const scope = { key: 'folders:' + fixture.toString(), name: 'fixture', folderUris: [fixture.toString()] };
  const queue = new ProjectQueueService(key => storage.getProjectQueueUri(key));
  const store = new ChatSessionStore(storage, 'en', scope, queue);
  const initialization = store.initialize({ fresh: true });
  await initialization;
  await new ModelSourceStore(uri as never).createSource({ id: 'probe', provider: 'openai-compatible',
    name: 'probe', apiKey: 'local-fixture', baseUrl: 'https://probe.invalid/v1', models: [{ id: 'probe-model', contextWindowTokens: 128000, maxOutputTokens: 8192 }] });
  // Simulate an existing queue member. It performs no operation during the probe.
  store.getActiveSession().messages.push({ role: 'user', id: 'prior-member', content: 'Queue member', createdAt: new Date().toISOString() });
  await store.persist();
  const source = await store.createNewSession();
  source.customTitle = 'Probe'; // Exclude asynchronous title traffic from the model experiment.
  const provider = new KeepseekChatViewProvider(vscode.Uri.file(process.cwd()) as never, store, uri as never,
    { keys: () => [], get: (_k: string, fallback: unknown) => fallback, update: async () => undefined } as never,
    { displayName: 'KeepSeek', version: 'probe', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' }, initialization);
  const host = provider as unknown as ProbeHost;
  const posts: Array<Record<string, unknown>> = [];
  host.views.add({ webview: { postMessage: async (event: Record<string, unknown>) => { posts.push(event); return true; } } });
  const captures: RunCapture[] = [];
  const originalRun = host.agentRunner.run.bind(host.agentRunner);
  t.mock.method(host.agentRunner, 'run', async (request: AgentRequest, callbacks: Parameters<AgentRunner['run']>[1] = {}) => {
    const capture: RunCapture = { request };
    captures.push(capture);
    const response = await originalRun(request, { ...callbacks, onCheckpoint: async cp => {
      capture.checkpoint = cp;
      if (cp.state?.draftEdits.length && capture.firstDraftAt === undefined) capture.firstDraftAt = performance.now();
      await callbacks.onCheckpoint?.(cp);
    } });
    capture.response = response;
    return response;
  });
  let phase: 'plan' | 'execute' = 'plan';
  let evidenceToRead: string | undefined;
  const samples: Sample[] = [];
  let draftIssued = false;
  let serial = 0;
  let planText = '';
  const wire = t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(String(url), 'https://probe.invalid/v1/chat/completions');
    const payload = JSON.parse(String(init.body)) as Payload;
    if (!payload.tools?.length) return fakeStream('Probe title', 'aux');
    if (payload.tool_choice === 'none') return fakeStream('Planning reads complete. Retrieve the recorded evidence in this task before preparing the draft.', 'summary');
    if (++serial > 32) return new Response('unexpected probe loop', { status: 400 });
    const visible = payload.messages.map(m => m.content).join('\n');
    const missing = values.find(item => !visible.includes(item.symbol + ' = ' + item.value + ';'));
    let answer: string | ToolCall;
    if (phase === 'execute' && evidenceToRead) {
      answer = { name: evidenceTool, args: { evidenceRef: evidenceToRead, maxChars: 600 } };
      evidenceToRead = undefined;
    } else if (missing && !draftIssued) {
      answer = { name: readFileTool, args: { path: missing.file, startLine: 1, endLine: 2 } };
    } else if (phase === 'plan') {
      answer = planText;
    } else if (!draftIssued) {
      answer = { name: draftTool, args: { path: 'total.ts', content: 'export const total = ' + values.reduce((sum, i) => sum + i.value, 0) + ';\n', reason: 'Record the verified total.' } };
      draftIssued = true;
    } else {
      answer = 'Prepared total.ts for review.';
    }
    samples.push({ payload, answer, estimatedTokens: estimateTokenCount(JSON.stringify({ messages: payload.messages, tools: payload.tools })) });
    return fakeStream(answer, 'probe-' + serial);
  });
  t.after(async () => {
    provider.dispose(); store.dispose(); wire.mock.restore();
    vscode.workspace.workspaceFolders = originalFolders;
    Object.assign(vscode.window, prevWindow);
    Object.assign(vscode, { StatusBarAlignment: originalAlignment });
    await storage.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  });
  await host.initializeAfterWebviewReady();
  planText = '1. Prepare total.ts\n   - Compute the sum of ' + values.map(v => v.symbol + ' in ' + v.file).join(', ') +
    '.\n2. Verify the draft\n   - Export a constant named total and leave the source files intact.';
  const goal = 'Create total.ts exporting the sum of ' + values.map(v => v.symbol + ' in ' + v.file).join(', ') +
    '. Read the inputs first. Deliver a reviewed draft.';
  await host.handleMessage({ type: 'sendPrompt', sessionId: source.id, requestId: 'plan', sourceId: 'probe', modelId: 'probe-model', prompt: goal });
  const plan = source.planWorkflows?.at(-1);
  assert.ok(plan && plan.status === 'pending', JSON.stringify({ tail: source.messages.at(-1)?.content, notices, submissions: posts.filter(p => p.type === 'submissionResult'), calls: samples.length, state: host.interactionSnapshot(1) }));
  const planning = captures[0];
  assert.ok(planning.checkpoint?.state?.epoch?.evidenceRefs.length);
  const evidence = planning.checkpoint.state.epoch.evidenceRefs.find(r => r.toolName === readFileTool)!;
  assert.ok(evidence);
  return { host, store, source, plan, samples, captures, planning, evidence, notices, posts, uri, goal, planText,
    startExecution(withEvidenceRead: boolean) { phase = 'execute'; evidenceToRead = withEvidenceRead ? evidence.evidenceRef : undefined; draftIssued = false; } };
}

test('plan card starts a new evidence task in the same session; an isolated epoch experiment keeps scope', async t => {
  const h = await startProbe(t, 1);
  const planCp = h.planning.checkpoint!;
  h.startExecution(true);
  const offset = h.samples.length;
  await h.host.handleMessage({ type: 'resolvePlanDecision', planId: h.plan.id, action: 'start_execution' });
  const execution = h.captures[1];
  assert.ok(execution?.checkpoint, JSON.stringify(h.notices));
  assert.equal(execution.request.sessionId, h.source.id);
  assert.notEqual(execution.checkpoint.taskId, planCp.taskId);
  assert.equal(execution.request.approvalRootTaskId, h.planning.request.approvalRootTaskId);
  const toolReply = h.samples[offset + 1].payload.messages.at(-1)?.content ?? '';
  assert.ok(/scope|unavailable|not_found|not found|不可用|不存在/i.test(toolReply), toolReply);
  assert.equal(execution.response?.draftEdits.length, 1);
  t.diagnostic(JSON.stringify({ sourceSession: h.source.id, planTask: planCp.taskId, executionTask: execution.checkpoint.taskId,
    approvalRootTask: execution.request.approvalRootTaskId, evidenceRef: h.evidence.evidenceRef,
    currentEvidence: toolReply, executionTools: h.samples[offset].payload.tools.map(x => x.function.name) }));
  assert.equal(h.plan.status, 'approved');
  // Model an explicit new-segment receipt in the experiment only. Ordinary recovery
  // must reject the completed plan. The released product has no epoch button.
  assert.match(recoveryBlocker(planCp) ?? '', /already completed/i);
  assert.ok(!planCp.state?.pending?.executing && !planCp.state?.pending?.response.message.tool_calls?.length);
  assert.equal(planCp.state?.draftEdits.length, 0);
  const segment = checkpointCopy(planCp);
  const confirmation = execution.request.history.at(-1)!;
  assert.equal(confirmation.role, 'user');
  const request: AgentRequest = { ...execution.request, preparedTaskBudget: undefined, taskCostBudget: undefined,
    taskRunBudget: undefined, taskClock: undefined, history: [confirmation], signal: undefined, checkpoint: segment };
  // The prototype takes a verified normal-phase request after the actual click.
  // Preserve the task/evidence key, accounts, cost and counters; switch only the
  // projection/receipt. No old tool output or approval is inserted in the user's history.
  const fresh = createRunCheckpoint(request, segment.maxExecutionMs, segment.limitSource, segment.workspaceFolders, segment.maxCost);
  segment.request = fresh.request;
  segment.status = 'interrupted'; delete segment.stopReason; delete segment.finalResponse;
  const state = segment.state!;
  const historicRoundIds = state.toolRounds.flatMap(r => r.toolCalls.map(c => c.id));
  state.toolRounds = []; delete state.completedReplay; delete state.pending;
  // Recovery at the durable start of summarization uses the real archive and seed writer.
  state.epoch!.status = 'summarizing';
  state.epoch!.pendingRollover = { reason: 'soft_context_pressure' };
  const historicalSchema = segment.toolSchemaHash;
  const restart = () => new AgentRunner(undefined, undefined, undefined, undefined, undefined, h.uri as never);
  assert.notEqual(historicalSchema, execution.checkpoint.toolSchemaHash);
  await assert.rejects(restart().run(request), /Tool schema changed/);
  // The tested boundary pins exactly the schema the host actually dispatched after confirmation.
  segment.toolSchemaHash = execution.checkpoint.toolSchemaHash;
  const sampleCount = h.samples.length;
  await assert.rejects(restart().run({ ...request, signal: AbortSignal.abort() }), /aborted|stopped|中止|停止/i);
  assert.equal(h.samples.length, sampleCount, 'a cancelled transition cannot dispatch');
  h.startExecution(true);
  let final: RunCheckpoint | undefined, savedDraft: RunCheckpoint | undefined;
  const response = await restart().run(request, { onCheckpoint: async cp => {
    final = cp;
    if (cp.state?.draftEdits.length && cp.state.toolRounds.some(r => r.toolCalls.some(c => c.function.name === draftTool)) && !savedDraft) {
      savedDraft = checkpointCopy(cp);
    }
  } });
  const epochReply = h.samples.slice(sampleCount).find(sample => sample.payload.messages.some(
    message => message.role === 'tool' && message.content?.includes('probeValue0 = 73;') && message.content.includes(h.evidence.evidenceRef)));
  assert.ok(epochReply, JSON.stringify(h.samples.slice(sampleCount).map(sample => [typeof sample.answer === 'string' ? sample.answer : sample.answer.name, sample.payload.messages.at(-1)?.content?.slice(0, 1400)])));
  assert.equal(final?.state?.epoch?.index, planCp.state!.epoch!.index + 1);
  assert.equal(final.taskId, planCp.taskId);
  assert.equal(final.request.approvalRootTaskId, h.planning.request.approvalRootTaskId);
  assert.equal(final.toolSchemaHash, execution.checkpoint.toolSchemaHash);
  assert.ok(final.usedMs >= planCp.usedMs && final.modelRequests > planCp.modelRequests);
  assert.equal(response.draftEdits.length, 1);
  assert.ok(response.toolRounds?.every(r => r.toolCalls.every(c => !historicRoundIds.includes(c.id))));
  const seed = final.state!.epoch!.seed!;
  assert.ok(seed.length < 24000);
  // Exercise the public seed builder for a large evidence index. The same
  // record is repeated as synthetic load; it does not create new evidence.
  const evidenceRefs = Array.from({ length: 512 }, () => h.evidence);
  const checkpointEvidence = JSON.parse(seed).hostState.evidenceIndex;
  const seedInput = { originalTask: h.goal, taskPlan: planCp.taskPlan!, semanticSummary: 'Verified source files.',
    evidenceRefs, idempotency: [], failures: [], draftEdits: [], draftRuns: [], repairLoop: state.repairLoop,
    nextStep: 'Prepare total.ts', checkpointEvidence };
  const indexedSeed = createEpochSeed(seedInput);
  assert.equal(JSON.parse(indexedSeed).hostState.evidence.length, 24);
  assert.ok(indexedSeed.length < 24000);
  // Report how the long required instruction affects the seed without pinning a future compaction strategy.
  const longSeed = createEpochSeed({ ...seedInput, originalTask: 'important '.repeat(4000) });
  assert.ok(savedDraft);
  // Reopen the exact committed post-draft boundary under a fresh runner.
  // The same DraftEdit and the same evidence intent are recovered once.
  const beforeReplay = h.samples.length;
  const replayed = await restart().run({ ...request, checkpoint: savedDraft });
  assert.deepEqual(replayed.draftEdits.map(e => e.id), response.draftEdits.map(e => e.id));
  assert.ok(h.samples.slice(beforeReplay).every(s => typeof s.answer === 'string'));
  t.diagnostic(JSON.stringify({ epochSeedChars: seed.length, indexed512SeedChars: indexedSeed.length, longRequirementSeedChars: longSeed.length, epochRead: 'probeValue0 = 73;', epochTask: final.taskId,
    epochIndex: final.state!.epoch!.index, modelRequestsBefore: planCp.modelRequests, modelRequestsAfter: final.modelRequests,
    planSchemaHash: historicalSchema, executionSchemaHash: final.toolSchemaHash, previousDraftRedispatches: 0 }));
});

for (const scenario of [1, 3]) for (const route of ['current', 'new'] as const) {
  test('mock cost to first verified draft: ' + scenario + ' source(s), ' + route, async t => {
    const h = await startProbe(t, scenario);
    const start = performance.now();
    const offset = h.samples.length;
    h.startExecution(false);
    if (route === 'current') {
      await h.host.handleMessage({ type: 'resolvePlanDecision', planId: h.plan.id, action: 'start_execution' });
    } else {
      const preview = buildPlanHandoffPrompt(h.source, h.plan.id, h.host.language);
      assert.ok(preview.ok);
      await h.host.handleMessage({ type: 'executePlanInNewSession', sessionId: h.source.id, planId: h.plan.id,
        planHash: preview.planHash, bodyHash: preview.bodyHash });
    }
    const execution = h.captures[1];
    assert.ok(execution?.firstDraftAt, JSON.stringify({ notices: h.notices, events: h.posts.slice(-3).map(e => [e.type, e.reason]) }));
    assert.equal(execution.request.sessionId === h.source.id, route === 'current');
    if (route === 'current') assert.equal(execution.request.approvalRootTaskId, h.planning.request.approvalRootTaskId);
    else {
      assert.notEqual(execution.request.approvalRootTaskId, h.planning.request.approvalRootTaskId);
      assert.equal(execution.request.approvalRootTaskId, h.store.getActiveSession().messages[0].id);
      assert.ok(execution.request.checkpoint!.modelRequests >= h.planning.checkpoint!.modelRequests);
    }
    const draft = execution.response?.draftEdits[0];
    assert.ok(draft?.kind === 'full_text_v1' && draft.action === 'create' && draft.label === 'total.ts');
    const expected = 'export const total = ' + (scenario === 1 ? 73 : 252) + ';\n';
    assert.equal(draft.result.sha256, createHash('sha256').update(expected).digest('hex'));
    const segment = h.samples.slice(offset);
    const draftRequest = segment.findIndex(s => typeof s.answer !== 'string' && s.answer.name === draftTool);
    assert.ok(draftRequest >= 0);
    const throughDraft = segment.slice(0, draftRequest + 1);
    t.diagnostic(JSON.stringify({ scenario, route, toolCalls: throughDraft.filter(s => typeof s.answer !== 'string').length,
      cumulativeEstimatedInputTokens: throughDraft.reduce((sum, s) => sum + s.estimatedTokens, 0),
      mockElapsedMs: Math.round(execution.firstDraftAt - start), measuredOnlineTokens: null }));
  });
}
