import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createFullTextDraftEdit } from '../src/edits/draftEdit';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { InteractionCoordinator } from '../src/provider/interactionState';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import type { ChangeSetFile, ChatSession, DraftEdit } from '../src/shared/types';
import * as vscode from './stubs/vscode';

/**
 * Boundary contract for approve-all.
 *
 * The reported failure: after "start execution" in plan mode the final DraftEdit
 * was never applied automatically and no manual entry existed either. The cause
 * was that the plan decision kept the interaction slot through run finalization,
 * so the only drain that could have applied the draft was refused as `busy`
 * (silently), latched, and then never rescheduled. These tests pin the three
 * properties that prevent that dead end: no dropped trigger, one attempt per
 * boundary, and a visible manual fallback for a blocked file draft.
 */

type ApproveAllGate = 'non_approve_all' | 'pending_truncation' | 'untrusted' | 'busy'
  | 'slot_unavailable' | 'preflight_failed' | 'identity_mismatch' | 'untrusted_target'
  | 'deferred_to_boundary' | 'plan_discarded' | 'manually_applied'
  | 'latched' | 'not_applicable' | 'applied' | 'apply_blocked' | 'none_pending';
type ApproveAllTrigger = 'mode_switch' | 'run_end' | 'checkpoint' | 'change_action'
  | 'session_navigation' | 'continuation' | 'slot_released' | 'manual';
interface ApproveAllLedgerEntry {
  gate: ApproveAllGate;
  trigger: ApproveAllTrigger;
  draftId?: string;
  reason?: string;
  hard?: boolean;
  at: string;
}
interface ApproveAllViewModel {
  pending: number;
  blocked: Array<{ id: string; kind: 'changeSet' | 'draftRun'; label: string; gate: ApproveAllGate; reason?: string; manual: boolean }>;
  nextTrigger: ApproveAllTrigger | 'drain';
  scheduled: boolean;
}

interface ApproveAllHost {
  changeSets: ChangeSetStore;
  interactions: InteractionCoordinator;
  approveAllAttempted: Set<string>;
  approveAllBlocked: Set<string>;
  approveAllStops: Map<string, { gate: ApproveAllGate; reason?: string; trigger: ApproveAllTrigger }>;
  approveAllLedger: ApproveAllLedgerEntry[];
  approveAllRerun?: ApproveAllTrigger;
  approveAllTimer?: ReturnType<typeof setTimeout>;
  approveAllInFlight: boolean;
  warnedApproveAllReasons: Set<string>;
  repairLoopsBySession: Map<string, { status: string; pendingDraftEditIds: string[] }>;
  drainApproveAllExecution(trigger: ApproveAllTrigger): Promise<void>;
  drainApproveAllStep(trigger: ApproveAllTrigger): Promise<void>;
  scheduleApproveAllExecution(trigger?: ApproveAllTrigger): void;
  approveAllViewModel(sessionId: string): ApproveAllViewModel;
  continueRepair(): Promise<void>;
  handleMessage(message: unknown, webviewId?: string): Promise<void>;
}

interface Harness {
  root: string;
  provider: KeepseekChatViewProvider;
  host: ApproveAllHost;
  sessionStore: ChatSessionStore;
  session: ChatSession;
  warnings: string[];
  posts: Array<Record<string, unknown>>;
  dispose(): Promise<void>;
}

