import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  DEFAULT_HISTORY_CLEANUP_OPTIONS, FileHistoryCleanupJournal, HistoryCleanupError, SessionHistoryCleanupService,
  normalizeHistoryCleanupJournal, selectHistoryCleanupTargets, validateHistoryCleanupOptions,
  type HistoryCleanupAdapter, type HistoryCleanupCatalogEntry, type HistoryCleanupJournal,
  type HistoryCleanupJournalRecord, type HistoryCleanupOptions, type HistoryCleanupState, type HistoryCleanupTargetResult
} from '../src/sessions/sessionHistoryCleanup';
import * as vscode from './stubs/vscode';

const now = Date.parse('2026-11-10T07:00:00.000Z');
const days = (n: number) => new Date(now - n * 86400000).toISOString();
const older: HistoryCleanupOptions = { scope: 'current', mode: 'olderThan', days: 3 };
function entry(id: string, overrides: Partial<HistoryCleanupCatalogEntry> = {}): HistoryCleanupCatalogEntry {
  return { workspaceKey: 'workspace:cleanup', id, updatedAt: days(4), createdAt: days(10),
    isFavorite: false, hasHistory: true, version: `version-${id}`, ...overrides };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
class MemoryJournal implements HistoryCleanupJournal {
  record?: HistoryCleanupJournalRecord;
  writes = 0;
  async load() { return this.record ? structuredClone(this.record) : undefined; }
  async save(record: HistoryCleanupJournalRecord) { this.writes++; this.record = structuredClone(record); }
}
function fixture(entries = [entry('a')], overrides: Partial<HistoryCleanupAdapter> = {}) {
  const journal = new MemoryJournal();
  let deletes = 0, catalogs = 0;
  const adapter: HistoryCleanupAdapter = {
    async readCatalog() { catalogs++; return { entries: structuredClone(entries), unknown: 0 }; },
    async revalidateTarget() { return true; },
    async deleteTarget() { deletes++; return { status: 'fullyDeleted' }; }, ...overrides
  };
  const service = new SessionHistoryCleanupService(adapter, { now: () => now, journal, currentSessionId: () => 'a' });
  return { journal, adapter, service, get deletes() { return deletes; }, get catalogs() { return catalogs; } };
}
async function preview(service: SessionHistoryCleanupService, options: HistoryCleanupOptions = older) {
  return service.preview('preview-1', 'view-1', options, 'workspace:cleanup');
}

test('manual history cleanup options are independent, default to three, accept only strict one-through-seven days', () => {
  assert.deepEqual(DEFAULT_HISTORY_CLEANUP_OPTIONS, older);
  for (const n of [1, 3, 7]) assert.equal(validateHistoryCleanupOptions({ ...older, days: n }).mode, 'olderThan');
  assert.deepEqual(validateHistoryCleanupOptions({ scope: 'all', mode: 'all' }), { scope: 'all', mode: 'all' });
  for (const value of [0, -1, 1.5, 8, 60, '3', NaN, Infinity, null, undefined, 'all', {}, []]) {
    assert.throws(() => validateHistoryCleanupOptions({ ...older, days: value }), HistoryCleanupError);
  }
  for (const value of [{ scope: 'visible', mode: 'all' }, { scope: 'current', mode: 'recent', days: 3 },
    { scope: 'current', mode: 'all', days: 3 }, null, []]) assert.throws(() => validateHistoryCleanupOptions(value));
});

test('cleanup uses a strict rolling 24-hour cutoff and last update rather than created time or local midnight', () => {
  const result = selectHistoryCleanupTargets([
    entry('before', { updatedAt: '2026-11-07T14:59:59.999+08:00' }),
    entry('equal', { updatedAt: '2026-11-07T15:00:00.000+08:00' }),
    entry('after', { updatedAt: '2026-11-07T15:00:00.001+08:00' }),
    entry('updated-recently', { createdAt: days(90), updatedAt: days(1) })
  ], older, now, 'workspace:cleanup');
  assert.deepEqual(result.targets.map(item => item.id), ['before']);
  assert.equal(result.cutoff, Date.parse('2026-11-07T07:00:00.000Z'));
});

test('invalid or untrusted updated timestamps never fall back to epoch or to an otherwise old creation date', () => {
  const result = selectHistoryCleanupTargets([
    entry('corrupt', { updatedAt: 'broken' }), entry('empty', { updatedAt: '' }), entry('null-time', { updatedAt: null }),
    entry('untrusted', { updatedAt: new Date(0).toISOString(), updatedAtTrusted: false }),
    entry('missing-old', { updatedAt: undefined, createdAt: days(8) }),
    entry('missing-untrusted-created', { updatedAt: undefined, createdAt: days(8), createdAtTrusted: false }),
    entry('not-a-date', { updatedAt: '3' }), entry('invalid-calendar-day', { updatedAt: '2026-02-30T07:00:00.000Z' })
  ], older, now, 'workspace:cleanup');
  assert.deepEqual(result.targets.map(item => item.id), ['missing-old']);
  assert.equal(result.unknownCount, 7);
  assert.equal(selectHistoryCleanupTargets([entry('corrupt', { updatedAt: 'broken' })], { scope: 'current', mode: 'all' }, now, 'workspace:cleanup').targets.length, 1);
});

test('scope, favorites, protected sessions, unknown identity and empty containers are calculated from complete summaries', () => {
  const entries = [entry('favorite', { isFavorite: true }), entry('other', { workspaceKey: 'workspace:other' }),
    entry('active', { protectedReason: 'running' }), entry('blank', { hasHistory: false }),
    entry('damaged', { unknownReason: 'index_identity_mismatch' })];
  const current = selectHistoryCleanupTargets(entries, older, now, 'workspace:cleanup');
  assert.deepEqual(current.targets.map(item => item.id), ['favorite']);
  assert.equal(current.protectedCount, 1); assert.equal(current.unknownCount, 1);
  const all = selectHistoryCleanupTargets(entries, { scope: 'all', mode: 'all' }, now, 'workspace:cleanup');
  assert.deepEqual(all.targets.map(item => item.id), ['favorite', 'other']);
});

test('previews are read-only, include favorite/current facts and cancellation performs no journal or delete writes', async () => {
  const f = fixture([entry('a', { isFavorite: true }), entry('protected', { protectedReason: 'approval' })]);
  const p = await preview(f.service);
  assert.equal(p.candidateCount, 1); assert.equal(p.favoriteCount, 1); assert.equal(p.protectedCount, 1);
  assert.equal(p.includesCurrentSession, true); assert.equal(f.journal.writes, 0); assert.equal(f.deletes, 0);
  const result = await f.service.request('delete-1', 'view-1', p.previewToken, async () => false);
  assert.equal(result.status, 'cancelled'); assert.equal(f.journal.writes, 0); assert.equal(f.deletes, 0);
});

test('confirmation ownership precedes await, duplicate messages share one modal and terminal requests are idempotent', async () => {
  const f = fixture(); const p = await preview(f.service); const confirmation = deferred<boolean>(); let modals = 0;
  const request = () => f.service.request('delete-1', 'view-1', p.previewToken, async () => { modals++; return confirmation.promise; });
  const a = request(), b = request(); assert.equal(a, b);
  await assert.rejects(f.service.request('different', 'view-1', p.previewToken, async () => true), /cleanup_busy/u);
  await Promise.resolve(); assert.equal(f.service.getCurrentOperation()?.status, 'confirming');
  confirmation.resolve(true);
  const result = await a;
  assert.equal(result.status, 'completed'); assert.equal(result.fullyDeleted, 1); assert.equal(modals, 1); assert.equal(f.deletes, 1);
  assert.deepEqual(await request(), result); assert.equal(modals, 1); assert.equal(f.deletes, 1);
});

test('expired, other-Webview and invalidated tokens cannot reach confirmation or deletion', async () => {
  let clock = now; const f = fixture();
  const service = new SessionHistoryCleanupService(f.adapter, { now: () => clock, tokenTtlMs: 10 });
  const p = await preview(service); let confirmations = 0;
  const confirm = async () => { confirmations++; return true; };
  await assert.rejects(service.request('a', 'other-view', p.previewToken, confirm), /invalid_preview/u);
  clock += 11;
  await assert.rejects(service.request('a', 'view-1', p.previewToken, confirm), /expired_preview/u);
  const p2 = await preview(service); service.invalidate('view-1');
  await assert.rejects(service.request('b', 'view-1', p2.previewToken, confirm), /invalid_preview/u);
  assert.equal(confirmations, 0); assert.equal(f.deletes, 0);
});

test('an out-of-order summary read cannot publish a stale preview token', async () => {
  const first = deferred<{ entries: HistoryCleanupCatalogEntry[]; unknown: number }>(); let calls = 0;
  const f = fixture([], { async readCatalog() { if (++calls === 1) return first.promise; return { entries: [entry('new')], unknown: 0 }; } });
  const old = f.service.preview('old', 'view-1', older, 'workspace:cleanup');
  const latest = await f.service.preview('new', 'view-1', { scope: 'all', mode: 'all' }, 'workspace:cleanup');
  first.resolve({ entries: [entry('old')], unknown: 0 });
  await assert.rejects(old, /stale_preview/u); assert.equal(latest.requestId, 'new');
});

test('whole-plan changes after confirmation retain every target and persist only the terminal result', async () => {
  const f = fixture([entry('a'), entry('b')], { async revalidateTarget(target) { return target.id !== 'b'; } });
  const p = await preview(f.service);
  const result = await f.service.request('run', 'view-1', p.previewToken, async () => true);
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'history_changed');
  assert.equal(f.deletes, 0); assert.equal(f.journal.writes, 1); assert.equal(result.failedBeforeCommit, 2);
});

