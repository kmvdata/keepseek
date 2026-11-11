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
import { checkpointCopy, createRunCheckpoint, inheritTaskBudget, normalizeRunCheckpoint, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { buildProviderRequestProjection, CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION, CURRENT_PROVIDER_TOOL_SCHEMA_VERSION } from '../src/agent/providerRequestProjection';
import { READ_EVIDENCE_TOOL_NAME, RUN_DRAFT_TOOL_NAME } from '../src/agent/protocol';
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
        const [observation] = checkpoint.commandRecoveryObservations!;
        assert.equal(observation.draftRunId, original!.draftRunId);
        assert.ok(observation.observedResponseId && observation.deliveredResponseId);
        assert.notEqual(observation.observedResponseId, observation.deliveredResponseId);
        assert.equal(observation.repeatedOf, undefined);
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

test('new segments inherit budgets, and same-root repetition needs a concrete diagnostic in the accepted request', async () => {
  await inWorkspace(async (_root, storage) => {
    const input = request('chat', 'root-budget');
    const originalFetch = globalThis.fetch;
    let first!: RunCheckpoint;
    let dispatches = 0;
    globalThis.fetch = (async () => {
      dispatches++;
      return dispatches === 1 ? streaming('chat', call('first-gap', {
        executable: 'cat', args: ['--future-first=one'], reason: 'Read the requested file.'
      })) : streaming('chat');
    }) as typeof fetch;
    try {
      await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
        storage as unknown as import('vscode').Uri).run(input, { onCheckpoint: async next => { first = checkpointCopy(next); } });
      assert.equal(first.commandRecoveryObservations?.length, 1);
      first.usedMs = Math.max(first.usedMs, 321);
      first.usedCostByCurrency = { '$': 0.125 };
      first.commandRecoveryKeys = [first.commandRecoveryObservations![0].key];
      first.commandRecoveryExhausted = true; // Historical stop evidence remains an audit field.
      const rootTaskId = input.approvalRootTaskId!;
      const ledger = normalizeUserTaskBudgets(JSON.parse(JSON.stringify({ [rootTaskId]: taskBudgetFromCheckpoint(first) })))[rootTaskId];
      assert.ok(ledger);
      const second = createRunCheckpoint(input, 0, 'new authorized continuation segment', [vscode.Uri.file(_root).toString()]);
      inheritTaskBudget(second, ledger);
      assert.notEqual(second.taskId, first.taskId);
      assert.equal(second.usedMs, first.usedMs);
      assert.deepEqual(second.usedCostByCurrency, first.usedCostByCurrency);
      assert.equal(second.modelRequests, first.modelRequests);
      assert.deepEqual(jsonValue(second.commandRecoveryObservations), first.commandRecoveryObservations);
      const restored = normalizeRunCheckpoint(JSON.parse(JSON.stringify(second)))!;
      assert.ok(restored);
      let latest!: RunCheckpoint;
      dispatches = 0;
      globalThis.fetch = (async (_url, init) => {
        dispatches++;
        const diagnostics = toolPayloads(JSON.parse(String(init?.body))).filter(value => value.status === 'needs_replan');
        if (dispatches === 1) {
          assert.equal(diagnostics.length, 0, 'the new segment did not project the earlier observation');
          return streaming('chat', call('fresh-response', { executable: 'cat', args: ['--future-first=two'], reason: 'Read the file.' }));
        }
        if (dispatches === 2) {
          assert.equal(diagnostics.length, 1);
          assert.equal((diagnostics[0].recovery as { allowed: boolean }).allowed, true);
          return streaming('chat', [
            call('repeated', { executable: 'cat', args: ['README.md', '--future-first=three'], reason: 'Cosmetic reason change.' }),
            call('independent', { executable: 'head', args: ['-n', '1', 'README.md'], reason: 'Read an independent line.' })
          ]);
        }
        assert.equal(dispatches, 3);
        assert.equal((diagnostics[1].recovery as { allowed: boolean }).allowed, false);
        return streaming('chat');
      }) as typeof fetch;
      const response = await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
        storage as unknown as import('vscode').Uri).run({ ...input, checkpoint: restored },
        { onCheckpoint: async next => { latest = checkpointCopy(next); } });
      assert.equal(dispatches, 3);
      assert.deepEqual(response.draftRuns?.[2].spec.args, ['-n', '1', 'README.md'], 'repetition must not swallow independent work');
      assert.equal(latest.commandRecoveryExhausted, true);
      assert.deepEqual(latest.commandRecoveryKeys, first.commandRecoveryKeys);
      const [earlier, fresh, repeated] = latest.commandRecoveryObservations!;
      assert.equal(earlier.key, fresh.key);
      assert.equal(fresh.repeatedOf, undefined);
      assert.equal(repeated.key, fresh.key);
      assert.equal(repeated.repeatedOf, fresh.draftRunId);
      assert.equal(repeated.observedResponseId, fresh.deliveredResponseId);
      assert.equal(latest.runBudget?.modelRequests, first.runBudget!.modelRequests + 3);
      assert.ok(latest.usedMs >= first.usedMs);
      assert.deepEqual(latest.usedCostByCurrency, first.usedCostByCurrency);
      const record = await new ToolEvidenceStore(storage as unknown as import('vscode').Uri)
        .findByToolCall(input.sessionId!, second.taskId, 'repeated');
      assert.ok(record?.providerEnvelope, 'the terminal diagnostic is durable before the bounded stop');
      assert.equal(JSON.parse(record.providerEnvelope).recovery.allowed, false);
      assert.deepEqual(jsonValue(normalizeRunCheckpoint(latest)?.commandRecoveryObservations), latest.commandRecoveryObservations);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('same-response sibling gaps deduplicate one root cause without capping distinct causes', async () => {
  await inWorkspace(async (_root, storage) => {
    const originalFetch = globalThis.fetch;
    let dispatches = 0;
    let checkpoint!: RunCheckpoint;
    globalThis.fetch = (async (_url, init) => {
      dispatches++;
      if (dispatches === 1) {
        const cases = [['--future-one=one'], ['--future-one=two'], ['--future-two'], ['-n'], ['-n', 'not-a-count']];
        const calls = cases.map((args, index) => call(`sibling-${index}`, {
          executable: 'head', args, reason: `Sibling observation ${index}`
        }));
        const event = { choices: [{ delta: { tool_calls: calls.map((tool, index) => ({
          index, id: tool.id, type: 'function', function: { name: tool.name, arguments: tool.arguments }
        })) }, finish_reason: 'tool_calls' }] };
        return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      const diagnostics = toolPayloads(JSON.parse(String(init?.body))).filter(value => value.status === 'needs_replan');
      assert.equal(diagnostics.length, 5, 'each sibling has its own immutable audited diagnostic');
      assert.equal(new Set(diagnostics.map(value => value.draftRunId)).size, 5);
      for (const diagnostic of diagnostics) assert.equal((diagnostic.recovery as { allowed: boolean }).allowed, true);
      return streaming('chat');
    }) as typeof fetch;
    try {
      const result = await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
        storage as unknown as import('vscode').Uri).run(request('chat', 'sibling-gaps'),
        { onCheckpoint: async next => { checkpoint = checkpointCopy(next); } });
      assert.equal(dispatches, 2, 'the model gets one opportunity to react after the sibling batch');
      assert.equal(result.draftRuns?.length, 5);
      const observations = checkpoint.commandRecoveryObservations!;
      assert.equal(new Set(observations.map(item => item.key)).size, 4);
      assert.equal(new Set(observations.map(item => item.observedResponseId)).size, 1);
      assert.equal(new Set(observations.map(item => item.deliveredResponseId)).size, 1);
      assert.ok(observations.every(item => !item.repeatedOf));
      assert.equal(checkpoint.commandRecoveryExhausted, undefined);
      assert.equal(checkpoint.runBudget?.toolCalls, 5);
      const restored = normalizeRunCheckpoint(JSON.parse(JSON.stringify(checkpoint)));
      assert.deepEqual(jsonValue(restored?.commandRecoveryObservations), observations);
      const rootTaskId = checkpoint.request.approvalRootTaskId!;
      const taskBudget = normalizeUserTaskBudgets(JSON.parse(JSON.stringify({ [rootTaskId]: taskBudgetFromCheckpoint(checkpoint) })))[rootTaskId];
      assert.deepEqual(jsonValue(taskBudget?.commandRecoveryObservations), observations);
      assert.equal(normalizeRunCheckpoint({ ...checkpoint, commandRecoveryBatch: { id: 'not-a-hash', keys: [] } }), undefined);
    } finally { globalThis.fetch = originalFetch; }
  });
});

test('a compact preflight envelope delivers ordinary diagnostics but a reference alone needs concrete evidence', async () => {
  await inWorkspace(async (_root, storage) => {
    const originalFetch = globalThis.fetch;
    const originalConfig = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = () => ({
      ...originalConfig(), get: <T>(key: string, fallback: T): T => key === 'providerInlineResultMaxChars' ? 1024 as T : fallback
    });
    const option = `--future-${'x'.repeat(350)}`;
    const input = request('chat', 'paged-preflight');
    const blocked = (id: string) => call(id, { executable: 'head', args: [option], reason: 'Read a bounded line.' });
    const requests: string[] = [];
    let reference: string;
    let firstDraftId: string;
    let final!: RunCheckpoint;
    globalThis.fetch = (async (_url, init) => {
      const raw = String(init?.body);
      requests.push(raw);
      const payloads = toolPayloads(JSON.parse(raw));
      const drafts = payloads.filter(item => item.status === 'needs_replan');
      const pages = payloads.filter(item => item.mode === 'bytes' && item.evidenceRef === reference && item.bodyDelivered === true);
      if (requests.length === 1) return streaming('chat', [
        call('ordinary', { executable: 'git', args: ['log', '--future-ordinary'], reason: 'Read local commit history.' }), blocked('reference-only')
      ]);
      if (requests.length === 2) {
        const ordinary = drafts[0];
        assert.equal(ordinary.completeInline, false, 'the common option diagnostic survives a compact envelope');
        assert.equal((ordinary.diagnostic as { token?: string }).token, '--future-ordinary');
        assert.equal((ordinary.diagnostic as { argumentIndex?: number }).argumentIndex, 1);
        assert.ok((ordinary.diagnostic as { reason?: string }).reason);
        const compact = drafts[1];
        assert.equal(compact.completeInline, false, 'oversized token needs bounded paging');
        assert.equal((compact.diagnostic as { reason?: string }).reason, undefined);
        reference = String(compact.evidenceRef);
        firstDraftId = String(compact.draftRunId);
        return streaming('chat', [blocked('while-reference-only'), call('page-1', { evidenceRef: reference, maxChars: 768 }, READ_EVIDENCE_TOOL_NAME)]);
      }
      if (requests.length === 3) {
        assert.equal((drafts[2].recovery as { allowed: boolean }).allowed, true, 'a reference alone does not give a correction opportunity');
        assert.equal(pages.length, 1);
        assert.ok(pages[0].nextCursor);
        return streaming('chat', call('page-2', { evidenceRef: reference, cursor: pages[0].nextCursor, maxChars: 768 }, READ_EVIDENCE_TOOL_NAME));
      }
      if (drafts.length === 3 && pages.at(-1)?.hasMore) {
        return streaming('chat', call(`page-${pages.length + 1}`, { evidenceRef: reference, cursor: pages.at(-1)!.nextCursor, maxChars: 768 }, READ_EVIDENCE_TOOL_NAME));
      }
      if (drafts.length === 3) {
        assert.ok(pages.length >= 2, 'diagnostic bytes span more than one page');
        assert.equal(pages.at(-1)!.hasMore, false, 'the last page closes the diagnostic snapshot');
        return streaming('chat', blocked('after-concrete-pages'));
      }
      assert.equal((drafts[3].recovery as { allowed: boolean }).allowed, false, 'complete paged diagnostic makes the later proposal a repeat');
      return streaming('chat');
    }) as typeof fetch;
    try {
      await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
        storage as unknown as import('vscode').Uri).run(input, { onCheckpoint: async next => { final = checkpointCopy(next); } });
      const [ordinary, original, beforeRead, afterRead] = final.commandRecoveryObservations!;
      assert.ok(ordinary.deliveredResponseId);
      assert.equal(original.draftRunId, firstDraftId!);
      assert.equal(original.deliveredResponseId, afterRead.observedResponseId);
      assert.equal(beforeRead.deliveredResponseId, undefined);
      assert.equal(beforeRead.repeatedOf, undefined);
      assert.equal(afterRead.repeatedOf, original.draftRunId);
    } finally { globalThis.fetch = originalFetch; vscode.workspace.getConfiguration = originalConfig; }
  });
});

test('checkpoint re-entry and a physical reconnect preserve one accepted correction opportunity', async () => {
  await inWorkspace(async (_root, storage) => {
    const originalFetch = globalThis.fetch;
    const originalConfig = vscode.workspace.getConfiguration;
    vscode.workspace.getConfiguration = () => ({
      ...originalConfig(), get: <T>(key: string, fallback: T): T => key === 'requestRetryBaseMs' ? 0 as T : fallback
    });
    const input = request('chat', 'reconnect-preflight');
    const requests: string[] = [];
    const blocked = (id: string) => call(id, { executable: 'head', args: ['--future-option'], reason: 'Read one line.' });
    let restored!: RunCheckpoint;
    let final!: RunCheckpoint;
    let pendingAfterNetworkFailure = false;
    const controller = new AbortController();
    globalThis.fetch = (async (_url, init) => {
      requests.push(String(init?.body));
      if (requests.length === 1) return streaming('chat', blocked('first-blocked'));
      if (requests.length === 2) throw new TypeError('fetch failed', { cause: Object.assign(new Error('socket lost'), { code: 'ECONNRESET' }) });
      if (requests.length === 3) {
        assert.equal(requests[1], requests[2], 'retry dispatches the identical frozen projection');
        return streaming('chat', blocked('after-reconnect'));
      }
      assert.equal(requests.length, 4);
      return streaming('chat');
    }) as typeof fetch;
    try {
      const runner = () => new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
        storage as unknown as import('vscode').Uri);
      await assert.rejects(runner().run({ ...input, signal: controller.signal }, {
        onCheckpoint: async next => {
          if (!restored && next.state?.pending?.results['first-blocked']) {
            restored = normalizeRunCheckpoint(checkpointCopy(next))!;
            controller.abort();
          }
        }
      }));
      assert.ok(restored.state?.pending?.commandRecoveryResponse?.id);
      assert.equal(restored.commandRecoveryObservations?.[0].deliveredResponseId, undefined);
      assert.equal(requests.length, 1);
      await runner().run({ ...input, checkpoint: restored }, {
        onCheckpoint: async next => {
          if (requests.length === 2 && !next.state?.pending) {
            pendingAfterNetworkFailure = true;
            assert.equal(next.commandRecoveryObservations?.[0].deliveredResponseId, undefined);
          }
          final = checkpointCopy(next);
        }
      });
      assert.equal(requests.length, 4);
      assert.ok(pendingAfterNetworkFailure);
      const [first, repeated] = final.commandRecoveryObservations!;
      assert.equal(first.observedResponseId, restored.state!.pending!.commandRecoveryResponse!.id);
      assert.equal(first.deliveredResponseId, repeated.observedResponseId);
      assert.equal(repeated.repeatedOf, first.draftRunId);
      assert.equal(final.runBudget?.toolCalls, 2, 'the completed first tool was recovered without executing again');
      assert.equal(final.runBudget?.toolRounds, 2);
    } finally { globalThis.fetch = originalFetch; vscode.workspace.getConfiguration = originalConfig; }
  });
});

test('a blocked emulated proposal keeps its audit identity across interruption before evidence completion', async () => {
  await inWorkspace(async (_root, storage) => {
    const originalFetch = globalThis.fetch;
    const input = request('chat', 'preflight-evidence-boundary');
    const controller = new AbortController();
    let restored!: RunCheckpoint;
    let final!: RunCheckpoint;
    let dispatches = 0;
    let toolCallId: string;
    globalThis.fetch = (async (_url, init) => {
      if (++dispatches === 1) return emulatedPreflight('Read one line.');
      const payloads = strings(JSON.parse(String(init?.body))).flatMap(content => Array.from(content.matchAll(/\nResult:\n([^\n]+)/gu), match => JSON.parse(match[1])));
      const payload = payloads.find(item => item.status === 'needs_replan');
      assert.equal(payload?.draftRunId, restored.state!.draftRuns[0].id);
      assert.equal(payload?.specHash, restored.state!.draftRuns[0].specHash);
      assert.equal((payload?.recovery as { allowed: boolean }).allowed, true);
      if (dispatches === 2) return emulatedPreflight('Same bounded read, different wording.');
      assert.equal(payloads[1].recovery.allowed, false);
      return streaming('chat');
    }) as typeof fetch;
    try {
      const runner = () => new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined,
        storage as unknown as import('vscode').Uri);
      await assert.rejects(runner().run({ ...input, signal: controller.signal }, {
        onCheckpoint: async next => {
          if (!restored && next.state?.pending?.executing && next.state.draftRuns.length) {
            toolCallId = next.state.pending.executing.id;
            restored = normalizeRunCheckpoint(checkpointCopy(next))!;
            controller.abort();
          }
        }
      }));
      assert.ok(restored);
      assert.equal(restored.state?.pending?.dsmlToolCalls, true);
      const evidenceStore = new ToolEvidenceStore(storage as unknown as import('vscode').Uri);
      assert.equal((await evidenceStore.findByToolCall(input.sessionId!, restored.taskId, toolCallId!))?.executionStatus, 'executing');
      const result = await runner().run({ ...input, checkpoint: restored }, { onCheckpoint: async next => { final = checkpointCopy(next); } });
      assert.equal(dispatches, 3);
      assert.equal(result.draftRuns?.length, 2);
      assert.equal(result.draftRuns?.[0].id, restored.state!.draftRuns[0].id);
      assert.equal(final.commandRecoveryObservations?.[1].repeatedOf, restored.state!.draftRuns[0].id);
      assert.equal(final.runBudget?.toolCalls, 2);
      assert.equal(final.runBudget?.toolRounds, 2);
      const evidence = await new ToolEvidenceStore(storage as unknown as import('vscode').Uri)
        .findByToolCall(input.sessionId!, restored.taskId, toolCallId!);
      assert.equal(evidence?.executionStatus, 'completed');
      assert.equal(JSON.parse(evidence!.providerEnvelope!).draftRunId, restored.state!.draftRuns[0].id);
    } finally { globalThis.fetch = originalFetch; }
  });
});

function emulatedPreflight(reason: string): Response {
  const content = '<||DSML||tool_calls><||DSML||invoke name="keepseek_run_draft">'
    + '<||DSML||parameter name="executable" string="true">head</||DSML||parameter>'
    + '<||DSML||parameter name="args" string="false">["--future-option"]</||DSML||parameter>'
    + `<||DSML||parameter name="reason" string="true">${reason}</||DSML||parameter>`
    + '</||DSML||invoke></||DSML||tool_calls>';
  const event = { choices: [{ delta: { content }, finish_reason: 'stop' }] };
  return new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
    status: 200, headers: { 'Content-Type': 'text/event-stream' }
  });
}

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
function jsonValue(value: unknown): unknown { return value === undefined ? undefined : JSON.parse(JSON.stringify(value)); }
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
function call(id: string, args: Record<string, unknown>, name = RUN_DRAFT_TOOL_NAME) { return { id, name, arguments: JSON.stringify(args) }; }
function streaming(lane: Lane, tool?: ReturnType<typeof call> | Array<ReturnType<typeof call>>): Response {
  const tools = tool === undefined ? [] : Array.isArray(tool) ? tool : [tool];
  let events: object[];
  if (lane === 'responses') events = [{ type: 'response.completed', response: { status: 'completed', output: tools.length
    ? tools.map(call => ({ type: 'function_call', id: `fc-${call.id}`, call_id: call.id, name: call.name, arguments: call.arguments }))
    : [{ type: 'message', id: 'final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Prepared; awaiting actual execution.' }] }] } }];
  else if (lane === 'anthropic') events = [
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    ...(tools.length ? tools.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.arguments) }))
      : [{ type: 'text', text: 'Prepared; awaiting actual execution.' }]).flatMap((block, index) => [
        { type: 'content_block_start', index, content_block: block }, { type: 'content_block_stop', index }
      ]),
    { type: 'message_delta', delta: { stop_reason: tools.length ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }
  ];
  else events = [{ choices: [{ delta: tools.length
    ? { tool_calls: tools.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) }
    : { content: 'Prepared; awaiting actual execution.' }, finish_reason: tools.length ? 'tool_calls' : 'stop' }] }];
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
