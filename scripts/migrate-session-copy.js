/* Offline recovery utility. Never writes the input or installs an extension.
 * Close all writers before RESTORING the output. Build:test is required.
 * node scripts/migrate-session-copy.js OLD_SHARD_JSON NEW_EMPTY_DIRECTORY
 */
require('../out-test/test/registerVscodeStub');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('../out-test/test/stubs/vscode');
const { SessionObjectStore } = require('../out-test/src/sessions/sessionObjectStore');
const { normalizeRunCheckpoint } = require('../out-test/src/agent/runCheckpoint');
const { snapshotSession } = require('../out-test/src/sessions/persistenceSnapshot');
async function main() {
  const [input, directory] = process.argv.slice(2);
  if (!input || !directory) throw new Error('Usage: migrate-session-copy.js OLD_SHARD_JSON NEW_EMPTY_DIRECTORY');
  const source = path.resolve(input), destination = path.resolve(directory);
  if (path.dirname(source) === destination) throw new Error('Output must be a separate empty directory.');
  const before = await fs.stat(source), bytes = await fs.readFile(source), after = await fs.stat(source);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes.length !== after.size) throw new Error('Input changed: obtain a consistent stopped-writer snapshot first.');
  const old = JSON.parse(bytes.toString('utf8'));
  if (old.version !== 2 || !Array.isArray(old.session?.messages)) throw new Error('Expected a V2 session shard.');
  const session = old.session;
  for (const message of session.messages) if (message.runCheckpoint) {
    const normalized = normalizeRunCheckpoint(message.runCheckpoint);
    if (!normalized) throw new Error('Invalid checkpoint: refusing to discard recovery state.');
    message.runCheckpoint = normalized;
  }
  await fs.mkdir(destination, { recursive: true });
  if ((await fs.readdir(destination)).length) throw new Error('Output directory must be empty.');
  const shard = path.join(destination, path.basename(source));
  await fs.writeFile(shard, bytes, { flag: 'wx' });
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.once('SIGINT', cancel);
  let lastProgress = 0, lastPhase = '';
  const storage = new SessionObjectStore(vscode.Uri.file(shard), true, { signal: controller.signal,
    onProgress: (phase, completed, total) => {
      if (phase !== lastPhase || Date.now() - lastProgress >= 1000) {
        console.error(JSON.stringify({ phase, completed, total }));
        lastPhase = phase; lastProgress = Date.now();
      }
    } });
  try { await storage.save(snapshotSession(session)); }
  finally { process.removeListener('SIGINT', cancel); }
  const manifest = JSON.parse(await fs.readFile(shard, 'utf8'));
  const verified = await new SessionObjectStore(vscode.Uri.file(shard)).load(manifest);
  if (verified.messages.length !== session.messages.length) throw new Error('Verification failed. Original copy retained.');
  console.log(JSON.stringify({ output: shard, objects: shard + '.objects', messages: verified.messages.length,
    note: 'Verified recovery copy only. No process resumed, approval reused, or original file replaced.' }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
