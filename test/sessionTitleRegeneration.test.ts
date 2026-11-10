import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from './stubs/vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { InteractionCoordinator } from '../src/provider/interactionState';
import { ChatSessionStore, createEmptySession, type ChatSessionStorageAdapter,
  type StoredWorkspaceSessionState } from '../src/sessions/chatSessionStore';
import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { getConfiguredAgentSettings } from '../src/shared/config';
import type { SessionTitleRequestInput } from '../src/provider/sessionTitleRequest';
import type { SessionTitleCoordinator } from '../src/sessions/sessionTitleCoordinator';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import type { ChatMessage, ChatSession, ChatSessionSummary, KeepseekModel, ProviderUsageLedgerRecord } from '../src/shared/types';
import { OneShotTextRequestError } from '../src/agent/oneShotTextRequest';
import type { SubagentModelSetting } from '../src/agent/subagents/types';
import { createUsageLedgerRecords, createUsagePriceSnapshot } from '../src/agent/usageLedger';
import { UsageLedgerStore } from '../src/agent/usageLedgerStore';
import type { ModelSourceStore } from '../src/accounts/accountStore';
import { SESSION_TITLE_SYSTEM_PROMPT } from '../src/sessions/sessionTitle';
import { createRunCheckpoint } from '../src/agent/runCheckpoint';
import { createLogicalRunBudgetState } from '../src/agent/executionPolicy';
import { taskBudgetFromCheckpoint } from '../src/sessions/userTaskBudget';
import type { AgentRequest } from '../src/shared/types';

const scope = { key: 'workspace:title-regeneration', name: 'Title regeneration', folderUris: [] };
const generated = '{"decision":"set","title":"会话标题重建"}';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

class MemoryStorage implements ChatSessionStorageAdapter {
  public failNextSave = false;
  public sessionLoads: string[] = [];
  public beforeSessionLoad?: (id: string) => Promise<void>;
  public constructor(public state: StoredWorkspaceSessionState, private readonly historyMode: 'none' | 'sharded' | 'loaded' = 'none') {}
  async loadWorkspace() {
    const state = structuredClone(this.state);
    if (this.historyMode !== 'none') state.sessionSummaries = state.sessions.map(summary);
    if (this.historyMode === 'sharded') state.sessions = state.sessions.filter(session => session.id === state.activeSessionId);
    return state;
  }
  async saveWorkspace(_scope: unknown, state: StoredWorkspaceSessionState) {
    if (this.failNextSave) { this.failNextSave = false; throw new Error('injected title save failure'); }
    const saved = structuredClone(state);
    if (this.historyMode !== 'none') {
      const ids = new Set(saved.sessionSummaries?.map(item => item.id));
      const byId = new Map(this.state.sessions.filter(session => ids.has(session.id)).map(session => [session.id, session]));
      for (const session of saved.sessions) byId.set(session.id, session);
      saved.sessions = [...byId.values()];
    }
    this.state = saved;
  }
  async loadSession(_workspace: string, id: string) {
    this.sessionLoads.push(id);
    const session = this.state.sessions.find(item => item.id === id);
    const snapshot = session ? structuredClone(session) : undefined;
    await this.beforeSessionLoad?.(id);
    return snapshot;
  }
  async listAllWorkspaceSummaries() { return []; }
  async loadWorkspaceSessions() { return structuredClone(this.state.sessions); }
  async deleteWorkspaceSessions(_workspace: string, ids: string[]) {
    this.state.sessions = this.state.sessions.filter(session => !ids.includes(session.id));
    this.state.sessionSummaries = this.state.sessionSummaries?.filter(session => !ids.includes(session.id));
  }
  async deleteEntireWorkspace() { this.state.sessions = []; }
  async cleanupExpiredSessions() { return false; }
}

function summary(session: ChatSession): ChatSessionSummary {
  return { id: session.id, title: session.title, customTitle: session.customTitle, createdAt: session.createdAt,
    updatedAt: session.updatedAt, messageCount: session.messages.length, workspaceKey: session.workspaceKey,
    workspaceName: session.workspaceName, isFavorite: session.isFavorite };
}

interface TitleHost {
  handleMessage(message: WebviewMessage): Promise<void>;
  regenerateSessionTitle(sessionId: string, requestId: string): Promise<void>;
  manualSessionTitleRequests: Map<string, string>;
  sessionTitles: SessionTitleCoordinator;
  sessionReady: boolean;
  approvalDataReady: boolean;
  requestContextReady: boolean;
  isBusy: boolean;
  isStartingRun: boolean;
  interactions: InteractionCoordinator;
  availableModels: KeepseekModel[];
  selectedSourceId: string;
  selectedModelId: string;
  subagentModelSetting: SubagentModelSetting;
  usageLedgerStore: UsageLedgerStore;
  usageLedgerFlushes: Map<string, Promise<void>>;
  changeSets: { flush(): Promise<void> };
  draftRuns: { flush(): Promise<void> };
  views: Set<unknown>;
}

function pair(taskId: string, prompt: string): ChatMessage[] {
  const userTask = { version: 1 as const, id: taskId, originMessageId: taskId, reason: 'user' as const };
  return [
    { id: taskId, role: 'user', content: prompt, createdAt: new Date(0).toISOString(), userTask },
    { id: `${taskId}-answer`, role: 'assistant', content: `ASSISTANT_ONLY_MARKER 讨论 ${prompt} 的实现。`, createdAt: new Date(1).toISOString(), userTask }
  ];
}

