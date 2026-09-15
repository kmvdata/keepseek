import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import * as vscode from 'vscode';
import { stableStringify } from '../evidence/shaping';
import { verifyGoalContract } from './goalContract';
import {
  GOAL_RECORD_VERSION,
  isGoalActiveStatus,
  isGoalTerminalStatus,
  type GoalContractV1,
  type GoalJournalEventV1,
  type GoalRecordV1,
  type GoalStatus
} from './goalTypes';

interface GoalIndexEntryV1 {
  goalId: string;
  workspaceKey: string;
  sessionId: string;
  status: GoalStatus;
  contractHash: string;
  snapshotHash: string;
  /** Absent only for the original v1 single-snapshot layout. */
  snapshotFile?: string;
  updatedAt: string;
}

interface GoalIndexV1 {
  version: 1;
  entries: GoalIndexEntryV1[];
}

interface GoalSnapshotV1 {
  version: 1;
  recordHash: string;
  record: GoalRecordV1;
}

export class GoalStoreCorruptionError extends Error {
  public constructor(message: string, public readonly uri: string) { super(message); }
}

export class GoalStore {
  private readonly root: vscode.Uri;
  private index: GoalIndexV1 = { version: 1, entries: [] };
  private initialized = false;
  private writeChain: Promise<void> = Promise.resolve();

