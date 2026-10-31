import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from './stubs/vscode';
import { buildProviderRequestProjection, normalizeProviderMessages } from '../src/agent/providerRequestProjection';
import { resolveProviderRequestBudget } from '../src/agent/requestBudget';
import { createContextUsageEstimate } from '../src/agent/contextUsage';
import { ToolResultAdmissionController } from '../src/agent/toolResultAdmission';
import { ToolEvidenceStore } from '../src/agent/evidence/store';
import { prepareEvidenceEnvelope } from '../src/agent/evidence/shaping';
import { SessionObjectStore } from '../src/sessions/sessionObjectStore';
import { GlobalSessionStorage } from '../src/sessions/globalSessionStorage';
import { ChatSessionStore } from '../src/sessions/chatSessionStore';
import { snapshotCheckpoint, snapshotSession } from '../src/sessions/persistenceSnapshot';
import { PerformanceTrace } from '../src/agent/logging/performanceTrace';
import { observeNoProgress, visibleProgressFingerprint } from '../src/agent/contextEpoch';
import { deriveHistoryProtection } from '../src/agent/historyProtection';
import { createRunCheckpoint, normalizeRunCheckpoint } from '../src/agent/runCheckpoint';
import type { AgentRequest, ChatSession } from '../src/shared/types';

function request(): AgentRequest {
  return { model: { id: 'fixture', label: 'fixture', provider: 'qwencloud', contextWindowTokens: 1024000, maxOutputTokens: 393192 },
    prompt: 'task', contextFiles: [], language: 'en', requestProtocolVersion: 10,
    settings: { thinkingEnabled: true, reasoningEffort: 'high', compressionThreshold: 'balanced' }, history: [
      { id: 'u', role: 'user', content: 'task', createdAt: '' },
      { id: 'a', role: 'assistant', content: 'done', createdAt: '', toolRounds: [{
        assistantContent: '', reasoningContent: 'reasoning '.repeat(100000),
        toolCalls: [{ id: 'c', type: 'function', function: { name: 'keepseek_list_workspace_files', arguments: '{}' } }],
        toolResults: [{ toolCallId: 'c', content: '{"files":[]}' }]
      }] }
    ] };
}
test('source-final projection, context usage, result admission and dispatch budget agree without reasoning', () => {
  const r = request(), before = JSON.stringify(r.history);
  const p = buildProviderRequestProjection({ ...r, agentSettings: r.settings });
  assert.equal(JSON.stringify(p.messages).includes('reasoning_content'), false);
  const budget = resolveProviderRequestBudget({ model: r.model, provider: 'qwencloud', body: { model: r.model.id, messages: p.messages, tools: p.tools, stream: true } });
  const usage = createContextUsageEstimate({ ...r, messages: r.history, agentSettings: r.settings, outputReserveTokens: 0, safetyReserveTokens: 0 });
  assert.equal(usage.usedTokensEstimate, budget.estimatedInputTokens);
  const admission = new ToolResultAdmissionController(1024000).decide({ estimatedInputTokens: usage.usedTokensEstimate,
    configuredMaxOutputTokens: 393192, phase: 'tool', remainingBatchResults: 0 });
  assert.equal(admission.shouldRollover, budget.needsCompaction);
  assert.equal(admission.outputReserveTokens, 393192);
  assert.equal(JSON.stringify(r.history), before);
  assert.deepEqual(normalizeProviderMessages(p.messages, 'qwencloud'), p.messages);
  const deepseek = buildProviderRequestProjection({ ...r, agentSettings: r.settings, provider: 'deepseek' });
  assert.ok(JSON.stringify(deepseek.messages).includes('reasoning_content'));
  const long = { ...r, history: Array.from({ length: 40 }, (_, i) => ({ ...r.history[i % 2], id: `history-${i}` })) };
  const capped = buildProviderRequestProjection({ ...long, agentSettings: r.settings, maxProjectionTokens: 20000 });
  assert.equal(capped.historyProjection.history.length, 40, 'unsent reasoning must not trigger the history fallback cap');
});

