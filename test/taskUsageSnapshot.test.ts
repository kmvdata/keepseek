import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TaskUsageSnapshotTracker, normalizeTaskUsageSnapshot, taskUsageFingerprint, taskUsageLaneFingerprint, validTaskUsage } from '../src/tasks/taskUsageSnapshot';
import type { ProjectTaskCard } from '../src/tasks/projectTasks';
import type { ContextUsageEstimate, TaskContextUsageOrigin } from '../src/shared/types';
import { AgentRunner } from '../src/agent/runner';

const date = '2026-11-07T00:00:00.000Z';
function card(id = 'a'): ProjectTaskCard {
  return { version: 1, projectId: 'project', taskCardId: id, sessionId: `session-${id}`, rootTaskId: 'root', segmentId: 'segment', generation: 1,
    revision: 1, title: id, snapshot: { modelId: id, sourceId: id, endpoint: 'https://example.test/v1?key=secret', approvalMode: 'ask', executionMode: 'normal', skillIds: [] },
    state: 'running', sessionCreated: true, dependencies: [], inputIds: [], createdAt: date, updatedAt: date,
    archived: false, usedMs: 0, costByCurrency: {}, usageIncomplete: true };
}
function origin(value: ProjectTaskCard, revision = 1, extra: Partial<TaskContextUsageOrigin> = {}): TaskContextUsageOrigin {
  return { identity: { projectId: value.projectId, taskCardId: value.taskCardId, sessionId: value.sessionId, rootTaskId: value.rootTaskId,
    segmentId: value.segmentId!, generation: value.generation, hostId: 'host', runtimeId: `worker-${value.taskCardId}` },
    laneFingerprint: taskUsageFingerprint(value.snapshot.modelId), configurationFingerprint: taskUsageLaneFingerprint(value.snapshot),
    projectionRevision: revision, capturedAt: date, ...extra };
}
function usage(used: number, max: number): ContextUsageEstimate {
  return { usedTokensEstimate: used, maxTokensEstimate: max, usedPercent: used / max * 100 } as ContextUsageEstimate;
}

test('independent Workers retain their own model windows and completed keeps its last occupancy', () => {
  const tracker = new TaskUsageSnapshotTracker('project', 'host'), a = card(), b = card('b');
  tracker.bindWorker('a', 'worker-a'); tracker.bindWorker('b', 'worker-b');
  assert.equal(tracker.begin(origin(a), a), true);
  assert.equal(tracker.accept(origin(a), 1, usage(250, 1000), a, date), true);
  assert.equal(tracker.begin(origin(b), b), true);
  assert.equal(tracker.accept(origin(b), 1, usage(800, 2000), b, date), true);
  assert.equal(tracker.get(a)?.usage.usedPercent, 25); assert.equal(tracker.get(b)?.usage.usedPercent, 40);
  a.state = 'completed'; assert.equal(tracker.get(a)?.usage.usedPercent, 25);
  assert.equal(tracker.get(a)?.status, 'current');
});

test('new projection start invalidates late old calibration without imposing monotonic occupancy', () => {
  const tracker = new TaskUsageSnapshotTracker('project', 'host'), a = card(); tracker.bindWorker('a', 'worker-a');
  const old = origin(a), compressed = origin(a, 2);
  tracker.begin(old, a); tracker.accept(old, 1, usage(900, 1000), a, date);
  tracker.begin(compressed, a);
  assert.equal(tracker.get(a)?.status, 'last_known');
  assert.equal(tracker.accept(old, 999, usage(950, 1000), a, date), false);
  assert.equal(tracker.accept(compressed, 2, usage(200, 1000), a, date), true);
  assert.equal(tracker.get(a)?.usage.usedPercent, 20);
  assert.equal(tracker.accept(compressed, 1, usage(500, 1000), a, date), false);
  assert.equal(tracker.begin(old, a), false);
});

