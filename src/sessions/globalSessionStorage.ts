import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
  getSessionUpdatedTimestamp,
  getVisibleMessages,
  sessionViewPageBounds,
  createSessionTitle,
  normalizeStoredActiveSessionIds,
  normalizeStoredSessions,
  SESSION_STORAGE_KEY,
  sortSessionsByUpdatedAt,
  type ChatSessionStorageAdapter,
  type StoredSessionState,
  type StoredWorkspaceSessionState,
  type SessionViewPage,
  type SessionViewPageOptions,
  type WorkspaceSessionScope
} from './chatSessionStore';
import { isRecord } from '../shared/errors';
import { getHardRetentionCutoff } from './sessionRetention';
import { deleteStorageUri, withStorageCoordinator, writeJsonAtomic } from '../shared/atomicStorage';
import type { StartupPerformanceTrace } from '../shared/startupPerformance';
import type { ApprovalMode, ChatSession, ChatSessionSummary, WorkspaceSummary } from '../shared/types';
import { ToolEvidenceStore } from '../agent/evidence/store';
import { SessionObjectStore } from './sessionObjectStore';

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
  /** Explicit import completed; the untouched inline V1 source is retained. */
  legacyImported?: boolean;
}

interface SessionCommitReceipt {
  version: 1;
  workspaceKey: string;
  workspaceName: string;
  workspaceFolders: string[];
  activeSessionId: string;
  approvalMode: ApprovalMode;
  entry: SessionIndexEntry;
}

export interface SessionIndexEntry extends ChatSessionSummary {
  storageFile: string;
  byteLength?: number;
  /** The atomic workspace index commits an automatic title, after its shard. */
  autoTitleCommit?: string;
  /** In-memory presentation marker, never written by the read-only adapter. */
  readonlyView?: 'memento';
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
  private readonly objectStores = new Map<string, SessionObjectStore>();
  private readonly mementoViews = new Map<string, { scope: WorkspaceSessionScope; activeSessionId: string; sessions: ChatSession[];
    canImport: () => boolean }>();
  private readOnly = false;
  public setReadOnly(readOnly: boolean): void { this.readOnly = readOnly; }
  private assertWritable(): void { if (this.readOnly) throw new Error('This project is open read-only in this window.'); }

  private objects(uri: vscode.Uri): SessionObjectStore {
    const key = uri.toString();
    let store = this.objectStores.get(key);
    if (!store) { store = new SessionObjectStore(uri); this.objectStores.set(key, store); }
    return store;
  }