async function createHarness(options: { approvalMode?: 'ask' | 'approve-all' } = {}): Promise<Harness> {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-approve-all-boundary-'));
  const uri = vscode.Uri.file(root);
  const previousWorkspace = { ...(vscode.workspace as unknown as Record<string, unknown>) };
  // A real workspace folder keeps the fixture drafts inside the project. Without
  // it every target is "external", so ask mode would legitimately require an
  // extra confirmation and the test would assert the wrong thing.
  Object.assign(vscode.workspace as unknown as Record<string, unknown>, {
    isTrusted: true,
    workspaceFolders: [{ uri, name: 'fixture', index: 0 }]
  });
  const warnings: string[] = [];
  const previousWindow = { ...vscode.window };
  Object.assign(vscode.window, {
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    showWarningMessage: async (message: string) => { warnings.push(message); return undefined; },
    showErrorMessage: async (message: string) => { warnings.push(message); return undefined; },
    showInformationMessage: async () => undefined
  });
  Object.assign(vscode as unknown as Record<string, unknown>, { StatusBarAlignment: { Left: 1, Right: 2 } });

  const scope = { key: 'workspace:approve-all-boundary', name: 'Approve All Boundary', folderUris: [] };
  const storage = new GlobalSessionStorage(uri as never);
  const seed = new ChatSessionStore(storage, 'en', scope);
  await seed.initialize();
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
  return {
    root,
    provider,
    host,
    sessionStore,
    session: sessionStore.getActiveSession(),
    warnings,
    posts,
    async dispose() {
      provider.dispose();
      Object.assign(vscode.window, previousWindow);
      Object.assign(vscode.workspace as unknown as Record<string, unknown>, previousWorkspace);
      await storage.flush().catch(() => undefined);
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

function statuses(host: ApproveAllHost, sessionId: string): Array<{ id: string; status: ChangeSetFile['status'] }> {
  return host.changeSets.toWebviewState(sessionId).flatMap(set => set.files.map(file => ({ id: file.id, status: file.status })));
}

function gatesFor(host: ApproveAllHost, draftId: string): ApproveAllGate[] {
  return host.approveAllLedger.filter(entry => entry.draftId === draftId).map(entry => entry.gate);
}

// Storage gates in this fixture can take seconds under load, so every wait is
// generous: a slow write must not be mistaken for a missing one.
async function waitFor(check: () => boolean, timeoutMs = 40000): Promise<boolean> {
  const startedAt = Date.now();
  for (;;) {
    if (check()) return true;
    if (Date.now() - startedAt > timeoutMs) return false;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** Reserve a session slot the way handlePlanDecision/sendPrompt do, and hand the
 * caller the release so an inherited-operation boundary can be replayed exactly. */
function holdInteractionSlot(host: ApproveAllHost, sessionId: string) {
  const operation = host.interactions.begin('continuation', sessionId, 'saving');
  assert.ok(operation, 'the fixture must be able to reserve the slot');
  return {
    operation,
    release() { host.interactions.finish(operation); }
  };
}

test('an inherited operation holds the slot past run_end, then the release applies the draft', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-plan', sessionId: h.session.id, messageId: 'message-plan',
    edits: [createDraftFixture(h.root, 'edit-plan', 'planned.ts')]
  })!;

  // This is the reported sequence: the plan decision owns the slot, run_end fires
  // while it is still held, and only then does the slot become free.
  const slot = holdInteractionSlot(h.host, h.session.id);
  await h.host.drainApproveAllExecution('run_end');
  const stillPending = statuses(h.host, h.session.id);
  assert.equal(stillPending[0]?.status, 'pending', 'a held slot must not write the draft');
  assert.deepEqual(gatesFor(h.host, set.id).slice(-1), ['deferred_to_boundary'],
    'the refusal is recorded as a deferral, not as a silent latch');

  slot.release();
  const written = await waitFor(() => statuses(h.host, h.session.id)[0]?.status === 'applied');
  assert.equal(written, true, 'the release boundary must apply the draft: '
    + JSON.stringify({ statuses: statuses(h.host, h.session.id), ledger: h.host.approveAllLedger }));
  assert.equal(h.host.approveAllViewModel(h.session.id).blocked.some(item => item.id === set.id), false,
    'an applied draft is no longer reported as blocked');
});

test('the release boundary fires for an inherited operation and needs no polling', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  h.host.changeSets.addDraftEdits({
    runId: 'run-plan', sessionId: h.session.id, messageId: 'message-plan',
    edits: [createDraftFixture(h.root, 'edit-plan', 'planned.ts')]
  });
  const slot = holdInteractionSlot(h.host, h.session.id);
  slot.release();
  const written = await waitFor(() => statuses(h.host, h.session.id)[0]?.status === 'applied');
  assert.equal(written, true, 'slot release alone must schedule the pass');
});

/**
 * The provider-level assertion above depends on real storage timing, so the
 * release notification itself is pinned on the coordinator: one release event per
 * finished operation, carrying the session that just became free.
 */
test('the coordinator reports a released task slot exactly once per operation', () => {
  const events: Array<{ sessionId: string; taskSlotFree: boolean; kind: string }> = [];
  const coordinator = new InteractionCoordinator({
    id: (() => { let next = 0; return () => `op-${++next}`; })(),
    onRelease: event => events.push({ sessionId: event.sessionId, taskSlotFree: event.taskSlotFree, kind: event.kind })
  });
  const first = coordinator.begin('continuation', 'session-a', 'saving');
  assert.ok(first);
  coordinator.finish(first!);
  assert.deepEqual(events, [{ sessionId: 'session-a', taskSlotFree: true, kind: 'continuation' }]);

  // A second owner in the same session keeps the slot busy; its own release is
  // the one that reports the slot as free. Navigation occupies its own slot, so
  // only the task owner affects `taskSlotFree`.
  const outer = coordinator.begin('task', 'session-b', 'running');
  assert.ok(outer);
  coordinator.finish(outer!);
  assert.deepEqual(events.at(-1), { sessionId: 'session-b', taskSlotFree: true, kind: 'task' });

  const firstOwner = coordinator.begin('task', 'session-c', 'running');
  const secondOwner = coordinator.begin('continuation', 'session-c', 'action');
  assert.ok(firstOwner);
  assert.equal(secondOwner, undefined, 'a session keeps one task owner at a time');

  // A stale token is not a release: nothing is notified twice.
  coordinator.finish(first!);
  assert.equal(events.length, 2);
});

test('a throwing release observer never interrupts the release itself', () => {
  const coordinator = new InteractionCoordinator({ onRelease: () => { throw new Error('observer failed'); } });
  const operation = coordinator.begin('continuation', 'session-a', 'saving');
  assert.ok(operation);
  assert.equal(coordinator.finish(operation!), true, 'finish must still report success');
  assert.equal(coordinator.currentFor('session-a'), undefined, 'the slot is really free');
});

test('one boundary makes one attempt: a refused write latches once and does not retry', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-1', 'blocked.ts')]
  })!;
  // Simulate a write that the store refuses without changing any file state.
  h.host.changeSets.applyAll = async () => undefined;

  await h.host.drainApproveAllExecution('run_end');
  const firstAttempts = gatesFor(h.host, set.id);
  assert.equal(firstAttempts.filter(gate => gate === 'preflight_failed').length, 1,
    'exactly one attempt is recorded for this boundary: ' + JSON.stringify(h.host.approveAllLedger));
  assert.equal(h.host.approveAllBlocked.has(set.id), true, 'the draft is latched as blocked');

  // A continuation inside the same boundary must not retry the same draft.
  await h.host.drainApproveAllExecution('continuation');
  assert.equal(gatesFor(h.host, set.id).filter(gate => gate === 'preflight_failed').length, 1,
    'a continuation within the window must not repeat the attempt');
  const ownWarnings = h.warnings.filter(message => message.includes('blocked.ts'));
  assert.equal(ownWarnings.length, 1, 'the same (draft, gate) warns once: ' + JSON.stringify(ownWarnings));
  assert.equal(h.host.warnedApproveAllReasons.size, 1, 'one (draft, gate) pair is remembered');
});

