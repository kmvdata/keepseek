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
import { OneShotTextRequestError } from '../src/agent/oneShotTextRequest';
import { buildSessionTitleMaterial, buildSessionTitleRegenerationMaterial } from '../src/sessions/sessionTitle';
import { createHistoryTruncationPlan, executeHistoryTruncation } from '../src/sessions/historyTruncation';
import type { ChatMessage, ChatSession } from '../src/shared/types';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import * as vscode from './stubs/vscode';

const scope = { key: 'workspace:title', name: 'Title', folderUris: [] };

async function removeStorageRoot(root: string): Promise<void> {
  // Reconciliation can defer a derived manifest write. Drain that real storage
  // barrier before removing the temporary tree, rather than racing its timer.
  await new GlobalSessionStorage(vscode.Uri.file(root) as never).flush();
  await rm(root, { recursive: true, force: true });
}
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

test('explicit title results distinguish committed same title, no topic and invalid output', async () => {
  const { session, coordinator } = await fixture();
  const material = buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!;
  assert.deepEqual(await coordinator.regenerateResult(session.id, 'turn-1', async () => set, material), { outcome: 'updated' });
  assert.deepEqual(await coordinator.regenerateResult(session.id, 'turn-1', async () => set, material), { outcome: 'unchanged' });
  assert.deepEqual(await coordinator.regenerateResult(session.id, 'turn-1', async () => '{"decision":"defer","title":null}', material), { outcome: 'no_material' });
  assert.deepEqual(await coordinator.regenerateResult(session.id, 'turn-1', async () => 'bad output', material), { outcome: 'invalid' });
  assert.equal(session.title, '审批失败排查');
});

test('manual outcome waits for the actual commit barrier and never reports a failed claim as provider success', async () => {
  const { session, coordinator, storage } = await fixture();
  const material = buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!;
  const started = deferred<void>(), release = deferred<void>();
  storage.beforeSave = async state => {
    if (state.sessions[0].title === '审批失败排查') { started.resolve(); await release.promise; }
  };
  let settled = false;
  const pending = coordinator.regenerateResult(session.id, 'turn-1', async () => set, material).then(result => { settled = true; return result; });
  await started.promise;
  assert.equal(settled, false);
  assert.equal(session.title, 'Temporary title');
  release.resolve();
  assert.deepEqual(await pending, { outcome: 'updated' });
  storage.beforeSave = () => { throw new Error('private disk failure'); };
  let calls = 0;
  assert.deepEqual(await coordinator.regenerateResult(session.id, 'turn-1', async () => { calls++; return set; }, material), { outcome: 'save_failed' });
  assert.equal(calls, 0);
  assert.equal(session.title, '审批失败排查');
});

for (const reason of ['timeout', 'unavailable', 'cancelled', 'invalid'] as const) {
  test(`explicit title request exposes safe ${reason} result and preserves the previous title`, async () => {
    const { session, coordinator } = await fixture();
    const result = await coordinator.regenerateResult(session.id, 'turn-1', async () => {
      throw new OneShotTextRequestError(reason, 'secret provider response that must not reach the UI');
    }, buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!);
    assert.deepEqual(result, { outcome: reason });
    assert.equal(session.title, 'Temporary title');
    assert.equal(session.autoTitle?.manualAttempt, undefined);
  });
}

test('manual request slots distinguish duplicate busy and late cancelled responses', async () => {
  const { session, coordinator } = await fixture();
  const material = buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!;
  const started = deferred<void>(), release = deferred<string>();
  const first = coordinator.regenerateResult(session.id, 'turn-1', async () => { started.resolve(); return release.promise; }, material);
  await started.promise;
  assert.deepEqual(await coordinator.regenerateResult(session.id, 'turn-1', async () => { throw new Error('duplicate dispatch'); }, material), { outcome: 'busy' });
  coordinator.cancel(session.id);
  release.resolve(set);
  assert.deepEqual(await first, { outcome: 'cancelled' });
  assert.equal(session.title, 'Temporary title');
});

