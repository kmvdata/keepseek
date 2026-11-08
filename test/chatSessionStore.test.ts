import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ChatSessionStore,
  getVisibleMessages,
  normalizeStoredSessions,
  SESSION_STORAGE_KEY,
  type ChatSessionStorageAdapter,
  type StoredWorkspaceSessionState,
  type WorkspaceSessionScope
} from '../src/sessions/chatSessionStore';
import {
  CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION,
  CURRENT_PROVIDER_TOOL_SCHEMA_VERSION
} from '../src/agent/providerRequestProjection';
import { GlobalSessionStorage, getWorkspaceHash, SESSION_MIGRATION_KEY } from '../src/sessions/globalSessionStorage';
import type { Memento } from 'vscode';
import { createHistoryTruncationPlan } from '../src/sessions/historyTruncation';
import type { ChatMessage, ChatSession, WorkspaceSummary } from '../src/shared/types';
import * as vscode from './stubs/vscode';

test('stored replay normalization clones protocol data without changing visible history or frozen protocol metadata', () => {
  const scope = { key: 'workspace:replay', name: 'Replay', folderUris: [] };
  const responses = {
    protocol: 'openai-responses', sourceId: ' source ', baseUrl: ' https://fixture.invalid/v1 ',
    items: [{ type: 'reasoning', encrypted_content: 'opaque\n  bytes' }]
  };
  const anthropic = {
    protocol: 'anthropic-messages', sourceId: ' source ', baseUrl: ' https://fixture.invalid/v1 ',
    messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '  thought\n', signature: 'signed' }] }]
  };
  const requestProtocol = {
    version: 2, serializationStrategy: 'provider-projection-v2', toolSchemaVersion: 2,
    toolNames: ['keepseek_read_workspace_file_range'], sourceId: 'source', createdAt: '2026-01-01T00:00:00.000Z'
  };
  const replays = [responses, anthropic, { ...responses, items: [{ type: 'future_item' }] }, { protocol: 'future' }];
  const raw = {
    ...createSession('session-replay', [], scope), requestProtocol,
    messages: replays.map((providerReplay, index) => ({
      ...createMessage(index), content: ' visible\n  bytes ', expandedContent: ' expanded\n bytes ', providerReplay
    }))
  };

  const [session] = normalizeStoredSessions({ sessions: [raw] }, scope);
  assert.deepEqual(JSON.parse(JSON.stringify(session.requestProtocol)), requestProtocol);
  assert.deepEqual(session.messages.map(message => message.content), replays.map(() => ' visible\n  bytes '));
  assert.deepEqual(session.messages.map(message => message.expandedContent), replays.map(() => ' expanded\n bytes '));
  assert.deepEqual(session.messages.slice(0, 2).map(message => message.providerReplay), [
    { ...responses, sourceId: 'source', baseUrl: 'https://fixture.invalid/v1' },
    { ...anthropic, sourceId: 'source', baseUrl: 'https://fixture.invalid/v1' }
  ]);
  assert.equal(session.messages[2].providerReplay, undefined);
  assert.equal(session.messages[3].providerReplay, undefined);

  responses.items[0].encrypted_content = 'changed after load';
  anthropic.messages[0].content[0].signature = 'changed after load';
  const replay = session.messages[0].providerReplay;
  assert.equal(replay?.protocol === 'openai-responses' && replay.items[0].encrypted_content, 'opaque\n  bytes');
  const signedReplay = session.messages[1].providerReplay;
  assert.equal(signedReplay?.protocol === 'anthropic-messages'
    && signedReplay.messages[0].content[0].type === 'thinking'
    && signedReplay.messages[0].content[0].signature, 'signed');
  const visible = getVisibleMessages(session.messages);
  assert.deepEqual(visible.map(message => message.id), session.messages.map(message => message.id));
  assert.ok(visible.every(message => !('providerReplay' in message) && !('expandedContent' in message)));
});