test('a trigger that arrives mid-pass is queued, not dropped', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-a', 'a.ts')]
  });
  // Count the passes themselves: the queued trigger must produce a second pass,
  // whichever trigger name wins the timer race with the apply's own completion.
  let passes = 0;
  const step = h.host.drainApproveAllStep.bind(h.host);
  h.host.drainApproveAllStep = async (trigger: ApproveAllTrigger) => { passes += 1; await step(trigger); };

  // Hold the pass open long enough for a second trigger to arrive inside it.
  const original = h.host.changeSets.applyAll.bind(h.host.changeSets);
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  h.host.changeSets.applyAll = async (...args: Parameters<typeof original>) => {
    entered();
    await gate;
    return original(...args);
  };
  const first = h.host.drainApproveAllExecution('run_end');
  await enteredPromise;
  h.host.scheduleApproveAllExecution('slot_released');
  assert.equal(h.host.approveAllRerun, 'slot_released', 'the mid-pass trigger is remembered');
  release();
  await first;
  assert.equal(passes, 1, 'the first pass is the only one that ran so far');

  const queuedPassRan = await waitFor(() => passes >= 2, 20000);
  assert.equal(queuedPassRan, true, 'the queued trigger runs after the pass ends: '
    + JSON.stringify(h.host.approveAllLedger));
  assert.equal(h.host.approveAllRerun, undefined, 'the queued trigger is consumed once');
});

