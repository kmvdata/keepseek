import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from './stubs/vscode';
import { ChatSessionStore, createEmptySession, type WorkspaceSessionScope } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage, getWorkspaceHash, type WorkspaceSessionIndex } from '../src/sessions/globalSessionStorage';
import type { ChatSession } from '../src/shared/types';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(yes => { resolve = yes; });
  return { promise, resolve };
}

interface StorageInternals {
  readSession(workspaceKey: string, sessionId: string, index: WorkspaceSessionIndex): Promise<ChatSession | undefined>;
  reconcileWorkspaceIndex(index: WorkspaceSessionIndex): Promise<WorkspaceSessionIndex>;
}

test('bounded disk loading skips index repairs and its late read cannot overwrite a replacement selection', { timeout: 3_000 }, async t => {
  const { root, storage, store, scope, active, target, indexPath } = await fixture(t);
  const orphan = createEmptySession('en', scope);
  orphan.messages.push({ id: 'orphan-user', role: 'user', content: 'Recovered only by ordinary readers', createdAt: orphan.createdAt });
  const orphanFile = createHash('sha256').update(orphan.id).digest('hex').slice(0, 32) + '.json';
  await writeFile(join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key), 'sessions', orphanFile),
    JSON.stringify({ version: 2, workspaceKey: scope.key, session: orphan }));

  const internals = storage as unknown as StorageInternals;
  const read = internals.readSession.bind(storage);
  const reconcile = internals.reconcileWorkspaceIndex.bind(storage);
  const entered = deferred(); const release = deferred(); const completed = deferred();
  t.after(() => release.resolve());
  let repairs = 0;
  internals.reconcileWorkspaceIndex = async index => { repairs++; return reconcile(index); };
  internals.readSession = async (workspaceKey, sessionId, index) => {
    if (sessionId !== target.id) return read(workspaceKey, sessionId, index);
    assert.equal(index.activeSessionId, active.id, 'the abandoned read holds the original index snapshot');
    entered.resolve(); await release.promise;
    try { return await read(workspaceKey, sessionId, index); }
    finally { completed.resolve(); }
  };

  const choosing = store.selectSessionBounded(target.id, { timeoutMs: 20 });
  await entered.promise;
  assert.deepEqual(await choosing, { status: 'timeout' });
  assert.equal(repairs, 0, 'even an existing orphan must not trigger writes in a bounded read');
  assert.equal(store.activeSessionId, active.id);
  const replacement = await store.createNewSession();
  await storage.flush();
  const before = await diskSnapshot(root);
  assert.equal(JSON.parse(await readFile(indexPath, 'utf8')).activeSessionId, replacement.id);

  release.resolve(); await completed.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  await storage.flush();
  assert.equal(store.activeSessionId, replacement.id);
  assert.equal(store.getSessionById(target.id), undefined);
  assert.equal(repairs, 0);
  assert.deepEqual(await diskSnapshot(root), before, 'late loading performs no shard, index or manifest write');
  assert.equal(JSON.parse(await readFile(indexPath, 'utf8')).activeSessionId, replacement.id);

  internals.readSession = read;
  assert.equal((await storage.loadSession(scope.key, target.id))?.id, target.id);
  assert.equal(repairs, 1, 'ordinary readers retain their existing reconciliation behavior');
  const repaired = JSON.parse(await readFile(indexPath, 'utf8')) as WorkspaceSessionIndex;
  assert.ok(repaired.sessions.some(session => session.id === orphan.id));
  assert.equal(repaired.activeSessionId, replacement.id);
});

test('read-only loading preserves a V1 fallback without migration or a derived manifest write', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-bounded-v1-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const scope = { key: 'workspace:bounded-v1', name: 'Bounded V1', folderUris: [] };
  const session = createEmptySession('en', scope);
  session.messages.push({ id: 'legacy-user', role: 'user', content: '  Preserve user bytes\n', createdAt: session.createdAt });
  const directory = join(root, 'chat-sessions', 'v1', 'workspaces');
  await mkdir(directory, { recursive: true });
  const legacyPath = join(directory, `${getWorkspaceHash(scope.key)}.json`);
  await writeFile(legacyPath, JSON.stringify({ version: 1, workspaceKey: scope.key, workspaceName: scope.name,
    workspaceFolders: scope.folderUris, activeSessionId: session.id, approvalMode: 'ask', sessions: [session], updatedAt: session.updatedAt }));
  const before = await diskSnapshot(root);

  const loaded = await storage.loadSession(scope.key, session.id, { readOnly: true });
  assert.equal(loaded?.id, session.id);
  assert.equal(loaded?.messages[0].content, session.messages[0].content);
  assert.equal(await storage.loadSession(scope.key, 'missing', { readOnly: true }), undefined);
  await storage.flush();
  assert.deepEqual(await diskSnapshot(root), before);
  await assert.rejects(stat(join(root, 'chat-sessions', 'v2')), { code: 'ENOENT' });
});

test('read-only loading of an absent workspace does not create storage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-bounded-missing-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  assert.equal(await storage.loadSession('workspace:missing', 'missing', { readOnly: true }), undefined);
  await storage.flush();
  assert.deepEqual(await readdir(root), []);
});

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-bounded-storage-'));
  const scope: WorkspaceSessionScope = { key: 'workspace:bounded-storage', name: 'Bounded Storage', folderUris: [] };
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const seed = new ChatSessionStore(storage, 'en', scope);
  await seed.initialize();
  const active = seed.getActiveSession();
  active.messages.push({ id: 'active-user', role: 'user', content: 'Active conversation', createdAt: active.createdAt });
  await seed.persist();
  const target = await seed.createNewSession();
  target.messages.push({ id: 'target-user', role: 'user', content: 'Cold conversation', createdAt: target.createdAt });
  await seed.persist();
  await seed.selectSession(active.id);
  await storage.flush();
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  assert.equal(store.getSessionById(target.id), undefined);
  const indexPath = join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key), 'index.json');
  return { root, storage, store, scope, active, target, indexPath };
}

async function diskSnapshot(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await visit(join(directory, entry.name), name + '/');
      else files[name] = createHash('sha256').update(await readFile(join(directory, entry.name))).digest('hex');
    }
  }
  await visit(root, '');
  return files;
}