  public constructor(private readonly globalStorageUri: vscode.Uri) {
    this.root = vscode.Uri.joinPath(globalStorageUri, 'goals', 'v1');
  }

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    const uri = vscode.Uri.joinPath(this.root, 'index.json');
    const bytes = await readOptional(uri);
    if (bytes) {
      try {
        this.index = normalizeIndex(JSON.parse(new TextDecoder().decode(bytes)));
        for (const entry of this.index.entries) await this.readSnapshot(entry);
      } catch (error) {
        try {
          this.index = await this.recoverIndexFromSnapshots();
          await writeAtomicJson(uri, this.index);
        } catch (recoveryError) {
          throw new GoalStoreCorruptionError(
            `Goal index is damaged and snapshots could not be recovered: ${String(error)}; ${String(recoveryError)}`,
            uri.toString()
          );
        }
      }
    } else if (await this.hasStoredRecords()) {
      try {
        this.index = await this.recoverIndexFromSnapshots();
        await writeAtomicJson(uri, this.index);
      } catch (error) {
        throw new GoalStoreCorruptionError(
          `Goal index is missing while persisted records exist: ${String(error)}`,
          uri.toString()
        );
      }
    }
    this.initialized = true;
  }

  public async create(input: {
    workspaceKey: string;
    sessionId: string;
    contract: GoalContractV1;
    initialPrompt: GoalRecordV1['initialPrompt'];
    requiredExternalAuthorizationUris?: string[];
    now?: string;
    id?: string;
  }): Promise<GoalRecordV1> {
    await this.initialize();
    if (!verifyGoalContract(input.contract)) throw new Error('Goal contract hash is invalid.');
    return this.serialize(async () => {
      const active = await this.loadWorkspaceUnlocked(input.workspaceKey);
      if (active && isGoalActiveStatus(active.status)) throw new Error('Only one active Goal is allowed in this workspace.');
      const now = input.now ?? new Date().toISOString();
      const id = input.id ?? randomUUID();
      const record: GoalRecordV1 = {
        version: GOAL_RECORD_VERSION,
        id,
        workspaceKey: input.workspaceKey,
        sessionId: input.sessionId,
        initialPrompt: structuredClone(input.initialPrompt),
        requiredExternalAuthorizationUris: [...(input.requiredExternalAuthorizationUris ?? [])],
        status: 'preparing',
        revisions: [{ revision: 1, contract: structuredClone(input.contract), createdAt: now }],
        currentRevision: 1,
        currentContractHash: input.contract.canonicalHash,
        usage: {
          activeExecutionMs: 0, costByCurrency: {}, modelRequests: 0,
          mainModelRequests: 0, auxiliaryModelRequests: 0, completionReviews: 0
        },
        workspaceMutationRevision: 0,
        validations: [],
        criteria: input.contract.acceptanceCriteria.map((criterion) => ({
          criterionId: criterion.id, status: 'pending', evidenceRefs: []
        })),
        consumedResultKeys: [],
        requestIntents: [],
        journalShards: [],
        nextJournalSequence: 1,
        sideEffects: {
          changeSetIds: [], draftRunIds: [], approvalIds: [], pendingToolCallIds: [],
          uncertainToolCallIds: [], subagentIds: []
        },
        createdAt: now,
        updatedAt: now
      };
      await this.writeSnapshotAndIndex(record);
      return structuredClone(record);
    });
  }

  public async load(goalId: string): Promise<GoalRecordV1 | undefined> {
    await this.initialize();
    const entry = this.index.entries.find((item) => item.goalId === goalId);
    if (!entry) return undefined;
    return this.readSnapshot(entry);
  }

  public async loadWorkspace(workspaceKey: string): Promise<GoalRecordV1 | undefined> {
    await this.initialize();
    return this.loadWorkspaceUnlocked(workspaceKey);
  }

  public async save(record: GoalRecordV1): Promise<GoalRecordV1> {
    await this.initialize();
    return this.serialize(async () => {
      normalizeRecord(record);
      const current = this.index.entries.find((entry) => entry.goalId === record.id);
      if (!current) throw new Error('Goal is not registered in the index.');
      if (current.workspaceKey !== record.workspaceKey || current.sessionId !== record.sessionId) {
        throw new Error('Goal workspace/session identity cannot change.');
      }
      await this.writeSnapshotAndIndex(record);
      return structuredClone(record);
    });
  }

  /** The journal shard is committed before the snapshot references it. A crash
   * may leave an unreferenced shard, but can never publish a missing event. */
  public async append(record: GoalRecordV1, type: string, payload: Record<string, unknown>, now = new Date().toISOString()): Promise<GoalRecordV1> {
    await this.initialize();
    return this.serialize(async () => {
      const current = await this.load(record.id);
      if (!current) throw new Error('Goal is unavailable.');
      if (current.nextJournalSequence !== record.nextJournalSequence) throw new Error('Stale Goal journal sequence.');
      if (hashRecord(current) !== hashRecord(record)) throw new Error('Stale Goal snapshot cannot append a journal event.');
      const sequence = record.nextJournalSequence;
      const shardName = `${String(sequence).padStart(10, '0')}.json`;
      const event: GoalJournalEventV1 = {
        version: 1, sequence, goalId: record.id, type: type.slice(0, 120), payload: structuredClone(payload), createdAt: now
      };
      await writeAtomicJson(vscode.Uri.joinPath(this.goalRoot(record.id), 'journal', shardName), event);
      const next = structuredClone(record);
      next.journalShards.push(shardName);
      next.nextJournalSequence = sequence + 1;
      next.updatedAt = now;
      await this.writeSnapshotAndIndex(next);
      return next;
    });
  }

  public async readJournal(record: GoalRecordV1): Promise<GoalJournalEventV1[]> {
    const events: GoalJournalEventV1[] = [];
    for (let index = 0; index < record.journalShards.length; index++) {
      const name = record.journalShards[index];
      const uri = vscode.Uri.joinPath(this.goalRoot(record.id), 'journal', name);
      const bytes = await readOptional(uri);
      if (!bytes) throw new GoalStoreCorruptionError(`Goal journal shard is missing: ${name}`, uri.toString());
      let event: GoalJournalEventV1;
      try { event = normalizeJournalEvent(JSON.parse(new TextDecoder().decode(bytes)), record.id, index + 1); }
      catch (error) { throw new GoalStoreCorruptionError(`Goal journal shard is damaged: ${String(error)}`, uri.toString()); }
      events.push(event);
    }
    return events;
  }

  public async clear(goalId: string): Promise<void> {
    await this.initialize();
    await this.serialize(async () => {
      const entry = this.index.entries.find((item) => item.goalId === goalId);
      if (!entry) return;
      const record = await this.readSnapshot(entry);
      if (!record) throw new GoalStoreCorruptionError('Goal snapshot is missing.', this.goalRoot(goalId).toString());
      if (!isGoalTerminalStatus(record.status)) throw new Error('Only completed, failed, or stopped Goals can be cleared.');
      const next: GoalIndexV1 = { version: 1, entries: this.index.entries.filter((item) => item.goalId !== goalId) };
      await writeAtomicJson(vscode.Uri.joinPath(this.root, 'index.json'), next);
      this.index = next;
      await vscode.workspace.fs.delete(this.goalRoot(goalId), { recursive: true, useTrash: false });
    });
  }

  public getRootUri(): vscode.Uri { return this.root; }

  private async hasStoredRecords(): Promise<boolean> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(this.root, 'records'));
      return entries.some(([, type]) => Boolean(type & vscode.FileType.Directory));
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'FileNotFound' || code === 'ENOENT' || /not found|enoent/iu.test(String(error))) return false;
      throw error;
    }
  }

  private async recoverIndexFromSnapshots(): Promise<GoalIndexV1> {
    const recordsRoot = vscode.Uri.joinPath(this.root, 'records');
    let entries: [string, vscode.FileType][];
    try { entries = await vscode.workspace.fs.readDirectory(recordsRoot); }
    catch (error) {
      if ((error as { code?: string }).code === 'FileNotFound' || /not found/iu.test(String(error))) {
        throw new Error('No recoverable Goal snapshots exist.');
      }
      throw error;
    }
    const recovered: GoalIndexEntryV1[] = [];
    for (const [goalId, type] of entries.sort(([left], [right]) => left.localeCompare(right))) {
      if (!(type & vscode.FileType.Directory) || !/^[A-Za-z0-9._-]+$/u.test(goalId)) continue;
      const selected = await this.recoverLatestSnapshot(recordsRoot, goalId);
      const { snapshot, snapshotHash, snapshotFile } = selected;
      recovered.push({
        goalId, workspaceKey: snapshot.record.workspaceKey, sessionId: snapshot.record.sessionId,
        status: snapshot.record.status, contractHash: snapshot.record.currentContractHash,
        snapshotHash, snapshotFile, updatedAt: snapshot.record.updatedAt
      });
    }
    if (!recovered.length) throw new Error('No recoverable Goal snapshots exist.');
    return { version: 1, entries: recovered.sort((left, right) => left.goalId.localeCompare(right.goalId)) };
  }

  private async recoverLatestSnapshot(recordsRoot: vscode.Uri, goalId: string): Promise<{
    snapshot: GoalSnapshotV1; snapshotHash: string; snapshotFile?: string;
  }> {
    const goalRoot = vscode.Uri.joinPath(recordsRoot, goalId);
    const candidates: Array<{ snapshot: GoalSnapshotV1; snapshotHash: string; snapshotFile?: string }> = [];
    const legacy = await readOptional(vscode.Uri.joinPath(goalRoot, 'snapshot.json'));
    if (legacy) candidates.push(readVerifiedSnapshot(legacy));
    try {
      const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(goalRoot, 'snapshots'));
      for (const [name, type] of entries.sort(([left], [right]) => left.localeCompare(right))) {
        if (!(type & vscode.FileType.File) || !/^[a-f0-9]{64}\.json$/u.test(name)) continue;
        const bytes = await readOptional(vscode.Uri.joinPath(goalRoot, 'snapshots', name));
        if (!bytes) continue;
        try { candidates.push({ ...readVerifiedSnapshot(bytes), snapshotFile: `snapshots/${name}` }); }
        catch { /* A partially damaged unreferenced generation is never selected. */ }
      }
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== 'FileNotFound' && code !== 'ENOENT' && !/not found|enoent/iu.test(String(error))) throw error;
    }
    const verified: typeof candidates = [];
    for (const candidate of candidates) {
      try {
        await verifyJournalShards(goalRoot, candidate.snapshot.record);
        verified.push(candidate);
      } catch { /* A snapshot referencing missing/damaged journal is not recoverable. */ }
    }
    const selected = verified.sort((left, right) => {
      const sequence = right.snapshot.record.nextJournalSequence - left.snapshot.record.nextJournalSequence;
      return sequence || right.snapshot.record.updatedAt.localeCompare(left.snapshot.record.updatedAt);
    })[0];
    if (!selected) throw new Error(`Missing valid snapshot for ${goalId}.`);
    return selected;
  }

  private async loadWorkspaceUnlocked(workspaceKey: string): Promise<GoalRecordV1 | undefined> {
    const candidates = this.index.entries.filter((entry) => entry.workspaceKey === workspaceKey)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    const active = candidates.filter((entry) => !isGoalTerminalStatus(entry.status));
    if (active.length > 1) throw new GoalStoreCorruptionError('Multiple active Goals are indexed for one workspace.', this.root.toString());
    return this.readSnapshot(active[0] ?? candidates[0]);
  }

  private async readSnapshot(entry: GoalIndexEntryV1 | undefined): Promise<GoalRecordV1 | undefined> {
    if (!entry) return undefined;
    const uri = entry.snapshotFile
      ? vscode.Uri.joinPath(this.goalRoot(entry.goalId), ...entry.snapshotFile.split('/'))
      : vscode.Uri.joinPath(this.goalRoot(entry.goalId), 'snapshot.json');
    const bytes = await readOptional(uri);
    if (!bytes) throw new GoalStoreCorruptionError('Goal snapshot is missing.', uri.toString());
    try {
      const { snapshot, snapshotHash: hash } = readVerifiedSnapshot(bytes);
      if (entry.snapshotHash !== hash) throw new Error('snapshot hash mismatch');
      await verifyJournalShards(this.goalRoot(entry.goalId), snapshot.record);
      return structuredClone(snapshot.record);
    } catch (error) {
      throw new GoalStoreCorruptionError(`Goal snapshot is damaged: ${String(error)}`, uri.toString());
    }
  }

  private async writeSnapshotAndIndex(record: GoalRecordV1): Promise<void> {
    normalizeRecord(record);
    const recordHash = hashRecord(record);
    const snapshotFile = `snapshots/${recordHash}.json`;
    await writeAtomicJson(vscode.Uri.joinPath(this.goalRoot(record.id), 'snapshots', `${recordHash}.json`), {
      version: 1, recordHash, record
    } satisfies GoalSnapshotV1);
    const entry: GoalIndexEntryV1 = {
      goalId: record.id, workspaceKey: record.workspaceKey, sessionId: record.sessionId,
      status: record.status, contractHash: record.currentContractHash, snapshotHash: recordHash, snapshotFile,
      updatedAt: record.updatedAt
    };
    const next: GoalIndexV1 = {
      version: 1,
      entries: [...this.index.entries.filter((item) => item.goalId !== record.id), entry]
        .sort((left, right) => left.goalId.localeCompare(right.goalId))
    };
    await writeAtomicJson(vscode.Uri.joinPath(this.root, 'index.json'), next);
    this.index = next;
  }

  private goalRoot(goalId: string): vscode.Uri {
    if (!/^[A-Za-z0-9._-]+$/u.test(goalId)) throw new Error('Invalid Goal id.');
    return vscode.Uri.joinPath(this.root, 'records', goalId);
  }

  private async serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.writeChain;
    let release!: () => void;
    this.writeChain = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    let guard: Awaited<ReturnType<typeof open>> | undefined;
    const guardPath = this.root.scheme === 'file' ? `${this.root.fsPath}.store-lock` : undefined;
    try {
      if (guardPath) {
        await mkdir(dirname(guardPath), { recursive: true });
        try { guard = await acquireStoreGuard(guardPath); }
        catch (error) {
          if ((error as { code?: string }).code === 'EEXIST') throw new Error('Goal Store is locked by another Extension Host.');
          throw error;
        }
        const bytes = await readOptional(vscode.Uri.joinPath(this.root, 'index.json'));
        this.index = bytes ? normalizeIndex(JSON.parse(new TextDecoder().decode(bytes))) : { version: 1, entries: [] };
      }
      return await operation();
    } finally {
      await guard?.close().catch(() => undefined);
      if (guardPath && guard) await unlink(guardPath).catch(() => undefined);
      release();
    }
  }
}

