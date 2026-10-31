/* Offline storage graph benchmark. No Provider, approvals or side effects run.
 * build:test first; node --expose-gc scripts/benchmark-long-task-mutations.js LABEL
 * Unlike benchmark-long-task.js this isolates the shard graph, excluding indexes.
 */
require('../out-test/test/registerVscodeStub');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const vscode = require('../out-test/test/stubs/vscode');
const { SessionObjectStore } = require('../out-test/src/sessions/sessionObjectStore');
const { snapshotSession } = require('../out-test/src/sessions/persistenceSnapshot');
const { fixture, percentile } = require('./benchmark-long-task');

async function main() {
  const results = [];
  for (const [count, chars] of [[3, 2000], [20, 12000], [55, 23800], [80, 12000]]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-mutations-'));
    try {
      const session = fixture(count, chars), active = session.messages.at(-1).runCheckpoint;
      const store = new SessionObjectStore(vscode.Uri.file(path.join(root, 'shard.json')));
      await store.save(snapshotSession(session));
      for (const mutation of ['heartbeat', 'append_message', 'tool_result', 'host_status']) {
        const times = [], bytes = [], writes = [], delays = [], heaps = [], retained = [], rss = [];
        const original = vscode.workspace.fs.writeFile;
        let byteCount = 0, writeCount = 0;
        vscode.workspace.fs.writeFile = async (uri, data) => { byteCount += data.byteLength; writeCount++; return original(uri, data); };
        try {
          for (let i = 0; i < 7; i++) {
            global.gc?.(); retained.push(process.memoryUsage().heapUsed);
            byteCount = 0; writeCount = 0;
            const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
            await new Promise(resolve => setTimeout(resolve, 20));
            active.usedMs += 100;
            if (mutation === 'append_message') session.messages.push({ id: `append-${i}`, role: 'user', content: `New user instruction ${i}`, createdAt: '' });
            if (mutation === 'tool_result') active.state.toolRounds.push({ assistantContent: '',
              toolCalls: [{ id: `call-${i}`, type: 'function', function: { name: 'keepseek_read_workspace_file', arguments: JSON.stringify({ path: `file-${i}` }) } }],
              toolResults: [{ toolCallId: `call-${i}`, content: JSON.stringify({ ok: true, content: `${i}:` + 'verified body '.repeat(3000) }) }] });
            if (mutation === 'host_status') session.contextCompression = { version: 1, summaries: [], protectedMessageIds: [],
              protectionState: { version: 1, pendingMessageIds: i % 2 ? [] : ['work'], settledMessageIds: i % 2 ? ['work'] : [],
                settledFacts: i % 2 ? [{ messageId: 'work', status: 'rejected', artifactId: `proposal-${i}` }] : [] } };
            const started = performance.now();
            await store.save(snapshotSession(session));
            times.push(performance.now() - started); bytes.push(byteCount); writes.push(writeCount);
            await new Promise(resolve => setTimeout(resolve, 20));
            delays.push(loop.max / 1e6); loop.disable();
            const memory = process.memoryUsage(); heaps.push(memory.heapUsed); rss.push(memory.rss);
          }
        } finally { vscode.workspace.fs.writeFile = original; }
        results.push({ checkpointCount: count, charsPerMessage: chars, mutation, samples: times.length,
          saveP50Ms: percentile(times, .5), saveP95Ms: percentile(times, .95), writeBytes: bytes, writeCounts: writes,
          eventLoopMaxMs: Math.max(...delays), sampledMaxRssBytes: Math.max(...rss), sampledMaxHeapBytes: Math.max(...heaps),
          gcRetainedHeapP50Bytes: percentile(retained, .5) });
        console.log(JSON.stringify(results.at(-1)));
      }
    } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  }
  const label = (process.argv[2] || 'result').replace(/[^a-z0-9_-]/gi, '');
  await fs.writeFile(path.join(__dirname, '..', 'doc', `long-task-mutations-${label}.json`), JSON.stringify({
    kind: 'synthetic offline shard graph benchmark; no workspace index', node: process.version, platform: process.platform,
    samplesPerMutation: 7, percentile: 'nearest-rank P95 equals maximum for 7 samples; no confidence claim',
    memory: 'per-save end samples, not process high-water marks; explicit GC before each sample', results }, null, 2) + '\n');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
