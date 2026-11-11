import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import * as vscode from './stubs/vscode';
import { AgentRunner } from '../src/agent/runner';
import {
  APPLY_PATCH_TOOL_NAME,
  CREATE_DRAFT_EDIT_TOOL_NAME,
  DELEGATE_TASK_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME
} from '../src/agent/protocol';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { ValidationToolService, type ValidationToolAdapter } from '../src/agent/tools/validationTools';
import type { ToolAuthorizationAdapter } from '../src/agent/tools/toolAuthorization';
import type {
  AgentRequest,
  RunAuthorizationPolicy,
  SafeNpmScript,
  ToolAuthorizationDecision
} from '../src/shared/types';
import type { ApprovalReviewerAdapter } from '../src/approvals/approvalReviewer';
import { APPROVAL_POLICY_VERSION, USER_CONFIRMABLE_RISK_RULE,
  type ApprovalReviewRecord, type ApprovalReviewRequest, type ApprovalReviewState } from '../src/approvals/approvalReviewTypes';
import { ApprovalAuditError } from '../src/approvals/approvalReviewStore';
import { AgentInterruptedError, normalizeRunCheckpoint, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { ToolEvidenceStore } from '../src/agent/evidence/store';
import { snapshotCheckpoint } from '../src/sessions/persistenceSnapshot';

let workspaceRoot = '';

beforeEach(async () => {
  workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-run-validation-'));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspaceRoot), name: 'validation-run' }];
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { compile: 'tsc -p .' } }));
});

afterEach(async () => {
  vscode.workspace.workspaceFolders = [];
  await rm(workspaceRoot, { recursive: true, force: true });
});

test('Runner allows baseline validation, then blocks validation after an ordinary DraftEdit', async () => {
  const validation = new FakeValidationTools([validationResult(true)]);
  const targetPath = path.join(workspaceRoot, 'ordinary.ts');
  const calls: ToolCallSpec[] = [
    toolCall('validate-before', RUN_VALIDATION_TOOL_NAME, { script: 'compile' }),
    toolCall('draft', CREATE_DRAFT_EDIT_TOOL_NAME, {
      path: targetPath,
      content: 'export const ready = true;\n',
      reason: 'Implement the requested change.'
    }),
    toolCall('validate-after', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })
  ];

  const response = await withResponses([toolResponse(calls), textResponse('The change is ready and validation passed.')], async () =>
    await createRunner(validation).run(createRequest('Implement the change.'))
  );

  assert.equal(validation.runCount, 1);
  assert.equal(response.draftEdits.length, 1);
  const results = response.toolRounds?.[0]?.toolResults ?? [];
  assert.equal(JSON.parse(results[0].content).ok, true);
  assert.equal(JSON.parse(results[2].content).errorType, 'pending_changes_require_apply');
  assert.doesNotMatch(response.message, /validation passed/u);
  assert.match(response.message, /covered only the pre-change workspace baseline/u);
  assert.match(response.message, /pending DraftEdits are unapplied and unvalidated/u);
});

test('Runner also blocks validation after a repair DraftEdit', async () => {
  const validation = new FakeValidationTools([validationResult(false)]);
  const targetPath = path.join(workspaceRoot, 'repair.ts');
  const calls: ToolCallSpec[] = [
    toolCall('validate-failure', RUN_VALIDATION_TOOL_NAME, { script: 'compile' }),
    toolCall('read-problems', READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME, {}),
    toolCall('repair-draft', CREATE_DRAFT_EDIT_TOOL_NAME, {
      path: targetPath,
      content: 'export const repaired = true;\n',
      reason: 'Repair the compile failure.'
    }),
    toolCall('validate-repair', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })
  ];

  const response = await withResponses([toolResponse(calls), textResponse('Repair prepared and compile failed.')], async () =>
    await createRunner(validation).run(createRequest('Fix the compile failure.'))
  );

  assert.equal(validation.runCount, 1);
  const results = response.toolRounds?.[0]?.toolResults ?? [];
  assert.equal(JSON.parse(results[3].content).errorType, 'pending_changes_require_apply');
  assert.equal(response.repairLoop.status, 'waiting_for_apply');
  assert.equal(response.repairLoop.pendingDraftEditIds.length, 1);
  assert.match(response.message, /Validation is paused/u);
  assert.match(response.message, /covered only the pre-change workspace baseline/u);
});

test('Runner records every v9 multi-file patch DraftEdit before blocking validation', async () => {
  const validation = new FakeValidationTools([]);
  await writeFile(path.join(workspaceRoot, 'one.ts'), 'export const one = 1;\n');
  await writeFile(path.join(workspaceRoot, 'two.ts'), 'export const two = 2;\n');
  const patch = JSON.stringify({
    version: 'keepseek_patch_v1',
    operations: [
      { action: 'update', path: 'one.ts', edits: [{ search: 'one = 1', replace: 'one = 10' }] },
      { action: 'update', path: 'two.ts', edits: [{ search: 'two = 2', replace: 'two = 20' }] }
    ]
  });
  const request = createRequest('Patch both files, then validate.');
  request.requestProtocolVersion = 9;
  const response = await withResponses([
    toolResponse([
      toolCall('patch-both', APPLY_PATCH_TOOL_NAME, { patch, reason: 'Update both constants.' }),
      toolCall('validate-after-patch', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })
    ]),
    textResponse('Both changes are pending.')
  ], async () => await createRunner(validation).run(request));

  assert.equal(validation.runCount, 0);
  assert.equal(response.draftEdits.length, 2);
  assert.equal(response.draftEdits.every((edit) => edit.kind === 'text_patch_v1' && !('newText' in edit)), true);
  const patchResult = JSON.parse(response.toolRounds?.[0]?.toolResults[0]?.content ?? '{}') as {
    draftEditIds?: string[];
    files?: Array<{ hash?: string }>;
    patch?: unknown;
  };
  assert.equal(patchResult.draftEditIds?.length, 2);
  assert.equal(patchResult.files?.every((file) => /^[a-f0-9]{64}$/u.test(file.hash ?? '')), true);
  assert.equal(Object.hasOwn(patchResult, 'patch'), false);
  assert.equal(JSON.parse(response.toolRounds?.[0]?.toolResults[1]?.content ?? '{}').errorType, 'pending_changes_require_apply');
  assert.deepEqual(await Promise.all([
    readFile(path.join(workspaceRoot, 'one.ts'), 'utf8'),
    readFile(path.join(workspaceRoot, 'two.ts'), 'utf8')
  ]), ['export const one = 1;\n', 'export const two = 2;\n']);
});

