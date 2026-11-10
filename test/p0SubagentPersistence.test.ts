import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from './stubs/vscode';
import { UsageLedgerStore } from '../src/agent/usageLedgerStore';
import { appendUsageLedgerRecord, createUsageLedgerRecords, createUsagePriceSnapshot, mergePendingUsageLedger } from '../src/agent/usageLedger';
import { createUsageEvent, rebuildSessionUsageStatsFromLedger } from '../src/agent/usageStats';
import { countObservedSubagentInvocations, createSubagentRunUsageSummary, createUsageDetailsViewModel, upsertSubagentRunUsageSummary } from '../src/agent/subagentUsageStats';
import { SubagentStore } from '../src/agent/subagents/store';
import type { StoredSubagentMetadata, StoredSubagentTranscript } from '../src/agent/subagents/types';
import { CoalescedWriter } from '../src/sessions/coalescedWriter';
import { SessionObjectStore } from '../src/sessions/sessionObjectStore';
import { snapshotCheckpoint, snapshotSession } from '../src/sessions/persistenceSnapshot';
import { createRunCheckpoint } from '../src/agent/runCheckpoint';
import type { AgentRequest, ChatSession, SubagentActivity } from '../src/shared/types';
import { OpenAICompatibleClient } from '../src/agent/providers/openAiCompatibleClient';
import { subscribeLocalPerformance } from '../src/agent/logging/performanceTrace';
import { ReferenceCostIndex, buildReferenceCostView } from '../src/agent/usageReferenceCosts';
import { KeepseekChatViewProvider } from '../src/provider/KeepseekChatViewProvider';

const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12, cacheHitTokens: 0, cacheMissTokens: 10,
  cacheDataStatus: 'unavailable' as const };
function record(withUsage = false, requestId = 'request', sourceId = 'account') {
  return { ...createUsageLedgerRecords({ requestId, source: 'subagent', usage: withUsage ? usage : undefined,
    attempts: [createUsagePriceSnapshot({ originalModelId: 'fixture', sourceId, provider: 'qwencloud', protocol: 'chat-completions',
      requestStartedAt: '2026-10-31T00:00:00.000Z', supportsBilling: false })] })[0], subagentId: 'sa_child' };
}
const metadata = (id = 'sa_child'): StoredSubagentMetadata => ({ version: 2, id, treeId: 'tree', parentSessionId: 'parent',
  parentRunId: 'root', rootRunId: 'root', depth: 1, profile: 'research', lane: 'research-read', task: 'private task', status: 'running',
  sourceId: 'account', modelId: 'fixture', provider: 'qwencloud', sourceConfigHash: '', systemPromptHash: '', toolSchemaHash: '',
  profileHash: '', projectInstructionsHash: '', createdAt: '2026-10-31T00:00:00.000Z', updatedAt: '2026-10-31T00:00:01.000Z' });
const transcript = (id = 'sa_child'): StoredSubagentTranscript => ({ version: 2, metadataId: id, contextInstructions: 'private instructions',
  messages: [{ id: 'u', role: 'user', content: 'private transcript', createdAt: '' }], result: 'private result' });

test('attempt upgrades survive duplication, late weaker callbacks, restart and damaged bucket rebuild', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-ledger-p0-')); t.after(() => rm(root, { recursive: true, force: true }));
  const uri = vscode.Uri.file(root) as never, store = new UsageLedgerStore(uri);
  await store.append('parent', record());
  assert.equal((await store.current('parent')).stats?.providerAttemptCount, 1);
  await Promise.all([store.append('parent', record(true)), store.append('parent', record()), store.append('parent', record(true))]);
  const hot = await store.current('parent');
  assert.equal(hot.stats?.providerAttemptCount, 1); assert.equal(hot.stats?.usageResponseCount, 1); assert.equal(hot.stats?.totalTokens, 12);
  const restored = await new UsageLedgerStore(uri).rebuild('parent');
  assert.deepEqual(restored.ledger.records, hot.ledger.records);
  assert.deepEqual(hot.stats?.bySource, rebuildSessionUsageStatsFromLedger(restored.ledger.records)?.bySource);
  const merged = mergePendingUsageLedger({ version: 1, records: [record()], incomplete: false },
    { version: 1, records: [record(true), record()], incomplete: false });
  assert.equal(merged.records.length, 1); assert.equal(merged.records[0].kind, 'usage_response');
  assert.equal(appendUsageLedgerRecord(merged, record()).records[0].kind, 'usage_response');
  const files = await readdir(root, { recursive: true });
  const bucket = files.find(file => /bucket-.*\.json$/u.test(file))!;
  await writeFile(join(root, bucket), '{broken');
  assert.equal((await store.rebuild('parent')).damagedBucketCount, 1);
  await assert.rejects(store.append('parent', record(true)), /damaged/u);
});

