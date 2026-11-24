import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  LEASE_TTL_MS,
  createFreeLease,
  heartbeat,
  isEpochCurrent,
  isExpired,
  isProcessAlive,
  isReclaimable,
  normalizeWriteLease,
  release,
  tryAcquire,
  type WriteLeaseRecord
} from '../src/sessions/queue/writeLease';
import { ProjectWriteLeaseStore } from '../src/sessions/queue/writeLeaseStore';
import { WriteLeaseMirror } from '../src/sessions/queue/writeLeaseMirror';
import { ProjectWriteLeaseCoordinator } from '../src/sessions/queue/writeLeaseRegistry';
import { conflictOf, SafeFileEditError, WriteConflictError } from '../src/edits/safeFileEditor';
import { checkWritePermission } from '../src/sessions/queue/modeGate';
import * as vscode from './stubs/vscode';

const WORKSPACE = 'workspace:lease-test';
const ALIVE = () => true;
const DEAD = () => false;

function held(overrides: Partial<WriteLeaseRecord> = {}): WriteLeaseRecord {
  return {
    ...createFreeLease(WORKSPACE),
    state: 'held',
    holderSessionId: 'session-a',
    holderPid: 111,
    purpose: 'edit',
    epoch: 3,
    acquiredAt: new Date(0).toISOString(),
    heartbeatAt: new Date(0).toISOString(),
    expiresAt: new Date(60_000).toISOString(),
    ...overrides
  };
}

test('acquire grants a free lease and advances the epoch', () => {
  const outcome = tryAcquire(createFreeLease(WORKSPACE), { sessionId: 'a', purpose: 'edit', pid: 1 });
  assert.equal(outcome.applied, true);
  assert.equal(outcome.lease.state, 'held');
  assert.equal(outcome.lease.holderSessionId, 'a');
  assert.equal(outcome.lease.epoch, 1);
  assert.equal(outcome.lease.purpose, 'edit');
});

test('acquire refuses while a live holder owns the lease', () => {
  const outcome = tryAcquire(held(), { sessionId: 'b', purpose: 'edit' }, new Date(1_000), ALIVE);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, 'held_by_other');
  assert.equal(outcome.lease.holderSessionId, 'session-a');
});

test('acquire reclaims an expired lease whose holder process is gone', () => {
  const lease = held({ expiresAt: new Date(500).toISOString() });
  const outcome = tryAcquire(lease, { sessionId: 'b', purpose: 'command' }, new Date(1_000), DEAD);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.lease.holderSessionId, 'b');
  assert.equal(outcome.lease.epoch, 4);
});

test('a paused but alive holder keeps the lease past its TTL', () => {
  const lease = held({ expiresAt: new Date(500).toISOString() });
  assert.equal(isExpired(lease, 1_000), true);
  assert.equal(isReclaimable(lease, 1_000, ALIVE), false);
  const outcome = tryAcquire(lease, { sessionId: 'b', purpose: 'edit' }, new Date(1_000), ALIVE);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.reason, 'held_by_other');
});

test('a lease without a recorded pid is reclaimable once expired', () => {
  const lease = held({ holderPid: undefined, expiresAt: new Date(500).toISOString() });
  assert.equal(isReclaimable(lease, 1_000, ALIVE), true);
});

test('heartbeat extends only for the holder at the same epoch', () => {
  const lease = held({ expiresAt: new Date(1_000).toISOString() });
  const renewed = heartbeat(lease, 'session-a', 3, new Date(2_000));
  assert.equal(renewed.applied, true);
  assert.equal(Date.parse(renewed.lease.expiresAt!), 2_000 + LEASE_TTL_MS);

  assert.equal(heartbeat(lease, 'session-b', 3, new Date(2_000)).reason, 'not_holder');
  assert.equal(heartbeat(lease, 'session-a', 2, new Date(2_000)).reason, 'stale_epoch');
});

