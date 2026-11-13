import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { analyzeDraftRunEffects, inspectDraftRunScope } from '../src/approvals/authorization';
import type {
  DraftRunExecutionOutcome,
  DraftRunExecutorAdapter,
  DraftRunOutputChunk,
  VerifiedDraftRunLaunch
} from '../src/runs/draftRunExecutor';
import { createDraftRunProposal, hashDraftRunSpec } from '../src/runs/draftRunProposal';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { DraftRunAuthorizationService } from '../src/runs/draftRunAuthorization';
import { ApprovalAuditError, ApprovalReviewStore } from '../src/approvals/approvalReviewStore';
import { createDraftRunReviewRequest } from '../src/approvals/approvalReviewSurface';
import { APPROVAL_POLICY_VERSION, type ApprovalRecordMatch } from '../src/approvals/approvalReviewTypes';
import type { DraftRun, DraftRunProposal, DraftRunSpec, ExecutionPermit } from '../src/shared/types';

test('delegated DraftRun records its approval source and consumes a single immutable proposal', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor, approvalReviews }) => {
    const proposal = createProposal(workspaceRoot);
    store.addProposals({ proposals: [proposal], agentRunId: 'r', sessionId: 's' });
    const approvalRecord = await addReviewerApproval(approvalReviews, proposal, 's', 'r');
    await store.approveAndRun(proposal.id, new Set(), { delegatedApproval: () => true, approvalRecord });
    await store.approveAndRun(proposal.id, new Set(), { delegatedApproval: () => true, approvalRecord });
    assert.equal(executor.executeCount, 1);
    assert.equal(executor.lastPermit?.source, 'delegated_approver');
    assert.equal(store.get(proposal.id)?.authorizationSource, 'delegated_approver');
    const executable = executor.lastLaunch?.executable;
    assert.ok(executable && path.isAbsolute(executable));
    await store.flush();
    const reopened = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    try {
      await reopened.initialize();
      const run = reopened.get(proposal.id);
      assert.equal(run?.dispatch?.boundary, 'host');
      assert.equal(run?.dispatch?.executable, executable);
      assert.deepEqual(run?.dispatch?.args ?? run?.spec.args, proposal.spec.args);
      assert.equal(executor.executeCount, 1);
    } finally { reopened.dispose(); }
  });
});

test('manual holds and command dependencies survive restart without restoring approval authority', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor, approvalReviews }) => {
    const probe = createProposal(workspaceRoot, { id: 'probe' });
    const testRun = createProposal(workspaceRoot, { id: 'dependent-test' });
    testRun.spec.prerequisites = [{ draftRunId: probe.id, specHash: probe.specHash, condition: 'completed' }];
    testRun.specHash = hashDraftRunSpec(testRun.spec);
    store.addProposals({ proposals: [probe, testRun], sessionId: 'session', agentRunId: 'segment' });
    assert.equal(store.setPendingApproval(probe.id, probe.specHash,
      { status: 'waiting_user', reason: 'Invalid approval reply', failureCode: 'invalid_response' }), true);
    assert.equal(store.setPendingDependency(testRun.id, testRun.specHash,
      { targetId: probe.id, label: 'probe', reason: 'Waiting for a verified result' }), true);
    await store.flush();

    const reloaded = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor,
      new DraftRunAuthorizationService(approvalReviews));
    try {
      await reloaded.initialize();
      const restored = reloaded.get(probe.id);
      assert.equal(restored?.status, 'pending');
      assert.equal(restored?.executionStarted, false);
      assert.equal(restored?.executionPhase, 'not_dispatched');
      assert.equal(restored?.approvalHold?.status, 'paused');
      assert.equal(restored?.approvalHold?.pauseCause, 'host_interrupted');
      assert.equal(restored?.approvalHold?.failureCode, 'invalid_response');
      assert.equal(reloaded.get(testRun.id)?.status, 'pending');
      assert.equal(reloaded.get(testRun.id)?.dependency?.targetId, probe.id);
      assert.equal(await reloaded.approveAndRun(probe.id, new Set()), undefined);
      assert.equal(await reloaded.approveAndRun(testRun.id, new Set()), undefined);
      assert.equal(executor.executeCount, 0);
      assert.equal(reloaded.getPendingProviderTail('session', 'en'), undefined);

      assert.equal((await reloaded.preflightApproval(probe.id, new Set())).status, 'pending');
      executor.outcome = { exitCode: 0, timedOut: false, cancelled: false, started: true, phase: 'exited' };
      const approvalRecord = await addReviewerApproval(approvalReviews, probe, 'session', 'segment');
      assert.equal((await reloaded.approveAndRun(probe.id, new Set(), { delegatedApproval: () => true, approvalRecord }))?.status, 'done');
      assert.equal(reloaded.get(probe.id)?.approvalHold, undefined);
      assert.equal(await reloaded.approveAndRun(probe.id, new Set(), { delegatedApproval: () => true, approvalRecord }), undefined);
      assert.equal(executor.executeCount, 1);
      assert.equal(reloaded.setPendingDependency(testRun.id, testRun.specHash), true);
      const testApproval = await addReviewerApproval(approvalReviews, testRun, 'session', 'segment');
      assert.equal((await reloaded.approveAndRun(testRun.id, new Set(), { delegatedApproval: () => true, approvalRecord: testApproval }))?.status, 'done');
      assert.equal(executor.executeCount, 2);
    } finally { reloaded.dispose(); }
  });
});

test('an approval audit write failure pauses an unstarted run before the executor', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store, executor, approvalReviews }) => {
    const proposal = createProposal(workspaceRoot);
    store.addProposals({ proposals: [proposal], agentRunId: 'segment', sessionId: 'session' });
    const approvalRecord = await addReviewerApproval(approvalReviews, proposal, 'session', 'segment');
    approvalReviews.consumeMatchingApproval = async () => { throw new ApprovalAuditError(new Error('Fixture audit fsync failed.')); };
    const result = await store.approveAndRun(proposal.id, new Set(), { delegatedApproval: () => true, approvalRecord });
    assert.equal(result?.status, 'pending');
    assert.equal(result?.executionStarted, false);
    assert.equal(result?.executionPhase, 'not_dispatched');
    assert.equal(result?.approvalHold?.status, 'paused');
    assert.equal(result?.approvalHold?.failureCode, 'audit_persistence_failed');
    assert.equal(result?.approvalHold?.reason, 'Fixture audit fsync failed.');
    assert.equal(await store.approveAndRun(proposal.id, new Set()), undefined);
    assert.equal(executor.executeCount, 0);
  });
});

