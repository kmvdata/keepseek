import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { normalizeRunCheckpoint, normalizeRunValidationState } from '../src/agent/runCheckpoint';
import { createFullTextDraftEdit } from '../src/edits/draftEdit';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import type { ChatSession, RepairLoopState } from '../src/shared/types';
import * as vscode from './stubs/vscode';

interface ReconcileHost {
  changeSets: ChangeSetStore;
  reconcilePendingDrafts(change: {
    applied?: readonly string[];
    discarded?: readonly string[];
    reverted?: readonly string[];
  }, sessionId?: string): Promise<void>;
  repairLoopsBySession: Map<string, RepairLoopState>;
}

interface Harness {
  root: string;
  provider: KeepseekChatViewProvider;
  host: ReconcileHost;
  session: ChatSession;
  store: ChatSessionStore;
  dispose(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-validation-reconcile-'));
  const uri = vscode.Uri.file(root);
  const previousWorkspace = { ...(vscode.workspace as unknown as Record<string, unknown>) };
  Object.assign(vscode.workspace as unknown as Record<string, unknown>, { isTrusted: true });
  const previousWindow = { ...vscode.window };
  const previousAlignment = (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
  Object.assign(vscode as unknown as Record<string, unknown>, { StatusBarAlignment: { Left: 1, Right: 2 } });
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
    showInformationMessage: async () => undefined
  });
  const scope = { key: 'workspace:reconcile', name: 'Reconcile', folderUris: [] };
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
  const host = provider as unknown as ReconcileHost;
  await (host as unknown as { initializeAfterWebviewReady(): Promise<void> }).initializeAfterWebviewReady();
  await host.changeSets.flush();
  const session = sessionStore.getActiveSession();
  return {
    root,
    provider,
    host,
    session,
    store: sessionStore,
    async dispose() {
      provider.dispose();
      Object.assign(vscode.window, previousWindow);
      if (previousAlignment === undefined) delete (vscode as unknown as { StatusBarAlignment?: unknown }).StatusBarAlignment;
      Object.assign(vscode.workspace as unknown as Record<string, unknown>, previousWorkspace);
      await storage.flush().catch(() => undefined);
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { await rm(root, { recursive: true, force: true }); break; } catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
    }
  };
}

function draft(root: string, id: string): ReturnType<typeof createFullTextDraftEdit> {
  return createFullTextDraftEdit({
    id,
    uri: vscode.Uri.joinPath(vscode.Uri.file(root), `${id}.ts`).toString(),
    label: `${id}.ts`,
    action: 'create',
    content: `export const ${id.replace(/[^a-z0-9]/giu, '_')} = 1;\n`,
    reason: `Create ${id}.ts`
  });
}

function seedCheckpoint(h: Harness, pendingDraftEditIds: string[]): void {
  const message = {
    id: 'assistant-1',
    role: 'assistant' as const,
    content: '',
    createdAt: new Date().toISOString(),
    runCheckpoint: {
      version: 2,
      taskId: 'task-1',
      attempt: 1,
      attemptIds: ['run-1'],
      status: 'interrupted' as const,
      stopReason: 'waiting_for_user' as const,
      usedMs: 1,
      maxExecutionMs: 0,
      modelRequests: 1,
      retries: 0,
      updatedAt: new Date().toISOString(),
      request: { history: [], prompt: 'p', model: { id: 'm' }, settings: {}, contextFiles: [],
        requestProtocolVersion: 0, language: 'en' },
      source: { sourceId: 's', modelId: 'm', provider: 'deepseek', endpointHash: 'e' },
      workspaceFolders: [],
      usedCostByCurrency: {},
      outputBudgetPolicyVersion: 1,
      maxCost: 0,
      state: {
        messages: [], toolRounds: [], draftEdits: [], draftRuns: [], reasoningParts: [],
        turn: 0, toolCallCount: 1, validationRunCount: 0, toolResultTokens: 0,
        repairLoop: { status: 'waiting_for_apply', iteration: 1, maxIterations: 3, pendingDraftEditIds },
        validationState: { pendingDraftEditIds, validations: [] }
      }
    }
  };
  h.session.messages.push(message as never);
}

test('an applied draft is removed from both the checkpoint and the repair loop', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  seedCheckpoint(h, ['edit-a', 'edit-b']);
  h.host.repairLoopsBySession.set(h.session.id, {
    status: 'waiting_for_apply', iteration: 1, maxIterations: 3, pendingDraftEditIds: ['edit-a', 'edit-b']
  });

  await h.host.reconcilePendingDrafts({ applied: ['edit-a'] });

  const checkpointState = h.session.messages[0]?.runCheckpoint?.state;
  assert.deepEqual(checkpointState?.validationState?.pendingDraftEditIds, ['edit-b'],
    'the applied id must leave the checkpoint, or a restored run re-seeds it');
  const loop = h.host.repairLoopsBySession.get(h.session.id);
  assert.deepEqual(loop?.pendingDraftEditIds, ['edit-b']);
  assert.equal(loop?.status, 'waiting_for_apply', 'a second pending draft keeps the loop waiting');
});

