import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boundedWait } from '../src/shared/boundedWait';

test('bounded waiting preserves a timely value and clears its timer before the deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  const value = { id: 'selected' };
  const result = await boundedWait(Promise.resolve(value), 20);
  assert.equal(result.status, 'settled');
  assert.equal(result.status === 'settled' && result.value, value);
  assert.equal(scheduled.mock.callCount(), 1);
  assert.equal(clear.mock.callCount(), 1);
  assert.equal(clear.mock.calls[0].arguments[0], scheduled.mock.calls[0].result);
  t.mock.timers.tick(100);
  assert.equal(clear.mock.callCount(), 1);
});

test('bounded waiting reports timeout once and ignores later successful work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fakeTimeout = globalThis.setTimeout;
  let timeoutCallbacks = 0;
  t.mock.method(globalThis, 'setTimeout', ((callback: () => void, delay: number) =>
    fakeTimeout(() => { timeoutCallbacks += 1; callback(); }, delay)) as typeof setTimeout);
  const clear = t.mock.method(globalThis, 'clearTimeout');
  let release!: (value: string) => void;
  const work = new Promise<string>(resolve => { release = resolve; });
  const pending = boundedWait(work, 20);
  t.mock.timers.tick(19);
  assert.equal(timeoutCallbacks, 0);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { status: 'timeout' });
  release('late');
  await Promise.resolve();
  t.mock.timers.tick(100);
  assert.equal(timeoutCallbacks, 1);
  assert.equal(clear.mock.callCount(), 1);
  assert.deepEqual(await pending, { status: 'timeout' });
});

test('bounded waiting consumes a rejection arriving after timeout', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let reject!: (error: Error) => void;
  const work = new Promise<string>((_resolve, rejectWork) => { reject = rejectWork; });
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => { unhandled.push(error); };
  process.on('unhandledRejection', onUnhandled);
  try {
    const pending = boundedWait(work, 20);
    t.mock.timers.tick(20);
    assert.deepEqual(await pending, { status: 'timeout' });
    reject(new Error('late disk failure'));
    // A full event-loop turn lets Node publish any unhandled rejection.
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('non-positive and non-finite deadlines wait for the original work without a timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const scheduled = t.mock.method(globalThis, 'setTimeout');
  for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    let release!: (value: string) => void;
    let completed = false;
    const pending = boundedWait(new Promise<string>(resolve => { release = resolve; }), timeoutMs)
      .then(result => { completed = true; return result; });
    t.mock.timers.tick(1_000_000);
    await Promise.resolve();
    assert.equal(completed, false);
    release('original');
    assert.deepEqual(await pending, { status: 'settled', value: 'original' });
  }
  assert.equal(scheduled.mock.callCount(), 0);
});

test('bounded waiting returns the exact original failure and clears a live timer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const clear = t.mock.method(globalThis, 'clearTimeout');
  const failure = new Error('read failed');
  for (const timeoutMs of [20, 0]) {
    const result = await boundedWait(Promise.reject(failure), timeoutMs);
    assert.equal(result.status, 'failed');
    assert.equal(result.status === 'failed' && result.error, failure);
  }
  assert.equal(clear.mock.callCount(), 1);
});
