import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import * as vscode from 'vscode';

export interface GoalLeaseRecordV1 {
  version: 1;
  workspaceKey: string;
  ownerId: string;
  fencingToken: number;
  heartbeatAt: number;
  expiresAt: number;
}

export interface GoalLeaseAcquireResult {
  acquired: boolean;
  lease?: GoalLeaseRecordV1;
  reason?: 'unsupported_storage' | 'held' | 'lock_busy' | 'state_changed' | 'storage_error';
  /** Bounded time until a held lease/guard can first be considered stale. */
  retryAfterMs?: number;
}

export interface GoalLeaseOptions {
  ownerId?: string;
  ttlMs?: number;
  now?: () => number;
  /** Absolute Extension Host path corresponding to globalStorageUri. This is
   * the Node-host fallback when a desktop-compatible host exposes storage
   * through a non-file URI scheme. */
  nativeStoragePath?: string;
}

export class GoalLease {
  private current?: GoalLeaseRecordV1;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  public readonly ownerId: string;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly nativeStoragePath?: string;

  public constructor(
    private readonly globalStorageUri: vscode.Uri,
    public readonly workspaceKey: string,
    options: GoalLeaseOptions = {}
  ) {
    this.ownerId = options.ownerId ?? randomUUID();
    this.ttlMs = options.ttlMs ?? 30_000;
    this.now = options.now ?? Date.now;
    this.nativeStoragePath = normalizeNativeStoragePath(options.nativeStoragePath);
  }

  public get supported(): boolean { return this.leasePath() !== undefined; }

  public async acquire(options: { allowStaleTakeover?: boolean; confirmState?: () => Promise<boolean> } = {}): Promise<GoalLeaseAcquireResult> {
    const path = this.leasePath();
    if (!path) return { acquired: false, reason: 'unsupported_storage' };
    const guard = `${path}.guard`;
    await mkdir(dirname(path), { recursive: true });
    let guardHandle;
    try { guardHandle = await acquireGuard(guard, this.ttlMs, this.now); }
    catch (error) {
      if (!isExists(error)) return { acquired: false, reason: 'storage_error' };
      const guardStat = await stat(guard).catch(() => undefined);
      return {
        acquired: false,
        reason: 'lock_busy',
        retryAfterMs: guardStat
          ? boundedRetryAfter(this.ttlMs - (this.now() - guardStat.mtimeMs), this.ttlMs)
          : undefined
      };
    }
    try {
      const previous = await readLease(path);
      const now = this.now();
      if (previous?.ownerId === this.ownerId && previous.expiresAt > now) {
        this.current = previous;
        return { acquired: true, lease: { ...previous } };
      }
      if (previous && previous.ownerId !== this.ownerId && previous.expiresAt > now) {
        return {
          acquired: false,
          reason: 'held',
          retryAfterMs: boundedRetryAfter(previous.expiresAt - now, this.ttlMs)
        };
      }
      if (previous && previous.ownerId !== this.ownerId) {
        if (!options.allowStaleTakeover) return { acquired: false, reason: 'held' };
        if (options.confirmState && !(await options.confirmState())) return { acquired: false, reason: 'state_changed' };
        const reread = await readLease(path);
        if (!reread || reread.ownerId !== previous.ownerId || reread.fencingToken !== previous.fencingToken || reread.expiresAt > this.now()) {
          return { acquired: false, reason: 'state_changed' };
        }
      }
      const counter = await readCounter(this.counterPath());
      const fencingToken = Math.max(counter, previous?.fencingToken ?? 0) + 1;
      const lease: GoalLeaseRecordV1 = {
        version: 1, workspaceKey: this.workspaceKey, ownerId: this.ownerId,
        fencingToken, heartbeatAt: now, expiresAt: now + this.ttlMs
      };
      await atomicWrite(this.counterPath(), JSON.stringify({ version: 1, value: fencingToken }));
      await atomicWrite(path, JSON.stringify(lease));
      this.current = lease;
      return { acquired: true, lease: { ...lease } };
    } catch {
      return { acquired: false, reason: 'storage_error' };
    } finally {
      await guardHandle.close();
      await unlink(guard).catch(() => undefined);
    }
  }

  public async confirm(): Promise<boolean> {
    const path = this.leasePath();
    if (!this.current || !path) return false;
    const lease = await readLease(path);
    return Boolean(lease && lease.workspaceKey === this.workspaceKey && lease.ownerId === this.ownerId
      && lease.fencingToken === this.current.fencingToken && lease.expiresAt > this.now());
  }

