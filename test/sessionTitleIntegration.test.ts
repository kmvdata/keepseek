import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { InteractionCoordinator } from '../src/provider/interactionState';
import { DelegatedApprovalQueue } from '../src/agent/approvalMode';
import { ChatSessionStore, createEmptySession, type StoredWorkspaceSessionState } from '../src/sessions/chatSessionStore';
import { SessionTitleCoordinator } from '../src/sessions/sessionTitleCoordinator';
import { buildSessionTitleRegenerationMaterial } from '../src/sessions/sessionTitle';
import type { SessionTitleCompletion } from '../src/provider/sessionTitleCompletion';
import type { SessionTitleRequestInput } from '../src/provider/sessionTitleRequest';
import { createManualSessionTitleBudget, restoreSessionTitleBudget } from '../src/provider/sessionTitleRequest';
import type { SessionTitleRequest } from '../src/sessions/sessionTitleCoordinator';
import type { UserTaskBudget } from '../src/sessions/userTaskBudget';
import type { AgentRequest, AgentResponse, ChatMessage, ChatSession } from '../src/shared/types';

type Parent = Pick<AgentRequest, 'model' | 'sourceConfig'>;
type Candidate = { completion: SessionTitleCompletion; parentRequest: Parent; durable: boolean };
type Host = {
  rememberSessionTitleCompletion(session: ChatSession, message: ChatMessage, response: AgentResponse, parent: Parent): void;
  flushSessionTitleCompletions(): void;
  maybeAutoContinueDraftRun(): Promise<void>;
  loadTaskBudget(session: ChatSession, link: NonNullable<ChatMessage['userTask']>): Promise<UserTaskBudget | undefined>;
  sendPrompt(prompt: string, sourceId: string, modelId: string): Promise<AgentResponse | undefined>;
  sessionTitleCandidates: Map<string, Map<string, Candidate>>;
  sessionTitles: {
    completeResult(sessionId: string, taskId: string, request: (input: SessionTitleRequest) => Promise<string>): Promise<{ outcome: string }>;
    isRunning(sessionId: string): boolean;
    cancel(sessionId: string): void;
    cancelAll(): void;
  };
  isBusy: boolean;
  isStartingRun: boolean;
  interactions: InteractionCoordinator;
  selectedSourceId: string;
  selectedModelId: string;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function turn(session: ChatSession, taskId = 'root', suffix = '') {
  const task = { version: 1 as const, id: taskId, originMessageId: `user-${taskId}`, reason: 'user' as const };
  if (!session.messages.some(message => message.id === task.originMessageId)) session.messages.push({
    id: task.originMessageId, role: 'user', content: '排查 KeepSeek 审批失败', createdAt: '', userTask: task
  });
  const message: ChatMessage = { id: `answer-${taskId}${suffix}`, role: 'assistant', content: '请补充错误日志。', createdAt: '',
    userTask: task, runDetails: { status: 'succeeded' } as ChatMessage['runDetails'] };
  session.messages.push(message);
  return message;
}

function fixture() {
  const a = createEmptySession(); a.id = 'session-a';
  const b = createEmptySession(); b.id = 'session-b';
  const sessions = new Map([[a.id, a], [b.id, b]]);
  let active = a;
  const queue = new DelegatedApprovalQueue();
  const calls: Array<{ sessionId: string; taskId: string; request: (input: SessionTitleRequest) => Promise<string> }> = [];
  const parent: Parent = { model: { id: 'main-a', label: 'Main A', sourceId: 'source-a', provider: 'deepseek' },
    sourceConfig: { sourceId: 'source-a', provider: 'deepseek', apiKey: 'test-key', baseUrl: 'https://a.invalid', supportsBilling: false } };
  const store = { activeSessionId: a.id, workspaceKey: 'workspace', getSessionById: (id: string) => sessions.get(id),
    getActiveSession: () => active, persist: async () => {} };
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    sessionStore: store, sessionTitleCandidates: new Map(), titleLifecycleDisposed: false,
    sessionReady: true, approvalDataReady: true, requestContextReady: true,
    sessionTitleDrains: new Set(), sessionTitleBudgetLeases: new Map(), sessionTitleDiagnostics: new Map(), manualSessionTitleRequests: new Map(),
    sessionTitles: { isRunning: () => false, completeResult: async (sessionId: string, taskId: string, request: (input: SessionTitleRequest) => Promise<string>) => {
      calls.push({ sessionId, taskId, request }); return { outcome: 'updated' };
    }, cancel: () => {}, cancelAll: () => {} },
    delegatedApprovals: queue, delegatedApprovalInFlight: false, draftRunAutoContinueInFlight: false,
    isBusy: false, activeChangeActions: new Set(),
    draftRunBatches: { pending: false, locked: false, cancel: () => {} },
    draftRuns: { claimReadyAutoContinuation: () => undefined },
    changeSets: { hasPendingForSession: () => false },
    repairLoopsBySession: new Map(), backgroundRunCoordinator: { getActiveRun: () => undefined },
    hasActiveBackgroundRun: () => false, getRootTaskDraftRuns: () => [],
    language: 'en', selectedSourceId: 'source-a', selectedModelId: 'main-a',
    awaitRunContextRefresh: async () => true, externalEffectGrants: { clear: () => {} },
    enterTaskWork: () => ({ finish: () => {} }), postState: () => {}, scheduleDraftRunAutoContinuation: () => {},
    globalStorageUri: vscode.Uri.file('/tmp/keepseek-title-integration'), sourceStore: {}, subagentSettingsStore: {},
    t: (key: string) => key
  }) as Host;
  return { a, b, host, parent, calls, store, queue,
    activate: (session: ChatSession) => { active = session; store.activeSessionId = session.id; } };
}