function normalizeIndex(value: unknown): GoalIndexV1 {
  if (!value || typeof value !== 'object' || (value as GoalIndexV1).version !== 1 || !Array.isArray((value as GoalIndexV1).entries)) {
    throw new Error('unsupported Goal index');
  }
  const entries = (value as GoalIndexV1).entries;
  if (entries.some((entry) => !entry.goalId || !entry.workspaceKey || !entry.sessionId || !entry.snapshotHash || !entry.contractHash
    || (entry.snapshotFile !== undefined && !/^snapshots\/[a-f0-9]{64}\.json$/u.test(entry.snapshotFile)))) {
    throw new Error('invalid Goal index entry');
  }
  return { version: 1, entries: structuredClone(entries) };
}

function readVerifiedSnapshot(bytes: Uint8Array): { snapshot: GoalSnapshotV1; snapshotHash: string } {
  const snapshot = JSON.parse(new TextDecoder().decode(bytes)) as GoalSnapshotV1;
  if (snapshot.version !== 1 || !snapshot.record) throw new Error('unsupported snapshot');
  normalizeRecord(snapshot.record);
  const snapshotHash = hashRecord(snapshot.record);
  if (snapshot.recordHash !== snapshotHash) throw new Error('snapshot hash mismatch');
  return { snapshot, snapshotHash };
}

