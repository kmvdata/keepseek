import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { applyChangeSetEventToRunDetails, RunDetailsBuilder } from '../src/agent/logging/runDetails';
import { createChangeSet } from '../src/edits/changeSet';
import type { ChangeSet, RepairLoopState, TaskPlan } from '../src/shared/types';

describe('RunDetailsBuilder', () => {
  it('redacts sensitive arguments and summarizes tools, validation, and waiting state', () => {
    const builder = new RunDetailsBuilder({
      runId: 'run-1',
      sessionId: 'session-1',
      assistantMessageId: 'message-1',
      modelId: 'deepseek-v4-flash',
      thinkingEnabled: true
    });
    builder.record({
      type: 'tool_call',
      toolCall: { id: 'tool-1', function: { name: 'keepseek_run_validation', arguments: '{}' } }
    });
    builder.recordToolArguments('tool-1', 'keepseek_run_validation', {
      script: 'test',
      apiKey: 'must-not-leak',
      content: 'large source body'
    });
    builder.recordToolResult('tool-1', 'keepseek_run_validation', JSON.stringify({
      ok: false,
      script: 'test',
      authorized: true,
      exitCode: 1,
      durationMs: 42,
      diagnostics: { errors: 2, warnings: 1 }
    }));
    builder.setRunContext({
      precedence: ['core', 'project', 'skill'],
      beforeDeduplicationCount: 2,
      afterDeduplicationCount: 1,
      totalCharacterCount: 120,
      totalTokenEstimate: 30,
      truncated: false,
      sources: [{
        id: 'skill-1',
        kind: 'skill',
        label: 'review-flow',
        uri: 'file:///workspace/.agents/skills/review-flow/SKILL.md',
        source: 'agentsWorkspace',
        activation: 'implicit',
        reason: 'Deterministic request match.',
        characterCount: 120,
        tokenEstimate: 30,
        contentHash: 'hash',
        truncated: false,
        scriptsPresent: true
      }],
      discarded: [{
        id: 'duplicate-skill',
        kind: 'skill',
        reason: 'duplicate_skill',
        keptId: 'skill-1'
      }],
      possibleConflicts: []
    });
    const plan = createPlan('blocked');
    const repairLoop: RepairLoopState = {
      status: 'waiting_for_apply',
      iteration: 1,
      maxIterations: 5,
      pendingDraftEditIds: ['edit-1'],
      stopReason: 'waiting_for_apply'
    };
    const summary = builder.finish({ taskPlan: plan, repairLoop });

    assert.equal(summary.status, 'waiting');
    assert.equal(summary.validations[0].errors, 2);
    assert.match(summary.toolCalls[0].argumentsSummary ?? '', /\[redacted\]/u);
    assert.ok(!(summary.toolCalls[0].argumentsSummary ?? '').includes('must-not-leak'));
    assert.match(summary.toolCalls[0].argumentsSummary ?? '', /"chars":17/u);
    assert.equal(summary.contextSources[0]?.activation, 'implicit');
    assert.equal(summary.contextSources[0]?.scriptsPresent, true);
    assert.equal(summary.contextDiscarded[0]?.reason, 'duplicate_skill');
  });

  it('updates persisted ChangeSet summaries after apply', () => {
    const builder = new RunDetailsBuilder({
      runId: 'run-2',
      modelId: 'deepseek-v4-flash',
      thinkingEnabled: false
    });
    builder.record({ type: 'change_set_created', changeSetId: 'change-1', fileCount: 2, files: [] });
    const summary = builder.finish({
      taskPlan: createPlan('completed'),
      repairLoop: { status: 'completed', iteration: 0, maxIterations: 2, pendingDraftEditIds: [] }
    });
    const updated = applyChangeSetEventToRunDetails(summary, {
      type: 'change_set_apply_result',
      result: { changeSetId: 'change-1', appliedEditIds: ['a', 'b'], failed: [] }
    });
    assert.equal(updated.changeSets[0].status, 'applied');
    assert.equal(updated.changeSets[0].appliedCount, 2);
  });

  it('tracks single-file discard and mixed file status in the lightweight history summary', () => {
    const changeSet = createTwoFileChangeSet();
    const summary = createSummaryWithChangeSet(changeSet);
    const updated = applyChangeSetEventToRunDetails(summary, {
      type: 'change_set_file_discarded',
      changeSetId: changeSet.id,
      editId: 'edit-a'
    });

    assert.equal(updated.changeSets[0].status, 'pending');
    assert.deepEqual(updated.changeSets[0].files?.map((file) => file.status), ['discarded', 'pending']);
  });

  it('uses the current ChangeSet snapshot for partial apply and failed revert outcomes', () => {
    const changeSet = createTwoFileChangeSet();
    const summary = createSummaryWithChangeSet(changeSet);
    changeSet.files[0].status = 'applied';
    changeSet.files[1].status = 'apply_failed';
    changeSet.files[1].error = 'Cannot write b.ts';
    changeSet.status = 'partially_failed';

    const applied = applyChangeSetEventToRunDetails(summary, {
      type: 'change_set_apply_result',
      result: {
        changeSetId: changeSet.id,
        appliedEditIds: ['edit-a'],
        failed: [{ editId: 'edit-b', error: 'Cannot write b.ts' }]
      }
    }, changeSet);
    assert.equal(applied.changeSets[0].status, 'partially_failed');
    assert.deepEqual(applied.changeSets[0].files?.map((file) => file.status), ['applied', 'apply_failed']);
    assert.equal(applied.changeSets[0].failedCount, 1);

    changeSet.files[0].status = 'revert_failed';
    changeSet.files[0].error = 'File changed after apply';
    const reverted = applyChangeSetEventToRunDetails(applied, {
      type: 'change_set_revert_result',
      result: {
        changeSetId: changeSet.id,
        revertedEditIds: [],
        failed: [{ editId: 'edit-a', error: 'File changed after apply' }]
      }
    }, changeSet);
    assert.equal(reverted.changeSets[0].files?.[0]?.status, 'revert_failed');
    assert.match(reverted.changeSets[0].files?.[0]?.error ?? '', /changed after apply/u);
  });
});

