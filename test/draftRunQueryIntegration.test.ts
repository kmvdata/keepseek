import './registerVscodeStub';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { ApprovalReviewerService } from '../src/approvals/approvalReviewer';
import { ApprovalReviewStore } from '../src/approvals/approvalReviewStore';
import { createDraftRunReviewRequest } from '../src/approvals/approvalReviewSurface';
import { ExactOperationGrants, inspectAutomaticRunAuthorization, assertAutomaticRunAuthorization } from '../src/approvals/authorization';
import { DraftRunAuthorizationService } from '../src/runs/draftRunAuthorization';
import { SpawnDraftRunExecutor } from '../src/runs/draftRunExecutor';
import { createDraftRunProposal } from '../src/runs/draftRunProposal';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { normalizeGitQueryResult } from '../src/runs/gitQueryResult';
import { inspectDraftRunDependencyFacts } from '../src/runs/draftRunDependencies';

test('delegate executes original five literal Git queries through real host approval and spawn exactly once', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-local-query-')));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const saved = { workspaceFolders: vscode.workspace.workspaceFolders, isTrusted: vscode.workspace.isTrusted };
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspace), name: 'query-fixture' }];
  vscode.workspace.isTrusted = true;
  const git = (...args: string[]) => execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'KeepSeek Query Test');
  git('config', 'user.email', 'query@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '.git/hooks');
  git('commit', '--allow-empty', '-m', 'base');
  git('tag', '0.5.0');
  git('commit', '--allow-empty', '-m', 'after tag');
  git('commit', '--allow-empty', '-m', 'after tag again');
  const storage = vscode.Uri.file(path.join(root, 'storage')) as never;
  const reviews = new ApprovalReviewStore(storage);
  let reviewerCalls = 0;
  const reviewer = new ApprovalReviewerService({ globalStorageUri: storage, workspaceKey: 'query-fixture',
    sourceStore: new ModelSourceStore(storage), store: reviews,
    requestText: async () => { reviewerCalls++; assert.fail('finite verified local queries use host policy'); } });
  const executor = new SpawnDraftRunExecutor();
  const launches: string[][] = [];
  const runs = new DraftRunStore(storage, {
    execute: async input => { launches.push([...input.draftRun.spec.args]); return await executor.execute(input); },
    cancel: id => executor.cancel(id), showTerminal: id => executor.showTerminal(id), dispose: () => executor.dispose()
  }, new DraftRunAuthorizationService(reviews));
  t.after(async () => {
    await runs.flush(); runs.dispose();
    Object.assign(vscode.workspace, saved);
    await rm(root, { recursive: true, force: true });
  });
  const execute = async (args: string[]) => {
    const proposal = await createDraftRunProposal({ executable: 'git', args, reason: 'Verify local history facts', timeoutMs: 120000 });
    const [run] = runs.addProposals({ proposals: [proposal], sessionId: 'queries', agentRunId: 'same-root-segment', messageId: 'queries-assistant' });
    const grants = new ExactOperationGrants();
    const decision = await inspectAutomaticRunAuthorization(run, grants, 'delegate');
    assert.equal(decision.allowed, true, decision.refusal?.reason);
    assert.equal(decision.route, 'host_policy', JSON.stringify(decision.scope.diagnostics));
    const { record } = await reviewer.createHostPolicyApproval({
      ...createDraftRunReviewRequest({ draftRun: run, scope: decision.scope, rootTaskId: 'same-root', history: [], language: 'en' }),
      approvalMode: 'delegate', scopeFingerprint: decision.scope.fingerprint
    });
    assert.equal(record.decision, 'approve', record.rationale);
    const result = await runs.approveAndRun(run.id, decision.authorizedUris, {
      delegatedApproval: () => true,
      verifyScope: () => assertAutomaticRunAuthorization(run, grants, decision.scope.fingerprint, 'delegate'),
      approvalRecord: { ...record, expectedSource: 'host_policy', workspaceTrusted: true }
    });
    assert.ok(result);
    assert.equal(result.executionStarted, true);
    assert.equal(result.executionPhase, 'exited');
    assert.equal(await runs.approveAndRun(run.id, decision.authorizedUris), undefined, 'completed runs do not relaunch');
    return result;
  };
  const original = [
    ['log', '--oneline', '--no-decorate', '0.5.0..HEAD'],
    ['tag', '--list', '0.5.0'],
    ['merge-base', '--is-ancestor', '0.5.0', 'HEAD'],
    ['rev-parse', 'HEAD^{tree}', 'HEAD', '0.5.0^{commit}'],
    ['rev-list', '--count', '0.5.0..HEAD']
  ];
  const results = [];
  for (const argv of original) results.push(await execute(argv));
  assert.deepEqual(launches, original);
  assert.ok(results.every(result => result.status === 'done'), JSON.stringify(results.map(result => ({ status: result.status, error: result.error }))));
  assert.match(results[0].outputHead, /after tag again/u);
  assert.equal(results[1].gitQueryResult?.predicate, true);
  assert.equal(results[2].gitQueryResult?.predicate, true);
  assert.deepEqual(results[3].gitQueryResult?.values, git('rev-parse', 'HEAD^{tree}', 'HEAD', '0.5.0^{commit}').trim().split('\n'));
  assert.equal(results[4].gitQueryResult?.count, 2);
  const equivalent = await execute(['log', '--oneline', '--decorate=no', '0.5.0..HEAD']);
  assert.equal(equivalent.outputHead, results[0].outputHead);
  const missingTag = await execute(['tag', '--list', 'does-not-exist']);
  assert.equal(missingTag.status, 'done');
  assert.equal(missingTag.exitCode, 0);
  assert.equal(missingTag.gitQueryResult?.predicate, false);
  const nonAncestor = await execute(['merge-base', '--is-ancestor', 'HEAD', '0.5.0']);
  assert.equal(nonAncestor.status, 'done', nonAncestor.error);
  assert.equal(nonAncestor.exitCode, 1);
  assert.equal(nonAncestor.gitQueryResult?.predicate, false);
  const falsePrerequisite = await createDraftRunProposal({ executable: 'git', args: ['tag', 'must-not-exist'],
    reason: 'Only tag if ancestry condition holds', prerequisites: [
      { draftRunId: nonAncestor.id, specHash: nonAncestor.specHash, condition: 'predicate_true' }
    ] });
  const [blocked] = runs.addProposals({ proposals: [falsePrerequisite], sessionId: 'queries', agentRunId: 'same-root-segment', messageId: 'queries-assistant' });
  const blockedResult = await runs.approveAndRun(blocked.id, new Set());
  assert.notEqual(blockedResult?.status, 'done');
  assert.equal(blockedResult?.executionStarted, false);
  assert.equal(git('tag', '--list', 'must-not-exist'), '', 'false ancestor cannot start a dependent write even with a direct click');
  const invalid = await execute(['rev-parse', 'definitely-missing^{commit}']);
  assert.equal(invalid.status, 'failed');
  assert.equal(invalid.gitQueryResult?.errorCode, 'invalid_revision');
  const invalidRange = await execute(['rev-list', '--count', 'missing..HEAD']);
  assert.equal(invalidRange.status, 'failed');
  assert.equal(invalidRange.gitQueryResult?.errorCode, 'invalid_range');
  const empty = await execute(['rev-list', '--count', 'HEAD..HEAD']);
  assert.equal(empty.status, 'done');
  assert.equal(empty.gitQueryResult?.count, 0);
  const stalePrerequisite = await createDraftRunProposal({ executable: 'git', args: ['tag', 'stale-must-not-exist'],
    reason: 'Only tag with a current ancestry fact', prerequisites: [
      { draftRunId: results[2].id, specHash: results[2].specHash, condition: 'predicate_true' }
    ] });
  const [stale] = runs.addProposals({ proposals: [stalePrerequisite], sessionId: 'queries', agentRunId: 'same-root-segment', messageId: 'queries-assistant' });
  const freshFact = await inspectDraftRunDependencyFacts(stale, id => runs.get(id));
  assert.equal(freshFact.allowed, true, freshFact.reason);
  const originalTagObject = git('rev-parse', 'refs/tags/0.5.0').trim();
  const tagMovedPrerequisite = await createDraftRunProposal({ executable: 'git', args: ['tag', 'tag-move-must-not-exist'],
    reason: 'Only tag with the exact ancestry query snapshot', prerequisites: [
      { draftRunId: results[2].id, specHash: results[2].specHash, condition: 'predicate_true' }
    ] });
  const [tagMoved] = runs.addProposals({ proposals: [tagMovedPrerequisite], sessionId: 'queries', agentRunId: 'same-root-segment', messageId: 'queries-assistant' });
  git('tag', '-f', '0.5.0', 'HEAD');
  const movedFact = await inspectDraftRunDependencyFacts(tagMoved, id => runs.get(id));
  assert.equal(movedFact.code, 'dependency_stale', 'moving an existing non-HEAD loose tag invalidates the fact');
  const movedResult = await runs.approveAndRun(tagMoved.id, new Set());
  assert.equal(movedResult?.executionStarted, false);
  assert.equal(git('tag', '--list', 'tag-move-must-not-exist'), '');
  git('tag', '-f', '0.5.0', originalTagObject);
  git('commit', '--allow-empty', '-m', 'changed HEAD');
  const changed = await execute(['rev-list', '--count', '0.5.0..HEAD']);
  assert.equal(changed.gitQueryResult?.count, 3, 'fresh scope observes the actual current HEAD');
  const staleFact = await inspectDraftRunDependencyFacts(stale, id => runs.get(id));
  assert.equal(staleFact.code, 'dependency_stale');
  const staleResult = await runs.approveAndRun(stale.id, new Set());
  assert.notEqual(staleResult?.status, 'done');
  assert.equal(staleResult?.executionStarted, false);
  assert.equal(git('tag', '--list', 'stale-must-not-exist'), '', 'changed HEAD invalidates the predecessor snapshot before dependent launch');
  assert.equal(reviewerCalls, 0);
  assert.equal(launches.length, 12, 'five original + seven result semantics queries actually launched');
  t.diagnostic('Original five queries: 5 real DraftRun launches, 0 reviewer calls, 0 manual prompts; all result semantics queries: 12 launches.');
});

test('query result normalization rejects corrupt evidence without inventing predicates', () => {
  assert.equal(normalizeGitQueryResult({ version: 1, kind: 'ancestor', predicate: 'true' }), undefined);
  assert.equal(normalizeGitQueryResult({ version: 1, kind: 'revision_count', count: -1 }), undefined);
  assert.equal(normalizeGitQueryResult({ version: 1, kind: 'log', values: [3] }), undefined);
  assert.equal(normalizeGitQueryResult({ version: 1, kind: 'ancestor', predicate: true, errorCode: 'git_query_failed' }), undefined);
  assert.equal(normalizeGitQueryResult({ version: 1, kind: 'revision_count', predicate: true }), undefined);
  assert.equal(normalizeGitQueryResult({ version: 1, kind: 'tag_list', predicate: true, values: [] }), undefined);
  assert.deepEqual(normalizeGitQueryResult({ version: 1, kind: 'ancestor' }), { version: 1, kind: 'ancestor' });
});
