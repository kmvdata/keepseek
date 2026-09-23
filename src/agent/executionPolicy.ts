/** Zero is the only serialized unlimited value. Never pass it to a timer. */
export function normalizeDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, Math.floor(value))) : 0;
}

export function mergeDurations(...values: unknown[]): number {
  const finite = values.map(normalizeDuration).filter((value) => value > 0);
  return finite.length ? Math.min(...finite) : 0;
}

export function normalizeCostLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.min(Number.MAX_SAFE_INTEGER, value) : 0;
}

export function mergeCostLimits(...values: unknown[]): number {
  const finite = values.map(normalizeCostLimit).filter((value) => value > 0);
  return finite.length ? Math.min(...finite) : 0;
}

export interface LogicalRunBudgetState {
  version: 1;
  modelRequests: number;
  toolRounds: number;
  toolCalls: number;
  continuations: number;
  promptTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  upstreamTokens: number;
  contextEpochRollovers: number;
  continuationOutputTokens: number;
  continuationOutputChars: number;
  usedMs: number;
  deadlineAt?: string;
  finalizationAttempted: boolean;
  treeUpstreamTokens: number;
}

export interface LogicalRunBudgetLimits {
  maxModelRequests: number;
  maxToolRounds: number;
  maxToolCalls: number;
  maxContinuations: number;
  maxContextEpochRollovers: number;
  maxUpstreamTokens: number;
  maxTreeUpstreamTokens: number;
  maxContinuationOutputTokens: number;
  maxContinuationOutputChars: number;
}

export function createLogicalRunBudgetState(input: Partial<LogicalRunBudgetState> = {}): LogicalRunBudgetState {
  return {
    version: 1,
    modelRequests: budgetCount(input.modelRequests),
    toolRounds: budgetCount(input.toolRounds),
    toolCalls: budgetCount(input.toolCalls),
    continuations: budgetCount(input.continuations),
    promptTokens: budgetCount(input.promptTokens),
    completionTokens: budgetCount(input.completionTokens),
    reasoningTokens: budgetCount(input.reasoningTokens),
    upstreamTokens: budgetCount(input.upstreamTokens),
    contextEpochRollovers: budgetCount(input.contextEpochRollovers),
    continuationOutputTokens: budgetCount(input.continuationOutputTokens),
    continuationOutputChars: budgetCount(input.continuationOutputChars),
    usedMs: normalizeDuration(input.usedMs),
    deadlineAt: normalizeDeadline(input.deadlineAt),
    finalizationAttempted: input.finalizationAttempted === true,
    treeUpstreamTokens: budgetCount(input.treeUpstreamTokens)
  };
}

interface PhysicalRequestReservation {
  promptTokens: number;
  outputTokens: number;
  upstreamTokens: number;
}

/** A single synchronous ledger is shared by a root run and all of its children.
 * JavaScript execution makes reserve/settle atomic even when children run in
 * parallel. Estimates are charged before dispatch and reconciled to reported
 * usage afterwards, so parallel requests cannot each claim the whole tree. */
export class SharedUpstreamTokenBudget {
  public constructor(public readonly limit: number, private used: number) {
    this.used = budgetCount(used);
  }

  public reserve(tokens: number): void {
    const amount = budgetCount(tokens);
    if (this.limit > 0 && this.used + amount > this.limit) {
      throw new LogicalBudgetExceededError('tree_upstream_token_budget_exhausted');
    }
    this.used += amount;
  }

  public reconcile(reserved: number, actual: number): void {
    this.used = budgetCount(this.used - budgetCount(reserved) + budgetCount(actual));
  }

  /** Child checkpoints store the cumulative tree snapshot. On host recovery the
   * newest child may be ahead of the parent's last checkpoint, so merge by max
   * before admitting another parallel request. */
  public restoreAtLeast(tokens: number): void {
    this.used = Math.max(this.used, budgetCount(tokens));
  }

  public get usedTokens(): number { return this.used; }
}

export class LogicalBudgetExceededError extends Error {
  public constructor(public readonly budgetReason: string) {
    super(`Logical run budget exhausted: ${budgetReason}`);
    this.name = 'LogicalBudgetExceededError';
  }
}

export class LogicalRunBudget {
  public readonly state: LogicalRunBudgetState;