test('trimActiveHistory preserves persisted active session messages', async () => {
  const workspaceScope: WorkspaceSessionScope = {
    key: 'workspace:test',
    name: 'Test Workspace',
    folderUris: []
  };
  const session = createSession(
    'session-1',
    Array.from({ length: 100 }, (_value, index) => createMessage(index)),
    workspaceScope
  );
  const storage = new MemorySessionStorage({
    activeSessionId: session.id,
    sessions: [session]
  });
  session.repairLoop = {
    status: 'waiting_for_apply',
    iteration: 1,
    maxIterations: 2,
    lastValidationScript: 'compile',
    pendingDraftEditIds: ['edit-1'],
    stopReason: 'waiting_for_apply'
  };
  session.historyArchive = [{
    id: 'archive-1', messageId: 'm1', toolCallId: 'call-1', toolName: 'read', role: 'tool',
    content: 'complete archived result', contentHash: 'hash-1', createdAt: '2026-01-01T00:00:00.000Z'
  }];
  session.requestProtocol = {
    version: 2, serializationStrategy: 'provider-projection-v2', toolSchemaVersion: 2,
    toolNames: ['keepseek_read_workspace_file_range'], sourceId: 'source-a', createdAt: '2026-01-01T00:00:00.000Z',
    lastProviderRequestAt: '2026-01-01T00:01:00.000Z'
  };
  session.contextCompression = {
    version: 1,
    protectedMessageIds: [],
    summaries: [{
      id: 'legacy-summary',
      content: 'legacy summary content',
      coveredMessageIds: ['m1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tokenEstimate: 10,
      modelId: 'legacy-model',
      version: 1
    }]
  };
  const store = new ChatSessionStore(storage, 'en', workspaceScope);

  await store.initialize();
  store.trimActiveHistory(10);
  await store.persist();

  assert.equal(store.messages.length, 100);
  assert.equal(store.getActiveSession().contextCompression?.summaries[0]?.modelId, 'legacy-model');
  assert.equal(store.getActiveSession().contextCompression?.summaries[0]?.sourceId, undefined);
  assert.equal(store.messages[0].id, 'm0');
  assert.equal(store.messages[99].id, 'm99');
  assert.equal(storage.saved?.sessions[0]?.messages.length, 100);
  assert.equal(storage.saved?.sessions[0]?.messages[0]?.id, 'm0');
  assert.deepEqual(storage.saved?.sessions[0]?.repairLoop?.pendingDraftEditIds, ['edit-1']);
  assert.equal(storage.saved?.sessions[0]?.historyArchive?.[0]?.content, 'complete archived result');
  assert.deepEqual(storage.saved?.sessions[0]?.requestProtocol?.toolNames, ['keepseek_read_workspace_file_range']);
  assert.equal(storage.saved?.sessions[0]?.requestProtocol?.sourceId, 'source-a');
  assert.equal(storage.saved?.sessions[0]?.requestProtocol?.version, 2);
  assert.equal(storage.saved?.sessions[0]?.requestProtocol?.serializationStrategy, 'provider-projection-v2');

  const next = await store.createNewSession('en');
  assert.equal(next.requestProtocol?.version, CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION);
  assert.equal(next.requestProtocol?.toolSchemaVersion, CURRENT_PROVIDER_TOOL_SCHEMA_VERSION);
  assert.equal(next.requestProtocol?.serializationStrategy, 'provider-projection-v2');
});

test('coalesced persistence waits for the requested snapshot revision and commits the latest state', async () => {
  const workspaceScope: WorkspaceSessionScope = {
    key: 'workspace:coalesced-persist',
    name: 'Coalesced Persist',
    folderUris: []
  };
  const session = createSession('session-1', [createMessage(0)], workspaceScope);
  const storage = new MemorySessionStorage({ activeSessionId: session.id, sessions: [session] });
  const originalSave = storage.saveWorkspace.bind(storage);
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let signalFirst!: () => void;
  let signalSecond!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const firstStarted = new Promise<void>((resolve) => { signalFirst = resolve; });
  const secondStarted = new Promise<void>((resolve) => { signalSecond = resolve; });
  let writes = 0;
  storage.saveWorkspace = async (scope, state) => {
    writes += 1;
    if (writes === 1) { signalFirst(); await firstGate; }
    if (writes === 2) { signalSecond(); await secondGate; }
    await originalSave(scope, state);
  };
  const store = new ChatSessionStore(storage, 'en', workspaceScope);
  await store.initialize();

  store.messages.push(createMessage(1));
  const first = store.persist();
  await firstStarted;
  store.messages.push(createMessage(2));
  let secondResolved = false;
  const second = store.persist().then(() => { secondResolved = true; });
  releaseFirst();
  await first;
  await secondStarted;
  assert.equal(secondResolved, false, 'the latest caller must not resolve after only the older snapshot is durable');
  releaseSecond();
  await second;

  assert.equal(writes, 2);
  assert.deepEqual(storage.saved?.sessions[0]?.messages.map((message) => message.id), ['m0', 'm1', 'm2']);
});

test('fresh sessions commit without waiting for an old body and survive its delayed initialization', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-fresh-session-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const scope = { key: 'fresh-session', name: 'Fresh', folderUris: [] };
  const old = createSession('old-session', [createMessage(0), createMessage(1)], scope);
  await storage.saveWorkspace(scope, { activeSessionId: old.id, sessions: [old] });
  const oldShard = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key), 'sessions',
    `${createHash('sha256').update(old.id).digest('hex').slice(0, 32)}.json`);
  const oldBytes = await readFile(oldShard, 'utf8');
  const loaded = deferred<void>(), release = deferred<void>();
  const load = storage.loadWorkspace.bind(storage);
  let reads = 0;
  storage.loadWorkspace = async workspace => {
    reads += 1;
    const result = await load(workspace);
    loaded.resolve(); await release.promise;
    return result;
  };
  const writes: string[][] = [];
  const save = storage.saveSessionChanges.bind(storage);
  storage.saveSessionChanges = async (workspace, state, preserve) => {
    writes.push(state.sessions.map(session => session.id));
    await save(workspace, state, preserve);
  };
  const store = new ChatSessionStore(storage, 'en', scope);
  const placeholder = store.getActiveSession();
  const initializing = store.initialize();
  await loaded.promise;
  let selectedAtSaving = '';
  const fresh = await store.createFreshSession('en', id => { selectedAtSaving = store.activeSessionId; assert.equal(id, selectedAtSaving); });
  assert.equal(store.getActiveSession(), fresh);
  assert.equal(reads, 1, 'New Chat must not issue another historical body load');
  assert.deepEqual(writes, [[fresh.id]], 'the pre-load placeholder is not authority');
  const disk = await new GlobalSessionStorage(vscode.Uri.file(root) as never).loadWorkspace(scope);
  assert.equal(disk.activeSessionId, fresh.id);
  assert.deepEqual(new Set(disk.sessionSummaries?.map(session => session.id)), new Set([old.id, fresh.id]));
  assert.ok(!disk.sessionSummaries?.some(session => session.id === placeholder.id));
  fresh.messages.push(createMessage(2));
  store.markSessionDirty(fresh.id);
  release.resolve(); await initializing;
  assert.equal(store.getActiveSession(), fresh, 'a late load cannot replace the live fresh object or selection');
  assert.deepEqual(fresh.messages.map(message => message.id), ['m2']);
  assert.ok(store.getSessionSummaries().some(session => session.id === old.id));
  await store.flush();
  assert.deepEqual(writes, [[fresh.id], [fresh.id]], 'late initialization preserves unsaved fresh revisions');
  assert.equal((await storage.loadSession(scope.key, fresh.id))?.messages[0]?.content, 'message 2');
  assert.equal(await readFile(oldShard, 'utf8'), oldBytes, 'old user/replay shards are untouched');
});

test('failed historical initialization does not discard a durable fresh session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-fresh-failed-load-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const scope = { key: 'fresh-failed-load', name: 'Fresh', folderUris: [] };
  const old = createSession('old-session', [createMessage(0)], scope);
  await storage.saveWorkspace(scope, { activeSessionId: old.id, sessions: [old] });
  const release = deferred<void>();
  storage.loadWorkspace = async () => { await release.promise; throw new Error('old history unavailable'); };
  const store = new ChatSessionStore(storage, 'en', scope);
  const initializing = store.initialize();
  const rejected = assert.rejects(initializing, /old history unavailable/);
  const fresh = await store.createFreshSession();
  release.resolve(); await rejected;
  assert.equal(store.getActiveSession(), fresh);
  fresh.messages.push(createMessage(2)); await store.persist();
  const disk = await new GlobalSessionStorage(vscode.Uri.file(root) as never).loadWorkspace(scope);
  assert.equal(disk.activeSessionId, fresh.id);
  assert.equal(disk.sessions[0].messages[0].id, 'm2');
  assert.ok(disk.sessionSummaries?.some(session => session.id === old.id));
});

