import './registerVscodeStub';
import { RunDetailsBuilder } from '../src/agent/logging/runDetails';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, symlink } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { SpawnDraftRunExecutor } from '../src/runs/draftRunExecutor';
import * as vscode from './stubs/vscode';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { DraftDiffService } from '../src/edits/draftDiffService';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { DraftRunAuthorizationService } from '../src/runs/draftRunAuthorization';
import { createDraftRunProposal, hashDraftRunSpec } from '../src/runs/draftRunProposal';
import { inspectDraftRunScope } from '../src/runs/draftRunScope';
import { ApprovalReviewStore } from '../src/approvals/approvalReviewStore';
import { ApprovalReviewerService } from '../src/approvals/approvalReviewer';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { SubagentSettingsStore } from '../src/accounts/subagentSettingsStore';
import { DelegatedApprovalQueue } from '../src/agent/approvalMode';
import { createRunCheckpoint, inheritTaskBudget, normalizeRunCheckpoint } from '../src/agent/runCheckpoint';
import { taskBudgetFromCheckpoint, normalizeUserTaskBudgets } from '../src/sessions/userTaskBudget';
import { createLogicalRunBudgetState } from '../src/agent/executionPolicy';
import { UserTaskClock, executionTimeView } from '../src/sessions/executionTimeStats';
import { executionSegmentId } from '../src/sessions/userTask';
import type { AgentRequest, AgentResponse, ChatMessage, ChatSession, DraftEdit } from '../src/shared/types';
import type { RunCheckpoint } from '../src/agent/runCheckpoint';
import type { DraftRunExecutorAdapter } from '../src/runs/draftRunExecutor';

type Host = {
  saveAgentCheckpoint(s: ChatSession, m: ChatMessage, cp: RunCheckpoint): Promise<void>;
  queueResponseApprovals(s: ChatSession, m: ChatMessage, r: AgentResponse): void;
  executeDelegatedApprovals(next: NonNullable<ReturnType<DelegatedApprovalQueue['take']>>): Promise<void>;
  resumeApprovalProcessing(id?: string): Promise<void>;
  handleApplyDraftEdit(message: { type: 'applyDraftEdit'; id: string; requestId: string }): Promise<void>;
  abortPrompt(): void;
};

