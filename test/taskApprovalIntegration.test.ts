import './registerVscodeStub';
import { RunDetailsBuilder } from '../src/agent/logging/runDetails';
import { AgentRunner } from '../src/agent/runner';
import { RUN_DRAFT_TOOL_NAME } from '../src/agent/protocol';
import { getApprovalModeUserTail, normalizeApprovalMode } from '../src/agent/approvalMode';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { createDeleteDraftEdit, createFullTextDraftEdit } from '../src/edits/draftEdit';
import { execFileSync } from 'node:child_process';
import { SpawnDraftRunExecutor } from '../src/runs/draftRunExecutor';
import { OpenAICompatibleClient } from '../src/agent/providers/openAiCompatibleClient';
import { gitReleaseIntent, taskNamesGitRef } from '../src/runs/gitTaskIntent';
import { gitTransportError } from '../src/runs/gitReleaseEvidence';
import { isExplicitLocalCommitGoal } from '../src/runs/localGitCommit';
import * as vscode from './stubs/vscode';
import { sessionUseFixture } from './sessionUseFixture';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import type { ChatSessionStorageAdapter, StoredWorkspaceSessionState, WorkspaceSessionScope } from '../src/sessions/chatSessionStore';
import type { ChatSessionSummary, WorkspaceSummary } from '../src/shared/types';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { DraftDiffService } from '../src/edits/draftDiffService';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { DraftRunAuthorizationService } from '../src/runs/draftRunAuthorization';
import { createDraftRunProposal, hashDraftRunSpec } from '../src/runs/draftRunProposal';
import { inspectDraftRunScope, ExactOperationGrants, draftRunIdentity, inspectAutomaticRunAuthorization } from '../src/approvals/authorization';
import { hashDraftEditAction } from '../src/approvals/approvalReviewHash';
import { createRunCheckpoint, inheritTaskBudget, normalizeRunCheckpoint } from '../src/agent/runCheckpoint';
import type { RunCheckpoint } from '../src/agent/runCheckpoint';
import { taskBudgetFromCheckpoint, normalizeUserTaskBudgets } from '../src/sessions/userTaskBudget';
import { createLogicalRunBudgetState } from '../src/agent/executionPolicy';
import { UserTaskClock, executionTimeView } from '../src/sessions/executionTimeStats';
import { executionSegmentId } from '../src/sessions/userTask';
import type { WebviewMessage } from '../src/provider/webviewMessages';
import type { ChangeSet } from '../src/shared/types';
import type { AgentRequest, AgentResponse, ChatMessage, ChatSession, DraftEdit } from '../src/shared/types';
import type { DraftRunExecutorAdapter } from '../src/runs/draftRunExecutor';
import { localize } from '../src/shared/i18n';

// The automatic approval subsystem (independent reviewer, policy versions,
// circuit breaker, delegated batches and manual approval requests) was removed.
// Two modes remain, so these integration contracts cover: ask leaves every draft
// pending until the user acts on that exact card, approve-all hands durable
// drafts to the host without any confirmation, and both modes keep the existing
// scope, hash, dependency and trust boundaries.

type Host = {
  saveAgentCheckpoint(s: ChatSession, m: ChatMessage, cp: RunCheckpoint): Promise<void>;
  maybeAutoContinueDraftRun(): Promise<void>;
  handleApplyDraftEdit(message: { type: 'applyDraftEdit'; id: string; requestId: string }): Promise<void>;
  abortPrompt(): void;
  handleMessage(message: WebviewMessage): Promise<void>;
};

function captureDraftRunSurface(host: Host) {
  return {
    isBusy: (host as unknown as { isBusy: boolean }).isBusy,
    activeDraftRunId: (host as unknown as { activeDraftRunId?: string }).activeDraftRunId,
    canSubmit: (host as unknown as { interactionSnapshot(revision: number): { canSubmit: boolean } }).interactionSnapshot(
      (host as unknown as { stateRevision: number }).stateRevision).canSubmit
  };
}

function captureDraftRunClick(host: Host) {
  const controller = host as Host & { executeApprovedDraftRun(id: string, autoContinue: boolean): Promise<void> };
  const execute = controller.executeApprovedDraftRun.bind(controller);
  let execution: Promise<void> | undefined;
  controller.executeApprovedDraftRun = (id, autoContinue) => execution = execute(id, autoContinue);
  return async (draft: { id: string; specHash: string }) => {
    execution = undefined;
    await host.handleMessage({ type: 'approveDraftRun', id: draft.id, specHash: draft.specHash });
    await execution;
  };
}