test('new sessions cannot enter the frozen plan and per-item changes produce a truthful partial result', async () => {
  const entries = [entry('a'), entry('b'), entry('c')]; const visited: string[] = [];
  const f = fixture(entries, { async deleteTarget(target) {
    visited.push(target.id);
    return target.id === 'b' ? { status: 'skippedChanged' } : target.id === 'c' ? { status: 'protected' } : { status: 'fullyDeleted' };
  } });
  const p = await preview(f.service); entries.push(entry('later'));
  const states: HistoryCleanupState[] = [];
  const result = await f.service.request('run', 'view-1', p.previewToken, async () => true, state => states.push(state));
  assert.deepEqual(visited, ['a', 'b', 'c']); assert.equal(result.total, 3); assert.equal(result.processed, 3);
  assert.equal(result.fullyDeleted, 1); assert.equal(result.skippedChanged, 1); assert.equal(result.protected, 1);
  assert.deepEqual(states.filter(state => state.status === 'running').map(state => state.processed), [0, 1, 2, 3]);
  assert.equal(f.service.getCurrentOperation()?.options.mode, 'olderThan');
});

test('associated cleanup failure stays logically removed and inaccessible legacy sources are counted separately', async () => {
  const f = fixture([entry('a'), entry('b')], {
    async deleteTarget() { return { status: 'removedPendingCleanup' }; },
    async finishTarget(target) { if (target.id === 'a') throw new Error('EACCES'); return { status: 'removedPendingCleanup', inaccessibleLegacySource: true }; }
  });
  const p = await preview(f.service);
  const result = await f.service.request('run', 'view-1', p.previewToken, async () => true);
  assert.equal(result.fullyDeleted, 0); assert.equal(result.removedPendingCleanup, 2); assert.equal(result.inaccessibleLegacy, 1);
  assert.equal(result.failedBeforeCommit, 0);
});