test('continuation carries safety counters without carrying prior tools or approvals; corrupt new limits fail closed', async () => {
  await fixture('delegate', async f => {
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

for (const mode of ['delegate', 'model_review'] as const) test(`real persisted completed checkpoint -> ${mode} -> edit + command exactly once`, async () => {
  await fixture(mode, async f => {
    const work = f.clock.enter(f.session, f.message.userTask!);
    f.advance(10_000);
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    work.finish();
    assert.equal(f.message.runCheckpoint, undefined, 'real drainPersistence releases completed checkpoint');
    assert.equal(executionSegmentId(f.message), f.cp.taskId);
    assert.notEqual(f.cp.taskId, f.response.runId);
    assert.equal(f.edits.getPendingEdit('edit')?.runId, f.cp.taskId);
    assert.equal(f.runs.get(f.proposal.id)?.agentRunId, f.cp.taskId);
    // Human idle never enters a scope, even though the task is pending.
    f.advance(60_000);
    f.host.queueResponseApprovals(f.session, f.message, f.response);
    await f.host.executeDelegatedApprovals(f.queue.take(f.session.id)!);
    assert.equal(f.session.approvalProcessing?.targets[0].status, 'executed', JSON.stringify(f.session.approvalProcessing));
    assert.equal(await readFile(path.join(f.workspace, 'result.txt'), 'utf8'), 'result\n');
    assert.equal(f.executions(), 1, JSON.stringify(f.session.approvalProcessing));
    assert.equal(f.reviews(), mode === 'model_review' ? 2 : 0);
    assert.equal(f.continuations(), 1);
    assert.equal(f.session.approvalProcessing?.status, 'completed');
    // 10 model + 2 reviewer (two targets, 1s each) + 3 command + 5 next model.
    assert.equal(executionTimeView(f.session).currentMs, mode === 'model_review' ? 20_000 : 18_000);
    assert.equal(executionTimeView(f.session).totalMs, mode === 'model_review' ? 20_000 : 18_000);
    const records = f.session.messages.flatMap(m => m.runDetails?.approvalReviews ?? []);
    assert.equal(records.length, 2);
    assert.ok(records.every(r => r.agentRunId === f.cp.taskId));
    if (mode === 'model_review') assert.ok(records.every(r => r.reviewerModelId === 'fixed-reviewer'));
    else assert.ok(records.every(r => r.approvalSource === 'host_policy'));
    const restoredCheckpoint = await (f.host as unknown as { sessionStore: ChatSessionStore }).sessionStore.getTaskCheckpoint(f.message.id);
    assert.equal(restoredCheckpoint?.taskId, f.cp.taskId);
    const reloaded = new ChatSessionStore(f.storage, 'en', f.scope);
    await reloaded.initialize();
    assert.equal(executionTimeView(reloaded.getActiveSession()).totalMs, executionTimeView(f.session).totalMs);
    assert.equal(new DelegatedApprovalQueue().take(f.session.id), undefined, 'load does not execute pending drafts');
    // Duplicate delivery is safe: real stores return saved results, not effects.
    f.host.queueResponseApprovals(f.session, f.message, f.response);
    await f.host.executeDelegatedApprovals(f.queue.take(f.session.id)!);
    assert.equal(f.executions(), 1, JSON.stringify(f.session.approvalProcessing));
    assert.equal(f.reviews(), mode === 'model_review' ? 2 : 0);
    assert.equal(f.continuations(), 1);
  });
});

test('persisted archive with wrong logical identity blocks all effects and never continues', async () => {
  await fixture('delegate', async f => {
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    f.queue.enqueue({ sessionId: f.session.id, runId: f.response.runId, editIds: ['edit'], draftRunIds: [f.proposal.id] });
    await f.host.executeDelegatedApprovals(f.queue.take(f.session.id)!);
    assert.equal(f.executions(), 0); assert.equal(f.continuations(), 0);
    assert.equal(f.session.approvalProcessing?.targets[0].status, 'identity_mismatch');
    assert.equal(f.runs.get(f.proposal.id)?.status, 'pending');
    assert.equal(f.session.messages.length, 2, 'blocking does not forge a user approval message');
  });
});

test('missing target and denied reviewer both stop dependent commands without empty continuation', async () => {
  await fixture('delegate', async f => {
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    f.queue.enqueue({ sessionId: f.session.id, runId: f.cp.taskId, editIds: ['missing'], draftRunIds: [f.proposal.id] });
    await f.host.executeDelegatedApprovals(f.queue.take(f.session.id)!);
    assert.equal(f.session.approvalProcessing?.targets[0].status, 'missing');
    assert.equal(f.executions(), 0); assert.equal(f.continuations(), 0);
  });
  await fixture('model_review', async f => {
    f.deny();
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    f.host.queueResponseApprovals(f.session, f.message, f.response);
    await f.host.executeDelegatedApprovals(f.queue.take(f.session.id)!);
    assert.equal(f.session.approvalProcessing?.targets[0].status, 'denied');
    assert.equal(f.executions(), 0); assert.equal(f.continuations(), 0);
    assert.equal(f.reviews(), 1);
  });
});

test('read reference does not grant external execution; exact explicit scope resumes normal approval', async () => {
  await fixture('delegate', async f => {
    const external = await createDraftRunProposal({ executable: 'node', args: ['--version'], cwd: f.root, reason: 'Check runtime' });
    // Persist a legacy URI spelling. On macOS the proposal factory now uses
    // /private/var, whereas existing drafts may retain /var.
    external.spec.cwdUri = vscode.Uri.file(f.root).toString();
    external.specHash = hashDraftRunSpec(external.spec);
    f.cp.finalResponse!.draftRuns = [external]; f.cp.finalResponse!.draftEdits = [];
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    (f.host as unknown as { authorizedExternalReferenceUris: Set<string> }).authorizedExternalReferenceUris.add(external.spec.cwdUri);
    f.host.queueResponseApprovals(f.session, f.message, f.response);
    await f.host.executeDelegatedApprovals(f.queue.take(f.session.id)!);
    assert.equal(f.executions(), 0); assert.equal(f.continuations(), 0);
    assert.equal(f.session.approvalProcessing?.targets[0].status, 'needs_authorization');
    const dialog = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async (_m, _o, ...items) => items[0] as never;
    try { await f.host.resumeApprovalProcessing(external.id); }
    finally { vscode.window.showWarningMessage = dialog; }
    await f.host.executeDelegatedApprovals(f.queue.take(f.session.id)!);
    assert.equal(f.executions(), 1, JSON.stringify(f.session.approvalProcessing)); assert.equal(f.continuations(), 1);
  });
});

test('Stop while external auto-approval dialog is open cannot enqueue or restore its authority', async () => {
  await fixture('delegate', async f => {
    const external = await createDraftRunProposal({ executable: 'node', args: ['--version'], cwd: f.root, reason: 'Scope' });
    f.response.draftRuns = [external]; f.response.draftEdits = [];
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    f.host.queueResponseApprovals(f.session, f.message, f.response);
    await f.host.executeDelegatedApprovals(f.queue.take(f.session.id)!);
    const dialog = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async (_m, _o, ...items) => { f.host.abortPrompt(); return items[0] as never; };
    try { await f.host.resumeApprovalProcessing(external.id); } finally { vscode.window.showWarningMessage = dialog; }
    assert.equal(f.queue.take(f.session.id), undefined);
    assert.equal(f.executions(), 0); assert.equal(f.continuations(), 0);
  });
});

test('scope check detects ../, absolute paths and symlink escape without classifying git push as external', async () => {
  await fixture('delegate', async f => {
    await symlink(f.root, path.join(f.workspace, 'escape'));
    for (const args of [['../outside'], [path.join(f.root, 'outside')], ['escape/outside'], ['-C../outside']]) {
      const p = await createDraftRunProposal({ executable: 'rm', args, reason: 'scope test' });
      const scope = await inspectDraftRunScope({ ...p } as never);
      assert.equal(scope.externalUris.length, 1);
    }
    for (const code of ['cat ../outside', 'rm escape/outside']) {
      const p = await createDraftRunProposal({ executable: 'sh', args: ['-c', code], reason: 'scope test' });
      assert.ok((await inspectDraftRunScope(p as never)).externalUris.length > 0);
    }
    const unknown = await createDraftRunProposal({ executable: 'sh', args: ['-c', 'custom-program'], reason: 'scope test' });
    assert.equal((await inspectDraftRunScope(unknown as never)).uncertain, true);
    for (const args of [['tag', 'test-tag'], ['push', 'origin', 'refs/tags/test-tag']]) {
      const p = await createDraftRunProposal({ executable: 'git', args, reason: 'Exact requested tag' });
      const scope = await inspectDraftRunScope({ ...p } as never);
      assert.deepEqual(scope.externalUris, []); assert.equal(scope.uncertain, false);
    }
  });
});

test('ask leaves real archived drafts pending until individual user approval', async () => {
  await fixture('ask', async f => {
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    f.host.queueResponseApprovals(f.session, f.message, f.response);
    await f.host.executeDelegatedApprovals(f.queue.take(f.session.id)!);
    assert.equal(f.executions(), 0); assert.equal(f.reviews(), 0); assert.equal(f.continuations(), 0);
    assert.equal(f.runs.get(f.proposal.id)?.status, 'pending');
    const edit = await f.edits.applyEdit('edit');
    assert.deepEqual(edit?.appliedEditIds, ['edit']);
    await f.runs.approveAndRun(f.proposal.id, new Set());
    assert.equal(f.executions(), 1); assert.equal(f.runs.get(f.proposal.id)?.authorizationSource, 'user_click');
  });
});

test('reloaded pending drafts stay inert until explicit Provider resume with a fresh approval runtime', async () => {
  await fixture('delegate', async f => {
    await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
    await f.edits.flush(); await f.runs.flush(); await f.storage.flush();
    const storageUri = vscode.Uri.file(path.join(f.root, 'storage')) as never;
    const sessions = new ChatSessionStore(f.storage, 'en', f.scope); await sessions.initialize();
    const approvals = new ApprovalReviewStore(storageUri); await approvals.initialize();
    const diff = new DraftDiffService();
    const edits = new ChangeSetStore(new SafeFileEditor(), diff, sessions, storageUri, key => key);
    await edits.initialize(); await edits.loadSession(sessions.activeSessionId);
    let executions = 0, continuations = 0;
    const runs = new DraftRunStore(storageUri, { execute: async () => { executions++; return { exitCode: 0, timedOut: false, cancelled: false }; },
      cancel: () => false, showTerminal: () => false, dispose: () => {} }, new DraftRunAuthorizationService(approvals));
    await runs.initialize();
    const queue = new DelegatedApprovalQueue();
    const clock = new UserTaskClock();
    const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), f.host, {
      sessionStore: sessions, changeSets: edits, draftRuns: runs, delegatedApprovals: queue, taskClock: clock,
      externalEffectGrants: new Map(), authorizedExternalExecutionUris: new Set(), approvalReviews: approvals,
      approvalReviewer: new ApprovalReviewerService({ globalStorageUri: storageUri, workspaceKey: f.scope.key,
        sourceStore: new ModelSourceStore(storageUri), store: approvals }),
      sendPrompt: async () => { continuations++; }
    }) as Host;
    try {
      assert.equal(executions, 0); assert.equal(queue.take(sessions.activeSessionId), undefined);
      assert.equal(runs.get(f.proposal.id)?.status, 'pending');
      assert.equal(edits.getPendingEdit('edit')?.runId, f.cp.taskId);
      assert.equal(sessions.getActiveSession().messages.at(-1)?.runCheckpoint, undefined);
      await host.resumeApprovalProcessing();
      await host.executeDelegatedApprovals(queue.take(sessions.activeSessionId)!);
      assert.equal(await readFile(path.join(f.workspace, 'result.txt'), 'utf8'), 'result\n');
      assert.equal(executions, 1); assert.equal(continuations, 1);
      assert.equal(sessions.getActiveSession().approvalProcessing?.status, 'completed');
    } finally { await runs.flush(); await edits.flush(); runs.dispose(); diff.dispose(); clock.dispose(); }
  });
});

test('delegate executes specified git tag and push only in a temporary project and local bare remote', async () => {
  await fixture('delegate', async f => {
    const remote = path.join(f.root, 'remote.git');
    execFileSync('git', ['init', '--bare', remote], { stdio: 'pipe' });
    execFileSync('git', ['init', f.workspace], { stdio: 'pipe' });
    execFileSync('git', ['-c', 'user.name=KeepSeek Test', '-c', 'user.email=keepseek-test@example.invalid', 'commit', '--allow-empty', '-m', 'fixture'], { cwd: f.workspace, stdio: 'pipe' });
    execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: f.workspace, stdio: 'pipe' });
    const runs = new DraftRunStore(vscode.Uri.file(path.join(f.root, 'git-storage')) as never,
      new SpawnDraftRunExecutor(), new DraftRunAuthorizationService((f.host as unknown as { approvalReviews: ApprovalReviewStore }).approvalReviews));
    (f.host as unknown as { draftRuns: DraftRunStore }).draftRuns = runs;
    try {
      f.session.messages[0].content = 'Create tag test-task-approval and push that exact tag to the configured local origin.';
      f.response.draftEdits = [];
      f.response.draftRuns = [
        await createDraftRunProposal({ executable: 'git', args: ['tag', 'test-task-approval'], reason: 'Create the requested tag' }),
        await createDraftRunProposal({ executable: 'git', args: ['push', 'origin', 'refs/tags/test-task-approval'], reason: 'Push the requested tag to local origin' })
      ];
      await f.host.saveAgentCheckpoint(f.session, f.message, f.cp);
      f.host.queueResponseApprovals(f.session, f.message, f.response);
      await f.host.executeDelegatedApprovals(f.queue.take(f.session.id)!);
      assert.equal(f.session.approvalProcessing?.status, 'completed', JSON.stringify(f.session.approvalProcessing));
      const tag = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/tags/test-task-approval'], { encoding: 'utf8' }).trim();
      assert.match(tag, /^[a-f0-9]{40,64}$/u);
      assert.ok(runs.toWebviewState(f.session.id).every(run => run.status === 'done' && run.authorizationSource === 'delegated_approver'));
    } finally { await runs.flush(); runs.dispose(); }
  });
});

