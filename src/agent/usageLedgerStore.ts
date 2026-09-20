import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { writeJsonAtomic } from '../shared/atomicStorage';
import type { ChatSession, ProviderUsageLedger, ProviderUsageLedgerRecord } from '../shared/types';
import { normalizeUsageLedgerRecord, normalizeUsageLedgerValue, summarizeUsageLedger } from './usageLedger';

export const USAGE_LEDGER_STORE_SCHEMA_VERSION = 2;
export const USAGE_LEDGER_STORE_BUCKET_COUNT = 256;

interface StoredUsageLedgerBucket {
  version: 2;
  sessionIdentity: string;
  bucket: number;
  records: ProviderUsageLedgerRecord[];
  updatedAt: string;
}

export interface UsageLedgerPage {
  records: ProviderUsageLedgerRecord[];
  total: number;
  nextCursor?: string;
  incomplete: boolean;
  damagedBucketCount: number;
}

/**
 * A bounded-write, content-free ledger. Each append rewrites at most one of
 * 256 deterministic buckets rather than the session JSON or the whole ledger.
 */
export class UsageLedgerStore {
  private readonly decoder = new TextDecoder();
  private readonly queues = new Map<string, Promise<unknown>>();

  public constructor(private readonly globalStorageUri?: vscode.Uri) {}

  public async append(sessionId: string, record: ProviderUsageLedgerRecord): Promise<boolean> {
    const result = await this.appendMany(sessionId, [record]);
    return result.appended > 0;
  }

  public async appendMany(
    sessionId: string,
    records: readonly ProviderUsageLedgerRecord[]
  ): Promise<{ appended: number; duplicates: number }> {
    if (!this.globalStorageUri || !sessionId.trim() || !records.length) return { appended: 0, duplicates: 0 };
    return await this.enqueue(sessionId, async () => {
      const normalized = records.map(normalizeUsageLedgerRecord).filter(
        (record): record is ProviderUsageLedgerRecord => Boolean(record)
      );
      const groups = new Map<number, ProviderUsageLedgerRecord[]>();
      for (const record of normalized) {
        const bucket = bucketFor(record);
        groups.set(bucket, [...(groups.get(bucket) ?? []), record]);
      }
      let appended = 0;
      let duplicates = records.length - normalized.length;
      for (const [bucket, additions] of groups) {
        const existing = await this.readBucket(sessionId, bucket);
        if (existing.damaged) {
          // Never overwrite an unreadable bucket. Other buckets remain usable
          // and the caller can surface the incomplete marker.
          throw new Error(`Usage ledger bucket ${bucket} is damaged.`);
        }
        const seen = new Set(existing.records.map(recordIdentity));
        const unique = additions.filter((record) => {
          const identity = recordIdentity(record);
          if (seen.has(identity)) {
            duplicates += 1;
            return false;
          }
          seen.add(identity);
          return true;
        });
        if (!unique.length) continue;
        const sessionIdentity = hashText(sessionId);
        await writeJsonAtomic(this.bucketUri(sessionIdentity, bucket), {
          version: USAGE_LEDGER_STORE_SCHEMA_VERSION,
          sessionIdentity,
          bucket,
          records: [...existing.records, ...unique],
          updatedAt: new Date().toISOString()
        } satisfies StoredUsageLedgerBucket);
        appended += unique.length;
      }
      return { appended, duplicates };
    });
  }

  public async readPage(
    sessionId: string,
    options: { cursor?: string; limit?: number; taskId?: string } = {}
  ): Promise<UsageLedgerPage> {
    if (!this.globalStorageUri) return { records: [], total: 0, incomplete: false, damagedBucketCount: 0 };
    const { records, damagedBucketCount } = await this.collectRecords(sessionId, options.taskId);
    const offset = decodeCursor(options.cursor);
    const limit = Math.max(1, Math.min(1_000, Math.floor(options.limit ?? 200)));
    const pageRecords = records.slice(offset, offset + limit);
    const nextOffset = offset + pageRecords.length;
    return {
      records: pageRecords,
      total: records.length,
      ...(nextOffset < records.length ? { nextCursor: encodeCursor(nextOffset) } : {}),
      incomplete: damagedBucketCount > 0,
      damagedBucketCount
    };
  }

  public async readAll(sessionId: string, taskId?: string): Promise<UsageLedgerPage> {
    if (!this.globalStorageUri) return { records: [], total: 0, incomplete: false, damagedBucketCount: 0 };
    const { records, damagedBucketCount } = await this.collectRecords(sessionId, taskId);
    return {
      records,
      total: records.length,
      incomplete: damagedBucketCount > 0,
      damagedBucketCount
    };
  }

