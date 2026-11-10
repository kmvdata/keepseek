import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as vscode from './stubs/vscode';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore, type ChatSessionStorageAdapter, type StoredWorkspaceSessionState } from '../src/sessions/chatSessionStore';
import { SessionHistoryCleanupService, type HistoryCleanupCatalogEntry, type HistoryCleanupPreview, type HistoryCleanupState, type HistoryCleanupTarget } from '../src/sessions/sessionHistoryCleanup';
import type { ChatSession } from '../src/shared/types';
import type { WebviewMessage } from '../src/provider/webviewMessages';

interface CleanupHost {
  handleMessage(message: WebviewMessage, webviewId?: string): Promise<void>;
  removeHistoryCleanupLocalState(target: HistoryCleanupTarget): Promise<void>;
  publishHistoryCleanupState(operation: HistoryCleanupState): void;
  sessionRecoveryReady: boolean;
  runContextReadiness: string;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(t: TestContext, extraSessions = 0) {
  const scope = { key: 'workspace:cleanup-host', name: 'Cleanup Host', folderUris: [] };
  const now = Date.parse('2026-11-10T07:00:00Z');
  const sessions: ChatSession[] = ['current', 'other', ...Array.from({ length: extraSessions }, (_, index) => 'extra-' + index)].map((id, index) => ({
    id, title: id, workspaceKey: scope.key, workspaceName: scope.name, workspaceFolders: [],
    createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-02T00:00:00.000Z',
    isFavorite: index === 0,
    messages: [{ id: 'message-' + id, role: 'user', content: ' exact\n persisted request bytes ', createdAt: '2026-10-01T00:00:00.000Z' }]
  }));
  const deleted = new Set<string>();
  let saves = 0;
  const storage: ChatSessionStorageAdapter = {
    loadWorkspace: async () => ({ activeSessionId: 'current', sessions: structuredClone(sessions) }),
    saveWorkspace: async (_scope, _state: StoredWorkspaceSessionState) => { saves++; },
    listAllWorkspaceSummaries: async () => [],
    loadWorkspaceSessions: async () => { throw new Error('must not hydrate'); },
    loadSession: async () => { throw new Error('must not hydrate'); },
    deleteWorkspaceSessions: async () => { throw new Error('must not use old delete'); },
    deleteEntireWorkspace: async () => { throw new Error('must not use old delete'); },
    cleanupExpiredSessions: async () => false,
    isSessionDeleted: async (_workspaceKey, id) => deleted.has(id)
  };
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const entries: HistoryCleanupCatalogEntry[] = sessions.map(session => ({
    workspaceKey: scope.key, id: session.id, updatedAt: session.updatedAt, createdAt: session.createdAt,
    isFavorite: !!session.isFavorite, hasHistory: true, version: 'summary-' + session.id
  }));
  const posts: Array<Record<string, unknown>> = [];
  let journalWrites = 0;
  let deleteCalls = 0;
  let statePosts = 0;
  const service = new SessionHistoryCleanupService({
    readCatalog: async () => ({ entries: structuredClone(entries), unknown: 0 }),
    revalidateTarget: async target => entries.some(entry => entry.id === target.id && entry.version === target.version),
    deleteTarget: async target => { deleteCalls++; deleted.add(target.id); return { status: 'removedPendingCleanup' }; },
    finishTarget: async target => { await host.removeHistoryCleanupLocalState(target); return { status: 'fullyDeleted' }; }
  }, { now: () => now, currentSessionId: () => store.activeSessionId,
    journal: { load: async () => undefined, save: async () => { journalWrites++; } } });
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    historyCleanup: service, sessionStore: store, sessionInitialization: Promise.resolve(), sessionReady: true,
    approvalDataReady: true, titleLifecycleDisposed: false, language: 'en', isBusy: false,
    requestContextReady: false, sessionRecoveryReady: false, runContextReadiness: 'loading',
    availableModels: [], activeChangeActions: new Set(),
    postToWebview: (post: Record<string, unknown>) => posts.push(post), postState: () => { statePosts++; }, postOtherWorkspaces: async () => {},
    cancelSessionTitleWork: () => {}, clearSessionTransientState: () => {},
    updateRequestContextReadiness: () => {}, sharedProjectSources: { dirty: false },
    taskPlansBySession: new Map(), repairLoopsBySession: new Map(), currentRunContextsBySession: new Map(),
    slimToolNamesBySession: new Map(), referenceCostViews: new Map(), referenceCostIndexes: new Map(),
    contextUsageCache: { clear: () => {} }, sessionTraceLogUris: new Map(), visibleMessageLimits: new Map(),
    usageDisplayReadiness: new Map(), restoredCacheObservations: new Map(), subagentRecoveryIncomplete: new Set(),
    refreshModelSourceState: () => { throw new Error('must not discover models'); },
    refreshSessionSkills: () => { throw new Error('must not load context'); }
  }) as CleanupHost;
  const previousWarning = vscode.window.showWarningMessage;
  t.after(() => { vscode.window.showWarningMessage = previousWarning; });
  const preview = async () => {
    await host.handleMessage({ type: 'previewHistoryCleanup', requestId: 'preview', scope: 'current', mode: 'olderThan', days: 3 }, 'view');
    const result = [...posts].reverse().find(post => post.type === 'historyCleanupPreview');
    assert.ok(result && !result.error);
    return result as unknown as HistoryCleanupPreview;
  };
  return { host, service, store, entries, posts, deleted, preview,
    statePosts: () => statePosts,
    metrics: () => ({ saves, journalWrites, deleteCalls }) };
}