test('Runner preserves the Apply-then-continue validation flow', async () => {
  const validation = new FakeValidationTools([validationResult(true)]);
  const request = createRequest('Continue repair validation after Apply.');
  request.repairLoop = {
    status: 'running_validation',
    iteration: 1,
    maxIterations: 2,
    lastValidationScript: 'compile',
    pendingDraftEditIds: []
  };

  const response = await withResponses([
    toolResponse([toolCall('post-apply-validation', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })]),
    textResponse('The controlled validation completed.')
  ], async () => await createRunner(validation).run(request));

  assert.equal(validation.runCount, 1);
  assert.equal(response.repairLoop.status, 'completed');
  assert.match(response.message, /post-Apply validation passed on the updated on-disk workspace/u);
});

test('Runner turns keepseek_run_draft into a pending proposal without executing it', async () => {
  const validation = new FakeValidationTools([]);
  const request = createRequest('Run a command after I approve it.');
  request.requestProtocolVersion = 4;
  const response = await withResponses([
    toolResponse([toolCall('draft-run', RUN_DRAFT_TOOL_NAME, {
      executable: 'printf',
      args: ['%s', 'literal; argument'],
      reason: 'Print one literal argument.',
      cwd: '.',
      timeoutMs: 20_000
    })]),
    textResponse('The command is pending your approval.')
  ], async () => await createRunner(validation).run(request));

  assert.equal(validation.runCount, 0);
  assert.equal(response.draftRuns?.length, 1);
  assert.equal(response.draftRuns?.[0]?.spec.executable, 'printf');
  assert.deepEqual(response.draftRuns?.[0]?.spec.args, ['%s', 'literal; argument']);
  assert.equal(response.draftRuns?.[0]?.spec.cwdUri, vscode.Uri.file(await realpath(workspaceRoot)).toString());
  const result = JSON.parse(response.toolRounds?.[0]?.toolResults[0]?.content ?? '{}') as {
    ok?: boolean;
    draftRun?: { status?: string };
    message?: string;
  };
  assert.equal(result.ok, true);
  assert.equal(result.draftRun?.status, 'pending');
  assert.match(result.message ?? '', /no process was started/u);
});

test('Runner Plan phase allows read-only investigation and blocks implementation before every approval mode', async () => {
  for (const approvalMode of ['ask', 'delegate'] as const) {
    const validation = new FakeValidationTools([]);
    const reviewer = new FakeApprovalReviewer('approve');
    const authorization = new AllowAllToolAuthorization();
    const request = createRequest('Plan the change without implementing it.');
    request.executionMode = 'plan';
    request.approvalMode = approvalMode;
    request.requestProtocolVersion = 5;
    request.sessionId = 'plan-session-' + approvalMode;
    const response = await withResponses([
      toolResponse([
        toolCall('read', READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME, {}),
        toolCall('draft', CREATE_DRAFT_EDIT_TOOL_NAME, { path: 'blocked.ts', content: 'blocked', reason: 'blocked' }),
        toolCall('delete', DELETE_WORKSPACE_FILE_TOOL_NAME, { path: 'blocked.ts', reason: 'blocked' }),
        toolCall('run', RUN_DRAFT_TOOL_NAME, { executable: 'node', args: ['--version'], reason: 'blocked' }),
        toolCall('writer', DELEGATE_TASK_TOOL_NAME, { profile: 'proposal', task: 'write files' })
      ]),
      textResponse('1. Inspect\n   - Verify the relevant code paths.')
    ], async () => await createRunner(validation, reviewer, authorization).run(request));

    assert.deepEqual(authorization.toolNames, [READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME]);
    assert.equal(reviewer.calls, 0);
    assert.equal(response.draftEdits.length, 0);
    assert.equal(response.draftRuns?.length, 0);
    const results = response.toolRounds?.[0]?.toolResults ?? [];
    assert.equal(JSON.parse(results[0]?.content ?? '{}').ok, true);
    for (const result of results.slice(1)) {
      assert.equal(JSON.parse(result.content).errorType, 'plan_phase_implementation_blocked');
    }
  }
});

test('model-reviewed validation persists a neutral tool placeholder and requires a new user-message boundary', async () => {
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { compile: 'tsc -p .' } }));
  const validation = new FakeValidationTools([validationResult(true)]);
  const reviewer = new FakeApprovalReviewer('approve');
  const request = createRequest('Compile the project under model review.');
  request.approvalMode = 'delegate';
  request.sessionId = 'session-review';
  const response = await withResponses([
    toolResponse([toolCall('reviewed-validation', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])
  ], async () => await createRunner(validation, reviewer).run(request));

  assert.equal(validation.runCount, 1);
  assert.equal(reviewer.calls, 1);
  assert.equal(response.approvalContinuationRequired, true);
  const providerResult = JSON.parse(response.toolRounds?.[0]?.toolResults[0]?.content ?? '{}');
  assert.equal(providerResult.status, 'approval_result_pending');
  assert.doesNotMatch(response.toolRounds?.[0]?.toolResults[0]?.content ?? '', /Scoped model approval|durationMs/u);
  assert.equal(response.runDetails.approvalReviews?.[0]?.decision, 'approve');
  assert.match(response.approvalToolResults?.[0]?.result.content ?? '', /durationMs/u);
});

