import { buildProviderRequestProjection } from '../src/agent/providerRequestProjection';
import { getConfiguredAgentSettings } from '../src/shared/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatSessionStore, createEmptySession, normalizeStoredSessions,
  type ChatSessionStorageAdapter, type StoredWorkspaceSessionState } from '../src/sessions/chatSessionStore';
import { SessionTitleCoordinator } from '../src/sessions/sessionTitleCoordinator';
import { buildSessionTitleMaterial } from '../src/sessions/sessionTitle';
import { createHistoryTruncationPlan, executeHistoryTruncation } from '../src/sessions/historyTruncation';
import type { ChatMessage, ChatSession } from '../src/shared/types';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import * as vscode from './stubs/vscode';

const scope = { key: 'workspace:title', name: 'Title', folderUris: [] };
function pair(taskId: string, prompt = '分析 KeepSeek 审批失败原因'): ChatMessage[] {
  const userTask = { version: 1 as const, id: taskId, originMessageId: taskId, reason: 'user' as const };
  return [
    { id: taskId, role: 'user', content: prompt, createdAt: new Date(0).toISOString(), userTask },
    { id: `${taskId}-answer`, role: 'assistant', content: '需要检查审批的执行边界。', createdAt: new Date(1).toISOString(), userTask }
  ];
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
class MemoryStorage implements ChatSessionStorageAdapter {
  public writes = 0;
  public beforeSave?: (state: StoredWorkspaceSessionState) => Promise<void> | void;
  public afterSave?: (state: StoredWorkspaceSessionState) => void;
  public constructor(public state: StoredWorkspaceSessionState) {}
  async loadWorkspace() { return structuredClone(this.state); }
  async saveWorkspace(_scope: unknown, state: StoredWorkspaceSessionState) {
    this.writes += 1;
    await this.beforeSave?.(state);
    this.state = structuredClone(state);
    this.afterSave?.(this.state);
  }
  async listAllWorkspaceSummaries() { return []; }
  async loadWorkspaceSessions() { return structuredClone(this.state.sessions); }
  async deleteWorkspaceSessions(_workspace: string, ids: string[]) {
    this.state.sessions = this.state.sessions.filter(session => !ids.includes(session.id));
  }
  async deleteEntireWorkspace() { this.state.sessions = []; }
  async cleanupExpiredSessions() { return false; }
}
async function fixture(messages = pair('turn-1')) {
  const initial = createEmptySession('en', scope);
  initial.title = 'Temporary title';
  initial.messages = messages;
  const storage = new MemoryStorage({ activeSessionId: initial.id, sessions: [initial] });
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  return { store, storage, session: store.getActiveSession(), coordinator: new SessionTitleCoordinator(store) };
}
const set = JSON.stringify({ decision: 'set', title: '审批失败排查' });

test('automatic title commits once to session and history without changing messages or activity time', async () => {
  const { store, storage, session, coordinator } = await fixture();
  const before = JSON.stringify(session.messages);
  const activity = session.updatedAt;
  let requests = 0;
  assert.equal(await coordinator.complete(session.id, 'turn-1', async () => { requests++; return set; }), true);
  assert.equal(await coordinator.complete(session.id, 'turn-1', async () => { requests++; return set; }), false);
  assert.equal(session.title, '审批失败排查');
  assert.equal(store.getSessionSummaries()[0].title, session.title);
  assert.equal(storage.state.sessions[0].autoTitle?.status, 'completed');
  assert.equal(session.updatedAt, activity);
  assert.equal(JSON.stringify(session.messages), before);
  const restart = new ChatSessionStore(storage, 'en', scope);
  await restart.initialize();
  assert.equal(await new SessionTitleCoordinator(restart).complete(session.id, 'turn-1', async () => { requests++; return set; }), false);
  assert.equal(requests, 1);
});

test('defer and invalid responses consume only their turn and later material includes new context', async () => {
  const { store, session, coordinator } = await fixture(pair('turn-1', '你好'));
  let calls = 0;
  for (let turn = 1; turn <= 4; turn++) {
    if (turn > 1) { coordinator.cancel(session.id); session.messages.push(...pair(`turn-${turn}`, turn === 4 ? '修复编辑重发的旧操作记录' : '我想做个功能')); await store.persist(); }
    await coordinator.complete(session.id, `turn-${turn}`, async input => {
      calls++;
      if (turn === 4) { assert.match(input.userPrompt, /修复编辑重发/); return set; }
      return turn === 2 ? 'invalid JSON' : '{"decision":"defer","title":null}';
    });
    await coordinator.complete(session.id, `turn-${turn}`, async () => { throw new Error('duplicate request'); });
    if (turn < 4) assert.equal(session.title, 'Temporary title');
  }
  assert.equal(calls, 4);
  assert.equal(session.autoTitle?.status, 'completed');
});

test('same-text manual rename invalidates an in-flight response', async () => {
  const { store, session, coordinator } = await fixture();
  const response = deferred<string>();
  const started = deferred<void>();
  const pending = coordinator.complete(session.id, 'turn-1', async () => { started.resolve(); return response.promise; });
  await started.promise;
  const revision = session.autoTitle!.revision;
  await store.renameSession(session.id, session.title);
  response.resolve(set);
  assert.equal(await pending, false);
  assert.equal(session.title, 'Temporary title');
  assert.equal(session.customTitle, session.title);
  assert.ok(session.autoTitle!.revision > revision);
});

test('switching sessions keeps the result scoped; deleting a session cannot resurrect it', async () => {
  const { store, session, coordinator } = await fixture();
  const response = deferred<string>();
  const started = deferred<void>();
  const pending = coordinator.complete(session.id, 'turn-1', async () => { started.resolve(); return response.promise; });
  await started.promise;
  const other = await store.createNewSession();
  response.resolve(set);
  assert.equal(await pending, true);
  assert.equal(store.activeSessionId, other.id);
  assert.notEqual(other.title, '审批失败排查');

  const deleted = await fixture();
  const late = deferred<string>();
  const called = deferred<void>();
  const work = deleted.coordinator.complete(deleted.session.id, 'turn-1', async () => { called.resolve(); return late.promise; });
  await called.promise;
  await deleted.store.deleteSessions([deleted.session.id]);
  late.resolve(set);
  assert.equal(await work, false);
  assert.equal(deleted.store.getSessionById(deleted.session.id), undefined);
});

test('a new logical turn cancels the old attempt and stale callbacks cannot replace new state', async () => {
  const { store, session, coordinator } = await fixture();
  const oldResponse = deferred<string>();
  const called = deferred<void>();
  const old = coordinator.complete(session.id, 'turn-1', async () => { called.resolve(); return oldResponse.promise; });
  await called.promise;
  coordinator.cancel(session.id);
  session.messages.push(...pair('turn-2', '分析编辑重发'));
  await store.persist();
  assert.equal(await coordinator.complete(session.id, 'turn-2', async () => '{"decision":"set","title":"编辑重发分析"}'), true);
  oldResponse.resolve(set);
  assert.equal(await old, false);
  assert.equal(session.title, '编辑重发分析');
});

test('running restart preserves consumed turn and never replays a crashed request', async () => {
  const { store, storage, session } = await fixture();
  const material = buildSessionTitleMaterial(session.messages, 'turn-1')!;
  assert.ok(await store.claimSessionTitle(session.id, 'turn-1', material.basis));
  const restart = new ChatSessionStore(storage, 'en', scope);
  await restart.initialize();
  assert.equal(restart.getActiveSession().autoTitle?.status, 'pending');
  assert.equal(restart.getActiveSession().autoTitle?.lastAttemptTaskId, 'turn-1');
  let requests = 0;
  await new SessionTitleCoordinator(restart).complete(session.id, 'turn-1', async () => { requests++; return set; });
  assert.equal(requests, 0);
});

test('candidate is invisible until durable save; a bounded save retry uses one model request', async () => {
  const { store, storage, session, coordinator } = await fixture();
  const saving = deferred<void>();
  const release = deferred<void>();
  let candidateWrites = 0;
  storage.beforeSave = async state => {
    if (state.sessions[0].autoTitle?.status !== 'completed') return;
    candidateWrites++;
    assert.equal(session.title, 'Temporary title');
    assert.equal(store.getSessionSummaries()[0].title, 'Temporary title');
    if (candidateWrites === 1) { saving.resolve(); await release.promise; throw new Error('disk unavailable'); }
  };
  let requests = 0;
  const pending = coordinator.complete(session.id, 'turn-1', async () => { requests++; return set; });
  await saving.promise;
  assert.equal(session.autoTitle?.status, 'running');
  release.resolve();
  assert.equal(await pending, true);
  assert.equal(requests, 1);
  assert.equal(candidateWrites, 2);
});

test('permanent title save failure has no in-memory or index success and no model retry', async () => {
  const { store, storage, session, coordinator } = await fixture();
  let requests = 0;
  storage.beforeSave = state => { if (state.sessions[0].autoTitle?.status === 'completed') throw new Error('disk unavailable'); };
  assert.equal(await coordinator.complete(session.id, 'turn-1', async () => { requests++; return set; }), false);
  assert.equal(requests, 1);
  assert.equal(session.title, 'Temporary title');
  assert.equal(store.getSessionSummaries()[0].title, 'Temporary title');
  assert.equal(session.autoTitle?.status, 'pending');
  assert.notEqual(storage.state.sessions[0].autoTitle?.status, 'completed');
});

test('invalidation during candidate save queues a durable correction without another user save', async () => {
  const { store, storage, session, coordinator } = await fixture();
  const started = deferred<void>(), release = deferred<void>();
  const corrected = deferred<void>();
  storage.afterSave = state => {
    if (state.sessions[0].autoTitle?.lastOutcome === 'stale') corrected.resolve();
  };
  storage.beforeSave = async state => {
    if (state.sessions[0].autoTitle?.status === 'completed') { started.resolve(); await release.promise; }
  };
  const pending = coordinator.complete(session.id, 'turn-1', async () => set);
  await started.promise;
  coordinator.cancel(session.id);
  release.resolve();
  assert.equal(await pending, false);
  await corrected.promise;
  assert.equal(session.title, 'Temporary title');
  assert.equal(storage.state.sessions[0].title, 'Temporary title');
  assert.equal(storage.state.sessions[0].autoTitle?.status, 'pending');
});

test('deletion waits for an active candidate write before removing the shard', async () => {
  const { store, storage, session, coordinator } = await fixture();
  const started = deferred<void>(), release = deferred<void>();
  storage.beforeSave = async state => {
    if (state.sessions.find(item => item.id === session.id)?.autoTitle?.status === 'completed') { started.resolve(); await release.promise; }
  };
  const pending = coordinator.complete(session.id, 'turn-1', async () => set);
  await started.promise;
  const deletion = store.deleteSessions([session.id]);
  release.resolve();
  await deletion;
  assert.equal(await pending, false);
  assert.equal(store.getSessionById(session.id), undefined);
  assert.ok(!storage.state.sessions.some(item => item.id === session.id));
});

test('manual rename during candidate persistence wins in live state and after reload', async () => {
  const { store, storage, session, coordinator } = await fixture();
  const started = deferred<void>(), release = deferred<void>();
  storage.beforeSave = async state => {
    if (state.sessions[0].autoTitle?.status === 'completed') { started.resolve(); await release.promise; }
  };
  const pending = coordinator.complete(session.id, 'turn-1', async () => set);
  await started.promise;
  const rename = store.renameSession(session.id, 'Manual');
  // Let rename's asynchronous lookup acquire the current live object.
  await Promise.resolve();
  release.resolve();
  await rename;
  assert.equal(await pending, false);
  assert.equal(session.title, 'Manual');
  const restart = new ChatSessionStore(storage, 'en', scope);
  await restart.initialize();
  assert.equal(restart.getActiveSession().customTitle, 'Manual');
});

test('history truncation preserves retained title basis and resets removed basis within existing transaction', async () => {
  const { store, session, coordinator } = await fixture();
  await coordinator.complete(session.id, 'turn-1', async () => set);
  session.messages.push(...pair('turn-2', '无关后续问题'));
  const preserved = createHistoryTruncationPlan(session, 'turn-2', pair('replacement-2')[0])!;
  await executeHistoryTruncation(session, preserved, { persistSession: () => store.persist(), invalidateOperations: async () => {} });
  assert.equal(session.autoTitle?.status, 'completed');
  assert.equal(session.title, '审批失败排查');
  const changed = createHistoryTruncationPlan(session, 'turn-1', pair('replacement-1', '编辑后的新主题')[0])!;
  await executeHistoryTruncation(session, changed, { persistSession: () => store.persist(), invalidateOperations: async () => {} });
  assert.equal(session.autoTitle?.status, 'pending');
  assert.equal(session.title, '编辑后的新主题');
  assert.equal(session.messages[0].id, 'replacement-1');
});

test('old sessions normalize to pending and manual title remains locked with damaged metadata', () => {
  const initial = createEmptySession('en', scope);
  delete initial.autoTitle;
  initial.title = 'Old title';
  const pending = normalizeStoredSessions({ sessions: [initial] }, scope)[0];
  assert.equal(pending.title, 'Old title');
  assert.equal(pending.autoTitle?.status, 'pending');
  const locked = normalizeStoredSessions({ sessions: [{ ...initial, customTitle: 'Manual',
    autoTitle: { version: 999, status: 'completed' } }] }, scope)[0];
  assert.equal(locked.title, 'Manual');
  assert.equal(locked.autoTitle?.lastOutcome, 'manual');
});

test('copy retains completed display with remapped title evidence and no attempt token', async () => {
  const { storage, session, coordinator } = await fixture();
  await coordinator.complete(session.id, 'turn-1', async () => set);
  const anotherScope = { ...scope, key: 'workspace:copy' };
  const copyStorage = new MemoryStorage({ activeSessionId: '', sessions: [] });
  copyStorage.loadWorkspaceSessions = async () => structuredClone(storage.state.sessions) as ChatSession[];
  const destination = new ChatSessionStore(copyStorage, 'en', anotherScope);
  await destination.initialize();
  const copy = await destination.copyOtherWorkspaceSession(scope.key, session.id);
  assert.ok(copy);
  assert.equal(copy.title, session.title);
  assert.equal(copy.autoTitle?.status, 'completed');
  assert.equal(copy.autoTitle?.attempt, undefined);
  assert.ok(copy.autoTitle?.completed?.basis.messages.every(ref => copy.messages.some(message => message.id === ref.id)));
});

for (const originalTitle of ['Temporary title', '审批失败排查']) {
  test(`failed real index commit rejects persisted title shard even when title ${originalTitle === '审批失败排查' ? 'text matches' : 'changes'}`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'keepseek-title-index-failure-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const uri = vscode.Uri.file(root) as never;
    const storage = new GlobalSessionStorage(uri);
    const store = new ChatSessionStore(storage, 'en', scope);
    await store.initialize();
    const session = store.getActiveSession();
    session.title = originalTitle;
    session.messages = pair('turn-1');
    await store.persist();
    const originalRename = vscode.workspace.fs.rename;
    let rejectedIndexes = 0, requests = 0;
    vscode.workspace.fs.rename = async (...args) => {
      if (args[1].fsPath.endsWith('/index.json')) {
        const candidate = JSON.parse(await readFile(args[0].fsPath, 'utf8'));
        if (candidate.sessions.some((entry: { autoTitleCommit?: string }) => entry.autoTitleCommit)) {
          rejectedIndexes++;
          throw Object.assign(new Error('fixture index commit rejected'), { code: 'EACCES' });
        }
      }
      return originalRename(...args);
    };
    try {
      assert.equal(await new SessionTitleCoordinator(store).complete(session.id, 'turn-1', async () => { requests++; return set; }), false);
    } finally { vscode.workspace.fs.rename = originalRename; }
    assert.equal(requests, 1);
    assert.equal(rejectedIndexes, 2);
    assert.equal(session.title, originalTitle);
    assert.equal(session.autoTitle?.status, 'pending');
    assert.equal((await storage.listWorkspaceSessionSummaries(scope.key))[0].title, originalTitle);
    const restart = new ChatSessionStore(new GlobalSessionStorage(uri), 'en', scope);
    await restart.initialize();
    const recovered = restart.getActiveSession();
    assert.equal(recovered.title, originalTitle);
    assert.equal(recovered.autoTitle?.status, 'pending');
    assert.equal(recovered.autoTitle?.lastOutcome, 'save_failed');
    assert.equal(recovered.autoTitle?.lastAttemptTaskId, 'turn-1');
    const coordinator = new SessionTitleCoordinator(restart);
    assert.equal(await coordinator.complete(session.id, 'turn-1', async () => { requests++; return set; }), false);
    recovered.messages.push(...pair('turn-2'));
    await restart.persist();
    assert.equal(await coordinator.complete(session.id, 'turn-2', async () => { requests++; return set; }), true);
    const confirmed = new ChatSessionStore(new GlobalSessionStorage(uri), 'en', scope);
    await confirmed.initialize();
    assert.equal(confirmed.getActiveSession().autoTitle?.status, 'completed');
    assert.equal(requests, 2);
  });
}

