import './registerVscodeStub';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { test } from 'node:test';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { KeepseekModel } from '../src/shared/types';

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import * as vscode from './stubs/vscode';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { ProjectResourceCoordinator } from '../src/tasks/projectResources';
import { ProjectRequestAdmission } from '../src/tasks/requestAdmission';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { ModelSourceService } from '../src/accounts/modelSourceService';
import { createWebviewDomHarness } from './webviewDomHarness';
import { WEBVIEW_MESSAGE_SCOPES, webviewMessageScope, type WebviewMessage } from '../src/provider/webviewMessages';


test('provider model-source refresh prevents stale catalog commits', async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const reading = new Promise<void>(resolve => { started = resolve; });
  let reads = 0, stalePublications = 0, currentPublications = 0;
  const model = (id: string): KeepseekModel => ({ id, label: id, sourceId: `source-${id}`, provider: 'deepseek' });
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    modelSourceStateRefreshGeneration: 0, availableModels: [], modelSources: [],
    selectedModelId: 'b', selectedSourceId: 'source-b',
    balanceStore: { selectSource: () => {} },
    getBalanceSourceScope: (sourceId: string) => ({ provider: 'deepseek', sourceId }),
    persistModelSelection: async () => {},
    defaultModelStore: { refresh: async () => {
      const id = ++reads === 1 ? 'a' : 'b';
      if (id === 'a') { started(); await gate; }
      return { modelSources: [], availableModels: [model(id)], defaultModel: model(id) };
    } }
  }) as { refreshModelSourceState(options: { preserveAuthoritativeSelection: boolean; onResolved(): void }): Promise<void>;
    availableModels: KeepseekModel[]; selectedSourceId: string; selectedModelId: string };
  const stale = host.refreshModelSourceState({ preserveAuthoritativeSelection: true, onResolved: () => { stalePublications++; } });
  await reading;
  const current = host.refreshModelSourceState({ preserveAuthoritativeSelection: true, onResolved: () => { currentPublications++; } });
  release();
  await Promise.all([stale, current]);
  assert.equal(reads, 2);
  assert.equal(stalePublications, 0, 'the superseded catalog cannot publish');
  assert.equal(currentPublications, 1);
  assert.deepEqual(host.availableModels.map(item => item.id), ['b']);
  assert.equal(host.selectedSourceId, 'source-b');
  assert.equal(host.selectedModelId, 'b');
});

