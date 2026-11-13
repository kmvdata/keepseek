export type BoundedWaitResult<T> =
  | { status: 'settled'; value: T }
  | { status: 'failed'; error: unknown }
  | { status: 'timeout' };

/** Bounds waiting only: callers must keep work free of commits until settled.
 * Both handlers remain attached after timeout so a late rejection is consumed. */
export async function boundedWait<T>(work: Promise<T>, timeoutMs: number): Promise<BoundedWaitResult<T>> {
  const settled = work.then<BoundedWaitResult<T>, BoundedWaitResult<T>>(
    value => ({ status: 'settled', value }),
    error => ({ status: 'failed', error })
  );
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return settled;

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<BoundedWaitResult<T>>(resolve => {
        timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
        timer.unref?.();
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
