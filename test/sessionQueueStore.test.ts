import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as vscode from './stubs/vscode';
import { ProjectQueueStore, normalizeProjectSessionQueue, saveQueueWithRebase } from '../src/sessions/queue/queueStore';
import { createEmptyQueue, enqueueNewSession, effectiveMode, orderedSessionIds, promoteToFront } from '../src/sessions/queue/projectQueue';

const KEY = 'file:///project';
const NOW = '2026-11-13T00:00:00.000Z';

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'keepseek-queue-'));
  try { await run(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

function uriFor(dir: string): ConstructorParameters<typeof ProjectQueueStore>[0] {
  return vscode.Uri.parse(pathToFileURL(join(dir, 'queue.json')).toString()) as unknown as ConstructorParameters<typeof ProjectQueueStore>[0];
}

function seeded(...ids: string[]) {
  let queue = createEmptyQueue(KEY, NOW);
  for (const id of ids) queue = enqueueNewSession(queue, id, NOW);
  return queue;
}

test('a missing queue file reports absent and falls back to creation order', async () => {
  await withTempDir(async (dir) => {
    const store = new ProjectQueueStore(uriFor(dir));
    const result = await store.load(KEY, [
      { id: 'b', createdAt: '2026-11-02T00:00:00.000Z' },
      { id: 'a', createdAt: '2026-11-01T00:00:00.000Z' }
    ], NOW);
    assert.equal(result.status, 'absent');
    assert.deepEqual(orderedSessionIds(result.queue), ['a', 'b']);
    assert.equal(effectiveMode(result.queue, 'a'), 'normal');
  });
});

test('a saved queue round-trips byte-for-byte through validation', async () => {
  await withTempDir(async (dir) => {
    const store = new ProjectQueueStore(uriFor(dir));
    const queue = promoteToFront(seeded('a', 'b', 'c'), 'c');
    const saved = await store.save(queue, queue.revision - 1);
    assert.equal(saved.status, 'saved');

    const reloaded = await store.load(KEY);
    assert.equal(reloaded.status, 'loaded');
    assert.deepEqual(orderedSessionIds(reloaded.queue), ['c', 'a', 'b']);
    assert.equal(reloaded.queue.revision, queue.revision);
    assert.equal(effectiveMode(reloaded.queue, 'c'), 'normal');
    assert.ok(reloaded.queue.entries.every((entry) => entry.userOrdered === true));
  });
});

test('a stale save is rejected as a conflict and does not overwrite the newer order', async () => {
  await withTempDir(async (dir) => {
    const store = new ProjectQueueStore(uriFor(dir));
    const base = seeded('a', 'b', 'c');
    const first = promoteToFront(base, 'c');
    assert.equal((await store.save(first, base.revision)).status, 'saved');

    // A second window still believes the old order.
    const staleSecond = promoteToFront(base, 'b');
    const conflict = await store.save(staleSecond, base.revision);
    assert.equal(conflict.status, 'conflict');
    assert.deepEqual(orderedSessionIds(conflict.current!), ['c', 'a', 'b']);

    const onDisk = await store.load(KEY);
    assert.deepEqual(orderedSessionIds(onDisk.queue), ['c', 'a', 'b'], 'the first writer wins, no silent overwrite');
  });
});

test('saveQueueWithRebase replays the intent on top of the newer queue', async () => {
  await withTempDir(async (dir) => {
    const store = new ProjectQueueStore(uriFor(dir));
    const base = seeded('a', 'b', 'c');
    const first = promoteToFront(base, 'c');
    await store.save(first, base.revision);

    const rebased = await saveQueueWithRebase({
      store,
      workspaceKey: KEY,
      base,
      candidate: promoteToFront(base, 'b'),
      mutate: (queue) => promoteToFront(queue, 'b'),
      now: NOW
    });
    assert.equal(rebased.status, 'saved');
    assert.deepEqual(orderedSessionIds(rebased.queue), ['b', 'c', 'a']);
    const onDisk = await store.load(KEY);
    assert.deepEqual(orderedSessionIds(onDisk.queue), ['b', 'c', 'a']);
  });
});

test('a corrupt queue file is rebuilt from session facts instead of failing the project', async () => {
  await withTempDir(async (dir) => {
    const uri = uriFor(dir);
    await writeFile(uri.fsPath, '{ not json', 'utf8');
    const store = new ProjectQueueStore(uri);
    const result = await store.load(KEY, [
      { id: 'a', createdAt: '2026-11-01T00:00:00.000Z' },
      { id: 'b', createdAt: '2026-11-02T00:00:00.000Z' }
    ], NOW);
    assert.equal(result.status, 'rebuilt');
    assert.equal(result.diagnostic, 'invalid_project_session_queue');
    assert.deepEqual(orderedSessionIds(result.queue), ['a', 'b']);
  });
});

test('a queue for another workspace is rejected rather than adopted', async () => {
  await withTempDir(async (dir) => {
    const uri = uriFor(dir);
    const other = seeded('a', 'b');
    await writeFile(uri.fsPath, JSON.stringify({ ...other, workspaceKey: 'file:///other' }), 'utf8');
    const store = new ProjectQueueStore(uri);
    const result = await store.load(KEY);
    assert.equal(result.status, 'rebuilt');
    assert.deepEqual(orderedSessionIds(result.queue), []);
  });
});

test('validation rejects every malformed shape of the current format', () => {
  const valid = seeded('a', 'b');
  assert.ok(normalizeProjectSessionQueue(JSON.parse(JSON.stringify(valid)), KEY));

  const cases: unknown[] = [
    null,
    {},
    { ...valid, version: 2 },
    { ...valid, workspaceKey: 'file:///other' },
    { ...valid, revision: 0 },
    { ...valid, revision: 1.5 },
    { ...valid, updatedAt: 'not-a-date' },
    { ...valid, entries: 'nope' },
    { ...valid, entries: [{ sessionId: '', serial: 1, createdAt: NOW }] },
    { ...valid, entries: [{ sessionId: 'a', serial: 0, createdAt: NOW }] },
    { ...valid, entries: [{ sessionId: 'a', serial: 1, createdAt: 'bad' }] },
    { ...valid, entries: [
      { sessionId: 'a', serial: 1, createdAt: NOW },
      { sessionId: 'a', serial: 2, createdAt: NOW }
    ] },
    { ...valid, entries: [
      { sessionId: 'a', serial: 1, createdAt: NOW },
      { sessionId: 'b', serial: 1, createdAt: NOW }
    ] }
  ];
  for (const [index, value] of cases.entries()) {
    assert.equal(normalizeProjectSessionQueue(value, KEY), undefined, `case ${index} must be rejected`);
  }
});