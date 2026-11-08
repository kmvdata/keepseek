import './registerVscodeStub';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { analyzeDraftRunEffects } from '../src/approvals/authorization';
import { DraftRunAuthorizationService } from '../src/runs/draftRunAuthorization';
import { SpawnDraftRunExecutor } from '../src/runs/draftRunExecutor';
import { spawnDurablyGated } from '../src/runs/durableSpawn';
import { ProjectExecutionOwner } from '../src/tasks/projectOwner';
import { ProjectResourceCoordinator, runProjectExecution } from '../src/tasks/projectResources';
import { hashDraftRunSpec } from '../src/runs/draftRunProposal';
import type { DraftRun, DraftRunSpec } from '../src/shared/types';
import type { ApprovalRecordMatch } from '../src/approvals/approvalReviewTypes';
import type { ApprovalReviewStore } from '../src/approvals/approvalReviewStore';
import { clearCreatedTerminals, createdTerminals } from './stubs/vscode';

test('delegated execution requires its matching approval record and remains single-use', async () => {
  const executor = new SpawnDraftRunExecutor();
  const draftRun = createDraftRun(['-e', 'process.stdout.write("delegated")']);
  const approvalStore = { consumeMatchingApproval: async () => ({}), findHardRunDenial: () => undefined } as unknown as ApprovalReviewStore;
  const authorization = new DraftRunAuthorizationService(approvalStore);
  const match: ApprovalRecordMatch = {
    reviewId: 'review', sessionId: draftRun.sessionId, rootTaskId: draftRun.agentRunId, agentRunId: draftRun.agentRunId,
    targetId: draftRun.id, actionKind: 'draft_run_execute', actionHash: draftRun.specHash,
    policyVersion: 1, expectedSource: 'auto_approval_review', approvalMode: 'delegate', workspaceTrusted: true
  };
  await assert.rejects(authorization.createDelegatedPermit(draftRun, () => false, match), /no longer authorized/u);
  const permit = await authorization.createDelegatedPermit(draftRun, () => true, match);
  await assert.rejects(executor.execute({ draftRun, permit, onOutput: () => {} }), /approval record/u);
  draftRun.authorizationSource = 'delegated_approver';
  const result = await executor.execute({ draftRun, permit, onOutput: () => {} });
  assert.equal(result.exitCode, 0);
  await assert.rejects(executor.execute({ draftRun, permit, onOutput: () => {} }), /already consumed/u);
  executor.dispose();
});

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
  assert.equal(outcome.started, false);
  assert.equal(outcome.phase, 'not_dispatched');
  assert.equal(output, '');
  assert.equal(executor.showTerminal(draftRun.id), false);
});