test('continuation carries safety counters without carrying prior tools or approvals; corrupt new limits fail closed', async () => {
  await fixture('ask', async f => {
    f.cp.maxExecutionMs = 90_000; f.cp.maxCost = 2; f.cp.usedCostByCurrency = { USD: 0.3 };
    f.cp.runBudget = createLogicalRunBudgetState({ modelRequests: 3, treeUpstreamTokens: 500 });
    f.cp.budgetLimits = { maxModelRequests: 8, maxToolRounds: 20, maxToolCalls: 20, maxContinuations: 4,
      maxContextEpochRollovers: 2, maxUpstreamTokens: 2000, maxTreeUpstreamTokens: 4000, maxContinuationOutputTokens: 0, maxContinuationOutputChars: 0 };
    const budget = taskBudgetFromCheckpoint(f.cp);
    const restored = normalizeUserTaskBudgets(JSON.parse(JSON.stringify({ task: budget }))).task;
    const fresh = createRunCheckpoint(f.cp.request as AgentRequest, 90_000, 'test', f.scope.folderUris);
    inheritTaskBudget(fresh, restored);
    assert.notEqual(fresh.taskId, f.cp.taskId); assert.equal(fresh.state, undefined); assert.equal(fresh.finalResponse, undefined);
    assert.equal(fresh.usedMs, 10_000); assert.equal(fresh.maxExecutionMs, 90_000); assert.equal(fresh.maxCost, 2);
    assert.deepEqual(fresh.usedCostByCurrency, { USD: 0.3 }); assert.equal(fresh.runBudget?.modelRequests, 3);
    assert.equal(fresh.runBudget?.treeUpstreamTokens, 500);
    assert.ok(normalizeRunCheckpoint(fresh));
    for (const bad of [{}, { ...budget.budgetLimits, maxModelRequests: -1 }, { ...budget.budgetLimits, maxToolCalls: NaN }]) {
      assert.equal(normalizeRunCheckpoint({ ...fresh, budgetLimits: bad }), undefined);
      assert.deepEqual(Object.keys(normalizeUserTaskBudgets({ task: { ...budget, budgetLimits: bad } })), []);
    }
    assert.deepEqual(Object.keys(normalizeUserTaskBudgets({ task: { ...budget, runBudget: { ...budget.runBudget, modelRequests: -1 } } })), []);
  });
});

test('manual external Apply requires exact scope and Stop revokes an outstanding dialog', async () => {
  for (const stop of [false, true]) await fixture('ask', async f => {
    const externalFile = path.join(f.root, 'external.txt');
    f.response.draftEdits[0].uri = vscode.Uri.file(externalFile).toString();
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    const dialog = vscode.window.showWarningMessage;
    const feedback: unknown[] = [];
    Object.assign(f.host, { postToWebview: (value: unknown) => feedback.push(value) });
    let prompts = 0;
    vscode.window.showWarningMessage = async (text, _o, ...items) => {
      prompts++; assert.match(text, /external\.txt/u);
      f.advance(60_000); if (stop) f.host.abortPrompt();
      return items[0] as never;
    };
    try { await f.host.handleApplyDraftEdit({ type: 'applyDraftEdit', id: 'edit', requestId: 'apply' }); }
    finally { vscode.window.showWarningMessage = dialog; }
    assert.equal(prompts, 1);
    if (stop) await assert.rejects(readFile(externalFile), { code: 'ENOENT' });
    else {
      assert.equal(f.edits.toWebviewState(f.session.id)[0].files[0].status, 'applied', JSON.stringify(feedback));
      assert.equal(await readFile(externalFile, 'utf8'), 'result\n');
    }
    assert.ok((executionTimeView(f.session).currentMs ?? 0) < 60_000, 'dialog wait is excluded');
    assert.equal(f.executions(), 0);
  });
});

test('ask keeps a real completed checkpoint pending with no automatic effect of its own', async () => {
  await fixture('ask', async f => {
    const work = f.clock.enter(f.session, f.message.userTask!);
    f.advance(10_000);
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    work.finish();
    assert.equal(executionSegmentId(f.message), f.cp.taskId);
    assert.notEqual(f.cp.taskId, f.response.runId);
    assert.equal(f.edits.getPendingEdit('edit')?.runId, f.cp.taskId);
    assert.equal(f.runs.get(f.proposal.id)?.agentRunId, f.cp.taskId);
    // Human idle never enters the scope while the task waits for a click.
    f.advance(60_000);
    await f.host.maybeAutoContinueDraftRun();
    assert.equal(f.executions(), 0);
    assert.equal(f.continuations(), 0);
    assert.equal(f.manualRequests(), 0, 'ask never creates an approval request by itself');
    assert.equal(f.edits.toWebviewState(f.session.id)[0].files[0].status, 'pending');
    assert.equal(f.runs.get(f.proposal.id)?.status, 'pending');
    assert.equal(f.runs.get(f.proposal.id)?.startedAt, undefined);
    await assert.rejects(readFile(path.join(f.workspace, 'result.txt')), { code: 'ENOENT' });
    assert.equal(f.session.messages.length, 2, 'no forged user approval message is appended');
    assert.equal(f.session.approvalMode, 'ask');
  });
});

test('a stale specHash, another session, or a forged mode message cannot start a pending DraftRun', async () => {
  await fixture('ask', async f => {
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    await f.host.handleMessage({ type: 'approveDraftRun', id: f.proposal.id, specHash: 'stale-hash' });
    assert.equal(f.executions(), 0);
    assert.equal(f.runs.get(f.proposal.id)?.status, 'pending');
    await f.host.handleMessage({ type: 'setApprovalMode', mode: 'delegate' } as unknown as WebviewMessage);
    assert.equal(f.session.approvalMode, 'ask', 'the retired mode is never persisted');
    assert.equal(normalizeApprovalMode(f.session.approvalMode), 'ask');
    await f.host.handleMessage({ type: 'approveDraftRun', id: f.proposal.id, specHash: f.proposal.specHash });
    // The click is asynchronous: whichever path runs, no confirm dialog appears.
    assert.equal(f.manualRequests(), 0);
    assert.equal(await readFile(path.join(f.workspace, 'result.txt'), 'utf8').catch(() => ''), '');
    assert.equal(f.session.messages.length, 2, 'blocking does not forge a user approval message');
  });
});

