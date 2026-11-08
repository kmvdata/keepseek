import './registerVscodeStub';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
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
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { taskUsageFingerprint, taskUsageLaneFingerprint } from '../src/tasks/taskUsageSnapshot';
import type { TaskContextUsageOrigin } from '../src/shared/types';
import type { ProjectWorkerBinding } from '../src/provider/projectAssistantHost';
import { ProjectTaskService } from '../src/tasks/projectTasks';

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
  await host.handleMessage({ type: 'projectTaskOpen', projectId: owner.projectId } as never);
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
    reopen: async (loadHistory = true) => { await host.dispose(); host = new ProjectAssistantHost(options); await host.initialize();
      if (loadHistory) await host.handleMessage({ type: 'projectTaskOpen', projectId: owner.projectId } as never); return host; } };
}

test('new project host stays blank and performs no historical I/O through repeated ready and idle', async t => {
  const f = await fixture(t);
  await f.host.handleMessage({ type: 'projectTaskAssociate', projectId: f.options.owner.projectId, sessionId: f.session.id });
  await f.host.dispose();
  const previousRead = vscode.workspace.fs.readFile;
  const previousFetch = globalThis.fetch;
  const reads: string[] = [];
  let requests = 0;
  vscode.workspace.fs.readFile = async uri => { reads.push(uri.toString()); return previousRead(uri); };
  globalThis.fetch = async () => { requests++; throw new Error('Blank boot must stay offline'); };
  try {
    await f.reopen(false);
    await f.host.handleMessage({ type: 'ready' });
    await f.host.handleMessage({ type: 'ready' });
    await new Promise(resolve => setTimeout(resolve, 30));
    const state = f.posts.filter(event => event.type === 'projectTasksState').at(-1)!;
    assert.equal(state.viewMode, 'legacy');
    assert.equal(state.enabled, false);
    assert.equal(state.historyReady, false);
    assert.deepEqual(state.cards, []);
    assert.equal(reads.length, 0, 'no Registry, usage, draft, scope/index, transcript or prefetch reads');
    assert.equal((f.host as unknown as { workers: Map<string, unknown> }).workers.size, 0);
    assert.equal(requests, 0);
    await f.host.handleMessage({ type: 'projectTaskOpen', projectId: f.options.owner.projectId } as never);
    assert.equal(f.host.tasks.list().length, 1, 'only an explicit history action reads cards');
    assert.equal((f.host as unknown as { workers: Map<string, unknown> }).workers.size, 0);
  } finally { vscode.workspace.fs.readFile = previousRead; globalThis.fetch = previousFetch; }
});

test('a delayed explicit task view cannot replace a newer blank target', async t => {
  const f = await fixture(t);
  await f.host.handleMessage({ type: 'projectTaskAssociate', projectId: f.options.owner.projectId, sessionId: f.session.id });
  const card = f.host.tasks.list()[0];
  const registryUri = (f.host.tasks as unknown as { uri: vscode.Uri }).uri.toString();
  await f.reopen(false);
  const previousRead = vscode.workspace.fs.readFile;
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  vscode.workspace.fs.readFile = async uri => {
    if (uri.toString() === registryUri) { enter(); await released; }
    return previousRead(uri);
  };
  try {
    const viewing = f.host.handleMessage({ type: 'projectTaskView', projectId: f.options.owner.projectId,
      taskCardId: card.taskCardId, mode: 'task', viewGeneration: 5 });
    await entered;
    assert.equal(await f.host.handleMessage({ type: 'newSession' }), false, 'the root Host owns the new blank target');
    release(); await viewing;
    const state = f.posts.filter(event => event.type === 'projectTasksState').at(-1)!;
    assert.equal(state.viewMode, 'legacy');
    assert.equal(state.viewTaskId, null);
    assert.equal(state.enabled, false);
    assert.equal(state.messages, undefined, 'late history metadata never publishes the old transcript');
    assert.equal((f.host as unknown as { workers: Map<string, unknown> }).workers.size, 0);
  } finally { release(); vscode.workspace.fs.readFile = previousRead; }
});

