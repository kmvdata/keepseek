import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { RunValidationStateTracker, RepairLoopTracker } from '../src/agent/repairLoop';
import { TaskPlanTracker } from '../src/agent/taskPlan';
import { RunDetailsBuilder } from '../src/agent/logging/runDetails';
import { preflightSafeValidation } from '../src/agent/tools/validationTools';
import { createFullTextDraftEdit } from '../src/edits/draftEdit';
import * as vscode from './stubs/vscode';

/**
 * The barrier contract, asserted on the tracker the runner actually uses:
 * a pending draft must produce a structured waiting result and must not touch
 * the validation budget, the repair loop or any executing intent.
 */
test('a pending draft produces a structured waiting result, not a failure', () => {
  const tracker = new RunValidationStateTracker('workspace_baseline', ['edit-1']);
  const raw = tracker.createBlockedValidationResult('en', {
    pendingDrafts: [{ draftEditId: 'edit-1', label: 'src/a.ts', action: 'modify' }],
    nextTrigger: 'run_end_host_apply'
  });
  const result = JSON.parse(raw) as Record<string, unknown>;
  assert.equal(result.ok, false);
  assert.equal(result.errorType, 'pending_changes_require_apply');
  assert.equal(result.waitingForApply, true, 'waiting must be distinguishable from a failure');
  assert.equal(result.executed, false, 'the barrier must state that nothing ran');
  assert.equal(result.suggestedAction, 'continue_after_apply');
  assert.equal(result.nextTrigger, 'run_end_host_apply');
  assert.deepEqual(result.pendingDraftEditIds, ['edit-1']);
  assert.deepEqual(result.pendingDrafts, [{ draftEditId: 'edit-1', label: 'src/a.ts', action: 'modify' }]);
});

test('the barrier names host-level ChangeSets and unknown ids separately', () => {
  const tracker = new RunValidationStateTracker('post_apply', ['edit-1', 'edit-foreign']);
  const result = JSON.parse(tracker.createBlockedValidationResult('zh-CN', {
    hostPending: [{ changeSetId: 'set-1', status: 'pending' }],
    unknownIds: ['edit-foreign'],
    nextTrigger: 'manual_apply'
  })) as Record<string, unknown>;
  assert.deepEqual(result.hostPending, [{ changeSetId: 'set-1', status: 'pending' }]);
  assert.deepEqual(result.unknownIds, ['edit-foreign']);
  assert.equal(result.nextTrigger, 'manual_apply');
});

test('the barrier result does not itself consume validation budget or clear pending', () => {
  const tracker = new RunValidationStateTracker('workspace_baseline', ['edit-1']);
  const before = tracker.getState();
  tracker.createBlockedValidationResult('en');
  const after = tracker.getState();
  assert.deepEqual(after, before, 'refusing to validate changes no state');
  assert.deepEqual(after.validations, [], 'no validation outcome is recorded');
});

test('remove, clear and reconcile keep the pending set equal to the disk', () => {
  const tracker = new RunValidationStateTracker('workspace_baseline', ['a', 'b', 'c']);
  tracker.remove(['a']);
  assert.deepEqual(tracker.getPendingDraftEditIds(), ['b', 'c']);
  tracker.remove(['unknown-id']);
  assert.deepEqual(tracker.getPendingDraftEditIds(), ['b', 'c'], 'an unrelated id is never removed');
  tracker.reconcile(['c']);
  assert.deepEqual(tracker.getPendingDraftEditIds(), ['c']);
  tracker.reconcile([]);
  assert.equal(tracker.hasPendingDraftEdit(), false);
  tracker.recordDraftEdit('d');
  assert.deepEqual(tracker.getPendingDraftEditIds(), ['d']);
  tracker.clear();
  assert.equal(tracker.hasPendingDraftEdit(), false);
  assert.deepEqual(tracker.getState().validations, [], 'clear keeps recorded outcomes');
});

test('a restored applied draft is not re-seeded as pending', () => {
  // This is the ghost-pending regression: the runner now seeds only from the
  // reconciled validationState, and the tracker must honour an empty list even
  // though the restored draftEdits array still contains the applied draft.
  const tracker = new RunValidationStateTracker('post_apply', [], [{ scope: 'post_apply', outcome: 'passed' }]);
  assert.equal(tracker.hasPendingDraftEdit(), false);
  assert.equal(tracker.getState().validations.length, 1);
});

test('reapplying a reconciled state is idempotent', () => {
  const tracker = new RunValidationStateTracker('workspace_baseline', ['a']);
  const before = tracker.getState();
  tracker.reconcile(['a']);
  assert.deepEqual(tracker.getState(), before, 'reconciling the same set must not disturb it');
});

