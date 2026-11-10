import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { AgentRunner } from '../src/agent/runner';
import { ToolEvidenceStore } from '../src/agent/evidence/store';
import { AgentInterruptedError, checkpointCopy, createRunCheckpoint, inheritTaskBudget, normalizeRunCheckpoint, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { buildProviderRequestProjection, CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION, CURRENT_PROVIDER_TOOL_SCHEMA_VERSION } from '../src/agent/providerRequestProjection';
import { getAgentSystemPrompt, getAgentToolNamesForPrompt, getAgentTools, RUN_DRAFT_TOOL_NAME } from '../src/agent/protocol';
import { normalizeUserTaskBudgets, taskBudgetFromCheckpoint } from '../src/sessions/userTaskBudget';
import type { AgentRequest } from '../src/shared/types';

type Lane = 'chat' | 'responses' | 'anthropic';
const oldUserBytes = 'Preserve old user bytes: 中文  $HOME\nsecond  line';

test('static unknown and incomplete argv reach the current tool loop, durable evidence and all three real payload projections', async () => {
  await inWorkspace(async (root, storage) => {
    for (const lane of ['chat', 'responses', 'anthropic'] as const) for (const malformed of ['unknown', 'missing'] as const) {
      const bodies: Record<string, unknown>[] = [];
      const checkpoints: RunCheckpoint[] = [];
      const input = request(lane, `${lane}-${malformed}`);
      delete input.requestProtocolVersion;
      let original: { draftRunId: string; specHash: string } | undefined;
      let corrected: { id: string; specHash: string } | undefined;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        assert.ok(strings(body).includes(oldUserBytes), `${lane}: original user bytes`);
        if (bodies.length === 1) return streaming(lane, call('bad', {
          executable: malformed === 'unknown' ? 'cat' : 'head',
          args: malformed === 'unknown' ? ['--future-option', 'README.md'] : ['-n'],
          reason: 'Read the first line without changing files.'
        }));
        const results = toolPayloads(body);
        const diagnostic = results.find(value => value.status === 'needs_replan');
        assert.ok(diagnostic, `${lane}: diagnostic is present on the wire`);
        assert.equal(diagnostic.started, false);
        assert.equal(diagnostic.executed, false);
        assert.equal((diagnostic.recovery as { allowed: boolean }).allowed, true);
        original = diagnostic as unknown as typeof original;
        if (bodies.length === 2) {
          assert.equal((diagnostic.diagnostic as { category: string }).category, malformed === 'unknown' ? 'capability' : 'invalid_argv');
          return streaming(lane, call('fixed', {
            executable: malformed === 'unknown' ? 'cat' : 'head',
            args: malformed === 'unknown' ? ['--', 'README.md'] : ['-n', '1', '--', 'README.md'],
            reason: 'Read the same file with supported exact arguments.',
            replacesDraftRun: { draftRunId: original!.draftRunId, specHash: original!.specHash }
          }));
        }
        assert.equal(bodies.length, 3);
        const pending = results.find(value => value.ok === true && value.draftRun);
        assert.ok(pending, `${lane}: corrected proposal reached the next projection`);
        corrected = pending.draftRun as typeof corrected;
        assert.notEqual(corrected!.id, original!.draftRunId);
        assert.notEqual(corrected!.specHash, original!.specHash);
        return streaming(lane);
      }) as typeof fetch;
      try {
        const result = await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
          storage as unknown as import('vscode').Uri).run(input, { onCheckpoint: async next => { checkpoints.push(checkpointCopy(next)); } });
        assert.match(result.message, /Prepared/u);
        assert.equal(bodies.length, 3);
        assert.equal(result.draftRuns?.length, 2, 'the rejected immutable proposal remains available for audit');
        assert.equal(result.draftRuns?.[0].capabilityDiagnostic?.started, false);
        assert.equal(result.draftRuns?.[1].capabilityDiagnostic, undefined);
        assert.equal(result.draftRuns?.[1].spec.replacesDraftRun?.draftRunId, original!.draftRunId);
        const checkpoint = checkpoints.at(-1)!;
        assert.ok(checkpoints.every(value => value.request.requestProtocolVersion === CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION),
          'default requests persist the same current protocol that produced the payload');
        assert.equal(new Set(checkpoints.map(value => value.taskId)).size, 1, 'correction does not create another logical task');
        assert.equal(checkpoint.commandRecoveryKeys?.length, 1);
        assert.equal(checkpoint.runBudget?.modelRequests, 3);
        assert.equal(checkpoint.runBudget?.toolCalls, 2);
        assert.equal(new Set(bodies.map(body => JSON.stringify(body.tools))).size, 1, 'schemas and tool order stay frozen across correction');
        const store = new ToolEvidenceStore(storage as unknown as import('vscode').Uri);
        for (const id of ['bad', 'fixed']) {
          const record = await store.findByToolCall(input.sessionId!, checkpoint.taskId, id);
          assert.ok(record, `${lane}: durable ${id} intent`);
          assert.equal(record.effectKind, 'proposal');
          assert.equal(record.executionStatus, 'completed');
          assert.equal(record.deliveryStatus, 'delivered');
          const raw = await store.readContent(record);
          assert.equal(record.contentHash, createHash('sha256').update(raw).digest('hex'));
          assert.ok(record.providerEnvelope, 'full evidence precedes the immutable Provider envelope');
          const visible = toolPayloads(bodies.at(-1)!).find(value => id === 'bad'
            ? value.draftRunId === original!.draftRunId
            : (value.draftRun as { id?: string } | undefined)?.id === corrected!.id);
          assert.deepEqual(JSON.parse(record.providerEnvelope), visible);
          if (id === 'bad') assert.equal(JSON.parse(raw).status, 'needs_replan');
        }
        if (lane === 'chat') assert.equal(result.toolRounds?.length, 2);
        else assert.equal(result.providerReplay?.protocol, lane === 'responses' ? 'openai-responses' : 'anthropic-messages');
      } finally { globalThis.fetch = originalFetch; }
    }
  });
});

