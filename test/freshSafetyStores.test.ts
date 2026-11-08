import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { ApprovalReviewStore } from '../src/approvals/approvalReviewStore';
import { APPROVAL_POLICY_VERSION } from '../src/approvals/approvalReviewTypes';
import { DraftRunStore } from '../src/runs/draftRunStore';
import { hashDraftRunSpec } from '../src/runs/draftRunProposal';
import { analyzeDraftRunEffects } from '../src/approvals/authorization';
import { ChangeSetStore } from '../src/edits/changeSetStore';
import { createChangeSet } from '../src/edits/changeSet';
import type { DraftRunProposal, DraftRunSpec } from '../src/shared/types';

function proposal(id: string): DraftRunProposal {
  const spec: DraftRunSpec = { executable: 'printf', args: ['%s', 'fixture'], reason: 'controlled fixture',
    cwdUri: 'file:///workspace', cwdLabel: '.', externalCwd: false, timeoutMs: 1000, env: [] };
  return { id, spec, specHash: hashDraftRunSpec(spec), effectAssessment: analyzeDraftRunEffects(spec) };
}

function approval(sessionId: string, targetId: string) {
  return { sessionId, rootTaskId: 'root', agentRunId: 'segment', targetId, actionKind: 'draft_run_execute' as const,
    actionHash: 'hash', policyVersion: APPROVAL_POLICY_VERSION, approvalMode: 'delegate' as const,
    approvalSource: 'user_click' as const, reviewerSourceId: '', reviewerModelId: '', reviewerProvider: 'host_policy',
    decision: 'approve' as const, risk: 'low' as const, rationale: 'controlled fixture', policyRules: [] };
}

function fixture(root: string, sessionId: string) {
  let executes = 0;
  const executor = { async execute() { executes++; throw new Error('Fixture must never execute.'); },
    cancel() { return false; }, showTerminal() { return false; }, dispose() {} };
  const uri = vscode.Uri.file(root) as never;
  const reviews = new ApprovalReviewStore(uri);
  const runs = new DraftRunStore(uri, executor);
  const session = { id: sessionId, messages: [], updatedAt: '2026-01-01T00:00:00.000Z' };
  const changes = new ChangeSetStore({} as never, {} as never,
    { activeSessionId: sessionId, getActiveSession: () => session, async persist() {} } as never, uri, key => key);
  return { reviews, runs, changes, executes: () => executes };
}

function change(sessionId: string, id: string) {
  return createChangeSet({ sessionId, runId: `run-${id}`, messageId: `message-${id}`,
    edits: [{ id, uri: `file:///workspace/${id}.txt`, label: `${id}.txt`, action: 'create', newText: id, reason: id }] })!;
}

test('fresh safety stores never read or rewrite old audit stores, including deferred ChangeSet GC', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-fresh-safety-'));
  const legacy = fixture(root, 'old');
  legacy.runs.addProposals({ sessionId: 'old', agentRunId: 'old-segment', proposals: [proposal('old-run')] });
  const oldReview = await legacy.reviews.add(approval('old', 'old-target'));
  const oldChange = legacy.changes.add(change('old', 'old-edit'))!;
  await Promise.all([legacy.runs.flush(), legacy.reviews.flush(), legacy.changes.flush()]);
  const oldPaths = [path.join(root, 'draft-runs.json'), path.join(root, 'approval-reviews.json'),
    path.join(root, 'change-sets', 'v4', 'index.json')];
  const before = await Promise.all(oldPaths.map(file => readFile(file, 'utf8')));
  const originalRead = vscode.workspace.fs.readFile;
  const originalDirectory = vscode.workspace.fs.readDirectory;
  const reads: string[] = [];
  vscode.workspace.fs.readFile = async uri => { reads.push(uri.fsPath); return originalRead(uri); };
  vscode.workspace.fs.readDirectory = async uri => { reads.push(uri.fsPath); return originalDirectory(uri); };
  const fresh = fixture(root, 'fresh');
  t.after(async () => {
    vscode.workspace.fs.readFile = originalRead;
    vscode.workspace.fs.readDirectory = originalDirectory;
    await Promise.all([legacy.runs.flush(), fresh.runs.flush(), fresh.reviews.flush(), fresh.changes.flush()]);
    legacy.runs.dispose(); fresh.runs.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all([fresh.runs.initializeFreshSession('fresh'), fresh.reviews.initializeFreshSession('fresh'),
    fresh.changes.initializeFreshSession('fresh')]);
  await Promise.all([fresh.runs.flush(), fresh.reviews.flush(), fresh.changes.flush()]);
  assert.deepEqual(reads, [], 'first-send safety preparation has no legacy recovery dependency');
  assert.deepEqual(await Promise.all(oldPaths.map(file => readFile(file, 'utf8'))), before,
    'flushing unused safety stores cannot replace an unexamined legacy aggregate');
  const run = proposal('new-run');
  fresh.runs.addProposals({ sessionId: 'fresh', agentRunId: 'segment', proposals: [run] });
  const newReview = await fresh.reviews.add(approval('fresh', 'new-target'));
  const newChange = fresh.changes.add(change('fresh', 'new-edit'))!;
  await Promise.all([fresh.runs.flush(), fresh.reviews.flush(), fresh.changes.flush()]);
  fresh.changes.discardAll(newChange.id);
  await fresh.changes.flush();
  await new Promise<void>(resolve => setTimeout(resolve, 2100));
  assert.deepEqual(reads, [], 'fresh mutation persistence and terminal idle work cannot scan old stores');
  assert.deepEqual(await Promise.all(oldPaths.map(file => readFile(file, 'utf8'))), before,
    'fresh audits publish independently without replacing legacy aggregates or ChangeSet index');
  assert.equal(fresh.executes(), 0);

  vscode.workspace.fs.readFile = originalRead;
  vscode.workspace.fs.readDirectory = originalDirectory;
  const restarted = fixture(root, 'fresh');
  await Promise.all([restarted.runs.initialize(), restarted.reviews.initialize(), restarted.changes.initialize()]);
  await restarted.changes.loadSession('old');
  assert.equal(restarted.runs.get('old-run')?.sessionId, 'old');
  assert.equal(restarted.runs.get('new-run')?.sessionId, 'fresh');
  assert.equal(restarted.reviews.get(oldReview.reviewId)?.targetId, 'old-target');
  assert.equal(restarted.reviews.get(newReview.reviewId)?.targetId, 'new-target');
  assert.equal(restarted.changes.getChangeSetStatus(oldChange.id), 'pending');
  assert.ok(restarted.changes.toWebviewState('fresh').some(item => item.id === newChange.id));
  await assert.rejects(restarted.reviews.consumeMatchingApproval({ reviewId: newReview.reviewId,
    sessionId: 'fresh', rootTaskId: 'root', agentRunId: 'segment', targetId: 'new-target', actionKind: 'draft_run_execute',
    actionHash: 'hash', policyVersion: APPROVAL_POLICY_VERSION, expectedSource: 'user_click',
    approvalMode: 'delegate', workspaceTrusted: true }), /matching approval/);
  assert.equal(restarted.executes(), 0, 'audit recovery cannot restore a process permit or execute work');
  await Promise.all([restarted.runs.flush(), restarted.changes.flush()]); restarted.runs.dispose();
});