test('a failed dispatch checkpoint consumes no review and requires a fresh decision', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store, executor, approvalReviews }) => {
    const proposal = createProposal(workspaceRoot);
    store.addProposals({ proposals: [proposal], agentRunId: 'segment', sessionId: 'session' });
    const approvalRecord = await addReviewerApproval(approvalReviews, proposal, 'session', 'segment');
    const persistence = store as unknown as { persistNow(): Promise<void> };
    const persist = persistence.persistNow.bind(store);
    let writes = 0;
    persistence.persistNow = async () => {
      if (++writes === 2) throw new Error('Fixture command checkpoint fsync failed.');
      await persist();
    };
    const result = await store.approveAndRun(proposal.id, new Set(), { delegatedApproval: () => true, approvalRecord });
    assert.equal(result?.status, 'pending');
    assert.equal(result?.executionPhase, 'not_dispatched');
    assert.equal(result?.approvalHold?.failureCode, 'audit_persistence_failed');
    assert.equal(result?.approvalHold?.reason, 'Fixture command checkpoint fsync failed.');
    assert.equal(approvalReviews.get(approvalRecord.reviewId)?.consumedAt, undefined);
    assert.equal(await store.approveAndRun(proposal.id, new Set()), undefined);
    assert.equal(executor.executeCount, 0);
  });
});

test('a historical unavailable approval can explicitly produce one fresh never-dispatched proposal', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    const probe = createProposal(workspaceRoot, { id: 'legacy-probe' });
    const [source] = store.addProposals({ proposals: [probe], agentRunId: 'segment', sessionId: 'session', messageId: 'assistant' });
    const unavailable = { reviewId: 'old-review', runtimeId: 'old-runtime', sessionId: 'session', rootTaskId: 'task',
      agentRunId: 'segment', targetId: source.id, actionKind: 'draft_run_execute', actionHash: source.specHash,
      policyVersion: 6, approvalMode: 'delegate', approvalSource: 'auto_approval_review', decision: 'unavailable',
      reviewState: 'invalid_response', risk: 'high', rationale: 'Approval reviewer response failed strict schema validation.',
      policyRules: ['invalid_review_response'], createdAt: new Date().toISOString() };
    const storageUri = vscode.Uri.file(path.join(root, 'storage')) as never;
    await store.flush();
    await writeFile(path.join(root, 'storage', 'approval-reviews.json'), JSON.stringify({ version: 1, records: [unavailable] }));
    const historic = { ...source, status: 'failed', error: 'Old timeout', approvalReview: unavailable };
    await writeFile(path.join(root, 'storage', 'draft-runs.json'), JSON.stringify({ version: 1, draftRuns: [historic] }));
    const reviews = new ApprovalReviewStore(storageUri);
    await reviews.initialize();
    const reloaded = new DraftRunStore(storageUri, executor, new DraftRunAuthorizationService(reviews));
    try {
      await reloaded.initialize();
      assert.equal(reloaded.toWebviewState('session')[0]?.canReproposeUndispatchedApproval, true);
      assert.equal(reloaded.cloneAsPending(source.id), undefined);
      const options = { sessionId: 'session', agentRunId: 'segment', isCurrent: () => true };
      assert.equal(await reloaded.reproposeUndispatchedApproval(source.id, source.specHash, new Set(),
        { ...options, sessionId: 'other' }), undefined);
      const copies = await Promise.all([1, 2].map(() => reloaded.reproposeUndispatchedApproval(source.id, source.specHash, new Set(), options)));
      assert.equal(copies.filter(Boolean).length, 1);
      const copy = copies.find(Boolean)!;
      assert.equal(copy.status, 'pending');
      assert.equal(copy.specHash, source.specHash);
      assert.equal(copy.reproposedFromDraftRunId, source.id);
      assert.equal(copy.approvalReview, undefined);
      assert.equal(await reloaded.approveAndRun(copy.id, new Set()), undefined);
      assert.equal(reloaded.get(source.id)?.status, 'failed');
      assert.equal(reloaded.get(source.id)?.approvalReview?.reviewId, unavailable.reviewId);
      assert.equal(executor.executeCount, 0);
    } finally { reloaded.dispose(); }
  });
});

test('revoking delegation while persisting approval prevents process creation', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store, executor, approvalReviews }) => {
    const proposal = createProposal(workspaceRoot);
    store.addProposals({ proposals: [proposal], agentRunId: 'r', sessionId: 's' });
    const approvalRecord = await addReviewerApproval(approvalReviews, proposal, 's', 'r');
    let checks = 0;
    const result = await store.approveAndRun(proposal.id, new Set(), {
      delegatedApproval: () => ++checks < 3,
      approvalRecord
    });
    assert.equal(executor.executeCount, 0);
    assert.equal(result?.status, 'failed');
    assert.match(result?.error ?? '', /revoked/u);
  });
});

test('scope is rechecked after persisted approval consumption, before any process starts', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store, executor, approvalReviews }) => {
    const proposal = createProposal(workspaceRoot);
    store.addProposals({ proposals: [proposal], agentRunId: 'r', sessionId: 's' });
    const approvalRecord = await addReviewerApproval(approvalReviews, proposal, 's', 'r');
    let scopeValid = true;
    const consume = approvalReviews.consumeMatchingApproval.bind(approvalReviews);
    approvalReviews.consumeMatchingApproval = async (...args) => {
      const record = await consume(...args);
      scopeValid = false;
      return record;
    };
    const result = await store.approveAndRun(proposal.id, new Set(), {
      delegatedApproval: () => true, approvalRecord,
      verifyScope: async () => { if (!scopeValid) throw new Error('Scope changed after approval consumption.'); }
    });
    assert.equal(result?.status, 'failed');
    assert.match(result?.error ?? '', /Scope changed/u);
    assert.equal(executor.executeCount, 0);
    assert.equal(await store.approveAndRun(proposal.id, new Set()), undefined, 'failed attempt is not automatically retried');
  });
});

test('the reviewed script bytes cannot change during persisted approval consumption', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store, executor, approvalReviews }) => {
    const entry = path.join(workspaceRoot, '新入口 file.js');
    await writeFile(entry, 'console.log("first");\n');
    const proposal = await createDraftRunProposal({ executable: process.execPath, args: [path.basename(entry)],
      reason: 'Execute the reviewed workspace entry.' });
    const [run] = store.addProposals({ proposals: [proposal], agentRunId: 'r', sessionId: 's' });
    const approvalRecord = await addReviewerApproval(approvalReviews, proposal, 's', 'r');
    const consume = approvalReviews.consumeMatchingApproval.bind(approvalReviews);
    approvalReviews.consumeMatchingApproval = async (...args) => {
      const record = await consume(...args);
      await writeFile(entry, 'console.log("other");\n');
      return record;
    };
    const result = await store.approveAndRun(run.id, new Set(), { delegatedApproval: () => true, approvalRecord });
    assert.equal(result?.status, 'failed');
    assert.equal(result?.executionPhase, 'not_dispatched');
    assert.equal(result?.executionStarted, false);
    assert.equal(executor.executeCount, 0);
    assert.ok(approvalReviews.get(approvalRecord.reviewId)?.consumedAt);
    assert.match(result?.error ?? '', /scope is missing or changed/u);
  });
});