test('production completion routing requires a durable response and consumes the event exactly once', () => {
  const f = fixture();
  const message = turn(f.a);
  f.host.rememberSessionTitleCompletion(f.a, message, {} as AgentResponse, f.parent);
  f.host.flushSessionTitleCompletions();
  assert.equal(f.calls.length, 0, 'capture alone is not the response persistence barrier');
  [...f.host.sessionTitleCandidates.get(f.a.id)!.values()].at(-1)!.durable = true;
  f.host.flushSessionTitleCompletions();
  f.host.flushSessionTitleCompletions();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].taskId, 'root');
  assert.equal(f.host.isBusy, false);
  assert.equal(f.host.isStartingRun, false);
});

test('production approval drain converges several internal responses to one final title candidate', async () => {
  const f = fixture();
  f.a.approvalMode = 'delegate';
  let segments = 0;
  const enqueue = () => f.queue.enqueue({ sessionId: f.a.id, rootTaskId: 'root', runId: `segment-${segments}`,
    editIds: ['prepared-edit'], draftRunIds: [] });
  enqueue();
  Object.assign(f.host, { executeDelegatedApprovals: async (entry: NonNullable<ReturnType<DelegatedApprovalQueue['take']>>) => {
    const message = turn(f.a, 'root', String(++segments));
    f.host.rememberSessionTitleCompletion(f.a, message, {} as AgentResponse, f.parent);
    [...f.host.sessionTitleCandidates.get(f.a.id)!.values()].at(-1)!.durable = true;
    f.host.flushSessionTitleCompletions();
    assert.equal(f.calls.length, 0, 'the active approval queue holds the response');
    if (segments < 3) enqueue();
    f.queue.finish(entry.controller);
  } });
  await f.host.maybeAutoContinueDraftRun();
  assert.equal(segments, 3);
  assert.equal(f.calls.length, 1);
  await f.host.maybeAutoContinueDraftRun();
  assert.equal(f.calls.length, 1, 'refresh-driven drains cannot create another event');
});