async function fixture(t: TestContext, options: { legacy?: boolean; customTitle?: string; historyCount?: number; loadHistory?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-title-regeneration-'));
  const initial = createEmptySession('en', scope);
  initial.messages = [...pair('first', '最早的审批预算约束'), ...pair('middle', '中间的编辑重发缓存'), ...pair('last', '最终的标题重建需求')];
  if (options.legacy) for (const message of initial.messages) delete message.userTask;
  initial.title = options.customTitle ?? 'Previous automatic title';
  initial.customTitle = options.customTitle;
  initial.contextInstructions = 'Stable project context\n  exact whitespace';
  initial.userTaskBudgets = { preservedRoot: { version: 1, usedMs: 42, maxExecutionMs: 0, usedCostByCurrency: {} } };
  const history = Array.from({ length: options.historyCount ?? 0 }, (_, index) => {
    const session = createEmptySession('en', scope);
    session.title = `Historical topic ${index}`;
    session.messages = pair(`history-task-${index}`, `历史会话 ${index} 的独立主题`);
    session.createdAt = session.updatedAt = new Date(1_000 + index).toISOString();
    return session;
  });
  const storage = new MemoryStorage({ activeSessionId: initial.id, sessions: [initial, ...history] },
    options.historyCount ? options.loadHistory ? 'loaded' : 'sharded' : 'none');
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const session = store.getActiveSession();
  const previousWindow = { ...vscode.window };
  const previousStatusBarFactory = (vscode.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  Object.assign(vscode, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, { createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }) });
  const uri = vscode.Uri.file(root);
  const provider = new KeepseekChatViewProvider(uri as never, store, uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => {} } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' });
  const host = provider as unknown as TitleHost;
  Object.assign(host, { sessionReady: true, approvalDataReady: true, requestContextReady: true,
    runContextReadiness: 'ready', sessionRecoveryReady: true,
    commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', autoApprovalReviewer: 'ready', executionMode: 'ready', approvalMode: 'ready' },
    availableModels: [{ id: 'main-a', label: 'Main A', sourceId: 'source-a', provider: 'deepseek' },
      { id: 'main-b', label: 'Main B', sourceId: 'source-b', provider: 'deepseek' }],
    selectedSourceId: 'source-a', selectedModelId: 'main-a' });
  const posts: Array<Record<string, unknown>> = [];
  host.views.add({ webview: { postMessage(message: Record<string, unknown>) { posts.push(message); return Promise.resolve(true); } } });
  const requests = require('../src/provider/sessionTitleRequest') as { requestSessionTitle(input: SessionTitleRequestInput): Promise<string> };
  const originalRequest = requests.requestSessionTitle;
  const inputs: SessionTitleRequestInput[] = [];
  let request: (input: SessionTitleRequestInput) => Promise<string> = async () => generated;
  requests.requestSessionTitle = async input => { inputs.push(input); return request(input); };
  t.after(async () => {
    requests.requestSessionTitle = originalRequest;
    provider.dispose();
    await Promise.all([host.changeSets.flush(), host.draftRuns.flush()]);
    // A main response can finish before its display-only ledger migration.
    // Wait for the owned writes rather than racing rm against a new bucket.
    while (host.usageLedgerFlushes.size) await Promise.all([...host.usageLedgerFlushes.values()]);
    Object.assign(vscode.window, previousWindow);
    if (previousStatusBarFactory === undefined) delete (vscode.window as unknown as { createStatusBarItem?: unknown }).createStatusBarItem;
    if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
    else Object.assign(vscode, { StatusBarAlignment: previousAlignment });
    await rm(root, { recursive: true, force: true });
  });
  return { host, store, storage, session, history, posts, inputs, storageUri: uri,
    setRequest: (next: typeof request) => { request = next; } };
}

test('title refresh Host route uses only the latest two real user inputs without changing the main request', async t => {
  const { host, store, storage, session, posts, inputs } = await fixture(t, { legacy: true, customTitle: 'User chosen name' });
  const before = JSON.stringify([session.messages, session.contextInstructions, session.requestProtocol, session.executionTime,
    session.lastTurnUsage, session.userTaskBudgets?.preservedRoot]);
  const mainRequest = () => JSON.stringify(buildProviderRequestProjection({
    model: host.availableModels[0], agentSettings: getConfiguredAgentSettings(), contextFiles: [],
    contextInstructions: session.contextInstructions, history: session.messages, language: 'en', prompt: 'Continue explanation',
    requestProtocolVersion: 15, provider: 'deepseek', sourceId: 'source-a', baseUrl: 'https://fixture.invalid/v1'
  }));
  const requestBytes = mainRequest();
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'gesture-1' });
  assert.equal(inputs.length, 1);
  assert.doesNotMatch(inputs[0].userPrompt, /最早的审批预算约束/u);
  assert.equal(JSON.parse(inputs[0].userPrompt).excerpts.length, 2);
  assert.ok(JSON.parse(inputs[0].userPrompt).excerpts.every((item: { role: string }) => item.role === 'user'));
  assert.doesNotMatch(inputs[0].userPrompt, /ASSISTANT_ONLY_MARKER/u);
  assert.match(inputs[0].userPrompt, /中间的编辑重发缓存/u);
  assert.match(inputs[0].userPrompt, /最终的标题重建需求/u);
  assert.equal(session.title, '会话标题重建');
  assert.equal(session.customTitle, undefined);
  assert.equal(session.autoTitle?.status, 'completed');
  assert.equal(store.getSessionSummaries()[0].title, session.title);
  assert.equal(storage.state.sessions[0].title, session.title);
  assert.equal(JSON.stringify([session.messages, session.contextInstructions, session.requestProtocol, session.executionTime,
    session.lastTurnUsage, session.userTaskBudgets?.preservedRoot]), before);
  assert.equal(mainRequest(), requestBytes);
  assert.equal(host.isBusy, false);
  assert.equal(host.isStartingRun, false);
  assert.ok(posts.some(post => post.type === 'sessionTitleUpdated' && post.regenerated === true && post.requestId === 'gesture-1'));
  assert.deepEqual(posts.filter(post => post.type === 'sessionTitleRegeneration').map(post => post.running), [true, false]);
});

test('manual regeneration is one in-flight request and follows the captured model while A can switch to B', async t => {
  const { host, store, session, posts, inputs, setRequest, storage } = await fixture(t);
  const started = deferred();
  const response = deferred<string>();
  setRequest(async input => {
    assert.ok(storage.state.sessions.find(saved => saved.id === session.id)?.userTaskBudgets?.[input.taskId],
      'the manual auxiliary budget must commit before a physical request');
    started.resolve();
    return response.promise;
  });
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'gesture-a' });
  await started.promise;
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'gesture-duplicate' });
  assert.equal(inputs.length, 1);
  assert.equal(host.isBusy, false);
  assert.equal(host.isStartingRun, false);
  const b = await store.createNewSession('en');
  b.title = 'Different session';
  host.selectedSourceId = 'source-b'; host.selectedModelId = 'main-b';
  host.availableModels[0].id = 'mutated-old-catalog-entry';
  assert.equal(inputs[0].parentRequest.model.id, 'main-a');
  assert.equal(inputs[0].parentRequest.model.sourceId, 'source-a');
  assert.equal(inputs[0].signal.aborted, false, 'session navigation keeps a valid isolated title request');
  response.resolve(generated);
  await pending;
  assert.equal(store.activeSessionId, b.id);
  assert.equal(b.title, 'Different session');
  assert.equal(session.title, '会话标题重建');
  assert.ok(posts.some(post => post.type === 'sessionTitleUpdated' && post.sessionId === session.id && post.requestId === 'gesture-a'));
  assert.equal(host.manualSessionTitleRequests.size, 0);
});

test('same-text manual rename retires a pending regeneration result', async t => {
  const { host, store, session, posts, inputs, setRequest } = await fixture(t, { customTitle: 'Keep this name' });
  const started = deferred(), response = deferred<string>();
  setRequest(async () => { started.resolve(); return response.promise; });
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'before-rename' });
  await started.promise;
  await host.handleMessage({ type: 'renameSession', sessionId: session.id, title: 'Keep this name' });
  assert.equal(inputs[0].signal.aborted, true);
  response.resolve(generated);
  await pending;
  assert.equal(store.getSessionById(session.id)?.title, 'Keep this name');
  assert.equal(session.customTitle, 'Keep this name');
  assert.equal(posts.some(post => post.type === 'sessionTitleUpdated' && post.regenerated === true), false);
  assert.equal(host.manualSessionTitleRequests.size, 0);
});