test('restart reclaims only operation-owned committed tombstones and never grants authorization to uncommitted candidates', async () => {
  const f = fixture([entry('a'), entry('b'), entry('c')], { async deleteTarget() { return { status: 'removedPendingCleanup' }; } });
  const p = await preview(f.service);
  await f.service.request('run', 'view-1', p.previewToken, async () => true);
  f.journal.record!.state.status = 'running';
  f.journal.record!.items[1].result = undefined;
  f.journal.record!.items[2].result = { status: 'removedPendingCleanup', inaccessibleLegacySource: true };
  let deletes = 0; const recovered: string[] = [];
  const service = new SessionHistoryCleanupService({ ...f.adapter,
    async deleteTarget() { deletes++; return { status: 'fullyDeleted' }; },
    async recoverCommittedTarget(target) { recovered.push(target.id); return target.id === 'a' ? { status: 'fullyDeleted' } : undefined; }
  }, { journal: f.journal });
  const result = await service.recover();
  assert.equal(result?.fullyDeleted, 1); assert.equal(result?.failedBeforeCommit, 1); assert.equal(result?.removedPendingCleanup, 1);
  assert.equal(result?.inaccessibleLegacy, 1); assert.deepEqual(recovered, ['a', 'b']); assert.equal(deletes, 0);
});

