import { performance } from 'node:perf_hooks';

export interface StartupPerformanceDetails {
  bytesRead?: number;
  entries?: number;
  revision?: number;
  skipped?: boolean;
}

export interface StartupPerformanceEvent extends StartupPerformanceDetails {
  stage: string;
  elapsedMs: number;
  durationMs?: number;
}

/**
 * Low-overhead startup diagnostics. Values intentionally contain only timing,
 * byte counts and item counts; no user content or request-prefix data enters it.
 */
export class StartupPerformanceTrace {
  private readonly startedAt = performance.now();
  private readonly events: StartupPerformanceEvent[] = [];

  public mark(stage: string, details: StartupPerformanceDetails = {}): void {
    const event: StartupPerformanceEvent = {
      stage,
      elapsedMs: round(performance.now() - this.startedAt),
      ...details
    };
    this.events.push(event);
    console.debug(`KeepSeek startup: ${stage}`, event);
  }

  public async measure<T>(stage: string, work: () => Promise<T>, details: () => StartupPerformanceDetails = () => ({})): Promise<T> {
    const startedAt = performance.now();
    try {
      return await work();
    } finally {
      const event: StartupPerformanceEvent = {
        stage,
        elapsedMs: round(performance.now() - this.startedAt),
        durationMs: round(performance.now() - startedAt),
        ...details()
      };
      this.events.push(event);
      console.debug(`KeepSeek startup: ${stage}`, event);
    }
  }

  public measureSync<T>(stage: string, work: () => T, details: (value: T) => StartupPerformanceDetails = () => ({})): T {
    const startedAt = performance.now();
    const value = work();
    const event: StartupPerformanceEvent = {
      stage,
      elapsedMs: round(performance.now() - this.startedAt),
      durationMs: round(performance.now() - startedAt),
      ...details(value)
    };
    this.events.push(event);
    console.debug(`KeepSeek startup: ${stage}`, event);
    return value;
  }

  public snapshot(): readonly StartupPerformanceEvent[] {
    return this.events.map((event) => ({ ...event }));
  }
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
