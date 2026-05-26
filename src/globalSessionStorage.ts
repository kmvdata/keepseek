import { createHash, randomUUID } from 'node:crypto';
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
import { isRecord } from './errors';
import { pruneExpiredSessions } from './sessionRetention';
import type { ChatSession } from './types';

export const SESSION_MIGRATION_KEY = 'keepseek.chatSessionsMigratedToGlobalV1';

const SESSION_STORAGE_ROOT_DIR = 'chat-sessions';
const SESSION_STORAGE_VERSION_DIR = 'v1';
const SESSION_STORAGE_MANIFEST_FILE = 'manifest.json';
const SESSION_STORAGE_WORKSPACES_DIR = 'workspaces';
const SESSION_STORAGE_VERSION = 1;

export interface GlobalSessionManifest {
  version: 1;
  workspaces: Record<string, GlobalSessionWorkspaceManifestEntry>;
  lastCleanupAt?: string;
}

export interface GlobalSessionWorkspaceManifestEntry {
  workspaceKey: string;
  workspaceName: string;
  workspaceFolders: string[];
  storageFile: string;
  activeSessionId?: string;
  updatedAt: string;
}

export interface WorkspaceSessionFile {
  version: 1;
  workspaceKey: string;
  workspaceName: string;
  workspaceFolders: string[];
  activeSessionId: string;
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

export class GlobalSessionStorage implements ChatSessionStorageAdapter {
  private readonly rootUri: vscode.Uri;
  private readonly manifestUri: vscode.Uri;
  private readonly workspacesUri: vscode.Uri;
  private readonly encoder = new TextEncoder();
  private readonly decoder = new TextDecoder();

  public constructor(private readonly globalStorageUri: vscode.Uri) {
    this.rootUri = vscode.Uri.joinPath(
      this.globalStorageUri,
      SESSION_STORAGE_ROOT_DIR,
      SESSION_STORAGE_VERSION_DIR
    );
    this.manifestUri = vscode.Uri.joinPath(this.rootUri, SESSION_STORAGE_MANIFEST_FILE);
    this.workspacesUri = vscode.Uri.joinPath(this.rootUri, SESSION_STORAGE_WORKSPACES_DIR);
  }

  public async loadWorkspace(workspaceScope: WorkspaceSessionScope): Promise<StoredWorkspaceSessionState> {
    const file = await this.readWorkspaceSessionFile(getWorkspaceHash(workspaceScope.key), workspaceScope);
    if (!file || file.workspaceKey !== workspaceScope.key) {
      return { activeSessionId: '', sessions: [] };
    }

    return {
      activeSessionId: file.activeSessionId,
      sessions: file.sessions
    };
  }

  public async saveWorkspace(
    workspaceScope: WorkspaceSessionScope,
    state: StoredWorkspaceSessionState
  ): Promise<void> {
    const file = createWorkspaceSessionFile(workspaceScope, state);
    await this.writeWorkspaceSessionFile(file);

    const manifest = await this.readManifest();
    this.setManifestWorkspace(manifest, file);
    await this.writeManifest(manifest);
  }