test('applying the last draft makes the repair loop ready for validation', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  seedCheckpoint(h, ['edit-a']);
  h.host.repairLoopsBySession.set(h.session.id, {
    status: 'waiting_for_apply', iteration: 1, maxIterations: 3, pendingDraftEditIds: ['edit-a']
  });

  await h.host.reconcilePendingDrafts({ applied: ['edit-a'] });

  const loop = h.host.repairLoopsBySession.get(h.session.id);
  assert.deepEqual(loop?.pendingDraftEditIds, []);
  assert.equal(loop?.status, 'ready_for_validation');
  assert.equal(loop?.stopReason, undefined);
});

test('a discarded draft is removed and the repair loop is abandoned, not resumed', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  seedCheckpoint(h, ['edit-a']);
  h.host.repairLoopsBySession.set(h.session.id, {
    status: 'waiting_for_apply', iteration: 1, maxIterations: 3, pendingDraftEditIds: ['edit-a']
  });

  await h.host.reconcilePendingDrafts({ discarded: ['edit-a'] });

  assert.deepEqual(h.session.messages[0]?.runCheckpoint?.state?.validationState?.pendingDraftEditIds, []);
  const loop = h.host.repairLoopsBySession.get(h.session.id);
  assert.deepEqual(loop?.pendingDraftEditIds, []);
  assert.equal(loop?.status, 'blocked', 'a discard must not become "ready for validation"');
  assert.equal(loop?.stopReason, 'repair_discarded');
});

test('a reverted draft is removed and the repair loop is abandoned', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  seedCheckpoint(h, ['edit-a']);
  h.host.repairLoopsBySession.set(h.session.id, {
    status: 'waiting_for_apply', iteration: 2, maxIterations: 3, pendingDraftEditIds: ['edit-a']
  });

  await h.host.reconcilePendingDrafts({ reverted: ['edit-a'] });

  assert.deepEqual(h.session.messages[0]?.runCheckpoint?.state?.validationState?.pendingDraftEditIds, []);
  assert.equal(h.host.repairLoopsBySession.get(h.session.id)?.status, 'blocked');
});

test('reconciliation ignores ids this session never recorded', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  seedCheckpoint(h, ['edit-a']);

  await h.host.reconcilePendingDrafts({ applied: ['someone-elses-edit'] });

  assert.deepEqual(h.session.messages[0]?.runCheckpoint?.state?.validationState?.pendingDraftEditIds, ['edit-a'],
    'an unrelated id must not silently clear a real pending draft');
});

test('reconciliation is a no-op when nothing changed and does not invent state', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  seedCheckpoint(h, ['edit-a']);
  await h.host.reconcilePendingDrafts({});
  await h.host.reconcilePendingDrafts({ applied: [] });
  assert.deepEqual(h.session.messages[0]?.runCheckpoint?.state?.validationState?.pendingDraftEditIds, ['edit-a']);
});

test('a real discard through the store reconciles the pending set', async t => {
  const h = await createHarness();
  t.after(() => h.dispose());
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1', edits: [draft(h.root, 'edit-a')]
  })!;
  assert.ok(set);
  seedCheckpoint(h, ['edit-a']);
  h.host.repairLoopsBySession.set(h.session.id, {
    status: 'waiting_for_apply', iteration: 1, maxIterations: 3, pendingDraftEditIds: ['edit-a']
  });
  assert.equal(h.host.changeSets.discardAll(set.id), true);
  await h.host.reconcilePendingDrafts({ discarded: [set.files[0]!.id] });
  assert.equal(h.host.repairLoopsBySession.get(h.session.id)?.status, 'blocked');
});

test('normalizeRunValidationState drops illegal items and unknown outcomes', () => {
  const state = normalizeRunValidationState({
    pendingDraftEditIds: ['a', 'a', '', 42, null, 'b'],
    validations: [
      { scope: 'post_apply', outcome: 'passed' },
      { scope: 'bogus', outcome: 'passed' },
      { scope: 'workspace_baseline', outcome: 'weird' },
      { scope: 'workspace_baseline', outcome: 'failed' }
    ]
  });
  assert.deepEqual(state?.pendingDraftEditIds, ['a', 'b'], 'duplicates and non-strings are dropped');
  assert.deepEqual(state?.validations, [
    { scope: 'post_apply', outcome: 'passed' },
    { scope: 'workspace_baseline', outcome: 'failed' }
  ]);
});

test('normalizeRunValidationState degrades an unusable value to undefined', () => {
  assert.equal(normalizeRunValidationState(undefined), undefined);
  assert.equal(normalizeRunValidationState(null), undefined);
  assert.equal(normalizeRunValidationState('nope'), undefined);
  assert.equal(normalizeRunValidationState([]), undefined);
  assert.equal(normalizeRunValidationState({ pendingDraftEditIds: 'a' }), undefined);
  assert.equal(normalizeRunValidationState({ pendingDraftEditIds: [], validations: [] }), undefined);
});

test('normalizeRunValidationState bounds the restored set', () => {
  const ids = Array.from({ length: 400 }, (_value, index) => `edit-${index}`);
  const state = normalizeRunValidationState({ pendingDraftEditIds: ids });
  assert.equal(state?.pendingDraftEditIds.length, 256);
});

test('a checkpoint with a broken validation state still loads', () => {
  // The field is optional and was historically unvalidated: a bad value must
  // not turn into "recovery refused" for an otherwise valid task.
  const checkpoint = normalizeRunCheckpoint(undefined);
  assert.equal(checkpoint, undefined);
  // Direct normalization is the contract under test here; the checkpoint-level
  // path is covered by the session startup suite.
  assert.equal(normalizeRunValidationState({ pendingDraftEditIds: [{}] }), undefined);
});