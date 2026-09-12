import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { ChatSessionStore, type WorkspaceSessionScope } from '../src/sessions/chatSessionStore';
import {
  GlobalSessionStorage,
  SESSION_CLEANUP_MIN_INTERVAL_MS,
  getWorkspaceHash
} from '../src/sessions/globalSessionStorage';
import type { ChatMessage, ChatSession } from '../src/shared/types';
import { ContextUsageEstimateCache, createContextUsageCacheKey } from '../src/agent/contextUsageCache';
import { getScript } from '../src/webview/script';
import { getHtmlForWebview } from '../src/webview/html';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';

test('cold storage starts with one usable empty session without creating a monolith', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cold-start-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const scope = workspaceScope('cold');
  const store = new ChatSessionStore(new GlobalSessionStorage(vscode.Uri.file(root) as never), 'en', scope);
  await store.initialize();
  assert.equal(store.messages.length, 0);
  assert.equal(store.getSessionSummaries().length, 1);
  await assert.rejects(stat(path.join(root, 'chat-sessions', 'v1', 'workspaces', `${getWorkspaceHash(scope.key)}.json`)));
});

test('large V1 projects migrate atomically and load only summaries plus the active session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-large-session-start-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const scope = workspaceScope('large');
  const sessions = Array.from({ length: 120 }, (_, index) => session(`s-${index}`, scope, 30, index));
  const legacyPath = await writeLegacyWorkspace(root, scope, sessions, sessions[0].id);
  const legacyBytes = (await stat(legacyPath)).size;

  const store = new ChatSessionStore(new GlobalSessionStorage(vscode.Uri.file(root) as never), 'en', scope);
  await store.initialize();
  assert.equal(store.getSessionSummaries().length, 120);
  assert.equal(store.getActiveSession().id, 's-0');
  assert.equal(store.messages.length, 30);
  const indexPath = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key), 'index.json');
  assert.ok((await stat(indexPath)).size < legacyBytes / 5);
  await assert.rejects(stat(legacyPath));

  const selected = await store.selectSession('s-119');
  assert.ok(selected?.messages[0]?.content.startsWith('message 119-0'));
  assert.equal(store.getSessionSummaries().length, 120);
});

test('failed V1 migration keeps the old file as a readable fallback', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-session-fallback-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const scope = workspaceScope('fallback');
  const sessions = [session('active', scope, 3, 0), session('older', scope, 2, 1)];
  const legacyPath = await writeLegacyWorkspace(root, scope, sessions, 'active');
  const originalRename = vscode.workspace.fs.rename;
  vscode.workspace.fs.rename = async (source, target, options) => {
    if (target.fsPath.endsWith('/index.json') && target.fsPath.includes('/chat-sessions/v2/')) {
      throw new Error('simulated atomic index failure');
    }
    await originalRename(source, target, options);
  };
  t.after(() => { vscode.workspace.fs.rename = originalRename; });

  const store = new ChatSessionStore(new GlobalSessionStorage(vscode.Uri.file(root) as never), 'en', scope);
  await store.initialize();
  assert.equal(store.getActiveSession().id, 'active');
  assert.equal(store.getSessionSummaries().length, 2);
  assert.ok((await stat(legacyPath)).size > 0);
});

test('cleanup is single-flight, limited to once per 24 hours, and preserves favorites', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-flight-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const scope = workspaceScope('cleanup');
  const current = session('current', scope, 1, 0);
  const expired = session('expired', scope, 1, 1);
  const favorite = session('favorite', scope, 1, 2);
  const protectedSession = session('protected', scope, 1, 3);
  expired.updatedAt = '2020-01-01T00:00:00.000Z';
  favorite.updatedAt = '2020-01-01T00:00:00.000Z';
  protectedSession.updatedAt = '2020-01-01T00:00:00.000Z';
  favorite.isFavorite = true;
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  await storage.saveWorkspace(scope, { activeSessionId: current.id, sessions: [current, expired, favorite, protectedSession] });

  const originalReadDirectory = vscode.workspace.fs.readDirectory;
  let workspaceEnumerations = 0;
  vscode.workspace.fs.readDirectory = async (uri) => {
    if (uri.fsPath.endsWith('/chat-sessions/v2/workspaces')) workspaceEnumerations += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return await originalReadDirectory(uri);
  };
  t.after(() => { vscode.workspace.fs.readDirectory = originalReadDirectory; });
  const now = Date.parse('2026-09-12T00:00:00.000Z');
  const results = await Promise.all([
    storage.cleanupExpiredSessions({ currentWorkspaceKey: scope.key, currentActiveSessionId: current.id, protectedSessionIds: ['protected'], now }),
    storage.cleanupExpiredSessions({ currentWorkspaceKey: scope.key, currentActiveSessionId: current.id, protectedSessionIds: ['protected'], now })
  ]);
  assert.deepEqual(results, [true, true]);
  assert.equal(workspaceEnumerations, 1);
  assert.deepEqual((await storage.listWorkspaceSessionSummaries(scope.key)).map((item) => item.id).sort(), ['current', 'favorite', 'protected']);

  await storage.cleanupExpiredSessions({
    currentWorkspaceKey: scope.key,
    currentActiveSessionId: current.id,
    now: now + SESSION_CLEANUP_MIN_INTERVAL_MS - 1
  });
  const manifest = JSON.parse(await readFile(path.join(root, 'chat-sessions', 'v2', 'manifest.json'), 'utf8')) as { lastCleanupAt?: string };
  assert.equal(manifest.lastCleanupAt, new Date(now).toISOString());
  assert.equal(workspaceEnumerations, 1);

  await storage.cleanupExpiredSessions({
    currentWorkspaceKey: scope.key,
    currentActiveSessionId: current.id,
    now: now + 1,
    force: true
  });
  assert.equal(workspaceEnumerations, 2);
});