test('slot_unavailable is recorded and the same draft is applied after slot_released', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-1', 'queued.ts')]
  })!;
  const slot = holdInteractionSlot(h.host, h.session.id);
  await h.host.drainApproveAllStep('run_end');

  // The deferral is recorded per draft; the ledger entry is the durable form.
  const deferred = h.host.approveAllLedger.find(entry => entry.draftId === set.id);
  assert.equal(deferred?.gate, 'deferred_to_boundary',
    'a slot refusal is a deferral with an exact reason: ' + JSON.stringify(h.host.approveAllLedger));
  assert.equal(deferred?.trigger, 'run_end');

  slot.release();
  const applied = await waitFor(() => statuses(h.host, h.session.id)[0]?.status === 'applied');
  assert.equal(applied, true, 'the released slot is the boundary that writes it');
});

test('a blocked draft is manually applicable under approve-all and the latch is cleared', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-manual', 'manual.ts')]
  })!;
  const failing = h.host.changeSets.applyAll.bind(h.host.changeSets);
  let fail = true;
  h.host.changeSets.applyAll = async (...args: Parameters<typeof failing>) => (fail ? undefined : failing(...args));

  await h.host.drainApproveAllExecution('run_end');
  const blocked = h.host.approveAllViewModel(h.session.id).blocked.find(item => item.id === set.id);
  assert.equal(blocked?.gate, 'preflight_failed', 'the view model carries the exact gate');
  assert.equal(blocked?.manual, true, 'a non-hard block offers the manual fallback');

  // The webview sends the same message ask mode uses; only the host decision
  // differs, so the store path and every check stay identical.
  fail = false;
  await h.host.handleMessage({ type: 'applyChangeSet', id: set.id, requestId: 'manual-1' });
  assert.equal(statuses(h.host, h.session.id)[0]?.status, 'applied', 'the manual apply writes the draft');
  assert.equal(h.host.approveAllStops.has(set.id), false, 'the latch is cleared after a manual apply');
  assert.equal(h.host.approveAllViewModel(h.session.id).blocked.some(item => item.id === set.id), false);
  assert.equal(h.host.approveAllLedger.some(entry => entry.gate === 'manually_applied' && entry.draftId === set.id), true);

  // A second click cannot write again: there is nothing applicable left.
  await h.host.handleMessage({ type: 'applyChangeSet', id: set.id, requestId: 'manual-2' });
  assert.equal(statuses(h.host, h.session.id)[0]?.status, 'applied');
  const appliedGates = h.host.approveAllLedger.filter(entry => entry.draftId === set.id && entry.gate === 'manually_applied');
  assert.equal(appliedGates.length, 1, 'a repeated manual apply is not recorded as a second write');
});

test('ask mode keeps its own flow: no drain, no manual-only gate', async t => {
  const h = await createHarness({ approvalMode: 'ask' });
  t.after(() => h.dispose());
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-ask', 'ask.ts')]
  })!;
  await h.host.drainApproveAllExecution('run_end');
  assert.equal(h.host.approveAllLedger.at(-1)?.gate, 'non_approve_all');
  assert.equal(statuses(h.host, h.session.id)[0]?.status, 'pending', 'ask never applies on its own');
  assert.equal(h.host.approveAllViewModel(h.session.id).blocked.length, 0,
    'ask does not advertise approve-all blocked state');

  // The user's own apply still works and is not routed through the fallback.
  await h.host.handleMessage({ type: 'applyChangeSet', id: set.id, requestId: 'ask-1' });
  assert.equal(statuses(h.host, h.session.id)[0]?.status, 'applied');
  assert.equal(h.host.approveAllLedger.some(entry => entry.gate === 'manually_applied'), false);
});

test('an untrusted workspace blocks a manual fallback instead of bypassing trust', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => {
    Object.assign(vscode.workspace as unknown as Record<string, unknown>, { isTrusted: true });
    return h.dispose();
  });
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-trust', 'trust.ts')]
  })!;
  Object.assign(vscode.workspace as unknown as Record<string, unknown>, { isTrusted: false });
  await h.host.drainApproveAllExecution('run_end');

  const view = h.host.approveAllViewModel(h.session.id);
  assert.equal(view.blocked.length, 1, 'the pending draft still reports why it did not advance');
  assert.equal(view.blocked[0]?.gate, 'untrusted', 'the workspace gate is the stated cause');
  assert.equal(view.blocked[0]?.manual, false, 'a hard precondition never offers a manual fallback');
  assert.equal(h.host.approveAllLedger.at(-1)?.gate, 'untrusted');
  assert.equal(h.host.approveAllLedger.at(-1)?.hard, true, 'the trust gate is a hard precondition');

  await h.host.handleMessage({ type: 'applyChangeSet', id: set.id, requestId: 'manual-untrusted' });
  assert.equal(statuses(h.host, h.session.id)[0]?.status, 'pending', 'the manual entry cannot write');
});

