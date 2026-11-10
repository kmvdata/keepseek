import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from './stubs/vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore, HISTORY_SESSION_LOAD_TIMEOUT_MS, type StoredWorkspaceSessionState } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import type { SessionTitleCoordinator } from '../src/sessions/sessionTitleCoordinator';
import type { SharedProjectSources } from '../src/context/sharedProjectSources';
import type { SkillStore } from '../src/skills/skillStore';
import type { InteractionCoordinator, InteractionSnapshot } from '../src/provider/interactionState';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import type { AgentResponse, ChatMessage, ChatSession } from '../src/shared/types';
import { localize, type KeepseekLanguage } from '../src/shared/i18n';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

interface NavigationHost {
  handleMessage(message: WebviewMessage): Promise<void>;
  initializeAfterWebviewReady(): Promise<void>;
  ensureSessionNavigationReady(): Promise<void>;
  refreshWorkspaceScope(): Promise<void>;
  refreshSkills(options?: { post?: boolean }): Promise<void>;
  postState(options: { immediate?: boolean; forceFull?: boolean }): void;
  isStartingRun: boolean;
  isBusy: boolean;
  sessionReady: boolean;
  approvalDataReady: boolean;
  requestContextReady: boolean;
  sessionRecoveryReady: boolean;
  language: KeepseekLanguage;
  historySessionLoadTimeoutMs: number;
  interactions: InteractionCoordinator;
  activeSessionEntryRevision: number;
  draftRunAutoContinueTimer?: ReturnType<typeof setTimeout>;
  scheduleDraftRunAutoContinuation(): void;
  sessionTitles: SessionTitleCoordinator;
  sharedProjectSources: SharedProjectSources;
  skillStore: SkillStore;
  currentRunContextsBySession: Map<string, unknown>;
  activeRunSettled?: Promise<void>;
  awaitRunContextRefresh(): Promise<boolean>;
  sendPromptImpl(prompt: string, sourceId: string, modelId: string, settings: unknown, options?: {
    userMessageId?: string; userTask?: NonNullable<ChatMessage['userTask']>; onSubmissionAccepted?: () => void;
  }): Promise<AgentResponse | undefined>;
  queueUsageLedgerFlush(session: ChatSession): void;
  recoverSubagentUsage(session: ChatSession): Promise<void>;
  usageLedgerFlushes: Map<string, Promise<void>>;
  usageDisplayReadiness: Map<string, 'loading' | 'ready' | 'incomplete'>;
  changeSets: { loadSession?(sessionId: string): Promise<void> };
  views: Set<unknown>;
}

interface PostedState {
  activeSessionId?: string;
  isBusy?: boolean;
  interaction?: InteractionSnapshot;
  messages?: ChatMessage[];
  usageMetrics?: { displayReadiness?: 'loading' | 'ready' | 'incomplete' };
}

interface HostPost {
  type: string;
  sessionId?: string;
  requestId?: string;
  revision?: number;
  status?: 'accepted' | 'rejected' | 'failed';
  reason?: string;
  state?: PostedState;
}

test('navigation preparation never advertises a running task or a Stop action', async t => {
  const { host, second, publish, posts } = await fixture(t);
  const reading = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const refresh = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
  host.sharedProjectSources.refresh = async (...args) => { reading.resolve(); await release.promise; return refresh(...args); };
  const navigation = host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await reading.promise;
  publish();
  const during = posts.at(-1)?.state as { isBusy?: boolean; interaction?: { phase: string; canCancel: boolean; canSubmit: boolean; canEdit: boolean; canNavigate: boolean } };
  // Capture before releasing the barrier, but always settle the operation even
  // when this regression is run against the old implementation.
  release.resolve();
  await navigation;
  assert.equal(during.isBusy, false, 'context I/O is not a main model task');
  assert.equal(during.interaction?.phase, 'preparing_context');
  assert.equal(during.interaction?.canCancel, false);
  assert.equal(during.interaction?.canSubmit, false);
  assert.equal(during.interaction?.canEdit, true);
  assert.equal(during.interaction?.canNavigate, true, 'context reads no longer own the safely committed navigation');
});

