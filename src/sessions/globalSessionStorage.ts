import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
  getSessionUpdatedTimestamp,
  createSessionTitle,
  normalizeStoredActiveSessionIds,
  normalizeStoredSessions,
  SESSION_STORAGE_KEY,
  sortSessionsByUpdatedAt,
  type ChatSessionStorageAdapter,
  type StoredSessionState,
  type StoredWorkspaceSessionState,
  type WorkspaceSessionScope
} from './chatSessionStore';
import { isRecord } from '../shared/errors';
import { getHardRetentionCutoff } from './sessionRetention';
import { deleteStorageUri, withStorageCoordinator, writeJsonAtomic } from '../shared/atomicStorage';
import type { StartupPerformanceTrace } from '../shared/startupPerformance';
import type { ApprovalMode, ChatSession, ChatSessionSummary, WorkspaceSummary } from '../shared/types';
import { ToolEvidenceStore } from '../agent/evidence/store';
import { SessionObjectStore } from './sessionObjectStore';
import { normalizeSessionTitle } from './sessionTitle';
import { SessionDeletionAuthority } from './sessionDeletionAuthority';
import { assertManagedStoragePath } from './sessionAssociatedPersistence';
import type { HistoryCleanupCatalogEntry, HistoryCleanupTargetResult } from './sessionHistoryCleanup';

export const SESSION_MIGRATION_KEY = 'keepseek.chatSessionsMigratedToGlobalV1';
export const SESSION_CLEANUP_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SESSION_STORAGE_ROOT_DIR = 'chat-sessions';
const SESSION_STORAGE_VERSION_DIR = 'v2';
const LEGACY_SESSION_STORAGE_VERSION_DIR = 'v1';
const SESSION_STORAGE_MANIFEST_FILE = 'manifest.json';
const SESSION_STORAGE_WORKSPACES_DIR = 'workspaces';
const cleanupFlights = new Map<string, Promise<boolean>>();
const manifestRefreshes = new Map<string, {
  indexes: Map<string, WorkspaceSessionIndex>;
  timer?: ReturnType<typeof setTimeout>;
}>();
const MANIFEST_REFRESH_DEBOUNCE_MS = 100;

export interface GlobalSessionManifest {
  version: 2;
  workspaces: Record<string, GlobalSessionWorkspaceManifestEntry>;
  lastCleanupAt?: string;
}

export interface GlobalSessionWorkspaceManifestEntry {
  workspaceKey: string;
  workspaceName: string;
  workspaceFolders: string[];
  storageFile: string;
  activeSessionId?: string;
  sessionCount: number;
  updatedAt: string;
}

export interface WorkspaceSessionIndex {
  version: 2;
  workspaceKey: string;
  workspaceName: string;
  workspaceFolders: string[];
  activeSessionId: string;
  approvalMode: ApprovalMode;
  approvalModeMigrated?: boolean;
  sessions: SessionIndexEntry[];
  updatedAt: string;
}

export interface SessionIndexEntry extends ChatSessionSummary {
  storageFile: string;
  byteLength?: number;
  /** The atomic workspace index commits an automatic title, after its shard. */
  autoTitleCommit?: string;
}

interface LegacyWorkspaceSessionFile {
  version: 1;
  workspaceKey: string;
  workspaceName: string;
  workspaceFolders: string[];
  activeSessionId: string;
  approvalMode: ApprovalMode;
  approvalModeMigrated?: boolean;
  sessions: ChatSession[];
  updatedAt: string;
}

interface WorkspaceMetadata {
  key: string;
  name: string;
  folderUris: string[];
  activeSessionId?: string;
  updatedAt?: string;
}

/** V2 stores a small project index and one atomic file per conversation. */
export class GlobalSessionStorage implements ChatSessionStorageAdapter {
  private readonly rootUri: vscode.Uri;
  private readonly manifestUri: vscode.Uri;
  private readonly workspacesUri: vscode.Uri;
  private readonly legacyWorkspacesUri: vscode.Uri;
  private readonly evidenceStore: ToolEvidenceStore;
  public readonly deletionAuthority: SessionDeletionAuthority;
  private readonly objectStores = new Map<string, SessionObjectStore>();

  private objects(uri: vscode.Uri): SessionObjectStore {
    const key = uri.toString();
    let store = this.objectStores.get(key);
    if (!store) { store = new SessionObjectStore(uri); this.objectStores.set(key, store); }
    return store;
  }

  public constructor(
    private readonly globalStorageUri: vscode.Uri,
    private readonly startupTrace?: StartupPerformanceTrace
  ) {
    this.deletionAuthority = new SessionDeletionAuthority(globalStorageUri);
    this.rootUri = vscode.Uri.joinPath(globalStorageUri, SESSION_STORAGE_ROOT_DIR, SESSION_STORAGE_VERSION_DIR);
    this.manifestUri = vscode.Uri.joinPath(this.rootUri, SESSION_STORAGE_MANIFEST_FILE);
    this.workspacesUri = vscode.Uri.joinPath(this.rootUri, SESSION_STORAGE_WORKSPACES_DIR);
    this.legacyWorkspacesUri = vscode.Uri.joinPath(
      globalStorageUri,
      SESSION_STORAGE_ROOT_DIR,
      LEGACY_SESSION_STORAGE_VERSION_DIR,
      SESSION_STORAGE_WORKSPACES_DIR
    );
    this.evidenceStore = new ToolEvidenceStore(globalStorageUri);
  }

  public async loadWorkspace(workspaceScope: WorkspaceSessionScope): Promise<StoredWorkspaceSessionState> {
    const hash = getWorkspaceHash(workspaceScope.key);
    let index = await this.readWorkspaceIndex(hash, workspaceScope);
    if (!index) {
      const legacy = await this.readLegacyWorkspaceSessionFile(hash, workspaceScope);
      if (!legacy || legacy.workspaceKey !== workspaceScope.key) {
        return { activeSessionId: '', sessions: [], sessionSummaries: [] };
      }
      try {
        index = await this.migrateLegacyWorkspaceFile(legacy);
      } catch (error) {
        console.warn('KeepSeek: sharded session migration failed; using the intact V1 file.', error);
        return {
          activeSessionId: legacy.activeSessionId,
          approvalMode: legacy.approvalMode,
          sessions: legacy.sessions.map(session => session.id === legacy.activeSessionId && legacy.approvalModeMigrated
            ? { ...session, approvalModeMigrated: true } : session),
          sessionSummaries: legacy.sessions.map(toSessionSummary)
        };
      }
    }

    index = await this.reconcileWorkspaceIndex(index);
    const activeSession = index.activeSessionId
      ? await this.readSession(index.workspaceKey, index.activeSessionId, index)
      : undefined;
    if (activeSession && index.approvalModeMigrated) activeSession.approvalModeMigrated = true;
    return {
      activeSessionId: activeSession?.id ?? '',
      approvalMode: index.approvalMode,
      sessions: activeSession ? [activeSession] : [],
      sessionSummaries: index.sessions.map(toPublicSummary)
    };
  }

  public async saveWorkspace(workspaceScope: WorkspaceSessionScope, state: StoredWorkspaceSessionState): Promise<void> {
    const leases: Array<{ release(): Promise<void> }> = [];
    try {
      if (this.globalStorageUri.scheme === 'file') {
        for (const session of state.sessions) {
          if (session.workspaceKey === workspaceScope.key && !await this.isSessionDeleted(session.workspaceKey, session.id)) {
            leases.push(await this.acquireSessionUse(session.workspaceKey, session.id));
          }
        }
      }
      await withStorageCoordinator(this.rootUri, async () => this.saveWorkspaceCoordinated(workspaceScope, state));
      await this.flush();
    } finally { for (const lease of leases) await lease.release(); }
  }

  public async flush(): Promise<void> {
    const pending = manifestRefreshes.get(this.rootUri.toString());
    if (pending?.timer) { clearTimeout(pending.timer); pending.timer = undefined; }
    const indexes = [...(pending?.indexes.values() ?? [])];
    pending?.indexes.clear();
    // A timer may already have transferred its indexes into the coordinator.
    // Even an empty flush must cross that barrier before shutdown/cleanup.
    await withStorageCoordinator(this.rootUri, async () => {
      if (!indexes.length) return;
      const manifest = await this.readManifestWithoutRebuild();
      indexes.forEach(index => this.setManifestWorkspace(manifest, index));
      await this.writeManifestBestEffort(manifest, 'flush');
    });
  }

