/* Read only input. Migration runs ONLY in a fresh temporary copy. No network.
 * node --expose-gc scripts/analyze-long-task-snapshot.js SNAPSHOT [OLD_EXTENSION_OUT]
 * Output is aggregate measurements; no message text, paths or account IDs. */
require('../out-test/test/registerVscodeStub');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { performance, monitorEventLoopDelay } = require('node:perf_hooks');
const vscode = require('../out-test/test/stubs/vscode');
const { SessionObjectStore } = require('../out-test/src/sessions/sessionObjectStore');
const { snapshotSession } = require('../out-test/src/sessions/persistenceSnapshot');
const { buildProviderRequestProjection, buildProviderPayloadProjection } = require('../out-test/src/agent/providerRequestProjection');
const { resolveProviderRequestBudget } = require('../out-test/src/agent/requestBudget');
const { AgentRunner } = require('../out-test/src/agent/runner');
const { createUsageDetailsViewModel } = require('../out-test/src/agent/subagentUsageStats');

async function main() {
  if (!process.argv[2]) throw new Error('A consistent offline snapshot path is required.');
  const source = await fs.readFile(process.argv[2]);
  const parsed = JSON.parse(source.toString('utf8')), session = parsed.session;
  if (parsed.version !== 2 || !Array.isArray(session?.messages)) throw new Error('Expected a KeepSeek V2 session snapshot.');
  if (session.messages.some(m => m.runCheckpoint?.status === 'running')) throw new Error('Snapshot has running checkpoints: use the stopped-writer recovery workflow.');
  const checkpoints = session.messages.flatMap(m => m.runCheckpoint ? [m.runCheckpoint] : []);
  const cp = checkpoints.at(-1), r = cp.request;
  const p = buildProviderRequestProjection({ ...r, agentSettings: r.settings });
  const body = buildProviderPayloadProjection({ modelId: r.model.id, provider: r.model.provider,
    maxOutputTokens: p.runtimeProfile.maxTokens, messages: cp.state.messages, tools: p.tools, native: cp.state.provider });
  const budget = resolveProviderRequestBudget({ model: r.model, provider: r.model.provider, body });
  const newAdmission = new AgentRunner().estimateCurrentProviderInputTokens(r, cp.state.messages, p.tools, cp.state.provider);
  let oldAdmission, oldView;
  if (process.argv[3]) {
    const OldRunner = require(path.resolve(process.argv[3], 'agent/runner.js')).AgentRunner;
    oldView = require(path.resolve(process.argv[3], 'agent/subagentUsageStats.js')).createUsageDetailsViewModel({ sessionUsageStats: session.usageStats }).session.total;
    oldAdmission = new OldRunner().estimateCurrentProviderInputTokens(r, cp.state.messages, p.tools, cp.state.provider);
  }
  const report = { kind: 'actual consistent offline snapshot; copied migration; no Provider request',
    sourceBytes: source.length, messageCount: session.messages.length, checkpointCount: checkpoints.length,
    embeddedCheckpointBytes: checkpoints.reduce((n,c) => n + Buffer.byteLength(JSON.stringify(c)), 0),
    repeatedHistoryBytes: checkpoints.reduce((n,c) => n + Buffer.byteLength(JSON.stringify(c.request.history)), 0),
    configuredWindow: r.model.contextWindowTokens, configuredOutput: r.model.maxOutputTokens,
    oldAdmissionInputTokens: oldAdmission, normalizedInputTokens: newAdmission,
    dispatchInputTokens: budget.estimatedInputTokens, needsCompaction: budget.needsCompaction,
    effectiveOutput: budget.actualMaxOutputTokens,
    lastStatus: cp.status, lastStopReason: cp.stopReason,
    storedAttemptCount: session.usageStats?.providerAttemptCount, storedUsageResponseCount: session.usageStats?.usageResponseCount,
    oldViewAttemptCount: oldView?.providerAttemptCount ?? null, oldViewUsageResponseCount: oldView?.usageResponseCount ?? null,
    newViewAttemptCount: createUsageDetailsViewModel({ sessionUsageStats: session.usageStats }).session.total.providerAttemptCount,
    newViewUsageResponseCount: createUsageDetailsViewModel({ sessionUsageStats: session.usageStats }).session.total.usageResponseCount };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-snapshot-migration-'));
  try {
    const shard = path.join(root, 'session.json'); await fs.writeFile(shard, source);
    const store = new SessionObjectStore(vscode.Uri.file(shard));
    const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
    await new Promise(resolve => setTimeout(resolve, 20));
    const start = performance.now(); await store.save(snapshotSession(session));
    report.migrationMs = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 20));
    report.migrationEventLoopMaxMs = loop.max / 1e6; loop.disable();
    report.migrationRssBytes = process.memoryUsage().rss;
    const manifestBytes = await fs.readFile(shard), manifest = JSON.parse(manifestBytes);
    report.manifestBytes = manifestBytes.length;
    const names = await fs.readdir(shard + '.objects');
    report.objectCount = names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).length;
    report.objectBytes = 0;
    for (const name of names.filter(n => /^[a-f0-9]{64}\.json$/.test(n))) report.objectBytes += (await fs.stat(path.join(shard + '.objects', name))).size;
    report.retainedLegacyBackupBytes = (await fs.stat(path.join(shard + '.objects', 'legacy-v2.json'))).size;
    const loadStart = performance.now(); const restored = await new SessionObjectStore(vscode.Uri.file(shard)).load(manifest);
    report.loadMs = performance.now() - loadStart;
    report.loadedCheckpointCount = restored.messages.filter(m => m.runCheckpoint).length;
    report.archivedCheckpointCount = restored.messages.filter(m => m.runCheckpointArchive).length;
    let bytes = 0;
    const original = vscode.workspace.fs.writeFile;
    vscode.workspace.fs.writeFile = async (uri, data) => { bytes += data.byteLength; return original(uri, data); };
    try { restored.updatedAt = new Date().toISOString(); await store.save(snapshotSession(restored)); }
    finally { vscode.workspace.fs.writeFile = original; }
    report.incrementalWriteBytes = bytes;
  } finally { await fs.rm(root, { recursive: true, force: true, maxRetries: 3 }); }
  await fs.writeFile(path.join(__dirname, '../doc/long-task-field-snapshot.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