test('a cleanup write failure does not prevent the active conversation from loading', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-cleanup-failure-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const scope = workspaceScope('cleanup-failure');
  const active = session('active', scope, 2, 0);
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  await storage.saveWorkspace(scope, { activeSessionId: active.id, sessions: [active] });
  const originalRename = vscode.workspace.fs.rename;
  vscode.workspace.fs.rename = async (source, target, options) => {
    if (target.fsPath.endsWith('/chat-sessions/v2/manifest.json')) throw new Error('simulated cleanup failure');
    await originalRename(source, target, options);
  };
  await assert.rejects(storage.cleanupExpiredSessions({
    currentWorkspaceKey: scope.key,
    currentActiveSessionId: active.id,
    now: Date.parse('2026-09-12T00:00:00.000Z')
  }));
  vscode.workspace.fs.rename = originalRename;
  t.after(() => { vscode.workspace.fs.rename = originalRename; });
  const restarted = new ChatSessionStore(new GlobalSessionStorage(vscode.Uri.file(root) as never), 'en', scope);
  await restarted.initialize();
  assert.equal(restarted.messages.length, 2);
});

test('concurrent windows preserve independently written session shards', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-session-windows-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const scope = workspaceScope('windows');
  const first = session('first', scope, 1, 0);
  const second = session('second', scope, 1, 1);
  const a = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const b = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  await Promise.all([
    a.saveWorkspace(scope, { activeSessionId: first.id, sessions: [first] }),
    b.saveWorkspace(scope, { activeSessionId: second.id, sessions: [second] })
  ]);
  const recovered = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  assert.deepEqual((await recovered.listWorkspaceSessionSummaries(scope.key)).map((item) => item.id).sort(), ['first', 'second']);
});

test('workspace listing repairs manifest entries lost by concurrent project writes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-project-windows-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const firstScope = workspaceScope('project-a');
  const secondScope = workspaceScope('project-b');
  await Promise.all([
    new GlobalSessionStorage(vscode.Uri.file(root) as never).saveWorkspace(firstScope, {
      activeSessionId: 'first', sessions: [session('first', firstScope, 1, 0)]
    }),
    new GlobalSessionStorage(vscode.Uri.file(root) as never).saveWorkspace(secondScope, {
      activeSessionId: 'second', sessions: [session('second', secondScope, 1, 1)]
    })
  ]);
  const summaries = await new GlobalSessionStorage(vscode.Uri.file(root) as never).listAllWorkspaceSummaries();
  assert.deepEqual(summaries.map((item) => item.workspaceKey).sort(), [firstScope.key, secondScope.key]);
});

test('deleting an unloaded conversation reports it and removes its shard', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-delete-unloaded-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const scope = workspaceScope('delete-unloaded');
  const sessions = [session('active', scope, 1, 0), session('old', scope, 1, 1)];
  await new GlobalSessionStorage(vscode.Uri.file(root) as never).saveWorkspace(scope, {
    activeSessionId: 'active', sessions
  });
  const store = new ChatSessionStore(new GlobalSessionStorage(vscode.Uri.file(root) as never), 'en', scope);
  await store.initialize();
  const result = await store.deleteSessions(['old']);
  assert.equal(result.deletedCount, 1);
  assert.deepEqual(store.getSessionSummaries().map((item) => item.id), ['active']);
  assert.equal(await new GlobalSessionStorage(vscode.Uri.file(root) as never).loadSession(scope.key, 'old'), undefined);
});

