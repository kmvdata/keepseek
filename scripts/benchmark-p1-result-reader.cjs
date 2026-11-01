/* Real temporary filesystem + VS Code stub. No Provider calls or production data.
 * Compare the SAME script against f313a00 via KEEPSEEK_BENCH_MODULES. */
const fsPromises = require('node:fs/promises');
const { mkdtemp, rm, mkdir, writeFile } = fsPromises;
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const modules = resolve(process.env.KEEPSEEK_BENCH_MODULES || 'out-test');
require(join(modules, 'test/registerVscodeStub'));
const vscode = require(join(modules, 'test/stubs/vscode'));
const { SubagentStore } = require(join(modules, 'src/agent/subagents/store'));
const hash = text => createHash('sha256').update(text).digest('hex');
function metadata(id, result) {
  return { version: 2, id, treeId: 'tree', parentSessionId: 'parent', parentRunId: 'run', rootRunId: 'run', depth: 1,
    profile: 'research', lane: 'research-read', task: 'Synthetic reader benchmark', status: 'completed', resultStatus: 'complete',
    resultContractVersion: 2, resultFormatAccepted: true, sourceId: 'source', modelId: 'fixture', provider: 'deepseek',
    sourceConfigHash: hash('source'), systemPromptHash: hash('system'), toolSchemaHash: hash('tools'), profileHash: hash('profile'),
    projectInstructionsHash: hash('project'), normalizedTaskHash: hash('Synthetic reader benchmark'), resultHash: hash(result),
    resultChars: result.length, resultBytes: Buffer.byteLength(result), createdAt: '', updatedAt: '' };
}
async function sample(size, privateBytes, concurrent, layout = 'state') {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-reader-bench-'));
  const result = '中文😀x\n'.repeat(Math.ceil(size / 12));
  const writeStore = new SubagentStore(vscode.Uri.file(root), 'workspace');
  const ids = Array.from({ length: concurrent }, (_, index) => `child_${index}`);
  try {
    await Promise.all(ids.map(async id => {
      const transcript = { version: 2, metadataId: id, contextInstructions: 'PRIVATE instructions', messages: [{ id: 'private',
        role: 'assistant', content: 'p'.repeat(privateBytes), createdAt: '' }], result };
      if (layout === 'state') await writeStore.save(metadata(id, result), transcript);
      else {
        const directory = join(root, 'chat-sessions', 'v1', 'subagents', hash('workspace').slice(0, 24), 'parent');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, id + '.run.json'), JSON.stringify({ metadata: metadata(id, result), transcript }));
      }
    }));
    const readStore = new SubagentStore(vscode.Uri.file(root), 'workspace');
    const read = vscode.workspace.fs.readFile, originalOpen = fsPromises.open;
    let readBytes = 0, objectsRead = 0, sessionGraphObjectsRead = 0, nativeRangeBytes = 0, nativeRangeReads = 0;
    fsPromises.open = async (...args) => {
      const handle = await originalOpen(...args), nativeRead = handle.read.bind(handle);
      handle.read = async (...rangeArgs) => { const value = await nativeRead(...rangeArgs);
        nativeRangeBytes += value.bytesRead; nativeRangeReads++; return value; };
      return handle;
    };
    vscode.workspace.fs.readFile = async uri => {
      const value = await read(uri); readBytes += value.length; objectsRead++;
      if (uri.fsPath.includes('.state.json.objects')) sessionGraphObjectsRead++;
      return value;
    };
    const measurements = [];
    try {
      for (let iteration = 0; iteration < 6; iteration++) {
        readBytes = 0; objectsRead = 0; sessionGraphObjectsRead = 0; nativeRangeBytes = 0; nativeRangeReads = 0;
        const beforeMemory = process.memoryUsage(), started = performance.now();
        const pages = await Promise.all(ids.map(id => readStore.readResultPage({ parentSessionId: 'parent', ref: id,
          offsetBytes: iteration === 0 || iteration % 2 ? 0 : Math.floor(Math.min(12_288, Math.max(0, Buffer.byteLength(result) - 12)) / 12) * 12, limitBytes: 1024 })));
        const durationMs = performance.now() - started, afterMemory = process.memoryUsage();
        for (const page of pages) {
          assert.equal(page.ok, true); assert.ok(Number(page.returnedBytes) > 0); assert.ok(Number(page.returnedBytes) <= 1024);
          assert.equal(Buffer.byteLength(String(page.content)), page.returnedBytes);
        }
        measurements.push({ phase: iteration ? 'warm' : 'logical-cold', durationMs, readBytes: readBytes + nativeRangeBytes, objectsRead: objectsRead + nativeRangeReads,
          nativeRangeBytes, nativeRangeReads, sessionGraphObjectsRead, deliveredBytes: pages.reduce((sum, page) => sum + page.returnedBytes, 0),
          rssDeltaBytes: afterMemory.rss - beforeMemory.rss, heapDeltaBytes: afterMemory.heapUsed - beforeMemory.heapUsed });
      }
    } finally { vscode.workspace.fs.readFile = read; fsPromises.open = originalOpen; }
    return { layout, canonicalBytes: Buffer.byteLength(result), privateBytesPerChild: privateBytes, concurrentChildren: concurrent,
      measurements };
  } finally { await rm(root, { recursive: true, force: true }); }
}
(async () => {
  const samples = [];
  for (let round = 0; round < 3; round++) for (const [size, privateBytes, concurrent, layout] of [
    [1024, 0, 1], [120_000, 0, 1], [1_000_000, 0, 1], [1024, 4_000_000, 1],
    [120_000, 4_000_000, 1], [120_000, 4_000_000, 3], [120_000, 4_000_000, 1, 'legacy-combined']
  ]) samples.push({ round, ...await sample(size, privateBytes, concurrent, layout) });
  process.stdout.write(JSON.stringify({ version: 1, baseline: process.env.KEEPSEEK_BENCH_LABEL || 'working-tree',
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    methodology: 'Three fresh temp directories per scenario; one logical-cold and five warm pages. OS caches are not flushed. Real durable writes precede timing; no Provider traffic. Memory differences are samples, not peak or a production p95. Repeated reads reverify disk chunk hashes; queue is Promise.all concurrency.',
    samples }, null, 2) + '\n');
})().catch(error => { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; });
