import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { writeJsonAtomic } from '../shared/atomicStorage';
import { TaskRuntime, type TaskExecutionDriver, type TaskExecutionIdentity, type TaskExecutionResult } from './taskRuntime';

export type ProjectTaskState = 'queued' | 'preparing' | 'running' | 'waiting' | 'settling' | 'completed' | 'failed' | 'cancelled' | 'stopping' | 'interrupted';
export type TaskInputKind = 'new' | 'followup' | 'supplement' | 'continue';
export type TaskInputState = 'received' | 'durable' | 'queued' | 'incorporated' | 'settled' | 'failed' | 'cancelled';

/** Host metadata, never serialized into a Provider prefix. No credentials. */
export interface TaskDefaultsSnapshot {
  sourceId?: string;
  modelId: string;
  wireModel?: string;
  endpoint?: string;
  protocol?: string;
  rootUri?: string;
  cwdUri?: string;
  approvalMode: 'ask' | 'delegate';
  executionMode: 'normal' | 'plan';
  skillIds: string[];
  configuration?: Record<string, unknown>;
}

export interface TaskInput {
  version: 1;
  inputId: string;
  requestId: string;
  taskCardId: string;
  sessionId: string;
  rootTaskId: string;
  kind: TaskInputKind;
  state: TaskInputState;
  content: string;
  replaceMessageId?: string;
  references: unknown[];
  skillIds: string[];
  fingerprint: string;
  createdAt: string;
  /** Immutable expansion intent, reused after a failed session commit. */
  preparedContent?: string;
  messageId?: string;
  incorporatedAt?: string;
  settledAt?: string;
  error?: string;
}

export interface ProjectTaskCard {
  version: 1;
  projectId: string;
  taskCardId: string;
  sessionId: string;
  rootTaskId: string;
  segmentId?: string;
  generation: number;
  revision: number;
  title: string;
  customTitle?: string;
  snapshot: TaskDefaultsSnapshot;
  state: ProjectTaskState;
  waitingReason?: string;
  progress?: string;
  error?: string;
  sessionCreated: boolean;
  associationRequestId?: string;
  dependencies: string[];
  inputIds: string[];
  resultEventId?: string;
  createdAt: string;
  updatedAt: string;
  archived: boolean;
  usedMs: number;
  costByCurrency: Record<string, number>;
  usageIncomplete: boolean;
}

export interface TaskResultEvent {
  version: 1;
  eventId: string;
  taskCardId: string;
  sessionId: string;
  rootTaskId: string;
  segmentId: string;
  state: ProjectTaskState;
  content: string;
  resultMessageId?: string;
  createdAt: string;
  /** Consumption is committed with the bytes of a real Router user input. */
  consumedByInputId?: string;
}

interface TaskRegistry {
  version: 1;
  projectId: string;
  revision: number;
  cards: ProjectTaskCard[];
  inputs: TaskInput[];
  events: TaskResultEvent[];
}

interface TaskObjectRef { hash: string; bytes: number }
type StoredTaskInput = Omit<TaskInput, 'content' | 'references' | 'skillIds' | 'preparedContent'> & { bodyRef: TaskObjectRef; preparedRef?: TaskObjectRef };
type StoredTaskResult = Omit<TaskResultEvent, 'content'> & { bodyRef: TaskObjectRef };
interface TaskRegistryV2 extends Omit<TaskRegistry, 'version' | 'inputs' | 'events'> {
  version: 2;
  inputs: StoredTaskInput[];
  events: StoredTaskResult[];
}
interface TaskObject {
  version: 1;
  projectId: string;
  kind: 'input-body' | 'prepared-input' | 'result-body';
  id: string;
  content: string;
  references?: unknown[];
  skillIds?: string[];
  messageId?: string;
}

export interface NewTaskInput {
  requestId: string;
  content: string;
  replaceMessageId?: string;
  references?: unknown[];
  skillIds?: string[];
}
export interface CreateProjectTask extends NewTaskInput {
  snapshot: TaskDefaultsSnapshot;
  title?: string;
  dependencies?: string[];
  /** Explicitly associate an existing session; no history is copied. */
  sessionId?: string;
}
export interface SubmitTaskInput extends NewTaskInput {
  kind: Exclude<TaskInputKind, 'new'>;
  rootTaskId?: string;
}
export interface DurableTaskReceipt { card: ProjectTaskCard; input: TaskInput; duplicate: boolean }
export interface ProjectTaskServiceOptions {
  storageUri: vscode.Uri;
  projectId: string;
  maxWorkers?: number;
  /** Dedicated Router sessions queue distinct real user turns; Workers still
   * require explicit same-root supplement while they are active. */
  allowQueuedFollowups?: boolean;
  /** Only dedicated Router rounds may settle their own error and advance to
   * the next real user turn. Dispatched Workers remain independent. */
  settleFailedInputs?: boolean;
  /** Must idempotently create/load precisely the supplied sessionId. */
  createSession(snapshot: TaskDefaultsSnapshot, sessionId: string): Promise<void>;
  driverFactory(card: Readonly<ProjectTaskCard>): TaskExecutionDriver;
  /** Enforced before every mutation/admission, including old execution entry points. */
  assertExecutionOwner?(): Promise<void> | void;
  onChange?(cards: readonly ProjectTaskCard[]): void;
  /** Storage adapter for deterministic failure injection. Production uses the
   * shared durable atomic writer; objects always commit before the manifest. */
  storageWrite?(uri: vscode.Uri, value: unknown): Promise<void>;
  now?(): string;
}

const ACTIVE = new Set<ProjectTaskState>(['preparing', 'running', 'settling', 'stopping']);
const UNFINISHED_INPUT = new Set<TaskInputState>(['received', 'durable', 'queued', 'incorporated']);
const TASK_STATES: readonly string[] = ['queued', 'preparing', 'running', 'waiting', 'settling', 'completed', 'failed', 'cancelled', 'stopping', 'interrupted'];
const INPUT_STATES: readonly string[] = ['received', 'durable', 'queued', 'incorporated', 'settled', 'failed', 'cancelled'];

/** Serialized, copy-on-write transactions: a failed save cannot acknowledge or
 * advance in-memory authority. The single atomic registry commits input/body,
 * result events and their indices together; session commits use prepareInput. */
export class ProjectTaskService {
  private registry: TaskRegistry;
  private serial: Promise<unknown> = Promise.resolve();
  private persistenceError?: unknown;
  private initialized = false;
  private readOnly = false;
  private disposed = false;
  private closing = false;
  private pumping = false;
  private reschedule = false;
  private readonly eligible = new Set<string>();
  private readonly runtimes = new Map<string, TaskRuntime>();
  private readonly inputBarriers = new Map<string, number>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly uri: vscode.Uri;
  private readonly maxWorkers: number;
  private readonly bodyRefs = new Map<string, TaskObjectRef>();
  private readonly preparedRefs = new Map<string, { content: string; messageId: string; ref: TaskObjectRef }>();
  private readonly resultRefs = new Map<string, TaskObjectRef>();
  private readonly knownObjects = new Set<string>();

