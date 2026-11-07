import type { ProjectTaskCard, TaskInput } from './projectTasks';

/** Every callback carries the execution identity captured before its first await. */
export interface TaskExecutionIdentity {
  projectId: string;
  taskCardId: string;
  sessionId: string;
  rootTaskId: string;
  segmentId: string;
  generation: number;
}

export interface TaskExecutionContext {
  identity: Readonly<TaskExecutionIdentity>;
  card: Readonly<ProjectTaskCard>;
  input: Readonly<TaskInput>;
  signal: AbortSignal;
  /** Bind the authoritative segment of a later internal assistant run without
   * creating another root, runtime owner, clock or budget. */
  executionSegment?(segmentId: string): Promise<void>;
  /** Persist this intent before committing the corresponding real user message. */
  prepareInput(content: string, messageId: string): Promise<void>;
  /** The authoritative session message must be durable before this callback. */
  incorporated(messageId: string): Promise<void>;
  progress(text: string): Promise<void>;
  waiting(reason: string): Promise<void>;
}

export interface TaskExecutionResult {
  result?: string;
  resultMessageId?: string;
  usedMs?: number;
  costByCurrency?: Record<string, number>;
  usageIncomplete?: boolean;
  waiting?: string;
}

/** A driver owns its own Runner, tools, approvals, context and model snapshot.
 * execute resolves only after the assistant/native tool round and session save
 * have settled. requestBoundary never inserts into an open assistant segment. */
export interface TaskExecutionDriver {
  execute(context: TaskExecutionContext): Promise<TaskExecutionResult>;
  requestBoundary?(identity: Readonly<TaskExecutionIdentity>): Promise<void> | void;
  revokePendingActions?(identity: Readonly<TaskExecutionIdentity>, reason: 'supplement' | 'stop'): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

export class TaskRuntime {
  readonly controller = new AbortController();
  private running = false;
  private disposed = false;

  constructor(readonly identity: Readonly<TaskExecutionIdentity>, readonly driver: TaskExecutionDriver) {}

  get isExecuting(): boolean { return this.running; }

  async execute(context: Omit<TaskExecutionContext, 'identity' | 'signal'>): Promise<TaskExecutionResult> {
    if (this.running || this.disposed) throw new Error('task_runtime_already_running');
    this.running = true;
    try { return await this.driver.execute({ ...context, identity: this.identity, signal: this.controller.signal }); }
    finally { this.running = false; }
  }

  async supplement(identity: Readonly<TaskExecutionIdentity> = this.identity): Promise<void> {
    if (this.disposed || this.controller.signal.aborted) throw new Error('task_runtime_stopping');
    this.assertIdentity(identity);
    // Revocation precedes the ACK. Already dispatched work is settled by the
    // driver; an old permit cannot launch another operation after acceptance.
    await this.driver.revokePendingActions?.(identity, 'supplement');
    await this.driver.requestBoundary?.(identity);
  }

  async stop(identity: Readonly<TaskExecutionIdentity> = this.identity): Promise<void> {
    this.assertIdentity(identity);
    this.controller.abort();
    await this.driver.revokePendingActions?.(identity, 'stop');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.driver.dispose?.();
  }

  private assertIdentity(identity: Readonly<TaskExecutionIdentity>): void {
    if (identity.projectId !== this.identity.projectId || identity.taskCardId !== this.identity.taskCardId
      || identity.sessionId !== this.identity.sessionId || identity.rootTaskId !== this.identity.rootTaskId
      || identity.generation !== this.identity.generation || !identity.segmentId) throw new Error('task_execution_identity_expired');
  }
}
