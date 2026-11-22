import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { getPlanWorkflowViews, registerPendingPlan, resolvePlanDecision } from '../src/agent/executionMode';
import { createLogicalRunBudgetState } from '../src/agent/executionPolicy';
import { buildPlanHandoffPrompt, renderGeneratedHandoffPrompt, verifyHandoffProjection } from '../src/agent/handoffPrompt';
import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { capOversizedFirstUserProviderContent } from '../src/agent/historyArchive';
import { getConfiguredAgentSettings } from '../src/shared/config';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ModelSourceStore } from '../src/accounts/accountStore';
import type { ModelSourceProvider } from '../src/accounts/types';
import type { ChatSession } from '../src/shared/types';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { effectiveMode } from '../src/sessions/queue/projectQueue';
import { ProjectQueueService } from '../src/sessions/queue/queueService';
import { ProjectQueueStore } from '../src/sessions/queue/queueStore';
import type { UserTaskBudget } from '../src/sessions/userTaskBudget';
import * as vscode from './stubs/vscode';

const taskId = 'logical-plan-task';
const userId = 'plan-user';
const planId = 'reviewed-plan';
const goal = 'Fix retry counting in src/retry.ts at calculateRetryCount. Acceptance requires the first attempt to count once.';
const steps = '1. Inspect calculateRetryCount and its callers in src/retry.ts.\n   - Record the input when retries are disabled.\n2. Update the counter and run its tests.\n   - Verify the first attempt counts once and a second attempt counts twice.';
const budget: UserTaskBudget = {
  version: 1, usedMs: 1210, maxExecutionMs: 60_000, maxCost: 0,
  usedCostByCurrency: { USD: 0.05 },
  runBudget: createLogicalRunBudgetState({ modelRequests: 2, toolRounds: 1, toolCalls: 3, upstreamTokens: 117, treeUpstreamTokens: 117 })
};

async function windowAt(root: string) {
  const uri = vscode.Uri.file(path.join(root, 'storage'));
  const project = vscode.Uri.file(path.join(root, 'project'));
  const scope = { key: 'folders:' + project.toString(), name: 'project', folderUris: [project.toString()] };
  const storage = new GlobalSessionStorage(uri as never);
  const queues = new ProjectQueueService(key => storage.getProjectQueueUri(key));
  const store = new ChatSessionStore(storage, 'en', scope, queues);
  await store.initialize({ fresh: true });
  return { root, uri, project, storage, store, scope };
}
type Window = Awaited<ReturnType<typeof windowAt>>;

async function seed(t: TestContext, planText = steps, approvalMode: 'ask' | 'approve-all' = 'ask') {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'keepseek-handoff-')));
  const cleanup: Array<() => Promise<void>> = [];
  t.after(async () => {
    try { for (const release of cleanup.reverse()) await release(); }
    finally { await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
  });
  await mkdir(path.join(root, 'project'));
  const w = await windowAt(root);
  await w.store.setApprovalMode(approvalMode);
  const order: string[] = [];
  for (const label of ['A', 'B', 'C']) {
    const session = await w.store.createNewSession();
    if (label === 'B') {
      const createdAt = new Date().toISOString();
      const userTask = { version: 1, id: taskId, originMessageId: userId, reason: 'user' } as const;
      session.messages.push(
        { id: userId, role: 'user', content: goal, createdAt, userTask },
        { id: 'plan-assistant', role: 'assistant', content: planText, createdAt, userTask });
      session.userTaskBudgets = { [taskId]: structuredClone(budget) };
      session.executionMode = 'plan';
      session.projectScopeUri = w.project.toString();
      session.activeSkillIds = ['workspace:one-off'];
      session.frozenImplicitSkillIds = ['builtin:gen-prompt'];
      registerPendingPlan({ session, userMessageId: userId, assistantMessageId: 'plan-assistant', content: planText, id: planId });
    } else {
      session.messages.push({ id: 'user-' + label, role: 'user', content: label, createdAt: new Date().toISOString() });
    }
    order.push(session.id);
    await w.store.persist();
  }
  const source = await w.store.selectSession(order[1]);
  assert.ok(source);
  assert.deepEqual((await diskQueue(w)).entries.map(entry => entry.sessionId), order);
  return { ...w, order, source, cleanup };
}
type Seed = Awaited<ReturnType<typeof seed>>;

