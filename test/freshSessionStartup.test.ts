import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from './stubs/vscode';
import { ChatSessionStore, createEmptySession, type WorkspaceSessionScope } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage, getWorkspaceHash, type WorkspaceSessionIndex } from '../src/sessions/globalSessionStorage';
import { SessionObjectStore } from '../src/sessions/sessionObjectStore';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Tiny current-format fixtures avoid exercising durable writes just to prepare
 * a startup read test. Their body nodes are still verified by the real reader. */
async function writeWorkspace(root: string, key: string) {
  const scope: WorkspaceSessionScope = { key, name: key, folderUris: [] };
  const directory = join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(key));
  const sessions = [0, 1, 2].map(index => {
    const session = createEmptySession('en', scope);
    session.id = `${key}-history-${index}`;
    session.title = `History ${index}`;
    session.messages.push({ id: `${key}-user-${index}`, role: 'user',
      content: `  Original user bytes ${index}\n`, createdAt: session.createdAt });
    return session;
  });
  for (const session of sessions) {
    const shard = join(directory, 'sessions', `${digest(session.id).slice(0, 32)}.json`);
    await mkdir(`${shard}.objects`, { recursive: true });
    const { messages, ...header } = session;
    const headerInline = { kind: 'json', value: header };
    const body = JSON.stringify({ kind: 'json', value: messages[0] });
    const bodyHash = digest(body);
    await writeFile(join(`${shard}.objects`, `${bodyHash}.json`), body);
    await writeFile(shard, JSON.stringify({ version: 4, workspaceKey: key, sessionId: session.id,
      revision: 1, header: digest(JSON.stringify(headerInline)), headerInline, messages: [{ body: bodyHash }] }));
  }
  // This valid orphan must not trigger startup directory enumeration/repair.
  const indexed = sessions.slice(0, 2);
  const index: WorkspaceSessionIndex = { version: 2, workspaceKey: key, workspaceName: scope.name,
    workspaceFolders: [], activeSessionId: indexed[0].id, approvalMode: 'ask', updatedAt: indexed[0].updatedAt,
    sessions: indexed.map(session => ({ id: session.id, title: session.title, workspaceKey: key,
      workspaceName: scope.name, createdAt: session.createdAt, updatedAt: session.updatedAt,
      isFavorite: false, messageCount: session.messages.length,
      storageFile: `sessions/${digest(session.id).slice(0, 32)}.json` })) };
  const indexPath = join(directory, 'index.json');
  const indexBytes = JSON.stringify(index);
  await writeFile(indexPath, indexBytes);
  return { scope, sessions: indexed, orphan: sessions[2], indexPath, indexBytes };
}

function observeStorageIo() {
  const reads: string[] = [], directories: string[] = [], writes: string[] = [];
  const fs = vscode.workspace.fs;
  const original = { readFile: fs.readFile, readDirectory: fs.readDirectory, writeFile: fs.writeFile, rename: fs.rename };
  fs.readFile = async uri => { reads.push(uri.fsPath); return original.readFile(uri); };
  fs.readDirectory = async uri => { directories.push(uri.fsPath); return original.readDirectory(uri); };
  fs.writeFile = async (uri, bytes) => { writes.push(uri.fsPath); return original.writeFile(uri, bytes); };
  fs.rename = async (from, to, options) => { writes.push(to.fsPath); return original.rename(from, to, options); };
  return { reads, directories, writes, restore: () => Object.assign(fs, original) };
}

function assertSummaryOnly(io: ReturnType<typeof observeStorageIo>) {
  assert.deepEqual(io.reads.filter(path => /[/\\]sessions[/\\]|\.objects[/\\]/u.test(path)), [],
    'fresh startup must not read a session shard or an object body');
  assert.deepEqual(io.directories, [], 'fresh startup must not enumerate or repair orphan histories');
  assert.deepEqual(io.writes, [], 'opening a blank session must not persist or change the previous selection');
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-fresh-start-'));
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  return { root, storage };
}

test('fresh adapter loading reads summaries without hydrating the previous active session or repairing orphans', async t => {
  const { root, storage } = await fixture(t);
  const saved = await writeWorkspace(root, 'workspace:fresh-adapter');
  const io = observeStorageIo();
  try {
    const state = await storage.loadWorkspace(saved.scope, { fresh: true });
    assert.equal(state.activeSessionId, '');
    assert.deepEqual(state.sessions, []);
    assert.deepEqual(state.sessionSummaries?.map(session => session.id).sort(), saved.sessions.map(session => session.id).sort());
    assertSummaryOnly(io);
    assert.ok(io.reads.includes(saved.indexPath), 'the current index remains the history menu source');
  } finally { io.restore(); }
  assert.equal(await readFile(saved.indexPath, 'utf8'), saved.indexBytes);
});