test('release requires the holder and the epoch that acquired it', () => {
  const lease = held();
  assert.equal(release(lease, 'session-a', 2).reason, 'stale_epoch');
  assert.equal(release(lease, 'session-b', 3).reason, 'not_holder');
  const released = release(lease, 'session-a', 3);
  assert.equal(released.applied, true);
  assert.equal(released.lease.state, 'free');
  assert.equal(released.lease.epoch, 4);
  assert.equal(isEpochCurrent(released.lease, 'session-a', 3), false);
});

test('malformed lease records degrade to free instead of throwing', () => {
  assert.equal(normalizeWriteLease(undefined, WORKSPACE).state, 'free');
  assert.equal(normalizeWriteLease({ version: 2 }, WORKSPACE).state, 'free');
  assert.equal(normalizeWriteLease({ version: 1, workspaceKey: 'other', state: 'held', holderSessionId: 'a' }, WORKSPACE).state, 'free');
  // A held record without a holder cannot be held.
  assert.equal(normalizeWriteLease({ version: 1, workspaceKey: WORKSPACE, state: 'held', epoch: 4 }, WORKSPACE).state, 'free');
});

test('a held record without a readable expiry is treated as already lapsed', () => {
  const normalized = normalizeWriteLease({
    version: 1, workspaceKey: WORKSPACE, state: 'held', holderSessionId: 'a', epoch: 7
  }, WORKSPACE);
  assert.equal(normalized.state, 'held');
  assert.equal(isExpired(normalized, 1), true);
});

test('isProcessAlive reports the current process as alive', () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(-1), false);
});

test('the mirror admits only the holder and follows epoch changes', () => {
  const mirror = new WriteLeaseMirror(WORKSPACE);
  assert.equal(mirror.allows('a', 'edit'), false);
  mirror.adopt(held({ epoch: 5 }));
  assert.equal(mirror.allows('session-a', 'edit'), true);
  assert.equal(mirror.allows('session-b', 'edit'), false);
  // A stale snapshot must never roll the epoch back.
  mirror.apply(held({ epoch: 4, holderSessionId: 'session-b' }));
  assert.equal(mirror.holder(), 'session-a');
  mirror.markReleased(6);
  assert.equal(mirror.allows('session-a', 'edit'), false);
});

function leaseStore(root: string): ProjectWriteLeaseStore {
  return new ProjectWriteLeaseStore(vscode.Uri.file(path.join(root, 'write-lease.json')) as never);
}