  constructor(private readonly options: ProjectTaskServiceOptions) {
    if (!validId(options.projectId)) throw new Error('task_project_invalid');
    this.uri = vscode.Uri.joinPath(options.storageUri, 'project-tasks.json');
    this.maxWorkers = Math.max(1, Math.min(8, Math.floor(options.maxWorkers ?? 2)));
    this.registry = { version: 1, projectId: options.projectId, revision: 0, cards: [], inputs: [], events: [] };
  }

  async initialize(options: { readOnly?: boolean } = {}): Promise<void> {
    this.readOnly = options.readOnly === true;
    try {
      this.registry = await this.readRegistry();
    } catch (error) { if (!isMissing(error)) throw error; }
    this.initialized = true;
    // Saved running is an interrupted process, never an executable queue.
    const recover = (r: TaskRegistry) => {
      for (const card of r.cards) if (ACTIVE.has(card.state) || card.state === 'queued') {
        card.state = 'interrupted'; card.waitingReason = 'restart_requires_continue'; card.revision = incrementCounter(card.revision);
      }
    };
    if (!this.readOnly && this.registry.cards.some(card => ACTIVE.has(card.state) || card.state === 'queued')) await this.transaction(recover);
    this.publish();
  }

  /** Observer refresh does not perform recovery, migration or any write. A
   * running record in another window describes its live owner, not this view. */
  async reload(): Promise<boolean> {
    if (!this.initialized) throw new Error('task_service_not_initialized');
    if (!this.readOnly) throw new Error('task_observer_reload_requires_read_only');
    const next = await this.readRegistry();
    if (next.revision <= this.registry.revision) return false;
    this.registry = next; this.publish(); return true;
  }

  list(): ProjectTaskCard[] { return clone(this.registry.cards); }
  get(taskCardId: string): ProjectTaskCard | undefined { return clone(this.registry.cards.find(card => card.taskCardId === taskCardId)); }
  inputs(taskCardId: string): TaskInput[] { return clone(this.registry.inputs.filter(input => input.taskCardId === taskCardId)); }
  findInputByRequestId(requestId: string): TaskInput | undefined { return clone(this.registry.inputs.find(input => input.requestId === requestId)); }
  events(options: { unconsumed?: boolean } = {}): TaskResultEvent[] {
    return clone(this.registry.events.filter(event => !options.unconsumed || !event.consumedByInputId));
  }
  get activeCount(): number { return this.runtimes.size; }

  async createTask(value: CreateProjectTask): Promise<DurableTaskReceipt> {
    this.assertAccepting();
    validateInput(value);
    if (value.replaceMessageId) throw new Error('task_edit_requires_existing_session');
    validateSnapshot(value.snapshot);
    if (value.title !== undefined && !validText(value.title, 4096)) throw new Error('task_title_invalid');
    if (value.dependencies !== undefined && (!Array.isArray(value.dependencies) || value.dependencies.length > 100_000 || value.dependencies.some(id => !validId(id)))) throw new Error('task_dependencies_invalid');
    const fingerprint = digest({ content: value.content, references: value.references ?? [], skillIds: value.skillIds ?? [], snapshot: value.snapshot, sessionId: value.sessionId, dependencies: value.dependencies ?? [] });
    let duplicate = false;
    let inputId = '';
    let cardId = '';
    await this.transaction(r => {
      const existing = r.inputs.find(input => input.requestId === value.requestId);
      if (r.cards.some(card => card.associationRequestId === value.requestId)) throw new Error('task_request_id_conflict');
      if (existing) {
        if (existing.fingerprint !== fingerprint || existing.kind !== 'new') throw new Error('task_request_id_conflict');
        inputId = existing.inputId; cardId = existing.taskCardId; duplicate = true; return;
      }
      if (value.sessionId && r.cards.some(card => card.sessionId === value.sessionId)) throw new Error('task_session_already_associated');
      const dependencies = [...new Set(value.dependencies ?? [])];
      for (const dependency of dependencies) this.requireCard(r, dependency);
      const now = this.now();
      const sessionId = value.sessionId ?? randomUUID();
      cardId = randomUUID(); inputId = randomUUID();
      const rootTaskId = randomUUID();
      r.cards.push({ version: 1, projectId: r.projectId, taskCardId: cardId, sessionId, rootTaskId,
        generation: 0, revision: 1, title: value.title?.trim() || temporaryTitle(value.content), snapshot: clone(value.snapshot),
        state: 'queued', sessionCreated: false, dependencies, inputIds: [inputId], createdAt: now, updatedAt: now,
        archived: false, usedMs: 0, costByCurrency: {}, usageIncomplete: false });
      r.inputs.push({ version: 1, inputId, requestId: value.requestId, taskCardId: cardId, sessionId, rootTaskId,
        kind: 'new', state: 'durable', content: value.content, references: clone(value.references ?? []),
        skillIds: [...(value.skillIds ?? value.snapshot.skillIds)], fingerprint, createdAt: now });
    });
    const card = this.get(cardId)!;
    if (!card.sessionCreated) {
      // The persisted deterministic ID is the recovery intent. A crash here
      // retries creation of the same session, never another Worker session.
      await this.options.createSession(clone(card.snapshot), card.sessionId);
      await this.transaction(r => { this.requireCard(r, cardId).sessionCreated = true; });
    }
    // A retransmitted ACK probe is not explicit restart consent. Saved
    // interrupted work remains visible until resume/Continue is requested.
    if (!duplicate || this.get(cardId)!.state === 'queued') {
      this.eligible.add(cardId); this.schedule();
    }
    return { card: this.get(cardId)!, input: clone(this.registry.inputs.find(input => input.inputId === inputId)!), duplicate };
  }

