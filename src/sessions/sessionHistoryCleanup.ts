import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { deleteStorageUri, writeJsonAtomic } from '../shared/atomicStorage';
import { assertManagedStoragePath, withAssociatedStoreGate } from './sessionAssociatedPersistence';
import type { HistoryCleanupIssueCode, HistoryCleanupPhase } from './historyCleanupErrors';

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_TTL_MS = 5 * 60 * 1000;
const activeCleanupOperations = new Set<string>();
export type HistoryCleanupOptions =
  | { scope: 'current' | 'all'; mode: 'olderThan'; days: number }
  | { scope: 'current' | 'all'; mode: 'all'; days?: never };
export const DEFAULT_HISTORY_CLEANUP_OPTIONS: HistoryCleanupOptions = { scope: 'current', mode: 'olderThan', days: 3 };

/** Raw index facts, before lossy date normalization. A version binds the complete stored summary. */
export interface HistoryCleanupCatalogEntry {
  workspaceKey: string;
  id: string;
  updatedAt?: unknown;
  createdAt?: unknown;
  updatedAtTrusted?: boolean;
  createdAtTrusted?: boolean;
  isFavorite: boolean;
  hasHistory: boolean;
  version: string;
  unknownReason?: string;
  protectedReason?: string;
}
export type HistoryCleanupTarget = HistoryCleanupCatalogEntry;
export type HistoryCleanupTargetStatus = 'fullyDeleted' | 'protected' | 'skippedChanged' | 'unknown'
  | 'unavailable' | 'failedBeforeCommit' | 'removedPendingCleanup';
export interface HistoryCleanupTargetResult {
  status: HistoryCleanupTargetStatus;
  reason?: string;
  inaccessibleLegacySource?: boolean;
}
export interface HistoryCleanupCatalogDiagnostic {
  code: HistoryCleanupIssueCode;
  phase: HistoryCleanupPhase;
  workspaceHash?: string;
  retryable?: boolean;
}
export interface HistoryCleanupPreview {
  requestId: string;
  previewToken: string;
  options: HistoryCleanupOptions;
  now: number;
  cutoff?: number;
  expiresAt: number;
  candidateCount: number;
  favoriteCount: number;
  protectedCount: number;
  unknownCount: number;
  includesCurrentSession: boolean;
  diagnostics?: HistoryCleanupCatalogDiagnostic[];
}
export interface HistoryCleanupState {
  requestId: string;
  operationId: string;
  status: 'confirming' | 'running' | 'completed' | 'cancelled' | 'failed';
  options: HistoryCleanupOptions;
  now: number;
  cutoff?: number;
  total: number;
  processed: number;
  fullyDeleted: number;
  protected: number;
  skippedChanged: number;
  unknown: number;
  failedBeforeCommit: number;
  removedPendingCleanup: number;
  inaccessibleLegacy: number;
  favoriteCount: number;
  includesCurrentSession: boolean;
  reasonCounts?: Record<string, number>;
  error?: string;
}
export interface HistoryCleanupAdapter {
  readCatalog(scope: 'current' | 'all', currentWorkspaceKey: string): Promise<{
    entries: HistoryCleanupCatalogEntry[]; unknown: number; diagnostics?: HistoryCleanupCatalogDiagnostic[];
  }>;
  revalidateTarget(target: HistoryCleanupTarget): Promise<boolean>;
  /** Must compare version and protection under the same cross-process gate as tombstone commit. */
  deleteTarget(target: HistoryCleanupTarget, operationId: string): Promise<HistoryCleanupTargetResult>;
  /** Called only after storage has committed logical removal. */
  finishTarget?(target: HistoryCleanupTarget, operationId: string, result: HistoryCleanupTargetResult): Promise<HistoryCleanupTargetResult>;
  /** Returns undefined unless this operation already has a durable tombstone. Must never authorize a new target. */
  recoverCommittedTarget?(target: HistoryCleanupTarget, operationId: string): Promise<HistoryCleanupTargetResult | undefined>;
}
export interface HistoryCleanupJournalRecord {
  version: 1;
  confirmedAt?: number;
  ownerPid?: number;
  state: HistoryCleanupState;
  items: Array<{ target: HistoryCleanupTarget; result?: HistoryCleanupTargetResult }>;
  excluded?: { protected: number; unknown: number };
}
export interface HistoryCleanupJournal {
  load(): Promise<HistoryCleanupJournalRecord | undefined>;
  save(record: HistoryCleanupJournalRecord, changedIndex?: number): Promise<void>;
  loadPending?(): Promise<HistoryCleanupJournalRecord[]>;
}

/** Immutable target plans, per-target result deltas and compact state checkpoints keep writes linear.
 * Terminal snapshots consolidate once; pending plans and deletion tombstones are never pruned. */