test('fresh sessions inherit the saved project mode while its old body is still unread', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-fresh-preferences-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const originalRead = vscode.workspace.fs.readFile;
  const release = deferred<void>();
  t.after(async () => {
    release.resolve(); vscode.workspace.fs.readFile = originalRead;
    await storage.flush(); await rm(root, { recursive: true, force: true });
  });
  const scope = { key: 'fresh-preferences', name: 'Fresh', folderUris: [] };
  const old = createSession('old-session', [createMessage(0)], scope);
  await storage.saveWorkspace(scope, { activeSessionId: old.id, approvalMode: 'delegate', sessions: [old] });
  const oldShard = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key), 'sessions',
    `${createHash('sha256').update(old.id).digest('hex').slice(0, 32)}.json`);
  const oldBytes = await readFile(oldShard, 'utf8');
  const blocked = deferred<void>();
  let bodyReads = 0;
  vscode.workspace.fs.readFile = async uri => {
    if (uri.fsPath === oldShard) { bodyReads += 1; blocked.resolve(); await release.promise; }
    return await originalRead(uri);
  };
  const store = new ChatSessionStore(storage, 'en', scope);
  const initializing = store.initialize();
  await blocked.promise;
  let selectedAtSaving = '';
  const creating = store.createFreshSession('en', id => { selectedAtSaving = id; });
  assert.equal(store.activeSessionId, selectedAtSaving, 'selection happens before preference I/O');
  assert.equal(store.approvalMode, 'ask', 'unread preferences cannot grant authority before their read');
  const fresh = await creating;
  assert.equal(store.approvalMode, 'delegate');
  assert.equal(fresh.approvalMode, 'delegate');
  assert.equal(bodyReads, 1, 'preference reads and fresh commits never open the old active body');
  const disk = await new GlobalSessionStorage(vscode.Uri.file(root) as never).loadWorkspace(scope);
  assert.equal(disk.activeSessionId, fresh.id);
  assert.equal(disk.approvalMode, 'delegate');
  assert.ok(disk.sessionSummaries?.some(session => session.id === old.id));
  assert.equal(await readFile(oldShard, 'utf8'), oldBytes);
  release.resolve(); await initializing;
  assert.equal(store.getActiveSession(), fresh);
  assert.equal(store.approvalMode, 'delegate');
});

test('an explicit newer ask selection wins a delayed saved delegate preference', async () => {
  const scope = { key: 'fresh-preference-selection', name: 'Fresh', folderUris: [] };
  const old = createSession('old-session', [createMessage(0)], scope);
  const storage = new MemorySessionStorage({ activeSessionId: old.id, approvalMode: 'delegate', sessions: [old] });
  const adapter: ChatSessionStorageAdapter = storage;
  const release = deferred<void>();
  adapter.readWorkspaceApprovalMode = async () => { await release.promise; return 'delegate'; };
  const store = new ChatSessionStore(adapter, 'en', scope);
  const creating = store.createFreshSession();
  assert.equal(await store.setApprovalMode('ask'), false);
  release.resolve(); const fresh = await creating;
  assert.equal(fresh.approvalMode, 'ask');
  assert.equal(store.approvalMode, 'ask');
  assert.equal(storage.saved?.approvalMode, 'ask');
});

test('fresh sessions also retain their live selection across an already-initialized reload', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-fresh-reload-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const scope = { key: 'fresh-reload', name: 'Fresh', folderUris: [] };
  const old = createSession('old-session', [createMessage(0)], scope);
  await storage.saveWorkspace(scope, { activeSessionId: old.id, sessions: [old] });
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const loaded = deferred<void>(), release = deferred<void>();
  const load = storage.loadWorkspace.bind(storage);
  storage.loadWorkspace = async workspace => {
    const snapshot = await load(workspace);
    loaded.resolve(); await release.promise; return snapshot;
  };
  const reloading = store.initialize();
  await loaded.promise;
  const fresh = await store.createFreshSession();
  fresh.messages.push(createMessage(2)); store.markSessionDirty(fresh.id);
  release.resolve(); await reloading;
  assert.equal(store.getActiveSession(), fresh);
  await store.flush();
  assert.equal((await storage.loadSession(scope.key, fresh.id))?.messages[0]?.id, 'm2');
});

test('fresh sessions safely merge replacement-only adapters before initialization', async () => {
  const scope = { key: 'fresh-replacement', name: 'Fresh', folderUris: [] };
  const old = createSession('old-session', [createMessage(0)], scope);
  const storage = new MemorySessionStorage({ activeSessionId: old.id, sessions: [old] });
  const store = new ChatSessionStore(storage, 'en', scope);
  const placeholder = store.getActiveSession();
  const fresh = await store.createFreshSession();
  assert.equal(storage.saved?.activeSessionId, fresh.id);
  assert.deepEqual(new Set(storage.saved?.sessions.map(session => session.id)), new Set([old.id, fresh.id]));
  assert.ok(!storage.saved?.sessions.some(session => session.id === placeholder.id));
  await store.initialize();
  assert.equal(store.getActiveSession(), fresh);
});

test('fresh sessions preserve V1 history when a delayed legacy migration resumes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-fresh-legacy-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const originalRead = vscode.workspace.fs.readFile;
  const release = deferred<void>();
  t.after(async () => {
    release.resolve(); vscode.workspace.fs.readFile = originalRead;
    await storage.flush(); await rm(root, { recursive: true, force: true });
  });
  const scope = { key: 'fresh-legacy', name: 'Fresh', folderUris: [] };
  const old = createSession('old-session', [createMessage(0), createMessage(1)], scope);
  const legacyPath = path.join(root, 'chat-sessions', 'v1', 'workspaces', `${getWorkspaceHash(scope.key)}.json`);
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(legacyPath)));
  await writeFile(legacyPath, JSON.stringify({ version: 1, workspaceKey: scope.key, workspaceName: scope.name,
    workspaceFolders: [], activeSessionId: old.id, approvalMode: 'delegate', sessions: [old], updatedAt: old.updatedAt }));
  const loaded = deferred<void>();
  let held = false;
  vscode.workspace.fs.readFile = async uri => {
    const bytes = await originalRead(uri);
    if (!held && uri.fsPath === legacyPath) { held = true; loaded.resolve(); await release.promise; }
    return bytes;
  };
  const store = new ChatSessionStore(storage, 'en', scope);
  const initializing = store.initialize();
  await loaded.promise;
  const fresh = await store.createFreshSession();
  release.resolve(); await initializing;
  assert.equal(store.getActiveSession(), fresh);
  const disk = await new GlobalSessionStorage(vscode.Uri.file(root) as never).loadWorkspace(scope);
  assert.equal(disk.activeSessionId, fresh.id);
  assert.equal(disk.approvalMode, 'delegate');
  assert.equal(fresh.approvalMode, 'delegate');
  assert.deepEqual(new Set(disk.sessionSummaries?.map(session => session.id)), new Set([old.id, fresh.id]));
  assert.deepEqual((await storage.loadSession(scope.key, old.id))?.messages.map(message => message.content), ['message 0', 'message 1']);
});