test('switching to B preserves A source snapshot and loads/publishes only A task budget', async () => {
  const f = fixture();
  const message = turn(f.a);
  f.host.rememberSessionTitleCompletion(f.a, message, {} as AgentResponse, f.parent);
  [...f.host.sessionTitleCandidates.get(f.a.id)!.values()].at(-1)!.durable = true;
  f.parent.model.id = 'mutated';
  f.parent.sourceConfig = { ...f.parent.sourceConfig!, sourceId: 'mutated' };
  f.activate(f.b); f.host.selectedSourceId = 'source-b'; f.host.selectedModelId = 'main-b';
  const budget = { version: 1, usedMs: 1000, maxExecutionMs: 0 } as UserTaskBudget;
  f.a.userTaskBudgets = { root: budget };
  const loaded: string[] = [];
  Object.assign(f.host, { loadTaskBudget: async (session: ChatSession) => { loaded.push(session.id); return budget; } });
  f.host.flushSessionTitleCompletions();
  assert.equal(f.calls[0].sessionId, f.a.id);
  // CommonJS export is the same production dependency reference used by the
  // provider; only transport is replaced, while routing and budget callbacks run.
  const requests = require('../src/provider/sessionTitleRequest') as { requestSessionTitle(input: SessionTitleRequestInput): Promise<string> };
  const original = requests.requestSessionTitle;
  const seen: SessionTitleRequestInput[] = [];
  requests.requestSessionTitle = async input => { seen.push(input); return '{"decision":"set","title":"审批失败排查"}'; };
  try {
    await f.calls[0].request({ systemPrompt: '', userPrompt: 'public-material', signal: new AbortController().signal, token: 'claim' });
  } finally { requests.requestSessionTitle = original; }
  assert.deepEqual(loaded, [f.a.id]);
  assert.equal(seen[0].sessionId, f.a.id);
  assert.equal(seen[0].parentRequest.model.id, 'main-a');
  assert.equal(seen[0].parentRequest.sourceConfig!.sourceId, 'source-a');
  assert.equal(seen[0].userPrompt, 'public-material');
  assert.equal(f.store.activeSessionId, f.b.id);
});

for (const fail of [false, true]) {
  test(`production send wrapper gates title dispatch until its final save ${fail ? 'fails' : 'succeeds'}`, async () => {
    const f = fixture();
    const saved = deferred<void>(), startedSaving = deferred<void>();
    f.store.persist = async () => { startedSaving.resolve(); await saved.promise; };
    Object.assign(f.host, { sendPromptImpl: async (_prompt: string, _source: string, _model: string, _settings: unknown,
      options: { userTask: NonNullable<ChatMessage['userTask']> }) => {
      const task = options.userTask;
      const message = turn(f.a, task.id);
      f.a.messages[0].id = task.originMessageId;
      f.a.messages[0].userTask = task;
      f.a.messages[0].contextMeta = { isProtected: true, protectedReason: 'first_user_request' };
      f.a.messages[0].userTask = task;
      message.userTask = task;
      f.host.rememberSessionTitleCompletion(f.a, message, {} as AgentResponse, f.parent);
      return {} as AgentResponse;
    } });
    const sent = f.host.sendPrompt('排查审批失败', 'source-a', 'main-a');
    await startedSaving.promise;
    assert.equal(f.host.isStartingRun, true, 'necessary final persistence retains admission ownership');
    const saving = f.host.interactions.snapshot({ sessionId: f.a.id, revision: 1, sessionReady: true,
      requestContextReady: true, approvalDataReady: true, cancellable: true });
    assert.equal(saving.phase, 'saving');
    assert.equal(saving.canSubmit, false);
    assert.equal(saving.canCancel, false, 'final persistence has no model cancellation target');
    await f.host.maybeAutoContinueDraftRun();
    assert.equal(f.calls.length, 0, 'a timer running during persistence cannot dispatch title');
    if (fail) saved.reject(new Error('simulated storage failure'));
    else saved.resolve();
    await sent;
    await f.host.maybeAutoContinueDraftRun();
    assert.equal(f.calls.length, fail ? 0 : 1);
    assert.equal(f.host.sessionTitleCandidates.size, 0);
  });
}