  async submitInput(taskCardId: string, value: SubmitTaskInput): Promise<DurableTaskReceipt> {
    this.assertAccepting();
    validateInput(value, value.kind === 'continue');
    if (value.replaceMessageId && value.kind !== 'followup') throw new Error('task_edit_requires_idle_followup');
    if (value.kind === 'supplement') this.inputBarriers.set(taskCardId, (this.inputBarriers.get(taskCardId) ?? 0) + 1);
    try {
      const fingerprint = digest({ taskCardId, content: value.content, references: value.references ?? [], skillIds: value.skillIds ?? [], kind: value.kind,
        rootTaskId: value.kind === 'followup' ? undefined : value.rootTaskId, replaceMessageId: value.replaceMessageId });
      let inputId = '';
      let duplicate = false;
      await this.transaction(r => {
        const card = this.requireCard(r, taskCardId);
        const existing = r.inputs.find(input => input.requestId === value.requestId);
        if (r.cards.some(item => item.associationRequestId === value.requestId)) throw new Error('task_request_id_conflict');
        if (existing) {
          if (existing.fingerprint !== fingerprint) throw new Error('task_request_id_conflict');
          inputId = existing.inputId; duplicate = true; return;
        }
        if (card.state === 'stopping') throw new Error('task_stopping');
        if (card.archived) throw new Error('task_archived');
        const running = this.runtimes.has(taskCardId) || card.state === 'queued' || card.state === 'waiting';
        const queuedRouterTurn = value.kind === 'followup' && this.options.allowQueuedFollowups === true && card.snapshot.configuration?.role === 'router';
        if (value.kind === 'supplement' && (!running || !['preparing', 'running', 'waiting', 'queued', 'settling'].includes(card.state) || !value.rootTaskId || value.rootTaskId !== card.rootTaskId)) throw new Error('task_supplement_root_expired');
        if (value.kind === 'followup' && running && !queuedRouterTurn) throw new Error('task_running_requires_supplement');
        if (value.kind === 'continue' && !['interrupted', 'cancelled', 'waiting', 'failed'].includes(card.state)) throw new Error('task_not_resumable');
        if (value.rootTaskId && value.kind !== 'followup' && value.rootTaskId !== card.rootTaskId) throw new Error('task_root_mismatch');
        const inputRootTaskId = value.kind === 'followup' ? randomUUID() : card.rootTaskId;
        // A queued Router round has a fresh root, but cannot replace the live
        // root used to validate callbacks from the currently running round.
        if (value.kind === 'followup' && !running) card.rootTaskId = inputRootTaskId;
        // A returned waiting segment is already durable and has no live writer.
        // Its real user input has been incorporated once; a supplement begins a
        // new segment, rather than replaying the old pending operation first.
        if (value.kind === 'supplement' && card.state === 'waiting' && !this.runtimes.has(taskCardId)) {
          for (const previous of r.inputs) if (previous.taskCardId === taskCardId && previous.rootTaskId === card.rootTaskId && previous.state === 'incorporated') {
            previous.state = 'settled'; previous.settledAt = this.now();
          }
        }
        inputId = randomUUID();
        r.inputs.push({ version: 1, inputId, requestId: value.requestId, taskCardId, sessionId: card.sessionId,
          rootTaskId: inputRootTaskId, kind: value.kind, state: 'durable', content: value.content,
          ...(value.replaceMessageId ? { replaceMessageId: value.replaceMessageId } : {}),
          references: clone(value.references ?? []), skillIds: [...(value.skillIds ?? card.snapshot.skillIds)], fingerprint, createdAt: this.now() });
        card.inputIds.push(inputId);
        if (!this.runtimes.has(taskCardId)) card.state = 'queued';
        card.error = undefined; card.waitingReason = undefined; this.touch(card);
      });
      const accepted = this.registry.inputs.find(input => input.inputId === inputId)!;
      if (value.kind === 'supplement' && UNFINISHED_INPUT.has(accepted.state) && (!duplicate || this.get(taskCardId)!.state !== 'interrupted')) {
        const live = this.runtimes.get(taskCardId);
        if (live) await live.supplement(this.currentExecutionIdentity(live));
        else {
          const card = this.get(taskCardId)!;
          const driver = this.options.driverFactory(card);
          const identity: TaskExecutionIdentity = { projectId: card.projectId, taskCardId, sessionId: card.sessionId,
            rootTaskId: card.rootTaskId, segmentId: card.segmentId ?? randomUUID(), generation: card.generation };
          // The cached Worker still owns its waiting approvals even when its
          // model slot is released. Revoke them before acknowledging new input.
          await driver.revokePendingActions?.(identity, 'supplement');
          await driver.requestBoundary?.(identity);
        }
      }
      if (!duplicate || this.get(taskCardId)!.state === 'queued') this.eligible.add(taskCardId);
      return { card: this.get(taskCardId)!, input: clone(this.registry.inputs.find(input => input.inputId === inputId)!), duplicate };
    } finally {
      if (value.kind === 'supplement') {
        const count = (this.inputBarriers.get(taskCardId) ?? 1) - 1;
        if (count) this.inputBarriers.set(taskCardId, count); else this.inputBarriers.delete(taskCardId);
      }
      this.wakeIdle(); this.schedule();
    }
  }

  /** Metadata-only association. The caller verifies that the existing session
   * belongs to this project. It never creates a user message or starts a run. */
  async associateSession(value: { requestId: string; sessionId: string; snapshot: TaskDefaultsSnapshot; title: string; rootTaskId?: string }): Promise<ProjectTaskCard> {
    this.assertAccepting();
    validateSnapshot(value.snapshot);
    if (!validId(value.requestId) || !validId(value.sessionId) || value.rootTaskId !== undefined && !validId(value.rootTaskId)) throw new Error('task_association_identity_required');
    if (!validText(value.title, 4096)) throw new Error('task_title_invalid');
    let cardId = '';
    await this.transaction(r => {
      if (r.inputs.some(input => input.requestId === value.requestId)) throw new Error('task_request_id_conflict');
      const previousRequest = r.cards.find(card => card.associationRequestId === value.requestId);
      if (previousRequest && previousRequest.sessionId !== value.sessionId) throw new Error('task_request_id_conflict');
      const existing = r.cards.find(card => card.sessionId === value.sessionId);
      if (existing) { cardId = existing.taskCardId; return; }
      cardId = randomUUID(); const now = this.now();
      r.cards.push({ version: 1, projectId: r.projectId, taskCardId: cardId, sessionId: value.sessionId,
        rootTaskId: value.rootTaskId ?? randomUUID(), generation: 0, revision: 1, title: value.title.trim() || 'Task',
        snapshot: clone(value.snapshot), state: 'completed', sessionCreated: true, associationRequestId: value.requestId,
        dependencies: [], inputIds: [], createdAt: now, updatedAt: now, archived: false, usedMs: 0,
        costByCurrency: {}, usageIncomplete: true });
    });
    return this.get(cardId)!;
  }

  /** Explicit restart continuation; no old callback/permit/process is revived. */
  async resume(taskCardId: string): Promise<void> {
    this.assertAccepting();
    await this.transaction(r => {
      const card = this.requireCard(r, taskCardId);
      if (this.runtimes.has(taskCardId) || !['interrupted', 'waiting', 'failed', 'cancelled'].includes(card.state)) throw new Error('task_not_resumable');
      if (!r.inputs.some(input => input.taskCardId === taskCardId && UNFINISHED_INPUT.has(input.state))) {
        const failed = r.inputs.find(input => input.taskCardId === taskCardId && input.rootTaskId === card.rootTaskId && input.state === 'failed');
        if (failed) { failed.state = 'durable'; failed.error = undefined; }
        else {
          const inputId = randomUUID(); const requestId = `continue:${randomUUID()}`;
          r.inputs.push({ version: 1, inputId, requestId, taskCardId, sessionId: card.sessionId, rootTaskId: card.rootTaskId,
            kind: 'continue', state: 'durable', content: '', references: [], skillIds: [...card.snapshot.skillIds],
            fingerprint: digest({ taskCardId, requestId, kind: 'continue' }), createdAt: this.now() });
          card.inputIds.push(inputId);
        }
      }
      card.state = 'queued'; card.waitingReason = undefined; card.error = undefined; this.touch(card);
    });
    const card = this.get(taskCardId)!;
    if (!card.sessionCreated) {
      await this.options.createSession(card.snapshot, card.sessionId);
      await this.transaction(r => { this.requireCard(r, taskCardId).sessionCreated = true; });
    }
    this.eligible.add(taskCardId); this.schedule();
  }