test('a durable title survives notification failure without reissuing the model request', async () => {
  const { store, session, storage } = await fixture();
  const coordinator = new SessionTitleCoordinator(store, { onCommitted: () => { throw new Error('webview gone'); } });
  assert.deepEqual(await coordinator.regenerateResult(session.id, 'turn-1', async () => set,
    buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!), { outcome: 'updated' });
  assert.equal(session.title, '审批失败排查');
  assert.equal(storage.state.sessions[0].title, '审批失败排查');
});

test('an intent retiring a settled commit before coordinator delivery suppresses the old title notification', async () => {
  const { store, session, storage } = await fixture();
  let notifications = 0;
  const coordinator = new SessionTitleCoordinator(store, { onCommitted: () => { notifications++; } });
  const finish = store.finishSessionTitleResult.bind(store);
  store.finishSessionTitleResult = async (...args: Parameters<typeof finish>) => {
    const saved = await finish(...args);
    assert.equal(saved, 'committed');
    coordinator.cancel(session.id);
    await store.renameSession(session.id, 'Newer user title');
    return saved;
  };
  const result = await coordinator.regenerateResult(session.id, 'turn-1', async () => set,
    buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!);
  assert.deepEqual(result, { outcome: 'cancelled' });
  assert.equal(notifications, 0);
  assert.equal(session.title, 'Newer user title');
  assert.equal(session.customTitle, 'Newer user title');
  assert.equal(storage.state.sessions[0].title, 'Newer user title');
});

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
    t.after(() => removeStorageRoot(root));
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
  t.after(() => removeStorageRoot(root));
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
  t.after(() => removeStorageRoot(root));
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