test('warm ledger appends read the touched bucket, and rebuild serializes with arriving usage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-ledger-warm-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new UsageLedgerStore(vscode.Uri.file(root) as never);
  await store.current('parent');
  let reads = 0;
  const original = vscode.workspace.fs.readFile;
  vscode.workspace.fs.readFile = async uri => { reads++; return original(uri); };
  try {
    await store.append('parent', record()); await store.current('parent');
    assert.ok(reads <= 2, `warm append performed ${reads} reads`);
    await Promise.all([store.rebuild('parent'), store.append('parent', record(true)), store.append('parent', record(true, 'second'))]);
    const current = await store.current('parent');
    assert.equal(current.stats?.providerAttemptCount, 2); assert.equal(current.stats?.usageResponseCount, 2);
  } finally { vscode.workspace.fs.readFile = original; }
});

test('host sees durable attempt upgrades once before flush and never saves the whole session for a derived refresh', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-host-ledger-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new UsageLedgerStore(vscode.Uri.file(root) as never);
  await store.current('parent');
  const session = { id: 'parent', messages: [] } as unknown as ChatSession;
  let sessionSaves = 0;
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    usageLedgerStore: store, usageLedgerFlushes: new Map(), referenceCostViews: new Map(), referenceCostIndexes: new Map(),
    sessionStore: { persist: async () => { sessionSaves++; } }
  }) as { applyUsageLedgerRecord(session: ChatSession, value: ReturnType<typeof record>): Promise<void>; usageLedgerFlushes: Map<string, Promise<void>> };
  await host.applyUsageLedgerRecord(session, record());
  assert.equal(session.usageStats?.providerAttemptCount, 1);
  await host.applyUsageLedgerRecord(session, record(true));
  await host.applyUsageLedgerRecord(session, record());
  assert.equal(session.usageStats?.providerAttemptCount, 1); assert.equal(session.usageStats?.usageResponseCount, 1);
  await host.usageLedgerFlushes.get('parent');
  assert.equal(session.usageStats?.totalTokens, 12); assert.equal(sessionSaves, 0);
});

test('ledger flush keeps records arriving during the durable read visible and pending until committed', async () => {
  let release!: () => void, entered!: () => void;
  const reading = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const stored: ReturnType<typeof record>[] = [];
  let first = true;
  const session = { id: 'parent', messages: [], usageLedger: appendUsageLedgerRecord(undefined, record(true, 'first')) } as unknown as ChatSession;
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), {
    usageLedgerStore: {
      appendMany: async (_sessionId: string, records: ReturnType<typeof record>[]) => { stored.push(...records); },
      current: async () => {
        const records = [...stored];
        if (first) { first = false; entered(); await gate; }
        return { ledger: { version: 1 as const, records, incomplete: false }, stats: rebuildSessionUsageStatsFromLedger(records), damagedBucketCount: 0 };
      }
    },
    usageLedgerFlushes: new Map(), referenceCostViews: new Map(), referenceCostIndexes: new Map(),
    sessionStore: { activeSessionId: 'other' }
  }) as { queueUsageLedgerFlush(session: ChatSession): void; usageLedgerFlushes: Map<string, Promise<void>> };
  host.queueUsageLedgerFlush(session);
  const flush = host.usageLedgerFlushes.get('parent');
  await reading;
  session.usageLedger = appendUsageLedgerRecord(session.usageLedger, record(true, 'second'));
  release();
  await flush;
  assert.equal(session.usageStats?.totalTokens, 24);
  assert.equal(session.usageStats?.providerAttemptCount, 2);
  assert.equal(session.usageLedger?.records[0]?.requestId, 'second');
  await host.usageLedgerFlushes.get('parent');
  assert.equal(session.usageLedger, undefined);
  assert.equal(stored.length, 2);
});