test('Worker reuse accepts a real new generation while old Host/runtime/root/segment/lane cannot overwrite', () => {
  const tracker = new TaskUsageSnapshotTracker('project', 'host'), a = card(); tracker.bindWorker('a', 'worker-a');
  const old = origin(a); tracker.begin(old, a); tracker.accept(old, 1, usage(900, 1000), a, date);
  a.rootTaskId = 'new-root'; a.segmentId = 'new-segment'; a.generation++;
  const current = origin(a, 2);
  assert.equal(tracker.begin(current, a), true);
  assert.equal(tracker.accept(current, 2, usage(300, 1000), a, date), true);
  assert.equal(tracker.begin({ ...current, projectionRevision: 3, identity: { ...current.identity, hostId: 'old-host' } }, a), false);
  assert.equal(tracker.begin({ ...current, projectionRevision: 3, identity: { ...current.identity, runtimeId: 'old-worker' } }, a), false);
  assert.equal(tracker.accept(old, 9999, usage(990, 1000), a, date), false);
  a.snapshot.modelId = 'new-model';
  assert.equal(tracker.get(a), undefined);
  assert.equal(tracker.begin(current, a), false);
  const newLane = origin(a, 3);
  assert.equal(tracker.begin(newLane, a), true);
  assert.equal(tracker.accept(newLane, 3, usage(100, 2000), a, date), true);
  assert.equal(tracker.accept({ ...newLane, laneFingerprint: current.laneFingerprint }, 4, usage(800, 1000), a, date), false);
  tracker.bindWorker('a', 'replacement');
  assert.equal(tracker.get(a)?.status, 'last_known');
  assert.equal(tracker.begin(origin(a, 4), a), false);
  assert.equal(tracker.begin(origin(a, 1, { identity: { ...newLane.identity, runtimeId: 'replacement' } }), a), true);
});

test('unknown, genuine zero, over-limit and malformed estimates remain distinguishable', () => {
  const tracker = new TaskUsageSnapshotTracker('project', 'host'), a = card(); tracker.bindWorker('a', 'worker-a');
  const source = origin(a); tracker.begin(source, a);
  assert.equal(tracker.get(a), undefined);
  assert.equal(tracker.accept(source, 1, usage(0, 1000), a, date), true);
  assert.equal(tracker.get(a)?.usage.usedPercent, 0);
  assert.equal(tracker.accept(source, 2, usage(1200, 1000), a, date), true);
  assert.equal(tracker.get(a)?.usage.usedPercent, 120);
  for (const value of [usage(-1, 1000), usage(1, 0), usage(Infinity, 1000), usage(1, NaN),
    { ...usage(500, 1000), usedPercent: 90 },
    { usedTokensEstimate: 1e308, maxTokensEstimate: 1e-308, usedPercent: 100 }]) assert.equal(validTaskUsage(value), false);
  assert.equal(tracker.accept(undefined as never, 3, usage(1, 10), a, date), false);
  // Legacy normalizer clamps percent but preserves the raw over-limit numerator.
  assert.equal(validTaskUsage({ ...usage(1200, 1000), usedPercent: 100 }), true);
});

test('restore only retains validated last-known display data; no credentials, execution or budget restored', () => {
  const tracker = new TaskUsageSnapshotTracker('project', 'host'), a = card(); tracker.bindWorker('a', 'worker-a');
  const source = origin(a); tracker.begin(source, a); tracker.accept(source, 1, usage(1, 10), a, date);
  const records = tracker.records([a]);
  assert.equal(JSON.stringify(records).includes('secret'), false);
  const restored = new TaskUsageSnapshotTracker('project', 'new-host'); restored.restore(records, [a]);
  assert.equal(restored.get(a)?.status, 'last_known');
  assert.equal(restored.accept(source, 2, usage(2, 10), a, date), false);
  assert.equal(normalizeTaskUsageSnapshot({ ...records[0], usage: usage(1, 0) }), undefined);
  assert.equal(taskUsageLaneFingerprint(a.snapshot), taskUsageLaneFingerprint({ ...a.snapshot, endpoint: 'https://user:password@example.test/v1?token=different#secret' }));
  restored.prune([]); assert.equal(restored.get(a), undefined);
});

test('evicting a Worker retains last-known occupancy while rejecting every late producer event', () => {
  const tracker = new TaskUsageSnapshotTracker('project', 'host'), a = card(); tracker.bindWorker('a', 'worker-a');
  const source = origin(a); tracker.begin(source, a); tracker.accept(source, 1, usage(3, 10), a, date);
  tracker.unbindWorker('a');
  assert.equal(tracker.get(a)?.status, 'last_known');
  assert.equal(tracker.get(a)?.usage.usedPercent, 30);
  assert.equal(tracker.accept(source, 2, usage(9, 10), a, date), false);
  assert.equal(tracker.begin(origin(a, 2), a), false);
  tracker.bindWorker('a', 'worker-replacement');
  const replacement = origin(a, 1, { identity: { ...source.identity, runtimeId: 'worker-replacement' } });
  assert.equal(tracker.begin(replacement, a), true);
  assert.equal(tracker.accept(replacement, 1, usage(1, 10), a, date), true);
  assert.equal(tracker.get(a)?.usage.usedPercent, 10);
});