/**
 * Ordering: the runner performs the barrier before preflight, and the host
 * authorization is requested with the fingerprint preflight froze. This test
 * exercises the real snapshot reader so the ordering assumption is verified
 * against the actual filesystem, not a mock of it.
 */
test('preflight freezes a fingerprint that changes once the draft is written', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-validation-barrier-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', scripts: {
      compile: 'node -e "process.exit(0)"',
      lint: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"'
    }
  }), 'utf8');
  await writeFile(path.join(root, 'src.ts'), 'export const a = 1;\n', 'utf8');

  const previousWorkspace = { ...(vscode.workspace as unknown as Record<string, unknown>) };
  const folder = { uri: vscode.Uri.file(root), name: 'fixture', index: 0 };
  Object.assign(vscode.workspace as unknown as Record<string, unknown>, {
    isTrusted: true,
    workspaceFolders: [folder],
    fs: (vscode.workspace as unknown as { fs: unknown }).fs
  });
  t.after(() => Object.assign(vscode.workspace as unknown as Record<string, unknown>, previousWorkspace));

  const before = await preflightSafeValidation({ script: 'compile', language: 'en', approvalMode: 'approve-all' });
  assert.equal(before.status, 'ready', 'the fixture must be eligible for validation');
  if (before.status !== 'ready') return;
  const fingerprintBefore = before.snapshot.fingerprint;

  // The fingerprint is bound to the launch facts (manifest scripts, validation
  // config files, npm runtime), so a change there invalidates a decision taken
  // against the old bytes. This is the property that makes "authorize, then let
  // the workspace change, then execute" impossible: the executor re-reads the
  // snapshot and refuses on a mismatch.
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>
  };
  manifest.scripts.compile = 'node -e "process.exit(1)"';
  await writeFile(path.join(root, 'package.json'), JSON.stringify(manifest), 'utf8');
  const after = await preflightSafeValidation({ script: 'compile', language: 'en', approvalMode: 'approve-all' });
  assert.equal(after.status, 'ready');
  if (after.status !== 'ready') return;
  assert.notEqual(after.snapshot.fingerprint, fingerprintBefore,
    'a changed validation launch must produce a different fingerprint');

  // Source bytes are not part of the fingerprint; the barrier, not the
  // fingerprint, is what keeps validation on the post-apply tree.
  await writeFile(path.join(root, 'src.ts'), 'export const a = 2;\n', 'utf8');
  const sourceOnly = await preflightSafeValidation({ script: 'compile', language: 'en', approvalMode: 'approve-all' });
  assert.equal(sourceOnly.status, 'ready');
  if (sourceOnly.status !== 'ready') return;
  assert.equal(sourceOnly.snapshot.fingerprint, after.snapshot.fingerprint,
    'the fingerprint covers the launch configuration, not source contents');
});

test('an unsupported script is refused before any authorization is requested', async () => {
  const result = await preflightSafeValidation({ script: 'build' as never, language: 'en' });
  assert.equal(result.status, 'blocked');
  if (result.status === 'blocked') assert.match(result.error, /allowlist|not supported|unsupported/iu);
});

test('the draft fixture used by these tests never implies execution', () => {
  const edit = createFullTextDraftEdit({
    id: 'edit-1',
    uri: 'file:///tmp/a.ts',
    label: 'a.ts',
    action: 'create',
    content: 'export const a = 1;\n',
    reason: 'fixture'
  });
  // Preparing a draft is not a side effect; only Apply writes the file.
  assert.equal(edit.kind, 'full_text_v1');
});
/**
 * Execution-side gate. The runner validates the host decision, then the tool
 * re-checks it immediately before the process starts. These are the denial
 * paths that must never reach a process.
 */
test('an untrusted workspace refuses validation before any authorization is spent', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-validation-untrusted-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture', version: '1.0.0', scripts: { compile: 'node -e "process.exit(0)"' }
  }), 'utf8');
  const previousWorkspace = { ...(vscode.workspace as unknown as Record<string, unknown>) };
  const folder = { uri: vscode.Uri.file(root), name: 'fixture', index: 0 };
  Object.assign(vscode.workspace as unknown as Record<string, unknown>, {
    isTrusted: false, workspaceFolders: [folder]
  });
  t.after(() => Object.assign(vscode.workspace as unknown as Record<string, unknown>, previousWorkspace));
  const result = await preflightSafeValidation({ script: 'compile', language: 'en', approvalMode: 'approve-all' });
  assert.equal(result.status, 'blocked', 'an untrusted workspace must not reach a launch plan');
});