  public constructor(
    globalStorageUri: vscode.Uri,
    private readonly startupTrace?: StartupPerformanceTrace
  ) {
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

  public async readWorkspaceApprovalMode(workspaceScope: WorkspaceSessionScope): Promise<ApprovalMode | undefined> {
    const hash = getWorkspaceHash(workspaceScope.key);
    const index = await this.readWorkspaceIndex(hash, workspaceScope);
    if (index?.workspaceKey === workspaceScope.key) return index.approvalMode;
    // Inline V1 preferences cannot be read independently of the old bodies.
    return undefined;
  }

  public async loadWorkspace(workspaceScope: WorkspaceSessionScope): Promise<StoredWorkspaceSessionState> {
    const hash = getWorkspaceHash(workspaceScope.key);
    let index: WorkspaceSessionIndex | undefined;
    try { index = await this.loadIndexByWorkspaceKey(workspaceScope.key); }
    catch (error) {
      const legacy = await this.readLegacyWorkspaceSessionFile(hash, workspaceScope);
      if (!legacy) throw error;
      return { activeSessionId: legacy.activeSessionId, approvalMode: legacy.approvalMode,
        sessions: legacy.sessions, sessionSummaries: legacy.sessions.map(toSessionSummary) };
    }
    if (!index) {
      const legacy = await this.readLegacyWorkspaceSessionFile(hash, workspaceScope);
      if (!legacy || legacy.workspaceKey !== workspaceScope.key) {
        return { activeSessionId: '', sessions: [], sessionSummaries: [] };
      }
      try {
        if (this.readOnly) return { activeSessionId: legacy.activeSessionId, approvalMode: legacy.approvalMode,
          sessions: legacy.sessions, sessionSummaries: legacy.sessions.map(toSessionSummary) };
        index = await this.migrateLegacyWorkspaceFile(legacy);
      } catch (error) {
        console.warn('KeepSeek: sharded session migration failed; using the intact V1 file.', storageFailureCode(error));
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
    this.assertWritable();
    await withStorageCoordinator(this.rootUri, async () => this.saveWorkspaceCoordinated(workspaceScope, state));
    await this.flush();
  }

  public async saveSessionChanges(workspaceScope: WorkspaceSessionScope, state: StoredWorkspaceSessionState,
    preserveSelection = false): Promise<void> {
    this.assertWritable();
    await withStorageCoordinator(this.rootUri, async () => this.saveWorkspaceCoordinated(workspaceScope, state, preserveSelection));
    await this.flush();
  }

  /** Canonical shard/object graph plus a tiny atomic discovery receipt. No old
   * index, manifest, V1 or Memento read is necessary for a new turn's barrier. */
  public async saveFreshSessionChanges(workspaceScope: WorkspaceSessionScope, state: StoredWorkspaceSessionState): Promise<void> {
    this.assertWritable();
    await withStorageCoordinator(this.rootUri, async () => {
      const hash = getWorkspaceHash(workspaceScope.key);
      for (const session of state.sessions) {
        if (session.workspaceKey !== workspaceScope.key) throw new Error('Fresh session workspace mismatch.');
        const byteLength = await this.objects(this.getSessionUri(hash, session.id)).save(session);
        const receipt: SessionCommitReceipt = { version: 1, workspaceKey: workspaceScope.key,
          workspaceName: workspaceScope.name, workspaceFolders: [...workspaceScope.folderUris],
          activeSessionId: state.activeSessionId, approvalMode: normalizeApprovalMode(state.approvalMode),
          entry: { ...toSessionSummary(session), storageFile: getSessionStorageFile(session.id),
            byteLength, autoTitleCommit: automaticTitleCommit(session) } };
        await writeJsonAtomic(this.getCommitUri(hash, session.id), receipt, { durable: true });
      }
    });
  }

  public async loadSessionPage(workspaceKey: string, sessionId: string,
    options: SessionViewPageOptions = {}): Promise<SessionViewPage | undefined> {
    const index = await this.loadIndexByWorkspaceKey(workspaceKey);
    const summary = index?.sessions.find(entry => entry.id === sessionId);
    if (!index || index.workspaceKey !== workspaceKey || !summary) return undefined;
    const uri = this.getSessionUri(getWorkspaceHash(workspaceKey), sessionId);
    let value = summary.readonlyView === 'memento'
      ? { version: 2, session: this.mementoViews.get(workspaceKey)?.sessions.find(item => item.id === sessionId) }
      : await this.readJsonFile(uri, 'session view');
    if (!value && this.readOnly) {
      const legacy = await this.readLegacyWorkspaceSessionFile(getWorkspaceHash(workspaceKey));
      const session = legacy?.sessions.find(item => item.id === sessionId && item.workspaceKey === workspaceKey);
      if (session) value = { version: 2, session };
    }
    if (!isRecord(value)) return undefined;
    if ([3, 4].includes(Number(value.version))) {
      const page = await this.objects(uri).loadViewPage(value, options);
      if (page.workspaceKey !== workspaceKey || page.sessionId !== sessionId) throw new Error('Session view scope mismatch');
      return { kind: 'session-view-page', ...page, title: summary.title };
    }
    // Old shards stay readable. Projection is display-only and no migration is triggered.
    const session = normalizeStoredSessions({ sessions: [value.session] }, { key: workspaceKey, name: index.workspaceName,
      folderUris: index.workspaceFolders })[0];
    if (!session || session.id !== sessionId || session.workspaceKey !== workspaceKey) return undefined;
    const anchorIndex = options.anchorMessageId === undefined ? undefined
      : session.messages.findIndex(message => message.id === options.anchorMessageId);
    const { startIndex, endIndex, hasOlder, hasNewer } = sessionViewPageBounds(session.messages.length, { ...options, anchorIndex });
    return { kind: 'session-view-page', sessionId, revision: 0, title: summary.title,
      totalMessages: session.messages.length, startIndex, hasOlder, hasNewer,
      ...(anchorIndex === undefined ? {} : { anchorFound: anchorIndex >= 0 }),
      messages: getVisibleMessages(session.messages.slice(startIndex, endIndex)) };
  }

  public async flush(): Promise<void> {
    if (this.readOnly) return;
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

  private async saveWorkspaceCoordinated(workspaceScope: WorkspaceSessionScope, state: StoredWorkspaceSessionState, preserveSelection = false): Promise<void> {
    const workspaceHash = getWorkspaceHash(workspaceScope.key);
    let existing = await this.loadIndexByWorkspaceKey(workspaceScope.key, true);
    if (!existing) {
      // New Chat can commit before the initial legacy-history read finishes.
      // Preserve that intact history before publishing the first V2 index.
      const legacy = await this.readLegacyWorkspaceSessionFile(workspaceHash, workspaceScope);
      if (legacy?.workspaceKey === workspaceScope.key) existing = await this.migrateLegacyWorkspaceFile(legacy, true);
    }
    const entries = new Map((existing?.sessions ?? []).map((entry) => [entry.id, entry]));
    for (const summary of state.sessionSummaries ?? []) {
      if (summary.workspaceKey !== workspaceScope.key) continue;
      const previous = entries.get(summary.id);
      entries.set(summary.id, {
        ...summary,
        storageFile: previous?.storageFile ?? getSessionStorageFile(summary.id),
        byteLength: previous?.byteLength,
        autoTitleCommit: previous?.autoTitleCommit
      });
    }

    const sessions = state.sessions.filter((session) => session.workspaceKey === workspaceScope.key);
    await Promise.all(sessions.map(async (session) => {
      const byteLength = await this.objects(this.getSessionUri(workspaceHash, session.id)).save(session);
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
      activeSessionId: chooseActiveSessionIdFromEntries(sortedEntries, preserveSelection ? existing?.activeSessionId : state.activeSessionId, existing?.activeSessionId),
      approvalMode: normalizeApprovalMode(preserveSelection ? existing?.approvalMode : state.approvalMode ?? existing?.approvalMode),
      legacyImported: existing?.legacyImported,
      sessions: sortedEntries,
      updatedAt: now
    };
    await this.writeWorkspaceIndex(index);
    this.scheduleManifestWorkspace(index);
  }

  /** Resolve the storage owner without cloning or relinking a legacy session.
   * IDs are usually UUIDs; ambiguous historical IDs fail closed. */
  public async findSessionScope(sessionId: string): Promise<WorkspaceSessionScope | undefined> {
    if (!sessionId.trim()) return undefined;
    let found: WorkspaceSessionScope | undefined;
    for (const hash of await this.listWorkspaceIndexHashes()) {
      const index = await this.indexForHash(hash);
      if (!index?.sessions.some(entry => entry.id === sessionId)) continue;
      if (found && found.key !== index.workspaceKey) throw new Error('Session identity is ambiguous across workspaces.');
      found = { key: index.workspaceKey, name: index.workspaceName, folderUris: [...index.workspaceFolders] };
    }
    for (const view of this.mementoViews.values()) {
      if (!view.sessions.some(session => session.id === sessionId)) continue;
      if (found && found.key !== view.scope.key) throw new Error('Session identity is ambiguous across workspaces.');
      found = { ...view.scope, folderUris: [...view.scope.folderUris] };
    }
    return found;
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
      const index = await this.indexForHash(hash);
      if (!index) continue;
      if (!index.sessions.length) { delete manifest.workspaces[hash]; repaired = true; continue; }
      this.setManifestWorkspace(manifest, index);
      repaired = true;
    }
    if (this.readOnly) for (const key of this.mementoViews.keys()) {
      const index = this.mementoViewIndex(undefined, key);
      if (!index) continue;
      const hash = getWorkspaceHash(key), previous = manifest.workspaces[hash];
      if (!previous) this.setManifestWorkspace(manifest, index);
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
    this.assertWritable();
    await withStorageCoordinator(this.rootUri, async () => this.deleteWorkspaceSessionsCoordinated(workspaceKey, sessionIds));
  }

  private async deleteWorkspaceSessionsCoordinated(workspaceKey: string, sessionIds: string[]): Promise<void> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    const ids = new Set(sessionIds.map((id) => id.trim()).filter(Boolean));
    if (!normalizedWorkspaceKey || !ids.size) return;
    const index = await this.loadIndexByWorkspaceKey(normalizedWorkspaceKey, true);
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
    this.assertWritable();
    await withStorageCoordinator(this.rootUri, async () => this.deleteEntireWorkspaceCoordinated(workspaceKey));
  }

  private async deleteEntireWorkspaceCoordinated(workspaceKey: string): Promise<void> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey) return;
    const hash = getWorkspaceHash(normalizedWorkspaceKey);
    this.forgetScheduledManifestWorkspace(hash);
    const index = await this.loadIndexByWorkspaceKey(normalizedWorkspaceKey, true);
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
    if (this.readOnly) return false;
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
        index = await this.migrateLegacyWorkspaceFile(legacy, true);
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
          if (index.legacyImported) {
            // The retained V1 file is a recovery original, not a second live
            // source. Keep its import tombstone so retention cannot resurrect
            // expired sessions on the next explicit history entry.
            index.activeSessionId = '';
            await this.writeWorkspaceIndex(index);
          } else await this.deleteFile(this.getWorkspaceDirectoryUri(hash), true);
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
      if (workspaceState.get<boolean>(SESSION_MIGRATION_KEY, false)) return false;
      const legacyState = workspaceState.get<StoredSessionState>(SESSION_STORAGE_KEY);
      if (!isRecord(legacyState) || !Array.isArray(legacyState.sessions)) {
        if (!this.readOnly) await workspaceState.update(SESSION_MIGRATION_KEY, true);
        return false;
      }
      const legacySessions = normalizeStoredSessions(legacyState, currentWorkspaceScope);
      const activeSessionIdsByWorkspace = normalizeStoredActiveSessionIds(legacyState, legacySessions);
      if (this.readOnly) {
        for (const [key, sessions] of groupSessionsByWorkspace(legacySessions)) this.mementoViews.set(key, {
          scope: getWorkspaceScopeForSessions(key, sessions, currentWorkspaceScope),
          activeSessionId: activeSessionIdsByWorkspace[key] ?? '', sessions,
          canImport: () => !workspaceState.get<boolean>(SESSION_MIGRATION_KEY, false)
        });
        return false; // View availability does not report a completed migration.
      }
      for (const [workspaceKey, sessions] of groupSessionsByWorkspace(legacySessions)) {
        const scope = getWorkspaceScopeForSessions(workspaceKey, sessions, currentWorkspaceScope);
        await withStorageCoordinator(this.rootUri, async () => {
          this.assertWritable();
          const existing = await this.loadIndexByWorkspaceKey(workspaceKey, true);
          const entries = new Map(existing?.sessions.map(entry => [entry.id, entry]));
          const imported: ChatSession[] = [];
          for (const session of sessions) {
            const previous = entries.get(session.id);
            // Compare the latest index inside the same transaction as the write.
            // Current authority wins ties; ordinary current bodies stay cold.
            if (previous && getSessionUpdatedTimestamp(session) <= getIsoTimestamp(previous.updatedAt)) continue;
            if (previous && !await this.readSession(workspaceKey, session.id, existing!)) {
              throw new Error('Cannot verify the existing session before importing newer legacy history.');
            }
            // Only a strictly newer same-ID legacy conflict needs its current
            // body verified to acquire the normal revision/hash save boundary.
            imported.push(session);
          }
          if (!imported.length) return;
          await this.saveWorkspaceCoordinated(scope, {
            activeSessionId: activeSessionIdsByWorkspace[workspaceKey] ?? '',
            sessions: imported,
            sessionSummaries: imported.map(toSessionSummary)
          }, Boolean(existing?.activeSessionId));
        });
      }
      await this.flush();
      await workspaceState.update(SESSION_MIGRATION_KEY, true);
      return true;
    } catch (error) {
      console.warn('KeepSeek: failed to migrate legacy chat sessions to global storage.', storageFailureCode(error));
      return false;
    }
  }

  private async loadIndexByWorkspaceKey(workspaceKey: string, coordinated = false): Promise<WorkspaceSessionIndex | undefined> {
    if (!workspaceKey) return undefined;
    if (!this.readOnly && this.mementoViews.has(workspaceKey)) return this.importMementoView(workspaceKey, coordinated);
    const hash = getWorkspaceHash(workspaceKey);
    let index = await this.readWorkspaceIndex(hash);
    if (!index?.legacyImported) {
      const legacy = await this.readLegacyWorkspaceSessionFile(hash);
      if (legacy?.workspaceKey === workspaceKey && !this.readOnly) index = await this.migrateLegacyWorkspaceFile(legacy, coordinated);
      else if (legacy?.workspaceKey === workspaceKey && this.readOnly && !index) {
        index = { version: 2, workspaceKey, workspaceName: legacy.workspaceName, workspaceFolders: legacy.workspaceFolders,
          activeSessionId: legacy.activeSessionId, approvalMode: legacy.approvalMode,
          sessions: legacy.sessions.map(session => ({ ...toSessionSummary(session), storageFile: getSessionStorageFile(session.id) })),
          updatedAt: legacy.updatedAt };
      }
    }
    if (!coordinated && !this.readOnly) {
      // A historical provider read may stall indefinitely. Keep that read out
      // of the write coordinator so a new independent target can still commit.
      // Re-read the small index only after acquiring the merge transaction.
      const historical = index;
      index = await withStorageCoordinator(this.rootUri, async () => this.mergeCommitReceipts(hash,
        await this.readWorkspaceIndex(hash) ?? historical));
    } else index = await this.mergeCommitReceipts(hash, index);
    if (this.readOnly) index = this.mementoViewIndex(index, workspaceKey);
    return index?.workspaceKey === workspaceKey ? await this.reconcileWorkspaceIndex(index, coordinated) : undefined;
  }

  private mementoViewIndex(index: WorkspaceSessionIndex | undefined, workspaceKey: string): WorkspaceSessionIndex | undefined {
    const view = this.mementoViews.get(workspaceKey);
    if (!view) return index;
    index ??= { version: 2, workspaceKey, workspaceName: view.scope.name, workspaceFolders: [...view.scope.folderUris],
      activeSessionId: view.activeSessionId, approvalMode: 'ask', sessions: [], updatedAt: new Date(0).toISOString() };
    const entries = new Map(index.sessions.map(entry => [entry.id, entry]));
    for (const session of view.sessions) {
      const previous = entries.get(session.id);
      if (previous && getSessionUpdatedTimestamp(session) <= getIsoTimestamp(previous.updatedAt)) continue;
      entries.set(session.id, { ...toSessionSummary(session), storageFile: getSessionStorageFile(session.id), readonlyView: 'memento' });
    }
    const sessions = sortIndexEntries([...entries.values()]);
    return { ...index, sessions, updatedAt: sessions[0]?.updatedAt ?? index.updatedAt };
  }

  private async importMementoView(workspaceKey: string, coordinated: boolean): Promise<WorkspaceSessionIndex | undefined> {
    const view = this.mementoViews.get(workspaceKey)!;
    const work = async () => {
      this.mementoViews.delete(workspaceKey);
      try {
        const existing = await this.loadIndexByWorkspaceKey(workspaceKey, true);
        if (!view.canImport()) return existing;
        const imported = view.sessions.filter(session => {
          const prior = existing?.sessions.find(entry => entry.id === session.id);
          return !prior || getSessionUpdatedTimestamp(session) > getIsoTimestamp(prior.updatedAt);
        });
        for (const session of imported) if (existing?.sessions.some(entry => entry.id === session.id)
          && !await this.readSession(workspaceKey, session.id, existing)) {
          throw new Error('Cannot verify current history before importing a newer viewed legacy session.');
        }
        if (imported.length) await this.saveWorkspaceCoordinated(view.scope, { activeSessionId: view.activeSessionId,
          sessions: imported, sessionSummaries: imported.map(toSessionSummary) }, Boolean(existing?.activeSessionId));
        return await this.loadIndexByWorkspaceKey(workspaceKey, true);
      } catch (error) { this.mementoViews.set(workspaceKey, view); throw error; }
    };
    return coordinated ? work() : withStorageCoordinator(this.rootUri, work);
  }

  private async migrateLegacyWorkspaceFile(file: LegacyWorkspaceSessionFile, coordinated = false): Promise<WorkspaceSessionIndex> {
    if (!coordinated) return await withStorageCoordinator(this.rootUri, async () => this.migrateLegacyWorkspaceFile(file, true));
    const workspaceHash = getWorkspaceHash(file.workspaceKey);
    const existing = await this.readWorkspaceIndex(workspaceHash);
    if (existing?.legacyImported) return existing;
    const entries: SessionIndexEntry[] = [...(existing?.sessions ?? [])];
    for (const session of file.sessions) {
      // The current index wins same-ID conflicts. Legacy originals remain
      // available for manual inspection; never rewrite current request bytes.
      if (entries.some(entry => entry.id === session.id)) continue;
      const value = { version: 2, workspaceKey: file.workspaceKey, session };
      const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      await writeJsonAtomic(this.getSessionUri(workspaceHash, session.id), value);
      entries.push({ ...toSessionSummary(session), storageFile: getSessionStorageFile(session.id), byteLength,
        autoTitleCommit: automaticTitleCommit(session) });
    }
    const index: WorkspaceSessionIndex = {
      version: 2,
      workspaceKey: file.workspaceKey,
      workspaceName: file.workspaceName,
      workspaceFolders: file.workspaceFolders,
      activeSessionId: chooseActiveSessionIdFromEntries(entries, existing?.activeSessionId, file.activeSessionId),
      approvalMode: existing?.approvalMode ?? file.approvalMode,
      approvalModeMigrated: file.approvalModeMigrated,
      sessions: sortIndexEntries(entries),
      updatedAt: file.updatedAt,
      legacyImported: true
    };
    // The index is the commit marker. A failed migration leaves V1 authoritative.
    await this.writeWorkspaceIndex(index);
    await this.updateManifestWorkspace(index);
    // The atomic workspace index is the migration commit marker. The global
    // manifest is derived and may be refreshed later without risking shards.
    // Retain the V1 original. legacyImported is the idempotent merge marker.
    return index;
  }

  private async mergeCommitReceipts(hash: string, index?: WorkspaceSessionIndex): Promise<WorkspaceSessionIndex | undefined> {
    let files: string[];
    try { files = (await vscode.workspace.fs.readDirectory(this.getCommitsDirectoryUri(hash)))
      .filter(([name, type]) => type === vscode.FileType.File && /^[a-f0-9]{32}\.json$/u.test(name)).map(([name]) => name); }
    catch (error) { if (isFileNotFoundError(error)) return index; throw error; }
    const receipts: Array<{ uri: vscode.Uri; value: SessionCommitReceipt }> = [];
    for (const file of files) {
      const uri = vscode.Uri.joinPath(this.getCommitsDirectoryUri(hash), file);
      const raw = await this.readJsonFile(uri, 'new session commit receipt');
      if (!isRecord(raw) || raw.version !== 1 || typeof raw.workspaceKey !== 'string'
        || getWorkspaceHash(raw.workspaceKey) !== hash) continue;
      const entry = normalizeSessionIndexEntry(raw.entry, raw.workspaceKey,
        typeof raw.workspaceName === 'string' ? raw.workspaceName : raw.workspaceKey);
      if (!entry || file !== `${getSessionHash(entry.id)}.json`) continue;
      receipts.push({ uri, value: { version: 1, workspaceKey: raw.workspaceKey,
        workspaceName: typeof raw.workspaceName === 'string' ? raw.workspaceName : raw.workspaceKey,
        workspaceFolders: stringArray(raw.workspaceFolders), activeSessionId: entry.id,
        approvalMode: normalizeApprovalMode(raw.approvalMode), entry } });
    }
    if (!receipts.length) return index;
    const first = receipts[0].value;
    index ??= { version: 2, workspaceKey: first.workspaceKey, workspaceName: first.workspaceName,
      workspaceFolders: first.workspaceFolders, activeSessionId: first.activeSessionId,
      approvalMode: first.approvalMode, sessions: [], updatedAt: first.entry.updatedAt };
    const entries = new Map(index.sessions.map(entry => [entry.id, entry]));
    for (const { value } of receipts) {
      if (value.workspaceKey !== index.workspaceKey) throw new Error('Session commit receipt scope mismatch.');
      entries.set(value.entry.id, value.entry);
    }
    index.sessions = sortIndexEntries([...entries.values()]);
    index.updatedAt = index.sessions[0]?.updatedAt ?? index.updatedAt;
    if (!this.readOnly) {
      // Publishing the canonical index precedes receipt removal. A crash at any
      // point repeats the same merge, never loses the only discovery marker.
      await this.writeWorkspaceIndex(index);
      for (const { uri } of receipts) await this.deleteFile(uri);
      this.scheduleManifestWorkspace(index);
    }
    return index;
  }

  private async indexForHash(hash: string): Promise<WorkspaceSessionIndex | undefined> {
    const work = async () => {
      const index = await this.readWorkspaceIndex(hash);
      return index ? this.loadIndexByWorkspaceKey(index.workspaceKey, true) : this.mergeCommitReceipts(hash);
    };
    return this.readOnly ? work() : withStorageCoordinator(this.rootUri, work);
  }

  private async reconcileWorkspaceIndex(index: WorkspaceSessionIndex, coordinated = false): Promise<WorkspaceSessionIndex> {
    if (this.readOnly) return index;
    if (!coordinated) return await withStorageCoordinator(this.rootUri, async () => this.reconcileWorkspaceIndex(index, true));
    const hash = getWorkspaceHash(index.workspaceKey);
    // A concurrently-created fresh session may have committed since this read.
    // Reconciliation must not write an obsolete index over that selection/shard.
    index = await this.readWorkspaceIndex(hash) ?? index;
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
    const entry = index.sessions.find(candidate => candidate.id === sessionId);
    if (!entry) return undefined;
    if (entry.readonlyView === 'memento') return this.mementoViews.get(workspaceKey)?.sessions.find(session => session.id === sessionId);
    return await this.readSessionShard(this.getSessionUri(getWorkspaceHash(workspaceKey), sessionId), index);
  }

  private async readSessionShard(uri: vscode.Uri, index: WorkspaceSessionIndex): Promise<ChatSession | undefined> {
    let value = await this.readJsonFile(uri, 'session shard');
    if (!value && this.readOnly) {
      const legacy = await this.readLegacyWorkspaceSessionFile(getWorkspaceHash(index.workspaceKey));
      const session = legacy?.sessions.find(item => getSessionHash(item.id) === uri.path.split('/').at(-1)?.replace(/\.json$/u, ''));
      if (session) value = { version: 2, session };
    }
    if (!isRecord(value) || ![2, 3, 4].includes(Number(value.version))) return undefined;
    const stored = Number(value.version) >= 3 ? await this.objects(uri).load(value) : value.session;
    if (!isRecord(stored)) return undefined;
    const scope = { key: index.workspaceKey, name: index.workspaceName, folderUris: index.workspaceFolders };
    const session = normalizeStoredSessions({ sessions: [stored] }, scope)[0];
    if (session?.autoTitle?.status === 'completed') {
      const entry = index.sessions.find(candidate => candidate.id === session.id);
      // Shards are written before the index. An interrupted/failed index commit
      // must not turn a rejected title into success on restart or orphan repair.
      if (!entry?.autoTitleCommit || entry.autoTitleCommit !== automaticTitleCommit(session)) {
        const state = session.autoTitle;
        const previous = state.regenerationPrevious;
        if (previous && entry) {
          const priorSession = { ...session, title: previous.title, customTitle: previous.customTitle,
            autoTitle: previous.metadata };
          const confirmedPrevious = previous.customTitle
            ? entry.customTitle === previous.customTitle && entry.title === previous.title
            : previous.metadata.status === 'completed'
              ? !!entry.autoTitleCommit && entry.autoTitleCommit === automaticTitleCommit(priorSession)
              : !entry.autoTitleCommit && entry.title === previous.title;
          if (confirmedPrevious) {
            session.title = previous.title;
            session.customTitle = previous.customTitle;
            session.autoTitle = previous.metadata;
            return session.workspaceKey === index.workspaceKey ? session : undefined;
          }
        }
        session.autoTitle = { version: 1, status: 'pending', revision: state.revision + 1,
          lastAttemptTaskId: state.lastAttemptTaskId ?? state.completed?.taskId,
          lastOutcome: entry?.customTitle ? 'manual' : 'save_failed' };
        session.customTitle = entry?.customTitle ?? session.customTitle;
        session.title = session.customTitle ?? entry?.title
          ?? createSessionTitle(session.messages.find(message => message.role === 'user'
            && !message.contextMeta?.displayKind)?.content ?? '');
      }
    }
    return session?.workspaceKey === index.workspaceKey ? session : undefined;
  }

  private async readWorkspaceIndex(hash: string, fallback?: WorkspaceMetadata | WorkspaceSessionScope): Promise<WorkspaceSessionIndex | undefined> {
    return normalizeWorkspaceIndex(await this.readJsonFile(this.getWorkspaceIndexUri(hash), 'workspace session index'), fallback);
  }

  private async writeWorkspaceIndex(index: WorkspaceSessionIndex): Promise<void> {
    this.assertWritable();
    await writeJsonAtomic(this.getWorkspaceIndexUri(getWorkspaceHash(index.workspaceKey)), index, { durable: true });
  }

  private async readLegacyWorkspaceSessionFile(hash: string, fallback?: WorkspaceMetadata | WorkspaceSessionScope): Promise<LegacyWorkspaceSessionFile | undefined> {
    const value = await this.readJsonFile(vscode.Uri.joinPath(this.legacyWorkspacesUri, `${hash}.json`), 'legacy workspace session file');
    return normalizeLegacyWorkspaceSessionFile(value, fallback);
  }

  private async readManifest(): Promise<GlobalSessionManifest> {
    return normalizeManifest(await this.readJsonFile(this.manifestUri, 'session manifest')) ?? await this.rebuildManifest();
  }

  private async writeManifest(manifest: GlobalSessionManifest): Promise<void> {
    if (this.readOnly) return;
    await writeJsonAtomic(this.manifestUri, manifest);
  }

  private async updateManifestWorkspace(index: WorkspaceSessionIndex): Promise<void> {
    this.scheduleManifestWorkspace(index);
  }

  private scheduleManifestWorkspace(index: WorkspaceSessionIndex): void {
    if (this.readOnly) return;
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
          console.warn('KeepSeek: derived session manifest refresh failed; it will be rebuilt later.', storageFailureCode(error));
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
                'KeepSeek: derived session manifest retry failed; startup rebuild remains available.', storageFailureCode(retryError)));
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
      console.warn(`KeepSeek: derived session manifest update failed during ${operation}; continuing.`, storageFailureCode(error));
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

  private async readJsonFile(uri: vscode.Uri, description: string): Promise<unknown | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      this.startupTrace?.mark('storage-read', { bytesRead: bytes.byteLength, entries: 1 });
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch (error) {
      if (!isFileNotFoundError(error)) console.warn(`KeepSeek: failed to read ${description}; ignoring it.`, storageFailureCode(error));
      return undefined;
    }
  }

