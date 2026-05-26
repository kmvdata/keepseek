import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ChatMessage, ChatSession, ChatSessionSummary, WorkspaceSummary } from './types';
import { getConfiguredKeepseekLanguage, localize, type KeepseekLanguage } from './i18n';
import { isRecord } from './errors';

export const SESSION_STORAGE_KEY = 'keepseek.chatSessions';
export const SESSION_STORAGE_VERSION = 2;
const MAX_STORED_SESSIONS = 50;
const DEFAULT_ACTIVE_HISTORY_LIMIT = 80;

export interface StoredSessionState {
  version: number;
  activeSessionId: string;
  activeSessionIdsByWorkspace?: Record<string, string>;
  sessions: ChatSession[];
}

export interface StoredWorkspaceSessionState {
  activeSessionId: string;
  sessions: ChatSession[];
}

export interface ChatSessionStorageAdapter {
  loadWorkspace(workspaceScope: WorkspaceSessionScope): Promise<StoredWorkspaceSessionState>;
  saveWorkspace(workspaceScope: WorkspaceSessionScope, state: StoredWorkspaceSessionState): Promise<void>;
  listAllWorkspaceSummaries(): Promise<WorkspaceSummary[]>;
  loadWorkspaceSessions(workspaceKey: string): Promise<ChatSession[]>;
  deleteWorkspaceSessions(workspaceKey: string, sessionIds: string[]): Promise<void>;
  deleteEntireWorkspace(workspaceKey: string): Promise<void>;
  cleanupExpiredSessions(options: {
    currentWorkspaceKey: string;
    currentActiveSessionId: string;
    now?: number;
  }): Promise<boolean>;
}

export interface WorkspaceSessionScope {
  key: string;
  name: string;
  folderUris: string[];
}

export interface DeleteSessionsResult {
  deletedCount: number;
  activeSessionChanged: boolean;
}

export class ChatSessionStore {
  private sessions: ChatSession[] = [];
  private activeSessionIdValue = '';

  public constructor(
    private readonly sessionStorage: ChatSessionStorageAdapter,
    private language: KeepseekLanguage = getConfiguredKeepseekLanguage(),
    private workspaceScope: WorkspaceSessionScope = getCurrentWorkspaceSessionScope()
  ) {}

  public async initialize(): Promise<void> {
    await this.load();
  }

  public get activeSessionId(): string {
    return this.activeSessionIdValue;
  }

  public get workspaceKey(): string {
    return this.workspaceScope.key;
  }

  public get messages(): ChatMessage[] {
    return this.getActiveSession().messages;
  }

  public setLanguage(language: KeepseekLanguage): void {
    this.language = language;
  }

  public async setWorkspaceScope(workspaceScope: WorkspaceSessionScope): Promise<boolean> {
    if (workspaceScope.key === this.workspaceScope.key) {
      return false;
    }

    this.workspaceScope = workspaceScope;
    await this.load();
    return true;
  }

  public getActiveSession(): ChatSession {
    return this.ensureActiveSession();
  }

  public async createNewSession(language: KeepseekLanguage = this.language): Promise<ChatSession> {
    this.language = language;
    const session = createEmptySession(language, this.workspaceScope);
    this.sessions.unshift(session);
    this.setActiveSessionId(session.id);
    await this.persist();
    return session;
  }

  public async selectSession(sessionId: string): Promise<ChatSession | undefined> {
    if (sessionId === this.activeSessionIdValue) {
      return undefined;
    }

    const session = this.sessions.find((item) => item.id === sessionId && this.isInCurrentWorkspace(item));
    if (!session) {
      return undefined;
    }

    this.setActiveSessionId(session.id);
    await this.persist();
    return session;
  }

  public async toggleSessionFavorite(sessionId: string): Promise<ChatSession | undefined> {
    const session = this.sessions.find((item) => item.id === sessionId && this.isInCurrentWorkspace(item));
    if (!session) {
      return undefined;
    }

    session.isFavorite = !session.isFavorite;
    await this.persist();
    return session;
  }

  public async renameSession(sessionId: string, title: string): Promise<ChatSession | undefined> {
    const session = this.sessions.find((item) => item.id === sessionId && this.isInCurrentWorkspace(item));
    if (!session) {
      return undefined;
    }

    const normalizedTitle = title.replace(/\s+/gu, ' ').trim();
    if (!normalizedTitle) {
      return undefined;
    }

    session.title = normalizedTitle;
    session.customTitle = normalizedTitle;
    session.updatedAt = new Date().toISOString();
    await this.persist();
    return session;
  }