export class FileHistoryCleanupJournal implements HistoryCleanupJournal {
  private readonly uri: vscode.Uri;
  private readonly operationsUri: vscode.Uri;
  private readonly pruned = new Set<string>();
  public constructor(private readonly globalStorageUri: vscode.Uri, workspaceKey: string) {
    const hash = createHash('sha256').update(workspaceKey).digest('hex').slice(0, 32);
    this.uri = vscode.Uri.joinPath(globalStorageUri, 'history-cleanup', 'v1', 'operations', `${hash}.json`);
    this.operationsUri = vscode.Uri.joinPath(globalStorageUri, 'history-cleanup', 'v1', 'operations', hash);
  }
  private key(operationId: string): string { return createHash('sha256').update(operationId).digest('hex'); }
  private file(operationId: string, suffix = '.json'): vscode.Uri {
    return vscode.Uri.joinPath(this.operationsUri, `${this.key(operationId)}${suffix}`);
  }
  private async readJson(uri: vscode.Uri): Promise<unknown | undefined> {
    try {
      await assertManagedStoragePath(this.globalStorageUri, uri);
      return JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as unknown;
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'ENOENT' || code === 'FileNotFound') return undefined;
      throw journalReadError(error);
    }
  }
  private async write(uri: vscode.Uri, value: unknown): Promise<void> {
    await assertManagedStoragePath(this.globalStorageUri, uri);
    await writeJsonAtomic(uri, value, { durable: true });
  }
  private async loadOperation(operationId: string): Promise<HistoryCleanupJournalRecord | undefined> {
    const raw = await this.readJson(this.file(operationId));
    if (raw === undefined) return undefined;
    const initial = isRecord(raw) && raw.version === 2 ? raw.record : raw;
    let record = normalizeHistoryCleanupJournal(initial);
    if (!record || record.state.operationId !== operationId) throw new HistoryCleanupError('journal_corrupt');
    const consolidated = await this.readJson(this.file(operationId, '.complete.json'));
    if (consolidated !== undefined) {
      const snapshot = normalizeHistoryCleanupJournal(consolidated);
      if (!snapshot || snapshot.state.operationId !== operationId || snapshot.items.length !== record.items.length) throw new HistoryCleanupError('journal_corrupt');
      record = snapshot;
    }
    const checkpoint = await this.readJson(this.file(operationId, '.state.json'));
    if (checkpoint !== undefined) {
      if (!isRecord(checkpoint) || checkpoint.version !== 2 || checkpoint.operationId !== operationId) throw new HistoryCleanupError('journal_corrupt');
      const merged = normalizeHistoryCleanupJournal({ ...record, state: checkpoint.state, ownerPid: checkpoint.ownerPid, confirmedAt: checkpoint.confirmedAt });
      if (!merged) throw new HistoryCleanupError('journal_corrupt');
      record = merged;
    }
    const resultsUri = this.file(operationId, '.results');
    let entries: [string, vscode.FileType][] = [];
    try { await assertManagedStoragePath(this.globalStorageUri, resultsUri); entries = await vscode.workspace.fs.readDirectory(resultsUri); }
    catch (error) { if (!isMissingJournalFile(error)) throw journalReadError(error); }
    for (const [name, type] of entries) {
      // A process may die after writing a same-directory atomic temporary file. It is not a committed delta.
      if (type === vscode.FileType.File && /^\.keepseek-[a-f0-9-]+\.tmp$/u.test(name)) continue;
      if (type !== vscode.FileType.File || !/^[0-9]{1,10}\.json$/u.test(name)) throw new HistoryCleanupError('journal_corrupt');
      const index = Number(name.slice(0, -5));
      const delta = await this.readJson(vscode.Uri.joinPath(resultsUri, name));
      if (!isRecord(delta) || delta.version !== 1 || delta.operationId !== operationId || delta.index !== index
        || !Number.isSafeInteger(index) || index < 0 || index >= record.items.length || !isValidTargetResult(delta.result)) throw new HistoryCleanupError('journal_corrupt');
      record.items[index].result = sanitizeTargetResult(delta.result);
    }
    recountHistoryCleanupRecord(record);
    return record;
  }
  public async load(): Promise<HistoryCleanupJournalRecord | undefined> {
    const pointer = await this.readJson(this.uri);
    let legacy = normalizeHistoryCleanupJournal(pointer);
    let selected = legacy?.state.operationId ?? (isRecord(pointer) && pointer.version === 2 && validIdentity(pointer.operationId) ? pointer.operationId : undefined);
    if (pointer !== undefined && !selected) throw new HistoryCleanupError('journal_corrupt');
    let selectedTime = legacy?.confirmedAt ?? legacy?.state.now ?? (isRecord(pointer) && typeof pointer.confirmedAt === 'number' ? pointer.confirmedAt : -Infinity);
    for (const metadata of await this.metadata()) {
      const time = metadata.confirmedAt ?? metadata.state.now;
      if (!selected || time > selectedTime) { selected = metadata.state.operationId; selectedTime = time; legacy = undefined; }
    }
    return selected ? await this.loadOperation(selected) ?? legacy : undefined;
  }
  public async loadPending(): Promise<HistoryCleanupJournalRecord[]> {
    const result: HistoryCleanupJournalRecord[] = [];
    for (const metadata of await this.metadata()) {
      if (metadata.state.status !== 'running' && !metadata.state.removedPendingCleanup) continue;
      const record = await this.loadOperation(metadata.state.operationId);
      if (record && (record.state.status === 'running' || record.items.some(item => item.result?.status === 'removedPendingCleanup' && !item.result.inaccessibleLegacySource))) result.push(record);
    }
    return result;
  }
  public async save(record: HistoryCleanupJournalRecord, changedIndex?: number): Promise<void> {
    const operationId = record.state.operationId;
    await withAssociatedStoreGate(this.globalStorageUri, `history-cleanup:${operationId}`, async () => {
      const previous = await this.readJson(this.file(operationId, '.state.json'));
      if (isRecord(previous) && isRecord(previous.state) && previous.state.status === 'running'
        && typeof previous.ownerPid === 'number' && previous.ownerPid !== record.ownerPid && processMayBeAlive(previous.ownerPid)) throw new HistoryCleanupError('cleanup_busy');
      const planUri = this.file(operationId);
      await assertManagedStoragePath(this.globalStorageUri, planUri);
      try {
        if ((await vscode.workspace.fs.stat(planUri)).type !== vscode.FileType.File) throw new HistoryCleanupError('journal_corrupt');
      } catch (error) {
        if (!isMissingJournalFile(error)) throw error;
        await this.write(planUri, { version: 2, record: minimalJournalRecord(record) });
      }
      if (changedIndex !== undefined) {
        const item = record.items[changedIndex];
        if (!item?.result || !Number.isSafeInteger(changedIndex) || changedIndex < 0) throw new HistoryCleanupError('journal_corrupt');
        await this.write(vscode.Uri.joinPath(this.file(operationId, '.results'), `${changedIndex}.json`),
          { version: 1, operationId, index: changedIndex, result: sanitizeTargetResult(item.result) });
      }
      if (record.state.status === 'completed' || record.state.status === 'failed') {
        await this.write(this.file(operationId, '.complete.json'), minimalJournalRecord(record));
        const results = this.file(operationId, '.results');
        await assertManagedStoragePath(this.globalStorageUri, results);
        await deleteStorageUri(results, { recursive: true });
      }
      await this.write(this.file(operationId, '.state.json'), { version: 2, operationId,
        confirmedAt: record.confirmedAt, ownerPid: record.ownerPid, state: record.state });
    });
    await this.write(this.uri, { version: 2, operationId, confirmedAt: record.confirmedAt ?? record.state.now });
    if (record.state.status === 'completed' && !record.state.removedPendingCleanup && !this.pruned.has(operationId)) {
      this.pruned.add(operationId); await this.pruneCompleted().catch(() => undefined);
    }
  }
  private async metadata(): Promise<Array<{ state: HistoryCleanupState; confirmedAt?: number; ownerPid?: number }>> {
    let entries: [string, vscode.FileType][];
    try { await assertManagedStoragePath(this.globalStorageUri, this.operationsUri); entries = await vscode.workspace.fs.readDirectory(this.operationsUri); }
    catch (error) { if (isMissingJournalFile(error)) return []; throw journalReadError(error); }
    const result: Array<{ state: HistoryCleanupState; confirmedAt?: number; ownerPid?: number }> = [];
    for (const [name, type] of entries) {
      if (type !== vscode.FileType.File || !/^[a-f0-9]{64}\.json$/u.test(name)) continue;
      const key = name.slice(0, -5);
      const checkpoint = await this.readJson(vscode.Uri.joinPath(this.operationsUri, `${key}.state.json`));
      if (isRecord(checkpoint) && checkpoint.version === 2 && isRecord(checkpoint.state)
        && validIdentity(checkpoint.state.operationId) && this.key(checkpoint.state.operationId) === key) {
        result.push(checkpoint as unknown as { state: HistoryCleanupState; confirmedAt?: number; ownerPid?: number }); continue;
      }
      const raw = await this.readJson(vscode.Uri.joinPath(this.operationsUri, name));
      const record = normalizeHistoryCleanupJournal(isRecord(raw) && raw.version === 2 ? raw.record : raw);
      if (!record || this.key(record.state.operationId) !== key) throw new HistoryCleanupError('journal_corrupt');
      result.push(record);
    }
    return result;
  }
  private async pruneCompleted(): Promise<void> {
    const terminal = (await this.metadata()).filter(({ state }) => state.status === 'completed' && !state.removedPendingCleanup)
      .sort((a, b) => (b.confirmedAt ?? b.state.now) - (a.confirmedAt ?? a.state.now));
    for (const { state } of terminal.slice(20)) {
      for (const suffix of ['.json', '.state.json', '.complete.json', '.results']) {
        const target = this.file(state.operationId, suffix);
        await assertManagedStoragePath(this.globalStorageUri, target);
        await deleteStorageUri(target, { recursive: suffix === '.results' });
      }
    }
  }
}