test('a newly ready webview receives the pending regeneration identity before its first session state', async t => {
  const { host, session, posts, setRequest } = await fixture(t, { customTitle: 'Before reload' });
  const started = deferred(), response = deferred<string>();
  t.after(() => response.resolve(generated));
  setRequest(async () => { started.resolve(); return response.promise; });
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'before-reload' });
  await started.promise;
  const boundary = posts.length;
  await host.handleMessage({ type: 'ready' });
  assert.deepEqual(posts[boundary], { type: 'sessionTitleRegeneration', sessionId: session.id,
    requestId: 'before-reload', running: true, restored: true });
  assert.equal(posts[boundary + 1]?.type, 'state');
  response.resolve(generated);
  await pending;
  assert.equal(session.title, '会话标题重建');
});

test('manual regeneration records already-spent usage in A after switching without changing B or the root budget', async t => {
  const { host, store, session, inputs, setRequest } = await fixture(t);
  const started = deferred(), response = deferred<string>();
  const recorded: Array<{ sessionId: string; record: ProviderUsageLedgerRecord }> = [];
  Object.assign(host, { applyUsageLedgerRecord: async (target: { id: string }, record: ProviderUsageLedgerRecord) => {
    recorded.push({ sessionId: target.id, record });
  } });
  setRequest(async () => { started.resolve(); return response.promise; });
  const originalRoot = structuredClone(session.userTaskBudgets!.preservedRoot);
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'usage-a' });
  await started.promise;
  const input = inputs[0];
  const b = await store.createNewSession('en');
  const record = { purpose: 'session_title', requestId: `session_title_${input.token}` } as ProviderUsageLedgerRecord;
  await input.onUsageLedgerRecord(record);
  const settled = structuredClone(input.taskBudget);
  settled.usedMs += 7;
  await input.onBudgetChanged?.(settled);
  response.resolve('{"decision":"defer","title":null}');
  await pending;
  assert.deepEqual(recorded.map(item => item.sessionId), [session.id]);
  assert.equal(session.userTaskBudgets?.[input.taskId]?.usedMs, settled.usedMs);
  assert.equal(b.userTaskBudgets?.[input.taskId], undefined);
  assert.deepEqual(session.userTaskBudgets?.preservedRoot, originalRoot);
  assert.equal(store.activeSessionId, b.id);
});

test('a stale title response retains its charged usage durably after a newer manual naming intent', async t => {
  const { host, store, session: active, history, posts, inputs, setRequest, storageUri } = await fixture(t, { historyCount: 1 });
  const target = history[0];
  const started = deferred(), release = deferred();
  const record: ProviderUsageLedgerRecord = { ...createUsageLedgerRecords({ requestId: 'stale-title-charge', source: 'subagent',
    usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120, cacheHitTokens: 0, cacheMissTokens: 100, cacheDataStatus: 'reported' },
    attempts: [createUsagePriceSnapshot({ originalModelId: 'fixture-title-model', sourceId: 'source-a', provider: 'deepseek', protocol: 'chat-completions',
      requestStartedAt: new Date(0).toISOString(), supportsBilling: true, rates: { inputPrice: 1, cacheHitPrice: 0.1, outputPrice: 2, currency: 'USD' } })] })[0],
    purpose: 'session_title' };
  setRequest(async input => {
    started.resolve(); await release.promise;
    await input.onUsageLedgerRecord(record);
    return generated;
  });
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: target.id, requestId: 'rename-after-dispatch' });
  await started.promise;
  try {
    await host.handleMessage({ type: 'renameSession', sessionId: target.id, title: 'My newer title' });
    assert.equal(inputs[0].signal.aborted, true);
    assert.equal(store.getSessionById(target.id)?.title, 'My newer title');
  } finally { release.resolve(); }
  await pending;
  await Promise.all(host.usageLedgerFlushes.values());
  const durable = await new UsageLedgerStore(storageUri as never).current(target.id);
  assert.equal(durable.ledger.records.length, 1);
  assert.equal(durable.ledger.records[0].requestId, 'stale-title-charge');
  assert.equal(durable.ledger.records[0].usage?.totalTokens, 120);
  assert.ok(durable.ledger.records[0].cost > 0);
  assert.equal(durable.ledger.records[0].purpose, 'session_title');
  assert.equal(store.activeSessionId, active.id);
  assert.equal(store.getSessionById(target.id)?.title, 'My newer title');
  assert.equal(posts.some(post => post.type === 'sessionTitleUpdated' && post.sessionId === target.id), false);
});

test('a cancelled title retains its late physical usage after the host changes workspace scope', async t => {
  const { host, store, session, posts, inputs, setRequest, storageUri } = await fixture(t);
  const started = deferred(), release = deferred();
  t.after(() => release.resolve());
  const record: ProviderUsageLedgerRecord = { ...createUsageLedgerRecords({ requestId: 'cross-workspace-title-charge', source: 'subagent',
    usage: { promptTokens: 75, completionTokens: 15, totalTokens: 90, cacheHitTokens: 0, cacheMissTokens: 75, cacheDataStatus: 'reported' },
    attempts: [createUsagePriceSnapshot({ originalModelId: 'fixture-title-model', sourceId: 'source-a', provider: 'deepseek', protocol: 'chat-completions',
      requestStartedAt: new Date(0).toISOString(), supportsBilling: true, rates: { inputPrice: 1, cacheHitPrice: 0.1, outputPrice: 2, currency: 'USD' } })] })[0],
    purpose: 'session_title' };
  setRequest(async input => {
    started.resolve();
    await release.promise;
    await input.onUsageLedgerRecord(record);
    return generated;
  });
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'scope-before-settlement' });
  await started.promise;
  const scopeHost = host as TitleHost & { cancelAllSessionTitleWork(): void };
  scopeHost.cancelAllSessionTitleWork();
  assert.equal(inputs[0].signal.aborted, true);
  await store.setWorkspaceScope({ key: 'workspace:other-title-scope', name: 'Other scope', folderUris: [] });
  const next = store.getActiveSession();
  const nextTitle = next.title;
  assert.equal(store.getSessionById(session.id), undefined, 'settlement cannot depend on an old target being resident in the current scope');
  release.resolve();
  await pending;
  const durable = await new UsageLedgerStore(storageUri as never).current(session.id);
  assert.equal(inputs.length, 1);
  assert.equal(durable.ledger.records.length, 1);
  assert.equal(durable.ledger.records[0].requestId, 'cross-workspace-title-charge');
  assert.equal(durable.ledger.records[0].usage?.totalTokens, 90);
  assert.ok(durable.ledger.records[0].cost > 0);
  assert.equal(store.activeSessionId, next.id);
  assert.equal(next.title, nextTitle);
  assert.equal(posts.some(post => post.type === 'sessionTitleUpdated' && post.sessionId === session.id), false);
  assert.equal(host.manualSessionTitleRequests.size, 0);
});

test('read-only runtime title diagnostics neither hydrate history nor dispatch naming requests', async t => {
  const { host, session, storage, inputs } = await fixture(t, { historyCount: 2 });
  const snapshot = JSON.stringify([session.messages, session.title, session.autoTitle]);
  const diagnosticsHost = host as TitleHost & { getSessionTitleDiagnostics(): { candidates: number; inFlight: number } };
  for (let index = 0; index < 3; index++) {
    const diagnostics = diagnosticsHost.getSessionTitleDiagnostics();
    assert.equal(diagnostics.candidates, 0);
    assert.equal(diagnostics.inFlight, 0);
  }
  assert.equal(inputs.length, 0);
  assert.deepEqual(storage.sessionLoads, []);
  assert.equal(JSON.stringify([session.messages, session.title, session.autoTitle]), snapshot);
});