for (const previousKind of ['automatic', 'custom'] as const) {
  test(`explicit regeneration replaces a ${previousKind} title, while automatic naming stays stopped`, async () => {
    const { store, storage, session } = await fixture();
    const commits: string[] = [];
    const coordinator = new SessionTitleCoordinator(store, { onCommitted: (_id, mode) => { commits.push(mode); } });
    if (previousKind === 'custom') await store.renameSession(session.id, 'My title');
    else await coordinator.complete(session.id, 'turn-1', async () => set);
    const material = buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!;
    let calls = 0;
    const regenerate = () => coordinator.regenerate(session.id, 'turn-1', async () => {
      calls++; return '{"decision":"set","title":"会话审批边界"}';
    }, material);
    assert.equal(await regenerate(), true);
    assert.equal(session.title, '会话审批边界');
    assert.equal(session.customTitle, undefined);
    assert.equal(storage.state.sessions[0].customTitle, undefined);
    assert.equal(store.getSessionSummaries()[0].title, session.title);
    assert.equal(session.autoTitle?.status, 'completed');
    assert.equal(commits.at(-1), 'manual');
    assert.equal(await coordinator.complete(session.id, 'turn-1', async () => { throw new Error('automatic repeat'); }), false);
    assert.equal(await regenerate(), true, 'a later explicit double-click can regenerate the same conversation again');
    assert.equal(calls, 2);
    assert.equal(Object.hasOwn(session.autoTitle!.regenerationPrevious!.metadata, 'regenerationPrevious'), false);
  });

  for (const response of ['defer', 'invalid', 'failed'] as const) {
    test(`manual ${response} preserves a ${previousKind} title and its lock across restart`, async () => {
      const { store, storage, session, coordinator } = await fixture();
      if (previousKind === 'custom') await store.renameSession(session.id, 'My title');
      else await coordinator.complete(session.id, 'turn-1', async () => set);
      const priorTitle = session.title, priorCustom = session.customTitle, priorStatus = session.autoTitle!.status;
      const result = await coordinator.regenerate(session.id, 'turn-1', async () => {
        if (response === 'failed') throw new Error('provider unavailable');
        return response === 'defer' ? '{"decision":"defer","title":null}' : 'malformed response';
      }, buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!);
      assert.equal(result, false);
      assert.equal(session.title, priorTitle);
      assert.equal(session.customTitle, priorCustom);
      assert.equal(session.autoTitle?.status, priorStatus);
      assert.equal(session.autoTitle?.manualAttempt, undefined);
      const restart = new ChatSessionStore(storage, 'en', scope);
      await restart.initialize();
      assert.equal(restart.getActiveSession().title, priorTitle);
      assert.equal(restart.getActiveSession().customTitle, priorCustom);
      assert.equal(restart.getActiveSession().autoTitle?.status, priorStatus);
    });
  }

  test(`manual claim restart retires the request and retains the ${previousKind} title`, async () => {
    const { store, storage, session, coordinator } = await fixture();
    if (previousKind === 'custom') await store.renameSession(session.id, 'My title');
    else await coordinator.complete(session.id, 'turn-1', async () => set);
    const priorTitle = session.title, priorCustom = session.customTitle, priorStatus = session.autoTitle!.status;
    assert.ok(await store.claimSessionTitle(session.id, 'turn-1', buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!.basis, 'manual'));
    const restart = new ChatSessionStore(storage, 'en', scope);
    await restart.initialize();
    const recovered = restart.getActiveSession();
    assert.equal(recovered.title, priorTitle);
    assert.equal(recovered.customTitle, priorCustom);
    assert.equal(recovered.autoTitle?.status, priorStatus);
    assert.equal(recovered.autoTitle?.manualAttempt, undefined);
    let requests = 0;
    assert.equal(await new SessionTitleCoordinator(restart).complete(recovered.id, 'turn-1', async () => { requests++; return set; }), false);
    assert.equal(requests, 0);
  });

  test(`manual candidate save failure retains a ${previousKind} title with no false success or model retry`, async () => {
    const { store, storage, session, coordinator } = await fixture();
    if (previousKind === 'custom') await store.renameSession(session.id, 'My title');
    else await coordinator.complete(session.id, 'turn-1', async () => set);
    const priorTitle = session.title, priorCustom = session.customTitle, priorStatus = session.autoTitle!.status;
    let calls = 0, saves = 0;
    storage.beforeSave = state => {
      if (state.sessions[0].title === '会话审批边界') { saves++; throw new Error('disk unavailable'); }
    };
    assert.equal(await coordinator.regenerate(session.id, 'turn-1', async () => {
      calls++; return '{"decision":"set","title":"会话审批边界"}';
    }, buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!), false);
    assert.equal(calls, 1); assert.equal(saves, 2);
    assert.equal(session.title, priorTitle);
    assert.equal(session.customTitle, priorCustom);
    assert.equal(session.autoTitle?.status, priorStatus);
    const restart = new ChatSessionStore(storage, 'en', scope);
    await restart.initialize();
    assert.equal(restart.getActiveSession().title, priorTitle);
    assert.equal(restart.getActiveSession().autoTitle?.status, priorStatus);
  });
}

for (const invalidation of ['rename', 'new-turn', 'delete'] as const) {
  test(`manual response cannot overwrite ${invalidation} and concurrent explicit requests dispatch once`, async () => {
    const { store, session, coordinator } = await fixture();
    await store.renameSession(session.id, 'Manual');
    const started = deferred<void>(), response = deferred<string>();
    const material = buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!;
    const work = coordinator.regenerate(session.id, 'turn-1', async () => { started.resolve(); return response.promise; }, material);
    await started.promise;
    assert.equal(await coordinator.regenerate(session.id, 'turn-1', async () => { throw new Error('duplicate'); }, material), false);
    if (invalidation === 'rename') await store.renameSession(session.id, 'Manual');
    if (invalidation === 'new-turn') { coordinator.cancel(session.id); session.messages.push(...pair('turn-2')); await store.persist(); }
    if (invalidation === 'delete') await store.deleteSessions([session.id]);
    response.resolve(set);
    assert.equal(await work, false);
    if (invalidation === 'delete') assert.equal(store.getSessionById(session.id), undefined);
    else { assert.equal(session.title, 'Manual'); assert.equal(session.customTitle, 'Manual'); }
  });
}

