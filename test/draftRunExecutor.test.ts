import './registerVscodeStub';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { analyzeDraftRunEffects } from '../src/runs/commandRisk';
import { DraftRunAuthorizationService } from '../src/runs/draftRunAuthorization';
import { SpawnDraftRunExecutor } from '../src/runs/draftRunExecutor';
import { hashDraftRunSpec } from '../src/runs/draftRunProposal';
import type { DraftRun, DraftRunSpec } from '../src/shared/types';

test('SpawnDraftRunExecutor passes a literal argv with shell disabled and consumes the permit once', async () => {
  const executor = new SpawnDraftRunExecutor();
  const literal = 'literal; echo must-not-run && $(must-not-expand)';
  const draftRun = createDraftRun([
    '-e',
    'process.stdout.write(process.argv[1])',
    literal
  ]);
  const permit = new DraftRunAuthorizationService().createUserClickPermit(draftRun);
  let output = '';

  const outcome = await executor.execute({
    draftRun,
    permit,
    onOutput: (chunk) => { output += chunk.text; }
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.timedOut, false);
  assert.equal(output, literal);
  assert.equal(executor.showTerminal(draftRun.id), true);
  await assert.rejects(
    executor.execute({ draftRun, permit, onOutput: () => undefined }),
    /permit was already consumed/u
  );
});

test('SpawnDraftRunExecutor stops a process at the approved timeout', async () => {
  const executor = new SpawnDraftRunExecutor();
  const draftRun = createDraftRun([
    '-e',
    'process.stdout.write("ready"); setInterval(() => undefined, 1000)'
  ], 500);
  const permit = new DraftRunAuthorizationService().createUserClickPermit(draftRun);
  let output = '';

  const outcome = await executor.execute({
    draftRun,
    permit,
    onOutput: (chunk) => { output += chunk.text; }
  });

  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.cancelled, false);
  assert.match(output, /ready/u);
});

test('SpawnDraftRunExecutor honors a pre-aborted signal without opening a process terminal', async () => {
  const executor = new SpawnDraftRunExecutor();
  const draftRun = createDraftRun(['-e', 'process.stdout.write("must-not-run")'], 4_000);
  const permit = new DraftRunAuthorizationService().createUserClickPermit(draftRun);
  const controller = new AbortController();
  controller.abort();
  let output = '';

  const outcome = await executor.execute({
    draftRun,
    permit,
    signal: controller.signal,
    onOutput: (chunk) => { output += chunk.text; }
  });

  assert.equal(outcome.cancelled, true);
  assert.equal(output, '');
  assert.equal(executor.showTerminal(draftRun.id), false);
});

function createDraftRun(args: string[], timeoutMs = 5_000): DraftRun {
  const spec: DraftRunSpec = {
    executable: process.execPath,
    args,
    reason: 'Exercise the direct-spawn executor.',
    cwdUri: vscode.Uri.file(os.tmpdir()).toString(),
    cwdLabel: os.tmpdir(),
    externalCwd: true,
    timeoutMs,
    env: []
  };
  const now = new Date().toISOString();
  return {
    id: `executor-${timeoutMs}-${args.length}`,
    spec,
    specHash: hashDraftRunSpec(spec),
    effectAssessment: analyzeDraftRunEffects(spec),
    agentRunId: 'agent-executor-test',
    sessionId: 'session-executor-test',
    messageId: 'assistant-executor-test',
    status: 'running',
    outputHead: '',
    outputTail: '',
    outputBytes: 0,
    outputTruncated: false,
    omittedOutputBytes: 0,
    createdAt: now,
    updatedAt: now
  };
}