test('workspace-state migration imports history without reopening current bodies or reverting a fresh selection', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-fresh-workspace-migration-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const originalRead = vscode.workspace.fs.readFile;
  t.after(async () => {
    vscode.workspace.fs.readFile = originalRead;
    await storage.flush(); await rm(root, { recursive: true, force: true });
  });
  const scope = { key: 'fresh-workspace-migration', name: 'Fresh', folderUris: [] };
  const current = createSession('current', [createMessage(0), createMessage(1)], scope);
  current.updatedAt = '2026-01-02T00:00:00.000Z';
  await storage.saveWorkspace(scope, { activeSessionId: current.id, approvalMode: 'delegate', sessions: [current] });
  const store = new ChatSessionStore(storage, 'en', scope);
  const fresh = await store.createFreshSession();
  const shard = (id: string) => path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key), 'sessions',
    `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`);
  const protectedPaths = [shard(current.id), shard(fresh.id)];
  const before = await Promise.all(protectedPaths.map(file => readFile(file, 'utf8')));
  const stale = createSession(current.id, [createMessage(0)], scope);
  const imported = createSession('legacy-only', [createMessage(3)], scope);
  const state = new MemoryMemento();
  await state.update(SESSION_STORAGE_KEY, { version: 2, activeSessionId: imported.id,
    activeSessionIdsByWorkspace: { [scope.key]: imported.id }, sessions: [stale, imported] });
  let bodyReads = 0;
  vscode.workspace.fs.readFile = async uri => {
    if (protectedPaths.some(file => uri.fsPath === file || uri.fsPath.startsWith(`${file}.objects${path.sep}`))) bodyReads += 1;
    return await originalRead(uri);
  };
  assert.equal(await storage.migrateLegacyWorkspaceState(state, scope), true);
  assert.equal(bodyReads, 0, 'metadata comparison must not reopen current authority bodies');
  vscode.workspace.fs.readFile = originalRead;
  const disk = await new GlobalSessionStorage(vscode.Uri.file(root) as never).loadWorkspace(scope);
  assert.equal(disk.activeSessionId, fresh.id, 'an obsolete workspace-state selection cannot replace New Chat');
  assert.equal(disk.approvalMode, 'delegate');
  assert.deepEqual(new Set(disk.sessionSummaries?.map(session => session.id)), new Set([current.id, fresh.id, imported.id]));
  assert.deepEqual(await Promise.all(protectedPaths.map(file => readFile(file, 'utf8'))), before);
  assert.equal((await storage.loadSession(scope.key, imported.id))?.messages[0]?.id, 'm3');
  assert.equal(state.get(SESSION_MIGRATION_KEY), true);
  assert.equal(await storage.migrateLegacyWorkspaceState(state, scope), false);
});

test('workspace-state migration verifies only strictly newer same-ID legacy conflicts and keeps current ties', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-workspace-migration-conflict-'));
  const writer = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const importer = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const originalRead = vscode.workspace.fs.readFile;
  t.after(async () => {
    vscode.workspace.fs.readFile = originalRead;
    await writer.flush(); await importer.flush(); await rm(root, { recursive: true, force: true });
  });
  const scope = { key: 'workspace-migration-conflict', name: 'Migration', folderUris: [] };
  const newer = createSession('newer-current', [createMessage(0), createMessage(1)], scope);
  const equal = createSession('equal-current', [createMessage(2)], scope);
  const older = createSession('older-current', [createMessage(3)], scope);
  newer.updatedAt = '2026-01-03T00:00:00.000Z';
  equal.updatedAt = '2026-01-02T00:00:00.000Z';
  older.updatedAt = '2026-01-01T00:00:00.000Z';
  await writer.saveWorkspace(scope, { activeSessionId: newer.id, approvalMode: 'delegate', sessions: [newer, equal, older] });
  const incomingOlder = { ...newer, updatedAt: '2026-01-01T00:00:00.000Z', messages: [createMessage(4)] };
  const incomingEqual = { ...equal, messages: [createMessage(5)] };
  const incomingNewer = { ...older, updatedAt: '2026-01-04T00:00:00.000Z', messages: [createMessage(6), createMessage(7)] };
  const missing = createSession('legacy-only', [createMessage(8)], scope);
  const state = new MemoryMemento();
  await state.update(SESSION_STORAGE_KEY, { version: 2, activeSessionId: missing.id,
    activeSessionIdsByWorkspace: { [scope.key]: missing.id }, sessions: [incomingOlder, incomingEqual, incomingNewer, missing] });
  const shard = (id: string) => path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key), 'sessions',
    `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`);
  const protectedPaths = [shard(newer.id), shard(equal.id)];
  const protectedBytes = await Promise.all(protectedPaths.map(file => readFile(file, 'utf8')));
  let unrelatedReads = 0, conflictReads = 0;
  vscode.workspace.fs.readFile = async uri => {
    if (protectedPaths.some(file => uri.fsPath === file || uri.fsPath.startsWith(`${file}.objects${path.sep}`))) unrelatedReads += 1;
    if (uri.fsPath.startsWith(shard(older.id))) conflictReads += 1;
    return await originalRead(uri);
  };
  assert.equal(await importer.migrateLegacyWorkspaceState(state, scope), true);
  assert.equal(unrelatedReads, 0);
  assert.ok(conflictReads > 0, 'a new writer must verify the winning conflict before committing its replacement');
  vscode.workspace.fs.readFile = originalRead;
  const disk = await importer.loadWorkspace(scope);
  assert.equal(disk.activeSessionId, newer.id);
  assert.equal(disk.approvalMode, 'delegate');
  assert.deepEqual(await Promise.all(protectedPaths.map(file => readFile(file, 'utf8'))), protectedBytes);
  assert.deepEqual((await importer.loadSession(scope.key, older.id))?.messages.map(message => message.id), ['m6', 'm7']);
  assert.equal((await importer.loadSession(scope.key, missing.id))?.messages[0]?.id, 'm8');
});

test('first workspace-state import keeps its original active conversation and completes once', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-first-workspace-migration-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const scope = { key: 'first-workspace-migration', name: 'Migration', folderUris: [] };
  const first = createSession('first', [createMessage(0)], scope);
  const selected = createSession('selected', [createMessage(1)], scope);
  const state = new MemoryMemento();
  await state.update(SESSION_STORAGE_KEY, { version: 2, activeSessionId: selected.id,
    activeSessionIdsByWorkspace: { [scope.key]: selected.id }, sessions: [first, selected] });
  assert.equal(await storage.migrateLegacyWorkspaceState(state, scope), true);
  const disk = await storage.loadWorkspace(scope);
  assert.equal(disk.activeSessionId, selected.id);
  assert.deepEqual(new Set(disk.sessionSummaries?.map(session => session.id)), new Set([first.id, selected.id]));
  assert.equal(state.get(SESSION_MIGRATION_KEY), true);
  assert.equal(await storage.migrateLegacyWorkspaceState(state, scope), false);
});