  async stop(taskCardId: string): Promise<void> {
    let stoppedRuntime: TaskRuntime | undefined;
    let before!: ProjectTaskCard;
    await this.transaction(r => {
      const card = this.requireCard(r, taskCardId);
      before = clone(card);
      // Linearize against admission under the same serialized transaction.
      // A pre-await runtime snapshot could miss a newly reserved container.
      stoppedRuntime = this.runtimes.get(taskCardId);
      this.eligible.delete(taskCardId);
      card.state = stoppedRuntime ? 'stopping' : 'cancelled'; card.waitingReason = undefined;
      for (const input of r.inputs) if (input.taskCardId === taskCardId && ['received', 'durable', 'queued'].includes(input.state)) {
        input.state = 'cancelled'; input.error = 'user_stopped'; input.settledAt = this.now();
      }
      this.touch(card);
    });
    const current = this.runtimes.get(taskCardId);
    if (stoppedRuntime && current === stoppedRuntime) await stoppedRuntime.stop(this.currentExecutionIdentity(stoppedRuntime));
    else if (!stoppedRuntime && !current && this.get(taskCardId)?.rootTaskId === before.rootTaskId && ['waiting', 'interrupted', 'stopping'].includes(before.state)) {
      // A waiting manual request belongs to the cached Worker even after its
      // logical model slot is released. Stopping the card revokes that queue.
      const driver = this.options.driverFactory(before);
      await driver.revokePendingActions?.({ projectId: before.projectId, taskCardId, sessionId: before.sessionId,
        rootTaskId: before.rootTaskId, segmentId: before.segmentId ?? randomUUID(), generation: before.generation }, 'stop');
    }
  }
  async stopAll(): Promise<void> { await Promise.all(this.list().filter(card => !['completed', 'cancelled'].includes(card.state)).map(card => this.stop(card.taskCardId))); }

  async setDependencies(taskCardId: string, dependencies: string[]): Promise<void> {
    if (!Array.isArray(dependencies) || dependencies.length > 100_000 || dependencies.some(id => !validId(id))) throw new Error('task_dependencies_invalid');
    await this.transaction(r => {
      const card = this.requireCard(r, taskCardId);
      if (this.runtimes.has(taskCardId)) throw new Error('task_dependency_change_during_execution');
      const ids = [...new Set(dependencies)];
      for (const id of ids) this.requireCard(r, id);
      card.dependencies = ids;
      validateDependencies(new Map(r.cards.map(item => [item.taskCardId, item]))); this.touch(card);
    });
    this.schedule();
  }

  async markDependentsStale(taskCardId: string): Promise<void> {
    await this.transaction(r => {
      this.requireCard(r, taskCardId);
      for (const card of r.cards) if (card.dependencies.includes(taskCardId)) {
        card.waitingReason = 'dependency_requires_review';
        if (!this.runtimes.has(card.taskCardId)) card.state = 'waiting';
        this.touch(card);
      }
    });
  }
  async rename(taskCardId: string, title: string, manual = true): Promise<void> {
    if (!validText(title, 4096, true)) throw new Error('task_title_empty');
    await this.transaction(r => {
      const card = this.requireCard(r, taskCardId);
      if (!manual && card.customTitle) return;
      card.title = title.trim(); if (manual) card.customTitle = card.title; this.touch(card);
    });
  }
  /** Host-only persistence for an explicit, already validated model/lane
   * change. It grants no permissions and does not change root or budgets. The
   * Router tool contract deliberately exposes no snapshot-setting operation. */
  async updateSnapshot(taskCardId: string, snapshot: TaskDefaultsSnapshot): Promise<void> {
    validateSnapshot(snapshot);
    await this.transaction(r => {
      const card = this.requireCard(r, taskCardId);
      card.snapshot = clone(snapshot); this.touch(card);
    });
  }
  async archive(taskCardId: string, archived = true): Promise<void> {
    await this.transaction(r => { const card = this.requireCard(r, taskCardId); card.archived = archived; this.touch(card); });
  }
  async delete(taskCardId: string): Promise<void> {
    await this.stop(taskCardId);
    await this.whenIdle(taskCardId);
    await this.transaction(r => {
      if (r.cards.some(card => card.dependencies.includes(taskCardId))) throw new Error('task_has_dependents');
      r.cards = r.cards.filter(card => card.taskCardId !== taskCardId);
      r.inputs = r.inputs.filter(input => input.taskCardId !== taskCardId);
      r.events = r.events.filter(event => event.taskCardId !== taskCardId);
    });
  }

  /** Called only after the Router real user message and its event-tail bytes
   * are durable. Replays require the same inputId, never a synthesized user. */
  async consumeEvents(eventIds: readonly string[], inputId: string): Promise<void> {
    if (!inputId) throw new Error('task_event_input_required');
    await this.transaction(r => {
      for (const eventId of eventIds) {
        const event = r.events.find(item => item.eventId === eventId);
        if (!event) throw new Error('task_event_missing');
        if (event.consumedByInputId && event.consumedByInputId !== inputId) throw new Error('task_event_already_consumed');
        event.consumedByInputId = inputId;
      }
    });
  }

  async flush(): Promise<void> { await this.serial; if (this.persistenceError) throw this.persistenceError; }
  async whenIdle(taskCardId?: string): Promise<void> {
    while (taskCardId ? this.runtimes.has(taskCardId) || this.inputBarriers.has(taskCardId) : this.runtimes.size > 0 || this.pumping || this.inputBarriers.size > 0) {
      await new Promise<void>(resolve => { this.idleWaiters.add(resolve); });
    }
    await this.flush();
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.closing = true; this.eligible.clear();
    await Promise.all([...this.runtimes.values()].map(runtime => runtime.stop(this.currentExecutionIdentity(runtime))));
    await this.whenIdle();
    this.disposed = true;
  }

