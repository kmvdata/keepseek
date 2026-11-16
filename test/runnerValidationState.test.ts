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
  READ_EVIDENCE_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME
} from '../src/agent/protocol';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { ValidationToolService, type ValidationToolAdapter } from '../src/agent/tools/validationTools';
import type {
  AgentRequest,
  SafeNpmScript,
  ToolAuthorizationDecision
} from '../src/shared/types';
import { AgentInterruptedError, createRunCheckpoint, normalizeRunCheckpoint, type RunCheckpoint } from '../src/agent/runCheckpoint';
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
    await createRunner(validation).run({ ...createRequest('Implement the change.'), approvalMode: 'ask' })
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
    await createRunner(validation).run({ ...createRequest('Fix the compile failure.'), approvalMode: 'ask' })
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
  for (const approvalMode of ['ask', 'approve-all'] as const) {
    const validation = new FakeValidationTools([]);
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
    ], async () => await createRunner(validation).run(request));

    assert.equal(response.draftEdits.length, 0);
    assert.equal(response.draftRuns?.length, 0);
    const results = response.toolRounds?.[0]?.toolResults ?? [];
    assert.equal(JSON.parse(results[0]?.content ?? '{}').ok, true);
    for (const result of results.slice(1)) {
      assert.equal(JSON.parse(result.content).errorType, 'plan_phase_implementation_blocked');
    }
  }
});

test('a crash after a completed validation recovers neutral replay and the exact result without another launch', async t => {
  const validation = new FakeValidationTools([validationResult(true)]);
  const storageUri = vscode.Uri.file(path.join(workspaceRoot, 'storage')) as never;
  const create = () => new AgentRunner(undefined, undefined, validation, undefined, undefined, storageUri);
  const request: AgentRequest = { ...createRequest('Run compile.'), approvalMode: 'ask', sessionId: 'result-recovery' };
  const original = ToolEvidenceStore.prototype.saveProviderEnvelope;
  let interrupted = false;
  t.mock.method(ToolEvidenceStore.prototype, 'saveProviderEnvelope', async function (this: ToolEvidenceStore,
    ...args: Parameters<ToolEvidenceStore['saveProviderEnvelope']>) {
    if (!interrupted) {
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
  assert.ok(checkpoint.state?.pending?.executing?.evidenceRef);

  const recovered = await withResponses([], () => create().run({ ...request, checkpoint: snapshotCheckpoint(checkpoint) }));
  assert.equal(validation.runCount, 1, 'completed validation is never launched again');
  const providerResult = recovered.toolRounds?.[0]?.toolResults[0]?.content ?? '';
  assert.match(providerResult, /durationMs/u);
});

for (const approvalMode of ['ask', 'approve-all'] as const) {
  test(`unavailable npm validation does not stop a local Git task under ${approvalMode}`, async () => {
    const manifest = path.join(workspaceRoot, 'package.json');
    for (const manifestExists of [false, true]) {
      if (manifestExists) await writeFile(manifest, JSON.stringify({ scripts: { test: 'node --test' } }));
      else await rm(manifest);
      const validation = new FakeValidationTools([]);
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
      ], () => createRunner(validation).run(request));

      const result = JSON.parse(response.toolRounds?.[0]?.toolResults[0]?.content ?? '{}');
      assert.equal(result.errorType, 'validation_unavailable');
      assert.equal(result.executed, false);
      assert.match(result.error, manifestExists ? /does not define "compile"/u : /no package\.json/u);
      assert.equal(response.runDetails.toolCalls[0]?.status, 'failed');
      assert.equal(validation.runCount, 0);
      assert.equal(response.repairLoop.iteration, 0);
      assert.equal(response.repairLoop.stopReason, undefined);
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
  const validation = new FakeValidationTools([]);
  const request = { ...createRequest('Run compile.'), approvalMode: 'approve-all' as const, sessionId: 'dangling-package' };
  const response = await withResponses([
    toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])
  ], () => createRunner(validation).run(request));

  const result = JSON.parse(response.toolRounds?.[0]?.toolResults[0]?.content ?? '{}');
  assert.equal(result.errorType, 'validation_preflight_failed');
  assert.equal(result.executed, false);
  assert.equal(validation.runCount, 0);
});

test('approve-all runs each fixed validation after an applied DraftEdit and delivers the real results', async () => {
  if (process.platform === 'win32') return;
  const entry = 'node --test verify.cjs';
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { compile: entry, lint: entry, test: entry } }));
  await writeFile(path.join(workspaceRoot, 'verify.cjs'), [
    "const fs = require('node:fs');",
    "require('node:assert/strict').equal(fs.readFileSync('result.txt', 'utf8'), 'ready');",
    "fs.appendFileSync('ran.log', process.env.npm_lifecycle_event + '\\n');"
  ].join('\n'));
  const runner = createRunner(new ValidationToolService());
  const request = createRequest('Create result.txt and run compile, lint and test.');
  request.approvalMode = 'approve-all';
  request.approvalRootTaskId = 'root-validation';
  request.sessionId = 'session-validation';
  const draft = await withResponses([
    toolResponse([toolCall('edit', CREATE_DRAFT_EDIT_TOOL_NAME, { path: 'result.txt', content: 'ready', reason: 'Create fixture result' })]),
    textResponse('Prepared the requested edit.')
  ], () => runner.run(request));
  assert.equal(draft.draftEdits.length, 1);
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
    const round = response.toolRounds?.[0]?.toolResults[0];
    const result = JSON.parse(round?.content ?? '{}');
    assert.equal(result.ok, true, round?.content);
    assert.equal(result.executed, true);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /tests 1/u);
  }
  assert.equal(await readFile(path.join(workspaceRoot, 'ran.log'), 'utf8'), 'compile\nlint\ntest\n');
});

