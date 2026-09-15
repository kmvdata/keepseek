import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
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
}

export class GoalLease {
  private current?: GoalLeaseRecordV1;
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  public constructor(
    private readonly globalStorageUri: vscode.Uri,
    public readonly workspaceKey: string,
    public readonly ownerId: string = randomUUID(),
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now
  ) {}

  public async acquire(options: { allowStaleTakeover?: boolean; confirmState?: () => Promise<boolean> } = {}): Promise<GoalLeaseAcquireResult> {
    if (this.globalStorageUri.scheme !== 'file') return { acquired: false, reason: 'unsupported_storage' };
    const path = this.leasePath();
    const guard = `${path}.guard`;
    await mkdir(dirname(path), { recursive: true });
    let guardHandle;
    try { guardHandle = await acquireGuard(guard, this.ttlMs, this.now); }
    catch (error) { return { acquired: false, reason: isExists(error) ? 'lock_busy' : 'storage_error' }; }
    try {
      const previous = await readLease(path);
      const now = this.now();
      if (previous?.ownerId === this.ownerId && previous.expiresAt > now) {
        this.current = previous;
        return { acquired: true, lease: { ...previous } };
      }
      if (previous && previous.ownerId !== this.ownerId && previous.expiresAt > now) return { acquired: false, reason: 'held' };
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
    if (!this.current || this.globalStorageUri.scheme !== 'file') return false;
    const lease = await readLease(this.leasePath());
    return Boolean(lease && lease.workspaceKey === this.workspaceKey && lease.ownerId === this.ownerId
      && lease.fencingToken === this.current.fencingToken && lease.expiresAt > this.now());
  }

  public async heartbeat(): Promise<boolean> {
    if (!this.current || this.globalStorageUri.scheme !== 'file') return false;
    const guard = `${this.leasePath()}.guard`;
    let guardHandle;
    try { guardHandle = await acquireGuard(guard, this.ttlMs, this.now); }
    catch { return false; }
    try {
      const latest = await readLease(this.leasePath());
      if (!latest || latest.ownerId !== this.current.ownerId || latest.fencingToken !== this.current.fencingToken
        || latest.expiresAt <= this.now()) return false;
      const now = this.now();
      const next = { ...this.current, heartbeatAt: now, expiresAt: now + this.ttlMs };
      await atomicWrite(this.leasePath(), JSON.stringify(next));
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
    if (!this.current || this.globalStorageUri.scheme !== 'file') return;
    const guard = `${this.leasePath()}.guard`;
    let guardHandle;
    try { guardHandle = await acquireGuard(guard, this.ttlMs, this.now); } catch { this.current = undefined; return; }
    try {
      const latest = await readLease(this.leasePath());
      if (latest?.ownerId === this.ownerId && latest.fencingToken === this.current.fencingToken) {
        await unlink(this.leasePath()).catch(() => undefined);
      }
    } finally { await guardHandle.close(); await unlink(guard).catch(() => undefined); }
    this.current = undefined;
  }

  public get binding(): { ownerId: string; fencingToken: number } | undefined {
    return this.current ? { ownerId: this.current.ownerId, fencingToken: this.current.fencingToken } : undefined;
  }

  private leasePath(): string {
    const name = createHash('sha256').update(this.workspaceKey, 'utf8').digest('hex');
    return vscode.Uri.joinPath(this.globalStorageUri, 'goals', 'leases', `${name}.json`).fsPath;
  }
  private counterPath(): string { return `${this.leasePath()}.fence`; }
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
