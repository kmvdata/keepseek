import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
  createSessionTitle,
  normalizeStoredSessions,
  sortSessionsByUpdatedAt,
  type ChatSessionStorageAdapter,
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
import { HistoryCleanupFailure, type HistoryCleanupIssueCode, type HistoryCleanupPhase } from './historyCleanupErrors';

export const SESSION_CLEANUP_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SESSION_STORAGE_ROOT_DIR = 'chat-sessions';
const SESSION_STORAGE_VERSION_DIR = 'v2';
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
  sessions: SessionIndexEntry[];
  updatedAt: string;
}

export interface SessionIndexEntry extends ChatSessionSummary {
  storageFile: string;
  byteLength?: number;
  /** The atomic workspace index commits an automatic title, after its shard. */
  autoTitleCommit?: string;
}

interface WorkspaceMetadata {
  key: string;
  name: string;
  folderUris: string[];
  activeSessionId?: string;
  updatedAt?: string;
}

export interface HistoryCleanupCatalogDiagnostic {
  code: HistoryCleanupIssueCode;
  phase: HistoryCleanupPhase;
  retryable: boolean;
  /** Stable storage identity only, never a project path, title or body. */
  workspaceHash?: string;
}
export interface HistoryCleanupCatalog {
  entries: HistoryCleanupCatalogEntry[];
  unknown: number;
  diagnostics: HistoryCleanupCatalogDiagnostic[];
  ownershipComplete: boolean;
}
interface CleanupWorkspaceSnapshot {
  workspaceKey: string;
  entries: HistoryCleanupCatalogEntry[];
  unknown: number;
}
interface CleanupIndexSnapshot {
  workspaces: Map<string, CleanupWorkspaceSnapshot>;
  unknownByHash: Map<string, number>;
  diagnostics: HistoryCleanupCatalogDiagnostic[];
  ownershipComplete: boolean;
  collisions: Set<string>;
}