export class HistoryCleanupError extends Error {
  public constructor(public readonly code: string, options?: { cause?: unknown }) {
    super(code, options); this.name = 'HistoryCleanupError';
  }
}

/** Corrupt JSON is distinct from denied access, unsupported URI or unsafe paths.
 * Keep the original error for the Host's sanitized diagnostic classification. */
function journalReadError(error: unknown): HistoryCleanupError {
  if (error instanceof HistoryCleanupError) return error;
  return new HistoryCleanupError(error instanceof SyntaxError ? 'journal_corrupt' : 'journal_unavailable', { cause: error });
}

export function validateHistoryCleanupOptions(value: unknown): HistoryCleanupOptions {
  if (!isRecord(value) || (value.scope !== 'current' && value.scope !== 'all')) throw new HistoryCleanupError('invalid_scope');
  if (value.mode === 'all') {
    if (value.days !== undefined) throw new HistoryCleanupError('invalid_days');
    return { scope: value.scope, mode: 'all' };
  }
  if (value.mode !== 'olderThan') throw new HistoryCleanupError('invalid_mode');
  if (typeof value.days !== 'number' || !Number.isInteger(value.days) || value.days < 1 || value.days > 7) {
    throw new HistoryCleanupError('invalid_days');
  }
  return { scope: value.scope, mode: 'olderThan', days: value.days };
}

