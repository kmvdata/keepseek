import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  ChatSessionStore,
  HISTORY_SESSION_LOAD_TIMEOUT_MS,
  getVisibleMessages,
  normalizeStoredSessions,
  type ChatSessionStorageAdapter,
  type StoredWorkspaceSessionState,
  type WorkspaceSessionScope
} from '../src/sessions/chatSessionStore';
import {
  CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION,
  CURRENT_PROVIDER_TOOL_SCHEMA_VERSION
} from '../src/agent/providerRequestProjection';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { createHistoryTruncationPlan } from '../src/sessions/historyTruncation';
import type { ChatMessage, ChatSession, WorkspaceSummary } from '../src/shared/types';
import * as vscode from './stubs/vscode';

for (const messages of [[], [{ ...createMessage(1), content: 'Local notice before any user submission' }]]) {
  test(`new session reuses an unused conversation with ${messages.length} local messages without saving`, async () => {
    const scope = { key: 'workspace:unused', name: 'Unused', folderUris: [] };
    const storage = new MemorySessionStorage({ activeSessionId: 'unused', sessions: [createSession('unused', messages, scope)] });
    const store = new ChatSessionStore(storage, 'en', scope);
    await store.initialize();
    const active = store.getActiveSession();
    active.executionMode = 'plan';
    active.activeSkillIds = ['selected-skill'];
    active.contextInstructions = 'Prepared context bytes\n';
    active.customTitle = active.title = 'Prepared task';
    // Saving settings must not promote a blank composer into history. A local
    // notice remains auditable, and neither case needs another save on New.
    await store.persist();
    const before = JSON.stringify(active);
    const summaries = store.getSessionSummaries();
    assert.equal(summaries.length, messages.length ? 1 : 0);
    assert.equal(storage.saved?.sessions.length, messages.length ? 1 : 0);
    storage.saveWorkspace = async () => { throw new Error('unexpected unused-session save'); };
    const onSaving = () => assert.fail('unused session must not start a save');

    assert.equal(store.hasUserMessages, false);
    const simultaneous = await Promise.all([store.createNewSession('en', onSaving), store.createNewSession('en', onSaving)]);
    for (const result of simultaneous) assert.equal(result, active);
    for (let click = 0; click < 3; click++) assert.equal(await store.createNewSession('en', onSaving), active);

    assert.equal(store.activeSessionId, active.id);
    assert.equal(JSON.stringify(active), before, 'reuse preserves title, modes, Skills, context and timestamps');
    assert.deepEqual(store.getSessionSummaries(), summaries);
  });
}

test('a submitted user instruction without a model reply is retained when creating one new blank', async () => {
  const scope = { key: 'workspace:submitted', name: 'Submitted', folderUris: [] };
  const user = { ...createMessage(0), content: '  Keep original user bytes\n', expandedContent: '  Expanded bytes\n' };
  const storage = new MemorySessionStorage({ activeSessionId: 'submitted', sessions: [createSession('submitted', [user], scope)] });
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const submitted = store.getActiveSession();
  const originalMessages = structuredClone(submitted.messages);
  assert.equal(store.hasUserMessages, true);
  let saves = 0;
  const blank = await store.createNewSession('en', () => { saves++; });
  assert.notEqual(blank.id, submitted.id);
  assert.deepEqual(blank.messages, []);
  assert.deepEqual(store.getSessionSummaries().map(summary => summary.id), [submitted.id]);
  assert.equal(storage.saved?.sessions.some(session => session.id === blank.id), false);
  assert.deepEqual(storage.saved?.sessions.find(session => session.id === submitted.id)?.messages, originalMessages);
  assert.equal(submitted.messages[0].content, user.content);
  assert.equal(submitted.messages[0].expandedContent, user.expandedContent);
  const saved = storage.saved;
  assert.equal(await store.createNewSession('en', () => { saves++; }), blank);
  assert.equal(saves, 1);
  assert.equal(storage.saved, saved, 'the next click on the unused blank performs no additional save');
});

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
    version: CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION, serializationStrategy: 'provider-projection-v2', toolSchemaVersion: CURRENT_PROVIDER_TOOL_SCHEMA_VERSION,
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