test('evidence pages retain root identity, advance UTF-8 ranges, and explicitly block zero capacity', async () => {
  const store = new ToolEvidenceStore();
  const scope = { sessionId: 'session', taskId: 'task' };
  const intent = (id: string, name = 'search') => ({ ...scope, toolCallId: id, toolName: name, argumentsHash: id, effectKind: 'read' as const });
  const content = '中文🙂"\\\n'.repeat(400);
  const root = await store.complete(await store.ensureIntent(intent('root')), content);
  let cursor: string | undefined, delivered = '';
  for (let i = 0; i < 100; i++) {
    const page = await store.read({ ...scope, evidenceRef: root.evidenceRef, cursor, maxChars: 2000 });
    const raw = JSON.stringify(page);
    const record = await store.complete(await store.ensureIntent(intent(`read-${i}`, 'keepseek_read_evidence')), raw);
    const blocked = JSON.parse(prepareEvidenceEnvelope({ record, rawContent: raw, inlineTokenAllowance: 0, inlineCharLimit: 48000 }).content);
    assert.equal(blocked.ok, false); assert.equal(blocked.bodyDelivered, false); assert.equal(blocked.evidenceRef, root.evidenceRef);
    const shaped = prepareEvidenceEnvelope({ record, rawContent: raw, inlineTokenAllowance: 500, inlineCharLimit: 1200 });
    const value = JSON.parse(shaped.content);
    assert.equal(value.evidenceRef, root.evidenceRef);
    assert.equal(value.contentHash, root.contentHash);
    assert.ok(value.content.length > 0);
    assert.ok(!value.content.includes('\ufffd'));
    delivered += value.content;
    await store.saveProviderEnvelope(record, shaped.content, shaped.completeInline);
    assert.equal((await store.findByRef(record.evidenceRef, 'session', 'task'))?.providerEnvelope, shaped.content);
    if (!value.hasMore) break;
    assert.ok(Number(value.nextCursor.slice(2)) > Number((cursor ?? 'b:0').slice(2)));
    cursor = value.nextCursor;
  }
  assert.equal(delivered, content);
  assert.equal((await store.read({ ...scope, evidenceRef: root.evidenceRef, cursor: 'bad' })).errorType, 'invalid_evidence_cursor');
  assert.equal((await store.read({ ...scope, sessionId: 'other', evidenceRef: root.evidenceRef })).errorType, 'evidence_not_found');
});

test('session object migration preserves legacy bytes, lazy archives and small durable updates', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-object-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'session.json'), uri = vscode.Uri.file(path) as never;
  const cp = createRunCheckpoint(request(), 0, 'test', []); cp.status = 'completed';
  const session: ChatSession = { id: 's', title: 's', isFavorite: false, workspaceKey: 'w', workspaceName: 'w', workspaceFolders: [],
    createdAt: '', updatedAt: '', messages: Array.from({ length: 55 }, (_, i) => ({ id: String(i), role: 'assistant', content: 'done', createdAt: '', runCheckpoint: { ...cp, taskId: `t${i}` } })) };
  const old = JSON.stringify({ version: 2, workspaceKey: 'w', session }); await writeFile(path, old);
  const storage = new SessionObjectStore(uri);
  await storage.save(snapshotSession(session));
  const manifest = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(manifest.version, 3);
  assert.equal(await readFile(join(root, 'session.json.objects', 'legacy-v2.json'), 'utf8'), old);
  let written = 0;
  const original = vscode.workspace.fs.writeFile;
  vscode.workspace.fs.writeFile = async (target, bytes) => { written += bytes.byteLength; return original(target, bytes); };
  try { session.updatedAt = 'next'; await storage.save(snapshotSession(session)); }
  finally { vscode.workspace.fs.writeFile = original; }
  assert.ok(written < 100000, `small update wrote ${written}`);
  const fresh = new SessionObjectStore(uri);
  const restored = await fresh.load(JSON.parse(await readFile(path, 'utf8')));
  assert.equal(restored.messages.length, 55);
  assert.ok(restored.messages.every(m => !m.runCheckpoint && m.runCheckpointArchive));
  const archive = await fresh.loadCheckpoint(restored.messages[0].runCheckpointArchive!.objectHash) as typeof cp;
  assert.equal(archive.taskId, 't0'); assert.deepEqual(archive.request.history, cp.request.history);
  const stale = new SessionObjectStore(uri); await stale.load(JSON.parse(await readFile(path, 'utf8')));
  await fresh.save(snapshotSession(restored));
  await assert.rejects(() => stale.save(restored), /Stale/);
  const files = await readdir(join(root, 'session.json.objects'));
  assert.ok(files.length < 400, 'shared history deduplicates across 55 checkpoints');
  const header = JSON.parse(await readFile(path, 'utf8')).header;
  await writeFile(join(root, 'session.json.objects', `${header}.json`), '{}');
  await assert.rejects(() => new SessionObjectStore(uri).load(JSON.parse(require('node:fs').readFileSync(path, 'utf8'))), /integrity/);
});