test('standalone compression waits for ledger commit and retains current pending records until then', async () => {
  let release!: () => void, settled = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const session = { id: 'parent', messages: [], usageStats: rebuildSessionUsageStatsFromLedger([record(true, 'prior-record')]) } as unknown as ChatSession;
  const host = Object.assign(Object.create(KeepseekChatViewProvider.prototype), { applyUsageLedgerRecord: async () => gate }) as {
    applyContextCompressionRefreshResult(session: ChatSession, result: unknown): Promise<boolean> };
  const committing = host.applyContextCompressionRefreshResult(session, { changed: true, reason: 'created',
    state: { version: 1, summaries: [], protectedMessageIds: [] }, usageLedgerRecords: [record(true)] });
  void committing.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(session.usageLedger?.records[0].kind, 'usage_response');
  assert.equal(session.usageLedger?.incomplete, false);
  assert.equal(session.usageStats?.totalTokens, 12, 'the pending commit must preserve previously confirmed usage');
  release(); assert.equal(await committing, true);
});

test('ledger-owned session events do not double usage even when the ledger is incomplete', () => {
  const host = Object.create(KeepseekChatViewProvider.prototype) as {
    applyUsageEvent(session: ChatSession, current: undefined, event: ReturnType<typeof createUsageEvent>): unknown };
  const session = { id: 'parent', messages: [], usageStats: rebuildSessionUsageStatsFromLedger([record(true)]) } as unknown as ChatSession;
  const event = createUsageEvent({ usage, cost: 0, currency: '', modelId: 'fixture', source: 'subagent', ledgerRecorded: true });
  host.applyUsageEvent(session, undefined, event); assert.equal(session.usageStats?.totalTokens, 12);
  session.usageLedgerRef = { version: 2, sessionId: 'parent', incomplete: true };
  host.applyUsageEvent(session, undefined, event); assert.equal(session.usageStats?.totalTokens, 12);
});

test('attempt-only and active children are visible; accounts and task counts stay separate from responses', () => {
  const activity: SubagentActivity = { ...metadata(), reused: false };
  const records = [record(), record(true, 'second'), record(true, 'third', 'other-account')];
  const stats = rebuildSessionUsageStatsFromLedger(records);
  const view = createUsageDetailsViewModel({ sessionUsageStats: stats, subagentActivities: [activity, activity], subagentLedgerRecords: records });
  assert.equal(view.subagents?.acceptedTaskCount, 1); assert.equal(view.subagents?.runningCount, 1);
  assert.equal(view.subagents?.usageUnreportedCount, 1); assert.equal(view.subagents?.byModel.length, 2);
  assert.equal(view.subagents?.byModel.find(group => group.sourceId === 'account')?.taskCount, 1);
  const onlyAttempt = createUsageDetailsViewModel({ sessionUsageStats: rebuildSessionUsageStatsFromLedger([record()]) });
  assert.ok(onlyAttempt.subagents); assert.equal(onlyAttempt.subagents.usageUnreportedCount, 1);
  assert.equal(onlyAttempt.subagents.acceptedTaskCount, undefined);
  const calls = countObservedSubagentInvocations([{ id: 'm', role: 'assistant', content: '', createdAt: '', toolRounds: [{
    assistantContent: '', reasoningContent: '', toolCalls: [{ id: 'batch', type: 'function', function: { name: 'keepseek_delegate_parallel', arguments: 'private' } }], toolResults: [] }] }]);
  assert.equal(calls.parallel, 1);
  assert.ok(createUsageDetailsViewModel({ observedInvocations: calls }).subagents, 'a rejected submission remains observable without invented tasks');
});

