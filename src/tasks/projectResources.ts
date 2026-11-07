import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ProjectExecutionOwner } from './projectOwner';
import type { ProjectRequestAdmission, ProjectRequestRole } from './requestAdmission';

export interface ProjectExecutionScope {
  sessionId: string;
  rootTaskId: string;
  segmentId: string;
  runtimeId: string;
}

export interface ProjectResourceToken {
  readonly projectId: string;
  readonly id: string;
  readonly scope: Readonly<ProjectExecutionScope>;
}

export interface ProjectValidationStamp {
  projectId: string;
  resourceRevision: number;
  phaseId: string;
  fingerprint: string;
}

export interface ProjectResourceLease {
  readonly token: ProjectResourceToken;
  readonly baselineRevision: number;
  assertValid(): void;
  recordMutation(): void;
  validationStamp(fingerprint: string): ProjectValidationStamp;
  release(): void;
}

interface Waiter {
  scope: ProjectExecutionScope;
  signal?: AbortSignal;
  resolve: (lease: ProjectResourceLease) => void;
  reject: (error: Error) => void;
  onAbort?: () => void;
}

/** One mutation/validation phase per physical project. Requests, root slots and
 * child scheduling are intentionally not acquired here, preventing hold/wait
 * cycles across those unrelated resources.
 */
export class ProjectResourceCoordinator {
  private active?: { token: ProjectResourceToken; references: number; invalidated: boolean };
  private readonly waiters: Waiter[] = [];
  private revision = 0;
  private readonly invalidatedScopes = new Set<string>();
  private readonly uncertainOperations = new Set<string>();

  public constructor(public readonly projectId: string) {}
  public get resourceRevision(): number { return this.revision; }
  public get waitingCount(): number { return this.waiters.length; }
  public get activeScope(): Readonly<ProjectExecutionScope> | undefined { return this.active?.token.scope; }

  public acquire(scope: ProjectExecutionScope, options: { signal?: AbortSignal; token?: ProjectResourceToken } = {}): Promise<ProjectResourceLease> {
    validateScope(scope);
    if (this.uncertainOperations.size) return Promise.reject(new Error('Project has unknown side effects requiring inspection. / 项目存在结果未知的副作用，须先核对。'));
    if (this.isScopeInvalidated(scope)) return Promise.reject(new Error('Project execution segment was invalidated. / 执行段已失效。'));
    if (options.signal?.aborted) return Promise.reject(aborted());
    if (options.token) {
      try {
        this.assertToken(options.token, scope);
        this.active!.references += 1;
        return Promise.resolve(this.makeLease(options.token, options.signal));
      } catch (error) { return Promise.reject(error); }
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { scope: { ...scope }, signal: options.signal, resolve, reject };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(aborted());
      };
      options.signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.waiters.push(waiter);
      this.pump();
    });
  }

  public async withLease<T>(scope: ProjectExecutionScope, work: (lease: ProjectResourceLease) => Promise<T>, options: { signal?: AbortSignal; token?: ProjectResourceToken } = {}): Promise<T> {
    const lease = await this.acquire(scope, options);
    try { lease.assertValid(); return await work(lease); }
    finally { lease.release(); }
  }

  public isValidationCurrent(stamp: ProjectValidationStamp): boolean {
    return stamp.projectId === this.projectId && stamp.resourceRevision === this.revision;
  }

  public verifyToken(token: ProjectResourceToken, scope: ProjectExecutionScope): void { this.assertToken(token, scope); }
  public isScopeInvalidated(scope: ProjectExecutionScope): boolean { return this.invalidatedScopes.has(scopeKey(scope)); }
  public blockUncertain(operationId: string): void {
    this.uncertainOperations.add(operationId);
    for (const waiter of this.waiters.splice(0)) {
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      waiter.reject(new Error('Project has unknown side effects requiring inspection. / 项目存在结果未知的副作用，须先核对。'));
    }
  }

  /** Call on explicit supplement/cancel/config boundaries; dispatched work still
   * owns its lease until settlement, but no nested new side effect may start.
   */
  public invalidate(scope: ProjectExecutionScope): void {
    this.invalidatedScopes.add(scopeKey(scope));
    if (this.active && sameScope(this.active.token.scope, scope)) this.active.invalidated = true;
    for (const waiter of [...this.waiters]) {
      if (!sameScope(waiter.scope, scope)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      waiter.reject(new Error('Project execution segment was invalidated. / 执行段已失效。'));
    }
  }

  private assertToken(token: ProjectResourceToken, scope: ProjectExecutionScope): void {
    if (this.uncertainOperations.size || token.projectId !== this.projectId || this.active?.token !== token || this.active.invalidated || !sameScope(token.scope, scope)) {
      throw new Error('Project resource lease is stale or belongs to another task. / 项目资源租约已失效或属于其他任务。');
    }
  }

  private makeLease(token: ProjectResourceToken, signal?: AbortSignal): ProjectResourceLease {
    const baselineRevision = this.revision;
    let released = false;
    const check = () => {
      if (released || signal?.aborted) throw aborted();
      this.assertToken(token, token.scope);
    };
    return {
      token, baselineRevision,
      assertValid: check,
      recordMutation: () => { check(); this.revision += 1; },
      validationStamp: (fingerprint) => { check(); return { projectId: this.projectId, resourceRevision: this.revision, phaseId: token.id, fingerprint }; },
      release: () => {
        if (released) return;
        released = true;
        if (this.active?.token !== token) return;
        this.active.references -= 1;
        if (this.active.references === 0) { this.active = undefined; this.pump(); }
      }
    };
  }

  private pump(): void {
    if (this.active) return;
    const next = this.waiters.shift();
    if (!next) return;
    next.signal?.removeEventListener('abort', next.onAbort!);
    if (next.signal?.aborted) { next.reject(aborted()); this.pump(); return; }
    const token: ProjectResourceToken = Object.freeze({ projectId: this.projectId, id: randomUUID(), scope: Object.freeze({ ...next.scope }) });
    this.active = { token, references: 1, invalidated: false };
    next.resolve(this.makeLease(token, next.signal));
  }
}