function confirmation(w: Seed) {
  const artifact = buildPlanHandoffPrompt(w.source, planId, 'en');
  assert.ok(artifact.ok, JSON.stringify(artifact));
  return { sourceSessionId: w.source.id, planId, body: artifact.body, bodyHash: artifact.bodyHash,
    planHash: artifact.planHash, projectScopeUri: w.project.toString(), canonicalScopeUri: w.project.toString(), language: 'en' as const, approvalMode: w.source.approvalMode ?? 'ask',
    sourceId: 'fixture-account', modelId: 'fixture-model' };
}

async function diskQueue(w: Window) {
  const result = await new ProjectQueueStore(w.storage.getProjectQueueUri(w.scope.key)).load(w.scope.key);
  assert.equal(result.status, 'loaded');
  return result.queue;
}

const guard = () => {};
for (const crash of ['after-first-message', 'after-promotion', 'after-dispatch'] as const) {
  test('a fresh host reconciles the same durable handoff ' + crash, async t => {
    const initial = await seed(t);
    const input = confirmation(initial);
    let hit = false;
    if (crash === 'after-first-message') {
      const save = initial.storage.saveWorkspace.bind(initial.storage);
      initial.storage.saveWorkspace = async (scope, state) => {
        await save(scope, state);
        if (state.sessions.some(s => !initial.order.includes(s.id) && s.messages.some(m => m.content === input.body))) {
          hit = true;
          throw new Error('injected after first message commit');
        }
      };
    } else if (crash === 'after-promotion') {
      const save = ProjectQueueStore.prototype.save;
      t.mock.method(ProjectQueueStore.prototype, 'save', async function(this: ProjectQueueStore, ...args: Parameters<typeof save>) {
        const saved = await save.apply(this, args);
        if (!hit && saved.status === 'saved' && !initial.order.includes(args[0].entries[0]?.sessionId)) {
          hit = true;
          throw new Error('injected after durable promotion');
        }
        return saved;
      });
    }
    let dispatches = 0;
    if (crash === 'after-dispatch') {
      const { record } = await initial.store.commitPlanHandoff(input, guard);
      initial.store.activatePlanHandoffTarget(record);
      if (await initial.store.claimPlanHandoffDispatch(record, guard, input.bodyHash)) dispatches++;
      assert.equal(dispatches, 1);
      // Simulate a request crossing the network followed by host death before acknowledgement.
      hit = true;
    } else {
      await assert.rejects(initial.store.commitPlanHandoff(input, guard), /injected/);
    }
    assert.ok(hit, 'the fault must have occurred after its durable boundary');
    await initial.storage.flush();
    initial.store.dispose();

    const restarted = await windowAt(initial.root);
    assert.equal(restarted.store.messages.length, 0, 'activation starts blank');
    const before = await restarted.storage.loadWorkspaceSessions(restarted.scope.key);
    const existing = before.filter(s => !initial.order.includes(s.id));
    assert.equal(existing.length, 1, 'the first visible target already has its body');
    assert.equal(existing[0].messages[0].content, input.body);
    await restarted.store.selectSession(initial.source.id);
    const { record, target } = await restarted.store.commitPlanHandoff(input, guard);
    assert.equal(target.id, existing[0].id);
    assert.equal(record.phase, crash === 'after-dispatch' ? 'dispatch_unknown' : 'queued');
    assert.deepEqual(target.messages.filter(m => m.role === 'user').map(m => m.content), [input.body]);
    assert.equal(target.userTaskBudgets?.[target.messages[0].userTask!.id]?.usedMs, budget.usedMs);
    assert.deepEqual(target.userTaskBudgets?.[target.messages[0].userTask!.id]?.usedCostByCurrency, budget.usedCostByCurrency);
    assert.deepEqual(target.userTaskBudgets?.[target.messages[0].userTask!.id]?.runBudget, budget.runBudget);
    assert.equal(target.activeSkillIds?.length ?? 0, 0);
    assert.equal(target.frozenImplicitSkillIds?.length ?? 0, 0);
    const sourceAfter = await restarted.storage.loadSession(restarted.scope.key, initial.source.id);
    assert.equal(sourceAfter?.planWorkflows?.[0].status, 'superseded');
    assert.equal(sourceAfter?.userTaskBudgets?.[taskId], undefined, 'only the target owns remaining budget');
    const catalog = await restarted.storage.readHistoryCleanupCatalog(restarted.scope.key);
    for (const id of [initial.source.id, target.id]) {
      assert.equal(catalog.entries.find(entry => entry.id === id)?.protectedReason, 'plan_handoff_pending');
    }
    const queue = await diskQueue(restarted);
    assert.deepEqual(queue.entries.map(entry => entry.sessionId), [target.id, ...initial.order]);
    assert.equal(queue.entries.filter(e => effectiveMode(queue, e.sessionId) === 'normal').length, 1);
    restarted.store.activatePlanHandoffTarget(record);
    if (await restarted.store.claimPlanHandoffDispatch(record, guard, input.bodyHash)) dispatches++;
    assert.equal(dispatches, 1, 'recovery must not repeat a request whose dispatch is unknown');
    restarted.store.dispose();
  });
}