test('committed historical interrupted checkpoints unload while the latest recovery point remains live', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-interrupted-archives-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cp = createRunCheckpoint({ ...request(), history: [] }, 10000, 'test', []);
  cp.status = 'interrupted'; cp.stopReason = 'user_stop'; cp.usedMs = 5000;
  const session: ChatSession = { id: 's', title: 's', isFavorite: false, workspaceKey: 'w', workspaceName: 'w', workspaceFolders: [],
    createdAt: '', updatedAt: '', messages: [0, 1, 2].map(i => ({ id: `m${i}`, role: 'assistant', content: '', createdAt: '',
      runCheckpoint: { ...cp, taskId: `t${i}` } })) };
  session.messages[0].runCheckpoint!.state = { messages: [], toolRounds: [], draftEdits: [], draftRuns: [], reasoningParts: [],
    turn: 1, toolCallCount: 1, validationRunCount: 0, toolResultTokens: 0,
    repairLoop: { status: 'idle', iteration: 0, maxIterations: 0, pendingDraftEditIds: [] },
    pending: { response: { message: { role: 'assistant', content: null } }, results: {} } };
  const store = new ChatSessionStore(new GlobalSessionStorage(vscode.Uri.file(root) as never), 'en', { key: 'w', name: 'w', folderUris: [] });
  Object.assign(store, { sessions: [session], activeSessionIdValue: session.id });
  await store.persist();
  assert.ok(session.messages.slice(0, 2).every(m => !m.runCheckpoint && m.runCheckpointArchive));
  assert.equal(session.messages[2].runCheckpoint?.usedMs, 5000);
  assert.equal(session.messages[2].runCheckpoint?.maxExecutionMs, 10000);
  assert.equal(session.messages[2].runCheckpointArchive, undefined);
  assert.equal(session.messages[0].runCheckpointArchive?.pendingTool, true);
  assert.deepEqual(deriveHistoryProtection(session.messages, []).pendingMessageIds, ['m0']);
  const restored = await new GlobalSessionStorage(vscode.Uri.file(root) as never).loadWorkspace({ key: 'w', name: 'w', folderUris: [] });
  assert.deepEqual(deriveHistoryProtection(restored.sessions[0].messages, []).pendingMessageIds, ['m0']);
  delete restored.sessions[0].messages[1].runCheckpointArchive!.pendingTool;
  assert.deepEqual(deriveHistoryProtection(restored.sessions[0].messages, []).pendingMessageIds, ['m0', 'm1'], 'old archive metadata remains conservative');
});

test('checkpoint persistence snapshots isolate mutable pending journals without recopying frozen history', () => {
  const cp = createRunCheckpoint(request(), 0, 'test', []);
  const first = snapshotCheckpoint(cp); cp.usedMs = 123;
  const next = snapshotCheckpoint(cp);
  assert.equal(first.usedMs, 0); assert.equal(next.usedMs, 123);
  assert.equal(first.request.history, next.request.history);
  assert.ok(Object.isFrozen(next.request.history));
});

test('154 settled receipts release active protection, but pending and unknown work remain protected without changing audit', () => {
  const r = request();
  const history = Array.from({ length: 154 }, (_, i) => ({ id: `receipt-${i}`, role: (i % 2 ? 'user' : 'assistant') as 'user' | 'assistant',
    content: `Host receipt ${i}`, createdAt: '', contextMeta: { isProtected: true, protectedReason: 'draft_edit_result' },
    toolRounds: r.history[1].toolRounds }));
  r.history = [r.history[0], ...history];
  const original = JSON.stringify(r.history);
  const artifacts = history.map((m, i) => ({ messageId: m.id, status: i === 0 ? 'pending' : i === 1 ? 'executing' : 'applied' }));
  const state = deriveHistoryProtection(r.history, artifacts);
  const p = buildProviderRequestProjection({ ...r, agentSettings: r.settings, contextCompression: {
    version: 1, summaries: [], protectedMessageIds: history.map(m => m.id), protectionState: state
  } });
  assert.deepEqual(state.pendingMessageIds, ['receipt-0', 'receipt-1']);
  assert.equal(state.settledMessageIds.length, 152);
  assert.equal(p.historyProjection.protectedMessageIds.length, 4);
  assert.equal(p.historyProjection.recentMessageIds.length, 15); // configured eight recent user turns
  assert.equal(p.historyProjection.compressibleMessageIds.length, 137);
  assert.equal(JSON.stringify(r.history), original);
});