  public async cleanupExpiredSessions(options: {
    currentWorkspaceKey: string;
    currentActiveSessionId: string;
    now?: number;
  }): Promise<boolean> {
    const now = options.now ?? Date.now();
    const cleanupTime = new Date(now).toISOString();
    const manifest = await this.readManifest();
    const workspaceHashes = new Set([
      ...Object.keys(manifest.workspaces),
      ...(await this.listWorkspaceSessionFileHashes())
    ]);

    let sessionsChanged = false;
    for (const hash of workspaceHashes) {
      const manifestEntry = manifest.workspaces[hash];
      const fallback = manifestEntryToMetadata(manifestEntry);
      const file = await this.readWorkspaceSessionFile(hash, fallback);
      if (!file) {
        if (manifestEntry) {
          delete manifest.workspaces[hash];
        }
        continue;
      }

      const pruned = pruneExpiredSessions(file.sessions, {
        currentWorkspaceKey: options.currentWorkspaceKey,
        currentActiveSessionId: options.currentActiveSessionId,
        now
      });
      const retainedSessions = compactWorkspaceSessions(pruned.sessions, file.activeSessionId);

      if (pruned.deletedCount > 0 || retainedSessions.length !== file.sessions.length) {
        sessionsChanged = true;
        if (retainedSessions.length) {
          const updatedFile = withUpdatedSessions(file, retainedSessions, cleanupTime);
          await this.writeWorkspaceSessionFile(updatedFile);
          this.setManifestWorkspace(manifest, updatedFile);
        } else {
          await this.deleteWorkspaceSessionFile(hash);
          delete manifest.workspaces[hash];
        }
        continue;
      }

      this.setManifestWorkspace(manifest, file);
    }

    manifest.lastCleanupAt = cleanupTime;
    await this.writeManifest(manifest);
    return sessionsChanged;
  }

  public async migrateLegacyWorkspaceState(
    workspaceState: vscode.Memento,
    currentWorkspaceScope: WorkspaceSessionScope
  ): Promise<boolean> {
    try {
      if (workspaceState.get<boolean>(SESSION_MIGRATION_KEY, false)) {
        return false;
      }

      const legacyState = workspaceState.get<StoredSessionState>(SESSION_STORAGE_KEY);
      if (!isRecord(legacyState) || !Array.isArray(legacyState.sessions)) {
        await workspaceState.update(SESSION_MIGRATION_KEY, true);
        return false;
      }

      const legacySessions = normalizeStoredSessions(legacyState, currentWorkspaceScope);
      const activeSessionIdsByWorkspace = normalizeStoredActiveSessionIds(legacyState, legacySessions);
      const legacyActiveSessionId = typeof legacyState.activeSessionId === 'string'
        ? legacyState.activeSessionId
        : '';
      const legacyActiveSession = legacySessions.find((session) => session.id === legacyActiveSessionId);
      if (legacyActiveSession && !activeSessionIdsByWorkspace[legacyActiveSession.workspaceKey]) {
        activeSessionIdsByWorkspace[legacyActiveSession.workspaceKey] = legacyActiveSession.id;
      }

      const sessionsByWorkspace = groupSessionsByWorkspace(legacySessions);
      for (const [workspaceKey, sessions] of sessionsByWorkspace) {
        const groupScope = getWorkspaceScopeForSessions(workspaceKey, sessions, currentWorkspaceScope);
        const existingFile = await this.readWorkspaceSessionFile(getWorkspaceHash(workspaceKey), groupScope);
        const existingSessions = existingFile?.sessions ?? [];
        const mergedSessions = mergeSessionsById(existingSessions, sessions);
        const activeSessionId = chooseActiveSessionId(
          mergedSessions,
          activeSessionIdsByWorkspace[workspaceKey],
          existingFile?.activeSessionId
        );
        const saveScope = existingFile
          ? workspaceSessionFileToScope(existingFile)
          : groupScope;
        await this.saveWorkspace(saveScope, {
          activeSessionId,
          sessions: mergedSessions
        });
      }

      await workspaceState.update(SESSION_MIGRATION_KEY, true);
      return true;
    } catch (error) {
      console.warn('KeepSeek: failed to migrate legacy chat sessions to global storage.', error);
      return false;
    }
  }

  private async readManifest(): Promise<GlobalSessionManifest> {
    const value = await this.readJsonFile(this.manifestUri, 'session manifest');
    const manifest = normalizeManifest(value);
    if (manifest) {
      return manifest;
    }

    return this.rebuildManifestFromWorkspaceFiles();
  }

  private async writeManifest(manifest: GlobalSessionManifest): Promise<void> {
    await this.writeJsonAtomic(this.manifestUri, this.rootUri, 'manifest', manifest);
  }