test('a crash after a reviewed result is durable recovers neutral replay and the exact result without another launch', async t => {
  const validation = new FakeValidationTools([validationResult(true)]);
  const reviewer = new FakeApprovalReviewer('approve');
  const storageUri = vscode.Uri.file(path.join(workspaceRoot, 'storage')) as never;
  const create = () => new AgentRunner(undefined, undefined, validation, undefined, undefined, undefined,
    storageUri, undefined, reviewer);
  const request: AgentRequest = { ...createRequest('Run compile.'), approvalMode: 'delegate', sessionId: 'review-result-recovery' };
  const original = ToolEvidenceStore.prototype.saveProviderEnvelope;
  let interrupted = false;
  t.mock.method(ToolEvidenceStore.prototype, 'saveProviderEnvelope', async function (this: ToolEvidenceStore,
    ...args: Parameters<ToolEvidenceStore['saveProviderEnvelope']>) {
    if (!interrupted && args[0].approvalResult) {
      interrupted = true;
      throw new AgentInterruptedError('extension_restart', 'Simulated host interruption before the Provider envelope.');
    }
    return original.apply(this, args);
  });
  let saved: RunCheckpoint | undefined;
  await assert.rejects(withResponses([toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])],
    () => create().run(request, { onCheckpoint: async cp => { saved = structuredClone(cp); } })),
  (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'extension_restart');
  const checkpoint = normalizeRunCheckpoint(saved);
  assert.ok(checkpoint);
  assert.equal(validation.runCount, 1);
  assert.equal(reviewer.consumed, 1);
  assert.ok(checkpoint.state?.pending?.executing?.evidenceRef);

  const recovered = await withResponses([], () => create().run({ ...request, checkpoint: snapshotCheckpoint(checkpoint) }));
  assert.equal(validation.runCount, 1);
  assert.equal(reviewer.calls, 1);
  assert.equal(recovered.approvalContinuationRequired, true);
  const providerResult = recovered.toolRounds?.[0]?.toolResults[0]?.content ?? '';
  assert.equal(JSON.parse(providerResult).status, 'approval_result_pending');
  assert.doesNotMatch(providerResult, /durationMs/u);
  assert.match(recovered.approvalToolResults?.[0]?.result.content ?? '', /durationMs/u);
});

test('model-reviewed validation denial does not execute and still crosses the new user-message boundary', async () => {
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { compile: 'tsc -p .' } }));
  const validation = new FakeValidationTools([]);
  const reviewer = new FakeApprovalReviewer('deny');
  const request = createRequest('Compile the project under model review.');
  request.approvalMode = 'delegate';
  request.sessionId = 'session-review';
  const response = await withResponses([
    toolResponse([toolCall('denied-validation', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])
  ], async () => await createRunner(validation, reviewer).run(request));

  assert.equal(validation.runCount, 0);
  assert.equal(response.approvalContinuationRequired, true);
  assert.equal(response.runDetails.approvalReviews?.[0]?.decision, 'deny');
  assert.doesNotMatch(response.toolRounds?.[0]?.toolResults[0]?.content ?? '', /Denied by reviewer/u);
  assert.equal(response.approvalToolResults?.[0]?.status, 'denied');
  const deniedResult = JSON.parse(response.approvalToolResults?.[0]?.result.content ?? '{}');
  assert.equal(deniedResult.ok, false);
  assert.equal(deniedResult.status, 'approval_denied');
  assert.equal(deniedResult.executed, false);
  assert.equal(deniedResult.errorType, 'approval_denied');
});

for (const approvalMode of ['ask', 'delegate'] as const) {
  test(`unavailable npm validation does not stop a local Git task under ${approvalMode}`, async () => {
    const manifest = path.join(workspaceRoot, 'package.json');
    for (const manifestExists of [false, true]) {
      if (manifestExists) await writeFile(manifest, JSON.stringify({ scripts: { test: 'node --test' } }));
      else await rm(manifest);
      const authorization = new AllowAllToolAuthorization();
      const validation = new FakeValidationTools([]);
      const reviewer = new FakeApprovalReviewer('approve');
      const request = createRequest('Run git add --all ., then summarize the staged changes and commit locally.');
      request.approvalMode = approvalMode;
      request.sessionId = `git-task-${approvalMode}-${manifestExists}`;
      request.requestProtocolVersion = 4;
      request.executionLimits = { ...request.executionLimits, maxToolIterations: 4 };
      const stage = ['add', '--all', '.'];
      const commit = ['commit', '-m', 'Update Python project'];
      const response = await withResponses([
        toolResponse([toolCall('optional-compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })]),
        toolResponse([toolCall('stage', RUN_DRAFT_TOOL_NAME, { executable: 'git', args: stage, reason: 'Stage the requested changes' })]),
        toolResponse([toolCall('commit', RUN_DRAFT_TOOL_NAME, { executable: 'git', args: commit, reason: 'Record the requested local commit' })]),
        textResponse('The Git operations are prepared.')
      ], () => createRunner(validation, reviewer, authorization).run(request));

      const result = JSON.parse(response.toolRounds?.[0]?.toolResults[0]?.content ?? '{}');
      assert.equal(result.errorType, 'validation_unavailable');
      assert.equal(result.executed, false);
      assert.match(result.error, manifestExists ? /does not define "compile"/u : /no package\.json/u);
      assert.equal(response.runDetails.toolCalls[0]?.status, 'failed');
      assert.deepEqual(authorization.toolNames, [RUN_DRAFT_TOOL_NAME, RUN_DRAFT_TOOL_NAME]);
      assert.equal(reviewer.calls, 0);
      assert.equal(validation.runCount, 0);
      assert.equal(response.repairLoop.iteration, 0);
      assert.equal(response.repairLoop.stopReason, undefined);
      assert.equal(response.approvalContinuationStopReason, undefined);
      assert.equal(response.taskPlan.steps.find(step => step.id === 'validate')?.status, 'skipped');
      assert.deepEqual(response.taskPlan.blockers, []);
      assert.deepEqual(response.draftRuns?.map(draft => draft.spec.args), [stage, commit]);
    }
  });
}

test('a dangling package.json symlink fails hard validation preflight without approval or launch', async () => {
  if (process.platform === 'win32') return;
  const manifest = path.join(workspaceRoot, 'package.json');
  await rm(manifest);
  await symlink('missing-package.json', manifest);
  const authorization = new AllowAllToolAuthorization();
  const validation = new FakeValidationTools([]);
  const reviewer = new FakeApprovalReviewer('approve');
  const request = { ...createRequest('Run compile.'), approvalMode: 'delegate' as const, sessionId: 'dangling-package' };
  const response = await withResponses([
    toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])
  ], () => createRunner(validation, reviewer, authorization).run(request));

  const result = JSON.parse(response.toolRounds?.[0]?.toolResults[0]?.content ?? '{}');
  assert.equal(result.errorType, 'validation_preflight_failed');
  assert.equal(result.executed, false);
  assert.ok(response.approvalContinuationStopReason);
  assert.deepEqual(authorization.toolNames, []);
  assert.equal(reviewer.calls, 0);
  assert.equal(validation.runCount, 0);
});

test('delegate reviews each fixed validation once and delivers the results of real executions', async () => {
  if (process.platform === 'win32') return;
  const entry = 'node --test verify.cjs';
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { compile: entry, lint: entry, test: entry } }));
  await writeFile(path.join(workspaceRoot, 'verify.cjs'), [
    "const fs = require('node:fs');",
    "require('node:assert/strict').equal(fs.readFileSync('result.txt', 'utf8'), 'ready');",
    "fs.appendFileSync('ran.log', process.env.npm_lifecycle_event + '\\n');"
  ].join('\n'));
  const reviewer = new FakeApprovalReviewer('approve');
  const runner = createRunner(new ValidationToolService(), reviewer);
  const request = createRequest('Create result.txt and run compile, lint and test.');
  request.approvalMode = 'delegate';
  request.approvalRootTaskId = 'root-validation';
  request.sessionId = 'session-validation';
  const draft = await withResponses([
    toolResponse([toolCall('edit', CREATE_DRAFT_EDIT_TOOL_NAME, { path: 'result.txt', content: 'ready', reason: 'Create fixture result' })]),
    textResponse('Prepared the requested edit.')
  ], () => runner.run(request));
  assert.equal(draft.draftEdits.length, 1);
  assert.equal(reviewer.calls, 0, 'draft preparation is read-only');
  await assert.rejects(readFile(path.join(workspaceRoot, 'result.txt')), { code: 'ENOENT' });
  const editor = new SafeFileEditor();
  const journalStates: string[] = [];
  const applied = await editor.applyDraftEdit(draft.draftEdits[0], 'validation-fixture', undefined, {
    persist: async checkpoint => { journalStates.push(checkpoint.state!); }
  });
  assert.equal(applied.state, 'applied');
  assert.deepEqual(journalStates, ['prepared', 'applying', 'applied']);

  for (const script of ['compile', 'lint', 'test'] as const) {
    const response = await withResponses([
      toolResponse([toolCall('validate-' + script, RUN_VALIDATION_TOOL_NAME, { script })])
    ], () => runner.run(request));
    assert.equal(response.approvalContinuationRequired, true);
    assert.equal(response.runDetails.approvalReviews?.[0]?.approvalSource, 'auto_approval_review');
    assert.equal(response.approvalToolResults?.[0]?.status, 'succeeded', response.approvalToolResults?.[0]?.result.content);
    const result = JSON.parse(response.approvalToolResults![0].result.content);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /tests 1/u);
  }
  assert.equal(reviewer.calls, 3);
  assert.equal(reviewer.consumed, 3);
  assert.equal(await readFile(path.join(workspaceRoot, 'ran.log'), 'utf8'), 'compile\nlint\ntest\n');
});

