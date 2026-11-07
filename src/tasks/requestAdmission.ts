import { assertProjectExecutionOwner, getProjectExecutionContext, runProjectExecution } from './projectResources';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

export type ProjectRequestRole = 'router' | 'worker' | 'child' | 'reviewer' | 'summary' | 'title';
export interface RequestAdmissionIdentity {
  /** Canonical account/endpoint key, never a credential or wire model alias. */
  sourceKey: string;
  role: ProjectRequestRole;
  signal?: AbortSignal;
}
export interface AdmissionPermit { release(): void }
export interface ProjectChildAdmissionInput { depth: number; proposal: boolean; signal?: AbortSignal }
export const PROJECT_CHILD_ROOT_CONCURRENCY = 3;
export const PROJECT_CHILD_NESTED_CONCURRENCY = 1;
export const PROJECT_CHILD_PROPOSAL_CONCURRENCY = 2;
interface Entry { resolve: (permit: AdmissionPermit) => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void; priority: number; sequence: number }

class PermitPool {
  private active = 0;
  private sequence = 0;
  private priorityBurst = 0;
  private readonly queue: Entry[] = [];
  public constructor(private readonly limit: number) {}
  public get occupied(): number { return this.active; }
  public get waiting(): number { return this.queue.length; }
  public acquire(signal?: AbortSignal, priority = 0): Promise<AdmissionPermit> {
    if (signal?.aborted) return Promise.reject(aborted());
    return new Promise((resolve, reject) => {
      const entry: Entry = { resolve, reject, signal, priority, sequence: this.sequence++ };
      entry.abort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(aborted());
      };
      signal?.addEventListener('abort', entry.abort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }
  private pump(): void {
    // Bounded Router preference: after two priority entries, FIFO gives an older
    // worker its turn. Source concurrency is never exceeded.
    while (this.active < this.limit && this.queue.length > 0) {
      this.queue.sort((a, b) => (this.priorityBurst < 2 ? b.priority - a.priority : 0) || a.sequence - b.sequence);
      const next = this.queue.shift()!;
      this.priorityBurst = next.priority > 0 ? this.priorityBurst + 1 : 0;
      next.signal?.removeEventListener('abort', next.abort!);
      if (next.signal?.aborted) { next.reject(aborted()); continue; }
      this.active += 1;
      let released = false;
      next.resolve({ release: () => { if (released) return; released = true; this.active -= 1; this.pump(); } });
    }
  }
}

/** Logical roots, child scheduling and actual source requests use distinct pools.
 * Only hold a source permit while transport is actually in flight, including
 * reading its response body, not during a tool/child/manual approval wait.
 */
export class ProjectRequestAdmission {
  private readonly roots: PermitPool;
  private readonly sources = new Map<string, PermitPool>();
  private readonly sourceLimit: number;
  private readonly globalRequests: PermitPool;
  private readonly childRoots: PermitPool;
  private readonly childNested: PermitPool;
  private readonly childProposals: PermitPool;
  public constructor(options: { rootConcurrency?: number; sourceConcurrency?: number; requestConcurrency?: number;
    childRootConcurrency?: number; childNestedConcurrency?: number; childProposalConcurrency?: number } = {}) {
    this.roots = new PermitPool(positive(options.rootConcurrency ?? 2));
    this.sourceLimit = positive(options.sourceConcurrency ?? 4);
    this.globalRequests = new PermitPool(positive(options.requestConcurrency ?? 8));
    this.childRoots = new PermitPool(positive(options.childRootConcurrency ?? PROJECT_CHILD_ROOT_CONCURRENCY));
    this.childNested = new PermitPool(positive(options.childNestedConcurrency ?? PROJECT_CHILD_NESTED_CONCURRENCY));
    this.childProposals = new PermitPool(positive(options.childProposalConcurrency ?? PROJECT_CHILD_PROPOSAL_CONCURRENCY));
  }
  public acquireRoot(signal?: AbortSignal): Promise<AdmissionPermit> { return this.roots.acquire(signal); }
  public async acquireChild(input: ProjectChildAdmissionInput): Promise<AdmissionPermit> {
    if (!Number.isSafeInteger(input.depth) || input.depth < 1 || input.depth > 2) throw new Error('Project child depth must be 1 or 2.');
    await assertProjectExecutionOwner();
    const depth = await (input.depth === 1 ? this.childRoots : this.childNested).acquire(input.signal);
    let proposal: AdmissionPermit | undefined;
    try {
      proposal = input.proposal ? await this.childProposals.acquire(input.signal) : undefined;
      await assertProjectExecutionOwner();
      if (input.signal?.aborted) throw aborted();
    } catch (error) { proposal?.release(); depth.release(); throw error; }
    let released = false;
    return { release: () => { if (released) return; released = true; proposal?.release(); depth.release(); } };
  }
  public async acquireRequest(identity: RequestAdmissionIdentity): Promise<AdmissionPermit> {
    if (!identity.sourceKey.trim()) throw new Error('Request admission requires a canonical source key.');
    await assertProjectExecutionOwner();
    let source = this.sources.get(identity.sourceKey);
    if (!source) { source = new PermitPool(this.sourceLimit); this.sources.set(identity.sourceKey, source); }
    // Fixed ordering everywhere: source then global. Neither is held while
    // waiting for any task, workspace lease or child to finish.
    const sourcePermit = await source.acquire(identity.signal, identity.role === 'router' ? 1 : 0);
    let globalPermit: AdmissionPermit;
    try { globalPermit = await this.globalRequests.acquire(identity.signal, identity.role === 'router' ? 1 : 0); }
    catch (error) { sourcePermit.release(); throw error; }
    try { await assertProjectExecutionOwner(); }
    catch (error) { globalPermit.release(); sourcePermit.release(); throw error; }
    let released = false;
    return { release: () => { if (released) return; released = true; globalPermit.release(); sourcePermit.release(); } };
  }
  public async withRequest<T>(identity: RequestAdmissionIdentity, work: () => Promise<T>): Promise<T> {
    const permit = await this.acquireRequest(identity);
    try { return await work(); } finally { permit.release(); }
  }
  public snapshot(): { roots: number; rootWaiting: number; requests: number; requestWaiting: number; sources: Record<string, { active: number; waiting: number }>;
    children: { rootActive: number; rootWaiting: number; nestedActive: number; nestedWaiting: number; proposalActive: number; proposalWaiting: number } } {
    return { roots: this.roots.occupied, rootWaiting: this.roots.waiting, requests: this.globalRequests.occupied, requestWaiting: this.globalRequests.waiting,
      children: { rootActive: this.childRoots.occupied, rootWaiting: this.childRoots.waiting, nestedActive: this.childNested.occupied,
        nestedWaiting: this.childNested.waiting, proposalActive: this.childProposals.occupied, proposalWaiting: this.childProposals.waiting },
      sources: Object.fromEntries([...this.sources].map(([key, pool]) => [key, { active: pool.occupied, waiting: pool.waiting }])) };
  }
}

const projectAdmissions = new Map<string, ProjectRequestAdmission>();
const childExecution = new AsyncLocalStorage<ProjectChildLease>();

/** One project authority shared by every Worker and its legacy/child paths. */
export function getProjectRequestAdmission(): ProjectRequestAdmission | undefined {
  const context = getProjectExecutionContext();
  if (!context) return undefined;
  let admission = context.admission ?? projectAdmissions.get(context.owner.projectId);
  if (!admission) { admission = new ProjectRequestAdmission(); projectAdmissions.set(context.owner.projectId, admission); }
  return admission;
}

class ProjectChildLease {
  private permit?: AdmissionPermit;
  private waiting = 0;
  private closed = false;
  public constructor(private readonly admission: ProjectRequestAdmission, private readonly input: ProjectChildAdmissionInput, permit: AdmissionPermit) {
    this.permit = permit;
  }
  public async withoutSlot<T>(work: () => Promise<T>): Promise<T> {
    this.waiting += 1;
    if (this.waiting === 1) { this.permit?.release(); this.permit = undefined; }
    try { return await work(); }
    finally {
      this.waiting -= 1;
      if (this.waiting === 0 && !this.closed && !this.input.signal?.aborted) this.permit = await this.admission.acquireChild(this.input);
    }
  }
  public release(): void { this.closed = true; this.permit?.release(); this.permit = undefined; }
}

/** Called by the actual scheduler. Per-tree budget/path state stays private to
 * its owning Runtime; only the project concurrency authority is shared.
 */
export async function runProjectChild<T>(input: ProjectChildAdmissionInput, task: () => Promise<T>): Promise<T> {
  const context = getProjectExecutionContext();
  const admission = getProjectRequestAdmission();
  if (!context || !admission) return task();
  if (context.token) throw new Error('A workspace mutation lease must be released before waiting for a child.');
  const signal = input.signal && context.signal && input.signal !== context.signal ? AbortSignal.any([input.signal, context.signal]) : input.signal ?? context.signal;
  const scopedInput = { ...input, signal };
  const permit = await admission.acquireChild(scopedInput);
  const lease = new ProjectChildLease(admission, scopedInput, permit);
  try {
    return await childExecution.run(lease, () => runProjectExecution({ ...context, signal, requestRole: 'child' }, task));
  } finally { lease.release(); }
}

/** A parent waiting for nested work or a live result does not consume a slot
 * needed by that work. Reacquire before its model/tool loop can resume.
 */
export async function withoutProjectChildSlot<T>(work: () => Promise<T>): Promise<T> {
  if (getProjectExecutionContext()?.token) throw new Error('A workspace mutation lease must be released before waiting for a child.');
  const lease = childExecution.getStore();
  return lease ? lease.withoutSlot(work) : work();
}

/** Transport-level gate covering exactly one physical HTTP attempt and all body
 * reads. Retries re-enter independently; backoff does not occupy a permit.
 * Endpoint origin grouping is deliberately conservative across account aliases.
 */
export async function withProjectProviderRequest<T>(endpoint: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  await assertProjectExecutionOwner();
  const context = getProjectExecutionContext();
  if (!context) return work();
  const admission = getProjectRequestAdmission()!;
  const combinedSignal = signal && context.signal && signal !== context.signal
    ? AbortSignal.any([signal, context.signal]) : signal ?? context.signal;
  const sourceKey = createHash('sha256').update(new URL(endpoint).origin).digest('hex');
  return admission.withRequest({ sourceKey, role: context.requestRole ?? 'worker', signal: combinedSignal }, async () => {
    const release = context.owner.beginOperation();
    try { return await work(); } finally { release(); }
  });
}

function positive(value: number): number { if (!Number.isSafeInteger(value) || value < 1) throw new Error('Admission concurrency must be a positive integer.'); return value; }
function aborted(): Error { const error = new Error('Request admission cancelled.'); error.name = 'AbortError'; return error; }
