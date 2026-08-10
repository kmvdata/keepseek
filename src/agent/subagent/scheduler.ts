export class SubagentScheduler {
  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  public constructor(private readonly maxConcurrency: number) {
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error('Subagent maxConcurrency must be a positive integer.');
    }
  }

  public async run<T>(task: () => Promise<T>, options: { nested?: boolean } = {}): Promise<T> {
    await this.acquire(options.nested === true);
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  public getActiveCount(): number {
    return this.activeCount;
  }

  private async acquire(nested: boolean): Promise<void> {
    if (this.activeCount < this.maxConcurrency) {
      this.activeCount += 1;
      return;
    }
    if (nested) {
      throw new Error('Nested subagent acquisition would block and was rejected.');
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter();
      return;
    }
    this.activeCount = Math.max(0, this.activeCount - 1);
  }
}
