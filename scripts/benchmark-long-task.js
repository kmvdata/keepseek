/* Deterministic synthetic offline workload; no provider calls or user data.
 * Run after build:test: node --expose-gc scripts/benchmark-long-task.js [label]
 */
require('../out-test/test/registerVscodeStub');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const vscode = require('../out-test/test/stubs/vscode');
const { GlobalSessionStorage } = require('../out-test/src/sessions/globalSessionStorage');
const { ChatSessionStore } = require('../out-test/src/sessions/chatSessionStore');
const { checkpointCopy } = require('../out-test/src/agent/runCheckpoint');
let snapshotCheckpoint = checkpointCopy, subscribe = () => () => {};
try { subscribe = require('../out-test/src/agent/logging/performanceTrace').subscribeLocalPerformance; } catch { /* baseline */ }
try { snapshotCheckpoint = require('../out-test/src/sessions/persistenceSnapshot').snapshotCheckpoint; } catch { /* baseline */ }

function fixture(count, chars) {
  const now = new Date().toISOString();
  const model = { id: 'fixture-model', provider: 'qwencloud', sourceId: 'fixture', label: 'fixture', contextWindowTokens: 1024000, maxOutputTokens: 393192 };
  const messages = [];
  const history = [];
  for (let i = 0; i < count * 3; i++) {
    const message = { id: `m${i}`, role: i % 3 === 2 ? 'assistant' : 'user', content: `${i}:` + 'evidence fixture text '.repeat(Math.ceil(chars / 22)).slice(0, chars), createdAt: now };
    history.push(message);
    const visible = { ...message };
    if (i % 3 === 2) visible.runCheckpoint = {
      version: 2, taskId: `t${i}`, attempt: 1, attemptIds: [`run${i}`], status: 'completed', stopReason: 'completed',
      usedMs: 1000, maxExecutionMs: 0, limitSource: 'fixture', modelRequests: 1, retries: 0, updatedAt: now,
      source: { sourceId: 'fixture', modelId: model.id, provider: 'qwencloud', endpointHash: 'a'.repeat(64) }, workspaceFolders: [],
      request: { model, history: history.slice(), prompt: 'fixture task', settings: { thinkingEnabled: true, reasoningEffort: 'high' }, contextFiles: [], language: 'en' },
      state: { messages: history.map(m => ({ role: m.role, content: m.content })), toolRounds: [], draftEdits: [], draftRuns: [], reasoningParts: [], turn: 1, toolCallCount: 0, validationRunCount: 0, toolResultTokens: 0, repairLoop: {} }
    };
    messages.push(visible);
  }
  messages.at(-1).runCheckpoint.status = 'interrupted';
  messages.at(-1).runCheckpoint.stopReason = 'user_stop';
  return { id: 'benchmark', title: 'synthetic fixture', workspaceKey: 'benchmark', workspaceName: 'benchmark', workspaceFolders: [], createdAt: now, updatedAt: now, messages };
}
const percentile = (xs, p) => [...xs].sort((a,b)=>a-b)[Math.min(xs.length-1, Math.ceil(xs.length*p)-1)];
async function diskFiles(root) {
  const results = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const name = path.join(root, entry.name);
    if (entry.isDirectory()) results.push(...await diskFiles(name));
    else results.push({ path: name, bytes: (await fs.stat(name)).size });
  }
  return results;
}
async function main() {
  const results = [];
  for (const [name, count, chars] of [['small', 3, 2000], ['medium', 20, 12000], ['large', 55, 23800]]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-perf-'));
    try {
      const session = fixture(count, chars);
      const legacyBytes = Buffer.byteLength(JSON.stringify({ version: 2, workspaceKey: session.workspaceKey, session }));
      const storage = new GlobalSessionStorage(vscode.Uri.file(root));
      const scope = { key: 'benchmark', name: 'benchmark', folderUris: [] };
      const store = new ChatSessionStore(storage, 'en', scope);
      store.sessions = [session]; store.activeSessionIdValue = session.id;
      await store.persist();
      const writes = [], times = [], loop = [], rss = [], clone = [], writeCounts = [], storagePhases = [], heaps = [], retainedHeaps = [];
      const unsubscribe = subscribe(event => { if (event.type === 'checkpoint_store') storagePhases.push(event); });
      const original = vscode.workspace.fs.writeFile;
      let bytes = 0, countWrites = 0;
      vscode.workspace.fs.writeFile = async (uri, content) => { bytes += content.byteLength; countWrites++; return original(uri, content); };
      try {
        for (let n = 0; n < 7; n++) {
          global.gc?.(); retainedHeaps.push(process.memoryUsage().heapUsed); bytes = 0; countWrites = 0;
          const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
          await new Promise(r=>setTimeout(r, 20));
          const start = performance.now();
          const cpStart = performance.now();
          session.messages.at(-1).runCheckpoint = snapshotCheckpoint(session.messages.at(-1).runCheckpoint);
          session.messages.at(-1).runCheckpoint.usedMs += 1000;
          clone.push(performance.now()-cpStart);
          await store.persist();
          times.push(performance.now()-start); writes.push(bytes); writeCounts.push(countWrites);
          await new Promise(r=>setTimeout(r, 20));
          loop.push(histogram.max/1e6); histogram.disable(); rss.push(process.memoryUsage().rss); heaps.push(process.memoryUsage().heapUsed);
        }
      } finally { unsubscribe(); vscode.workspace.fs.writeFile = original; }
      const loadStart = performance.now(); await new GlobalSessionStorage(vscode.Uri.file(root)).loadWorkspace(scope);
      const loadMs = performance.now()-loadStart;
      const files = await diskFiles(root);
      const storageBytes = files.reduce((n, f) => n + f.bytes, 0);
      const graphBytes = files.filter(f => f.path.includes('.objects/')).reduce((n, f) => n + f.bytes, 0);
      results.push({ name, checkpointCount: count, legacyBytes, samples: 7, writeBytes: writes, saveP50Ms: percentile(times,.5), saveP95Ms: percentile(times,.95), checkpointCopyP50Ms: percentile(clone,.5), eventLoopMaxMs: Math.max(...loop), rssPeakBytes: Math.max(...rss), heapUsedPeakBytes: Math.max(...heaps), retainedHeapP50Bytes: percentile(retainedHeaps, .5), loadMs, storageBytes, graphBytes, files: files.length, writeCounts, encodeP50Ms: storagePhases.length ? percentile(storagePhases.map(e => e.encodeMs), .5) : undefined, commitP50Ms: storagePhases.length ? percentile(storagePhases.map(e => e.commitMs), .5) : undefined });
      console.log(JSON.stringify(results.at(-1)));
    } finally { await new Promise(r=>setTimeout(r, 150)); await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  }
  const label = (process.argv[2] || 'result').replace(/[^a-z0-9_-]/gi,'');
  await fs.writeFile(path.join(__dirname, '..', 'doc', `long-task-perf-${label}.json`), JSON.stringify({ kind: 'synthetic offline real filesystem benchmark', node: process.version, platform: process.platform, arch: process.arch, results }, null, 2)+'\n');
}
module.exports = { fixture, percentile };
if (require.main === module) main().catch(e=>{console.error(e);process.exitCode=1;});
