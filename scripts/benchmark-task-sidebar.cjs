'use strict';

// Node DOM execution metrics only. This does not measure VS Code geometry or paint.
// Compile the harness first: bun run build:test
// Baseline source is read directly from Git, without a checkout or output mutation.
// Record: node scripts/benchmark-task-sidebar.cjs baseline|current [baseline-ref]
require('../out-test/test/registerVscodeStub.js');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, dirname, posix } = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const ts = require('typescript');
const { performance } = require('node:perf_hooks');
const os = require('node:os');
const assert = require('node:assert/strict');

const stage = process.argv[2];
assert.ok(stage === 'baseline' || stage === 'current', 'Choose baseline or current');
const repository = resolve(__dirname, '..');
const baselineRef = process.argv[3] || 'd5f941dfb941f58c14267fdb4a8663e826275e10';
const baselineCommit = execFileSync('git', ['rev-parse', '--verify', baselineRef + '^{commit}'], { cwd: repository, encoding: 'utf8' }).trim();
const sourceFiles = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', baselineCommit], { cwd: repository, encoding: 'utf8' }).split('\n'));
const modules = new Map(), sourceHashes = new Map();
const sha256 = value => createHash('sha256').update(value).digest('hex');
function loadSource(file) {
  if (modules.has(file)) return modules.get(file).exports;
  // Always use the same current test harness; all product source comes from the chosen lane.
  const source = stage === 'baseline' && file.startsWith('src/')
    ? execFileSync('git', ['show', baselineCommit + ':' + file], { cwd: repository, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    : readFileSync(resolve(repository, file), 'utf8');
  sourceHashes.set(file, sha256(source));
  const module = { exports: {} }; modules.set(file, module);
  const filename = resolve(repository, file), localRequire = createRequire(filename);
  const imports = name => {
    if (!name.startsWith('.')) return localRequire(name);
    const path = posix.normalize(posix.join(posix.dirname(file), name));
    const resolved = [path, path + '.ts', path + '/index.ts'].find(candidate =>
      candidate.endsWith('.ts') && (stage !== 'baseline' || !candidate.startsWith('src/') || sourceFiles.has(candidate)) &&
      (stage === 'baseline' && candidate.startsWith('src/') || require('node:fs').existsSync(resolve(repository, candidate))));
    return resolved ? loadSource(resolved) : localRequire(name);
  };
  const javascript = ts.transpileModule(source, { fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: false } }).outputText;
  new Function('require', 'module', 'exports', '__filename', '__dirname', javascript)(imports, module, module.exports, filename, dirname(filename));
  return module.exports;
}
const { createWebviewDomHarness } = loadSource('test/webviewDomHarness.ts');
const output = resolve(__dirname, '../doc/benchmarks/keepseek-task-sidebar-20261108.json');
const reports = [];
for (const count of [10, 100]) {
  for (let sample = 0; sample < 3; sample++) {
    const view = createWebviewDomHarness();
    const timestamp = new Date().toISOString();
    const cards = Array.from({ length: count }, (_, index) => ({
      taskCardId: `task-${index}`, title: `Task ${index}`, sessionId: `session-${index}`,
      rootTaskId: `root-${index}`, state: 'running', progress: 'Reading code',
      createdAt: timestamp, firstSubmittedAt: timestamp, firstSubmittedAtSource: 'user_input',
      lastActivityAt: timestamp, usedMs: 1000, costByCurrency: {}
    }));
    view.receive({ type: 'state', revision: 1, state: { activeSessionId: 'legacy', language: 'en',
      startup: { interactiveReady: true, sideEffectsReady: true } } });
    view.receive({ type: 'projectTasksState', projectId: 'benchmark', revision: 1,
      viewGeneration: 0, viewTaskId: null, messages: [], cards });
    const toggle = view.document.getElementById('projectSidebarToggle');
    if (toggle) toggle.click();
    const list = view.element('projectTaskList');
    // The rail is a blank drawer handle; task rows exist only in the drawer list.
    const initialRows = [...list.children];
    const transcript = view.element('transcript');
    let allocations = 0, listClears = 0, transcriptClears = 0;
    const create = view.document.createElement, createSvg = view.document.createElementNS;
    view.document.createElement = (...args) => { allocations++; return create(...args); };
    view.document.createElementNS = (...args) => { allocations++; return createSvg(...args); };
    const listReplace = list.replaceChildren;
    list.replaceChildren = function (...nodes) { listClears++; return listReplace.apply(this, nodes); };
    const transcriptReplace = transcript.replaceChildren;
    transcript.replaceChildren = function (...nodes) { transcriptClears++; return transcriptReplace.apply(this, nodes); };
    const postedBefore = view.posted.length;
    const started = performance.now();
    for (let update = 0; update < 50; update++) {
      cards[update % count] = { ...cards[update % count], progress: `Step ${update}`, usedMs: 1000 + update };
      view.receive({ type: 'projectTasksState', projectId: 'benchmark', revision: 2 + update,
        viewGeneration: 0, viewTaskId: null, cards });
    }
    reports.push({ cards: count, sample: sample + 1, updates: 50,
      elapsedMs: Number((performance.now() - started).toFixed(3)), createdElements: allocations,
      taskListReplaceChildren: listClears, transcriptReplaceChildren: transcriptClears,
      retainedTaskRows: initialRows.filter(node => list.children.includes(node)).length,
      retainedRailRows: 0, initialTaskRows: initialRows.length, initialRailRows: 0,
      emittedMessages: view.posted.length - postedBefore });
  }
}
let report = {};
try { report = JSON.parse(readFileSync(output, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
report.environment = { platform: process.platform, arch: process.arch, node: process.version,
  osRelease: os.release(), cpu: os.cpus()[0]?.model, harness: 'test/webviewDomHarness.ts',
  sampleScope: 'Complete generated Webview script in Node VM, overlay opened; 50 card-only updates per sample',
  limits: 'No native VS Code, browser layout/paint, bounding boxes, Provider billing or cache hit measurement. Timings are synchronous harness execution only.' };
report[stage] = { recordedAt: new Date().toISOString(), source: stage === 'baseline' ? { commit: baselineCommit } : {
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), workingTree: true },
  sourceSha256: Object.fromEntries([...sourceHashes].filter(([path]) => path === 'test/webviewDomHarness.ts' || path.startsWith('src/webview/')).sort()),
  generatedScriptSha256: sha256(loadSource('src/webview/script.ts').getScript()),
  generatedTemplateSha256: sha256(loadSource('src/webview/template.ts').getTemplate()), samples: reports };
mkdirSync(resolve(__dirname, '../doc/benchmarks'), { recursive: true });
writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ stage, output, samples: reports }));
