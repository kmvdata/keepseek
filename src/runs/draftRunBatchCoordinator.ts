import { randomUUID } from 'node:crypto';
import type { DraftRun, DraftRunBatchSnapshot, DraftRunBatchState } from '../shared/types';
import type { DraftRunStore } from './draftRunStore';

type BatchStore = Pick<DraftRunStore, 'get' | 'toWebviewState' | 'flush' | 'approveAndRun'
  | 'validateApprovalBoundary' | 'cancelAutoContinuations'>;

/** One finite user-click authorization, with an independent once-only continuation. */
export class DraftRunBatchCoordinator {
  private readonly offers = new Map<string, DraftRunBatchSnapshot>();
  private operation?: { state: DraftRunBatchState; controller: AbortController };

  public constructor(private readonly store: BatchStore, private readonly changed: () => void = () => {}) {}

  public get state(): DraftRunBatchState | undefined {
    return this.operation ? structuredClone(this.operation.state) : undefined;
  }

  public get pending(): boolean {
    return Boolean(this.operation && ['queued', 'running', 'waiting', 'continuing'].includes(this.operation.state.phase));
  }

  public get locked(): boolean {
    return Boolean(this.operation && ['queued', 'running', 'continuing'].includes(this.operation.state.phase));
  }

  public snapshots(sessionId: string): DraftRunBatchSnapshot[] {
    const groups = new Map<string, DraftRunBatchSnapshot['entries']>();
    for (const run of this.store.toWebviewState(sessionId)) {
      if (run.status !== 'pending') continue;
      const entries = groups.get(run.agentRunId) ?? [];
      entries.push({ draftRunId: run.id, specHash: run.specHash });
      groups.set(run.agentRunId, entries);
    }
    const snapshots: DraftRunBatchSnapshot[] = [];
    for (const [agentRunId, entries] of groups) {
      if (entries.length < 2) continue;
      const key = JSON.stringify([sessionId, agentRunId]);
      let offer = this.offers.get(key);
      if (!offer || JSON.stringify(offer.entries) !== JSON.stringify(entries)) {
        offer = { snapshotId: randomUUID(), sessionId, agentRunId, entries };
        this.offers.set(key, offer);
      }
      snapshots.push(structuredClone(offer));
    }
    for (const [key, offer] of this.offers) {
      if (offer.sessionId === sessionId && !snapshots.some((item) => item.snapshotId === offer.snapshotId)) this.offers.delete(key);
    }
    return snapshots;
  }

  /** Synchronous claim before any async validation, persistence or UI feedback. */
  public accept(request: DraftRunBatchSnapshot, context: { sessionId: string; sourceId: string; modelId: string }): string {
    if (this.locked) throw new Error('A command batch is already active.');
    const key = JSON.stringify([request.sessionId, request.agentRunId]);
    const offer = this.offers.get(key);
    if (!offer || request.sessionId !== context.sessionId || request.snapshotId !== offer.snapshotId
      || !Array.isArray(request.entries) || request.entries.length < 2
      || new Set(request.entries.map((entry) => entry?.draftRunId)).size !== request.entries.length
      || JSON.stringify(request.entries) !== JSON.stringify(offer.entries)) {
      throw new Error('The displayed command snapshot is stale. Review the refreshed cards.');
    }
    this.assertSnapshot(offer);
    this.cancel();
    this.offers.delete(key);
    const state: DraftRunBatchState = {
      ...structuredClone(offer), operationId: randomUUID(), sourceId: context.sourceId, modelId: context.modelId,
      phase: 'queued', completed: 0, currentIndex: 0, remaining: offer.entries.length
    };
    this.operation = { state, controller: new AbortController() };
    // Retire old single-command intentions without touching history or results.
    this.store.cancelAutoContinuations(context.sessionId);
    return state.operationId;
  }

  private assertSnapshot(snapshot: DraftRunBatchSnapshot): void {
    const actual = this.store.toWebviewState(snapshot.sessionId)
      .filter((run) => run.agentRunId === snapshot.agentRunId && run.status === 'pending')
      .map((run) => ({ draftRunId: run.id, specHash: run.specHash }));
    if (JSON.stringify(actual) !== JSON.stringify(snapshot.entries)) throw new Error('The pending command list changed. Review the refreshed cards.');
  }

  public isValid(operationId: string): boolean {
    return this.operation?.state.operationId === operationId && !this.operation.controller.signal.aborted && this.pending;
  }