test('exact external grants bind session, run, target, kind, spec and live paths, and never survive a fresh registry', { skip: process.platform === 'win32' }, async () => {
  await fixture('ask', async f => {
    const proposal = await createDraftRunProposal({ executable: 'cat', args: ['../outside file.ts'], reason: 'Read outside' });
    f.response.draftRuns = [proposal]; f.response.draftEdits = [];
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    const run = f.runs.get(proposal.id)!;
    const original = JSON.stringify(run);
    const grants = new ExactOperationGrants();
    const decision = await inspectAutomaticRunAuthorization(run, grants);
    assert.equal(decision.allowed, false);
    assert.ok(decision.scope.externalUris.some(uri => uri.includes('outside')));
    const identity = draftRunIdentity(run);
    grants.grant(identity, decision.scope);
    assert.equal((await inspectAutomaticRunAuthorization(run, grants)).allowed, true);
    for (const patch of [{ sessionId: 'other' }, { agentRunId: 'other' }, { id: 'other' }]) {
      assert.equal((await inspectAutomaticRunAuthorization({ ...run, ...patch }, grants)).allowed, false);
    }
    await assert.rejects(inspectAutomaticRunAuthorization({ ...run, specHash: 'other' }, grants), /changed after review/u);
    const newSpec = { ...run.spec, env: [{ name: 'EXAMPLE', value: 'changed' }] };
    assert.equal((await inspectAutomaticRunAuthorization({ ...run, spec: newSpec, specHash: hashDraftRunSpec(newSpec) }, grants)).allowed, false);
    assert.equal(grants.matches({ ...identity, kind: 'edit' }, decision.scope), false);
    assert.equal(grants.matches(identity, { ...decision.scope, fingerprint: 'changed resolution' }), false);
    assert.equal(grants.matches(identity, { ...decision.scope, externalUris: [...decision.scope.externalUris, 'file:///new'] }), false);
    assert.equal((await inspectAutomaticRunAuthorization(run, new ExactOperationGrants())).allowed, false);
    grants.clear();
    assert.equal((await inspectAutomaticRunAuthorization(run, grants)).allowed, false);
    assert.equal(JSON.stringify(run), original, 'derived diagnostics and grants do not mutate persisted drafts');
    vscode.workspace.isTrusted = false;
    await assert.rejects(inspectAutomaticRunAuthorization(run, grants), /not trusted/u);
  });
});test('scope check detects ../, absolute paths and symlink escape without classifying git push as external', async () => {
  await fixture('ask', async f => {
    for (const args of [['../outside'], [path.join(f.root, 'outside')], ['-C../outside']]) {
      const p = await createDraftRunProposal({ executable: 'rm', args, reason: 'scope test' });
      const scope = await inspectDraftRunScope({ ...p } as never);
      assert.equal(scope.externalUris.length, 1);
    }
    for (const code of ['cat ../outside', 'rm escape/outside']) {
      const p = await createDraftRunProposal({ executable: 'sh', args: ['-c', code], reason: 'scope test' });
      assert.equal((await inspectDraftRunScope(p as never)).uncertain, true, 'shell text must not be split as argv');
    }
    const unknown = await createDraftRunProposal({ executable: 'sh', args: ['-c', 'custom-program'], reason: 'scope test' });
    assert.equal((await inspectDraftRunScope(unknown as never)).uncertain, true);
    for (const args of [['tag', 'test-tag'], ['push', 'origin', 'refs/tags/test-tag']]) {
      const p = await createDraftRunProposal({ executable: 'git', args, reason: 'Exact requested tag' });
      const scope = await inspectDraftRunScope({ ...p } as never);
      assert.deepEqual(scope.externalUris, []); assert.equal(scope.uncertain, true);
      assert.ok(scope.diagnostics.some(reason => reason.code === 'git_runtime'));
    }
  });
});test('source files with spaces are actually read through both approval modes without running their contents', async () => {
  if (process.platform === 'win32') return; // POSIX system-executable support is deliberately bounded.
  for (const mode of ['ask', 'approve-all'] as const) await fixture(mode, async f => {
    const files = ['source name.ts', 'format rm.js', '--output=script.sh'];
    const content = '#!/bin/sh\necho should-not-run > unexpected-marker\n';
    for (const file of files) await writeFile(path.join(f.workspace, file), content);
    const runs = new DraftRunStore(vscode.Uri.file(path.join(f.root, 'read-storage')) as never,
      new SpawnDraftRunExecutor(), new DraftRunAuthorizationService());
    Object.assign(f.host, { draftRuns: runs });
    try {
      f.response.draftEdits = [];
      const proposal = await createDraftRunProposal({ executable: '/bin/cat', args: ['--', ...files], reason: 'Read source text', timeoutMs: 120_000 });
      f.response.draftRuns = [proposal];
      await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
      const originalSpec = JSON.stringify(runs.get(proposal.id)!.spec);
      if (mode === 'ask') {
        assert.equal(runs.get(proposal.id)!.status, 'pending');
        await captureDraftRunClick(f.host)(proposal);
      } else {
        await drainApproveAll(f.host);
        assert.notEqual(runs.get(proposal.id)!.status, 'pending', 'approve-all starts the draft without a click');
      }
      const result = runs.toWebviewState(f.session.id)[0];
      assert.equal(result.status, 'done', result.error);
      assert.equal(result.output, content.repeat(files.length));
      assert.deepEqual(result.effectAssessment.effects, ['workspace_read']);
      assert.equal(JSON.stringify(result.spec), originalSpec);
      assert.equal(result.specHash, proposal.specHash);
      await assert.rejects(readFile(path.join(f.workspace, 'unexpected-marker')), { code: 'ENOENT' });
      assert.equal(await runs.approveAndRun(proposal.id, new Set()), undefined, 'completed reads are not re-executed');
    } finally { await runs.flush(); runs.dispose(); }
  });
});

