import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage, getWorkspaceHash } from '../src/sessions/globalSessionStorage';
import { missing } from '../src/sessions/sessionDeletionAuthority';
import * as vscode from './stubs/vscode';

const SCOPE_KEY = 'folders:file:///d%3A/Projects/case';
/** A distinct project identity that this same installation never opens. */
const CASE_KEY = 'folders:file:///d%3A/Projects/other-case';

interface StartupHost {
  initializeAfterWebviewReady(): Promise<void>;
  commandSettingsReadiness: Record<string, string>;
  getStartupState(): { phase: string };
  interactionSnapshot(revision: number): { sessionId?: string; canEdit?: boolean; canSubmit?: boolean; waitingReason?: string; failure?: string };
  sessionStore: ChatSessionStore;
  interactions: { begin(kind: 'recovery', sessionId: string, phase: 'preparing_context'): { readonly operationId: string } | undefined;
    finish(operation: { readonly operationId: string }): boolean };
  publishStartupComposer(): Promise<void>;
  dispose(): void;
}

interface Harness {
  host: StartupHost;
  storage: GlobalSessionStorage;
  posts: Array<Record<string, unknown>>;
  dispose(): Promise<void>;
}

async function withHost<T>(work: () => Promise<T>): Promise<T> {
  const previousWindow = { ...vscode.window };
  const previousIsTrusted = vscode.workspace.isTrusted;
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  const previousWarn = console.warn;
  const previousError = console.error;
  Object.assign(vscode as unknown as Record<string, unknown>, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.workspace as unknown as Record<string, unknown>, { isTrusted: true });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined
  });
  console.warn = () => undefined;
  console.error = () => undefined;
  try { return await work(); } finally {
    Object.assign(vscode.window, previousWindow);
    Object.assign(vscode.workspace as unknown as Record<string, unknown>, { isTrusted: previousIsTrusted });
    if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
    console.warn = previousWarn; console.error = previousError;
  }
}

/** Exactly what extension.ts does: the already-started store initialization
 * Promise is handed to the provider. */
async function startProvider(root: string): Promise<Harness> {
  const uri = vscode.Uri.file(root);
  const scope = { key: SCOPE_KEY, name: 'case', folderUris: [SCOPE_KEY] };
  const storage = new GlobalSessionStorage(uri as never);
  const sessionStore = new ChatSessionStore(storage, 'en', scope);
  const initialization = sessionStore.initialize({ fresh: true });
  await initialization.catch(() => undefined);
  const provider = new KeepseekChatViewProvider(
    uri as never,
    sessionStore,
    uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    initialization
  );
  const host = provider as unknown as StartupHost & { views?: Set<unknown> };
  const posts: Array<Record<string, unknown>> = [];
  host.views?.add({ webview: { postMessage(message: Record<string, unknown>) { posts.push(message); return Promise.resolve(true); } } });
  return {
    host, storage, posts,
    async dispose() {
      (provider as unknown as { dispose(): void }).dispose();
      await storage.flush().catch(() => undefined);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { await rm(root, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
    }
  };
}

async function seedActiveSession(root: string): Promise<string> {
  const uri = vscode.Uri.file(root);
  const storage = new GlobalSessionStorage(uri as never);
  const scope = { key: SCOPE_KEY, name: 'case', folderUris: [SCOPE_KEY] };
  const store = new ChatSessionStore(storage, 'en', scope);
  await store.initialize();
  const session = store.getActiveSession();
  session.messages.push({ id: 'message-1', role: 'user', content: 'hello', createdAt: new Date().toISOString() } as never);
  session.title = 'Existing conversation';
  await store.persist();
  await storage.flush();
  return session.id;
}

/** A lease whose owning process is gone: what a crash or a killed extension
 * host leaves behind between restarts. */
async function writeStaleUseRecord(root: string, sessionId: string): Promise<void> {
  const directory = path.join(root, 'session-deletions', 'v1', 'uses', createHash('sha256').update(sessionId).digest('hex'));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'stale-0000.json'), JSON.stringify({
    version: 1, pid: 0x7ffffff, token: 'stale-0000', workspaceKey: SCOPE_KEY, sessionId
  }));
}