test('ask uses its existing validation authorization and cannot bypass a historical safety denial', async () => {
  if (process.platform === 'win32') return;
  const validation = new FakeValidationTools([]);
  const authorization = new AllowAllToolAuthorization();
  const reviewer = new FakeApprovalReviewer('deny');
  const request = { ...createRequest('Run the fixed compile entry.'), approvalMode: 'ask' as const };
  const runner = createRunner(validation, reviewer, authorization);
  const compile = () => toolResponse([toolCall('ask-compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })]);
  const allowed = await withResponses([compile(), textResponse('Compile completed.')], () => runner.run(request));
  assert.equal(JSON.parse(allowed.toolRounds?.[0]?.toolResults[0].content ?? '{}').ok, true);
  reviewer.historicalDenial = true;
  const blocked = await withResponses([compile(), textResponse('Compile was denied.')], () => runner.run(request));
  assert.equal(JSON.parse(blocked.toolRounds?.[0]?.toolResults[0].content ?? '{}').errorType, 'approval_denied');
  assert.equal(validation.runCount, 1);
  assert.deepEqual(authorization.toolNames, [RUN_VALIDATION_TOOL_NAME]);
  assert.equal(reviewer.calls, 0);
});

test('delegate stops before validation when the review service is absent or launch evidence is incomplete', async () => {
  if (process.platform === 'win32') return;
  const validation = new FakeValidationTools([]);
  const authorization = new AllowAllToolAuthorization();
  const request = { ...createRequest('Run the fixed compile entry.'), approvalMode: 'delegate' as const };
  const compile = () => toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })]);
  const missing = await withResponses([compile()], () => createRunner(validation, undefined, authorization).run(request));
  assert.match(missing.approvalContinuationStopReason ?? '', /review service unavailable/u);
  await writeFile(path.join(workspaceRoot, '.npmrc'), 'ignore-scripts=false\n');
  const reviewer = new FakeApprovalReviewer('approve');
  const incomplete = await withResponses([compile()], () => createRunner(validation, reviewer, authorization).run(request));
  assert.equal(JSON.parse(incomplete.toolRounds?.[0]?.toolResults[0].content ?? '{}').errorType, 'insufficient_launch_evidence');
  assert.equal(reviewer.calls, 0);
  assert.equal(validation.runCount, 0);
  assert.deepEqual(authorization.toolNames, []);
});

test('approval audit failure stops the tool batch without executing or requesting a click', async () => {
  if (process.platform === 'win32') return;
  const validation = new FakeValidationTools([]);
  const reviewer = new FakeApprovalReviewer('approve', async () => { throw new ApprovalAuditError(new Error('approval ledger failure')); });
  const request = { ...createRequest('Run the fixed compile entry.'), approvalMode: 'delegate' as const, sessionId: 'audit-failure' };
  const runner = new AgentRunner(undefined, undefined, validation, undefined, undefined, undefined,
    undefined, undefined, reviewer, async () => assert.fail('an audit error cannot request a click'));
  await assert.rejects(withResponses([
    toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' }),
      toolCall('compile-after', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])
  ], () => runner.run(request)), (error: unknown) => error instanceof AgentInterruptedError
    && error.reason === 'storage_failure' && /approval ledger failure/u.test(error.message));
  assert.equal(reviewer.calls, 1);
  assert.equal(validation.runCount, 0);
});

