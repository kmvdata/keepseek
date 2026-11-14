import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEmptyQueue,
  effectiveMode,
  enqueueNewSession,
  findEntry,
  headSessionId,
  moveDown,
  moveToIndex,
  moveUp,
  orderedSessionIds,
  positionOf,
  promoteToFront,
  reconcile,
  removeEntry
} from '../src/sessions/queue/projectQueue';
import type { ProjectSessionQueue } from '../src/sessions/queue/types';

const KEY = 'file:///project';

function queue(...ids: string[]): ProjectSessionQueue {
  let value = createEmptyQueue(KEY, '2026-11-13T00:00:00.000Z');
  for (const id of ids) value = enqueueNewSession(value, id, '2026-11-13T00:00:00.000Z');
  return value;
}

test('a newly created session starts as plan and only the head is normal', () => {
  const first = queue('a');
  assert.equal(effectiveMode(first, 'a'), 'normal');
  assert.equal(headSessionId(first), 'a');

  const second = enqueueNewSession(first, 'b');
  assert.equal(effectiveMode(second, 'a'), 'normal');
  assert.equal(effectiveMode(second, 'b'), 'plan', 'a new session must not become normal');
  assert.deepEqual(orderedSessionIds(second), ['a', 'b']);
});

test('enqueue is idempotent so a retried create cannot duplicate an entry', () => {
  const once = enqueueNewSession(queue('a'), 'b');
  const twice = enqueueNewSession(once, 'b');
  assert.equal(twice, once, 'a duplicate enqueue returns the same queue');
  assert.deepEqual(orderedSessionIds(twice), ['a', 'b']);
});

test('serial preserves creation order even after the user reorders', () => {
  const original = queue('a', 'b', 'c');
  const reordered = promoteToFront(original, 'c');
  assert.deepEqual(orderedSessionIds(reordered), ['c', 'a', 'b']);
  assert.equal(findEntry(reordered, 'a')?.serial, 1);
  assert.equal(findEntry(reordered, 'b')?.serial, 2);
  assert.equal(findEntry(reordered, 'c')?.serial, 3);
  assert.ok(reordered.entries.every((entry) => entry.userOrdered === true));
});

test('promoting a session makes it normal and demotes the previous head to plan', () => {
  const value = promoteToFront(queue('a', 'b'), 'b');
  assert.equal(effectiveMode(value, 'b'), 'normal');
  assert.equal(effectiveMode(value, 'a'), 'plan');
  assert.equal(headSessionId(value), 'b');
});

test('removing the head hands normal to the next entry', () => {
  const value = removeEntry(queue('a', 'b', 'c'), 'a');
  assert.deepEqual(orderedSessionIds(value), ['b', 'c']);
  assert.equal(effectiveMode(value, 'b'), 'normal');
  assert.equal(effectiveMode(value, 'c'), 'plan');
});

test('removing a middle or unknown session keeps the head unchanged', () => {
  const base = queue('a', 'b', 'c');
  const middle = removeEntry(base, 'b');
  assert.deepEqual(orderedSessionIds(middle), ['a', 'c']);
  assert.equal(effectiveMode(middle, 'a'), 'normal');
  assert.equal(removeEntry(base, 'missing'), base, 'unknown removal is a no-op');
});

test('moveUp and moveDown are bounded and never lose entries', () => {
  const base = queue('a', 'b', 'c');
  assert.equal(moveUp(base, 'a'), base, 'the head cannot move up');
  assert.equal(moveDown(base, 'c'), base, 'the tail cannot move down');

  const down = moveDown(base, 'a');
  assert.deepEqual(orderedSessionIds(down), ['b', 'a', 'c']);
  assert.equal(effectiveMode(down, 'b'), 'normal');

  const up = moveUp(down, 'c');
  assert.deepEqual(orderedSessionIds(up), ['b', 'c', 'a']);
});

test('moving to an out-of-range index clamps instead of dropping the entry', () => {
  const base = queue('a', 'b', 'c');
  assert.deepEqual(orderedSessionIds(moveToIndex(base, 'a', 99)), ['b', 'c', 'a']);
  assert.deepEqual(orderedSessionIds(moveToIndex(base, 'c', -5)), ['c', 'a', 'b']);
  assert.deepEqual(orderedSessionIds(moveToIndex(base, 'c', 99)), ['a', 'b', 'c']);
});

