import * as vscode from 'vscode';
import type { ModelSourceBalanceState } from '../../shared/types';
import { isRecord } from '../../shared/errors';
import { isModelSourceProvider } from '../../accounts/accountStore';
import type { ModelSourceProvider } from '../../accounts/types';
import { normalizeBalanceStateValue } from '../usageStats';

/** Identifies the model source whose balance and refresh throttle are being stored. */
export interface BalanceSourceScope {
  provider: ModelSourceProvider;
  sourceId: string;
}

/**
 * Each source has its own globally shared balance record. Multiple workspaces and
 * windows using the same source still share one snapshot and one throttle clock.
 */
export interface GlobalBalanceRecord {
  /** 最近一次成功（或失败）刷新得到的余额快照；无记录时为 undefined。 */
  balance?: ModelSourceBalanceState;
  /** 上次真正发起余额请求的时刻（epoch ms）；0 表示从未请求过。 */
  lastRefreshAt: number;
}

const BALANCE_STORAGE_DIR = 'balance';
const BALANCE_STORAGE_FILE = 'balance.json';
const DEFAULT_BALANCE_SOURCE_SCOPE: BalanceSourceScope = {
  provider: 'deepseek',
  sourceId: 'default'
};
const SAFE_PATH_SEGMENT_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

// Different Provider instances can own different stores inside one extension host.
// Serialize the read-check-reserve sequence per persisted source so two callers
// cannot both observe an expired timestamp before either reservation is written.
const refreshClaimLocks = new Map<string, Promise<void>>();
const activeRefreshClaims = new Map<string, { owner: object; token: symbol }>();

export function normalizeGlobalBalanceRecord(value: unknown): GlobalBalanceRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const lastRefreshAt = readFiniteNonNegativeTimestamp(value.lastRefreshAt);
  const balance = normalizeBalanceStateValue(value.balance);
  if (balance === undefined && lastRefreshAt <= 0) {
    return undefined;
  }
  return { balance, lastRefreshAt };
}

