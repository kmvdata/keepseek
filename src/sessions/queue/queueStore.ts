import * as vscode from 'vscode';
import { missing } from '../sessionDeletionAuthority';
import { withAssociatedStoreGate } from '../sessionAssociatedPersistence';
import { isRecord } from '../../shared/errors';
import { writeJsonAtomic } from '../../shared/atomicStorage';
import {
  PROJECT_SESSION_QUEUE_VERSION,
  type ProjectSessionQueue,
  type QueueEntry
} from './types';
import { cloneQueue, createEmptyQueue, reconcile } from './projectQueue';

/**
 * Durable per-project session queue.
 *
 * The queue is the authority for ordering and therefore for the derived
 * normal/plan mode, so it lives next to the workspace session index and is
 * written with the same atomic replacement. Mutations use a `revision` CAS so
 * two windows cannot silently overwrite each other's ordering.
 */

export type QueueLoadStatus =
  /** File parsed and validated as-is. */
  | 'loaded'
  /** File was missing; an empty queue was created (not yet persisted). */
  | 'absent'
  /** File was unreadable or invalid; rebuilt from session facts. */
  | 'rebuilt';

export interface QueueLoadResult {
  queue: ProjectSessionQueue;
  status: QueueLoadStatus;
  diagnostic?: string;
}

export type QueueSaveStatus = 'saved' | 'conflict';

export interface QueueSaveResult {
  status: QueueSaveStatus;
  /** Queue on disk after a conflict; only present when `conflict`. */
  current?: ProjectSessionQueue;
}

const MAX_ENTRIES = 5_000;

export class ProjectQueueStore {
  public constructor(private readonly queueUri: vscode.Uri) {}

  public get uri(): vscode.Uri {
    return this.queueUri;
  }

  /**
   * Read and validate the queue.
   *
   * `fallbackSessions` are used only when the file is absent or invalid, so a
   * damaged queue degrades to creation order instead of losing the project.
   */
  public async load(
    workspaceKey: string,
    fallbackSessions: readonly { id: string; createdAt: string }[] = [],
    now?: string
  ): Promise<QueueLoadResult> {
    const raw = await this.readRaw();
    if (raw === undefined) {
      return { queue: reconcile(createEmptyQueue(workspaceKey, now), fallbackSessions, now), status: 'absent' };
    }
    const normalized = normalizeProjectSessionQueue(raw, workspaceKey);
    if (!normalized) {
      const rebuilt = reconcile(createEmptyQueue(workspaceKey, now), fallbackSessions, now);
      return {
        queue: rebuilt,
        status: 'rebuilt',
        diagnostic: 'invalid_project_session_queue'
      };
    }
    return { queue: normalized, status: 'loaded' };
  }

  /**
   * Compare-and-set save. Refuses to overwrite a queue whose stored revision
   * differs from `queue.revision - 1` (i.e. the caller's basis).
   *
   * Pass `previousRevision` explicitly when the caller mutated a copy.
   */
  public async save(
    queue: ProjectSessionQueue,
    previousRevision: number = queue.revision - 1,
    guard?: (previous: ProjectSessionQueue | undefined) => Promise<void>
  ): Promise<QueueSaveResult> {
    // The comparison and atomic replacement must share the same cross-process
    // critical section. Atomic rename by itself is not compare-and-swap.
    return this.withOrderLock(() => this.saveLocked(queue, previousRevision, guard));
  }

  private async saveLocked(queue: ProjectSessionQueue, previousRevision: number,
    guard?: (previous: ProjectSessionQueue | undefined) => Promise<void>): Promise<QueueSaveResult> {
    const existing = await this.readRaw();
    const current = normalizeProjectSessionQueue(existing, queue.workspaceKey);
    if (existing !== undefined) {
      if (current && current.revision !== previousRevision) {
        return { status: 'conflict', current };
      }
      // An invalid on-disk file is replaced: nothing valuable is overwritten.
    }
    await guard?.(current);
    await writeJsonAtomic(this.queueUri, serializeQueue(queue), { durable: true });
    return { status: 'saved' };
  }

  public withOrderLock<T>(work: () => Promise<T>): Promise<T> {
    return withAssociatedStoreGate(vscode.Uri.joinPath(this.queueUri, '..'), 'queue', work);
  }