test('context usage cache reuses stable inputs and invalidates model, message, context and schema changes', () => {
  const base = {
    sessionId: 's', sessionUpdatedAt: '1', messageCount: 2, lastMessageSignature: 'm:10:0',
    sourceId: 'source', modelId: 'model', agentSettings: { thinkingEnabled: true },
    contextInstructions: 'stable', contextProjectionFingerprint: 'projection',
    contextFileFingerprints: ['file:a'], requestProtocolVersion: 7, toolSchemaVersion: 7,
    toolNames: ['read']
  };
  const cache = new ContextUsageEstimateCache<object>();
  let computes = 0;
  const value = () => cache.getOrCompute(createContextUsageCacheKey(base), () => ({ computes: ++computes }));
  assert.equal(value(), value());
  assert.equal(computes, 1);
  for (const changed of [
    { modelId: 'other' }, { sessionUpdatedAt: '2' }, { contextProjectionFingerprint: 'next' },
    { contextFileFingerprints: ['file:b'] }, { toolSchemaVersion: 8 }
  ]) {
    cache.getOrCompute(createContextUsageCacheKey({ ...base, ...changed }), () => ({ computes: ++computes }));
  }
  assert.equal(computes, 6);
});

test('webview bootstrap uses monotonic revisions, early ready, paging, and fail-closed startup controls', () => {
  const script = getScript();
  assert.doesNotThrow(() => new Function(script));
  assert.match(script, /incomingRevision <= lastStateRevision/u);
  assert.match(script, /type: 'loadOlderMessages'/u);
  assert.match(script, /sideEffectsReady/u);
  assert.match(script, /getCommandSettingReadiness\('mainModel'\)/u);
  assert.match(script, /approvalModeRestoring/u);
  assert.match(script, /startupLoadingRequestContext/u);
  assert.match(script, /message\.scope === 'startupSettings'/u);
  assert.match(script, /syncSendButtonAvailability/u);
  assert.doesNotMatch(script, /postMessage\(\{ type: 'ready' \}\)/u);
  const html = getHtmlForWebview({
    webview: { cspSource: 'test-csp', asWebviewUri: (uri: vscode.Uri) => uri } as never,
    extensionUri: vscode.Uri.file('/extension') as never,
    language: 'en',
    extensionInfo: {
      displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'test',
      repositoryUrl: 'https://example.invalid', license: 'MIT'
    }
  });
  assert.ok(html.indexOf("postMessage({ type: 'ready' })") < html.indexOf('window.keepseekLogoUri'));
  assert.match(html, /script-src 'nonce-[A-Za-z0-9]+'/u);
});

test('startup settings patches expose values independently while keeping unsafe controls fail closed', () => {
  const posted: Array<{ type: string; scope?: string; revision: number; state: Record<string, unknown> }> = [];
  const activeSession = { approvalMode: 'delegate' };
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    sessionReady: true,
    approvalDataReady: false,
    requestContextReady: false,
    runContextReadiness: 'loading',
    commandSettingsReadiness: {
      mainModel: 'ready', subagentModel: 'loading', approvalMode: 'loading'
    },
    stateRevision: 0,
    startupStatePostCount: 0,
    availableModels: [{ id: 'model', sourceId: 'source' }],
    selectedSourceId: 'source',
    selectedModelId: 'model',
    subagentModelSetting: { version: 1, mode: 'follow-main', updatedAt: new Date(0).toISOString() },
    modelSelectionTransactions: { getSnapshot: () => ({ generation: 0 }) },
    backgroundRunCoordinator: { getActiveRun: () => undefined },
    sessionStore: { getActiveSession: () => activeSession },
    startupTraceStages: new Set<string>(),
    postToWebview: (message: { type: string; scope?: string; revision: number; state: Record<string, unknown> }) => posted.push(message)
  });
  const provider = host as unknown as { postStartupSettingsPatch(): void };
  provider.postStartupSettingsPatch();
  assert.equal(posted[0]?.type, 'statePatch');
  assert.equal(posted[0]?.scope, 'startupSettings');
  assert.equal(posted[0]?.revision, 1);
  assert.equal(posted[0]?.state.approvalMode, 'delegate');
  assert.deepEqual(posted[0]?.state.startup, {
    phase: 'restoring-safety-state', interactiveReady: false, sideEffectsReady: false
  });
  assert.deepEqual(posted[0]?.state.commandSettingsReadiness, {
    mainModel: 'ready', subagentModel: 'loading', approvalMode: 'loading'
  });

  host.approvalDataReady = true;
  host.requestContextReady = true;
  host.runContextReadiness = 'ready';
  host.commandSettingsReadiness = {
    mainModel: 'ready', subagentModel: 'ready', approvalMode: 'ready'
  };
  provider.postStartupSettingsPatch();
  assert.equal(posted[1]?.revision, 2);
  assert.deepEqual(posted[1]?.state.startup, {
    phase: 'ready', interactiveReady: true, sideEffectsReady: true
  });
});