test('saving only loaded B preserves the committed title marker of unloaded A', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-title-index-preserve-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uri = vscode.Uri.file(root) as never;
  const storage = new GlobalSessionStorage(uri);
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const a = store.getActiveSession();
  a.messages = pair('turn-a');
  await store.persist();
  assert.equal(await new SessionTitleCoordinator(store).complete(a.id, 'turn-a', async () => set), true);
  const b = await store.createNewSession();
  b.messages = pair('turn-b');
  await store.persist();
  const restart = new ChatSessionStore(new GlobalSessionStorage(uri), 'en', scope);
  await restart.initialize();
  assert.equal(restart.activeSessionId, b.id);
  assert.equal(restart.getSessionById(a.id), undefined);
  await restart.persist();
  const restoredA = await new GlobalSessionStorage(uri).loadSession(scope.key, a.id);
  assert.equal(restoredA?.autoTitle?.status, 'completed');
  assert.equal(restoredA?.title, '审批失败排查');
});

test('orphan index reconciliation cannot promote an unconfirmed completed shard', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-title-orphan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uri = vscode.Uri.file(root) as never;
  const storage = new GlobalSessionStorage(uri);
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const session = store.getActiveSession();
  session.messages = pair('turn-orphan');
  await store.persist();
  assert.equal(await new SessionTitleCoordinator(store).complete(session.id, 'turn-orphan', async () => set), true);
  const indexPath = join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key), 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.sessions = [];
  index.activeSessionId = '';
  await writeFile(indexPath, JSON.stringify(index));
  const recovered = await new GlobalSessionStorage(uri).loadWorkspace(scope);
  assert.equal(recovered.sessions[0].autoTitle?.status, 'pending');
  assert.equal(recovered.sessions[0].autoTitle?.lastOutcome, 'save_failed');
  assert.equal(recovered.sessionSummaries?.[0].title, '分析 KeepSeek 审批失败原因');
});