test('request credentials are resolved from the exact selected model source', async () => {
  const source = await readProviderSource();
  assert.match(
    source,
    /findModelBySelection\(models, \{ sourceId, modelId \}\)[\s\S]*?resolveModelSourceConfig\(model\.sourceId/u
  );
  assert.match(
    source,
    /const sourceConfig: ModelSourceConfigSnapshot = Object\.freeze\(\{[\s\S]*?sourceId: resolvedSource\.sourceId[\s\S]*?supportsBilling: resolvedSource\.supportsBilling/u
  );
  assert.doesNotMatch(source, /activeAccountId|resolveActiveAccountConfig|selectAccount/u);
});

test('source deletion scrubs cached credentials and cascades the balance record', async () => {
  const source = await readProviderSource();
  assert.match(
    source,
    /await this\.balanceStore\.deleteSource\(\{ provider: source\.provider, sourceId: source\.id \}\);[\s\S]*?await this\.sourceStore\.deleteSource\(source\.id\);[\s\S]*?this\.scrubDeletedModelSourceFromMemory\(source\.id\)/u
  );
  assert.match(
    source,
    /private scrubDeletedModelSourceFromMemory\(sourceId: string\): void \{[\s\S]*?this\.modelSourceStateRefreshGeneration \+= 1;[\s\S]*?this\.modelSources = this\.modelSources\.filter/u
  );
});

async function readProviderSource(): Promise<string> {
  return await readFile(path.resolve(process.cwd(), 'src/provider/KeepseekChatViewProvider.ts'), 'utf8');
}

// Complete generated scripts use the same message scope table as the real Host.
// These tests keep actual account/storage/Host code and only substitute VS Code
// APIs, upstream transport, and the explicitly controlled kernel-lock adapter.

async function accountFixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-account-readiness-'));
  const uri = vscode.Uri.file(root);
  const previousWindow = { ...vscode.window };
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  Object.assign(vscode, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) });
  const live = await ProjectExecutionOwner.acquire({ projectUri: root, lockRoot: join(root, 'locks') });
  const observer = await ProjectExecutionOwner.acquire({ projectUri: root, lockRoot: join(root, 'locks') });
  assert.equal(live.isOwner, true);
  assert.equal(observer.isOwner, false);
  const storage = new GlobalSessionStorage(uri as never);
  const store = new ChatSessionStore(storage, 'en', { key: 'account-fixture', name: 'Account fixture', folderUris: [uri.toString()] });
  store.initializeFreshBoot();
  store.setReadOnly(true); storage.setReadOnly(true);
  const provider = new KeepseekChatViewProvider(uri as never, store, uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: '', author: '', repositoryUrl: '', license: 'MIT' },
    new Promise<void>(() => {}), undefined,
    { owner: observer, resources: new ProjectResourceCoordinator(observer.projectId), admission: new ProjectRequestAdmission() });
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: store.activeSessionId, language: 'en',
    interaction: { sessionId: store.activeSessionId, revision: 1, canEdit: true, canManageAccounts: true,
      canReadAccounts: true, canSubmit: false, canNavigate: true, canChangeContext: false, phase: 'loading_session' } } });
  const posts: Array<Record<string, any>> = [];
  const host = provider as unknown as { handleMessage(message: WebviewMessage): Promise<void>;
    sourceStore: ModelSourceStore; views: Set<unknown> };
  host.views.add({ webview: { postMessage(message: Record<string, any>) { posts.push(message); view.receive(message); return Promise.resolve(true); } } });
  t.after(async () => {
    await provider.shutdown(); await live.dispose(); await storage.flush();
    Object.assign(vscode.window, previousWindow);
    if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
    else Object.assign(vscode, { StatusBarAlignment: previousAlignment });
    await rm(root, { recursive: true, force: true });
  });
  return { root, view, posts, host, store };
}

test('observer account entry opens before local account I/O; saving first account works with hung session safety and no model', async t => {
  const f = await accountFixture(t);
  const previousFetch = globalThis.fetch;
  let remoteRequests = 0;
  globalThis.fetch = (async () => { remoteRequests++; throw new Error('No implicit network request'); }) as typeof fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const list = f.host.sourceStore.listSources.bind(f.host.sourceStore);
  f.host.sourceStore.listSources = async () => { await hold; return list(); };
  f.view.element('settingsApiKeyMenuItem').click();
  const open = f.view.posted.find(message => message.type === 'openApiSettings')!;
  const opening = f.host.handleMessage({ ...open, taskCardId: 'old-task', projectId: 'old-project' } as WebviewMessage);
  await Promise.resolve();
  assert.equal(f.view.element('settingsDialogOverlay').classList.contains('hidden'), false);
  assert.equal(f.view.element('settingsCreateAccountBtn').disabled, false);
  release(); await opening;
  f.host.sourceStore.listSources = list;
  f.view.element('settingsCreateAccountBtn').click();
  f.view.element('newAccountName').value = 'First account';
  f.view.element('newAccountProvider').value = 'openai-compatible';
  f.view.element('newAccountBaseUrl').value = 'https://unreachable.example/v1';
  f.view.element('newAccountApiKey').value = 'editable-invalid-key';
  f.view.element('newAccountSaveBtn').click();
  const create = f.view.posted.find(message => message.type === 'addModel')!;
  assert.ok(create.requestId);
  assert.equal(create.taskCardId, undefined);
  await f.host.handleMessage({ ...create, taskCardId: 'obsolete-task-target' } as WebviewMessage);
  assert.equal((await list()).length, 1);
  await f.host.handleMessage(create as WebviewMessage);
  assert.equal((await list()).length, 1, 'completed request replay cannot create another account');
  const replayedResults = f.posts.filter(message => message.type === 'addModelResult' && message.requestId === create.requestId);
  assert.equal(replayedResults.length, 2);
  assert.deepEqual(replayedResults[1], replayedResults[0], 'a repeated completed request replays its original terminal outcome');
  await f.host.handleMessage({ ...create, name: 'Different payload' } as WebviewMessage);
  assert.equal((await list()).length, 1, 'request IDs cannot be reused for a different mutation');
  assert.match(f.posts.filter(message => message.type === 'accountOperationResult' && message.requestId === create.requestId).at(-1)!.error, /different operation|其他操作/u);
  assert.equal(f.store.getActiveSession().messages.length, 0);
  assert.equal(remoteRequests, 0, 'open/add/save never probes, discovers, bills or loads history');
  assert.ok(f.posts.some(message => message.type === 'accountOperationResult' && message.requestId === create.requestId && message.ok));
  assert.equal(f.view.element('newAccountDialogOverlay').classList.contains('hidden'), true);
});

