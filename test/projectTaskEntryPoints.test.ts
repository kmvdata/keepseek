import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import * as vscodeStub from './stubs/vscode';
import { ProjectAssistantHost } from '../src/provider/projectAssistantHost';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { SharedProjectSources } from '../src/context/sharedProjectSources';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { getProjectExecutionContext, ProjectResourceCoordinator } from '../src/tasks/projectResources';
import { ProjectRequestAdmission } from '../src/tasks/requestAdmission';
import type { TaskDefaultsSnapshot } from '../src/tasks/projectTasks';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import { createWebviewDomHarness } from './webviewDomHarness';
import type { TaskContextUsageSnapshot } from '../src/shared/types';
import type { ModelSourceProvider } from '../src/accounts/types';
import { taskUsageLaneFingerprint } from '../src/tasks/taskUsageSnapshot';

type Transport = { url: string; body: Record<string, unknown>; rawBody: string; signal?: AbortSignal | null;
  scope?: { sessionId: string; rootTaskId: string; segmentId: string; runtimeId: string }; role: string };

test('actual Host stamped legacy sendPrompt commits to the target inbox and cannot fall through a view-selected legacy Runner', async t => {
  const f = await fixture(t);
  await f.send({ type: 'projectTaskCreate', requestId: 'legacy-a', prompt: 'ENTRY_INITIAL_A', draftRevision: 1 });
  await f.host.tasks.whenIdle();
  await f.send({ type: 'projectTaskCreate', requestId: 'legacy-b', prompt: 'ENTRY_INITIAL_B', draftRevision: 1 });
  await f.host.tasks.whenIdle();
  const [a, b] = f.host.tasks.list();
  await f.send({ type: 'projectTaskView', taskCardId: b.taskCardId, viewGeneration: 1 });
  const previousCalls = f.workers.length;
  assert.equal(await f.send({ type: 'sendPrompt', taskCardId: a.taskCardId, sessionId: a.sessionId,
    requestId: 'stamped-legacy-a', prompt: 'ENTRY_STAMPED_TARGET_A', sourceId: 'ignored-view-source', modelId: 'ignored-view-model' }), true);
  const accepted = f.posts.find(post => post.type === 'submissionResult' && post.requestId === 'stamped-legacy-a');
  assert.equal(accepted?.status, 'accepted');
  const input = f.host.tasks.findInputByRequestId('stamped-legacy-a');
  assert.ok(input); assert.equal(input.taskCardId, a.taskCardId); assert.equal(input.sessionId, a.sessionId);
  assert.notEqual(input.rootTaskId, a.rootTaskId);
  await f.host.tasks.whenIdle();
  assert.equal(f.workers.length, previousCalls + 1);
  assert.equal(f.workers.at(-1)?.body.model, 'entry-model');
  assert.equal(f.workers.at(-1)?.url, 'https://entry-fixture.invalid/v1/chat/completions');
  const aSession = await f.load(a.sessionId), bSession = await f.load(b.sessionId);
  assert.ok(aSession?.messages.some(message => message.id === input.inputId && message.content === 'ENTRY_STAMPED_TARGET_A'));
  assert.ok(!bSession?.messages.some(message => message.content === 'ENTRY_STAMPED_TARGET_A'));
  assert.equal(f.host.selectedTaskId, b.taskCardId, 'targeting A does not select it or repurpose B');
  await f.assertEveryWorkerInputTracked();
  const beforeUnstamped = f.workers.length;
  assert.equal(await f.send({ type: 'sendPrompt', sessionId: b.sessionId, requestId: 'unstamped-old-client',
    prompt: 'MUST_NOT_BYPASS_TASK_INBOX', sourceId: 'fixture', modelId: 'entry-model' }), true);
  assert.equal(f.host.tasks.findInputByRequestId('unstamped-old-client'), undefined);
  assert.equal(f.workers.length, beforeUnstamped, 'old unstamped mutation never escapes to another execution entry point');
  assert.equal(f.posts.find(post => post.type === 'submissionResult' && post.requestId === 'unstamped-old-client')?.status, 'rejected',
    'legacy submission receives a visible terminal rejection so its draft stays editable');
  assert.equal(f.routerCalls(), 0);
});