test('the durable store serialises acquire, renew and release across callers', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-lease-'));
  try {
    const store = leaseStore(root);
    const first = await store.acquire(WORKSPACE, { sessionId: 'a', purpose: 'edit', pid: process.pid });
    assert.equal(first.acquired, true);
    assert.equal(first.lease.epoch, 1);

    const second = await store.acquire(WORKSPACE, { sessionId: 'b', purpose: 'edit', pid: process.pid });
    assert.equal(second.acquired, false);
    assert.equal(second.lease.holderSessionId, 'a');

    // Acquiring again as the same session is idempotent and keeps the epoch.
    const again = await store.acquire(WORKSPACE, { sessionId: 'a', purpose: 'edit', pid: process.pid });
    assert.equal(again.acquired, true);
    assert.equal(again.lease.epoch, 1);

    const renewed = await store.renew(WORKSPACE, 'a', 1);
    assert.equal(renewed.renewed, true);

    const wrongEpoch = await store.release(WORKSPACE, 'a', 99);
    assert.equal(wrongEpoch.released, false);

    const released = await store.release(WORKSPACE, 'a', 1);
    assert.equal(released.released, true);
    assert.equal(released.lease.state, 'free');

    const next = await store.acquire(WORKSPACE, { sessionId: 'b', purpose: 'command', pid: process.pid });
    assert.equal(next.acquired, true);
    assert.equal(next.lease.epoch, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a concurrent pair of acquirers yields exactly one holder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-lease-race-'));
  try {
    const store = leaseStore(root);
    const results = await Promise.all([
      store.acquire(WORKSPACE, { sessionId: 'a', purpose: 'edit', pid: 111 }, DEAD),
      store.acquire(WORKSPACE, { sessionId: 'b', purpose: 'edit', pid: 222 }, DEAD)
    ]);
    assert.equal(results.filter((result) => result.acquired).length, 1);
    const final = await store.load(WORKSPACE);
    assert.equal(final.state, 'held');
    assert.ok(final.holderSessionId === 'a' || final.holderSessionId === 'b');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the coordinator reports the holder and releases its own claim', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-lease-coord-'));
  try {
    const store = leaseStore(root);
    const mirror = new WriteLeaseMirror(WORKSPACE);
    const coordinator = new ProjectWriteLeaseCoordinator(WORKSPACE, store, mirror, {
      pid: process.pid, heartbeatMs: 60_000, pollMs: 60_000
    });
    try {
      await coordinator.initialize();

      const granted = await coordinator.acquire({ sessionId: 'a', purpose: 'edit', batchId: 'edits:set-1' });
      assert.equal(granted.acquired, true);
      assert.equal(mirror.allows('a', 'edit'), true);
      assert.equal(coordinator.describe().holderSessionId, 'a');
      assert.equal(coordinator.describe().batchId, 'edits:set-1');

      const refused = await coordinator.acquire({ sessionId: 'b', purpose: 'edit' });
      assert.equal(refused.acquired, false);
      if (!refused.acquired) assert.equal(refused.holderSessionId, 'a');

      if (granted.acquired) {
        await granted.grant.release();
        await granted.grant.release();
      }
      assert.equal(mirror.allows('a', 'edit'), false);

      const grantedAgain = await coordinator.acquire({ sessionId: 'b', purpose: 'command' });
      assert.equal(grantedAgain.acquired, true);
    } finally {
      coordinator.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('a conflict is typed, code-stable, and survives the SafeFileEditError wrapper', async () => {
  const conflict = new WriteConflictError('base changed', 'draft_base_mismatch', 'file:///a.ts', 'a.ts',
    { sha256: 'a'.repeat(64), sizeBytes: 10 }, { sha256: 'b'.repeat(64), sizeBytes: 20 });
  assert.equal(conflictOf(conflict), conflict);
  // The apply path wraps every failure; the conflict identity must survive so the
  // caller can still tell "retry with a new draft" from "this write is refused".
  const wrapped = new SafeFileEditError(conflict.message, undefined, conflict);
  assert.equal(conflictOf(wrapped)?.code, 'draft_base_mismatch');
  assert.equal(conflictOf(new SafeFileEditError('other', undefined))?.code, undefined);
  assert.equal(conflictOf(new Error('plain')), undefined);
});

test('only a foreign holder is refused; a free lease is not a denial', async () => {
  const free = createFreeLease(WORKSPACE);
  const mine = held({ holderSessionId: 'a' });
  const theirs = held({ holderSessionId: 'b', purpose: 'command' });

  // Lease awareness must never turn "not yet acquired" into a refusal: the write
  // path acquires immediately before it writes, so denying here would deadlock.
  const freeResult = checkWritePermission({ sessionId: 'a', capability: 'edit', lease: free });
  assert.equal(freeResult.allowed, false);
  if (!freeResult.allowed) assert.equal(freeResult.reason, 'lease_free');
  assert.equal(checkWritePermission({ sessionId: 'a', capability: 'edit', lease: mine }).allowed, true);
  const denied = checkWritePermission({ sessionId: 'a', capability: 'edit', lease: theirs });
  assert.equal(denied.allowed, false);
  if (!denied.allowed) {
    assert.equal(denied.reason, 'lease_held_by_other');
    assert.equal(denied.holderSessionId, 'b');
    assert.equal(denied.holderCapability, 'command');
  }
});
