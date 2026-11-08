import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { activate, deactivate } from '../src/extension';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore, getCurrentWorkspaceSessionScope, SESSION_STORAGE_KEY } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { configureProjectExecutionEnforcement } from '../src/tasks/projectResources';
import { createWebviewDomHarness } from './webviewDomHarness';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import type { ChatSession } from '../src/shared/types';
import type { ModelSourceStore } from '../src/accounts/accountStore';
import { SessionObjectStore } from '../src/sessions/sessionObjectStore';

test('real activation, stores, Host and generated Webview keep old V1/Memento/task content cold through ready and watcher idle', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-fresh-activation-'));
  const data = vscode.Uri.file(join(root, 'data'));
  const project = vscode.Uri.file(join(root, 'project'));
  await mkdir(project.fsPath, { recursive: true });
  const savedWorkspace = { ...vscode.workspace }, savedWindow = { ...vscode.window }, savedCommands = { ...vscode.commands };
  const moduleRecord = vscode as unknown as Record<string, unknown>;
  const savedEnv = moduleRecord.env, savedAlignment = moduleRecord.StatusBarAlignment;
  const originalStartAcquire = ProjectExecutionOwner.startAcquire, originalFetch = globalThis.fetch;
  const originalRead = vscode.workspace.fs.readFile, originalReadDirectory = vscode.workspace.fs.readDirectory,
    originalRename = vscode.workspace.fs.rename;
  const listeners = new Map<string, (...args: any[]) => unknown>();
  const events = new Map<string, Array<(...args: any[]) => unknown>>();
  let provider!: KeepseekChatViewProvider;
  Object.assign(vscode, { env: { sessionId: 'activation-fixture', language: 'en', remoteName: undefined }, StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.workspace, { workspaceFolders: [{ uri: project, name: 'Temporary activation project' }],
    onDidChangeConfiguration: eventHook('config'), onDidChangeWorkspaceFolders: eventHook('folders'),
    onDidGrantWorkspaceTrust: eventHook('trust'), onDidSaveTextDocument: eventHook('save'),
    onDidCreateFiles: eventHook('create'), onDidDeleteFiles: eventHook('delete'), onDidRenameFiles: eventHook('rename') });
  Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    registerWebviewViewProvider: (_id: string, value: KeepseekChatViewProvider) => { provider = value; return { dispose() {} }; } });
  Object.assign(vscode.commands, { registerCommand: (id: string, handler: (...args: any[]) => unknown) => { listeners.set(id, handler); return { dispose: () => listeners.delete(id) }; } });
  ProjectExecutionOwner.startAcquire = options => originalStartAcquire({ ...options, lockRoot: join(root, 'locks') });
  const scope = getCurrentWorkspaceSessionScope();
  const sessions: ChatSession[] = Array.from({ length: 120 }, (_, index) => ({ id: `old-${index}`, title: `Old ${index}`,
    messages: Array.from({ length: 30 }, (_, n) => ({ id: `old-${index}-${n}`, role: n % 2 ? 'assistant' : 'user', content: 'old-context'.repeat(40), createdAt: '2026-11-01T00:00:00.000Z' })),
    contextInstructions: 'old frozen context', approvalMode: 'delegate', isFavorite: false, createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z', workspaceKey: scope.key, workspaceName: scope.name, workspaceFolders: scope.folderUris }));
  const legacyDirectory = join(data.fsPath, 'chat-sessions', 'v1', 'workspaces');
  const legacyPath = join(legacyDirectory, `${getWorkspaceHash(scope.key)}.json`);
  await mkdir(legacyDirectory, { recursive: true });
  const originalLegacy = JSON.stringify({ version: 1, workspaceKey: scope.key, workspaceName: scope.name,
    workspaceFolders: scope.folderUris, activeSessionId: sessions[0].id, approvalMode: 'delegate', sessions });
  await writeFile(legacyPath, originalLegacy);
  const reads: Array<{ historical: boolean; legacy: boolean; bytes: number }> = [];
  const attempts: Array<{ historical: boolean; old: boolean; path: string }> = [];
  const ownHashes = new Set<string>();
  const allowCurrentSession = (sessionId: string) => {
    const hash = createHash('sha256').update(sessionId).digest('hex'); ownHashes.add(hash); ownHashes.add(hash.slice(0, 32));
  };
  const recordAttempt = (uri: vscode.Uri) => {
    const historical = /chat-sessions|project-assistant|usage-ledger|tool-evidence/u.test(uri.fsPath);
    attempts.push({ historical, old: historical && ![...ownHashes].some(hash => uri.fsPath.includes(hash)), path: uri.fsPath });
  };
  let migrationWrites = 0, remoteRequests = 0, mementoHistoryReads = 0;
  vscode.workspace.fs.readFile = async uri => {
    recordAttempt(uri);
    const value = await originalRead(uri);
    reads.push({ historical: /chat-sessions|project-assistant|usage-ledger|tool-evidence/u.test(uri.fsPath),
      legacy: uri.fsPath === legacyPath, bytes: value.byteLength });
    return value;
  };
  vscode.workspace.fs.readDirectory = async uri => { recordAttempt(uri); return originalReadDirectory(uri); };
  vscode.workspace.fs.rename = async (from, to, options) => {
    if (/chat-sessions.*index\.json$/u.test(to.fsPath)) migrationWrites++;
    return originalRename(from, to, options);
  };
  globalThis.fetch = async () => { remoteRequests++; throw new Error('Blank activation must stay offline'); };
  const state = new Map<string, unknown>([['keepseek.keybindingsCheckedV2', true], [SESSION_STORAGE_KEY, { version: 2, activeSessionId: sessions[0].id, sessions }]]);
  const memento = { keys: () => [...state.keys()], get: (key: string, fallback?: unknown) => {
    if (key === SESSION_STORAGE_KEY) mementoHistoryReads++;
    return state.has(key) ? state.get(key) : fallback;
  }, update: async (key: string, value: unknown) => { state.set(key, value); } };
  const context = () => ({ extensionUri: vscode.Uri.file(process.cwd()), globalStorageUri: data,
    extensionMode: 2, extension: { packageJSON: { version: 'test', displayName: 'KeepSeek', publisher: 'keepseek' } },
    workspaceState: memento, globalState: memento, subscriptions: [] as Array<{ dispose(): unknown }> });
  const samples: Array<Record<string, number>> = [];
  let view = createWebviewDomHarness();
  const posts: Array<Record<string, any>> = [];
  let lastContext = context();
  try {
    const started = performance.now();
    await activate(lastContext as never);
    const registered = performance.now();
    let disposed!: () => void;
    provider.resolveWebviewView({ webview: { cspSource: 'test', asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async (value: Record<string, any>) => { posts.push(value); view.receive(value); return true; } },
      onDidDispose: (callback: () => void) => { disposed = callback; return { dispose() {} }; } } as never);
    const host = provider as unknown as { handleMessage(message: WebviewMessage): Promise<void>; sessionStore: ChatSessionStore;
      ownerReadiness: Promise<unknown>; ensureProjectAssistant(): Promise<void>;
      cleanupExpiredSessions(): Promise<void>; projectAssistant?: { viewingTask: boolean; tasks: { list(): unknown[] }; workers: Map<string, unknown> } };
    await host.handleMessage({ type: 'ready' });
    const initialId = host.sessionStore.activeSessionId;
    assert.ok(initialId && !initialId.startsWith('old-'));
    assert.equal(host.sessionStore.messages.length, 0);
    assert.equal(host.sessionStore.getActiveSession().contextInstructions, undefined);
    assert.equal(host.sessionStore.getActiveSession().approvalMode, 'ask');
    const ready = performance.now();
    view.element('promptInput').textContent = 'Draft remains editable';
    view.element('promptInput').dispatchEvent({ type: 'input' });
    assert.equal(view.element('promptInput').getAttribute('contenteditable'), 'true');
    view.element('settingsApiKeyMenuItem').click();
    const open = view.posted.filter(value => value.type === 'openApiSettings').at(-1)!;
    assert.ok(open && !open.taskCardId);
    await host.handleMessage(open as unknown as WebviewMessage);
    assert.ok(posts.some(value => value.type === 'showSettingsDialog'));
    const accountReady = performance.now();
    await host.handleMessage({ type: 'ready' });
    assert.equal(host.sessionStore.activeSessionId, initialId, 'duplicate ready is the same activation target');
    assert.equal(view.element('promptInput').textContent, 'Draft remains editable');
    await host.cleanupExpiredSessions();
    for (const callback of events.get('config') ?? []) callback({ affectsConfiguration: () => true });
    for (const callback of events.get('trust') ?? []) callback();
    for (const callback of events.get('create') ?? []) callback({ files: [vscode.Uri.file(join(project.fsPath, 'AGENTS.md'))] });
    await new Promise(resolve => setTimeout(resolve, 120));
    await host.ownerReadiness;
    await host.ensureProjectAssistant();
    assert.equal(host.projectAssistant?.viewingTask, false);
    assert.equal(host.projectAssistant?.tasks.list().length, 0);
    assert.equal(host.projectAssistant?.workers.size, 0);
    assert.equal(reads.filter(value => value.historical).length, 0);
    assert.equal(attempts.filter(value => value.historical).length, 0, 'default boot and idle make no historical file or directory read attempts');
    assert.equal(migrationWrites, 0);
    assert.equal(mementoHistoryReads, 0);
    assert.equal(remoteRequests, 0);
    assert.equal(host.sessionStore.getSessionSummaries().length, 1);
    assert.equal(await readFile(legacyPath, 'utf8'), originalLegacy);
    samples.push({ activateToRegisteredMs: registered - started, activateToReadyMs: ready - started,
      activateToAccountsMs: accountReady - started, oldReadAttempts: 0, oldReadCount: 0, oldReadBytes: 0, migrations: 0, workers: 0, remoteRequests });
    disposed();
    await deactivate();
    for (const subscription of lastContext.subscriptions) subscription.dispose();
    lastContext = context();
    await activate(lastContext as never);
    view = createWebviewDomHarness();
    provider.resolveWebviewView({ webview: { cspSource: 'test', asWebviewUri: (uri: unknown) => uri,
      onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async (value: Record<string, any>) => { posts.push(value); view.receive(value); return true; } },
      onDidDispose: () => ({ dispose() {} }) } as never);
    const second = provider as unknown as { sessionStore: ChatSessionStore; handleMessage(message: WebviewMessage): Promise<void> };
    await second.handleMessage({ type: 'ready' });
    assert.notEqual(second.sessionStore.activeSessionId, initialId, 'new activation creates exactly one new empty target');
    assert.equal(second.sessionStore.messages.length, 0);
    assert.equal(reads.filter(value => value.historical).length, 0);
    assert.equal(remoteRequests, 0);
    // Exercise the real first submission after the zero-I/O startup evidence.
    // The transport is controlled; account, Store, Host and generated composer
    // paths remain real, including the exact user-body durability barrier.
    const sending = provider as unknown as { sourceStore: ModelSourceStore; sessionStore: ChatSessionStore;
      ownerReadiness: Promise<unknown>; ensureProjectAssistant(): Promise<void>;
      initializeAfterWebviewReady(): Promise<void>; handleMessage(message: WebviewMessage): Promise<void> };
    await sending.initializeAfterWebviewReady();
    await sending.ownerReadiness;
    await sending.ensureProjectAssistant();
    const source = await sending.sourceStore.createSource({ provider: 'openai-compatible', name: 'Controlled fixture',
      apiKey: 'fixture-credential', baseUrl: 'https://fixture.invalid/v1',
      models: [{ id: 'controlled-fixture-model', contextWindowTokens: 64000, maxOutputTokens: 1024 }] });
    await sending.handleMessage({ type: 'openApiSettings', requestId: 'controlled-account-open' });
    const currentId = sending.sessionStore.activeSessionId;
    allowCurrentSession(currentId);
    const marker = 'Exact first-send fixture bytes 中文';
    let controlledRequests = 0, dispatchAfterDurableAck = false;
    globalThis.fetch = async (_url, options) => {
      const request = JSON.parse(String(options?.body)) as { stream?: boolean; messages: Array<{ role: string; content: string }> };
      controlledRequests++;
      if (controlledRequests === 1) {
        assert.ok(posts.some(post => post.type === 'submissionResult' && post.sessionId === currentId && post.status === 'accepted'));
        const hash = createHash('sha256').update(currentId).digest('hex').slice(0, 32);
        const shard = vscode.Uri.file(join(data.fsPath, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key), 'sessions', `${hash}.json`));
        const own = await new SessionObjectStore(shard as never).load(JSON.parse(await readFile(shard.fsPath, 'utf8')));
        assert.equal(own.messages[0].content, marker);
        assert.equal(request.messages.filter(message => message.role === 'user').at(-1)?.content,
          (own.messages[0].providerContent ?? own.messages[0].expandedContent ?? own.messages[0].content).trim());
        dispatchAfterDurableAck = true;
      }
      return request.stream
        ? new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Controlled reply' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } })
        : new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"skip"}' }, finish_reason: 'stop' }] }),
          { headers: { 'content-type': 'application/json' } });
    };
    view.receive({ type: 'hideSettingsDialog' });
    view.element('promptInput').textContent = marker;
    view.element('promptInput').dispatchEvent({ type: 'input' });
    assert.equal(view.element('sendButton').disabled, false);
    view.element('composer').dispatchEvent({ type: 'submit' });
    const submission = view.posted.filter(post => post.type === 'sendPrompt').at(-1)!;
    assert.ok(submission && submission.sessionId === currentId);
    await sending.handleMessage({ ...submission, sourceId: source.id, modelId: 'controlled-fixture-model' } as WebviewMessage);
    assert.equal(dispatchAfterDurableAck, true);
    assert.equal(sending.sessionStore.messages.filter(message => message.role === 'user').length, 1);
    assert.equal(view.element('promptInput').textContent, '');
    assert.equal(await readFile(legacyPath, 'utf8'), originalLegacy);
    t.diagnostic(JSON.stringify({ firstSend: { modelAndTitleRequests: controlledRequests,
      durableBeforeAckAndDispatch: dispatchAfterDurableAck, userMessages: 1 } }));

    await sending.handleMessage({ type: 'newSession' });
    const cancelSessionId = sending.sessionStore.activeSessionId;
    allowCurrentSession(cancelSessionId);
    const cancelledPrompt = 'Cancel while the first durable receipt is pending';
    view.element('promptInput').textContent = cancelledPrompt;
    view.element('promptInput').dispatchEvent({ type: 'input' });
    const countingRename = vscode.workspace.fs.rename;
    let releaseReceipt!: () => void, reachedReceipt!: () => void;
    const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
    const receiptReached = new Promise<void>(resolve => { reachedReceipt = resolve; });
    let paused = false;
    vscode.workspace.fs.rename = async (from, to, options) => {
      if (!paused && to.fsPath.includes('/commits/')) { paused = true; reachedReceipt(); await receiptGate; }
      return countingRename(from, to, options);
    };
    const requestsBeforeCancel = controlledRequests;
    view.element('composer').dispatchEvent({ type: 'submit' });
    const cancelling = view.posted.filter(post => post.type === 'sendPrompt').at(-1)!;
    assert.equal(cancelling.sessionId, cancelSessionId);
    const cancelRun = sending.handleMessage({ ...cancelling, sourceId: source.id, modelId: 'controlled-fixture-model' } as WebviewMessage);
    try {
      await Promise.race([receiptReached, cancelRun.then(() => { throw new Error('Submission did not reach the pending durability fixture'); })]);
      await sending.handleMessage({ type: 'abortPrompt', sessionId: cancelSessionId });
    } finally { releaseReceipt(); }
    await cancelRun;
    vscode.workspace.fs.rename = countingRename;
    assert.equal(controlledRequests, requestsBeforeCancel, 'cancelled preparation dispatches no model request');
    assert.ok(!posts.some(post => post.type === 'submissionResult' && post.requestId === cancelling.requestId && post.status === 'accepted'));
    assert.equal(view.element('promptInput').textContent, cancelledPrompt, 'cancel before acceptance retains the draft');
    view.element('composer').dispatchEvent({ type: 'submit' });
    const retry = view.posted.filter(post => post.type === 'sendPrompt').at(-1)!;
    assert.notEqual(retry.requestId, cancelling.requestId);
    await sending.handleMessage({ ...retry, sourceId: source.id, modelId: 'controlled-fixture-model' } as WebviewMessage);
    assert.equal(sending.sessionStore.messages.filter(message => message.role === 'user').length, 1,
      'explicit retry reuses the durable prepared input rather than appending a duplicate');
    assert.equal(controlledRequests, requestsBeforeCancel + 1);
    assert.equal(view.element('promptInput').textContent, '');
    assert.equal(reads.filter(value => value.legacy).length, 0, 'first sends and retries keep the unrelated V1 bodies cold');
    assert.equal(attempts.filter(value => value.old).length, 0, 'new sends and retries never attempt old file or directory reads, including missing indexes');
    assert.equal(mementoHistoryReads, 0);
    assert.equal(migrationWrites, 0, 'fresh message barriers publish no old-history index or migration');
    t.diagnostic(JSON.stringify({ cancelDuringDurability: { cancelledRequests: 0, retryUserMessages: 1, retryModelRequests: 1 } }));
    await deactivate();
    // The previous activation used initialize() on this exact V1 fixture. This
    // comparison measures that storage path, not a fabricated native UI time.
    const beforeBaselineReads = reads.filter(value => value.historical).length;
    const beforeBaselineAttempts = attempts.filter(value => value.historical).length;
    const beforeBaselineBytes = reads.filter(value => value.historical).reduce((sum, value) => sum + value.bytes, 0);
    const beforeBaselineMigrations = migrationWrites;
    const baselineData = vscode.Uri.file(join(root, 'baseline-data'));
    const baselineLegacy = join(baselineData.fsPath, 'chat-sessions', 'v1', 'workspaces', `${getWorkspaceHash(scope.key)}.json`);
    await mkdir(join(baselineData.fsPath, 'chat-sessions', 'v1', 'workspaces'), { recursive: true });
    await writeFile(baselineLegacy, originalLegacy);
    const baselineStarted = performance.now();
    const baselineStorage = new GlobalSessionStorage(baselineData as never);
    const explicitLegacy = new ChatSessionStore(baselineStorage, 'en', scope);
    await explicitLegacy.initialize();
    await baselineStorage.flush();
    const baseline = { storageInitializeMs: performance.now() - baselineStarted,
      oldReadCount: reads.filter(value => value.historical).length - beforeBaselineReads,
      oldReadAttempts: attempts.filter(value => value.historical).length - beforeBaselineAttempts,
      oldReadBytes: reads.filter(value => value.historical).reduce((sum, value) => sum + value.bytes, 0) - beforeBaselineBytes,
      selectedMessages: explicitLegacy.messages.length, migrations: migrationWrites - beforeBaselineMigrations };
    assert.equal(explicitLegacy.getActiveSession().id, 'old-0');
    assert.equal(baseline.selectedMessages, 30);
    assert.ok(baseline.oldReadCount > 0 && baseline.oldReadBytes >= Buffer.byteLength(originalLegacy));
    assert.equal(await readFile(legacyPath, 'utf8'), originalLegacy);
    t.diagnostic(JSON.stringify({ environment: { node: process.version, platform: process.platform,
      ownership: 'controlled test adapter; native exclusion is tested separately' }, fixtureSessions: 120, fixtureMessages: 3600, samples,
      baseline: { kind: 'previous activation storage initialize path; not full native activation', ...baseline } }));
  } finally {
    await deactivate();
    configureProjectExecutionEnforcement(false);
    for (const subscription of lastContext.subscriptions) subscription.dispose();
    vscode.workspace.fs.readFile = originalRead; vscode.workspace.fs.readDirectory = originalReadDirectory; vscode.workspace.fs.rename = originalRename;
    ProjectExecutionOwner.startAcquire = originalStartAcquire; globalThis.fetch = originalFetch;
    Object.assign(vscode.workspace, savedWorkspace); Object.assign(vscode.window, savedWindow); Object.assign(vscode.commands, savedCommands);
    if (savedEnv === undefined) delete moduleRecord.env; else moduleRecord.env = savedEnv;
    if (savedAlignment === undefined) delete moduleRecord.StatusBarAlignment; else moduleRecord.StatusBarAlignment = savedAlignment;
    await rm(root, { recursive: true, force: true });
  }
  function eventHook(name: string) { return (callback: (...args: any[]) => unknown) => {
    const list = events.get(name) ?? []; list.push(callback); events.set(name, list);
    return { dispose: () => { const index = list.indexOf(callback); if (index >= 0) list.splice(index, 1); } };
  }; }
});
