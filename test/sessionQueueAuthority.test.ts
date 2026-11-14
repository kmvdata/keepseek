import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createEmptyQueue,
  effectiveMode,
  enqueueNewSession,
  orderedSessionIds,
  promoteToFront
} from '../src/sessions/queue/projectQueue';
import {
  checkWritePermission,
  canWrite,
  describeWriteBlock,
  type WriteCapability
} from '../src/sessions/queue/modeGate';
import { tryAcquire } from '../src/sessions/queue/writeLease';

/**
 * P2 invariant tests: the project queue — not a per-session flag — decides
 * `normal`/`plan`. These pin the rules that a queue-authoritative
 * `setExecutionMode` must preserve.
 */

const KEY = 'file:///project';
const NOW = '2026-11-13T00:00:00.000Z';

function build(...ids: string[]) {
  let queue = createEmptyQueue(KEY, NOW);
  for (const id of ids) queue = enqueueNewSession(queue, id, NOW);
  return queue;
}

test('only the queue head resolves to normal, regardless of any stored flag', () => {
  const queue = build('a', 'b', 'c');
  assert.deepEqual(orderedSessionIds(queue), ['a', 'b', 'c']);
  assert.equal(effectiveMode(queue, 'a'), 'normal');
  // b and c may carry a stale `normal` flag from before P2; the queue wins.
  assert.equal(effectiveMode(queue, 'b'), 'plan');
  assert.equal(effectiveMode(queue, 'c'), 'plan');
});

test('requesting normal promotes the session to the head and demotes the previous head', () => {
  const queue = build('a', 'b');
  const after = promoteToFront(queue, 'b');
  assert.equal(effectiveMode(after, 'b'), 'normal', 'the requested session is now normal');
  assert.equal(effectiveMode(after, 'a'), 'plan', 'the previous head becomes plan');
  assert.deepEqual(orderedSessionIds(after), ['b', 'a']);
});

test('there is never more than one normal session after any promotion', () => {
  let queue = build('a', 'b', 'c', 'd');
  for (const target of ['b', 'd', 'c', 'a']) {
    queue = promoteToFront(queue, target);
    const normal = queue.entries.filter((entry) => effectiveMode(queue, entry.sessionId) === 'normal');
    assert.equal(normal.length, 1, `exactly one normal after promoting ${target}`);
    assert.equal(normal[0].sessionId, target);
  }
});

test('a non-head session can never satisfy the write gate even with the lease', () => {
  const queue = build('a', 'b');
  // A stale lease held by a demoted session must not grant write access.
  const permission = checkWritePermission({
    queue,
    sessionId: 'b',
    lease: { holderSessionId: 'b' },
    capability: 'edit'
  });
  assert.equal(permission.allowed, false);
  assert.equal(permission.reason, 'queued_not_head');
  assert.equal(permission.mode, 'plan');
});

test('after promotion the new head writes and the old head is blocked', () => {
  const queue = promoteToFront(build('a', 'b'), 'b');
  assert.equal(canWrite({ queue, sessionId: 'b', lease: { holderSessionId: 'b' }, capability: 'edit' }), true);
  for (const capability of ['edit', 'command', 'validation', 'git_mutation'] as WriteCapability[]) {
    assert.equal(canWrite({ queue, sessionId: 'a', lease: { holderSessionId: 'b' }, capability }), false, capability);
  }
});

test('promotion does not disturb other sessions ordering', () => {
  const queue = promoteToFront(build('a', 'b', 'c', 'd'), 'c');
  assert.deepEqual(orderedSessionIds(queue), ['c', 'a', 'b', 'd']);
});

test('the blocking reason names the position, so a queued session knows it is waiting', () => {
  const queue = build('a', 'b', 'c');
  const permission = checkWritePermission({ queue, sessionId: 'c', lease: { holderSessionId: 'a' }, capability: 'edit' });
  assert.equal(permission.allowed, false);
  const zh = describeWriteBlock(permission, 'zh-CN');
  const en = describeWriteBlock(permission, 'en');
  assert.ok(zh && zh.includes('第 3 位'), zh);
  assert.ok(en && en.includes('position 3'), en);
});

test('the head must also hold the lease; queue position alone is not write access', () => {
  const queue = build('a', 'b');
  const noLease = checkWritePermission({ queue, sessionId: 'a', lease: {}, capability: 'edit' });
  assert.equal(noLease.allowed, false);
  assert.equal(noLease.reason, 'lease_free');

  const lease = tryAcquire({ workspaceKey: KEY, state: 'free', epoch: 0 }, 'a', NOW).lease;
  assert.equal(canWrite({ queue, sessionId: 'a', lease: { holderSessionId: lease.holderSessionId }, capability: 'edit' }), true);
});