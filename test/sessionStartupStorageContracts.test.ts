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
import { missing, SessionDeletionAuthority } from '../src/sessions/sessionDeletionAuthority';
import * as vscode from './stubs/vscode';

const SCOPE_KEY = 'folders:file:///d%3A/Projects/case';
/** A distinct project identity that this same installation never opens. */
const CASE_KEY = 'folders:file:///d%3A/Projects/other-case';

interface StartupHost {
  initializeAfterWebviewReady(): Promise<void>;
  commandSettingsReadiness: Record<string, string>;
  getStartupState(): { phase: string };
  interactionSnapshot(revision: number): { sessionId?: string; canEdit?: boolean; canSubmit?: boolean; canNavigate?: boolean; waitingReason?: string; failure?: string; blockingReason?: string };
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

/** The report shape: VS Code's own `stat` failure for a tombstone that was
 * never written. No safety directory exists before the first deletion, so this
 * probe describes ordinary live history, not a damaged or deleted session. */
test('vscode FileSystemError shapes for an absent record stay ordinary history', () => {
  const path = "cannot be found (Error: ENOENT: no such file or directory, stat 'C:\\Users\\k\\AppData\\Local\\com.kmvdata.keepseek\\session-deletions\\v1\\deleted\\f19cf1.json')";
  assert.equal(missing(new Error(path)), true, 'the vscode stat message proves a vanished path');
  assert.equal(missing(Object.assign(new Error(path), { code: 'Unknown', name: 'EntryNotFound (FileSystemError)' })), true,
    'a named FileSystemError carrying ENOENT is still an absent record');
  assert.equal(missing(Object.assign(new Error('cannot be found (Error: EPERM: operation not permitted, stat x.json)'),
    { code: 'Unknown', name: 'NoPermissions (FileSystemError)' })), false,
  'a FileSystemError that is not ENOENT stays an error');
  assert.equal(missing(new Error('access denied while reading the record')), false);
});

/** Absent safety directories are the ordinary first-run state: reading them
 * must report "nothing deleted" and must never fail session loading. */
test('a never-initialized deletion layout reports no pending deletions', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-deletions-absent-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const authority = new SessionDeletionAuthority(vscode.Uri.file(root) as never);
  assert.deepEqual(await authority.listPending(), [], 'an absent journal directory is an empty journal');
  assert.equal(await authority.hasRecord('live-session'), false);
  assert.equal(await authority.isSessionIdDeleted('live-session'), false);
  assert.equal(await authority.readRecord('live-session'), undefined);
  assert.equal(await authority.inspectUse(SCOPE_KEY, 'live-session'), false, 'absent use ownership is not a lock');
});

/** The first deletion creates the layout instead of failing on it. */
test('the first committed deletion creates the journal layout', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-deletions-create-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const authority = new SessionDeletionAuthority(vscode.Uri.file(root) as never);
  const record = { version: 1 as const, workspaceKey: SCOPE_KEY, sessionId: 'first-deletion',
    operationId: 'operation-1', confirmedAt: new Date().toISOString(), phase: 'committed' as const };
  await authority.commitDeletion(record);
  assert.equal(await authority.hasRecord('first-deletion'), true);
  assert.deepEqual((await authority.listPending()).map(item => item.sessionId), ['first-deletion']);
  await assert.rejects(() => authority.assertSessionIdWritable('first-deletion'), /permanently deleted/);
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

/** Other windows enter and leave the same gate continuously. A snapshot that
 * lands between an owner's write and its rename, or loses a participant to a
 * racing unlink, describes a racing *other* participant: it must be retried,
 * never reported as a damaged gate that dead-ends startup. */
test('a gate whose participant is not yet committed is retried instead of failing', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-gate-race-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const authority = new SessionDeletionAuthority(vscode.Uri.file(root) as never);
  const sessionId = 'race-session';
  const gateDirectory = path.join(root, 'session-deletions', 'v1', 'gates',
    createHash('sha256').update(`session:${sessionId}`).digest('hex'));
  await mkdir(gateDirectory, { recursive: true });
  // Exactly what another process leaves between its writeFile and rename: a
  // record that exists but is not yet a valid, fully committed participant.
  const racingToken = '00000000-0000-4000-8000-000000000000';
  const racingRecord = path.join(gateDirectory, `${racingToken}.json`);
  await writeFile(racingRecord, '{"version":1,"pid":');
  const settled = (async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    await writeFile(racingRecord, JSON.stringify({
      version: 1, pid: 0x7ffffff, token: racingToken, choosing: false, ticket: 1
    }));
  })();
  const result = await authority.withSessionIdGate(sessionId, async () => 'entered');
  await settled;
  assert.equal(result, 'entered', 'an in-flight participant write must not fail the gate');
});