test('safe history selection allows another navigation while old context is pending without releasing the new recovery owner', async t => {
  const { host, store, first, second, posts, publish, errors } = await fixture(t);
  const oldContextEntered = deferred(); const releaseOldContext = deferred();
  const newRecoveryEntered = deferred(); const releaseNewRecovery = deferred();
  t.after(() => { releaseOldContext.resolve(); releaseNewRecovery.resolve(); });
  const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
  let pauseOld = true;
  host.skillStore.resolveAndLoadSkills = async input => {
    const result = await resolveSkills(input);
    if (input.session.id === second.id && pauseOld) {
      pauseOld = false; oldContextEntered.resolve(); await releaseOldContext.promise;
      throw new Error('obsolete history context failed');
    }
    return result;
  };
  const oldNavigation = host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await oldContextEntered.promise;
  publish();
  assert.equal(store.activeSessionId, second.id);
  assert.equal(lastState(posts).interaction?.canNavigate, true);
  assert.equal(lastState(posts).interaction?.canEdit, true);
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  const load = host.changeSets.loadSession!.bind(host.changeSets);
  host.changeSets.loadSession = async sessionId => {
    if (sessionId === first.id) { newRecoveryEntered.resolve(); await releaseNewRecovery.promise; }
    await load(sessionId);
  };
  const newNavigation = host.handleMessage({ type: 'selectSession', sessionId: first.id });
  await newRecoveryEntered.promise;
  publish();
  const owner = lastState(posts).interaction?.operationId;
  assert.ok(owner);
  const entryFloor = host.activeSessionEntryRevision;
  const changedCount = posts.filter(post => post.type === 'sessionChanged').length;
  releaseOldContext.resolve(); await oldNavigation;
  publish();
  assert.equal(store.activeSessionId, first.id);
  assert.equal(lastState(posts).interaction?.operationId, owner, 'old finally cannot release a newer navigation owner');
  assert.equal(lastState(posts).interaction?.canNavigate, false, 'new target operation recovery still owns navigation');
  assert.equal(host.activeSessionEntryRevision, entryFloor, 'old completion cannot create a new entry revision');
  assert.equal(posts.filter(post => post.type === 'sessionChanged').length, changedCount);
  assert.equal(errors.length, 0);
  releaseNewRecovery.resolve(); await newNavigation;
  publish();
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('A to B to A context preparation ignores the previous A generation failure and completion publication', async t => {
  const { host, store, first, second, posts, publish, errors } = await fixture(t);
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
  let pauseFirstA = true;
  host.skillStore.resolveAndLoadSkills = async input => {
    const result = await resolveSkills(input);
    if (input.session.id === first.id && pauseFirstA) {
      pauseFirstA = false; entered.resolve(); await release.promise;
      throw new Error('previous A preparation failed');
    }
    return result;
  };
  const previousA = host.handleMessage({ type: 'selectSession', sessionId: first.id });
  await entered.promise;
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await host.handleMessage({ type: 'selectSession', sessionId: first.id });
  publish();
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  const entryFloor = host.activeSessionEntryRevision;
  const changedCount = posts.filter(post => post.type === 'sessionChanged').length;
  release.resolve(); await previousA;
  publish();
  assert.equal(store.activeSessionId, first.id);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(host.activeSessionEntryRevision, entryFloor);
  assert.equal(posts.filter(post => post.type === 'sessionChanged').length, changedCount);
  assert.equal(errors.length, 0);
});

for (const action of ['newSession', 'copyOtherWorkspaceSession'] as const) {
  test(`${action} releases navigation after safe selection while its context continues loading`, async t => {
    const { host, store, storage, first, publish, posts, errors } = await fixture(t);
    const foreignScope = { key: 'workspace:copy-context', name: 'Copy Context', folderUris: [] };
    const sourceId = 'copy-source';
    if (action === 'copyOtherWorkspaceSession') await storage.saveWorkspace(foreignScope, {
      activeSessionId: sourceId,
      sessions: [{ ...first, id: sourceId, workspaceKey: foreignScope.key, workspaceName: foreignScope.name, workspaceFolders: [] }]
    });
    const entered = deferred(); const release = deferred();
    t.after(() => release.resolve());
    const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
    let pauseTarget = true;
    host.skillStore.resolveAndLoadSkills = async input => {
      const result = await resolveSkills(input);
      if (input.session.id !== first.id && pauseTarget) {
        pauseTarget = false; entered.resolve(); await release.promise;
      }
      return result;
    };
    const preparing = host.handleMessage(action === 'newSession' ? { type: action }
      : { type: action, workspaceKey: foreignScope.key, sessionId: sourceId });
    await entered.promise;
    publish();
    assert.notEqual(store.activeSessionId, first.id);
    assert.equal(lastState(posts).interaction?.canNavigate, true);
    assert.equal(lastState(posts).interaction?.canEdit, true);
    assert.equal(lastState(posts).interaction?.canSubmit, false);
    await host.handleMessage({ type: 'selectSession', sessionId: first.id });
    const entryFloor = host.activeSessionEntryRevision;
    release.resolve(); await preparing;
    publish();
    assert.equal(store.activeSessionId, first.id);
    assert.equal(lastState(posts).interaction?.canSubmit, true);
    assert.equal(host.activeSessionEntryRevision, entryFloor);
    assert.equal(errors.length, 0);
  });
}

test('cold startup context for the previous session cannot hold or overwrite a ready history target', async t => {
  const { host, store, first, second, publish, posts } = await fixture(t, { skipStartup: true });
  const started = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const refresh = host.sharedProjectSources.refresh.bind(host.sharedProjectSources);
  let initial = true;
  host.sharedProjectSources.refresh = async (...args) => {
    const result = await refresh(...args);
    if (args[0] === first.id && initial) {
      initial = false; started.resolve(); await release.promise;
    }
    return result;
  };
  const startup = host.initializeAfterWebviewReady();
  await started.promise;
  await host.ensureSessionNavigationReady();
  assert.equal(host.requestContextReady, false, 'old startup context is still required for the old session');
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  publish();
  assert.equal(store.activeSessionId, second.id);
  assert.equal(lastState(posts).interaction?.canSubmit, true, 'target is ready before the unrelated old promise ends');
  assert.equal(host.sessionRecoveryReady, true);
  release.resolve(); await startup;
  publish();
  assert.equal(lastState(posts).interaction?.canSubmit, true, 'old failure/finally cannot take readiness away');
  assert.equal(host.sharedProjectSources.sessionId, second.id, 'old continuation does not reselect the source facade');
  assert.ok(host.currentRunContextsBySession.has(second.id));
  t.diagnostic(JSON.stringify({ boundary: 'cold-start-history', oldContextPaused: true, targetCanSubmitBeforeRelease: true,
    oldCompletionIgnored: true, sourceReads: host.sharedProjectSources.diagnostics }));
});

for (const action of ['refresh', 'retry'] as const) {
  test(`same-session ${action} owns readiness when the old startup Skill load fails late`, async t => {
    const { host, store, first, publish, posts } = await fixture(t, { skipStartup: true });
    const started = deferred(); const release = deferred();
    t.after(() => release.resolve());
    const resolveSkills = host.skillStore.resolveAndLoadSkills.bind(host.skillStore);
    let initial = true;
    host.skillStore.resolveAndLoadSkills = async input => {
      if (initial) {
        initial = false; started.resolve(); await release.promise;
        throw new Error('old Skill source was superseded');
      }
      return resolveSkills(input);
    };
    const startup = host.initializeAfterWebviewReady();
    await started.promise;
    await host.ensureSessionNavigationReady();
    host.sharedProjectSources.dirty = true;
    if (action === 'refresh') await host.refreshSkills();
    else await host.handleMessage({ type: 'retryInteraction' });
    publish();
    assert.equal(lastState(posts).interaction?.canSubmit, true, 'new preparation completed while old Skill work is paused');
    release.resolve(); await startup;
    publish();
    assert.equal(store.activeSessionId, first.id, 'the race stays within one session');
    assert.equal(lastState(posts).interaction?.canSubmit, true, 'late startup failure cannot replace the new ready state');
    assert.notEqual(lastState(posts).interaction?.phase, 'failed');
  });
}

test('target operation recovery failure is retried before submission becomes available', async t => {
  const { host, second, publish, posts } = await fixture(t);
  const originalLoad = host.changeSets.loadSession!.bind(host.changeSets);
  let attempts = 0;
  host.changeSets.loadSession = async sessionId => {
    if (sessionId === second.id && ++attempts === 1) throw new Error('target recovery read failed');
    await originalLoad(sessionId);
  };
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  publish();
  assert.equal(host.sessionRecoveryReady, false);
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  await host.handleMessage({ type: 'retryInteraction' });
  publish();
  assert.equal(attempts, 2, 'retry reloads the necessary target records');
  assert.equal(host.sessionRecoveryReady, true);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('deleting the active history row restores the replacement session recovery readiness', async t => {
  const { host, store, first, publish, posts } = await fixture(t);
  const previousWarning = vscode.window.showWarningMessage;
  vscode.window.showWarningMessage = async (_message, ...items) => items.find(item => typeof item === 'string') as never;
  t.after(() => { vscode.window.showWarningMessage = previousWarning; });
  await host.handleMessage({ type: 'deleteSessions', sessionIds: [first.id] });
  publish();
  assert.notEqual(store.activeSessionId, first.id);
  assert.equal(host.sessionRecoveryReady, true);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('workspace scope change restores target operations before opening task submission', async t => {
  const { host, store, publish, posts } = await fixture(t);
  const initial = store.activeSessionId;
  await host.refreshWorkspaceScope();
  publish();
  assert.notEqual(store.activeSessionId, initial, 'isolated fixture scope differs from the configured workspace scope');
  assert.equal(host.sessionRecoveryReady, true);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

function messages(taskId: string): ChatMessage[] {
  const userTask = { version: 1 as const, id: taskId, originMessageId: `${taskId}-user`, reason: 'user' as const };
  return [
    { id: `${taskId}-user`, role: 'user', content: '分析 KeepSeek 会话切换', createdAt: new Date().toISOString(), userTask },
    { id: `${taskId}-answer`, role: 'assistant', content: '检查会话存储与状态发布。', createdAt: new Date().toISOString(), userTask }
  ];
}

async function fixture(t: TestContext, options: { delayLoad?: boolean; loadFailure?: boolean; skipStartup?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-session-navigation-'));
  const uri = vscode.Uri.file(root);
  const scope = { key: 'workspace:navigation', name: 'Navigation', folderUris: [] };
  const storage = new GlobalSessionStorage(uri as never);
  const seed = new ChatSessionStore(storage, 'en', scope);
  await seed.initialize();
  const first = seed.getActiveSession();
  first.messages = messages('task-first');
  await seed.persist();
  const second = await seed.createNewSession();
  second.messages = messages('task-second');
  await seed.persist();
  await seed.selectSession(first.id);

  const loadStarted = deferred();
  const releaseLoad = deferred();
  const originalLoad = storage.loadWorkspace.bind(storage);
  if (options.delayLoad) storage.loadWorkspace = async input => {
    const snapshot = await originalLoad(input);
    loadStarted.resolve();
    await releaseLoad.promise;
    if (options.loadFailure) throw new Error('injected session load failure');
    return snapshot;
  };
  const store = new ChatSessionStore(storage, 'en', scope);
  const initialization = store.initialize();
  void initialization.catch(() => undefined);
  if (!options.delayLoad) await initialization;
  else await loadStarted.promise;

  const previousWindow = { ...vscode.window };
  const previousStatusBarFactory = (vscode.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  const errors: string[] = [];
  const informations: string[] = [];
  Object.assign(vscode, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showErrorMessage: async (error: string) => { errors.push(error); },
    showInformationMessage: async (message: string) => { informations.push(message); return undefined; }
  });
  const provider = new KeepseekChatViewProvider(uri as never, store, uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    initialization);
  const host = provider as unknown as NavigationHost;
  const posts: HostPost[] = [];
  host.views.add({ webview: { postMessage(message: typeof posts[number]) { posts.push(message); return Promise.resolve(true); } } });
  t.after(async () => {
    releaseLoad.resolve();
    await initialization.catch(() => undefined);
    provider.dispose();
    await storage.cleanupExpiredSessions({ currentWorkspaceKey: scope.key, currentActiveSessionId: store.activeSessionId });
    await storage.flush();
    Object.assign(vscode.window, previousWindow);
    if (previousStatusBarFactory === undefined) delete (vscode.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
    if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
    else Object.assign(vscode, { StatusBarAlignment: previousAlignment });
    await rm(root, { recursive: true, force: true });
  });
  if (!options.delayLoad && !options.skipStartup) await host.initializeAfterWebviewReady();
  const publish = () => host.postState({ immediate: true, forceFull: true });
  return { host, store, storage, scope, first, second, posts, errors, informations, releaseLoad, initialization, publish };
}

/** The real Host admission, ownership and final persistence remain in use. */
function acceptedRun(host: NavigationHost, store: ChatSessionStore) {
  const calls: Array<{ prompt: string; sessionId: string; rootTaskId: string }> = [];
  host.sendPromptImpl = async (prompt, _source, _model, _settings, options) => {
    assert.ok(options?.userMessageId && options.userTask);
    const session = store.getActiveSession();
    calls.push({ prompt, sessionId: session.id, rootTaskId: options.userTask.id });
    session.messages.push({ id: options.userMessageId, role: 'user', content: prompt,
      createdAt: new Date(0).toISOString(), userTask: options.userTask });
    options.onSubmissionAccepted?.();
    return { message: 'controlled response', draftEdits: [] } as unknown as AgentResponse;
  };
  return calls;
}

function submission(sessionId: string, requestId: string, messageId?: string): Extract<WebviewMessage, { type: 'sendPrompt' | 'editUserPrompt' }> {
  const shared = { sessionId, requestId, prompt: `Question ${requestId}`, sourceId: 'test-source', modelId: 'test-model' };
  return messageId ? { type: 'editUserPrompt', messageId, ...shared } : { type: 'sendPrompt', ...shared };
}

function lastState(posts: readonly HostPost[]): PostedState {
  const state = [...posts].reverse().find(post => Boolean(post.state))?.state;
  assert.ok(state);
  return state;
}

for (const kind of ['sendPrompt', 'editUserPrompt'] as const) {
  test(`${kind} reserves before its first context await; duplicates and navigation cannot cross it`, async t => {
    const { host, store, first, second, posts, publish } = await fixture(t);
    const entered = deferred();
    const release = deferred<boolean>();
    t.after(() => release.resolve(true));
    host.awaitRunContextRefresh = async () => { entered.resolve(); return release.promise; };
    const calls = acceptedRun(host, store);
    const request = submission(first.id, 'original', kind === 'editUserPrompt' ? first.messages[0].id : undefined);
    const running = host.handleMessage(request);
    await entered.promise;
    try {
      await host.handleMessage(request); // Same transport request is still pending.
      await host.handleMessage(submission(first.id, 'conflicting-send'));
      await host.handleMessage(submission(first.id, 'conflicting-edit', first.messages[0].id));
      await host.handleMessage({ type: 'selectSession', sessionId: second.id });
      await host.handleMessage({ type: 'newSession' });
      publish();
      const pending = lastState(posts);
      assert.equal(pending.interaction?.phase, 'preparing_task');
      assert.equal(pending.interaction?.canSubmit, false);
      assert.equal(pending.interaction?.canNavigate, false);
      assert.equal(pending.interaction?.canEdit, true);
      assert.equal(store.activeSessionId, first.id);
      assert.equal(calls.length, 0, 'nothing dispatches before the required context barrier');
      assert.deepEqual(posts.filter(post => post.type === 'submissionResult').map(post => [post.requestId, post.status]),
        [['conflicting-send', 'rejected'], ['conflicting-edit', 'rejected']]);
    } finally { release.resolve(true); await running; }
    assert.equal(calls.length, 1);
    assert.equal(calls[0].sessionId, first.id);
    assert.equal(posts.filter(post => post.type === 'submissionResult' && post.requestId === 'original' && post.status === 'accepted').length, 1);
    await host.handleMessage(request);
    assert.equal(calls.length, 1, 'replaying accepted transport feedback never reruns the task');
    publish();
    assert.equal(lastState(posts).interaction?.canSubmit, true);
    t.diagnostic(JSON.stringify({ boundary: 'first-context-await', request: kind, acceptedTasks: calls.length,
      pendingPhase: 'preparing_task', navigationCommitted: false, finalPhase: lastState(posts).interaction?.phase }));
  });
}

test('request feedback closes wrong-session, unready and failed admission without consuming another request', async t => {
  const { host, store, first, second, posts, publish } = await fixture(t);
  const calls = acceptedRun(host, store);
  await host.handleMessage(submission(second.id, 'wrong-session'));
  host.requestContextReady = false;
  await host.handleMessage(submission(first.id, 'not-ready'));
  host.requestContextReady = true;
  await host.handleMessage(submission(first.id, 'not-ready')); // Repeated old rejection is idempotent.
  assert.equal(calls.length, 0);
  const original = host.sendPromptImpl;
  host.sendPromptImpl = async () => { throw new Error('injected preparation failure'); };
  await host.handleMessage(submission(first.id, 'failed-preparation'));
  host.sendPromptImpl = original;
  await host.handleMessage(submission(first.id, 'valid-next-request'));
  assert.deepEqual(posts.filter(post => post.type === 'submissionResult').map(post => [post.sessionId, post.requestId, post.status]), [
    [second.id, 'wrong-session', 'rejected'], [first.id, 'not-ready', 'rejected'], [first.id, 'not-ready', 'rejected'],
    [first.id, 'failed-preparation', 'failed'], [first.id, 'valid-next-request', 'accepted']
  ]);
  assert.match(posts.find(post => post.requestId === 'failed-preparation')?.reason ?? '', /injected preparation failure/u);
  assert.equal(calls.length, 1);
  assert.equal(store.activeSessionId, first.id);
  publish();
  assert.equal(lastState(posts).interaction?.phase, 'idle');
});

test('a preparation cancel must match its owner and cannot release still-pending context I/O', async t => {
  const { host, store, first, second, posts, publish } = await fixture(t);
  const entered = deferred();
  const release = deferred<boolean>();
  t.after(() => release.resolve(true));
  host.awaitRunContextRefresh = async () => { entered.resolve(); return release.promise; };
  const calls = acceptedRun(host, store);
  const before = store.getActiveSession().messages.length;
  const pending = host.handleMessage(submission(first.id, 'cancel-preparation'));
  await entered.promise;
  try {
    publish();
    const owner = lastState(posts).interaction?.cancelOperationId;
    assert.ok(owner);
    await host.handleMessage({ type: 'abortPrompt', sessionId: first.id, operationId: 'old-operation' });
    publish();
    assert.equal(lastState(posts).interaction?.canCancel, true, 'a stale Stop cannot cancel the current owner');
    await host.handleMessage({ type: 'abortPrompt', sessionId: first.id, operationId: owner });
    publish();
    const stopping = lastState(posts);
    assert.equal(stopping.interaction?.canCancel, false);
    assert.equal(stopping.interaction?.canSubmit, false, 'an abort signal cannot prove the pending read has settled');
    await host.handleMessage({ type: 'selectSession', sessionId: second.id });
    assert.equal(store.activeSessionId, first.id);
  } finally { release.resolve(true); await pending; }
  assert.equal(calls.length, 0);
  assert.equal(store.getActiveSession().messages.length, before);
  assert.equal(posts.find(post => post.requestId === 'cancel-preparation')?.status, 'rejected');
  assert.equal(lastState(posts).interaction?.phase, 'idle');
});

test('rapid history navigation drops concurrent targets and persists the same final selection it displays', async t => {
  const { host, store, storage, scope, first, second, posts } = await fixture(t);
  const entered = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const save = storage.saveWorkspace.bind(storage);
  storage.saveWorkspace = async (...args) => { entered.resolve(); await release.promise; return save(...args); };
  const navigating = host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await entered.promise;
  try {
    await host.handleMessage({ type: 'selectSession', sessionId: first.id });
    await host.handleMessage({ type: 'selectSession', sessionId: second.id });
    await host.handleMessage({ type: 'newSession' });
    assert.equal(store.activeSessionId, second.id, 'selection persistence retains navigation ownership');
  } finally { release.resolve(); await navigating; }
  await host.handleMessage({ type: 'selectSession', sessionId: first.id });
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  assert.equal(store.activeSessionId, second.id);
  assert.equal(lastState(posts).activeSessionId, second.id);
  const durable = await storage.loadWorkspace(scope);
  assert.equal(durable?.activeSessionId, second.id);
  assert.equal(durable.sessionSummaries?.length, 2, 'ignored concurrent New never created a hidden third session');
});

test('final durability keeps admission and settlement pending with Saving, then releases in the same state update', async t => {
  const { host, store, first, second, posts, publish } = await fixture(t);
  const calls = acceptedRun(host, store);
  const saving = deferred();
  const release = deferred();
  t.after(() => release.resolve());
  const persist = store.persist.bind(store);
  store.persist = async (...args) => { saving.resolve(); await release.promise; await persist(...args); };
  const running = host.handleMessage(submission(first.id, 'slow-final-save'));
  await saving.promise;
  const settled = host.activeRunSettled;
  assert.ok(settled);
  let completed = false;
  void settled.then(() => { completed = true; });
  try {
    publish();
    const during = lastState(posts);
    assert.equal(during.isBusy, false);
    assert.equal(during.interaction?.phase, 'saving');
    assert.equal(during.interaction?.canCancel, false);
    assert.equal(during.interaction?.canSubmit, false);
    await host.handleMessage(submission(first.id, 'during-save'));
    await host.handleMessage({ type: 'selectSession', sessionId: second.id });
    await Promise.resolve();
    assert.equal(completed, false, 'scope changes must still await necessary durability');
    assert.equal(store.activeSessionId, first.id);
    assert.equal(calls.length, 1);
  } finally { release.resolve(); await running; }
  assert.equal(completed, true);
  assert.equal(host.activeRunSettled, undefined);
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(posts.find(post => post.requestId === 'during-save')?.status, 'rejected');
  t.diagnostic(JSON.stringify({ boundary: 'final-durability', modelFinished: true, phaseUntilWrite: 'saving',
    cancelAvailable: false, settledBeforeWrite: false, terminalPhase: lastState(posts).interaction?.phase }));
});

test('failed final durability preserves accepted content and retry saves it without rerunning the model', async t => {
  const { host, store, storage, scope, first, posts, publish } = await fixture(t);
  const calls = acceptedRun(host, store);
  const persist = store.persist.bind(store);
  let fail = true;
  store.persist = async (...args) => { if (fail) throw new Error('injected final write failure'); await persist(...args); };
  await host.handleMessage(submission(first.id, 'save-failure'));
  publish();
  const failed = lastState(posts);
  assert.equal(failed.interaction?.phase, 'failed');
  assert.equal(failed.interaction?.canSubmit, false);
  assert.equal(failed.interaction?.canCancel, false);
  assert.match(failed.interaction?.blockingReason ?? '', /injected final write failure/u);
  assert.ok(store.getActiveSession().messages.some(message => message.content === 'Question save-failure'));
  assert.equal(posts.find(post => post.requestId === 'save-failure')?.status, 'accepted');
  await host.handleMessage(submission(first.id, 'blocked-by-write'));
  assert.equal(calls.length, 1);
  fail = false;
  await host.handleMessage({ type: 'retryInteraction' });
  assert.equal(calls.length, 1, 'retry has no model or side-effect execution');
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  const durable = await storage.loadWorkspace(scope);
  assert.ok(durable.sessions[0].messages.some(message => message.content === 'Question save-failure'),
    'retry really commits the retained accepted content to temporary session storage');
});

test('display ledger and child summaries can stay pending while critical operation recovery controls readiness', async t => {
  const { host, store, first, second, posts, publish } = await fixture(t);
  const ledger = deferred();
  const summaries = deferred();
  const recovery = deferred();
  const recoveryStarted = deferred();
  t.after(() => { ledger.resolve(); summaries.resolve(); recovery.resolve(); });
  let ledgerReads = 0, summaryReads = 0;
  host.queueUsageLedgerFlush = session => { ledgerReads++; host.usageLedgerFlushes.set(session.id, ledger.promise); };
  host.recoverSubagentUsage = async () => { summaryReads++; await summaries.promise; };
  const loadOperations = host.changeSets.loadSession!.bind(host.changeSets);
  host.changeSets.loadSession = async sessionId => { recoveryStarted.resolve(); await recovery.promise; await loadOperations(sessionId); };
  const navigation = host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await recoveryStarted.promise;
  try {
    publish();
    const visible = lastState(posts);
    assert.equal(visible.activeSessionId, second.id);
    assert.ok(visible.messages?.some(message => message.id === 'task-second-user'), 'the correct body is safe to show before operation recovery');
    assert.equal(visible.interaction?.phase, 'preparing_context');
    assert.equal(visible.interaction?.canSubmit, false, 'operation consistency remains a required barrier');
    assert.equal(visible.usageMetrics?.displayReadiness, 'loading');
  } finally { recovery.resolve(); await navigation; }
  assert.equal(ledgerReads, 1);
  assert.equal(summaryReads, 1);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(lastState(posts).usageMetrics?.displayReadiness, 'loading', 'pending statistics are not invented as complete zeroes');
  await host.handleMessage({ type: 'selectSession', sessionId: first.id });
  assert.equal(store.activeSessionId, first.id, 'the next session does not await old display work');
  ledger.resolve(); summaries.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(store.activeSessionId, first.id);
  assert.equal(lastState(posts).activeSessionId, first.id);
  assert.equal(host.usageDisplayReadiness.get(second.id), 'ready');
  assert.equal(lastState(posts).interaction?.phase, 'idle');
  t.diagnostic(JSON.stringify({ boundary: 'navigation-dependencies', criticalRecoveryBlocksSubmit: true,
    ledgerReads, summaryReads, displayPendingAtSubmitReady: true, lateDisplayChangedActiveSession: false }));
});

test('an older queued context refresh failure cannot replace a newer successful refresh', async t => {
  const { host, posts, publish } = await fixture(t);
  const runtime = host as unknown as {
    fileContext: { getAll(): unknown[]; refreshUris(uris: readonly string[]): Promise<void> };
    scheduleRunContextRefresh(uris: readonly string[]): void;
    runContextRefreshPromise?: Promise<void>;
    runContextRefreshError?: unknown;
  };
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const uri = 'file:///temporary-context.txt';
  runtime.fileContext.getAll = () => [{ id: 'context', uri, label: 'context', fsPath: '/temporary-context.txt',
    languageId: 'plaintext', source: 'workspace', content: '', sizeBytes: 0 }];
  let reads = 0;
  runtime.fileContext.refreshUris = async () => {
    if (++reads === 1) { entered.resolve(); await release.promise; throw new Error('obsolete refresh failure'); }
  };
  runtime.scheduleRunContextRefresh([uri]);
  await entered.promise;
  runtime.scheduleRunContextRefresh([uri]);
  const latest = runtime.runContextRefreshPromise;
  release.resolve();
  await latest;
  await new Promise<void>(resolve => setImmediate(resolve));
  publish();
  assert.equal(reads, 2);
  assert.equal(runtime.runContextRefreshError, undefined);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});

test('A to B to A rejects submissions from the previous entry revision without losing a newer draft', async t => {
  const { host, store, first, second, posts, publish } = await fixture(t);
  const calls = acceptedRun(host, store);
  publish();
  const revision = lastState(posts).interaction!.revision;
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await host.handleMessage({ type: 'selectSession', sessionId: first.id });
  await host.handleMessage({ ...submission(first.id, 'old-entry'), stateRevision: revision });
  assert.equal(posts.find(post => post.requestId === 'old-entry')?.status, 'rejected');
  assert.equal(calls.length, 0);
  await host.handleMessage({ ...submission(first.id, 'current-entry'), stateRevision: lastState(posts).interaction!.revision });
  assert.equal(calls.length, 1);
  assert.equal(posts.find(post => post.requestId === 'current-entry')?.status, 'accepted');
});

test('failed startup safety recovery cannot be bypassed through navigation into a store flush', async t => {
  const { host, store, first, second, posts } = await fixture(t);
  host.approvalDataReady = false;
  let loads = 0;
  host.changeSets.loadSession = async () => { loads++; };
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  assert.equal(store.activeSessionId, first.id);
  assert.equal(loads, 0, 'a failed safety store must not be flushed from partial in-memory data');
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  assert.match(lastState(posts).interaction?.blockingReason ?? '', /Safety recovery failed|操作记录恢复失败/u);
});

for (const type of ['newSession', 'selectSession'] as const) {
  test(`session navigation ${type} waits for the initial persisted session load`, async t => {
    const { host, store, storage, first, second, releaseLoad, initialization, publish, posts } = await fixture(t, { delayLoad: true });
    let writes = 0;
    const originalSave = storage.saveWorkspace.bind(storage);
    storage.saveWorkspace = async (scope, state) => { writes++; await originalSave(scope, state); };
    const navigation = host.handleMessage(type === 'newSession' ? { type } : { type, sessionId: second.id });
    const writesBeforeLoad = writes;
    releaseLoad.resolve();
    await Promise.all([initialization, navigation]);
    assert.equal(writesBeforeLoad, 0, 'navigation must not save an empty pre-load session over persisted history');
    if (type === 'newSession') assert.notEqual(store.activeSessionId, first.id, 'late initialization must not restore the old active session');
    else assert.equal(store.activeSessionId, second.id, 'history selection must use the initialized summaries');
    publish();
    assert.equal(posts.at(-1)?.state?.activeSessionId, store.activeSessionId);
  });
}

test('failed initial session loading leaves navigation unlocked without saving a replacement', async t => {
  const { host, storage, releaseLoad, initialization, errors } = await fixture(t, { delayLoad: true, loadFailure: true });
  let writes = 0;
  const originalSave = storage.saveWorkspace.bind(storage);
  storage.saveWorkspace = async (scope, state) => { writes++; await originalSave(scope, state); };
  const navigation = host.handleMessage({ type: 'newSession' });
  releaseLoad.resolve();
  await navigation;
  await assert.rejects(initialization, /injected session load failure/);
  assert.equal(writes, 0);
  assert.equal(host.isStartingRun, false);
  assert.equal(host.sessionReady, false);
  assert.equal(errors.length, 1);
});

test('repeated new-session clicks create one persisted session while navigation is pending', async t => {
  const { host, store, storage, first, second, publish, posts } = await fixture(t);
  const saveStarted = deferred();
  const releaseSave = deferred();
  t.after(() => releaseSave.resolve());
  const states: StoredWorkspaceSessionState[] = [];
  const originalSave = storage.saveWorkspace.bind(storage);
  storage.saveWorkspace = async (scope, state) => {
    states.push(state);
    saveStarted.resolve();
    await releaseSave.promise;
    await originalSave(scope, state);
  };
  const firstClick = host.handleMessage({ type: 'newSession' });
  const secondClick = host.handleMessage({ type: 'newSession' });
  await saveStarted.promise;
  const lockedDuringSave = host.isStartingRun;
  releaseSave.resolve();
  await Promise.all([firstClick, secondClick]);
  assert.equal(lockedDuringSave, true, 'navigation owns the host lock before its first asynchronous barrier');
  assert.equal(new Set(states.map(state => state.activeSessionId)).size, 1);
  assert.notEqual(store.activeSessionId, first.id);
  assert.notEqual(store.activeSessionId, second.id);
  assert.equal(host.isStartingRun, false);
  assert.ok(host.currentRunContextsBySession.has(store.activeSessionId), 'new session Skills and project context are actually refreshed under the navigation lock');
  publish();
  assert.equal(posts.at(-1)?.state?.isBusy, false);
});

for (const type of ['newSession', 'selectSession'] as const) {
  test(`persisted ${type} is published and unlocked when its context refresh fails`, async t => {
    const { host, store, first, second, posts, errors, publish } = await fixture(t);
    // Fault injection at the context-source dependency, without replacing Host
    // navigation, state construction, persistence, or approval/runtime services.
    host.sharedProjectSources.refresh = async () => { throw new Error('injected context read failure'); };
    await host.handleMessage(type === 'newSession' ? { type } : { type, sessionId: second.id });
    assert.notEqual(store.activeSessionId, first.id);
    assert.equal(host.isStartingRun, false);
    assert.equal(errors.length, 1);
    assert.ok(posts.some(post => post.type === 'sessionChanged'));
    publish();
    assert.equal(posts.at(-1)?.state?.activeSessionId, store.activeSessionId);
    assert.equal(posts.at(-1)?.state?.isBusy, false);
  });
}

test('an in-flight automatic title does not block or get cancelled by session navigation', async t => {
  const { host, store, first, second, publish, posts } = await fixture(t);
  const requested = deferred();
  const response = deferred<string>();
  t.after(() => response.resolve('{"decision":"defer","title":null}'));
  let titleSignal: AbortSignal | undefined;
  const title = host.sessionTitles.complete(first.id, 'task-first', async input => {
    titleSignal = input.signal;
    requested.resolve();
    return response.promise;
  });
  await requested.promise;
  await host.handleMessage({ type: 'newSession' });
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  assert.equal(store.activeSessionId, second.id);
  assert.equal(titleSignal?.aborted, false);
  response.resolve('{"decision":"set","title":"会话切换排查"}');
  assert.equal(await title, true);
  assert.equal(store.getSessionById(first.id)?.title, '会话切换排查');
  assert.equal(store.activeSessionId, second.id);
  publish();
  assert.equal(posts.at(-1)?.state?.isBusy, false);
});

test('session navigation retains the main-run busy guard', async t => {
  const { host, store, first, second } = await fixture(t);
  host.isBusy = true;
  await host.handleMessage({ type: 'newSession' });
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  assert.equal(store.activeSessionId, first.id);
  host.isBusy = false;
});

test('early navigation state cannot schedule a continuation before recovery and request context are ready', async t => {
  const { host } = await fixture(t);
  clearTimeout(host.draftRunAutoContinueTimer);
  host.draftRunAutoContinueTimer = undefined;
  for (const [approvalReady, contextReady] of [[false, false], [false, true], [true, false]]) {
    host.approvalDataReady = approvalReady;
    host.requestContextReady = contextReady;
    host.scheduleDraftRunAutoContinuation();
    assert.equal(host.draftRunAutoContinueTimer, undefined);
  }
  host.approvalDataReady = true;
  host.requestContextReady = true;
  host.scheduleDraftRunAutoContinuation();
  assert.ok(host.draftRunAutoContinueTimer, 'the ready startup full state can schedule continuation normally');
});

for (const stage of ['loadSession', 'isSessionDeleted'] as const) {
  test(`history timeout bounds ${stage}, opens a ready empty session and ignores the late read`, { timeout: 3_000 }, async t => {
    const { host, store, storage, first, second, posts, errors, informations, publish } = await fixture(t);
    host.historySessionLoadTimeoutMs = 20;
    host.language = stage === 'loadSession' ? 'en' : 'zh-CN';
    const entered = deferred(); const release = deferred(); const completed = deferred();
    t.after(() => release.resolve());
    assert.equal(store.getSessionById(second.id), undefined, 'the target is a cold indexed history row');
    if (stage === 'loadSession') {
      const load = storage.loadSession.bind(storage);
      storage.loadSession = async (workspaceKey, sessionId, options) => {
        if (sessionId !== second.id) return load(workspaceKey, sessionId, options);
        entered.resolve(); await release.promise;
        try { return await load(workspaceKey, sessionId, options); }
        finally { completed.resolve(); }
      };
    } else {
      const isDeleted = storage.isSessionDeleted.bind(storage);
      let pauseFirstCheck = true;
      storage.isSessionDeleted = async (workspaceKey, sessionId) => {
        if (sessionId !== second.id || !pauseFirstCheck) return isDeleted(workspaceKey, sessionId);
        pauseFirstCheck = false;
        entered.resolve(); await release.promise;
        try { return await isDeleted(workspaceKey, sessionId); }
        finally { completed.resolve(); }
      };
    }
    const notification = deferred<string | undefined>();
    t.after(() => notification.resolve(undefined));
    vscode.window.showInformationMessage = async message => {
      informations.push(message);
      return notification.promise;
    };
    const selection = host.handleMessage({ type: 'selectSession', sessionId: second.id });
    await entered.promise;
    await selection;
    publish();
    const replacement = store.getActiveSession();
    assert.notEqual(replacement.id, first.id);
    assert.notEqual(replacement.id, second.id);
    assert.equal(replacement.messages.length, 0);
    assert.equal(lastState(posts).activeSessionId, replacement.id);
    assert.equal(lastState(posts).interaction?.phase, 'idle');
    assert.equal(lastState(posts).interaction?.canNavigate, true);
    assert.equal(lastState(posts).interaction?.canSubmit, true);
    assert.equal(lastState(posts).isBusy, false);
    assert.deepEqual(errors, []);
    assert.equal(informations.length, 1, 'notification does not require dismissal before navigation completes');
    assert.equal(informations[0], localize(host.language, 'historySessionLoadTimeout', {
      seconds: HISTORY_SESSION_LOAD_TIMEOUT_MS / 1000
    }));
    const entryRevision = host.activeSessionEntryRevision;
    const changedCount = posts.filter(post => post.type === 'sessionChanged').length;
    release.resolve(); await completed.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(store.activeSessionId, replacement.id);
    assert.equal(store.getSessionById(second.id), undefined, 'late loading cannot make the abandoned body resident');
    assert.equal(host.activeSessionEntryRevision, entryRevision);
    assert.equal(posts.filter(post => post.type === 'sessionChanged').length, changedCount);
    assert.deepEqual(errors, []);
  });
}

test('history timeout reuses a different active empty session without another save or entry publication', { timeout: 3_000 }, async t => {
  const { host, store, storage, second, posts, errors, informations, publish } = await fixture(t);
  await host.handleMessage({ type: 'newSession' });
  const empty = store.getActiveSession();
  assert.equal(empty.messages.length, 0);
  host.historySessionLoadTimeoutMs = 20;
  const entered = deferred(); const release = deferred(); const completed = deferred();
  t.after(() => release.resolve());
  const load = storage.loadSession.bind(storage);
  storage.loadSession = async (workspaceKey, sessionId, options) => {
    if (sessionId !== second.id) return load(workspaceKey, sessionId, options);
    entered.resolve(); await release.promise;
    try { return await load(workspaceKey, sessionId, options); }
    finally { completed.resolve(); }
  };
  let saves = 0;
  const save = storage.saveWorkspace.bind(storage);
  storage.saveWorkspace = async (...args) => { saves++; return save(...args); };
  const entryRevision = host.activeSessionEntryRevision;
  const changedCount = posts.filter(post => post.type === 'sessionChanged').length;
  const selection = host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await entered.promise; await selection;
  publish();
  assert.equal(store.getActiveSession(), empty);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(lastState(posts).interaction?.canNavigate, true);
  assert.equal(saves, 0);
  assert.equal(host.activeSessionEntryRevision, entryRevision);
  assert.equal(posts.filter(post => post.type === 'sessionChanged').length, changedCount);
  assert.equal(informations.length, 1);
  assert.deepEqual(errors, []);
  release.resolve(); await completed.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(store.getActiveSession(), empty);
  assert.equal(saves, 0);
  assert.equal(host.activeSessionEntryRevision, entryRevision);
});

test('history body released before its deadline follows normal selection and recovery', async t => {
  const { host, store, storage, second, posts, errors, informations, publish } = await fixture(t);
  host.historySessionLoadTimeoutMs = 1_000;
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const load = storage.loadSession.bind(storage);
  storage.loadSession = async (workspaceKey, sessionId, options) => {
    if (sessionId === second.id) { entered.resolve(); await release.promise; }
    return load(workspaceKey, sessionId, options);
  };
  const selection = host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await entered.promise; release.resolve(); await selection;
  publish();
  assert.equal(store.activeSessionId, second.id);
  assert.ok(store.getActiveSession().messages.some(message => message.id === 'task-second-user'));
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.equal(lastState(posts).interaction?.canNavigate, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(informations, []);
});

test('history timeout reuse retains the empty session recovery barrier', { timeout: 3_000 }, async t => {
  const { host, store, storage, second, posts, errors, publish } = await fixture(t);
  await host.handleMessage({ type: 'newSession' });
  const emptyId = store.activeSessionId;
  host.sessionRecoveryReady = false;
  host.historySessionLoadTimeoutMs = 20;
  const entered = deferred(); const release = deferred(); const completed = deferred();
  t.after(() => release.resolve());
  const load = storage.loadSession.bind(storage);
  storage.loadSession = async (workspaceKey, sessionId, options) => {
    if (sessionId !== second.id) return load(workspaceKey, sessionId, options);
    entered.resolve(); await release.promise;
    try { return await load(workspaceKey, sessionId, options); }
    finally { completed.resolve(); }
  };
  const selection = host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await entered.promise; await selection;
  publish();
  assert.equal(store.activeSessionId, emptyId);
  assert.equal(host.sessionRecoveryReady, false);
  assert.equal(lastState(posts).interaction?.canNavigate, true);
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  assert.equal(lastState(posts).interaction?.waitingReason, 'recovery');
  assert.deepEqual(errors, []);
  release.resolve(); await completed.promise;
});

test('history timeout replacement keeps a failed Skill refresh closed to submission', { timeout: 3_000 }, async t => {
  const { host, store, storage, first, second, posts, errors, publish } = await fixture(t);
  host.historySessionLoadTimeoutMs = 20;
  const entered = deferred(); const release = deferred(); const completed = deferred();
  t.after(() => release.resolve());
  const load = storage.loadSession.bind(storage);
  storage.loadSession = async (workspaceKey, sessionId, options) => {
    if (sessionId !== second.id) return load(workspaceKey, sessionId, options);
    entered.resolve(); await release.promise;
    try { return await load(workspaceKey, sessionId, options); }
    finally { completed.resolve(); }
  };
  host.skillStore.resolveAndLoadSkills = async () => { throw new Error('replacement Skill read failed'); };
  const selection = host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await entered.promise; await selection;
  publish();
  assert.notEqual(store.activeSessionId, first.id);
  assert.notEqual(store.activeSessionId, second.id);
  assert.equal(store.getActiveSession().messages.length, 0);
  assert.equal(lastState(posts).interaction?.canNavigate, true);
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  assert.equal(lastState(posts).interaction?.phase, 'failed');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /replacement Skill read failed/u);
  release.resolve(); await completed.promise;
});

test('history selection already saving never times out or creates a replacement', { timeout: 3_000 }, async t => {
  const { host, store, storage, second, posts, errors, informations, publish } = await fixture(t);
  host.historySessionLoadTimeoutMs = 20;
  const entered = deferred(); const release = deferred();
  t.after(() => release.resolve());
  const save = storage.saveWorkspace.bind(storage);
  storage.saveWorkspace = async (...args) => { entered.resolve(); await release.promise; return save(...args); };
  const selection = host.handleMessage({ type: 'selectSession', sessionId: second.id });
  await entered.promise;
  await new Promise<void>(resolve => setTimeout(resolve, 40));
  publish();
  assert.equal(store.activeSessionId, second.id);
  assert.equal(lastState(posts).interaction?.phase, 'saving');
  assert.equal(lastState(posts).interaction?.canNavigate, false);
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  assert.deepEqual(informations, []);
  release.resolve(); await selection;
  publish();
  assert.equal(store.activeSessionId, second.id);
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  assert.deepEqual(errors, []);
});

test('history I/O failure retains failed preparation and retry instead of timeout fallback', async t => {
  const { host, store, storage, first, second, posts, errors, informations, publish } = await fixture(t);
  host.historySessionLoadTimeoutMs = 1_000;
  const load = storage.loadSession.bind(storage);
  storage.loadSession = async (workspaceKey, sessionId, options) => {
    if (sessionId === second.id) throw new Error('injected history read failure');
    return load(workspaceKey, sessionId, options);
  };
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  publish();
  assert.equal(store.activeSessionId, first.id);
  assert.equal(lastState(posts).interaction?.phase, 'failed');
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  assert.match(errors[0] ?? '', /injected history read failure/u);
  assert.deepEqual(informations, []);
  storage.loadSession = load;
  await host.handleMessage({ type: 'retryInteraction' });
  publish();
  assert.equal(lastState(posts).interaction?.canSubmit, true);
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  assert.equal(store.activeSessionId, second.id);
  assert.equal(errors.length, 1);
});

test('A to B to A keeps the newer recovery owner when an abandoned B selection times out', { timeout: 3_000 }, async t => {
  const { host, store, storage, first, second, posts, errors, informations, publish } = await fixture(t);
  host.historySessionLoadTimeoutMs = 1_000;
  const oldReadEntered = deferred(); const releaseOldRead = deferred(); const oldReadCompleted = deferred();
  const recoveryEntered = deferred(); const releaseRecovery = deferred();
  t.after(() => { releaseOldRead.resolve(); releaseRecovery.resolve(); });
  const load = storage.loadSession.bind(storage);
  let pauseOldRead = true;
  storage.loadSession = async (workspaceKey, sessionId, options) => {
    if (sessionId === second.id && pauseOldRead) {
      pauseOldRead = false; oldReadEntered.resolve(); await releaseOldRead.promise;
      try { return await load(workspaceKey, sessionId, options); }
      finally { oldReadCompleted.resolve(); }
    }
    return load(workspaceKey, sessionId, options);
  };
  const oldSelection = host.handleMessage({ type: 'selectSession', sessionId: second.id });
  let oldSelectionSettled = false;
  void oldSelection.then(() => { oldSelectionSettled = true; });
  await oldReadEntered.promise;
  const oldOwner = host.interactions.current;
  assert.ok(oldOwner);
  // Simulate a foreground handoff while the old disk read cannot be cancelled.
  // The obsolete selection may finish, but must never release a later token.
  assert.equal(host.interactions.finish(oldOwner), true);
  host.historySessionLoadTimeoutMs = 1_000;
  await host.handleMessage({ type: 'selectSession', sessionId: second.id });
  assert.equal(store.activeSessionId, second.id);
  const loadOperations = host.changeSets.loadSession!.bind(host.changeSets);
  host.changeSets.loadSession = async sessionId => {
    if (sessionId === first.id) { recoveryEntered.resolve(); await releaseRecovery.promise; }
    return loadOperations(sessionId);
  };
  const newSelection = host.handleMessage({ type: 'selectSession', sessionId: first.id });
  await recoveryEntered.promise;
  assert.equal(oldSelectionSettled, false, 'the old deadline must expire while the new A recovery owner is pending');
  const newOwner = host.interactions.current;
  assert.ok(newOwner);
  assert.notEqual(newOwner, oldOwner);
  const entryRevision = host.activeSessionEntryRevision;
  const changedCount = posts.filter(post => post.type === 'sessionChanged').length;
  await oldSelection;
  publish();
  assert.equal(store.activeSessionId, first.id);
  assert.equal(host.interactions.current, newOwner);
  assert.equal(lastState(posts).interaction?.canNavigate, false);
  assert.equal(lastState(posts).interaction?.canSubmit, false);
  assert.equal(host.activeSessionEntryRevision, entryRevision);
  assert.equal(posts.filter(post => post.type === 'sessionChanged').length, changedCount);
  assert.deepEqual(informations, [], 'a stale timeout cannot announce a replacement it did not open');
  assert.deepEqual(errors, []);
  releaseOldRead.resolve(); await oldReadCompleted.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(host.interactions.current, newOwner);
  assert.equal(store.activeSessionId, first.id);
  assert.equal(host.activeSessionEntryRevision, entryRevision);
  releaseRecovery.resolve(); await newSelection;
  publish();
  assert.equal(lastState(posts).interaction?.canSubmit, true);
});