test('reviewed validation runs only with the reviewed lifecycle snapshot; changed launch has zero effects', async () => {
  if (process.platform === 'win32') return;
  const marker = path.join(workspaceRoot, 'ran.txt');
  const manifest = path.join(workspaceRoot, 'package.json');
  const entry = 'node --test verify.cjs';
  await writeFile(manifest, JSON.stringify({ scripts: { test: entry } }));
  await writeFile(path.join(workspaceRoot, 'verify.cjs'), "require('node:fs').writeFileSync('ran.txt', 'executed');");
  const request = createRequest('Run the exact test script.');
  request.approvalMode = 'delegate';
  request.sessionId = 'snapshot-test';
  for (const change of [true, false]) {
    await writeFile(manifest, JSON.stringify({ scripts: { test: entry } }));
    const reviewer = new FakeApprovalReviewer('approve', async action => {
      assert.equal(action.exactAction.kind, 'validation_run');
      if (action.exactAction.kind !== 'validation_run') throw new Error('Wrong action');
      assert.match(action.exactAction.launch?.scripts.content ?? '', /node --test verify.cjs/u);
      assert.equal(action.exactAction.launch?.argv.at(-1), 'test');
      assert.ok(action.scopeFingerprint);
      await assert.rejects(readFile(marker), { code: 'ENOENT' });
      if (change) await writeFile(manifest, JSON.stringify({ scripts: { pretest: 'node --test verify.cjs', test: entry } }));
    });
    const response = await withResponses([
      toolResponse([toolCall('snapshot-validation', RUN_VALIDATION_TOOL_NAME, { script: 'test' })])
    ], () => createRunner(new ValidationToolService(), reviewer).run(request));
    assert.equal(reviewer.calls, 1);
    assert.equal(response.approvalToolResults?.[0]?.status, change ? 'failed' : 'succeeded', response.approvalToolResults?.[0]?.result.content);
    if (change) await assert.rejects(readFile(marker), { code: 'ENOENT' });
    else assert.equal(await readFile(marker, 'utf8'), 'executed');
  }
});

test('delegate reviews a changed fixed entry and checks a risky lifecycle script before any review or launch', async () => {
  if (process.platform === 'win32') return;
  const manifest = path.join(workspaceRoot, 'package.json');
  await writeFile(manifest, JSON.stringify({ scripts: { test: 'node --test verify.cjs' } }));
  const validation = new FakeValidationTools([]);
  const reviewer = new FakeApprovalReviewer('approve');
  const runner = createRunner(validation, reviewer);
  const request = { ...createRequest('Validate after the edit.'), approvalMode: 'delegate' as const,
    sessionId: 'changed-entry', approvalRootTaskId: 'changed-entry-root' };
  await withResponses([textResponse('Preparing changes.')], () => runner.run(request));
  await writeFile(manifest, JSON.stringify({ scripts: { test: 'node --test verify.cjs newer.cjs' } }));
  await withResponses([toolResponse([toolCall('changed', RUN_VALIDATION_TOOL_NAME, { script: 'test' })])], () => runner.run(request));
  assert.equal(reviewer.calls, 1);
  assert.equal(validation.runCount, 1);
  await writeFile(manifest, JSON.stringify({ scripts: { pretest: 'curl https://example.invalid', test: 'node --test verify.cjs' } }));
  const blocked = await withResponses([toolResponse([toolCall('risky', RUN_VALIDATION_TOOL_NAME, { script: 'test' })])], () => runner.run(request));
  assert.match(blocked.message, /prohibited effect/u);
  assert.equal(reviewer.calls, 1);
  assert.equal(validation.runCount, 1);
});