test('ask uses its existing validation authorization and cannot bypass a local tool denial', async () => {
  if (process.platform === 'win32') return;
  const validation = new FakeValidationTools([]);
  const compile = () => toolResponse([toolCall('ask-compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })]);
  const runner = createRunner(validation);
  const allowed = await withResponses([compile(), textResponse('Compile completed.')],
    () => runner.run({ ...createRequest('Run the fixed compile entry.'), approvalMode: 'ask' }));
  assert.equal(JSON.parse(allowed.toolRounds?.[0]?.toolResults[0].content ?? '{}').ok, true);
  const deniedRunner = createRunner(Object.assign(new FakeValidationTools([]), { denyAsUser: true }));
  const denied = await withResponses([compile(), textResponse('Compile was denied.')],
    () => deniedRunner.run({ ...createRequest('Run the fixed compile entry.'), approvalMode: 'ask' }));
  assert.equal(JSON.parse(denied.toolRounds?.[0]?.toolResults[0].content ?? '{}').errorType, 'approval_denied');
  assert.equal(validation.runCount, 1, 'a denied validation never reaches the local adapter');
});

test('approve-all runs a fixed validation only with a complete, unchanged launch snapshot', async () => {
  if (process.platform === 'win32') return;
  const validation = new FakeValidationTools([]);
  const request = { ...createRequest('Run the fixed compile entry.'), approvalMode: 'approve-all' as const };
  const compile = () => toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })]);
  const complete = await withResponses([compile()], () => createRunner(validation).run(request));
  assert.equal(JSON.parse(complete.toolRounds?.[0]?.toolResults[0].content ?? '{}').ok, true);
  assert.equal(validation.runCount, 1);
  await writeFile(path.join(workspaceRoot, '.npmrc'), 'ignore-scripts=false\n');
  const blocked = await withResponses([compile(), textResponse('Compile was blocked.')],
    () => createRunner(new FakeValidationTools([])).run(request));
  assert.match(blocked.message, /prohibited effect/u);
  assert.equal(validation.runCount, 1);
});