test('a validation script that is not in the fixed allowlist never gets a preflight', async () => {
  for (const script of ['build', 'deploy', 'postinstall', '']) {
    const result = await preflightSafeValidation({ script: script as never, language: 'en' });
    assert.equal(result.status, 'blocked', `"${script}" must be refused`);
  }
});

test('an authorization source that is not host-issued is refused by the execution gate', async () => {
  // Mirrors inspectValidationAuthorization: the run_validation tool accepts only
  // host_signed / user_confirmed with a live decision id. Anything else is a
  // denial, and the tool returns authorization_denied without starting a process.
  const { isValidationAuthorizationValid } = await import('../src/agent/tools/toolAuthorization.js');
  const base = {
    allowed: true, requiresExplicitConfirmation: false, riskLevel: 'medium' as const,
    scope: 'validation_compile_lint' as const, toolName: 'keepseek_run_validation',
    decisionId: 'decision-x', executionSnapshot: 'fp'
  };
  const expected = { script: 'compile' as const, scope: 'validation_compile_lint' as const, fingerprint: 'fp' };
  assert.equal(isValidationAuthorizationValid({ ...base, source: 'low_risk' }, expected), false);
  assert.equal(isValidationAuthorizationValid({ ...base, source: 'user_denied' }, expected), false);
  assert.equal(isValidationAuthorizationValid({ ...base, source: 'host_signed' }, expected), true);
});

/**
 * Plan/status contract. The pending-apply barrier reports `ok: false` so the
 * model does not retry in the same round, but it is a waiting state: the round
 * must not be classified as blocked, and a later successful tool call in the
 * same round must be able to finish it normally.
 */
function createPlan(draftEditIds: readonly string[] = []) {
  const tracker = new TaskPlanTracker({
    runId: 'run-1', sessionId: 'session-1', prompt: 'Fix the bug', language: 'en'
  });
  tracker.beginExecution();
  for (const id of draftEditIds) {
    tracker.startTool('keepseek_create_draft_edit');
    tracker.finishTool('keepseek_create_draft_edit', JSON.stringify({ ok: true, draftEditId: id }));
  }
  return tracker;
}

function barrierResult(): string {
  return new RunValidationStateTracker('workspace_baseline', ['edit-1'])
    .createBlockedValidationResult('en', { nextTrigger: 'run_end_host_apply' });
}

function runDetailsStatus(plan: TaskPlanTracker, options: { awaitingApply: boolean }): string {
  return new RunDetailsBuilder({ runId: 'run-1', modelId: 'model-1', thinkingEnabled: false }).finish({
    taskPlan: plan.getPlan(),
    repairLoop: { status: 'idle', iteration: 0, maxIterations: 3, pendingDraftEditIds: [] },
    awaitingApply: options.awaitingApply
  }).status;
}

test('a pending-apply barrier never blocks the plan or records a blocker', () => {
  const tracker = createPlan(['edit-1', 'edit-2', 'edit-3']);
  tracker.startTool('keepseek_run_validation');
  tracker.finishTool('keepseek_run_validation', barrierResult());

  const plan = tracker.getPlan();
  assert.notEqual(plan.status, 'blocked', 'waiting for apply is not a failure');
  assert.deepEqual(plan.blockers, [], 'the barrier text must not become a blocker');
  const validate = plan.steps.find(step => step.id === 'validate');
  assert.equal(validate?.status, 'pending', 'the validation step stays to be done after apply');
  assert.match(validate?.detail ?? '', /waiting|appl/iu, 'the step keeps a readable waiting detail');
  assert.equal(tracker.isAwaitingApply(), true);
});

test('the barrier is idempotent and a later success still completes the round', () => {
  const tracker = createPlan(['edit-1']);
  tracker.startTool('keepseek_run_validation');
  tracker.finishTool('keepseek_run_validation', barrierResult());
  tracker.startTool('keepseek_run_validation');
  tracker.finishTool('keepseek_run_validation', barrierResult());
  assert.deepEqual(tracker.getPlan().blockers, [], 'repeating the barrier never accumulates blockers');

  tracker.startTool('keepseek_read_workspace_file');
  tracker.finishTool('keepseek_read_workspace_file', JSON.stringify({ ok: true, content: 'x' }));
  const completed = tracker.complete('Prepared the change; the host applies it after this run.');
  assert.equal(completed.status, 'completed', 'a successful tool call and completion are not blocked');
  assert.deepEqual(completed.blockers, []);
});