test('a configured fixed title model remains usable when the main picker selection is missing', async t => {
  const { host, session, inputs, posts } = await fixture(t);
  host.selectedSourceId = 'missing-main-source';
  host.selectedModelId = 'missing-main-model';
  host.subagentModelSetting = { version: 1, mode: 'fixed', sourceId: 'source-b', modelId: 'main-b', updatedAt: new Date(0).toISOString() };
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'fixed-without-main' });
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].parentRequest.model.id, 'main-b');
  assert.equal(inputs[0].parentRequest.model.sourceId, 'source-b');
  assert.equal(inputs[0].setting?.mode, 'fixed');
  assert.equal(inputs[0].setting?.modelId, 'main-b');
  assert.equal(session.title, '会话标题重建');
  assert.ok(posts.some(post => post.type === 'sessionTitleRegeneration' && post.requestId === 'fixed-without-main'
    && post.running === false && post.outcome === 'updated'));
});

test('busy, unready, unknown and untrusted manual requests are rejected and release only their own UI gesture', async t => {
  const { host, session, posts, inputs } = await fixture(t);
  host.isBusy = true;
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'isBusy' });
  host.isBusy = false;
  const preparation = host.interactions.begin('task', session.id, 'preparing_task')!;
  try {
    assert.equal(host.isStartingRun, true);
    await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'isStartingRun' });
  } finally { host.interactions.finish(preparation); }
  for (const property of ['sessionReady', 'approvalDataReady'] as const) {
    host[property] = false;
    await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: property });
    host[property] = true;
  }
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: 'unknown-session', requestId: 'unknown' });
  const previousTrusted = vscode.workspace.isTrusted;
  try {
    vscode.workspace.isTrusted = false;
    await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'untrusted' });
  } finally { vscode.workspace.isTrusted = previousTrusted; }
  assert.equal(inputs.length, 0);
  assert.equal(host.manualSessionTitleRequests.size, 0);
  const statuses = posts.filter(post => post.type === 'sessionTitleRegeneration');
  assert.deepEqual(statuses.filter(post => post.running === false).map(post => post.requestId),
    ['isBusy', 'isStartingRun', 'sessionReady', 'approvalDataReady', 'unknown', 'untrusted']);
  assert.deepEqual(statuses.filter(post => post.running === true).map(post => post.requestId), ['unknown']);
  assert.ok(statuses.filter(post => post.running === false).every(post => typeof post.outcome === 'string' && typeof post.reason === 'string'));
});

test('a safe history refresh does not wait for the current project Skills or occupy its navigation owner', async t => {
  const { host, store, session, history, posts, inputs } = await fixture(t, { historyCount: 1 });
  host.requestContextReady = false;
  const operation = host.interactions.begin('navigation', session.id, 'preparing_context')!;
  try {
    await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: history[0].id, requestId: 'independent-context' });
    assert.equal(inputs.length, 1);
    assert.equal(host.requestContextReady, false);
    assert.equal(host.interactions.current, operation);
    assert.equal(host.isBusy, false);
    assert.equal(store.activeSessionId, session.id);
    assert.ok(posts.some(post => post.type === 'sessionTitleRegeneration' && post.requestId === 'independent-context'
      && post.running === false && post.outcome === 'updated'));
  } finally { host.interactions.finish(operation); }
});

test('explicit no-material and unchanged title results close their own request without replacing the conversation', async t => {
  const { host, session, posts, inputs, setRequest } = await fixture(t);
  const empty = await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: 'unknown', requestId: 'missing-target' });
  assert.equal(empty, undefined);
  setRequest(async () => '{"decision":"defer","title":null}');
  const old = session.title;
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'no-topic' });
  assert.equal(session.title, old);
  setRequest(async () => JSON.stringify({ decision: 'set', title: '同一标题' }));
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'new-title' });
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'same-title' });
  assert.equal(session.title, '同一标题');
  const outcomes = posts.filter(post => post.type === 'sessionTitleRegeneration' && post.running === false);
  assert.deepEqual(outcomes.map(post => [post.requestId, post.outcome]),
    [['missing-target', 'stale'], ['no-topic', 'no_material'], ['new-title', 'updated'], ['same-title', 'unchanged']]);
  assert.equal(inputs.length, 3);
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'same-title' });
  assert.equal(inputs.length, 3, 'a repeated request identity replays its terminal without charging again');
});

test('a failed manual claim never dispatches and a later gesture can retry with bounded auxiliary budget metadata', async t => {
  const { host, storage, session, posts, inputs } = await fixture(t, { customTitle: 'Original custom name' });
  storage.failNextSave = true;
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'failed-save' });
  assert.equal(inputs.length, 0);
  assert.equal(session.title, 'Original custom name');
  assert.equal(host.manualSessionTitleRequests.size, 0);
  assert.ok(posts.some(post => post.type === 'sessionTitleRegeneration' && post.requestId === 'failed-save' && post.running === false));
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'retry-1' });
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'retry-2' });
  assert.equal(inputs.length, 2, 'explicit subsequent gestures still call the provider after a completed title');
  assert.notEqual(inputs[0].taskId, inputs[1].taskId);
  assert.equal(Object.keys(session.userTaskBudgets ?? {}).filter(id => id.startsWith('session_title_manual_')).length, 1);
  assert.ok(session.userTaskBudgets?.preservedRoot);
});

test('a failed auxiliary-budget save after a successful claim is save_failed and dispatches no model', async t => {
  const { host, storage, session, posts, inputs } = await fixture(t);
  const save = storage.saveWorkspace.bind(storage);
  let writes = 0;
  storage.saveWorkspace = async (...args: Parameters<typeof save>) => {
    if (++writes === 2) throw new Error('private budget persistence failure');
    await save(...args);
  };
  const old = session.title;
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'budget-save-failure' });
  assert.equal(inputs.length, 0);
  assert.equal(session.title, old);
  assert.ok(posts.some(post => post.type === 'sessionTitleRegeneration' && post.requestId === 'budget-save-failure'
    && post.running === false && post.outcome === 'save_failed'));
  assert.equal(host.manualSessionTitleRequests.size, 0);
});

for (const reason of ['unavailable', 'timeout', 'invalid', 'cancelled'] as const) {
  test(`Host manual ${reason} reports a matching safe terminal and allows a later explicit retry`, async t => {
    const { host, session, posts, inputs, setRequest } = await fixture(t);
    const old = session.title;
    setRequest(async () => { throw new OneShotTextRequestError(reason, 'private raw Provider body or credentials'); });
    await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: `manual-${reason}` });
    const result = posts.find(post => post.type === 'sessionTitleRegeneration' && post.requestId === `manual-${reason}` && post.running === false);
    assert.equal(result?.sessionId, session.id);
    assert.equal(result?.outcome, reason);
    assert.equal(typeof result?.reason, 'string');
    assert.doesNotMatch(JSON.stringify(result), /private raw/u);
    assert.equal(session.title, old);
    assert.equal(host.manualSessionTitleRequests.size, 0);
    setRequest(async () => generated);
    await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: `retry-${reason}` });
    assert.equal(inputs.length, 2);
    assert.equal(session.title, '会话标题重建');
  });
}