  private schedule(): void {
    if (this.disposed || this.closing || this.readOnly) return;
    if (this.pumping) { this.reschedule = true; return; }
    this.pumping = true;
    void this.pump().catch(error => {
      try { this.options.onChange?.(this.list().map(card => ({ ...card, error: card.error ?? errorText(error) }))); }
      catch { /* A detached view cannot cancel or acknowledge execution. */ }
    })
      .finally(() => { this.pumping = false; this.wakeIdle(); if (this.reschedule) { this.reschedule = false; this.schedule(); } });
  }
  private async pump(): Promise<void> {
    while (!this.disposed && !this.closing && this.runtimes.size < this.maxWorkers) {
      const card = this.registry.cards.find(item => this.eligible.has(item.taskCardId) && item.sessionCreated
        && !this.runtimes.has(item.taskCardId) && !this.inputBarriers.has(item.taskCardId) && !item.archived
        && this.registry.inputs.some(input => input.taskCardId === item.taskCardId && UNFINISHED_INPUT.has(input.state)));
      if (!card) break;
      const blocked = card.dependencies.find(id => this.registry.cards.find(item => item.taskCardId === id)?.state !== 'completed');
      if (blocked || card.waitingReason === 'dependency_requires_review') {
        this.eligible.delete(card.taskCardId);
        await this.transaction(r => { const target = this.requireCard(r, card.taskCardId); target.state = 'waiting'; target.waitingReason = card.waitingReason ?? `dependency:${blocked}`; this.touch(target); });
        continue;
      }
      const input = this.registry.inputs.find(item => item.taskCardId === card.taskCardId && UNFINISHED_INPUT.has(item.state))!;
      const recovering = input.kind === 'continue' || input.state === 'incorporated' || input.preparedContent !== undefined;
      const identity: TaskExecutionIdentity = { projectId: card.projectId, taskCardId: card.taskCardId, sessionId: card.sessionId,
        rootTaskId: input.rootTaskId, segmentId: recovering && card.segmentId ? card.segmentId : randomUUID(), generation: incrementCounter(card.generation) };
      await this.options.assertExecutionOwner?.();
      const runtime = new TaskRuntime(Object.freeze(identity), this.options.driverFactory(clone(card)));
      this.runtimes.set(card.taskCardId, runtime);
      try {
        await this.transaction(r => {
          const target = this.requireCard(r, card.taskCardId);
          const current = r.inputs.find(item => item.inputId === input.inputId);
          if (!current || !UNFINISHED_INPUT.has(current.state) || !this.eligible.has(card.taskCardId)
            || this.inputBarriers.has(card.taskCardId) || ['stopping', 'cancelled', 'interrupted', 'failed'].includes(target.state)
            || target.archived || runtime.controller.signal.aborted) throw new Error('task_admission_superseded');
          target.rootTaskId = input.rootTaskId; target.state = 'preparing'; target.error = undefined;
          target.segmentId = identity.segmentId; target.generation = identity.generation; this.touch(target);
          if (current.state !== 'incorporated') current.state = 'queued';
        });
      } catch (error) {
        if (this.runtimes.get(card.taskCardId) === runtime) this.runtimes.delete(card.taskCardId);
        await runtime.dispose();
        if (errorText(error) !== 'task_admission_superseded') throw error;
        if (this.get(card.taskCardId)?.state === 'stopping') await this.transaction(r => {
          const target = this.requireCard(r, card.taskCardId);
          if (target.state === 'stopping' && !this.runtimes.has(card.taskCardId)) { target.state = 'cancelled'; this.touch(target); }
        });
        this.wakeIdle(); continue;
      }
      void this.run(runtime, clone(input));
    }
  }
  private async run(runtime: TaskRuntime, input: TaskInput): Promise<void> {
    const identity = runtime.identity;
    try {
      const result = await runtime.execute({ card: this.get(identity.taskCardId)!, input,
        executionSegment: segmentId => {
          if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(segmentId)) return Promise.reject(new Error('task_execution_segment_invalid'));
          return this.executionTransaction(identity, (_r, card) => {
            if (!runtime.isExecuting || runtime.controller.signal.aborted || card.state === 'stopping') throw new Error('task_execution_identity_expired');
            card.segmentId = segmentId; this.touch(card);
          });
        },
        prepareInput: (content, messageId) => this.executionTransaction(identity, (r, _card) => {
          const target = r.inputs.find(item => item.inputId === input.inputId)!;
          if (target.preparedContent !== undefined && (target.preparedContent !== content || target.messageId !== messageId)) throw new Error('task_input_bytes_changed');
          target.preparedContent = content; target.messageId = messageId;
        }),
        incorporated: messageId => this.executionTransaction(identity, (r, card) => {
          const target = r.inputs.find(item => item.inputId === input.inputId)!;
          if (target.messageId !== messageId || target.preparedContent === undefined) throw new Error('task_input_not_prepared');
          target.state = 'incorporated'; target.incorporatedAt ??= this.now();
          if (card.state !== 'stopping') card.state = 'running'; this.touch(card);
        }),
        progress: text => this.executionTransaction(identity, (_r, card) => {
          card.progress = text.slice(0, 2000);
          if (card.state === 'waiting' && runtime.isExecuting && !runtime.controller.signal.aborted) { card.state = 'running'; card.waitingReason = undefined; }
          this.touch(card);
        }),
        waiting: reason => this.executionTransaction(identity, (_r, card) => { if (card.state !== 'stopping') card.state = 'waiting'; card.waitingReason = reason; this.touch(card); })
      });
      await this.executionTransaction(identity, (_r, card) => { if (card.state !== 'stopping') card.state = 'settling'; this.touch(card); });
      await this.finish(identity, input.inputId, result, runtime.controller.signal.aborted);
    } catch (error) {
      let advanceRouter = false;
      await this.executionTransaction(identity, (r, card) => {
        const target = r.inputs.find(item => item.inputId === input.inputId)!;
        // An incorporated input remains recoverable. Failure is not proof that
        // an Apply/command did not occur, and does not authorize a retry.
        target.error = errorText(error);
        const settleRouter = this.options.settleFailedInputs === true && card.snapshot.configuration?.role === 'router'
          && !runtime.controller.signal.aborted && !this.closing;
        if (settleRouter) {
          target.state = 'failed'; target.settledAt = this.now();
          advanceRouter = r.inputs.some(other => other.taskCardId === card.taskCardId && other.inputId !== input.inputId && UNFINISHED_INPUT.has(other.state));
          card.state = advanceRouter ? 'queued' : 'failed';
        } else {
          if (target.state !== 'incorporated' && !this.closing) target.state = runtime.controller.signal.aborted ? 'cancelled' : 'failed';
          card.state = runtime.controller.signal.aborted && !this.closing ? 'cancelled'
            : !this.closing && target.state === 'failed' ? 'failed' : 'interrupted';
        }
        card.error = errorText(error); this.touch(card);
      }).catch(() => { advanceRouter = false; }); // The last durable state stays interrupted on restart.
      if (advanceRouter) this.eligible.add(identity.taskCardId); else this.eligible.delete(identity.taskCardId);
    } finally {
      await runtime.dispose().catch(() => undefined);
      if (this.runtimes.get(identity.taskCardId) === runtime) this.runtimes.delete(identity.taskCardId);
      this.wakeIdle(); this.schedule();
    }
  }
  private async finish(identity: Readonly<TaskExecutionIdentity>, inputId: string, result: TaskExecutionResult, stopped: boolean): Promise<void> {
    if (result.usedMs !== undefined && !finiteNonnegative(result.usedMs)
      || result.costByCurrency !== undefined && !validCosts(result.costByCurrency)) throw new Error('task_accounting_invalid');
    await this.executionTransaction(identity, (r, card) => {
      const input = r.inputs.find(item => item.inputId === inputId)!;
      if (!result.waiting && !(stopped && this.closing)) { input.state = stopped ? 'cancelled' : 'settled'; input.settledAt = this.now(); }
      const usedMs = card.usedMs + (result.usedMs ?? 0);
      if (!finiteNonnegative(usedMs)) throw new Error('task_accounting_invalid');
      card.usedMs = usedMs;
      for (const [currency, cost] of Object.entries(result.costByCurrency ?? {})) {
        const total = (card.costByCurrency[currency] ?? 0) + cost;
        if (!finiteNonnegative(total)) throw new Error('task_accounting_invalid');
        card.costByCurrency[currency] = total;
      }
      card.usageIncomplete ||= result.usageIncomplete === true;
      const pending = r.inputs.some(item => item.taskCardId === card.taskCardId && item.inputId !== inputId && UNFINISHED_INPUT.has(item.state));
      card.state = stopped ? this.closing ? 'interrupted' : 'cancelled' : result.waiting ? 'waiting' : pending ? 'queued' : 'completed';
      card.waitingReason = result.waiting;
      // Results become visible in the same commit that settles the input.
      if (result.result !== undefined) {
        // Continue preserves the authoritative segment, but may turn a saved
        // proposal into a completed result. Identity includes the durable
        // result version so retry deduplicates without hiding later results.
        const segmentId = card.segmentId ?? identity.segmentId;
        const eventId = `${segmentId}:result:${digest({ content: result.result, messageId: result.resultMessageId, state: card.state }).slice(0, 24)}`;
        if (!r.events.some(event => event.eventId === eventId)) r.events.push({ version: 1, eventId,
          taskCardId: card.taskCardId, sessionId: card.sessionId, rootTaskId: identity.rootTaskId, segmentId,
          state: card.state, content: result.result, resultMessageId: result.resultMessageId, createdAt: this.now() });
        card.resultEventId = eventId;
      }
      this.touch(card);
    });
    const card = this.get(identity.taskCardId)!;
    if (card.state === 'completed') for (const dependent of this.registry.cards) if (dependent.dependencies.includes(card.taskCardId) && dependent.waitingReason?.startsWith('dependency:')) this.eligible.add(dependent.taskCardId);
    if (card.state !== 'queued') this.eligible.delete(identity.taskCardId);
  }
  private executionTransaction(identity: Readonly<TaskExecutionIdentity>, work: (registry: TaskRegistry, card: ProjectTaskCard) => void): Promise<void> {
    return this.transaction(r => {
      const card = this.requireCard(r, identity.taskCardId);
      const runtime = this.runtimes.get(identity.taskCardId);
      if (!runtime || runtime.identity !== identity || card.projectId !== identity.projectId || card.sessionId !== identity.sessionId
        || card.rootTaskId !== identity.rootTaskId || card.generation !== identity.generation) throw new Error('task_execution_identity_expired');
      work(r, card);
    });
  }
  private currentExecutionIdentity(runtime: TaskRuntime): Readonly<TaskExecutionIdentity> {
    const card = this.registry.cards.find(item => item.taskCardId === runtime.identity.taskCardId);
    return Object.freeze({ ...runtime.identity, segmentId: card?.segmentId ?? runtime.identity.segmentId });
  }
  private transaction(work: (registry: TaskRegistry) => void): Promise<void> {
    const operation = this.serial.catch(() => undefined).then(async () => {
      if (!this.initialized) throw new Error('task_service_not_initialized');
      if (this.readOnly) throw new Error('project_read_only');
      if (this.disposed) throw new Error('task_service_disposed');
      await this.options.assertExecutionOwner?.();
      const next = clone(this.registry);
      work(next); next.revision = incrementCounter(next.revision);
      try { await this.persistRegistry(next); this.persistenceError = undefined; }
      catch (error) {
        this.persistenceError = error;
        // A backend may throw after an atomic rename actually committed (for
        // example directory fsync failure). Reconcile the readable revision
        // before the next transaction so it cannot overwrite a committed
        // input/result with an older in-memory snapshot. This is still not a
        // durable ACK; a later successful commit is required to clear failure.
        try {
          const observed = await this.readRegistry();
          if (observed.revision > this.registry.revision) { this.registry = observed; this.publish(); }
        } catch { /* Keep the last known authority and the original failure. */ }
        for (const inputId of this.preparedRefs.keys()) {
          if (this.registry.inputs.find(input => input.inputId === inputId)?.preparedContent === undefined) this.preparedRefs.delete(inputId);
        }
        throw error;
      }
      this.registry = next; this.publish();
    });
    // Validation errors reject only their caller. A real failed disk barrier
    // remains visible through flush until a later complete commit succeeds.
    this.serial = operation.catch(() => undefined);
    return operation;
  }
  private requireCard(r: TaskRegistry, taskCardId: string): ProjectTaskCard {
    const card = r.cards.find(item => item.taskCardId === taskCardId);
    if (!card || card.projectId !== this.options.projectId) throw new Error('task_target_missing');
    return card;
  }

  private async readRegistry(): Promise<TaskRegistry> {
    const raw: unknown = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.uri)));
    if (!raw || typeof raw !== 'object' || !('version' in raw) || raw.version !== 2) return normalizeTaskRegistry(raw, this.options.projectId);
    const manifest = raw as TaskRegistryV2;
    if (manifest.projectId !== this.options.projectId || !Array.isArray(manifest.inputs) || !Array.isArray(manifest.events)) throw new Error('task_registry_invalid');
    const inputs = await Promise.all(manifest.inputs.map(async stored => {
      const { bodyRef, preparedRef, ...metadata } = stored;
      const body = await this.readObject(bodyRef, 'input-body', stored.inputId);
      if (!Array.isArray(body.references) || !Array.isArray(body.skillIds)) throw new Error('task_input_object_invalid');
      let preparedContent: string | undefined;
      if (preparedRef) {
        const prepared = await this.readObject(preparedRef, 'prepared-input', stored.inputId);
        if (!prepared.messageId || prepared.messageId !== stored.messageId) throw new Error('task_prepared_object_invalid');
        preparedContent = prepared.content;
        this.preparedRefs.set(stored.inputId, { content: prepared.content, messageId: prepared.messageId, ref: preparedRef });
      }
      this.bodyRefs.set(stored.inputId, bodyRef);
      return { ...metadata, content: body.content, references: body.references, skillIds: body.skillIds, ...(preparedContent === undefined ? {} : { preparedContent }) };
    }));
    const events = await Promise.all(manifest.events.map(async stored => {
      const { bodyRef, ...metadata } = stored;
      const body = await this.readObject(bodyRef, 'result-body', stored.eventId);
      this.resultRefs.set(stored.eventId, bodyRef);
      return { ...metadata, content: body.content };
    }));
    return normalizeTaskRegistry({ ...manifest, version: 1, inputs, events }, this.options.projectId);
  }

  private async persistRegistry(registry: TaskRegistry): Promise<void> {
    const inputs = await Promise.all(registry.inputs.map(async input => {
      const { content, references, skillIds, preparedContent, ...metadata } = input;
      let bodyRef = this.bodyRefs.get(input.inputId);
      if (!bodyRef) {
        bodyRef = await this.putObject({ version: 1, projectId: registry.projectId, kind: 'input-body', id: input.inputId, content, references, skillIds });
        this.bodyRefs.set(input.inputId, bodyRef);
      }
      let preparedRef: TaskObjectRef | undefined;
      if (preparedContent !== undefined) {
        if (!input.messageId) throw new Error('task_prepared_message_required');
        const cached = this.preparedRefs.get(input.inputId);
        if (cached && (cached.content !== preparedContent || cached.messageId !== input.messageId)) throw new Error('task_input_bytes_changed');
        preparedRef = cached?.ref ?? await this.putObject({ version: 1, projectId: registry.projectId, kind: 'prepared-input', id: input.inputId,
          content: preparedContent, messageId: input.messageId });
        this.preparedRefs.set(input.inputId, { content: preparedContent, messageId: input.messageId, ref: preparedRef });
      }
      return { ...metadata, bodyRef, ...(preparedRef ? { preparedRef } : {}) };
    }));
    const events = await Promise.all(registry.events.map(async event => {
      const { content, ...metadata } = event;
      let bodyRef = this.resultRefs.get(event.eventId);
      if (!bodyRef) {
        bodyRef = await this.putObject({ version: 1, projectId: registry.projectId, kind: 'result-body', id: event.eventId, content });
        this.resultRefs.set(event.eventId, bodyRef);
      }
      return { ...metadata, bodyRef };
    }));
    const manifest: TaskRegistryV2 = { ...registry, version: 2, inputs, events };
    await this.writeStorage(this.uri, manifest);
  }

  private objectUri(hash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.options.storageUri, 'task-objects', hash.slice(0, 2), `${hash}.json`);
  }
  private async putObject(object: TaskObject): Promise<TaskObjectRef> {
    const bytes = new TextEncoder().encode(JSON.stringify(object));
    if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('task_object_resource_limit');
    const ref = { hash: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.byteLength };
    if (!this.knownObjects.has(ref.hash)) {
      const uri = this.objectUri(ref.hash);
      try {
        const existing = await vscode.workspace.fs.readFile(uri);
        if (existing.byteLength !== ref.bytes || createHash('sha256').update(existing).digest('hex') !== ref.hash) throw new Error('task_object_hash_mismatch');
        // Unknown existing objects can be leftovers of a failed fsync. A
        // verified read is not a durability barrier; commit these bytes again.
        await this.writeStorage(uri, object);
      } catch (error) { if (!isMissing(error)) throw error; await this.writeStorage(uri, object); }
      this.knownObjects.add(ref.hash);
    }
    return ref;
  }
  private async readObject(ref: TaskObjectRef, kind: TaskObject['kind'], id: string): Promise<TaskObject> {
    if (!isPlainRecord(ref) || typeof ref.hash !== 'string' || !/^[a-f0-9]{64}$/.test(ref.hash) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0 || ref.bytes > 64 * 1024 * 1024) throw new Error('task_object_reference_invalid');
    let bytes: Uint8Array;
    try { bytes = await vscode.workspace.fs.readFile(this.objectUri(ref.hash)); }
    catch (error) { if (isMissing(error)) throw new Error('task_object_missing'); throw error; }
    if (bytes.byteLength !== ref.bytes || createHash('sha256').update(bytes).digest('hex') !== ref.hash) throw new Error('task_object_hash_mismatch');
    const value = JSON.parse(new TextDecoder().decode(bytes)) as TaskObject;
    if (!isPlainRecord(value) || value.version !== 1 || value.projectId !== this.options.projectId || value.kind !== kind || value.id !== id || typeof value.content !== 'string') throw new Error('task_object_scope_mismatch');
    this.knownObjects.add(ref.hash); return value;
  }
  private async writeStorage(uri: vscode.Uri, value: unknown): Promise<void> {
    if (this.options.storageWrite) await this.options.storageWrite(uri, value);
    else await writeJsonAtomic(uri, value, { durable: true });
  }
  private now(): string {
    const value = this.options.now?.() ?? new Date().toISOString();
    if (!validTimestamp(value)) throw new Error('task_timestamp_invalid');
    return value;
  }
  private assertAccepting(): void { if (this.closing || this.disposed) throw new Error('task_service_disposed'); }
  private touch(card: ProjectTaskCard): void { card.revision = incrementCounter(card.revision); card.updatedAt = this.now(); }
  private publish(): void {
    try { this.options.onChange?.(this.list()); }
    catch { /* View publication is not a storage or execution barrier. */ }
  }
  private wakeIdle(): void { const waiters = [...this.idleWaiters]; this.idleWaiters.clear(); for (const resolve of waiters) resolve(); }
}