test('history settings open immediately and cancelling the one native confirmation performs no mutation', async t => {
  const f = await fixture(t);
  await f.host.handleMessage({ type: 'openHistorySettings' }, 'view');
  assert.equal(f.posts[0].type, 'showHistorySettingsDialog');
  const preview = await f.preview();
  assert.equal(preview.candidateCount, 2);
  assert.equal(preview.favoriteCount, 1);
  let confirmations = 0;
  Object.assign(vscode.window, { showWarningMessage: async (message: string, options: { modal?: boolean }) => {
    confirmations++;
    assert.equal(options.modal, true);
    assert.match(message, /current project/);
    assert.match(message, /last updated before/);
    assert.match(message, /1 favorites/);
    assert.match(message, /rollback history/);
    return undefined;
  } });
  await f.host.handleMessage({ type: 'requestHistoryCleanup', requestId: 'cancelled', previewToken: preview.previewToken }, 'view');
  assert.equal(confirmations, 1);
  assert.deepEqual(f.metrics(), { saves: 0, journalWrites: 0, deleteCalls: 0 });
  assert.equal(f.deleted.size, 0);
  assert.equal(f.service.getCurrentOperation()?.status, 'cancelled');
});

test('duplicate cleanup requests share one native modal and deleting the viewed session publishes a lazy blank replacement', async t => {
  const f = await fixture(t);
  const preview = await f.preview();
  const entered = deferred(), release = deferred();
  let confirmations = 0;
  Object.assign(vscode.window, { showWarningMessage: async (_message: string, _options: unknown, action: string) => {
    confirmations++; entered.resolve(); await release.promise; return action;
  } });
  const message = { type: 'requestHistoryCleanup' as const, requestId: 'confirmed', previewToken: preview.previewToken };
  const first = f.host.handleMessage(message, 'view');
  await entered.promise;
  const duplicate = f.host.handleMessage(message, 'view');
  release.resolve();
  await Promise.all([first, duplicate]);
  assert.equal(confirmations, 1);
  assert.equal(f.metrics().deleteCalls, 2);
  assert.equal(f.metrics().saves, 1, 'only replacement selection requires a survivor save');
  assert.equal(f.service.getCurrentOperation()?.fullyDeleted, 2);
  assert.equal(f.store.messages.length, 0);
  assert.equal(f.host.sessionRecoveryReady, true);
  assert.equal(f.host.runContextReadiness, 'ready');
  const replacement = f.posts.find(post => post.type === 'historyCleanupSessionReplacement');
  assert.equal(replacement?.previousSessionId, 'current');
  assert.equal(replacement?.sessionId, f.store.activeSessionId);
  assert.ok(f.posts.some(post => post.type === 'historyCleanupDeleted'));
});

test('Host rejects invalid options and another Webview token without confirming or mutating', async t => {
  const f = await fixture(t);
  let confirmations = 0;
  Object.assign(vscode.window, { showWarningMessage: async () => { confirmations++; return undefined; } });
  await f.host.handleMessage({ type: 'previewHistoryCleanup', requestId: 'invalid', scope: 'all', mode: 'olderThan', days: 8 }, 'view');
  assert.equal(f.posts.at(-1)?.error, 'Invalid cleanup options.');
  const preview = await f.preview();
  await f.host.handleMessage({ type: 'requestHistoryCleanup', requestId: 'wrong-window', previewToken: preview.previewToken }, 'another-view');
  assert.match(String(f.posts.at(-1)?.error), /Preview again/);
  assert.equal(confirmations, 0);
  assert.deepEqual(f.metrics(), { saves: 0, journalWrites: 0, deleteCalls: 0 });
});

test('a target changed while confirming leaves every planned session intact and requires a new preview', async t => {
  const f = await fixture(t);
  const preview = await f.preview();
  Object.assign(vscode.window, { showWarningMessage: async (_message: string, _options: unknown, action: string) => {
    f.entries[1].version = 'changed-during-confirmation'; return action;
  } });
  await f.host.handleMessage({ type: 'requestHistoryCleanup', requestId: 'changed', previewToken: preview.previewToken }, 'view');
  assert.equal(f.metrics().deleteCalls, 0);
  assert.equal(f.deleted.size, 0);
  assert.equal(f.service.getCurrentOperation()?.error, 'history_changed');
});

test('a 120-session non-current cleanup batches list invalidation without repeatedly publishing the survivor transcript', async t => {
  const f = await fixture(t, 119);
  const targets = f.entries.filter(entry => entry.id !== 'current');
  assert.equal(targets.length, 120);
  const current = f.store.getActiveSession();
  for (const target of targets) {
    f.deleted.add(target.id);
    await f.host.removeHistoryCleanupLocalState(target);
  }
  assert.equal(f.store.getActiveSession(), current);
  assert.equal(f.metrics().saves, 0);
  assert.equal(f.statePosts(), 0, 'unrelated cleanup must not republish the active transcript per target');
  assert.equal(f.posts.filter(post => post.type === 'historyCleanupDeleted').length, 0);
  f.host.publishHistoryCleanupState({ requestId: 'batch', operationId: 'batch-operation', status: 'completed',
    options: { scope: 'current', mode: 'all' }, now: Date.now(), total: 120, processed: 120,
    fullyDeleted: 120, protected: 0, skippedChanged: 0, unknown: 0, failedBeforeCommit: 0,
    removedPendingCleanup: 0, inaccessibleLegacy: 0, favoriteCount: 0, includesCurrentSession: false });
  const invalidations = f.posts.filter(post => post.type === 'historyCleanupDeleted');
  assert.equal(invalidations.length, 1);
  assert.deepEqual(new Set(invalidations[0].sessionIds as string[]), new Set(targets.map(target => target.id)));
  assert.equal(f.posts.at(-1)?.type, 'historyCleanupState');
  assert.equal(f.statePosts(), 0);
});