async function coordinatorFixture() {
  const scope = { key: 'workspace:title-integration', name: 'Title integration', folderUris: [] };
  const initial = createEmptySession('en', scope);
  initial.title = 'Initial title';
  let saved: StoredWorkspaceSessionState = { activeSessionId: initial.id, sessions: [initial] };
  const storage = {
    loadWorkspace: async () => structuredClone(saved),
    saveWorkspace: async (_scope: unknown, next: StoredWorkspaceSessionState) => { saved = structuredClone(next); },
    listAllWorkspaceSummaries: async () => [],
    loadWorkspaceSessions: async () => structuredClone(saved.sessions),
    deleteWorkspaceSessions: async () => {}, deleteEntireWorkspace: async () => {}, cleanupExpiredSessions: async () => false
  };
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const session = store.getActiveSession();
  return { session, store, storage, scope, coordinator: new SessionTitleCoordinator(store), saved: () => saved };
}

const named = '{"decision":"set","title":"审批失败排查"}';
const deferTitle = '{"decision":"defer","title":null}';

test('coordinator commits the third valid round once and keeps its stop across append and restart', async () => {
  const f = await coordinatorFixture();
  let requests = 0;
  const outcomes = [deferTitle, 'invalid JSON', named];
  for (let index = 0; index < outcomes.length; index++) {
    turn(f.session, `root-${index}`);
    await f.store.persist();
    await f.coordinator.completeResult(f.session.id, `root-${index}`, async () => { requests++; return outcomes[index]; });
  }
  assert.equal(requests, 3);
  assert.equal(f.session.title, '审批失败排查');
  assert.equal(f.session.autoTitle?.stopped, 'named');
  for (let index = 3; index < 8; index++) {
    turn(f.session, `root-${index}`);
    await f.store.persist();
    await f.coordinator.completeResult(f.session.id, `root-${index}`, async () => { requests++; return named; });
  }
  const restarted = new ChatSessionStore(f.storage, 'en', f.scope);
  await restarted.initialize();
  await new SessionTitleCoordinator(restarted).completeResult(f.session.id, 'root-7', async () => { requests++; return named; });
  assert.equal(requests, 3);
  assert.equal(f.saved().sessions.find(session => session.id === f.session.id)?.autoTitle?.stopped, 'named');
});

test('new real user input does not cancel an earlier title request or invalidate its selected material', async () => {
  const f = await coordinatorFixture();
  turn(f.session, 'first');
  await f.store.persist();
  const started = deferred<void>(), response = deferred<string>();
  let signal: AbortSignal | undefined;
  let requests = 0;
  const first = f.coordinator.completeResult(f.session.id, 'first', async input => {
    requests++; signal = input.signal; started.resolve(); return response.promise;
  });
  await started.promise;
  turn(f.session, 'second');
  await f.store.persist();
  assert.equal(signal?.aborted, false);
  assert.deepEqual(await f.coordinator.completeResult(f.session.id, 'second', async () => { requests++; return named; }), { outcome: 'busy' });
  response.resolve(named);
  assert.deepEqual(await first, { outcome: 'updated' });
  await f.coordinator.completeResult(f.session.id, 'second', async () => { requests++; return named; });
  assert.equal(requests, 1);
  assert.equal(f.session.autoTitle?.stopped, 'named');
});

test('manual refresh preempts automatic work and old response/finally cannot clear its replacement slot', async () => {
  const f = await coordinatorFixture();
  turn(f.session, 'first');
  await f.store.persist();
  const autoStarted = deferred<void>(), autoResponse = deferred<string>();
  const manualStarted = deferred<void>(), manualResponse = deferred<string>();
  let automaticSignal: AbortSignal | undefined;
  const automatic = f.coordinator.completeResult(f.session.id, 'first', async input => {
    automaticSignal = input.signal; autoStarted.resolve(); return autoResponse.promise;
  });
  await autoStarted.promise;
  const manual = f.coordinator.regenerateResult(f.session.id, 'first', async () => {
    manualStarted.resolve(); return manualResponse.promise;
  }, buildSessionTitleRegenerationMaterial(f.session.messages, 'first')!);
  await manualStarted.promise;
  assert.equal(automaticSignal?.aborted, true);
  autoResponse.resolve('{"decision":"set","title":"旧自动标题"}');
  assert.deepEqual(await automatic, { outcome: 'cancelled' });
  assert.equal(f.coordinator.isRunning(f.session.id), true);
  assert.equal(f.coordinator.runningCount, 1);
  assert.deepEqual(await f.coordinator.regenerateResult(f.session.id, 'first', async () => { throw new Error('duplicate manual request'); },
    buildSessionTitleRegenerationMaterial(f.session.messages, 'first')!), { outcome: 'busy' });
  manualResponse.resolve(named);
  assert.deepEqual(await manual, { outcome: 'updated' });
  assert.equal(f.coordinator.runningCount, 0);
  assert.equal(f.session.title, '审批失败排查');
  assert.equal(f.session.autoTitle?.stopped, 'named');
});

