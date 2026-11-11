export class ApprovalCircuitBreaker {
  private readonly outcomes = new Map<string, Array<'approve' | 'deny' | 'needs_user' | 'unavailable'>>();

  public restore(rootTaskId: string, outcomes: Array<'approve' | 'deny'>): void {
    this.outcomes.set(rootTaskId, outcomes.slice(-50));
  }

  public record(rootTaskId: string, outcome: 'approve' | 'deny' | 'needs_user' | 'unavailable'): {
    tripped: boolean;
    reason?: 'consecutive_denials' | 'recent_denials';
  } {
    if (outcome === 'needs_user' || outcome === 'unavailable') return { tripped: false };
    const history = [...(this.outcomes.get(rootTaskId) ?? []), outcome].slice(-50);
    this.outcomes.set(rootTaskId, history);
    if (outcome !== 'deny') return { tripped: false };
    return this.current(rootTaskId);
  }

  public current(rootTaskId: string): { tripped: boolean; reason?: 'consecutive_denials' | 'recent_denials' } {
    const history = this.outcomes.get(rootTaskId) ?? [];
    const consecutive = countTrailingDenials(history);
    if (consecutive >= 3) return { tripped: true, reason: 'consecutive_denials' };
    if (history.filter((item) => item === 'deny').length >= 10) return { tripped: true, reason: 'recent_denials' };
    return { tripped: false };
  }

  public clear(rootTaskId?: string): void {
    if (rootTaskId) this.outcomes.delete(rootTaskId);
    else this.outcomes.clear();
  }
}

function countTrailingDenials(history: readonly string[]): number {
  let count = 0;
  for (let index = history.length - 1; index >= 0 && history[index] === 'deny'; index--) count++;
  return count;
}
