import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmptyQueue, enqueueNewSession, promoteToFront } from '../src/sessions/queue/projectQueue';
import {
  admitSubmission,
  decidePlanExecution,
  planningTurnProducedPlan,
  submissionMayWrite
} from '../src/sessions/queue/runGate';

/**
 * D3 admission rules: every submission starts read-only in the plan phase, and
 * only an explicit "execute plan" promotes a session that is not at the head.
 */

const KEY = 'file:///project';
const NOW = '2026-11-13T00:00:00.000Z';

function queue(...ids: string[]) {
  let value = createEmptyQueue(KEY, NOW);
  for (const id of ids) value = enqueueNewSession(value, id, NOW);
  return value;
}

test('the queue head is admitted as writable so it need not click through a plan card', () => {
  const admission = admitSubmission({ queue: queue('a', 'b'), sessionId: 'a', resolvedMode: 'normal' });
  assert.equal(admission.mode, 'normal');
  assert.equal(submissionMayWrite(admission), true);
  assert.equal(admission.mode === 'normal' && admission.reason, 'head');
});

test('a queued non-head session is admitted read-only', () => {
  const admission = admitSubmission({ queue: queue('a', 'b'), sessionId: 'b', resolvedMode: 'plan' });
  assert.equal(admission.mode, 'plan');
  assert.equal(submissionMayWrite(admission), false);
  assert.equal(admission.mode === 'plan' && admission.reason, 'queued');
});

test('a session outside the queue cannot write', () => {
  const admission = admitSubmission({ queue: queue('a'), sessionId: 'ghost', resolvedMode: 'plan' });
  assert.equal(admission.mode, 'plan');
  assert.equal(submissionMayWrite(admission), false);
});

test('without a loaded queue the resolved mode is kept', () => {
  assert.equal(admitSubmission({ queue: undefined, sessionId: 'a', resolvedMode: 'normal' }).mode, 'normal');
  assert.equal(admitSubmission({ queue: undefined, sessionId: 'a', resolvedMode: 'plan' }).mode, 'plan');
});

test('a plan-execution continuation is admitted writable', () => {
  const admission = admitSubmission({
    queue: queue('a', 'b'), sessionId: 'b', resolvedMode: 'plan', executingPlan: true
  });
  assert.equal(admission.mode, 'normal');
  assert.equal(submissionMayWrite(admission), true);
});

test('executing a plan promotes a non-head session', () => {
  const decision = decidePlanExecution({ queue: queue('a', 'b'), sessionId: 'b', hasPendingPlan: true });
  assert.equal(decision.allowed, true);
  assert.equal(decision.allowed && decision.promoteSessionId, 'b');
});

test('executing a plan requires a pending plan record', () => {
  const decision = decidePlanExecution({ queue: queue('a', 'b'), sessionId: 'b', hasPendingPlan: false });
  assert.equal(decision.allowed, false);
  assert.equal(decision.allowed === false && decision.reason, 'no_plan');
});

test('the head does not need promotion and an unqueued session is refused', () => {
  const head = decidePlanExecution({ queue: queue('a', 'b'), sessionId: 'a', hasPendingPlan: true });
  assert.equal(head.allowed, false);
  assert.equal(head.allowed === false && head.reason, 'already_head');

  const ghost = decidePlanExecution({ queue: queue('a'), sessionId: 'ghost', hasPendingPlan: true });
  assert.equal(ghost.allowed, false);
  assert.equal(ghost.allowed === false && ghost.reason, 'not_queued');
});

test('after promotion the promoted session is the writable head', () => {
  const promoted = promoteToFront(queue('a', 'b'), 'b');
  const admission = admitSubmission({ queue: promoted, sessionId: 'b', resolvedMode: 'normal' });
  assert.equal(admission.mode, 'normal');
  assert.equal(admitSubmission({ queue: promoted, sessionId: 'a', resolvedMode: 'plan' }).mode, 'plan');
});

test('a planning turn without a plan artifact may not progress to writing', () => {
  assert.equal(planningTurnProducedPlan({ mode: 'plan', hasPlanArtifact: false }), false);
  assert.equal(planningTurnProducedPlan({ mode: 'plan', hasPlanArtifact: true }), true);
  assert.equal(planningTurnProducedPlan({ mode: 'normal', hasPlanArtifact: false }), true);
});