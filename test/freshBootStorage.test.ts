import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { ChatSessionStore, type WorkspaceSessionScope } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import type { ChatMessage, ChatSession } from '../src/shared/types';
import * as vscode from './stubs/vscode';
import { SESSION_STORAGE_KEY } from '../src/sessions/chatSessionStore';
import { SESSION_MIGRATION_KEY } from '../src/sessions/globalSessionStorage';

function scope(name: string): WorkspaceSessionScope {
  return { key: `fresh-boot:${name}`, name, folderUris: [] };
}

function message(id: string, content = `message ${id}`): ChatMessage {
  return { id, role: 'user', content, expandedContent: `${content}  \n retained`, createdAt: '2026-01-02T00:00:00.000Z' };
}

function session(id: string, workspace: WorkspaceSessionScope): ChatSession {
  return { id, title: id, messages: [message(`${id}-message`)], createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z', workspaceKey: workspace.key, workspaceName: workspace.name,
    workspaceFolders: [], isFavorite: false, approvalMode: 'delegate', contextInstructions: 'stable instruction bytes\n  unchanged' };
}

function shard(root: string, workspace: WorkspaceSessionScope, id: string): string {
  return path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(workspace.key), 'sessions',
    `${createHash('sha256').update(id).digest('hex').slice(0, 32)}.json`);
}

test('fresh host target is created once without reading historical storage or persisting unused blanks', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-blank-boot-'));
  const workspace = scope('blank');
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  await storage.saveWorkspace(workspace, { activeSessionId: 'old', approvalMode: 'delegate', sessions: [session('old', workspace)] });
  const reads: string[] = [];
  const originalRead = vscode.workspace.fs.readFile;
  const originalDirectory = vscode.workspace.fs.readDirectory;
  const originalWrite = vscode.workspace.fs.writeFile;
  let writes = 0;
  vscode.workspace.fs.readFile = async uri => { reads.push(uri.fsPath); return originalRead(uri); };
  vscode.workspace.fs.readDirectory = async uri => { reads.push(uri.fsPath); return originalDirectory(uri); };
  vscode.workspace.fs.writeFile = async (uri, bytes) => { writes++; return originalWrite(uri, bytes); };
  t.after(async () => {
    vscode.workspace.fs.readFile = originalRead;
    vscode.workspace.fs.readDirectory = originalDirectory;
    vscode.workspace.fs.writeFile = originalWrite;
    await storage.flush(); await rm(root, { recursive: true, force: true });
  });
  const store = new ChatSessionStore(storage, 'en', workspace);
  await store.initializeFreshBoot();
  const target = store.getActiveSession();
  await store.initializeFreshBoot();
  assert.equal(store.getActiveSession(), target, 'a repeated ready path retains the same target object');
  assert.notEqual(target.id, 'old');
  assert.deepEqual(target.messages, []);
  assert.equal(target.contextInstructions, undefined);
  assert.equal(target.approvalMode, 'ask', 'an unexamined legacy preference cannot expand approval');
  await store.flush();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(reads, [], 'blank activation and idle flush leave old metadata and bodies cold');
  assert.equal(writes, 0, 'an unused blank never adds a durable history record');
  const secondHost = new ChatSessionStore(storage, 'en', workspace);
  await secondHost.initializeFreshBoot();
  assert.notEqual(secondHost.activeSessionId, target.id, 'a new host gets a different blank target');
});