const settleHost = () => new Promise<void>(resolve => setImmediate(resolve));

test('production queue preserves three completed rounds during in-flight work and stops after first set', async () => {
  const f = fixture();
  const replies = [deferred<{ outcome: string }>(), deferred<{ outcome: string }>(), deferred<{ outcome: string }>()];
  const order: string[] = [];
  f.host.sessionTitles.completeResult = async (_sessionId, taskId) => {
    const index = order.push(taskId) - 1;
    assert.ok(index < replies.length, 'first successful title must clear subsequent automatic work');
    return replies[index].promise;
  };
  for (const taskId of ['one', 'two', 'three']) {
    const message = turn(f.a, taskId);
    f.host.rememberSessionTitleCompletion(f.a, message, {} as AgentResponse, f.parent);
    f.host.sessionTitleCandidates.get(f.a.id)!.get(taskId)!.durable = true;
    f.host.flushSessionTitleCompletions();
  }
  assert.deepEqual(order, ['one']);
  assert.equal(f.host.sessionTitleCandidates.get(f.a.id)?.size, 3);
  replies[0].resolve({ outcome: 'no_material' });
  await settleHost();
  assert.deepEqual(order, ['one', 'two']);
  replies[1].resolve({ outcome: 'invalid' });
  await settleHost();
  assert.deepEqual(order, ['one', 'two', 'three']);
  const fourth = turn(f.a, 'four');
  f.host.rememberSessionTitleCompletion(f.a, fourth, {} as AgentResponse, f.parent);
  f.host.sessionTitleCandidates.get(f.a.id)!.get('four')!.durable = true;
  f.a.title = '审批失败排查';
  f.a.autoTitle = { version: 2, status: 'completed', stopped: 'named', revision: 0 };
  replies[2].resolve({ outcome: 'updated' });
  await settleHost();
  f.host.flushSessionTitleCompletions();
  assert.deepEqual(order, ['one', 'two', 'three']);
  assert.equal(f.host.sessionTitleCandidates.size, 0);
});

test('production busy is not candidate consumption and a later settled drain retries admission only', async () => {
  const f = fixture();
  const message = turn(f.a);
  f.host.rememberSessionTitleCompletion(f.a, message, {} as AgentResponse, f.parent);
  f.host.sessionTitleCandidates.get(f.a.id)!.get('root')!.durable = true;
  let busy = false, admissions = 0, requests = 0;
  f.host.sessionTitles.isRunning = () => busy;
  f.host.sessionTitles.completeResult = async () => {
    admissions++;
    if (admissions === 1) { busy = true; return { outcome: 'busy' }; }
    requests++;
    return { outcome: 'no_material' };
  };
  f.host.flushSessionTitleCompletions();
  await settleHost();
  assert.equal(admissions, 1);
  assert.equal(requests, 0);
  assert.equal(f.host.sessionTitleCandidates.get(f.a.id)?.size, 1);
  busy = false;
  f.host.flushSessionTitleCompletions();
  await settleHost();
  assert.equal(admissions, 2);
  assert.equal(requests, 1);
  assert.equal(f.host.sessionTitleCandidates.size, 0);
});