  public constructor(
    restored: LogicalRunBudgetState | undefined,
    public readonly limits: LogicalRunBudgetLimits,
    public readonly tree: SharedUpstreamTokenBudget,
    maxExecutionMs: number,
    now = Date.now(),
    inheritedDeadlineAt?: number
  ) {
    this.state = createLogicalRunBudgetState(restored);
    this.tree.restoreAtLeast(this.state.treeUpstreamTokens);
    if (!this.state.deadlineAt && maxExecutionMs > 0) {
      const remaining = Math.max(0, maxExecutionMs - this.state.usedMs);
      this.state.deadlineAt = new Date(now + remaining).toISOString();
    }
    const ownDeadlineAt = this.deadlineAt;
    if (typeof inheritedDeadlineAt === 'number' && Number.isFinite(inheritedDeadlineAt)
      && (ownDeadlineAt === undefined || inheritedDeadlineAt < ownDeadlineAt)) {
      this.state.deadlineAt = new Date(inheritedDeadlineAt).toISOString();
    }
    this.syncTree();
  }

  public get deadlineAt(): number | undefined {
    const parsed = this.state.deadlineAt ? Date.parse(this.state.deadlineAt) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  public assertCanDispatch(): void {
    if (this.limits.maxModelRequests > 0 && this.state.modelRequests >= this.limits.maxModelRequests) {
      throw new LogicalBudgetExceededError('model_request_budget_exhausted');
    }
    if (this.deadlineAt !== undefined && Date.now() >= this.deadlineAt) {
      throw new LogicalBudgetExceededError('run_time_budget_exhausted');
    }
  }

  public reservePhysicalRequest(estimatedPromptTokens: number, outputTokens: number): PhysicalRequestReservation {
    this.assertCanDispatch();
    const promptTokens = budgetCount(estimatedPromptTokens);
    const reservedOutputTokens = budgetCount(outputTokens);
    const upstreamTokens = promptTokens + reservedOutputTokens;
    if (this.limits.maxUpstreamTokens > 0 && this.state.upstreamTokens + upstreamTokens > this.limits.maxUpstreamTokens) {
      throw new LogicalBudgetExceededError('upstream_token_budget_exhausted');
    }
    this.tree.reserve(upstreamTokens);
    this.state.modelRequests += 1;
    this.state.promptTokens += promptTokens;
    this.state.upstreamTokens += upstreamTokens;
    this.syncTree();
    return { promptTokens, outputTokens: reservedOutputTokens, upstreamTokens };
  }

  public settlePhysicalRequest(
    reservation: PhysicalRequestReservation,
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      reasoning_tokens?: number;
      completion_tokens_details?: { reasoning_tokens?: number };
    }
  ): void {
    if (!usage) return;
    const prompt = budgetCount(usage.prompt_tokens);
    const completion = budgetCount(usage.completion_tokens);
    const reasoning = budgetCount(usage.reasoning_tokens ?? usage.completion_tokens_details?.reasoning_tokens);
    const total = budgetCount(usage.total_tokens || prompt + completion);
    this.state.promptTokens = budgetCount(this.state.promptTokens - reservation.promptTokens + prompt);
    this.state.completionTokens += completion;
    this.state.reasoningTokens += reasoning;
    this.state.upstreamTokens = budgetCount(this.state.upstreamTokens - reservation.upstreamTokens + total);
    this.tree.reconcile(reservation.upstreamTokens, total);
    this.syncTree();
  }

  public canUseTools(): boolean {
    return this.limits.maxToolRounds > 0 && this.state.toolRounds < this.limits.maxToolRounds
      && this.limits.maxToolCalls > 0 && this.state.toolCalls < this.limits.maxToolCalls;
  }

  public recordToolRound(): void {
    if (this.limits.maxToolRounds <= 0 || this.state.toolRounds >= this.limits.maxToolRounds) {
      throw new LogicalBudgetExceededError('tool_round_budget_exhausted');
    }
    this.state.toolRounds += 1;
  }

  public tryRecordToolCall(): boolean {
    if (this.limits.maxToolCalls <= 0 || this.state.toolCalls >= this.limits.maxToolCalls) return false;
    this.state.toolCalls += 1;
    return true;
  }

  public beginFinalization(): boolean {
    if (this.state.finalizationAttempted) return false;
    this.state.finalizationAttempted = true;
    return true;
  }

  public beginContinuation(): boolean {
    if (this.limits.maxContinuations >= 0 && this.state.continuations >= this.limits.maxContinuations) return false;
    this.state.continuations += 1;
    return true;
  }