function sessionShardPath(root: string, sessionId: string): string {
  const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
  return path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(SCOPE_KEY), 'sessions', `${hash}.json`);
}

test('startup succeeds when recovery only probes storage paths that do not exist', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-startup-missing-'));
  const sessionId = await seedActiveSession(root);
  await writeStaleUseRecord(root, sessionId);
  await withHost(async () => {
    const h = await startProvider(root);
    t.after(() => h.dispose());
    await h.host.initializeAfterWebviewReady();
    assert.equal(h.host.commandSettingsReadiness.executionMode, 'ready', 'session loading must not fail');
    assert.notEqual(h.host.interactionSnapshot(1).failure, 'Session loading failed. Reload the window to retry.');
    assert.notEqual(h.host.getStartupState().phase, 'startup-error');
  });
});

/** A live allocation in this host error shape: no live session has this tombstone. */
test('a missing deletion record is ordinary history in the provider error shape', async () => {
  const missingError = new Error("ENOENT: no such file or directory, stat '/Users/kermit/Library/Application Support/com.kmvdata.keepseek/session-deletions/v1/deleted/9f1c1a64fc75cb61867393e350252bf90e7e727248833406408ebf1a5027c97.json'");
  assert.equal(missing(missingError), true, 'the provider omits code; the message still proves a vanished path');
  assert.equal(missing(new Error('EPERM: operation not permitted, stat x.json')), false, 'an unreadable record stays an error');
  assert.equal(missing({ code: 'FileNotFound', errno: -2 }), true);
  assert.equal(missing({ code: 'FileNotFound', errno: -13 }), false);
  assert.equal(missing({ code: 'ENOENT' }), true);
});

/** A second project the same installation never opened in this window. */
async function seedOtherProjectSession(): Promise<void> {
  const otherRoot = await mkdtemp(path.join(tmpdir(), 'keepseek-startup-other-'));
  try {
    const otherScope = { key: CASE_KEY, name: 'other-case', folderUris: [CASE_KEY] };
    const otherStorage = new GlobalSessionStorage(vscode.Uri.file(otherRoot) as never);
    const otherStore = new ChatSessionStore(otherStorage, 'en', otherScope);
    await otherStore.initialize();
    const session = otherStore.getActiveSession();
    session.messages.push({ id: 'other-message', role: 'user', content: 'other project', createdAt: new Date().toISOString() } as never);
    await otherStore.persist();
    await otherStorage.flush();
  } finally {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try { await rm(otherRoot, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
    }
  }
}

/** Every open starts a brand-new conversation: the seeded body is history only. */
test('startup opens a new conversation and never restores the previous one', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-startup-fresh-'));
  const seededId = await seedActiveSession(root);
  await withHost(async () => {
    const h = await startProvider(root);
    t.after(() => h.dispose());
    const active = h.host.sessionStore.getActiveSession();
    assert.notEqual(active.id, seededId, 'startup must not select the stored conversation');
    assert.equal(active.messages.length, 0, 'the composer starts empty');
    const summaries = h.host.sessionStore.getSessionSummaries();
    assert.ok(summaries.some(summary => summary.id === seededId), 'previous conversations stay listed as history');
    assert.ok(!summaries.some(summary => summary.id === active.id), 'a blank conversation is not history');
    await h.host.initializeAfterWebviewReady();
    assert.notEqual(h.host.sessionStore.getActiveSession().id, seededId, 'the final load keeps the new conversation');
    assert.equal(h.host.sessionStore.getActiveSession().messages.length, 0);
  });
});