function createTwoFileChangeSet(): ChangeSet {
  const changeSet = createChangeSet({
    runId: 'run-change-set',
    sessionId: 'session-1',
    messageId: 'message-1',
    operationSummary: 'Update two files',
    edits: [
      { id: 'edit-a', uri: 'file:///a.ts', label: 'a.ts', action: 'modify', newText: 'a', reason: 'A' },
      { id: 'edit-b', uri: 'file:///b.ts', label: 'b.ts', action: 'modify', newText: 'b', reason: 'B' }
    ]
  });
  assert.ok(changeSet);
  return changeSet;
}

function createSummaryWithChangeSet(changeSet: ChangeSet) {
  const builder = new RunDetailsBuilder({
    runId: changeSet.runId,
    sessionId: changeSet.sessionId,
    assistantMessageId: changeSet.messageId,
    modelId: 'deepseek-v4-flash',
    thinkingEnabled: false
  });
  return builder.finish({
    taskPlan: createPlan('completed'),
    repairLoop: { status: 'completed', iteration: 0, maxIterations: 2, pendingDraftEditIds: [] },
    changeSet
  });
}

function createPlan(status: TaskPlan['status']): TaskPlan {
  const now = new Date().toISOString();
  return {
    id: 'plan-1',
    runId: 'run-1',
    goal: 'Validate the workspace',
    status,
    steps: [{ id: 'validate', title: 'Validate', status: status === 'completed' ? 'completed' : 'blocked', updatedAt: now }],
    blockers: status === 'blocked' ? ['Apply the pending ChangeSet.'] : [],
    createdAt: now,
    updatedAt: now
  };
}
