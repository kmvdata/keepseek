/* Offline synthetic benchmark: real temporary filesystem, VS Code API stub,
 * no Provider traffic or user data. Run after bun run build:test.
 * KEEPSEEK_BENCH_MODULES may point at a separately compiled baseline. */
const { mkdtemp, rm, readFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const root = resolve(process.env.KEEPSEEK_BENCH_MODULES || 'out-test');
require(join(root, 'test/registerVscodeStub'));
// Equal durability for comparison: the baseline child/ledger omitted fsync.
// Normalize both revisions to durable atomic replacement rather than claiming
// a performance win from weaker persistence.
const atomic = require(join(root, 'src/shared/atomicStorage'));
const originalAtomic = atomic.writeJsonAtomic;
atomic.writeJsonAtomic = (uri, value, options) => originalAtomic(uri, value, { ...options, durable: true });
const vscode = require(join(root, 'test/stubs/vscode'));
const { SessionObjectStore } = require(join(root, 'src/sessions/sessionObjectStore'));
const { snapshotSession, freezeTree } = require(join(root, 'src/sessions/persistenceSnapshot'));
const { SubagentStore } = require(join(root, 'src/agent/subagents/store'));
const { createRunCheckpoint } = require(join(root, 'src/agent/runCheckpoint'));
const { UsageLedgerStore } = require(join(root, 'src/agent/usageLedgerStore'));
const { createUsageLedgerRecords, createUsagePriceSnapshot } = require(join(root, 'src/agent/usageLedger'));
const { subscribeLocalPerformance } = require(join(root, 'src/agent/logging/performanceTrace'));
const request = history => ({ model: { id: 'fixture', label: 'fixture', provider: 'deepseek' },
  prompt: 'synthetic', contextFiles: [], language: 'en', settings: { thinkingEnabled: false,
    reasoningEffort: 'high', compressionThreshold: 'balanced' }, history });
function unionMs(events) {
  const intervals = events.filter(e => e.type === 'checkpoint_store' || e.type === 'checkpoint_child_store' || e.type === 'checkpoint_ledger_store')
    .map(e => [e.observedAt - e.durationMs, e.observedAt]).sort((a,b) => a[0]-b[0]);
  let total = 0, end = -Infinity;
  for (const [start, stop] of intervals) { total += Math.max(0, stop - Math.max(start,end)); end = Math.max(stop,end); }
  return total;
}
async function run(kind) {
  const dir = await mkdtemp(join(tmpdir(), 'keepseek-p0-bench-'));
  let bytes = 0, writes = 0, reads = 0, peak = 0, active = 0;
  const events = [];
  const off = subscribeLocalPerformance(e => events.push({ ...e, observedAt: performance.now() }));
  const write = vscode.workspace.fs.writeFile, read = vscode.workspace.fs.readFile;
  vscode.workspace.fs.writeFile = async (uri, data) => {
    bytes += data.byteLength; writes++; peak = Math.max(peak, ++active);
    try { return await write(uri, data); } finally { active--; }
  };
  vscode.workspace.fs.readFile = async uri => { reads++; return read(uri); };
  try {
    const long = kind === 'long';
    const largeHistory = long || kind.includes('child');
    const history = Array.from({ length: largeHistory ? 165 : 4 }, (_, i) => ({ id: `m${i}`,
      role: i % 2 ? 'assistant' : 'user', content: `body-${i}:` + 'synthetic '.repeat(largeHistory ? 2000 : 20), createdAt: '' }));
    freezeTree(history);
    const cp = createRunCheckpoint(request(history), 0, 'test', []);
    cp.state = { messages: [], toolRounds: [], draftEdits: [], draftRuns: [], reasoningParts: [], turn: 0,
      toolCallCount: 0, validationRunCount: 0, toolResultTokens: 0,
      repairLoop: { status: 'idle', iteration: 0, maxIterations: 0, pendingDraftEditIds: [] } };
    const session = { id: 'session', workspaceKey: 'workspace', title: 'Synthetic', messages: [...history],
      createdAt: '', updatedAt: '', isFavorite: false, workspaceName: 'workspace', workspaceFolders: [] };
    if (long) for (let i = 0; i < 55; i++) session.messages.push({ id: `cp${i}`, role: 'assistant', content: '', createdAt: '',
      runCheckpoint: { ...cp, state: { ...cp.state }, taskId: `task${i}`, status: 'completed' } });
    if (long) session.messages.push({ id: 'active', role: 'assistant', content: '', createdAt: '', runCheckpoint: cp });
    const storage = new SessionObjectStore(vscode.Uri.file(join(dir, 'session.json')));
    const child = new SubagentStore(vscode.Uri.file(dir), 'workspace');
    const meta = id => ({ version: 2, id, treeId: 'tree', parentSessionId: 'session', parentRunId: 'root', rootRunId: 'root',
      depth: 1, profile: 'research', lane: 'research', task: 'Synthetic', status: 'running', sourceId: 'source', modelId: 'fixture',
      provider: 'deepseek', sourceConfigHash: '', systemPromptHash: '', toolSchemaHash: '', profileHash: '', projectInstructionsHash: '',
      createdAt: '', updatedAt: '' });
    const ledger = new UsageLedgerStore(vscode.Uri.file(dir));
    const start = performance.now();
    let coldMs, hotBytes, hotWrites, hotReads, snapshotMs = 0;
    for (let step = 0; step < 6; step++) {
      cp.usedMs = step; cp.state.turn = step;
      session.updatedAt = String(step);
      if (kind === 'single-child' || kind === 'parallel-child') {
        await Promise.all(Array.from({ length: kind === 'single-child' ? 1 : 3 }, (_, i) => child.save(meta(`sa_${i}`), {
          version: 2, metadataId: `sa_${i}`, contextInstructions: 'private fixture', messages: history,
          result: '', checkpoint: cp
        })));
      } else if (kind === 'ledger') {
        const records = createUsageLedgerRecords({ requestId: `req-${step}`, source: 'subagent',
          attempts: [createUsagePriceSnapshot({ sourceId: 's', provider: 'deepseek', protocol: 'chat-completions',
            originalModelId: 'deepseek-chat', supportsBilling: true })] });
        await ledger.appendMany('session', records);
        if (ledger.current) await ledger.current('session'); else await ledger.rebuild('session');
      } else {
        const copyStart = performance.now(), snapshot = snapshotSession(session);
        snapshotMs += performance.now() - copyStart;
        await storage.save(snapshot);
      }
      if (step === 0) { coldMs = performance.now() - start; hotBytes = bytes; hotWrites = writes; hotReads = reads; }
    }
    const totalMs = performance.now() - start;
    const measured = { bytes, writes, reads }, measuredEvents = events.slice();
    if (kind === 'short' || long) {
      const fresh = new SessionObjectStore(vscode.Uri.file(join(dir, 'session.json')));
      const restored = await fresh.load(JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')));
      assert.equal(restored.updatedAt, '5'); assert.equal(restored.messages.length, session.messages.length);
    } else if (kind.includes('child')) {
      const restored = await new SubagentStore(vscode.Uri.file(dir), 'workspace').read('session', 'sa_0');
      assert.equal(restored.transcript.checkpoint.usedMs, 5);
    } else assert.equal((await ledger.rebuild('session')).ledger.records.length, 6);
    return { totalMs, coldMs, hotMs: totalMs - coldMs, ...measured, hotBytes: measured.bytes - hotBytes,
      hotWrites: measured.writes - hotWrites, hotReads: measured.reads - hotReads, ioPeak: peak,
      providerMs: 0, saves: 6 * (kind === 'parallel-child' ? 3 : 1),
      snapshotMs: snapshotMs + measuredEvents.reduce((n,e) => n + (e.snapshotMs || 0), 0),
      localPersistenceUnionMs: measuredEvents.some(e => ['checkpoint_store', 'checkpoint_child_store', 'checkpoint_ledger_store'].includes(e.type))
        ? unionMs(measuredEvents) : null,
      queueMs: measuredEvents.some(e => Number.isFinite(e.queueMs)) ? measuredEvents.reduce((n, e) => n + (e.queueMs || 0), 0) : null,
      processingMs: measuredEvents.some(e => Number.isFinite(e.processingMs)) ? measuredEvents.reduce((n, e) => n + (e.processingMs || 0), 0) : null,
      persistenceQueuePeak: measuredEvents.some(e => Number.isFinite(e.queueDepth)) ? Math.max(...measuredEvents.map(e => e.queueDepth || 0)) : null,
      objectsWritten: measuredEvents.filter(e => e.type === 'checkpoint_store').reduce((n,e) => n + (e.objectsWritten || 0), 0) };
  } finally { off(); vscode.workspace.fs.writeFile = write; vscode.workspace.fs.readFile = read; await rm(dir, { recursive: true, force: true }); }
}
(async () => {
  const results = {};
  for (const kind of ['short', 'long', 'single-child', 'parallel-child', 'ledger']) {
    results[kind] = [];
    for (let i = 0; i < Number(process.env.KEEPSEEK_BENCH_ROUNDS || 3); i++) results[kind].push(await run(kind));
  }
  process.stdout.write(JSON.stringify({ environment: { node: process.version, platform: process.platform, arch: process.arch,
    provider: 'none; identical persistence workload', filesystem: 'real temporary filesystem via VS Code stub', rounds: 3 }, results }, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
