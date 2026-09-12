import type { SubagentTreeBudget } from './types';
import { AgentRunAbortedError } from '../runner';
import type { KeepseekLanguage } from '../../shared/i18n';
import {
  decodeProposalPathScope,
  encodeProposalPathScope,
  scopesOverlap,
  type ProposalPathScope,
  type WorkspaceScopeRoot
} from './pathScope';

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
  pathClaims: Map<string, ProposalPathScope>;
}

interface SubagentReservationInput {
  treeId: string;
  parentRunId: string;
  ownerId: string;
  depth: number;
  proposal: boolean;
  scope?: ProposalPathScope;
  /** Legacy test/adapter surface. Runtime callers must pass a URI-resolved scope. */
  paths?: readonly string[];
  roots?: readonly WorkspaceScopeRoot[];
  conflictingScopes?: readonly ProposalPathScope[];
}

export class SubagentScheduler {
  private readonly rootSlots = new Semaphore(DEFAULT_SUBAGENT_ROOT_CONCURRENCY);
  private readonly nestedSlots = new Semaphore(DEFAULT_SUBAGENT_TOTAL_CONCURRENCY - DEFAULT_SUBAGENT_ROOT_CONCURRENCY);
  private readonly proposalSlots = new Semaphore(DEFAULT_SUBAGENT_PROPOSAL_CONCURRENCY);
  private readonly treeBudgets = new Map<string, TreeBudget>();
  private readonly parentCounts = new Map<string, number>();
  private readonly activeProposalClaims = new Map<string, { treeId: string; scope: ProposalPathScope }>();

  public reserve(input: SubagentReservationInput): { ok: true } | { ok: false; reason: string } {
    return this.reserveBatch([input]);
  }

  /** Validate a whole batch against budgets and every active/peer lease before
   * mutating scheduler state. No child can start from a partially reserved batch. */
  public reserveBatch(inputs: readonly SubagentReservationInput[]): { ok: true } | { ok: false; reason: string } {
    const stagedTrees = new Map<string, TreeBudget>();
    const stagedParents = new Map(this.parentCounts);
    const stagedActive = new Map(this.activeProposalClaims);
    for (const input of inputs) {
      if (input.depth < 1 || input.depth > DEFAULT_SUBAGENT_MAX_DEPTH) {
        return { ok: false, reason: `Subagent depth ${input.depth} exceeds the supported range 1-${DEFAULT_SUBAGENT_MAX_DEPTH}.` };
      }
      const parentCount = stagedParents.get(input.parentRunId) ?? 0;
      if (parentCount >= DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT_RUN) {
        return { ok: false, reason: `This parent run has reached its ${DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT_RUN}-child limit.` };
      }
      const existingTree = stagedTrees.get(input.treeId) ?? this.treeBudgets.get(input.treeId);
      const tree: TreeBudget = existingTree ? {
        count: existingTree.count,
        parents: new Set(existingTree.parents),
        updatedAt: existingTree.updatedAt,
        pathClaims: new Map(existingTree.pathClaims)
      } : { count: 0, parents: new Set(), updatedAt: Date.now(), pathClaims: new Map() };
      if (tree.count >= DEFAULT_SUBAGENT_MAX_CHILDREN_PER_TREE) {
        return { ok: false, reason: `This delegation tree has reached its ${DEFAULT_SUBAGENT_MAX_CHILDREN_PER_TREE}-child limit.` };
      }
      if (input.proposal) {
        const roots = input.roots?.length ? input.roots : [legacyScopeRoot()];
        const scope = input.scope ?? (input.paths?.length ? legacyPathScope(input.paths) : { kind: 'workspace' as const });
        for (const conflict of input.conflictingScopes ?? []) {
          if (scopesOverlap(scope, conflict, roots)) {
            return { ok: false, reason: 'Proposal scope conflicts with an existing parent DraftEdit.' };
          }
        }
        for (const [owner, active] of stagedActive) {
          if (owner !== input.ownerId && scopesOverlap(scope, active.scope, roots)) {
            return { ok: false, reason: 'Proposal scope is already claimed by another active subagent.' };
          }
        }
        tree.pathClaims.set(input.ownerId, scope);
        stagedActive.set(input.ownerId, { treeId: input.treeId, scope });
      }
      tree.count += 1;
      tree.parents.add(input.parentRunId);
      tree.updatedAt = Date.now();
      stagedTrees.set(input.treeId, tree);
      stagedParents.set(input.parentRunId, parentCount + 1);
    }
    stagedTrees.forEach((tree, treeId) => this.treeBudgets.set(treeId, tree));
    this.parentCounts.clear();
    stagedParents.forEach((count, parentId) => this.parentCounts.set(parentId, count));
    this.activeProposalClaims.clear();
    stagedActive.forEach((claim, owner) => this.activeProposalClaims.set(owner, claim));
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
    return tree ? {
      count: tree.count,
      paths: [...tree.pathClaims].flatMap(([owner, scope]) => encodeProposalPathScope(scope, []).map((claim) => [claim, owner] as [string, string])),
      parents: [...tree.parents].map((id) => [id, this.parentCounts.get(id) ?? 0])
    } : undefined;
  }
  public restoreTree(treeId: string, budget: SubagentTreeBudget): void {
    if (this.treeBudgets.has(treeId)) return;
    const byOwner = new Map<string, string[]>();
    budget.paths.forEach(([claim, owner]) => byOwner.set(owner, [...(byOwner.get(owner) ?? []), claim]));
    const pathClaims = new Map<string, ProposalPathScope>();
    byOwner.forEach((claims, owner) => {
      const scope = decodeProposalPathScope(claims);
      pathClaims.set(owner, scope);
      this.activeProposalClaims.set(owner, { treeId, scope });
    });
    this.treeBudgets.set(treeId, { count: budget.count, pathClaims, parents: new Set(budget.parents.map(([id]) => id)), updatedAt: Date.now() });
    budget.parents.forEach(([id, count]) => this.parentCounts.set(id, count));
  }
  public releaseTree(treeId: string): void {
    this.treeBudgets.get(treeId)?.parents.forEach((id) => this.parentCounts.delete(id));
    for (const [owner, claim] of this.activeProposalClaims) {
      if (claim.treeId === treeId) this.activeProposalClaims.delete(owner);
    }
    this.treeBudgets.delete(treeId);
  }

}

function legacyScopeRoot(): WorkspaceScopeRoot {
  return { id: 'legacy', name: 'legacy', uri: {} as never, caseSensitive: true };
}

function legacyPathScope(paths: readonly string[]): ProposalPathScope {
  return {
    kind: 'paths',
    claims: paths.map((value) => ({
      rootId: 'legacy',
      segments: value.trim().replace(/\\/gu, '/').split('/').filter((segment) => segment && segment !== '.')
    }))
  };
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
