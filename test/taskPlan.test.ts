import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskPlanTracker } from '../src/agent/taskPlan';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME
} from '../src/agent/protocol';

test('task plan tracks inspection, edit, validation, and blockers', () => {
  const updates: string[] = [];
  const tracker = new TaskPlanTracker({
    runId: 'run-1',
    sessionId: 'session-1',
    prompt: 'Implement the requested capability.\nKeep the rest unchanged.',
    language: 'en',
    onChange: (plan) => updates.push(plan.status)
  });

  tracker.beginExecution();
  tracker.startTool(READ_WORKSPACE_FILE_RANGE_TOOL_NAME);
  tracker.finishTool(READ_WORKSPACE_FILE_RANGE_TOOL_NAME, JSON.stringify({ ok: true }));
  tracker.startTool(CREATE_DRAFT_EDIT_TOOL_NAME);
  tracker.finishTool(CREATE_DRAFT_EDIT_TOOL_NAME, JSON.stringify({ ok: true }));
  tracker.startTool(RUN_VALIDATION_TOOL_NAME);
  tracker.finishTool(RUN_VALIDATION_TOOL_NAME, JSON.stringify({ ok: false, error: 'lint failed' }));
  const plan = tracker.complete('Prepared the changes; lint remains blocked.');

  assert.equal(plan.goal, 'Implement the requested capability.');
  assert.equal(plan.status, 'blocked');
  assert.equal(plan.currentStepId, undefined);
  assert.deepEqual(plan.blockers, ['lint failed']);
  assert.deepEqual(plan.steps.map((step) => step.id), ['understand', 'inspect', 'edit', 'validate', 'respond']);
  assert.equal(plan.steps.find((step) => step.id === 'validate')?.status, 'blocked');
  assert.ok(updates.length >= 6);
});

test('a later successful validation clears the earlier validation blocker', () => {
  const tracker = new TaskPlanTracker({
    runId: 'run-2',
    prompt: 'Validate the project.',
    language: 'en'
  });
  tracker.beginExecution();
  tracker.startTool(RUN_VALIDATION_TOOL_NAME);
  tracker.finishTool(RUN_VALIDATION_TOOL_NAME, JSON.stringify({ ok: false, error: 'compile failed' }));
  tracker.startTool(RUN_VALIDATION_TOOL_NAME);
  tracker.finishTool(RUN_VALIDATION_TOOL_NAME, JSON.stringify({ ok: true }));

  const plan = tracker.complete('Validation passed after the fix.');
  assert.equal(plan.status, 'completed');
  assert.deepEqual(plan.blockers, []);
});
