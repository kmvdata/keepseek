import { createHash } from 'node:crypto';

export class ContextUsageEstimateCache<T> {
  private readonly entries = new Map<string, T>();

  public constructor(private readonly maxEntries = 16) {}

  public getOrCompute(key: string, compute: () => T): T {
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, cached);
      return cached;
    }
    const value = compute();
    this.entries.set(key, value);
    while (this.entries.size > Math.max(1, this.maxEntries)) {
      const oldestKey = this.entries.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.entries.delete(oldestKey);
    }
    return value;
  }

  public clear(): void {
    this.entries.clear();
  }
}

export function createContextUsageCacheKey(input: {
  sessionId: string;
  sessionUpdatedAt: string;
  messageCount: number;
  lastMessageSignature: string;
  sourceId: string;
  modelId: string;
  agentSettings: unknown;
  contextInstructions: string;
  contextProjectionFingerprint: string;
  contextFileFingerprints: readonly string[];
  requestProtocolVersion?: number;
  toolSchemaVersion?: number;
  toolNames: readonly string[];
}): string {
  const hash = createHash('sha256');
  hash.update(JSON.stringify(input));
  return hash.digest('hex');
}