  private async saveWorkspaceCoordinated(workspaceScope: WorkspaceSessionScope, state: StoredWorkspaceSessionState): Promise<void> {
    const workspaceHash = getWorkspaceHash(workspaceScope.key);
    const existing = await this.readWorkspaceIndex(workspaceHash, workspaceScope);
    const entries = new Map((existing?.sessions ?? []).map((entry) => [entry.id, entry]));
    for (const summary of state.sessionSummaries ?? []) {
      if (summary.workspaceKey !== workspaceScope.key || await this.isSessionDeleted(summary.workspaceKey, summary.id)) continue;
      const previous = entries.get(summary.id);
      entries.set(summary.id, {
        ...summary,
        storageFile: previous?.storageFile ?? getSessionStorageFile(summary.id),
        byteLength: previous?.byteLength,
        autoTitleCommit: previous?.autoTitleCommit
      });
    }

    const sessions: ChatSession[] = [];
    for (const session of state.sessions) if (session.workspaceKey === workspaceScope.key
      && !await this.isSessionDeleted(session.workspaceKey, session.id)) sessions.push(session);
    await Promise.all(sessions.map(async (session) => {
      const byteLength = await this.objects(this.getSessionUri(workspaceHash, session.id)).save(session, toSessionSummary(session));
      entries.set(session.id, {
        ...toSessionSummary(session),
        storageFile: getSessionStorageFile(session.id),
        byteLength,
        autoTitleCommit: automaticTitleCommit(session)
      });
    }));

    const sortedEntries = sortIndexEntries(Array.from(entries.values()));
    const now = new Date().toISOString();
    const index: WorkspaceSessionIndex = {
      version: 2,
      workspaceKey: workspaceScope.key,
      workspaceName: workspaceScope.name,
      workspaceFolders: workspaceScope.folderUris,
      activeSessionId: chooseActiveSessionIdFromEntries(sortedEntries, state.activeSessionId, existing?.activeSessionId),
      approvalMode: normalizeApprovalMode(state.approvalMode ?? existing?.approvalMode),
      sessions: sortedEntries,
      updatedAt: now
    };
    await this.writeWorkspaceIndex(index, true);
    this.scheduleManifestWorkspace(index);
  }