test('child summaries recover before parent callbacks without reading private objects or restarting children', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-child-index-')); t.after(() => rm(root, { recursive: true, force: true }));
  const uri = vscode.Uri.file(root) as never, store = new SubagentStore(uri, 'workspace');
  const meta = metadata(); meta.status = 'completed';
  meta.stats = createSubagentRunUsageSummary({ subagentId: meta.id, parentRunId: 'root', rootRunId: 'root', depth: 1,
    profile: meta.profile, lane: meta.lane, status: 'completed', sourceId: meta.sourceId, modelId: meta.modelId, provider: meta.provider,
    startedAt: meta.createdAt, completedAt: meta.updatedAt });
  await store.save(meta, transcript());
  await store.saveActivity({ ...metadata('sa_queued'), status: 'queued' });
  const original = vscode.workspace.fs.readFile;
  vscode.workspace.fs.readFile = async target => {
    assert.ok(!target.fsPath.includes('.objects'), 'startup must not read the private graph');
    return original(target);
  };
  let restored;
  try { restored = await new SubagentStore(uri, 'workspace').readSummaries('parent'); }
  finally { vscode.workspace.fs.readFile = original; }
  assert.equal(restored.activities.length, 2); assert.equal(restored.summaries.length, 1);
  assert.equal(restored.activities.find(item => item.id === 'sa_queued')?.status, 'stopped');
  assert.equal(restored.activities.find(item => item.id === 'sa_queued')?.interrupted, true);
  let stats = upsertSubagentRunUsageSummary(undefined, restored.summaries[0]);
  stats = upsertSubagentRunUsageSummary(stats, restored.summaries[0]);
  assert.equal(stats.totalCount, 1);
  assert.doesNotMatch(JSON.stringify(restored), /private task|private result|private transcript|private instructions/u);
  assert.equal((await store.read('other-parent', meta.id)), undefined);
  assert.equal((await new SubagentStore(uri, 'other-workspace').read('parent', meta.id)), undefined);
  const files = await readdir(root, { recursive: true }), file = files.find(name => name.endsWith('sa_child.state.json'))!;
  const manifest = JSON.parse(await readFile(join(root, file), 'utf8'));
  manifest.summary.activity.treeId = 'wrong-tree'; await writeFile(join(root, file), JSON.stringify(manifest));
  assert.equal((await store.readSummaries('parent')).incomplete, true);
});

test('current graph updates preserve identity and revision without creating rollback formats', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-current-graph-')); t.after(() => rm(root, { recursive: true, force: true }));
  const uri = vscode.Uri.file(join(root, 'session.json')) as never;
  const store = new SessionObjectStore(uri);
  const session = { id: 's', workspaceKey: 'w', title: 'first', messages: [] } as unknown as ChatSession;
  await store.save(snapshotSession(session));
  const original = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
  assert.equal(original.version, 4);
  const reopened = new SessionObjectStore(uri), restored = await reopened.load(original);
  restored.title = 'second';
  await reopened.save(snapshotSession(restored));
  const current = JSON.parse(await readFile(join(root, 'session.json'), 'utf8'));
  assert.equal(current.version, 4);
  assert.equal(current.revision, original.revision + 1);
  const latest = await new SessionObjectStore(uri).load(current);
  assert.equal(latest.id, 's');
  assert.equal(latest.title, 'second');
  assert.ok((await readdir(join(root, 'session.json.objects'))).every(file => !file.startsWith('legacy-')));
});

test('a failed child manifest switch leaves the prior result authoritative and allows an explicit retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-child-fault-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SubagentStore(vscode.Uri.file(root) as never, 'workspace'), meta = metadata();
  await store.save(meta, transcript());
  const original = vscode.workspace.fs.rename;
  vscode.workspace.fs.rename = async (a,b,options) => {
    if (b.fsPath.endsWith('sa_child.state.json')) throw new Error('manifest fault');
    return original(a,b,options);
  };
  try { await assert.rejects(store.save(meta, { ...transcript(), result: 'next result' }), /manifest fault/u); }
  finally { vscode.workspace.fs.rename = original; }
  assert.equal((await store.read('parent', meta.id))?.transcript.result, 'private result');
  await store.save(meta, { ...transcript(), result: 'next result' });
  assert.equal((await store.read('parent', meta.id))?.transcript.result, 'next result');
});

test('retired combined and split child files are ignored', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-child-legacy-')); t.after(() => rm(root, { recursive: true, force: true }));
  const hash = createHash('sha256').update('workspace').digest('hex').slice(0, 24);
  const directory = vscode.Uri.file(join(root, 'chat-sessions/v1/subagents', hash, 'parent'));
  await vscode.workspace.fs.createDirectory(directory);
  const meta = { ...metadata(), status: 'completed' };
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, 'sa_child.run.json'), Buffer.from(JSON.stringify({ version: 1, metadata: meta, transcript: transcript() })));
  const store = new SubagentStore(vscode.Uri.file(root) as never, 'workspace');
  assert.equal(await store.read('parent', 'sa_child'), undefined);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, 'sa_forged.run.json'), Buffer.from(JSON.stringify({ version: 1, metadata: meta, transcript: transcript() })));
  assert.equal(await store.read('parent', 'sa_forged'), undefined);
  assert.equal((await store.readSummaries('parent')).incomplete, false);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, 'sa_split.meta.json'), Buffer.from(JSON.stringify({ ...metadata('sa_split'), status: 'stopped' })));
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, 'sa_split.transcript.json'), Buffer.from(JSON.stringify(transcript('sa_split'))));
  assert.equal(await store.read('parent', 'sa_split'), undefined);
  assert.deepEqual((await store.readSummaries('parent')).activities, []);
});