  public async deleteSessions(sessionIds: string[]): Promise<DeleteSessionsResult> {
    const ids = new Set(sessionIds.filter((id) => typeof id === 'string' && id.trim()));
    if (!ids.size) {
      return { deletedCount: 0, activeSessionChanged: false };
    }

    const previousActiveSessionId = this.activeSessionIdValue;
    let deletedCount = 0;
    this.sessions = this.sessions.filter((session) => {
      if (!this.isInCurrentWorkspace(session) || !ids.has(session.id)) {
        return true;
      }
      deletedCount += 1;
      return false;
    });

    this.ensureActiveSession();
    this.compact();
    await this.persist();
    return {
      deletedCount,
      activeSessionChanged: previousActiveSessionId !== this.activeSessionIdValue
    };
  }

  public async cleanupExpiredSessions(now = Date.now()): Promise<boolean> {
    const changed = await this.sessionStorage.cleanupExpiredSessions({
      currentWorkspaceKey: this.workspaceScope.key,
      currentActiveSessionId: this.activeSessionIdValue,
      now
    });
    if (changed) {
      await this.load();
    }
    return changed;
  }

  public async persist(): Promise<void> {
    this.compact();
    await this.sessionStorage.saveWorkspace(this.workspaceScope, {
      activeSessionId: this.activeSessionIdValue,
      sessions: this.sessions
    });
  }

  public async relocalizeEmptySessionTitles(language: KeepseekLanguage): Promise<void> {
    this.language = language;
    const defaultTitles = new Set([
      localize('zh-CN', 'defaultSessionTitle'),
      localize('en', 'defaultSessionTitle')
    ]);
    let changed = false;
    for (const session of this.sessions) {
      if (!session.customTitle && !session.messages.length && defaultTitles.has(session.title)) {
        session.title = localize(language, 'defaultSessionTitle');
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  public getSessionSummaries(): ChatSessionSummary[] {
    return this.getCurrentWorkspaceSessions().map((session) => toSessionSummary(session, this.language));
  }

  public async getAllWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
    return this.sessionStorage.listAllWorkspaceSummaries();
  }

  public async getOtherWorkspaceSessionSummaries(workspaceKey: string): Promise<ChatSessionSummary[]> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.workspaceScope.key) {
      return [];
    }

    const sessions = await this.sessionStorage.loadWorkspaceSessions(normalizedWorkspaceKey);
    return sessions.map((session) => toSessionSummary(session, this.language));
  }