test('current persistence preserves the complete active history and frozen request metadata', async () => {
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
    version: CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION, serializationStrategy: 'provider-projection-v2', toolSchemaVersion: CURRENT_PROVIDER_TOOL_SCHEMA_VERSION,
    toolNames: ['keepseek_read_workspace_file_range'], sourceId: 'source-a', createdAt: '2026-01-01T00:00:00.000Z',
    lastProviderRequestAt: '2026-01-01T00:01:00.000Z'
  };
  session.contextCompression = {
    version: 1,
    protectedMessageIds: [],
    summaries: [{
      id: 'summary',
      content: 'summary content',
      coveredMessageIds: ['m1'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      tokenEstimate: 10,
      modelId: 'current-model',
      version: 1
    }]
  };
  const store = new ChatSessionStore(storage, 'en', workspaceScope);

  await store.initialize();
  await store.persist();

  assert.equal(store.messages.length, 100);
  assert.equal(store.getActiveSession().contextCompression?.summaries[0]?.modelId, 'current-model');
  assert.equal(store.getActiveSession().contextCompression?.summaries[0]?.sourceId, undefined);
  assert.equal(store.messages[0].id, 'm0');
  assert.equal(store.messages[99].id, 'm99');
  assert.equal(storage.saved?.sessions[0]?.messages.length, 100);
  assert.equal(storage.saved?.sessions[0]?.messages[0]?.id, 'm0');
  assert.deepEqual(storage.saved?.sessions[0]?.repairLoop?.pendingDraftEditIds, ['edit-1']);
  assert.equal(storage.saved?.sessions[0]?.historyArchive?.[0]?.content, 'complete archived result');
  assert.deepEqual(storage.saved?.sessions[0]?.requestProtocol?.toolNames, ['keepseek_read_workspace_file_range']);
  assert.equal(storage.saved?.sessions[0]?.requestProtocol?.sourceId, 'source-a');
  assert.equal(storage.saved?.sessions[0]?.requestProtocol?.version, CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION);
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

test('unsupported approval mode is rejected without broadening authorization', async () => {
  const scope = { key: 'legacy-mode', name: 'Legacy', folderUris: [] };
  const active = createSession('legacy-active', [createMessage(0)], scope);
  const originalMessages = active.messages.map(message => ({ content: message.content, expandedContent: message.expandedContent, providerContent: message.providerContent }));
  const storage = new MemorySessionStorage({ activeSessionId: active.id, approvalMode: 'model_review' as never, sessions: [active] });
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  assert.equal(store.approvalMode, 'ask');
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
  first.messages.push({ ...createMessage(0), content: 'An actual submitted task to copy across workspaces' });
  await first.persist();
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
    assert.equal(store.getSessionSummaries().length, 0, 'an unused target composer is not a history row');
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

test('cleanup replaces a deleted active session with a blank normal session without loading another body', async () => {
  const scope = { key: 'workspace:cleanup-current', name: 'Cleanup', folderUris: [] };
  const active = createSession('cleanup-current', [createMessage(0)], scope);
  const other = createSession('cleanup-preserved', [createMessage(1)], scope);
  active.executionMode = 'plan';
  other.contextInstructions = ' stable\n instructions ';
  other.messages[0].expandedContent = ' expanded\n bytes ';
  const storage = new MemorySessionStorage({ activeSessionId: active.id, sessions: [active, other], approvalMode: 'delegate' });
  const adapter: ChatSessionStorageAdapter = storage;
  adapter.isSessionDeleted = async (_workspaceKey, id) => id === active.id;
  let bodyReads = 0;
  adapter.loadSession = async () => { bodyReads += 1; throw new Error('cleanup must not hydrate'); };
  const store = new ChatSessionStore(adapter, 'en', scope);
  await store.initialize();
  const retained = store.getSessionById(other.id)!;
  const before = JSON.stringify([retained.messages, retained.contextInstructions, retained.requestProtocol]);
  const result = await store.forgetHistoryCleanup([active.id]);
  assert.deepEqual(result, { deletedCount: 1, activeSessionChanged: true });
  assert.notEqual(store.activeSessionId, active.id);
  assert.notEqual(store.activeSessionId, other.id);
  assert.equal(store.messages.length, 0);
  assert.equal(store.getActiveSession().executionMode, 'normal');
  assert.equal(store.getActiveSession().approvalMode, 'delegate');
  assert.equal(bodyReads, 0);
  assert.equal(JSON.stringify([retained.messages, retained.contextInstructions, retained.requestProtocol]), before);
  assert.equal(storage.saved?.activeSessionId, store.activeSessionId);
  assert.ok(!storage.saved?.sessions.some(session => session.id === active.id));
  assert.ok(!storage.saved?.sessions.some(session => session.id === store.activeSessionId));
  assert.deepEqual(store.getSessionSummaries().map(summary => summary.id), [other.id]);
});

test('deleting a current conversation replaces it with a transient blank and never adds empty history', async () => {
  const scope = { key: 'workspace:delete-current', name: 'Delete Current', folderUris: [] };
  const active = createSession('delete-current', [createMessage(0)], scope);
  const retained = createSession('delete-retained', [createMessage(2)], scope);
  const storage = new MemorySessionStorage({ activeSessionId: active.id, sessions: [active, retained] });
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();

  assert.deepEqual(await store.deleteSessions([active.id]), { deletedCount: 1, activeSessionChanged: true });
  const blank = store.getActiveSession();
  assert.notEqual(blank.id, active.id);
  assert.notEqual(blank.id, retained.id);
  assert.equal(blank.messages.length, 0);
  assert.deepEqual(store.getSessionSummaries().map(summary => summary.id), [retained.id]);
  assert.deepEqual(storage.saved?.sessions.map(session => session.id), [retained.id]);
  assert.equal(await store.createNewSession(), blank);

  // A direct deletion can target the resident blank even though it has no
  // history row. Replacing it must not silently select the retained history.
  assert.deepEqual(await store.deleteSessions([blank.id]), { deletedCount: 1, activeSessionChanged: true });
  assert.notEqual(store.activeSessionId, blank.id);
  assert.notEqual(store.activeSessionId, retained.id);
  assert.equal(store.messages.length, 0);
  assert.deepEqual(store.getSessionSummaries().map(summary => summary.id), [retained.id]);
  assert.deepEqual(storage.saved?.sessions.map(session => session.id), [retained.id]);
});

test('cleanup of another session preserves the viewed session identity and requires a committed deletion', async () => {
  const scope = { key: 'workspace:cleanup-other', name: 'Cleanup', folderUris: [] };
  const active = createSession('cleanup-viewed', [createMessage(0)], scope);
  const other = createSession('cleanup-other', [createMessage(1)], scope);
  const storage = new MemorySessionStorage({ activeSessionId: active.id, sessions: [active, other] });
  const adapter: ChatSessionStorageAdapter = storage;
  const deleted = new Set<string>();
  adapter.isSessionDeleted = async (_workspaceKey, id) => deleted.has(id);
  const store = new ChatSessionStore(adapter, 'en', scope);
  await store.initialize();
  await assert.rejects(store.forgetHistoryCleanup([other.id]), /history_cleanup_not_committed/);
  assert.ok(store.getSessionById(other.id));
  deleted.add(other.id);
  const viewed = store.getActiveSession();
  assert.deepEqual(await store.forgetHistoryCleanup([other.id]), { deletedCount: 1, activeSessionChanged: false });
  assert.equal(store.getActiveSession(), viewed);
  assert.equal(await store.selectSession(other.id), undefined);
  assert.equal(storage.saved, undefined, 'removing an unrelated ID must not rewrite survivor bodies');
});

test('confirmed cleanup settles an in-flight save before final target validation and does not start a new save', async () => {
  const scope = { key: 'workspace:cleanup-drain', name: 'Cleanup', folderUris: [] };
  const active = createSession('cleanup-drain', [createMessage(0)], scope);
  const storage = new MemorySessionStorage({ activeSessionId: active.id, sessions: [active] });
  let release!: () => void;
  let started!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { started = resolve; });
  const original = storage.saveWorkspace.bind(storage);
  let saves = 0;
  storage.saveWorkspace = async (workspace, state) => { saves += 1; started(); await barrier; await original(workspace, state); };
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const save = store.persist();
  await entered;
  let settled = false;
  const settling = store.settleHistoryCleanup([active.id]).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await Promise.all([save, settling]);
  assert.equal(saves, 1);
});

test('a large cleanup batch forgets non-active summaries without repeatedly saving survivor object graphs', async () => {
  const scope = { key: 'workspace:cleanup-batch', name: 'Cleanup', folderUris: [] };
  const active = createSession('cleanup-batch-viewed', [createMessage(0)], scope);
  const others = Array.from({ length: 120 }, (_, index) => createSession(`cleanup-batch-${index}`, [createMessage(index + 1)], scope));
  const storage = new MemorySessionStorage({ activeSessionId: active.id, sessions: [active, ...others] });
  const adapter: ChatSessionStorageAdapter = storage;
  adapter.isSessionDeleted = async (_workspaceKey, id) => id !== active.id;
  storage.saveWorkspace = async () => { throw new Error('unrelated survivors must not be rewritten'); };
  const store = new ChatSessionStore(adapter, 'en', scope);
  await store.initialize();
  const viewed = store.getActiveSession();
  for (const other of others) {
    assert.deepEqual(await store.forgetHistoryCleanup([other.id]), { deletedCount: 1, activeSessionChanged: false });
  }
  assert.equal(store.getActiveSession(), viewed);
  assert.deepEqual(store.getSessionSummaries().map(summary => summary.id), [active.id]);
});

test('execution admission refuses a deleted idle session and delegates use acquisition to the authority', async () => {
  const scope = { key: 'workspace:cleanup-admission', name: 'Cleanup', folderUris: [] };
  const active = createSession('cleanup-admission', [createMessage(0)], scope);
  const storage = new MemorySessionStorage({ activeSessionId: active.id, sessions: [active] });
  const adapter: ChatSessionStorageAdapter = storage;
  let deleted = true;
  adapter.assertSessionWritable = async (workspace, id) => {
    assert.equal(workspace, scope.key); assert.equal(id, active.id);
    if (deleted) throw new Error('session_deleted');
  };
  let acquired = 0;
  let released = 0;
  adapter.acquireSessionUse = async (workspace, id) => {
    await adapter.assertSessionWritable!(workspace, id);
    acquired += 1;
    return { release: async () => { released += 1; } };
  };
  const store = new ChatSessionStore(adapter, 'en', scope);
  await store.initialize();
  await assert.rejects(store.assertSessionWritable(), /session_deleted/);
  await assert.rejects(store.acquireSessionUse(), /session_deleted/);
  deleted = false;
  const use = await store.acquireSessionUse();
  assert.equal(acquired, 1);
  await use.release();
  assert.equal(released, 1);
});

test('loading a corrupt history truncation journal fails closed instead of dropping its pending recovery boundary', () => {
  const scope = { key: 'workspace:corrupt-truncation', name: 'Corrupt', folderUris: [] };
  const source = createSession('corrupt-source', [createMessage(0)], scope);
  assert.throws(() => normalizeStoredSessions({ sessions: [{ ...source, pendingHistoryTruncation: null }] }, scope), /journal/);
  assert.throws(() => normalizeStoredSessions({ sessions: [{ ...source,
    pendingHistoryTruncation: { version: 1, sessionId: 'another-session' } }] }, scope), /journal scope/);
});

for (const blockedStage of ['deletion-check', 'session-body'] as const) {
  test(`bounded selection times out during ${blockedStage} without caching or committing a late body`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { store, storage, adapter, active, target } = await boundedSelectionFixture();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    adapter.isSessionDeleted = async () => {
      if (blockedStage === 'deletion-check') { entered(); await gate; }
      return false;
    };
    adapter.loadSession = async (_workspaceKey, _sessionId, options) => {
      assert.equal(options?.readOnly, true, 'bounded reads must not reconcile or rewrite storage');
      if (blockedStage === 'session-body') { entered(); await gate; }
      return target;
    };
    let saving = 0;
    const pending = store.selectSessionBounded(target.id, { timeoutMs: 20, onSaving: () => { saving += 1; } });
    await started;
    t.mock.timers.tick(20);
    assert.deepEqual(await pending, { status: 'timeout' });
    assert.equal(store.activeSessionId, active.id);
    assert.equal(store.getSessionById(target.id), undefined);
    assert.equal(saving, 0);
    assert.equal(storage.saved, undefined);

    release();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(store.activeSessionId, active.id);
    assert.equal(store.getSessionById(target.id), undefined, 'late reads must not enter the resident session set');
    assert.equal(saving, 0);
    assert.equal(storage.saved, undefined);
    await store.persist();
    const saved = storage.saved as StoredWorkspaceSessionState | undefined;
    assert.equal(saved?.activeSessionId, active.id);
    assert.equal(saved?.sessions.some(session => session.id === target.id), false);
  });
}

test('legacy selection uses the same default bounded read and retains its undefined timeout result', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, adapter, active, target } = await boundedSelectionFixture();
  adapter.isSessionDeleted = async () => new Promise<boolean>(() => {});
  const pending = store.selectSession(target.id);
  t.mock.timers.tick(HISTORY_SESSION_LOAD_TIMEOUT_MS);
  assert.equal(await pending, undefined);
  assert.equal(store.activeSessionId, active.id);
});