test('two windows competing to submit one reviewed version create one target, message and dispatch claim', async t => {
  const first = await seed(t);
  const input = confirmation(first);
  const second = await windowAt(first.root);
  await second.store.selectSession(first.source.id);
  const commits = await Promise.allSettled([
    first.store.commitPlanHandoff(input, guard), second.store.commitPlanHandoff(input, guard)
  ]);
  const winners = commits.flatMap((result, index) => result.status === 'fulfilled'
    ? [{ store: index === 0 ? first.store : second.store, value: result.value }] : []);
  assert.ok(winners.length > 0, 'at least one competing submit must finish');
  const targetId = winners[0].value.target.id;
  for (const { store, value } of winners) {
    assert.equal(value.target.id, targetId);
    store.activatePlanHandoffTarget(value.record);
  }
  const claims = await Promise.all(winners.map(({ store, value }) => store.claimPlanHandoffDispatch(value.record, guard, input.bodyHash)));
  assert.equal(claims.filter(Boolean).length, 1);
  const sessions = await first.storage.loadWorkspaceSessions(first.scope.key);
  assert.equal(sessions.length, first.order.length + 1);
  assert.deepEqual(sessions.find(s => s.id === targetId)?.messages.map(m => m.content), [input.body]);
  assert.deepEqual((await diskQueue(first)).entries.map(entry => entry.sessionId), [targetId, ...first.order]);
});

test('stale source persistence cannot resurrect a transferred budget, and a displaced target cannot dispatch', async t => {
  const first = await seed(t);
  const stale = await windowAt(first.root);
  await stale.store.selectSession(first.source.id);
  const input = confirmation(first);
  const { record } = await first.store.commitPlanHandoff(input, guard);
  await assert.rejects(stale.store.persist('stale_source'));
  const durableSource = await stale.storage.loadSession(stale.scope.key, first.source.id);
  assert.equal(durableSource?.planWorkflows?.[0].status, 'superseded');
  assert.equal(durableSource?.userTaskBudgets?.[taskId], undefined);
  const third = await windowAt(first.root);
  await third.store.ensureProjectQueue();
  await third.store.promoteSessionInQueue(first.order[2]);
  first.store.activatePlanHandoffTarget(record);
  await assert.rejects(first.store.claimPlanHandoffDispatch(record, guard, input.bodyHash), /head|队首/u);
  assert.equal((await diskQueue(first)).entries[0].sessionId, first.order[2]);
  assert.equal((await first.storage.loadSession(first.scope.key, first.source.id))?.planHandoffs?.[0].phase, 'queued');
});

test('a stale plan or changed confirmation body keeps the original plan actionable', async t => {
  const w = await seed(t);
  const input = confirmation(w);
  for (const invalid of [{ ...input, bodyHash: '0'.repeat(64) }, { ...input, planHash: 'f'.repeat(64) },
    { ...input, body: input.body + ' execute something else' }]) {
    await assert.rejects(w.store.commitPlanHandoff(invalid, guard));
  }
  assert.deepEqual((await diskQueue(w)).entries.map(entry => entry.sessionId), w.order);
  const source = await w.storage.loadSession(w.scope.key, w.source.id);
  assert.equal(source?.planWorkflows?.[0].status, 'pending');
  assert.equal((await w.storage.loadWorkspaceSessions(w.scope.key)).length, 3);
});

const lanes = ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as const;
const criterion = 'HARD ACCEPTANCE. Retrying the third item must preserve its initial attempt count.';

function longPlan(lines: number) {
  const parts = Array.from({ length: lines }, (_, index) =>
    `- For scenario ${index + 1}, check the recorded input against the retry result and validate its final count.`);
  parts.splice(Math.floor(lines * 0.66), 0, criterion);
  return [steps, ...parts].join('\n');
}