test('SpawnDraftRunExecutor distinguishes a failed launch from an executed command', async () => {
  const executor = new SpawnDraftRunExecutor();
  try {
    const missing = createDraftRun([]);
    missing.spec.executable = os.tmpdir() + '/keepseek-definitely-missing-executable';
    missing.specHash = hashDraftRunSpec(missing.spec);
    const failed = await executor.execute({ draftRun: missing,
      permit: new DraftRunAuthorizationService().createUserClickPermit(missing), onOutput: () => {} });
    assert.equal(failed.started, false);
    assert.equal(failed.phase, 'spawn_failed');
    assert.equal(failed.exitCode, undefined);
    assert.match(failed.error ?? '', /ENOENT/u);
    const actual = createDraftRun(['-e', 'process.exitCode = 3']);
    const exited = await executor.execute({ draftRun: actual,
      permit: new DraftRunAuthorizationService().createUserClickPermit(actual), onOutput: () => {} });
    assert.equal(exited.started, true);
    assert.equal(exited.phase, 'exited');
    assert.equal(exited.exitCode, 3);
  } finally { executor.dispose(); }
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

test('durable launch gate waits for recorded PID before it invokes literal target argv', async () => {
  const { mkdtemp, access, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(os.tmpdir(), 'keepseek-dispatch-gate-'));
  const target = join(directory, 'dispatched.txt');
  let recorded!: () => void;
  let allow!: () => void;
  const recording = new Promise<void>(resolve => { recorded = resolve; });
  const barrier = new Promise<void>(resolve => { allow = resolve; });
  const gate = spawnDurablyGated({
    executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"literal;$(untouched)")', target],
    cwd: directory, env: process.env,
    journal: { dispatched: async ({ pid, processGroup }) => {
      assert.ok(pid && pid > 0);
      if (process.platform !== 'win32') assert.equal(processGroup, pid);
      recorded(); await barrier;
    } }
  });
  const closed = new Promise<number | null>(resolve => gate.child.once('close', resolve));
  try {
    await recording;
    await assert.rejects(access(target));
    assert.equal(gate.started, false);
    allow();
    await gate.dispatch;
    assert.equal(await closed, 0);
    assert.equal(gate.started, true);
    const { readFile } = await import('node:fs/promises');
    assert.equal(await readFile(target, 'utf8'), 'literal;$(untouched)');
  } finally { allow(); gate.child.kill(); await rm(directory, { recursive: true, force: true }); }
});

test('durable launch gate never starts a target after journal failure or pre-dispatch cancellation', async () => {
  const { mkdtemp, access, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  for (const mode of ['journal-failed', 'cancelled'] as const) {
    const directory = await mkdtemp(join(os.tmpdir(), 'keepseek-dispatch-gate-'));
    const target = join(directory, 'must-not-exist');
    const signal = new AbortController();
    let gate!: ReturnType<typeof spawnDurablyGated>;
    gate = spawnDurablyGated({
      executable: process.execPath, args: ['-e', 'require("node:fs").writeFileSync(process.argv[1],"unexpected")', target],
      cwd: directory, env: process.env, signal: signal.signal,
      journal: { dispatched: async () => {
        if (mode === 'journal-failed') throw new Error('fixture journal write failed');
        signal.abort();
      } }
    });
    const closed = new Promise<void>(resolve => gate.child.once('close', () => resolve()));
    try {
      await gate.dispatch;
      await closed;
      assert.equal(gate.authorized, false);
      assert.equal(gate.started, false);
      assert.match(gate.launchError!, /journal write failed|cancelled/u);
      await assert.rejects(access(target));
    } finally { gate.child.kill(); await rm(directory, { recursive: true, force: true }); }
  }
});


test('actual project execution settles the durable command receipt without leaving the owner blocked', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(os.tmpdir(), 'keepseek-command-receipt-'));
  const owner = await ProjectExecutionOwner.acquire({ projectUri: directory, lockRoot: join(directory, 'locks') });
  const executor = new SpawnDraftRunExecutor();
  try {
    assert.equal(owner.isOwner, true, owner.reason);
    const resources = new ProjectResourceCoordinator(owner.projectId);
    for (const failed of [false, true]) {
      const draftRun = createDraftRun(['-e', 'process.stdout.write("journalled")']);
      draftRun.id = failed ? 'durable-launch-failed' : 'durable-launch-ok';
      draftRun.spec.cwdUri = vscode.Uri.file(directory).toString();
      if (failed) draftRun.spec.executable = join(directory, 'nonexistent-executable');
      draftRun.specHash = hashDraftRunSpec(draftRun.spec);
      const permit = new DraftRunAuthorizationService().createUserClickPermit(draftRun);
      let output = '';
      const result = await runProjectExecution({ owner, resources, scope: {
        sessionId: draftRun.sessionId, rootTaskId: draftRun.agentRunId, segmentId: 'segment', runtimeId: 'runtime'
      } }, () => executor.execute({ draftRun, permit, onOutput: chunk => { output += chunk.text; } }));
      assert.equal(result.started, !failed);
      assert.equal(result.phase, failed ? 'spawn_failed' : 'exited');
      assert.equal(output, failed ? '' : 'journalled');
      const receipt = (await owner.diagnostics()).operations.find(operation => operation.id === draftRun.id);
      assert.ok(receipt);
      assert.equal(receipt.state, failed ? 'not_dispatched' : 'completed');
      assert.ok(receipt.processId);
      assert.equal(owner.isOwner, true);
      await owner.verify();
    }
  } finally { executor.dispose(); await owner.dispose(); await rm(directory, { recursive: true, force: true }); }
});


test('a host exit before granting the launch gate cannot invoke the target', async () => {
  const { mkdtemp, access, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const directory = await mkdtemp(join(os.tmpdir(), 'keepseek-dispatch-parent-exit-'));
  const target = join(directory, 'must-not-exist');
  try {
    await promisify(execFile)(process.execPath, ['-e', `
      require(process.argv[1]);
      const {spawnDurablyGated}=require(process.argv[2]);
      spawnDurablyGated({executable:process.execPath,args:['-e','require("node:fs").writeFileSync(process.argv[1],"unexpected")',process.argv[3]],
        cwd:process.cwd(),env:process.env,journal:{dispatched:async()=>{process.exit(0)}}});
    `, require.resolve('./registerVscodeStub'), require.resolve('../src/runs/durableSpawn'), target], { timeout: 5_000 });
    await assert.rejects(access(target));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