test('actual Host editUserPrompt persists its truncation target and a new root before actual same-session Runner execution', async t => {
  const f = await fixture(t);
  await f.send({ type: 'projectTaskCreate', requestId: 'edit-origin', prompt: 'ENTRY_RETAINED_FIRST_TURN', draftRevision: 1 });
  await f.host.tasks.whenIdle();
  const original = f.host.tasks.list()[0];
  await f.send({ type: 'sendPrompt', taskCardId: original.taskCardId, sessionId: original.sessionId,
    requestId: 'edit-second', prompt: 'ENTRY_OLD_SECOND_TURN', sourceId: 'fixture', modelId: 'entry-model' });
  await f.host.tasks.whenIdle();
  const before = await f.load(original.sessionId);
  assert.ok(before);
  const users = before.messages.filter(message => message.role === 'user');
  assert.equal(users.length, 2);
  const retained = { user: providerBytes(users[0]), assistant: before.messages[1].content,
    rounds: structuredClone(before.messages[1].toolRounds), replay: structuredClone(before.messages[1].providerReplay) };
  const oldRoot = users[1].userTask!.id;
  const oldSecondAnswer = before.messages.at(-1)!.id;
  assert.equal(await f.send({ type: 'editUserPrompt', taskCardId: original.taskCardId, sessionId: original.sessionId,
    requestId: 'durable-edit', messageId: users[1].id, prompt: 'ENTRY_EDITED_SECOND_TURN', sourceId: 'fixture', modelId: 'entry-model' }), true);
  const input = f.host.tasks.findInputByRequestId('durable-edit');
  assert.ok(input); assert.equal(input.replaceMessageId, users[1].id); assert.notEqual(input.rootTaskId, oldRoot);
  assert.equal(input.sessionId, original.sessionId);
  assert.ok(f.posts.some(post => post.type === 'submissionResult' && post.requestId === 'durable-edit' && post.status === 'accepted'));
  await f.host.tasks.whenIdle();
  assert.equal(f.host.tasks.get(original.taskCardId)?.state, 'completed', f.host.tasks.get(original.taskCardId)?.error);
  const after = await f.load(original.sessionId);
  assert.ok(after);
  const afterUsers = after.messages.filter(message => message.role === 'user');
  assert.deepEqual(afterUsers.map(message => message.id), [users[0].id, input.inputId]);
  assert.equal(afterUsers[1].userTask?.id, input.rootTaskId);
  assert.ok(!after.messages.some(message => message.id === oldSecondAnswer));
  assert.deepEqual({ user: providerBytes(afterUsers[0]), assistant: after.messages[1].content,
    rounds: after.messages[1].toolRounds, replay: after.messages[1].providerReplay }, retained);
  const lastRequestUsers = requestUsers(f.workers.at(-1)!.body);
  assert.equal(lastRequestUsers.at(-1)?.content, providerBytes(afterUsers[1]));
  assert.ok(!lastRequestUsers.some(message => String(message.content).includes('ENTRY_OLD_SECOND_TURN')));
  const calls = f.workers.length;
  await f.send({ type: 'editUserPrompt', taskCardId: original.taskCardId, sessionId: original.sessionId,
    requestId: 'durable-edit', messageId: users[1].id, prompt: 'ENTRY_EDITED_SECOND_TURN', sourceId: 'fixture', modelId: 'entry-model' });
  await f.host.tasks.whenIdle();
  assert.equal(f.workers.length, calls, 'a duplicate legacy edit ACK never truncates or sends again');
  assert.equal(f.host.tasks.inputs(original.taskCardId).filter(item => item.requestId === 'durable-edit').length, 1);
  assert.equal(f.routerCalls(), 0);
});