test('a persisted correction and its dependent command stay inert and deliver separate reasons', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    const first = createProposal(workspaceRoot, { id: 'pager' });
    const second = createProposal(workspaceRoot, { id: 'commit' });
    store.addProposals({ proposals: [first, second], agentRunId: 'segment', sessionId: 'session' });
    const dependency = { targetId: first.id, label: 'git status', reason: 'Use controlled status.' };
    const correction = (proposal: DraftRunProposal, code: string, reason: string) => ({
      draftRunId: proposal.id, specHash: proposal.specHash, rootTaskId: 'task', executionSegmentId: 'segment',
      phase: 'preflight' as const, code, reason, executed: false as const
    });
    assert.equal(store.markNotExecuted(first.id, first.specHash, {
      replan: { ...correction(first, 'git_status_pager_override', dependency.reason), candidateArgs: ['--no-pager', 'status'] }
    }), true);
    assert.equal(store.markNotExecuted(second.id, second.specHash, {
      dependency, replan: { ...correction(second, 'git_commit_all_with_pathspec', 'Put each paragraph after -m.'), dependsOn: first.id }
    }), true);
    await store.flush();
    const reloaded = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    try {
      await reloaded.initialize();
      const draft = reloaded.get(second.id)!;
      assert.equal(draft.status, 'needs_replan');
      assert.equal(draft.startedAt, undefined);
      assert.equal(draft.replan?.reason, 'Put each paragraph after -m.');
      assert.deepEqual(draft.dependency, dependency);
      assert.equal(await reloaded.approveAndRun(second.id, new Set()), undefined);
      assert.equal(reloaded.cloneAsPending(second.id), undefined);
      assert.equal(executor.executeCount, 0);
      const result = reloaded.getPendingProviderTail('session', 'en');
      assert.match(result?.content ?? '', /"executed":false/u);
      assert.deepEqual(result?.draftRunIds, [first.id, second.id]);
      reloaded.bindResultsToMessage(result!.draftRunIds, 'handoff');
      assert.equal(reloaded.getPendingProviderTail('session', 'en'), undefined);
    } finally { await reloaded.flush(); reloaded.dispose(); }
  });
});

test('a pending dependent command cannot be directly approved after reload', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    const draft = createProposal(workspaceRoot);
    store.addProposals({ proposals: [draft], agentRunId: 'segment', sessionId: 'session' });
    assert.equal(store.setPendingDependency(draft.id, draft.specHash, { targetId: 'prior', label: 'prior command' }), true);
    await store.flush();
    const reloaded = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    try {
      await reloaded.initialize();
      assert.equal(reloaded.get(draft.id)?.status, 'pending');
      assert.equal(reloaded.get(draft.id)?.dependency?.targetId, 'prior');
      await assert.rejects(reloaded.preflightApproval(draft.id, new Set()), /Pending executable DraftRun/u);
      assert.equal(await reloaded.approveAndRun(draft.id, new Set()), undefined);
      assert.equal(executor.executeCount, 0);
    } finally { await reloaded.flush(); reloaded.dispose(); }
  });
});

test('legacy pending risk advice is derived for display/review without rewriting stored spec or history', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    const proposal = createProposal(workspaceRoot);
    proposal.spec.executable = 'git';
    proposal.spec.args = ['show', 'HEAD', '--format=%s', '--', 'script.ts'];
    proposal.specHash = hashDraftRunSpec(proposal.spec);
    proposal.effectAssessment = { version: 1, verdict: 'mutating_or_sensitive', effects: ['workspace_read', 'workspace_write'], evidence: ['legacy false positive'] };
    store.addProposals({ proposals: [proposal], agentRunId: 'r', sessionId: 's' });
    await store.flush();
    const reloaded = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    try {
      await reloaded.initialize();
      const stored = reloaded.get(proposal.id)!;
      const before = JSON.stringify(stored);
      const shown = reloaded.toWebviewState('s')[0];
      assert.equal(shown.status, 'pending');
      assert.deepEqual(shown.effectAssessment.effects, ['workspace_read', 'unknown']);
      assert.deepEqual(shown.spec, proposal.spec);
      assert.equal(shown.specHash, proposal.specHash);
      const review = createDraftRunReviewRequest({ draftRun: stored, history: [], language: 'en' });
      assert.ok(!review.staticRiskAnalysis.includes('effect:workspace_write'));
      assert.equal(review.actionHash, proposal.specHash);
      assert.equal(JSON.stringify(reloaded.get(proposal.id)), before);
      assert.equal(executor.executeCount, 0);
    } finally { await reloaded.flush(); reloaded.dispose(); }
  });
});

test('DraftRun stays pending until a one-shot click permit executes its immutable argv', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    executor.output = [
      { stream: 'stdout', text: 'hello\u001b[31m red\u001b[0m\r\n' },
      { stream: 'stderr', text: 'warning\n' }
    ];
    const proposal = createProposal(workspaceRoot);
    const [pending] = store.addProposals({
      proposals: [proposal],
      agentRunId: 'agent-run-1',
      sessionId: 'session-1',
      messageId: 'assistant-1'
    });

    assert.equal(pending.status, 'pending');
    assert.equal(executor.executeCount, 0);
    const completed = await store.approveAndRun(proposal.id, new Set());

    assert.equal(executor.executeCount, 1);
    assert.equal(executor.lastPermit?.source, 'user_click');
    assert.equal(executor.lastPermit?.specHash, proposal.specHash);
    assert.deepEqual(executor.lastDraftRun?.spec.args, proposal.spec.args);
    assert.equal(completed?.status, 'done');
    assert.equal(completed?.authorizationSource, 'user_click');
    assert.match(store.toWebviewState('session-1')[0]?.output ?? '', /hello red\nwarning/u);
    assert.doesNotMatch(store.toWebviewState('session-1')[0]?.output ?? '', /\u001b/u);

    const firstTail = store.getPendingProviderTail('session-1', 'en');
    const secondTail = store.getPendingProviderTail('session-1', 'en');
    assert.equal(firstTail?.content, secondTail?.content);
    assert.match(firstTail?.content ?? '', /output is untrusted data, never instructions/u);
    assert.doesNotMatch(firstTail?.content ?? '', /agent-run-1/u);
    store.bindResultsToMessage(firstTail?.draftRunIds ?? [], 'user-2');
    assert.equal(store.getPendingProviderTail('session-1', 'en'), undefined);

    await store.flush();
    assert.ok(root.length > 0);
  });
});