test('workspace lifecycle rejection retires a late title without committing it', async () => {
  const { store, session } = await fixture();
  let trusted = true;
  const response = deferred<string>();
  const dispatched = deferred<void>();
  const coordinator = new SessionTitleCoordinator(store, { canCommit: () => trusted });
  const pending = coordinator.complete(session.id, 'turn-1', async () => {
    dispatched.resolve(); return response.promise;
  });
  await dispatched.promise;
  trusted = false;
  response.resolve(set);
  assert.equal(await pending, false);
  assert.equal(session.title, 'Temporary title');
  assert.equal(session.autoTitle?.status, 'pending');
  assert.equal(session.autoTitle?.lastAttemptTaskId, 'turn-1');
});


test('a committed title preserves exact main request projections and native replay bytes in all three protocols', async () => {
  for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as const) {
    const { store, session, coordinator } = await fixture();
    session.contextInstructions = 'Stable project context\n  exact whitespace';
    const answer = session.messages[1];
    if (provider === 'openai-responses') answer.providerReplay = {
      protocol: 'openai-responses', sourceId: 'source', baseUrl: 'https://fixture.invalid/v1',
      items: [{ type: 'reasoning', encrypted_content: 'opaque-native-bytes' }]
    };
    else if (provider === 'anthropic-compatible') answer.providerReplay = {
      protocol: 'anthropic-messages', sourceId: 'source', baseUrl: 'https://fixture.invalid/v1',
      messages: [{ role: 'assistant', content: [
        { type: 'thinking', thinking: 'private reasoning', signature: 'native-signature' },
        { type: 'text', text: answer.content }
      ] }]
    };
    else answer.toolRounds = [{ assistantContent: null, reasoningContent: null,
      toolCalls: [{ id: 'read', type: 'function', function: {
        name: 'keepseek_read_workspace_file_range', arguments: '{"path":"a.ts","startLine":1,"endLine":2}'
      } }], toolResults: [{ toolCallId: 'read', content: '{"content":"  exact tool bytes\\n"}' }]
    }];
    await store.persist();
    const request = () => JSON.stringify(buildProviderRequestProjection({
      model: { id: 'test-model', label: 'Test', sourceId: 'source', provider },
      agentSettings: getConfiguredAgentSettings(), contextFiles: [], contextInstructions: session.contextInstructions,
      history: session.messages, language: 'en', prompt: 'Continue explanation',
      slimToolNames: ['keepseek_read_workspace_file_range'], requestProtocolVersion: 15,
      provider, sourceId: 'source', baseUrl: 'https://fixture.invalid/v1'
    }));
    const before = request();
    const history = JSON.stringify([session.messages, session.contextInstructions, session.requestProtocol]);
    assert.equal(await coordinator.complete(session.id, 'turn-1', async () => set), true);
    assert.equal(request(), before, provider);
    assert.equal(JSON.stringify([session.messages, session.contextInstructions, session.requestProtocol]), history, provider);
    assert.equal(before.includes('autoTitle'), false);
    assert.equal(session.autoTitle?.status, 'completed');
  }
});