test('delegate reviews only metadata for an exact authorized external file and checks the file identity again', async () => {
  const externalRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-external-read-')));
  try {
    const target = path.join(externalRoot, 'reference.txt');
    await writeFile(target, 'EXTERNAL_CONTENT_ONLY_FOR_MAIN_MODEL\n');
    const request: AgentRequest = { ...createRequest('Read the attached reference.'), approvalMode: 'delegate' as const,
      sessionId: 'external-read', approvalRootTaskId: 'external-root' };
    const reviewer = new FakeApprovalReviewer('approve', async action => {
      assert.equal(action.exactAction.kind, 'external_file_access');
      assert.doesNotMatch(JSON.stringify(action), /EXTERNAL_CONTENT_ONLY_FOR_MAIN_MODEL/u);
      assert.equal(action.scopeFingerprint?.length, 64);
    });
    const responseForRead = () => toolResponse([toolCall('read-external', READ_WORKSPACE_FILE_TOOL_NAME, { path: target })]);
    const runner = createRunner(new FakeValidationTools([]), reviewer);
    await assert.rejects(withResponses([responseForRead()], () => runner.run(request)),
      (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'waiting_for_user'
        && /Authorize this exact URI/u.test(error.message) && !error.message.includes('EXTERNAL_CONTENT_ONLY_FOR_MAIN_MODEL'));
    assert.equal(reviewer.calls, 1, 'only URI metadata is reviewed before a user grant');
    request.authorizedExternalReferenceUris = [vscode.Uri.file(target).toString()];
    const authorized = await withResponses([responseForRead()], () => runner.run(request));
    assert.equal(reviewer.calls, 2);
    assert.match(authorized.approvalToolResults?.[0]?.result.content ?? '', /EXTERNAL_CONTENT_ONLY_FOR_MAIN_MODEL/u);

    const changing = new FakeApprovalReviewer('approve', async () => {
      await writeFile(target, 'A_DIFFERENT_FILE_VERSION\n');
    });
    const changed = await withResponses([responseForRead()], () => createRunner(new FakeValidationTools([]), changing).run(request));
    assert.equal(changed.approvalToolResults?.[0]?.status, 'failed');
    assert.doesNotMatch(changed.approvalToolResults?.[0]?.result.content ?? '', /A_DIFFERENT_FILE_VERSION/u);
  } finally { await rm(externalRoot, { recursive: true, force: true }); }
});

test('user-confirmable risk can approve exact fixed validation inside the project', async () => {
  if (process.platform === 'win32') return;
  const marker = path.join(workspaceRoot, 'manual.txt');
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test verify.cjs' } }));
  await writeFile(path.join(workspaceRoot, 'verify.cjs'), "require('node:fs').appendFileSync('manual.txt', 'once');");
  const review = new FakeApprovalReviewer('needs_user');
  const validation = new FakeValidationTools([]);
  const authorization = new AllowAllToolAuthorization();
  const request = { ...createRequest('Run the tests and read Problems.'), approvalMode: 'delegate' as const, sessionId: 'manual-validation' };
  const runner = new AgentRunner(undefined, undefined, validation, undefined, undefined, authorization,
    undefined, undefined, review, async (approval, _signal, verifyCurrent) => {
      assert.equal(validation.runCount, 0);
      assert.equal(approval.risk, 'high');
      assert.equal(approval.authorizationTargets, undefined);
      assert.match(approval.label, /test/u);
      assert.equal(await verifyCurrent?.(), true);
      approval.id = 'confirm-fixed-validation';
      review.configurationChanged = true;
      return true;
    });
  const response = await withResponses([
    toolResponse([toolCall('manual-validation', RUN_VALIDATION_TOOL_NAME, { script: 'test' }),
      toolCall('diagnostics', READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME, {})])
  ], () => runner.run(request));
  assert.equal(review.calls, 1);
  assert.equal(review.consumed, 1);
  assert.equal(review.userApprovals, 1);
  assert.equal(validation.runCount, 1);
  assert.equal(response.approvalToolResults?.[0]?.status, 'succeeded');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('unavailable in-loop review can wait across one hour and consume one precise manual approval', async () => {
  if (process.platform === 'win32') return;
  const validation = new FakeValidationTools([]);
  const reviewer = new FakeApprovalReviewer('unavailable', undefined, 'configuration_unavailable');
  reviewer.configurationChanged = true;
  const originalNow = Date.now;
  let saved: RunCheckpoint | undefined;
  const runner = new AgentRunner(undefined, undefined, validation, undefined, undefined, undefined,
    undefined, undefined, reviewer, async (approval, signal, verifyCurrent) => {
      assert.equal(saved?.state?.pending?.approval?.status, 'waiting');
      assert.equal(approval.reviewState, 'configuration_unavailable');
      assert.equal(approval.risk, undefined);
      assert.equal(validation.runCount, 0);
      assert.equal(reviewer.consumed, 0);
      Date.now = () => originalNow() + 3_600_001;
      assert.equal(signal?.aborted, false);
      assert.equal(await verifyCurrent?.(), true);
      approval.id = 'manual-after-one-hour';
      return true;
    });
  const request: AgentRequest = { ...createRequest('Run compile.'), approvalMode: 'delegate', sessionId: 'one-hour-manual' };
  request.executionLimits = { ...request.executionLimits, maxRunMs: 15_000 };
  try {
    const response = await withResponses([toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])],
      () => runner.run(request, { onCheckpoint: async cp => { saved = structuredClone(cp); } }));
    assert.equal(response.approvalToolResults?.[0]?.status, 'succeeded');
    assert.equal(reviewer.calls, 1);
    assert.equal(reviewer.userApprovals, 1);
    assert.equal(reviewer.consumed, 1);
    assert.equal(validation.runCount, 1);
    assert.ok(saved?.runBudget?.deadlineAt);
    assert.ok(Date.parse(saved.runBudget.deadlineAt) > Date.now());
    assert.ok(saved.usedMs < 15_000);
  } finally {
    Date.now = originalNow;
  }
});

test('interrupted in-loop approval can re-review the saved tool without replaying the Provider request or tool budget', async () => {
  if (process.platform === 'win32') return;
  const validation = new FakeValidationTools([]);
  const reviewer = new FakeApprovalReviewer('unavailable', undefined, 'invalid_response');
  const request: AgentRequest = { ...createRequest('Run compile.'), approvalMode: 'delegate', sessionId: 'resume-tool-review' };
  request.executionLimits = { ...request.executionLimits, maxToolCalls: 1 };
  const storageUri = vscode.Uri.file(path.join(workspaceRoot, 'storage')) as never;
  const runner = new AgentRunner(undefined, undefined, validation, undefined, undefined, undefined,
    storageUri, undefined, reviewer, async (approval) => {
      approval.status = 'interrupted';
      approval.resolutionReason = 'host_interrupted';
      return false;
    });
  let saved: RunCheckpoint | undefined;
  await assert.rejects(withResponses([toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])],
    () => runner.run(request, { onCheckpoint: async cp => { saved = structuredClone(cp); } })),
  (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'waiting_for_user');
  const checkpoint = normalizeRunCheckpoint(saved);
  assert.ok(checkpoint);
  assert.equal(checkpoint.status, 'interrupted');
  assert.equal(checkpoint.state?.pending?.approval?.status, 'paused');
  assert.equal(checkpoint.state?.pending?.approval?.priorReviewId, 'review-1');
  assert.equal(checkpoint.state?.pending?.executing, undefined);
  assert.equal(checkpoint.runBudget?.toolCalls, 1);
  assert.equal(validation.runCount, 0);
  assert.equal(reviewer.consumed, 0);

  const unverifiedReviewer = new FakeApprovalReviewer('approve');
  await assert.rejects(withResponses([], () => createRunner(validation, unverifiedReviewer).run({ ...request, checkpoint })),
    (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'uncertain_tool_result');
  assert.equal(unverifiedReviewer.calls, 0);
  assert.equal(validation.runCount, 0);

  const recoveredReviewer = new FakeApprovalReviewer('approve');
  const restarted = new AgentRunner(undefined, undefined, validation, undefined, undefined, undefined,
    storageUri, undefined, recoveredReviewer, async () => assert.fail('The replacement reviewer approved'));
  const response = await withResponses([], () => restarted.run({ ...request, checkpoint }, { onCheckpoint: async cp => { saved = structuredClone(cp); } }));
  assert.deepEqual(recoveredReviewer.retries, ['review-1']);
  assert.deepEqual(recoveredReviewer.recoveryProofs, ['not_dispatched']);
  assert.equal(response.approvalToolResults?.[0]?.status, 'succeeded');
  assert.equal(validation.runCount, 1);
  assert.equal(recoveredReviewer.consumed, 1);
  assert.equal(saved?.runBudget?.toolCalls, 1);
  assert.equal(saved?.modelRequests, checkpoint.modelRequests);
});

test('changing the approval model after fixed validation review prevents approval consumption and execution', async () => {
  if (process.platform === 'win32') return;
  const marker = path.join(workspaceRoot, 'invalidated.txt');
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test verify.cjs' } }));
  await writeFile(path.join(workspaceRoot, 'verify.cjs'), "require('node:fs').writeFileSync('invalidated.txt', 'ran');");
  const reviewer = new FakeApprovalReviewer('approve', async () => { reviewer.configurationChanged = true; });
  const request = { ...createRequest('Run the fixed test script.'), approvalMode: 'delegate' as const,
    sessionId: 'validation-configuration-change' };
  const runner = new AgentRunner(undefined, undefined, new ValidationToolService(), undefined, undefined, undefined,
    undefined, undefined, reviewer, async () => assert.fail('Stale reviewer configuration cannot request a click'));
  const response = await withResponses([
    toolResponse([toolCall('changed-configuration', RUN_VALIDATION_TOOL_NAME, { script: 'test' })])
  ], () => runner.run(request));
  assert.equal(reviewer.calls, 1);
  assert.equal(reviewer.userApprovals, 0);
  assert.equal(reviewer.consumed, 0);
  assert.equal(JSON.parse(response.approvalToolResults?.[0]?.result.content ?? '{}').errorType, 'approval_scope_changed');
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
});

test('external read combines exact URI permission and one read in one host request', async () => {
  const externalRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-external-read-once-')));
  try {
    const target = path.join(externalRoot, 'reference.txt');
    const uri = vscode.Uri.file(target).toString();
    await writeFile(target, 'EXTERNAL_ONE_SHOT_CONTENT');
    const reviewer = new FakeApprovalReviewer('approve', async request => {
      assert.deepEqual(request.externalAuthorization, { required: true, targets: [uri] });
      assert.equal(request.exactAction.kind, 'external_file_access');
      assert.deepEqual(request.exactAction.readLimits, { maxBytes: 48, startLine: 1, endLine: 1 });
      assert.doesNotMatch(JSON.stringify(request), /EXTERNAL_ONE_SHOT_CONTENT/u);
    });
    const workspace = new WorkspaceToolService();
    let confirmations = 0;
    const runner = new AgentRunner(workspace, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, reviewer, async (input, _signal, verifyCurrent) => {
        assert.equal(await verifyCurrent?.(), true);
        assert.equal((await workspace.inspectExternalRead(target))?.authorized, false);
        assert.deepEqual(input.authorizationTargets, [uri]);
        assert.match(input.label, /Lines 1–1 · Up to 48 bytes/u);
        assert.match(input.reason, /allow one read/u);
        confirmations++;
        input.id = 'one-read-click';
        return true;
      });
    const response = await withResponses([
      toolResponse([toolCall('one-read', READ_WORKSPACE_FILE_RANGE_TOOL_NAME, { path: target, startLine: 1.7, endLine: 1.9, maxBytes: 48 })])
    ], () => runner.run({ ...createRequest('Read the external text file.'), approvalMode: 'delegate', sessionId: 'one-read' }));
    assert.equal(confirmations, 1);
    assert.equal(reviewer.calls, 1);
    assert.equal(reviewer.userApprovals, 1);
    assert.equal(reviewer.consumed, 1);
    assert.match(response.approvalToolResults?.[0]?.result.content ?? '', /EXTERNAL_ONE_SHOT_CONTENT/u);
    assert.equal((await workspace.inspectExternalRead(target))?.authorized, false);
  } finally { await rm(externalRoot, { recursive: true, force: true }); }
});

test('an external path retargeted while awaiting a click yields no read or live grant', async () => {
  if (process.platform === 'win32') return;
  const externalRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-external-retarget-')));
  try {
    const target = path.join(externalRoot, 'reference.txt');
    const replacement = path.join(externalRoot, 'replacement.txt');
    await writeFile(target, 'INITIAL_CONTENT');
    await writeFile(replacement, 'UNAPPROVED_REPLACEMENT_CONTENT');
    const workspace = new WorkspaceToolService();
    const reviewer = new FakeApprovalReviewer('approve');
    const runner = new AgentRunner(workspace, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, reviewer, async (input, _signal, verifyCurrent) => {
        assert.equal(await verifyCurrent?.(), true);
        await rm(target);
        await symlink(replacement, target);
        input.id = 'retargeted-click';
        return true;
      });
    await assert.rejects(withResponses([
      toolResponse([toolCall('retargeted', READ_WORKSPACE_FILE_TOOL_NAME, { path: target })])
    ], () => runner.run({ ...createRequest('Read the external text file.'), approvalMode: 'delegate', sessionId: 'retargeted' })),
    (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'waiting_for_user' && /scope .*changed/u.test(error.message));
    assert.equal(reviewer.calls, 1);
    assert.equal(reviewer.userApprovals, 0);
    assert.equal(reviewer.consumed, 0);
    assert.equal((await workspace.inspectExternalRead(target))?.authorized, false);
  } finally { await rm(externalRoot, { recursive: true, force: true }); }
});

class FakeValidationTools implements ValidationToolAdapter {
  public runCount = 0;

  public constructor(private readonly results: string[]) {}

  public async readWorkspaceDiagnostics(): Promise<string> {
    return JSON.stringify({
      ok: true,
      total: 1,
      errors: 1,
      warnings: 0,
      information: 0,
      hints: 0,
      truncated: false,
      items: []
    });
  }

  public async runSafeNpmScript(): Promise<string> {
    this.runCount += 1;
    return this.results.shift() ?? validationResult(true);
  }
}

class AllowAllToolAuthorization implements ToolAuthorizationAdapter {
  public readonly toolNames: string[] = [];

  public createRunPolicy(runId: string): RunAuthorizationPolicy {
    return {
      runId,
      mediumRiskPolicy: 'always',
      authorizedScopes: [],
      deniedScopes: []
    };
  }

  public async authorize(input: {
    toolName: string;
    args: Record<string, unknown>;
    policy: RunAuthorizationPolicy;
  }): Promise<ToolAuthorizationDecision> {
    this.toolNames.push(input.toolName);
    const validation = input.toolName === RUN_VALIDATION_TOOL_NAME;
    const draftRun = input.toolName === RUN_DRAFT_TOOL_NAME;
    return {
      allowed: true,
      toolName: input.toolName,
      riskLevel: validation ? 'medium' : 'low',
      scope: validation
        ? input.args.script === 'test' ? 'validation_test' : 'validation_compile_lint'
        : draftRun ? 'draft_run_prepare' : 'draft_edit_prepare',
      source: validation ? 'configuration' : 'low_risk',
      requiresExplicitConfirmation: false
    };
  }
}

function createRunner(
  validation: ValidationToolAdapter,
  reviewer?: ApprovalReviewerAdapter,
  authorization: ToolAuthorizationAdapter = new AllowAllToolAuthorization()
): AgentRunner {
  return new AgentRunner(
    new WorkspaceToolService(),
    undefined,
    validation,
    undefined,
    undefined,
    authorization,
    undefined,
    undefined,
    reviewer
  );
}

class FakeApprovalReviewer implements ApprovalReviewerAdapter {
  public calls = 0;
  public consumed = 0;
  public userApprovals = 0;
  public historicalDenial = false;
  public configurationChanged = false;

  public readonly retries: Array<string | undefined> = [];
  public readonly recoveryProofs: Array<string | undefined> = [];

  public constructor(private readonly decision: ApprovalReviewRecord['decision'],
    private readonly onReview?: (request: ApprovalReviewRequest) => Promise<void>,
    private readonly reviewState?: ApprovalReviewState) {}

  public async review(...[request, , , , options]: Parameters<ApprovalReviewerAdapter['review']>): ReturnType<ApprovalReviewerAdapter['review']> {
    this.calls += 1;
    this.retries.push(options?.retryOf);
    this.recoveryProofs.push(options?.recovery);
    await this.onReview?.(request);
    return { status: this.decision === 'unavailable' ? 'unavailable' : 'reviewed', record: this.createRecord(request, 'auto_approval_review') };
  }

  public async createUserApproval(request: ApprovalReviewRequest): Promise<{ status: 'reviewed'; record: ApprovalReviewRecord }> {
    this.userApprovals++;
    return { status: 'reviewed', record: { ...this.createRecord(request, 'user_click'), reviewId: 'user-' + request.targetId,
      decision: 'approve', reviewState: undefined, rationale: 'User confirmed.' } };
  }

  public async consumeApproval(): Promise<void> { this.consumed++; }

  public findHistoricalDenial(request: ApprovalReviewRequest): ApprovalReviewRecord | undefined {
    return this.historicalDenial ? this.createRecord(request, 'auto_approval_review') : undefined;
  }

  public async assertReviewerConfiguration(): Promise<void> {
    if (this.configurationChanged) throw new Error('Configuration changed');
  }

  private createRecord(request: ApprovalReviewRequest, source: 'auto_approval_review' | 'user_click'): ApprovalReviewRecord {
    return {
      reviewId: `review-${this.calls}`,
      runtimeId: 'runtime',
      sessionId: request.sessionId,
      rootTaskId: request.rootTaskId,
      agentRunId: request.agentRunId,
      targetId: request.targetId,
      actionKind: request.actionKind,
      actionHash: request.actionHash,
      policyVersion: APPROVAL_POLICY_VERSION,
      approvalSource: source,
      reviewerSourceId: source === 'auto_approval_review' ? 'review-source' : '',
      reviewerModelId: source === 'auto_approval_review' ? 'review-model' : '',
      reviewerProvider: source === 'auto_approval_review' ? 'openai-responses' : 'user_click',
      decision: this.decision,
      reviewState: this.reviewState,
      risk: this.decision === 'approve' ? 'low' : 'high',
      rationale: this.decision === 'approve' ? 'Scoped model approval.' : this.decision === 'unavailable' ? 'Reviewer unavailable.'
        : this.decision === 'needs_user' ? 'The fixed test can write to the project.' : 'Denied by reviewer.',
      policyRules: this.decision === 'needs_user' ? [USER_CONFIRMABLE_RISK_RULE] : ['least_privilege'],
      createdAt: '2026-01-01T00:00:00.000Z'
    };
  }
}

function createRequest(prompt: string): AgentRequest {
  return {
    prompt,
    model: {
      id: 'responses-eval-model',
      label: 'Responses Eval Model',
      provider: 'openai-responses',
      sourceId: 'responses-eval-source',
      contextWindowTokens: 64_000,
      maxOutputTokens: 2_000
    },
    settings: {
      thinkingEnabled: false,
      reasoningEffort: 'high',
      compressionThreshold: 'balanced'
    },
    contextFiles: [],
    history: [{
      id: 'user-1',
      role: 'user',
      content: prompt,
      createdAt: '2026-01-01T00:00:00.000Z'
    }],
    language: 'en',
    requestProtocolVersion: 3,
    sourceConfig: {
      sourceId: 'responses-eval-source',
      provider: 'openai-responses',
      apiKey: 'test-key',
      baseUrl: 'https://eval.invalid/v1',
      supportsBilling: false
    },
    executionLimits: {
      maxToolIterations: 2,
      maxToolCalls: 8,
      maxRepairIterations: 2
    }
  };
}

function validationResult(ok: boolean): string {
  return JSON.stringify({
    ok,
    kind: 'npm_script',
    script: 'compile' satisfies SafeNpmScript,
    authorized: true,
    exitCode: ok ? 0 : 1,
    durationMs: 20,
    timedOut: false,
    diagnostics: {
      ok: true,
      total: ok ? 0 : 1,
      errors: ok ? 0 : 1,
      warnings: 0,
      information: 0,
      hints: 0,
      truncated: false,
      items: []
    },
    error: ok ? undefined : 'compile failed'
  });
}

interface ToolCallSpec {
  id: string;
  name: string;
  arguments: string;
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCallSpec {
  return { id, name, arguments: JSON.stringify(args) };
}

function toolResponse(calls: ToolCallSpec[]): Response {
  return completedResponse(calls.map((call) => ({
    type: 'function_call',
    call_id: call.id,
    name: call.name,
    arguments: call.arguments
  })));
}

function textResponse(text: string): Response {
  return completedResponse([{
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text }]
  }]);
}

function completedResponse(output: unknown[]): Response {
  const body = `data: ${JSON.stringify({
    type: 'response.completed',
    response: { status: 'completed', output }
  })}\n\n`;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function withResponses<T>(responses: Response[], run: () => Promise<T>): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error('No mocked provider response remains.');
    }
    return response;
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
