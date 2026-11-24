/* End-to-end: what the user actually waits for when clicking a history entry.
 *
 * Runs the production `ChatSessionStore.selectSessionBounded()` path against a
 * *copy* of a real storage root (KEEPSEEK_BENCH_ROOT). Nothing here is synthetic:
 * the object graph, the checkpoints and the manifests are the user's own.
 * Every attempt gets a fresh store and a cold object cache, because the user
 * pays the cold path — never a cache warmed by a previous click.
 *
 * Run after `bun run build:test`. KEEPSEEK_BENCH_MODULES selects another build. */
const { join, resolve } = require('node:path');
const { cp, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const root = resolve(process.env.KEEPSEEK_BENCH_MODULES || 'out-test');
require(join(root, 'test/registerVscodeStub'));
const vscode = require(join(root, 'test/stubs/vscode'));
const { GlobalSessionStorage } = require(join(root, 'src/sessions/globalSessionStorage'));
const { ChatSessionStore } = require(join(root, 'src/sessions/chatSessionStore'));

const WORKSPACE_KEY = 'folders:file:///Users/kermit/Projects/kmvdata/deepseek/keepseek';

/** The store reports its two halves through its own stage log; reading that log
 * is the least invasive way to attribute end-to-end time without changing code
 * that is about to be changed. */
async function openOnce(storageRoot, sessionId) {
  const stages = [];
  const originalInfo = console.info;
  console.info = (tag, payload) => { if (payload && payload.stage) stages.push(payload); };
  let objectReads = 0, objectBytes = 0, objectWrites = 0;
  const read = vscode.workspace.fs.readFile, write = vscode.workspace.fs.writeFile;
  vscode.workspace.fs.readFile = async uri => {
    const data = await read(uri);
    if (/\.json\.objects\//u.test(uri.path)) { objectReads++; objectBytes += data.byteLength; }
    return data;
  };
  vscode.workspace.fs.writeFile = async (uri, data) => {
    if (/\.json\.objects\//u.test(uri.path)) objectWrites++;
    return write(uri, data);
  };
  try {
    const storage = new GlobalSessionStorage(vscode.Uri.file(storageRoot));
    const store = new ChatSessionStore(storage, 'en',
      { key: WORKSPACE_KEY, name: 'keepseek', folderUris: [WORKSPACE_KEY] });
    await store.initialize({ fresh: true });
    const started = performance.now();
    const selection = await store.selectSessionBounded(sessionId, { timeoutMs: 15000 });
    const totalMs = performance.now() - started;
    store.dispose();
    if (selection.status !== 'selected') throw new Error(`selection failed: ${selection.status}`);
    const stageMs = name => {
      const ended = stages.filter(stage => stage.stage === name && stage.event === 'end');
      return ended.length ? +ended.at(-1).elapsedMs.toFixed(1) : null;
    };
    return { totalMs: +totalMs.toFixed(1), loadMs: stageMs('session-body'),
      persistMs: stageMs('active-selection-save'), messages: selection.session.messages.length,
      objectReads, objectBytes, objectWrites };
  } finally {
    console.info = originalInfo;
    vscode.workspace.fs.readFile = read;
    vscode.workspace.fs.writeFile = write;
  }
}

async function main() {
  const source = process.env.KEEPSEEK_BENCH_ROOT;
  if (!source) throw new Error('KEEPSEEK_BENCH_ROOT is required');
  const sessionIds = (process.env.KEEPSEEK_BENCH_SESSIONS || '').split(',').filter(Boolean);
  if (!sessionIds.length) throw new Error('KEEPSEEK_BENCH_SESSIONS is required');
  const repeats = Number(process.env.KEEPSEEK_BENCH_REPEATS || 3);
  const scratch = await mkdtemp(join(tmpdir(), 'keepseek-open-bench-'));
  const storageRoot = join(scratch, 'storage');
  try {
    // copy: selectSessionBounded's own index repair must never touch real data
    await cp(source, storageRoot, { recursive: true });
    const results = [];
    for (const sessionId of sessionIds) {
      const runs = [];
      for (let attempt = 0; attempt < repeats; attempt++) runs.push(await openOnce(storageRoot, sessionId));
      const median = key => {
        const values = runs.map(run => run[key]).filter(value => typeof value === 'number')
          .sort((left, right) => left - right);
        return values.length ? values[Math.floor(values.length / 2)] : null;
      };
      results.push({ sessionId: sessionId.slice(0, 8), messages: runs[0].messages,
        medianTotalMs: median('totalMs'), medianLoadMs: median('loadMs'), medianPersistMs: median('persistMs'),
        objectReads: runs[0].objectReads, objectBytes: runs[0].objectBytes, objectWrites: runs[0].objectWrites,
        allTotalMs: runs.map(run => run.totalMs) });
    }
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), platform: process.platform,
      node: process.version, repeats, results }, null, 2));
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });