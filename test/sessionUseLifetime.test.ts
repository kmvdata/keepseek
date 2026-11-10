import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SessionUseLifetime } from '../src/provider/sessionUseLifetime';

test('a session lease survives queued, waiting and settling gaps and releases once idle', async () => {
  let phase = 'queued'; let releases = 0;
  const lifetime = new SessionUseLifetime(() => phase !== 'idle');
  const use = { release: async () => { releases++; } };
  await lifetime.releaseWhenIdle('session', use);
  for (const next of ['waiting_approval', 'continuation_queued', 'settling']) {
    phase = next; await lifetime.notify(); assert.equal(releases, 0);
  }
  phase = 'idle'; await lifetime.notify();
  assert.equal(releases, 1); assert.equal(lifetime.heldCount, 0);
  await lifetime.releaseWhenIdle('session', use); await lifetime.notify();
  assert.equal(releases, 1);
  lifetime.dispose();
});

test('independent session leases release without waiting for another active session', async () => {
  let active = true; const released: string[] = [];
  const lifetime = new SessionUseLifetime(id => id === 'active' && active);
  await lifetime.releaseWhenIdle('active', { release: async () => { released.push('active'); } });
  await lifetime.releaseWhenIdle('idle', { release: async () => { released.push('idle'); } });
  assert.deepEqual(released, ['idle']);
  active = false; await lifetime.notify();
  assert.deepEqual(released, ['idle', 'active']);
  lifetime.dispose();
});

test('unknown local status and release I/O failure retain protection until a later successful check', async () => {
  let unknown = true; let failRelease = true; let released = 0;
  const errors: string[] = [];
  const lifetime = new SessionUseLifetime(() => { if (unknown) throw new Error('unavailable'); return false; },
    { onError: phase => errors.push(phase) });
  await lifetime.releaseWhenIdle('session', { release: async () => { if (failRelease) throw new Error('I/O'); released++; } });
  assert.equal(lifetime.heldCount, 1);
  unknown = false; await lifetime.notify();
  assert.equal(lifetime.heldCount, 1); assert.equal(released, 0);
  failRelease = false; await lifetime.notify();
  assert.equal(lifetime.heldCount, 0); assert.equal(released, 1);
  assert.deepEqual(errors, ['inspect', 'release']);
  lifetime.dispose();
});

test('disposing a view preserves an active use record until its command actually settles', async () => {
  let active = true; let released = 0;
  const lifetime = new SessionUseLifetime(() => active);
  await lifetime.releaseWhenIdle('session', { release: async () => { released++; } });
  lifetime.dispose(); await lifetime.notify();
  assert.equal(released, 0); assert.equal(lifetime.heldCount, 1);
  active = false; await lifetime.notify();
  assert.equal(released, 1); assert.equal(lifetime.heldCount, 0);
});

test('concurrent notifications never release the same record twice', async () => {
  let release!: () => void; let calls = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const lifetime = new SessionUseLifetime(() => false);
  const releasing = lifetime.releaseWhenIdle('session', { release: async () => { calls++; await barrier; } });
  await lifetime.notify(); await lifetime.notify();
  assert.equal(calls, 1);
  release(); await releasing; await lifetime.notify();
  assert.equal(calls, 1); assert.equal(lifetime.heldCount, 0);
  lifetime.dispose();
});