function normalizeRecord(record: GoalRecordV1): void {
  record.requiredExternalAuthorizationUris ??= [];
  record.usage.mainModelRequests ??= record.usage.modelRequests ?? 0;
  record.usage.auxiliaryModelRequests ??= 0;
  if (record.version !== GOAL_RECORD_VERSION || !record.id || !record.workspaceKey || !record.sessionId
    || !record.initialPrompt?.visibleContent || !record.initialPrompt.expandedContent || !record.initialPrompt.providerContent
    || !record.currentContractHash || !Number.isSafeInteger(record.currentRevision) || record.currentRevision < 1
    || !Array.isArray(record.revisions) || !record.revisions.length || !Array.isArray(record.journalShards)
    || record.nextJournalSequence !== record.journalShards.length + 1) throw new Error('invalid Goal record');
  const contract = record.revisions.find((revision) => revision.revision === record.currentRevision)?.contract;
  if (!contract || !verifyGoalContract(contract) || contract.canonicalHash !== record.currentContractHash) throw new Error('invalid Goal contract revision');
}

function normalizeJournalEvent(value: unknown, goalId: string, sequence: number): GoalJournalEventV1 {
  const event = value as GoalJournalEventV1;
  if (!event || event.version !== 1 || event.goalId !== goalId || event.sequence !== sequence || typeof event.type !== 'string'
    || !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) throw new Error('invalid journal event');
  return structuredClone(event);
}

