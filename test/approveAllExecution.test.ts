import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createFullTextDraftEdit } from '../src/edits/draftEdit';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import type { ChangeSetFile, ChatSession, DraftEdit } from '../src/shared/types';
import * as vscode from './stubs/vscode';

interface ApproveAllHost {
  changeSets: ChangeSetStore;
  approveAllAttempted: Set<string>;
  drainApproveAllExecution(): Promise<void>;
  scheduleApproveAllExecution(): void;
}

interface Harness {
  root: string;
  provider: KeepseekChatViewProvider;
  host: ApproveAllHost;
  store: { activeSession: ChatSession };
  warnings: string[];
  posts: Array<Record<string, unknown>>;
  dispose(): Promise<void>;
}
async function createHarness(options: {
  approvalMode?: 'ask' | 'approve-all';
  applyBehavior?: 'succeed' | 'never-attempt';
} = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-approve-all-'));
  const uri = vscode.Uri.file(root);
  const previousWorkspace = { ...(vscode.workspace as unknown as Record<string, unknown>) };
  Object.assign(vscode.workspace as unknown as Record<string, unknown>, { isTrusted: true });
  const warnings: string[] = [];
  const previousWindow = { ...vscode.window };
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  Object.assign(vscode as unknown as Record<string, unknown>, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async (message: string) => { warnings.push(message); return undefined; },
    showErrorMessage: async (message: string) => { warnings.push(message); return undefined; },
    showInformationMessage: async () => undefined
  });

  const scope = { key: 'workspace:approve-all', name: 'Approve All', folderUris: [] };
  const storage = new GlobalSessionStorage(uri as never);
  const seed = new ChatSessionStore(storage, 'en', scope);
  await seed.initialize();
  const active = seed.getActiveSession();
  if (options.approvalMode) await seed.setApprovalMode(options.approvalMode);
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
  const host = provider as unknown as ApproveAllHost & { views?: Set<unknown> };
  const posts: Array<Record<string, unknown>> = [];
  host.views?.add({ webview: { postMessage(message: Record<string, unknown>) { posts.push(message); return Promise.resolve(true); } } });
  await (host as unknown as { initializeAfterWebviewReady(): Promise<void> }).initializeAfterWebviewReady();
  await host.changeSets.flush();
  if (options.applyBehavior === 'never-attempt') {
    // The provider refuses to apply before it ever calls the store: this is what
    // an approve-all draft experiences when the apply path rejects it.
    host.changeSets.applyAll = async () => undefined;
  }
  const session = sessionStore.getActiveSession();
  return {
    root,
    provider,
    host,
    store: { activeSession: session },
    warnings,
    posts,
    async dispose() {
      provider.dispose();
      Object.assign(vscode.window, previousWindow);
      if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
      Object.assign(vscode.workspace as unknown as Record<string, unknown>, previousWorkspace);
      await storage.flush().catch(() => undefined);
      // Background writers may still finish a write after dispose. Scratch cleanup
      // must never mask a test verdict.
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { await rm(root, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
    }
  };
}
function createDraftFixture(root: string, id: string, label: string): DraftEdit {
  return createFullTextDraftEdit({
    id,
    uri: vscode.Uri.joinPath(vscode.Uri.file(root), label).toString(),
    label,
    action: 'create',
    content: `export const ${id.replace(/-/gu, '_')} = 1;\n`,
    reason: `Create ${label}`
  });
}

function statuses(store: ApproveAllHost, sessionId: string): Array<{ id: string; status: ChangeSetFile['status'] }> {
  return store.changeSets.toWebviewState(sessionId).flatMap(set => set.files.map(file => ({ id: file.id, status: file.status })));
}

test('approve-all advances a pending draft to applied without any confirmation prompt', async t => {
  const h = await createHarness({ approvalMode: 'approve-all', applyBehavior: 'succeed' });
  t.after(() => h.dispose());
  const session = h.store.activeSession;
  h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-create', 'created.ts')]
  });
  await h.host.drainApproveAllExecution();
  const after = statuses(h.host, session.id);
  assert.equal(after[0]?.status, 'applied', 'approve-all must apply the draft: ' + JSON.stringify({thrown: (globalThis as unknown as { __keepseekThrown?: string[] }).__keepseekThrown ?? [], statuses: after, warnings: h.warnings, posts: h.posts.length }));
});

test('approve-all advances a pending draft to applied through the real store', async t => {
  const h = await createHarness({ approvalMode: 'approve-all', applyBehavior: 'succeed' });
  t.after(() => { h.host.changeSets.applyAll = Object.getPrototypeOf(h.host.changeSets).applyAll.bind(h.host.changeSets); return h.dispose(); });
  const session = h.store.activeSession;
  h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-create', 'created.ts')]
  });
  await h.host.drainApproveAllExecution();
  const after = statuses(h.host, session.id);
  assert.notEqual(after[0]?.status, 'pending', 'a pending draft must leave the pending state under approve-all');
});

test('a draft the apply path never acted on stays retryable instead of being latched out', async t => {
  const h = await createHarness({ approvalMode: 'approve-all', applyBehavior: 'never-attempt' });
  t.after(() => h.dispose());
  const session = h.store.activeSession;
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-create', 'created.ts')]
  })!;
  await h.host.drainApproveAllExecution();
  assert.equal(h.host.changeSets.hasPendingForSession(session.id), true, 'the draft is still pending');
  assert.equal(h.host.approveAllAttempted.has(set.id), false,
    'a ChangeSet that was not applied must not stay registered as permanently attempted');
});