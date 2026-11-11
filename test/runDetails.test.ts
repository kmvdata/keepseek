import { createFullTextDraftEdit } from '../src/edits/draftEdit';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { applyChangeSetEventToRunDetails, RunDetailsBuilder } from '../src/agent/logging/runDetails';
import { createChangeSet } from '../src/edits/changeSet';
import type { ChangeSet, RepairLoopState, TaskPlan } from '../src/shared/types';
import { normalizeRunDetailsDelegation } from '../src/agent/logging/subagentDetails';
import { normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { getScript } from '../src/webview/script';
import { createWebviewDomHarness } from './webviewDomHarness';

describe('RunDetailsBuilder', () => {
  it('restores audit snapshots and renders approval provenance and interruption in both languages', () => {
    const builder = new RunDetailsBuilder({ runId: 'review-run', modelId: 'main-model', thinkingEnabled: false });
    const timestamp = '2026-11-11T00:00:00.000Z';
    const baseReview = { sessionId: 'A', rootTaskId: 'task', agentRunId: 'review-run', targetId: 'exact-target',
      actionKind: 'draft_run_execute', createdAt: timestamp, risk: 'low', rationale: 'Fixture rationale', decision: 'approve' };
    const session = normalizeStoredSessions({ sessions: [{ id: 'A', title: 'Audit', createdAt: timestamp,
      messages: [{ id: 'assistant', role: 'assistant', content: '', createdAt: timestamp, runDetails: { ...builder.build(),
        authorizations: [{ toolName: 'coarse-source', allowed: true, riskLevel: 'low', scope: 'validation', source: 'delegated_approver' }],
        approvalReviews: [
          { ...baseReview, reviewId: 'historical-host', approvalSource: 'host_policy', policyVersion: 2 },
          { ...baseReview, reviewId: 'historical-model', approvalSource: 'auto_approval_review', policyVersion: 5, reviewerModelId: 'older-reviewer' },
          { ...baseReview, reviewId: 'historical-user', approvalSource: 'user_click', policyVersion: 2 },
          { ...baseReview, reviewId: 'new-review', approvalSource: 'auto_approval_review', policyVersion: 6,
            reviewerSourceId: 'review-source', reviewerModelId: 'actual-reviewer', decision: 'needs_user', risk: 'critical' },
          { ...baseReview, reviewId: 'invalid-config', approvalSource: 'auto_approval_review', policyVersion: 6,
            reviewerModelId: 'never-requested', decision: 'unavailable', reviewState: 'configuration_unavailable' },
          { ...baseReview, reviewId: 'interrupted', approvalSource: 'auto_approval_review', policyVersion: 6,
            decision: 'unavailable', reviewState: 'in_progress', exactAction: { secret: 'never-display' } }
        ] } }]
    }] }, { key: 'workspace:ui', name: 'UI', folderUris: [] })[0];
    const reviews = session.messages[0].runDetails?.approvalReviews;
    assert.deepEqual(reviews?.map(review => review.policyVersion), [2, 5, 2, 6, 6, 6]);
    assert.equal(reviews?.at(-1)?.reviewState, 'interrupted');
    assert.doesNotMatch(JSON.stringify(reviews), /never-display/u);
    for (const language of ['zh-CN', 'en'] as const) {
      const view = createWebviewDomHarness();
      view.receive({ type: 'state', revision: 1, state: { activeSessionId: session.id, language, messages: session.messages,
        startup: { interactiveReady: true, sideEffectsReady: true } } });
      const details = view.element('transcript').querySelector('.run-details');
      assert.ok(details);
      const labels = WEBVIEW_TRANSLATIONS[language];
      for (const label of [labels.approvalSourceHost, labels.approvalSourceDelegatedExecution, labels.approvalNeedsUser,
        labels.approvalRiskCritical, labels.approvalReviewState_configuration_unavailable, labels.approvalReviewState_interrupted]) {
        assert.ok(details.textContent.includes(label), label);
      }
      assert.match(details.textContent, /review-source \/ actual-reviewer/u);
      assert.doesNotMatch(details.textContent, /never-requested|never-display/u);
      assert.equal(details.textContent.split(labels.approvalSourceHost).length - 1, 1);
    }
  });

  it('keeps lifecycle, partial completion, parent acceptance and unavailable detail distinct without private content', () => {
    const builder = new RunDetailsBuilder({ runId: 'run-child', modelId: 'model', thinkingEnabled: false });
    builder.recordToolResult('child', 'keepseek_delegate_task', JSON.stringify({
      version: 3, kind: 'subagent_result_manifest', ok: true, subagentId: 'sa_child', profile: 'research',
      status: 'completed', resultStatus: 'partial', formatAccepted: true, parentAcceptance: 'pending',
      resultRef: 'sa_child', summary: 'private conclusion', preview: 'private child body',
      transcript: 'private trace'
    }));
    let display = builder.build().delegation!;
    assert.equal(display.results[0].lifecycleStatus, 'completed');
    assert.equal(display.results[0].resultStatus, 'partial');
    assert.equal(display.results[0].formatAccepted, true);
    assert.equal(display.results[0].parentAcceptance, 'pending');
    assert.equal(JSON.stringify(display).includes('private'), false);
    const plan = createPlan('blocked');
    const delegation = {
      version: 1, candidates: [{ id: 'c1', task: 'private branch task' }],
      assessment: { trigger: 'initial', decision: 'delegate', reason: 'Two independent modules' },
      results: [{ candidateId: 'c1', subagentId: 'sa_child', resultRef: 'sa_child', resultStatus: 'partial',
        formatAccepted: true, acceptance: 'needs_details', reason: 'apiKey=do-not-show Need exact evidence' }],
      events: [{ kind: 'returned', subagentId: 'sa_child' }]
    };
    Object.assign(plan, { delegation });
    builder.record({ type: 'task_plan_update', plan });
    delegation.results[0].acceptance = 'adopt';
    builder.recordToolArguments('page', 'keepseek_read_subagent_result', { ref: 'sa_child', offsetBytes: 0 });
    builder.recordToolResult('page', 'keepseek_read_subagent_result', JSON.stringify({ ok: false, errorType: 'subagent_result_corrupt' }));
    display = builder.build().delegation!;
    assert.equal(display.candidateCount, 1);
    assert.equal(display.results[0].parentAcceptance, 'needs_details');
    assert.equal(display.results[0].detailsAvailable, false);
    assert.equal(display.results[0].lifecycleStatus, 'completed');
    assert.equal(JSON.stringify(display).includes('do-not-show'), false);
    assert.equal(JSON.stringify(display).includes('private branch task'), false);
    assert.match(display.results[0].reason!, /\[redacted\]/u);
  });

  it('persists bounded display metadata and keeps legacy completed results semantically unknown', () => {
    const builder = new RunDetailsBuilder({ runId: 'run-legacy-child', modelId: 'model', thinkingEnabled: false });
    builder.recordToolResult('child', 'keepseek_delegate_task', JSON.stringify({
      version: 2, kind: 'subagent_result_manifest', ok: true, subagentId: 'sa_old', status: 'completed', resultRef: 'sa_old'
    }));
    assert.equal(builder.build().delegation!.results[0].resultStatus, 'unknown');
    const bounded = normalizeRunDetailsDelegation({
      version: 1, candidateCount: 1000, explicitSelection: 'parallel', explicitUnfulfilled: true,
      results: Array.from({ length: 40 }, (_, i) => ({ subagentId: `sa_${i}`, resultStatus: 'partial', privateTrace: 'must omit' })),
      events: Array.from({ length: 50 }, () => ({ kind: 'rejected', reason: 'x'.repeat(1000), privateTrace: 'must omit' }))
    })!;
    assert.equal(bounded.candidateCount, 8);
    assert.equal(bounded.results.length, 16);
    assert.equal(bounded.events.length, 16);
    assert.equal(bounded.events[0].reason?.length, 240);
    const session = normalizeStoredSessions({ sessions: [{
      id: 'session-ui', workspaceKey: 'workspace:ui', title: 'UI', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      messages: [{ id: 'm-ui', role: 'assistant', content: '', createdAt: new Date().toISOString(),
        runDetails: { ...builder.build(), delegation: { ...bounded, privateTrace: 'must omit' } } }]
    }] }, { key: 'workspace:ui', name: 'UI', folderUris: [] })[0];
    assert.deepEqual(session.messages[0].runDetails?.delegation, bounded);
    assert.equal(JSON.stringify(session.messages[0].runDetails?.delegation).includes('must omit'), false);
    assert.equal(normalizeRunDetailsDelegation({ version: 999, results: [] }), undefined);
    const invalidAdoption = normalizeRunDetailsDelegation({ version: 1, results: [
      { subagentId: 'sa_partial', resultStatus: 'partial', formatAccepted: true, parentAcceptance: 'accepted' }
    ] })!;
    assert.equal(invalidAdoption.results[0].parentAcceptance, 'pending');
  });

  it('renders translated completion and parent judgment states without implying an execution permit', () => {
    const script = getScript();
    const start = script.indexOf('    function formatDelegationDetails(');
    const end = script.indexOf('    function formatDateTime(', start);
    assert.ok(start >= 0 && end > start);
    for (const language of ['zh-CN', 'en'] as const) {
      const translate = (key: string, values: Record<string, string | number> = {}) =>
        Object.entries(values).reduce((value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)),
          WEBVIEW_TRANSLATIONS[language][key] ?? key);
      const render = new Function('t', `${script.slice(start, end)};return formatDelegationDetails;`)(translate) as (value: unknown) => string[];
      const lines = render({
        version: 1, candidateCount: 1, explicitSelection: 'parallel', explicitUnfulfilled: true,
        results: [{ subagentId: 'sa_partial', lifecycleStatus: 'completed', resultStatus: 'partial', formatAccepted: true,
          parentAcceptance: 'needs_details', detailsAvailable: false, resultRef: 'sa_partial' }], events: []
      }).join('\n');
      assert.ok(lines.includes(translate('subagentStatus_completed')));
      assert.ok(lines.includes(translate('runDetailsChildResult_partial')));
      assert.ok(lines.includes(translate('runDetailsChildAcceptance_needs_details')));
      assert.ok(lines.includes(translate('runDetailsChildDetailsUnavailable')));
      assert.ok(lines.includes(translate('runDetailsDelegationUnfulfilled')));
      assert.equal(lines.includes('runDetailsChild'), false);
      assert.match(translate('runDetailsChildAcceptance_accepted'), language === 'en' ? /no execution permission/u : /非执行许可/u);
    }
    assert.doesNotThrow(() => new Function(script));
  });

  it('preserves partial audit status while showing replacement by an accepted complete follow-up', () => {
    const builder = new RunDetailsBuilder({ runId: 'run-follow-up', modelId: 'model', thinkingEnabled: false });
    const plan = createPlan('completed');
    Object.assign(plan, { delegation: {
      version: 1, candidates: [{ id: 'c1' }], events: [], results: [
        { candidateId: 'c1', subagentId: 'sa_partial', resultStatus: 'partial', formatAccepted: true,
          resultRef: 'sa_partial', acceptance: 'investigate', supersededBy: 'sa_followup' },
        { candidateId: 'c1', subagentId: 'sa_followup', resultStatus: 'complete', formatAccepted: true,
          resultRef: 'sa_followup', acceptance: 'adopt' }
      ]
    } });
    builder.record({ type: 'task_plan_update', plan });
    const display = builder.build().delegation!;
    assert.equal(display.results[0].resultStatus, 'partial');
    assert.equal(display.results[0].parentAcceptance, 'needs_followup');
    assert.equal(display.results[0].supersededBy, 'sa_followup');
    assert.deepEqual(normalizeRunDetailsDelegation(JSON.parse(JSON.stringify(display))), display);
    const archivedPlan = createPlan('completed');
    Object.assign(archivedPlan, { delegation: { version: 1, candidates: [], results: [], events: [
      { kind: 'accepted_window_archived' }
    ] } });
    builder.record({ type: 'task_plan_update', plan: archivedPlan });
    assert.equal(builder.build().delegation!.results[0].supersededBy, 'sa_followup');
    assert.equal(builder.build().delegation!.results[1].parentAcceptance, 'accepted');
    const reopenedPlan = structuredClone(plan);
    const reopened = reopenedPlan as unknown as { delegation: { results: Array<{ supersededBy?: string }> } };
    delete reopened.delegation.results[0].supersededBy;
    builder.record({ type: 'task_plan_update', plan: reopenedPlan });
    assert.equal(builder.build().delegation!.results[0].supersededBy, undefined);
    const invalid = normalizeRunDetailsDelegation({ ...display, results: [
      { ...display.results[0], supersededBy: 'sa_missing' },
      display.results[1]
    ] })!;
    assert.equal(invalid.results[0].supersededBy, undefined);
    const unaccepted = normalizeRunDetailsDelegation({ ...display, results: [
      display.results[0], { ...display.results[1], parentAcceptance: 'pending' }
    ] })!;
    assert.equal(unaccepted.results[0].supersededBy, undefined);
    const script = getScript();
    const start = script.indexOf('    function formatDelegationDetails(');
    const end = script.indexOf('    function formatDateTime(', start);
    for (const language of ['zh-CN', 'en'] as const) {
      const translate = (key: string) => WEBVIEW_TRANSLATIONS[language][key] ?? key;
      const render = new Function('t', `${script.slice(start, end)};return formatDelegationDetails;`)(translate) as (value: unknown) => string[];
      const partialLine = render(display).find((line) => line.startsWith('sa_partial'))!;
      assert.ok(partialLine.includes(translate('runDetailsChildResult_partial')));
      assert.ok(partialLine.includes(translate('runDetailsChildSuperseded')));
      assert.ok(partialLine.includes('sa_followup'));
      assert.equal(partialLine.includes(translate('runDetailsChildAcceptance_pending')), false);
      assert.equal(partialLine.includes(translate('runDetailsChildAcceptance_needs_followup')), false);
    }
  });

  it('records budget rejection without duplicating or changing actual validation evidence', () => {
    const builder = new RunDetailsBuilder({ runId: 'run-budget', modelId: 'model', thinkingEnabled: false });
    builder.recordToolResult('validation', 'keepseek_run_validation', JSON.stringify({ ok: true, script: 'test', exitCode: 0 }));
    builder.recordToolResult('validation', 'keepseek_run_validation', JSON.stringify({ ok: false, budgetReason: 'tool_result_budget_exhausted',
      usedTokens: 60000, nextTokens: 8000, maxTokens: 64000 }), { deliveryOnly: true });
    const summary = builder.build();
    assert.equal(summary.validations.length, 1);
    assert.equal(summary.validations[0].ok, true);
    assert.equal(summary.toolCalls[0].status, 'failed');
    assert.equal(JSON.parse(summary.toolCalls[0].resultSummary!).maxTokens, 64000);
  });

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
    builder.setHistorySummaries([{
      id: 'summary-1',
      content: 'not exposed in Run Details',
      coveredMessageIds: ['older-message'],
      createdAt: '2026-08-25T00:00:00.000Z',
      updatedAt: '2026-08-25T00:00:00.000Z',
      tokenEstimate: 20,
      modelId: 'summary-model',
      sourceId: 'summary-source',
      provider: 'openai-compatible',
      version: 1
    }]);
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
    assert.deepEqual(summary.historySummaries, [{
      modelId: 'summary-model',
      sourceId: 'summary-source',
      provider: 'openai-compatible',
      createdAt: '2026-08-25T00:00:00.000Z'
    }]);
    assert.equal(JSON.stringify(summary).includes('not exposed in Run Details'), false);
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

  it('rekeys the final Run Details summary to the canonical checkpoint ChangeSet', () => {
    const finalChangeSet = createTwoFileChangeSet();
    const summary = createSummaryWithChangeSet(finalChangeSet);
    const canonicalChangeSet: ChangeSet = {
      ...finalChangeSet,
      id: 'checkpoint-change-set',
      files: finalChangeSet.files.map((file) => ({ ...file }))
    };

    const updated = applyChangeSetEventToRunDetails(summary, {
      type: 'change_set_merged',
      changeSetId: canonicalChangeSet.id,
      incomingChangeSetId: finalChangeSet.id,
      addedEditIds: []
    }, canonicalChangeSet);

    assert.equal(updated.changeSets.length, 1);
    assert.equal(updated.changeSets[0]?.id, canonicalChangeSet.id);
    assert.deepEqual(updated.changeSets[0]?.files?.map((file) => file.id), ['edit-a', 'edit-b']);
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
      createFullTextDraftEdit({ id: 'edit-a', uri: 'file:///a.ts', label: 'a.ts', action: 'modify', content: 'a', reason: 'A' }),
      createFullTextDraftEdit({ id: 'edit-b', uri: 'file:///b.ts', label: 'b.ts', action: 'modify', content: 'b', reason: 'B' })
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