test('a shell -c argument in a fixed validation script reaches real execution under approve-all', async () => {
  if (process.platform === 'win32') return;
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({
    scripts: { compile: "sh -c 'printf ready > validation-marker'" }
  }));
  const request = { ...createRequest('Run the fixed compile entry.'), approvalMode: 'approve-all' as const };
  const response = await withResponses([toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })])],
    () => createRunner(new ValidationToolService()).run(request));
  const round = response.toolRounds?.[0]?.toolResults[0];
  assert.equal(JSON.parse(round?.content ?? '{}').ok, true, round?.content);
  assert.equal(await readFile(path.join(workspaceRoot, 'validation-marker'), 'utf8'), 'ready');
});

test('a validation budget stop does not execute the remaining queued validation', async () => {
  if (process.platform === 'win32') return;
  const validation = new FakeValidationTools([validationResult(true)]);
  const request: AgentRequest = { ...createRequest('Run the fixed compile entry.'), approvalMode: 'approve-all',
    sessionId: 'validation-budget' };
  request.executionLimits = { ...request.executionLimits, maxValidationRuns: 1 };
  const response = await withResponses([
    toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' }),
      toolCall('compile-after', RUN_VALIDATION_TOOL_NAME, { script: 'compile' })]),
    textResponse('The compile budget was exhausted.')
  ], () => createRunner(validation).run(request));
  assert.equal(validation.runCount, 1);
  const results = response.toolRounds?.[0]?.toolResults ?? [];
  assert.equal(JSON.parse(results[0]?.content ?? '{}').ok, true);
  assert.equal(JSON.parse(results[1]?.content ?? '{}').errorType, 'validation_run_limit_exhausted');
});

test('a fixed validation runs only with an unchanged lifecycle snapshot; a changed launch has zero effects', async () => {
  if (process.platform === 'win32') return;
  const marker = path.join(workspaceRoot, 'ran.txt');
  const manifest = path.join(workspaceRoot, 'package.json');
  const entry = 'node --test verify.cjs';
  await writeFile(path.join(workspaceRoot, 'verify.cjs'), "require('node:fs').writeFileSync('ran.txt', 'executed');");
  const request = { ...createRequest('Run the exact test script.'), approvalMode: 'approve-all' as const,
    sessionId: 'snapshot-test' };
  for (const change of [true, false]) {
    await writeFile(manifest, JSON.stringify({ scripts: { test: entry } }));
    const response = await withResponses([
      toolResponse([toolCall('snapshot-validation', RUN_VALIDATION_TOOL_NAME, { script: 'test' })])
    ], () => {
      if (change) {
        // Retarget the lifecycle scripts before the launch snapshot is verified.
        void writeFile(manifest, JSON.stringify({ scripts: { pretest: 'node --test verify.cjs', test: entry } }));
      }
      return createRunner(new ValidationToolService()).run(request);
    });
    const content = response.toolRounds?.[0]?.toolResults[0]?.content ?? '{}';
    assert.equal(JSON.parse(content).ok, !change, content);
    await assert.rejects(readFile(marker), { code: 'ENOENT' });
  }
});

test('a changed fixed entry still runs, while a risky lifecycle script is blocked before launch', async () => {
  if (process.platform === 'win32') return;
  const manifest = path.join(workspaceRoot, 'package.json');
  await writeFile(manifest, JSON.stringify({ scripts: { test: 'node --test verify.cjs' } }));
  const validation = new FakeValidationTools([]);
  const runner = createRunner(validation);
  const request = { ...createRequest('Validate after the edit.'), approvalMode: 'approve-all' as const,
    sessionId: 'changed-entry', approvalRootTaskId: 'changed-entry-root' };
  await withResponses([textResponse('Preparing changes.')], () => runner.run(request));
  await writeFile(manifest, JSON.stringify({ scripts: { test: 'node --test verify.cjs newer.cjs' } }));
  await withResponses([toolResponse([toolCall('changed', RUN_VALIDATION_TOOL_NAME, { script: 'test' })])], () => runner.run(request));
  assert.equal(validation.runCount, 1);
  await writeFile(manifest, JSON.stringify({ scripts: { pretest: 'curl https://example.invalid', test: 'node --test verify.cjs' } }));
  const blocked = await withResponses([toolResponse([toolCall('risky', RUN_VALIDATION_TOOL_NAME, { script: 'test' })])], () => runner.run(request));
  assert.match(blocked.message, /prohibited effect/u);
  assert.equal(validation.runCount, 1);
});