test('a pending history truncation is a hard block for the manual fallback too', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-truncation', 'truncation.ts')]
  })!;
  h.session.pendingHistoryTruncation = { id: 'truncation-1' } as never;

  // The manual apply must be refused by the shared preconditions, even though the
  // draft was never blocked by a pass (no latch exists yet).
  await h.host.handleMessage({ type: 'applyChangeSet', id: set.id, requestId: 'manual-truncation' });
  assert.equal(statuses(h.host, h.session.id)[0]?.status, 'pending', 'nothing is written during truncation');
  assert.equal(h.host.approveAllStops.has(set.id), false, 'a refused start is not recorded as a block');
});

test('a plan-stage draft that is dropped says why (R7)', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  const host = h.host as unknown as {
    saveAgentCheckpoint(session: ChatSession, message: unknown, checkpoint: unknown): Promise<void>;
  };
  const session = h.session;
  const message = {
    id: 'message-plan-stage', role: 'assistant', content: '', createdAt: new Date().toISOString(),
    userTask: { version: 1, id: 'task-1', originMessageId: 'message-plan-stage', reason: 'user' }
  };
  session.messages.push(message as never);
  const checkpoint = {
    version: 2, taskId: 'task-1', attempt: 1, attemptIds: ['task-1'], status: 'completed',
    usedMs: 0, maxExecutionMs: 1000, limitSource: 'default', modelRequests: 1, retries: 0,
    updatedAt: new Date().toISOString(),
    request: { executionMode: 'plan', approvalMode: 'approve-all', prompt: 'plan', history: [], contextFiles: [], model: {}, settings: {} },
    source: { sourceId: 'source', modelId: 'model', provider: 'deepseek', endpointHash: 'hash' },
    workspaceFolders: [h.root],
    finalResponse: {
      runId: 'task-1', message: 'plan ready', draftEdits: [createDraftFixture(h.root, 'edit-planned', 'planned.ts')],
      draftRuns: [],
      // The status projection reads these; a partial fixture must still have the
      // shape the renderer expects so this test only exercises R7.
      runDetails: { runId: 'task-1', modelId: 'model', status: 'succeeded', startedAt: new Date().toISOString(),
        toolCalls: [], changeSets: [], validations: [], subagentRuns: [], modelRequests: [] }
    }
  };
  await host.saveAgentCheckpoint(session, message, checkpoint);

  const entry = h.host.approveAllLedger.find(item => item.gate === 'plan_discarded');
  assert.ok(entry, 'a dropped plan draft is recorded: ' + JSON.stringify(h.host.approveAllLedger));
  assert.equal(entry?.draftId, 'edit-planned');
  assert.equal(entry?.reason, 'plan_mode_produces_no_writes');
  assert.equal(h.host.changeSets.hasPendingForSession(session.id), false, 'plan mode prepares no writes');
});

test('a checkpoint no longer attempts a write while the run holds the slot (D2)', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  const host = h.host as unknown as {
    saveAgentCheckpoint(session: ChatSession, message: unknown, checkpoint: unknown): Promise<void>;
  };
  const session = h.session;
  const message = {
    id: 'message-run', role: 'assistant', content: '', createdAt: new Date().toISOString(),
    userTask: { version: 1, id: 'task-1', originMessageId: 'message-run', reason: 'user' }
  };
  session.messages.push(message as never);
  const checkpoint = {
    version: 2, taskId: 'task-1', attempt: 1, attemptIds: ['task-1'], status: 'running',
    usedMs: 0, maxExecutionMs: 1000, limitSource: 'default', modelRequests: 1, retries: 0,
    updatedAt: new Date().toISOString(),
    request: { executionMode: 'normal', approvalMode: 'approve-all', prompt: 'go', history: [], contextFiles: [], model: {}, settings: {} },
    source: { sourceId: 'source', modelId: 'model', provider: 'deepseek', endpointHash: 'hash' },
    workspaceFolders: [h.root],
    state: { messages: [], toolRounds: [], draftEdits: [createDraftFixture(h.root, 'edit-midrun', 'midrun.ts')],
      draftRuns: [] }
  };
  await host.saveAgentCheckpoint(session, message, checkpoint);
  const gate = h.host.approveAllLedger.find(item => item.draftId === 'edit-midrun');
  assert.equal(gate?.gate, 'deferred_to_boundary', 'a checkpoint registers the draft, it does not try to write it');
  assert.equal(gate?.trigger, 'checkpoint');
  assert.equal(statuses(h.host, session.id).some(file => file.status === 'applied'), false,
    'nothing is written by a checkpoint');
});