test('run details report waiting, not blocked, for a round that ends at the barrier', () => {
  const tracker = createPlan(['edit-1']);
  tracker.startTool('keepseek_run_validation');
  tracker.finishTool('keepseek_run_validation', barrierResult());
  tracker.complete('Prepared the change; the host applies it after this run.');

  assert.equal(runDetailsStatus(tracker, { awaitingApply: true }), 'waiting');
  // Control: without the barrier fact the same plan is an ordinary success, so
  // the assertion above is really about the waiting state, not about plan.status.
  assert.equal(runDetailsStatus(tracker, { awaitingApply: false }), 'succeeded');
});

test('a real validation failure still blocks the plan and the run', () => {
  const tracker = createPlan(['edit-1']);
  tracker.startTool('keepseek_run_validation');
  const failure = JSON.stringify({ ok: false, authorized: true, exitCode: 1, error: 'Compile failed.' });
  tracker.finishTool('keepseek_run_validation', failure);
  const repairLoop = new RepairLoopTracker(3);
  const outcome = repairLoop.recordValidationResult(failure);
  assert.equal(outcome.failed, true);
  tracker.beginRepair(1, 3, outcome.summary);

  const plan = tracker.complete('Validation failed.');
  assert.equal(plan.status, 'blocked', 'a failing script keeps the round blocked');
  assert.ok(plan.blockers.length > 0, 'a real failure keeps its blocker');
  assert.equal(tracker.getPlan().steps.find(step => step.id === 'validate')?.status, 'blocked');
  assert.equal(tracker.isAwaitingApply(), false, 'a failure is not a waiting state');
  assert.equal(new RunDetailsBuilder({ runId: 'run-1', modelId: 'model-1', thinkingEnabled: false }).finish({
    taskPlan: plan,
    repairLoop: repairLoop.getState(),
    awaitingApply: tracker.isAwaitingApply()
  }).status, 'blocked');
});

test('sandbox and authorization denials keep their blocked semantics', () => {
  const tracker = createPlan(['edit-1']);
  tracker.startTool('keepseek_run_validation');
  tracker.finishTool('keepseek_run_validation', JSON.stringify({
    ok: false, errorType: 'authorization_denied', error: 'Denied.'
  }));
  assert.equal(tracker.complete('Denied.').status, 'blocked');
  assert.equal(tracker.isAwaitingApply(), false);
  // The repair loop must treat a denial as blocked, not as a consumed attempt.
  const repairLoop = new RepairLoopTracker(3);
  const outcome = repairLoop.recordValidationResult(JSON.stringify({ ok: false, errorType: 'authorization_denied' }));
  assert.equal(outcome.failed, false);
  assert.equal(repairLoop.getState().status, 'blocked');
  assert.equal(repairLoop.getState().iteration, 0, 'a denial consumes no repair iteration');
});

test('validation_unavailable keeps its skipped semantics and is not a waiting state', () => {
  const tracker = createPlan(['edit-1']);
  tracker.startTool('keepseek_run_validation');
  tracker.finishTool('keepseek_run_validation', JSON.stringify({
    ok: false, errorType: 'validation_unavailable', executed: false, error: 'No fixed script.'
  }));
  const validate = tracker.getPlan().steps.find(step => step.id === 'validate');
  assert.equal(validate?.status, 'skipped', 'a missing script stays unavailable, not waiting');
  assert.equal(tracker.isAwaitingApply(), false);
});

test('a real failure after a barrier is still blocked, not masked as waiting', () => {
  const tracker = createPlan(['edit-1']);
  tracker.startTool('keepseek_run_validation');
  tracker.finishTool('keepseek_run_validation', barrierResult());
  // The host applied the ChangeSet, validation really ran, and it failed.
  tracker.startTool('keepseek_run_validation');
  tracker.finishTool('keepseek_run_validation', JSON.stringify({
    ok: false, authorized: true, exitCode: 2, error: 'Compile failed.'
  }));

  const plan = tracker.complete('Validation failed.');
  assert.equal(plan.status, 'blocked');
  assert.ok(plan.blockers.length > 0, 'the real failure keeps its blocker');
  const status = new RunDetailsBuilder({ runId: 'run-1', modelId: 'model-1', thinkingEnabled: false }).finish({
    taskPlan: plan,
    repairLoop: { status: 'idle', iteration: 0, maxIterations: 3, pendingDraftEditIds: [] },
    awaitingApply: tracker.isAwaitingApply()
  }).status;
  assert.equal(status, 'blocked', 'a blocked plan is never overridden by the waiting fact');
});