function readFiniteNonNegativeTimestamp(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Source-scoped global balance store. Records live at
 * `globalStorageUri/accounts/<provider>/<sourceId>/balance.json`. The optional scope on
 * each operation makes model-source selection explicit; callers that omit it retain
 * the legacy DeepSeek/default behavior.
 */
export class GlobalBalanceStore {
  private readonly records = new Map<string, GlobalBalanceRecord>();
  private readonly refreshClaimTokens = new Map<string, symbol>();
  private activeScope: BalanceSourceScope;
  private readonly accountsRootUri: vscode.Uri;
  private readonly legacyFileUri: vscode.Uri;
  private readonly globalStorageKey: string;
  private readonly decoder = new TextDecoder();

  public constructor(
    globalStorageUri: vscode.Uri,
    initialScope: BalanceSourceScope = DEFAULT_BALANCE_SOURCE_SCOPE
  ) {
    this.accountsRootUri = vscode.Uri.joinPath(globalStorageUri, 'accounts');
    this.legacyFileUri = vscode.Uri.joinPath(globalStorageUri, BALANCE_STORAGE_DIR, BALANCE_STORAGE_FILE);
    this.globalStorageKey = globalStorageUri.toString();
    this.activeScope = normalizeBalanceSourceScope(initialScope);
  }

  /** Selects the model source used by operations whose scope argument is omitted. */
  public selectSource(scope: BalanceSourceScope): void {
    this.activeScope = normalizeBalanceSourceScope(scope);
  }

  /** 当前来源在内存中的全局余额快照（同步读取，供 UI 立即展示）。 */
  public getBalance(scope?: BalanceSourceScope): ModelSourceBalanceState | undefined {
    return this.records.get(this.getScopeKey(scope))?.balance;
  }

  /** 从磁盘读取来源最新记录并刷新内存缓存；文件缺失或损坏时视为无记录。 */
  public async refreshFromDisk(scope?: BalanceSourceScope): Promise<void> {
    const normalizedScope = this.getScope(scope);
    const scopeKey = getBalanceScopeKey(normalizedScope);
    const fileUri = this.getFileUri(normalizedScope);
    const record = await this.readRecord(fileUri)
      ?? await this.readLegacyDefaultRecord(normalizedScope);
    this.records.set(scopeKey, record ?? { lastRefreshAt: 0 });
  }

  /** 距该来源上次请求是否已超过限流间隔（force 时始终视为到期）。 */
  public async isRefreshDue(
    now: number,
    intervalMs: number,
    force?: boolean,
    scope?: BalanceSourceScope
  ): Promise<boolean> {
    const normalizedScope = this.getScope(scope);
    await this.refreshFromDisk(normalizedScope);
    const record = this.records.get(getBalanceScopeKey(normalizedScope)) ?? { lastRefreshAt: 0 };
    return Boolean(force) || now - record.lastRefreshAt >= intervalMs;
  }

  /**
   * Atomically claims this source's next refresh within the current extension
   * host. A successful claim persists its timestamp before returning so other
   * stores and windows observe the reservation before any network request starts.
   */
  public async claimRefresh(
    now: number,
    intervalMs: number,
    force?: boolean,
    scope?: BalanceSourceScope
  ): Promise<boolean> {
    const normalizedScope = this.getScope(scope);
    const scopeKey = getBalanceScopeKey(normalizedScope);
    const claimKey = this.getRefreshClaimKey(normalizedScope);

    return withRefreshClaimLock(claimKey, async () => {
      await this.refreshFromDisk(normalizedScope);
      if (activeRefreshClaims.has(claimKey)) {
        return false;
      }

      const record = this.records.get(scopeKey) ?? { lastRefreshAt: 0 };
      if (!force && now - record.lastRefreshAt < intervalMs) {
        return false;
      }

      const reservation: GlobalBalanceRecord = {
        balance: record.balance,
        lastRefreshAt: now
      };
      try {
        await this.writeRecordOrThrow(normalizedScope, reservation);
      } catch {
        // A reservation that exists only in memory cannot enforce the promised
        // cross-store throttle. Do not allow the network request to start.
        return false;
      }
      const token = Symbol(claimKey);
      this.records.set(scopeKey, reservation);
      this.refreshClaimTokens.set(claimKey, token);
      activeRefreshClaims.set(claimKey, { owner: this, token });
      return true;
    });
  }

  /** Releases an in-flight refresh claim owned by this store. */
  public releaseRefreshClaim(scope?: BalanceSourceScope): void {
    const normalizedScope = this.getScope(scope);
    const claimKey = this.getRefreshClaimKey(normalizedScope);
    const token = this.refreshClaimTokens.get(claimKey);
    this.refreshClaimTokens.delete(claimKey);
    const activeClaim = activeRefreshClaims.get(claimKey);
    if (token && activeClaim?.owner === this && activeClaim.token === token) {
      activeRefreshClaims.delete(claimKey);
    }
  }

  /** 写入该来源最新余额快照并推进其全局限流时间戳。 */
  public async update(
    balance: ModelSourceBalanceState,
    now: number,
    scope?: BalanceSourceScope
  ): Promise<void> {
    const normalizedScope = this.getScope(scope);
    const scopeKey = getBalanceScopeKey(normalizedScope);
    const claimKey = this.getRefreshClaimKey(normalizedScope);
    await withRefreshClaimLock(claimKey, async () => {
      const token = this.refreshClaimTokens.get(claimKey);
      if (token) {
        this.refreshClaimTokens.delete(claimKey);
        const activeClaim = activeRefreshClaims.get(claimKey);
        if (activeClaim?.owner !== this || activeClaim.token !== token) {
          // clear/delete invalidated this request while it was in flight. Its
          // stale result must not recreate a removed file or overwrite a new key.
          this.records.set(scopeKey, { lastRefreshAt: 0 });
          return;
        }
      }

      const record = { balance, lastRefreshAt: now };
      this.records.set(scopeKey, record);
      try {
        await this.writeRecord(normalizedScope, record);
      } finally {
        const activeClaim = activeRefreshClaims.get(claimKey);
        if (token && activeClaim?.owner === this && activeClaim.token === token) {
          activeRefreshClaims.delete(claimKey);
        }
      }
    });
  }

  /** 清空单个来源记录（例如其 API key / endpoint 变更后强制刷新）。 */
  public async clear(scope?: BalanceSourceScope): Promise<void> {
    const normalizedScope = this.getScope(scope);
    const claimKey = this.getRefreshClaimKey(normalizedScope);
    await withRefreshClaimLock(claimKey, async () => {
      activeRefreshClaims.delete(claimKey);
      this.records.set(getBalanceScopeKey(normalizedScope), { lastRefreshAt: 0 });
      await this.deleteFile(this.getFileUri(normalizedScope));

      // The old shared file belongs to the historical DeepSeek/default source.
      // Removing it prevents a cleared source from being repopulated by fallback.
      if (isDefaultBalanceSourceScope(normalizedScope)) {
        await this.deleteFile(this.legacyFileUri);
      }
    });
  }

  /** Physically removes a deleted source's balance file and cached snapshot. */
  public async deleteSource(scope: BalanceSourceScope): Promise<void> {
    const normalizedScope = this.getScope(scope);
    const claimKey = this.getRefreshClaimKey(normalizedScope);
    await withRefreshClaimLock(claimKey, async () => {
      activeRefreshClaims.delete(claimKey);
      this.records.set(getBalanceScopeKey(normalizedScope), { lastRefreshAt: 0 });
      await this.deleteFileOrThrow(this.getFileUri(normalizedScope));
      if (isDefaultBalanceSourceScope(normalizedScope)) {
        await this.deleteFileOrThrow(this.legacyFileUri);
      }
    });
  }

  private getScope(scope?: BalanceSourceScope): BalanceSourceScope {
    return scope ? normalizeBalanceSourceScope(scope) : this.activeScope;
  }

  private getScopeKey(scope?: BalanceSourceScope): string {
    return getBalanceScopeKey(this.getScope(scope));
  }

  private getFileUri(scope: BalanceSourceScope): vscode.Uri {
    return vscode.Uri.joinPath(this.accountsRootUri, scope.provider, scope.sourceId, BALANCE_STORAGE_FILE);
  }

  private getRefreshClaimKey(scope: BalanceSourceScope): string {
    return JSON.stringify([this.globalStorageKey, scope.provider, scope.sourceId]);
  }

  private async readLegacyDefaultRecord(scope: BalanceSourceScope): Promise<GlobalBalanceRecord | undefined> {
    return isDefaultBalanceSourceScope(scope) ? this.readRecord(this.legacyFileUri) : undefined;
  }

  private async readRecord(fileUri: vscode.Uri): Promise<GlobalBalanceRecord | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(fileUri);
      const parsed: unknown = JSON.parse(this.decoder.decode(bytes));
      return normalizeGlobalBalanceRecord(parsed);
    } catch {
      return undefined;
    }
  }

  private async writeRecord(scope: BalanceSourceScope, record: GlobalBalanceRecord): Promise<void> {
    try {
      await this.writeRecordOrThrow(scope, record);
    } catch {
      // 余额记录是次要展示数据：写入失败时保留内存快照，下次刷新再重试。
    }
  }

  private async writeRecordOrThrow(
    scope: BalanceSourceScope,
    record: GlobalBalanceRecord
  ): Promise<void> {
    const dirUri = vscode.Uri.joinPath(this.accountsRootUri, scope.provider, scope.sourceId);
    await vscode.workspace.fs.createDirectory(dirUri);
    await vscode.workspace.fs.writeFile(
      this.getFileUri(scope),
      new TextEncoder().encode(`${JSON.stringify(record, null, 2)}\n`)
    );
  }

  private async deleteFile(fileUri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(fileUri, { useTrash: false });
    } catch {
      // 文件不存在时忽略：无记录状态即目标状态。
    }
  }

  private async deleteFileOrThrow(fileUri: vscode.Uri): Promise<void> {
    try {
      await vscode.workspace.fs.delete(fileUri, { useTrash: false });
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
    }
  }
}