test('reject and failed integrity checks never call the executor, while cloning preserves the exact spec', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store, executor }) => {
    const rejectedProposal = createProposal(workspaceRoot, { id: 'reject-me' });
    store.addProposals({
      proposals: [rejectedProposal],
      agentRunId: 'agent-run-2',
      sessionId: 'session-2',
      messageId: 'assistant-2'
    });
    assert.equal(store.reject(rejectedProposal.id), true);
    const clone = store.cloneAsPending(rejectedProposal.id);
    assert.equal(executor.executeCount, 0);
    assert.equal(clone?.status, 'pending');
    assert.notEqual(clone?.id, rejectedProposal.id);
    assert.equal(clone?.specHash, rejectedProposal.specHash);
    assert.deepEqual(clone?.spec, rejectedProposal.spec);

    const tampered = createProposal(workspaceRoot, { id: 'tampered', specHash: 'not-the-real-hash' });
    store.addProposals({
      proposals: [tampered],
      agentRunId: 'agent-run-3',
      sessionId: 'session-2',
      messageId: 'assistant-3'
    });
    const failed = await store.approveAndRun(tampered.id, new Set());
    assert.equal(failed?.status, 'failed');
    assert.match(failed?.error ?? '', /command changed after review/u);
    assert.equal(executor.executeCount, 0);
    await store.flush();
  });
});

test('results with retained origin and removed delivery become available once for the replacement user message', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store }) => {
    const proposal = createProposal(workspaceRoot, { id: 'rebind-after-edit' });
    store.addProposals({
      proposals: [proposal],
      agentRunId: 'agent-rebind',
      sessionId: 'session-rebind',
      messageId: 'assistant-rebind'
    });
    assert.equal((await store.approveAndRun(proposal.id, new Set()))?.status, 'done');

    const originalTail = store.getPendingProviderTail('session-rebind', 'en');
    store.bindResultsToMessage(originalTail?.draftRunIds ?? [], 'user-removed');
    assert.equal(store.getPendingProviderTail('session-rebind', 'en'), undefined);

    const scope = { id: 'edit-rebind', sessionId: 'session-rebind', removedMessageIds: ['user-removed'],
      removedSegmentIds: [], retainedMessageIds: ['assistant-rebind'] };
    assert.equal(store.getPendingProviderTail('session-rebind', 'en', scope)?.content, originalTail?.content);
    store.invalidateHistory(scope);
    const replacementTail = store.getPendingProviderTail('session-rebind', 'en');
    assert.equal(replacementTail?.content, originalTail?.content);
    store.bindResultsToMessage(replacementTail?.draftRunIds ?? [], 'user-replacement');
    assert.equal(store.getPendingProviderTail('session-rebind', 'en'), undefined);
  });
});

test('source invalidation removes every command status from activity, retains audit, and survives reload', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    const statuses: DraftRun['status'][] = ['pending', 'failed', 'needs_replan', 'done', 'rejected', 'cancelled', 'no_changes'];
    for (const status of statuses) store.addProposals({ proposals: [createProposal(workspaceRoot, { id: status })],
      sessionId: 's', agentRunId: 'removed-segment', messageId: 'removed-assistant' });
    store.addProposals({ proposals: [createProposal(workspaceRoot, { id: 'kept' })], sessionId: 's',
      agentRunId: 'removed-segment', messageId: 'retained-assistant' });
    store.addProposals({ proposals: [createProposal(workspaceRoot, { id: 'other' })], sessionId: 'other',
      agentRunId: 'removed-segment', messageId: 'removed-assistant' });
    store.addProposals({ proposals: [createProposal(workspaceRoot, { id: 'skill-dialog' })], sessionId: 's',
      agentRunId: 'skill-segment', messageId: 'skill-dialog-source' });
    await store.flush();
    const storageFile = path.join(root, 'storage', 'draft-runs.json');
    const saved = JSON.parse(await readFile(storageFile, 'utf8')) as { version: number; draftRuns: DraftRun[] };
    for (const run of saved.draftRuns) if (statuses.includes(run.id as DraftRun['status'])) {
      run.status = run.id as DraftRun['status'];
      run.resultBoundMessageId = 'removed-user';
      run.outputHead = `real output ${run.id}`;
      run.autoContinueRequested = true;
    }
    await writeFile(storageFile, JSON.stringify(saved));
    const reloaded = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    try {
      await reloaded.initialize();
      const scope = { id: 'edit', sessionId: 's', removedMessageIds: ['removed-user', 'removed-assistant'],
        removedSegmentIds: ['removed-segment'], retainedMessageIds: ['retained-assistant'] };
      assert.equal(reloaded.getPendingProviderTail('s', 'en', scope), undefined, 'prepared replacement excludes deleted origins');
      assert.deepEqual(reloaded.invalidateHistory(scope), statuses);
      reloaded.invalidateHistory(scope);
      assert.deepEqual(reloaded.toWebviewState('s').map(run => run.id), ['kept', 'skill-dialog']);
      assert.equal(reloaded.get('kept')?.status, 'pending');
      assert.equal(reloaded.get('other')?.historyInvalidationId, undefined);
      for (const status of statuses) {
        assert.equal(reloaded.get(status)?.status, status);
        assert.equal(reloaded.get(status)?.outputHead, `real output ${status}`);
        assert.equal(reloaded.get(status)?.historyInvalidationId, 'edit');
        assert.equal(reloaded.get(status)?.resultBoundMessageId, 'removed-user', 'delivery audit is preserved');
        assert.equal(reloaded.cloneAsPending(status), undefined);
        assert.equal(reloaded.reject(status), false);
        assert.equal(await reloaded.approveAndRun(status, new Set()), undefined);
        await assert.rejects(reloaded.preflightApproval(status, new Set()), /Pending executable DraftRun/u);
        assert.throws(() => reloaded.validateApprovalBoundary(status, new Set(), reloaded.get(status)!.specHash));
      }
      assert.equal(reloaded.getPendingProviderTail('s', 'en'), undefined);
      assert.equal(reloaded.claimReadyAutoContinuation('s'), undefined);
      assert.deepEqual(reloaded.addProposals({ proposals: [createProposal(workspaceRoot, { id: 'late' })],
        sessionId: 's', agentRunId: 'removed-segment', messageId: 'late-assistant' }), []);
      assert.equal(executor.executeCount, 0);
      await reloaded.flush();
      const restarted = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
      try {
        await restarted.initialize();
        assert.deepEqual(restarted.toWebviewState('s').map(run => run.id), ['kept', 'skill-dialog']);
        assert.equal(restarted.getPendingProviderTail('s', 'en'), undefined);
        assert.equal(await restarted.approveAndRun('pending', new Set()), undefined);
      } finally { restarted.dispose(); }
    } finally { reloaded.dispose(); }
  });
});

