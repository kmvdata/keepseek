// Reproduce after `bun run build:test`: node scripts/benchmark-project-views.cjs
// Uses only temporary sessions. No Provider requests or real workspace edits.
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const ts = require(process.cwd() + '/node_modules/typescript');
require(process.cwd() + '/out-test/test/registerVscodeStub.js');
const vscode = require(process.cwd() + '/out-test/test/stubs/vscode.js');
const { GlobalSessionStorage } = require(process.cwd() + '/out-test/src/sessions/globalSessionStorage.js');
const { ChatSessionStore } = require(process.cwd() + '/out-test/src/sessions/chatSessionStore.js');
const baselineRef = process.env.KEEPSEEK_BENCHMARK_BASELINE || '87ee2bbc29546e575556f2e49aae67136f781e00';
const original = execFileSync('git', ['show', `${baselineRef}:src/sessions/chatSessionStore.ts`], { encoding: 'utf8' });
const baseline = new Module(process.cwd() + '/out-test/src/sessions/baselineChatSessionStore.js', module);
baseline.filename = process.cwd() + '/out-test/src/sessions/baselineChatSessionStore.js';
baseline.paths = module.paths;
baseline._compile(ts.transpileModule(original, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, baseline.filename);
const BaselineStore = baseline.exports.ChatSessionStore;
const quantiles = values => {
  const sorted = [...values].sort((a,b) => a-b);
  return { samples: values.length, p50: sorted[Math.ceil(sorted.length*.50)-1], p95: sorted[Math.ceil(sorted.length*.95)-1], p99: sorted[Math.ceil(sorted.length*.99)-1] };
};
(async () => {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-view-bench-'));
 const scope = { key: 'benchmark-project', name: 'Benchmark', folderUris: [] };
 let modelCalls = 0;
 const priorFetch = global.fetch;
 global.fetch = async () => { modelCalls++; throw new Error('No model or network requests authorized in benchmark.'); };
 const storage = new GlobalSessionStorage(vscode.Uri.file(root));
 const now = new Date().toISOString();
 const session = id => ({ id, title: id, approvalMode: 'ask', executionMode: 'normal',
   createdAt: now, updatedAt: now, workspaceKey: scope.key, workspaceName: scope.name, workspaceFolders: [],
   contextInstructions: 'Frozen context\n  exact bytes', messages: Array.from({length:100}, (_,i) => ({
    id: `${id}-${i}`, role: i%2 ? 'assistant' : 'user', content: 'unchanged history '.repeat(64), createdAt: now })) });
 const a = session('A'), b = session('B');
 await storage.saveWorkspace(scope, { activeSessionId:'A', sessions:[a,b], approvalMode:'ask' });
 const originalLog = console.info; console.info = () => {};
 const before = new BaselineStore(storage, 'en', scope); await before.initialize(); await before.selectSession('B');
 const after = new ChatSessionStore(storage, 'en', scope); await after.initialize(); await after.loadSessionById('A'); await after.loadSessionById('B');
 const hotBefore=[], hotAfter=[], coldBefore=[], coldAfter=[];
 for(let i=0;i<30;i++) { let t=performance.now(); await before.selectSession(i%2?'A':'B'); hotBefore.push(performance.now()-t); }
 for(let i=0;i<30;i++) { let t=performance.now(); await after.viewSessionPage(i%2?'A':'B'); hotAfter.push(performance.now()-t); }
 // Cold means new JS storage+store instances, OS filesystem cache remains warm.
 for(let i=0;i<30;i++) {
  const s = new GlobalSessionStorage(vscode.Uri.file(root));
  const store = new BaselineStore(s,'en',scope); await store.initialize();
  const target = store.activeSessionId === 'A' ? 'B' : 'A'; let t=performance.now();
  await store.selectSession(target); coldBefore.push(performance.now()-t); await s.flush();
 }
 for(let i=0;i<30;i++) {
  const s = new GlobalSessionStorage(vscode.Uri.file(root));
  const store = new ChatSessionStore(s,'en',scope); await store.initialize();
  const target = store.activeSessionId === 'A' ? 'B' : 'A'; let t=performance.now();
  await store.viewSessionPage(target); coldAfter.push(performance.now()-t); await s.flush();
 }
 console.info = originalLog;
 const data = { measuredAt: new Date().toISOString(), platform: { platform:process.platform, arch:process.arch, node:process.version, cpu:os.cpus()[0]?.model },
   baseline: { head:execFileSync('git',['rev-parse',baselineRef],{encoding:'utf8'}).trim(), storeSha256:createHash('sha256').update(original).digest('hex') },
   currentCompiledStoreSha256:createHash('sha256').update(await fs.readFile(process.cwd()+'/out-test/src/sessions/chatSessionStore.js')).digest('hex'),
   fixture: { sessions:2, messagesPerSession:100, contentBytesPerMessage:Buffer.byteLength(a.messages[0].content), concurrentWorkers:0 },
   definitions: { hot:'Both authority sessions resident; alternate A/B. Baseline actual selectSession includes required selection persistence; new pure viewSessionPage has no writes.', cold:'New JS store and object-store instances; OS filesystem cache warm. Baseline selects cold target authority and persists; new projection decodes only final 30 display bodies.',
     sharedBackend:'Both variants use current GlobalSessionStorage/object storage. Only ChatSessionStore and the select/view path vary; this is not a full old-extension release benchmark.',
     scope:'Host read/publication preparation only. No actual Webview paint, cursor, durable input or Worker start measurements.' },
   milliseconds:{ baselineHot:quantiles(hotBefore), currentHot:quantiles(hotAfter), baselineCold:quantiles(coldBefore), currentCold:quantiles(coldAfter) },
   modelCalls, memory:process.memoryUsage(), processPeakRssBytes:process.resourceUsage().maxRSS*1024,
   memoryScope:'End-of-run sample and lifetime peak of the same benchmark process, including baseline/current fixtures; not separate runtime or concurrent Worker peaks.',
   thresholds:{ hotHostPreparationP95Under200ms:quantiles(hotAfter).p95<=200, coldHostPreparationP95Under1000ms:quantiles(coldAfter).p95<=1000 },
   limitations:['No native VS Code/Webview paint measurement.','No true cold OS disk cache.','Memory includes baseline/current fixtures in one process, not isolated Worker peak.','No Provider usage or paid cache/fee measurement.'] };
 await storage.flush(); await fs.rm(root,{recursive:true,force:true}); global.fetch = priorFetch;
 await fs.mkdir('doc/benchmarks',{recursive:true});
 await fs.writeFile('doc/benchmarks/keepseek-project-view-storage-20261107.json',JSON.stringify(data,null,2)+'\n');
 console.log(JSON.stringify(data));
})().catch(error => { console.error(error); process.exitCode=1; });
