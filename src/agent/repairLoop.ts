import type { RepairLoopState, SafeNpmScript } from '../shared/types';

export class RepairLoopTracker {
  private readonly state: RepairLoopState;

  public constructor(
    maxIterations: number,
    private readonly recordTrace?: (event: { type: string; [key: string]: unknown }) => void,
    initialState?: RepairLoopState
  ) {
    this.state = initialState
      ? {
          ...initialState,
          maxIterations: Math.max(0, Math.floor(maxIterations)),
          pendingDraftEditIds: [...initialState.pendingDraftEditIds]
        }
      : {
          status: 'idle',
          iteration: 0,
          maxIterations: Math.max(0, Math.floor(maxIterations)),
          pendingDraftEditIds: []
        };
  }

  public startValidation(script: SafeNpmScript): void {
    this.state.status = 'running_validation';
    this.state.lastValidationScript = script;
    this.state.stopReason = undefined;
    this.trace('repair_validation_started', { script });
  }

  public recordValidationResult(rawResult: string): { failed: boolean; limitReached: boolean; summary?: string } {
    const result = parseRecord(rawResult);
    if (result?.ok === true) {
      this.state.status = 'completed';
      this.state.lastFailureSummary = undefined;
      this.state.stopReason = 'validation_passed';
      this.trace('repair_validation_passed', { script: this.state.lastValidationScript, iteration: this.state.iteration });
      return { failed: false, limitReached: false };
    }

    // Authorization and precondition denials do not consume a repair attempt.
    const authorizedFailure = result?.authorized === true
      || (typeof result?.exitCode === 'number' && result.exitCode !== 0);
    if (!authorizedFailure) {
      if (result?.errorType === 'authorization_denied') {
        this.state.status = 'blocked';
        this.state.stopReason = 'authorization_denied';
      }
      return { failed: false, limitReached: false };
    }

    this.state.iteration += 1;
    const summary = summarizeValidationFailure(result);
    this.state.lastFailureSummary = summary;
    const limitReached = this.state.iteration > this.state.maxIterations || this.state.maxIterations === 0;
    this.state.status = limitReached ? 'blocked' : 'validation_failed';
    this.state.stopReason = limitReached ? 'repair_iteration_limit' : undefined;
    this.trace('repair_validation_failed', {
      script: this.state.lastValidationScript,
      iteration: this.state.iteration,
      maxIterations: this.state.maxIterations,
      failureSummary: summary,
      limitReached
    });
    return { failed: true, limitReached, summary };
  }

  public recordProblemsRead(): void {
    if (this.state.status !== 'validation_failed' && this.state.status !== 'reading_problems') {
      return;
    }
    this.state.status = 'reading_problems';
    this.trace('repair_problems_read', { iteration: this.state.iteration });
  }

  public beginRepair(): boolean {
    if (this.state.status === 'blocked' || this.state.iteration > this.state.maxIterations || this.state.maxIterations === 0) {
      this.state.status = 'blocked';
      this.state.stopReason = 'repair_iteration_limit';
      this.trace('repair_loop_stopped', {
        reason: 'repair_iteration_limit',
        iteration: this.state.iteration,
        maxIterations: this.state.maxIterations
      });
      return false;
    }
    if (this.state.status === 'validation_failed' || this.state.status === 'reading_problems' || this.state.status === 'generating_repair') {
      this.state.status = 'generating_repair';
      this.trace('repair_generation_started', { iteration: this.state.iteration });
    }
    return true;
  }

  public recordDraftEdit(editId: string): void {
    if (this.state.status !== 'generating_repair') {
      return;
    }
    if (!this.state.pendingDraftEditIds.includes(editId)) {
      this.state.pendingDraftEditIds.push(editId);
    }
    this.state.status = 'waiting_for_apply';
    this.state.stopReason = 'waiting_for_apply';
    this.trace('repair_loop_waiting_for_apply', {
      iteration: this.state.iteration,
      pendingDraftEditIds: [...this.state.pendingDraftEditIds]
    });
  }

  public hasPendingRepair(): boolean {
    return this.state.status === 'waiting_for_apply' && this.state.pendingDraftEditIds.length > 0;
  }

  public getState(): RepairLoopState {
    return { ...this.state, pendingDraftEditIds: [...this.state.pendingDraftEditIds] };
  }

  private trace(type: string, details: Record<string, unknown>): void {
    this.recordTrace?.({ type, ...details });
  }
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function summarizeValidationFailure(result: Record<string, unknown>): string {
  const diagnostics = result.diagnostics && typeof result.diagnostics === 'object' && !Array.isArray(result.diagnostics)
    ? result.diagnostics as Record<string, unknown>
    : undefined;
  const parts = [
    typeof result.error === 'string' ? result.error : undefined,
    typeof result.exitCode === 'number' ? `exitCode=${result.exitCode}` : undefined,
    diagnostics ? `diagnostics: errors=${Number(diagnostics.errors ?? 0)}, warnings=${Number(diagnostics.warnings ?? 0)}` : undefined
  ].filter(Boolean);
  return parts.join('; ').slice(0, 500) || 'Validation failed.';
}