test('an unloaded history row refresh updates only its session while the active conversation and request bytes remain intact', async t => {
  const { host, store, storage, session: active, history, posts, inputs } = await fixture(t, { historyCount: 1 });
  const target = history[0];
  assert.equal(store.getSessionById(target.id), undefined, 'sharded startup must not preload inactive history');
  const before = JSON.stringify([active.messages, active.title, active.contextInstructions, active.executionTime, active.lastTurnUsage]);
  const requestBytes = () => JSON.stringify(buildProviderRequestProjection({
    model: host.availableModels[0], agentSettings: getConfiguredAgentSettings(), contextFiles: [],
    contextInstructions: active.contextInstructions, history: active.messages, language: 'en', prompt: 'Continue explanation',
    requestProtocolVersion: 15, provider: 'deepseek', sourceId: 'source-a', baseUrl: 'https://fixture.invalid/v1'
  }));
  const requestBefore = requestBytes();
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: target.id, requestId: 'history-row' });
  assert.deepEqual(storage.sessionLoads, [target.id]);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].sessionId, target.id);
  assert.match(inputs[0].userPrompt, /历史会话 0 的独立主题/u);
  assert.doesNotMatch(inputs[0].userPrompt, /最早的审批预算约束/u);
  assert.equal(store.activeSessionId, active.id);
  assert.equal(store.getSessionById(target.id)?.title, '会话标题重建');
  assert.equal(store.getSessionSummaries().find(item => item.id === target.id)?.title, '会话标题重建');
  assert.equal(storage.state.sessions.find(item => item.id === target.id)?.title, '会话标题重建');
  assert.equal(JSON.stringify([active.messages, active.title, active.contextInstructions, active.executionTime, active.lastTurnUsage]), before);
  assert.equal(requestBytes(), requestBefore);
  assert.equal(posts.some(post => post.type === 'sessionChanged'), false);
  assert.ok(posts.some(post => post.type === 'sessionTitleUpdated' && post.sessionId === target.id && post.requestId === 'history-row'));
});

test('history loading claims the row synchronously and retains the click model snapshot through duplicate refreshes', async t => {
  const { host, store, storage, session: active, history, inputs } = await fixture(t, { historyCount: 1 });
  const target = history[0];
  const started = deferred(), release = deferred();
  storage.beforeSessionLoad = async id => {
    assert.equal(id, target.id);
    started.resolve();
    await release.promise;
  };
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: target.id, requestId: 'loading-first' });
  const capturedSetting = structuredClone(host.subagentModelSetting);
  await started.promise;
  try {
    await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: target.id, requestId: 'loading-duplicate' });
    assert.deepEqual(storage.sessionLoads, [target.id]);
    assert.equal(inputs.length, 0);
    assert.equal(host.manualSessionTitleRequests.get(target.id), 'loading-first');
    assert.equal(host.isBusy, false);
    assert.equal(host.isStartingRun, false);
    host.selectedSourceId = 'source-b'; host.selectedModelId = 'main-b';
    host.availableModels[0].id = 'mutated-after-click';
    host.subagentModelSetting.mode = 'fixed';
    host.subagentModelSetting.sourceId = 'later-source';
    host.subagentModelSetting.modelId = 'later-model';
  } finally { release.resolve(); }
  await pending;
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].parentRequest.model.id, 'main-a');
  assert.equal(inputs[0].parentRequest.model.sourceId, 'source-a');
  assert.deepEqual(inputs[0].setting, capturedSetting);
  assert.equal(store.activeSessionId, active.id);
  assert.equal(host.manualSessionTitleRequests.size, 0);
});

test('a new runtime conflict during history loading closes the accepted request with its actual reason', async t => {
  const { host, storage, history, inputs, posts } = await fixture(t, { historyCount: 1 });
  const target = history[0];
  const started = deferred(), release = deferred();
  t.after(() => release.resolve());
  storage.beforeSessionLoad = async () => { started.resolve(); await release.promise; };
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: target.id, requestId: 'became-busy' });
  await started.promise;
  host.isBusy = true;
  release.resolve();
  try { await pending; } finally { host.isBusy = false; }
  const result = posts.find(post => post.type === 'sessionTitleRegeneration'
    && post.requestId === 'became-busy' && post.running === false);
  assert.equal(result?.outcome, 'busy');
  assert.equal(typeof result?.reason, 'string');
  assert.doesNotMatch(String(result?.reason), /model|模型|titleRefresh/u);
  assert.equal(inputs.length, 0);
  assert.equal(host.manualSessionTitleRequests.size, 0);
});

test('deleting a history row during its load prevents provider dispatch and cannot resurrect its summary or stored body', async t => {
  const { host, store, storage, session: active, history, inputs, posts } = await fixture(t, { historyCount: 1 });
  const target = history[0];
  const started = deferred(), release = deferred();
  storage.beforeSessionLoad = async () => { started.resolve(); await release.promise; };
  Object.assign(vscode.window, { showWarningMessage: async (_message: string, _options: unknown, action: string) => action });
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: target.id, requestId: 'deleted-row' });
  await started.promise;
  try {
    await host.handleMessage({ type: 'deleteSessions', sessionIds: [target.id] });
    assert.equal(host.manualSessionTitleRequests.has(target.id), false, 'deletion also retires the pre-model loading slot');
  } finally { release.resolve(); }
  await pending;
  assert.equal(inputs.length, 0);
  assert.equal(store.getSessionById(target.id), undefined);
  assert.equal(store.getSessionSummaries().some(item => item.id === target.id), false);
  assert.equal(storage.state.sessions.some(item => item.id === target.id), false);
  assert.equal(store.activeSessionId, active.id);
  assert.equal(posts.some(post => post.type === 'sessionTitleUpdated' && post.sessionId === target.id), false);
});

test('manual rename during a history load retires the old request and concurrent loading returns the renamed live object', async t => {
  const { host, store, storage, session: active, history, inputs } = await fixture(t, { historyCount: 1 });
  const target = history[0];
  const started = deferred(), release = deferred();
  let loads = 0;
  storage.beforeSessionLoad = async () => { if (++loads === 1) { started.resolve(); await release.promise; } };
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: target.id, requestId: 'before-history-rename' });
  await started.promise;
  let renamed: ChatSession | undefined;
  try {
    await host.handleMessage({ type: 'renameSession', sessionId: target.id, title: 'Chosen historical name' });
    renamed = store.getSessionById(target.id);
    assert.equal(host.manualSessionTitleRequests.has(target.id), false);
    assert.equal(renamed?.customTitle, 'Chosen historical name');
  } finally { release.resolve(); }
  await pending;
  assert.equal(inputs.length, 0);
  assert.equal(store.getSessionById(target.id), renamed, 'late stale history load must reuse the already-renamed object');
  assert.equal(store.getSessionById(target.id)?.title, 'Chosen historical name');
  assert.equal(storage.state.sessions.find(item => item.id === target.id)?.customTitle, 'Chosen historical name');
  assert.equal(store.activeSessionId, active.id);
});

