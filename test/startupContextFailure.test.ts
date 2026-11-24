import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { getScript } from '../src/webview/script';
import * as vscode from './stubs/vscode';

const SCOPE_KEY = 'folders:file:///d%3A/Projects/context-failure';

interface ContextHost {
  initializeAfterWebviewReady(): Promise<void>;
  getStartupState(): { phase: string };
  interactionSnapshot(revision: number): { failure?: string; canEdit?: boolean; blockingReason?: string };
  sessionStore: ChatSessionStore;
  sharedProjectSources: { refresh(sessionId: string, cwd?: string): Promise<never> };
  selectSession(sessionId: string): Promise<void>;
  interactionFailure?: { sessionId: string; message: string };
  runContextReadiness: string;
  runContextFailure?: string;
  dispose(): void;
}

function withWindow<T>(work: () => Promise<T>): Promise<T> {
  const previousWindow = { ...vscode.window };
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  Object.assign(vscode as unknown as Record<string, unknown>, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined
  });
  return work().finally(() => {
    Object.assign(vscode.window, previousWindow);
    if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  });
}

async function startHost(root: string): Promise<ContextHost> {
  const uri = vscode.Uri.file(root);
  const scope = { key: SCOPE_KEY, name: 'ctx', folderUris: [SCOPE_KEY] };
  const storage = new GlobalSessionStorage(uri as never);
  const sessionStore = new ChatSessionStore(storage, 'en', scope);
  const initialization = sessionStore.initialize({
    fresh: true
  });
  await initialization.catch(() => undefined);
  const provider = new KeepseekChatViewProvider(
    uri as never, sessionStore, uri as never,
    { keys: () => [], get: (_key: string, fallback: unknown) => fallback, update: async () => undefined } as never,
    { displayName: 'KeepSeek', version: 'test', publisher: 'keepseek', author: 'keepseek', repositoryUrl: '', license: 'MIT' },
    initialization
  );
  const view = { webview: { postMessage: async () => true } };
  (provider as unknown as { views?: Set<unknown> }).views?.add(view);
  return provider as unknown as ContextHost;
}

/** Startup loads project instructions when the conversation it opens already has
 * messages. A failure there used to be reported only as "some startup data
 * failed to load": the cause was caught and thrown away, so the banner named no
 * stage and gave nothing to act on. The cause now survives into the state. */
test('a startup project-context failure keeps its cause instead of a bare reload hint', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-context-failure-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }).catch(() => undefined); });
  await withWindow(async () => {
    const host = await startHost(root);
    t.after(() => host.dispose());
    // Startup inspects the conversation it opened; give it one real message so the
    // project-context stage runs instead of deferring for an empty composer.
    host.sessionStore.getActiveSession().messages.push(
      { id: 'm1', role: 'user', content: 'hi', createdAt: new Date().toISOString() } as never);
    const failure = "EACCES: permission denied, open 'AGENTS.md'";
    host.sharedProjectSources.refresh = async () => { throw new Error(failure); };
    await host.initializeAfterWebviewReady().catch(() => undefined);

    assert.equal(host.runContextReadiness, 'error', 'the failed context stage is recorded as degraded');
    assert.equal(host.runContextFailure, failure, 'the cause is kept, not discarded');
    const snapshot = host.interactionSnapshot(1);
    const reported = String(snapshot.failure ?? snapshot.blockingReason ?? '');
    assert.match(reported, /EACCES/u, 'the user sees the real cause, not an unexplained reload prompt');
    assert.match(reported, /AGENTS\.md/u, 'the failing path is named');
    assert.equal(snapshot.canEdit, true, 'only project context is degraded; the draft stays editable');
  });
});

test('startup settings keep the empty composer lightweight', () => {
  // There are no plan cards anymore, so a startup settings patch can only change
  // the composer's availability. It must never trigger a full transcript redraw:
  // that is what keeps the empty composer cheap while models are still loading.
  const script = getScript();
  const start = script.indexOf('function handleKeepseekHostMessage(');
  const end = script.indexOf('function applyAgentRunStreamPatch(', start);
  assert.ok(start > 0 && end > start);
  const sessionId = 'session';
  const state = { activeSessionId: sessionId, interaction: { sessionId, canSubmit: false } };
  let redraws = 0;
  let composerRefreshes = 0;
  const handle = runInNewContext(script.slice(start, end) + ';handleKeepseekHostMessage', {
    state, lastStateRevision: 0, window: {}, changeVisibleSession() {}, rememberTerminalAgentActivity() {},
    renderStatus() {}, syncSendButtonAvailability() { composerRefreshes++; },
    render() { redraws++; }
  }) as (event: { data: unknown }) => void;
  const send = (revision: number, canSubmit: boolean) => handle({ data: {
    type: 'statePatch', scope: 'startupSettings', revision,
    state: { activeSessionId: sessionId, interaction: { sessionId, canSubmit } }
  } });

  send(1, false);
  send(2, true);
  send(1, false); // a late update cannot revoke availability that already arrived
  assert.equal(redraws, 0, 'a startup patch never redraws the transcript');
  assert.equal(composerRefreshes, 2, 'only the composer is refreshed, once per accepted revision');
});