  private async rebuildManifestFromWorkspaceFiles(): Promise<GlobalSessionManifest> {
    const manifest: GlobalSessionManifest = {
      version: SESSION_STORAGE_VERSION,
      workspaces: {}
    };

    const hashes = await this.listWorkspaceSessionFileHashes();
    for (const hash of hashes) {
      const file = await this.readWorkspaceSessionFile(hash);
      if (file) {
        this.setManifestWorkspace(manifest, file);
      }
    }
    return manifest;
  }

  private async readWorkspaceSessionFile(
    workspaceHash: string,
    fallback?: WorkspaceMetadata
  ): Promise<WorkspaceSessionFile | undefined> {
    const uri = this.getWorkspaceSessionFileUri(workspaceHash);
    const value = await this.readJsonFile(uri, `workspace session file ${workspaceHash}`);
    if (value === undefined) {
      return undefined;
    }

    const file = normalizeWorkspaceSessionFile(value, fallback);
    if (!file) {
      console.warn(`KeepSeek: skipping invalid workspace session file ${uri.toString()}.`);
    }
    return file;
  }

  private async writeWorkspaceSessionFile(file: WorkspaceSessionFile): Promise<void> {
    await this.writeJsonAtomic(
      this.getWorkspaceSessionFileUri(getWorkspaceHash(file.workspaceKey)),
      this.workspacesUri,
      getWorkspaceHash(file.workspaceKey),
      file
    );
  }

  private async deleteWorkspaceSessionFile(workspaceHash: string): Promise<void> {
    try {
      await vscode.workspace.fs.delete(this.getWorkspaceSessionFileUri(workspaceHash), { useTrash: false });
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.warn(`KeepSeek: failed to delete expired workspace session file ${workspaceHash}.`, error);
      }
    }
  }

  private async listWorkspaceSessionFileHashes(): Promise<string[]> {
    try {
      const entries = await vscode.workspace.fs.readDirectory(this.workspacesUri);
      return entries
        .filter(([name, type]) => type === vscode.FileType.File && /^[a-f0-9]{32}\.json$/u.test(name))
        .map(([name]) => name.replace(/\.json$/u, ''));
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.warn('KeepSeek: failed to enumerate global session workspace files.', error);
      }
      return [];
    }
  }

  private setManifestWorkspace(manifest: GlobalSessionManifest, file: WorkspaceSessionFile): void {
    const workspaceHash = getWorkspaceHash(file.workspaceKey);
    manifest.workspaces[workspaceHash] = {
      workspaceKey: file.workspaceKey,
      workspaceName: file.workspaceName,
      workspaceFolders: file.workspaceFolders,
      storageFile: `${SESSION_STORAGE_WORKSPACES_DIR}/${workspaceHash}.json`,
      activeSessionId: file.activeSessionId || undefined,
      updatedAt: file.updatedAt
    };
  }

  private getWorkspaceSessionFileUri(workspaceHash: string): vscode.Uri {
    return vscode.Uri.joinPath(this.workspacesUri, `${workspaceHash}.json`);
  }

  private async readJsonFile(uri: vscode.Uri, description: string): Promise<unknown | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      return JSON.parse(this.decoder.decode(bytes));
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        console.warn(`KeepSeek: failed to read ${description}; ignoring it.`, error);
      }
      return undefined;
    }
  }

  private async writeJsonAtomic(
    uri: vscode.Uri,
    parentUri: vscode.Uri,
    tempPrefix: string,
    value: unknown
  ): Promise<void> {
    await vscode.workspace.fs.createDirectory(parentUri);
    const tempUri = vscode.Uri.joinPath(parentUri, `${tempPrefix}.${randomUUID()}.tmp`);
    try {
      await vscode.workspace.fs.writeFile(
        tempUri,
        this.encoder.encode(`${JSON.stringify(value, null, 2)}\n`)
      );
      await vscode.workspace.fs.rename(tempUri, uri, { overwrite: true });
    } catch (error) {
      try {
        await vscode.workspace.fs.delete(tempUri, { useTrash: false });
      } catch {
        // Best-effort cleanup for the temporary file used by atomic writes.
      }
      throw error;
    }
  }
}