test('approval mode persists for the project and is inherited by every new or selected session', async () => {
  const workspaceScope: WorkspaceSessionScope = {
    key: 'workspace:approval-mode',
    name: 'Approval Workspace',
    folderUris: []
  };
  const original = createSession('original', [createMessage(0)], workspaceScope);
  const older = createSession('older', [createMessage(1)], workspaceScope);
  const storage = new MemorySessionStorage({
    activeSessionId: original.id,
    sessions: [original, older]
  });
  const store = new ChatSessionStore(storage, 'en', workspaceScope);

  await store.initialize();
  assert.equal(store.approvalMode, 'ask');
  assert.equal(await store.setApprovalMode('delegate'), true);
  assert.equal(storage.saved?.approvalMode, 'delegate');

  const created = await store.createNewSession('en');
  assert.equal(created.approvalMode, 'delegate');

  const selected = await store.selectSession(older.id);
  assert.equal(selected?.approvalMode, 'delegate');

  const restarted = new ChatSessionStore(storage, 'en', workspaceScope);
  await restarted.initialize();
  assert.equal(restarted.approvalMode, 'delegate');
  assert.equal(restarted.getActiveSession().approvalMode, 'delegate');
});

test('execution mode defaults to normal and is restored independently for each session', async () => {
  const workspaceScope: WorkspaceSessionScope = {
    key: 'workspace:execution-mode',
    name: 'Execution Workspace',
    folderUris: []
  };
  const normal = createSession('normal-session', [createMessage(0)], workspaceScope);
  const planned = createSession('plan-session', [createMessage(1)], workspaceScope);
  planned.executionMode = 'plan';
  const storage = new MemorySessionStorage({
    activeSessionId: normal.id,
    sessions: [normal, planned]
  });
  const store = new ChatSessionStore(storage, 'en', workspaceScope);

  await store.initialize();
  assert.equal(store.executionMode, 'normal');
  assert.equal((await store.createNewSession('en')).executionMode, 'normal');
  assert.equal((await store.selectSession(planned.id))?.executionMode, 'plan');
  assert.equal(await store.setExecutionMode('normal'), true);
  assert.equal((await store.selectSession(normal.id))?.executionMode, 'normal');
  assert.equal(await store.setExecutionMode('plan'), true);

  const restarted = new ChatSessionStore(storage, 'en', workspaceScope);
  await restarted.initialize();
  assert.equal(restarted.executionMode, 'plan');
  assert.equal((await restarted.selectSession(planned.id))?.executionMode, 'normal');
});

test('legacy workspace approval mode migrates from its active session', async () => {
  const workspaceScope: WorkspaceSessionScope = {
    key: 'workspace:legacy-approval-mode',
    name: 'Legacy Approval Workspace',
    folderUris: []
  };
  const active = createSession('active', [createMessage(0)], workspaceScope);
  active.approvalMode = 'delegate';
  const storage = new MemorySessionStorage({ activeSessionId: active.id, sessions: [active] });
  const store = new ChatSessionStore(storage, 'en', workspaceScope);

  await store.initialize();
  assert.equal(store.approvalMode, 'delegate');
  const created = await store.createNewSession('en');
  assert.equal(created.approvalMode, 'delegate');
  assert.equal(storage.saved?.approvalMode, 'delegate');
});

test('stored project approval mode overrides stale per-session values on load', async () => {
  const workspaceScope: WorkspaceSessionScope = {
    key: 'workspace:stored-project-mode',
    name: 'Stored Project Mode',
    folderUris: []
  };
  const active = createSession('active', [createMessage(0)], workspaceScope);
  active.approvalMode = 'ask';
  const storage = new MemorySessionStorage({
    activeSessionId: active.id,
    approvalMode: 'delegate',
    sessions: [active]
  });
  const store = new ChatSessionStore(storage, 'en', workspaceScope);

  await store.initialize();
  assert.equal(store.approvalMode, 'delegate');
  assert.equal(store.getActiveSession().approvalMode, 'delegate');
});

test('legacy project model_review migrates to ask without broadening authorization and rejects new legacy selections', async () => {
  const scope = { key: 'legacy-mode', name: 'Legacy', folderUris: [] };
  const active = createSession('legacy-active', [createMessage(0)], scope);
  const originalMessages = active.messages.map(message => ({ content: message.content, expandedContent: message.expandedContent, providerContent: message.providerContent }));
  const storage = new MemorySessionStorage({ activeSessionId: active.id, approvalMode: 'model_review' as never, sessions: [active] });
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  assert.equal(store.approvalMode, 'ask');
  assert.equal(store.getActiveSession().approvalModeMigrated, true);
  assert.equal(await store.setApprovalMode('model_review' as never), false);
  assert.deepEqual(store.getActiveSession().messages.map(message => ({ content: message.content, expandedContent: message.expandedContent, providerContent: message.providerContent })), originalMessages);
});

test('global storage isolates project approval modes and copied sessions use the target project mode', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-project-approval-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const storageUri = vscode.Uri.file(root) as never;
  const storage = new GlobalSessionStorage(storageUri);
  const firstScope: WorkspaceSessionScope = {
    key: 'workspace:first', name: 'First', folderUris: ['file:///first']
  };
  const secondScope: WorkspaceSessionScope = {
    key: 'workspace:second', name: 'Second', folderUris: ['file:///second']
  };

  const first = new ChatSessionStore(storage, 'en', firstScope);
  await first.initialize();
  await first.setApprovalMode('delegate');
  await first.setExecutionMode('plan');
  const firstSessionId = first.activeSessionId;

  const second = new ChatSessionStore(storage, 'en', secondScope);
  await second.initialize();
  assert.equal(second.approvalMode, 'ask');
  await second.setApprovalMode('delegate');
  const copied = await second.copyOtherWorkspaceSession(firstScope.key, firstSessionId);
  assert.equal(copied?.approvalMode, 'delegate');
  assert.equal(copied?.executionMode, 'normal');
  assert.equal(copied?.planWorkflows, undefined);

  const restartedFirst = new ChatSessionStore(new GlobalSessionStorage(storageUri), 'en', firstScope);
  await restartedFirst.initialize();
  assert.equal(restartedFirst.approvalMode, 'delegate');
  assert.equal((await restartedFirst.createNewSession('en')).approvalMode, 'delegate');

  const restartedSecond = new ChatSessionStore(new GlobalSessionStorage(storageUri), 'en', secondScope);
  await restartedSecond.initialize();
  assert.equal(restartedSecond.approvalMode, 'delegate');
});