/** Session loading selects history only. When it fails, the window must still
 * offer a blank conversation the user can type into and see the real cause:
 * an unusable composer is never an acceptable fallback. */
test('a failed session load keeps the composer usable and names the cause', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-startup-store-failure-'));
  await seedActiveSession(root);
  await withHost(async () => {
    const uri = vscode.Uri.file(root);
    const scope = { key: SCOPE_KEY, name: 'case', folderUris: [SCOPE_KEY] };
    const storage = new GlobalSessionStorage(uri as never);
    const sessionStore = new ChatSessionStore(storage, 'en', scope);
    // The exact failure from the report: a startup read that could not be
    // verified must not be mistaken for an empty history of a broken window.
    const initialization = Promise.reject(new Error(
      "ENOENT: no such file or directory, stat '" + path.join(root, 'session-deletions', 'v1', 'deleted', 'missing.json') + "'"));
    await initialization.catch(() => undefined);
    const provider = new KeepseekChatViewProvider(
      uri as never, sessionStore, uri as never,
      { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } as never,
      { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
      initialization
    );
    t.after(async () => {
      (provider as unknown as { dispose(): void }).dispose();
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    });
    const host = provider as unknown as StartupHost;
    await host.initializeAfterWebviewReady().catch(() => undefined);
    const started = host.getStartupState();
    const interaction = host.interactionSnapshot(1);
    assert.equal(interaction.canEdit, true, 'a draft stays editable when history cannot be read');
    assert.equal(interaction.sessionId, sessionStore.getActiveSession().id,
      'the blank conversation stays addressable so the user can type and keep a draft');
    const reported = String(interaction.failure ?? interaction.blockingReason);
    assert.match(reported, /ENOENT/, 'the real cause is reported, not a bare retry hint');
    assert.match(reported, /new task|新建任务/, 'the message says a new task can still start');
    assert.match(reported, /unavailable|不可用/, 'history, not the window, is named as unavailable');
    // Navigation is not what the failure broke: the composer, not the window, decides.
    assert.equal(host.commandSettingsReadiness.executionMode, 'error', 'the degraded part stays visible');
    assert.notEqual(started.phase, 'ready');
  });
});

/** A gate that stays unreadable is still reported, with the cause attached. */
test('a permanently damaged gate reports the cause it observed', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-gate-damaged-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  const authority = new SessionDeletionAuthority(vscode.Uri.file(root) as never);
  const sessionId = 'damaged-session';
  const gateDirectory = path.join(root, 'session-deletions', 'v1', 'gates',
    createHash('sha256').update(`session:${sessionId}`).digest('hex'));
  await mkdir(gateDirectory, { recursive: true });
  await writeFile(path.join(gateDirectory, 'corrupt-token.json'), '{"version":1,"token":"other-token"}');
  await assert.rejects(
    () => authority.withSessionIdGate(sessionId, async () => 'entered'),
    /Storage gate ownership cannot be verified/,
    'a participant that never becomes valid must not be silently ignored'
  );
});