test('history association uses complete-session first input and real finish evidence without renewing a shutdown record', async t => {
  const f = await fixture(t);
  const start = '2026-11-01T08:00:00.000Z', finish = '2026-11-07T08:00:00.000Z';
  for (const message of f.session.messages) message.createdAt = start;
  f.session.messages[0].content = '';
  f.session.messages[0].expandedContent = 'Original expanded user input';
  f.session.messages[77].runDetails = { status: 'succeeded', endedAt: finish } as never;
  f.session.messages[79].runDetails = { status: 'stopped', endedAt: '2026-11-08T08:00:00.000Z' } as never;
  await f.store.persist();
  const bytes = JSON.stringify(f.session.messages);
  await f.host.handleMessage({ type: 'projectTaskAssociate', projectId: f.options.owner.projectId, sessionId: f.session.id });
  const card = f.host.tasks.list()[0];
  assert.equal(card.firstSubmittedAt, start);
  assert.equal(card.firstSubmittedAtSource, 'user_input');
  assert.equal(card.lastActivityAt, finish, 'a real long-running completion counts; ambiguous shutdown does not');
  assert.equal(JSON.stringify(f.store.getSessionById(f.session.id)!.messages), bytes, 'association never rewrites the old request history');
});

test('real ProjectAssistantHost publishes task cards and finite session views without executing a Provider', async t => {
  const f = await fixture(t);
  const previousFetch = globalThis.fetch;
  let providerRequests = 0;
  globalThis.fetch = async () => { providerRequests += 1; throw new Error('View must never contact a Provider'); };
  t.after(() => { globalThis.fetch = previousFetch; });
  await f.host.handleMessage({ type: 'projectTaskAssociate', projectId: f.options.owner.projectId, sessionId: f.session.id });
  const card = f.host.tasks.list()[0];
  assert.ok(card);
  f.view.element('projectSidebarToggle').click();
  assert.match(f.view.element('projectTaskList').textContent, new RegExp(card.title));
  assert.equal(f.view.state.messages.length <= 30, true);
  assert.equal(f.view.state.messages.at(-1).id, 'm-79');
  for (let generation = 2; generation < 7; generation += 1) {
    await f.host.handleMessage({ type: 'projectTaskView', projectId: f.options.owner.projectId,
      taskCardId: generation % 2 ? card.taskCardId : null, mode: generation % 2 ? 'task' : 'project', viewGeneration: generation });
  }
  await f.host.handleMessage({ type: 'ready' });
  assert.equal(providerRequests, 0);
  assert.equal((f.host as unknown as { workers: Map<string, unknown> }).workers.size, 0, 'viewing a task never constructs its execution Worker');
  assert.equal(JSON.stringify(f.store.getSessionById(f.session.id)), f.before, 'viewing/association preserve Worker history and frozen context bytes');
});

