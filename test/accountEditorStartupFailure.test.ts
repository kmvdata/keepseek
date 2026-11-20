import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { getScript } from '../src/webview/script';
import * as vscode from './stubs/vscode';

const SCOPE_KEY = 'folders:file:///d%3A/Projects/account-editor';

interface EditorHost {
  initializeAfterWebviewReady(): Promise<void>;
  getStartupState(): { phase: string };
  interactionSnapshot(revision: number): { canChangeContext?: boolean; failure?: string; blockingReason?: string; phase?: string };
  commandSettingsReadiness: Record<string, string>;
  sessionStore: ChatSessionStore;
  // Simulate the safety-recovery store failing at startup.
  changeSets: { initialize(): Promise<void>; loadSession(sessionId: string): Promise<void> };
  draftRuns: { initialize(): Promise<void> };
  safetyRecoveryFailure?: string;
  dispose(): void;
}

/** Model-source editing is host-side bookkeeping: it sends no Provider request
 * and starts no task, so a failed startup recovery must never disable it. That
 * coupling was a hard deadlock: with no account configured, adding the first
 * one was gated behind the very readiness the missing account kept broken. */
test('a failed startup recovery keeps model-source editing available and names the cause', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-account-editor-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });

  const previousWindow = { ...vscode.window };
  Object.assign(vscode as unknown as Record<string, unknown>, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined
  });
  t.after(() => { Object.assign(vscode.window, previousWindow); });

  const uri = vscode.Uri.file(root);
  const scope = { key: SCOPE_KEY, name: 'account-editor', folderUris: [SCOPE_KEY] };
  const storage = new GlobalSessionStorage(uri as never);
  const sessionStore = new ChatSessionStore(storage, 'en', scope);
  const initialization = sessionStore.initialize({ fresh: true });
  await initialization.catch(() => undefined);

  const provider = new KeepseekChatViewProvider(
    uri as never, sessionStore, uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    initialization
  );
  const view = { webview: { postMessage: async () => true } };
  (provider as unknown as { views?: Set<unknown> }).views?.add(view);
  t.after(() => (provider as unknown as { dispose(): void }).dispose());

  const host = provider as unknown as EditorHost;
  // The safety-recovery store cannot be read: this is the condition that used to
  // leave the window on a bare reload prompt with every model control disabled.
  const failure = "EACCES: permission denied, open 'draft-runs.json'";
  host.changeSets.initialize = async () => { throw new Error(failure); };
  host.draftRuns.initialize = async () => { throw new Error(failure); };

  await host.initializeAfterWebviewReady().catch(() => undefined);

  assert.equal(host.commandSettingsReadiness.approvalMode, 'error', 'the failed safety stage is recorded');
  assert.equal(host.getStartupState().phase, 'startup-error', 'the window reports a startup error');
  assert.equal(host.safetyRecoveryFailure?.includes('EACCES'), true, 'the cause is kept, not discarded');

  const snapshot = host.interactionSnapshot(1);
  const reported = String(snapshot.failure ?? snapshot.blockingReason ?? '');
  assert.match(reported, /EACCES/u, 'the user sees the real cause instead of a bare reload prompt');
  assert.match(reported, /操作记录恢复失败|Safety recovery failed/u, 'the failing stage is named');
  assert.equal(snapshot.canChangeContext, false, 'project-context mutation stays gated (unchanged behaviour)');

  // The regression itself: the account editor must not consult canChangeContext.
  const script = getScript();
  assert.doesNotMatch(script, /runBusy\s*=\s*!canChangeContext\(\)/u,
    'the model-source editor is no longer bound to conversation readiness');
  assert.match(script, /function accountSettingsWritable\(\)/u, 'the editor owns its own concurrency predicate');
  assert.match(script, /if \(accountSettingsWritable\(\)\) \{ return false; \}/u,
    'saving a source is admitted while startup recovery is degraded');
});