  public recordContinuationOutput(tokens: number, chars: number): boolean {
    this.state.continuationOutputTokens += budgetCount(tokens);
    this.state.continuationOutputChars += budgetCount(chars);
    return (this.limits.maxContinuationOutputTokens <= 0
      || this.state.continuationOutputTokens <= this.limits.maxContinuationOutputTokens)
      && (this.limits.maxContinuationOutputChars <= 0
        || this.state.continuationOutputChars <= this.limits.maxContinuationOutputChars);
  }

  public tryRecordRollover(): boolean {
    if (this.limits.maxContextEpochRollovers >= 0
      && this.state.contextEpochRollovers >= this.limits.maxContextEpochRollovers) return false;
    this.state.contextEpochRollovers += 1;
    return true;
  }

  public syncUsedMs(usedMs: number): void {
    this.state.usedMs = normalizeDuration(usedMs);
    this.syncTree();
  }

  private syncTree(): void { this.state.treeUpstreamTokens = this.tree.usedTokens; }
}

function budgetCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value)) : 0;
}

function normalizeDeadline(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : undefined;
}

/** Shared by a root run and its children. Costs in different currencies are
 * intentionally not added together; the configured ceiling applies to each
 * independently accounted currency. */
export class ExecutionCostBudget {
  private readonly costs = new Map<string, number>();

  public constructor(public readonly limit: number, restored: Record<string, number> = {}) {
    for (const [currency, cost] of Object.entries(restored)) {
      if (currency && Number.isFinite(cost) && cost >= 0) this.costs.set(currency, cost);
    }
  }

  public record(cost: number, currency: string): void {
    if (!(cost >= 0) || !Number.isFinite(cost) || !currency) return;
    this.costs.set(currency, (this.costs.get(currency) ?? 0) + cost);
  }

  public restoreAtLeast(restored: Record<string, number>): void {
    for (const [currency, cost] of Object.entries(restored)) {
      if (currency && Number.isFinite(cost) && cost >= 0) {
        this.costs.set(currency, Math.max(this.costs.get(currency) ?? 0, cost));
      }
    }
  }

  public get exhausted(): { currency: string; cost: number; limit: number } | undefined {
    if (!(this.limit > 0)) return undefined;
    for (const [currency, cost] of [...this.costs].sort(compareCurrencyEntries)) {
      if (cost >= this.limit) return { currency, cost, limit: this.limit };
    }
    return undefined;
  }

  public snapshot(): Record<string, number> {
    return Object.fromEntries([...this.costs].sort(compareCurrencyEntries));
  }
}

function compareCurrencyEntries([left]: [string, number], [right]: [string, number]): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export class ExecutionBudgetError extends Error {
  public constructor() { super('Effective execution time budget exhausted / 有效执行时间预算已用尽'); }
}

/** Counts the union of active scopes, not the sum of parallel child durations.
 * Long host suspension/event-loop gaps are conservatively excluded. Wall clock
 * timestamps are for display only; restart resumes the persisted usedMs. */
export class ExecutionClock {
  private active = 0;
  private last: number;
  private used: number;
  private readonly controller = new AbortController();
  private timer?: ReturnType<typeof setInterval>;
  public constructor(public readonly limitMs: number, usedMs = 0,
    private readonly now: () => number = () => performance.now()) {
    this.used = normalizeDuration(usedMs);
    this.last = now();
  }
  public get signal(): AbortSignal { return this.controller.signal; }
  public get usedMs(): number { this.sample(); return Math.floor(this.used); }
  public get remainingMs(): number { return this.limitMs > 0 ? Math.max(0, this.limitMs - this.usedMs) : Infinity; }
  public sample(): void {
    const next = this.now();
    const delta = next - this.last;
    this.last = next;
    if (this.active && delta >= 0 && delta <= 5_000) this.used += delta;
    if (this.limitMs > 0 && this.used >= this.limitMs) this.controller.abort(new ExecutionBudgetError());
  }
  public enter(): () => void {
    this.sample();
    this.active++;
    if (!this.timer) {
      this.timer = setInterval(() => this.sample(), 250);
      this.timer.unref?.();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.sample();
      this.active--;
      if (!this.active && this.timer) { clearInterval(this.timer); this.timer = undefined; }
    };
  }
  public dispose(): void { this.sample(); if (this.timer) clearInterval(this.timer); this.timer = undefined; }
}

/** Cancellation of a modal/uncancellable read must release the execution chain;
 * its late result cannot authorize or start a tool. */
export async function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw signal.reason ?? new Error('Stopped');
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(signal.reason ?? new Error('Stopped')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
  });
}
