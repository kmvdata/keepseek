/* Production accountResolver/catalog/AgentRunner/serializer, with an isolated
 * VS Code filesystem facade. This is not a real Webview or six-hour soak test.
 * No live calls without explicit opt-in and positive user-supplied budgets.
 * bun run build:test first. Credentials are read through accountResolver only.
 */
require('../out-test/test/registerVscodeStub');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const vscode = require('../out-test/test/stubs/vscode');
const { ModelSourceStore } = require('../out-test/src/accounts/accountStore');
const { resolveModelSourceConfig } = require('../out-test/src/accounts/accountResolver');
const { createModelCatalog } = require('../out-test/src/accounts/modelCatalog');
const { AgentRunner } = require('../out-test/src/agent/runner');
const { WorkspaceToolService } = require('../out-test/src/agent/tools/workspaceTools');
const { InteractionTraceLogService } = require('../out-test/src/agent/logging/interactionTrace');
const { UsageLedgerStore } = require('../out-test/src/agent/usageLedgerStore');
const { snapshotCheckpoint } = require('../out-test/src/sessions/persistenceSnapshot');
const { writeJsonAtomic } = require('../out-test/src/shared/atomicStorage');

async function main() {
  if (process.env.KEEPSEEK_LIVE_ACCEPT !== '1') throw new Error('No live calls: set KEEPSEEK_LIVE_ACCEPT=1 after reviewing explicit budgets.');
  const required = name => { const value = process.env[name]; if (!value) throw new Error(`Missing ${name}`); return value; };
  const positive = name => { const value = Number(required(name)); if (!(value > 0) || !Number.isFinite(value)) throw new Error(`Invalid ${name}`); return value; };
  const maxCost = positive('KEEPSEEK_ACCEPT_MAX_COST');
  const maxRunMs = positive('KEEPSEEK_ACCEPT_MAX_MS');
  const maxModelRequests = positive('KEEPSEEK_ACCEPT_MAX_REQUESTS');
  if (!Number.isSafeInteger(maxRunMs) || !Number.isSafeInteger(maxModelRequests)) throw new Error('Time and request budgets must be integers.');
  const sourceStorage = vscode.Uri.file(path.resolve(required('KEEPSEEK_ACCEPT_SOURCE_STORAGE')));
  const sourceId = required('KEEPSEEK_ACCEPT_SOURCE_ID'), modelId = required('KEEPSEEK_ACCEPT_MODEL');
  const sourceStore = new ModelSourceStore(sourceStorage);
  const sourceConfig = await resolveModelSourceConfig(sourceId, sourceStorage, { sourceStore });
  const source = await sourceStore.getSource(sourceId);
  const model = createModelCatalog([source]).find(value => value.id === modelId && value.sourceId === sourceId);
  if (!model) throw new Error('Configured source/model unavailable. No fallback is allowed.');
  const directory = path.resolve(required('KEEPSEEK_ACCEPT_OUTPUT'));
  await fs.mkdir(directory, { recursive: true });
  if ((await fs.readdir(directory)).length) throw new Error('Output directory must be empty and isolated from production data.');
  const marker = `acceptance-${randomUUID()}`;
  await fs.writeFile(path.join(directory, 'acceptance.txt'), marker + '\n', { flag: 'wx' });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(directory), name: 'isolated acceptance' }];
  const originalConfig = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = (...args) => ({ ...originalConfig(...args), get: (key, fallback) =>
    key === 'trace.enabled' ? true : originalConfig(...args).get(key, fallback) });
  const storage = vscode.Uri.file(path.join(directory, 'runtime'));
  const ledger = new UsageLedgerStore(storage), records = [];
  const request = { sessionId: 'isolated-live-acceptance', model, sourceConfig, requestProtocolVersion: 10,
    prompt: 'Use keepseek_read_workspace_file to read acceptance.txt. Return its exact contents. Do not use any other tool.',
    history: [], contextFiles: [], language: 'en', slimToolNames: ['keepseek_read_workspace_file', 'keepseek_read_evidence'],
    settings: { thinkingEnabled: true, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    executionLimits: { maxCost, maxRunMs, maxModelRequests } };
  let checkpoint;
  try {
    const response = await new AgentRunner(new WorkspaceToolService(), new InteractionTraceLogService(storage),
      undefined, undefined, undefined, undefined, storage).run(request, {
      onCheckpoint: async cp => { checkpoint = snapshotCheckpoint(cp); await writeJsonAtomic(vscode.Uri.file(path.join(directory, 'checkpoint.json')), checkpoint, { durable: true }); },
      onUsageLedgerRecord: record => { records.push(record); }
    });
    await ledger.appendMany(request.sessionId, records);
    const verifiedBody = response.message.includes(marker) && response.runDetails.toolCalls.some(call => call.name === 'keepseek_read_workspace_file' && call.status === 'succeeded');
    await fs.writeFile(path.join(directory, 'acceptance-result.json'), JSON.stringify({
      kind: 'live production runtime with isolated VS Code facade', verifiedBody, sourceId, modelId,
      configuredContext: model.contextWindowTokens, configuredOutput: model.maxOutputTokens,
      lastRequestBudget: checkpoint?.lastRequestBudget, modelRequests: checkpoint?.modelRequests,
      usedMs: checkpoint?.usedMs, usedCostByCurrency: checkpoint?.usedCostByCurrency, traceLog: response.traceLog
    }, null, 2));
    if (!verifiedBody) throw new Error('No verified fixture body in final response. Inspect isolated evidence and trace.');
    console.log('Verified fixture body; inspect acceptance-result.json and isolated runtime logs.');
  } finally {
    if (records.length) await ledger.appendMany(request.sessionId, records);
    vscode.workspace.getConfiguration = originalConfig;
  }
}
main().catch(error => {
  const safe = /^(Missing KEEPSEEK_|Invalid KEEPSEEK_|No live calls|Configured source|Output directory|Time and request|No verified fixture)/u.test(error.message);
  console.error(safe ? error.message : 'Live runtime blocked or failed; inspect isolated trace, pricing and budgets. No credentials printed.');
  process.exitCode = 1;
});
