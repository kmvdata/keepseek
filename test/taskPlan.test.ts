import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markTaskPlanReadyForValidation, TaskPlanTracker } from '../src/agent/taskPlan';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME
} from '../src/agent/protocol';

test('task plan treats pending file deletion as an edit step', () => {
  const english = new TaskPlanTracker({
    runId: 'run-delete-en',
    prompt: 'Delete src/obsolete.ts.',
    language: 'en'
  });
  english.beginExecution();
  english.startTool(DELETE_WORKSPACE_FILE_TOOL_NAME);

  const englishEdit = english.getPlan().steps.find((step) => step.id === 'edit');
  assert.equal(englishEdit?.status, 'in_progress');
  assert.equal(englishEdit?.detail, 'Preparing a pending file deletion');

  const chinese = new TaskPlanTracker({
    runId: 'run-delete-zh',
    prompt: '删除 src/obsolete.ts。',
    language: 'zh-CN'
  });
  chinese.beginExecution();
  chinese.startTool(DELETE_WORKSPACE_FILE_TOOL_NAME);

  const chineseEdit = chinese.getPlan().steps.find((step) => step.id === 'edit');
  assert.equal(chineseEdit?.status, 'in_progress');
  assert.equal(chineseEdit?.detail, '准备待确认文件删除');
});

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

test('moves a paused repair plan from ChangeSet apply to ready validation', () => {
  const tracker = new TaskPlanTracker({
    runId: 'run-repair',
    sessionId: 'session-repair',
    prompt: 'Fix compile errors',
    language: 'en'
  });
  tracker.beginExecution();
  tracker.beginRepair(1, 2, 'compile failed');
  tracker.markProblemsRead();
  tracker.markGeneratingRepair();
  tracker.markWaitingForApply('Apply the repair ChangeSet.');

  const ready = markTaskPlanReadyForValidation(tracker.getPlan(), 'en');

  assert.equal(ready.status, 'running');
  assert.equal(ready.currentStepId, 'repair_validate');
  assert.equal(ready.steps.find((step) => step.id === 'repair_wait_apply')?.status, 'completed');
  assert.equal(ready.steps.find((step) => step.id === 'repair_validate')?.status, 'in_progress');
  assert.deepEqual(ready.blockers, []);
});

test('task plan exposes planner and review subagent phases', () => {
  const tracker = new TaskPlanTracker({
    runId: 'run-model-strategy',
    prompt: 'Plan and implement the change.',
    language: 'en'
  });
  tracker.beginPlanning();
  assert.equal(tracker.getPlan().currentStepId, 'planning');
  tracker.finishPlanning(true);
  tracker.beginSubagentReview();
  assert.equal(tracker.getPlan().currentStepId, 'subagent_review');
  tracker.finishSubagentReview(true);
  const plan = tracker.complete('Done.');
  assert.equal(plan.steps.find((step) => step.id === 'planning')?.status, 'completed');
  assert.equal(plan.steps.find((step) => step.id === 'subagent_review')?.status, 'completed');
});