test('copying another workspace session refuses a pending or malformed history journal before creating a new identity', async () => {
  const sourceScope = { key: 'workspace:copy-source', name: 'Source', folderUris: [] };
  const targetScope = { key: 'workspace:copy-target', name: 'Target', folderUris: [] };
  const source = createSession('copy-source', [createMessage(0), createMessage(1)], sourceScope);
  const target = createSession('copy-target', [], targetScope);
  const storage = new MemorySessionStorage({ activeSessionId: target.id, sessions: [target] });
  storage.loadWorkspaceSessions = async () => [source];
  const store = new ChatSessionStore(storage, 'en', targetScope);
  await store.initialize();
  const originalSource = JSON.stringify(source);
  const journal = createHistoryTruncationPlan(source, 'm0', { ...createMessage(2), content: 'replacement bytes' })!;
  for (const pending of [journal, null, { version: 1, sessionId: 'wrong-session' }]) {
    source.pendingHistoryTruncation = pending as ChatSession['pendingHistoryTruncation'];
    await assert.rejects(store.copyOtherWorkspaceSession(sourceScope.key, source.id), /original workspace.*history recovery/);
    assert.equal(store.activeSessionId, target.id);
    assert.equal(store.getSessionSummaries().length, 1);
    assert.equal(storage.saved, undefined);
  }
  delete source.pendingHistoryTruncation;
  assert.equal(JSON.stringify(source), originalSource);
  const copied = await store.copyOtherWorkspaceSession(sourceScope.key, source.id);
  assert.ok(copied && copied.id !== source.id);
  assert.equal(copied.pendingHistoryTruncation, undefined);
  assert.deepEqual(copied.messages.map(message => message.content), source.messages.map(message => message.content));
  assert.equal(storage.saved?.sessions.find(session => session.id === copied.id)?.pendingHistoryTruncation, undefined);
});

test('loading a corrupt history truncation journal fails closed instead of dropping its pending recovery boundary', () => {
  const scope = { key: 'workspace:corrupt-truncation', name: 'Corrupt', folderUris: [] };
  const source = createSession('corrupt-source', [createMessage(0)], scope);
  assert.throws(() => normalizeStoredSessions({ sessions: [{ ...source, pendingHistoryTruncation: null }] }, scope), /journal/);
  assert.throws(() => normalizeStoredSessions({ sessions: [{ ...source,
    pendingHistoryTruncation: { version: 1, sessionId: 'another-session' } }] }, scope), /journal scope/);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

class MemoryMemento implements Memento {
  private readonly values = new Map<string, unknown>();
  public keys(): readonly string[] { return [...this.values.keys()]; }
  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }
  public async update(key: string, value: unknown): Promise<void> { this.values.set(key, value); }
}

class MemorySessionStorage implements ChatSessionStorageAdapter {
  public saved: StoredWorkspaceSessionState | undefined;

  public constructor(private state: StoredWorkspaceSessionState) {}

  public async loadWorkspace(_workspaceScope: WorkspaceSessionScope): Promise<StoredWorkspaceSessionState> {
    void _workspaceScope;
    return cloneWorkspaceState(this.state);
  }

  public async saveWorkspace(
    _workspaceScope: WorkspaceSessionScope,
    state: StoredWorkspaceSessionState
  ): Promise<void> {
    void _workspaceScope;
    this.state = cloneWorkspaceState(state);
    this.saved = cloneWorkspaceState(state);
  }

  public async listAllWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
    return [];
  }

  public async loadWorkspaceSessions(_workspaceKey: string): Promise<ChatSession[]> {
    void _workspaceKey;
    return [];
  }

  public async deleteWorkspaceSessions(_workspaceKey: string, _sessionIds: string[]): Promise<void> {
    void _workspaceKey;
    void _sessionIds;
    return undefined;
  }

  public async deleteEntireWorkspace(_workspaceKey: string): Promise<void> {
    void _workspaceKey;
    return undefined;
  }

  public async cleanupExpiredSessions(): Promise<boolean> {
    return false;
  }
}

function createSession(
  id: string,
  messages: ChatMessage[],
  workspaceScope: WorkspaceSessionScope
): ChatSession {
  const now = new Date(0).toISOString();
  return {
    id,
    title: 'Long Session',
    messages,
    createdAt: now,
    updatedAt: now,
    workspaceKey: workspaceScope.key,
    workspaceName: workspaceScope.name,
    workspaceFolders: workspaceScope.folderUris,
    isFavorite: false
  };
}

function createMessage(index: number): ChatMessage {
  return {
    id: `m${index}`,
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `message ${index}`,
    createdAt: new Date(index * 1000).toISOString()
  };
}

function cloneWorkspaceState(state: StoredWorkspaceSessionState): StoredWorkspaceSessionState {
  return {
    activeSessionId: state.activeSessionId,
    approvalMode: state.approvalMode,
    sessions: state.sessions.map((session) => ({
      ...session,
      messages: session.messages.map((message) => ({ ...message })),
      contextCompression: session.contextCompression
        ? {
            ...session.contextCompression,
            protectedMessageIds: [...session.contextCompression.protectedMessageIds],
            summaries: session.contextCompression.summaries.map((summary) => ({
              ...summary,
              coveredMessageIds: [...summary.coveredMessageIds]
            }))
          }
        : undefined,
      repairLoop: session.repairLoop
        ? { ...session.repairLoop, pendingDraftEditIds: [...session.repairLoop.pendingDraftEditIds] }
        : undefined
    }))
  };
}

test('execution timing survives persistence, repeated saves, session switches and a store restart', async (t) => {
  const { executionTimeView } = await import('../src/sessions/executionTimeStats.js');
  const scope = { key: 'timing', name: 'Timing', folderUris: [] };
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-execution-time-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const first = store.getActiveSession();
  first.messages.push({ id: 'u', role: 'user', content: 'first run', createdAt: new Date().toISOString() });
  first.messages.push({ id: 'a', role: 'assistant', content: 'done', createdAt: new Date().toISOString(),
    runState: { taskId: 'runA', usedMs: 12345, status: 'completed', maxExecutionMs: 0, limitSource: 'test',
      attempt: 1, modelRequests: 1, retries: 0, steps: 0, canResume: false } });
  await store.persist();
  await store.persist();
  const second = await store.createNewSession();
  assert.equal(executionTimeView(second).totalMs, 0);
  second.messages.push({ id: 'u2', role: 'user', content: 'not started', createdAt: new Date().toISOString() });
  await store.selectSession(first.id);
  assert.equal(executionTimeView(store.getActiveSession()).totalMs, 12345);
  const restarted = new ChatSessionStore(storage, 'en', scope);
  await restarted.initialize();
  assert.equal(executionTimeView(restarted.getActiveSession()).totalMs, 12345);
  await restarted.selectSession(second.id);
  assert.equal(executionTimeView(restarted.getActiveSession()).totalMs, 0);
});

