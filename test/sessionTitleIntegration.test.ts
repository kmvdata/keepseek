import './registerVscodeStub';
import assert from 'node:assert/strict';
import { sessionUseFixture } from './sessionUseFixture';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { InteractionCoordinator } from '../src/provider/interactionState';
import { DelegatedApprovalQueue } from '../src/agent/approvalMode';
import { ChatSessionStore, createEmptySession, type StoredWorkspaceSessionState } from '../src/sessions/chatSessionStore';
import { SessionTitleCoordinator } from '../src/sessions/sessionTitleCoordinator';
import { buildSessionTitleRegenerationMaterial } from '../src/sessions/sessionTitle';
import type { SessionTitleSubmission } from '../src/provider/sessionTitleCompletion';
import type { SessionTitleRequestInput } from '../src/provider/sessionTitleRequest';
import type { SessionTitleRequest } from '../src/sessions/sessionTitleCoordinator';
import type { UserTaskBudget } from '../src/sessions/userTaskBudget';
import type { AgentRequest, AgentResponse, ChatMessage, ChatSession } from '../src/shared/types';

type Parent = Pick<AgentRequest, 'model' | 'sourceConfig'>;
type Candidate = { submission: SessionTitleSubmission; parentRequest: Parent; durable: boolean };
type Host = {
  rememberSessionTitleSubmission(session: ChatSession, message: ChatMessage, parent: Parent): void;
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

function turn(session: ChatSession, taskId = 'root') {
  const task = { version: 1 as const, id: taskId, originMessageId: `user-${taskId}`, reason: 'user' as const };
  const existing = session.messages.find(message => message.id === task.originMessageId);
  if (existing) return existing;
  const user: ChatMessage = { id: task.originMessageId, role: 'user', content: `排查 KeepSeek 审批失败 ${taskId}`, createdAt: '', userTask: task };
  session.messages.push(user);
  return user;
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
  const store = { ...sessionUseFixture(), activeSessionId: a.id, workspaceKey: 'workspace', getSessionById: (id: string) => sessions.get(id),
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

test('a durable accepted user input dispatches immediately while the main answer is still pending', async () => {
  const f = fixture();
  const user = turn(f.a);
  f.a.messages.push({ id: 'pending-answer', role: 'assistant', content: '', createdAt: '', userTask: user.userTask, isStreaming: true });
  Object.assign(f.host, { isBusy: true });
  const owner = f.host.interactions.begin('task', f.a.id, 'running')!;
  try {
    await f.store.persist();
    f.host.rememberSessionTitleSubmission(f.a, user, f.parent);
    f.host.flushSessionTitleCompletions();
    f.host.flushSessionTitleCompletions();
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].taskId, 'root');
    assert.equal(f.host.isBusy, true, 'naming never takes over the foreground task');
    assert.equal(f.host.interactions.current, owner);
    assert.equal(f.a.messages.at(-1)?.isStreaming, true);
  } finally { f.host.interactions.finish(owner); }
});

test('internal approval, command, plan and repair inputs never manufacture title submissions', async () => {
  const f = fixture();
  const user = turn(f.a);
  for (const reason of ['approval', 'command', 'plan', 'repair', 'recovery'] as const) {
    const internal: ChatMessage = { id: `internal-${reason}`, role: 'user', content: 'HOST_CONTINUATION_SECRET', createdAt: '',
      userTask: { ...user.userTask!, reason },
      contextMeta: { isProtected: true, protectedReason: 'delegated_approval_result', displayKind: 'delegated_auto_continue' } };
    f.a.messages.push(internal);
    f.host.rememberSessionTitleSubmission(f.a, internal, f.parent);
  }
  f.a.messages.push({ id: 'raw-assistant', role: 'assistant', content: 'ASSISTANT_SECRET', createdAt: '', userTask: user.userTask });
  f.host.rememberSessionTitleSubmission(f.a, f.a.messages.at(-1)!, f.parent);
  f.host.flushSessionTitleCompletions();
  assert.equal(f.calls.length, 0);
  f.host.rememberSessionTitleSubmission(f.a, user, f.parent);
  f.host.flushSessionTitleCompletions();
  assert.equal(f.calls.length, 1);
  await f.host.maybeAutoContinueDraftRun();
  assert.equal(f.calls.length, 1, 'continuation drains do not create another observed user submission');
});

test('switching to B preserves A source snapshot and loads/publishes only A task budget', async () => {
  const f = fixture();
  const message = turn(f.a);
  f.host.rememberSessionTitleSubmission(f.a, message, f.parent);
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
  test(`an accepted user purpose stays eligible while the outer final save ${fail ? 'fails' : 'succeeds'}`, async () => {
    const f = fixture();
    const saved = deferred<void>(), startedSaving = deferred<void>();
    let userAccepted = false;
    f.store.persist = async () => { startedSaving.resolve(); await saved.promise; };
    Object.assign(f.host, { sendPromptImpl: async (_prompt: string, _source: string, _model: string, _settings: unknown,
      options: { userTask: NonNullable<ChatMessage['userTask']> }) => {
      const user: ChatMessage = { id: options.userTask.originMessageId, role: 'user', content: '排查审批失败', createdAt: '', userTask: options.userTask };
      f.a.messages.push(user);
      // This stub represents the already-confirmed initial user persistence;
      // the real send path's initial barrier is tested in regeneration tests.
      userAccepted = true;
      f.host.rememberSessionTitleSubmission(f.a, user, f.parent);
      f.host.flushSessionTitleCompletions();
      assert.equal(f.calls.length, 1, 'a final assistant/persistence event is not needed');
      return {} as AgentResponse;
    } });
    const sent = f.host.sendPrompt('排查审批失败', 'source-a', 'main-a');
    await startedSaving.promise;
    assert.equal(userAccepted, true);
    assert.equal(f.calls.length, 1);
    if (fail) saved.reject(new Error('simulated final response storage failure'));
    else saved.resolve();
    await sent;
    await f.host.maybeAutoContinueDraftRun();
    assert.equal(f.calls.length, 1, 'the accepted input opportunity is independent of final answer durability');
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

test('production queue preserves three accepted user inputs during in-flight work and stops after first set', async () => {
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
    f.host.rememberSessionTitleSubmission(f.a, message, f.parent);
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
  f.host.rememberSessionTitleSubmission(f.a, fourth, f.parent);
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
  f.host.rememberSessionTitleSubmission(f.a, message, f.parent);
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
  f.host.rememberSessionTitleSubmission(f.a, message, f.parent);
  f.host.flushSessionTitleCompletions();
  assert.equal(f.calls.length, 1);
  assert.equal(f.host.isBusy, false);
  assert.equal(f.host.isStartingRun, false);
  await settleHost();
});

test('storage readiness and trust still block production title dispatch', async () => {
  const f = fixture();
  const message = turn(f.a);
  f.host.rememberSessionTitleSubmission(f.a, message, f.parent);
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

test('a pending main runtime, queued approval and tool work do not delay an accepted input title', async () => {
  const f = fixture();
  const user = turn(f.a, 'parallel-purpose');
  Object.assign(f.host, { isBusy: true, delegatedApprovalInFlight: true, draftRunAutoContinueInFlight: true,
    activeChangeActions: new Set(['pending-apply']), taskClock: { owns: () => true } });
  f.queue.enqueue({ sessionId: f.a.id, rootTaskId: 'parallel-purpose', runId: 'segment', editIds: ['edit'], draftRunIds: [] });
  f.host.rememberSessionTitleSubmission(f.a, user, f.parent);
  f.host.flushSessionTitleCompletions();
  assert.equal(f.calls.length, 1, 'the accepted user body is already the complete title material');
  assert.equal(f.host.isBusy, true);
  await settleHost();
});