test('oversize essential content refuses a lossy handoff and leaves the plan and queue intact', async t => {
  const plan = longPlan(430);
  assert.ok(plan.length > 32_000 && plan.indexOf(criterion) > 24_000);
  t.diagnostic('Required plan length ' + plan.length + ', middle acceptance offset ' + plan.indexOf(criterion));
  const w = await seed(t, plan);
  const artifact = buildPlanHandoffPrompt(w.source, planId, 'en');
  if (artifact.ok) {
    assert.ok(artifact.body.includes(criterion));
    for (let i = 1; i <= 430; i++) assert.ok(artifact.body.includes('scenario ' + i + ','));
  } else {
    assert.match(artifact.reason, /size|large|long|limit|length/u);
  }
  assert.equal(w.source.planWorkflows?.[0].status, 'pending');
  assert.deepEqual((await diskQueue(w)).entries.map(entry => entry.sessionId), w.order);
  assert.equal((await w.storage.loadWorkspaceSessions(w.scope.key)).length, 3);
});

test('an approved short enough body survives all three wire projections; host-tail archiving is detected', async t => {
  const w = await seed(t, longPlan(270));
  const { body, bodyHash } = confirmation(w);
  assert.ok(body.includes(criterion));
  const createdAt = new Date().toISOString();
  for (const provider of lanes) {
    for (const oversize of [false, true]) {
      const wrapped = body + '\n\nHost result: ' + (oversize ? 'evidence '.repeat(2600) : 'complete');
      const session: ChatSession = { ...w.source, messages: [{ id: 'first', role: 'user', createdAt, content: body, providerContent: wrapped }] };
      const archived = capOversizedFirstUserProviderContent(session);
      assert.equal(archived.changed, oversize);
      const projection = buildProviderRequestProjection({
        model: { id: 'fixture-model', label: 'Fixture', provider, sourceId: 'fixture-account', contextWindowTokens: 1_000_000 },
        provider, baseUrl: 'https://handoff.invalid/v1', sourceId: 'fixture-account', agentSettings: getConfiguredAgentSettings(),
        language: 'en', contextFiles: [], history: session.messages, prompt: session.messages[0].providerContent!
      });
      if (oversize) assert.throws(() => verifyHandoffProjection(projection, body, bodyHash));
      else assert.match(verifyHandoffProjection(projection, body, bodyHash), /^[0-9a-f]{64}$/u);
    }
  }
});

interface MessageHost {
  handleMessage(message: WebviewMessage): Promise<void>;
  initializeAfterWebviewReady(): Promise<void>;
  refreshModelSourceState(): Promise<void>;
  language: 'en' | 'zh-CN';
  postState(options?: unknown): void;
}

async function providerAt(w: Seed, lane: ModelSourceProvider) {
  const namespace = vscode as unknown as Record<string, unknown>;
  const alignment = namespace.StatusBarAlignment;
  const previousWindow = { ...vscode.window };
  const previousFolders = vscode.workspace.workspaceFolders;
  const warnings: string[] = [];
  namespace.StatusBarAlignment = { Left: 1, Right: 2 };
  vscode.workspace.workspaceFolders = [{ name: 'project', uri: w.project }];
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async (m: string) => { warnings.push(m); },
    showErrorMessage: async (m: string) => { warnings.push(m); },
    showInformationMessage: async (m: string) => { warnings.push(m); }
  });
  const accounts = new ModelSourceStore(w.uri as never);
  if (!await accounts.getSource('fixture-account')) await accounts.createSource({ id: 'fixture-account', name: 'Probe', baseUrl: 'https://handoff.invalid/v1',
    apiKey: 'fixture-only', provider: lane, models: [{ id: 'fixture-model', contextWindowTokens: 1_000_000 }] });
  const provider = new KeepseekChatViewProvider(vscode.Uri.file(process.cwd()) as never, w.store, w.uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    Promise.resolve());
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    provider.dispose();
    await w.storage.flush();
    Object.assign(vscode.window, previousWindow);
    vscode.workspace.workspaceFolders = previousFolders;
    if (alignment === undefined) delete namespace.StatusBarAlignment;
    else namespace.StatusBarAlignment = alignment;
  };
  w.cleanup.push(dispose);
  const host = provider as unknown as MessageHost;
  await host.initializeAfterWebviewReady();
  await host.handleMessage({ type: 'selectSession', sessionId: w.source.id });
  await host.refreshModelSourceState();
  host.language = 'en';
  return { host, warnings, dispose };
}

function streamReply(lane: ModelSourceProvider, text: string) {
  const events = lane === 'anthropic-compatible' ? [
    { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } },
    { type: 'message_stop' }
  ] : lane === 'openai-responses' ? [
    { type: 'response.output_text.delta', delta: text },
    { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant',
      content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 8 } } }
  ] : [
    { choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 } }
  ];
  return new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('') +
    (lane === 'openai-compatible' ? 'data: [DONE]\n\n' : ''), { headers: { 'Content-Type': 'text/event-stream' } });
}