test('fresh session initialization remains blank until explicit history selection loads the selected body', async t => {
  const { root, storage } = await fixture(t);
  const saved = await writeWorkspace(root, 'workspace:fresh-store');
  const store = new ChatSessionStore(storage, 'en', saved.scope);
  const io = observeStorageIo();
  try {
    await store.initialize({ fresh: true });
    const blank = store.getActiveSession();
    assert.equal(blank.messages.length, 0);
    assert.ok(!saved.sessions.some(session => session.id === blank.id));
    const summaries = store.getSessionSummaries();
    for (let click = 0; click < 5; click++) assert.equal(await store.createNewSession(), blank);
    assert.equal(store.activeSessionId, blank.id);
    assert.deepEqual(store.getSessionSummaries(), summaries, 'repeated New clicks add no empty history rows');
    for (const session of saved.sessions) {
      assert.equal(store.getSessionById(session.id), undefined, 'historical bodies remain cold');
      assert.ok(store.getSessionSummaries().some(summary => summary.id === session.id));
    }
    assert.ok(!store.getSessionSummaries().some(summary => summary.id === saved.orphan.id));
    assertSummaryOnly(io);
    assert.equal(await readFile(saved.indexPath, 'utf8'), saved.indexBytes);

    const selected = await store.selectSession(saved.sessions[1].id);
    assert.equal(selected?.id, saved.sessions[1].id);
    assert.equal(selected?.messages[0].content, saved.sessions[1].messages[0].content);
    assert.ok(io.reads.some(path => path.endsWith(`${digest(saved.sessions[1].id).slice(0, 32)}.json`)));
    assert.ok(io.reads.some(path => path.includes('.objects')));
    assert.equal(store.getSessionById(saved.sessions[0].id), undefined, 'selection does not preload another history');
    assert.equal(store.getSessionById(saved.orphan.id), undefined, 'explicit selection performs no orphan recovery');
  } finally { io.restore(); }
});

test('fresh workspace changes preserve each history menu without restoring or saving either active history', async t => {
  const { root, storage } = await fixture(t);
  const first = await writeWorkspace(root, 'workspace:fresh-first');
  const second = await writeWorkspace(root, 'workspace:fresh-second');
  const store = new ChatSessionStore(storage, 'en', first.scope);
  const io = observeStorageIo();
  try {
    await store.initialize({ fresh: true });
    const firstBlank = store.activeSessionId;
    assert.equal(await store.setWorkspaceScope(second.scope, { fresh: true }), true);
    assert.equal(store.workspaceKey, second.scope.key);
    assert.notEqual(store.activeSessionId, firstBlank);
    assert.equal(store.messages.length, 0);
    for (const session of second.sessions) {
      assert.ok(store.getSessionSummaries().some(summary => summary.id === session.id));
      assert.equal(store.getSessionById(session.id), undefined);
    }
    assert.ok(store.getSessionSummaries().every(summary => summary.workspaceKey === second.scope.key));
    assertSummaryOnly(io);
  } finally { io.restore(); }
  assert.equal(await readFile(first.indexPath, 'utf8'), first.indexBytes);
  assert.equal(await readFile(second.indexPath, 'utf8'), second.indexBytes);
});

test('automatic cleanup refreshes summaries without reviving the stored active history or replacing the fresh blank', async t => {
  const { root, storage } = await fixture(t);
  const saved = await writeWorkspace(root, 'workspace:fresh-cleanup');
  const store = new ChatSessionStore(storage, 'en', saved.scope);
  const io = observeStorageIo();
  try {
    await store.initialize({ fresh: true });
    const blank = store.getActiveSession();
    blank.title = 'Unsaved fresh title';
    blank.contextInstructions = 'Prepared in memory before background retention finishes';
    let cleanups = 0;
    storage.cleanupExpiredSessions = async options => {
      cleanups++;
      assert.equal(options.currentActiveSessionId, blank.id);
      assert.equal(options.currentWorkspaceKey, saved.scope.key);
      return true;
    };

    assert.equal(await store.cleanupExpiredSessions(), true);
    assert.equal(cleanups, 1);
    assert.equal(store.getActiveSession(), blank, 'retention must preserve the resident active object');
    assert.equal(store.activeSessionId, blank.id);
    assert.equal(store.messages.length, 0);
    assert.equal(blank.title, 'Unsaved fresh title');
    assert.equal(blank.contextInstructions, 'Prepared in memory before background retention finishes');
    for (const session of saved.sessions) {
      assert.equal(store.getSessionById(session.id), undefined, 'retention cannot hydrate the old active history');
      assert.ok(store.getSessionSummaries().some(summary => summary.id === session.id));
    }
    assertSummaryOnly(io);
  } finally { io.restore(); }
  assert.equal(await readFile(saved.indexPath, 'utf8'), saved.indexBytes);
});