export function selectHistoryCleanupTargets(
  entries: readonly HistoryCleanupCatalogEntry[], options: HistoryCleanupOptions, now: number,
  currentWorkspaceKey: string, initialUnknown = 0
): { targets: HistoryCleanupTarget[]; protectedCount: number; unknownCount: number; cutoff?: number } {
  const validated = validateHistoryCleanupOptions(options);
  if (!Number.isFinite(now)) throw new HistoryCleanupError('invalid_now');
  const cutoff = validated.mode === 'olderThan' ? now - validated.days * DAY_MS : undefined;
  const targets: HistoryCleanupTarget[] = [];
  let protectedCount = 0, unknownCount = initialUnknown;
  const unique = new Map<string, HistoryCleanupCatalogEntry>();
  const conflicting = new Set<string>();
  for (const entry of entries) {
    if (validated.scope === 'current' && entry.workspaceKey !== currentWorkspaceKey) continue;
    if (!validIdentity(entry.workspaceKey) || !validIdentity(entry.id) || !entry.version || entry.unknownReason) {
      unknownCount++; continue;
    }
    const key = JSON.stringify([entry.workspaceKey, entry.id]);
    const previous = unique.get(key);
    if (previous && previous.version !== entry.version) conflicting.add(key);
    else unique.set(key, entry);
  }
  for (const [key, entry] of unique) {
    if (conflicting.has(key)) { unknownCount++; continue; }
    if (!entry.hasHistory) continue;
    if (cutoff !== undefined) {
      // Only a missing updatedAt may fall back. Corrupt updatedAt must never become epoch.
      const missing = entry.updatedAt === undefined;
      const timestamp = missing
        ? entry.createdAtTrusted === false ? undefined : trustworthyTimestamp(entry.createdAt)
        : entry.updatedAtTrusted === false ? undefined : trustworthyTimestamp(entry.updatedAt);
      if (timestamp === undefined) { unknownCount++; continue; }
      if (timestamp >= cutoff) continue;
    }
    if (entry.protectedReason) { protectedCount++; continue; }
    targets.push(structuredClone(entry));
  }
  return { targets, protectedCount, unknownCount, cutoff };
}

interface PreviewPlan { preview: HistoryCleanupPreview; webviewId: string; targets: HistoryCleanupTarget[]; generation: number }
interface RequestOwner { requestId: string; webviewId: string; promise: Promise<HistoryCleanupState> }

/** Local orchestration only. Rules, native confirmation and destructive storage are separate boundaries. */
export class SessionHistoryCleanupService {
  private readonly plans = new Map<string, PreviewPlan>();
  private readonly generations = new Map<string, number>();
  private owner?: RequestOwner;
  private current?: HistoryCleanupState;
  private record?: HistoryCleanupJournalRecord;
  private recovery?: Promise<HistoryCleanupState | undefined>;
  private recoveryRunning = false;
  private readonly completedRequests = new Map<string, { token: string; state: HistoryCleanupState }>();
  public constructor(private readonly adapter: HistoryCleanupAdapter, private readonly config: {
    now?: () => number; tokenTtlMs?: number; journal?: HistoryCleanupJournal; currentSessionId?: () => string | undefined;
  } = {}) {}

  public hasLocalOwner(): boolean { return !!this.owner || this.recoveryRunning; }
  public getCurrentOperation(): HistoryCleanupState | undefined { return this.current ? structuredClone(this.current) : undefined; }

  /** Opening the dialog only inspects a result. It never claims a recovery
   * owner, saves a journal, or starts physical recycling. Runtime recovery is a
   * separate background operation, and a late disk read cannot replace it. */
  public async inspectCurrentOperation(): Promise<HistoryCleanupState | undefined> {
    if (this.hasLocalOwner() && this.current) return this.getCurrentOperation();
    const record = await this.config.journal?.load();
    if (this.hasLocalOwner() && this.current) return this.getCurrentOperation();
    return record ? structuredClone(record.state) : this.getCurrentOperation();
  }
  public invalidate(webviewId: string): void {
    this.generations.set(webviewId, (this.generations.get(webviewId) ?? 0) + 1);
    for (const [token, plan] of this.plans) if (plan.webviewId === webviewId) this.plans.delete(token);
  }