  public async loadSession(workspaceKey: string, sessionId: string): Promise<ChatSession | undefined> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    const normalizedSessionId = sessionId.trim();
    if (!normalizedWorkspaceKey || !normalizedSessionId) return undefined;
    const index = await this.loadIndexByWorkspaceKey(normalizedWorkspaceKey);
    return index ? await this.readSession(normalizedWorkspaceKey, normalizedSessionId, index) : undefined;
  }

  /** Resolve only a checkpoint referenced by this exact session/message. */
  public async loadMessageCheckpoint(workspaceKey: string, sessionId: string, messageId: string): Promise<unknown> {
    const session = await this.loadSession(workspaceKey, sessionId);
    const message = session?.messages.find(item => item.id === messageId);
    if (message?.runCheckpoint) return message.runCheckpoint;
    if (!message?.runCheckpointArchive) return undefined;
    return this.objects(this.getSessionUri(getWorkspaceHash(workspaceKey), sessionId))
      .loadCheckpoint(message.runCheckpointArchive.objectHash);
  }

  public async listWorkspaceSessionSummaries(workspaceKey: string): Promise<ChatSessionSummary[]> {
    const index = await this.loadIndexByWorkspaceKey(workspaceKey.trim());
    return index ? index.sessions.map(toPublicSummary) : [];
  }

  public async listAllWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
    const manifest = await this.readManifestWithoutRebuild();
    let repaired = false;
    for (const hash of await this.listWorkspaceIndexHashes()) {
      const index = await this.readWorkspaceIndex(hash);
      if (!index) continue;
      const previous = JSON.stringify(manifest.workspaces[hash]);
      this.setManifestWorkspace(manifest, index);
      if (JSON.stringify(manifest.workspaces[hash]) !== previous) repaired = true;
    }
    if (repaired) await this.writeManifestBestEffort(manifest, 'workspace listing repair');
    return Object.values(manifest.workspaces).map((entry) => ({
      workspaceKey: entry.workspaceKey,
      workspaceName: entry.workspaceName,
      workspaceFolders: entry.workspaceFolders,
      sessionCount: entry.sessionCount,
      updatedAt: entry.updatedAt
    })).sort((left, right) => getIsoTimestamp(right.updatedAt) - getIsoTimestamp(left.updatedAt));
  }

  public async loadWorkspaceSessions(workspaceKey: string): Promise<ChatSession[]> {
    const index = await this.loadIndexByWorkspaceKey(workspaceKey.trim());
    if (!index) return [];
    const sessions = await Promise.all(index.sessions.map((entry) => this.readSession(index.workspaceKey, entry.id, index)));
    return sortSessionsByUpdatedAt(sessions.filter((session): session is ChatSession => Boolean(session)));
  }

  public async deleteWorkspaceSessions(workspaceKey: string, sessionIds: string[]): Promise<void> {
    await withStorageCoordinator(this.rootUri, async () => this.deleteWorkspaceSessionsCoordinated(workspaceKey, sessionIds));
  }

  private async deleteWorkspaceSessionsCoordinated(workspaceKey: string, sessionIds: string[]): Promise<void> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    const ids = new Set(sessionIds.map((id) => id.trim()).filter(Boolean));
    if (!normalizedWorkspaceKey || !ids.size) return;
    const index = await this.loadIndexByWorkspaceKey(normalizedWorkspaceKey);
    if (!index) return;
    const removed = index.sessions.filter((entry) => ids.has(entry.id));
    if (!removed.length) return;
    await Promise.all(removed.flatMap((entry) => [
      this.deleteFile(this.getSessionUri(getWorkspaceHash(normalizedWorkspaceKey), entry.id)),
      this.objects(this.getSessionUri(getWorkspaceHash(normalizedWorkspaceKey), entry.id)).deleteObjects(),
      this.evidenceStore.deleteSessionEvidence(entry.id)
    ]));
    index.sessions = index.sessions.filter((entry) => !ids.has(entry.id));
    index.activeSessionId = chooseActiveSessionIdFromEntries(index.sessions, index.activeSessionId);
    index.updatedAt = new Date().toISOString();
    if (!index.sessions.length) {
      await this.deleteEntireWorkspaceCoordinated(normalizedWorkspaceKey);
      return;
    }
    await this.writeWorkspaceIndex(index);
    this.scheduleManifestWorkspace(index);
  }

  public async deleteEntireWorkspace(workspaceKey: string): Promise<void> {
    await withStorageCoordinator(this.rootUri, async () => this.deleteEntireWorkspaceCoordinated(workspaceKey));
  }

  private async deleteEntireWorkspaceCoordinated(workspaceKey: string): Promise<void> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey) return;
    const hash = getWorkspaceHash(normalizedWorkspaceKey);
    this.forgetScheduledManifestWorkspace(hash);
    const index = await this.loadIndexByWorkspaceKey(normalizedWorkspaceKey);
    if (index) await Promise.all(index.sessions.map((entry) => this.evidenceStore.deleteSessionEvidence(entry.id)));
    await this.deleteFile(this.getWorkspaceDirectoryUri(hash), true);
    await this.deleteFile(vscode.Uri.joinPath(this.legacyWorkspacesUri, `${hash}.json`));
    const manifest = await this.readManifest();
    if (manifest.workspaces[hash]) {
      delete manifest.workspaces[hash];
      await this.writeManifestBestEffort(manifest, 'delete workspace');
    }
  }

  public async cleanupExpiredSessions(options: {
    currentWorkspaceKey: string;
    currentActiveSessionId: string;
    protectedSessionIds?: readonly string[];
    now?: number;
    force?: boolean;
  }): Promise<boolean> {
    const key = this.rootUri.toString();
    const existing = cleanupFlights.get(key);
    if (existing) return await existing;
    const flight = withStorageCoordinator(this.rootUri, async () => this.performCleanup(options)).finally(() => {
      if (cleanupFlights.get(key) === flight) cleanupFlights.delete(key);
    });
    cleanupFlights.set(key, flight);
    return await flight;
  }

  private async performCleanup(options: {
    currentWorkspaceKey: string;
    currentActiveSessionId: string;
    protectedSessionIds?: readonly string[];
    now?: number;
    force?: boolean;
  }): Promise<boolean> {
    const now = options.now ?? Date.now();
    const manifest = await this.readManifestWithoutRebuild();
    const previousCleanup = manifest.lastCleanupAt ? Date.parse(manifest.lastCleanupAt) : Number.NaN;
    if (!options.force && Number.isFinite(previousCleanup) && now - previousCleanup < SESSION_CLEANUP_MIN_INTERVAL_MS) {
      this.startupTrace?.mark('session-cleanup-skipped', { skipped: true });
      return false;
    }
    this.startupTrace?.mark('session-cleanup-start');
    const protectedIds = new Set(options.protectedSessionIds ?? []);
    const cutoff = getHardRetentionCutoff(now);
    let changed = false;
    const hashes = new Set([...Object.keys(manifest.workspaces), ...(await this.listWorkspaceIndexHashes())]);
    for (const hash of hashes) {
      let index = await this.readWorkspaceIndex(hash, manifestEntryToMetadata(manifest.workspaces[hash]));
      if (!index) {
        const legacy = await this.readLegacyWorkspaceSessionFile(hash, manifestEntryToMetadata(manifest.workspaces[hash]));
        if (!legacy) continue;
        index = await this.migrateLegacyWorkspaceFile(legacy);
      }
      const removed = index.sessions.filter((entry) => {
        if (entry.isFavorite || protectedIds.has(entry.id)) return false;
        if (entry.workspaceKey === options.currentWorkspaceKey && entry.id === options.currentActiveSessionId) return false;
        const updatedAt = Date.parse(entry.updatedAt);
        return Number.isFinite(updatedAt) && updatedAt < cutoff;
      });
      if (removed.length) {
        changed = true;
        const removedIds = new Set(removed.map((entry) => entry.id));
        await Promise.all(removed.flatMap((entry) => [
          this.deleteFile(this.getSessionUri(hash, entry.id)),
          this.objects(this.getSessionUri(hash, entry.id)).deleteObjects(),
          this.evidenceStore.deleteSessionEvidence(entry.id)
        ]));
        index.sessions = index.sessions.filter((entry) => !removedIds.has(entry.id));
        index.activeSessionId = chooseActiveSessionIdFromEntries(index.sessions, index.activeSessionId);
        index.updatedAt = new Date(now).toISOString();
        if (index.sessions.length) {
          await this.writeWorkspaceIndex(index);
          this.scheduleManifestWorkspace(index);
        } else {
          this.forgetScheduledManifestWorkspace(hash);
          await this.deleteFile(this.getWorkspaceDirectoryUri(hash), true);
        }
      }
      if (index.sessions.length) this.setManifestWorkspace(manifest, index);
      else delete manifest.workspaces[hash];
    }
    manifest.lastCleanupAt = new Date(now).toISOString();
    await this.writeManifestBestEffort(manifest, 'session cleanup');
    this.startupTrace?.mark('session-cleanup-finished', { entries: hashes.size });
    return changed;
  }

  public async migrateLegacyWorkspaceState(
    workspaceState: vscode.Memento,
    currentWorkspaceScope: WorkspaceSessionScope
  ): Promise<boolean> {
    try {
      // A previously migrated Memento may become accessible only when its old
      // workspace reopens. Reclaim only IDs with a committed deletion authority
      // before honoring the migration flag; never import or select new targets.
      const accessible = workspaceState.get<StoredSessionState>(SESSION_STORAGE_KEY);
      if (isRecord(accessible) && Array.isArray(accessible.sessions)) {
        const sessions: unknown[] = [];
        const reclaimed: string[] = [];
        for (const item of accessible.sessions) {
          const id = isRecord(item) && typeof item.id === 'string' ? item.id : undefined;
          const record = id ? await this.deletionAuthority.readRecord(id) : undefined;
          const owner = isRecord(item) && typeof item.workspaceKey === 'string' ? item.workspaceKey : currentWorkspaceScope.key;
          if (record && record.workspaceKey === owner) reclaimed.push(record.sessionId);
          else sessions.push(item);
        }
        if (reclaimed.length) {
          const activeSessionIdsByWorkspace = isRecord(accessible.activeSessionIdsByWorkspace)
            ? Object.fromEntries(Object.entries(accessible.activeSessionIdsByWorkspace).filter(([, id]) => !reclaimed.includes(String(id)))) : undefined;
          await workspaceState.update(SESSION_STORAGE_KEY, { ...accessible, sessions,
            ...(reclaimed.includes(String(accessible.activeSessionId)) ? { activeSessionId: '' } : {}),
            ...(activeSessionIdsByWorkspace ? { activeSessionIdsByWorkspace } : {}) });
          for (const id of reclaimed) {
            const record = await this.deletionAuthority.readRecord(id);
            if (!record) continue;
            const reasons = record.pendingReasons?.filter(reason => reason !== 'inaccessible_legacy_source');
            await this.deletionAuthority.updateDeletion(id, reasons?.length ? 'committed' : record.pendingReasons ? 'reclaimed' : record.phase, reasons);
          }
        }
      }
      if (workspaceState.get<boolean>(SESSION_MIGRATION_KEY, false)) return false;
      const legacyState = workspaceState.get<StoredSessionState>(SESSION_STORAGE_KEY);
      if (!isRecord(legacyState) || !Array.isArray(legacyState.sessions)) {
        await workspaceState.update(SESSION_MIGRATION_KEY, true);
        return false;
      }
      const legacySessions = [];
      for (const session of normalizeStoredSessions(legacyState, currentWorkspaceScope, { confirmedLegacyTitleCompletion: true })) {
        if (!await this.isSessionDeleted(session.workspaceKey, session.id)) legacySessions.push(session);
      }
      const activeSessionIdsByWorkspace = normalizeStoredActiveSessionIds(legacyState, legacySessions);
      for (const [workspaceKey, sessions] of groupSessionsByWorkspace(legacySessions)) {
        const scope = getWorkspaceScopeForSessions(workspaceKey, sessions, currentWorkspaceScope);
        const existing = await this.loadWorkspaceSessions(workspaceKey);
        const merged = mergeSessionsById(existing, sessions);
        await this.saveWorkspace(scope, {
          activeSessionId: chooseActiveSessionId(merged, activeSessionIdsByWorkspace[workspaceKey]),
          sessions: merged,
          sessionSummaries: merged.map(toSessionSummary)
        });
      }
      await workspaceState.update(SESSION_MIGRATION_KEY, true);
      return true;
    } catch (error) {
      console.warn('KeepSeek: failed to migrate legacy chat sessions to global storage.', error);
      return false;
    }
  }

  private async loadIndexByWorkspaceKey(workspaceKey: string): Promise<WorkspaceSessionIndex | undefined> {
    if (!workspaceKey) return undefined;
    const hash = getWorkspaceHash(workspaceKey);
    let index = await this.readWorkspaceIndex(hash);
    if (!index) {
      const manifest = await this.readManifest();
      const legacy = await this.readLegacyWorkspaceSessionFile(hash, manifestEntryToMetadata(manifest.workspaces[hash]));
      if (legacy?.workspaceKey === workspaceKey) index = await this.migrateLegacyWorkspaceFile(legacy);
    }
    return index?.workspaceKey === workspaceKey ? await this.reconcileWorkspaceIndex(index) : undefined;
  }

  private async migrateLegacyWorkspaceFile(file: LegacyWorkspaceSessionFile): Promise<WorkspaceSessionIndex> {
    const workspaceHash = getWorkspaceHash(file.workspaceKey);
    const entries: SessionIndexEntry[] = [];
    for (const session of file.sessions) {
      if (await this.isSessionDeleted(file.workspaceKey, session.id)) continue;
      const value = { version: 2, workspaceKey: file.workspaceKey, session };
      const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (this.globalStorageUri.scheme === 'file') {
        await this.deletionAuthority.withSessionGate(file.workspaceKey, session.id, async () => {
          await this.assertSessionWritable(file.workspaceKey, session.id);
          await writeJsonAtomic(this.getSessionUri(workspaceHash, session.id), value);
        });
      } else await writeJsonAtomic(this.getSessionUri(workspaceHash, session.id), value);
      entries.push({ ...toSessionSummary(session), storageFile: getSessionStorageFile(session.id), byteLength,
        autoTitleCommit: automaticTitleCommit(session) });
    }
    const index: WorkspaceSessionIndex = {
      version: 2,
      workspaceKey: file.workspaceKey,
      workspaceName: file.workspaceName,
      workspaceFolders: file.workspaceFolders,
      activeSessionId: chooseActiveSessionIdFromEntries(entries, file.activeSessionId),
      approvalMode: file.approvalMode,
      approvalModeMigrated: file.approvalModeMigrated,
      sessions: sortIndexEntries(entries),
      updatedAt: file.updatedAt
    };
    // The index is the commit marker. A failed migration leaves V1 authoritative.
    await this.writeWorkspaceIndex(index);
    await this.updateManifestWorkspace(index);
    // The atomic workspace index is the migration commit marker. The global
    // manifest is derived and may be refreshed later without risking shards.
    await this.deleteFile(vscode.Uri.joinPath(this.legacyWorkspacesUri, `${workspaceHash}.json`));
    return index;
  }

  private async reconcileWorkspaceIndex(index: WorkspaceSessionIndex): Promise<WorkspaceSessionIndex> {
    const hash = getWorkspaceHash(index.workspaceKey);
    const known = new Set(index.sessions.map((entry) => entry.storageFile.replace(/^sessions\//u, '')));
    const orphanFiles = (await this.listSessionShardFiles(hash)).filter((file) => !known.has(file));
    if (!orphanFiles.length) return index;
    for (const file of orphanFiles) {
      const session = await this.readSessionShard(vscode.Uri.joinPath(this.getSessionsDirectoryUri(hash), file), index);
      if (session && !index.sessions.some((entry) => entry.id === session.id)) {
        index.sessions.push({ ...toSessionSummary(session), storageFile: `sessions/${file}` });
      }
    }
    index.sessions = sortIndexEntries(index.sessions);
    index.activeSessionId = chooseActiveSessionIdFromEntries(index.sessions, index.activeSessionId);
    await this.writeWorkspaceIndex(index);
    await this.updateManifestWorkspace(index);
    return index;
  }

  private async readSession(workspaceKey: string, sessionId: string, index: WorkspaceSessionIndex): Promise<ChatSession | undefined> {
    if (!index.sessions.some((candidate) => candidate.id === sessionId)) return undefined;
    return await this.readSessionShard(this.getSessionUri(getWorkspaceHash(workspaceKey), sessionId), index);
  }

  private async readSessionShard(uri: vscode.Uri, index: WorkspaceSessionIndex): Promise<ChatSession | undefined> {
    const value = await this.readJsonFile(uri, 'session shard');
    const rawId = isRecord(value) ? (typeof value.sessionId === 'string' ? value.sessionId
      : isRecord(value.session) && typeof value.session.id === 'string' ? value.session.id : undefined) : undefined;
    if (rawId && await this.isSessionDeleted(index.workspaceKey, rawId)) return undefined;
    if (!isRecord(value) || ![2, 3, 4].includes(Number(value.version))) return undefined;
    const stored = Number(value.version) >= 3 ? await this.objects(uri).load(value) : value.session;
    if (!isRecord(stored)) return undefined;
    const scope = { key: index.workspaceKey, name: index.workspaceName, folderUris: index.workspaceFolders };
    // Verify the exact on-disk generation before normalization. A legacy
    // completed record may refer to archived bodies; testing its basis first
    // would erase a genuinely committed stop before the index can attest it.
    let candidate = stored;
    const entry = index.sessions.find(item => item.id === stored.id);
    let confirmedLegacyTitleCompletion = false;
    const state = isRecord(stored.autoTitle) ? stored.autoTitle : undefined;
    if (state && (state.status === 'completed' || state.stopped === 'named')) {
      const confirmed = titleMatchesIndex(stored as unknown as ChatSession, entry);
      confirmedLegacyTitleCompletion = confirmed && state.version === 1;
      if (!confirmed) {
        const previous = isRecord(state.regenerationPrevious) ? state.regenerationPrevious : undefined;
        const prior = previous && isRecord(previous.metadata) && typeof previous.title === 'string'
          ? { ...stored, title: previous.title, customTitle: previous.customTitle, autoTitle: previous.metadata } : undefined;
        const priorHash = prior ? automaticTitleCommit(prior as unknown as ChatSession) : undefined;
        const confirmedPrevious = !!prior && !!entry && (typeof previous?.customTitle === 'string'
          ? entry.customTitle === previous.customTitle && entry.title === previous.title
          : priorHash ? titleMatchesIndex(prior as unknown as ChatSession, entry) : !entry.autoTitleCommit && entry.title === previous?.title);
        if (confirmedPrevious) {
          candidate = prior!;
          confirmedLegacyTitleCompletion = isRecord(candidate.autoTitle) && candidate.autoTitle.version === 1;
        } else {
          const taskId = typeof state.lastAttemptTaskId === 'string' ? state.lastAttemptTaskId
            : isRecord(state.completed) && typeof state.completed.taskId === 'string' ? state.completed.taskId : undefined;
          candidate = { ...stored, autoTitle: { version: 2, status: 'pending',
            revision: typeof state.revision === 'number' ? state.revision + 1 : 1,
            stopped: entry?.customTitle ? 'manual' : undefined, lastAttemptTaskId: taskId,
            lastOutcome: entry?.customTitle ? 'manual' : 'save_failed' },
          customTitle: entry?.customTitle, title: entry?.customTitle ?? entry?.title
            ?? createSessionTitle(Array.isArray(stored.messages)
              ? (stored.messages.find(item => isRecord(item) && item.role === 'user'
                && typeof item.content === 'string') as { content?: string } | undefined)?.content ?? '' : '') };
        }
      }
    }
    const session = normalizeStoredSessions({ sessions: [candidate] }, scope, { confirmedLegacyTitleCompletion })[0];
    return session?.workspaceKey === index.workspaceKey && !await this.isSessionDeleted(index.workspaceKey, session.id) ? session : undefined;
  }

  private async readWorkspaceIndex(hash: string, fallback?: WorkspaceMetadata | WorkspaceSessionScope): Promise<WorkspaceSessionIndex | undefined> {
    const index = normalizeWorkspaceIndex(await this.readJsonFile(this.getWorkspaceIndexUri(hash), 'workspace session index'), fallback);
    if (!index || getWorkspaceHash(index.workspaceKey) !== hash) return undefined;
    index.sessions = await this.filterDeleted(index.workspaceKey, index.sessions);
    index.activeSessionId = chooseActiveSessionIdFromEntries(index.sessions, index.activeSessionId);
    return index;
  }

  private async writeWorkspaceIndex(index: WorkspaceSessionIndex, mergeConcurrent = false): Promise<void> {
    const write = async () => {
      if (mergeConcurrent) {
        const current = await this.readWorkspaceIndex(getWorkspaceHash(index.workspaceKey));
        const entries = new Map((current?.sessions ?? []).map(entry => [entry.id, entry]));
        for (const entry of index.sessions) {
          const old = entries.get(entry.id);
          if (!old || getIsoTimestamp(entry.updatedAt) >= getIsoTimestamp(old.updatedAt)) entries.set(entry.id, entry);
        }
        index.sessions = sortIndexEntries([...entries.values()]);
      }
      index.sessions = await this.filterDeleted(index.workspaceKey, index.sessions);
      index.activeSessionId = chooseActiveSessionIdFromEntries(index.sessions, index.activeSessionId);
      await writeJsonAtomic(this.getWorkspaceIndexUri(getWorkspaceHash(index.workspaceKey)), index);
    };
    if (this.globalStorageUri.scheme === 'file') await this.deletionAuthority.withIndexGate(index.workspaceKey, write);
    else await write();
  }

  private async readLegacyWorkspaceSessionFile(hash: string, fallback?: WorkspaceMetadata | WorkspaceSessionScope): Promise<LegacyWorkspaceSessionFile | undefined> {
    const value = await this.readJsonFile(vscode.Uri.joinPath(this.legacyWorkspacesUri, `${hash}.json`), 'legacy workspace session file');
    const legacy = normalizeLegacyWorkspaceSessionFile(value, fallback);
    if (!legacy) return undefined;
    legacy.sessions = await this.filterDeleted(legacy.workspaceKey, legacy.sessions);
    legacy.activeSessionId = chooseActiveSessionId(legacy.sessions, legacy.activeSessionId);
    return legacy;
  }

  private async readManifest(): Promise<GlobalSessionManifest> {
    return normalizeManifest(await this.readJsonFile(this.manifestUri, 'session manifest')) ?? await this.rebuildManifest();
  }

  private async writeManifest(manifest: GlobalSessionManifest): Promise<void> {
    const write = async () => {
      // Re-read actual indexes instead of replaying a delayed stale snapshot.
      for (const [hash, entry] of Object.entries(manifest.workspaces)) {
        const index = await this.readWorkspaceIndex(hash);
        if (index) this.setManifestWorkspace(manifest, index);
        else if (await this.hasDeletedWorkspace(entry.workspaceKey)) delete manifest.workspaces[hash];
      }
      await writeJsonAtomic(this.manifestUri, manifest);
    };
    if (this.globalStorageUri.scheme === 'file') await this.deletionAuthority.withManifestGate(write);
    else await write();
  }

  private async updateManifestWorkspace(index: WorkspaceSessionIndex): Promise<void> {
    this.scheduleManifestWorkspace(index);
  }

  private scheduleManifestWorkspace(index: WorkspaceSessionIndex): void {
    const key = this.rootUri.toString();
    const pending = manifestRefreshes.get(key) ?? { indexes: new Map<string, WorkspaceSessionIndex>() };
    pending.indexes.set(getWorkspaceHash(index.workspaceKey), structuredClone(index));
    if (!pending.timer) {
      pending.timer = setTimeout(() => {
        pending.timer = undefined;
        const indexes = [...pending.indexes.values()];
        pending.indexes.clear();
        void withStorageCoordinator(this.rootUri, async () => {
          const manifest = await this.readManifestWithoutRebuild();
          indexes.forEach((next) => this.setManifestWorkspace(manifest, next));
          await this.writeManifest(manifest);
        }).catch((error) => {
          console.warn('KeepSeek: derived session manifest refresh failed; it will be rebuilt later.', error);
          indexes.forEach((next) => {
            const hash = getWorkspaceHash(next.workspaceKey);
            if (!pending.indexes.has(hash)) pending.indexes.set(hash, next);
          });
          if (!pending.timer) {
            pending.timer = setTimeout(() => {
              pending.timer = undefined;
              const retryIndexes = [...pending.indexes.values()];
              pending.indexes.clear();
              void withStorageCoordinator(this.rootUri, async () => {
                const manifest = await this.readManifestWithoutRebuild();
                retryIndexes.forEach((next) => this.setManifestWorkspace(manifest, next));
                await this.writeManifest(manifest);
              }).catch((retryError) => console.warn(
                'KeepSeek: derived session manifest retry failed; startup rebuild remains available.', retryError));
            }, MANIFEST_REFRESH_DEBOUNCE_MS * 10);
            pending.timer.unref?.();
          }
        });
      }, MANIFEST_REFRESH_DEBOUNCE_MS);
      pending.timer.unref?.();
    }
    manifestRefreshes.set(key, pending);
  }

  private forgetScheduledManifestWorkspace(workspaceHash: string): void {
    manifestRefreshes.get(this.rootUri.toString())?.indexes.delete(workspaceHash);
  }

  private async writeManifestBestEffort(manifest: GlobalSessionManifest, operation: string): Promise<void> {
    try {
      await this.writeManifest(manifest);
    } catch (error) {
      console.warn(`KeepSeek: derived session manifest update failed during ${operation}; continuing.`, error);
    }
  }

  private async readManifestWithoutRebuild(): Promise<GlobalSessionManifest> {
    return normalizeManifest(await this.readJsonFile(this.manifestUri, 'session manifest'))
      ?? { version: 2, workspaces: {} };
  }

  private setManifestWorkspace(manifest: GlobalSessionManifest, index: WorkspaceSessionIndex): void {
    const hash = getWorkspaceHash(index.workspaceKey);
    manifest.workspaces[hash] = {
      workspaceKey: index.workspaceKey,
      workspaceName: index.workspaceName,
      workspaceFolders: index.workspaceFolders,
      storageFile: `${SESSION_STORAGE_WORKSPACES_DIR}/${hash}/index.json`,
      activeSessionId: index.activeSessionId || undefined,
      sessionCount: index.sessions.length,
      updatedAt: index.updatedAt
    };
  }

  private async rebuildManifest(): Promise<GlobalSessionManifest> {
    const manifest: GlobalSessionManifest = { version: 2, workspaces: {} };
    for (const hash of await this.listWorkspaceIndexHashes()) {
      const index = await this.readWorkspaceIndex(hash);
      if (index) this.setManifestWorkspace(manifest, index);
    }
    return manifest;
  }


  public async isSessionDeleted(workspaceKey: string, sessionId: string): Promise<boolean> {
    return this.deletionAuthority.isDeleted(workspaceKey, sessionId);
  }
  public async assertSessionWritable(workspaceKey: string, sessionId: string): Promise<void> {
    await this.deletionAuthority.assertWritable(workspaceKey, sessionId);
  }
  public async acquireSessionUse(workspaceKey: string, sessionId: string): Promise<{ release(): Promise<void> }> {
    return this.deletionAuthority.acquireUse(workspaceKey, sessionId);
  }
  private async filterDeleted<T extends { id: string }>(workspaceKey: string, items: T[]): Promise<T[]> {
    const result: T[] = [];
    for (const item of items) if (!await this.isSessionDeleted(workspaceKey, item.id)) result.push(item);
    return result;
  }
  private async hasDeletedWorkspace(workspaceKey: string): Promise<boolean> {
    return (await this.deletionAuthority.listPending()).some(record => record.workspaceKey === workspaceKey);
  }

  /** Raw indexes only: no normalization-generated timestamps, migrations,
   * manifests, object graphs or checkpoints are written/read by preview. */
  public async readHistoryCleanupCatalog(workspaceKey?: string): Promise<{ entries: HistoryCleanupCatalogEntry[]; unknown: number }> {
    const entries: HistoryCleanupCatalogEntry[] = [];
    let unknown = 0;
    const hashes = workspaceKey ? [getWorkspaceHash(workspaceKey)] : await this.listCleanupWorkspaceHashes();
    for (const workspaceHash of hashes) {
      let raw: unknown;
      try { raw = await this.readCleanupJson(this.getWorkspaceIndexUri(workspaceHash), 'cleanup summary index'); }
      catch (error) { if (error instanceof SyntaxError) { unknown++; continue; } throw error; }
      if (!raw) {
        // An absent current project with no persisted history is an empty scope.
        const files = await this.listCleanupShardFiles(workspaceHash);
        if (files.length) unknown += files.length;
        continue;
      }
      if (!isRecord(raw) || raw.version !== 2 || typeof raw.workspaceKey !== 'string'
        || getWorkspaceHash(raw.workspaceKey) !== workspaceHash || !Array.isArray(raw.sessions)) { unknown++; continue; }
      if (workspaceKey && raw.workspaceKey !== workspaceKey) { unknown++; continue; }
      for (const item of raw.sessions) {
        const candidate = this.cleanupEntry(raw.workspaceKey, item);
        if (!candidate) { unknown++; continue; }
        if (await this.isSessionDeleted(candidate.workspaceKey, candidate.id)) continue;
        try {
          if (await this.deletionAuthority.inspectUse(candidate.workspaceKey, candidate.id)) candidate.protectedReason = 'session_in_use';
        } catch { candidate.protectedReason = 'storage_ownership_unavailable'; }
        entries.push(candidate);
      }
      const knownFiles = new Set(raw.sessions.filter(isRecord).map(item => typeof item.id === 'string' ? `${getSessionHash(item.id)}.json` : ''));
      unknown += (await this.listCleanupShardFiles(workspaceHash)).filter(file => !knownFiles.has(file)).length;
    }
    // Legacy-only projects cannot be safely expanded for a summary preview.
    try {
      await assertManagedStoragePath(this.globalStorageUri, this.legacyWorkspacesUri);
      for (const [name, type] of await vscode.workspace.fs.readDirectory(this.legacyWorkspacesUri)) {
        if (type !== vscode.FileType.File || !/^[a-f0-9]{32}\.json$/u.test(name)) continue;
        const legacyHash = name.slice(0, -5);
        if (workspaceKey && legacyHash !== getWorkspaceHash(workspaceKey)) continue;
        unknown++;
      }
    } catch (error) { if (!isFileNotFoundError(error)) throw error; }
    const ownership = new Map<string, string>();
    const collisions = new Set<string>();
    for (const hash of await this.listCleanupWorkspaceHashes()) {
      const raw = await this.readCleanupJson(this.getWorkspaceIndexUri(hash), 'cleanup ownership summary');
      if (!isRecord(raw) || typeof raw.workspaceKey !== 'string' || getWorkspaceHash(raw.workspaceKey) !== hash || !Array.isArray(raw.sessions)) continue;
      for (const item of raw.sessions) {
        if (!isRecord(item) || typeof item.id !== 'string') continue;
        const owner = ownership.get(item.id);
        if (owner && owner !== raw.workspaceKey) collisions.add(item.id);
        else ownership.set(item.id, raw.workspaceKey);
      }
    }
    for (const entry of entries) if (collisions.has(entry.id)) entry.unknownReason = 'duplicate_session_identity';
    return { entries, unknown };
  }
  private async hasOtherSessionOwner(workspaceKey: string, sessionId: string): Promise<boolean> {
    for (const hash of await this.listCleanupWorkspaceHashes()) {
      if (hash === getWorkspaceHash(workspaceKey)) continue;
      const raw = await this.readCleanupJson(this.getWorkspaceIndexUri(hash), 'cleanup target ownership');
      if (!isRecord(raw) || typeof raw.workspaceKey !== 'string' || !Array.isArray(raw.sessions)) continue;
      if (raw.sessions.some(item => isRecord(item) && item.id === sessionId)) return true;
    }
    return false;
  }
  private cleanupEntry(workspaceKey: string, raw: unknown): HistoryCleanupCatalogEntry | undefined {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 4096
      || (raw.workspaceKey !== undefined && raw.workspaceKey !== workspaceKey)
      || (raw.storageFile !== undefined && raw.storageFile !== getSessionStorageFile(raw.id))) return undefined;
    const count = raw.messageCount;
    return { workspaceKey, id: raw.id, updatedAt: raw.updatedAt, createdAt: raw.createdAt,
      isFavorite: raw.isFavorite === true, updatedAtTrusted: raw.updatedAt !== new Date(0).toISOString(),
      createdAtTrusted: raw.createdAt !== new Date(0).toISOString(), hasHistory: typeof count !== 'number' || count > 0,
      version: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
      ...(typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 ? { unknownReason: 'invalid_history_summary' } : {}) };
  }
  public async revalidateHistoryCleanupTarget(target: HistoryCleanupCatalogEntry): Promise<boolean> {
    const raw = await this.readCleanupJson(this.getWorkspaceIndexUri(getWorkspaceHash(target.workspaceKey)), 'cleanup target index');
    if (!isRecord(raw) || raw.version !== 2 || raw.workspaceKey !== target.workspaceKey || !Array.isArray(raw.sessions)) return false;
    const actual = this.cleanupEntry(target.workspaceKey, raw.sessions.find(item => isRecord(item) && item.id === target.id));
    return actual?.version === target.version && !await this.hasOtherSessionOwner(target.workspaceKey, target.id)
      && !await this.isSessionDeleted(target.workspaceKey, target.id)
      && !await this.deletionAuthority.inspectUse(target.workspaceKey, target.id);
  }
  public async recoverHistoryCleanupTarget(target: HistoryCleanupCatalogEntry, operationId: string): Promise<HistoryCleanupTargetResult | undefined> {
    const record = await this.deletionAuthority.readRecord(target.id);
    if (!record || record.workspaceKey !== target.workspaceKey || record.operationId !== operationId) return undefined;
    return this.deleteHistoryCleanupTarget(target, operationId);
  }
  public async deleteHistoryCleanupTarget(target: HistoryCleanupCatalogEntry, operationId: string): Promise<HistoryCleanupTargetResult> {
    if (this.globalStorageUri.scheme !== 'file') return { status: 'unavailable', reason: 'storage_ownership_unavailable' };
    let committed = false;
    try {
      const result = await this.deletionAuthority.withSessionGate(target.workspaceKey, target.id, async (): Promise<HistoryCleanupTargetResult | undefined> => {
        const existing = await this.deletionAuthority.readRecord(target.id);
        if (existing) {
          if (existing.workspaceKey !== target.workspaceKey || existing.operationId !== operationId) return { status: 'unavailable', reason: 'deletion_intent_scope_conflict' };
          committed = true;
        }
        if (!committed && await this.deletionAuthority.inspectUse(target.workspaceKey, target.id)) return { status: 'protected', reason: 'session_in_use' };
        if (!committed && !await this.revalidateHistoryCleanupTarget(target)) return { status: 'skippedChanged', reason: 'history_changed' };
        const shard = this.getSessionUri(getWorkspaceHash(target.workspaceKey), target.id);
        await assertManagedStoragePath(this.globalStorageUri, shard);
        if (!committed) {
          const shardType = (await vscode.workspace.fs.stat(shard)).type;
          if ((shardType & vscode.FileType.SymbolicLink) !== 0 || shardType !== vscode.FileType.File) return { status: 'unknown', reason: 'unsafe_session_shard' };
          const manifest = await this.readCleanupJson(shard, 'cleanup target identity');
          if (!isRecord(manifest)) return { status: 'unknown', reason: 'unreadable_session_identity' };
          const identity = Number(manifest.version) === 2 && isRecord(manifest.session) ? manifest.session : manifest;
          const id = Number(manifest.version) === 2 ? identity.id : identity.sessionId;
          if (id !== target.id || identity.workspaceKey !== target.workspaceKey) return { status: 'unknown', reason: 'session_identity_mismatch' };
          if (Number(manifest.version) >= 3) {
            // Read only header fields, never messages/checkpoints, for final
            // admission against a shard committed before its index update.
            const updatedAt = await this.objects(shard).loadField(manifest, ['updatedAt']);
            if (updatedAt !== target.updatedAt) return { status: 'skippedChanged', reason: 'session_shard_changed' };
          } else if (identity.updatedAt !== target.updatedAt) return { status: 'skippedChanged', reason: 'session_shard_changed' };
        }
        const objectsUri = vscode.Uri.joinPath(shard, '..', `${shard.path.split('/').at(-1)}.objects`);
        await assertManagedStoragePath(this.globalStorageUri, objectsUri);
        try {
          const type = (await vscode.workspace.fs.stat(objectsUri)).type;
          if ((type & vscode.FileType.SymbolicLink) !== 0 || type !== vscode.FileType.Directory) return { status: committed ? 'removedPendingCleanup' : 'unknown', reason: 'unsafe_session_objects' };
        } catch (error) { if (!isFileNotFoundError(error)) throw error; }
        // Legacy writer locks live inside the object directory. Unknown/old
        // writers cannot be proved idle by absence of a new-version use record.
        const lock = vscode.Uri.joinPath(shard, '..', `${shard.path.split('/').at(-1)}.objects`, 'writer.lock');
        try { await vscode.workspace.fs.stat(lock); return { status: committed ? 'removedPendingCleanup' : 'unavailable', reason: 'legacy_writer_lock' }; }
        catch (error) { if (!isFileNotFoundError(error)) throw error; }
        if (!committed) await this.deletionAuthority.commitDeletion({ version: 1, workspaceKey: target.workspaceKey, sessionId: target.id,
          operationId, confirmedAt: new Date().toISOString(), phase: 'committed' });
        committed = true;
        // Every canonical main writer shares this same session gate.
        await this.deleteFile(shard);
        await this.objects(shard).deleteObjects();
        this.objectStores.delete(shard.toString());
        return undefined;
      });
      if (result) return result;
      await this.deletionAuthority.withIndexGate(target.workspaceKey, async () => {
        const uri = this.getWorkspaceIndexUri(getWorkspaceHash(target.workspaceKey));
        const raw = await this.readCleanupJson(uri, 'cleanup index');
        if (raw !== undefined && (!isRecord(raw) || raw.workspaceKey !== target.workspaceKey || !Array.isArray(raw.sessions))) throw new Error('Cleanup source identity cannot be verified');
        if (isRecord(raw) && raw.workspaceKey === target.workspaceKey && Array.isArray(raw.sessions)) {
          raw.sessions = raw.sessions.filter(item => !isRecord(item) || item.id !== target.id);
          if (raw.activeSessionId === target.id) raw.activeSessionId = '';
          await writeJsonAtomic(uri, raw, { durable: true });
        }
      });
      const legacyUri = vscode.Uri.joinPath(this.legacyWorkspacesUri, `${getWorkspaceHash(target.workspaceKey)}.json`);
      // Accessible V1 records are removed in a scoped read-modify-write gate.
      await this.deletionAuthority.withIndexGate(target.workspaceKey, async () => {
        const raw = await this.readCleanupJson(legacyUri, 'cleanup legacy source');
        if (raw !== undefined && (!isRecord(raw) || raw.workspaceKey !== target.workspaceKey || !Array.isArray(raw.sessions))) throw new Error('Cleanup source identity cannot be verified');
        if (isRecord(raw) && raw.workspaceKey === target.workspaceKey && Array.isArray(raw.sessions)) {
          raw.sessions = raw.sessions.filter(item => !isRecord(item) || item.id !== target.id);
          if (raw.activeSessionId === target.id) raw.activeSessionId = '';
          await writeJsonAtomic(legacyUri, raw, { durable: true });
        }
      });
      const refreshed = await this.readWorkspaceIndex(getWorkspaceHash(target.workspaceKey));
      if (refreshed) this.scheduleManifestWorkspace(refreshed);
      await this.flush();
      return { status: 'removedPendingCleanup', reason: 'associated_cleanup_required', inaccessibleLegacySource: true };
    } catch (error) {
      const code = isRecord(error) && typeof error.code === 'string' && /^[A-Za-z_]+$/u.test(error.code) ? error.code : 'unavailable';
      return { status: committed ? 'removedPendingCleanup' : 'failedBeforeCommit', reason: `session_storage:${code}` };
    }
  }

  private async readCleanupJson(uri: vscode.Uri, _description: string): Promise<unknown | undefined> {
    try {
      await assertManagedStoragePath(this.globalStorageUri, uri);
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(uri))) as unknown;
    }
    catch (error) { if (isFileNotFoundError(error)) return undefined; throw error; }
  }
  private async listCleanupWorkspaceHashes(): Promise<string[]> {
    try {
      await assertManagedStoragePath(this.globalStorageUri, this.workspacesUri);
      return (await vscode.workspace.fs.readDirectory(this.workspacesUri))
        .filter(([name, type]) => type === vscode.FileType.Directory && /^[a-f0-9]{32}$/u.test(name)).map(([name]) => name);
    } catch (error) { if (isFileNotFoundError(error)) return []; throw error; }
  }
  private async listCleanupShardFiles(hash: string): Promise<string[]> {
    try {
      await assertManagedStoragePath(this.globalStorageUri, this.getSessionsDirectoryUri(hash));
      return (await vscode.workspace.fs.readDirectory(this.getSessionsDirectoryUri(hash)))
        .filter(([name, type]) => type === vscode.FileType.File && /^[a-f0-9]{32}\.json$/u.test(name)).map(([name]) => name);
    } catch (error) { if (isFileNotFoundError(error)) return []; throw error; }
  }

  private async readJsonFile(uri: vscode.Uri, description: string): Promise<unknown | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.startupTrace?.mark('storage-read', { bytesRead: bytes.byteLength, entries: 1 });
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (!isFileNotFoundError(error)) console.warn(`KeepSeek: failed to read ${description}; ignoring it.`, error);
      return undefined;
    }
  }

  private async listWorkspaceIndexHashes(): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.workspacesUri);
      return entries.filter(([name, type]) => type === vscode.FileType.Directory && /^[a-f0-9]{32}$/u.test(name)).map(([name]) => name);
    } catch (error) {
      if (!isFileNotFoundError(error)) console.warn('KeepSeek: failed to enumerate session indexes.', error);
      return [];
    }
  }

  private async listSessionShardFiles(workspaceHash: string): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.getSessionsDirectoryUri(workspaceHash));
      return entries.filter(([name, type]) => type === vscode.FileType.File && /^[a-f0-9]{32}\.json$/u.test(name)).map(([name]) => name);
    } catch (error) {
      if (!isFileNotFoundError(error)) console.warn('KeepSeek: failed to enumerate session shards.', error);
      return [];
    }
  }

  private async deleteFile(uri: vscode.Uri, recursive = false): Promise<void> {
    await deleteStorageUri(uri, { recursive });
  }

  private getWorkspaceDirectoryUri(hash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.workspacesUri, hash);
  }

  private getWorkspaceIndexUri(hash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getWorkspaceDirectoryUri(hash), 'index.json');
  }

  private getSessionsDirectoryUri(hash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getWorkspaceDirectoryUri(hash), 'sessions');
  }

  private getSessionUri(workspaceHash: string, sessionId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getSessionsDirectoryUri(workspaceHash), `${getSessionHash(sessionId)}.json`);
  }
}