/** V2 stores a small project index and one atomic file per conversation. */
export class GlobalSessionStorage implements ChatSessionStorageAdapter {
  private readonly rootUri: vscode.Uri;
  private readonly manifestUri: vscode.Uri;
  private readonly workspacesUri: vscode.Uri;
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
    this.evidenceStore = new ToolEvidenceStore(globalStorageUri);
  }

  public async loadWorkspace(workspaceScope: WorkspaceSessionScope, options: { fresh?: boolean } = {}): Promise<StoredWorkspaceSessionState> {
    const hash = getWorkspaceHash(workspaceScope.key);
    let index = await this.readWorkspaceIndex(hash, workspaceScope);
    if (!index) return { activeSessionId: '', sessions: [], sessionSummaries: [] };
    if (options.fresh) return { activeSessionId: '', approvalMode: index.approvalMode,
      sessions: [], sessionSummaries: index.sessions.map(toPublicSummary) };

    index = await this.reconcileWorkspaceIndex(index);
    const activeSession = index.activeSessionId
      ? await this.readSession(index.workspaceKey, index.activeSessionId, index)
      : undefined;
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

  public async loadSession(workspaceKey: string, sessionId: string, options: { readOnly?: boolean } = {}): Promise<ChatSession | undefined> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    const normalizedSessionId = sessionId.trim();
    if (!normalizedWorkspaceKey || !normalizedSessionId) return undefined;
    if (options.readOnly) {
      // A bounded navigation may abandon this read. Index repair can
      // write an old active selection after a replacement session has committed,
      // so only initialization and ordinary readers may perform those repairs.
      const hash = getWorkspaceHash(normalizedWorkspaceKey);
      const index = await this.readWorkspaceIndex(hash);
      if (index) return index.workspaceKey === normalizedWorkspaceKey
        ? await this.readSession(normalizedWorkspaceKey, normalizedSessionId, index) : undefined;
      return undefined;
    }
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
      const index = await this.readWorkspaceIndex(hash, manifestEntryToMetadata(manifest.workspaces[hash]));
      if (!index) continue;
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

  private async loadIndexByWorkspaceKey(workspaceKey: string): Promise<WorkspaceSessionIndex | undefined> {
    if (!workspaceKey) return undefined;
    const hash = getWorkspaceHash(workspaceKey);
    const index = await this.readWorkspaceIndex(hash);
    return index?.workspaceKey === workspaceKey ? await this.reconcileWorkspaceIndex(index) : undefined;
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
    if (!isRecord(value) || value.version !== 4 || typeof value.sessionId !== 'string') return undefined;
    if (await this.isSessionDeleted(index.workspaceKey, value.sessionId)) return undefined;
    const stored = await this.objects(uri).load(value);
    if (!isRecord(stored)) return undefined;
    const scope = { key: index.workspaceKey, name: index.workspaceName, folderUris: index.workspaceFolders };
    // The shard is written before the index; attest a completed title against
    // its committed index before accepting it after an interrupted save.
    let candidate = stored;
    const entry = index.sessions.find(item => item.id === stored.id);
    const state = isRecord(stored.autoTitle) ? stored.autoTitle : undefined;
    if (state && (state.status === 'completed' || state.stopped === 'named')) {
      const confirmed = titleMatchesIndex(stored as unknown as ChatSession, entry);
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
    const session = normalizeStoredSessions({ sessions: [candidate] }, scope)[0];
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

  /** One immutable readonly summary snapshot supplies candidates and ownership.
   * No body/checkpoint hydration, manifest repair or persistence is
   * permitted here. Unknown foreign ownership cannot authorize global-ID stores. */
  public async readHistoryCleanupCatalog(workspaceKey?: string): Promise<HistoryCleanupCatalog> {
    const snapshot = await this.readCleanupIndexSnapshot(workspaceKey);
    const entries: HistoryCleanupCatalogEntry[] = [];
    let unknown = 0;
    for (const [hash, workspace] of snapshot.workspaces) {
      if (workspaceKey && workspace.workspaceKey !== workspaceKey) continue;
      unknown += workspace.unknown;
      for (const candidate of workspace.entries) {
        try {
          if (await this.isSessionDeleted(candidate.workspaceKey, candidate.id)) continue;
        } catch (error) {
          candidate.unknownReason = 'deletion_authority_unavailable';
          snapshot.diagnostics.push(this.cleanupDiagnostic(error, 'ownership', hash));
        }
        if (snapshot.collisions.has(candidate.id)) candidate.unknownReason = 'duplicate_session_identity';
        else if (!snapshot.ownershipComplete) candidate.unknownReason ??= 'workspace_ownership_unverified';
        if (!candidate.unknownReason) {
          try {
            if (await this.deletionAuthority.inspectUse(candidate.workspaceKey, candidate.id)) candidate.protectedReason = 'session_in_use';
          } catch (error) {
            candidate.unknownReason = 'storage_ownership_unavailable';
            snapshot.diagnostics.push(this.cleanupDiagnostic(error, 'ownership', hash));
          }
        }
        entries.push(candidate);
      }
    }
    for (const [hash, count] of snapshot.unknownByHash) {
      if (!workspaceKey || hash === getWorkspaceHash(workspaceKey)) unknown += count;
    }
    return { entries, unknown, diagnostics: snapshot.diagnostics, ownershipComplete: snapshot.ownershipComplete };
  }

  private async readCleanupIndexSnapshot(currentWorkspaceKey?: string): Promise<CleanupIndexSnapshot> {
    if (this.globalStorageUri.scheme !== 'file') throw new HistoryCleanupFailure('unsupported_storage', 'catalog', false);
    const result: CleanupIndexSnapshot = { workspaces: new Map(), unknownByHash: new Map(),
      diagnostics: [], ownershipComplete: true, collisions: new Set() };
    let hashes: string[];
    try { hashes = await this.listCleanupWorkspaceHashes(); }
    catch (error) { const issue = this.cleanupDiagnostic(error, 'catalog'); throw new HistoryCleanupFailure(issue.code, issue.phase, issue.retryable); }
    if (currentWorkspaceKey && !hashes.includes(getWorkspaceHash(currentWorkspaceKey))) hashes.push(getWorkspaceHash(currentWorkspaceKey));
    const owners = new Map<string, string>();
    const recordUnknown = (hash: string, count: number, error: unknown, phase: HistoryCleanupPhase = 'catalog') => {
      result.ownershipComplete = false;
      result.unknownByHash.set(hash, (result.unknownByHash.get(hash) ?? 0) + Math.max(1, count));
      result.diagnostics.push(this.cleanupDiagnostic(error, phase, hash));
    };
    for (const hash of hashes) {
      let raw: unknown;
      try { raw = await this.readCleanupJson(this.getWorkspaceIndexUri(hash), 'cleanup summary index'); }
      catch (error) { recordUnknown(hash, 1, error); continue; }
      let files: string[];
      try { files = await this.listCleanupShardFiles(hash); }
      catch (error) { recordUnknown(hash, 1, error); continue; }
      if (raw === undefined) {
        if (files.length) recordUnknown(hash, files.length, new HistoryCleanupFailure('corrupt_index', 'catalog', false));
        continue;
      }
      if (!isRecord(raw) || raw.version !== 2 || typeof raw.workspaceKey !== 'string'
        || getWorkspaceHash(raw.workspaceKey) !== hash || !Array.isArray(raw.sessions)) {
        recordUnknown(hash, 1, new HistoryCleanupFailure('corrupt_index', 'catalog', false)); continue;
      }
      const workspace: CleanupWorkspaceSnapshot = { workspaceKey: raw.workspaceKey, entries: [], unknown: 0 };
      result.workspaces.set(hash, workspace);
      for (const item of raw.sessions) {
        const candidate = this.cleanupEntry(raw.workspaceKey, item);
        if (!candidate) { workspace.unknown++; result.ownershipComplete = false; continue; }
        workspace.entries.push(candidate);
        const owner = owners.get(candidate.id);
        if (owner && owner !== raw.workspaceKey) result.collisions.add(candidate.id);
        else owners.set(candidate.id, raw.workspaceKey);
      }
      // A malformed summary with a known ID is already counted above; its
      // canonical shard must not be counted a second time as an orphan.
      const knownFiles = new Set(raw.sessions.filter(isRecord).flatMap(item => typeof item.id === 'string'
        ? [`${getSessionHash(item.id)}.json`] : []));
      const orphans = files.filter(file => !knownFiles.has(file)).length;
      if (orphans) { workspace.unknown += orphans; result.ownershipComplete = false; }
      if (workspace.unknown) result.diagnostics.push({ code: 'ownership_unverified', phase: 'ownership', retryable: false, workspaceHash: hash });
    }
    return result;
  }

  private cleanupDiagnostic(error: unknown, phase: HistoryCleanupPhase, workspaceHash?: string): HistoryCleanupCatalogDiagnostic {
    if (error instanceof HistoryCleanupFailure) return { code: error.code, phase: error.phase, retryable: error.retryable, workspaceHash };
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : '';
    const message = error instanceof Error ? error.message : '';
    if (code === 'EACCES' || code === 'EPERM' || code === 'NoPermissions') return { code: 'permission_denied', phase, retryable: false, workspaceHash };
    if (error instanceof SyntaxError || /encoded data|encoding.*valid/iu.test(message)) return { code: 'corrupt_index', phase, retryable: false, workspaceHash };
    if (/symbolic-link|escaped.*root/iu.test(message)) return { code: 'unsafe_storage_path', phase, retryable: false, workspaceHash };
    return { code: 'storage_io', phase, retryable: true, workspaceHash };
  }
  private cleanupEntry(workspaceKey: string, raw: unknown): HistoryCleanupCatalogEntry | undefined {
    if (!isRecord(raw) || typeof raw.id !== 'string' || !raw.id || raw.id.length > 4096 || raw.id.includes('\0')
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
    const snapshot = await this.readCleanupIndexSnapshot(target.workspaceKey);
    if (!snapshot.ownershipComplete || snapshot.collisions.has(target.id)) return false;
    const workspace = snapshot.workspaces.get(getWorkspaceHash(target.workspaceKey));
    const actual = workspace?.workspaceKey === target.workspaceKey ? workspace.entries.find(item => item.id === target.id) : undefined;
    return actual?.version === target.version && !await this.isSessionDeleted(target.workspaceKey, target.id)
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
          if (manifest.version !== 4 || manifest.sessionId !== target.id || manifest.workspaceKey !== target.workspaceKey) {
            return { status: 'unknown', reason: 'session_identity_mismatch' };
          }
          // Read only header fields, never messages/checkpoints, for final
          // admission against a shard committed before its index update.
          const updatedAt = await this.objects(shard).loadField(manifest, ['updatedAt']);
          if (updatedAt !== target.updatedAt) return { status: 'skippedChanged', reason: 'session_shard_changed' };
        }
        const objectsUri = vscode.Uri.joinPath(shard, '..', `${shard.path.split('/').at(-1)}.objects`);
        await assertManagedStoragePath(this.globalStorageUri, objectsUri);
        try {
          const type = (await vscode.workspace.fs.stat(objectsUri)).type;
          if ((type & vscode.FileType.SymbolicLink) !== 0 || type !== vscode.FileType.Directory) return { status: committed ? 'removedPendingCleanup' : 'unknown', reason: 'unsafe_session_objects' };
        } catch (error) { if (!isFileNotFoundError(error)) throw error; }
        // An unfinished object writer must never be removed during cleanup.
        const lock = vscode.Uri.joinPath(shard, '..', `${shard.path.split('/').at(-1)}.objects`, 'writer.lock');
        try { await vscode.workspace.fs.stat(lock); return { status: committed ? 'removedPendingCleanup' : 'unavailable', reason: 'session_writer_lock' }; }
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
      const refreshed = await this.readWorkspaceIndex(getWorkspaceHash(target.workspaceKey));
      if (refreshed) this.scheduleManifestWorkspace(refreshed);
      await this.flush();
      return { status: 'removedPendingCleanup', reason: 'associated_cleanup_required' };
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
        .filter(([name, type]) => (type === vscode.FileType.Directory || (type & vscode.FileType.SymbolicLink) !== 0)
          && /^[a-f0-9]{32}$/u.test(name)).map(([name]) => name);
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

/** The workspace index attests the exact completed automatic title. */
function titleMatchesIndex(session: ChatSession, entry?: SessionIndexEntry): boolean {
  return !!entry?.autoTitleCommit && entry.title === session.title && !entry.customTitle
    && automaticTitleCommit(session) === entry.autoTitleCommit;
}

export function automaticTitleCommit(session: ChatSession): string | undefined {
  if (session.customTitle || !session.autoTitle || typeof session.id !== 'string' || typeof session.title !== 'string') return undefined;
  const raw = session.autoTitle;
  const state = normalizeSessionTitle(raw, undefined, { preserveRunning: true });
  if (raw.version !== 2 || raw.stopped !== 'named' || raw.status !== 'completed'
    || state.stopped !== 'named' || state.status !== 'completed') return undefined;
  return createHash('sha256').update(JSON.stringify([
    'session_title_v2', session.id, session.title, state.revision, state.stopped,
    state.completed ? [state.completed.taskId, state.completed.basis] : null
  ]), 'utf8').digest('hex');
}

function sortIndexEntries(entries: SessionIndexEntry[]): SessionIndexEntry[] {
  return [...entries].sort((left, right) => getIsoTimestamp(right.updatedAt) - getIsoTimestamp(left.updatedAt));
}

function chooseActiveSessionIdFromEntries(entries: readonly SessionIndexEntry[], ...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) if (candidate && entries.some((entry) => entry.id === candidate)) return candidate;
  return entries[0]?.id ?? '';
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