test('account messages remain global in task view, and closing ignores late results while preserving the form', () => {
  const view = createWebviewDomHarness();
  view.receive({ type: 'state', revision: 1, state: { activeSessionId: 'old-session', language: 'en',
    interaction: { sessionId: 'old-session', revision: 1, canManageAccounts: true, canSubmit: false, canChangeContext: false } } });
  view.receive({ type: 'projectTasksState', projectId: 'P', revision: 1, viewGeneration: 1,
    viewMode: 'task', viewTaskId: 'T', readOnly: true, cards: [{ id: 'T', sessionId: 'old-session', rootTaskId: 'R', status: 'running', title: 'Task' }] });
  view.element('settingsApiKeyMenuItem').click();
  const open = view.posted.find(message => message.type === 'openApiSettings')!;
  assert.equal(open.taskCardId, undefined);
  assert.equal(open.projectId, undefined);
  view.receive({ type: 'showSettingsDialog', requestId: open.requestId, accountDialogGeneration: open.accountDialogGeneration, sources: [] });
  assert.equal(view.element('settingsCreateAccountBtn').disabled, false);
  view.element('settingsAccountName').value = 'Kept draft';
  view.element('settingsApiKey').value = 'kept-key';
  view.element('settingsBaseUrl').value = 'https://offline.example/v1';
  view.element('settingsAccountName').dispatchEvent({ type: 'input' });
  view.element('settingsSaveBtn').click();
  const save = view.posted.find(message => message.type === 'addModel')!;
  assert.equal(save.taskCardId, undefined);
  view.element('settingsCancelBtn').click();
  assert.equal(view.element('settingsDialogOverlay').classList.contains('hidden'), true);
  view.receive({ type: 'showSettingsDialog', requestId: save.requestId, accountDialogGeneration: save.accountDialogGeneration,
    sources: [], settingsSaved: true });
  assert.equal(view.element('settingsDialogOverlay').classList.contains('hidden'), true, 'late success cannot reopen a closed dialog');
  view.element('settingsApiKeyMenuItem').click();
  const reopen = view.posted.filter(message => message.type === 'openApiSettings').at(-1)!;
  view.receive({ type: 'showSettingsDialog', requestId: reopen.requestId, accountDialogGeneration: reopen.accountDialogGeneration, sources: [] });
  assert.equal(view.element('settingsAccountName').value, 'Kept draft');
  assert.equal(view.element('settingsApiKey').value, 'kept-key');
  assert.ok(view.posted.some(message => message.type === 'cancelAccountOperation' && message.requestId === save.requestId));
  assert.equal(view.posted.some(message => message.type === 'sendPrompt' || message.type === 'projectTaskSubmit'), false);
});