function normalizeTaskRegistry(value: unknown, projectId: string): TaskRegistry {
  const raw = value as Partial<TaskRegistry> | null;
  if (!isPlainRecord(raw) || raw.version !== 1 || raw.projectId !== projectId || !validId(raw.projectId)
    || !validCounter(raw.revision) || !Array.isArray(raw.cards) || raw.cards.length > 100_000
    || !Array.isArray(raw.inputs) || raw.inputs.length > 1_000_000 || !Array.isArray(raw.events) || raw.events.length > 1_000_000) throw new Error('task_registry_invalid');
  const r = clone(raw) as TaskRegistry;
  const sessions = new Set<string>(), requests = new Set<string>(), inputIds = new Set<string>(), eventIds = new Set<string>();
  const eventCards = new Map<string, string>();
  const cards = new Map<string, ProjectTaskCard>(), inputsByCard = new Map<string, string[]>(), rootsByCard = new Map<string, Set<string>>();
  for (const card of r.cards) {
    if (!isPlainRecord(card) || card.version !== 1 || card.projectId !== projectId || !validId(card.taskCardId) || !validId(card.sessionId)
      || !validId(card.rootTaskId) || cards.has(card.taskCardId) || sessions.has(card.sessionId) || !validCounter(card.generation) || !validCounter(card.revision)
      || card.segmentId !== undefined && !validSegment(card.segmentId) || !validText(card.title, 4096, true)
      || card.customTitle !== undefined && !validText(card.customTitle, 4096, true) || !validTimestamp(card.createdAt) || !validTimestamp(card.updatedAt)
      || typeof card.archived !== 'boolean' || typeof card.sessionCreated !== 'boolean' || typeof card.usageIncomplete !== 'boolean'
      || !finiteNonnegative(card.usedMs) || !validCosts(card.costByCurrency)
      || !Array.isArray(card.dependencies) || card.dependencies.length > 100_000 || card.dependencies.some(id => !validId(id))
      || new Set(card.dependencies).size !== card.dependencies.length
      || card.inputIds !== undefined && (!Array.isArray(card.inputIds) || card.inputIds.length > 1_000_000 || card.inputIds.some(id => !validId(id)))
      || card.associationRequestId !== undefined && (!validId(card.associationRequestId) || requests.has(card.associationRequestId))
      || card.resultEventId !== undefined && !validId(card.resultEventId, 1024)
      || [card.waitingReason, card.progress, card.error].some(text => text !== undefined && !validText(text, 1024 * 1024))) throw new Error('task_card_invalid');
    if (!TASK_STATES.includes(card.state)) throw new Error('task_state_invalid');
    validateSnapshot(card.snapshot); cards.set(card.taskCardId, card); sessions.add(card.sessionId);
    inputsByCard.set(card.taskCardId, []); rootsByCard.set(card.taskCardId, new Set());
    if (card.associationRequestId) requests.add(card.associationRequestId);
  }
  validateDependencies(cards);
  for (const input of r.inputs) {
    const card = cards.get(input?.taskCardId);
    if (!isPlainRecord(input) || input.version !== 1 || !validId(input.inputId) || inputIds.has(input.inputId) || !validId(input.requestId)
      || requests.has(input.requestId) || !validId(input.rootTaskId) || !card || card.sessionId !== input.sessionId
      || !['new', 'followup', 'supplement', 'continue'].includes(input.kind) || !INPUT_STATES.includes(input.state)
      || typeof input.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.fingerprint)
      || !Array.isArray(input.references) || input.references.length > 4096 || !validSkillIds(input.skillIds)
      || !validTimestamp(input.createdAt) || input.incorporatedAt !== undefined && !validTimestamp(input.incorporatedAt)
      || input.settledAt !== undefined && !validTimestamp(input.settledAt) || input.messageId !== undefined && !validId(input.messageId)
      || input.error !== undefined && !validText(input.error, 1024 * 1024)
      || input.preparedContent !== undefined && (typeof input.preparedContent !== 'string' || input.preparedContent.length > 64 * 1024 * 1024 || !validId(input.messageId))
      || input.replaceMessageId !== undefined && (!validId(input.replaceMessageId) || input.kind !== 'followup')) throw new Error('task_input_invalid');
    validateInput(input, input.kind === 'continue');
    requests.add(input.requestId); inputIds.add(input.inputId); inputsByCard.get(card.taskCardId)!.push(input.inputId); rootsByCard.get(card.taskCardId)!.add(input.rootTaskId);
  }
  // Rebuild list indices from durable input identities; never use array offsets
  // as a cross-file consumption receipt.
  for (const card of r.cards) card.inputIds = inputsByCard.get(card.taskCardId)!;
  for (const event of r.events) {
    const card = cards.get(event?.taskCardId);
    if (!isPlainRecord(event) || event.version !== 1 || !validId(event.eventId, 1024) || eventIds.has(event.eventId) || !card
      || event.sessionId !== card.sessionId || !validId(event.rootTaskId) || !rootsByCard.get(card.taskCardId)!.has(event.rootTaskId)
      || !validSegment(event.segmentId) || !TASK_STATES.includes(event.state) || !validTimestamp(event.createdAt)
      || typeof event.content !== 'string' || event.content.length > 64 * 1024 * 1024 || event.resultMessageId !== undefined && !validId(event.resultMessageId)
      || event.consumedByInputId !== undefined && !validId(event.consumedByInputId)) throw new Error('task_event_invalid');
    eventIds.add(event.eventId); eventCards.set(event.eventId, card.taskCardId);
  }
  for (const card of r.cards) if (card.resultEventId && eventCards.get(card.resultEventId) !== card.taskCardId) throw new Error('task_event_reference_invalid');
  return r;
}
function validateSnapshot(snapshot: TaskDefaultsSnapshot): void {
  if (!isPlainRecord(snapshot) || !validId(snapshot.modelId, 4096) || !['ask', 'delegate'].includes(snapshot.approvalMode)
    || !['normal', 'plan'].includes(snapshot.executionMode) || !validSkillIds(snapshot.skillIds)
    || snapshot.sourceId !== undefined && snapshot.sourceId !== '' && !validId(snapshot.sourceId, 4096)
    || snapshot.wireModel !== undefined && !validId(snapshot.wireModel, 4096)
    || snapshot.endpoint !== undefined && !validText(snapshot.endpoint, 16384)
    || snapshot.protocol !== undefined && !validId(snapshot.protocol, 256)
    || [snapshot.rootUri, snapshot.cwdUri].some(uri => uri !== undefined && !validText(uri, 16384, true))
    || snapshot.configuration !== undefined && !isPlainRecord(snapshot.configuration)) throw new Error('task_snapshot_invalid');
}
function validateInput(value: NewTaskInput, allowEmpty = false): void {
  if (!validId(value.requestId)) throw new Error('task_request_id_required');
  if (typeof value.content !== 'string' || (!allowEmpty && !value.content.trim()) || Buffer.byteLength(value.content, 'utf8') > 1024 * 1024) throw new Error('task_input_invalid');
  if (value.replaceMessageId !== undefined && (typeof value.replaceMessageId !== 'string' || !value.replaceMessageId || value.replaceMessageId.length > 256)) throw new Error('task_edit_target_invalid');
  if (value.references !== undefined && (!Array.isArray(value.references) || value.references.length > 4096)) throw new Error('task_references_invalid');
  if (value.skillIds !== undefined && !validSkillIds(value.skillIds)) throw new Error('task_skills_invalid');
  if (Buffer.byteLength(JSON.stringify({ references: value.references, skillIds: value.skillIds }), 'utf8') > 1024 * 1024) throw new Error('task_input_metadata_too_large');
}
function validateDependencies(cards: ReadonlyMap<string, ProjectTaskCard>): void {
  const remaining = new Map<string, number>(), dependents = new Map<string, string[]>();
  for (const card of cards.values()) {
    remaining.set(card.taskCardId, card.dependencies.length);
    for (const dependency of card.dependencies) {
      if (!cards.has(dependency)) throw new Error('task_dependency_target_invalid');
      const list = dependents.get(dependency) ?? []; list.push(card.taskCardId); dependents.set(dependency, list);
    }
  }
  const ready = [...remaining].filter(([, count]) => count === 0).map(([id]) => id); let visited = 0;
  while (ready.length) {
    const id = ready.pop()!; visited += 1;
    for (const dependent of dependents.get(id) ?? []) {
      const next = remaining.get(dependent)! - 1; remaining.set(dependent, next); if (!next) ready.push(dependent);
    }
  }
  if (visited !== cards.size) throw new Error('task_dependency_cycle');
}
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function validCounter(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function incrementCounter(value: number): number {
  if (!validCounter(value) || value >= Number.MAX_SAFE_INTEGER) throw new Error('task_counter_exhausted');
  return value + 1;
}
function finiteNonnegative(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function validCosts(value: unknown): value is Record<string, number> {
  return isPlainRecord(value) && Object.entries(value).every(([currency, cost]) => validId(currency, 64) && finiteNonnegative(cost));
}
function validText(value: unknown, maxLength: number, nonempty = false): value is string {
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\0') && (!nonempty || !!value.trim());
}
function validId(value: unknown, maxLength = 256): value is string {
  if (!validText(value, maxLength, true)) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index); if (code < 32 || code === 127) return false;
  }
  return true;
}
function validSegment(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value); }
function validTimestamp(value: unknown): value is string { return validText(value, 128, true) && Number.isFinite(Date.parse(value)); }
function validSkillIds(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 4096 && value.every(id => validId(id, 4096)); }
function temporaryTitle(content: string): string { return [...content.trim().replace(/\s+/g, ' ')].slice(0, 32).join(''); }
function clone<T>(value: T): T { return value === undefined ? value : structuredClone(value); }
function digest(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && ['FileNotFound', 'ENOENT'].includes(String(error.code)); }
