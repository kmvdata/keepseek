import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from './stubs/vscode';
import { ProjectAssistantHost } from '../src/provider/projectAssistantHost';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { ProjectResourceCoordinator } from '../src/tasks/projectResources';
import { ProjectRequestAdmission } from '../src/tasks/requestAdmission';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { createWebviewDomHarness } from './webviewDomHarness';
import { SharedProjectSources } from '../src/context/sharedProjectSources';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-project-view-host-'));
  const uri = vscode.Uri.file(root);
  const previousWindow = { ...vscode.window };
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  const previousStatusBarFactory = (vscode.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
  Object.assign(vscode, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) });
  const owner = await ProjectExecutionOwner.acquire({ projectUri: root, lockRoot: join(root, 'locks') });
  assert.equal(owner.isOwner, true);
  const storage = new GlobalSessionStorage(uri as never);
  const store = new ChatSessionStore(storage, 'en', { key: 'view-host', name: 'view-host', folderUris: [uri.toString()] });
  await store.initialize();
  const session = store.getActiveSession();
  session.contextInstructions = 'exact frozen project context';
  session.messages = Array.from({ length: 80 }, (_, index) => ({ id: 'm-' + index,
    role: index % 2 === 0 ? 'user' as const : 'assistant' as const, content: 'message ' + index, createdAt: new Date(0).toISOString() }));
  await store.persist();
  const before = JSON.stringify(session);
  const posts: Array<Record<string, any>> = [];
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: { language: 'en', activeSessionId: session.id,
    startup: { interactiveReady: true, sideEffectsReady: true } } });
  const sources = new SharedProjectSources();
  const options = {
    sources, owner, resources: new ProjectResourceCoordinator(owner.projectId), admission: new ProjectRequestAdmission(),
    extensionUri: uri as never, storageUri: uri as never, sessionStore: store,
    windowId: 'view-contract', skillState: { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    extensionInfo: { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    defaults: () => ({ modelId: 'test-model', sourceId: 'test-source', wireModel: 'test-model', protocol: 'chat-completions', endpoint: 'https://example.invalid',
      rootUri: uri.toString(), cwdUri: uri.toString(), approvalMode: 'ask' as const, executionMode: 'normal' as const, skillIds: [] }),
    publish: (event: unknown) => { posts.push(event as Record<string, any>); view.receive(event); }
  };
  let host = new ProjectAssistantHost(options);
  await host.initialize();
  t.after(async () => {
    try { await host.dispose(); await storage.flush(); sources.dispose(); await owner.dispose(); }
    finally {
      Object.assign(vscode.window, previousWindow);
      if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
      else Object.assign(vscode, { StatusBarAlignment: previousAlignment });
      if (previousStatusBarFactory === undefined) delete (vscode.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
      await rm(root, { recursive: true, force: true });
    }
  });
  return { view, posts, session, before, store, options, get host() { return host; },
    reopen: async () => { await host.dispose(); host = new ProjectAssistantHost(options); await host.initialize(); return host; } };
}

test('real ProjectAssistantHost publishes task cards and finite session views without executing a Provider', async t => {
  const f = await fixture(t);
  const previousFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = async () => { providerRequests += 1; throw new Error('View must never contact a Provider'); };
  t.after(() => { globalThis.fetch = previousFetch; });
  await f.host.handleMessage({ type: 'projectTaskAssociate', projectId: f.options.owner.projectId, sessionId: f.session.id });
  const card = f.host.tasks.list()[0];
  assert.ok(card);
  assert.match(f.view.element('projectTaskList').textContent, new RegExp(card.title));
  assert.equal(f.view.state.messages.length <= 30, true);
  assert.equal(f.view.state.messages.at(-1).id, 'm-79');
  for (let generation = 2; generation < 7; generation += 1) {
    await f.host.handleMessage({ type: 'projectTaskView', projectId: f.options.owner.projectId,
      taskCardId: generation % 2 ? card.taskCardId : null, mode: generation % 2 ? 'task' : 'project', viewGeneration: generation });
  }
  await f.host.handleMessage({ type: 'ready' });
  assert.equal(providerRequests, 0);
  assert.equal(JSON.stringify(f.store.getSessionById(f.session.id)), f.before, 'viewing/association preserve Worker history and frozen context bytes');
});

test('real Host persists task-local drafts and restores the newest revision across reconstruction', async t => {
  const f = await fixture(t);
  await f.host.handleMessage({ type: 'projectTaskAssociate', projectId: f.options.owner.projectId, sessionId: f.session.id });
  const card = f.host.tasks.list()[0];
  const draft = { type: 'projectTaskDraft' as const, projectId: f.options.owner.projectId, targetId: card.taskCardId,
    revision: 3, markup: 'Newest durable task draft', cursor: { start: 5, end: 9 }, scrollTop: 72, expanded: false, skillIds: ['selected-skill'] };
  await f.host.handleMessage(draft);
  await f.host.handleMessage({ ...draft, revision: 2, markup: 'stale draft' });
  await f.reopen();
  await f.host.handleMessage({ type: 'projectTaskView', projectId: f.options.owner.projectId, taskCardId: card.taskCardId, mode: 'task', viewGeneration: 5 });
  const snapshot = f.posts.filter(item => item.type === 'projectTasksState' && item.viewTaskId === card.taskCardId).at(-1)!;
  assert.equal(snapshot.draft.markup, draft.markup);
  assert.deepEqual(snapshot.draft.cursor, draft.cursor);
  assert.equal(snapshot.draft.scrollTop, draft.scrollTop);
  assert.equal(snapshot.draft.expanded, false);
  assert.deepEqual(snapshot.draft.skillIds, ['selected-skill']);
  assert.equal(f.view.element('promptInput').textContent, draft.markup);
  assert.equal(f.view.element('transcript').scrollTop, 72);
});

test('real Host reopens a bounded deep-history anchor and Latest performs only a local page read', async t => {
  const f = await fixture(t);
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('History pages are local'); };
  t.after(() => { globalThis.fetch = previousFetch; });
  await f.host.handleMessage({ type: 'projectTaskAssociate', projectId: f.options.owner.projectId, sessionId: f.session.id });
  const card = f.host.tasks.list()[0];
  await f.host.handleMessage({ type: 'projectTaskDraft', projectId: f.options.owner.projectId, targetId: card.taskCardId,
    revision: 4, markup: 'Keep this draft', scrollAnchor: { messageId: 'm-20', offset: 0 }, scrollTop: 800 });
  await f.host.handleMessage({ type: 'projectTaskView', projectId: f.options.owner.projectId, taskCardId: null, mode: 'project', viewGeneration: 3 });
  await f.host.handleMessage({ type: 'projectTaskView', projectId: f.options.owner.projectId, taskCardId: card.taskCardId, mode: 'task', viewGeneration: 4 });
  assert.equal(f.view.state.messages.length, 30);
  assert.equal(f.view.state.messages[0].id, 'm-5');
  assert.ok(f.view.state.messages.some((message: { id: string }) => message.id === 'm-20'));
  assert.equal(f.view.state.hasNewerMessages, true);
  assert.equal(f.view.element('promptInput').textContent, 'Keep this draft');
  f.view.element('projectLatestMessages').click();
  const latest = f.view.posted.filter(item => item.type === 'projectTaskLatest').at(-1)!;
  await f.host.handleMessage(latest as never);
  assert.equal(f.view.state.messages.at(-1).id, 'm-79');
  assert.equal(f.view.state.hasNewerMessages, false);
  assert.equal(requests, 0);
  assert.equal(JSON.stringify(f.store.getSessionById(f.session.id)), f.before);
});

test('a real read-only Host settles stamped legacy inputs, title requests and actions without creating a Worker or changing authority', async t => {
  const f = await fixture(t);
  await f.host.handleMessage({ type: 'projectTaskAssociate', projectId: f.options.owner.projectId, sessionId: f.session.id });
  const card = f.host.tasks.list()[0];
  const root = f.options.owner.canonicalRoot;
  const observerOwner = await ProjectExecutionOwner.acquire({ projectUri: root, lockRoot: join(root, 'locks') });
  assert.equal(observerOwner.isOwner, false);
  assert.equal(observerOwner.projectId, f.options.owner.projectId);
  const observerStorage = new GlobalSessionStorage(f.options.storageUri);
  observerStorage.setReadOnly(true);
  const observerStore = new ChatSessionStore(observerStorage, 'en',
    { key: f.store.workspaceKey, name: 'view-host', folderUris: [vscode.Uri.file(root).toString()] });
  observerStore.setReadOnly(true);
  await observerStore.initialize();
  const posts: Array<Record<string, any>> = [];
  let watcherInjectionScheduled = false, watcherErrorInjected = false;
  let finishWatcherInjection!: () => void;
  const watcherInjection = new Promise<void>(resolve => { finishWatcherInjection = resolve; });
  let observer!: ProjectAssistantHost;
  observer = new ProjectAssistantHost({ ...f.options, owner: observerOwner, sessionStore: observerStore,
    windowId: 'read-only-contract', publish: event => {
      const value = event as Record<string, any>; posts.push(value);
      if (value.type === 'projectTasksState' && value.readOnly && !watcherInjectionScheduled) {
        watcherInjectionScheduled = true;
        // Schedule before fs.watch's possible native error delivery, but after
        // initialize has created its actual watcher and attached the listener.
        process.nextTick(() => {
          const watcher = (observer as unknown as { observerWatcher?: { emit(name: string, error: Error): void } }).observerWatcher;
          if (watcher) { watcherErrorInjected = true; watcher.emit('error', new Error('injected observer watcher failure')); }
          finishWatcherInjection();
        });
      }
    } });
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests += 1; throw new Error('A read-only Host cannot contact a Provider'); };
  try {
    const registryUri = (f.host.tasks as unknown as { uri: vscode.Uri }).uri;
    const beforeRegistry = await vscode.workspace.fs.readFile(registryUri as never);
    const beforeSession = JSON.stringify(await observerStorage.loadSession(f.store.workspaceKey, f.session.id));
    const beforeCards = JSON.stringify(f.host.tasks.list());
    await observer.initialize();
    await watcherInjection;
    const watcherError = posts.find(event => event.type === 'projectTaskError'
      && (watcherErrorInjected ? /injected observer watcher failure/u : /EMFILE|too many open files/iu).test(String(event.reason)));
    assert.ok(watcherError, 'the actual watcher reports either the injected failure or an earlier native descriptor failure');
    t.diagnostic(JSON.stringify({ observerWatcherFailure: watcherErrorInjected ? 'injected' : 'native', reason: watcherError.reason }));
    assert.equal((observer as unknown as { observerWatcher?: unknown }).observerWatcher, undefined);
    await observer.handleMessage({ type: 'projectTaskView', projectId: observerOwner.projectId,
      taskCardId: card.taskCardId, mode: 'task', viewGeneration: 3 });
    const page = posts.filter(event => event.type === 'projectTasksState' && event.viewTaskId === card.taskCardId && Array.isArray(event.messages)).at(-1)!;
    assert.equal(page.messages.at(-1).id, 'm-79', 'explicit local viewing remains available after the watcher fails');
    const target = { projectId: observerOwner.projectId, taskCardId: card.taskCardId, sessionId: card.sessionId, rootTaskId: card.rootTaskId };
    await observer.handleMessage({ ...target, type: 'sendPrompt', requestId: 'readonly-send', prompt: 'Must remain a draft',
      sourceId: 'test-source', modelId: 'test-model' });
    await observer.handleMessage({ ...target, type: 'editUserPrompt', requestId: 'readonly-edit', messageId: 'm-0',
      prompt: 'Must not truncate history', sourceId: 'test-source', modelId: 'test-model' });
    await observer.handleMessage({ ...target, type: 'regenerateSessionTitle', requestId: 'readonly-title' });
    await observer.handleMessage({ ...target, type: 'applyChangeSet', id: 'readonly-change', requestId: 'readonly-action' });
    for (const requestId of ['readonly-send', 'readonly-edit']) {
      const terminal = posts.filter(event => event.type === 'submissionResult' && event.requestId === requestId);
      assert.equal(terminal.length, 1, 'each rejected legacy request gets one terminal');
      assert.equal(terminal[0].status, 'rejected');
      assert.equal(terminal[0].sessionId, card.sessionId);
      assert.ok(terminal[0].reason);
    }
    const title = posts.filter(event => event.type === 'sessionTitleRegeneration' && event.requestId === 'readonly-title');
    assert.equal(title.length, 1); assert.equal(title[0].running, false); assert.equal(title[0].outcome, 'unavailable');
    assert.equal(title[0].sessionId, card.sessionId);
    const action = posts.filter(event => event.type === 'changeActionFeedback' && event.requestId === 'readonly-action');
    assert.equal(action.length, 1); assert.equal(action[0].phase, 'failed');
    assert.equal(action[0].action, 'applyChangeSet'); assert.equal(action[0].id, 'readonly-change');
    assert.ok(posts.some(event => event.type === 'projectReadOnly'), 'the denied operation explains the read-only boundary');
    assert.equal((observer as unknown as { workers: Map<string, unknown> }).workers.size, 0);
    assert.equal(requests, 0);
    assert.equal(JSON.stringify(f.host.tasks.list()), beforeCards);
    assert.deepEqual(await vscode.workspace.fs.readFile(registryUri as never), beforeRegistry);
    assert.equal(JSON.stringify(await observerStorage.loadSession(f.store.workspaceKey, f.session.id)), beforeSession);
    assert.equal(JSON.stringify(f.store.getSessionById(f.session.id)), f.before);
  } finally {
    globalThis.fetch = previousFetch;
    await observer.dispose();
    await observerStorage.flush();
    await observerOwner.dispose();
  }
});