test('a new user intent without a persisted question preserves the accepted history refresh', async t => {
  const { host, store, storage, history, inputs } = await fixture(t, { historyCount: 1 });
  const target = history[0];
  const started = deferred(), release = deferred();
  let loads = 0;
  storage.beforeSessionLoad = async () => { if (++loads === 1) { started.resolve(); await release.promise; } };
  const pending = host.handleMessage({ type: 'regenerateSessionTitle', sessionId: target.id, requestId: 'before-new-intent' });
  await started.promise;
  try {
    await store.selectSession(target.id);
    // Stop after the production send wrapper observes the actual new-user
    // intent, before any main Provider/context work is authorized by the test.
    Object.assign(host, { awaitRunContextRefresh: async () => false });
    await host.handleMessage({ type: 'sendPrompt', prompt: 'A new question', sourceId: 'source-a', modelId: 'main-a' });
    assert.equal(host.manualSessionTitleRequests.has(target.id), true);
  } finally { release.resolve(); }
  await pending;
  assert.equal(inputs.length, 1);
  assert.equal(store.getSessionById(target.id)?.title, '会话标题重建');
});

test('an older history refresh stays resident through commit even with fifty newer loaded conversations', async t => {
  const { host, store, storage, session: active, history, inputs, posts } = await fixture(t, { historyCount: 55, loadHistory: true });
  const target = history[0];
  assert.equal(store.getSessionById(target.id), undefined, 'normal compaction evicts this oldest loaded body');
  assert.equal(store.getSessionSummaries().length, 56, 'the history index still retains every conversation');
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: target.id, requestId: 'oldest-history' });
  assert.equal(inputs.length, 1, 'claim persistence must not evict the just-loaded naming target');
  assert.equal(store.getSessionSummaries().find(item => item.id === target.id)?.title, '会话标题重建');
  assert.equal(storage.state.sessions.find(item => item.id === target.id)?.title, '会话标题重建');
  assert.ok(posts.some(post => post.type === 'sessionTitleUpdated' && post.sessionId === target.id));
  assert.equal(store.activeSessionId, active.id);
});


test('manual title refresh can name a latest accepted user intent that has no assistant answer', async t => {
  const { host, session, inputs } = await fixture(t, { customTitle: 'Previous chosen name' });
  const latest = pair('latest-unanswered', '最新用户目标是压缩任务侧栏占用空间')[0];
  latest.expandedContent = 'EXPANDED_ATTACHMENT_SECRET';
  latest.providerContent = 'PROVIDER_TAIL_SECRET';
  session.messages.push(latest);
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'latest-user-only' });
  assert.equal(inputs.length, 1);
  const data = JSON.parse(inputs[0].userPrompt) as { excerpts: Array<{ role: string; text: string }> };
  assert.equal(data.excerpts.length, 2);
  assert.ok(data.excerpts.every(excerpt => excerpt.role === 'user'));
  assert.match(inputs[0].userPrompt, /最新用户目标是压缩任务侧栏占用空间/u);
  assert.doesNotMatch(inputs[0].userPrompt, /ASSISTANT_ONLY_MARKER|EXPANDED_ATTACHMENT_SECRET|PROVIDER_TAIL_SECRET|最早的审批预算约束/u);
  assert.equal(session.title, '会话标题重建');
  assert.equal(session.autoTitle?.stopped, 'named');
});

test('manual title materials ignore failed or cancelled assistant output while preserving its latest user intent', async t => {
  const { host, session, inputs } = await fixture(t);
  const lastAnswer = session.messages.at(-1)!;
  lastAnswer.content = 'RAW_ASSISTANT_FAILURE_SECRET';
  lastAnswer.incompleteForTitle = true;
  lastAnswer.runDetails = { status: 'failed' } as ChatMessage['runDetails'];
  await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'user-purpose-after-failure' });
  assert.equal(inputs.length, 1);
  assert.match(inputs[0].userPrompt, /最终的标题重建需求/u);
  assert.doesNotMatch(inputs[0].userPrompt, /RAW_ASSISTANT_FAILURE_SECRET|ASSISTANT_ONLY_MARKER/u);
  assert.equal(session.title, '会话标题重建');
});


function streamingReply(text: string): Response {
  return new Response('data: ' + JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: 'stop' }] })
    + '\n\ndata: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })
    + '\n\ndata: [DONE]\n\n');
}

async function prepareRealSubmissionRoute(host: TitleHost): Promise<void> {
  const sourceStore = (host as unknown as { sourceStore: ModelSourceStore }).sourceStore;
  await sourceStore.createSource({ id: 'source-a', provider: 'deepseek', name: 'Captured source', apiKey: 'fake-key',
    baseUrl: 'https://input-title-test.invalid/v1', models: [{ id: 'main-a', contextWindowTokens: 32768, maxOutputTokens: 8192 }] });
  Object.assign(host, {
    refreshModelSourceState: async () => {}, awaitRunContextRefresh: async () => true,
    modelSelectionTransactions: { beginRun() {}, getSnapshot: () => ({}) },
    refreshCurrentRunContext: async () => ({ context: { projectInstructions: [], skills: [], metadata: {
      precedence: [], beforeDeduplicationCount: 0, afterDeduplicationCount: 0, totalCharacterCount: 0,
      totalTokenEstimate: 0, truncated: false, sources: [], discarded: [], possibleConflicts: []
    } }, failures: [] }),
    refreshContextCompressionBeforeRun: async () => {}, scheduleContextCompressionRefresh: () => {},
    updateActiveSessionContextUsage: () => {}, createCurrentSessionContextUsage: () => undefined,
    applyPromptCacheDiagnostics: () => [], createRunCacheSummary: () => undefined,
    applyPendingModelSelectionAfterRun: async () => {}, refreshBalance: async () => {},
    postState: () => {}, setAgentActivity: () => {}, scheduleDraftRunAutoContinuation: () => {}
  });
}