export function getWorkspaceHash(workspaceKey: string): string {
  return createHash('sha256').update(workspaceKey).digest('hex').slice(0, 32);
}

function getSessionHash(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex').slice(0, 32);
}

function getSessionStorageFile(sessionId: string): string {
  return `sessions/${getSessionHash(sessionId)}.json`;
}

function toSessionSummary(session: ChatSession): ChatSessionSummary {
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    workspaceKey: session.workspaceKey,
    workspaceName: session.workspaceName,
    isFavorite: Boolean(session.isFavorite),
    customTitle: session.customTitle
  };
}

function toPublicSummary(entry: SessionIndexEntry): ChatSessionSummary {
  return {
    id: entry.id,
    title: entry.title,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    messageCount: entry.messageCount,
    workspaceKey: entry.workspaceKey,
    workspaceName: entry.workspaceName,
    isFavorite: entry.isFavorite,
    customTitle: entry.customTitle
  };
}

function normalizeManifest(value: unknown): GlobalSessionManifest | undefined {
  if (!isRecord(value) || value.version !== 2 || !isRecord(value.workspaces)) return undefined;
  const workspaces: Record<string, GlobalSessionWorkspaceManifestEntry> = {};
  for (const [hash, raw] of Object.entries(value.workspaces)) {
    if (!/^[a-f0-9]{32}$/u.test(hash) || !isRecord(raw)) continue;
    const workspaceKey = nonEmptyString(raw.workspaceKey);
    if (!workspaceKey) continue;
    workspaces[hash] = {
      workspaceKey,
      workspaceName: nonEmptyString(raw.workspaceName) ?? workspaceKey,
      workspaceFolders: stringArray(raw.workspaceFolders),
      storageFile: nonEmptyString(raw.storageFile) ?? `${SESSION_STORAGE_WORKSPACES_DIR}/${hash}/index.json`,
      activeSessionId: nonEmptyString(raw.activeSessionId),
      sessionCount: nonNegativeInteger(raw.sessionCount),
      updatedAt: isoString(raw.updatedAt, new Date(0).toISOString())
    };
  }
  return { version: 2, workspaces, lastCleanupAt: nonEmptyString(value.lastCleanupAt) };
}

