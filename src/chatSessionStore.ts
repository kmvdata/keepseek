import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { ChatMessage, ChatSession, ChatSessionSummary } from './types';
import { getConfiguredKeepseekLanguage, localize, type KeepseekLanguage } from './i18n';
import { isRecord } from './errors';

const SESSION_STORAGE_KEY = 'keepseek.chatSessions';
const SESSION_STORAGE_VERSION = 1;
const MAX_STORED_SESSIONS = 50;
const DEFAULT_ACTIVE_HISTORY_LIMIT = 80;

interface StoredSessionState {
  version: number;
  activeSessionId: string;
  sessions: ChatSession[];
}

export class ChatSessionStore {
  private sessions: ChatSession[] = [];
  private activeSessionIdValue = '';

  public constructor(
    private readonly sessionStorage: vscode.Memento,
    private language: KeepseekLanguage = getConfiguredKeepseekLanguage()
  ) {
    this.load();
  }

  public get activeSessionId(): string {
    return this.activeSessionIdValue;
  }

  public get messages(): ChatMessage[] {
    return this.getActiveSession().messages;
  }

  public setLanguage(language: KeepseekLanguage): void {
    this.language = language;
  }

  public getActiveSession(): ChatSession {
    const existing = this.sessions.find((session) => session.id === this.activeSessionIdValue);
    if (existing) {
      return existing;
    }

    const fallback = this.sessions[0] ?? createEmptySession(this.language);
    if (!this.sessions.length) {
      this.sessions.push(fallback);
    }
    this.activeSessionIdValue = fallback.id;
    return fallback;
  }

  public async createNewSession(language: KeepseekLanguage = this.language): Promise<ChatSession> {
    this.language = language;
    const session = createEmptySession(language);
    this.sessions.unshift(session);
    this.activeSessionIdValue = session.id;
    await this.persist();
    return session;
  }

  public async selectSession(sessionId: string): Promise<ChatSession | undefined> {
    if (sessionId === this.activeSessionIdValue) {
      return undefined;
    }

    const session = this.sessions.find((item) => item.id === sessionId);
    if (!session) {
      return undefined;
    }

    session.updatedAt = new Date().toISOString();
    this.activeSessionIdValue = session.id;
    await this.persist();
    return session;
  }

  public async persist(): Promise<void> {
    this.compact();
    await this.sessionStorage.update(SESSION_STORAGE_KEY, {
      version: SESSION_STORAGE_VERSION,
      activeSessionId: this.activeSessionIdValue,
      sessions: this.sessions
    } satisfies StoredSessionState);
  }

  public async relocalizeEmptySessionTitles(language: KeepseekLanguage): Promise<void> {
    this.language = language;
    const defaultTitles = new Set([
      localize('zh-CN', 'defaultSessionTitle'),
      localize('en', 'defaultSessionTitle')
    ]);
    let changed = false;
    for (const session of this.sessions) {
      if (!session.messages.length && defaultTitles.has(session.title)) {
        session.title = localize(language, 'defaultSessionTitle');
        changed = true;
      }
    }
    if (changed) {
      await this.persist();
    }
  }

  public getSessionSummaries(): ChatSessionSummary[] {
    return this.sessions.map((session) => ({
      id: session.id,
      title: session.title || localize(this.language, 'defaultSessionTitle'),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messages.length
    }));
  }

  public trimActiveHistory(maxMessages = DEFAULT_ACTIVE_HISTORY_LIMIT): void {
    const messages = this.messages;
    if (messages.length > maxMessages) {
      messages.splice(0, messages.length - maxMessages);
    }
  }

  private load(): void {
    const stored = this.sessionStorage.get<StoredSessionState>(SESSION_STORAGE_KEY);
    const sessions = normalizeStoredSessions(stored);
    const activeSessionId = typeof stored?.activeSessionId === 'string' ? stored.activeSessionId : '';

    this.sessions = sessions.length ? sessions : [createEmptySession(this.language)];
    this.activeSessionIdValue = this.sessions.some((session) => session.id === activeSessionId)
      ? activeSessionId
      : this.sessions[0].id;
    this.compact();
  }

  private compact(): void {
    const activeSession = this.getActiveSession();
    this.sessions = this.sessions
      .filter((session) => session.id === activeSession.id || session.messages.length > 0)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

    if (!this.sessions.some((session) => session.id === activeSession.id)) {
      this.sessions.unshift(activeSession);
    }

    if (this.sessions.length > MAX_STORED_SESSIONS) {
      const activeIndex = this.sessions.findIndex((session) => session.id === activeSession.id);
      this.sessions = this.sessions.slice(0, MAX_STORED_SESSIONS);
      if (activeIndex >= MAX_STORED_SESSIONS) {
        this.sessions[MAX_STORED_SESSIONS - 1] = activeSession;
      }
    }

    this.activeSessionIdValue = activeSession.id;
  }
}

export function createEmptySession(language: KeepseekLanguage = getConfiguredKeepseekLanguage()): ChatSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: localize(language, 'defaultSessionTitle'),
    messages: [],
    createdAt: now,
    updatedAt: now
  };
}

export function createSessionTitle(prompt: string, language: KeepseekLanguage = getConfiguredKeepseekLanguage()): string {
  const normalized = prompt.replace(/\s+/gu, ' ').trim();
  if (!normalized) {
    return localize(language, 'defaultSessionTitle');
  }
  return normalized.length > 48 ? `${normalized.slice(0, 48)}...` : normalized;
}

export function getVisibleMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(({ expandedContent: _expandedContent, ...message }) => message);
}

function normalizeStoredSessions(value: unknown): ChatSession[] {
  if (!isRecord(value) || !Array.isArray(value.sessions)) {
    return [];
  }

  const language = getConfiguredKeepseekLanguage();
  const sessions: ChatSession[] = [];
  const seen = new Set<string>();

  for (const item of value.sessions) {
    if (!isRecord(item) || typeof item.id !== 'string' || seen.has(item.id)) {
      continue;
    }

    const messages = Array.isArray(item.messages)
      ? item.messages.map(normalizeStoredMessage).filter((message): message is ChatMessage => Boolean(message))
      : [];
    const createdAt = typeof item.createdAt === 'string' ? item.createdAt : new Date().toISOString();
    const updatedAt = typeof item.updatedAt === 'string' ? item.updatedAt : createdAt;
    const title = typeof item.title === 'string' && item.title.trim()
      ? item.title.trim()
      : createTitleFromMessages(messages, language);

    sessions.push({
      id: item.id,
      title,
      messages,
      createdAt,
      updatedAt
    });
    seen.add(item.id);
  }

  return sessions;
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
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date().toISOString(),
    modelId: typeof value.modelId === 'string' ? value.modelId : undefined,
    reasoningContent: typeof value.reasoningContent === 'string' ? value.reasoningContent : undefined
  };
}

function createTitleFromMessages(messages: ChatMessage[], language: KeepseekLanguage = getConfiguredKeepseekLanguage()): string {
  const firstUserMessage = messages.find((message) => message.role === 'user');
  return firstUserMessage ? createSessionTitle(firstUserMessage.content, language) : localize(language, 'defaultSessionTitle');
}