test('the real accepted-input route commits a purpose title before its main assistant answer exists', { timeout: 15000 }, async t => {
  const { host, session, storage } = await fixture(t);
  await prepareRealSubmissionRoute(host);
  const mainStarted = deferred(), titleCommitted = deferred(), mainReply = deferred<Response>();
  const titleInputs: string[] = [];
  let mainPosts = 0, settled = false;
  const originalFetch = globalThis.fetch;
  host.views.add({ webview: { postMessage(message: Record<string, unknown>) {
    if (message.type === 'sessionTitleUpdated' && message.sessionId === session.id) titleCommitted.resolve();
    return Promise.resolve(true);
  } } });
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
    if (body.messages[0]?.content === SESSION_TITLE_SYSTEM_PROMPT) {
      titleInputs.push(body.messages.at(-1)!.content);
      assert.ok(storage.state.sessions.find(saved => saved.id === session.id)?.messages.some(message =>
        message.role === 'user' && message.content === 'USER_PURPOSE_MARKER 精简任务侧栏占用空间'), 'the user text is durable before naming');
      return streamingReply('{"decision":"set","title":"任务侧栏精简"}');
    }
    mainPosts++;
    mainStarted.resolve();
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      void mainReply.promise.then(resolve, reject);
    });
  }) as typeof fetch;
  let sent: Promise<void> | undefined;
  try {
    sent = host.handleMessage({ type: 'sendPrompt', prompt: 'USER_PURPOSE_MARKER 精简任务侧栏占用空间',
      sourceId: 'source-a', modelId: 'main-a' }).then(() => { settled = true; });
    await mainStarted.promise;
    await titleCommitted.promise;
    assert.equal(settled, false, 'title completion cannot await the main answer');
    assert.equal(mainPosts, 1);
    assert.equal(titleInputs.length, 1);
    const material = JSON.parse(titleInputs[0]) as { excerpts: Array<{ role: string; text: string }> };
    assert.equal(material.excerpts.length, 1);
    assert.equal(material.excerpts[0].role, 'user');
    assert.match(titleInputs[0], /USER_PURPOSE_MARKER/u);
    assert.doesNotMatch(titleInputs[0], /ASSISTANT_ONLY_MARKER|最早的审批预算约束|最终的标题重建需求/u);
    assert.equal(session.title, '任务侧栏精简');
    assert.equal(session.autoTitle?.stopped, 'named');
    assert.equal(session.messages.at(-1)?.role, 'assistant');
    assert.equal(session.messages.at(-1)?.content, '');
    assert.equal(session.messages.at(-1)?.isStreaming, true);
    mainReply.resolve(streamingReply('LONG_ASSISTANT_REPLY_MARKER '.repeat(500)));
    await sent;
    assert.equal(titleInputs.length, 1, 'the final response never creates another title request');
  } finally {
    mainReply.resolve(streamingReply('Complete main answer'));
    await sent?.catch(() => {});
    globalThis.fetch = originalFetch;
  }
});

test('a failed real initial user persistence dispatches neither main nor title requests', async t => {
  const { host, session, storage } = await fixture(t);
  await prepareRealSubmissionRoute(host);
  const save = storage.saveWorkspace.bind(storage);
  storage.saveWorkspace = async (...args: Parameters<typeof save>) => {
    if (args[1].sessions.some(saved => saved.messages.some(message => message.content === 'UNSAVED_PURPOSE_MARKER'))) {
      throw new Error('injected initial user persistence failure');
    }
    await save(...args);
  };
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async () => { posts++; return streamingReply('Unexpected response'); }) as typeof fetch;
  try {
    await host.handleMessage({ type: 'sendPrompt', prompt: 'UNSAVED_PURPOSE_MARKER', sourceId: 'source-a', modelId: 'main-a' });
    assert.equal(posts, 0);
    assert.ok(session.messages.some(message => message.content === 'UNSAVED_PURPOSE_MARKER'));
    assert.equal(session.autoTitle?.stopped, undefined);
  } finally { globalThis.fetch = originalFetch; }
});


test('cancelling the main answer does not cancel an already accepted user-purpose title', { timeout: 15000 }, async t => {
  const { host, session } = await fixture(t);
  await prepareRealSubmissionRoute(host);
  const mainStarted = deferred(), titleStarted = deferred(), titleCommitted = deferred();
  const titleReply = deferred<Response>();
  const originalFetch = globalThis.fetch;
  let titleSignal: AbortSignal | undefined;
  host.views.add({ webview: { postMessage(message: Record<string, unknown>) {
    if (message.type === 'sessionTitleUpdated' && message.sessionId === session.id) titleCommitted.resolve();
    return Promise.resolve(true);
  } } });
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    if (body.messages[0]?.content === SESSION_TITLE_SYSTEM_PROMPT) {
      titleSignal = init?.signal ?? undefined;
      titleStarted.resolve();
      return titleReply.promise;
    }
    mainStarted.resolve();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    });
  }) as typeof fetch;
  let sent: Promise<void> | undefined;
  try {
    sent = host.handleMessage({ type: 'sendPrompt', prompt: '优化账号管理入口响应速度', sourceId: 'source-a', modelId: 'main-a' });
    await Promise.all([mainStarted.promise, titleStarted.promise]);
    await host.handleMessage({ type: 'abortPrompt', sessionId: session.id });
    await sent;
    assert.equal(titleSignal?.aborted, false, 'title has a separate cancellation owner from the main answer');
    titleReply.resolve(streamingReply('{"decision":"set","title":"账号入口提速"}'));
    await titleCommitted.promise;
    assert.equal(session.title, '账号入口提速');
    assert.equal(session.autoTitle?.stopped, 'named');
  } finally {
    titleReply.resolve(streamingReply('{"decision":"defer","title":null}'));
    await sent?.catch(() => {});
    globalThis.fetch = originalFetch;
  }
});


test('an accepted purpose title commits before a slow pre-run compression refresh finishes', { timeout: 15000 }, async t => {
  const { host, session } = await fixture(t);
  await prepareRealSubmissionRoute(host);
  const compressionEntered = deferred(), releaseCompression = deferred(), titleCommitted = deferred();
  Object.assign(host, { refreshContextCompressionBeforeRun: async () => {
    compressionEntered.resolve();
    await releaseCompression.promise;
  } });
  host.views.add({ webview: { postMessage(message: Record<string, unknown>) {
    if (message.type === 'sessionTitleUpdated' && message.sessionId === session.id) titleCommitted.resolve();
    return Promise.resolve(true);
  } } });
  const originalFetch = globalThis.fetch;
  t.after(() => { releaseCompression.resolve(); globalThis.fetch = originalFetch; });
  let mainPosts = 0, titlePosts = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    if (body.messages[0]?.content === SESSION_TITLE_SYSTEM_PROMPT) {
      titlePosts++;
      assert.match(body.messages.at(-1)!.content, /压缩任务侧栏占用/u);
      return streamingReply('{"decision":"set","title":"任务侧栏精简"}');
    }
    mainPosts++;
    return streamingReply('Complete main response after the compression refresh');
  }) as typeof fetch;
  let sent: Promise<void> | undefined;
  try {
    sent = host.handleMessage({ type: 'sendPrompt', prompt: '压缩任务侧栏占用空间', sourceId: 'source-a', modelId: 'main-a' });
    await compressionEntered.promise;
    await titleCommitted.promise;
    assert.equal(titlePosts, 1);
    assert.equal(mainPosts, 0, 'the main request is still waiting only for its own context refresh');
    assert.equal(session.messages.at(-1)?.role, 'user', 'title does not need even an assistant placeholder');
    assert.equal(session.title, '任务侧栏精简');
    releaseCompression.resolve();
    await sent;
    assert.equal(mainPosts, 1);
    assert.equal(titlePosts, 1);
    const latestInput = [...session.messages].reverse().find(message => message.role === 'user')!;
    assert.equal(session.userTaskBudgets?.[latestInput.userTask!.id]?.runBudget?.modelRequests, 2,
      'the prepared authority must be reused by the main run after the title already spent its slot');
  } finally {
    releaseCompression.resolve();
    await sent?.catch(() => {});
    globalThis.fetch = originalFetch;
  }
});