export interface ProjectExecutionContext {
  owner: ProjectExecutionOwner;
  resources: ProjectResourceCoordinator;
  scope: ProjectExecutionScope;
  signal?: AbortSignal;
  token?: ProjectResourceToken;
  admission?: ProjectRequestAdmission;
  requestRole?: ProjectRequestRole;
}

const executionContext = new AsyncLocalStorage<ProjectExecutionContext>();
let enforceContext = false;

/** Enabled once by the extension host, including legacy entry points. Unit
 * services remain independently usable before an extension host is constructed.
 */
export function configureProjectExecutionEnforcement(required: boolean): void { enforceContext = required; }
export function getProjectExecutionContext(): ProjectExecutionContext | undefined { return executionContext.getStore(); }
export function runProjectExecution<T>(context: ProjectExecutionContext, work: () => T): T {
  context.owner.assertOwner();
  if (context.owner.projectId !== context.resources.projectId) throw new Error('Project owner/resource scope mismatch.');
  validateScope(context.scope);
  const release = context.owner.beginOperation();
  try {
    const result = executionContext.run({ ...context, scope: Object.freeze({ ...context.scope }) }, work);
    if (result && typeof result === 'object' && 'then' in result && typeof result.then === 'function') {
      return Promise.resolve(result).finally(release) as T;
    }
    release(); return result;
  } catch (error) { release(); throw error; }
}

export async function assertProjectExecutionOwner(): Promise<void> {
  const context = executionContext.getStore();
  if (!context) {
    if (enforceContext) throw new Error('Missing project execution owner. / 缺少项目执行所有权。');
    return;
  }
  if (context.signal?.aborted) throw aborted();
  if (context.resources.isScopeInvalidated(context.scope)) throw new Error('Project execution segment was invalidated. / 执行段已失效。');
  await context.owner.verify();
}

export async function assertProjectMutationLease(): Promise<void> {
  await assertProjectExecutionOwner();
  const context = executionContext.getStore();
  if (!context) return;
  if (!context.token) throw new Error('Project mutation requires its resource lease. / 项目修改缺少资源租约。');
  context.resources.verifyToken(context.token, context.scope);
}

export function markProjectOperationUncertain(operationId: string): void {
  const context = executionContext.getStore();
  context?.owner.markUncertainOperation(operationId);
  context?.resources.blockUncertain(operationId);
}

/** Use only around bounded dispatch/Apply/validation, never around approval,
 * user input, another worker, Router or child completion waits. The caller may
 * group related mutations and validation using this same reentrant phase.
 */
export async function withProjectMutationPhase<T>(work: (lease?: ProjectResourceLease) => Promise<T>, signal?: AbortSignal): Promise<T> {
  await assertProjectExecutionOwner();
  const context = executionContext.getStore();
  if (!context) return work();
  const combinedSignal = signal && context.signal && signal !== context.signal
    ? AbortSignal.any([signal, context.signal]) : signal ?? context.signal;
  return context.resources.withLease(context.scope, async (lease) => {
    const release = context.owner.beginOperation();
    try {
    await context.owner.verify();
    lease.assertValid();
    return await executionContext.run({ ...context, signal: combinedSignal, token: lease.token }, () => work(lease));
    } finally { release(); }
  }, { signal: combinedSignal, token: context.token });
}

function validateScope(scope: ProjectExecutionScope): void {
  if (![scope.sessionId, scope.rootTaskId, scope.segmentId, scope.runtimeId].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new Error('Project execution requires complete session/root/segment/runtime identity.');
  }
}
function sameScope(a: Readonly<ProjectExecutionScope>, b: Readonly<ProjectExecutionScope>): boolean {
  return a.sessionId === b.sessionId && a.rootTaskId === b.rootTaskId && a.segmentId === b.segmentId && a.runtimeId === b.runtimeId;
}
function scopeKey(scope: Readonly<ProjectExecutionScope>): string { return JSON.stringify([scope.sessionId, scope.rootTaskId, scope.segmentId, scope.runtimeId]); }
function aborted(): Error { const error = new Error('Project operation cancelled. / 项目操作已取消。'); error.name = 'AbortError'; return error; }
