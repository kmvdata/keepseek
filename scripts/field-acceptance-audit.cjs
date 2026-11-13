/* Read-only, content-free acceptance audit. No account files, prompts, private
 * child graph or workspace writes. Explicit paths only; never auto-run live API.
 * node scripts/field-acceptance-audit.cjs STORAGE_DIR OUTPUT.json [TRACE_BASE ...]
 * TRACE_BASE is the run-....jsonl filename. Perf sidecars plus the first request
 * schema are projected; raw messages/content are never exported.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const sha = text => createHash('sha256').update(text).digest('hex');

function union(intervals) {
  let total = 0, end = -Infinity;
  for (const [start, stop] of intervals.filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b >= a).sort((a,b) => a[0]-b[0])) {
    total += Math.max(0, stop - Math.max(start, end)); end = Math.max(end, stop);
  }
  return total;
}
function reconcileChildren(summaries, records) {
  return summaries.map(summary => {
    const own = records.filter(r => (r.subagentId ?? r.cacheObservation?.conversationId ?? r.conversationId) === summary.subagentId);
    const attempts = summary.usage?.providerAttemptCount, usage = summary.usage?.usageResponseCount;
    const known = Number.isFinite(attempts) && Number.isFinite(usage);
    const responses = own.filter(r=>r.kind==='usage_response').length;
    return { subagentId:summary.subagentId,summaryAttempts:attempts ?? null,summaryUsage:usage ?? null,
      ledgerAttempts:own.length,ledgerUsage:responses,countsMatch:known ? attempts===own.length && usage===responses : null };
  });
}
function summarizePerformance(input, index = {}) {
  const rows = [...new Map(input.filter(r => Number.isFinite(r.monotonicMs)).map(r => [r.seq, r])).values()].sort((a,b) => a.seq-b.seq);
  const counts = {};
  for (const row of rows) counts[row.type] = (counts[row.type] ?? 0) + 1;
  const starts = new Map(), provider = [], open = [];
  for (const row of rows) {
    const key = row.requestId + ':' + (row.attemptIndex ?? row.attempt ?? 0);
    if (row.type === 'upstream_attempt_start') starts.set(key, row);
    if (row.type === 'upstream_attempt_finish' && starts.has(key)) {
      provider.push([starts.get(key).monotonicMs, row.monotonicMs]); starts.delete(key);
    }
  }
  open.push(...starts.keys());
  const stores = rows.filter(r => ['checkpoint_store', 'checkpoint_child_store', 'checkpoint_ledger_store'].includes(r.type) && Number.isFinite(r.durationMs));
  const intervals = stores.map(r => [r.monotonicMs-r.durationMs, r.monotonicMs]);
  const values = key => rows.filter(r => Number.isFinite(r[key])).map(r => r[key]);
  const range = xs => xs.length ? { count: xs.length, min: Math.min(...xs), max: Math.max(...xs) } : null;
  const first = rows[0], last = rows.at(-1), start = rows.find(r => r.type === 'run_start');
  const observationStart = start?.monotonicMs ?? first?.monotonicMs;
  const clipped = intervals.map(([a,b]) => [Math.max(observationStart, a), b]);
  return { runId: first?.runId ?? null, sessionId: first?.sessionId ?? null, taskId: first?.taskId ?? null,
    observedAt: last?.ts ?? null, firstSequence: first?.seq ?? null, lastSequence: last?.seq ?? null,
    traceComplete: !!start && first.seq === 1 && !index.droppedEvents && !index.writeFailures && !!(counts.run_end || counts.run_finish || counts.run_error),
    rotated: index.rotated ?? null, droppedEvents: index.droppedEvents ?? null, writeFailures: index.writeFailures ?? null,
    observationWallMs: first && last ? last.monotonicMs-observationStart : null, runEnded: !!(counts.run_end || counts.run_finish || counts.run_error),
    providerCompletedUnionMs: union(provider), openProviderAttempts: open,
    persistenceUnionMs: union(clipped), providerAndPersistenceOverlapMs: union(provider)+union(clipped)-union(provider.concat(clipped)),
    // Nested checkpoint_save includes waiting for persistence; never add it.
    checkpointSaveMs: range(rows.filter(r=>r.type==='checkpoint_save').map(r=>r.durationMs)),
    checkpointStoreMs: range(stores.map(r=>r.durationMs)), counts,
    eventLoopMaxMs: range(values('eventLoopMaxMs')), projectionInputTokensEstimate: range(values('estimatedInputTokens')),
    compression: rows.filter(r => Number.isFinite(r.netReleasedTokens)).map(r=>({ seq:r.seq, type:r.type,
      netReleasedTokens:r.netReleasedTokens, before:r.estimatedPromptTokens ?? null, after:r.afterEstimatedPromptTokens ?? null })),
    activeMs: null, userWaitMs: null, approvalWaitMs: null, parentAcceptanceMs: null,
    unknownIntervals: 'All uninstrumented/unpaired intervals remain unassigned; unions overlap and are not additive.' };
}

async function audit(storage, traceBases) {
  const modules = path.resolve('out-test');
  require(path.join(modules, 'test/registerVscodeStub'));
  const vscode = require(path.join(modules, 'test/stubs/vscode'));
  const { SubagentStore } = require(path.join(modules, 'src/agent/subagents/store'));
  const { UsageLedgerStore } = require(path.join(modules, 'src/agent/usageLedgerStore'));
  const { summarizeUsageLedger } = require(path.join(modules, 'src/agent/usageLedger'));
  const ledger = new UsageLedgerStore(vscode.Uri.file(storage));
  const workspaceRoot = path.join(storage, 'chat-sessions/v2/workspaces');
  const workspaceKeys = new Map();
  for (const folder of await fs.readdir(workspaceRoot)) {
    const v = JSON.parse(await fs.readFile(path.join(workspaceRoot, folder, 'index.json'), 'utf8'));
    if (typeof v.workspaceKey === 'string') workspaceKeys.set(sha(v.workspaceKey).slice(0,24), v.workspaceKey);
  }
  const report = { version: 1, kind: 'read-only-record-audit', capturedAt: new Date().toISOString(), units: { time:'ms', tokens:'upstream reported', bytes:'UTF-8' },
    atomicSnapshot: false, scope: 'Existing child summary indexes and their parent ledgers; no private graph, account data or conversation content is exported.', parents: [], traces: [] };
  const childRoot = path.join(storage, 'chat-sessions/v1/subagents');
  for (const workspaceHash of await fs.readdir(childRoot)) {
    const key = workspaceKeys.get(workspaceHash);
    if (!key) { (report.unmappedWorkspaceHashes ??= []).push(workspaceHash); continue; }
    const store = new SubagentStore(vscode.Uri.file(storage), key);
    for (const parent of await fs.readdir(path.join(childRoot, workspaceHash))) {
      if (!(await fs.stat(path.join(childRoot, workspaceHash, parent))).isDirectory()) continue;
      const restored = await store.readSummaries(parent);
      const page = await ledger.readAll(parent);
      const records = page.records.filter(r=>r.source==='subagent');
      const sum = summarizeUsageLedger({ version:1, records });
      const childReconciliation = reconcileChildren(restored.summaries, records);
      const statsKnown = childReconciliation.length === restored.activities.length && childReconciliation.every(r=>r.countsMatch!==null);
      const statsAttempts = statsKnown ? childReconciliation.reduce((n,s)=>n+s.summaryAttempts,0) : null;
      const statsUsage = statsKnown ? childReconciliation.reduce((n,s)=>n+s.summaryUsage,0) : null;
      report.parents.push({ workspaceHash, parentSessionId:parent, childCount:restored.activities.length,
        children:restored.activities.map(a=>({ subagentId:a.id, parentRunId:a.parentRunId, rootRunId:a.rootRunId, status:a.status,
          profile:a.profile, sourceId:a.sourceId, modelId:a.modelId })),
        summaries:restored.summaries.map(s=>({ subagentId:s.subagentId, providerAttemptCount:s.usage?.providerAttemptCount ?? null, usageResponseCount:s.usage?.usageResponseCount ?? null,
          requestCount:s.usage?.requestCount ?? null, totalTokens:s.usage?.totalTokens ?? null,
          reused:restored.activities.find(a=>a.id===s.subagentId)?.reused ?? false })),
        indexIncomplete:restored.incomplete, damagedLedgerBuckets:page.damagedBucketCount,
        ledger: { providerAttemptCount:sum.providerAttemptCount, usageResponseCount:sum.usageResponseCount, promptTokens:sum.promptTokens,
          completionTokens:sum.completionTokens, totalTokens:sum.totalTokens, cacheHitTokens:sum.cacheHitTokens, actualCostByCurrency:sum.costByCurrency },
        missingUsageAttempts:sum.providerAttemptCount-sum.usageResponseCount,
        childReconciliation,statsAttempts, statsUsage, countsMatch:statsKnown ? statsAttempts===sum.providerAttemptCount && statsUsage===sum.usageResponseCount : null,
        attemptIdentities:records.map(r=>({ requestId:r.requestId, attemptIndex:r.attemptIndex, kind:r.kind, subagentId:r.subagentId ?? null,
          taskId:r.taskId ?? null, conversationId:r.cacheObservation?.conversationId ?? null })),
        allRoles:summarizeUsageLedger({ version:1, records:page.records }).bySourceCounts });
    }
  }
  for (const base of traceBases) {
    const index = JSON.parse(await fs.readFile(base+'.perf-index.json','utf8'));
    const rows = [], sources = [];
    for (let i=0;i<4;i++) {
      try { const bytes=await fs.readFile(base+'.perf-'+i+'.jsonl');
        sources.push({ file:path.basename(base)+'.perf-'+i+'.jsonl', bytes:bytes.length, sha256:sha(bytes) });
        rows.push(...bytes.toString('utf8').trim().split('\n').filter(Boolean).map(JSON.parse));
      } catch(e) { if(e.code!=='ENOENT')throw e; }
    }
    const summary = summarizePerformance(rows,index);
    const requestIds = new Set(rows.filter(r=>r.type==='upstream_attempt_start').map(r=>r.requestId));
    const ledgerPage = summary.sessionId ? await ledger.readAll(summary.sessionId) : { records:[] };
    const records = ledgerPage.records.filter(r=>requestIds.has(r.requestId));
    const totals = summarizeUsageLedger({ version:1,records });
    let firstRequest = null, runConfiguration = null;
    const { getAgentTools } = require(path.join(modules,'src/agent/protocol'));
    const stream = require('node:fs').createReadStream(base);
    try {
      for await (const line of require('node:readline').createInterface({input:stream,crlfDelay:Infinity})) {
        const r=JSON.parse(line);
        if(r.type==='run_start') runConfiguration={ modelId:r.model?.id,sourceId:r.model?.sourceId,provider:r.model?.provider,
          contextWindowTokens:r.model?.contextWindowTokens,maxOutputTokens:r.model?.maxOutputTokens,
          thinkingEnabled:r.settings?.thinkingEnabled,reasoningEffort:r.settings?.reasoningEffort,compressionThreshold:r.settings?.compressionThreshold,
          requestProtocolVersion:r.requestProtocolVersion ?? null };
        if(r.type==='upstream_request') {
          const tools=r.body?.tools;
          if(Array.isArray(tools)&&tools.every(t=>t.function?.name)) {
            const schemaHash=sha(JSON.stringify(tools)),versions=[];
            for(let version=1;version<=11;version++)if(sha(JSON.stringify(getAgentTools({toolNames:tools.map(t=>t.function.name),requestProtocolVersion:version})))===schemaHash)versions.push(version);
            firstRequest={toolCount:tools.length,schemaSha256:schemaHash,matchingSchemaVersions:versions,
              hasDelegationCheckpoint:tools.some(t=>t.function.name==='keepseek_delegation_checkpoint'),maxOutputTokens:r.body.max_tokens ?? null,messageCount:r.body.messages?.length ?? null};
          }
          break;
        }
      }
    } finally {stream.destroy();}
    report.traces.push({ ...summary, sources,runConfiguration,firstRequest,
      ledger:{ providerAttemptCount:totals.providerAttemptCount,usageResponseCount:totals.usageResponseCount,promptTokens:totals.promptTokens,
        completionTokens:totals.completionTokens,totalTokens:totals.totalTokens,cacheHitTokens:totals.cacheHitTokens,bySource:totals.bySourceCounts },
      requestIdentities:records.map(r=>({requestId:r.requestId,attemptIndex:r.attemptIndex,kind:r.kind,source:r.source})) });
  }
  return report;
}
module.exports = { union, summarizePerformance, reconcileChildren, audit };
if (require.main === module) (async()=>{
  const [storage, output, ...traces] = process.argv.slice(2);
  if (!storage || !output) throw new Error('Expected STORAGE_DIR OUTPUT.json [TRACE_BASE ...]');
  const result = await audit(storage,traces);
  await fs.writeFile(output,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({ output, parents:result.parents.length, children:result.parents.reduce((n,p)=>n+p.childCount,0), mismatches:result.parents.filter(p=>p.countsMatch===false).length,unknown:result.parents.filter(p=>p.countsMatch===null).length }));
})().catch(()=>{process.stderr.write('field_acceptance_audit_failed\n');process.exitCode=1;});
