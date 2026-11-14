import type * as vscode from 'vscode';
import type { ChatSession } from '../../shared/types';
import { ProjectQueueStore, saveQueueWithRebase, type QueueLoadResult } from './queueStore';
import { cloneQueue, createEmptyQueue, enqueueNewSession, effectiveMode, reconcile, removeEntry } from './projectQueue';
import type { ProjectSessionQueue, SessionExecutionMode } from './types';

/**
 * Project queue service — the single serialized entry point for queue reads
 * and writes.
 *
 * P1 scope: this service is authoritative for ORDER and for the DERIVED mode,
 * but it does not yet own write permissions or lease transfer (P3/P4). Callers
 * use `getDerivedMode()` for display; the legacy per-session `executionMode`
 * field remains the runtime authority until P2.
 */
export class ProjectQueueService {
  private readonly stores = new Map<string, ProjectQueueStore>();
  private readonly queues = new Map<string, ProjectSessionQueue>();
  private readonly loading = new Map<string, Promise<ProjectSessionQueue>>();
  /** Serializes every mutation per workspace so read-modify-write cannot interleave. */
  private readonly chains = new Map<string, Promise<unknown>>();

  public constructor(private readonly queueUriFor: (workspaceKey: string) => vscode.Uri) {}

  private storeFor(workspaceKey: string): ProjectQueueStore {
    let store = this.stores.get(workspaceKey);
    if (!store) {
      store = new ProjectQueueStore(this.queueUriFor(workspaceKey));
      this.stores.set(workspaceKey, store);
    }
    return store;
  }

  private async serialize<T>(workspaceKey: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(workspaceKey) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(work);
    this.chains.set(workspaceKey, run.catch(() => undefined));
    try {
      return await run;
    } finally {
      if (this.chains.get(workspaceKey) === run || this.chains.get(workspaceKey) === undefined) {
        this.chains.delete(workspaceKey);
      }
    }
  }

  /**
   * Load the queue once per workspace. `sessions` seeds a rebuild when the file
   * is missing or invalid, so a project can never end up with no head.
   */
  public async ensureLoaded(
    workspaceKey: string,
    sessions: readonly Pick<ChatSession, 'id' | 'createdAt'>[] = [],
    now?: string
  ): Promise<QueueLoadResult> {
    const cached = this.queues.get(workspaceKey);
    if (cached) return { queue: cached, status: 'loaded' };
    const inFlight = this.loading.get(workspaceKey);
    if (inFlight) return { queue: await inFlight, status: 'loaded' };

    const promise = this.serialize(workspaceKey, async () => {
      const result = await this.storeFor(workspaceKey).load(workspaceKey, sessions, now);
      this.queues.set(workspaceKey, result.queue);
      return result;
    });
    this.loading.set(workspaceKey, promise.then((result) => result.queue));
    try {
      return await promise;
    } finally {
      this.loading.delete(workspaceKey);
    }
  }

  /** Best-effort synchronous view; `undefined` until `ensureLoaded` ran. */
  public peek(workspaceKey: string): ProjectSessionQueue | undefined {
    return this.queues.get(workspaceKey);
  }

  /**
   * Derived mode for display. Falls back to `'plan'` for an unloaded queue so
   * the UI never promises write access it cannot verify.
   */
  public getDerivedMode(workspaceKey: string, sessionId: string): SessionExecutionMode | undefined {
    const queue = this.queues.get(workspaceKey);
    if (!queue) return undefined;
    return effectiveMode(queue, sessionId);
  }

  /**
   * Register a newly created session at the tail. A new session is therefore
   * `plan` whenever the project already has one.
   */
  public async enqueue(
    workspaceKey: string,
    sessionId: string,
    sessions: readonly Pick<ChatSession, 'id' | 'createdAt'>[] = [],
    now?: string
  ): Promise<ProjectSessionQueue> {
    await this.ensureLoaded(workspaceKey, sessions, now);
    return this.serialize(workspaceKey, async () => {
      const base = this.queues.get(workspaceKey) ?? createEmptyQueue(workspaceKey, now);
      const candidate = reconcile(enqueueNewSession(base, sessionId, now), sessions, now);
      if (candidate === base) return base;
      const saved = await saveQueueWithRebase({
        store: this.storeFor(workspaceKey),
        workspaceKey,
        base,
        candidate,
        mutate: (queue) => reconcile(enqueueNewSession(queue, sessionId, now), sessions, now),
        now
      });
      this.queues.set(workspaceKey, saved.queue);
      return saved.queue;
    });
  }

  /** Drop a deleted session; the next entry becomes the head (and normal). */
  public async remove(
    workspaceKey: string,
    sessionId: string,
    sessions: readonly Pick<ChatSession, 'id' | 'createdAt'>[] = [],
    now?: string
  ): Promise<ProjectSessionQueue> {
    await this.ensureLoaded(workspaceKey, sessions, now);
    return this.serialize(workspaceKey, async () => {
      const base = this.queues.get(workspaceKey) ?? createEmptyQueue(workspaceKey, now);
      const candidate = reconcile(removeEntry(base, sessionId, now), sessions, now);
      if (candidate === base) return base;
      const saved = await saveQueueWithRebase({
        store: this.storeFor(workspaceKey),
        workspaceKey,
        base,
        candidate,
        mutate: (queue) => reconcile(removeEntry(queue, sessionId, now), sessions, now),
        now
      });
      this.queues.set(workspaceKey, saved.queue);
      return saved.queue;
    });
  }

  /**
   * Apply an arbitrary reorder and persist it. The caller (P5 UI) supplies the
   * mutation; keeping it here means every ordering change goes through the same
   * CAS and serialization path.
   */
  public async mutate(
    workspaceKey: string,
    sessions: readonly Pick<ChatSession, 'id' | 'createdAt'>[],
    mutate: (queue: ProjectSessionQueue) => ProjectSessionQueue,
    now?: string
  ): Promise<ProjectSessionQueue> {
    await this.ensureLoaded(workspaceKey, sessions, now);
    return this.serialize(workspaceKey, async () => {
      const base = this.queues.get(workspaceKey) ?? createEmptyQueue(workspaceKey, now);
      const candidate = reconcile(mutate(cloneQueue(base)), sessions, now);
      if (candidate === base) return base;
      const saved = await saveQueueWithRebase({
        store: this.storeFor(workspaceKey),
        workspaceKey,
        base,
        candidate,
        mutate: (queue) => reconcile(mutate(queue), sessions, now),
        now
      });
      this.queues.set(workspaceKey, saved.queue);
      return saved.queue;
    });
  }

  /** Re-align the queue with the sessions that actually exist. */
  public async sync(
    workspaceKey: string,
    sessions: readonly Pick<ChatSession, 'id' | 'createdAt'>[],
    now?: string
  ): Promise<ProjectSessionQueue> {
    return this.mutate(workspaceKey, sessions, (queue) => reconcile(queue, sessions, now), now);
  }

  /** Drop cached state, e.g. after a workspace scope change. */
  public forget(workspaceKey: string): void {
    this.queues.delete(workspaceKey);
    this.stores.delete(workspaceKey);
  }
}