for (const lane of lanes) {
  test('the plan card submits the reviewed body exactly once through the ' + lane + ' transport', async t => {
    const approvalMode = lane === 'openai-responses' ? 'approve-all' : 'ask';
    const w = await seed(t, longPlan(40), approvalMode);
    const { host, warnings } = await providerAt(w, lane);
    const artifact = confirmation(w);
    const wire: unknown[] = [];
    t.mock.method(globalThis, 'fetch', async (_input: unknown, init: RequestInit) => {
      if (init.method !== 'POST') return new Response('{}', { status: 404 });
      const payload = JSON.parse(String(init.body));
      wire.push(payload);
      return streamReply(lane, 'Recorded execution prompt.');
    });
    const click = { type: 'executePlanInNewSession', sessionId: w.source.id, planId, planHash: artifact.planHash, bodyHash: artifact.bodyHash } as const;
    await Promise.all([host.handleMessage(click), host.handleMessage(click)]);
    const bodies = wire.flatMap(p => {
      const payload = p as { input?: Array<{role?: string; content?: unknown}>; messages?: Array<{role?: string; content?: unknown}> };
      return (payload.input ?? payload.messages ?? []).filter(m => m.role === 'user').map(m =>
        typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map(b => b.text).join('') : '');
    }).filter(content => content.includes(criterion));
    assert.equal(bodies.length, 1, JSON.stringify(warnings));
    assert.ok(bodies[0].includes(artifact.body), 'the complete preview appears on the wire, including its middle acceptance condition');
    assert.deepEqual(w.store.messages.filter(m => m.role === 'user').map(m => m.content), [artifact.body]);
    assert.equal((await diskQueue(w)).entries[0].sessionId, w.store.activeSessionId);
    assert.notEqual(w.store.activeSessionId, w.source.id);
    assert.ok(w.store.messages.some(m => m.role === 'assistant' && m.content.includes('Recorded execution prompt.')),
      'the real transport parsed the mock completion and persisted its response');
    const final = await w.storage.loadSession(w.scope.key, w.source.id);
    const journal = final?.planHandoffs?.[0];
    assert.equal(journal?.phase, 'completed');
    assert.equal(journal.approvalMode, approvalMode);
    assert.equal(w.store.approvalMode, approvalMode);
    assert.equal(journal.bodyHash, createHash('sha256').update(artifact.body).digest('hex'));
    assert.equal(journal.projectionHash, createHash('sha256').update(bodies[0]).digest('hex'));
    const settled = w.store.getActiveSession().userTaskBudgets?.[journal.targetMessageId];
    assert.ok(settled && settled.usedMs >= budget.usedMs && settled.usedCostByCurrency!.USD >= budget.usedCostByCurrency!.USD);
    assert.ok(settled.runBudget && settled.runBudget.modelRequests >= budget.runBudget!.modelRequests + 1,
      'execution is charged against the transferred counters');
    assert.equal(final?.userTaskBudgets?.[taskId], undefined);
  });
}

test('project paths in Chinese punctuation and command options remain portable at the plan card', async t => {
  const w = await seed(t);
  const user = w.source.messages.find(message => message.id === userId)!;
  user.content = '核对（' + w.project.fsPath + '/src/retry.ts），并在 --cwd=' + w.project.fsPath + ' 运行测试。';
  const view = getPlanWorkflowViews(w.source, { language: 'zh-CN' })[0];
  assert.ok(view.promptPreview?.ok);
  assert.ok(view.promptPreview.body.includes('核对（./src/retry.ts），并在 --cwd=. 运行测试。'));
  assert.equal(view.newSessionBlockedReason, undefined);
  for (const outside of [w.project.fsPath + '-other/private.ts', w.project.fsPath + '/../private.ts']) {
    user.content = '核对（' + outside + '）';
    assert.deepEqual(buildPlanHandoffPrompt(w.source, planId, 'zh-CN'), { ok: false, reason: 'disclosure' });
  }
});