test('command settings become ready without waiting for project context or the first full state', async () => {
  let releaseContext!: () => void;
  const contextGate = new Promise<void>((resolve) => { releaseContext = resolve; });
  let settingsReady!: () => void;
  const settingsReadySignal = new Promise<void>((resolve) => { settingsReady = resolve; });
  let fullStatePosts = 0;
  const patches: Array<Record<string, string>> = [];
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    sessionInitialization: Promise.resolve(),
    sessionReady: false,
    approvalDataReady: false,
    requestContextReady: false,
    runContextReadiness: 'loading',
    commandSettingsReadiness: {
      mainModel: 'loading', subagentModel: 'loading', approvalMode: 'loading'
    },
    availableModels: [{ id: 'model', sourceId: 'source' }],
    startupTraceStages: new Set<string>(),
    sessionStore: { activeSessionId: 'session', getActiveSession: () => ({ approvalMode: 'ask' }) },
    approvalReviews: { initialize: async () => {} },
    changeSets: { initialize: async () => {}, loadSession: async () => {} },
    draftRuns: { initialize: async () => {}, loadSession: async () => {} },
    legacyMemoryMigration: { refresh: async () => {} },
    subagentSettingsStore: {
      load: async () => ({ version: 1, mode: 'follow-main', updatedAt: new Date(0).toISOString() })
    },
    syncConfiguredState: () => {},
    postLightweightState: () => {},
    postStartupSettingsPatch() {
      const snapshot = { ...this.commandSettingsReadiness } as Record<string, string>;
      patches.push(snapshot);
      if (Object.values(snapshot).every((value) => value === 'ready')) settingsReady();
    },
    refreshModelSourceState: async (options?: { onResolved?: () => void }) => { options?.onResolved?.(); },
    refreshSkills: async () => { await contextGate; },
    refreshBackgroundRunAvailability: async () => {},
    postState: () => { fullStatePosts += 1; },
    cleanupExpiredSessions: async () => {},
    refreshBalance: async () => {}
  });
  const provider = host as unknown as { initializeAfterWebviewReady(): Promise<void> };
  const initialization = provider.initializeAfterWebviewReady();
  await settingsReadySignal;
  assert.equal(fullStatePosts, 0);
  assert.equal(host.approvalDataReady, true);
  assert.equal(host.requestContextReady, false);
  assert.ok(patches.some((snapshot) => snapshot.mainModel === 'ready'));
  assert.ok(patches.some((snapshot) => snapshot.subagentModel === 'ready'));
  assert.ok(patches.some((snapshot) => snapshot.approvalMode === 'ready'));

  releaseContext();
  await initialization;
  assert.equal(host.requestContextReady, true);
  assert.equal(fullStatePosts, 1);
});

function workspaceScope(name: string): WorkspaceSessionScope {
  return { key: `workspace:${name}`, name, folderUris: [`file:///${name}`] };
}

function session(id: string, scope: WorkspaceSessionScope, messageCount: number, seed: number): ChatSession {
  const createdAt = new Date(Date.UTC(2026, 8, 12, 0, seed)).toISOString();
  return {
    id,
    title: `Session ${id}`,
    messages: Array.from({ length: messageCount }, (_, index): ChatMessage => ({
      id: `${id}-m-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      content: `message ${seed}-${index}`.padEnd(400, 'x'),
      createdAt
    })),
    approvalMode: 'ask',
    createdAt,
    updatedAt: createdAt,
    workspaceKey: scope.key,
    workspaceName: scope.name,
    workspaceFolders: scope.folderUris,
    isFavorite: false
  };
}

async function writeLegacyWorkspace(
  root: string,
  scope: WorkspaceSessionScope,
  sessions: ChatSession[],
  activeSessionId: string
): Promise<string> {
  const directory = path.join(root, 'chat-sessions', 'v1', 'workspaces');
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `${getWorkspaceHash(scope.key)}.json`);
  await writeFile(target, JSON.stringify({
    version: 1,
    workspaceKey: scope.key,
    workspaceName: scope.name,
    workspaceFolders: scope.folderUris,
    activeSessionId,
    approvalMode: 'ask',
    sessions,
    updatedAt: sessions[0]?.updatedAt
  }));
  return target;
}