test('first fresh commit stays independent of V1 history and explicit history safely merges it', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-blank-v1-'));
  const workspace = scope('v1');
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const old = session('legacy', workspace);
  const legacyPath = path.join(root, 'chat-sessions', 'v1', 'workspaces', `${getWorkspaceHash(workspace.key)}.json`);
  await mkdir(path.dirname(legacyPath), { recursive: true });
  const legacyBytes = JSON.stringify({ version: 1, workspaceKey: workspace.key, workspaceName: workspace.name,
    workspaceFolders: [], activeSessionId: old.id, approvalMode: 'delegate', sessions: [old], updatedAt: old.updatedAt });
  await writeFile(legacyPath, legacyBytes);
  const originalRead = vscode.workspace.fs.readFile;
  const reads: string[] = [];
  vscode.workspace.fs.readFile = async uri => { reads.push(uri.fsPath); return originalRead(uri); };
  t.after(() => { vscode.workspace.fs.readFile = originalRead; });
  const store = new ChatSessionStore(storage, 'en', workspace);
  await store.initializeFreshBoot();
  const target = store.getActiveSession();
  target.messages.push(message('new-message', 'new user bytes'));
  await store.persistSession(target.id, 'user_submit_barrier');
  assert.ok(!reads.includes(legacyPath), 'accepting a new message cannot read or migrate unrelated V1 bodies');
  assert.ok(!reads.some(file => file.endsWith('/index.json')), 'the first commit cannot depend on the historical index');
  assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes);

  await store.loadHistoryMetadata();
  assert.equal(store.getActiveSession(), target, 'opening history metadata cannot replace the active blank turn');
  assert.deepEqual(new Set(store.getSessionSummaries().map(item => item.id)), new Set([old.id, target.id]));
  assert.equal(await readFile(legacyPath, 'utf8'), legacyBytes, 'controlled merging keeps the intact legacy original');
  await store.loadHistoryMetadata();
  assert.equal(store.getSessionSummaries().filter(item => item.id === target.id).length, 1, 'receipt merging is idempotent');

  const reopened = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const recoveredOld = await reopened.loadSession(workspace.key, old.id);
  assert.deepEqual(recoveredOld?.messages.map(item => [item.id, item.content, item.expandedContent]),
    old.messages.map(item => [item.id, item.content, item.expandedContent]));
  assert.equal(recoveredOld?.contextInstructions, old.contextInstructions);
  const saved = await reopened.loadSession(workspace.key, target.id);
  assert.equal(saved?.messages[0].expandedContent, 'new user bytes  \n retained');
  assert.equal(saved?.approvalMode, 'ask');
  await reopened.flush();
});

test('fresh commits preserve the old V2 index and shard bytes until explicit history metadata is opened', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-blank-v2-'));
  const workspace = scope('v2');
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const old = session('old-v2', workspace);
  await storage.saveWorkspace(workspace, { activeSessionId: old.id, sessions: [old] });
  const oldPath = shard(root, workspace, old.id);
  const indexPath = path.join(path.dirname(path.dirname(oldPath)), 'index.json');
  const before = await Promise.all([readFile(oldPath, 'utf8'), readFile(indexPath, 'utf8')]);
  const originalRead = vscode.workspace.fs.readFile;
  const reads: string[] = [];
  vscode.workspace.fs.readFile = async uri => { reads.push(uri.fsPath); return originalRead(uri); };
  t.after(() => { vscode.workspace.fs.readFile = originalRead; });
  const store = new ChatSessionStore(storage, 'en', workspace);
  await store.initializeFreshBoot();
  store.messages.push(message('first'));
  await store.persist();
  const firstId = store.activeSessionId;
  store.messages.push(message('second'));
  await store.persist();
  assert.ok(!reads.includes(oldPath));
  assert.ok(!reads.includes(indexPath));
  assert.deepEqual(await Promise.all([readFile(oldPath, 'utf8'), readFile(indexPath, 'utf8')]), before,
    'incremental fresh saves cannot replace the old canonical history index');
  const restartedStore = new ChatSessionStore(new GlobalSessionStorage(vscode.Uri.file(root) as never), 'en', workspace);
  await restartedStore.initializeFreshBoot();
  assert.equal(restartedStore.messages.length, 0);
  assert.notEqual(restartedStore.activeSessionId, firstId);
  await restartedStore.loadHistoryMetadata();
  assert.ok(restartedStore.getSessionSummaries().some(item => item.id === old.id));
  assert.ok(restartedStore.getSessionSummaries().some(item => item.id === firstId));
  const selected = await restartedStore.selectSession(firstId);
  assert.deepEqual(selected?.messages.map(item => item.id), ['first', 'second']);
  assert.equal(await readFile(oldPath, 'utf8'), before[0], 'opening another history target preserves old request bytes');
});

