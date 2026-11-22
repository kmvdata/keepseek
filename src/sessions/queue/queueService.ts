import type * as vscode from 'vscode';
import type { ChatSession } from '../../shared/types';
import { ProjectQueueStore, saveQueueWithRebase, type QueueLoadResult } from './queueStore';
import { cloneQueue, createEmptyQueue, enqueueNewSession, effectiveMode, promoteToFront, reconcile, removeEntry } from './projectQueue';
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

  private isExclusiveWriter?: (workspaceKey: string, id: string) => Promise<boolean>;
  private listDurableSessions?: (workspaceKey: string) => Promise<readonly Pick<ChatSession, 'id' | 'createdAt'>[]>;

  /** A stale history projection must not evict a session created in another
   * window. Consult the durable catalog only when the queue has unknown IDs. */
  public setSessionCatalog(load: (workspaceKey: string) => Promise<readonly Pick<ChatSession, 'id' | 'createdAt'>[]>,
    isExclusiveWriter?: (workspaceKey: string, id: string) => Promise<boolean>): void {
    this.listDurableSessions = load;
    this.isExclusiveWriter = isExclusiveWriter;
  }

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
    const loading = promise.then((result) => result.queue);
    // The initiating caller awaits promise below; this separate promise only
    // has a consumer when a concurrent reader joins the load.
    void loading.catch(() => undefined);
    this.loading.set(workspaceKey, loading);
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
    return this.mutate(workspaceKey, sessions, queue => enqueueNewSession(queue, sessionId, now), now);
  }

  /** Drop a deleted session; the next entry becomes the head (and normal). */
  public async remove(
    workspaceKey: string,
    sessionId: string,
    sessions: readonly Pick<ChatSession, 'id' | 'createdAt'>[] = [],
    now?: string
  ): Promise<ProjectSessionQueue> {
    return this.mutate(workspaceKey, sessions, queue => removeEntry(queue, sessionId, now), now);
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
      const store = this.storeFor(workspaceKey);
      const { queue: disk, status } = await store.load(workspaceKey, sessions, now);
      const base = status === 'loaded' ? disk : this.queues.get(workspaceKey) ?? createEmptyQueue(workspaceKey, now);
      const align = async (queue: ProjectSessionQueue) => {
        let seeds = sessions;
        const known = new Set(sessions.map(s => s.id));
        if (this.listDurableSessions && (queue.entries.length !== known.size || queue.entries.some(entry => !known.has(entry.sessionId)))) {
          seeds = await this.listDurableSessions(workspaceKey);
        }
        return reconcile(mutate(queue), seeds, now);
      };
      const candidate = await align(cloneQueue(base));
      // A checkpoint save normally leaves membership and order unchanged. A
      // read of the current disk revision suffices; avoid locking/fsyncing an
      // identical queue on every token checkpoint or blank navigation.
      if (status === 'loaded' && candidate.revision === base.revision
        && JSON.stringify(candidate.entries) === JSON.stringify(base.entries)) {
        this.queues.set(workspaceKey, base);
        return base;
      }
      const saved = await saveQueueWithRebase({
        store: this.storeFor(workspaceKey),
        workspaceKey,
        base,
        candidate,
        mutate: align,
        guard: async (current, candidate) => {
          const writer = current?.entries[0]?.sessionId;
          if (writer && writer !== candidate.entries[0]?.sessionId && await this.isExclusiveWriter?.(workspaceKey, writer)) {
            throw new Error('The handoff writer is in use / 交接写会话正在执行');
          }
        },
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
    return this.mutate(workspaceKey, sessions, queue => queue, now);
  }

  /** Register an ordinary reader/writer under the same order lock that
   * checks the displaced writer's use records before handoff promotion. */
  public async acquireSessionUse<T>(workspaceKey: string, sessions: readonly Pick<ChatSession, 'id' | 'createdAt'>[],
    acquire: () => Promise<T>): Promise<T> {
    return this.serialize(workspaceKey, async () => {
      const store = this.storeFor(workspaceKey);
      return store.withOrderLock(async () => {
        const result = await store.load(workspaceKey, sessions);
        this.queues.set(workspaceKey, result.queue);
        return acquire();
      });
    });
  }

  public async readHandoffSource(workspaceKey: string, sourceId: string): Promise<ProjectSessionQueue> {
    const { queue, status } = await this.storeFor(workspaceKey).load(workspaceKey);
    if (status !== 'loaded' || !queue.entries.some(e => e.sessionId === sourceId)) {
      throw new Error('Source queue membership changed / 源会话队列位置已变化');
    }
    return queue;
  }

  /** Transactional handoff operates on disk order, never on a stale sessions
   * projection. A rebase keeps foreign members and revalidates admission. */
  public async promoteHandoff(workspaceKey: string, sourceId: string, targetId: string,
    guard: (queue: ProjectSessionQueue) => Promise<void>): Promise<ProjectSessionQueue> {
    return this.serialize(workspaceKey, async () => {
      const store = this.storeFor(workspaceKey);
      for (let attempt = 0; attempt < 3; attempt++) {
        const queue = await this.readHandoffSource(workspaceKey, sourceId);
        await guard(queue);
        const candidate = promoteToFront(enqueueNewSession(queue, targetId), targetId);
        // Even the idempotent path attests the committed queue under the CAS lock.
        const result = await store.save({ ...candidate, revision: queue.revision + 1 }, queue.revision, async current => {
          if (!current) throw new Error('Project queue unavailable / 项目队列不可用');
          await guard(current);
        });
        if (result.status === 'saved') return this.verifyHandoffHeadUnlocked(workspaceKey, targetId);
      }
      throw new Error('Project queue changed. Retry the handoff / 项目队列已变化，请重试交接');
    });
  }

  public async atHandoffHead<T>(workspaceKey: string, targetId: string, work: () => Promise<T>): Promise<T> {
    return this.serialize(workspaceKey, () => this.storeFor(workspaceKey).withVerifiedHead(workspaceKey, targetId, async queue => {
      this.queues.set(workspaceKey, queue);
      return work();
    }));
  }

  private async verifyHandoffHeadUnlocked(workspaceKey: string, targetId: string): Promise<ProjectSessionQueue> {
    const { queue, status } = await this.storeFor(workspaceKey).load(workspaceKey);
    this.queues.set(workspaceKey, queue);
    if (status !== 'loaded' || queue.entries[0]?.sessionId !== targetId) {
      throw new Error('Handoff target is not the durable queue head / 交接目标未取得持久化队首');
    }
    return queue;
  }

  /** Drop cached state, e.g. after a workspace scope change. */
  public forget(workspaceKey: string): void {
    this.queues.delete(workspaceKey);
    this.stores.delete(workspaceKey);
  }
}