import { hasExactCommandScope, inspectDraftRunScope, type CommandScope } from '../approvals/authorization/commandScope';
import { randomUUID } from 'node:crypto';
import type { DraftRun, DraftRunBatchSnapshot, DraftRunBatchState } from '../shared/types';
import type { DraftRunStore } from './draftRunStore';
import type { HistoryTruncationScope } from '../sessions/historyTruncation';
import { canIsolateDraftRunFailure, inspectDraftRunDependencies, inspectGitAncestorPrerequisite, orderDraftRunDependencies } from './draftRunDependencies';

type BatchStore = Pick<DraftRunStore, 'get' | 'toWebviewState' | 'flush' | 'approveAndRun'
  | 'validateApprovalBoundary' | 'cancelAutoContinuations' | 'recordBatchDisplay' | 'setPendingDependency'>;

/** One finite user-click authorization, with an independent once-only continuation. */
export class DraftRunBatchCoordinator {
  private readonly offers = new Map<string, DraftRunBatchSnapshot>();
  private operation?: { state: DraftRunBatchState; controller: AbortController };

  public constructor(private readonly store: BatchStore, private readonly changed: () => void = () => {}) {}

  private notifyChanged(): void {
    if (this.operation) this.store.recordBatchDisplay(this.operation.state);
    this.changed();
  }

  public get state(): DraftRunBatchState | undefined {
    if (this.operation && !this.hasActiveMembers(this.operation.state)) return undefined;
    return this.operation ? structuredClone(this.operation.state) : undefined;
  }

  private hasActiveMembers(snapshot: DraftRunBatchSnapshot): boolean {
    return snapshot.entries.every(entry => {
      const run = this.store.get(entry.draftRunId);
      return run && !run.historyInvalidationId && !run.historyOriginUnverified;
    });
  }

  /** Forget finite click authority and presentation when its source history leaves. */
  public invalidateHistory(scope: HistoryTruncationScope): void {
    for (const [key, offer] of this.offers) {
      if (offer.sessionId === scope.sessionId && !this.hasActiveMembers(offer)) this.offers.delete(key);
    }
    const op = this.operation;
    if (op?.state.sessionId !== scope.sessionId || this.hasActiveMembers(op.state)) return;
    op.controller.abort();
    this.operation = undefined;
    this.changed();
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
      if (run.status !== 'pending' || run.dependency || run.approvalHold) continue;
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
    this.store.recordBatchDisplay(state);
    // Retire old single-command intentions without touching history or results.
    this.store.cancelAutoContinuations(context.sessionId);
    return state.operationId;
  }

  private assertSnapshot(snapshot: DraftRunBatchSnapshot): void {
    const actual = this.store.toWebviewState(snapshot.sessionId)
      .filter((run) => run.agentRunId === snapshot.agentRunId && run.status === 'pending' && !run.dependency && !run.approvalHold)
      .map((run) => ({ draftRunId: run.id, specHash: run.specHash }));
    if (JSON.stringify(actual) !== JSON.stringify(snapshot.entries)) throw new Error('The pending command list changed. Review the refreshed cards.');
  }

  public isValid(operationId: string): boolean {
    return this.operation?.state.operationId === operationId && !this.operation.controller.signal.aborted && this.pending
      && this.hasActiveMembers(this.operation.state);
  }

  public cancel(operationId?: string): void {
    const op = this.operation;
    if (!op || (operationId && op.state.operationId !== operationId) || !this.pending) return;
    op.controller.abort();
    op.state.phase = 'cancelled';
    op.state.reason = undefined;
    this.notifyChanged();
  }