test('actual Host legacy abortPrompt stops its card and continueAgentTask re-enters durable recovery with the same root and segment', async t => {
  const f = await fixture(t);
  let aborted = false;
  f.workerReply = transport => new Promise<Response>((_resolve, reject) => {
    const abort = () => { aborted = true; reject(new DOMException('Controlled user cancellation', 'AbortError')); };
    if (transport.signal?.aborted) abort(); else transport.signal?.addEventListener('abort', abort, { once: true });
  });
  await f.send({ type: 'projectTaskCreate', requestId: 'abort-origin', prompt: 'ENTRY_ABORT_THEN_CONTINUE', draftRevision: 1 });
  await until(() => f.workers.length === 1, 'first real Worker request');
  const running = f.host.tasks.list()[0];
  const frozenRequest = JSON.stringify(f.workers[0].body);
  assert.equal(await f.send({ type: 'abortPrompt', taskCardId: running.taskCardId, sessionId: running.sessionId }), true);
  await f.host.tasks.whenIdle();
  assert.equal(aborted, true);
  const stopped = f.host.tasks.get(running.taskCardId)!;
  assert.equal(stopped.state, 'cancelled'); assert.equal(stopped.rootTaskId, running.rootTaskId);
  assert.equal(f.workers.length, 1);
  const interrupted = await f.load(stopped.sessionId);
  const answer = interrupted?.messages.find(message => message.role === 'assistant');
  assert.ok(answer);
  f.workerReply = () => textReply('Resumed using the saved execution checkpoint.');
  assert.equal(await f.send({ type: 'continueAgentTask', taskCardId: stopped.taskCardId, sessionId: stopped.sessionId, messageId: answer.id }), true);
  await f.host.tasks.whenIdle();
  const resumed = f.host.tasks.get(stopped.taskCardId)!;
  assert.equal(resumed.state, 'completed', resumed.error);
  assert.equal(resumed.rootTaskId, stopped.rootTaskId); assert.equal(resumed.segmentId, stopped.segmentId);
  assert.ok(resumed.generation > stopped.generation);
  assert.equal(f.workers.length, 2);
  assert.equal(JSON.stringify(f.workers[1].body), frozenRequest, 'exact recovery reuses the original actual transport bytes');
  const after = await f.load(stopped.sessionId);
  const realUsers = after!.messages.filter(message => message.role === 'user');
  assert.equal(realUsers.length, 1, 'Continue does not synthesize another user message');
  assert.equal(realUsers[0].userTask?.id, stopped.rootTaskId);
  assert.ok(f.host.tasks.inputs(stopped.taskCardId).every(input => input.rootTaskId === stopped.rootTaskId));
  assert.equal(f.routerCalls(), 0);
});

test('actual Host shutdown retains a draft-save failure while aborting the active transport and reusing one rejected shutdown promise', async t => {
  const f = await fixture(t);
  let aborted = false;
  f.workerReply = transport => new Promise<Response>((_resolve, reject) => {
    const abort = () => { aborted = true; reject(new DOMException('Host shutdown cancelled this request', 'AbortError')); };
    if (transport.signal?.aborted) abort(); else transport.signal?.addEventListener('abort', abort, { once: true });
  });
  await f.send({ type: 'projectTaskCreate', requestId: 'shutdown-save-failure', prompt: 'ENTRY_SHUTDOWN_ACTIVE_TRANSPORT', draftRevision: 1 });
  await until(() => f.workers.length === 1, 'active actual Worker transport before shutdown');
  const card = f.host.tasks.list()[0];
  const calls = f.transports.length;
  const failure = new Error('Injected task draft persistence failure');
  let draftWrites = 0;
  const internals = f.host as unknown as { persistDrafts(): Promise<void> };
  const originalPersistDrafts = internals.persistDrafts;
  internals.persistDrafts = async () => { draftWrites += 1; throw failure; };
  f.expectDisposeFailure(failure);
  try {
    const firstShutdown = f.host.dispose();
    const secondShutdown = f.host.dispose();
    assert.equal(secondShutdown, firstShutdown, 'duplicate shutdown joins the original operation');
    await assert.rejects(firstShutdown, error => error instanceof AggregateError && error.errors.includes(failure));
    assert.equal(aborted, true, 'draft persistence failure must not strand a live transport');
    assert.equal(f.host.tasks.activeCount, 0);
    assert.equal(f.host.tasks.get(card.taskCardId)?.state, 'interrupted');
    assert.equal(f.host.tasks.get(card.taskCardId)?.rootTaskId, card.rootTaskId);
    assert.equal(f.transports.length, calls, 'closing never creates another Worker or Provider request');
    assert.equal(draftWrites, 1);
    const repeated = f.host.dispose();
    assert.equal(repeated, firstShutdown);
    await assert.rejects(repeated, error => error instanceof AggregateError && error.errors.includes(failure));
    assert.equal(draftWrites, 1, 'the retained failure does not silently retry or erase the failed write');
  } finally { internals.persistDrafts = originalPersistDrafts; }
});

