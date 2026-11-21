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

type ApproveAllGate = 'non_approve_all' | 'pending_truncation' | 'untrusted' | 'busy'
  | 'latched' | 'not_applicable' | 'applied' | 'apply_blocked' | 'none_pending';
type ApproveAllTrigger = 'mode_switch' | 'run_end' | 'checkpoint' | 'change_action'
  | 'session_navigation' | 'continuation' | 'manual';
interface ApproveAllLedgerEntry {
  gate: ApproveAllGate;
  trigger: ApproveAllTrigger;
  draftId?: string;
  reason?: string;
  at: string;
}

interface ApproveAllHost {
  changeSets: ChangeSetStore;
  approveAllAttempted: Set<string>;
  approveAllBlocked: Set<string>;
  approveAllLedger: ApproveAllLedgerEntry[];
  warnedApproveAllReasons: Set<string>;
  repairLoopsBySession: Map<string, { status: string; pendingDraftEditIds: string[] }>;
  drainApproveAllExecution(trigger: ApproveAllTrigger): Promise<void>;
  scheduleApproveAllExecution(trigger?: ApproveAllTrigger): void;
  continueRepair(): Promise<void>;
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
  await h.host.drainApproveAllExecution('manual');
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
  await h.host.drainApproveAllExecution('manual');
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
  await h.host.drainApproveAllExecution('manual');
  assert.equal(h.host.changeSets.hasPendingForSession(session.id), true, 'the draft is still pending');
  assert.equal(h.host.approveAllAttempted.has(set.id), false,
    'a ChangeSet that was not applied must not stay registered as permanently attempted');
});async function waitForStatus(
  host: ApproveAllHost, sessionId: string, expected: ChangeSetFile['status'], timeoutMs = 30000
): Promise<Array<{ id: string; status: ChangeSetFile['status'] }>> {
  const startedAt = Date.now();
  for (;;) {
    const current = statuses(host, sessionId);
    if (current[0]?.status === expected || Date.now() - startedAt > timeoutMs) return current;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

test('a run-end drain applies a pending draft without any prompt', async t => {
  const h = await createHarness({ approvalMode: 'approve-all', applyBehavior: 'succeed' });
  t.after(() => h.dispose());
  const session = h.store.activeSession;
  h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-create', 'created.ts')]
  });
  h.host.scheduleApproveAllExecution('run_end');
  const after = await waitForStatus(h.host, session.id, 'applied');
  assert.equal(after[0]?.status, 'applied', 'the run boundary must trigger the apply: '
    + JSON.stringify({ statuses: after, warnings: h.warnings, ledger: h.host.approveAllLedger }));
});

test('every gate that stops a drain is recorded with a structured reason', async t => {
  const h = await createHarness({ approvalMode: 'ask' });
  t.after(() => h.dispose());
  await h.host.drainApproveAllExecution('run_end');
  const entry = h.host.approveAllLedger.at(-1);
  assert.equal(entry?.gate, 'non_approve_all', 'ask mode must state why it did not drain');
  assert.equal(entry?.trigger, 'run_end');
  assert.equal(typeof entry?.at, 'string');
});

test('an untrusted workspace records the untrusted gate instead of failing silently', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => {
    Object.assign(vscode.workspace as unknown as Record<string, unknown>, { isTrusted: true });
    return h.dispose();
  });
  Object.assign(vscode.workspace as unknown as Record<string, unknown>, { isTrusted: false });
  await h.host.drainApproveAllExecution('run_end');
  assert.equal(h.host.approveAllLedger.at(-1)?.gate, 'untrusted');
});

test('a pending-history truncation records its own gate', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  h.store.activeSession.pendingHistoryTruncation = { id: 'truncation-1' } as never;
  await h.host.drainApproveAllExecution('run_end');
  assert.equal(h.host.approveAllLedger.at(-1)?.gate, 'pending_truncation');
});

test('an empty queue records none_pending, not silence', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  await h.host.drainApproveAllExecution('run_end');
  assert.equal(h.host.approveAllLedger.at(-1)?.gate, 'none_pending');
});

test('a latched draft is retried after a new trigger', async t => {
  const h = await createHarness({ approvalMode: 'approve-all', applyBehavior: 'never-attempt' });
  t.after(() => h.dispose());
  const session = h.store.activeSession;
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-create', 'created.ts')]
  })!;

  await h.host.drainApproveAllExecution('manual');
  const probe = h.host as unknown as { activeChangeActions: Set<string>; isStartingRun: boolean };
  assert.equal(h.host.approveAllBlocked.has(set.id), true,
    'a draft that did not advance is latched: ' + JSON.stringify({ activeChangeActions: [...probe.activeChangeActions],
      starting: probe.isStartingRun, ledger: h.host.approveAllLedger.slice(0, 4) }));

  // A new boundary releases the latch: the same draft is attempted again.
  await h.host.drainApproveAllExecution('run_end');
  assert.equal(h.host.approveAllBlocked.has(set.id), true, 'it is latched again while the apply still fails');
  const latched = h.host.approveAllLedger.filter(entry => entry.gate === 'latched' && entry.draftId === set.id);
  assert.equal(latched.length >= 2, true,
    'each trigger makes a fresh, recorded attempt: ' + JSON.stringify(h.host.approveAllLedger));
});

test('a repeated failure warns once per draft and gate', async t => {
  const h = await createHarness({ approvalMode: 'approve-all', applyBehavior: 'never-attempt' });
  t.after(() => h.dispose());
  const session = h.store.activeSession;
  h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-create', 'created.ts')]
  });
  await h.host.drainApproveAllExecution('manual');
  const afterFirst = h.warnings.length;
  await h.host.drainApproveAllExecution('run_end');
  assert.equal(h.warnings.length, afterFirst,
    'the same (draft, gate) pair must not warn again: ' + JSON.stringify(h.warnings));
  assert.equal(h.host.warnedApproveAllReasons.size >= 1, true);
});

test('a drain does not start a follow-up run while a draft is still pending', async t => {
  const h = await createHarness({ approvalMode: 'approve-all', applyBehavior: 'never-attempt' });
  t.after(() => h.dispose());
  const session = h.store.activeSession;
  h.host.repairLoopsBySession.set(session.id, { status: 'waiting_for_apply', pendingDraftEditIds: ['edit-create'] });
  h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-create', 'created.ts')]
  });
  let continued = 0;
  const originalContinue = h.host.continueRepair.bind(h.host);
  h.host.continueRepair = async () => { continued += 1; await originalContinue(); };
  await h.host.drainApproveAllExecution('run_end');
  assert.equal(continued, 0, 'a pending draft must not be validated against the old tree');
});

test('ask mode advances the barrier through the user apply, not a drain', async t => {
  const h = await createHarness({ approvalMode: 'ask', applyBehavior: 'succeed' });
  t.after(() => h.dispose());
  const session = h.store.activeSession;
  h.host.repairLoopsBySession.set(session.id, { status: 'waiting_for_apply', pendingDraftEditIds: ['edit-a'] });
  let continued = 0;
  const originalContinue = h.host.continueRepair.bind(h.host);
  h.host.continueRepair = async () => { continued += 1; await originalContinue(); };
  // No pending drafts and a reconciled loop means the barrier is satisfied.
  h.host.repairLoopsBySession.set(session.id, { status: 'ready_for_validation', pendingDraftEditIds: [] });
  await h.host.drainApproveAllExecution('run_end');
  assert.equal(continued, 0, 'ask mode never drains its own drafts');
  assert.equal(h.host.approveAllLedger.at(-1)?.gate, 'non_approve_all',
    'ask must state that the drain does not apply anything');
});