function normalizeWorkspaceIndex(value: unknown, fallback?: WorkspaceMetadata | WorkspaceSessionScope): WorkspaceSessionIndex | undefined {
  if (!isRecord(value) || value.version !== 2 || !Array.isArray(value.sessions)) return undefined;
  const workspaceKey = nonEmptyString(value.workspaceKey) ?? fallback?.key;
  if (!workspaceKey) return undefined;
  const workspaceName = nonEmptyString(value.workspaceName) ?? fallback?.name ?? workspaceKey;
  const workspaceFolders = Array.isArray(value.workspaceFolders) ? stringArray(value.workspaceFolders) : fallback?.folderUris ?? [];
  const sessions = value.sessions.map((entry) => normalizeSessionIndexEntry(entry, workspaceKey, workspaceName)).filter((entry): entry is SessionIndexEntry => Boolean(entry));
  const fallbackActiveId = fallback && 'activeSessionId' in fallback ? fallback.activeSessionId : undefined;
  return {
    version: 2,
    workspaceKey,
    workspaceName,
    workspaceFolders,
    activeSessionId: chooseActiveSessionIdFromEntries(sessions, nonEmptyString(value.activeSessionId), fallbackActiveId),
    approvalMode: normalizeApprovalMode(value.approvalMode),
    approvalModeMigrated: value.approvalMode === 'model_review' || value.approvalModeMigrated === true || undefined,
    sessions: sortIndexEntries(sessions),
    updatedAt: isoString(value.updatedAt, sessions[0]?.updatedAt ?? new Date(0).toISOString())
  };
}

