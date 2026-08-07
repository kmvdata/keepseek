import * as vscode from 'vscode';
import type { DeepSeekBalanceState } from '../../shared/types';
import { isRecord } from '../../shared/errors';
import { normalizeBalanceStateValue } from '../usageStats';

/**
 * 全局余额记录在 `context.globalState` 中的存储 key。
 *
 * 余额记录与限流计时（lastRefreshAt）跨 workspace、跨窗口共享：所有工程
 * 弹出“用量统计”时都展示同一份余额，并按同一份时间戳限流，避免每个
 * workspace / 会话各自请求、各自计时的旧行为。
 */
export const GLOBAL_BALANCE_RECORD_KEY = 'keepseek.globalBalanceRecord';

export interface GlobalBalanceRecord {
  /** 最近一次成功（或失败）刷新得到的余额快照；无记录时为 undefined。 */
  balance?: DeepSeekBalanceState;
  /** 上次真正发起余额请求的时刻（epoch ms）；0 表示从未请求过。 */
  lastRefreshAt: number;
}

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
 * 全局余额 store：内存缓存 + `context.globalState` 持久化。
 * 读走内存缓存（同步），写立即落盘（Memento 持久化），同一扩展的所有窗口
 * 最终共享同一份记录。
 */
export class GlobalBalanceStore {
  private record: GlobalBalanceRecord;

  public constructor(private readonly globalState: vscode.Memento) {
    this.record = normalizeGlobalBalanceRecord(this.globalState.get<unknown>(GLOBAL_BALANCE_RECORD_KEY))
      ?? { lastRefreshAt: 0 };
  }

  /** 当前全局余额快照；没有记录时返回 undefined。 */
  public getBalance(): DeepSeekBalanceState | undefined {
    return this.record.balance;
  }

  /** 距上次请求是否已超过限流间隔（force 时始终视为到期）。 */
  public isRefreshDue(now: number, intervalMs: number, force?: boolean): boolean {
    return Boolean(force) || now - this.record.lastRefreshAt >= intervalMs;
  }

  /** 写入最新余额快照并推进限流时间戳。 */
  public update(balance: DeepSeekBalanceState, now: number): void {
    this.record = { balance, lastRefreshAt: now };
    void this.globalState.update(GLOBAL_BALANCE_RECORD_KEY, this.record);
  }

  /** 清空全局记录（例如 API key / endpoint 变更后强制刷新）。 */
  public clear(): void {
    this.record = { lastRefreshAt: 0 };
    void this.globalState.update(GLOBAL_BALANCE_RECORD_KEY, undefined);
  }
}