  private async listWorkspaceIndexHashes(): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.workspacesUri);
      return entries.filter(([name, type]) => type === vscode.FileType.Directory && /^[a-f0-9]{32}$/u.test(name)).map(([name]) => name);
    } catch (error) {
      if (!isFileNotFoundError(error)) console.warn('KeepSeek: failed to enumerate session indexes.', storageFailureCode(error));
      return [];
    }
  }

  private async listSessionShardFiles(workspaceHash: string): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.getSessionsDirectoryUri(workspaceHash));
      return entries.filter(([name, type]) => type === vscode.FileType.File && /^[a-f0-9]{32}\.json$/u.test(name)).map(([name]) => name);
    } catch (error) {
      if (!isFileNotFoundError(error)) console.warn('KeepSeek: failed to enumerate session shards.', storageFailureCode(error));
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

  private getCommitsDirectoryUri(hash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getWorkspaceDirectoryUri(hash), 'commits');
  }

  private getCommitUri(hash: string, sessionId: string): vscode.Uri {
    return vscode.Uri.joinPath(this.getCommitsDirectoryUri(hash), `${getSessionHash(sessionId)}.json`);
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
    legacyImported: value.legacyImported === true || undefined,
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

function automaticTitleCommit(session: ChatSession): string | undefined {
  const state = session.autoTitle;
  if (session.customTitle || state?.status !== 'completed' || !state.completed) return undefined;
  return createHash('sha256').update(JSON.stringify([
    session.id, session.title, state.revision, state.completed.taskId,
    state.completed.basis.messages.map(ref => [ref.id, ref.hash]), state.completed.basis.lastMessageId,
    ...(state.completed.basis.conversation ? [state.completed.basis.conversation] : [])
  ]), 'utf8').digest('hex');
}

function normalizeLegacyWorkspaceSessionFile(value: unknown, fallback?: WorkspaceMetadata | WorkspaceSessionScope): LegacyWorkspaceSessionFile | undefined {
  if (!isRecord(value)) return undefined;
  const workspaceKey = nonEmptyString(value.workspaceKey) ?? fallback?.key;
  if (!workspaceKey) return undefined;
  const workspaceName = nonEmptyString(value.workspaceName) ?? fallback?.name ?? workspaceKey;
  const workspaceFolders = Array.isArray(value.workspaceFolders) ? stringArray(value.workspaceFolders) : fallback?.folderUris ?? [];
  const scope = { key: workspaceKey, name: workspaceName, folderUris: workspaceFolders };
  const sessions = normalizeStoredSessions(value, scope).filter((session) => session.workspaceKey === workspaceKey);
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

function storageFailureCode(error: unknown): string {
  const code = isRecord(error) ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z_0-9]{1,48}$/u.test(code) ? code
    : error instanceof SyntaxError ? 'invalid_json' : 'storage_error';
}