test('a real no-progress user supplement has its own title opportunity while retaining the original spent root allowance', { timeout: 15000 }, async t => {
  const { host, session, store, inputs } = await fixture(t);
  await prepareRealSubmissionRoute(host);
  const previousUser = session.messages.at(-2)!;
  const previousAssistant = session.messages.at(-1)!;
  const rootTaskId = previousUser.userTask!.id;
  const source = { sourceId: 'source-a', provider: 'deepseek' as const, apiKey: 'fake-key',
    baseUrl: 'https://input-title-test.invalid/v1', supportsBilling: false };
  const oldRequest: AgentRequest = {
    prompt: previousUser.content, history: session.messages.slice(0, -1), model: { ...host.availableModels[0] },
    settings: getConfiguredAgentSettings(), contextFiles: [], contextInstructions: session.contextInstructions,
    language: 'en', sessionId: session.id, requestProtocolVersion: session.requestProtocol?.version,
    executionMode: 'normal', approvalMode: 'ask', approvalRootTaskId: rootTaskId,
    sourceConfig: source, authorizedExternalReferenceUris: []
  };
  const cp = createRunCheckpoint(oldRequest, 0, 'stored no-progress root allowance',
    (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString()));
  cp.status = 'interrupted'; cp.stopReason = 'no_progress_loop'; cp.usedMs = 250; cp.modelRequests = 2;
  cp.runBudget = createLogicalRunBudgetState({ modelRequests: 2, upstreamTokens: 200, treeUpstreamTokens: 200, usedMs: 250 });
  cp.budgetLimits = { maxModelRequests: 4, maxToolRounds: 0, maxToolCalls: 0, maxContinuations: 0,
    maxContextEpochRollovers: 0, maxUpstreamTokens: 100000, maxTreeUpstreamTokens: 100000,
    maxContinuationOutputTokens: 0, maxContinuationOutputChars: 0 };
  cp.state = { messages: [{ role: 'user', content: previousUser.content }], toolRounds: [], draftEdits: [], draftRuns: [],
    reasoningParts: [], turn: 0, toolCallCount: 0, validationRunCount: 0, toolResultTokens: 0,
    repairLoop: { status: 'idle', iteration: 0, maxIterations: 2, pendingDraftEditIds: [] } };
  previousAssistant.runCheckpoint = cp;
  previousAssistant.incompleteForTitle = true;
  session.userTaskBudgets![rootTaskId] = taskBudgetFromCheckpoint(cp);
  session.autoTitle = { version: 2, status: 'pending', revision: 1, lastAttemptTaskId: rootTaskId,
    attemptedTaskIds: [rootTaskId], attemptedThrough: { taskId: rootTaskId, originMessageId: previousUser.id }, lastOutcome: 'defer' };
  await store.persist();
  const titleCommitted = deferred();
  host.views.add({ webview: { postMessage(message: Record<string, unknown>) {
    if (message.type === 'sessionTitleUpdated' && message.sessionId === session.id) titleCommitted.resolve();
    return Promise.resolve(true);
  } } });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let mainPosts = 0, titlePosts = 0;
  const titleMaterials: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    if (body.messages[0]?.content === SESSION_TITLE_SYSTEM_PROMPT) {
      titlePosts++; titleMaterials.push(body.messages.at(-1)!.content);
      return streamingReply('{"decision":"set","title":"账号入口提速"}');
    }
    mainPosts++;
    assert.match(String(init?.body), /NEW_RECOVERY_PURPOSE_MARKER/u);
    return streamingReply('Use the new evidence to improve the account entry response');
  }) as typeof fetch;
  try {
    await host.handleMessage({ type: 'sendPrompt', prompt: 'NEW_RECOVERY_PURPOSE_MARKER 优化账号管理入口响应速度',
      sourceId: 'source-a', modelId: 'main-a' });
    assert.equal(mainPosts, 1, 'the accepted recovery must reach its main request without waiting on its own title lease');
    await titleCommitted.promise;
    const latestInput = [...session.messages].reverse().find(message => message.role === 'user')!;
    assert.equal(latestInput.userTask?.id, rootTaskId);
    assert.equal(latestInput.userTask?.reason, 'recovery');
    assert.notEqual(latestInput.id, previousUser.id);
    assert.equal(mainPosts, 1);
    assert.equal(titlePosts, 1);
    assert.match(titleMaterials[0], /NEW_RECOVERY_PURPOSE_MARKER/u);
    assert.doesNotMatch(titleMaterials[0], /ASSISTANT_ONLY_MARKER|最早的审批预算约束/u);
    assert.equal(session.title, '账号入口提速');
    assert.equal(session.autoTitle?.lastAttemptTaskId, latestInput.id, 'naming dedupe uses the new input identity');
    assert.equal(session.userTaskBudgets![rootTaskId].runBudget?.modelRequests, 4, 'main and title retain the two previous spent requests');
    assert.equal(Object.hasOwn(session.userTaskBudgets!, latestInput.id), false, 'a new naming input does not manufacture a fresh root allowance');
    assert.equal(session.userTaskBudgets!.preservedRoot.usedMs, 42);
    await host.handleMessage({ type: 'regenerateSessionTitle', sessionId: session.id, requestId: 'latest-recovery-purpose' });
    assert.equal(inputs.length, 1);
    assert.match(inputs[0].userPrompt, /NEW_RECOVERY_PURPOSE_MARKER/u);
    assert.equal(JSON.parse(inputs[0].userPrompt).excerpts.length, 2);
    assert.doesNotMatch(inputs[0].userPrompt, /ASSISTANT_ONLY_MARKER|最早的审批预算约束/u);
    assert.equal(session.userTaskBudgets![rootTaskId].runBudget?.modelRequests, 4);
  } finally { globalThis.fetch = originalFetch; }
});


test('an unexpected automatic-title enrollment failure cannot abort the real main request or lose its accepted user input', async t => {
  const { host, session } = await fixture(t);
  await prepareRealSubmissionRoute(host);
  const oldTitle = session.title;
  const titleHost = host as unknown as { rememberSessionTitleSubmission: (...args: unknown[]) => void };
  const originalRemember = titleHost.rememberSessionTitleSubmission;
  titleHost.rememberSessionTitleSubmission = () => { throw new Error('injected auxiliary enrollment failure'); };
  const originalFetch = globalThis.fetch;
  let mainPosts = 0, titlePosts = 0;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    if (body.messages[0]?.content === SESSION_TITLE_SYSTEM_PROMPT) {
      titlePosts++;
      return streamingReply('{"decision":"set","title":"Unexpected title"}');
    }
    mainPosts++;
    return streamingReply('The main request still completes after the auxiliary service failed.');
  }) as typeof fetch;
  try {
    await host.handleMessage({ type: 'sendPrompt', prompt: 'PRESERVED_MAIN_PURPOSE_MARKER 优化账号设置入口',
      sourceId: 'source-a', modelId: 'main-a' });
    assert.equal(mainPosts, 1);
    assert.equal(titlePosts, 0);
    assert.ok(session.messages.some(message => message.role === 'user' && message.content === 'PRESERVED_MAIN_PURPOSE_MARKER 优化账号设置入口'));
    assert.match(session.messages.at(-1)!.content, /main request still completes/u);
    assert.equal(session.messages.at(-1)!.isStreaming, undefined);
    assert.equal(session.title, oldTitle);
    assert.equal(session.autoTitle?.stopped, undefined);
    assert.equal(host.isBusy, false);
    assert.equal(host.isStartingRun, false);
  } finally {
    titleHost.rememberSessionTitleSubmission = originalRemember;
    globalThis.fetch = originalFetch;
  }
});