for (const previousKind of ['automatic', 'custom'] as const) {
  test(`failed real manual index commit restores a ${previousKind} title and stop semantics on restart`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'keepseek-manual-title-index-'));
    t.after(() => removeStorageRoot(root));
    const uri = vscode.Uri.file(root) as never;
    const storage = new GlobalSessionStorage(uri);
    const store = new ChatSessionStore(storage, 'en', scope);
    await store.initialize();
    const session = store.getActiveSession();
    session.messages = pair('turn-1'); await store.persist();
    const coordinator = new SessionTitleCoordinator(store);
    if (previousKind === 'custom') await store.renameSession(session.id, 'Manual title');
    else assert.equal(await coordinator.complete(session.id, 'turn-1', async () => set), true);
    const priorTitle = session.title, priorCustom = session.customTitle, priorStatus = session.autoTitle!.status;
    const originalRename = vscode.workspace.fs.rename;
    let rejected = 0, requests = 0;
    vscode.workspace.fs.rename = async (...args) => {
      if (args[1].fsPath.endsWith('/index.json')) {
        const candidate = JSON.parse(await readFile(args[0].fsPath, 'utf8'));
        if (candidate.sessions.some((entry: { title: string }) => entry.title === '会话审批边界')) {
          rejected++; throw Object.assign(new Error('index unavailable'), { code: 'EACCES' });
        }
      }
      return originalRename(...args);
    };
    try {
      assert.equal(await coordinator.regenerate(session.id, 'turn-1', async () => {
        requests++; return '{"decision":"set","title":"会话审批边界"}';
      }, buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!), false);
    } finally { vscode.workspace.fs.rename = originalRename; }
    assert.equal(requests, 1); assert.equal(rejected, 2);
    assert.equal(session.title, priorTitle);
    const restart = new ChatSessionStore(new GlobalSessionStorage(uri), 'en', scope);
    await restart.initialize();
    const recovered = restart.getActiveSession();
    assert.equal(recovered.title, priorTitle);
    assert.equal(recovered.customTitle, priorCustom);
    assert.equal(recovered.autoTitle?.status, priorStatus);
    assert.equal(recovered.autoTitle?.manualAttempt, undefined);
  });
}

test('manual regeneration names legacy conversations without rewriting their task links or request bytes', async () => {
  const legacy = pair('legacy');
  for (const message of legacy) delete message.userTask;
  const { store, session, coordinator } = await fixture(legacy);
  const before = JSON.stringify(session.messages);
  assert.equal(await coordinator.regenerate(session.id, 'legacy', async () => set,
    buildSessionTitleRegenerationMaterial(session.messages, 'legacy')!), true);
  assert.equal(JSON.stringify(session.messages), before);
  assert.equal(session.autoTitle?.status, 'completed');
  await store.persist();
});