test('a historical plan without its task identity keeps the copy preview and cannot start a handoff', async t => {
  const w = await seed(t);
  delete w.source.messages.find(message => message.id === userId)!.userTask;
  await w.store.persist();
  const { host, warnings } = await providerAt(w, 'openai-compatible');
  const artifact = confirmation(w);
  for (const language of ['en', 'zh-CN'] as const) {
    const view = getPlanWorkflowViews(w.store.getActiveSession(), { language })[0];
    assert.ok(view.promptPreview?.ok && view.newSessionBlockedReason);
  }
  const send = t.mock.method(globalThis, 'fetch', async () => streamReply('openai-compatible', 'Unexpected request.'));
  await host.handleMessage({ type: 'executePlanInNewSession', sessionId: w.source.id, planId,
    planHash: artifact.planHash, bodyHash: artifact.bodyHash });
  assert.match(warnings.at(-1) ?? '', /task budget/u);
  assert.equal(send.mock.callCount(), 0);
  assert.deepEqual((await diskQueue(w)).entries.map(entry => entry.sessionId), w.order);
  assert.equal(w.store.getActiveSession().planWorkflows?.[0].status, 'pending');
});

test('the actual submission refuses a complete preview when the host tail exceeds the first-message limit', async t => {
  const initial = longPlan(300);
  const base = renderGeneratedHandoffPrompt(goal, initial, 'en');
  assert.ok(base.ok);
  const required = initial + '\n' + 'x'.repeat(31998 - base.body.length);
  const w = await seed(t, required);
  const { host, warnings } = await providerAt(w, 'openai-compatible');
  const artifact = confirmation(w);
  assert.equal(artifact.body.length, 31999);
  let physicalRequests = 0;
  t.mock.method(globalThis, 'fetch', async () => { physicalRequests++; return streamReply('openai-compatible', 'Unexpected request.'); });
  await host.handleMessage({ type: 'executePlanInNewSession', sessionId: w.source.id, planId,
    planHash: artifact.planHash, bodyHash: artifact.bodyHash });
  assert.equal(physicalRequests, 0);
  assert.equal((await w.storage.loadSession(w.scope.key, w.source.id))?.planWorkflows?.[0].status, 'pending');
  assert.deepEqual((await diskQueue(w)).entries.map(entry => entry.sessionId), w.order);
  assert.ok(warnings.length, 'the host must explain why the handoff cannot be submitted');
});

test('the old writer blocks submission and target preparation excludes independent work', async t => {
  const w = await seed(t);
  const other = await windowAt(w.root);
  const input = confirmation(w);
  const oldWriter = await other.store.acquireSessionUse(w.order[0]);
  try {
    await assert.rejects(w.store.commitPlanHandoff(input, guard), /use|执行/u);
    const source = await w.storage.loadSession(w.scope.key, w.source.id);
    assert.equal(source?.planWorkflows?.[0].status, 'pending');
    assert.equal(source?.userTaskBudgets?.[taskId]?.usedMs, budget.usedMs);
    assert.deepEqual((await diskQueue(w)).entries.map(entry => entry.sessionId), w.order);
  } finally { await oldWriter.release(); }
  const { record, target } = await w.store.commitPlanHandoff(input, guard);
  const preparing = await w.store.acquirePlanHandoffPreparation(record);
  try { await assert.rejects(other.store.acquireSessionUse(target.id)); }
  finally { await preparing.release(); }
  const ordinary = await other.store.acquireSessionUse(target.id);
  await ordinary.release();
});

for (const action of ['start_execution', 'revise_plan'] as const) {
  test('a competing ' + action + ' that commits after source validation wins over the stale handoff', async t => {
    const w = await seed(t);
    const other = await windowAt(w.root);
    const session = await other.store.selectSession(w.source.id);
    assert.ok(session);
    const input = confirmation(w);
    const save = w.storage.saveWorkspace.bind(w.storage);
    let raced = false;
    w.storage.saveWorkspace = async (scope, state) => {
      if (!raced && state.sessions.some(source => source.planHandoffs?.length)) {
        raced = true;
        const decision = resolvePlanDecision({ session, activeSessionId: session.id, planId, action });
        assert.ok(decision.ok);
        if (action === 'start_execution') await other.store.promoteSessionInQueue(session.id);
        await other.store.persist();
      }
      await save(scope, state);
    };
    await assert.rejects(w.store.commitPlanHandoff(input, guard));
    assert.ok(raced);
    const source = await other.storage.loadSession(w.scope.key, session.id);
    assert.equal(source?.planWorkflows?.[0].status, action === 'start_execution' ? 'approved' : 'revision_requested');
    assert.equal(source?.userTaskBudgets?.[taskId]?.usedMs, budget.usedMs);
    assert.equal(source?.planHandoffs?.length ?? 0, 0);
    assert.equal((await other.storage.loadWorkspaceSessions(w.scope.key)).length, w.order.length);
  });
}