  public async deleteOtherWorkspaceSessions(workspaceKey: string, sessionIds: string[]): Promise<number> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.workspaceScope.key) {
      return 0;
    }

    const ids = new Set(sessionIds.filter((sessionId) => typeof sessionId === 'string' && sessionId.trim()));
    if (!ids.size) {
      return 0;
    }

    const sessions = await this.sessionStorage.loadWorkspaceSessions(normalizedWorkspaceKey);
    const deletedCount = sessions.filter((session) => ids.has(session.id)).length;
    if (!deletedCount) {
      return 0;
    }

    await this.sessionStorage.deleteWorkspaceSessions(normalizedWorkspaceKey, Array.from(ids));
    return deletedCount;
  }

  public async deleteOtherWorkspace(workspaceKey: string): Promise<void> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.workspaceScope.key) {
      return;
    }

    await this.sessionStorage.deleteEntireWorkspace(normalizedWorkspaceKey);
  }

  public trimActiveHistory(maxMessages = DEFAULT_ACTIVE_HISTORY_LIMIT): void {
    const messages = this.messages;
    if (messages.length > maxMessages) {
      messages.splice(0, messages.length - maxMessages);
    }
  }

  private async load(): Promise<void> {
    const stored = await this.sessionStorage.loadWorkspace(this.workspaceScope);
    const sessions = normalizeStoredSessions({ sessions: stored.sessions }, this.workspaceScope);

    this.sessions = sessions.filter((session) => this.isInCurrentWorkspace(session));
    this.activeSessionIdValue = typeof stored.activeSessionId === 'string' ? stored.activeSessionId : '';
    this.ensureActiveSession();
    this.compact();
  }

  private ensureActiveSession(): ChatSession {
    const currentSessions = this.getCurrentWorkspaceSessions();
    const existing = currentSessions.find((session) => session.id === this.activeSessionIdValue);
    if (existing) {
      this.setActiveSessionId(existing.id);
      return existing;
    }

    const fallback = currentSessions[0] ?? createEmptySession(this.language, this.workspaceScope);
    if (!currentSessions.length) {
      this.sessions.unshift(fallback);
    }
    this.setActiveSessionId(fallback.id);
    return fallback;
  }

  private compact(): void {
    const activeSession = this.ensureActiveSession();
    const sessionsByWorkspace = new Map<string, ChatSession[]>();
    for (const session of this.sessions) {
      if (!session.workspaceKey) {
        session.workspaceKey = this.workspaceScope.key;
        session.workspaceName = this.workspaceScope.name;
        session.workspaceFolders = this.workspaceScope.folderUris;
      }

      const isActive = session.id === activeSession.id;
      if (!isActive && !session.messages.length) {
        continue;
      }

      const sessions = sessionsByWorkspace.get(session.workspaceKey) ?? [];
      sessions.push(session);
      sessionsByWorkspace.set(session.workspaceKey, sessions);
    }

    const compacted: ChatSession[] = [];
    for (const sessions of sessionsByWorkspace.values()) {
      const sorted = sortSessionsByUpdatedAt(sessions);
      let storedNonFavoriteContentSessions = 0;
      for (const session of sorted) {
        const isActive = session.id === activeSession.id;
        if (isActive || session.isFavorite) {
          compacted.push(session);
          continue;
        }

        if (session.messages.length && storedNonFavoriteContentSessions < MAX_STORED_SESSIONS) {
          compacted.push(session);
          storedNonFavoriteContentSessions += 1;
        }
      }
    }

    this.sessions = sortSessionsByUpdatedAt(compacted);
    this.setActiveSessionId(activeSession.id);
  }

  private getCurrentWorkspaceSessions(): ChatSession[] {
    return sortSessionsByUpdatedAt(this.sessions.filter((session) => this.isInCurrentWorkspace(session)));
  }

  private isInCurrentWorkspace(session: ChatSession): boolean {
    return session.workspaceKey === this.workspaceScope.key;
  }

  private setActiveSessionId(sessionId: string): void {
    this.activeSessionIdValue = sessionId;
  }
}

export function createEmptySession(
  language: KeepseekLanguage = getConfiguredKeepseekLanguage(),
  workspaceScope: WorkspaceSessionScope = getCurrentWorkspaceSessionScope()
): ChatSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: localize(language, 'defaultSessionTitle'),
    messages: [],
    createdAt: now,
    updatedAt: now,
    workspaceKey: workspaceScope.key,
    workspaceName: workspaceScope.name,
    workspaceFolders: workspaceScope.folderUris,
    isFavorite: false
  };
}

export function createSessionTitle(prompt: string, language: KeepseekLanguage = getConfiguredKeepseekLanguage()): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return localize(language, 'defaultSessionTitle');
  }
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

function toSessionSummary(session: ChatSession, language: KeepseekLanguage): ChatSessionSummary {
  return {
    id: session.id,
    title: session.title || localize(language, 'defaultSessionTitle'),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: session.messages.length,
    workspaceKey: session.workspaceKey,
    workspaceName: session.workspaceName,
    isFavorite: Boolean(session.isFavorite),
    customTitle: session.customTitle
  };
}

export function getVisibleMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(({ expandedContent: _expandedContent, ...message }) => message);
}

export function getCurrentWorkspaceSessionScope(): WorkspaceSessionScope {
  const workspaceFolders = vscode.workspace.workspaceFolders ?? [];
  const folderUris = workspaceFolders.map((folder) => folder.uri.toString());
  if (vscode.workspace.workspaceFile) {
    return {
      key: `workspace:${vscode.workspace.workspaceFile.toString()}`,
      name: vscode.workspace.name || getUriLabel(vscode.workspace.workspaceFile),
      folderUris
    };
  }

  if (workspaceFolders.length) {
    return {
      key: `folders:${[...folderUris].sort().join('|')}`,
      name: vscode.workspace.name || workspaceFolders.map((folder) => folder.name).join(', '),
      folderUris
    };
  }

  return {
    key: 'no-workspace',
    name: vscode.workspace.name || 'No workspace',
    folderUris: []
  };
}