test('progress remembers individual facts across alternating batches and ignores reference identities', () => {
  const visible = (id: string, text: string, offset = 0) => visibleProgressFingerprint('keepseek_read_evidence', JSON.stringify({
    ok: true, evidenceRef: id, contentHash: 'same-hash', content: text, cursor: `b:${offset}`, query: id
  }))!;
  assert.equal(visible('one', 'data'), visible('two', 'data'));
  assert.equal(visibleProgressFingerprint('search', '{"ok":true,"completeInline":false,"evidenceRef":"new"}'), undefined);
  const a = visible('a', 'A'), b = visible('b', 'B');
  let state = observeNoProgress(undefined, [a]).state;
  state = observeNoProgress(state, [b]).state;
  const warn = observeNoProgress(state, [a, b]);
  assert.equal(warn.action, 'warn');
  assert.equal(observeNoProgress(warn.state, [b]).action, 'stop');
  // A new delivered range or asynchronous host status transition is progress.
  assert.equal(observeNoProgress(warn.state, [visible('a', 'A', 1)]).action, 'none');
  assert.notEqual(visible('a', 'A', 1), a);
  for (let i = 0; i < 100; i++) {
    const next = observeNoProgress(state, [visible('a', `file-${i}`, i)]);
    assert.equal(next.action, 'none'); state = next.state;
  }
  assert.ok(state.recent!.length <= 64);
});

test('migration and commit failures preserve authority, retry idempotently and refuse active or foreign writers', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-fault-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'session.json'), uri = vscode.Uri.file(path) as never;
  const cp = createRunCheckpoint({ ...request(), history: [] }, 10000, 'test', []); cp.status = 'interrupted'; cp.usedMs = 5000;
  const session: ChatSession = { id: 's', title: 's', isFavorite: false, workspaceKey: 'w', workspaceName: 'w', workspaceFolders: [],
    createdAt: '', updatedAt: '', messages: [{ id: 'a', role: 'assistant', content: '', createdAt: '', runCheckpoint: cp }] };
  const old = JSON.stringify({ version: 2, workspaceKey: 'w', session }, null, 2); await writeFile(path, old);
  const originalRename = vscode.workspace.fs.rename, originalWrite = vscode.workspace.fs.writeFile;
  const storage = new SessionObjectStore(uri);
  vscode.workspace.fs.writeFile = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
  try { await assert.rejects(() => storage.save(snapshotSession(session)), /disk full/); }
  finally { vscode.workspace.fs.writeFile = originalWrite; }
  assert.equal(await readFile(path, 'utf8'), old);
  vscode.workspace.fs.rename = async (a, b, options) => {
    if (b.fsPath === path) throw new Error('manifest interrupted');
    return originalRename(a, b, options);
  };
  try { await assert.rejects(() => storage.save(snapshotSession(session)), /manifest interrupted/); }
  finally { vscode.workspace.fs.rename = originalRename; }
  assert.equal(await readFile(path, 'utf8'), old);
  assert.equal(await readFile(join(root, 'session.json.objects', 'legacy-v2.json'), 'utf8'), old);
  await new SessionObjectStore(uri).save(snapshotSession(session));
  const fresh = new SessionObjectStore(uri);
  const restored = await fresh.load(JSON.parse(await readFile(path, 'utf8')));
  assert.equal(restored.messages[0].runCheckpoint!.usedMs, 5000);
  assert.equal(restored.messages[0].runCheckpoint!.maxExecutionMs, 10000);
  await fresh.save(snapshotSession(restored));
  await writeFile(join(root, 'session.json.objects', 'writer.lock'), JSON.stringify({ pid: process.pid }));
  await assert.rejects(() => fresh.save(restored), /active writer/);
  await rm(join(root, 'session.json.objects', 'writer.lock'));
  const other = new SessionObjectStore(vscode.Uri.file(join(root, 'foreign.json')) as never);
  await assert.rejects(() => other.save({ ...session, messages: [{ ...session.messages[0], runCheckpoint: undefined,
    runCheckpointArchive: { version: 1, objectHash: 'a'.repeat(64), summary: { taskId: 't', status: 'completed', canResume: false, usedMs: 0, maxExecutionMs: 0, limitSource: 'test', attempt: 0, modelRequests: 0, retries: 0, steps: 0 } } }] }), /ENOENT/);
  cp.status = 'running'; await writeFile(path, JSON.stringify({ version: 2, session }));
  await assert.rejects(() => new SessionObjectStore(uri).save(snapshotSession(session)), /still marked running/);
});

