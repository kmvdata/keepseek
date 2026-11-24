import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import type { SessionRunStatusView } from '../src/provider/sessionRunStatus';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import type { ChatSession } from '../src/shared/types';
import * as vscode from './stubs/vscode';

/**
 * Contract for the history row's square button on the Host side.
 *
 * The Webview half (glyph + `dismissSessionRun` message) is already fixed by the
 * session-list tests, and this file pins the half that was missing: the Host owns
 * the decision. A finished row leaves without a prompt, a live row asks first and
 * a cancel writes nothing at all, and leaving either way is expressed as a session
 * header marker — never by touching the append-only history.
 */

interface DismissHost {
  sessionRuns: {
    tryStart(sessionId: string): { release(): void } | undefined;
    isRunning(sessionId: string): boolean;
  };
  runAbortControllers: Map<string, AbortController>;
  sessionRunStatusViews(): Record<string, SessionRunStatusView>;
  dismissSessionRun(sessionId: string): Promise<void>;
}

interface Harness {
  root: string;
  provider: KeepseekChatViewProvider;
  host: DismissHost;
  sessionStore: ChatSessionStore;
  session: ChatSession;
  warnings: string[];
  dispose(): Promise<void>;
}

async function createHarness(confirmAction?: string): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-session-run-dismissal-'));
  const uri = vscode.Uri.file(root);
  const previousWorkspace = { ...(vscode.workspace as unknown as Record<string, unknown>) };
  Object.assign(vscode.workspace as unknown as Record<string, unknown>, {
    isTrusted: true,
    workspaceFolders: [{ uri, name: 'fixture', index: 0 }]
  });
  const warnings: string[] = [];
  const previousWindow = { ...vscode.window };
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    // The modal is the only confirmation surface: returning the action label is
    // the user confirming, anything else is a cancel.
    showWarningMessage: async (message: string) => { warnings.push(message); return confirmAction; },
    showErrorMessage: async (message: string) => { warnings.push(message); return undefined; },
    showInformationMessage: async () => undefined
  });
  Object.assign(vscode as unknown as Record<string, unknown>, { StatusBarAlignment: { Left: 1, Right: 2 } });

  const scope = { key: 'workspace:session-run-dismissal', name: 'Session Run Dismissal', folderUris: [] };
  const storage = new GlobalSessionStorage(uri as never);
  const seed = new ChatSessionStore(storage, 'en', scope);
  await seed.initialize();
  await seed.persist();

  const sessionStore = new ChatSessionStore(storage, 'en', scope);
  const initialization = sessionStore.initialize();
  await initialization.catch(() => undefined);

  const provider = new KeepseekChatViewProvider(
    uri as never,
    sessionStore,
    uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    initialization
  );
  const host = provider as unknown as DismissHost & { views?: Set<unknown> };
  host.views?.add({ webview: { postMessage(_message: Record<string, unknown>) { return Promise.resolve(true); } } });
  await (host as unknown as { initializeAfterWebviewReady(): Promise<void> }).initializeAfterWebviewReady();

  // One archived run is enough to prove the projection: it is the durable shape a
  // finished conversation keeps after its checkpoint was archived, and it carries
  // no timestamp, so the marker rests on the message id alone.
  const session = sessionStore.getActiveSession();
  session.messages.push({
    id: 'run-1',
    role: 'assistant',
    content: 'done',
    createdAt: '2024-01-01T00:00:00.000Z',
    runCheckpointArchive: {
      version: 1,
      objectHash: 'archive-hash',
      summary: {
        taskId: 'task-1',
        status: 'completed',
        usedMs: 1,
        maxExecutionMs: 1000,
        limitSource: 'test',
        attempt: 1,
        modelRequests: 1,
        retries: 0
      }
    }
  } as never);
  await sessionStore.persist();

  return {
    root,
    provider,
    host,
    sessionStore,
    session,
    warnings,
    async dispose() {
      provider.dispose();
      Object.assign(vscode.window, previousWindow);
      Object.assign(vscode.workspace as unknown as Record<string, unknown>, previousWorkspace);
      await storage.flush().catch(() => undefined);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { await rm(root, { recursive: true, force: true }); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
    }
  };
}

test('a finished run leaves the running list without asking and keeps its history', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());

  assert.equal(h.host.sessionRunStatusViews()[h.session.id]?.kind, 'completed',
    'the fixture starts as a finished row');

  await h.host.dismissSessionRun(h.session.id);

  assert.deepEqual(h.warnings, [], 'a finished row needs no confirmation');
  const marker = h.sessionStore.getSessionById(h.session.id)?.runStatusDismissal;
  assert.equal(marker?.version, 1, 'the marker is header state in the current format');
  assert.equal(marker?.messageId, 'run-1', 'the marker names the message the projection read');
  assert.equal(marker?.proofAt, undefined, 'an archived run carries no timestamp to bind');
  assert.equal(h.host.sessionRunStatusViews()[h.session.id]?.kind, 'idle',
    'the row reads as idle immediately');
  assert.equal(h.session.messages.length, 1, 'the append-only history is never rewritten');
});

test('cancelling the confirmation of a live row changes nothing', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const controller = new AbortController();
  h.host.runAbortControllers.set(h.session.id, controller);
  const handle = h.host.sessionRuns.tryStart(h.session.id);
  assert.ok(handle, 'the fixture must be able to claim the run');
  t.after(() => handle?.release());

  assert.equal(h.host.sessionRunStatusViews()[h.session.id]?.kind, 'running',
    'a live run is the solid-square case');
  const updatedAt = h.session.updatedAt;

  await h.host.dismissSessionRun(h.session.id);

  assert.equal(h.warnings.length, 1, 'a live row asks before it stops anything');
  assert.equal(h.sessionStore.getSessionById(h.session.id)?.runStatusDismissal, undefined,
    'cancel writes no marker');
  assert.equal(controller.signal.aborted, false, 'cancel aborts nothing');
  assert.equal(h.host.sessionRuns.isRunning(h.session.id), true, 'cancel keeps the run');
  assert.equal(h.session.updatedAt, updatedAt, 'cancel persists nothing');
  assert.equal(h.host.sessionRunStatusViews()[h.session.id]?.kind, 'running',
    'the row is still live');
});

test('confirming stops that session and leaves the row idle', async t => {
  const h = await createHarness('Stop and leave');
  t.after(() => h.dispose());
  const controller = new AbortController();
  h.host.runAbortControllers.set(h.session.id, controller);
  const handle = h.host.sessionRuns.tryStart(h.session.id);
  assert.ok(handle, 'the fixture must be able to claim the run');
  t.after(() => handle?.release());

  await h.host.dismissSessionRun(h.session.id);

  assert.deepEqual(h.warnings, [], 'a confirmed stop reports no blocked row');
  assert.equal(controller.signal.aborted, true, 'the session\'s own run is aborted');
  assert.equal(h.host.sessionRuns.isRunning(h.session.id), false, 'the run registry is released');
  assert.equal(h.sessionStore.getSessionById(h.session.id)?.runStatusDismissal?.messageId, 'run-1',
    'the marker names the run the user left');
  assert.equal(h.host.sessionRunStatusViews()[h.session.id]?.kind, 'idle',
    'the row leaves the running list');
  assert.equal(h.session.messages.length, 1, 'stopping never rewrites the history');
});