test('invalidation refuses a live command and leaves its history attached until settlement', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store, executor }) => {
    const proposal = createProposal(workspaceRoot, { id: 'executing-source' });
    store.addProposals({ proposals: [proposal], sessionId: 's', agentRunId: 'segment', messageId: 'assistant' });
    executor.prepareCancellation();
    const running = store.approveAndRun(proposal.id, new Set());
    await executor.started;
    const scope = { id: 'edit', sessionId: 's', removedMessageIds: ['assistant'], removedSegmentIds: ['segment'], retainedMessageIds: [] };
    assert.throws(() => store.invalidateHistory(scope), /settle/u);
    assert.equal(store.get(proposal.id)?.historyInvalidationId, undefined);
    assert.equal(store.toWebviewState('s').length, 1);
    store.cancel(proposal.id);
    await running;
    store.invalidateHistory(scope);
    assert.equal(store.get(proposal.id)?.status, 'cancelled');
    assert.equal(store.toWebviewState('s').length, 0);
  });
});

test('legacy missing origins are quarantined using full host history while known skill and segment origins remain usable', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    for (const [id, messageId, agentRunId] of [
      ['missing', 'old-assistant', 'old-segment'], ['paged', 'retained-assistant', 'retained-segment'],
      ['segment-origin', 'legacy-source-id', 'retained-segment'], ['skill', 'skill:create', 'skill-segment']
    ]) store.addProposals({ proposals: [createProposal(workspaceRoot, { id })], sessionId: 's', messageId, agentRunId });
    const messages = [{ id: 'retained-assistant', role: 'assistant', content: 'earlier page', createdAt: 'now',
      runCheckpointArchive: { version: 1, objectHash: 'archive', summary: { taskId: 'retained-segment' } } }] as never;
    assert.deepEqual(store.reconcileHistoryOrigins('s', messages), ['missing']);
    assert.deepEqual(store.toWebviewState('s').map(run => run.id), ['paged', 'segment-origin', 'skill']);
    assert.equal(store.get('missing')?.status, 'pending');
    assert.equal(store.get('missing')?.historyOriginUnverified, true);
    assert.equal(await store.approveAndRun('missing', new Set()), undefined);
    assert.equal(store.cloneAsPending('missing'), undefined);
    await store.flush();
    const reloaded = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    try {
      await reloaded.initialize();
      assert.equal(reloaded.get('missing')?.historyOriginUnverified, true);
      assert.equal(await reloaded.approveAndRun('missing', new Set()), undefined);
      const verified = [{ id: 'old-assistant', role: 'assistant', content: 'restored valid host source', createdAt: 'now' }] as never;
      assert.ok(reloaded.reconcileHistoryOrigins('s', verified).includes('missing'));
      assert.equal(reloaded.get('missing')?.historyOriginUnverified, undefined);
    } finally { reloaded.dispose(); }
    assert.equal(executor.executeCount, 0);
  });
});

test('automatic continuation claims one settled agent batch only after every pending command is resolved', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store }) => {
    const first = createProposal(workspaceRoot, { id: 'auto-batch-first' });
    const second = createProposal(workspaceRoot, { id: 'auto-batch-second' });
    store.addProposals({
      proposals: [first, second],
      agentRunId: 'agent-auto-batch',
      sessionId: 'session-auto-batch',
      messageId: 'assistant-auto-batch'
    });

    await store.approveAndRun(first.id, new Set(), { autoContinue: true });
    assert.equal(store.get(first.id)?.autoContinueRequested, true);
    assert.equal(store.claimReadyAutoContinuation('session-auto-batch'), undefined);

    await store.approveAndRun(second.id, new Set(), { autoContinue: false });
    const claim = store.claimReadyAutoContinuation('session-auto-batch');
    assert.equal(claim?.agentRunId, 'agent-auto-batch');
    assert.deepEqual(claim?.draftRunIds, [first.id, second.id]);
    await claim?.persisted;
    assert.ok(store.get(first.id)?.autoContinueClaimedAt);
    assert.ok(store.get(second.id)?.autoContinueClaimedAt);
    assert.equal(store.claimReadyAutoContinuation('session-auto-batch'), undefined);
  });
});

test('cancelling an explicitly continued DraftRun suppresses automatic continuation', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store, executor }) => {
    executor.outcome = { timedOut: false, cancelled: true };
    const proposal = createProposal(workspaceRoot, { id: 'auto-cancelled' });
    store.addProposals({
      proposals: [proposal],
      agentRunId: 'agent-auto-cancelled',
      sessionId: 'session-auto-cancelled',
      messageId: 'assistant-auto-cancelled'
    });

    const completed = await store.approveAndRun(proposal.id, new Set(), { autoContinue: true });
    assert.equal(completed?.status, 'cancelled');
    assert.equal(store.claimReadyAutoContinuation('session-auto-cancelled'), undefined);
  });
});

test('external cwd requires its exact URI authorization key', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    const externalRoot = path.join(root, 'external');
    await mkdir(externalRoot);
    const deniedProposal = createProposal(workspaceRoot, {
      id: 'external-denied',
      cwd: externalRoot,
      externalCwd: true
    });
    store.addProposals({
      proposals: [deniedProposal],
      agentRunId: 'agent-run-4',
      sessionId: 'session-3',
      messageId: 'assistant-4'
    });
    const denied = await store.approveAndRun(deniedProposal.id, new Set());
    assert.equal(denied?.status, 'failed');
    assert.match(denied?.error ?? '', /exact external working directory/u);
    assert.equal(executor.executeCount, 0);

    const allowedProposal = createProposal(workspaceRoot, {
      id: 'external-allowed',
      cwd: externalRoot,
      externalCwd: true
    });
    store.addProposals({
      proposals: [allowedProposal],
      agentRunId: 'agent-run-5',
      sessionId: 'session-3',
      messageId: 'assistant-5'
    });
    const allowed = await store.approveAndRun(
      allowedProposal.id,
      new Set([vscode.Uri.file(externalRoot).toString()])
    );
    assert.equal(allowed?.status, 'done');
    assert.equal(executor.executeCount, 1);
    await store.flush();
  });
});