test('fresh initialization of an unused workspace creates only an in-memory blank session', async t => {
  const { root, storage } = await fixture(t);
  const store = new ChatSessionStore(storage, 'en', { key: 'workspace:new', name: 'New', folderUris: [] });
  const io = observeStorageIo();
  try {
    await store.initialize({ fresh: true });
    assert.equal(store.messages.length, 0);
    assert.equal(store.getSessionSummaries().length, 0, 'the usable blank composer is not a history entry');
    assertSummaryOnly(io);
  } finally { io.restore(); }
  assert.deepEqual(await readdir(root), []);
});

test('creating, configuring and deleting sessions never persists blank replacement shards', async t => {
  const { root, storage } = await fixture(t);
  const scope = { key: 'workspace:empty-history', name: 'Empty history', folderUris: [] };
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize({ fresh: true });
  const first = store.getActiveSession();
  await store.setExecutionMode('plan');
  await store.setApprovalMode('delegate');
  assert.equal(store.getActiveSession(), first);
  assert.deepEqual(store.getSessionSummaries(), []);
  assert.deepEqual((await storage.loadWorkspace(scope, { fresh: true })).sessionSummaries, []);

  const directory = join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(scope.key));
  const shardPath = (id: string) => join(directory, 'sessions', `${digest(id).slice(0, 32)}.json`);
  await assert.rejects(readFile(shardPath(first.id)), { code: 'ENOENT' });
  first.messages.push({ id: 'first-user', role: 'user', content: '  First submitted bytes\n', createdAt: first.createdAt });
  await store.persist();
  assert.deepEqual(store.getSessionSummaries().map(item => item.id), [first.id]);
  assert.equal((await storage.loadSession(scope.key, first.id))?.messages[0].content, '  First submitted bytes\n');

  const second = await store.createNewSession();
  assert.notEqual(second.id, first.id);
  await store.setExecutionMode('plan');
  assert.deepEqual(store.getSessionSummaries().map(item => item.id), [first.id]);
  await assert.rejects(readFile(shardPath(second.id)), { code: 'ENOENT' });
  await store.selectSession(first.id);
  assert.deepEqual(store.getSessionSummaries().map(item => item.id), [first.id], 'abandoned blanks leave no stale summaries');
  await store.deleteSessions([first.id]);
  const replacement = store.getActiveSession();
  assert.equal(replacement.messages.length, 0);
  assert.deepEqual(store.getSessionSummaries(), []);
  assert.deepEqual((await storage.loadWorkspace(scope, { fresh: true })).sessionSummaries, []);
  await assert.rejects(readFile(shardPath(replacement.id)), { code: 'ENOENT' });

  replacement.messages.push({ id: 'replacement-user', role: 'user', content: 'Next task', createdAt: replacement.createdAt });
  await store.persist();
  const restored = new ChatSessionStore(new GlobalSessionStorage(vscode.Uri.file(root) as never), 'en', scope);
  await restored.initialize({ fresh: true });
  assert.deepEqual(restored.getSessionSummaries().map(item => item.id), [replacement.id]);
  assert.equal(restored.messages.length, 0, 'fresh startup still opens an unused composer without restoring history');
});