test('pure task views preserve execution selection and byte history and scoped commits only save their target', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-task-scope-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const scope = { key: 'task-scope', name: 'Tasks', folderUris: [] };
  const store = new ChatSessionStore(storage, 'en', scope); await store.initialize();
  const legacy = store.getActiveSession(); legacy.messages.push(createMessage(0)); await store.persist();
  const before = JSON.stringify(legacy), selected = store.activeSessionId;
  const worker = await store.createDetachedSession({ title: 'Worker A', approvalMode: 'delegate',
    contextInstructions: ' frozen\n context ', messages: Array.from({ length: 80 }, (_, i) => createMessage(i + 1)) });
  assert.equal(store.activeSessionId, selected);
  const page = await store.viewSessionPage(worker.id);
  assert.equal(page?.kind, 'session-view-page'); assert.equal(page?.messages.length, 30);
  assert.equal(page?.startIndex, 50); assert.equal(store.activeSessionId, selected);
  assert.equal(JSON.stringify(legacy), before);
  const workerScope = await store.createSessionScope(worker.id);
  assert.equal(workerScope.getActiveSession(), worker);
  await workerScope.initialize(); assert.equal(workerScope.getActiveSession(), worker);
  await assert.rejects(workerScope.selectSession(legacy.id), /cannot select/);
  await assert.rejects(workerScope.createFreshSession(), /cannot create/);
  const writes: string[][] = [];
  const save = storage.saveSessionChanges.bind(storage);
  storage.saveSessionChanges = async (workspace, state, preserve) => {
    writes.push(state.sessions.map(session => session.id)); await save(workspace, state, preserve);
  };
  worker.messages.push(createMessage(90)); await workerScope.persist('worker_evidence');
  assert.deepEqual(writes, [[worker.id]]);
  assert.equal(store.activeSessionId, selected);
  const reloaded = await new GlobalSessionStorage(vscode.Uri.file(root) as never).loadWorkspace(scope);
  assert.equal(reloaded.activeSessionId, selected);
  assert.equal(JSON.stringify(legacy), before);
  assert.equal((await storage.loadSession(scope.key, worker.id))?.messages.length, 81);
  workerScope.disposeSessionScope();
});

test('cold task page reads merge, remain bounded and never decode or save complete authority sessions', async () => {
  const scope = { key: 'view-pages', name: 'Views', folderUris: [] };
  const session = createSession('active', [createMessage(0)], scope);
  const storage = new MemorySessionStorage({ activeSessionId: session.id, sessions: [session] });
  let pages = 0, full = 0;
  const adapter: ChatSessionStorageAdapter = Object.assign(storage, {
    loadSession: async () => { full++; throw new Error('full history must not be loaded'); },
    loadSessionPage: async (_workspaceKey: string, sessionId: string) => {
      pages++; await new Promise(resolve => setTimeout(resolve, 5));
      return { kind: 'session-view-page' as const, sessionId, revision: 17, title: 'Other task',
        totalMessages: 8000, startIndex: 7970, messages: Array.from({ length: 30 }, (_, i) => createMessage(i)) };
    }
  });
  const store = new ChatSessionStore(adapter, 'en', scope); await store.initialize();
  const [a, b] = await Promise.all([store.viewSessionPage('other'), store.viewSessionPage('other')]);
  assert.equal(a, b); assert.equal(pages, 1); assert.equal(full, 0);
  assert.equal((await store.viewSessionPage('other'))?.revision, 17); assert.equal(pages, 1);
  assert.equal(store.activeSessionId, session.id); assert.equal(storage.saved, undefined);
});

test('display projections read only recent manifest bodies and cannot erase historical authority', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-task-page-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const scope = { key: 'disk-pages', name: 'Disk Pages', folderUris: [] };
  const session = createSession('paged-session', Array.from({ length: 140 }, (_, i) => createMessage(i)), scope);
  await storage.saveWorkspace(scope, { activeSessionId: session.id, sessions: [session] });
  const page = await storage.loadSessionPage(scope.key, session.id);
  assert.equal(page?.startIndex, 110); assert.equal(page?.messages.length, 30);
  assert.equal(page?.totalMessages, 140); assert.equal(page?.messages[0].id, 'm110');
  const earlier = await storage.loadSessionPage(scope.key, session.id, { before: 110, limit: 50 });
  assert.equal(earlier?.startIndex, 60); assert.equal(earlier?.messages.length, 50);
  assert.equal((await storage.loadSession(scope.key, session.id))?.messages.length, 140);
});

test('pinned empty task sessions survive compaction and idle eviction while read-only observers cannot mutate storage', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-task-pin-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { storage.setReadOnly(false); await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const scope = { key: 'task-pins', name: 'Pins', folderUris: [] };
  const store = new ChatSessionStore(storage, 'en', scope); await store.initialize(); await store.persist();
  const task = await store.createDetachedSession({ title: 'Queued task' });
  const release = store.pinSession(task.id, 'queued');
  store.evictIdleSessions(0); assert.equal(store.getSessionById(task.id), task);
  assert.equal((await storage.loadSession(scope.key, task.id))?.messages.length, 0);
  storage.setReadOnly(true); store.setReadOnly(true);
  assert.ok(await store.viewSessionPage(task.id));
  await assert.rejects(store.createDetachedSession(), /read-only/);
  await assert.rejects(store.createFreshSession(), /read-only/);
  await assert.rejects(storage.saveWorkspace(scope, { activeSessionId: task.id, sessions: [task] }), /read-only/);
  assert.equal(await storage.cleanupExpiredSessions({ currentWorkspaceKey: scope.key, currentActiveSessionId: task.id, force: true }), false);
  release(); store.evictIdleSessions(0); assert.equal(store.getSessionById(task.id), undefined);
});

test('canonical project storage scopes preserve legacy workspace sessions and resolve association ownership without copies', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-project-scope-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const alias = { key: 'workspace-alias-A', name: 'Alias A', folderUris: [] };
  const legacy = new ChatSessionStore(storage, 'en', alias); await legacy.initialize();
  const old = legacy.getActiveSession(); old.messages.push(createMessage(0)); await legacy.persist();
  const canonical = { key: 'project:physical-root-identity', name: 'Canonical Project', folderUris: [] };
  const tasks = await legacy.createWorkspaceScope(canonical);
  const task = await tasks.createDetachedSession({ title: 'Physical project task', messages: [createMessage(1)] });
  assert.equal(task.workspaceKey, canonical.key); assert.equal(old.workspaceKey, alias.key);
  assert.equal(legacy.activeSessionId, old.id);
  assert.deepEqual(await tasks.findSessionScope(old.id), alias);
  const observedScope = await tasks.createWorkspaceScope((await tasks.findSessionScope(old.id))!);
  assert.equal((await observedScope.loadSessionById(old.id))?.id, old.id);
  assert.equal((await storage.loadSession(alias.key, old.id))?.messages[0].id, 'm0');
  assert.equal((await storage.loadSession(canonical.key, task.id))?.messages[0].id, 'm1');
  await storage.saveWorkspace({ ...canonical, key: 'another-project' }, { activeSessionId: old.id,
    sessions: [{ ...old, workspaceKey: 'another-project' }] });
  await assert.rejects(storage.findSessionScope(old.id), /ambiguous/);
});

