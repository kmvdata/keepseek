import * as vscode from 'vscode';
import type { DeepSeekBalanceState } from '../../shared/types';
import { isRecord } from '../../shared/errors';
import { normalizeBalanceStateValue } from '../usageStats';

/**
 * 全局余额记录存储在 `globalStorageUri/balance/balance.json`，所有工程
 * （跨 workspace、跨窗口）共享同一份物理文件：
 * - 余额快照：任意工程弹出“用量统计”都优先展示这份记录；
 * - 限流时间戳 lastRefreshAt：任意工程发起余额请求前都先读磁盘判断，
 *   间隔内一律忽略，保证全局只有一份真正的请求节奏。
 */
export interface GlobalBalanceRecord {
  /** 最近一次成功（或失败）刷新得到的余额快照；无记录时为 undefined。 */
  balance?: DeepSeekBalanceState;
  /** 上次真正发起余额请求的时刻（epoch ms）；0 表示从未请求过。 */
  lastRefreshAt: number;
}

const BALANCE_STORAGE_DIR = 'balance';
const BALANCE_STORAGE_FILE = 'balance.json';

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
 * 全局余额 store：内存缓存 + `globalStorageUri` 下 JSON 文件持久化。
 * 内存缓存只用于同步展示（postState）；每次限流判断前都从磁盘刷新，
 * 使同一扩展的所有窗口共享同一份最新记录。
 */
export class GlobalBalanceStore {
  private record: GlobalBalanceRecord = { lastRefreshAt: 0 };
  private readonly dirUri: vscode.Uri;
  private readonly fileUri: vscode.Uri;
  private readonly decoder = new TextDecoder();

  public constructor(globalStorageUri: vscode.Uri) {
    this.dirUri = vscode.Uri.joinPath(globalStorageUri, BALANCE_STORAGE_DIR);
    this.fileUri = vscode.Uri.joinPath(this.dirUri, BALANCE_STORAGE_FILE);
  }

  /** 当前内存中的全局余额快照（同步读取，供 UI 立即展示）。 */
  public getBalance(): DeepSeekBalanceState | undefined {
    return this.record.balance;
  }

  /** 从磁盘读取最新记录并刷新内存缓存；文件缺失或损坏时视为无记录。 */
  public async refreshFromDisk(): Promise<void> {
    try {
      const bytes = await vscode.workspace.fs.readFile(this.fileUri);
      const parsed: unknown = JSON.parse(this.decoder.decode(bytes));
      this.record = normalizeGlobalBalanceRecord(parsed) ?? { lastRefreshAt: 0 };
    } catch {
      this.record = { lastRefreshAt: 0 };
    }
  }

  /** 距上次请求是否已超过限流间隔（force 时始终视为到期）；判断前先读磁盘。 */
  public async isRefreshDue(now: number, intervalMs: number, force?: boolean): Promise<boolean> {
    await this.refreshFromDisk();
    return Boolean(force) || now - this.record.lastRefreshAt >= intervalMs;
  }

  /** 写入最新余额快照并推进全局限流时间戳。 */
  public async update(balance: DeepSeekBalanceState, now: number): Promise<void> {
    this.record = { balance, lastRefreshAt: now };
    await this.writeRecord();
  }

  /** 清空全局记录（例如 API key / endpoint 变更后强制刷新）。 */
  public async clear(): Promise<void> {
    this.record = { lastRefreshAt: 0 };
    try {
      await vscode.workspace.fs.delete(this.fileUri, { useTrash: false });
    } catch {
      // 文件不存在时忽略：无记录状态即目标状态。
    }
  }

  private async writeRecord(): Promise<void> {
    try {
      await vscode.workspace.fs.createDirectory(this.dirUri);
      await vscode.workspace.fs.writeFile(
        this.fileUri,
        new TextEncoder().encode(`${JSON.stringify(this.record, null, 2)}\n`)
      );
    } catch {
      // 余额记录是次要展示数据：写入失败时保留内存快照，下次刷新再重试。
    }
  }
}