async function fixture(mode: 'ask' | 'delegate' | 'model_review', body: (f: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const folders = vscode.workspace.workspaceFolders, trusted = vscode.workspace.isTrusted;
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-task-approval-'));
  let f: Awaited<ReturnType<typeof createFixture>> | undefined;
  try { f = await createFixture(root, mode); await body(f); }
  finally {
    if (f) { await f.runs.flush(); await f.edits.flush(); await f.storage.flush(); f.runs.dispose(); f.diff.dispose(); f.clock.dispose(); }
    vscode.workspace.workspaceFolders = folders; vscode.workspace.isTrusted = trusted;
    await rm(root, { recursive: true, force: true });
  }
}
async function createFixture(root: string, mode: 'ask' | 'delegate' | 'model_review') {
  const workspace = path.join(root, 'project'); await mkdir(workspace);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspace), name: 'project' }]; vscode.workspace.isTrusted = true;
  const storageUri = vscode.Uri.file(path.join(root, 'storage')) as never;
  const storage = new GlobalSessionStorage(storageUri);
  const scope = { key: 'task-integration', name: 'project', folderUris: [vscode.Uri.file(workspace).toString()] };
  const sessions = new ChatSessionStore(storage, 'en', scope); await sessions.initialize(); await sessions.setApprovalMode(mode);
  const session = sessions.getActiveSession();
  const userTask = { version: 1 as const, id: 'user-task', originMessageId: 'user', reason: 'user' as const };
  session.messages.push({ id: 'user', role: 'user', content: 'Create result.txt and check runtime.', createdAt: new Date().toISOString(), userTask });
  const message: ChatMessage = { id: 'assistant', role: 'assistant', content: '', createdAt: new Date().toISOString(), userTask };
  session.messages.push(message);
  const proposal = await createDraftRunProposal({ executable: 'node', args: ['--version'], reason: 'Check runtime' });
  const edit: DraftEdit = { id: 'edit', uri: vscode.Uri.file(path.join(workspace, 'result.txt')).toString(), label: 'result.txt', action: 'create', newText: 'result\n', reason: 'Create requested result' };
  const response = { runId: 'physical-trace-id', message: 'Prepared', draftEdits: [edit], draftRuns: [proposal],
    runDetails: new RunDetailsBuilder({ runId: 'physical-trace-id', modelId: 'main', thinkingEnabled: false }).build('succeeded'), toolRounds: [] } as unknown as AgentResponse;
  const request: AgentRequest = { approvalMode: mode, model: { id: 'main', sourceId: 'main', provider: 'openai-compatible', label: 'main', contextWindowTokens: 32768, maxOutputTokens: 4096 },
    prompt: 'task', contextFiles: [], history: [session.messages[0]], settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' }, language: 'en', sessionId: session.id, assistantMessageId: message.id };
  const cp = createRunCheckpoint(request, 0, 'test', scope.folderUris); cp.status = 'completed'; cp.usedMs = 10_000; cp.finalResponse = response;
  let now = 0, executeCount = 0, reviewCount = 0, continuationCount = 0, denied = false;
  const clock = new UserTaskClock(() => now);
  const reviews = new ApprovalReviewStore(storageUri); await reviews.initialize();
  const sourceStore = new ModelSourceStore(storageUri);
  await sourceStore.createSource({ id: 'review-source', provider: 'openai-compatible', name: 'Reviewer', apiKey: 'test-key', models: [{ id: 'fixed-reviewer' }] });
  await new SubagentSettingsStore(storageUri, scope.key).save({ mode: 'fixed', sourceId: 'review-source', modelId: 'fixed-reviewer' });
  await new SubagentSettingsStore(storageUri, scope.key).save({ mode: 'fixed', sourceId: 'missing-profile-source', modelId: 'profile-only' }, 'review');
  const reviewer = new ApprovalReviewerService({ globalStorageUri: storageUri, workspaceKey: scope.key, sourceStore, store: reviews,
    requestText: async input => {
      reviewCount++; now += 1000;
      assert.equal(input.model.id, 'fixed-reviewer');
      assert.match(input.userPrompt, /Create result.txt and check runtime/u);
      return JSON.stringify({ decision: denied ? 'deny' : 'approve', risk: 'low', reason: denied ? 'Not allowed.' : 'Requested operation.', policyRules: ['direct_user_goal'], saferAlternative: '' });
    } });
  const executor = { execute: async () => { executeCount++; now += 3000; return { exitCode: 0, signal: undefined, timedOut: false, cancelled: false }; }, cancel: () => false, showTerminal: () => false, dispose: () => {} } as DraftRunExecutorAdapter;
  const runs = new DraftRunStore(storageUri, executor, new DraftRunAuthorizationService(reviews));
  const diff = new DraftDiffService();
  const edits = new ChangeSetStore(new SafeFileEditor(), diff, sessions, storageUri, key => key);
  const queue = new DelegatedApprovalQueue();
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    language: 'en', sessionStore: sessions, taskClock: clock, changeSets: edits, draftRuns: runs, delegatedApprovals: queue,
    activeChangeActions: new Set(),
    approvalReviews: reviews, approvalReviewer: reviewer, repairLoopsBySession: new Map(), checkpointActivityDepth: 0,
    externalEffectGrants: new Map(), authorizedExternalReferenceUris: new Set(), authorizedExternalExecutionUris: new Set(),
    agentActivity: { sequence: 0 }, getApprovalReviewerModelContext: async () => ({ model: request.model }),
    postState: () => {}, postToWebview: () => {}, setAgentActivity: () => {}, scheduleRunContextRefresh: () => {}, awaitRunContextRefresh: async () => true,
    handleAppliedRepairEdits: async () => {}, selectedSourceId: 'main', selectedModelId: 'main',
    sendPrompt: async () => { continuationCount++; const work = clock.enter(session, userTask); now += 5000; work.finish(); }
  }) as Host;
  return { root, workspace, scope, storage, session, message, proposal, cp, response, host, queue, clock, runs, edits, diff,
    advance: (ms: number) => { now += ms; }, executions: () => executeCount, reviews: () => reviewCount,
    continuations: () => continuationCount, deny: () => { denied = true; } };
}