export function normalizeStoredSessions(value: unknown, workspaceScope: WorkspaceSessionScope): ChatSession[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    return [];
  }

  const language = getConfiguredKeepseekLanguage();
  const sessions: ChatSession[] = [];
  const seen = new Set<string>();
  const now = new Date().toISOString();

  for (const item of value.sessions) {
    if (!isRecord(item) || typeof item.id !== 'string' || seen.has(item.id)) {
      continue;
    }

    const messages = Array.isArray(item.messages)
      ? item.messages.map(normalizeStoredMessage).filter((message): message is ChatMessage => Boolean(message))
      : [];
    const createdAt = normalizeSessionTimestamp(item.createdAt, now);
    const updatedAt = normalizeSessionTimestamp(item.updatedAt, createdAt);
    const customTitle = typeof item.customTitle === 'string' && item.customTitle.trim()
      ? item.customTitle.trim()
      : undefined;
    const title = customTitle
      ?? (typeof item.title === 'string' && item.title.trim()
        ? item.title.trim()
        : createTitleFromMessages(messages, language));
    const workspaceKey = typeof item.workspaceKey === 'string' && item.workspaceKey.trim()
      ? item.workspaceKey.trim()
      : workspaceScope.key;
    const workspaceName = typeof item.workspaceName === 'string' && item.workspaceName.trim()
      ? item.workspaceName.trim()
      : workspaceScope.name;
    const workspaceFolders = Array.isArray(item.workspaceFolders)
      ? item.workspaceFolders.filter((folder): folder is string => typeof folder === 'string' && Boolean(folder))
      : workspaceScope.folderUris;

    sessions.push({
      id: item.id,
      title,
      messages,
      createdAt,
      updatedAt,
      workspaceKey,
      workspaceName,
      workspaceFolders,
      isFavorite: item.isFavorite === true,
      customTitle
    });
    seen.add(item.id);
  }

  return sortSessionsByUpdatedAt(sessions);
}

export function normalizeStoredActiveSessionIds(value: unknown, sessions: ChatSession[]): Record<string, string> {
  const activeSessionIdsByWorkspace: Record<string, string> = {};
  if (isRecord(value) && isRecord(value.activeSessionIdsByWorkspace)) {
    for (const [workspaceKey, sessionId] of Object.entries(value.activeSessionIdsByWorkspace)) {
      if (typeof sessionId === 'string' && sessions.some((session) => session.id === sessionId)) {
        activeSessionIdsByWorkspace[workspaceKey] = sessionId;
      }
    }
  }
  return activeSessionIdsByWorkspace;
}

function normalizeStoredMessage(value: unknown): ChatMessage | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.content !== 'string') {
    return undefined;
  }

  const role = value.role === 'user' || value.role === 'assistant' || value.role === 'system'
    ? value.role
    : undefined;
  if (!role) {
    return undefined;
  }

  return {
    id: value.id,
    role,
    content: value.content,
    expandedContent: typeof value.expandedContent === 'string' ? value.expandedContent : undefined,
    createdAt: normalizeSessionTimestamp(value.createdAt, new Date().toISOString()),
    modelId: typeof value.modelId === 'string' ? value.modelId : undefined,
    reasoningContent: typeof value.reasoningContent === 'string' ? value.reasoningContent : undefined
  };
}

function createTitleFromMessages(messages: ChatMessage[], language: KeepseekLanguage = getConfiguredKeepseekLanguage()): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  return firstUserMessage ? createSessionTitle(firstUserMessage.content, language) : localize(language, 'defaultSessionTitle');
}

export function sortSessionsByUpdatedAt(sessions: ChatSession[]): ChatSession[] {
  return [...sessions].sort((a, b) => getSessionUpdatedTimestamp(b) - getSessionUpdatedTimestamp(a));
}

export function getSessionUpdatedTimestamp(session: ChatSession): number {
  const updatedAt = Date.parse(session.updatedAt);
  if (Number.isFinite(updatedAt)) {
    return updatedAt;
  }

  const createdAt = Date.parse(session.createdAt);
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function normalizeSessionTimestamp(value: unknown, fallback: string): string {
  if (typeof value !== 'string') {
    return fallback;
  }
  return Number.isFinite(Date.parse(value)) ? value : fallback;
}

function getUriLabel(uri: vscode.Uri): string {
  const path = uri.fsPath || uri.path;
  const normalized = path.replace(/[\\/]+$/u, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index >= 0 ? normalized.slice(index + 1) : normalized || uri.toString();
}