test('coalescing bounds snapshots and waits for a committed newer revision; failures do not retry', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const writes: number[] = [];
  const writer = new CoalescedWriter<number>(async value => { writes.push(value); if (value === 1) await gate; });
  const one = writer.save(1), two = writer.save(2), three = writer.save(3);
  assert.equal(writer.pendingSnapshots, 2); release(); await Promise.all([one, two, three]);
  assert.deepEqual(writes, [1, 3]);
  let failures = 0;
  const failing = new CoalescedWriter<number>(async () => { failures++; throw new Error('disk full'); });
  await assert.rejects(failing.save(1), /disk full/u); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(failures, 1);
});

test('a blocked child does not block a sibling commit, and mutable journals are captured at invocation', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-child-parallel-')); t.after(() => rm(root, { recursive: true, force: true }));
  const store = new SubagentStore(vscode.Uri.file(root) as never, 'workspace');
  const original = vscode.workspace.fs.writeFile;
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blocked = new Promise<void>(resolve => { entered = resolve; });
  vscode.workspace.fs.writeFile = async (uri, bytes) => {
    if (uri.fsPath.includes('sa_a.state.json.objects')) { entered(); await gate; }
    return original(uri, bytes);
  };
  const input = transcript('sa_a'), meta = metadata('sa_a');
  const first = store.save(meta, input); input.result = 'changed after call'; meta.status = 'failed';
  try {
    await blocked;
    await store.save(metadata('sa_b'), transcript('sa_b'));
    assert.equal((await store.read('parent', 'sa_b'))?.metadata.id, 'sa_b');
    release(); await first;
    const saved = await store.read('parent', 'sa_a');
    assert.equal(saved?.transcript.result, 'private result'); assert.equal(saved?.metadata.failureKind, 'interrupted');
  } finally { release(); await first; vscode.workspace.fs.writeFile = original; }
});

test('packed session recovery keeps changed journals and budgets while reusing verified history', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-packed-journal-')); t.after(() => rm(root, { recursive: true, force: true }));
  const request: AgentRequest = { model: { id: 'fixture', label: 'fixture', provider: 'qwencloud' }, prompt: 'task', history: [],
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' }, contextFiles: [], language: 'en' };
  const cp = createRunCheckpoint(request, 10000, 'test', []);
  cp.state = { messages: [], toolRounds: [], draftEdits: [], draftRuns: [], reasoningParts: [], turn: 0, toolCallCount: 0,
    validationRunCount: 0, toolResultTokens: 0, repairLoop: { status: 'idle', iteration: 0, maxIterations: 0, pendingDraftEditIds: [] },
    pending: { response: { message: { role: 'assistant', content: null } }, results: { done: 'first' } } };
  const session = { id: 's', workspaceKey: 'w', messages: [{ id: 'a', role: 'assistant', content: '', createdAt: '', runCheckpoint: cp }] } as ChatSession;
  const store = new SessionObjectStore(vscode.Uri.file(join(root, 'session.json')) as never);
  const first = snapshotCheckpoint(cp); cp.usedMs = 42; cp.usedCostByCurrency = { USD: 2 }; cp.modelRequests = 3;
  cp.state.pending!.results.done = 'second'; cp.state.reasoningParts.push('new private reasoning');
  await store.save(snapshotSession(session));
  assert.equal(first.usedMs, 0);
  assert.equal(first.state?.pending?.results.done, 'first');
  assert.equal(first.state?.reasoningParts.length, 0);
  const restored = await new SessionObjectStore(vscode.Uri.file(join(root, 'session.json')) as never).load(JSON.parse(await readFile(join(root, 'session.json'), 'utf8')));
  assert.equal(restored.messages[0].runCheckpoint?.usedMs, 42);
  assert.equal(restored.messages[0].runCheckpoint?.modelRequests, 3);
  assert.deepEqual(restored.messages[0].runCheckpoint?.usedCostByCurrency, { USD: 2 });
  assert.equal(restored.messages[0].runCheckpoint?.state?.pending?.results.done, 'second');
});