/** The composer is usable, and reports why sending still waits, before recovery finishes. */
test('the composer accepts input before recovery stores finish loading', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-startup-composer-'));
  await seedActiveSession(root);
  await withHost(async () => {
    const h = await startProvider(root);
    t.after(() => h.dispose());
    const operation = h.host.interactions.begin('recovery', h.host.sessionStore.activeSessionId, 'preparing_context');
    assert.ok(operation, 'the test holds the only startup owner');
    try {
      await h.host.publishStartupComposer();
      const early = h.host.interactionSnapshot(1);
      assert.equal(early.sessionId, h.host.sessionStore.activeSessionId, 'the new conversation is addressable while loading');
      assert.equal(early.canEdit, true, 'typing is never gated by startup');
      assert.equal(early.canSubmit, false, 'sending waits for verified recovery stores');
      assert.equal(early.waitingReason, 'recovery', 'the wait reports recovery, not a session switch');
    } finally {
      h.host.interactions.finish(operation);
    }
  });
});

/** The warm-up read is display-only and can never leak another project. */
test('the startup history warm-up lists history without selecting or writing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-startup-warm-'));
  const seededId = await seedActiveSession(root);
  await seedOtherProjectSession();
  const indexUri = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(SCOPE_KEY), 'index.json');
  const before = await readFile(indexUri, 'utf8');
  await withHost(async () => {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    const store = new ChatSessionStore(storage, 'en', { key: SCOPE_KEY, name: 'case', folderUris: [SCOPE_KEY] });
    const activeBefore = store.getActiveSession().id;
    await store.warmUpHistorySummaries();
    const summaries = store.getSessionSummaries();
    assert.ok(summaries.some(summary => summary.id === seededId));
    assert.ok(!summaries.some(summary => summary.workspaceKey === CASE_KEY), 'another project never enters this list');
    assert.equal(store.getActiveSession().id, activeBefore, 'warm-up never selects a conversation');
    assert.equal(store.getActiveSession().messages.length, 0);
    store.dispose();
  });
  assert.equal(await readFile(indexUri, 'utf8'), before, 'the warm-up read never rewrites the index');
});

test('history cleanup removes the shard it reports as removed', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-cleanup-shard-'));
  const sessionId = await seedActiveSession(root);
  await withHost(async () => {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    const catalog = await storage.readHistoryCleanupCatalog(SCOPE_KEY);
    const target = catalog.entries.find(entry => entry.id === sessionId);
    assert.ok(target, 'the seeded session is in the cleanup catalog');
    const result = await storage.deleteHistoryCleanupTarget(target, 'operation-1');
    assert.equal(result.status, 'removedPendingCleanup', 'cleanup must commit: ' + JSON.stringify(result));
    await assert.rejects(readFile(sessionShardPath(root, sessionId)), 'the deleted shard must be gone');
  });
});

test('reading a workspace index never rewrites it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-index-read-'));
  await seedActiveSession(root);
  // A committed tombstone whose record the reader may not parse must drop only
  // that session; filtering is a read and must not rewrite the index.
  const deletions = path.join(root, 'session-deletions', 'v1', 'deleted');
  await mkdir(deletions, { recursive: true });
  const ghost = 'ghost-session-id';
  await writeFile(path.join(deletions, `${createHash('sha256').update(ghost).digest('hex')}.json`), JSON.stringify({
    version: 1, workspaceKey: SCOPE_KEY, sessionId: ghost, operationId: 'op', confirmedAt: new Date().toISOString(), phase: 'committed'
  }));
  const indexUri = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(SCOPE_KEY), 'index.json');
  const before = await readFile(indexUri, 'utf8');
  await withHost(async () => {
    const storage = new GlobalSessionStorage(vscode.Uri.file(root) as never);
    await storage.loadWorkspaceSessions(SCOPE_KEY);
    await new Promise(resolve => setTimeout(resolve, 10));
  });
  assert.equal(await readFile(indexUri, 'utf8'), before, 'listing history must not rewrite the index');
});