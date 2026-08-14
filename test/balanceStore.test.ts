import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { GlobalBalanceStore, normalizeGlobalBalanceRecord } from '../src/agent/deepseek/balanceStore';

const NOW = 1_700_000_000_000;
const INTERVAL_MS = 60_000;
const PRIMARY_ACCOUNT = { provider: 'deepseek', accountId: 'primary' } as const;
const SECONDARY_ACCOUNT = { provider: 'deepseek', accountId: 'secondary' } as const;

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

test('concurrent stores allow only one refresh claim and persist its reservation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  try {
    const first = new GlobalBalanceStore(vscode.Uri.file(dir));
    const second = new GlobalBalanceStore(vscode.Uri.file(dir));
    const claims = await Promise.all([
      first.claimRefresh(NOW, INTERVAL_MS, true, PRIMARY_ACCOUNT),
      second.claimRefresh(NOW, INTERVAL_MS, true, PRIMARY_ACCOUNT)
    ]);

    assert.equal(claims.filter(Boolean).length, 1);

    const observer = new GlobalBalanceStore(vscode.Uri.file(dir));
    assert.equal(
      await observer.isRefreshDue(NOW + 1, INTERVAL_MS, false, PRIMARY_ACCOUNT),
      false
    );

    const winner = claims[0] ? first : second;
    const other = claims[0] ? second : first;
    await winner.update({ totalBalance: 8.88, currency: '¥' }, NOW + 2, PRIMARY_ACCOUNT);

    // force still bypasses the completed throttle window once no request is in flight.
    assert.equal(await other.claimRefresh(NOW + 3, INTERVAL_MS, true, PRIMARY_ACCOUNT), true);
    await other.update({ totalBalance: 9.99, currency: '¥' }, NOW + 4, PRIMARY_ACCOUNT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a refresh claim fails closed when its reservation cannot be persisted', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  const mutableFs = vscode.workspace.fs as unknown as {
    writeFile: typeof vscode.workspace.fs.writeFile;
  };
  const originalWriteFile = mutableFs.writeFile;
  try {
    mutableFs.writeFile = async () => {
      throw new Error('storage unavailable');
    };
    const store = new GlobalBalanceStore(vscode.Uri.file(dir));
    assert.equal(await store.claimRefresh(NOW, INTERVAL_MS, false, PRIMARY_ACCOUNT), false);

    mutableFs.writeFile = originalWriteFile;
    assert.equal(await store.claimRefresh(NOW + 1, INTERVAL_MS, false, PRIMARY_ACCOUNT), true);
    store.releaseRefreshClaim(PRIMARY_ACCOUNT);
  } finally {
    mutableFs.writeFile = originalWriteFile;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('clear invalidates another store claim so its stale update cannot recreate the file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  try {
    const requestStore = new GlobalBalanceStore(vscode.Uri.file(dir));
    const settingsStore = new GlobalBalanceStore(vscode.Uri.file(dir));
    assert.equal(await requestStore.claimRefresh(NOW, INTERVAL_MS, true, PRIMARY_ACCOUNT), true);

    await settingsStore.clear(PRIMARY_ACCOUNT);
    await requestStore.update({ totalBalance: 8.88, currency: '¥' }, NOW + 1, PRIMARY_ACCOUNT);

    assert.equal(existsSync(join(dir, 'accounts', 'deepseek', 'primary', 'balance.json')), false);
    assert.equal(requestStore.getBalance(PRIMARY_ACCOUNT), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('delete invalidates another store claim so its stale update cannot resurrect account balance', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  try {
    const requestStore = new GlobalBalanceStore(vscode.Uri.file(dir));
    const settingsStore = new GlobalBalanceStore(vscode.Uri.file(dir));
    assert.equal(await requestStore.claimRefresh(NOW, INTERVAL_MS, true, PRIMARY_ACCOUNT), true);

    await settingsStore.deleteAccount(PRIMARY_ACCOUNT);
    await requestStore.update({ totalBalance: 8.88, currency: '¥' }, NOW + 1, PRIMARY_ACCOUNT);

    assert.equal(existsSync(join(dir, 'accounts', 'deepseek', 'primary', 'balance.json')), false);
    assert.equal(requestStore.getBalance(PRIMARY_ACCOUNT), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an abandoned caller can release its claim so force refresh remains available', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  try {
    const first = new GlobalBalanceStore(vscode.Uri.file(dir));
    const second = new GlobalBalanceStore(vscode.Uri.file(dir));
    await assert.rejects(async () => {
      assert.equal(await first.claimRefresh(NOW, INTERVAL_MS, true, PRIMARY_ACCOUNT), true);
      try {
        throw new Error('unexpected refresh failure');
      } finally {
        first.releaseRefreshClaim(PRIMARY_ACCOUNT);
      }
    }, /unexpected refresh failure/u);

    assert.equal(await second.claimRefresh(NOW + 1, INTERVAL_MS, true, PRIMARY_ACCOUNT), true);
    second.releaseRefreshClaim(PRIMARY_ACCOUNT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('balance snapshots and throttle clocks are isolated by provider and account id', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  try {
    const store = new GlobalBalanceStore(vscode.Uri.file(dir));
    await store.update({ totalBalance: 8.88, currency: '¥' }, NOW, PRIMARY_ACCOUNT);
    await store.update({ totalBalance: 3.21, currency: '$' }, NOW - INTERVAL_MS, SECONDARY_ACCOUNT);
    await store.update(
      { totalBalance: 7.77, currency: '$' },
      NOW,
      { provider: 'openai-compatible', accountId: 'primary' }
    );

    assert.equal(await store.isRefreshDue(NOW + 1, INTERVAL_MS, false, PRIMARY_ACCOUNT), false);
    assert.equal(await store.isRefreshDue(NOW + 1, INTERVAL_MS, false, SECONDARY_ACCOUNT), true);
    assert.equal(store.getBalance(PRIMARY_ACCOUNT)?.totalBalance, 8.88);
    assert.equal(store.getBalance(SECONDARY_ACCOUNT)?.totalBalance, 3.21);
    assert.equal(store.getBalance({ provider: 'openai-compatible', accountId: 'primary' })?.totalBalance, 7.77);

    assert.equal(existsSync(join(dir, 'accounts', 'deepseek', 'primary', 'balance.json')), true);
    assert.equal(existsSync(join(dir, 'accounts', 'deepseek', 'secondary', 'balance.json')), true);
    assert.equal(existsSync(join(dir, 'accounts', 'openai-compatible', 'primary', 'balance.json')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('selectAccount scopes legacy call sites without leaking another account snapshot', async () => {
  const { store, cleanup } = createStore();
  try {
    store.selectAccount(PRIMARY_ACCOUNT);
    await store.update({ totalBalance: 10, currency: '¥' }, NOW);
    store.selectAccount(SECONDARY_ACCOUNT);
    assert.equal(store.getBalance(), undefined);
    await store.update({ totalBalance: 20, currency: '¥' }, NOW);
    assert.equal(store.getBalance()?.totalBalance, 20);
    store.selectAccount(PRIMARY_ACCOUNT);
    assert.equal(store.getBalance()?.totalBalance, 10);
  } finally {
    cleanup();
  }
});

test('account scope rejects path traversal ids before touching storage', async () => {
  const { store, cleanup } = createStore();
  try {
    await assert.rejects(
      store.update(
        { totalBalance: 1, currency: '¥' },
        NOW,
        { provider: 'deepseek', accountId: '../outside' }
      ),
      /Invalid balance account id/u
    );
  } finally {
    cleanup();
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

test('deleteAccount physically removes only that account balance file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  try {
    const store = new GlobalBalanceStore(vscode.Uri.file(dir));
    await store.update({ totalBalance: 5, currency: '¥' }, NOW, PRIMARY_ACCOUNT);
    await store.update({ totalBalance: 6, currency: '¥' }, NOW, SECONDARY_ACCOUNT);

    await store.deleteAccount(PRIMARY_ACCOUNT);

    assert.equal(store.getBalance(PRIMARY_ACCOUNT), undefined);
    assert.equal(existsSync(join(dir, 'accounts', 'deepseek', 'primary', 'balance.json')), false);
    assert.equal(existsSync(join(dir, 'accounts', 'deepseek', 'secondary', 'balance.json')), true);
    assert.equal(store.getBalance(SECONDARY_ACCOUNT)?.totalBalance, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the default account can read and clear the legacy shared balance file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keepseek-balance-'));
  try {
    mkdirSync(join(dir, 'balance'), { recursive: true });
    writeFileSync(join(dir, 'balance', 'balance.json'), JSON.stringify({
      balance: { totalBalance: 9.99, currency: '¥' },
      lastRefreshAt: NOW
    }), 'utf8');
    const store = new GlobalBalanceStore(vscode.Uri.file(dir));

    await store.refreshFromDisk();
    assert.equal(store.getBalance()?.totalBalance, 9.99);
    assert.equal(await store.isRefreshDue(NOW + 1, INTERVAL_MS), false);

    await store.clear();
    assert.equal(existsSync(join(dir, 'balance', 'balance.json')), false);
    assert.equal(store.getBalance(), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