test('the persisted journal validates schema and survives independent store instances using only temporary storage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-journal-'));
  try {
    const journal = new FileHistoryCleanupJournal(vscode.Uri.file(root) as never, 'workspace:cleanup');
    const f = fixture();
    const service = new SessionHistoryCleanupService(f.adapter, { journal, now: () => now });
    const p = await preview(service);
    const result = await service.request('run', 'view-1', p.previewToken, async () => true);
    const reloaded = await new FileHistoryCleanupJournal(vscode.Uri.file(root) as never, 'workspace:cleanup').load();
    assert.deepEqual(reloaded?.state, result);
    assert.equal(normalizeHistoryCleanupJournal({ ...reloaded, version: 99 }), undefined);
    assert.equal(normalizeHistoryCleanupJournal({ ...reloaded, state: { ...result, total: 99 } }), undefined);
    assert.equal(normalizeHistoryCleanupJournal({ ...reloaded, state: { ...result, fullyDeleted: -1 } }), undefined);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('ten thousand raw summaries preview without body reads or model calls and bounded deletion concurrency', async () => {
  const entries = Array.from({ length: 10000 }, (_, index) => entry(String(index), { isFavorite: index % 10 === 0 }));
  let active = 0, maxActive = 0; const bodyReads = 0, modelRequests = 0;
  const f = fixture(entries, { async deleteTarget() { active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return { status: 'fullyDeleted' }; } });
  const start = performance.now(); const p = await preview(f.service); const elapsed = performance.now() - start;
  assert.equal(p.candidateCount, 10000); assert.equal(p.favoriteCount, 1000); assert.equal(bodyReads, 0); assert.equal(modelRequests, 0);
  // Journal fsync is measured separately by storage tests; bound this orchestration sample to 100 synthetic targets.
  const small = new SessionHistoryCleanupService({ ...f.adapter, async readCatalog() { return { entries: entries.slice(0, 100), unknown: 0 }; } }, { now: () => now });
  const sp = await preview(small); const deletionStart = performance.now();
  const result = await small.request('benchmark', 'view-1', sp.previewToken, async () => true);
  assert.equal(result.fullyDeleted, 100); assert.equal(maxActive, 1);
  console.log(`history-cleanup synthetic summaries=10000 previewMs=${elapsed.toFixed(2)} deletionTargets=100 deleteMs=${(performance.now() - deletionStart).toFixed(2)} bodyReads=${bodyReads} modelRequests=${modelRequests} maxConcurrency=${maxActive}`);
});

test('independent windows retain per-operation journals and recover older committed cleanup without replacing latest result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-multi-operation-'));
  try {
    const storage = vscode.Uri.file(root) as never;
    const firstJournal = new FileHistoryCleanupJournal(storage, 'workspace:cleanup');
    const f = fixture([entry('older-operation')], { async deleteTarget() { return { status: 'removedPendingCleanup' }; } });
    const first = new SessionHistoryCleanupService(f.adapter, { now: () => now, journal: firstJournal });
    const fp = await preview(first);
    const firstResult = await first.request('first', 'view-1', fp.previewToken, async () => true);
    const secondJournal = new FileHistoryCleanupJournal(storage, 'workspace:cleanup');
    const second = new SessionHistoryCleanupService({ ...f.adapter,
      async readCatalog() { return { entries: [entry('latest-operation')], unknown: 0 }; },
      async deleteTarget() { return { status: 'fullyDeleted' }; }
    }, { now: () => now + 1000, journal: secondJournal });
    const sp = await preview(second);
    const secondResult = await second.request('second', 'view-1', sp.previewToken, async () => true);
    const before = await new FileHistoryCleanupJournal(storage, 'workspace:cleanup').loadPending();
    assert.deepEqual(before.map(item => item.state.operationId), [firstResult.operationId]);
    const recovered: string[] = [];
    const restart = new SessionHistoryCleanupService({ ...f.adapter,
      async recoverCommittedTarget(target, operationId) {
        recovered.push(target.id); assert.equal(operationId, firstResult.operationId); return { status: 'fullyDeleted' };
      }
    }, { journal: new FileHistoryCleanupJournal(storage, 'workspace:cleanup') });
    const final = await restart.recover();
    assert.deepEqual(recovered, ['older-operation']);
    assert.equal(final?.operationId, secondResult.operationId);
    assert.equal((await firstJournal.load())?.state.operationId, secondResult.operationId);
    assert.deepEqual(await firstJournal.loadPending(), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a second provider recovering a still-active operation cannot reclaim its uncommitted targets or overwrite its journal', async () => {
  const started = deferred<void>(), release = deferred<void>();
  const f = fixture([entry('a')], { async deleteTarget() { started.resolve(); await release.promise; return { status: 'fullyDeleted' }; } });
  const p = await preview(f.service);
  const running = f.service.request('active', 'view-1', p.previewToken, async () => true);
  await started.promise;
  const writesBefore = f.journal.writes;
  let reclaimed = 0;
  const otherProvider = new SessionHistoryCleanupService({ ...f.adapter,
    async recoverCommittedTarget() { reclaimed++; return undefined; }
  }, { journal: f.journal });
  assert.equal((await otherProvider.recover())?.status, 'running');
  assert.equal(f.journal.writes, writesBefore); assert.equal(reclaimed, 0);
  release.resolve(); assert.equal((await running).fullyDeleted, 1);
  assert.equal((await otherProvider.recover())?.status, 'completed');
});