test('production title scheduling is independent of Skills readiness and unrelated interaction failures', async () => {
  const f = fixture();
  Object.assign(f.host, { requestContextReady: false, interactionFailure: { sessionId: f.a.id, message: 'Skills unavailable' } });
  const message = turn(f.a);
  f.host.rememberSessionTitleCompletion(f.a, message, {} as AgentResponse, f.parent);
  f.host.sessionTitleCandidates.get(f.a.id)!.get('root')!.durable = true;
  f.host.flushSessionTitleCompletions();
  assert.equal(f.calls.length, 1);
  assert.equal(f.host.isBusy, false);
  assert.equal(f.host.isStartingRun, false);
  await settleHost();
});

test('storage readiness and trust still block production title dispatch', async () => {
  const f = fixture();
  const message = turn(f.a);
  f.host.rememberSessionTitleCompletion(f.a, message, {} as AgentResponse, f.parent);
  f.host.sessionTitleCandidates.get(f.a.id)!.get('root')!.durable = true;
  Object.assign(f.host, { sessionReady: false });
  f.host.flushSessionTitleCompletions();
  assert.equal(f.calls.length, 0);
  assert.equal(f.host.sessionTitleCandidates.get(f.a.id)?.size, 1);
  Object.assign(f.host, { sessionReady: true });
  const trusted = vscode.workspace.isTrusted;
  try {
    vscode.workspace.isTrusted = false;
    f.host.flushSessionTitleCompletions();
    assert.equal(f.calls.length, 0);
    assert.equal(f.host.sessionTitleCandidates.size, 0);
  } finally { vscode.workspace.isTrusted = trusted; }
  await settleHost();
});

test('same-root continuation reads the settled title reservation before checking its last physical request allowance', async () => {
  const f = fixture();
  const message = turn(f.a, 'last-allowance');
  const budget = createManualSessionTitleBudget();
  f.a.userTaskBudgets = { 'last-allowance': budget };
  f.host.rememberSessionTitleCompletion(f.a, message, {} as AgentResponse, f.parent);
  f.host.sessionTitleCandidates.get(f.a.id)!.get('last-allowance')!.durable = true;
  const started = deferred<void>(), response = deferred<void>();
  let physicalPosts = 0, resumeLoaded = false;
  const requests = require('../src/provider/sessionTitleRequest') as { requestSessionTitle(input: SessionTitleRequestInput): Promise<string> };
  const original = requests.requestSessionTitle;
  requests.requestSessionTitle = async input => {
    const restored = restoreSessionTitleBudget(input.taskBudget);
    restored.run.reservePhysicalRequest(100, 512);
    await input.onBudgetChanged?.({ ...input.taskBudget, runBudget: { ...restored.run.state } });
    physicalPosts++;
    started.resolve();
    await response.promise;
    // Cancellation/no reported usage never refunds this physical POST.
    await input.onBudgetChanged?.({ ...input.taskBudget, runBudget: { ...restored.run.state } });
    return deferTitle;
  };
  f.host.sessionTitles.completeResult = async (_sessionId, _taskId, request) => {
    await request({ systemPrompt: '', userPrompt: 'selected material', signal: new AbortController().signal, token: 'claim' });
    return { outcome: 'no_material' };
  };
  try {
    f.host.flushSessionTitleCompletions();
    await started.promise;
    const resumed = f.host.loadTaskBudget(f.a, message.userTask!).then(current => {
      resumeLoaded = true;
      return current;
    });
    await settleHost();
    assert.equal(resumeLoaded, false, 'continuation cannot admit from a snapshot preceding the title reservation');
    assert.equal(f.a.userTaskBudgets!['last-allowance'].runBudget!.modelRequests, 1);
    response.resolve();
    const current = await resumed;
    assert.equal(resumeLoaded, true);
    assert.throws(() => restoreSessionTitleBudget(current!), /model_request_budget_exhausted/u);
    assert.equal(physicalPosts, 1);
    assert.equal(f.a.userTaskBudgets!['last-allowance'].runBudget!.modelRequests, 1);
  } finally { requests.requestSessionTitle = original; }
});
