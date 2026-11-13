/* Bounded real KeepSeek AgentLoop + SubagentRuntime, native Provider transport,
 * real workspace tools and durable temporary stores. VS Code API is stubbed:
 * this is NOT Extension Host/UI acceptance. Credentials are resolved in memory
 * by accountResolver from an explicitly supplied existing storage directory.
 * Never log requests, responses, account objects or thrown provider messages.
 * Usage after build:test:
 * node scripts/field-acceptance-live.cjs STORAGE_DIR smoke OUTPUT.json
 * Additional batches: investigation, roles (run only after smoke inspection).
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const modules = path.resolve('out-test');
require(path.join(modules, 'test/registerVscodeStub'));
const vscode = require(path.join(modules, 'test/stubs/vscode'));
const { AgentLoop } = require(path.join(modules, 'src/agent/runner'));
const { ModelSourceStore } = require(path.join(modules, 'src/accounts/accountStore'));
const { resolveModelSourceConfig } = require(path.join(modules, 'src/accounts/accountResolver'));
const { createModelCatalog, findModelBySelection } = require(path.join(modules, 'src/accounts/modelCatalog'));
const { SubagentRuntime } = require(path.join(modules, 'src/agent/subagents/runtime'));
const { UsageLedgerStore } = require(path.join(modules, 'src/agent/usageLedgerStore'));
const { summarizeUsageLedger } = require(path.join(modules, 'src/agent/usageLedger'));
const { getConfiguredAgentSettings } = require(path.join(modules, 'src/shared/config'));
const { getCurrentWorkspaceSessionScope } = require(path.join(modules, 'src/sessions/chatSessionStore'));
const sha = data => createHash('sha256').update(data).digest('hex');
const batches = {
  smoke: [{ id: 'S01', prompt: '只读定位 CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION 的定义与 buildProviderRequestProjection 的关系。给出路径、行号和一句结论。不要修改文件或执行命令。' }],
  investigation: [{ id: 'S02', prompt: '只读核查 KeepSeek 子代理从分工评估、隔离请求、结果交付到用量归集的真实链路，给出各段源码证据和仍未证实的部分。不要修改或运行命令。' }],
  roles: [
    { id: 'S03', role: 'research', prompt: '/research 只读检查 src/agent/subagents/profiles.ts 内置 research 的工具与深度限制，返回源码证据和边界。不要执行命令。' },
    { id: 'S04', role: 'review', prompt: '/review 只读审查 src/agent/subagents/resultEnvelope.ts 如何处理超限与 partial，给出 verdict、源码证据和不确定项。不要执行命令。' },
    { id: 'S05', role: 'parallel', prompt: '/parallel 分别只读检查 src/agent/delegation.ts 中候选依赖门禁和 src/agent/subagents/profiles.ts 的 research 权限，这两个问题相互独立。综合源码证据与限制。不要修改或执行命令。' }
  ]
};

(async () => {
  const [sourceStorage, batch, output, transportCap] = process.argv.slice(2);
  if (!sourceStorage || !batches[batch] || !output) throw new Error('Expected STORAGE_DIR smoke|investigation|roles OUTPUT.json');
  if (transportCap !== undefined && (!/^\d+$/.test(transportCap) || Number(transportCap) < 1 || Number(transportCap) > 24)) throw new Error('Invalid transport cap');
  const root = process.cwd(), temp = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-live-acceptance-'));
  const report = { version: 1, kind: 'real-provider-real-runtime-vscode-stub', startedAt: new Date().toISOString(),
    outputUnit: 'tokens from upstream usage, durations in ms, bytes UTF-8', providerTraffic: true, extensionHost: false,
    batch, temporaryStorage: temp, limits: { maxPhysicalTransportsPerBatch: Math.min(batch === 'smoke' ? 3 : 24, Number(transportCap ?? 24)), maxMsPerSample: batch === 'smoke' ? 180000 : 300000 }, samples: [] };
  const originalFetch = globalThis.fetch;
  try {
    // JSONC parsing uses the installed compiler; no account data is read here.
    const ts = require('typescript');
    const workspaceConfig = ts.parseConfigFileTextToJson('settings', await fs.readFile('.vscode/settings.json', 'utf8')).config;
    let userConfig = {};
    try { userConfig = ts.parseConfigFileTextToJson('settings', await fs.readFile(path.join(sourceStorage, '../..', 'settings.json'), 'utf8')).config ?? {}; } catch { /* absent user settings */ }
    const config = { ...userConfig, ...workspaceConfig };
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'keepseek' }];
    vscode.workspace.getConfiguration = (section = 'keepseek') => ({ get: (key, fallback) => config[section + '.' + key] ?? fallback });
    const sourceStore = new ModelSourceStore(vscode.Uri.file(sourceStorage));
    const model = findModelBySelection(createModelCatalog(await sourceStore.listSources()), {
      sourceId: config['keepseek.selectedSourceId'], modelId: config['keepseek.selectedModelId']
    });
    if (!model || !config['keepseek.selectedSourceId']) throw new Error('No explicit existing workspace model');
    const resolved = await resolveModelSourceConfig(model.sourceId, vscode.Uri.file(sourceStorage), { sourceStore });
    const sourceConfig = { sourceId: resolved.sourceId, provider: resolved.provider, apiKey: resolved.apiKey, baseUrl: resolved.baseUrl, supportsBilling: resolved.supportsBilling };
    const settings = getConfiguredAgentSettings(), workspaceKey = getCurrentWorkspaceSessionScope().key;
    // Exact profile settings are copied, never credentials or account files.
    const settingsDir = path.join(sourceStorage, 'subagent-settings', 'v1');
    const settingFile = sha(workspaceKey).slice(0, 32) + '.json';
    try { const text = await fs.readFile(path.join(settingsDir, settingFile));
      await fs.mkdir(path.join(temp, 'subagent-settings/v1'), { recursive: true });
      await fs.writeFile(path.join(temp, 'subagent-settings/v1', settingFile), text); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const uri = vscode.Uri.file(temp), ledger = new UsageLedgerStore(uri);
    const runtime = new SubagentRuntime({ globalStorageUri: uri, workspaceKey, sourceStore });
    const projectText = await fs.readFile('AGENTS.md', 'utf8');
    report.model = { sourceId: model.sourceId, modelId: model.id, provider: model.provider,
      contextWindowTokens: model.contextWindowTokens, maxOutputTokens: model.maxOutputTokens, settings };
    const configured = require(path.join(modules, 'src/shared/config'));
    report.configuredLimits = Object.fromEntries(['getConfiguredModelRequestTimeoutMs', 'getConfiguredAgentMaxExecutionMs',
      'getConfiguredSubagentMaxExecutionMs', 'getConfiguredAgentMaxModelRequests', 'getConfiguredAgentMaxCost',
      'getConfiguredAgentMaxTreeUpstreamTokens'].map(name=>[name,configured[name]()]));
    report.workspaceSourceHash = sha(projectText);
    let physical = 0;
    for (const sample of batches[batch]) {
      if (physical >= report.limits.maxPhysicalTransportsPerBatch) break;
      const controller = new AbortController(), timer = setTimeout(() => controller.abort('field_acceptance_timebox'), report.limits.maxMsPerSample);
      const row = { sampleId: sample.id, goal: sample.prompt, sessionId: 'field-' + randomUUID(), requestProtocolVersion: 11,
        physicalAttempts: [], summaries: [], startedAt: new Date().toISOString(), status: 'running' };
      report.samples.push(row);
      const started = performance.now();
      globalThis.fetch = async (url, init) => {
        if (physical >= report.limits.maxPhysicalTransportsPerBatch) { controller.abort('field_acceptance_transport_cap'); throw new Error('field_acceptance_transport_cap'); }
        physical++;
        const body = JSON.parse(String(init.body));
        const userText = (body.messages ?? []).filter(x => x.role === 'user').map(x => x.content).join('\n');
        const child = /keepseek-subagent-result-binding-v1/.test(userText);
        const attempt = { ordinal: physical, child, modelId: body.model, maxOutputTokens: body.max_tokens ?? body.max_output_tokens,
          thinking: body.enable_thinking ?? body.thinking ?? null, inputBytes: Buffer.byteLength(String(init.body)), bodySha256: sha(String(init.body)),
          toolNames: (body.tools ?? []).map(x => x.function?.name ?? x.name),
          parentPrivateMarkerPresent: String(init.body).includes('FIELD_PARENT_PRIVATE_MARKER'), startedOffsetMs: performance.now() - started };
        row.physicalAttempts.push(attempt);
        // Original native transport and streaming response, unchanged.
        try { const response = await originalFetch(url, init); attempt.httpStatus = response.status; return response; }
        catch (e) { attempt.errorName = e.name; attempt.errorCode = e.cause?.code ?? null; throw e; }
      };
      let latest;
      try {
        const request = { model, sourceConfig, settings, prompt: sample.prompt, contextFiles: [], language: 'zh-CN',
          sessionId: row.sessionId, requestProtocolVersion: 11, signal: controller.signal,
          contextInstructions: projectText,
          currentRunContext: { projectInstructions: [{ id: 'rules', uri: vscode.Uri.file(path.join(root, 'AGENTS.md')).toString(),
            workspaceFolder: 'keepseek', content: projectText, contentHash: sha(projectText), characterCount: projectText.length, tokenEstimate: 0, truncated: false }], skills: [],
            metadata: { precedence: [], beforeDeduplicationCount: 1, afterDeduplicationCount: 1, totalCharacterCount: projectText.length, totalTokenEstimate: 0, truncated: false, sources: [], discarded: [], possibleConflicts: [] } },
          history: [{ id: 'private-marker', role: 'assistant', content: 'FIELD_PARENT_PRIVATE_MARKER', createdAt: '' },
            { id: 'user', role: 'user', content: sample.prompt, createdAt: '' }],
          ...(sample.role ? { explicitSubagentSelection: { kind: sample.role === 'parallel' ? 'parallel' : 'single', profile: sample.role === 'parallel' ? 'research' : sample.role } } : {}),
          executionLimits: { maxModelRequests: sample.id === 'S01' ? 3 : 12, maxRunMs: report.limits.maxMsPerSample, timeLimitSource: 'isolated field acceptance stop condition' } };
        const response = await new AgentLoop(undefined, undefined, undefined, undefined, undefined, undefined, uri, runtime).run(request, {
          onCheckpoint: async cp => { latest = cp; /* no credentials in product checkpoints */
            const { writeJsonAtomic } = require(path.join(modules, 'src/shared/atomicStorage'));
            await writeJsonAtomic(vscode.Uri.file(path.join(temp, sample.id + '.checkpoint.json')), cp, { durable: true }); },
          onUsageLedgerRecord: record => ledger.append(row.sessionId, record),
          onSubagentRunSummary: summary => row.summaries.push(summary)
        });
        row.runId = response.runId; row.status = response.taskPlan?.status ?? 'returned';
        row.delegation = response.taskPlan?.delegation ?? null;
        row.toolNames = response.toolRounds?.flatMap(r => r.toolCalls.map(c => c.function.name)) ?? [];
        row.answerHash = sha(response.message); row.answerChars = response.message.length;
        // Only fresh test answers, never existing personal conversation data.
        await fs.writeFile(path.join(temp, sample.id + '.answer.txt'), response.message);
        row.answerPath = path.join(temp, sample.id + '.answer.txt');
      } catch (e) { row.status = controller.signal.aborted ? 'stopped' : 'error'; row.errorName = e.name; row.errorCode = e.code ?? e.cause?.code ?? null; }
      finally { clearTimeout(timer); globalThis.fetch = originalFetch; }
      row.wallMs = performance.now() - started;
      row.taskId = latest?.taskId; row.activeMs = latest?.usedMs; row.stopReason = latest?.stopReason ?? null;
      const restored = await ledger.readAll(row.sessionId);
      row.ledger = summarizeUsageLedger({ version: 1, records: restored.records });
      row.usage = { knownResponseCount: row.ledger.usageResponseCount,
        missingAttemptCount: row.ledger.providerAttemptCount-row.ledger.usageResponseCount,
        actualTotalTokens: row.ledger.usageResponseCount ? row.ledger.totalTokens : null,
        actualCost: row.ledger.pricedRequestCount === row.ledger.providerAttemptCount && row.ledger.providerAttemptCount > 0 ? row.ledger.costByCurrency : null };
      row.ledgerIdentities = restored.records.map(r => ({ requestId: r.requestId, attemptIndex: r.attemptIndex, source: r.source, taskId: r.taskId, subagentId: r.subagentId, status: r.status }));
      row.restoredChildren = await runtime.restoreUsage(row.sessionId);
      await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
      if (row.status === 'error' || controller.signal.aborted || row.physicalAttempts.some(a => a.errorName || a.httpStatus >= 400)) break;
    }
  } catch (e) { report.blocked = { errorName: e.name, errorCode: e.code ?? null }; }
  finally { globalThis.fetch = originalFetch; report.finishedAt = new Date().toISOString(); await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n'); }
  console.log(JSON.stringify({ output, blocked: report.blocked ?? null, samples: report.samples.map(s => ({ sampleId: s.sampleId, status: s.status, attempts: s.physicalAttempts.length, stopReason: s.stopReason, ledgerAttempts: s.ledger?.providerAttemptCount })) }));
})().catch(() => { process.stderr.write('field_acceptance_setup_failed\n'); process.exitCode = 1; });
