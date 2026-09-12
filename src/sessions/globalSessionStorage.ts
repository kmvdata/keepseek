import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import {
  getSessionUpdatedTimestamp,
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
import { writeJsonAtomic } from '../shared/atomicStorage';
import type { StartupPerformanceTrace } from '../shared/startupPerformance';
import type { ApprovalMode, ChatSession, ChatSessionSummary, WorkspaceSummary } from '../shared/types';

export const SESSION_MIGRATION_KEY = 'keepseek.chatSessionsMigratedToGlobalV1';
export const SESSION_CLEANUP_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;

const SESSION_STORAGE_ROOT_DIR = 'chat-sessions';
const SESSION_STORAGE_VERSION_DIR = 'v2';
const LEGACY_SESSION_STORAGE_VERSION_DIR = 'v1';
const SESSION_STORAGE_MANIFEST_FILE = 'manifest.json';
const SESSION_STORAGE_WORKSPACES_DIR = 'workspaces';
const cleanupFlights = new Map<string, Promise<boolean>>();

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
}

interface LegacyWorkspaceSessionFile {
  version: 1;
  workspaceKey: string;
  workspaceName: string;
  workspaceFolders: string[];
  activeSessionId: string;
  approvalMode: ApprovalMode;
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
          sessions: legacy.sessions,
          sessionSummaries: legacy.sessions.map(toSessionSummary)
        };
      }
    }

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
    const workspaceHash = getWorkspaceHash(workspaceScope.key);
    const existing = await this.readWorkspaceIndex(workspaceHash, workspaceScope);
    const entries = new Map((existing?.sessions ?? []).map((entry) => [entry.id, entry]));
    for (const summary of state.sessionSummaries ?? []) {
      if (summary.workspaceKey !== workspaceScope.key) continue;
      const previous = entries.get(summary.id);
      entries.set(summary.id, {
        ...summary,
        storageFile: previous?.storageFile ?? getSessionStorageFile(summary.id),
        byteLength: previous?.byteLength
      });
    }

    const sessions = state.sessions.filter((session) => session.workspaceKey === workspaceScope.key);
    await Promise.all(sessions.map(async (session) => {
      const value = { version: 2, workspaceKey: workspaceScope.key, session };
      const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      await writeJsonAtomic(this.getSessionUri(workspaceHash, session.id), value);
      entries.set(session.id, {
        ...toSessionSummary(session),
        storageFile: getSessionStorageFile(session.id),
        byteLength
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
    await this.writeWorkspaceIndex(index);
    await this.updateManifestWorkspace(index);
  }

  public async loadSession(workspaceKey: string, sessionId: string): Promise<ChatSession | undefined> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    const normalizedSessionId = sessionId.trim();
    if (!normalizedWorkspaceKey || !normalizedSessionId) return undefined;
    const index = await this.loadIndexByWorkspaceKey(normalizedWorkspaceKey);
    return index ? await this.readSession(normalizedWorkspaceKey, normalizedSessionId, index) : undefined;
  }

  public async listWorkspaceSessionSummaries(workspaceKey: string): Promise<ChatSessionSummary[]> {
    const index = await this.loadIndexByWorkspaceKey(workspaceKey.trim());
    return index ? index.sessions.map(toPublicSummary) : [];
  }

  public async listAllWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
    const manifest = await this.readManifest();
    let repaired = false;
    for (const hash of await this.listWorkspaceIndexHashes()) {
      if (manifest.workspaces[hash]) continue;
      const index = await this.readWorkspaceIndex(hash);
      if (!index) continue;
      this.setManifestWorkspace(manifest, index);
      repaired = true;
    }
    if (repaired) await this.writeManifest(manifest);
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
    const normalizedWorkspaceKey = workspaceKey.trim();
    const ids = new Set(sessionIds.map((id) => id.trim()).filter(Boolean));
    if (!normalizedWorkspaceKey || !ids.size) return;
    const index = await this.loadIndexByWorkspaceKey(normalizedWorkspaceKey);
    if (!index) return;
    const removed = index.sessions.filter((entry) => ids.has(entry.id));
    if (!removed.length) return;
    await Promise.all(removed.map((entry) => this.deleteFile(this.getSessionUri(getWorkspaceHash(normalizedWorkspaceKey), entry.id))));
    index.sessions = index.sessions.filter((entry) => !ids.has(entry.id));
    index.activeSessionId = chooseActiveSessionIdFromEntries(index.sessions, index.activeSessionId);
    index.updatedAt = new Date().toISOString();
    if (!index.sessions.length) {
      await this.deleteEntireWorkspace(normalizedWorkspaceKey);
      return;
    }
    await this.writeWorkspaceIndex(index);
    await this.updateManifestWorkspace(index);
  }

  public async deleteEntireWorkspace(workspaceKey: string): Promise<void> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey) return;
    const hash = getWorkspaceHash(normalizedWorkspaceKey);
    await this.deleteFile(this.getWorkspaceDirectoryUri(hash), true);
    await this.deleteFile(vscode.Uri.joinPath(this.legacyWorkspacesUri, `${hash}.json`));
    const manifest = await this.readManifest();
    if (manifest.workspaces[hash]) {
      delete manifest.workspaces[hash];
      await this.writeManifest(manifest);
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
    const flight = this.performCleanup(options).finally(() => {
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
    const manifest = await this.readManifest();
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
        await Promise.all(removed.map((entry) => this.deleteFile(this.getSessionUri(hash, entry.id))));
        index.sessions = index.sessions.filter((entry) => !removedIds.has(entry.id));
        index.activeSessionId = chooseActiveSessionIdFromEntries(index.sessions, index.activeSessionId);
        index.updatedAt = new Date(now).toISOString();
        if (index.sessions.length) await this.writeWorkspaceIndex(index);
        else await this.deleteFile(this.getWorkspaceDirectoryUri(hash), true);
      }
      if (index.sessions.length) this.setManifestWorkspace(manifest, index);
      else delete manifest.workspaces[hash];
    }
    manifest.lastCleanupAt = new Date(now).toISOString();
    await this.writeManifest(manifest);
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
        await workspaceState.update(SESSION_MIGRATION_KEY, true);
        return false;
      }
      const legacySessions = normalizeStoredSessions(legacyState, currentWorkspaceScope);
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
      const value = { version: 2, workspaceKey: file.workspaceKey, session };
      const byteLength = new TextEncoder().encode(JSON.stringify(value)).byteLength;
      await writeJsonAtomic(this.getSessionUri(workspaceHash, session.id), value);
      entries.push({ ...toSessionSummary(session), storageFile: getSessionStorageFile(session.id), byteLength });
    }
    const index: WorkspaceSessionIndex = {
      version: 2,
      workspaceKey: file.workspaceKey,
      workspaceName: file.workspaceName,
      workspaceFolders: file.workspaceFolders,
      activeSessionId: chooseActiveSessionIdFromEntries(entries, file.activeSessionId),
      approvalMode: file.approvalMode,
      sessions: sortIndexEntries(entries),
      updatedAt: file.updatedAt
    };
    // The index is the commit marker. A failed migration leaves V1 authoritative.
    await this.writeWorkspaceIndex(index);
    await this.updateManifestWorkspace(index);
    // Only remove V1 after every shard, the atomic index commit, and the
    // manifest update have succeeded. Until this point it remains the fallback.
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
    if (!isRecord(value) || value.version !== 2 || !isRecord(value.session)) return undefined;
    const scope = { key: index.workspaceKey, name: index.workspaceName, folderUris: index.workspaceFolders };
    const session = normalizeStoredSessions({ sessions: [value.session] }, scope)[0];
    return session?.workspaceKey === index.workspaceKey ? session : undefined;
  }

  private async readWorkspaceIndex(hash: string, fallback?: WorkspaceMetadata | WorkspaceSessionScope): Promise<WorkspaceSessionIndex | undefined> {
    return normalizeWorkspaceIndex(await this.readJsonFile(this.getWorkspaceIndexUri(hash), 'workspace session index'), fallback);
  }

  private async writeWorkspaceIndex(index: WorkspaceSessionIndex): Promise<void> {
    await writeJsonAtomic(this.getWorkspaceIndexUri(getWorkspaceHash(index.workspaceKey)), index);
  }

  private async readLegacyWorkspaceSessionFile(hash: string, fallback?: WorkspaceMetadata | WorkspaceSessionScope): Promise<LegacyWorkspaceSessionFile | undefined> {
    const value = await this.readJsonFile(vscode.Uri.joinPath(this.legacyWorkspacesUri, `${hash}.json`), 'legacy workspace session file');
    return normalizeLegacyWorkspaceSessionFile(value, fallback);
  }

  private async readManifest(): Promise<GlobalSessionManifest> {
    return normalizeManifest(await this.readJsonFile(this.manifestUri, 'session manifest')) ?? await this.rebuildManifest();
  }

  private async writeManifest(manifest: GlobalSessionManifest): Promise<void> {
    await writeJsonAtomic(this.manifestUri, manifest);
  }

  private async updateManifestWorkspace(index: WorkspaceSessionIndex): Promise<void> {
    const manifest = await this.readManifest();
    this.setManifestWorkspace(manifest, index);
    await this.writeManifest(manifest);
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
    try {
      await vscode.workspace.fs.delete(uri, { recursive, useTrash: false });
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
    }
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
    storageFile: nonEmptyString(value.storageFile) ?? getSessionStorageFile(id),
    byteLength: typeof value.byteLength === 'number' && value.byteLength >= 0 ? Math.floor(value.byteLength) : undefined
  };
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
  return value === 'delegate' || value === 'model_review' ? value : 'ask';
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