test('bounded selection and legacy wrapper preserve the same fields, mode normalization and save ordering', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  for (const executionMode of ['plan', 'invalid'] as const) {
    const bounded = await boundedSelectionFixture();
    const legacy = await boundedSelectionFixture();
    for (const fixture of [bounded, legacy]) {
      fixture.target.approvalMode = 'ask';
      fixture.target.executionMode = executionMode as ChatSession['executionMode'];
      await fixture.store.setApprovalMode('delegate');
    }
    const before = new Date().toISOString();
    const saving: string[] = [];
    const result = await bounded.store.selectSessionBounded(bounded.target.id, { onSaving: id => {
      assert.equal(bounded.store.activeSessionId, id);
      assert.equal(bounded.store.getActiveSession().updatedAt, before);
      saving.push(id);
    } });
    const legacyResult = await legacy.store.selectSession(legacy.target.id);
    assert.equal(result.status, 'selected');
    assert.equal(legacyResult?.updatedAt, before);
    if (result.status !== 'selected') throw new Error('expected selected session');
    assert.deepEqual(result.session, legacyResult);
    assert.equal(result.session.approvalMode, 'delegate');
    assert.equal(result.session.executionMode, executionMode === 'plan' ? 'plan' : 'normal');
    assert.deepEqual(saving, [bounded.target.id]);
    assert.equal(bounded.storage.saved?.activeSessionId, bounded.target.id);
  }
});