test('usage updates coalesce independently; failed metadata save preserves durable ACK/terminal and reopen is last-known', async t => {
  const f = await fixture(t);
  const previousExecute = KeepseekChatViewProvider.prototype.executeProjectInput;
  const previousRename = vscode.workspace.fs.rename;
  const previousLoad = ChatSessionStore.prototype.loadSessionById;
  let failUsageSave = true, usageWrites = 0, requests = 0, registryWrites = 0, fullSessionReads = 0;
  let burstRegistryWrites = -1, burstSessionReads = -1;
  ChatSessionStore.prototype.loadSessionById = function(...args) { fullSessionReads++; return previousLoad.apply(this, args); };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => { requests++; throw new Error('Controlled execution must not request a model'); };
  vscode.workspace.fs.rename = async (source, target, options) => {
    if (target.fsPath.endsWith('project-tasks.json')) registryWrites++;
    if (target.fsPath.endsWith('task-context-usage.json')) {
      usageWrites++;
      if (failUsageSave) throw Object.assign(new Error('controlled usage metadata failure'), { code: 'EACCES' });
    }
    return previousRename(source, target, options);
  };
  KeepseekChatViewProvider.prototype.executeProjectInput = async function(context) {
    const binding = (this as unknown as { projectBinding: ProjectWorkerBinding }).projectBinding;
    const source: TaskContextUsageOrigin = { identity: { ...context.identity, hostId: binding.hostId, runtimeId: binding.runtimeId },
      laneFingerprint: taskUsageFingerprint('controlled prepared profile'), configurationFingerprint: taskUsageLaneFingerprint(context.card.snapshot),
      projectionRevision: 1, capturedAt: '2026-11-07T00:00:00.000Z' };
    binding.publish({ type: 'taskContextUsageStart', origin: source });
    const registryBefore = registryWrites, readsBefore = fullSessionReads;
    for (let sequence = 1; sequence <= 100; sequence++) binding.publish({ type: 'taskContextUsage', origin: source, sequence,
      usage: { usedTokensEstimate: sequence, maxTokensEstimate: 1000, usedPercent: sequence / 10 }, recordedAt: '2026-11-07T00:00:01.000Z' });
    burstRegistryWrites = registryWrites - registryBefore; burstSessionReads = fullSessionReads - readsBefore;
    return { result: 'Controlled execution completed', usedMs: 12, costByCurrency: {}, usageIncomplete: true };
  };
  try {
    const countBefore = f.posts.filter(event => event.type === 'projectTasksState').length;
    await f.host.handleMessage({ type: 'projectTaskCreate', projectId: f.options.owner.projectId,
      requestId: 'usage-save-failure', prompt: 'Controlled execution', draftRevision: 1,
      targetId: '$new', sourceId: 'test-source', modelId: 'test-model' });
    await f.host.tasks.whenIdle();
    const internal = f.host as unknown as { contextUsageWriter: Promise<void>; saveContextUsage(): Promise<void> };
    await internal.contextUsageWriter;
    const card = f.host.tasks.list()[0];
    assert.equal(card.state, 'completed');
    assert.equal(f.posts.find(event => event.type === 'projectTaskSubmissionResult' && event.requestId === 'usage-save-failure')?.status, 'accepted');
    assert.ok(usageWrites > 0, 'the independent save actually failed');
    const snapshot = f.posts.filter(event => event.type === 'projectTasksState').at(-1)?.cards[0]?.contextUsageSnapshot;
    assert.equal(snapshot?.usage.usedPercent, 10); assert.equal(snapshot?.sequence, 100);
    assert.ok(f.posts.filter(event => event.type === 'projectTasksState').length - countBefore < 25,
      '100 synchronous usage samples do not publish 100 Registry/card snapshots');
    failUsageSave = false;
    await internal.saveContextUsage();
    const writesAfterFlush = usageWrites;
    assert.ok(writesAfterFlush < 5, 'usage samples do not each rewrite metadata');
    assert.equal(burstRegistryWrites, 0, '100 context estimates must not write the authoritative Registry');
    assert.equal(burstSessionReads, 0, '100 context estimates must not load any full session');
    t.diagnostic(JSON.stringify({ usageSamples: 100, usageMetadataWriteAttempts: writesAfterFlush,
      registryWritesDuringSamples: burstRegistryWrites, fullSessionReadsDuringSamples: burstSessionReads,
      hostPublicationsThroughTerminal: f.posts.filter(event => event.type === 'projectTasksState').length - countBefore }));
    await f.reopen();
    const restored = f.posts.filter(event => event.type === 'projectTasksState').at(-1)?.cards[0]?.contextUsageSnapshot;
    assert.equal(restored?.status, 'last_known'); assert.equal(restored?.usage.usedPercent, 10);
    assert.equal(f.host.tasks.get(card.taskCardId)?.state, 'completed');
    const restoredCard = f.host.tasks.get(card.taskCardId)!;
    const worker = await (f.host as unknown as { worker(card: typeof restoredCard, router: boolean): Promise<KeepseekChatViewProvider> }).worker(restoredCard, false);
    const binding = (worker as unknown as { projectBinding: ProjectWorkerBinding }).projectBinding;
    await binding.onSnapshotChanged!({ ...restoredCard.snapshot, modelId: 'another-window' });
    await binding.onSnapshotChanged!(restoredCard.snapshot);
    const afterRoundtrip = f.posts.filter(event => event.type === 'projectTasksState').at(-1)?.cards[0];
    assert.equal(afterRoundtrip.contextUsageSnapshot, undefined,
      'a lane A → B → A change without a fresh estimate cannot resurrect the old A snapshot');
    assert.equal(afterRoundtrip.firstSubmittedAt, restoredCard.firstSubmittedAt);
    assert.equal(afterRoundtrip.lastActivityAt, restoredCard.lastActivityAt, 'configuration changes do not renew recent activity');
    assert.equal(requests, 0);
  } finally {
    KeepseekChatViewProvider.prototype.executeProjectInput = previousExecute;
    vscode.workspace.fs.rename = previousRename;
    ChatSessionStore.prototype.loadSessionById = previousLoad;
    globalThis.fetch = previousFetch;
  }
});