function normalizeBalanceSourceScope(scope: BalanceSourceScope): BalanceSourceScope {
  const sourceId = scope.sourceId.trim();
  if (!SAFE_PATH_SEGMENT_PATTERN.test(sourceId) || sourceId === '.' || sourceId === '..') {
    throw new Error('Invalid balance source id.');
  }
  if (!isModelSourceProvider(scope.provider)) {
    throw new Error('Invalid balance source provider.');
  }
  return { provider: scope.provider, sourceId };
}

function getBalanceScopeKey(scope: BalanceSourceScope): string {
  return `${scope.provider}/${scope.sourceId}`;
}

function isDefaultBalanceSourceScope(scope: BalanceSourceScope): boolean {
  return scope.provider === DEFAULT_BALANCE_SOURCE_SCOPE.provider
    && scope.sourceId === DEFAULT_BALANCE_SOURCE_SCOPE.sourceId;
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'FileNotFound' || error.code === 'ENOENT');
}

async function withRefreshClaimLock<T>(key: string, action: () => Promise<T>): Promise<T> {
  const previous = refreshClaimLocks.get(key);
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  refreshClaimLocks.set(key, current);

  if (previous) {
    await previous;
  }
  try {
    return await action();
  } finally {
    releaseCurrent();
    if (refreshClaimLocks.get(key) === current) {
      refreshClaimLocks.delete(key);
    }
  }
}