export function getWorkspaceHash(workspaceKey: string): string {
  return createHash('sha256').update(workspaceKey).digest('hex').slice(0, 32);
}

function createWorkspaceSessionFile(
  workspaceScope: WorkspaceSessionScope,
  state: StoredWorkspaceSessionState
): WorkspaceSessionFile {
  const rawSessions = sortSessionsByUpdatedAt(
    state.sessions.filter((session) => session.workspaceKey === workspaceScope.key)
  );
  const initialActiveSessionId = chooseActiveSessionId(rawSessions, state.activeSessionId);
  const sessions = compactWorkspaceSessions(rawSessions, initialActiveSessionId);
  const activeSessionId = chooseActiveSessionId(sessions, state.activeSessionId);
  const now = new Date().toISOString();
  return {
    version: SESSION_STORAGE_VERSION,
    workspaceKey: workspaceScope.key,
    workspaceName: workspaceScope.name,
    workspaceFolders: workspaceScope.folderUris,
    activeSessionId,
    sessions,
    updatedAt: now
  };
}

function normalizeManifest(value: unknown): GlobalSessionManifest | undefined {
  if (!isRecord(value) || value.version !== SESSION_STORAGE_VERSION || !isRecord(value.workspaces)) {
    return undefined;
  }

  const workspaces: Record<string, GlobalSessionWorkspaceManifestEntry> = {};
  for (const [hash, entry] of Object.entries(value.workspaces)) {
    if (!/^[a-f0-9]{32}$/u.test(hash) || !isRecord(entry)) {
      continue;
    }

    const workspaceKey = getNonEmptyString(entry.workspaceKey);
    if (!workspaceKey) {
      continue;
    }
    const workspaceName = getNonEmptyString(entry.workspaceName) ?? workspaceKey;
    const storageFile = getNonEmptyString(entry.storageFile) ?? `${SESSION_STORAGE_WORKSPACES_DIR}/${hash}.json`;
    const updatedAt = normalizeIsoString(entry.updatedAt, new Date().toISOString());

    workspaces[hash] = {
      workspaceKey,
      workspaceName,
      workspaceFolders: getStringArray(entry.workspaceFolders),
      storageFile,
      activeSessionId: getNonEmptyString(entry.activeSessionId),
      updatedAt
    };
  }

  return {
    version: SESSION_STORAGE_VERSION,
    workspaces,
    lastCleanupAt: getNonEmptyString(value.lastCleanupAt)
  };
}

function normalizeWorkspaceSessionFile(
  value: unknown,
  fallback?: WorkspaceMetadata
): WorkspaceSessionFile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const workspaceKey = getNonEmptyString(value.workspaceKey) ?? fallback?.key;
  if (!workspaceKey) {
    return undefined;
  }

  const workspaceName = getNonEmptyString(value.workspaceName) ?? fallback?.name ?? workspaceKey;
  const workspaceFolders = Array.isArray(value.workspaceFolders)
    ? getStringArray(value.workspaceFolders)
    : fallback?.folderUris ?? [];
  const workspaceScope: WorkspaceSessionScope = {
    key: workspaceKey,
    name: workspaceName,
    folderUris: workspaceFolders
  };
  const sessions = normalizeStoredSessions(value, workspaceScope)
    .filter((session) => session.workspaceKey === workspaceKey);
  const activeSessionId = chooseActiveSessionId(
    sessions,
    getNonEmptyString(value.activeSessionId),
    fallback?.activeSessionId
  );
  const newestSession = sortSessionsByUpdatedAt(sessions)[0];
  const updatedAtFallback = newestSession?.updatedAt ?? fallback?.updatedAt ?? new Date().toISOString();

  return {
    version: SESSION_STORAGE_VERSION,
    workspaceKey,
    workspaceName,
    workspaceFolders,
    activeSessionId,
    sessions: sortSessionsByUpdatedAt(sessions),
    updatedAt: normalizeIsoString(value.updatedAt, updatedAtFallback)
  };
}

