import { MAX_CHECKPOINT_BYTES, type RunCheckpoint } from '../agent/runCheckpoint';
import type { ChatMessage, ChatSession } from '../shared/types';

// Only fields whose producers replace rather than mutate are memoized. Header,
// pending journal, budgets, plans and mutable arrays are copied every barrier.
const immutableCopies = new WeakMap<object, object>();
const immutableSizes = new WeakMap<object, number>();
const frozenTrees = new WeakSet<object>();
const packedTrees = new WeakSet<object>();
const messageBodyCopies = new WeakMap<object, object>();
const messageSnapshotBodies = new WeakMap<object, object>();
export function isPackedPersistenceTree(value: object): boolean { return packedTrees.has(value); }
/** Explicitly immutable inputs may be stored as one hashed object, rather than
 * hundreds of individually durable leaf files. Never use for a mutable journal. */
export function packPersistenceInput<T extends object>(value: T): T {
  freezeTree(value); packedTrees.add(value); return value;
}
export function isFrozenTree(value: object): boolean { return frozenTrees.has(value); }
function jsonSize(value: unknown): number {
  if (!value || typeof value !== 'object') return Buffer.byteLength(JSON.stringify(value) ?? 'null');
  const cached = isFrozenTree(value) ? immutableSizes.get(value) : undefined;
  if (cached !== undefined) return cached;
  const entries = Array.isArray(value) ? value : Object.entries(value).filter(([, v]) => v !== undefined);
  const size = 2 + Math.max(0, entries.length - 1) + entries.reduce((sum: number, item: unknown) => {
    if (Array.isArray(value)) return sum + jsonSize(item);
    const [key, child] = item as [string, unknown];
    return sum + Buffer.byteLength(JSON.stringify(key)) + 1 + jsonSize(child);
  }, 0);
  if (isFrozenTree(value)) immutableSizes.set(value, size);
  return size;
}
function immutableCopy<T extends object>(value: T): T {
  if (isFrozenTree(value)) return value;
  const prior = immutableCopies.get(value);
  if (prior) return prior as T;
  const copy = structuredClone(value);
  freezeTree(copy);
  immutableCopies.set(value, copy);
  return copy;
}
export function freezeTree(value: unknown): void {
  if (!value || typeof value !== 'object' || isFrozenTree(value)) return;
  for (const child of Object.values(value)) freezeTree(child);
  Object.freeze(value);
  frozenTrees.add(value);
}

/** Copy mutable journals while retaining only recursively verified immutable trees.
 * structuredClone loses their identity and makes every downstream store walk them again. */
export function copyPersistenceValue<T>(value: T): T {
  if (!value || typeof value !== 'object' || isFrozenTree(value)) return value;
  if (Array.isArray(value)) return value.map(copyPersistenceValue) as T;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, copyPersistenceValue(child)])) as T;
}

function samePersistenceValue(value: unknown, snapshot: unknown): boolean {
  if (value === snapshot) return true; // Mutable inputs are copied, so shared objects are verified frozen trees.
  if (!value || !snapshot || typeof value !== 'object' || typeof snapshot !== 'object'
    || Array.isArray(value) !== Array.isArray(snapshot)) return false;
  const keys = Object.keys(value), priorKeys = Object.keys(snapshot);
  return keys.length === priorKeys.length && keys.every(key => Object.hasOwn(snapshot, key)
    && samePersistenceValue((value as Record<string, unknown>)[key], (snapshot as Record<string, unknown>)[key]));
}

/** Mutable nested metadata is compared, never cached by identity alone. */
export function persistenceMessageBody(message: object, current: object): object {
  const body = messageSnapshotBodies.get(message);
  return body && samePersistenceValue(current, body) ? body : current;
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
  return { ...copyPersistenceValue(header), messages: messages.map(message => {
    const { runCheckpoint, runCheckpointArchive, ...body } = message;
    delete body.runState;
    const prior = messageBodyCopies.get(message);
    const copied = prior && samePersistenceValue(body, prior) ? prior : copyPersistenceValue(body);
    freezeTree(copied);
    messageBodyCopies.set(message, copied);
    const snapshot = { ...copied as Omit<ChatMessage, 'runCheckpoint'>,
      runCheckpointArchive: copyPersistenceValue(runCheckpointArchive),
      runCheckpoint: runCheckpoint ? snapshotCheckpoint(runCheckpoint) : undefined };
    messageSnapshotBodies.set(snapshot, copied);
    return snapshot;
  }) };
}
