import assert from 'node:assert/strict';
import { test } from 'node:test';
import { RepairLoopTracker } from '../src/agent/repairLoop';

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
