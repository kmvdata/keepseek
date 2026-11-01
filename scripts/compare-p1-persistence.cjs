/* Compare the unchanged P0 persistence workload at f313a00 and the P1 tree.
 * Usage: node scripts/compare-p1-persistence.cjs BASELINE.json P1.json OUTPUT.json
 * Inputs must be measured separately after competing build/tests have stopped.
 */
const assert = require('node:assert/strict');
const { readFile, writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');

const metrics = ['totalMs', 'coldMs', 'hotMs', 'bytes', 'writes', 'reads', 'hotBytes', 'hotWrites', 'hotReads', 'ioPeak',
  'saves', 'snapshotMs', 'localPersistenceUnionMs', 'queueMs', 'processingMs', 'persistenceQueuePeak', 'objectsWritten'];
function summarize(rows, metric) {
  const values = rows.map(row => row[metric]).filter(value => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (!values.length) return { count: 0, min: null, median: null, max: null };
  const middle = Math.floor(values.length / 2);
  return { count: values.length, min: values[0], median: values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2, max: values.at(-1) };
}
(async () => {
  const [baselinePath, currentPath, outputPath] = process.argv.slice(2);
  assert.ok(baselinePath && currentPath && outputPath, 'Expected BASELINE.json P1.json OUTPUT.json');
  const [baseline, current] = await Promise.all([baselinePath, currentPath].map(async path => JSON.parse(await readFile(resolve(path), 'utf8'))));
  for (const key of ['node', 'platform', 'arch', 'provider', 'filesystem']) assert.equal(current.environment[key], baseline.environment[key], `Environment mismatch: ${key}`);
  assert.deepEqual(Object.keys(current.results), Object.keys(baseline.results), 'Workloads differ');
  const workloads = {};
  for (const kind of Object.keys(baseline.results)) {
    const before = baseline.results[kind], after = current.results[kind];
    assert.equal(before.length, 3, `${kind}: baseline is not the required three rounds`);
    assert.equal(after.length, 3, `${kind}: P1 is not the required three rounds`);
    assert.ok(before.concat(after).every(row => row.providerMs === 0), 'Unexpected Provider work in persistence-only comparison');
    assert.deepEqual(before.map(row => row.saves), after.map(row => row.saves), `${kind}: save counts changed`);
    workloads[kind] = {};
    for (const metric of metrics) {
      const old = summarize(before, metric), next = summarize(after, metric);
      workloads[kind][metric] = { baseline: old, p1: next,
        medianDelta: old.median === null || next.median === null ? null : next.median - old.median,
        medianDeltaPercent: old.median === null || old.median === 0 || next.median === null ? null : (next.median - old.median) / old.median * 100 };
    }
  }
  await writeFile(resolve(outputPath), JSON.stringify({ version: 1, baseline: 'f313a00', p1: 'uncommitted P1 working tree based on f313a00',
    baselineFile: baselinePath, p1File: currentPath, environment: current.environment, roundsPerWorkload: 3,
    conditions: { workloadScript: 'scripts/benchmark-p0-persistence.cjs (unchanged)', durableAtomicReplacement: true,
      realTemporaryFilesystem: true, vscodeStub: true, providerTraffic: false, originalHistoryAndCheckpointCountsPreserved: true },
    notes: ['This is the P1 delta from f313a00; it does not reuse the older P0 improvement from 9a874e8.',
      'Three local samples provide min/median/max observations, never production p95.',
      'Extra result-index metadata or IO is included. No history was removed, persistence barrier weakened, or execution budget increased.',
      'Timing is environment-dependent; compare IO counts/bytes and behavior alongside elapsed time.'], workloads }, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