test('fresh blank boot tolerates malformed unrelated history and leaves it available for diagnosis', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-blank-corrupt-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); });
  const workspace = scope('corrupt');
  const indexPath = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(workspace.key), 'index.json');
  await mkdir(path.dirname(indexPath), { recursive: true });
  await writeFile(indexPath, '{damaged history');
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const store = new ChatSessionStore(storage, 'en', workspace);
  await store.initializeFreshBoot();
  store.messages.push(message('independent-new-message'));
  await store.persist();
  assert.equal(await readFile(indexPath, 'utf8'), '{damaged history');
  assert.equal(store.messages[0].id, 'independent-new-message');
  const entries = await readdir(path.dirname(indexPath));
  assert.ok(entries.includes('sessions'), 'the accepted new message has a durable independent shard');
  await storage.flush();
});

test('retention keeps the legacy import tombstone so intact V1 originals cannot resurrect expired history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-legacy-retention-'));
  const workspace = scope('retention');
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  t.after(async () => { await storage.flush(); await rm(root, { recursive: true, force: true }); });
  const old = session('expired-legacy', workspace);
  const legacyPath = path.join(root, 'chat-sessions', 'v1', 'workspaces', `${getWorkspaceHash(workspace.key)}.json`);
  await mkdir(path.dirname(legacyPath), { recursive: true });
  const bytes = JSON.stringify({ version: 1, workspaceKey: workspace.key, workspaceName: workspace.name,
    workspaceFolders: [], activeSessionId: old.id, sessions: [old], updatedAt: old.updatedAt });
  await writeFile(legacyPath, bytes);
  assert.equal((await storage.listWorkspaceSessionSummaries(workspace.key)).length, 1);
  await storage.cleanupExpiredSessions({ currentWorkspaceKey: workspace.key, currentActiveSessionId: '',
    force: true, now: Date.parse('2027-12-31T00:00:00.000Z') });
  assert.equal(await readFile(legacyPath, 'utf8'), bytes);
  const restarted = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  assert.deepEqual(await restarted.listWorkspaceSessionSummaries(workspace.key), []);
  assert.deepEqual(await restarted.listAllWorkspaceSummaries(), []);
  assert.equal(await readFile(legacyPath, 'utf8'), bytes);
  await restarted.flush();
});

test('observer explicit Memento-only history is a read-only view and promotion imports it only on an explicit target read', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-observer-memento-'));
  const workspace = scope('observer-memento');
  const old = session('memento-only-old', workspace);
  old.messages = Array.from({ length: 70 }, (_, index) => message(`memento-${index}`, `retained ${index}`));
  const raw = { version: 2, activeSessionId: old.id, sessions: [old] };
  const originalBytes = JSON.stringify(raw);
  let reads = 0, updates = 0, writes = 0;
  const memento = { keys: () => [SESSION_STORAGE_KEY],
    get: (key: string, fallback?: unknown) => { if (key === SESSION_STORAGE_KEY) { reads++; return raw; } return fallback; },
    update: async () => { updates++; } };
  const originalWrite = vscode.workspace.fs.writeFile;
  vscode.workspace.fs.writeFile = async (uri, bytes) => { writes++; return originalWrite(uri, bytes); };
  t.after(async () => { vscode.workspace.fs.writeFile = originalWrite; await rm(root, { recursive: true, force: true }); });
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  storage.setReadOnly(true);
  const store = new ChatSessionStore(storage, 'en', workspace);
  store.setReadOnly(true); store.initializeFreshBoot();
  const blank = store.getActiveSession();
  assert.equal(reads, 0, 'blank boot never inspects Memento');
  assert.equal(await storage.migrateLegacyWorkspaceState(memento as never, workspace), false);
  await store.loadHistoryMetadata();
  assert.equal(store.getActiveSession(), blank);
  assert.ok(store.getSessionSummaries().some(summary => summary.id === old.id));
  const page = await store.viewSessionPage(old.id, { limit: 5 });
  assert.deepEqual(page?.messages.map(item => [item.id, item.content]), old.messages.slice(-5).map(item => [item.id, item.content]));
  assert.equal((await storage.listAllWorkspaceSummaries())[0]?.sessionCount, 1);
  assert.equal(writes, 0); assert.equal(updates, 0); assert.equal(reads, 1);
  assert.equal(JSON.stringify(raw), originalBytes);
  storage.setReadOnly(false); store.setReadOnly(false);
  assert.equal(writes, 0, 'owner role conversion alone cannot migrate viewed history');
  const authority = await storage.loadSession(workspace.key, old.id);
  assert.equal(authority?.messages[0].expandedContent, old.messages[0].expandedContent);
  assert.ok(writes > 0, 'explicit continuation publishes the canonical authority before it can execute');
  assert.equal(updates, 0); assert.equal(JSON.stringify(raw), originalBytes);
  assert.equal(memento.get(SESSION_MIGRATION_KEY, false), false);
  await storage.flush();
});