  public async heartbeat(): Promise<boolean> {
    const path = this.leasePath();
    if (!this.current || !path) return false;
    const guard = `${path}.guard`;
    let guardHandle;
    try { guardHandle = await acquireGuard(guard, this.ttlMs, this.now); }
    catch { return false; }
    try {
      const latest = await readLease(path);
      if (!latest || latest.ownerId !== this.current.ownerId || latest.fencingToken !== this.current.fencingToken
        || latest.expiresAt <= this.now()) return false;
      const now = this.now();
      const next = { ...this.current, heartbeatAt: now, expiresAt: now + this.ttlMs };
      await atomicWrite(path, JSON.stringify(next));
      this.current = next;
      return true;
    } finally {
      await guardHandle.close();
      await unlink(guard).catch(() => undefined);
    }
  }

  public startHeartbeat(onLost?: () => void): void {
    if (this.heartbeatTimer || !this.current) return;
    this.heartbeatTimer = setInterval(() => {
      void this.heartbeat().then((ok) => { if (!ok) { this.stopHeartbeat(); this.current = undefined; onLost?.(); } });
    }, Math.max(250, Math.floor(this.ttlMs / 3)));
    this.heartbeatTimer.unref?.();
  }

  public stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  public async release(): Promise<void> {
    this.stopHeartbeat();
    const path = this.leasePath();
    if (!this.current || !path) return;
    const guard = `${path}.guard`;
    let guardHandle;
    try { guardHandle = await acquireGuard(guard, this.ttlMs, this.now); } catch { this.current = undefined; return; }
    try {
      const latest = await readLease(path);
      if (latest?.ownerId === this.ownerId && latest.fencingToken === this.current.fencingToken) {
        await unlink(path).catch(() => undefined);
      }
    } finally { await guardHandle.close(); await unlink(guard).catch(() => undefined); }
    this.current = undefined;
  }

  public get binding(): { ownerId: string; fencingToken: number } | undefined {
    return this.current ? { ownerId: this.current.ownerId, fencingToken: this.current.fencingToken } : undefined;
  }

  private leasePath(): string | undefined {
    const storagePath = this.globalStorageUri.scheme === 'file'
      ? this.globalStorageUri.fsPath
      : this.nativeStoragePath;
    if (!storagePath) return undefined;
    const name = createHash('sha256').update(this.workspaceKey, 'utf8').digest('hex');
    return join(storagePath, 'goals', 'leases', `${name}.json`);
  }
  private counterPath(): string {
    const path = this.leasePath();
    if (!path) throw new Error('Goal lease storage is unavailable.');
    return `${path}.fence`;
  }
}

function normalizeNativeStoragePath(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && isAbsolute(normalized) && dirname(normalized) !== normalized ? normalized : undefined;
}

async function readLease(path: string): Promise<GoalLeaseRecordV1 | undefined> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as GoalLeaseRecordV1;
    if (value.version !== 1 || !value.workspaceKey || !value.ownerId || !Number.isSafeInteger(value.fencingToken)
      || value.fencingToken < 1 || !Number.isFinite(value.heartbeatAt) || !Number.isFinite(value.expiresAt)) return undefined;
    return value;
  } catch (error) { if (isMissing(error)) return undefined; throw error; }
}

async function readCounter(path: string): Promise<number> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as { version?: number; value?: number };
    return value.version === 1 && Number.isSafeInteger(value.value) && (value.value ?? 0) >= 0 ? value.value ?? 0 : 0;
  } catch (error) { if (isMissing(error)) return 0; throw error; }
}

async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
  try { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } } catch {
    // Some file systems do not support directory fsync.
  }
}

function isMissing(error: unknown): boolean { return (error as { code?: string }).code === 'ENOENT'; }
function isExists(error: unknown): boolean { return (error as { code?: string }).code === 'EEXIST'; }
function boundedRetryAfter(value: number, ttlMs: number): number {
  return Math.max(1, Math.min(Math.ceil(value), ttlMs));
}

async function acquireGuard(path: string, ttlMs: number, now: () => number) {
  try { return await open(path, 'wx', 0o600); }
  catch (error) {
    if (!isExists(error)) throw error;
    const first = await stat(path).catch(() => undefined);
    if (!first || now() - first.mtimeMs <= ttlMs) throw error;
    const second = await stat(path).catch(() => undefined);
    if (!second || second.ino !== first.ino || second.mtimeMs !== first.mtimeMs) throw error;
    await unlink(path).catch(() => undefined);
    return await open(path, 'wx', 0o600);
  }
}