  public async execute(operationId: string, input: {
    authorizedUris: ReadonlySet<string>;
    rootTaskRunIds?: ReadonlySet<string>;
    selectedProjectUri?: string;
    verifyEditDependencies?: (run: DraftRun, scope: CommandScope) => Promise<void>;
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
        const run = this.store.validateApprovalBoundary(entry.draftRunId, input.authorizedUris, entry.specHash);
        const scope = await inspectDraftRunScope(run, false, undefined, false, input.selectedProjectUri, true);
        assertValid();
        if (!hasExactCommandScope(scope, run.spec.cwdUri, input.authorizedUris)) {
          throw new Error('A command needs individual external scope authorization. / 命令需要逐项授权外部范围。');
        }
      }
      op.state.currentIndex = 0;
      await this.store.flush();
      assertValid();
      this.assertSnapshot(op.state);
      const failedRuns: DraftRun[] = [];
      let firstFailure: string | undefined;
      const entries = orderDraftRunDependencies(op.state.entries.map(entry => entry.draftRunId), id => this.store.get(id))
        .map(id => op.state.entries.find(entry => entry.draftRunId === id)!);
      for (const [index, entry] of entries.entries()) {
        assertValid();
        op.state.currentIndex = index + 1;
        const run = this.store.validateApprovalBoundary(entry.draftRunId, input.authorizedUris, entry.specHash);
        const dependency = inspectDraftRunDependencies(run, id => this.store.get(id), input.rootTaskRunIds);
        if (!dependency.allowed) {
          firstFailure ??= dependency.reason;
          this.store.setPendingDependency(run.id, run.specHash, dependency.dependency);
          failedRuns.push({ ...run, executionStarted: false, executionPhase: 'not_dispatched' });
          continue;
        }
        const prior = [...(input.rootTaskRunIds ?? new Set(op.state.entries.map(item => item.draftRunId)))]
          .flatMap(id => { const member = this.store.get(id); return member ? [member] : []; });
        const ancestor = await inspectGitAncestorPrerequisite(run, prior, input.authorizedUris, input.selectedProjectUri);
        assertValid();
        if (!ancestor.allowed) {
          firstFailure ??= ancestor.reason;
          this.store.setPendingDependency(run.id, run.specHash, ancestor.dependency);
          failedRuns.push({ ...run, executionStarted: false, executionPhase: 'not_dispatched' });
          continue;
        }
        if (failedRuns.length && !await canIsolateDraftRunFailure(run, failedRuns, input.authorizedUris)) {
          continue;
        }
        assertValid();
        op.state.phase = 'running';
        op.state.remaining = op.state.entries.length - index - 1;
        op.state.currentCommand = run.spec.executable;
        input.onCurrent(run);
        this.notifyChanged();
        assertValid();
        let result: DraftRun | undefined;
        try {
          result = await this.store.approveAndRun(entry.draftRunId, input.authorizedUris, {
            signal: op.controller.signal, expectedSpecHash: entry.specHash,
            rootTaskRunIds: input.rootTaskRunIds,
            selectedProjectUri: input.selectedProjectUri,
            verifyScope: async inspectScope => {
              if (!input.verifyEditDependencies) return;
              const scope = await inspectScope();
              assertValid();
              if (!hasExactCommandScope(scope, run.spec.cwdUri, input.authorizedUris)) {
                throw new Error('A command needs individual external scope authorization. / 命令需要逐项授权外部范围。');
              }
              await input.verifyEditDependencies(run, scope);
            },
            userApproval: () => { assertValid(); return true; }
          });
        } catch (error) {
          assertValid();
          firstFailure ??= error instanceof Error ? error.message : String(error);
          failedRuns.push(this.store.get(run.id) ?? run);
          input.onCurrent(undefined);
          continue;
        }
        op.state.remaining = op.state.entries.filter((item) => this.store.get(item.draftRunId)?.status === 'pending').length;
        assertValid();
        if (!result || result.status !== 'done') {
          firstFailure ??= result?.error ?? `Command ${index + 1} did not succeed.`;
          failedRuns.push(result ?? run);
          input.onCurrent(undefined);
          this.notifyChanged();
          continue;
        }
        op.state.completed++;
        input.onCurrent(undefined);
        this.notifyChanged();
      }
      assertValid();
      if (firstFailure) throw new Error(firstFailure);
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
      this.notifyChanged();
    }
  }

  public wait(reason: string): void {
    if (this.operation?.state.phase !== 'waiting' || this.operation.state.reason === reason) return;
    this.operation.state.reason = reason;
    this.notifyChanged();
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
    this.notifyChanged();
    try {
      await this.store.flush();
      if (!this.isValid(op.state.operationId)) return;
      input.assertContext();
      const reason = input.blocker();
      if (reason) { op.state.phase = 'waiting'; op.state.reason = reason; return; }
      if (!op.state.entries.every((entry) => {
        const run = this.store.get(entry.draftRunId);
        return run?.status === 'done' && !run.historyInvalidationId && !run.historyOriginUnverified && run.specHash === entry.specHash
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
    } finally { this.notifyChanged(); }
  }
}