test('observer reload replaces cleared metadata while a live owner rejects persisted rollback', () => {
  const owner = new TaskUsageSnapshotTracker('project', 'host'), a = card(); owner.bindWorker('a', 'worker-a');
  const source = origin(a); owner.begin(source, a); owner.accept(source, 1, usage(2, 10), a, date);
  const records = owner.records([a]);
  const observer = new TaskUsageSnapshotTracker('project', 'observer');
  observer.restore(records, [a]); assert.equal(observer.get(a)?.status, 'last_known');
  observer.restore([], [a]); assert.equal(observer.get(a), undefined, 'owner-cleared snapshot is removed on reload');
  observer.restore(records, [a]);
  observer.restore([{ ...records[0], configurationFingerprint: taskUsageFingerprint('obsolete config') }], [a]);
  assert.equal(observer.get(a), undefined, 'obsolete lane metadata cannot survive replacement');
  owner.accept(source, 2, usage(4, 10), a, date);
  owner.restore(records, [a]);
  assert.equal(owner.get(a)?.usage.usedPercent, 40);
  assert.equal(owner.get(a)?.status, 'current');
  owner.restore([], [a]); assert.equal(owner.get(a)?.usage.usedPercent, 40);
});

test('normalization whitelists identity fields and duplicate records cannot downgrade a producer revision', () => {
  const tracker = new TaskUsageSnapshotTracker('project', 'host'), a = card(); tracker.bindWorker('a', 'worker-a');
  const source = origin(a); tracker.begin(source, a); tracker.accept(source, 1, usage(2, 10), a, date);
  const snapshot = tracker.records([a])[0];
  const normalized = normalizeTaskUsageSnapshot({ ...snapshot, identity: { ...snapshot.identity, apiKey: 'never retain' } });
  assert.equal(JSON.stringify(normalized).includes('never retain'), false);
  const restored = new TaskUsageSnapshotTracker('project', 'new-host');
  restored.restore([{ ...snapshot, projectionRevision: 2, sequence: 3, usage: usage(1, 10) }, snapshot], [a]);
  assert.equal(restored.get(a)?.usage.usedPercent, 10);
  assert.equal(restored.get(a)?.projectionRevision, 2);
});

test('real Runner carries the pre-transport origin through async usage calibration instead of recapturing it', async () => {
  const tracker = new TaskUsageSnapshotTracker('project', 'host'), a = card(); tracker.bindWorker('a', 'worker-a');
  let revision = 0, sequence = 0, current: TaskContextUsageOrigin | undefined, requestOrigin: TaskContextUsageOrigin | undefined;
  const observations: Array<{ origin?: TaskContextUsageOrigin; accepted: boolean }> = [];
  const capture = () => { current = origin(a, ++revision); tracker.begin(current, a); return current; };
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests++; requestOrigin = current;
    // A newer projection/epoch has become authoritative while this request is
    // in flight. Its response must retain the old captured provenance.
    capture();
    return new Response('data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n'
      + 'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"total_tokens":102}}\n\ndata: [DONE]\n\n');
  };
  try {
    await new AgentRunner().run({ model: { id: 'deepseek-v4.1-flash-1017', label: 'fixture', provider: 'qwencloud',
      contextWindowTokens: 1024000, maxOutputTokens: 8192 }, prompt: 'Explain the result.', contextFiles: [], history: [],
      language: 'en', requestProtocolVersion: 8, settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
      sourceConfig: { sourceId: 'fixture', provider: 'qwencloud', baseUrl: 'https://fixture.invalid', apiKey: 'fixture-only-key', supportsBilling: false } }, {
      captureUsageEstimate: capture,
      onUsageEstimate: (estimate, source) => observations.push({ origin: source,
        accepted: !!source && tracker.accept(source, ++sequence, estimate, a, date) })
    });
    const requestObservations = observations.filter(item => item.origin === requestOrigin);
    assert.equal(requests, 1);
    assert.ok(requestObservations.length >= 2, 'initial budget and response calibration share a producer token');
    assert.equal(requestObservations[0].accepted, true);
    assert.equal(requestObservations.at(-1)?.accepted, false, 'late response does not receive a fresh projection revision');
  } finally { globalThis.fetch = originalFetch; }
});
