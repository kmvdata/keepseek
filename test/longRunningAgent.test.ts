import './registerVscodeStub';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Script } from 'node:vm';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from './stubs/vscode';
import { writeJsonAtomic } from '../src/shared/atomicStorage';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import { getScript } from '../src/webview/script';
import { WEBVIEW_TRANSLATIONS } from '../src/shared/i18n';
import { getVisibleMessages, normalizeStoredSessions } from '../src/sessions/chatSessionStore';
import { ExecutionClock, abortable, mergeDurations, normalizeDuration } from '../src/agent/executionPolicy';
import { checkpointCopy, createRunCheckpoint, normalizeRunCheckpoint, recoveryBlocker, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { AgentRunner } from '../src/agent/runner';
import { BackgroundRunCoordinator } from '../src/agent/backgroundRunCoordinator';
import { SubagentScheduler } from '../src/agent/subagents/scheduler';
import { StreamParser } from '../src/agent/providers/streamParser';
import { ResponsesStreamParser } from '../src/agent/providers/responsesStreamParser';
import { AnthropicStreamParser } from '../src/agent/providers/anthropicStreamParser';
import { OpenAICompatibleClient } from '../src/agent/providers/openAiCompatibleClient';
import { getAgentRuntimeProfile } from '../src/shared/modelProfiles';
import { getConfiguredAgentMaxExecutionMs, getConfiguredBackgroundMaxDurationMs } from '../src/shared/config';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import type { AgentRequest } from '../src/shared/types';

describe('long-running Agent execution and safe recovery', () => {
  it('normalizes unlimited values, round trips and merges positive explicit constraints', () => {
    for (const value of [undefined, null, 0, -1, NaN, Infinity, '1000']) assert.equal(normalizeDuration(value), 0);
    assert.equal(mergeDurations(0, undefined, 1234, 9000), 1234);
    assert.equal(mergeDurations(null, -1, Infinity), 0);
    assert.equal(normalizeDuration(Number.MAX_VALUE), Number.MAX_SAFE_INTEGER);
    assert.equal(JSON.parse(JSON.stringify({ duration: normalizeDuration(undefined) })).duration, 0);
    assert.equal(getConfiguredAgentMaxExecutionMs(), 0);
    assert.equal(getConfiguredBackgroundMaxDurationMs(), 0);
    for (const id of ['generic', 'deepseek-v4-flash', 'deepseek-v4-pro']) {
      for (const reasoningEffort of ['high', 'max'] as const) {
        assert.equal(getAgentRuntimeProfile({ id, label: id, provider: id.startsWith('deepseek') ? 'deepseek' : 'openai-compatible' }, { thinkingEnabled: true, reasoningEffort }).maxRunMs, 0);
      }
    }
  });

  it('runs beyond 10, 30, 60 minutes; excludes pauses and host suspension; parallel time counts once', () => {
    let now = 0;
    const clock = new ExecutionClock(0, 0, () => now);
    const release = clock.enter();
    const child = clock.enter();
    for (let second = 1; second <= 7200; second++) { now += 1000; clock.sample(); }
    assert.equal(clock.usedMs, 7_200_000);
    assert.equal(clock.signal.aborted, false);
    child(); release();
    now += 3_600_000;
    assert.equal(clock.usedMs, 7_200_000);
    const next = clock.enter();
    now += 3_600_000; // OS sleep / host unavailable
    assert.equal(clock.usedMs, 7_200_000);
    now -= 9_000_000; // clock regression cannot charge time
    assert.equal(clock.usedMs, 7_200_000);
    next(); clock.dispose();
    const bounded = new ExecutionClock(1000, 700, () => now);
    const finish = bounded.enter(); now += 300;
    assert.equal(bounded.usedMs, 1000);
    assert.equal(bounded.signal.aborted, true);
    finish(); bounded.dispose();
  });

  it('does not spend background budget while awaiting Apply or authorization', () => {
    const coordinator = new BackgroundRunCoordinator();
    coordinator.start({ sessionId: 's', workspaceKey: 'w', goal: { kind: 'repair_until_validation_passes', script: 'test', description: 'test' }, limits: { maxRounds: 3, maxDurationMs: 0, maxToolCalls: 30 } });
    coordinator.recordExecutionTime(7_200_000);
    coordinator.waitForApply('apply');
    assert.equal(coordinator.getRemainingExecutionLimits().maxRunMs, 0);
    assert.equal(coordinator.getLimitStopReason(), undefined);
    coordinator.stop('stop');
    coordinator.start({ sessionId: 's', workspaceKey: 'w', goal: { kind: 'repair_until_validation_passes', script: 'test', description: 'test' }, limits: { maxRounds: 3, maxDurationMs: 2000, maxToolCalls: 30 } });
    coordinator.recordExecutionTime(500);
    coordinator.waitForAuthorization('approve');
    assert.equal(coordinator.getRemainingExecutionLimits().maxRunMs, 1500);
    coordinator.markRunning(); coordinator.recordExecutionTime(1500);
    assert.match(coordinator.getLimitStopReason()!, /duration/u);
  });

  it('retains active tree budgets and path claims despite wall-clock age and restore', () => {
    const scheduler = new SubagentScheduler();
    const input = { treeId: 'tree', parentRunId: 'parent', ownerId: 'one', depth: 1, proposal: true, paths: ['src/a.ts'] };
    assert.equal(scheduler.reserve(input).ok, true);
    const oldNow = Date.now;
    Date.now = () => oldNow() + 10 * 60 * 60 * 1000;
    try { assert.equal(scheduler.reserve({ ...input, ownerId: 'two' }).ok, false); }
    finally { Date.now = oldNow; }
    const copy = new SubagentScheduler();
    copy.restoreTree('tree', JSON.parse(JSON.stringify(scheduler.snapshotTree('tree'))));
    assert.equal(copy.reserve({ ...input, ownerId: 'two' }).ok, false);
    copy.releaseTree('tree');
    assert.equal(copy.reserve({ ...input, ownerId: 'two' }).ok, true);
  });

  it('releases depth capacity when proposal acquisition is cancelled', async () => {
    const scheduler = new SubagentScheduler();
    const tasks: Array<() => void> = [];
    const hold = () => new Promise<void>((resolve) => tasks.push(resolve));
    const options = { depth: 1, proposal: true, language: 'en' as const };
    const first = scheduler.run(options, hold);
    const second = scheduler.run(options, hold);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const controller = new AbortController();
    const third = scheduler.run({ ...options, signal: controller.signal }, async () => assert.fail('cancelled task ran'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(third);
    let readRan = false;
    await scheduler.run({ ...options, proposal: false }, async () => { readRan = true; });
    assert.equal(readRan, true);
    tasks.forEach((release) => release()); await Promise.all([first, second]);
  });

  it('cancels authorization waits and ignores late resolutions', async () => {
    const controller = new AbortController();
    let resolve!: (value: boolean) => void;
    const waiting = abortable(new Promise<boolean>((done) => { resolve = done; }), controller.signal);
    controller.abort();
    await assert.rejects(waiting);
    resolve(true);
  });

  it('rejects incomplete Chat, Responses and Anthropic streams and observes comments separately', async () => {
    for (const parser of [new StreamParser(), new ResponsesStreamParser(), new AnthropicStreamParser()]) {
      const events: string[] = [];
      await assert.rejects(parser.parse(stream(': keepalive\r\n\r\n'), 'en', { onActivity: (kind) => events.push(kind) }));
      assert.ok(events.includes('event'));
      assert.equal(events.includes('content'), false);
    }
    await assert.rejects(new StreamParser().parse(stream('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"one","function":{"name":"tool","arguments":"{"}}]}}]}\n\n'), 'en', {}), /before completion/u);
    const activity: string[] = [];
    const complete = await new StreamParser().parse(stream('data: {"choices":[{"delta":{"reasoning_content":"thinking"},"finish_reason":"stop"}]}\r\n\r\ndata: [DONE]\r\n\r\n'), 'en', { onActivity: (kind) => activity.push(kind) });
    assert.equal(complete.message.reasoning_content, 'thinking');
    assert.ok(activity.includes('content'));
  });

  it('uses bounded retries only for explicit rejection and cancels a silent original request', async () => {
    const savedFetch = globalThis.fetch;
    const client = new OpenAICompatibleClient({ displayName: 'Test' });
    const config = { apiKey: '', baseUrl: 'https://example.invalid', maxRequestRetries: 2, requestRetryBaseMs: 0, streamIdleTimeoutMs: 0 };
    const input = { body: { model: 'test', messages: [], stream: true as const }, language: 'en' as const };
    try {
      let count = 0;
      globalThis.fetch = (async () => { count++; return new Response('rate limited', { status: 429 }); }) as typeof fetch;
      await client.createModelResponse(config, input);
      assert.equal(count, 3);
      count = 0;
      globalThis.fetch = (async () => { count++; throw new TypeError('fetch failed'); }) as typeof fetch;
      const uncertain = await client.createModelResponse(config, input);
      assert.equal(count, 1); assert.equal(uncertain.retryable, false);
      const controller = new AbortController();
      globalThis.fetch = (async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true });
      })) as typeof fetch;
      const waiting = client.createModelResponse(config, { ...input, signal: controller.signal });
      controller.abort();
      assert.equal((await waiting).failureKind, 'external_abort');
    } finally { globalThis.fetch = savedFetch; }
  });

  it('saves individual tool results and resumes exact native prefix without rerunning completed tools', async () => {
    const originalFetch = globalThis.fetch;
    let toolCount = 0;
    const workspace = new WorkspaceToolService();
    workspace.listWorkspaceFiles = async () => { toolCount++; return JSON.stringify({ ok: true, files: [] }); };
    const runner = new AgentRunner(workspace);
    let cp: RunCheckpoint | undefined;
    const controller = new AbortController();
    const bodies: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return bodies.length === 1 ? response([
        { type: 'reasoning', id: 'reason', encrypted_content: 'opaque-byte-sequence', summary: [] },
        { type: 'function_call', call_id: 'one', name: 'keepseek_list_workspace_files', arguments: '{}' },
        { type: 'function_call', call_id: 'two', name: 'keepseek_list_workspace_files', arguments: '{}' }
      ]) : response([{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] }]);
    }) as typeof fetch;
    try {
      await assert.rejects(runner.run({ ...request(), signal: controller.signal }, { onCheckpoint: async (next) => {
        cp = checkpointCopy(next);
        if (next.state?.pending?.results.one) controller.abort();
      } }));
      assert.equal(toolCount, 1);
      assert.equal(cp?.stopReason, 'user_stop');
      assert.equal(recoveryBlocker(cp!), undefined);
      assert.equal(JSON.stringify(cp).includes('secret-key'), false);
      const reloaded = normalizeRunCheckpoint(JSON.parse(JSON.stringify(cp)))!;
      const taskId = reloaded.taskId;
      const result = await runner.run({ ...request(), checkpoint: reloaded }, { onCheckpoint: async (next) => { cp = checkpointCopy(next); } });
      assert.equal(result.message, 'done');
      assert.equal(toolCount, 2); assert.equal(bodies.length, 2);
      assert.equal(cp?.taskId, taskId); assert.equal(cp?.attempt, 2);
      assert.equal(result.toolRounds?.[0].toolResults.length, 2);
      const nextInput = bodies[1].input as Array<Record<string, unknown>>;
      assert.equal(nextInput.filter((item) => item.type === 'function_call_output').length, 2);
      assert.equal(nextInput.find((item) => item.type === 'reasoning')?.encrypted_content, 'opaque-byte-sequence');
      assert.equal(JSON.stringify(bodies[0].tools), JSON.stringify(bodies[1].tools));
    } finally { globalThis.fetch = originalFetch; }
  });

  it('blocks execution when a durable intent cannot be saved; rejects malformed and uncertain checkpoints', async () => {
    const originalFetch = globalThis.fetch;
    let toolCount = 0;
    const workspace = new WorkspaceToolService();
    workspace.listWorkspaceFiles = async () => { toolCount++; return '{}'; };
    globalThis.fetch = (async () => response([{ type: 'function_call', call_id: 'one', name: 'keepseek_list_workspace_files', arguments: '{}' }])) as typeof fetch;
    try {
      await assert.rejects(new AgentRunner(workspace).run(request(), { onCheckpoint: async (cp) => {
        if (cp.state?.pending?.executing) throw new Error('disk full');
      } }), /disk full/u);
      assert.equal(toolCount, 0);
    } finally { globalThis.fetch = originalFetch; }
    const cp = createRunCheckpoint(request(), 100, 'user', []);
    cp.status = 'running'; cp.usedMs = 100;
    assert.match(recoveryBlocker(cp)!, /Time budget/u);
    assert.equal(normalizeRunCheckpoint(cp)?.stopReason, 'extension_restart');
    assert.equal(normalizeRunCheckpoint({ version: 1 }), undefined);
    assert.equal(normalizeRunCheckpoint({ ...cp, version: 900 }), undefined);
  });

  it('round trips interrupted tasks without exposing the full checkpoint or credentials to the webview', () => {
    const cp = createRunCheckpoint(request(), 0, 'default', []);
    const scope = { key: 'w', name: 'workspace', folderUris: [] };
    const sessions = normalizeStoredSessions({ sessions: [{
      id: 's', workspaceKey: 'w', messages: [{ id: 'a', role: 'assistant', content: 'partial', createdAt: new Date().toISOString(), runCheckpoint: cp }]
    }] }, scope);
    assert.equal(sessions[0].messages[0].runCheckpoint?.stopReason, 'extension_restart');
    const visible = getVisibleMessages(sessions[0].messages);
    assert.equal(visible[0].runState?.canResume, true);
    assert.equal(visible[0].runCheckpoint, undefined);
    assert.equal(JSON.stringify(visible).includes('secret-key'), false);
  });

  it('preserves the previous atomic record on disk failure and rejects changed modification baselines', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'keepseek-recovery-storage-'));
    const uri = vscode.Uri.file(join(directory, 'state.json'));
    const oldWriter = vscode.workspace.fs.writeFile;
    const oldFolders = vscode.workspace.workspaceFolders;
    try {
      await writeJsonAtomic(uri as unknown as import('vscode').Uri, { previous: true });
      vscode.workspace.fs.writeFile = async () => { throw new Error('ENOSPC'); };
      await assert.rejects(writeJsonAtomic(uri as unknown as import('vscode').Uri, { previous: false }), /ENOSPC/u);
      assert.deepEqual(JSON.parse(await readFile(uri.fsPath, 'utf8')), { previous: true });
      vscode.workspace.fs.writeFile = oldWriter;
      vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'test' }];
      const target = join(directory, 'edited.txt');
      await writeFile(target, 'user changed it');
      await assert.rejects(new SafeFileEditor().applyDraftEdit({
        id: 'edit', uri: vscode.Uri.file(target).toString(), label: 'edited.txt', action: 'modify',
        newText: 'replacement', reason: 'proposal', expectedOriginalTextHash: 'old-baseline'
      }), /cannotApplyChangedDraftTarget/u);
      assert.equal(await readFile(target, 'utf8'), 'user changed it');
    } finally {
      vscode.workspace.fs.writeFile = oldWriter;
      vscode.workspace.workspaceFolders = oldFolders;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('parses the generated webview script and has bilingual recovery/status strings', () => {
    assert.doesNotThrow(() => new Script(getScript()));
    for (const key of Object.keys(WEBVIEW_TRANSLATIONS.en).filter((key) => key.startsWith('run'))) {
      assert.ok(WEBVIEW_TRANSLATIONS['zh-CN'][key], key);
    }
  });
});

function request(): AgentRequest {
  return {
    prompt: 'Inspect files', model: { id: 'test', label: 'Test', provider: 'openai-responses', sourceId: 'test-source', contextWindowTokens: 128000 },
    settings: { thinkingEnabled: true, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    contextFiles: [], history: [{ id: 'u', role: 'user', content: 'Inspect files', createdAt: '2026-01-01T00:00:00Z' }],
    language: 'en', requestProtocolVersion: 5,
    sourceConfig: { sourceId: 'test-source', provider: 'openai-responses', baseUrl: 'https://example.invalid', apiKey: 'secret-key', supportsBilling: false }
  };
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { for (const character of text) controller.enqueue(new TextEncoder().encode(character)); controller.close(); } });
}
function response(output: unknown[]): Response {
  return new Response(stream(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output } })}\n\n`));
}