for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as const) {
test(`sidebar display gestures and local task browsing add zero ${provider} model requests to settled Workers`, async t => {
  const f = await fixture(t, { webview: true, provider });
  await f.send({ type: 'projectTaskCreate', requestId: 'sidebar-static-a', prompt: 'SIDEBAR_STATIC_A', draftRevision: 1 });
  await f.host.tasks.whenIdle();
  f.selectDefaultModel('entry-wide');
  await f.send({ type: 'projectTaskCreate', requestId: 'sidebar-static-b', prompt: 'SIDEBAR_STATIC_B', draftRevision: 1 });
  await f.host.tasks.whenIdle();
  await f.flushTitleWork();
  const cards = f.host.tasks.list();
  assert.deepEqual(cards.map(card => card.snapshot.modelId), ['entry-model', 'entry-wide']);
  assert.deepEqual(f.workers.map(capture => capture.body.model), ['entry-model', 'entry-wide']);
  const terminal = f.posts.filter(post => post.type === 'projectTasksState' && Array.isArray(post.cards)).at(-1)!;
  const published = terminal.cards as Array<{ taskCardId: string; contextUsageSnapshot?: TaskContextUsageSnapshot }>;
  const snapshots = cards.map(card => {
    const snapshot = published.find(candidate => candidate.taskCardId === card.taskCardId)?.contextUsageSnapshot;
    assert.ok(snapshot, 'a background Worker must publish its actual estimate by terminal Host publication without viewing it');
    assert.deepEqual(snapshot.identity, { projectId: card.projectId, taskCardId: card.taskCardId, sessionId: card.sessionId,
      rootTaskId: card.rootTaskId, segmentId: card.segmentId, generation: card.generation,
      hostId: terminal.hostId, runtimeId: snapshot.identity.runtimeId });
    assert.equal(snapshot.configurationFingerprint, taskUsageLaneFingerprint(card.snapshot));
    assert.ok(snapshot.identity.runtimeId && snapshot.sequence > 0 && snapshot.projectionRevision > 0);
    assert.ok(Number.isFinite(Date.parse(snapshot.recordedAt)) && snapshot.usage.maxTokensEstimate > 0);
    return { taskCardId: card.taskCardId, modelId: card.snapshot.modelId, snapshot };
  });
  assert.notEqual(snapshots[0].snapshot.identity.runtimeId, snapshots[1].snapshot.identity.runtimeId);
  assert.notEqual(snapshots[0].snapshot.configurationFingerprint, snapshots[1].snapshot.configurationFingerprint);
  assert.notEqual(snapshots[0].snapshot.laneFingerprint, snapshots[1].snapshot.laneFingerprint);
  assert.notEqual(snapshots[0].snapshot.usage.maxTokensEstimate, snapshots[1].snapshot.usage.maxTokensEstimate,
    '64K and 128K Worker estimates retain their independent denominators');
  const before = f.transports.map(capture => capture.rawBody);
  const historiesBefore = await Promise.all(cards.map(async card => JSON.stringify((await f.load(card.sessionId))?.messages)));
  const scopeBefore = f.host.tasks.list().map(card => ({ taskCardId: card.taskCardId, sessionId: card.sessionId,
    rootTaskId: card.rootTaskId, generation: card.generation, state: card.state }));
  const operations = await sidebarDisplayActions(f);
  await f.flushTitleWork();
  assert.deepEqual(f.transports.map(capture => capture.rawBody), before,
    'hover/focus/open/close/ranges/view/Latest/ready are local reads, including title, summary and reviewer roles');
  assert.deepEqual(await Promise.all(cards.map(async card => JSON.stringify((await f.load(card.sessionId))?.messages))), historiesBefore,
    'sidebar reads preserve the complete persisted history, including protocol-native replay and exact user bytes');
  assert.deepEqual(f.host.tasks.list().map(card => ({ taskCardId: card.taskCardId, sessionId: card.sessionId,
    rootTaskId: card.rootTaskId, generation: card.generation, state: card.state })), scopeBefore);
  await persistSidebarRequestEvidence(provider + ':settled', f.transports, before.length, operations, cards, snapshots);
});

test(`sidebar gestures while an actual ${provider} Worker continues preserve role/root attribution and its frozen request prefix`, async t => {
  const f = await fixture(t, { webview: true, provider });
  await f.send({ type: 'projectTaskCreate', requestId: 'sidebar-background-b', prompt: 'SIDEBAR_VIEW_B', draftRevision: 1 });
  await f.host.tasks.whenIdle(); await f.flushTitleWork();
  let release!: (value: Response) => void;
  const gate = new Promise<Response>(resolve => { release = resolve; });
  let activeCalls = 0;
  f.workerReply = transport => {
    if (JSON.stringify(transport.body).includes('SIDEBAR_BACKGROUND_A')) {
      activeCalls += 1;
      if (activeCalls !== 1) return nativeTextReply(provider, 'Controlled continuation finished.');
      return new Promise<Response>((resolve, reject) => {
        const abort = () => reject(new DOMException('Controlled background request aborted', 'AbortError'));
        if (transport.signal?.aborted) abort(); else transport.signal?.addEventListener('abort', abort, { once: true });
        void gate.then(response => { transport.signal?.removeEventListener('abort', abort); resolve(response); });
      });
    }
    return nativeTextReply(provider, 'Unrelated existing task.');
  };
  t.after(() => { release(nativeTextReply(provider, 'Released during test cleanup.')); });
  await f.send({ type: 'projectTaskCreate', requestId: 'sidebar-background-a', prompt: 'SIDEBAR_BACKGROUND_A', draftRevision: 1 });
  await until(() => activeCalls === 1, 'background Worker first controlled request');
  const a = f.host.tasks.list().find(card => f.host.tasks.inputs(card.taskCardId).some(input => input.requestId === 'sidebar-background-a'))!;
  const first = f.workers.at(-1)!;
  const frozen = first.rawBody;
  const countBefore = f.transports.length;
  const operations = await sidebarDisplayActions(f);
  assert.equal(f.transports.length, countBefore, 'sidebar gestures cannot add requests while the original request is gated');
  assert.equal(first.rawBody, frozen);
  assert.equal(JSON.stringify(first.body), frozen);
  assert.equal(f.host.tasks.get(a.taskCardId)?.state, 'running');
  release(nativeTextReply(provider, 'Controlled partial response.', 'length'));
  await f.host.tasks.whenIdle(); await f.flushTitleWork();
  assert.equal(f.transports.length, countBefore + 2,
    'after release only the normal Worker continuation and the task-completion title request may be added');
  const background = f.workers.filter(capture => capture.scope?.rootTaskId === a.rootTaskId);
  assert.equal(background.length, 2, 'only the explicitly released Worker continuation adds another Worker request');
  assert.ok(background.every(capture => capture.scope?.sessionId === a.sessionId && capture.role === 'worker'));
  assert.deepEqual(background[1].body.tools, first.body.tools, 'frozen tools and order survive all sidebar gestures');
  assert.deepEqual(requestUsers(background[1].body)[0], requestUsers(first.body)[0], 'persisted original user bytes remain exact');
  const system = (capture: Transport) => requestSystem(capture.body);
  assert.deepEqual(system(background[1]), system(first), 'static system remains exact during background continuation');
  assert.ok(background.every(capture => !/firstSubmittedAt|lastActivityAt|contextUsageSnapshot|projectSidebar/.test(capture.rawBody)));
  assert.equal(f.routerCalls(), 0);
  await persistSidebarRequestEvidence(provider + ':background_continuation', f.transports, countBefore, operations, f.host.tasks.list());
});
}

