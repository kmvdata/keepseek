import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from './stubs/vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore, type StoredWorkspaceSessionState } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import type { SessionTitleCoordinator } from '../src/sessions/sessionTitleCoordinator';
import type { SharedProjectSources } from '../src/context/sharedProjectSources';
import type { ChatMessage } from '../src/shared/types';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

interface NavigationHost {
  handleMessage(message: { type: 'newSession' } | { type: 'selectSession'; sessionId: string }): Promise<void>;
  initializeAfterWebviewReady(): Promise<void>;
  postState(options: { immediate?: boolean; forceFull?: boolean }): void;
  isStartingRun: boolean;
  isBusy: boolean;
  sessionReady: boolean;
  approvalDataReady: boolean;
  requestContextReady: boolean;
  draftRunAutoContinueTimer?: ReturnType<typeof setTimeout>;
  scheduleDraftRunAutoContinuation(): void;
  sessionTitles: SessionTitleCoordinator;
  sharedProjectSources: SharedProjectSources;
  currentRunContextsBySession: Map<string, unknown>;
  views: Set<unknown>;
}

function messages(taskId: string): ChatMessage[] {
  const userTask = { version: 1 as const, id: taskId, originMessageId: `${taskId}-user`, reason: 'user' as const };
  return [
    { id: `${taskId}-user`, role: 'user', content: '分析 KeepSeek 会话切换', createdAt: new Date().toISOString(), userTask },
    { id: `${taskId}-answer`, role: 'assistant', content: '检查会话存储与状态发布。', createdAt: new Date().toISOString(), userTask }
  ];
}

async function fixture(t: TestContext, options: { delayLoad?: boolean; loadFailure?: boolean } = {}) {
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
  Object.assign(vscode, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showErrorMessage: async (error: string) => { errors.push(error); }
  });
  const provider = new KeepseekChatViewProvider(uri as never, store, uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    initialization);
  const host = provider as unknown as NavigationHost;
  const posts: Array<{ type: string; state?: { activeSessionId?: string; isBusy?: boolean } }> = [];
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
  if (!options.delayLoad) await host.initializeAfterWebviewReady();
  const publish = () => host.postState({ immediate: true, forceFull: true });
  return { host, store, storage, first, second, posts, errors, releaseLoad, initialization, publish };
}

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