  public async withVerifiedHead<T>(workspaceKey: string, sessionId: string, work: (queue: ProjectSessionQueue) => Promise<T>): Promise<T> {
    return this.withOrderLock(async () => {
      const { queue, status } = await this.load(workspaceKey);
      if (status !== 'loaded' || queue.entries[0]?.sessionId !== sessionId) {
        throw new Error('Handoff target is not the durable queue head / 交接目标未取得持久化队首');
      }
      return work(queue);
    });
  }

  public async exists(): Promise<boolean> {
    return (await this.readRaw()) !== undefined;
  }

  private async readRaw(): Promise<unknown | undefined> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(this.queueUri);
    } catch (error) {
      if (missing(error)) return undefined;
      throw error;
    }
    if (!bytes.byteLength) return undefined;
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      return { __unparseable: true };
    }
  }
}

export function serializeQueue(queue: ProjectSessionQueue): ProjectSessionQueue {
  return {
    version: PROJECT_SESSION_QUEUE_VERSION,
    workspaceKey: queue.workspaceKey,
    revision: queue.revision,
    entries: queue.entries.map((entry) => ({
      sessionId: entry.sessionId,
      serial: entry.serial,
      createdAt: entry.createdAt,
      ...(entry.userOrdered ? { userOrdered: true } : {})
    })),
    updatedAt: queue.updatedAt
  };
}

/**
 * Strict validation of the current format only. Returns `undefined` for
 * anything that is not a well-formed queue for this workspace.
 */
export function normalizeProjectSessionQueue(value: unknown, workspaceKey: string): ProjectSessionQueue | undefined {
  if (!isRecord(value)) return undefined;
  if (value.version !== PROJECT_SESSION_QUEUE_VERSION) return undefined;
  if (value.workspaceKey !== workspaceKey) return undefined;
  if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) return undefined;
  if (typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) return undefined;
  if (!Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) return undefined;

  const entries: QueueEntry[] = [];
  const seenIds = new Set<string>();
  const seenSerials = new Set<number>();
  for (const item of value.entries) {
    if (!isRecord(item)) return undefined;
    const sessionId = item.sessionId;
    const serial = item.serial;
    const createdAt = item.createdAt;
    if (typeof sessionId !== 'string' || !sessionId.trim()) return undefined;
    if (seenIds.has(sessionId)) return undefined;
    if (typeof serial !== 'number' || !Number.isSafeInteger(serial) || serial < 1) return undefined;
    if (seenSerials.has(serial)) return undefined;
    if (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt))) return undefined;
    seenIds.add(sessionId);
    seenSerials.add(serial);
    entries.push({
      sessionId,
      serial,
      createdAt,
      ...(item.userOrdered === true ? { userOrdered: true } : {})
    });
  }

  return {
    version: PROJECT_SESSION_QUEUE_VERSION,
    workspaceKey,
    entries,
    revision: value.revision,
    updatedAt: value.updatedAt
  };
}

/**
 * Save helper used by callers that only have a candidate queue and a base:
 * on conflict it re-reads, re-applies `mutate`, and retries a bounded number of
 * times instead of overwriting another window's ordering.
 */
export async function saveQueueWithRebase(input: {
  store: ProjectQueueStore;
  workspaceKey: string;
  base: ProjectSessionQueue;
  candidate: ProjectSessionQueue;
  mutate: (queue: ProjectSessionQueue) => ProjectSessionQueue | Promise<ProjectSessionQueue>;
  guard?: (previous: ProjectSessionQueue | undefined, candidate: ProjectSessionQueue) => Promise<void>;
  attempts?: number;
  now?: string;
}): Promise<{ status: 'saved' | 'conflict'; queue: ProjectSessionQueue }> {
  const attempts = Math.max(1, input.attempts ?? 3);
  let base = input.base;
  let candidate = input.candidate;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await input.store.save(candidate, base.revision, current => input.guard?.(current, candidate) ?? Promise.resolve());
    if (result.status === 'saved') return { status: 'saved', queue: candidate };
    if (!result.current) return { status: 'conflict', queue: base };
    base = result.current;
    candidate = await input.mutate(cloneQueue(base));
  }
  return { status: 'conflict', queue: base };
}