test('a blocked draft is visible from persisted state after a reload', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-persist', 'persist.ts')]
  })!;
  h.host.changeSets.applyAll = async () => undefined;
  await h.host.drainApproveAllExecution('run_end');
  await h.host.changeSets.flush();
  const blockedBefore = h.host.approveAllViewModel(h.session.id).blocked.find(item => item.id === set.id);
  assert.equal(blockedBefore?.gate, 'preflight_failed');

  // A reload keeps the pending ChangeSet on disk while the in-memory ledger is
  // gone. The draft must still explain itself instead of silently claiming that
  // an automatic attempt is pending.
  const host = h.host as unknown as { approveAllStops: Map<string, unknown>; approveAllLedger: ApproveAllLedgerEntry[] };
  host.approveAllStops.clear();
  host.approveAllLedger = [];
  const settled = await waitFor(() => !h.host.approveAllViewModel(h.session.id).scheduled);
  assert.equal(settled, true, 'the fixture must reach an idle boundary before asserting');
  // While a pass is still scheduled the draft is legitimately "waiting"; once the
  // boundary is idle, a pending draft with no recorded reason must say exactly
  // that instead of leaving the card to imply an automatic attempt is pending.
  const blockedAfter = await waitFor(() => Boolean(h.host.approveAllViewModel(h.session.id).blocked.find(item => item.id === set.id)));
  assert.equal(blockedAfter, true, 'a still-pending draft is never reported as "nothing to do"');
  const entry = h.host.approveAllViewModel(h.session.id).blocked.find(item => item.id === set.id);
  assert.equal(entry?.gate, 'deferred_to_boundary',
    'without a recorded reason the draft states that no attempt is scheduled');
  // Nothing is scheduled any more, so this is exactly the dead end the fallback
  // exists for: the button must be there from durable state alone.
  assert.equal(entry?.manual, true, 'the fallback stays available from durable state alone');
});

test('a successful apply advances the validation barrier without another empty pass (R5)', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  h.host.repairLoopsBySession.set(h.session.id, { status: 'waiting_for_apply', pendingDraftEditIds: ['edit-barrier'] });
  h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-barrier', 'barrier.ts')]
  });
  let continued = 0;
  const originalContinue = h.host.continueRepair.bind(h.host);
  h.host.continueRepair = async () => { continued += 1; await originalContinue(); };

  await h.host.drainApproveAllExecution('run_end');
  assert.equal(statuses(h.host, h.session.id)[0]?.status, 'applied');
  assert.equal(continued >= 1, true, 'the barrier is advanced by the successful apply itself: '
    + JSON.stringify(h.host.approveAllLedger));
});

test('the draft file on disk matches the applied draft after a manual fallback', async t => {
  const h = await createHarness({ approvalMode: 'approve-all' });
  t.after(() => h.dispose());
  const set = h.host.changeSets.addDraftEdits({
    runId: 'run-1', sessionId: h.session.id, messageId: 'message-1',
    edits: [createDraftFixture(h.root, 'edit-write', 'written.ts')]
  })!;
  const failing = h.host.changeSets.applyAll.bind(h.host.changeSets);
  let fail = true;
  h.host.changeSets.applyAll = async (...args: Parameters<typeof failing>) => (fail ? undefined : failing(...args));
  await h.host.drainApproveAllExecution('run_end');

  fail = false;
  await h.host.handleMessage({ type: 'applyChangeSet', id: set.id, requestId: 'manual-write' });
  const text = await readFile(path.join(h.root, 'written.ts'), 'utf8');
  assert.match(text, /edit_write/u, 'the fallback writes the same content the draft describes');
});