function normalizeSessionIndexEntry(value: unknown, workspaceKey: string, workspaceName: string): SessionIndexEntry | undefined {
  if (!isRecord(value)) return undefined;
  const id = nonEmptyString(value.id);
  if (!id) return undefined;
  const createdAt = isoString(value.createdAt, new Date(0).toISOString());
  return {
    id,
    title: nonEmptyString(value.title) ?? 'New Chat',
    createdAt,
    updatedAt: isoString(value.updatedAt, createdAt),
    messageCount: nonNegativeInteger(value.messageCount),
    workspaceKey,
    workspaceName: nonEmptyString(value.workspaceName) ?? workspaceName,
    isFavorite: value.isFavorite === true,
    customTitle: nonEmptyString(value.customTitle),
    autoTitleCommit: typeof value.autoTitleCommit === 'string' && /^[a-f0-9]{64}$/u.test(value.autoTitleCommit)
      ? value.autoTitleCommit : undefined,
    storageFile: nonEmptyString(value.storageFile) ?? getSessionStorageFile(id),
    byteLength: typeof value.byteLength === 'number' && value.byteLength >= 0 ? Math.floor(value.byteLength) : undefined
  };
}

/** The first generic v2 write can reach the shard and then fail before the
 * old index is replaced. Accept its v1 proof only for the same committed
 * title, revision and exact legacy provenance. New requests always use scoped bases. */
