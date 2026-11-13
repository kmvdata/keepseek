import './registerVscodeStub';
import assert from 'node:assert/strict';
import childProcess = require('node:child_process');
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { ApprovalReviewerService } from '../src/approvals/approvalReviewer';
import { ApprovalReviewStore } from '../src/approvals/approvalReviewStore';
import { createDraftRunReviewRequest } from '../src/approvals/approvalReviewSurface';
import { APPROVAL_POLICY_VERSION } from '../src/approvals/approvalReviewTypes';
import { ExactOperationGrants, inspectAutomaticRunAuthorization, assertAutomaticRunAuthorization } from '../src/approvals/authorization';
import { DraftRunAuthorizationService } from '../src/runs/draftRunAuthorization';
import { SpawnDraftRunExecutor } from '../src/runs/draftRunExecutor';
import { createDraftRunProposal } from '../src/runs/draftRunProposal';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { interpretGitQueryResult, normalizeGitQueryResult } from '../src/runs/gitQueryResult';
import { inspectDraftRunDependencyFacts } from '../src/runs/draftRunDependencies';
import type { DraftRun } from '../src/shared/types';

test('bounded Git queries preserve literal argv through real delegate and explicit ask launches', async t => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-local-query-')));
  const workspace = path.join(root, 'workspace');
  await mkdir(workspace);
  const saved = { workspaceFolders: vscode.workspace.workspaceFolders, isTrusted: vscode.workspace.isTrusted };
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspace), name: 'query-fixture' }];
  vscode.workspace.isTrusted = true;
  const git = (...args: string[]) => childProcess.execFileSync('git', args, { cwd: workspace, encoding: 'utf8', stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'KeepSeek Query Test');
  git('config', 'user.email', 'query@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('config', 'core.warnAmbiguousRefs', 'true');
  git('config', 'core.hooksPath', '.git/hooks');
  await writeFile(path.join(workspace, 'tracked.txt'), 'stable index and worktree\n');
  git('add', 'tracked.txt');
  git('commit', '--allow-empty', '-m', 'base');
  git('tag', '0.5.0');
  git('commit', '--allow-empty', '-m', 'after tag');
  git('commit', '--allow-empty', '-m', 'after tag again');
  git('tag', '-a', '-m', 'annotated fixture', 'v0.5.3', '0.5.0');
  git('branch', 'v0.5.3', 'HEAD');
  const storage = vscode.Uri.file(path.join(root, 'storage')) as never;
  const reviews = new ApprovalReviewStore(storage);
  await reviews.initialize();
  const sourceStore = new ModelSourceStore(storage);
  await sourceStore.createSource({ id: 'query-source', provider: 'openai-compatible', name: 'Query source',
    apiKey: 'fixture-only', models: [{ id: 'query-model' }] });
  const modelContext = { model: { id: 'query-model', sourceId: 'query-source', provider: 'openai-compatible' as const,
    label: 'Query model', contextWindowTokens: 32768, maxOutputTokens: 4096 } };
  let reviewerCalls = 0;
  const reviewer = new ApprovalReviewerService({ globalStorageUri: storage, workspaceKey: 'query-fixture',
    sourceStore, store: reviews, getAutoSetting: () => ({ mode: 'follow-main' }),
    requestText: async input => {
      reviewerCalls++;
      assert.equal(input.model.id, modelContext.model.id);
      const { exactAction } = JSON.parse(input.userPrompt.split('\n')[2]);
      return JSON.stringify({ decision: 'approve', risk: 'low', reason: 'Finite verified query.', policyRules: ['direct_user_goal'],
        saferAlternative: '', affectedTargets: [exactAction.cwdUri] });
    } });
  const executor = new SpawnDraftRunExecutor();
  const spawn = t.mock.method(childProcess, 'spawn');
  const launches = () => spawn.mock.calls.map(({ arguments: [, argv, options] }) => {
    assert.equal(options?.shell, false);
    assert.ok(Array.isArray(argv));
    return argv;
  });
  const stdoutById = new Map<string, string>();
  const runs = new DraftRunStore(storage, {
    execute: async input => {
      const { id } = input.draftRun;
      return await executor.execute({ ...input, onOutput: chunk => {
        if (chunk.stream === 'stdout') stdoutById.set(id, (stdoutById.get(id) ?? '') + chunk.text);
        input.onOutput(chunk);
      } });
    },
    cancel: id => executor.cancel(id), showTerminal: id => executor.showTerminal(id), dispose: () => executor.dispose()
  }, new DraftRunAuthorizationService(reviews));
  t.after(async () => {
    await runs.flush(); runs.dispose();
    Object.assign(vscode.workspace, saved);
    await rm(root, { recursive: true, force: true });
  });
  const ownership = { sessionId: 'queries', agentRunId: 'same-root-segment', messageId: 'queries-assistant' };
  const proposalFor = (args: string[], cwd?: string) => createDraftRunProposal({
    executable: 'git', args, reason: 'Verify local history facts', timeoutMs: 120000, cwd
  });
  const historicalArgs = ['rev-parse', '--verify', 'v0.5.3^{commit}'];
  const legacy: DraftRun = {
    ...await proposalFor(historicalArgs), ...ownership, status: 'needs_replan', executionStarted: false, executionPhase: 'not_dispatched',
    capabilityDiagnostic: { code: 'host_unsupported_option', phase: 'capability', started: false, category: 'capability',
      argumentIndex: 1, token: '--verify', capabilityVersion: 1, blocking: true,
      reason: 'This argument or behavior is outside the host command grammar. / 该参数或行为不在宿主命令语法内。 (--verify)' },
    outputHead: '', outputTail: '', outputBytes: 0, outputTruncated: false, omittedOutputBytes: 0,
    createdAt: '2026-11-11T01:00:00.000Z', updatedAt: '2026-11-11T01:00:00.000Z', finishedAt: '2026-11-11T01:00:00.000Z'
  };
  await mkdir(path.join(root, 'storage'), { recursive: true });
  await writeFile(path.join(root, 'storage', 'draft-runs.json'), JSON.stringify({ version: 1, draftRuns: [legacy] }));
  await runs.initialize();
  const [historyCard] = runs.toWebviewState(ownership.sessionId);
  assert.equal(historyCard.status, 'needs_replan');
  assert.deepEqual(historyCard.spec.args, historicalArgs);
  assert.deepEqual(JSON.parse(JSON.stringify(historyCard.capabilityDiagnostic)), legacy.capabilityDiagnostic);
  assert.equal(historyCard.executionStarted, false);
  assert.equal(await runs.approveAndRun(legacy.id, new Set()), undefined);
  assert.equal(runs.cloneAsPending(legacy.id), undefined);
  assert.equal(launches().length, 0, 'loading, rendering and attempting to run the historical card cannot launch it');

  const execute = async (args: string[], mode: 'ask' | 'delegate' = 'delegate') => {
    const proposal = await proposalFor(args);
    const [run] = runs.addProposals({ proposals: [proposal], ...ownership });
    assert.equal(run.status, 'pending');
    assert.equal(run.approvedAt, undefined);
    assert.equal(run.executionStarted, false);
    const grants = new ExactOperationGrants();
    const decision = await inspectAutomaticRunAuthorization(run, grants, mode);
    assert.equal(decision.allowed, true, decision.refusal?.reason);
    assert.equal(decision.reviewable, true, JSON.stringify(decision.scope.diagnostics));
    let result: DraftRun | undefined;
    if (mode === 'delegate') {
      const { record } = await reviewer.review({
        ...createDraftRunReviewRequest({ draftRun: run, scope: decision.scope, rootTaskId: 'same-root', language: 'en',
          history: [{ id: 'query-user', role: 'user', content: 'Inspect the requested repository objects.', createdAt: new Date().toISOString() }] }),
        approvalMode: 'delegate', scopeFingerprint: decision.scope.fingerprint
      }, modelContext);
      assert.equal(record.decision, 'approve', record.rationale);
      result = await runs.approveAndRun(run.id, decision.authorizedUris, {
        delegatedApproval: () => true,
        verifyScope: () => assertAutomaticRunAuthorization(run, grants, decision.scope.fingerprint, 'delegate'),
        approvalRecord: { ...record, expectedSource: 'auto_approval_review', workspaceTrusted: true }
      });
    } else {
      assert.equal(runs.get(run.id)?.status, 'pending', 'scope verification is not user approval');
      result = await runs.approveAndRun(run.id, decision.authorizedUris, { expectedSpecHash: run.specHash, userApproval: () => true });
      assert.equal(result?.authorizationSource, 'user_click');
    }
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
  assert.deepEqual(launches(), original);
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
  assert.equal(launches().length, 12, 'five original + seven result semantics queries actually launched');

  const refsBefore = git('for-each-ref', '--format=%(refname) %(objectname)');
  const indexFile = path.join(workspace, '.git', 'index');
  const indexBefore = await readFile(indexFile);
  const worktreeBefore = await readFile(path.join(workspace, 'tracked.txt'));
  const taggedCommit = git('rev-parse', 'refs/tags/0.5.0').trim();
  const verified = await execute(historicalArgs);
  assert.notEqual(verified.id, legacy.id);
  assert.equal(verified.specHash, legacy.specHash, 'identical immutable command bytes keep their canonical hash');
  assert.equal(verified.status, 'done');
  assert.deepEqual(verified.gitQueryResult?.values, [taggedCommit]);
  assert.equal(verified.gitQueryResult?.predicate, undefined, 'ambiguous revision parsing is not exact tag evidence');
  assert.match(verified.outputHead, /refname .* is ambiguous/u);
  assert.equal(verified.gitReleaseEvidence, undefined);
  assert.equal(await runs.approveAndRun(legacy.id, new Set()), undefined);
  const prefixed = await execute(['-C', '.', 'rev-parse', '--verify', '--end-of-options', 'refs/tags/v0.5.3^{commit}']);
  assert.equal(prefixed.status, 'done');
  assert.deepEqual(prefixed.gitQueryResult?.values, [taggedCommit]);
  const lightweight = await execute(['rev-parse', '--verify', 'refs/tags/0.5.0^{commit}']);
  assert.deepEqual(lightweight.gitQueryResult?.values, [taggedCommit]);
  const asked = await execute(['rev-parse', '--verify', '--quiet', '--end-of-options', 'v0.5.3^{commit}'], 'ask');
  assert.equal(asked.status, 'done');
  assert.deepEqual(asked.gitQueryResult?.values, [taggedCommit]);
  assert.equal(stdoutById.get(asked.id)?.trim(), taggedCommit, 'quiet verify emits exactly one full object ID on stdout');

  const quietMissing = await execute(['rev-parse', '--verify', '--quiet', 'missing-tag^{commit}']);
  assert.equal(quietMissing.status, 'failed');
  assert.equal(quietMissing.exitCode, 1);
  assert.equal(stdoutById.get(quietMissing.id), undefined);
  assert.equal(quietMissing.gitQueryResult?.errorCode, 'git_query_failed');
  assert.equal(quietMissing.gitQueryResult?.predicate, undefined);
  const tree = git('rev-parse', 'HEAD^{tree}').trim();
  const wrongType = await execute(['rev-parse', '--verify', '--quiet', tree + '^{commit}']);
  assert.equal(wrongType.status, 'failed');
  assert.equal(wrongType.exitCode, 1);
  assert.equal(wrongType.gitQueryResult?.errorCode, 'git_query_failed');
  assert.equal(wrongType.gitQueryResult?.values, undefined);
  const missing = await execute(['rev-parse', '--verify', 'missing-tag^{commit}']);
  assert.equal(missing.status, 'failed');
  assert.equal(missing.gitQueryResult?.errorCode, 'invalid_revision');
  const absentObject = '1'.repeat(taggedCommit.length);
  const bare = await execute(['rev-parse', '--verify', absentObject]);
  assert.equal(bare.status, 'done');
  assert.deepEqual(bare.gitQueryResult?.values, [absentObject]);
  assert.equal(bare.gitQueryResult?.predicate, undefined);
  const checked = await execute(['rev-parse', '--verify', '--quiet', absentObject + '^{object}']);
  assert.equal(checked.status, 'failed');
  assert.equal(checked.exitCode, 1);
  assert.equal(checked.gitQueryResult?.values, undefined);
  assert.deepEqual(launches().slice(12), [verified, prefixed, lightweight, asked, quietMissing, wrongType, missing, bare, checked]
    .map(run => run.spec.args), 'the complete literal argv, including each ^{commit} suffix, reaches real spawn');

  const external = path.join(root, 'external');
  await mkdir(external);
  const [outside] = runs.addProposals({ proposals: [await proposalFor(historicalArgs, external)], ...ownership });
  const outsideAuthorization = await inspectAutomaticRunAuthorization(outside, new ExactOperationGrants(), 'delegate');
  assert.equal(outsideAuthorization.requiresExactGrant, true);
  assert.equal(outsideAuthorization.reviewable, false);
  assert.equal(outsideAuthorization.refusal?.code, 'insufficient_launch_evidence');
  assert.equal((await runs.approveAndRun(outside.id, new Set()))?.executionStarted, false);
  const [untrusted, cancelled, unverified] = runs.addProposals({ proposals: await Promise.all([
    proposalFor(historicalArgs), proposalFor(historicalArgs), proposalFor(historicalArgs)
  ]), ...ownership });
  vscode.workspace.isTrusted = false;
  await assert.rejects(inspectAutomaticRunAuthorization(untrusted, new ExactOperationGrants(), 'delegate'), /workspace is not trusted/u);
  assert.equal((await runs.approveAndRun(untrusted.id, new Set()))?.executionStarted, false);
  vscode.workspace.isTrusted = true;
  assert.equal((await runs.approveAndRun(cancelled.id, new Set(), { userApproval: () => true, signal: AbortSignal.abort() }))?.executionStarted, false);
  git('config', 'remote.origin.promisor', 'true');
  assert.equal((await inspectAutomaticRunAuthorization(unverified, new ExactOperationGrants(), 'delegate')).refusal?.code, 'insufficient_launch_evidence');
  git('config', '--unset', 'remote.origin.promisor');
  if (process.platform !== 'win32') {
    const shim = path.join(workspace, 'git');
    await writeFile(shim, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
    const proposal = await createDraftRunProposal({ executable: shim, args: historicalArgs, reason: 'Unverified Git launcher' });
    const [untrustedLauncher] = runs.addProposals({ proposals: [proposal], ...ownership });
    assert.equal((await inspectAutomaticRunAuthorization(untrustedLauncher, new ExactOperationGrants(), 'delegate')).refusal?.code,
      'insufficient_launch_evidence');
    await rm(shim);
  }
  const [denied] = runs.addProposals({ proposals: [await proposalFor(historicalArgs)], ...ownership });
  await reviews.add({ sessionId: denied.sessionId, agentRunId: denied.agentRunId, rootTaskId: 'same-root', targetId: 'denied-prior-id',
    actionKind: 'draft_run_execute', actionHash: denied.specHash, policyVersion: APPROVAL_POLICY_VERSION, approvalSource: 'local_policy',
    reviewerSourceId: '', reviewerModelId: '', reviewerProvider: 'local_policy', decision: 'deny', risk: 'critical',
    rationale: 'Existing hard denial fixture', policyRules: ['fixture'] });
  const deniedAttempt = await runs.approveAndRun(denied.id, new Set(), { expectedSpecHash: denied.specHash, userApproval: () => true });
  assert.equal(deniedAttempt?.executionStarted, false);
  assert.equal(deniedAttempt?.error, 'Existing hard denial fixture');
  assert.equal(git('for-each-ref', '--format=%(refname) %(objectname)'), refsBefore);
  assert.deepEqual(await readFile(indexFile), indexBefore);
  assert.deepEqual(await readFile(path.join(workspace, 'tracked.txt')), worktreeBefore);
  assert.equal(git('--no-optional-locks', 'status', '--porcelain'), '');
  assert.equal(reviewerCalls, 20);
  assert.equal(launches().length, 21, 'historical and refused commands add no launch to the 21 approved queries');
  t.diagnostic('21 real DraftRun launches (20 delegate reviews, 1 explicit ask), 9 verify launches and 0 historical launches.');
});

test('verify output must be one full SHA-1 or SHA-256 object ID', () => {
  const spec = { executable: 'git', args: ['rev-parse', '--verify', 'HEAD'], reason: 'Verify output', cwdUri: 'file:///repo',
    cwdLabel: '.', externalCwd: false, timeoutMs: 120_000, env: [] };
  const exit = { exitCode: 0, cancelled: false, timedOut: false };
  for (const length of [40, 64]) {
    const oid = 'a'.repeat(length);
    assert.deepEqual(interpretGitQueryResult(spec, exit, oid + '\r\n', '')?.values, [oid]);
    assert.equal(interpretGitQueryResult(spec, exit, `${oid}\n${oid}\n`, '')?.errorCode, 'invalid_query_output');
    assert.equal(interpretGitQueryResult(spec, exit, `--end-of-options\n${oid}\n`, '')?.errorCode, 'invalid_query_output');
  }
  assert.equal(interpretGitQueryResult(spec, exit, 'a'.repeat(39) + '\n', '')?.errorCode, 'invalid_query_output');
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