function groupSessionsByWorkspace(sessions: readonly ChatSession[]): Map<string, ChatSession[]> {
  const groups = new Map<string, ChatSession[]>();
  for (const session of sessions) {
    const group = groups.get(session.workspaceKey) ?? [];
    group.push(session);
    groups.set(session.workspaceKey, group);
  }
  return groups;
}

function getWorkspaceScopeForSessions(
  workspaceKey: string,
  sessions: readonly ChatSession[],
  currentWorkspaceScope: WorkspaceSessionScope
): WorkspaceSessionScope {
  if (workspaceKey === currentWorkspaceScope.key) {
    return currentWorkspaceScope;
  }

  const newestSession = sortSessionsByUpdatedAt([...sessions])[0];
  return {
    key: workspaceKey,
    name: newestSession?.workspaceName || workspaceKey,
    folderUris: newestSession?.workspaceFolders ?? []
  };
}

function mergeSessionsById(existingSessions: readonly ChatSession[], incomingSessions: readonly ChatSession[]): ChatSession[] {
  const sessionsById = new Map<string, ChatSession>();
  for (const session of existingSessions) {
    sessionsById.set(session.id, session);
  }

  for (const session of incomingSessions) {
    const existing = sessionsById.get(session.id);
    if (!existing || getSessionUpdatedTimestamp(session) >= getSessionUpdatedTimestamp(existing)) {
      sessionsById.set(session.id, session);
    }
  }

  return sortSessionsByUpdatedAt(Array.from(sessionsById.values()));
}

function chooseActiveSessionId(sessions: readonly ChatSession[], ...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    if (candidate && sessions.some((session) => session.id === candidate)) {
      return candidate;
    }
  }
  return sessions[0]?.id ?? '';
}

function withUpdatedSessions(
  file: WorkspaceSessionFile,
  sessions: readonly ChatSession[],
  updatedAt: string
): WorkspaceSessionFile {
  const sortedSessions = compactWorkspaceSessions(sessions, file.activeSessionId);
  return {
    ...file,
    activeSessionId: chooseActiveSessionId(sortedSessions, file.activeSessionId),
    sessions: sortedSessions,
    updatedAt
  };
}

function compactWorkspaceSessions(sessions: readonly ChatSession[], activeSessionId: string): ChatSession[] {
  return sortSessionsByUpdatedAt([...sessions]).filter((session) => {
    if (session.id === activeSessionId) {
      return true;
    }
    return session.messages.length > 0;
  });
}

function manifestEntryToMetadata(
  entry: GlobalSessionWorkspaceManifestEntry | undefined
): WorkspaceMetadata | undefined {
  if (!entry) {
    return undefined;
  }

  return {
    key: entry.workspaceKey,
    name: entry.workspaceName,
    folderUris: entry.workspaceFolders,
    activeSessionId: entry.activeSessionId,
    updatedAt: entry.updatedAt
  };
}

function workspaceSessionFileToScope(file: WorkspaceSessionFile): WorkspaceSessionScope {
  return {
    key: file.workspaceKey,
    name: file.workspaceName,
    folderUris: file.workspaceFolders
  };
}

function getNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && Boolean(item))
    : [];
}

function normalizeIsoString(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  return Number.isFinite(Date.parse(value)) ? value : fallback;
}

function isFileNotFoundError(error: unknown): boolean {
  if (!isRecord(error)) {
    return false;
  }
  return error.code === 'FileNotFound' || error.code === 'ENOENT';
}