async function verifyJournalShards(goalRoot: vscode.Uri, record: GoalRecordV1): Promise<void> {
  for (let index = 0; index < record.journalShards.length; index++) {
    const name = record.journalShards[index];
    const uri = vscode.Uri.joinPath(goalRoot, 'journal', name);
    const bytes = await readOptional(uri);
    if (!bytes) throw new Error(`missing Goal journal shard ${name}`);
    normalizeJournalEvent(JSON.parse(new TextDecoder().decode(bytes)), record.id, index + 1);
  }
}

function hashRecord(record: GoalRecordV1): string {
  return createHash('sha256').update(stableStringify(record), 'utf8').digest('hex');
}

async function readOptional(uri: vscode.Uri): Promise<Uint8Array | undefined> {
  try { return await vscode.workspace.fs.readFile(uri); }
  catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'FileNotFound' || code === 'ENOENT' || /not found|enoent/iu.test(String(error))) return undefined;
    throw error;
  }
}

async function writeAtomicJson(uri: vscode.Uri, value: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(stableStringify(value));
  if (uri.scheme !== 'file') {
    const parent = vscode.Uri.joinPath(uri, '..');
    const temporary = vscode.Uri.joinPath(parent, `.keepseek-goal-${randomUUID()}.tmp`);
    await vscode.workspace.fs.createDirectory(parent);
    try {
      await vscode.workspace.fs.writeFile(temporary, bytes);
      await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
    } finally {
      await Promise.resolve(vscode.workspace.fs.delete(temporary, { useTrash: false })).catch(() => undefined);
    }
    return;
  }
  await mkdir(dirname(uri.fsPath), { recursive: true });
  const temporary = `${uri.fsPath}.keepseek-goal-${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, uri.fsPath);
  try {
    const directory = await open(dirname(uri.fsPath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { /* Some file systems do not allow directory fsync. */ }
}

/** Test helper for checking a file written through the native atomic path. */
export async function readGoalStoreFile(path: string): Promise<string> {
  return readFile(path, 'utf8');
}

async function acquireStoreGuard(path: string) {
  try { return await open(path, 'wx', 0o600); }
  catch (error) {
    if ((error as { code?: string }).code !== 'EEXIST') throw error;
    const first = await stat(path).catch(() => undefined);
    if (!first || Date.now() - first.mtimeMs <= 30_000) throw error;
    const second = await stat(path).catch(() => undefined);
    if (!second || second.ino !== first.ino || second.mtimeMs !== first.mtimeMs) throw error;
    await unlink(path).catch(() => undefined);
    return await open(path, 'wx', 0o600);
  }
}