test('a crash between the dispatch claim and network requires an explicit retry on the same target', async t => {
  const initial = await seed(t);
  const input = confirmation(initial);
  const { record, target } = await initial.store.commitPlanHandoff(input, guard);
  initial.store.activatePlanHandoffTarget(record);
  const projectionHash = createHash('sha256').update(target.messages[0].providerContent!).digest('hex');
  assert.equal(await initial.store.claimPlanHandoffDispatch(record, guard, projectionHash), true);
  await assert.rejects(initial.store.claimPlanHandoffDispatch(record, guard, 'a'.repeat(64), true));
  initial.store.dispose();

  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (init.method === 'POST' && String(init.body).includes('calculateRetryCount')) requests++;
    return streamReply('openai-compatible', 'Acknowledged explicit retry.');
  });
  const fresh = await windowAt(initial.root);
  assert.equal(fresh.store.messages.length, 0);
  const { host, warnings, dispose } = await providerAt({ ...initial, ...fresh }, 'openai-compatible');
  assert.equal(requests, 0);
  const click = { type: 'executePlanInNewSession', sessionId: initial.source.id, planId, planHash: input.planHash,
    bodyHash: input.bodyHash } as const;
  await host.handleMessage(click);
  assert.ok(warnings.some(message => /unknown|未知/u.test(message)));
  assert.equal(requests, 0, 'reviewing the source and declining the retry must not dispatch');
  assert.equal(fresh.store.activeSessionId, target.id);
  const independent = { sessionId: target.id, sourceId: input.sourceId, modelId: input.modelId,
    prompt: 'Inspect a new requirement independently.' };
  await host.handleMessage({ ...independent, type: 'sendPrompt', requestId: 'unresolved-send' });
  await host.handleMessage({ ...independent, type: 'editUserPrompt', requestId: 'unresolved-edit', messageId: record.targetMessageId });
  assert.equal(requests, 0, 'ordinary send/edit cannot bypass an unresolved dispatch');
  assert.deepEqual(fresh.store.messages.map(m => [m.id, m.content]), [[record.targetMessageId, input.body]]);
  await host.handleMessage({ type: 'selectSession', sessionId: initial.source.id });
  t.mock.method(vscode.window, 'showWarningMessage', async (_message: string, options: { modal?: boolean }, retry?: string) =>
    options?.modal === true ? retry : undefined);
  await host.handleMessage(click);
  assert.equal(requests, 1, JSON.stringify(warnings));
  const after = await fresh.storage.loadSession(fresh.scope.key, initial.source.id);
  assert.equal(after?.planHandoffs?.[0].phase, 'completed');
  assert.equal(fresh.store.activeSessionId, target.id);
  assert.deepEqual(fresh.store.messages.filter(message => message.role === 'user').map(m => m.id), [record.targetMessageId]);

  // After completion, removing the source and reopening the target must still permit an independent user task.
  assert.equal((await fresh.storage.loadSession(fresh.scope.key, target.id))?.planHandoffCompleted, true);
  const deletion = await fresh.store.deleteSessions([initial.source.id]);
  assert.equal(deletion.deletedCount, 1);
  await dispose();
  fresh.store.dispose();
  const reopened = await windowAt(initial.root);
  const history = await providerAt({ ...initial, ...reopened, source: target }, 'openai-compatible');
  await history.host.handleMessage({ ...independent, type: 'sendPrompt', requestId: 'completed-independent' });
  const users = reopened.store.messages.filter(m => m.role === 'user');
  assert.deepEqual(users.map(m => m.content), [input.body, independent.prompt], JSON.stringify(history.warnings));
  assert.notEqual(users[1].userTask?.id, users[0].userTask?.id);
  assert.ok(reopened.store.messages.at(-1)?.content.includes('Acknowledged explicit retry.'));
});