test('account transaction merges concurrent model edits and rejects a stale credentials form', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-account-conflicts-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uri = vscode.Uri.file(root) as never;
  const firstStore = new ModelSourceStore(uri);
  const secondStore = new ModelSourceStore(uri);
  const first = new ModelSourceService(firstStore), second = new ModelSourceService(secondStore);
  const created = await first.addModel({ provider: 'openai-compatible', name: 'Shared', apiKey: '', baseUrl: 'http://localhost:1234/v1' });
  await Promise.all(['a', 'b'].map((modelId, index) => (index ? second : first).addModel({ sourceId: created.source.id,
    provider: 'openai-compatible', apiKey: '', baseUrl: created.source.baseUrl, modelId })));
  assert.deepEqual((await firstStore.getSource(created.source.id))?.models.map(model => model.id).sort(), ['a', 'b']);
  const stale = await secondStore.getSource(created.source.id);
  assert.ok(stale);
  await first.saveSource({ sourceId: stale.id, name: 'Latest', apiKey: '', baseUrl: stale.baseUrl, expectedUpdatedAt: stale.updatedAt });
  await assert.rejects(second.saveSource({ sourceId: stale.id, name: 'Stale', apiKey: '', baseUrl: stale.baseUrl,
    expectedUpdatedAt: stale.updatedAt }), /changed in another window/u);
  assert.equal((await firstStore.getSource(stale.id))?.name, 'Latest');
});

test('every declared account message has explicit user scope; unknown messages cannot acquire task identity', () => {
  for (const type of ['openApiSettings', 'addModel', 'saveModelSource', 'deleteModelSource', 'refreshSourceModels', 'testSourceConnection']) {
    assert.equal(webviewMessageScope(type), 'user');
  }
  assert.equal(Object.keys(WEBVIEW_MESSAGE_SCOPES).length > 100, true);
  assert.equal(webviewMessageScope('__unknown_future_message__'), undefined);
});

test('explicit connection test cancels by request identity, releases pending controls and keeps the form for retry', async t => {
  const f = await accountFixture(t);
  const previousFetch = globalThis.fetch;
  let started!: () => void;
  const requestStarted = new Promise<void>(resolve => { started = resolve; });
  let requests = 0;
  globalThis.fetch = (async (_url, init) => {
    requests++; started();
    return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  f.view.element('settingsApiKeyMenuItem').click();
  await f.host.handleMessage(f.view.posted.find(message => message.type === 'openApiSettings') as WebviewMessage);
  f.view.element('settingsCreateAccountBtn').click();
  f.view.element('newAccountName').value = 'Unsaved form';
  f.view.element('newAccountBaseUrl').value = 'https://offline.example/v1';
  f.view.element('newAccountApiKey').value = 'test-key';
  f.view.element('newAccountTestBtn').click();
  f.view.element('newAccountTestBtn').click();
  const testMessage = f.view.posted.find(message => message.type === 'testSourceConnection')!;
  const pending = f.host.handleMessage(testMessage as WebviewMessage);
  await requestStarted;
  assert.equal(requests, 1);
  f.view.element('newAccountCancelBtn').click();
  const cancel = f.view.posted.find(message => message.type === 'cancelAccountOperation' && message.requestId === testMessage.requestId)!;
  assert.ok(cancel);
  await f.host.handleMessage(cancel as WebviewMessage); await pending;
  assert.equal(f.view.element('newAccountDialogOverlay').classList.contains('hidden'), true);
  assert.ok(f.posts.some(message => message.type === 'accountOperationResult' && message.requestId === testMessage.requestId && !message.ok));
  f.view.element('settingsCreateAccountBtn').click();
  assert.equal(f.view.element('newAccountName').value, 'Unsaved form');
  assert.equal(f.view.element('newAccountApiKey').value, 'test-key');
  assert.equal(f.view.element('newAccountTestBtn').disabled, false);
  f.view.receive({ type: 'sourceConnectionTestResult', requestId: testMessage.requestId, ok: true });
  assert.equal(f.view.element('newAccountDialogStatus').textContent, '', 'late cancelled success cannot alter the reopened form');
  assert.equal((await f.host.sourceStore.listSources()).length, 0);
});