test('lightweight performance tail rotates, survives detailed payload volume and bounds slow-disk backlog', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-perf-tail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'run.jsonl');
  const trace = new PerformanceTrace(vscode.Uri.file(path) as never, 'run', 2048, 4096);
  const original = vscode.workspace.fs.writeFile;
  let release!: () => void, first = true;
  const gate = new Promise<void>(resolve => { release = resolve; });
  vscode.workspace.fs.writeFile = async (uri, bytes) => {
    if (first) { first = false; await gate; }
    return original(uri, bytes);
  };
  try {
    trace.record({ type: 'upstream_attempt_start', requestId: 'first' });
    const draining = trace.flush();
    for (let i = 0; i < 1000; i++) {
      trace.record({ type: 'tool_result_raw', toolName: 'read', durationMs: i, content: 'secret body'.repeat(3000) });
      void trace.flush();
    }
    release(); await draining;
  } finally { release(); vscode.workspace.fs.writeFile = original; }
  for (let i = 0; i < 100; i++) { trace.record({ type: 'checkpoint_store', durationMs: i }); await trace.flush(); }
  trace.record({ type: 'run_end', stopReason: 'completed', requestId: 'tail' }); await trace.flush();
  const names = (await readdir(root)).filter(x => x.endsWith('.jsonl'));
  assert.ok(names.length <= 4);
  const segments = await Promise.all(names.map(name => readFile(join(root, name), 'utf8')));
  assert.ok(segments.every(x => Buffer.byteLength(x) <= 2048));
  assert.ok(segments.some(x => x.includes('tail')));
  assert.ok(segments.every(x => !x.includes('secret body')));
  const index = JSON.parse(await readFile(path + '.perf-index.json', 'utf8'));
  assert.equal(index.rotated, true); assert.ok(index.generation > 4);
  assert.ok(index.droppedEvents > 0);
});

test('failed durable evidence writes cannot publish cached success, and corrupted pages fail integrity', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-evidence-fault-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uri = vscode.Uri.file(root) as never;
  const scope = { sessionId: 's', taskId: 't' };
  const input = { ...scope, toolCallId: 'call', toolName: 'search', argumentsHash: 'args', effectKind: 'read' as const };
  const store = new ToolEvidenceStore(uri);
  const original = vscode.workspace.fs.writeFile;
  vscode.workspace.fs.writeFile = async () => { throw Object.assign(new Error('full'), { code: 'ENOSPC' }); };
  try { await assert.rejects(() => store.ensureIntent(input), /persisted/); }
  finally { vscode.workspace.fs.writeFile = original; }
  assert.equal(await store.findByToolCall('s', 't', 'call'), undefined);
  const evidence = await store.complete(await store.ensureIntent(input), '🙂immutable');
  const tiny = await store.read({ ...scope, evidenceRef: evidence.evidenceRef, maxChars: 1 });
  assert.equal(tiny.errorType, 'evidence_page_too_small');
  const page = await store.read({ ...scope, evidenceRef: evidence.evidenceRef, maxChars: 20 });
  assert.equal(page.content, '🙂immutable');
  const files = await readdir(root, { recursive: true });
  const blob = files.find(name => name.endsWith(evidence.blobName!))!;
  await writeFile(join(root, blob), 'corrupt');
  await assert.rejects(() => store.read({ ...scope, evidenceRef: evidence.evidenceRef }), /integrity/);
  const cp = createRunCheckpoint({ ...request(), history: [] }, 0, 'test', []);
  assert.ok(normalizeRunCheckpoint(cp), 'legacy checkpoint without optional progress metadata remains readable');
});
