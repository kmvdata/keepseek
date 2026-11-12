import './registerVscodeStub';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { inspectDraftRunScope } from '../src/approvals/authorization/commandScope';
import { createDraftRunProposal } from '../src/runs/draftRunProposal';
import { missingGitTaskOutcome } from '../src/runs/gitReleaseBatch';
import { authorizeGitRemote, snapshotProjectGitPushDestination, type GitRemoteLaunch } from '../src/runs/gitReleaseAuthorization';
import { normalizeGitReleaseEvidence, prepareGitRelease, verifyBlockedGitTag } from '../src/runs/gitReleaseEvidence';
import { gitReleaseIntent } from '../src/runs/gitTaskIntent';
import { prepareGitTransportEnvironment } from '../src/runs/gitTransportEnvironment';
import { normalizeUserTask } from '../src/sessions/userTask';
import { assertLocalGitCommitSnapshot, normalizeLocalGitCommitPlan, prepareLocalGitCommit } from '../src/runs/localGitCommit';
import { analyzeCommand } from '../src/approvals/authorization/commandSemantics';
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

test('Git launch proofs reject changed local content and defer the remote push probe until scope consent', async t => {
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-release-review-')));
  const repo = path.join(fixture, 'project');
  const bare = path.join(fixture, 'destination.git');
  const previousWorkspace = { workspaceFolders: vscode.workspace.workspaceFolders, isTrusted: vscode.workspace.isTrusted };
  t.after(async () => {
    Object.assign(vscode.workspace, previousWorkspace);
    await rm(fixture, { recursive: true, force: true });
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main', repo);
  git('init', '--bare', bare);
  git('-C', repo, 'config', 'user.name', 'KeepSeek Release Fixture');
  git('-C', repo, 'config', 'user.email', 'release@example.invalid');
  git('-C', repo, 'config', 'commit.gpgsign', 'false');
  git('-C', repo, 'config', 'core.hooksPath', '.git/hooks');
  git('-C', repo, 'remote', 'add', 'origin', bare);
  const tracked = path.join(repo, 'tracked.txt');
  await writeFile(tracked, 'initial\n');
  git('-C', repo, 'add', 'tracked.txt');
  git('-C', repo, 'commit', '-m', 'initial');
  const initialHead = git('-C', repo, 'rev-parse', 'HEAD');
  vscode.workspace.workspaceFolders = [{ name: 'fixture', uri: vscode.Uri.file(repo) }];
  vscode.workspace.isTrusted = true;
  const run = async (args: string[]): Promise<DraftRun> => ({
    ...await createDraftRunProposal({ executable: 'git', args, reason: 'Git release approval fixture' }),
    status: 'pending', sessionId: 'fixture-session', agentRunId: 'fixture-segment', messageId: 'fixture-message',
    createdAt: '', updatedAt: '', outputHead: '', outputTail: '', outputBytes: 0, outputTruncated: false, omittedOutputBytes: 0
  });
  const signal = new AbortController().signal;
  const commit = await run(['commit', '-a', '-m', 'update']);
  await writeFile(tracked, 'version A\n');
  const commitScope = await inspectDraftRunScope(commit);
  const preparedCommit = await prepareLocalGitCommit(commit, commitScope, 'fixture-task', signal);
  assert.equal(preparedCommit?.outcome, 'ready', commitScope.reasons.join('\n'));
  if (preparedCommit?.outcome !== 'ready') return;
  assert.deepEqual(normalizeLocalGitCommitPlan(preparedCommit.snapshot), preparedCommit.snapshot);
  await assertLocalGitCommitSnapshot(commit, preparedCommit.snapshot, signal);
  await writeFile(tracked, 'version B\n');
  await assert.rejects(assertLocalGitCommitSnapshot(commit, preparedCommit.snapshot, signal), /scope changed before launch/u);
  assert.equal(git('-C', repo, 'rev-parse', 'HEAD'), initialHead);

  const push = await run(['push', 'origin', 'refs/heads/main']);
  const pushScope = await inspectDraftRunScope(push, true);
  const pushCommand = analyzeCommand(push.spec).gitRemote;
  assert.ok(pushCommand && pushScope.gitRemote, pushScope.reasons.join('\n'));
  const intent = gitReleaseIntent('Push the current branch to origin.');
  const remote = await authorizeGitRemote(pushScope, pushCommand, intent, undefined,
    { repository: repo, destination: pushScope.gitRemote.destination, read: ['refs/heads/main'], push: ['refs/heads/main'] });
  assert.ok(remote);
  const input = { run: push, scope: pushScope, intent, remote: { ...remote, executable: path.join(fixture, 'unavailable-git') },
    prior: [], needsCommit: false, signal };
  const pending = await prepareGitRelease({ ...input, probeRemote: false });
  assert.ok(pending);
  assert.equal(pending.pushAttempt, undefined);
  await pending.beforeLaunch();
  await assert.rejects(pending.verify(push), /authorized destination/u);
  await assert.rejects(prepareGitRelease(input));
  assert.equal(git('-C', bare, 'for-each-ref'), '', 'the destination receives no ref');

  git('-C', repo, 'commit', '-a', '-m', 'update');
  await assert.rejects(pending.beforeLaunch(), /Local refs changed before push/u);
});

test('a default push binds the effective remote and source object, and an exact lease verifies a real rewrite', async t => {
  const fixture = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-controlled-push-')));
  const repo = path.join(fixture, 'project');
  const destination = path.join(fixture, 'approved remote.git');
  const other = path.join(fixture, 'different.git');
  const previousWorkspace = { workspaceFolders: vscode.workspace.workspaceFolders, isTrusted: vscode.workspace.isTrusted,
    getConfiguration: vscode.workspace.getConfiguration };
  t.after(async () => {
    Object.assign(vscode.workspace, previousWorkspace);
    await rm(fixture, { recursive: true, force: true });
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: fixture, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main', repo);
  git('init', '--bare', destination);
  git('init', '--bare', other);
  git('-C', repo, 'config', 'user.name', 'KeepSeek Push Fixture');
  git('-C', repo, 'config', 'user.email', 'push@example.invalid');
  git('-C', repo, 'config', 'commit.gpgsign', 'false');
  git('-C', repo, 'config', 'core.hooksPath', '.git/hooks');
  git('-C', repo, 'config', 'push.default', 'current');
  git('-C', repo, 'remote', 'add', 'origin', other);
  git('-C', repo, 'remote', 'set-url', '--push', 'origin', destination);
  git('-C', repo, 'commit', '--allow-empty', '-m', 'base');
  const base = git('-C', repo, 'rev-parse', 'HEAD');
  git('-C', repo, 'commit', '--allow-empty', '-m', 'new');
  const latest = git('-C', repo, 'rev-parse', 'HEAD');
  vscode.workspace.workspaceFolders = [{ name: 'fixture', uri: vscode.Uri.file(repo) }];
  vscode.workspace.isTrusted = true;
  vscode.workspace.getConfiguration = () => ({ ...previousWorkspace.getConfiguration(), inspect: () => undefined });
  const ref = 'refs/heads/main';
  const run = async (args: string[]): Promise<DraftRun> => ({
    ...await createDraftRunProposal({ executable: 'git', args, reason: 'Verified isolated fixture push' }),
    status: 'pending', sessionId: 's', agentRunId: 'segment', messageId: 'message', createdAt: '', updatedAt: '',
    outputHead: '', outputTail: '', outputBytes: 0, outputTruncated: false, omittedOutputBytes: 0
  });
  const push = await run(['push']);
  const command = analyzeCommand(push.spec).gitRemote;
  assert.ok(command?.kind === 'push' && command.currentBranch);
  const scope = await inspectDraftRunScope(push, true);
  assert.deepEqual(scope.gitRemote?.command, { kind: 'push', remote: 'origin', refs: [ref] }, scope.reasons.join('\n'));
  assert.deepEqual(scope.gitRemote?.sourceRefs, [{ ref, object: latest }]);
  const aliasIntent = gitReleaseIntent('Push the current branch to origin.');
  assert.equal(await authorizeGitRemote(scope, command, aliasIntent), undefined);
  const taskDestination = await snapshotProjectGitPushDestination(undefined, aliasIntent);
  assert.deepEqual(taskDestination, { repository: repo, destination, remote: 'origin' });
  const task = { version: 1, id: 'task', originMessageId: 'task', reason: 'user', gitPushDestination: taskDestination };
  const restoredDestination = normalizeUserTask(JSON.parse(JSON.stringify(task)))?.gitPushDestination;
  assert.deepEqual(restoredDestination, taskDestination);
  assert.equal(normalizeUserTask({ ...task, gitPushDestination: { ...taskDestination, repository: '..' } })?.gitPushDestination, undefined);
  assert.equal((await authorizeGitRemote(scope, command, aliasIntent, undefined, undefined, restoredDestination))?.authorization, 'task');
  const exactQuery = await run(['ls-remote', destination, ref]);
  const queryCommand = analyzeCommand(exactQuery.spec).gitRemote;
  assert.ok(queryCommand);
  assert.equal((await authorizeGitRemote(await inspectDraftRunScope(exactQuery, true), queryCommand,
    aliasIntent, undefined, undefined, taskDestination))?.authorization, 'task');
  const intent = gitReleaseIntent(`Push the current branch to "${destination}".`);
  const remote = await authorizeGitRemote(scope, command, intent);
  assert.ok(remote);
  assert.equal(remote.authorization, 'task');
  assert.deepEqual(remote.args.slice(-3), ['--', destination, `${latest}:${ref}`]);
  const metadata = await inspectDraftRunScope(push, 'metadata');
  assert.equal((await authorizeGitRemote(metadata, command, intent))?.fingerprint, remote.fingerprint);
  const shorthand = await run(['push', 'origin', 'main']);
  assert.deepEqual((await inspectDraftRunScope(shorthand, true)).gitRemote?.command, { kind: 'push', remote: 'origin', refs: [ref] });
  git('-C', repo, 'tag', 'main');
  await assert.rejects(inspectDraftRunScope(shorthand, true), /ref is missing or ambiguous/u);
  git('-C', repo, 'tag', '-d', 'main');
  const signal = new AbortController().signal;
  const execute = async (launch: GitRemoteLaunch) => {
    const transport = await prepareGitTransportEnvironment(launch);
    try {
      assert.notEqual(transport.cwd, repo);
      execFileSync(launch.executable, launch.args, { cwd: transport.cwd, env: transport.env, stdio: 'pipe' });
    } finally { await transport.dispose(); }
  };
  const grant = { repository: repo, destination, read: [ref], push: [ref], rewrite: [ref] };
  vscode.workspace.getConfiguration = () => ({ ...previousWorkspace.getConfiguration(), inspect: (key: string) =>
    key === 'gitReleaseGrants' ? { globalValue: [grant, { ...grant, destination: other }] } : undefined });
  const conflictCases = [
    ['Commit the current changes without pushing.', /task prohibits/u],
    ['请提交改动，禁止推送。', /task prohibits/u],
    ['Push the current branch to upstream.', /task destination/u],
    [`Push the current branch to "${other}".`, /task destination/u],
    ['Inspect branch main, then push branch release to origin.', /outside the current task/u],
    ['Create tag v-next, then push tag v-other to origin.', /outside the current task/u],
    ['git push origin refs/heads/release', /outside the current task/u]
  ] as const;
  for (const [goal, error] of conflictCases) {
    await assert.rejects(authorizeGitRemote(scope, command, gitReleaseIntent(goal)), error);
    await assert.rejects(authorizeGitRemote(scope, command, gitReleaseIntent(goal), undefined, grant), error);
  }
  assert.equal((await authorizeGitRemote(scope, command, aliasIntent))?.authorization, 'configured');
  const localOnly = 'Commit the current changes without pushing.';
  const correction = 'Continue this task, push to origin.';
  assert.equal((await authorizeGitRemote(scope, command, gitReleaseIntent(`${localOnly}\n\n${correction}`, [localOnly, correction]),
    undefined, undefined, restoredDestination))?.authorization, 'task');
  await assert.rejects(authorizeGitRemote(scope, command, gitReleaseIntent(`${correction}\n\n${localOnly}`, [correction, localOnly]),
    undefined, grant, restoredDestination), /task prohibits/u);
  vscode.workspace.getConfiguration = () => ({ ...previousWorkspace.getConfiguration(), inspect: () => undefined });

  const alternate = path.join(repo, '.git', 'objects', 'info', 'alternates');
  await writeFile(alternate, path.join(other, 'objects') + '\n');
  try { await assert.rejects(prepareGitTransportEnvironment(remote), /source object storage is redirected/u); }
  finally { await rm(alternate); }
  if (process.platform !== 'win32') {
    const object = path.join(repo, '.git', 'objects', latest.slice(0, 2), latest.slice(2));
    const savedObject = path.join(fixture, 'saved-object');
    await rename(object, savedObject);
    await symlink(savedObject, object);
    try { await assert.rejects(prepareGitTransportEnvironment(remote), /source object storage is redirected/u); }
    finally { await rm(object); await rename(savedObject, object); }
  }
  const release = await prepareGitRelease({ run: push, scope, remote, intent, prior: [], needsCommit: false, signal });
  assert.ok(release && !release.completed);
  await release.beforeLaunch();
  await execute(remote);
  assert.deepEqual((await release.verify({ ...push, startedAt: new Date().toISOString(), exitCode: 0 })).refs,
    [{ ref, object: latest }]);
  assert.equal(git('-C', other, 'for-each-ref'), '');

  git('-C', repo, 'reset', '--hard', base);
  const wrongLease = await run(['push', `--force-with-lease=${ref}:${base}`, 'origin', ref]);
  const rightLease = await run(['push', `--force-with-lease=${ref}:${latest}`, 'origin', ref]);
  const rewrite = gitReleaseIntent(`Force-push the current branch to "${destination}".`);
  for (const [candidate, correct] of [[wrongLease, false], [rightLease, true]] as const) {
    const proposal = analyzeCommand(candidate.spec).gitRemote;
    const live = await inspectDraftRunScope(candidate, true);
    assert.ok(proposal?.kind === 'push' && proposal.lease && live.gitRemote, live.reasons.join('\n'));
    assert.equal(await authorizeGitRemote(live, proposal, intent), undefined, 'ordinary push authority does not cover a rewrite');
    const explicitLease = gitReleaseIntent(`git push --force-with-lease=${ref}:${latest} origin ${ref}`);
    if (!correct) await assert.rejects(authorizeGitRemote(live, proposal, explicitLease, undefined, grant, restoredDestination), /task lease/u);
    else assert.equal((await authorizeGitRemote(live, proposal, explicitLease, undefined, undefined, restoredDestination))?.authorization, 'task');
    const transport = await authorizeGitRemote(live, proposal, rewrite);
    assert.ok(transport);
    const prepare = () => prepareGitRelease({ run: candidate, scope: live, remote: transport, intent: rewrite,
      prior: [], needsCommit: false, signal });
    if (!correct) {
      await assert.rejects(prepare, /differs from the requested lease/u);
      assert.equal(git('-C', destination, 'rev-parse', ref), latest);
    } else {
      const prepared = await prepare();
      assert.ok(prepared && !prepared.completed);
      await prepared.beforeLaunch();
      await execute(transport);
      assert.deepEqual((await prepared.verify({ ...candidate, startedAt: new Date().toISOString(), exitCode: 0 })).refs,
        [{ ref, object: base }]);
    }
  }
  const pack = path.join(destination, 'objects', 'pack');
  const savedPack = path.join(fixture, 'saved-pack');
  const outsidePack = path.join(other, 'objects', 'pack');
  await rename(pack, savedPack);
  await symlink(outsidePack, pack, process.platform === 'win32' ? 'junction' : 'dir');
  try {
    await assert.rejects(inspectDraftRunScope(push, true), /destination storage is redirected/u);
    assert.deepEqual(await readdir(outsidePack), []);
  } finally {
    await rm(pack);
    await rename(savedPack, pack);
  }
  const outsideLog = path.join(fixture, 'unrelated-log');
  const reflog = path.join(destination, 'logs', 'refs', 'heads', 'main');
  await writeFile(outsideLog, 'untouched\n');
  await mkdir(path.dirname(reflog), { recursive: true });
  await link(outsideLog, reflog);
  try {
    await assert.rejects(inspectDraftRunScope(push, true), /destination storage is redirected/u);
    assert.equal(await readFile(outsideLog, 'utf8'), 'untouched\n');
  } finally { await rm(reflog); }
  git('-C', repo, 'remote', 'set-url', '--push', 'origin', other);
  const redirected = await inspectDraftRunScope(push, true);
  vscode.workspace.getConfiguration = () => ({ ...previousWorkspace.getConfiguration(), inspect: (key: string) =>
    key === 'gitReleaseGrants' ? { globalValue: [{ ...grant, destination: other }] } : undefined });
  await assert.rejects(authorizeGitRemote(redirected, command, intent), /task destination/u);
  await assert.rejects(authorizeGitRemote(redirected, command, aliasIntent, undefined, undefined, restoredDestination), /task destination/u);
  git('-C', repo, 'config', 'remote.origin.push', 'refs/heads/*:refs/heads/*');
  await assert.rejects(inspectDraftRunScope(push, true), /does not resolve to one current branch/u);
});

test('HTTPS uses the resolved endpoint and a scoped host credential without loading project Git helpers', async t => {
  const repo = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-git-https-')));
  const previousWorkspace = { workspaceFolders: vscode.workspace.workspaceFolders, isTrusted: vscode.workspace.isTrusted,
    getConfiguration: vscode.workspace.getConfiguration };
  const credentialEnvironment = 'KEEPSEEK_TEST_CONTROLLED_GIT_TOKEN';
  const priorToken = process.env[credentialEnvironment];
  const token = 'fixture-token-only';
  t.after(async () => {
    Object.assign(vscode.workspace, previousWorkspace);
    if (priorToken === undefined) delete process.env[credentialEnvironment];
    else process.env[credentialEnvironment] = priorToken;
    await rm(repo, { recursive: true, force: true });
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.name', 'KeepSeek HTTPS Fixture');
  git('config', 'user.email', 'https@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '.git/hooks');
  git('commit', '--allow-empty', '-m', 'base');
  const ref = 'refs/heads/main';
  const object = git('rev-parse', 'HEAD');
  const destination = 'https://example.invalid/owner/project.git';
  git('remote', 'add', 'origin', 'fixture:project.git');
  git('config', 'url.https://example.invalid/owner/.insteadOf', 'fixture:');
  git('config', 'credential.helper', '!false');
  git('config', 'http.followRedirects', 'true');
  vscode.workspace.workspaceFolders = [{ name: 'fixture', uri: vscode.Uri.file(repo) }];
  vscode.workspace.isTrusted = true;
  process.env[credentialEnvironment] = token;
  vscode.workspace.getConfiguration = () => ({ ...previousWorkspace.getConfiguration(), inspect: (setting: string) =>
    setting === 'gitReleaseGrants' ? { globalValue: [{ repository: repo, destination, read: [ref], push: [ref],
      credentialEnvironment, credentialUsername: 'release-bot' }] } : undefined });
  const proposal = await createDraftRunProposal({ executable: 'git', args: ['push', 'origin', ref], reason: 'Fixture HTTPS push' });
  const command = analyzeCommand(proposal.spec).gitRemote;
  const scope = await inspectDraftRunScope(proposal, 'metadata');
  assert.ok(command && scope.gitRemote);
  assert.equal(scope.gitRemote.destination, destination);
  assert.equal(scope.gitRemote.protocol, 'https');
  const intent = gitReleaseIntent('Push the current branch to origin.');
  const launch = await authorizeGitRemote(scope, command, intent);
  assert.ok(launch);
  assert.deepEqual(launch.args.slice(-3), ['--', destination, `${object}:${ref}`]);
  assert.equal(JSON.stringify(launch.args).includes(token), false);
  assert.equal(launch.env[credentialEnvironment], undefined);
  const direct = await createDraftRunProposal({ executable: 'git', args: ['push', destination, ref], reason: 'Fixture direct HTTPS push' });
  const directScope = await inspectDraftRunScope(direct, 'metadata');
  const directCommand = analyzeCommand(direct.spec).gitRemote;
  assert.ok(directCommand && directScope.gitRemote);
  assert.equal((await authorizeGitRemote(directScope, directCommand, gitReleaseIntent(`git push ${destination} ${ref}`)))?.authorization, 'task');
  const prepared = await prepareGitTransportEnvironment(launch);
  try {
    const readConfig = (...args: string[]) => execFileSync(launch.executable, ['config', ...args],
      { cwd: prepared.cwd, env: prepared.env, encoding: 'utf8', stdio: 'pipe' }).trim();
    assert.equal(readConfig('--get', 'http.followRedirects'), 'false');
    assert.equal(readConfig('--get', 'http.sslVerify'), 'true');
    assert.throws(() => readConfig('--get', 'credential.helper'));
    const header = readConfig('--get-urlmatch', 'http.extraHeader', destination);
    assert.equal(header, 'Authorization: Basic ' + Buffer.from('release-bot:' + token).toString('base64'));
    assert.throws(() => readConfig('--get-urlmatch', 'http.extraHeader', 'https://example.invalid/owner/other.git'));
  } finally { await prepared.dispose(); }
  process.env[credentialEnvironment] = 'rotated-fixture-token';
  assert.notEqual((await authorizeGitRemote(scope, command, intent))?.fingerprint, launch.fingerprint);
});