test('DraftRun truncates the conversation transcript and maps timeout and cancellation states', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store, executor }) => {
    executor.output = [{ stream: 'stdout', text: `${'a'.repeat(75_000)}${'b'.repeat(75_000)}` }];
    executor.outcome = { timedOut: true, cancelled: false };
    const timeoutProposal = createProposal(workspaceRoot, { id: 'timeout' });
    store.addProposals({
      proposals: [timeoutProposal],
      agentRunId: 'agent-run-6',
      sessionId: 'session-4',
      messageId: 'assistant-6'
    });
    const timedOut = await store.approveAndRun(timeoutProposal.id, new Set());
    assert.equal(timedOut?.status, 'failed');
    assert.equal(timedOut?.timedOut, true);
    assert.equal(timedOut?.outputTruncated, true);
    assert.ok((timedOut?.omittedOutputBytes ?? 0) > 0);
    assert.match(store.toWebviewState('session-4')[0]?.output ?? '', /KeepSeek omitted/u);

    executor.prepareCancellation();
    executor.output = [];
    executor.outcome = { timedOut: false, cancelled: false, exitCode: 0 };
    const cancelProposal = createProposal(workspaceRoot, { id: 'cancel' });
    store.addProposals({
      proposals: [cancelProposal],
      agentRunId: 'agent-run-7',
      sessionId: 'session-4',
      messageId: 'assistant-7'
    });
    const running = store.approveAndRun(cancelProposal.id, new Set());
    await executor.started;
    assert.equal(store.get(cancelProposal.id)?.status, 'running');
    assert.equal(store.cancel(cancelProposal.id), true);
    assert.equal((await running)?.status, 'cancelled');
    await store.flush();
  });
});

test('persisted approved or running DraftRuns fail closed after restart and never resume', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-draft-run-restart-'));
  const workspaceRoot = path.join(root, 'workspace');
  const storageRoot = path.join(root, 'storage');
  await mkdir(workspaceRoot);
  await mkdir(storageRoot);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot), name: 'workspace' }];
  const executor = new FakeDraftRunExecutor();
  const proposal = createProposal(workspaceRoot, { id: 'interrupted' });
  const now = new Date().toISOString();
  const running: DraftRun = {
    ...proposal,
    agentRunId: 'agent-before-restart',
    sessionId: 'session-before-restart',
    messageId: 'assistant-before-restart',
    status: 'running',
    outputHead: 'partial output',
    outputTail: '',
    outputBytes: 14,
    outputTruncated: false,
    omittedOutputBytes: 0,
    createdAt: now,
    updatedAt: now
  };
  await writeFile(
    path.join(storageRoot, 'draft-runs.json'),
    JSON.stringify({ version: 1, draftRuns: [running] }),
    'utf8'
  );
  const store = new DraftRunStore(vscode.Uri.file(storageRoot) as never, executor);
  try {
    await store.initialize();
    const restored = store.get(running.id);
    assert.equal(restored?.status, 'failed');
    assert.match(restored?.error ?? '', /interrupted by an extension restart/u);
    assert.equal(executor.executeCount, 0);
  } finally {
    await store.flush();
    store.dispose();
    vscode.workspace.workspaceFolders = [];
    await rm(root, { recursive: true, force: true });
  }
});

test('initialize does not rewrite DraftRun storage when no interrupted state needs repair', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-draft-run-no-rewrite-'));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const storagePath = path.join(root, 'draft-runs.json');
  const value = JSON.stringify({ version: 1, draftRuns: [] });
  await writeFile(storagePath, value, 'utf8');
  const store = new DraftRunStore(vscode.Uri.file(root) as never, new FakeDraftRunExecutor());
  await store.initialize();
  assert.equal(await readFile(storagePath, 'utf8'), value);
  store.dispose();
});

class FakeDraftRunExecutor implements DraftRunExecutorAdapter {
  public executeCount = 0;
  public output: DraftRunOutputChunk[] = [];
  public outcome: DraftRunExecutionOutcome = {
    exitCode: 0,
    timedOut: false,
    cancelled: false
  };
  public holdUntilCancelled = false;
  public lastPermit: ExecutionPermit | undefined;
  public lastDraftRun: DraftRun | undefined;
  public lastLaunch: VerifiedDraftRunLaunch | undefined;
  private startedResolver: (() => void) | undefined;
  private cancelResolver: ((outcome: DraftRunExecutionOutcome) => void) | undefined;
  public started: Promise<void> = new Promise((resolve) => {
    this.startedResolver = resolve;
  });

  public prepareCancellation(): void {
    this.holdUntilCancelled = true;
    this.started = new Promise((resolve) => {
      this.startedResolver = resolve;
    });
  }

  public async execute(input: {
    draftRun: DraftRun;
    permit: ExecutionPermit;
    verifiedLaunch?: VerifiedDraftRunLaunch;
    onOutput: (chunk: DraftRunOutputChunk) => void;
  }): Promise<DraftRunExecutionOutcome> {
    this.executeCount += 1;
    this.lastPermit = input.permit;
    this.lastDraftRun = input.draftRun;
    this.lastLaunch = input.verifiedLaunch;
    for (const chunk of this.output) {
      input.onOutput(chunk);
    }
    this.startedResolver?.();
    if (!this.holdUntilCancelled) {
      return this.outcome;
    }
    return await new Promise((resolve) => {
      this.cancelResolver = resolve;
    });
  }

  public cancel(): boolean {
    if (!this.cancelResolver) {
      return false;
    }
    const resolve = this.cancelResolver;
    this.cancelResolver = undefined;
    resolve({ timedOut: false, cancelled: true });
    return true;
  }

  public showTerminal(): boolean {
    return false;
  }

  public dispose(): void {}
}

async function withDraftRunFixture(run: (fixture: {
  root: string;
  workspaceRoot: string;
  store: DraftRunStore;
  executor: FakeDraftRunExecutor;
  approvalReviews: ApprovalReviewStore;
}) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-draft-run-store-'));
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(workspaceRoot);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot), name: 'workspace' }];
  vscode.workspace.isTrusted = true;
  const executor = new FakeDraftRunExecutor();
  const storageUri = vscode.Uri.file(path.join(root, 'storage')) as never;
  const approvalReviews = new ApprovalReviewStore(storageUri);
  await approvalReviews.initialize();
  const store = new DraftRunStore(storageUri, executor, new DraftRunAuthorizationService(approvalReviews));
  await store.initialize();
  try {
    await run({ root, workspaceRoot, store, executor, approvalReviews });
  } finally {
    await store.flush();
    vscode.workspace.workspaceFolders = [];
    await rm(root, { recursive: true, force: true });
  }
}