  public async preview(requestId: string, webviewId: string, rawOptions: unknown, currentWorkspaceKey: string): Promise<HistoryCleanupPreview> {
    if (!validIdentity(requestId) || !validIdentity(webviewId)) throw new HistoryCleanupError('invalid_request');
    if (this.owner || this.recoveryRunning) throw new HistoryCleanupError('cleanup_busy');
    const options = validateHistoryCleanupOptions(rawOptions);
    this.invalidate(webviewId);
    const generation = this.generations.get(webviewId)!;
    const now = this.now();
    const catalog = await this.adapter.readCatalog(options.scope, currentWorkspaceKey);
    if (generation !== this.generations.get(webviewId)) throw new HistoryCleanupError('stale_preview');
    const selected = selectHistoryCleanupTargets(catalog.entries, options, now, currentWorkspaceKey, catalog.unknown);
    const preview: HistoryCleanupPreview = {
      requestId, previewToken: randomUUID(), options, now, cutoff: selected.cutoff,
      expiresAt: now + (this.config.tokenTtlMs ?? TOKEN_TTL_MS), candidateCount: selected.targets.length,
      favoriteCount: selected.targets.filter(target => target.isFavorite).length,
      protectedCount: selected.protectedCount, unknownCount: selected.unknownCount,
      includesCurrentSession: selected.targets.some(target => target.workspaceKey === currentWorkspaceKey && target.id === this.config.currentSessionId?.()),
      ...(catalog.diagnostics?.length ? { diagnostics: catalog.diagnostics.slice(0, 32).map(issue => ({
        code: issue.code, phase: issue.phase,
        ...(typeof issue.retryable === 'boolean' ? { retryable: issue.retryable } : {}),
        ...(issue.workspaceHash && /^[a-f0-9]{12,64}$/u.test(issue.workspaceHash) ? { workspaceHash: issue.workspaceHash } : {})
      })) } : {})
    };
    this.plans.set(preview.previewToken, { preview, webviewId, targets: selected.targets, generation });
    return structuredClone(preview);
  }

  /** Synchronous reservation precedes the first await, including native modal confirmation. */
  public request(requestId: string, webviewId: string, token: string,
    confirm: (preview: HistoryCleanupPreview) => Promise<boolean>, onProgress?: (state: HistoryCleanupState) => void
  ): Promise<HistoryCleanupState> {
    const completedKey = JSON.stringify([webviewId, requestId]);
    const completed = this.completedRequests.get(completedKey);
    if (completed) return completed.token === token ? Promise.resolve(structuredClone(completed.state))
      : Promise.reject(new HistoryCleanupError('invalid_request'));
    if (this.recoveryRunning) return Promise.reject(new HistoryCleanupError('cleanup_busy'));
    if (this.owner) {
      if (this.owner.requestId === requestId && this.owner.webviewId === webviewId) return this.owner.promise;
      return Promise.reject(new HistoryCleanupError('cleanup_busy'));
    }
    const plan = this.plans.get(token);
    if (!validIdentity(requestId) || !plan || plan.webviewId !== webviewId || plan.generation !== this.generations.get(webviewId)) {
      return Promise.reject(new HistoryCleanupError('invalid_preview'));
    }
    if (this.now() > plan.preview.expiresAt) { this.plans.delete(token); return Promise.reject(new HistoryCleanupError('expired_preview')); }
    if (!plan.targets.length) return Promise.reject(new HistoryCleanupError('nothing_to_clean'));
    const owner: RequestOwner = { requestId, webviewId, promise: undefined as unknown as Promise<HistoryCleanupState> };
    this.owner = owner;
    // Deferring work by one microtask ensures re-entrant progress callbacks see the complete owner.
    owner.promise = Promise.resolve().then(() => this.execute(plan, requestId, token, confirm, onProgress)).then(state => {
      this.completedRequests.set(completedKey, { token, state: structuredClone(state) });
      if (this.completedRequests.size > 100) this.completedRequests.delete(this.completedRequests.keys().next().value!);
      return state;
    }).finally(() => {
      if (this.owner === owner) this.owner = undefined;
    });
    return owner.promise;
  }

