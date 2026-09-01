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
import { clearCreatedTerminals, createdTerminals } from './stubs/vscode';

test('SpawnDraftRunExecutor passes a literal argv with shell disabled and consumes the permit once', async () => {
  clearCreatedTerminals();
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
  assert.equal(createdTerminals.length, 1);
  assert.equal(createdTerminals[0]?.showCount, 0);
  assert.equal(executor.showTerminal(draftRun.id), true);
  assert.equal(createdTerminals[0]?.showCount, 1);
  await assert.rejects(
    executor.execute({ draftRun, permit, onOutput: () => undefined }),
    /permit was already consumed/u
  );
});

test('SpawnDraftRunExecutor reuses one hidden terminal for consecutive runs in the same session', async () => {
  clearCreatedTerminals();
  const executor = new SpawnDraftRunExecutor();
  try {
    const first = createDraftRun(['-e', 'process.stdout.write("first")']);
    first.id = 'executor-shared-terminal-first';
    const second = createDraftRun(['-e', 'process.stdout.write("second")']);
    second.id = 'executor-shared-terminal-second';
    const authorization = new DraftRunAuthorizationService();

    await executor.execute({
      draftRun: first,
      permit: authorization.createUserClickPermit(first),
      onOutput: () => undefined
    });
    await executor.execute({
      draftRun: second,
      permit: authorization.createUserClickPermit(second),
      onOutput: () => undefined
    });

    assert.equal(createdTerminals.length, 1);
    assert.equal(createdTerminals[0]?.name, 'KeepSeek DraftRuns');
    assert.equal(createdTerminals[0]?.showCount, 0);
    assert.equal(executor.showTerminal(first.id), true);
    assert.equal(executor.showTerminal(second.id), true);
    assert.equal(createdTerminals[0]?.showCount, 2);
  } finally {
    executor.dispose();
  }
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

test('SpawnDraftRunExecutor settles when a detached descendant keeps inherited output open', {
  skip: process.platform === 'win32',
  timeout: 8_000
}, async () => {
  const executor = new SpawnDraftRunExecutor();
  const childCode = [
    'const { spawn } = require("node:child_process");',
    'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 10000)"],',
    '  { detached: true, stdio: "inherit" });',
    'process.stdout.write(String(descendant.pid) + "\\n");',
    'descendant.unref();'
  ].join('\n');
  const draftRun = createDraftRun(['-e', childCode], 4_000);
  const permit = new DraftRunAuthorizationService().createUserClickPermit(draftRun);
  let output = '';
  let descendantPid = 0;
  const emergencyCleanup = setTimeout(() => {
    descendantPid = Number(output.trim());
    stopProcess(descendantPid);
  }, 5_000);

  const startedAt = Date.now();
  try {
    const outcome = await executor.execute({
      draftRun,
      permit,
      onOutput: (chunk) => { output += chunk.text; }
    });
    descendantPid = Number(output.trim());

    assert.ok(Date.now() - startedAt < 3_000);
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.timedOut, false);
    assert.equal(outcome.cancelled, false);
    assert.match(outcome.error ?? '', /output streams did not close/u);
  } finally {
    clearTimeout(emergencyCleanup);
    stopProcess(descendantPid || Number(output.trim()));
    executor.dispose();
  }
});

test('SpawnDraftRunExecutor force-settles a timeout when escaped output holders survive termination', {
  skip: process.platform === 'win32',
  timeout: 6_000
}, async () => {
  const executor = new SpawnDraftRunExecutor();
  const childCode = [
    'const { spawn } = require("node:child_process");',
    'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 10000)"],',
    '  { detached: true, stdio: "inherit" });',
    'process.stdout.write(String(descendant.pid) + "\\n");',
    'descendant.unref();',
    'setInterval(() => undefined, 10000);'
  ].join('\n');
  const draftRun = createDraftRun(['-e', childCode], 300);
  const permit = new DraftRunAuthorizationService().createUserClickPermit(draftRun);
  let output = '';
  let descendantPid = 0;
  const emergencyCleanup = setTimeout(() => {
    descendantPid = Number(output.trim());
    stopProcess(descendantPid);
  }, 3_500);

  const startedAt = Date.now();
  try {
    const outcome = await executor.execute({
      draftRun,
      permit,
      onOutput: (chunk) => { output += chunk.text; }
    });
    descendantPid = Number(output.trim());

    assert.ok(Date.now() - startedAt < 3_000);
    assert.equal(outcome.timedOut, true);
    assert.equal(outcome.cancelled, false);
  } finally {
    clearTimeout(emergencyCleanup);
    stopProcess(descendantPid || Number(output.trim()));
    executor.dispose();
  }
});

test('SpawnDraftRunExecutor force-settles direct terminal cancellation', {
  skip: process.platform === 'win32',
  timeout: 6_000
}, async () => {
  const executor = new SpawnDraftRunExecutor();
  const childCode = [
    'const { spawn } = require("node:child_process");',
    'const descendant = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 10000)"],',
    '  { detached: true, stdio: "inherit" });',
    'process.stdout.write(String(descendant.pid) + "\\n");',
    'descendant.unref();',
    'setInterval(() => undefined, 10000);'
  ].join('\n');
  const draftRun = createDraftRun(['-e', childCode], 5_000);
  const permit = new DraftRunAuthorizationService().createUserClickPermit(draftRun);
  let output = '';
  let descendantPid = 0;
  let ready!: () => void;
  const outputReady = new Promise<void>((resolve) => { ready = resolve; });
  const emergencyCleanup = setTimeout(() => {
    descendantPid = Number(output.trim());
    stopProcess(descendantPid);
  }, 3_500);

  try {
    const execution = executor.execute({
      draftRun,
      permit,
      onOutput: (chunk) => {
        output += chunk.text;
        if (Number.isInteger(Number(output.trim()))) ready();
      }
    });
    await outputReady;
    assert.equal(executor.cancel(draftRun.id), true);
    const outcome = await execution;
    descendantPid = Number(output.trim());

    assert.equal(outcome.cancelled, true);
    assert.equal(outcome.timedOut, false);
  } finally {
    clearTimeout(emergencyCleanup);
    stopProcess(descendantPid || Number(output.trim()));
    executor.dispose();
  }
});

function stopProcess(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // The detached test descendant already exited.
  }
}

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