test('a failed fresh discovery commit rejects durability and a retry retains exactly one user message', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-blank-commit-failure-'));
  const workspace = scope('commit-failure');
  const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const originalRename = vscode.workspace.fs.rename;
  let fail = true;
  vscode.workspace.fs.rename = async (source, target, options) => {
    if (fail && target.fsPath.includes(`${path.sep}commits${path.sep}`)) throw new Error('fixture commit publication failure');
    return originalRename(source, target, options);
  };
  t.after(async () => {
    vscode.workspace.fs.rename = originalRename;
    await storage.flush(); await rm(root, { recursive: true, force: true });
  });
  const store = new ChatSessionStore(storage, 'en', workspace);
  await store.initializeFreshBoot();
  const target = store.getActiveSession();
  const input = message('durable-input', 'preserve pending user bytes');
  store.messages.push(input);
  await assert.rejects(store.persistSession(target.id, 'user_submit_barrier'), /fixture commit publication failure/);
  assert.equal(store.getActiveSession(), target);
  assert.equal(store.messages[0], input, 'failed persistence retains the original draft authority for retry');
  fail = false;
  await store.persistSession(target.id, 'user_submit_barrier');
  const reopened = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const recovered = await reopened.loadSession(workspace.key, target.id);
  assert.deepEqual(recovered?.messages.map(item => item.id), ['durable-input']);
  assert.equal(recovered?.messages[0].expandedContent, input.expandedContent);
  await reopened.flush();
});

test('observer history reads merge legacy and new receipts without migrating or writing project history', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-blank-observer-'));
  const workspace = scope('observer');
  const writer = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  const legacyPath = path.join(root, 'chat-sessions', 'v1', 'workspaces', `${getWorkspaceHash(workspace.key)}.json`);
  await mkdir(path.dirname(legacyPath), { recursive: true });
  const old = session('observer-old', workspace);
  const original = JSON.stringify({ version: 1, workspaceKey: workspace.key, workspaceName: workspace.name,
    workspaceFolders: [], activeSessionId: old.id, sessions: [old], updatedAt: old.updatedAt });
  await writeFile(legacyPath, original);
  const live = new ChatSessionStore(writer, 'en', workspace);
  await live.initializeFreshBoot(); live.messages.push(message('owner-new'));
  await live.persist();
  const observerStorage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
  observerStorage.setReadOnly(true);
  const observer = new ChatSessionStore(observerStorage, 'en', workspace);
  observer.setReadOnly(true);
  const originalWrite = vscode.workspace.fs.writeFile;
  let writes = 0;
  vscode.workspace.fs.writeFile = async (uri, bytes) => { writes++; return originalWrite(uri, bytes); };
  t.after(async () => {
    vscode.workspace.fs.writeFile = originalWrite;
    await writer.flush(); await rm(root, { recursive: true, force: true });
  });
  await observer.initializeFreshBoot();
  const blankId = observer.activeSessionId;
  await observer.loadHistoryMetadata();
  assert.equal(observer.activeSessionId, blankId);
  assert.ok(observer.getSessionSummaries().some(item => item.id === old.id));
  assert.ok(observer.getSessionSummaries().some(item => item.id === live.activeSessionId));
  const oldPage = await observer.viewSessionPage(old.id);
  assert.equal(oldPage?.messages[0].content, old.messages[0].content);
  const newPage = await observer.viewSessionPage(live.activeSessionId);
  assert.equal(newPage?.messages[0].id, 'owner-new');
  const nextBlank = await observer.createFreshSession();
  assert.notEqual(nextBlank.id, blankId, 'an observer can start another local draft after browsing history');
  assert.deepEqual(nextBlank.messages, []);
  await observer.flush();
  assert.equal(writes, 0, 'viewing history in another owner window cannot become a storage writer');
  assert.equal(await readFile(legacyPath, 'utf8'), original);
});
