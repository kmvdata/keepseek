import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { GlobalBalanceStore, normalizeGlobalBalanceRecord } from '../src/agent/deepseek/balanceStore';

const NOW = 1_700_000_000_000;
const INTERVAL_MS = 60_000;

function createStore(): { store: GlobalBalanceStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  return {
    store: new GlobalBalanceStore(vscode.Uri.file(dir)),
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('normalizeGlobalBalanceRecord keeps balance and lastRefreshAt from valid records', () => {
  const record = normalizeGlobalBalanceRecord({
    balance: {
      totalBalance: 12.34,
      currency: '¥',
      isAvailable: true,
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    lastRefreshAt: NOW
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
  assert.equal(record?.lastRefreshAt, NOW);
});

test('normalizeGlobalBalanceRecord tolerates missing optional fields and rejects invalid records', () => {
  const minimal = normalizeGlobalBalanceRecord({ lastRefreshAt: 123 });
  assert.equal(minimal?.lastRefreshAt, 123);
  assert.equal(minimal?.balance, undefined);
  assert.equal(normalizeGlobalBalanceRecord(null), undefined);
  assert.equal(normalizeGlobalBalanceRecord({}), undefined);
  assert.equal(normalizeGlobalBalanceRecord('not a record'), undefined);
});

test('store starts with no record and treats the first refresh as due', async () => {
  const { store, cleanup } = createStore();
  try {
    assert.equal(store.getBalance(), undefined);
    assert.equal(await store.isRefreshDue(NOW, INTERVAL_MS), true);
  } finally {
    cleanup();
  }
});

test('update persists the shared record and enforces the throttle window', async () => {
  const { store, cleanup } = createStore();
  try {
    await store.update({ totalBalance: 1, currency: '¥' }, NOW);

    // 间隔内忽略（不 force）。
    assert.equal(await store.isRefreshDue(NOW + INTERVAL_MS - 1, INTERVAL_MS), false);
    // 到达间隔即允许再次请求。
    assert.equal(await store.isRefreshDue(NOW + INTERVAL_MS, INTERVAL_MS), true);
    // force 无视间隔。
    assert.equal(await store.isRefreshDue(NOW + 1, INTERVAL_MS, true), true);
  } finally {
    cleanup();
  }
});

test('a second store on the same storage dir shares balance and throttle timestamp', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  try {
    const first = new GlobalBalanceStore(vscode.Uri.file(dir));
    await first.update({ totalBalance: 8.88, currency: '¥' }, NOW);

    // 模拟另一个窗口：新实例从磁盘读到同一份 lastRefreshAt 与余额快照。
    const second = new GlobalBalanceStore(vscode.Uri.file(dir));
    assert.equal(await second.isRefreshDue(NOW + INTERVAL_MS - 1, INTERVAL_MS), false);
    await second.refreshFromDisk();
    assert.equal(second.getBalance()?.totalBalance, 8.88);
    assert.equal(second.getBalance()?.currency, '¥');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clear drops the snapshot, deletes the file, and resets the throttle timestamp', async () => {
  const { store, cleanup } = createStore();
  try {
    await store.update({ totalBalance: 5, currency: '¥' }, NOW);
    assert.equal(store.getBalance()?.totalBalance, 5);

    await store.clear();
    assert.equal(store.getBalance(), undefined);
    assert.equal(await store.isRefreshDue(Date.now(), INTERVAL_MS), true);
  } finally {
    cleanup();
  }
});

test('a corrupted shared file is treated as no record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  try {
    mkdirSync(join(dir, 'balance'), { recursive: true });
    writeFileSync(join(dir, 'balance', 'balance.json'), 'not-json{{{', 'utf8');
    const store = new GlobalBalanceStore(vscode.Uri.file(dir));
    assert.equal(await store.isRefreshDue(NOW, INTERVAL_MS), true);
    assert.equal(store.getBalance(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
