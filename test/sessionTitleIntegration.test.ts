import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { InteractionCoordinator } from '../src/provider/interactionState';
import { DelegatedApprovalQueue } from '../src/agent/approvalMode';
import { createEmptySession } from '../src/sessions/chatSessionStore';
import type { SessionTitleCompletion } from '../src/provider/sessionTitleCompletion';
import type { SessionTitleRequestInput } from '../src/provider/sessionTitleRequest';
import type { SessionTitleRequest } from '../src/sessions/sessionTitleCoordinator';
import type { UserTaskBudget } from '../src/sessions/userTaskBudget';
import type { AgentRequest, AgentResponse, ChatMessage, ChatSession } from '../src/shared/types';

type Parent = Pick<AgentRequest, 'model' | 'sourceConfig'>;
type Candidate = { completion: SessionTitleCompletion; parentRequest: Parent; durable: boolean };
type Host = {
  rememberSessionTitleCompletion(session: ChatSession, message: ChatMessage, response: AgentResponse, parent: Parent): void;
  flushSessionTitleCompletions(): void;
  maybeAutoContinueDraftRun(): Promise<void>;
  sendPrompt(prompt: string, sourceId: string, modelId: string): Promise<AgentResponse | undefined>;
  sessionTitleCandidates: Map<string, Candidate>;
  sessionTitles: {
    complete(sessionId: string, taskId: string, request: (input: SessionTitleRequest) => Promise<string>): Promise<boolean>;
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
    sessionTitles: { complete: async (sessionId: string, taskId: string, request: (input: SessionTitleRequest) => Promise<string>) => {
      calls.push({ sessionId, taskId, request }); return true;
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
  f.host.sessionTitleCandidates.get(f.a.id)!.durable = true;
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
    f.host.sessionTitleCandidates.get(f.a.id)!.durable = true;
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
  f.host.sessionTitleCandidates.get(f.a.id)!.durable = true;
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