function titleMatchesIndex(session: ChatSession, entry?: SessionIndexEntry): boolean {
  if (!entry?.autoTitleCommit || entry.title !== session.title || entry.customTitle) return false;
  if (automaticTitleCommit(session) === entry.autoTitleCommit) return true;
  const state = session.autoTitle;
  return state?.version === 2 && state.stopped === 'named' && state.status === 'completed'
    && !!state.completed && !state.completed.basis?.scope
    && automaticTitleCommit({ ...session, autoTitle: { ...state, version: 1 } }) === entry.autoTitleCommit;
}

/** The format is selected from the stored metadata version. Never hash a
 * migrated v2 object when verifying an old v1 index marker. */
export function automaticTitleCommit(session: ChatSession): string | undefined {
  if (session.customTitle || !session.autoTitle || typeof session.id !== 'string' || typeof session.title !== 'string') return undefined;
  const raw = session.autoTitle;
  const state = normalizeSessionTitle(raw, undefined, { preserveRunning: true });
  if (raw.version === 1) {
    if (raw.status !== 'completed' || !state.completed) return undefined;
    return createHash('sha256').update(JSON.stringify([
      session.id, session.title, state.revision, state.completed.taskId,
      state.completed.basis.messages.map(ref => [ref.id, ref.hash]), state.completed.basis.lastMessageId,
      ...(state.completed.basis.conversation ? [state.completed.basis.conversation] : [])
    ]), 'utf8').digest('hex');
  }
  if (raw.version !== 2 || raw.stopped !== 'named' || raw.status !== 'completed'
    || state.stopped !== 'named' || state.status !== 'completed') return undefined;
  return createHash('sha256').update(JSON.stringify([
    'session_title_v2', session.id, session.title, state.revision, state.stopped,
    state.completed ? [state.completed.taskId, state.completed.basis] : null
  ]), 'utf8').digest('hex');
}