  public cancel(operationId?: string): void {
    const op = this.operation;
    if (!op || (operationId && op.state.operationId !== operationId) || !this.pending) return;
    op.controller.abort();
    op.state.phase = 'cancelled';
    op.state.reason = undefined;
    this.changed();
  }

  public async execute(operationId: string, input: {
    authorizedUris: ReadonlySet<string>;
    assertContext: () => void;
    onCurrent: (run: DraftRun | undefined) => void;
  }): Promise<void> {
    const op = this.operation;
    if (!op || op.state.operationId !== operationId || op.state.phase !== 'queued') return;
    const assertValid = () => {
      if (!this.isValid(operationId)) throw new Error('Command batch authorization was revoked.');
      input.assertContext();
    };
    try {
      assertValid();
      this.assertSnapshot(op.state);
      // Check the entire boundary now, but stat each cwd only when its turn arrives:
      // an earlier command may create a later command's working directory.
      for (const [index, entry] of op.state.entries.entries()) {
        op.state.currentIndex = index + 1;
        this.store.validateApprovalBoundary(entry.draftRunId, input.authorizedUris, entry.specHash);
      }
      op.state.currentIndex = 0;
      await this.store.flush();
      assertValid();
      this.assertSnapshot(op.state);
      for (const [index, entry] of op.state.entries.entries()) {
        assertValid();
        op.state.currentIndex = index + 1;
        const run = this.store.validateApprovalBoundary(entry.draftRunId, input.authorizedUris, entry.specHash);
        op.state.phase = 'running';
        op.state.remaining = op.state.entries.length - index - 1;
        op.state.currentCommand = run.spec.executable;
        input.onCurrent(run);
        this.changed();
        assertValid();
        const result = await this.store.approveAndRun(entry.draftRunId, input.authorizedUris, {
          signal: op.controller.signal, expectedSpecHash: entry.specHash,
          userApproval: () => { assertValid(); return true; }
        });
        op.state.remaining = op.state.entries.filter((item) => this.store.get(item.draftRunId)?.status === 'pending').length;
        assertValid();
        if (!result || result.status !== 'done') throw new Error(result?.error ?? `Command ${index + 1} did not succeed.`);
        op.state.completed++;
        input.onCurrent(undefined);
        this.changed();
      }
      assertValid();
      op.state.phase = 'waiting';
      op.state.currentCommand = undefined;
    } catch (error) {
      if (!op.controller.signal.aborted) {
        op.state.phase = 'failed';
        op.state.reason = error instanceof Error ? error.message : String(error);
        op.controller.abort();
      }
    } finally {
      op.state.remaining = op.state.entries.filter((entry) => this.store.get(entry.draftRunId)?.status === 'pending').length;
      input.onCurrent(undefined);
      this.changed();
    }
  }

  public wait(reason: string): void {
    if (this.operation?.state.phase !== 'waiting' || this.operation.state.reason === reason) return;
    this.operation.state.reason = reason;
    this.changed();
  }

  /** Claim synchronously; duplicate timers/state pushes cannot dispatch again. */
  public async continueOnce(input: {
    assertContext: () => void;
    blocker: () => string | undefined;
    send: (state: DraftRunBatchState, signal: AbortSignal) => Promise<boolean>;
  }): Promise<void> {
    const op = this.operation;
    if (!op || op.state.phase !== 'waiting') return;
    op.state.phase = 'continuing';
    try {
      await this.store.flush();
      if (!this.isValid(op.state.operationId)) return;
      input.assertContext();
      const reason = input.blocker();
      if (reason) { op.state.phase = 'waiting'; op.state.reason = reason; return; }
      if (!op.state.entries.every((entry) => {
        const run = this.store.get(entry.draftRunId);
        return run?.status === 'done' && run.specHash === entry.specHash
          && run.sessionId === op.state.sessionId && run.agentRunId === op.state.agentRunId;
      })) throw new Error('Completed command records changed or were removed.');
      const sent = await input.send(structuredClone(op.state), op.controller.signal);
      if (!this.isValid(op.state.operationId)) return;
      if (!sent) throw new Error('Could not continue the task. Command results are saved; send a new message to continue.');
      op.state.phase = 'completed';
      op.state.reason = undefined;
    } catch (error) {
      if (!op.controller.signal.aborted) {
        op.state.failureStage = 'continuation';
        op.state.phase = 'failed';
        op.state.reason = error instanceof Error ? error.message : String(error);
        op.controller.abort();
      }
    } finally { this.changed(); }
  }
}