test('unknown command blocks new dispatch but fenced shutdown still commits task result and interruption audit', async t => {
  const f = await fixture(t);
  const previousExecute = KeepseekChatViewProvider.prototype.executeProjectInput;
  let child: ChildProcess | undefined;
  let dispatched = 0, started!: () => void;
  const unknown = new Promise<void>(resolve => { started = resolve; });
  KeepseekChatViewProvider.prototype.executeProjectInput = async function(context) {
    await context.prepareInput(context.input.content, context.input.inputId);
    await context.incorporated(context.input.inputId);
    const operation = await f.options.owner.beginDurableOperation({ id: 'controlled-unsettled-command', kind: 'command' });
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      cwd: f.options.owner.canonicalRoot, detached: process.platform !== 'win32', stdio: 'ignore'
    });
    await new Promise<void>((resolve, reject) => { child!.once('spawn', resolve); child!.once('error', reject); });
    dispatched++;
    await operation.dispatched({ pid: child.pid, processGroup: process.platform === 'win32' ? undefined : child.pid });
    await operation.settle('result_unknown');
    started();
    if (!context.signal.aborted) await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
    return { result: 'Controlled command outcome remains unknown; no replay is authorized.', usedMs: 17, usageIncomplete: true };
  };
  try {
    await f.host.handleMessage({ type: 'projectTaskCreate', projectId: f.options.owner.projectId,
      requestId: 'unknown-command-task', prompt: 'Controlled command fixture', draftRevision: 1,
      targetId: '$new', sourceId: 'test-source', modelId: 'test-model' });
    await Promise.race([unknown, f.host.tasks.whenIdle().then(() => { throw new Error('Controlled command did not reach the unknown-state barrier'); })]);
    assert.equal(f.options.owner.isOwner, false);
    assert.equal(f.options.owner.canWriteStorage, true, 'the same kernel-fenced host may still save its admitted result');
    await f.host.handleMessage({ type: 'projectTaskCreate', projectId: f.options.owner.projectId,
      requestId: 'denied-after-unknown', prompt: 'Must remain a draft', draftRevision: 2,
      targetId: '$new', sourceId: 'test-source', modelId: 'test-model' });
    assert.equal(f.posts.find(event => event.type === 'projectTaskSubmissionResult' && event.requestId === 'denied-after-unknown')?.status, 'failed');
    assert.equal(dispatched, 1);
    const card = f.host.tasks.list()[0];
    const shutdown = f.host.dispose();
    assert.equal(f.host.dispose(), shutdown, 'shutdown retains one awaited result');
    await shutdown;
    assert.equal(f.host.tasks.activeCount, 0);
    assert.equal(f.host.tasks.get(card.taskCardId)?.state, 'interrupted');
    assert.equal(f.host.tasks.get(card.taskCardId)?.usedMs, 17);
    assert.equal(f.host.tasks.inputs(card.taskCardId)[0].state, 'incorporated', 'unknown side effects retain recovery evidence');
    assert.match(f.host.tasks.events()[0].content, /no replay is authorized/);
    const registryUri = (f.host.tasks as unknown as { uri: vscode.Uri }).uri;
    const restored = new ProjectTaskService({ projectId: f.options.owner.projectId,
      storageUri: vscode.Uri.file(join(registryUri.fsPath, '..')) as never,
      createSession: async () => { throw new Error('Audit restore cannot create a session'); },
      driverFactory: () => { throw new Error('Audit restore cannot dispatch a driver'); } });
    await restored.initialize({ readOnly: true });
    assert.equal(restored.get(card.taskCardId)?.state, 'interrupted');
    assert.equal(restored.get(card.taskCardId)?.usedMs, 17);
    assert.equal(restored.events()[0].content, f.host.tasks.events()[0].content);
    await restored.dispose();
    assert.equal(dispatched, 1, 'durable audit recovery never replays the unknown command');
    const diagnosis = await f.options.owner.diagnostics();
    assert.equal(diagnosis.operations.find(operation => operation.id === 'controlled-unsettled-command')?.state, 'result_unknown');
    assert.equal(f.options.owner.isOwner, false);
  } finally {
    KeepseekChatViewProvider.prototype.executeProjectInput = previousExecute;
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child.kill(); await exited;
    }
  }
});

