/** One in-flight commit and one latest pending snapshot. A barrier resolves only
 * after its revision (or a newer superset) commits. Errors never retry a snapshot. */
export class CoalescedWriter<T> {
  private revision = 0;
  private pending?: { revision: number; value: T };
  private drain?: Promise<void>;
  private readonly waiters: Array<{ revision: number; resolve: () => void; reject: (error: unknown) => void }> = [];
  public constructor(private readonly commit: (value: T) => Promise<void>) {}
  public save(value: T): Promise<void> {
    const revision = ++this.revision;
    this.pending = { revision, value };
    const promise = new Promise<void>((resolve, reject) => this.waiters.push({ revision, resolve, reject }));
    this.start();
    return promise;
  }
  public get pendingSnapshots(): number { return Number(Boolean(this.drain)) + Number(Boolean(this.pending)); }
  private start(): void {
    if (this.drain) return;
    this.drain = this.run().finally(() => { this.drain = undefined; if (this.pending) this.start(); });
  }
  private async run(): Promise<void> {
    while (this.pending) {
      const next = this.pending; this.pending = undefined;
      let error: unknown;
      try { await this.commit(next.value); } catch (failure) { error = failure; }
      for (let i = this.waiters.length - 1; i >= 0; i--) {
        const waiter = this.waiters[i];
        if (waiter.revision > next.revision) continue;
        this.waiters.splice(i, 1);
        if (error !== undefined) waiter.reject(error); else waiter.resolve();
      }
    }
  }
}