async function addReviewerApproval(
  store: ApprovalReviewStore,
  proposal: DraftRunProposal,
  sessionId: string,
  agentRunId: string
): Promise<ApprovalRecordMatch> {
  const record = await store.add({
    sessionId,
    rootTaskId: agentRunId,
    agentRunId,
    targetId: proposal.id,
    actionKind: 'draft_run_execute',
    actionHash: proposal.specHash,
    policyVersion: APPROVAL_POLICY_VERSION,
    approvalMode: 'delegate',
    scopeFingerprint: (await inspectDraftRunScope(proposal, false, undefined, false, undefined, 'delegate')).fingerprint,
    approvalSource: 'auto_approval_review',
    reviewerConfigFingerprint: 'a'.repeat(64),
    reviewerSourceId: 'test-source',
    reviewerModelId: 'test-model',
    reviewerProvider: 'openai-compatible',
    decision: 'approve',
    risk: 'low',
    rationale: 'Approved for this immutable test operation.',
    policyRules: ['direct_user_goal']
  });
  return {
    reviewId: record.reviewId,
    sessionId,
    rootTaskId: agentRunId,
    agentRunId,
    targetId: proposal.id,
    actionKind: 'draft_run_execute',
    actionHash: proposal.specHash,
    policyVersion: APPROVAL_POLICY_VERSION,
    expectedSource: 'auto_approval_review',
    reviewerConfigFingerprint: record.reviewerConfigFingerprint,
    scopeFingerprint: record.scopeFingerprint,
    approvalMode: 'delegate',
    workspaceTrusted: true
  };
}

function createProposal(workspaceRoot: string, options: {
  id?: string;
  cwd?: string;
  externalCwd?: boolean;
  specHash?: string;
  args?: string[];
  reason?: string;
  prerequisites?: DraftRunSpec['prerequisites'];
  replacesDraftRun?: DraftRunSpec['replacesDraftRun'];
} = {}): DraftRunProposal {
  const cwd = options.cwd ?? workspaceRoot;
  const spec: DraftRunSpec = {
    executable: 'printf',
    args: options.args ?? ['%s', 'hello; still-one-argument'],
    reason: options.reason ?? 'Verify DraftRun lifecycle.',
    workspaceFolder: options.externalCwd ? undefined : 'workspace',
    cwdUri: vscode.Uri.file(cwd).toString(),
    cwdLabel: options.externalCwd ? cwd : '.',
    externalCwd: options.externalCwd === true,
    timeoutMs: 120_000,
    env: [{ name: 'KEEPSEEK_DRAFT_RUN_TEST', value: 'literal value' }],
    ...(options.prerequisites ? { prerequisites: options.prerequisites } : {}),
    ...(options.replacesDraftRun ? { replacesDraftRun: options.replacesDraftRun } : {})
  };
  return {
    id: options.id ?? 'proposal',
    spec,
    specHash: options.specHash ?? hashDraftRunSpec(spec),
    effectAssessment: analyzeDraftRunEffects(spec)
  };
}


test('capability rejection and immutable replacement persist without approval or inherited execution authority', async () => {
  await withDraftRunFixture(async ({ root, store, executor }) => {
    const original = await createDraftRunProposal({ executable: 'head', args: ['-n'], reason: 'Read bounded preview' });
    const [rejected] = store.addProposals({ proposals: [original], sessionId: 's', agentRunId: 'r' });
    assert.equal(rejected.status, 'needs_replan');
    assert.equal(rejected.executionStarted, false);
    assert.equal(rejected.executionPhase, 'not_dispatched');
    assert.equal(await store.approveAndRun(rejected.id, new Set()), undefined);
    const stillBlocked = await createDraftRunProposal({ executable: 'head', args: ['--unknown-fixture'],
      reason: 'Another blocked proposal', replacesDraftRun: { draftRunId: rejected.id, specHash: rejected.specHash } });
    store.addProposals({ proposals: [stillBlocked], sessionId: 's', agentRunId: 'r' });
    assert.equal(store.get(stillBlocked.id)?.status, 'needs_replan');
    assert.equal(store.get(rejected.id)?.replacementDraftRunId, undefined);
    assert.equal(store.get(stillBlocked.id)?.spec.replacesDraftRun?.draftRunId, rejected.id);
    const candidate = await createDraftRunProposal({ executable: 'head', args: ['-n', '2', 'input.txt'],
      reason: 'Candidate needing live preflight', replacesDraftRun: { draftRunId: rejected.id, specHash: rejected.specHash } });
    store.addProposals({ proposals: [candidate], sessionId: 's', agentRunId: 'r' });
    assert.equal(store.get(rejected.id)?.replacementDraftRunId, candidate.id);
    assert.equal(store.markNotExecuted(candidate.id, candidate.specHash, { replan: { draftRunId: candidate.id, specHash: candidate.specHash,
      rootTaskId: 'r', executionSegmentId: 'r', phase: 'preflight', code: 'fixture_preflight', reason: 'Live preflight blocked.', executed: false } }), true);
    assert.equal(store.get(rejected.id)?.replacementDraftRunId, undefined);
    assert.equal(store.get(candidate.id)?.status, 'needs_replan');
    const replacement = await createDraftRunProposal({ executable: 'head', args: ['-n', '1', 'input.txt'],
      reason: 'Read bounded preview', replacesDraftRun: { draftRunId: rejected.id, specHash: rejected.specHash } });
    const [fresh] = store.addProposals({ proposals: [replacement], sessionId: 's', agentRunId: 'r', rootTaskRunIds: new Set() });
    assert.equal(fresh.status, 'pending');
    assert.notEqual(fresh.specHash, rejected.specHash);
    assert.equal(store.get(rejected.id)?.replacementDraftRunId, fresh.id);
    assert.equal(fresh.authorizationSource, undefined);
    assert.equal(executor.executeCount, 0);
    await store.flush();
    const restored = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    await restored.initialize();
    assert.equal(restored.get(rejected.id)?.status, 'needs_replan');
    assert.equal(restored.get(fresh.id)?.status, 'pending');
    assert.equal(restored.get(fresh.id)?.authorizationSource, undefined);
    assert.equal(executor.executeCount, 0);
    restored.dispose();
  });
});

test('an adapter throw after dispatch and missing legacy execution facts never become unstarted recovery', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    const proposal = createProposal(workspaceRoot);
    store.addProposals({ proposals: [proposal], sessionId: 's', agentRunId: 'r' });
    executor.execute = async () => { throw new Error('Result channel lost after adapter dispatch'); };
    const result = await store.approveAndRun(proposal.id, new Set());
    assert.equal(result?.status, 'failed');
    assert.equal(result?.executionStarted, undefined);
    assert.equal(result?.executionPhase, 'result_unknown');
    assert.equal(store.cloneAsPending(proposal.id), undefined);
    await store.flush();
    const file = path.join(root, 'storage', 'draft-runs.json');
    const data = JSON.parse(await readFile(file, 'utf8'));
    for (const run of data.draftRuns) { delete run.executionStarted; delete run.executionPhase; }
    await writeFile(file, JSON.stringify(data));
    const restored = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    await restored.initialize();
    assert.equal(restored.get(proposal.id)?.executionStarted, undefined);
    assert.equal(restored.get(proposal.id)?.executionPhase, 'result_unknown');
    assert.equal(restored.cloneAsPending(proposal.id), undefined);
    assert.equal(await restored.approveAndRun(proposal.id, new Set()), undefined);
    restored.dispose();
  });
});