  /** Restart resumes physical cleanup of committed identities only, never a frozen but uncommitted plan. */
  public recover(onProgress?: (state: HistoryCleanupState) => void): Promise<HistoryCleanupState | undefined> {
    if (this.recovery) return this.recovery;
    this.recoveryRunning = true;
    this.recovery = this.recoverImpl(onProgress).finally(() => { this.recoveryRunning = false; this.recovery = undefined; });
    return this.recovery;
  }
  private async recoverImpl(onProgress?: (state: HistoryCleanupState) => void): Promise<HistoryCleanupState | undefined> {
    if (this.owner) throw new HistoryCleanupError('cleanup_busy');
    const latest = await this.config.journal?.load();
    const pending = await this.config.journal?.loadPending?.() ?? [];
    if (!latest && !pending.length) return undefined;
    const latestId = latest?.state.operationId ?? pending.at(-1)!.state.operationId;
    // New per-operation records are written before the latest pointer and may contain a newer durable phase.
    const records = new Map<string, HistoryCleanupJournalRecord>();
    if (latest) records.set(latest.state.operationId, latest);
    for (const record of pending) records.set(record.state.operationId, record);
    const activeRecords = new Set<string>();
    for (const record of records.values()) {
      this.record = record; this.current = record.state;
      // Another living extension host may still be executing this operation. No TTL proves it finished.
      if (activeCleanupOperations.has(record.state.operationId) || (record.state.status === 'running'
        && record.ownerPid !== undefined && record.ownerPid !== process.pid && processMayBeAlive(record.ownerPid))) {
        activeRecords.add(record.state.operationId); continue;
      }
      if (record.state.status !== 'running' && !record.items.some(item => item.result?.status === 'removedPendingCleanup' && !item.result.inaccessibleLegacySource)) continue;
      record.state.status = 'running'; record.ownerPid = process.pid;
      activeCleanupOperations.add(record.state.operationId);
      try {
        // Claim recovery before physical work; the operation gate rejects a second living owner.
        await this.persist(record);
      for (const [index, item] of record.items.entries()) {
        if (item.result && item.result.status !== 'removedPendingCleanup') continue;
        // Inaccessible old Mementos remain explicit pending sources, rather than a spurious retry success.
        if (item.result?.inaccessibleLegacySource) continue;
        try {
          const recovered = await this.adapter.recoverCommittedTarget?.(item.target, record.state.operationId);
          item.result = sanitizeTargetResult(recovered ?? { status: 'failedBeforeCommit', reason: 'interrupted_before_commit' });
        } catch {
          item.result ??= { status: 'unknown', reason: 'recovery_unavailable' };
        }
        this.recount(record);
        await this.persist(record, index);
        if (record.state.operationId === latestId) onProgress?.(this.getCurrentOperation()!);
      }
      this.recount(record);
      record.state.status = 'completed';
      await this.persist(record);
      } finally { activeCleanupOperations.delete(record.state.operationId); }

    }
    const selected = records.get(latestId)!;
    this.record = selected; this.current = selected.state;
    // Restore the original latest operation after reclaiming an older window's pending records.
    // Journal load chooses the latest confirmed operation independently of progress checkpoint write order.
    onProgress?.(this.getCurrentOperation()!);
    return this.getCurrentOperation();
  }

  private async execute(plan: PreviewPlan, requestId: string, token: string,
    confirm: (preview: HistoryCleanupPreview) => Promise<boolean>, onProgress?: (state: HistoryCleanupState) => void
  ): Promise<HistoryCleanupState> {
    const state: HistoryCleanupState = {
      requestId, operationId: randomUUID(), status: 'confirming', options: structuredClone(plan.preview.options),
      now: plan.preview.now, cutoff: plan.preview.cutoff, total: plan.targets.length, processed: 0,
      fullyDeleted: 0, protected: plan.preview.protectedCount, skippedChanged: 0, unknown: plan.preview.unknownCount,
      failedBeforeCommit: 0, removedPendingCleanup: 0, inaccessibleLegacy: 0,
      favoriteCount: plan.preview.favoriteCount, includesCurrentSession: plan.preview.includesCurrentSession
    };
    this.current = state;
    onProgress?.(structuredClone(state));
    let confirmed = false;
    let journalWriteAttempted = false;
    try {
      confirmed = await confirm(structuredClone(plan.preview));
      if (!confirmed) { state.status = 'cancelled'; onProgress?.(structuredClone(state)); return state; }
      if (this.plans.get(token) !== plan || this.generations.get(plan.webviewId) !== plan.generation) throw new HistoryCleanupError('invalid_preview');
      if (this.now() > plan.preview.expiresAt) throw new HistoryCleanupError('expired_preview');
      // Whole-plan admission, before recording or mutating any target. Bounded and no body hydration.
      for (const target of plan.targets) if (!await this.adapter.revalidateTarget(target)) throw new HistoryCleanupError('history_changed');
      state.status = 'running';
      const record: HistoryCleanupJournalRecord = { version: 1, confirmedAt: this.now(), ownerPid: process.pid, state, items: plan.targets.map(target => ({ target })),
        excluded: { protected: plan.preview.protectedCount, unknown: plan.preview.unknownCount } };
      this.current = state; this.record = record;
      activeCleanupOperations.add(state.operationId);
      journalWriteAttempted = true;
      await this.persist(record);
      onProgress?.(structuredClone(state));
      // One target at a time bounds disk pressure; stores hold only their own short commit gate.
      let committedAny = false;
      for (const [index, item] of record.items.entries()) {
        let result: HistoryCleanupTargetResult;
        try {
          result = await this.adapter.deleteTarget(item.target, state.operationId);
          if ((result.status === 'fullyDeleted' || result.status === 'removedPendingCleanup') && this.adapter.finishTarget) {
            // Persist logical removal before optional associated reclamation so interruption is recoverable.
            item.result = { status: 'removedPendingCleanup', reason: 'reclaiming' };
            this.recount(record); await this.persist(record, index);
            try { result = await this.adapter.finishTarget(item.target, state.operationId, result); }
            catch { result = { status: 'removedPendingCleanup', reason: 'associated_cleanup_failed' }; }
          }
        } catch {
          // Never report "still retained" when a failed I/O prevented determining whether commit happened.
          if (item.result?.status === 'removedPendingCleanup') result = item.result;
          else if (this.adapter.recoverCommittedTarget) {
            try {
              result = await this.adapter.recoverCommittedTarget(item.target, state.operationId)
                ?? { status: 'failedBeforeCommit', reason: 'storage_failed' };
            } catch { result = { status: 'unknown', reason: 'storage_outcome_unavailable' }; }
          } else result = { status: 'unknown', reason: 'storage_outcome_unavailable' };
        }
        committedAny ||= result.status === 'fullyDeleted' || result.status === 'removedPendingCleanup';
        item.result = sanitizeTargetResult(result);
        if (!committedAny && (result.status === 'skippedChanged' || result.status === 'protected')) {
          // Final admission can race the whole-plan check. Before any committed deletion, the
          // changed set requires another preview/confirmation rather than silently shrinking it.
          for (const remaining of record.items) remaining.result ??= { status: 'failedBeforeCommit', reason: 'history_changed' };
          this.recount(record);
          state.status = 'failed'; state.error = 'history_changed';
          await this.persist(record);
          onProgress?.(structuredClone(state));
          return structuredClone(state);
        }
        this.recount(record);
        await this.persist(record, index);
        onProgress?.(structuredClone(state));
      }
      state.status = 'completed';
      await this.persist(record);
      onProgress?.(structuredClone(state));
      return structuredClone(state);
    } catch (error) {
      state.status = 'failed';
      state.error = error instanceof HistoryCleanupError ? error.code : 'cleanup_failed';
      if (confirmed) {
        this.current = state;
        if (!journalWriteAttempted) {
          // This is a result record, never a deletion intent. No candidate can be resumed from it.
          const failedRecord: HistoryCleanupJournalRecord = { version: 1, confirmedAt: this.now(), ownerPid: process.pid, state,
            excluded: { protected: plan.preview.protectedCount, unknown: plan.preview.unknownCount },
            items: plan.targets.map(target => ({ target, result: { status: 'failedBeforeCommit',
              reason: state.error === 'history_changed' ? 'history_changed' : 'interrupted_before_commit' } })) };
          this.record = failedRecord; this.recount(failedRecord);
          await this.persist(failedRecord).catch(() => { state.error = 'journal_unavailable'; });
        }
        // A journal I/O failure must not overwrite an existing running durable checkpoint.
      }
      onProgress?.(structuredClone(state));
      return structuredClone(state);
    } finally {
      activeCleanupOperations.delete(state.operationId);
      this.plans.delete(token);
    }
  }
  private recount(record: HistoryCleanupJournalRecord): void { recountHistoryCleanupRecord(record); }