test('unchanged message bodies skip re-encoding while in-place mutable metadata changes remain durable', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-body-reuse-')); t.after(() => rm(root, { recursive: true, force: true }));
  const session = { id: 's', workspaceKey: 'w', messages: Array.from({ length: 20 }, (_, i) => ({ id: String(i), role: 'user',
    content: String(i) + 'old body'.repeat(5000), createdAt: '', contextMeta: { isProtected: false } })) } as ChatSession;
  const store = new SessionObjectStore(vscode.Uri.file(join(root, 'session.json')) as never);
  const visits: number[] = [];
  const off = subscribeLocalPerformance(event => { if (event.type === 'checkpoint_encoding') visits.push(Number(event.nodesVisited)); });
  try {
    await store.save(snapshotSession(session)); await store.save(snapshotSession(session));
    assert.ok(visits[1] < visits[0] / 2, `${visits} should skip old bodies`);
    session.messages[0].contextMeta!.isProtected = true;
    await store.save(snapshotSession(session));
    const restored = await new SessionObjectStore(vscode.Uri.file(join(root, 'session.json')) as never).load(JSON.parse(await readFile(join(root, 'session.json'), 'utf8')));
    assert.equal(restored.messages[0].contextMeta?.isProtected, true);
  } finally { off(); }
});

test('incremental reference costs match a fresh projection and drop records removed by an integrity rebuild', () => {
  const index = new ReferenceCostIndex(), records = [record(), record(true, 'second')];
  const ledger = { version: 1 as const, records, incomplete: false };
  buildReferenceCostView(ledger, {}, index);
  records[0] = record(true);
  const updated = buildReferenceCostView(ledger, {}, index), fresh = buildReferenceCostView(ledger, {});
  assert.equal(updated.session?.sessionCost, fresh.session?.sessionCost);
  assert.equal(updated.session?.requestCount, 2);
  const reduced = buildReferenceCostView({ ...ledger, records: [records[0]], incomplete: true }, {}, index);
  assert.equal(reduced.session?.requestCount, 1);
});

test('transport ledger persistence failure cannot become a network retry or dispatch a POST', async () => {
  let posts = 0, attempts = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => { posts++; throw new Error('unexpected POST'); }) as typeof fetch;
  try {
    await assert.rejects(new OpenAICompatibleClient({ displayName: 'fixture' }).createModelResponse({ apiKey: 'fixture',
      baseUrl: 'https://example.invalid/v1', maxRequestRetries: 3, requestRetryBaseMs: 0, streamIdleTimeoutMs: 1000 },
    { body: { model: 'fixture', messages: [], stream: true }, language: 'en', onAttempt: async () => { attempts++; throw new Error('disk full'); } }), /disk full/u);
    assert.equal(posts, 0); assert.equal(attempts, 1);
  } finally { globalThis.fetch = original; }
});

test('deletion serializes with an in-flight ledger commit and rejects queued or late auxiliary usage', async t => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-ledger-delete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const uri = vscode.Uri.file(root) as never;
  const store = new UsageLedgerStore(uri);
  await store.current('deleted-parent');
  let reached!: () => void;
  const committing = new Promise<void>(resolve => { reached = resolve; });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const originalRename = vscode.workspace.fs.rename;
  let first = true;
  vscode.workspace.fs.rename = async (...args) => {
    if (first && args[1].fsPath.includes('usage-ledger')) { first = false; reached(); await gate; }
    return originalRename(...args);
  };
  try {
    const active = store.append('deleted-parent', { ...record(true, 'active-title'), purpose: 'session_title' });
    await committing;
    const queued = store.append('deleted-parent', record(true, 'queued-title'));
    const deleted = store.deleteSession('deleted-parent');
    assert.equal(await store.append('deleted-parent', record(true, 'late-title')), false);
    assert.equal(store.peekStats('deleted-parent'), undefined);
    release();
    await Promise.all([active, deleted]);
    assert.equal(await queued, false);
    assert.equal((await store.current('deleted-parent')).ledger.records.length, 0);
    assert.equal(store.peekStats('deleted-parent'), undefined);
    assert.equal((await new UsageLedgerStore(uri).readAll('deleted-parent')).total, 0);
    const identity = createHash('sha256').update('deleted-parent').digest('hex');
    await assert.rejects(readdir(join(root, 'usage-ledger', 'v2', identity)), { code: 'ENOENT' });
  } finally { release(); vscode.workspace.fs.rename = originalRename; }
});
