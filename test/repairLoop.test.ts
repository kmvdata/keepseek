import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RepairLoopTracker, RunValidationStateTracker } from '../src/agent/repairLoop';

test('allows validation before a DraftEdit and blocks it after any ordinary pending DraftEdit', () => {
  const tracker = new RunValidationStateTracker('workspace_baseline');
  assert.equal(tracker.hasPendingDraftEdit(), false);

  tracker.recordValidationResult(JSON.stringify({ ok: true }));
  tracker.recordDraftEdit('ordinary-edit');

  assert.equal(tracker.hasPendingDraftEdit(), true);
  const blocked = JSON.parse(tracker.createBlockedValidationResult('en')) as Record<string, unknown>;
  assert.equal(blocked.ok, false);
  assert.equal(blocked.errorType, 'pending_changes_require_apply');
  assert.deepEqual(blocked.pendingDraftEditIds, ['ordinary-edit']);
  assert.equal(blocked.suggestedAction, 'apply_pending_changes');
  const english = tracker.decorateFinalMessage('Changes are ready and tests passed.', 'en');
  assert.doesNotMatch(english, /tests passed/u);
  assert.match(english, /covered only the pre-change workspace baseline/u);
  assert.match(tracker.decorateFinalMessage('修改已准备并且测试通过。', 'zh-CN'), /只覆盖修改前的工作区基线/u);
});

test('reports post-Apply validation separately from pending follow-up repairs', () => {
  const tracker = new RunValidationStateTracker('post_apply');
  tracker.recordValidationResult(JSON.stringify({ ok: false }));
  assert.match(tracker.decorateFinalMessage('Still failing.', 'en'), /post-Apply validation failed/u);

  tracker.recordDraftEdit('repair-2');
  const message = tracker.decorateFinalMessage('Prepared another repair.', 'en');
  assert.match(message, /post-Apply validation failed/u);
  assert.match(message, /newly prepared repair DraftEdits remain unapplied and unvalidated/u);
});

test('removes unsupported validation claims when a pending DraftEdit has never been validated', () => {
  const tracker = new RunValidationStateTracker('workspace_baseline');
  tracker.recordDraftEdit('unvalidated-edit');

  const message = tracker.decorateFinalMessage('The edit is ready and all tests passed.', 'en');
  assert.doesNotMatch(message, /tests passed/u);
  assert.match(message, /they are not written or validated/u);
});

test('ordinary DraftEdits do not consume or require automatic repair iterations', () => {
  const tracker = new RepairLoopTracker(0);
  assert.equal(tracker.beginRepair(), true);
  assert.equal(tracker.getState().status, 'idle');
});

test('pauses repair validation until the generated DraftEdit is applied', () => {
  const events: string[] = [];
  const tracker = new RepairLoopTracker(2, (event) => events.push(event.type));
  tracker.startValidation('compile');
  const failure = tracker.recordValidationResult(JSON.stringify({
    ok: false,
    authorized: true,
    exitCode: 2,
    error: 'compile failed',
    diagnostics: { errors: 1, warnings: 0 }
  }));

  assert.equal(failure.failed, true);
  assert.equal(failure.limitReached, false);
  tracker.recordProblemsRead();
  assert.equal(tracker.beginRepair(), true);
  tracker.recordDraftEdit('edit-1');

  assert.deepEqual(tracker.getState(), {
    status: 'waiting_for_apply',
    iteration: 1,
    maxIterations: 2,
    lastValidationScript: 'compile',
    lastFailureSummary: 'compile failed; exitCode=2; diagnostics: errors=1, warnings=0',
    pendingDraftEditIds: ['edit-1'],
    stopReason: 'waiting_for_apply'
  });
  assert.equal(tracker.hasPendingRepair(), true);
  assert.ok(events.includes('repair_loop_waiting_for_apply'));
});

test('does not consume repair iterations for authorization denial', () => {
  const tracker = new RepairLoopTracker(2);
  tracker.startValidation('test');
  const result = tracker.recordValidationResult(JSON.stringify({
    ok: false,
    errorType: 'authorization_denied',
    error: 'denied'
  }));

  assert.equal(result.failed, false);
  assert.equal(tracker.getState().iteration, 0);
  assert.equal(tracker.getState().stopReason, 'authorization_denied');
});

test('stops automatic repair when the configured limit is reached', () => {
  const tracker = new RepairLoopTracker(1);
  tracker.startValidation('lint');
  tracker.recordValidationResult(JSON.stringify({ ok: false, authorized: true, exitCode: 1 }));
  tracker.startValidation('lint');
  const second = tracker.recordValidationResult(JSON.stringify({ ok: false, authorized: true, exitCode: 1 }));

  assert.equal(second.limitReached, true);
  assert.equal(tracker.beginRepair(), false);
  assert.equal(tracker.getState().stopReason, 'repair_iteration_limit');
});