test('deep-history anchor views are bounded, preserve execution bytes, and keep latest-page navigation independent', async () => {
  const scope = { key: 'anchor-resident', name: 'Anchor', folderUris: [] };
  const source = createSession('anchor-session', Array.from({ length: 200 }, (_, i) => createMessage(i)), scope);
  const storage = new MemorySessionStorage({ activeSessionId: source.id, sessions: [source] });
  const store = new ChatSessionStore(storage, 'en', scope); await store.initialize();
  const before = JSON.stringify(store.getActiveSession());
  const middle = await store.viewSessionPageAtAnchor(source.id, 'm50');
  assert.equal(middle?.messages.length, 30); assert.equal(middle?.startIndex, 35);
  assert.equal(middle?.anchorFound, true); assert.equal(middle?.hasOlder, true); assert.equal(middle?.hasNewer, true);
  assert.ok(middle?.messages.some(message => message.id === 'm50'));
  const beginning = await store.viewSessionPageAtAnchor(source.id, 'm0');
  assert.equal(beginning?.startIndex, 0); assert.equal(beginning?.hasOlder, false); assert.equal(beginning?.hasNewer, true);
  const latest = await store.viewSessionPage(source.id);
  assert.equal(latest?.startIndex, 170); assert.equal(latest?.hasNewer, false);
  const missing = await store.viewSessionPageAtAnchor(source.id, 'deleted-message');
  assert.equal(missing?.anchorFound, false); assert.equal(missing?.startIndex, 170);
  assert.equal(JSON.stringify(store.getActiveSession()), before); assert.equal(storage.saved, undefined);
});

test('cold anchor views use the manifest message ID index and old manifests project IDs without decoding distant history', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-anchor-page-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const scope = { key: 'anchor-disk', name: 'Anchor Disk', folderUris: [] };
  const session = createSession('anchor-disk-session', Array.from({ length: 120 }, (_, i) => createMessage(i)), scope);
  await storage.saveWorkspace(scope, { activeSessionId: session.id, sessions: [session] });
  const sessionHash = createHash('sha256').update(session.id).digest('hex').slice(0, 32);
  const shard = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key), 'sessions', `${sessionHash}.json`);
  const manifest = JSON.parse(await readFile(shard, 'utf8')) as { messages: Array<{ body: string; messageId?: string }> };
  assert.equal(manifest.messages[50].messageId, 'm50');
  const excluded = new Set(manifest.messages.filter((_entry, index) => index < 35 || index >= 65).map(entry => `${entry.body}.json`));
  const originalRead = vscode.workspace.fs.readFile;
  vscode.workspace.fs.readFile = async uri => {
    if (uri.fsPath.includes('.objects') && excluded.has(path.basename(uri.fsPath))) throw new Error('Decoded history outside the anchored page');
    return originalRead(uri);
  };
  try {
    const page = await storage.loadSessionPage(scope.key, session.id, { anchorMessageId: 'm50' });
    assert.equal(page?.startIndex, 35); assert.equal(page?.messages.length, 30); assert.equal(page?.anchorFound, true);
    assert.equal(page?.hasOlder, true); assert.equal(page?.hasNewer, true);
  } finally { vscode.workspace.fs.readFile = originalRead; }
  // An older manifest can locate IDs without following an unrelated content
  // reference. A full authority load would have to validate that content.
  for (const entry of manifest.messages) delete entry.messageId;
  const distantNode = JSON.stringify({ kind: 'object', entries: [['id', 'm0'], ['content', { ref: 'f'.repeat(64) }]] });
  const distantHash = createHash('sha256').update(distantNode).digest('hex');
  await writeFile(path.join(`${shard}.objects`, `${distantHash}.json`), distantNode);
  manifest.messages[0].body = distantHash; await writeFile(shard, JSON.stringify(manifest));
  const page = await storage.loadSessionPage(scope.key, session.id, { anchorMessageId: 'm50' });
  assert.equal(page?.anchorFound, true); assert.equal(page?.startIndex, 35); assert.equal(page?.messages.length, 30);
  assert.equal(page?.messages.find(message => message.id === 'm50')?.content, 'message 50');
});

test('ordinary cold session reads coalesce while user metadata and selection bypass an obsolete background title read', async () => {
  const scope = { key: 'title-read-priority', name: 'Title read priority', folderUris: [] };
  const make = async () => {
    const active = createSession('active', [createMessage(0)], scope), historical = createSession('historical', [createMessage(1)], scope);
    const storage = new MemorySessionStorage({ activeSessionId: active.id, sessions: [active, historical] });
    const loadWorkspace = storage.loadWorkspace.bind(storage);
    storage.loadWorkspace = async workspace => {
      const state = await loadWorkspace(workspace);
      return { ...state, sessions: state.sessions.filter(session => session.id === active.id),
        sessionSummaries: state.sessions.map(session => ({ id: session.id, title: session.title, createdAt: session.createdAt,
          updatedAt: session.updatedAt, messageCount: session.messages.length, workspaceKey: scope.key,
          workspaceName: scope.name, workspaceFolders: [], isFavorite: false })) };
    };
    let ready!: () => void, release!: () => void, reads = 0;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const adapter: ChatSessionStorageAdapter = Object.assign(storage, { loadSession: async () => {
      if (++reads === 1) { ready(); await held; }
      return structuredClone(historical);
    } });
    const store = new ChatSessionStore(adapter, 'en', scope); await store.initialize();
    return { store, storage, started, release, reads: () => reads };
  };
  const ordinary = await make();
  const first = ordinary.store.loadSessionById('historical'); await ordinary.started;
  const second = ordinary.store.loadSessionById('historical');
  ordinary.release(); const [one, two] = await Promise.all([first, second]);
  assert.equal(ordinary.reads(), 1); assert.equal(one, two, 'ordinary same-target cold consumers still share the exact live object');

  const background = await make();
  let renamed: ChatSession | undefined;
  const title = background.store.withSessionForTitle('historical', async session => session);
  await background.started;
  const rename = background.store.renameSession('historical', 'Chosen by the user').then(session => { renamed = session; return session; });
  let beforeRelease: { reads: number; title?: string; active: string };
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    beforeRelease = { reads: background.reads(), title: renamed?.customTitle, active: background.store.activeSessionId };
  } finally { background.release(); }
  const [named, lateTitle] = await Promise.all([rename, title]);
  assert.deepEqual(beforeRelease!, { reads: 2, title: 'Chosen by the user', active: 'active' },
    'the user rename must finish without waiting for the obsolete title read');
  assert.equal(lateTitle, named, 'late background delivery reuses the renamed resident winner');
  assert.equal(background.store.getSessionById('historical')?.customTitle, 'Chosen by the user');
  assert.equal(background.storage.saved?.sessions.find(session => session.id === 'historical')?.customTitle, 'Chosen by the user');
});