test('observer summary scopes become writable only after promotion and can execute a new independent task', async t => {
  const f = await fixture(t);
  await f.host.handleMessage({ type: 'projectTaskAssociate', projectId: f.options.owner.projectId, sessionId: f.session.id });
  const oldCard = f.host.tasks.list()[0];
  const root = f.options.owner.canonicalRoot;
  const observerOwner = await ProjectExecutionOwner.acquire({ projectUri: root, lockRoot: join(root, 'locks') });
  assert.equal(observerOwner.isOwner, false);
  const observerStorage = new GlobalSessionStorage(f.options.storageUri);
  observerStorage.setReadOnly(true);
  const observerStore = new ChatSessionStore(observerStorage, 'en', { key: f.store.workspaceKey, name: 'observer', folderUris: [vscode.Uri.file(root).toString()] });
  observerStore.setReadOnly(true);
  await observerStore.initializeFreshBoot();
  const posts: Array<Record<string, any>> = [];
  const observer = new ProjectAssistantHost({ ...f.options, owner: observerOwner, sessionStore: observerStore,
    resources: new ProjectResourceCoordinator(observerOwner.projectId), windowId: 'promoted-observer', publish: event => posts.push(event as Record<string, any>) });
  const previousExecute = KeepseekChatViewProvider.prototype.executeProjectInput;
  let executions = 0;
  KeepseekChatViewProvider.prototype.executeProjectInput = async function(context) {
    executions++;
    await context.prepareInput(context.input.content, context.input.inputId);
    await context.incorporated(context.input.inputId);
    return { result: 'New task completed after promotion' };
  };
  try {
    await observer.initialize();
    await observer.handleMessage({ type: 'projectTaskOpen', projectId: observerOwner.projectId });
    await observer.handleMessage({ type: 'projectTaskView', projectId: observerOwner.projectId, taskCardId: oldCard.taskCardId, mode: 'task', viewGeneration: 3 });
    assert.equal(executions, 0, 'viewing the old task remains a pure page read');
    assert.equal((observer as unknown as { workers: Map<string, unknown> }).workers.size, 0);
    await f.host.dispose(); await f.options.owner.dispose();
    await observerOwner.retryAcquire();
    assert.equal(observerOwner.isOwner, true);
    observerStorage.setReadOnly(!observerOwner.canWriteStorage); // Root activation synchronizes the shared adapter.
    observer.publishOwnershipChanged();
    await observer.handleMessage({ type: 'projectTaskCreate', projectId: observerOwner.projectId,
      requestId: 'promoted-new-task', prompt: 'Fresh independent task', draftRevision: 1,
      targetId: '$new', sourceId: 'test-source', modelId: 'test-model' });
    await observer.tasks.whenIdle();
    assert.equal(posts.find(event => event.type === 'projectTaskSubmissionResult' && event.requestId === 'promoted-new-task')?.status, 'accepted');
    const created = observer.tasks.list().find(card => card.taskCardId !== oldCard.taskCardId)!;
    assert.ok(created);
    assert.equal(created.state, 'completed');
    assert.equal(executions, 1);
    assert.equal(JSON.stringify(f.store.getSessionById(f.session.id)), f.before, 'promotion never executes or rewrites the viewed old task');
  } finally {
    KeepseekChatViewProvider.prototype.executeProjectInput = previousExecute;
    await observer.dispose(); await observerStorage.flush(); await observerOwner.dispose();
  }
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
  await f.host.handleMessage({ ...draft, targetId: '$new', revision: 100, markup: 'Saved explicit new-task draft' });
  await f.reopen();
  await f.host.handleMessage({ type: 'projectTaskView', projectId: f.options.owner.projectId, taskCardId: null, mode: 'new', viewGeneration: 6 });
  const newTarget = f.posts.filter(item => item.type === 'projectTasksState' && item.viewMode === 'new').at(-1)!;
  assert.equal(newTarget.draft.revision, 100, 'explicit new-task entry hydrates its saved revision before accepting edits');
  assert.equal(newTarget.draft.markup, 'Saved explicit new-task draft');
  await f.host.handleMessage({ ...draft, targetId: '$new', revision: 101, markup: 'Newest explicit new-task draft' });
  await f.reopen();
  await f.host.handleMessage({ type: 'projectTaskView', projectId: f.options.owner.projectId, taskCardId: null, mode: 'new', viewGeneration: 7 });
  assert.equal(f.posts.filter(item => item.type === 'projectTasksState' && item.viewMode === 'new').at(-1)!.draft.markup, 'Newest explicit new-task draft');
});

