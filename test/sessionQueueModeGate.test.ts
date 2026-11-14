import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEmptyQueue, enqueueNewSession, promoteToFront } from '../src/sessions/queue/projectQueue';
import { checkWritePermission, canWrite, describeWriteBlock } from '../src/sessions/queue/modeGate';

const KEY = 'file:///project';
const NOW = '2026-11-13T00:00:00.000Z';

function queue(...ids: string[]) {
  let value = createEmptyQueue(KEY, NOW);
  for (const id of ids) value = enqueueNewSession(value, id, NOW);
  return value;
}

test('the head session may write only while it holds the lease', () => {
  const q = queue('a', 'b');
  const withoutLease = checkWritePermission({ queue: q, sessionId: 'a', lease: {}, capability: 'edit' });
  assert.equal(withoutLease.allowed, false);
  assert.equal(withoutLease.reason, 'lease_free');

  const withLease = checkWritePermission({ queue: q, sessionId: 'a', lease: { holderSessionId: 'a' }, capability: 'edit' });
  assert.equal(withLease.allowed, true);
});

test('a queued non-head session can never write, even if it holds the lease', () => {
  const q = queue('a', 'b');
  const permission = checkWritePermission({ queue: q, sessionId: 'b', lease: { holderSessionId: 'b' }, capability: 'edit' });
  assert.equal(permission.allowed, false);
  assert.equal(permission.reason, 'queued_not_head');
  assert.equal(permission.mode, 'plan');
  assert.equal(permission.position, 1);
});

test('a head session blocked by another holder reports who it is waiting for', () => {
  const q = queue('a', 'b');
  const permission = checkWritePermission({ queue: q, sessionId: 'a', lease: { holderSessionId: 'b' }, capability: 'command' });
  assert.equal(permission.allowed, false);
  assert.equal(permission.reason, 'lease_held_by_other');
  assert.equal(permission.waitingFor, 'b', 'explicit handoff needs a named waiting target');
});

test('a promoted session gains write access once it holds the lease', () => {
  const q = promoteToFront(queue('a', 'b'), 'b');
  assert.equal(canWrite({ queue: q, sessionId: 'b', lease: { holderSessionId: 'b' }, capability: 'edit' }), true);
  assert.equal(canWrite({ queue: q, sessionId: 'a', lease: { holderSessionId: 'b' }, capability: 'edit' }), false);
});

test('a session outside the queue cannot write', () => {
  const permission = checkWritePermission({ queue: queue('a'), sessionId: 'ghost', lease: {}, capability: 'edit' });
  assert.equal(permission.allowed, false);
  assert.equal(permission.reason, 'not_queued');
});

test('every write capability is gated the same way', () => {
  const q = queue('a', 'b');
  for (const capability of ['edit', 'command', 'validation', 'git_mutation'] as const) {
    assert.equal(canWrite({ queue: q, sessionId: 'b', lease: { holderSessionId: 'b' }, capability }), false, capability);
    assert.equal(canWrite({ queue: q, sessionId: 'a', lease: { holderSessionId: 'a' }, capability }), true, capability);
  }
});

test('block descriptions are user-facing and never leak session ids', () => {
  const q = queue('a', 'b');
  const queued = checkWritePermission({ queue: q, sessionId: 'b', lease: {}, capability: 'edit' });
  const zh = describeWriteBlock(queued, 'zh-CN');
  const en = describeWriteBlock(queued, 'en');
  assert.ok(zh && zh.includes('第 2 位'), zh);
  assert.ok(en && en.includes('position 2'), en);
  assert.equal(describeWriteBlock(checkWritePermission({ queue: q, sessionId: 'a', lease: { holderSessionId: 'a' }, capability: 'edit' })), undefined);
});