test('I/O failures cannot be reported as failure before commit if the durable outcome cannot be inspected', async () => {
  const f = fixture([entry('a')], {
    async deleteTarget() { throw new Error('permission failure after an unknown commit boundary'); },
    async recoverCommittedTarget() { throw new Error('EACCES'); }
  });
  const p = await preview(f.service);
  const result = await f.service.request('unknown-outcome', 'view-1', p.previewToken, async () => true);
  assert.equal(result.unknown, 1); assert.equal(result.failedBeforeCommit, 0); assert.equal(result.fullyDeleted, 0);
});

test('result reasons expose only bounded safe codes and preserve pending-source diagnosis', async () => {
  const f = fixture([entry('a'), entry('b')], { async deleteTarget(target) {
    return { status: 'removedPendingCleanup', reason: target.id === 'a'
      ? 'inaccessible_legacy_source;unverified_legacy_logs;inaccessible_legacy_source;/private/secret;secretcredential;usage-ledger:EACCES'
      : 'unverified_legacy_logs;workspace_state_cleanup_failed', inaccessibleLegacySource: target.id === 'a' };
  } });
  const p = await preview(f.service);
  const result = await f.service.request('reasons', 'view-1', p.previewToken, async () => true);
  assert.deepEqual(result.reasonCounts, { inaccessible_legacy_source: 1, unverified_legacy_logs: 2, usage_ledger_cleanup_failed: 1, workspace_state_cleanup_failed: 1 });
  assert.equal(result.inaccessibleLegacy, 1);
});

test('a target changing at the first deletion gate aborts untouched candidates before any logical commit', async () => {
  for (const firstStatus of ['skippedChanged', 'protected'] as const) {
    const visited: string[] = [];
    const f = fixture([entry('first'), entry('later'), entry('last')], {
      async revalidateTarget() { return true; },
      async deleteTarget(target) {
        visited.push(target.id);
        return target.id === 'first' ? { status: firstStatus, reason: 'history_changed' } : { status: 'fullyDeleted' };
      }
    });
    const p = await preview(f.service);
    const result = await f.service.request(`admission-race-${firstStatus}`, 'view-1', p.previewToken, async () => true);
    assert.deepEqual(visited, ['first']);
    assert.equal(result.status, 'failed'); assert.equal(result.error, 'history_changed');
    assert.equal(result.fullyDeleted, 0); assert.equal(result.removedPendingCleanup, 0);
    assert.equal(result.failedBeforeCommit, 2);
    assert.equal(firstStatus === 'protected' ? result.protected : result.skippedChanged, 1);
    assert.equal(f.journal.record?.state.error, 'history_changed');
  }
});