for (const previousKind of ['automatic', 'custom'] as const) {
  test(`a failed manual claim index write preserves the ${previousKind} title before provider dispatch`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'keepseek-manual-title-claim-'));
    t.after(() => removeStorageRoot(root));
    const uri = vscode.Uri.file(root) as never;
    const storage = new GlobalSessionStorage(uri);
    const store = new ChatSessionStore(storage, 'en', scope);
    await store.initialize();
    const session = store.getActiveSession();
    session.messages = pair('turn-1'); await store.persist();
    const coordinator = new SessionTitleCoordinator(store);
    if (previousKind === 'custom') await store.renameSession(session.id, 'Manual title');
    else assert.equal(await coordinator.complete(session.id, 'turn-1', async () => set), true);
    const priorTitle = session.title, priorCustom = session.customTitle, priorStatus = session.autoTitle!.status;
    const originalRename = vscode.workspace.fs.rename;
    let requests = 0;
    vscode.workspace.fs.rename = async (...args) => {
      if (args[1].fsPath.endsWith('/index.json')) throw Object.assign(new Error('claim index unavailable'), { code: 'EACCES' });
      return originalRename(...args);
    };
    try {
      assert.equal(await coordinator.regenerate(session.id, 'turn-1', async () => { requests++; return set; },
        buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!), false);
    } finally { vscode.workspace.fs.rename = originalRename; }
    assert.equal(requests, 0);
    const restart = new ChatSessionStore(new GlobalSessionStorage(uri), 'en', scope);
    await restart.initialize();
    const recovered = restart.getActiveSession();
    assert.equal(recovered.title, priorTitle);
    assert.equal(recovered.customTitle, priorCustom);
    assert.equal(recovered.autoTitle?.status, priorStatus);
    assert.equal(recovered.autoTitle?.manualAttempt, undefined);
  });
}

test('a retired manual callback cannot cancel or invalidate a newer in-flight regeneration', async () => {
  const { store, session, coordinator } = await fixture();
  await store.renameSession(session.id, 'Manual');
  const material = buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!;
  const oldStarted = deferred<void>(), newStarted = deferred<void>();
  const oldResponse = deferred<string>(), newResponse = deferred<string>();
  const old = coordinator.regenerate(session.id, 'turn-1', async () => { oldStarted.resolve(); return oldResponse.promise; }, material);
  await oldStarted.promise;
  coordinator.cancel(session.id);
  let newSignal: AbortSignal | undefined;
  const current = coordinator.regenerate(session.id, 'turn-1', async input => {
    newSignal = input.signal; newStarted.resolve(); return newResponse.promise;
  }, material);
  await newStarted.promise;
  const token = session.autoTitle!.manualAttempt!.token;
  oldResponse.resolve(set);
  assert.equal(await old, false);
  assert.equal(newSignal?.aborted, false);
  assert.equal(session.autoTitle?.manualAttempt?.token, token);
  newResponse.resolve('{"decision":"set","title":"会话审批边界"}');
  assert.equal(await current, true);
  assert.equal(session.title, '会话审批边界');
});

test('a cancelled manual claim keeps its committed automatic revision if the correction index write fails', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-manual-title-cancel-'));
  t.after(() => removeStorageRoot(root));
  const uri = vscode.Uri.file(root) as never;
  const store = new ChatSessionStore(new GlobalSessionStorage(uri), 'en', scope);
  await store.initialize();
  const session = store.getActiveSession();
  session.messages = pair('turn-1'); await store.persist();
  assert.equal(await new SessionTitleCoordinator(store).complete(session.id, 'turn-1', async () => set), true);
  const revision = session.autoTitle!.revision;
  assert.ok(await store.claimSessionTitle(session.id, 'turn-1', buildSessionTitleRegenerationMaterial(session.messages, 'turn-1')!.basis, 'manual'));
  const originalRename = vscode.workspace.fs.rename;
  vscode.workspace.fs.rename = async (...args) => {
    if (args[1].fsPath.endsWith('/index.json')) throw Object.assign(new Error('cancel index unavailable'), { code: 'EACCES' });
    return originalRename(...args);
  };
  try {
    store.invalidateSessionTitle(session.id);
    await assert.rejects(store.persist(), /cancel index unavailable/);
  } finally { vscode.workspace.fs.rename = originalRename; }
  assert.equal(session.autoTitle?.revision, revision);
  const restart = new ChatSessionStore(new GlobalSessionStorage(uri), 'en', scope);
  await restart.initialize();
  const recovered = restart.getActiveSession();
  assert.equal(recovered.title, '审批失败排查');
  assert.equal(recovered.autoTitle?.status, 'completed');
  assert.equal(recovered.autoTitle?.manualAttempt, undefined);
});