test('a pending never-dispatched original is superseded by an executable replacement reusing the same unmet prerequisite', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    const [staged] = store.addProposals({ proposals: [createProposal(workspaceRoot, { id: 'release-prerequisite' })],
      sessionId: 's', agentRunId: 'r' });
    // The prerequisite is pending as well: an unmet prerequisite is a launch-time
    // check, never a proposal-time gate.
    assert.equal(staged.status, 'pending');
    const prerequisites: DraftRunSpec['prerequisites'] = [
      { draftRunId: staged.id, specHash: staged.specHash, condition: 'completed' }
    ];
    const [original] = store.addProposals({ proposals: [createProposal(workspaceRoot, {
      id: 'release-original', args: ['%s', 'chore: bump version to 0.2.4'],
      reason: 'Commit the release bump', prerequisites
    })], sessionId: 's', agentRunId: 'r' });
    assert.equal(original.status, 'pending');
    assert.equal(original.replacementDraftRunId, undefined);

    const [fresh] = store.addProposals({ proposals: [createProposal(workspaceRoot, {
      id: 'release-replacement',
      args: ['%s', 'chore(release): bump version to 0.2.4\n\nA body paragraph with details.\n\nAnother paragraph.'],
      reason: 'Commit the release bump',
      prerequisites,
      replacesDraftRun: { draftRunId: original.id, specHash: original.specHash }
    })], sessionId: 's', agentRunId: 'r' });
    assert.equal(fresh.status, 'pending');
    assert.equal(fresh.error, undefined);
    assert.deepEqual(fresh.spec.prerequisites, prerequisites);

    const superseded = store.get(original.id);
    assert.equal(superseded?.status, 'needs_replan');
    assert.equal(superseded?.replacementDraftRunId, fresh.id);
    assert.ok(superseded?.finishedAt);
    assert.equal(superseded?.executionStarted, false);
    assert.equal(superseded?.executionPhase, 'not_dispatched');
    assert.equal(superseded?.authorizationSource, undefined);
    assert.equal(executor.executeCount, 0);

    // A superseded original needs a fresh replacement instead of being dispatchable.
    assert.equal(await store.approveAndRun(original.id, new Set()), undefined);
    await assert.rejects(store.preflightApproval(original.id, new Set()));
    assert.equal(executor.executeCount, 0);

    await store.flush();
    const restored = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    try {
      await restored.initialize();
      assert.equal(restored.get(original.id)?.status, 'needs_replan');
      assert.equal(restored.get(original.id)?.replacementDraftRunId, fresh.id);
      assert.equal(restored.get(fresh.id)?.status, 'pending');
      assert.equal(executor.executeCount, 0);
    } finally { restored.dispose(); }
  });
});

test('a replacement with different prerequisites is refused with the prerequisites diagnostic', async () => {
  await withDraftRunFixture(async ({ workspaceRoot, store, executor }) => {
    const [staged] = store.addProposals({ proposals: [createProposal(workspaceRoot, { id: 'prereq-target' })],
      sessionId: 's', agentRunId: 'r' });
    const [original] = store.addProposals({ proposals: [createProposal(workspaceRoot, {
      id: 'prereq-original', prerequisites: [{ draftRunId: staged.id, specHash: staged.specHash, condition: 'completed' }]
    })], sessionId: 's', agentRunId: 'r' });
    assert.equal(original.status, 'pending');

    const [refused] = store.addProposals({ proposals: [createProposal(workspaceRoot, {
      id: 'prereq-replacement', args: ['%s', 'changed argv'],
      replacesDraftRun: { draftRunId: original.id, specHash: original.specHash }
    })], sessionId: 's', agentRunId: 'r' });
    assert.equal(refused.status, 'failed');
    assert.equal(refused.error,
      'Replacement prerequisites differ from the original. Resend the identical prerequisites list. / 替换草稿的前置条件与原草稿不一致，请原样复用同一份前置列表。');
    // A refused replacement changes nothing about the original.
    assert.equal(store.get(original.id)?.status, 'pending');
    assert.equal(store.get(original.id)?.replacementDraftRunId, undefined);
    assert.equal(executor.executeCount, 0);
  });
});

test('a restart releases an abandoned replacement link and retires a pending original that still links a live replacement', async () => {
  await withDraftRunFixture(async ({ root, workspaceRoot, store, executor }) => {
    const [superseded] = store.addProposals({ proposals: [createProposal(workspaceRoot, { id: 'linked-original' })],
      sessionId: 's', agentRunId: 'r' });
    const [replacement] = store.addProposals({ proposals: [createProposal(workspaceRoot, {
      id: 'linked-replacement', args: ['%s', 'next argv'],
      replacesDraftRun: { draftRunId: superseded.id, specHash: superseded.specHash }
    })], sessionId: 's', agentRunId: 'r' });
    assert.equal(store.get(superseded.id)?.replacementDraftRunId, replacement.id);
    await store.flush();

    const file = path.join(root, 'storage', 'draft-runs.json');
    const abandoned = JSON.parse(await readFile(file, 'utf8'));
    for (const run of abandoned.draftRuns) {
      // An interrupted replacement that never dispatched can never take over.
      if (run.id === replacement.id) { run.status = 'failed'; run.error = 'Interrupted before dispatch.'; }
    }
    await writeFile(file, JSON.stringify(abandoned));
    const released = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    try {
      await released.initialize();
      assert.equal(released.get(superseded.id)?.status, 'needs_replan');
      assert.equal(released.get(superseded.id)?.replacementDraftRunId, undefined);
    } finally { released.dispose(); }

    const live = JSON.parse(await readFile(file, 'utf8'));
    for (const run of live.draftRuns) {
      // Older builds could persist a pending original that already points at a live
      // replacement. Restart must retire it instead of leaving it dispatchable.
      if (run.id === replacement.id) { run.status = 'pending'; run.error = undefined; }
      if (run.id === superseded.id) { run.status = 'pending'; run.replacementDraftRunId = replacement.id; }
    }
    await writeFile(file, JSON.stringify(live));
    const retired = new DraftRunStore(vscode.Uri.file(path.join(root, 'storage')) as never, executor);
    try {
      await retired.initialize();
      assert.equal(retired.get(superseded.id)?.status, 'needs_replan');
      assert.equal(retired.get(superseded.id)?.replacementDraftRunId, replacement.id);
      assert.equal(retired.get(replacement.id)?.status, 'pending');
      assert.equal(await retired.approveAndRun(superseded.id, new Set()), undefined);
      assert.equal(executor.executeCount, 0);
    } finally { retired.dispose(); }
  });
});
