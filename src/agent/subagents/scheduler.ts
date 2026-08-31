import type { SubagentTreeBudget } from './types';
import { AgentRunAbortedError } from '../runner';
import type { KeepseekLanguage } from '../../shared/i18n';

export const DEFAULT_SUBAGENT_TOTAL_CONCURRENCY = 4;
export const DEFAULT_SUBAGENT_ROOT_CONCURRENCY = 3;
export const DEFAULT_SUBAGENT_PROPOSAL_CONCURRENCY = 2;
export const DEFAULT_SUBAGENT_MAX_DEPTH = 2;
export const DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT_RUN = 8;
export const DEFAULT_SUBAGENT_MAX_CHILDREN_PER_TREE = 12;

interface TreeBudget {
  count: number;
  parents: Set<string>;
  updatedAt: number;
  pathClaims: Map<string, string>;
}

export class SubagentScheduler {
  private readonly rootSlots = new Semaphore(DEFAULT_SUBAGENT_ROOT_CONCURRENCY);
  private readonly nestedSlots = new Semaphore(DEFAULT_SUBAGENT_TOTAL_CONCURRENCY - DEFAULT_SUBAGENT_ROOT_CONCURRENCY);
  private readonly proposalSlots = new Semaphore(DEFAULT_SUBAGENT_PROPOSAL_CONCURRENCY);
  private readonly treeBudgets = new Map<string, TreeBudget>();
  private readonly parentCounts = new Map<string, number>();

  public reserve(input: {
    treeId: string;
    parentRunId: string;
    ownerId: string;
    depth: number;
    proposal: boolean;
    paths?: readonly string[];
  }): { ok: true } | { ok: false; reason: string } {

    if (input.depth < 1 || input.depth > DEFAULT_SUBAGENT_MAX_DEPTH) {
      return { ok: false, reason: `Subagent depth ${input.depth} exceeds the supported range 1-${DEFAULT_SUBAGENT_MAX_DEPTH}.` };
    }
    const parentCount = this.parentCounts.get(input.parentRunId) ?? 0;
    if (parentCount >= DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT_RUN) {
      return { ok: false, reason: `This parent run has reached its ${DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT_RUN}-child limit.` };
    }
    const tree = this.treeBudgets.get(input.treeId) ?? {
      count: 0,
      parents: new Set<string>(),
      updatedAt: Date.now(),
      pathClaims: new Map<string, string>()
    };
    if (tree.count >= DEFAULT_SUBAGENT_MAX_CHILDREN_PER_TREE) {
      return { ok: false, reason: `This delegation tree has reached its ${DEFAULT_SUBAGENT_MAX_CHILDREN_PER_TREE}-child limit.` };
    }
    if (input.proposal) {
      for (const rawPath of input.paths ?? []) {
        const path = normalizeClaimPath(rawPath);
        const owner = path ? tree.pathClaims.get(path) : undefined;
        if (owner && owner !== input.ownerId) {
          return { ok: false, reason: `Proposal path is already claimed by a sibling subagent: ${rawPath}` };
        }
      }
      for (const rawPath of input.paths ?? []) {
        const path = normalizeClaimPath(rawPath);
        if (path) {
          tree.pathClaims.set(path, input.ownerId);
        }
      }
    }
    tree.count += 1;
    tree.parents.add(input.parentRunId);
    tree.updatedAt = Date.now();
    this.treeBudgets.set(input.treeId, tree);
    this.parentCounts.set(input.parentRunId, parentCount + 1);
    return { ok: true };
  }

  public async run<T>(input: {
    depth: number;
    proposal: boolean;
    signal?: AbortSignal;
    language: KeepseekLanguage;
  }, task: () => Promise<T>): Promise<T> {
    const releaseDepth = await (input.depth === 1 ? this.rootSlots : this.nestedSlots).acquire(input.signal, input.language);
    let releaseProposal: (() => void) | undefined;
    try {
      releaseProposal = input.proposal ? await this.proposalSlots.acquire(input.signal, input.language) : undefined;
      if (input.signal?.aborted) throw new AgentRunAbortedError(input.language);
      return await task();
    } finally {
      releaseProposal?.();
      releaseDepth();
    }
  }

  /** Explicit lifecycle cleanup only. Interrupted trees retain their count and
   * path claims until their logical task is completed/abandoned. */
  public snapshotTree(treeId: string): SubagentTreeBudget | undefined {
    const tree = this.treeBudgets.get(treeId);
    return tree ? { count: tree.count, paths: [...tree.pathClaims], parents: [...tree.parents].map((id) => [id, this.parentCounts.get(id) ?? 0]) } : undefined;
  }
  public restoreTree(treeId: string, budget: SubagentTreeBudget): void {
    if (this.treeBudgets.has(treeId)) return;
    this.treeBudgets.set(treeId, { count: budget.count, pathClaims: new Map(budget.paths), parents: new Set(budget.parents.map(([id]) => id)), updatedAt: Date.now() });
    budget.parents.forEach(([id, count]) => this.parentCounts.set(id, count));
  }
  public releaseTree(treeId: string): void {
    this.treeBudgets.get(treeId)?.parents.forEach((id) => this.parentCounts.delete(id));
    this.treeBudgets.delete(treeId);
  }

}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<{
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    language: KeepseekLanguage;
    cleanup: () => void;
  }> = [];

  public constructor(private readonly capacity: number) {}

  public async acquire(signal: AbortSignal | undefined, language: KeepseekLanguage): Promise<() => void> {
    if (signal?.aborted) {
      throw new AgentRunAbortedError(language);
    }
    if (this.active < this.capacity) {
      this.active += 1;
      return this.createRelease();
    }
    return await new Promise<() => void>((resolve, reject) => {
      const waiter = { resolve, reject, signal, language, cleanup: () => signal?.removeEventListener('abort', abort) };
      const abort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) {
          this.waiters.splice(index, 1);
          reject(new AgentRunAbortedError(language));
        }
      };
      this.waiters.push(waiter);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      while (this.waiters.length) {
        const waiter = this.waiters.shift();
        waiter?.cleanup();
        if (!waiter || waiter.signal?.aborted) {
          continue;
        }
        waiter.resolve(this.createRelease());
        return;
      }
      this.active = Math.max(0, this.active - 1);
    };
  }
}

function normalizeClaimPath(value: string): string {
  return value.trim().replace(/\\/gu, '/').replace(/^\.\//u, '').replace(/\/{2,}/gu, '/').toLocaleLowerCase();
}
