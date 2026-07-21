import { randomUUID } from 'node:crypto';
import type {
  AgentExecutionLimits,
  BackgroundRun,
  BackgroundRunGoal,
  BackgroundRunLimits,
  RunDetailsSummary
} from '../shared/types';

export type BackgroundRunChangeHandler = (run: BackgroundRun | undefined) => void;

export class BackgroundRunCoordinator {
  private activeRun: BackgroundRun | undefined;

  public constructor(private readonly onChange?: BackgroundRunChangeHandler) {}

  public start(input: {
    sessionId: string;
    workspaceKey: string;
    goal: BackgroundRunGoal;
    limits: BackgroundRunLimits;
  }): BackgroundRun {
    if (this.activeRun && !isTerminal(this.activeRun)) {
      throw new Error('Only one background Agent task can run in this workspace.');
    }
    const now = new Date().toISOString();
    this.activeRun = {
      id: randomUUID(),
      sessionId: input.sessionId,
      workspaceKey: input.workspaceKey,
      status: 'running',
      goal: { ...input.goal },
      limits: normalizeLimits(input.limits),
      progress: {
        round: 0,
        toolCalls: 0,
        runIds: []
      },
      startedAt: now,
      updatedAt: now
    };
    this.emit();
    return this.getActiveRun() as BackgroundRun;
  }

  public beginRound(): BackgroundRun {
    const run = this.requireRun();
    const stopReason = this.getLimitStopReason(run);
    if (stopReason) {
      return this.fail(stopReason);
    }
    run.status = 'running';
    run.progress.round += 1;
    run.waitingReason = undefined;
    run.stopReason = undefined;
    this.touch();
    return this.getActiveRun() as BackgroundRun;
  }

  public recordRun(details: RunDetailsSummary): BackgroundRun {
    const run = this.requireRun();
    if (!run.progress.runIds.includes(details.runId)) {
      run.progress.runIds.push(details.runId);
    }
    run.progress.lastRunId = details.runId;
    run.progress.toolCalls += details.toolCallCount;
    this.touch();
    return this.getActiveRun() as BackgroundRun;
  }

  public markRunning(): BackgroundRun {
    const run = this.requireRun();
    if (isTerminal(run)) {
      return this.getActiveRun() as BackgroundRun;
    }
    run.status = 'running';
    run.waitingReason = undefined;
    this.touch();
    return this.getActiveRun() as BackgroundRun;
  }

  public waitForApply(reason: string): BackgroundRun {
    return this.wait('waiting_for_apply', reason);
  }

  public waitForAuthorization(reason: string): BackgroundRun {
    return this.wait('waiting_for_authorization', reason);
  }

  public complete(reason?: string): BackgroundRun {
    const run = this.requireRun();
    run.status = 'completed';
    run.stopReason = reason;
    run.waitingReason = undefined;
    run.endedAt = new Date().toISOString();
    this.touch();
    return this.getActiveRun() as BackgroundRun;
  }

  public fail(reason: string): BackgroundRun {
    const run = this.requireRun();
    run.status = 'failed';
    run.stopReason = reason;
    run.waitingReason = undefined;
    run.endedAt = new Date().toISOString();
    this.touch();
    return this.getActiveRun() as BackgroundRun;
  }

  public stop(reason: string): BackgroundRun {
    const run = this.requireRun();
    if (isTerminal(run)) {
      return this.getActiveRun() as BackgroundRun;
    }
    run.status = 'stopped';
    run.stopReason = reason;
    run.waitingReason = undefined;
    run.endedAt = new Date().toISOString();
    this.touch();
    return this.getActiveRun() as BackgroundRun;
  }

  public getRemainingExecutionLimits(): AgentExecutionLimits {
    const run = this.requireRun();
    const elapsedMs = Math.max(0, Date.now() - Date.parse(run.startedAt));
    const remainingToolCalls = Math.max(1, run.limits.maxToolCalls - run.progress.toolCalls);
    const remainingDurationMs = Math.max(1, run.limits.maxDurationMs - elapsedMs);
    return {
      maxToolIterations: remainingToolCalls,
      maxToolCalls: remainingToolCalls,
      maxRunMs: remainingDurationMs,
      maxRepairIterations: run.limits.maxRounds
    };
  }

  public getLimitStopReason(run = this.activeRun): string | undefined {
    if (!run) return 'Background task is unavailable.';
    if (run.progress.round >= run.limits.maxRounds) return `Maximum background rounds reached (${run.limits.maxRounds}).`;
    if (run.progress.toolCalls >= run.limits.maxToolCalls) return `Maximum background tool calls reached (${run.limits.maxToolCalls}).`;
    if (Date.now() - Date.parse(run.startedAt) >= run.limits.maxDurationMs) return `Maximum background duration reached (${run.limits.maxDurationMs} ms).`;
    return undefined;
  }

  public getActiveRun(): BackgroundRun | undefined {
    return this.activeRun ? cloneRun(this.activeRun) : undefined;
  }

  public clear(): void {
    this.activeRun = undefined;
    this.emit();
  }

  private wait(status: 'waiting_for_apply' | 'waiting_for_authorization', reason: string): BackgroundRun {
    const run = this.requireRun();
    if (isTerminal(run)) {
      return this.getActiveRun() as BackgroundRun;
    }
    run.status = status;
    run.waitingReason = reason.slice(0, 500);
    this.touch();
    return this.getActiveRun() as BackgroundRun;
  }

  private requireRun(): BackgroundRun {
    if (!this.activeRun) {
      throw new Error('No background Agent task is active.');
    }
    return this.activeRun;
  }

  private touch(): void {
    if (this.activeRun) {
      this.activeRun.updatedAt = new Date().toISOString();
    }
    this.emit();
  }

  private emit(): void {
    this.onChange?.(this.getActiveRun());
  }
}

function normalizeLimits(limits: BackgroundRunLimits): BackgroundRunLimits {
  return {
    maxRounds: clamp(limits.maxRounds, 1, 10),
    maxDurationMs: clamp(limits.maxDurationMs, 60_000, 3_600_000),
    maxToolCalls: clamp(limits.maxToolCalls, 1, 256)
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isTerminal(run: BackgroundRun): boolean {
  return run.status === 'completed' || run.status === 'failed' || run.status === 'stopped';
}

function cloneRun(run: BackgroundRun): BackgroundRun {
  return {
    ...run,
    goal: { ...run.goal },
    limits: { ...run.limits },
    progress: { ...run.progress, runIds: [...run.progress.runIds] }
  };
}