test('every accepted mutation advances the revision and updates updatedAt', () => {
  const base = queue('a', 'b');
  const before = base.revision;
  const moved = promoteToFront(base, 'b', '2026-11-13T01:00:00.000Z');
  assert.equal(moved.revision, before + 1);
  assert.equal(moved.updatedAt, '2026-11-13T01:00:00.000Z');
  assert.equal(base.revision, before, 'input queue is never mutated');
  assert.deepEqual(orderedSessionIds(base), ['a', 'b']);
});

test('operations never mutate the queue they are given', () => {
  const base = queue('a', 'b', 'c');
  const snapshot = JSON.stringify(base);
  promoteToFront(base, 'c');
  moveDown(base, 'a');
  removeEntry(base, 'a');
  enqueueNewSession(base, 'd');
  reconcile(base, [{ id: 'z', createdAt: '2026-01-01T00:00:00.000Z' }]);
  assert.equal(JSON.stringify(base), snapshot);
});

test('a session not in the queue derives plan and reports position -1', () => {
  const base = queue('a');
  assert.equal(positionOf(base, 'ghost'), -1);
  assert.equal(effectiveMode(base, 'ghost'), 'plan');
});

test('an empty queue has no head', () => {
  assert.equal(headSessionId(createEmptyQueue(KEY)), undefined);
  assert.equal(effectiveMode(createEmptyQueue(KEY), 'anything'), 'plan');
});

test('reconcile appends unknown sessions in creation order, not by id', () => {
  const base = queue('a');
  const repaired = reconcile(base, [
    { id: 'a', createdAt: '2026-11-01T00:00:00.000Z' },
    { id: 'zzz', createdAt: '2026-11-02T00:00:00.000Z' },
    { id: 'bbb', createdAt: '2026-11-03T00:00:00.000Z' }
  ]);
  assert.deepEqual(orderedSessionIds(repaired), ['a', 'zzz', 'bbb']);
  assert.equal(effectiveMode(repaired, 'a'), 'normal');
});

test('reconcile drops sessions that no longer exist', () => {
  const base = queue('a', 'b', 'c');
  const repaired = reconcile(base, [
    { id: 'b', createdAt: '2026-11-01T00:00:00.000Z' },
    { id: 'c', createdAt: '2026-11-02T00:00:00.000Z' }
  ]);
  assert.deepEqual(orderedSessionIds(repaired), ['b', 'c']);
  assert.equal(effectiveMode(repaired, 'b'), 'normal', 'normal follows the new head');
});

test('reconcile repairs duplicate ids and duplicate serials', () => {
  const broken: ProjectSessionQueue = {
    version: 1,
    workspaceKey: KEY,
    revision: 3,
    updatedAt: '2026-11-13T00:00:00.000Z',
    entries: [
      { sessionId: 'a', serial: 1, createdAt: '2026-11-01T00:00:00.000Z' },
      { sessionId: 'a', serial: 2, createdAt: '2026-11-01T00:00:00.000Z' },
      { sessionId: 'b', serial: 1, createdAt: '2026-11-02T00:00:00.000Z' }
    ]
  };
  const repaired = reconcile(broken, [
    { id: 'a', createdAt: '2026-11-01T00:00:00.000Z' },
    { id: 'b', createdAt: '2026-11-02T00:00:00.000Z' }
  ]);
  assert.deepEqual(orderedSessionIds(repaired), ['a', 'b']);
  const serials = repaired.entries.map((entry) => entry.serial);
  assert.equal(new Set(serials).size, serials.length, 'serials must be unique');
});

test('reconcile returns the same queue when nothing needed repair', () => {
  const base = queue('a', 'b');
  const same = reconcile(base, [
    { id: 'a', createdAt: '2026-11-01T00:00:00.000Z' },
    { id: 'b', createdAt: '2026-11-02T00:00:00.000Z' }
  ]);
  assert.equal(same, base, 'a no-op reconcile must not bump the revision');
});