  private async persist(record: HistoryCleanupJournalRecord, changedIndex?: number): Promise<void> {
    await this.config.journal?.save(record, changedIndex);
  }

  private now(): number { return (this.config.now ?? Date.now)(); }
}

export function normalizeHistoryCleanupJournal(value: unknown): HistoryCleanupJournalRecord | undefined {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.state) || !Array.isArray(value.items)) return undefined;
  const state = value.state;
  if (value.ownerPid !== undefined && (typeof value.ownerPid !== 'number' || !Number.isSafeInteger(value.ownerPid) || value.ownerPid <= 0)) return undefined;
  if (value.confirmedAt !== undefined && (typeof value.confirmedAt !== 'number' || !Number.isFinite(value.confirmedAt))) return undefined;
  try { validateHistoryCleanupOptions(state.options); } catch { return undefined; }
  if (!validIdentity(state.operationId) || !validIdentity(state.requestId)
    || !['running', 'completed', 'failed'].includes(String(state.status)) || typeof state.now !== 'number' || !Number.isFinite(state.now)) return undefined;
  const counterKeys = ['total', 'processed', 'fullyDeleted', 'protected', 'skippedChanged', 'unknown', 'failedBeforeCommit', 'removedPendingCleanup', 'inaccessibleLegacy', 'favoriteCount'];
  if (counterKeys.some(key => typeof state[key] !== 'number' || !Number.isInteger(state[key]) || (state[key] as number) < 0)) return undefined;
  for (const item of value.items) {
    if (!isRecord(item) || !isRecord(item.target) || !validIdentity(item.target.workspaceKey) || !validIdentity(item.target.id) || !validIdentity(item.target.version)) return undefined;
    if (item.result !== undefined && !isValidTargetResult(item.result)) return undefined;
  }
  if (state.reasonCounts !== undefined && (!isRecord(state.reasonCounts) || Object.keys(state.reasonCounts).length > 32
    || Object.entries(state.reasonCounts).some(([key, count]) => !/^[a-z][a-z0-9_]{0,63}$/u.test(key)
      || typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1))) return undefined;
  if (state.total !== value.items.length || (state.processed as number) > value.items.length) return undefined;
  if (value.excluded !== undefined && (!isRecord(value.excluded) || !Number.isInteger(value.excluded.protected)
    || !Number.isInteger(value.excluded.unknown) || (value.excluded.protected as number) < 0 || (value.excluded.unknown as number) < 0)) return undefined;
  return structuredClone(value) as unknown as HistoryCleanupJournalRecord;
}
function trustworthyTimestamp(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const fields = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!fields) return undefined;
  const [, y, m, d, hh, mm, ss] = fields;
  const year = Number(y), month = Number(m), day = Number(d);
  const monthEnd = new Date(0); monthEnd.setUTCFullYear(year, month, 0);
  if (month < 1 || month > 12 || day < 1 || day > monthEnd.getUTCDate()
    || Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function validIdentity(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }

function processMayBeAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH'); }
}