test('a new execution segment inherits command correction, time, cost and request budgets and cannot change argv to reset the same root cause', async () => {
  await inWorkspace(async (_root, storage) => {
    const input = request('chat', 'root-budget');
    const originalFetch = globalThis.fetch;
    let first!: RunCheckpoint;
    let dispatches = 0;
    globalThis.fetch = (async () => {
      dispatches++;
      return dispatches === 1 ? streaming('chat', call('first-gap', {
        executable: 'cat', args: ['--future-first'], reason: 'Read the requested file.'
      })) : streaming('chat');
    }) as typeof fetch;
    try {
      await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
        storage as unknown as import('vscode').Uri).run(input, { onCheckpoint: async next => { first = checkpointCopy(next); } });
      assert.equal(first.commandRecoveryKeys?.length, 1);
      first.usedMs = Math.max(first.usedMs, 321);
      first.usedCostByCurrency = { '$': 0.125 };
      const ledger = normalizeUserTaskBudgets(JSON.parse(JSON.stringify({ root: taskBudgetFromCheckpoint(first) }))).root;
      assert.ok(ledger);
      const second = createRunCheckpoint(input, 0, 'new authorized continuation segment', [vscode.Uri.file(_root).toString()]);
      inheritTaskBudget(second, ledger);
      assert.notEqual(second.taskId, first.taskId);
      assert.equal(second.usedMs, first.usedMs);
      assert.deepEqual(second.usedCostByCurrency, first.usedCostByCurrency);
      assert.equal(second.modelRequests, first.modelRequests);
      assert.deepEqual(second.commandRecoveryKeys, first.commandRecoveryKeys);
      const restored = normalizeRunCheckpoint(JSON.parse(JSON.stringify(second)))!;
      assert.ok(restored);
      let stopped!: RunCheckpoint;
      dispatches = 0;
      globalThis.fetch = (async () => {
        dispatches++;
        return streaming('chat', call('different-id', { executable: 'cat', args: ['--future-second'], reason: 'Cosmetic reason changes cannot buy another retry.' }));
      }) as typeof fetch;
      await assert.rejects(new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
        storage as unknown as import('vscode').Uri).run({ ...input, checkpoint: restored },
        { onCheckpoint: async next => { stopped = checkpointCopy(next); } }),
      error => error instanceof AgentInterruptedError && error.reason === 'no_progress_loop');
      assert.equal(dispatches, 1, 'stop follows the durable repeated-root diagnostic without another model request');
      assert.equal(stopped.commandRecoveryExhausted, true);
      assert.deepEqual(stopped.commandRecoveryKeys, first.commandRecoveryKeys);
      assert.equal(stopped.runBudget?.modelRequests, first.runBudget!.modelRequests + 1);
      assert.ok(stopped.usedMs >= first.usedMs);
      assert.deepEqual(stopped.usedCostByCurrency, first.usedCostByCurrency);
      const record = await new ToolEvidenceStore(storage as unknown as import('vscode').Uri)
        .findByToolCall(input.sessionId!, second.taskId, 'different-id');
      assert.ok(record?.providerEnvelope, 'the terminal diagnostic is durable before the bounded stop');
      assert.equal(JSON.parse(record.providerEnvelope).recovery.allowed, false);
      const count = dispatches;
      await assert.rejects(new AgentRunner().run({ ...input, checkpoint: normalizeRunCheckpoint(stopped)! }),
        error => error instanceof AgentInterruptedError && error.reason === 'waiting_for_user');
      assert.equal(dispatches, count, 'restart cannot revive the exhausted execution');
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('same-response sibling capability gaps share one observation before the model can react', async () => {
  await inWorkspace(async (_root, storage) => {
    const originalFetch = globalThis.fetch;
    let dispatches = 0;
    let checkpoint!: RunCheckpoint;
    globalThis.fetch = (async (_url, init) => {
      dispatches++;
      if (dispatches === 1) {
        const calls = ['one', 'two'].map((id, index) => call(id, {
          executable: 'cat', args: [`--future-${index}`], reason: `Sibling observation ${index}`
        }));
        const event = { choices: [{ delta: { tool_calls: calls.map((tool, index) => ({
          index, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments }
        })) }, finish_reason: 'tool_calls' }] };
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      const diagnostics = toolPayloads(JSON.parse(String(init?.body))).filter(value => value.status === 'needs_replan');
      assert.equal(diagnostics.length, 2, 'each sibling has its own immutable audited diagnostic');
      assert.equal(new Set(diagnostics.map(value => value.draftRunId)).size, 2);
      for (const diagnostic of diagnostics) assert.equal((diagnostic.recovery as { allowed: boolean }).allowed, true);
      return streaming('chat');
    }) as typeof fetch;
    try {
      const result = await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
        storage as unknown as import('vscode').Uri).run(request('chat', 'sibling-gaps'),
        { onCheckpoint: async next => { checkpoint = checkpointCopy(next); } });
      assert.equal(dispatches, 2, 'the model gets one opportunity to react after the sibling batch');
      assert.equal(result.draftRuns?.length, 2);
      assert.equal(checkpoint.commandRecoveryKeys?.length, 1);
      assert.equal(checkpoint.commandRecoveryBatch?.keys.length, 1);
      assert.equal(checkpoint.commandRecoveryExhausted, undefined);
      assert.equal(checkpoint.runBudget?.toolCalls, 2);
      assert.ok(normalizeRunCheckpoint(JSON.parse(JSON.stringify(checkpoint))));
      assert.equal(normalizeRunCheckpoint({ ...checkpoint, commandRecoveryBatch: { id: 'not-a-hash', keys: [] } }), undefined);
    } finally { globalThis.fetch = originalFetch; }
  });
});

function request(lane: Lane, sessionId: string): AgentRequest {
  const provider = lane === 'responses' ? 'openai-responses' : lane === 'anthropic' ? 'anthropic-compatible' : 'openai-compatible';
  return { prompt: 'Prepare the requested local read command, preserve the goal and await execution evidence.',
    model: { id: 'capability-fixture', label: 'Fixture', sourceId: 'capability-source', provider, contextWindowTokens: 128000, maxOutputTokens: 4000 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    history: [{ id: 'old-user', role: 'user', content: 'Old request', providerContent: oldUserBytes, createdAt: '2026-01-01T00:00:00.000Z' }],
    contextFiles: [], language: 'en', sessionId, requestProtocolVersion: 15, approvalMode: 'ask', approvalRootTaskId: `root-${sessionId}`,
    sourceConfig: { sourceId: 'capability-source', provider, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', supportsBilling: false },
    executionLimits: { maxToolIterations: 6, maxModelRequests: 8 } };
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
}
function toolPayloads(body: unknown): Record<string, unknown>[] {
  return strings(body).flatMap(value => {
    try { const parsed: unknown = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? [parsed as Record<string, unknown>] : []; }
    catch { return []; }
  });
}
function call(id: string, args: Record<string, unknown>) { return { id, name: RUN_DRAFT_TOOL_NAME, arguments: JSON.stringify(args) }; }
function streaming(lane: Lane, tool?: ReturnType<typeof call>): Response {
  let events: object[];
  if (lane === 'responses') events = [{ type: 'response.completed', response: { status: 'completed', output: tool
    ? [{ type: 'function_call', id: `fc-${tool.id}`, call_id: tool.id, name: tool.name, arguments: tool.arguments }]
    : [{ type: 'message', id: 'final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Prepared; awaiting actual execution.' }] }] } }];
  else if (lane === 'anthropic') events = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    { type: 'content_block_start', index: 0, content_block: tool
      ? { type: 'tool_use', id: tool.id, name: tool.name, input: JSON.parse(tool.arguments) }
      : { type: 'text', text: 'Prepared; awaiting actual execution.' } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }
  ];
  else events = [{ choices: [{ delta: tool
    ? { tool_calls: [{ index: 0, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments } }] }
    : { content: 'Prepared; awaiting actual execution.' }, finish_reason: tool ? 'tool_calls' : 'stop' }] }];
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (lane === 'chat' ? 'data: [DONE]\n\n' : ''),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
async function inWorkspace(work: (root: string, storage: vscode.Uri) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'keepseek-capability-runtime-')));
  const before = { workspaceFolders: vscode.workspace.workspaceFolders, isTrusted: vscode.workspace.isTrusted };
  Object.assign(vscode.workspace, { isTrusted: true, workspaceFolders: [{ name: 'fixture', index: 0, uri: vscode.Uri.file(root) }] });
  try {
    await writeFile(join(root, 'README.md'), 'fixture\n');
    await work(root, vscode.Uri.file(join(root, 'storage')));
  } finally { Object.assign(vscode.workspace, before); await rm(root, { recursive: true, force: true }); }
}
