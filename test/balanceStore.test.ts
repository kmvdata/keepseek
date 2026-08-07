import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from 'vscode';
import {
  GLOBAL_BALANCE_RECORD_KEY,
  GlobalBalanceStore,
  normalizeGlobalBalanceRecord
} from '../src/agent/deepseek/balanceStore';

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

test('normalizeGlobalBalanceRecord keeps balance and lastRefreshAt from valid records', () => {
  const record = normalizeGlobalBalanceRecord({
    balance: {
      totalBalance: 12.34,
      currency: '¥',
      isAvailable: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    lastRefreshAt: 1_700_000_000_000
  });

  assert.deepEqual(record?.balance && {
    totalBalance: record.balance.totalBalance,
    currency: record.balance.currency,
    isAvailable: record.balance.isAvailable,
    updatedAt: record.balance.updatedAt
  }, {
    totalBalance: 12.34,
    currency: '¥',
    isAvailable: true,
    updatedAt: '2026-01-01T00:00:00.000Z'
  });
  assert.equal(record?.lastRefreshAt, 1_700_000_000_000);
});

test('normalizeGlobalBalanceRecord tolerates missing optional fields and rejects invalid records', () => {
  const minimal = normalizeGlobalBalanceRecord({ lastRefreshAt: 123 });
  assert.equal(minimal?.lastRefreshAt, 123);
  assert.equal(minimal?.balance, undefined);
  assert.equal(normalizeGlobalBalanceRecord(null), undefined);
  assert.equal(normalizeGlobalBalanceRecord({}), undefined);
  assert.equal(normalizeGlobalBalanceRecord('not a record'), undefined);
});

test('GlobalBalanceStore loads a persisted record from memento at construction', () => {
  const memento = new MemoryMemento();
  const stored = {
    balance: { totalBalance: 9.99, currency: '¥', updatedAt: '2026-01-01T00:00:00.000Z' },
    lastRefreshAt: 1_700_000_000_000
  };
  void memento.update(GLOBAL_BALANCE_RECORD_KEY, stored);

  const store = new GlobalBalanceStore(memento);
  assert.equal(store.getBalance()?.totalBalance, stored.balance.totalBalance);
  assert.equal(store.getBalance()?.currency, '¥');
  assert.equal(store.getBalance()?.updatedAt, stored.balance.updatedAt);
});

test('GlobalBalanceStore enforces the shared throttle window using the persisted lastRefreshAt', () => {
  const memento = new MemoryMemento();
  const store = new GlobalBalanceStore(memento);
  const now = 1_700_000_000_000;

  // 从未刷新过：视为到期。
  assert.equal(store.isRefreshDue(now, 60_000), true);

  store.update({ totalBalance: 1, currency: '¥' }, now);
  // 间隔内忽略（不 force）。
  assert.equal(store.isRefreshDue(now + 59_999, 60_000), false);
  // 到达间隔即允许再次请求。
  assert.equal(store.isRefreshDue(now + 60_000, 60_000), true);
  // force 无视间隔。
  assert.equal(store.isRefreshDue(now + 1, 60_000, true), true);
  // 更新同时持久化到 memento。
  assert.deepEqual(memento.get(GLOBAL_BALANCE_RECORD_KEY), { balance: { totalBalance: 1, currency: '¥' }, lastRefreshAt: now });
});

test('GlobalBalanceStore.clear drops the snapshot and resets the throttle timestamp', () => {
  const memento = new MemoryMemento();
  const store = new GlobalBalanceStore(memento);
  store.update({ totalBalance: 5, currency: '¥' }, 1_700_000_000_000);
  assert.equal(store.getBalance()?.totalBalance, 5);

  store.clear();
  assert.equal(store.getBalance(), undefined);
  assert.equal(store.isRefreshDue(Date.now(), 60_000), true);
});