test('a selected body commits through the persistence barrier even after the read deadline passes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { store, storage, target } = await boundedSelectionFixture();
  const originalSave = storage.saveWorkspace.bind(storage);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  storage.saveWorkspace = async (scope, state) => { entered(); await gate; await originalSave(scope, state); };
  let completed = false;
  const pending = store.selectSessionBounded(target.id, { timeoutMs: 20 }).then(result => { completed = true; return result; });
  await started;
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(completed, false);
  assert.equal(store.activeSessionId, target.id);
  release();
  assert.equal((await pending).status, 'selected');
  assert.equal(storage.saved?.activeSessionId, target.id);
});

test('bounded selection returns missing without saving and rethrows original deletion/body I/O errors', async () => {
  const { store, storage, adapter, active, target } = await boundedSelectionFixture();
  assert.deepEqual(await store.selectSessionBounded('missing'), { status: 'missing' });
  assert.equal(storage.saved, undefined);
  const failure = new Error('original storage failure');
  adapter.isSessionDeleted = async () => { throw failure; };
  await assert.rejects(store.selectSessionBounded(target.id), error => error === failure);
  adapter.isSessionDeleted = async () => false;
  adapter.loadSession = async () => { throw failure; };
  await assert.rejects(store.selectSessionBounded(target.id), error => error === failure);
  assert.equal(store.activeSessionId, active.id);
  assert.equal(store.getSessionById(target.id), undefined);
  assert.equal(storage.saved, undefined);
});

async function boundedSelectionFixture() {
  const scope = { key: 'workspace:bounded-selection', name: 'Bounded Selection', folderUris: [] };
  const active = createSession('bounded-active', [createMessage(0)], scope);
  const target = createSession('bounded-target', [createMessage(1)], scope);
  const storage = new MemorySessionStorage({ activeSessionId: active.id, sessions: [active] });
  storage.loadWorkspace = async () => ({ activeSessionId: active.id, sessions: [active],
    sessionSummaries: [active, target].map(session => ({
      id: session.id, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt,
      workspaceKey: scope.key, workspaceName: scope.name, messageCount: session.messages.length, isFavorite: false
    })) });
  const adapter: ChatSessionStorageAdapter = storage;
  adapter.loadSession = async () => target;
  const store = new ChatSessionStore(adapter, 'en', scope);
  await store.initialize();
  return { store, storage, adapter, active, target };
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