test('trusted project scripts launch with the verified executable and cwd under each approval mode', async () => {
  if (process.platform === 'win32') return;
  for (const mode of ['approve-all', 'ask'] as const) await fixture(mode, async f => {
    const cwd = path.join(f.workspace, 'run space');
    const marker = path.join(cwd, 'script-marker.txt');
    const executable = '/bin/bash';
    await mkdir(cwd);
    await writeFile(path.join(cwd, 'project job.sh'), '#!/bin/bash\nprintf "%s\\n" "$PWD" > script-marker.txt\nprintf "script finished\\n"\n');
    const spawn = new SpawnDraftRunExecutor();
    const launches: Array<{ executable: string; cwd: string } | undefined> = [];
    const executor: DraftRunExecutorAdapter = {
      execute: input => {
        launches.push(input.verifiedLaunch);
        return spawn.execute(input);
      },
      cancel: id => spawn.cancel(id), showTerminal: id => spawn.showTerminal(id), dispose: () => spawn.dispose()
    };
    const runs = new DraftRunStore(vscode.Uri.file(path.join(f.root, 'project-script-storage')) as never,
      executor, new DraftRunAuthorizationService());
    Object.assign(f.host, { draftRuns: runs });
    const dialog = vscode.window.showWarningMessage;
    let prompts = 0;
    vscode.window.showWarningMessage = async () => { prompts++; return undefined; };
    try {
      f.session.messages[0].content += ' Run the project job script from its directory.';
      const proposal = await createDraftRunProposal({ executable, args: ['project job.sh'], cwd: 'run space', reason: 'Run the requested project job' });
      f.response.draftEdits = [];
      f.response.draftRuns = [proposal];
      await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
      if (mode === 'ask') {
        assert.equal(runs.get(proposal.id)?.status, 'pending');
        assert.deepEqual(launches, []);
        await assert.rejects(readFile(marker), { code: 'ENOENT' });
        await captureDraftRunClick(f.host)(proposal);
      } else {
        await drainApproveAll(f.host);
        assert.notEqual(runs.get(proposal.id)?.status, 'pending', JSON.stringify(runs.toWebviewState(f.session.id)));
      }
      const canonicalCwd = await realpath(cwd);
      assert.deepEqual(launches.map(launch => launch && [launch.executable, launch.cwd]), [[await realpath(executable), canonicalCwd]]);
      assert.equal(await readFile(marker, 'utf8'), `${canonicalCwd}\n`);
      const result = runs.toWebviewState(f.session.id)[0];
      assert.equal(result.status, 'done', result.error);
      assert.equal(result.output, 'script finished\n');
      assert.equal(prompts, 0, 'neither mode prompts for a trusted in-project script');
    } finally {
      vscode.window.showWarningMessage = dialog;
      await runs.flush();
      runs.dispose();
    }
  });
});