  public async migrateInlineLedger(
    session: Pick<ChatSession, 'id' | 'usageLedger' | 'usageLedgerRef' | 'usageStats'>
  ): Promise<NonNullable<ChatSession['usageLedgerRef']> | undefined> {
    const inline = normalizeUsageLedgerValue(session.usageLedger);
    if (!inline?.records.length && !session.usageLedgerRef) return undefined;
    if (inline?.records.length) await this.appendMany(session.id, inline.records);
    const restored = await this.readAll(session.id);
    const restoredIdentities = new Set(restored.records.map(recordIdentity));
    if (inline && inline.records.some((record) => !restoredIdentities.has(recordIdentity(record)))) {
      throw new Error('Usage ledger migration verification failed.');
    }
    return {
      version: USAGE_LEDGER_STORE_SCHEMA_VERSION,
      sessionId: session.id,
      migratedInlineVersion: inline ? 1 : session.usageLedgerRef?.migratedInlineVersion,
      legacyAggregate: inline?.legacyAggregate ?? session.usageLedgerRef?.legacyAggregate
        ?? Boolean(session.usageStats?.legacyUnattributed),
      incomplete: Boolean(inline?.incomplete || session.usageLedgerRef?.incomplete || restored.incomplete),
      ...(restored.damagedBucketCount ? { damagedBucketCount: restored.damagedBucketCount } : {})
    };
  }

  public async rebuild(sessionId: string): Promise<{
    ledger: ProviderUsageLedger;
    summary: ReturnType<typeof summarizeUsageLedger>;
    damagedBucketCount: number;
  }> {
    const page = await this.readAll(sessionId);
    const ledger: ProviderUsageLedger = {
      version: 1,
      records: page.records,
      legacyAggregate: false,
      incomplete: page.incomplete
    };
    return { ledger, summary: summarizeUsageLedger(ledger), damagedBucketCount: page.damagedBucketCount };
  }

  public async deleteSession(sessionId: string): Promise<void> {
    if (!this.globalStorageUri || !sessionId.trim()) return;
    try {
      await vscode.workspace.fs.delete(this.sessionUri(hashText(sessionId)), { recursive: true, useTrash: false });
    } catch {
      // Missing or partially removed ledger directories are already clean.
    }
  }

  private async readBucket(sessionId: string, bucket: number): Promise<{
    records: ProviderUsageLedgerRecord[];
    damaged: boolean;
  }> {
    const sessionIdentity = hashText(sessionId);
    try {
      const bytes = await vscode.workspace.fs.readFile(this.bucketUri(sessionIdentity, bucket));
      const value: unknown = JSON.parse(this.decoder.decode(bytes));
      if (!isBucket(value, sessionIdentity, bucket)) return { records: [], damaged: true };
      const records = value.records.map(normalizeUsageLedgerRecord).filter(
        (record): record is ProviderUsageLedgerRecord => Boolean(record)
      );
      return { records, damaged: records.length !== value.records.length };
    } catch (error) {
      return isMissingFileError(error) ? { records: [], damaged: false } : { records: [], damaged: true };
    }
  }

  private async collectRecords(sessionId: string, taskId?: string): Promise<{
    records: ProviderUsageLedgerRecord[];
    damagedBucketCount: number;
  }> {
    const records: ProviderUsageLedgerRecord[] = [];
    let damagedBucketCount = 0;
    for (let bucket = 0; bucket < USAGE_LEDGER_STORE_BUCKET_COUNT; bucket += 1) {
      const stored = await this.readBucket(sessionId, bucket);
      if (stored.damaged) damagedBucketCount += 1;
      records.push(...stored.records.filter((record) => !taskId
        || record.cacheObservation?.taskId === taskId));
    }
    records.sort(compareRecords);
    return { records, damagedBucketCount };
  }

  private sessionUri(sessionIdentity: string): vscode.Uri {
    return vscode.Uri.joinPath(this.globalStorageUri!, 'usage-ledger', 'v2', sessionIdentity);
  }

  private bucketUri(sessionIdentity: string, bucket: number): vscode.Uri {
    return vscode.Uri.joinPath(this.sessionUri(sessionIdentity), `bucket-${bucket.toString(16).padStart(2, '0')}.json`);
  }

  private async enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(sessionId, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(sessionId) === current) this.queues.delete(sessionId);
    }
  }
}

function bucketFor(record: ProviderUsageLedgerRecord): number {
  return createHash('sha256').update(recordIdentity(record), 'utf8').digest()[0] ?? 0;
}

function recordIdentity(record: Pick<ProviderUsageLedgerRecord, 'requestId' | 'attemptIndex'>): string {
  return `${record.requestId}\u0000${record.attemptIndex}`;
}

function compareRecords(left: ProviderUsageLedgerRecord, right: ProviderUsageLedgerRecord): number {
  return left.requestStartedAt.localeCompare(right.requestStartedAt)
    || left.requestId.localeCompare(right.requestId)
    || left.attemptIndex - right.attemptIndex;
}

function isBucket(value: unknown, sessionIdentity: string, bucket: number): value is StoredUsageLedgerBucket {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Partial<StoredUsageLedgerBucket>;
  return item.version === USAGE_LEDGER_STORE_SCHEMA_VERSION && item.sessionIdentity === sessionIdentity
    && item.bucket === bucket && Array.isArray(item.records);
}

function hashText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ version: 1, offset }), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { version?: unknown; offset?: unknown };
    return parsed.version === 1 && Number.isSafeInteger(parsed.offset) && Number(parsed.offset) >= 0
      ? Number(parsed.offset) : 0;
  } catch {
    return 0;
  }
}

function isMissingFileError(error: unknown): boolean {
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  return code === 'FileNotFound' || code === 'ENOENT';
}