function journalFixture(count: number, operationId: string): HistoryCleanupJournalRecord {
  return { version: 1, confirmedAt: now, ownerPid: process.pid, excluded: { protected: 0, unknown: 0 },
    state: { requestId: operationId, operationId, status: 'running', options: older, now, total: count, processed: 0,
      fullyDeleted: 0, protected: 0, skippedChanged: 0, unknown: 0, failedBeforeCommit: 0, removedPendingCleanup: 0,
      inaccessibleLegacy: 0, favoriteCount: 0, includesCurrentSession: false },
    items: Array.from({ length: count }, (_, index) => ({ target: entry(`journal-target-${index}`) })) };
}

test('readonly cleanup result inspection does not claim recovery or recycle interrupted targets', async () => {
  const record = journalFixture(2, 'readonly-interrupted');
  record.items[0].result = { status: 'removedPendingCleanup' };
  let reads = 0, writes = 0, pendingReads = 0, recoveryCalls = 0;
  const f = fixture();
  const service = new SessionHistoryCleanupService({ ...f.adapter,
    async recoverCommittedTarget() { recoveryCalls++; return { status: 'fullyDeleted' }; }
  }, { journal: {
    async load() { reads++; return structuredClone(record); },
    async save() { writes++; },
    async loadPending() { pendingReads++; return [structuredClone(record)]; }
  } });
  const state = await service.inspectCurrentOperation();
  assert.equal(state?.operationId, record.state.operationId);
  assert.equal(state?.status, 'running');
  assert.equal(service.hasLocalOwner(), false);
  assert.equal(service.getCurrentOperation(), undefined, 'inspection does not replace local execution state');
  state!.fullyDeleted = 99;
  assert.equal((await service.inspectCurrentOperation())?.fullyDeleted, 0);
  assert.deepEqual({ reads, writes, pendingReads, recoveryCalls, deletes: f.deletes },
    { reads: 2, writes: 0, pendingReads: 0, recoveryCalls: 0, deletes: 0 });
});

test('readonly cleanup inspection returns a live confirmation and ignores a late stale disk result', async () => {
  const f = fixture();
  const disk = deferred<HistoryCleanupJournalRecord | undefined>();
  let reads = 0;
  f.journal.load = async () => { reads++; return disk.promise; };
  const inspection = f.service.inspectCurrentOperation();
  const p = await preview(f.service);
  const entered = deferred<void>(), confirm = deferred<boolean>();
  const execution = f.service.request('live-inspection', 'view-1', p.previewToken, async () => {
    entered.resolve(); return confirm.promise;
  });
  await entered.promise;
  assert.equal((await f.service.inspectCurrentOperation())?.status, 'confirming');
  assert.equal(reads, 1, 'live owner bypasses journal inspection');
  disk.resolve(journalFixture(1, 'stale-operation'));
  const observed = await inspection;
  assert.equal(observed?.requestId, 'live-inspection');
  assert.equal(observed?.status, 'confirming');
  confirm.resolve(false);
  await execution;
  assert.equal(f.journal.writes, 0); assert.equal(f.deletes, 0);
});

test('readonly cleanup inspection failure does not poison a later preview or create deletion authority', async () => {
  const f = fixture();
  f.journal.load = async () => { throw new HistoryCleanupError('journal_corrupt'); };
  await assert.rejects(f.service.inspectCurrentOperation(), error => error instanceof HistoryCleanupError && error.code === 'journal_corrupt');
  assert.equal(f.service.hasLocalOwner(), false);
  const p = await preview(f.service);
  assert.equal(p.candidateCount, 1);
  const result = await f.service.request('cancel-after-inspection-failure', 'view-1', p.previewToken, async () => false);
  assert.equal(result.status, 'cancelled'); assert.equal(f.journal.writes, 0); assert.equal(f.deletes, 0);
});

test('cleanup preview preserves bounded safe catalog diagnostics without exposing raw paths', async () => {
  const f = fixture([entry('a')], { async readCatalog() {
    return { entries: [entry('a')], unknown: 1, diagnostics: Array.from({ length: 40 }, () => ({
      code: 'corrupt_index' as const, phase: 'catalog' as const, retryable: false,
      workspaceHash: '../../private/storage', rawPath: '/private/history/body'
    })) };
  } });
  const p = await preview(f.service);
  assert.equal(p.candidateCount, 1); assert.equal(p.unknownCount, 1);
  assert.equal(p.diagnostics?.length, 32);
  assert.deepEqual(p.diagnostics?.[0], { code: 'corrupt_index', phase: 'catalog', retryable: false });
  assert.equal(JSON.stringify(p.diagnostics).includes('/private'), false);
  assert.equal(f.journal.writes, 0); assert.equal(f.deletes, 0);
});