test('a transport failure can be explicitly continued after a fresh activation without duplicating the goal', async t => {
  const initial = await seed(t);
  const input = confirmation(initial);
  let recovering = false;
  let initialCalls = 0;
  let recoveryCalls = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (init.method !== 'POST') return new Response('{}', { status: 404 });
    const containsPrompt = String(init.body).includes('calculateRetryCount');
    if (!containsPrompt) return streamReply('openai-compatible', 'Retry count');
    if (!recovering) {
      initialCalls++;
      return new Response('{"error":{"message":"mock rejected this request"}}', { status: 401 });
    }
    recoveryCalls++;
    return streamReply('openai-compatible', 'The recovered execution is complete.');
  });
  const first = await providerAt(initial, 'openai-compatible');
  const click = { type: 'executePlanInNewSession', sessionId: initial.source.id, planId,
    planHash: input.planHash, bodyHash: input.bodyHash } as const;
  await first.host.handleMessage(click);
  assert.equal(initialCalls, 1, JSON.stringify(first.warnings));
  const source = await initial.storage.loadSession(initial.scope.key, initial.source.id);
  const record = source?.planHandoffs?.[0];
  assert.equal(record?.phase, 'dispatch_unknown');
  const messageId = initial.store.messages.at(-1)?.id;
  assert.ok(messageId && messageId !== record.targetMessageId);
  await first.dispose();
  initial.store.dispose();
  recovering = true;

  const next = await windowAt(initial.root);
  assert.equal(next.store.messages.length, 0);
  const second = await providerAt({ ...initial, ...next }, 'openai-compatible');
  await second.host.handleMessage(click);
  assert.equal(recoveryCalls, 0, 'reviewing a request with an existing checkpoint cannot resend it');
  assert.equal(next.store.activeSessionId, record.targetSessionId);
  await second.host.handleMessage({ type: 'continueAgentTask', messageId });
  assert.equal(recoveryCalls, 1, JSON.stringify(second.warnings));
  const done = await next.storage.loadSession(next.scope.key, initial.source.id);
  assert.equal(done?.planHandoffs?.[0].phase, 'completed');
  assert.deepEqual(next.store.messages.filter(m => m.role === 'user').map(m => m.id), [record.targetMessageId]);
});

test('the handoff reservation blocks navigation and accepts cancellation before local commit', async t => {
  const w = await seed(t);
  const { host } = await providerAt(w, 'openai-compatible');
  const input = confirmation(w);
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => { requests++; return streamReply('openai-compatible', 'Unexpected'); });
  let resume!: () => void;
  let entered!: () => void;
  const paused = new Promise<void>(resolve => { entered = resolve; });
  const release = new Promise<void>(resolve => { resume = resolve; });
  const commit = w.store.commitPlanHandoff.bind(w.store);
  w.store.commitPlanHandoff = async (submission, check) => {
    entered();
    await release;
    return commit(submission, check);
  };
  const pending = host.handleMessage({ type: 'executePlanInNewSession', sessionId: w.source.id, planId,
    planHash: input.planHash, bodyHash: input.bodyHash });
  try {
    await Promise.race([paused, pending.then(() => { throw new Error('handoff exited before reaching the local commit'); })]);
    await host.handleMessage({ type: 'selectSession', sessionId: w.order[0] });
    assert.equal(w.store.activeSessionId, w.source.id);
    await host.handleMessage({ type: 'abortPrompt', sessionId: w.source.id });
  } finally { resume(); }
  await pending;
  assert.equal(requests, 0);
  assert.equal((await w.storage.loadSession(w.scope.key, w.source.id))?.planWorkflows?.[0].status, 'pending');
  assert.deepEqual((await diskQueue(w)).entries.map(entry => entry.sessionId), w.order);
});

test('a confirmed local model completion repairs an interrupted source audit without a second request', async t => {
  const initial = await seed(t);
  const input = confirmation(initial);
  let posts = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    if (init.method === 'POST' && String(init.body).includes('calculateRetryCount')) posts++;
    return streamReply('openai-compatible', 'Durable result before journal confirmation.');
  });
  const first = await providerAt(initial, 'openai-compatible');
  initial.store.finishPlanHandoffDispatch = async () => { throw new Error('crash before source receipt'); };
  const click = { type: 'executePlanInNewSession', sessionId: initial.source.id, planId,
    planHash: input.planHash, bodyHash: input.bodyHash } as const;
  await first.host.handleMessage(click);
  assert.equal(posts, 1);
  const before = await initial.storage.loadSession(initial.scope.key, initial.source.id);
  const record = before?.planHandoffs?.[0];
  assert.equal(record?.phase, 'dispatch_unknown');
  assert.ok(initial.store.messages.at(-1)?.content.includes('Durable result before journal confirmation.'));
  await first.dispose();
  initial.store.dispose();
  const fresh = await windowAt(initial.root);
  const next = await providerAt({ ...initial, ...fresh }, 'openai-compatible');
  await next.host.handleMessage(click);
  assert.equal(posts, 1, JSON.stringify(next.warnings));
  assert.equal((await fresh.storage.loadSession(fresh.scope.key, record.sourceSessionId))?.planHandoffs?.[0].phase, 'completed');
  assert.equal((await fresh.storage.loadSession(fresh.scope.key, record.targetSessionId))?.planHandoffCompleted, true);
  assert.equal((await diskQueue(fresh)).entries[0].sessionId, record.targetSessionId);
});