async function fixture(t: TestContext, options: { webview?: boolean; provider?: ModelSourceProvider } = {}) {
  const provider = options.provider ?? 'openai-compatible';
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-project-entry-'));
  const projectPath = join(directory, 'workspace'), storagePath = join(directory, 'storage'), codexPath = join(directory, 'codex');
  await Promise.all([mkdir(projectPath), mkdir(storagePath), mkdir(codexPath)]);
  const project = vscode.Uri.file(projectPath), storageUri = vscode.Uri.file(storagePath);
  const previousFolders = vscodeStub.workspace.workspaceFolders;
  const previousWindow = { ...vscodeStub.window };
  const previousStatusBarFactory = (vscodeStub.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
  const previousAlignment = (vscodeStub as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  const previousCodexHome = process.env.CODEX_HOME;
  const previousFetch = globalThis.fetch;
  process.env.CODEX_HOME = codexPath;
  vscodeStub.workspace.workspaceFolders = [{ uri: project as never, name: 'Entry fixture' }];
  Object.assign(vscodeStub, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscodeStub.window, { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) });
  const owner = await ProjectExecutionOwner.acquire({ projectUri: project, lockRoot: join(directory, 'locks') });
  assert.equal(owner.isOwner, true, owner.reason);
  const storage = new GlobalSessionStorage(storageUri);
  const store = new ChatSessionStore(storage, 'en', { key: 'entry-fixture', name: 'Entry fixture', folderUris: [project.toString()] });
  await store.initialize();
  await new ModelSourceStore(storageUri).createSource({ id: 'fixture', name: 'Entry controlled source', provider,
    apiKey: 'controlled-test-key', baseUrl: 'https://entry-fixture.invalid/v1', models: [
      { id: 'entry-model', contextWindowTokens: 64000, maxOutputTokens: 2000 },
      { id: 'entry-wide', contextWindowTokens: 128000, maxOutputTokens: 2000 }
    ] });
  const defaults: TaskDefaultsSnapshot = { sourceId: 'fixture', modelId: 'entry-model', wireModel: 'entry-model',
    endpoint: 'https://entry-fixture.invalid/v1', protocol: provider, rootUri: project.toString(), cwdUri: project.toString(),
    approvalMode: 'ask', executionMode: 'normal', skillIds: [], configuration: { settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' } } };
  const sources = new SharedProjectSources();
  const view = options.webview ? createWebviewDomHarness() : undefined;
  view?.receive({ type: 'state', revision: 1, state: { activeSessionId: store.activeSessionId, language: 'en',
    startup: { interactiveReady: true, sideEffectsReady: true } } });
  const posts: Array<Record<string, unknown>> = [], workers: Transport[] = [], transports: Transport[] = [];
  let workerReply: (transport: Transport) => Response | Promise<Response> = () => nativeTextReply(provider, 'Controlled Worker answer.');
  globalThis.fetch = (async (url, init) => {
    assert.equal(typeof init?.body, 'string', 'every fixture request must be an inspectable actual Provider payload');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const execution = getProjectExecutionContext();
    const transport: Transport = { url: String(url), body, rawBody: String(init?.body), signal: init?.signal,
      scope: execution ? { ...execution.scope } : undefined,
      role: String(JSON.stringify(body.tools)).includes('keepseek_tasks_create') ? 'router' : body.tools ? execution?.requestRole ?? 'worker' : 'session_title' };
    transports.push(transport);
    if (body.tools) { workers.push(transport); return workerReply(transport); }
    return nativeTextReply(provider, '{"decision":"defer","title":null}');
  }) as typeof fetch;
  const host = new ProjectAssistantHost({ owner, resources: new ProjectResourceCoordinator(owner.projectId), admission: new ProjectRequestAdmission(), sources,
    windowId: 'entry-fixture', extensionUri: storageUri, storageUri, sessionStore: store,
    skillState: { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    extensionInfo: { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    defaults: () => structuredClone(defaults), publish: value => { posts.push(value as Record<string, unknown>); view?.receive(value); } });
  await host.initialize();
  let expectedDisposeFailure: Error | undefined;
  t.after(async () => {
    try {
      await host.dispose().catch(error => {
        if (!expectedDisposeFailure || !(error instanceof AggregateError) || !error.errors.includes(expectedDisposeFailure)) throw error;
      });
      await storage.flush(); await owner.dispose(); sources.dispose();
    }
    finally {
      globalThis.fetch = previousFetch; vscodeStub.workspace.workspaceFolders = previousFolders; Object.assign(vscodeStub.window, previousWindow);
      if (previousStatusBarFactory === undefined) delete (vscodeStub.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
      if (previousAlignment === undefined) delete (vscodeStub as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
      else Object.assign(vscodeStub, { StatusBarAlignment: previousAlignment });
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousCodexHome;
      await rm(directory, { recursive: true, force: true });
    }
  });
  const load = async (sessionId: string) => {
    const scope = await store.findSessionScope(sessionId); assert.ok(scope);
    return (await store.createWorkspaceScope(scope)).loadSessionById(sessionId);
  };
  let viewMessageIndex = 0;
  return { host, posts, workers, transports, load, view,
    selectDefaultModel: (modelId: 'entry-model' | 'entry-wide') => { defaults.modelId = modelId; defaults.wireModel = modelId; },
    flushViewMessages: async () => {
      if (!view) return;
      for (let safety = 0; safety < 1000 && viewMessageIndex < view.posted.length; safety++) {
        const message = view.posted[viewMessageIndex++];
        if (message.type.startsWith('project')) await host.handleMessage(message as unknown as WebviewMessage);
      }
      assert.equal(viewMessageIndex, view.posted.length, 'view/Host feedback must settle with bounded messages');
    },
    flushTitleWork: async () => {
      // Join existing title operations; never create a naming candidate from viewing.
      const workers = (host as unknown as { workers: Map<string, Promise<{ sessionTitles: { flush(): Promise<void> } }>> }).workers;
      await Promise.all([...workers.values()].map(async promise => (await promise).sessionTitles.flush()));
    },
    expectDisposeFailure: (error: Error) => { expectedDisposeFailure = error; },
    get workerReply() { return workerReply; }, set workerReply(value: (transport: Transport) => Response | Promise<Response>) { workerReply = value; },
    send: (message: Record<string, unknown>) => host.handleMessage({ projectId: owner.projectId, ...message } as unknown as WebviewMessage),
    routerCalls: () => transports.filter(item => String(JSON.stringify(item.body.tools)).includes('keepseek_tasks_create')).length,
    assertEveryWorkerInputTracked: async () => {
      const sessions = await Promise.all(host.tasks.list().map(card => load(card.sessionId)));
      const inputs = sessions.flatMap(session => session?.messages.filter(message => message.role === 'user').map(providerBytes) ?? []);
      for (const transport of workers) assert.ok(inputs.includes(String(requestUsers(transport.body).at(-1)?.content)), 'actual Worker transport must point to a real durable task input');
    }
  };
}

async function until(condition: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 20000;
  while (!condition()) { if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function sidebarDisplayActions(f: Awaited<ReturnType<typeof fixture>>): Promise<string[]> {
  const view = f.view!;
  const operations: string[] = [];
  const toggle = view.element('projectSidebarToggle');
  assert.ok(toggle, 'the actual generated Webview has the sidebar toggle');
  const targetBefore = view.element('projectInputTarget').textContent;
  const viewRequestsBefore = view.posted.filter(item => item.type === 'projectTaskView').length;
  toggle.click(); toggle.click(); operations.push('open', 'close');
  const history = view.element('projectTaskHistory'); history.click(); operations.push('all_history');
  const scope = view.element('projectTaskScope');
  scope.value = 'recent'; scope.dispatchEvent({ type: 'change' }); operations.push('recent');
  scope.value = 'all'; scope.dispatchEvent({ type: 'change' }); operations.push('all');
  const archived = view.element('projectShowArchived');
  archived.checked = true; archived.dispatchEvent({ type: 'change' });
  archived.checked = false; archived.dispatchEvent({ type: 'change' }); operations.push('archived_range');
  const rail = view.element('projectTaskRailList');
  const button = rail.querySelector('button'); assert.ok(button);
  button.dispatchEvent({ type: 'mouseenter' }); button.dispatchEvent({ type: 'focus' });
  button.dispatchEvent({ type: 'focusin' }); button.dispatchEvent({ type: 'mouseleave' }); operations.push('hover', 'focus');
  assert.equal(view.element('projectInputTarget').textContent, targetBefore, 'display-only gestures preserve input target');
  assert.equal(view.posted.filter(item => item.type === 'projectTaskView').length, viewRequestsBefore);
  await f.flushViewMessages();
  const ids = f.host.tasks.list().map(card => card.taskCardId);
  for (const id of [ids[0], ids[1], ids[0]]) {
    const node = rail.querySelector('[data-task-card-id="' + id + '"]');
    assert.ok(node); (node.tagName === 'BUTTON' ? node : node.querySelector('button'))!.click();
    await f.flushViewMessages();
  }
  operations.push('view_A_B_A', 'restore_drafts');
  // Latest is a bounded local page read, even if the current page has no newer tail.
  const current = f.posts.filter(post => post.type === 'projectTasksState').at(-1)!;
  await f.send({ type: 'projectTaskLatest', taskCardId: f.host.selectedTaskId, viewGeneration: current.viewGeneration });
  operations.push('latest_local_page');
  view.element('projectAssistantView').click(); await f.flushViewMessages(); operations.push('view_project_assistant');
  await f.send({ type: 'ready' }); operations.push('ready_reconnect');
  view.advance(60_001); await f.flushViewMessages(); operations.push('expiry_recalculation');
  assert.equal(view.posted.filter(item => ['projectAssistantSubmit', 'projectTaskCreate', 'projectTaskSubmit', 'sendPrompt'].includes(item.type)).length, 0);
  return operations;
}

async function persistSidebarRequestEvidence(name: string, transports: Transport[], beforeCount: number, operations: string[],
  cards: Array<{ taskCardId: string; sessionId: string; rootTaskId: string }>,
  usageSnapshots?: Array<{ taskCardId: string; modelId: string; snapshot: TaskContextUsageSnapshot }>): Promise<void> {
  const path = process.env.KEEPSEEK_SIDEBAR_REQUEST_EVIDENCE_PATH;
  if (!path) return;
  const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
  const requests = transports.map((capture, index) => ({ ordinal: index + 1, role: capture.role,
    taskCardId: cards.find(card => card.sessionId === capture.scope?.sessionId)?.taskCardId ?? null,
    sessionId: capture.scope?.sessionId ?? null, rootTaskId: capture.scope?.rootTaskId ?? null,
    segmentId: capture.scope?.segmentId ?? null, runtimeId: capture.scope?.runtimeId ?? null,
    payloadBytes: Buffer.byteLength(capture.rawBody), payloadSha256: hash(capture.rawBody),
    orderedToolsSha256: hash(JSON.stringify(capture.body.tools ?? [])),
    staticSystemSha256: hash(JSON.stringify(requestSystem(capture.body))),
    firstRealUserSha256: hash(JSON.stringify(requestUsers(capture.body)[0] ?? null)) }));
  const data = { schemaVersion: 1, capturedAt: new Date().toISOString(), node: process.version, platform: process.platform,
    transport: 'Actual Host/Provider/Runner through controlled fetch, no paid Provider requests',
    limits: 'Actual Chat Completions, Responses and Anthropic sidebar attribution cases with controlled fetch; no upstream billing or real cache-hit claim.',
    cases: [] as Array<Record<string, unknown>> };
  try { data.cases = (JSON.parse(await readFile(path, 'utf8')) as typeof data).cases.filter(item => item.name !== name); }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw error; }
  data.cases.push({ name, operations, usageSnapshots, requestCountBeforeActions: beforeCount, requestsAfterTaskSettled: requests.length,
    sidebarTriggeredRequests: 0, normalContinuationWorkerRequests: name.endsWith(':background_continuation') ? 1 : 0,
    normalCompletionTitleRequests: name.endsWith(':background_continuation') ? 1 : 0,
    requestsByRole: Object.fromEntries(['worker', 'router', 'session_title', 'reviewer', 'summary', 'child'].map(role => [role, requests.filter(request => request.role === role).length])), requests });
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(data, null, 2) + '\n');
}
function requestUsers(body: Record<string, unknown>): Array<{ role: string; content: unknown }> {
  return ((body.input ?? body.messages) as Array<{ role: string; content: unknown }>).filter(message => message.role === 'user');
}
function requestSystem(body: Record<string, unknown>): unknown {
  return body.instructions ?? body.system ?? ((body.input ?? body.messages ?? []) as Array<{ role: string }>).filter(message => message.role === 'system' || message.role === 'developer');
}
function providerBytes(message: { content: string; expandedContent?: string; providerContent?: string }): string {
  return (message.providerContent ?? message.expandedContent ?? message.content).trim();
}
function textReply(content: string): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`);
}

function nativeTextReply(provider: ModelSourceProvider, content: string, finish: 'stop' | 'length' = 'stop'): Response {
  const events: object[] = provider === 'openai-responses' ? [{ type: finish === 'length' ? 'response.incomplete' : 'response.completed', response: {
    status: finish === 'length' ? 'incomplete' : 'completed', incomplete_details: finish === 'length' ? { reason: 'max_output_tokens' } : undefined,
    output: [{ type: 'message', id: 'sidebar-response', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: content }] }],
    usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }
  } }] : provider === 'anthropic-compatible' ? [
    { type: 'message_start', message: { id: 'sidebar-message', role: 'assistant', usage: { input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: finish === 'length' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 10 } },
    { type: 'message_stop' }
  ] : [{ choices: [{ delta: { content }, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')
    + (provider === 'openai-responses' || provider === 'anthropic-compatible' ? '' : 'data: [DONE]\n\n'));
}