test('journal read errors distinguish corrupt JSON from denied access while preserving the underlying cause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-journal-error-'));
  const originalRead = vscode.workspace.fs.readFile;
  try {
    const workspaceKey = 'workspace:cleanup';
    const hash = createHash('sha256').update(workspaceKey).digest('hex').slice(0, 32);
    const directory = join(root, 'history-cleanup', 'v1', 'operations');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, `${hash}.json`), '{broken');
    const journal = new FileHistoryCleanupJournal(vscode.Uri.file(root) as never, workspaceKey);
    await assert.rejects(journal.load(), error => error instanceof HistoryCleanupError
      && error.code === 'journal_corrupt' && error.cause instanceof SyntaxError);
    await writeFile(join(directory, `${hash}.json`), JSON.stringify({ version: 2, operationId: '' }));
    await assert.rejects(journal.load(), error => error instanceof HistoryCleanupError && error.code === 'journal_corrupt');
    const denied = Object.assign(new Error('denied'), { code: 'EACCES' });
    vscode.workspace.fs.readFile = async uri => {
      if (uri.fsPath.startsWith(root)) throw denied;
      return originalRead(uri);
    };
    await assert.rejects(journal.load(), error => error instanceof HistoryCleanupError
      && error.code === 'journal_unavailable' && error.cause === denied);
  } finally { vscode.workspace.fs.readFile = originalRead; await rm(root, { recursive: true, force: true }); }
});

test('journal inspection refuses a symbolic-link parent as unavailable rather than corrupting or recovering it',
  { skip: process.platform === 'win32' }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-journal-symlink-'));
    try {
      const root = join(directory, 'storage'), outside = join(directory, 'outside');
      await mkdir(root); await mkdir(outside);
      await symlink(outside, join(root, 'history-cleanup'));
      const journal = new FileHistoryCleanupJournal(vscode.Uri.file(root) as never, 'workspace:cleanup');
      await assert.rejects(journal.load(), error => error instanceof HistoryCleanupError
        && error.code === 'journal_unavailable' && error.cause instanceof Error && /Symbolic-link/u.test(error.cause.message));
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

test('a thousand durable per-target journal checkpoints write linear bytes rather than repeatedly copying the plan', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-journal-linear-'));
  const originalWrite = vscode.workspace.fs.writeFile;
  let bytesWritten = 0, writes = 0;
  const start = performance.now();
  vscode.workspace.fs.writeFile = async (uri, bytes) => {
    if (uri.fsPath.startsWith(root)) { bytesWritten += bytes.byteLength; writes++; }
    await originalWrite(uri, bytes);
  };
  try {
    const journal = new FileHistoryCleanupJournal(vscode.Uri.file(root) as never, 'workspace:cleanup');
    const record = journalFixture(1000, 'linear-journal');
    await journal.save(record);
    for (let index = 0; index < record.items.length; index++) {
      record.items[index].result = { status: 'fullyDeleted' };
      record.state.processed = index + 1; record.state.fullyDeleted = index + 1;
      await journal.save(record, index);
    }
    record.state.status = 'completed'; await journal.save(record);
    assert.ok(bytesWritten < 1000 * 10000, `journal wrote ${bytesWritten} bytes for 1000 targets`);
    const loaded = await new FileHistoryCleanupJournal(vscode.Uri.file(root) as never, 'workspace:cleanup').load();
    assert.equal(loaded?.state.fullyDeleted, 1000); assert.equal(loaded?.items.length, 1000);
    console.log(`history-cleanup durableJournalTargets=1000 bytesWritten=${bytesWritten} writes=${writes} elapsedMs=${(performance.now() - start).toFixed(2)}`);
  } finally { vscode.workspace.fs.writeFile = originalWrite; await rm(root, { recursive: true, force: true }); }
});

test('a durable result delta survives interruption before its compact state checkpoint without authorizing remaining targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-journal-overlay-'));
  const originalRename = vscode.workspace.fs.rename;
  try {
    const storage = vscode.Uri.file(root) as never;
    const journal = new FileHistoryCleanupJournal(storage, 'workspace:cleanup');
    const record = journalFixture(2, 'delta-interruption');
    await journal.save(record);
    record.items[0].result = { status: 'fullyDeleted' }; record.state.processed = 1; record.state.fullyDeleted = 1;
    let fail = true;
    vscode.workspace.fs.rename = async (from, to, options) => {
      if (fail && to.fsPath.startsWith(root) && to.fsPath.endsWith('.state.json')) { fail = false; throw new Error('synthetic interruption'); }
      return originalRename(from, to, options);
    };
    await assert.rejects(journal.save(record, 0), /synthetic interruption/u);
    vscode.workspace.fs.rename = originalRename;
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    await writeFile(join(root, 'history-cleanup', 'v1', 'operations', digest('workspace:cleanup').slice(0, 32),
      `${digest(record.state.operationId)}.results`, '.keepseek-00000000-0000-0000-0000-000000000000.tmp'), 'incomplete atomic payload');
    const loaded = await new FileHistoryCleanupJournal(storage, 'workspace:cleanup').load();
    assert.equal(loaded?.items[0].result?.status, 'fullyDeleted');
    assert.equal(loaded?.state.fullyDeleted, 1); assert.equal(loaded?.state.processed, 1);
    const f = fixture(); let deletions = 0; const inspected: string[] = [];
    const restarted = new SessionHistoryCleanupService({ ...f.adapter,
      async deleteTarget() { deletions++; return { status: 'fullyDeleted' }; },
      async recoverCommittedTarget(target) { inspected.push(target.id); return undefined; }
    }, { journal: new FileHistoryCleanupJournal(storage, 'workspace:cleanup') });
    const result = await restarted.recover();
    assert.equal(result?.fullyDeleted, 1); assert.equal(result?.failedBeforeCommit, 1);
    assert.deepEqual(inspected, ['journal-target-1']); assert.equal(deletions, 0);
  } finally { vscode.workspace.fs.rename = originalRename; await rm(root, { recursive: true, force: true }); }
});