const SAFE_REASON_CODES = new Set([
  'reclaiming', 'associated_cleanup_failed', 'interrupted_before_commit', 'recovery_unavailable', 'storage_failed',
  'storage_outcome_unavailable', 'storage_cleanup_failed', 'session_storage_pending', 'workspace_state_cleanup_failed',
  'inaccessible_legacy_source', 'unverified_legacy_logs', 'session_in_use', 'storage_ownership_unavailable',
  'deletion_intent_scope_conflict', 'history_changed', 'unsafe_session_shard', 'unreadable_session_identity',
  'session_identity_mismatch', 'session_shard_changed', 'unsafe_session_objects', 'legacy_writer_lock', 'associated_cleanup_required',
  'evidence_cleanup_failed', 'subagents_cleanup_failed', 'usage_ledger_cleanup_failed', 'change_sets_cleanup_failed',
  'draft_runs_cleanup_failed', 'approval_reviews_cleanup_failed', 'interaction_traces_cleanup_failed'
]);
const SAFE_REASON_STORES = new Set(['evidence', 'subagents', 'usage-ledger', 'change-sets', 'draft-runs', 'approval-reviews', 'interaction-traces']);
function safeReasonCode(raw: string): string | undefined {
  if (SAFE_REASON_CODES.has(raw)) return raw;
  const [store, code, extra] = raw.split(':');
  if (extra !== undefined || !SAFE_REASON_STORES.has(store) || !/^[A-Za-z_]+$/u.test(code ?? '')) return undefined;
  if (code === 'legacy_ownership_unverified') return 'unverified_legacy_logs';
  return `${store.replace(/-/gu, '_')}_cleanup_failed`;
}

function sanitizeTargetResult(result: HistoryCleanupTargetResult): HistoryCleanupTargetResult {
  const codes = [...new Set((result.reason ?? '').split(/[;,]/u).map(safeReasonCode).filter((value): value is string => !!value))];
  return { status: result.status, ...(result.reason ? { reason: codes.join(';') || 'storage_cleanup_failed' } : {}),
    ...(result.inaccessibleLegacySource ? { inaccessibleLegacySource: true } : {}) };
}

function recountHistoryCleanupRecord(record: HistoryCleanupJournalRecord): void {
  const state = record.state;
  state.processed = 0; state.fullyDeleted = 0; state.skippedChanged = 0; state.failedBeforeCommit = 0;
  state.removedPendingCleanup = 0; state.inaccessibleLegacy = 0;
  const extraProtected = record.items.filter(item => item.result?.status === 'protected').length;
  const extraUnknown = record.items.filter(item => item.result?.status === 'unknown' || item.result?.status === 'unavailable').length;
  // Older operation records may lack explicit baselines; derive them from their persisted counters once.
  record.excluded ??= { protected: Math.max(0, state.protected - extraProtected), unknown: Math.max(0, state.unknown - extraUnknown) };
  state.protected = record.excluded.protected + extraProtected;
  state.unknown = record.excluded.unknown + extraUnknown;
  state.reasonCounts = {};
  for (const item of record.items) {
    if (!item.result) continue;
    for (const code of new Set((item.result.reason ?? '').split(/[;,]/u).map(safeReasonCode))) {
      if (!code) continue;
      if (!(code in state.reasonCounts) && Object.keys(state.reasonCounts).length >= 32) continue;
      state.reasonCounts[code] = (state.reasonCounts[code] ?? 0) + 1;
    }
    state.processed++;
    const status = item.result.status;
    if (status === 'fullyDeleted' || status === 'skippedChanged' || status === 'failedBeforeCommit' || status === 'removedPendingCleanup') state[status]++;
    if (item.result.inaccessibleLegacySource) state.inaccessibleLegacy++;
  }
}

function minimalJournalRecord(record: HistoryCleanupJournalRecord): HistoryCleanupJournalRecord {
  return { ...record, state: structuredClone(record.state), items: record.items.map(({ target, result }) => ({
    target: { workspaceKey: target.workspaceKey, id: target.id, version: target.version, isFavorite: target.isFavorite, hasHistory: target.hasHistory },
    result: result ? sanitizeTargetResult(result) : undefined
  })) };
}
function isMissingJournalFile(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && (error.code === 'ENOENT' || error.code === 'FileNotFound');
}
function isValidTargetResult(value: unknown): value is HistoryCleanupTargetResult {
  return isRecord(value) && ['fullyDeleted', 'protected', 'skippedChanged', 'unknown', 'unavailable', 'failedBeforeCommit', 'removedPendingCleanup'].includes(String(value.status))
    && (value.reason === undefined || typeof value.reason === 'string')
    && (value.inaccessibleLegacySource === undefined || typeof value.inaccessibleLegacySource === 'boolean');
}