test('sidebar actions reject retired Hosts and stale full task identities before any mutation', async t => {
  const f = await fixture(t);
  await (f.host as unknown as { ensureExecutionLoaded(): Promise<void> }).ensureExecutionLoaded();
  const card = await f.host.tasks.associateSession({ sessionId: f.session.id, title: 'Identity fixture',
    requestId: 'identity-association', snapshot: f.options.defaults() });
  const hostId = f.posts.filter(event => event.type === 'projectTasksState').at(-1)!.hostId;
  const identity = { projectId: card.projectId, taskCardId: card.taskCardId, hostId,
    sessionId: card.sessionId, rootTaskId: card.rootTaskId, segmentId: card.segmentId, generation: card.generation };
  const before = JSON.stringify(f.host.tasks.list());
  const faults = [{ hostId: 'retired-host' }, { sessionId: 'different-session' }, { rootTaskId: 'previous-root' },
    { segmentId: 'previous-segment' }, { generation: card.generation + 1 }, { sessionId: undefined }];
  let rejected = 0;
  for (const type of ['projectTaskStop', 'projectTaskResume', 'projectTaskArchive', 'projectTaskDelete']) {
    for (const fault of faults) {
      const errors = f.posts.filter(event => event.type === 'projectTaskError').length;
      await f.host.handleMessage({ ...identity, ...fault, type } as never);
      assert.equal(f.posts.filter(event => event.type === 'projectTaskError').length, errors + 1);
      assert.equal(JSON.stringify(f.host.tasks.list()), before, 'a stale action cannot change activity, state, archive or evidence');
      rejected++;
    }
  }
  assert.equal(rejected, 24);
  assert.equal((f.host as unknown as { workers: Map<string, unknown> }).workers.size, 0);
  await f.host.handleMessage({ ...identity, type: 'projectTaskArchive', archived: true } as never);
  assert.equal(f.host.tasks.get(card.taskCardId)?.archived, true, 'a matching identity remains usable');
  await f.host.handleMessage({ ...identity, type: 'projectTaskArchive', archived: false } as never);
  assert.equal(f.host.tasks.get(card.taskCardId)?.archived, false);
  assert.equal(f.host.tasks.get(card.taskCardId)?.lastActivityAt, card.lastActivityAt);
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
      if (value.type === 'projectTasksState' && value.historyReady && value.readOnly && !watcherInjectionScheduled) {
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
    await observer.handleMessage({ type: 'projectTaskOpen', projectId: observerOwner.projectId });
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
