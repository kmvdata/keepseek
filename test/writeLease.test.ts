import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createFreeLease,
  handOff,
  isEpochCurrent,
  isLeaseHolder,
  normalizeLease,
  reclaim,
  release,
  requestHandoff,
  tryAcquire
} from '../src/sessions/queue/writeLease';

const KEY = 'file:///project';
const NOW = '2026-11-13T00:00:00.000Z';

test('a free lease can be acquired by exactly one session', () => {
  const acquired = tryAcquire(createFreeLease(KEY), 'a', NOW);
  assert.equal(acquired.applied, true);
  assert.equal(acquired.lease.holderSessionId, 'a');
  assert.equal(acquired.lease.state, 'held');
  assert.ok(isLeaseHolder(acquired.lease, 'a'));
});

test('a held lease is never stolen by another session', () => {
  const held = tryAcquire(createFreeLease(KEY), 'a', NOW).lease;
  const stolen = tryAcquire(held, 'b', NOW);
  assert.equal(stolen.applied, false);
  assert.equal(stolen.reason, 'held_by_other');
  assert.equal(stolen.lease.holderSessionId, 'a', 'the holder is unchanged');
});

test('re-acquiring your own lease is a no-op that keeps the epoch', () => {
  const held = tryAcquire(createFreeLease(KEY), 'a', NOW).lease;
  const again = tryAcquire(held, 'a', NOW);
  assert.equal(again.applied, false);
  assert.equal(again.reason, 'already_held');
  assert.equal(again.lease.epoch, held.epoch);
});

test('a handoff request does not move the lease', () => {
  const held = tryAcquire(createFreeLease(KEY), 'a', NOW).lease;
  const requested = requestHandoff(held, 'b', NOW);
  assert.equal(requested.applied, true);
  assert.equal(requested.lease.holderSessionId, 'a', 'requesting is not transferring');
  assert.equal(requested.lease.state, 'handoff_requested');
  assert.equal(requested.lease.pendingHandoffToSessionId, 'b');
  assert.equal(requested.lease.epoch, held.epoch, 'a request does not invalidate in-flight work');
});

test('only the holder can hand off, and only at a real boundary', () => {
  const held = tryAcquire(createFreeLease(KEY), 'a', NOW).lease;
  const requested = requestHandoff(held, 'b', NOW).lease;

  const foreign = handOff(requested, 'b', 'tool_completed', NOW);
  assert.equal(foreign.applied, false);
  assert.equal(foreign.reason, 'not_holder');

  const badBoundary = handOff(requested, 'a', 'not_a_boundary' as never, NOW);
  assert.equal(badBoundary.applied, false);
  assert.equal(badBoundary.reason, 'invalid_boundary');

  assert.equal(requested.holderSessionId, 'a', 'failed handoffs change nothing');
});

test('handoff transfers the lease and bumps the epoch', () => {
  const held = tryAcquire(createFreeLease(KEY), 'a', NOW).lease;
  const requested = requestHandoff(held, 'b', NOW).lease;
  const handed = handOff(requested, 'a', 'apply_completed', NOW);
  assert.equal(handed.applied, true);
  assert.equal(handed.lease.holderSessionId, 'b');
  assert.equal(handed.lease.state, 'held');
  assert.equal(handed.lease.pendingHandoffToSessionId, undefined);
  assert.equal(handed.lease.epoch, held.epoch + 1);
});

test('handing off without a pending request is refused', () => {
  const held = tryAcquire(createFreeLease(KEY), 'a', NOW).lease;
  const result = handOff(held, 'a', 'task_ended', NOW);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'no_pending_handoff');
});

test('only the holder can release', () => {
  const held = tryAcquire(createFreeLease(KEY), 'a', NOW).lease;
  assert.equal(release(held, 'b').applied, false);
  const released = release(held, 'a');
  assert.equal(released.applied, true);
  assert.equal(released.lease.state, 'free');
  assert.equal(released.lease.holderSessionId, undefined);
});

test('a stale epoch from a previous holder cannot act after a transfer', () => {
  const held = tryAcquire(createFreeLease(KEY), 'a', NOW).lease;
  const capturedEpoch = held.epoch;
  const requested = requestHandoff(held, 'b', NOW).lease;
  const handed = handOff(requested, 'a', 'tool_completed', NOW).lease;

  assert.equal(isEpochCurrent(handed, 'a', capturedEpoch), false, 'the old holder is stale');
  assert.equal(isEpochCurrent(handed, 'b', handed.epoch), true, 'the new holder is current');
});

test('reclaim is the only non-explicit transfer and clears the lease', () => {
  const held = tryAcquire(createFreeLease(KEY), 'a', NOW).lease;
  const reclaimed = reclaim(held);
  assert.equal(reclaimed.applied, true);
  assert.equal(reclaimed.lease.state, 'free');
  assert.ok(reclaimed.lease.epoch > held.epoch);
  assert.equal(reclaim(createFreeLease(KEY)).applied, false, 'reclaiming a free lease is a no-op');
});

test('the stated invariant holds: at most one holder through any transition sequence', () => {
  let lease = createFreeLease(KEY);
  const steps = [
    () => tryAcquire(lease, 'a', NOW),
    () => tryAcquire(lease, 'b', NOW),
    () => requestHandoff(lease, 'b', NOW),
    () => handOff(lease, 'a', 'tool_completed', NOW),
    () => tryAcquire(lease, 'c', NOW),
    () => requestHandoff(lease, 'c', NOW),
    () => handOff(lease, 'b', 'task_ended', NOW),
    () => release(lease, 'c')
  ];
  for (const step of steps) {
    lease = step().lease;
    const holders = [lease.holderSessionId].filter(Boolean);
    assert.equal(holders.length <= 1, true, `at most one holder, got ${JSON.stringify(holders)}`);
  }
  assert.equal(lease.state, 'free');
});

test('normalizeLease rejects a holder-less non-free state', () => {
  assert.equal(normalizeLease({ state: 'held', epoch: 3 }, KEY).state, 'free');
  assert.equal(normalizeLease(undefined, KEY).state, 'free');
  const valid = normalizeLease({ state: 'held', holderSessionId: 'a', epoch: 2 }, KEY);
  assert.equal(valid.holderSessionId, 'a');
  assert.equal(valid.epoch, 2);
});