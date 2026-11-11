import './registerVscodeStub';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rename, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { inspectDraftRunScope } from '../src/approvals/authorization/commandScope';
import { createDraftRunProposal } from '../src/runs/draftRunProposal';
import { missingGitTaskOutcome } from '../src/runs/gitReleaseBatch';
import { normalizeGitReleaseEvidence, prepareGitRelease, verifyBlockedGitTag } from '../src/runs/gitReleaseEvidence';
import { gitReleaseIntent } from '../src/runs/gitTaskIntent';
import type { DraftRun, DraftRunProposal } from '../src/shared/types';
import * as vscode from './stubs/vscode';

test('release tag proof matches the exact current ref and the same repository and task commit', async t => {
  const repository = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-tag-evidence-')));
  const previousWorkspace = { workspaceFolders: vscode.workspace.workspaceFolders, isTrusted: vscode.workspace.isTrusted };
  vscode.workspace.workspaceFolders = [{ name: 'fixture', uri: vscode.Uri.file(repository) }];
  vscode.workspace.isTrusted = true;
  t.after(async () => {
    Object.assign(vscode.workspace, previousWorkspace);
    await rm(repository, { recursive: true, force: true });
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'KeepSeek Tag Fixture');
  git('config', 'user.email', 'tag@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  git('config', 'tag.forceSignAnnotated', 'false');
  git('config', 'core.hooksPath', '.git/hooks');
  git('commit', '--allow-empty', '-m', 'base');
  const previousHead = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'release');
  const head = git('rev-parse', 'HEAD');
  const goal = 'Commit the current changes and create tag v-proof.';
  const ref = 'refs/tags/v-proof';
  const signal = new AbortController().signal;
  const asRun = (proposal: DraftRunProposal): DraftRun => ({ ...proposal, status: 'pending', sessionId: 'tag-fixture-session',
    agentRunId: 'tag-fixture-segment', messageId: 'tag-fixture-message', createdAt: '', updatedAt: '',
    outputHead: '', outputTail: '', outputBytes: 0, outputTruncated: false, omittedOutputBytes: 0 });
  const proposal = (args: string[]) => createDraftRunProposal({ executable: 'git', args, reason: 'Isolated tag fixture' });
  const legacyBlockedRun = async (args: string[], executable = 'git') => {
    const run = asRun(await createDraftRunProposal({ executable, args, reason: 'Historical tag fixture' }));
    const historicalDiagnostic = { code: 'host_unsupported_option', phase: 'capability', started: false, category: 'capability',
      capabilityVersion: 1, blocking: true, argumentIndex: args.indexOf('--verify'), token: '--verify', reason: 'Historical capability diagnosis.' } as const;
    Object.assign(run, { status: 'needs_replan', executionStarted: false, executionPhase: 'not_dispatched',
      capabilityDiagnostic: historicalDiagnostic, replan: { code: historicalDiagnostic.code, phase: 'capability',
        executed: false, rootTaskId: 'tag-fixture-root', draftRunId: run.id, specHash: run.specHash,
        executionSegmentId: run.agentRunId, diagnostic: historicalDiagnostic, reason: historicalDiagnostic.reason } });
    return run;
  };
  const blocked = await legacyBlockedRun(['-C', '.', 'rev-parse', '--verify', 'v-proof^{commit}']);
  const commit = asRun(await proposal(['commit', '-m', 'release']));
  commit.status = 'done';
  commit.gitCommitEvidence = { outcome: 'verified', executed: true, rootTaskId: 'tag-fixture-root',
    repositoryUri: vscode.Uri.file(repository).toString(), previousHead, head, message: 'release', files: [], remainingStatus: '' };
  const tag = asRun(await proposal(['tag', 'v-proof']));
  const tagScope = await inspectDraftRunScope(tag);
  assert.equal(tagScope.uncertain, false, tagScope.reasons.join('\n'));
  const prepare = () => prepareGitRelease({ run: tag, scope: tagScope, intent: gitReleaseIntent(goal), prior: [commit],
    needsCommit: true, signal });
  const verify = (prior: DraftRun[], overrides: Partial<Parameters<typeof verifyBlockedGitTag>[0]> = {}) =>
    verifyBlockedGitTag({ run: blocked, prior, rootTaskId: 'tag-fixture-root', goal, signal, ...overrides });

  git('branch', 'v-proof', previousHead);
  git('update-ref', 'refs/refs/tags/v-proof', head);
  assert.equal(git('rev-parse', '--verify', `${ref}^{commit}`), head, 'Git falls back from the missing full name to a different ref');
  assert.equal(await verify([commit]), undefined);
  assert.equal((await prepare())?.completed, undefined);
  git('tag', 'v-proof/nested', head);
  assert.equal(await verify([commit]), undefined, 'a for-each-ref prefix match is insufficient');
  git('tag', '-d', 'v-proof/nested');
  git('tag', 'v-proof', 'HEAD^{tree}');
  assert.equal(await verify([commit]), undefined, 'a ref pointing to a tree has no commit proof');
  await assert.rejects(prepare, /Git verification query failed/u);
  git('tag', '-d', 'v-proof');
  git('tag', '-a', 'v-proof', '-m', 'Annotated fixture');
  const object = git('for-each-ref', '--format=%(objectname)', ref);
  assert.notEqual(object, head);
  tag.gitReleaseEvidence = (await prepare())?.completed;
  tag.status = 'no_changes';
  assert.deepEqual(tag.gitReleaseEvidence?.refs, [{ ref, object, peeled: head }]);
  assert.equal(tag.gitReleaseEvidence?.executed, false, 'the matching tag already exists');
  assert.match(tag.gitReleaseEvidence?.repositoryIdentity ?? '', /^[a-f\d]{64}$/u);
  assert.deepEqual(normalizeGitReleaseEvidence(tag.gitReleaseEvidence)?.refs, tag.gitReleaseEvidence?.refs);
  assert.equal(normalizeGitReleaseEvidence({ ...tag.gitReleaseEvidence, repositoryIdentity: 'corrupt' }), undefined);

  const before = [git('show-ref'), git('ls-files', '--stage'), git('status', '--porcelain=v1')];
  const legacyTag = { ...tag, gitReleaseEvidence: { ...tag.gitReleaseEvidence!, repositoryIdentity: undefined } };
  const recorded = await verify([commit, legacyTag]);
  assert.deepEqual(recorded?.refs, [{ ref, object, peeled: head }]);
  assert.equal(recorded?.executed, false);
  const freshlyVerified = await verify([commit]);
  assert.deepEqual(freshlyVerified, recorded, 'fixed host probes can obtain the exact proof without a release record');
  assert.deepEqual(await verify([commit, tag], { goal: `${goal} Independently verify tag v-proof.` }), recorded);
  assert.equal(missingGitTaskOutcome(goal, () => [commit], 'tag-fixture-root'), 'tag');
  assert.equal(missingGitTaskOutcome(goal, () => [commit], 'tag-fixture-root', [freshlyVerified!]), undefined);
  const multiple = 'Commit and create tags v-proof and v-other.';
  assert.deepEqual([...gitReleaseIntent(multiple).localTags], ['v-proof', 'v-other']);
  assert.deepEqual([...gitReleaseIntent('创建标签 v-proof、v-other，并推送已有标签 previous。').localTags], ['v-proof', 'v-other']);
  assert.deepEqual([...gitReleaseIntent('Create an annotated tag v-proof, then push existing tag v-other.').localTags], ['v-proof']);
  const otherTag = { ...freshlyVerified!, refsRequested: ['refs/tags/v-other'], refs: [{ ref: 'refs/tags/v-other', object: head }] };
  const otherRecord = { ...tag, gitReleaseEvidence: otherTag };
  assert.equal(missingGitTaskOutcome(multiple, () => [commit, otherRecord], 'tag-fixture-root', [freshlyVerified!]), 'tag');
  assert.equal(missingGitTaskOutcome(multiple, () => [commit], 'tag-fixture-root', [freshlyVerified!, otherTag]), undefined);
  assert.equal(await verify([commit, tag], { rootTaskId: 'another-task' }), undefined);
  assert.equal(await verify([commit, tag], { goal: 'Create tag v-other.' }), undefined);
  assert.equal(await verify([commit, tag], { signal: AbortSignal.abort() }), undefined);
  assert.equal(await verify([{ ...commit, sessionId: 'another-session' }, tag]), undefined);
  assert.equal(await verify([commit, tag], { run: await legacyBlockedRun(['-C', '..', 'rev-parse', '--verify', 'v-proof^{commit}']) }), undefined);
  assert.equal(await verify([commit, tag], { run: await legacyBlockedRun(['rev-parse', '--verify', 'v-proof^{commit}'], './git') }), undefined);
  assert.deepEqual([git('show-ref'), git('ls-files', '--stage'), git('status', '--porcelain=v1')], before);

  const objectPath = path.join(repository, '.git', 'objects', object.slice(0, 2), object.slice(2));
  const detachedObjectPath = path.join(repository, '.git', 'fixture-detached-object');
  await rename(objectPath, detachedObjectPath);
  try {
    assert.equal(await verify([commit, legacyTag]), undefined, 'a dangling loose ref cannot reuse historical tag proof');
  } finally { await rename(detachedObjectPath, objectPath); }

  vscode.workspace.isTrusted = false;
  assert.equal(await verify([commit, tag]), undefined);
  vscode.workspace.isTrusted = true;
  git('config', 'remote.fixture.promisor', 'true');
  assert.equal(await verify([commit, tag]), undefined, 'repository configuration must still be verified');
  git('config', '--unset', 'remote.fixture.promisor');
  git('tag', '-f', 'v-proof', previousHead);
  assert.equal(await verify([commit, tag]), undefined, 'moving the ref invalidates the prior object evidence');
  git('tag', '-f', 'v-proof', head);
  assert.equal(await verify([commit, tag]), undefined, 'a different object does not prove the original release tag even if it peels to the same commit');
  assert.deepEqual((await verify([commit]))?.refs, [{ ref, object: head }], 'a lightweight tag binds directly to the commit');
  t.diagnostic('Git exact-ref/OID verification performed through fixed host probes; business DraftRun launches 0, model continuations 0');
});
