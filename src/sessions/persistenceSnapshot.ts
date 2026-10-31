import { MAX_CHECKPOINT_BYTES, type RunCheckpoint } from '../agent/runCheckpoint';
import type { ChatSession } from '../shared/types';

// Only fields whose producers replace rather than mutate are memoized. Header,
// pending journal, budgets, plans and mutable arrays are copied every barrier.
const immutableCopies = new WeakMap<object, object>();
const immutableSizes = new WeakMap<object, number>();
function jsonSize(value: unknown): number {
  if (!value || typeof value !== 'object') return Buffer.byteLength(JSON.stringify(value) ?? 'null');
  const cached = Object.isFrozen(value) ? immutableSizes.get(value) : undefined;
  if (cached !== undefined) return cached;
  const entries = Array.isArray(value) ? value : Object.entries(value).filter(([, v]) => v !== undefined);
  const size = 2 + Math.max(0, entries.length - 1) + entries.reduce((sum: number, item: unknown) => {
    if (Array.isArray(value)) return sum + jsonSize(item);
    const [key, child] = item as [string, unknown];
    return sum + Buffer.byteLength(JSON.stringify(key)) + 1 + jsonSize(child);
  }, 0);
  if (Object.isFrozen(value)) immutableSizes.set(value, size);
  return size;
}
function immutableCopy<T extends object>(value: T): T {
  if (Object.isFrozen(value)) return value;
  const prior = immutableCopies.get(value);
  if (prior) return prior as T;
  const copy = structuredClone(value);
  freezeTree(copy);
  immutableCopies.set(value, copy);
  return copy;
}
export function freezeTree(value: unknown): void {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
}

/** Snapshot used only at persistence barriers. Mutable recovery uses checkpointCopy. */
export function snapshotCheckpoint(cp: RunCheckpoint): RunCheckpoint {
  const { request, state, ...header } = cp;
  const { history, ...requestHeader } = request;
  const snapshot: RunCheckpoint = { ...structuredClone(header), request: {
    ...structuredClone(requestHeader), history: immutableCopy(history)
  } };
  if (state) {
    const { messages, provider, completedReplay, toolRounds, ...journal } = state;
    snapshot.state = { ...structuredClone(journal), messages: immutableCopy(messages),
      provider: provider ? immutableCopy(provider) : undefined,
      completedReplay: completedReplay ? immutableCopy(completedReplay) : undefined,
      toolRounds: toolRounds.map(round => immutableCopy(round)) };
  }
  // The host may update liveness timestamps on the header, never these trees.
  freezeTree(snapshot.request);
  freezeTree(snapshot.state);
  if (jsonSize(snapshot) > MAX_CHECKPOINT_BYTES) throw new Error('Checkpoint resource limit (32 MiB) / 检查点资源上限（32 MiB）');
  return snapshot;
}

export function snapshotSession(session: ChatSession): ChatSession {
  const { messages, ...header } = session;
  return { ...structuredClone(header), messages: messages.map(message => {
    const { runCheckpoint, ...body } = message;
    return { ...structuredClone(body), runCheckpoint: runCheckpoint ? snapshotCheckpoint(runCheckpoint) : undefined };
  }) };
}
