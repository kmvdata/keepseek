import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import * as vscode from './stubs/vscode';
import { ProjectQueueService } from '../src/sessions/queue/queueService';
import { buildQueueView } from '../src/sessions/queue/queueView';
import { effectiveMode, orderedSessionIds, promoteToFront } from '../src/sessions/queue/projectQueue';

const KEY = 'file:///project';
const NOW = '2026-11-13T00:00:00.000Z';

async function withService(run: (service: ProjectQueueService, dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'keepseek-qsvc-'));
  try {
    const service = new ProjectQueueService((workspaceKey) => {
      const safe = workspaceKey.replace(/[^a-z0-9]/giu, '_');
      return vscode.Uri.parse(pathToFileURL(join(dir, `${safe}.json`)).toString()) as never;
    });
    await run(service, dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const seeds = [
  { id: 'a', createdAt: '2026-11-01T00:00:00.000Z' },
  { id: 'b', createdAt: '2026-11-02T00:00:00.000Z' }
];

test('the first session of a project becomes normal, the next one plan', async () => {
  await withService(async (service) => {
    await service.ensureLoaded(KEY, [seeds[0]], NOW);
    const afterFirst = await service.enqueue(KEY, 'a', [seeds[0]], NOW);
    assert.equal(effectiveMode(afterFirst, 'a'), 'normal');

    const afterSecond = await service.enqueue(KEY, 'b', seeds, NOW);
    assert.deepEqual(orderedSessionIds(afterSecond), ['a', 'b']);
    assert.equal(effectiveMode(afterSecond, 'a'), 'normal');
    assert.equal(effectiveMode(afterSecond, 'b'), 'plan');
    assert.equal(service.getDerivedMode(KEY, 'b'), 'plan');
  });
});

test('derived mode is undefined until the queue is loaded', async () => {
  await withService(async (service) => {
    assert.equal(service.getDerivedMode(KEY, 'a'), undefined, 'never invent a mode before load');
  });
});

test('queue state survives reload from disk', async () => {
  await withService(async (service) => {
    await service.ensureLoaded(KEY, seeds, NOW);
    await service.enqueue(KEY, 'a', [seeds[0]], NOW);
    await service.enqueue(KEY, 'b', seeds, NOW);
    await service.mutate(KEY, seeds, (queue) => promoteToFront(queue, 'b'), NOW);

    const fresh = new ProjectQueueService((workspaceKey) => queueUri(service, workspaceKey));
    await fresh.ensureLoaded(KEY, seeds, NOW);
    assert.deepEqual(orderedSessionIds(fresh.peek(KEY)!), ['b', 'a']);
    assert.equal(fresh.getDerivedMode(KEY, 'b'), 'normal');
  });
});

test('deleting the head hands normal to the next queued session', async () => {
  await withService(async (service) => {
    await service.ensureLoaded(KEY, seeds, NOW);
    await service.enqueue(KEY, 'a', [seeds[0]], NOW);
    await service.enqueue(KEY, 'b', seeds, NOW);
    const after = await service.remove(KEY, 'a', [seeds[1]], NOW);
    assert.deepEqual(orderedSessionIds(after), ['b']);
    assert.equal(effectiveMode(after, 'b'), 'normal');
  });
});

test('mutation chains serialize so concurrent reorders cannot interleave', async () => {
  await withService(async (service) => {
    const three = [...seeds, { id: 'c', createdAt: '2026-11-03T00:00:00.000Z' }];
    await service.ensureLoaded(KEY, three, NOW);
    for (const seed of three) await service.enqueue(KEY, seed.id, three, NOW);

    const results = await Promise.all([
      service.mutate(KEY, three, (queue) => promoteToFront(queue, 'c'), NOW),
      service.mutate(KEY, three, (queue) => promoteToFront(queue, 'b'), NOW)
    ]);
    const final = results.at(-1)!;
    assert.equal(final.entries.length, 3, 'no entry may be lost by interleaving');
    assert.equal(new Set(final.entries.map((entry) => entry.sessionId)).size, 3);
  });
});

test('the queue view projects positions, derived mode and move affordances', async () => {
  await withService(async (service) => {
    const three = [...seeds, { id: 'c', createdAt: '2026-11-03T00:00:00.000Z' }];
    await service.ensureLoaded(KEY, three, NOW);
    for (const seed of three) await service.enqueue(KEY, seed.id, three, NOW);

    const view = buildQueueView({
      queue: service.peek(KEY)!,
      titles: new Map([['a', 'Alpha'], ['b', 'Beta']])
    });
    assert.deepEqual(view.entries.map((entry) => entry.sessionId), ['a', 'b', 'c']);
    assert.deepEqual(view.entries.map((entry) => entry.position), [1, 2, 3]);
    assert.deepEqual(view.entries.map((entry) => entry.mode), ['normal', 'plan', 'plan']);
    assert.equal(view.entries[0].title, 'Alpha');
    assert.equal(view.entries[2].title, 'c', 'a missing title falls back to the id');
    assert.equal(view.entries[0].canMoveUp, false);
    assert.equal(view.entries[2].canMoveDown, false);
    assert.equal(view.headSessionId, 'a');
  });
});

/** Reuse the same on-disk location for a second service instance. */
function queueUri(service: ProjectQueueService, workspaceKey: string) {
  const internals = service as unknown as { queueUriFor: (key: string) => unknown };
  return internals.queueUriFor(workspaceKey) as never;
}