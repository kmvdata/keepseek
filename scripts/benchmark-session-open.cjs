/* Real-data benchmark for opening one historical session.
 *
 * Not synthetic: it reads a *copy* of a real session shard shipped by the user's
 * own installation. Pass the directory holding `<hash>.json` + `<hash>.json.objects`
 * with KEEPSEEK_BENCH_SESSION_DIR. Never point it at the live storage root.
 * Run after `bun run build:test`; KEEPSEEK_BENCH_MODULES selects another build. */
const { readdir, readFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const root = resolve(process.env.KEEPSEEK_BENCH_MODULES || 'out-test');
require(join(root, 'test/registerVscodeStub'));
const vscode = require(join(root, 'test/stubs/vscode'));
const { SessionObjectStore } = require(join(root, 'src/sessions/sessionObjectStore'));

async function countSessionReads(operation) {
  const originalRead = vscode.workspace.fs.readFile;
  const stat = { reads: 0, bytes: 0 };
  vscode.workspace.fs.readFile = async uri => {
    const bytes = await originalRead(uri);
    // Only object reads count; the caller's own manifest read is not part of
    // the object-graph cost being compared.
    if (/\.json\.objects\//u.test(uri.path)) { stat.reads += 1; stat.bytes += bytes.byteLength; }
    return bytes;
  };
  try {
    const started = performance.now();
    const value = await operation();
    return { value, durationMs: performance.now() - started, ...stat };
  } finally { vscode.workspace.fs.readFile = originalRead; }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)];
}

async function measureOnce(directory, file, limit) {
  const uri = vscode.Uri.file(join(directory, file));
  const store = new SessionObjectStore(uri);
  const manifest = JSON.parse(await readFile(join(directory, file), 'utf8'));
  const result = await countSessionReads(() => limit
    ? store.load(manifest, { tailLimit: limit })
    : store.load(manifest));
  if (!result.value || !Array.isArray(result.value.messages)) throw new Error('load returned no session');
  return {
    messages: result.value.messages.length,
    ...(limit ? { tailLimit: limit } : {}),
    durationMs: +result.durationMs.toFixed(1), objectReads: result.reads, objectBytes: result.bytes,
    // A recovery-relevant tail checkpoint must survive a bounded read.
    tailCheckpointLoaded: Boolean(result.value.messages.at(-1)?.runCheckpoint
      || result.value.messages.at(-1)?.runCheckpointArchive)
  };
}

async function main() {
  const directory = process.env.KEEPSEEK_BENCH_SESSION_DIR;
  if (!directory) throw new Error('KEEPSEEK_BENCH_SESSION_DIR is required');
  // Shard file names are the session id (32 hex), never an object hash (64).
  const files = (await readdir(directory)).filter(name => /^[a-f0-9]{32}\.json$/u.test(name));
  const report = [];
  for (const file of files) {
    const manifest = JSON.parse(await readFile(join(directory, file), 'utf8'));
    const variants = [undefined, 20];
    const rows = [];
    for (const limit of variants) {
      const runs = [];
      for (let attempt = 0; attempt < 5; attempt++) runs.push(await measureOnce(directory, file, limit));
      rows.push({ ...runs.at(-1), durationMs: +median(runs.map(run => run.durationMs)).toFixed(1),
        durationMsAll: runs.map(run => +run.durationMs.toFixed(1)) });
    }
    report.push({ file, revision: manifest.revision, storedMessages: manifest.messages.length, variants: rows });
  }
  console.log(JSON.stringify({ measuredAt: new Date().toISOString(), platform: process.platform,
    node: process.version, directory, report }, null, 2));
}
main().catch(error => { console.error(error); process.exitCode = 1; });