test('an external read needs exact URI authorization and a never-granted file stays unreadable', async () => {
  const externalRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-external-read-')));
  try {
    const target = path.join(externalRoot, 'reference.txt');
    await writeFile(target, 'EXTERNAL_CONTENT_ONLY_FOR_MAIN_MODEL\n');
    const request: AgentRequest = { ...createRequest('Read the attached reference.'), approvalMode: 'approve-all',
      sessionId: 'external-read', approvalRootTaskId: 'external-root' };
    const responseForRead = () => toolResponse([toolCall('read-external', READ_WORKSPACE_FILE_TOOL_NAME, { path: target })]);
    const runner = createRunner(new FakeValidationTools([]));
    await assert.rejects(withResponses([responseForRead()], () => runner.run(request)),
      (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'waiting_for_user'
        && /Authorize this exact URI/u.test(error.message) && !error.message.includes('EXTERNAL_CONTENT_ONLY_FOR_MAIN_MODEL'));
    request.authorizedExternalReferenceUris = [vscode.Uri.file(target).toString()];
    const authorized = await withResponses([responseForRead(), textResponse('Read the authorized reference once.')],
      () => runner.run(request));
    assert.match(authorized.toolRounds?.[0]?.toolResults[0]?.content ?? '', /EXTERNAL_CONTENT_ONLY_FOR_MAIN_MODEL/u);

    const unapproved = path.join(externalRoot, 'other.txt');
    await writeFile(unapproved, 'A_DIFFERENT_FILE_VERSION\n');
    // Without the exact URI grant the read never returns file bytes: it interrupts
    // for the user's own decision instead.
    await assert.rejects(withResponses([toolResponse([toolCall('read-other', READ_WORKSPACE_FILE_TOOL_NAME, { path: unapproved })])],
      () => runner.run(request)),
    (error: unknown) => !String(error).includes('A_DIFFERENT_FILE_VERSION'));
  } finally { await rm(externalRoot, { recursive: true, force: true }); }
});

test('approve-all validation executes once without requesting any user click', async () => {
  if (process.platform === 'win32') return;
  const marker = path.join(workspaceRoot, 'manual.txt');
  await writeFile(path.join(workspaceRoot, 'package.json'), JSON.stringify({ scripts: { test: 'node --test verify.cjs' } }));
  await writeFile(path.join(workspaceRoot, 'verify.cjs'), "require('node:fs').appendFileSync('manual.txt', 'once');");
  const validation = new ValidationToolService();
  const request = { ...createRequest('Run the tests and read Problems.'), approvalMode: 'approve-all' as const,
    sessionId: 'manual-validation' };
  const response = await withResponses([
    toolResponse([toolCall('manual-validation', RUN_VALIDATION_TOOL_NAME, { script: 'test' }),
      toolCall('diagnostics', READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME, {})])
  ], () => createRunner(validation).run(request));
  const round = response.toolRounds?.[0]?.toolResults ?? [];
  assert.equal(JSON.parse(round[0]?.content ?? '{}').ok, true, round[0]?.content);
  assert.equal(JSON.parse(round[1]?.content ?? '{}').ok, true);
  assert.equal(await readFile(marker, 'utf8'), 'once');
});

test('a validation paused at its tool budget keeps the deadline and resumes only through a granted segment', async () => {
  if (process.platform === 'win32') return;
  const validation = new FakeValidationTools([validationResult(true)]);
  let saved: RunCheckpoint | undefined;
  const request: AgentRequest = { ...createRequest('Run compile and read Problems.'), approvalMode: 'ask', sessionId: 'tool-budget-pause' };
  request.executionLimits = { ...request.executionLimits, maxToolCalls: 1 };
  const response = await withResponses([
    toolResponse([toolCall('compile', RUN_VALIDATION_TOOL_NAME, { script: 'compile' }),
      toolCall('diagnostics', READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME, {})])
  ], () => createRunner(validation).run(request, { onCheckpoint: async cp => { saved = structuredClone(cp); } }));
  assert.equal(validation.runCount, 1);
  const checkpoint = normalizeRunCheckpoint(saved);
  assert.ok(checkpoint);
  assert.equal(checkpoint.state?.budgetStopReason, 'tool_call_budget_exhausted');
  assert.ok(checkpoint.runBudget?.deadlineAt, 'a paused tool budget keeps the remaining run deadline');
  assert.equal(response.runDetails.budgetPause?.resumable, true);
});

test('an external read needs the exact URI grant and never leaves the workspace tool authorized', async () => {
  const externalRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-external-read-once-')));
  try {
    const target = path.join(externalRoot, 'reference.txt');
    const uri = vscode.Uri.file(target).toString();
    await writeFile(target, 'EXTERNAL_ONE_SHOT_CONTENT');
    const workspace = new WorkspaceToolService();
    const runner = createRunner(new FakeValidationTools([]));
    const request = { ...createRequest('Read the external text file.'), approvalMode: 'approve-all' as const, sessionId: 'one-read',
      authorizedExternalReferenceUris: [uri] };
    assert.equal((await workspace.inspectExternalRead(target))?.authorized, false, 'authorization is per-run, never global');
    const response = await withResponses([
      toolResponse([toolCall('one-read', READ_WORKSPACE_FILE_RANGE_TOOL_NAME, { path: target, startLine: 1.7, endLine: 1.9, maxBytes: 48 })]),
      textResponse('Read the externally referenced file once.')
    ], () => runner.run(request));
    assert.match(response.toolRounds?.[0]?.toolResults[0]?.content ?? '', /EXTERNAL_ONE_SHOT_CONTENT/u);
    assert.equal((await workspace.inspectExternalRead(target))?.authorized, false);
  } finally { await rm(externalRoot, { recursive: true, force: true }); }
});

test('a retargeted external path cannot borrow the grant of another exact URI', async () => {
  if (process.platform === 'win32') return;
  const externalRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-external-retarget-')));
  try {
    const target = path.join(externalRoot, 'reference.txt');
    const replacement = path.join(externalRoot, 'replacement.txt');
    await writeFile(target, 'INITIAL_CONTENT');
    await writeFile(replacement, 'UNAPPROVED_REPLACEMENT_CONTENT');
    const workspace = new WorkspaceToolService();
    const runner = createRunner(new FakeValidationTools([]));
    const request = { ...createRequest('Read the external text file.'), approvalMode: 'approve-all' as const,
      sessionId: 'retargeted', authorizedExternalReferenceUris: [vscode.Uri.file(target).toString()] };
    await rm(target);
    await symlink(replacement, target);
    await assert.rejects(withResponses([
      toolResponse([toolCall('retargeted', READ_WORKSPACE_FILE_TOOL_NAME, { path: target })])
    ], () => runner.run(request)),
    (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'waiting_for_user');
    assert.equal((await workspace.inspectExternalRead(target))?.authorized, false);
  } finally { await rm(externalRoot, { recursive: true, force: true }); }
});

class FakeValidationTools implements ValidationToolAdapter {
  public runCount = 0;
  public denyAsUser = false;

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
    if (this.denyAsUser) {
      return JSON.stringify({ ok: false, errorType: 'approval_denied', executed: false, error: 'The user denied this run.' });
    }
    this.runCount += 1;
    return this.results.shift() ?? validationResult(true);
  }
}


function createRunner(validation: ValidationToolAdapter): AgentRunner {
  return new AgentRunner(new WorkspaceToolService(), undefined, validation);
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
