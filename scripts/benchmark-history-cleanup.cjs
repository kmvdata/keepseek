/* Synthetic, temporary data only. Run after bun run build:test. */
require('../out-test/test/registerVscodeStub.js');
const { mkdtemp, mkdir, writeFile, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const vscode = require('../out-test/test/stubs/vscode.js');
const { GlobalSessionStorage, getWorkspaceHash } = require('../out-test/src/sessions/globalSessionStorage.js');
const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 32);
async function main() {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-cleanup-benchmark-'));
  const workspaceKey = 'workspace:benchmark';
  const directory = path.join(root, 'chat-sessions', 'v2', 'workspaces', getWorkspaceHash(workspaceKey));
  const originalRead = vscode.workspace.fs.readFile;
  let bodyReads = 0;
  vscode.workspace.fs.readFile = async uri => {
    if (/\/sessions\/[a-f0-9]{32}\.json$/u.test(uri.path)) bodyReads++;
    return originalRead(uri);
  };
  const results = [];
  try {
    await mkdir(path.join(directory, 'sessions'), { recursive: true });
    for (const count of [1000, 10000]) {
      const entries = Array.from({ length: count }, (_, n) => ({ id: `fixture-${n}`, workspaceKey, title: 'Fixture',
        createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', messageCount: 1,
        storageFile: `sessions/${hash(`fixture-${n}`)}.json`, isFavorite: n % 10 === 0 }));
      await writeFile(path.join(directory, 'index.json'), JSON.stringify({ version: 2, workspaceKey, sessions: entries }));
      bodyReads = 0;
      const storage = new GlobalSessionStorage(vscode.Uri.file(root));
      const start = performance.now();
      const catalog = await storage.readHistoryCleanupCatalog(workspaceKey);
      results.push({ operation: 'readonlyPreview', summaries: count, candidates: catalog.entries.length,
        durationMs: +(performance.now() - start).toFixed(2), sessionShardReads: bodyReads, modelRequests: 0, maxConcurrency: 1 });
    }
    const count = 25;
    const entries = Array.from({ length: count }, (_, n) => ({ id: `fixture-${n}`, workspaceKey, title: 'Fixture',
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', messageCount: 1,
      storageFile: `sessions/${hash(`fixture-${n}`)}.json` }));
    await writeFile(path.join(directory, 'index.json'), JSON.stringify({ version: 2, workspaceKey, sessions: entries }));
    for (const entry of entries) await writeFile(path.join(directory, entry.storageFile), JSON.stringify({ version: 2,
      workspaceKey, session: { ...entry, messages: [{ id: 'm', role: 'user', content: 'synthetic', createdAt: entry.createdAt }] } }));
    const storage = new GlobalSessionStorage(vscode.Uri.file(root));
    const { entries: targets } = await storage.readHistoryCleanupCatalog(workspaceKey);
    bodyReads = 0;
    const start = performance.now(), outcomes = {};
    for (const target of targets) {
      const result = await storage.deleteHistoryCleanupTarget(target, 'benchmark-operation');
      outcomes[result.status] = (outcomes[result.status] || 0) + 1;
    }
    results.push({ operation: 'storageReclaim', targets: count, durationMs: +(performance.now() - start).toFixed(2),
      sessionShardReads: bodyReads, modelRequests: 0, maxConcurrency: 1, outcomes,
      note: 'associated store and Memento cleanup intentionally not counted as fullyDeleted' });
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), platform: process.platform, node: process.version, results }, null, 2));
  } finally { vscode.workspace.fs.readFile = originalRead; await rm(root, { recursive: true, force: true }); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