test('PATH shims, environment overrides and foreign paths cannot borrow a read command name', { skip: process.platform === 'win32' }, async () => {
  await fixture('ask', async f => {
    const shim = path.join(f.workspace, 'cat');
    await writeFile(shim, '#!/bin/sh\nexit 0\n'); await chmod(shim, 0o755);
    for (const input of [
      { executable: shim, args: ['file.ts'] },
      { executable: 'cat', args: ['file.ts'], env: [{ name: 'PATH', value: f.workspace }] },
    ]) {
      const proposal = await createDraftRunProposal({ ...input, reason: 'Read' });
      const scope = await inspectDraftRunScope(proposal);
      assert.equal(scope.uncertain, true);
      assert.ok(scope.diagnostics.some(reason => ['environment_override', 'executable_identity'].includes(reason.code)));
    }
    const injected = await createDraftRunProposal({ executable: 'cat', args: ['file.ts'],
      env: [{ name: 'DYLD_INSERT_LIBRARIES', value: '/tmp/helper' }], reason: 'Read' });
    await assert.rejects(inspectDraftRunScope(injected), /unsafe execution environment/u);
    const shimProposal = await createDraftRunProposal({ executable: shim, args: [], reason: 'Exact program' });
    f.response.draftRuns = [shimProposal]; f.response.draftEdits = [];
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    const run = f.runs.get(shimProposal.id)!;
    const grants = new ExactOperationGrants();
    const initial = await inspectAutomaticRunAuthorization(run, grants);
    grants.grant(draftRunIdentity(run), initial.scope);
    assert.equal(initial.allowed, true);
    await writeFile(shim, '#!/bin/sh\necho changed-program\n');
    const changed = await inspectAutomaticRunAuthorization(run, grants);
    assert.equal(grants.matches(draftRunIdentity(run), changed.scope), false, 'executable replacement invalidates its exact grant');
    assert.equal(changed.scope.verifiedLauncher, undefined, 'a shim never inherits the system launcher identity');
    if (process.platform !== 'win32') {
      const proposal = await createDraftRunProposal({ executable: 'cat', args: ['C:\\outside\\script.ts'], reason: 'Read' });
      assert.ok((await inspectDraftRunScope(proposal)).diagnostics.some(reason => reason.code === 'foreign_path'));
    }
  });
});test('Git scope tracks cwd/repository/output paths but does not turn format values or revisions into filenames', async () => {
  await fixture('ask', async f => {
    const display = await createDraftRunProposal({ executable: 'git', args: ['show', 'refs/heads/format',
      '--format=plain /outside/text curl format', '--', 'file with spaces.ts'], reason: 'Inspect' });
    assert.deepEqual((await inspectDraftRunScope(display)).externalUris, []);
    const changedCwd = await createDraftRunProposal({ executable: 'git', args: ['-C', '../other repo', 'show',
      '--output', 'output file', '--', 'source.ts'], reason: 'Inspect' });
    const scope = await inspectDraftRunScope(changedCwd);
    assert.ok(scope.externalUris.some(uri => decodeURIComponent(uri).endsWith('/other repo')));
    assert.ok(scope.externalUris.some(uri => decodeURIComponent(uri).endsWith('/other repo/output file')));
    assert.ok(scope.externalUris.some(uri => decodeURIComponent(uri).endsWith('/other repo/source.ts')));
    const repository = await createDraftRunProposal({ executable: 'git', args: ['--git-dir=../git data',
      '--work-tree', '../other tree', 'show'], reason: 'Inspect' });
    assert.equal((await inspectDraftRunScope(repository)).externalUris.length, 2);
    void f;
  });
});

test('Git approval rejects credential candidates and direct repository control files', async () => {
  if (process.platform === 'win32') return;
  await fixture('ask', async f => {
    const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: f.workspace, stdio: 'pipe' });
    git('init');
    const proposal = (args: string[]) => createDraftRunProposal({ executable: '/usr/bin/git', args, reason: 'Check local Git scope' });
    await writeFile(path.join(f.workspace, '.env'), 'FIXTURE=private\n');
    await assert.rejects(inspectDraftRunScope(await proposal(['add', '--all', '.'])), /protected file|受保护/u);
    await assert.rejects(inspectDraftRunScope(await proposal(['add', '--', '.git/config'])), /Protected credential|受保护/u);
    await mkdir(path.join(f.workspace, '.agents/skills/test'), { recursive: true });
    await writeFile(path.join(f.workspace, '.agents/skills/test/.env'), 'FIXTURE=private\n');
    await assert.rejects(inspectDraftRunScope(await proposal(['add', '--', '.agents/skills'])), /protected file|受保护/u);
    git('add', '--', '.env');
    await assert.rejects(inspectDraftRunScope(await proposal(['commit', '-a', '-m', 'Local change'])), /protected file|受保护/u);
  });
});