test('a confirmed failed preflight restores the original readonly result after restart and never authorizes deletion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-cleanup-preflight-result-'));
  try {
    const storage = vscode.Uri.file(root) as never;
    const f = fixture([entry('a'), entry('b')], { async revalidateTarget() { return false; } });
    const service = new SessionHistoryCleanupService(f.adapter, { journal: new FileHistoryCleanupJournal(storage, 'workspace:cleanup'), now: () => now });
    const p = await preview(service, { scope: 'all', mode: 'all' });
    const result = await service.request('failed-confirmed', 'view-1', p.previewToken, async () => true);
    assert.equal(result.error, 'history_changed'); assert.equal(result.failedBeforeCommit, 2); assert.equal(f.deletes, 0);
    let attempted = 0;
    const restarted = new SessionHistoryCleanupService({ ...f.adapter,
      async recoverCommittedTarget() { attempted++; return undefined; }
    }, { journal: new FileHistoryCleanupJournal(storage, 'workspace:cleanup') });
    const restored = await restarted.recover();
    assert.equal(restored?.status, 'failed'); assert.equal(restored?.error, 'history_changed');
    assert.deepEqual(restored?.options, { scope: 'all', mode: 'all' });
    assert.equal(restored?.failedBeforeCommit, 2); assert.equal(attempted, 0); assert.equal(f.deletes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('two same-process providers cannot both claim a completed operation with pending physical cleanup', async () => {
  const f = fixture([entry('a')], { async deleteTarget() { return { status: 'removedPendingCleanup' }; } });
  const p = await preview(f.service);
  await f.service.request('pending-physical', 'view-1', p.previewToken, async () => true);
  const started = deferred<void>(), release = deferred<void>();
  const claimed: string[] = [];
  const create = (name: string) => new SessionHistoryCleanupService({ ...f.adapter,
    async recoverCommittedTarget() { claimed.push(name); started.resolve(); await release.promise; return { status: 'fullyDeleted' }; }
  }, { journal: f.journal });
  const first = create('first').recover(), second = create('second').recover();
  await started.promise;
  assert.equal(claimed.length, 1);
  release.resolve(); await Promise.all([first, second]);
  assert.equal(claimed.length, 1); assert.equal(f.journal.record?.state.fullyDeleted, 1);
});