test('current-format empty shards are excluded without losing delayed first messages or cleanup ownership', async t => {
  const { root, storage } = await fixture(t);
  const saved = await writeWorkspace(root, 'workspace:existing-empty');
  const directory = join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(saved.scope.key));
  const index = JSON.parse(await readFile(saved.indexPath, 'utf8')) as WorkspaceSessionIndex;
  // Seed the exact current-format data written by the old bug, bypassing the
  // corrected adapter's refusal to create a new empty historical shard.
  const empty = createEmptySession('en', saved.scope);
  const storageFile = `sessions/${digest(empty.id).slice(0, 32)}.json`;
  const emptyObjects = new SessionObjectStore(vscode.Uri.file(join(directory, storageFile)) as never);
  await emptyObjects.save(empty);
  const emptyOrphan = createEmptySession('en', saved.scope);
  await new SessionObjectStore(vscode.Uri.file(join(directory, 'sessions', `${digest(emptyOrphan.id).slice(0, 32)}.json`)) as never).save(emptyOrphan);
  index.sessions.push({ id: empty.id, title: empty.title, workspaceKey: saved.scope.key, workspaceName: saved.scope.name,
    createdAt: empty.createdAt, updatedAt: empty.updatedAt, messageCount: 0, isFavorite: false, storageFile });
  const delayed = index.sessions[0];
  delayed.messageCount = 0; // The body commit succeeded before its summary did.
  await writeFile(saved.indexPath, JSON.stringify(index));
  const io = observeStorageIo();
  try {
    const fresh = await storage.loadWorkspace(saved.scope, { fresh: true });
    assert.deepEqual(fresh.sessionSummaries?.map(item => item.id).sort(), saved.sessions.map(item => item.id).sort());
    assert.equal(fresh.sessionSummaries?.find(item => item.id === delayed.id)?.messageCount, 1);
    assert.deepEqual(io.reads.filter(path => path.includes('.objects')), [], 'zero-count validation reads manifests, never user bodies');
    assert.deepEqual(io.writes, []);
  } finally { io.restore(); }
  assert.ok(!(await storage.listWorkspaceSessionSummaries(saved.scope.key)).some(item => item.id === empty.id));
  assert.ok(!(await storage.listWorkspaceSessionSummaries(saved.scope.key)).some(item => item.id === emptyOrphan.id));
  assert.ok(!(await storage.loadWorkspaceSessions(saved.scope.key)).some(item => item.id === empty.id));
  assert.equal((await storage.listAllWorkspaceSummaries()).find(item => item.workspaceKey === saved.scope.key)?.sessionCount, 3,
    'the recovered non-empty orphan counts as history, while the empty shard does not');
  const catalog = await storage.readHistoryCleanupCatalog(saved.scope.key);
  assert.equal(catalog.ownershipComplete, true, 'the old empty shard keeps its raw ownership record');
  assert.equal(catalog.entries.find(item => item.id === empty.id)?.hasHistory, false);
  assert.equal(catalog.entries.find(item => item.id === emptyOrphan.id)?.hasHistory, false,
    'repair registers an empty orphan as ownership metadata without making it public history');
  // A stale empty snapshot must neither erase nor hide the committed body.
  await storage.saveWorkspace(saved.scope, { activeSessionId: empty.id, sessions: [empty],
    sessionSummaries: [{ ...delayed, messageCount: 0 }, { ...index.sessions[1], messageCount: 0 }] });
  const committed = JSON.parse(await readFile(saved.indexPath, 'utf8')) as WorkspaceSessionIndex;
  assert.equal(committed.sessions.find(item => item.id === index.sessions[1].id)?.messageCount, 1,
    'a stale zero-count summary cannot overwrite a positive history record');
  assert.equal((await storage.loadSession(saved.scope.key, delayed.id))?.messages[0].content, saved.sessions[0].messages[0].content);
  assert.ok(!(await storage.listWorkspaceSessionSummaries(saved.scope.key)).some(item => item.id === empty.id));
});

test('an unverified zero-count shard remains visible rather than being discarded as empty', async t => {
  const { root, storage } = await fixture(t);
  const saved = await writeWorkspace(root, 'workspace:unknown-empty');
  const index = JSON.parse(await readFile(saved.indexPath, 'utf8')) as WorkspaceSessionIndex;
  index.sessions[0].messageCount = 0;
  await writeFile(saved.indexPath, JSON.stringify(index));
  await writeFile(join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(saved.scope.key), index.sessions[0].storageFile), '{}');
  const fresh = await storage.loadWorkspace(saved.scope, { fresh: true });
  assert.ok(fresh.sessionSummaries?.some(item => item.id === index.sessions[0].id));
});

test('production activation explicitly requests fresh initialization with the shared native storage root', () => {
  const source = readFileSync('src/extension.ts', 'utf8');
  assert.match(source, /const storageUri = getNativeStorageUri\(\)/u);
  assert.match(source, /new GlobalSessionStorage\(storageUri,/u);
  assert.match(source, /new ChatSessionStore\(globalSessionStorage,/u);
  assert.match(source, /await sessionStore\.initialize\(\{\s*fresh:\s*true\s*\}\)/u,
    'activation must opt into summary-only blank startup instead of the explicit restore path');
  assert.doesNotMatch(source, /sessionStore\.selectSession\(|globalSessionStorage\.loadWorkspace\(/u);
});