function normalizeLegacyWorkspaceSessionFile(value: unknown, fallback?: WorkspaceMetadata | WorkspaceSessionScope): LegacyWorkspaceSessionFile | undefined {
  if (!isRecord(value)) return undefined;
  const workspaceKey = nonEmptyString(value.workspaceKey) ?? fallback?.key;
  if (!workspaceKey) return undefined;
  const workspaceName = nonEmptyString(value.workspaceName) ?? fallback?.name ?? workspaceKey;
  const workspaceFolders = Array.isArray(value.workspaceFolders) ? stringArray(value.workspaceFolders) : fallback?.folderUris ?? [];
  const scope = { key: workspaceKey, name: workspaceName, folderUris: workspaceFolders };
  const sessions = normalizeStoredSessions(value, scope, { confirmedLegacyTitleCompletion: true }).filter((session) => session.workspaceKey === workspaceKey);
  const fallbackActiveId = fallback && 'activeSessionId' in fallback ? fallback.activeSessionId : undefined;
  const activeSessionId = chooseActiveSessionId(sessions, nonEmptyString(value.activeSessionId), fallbackActiveId);
  return {
    version: 1,
    workspaceKey,
    workspaceName,
    workspaceFolders,
    activeSessionId,
    approvalModeMigrated: value.approvalMode === 'model_review' || value.approvalModeMigrated === true || undefined,
    approvalMode: normalizeApprovalMode(value.approvalMode ?? sessions.find((session) => session.id === activeSessionId)?.approvalMode),
    sessions: sortSessionsByUpdatedAt(sessions),
    updatedAt: isoString(value.updatedAt, sessions[0]?.updatedAt ?? new Date(0).toISOString())
  };
}

function sortIndexEntries(entries: SessionIndexEntry[]): SessionIndexEntry[] {
  return [...entries].sort((left, right) => getIsoTimestamp(right.updatedAt) - getIsoTimestamp(left.updatedAt));
}

function chooseActiveSessionIdFromEntries(entries: readonly SessionIndexEntry[], ...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) if (candidate && entries.some((entry) => entry.id === candidate)) return candidate;
  return entries[0]?.id ?? '';
}

function chooseActiveSessionId(sessions: readonly ChatSession[], ...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) if (candidate && sessions.some((session) => session.id === candidate)) return candidate;
  return sessions[0]?.id ?? '';
}

function groupSessionsByWorkspace(sessions: readonly ChatSession[]): Map<string, ChatSession[]> {
  const groups = new Map<string, ChatSession[]>();
  for (const session of sessions) groups.set(session.workspaceKey, [...(groups.get(session.workspaceKey) ?? []), session]);
  return groups;
}

function getWorkspaceScopeForSessions(workspaceKey: string, sessions: readonly ChatSession[], current: WorkspaceSessionScope): WorkspaceSessionScope {
  if (workspaceKey === current.key) return current;
  const newest = sortSessionsByUpdatedAt([...sessions])[0];
  return { key: workspaceKey, name: newest?.workspaceName || workspaceKey, folderUris: newest?.workspaceFolders ?? [] };
}

function mergeSessionsById(existing: readonly ChatSession[], incoming: readonly ChatSession[]): ChatSession[] {
  const byId = new Map(existing.map((session) => [session.id, session]));
  for (const session of incoming) {
    const previous = byId.get(session.id);
    if (!previous || getSessionUpdatedTimestamp(session) >= getSessionUpdatedTimestamp(previous)) byId.set(session.id, session);
  }
  return sortSessionsByUpdatedAt(Array.from(byId.values()));
}

function manifestEntryToMetadata(entry: GlobalSessionWorkspaceManifestEntry | undefined): WorkspaceMetadata | undefined {
  return entry ? { key: entry.workspaceKey, name: entry.workspaceName, folderUris: entry.workspaceFolders, activeSessionId: entry.activeSessionId, updatedAt: entry.updatedAt } : undefined;
}

function normalizeApprovalMode(value: unknown): ApprovalMode {
  return value === 'delegate' ? value : 'ask';
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];
}

function isoString(value: unknown, fallback: string): string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function getIsoTimestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFileNotFoundError(error: unknown): boolean {
  return isRecord(error) && (error.code === 'FileNotFound' || error.code === 'ENOENT');
}