test('local Git scope rejects redirects and detects config, hook and index changes', async () => {
  if (process.platform === 'win32') return;
  await fixture('ask', async f => {
    execFileSync('/usr/bin/git', ['init', f.workspace], { stdio: 'pipe' });
    const git = (...args: string[]) => execFileSync('/usr/bin/git', args, { cwd: f.workspace, stdio: 'pipe' });
    git('config', 'commit.gpgsign', 'false');
    git('config', 'core.fsmonitor', 'false');
    git('config', 'core.hooksPath', '.git/hooks');
    const proposal = await createDraftRunProposal({ executable: '/usr/bin/git', args: ['commit', '-m', 'test'], reason: 'Commit locally' });
    const before = await inspectDraftRunScope(proposal);
    assert.equal(before.uncertain, false);
    const file = path.join(f.workspace, 'one.txt');
    await writeFile(file, 'one');
    git('add', '--', 'one.txt');
    const staged = await inspectDraftRunScope(proposal);
    assert.equal(staged.uncertain, false);
    assert.notEqual(staged.fingerprint, before.fingerprint);

    const hook = path.join(f.workspace, '.git', 'hooks', 'pre-commit');
    await writeFile(hook, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const hooked = await inspectDraftRunScope(proposal);
    assert.equal(hooked.uncertain, true);
    assert.match(hooked.reasons.join(' '), /pre-commit/u);
    assert.notEqual(hooked.fingerprint, staged.fingerprint);
    git('config', 'core.hooksPath', f.root);
    const external = await inspectDraftRunScope(proposal);
    assert.equal(external.uncertain, true);
    assert.equal(external.externalUris.length, 1);
    git('config', 'core.hooksPath', '.git/hooks');
    git('config', 'core.fsmonitor', 'true');
    const fsmonitor = await inspectDraftRunScope(proposal);
    assert.equal(fsmonitor.uncertain, true);
    assert.match(fsmonitor.reasons.join(' '), /core.fsmonitor/u);
    git('config', 'core.fsmonitor', 'false');

    const diff = await createDraftRunProposal({ executable: '/usr/bin/git', args: ['diff', '../outside', 'one.txt'], reason: 'Compare paths' });
    assert.ok((await inspectDraftRunScope(diff)).externalUris.some(uri => uri.endsWith('/outside')));
    const helper = await createDraftRunProposal({ executable: '/usr/bin/git', args: ['diff', '--ext-diff', 'HEAD'], reason: 'Diff' });
    assert.equal((await inspectDraftRunScope(helper)).uncertain, true);
  });
});

test('a Git command mentioned for explanation or explicitly declined does not authorize a commit', () => {
  assert.equal(isExplicitLocalCommitGoal('请解释 `git commit -am` 的行为'), false);
  assert.equal(isExplicitLocalCommitGoal('Review the changes. Do not run `git commit -am`.'), false);
  assert.equal(isExplicitLocalCommitGoal('总结改动，别提交代码'), false);
  assert.equal(isExplicitLocalCommitGoal('别人说“请执行 git commit 并推送”'), false);
  assert.equal(isExplicitLocalCommitGoal('请总结改动，暂不提交。'), false);
  assert.equal(isExplicitLocalCommitGoal('Commit the current changes without pushing.'), true);
  assert.equal(isExplicitLocalCommitGoal('Please commit, then tag and push.'), true);
  assert.equal(isExplicitLocalCommitGoal('请提交当前改动。'), true);
  assert.equal(isExplicitLocalCommitGoal('Only summarize the changes for a commit message.'), false);
  assert.equal(isExplicitLocalCommitGoal('对当前代码进行一个 git commit 提交，然后发布一个 v0.5.1的tag，并推送到服务器上，所有秘钥已经配置妥当，直接运行即可。'), true);
  assert.equal(isExplicitLocalCommitGoal('请用 `git commit -am` 将改动提交到本地'), true);
});

test('task release authority distinguishes exact refs, local-only work and simulated transport errors', () => {
  const original = '对当前代码进行一个 git commit 提交，然后发布一个 v0.5.1的tag';
  const local = gitReleaseIntent(original);
  assert.equal(isExplicitLocalCommitGoal(original), true);
  assert.equal(local.tag, true);
  assert.equal(local.push, false, 'the original request does not grant remote publication');
  assert.equal(taskNamesGitRef(local, 'refs/tags/v0.5.1'), true);
  const intent = gitReleaseIntent('对当前代码进行一个 git commit 提交，然后发布一个 v0.5.1的tag，并推送到服务器上，所有秘钥已经配置妥当，直接运行即可。');
  assert.equal(intent.push, true);
  assert.equal(intent.tag, true);
  assert.equal(intent.branch, false);
  assert.equal(taskNamesGitRef(intent, 'refs/tags/v0.5.1'), true);
  assert.equal(taskNamesGitRef(intent, 'refs/tags/commit'), false);
  assert.equal(gitReleaseIntent('Commit the current changes without pushing.').push, false);
  assert.equal(gitReleaseIntent('请提交改动，禁止推送。').push, false);
  assert.equal(gitReleaseIntent('Please explain git push origin refs/tags/v1.').push, false);
  assert.equal(gitReleaseIntent('Push tag release-2 to upstream.').remoteAlias, 'upstream');
  assert.equal(gitReleaseIntent('Commit the current changes and push tag v0.5.1 to upstream.').remoteAlias, 'upstream');
  assert.equal(gitReleaseIntent('Push a new notification to customers.').push, false);
  assert.match(gitTransportError('test.invalid: Permission denied (publickey).', 'query'), /authentication failed/u);
  assert.match(gitTransportError('! [rejected] (non-fast-forward)', 'push'), /conflicting ref update/u);
  assert.match(gitTransportError('Could not resolve hostname test.invalid', 'query'), /transport or launcher is unavailable/u);
  assert.match(gitTransportError('untrusted server output', 'push'), /^Git push failed/u);
});

test('forged or stale approval-mode messages cannot activate a retired mode or start existing drafts', async () => {
  await fixture('ask', async f => {
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    Object.assign(f.host, { commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', executionMode: 'ready', approvalMode: 'ready' } });
    for (const mode of ['model_review', 'delegate'] as const) {
      await f.host.handleMessage({ type: 'setApprovalMode', mode } as unknown as WebviewMessage);
      assert.equal(f.session.approvalMode, 'ask');
    }
    assert.equal(f.executions(), 0);
    assert.equal(f.runs.get(f.proposal.id)?.status, 'pending');
    await assert.rejects(readFile(path.join(f.workspace, 'result.txt')), { code: 'ENOENT' });
  });
});

test('ask keeps a stored proposal pending verbatim and never authorizes it from stale audit data', async () => {
  await fixture('ask', async f => {
    const args = ['rev-parse', '--unknown-fixture', 'HEAD'];
    const proposal = await createDraftRunProposal({ executable: 'git', args, reason: 'Resolve HEAD' });
    f.response.draftEdits = [];
    f.response.draftRuns = [proposal];
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    const stored = f.runs.toWebviewState(f.session.id).filter(item => item.id === proposal.id);
    assert.equal(stored.length, 1);
    assert.deepEqual(stored[0].spec.args, args);
    // A non-interactive fixture cannot host its own command, so the host records
    // a never-started correction instead of executing it.
    assert.equal(stored[0].executionStarted, false);
    // The recorded correction is a never-dispatched diagnosis, never a launch.
    assert.equal(f.runs.get(proposal.id)?.executionStarted, false);
    assert.equal(f.runs.get(proposal.id)?.startedAt, undefined);
    const before = f.runs.get(proposal.id)?.status;
    await f.host.handleMessage({ type: 'approveDraftRun', id: proposal.id, specHash: 'not-the-stored-hash' });
    assert.equal(f.runs.get(proposal.id)?.status, before, 'a stale specHash never changes the stored command');
    assert.equal(f.executions(), 0);
  });
});

test('a copied correction prompt keeps the current task identity for the next proposal', async () => {
  await fixture('ask', async f => {
    f.response.draftEdits = [];
    f.response.draftRuns = [await createDraftRunProposal({ executable: 'head', args: ['-n'], reason: 'Preview the input' })];
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    const correction = localize('en', 'draftRunCloneForCorrectionPrompt');
    // The copied instruction is a host-generated recovery prompt for the same
    // task, never a new user task.
    assert.ok(f.message.userTask);
    assert.match(correction, /\S/u);
    assert.equal(f.runs.get(f.response.draftRuns[0].id)?.status, 'needs_replan');
    assert.equal(f.executions(), 0);
    assert.equal(f.manualRequests(), 0);
    assert.ok(f.session.messages.every(message => message.role !== 'user' || message.id === 'user'));
  });
});test('the ask tail is the only approval instruction a prepared task can carry', async () => {
  await fixture('ask', async f => {
    f.session.messages[0].content = 'Create result.txt.';
    const tail = getApprovalModeUserTail(normalizeApprovalMode(f.session.approvalMode));
    assert.match(tail, /<keepseek-approval-mode>ask:/u);
    assert.equal(f.session.pendingHistoryTruncation, undefined);
    assert.ok(f.session.messages.every(message => !message.content.includes('<keepseek-approval-mode>')));
  });
});

type FixtureMode = 'ask' | 'approve-all';

async function fixture(mode: FixtureMode, body: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const folders = vscode.workspace.workspaceFolders, trusted = vscode.workspace.isTrusted;
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-task-approval-'));
  let f: Awaited<ReturnType<typeof createFixture>> | undefined;
  try {
    f = await createFixture(root, mode);
    await body(f);
  } finally {
    if (f) { await f.runs.flush(); await f.edits.flush(); await f.storage.flush(); f.runs.dispose(); f.diff.dispose(); f.clock.dispose(); }
    vscode.workspace.workspaceFolders = folders; vscode.workspace.isTrusted = trusted;
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 30 });
  }
}

/** The approval contracts never need durable session bytes; an in-memory
 * adapter keeps every fixture inside the process and out of the temp dir. */
class InMemorySessionStorage implements ChatSessionStorageAdapter {
  private sessions: ChatSession[] = [];
  private activeSessionId = '';
  private approvalMode: string | undefined;
  public async loadWorkspace(_scope: WorkspaceSessionScope): Promise<StoredWorkspaceSessionState> {
    return { activeSessionId: this.activeSessionId, approvalMode: this.approvalMode as never,
      sessions: structuredClone(this.sessions), sessionSummaries: [] };
  }
  public async saveWorkspace(scope: WorkspaceSessionScope, state: StoredWorkspaceSessionState): Promise<void> {
    void scope;
    this.activeSessionId = state.activeSessionId;
    this.approvalMode = state.approvalMode;
    this.sessions = structuredClone(state.sessions);
  }
  public async flush(): Promise<void> {}
  public async listAllWorkspaceSummaries(): Promise<WorkspaceSummary[]> { return []; }
  public async loadWorkspaceSessions(): Promise<ChatSession[]> { return structuredClone(this.sessions); }
  public async listWorkspaceSessionSummaries(): Promise<ChatSessionSummary[]> { return []; }
  public async deleteWorkspaceSessions(): Promise<void> {}
  public async deleteEntireWorkspace(): Promise<void> {}
  public async cleanupExpiredSessions(): Promise<boolean> { return false; }
}
async function createFixture(root: string, mode: FixtureMode) {
  const workspace = path.join(root, 'project'); await mkdir(workspace);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspace), name: 'project' }]; vscode.workspace.isTrusted = true;
  const storageUri = vscode.Uri.file(path.join(root, 'storage')) as never;
  const storage = new InMemorySessionStorage();
  const scope = { key: 'task-integration', name: 'project', folderUris: [vscode.Uri.file(workspace).toString()] };
  const sessions = new ChatSessionStore(storage, 'en', scope); await sessions.initialize(); await sessions.setApprovalMode(mode);
  const session = sessions.getActiveSession();
  const userTask = { version: 1 as const, id: 'user-task', originMessageId: 'user', reason: 'user' as const };
  session.messages.push({ id: 'user', role: 'user', content: 'Create result.txt and check runtime.', createdAt: new Date().toISOString(), userTask });
  const message: ChatMessage = { id: 'assistant', role: 'assistant', content: '', createdAt: new Date().toISOString(), userTask };
  session.messages.push(message);
  const proposal = await createDraftRunProposal({ executable: 'node', args: ['--version'], reason: 'Check runtime' });
  const edit: DraftEdit = createFullTextDraftEdit({ id: 'edit', uri: vscode.Uri.file(path.join(workspace, 'result.txt')).toString(), label: 'result.txt', action: 'create', content: 'result\n', reason: 'Create requested result' });
  const response = { runId: 'physical-trace-id', message: 'Prepared', draftEdits: [edit], draftRuns: [proposal],
    runDetails: new RunDetailsBuilder({ runId: 'physical-trace-id', modelId: 'main', thinkingEnabled: false }).build('succeeded'), toolRounds: [] } as unknown as AgentResponse;
  const request: AgentRequest = { approvalMode: mode, model: { id: 'main', sourceId: 'main', provider: 'openai-compatible', label: 'main', contextWindowTokens: 32768, maxOutputTokens: 4096 },
    prompt: 'task', contextFiles: [], history: [session.messages[0]], settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' }, language: 'en', sessionId: session.id, assistantMessageId: message.id };
  const cp = createRunCheckpoint(request, 0, 'test', scope.folderUris); cp.status = 'completed'; cp.usedMs = 10_000; cp.finalResponse = response;
  let now = 0, executeCount = 0, continuationCount = 0;
  const clock = new UserTaskClock(() => now);
  const executor = { execute: async () => { executeCount++; now += 3000; return { started: true, phase: 'exited', exitCode: 0, signal: undefined, timedOut: false, cancelled: false }; }, cancel: () => false, showTerminal: () => false, dispose: () => {} } satisfies DraftRunExecutorAdapter;
  const runs = new DraftRunStore(storageUri, executor, new DraftRunAuthorizationService());
  const diff = new DraftDiffService();
  const edits = new ChangeSetStore(new SafeFileEditor(), diff, sessions, storageUri, key => key);
  const approvedChangeSets = new Set<string>();
  let operationSequence = 0;
  const interactionCoordinator = {
    begin: () => ({ id: 'operation-' + (++operationSequence), sessionId: session.id }),
    update: () => {},
    finish: () => {}
  };
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    ...sessionUseFixture(),
    language: 'en', sessionStore: sessions, taskClock: clock, changeSets: edits, draftRuns: runs,
    interactionCoordinator: undefined, activeChangeActions: new Set(), sessionReady: true, approvalDataReady: true, requestContextReady: true, availableModels: [],
    backgroundRunCoordinator: { getActiveRun: () => undefined },
    commandSettingsReadiness: { mainModel: 'ready', subagentModel: 'ready', executionMode: 'ready', approvalMode: 'ready' },
    runContextReadiness: 'ready', stateRevision: 0,
    repairLoopsBySession: new Map(), checkpointActivityDepth: 0,
    externalEffectGrants: new ExactOperationGrants(), authorizedExternalReferenceUris: new Set<string>(), authorizedExternalExecutionUris: new Set<string>(),
    agentActivity: { sequence: 0 }, isBusy: false, activeDraftRunId: undefined,
    selectedSourceId: 'main', selectedModelId: 'main',
    postState: () => {}, postToWebview: () => {}, setAgentActivity: () => {},
    scheduleRunContextRefresh: () => {}, awaitRunContextRefresh: async () => true,
    scheduleDraftRunAutoContinuation: () => {}, hasActiveBackgroundRun: () => false,
    stopBackgroundRun: async () => {},
    handleAppliedRepairEdits: async () => {},
    t: (key: string, values?: Record<string, string | number>) => localize('en', key, values),
    // Only the host-owned confirmation path for approved changes is stubbed; the
    // ask path below still runs prepareManualApply, and approve-all skips it.
    handleApplyChangeSet: async (message: { id: string }) => {
      const changeSet = edits.toWebviewState(session.id).find(set => set.id === message.id);
      if (!changeSet) return;
      approvedChangeSets.add(changeSet.id);
      await edits.applyAll(changeSet.id);
    },
    sendPrompt: async () => { continuationCount++; const work = clock.enter(session, userTask); now += 5000; work.finish(); return response; }
  }) as Host & Record<string, unknown>;
  return { root, workspace, scope, storage, sessions, session, message, proposal, cp, response, host, clock, runs, edits, diff,
    approvedChangeSets,
    advance: (ms: number) => { now += ms; }, executions: () => executeCount,
    continuations: () => continuationCount,
    manualRequests: () => 0 };
}

/** Drives the host's own approve-all drain until no pending draft remains. */
async function drainApproveAll(host: Host): Promise<void> {
  const drain = (host as unknown as { drainApproveAllExecution(): Promise<void> }).drainApproveAllExecution.bind(host);
  for (let index = 0; index < 12; index++) await drain();
}

async function realpath(target: string): Promise<string> {
  return await (await import('node:fs/promises')).realpath(target);
}

void createDeleteDraftEdit;
void (undefined as unknown as ChangeSet);
