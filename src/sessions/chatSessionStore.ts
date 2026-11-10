import { normalizeProviderReplay } from './providerReplayNormalization';
import { normalizePendingHistoryTruncation } from './historyTruncation';
import { normalizeManualApproval } from '../approvals/manualApproval';
import { normalizeUserTaskBudgets } from './userTaskBudget';
import { normalizeApprovalProcessing } from '../approvals/approvalProcessing';
import { normalizeUserTask } from './userTask';
import { reconcileExecutionTime } from './executionTimeStats';
import { normalizeRequestBudget } from '../agent/requestBudget';
import { normalizeRunDetailsDelegation } from '../agent/logging/subagentDetails';
import { isResumableToolBudgetCheckpoint, normalizeRunCheckpoint, recoveryBlocker } from '../agent/runCheckpoint';
import { normalizeHistoryWorkFacts } from '../agent/historyProtection';
import { snapshotSession } from './persistenceSnapshot';
import { recordLocalPerformance } from '../agent/logging/performanceTrace';
import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  AgentToolCall,
  AgentToolResult,
  AgentToolRound,
  ChatMessage,
  ChatMessageContextMeta,
  ChatSession,
  ChatSessionSummary,
  ContextCompressionState,
  HistorySummary,
  HistoryArchiveEntry,
  type ApprovalMode,
  RepairLoopState,
  SessionRequestProtocol,
  WorkspaceSummary,
  type ExecutionMode
} from '../shared/types';
import { normalizeExecutionMode, normalizePlanWorkflowRecords } from '../agent/executionMode';
import {
  CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION,
  CURRENT_PROVIDER_TOOL_SCHEMA_VERSION,
  PROVIDER_PROJECTION_REQUEST_PROTOCOL_VERSION
} from '../agent/providerRequestProjection';
import { getConfiguredKeepseekLanguage, localize, type KeepseekLanguage } from '../shared/i18n';
import { isRecord } from '../shared/errors';
import { normalizeContextUsageEstimateValue } from '../agent/contextUsage';
import { normalizeSubagentSessionUsageStatsValue } from '../agent/subagentUsageStats';
import {
  normalizeBalanceStateValue,
  normalizePromptCacheDiagnosticsValue,
  normalizeSessionUsageStatsValue,
  normalizeTurnUsageStatsValue
} from '../agent/usageStats';
import { normalizeUsageLedgerValue } from '../agent/usageLedger';
import { cloneSessionTitleMetadata, lockSessionTitleMetadata, normalizeSessionTitle, recordSessionTitleAttempt, sessionTitleTaskWasAttempted, sessionTitleTaskBasisMatches,
  type SessionTitleBasis, type SessionTitleMetadata } from './sessionTitle';

export const SESSION_STORAGE_KEY = 'keepseek.chatSessions';
export const SESSION_STORAGE_VERSION = 2;
const MAX_STORED_SESSIONS = 50;
export interface StoredSessionState {
  version: number;
  activeSessionId: string;
  activeSessionIdsByWorkspace?: Record<string, string>;
  sessions: ChatSession[];
}

export interface StoredWorkspaceSessionState {
  activeSessionId: string;
  approvalMode?: ApprovalMode;
  sessions: ChatSession[];
  /** Small index records. Sharded adapters return these without loading message bodies. */
  sessionSummaries?: ChatSessionSummary[];
}

export interface ChatSessionStorageAdapter {
  /** Cleanup and every execution admission share the persistent deletion authority. */
  isSessionDeleted?(workspaceKey: string, sessionId: string): Promise<boolean>;
  assertSessionWritable?(workspaceKey: string, sessionId: string): Promise<void>;
  acquireSessionUse?(workspaceKey: string, sessionId: string): Promise<{ release(): Promise<void> }>;
  loadMessageCheckpoint?(workspaceKey: string, sessionId: string, messageId: string): Promise<unknown>;
  loadWorkspace(workspaceScope: WorkspaceSessionScope): Promise<StoredWorkspaceSessionState>;
  saveWorkspace(workspaceScope: WorkspaceSessionScope, state: StoredWorkspaceSessionState): Promise<void>;
  listAllWorkspaceSummaries(): Promise<WorkspaceSummary[]>;
  loadWorkspaceSessions(workspaceKey: string): Promise<ChatSession[]>;
  loadSession?(workspaceKey: string, sessionId: string): Promise<ChatSession | undefined>;
  listWorkspaceSessionSummaries?(workspaceKey: string): Promise<ChatSessionSummary[]>;
  deleteWorkspaceSessions(workspaceKey: string, sessionIds: string[]): Promise<void>;
  deleteEntireWorkspace(workspaceKey: string): Promise<void>;
  cleanupExpiredSessions(options: {
    currentWorkspaceKey: string;
    currentActiveSessionId: string;
    protectedSessionIds?: readonly string[];
    now?: number;
    force?: boolean;
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

interface StagedSessionTitle {
  token: string;
  revision: number;
  title: string;
  metadata: SessionTitleMetadata;
  clearCustomTitle?: boolean;
}

export class ChatSessionStore {
  private sessions: ChatSession[] = [];
  private sessionSummaries = new Map<string, ChatSessionSummary>();
  private activeSessionIdValue = '';
  private approvalModeValue: ApprovalMode = 'ask';
  private readonly stagedTitles = new Map<string, StagedSessionTitle>();
  private readonly titleSessionPins = new Map<string, number>();
  private readonly deletedSessionKeys = new Set<string>();

  /** Loaded sessions only: background naming must never load an entire old history. */
  public getSessionById(sessionId: string): ChatSession | undefined {
    if (this.deletedSessionKeys.has(this.sessionIdentity(sessionId))) return undefined;
    return this.sessions.find(session => session.id === sessionId && this.isInCurrentWorkspace(session));
  }

  /** Call at a user action boundary; a stale idle window must not reuse deleted
   * proposals, approvals or a conversation removed by another process. */
  public async assertSessionWritable(sessionId = this.activeSessionIdValue): Promise<void> {
    const workspaceKey = this.workspaceScope.key;
    if (this.deletedSessionKeys.has(this.sessionIdentity(sessionId))) throw new Error('session_deleted');
    if (this.sessionStorage.assertSessionWritable) {
      await this.sessionStorage.assertSessionWritable(workspaceKey, sessionId);
    } else if (await this.sessionStorage.isSessionDeleted?.(workspaceKey, sessionId)) {
      throw new Error('session_deleted');
    }
    if (workspaceKey !== this.workspaceScope.key) throw new Error('session_workspace_changed');
  }

  /** Acquisition checks deletion and registers use under the same storage gate.
   * The caller keeps the handle until queued work and its final save settle. */
  public async acquireSessionUse(sessionId = this.activeSessionIdValue): Promise<{ release(): Promise<void> }> {
    const workspaceKey = this.workspaceScope.key;
    if (this.deletedSessionKeys.has(this.sessionIdentity(sessionId))) throw new Error('session_deleted');
    if (this.sessionStorage.acquireSessionUse) {
      const use = await this.sessionStorage.acquireSessionUse(workspaceKey, sessionId);
      if (workspaceKey !== this.workspaceScope.key) {
        await use.release();
        throw new Error('session_workspace_changed');
      }
      return use;
    }
    await this.assertSessionWritable(sessionId);
    return { release: async () => {} };
  }

  private sessionIdentity(sessionId: string): string {
    return JSON.stringify([this.workspaceScope.key, sessionId]);
  }

  /** Keep only sessions with observed title work resident; never hydrate here. */
  public pinSessionForTitle(sessionId: string): () => void {
    const key = JSON.stringify([this.workspaceScope.key, sessionId]);
    this.titleSessionPins.set(key, (this.titleSessionPins.get(key) ?? 0) + 1);
    return () => {
      const remaining = (this.titleSessionPins.get(key) ?? 1) - 1;
      if (remaining > 0) this.titleSessionPins.set(key, remaining);
      else this.titleSessionPins.delete(key);
    };
  }

  /** Explicit history-row requests load only that session and keep it resident
   * through commit/notification, without changing the active conversation. */
  public async withSessionForTitle<T>(sessionId: string, action: (session: ChatSession) => Promise<T>): Promise<T | undefined> {
    const workspaceKey = this.workspaceScope.key;
    const release = this.pinSessionForTitle(sessionId);
    try {
      // Resident targets accept and freeze material in this same turn.
      const session = this.getSessionById(sessionId) ?? await this.loadSessionById(sessionId);
      if (!session || this.workspaceScope.key !== workspaceKey || this.getSessionById(sessionId) !== session) return undefined;
      return await action(session);
    } finally { release(); }
  }

  /** Destructive edits and explicit title intent retire only the current claim.
   * Ordinary appends and navigation must not call this method. */
  public invalidateSessionTitle(sessionId: string): void {
    const session = this.getSessionById(sessionId);
    if (!session) return;
    const state = normalizeSessionTitle(session.autoTitle, session.customTitle, { preserveRunning: true });
    this.stagedTitles.delete(sessionId);
    if (state.status !== 'running' && !state.manualAttempt) return;
    session.autoTitle = { ...state, status: state.status === 'running' ? 'pending' : state.status,
      revision: state.status === 'running' ? state.revision + 1 : state.revision,
      manualAttempt: undefined, attempt: undefined,
      lastOutcome: state.manualAttempt ? state.lastOutcome : 'stale' };
    // A completed candidate may already be in an adapter write. Queue its
    // invalidation behind that write even when no subsequent user turn saves.
    void this.persist('session_title_invalidated').catch(() => { /* next normal barrier / load normalization */ });
  }

  public async claimSessionTitle(sessionId: string, taskId: string, basis: SessionTitleBasis,
    mode: 'automatic' | 'manual' = 'automatic', orderedObservedPrefix = false): Promise<{
    token: string; revision: number;
  } | undefined> {
    const session = this.getSessionById(sessionId);
    if (!session || (session.customTitle && mode === 'automatic') || session.pendingHistoryTruncation
      && basis.messages.some(ref => !session.pendingHistoryTruncation!.retainedMessageIds.includes(ref.id))) return undefined;
    const state = normalizeSessionTitle(session.autoTitle, session.customTitle, { preserveRunning: true });
    if (state.manualAttempt || state.status === 'running'
      || (mode === 'automatic' && (state.stopped || state.status !== 'pending' || sessionTitleTaskWasAttempted(state, session.messages, taskId)))
      || !sessionTitleTaskBasisMatches(session.messages, taskId, basis)) return undefined;
    const token = randomUUID();
    // A manual claim keeps the committed revision intact. Its token provides
    // isolation; only a successful new title advances the revision. Otherwise a
    // failed claim-index write could invalidate the previously committed title.
    const revision = mode === 'manual' ? state.revision : state.revision + 1;
    const consumed = recordSessionTitleAttempt(state, session.messages, taskId, mode, orderedObservedPrefix);
    session.autoTitle = mode === 'manual'
      ? { ...state, revision, ...consumed, lastAttemptTaskId: taskId, manualAttempt: { token, taskId, basis } }
      : { ...state, status: 'running', revision, ...consumed, lastAttemptTaskId: taskId,
        attempt: { token, taskId, basis }, completed: undefined };
    try { await this.persist('session_title_claim'); }
    catch (error) {
      if (session.autoTitle?.manualAttempt?.token === token) session.autoTitle = {
        ...session.autoTitle, manualAttempt: undefined };
      else if (session.autoTitle?.attempt?.token === token) session.autoTitle = {
        ...session.autoTitle, status: 'pending', attempt: undefined, lastOutcome: 'save_failed' };
      throw error;
    }
    if (this.matchesTitleAttempt(sessionId, token, revision)) return { token, revision };
    if (session.autoTitle?.attempt?.token === token || session.autoTitle?.manualAttempt?.token === token) {
      this.invalidateSessionTitle(sessionId);
    }
    return undefined;
  }

  /** Only a committed candidate is exposed to memory/UI. Retries save the same candidate. */
  public async finishSessionTitle(sessionId: string, token: string, result: {
    title?: string; outcome: SessionTitleMetadata['lastOutcome'];
  }): Promise<boolean> {
    return await this.finishSessionTitleResult(sessionId, token, result) === 'committed';
  }

  /** A valid no-title decision and a stale candidate both used to return false.
   * Keep their durable outcomes distinct for explicit user actions. */
  public async finishSessionTitleResult(sessionId: string, token: string, result: {
    title?: string; outcome: SessionTitleMetadata['lastOutcome'];
  }): Promise<'committed' | 'recorded' | 'stale' | 'save_failed'> {
    if (this.deletedSessionKeys.has(this.sessionIdentity(sessionId))
      || await this.sessionStorage.isSessionDeleted?.(this.workspaceScope.key, sessionId)) return 'stale';
    const session = this.getSessionById(sessionId);
    const manual = session?.autoTitle?.manualAttempt?.token === token;
    const attempt = manual ? session?.autoTitle?.manualAttempt : session?.autoTitle?.attempt;
    if (!session || !attempt || !this.matchesTitleAttempt(sessionId, token, session.autoTitle!.revision)) return 'stale';
    if (!result.title) {
      const settled = session.autoTitle = manual ? { ...session.autoTitle!, manualAttempt: undefined, lastOutcome: result.outcome }
        : { ...session.autoTitle!, status: 'pending', attempt: undefined, lastOutcome: result.outcome };
      try { await this.persist('session_title_result'); }
      catch {
        if (session.autoTitle === settled) session.autoTitle = { ...settled, lastOutcome: 'save_failed' };
        return 'save_failed';
      }
      return this.getSessionById(sessionId) === session && session.autoTitle === settled ? 'recorded' : 'stale';
    }
    const revision = session.autoTitle!.revision;
    const prior = session.autoTitle!;
    const priorMetadata = { version: prior.version, status: prior.status, stopped: prior.stopped, revision: prior.revision,
      lastAttemptTaskId: prior.lastAttemptTaskId, attemptedTaskIds: prior.attemptedTaskIds, attemptedThrough: prior.attemptedThrough, lastOutcome: prior.lastOutcome, completed: prior.completed };
    const candidate = { token, revision, title: result.title, clearCustomTitle: manual, metadata: {
      ...session.autoTitle!, version: 2 as const, status: 'completed' as const, stopped: 'named' as const, attempt: undefined, manualAttempt: undefined,
      revision: manual ? revision + 1 : revision,
      completed: { taskId: attempt.taskId, basis: attempt.basis }, lastOutcome: result.outcome,
      regenerationPrevious: manual ? { title: session.title, customTitle: session.customTitle, metadata: priorMetadata } : undefined
    } };
    for (let save = 0; save < 2; save += 1) {
      if (!this.matchesTitleAttempt(sessionId, token, revision)) return 'stale';
      this.stagedTitles.set(sessionId, candidate);
      try {
        await this.persist('session_title_commit');
        return this.getSessionById(sessionId)?.autoTitle === candidate.metadata ? 'committed' : 'stale';
      } catch {
        if (this.stagedTitles.get(sessionId) === candidate) this.stagedTitles.delete(sessionId);
      }
    }
    if (!this.matchesTitleAttempt(sessionId, token, revision)) return 'stale';
    session.autoTitle = manual
      ? { ...session.autoTitle!, manualAttempt: undefined, lastOutcome: 'save_failed' }
      : { ...session.autoTitle!, status: 'pending', attempt: undefined, lastOutcome: 'save_failed' };
    return 'save_failed';
  }

  private matchesTitleAttempt(sessionId: string, token: string, revision: number): boolean {
    const session = this.getSessionById(sessionId);
    const manual = session?.autoTitle?.manualAttempt?.token === token;
    const attempt = manual ? session?.autoTitle?.manualAttempt : session?.autoTitle?.attempt;
    return !!session && !!attempt && (manual || !session.customTitle) && (!session.pendingHistoryTruncation || attempt.basis.messages.every(ref =>
        session.pendingHistoryTruncation!.retainedMessageIds.includes(ref.id)))
      && (manual || session.autoTitle?.status === 'running') && session.autoTitle?.revision === revision
      && attempt.token === token && sessionTitleTaskBasisMatches(session.messages, attempt.taskId, attempt.basis);
  }

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

  public get approvalMode(): ApprovalMode {
    return this.approvalModeValue;
  }

  public get executionMode(): ExecutionMode {
    return normalizeExecutionMode(this.getActiveSession().executionMode);
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

  public async createNewSession(language: KeepseekLanguage = this.language, onSaving?: (sessionId: string) => void): Promise<ChatSession> {
    this.language = language;
    const session = createEmptySession(language, this.workspaceScope, this.approvalModeValue, 'normal');
    this.sessions.unshift(session);
    this.setActiveSessionId(session.id);
    onSaving?.(session.id);
    await this.persist();
    return session;
  }

  public async setApprovalMode(approvalMode: ApprovalMode): Promise<boolean> {
    if (approvalMode !== 'ask' && approvalMode !== 'delegate') return false;
    const session = this.getActiveSession();
    if (this.approvalModeValue === approvalMode && session.approvalMode === approvalMode) {
      return false;
    }

    this.approvalModeValue = approvalMode;
    session.approvalMode = approvalMode;
    session.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  public async setExecutionMode(executionMode: ExecutionMode): Promise<boolean> {
    const session = this.getActiveSession();
    const normalized = normalizeExecutionMode(executionMode);
    if (normalizeExecutionMode(session.executionMode) === normalized) return false;
    session.executionMode = normalized;
    session.updatedAt = new Date().toISOString();
    await this.persist();
    return true;
  }

  public async selectSession(sessionId: string, onSaving?: (sessionId: string) => void): Promise<ChatSession | undefined> {
    const session = await measureSessionSelection('session-body', sessionId, () => this.loadSessionById(sessionId));
    if (!session) {
      return undefined;
    }

    session.updatedAt = new Date().toISOString();
    session.approvalMode = this.approvalModeValue;
    session.executionMode = normalizeExecutionMode(session.executionMode);
    this.setActiveSessionId(session.id);
    onSaving?.(session.id);
    await measureSessionSelection('active-selection-save', session.id, () => this.persist());
    return session;
  }

  public async copyOtherWorkspaceSession(workspaceKey: string, sessionId: string): Promise<ChatSession | undefined> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    const normalizedSessionId = sessionId.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.workspaceScope.key || !normalizedSessionId) {
      return undefined;
    }

    const source = this.sessionStorage.loadSession
      ? await this.sessionStorage.loadSession(normalizedWorkspaceKey, normalizedSessionId)
      : (await this.sessionStorage.loadWorkspaceSessions(normalizedWorkspaceKey))
        .find((session) => session.id === normalizedSessionId);
    if (!source) {
      return undefined;
    }
    // The source intent owns independent operation-store commits in its original
    // workspace. Copying either side before recovery can expose deleted history,
    // and carrying its session-bound journal to a new ID cannot recover safely.
    if (source.pendingHistoryTruncation !== undefined) {
      throw new Error(this.language === 'en'
        ? 'Open this session in its original workspace and finish history recovery before copying it.'
        : '请先在原工作区打开此会话并完成历史恢复，再复制会话。');
    }

    const now = new Date().toISOString();
    const copied: ChatSession = {
      ...source,
      pendingHistoryTruncation: undefined,
      approvalMode: this.approvalModeValue,
      executionMode: 'normal',
      planWorkflows: undefined,
      id: randomUUID(),
      messages: source.messages.map(copyMessage),
      contextCompression: undefined,
      requestProtocol: createNewSessionRequestProtocol(now),
      repairLoop: undefined,
      lastTraceLogUri: undefined,
      createdAt: now,
      updatedAt: now,
      workspaceKey: this.workspaceScope.key,
      workspaceName: this.workspaceScope.name,
      workspaceFolders: this.workspaceScope.folderUris
    };
    const copiedIds = new Map(source.messages.map((message, index) => [message.id, copied.messages[index].id]));
    for (const message of copied.messages) {
      const task = message.userTask;
      if (!task) continue;
      const originMessageId = copiedIds.get(task.originMessageId);
      if (!originMessageId) { message.userTask = undefined; continue; }
      const taskId = copiedIds.get(task.id) ?? originMessageId;
      copiedIds.set(task.id, taskId);
      message.userTask = { ...task, id: taskId, originMessageId };
    }
    // Copy spent root allowances under the new identities. Explicit title
    // refresh budgets are one-shot auxiliary claims whose keys contain request
    // tokens; neither those claims nor their token identities belong to a copy.
    const copiedBudgets: NonNullable<ChatSession['userTaskBudgets']> = Object.create(null);
    for (const [sourceTaskId, budget] of Object.entries(normalizeUserTaskBudgets(source.userTaskBudgets))) {
      if (sourceTaskId.startsWith('session_title_manual_')) continue;
      const taskId = copiedIds.get(sourceTaskId) ?? randomUUID();
      copiedIds.set(sourceTaskId, taskId);
      copiedBudgets[taskId] = budget;
    }
    copied.userTaskBudgets = copiedBudgets;
    copied.autoTitle = cloneSessionTitleMetadata(source.autoTitle, source.customTitle, copiedIds, copied.messages);

    this.sessions.unshift(copied);
    this.setActiveSessionId(copied.id);
    await this.persist();
    return copied;
  }

  public async toggleSessionFavorite(sessionId: string): Promise<ChatSession | undefined> {
    const session = await this.loadSessionById(sessionId);
    if (!session) {
      return undefined;
    }

    session.isFavorite = !session.isFavorite;
    await this.persist();
    return session;
  }

  public async renameSession(sessionId: string, title: string): Promise<ChatSession | undefined> {
    const session = await this.loadSessionById(sessionId);
    if (!session) {
      return undefined;
    }

    const normalizedTitle = title.replace(/\s+/gu, ' ').trim();
    if (!normalizedTitle) {
      return undefined;
    }

    session.title = normalizedTitle;
    session.customTitle = normalizedTitle;
    session.autoTitle = lockSessionTitleMetadata(session.autoTitle);
    this.stagedTitles.delete(sessionId);
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
    const deletedSummaryIds = new Set(Array.from(ids).filter((id) => this.sessionSummaries.has(id)));
    const deletedActiveSession = deletedSummaryIds.has(previousActiveSessionId);
    const deletedCount = deletedSummaryIds.size;
    this.sessions = this.sessions.filter((session) => {
      if (!this.isInCurrentWorkspace(session) || !ids.has(session.id)) {
        return true;
      }
      return false;
    });
    for (const id of ids) {
      this.sessionSummaries.delete(id);
      this.stagedTitles.delete(id);
    }

    if (deletedActiveSession) {
      const session = createEmptySession(this.language, this.workspaceScope, this.approvalModeValue);
      this.sessions.unshift(session);
      this.setActiveSessionId(session.id);
    } else {
      this.ensureActiveSession();
    }
    this.compact();
    // An already-started title snapshot must finish before deleting its shard;
    // otherwise that adapter write could recreate the deleted session.
    await this.persistenceDrain?.catch(() => {});
    await this.sessionStorage.deleteWorkspaceSessions(this.workspaceScope.key, Array.from(ids));
    await this.persist();
    return {
      deletedCount,
      activeSessionChanged: previousActiveSessionId !== this.activeSessionIdValue
    };
  }

  /** Retire cancellable title work only after Host confirmation. This does not
   * delete, hydrate or save a session; an in-flight save is allowed to settle
   * before the cleanup service performs its final version check. */
  public async settleHistoryCleanup(sessionIds: readonly string[]): Promise<void> {
    for (const id of new Set(sessionIds)) {
      this.stagedTitles.delete(id);
      const session = this.getSessionById(id);
      if (!session) continue;
      const state = normalizeSessionTitle(session.autoTitle, session.customTitle, { preserveRunning: true });
      if (state.status === 'running' || state.manualAttempt) session.autoTitle = {
        ...state, status: state.status === 'running' ? 'pending' : state.status,
        revision: state.revision + 1, attempt: undefined, manualAttempt: undefined, lastOutcome: 'stale'
      };
    }
    while (this.persistenceDrain || this.pendingPersistence) {
      this.startPersistenceDrain();
      await this.persistenceDrain;
    }
  }

  /** Forget only IDs already committed to the durable deletion authority. Disk
   * reclamation belongs to the cleanup service. Never select another history or
   * prepare context when replacing the deleted active session. */
  public async forgetHistoryCleanup(sessionIds: readonly string[]): Promise<DeleteSessionsResult> {
    const ids = new Set(sessionIds.filter(id => typeof id === 'string' && !!id.trim()));
    if (!ids.size) return { deletedCount: 0, activeSessionChanged: false };
    const workspaceKey = this.workspaceScope.key;
    if (this.sessionStorage.isSessionDeleted) {
      for (const id of ids) if (!await this.sessionStorage.isSessionDeleted(workspaceKey, id)) {
        throw new Error('history_cleanup_not_committed');
      }
    }
    if (workspaceKey !== this.workspaceScope.key) throw new Error('session_workspace_changed');
    const previousActive = this.activeSessionIdValue;
    const deletedCount = [...ids].filter(id => this.sessionSummaries.has(id)
      || this.sessions.some(session => this.isInCurrentWorkspace(session) && session.id === id)).length;
    for (const id of ids) {
      this.deletedSessionKeys.add(this.sessionIdentity(id));
      this.sessionSummaries.delete(id);
      this.stagedTitles.delete(id);
      this.titleSessionPins.delete(this.sessionIdentity(id));
    }
    this.sessions = this.sessions.filter(session => !this.isInCurrentWorkspace(session) || !ids.has(session.id));
    const pending = this.pendingPersistence;
    if (pending?.scope.key === this.workspaceScope.key) {
      pending.snapshot.sessions = pending.snapshot.sessions.filter(session => !ids.has(session.id));
      pending.snapshot.sessionSummaries = pending.snapshot.sessionSummaries?.filter(session => !ids.has(session.id));
    }
    if (ids.has(previousActive)) {
      const blank = createEmptySession(this.language, this.workspaceScope, this.approvalModeValue, 'normal');
      this.sessions.unshift(blank);
      this.setActiveSessionId(blank.id);
    }
    // The store transaction already removed non-active targets from disk. Avoid
    // rewriting every survivor for each item in a large cleanup batch.
    if (previousActive !== this.activeSessionIdValue) await this.persist('history_cleanup_selection');
    return { deletedCount, activeSessionChanged: previousActive !== this.activeSessionIdValue };
  }

  public async cleanupExpiredSessions(
    now = Date.now(),
    protectedSessionIds: readonly string[] = [],
    force = false
  ): Promise<boolean> {
    const changed = await this.sessionStorage.cleanupExpiredSessions({
      currentWorkspaceKey: this.workspaceScope.key,
      currentActiveSessionId: this.activeSessionIdValue,
      protectedSessionIds,
      now,
      force
    });
    if (changed) {
      await this.load();
    }
    return changed;
  }

  private persistRevision = 0;
  private persistedRevision = 0;
  private pendingPersistence?: {
    revision: number;
    scope: WorkspaceSessionScope;
    snapshot: StoredWorkspaceSessionState;
    checkpointSources: Map<string, ChatMessage['runCheckpoint']>;
    queuedAt: number;
    reason: string;
  };
  private persistenceDrain?: Promise<void>;
  private readonly persistenceWaiters: Array<{
    revision: number;
    resolve: () => void;
    reject: (error: unknown) => void;
  }> = [];

  public async persist(reason = 'session_barrier'): Promise<void> {
    const started = performance.now();
    for (const session of this.sessions) session.executionTime = reconcileExecutionTime(session.executionTime, session.messages);
    this.compact();
    const revision = ++this.persistRevision;
    const snapshot: StoredWorkspaceSessionState = {
      activeSessionId: this.activeSessionIdValue,
      approvalMode: this.approvalModeValue,
      sessions: this.sessions.map(snapshotSession),
      sessionSummaries: this.getSessionSummaries()
    };
    const checkpointSources = new Map(this.sessions.flatMap(session => session.messages.map(message => [message.id, message.runCheckpoint] as const)));
    this.pendingPersistence = { revision, scope: { ...this.workspaceScope, folderUris: [...this.workspaceScope.folderUris] }, snapshot, checkpointSources,
      queuedAt: performance.now(), reason };
    for (const session of this.sessions) recordLocalPerformance({ type: 'checkpoint_snapshot', sessionId: session.id,
      snapshotMs: performance.now() - started, reason, queueDepth: Number(Boolean(this.persistenceDrain)) + 1 });
    const completed = new Promise<void>((resolve, reject) => {
      this.persistenceWaiters.push({ revision, resolve, reject });
    });
    this.startPersistenceDrain();
    await completed;
  }

  public async getRecoveryCheckpoint(messageId: string): Promise<import('../agent/runCheckpoint').RunCheckpoint | undefined> {
    const session = this.getActiveSession();
    const message = session.messages.at(-1);
    if (message?.id !== messageId) return undefined;
    if (message.runCheckpoint) return message.runCheckpoint;
    if (!message.runCheckpointArchive) return undefined;
    const stored = await this.sessionStorage.loadSession?.(this.workspaceScope.key, session.id);
    // Recheck the live tail after asynchronous I/O. Never attach stale recovery.
    if (this.getActiveSession() !== session || session.messages.at(-1) !== message) return undefined;
    const cp = stored?.messages.at(-1);
    return cp?.id === messageId ? cp.runCheckpoint : undefined;
  }

  public async getTaskCheckpoint(messageId: string, sessionId?: string): Promise<import('../agent/runCheckpoint').RunCheckpoint | undefined> {
    const session = sessionId ? this.getSessionById(sessionId) : this.getActiveSession();
    if (!session) return undefined;
    const message = session.messages.find(item => item.id === messageId);
    if (message?.runCheckpoint) return message.runCheckpoint;
    if (!message?.runCheckpointArchive) return undefined;
    const stored = await this.sessionStorage.loadMessageCheckpoint?.(this.workspaceScope.key, session.id, messageId);
    if ((sessionId ? this.getSessionById(sessionId) : this.getActiveSession()) !== session || !session.messages.includes(message)) return undefined;
    const cp = normalizeRunCheckpoint(stored);
    return cp?.taskId === message.runCheckpointArchive.summary.taskId ? cp : undefined;
  }

  private startPersistenceDrain(): void {
    if (this.persistenceDrain) return;
    const drain = this.drainPersistence();
    this.persistenceDrain = drain;
    void drain.then(
      () => this.finishPersistenceDrain(drain),
      () => this.finishPersistenceDrain(drain)
    );
  }

  private finishPersistenceDrain(drain: Promise<void>): void {
    if (this.persistenceDrain !== drain) return;
    this.persistenceDrain = undefined;
    if (this.pendingPersistence) this.startPersistenceDrain();
  }

  private async drainPersistence(): Promise<void> {
    while (this.pendingPersistence) {
      const next = this.pendingPersistence;
      this.pendingPersistence = undefined;
      const processing = performance.now();
      const titleWrites = new Map<string, StagedSessionTitle>();
      try {
        // A title candidate stays out of live memory until this write commits.
        // Re-evaluate at the queue boundary: newer turns/renames may have
        // invalidated a candidate while an earlier save was in flight.
        for (const saved of next.snapshot.sessions) {
          const live = this.getSessionById(saved.id);
          if (!live || live.workspaceKey !== next.scope.key) continue;
          const staged = this.stagedTitles.get(saved.id);
          const valid = staged && this.matchesTitleAttempt(saved.id, staged.token, staged.revision);
          if (valid) titleWrites.set(saved.id, staged);
          saved.title = valid ? staged.title : live.title;
          saved.customTitle = valid && staged.clearCustomTitle ? undefined : live.customTitle;
          saved.autoTitle = structuredClone(valid ? staged.metadata : live.autoTitle);
          const summary = next.snapshot.sessionSummaries?.find(item => item.id === saved.id);
          if (summary) { summary.title = saved.title; summary.customTitle = saved.customTitle; }
        }
        await this.sessionStorage.saveWorkspace(next.scope, next.snapshot);
        for (const saved of next.snapshot.sessions) {
          const staged = this.stagedTitles.get(saved.id);
          if (staged && titleWrites.get(saved.id) === staged && saved.autoTitle?.status === 'completed'
            && saved.autoTitle.revision === staged.metadata.revision
            && saved.autoTitle.completed?.taskId === staged.metadata.completed?.taskId
            && this.matchesTitleAttempt(saved.id, staged.token, staged.revision)) {
            if (await this.sessionStorage.isSessionDeleted?.(next.scope.key, saved.id)) {
              this.stagedTitles.delete(saved.id);
              continue;
            }
            const live = this.getSessionById(saved.id)!;
            live.title = staged.title;
            if (staged.clearCustomTitle) live.customTitle = undefined;
            live.autoTitle = staged.metadata;
            this.sessionSummaries.set(live.id, toSessionSummary(live, this.language));
            this.stagedTitles.delete(live.id);
          }
        }
        // Release archived bodies only after the object graph AND manifest commit.
        // An in-flight newer checkpoint wins; never detach its recovery state.
        for (const savedSession of next.snapshot.sessions) {
          const live = this.sessions.find(session => session.id === savedSession.id);
          for (const saved of savedSession.messages) {
            if (!saved.runCheckpointArchive) continue;
            const message = live?.messages.find(item => item.id === saved.id);
            if (message?.runCheckpoint && message.runCheckpoint.status !== 'running'
              && message.runCheckpoint === next.checkpointSources.get(saved.id)) {
              message.runCheckpointArchive = saved.runCheckpointArchive;
              message.runCheckpoint = undefined;
            }
          }
        }
      } catch (error) {
        // Pending generic saves are re-projected from live titles above. They
        // cannot resurrect a rejected staged candidate.
        for (const [sessionId, staged] of titleWrites) {
          if (this.stagedTitles.get(sessionId) === staged) this.stagedTitles.delete(sessionId);
        }
        this.rejectPersistenceWaitersThrough(next.revision, error);
        throw error;
      }
      this.persistedRevision = Math.max(this.persistedRevision, next.revision);
      for (const session of next.snapshot.sessions) recordLocalPerformance({ type: 'checkpoint_session_commit', sessionId: session.id,
        reason: next.reason, queueMs: processing - next.queuedAt, processingMs: performance.now() - processing,
        durationMs: performance.now() - next.queuedAt });
      this.settlePersistenceWaiters();
    }
  }

  private rejectPersistenceWaitersThrough(revision: number, error: unknown): void {
    for (let index = this.persistenceWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.persistenceWaiters[index];
      if (waiter.revision <= revision) {
        this.persistenceWaiters.splice(index, 1);
        waiter.reject(error);
      }
    }
  }

  private settlePersistenceWaiters(): void {
    for (let index = this.persistenceWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.persistenceWaiters[index];
      if (waiter.revision <= this.persistedRevision) {
        this.persistenceWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
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
    for (const session of this.getCurrentWorkspaceSessions()) {
      this.sessionSummaries.set(session.id, toSessionSummary(session, this.language));
    }
    return Array.from(this.sessionSummaries.values())
      .filter((summary) => summary.workspaceKey === this.workspaceScope.key)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }

  public async getAllWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
    return this.sessionStorage.listAllWorkspaceSummaries();
  }

  public async getOtherWorkspaceSessionSummaries(workspaceKey: string): Promise<ChatSessionSummary[]> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.workspaceScope.key) {
      return [];
    }

    if (this.sessionStorage.listWorkspaceSessionSummaries) {
      return await this.sessionStorage.listWorkspaceSessionSummaries(normalizedWorkspaceKey);
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

    const summaries = await this.getOtherWorkspaceSessionSummaries(normalizedWorkspaceKey);
    const deletedCount = summaries.filter((session) => ids.has(session.id)).length;
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

  public trimActiveHistory(_maxMessages?: number): void {
    // Compatibility no-op: model context is trimmed by historyProjection, not by deleting
    // persisted active-session messages.
  }

  private async load(): Promise<void> {
    const stored = await this.sessionStorage.loadWorkspace(this.workspaceScope);
    const sessions = normalizeStoredSessions({ sessions: stored.sessions }, this.workspaceScope);

    this.sessions = sessions.filter((session) => this.isInCurrentWorkspace(session));
    this.sessionSummaries = new Map((stored.sessionSummaries ?? this.sessions.map((session) => toSessionSummary(session, this.language)))
      .filter((summary) => summary.workspaceKey === this.workspaceScope.key)
      .map((summary) => [summary.id, summary]));
    this.activeSessionIdValue = typeof stored.activeSessionId === 'string' ? stored.activeSessionId : '';
    const storedActiveSession = this.sessions.find((session) => session.id === this.activeSessionIdValue)
      ?? this.getCurrentWorkspaceSessions()[0];
    this.approvalModeValue = normalizeStoredApprovalMode(stored.approvalMode ?? storedActiveSession?.approvalMode);
    this.ensureActiveSession();
    if ((stored.approvalMode as unknown) === 'model_review') this.getActiveSession().approvalModeMigrated = true;
    this.compact();
  }

  private ensureActiveSession(): ChatSession {
    const currentSessions = this.getCurrentWorkspaceSessions();
    const existing = currentSessions.find((session) => session.id === this.activeSessionIdValue);
    if (existing) {
      existing.approvalMode = this.approvalModeValue;
      existing.executionMode = normalizeExecutionMode(existing.executionMode);
      this.setActiveSessionId(existing.id);
      return existing;
    }

    const fallback = currentSessions[0]
      ?? createEmptySession(this.language, this.workspaceScope, this.approvalModeValue);
    if (!currentSessions.length) {
      this.sessions.unshift(fallback);
    }
    fallback.approvalMode = this.approvalModeValue;
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
        if (isActive || session.isFavorite || this.titleSessionPins.has(JSON.stringify([session.workspaceKey, session.id]))) {
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
    for (const session of this.sessions) {
      this.sessionSummaries.set(session.id, toSessionSummary(session, this.language));
    }
    this.setActiveSessionId(activeSession.id);
  }

  private async loadSessionById(sessionId: string): Promise<ChatSession | undefined> {
    const workspaceKey = this.workspaceScope.key;
    if (this.deletedSessionKeys.has(this.sessionIdentity(sessionId))
      || await this.sessionStorage.isSessionDeleted?.(workspaceKey, sessionId)) return undefined;
    if (workspaceKey !== this.workspaceScope.key) return undefined;
    const loaded = this.sessions.find((item) => item.id === sessionId && this.isInCurrentWorkspace(item));
    if (loaded) {
      return loaded;
    }
    if (!this.sessionSummaries.has(sessionId) || !this.sessionStorage.loadSession) {
      return undefined;
    }
    const session = await this.sessionStorage.loadSession(workspaceKey, sessionId);
    if (!session || session.id !== sessionId || workspaceKey !== this.workspaceScope.key
      || !this.sessionSummaries.has(sessionId) || !this.isInCurrentWorkspace(session)) {
      return undefined;
    }
    const current = this.getSessionById(sessionId);
    if (current) return current;
    this.sessions.push(session);
    return session;
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
  workspaceScope: WorkspaceSessionScope = getCurrentWorkspaceSessionScope(),
  approvalMode: ApprovalMode = 'ask',
  executionMode: ExecutionMode = 'normal'
): ChatSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    title: localize(language, 'defaultSessionTitle'),
    autoTitle: normalizeSessionTitle(undefined, undefined),
    messages: [],
    executionTime: { version: 1, byTask: {}, incomplete: false },
    approvalMode,
    executionMode: normalizeExecutionMode(executionMode),
    planWorkflows: [],
    activeSkillIds: [],
    requestProtocol: createNewSessionRequestProtocol(now),
    createdAt: now,
    updatedAt: now,
    workspaceKey: workspaceScope.key,
    workspaceName: workspaceScope.name,
    workspaceFolders: workspaceScope.folderUris,
    isFavorite: false
  };
}

function normalizeStoredApprovalMode(value: unknown): ApprovalMode {
  return value === 'delegate' ? value : 'ask';
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

function copyMessage(message: ChatMessage): ChatMessage {
  return {
    ...message,
    id: randomUUID(),
    isStreaming: undefined,
    runCheckpoint: undefined,
    runCheckpointArchive: undefined,
    runDetails: message.runDetails ? cloneRunDetails(message.runDetails) : undefined
  };
}

export function getVisibleMessages(messages: ChatMessage[], models: readonly import('../shared/types').KeepseekModel[] = []): ChatMessage[] {
  return messages.map(({
    runCheckpoint,
    runCheckpointArchive,
    dynamicContextHash: _dynamicContextHash,
    expandedContent: _expandedContent,
    providerReplay: _providerReplay,
    toolRounds: _toolRounds,
    ...message
  }) => ({
    ...message,
    runState: runCheckpoint ? (() => {
      const resumableBudgetPause = isResumableToolBudgetCheckpoint(runCheckpoint);
      return {
      taskId: runCheckpoint.taskId,
      status: resumableBudgetPause ? 'interrupted' : runCheckpoint.status,
      stopReason: resumableBudgetPause ? 'budget_pause' : runCheckpoint.stopReason,
      usedMs: runCheckpoint.usedMs, maxExecutionMs: runCheckpoint.maxExecutionMs, limitSource: runCheckpoint.limitSource,
      attempt: runCheckpoint.attempt, modelRequests: runCheckpoint.modelRequests, retries: runCheckpoint.retries,
      lastNetworkAt: runCheckpoint.lastNetworkAt, lastEventAt: runCheckpoint.lastEventAt, lastContentAt: runCheckpoint.lastContentAt,
      requestStartedAt: runCheckpoint.requestStartedAt, lastStepAt: runCheckpoint.lastStepAt, steps: (runCheckpoint.state?.toolRounds.reduce((count, round) => count + round.toolResults.length, 0) ?? 0) + Object.keys(runCheckpoint.state?.pending?.results ?? {}).length,
      outputBudget: runCheckpoint.lastRequestBudget,
      outputFailure: runCheckpoint.outputFailure ? { finishReason: runCheckpoint.outputFailure.finishReason,
        requestId: runCheckpoint.outputFailure.requestId, toolsExecuted: 0 as const } : undefined,
      outputBudgetMigrations: runCheckpoint.outputBudgetMigrations,
      canResume: runCheckpoint.status !== 'running' && !recoveryBlocker(runCheckpoint, models.find((model) => model.sourceId === runCheckpoint.source.sourceId && model.id === runCheckpoint.source.modelId)),
      blocker: recoveryBlocker(runCheckpoint, models.find((model) => model.sourceId === runCheckpoint.source.sourceId && model.id === runCheckpoint.source.modelId)), error: runCheckpoint.error
      };
    })() : runCheckpointArchive?.summary,
    ...(message.runDetails ? { runDetails: {
      ...message.runDetails,
      toolCalls: message.runDetails.toolCalls.map((tool) => {
        if (!['keepseek_delegate_task', 'keepseek_delegate_parallel', 'keepseek_read_subagent_result'].includes(tool.name)) {
          return tool;
        }
        return {
          id: tool.id, name: tool.name, status: tool.status,
          startedAt: tool.startedAt, endedAt: tool.endedAt, durationMs: tool.durationMs,
          riskLevel: tool.riskLevel, scope: tool.scope, truncated: tool.truncated
        };
      })
    } } : {})
  }));
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

export function normalizeStoredSessions(value: unknown, workspaceScope: WorkspaceSessionScope,
  options: { confirmedLegacyTitleCompletion?: boolean } = {}): ChatSession[] {
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
    const autoTitle = normalizeSessionTitle(item.autoTitle, customTitle, { messages,
      confirmedLegacyCompletion: options.confirmedLegacyTitleCompletion });

    sessions.push({
      id: item.id,
      title,
      autoTitle,
      messages,
      approvalMode: normalizeStoredApprovalMode(item.approvalMode),
      approvalModeMigrated: item.approvalMode === 'model_review' || item.approvalModeMigrated === true || undefined,
      pendingApproval: normalizeManualApproval(item.pendingApproval),
      pendingHistoryTruncation: normalizePendingHistoryTruncation(item.pendingHistoryTruncation, item.id, normalizeStoredMessage),
      executionMode: normalizeExecutionMode(item.executionMode),
      planWorkflows: normalizePlanWorkflowRecords(item.planWorkflows, item.id),
      activeSkillIds: normalizeStringArray(item.activeSkillIds),
      projectScopeUri: normalizeProjectScopeUri(item.projectScopeUri),
      frozenImplicitSkillIds: normalizeStringArray(item.frozenImplicitSkillIds),
      requestProtocol: normalizeSessionRequestProtocol(item.requestProtocol),
      historyArchive: normalizeHistoryArchive(item.historyArchive),
      contextCompression: normalizeContextCompressionState(item.contextCompression),
      contextInstructions: typeof item.contextInstructions === 'string'
        ? item.contextInstructions
        : undefined,
      repairLoop: normalizeRepairLoopState(item.repairLoop),
      contextUsage: normalizeContextUsageEstimateValue(item.contextUsage),
      executionTime: reconcileExecutionTime(item.executionTime, messages),
      approvalProcessing: normalizeApprovalProcessing(item.approvalProcessing),
      userTaskBudgets: normalizeUserTaskBudgets(item.userTaskBudgets),
      usageStats: normalizeSessionUsageStatsValue(item.usageStats),
      usageLedger: normalizeUsageLedgerValue(item.usageLedger),
      usageLedgerRef: normalizeUsageLedgerRef(item.usageLedgerRef, item.id),
      lastTurnUsage: normalizeTurnUsageStatsValue(item.lastTurnUsage),
      subagentUsageStats: normalizeSubagentSessionUsageStatsValue(item.subagentUsageStats),
      balance: normalizeBalanceStateValue(item.balance),
      promptCacheDiagnostics: normalizePromptCacheDiagnosticsValue(item.promptCacheDiagnostics),
      lastTraceLogUri: typeof item.lastTraceLogUri === 'string' && item.lastTraceLogUri.trim()
        ? item.lastTraceLogUri.trim()
        : undefined,
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

function normalizeUsageLedgerRef(value: unknown, sessionId: string): ChatSession['usageLedgerRef'] {
  if (!isRecord(value) || value.version !== 2 || value.sessionId !== sessionId) return undefined;
  return {
    version: 2,
    sessionId,
    ...(value.migratedInlineVersion === 1 ? { migratedInlineVersion: 1 } : {}),
    legacyAggregate: value.legacyAggregate === true,
    incomplete: value.incomplete === true,
    ...(Number.isSafeInteger(value.damagedBucketCount) && Number(value.damagedBucketCount) > 0
      ? { damagedBucketCount: Number(value.damagedBucketCount) } : {})
  };
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
    userTask: normalizeUserTask(value.userTask),
    ...(value.incompleteForTitle === true || value.isStreaming === true ? { incompleteForTitle: true as const } : {}),
    role,
    content: value.content,
    expandedContent: typeof value.expandedContent === 'string' ? value.expandedContent : undefined,
    createdAt: normalizeSessionTimestamp(value.createdAt, new Date().toISOString()),
    modelId: typeof value.modelId === 'string' ? value.modelId : undefined,
    reasoningContent: typeof value.reasoningContent === 'string' ? value.reasoningContent : undefined,
    providerContent: typeof value.providerContent === 'string' ? value.providerContent : undefined,
    dynamicContextHash: typeof value.dynamicContextHash === 'string' && /^[a-f0-9]{64}$/u.test(value.dynamicContextHash)
      ? value.dynamicContextHash : undefined,
    contextMeta: normalizeMessageContextMeta(value.contextMeta),
    usedSkills: normalizeMessageUsedSkills(value.usedSkills),
    runCheckpoint: normalizeRunCheckpoint(value.runCheckpoint),
    runCheckpointArchive: normalizeCheckpointArchive(value.runCheckpointArchive),
    runDetails: normalizeRunDetails(value.runDetails),
    toolRounds: normalizeAgentToolRounds(value.toolRounds),
    providerReplay: normalizeProviderReplay(value.providerReplay)
  };
}

function normalizeCheckpointArchive(value: unknown): ChatMessage['runCheckpointArchive'] {
  if (!isRecord(value) || value.version !== 1 || typeof value.objectHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.objectHash) || !isRecord(value.summary)) return undefined;
  const s = value.summary;
  if (typeof s.taskId !== 'string' || !['running', 'interrupted', 'completed', 'blocked'].includes(String(s.status))) return undefined;
  const count = (key: string) => typeof s[key] === 'number' && Number.isFinite(s[key]) ? Math.max(0, Math.floor(s[key] as number)) : 0;
  return { version: 1, objectHash: value.objectHash,
    pendingTool: typeof value.pendingTool === 'boolean' ? value.pendingTool : undefined, summary: {
    taskId: s.taskId, status: s.status === 'running' ? 'interrupted' : String(s.status),
    stopReason: s.status === 'running' ? 'extension_restart' : typeof s.stopReason === 'string' ? s.stopReason : undefined,
    usedMs: count('usedMs'), maxExecutionMs: count('maxExecutionMs'), attempt: count('attempt'),
    modelRequests: count('modelRequests'), retries: count('retries'), steps: count('steps'),
    limitSource: typeof s.limitSource === 'string' ? s.limitSource : '', canResume: false,
    error: typeof s.error === 'string' ? s.error : undefined
  } };
}

function createNewSessionRequestProtocol(now: string): SessionRequestProtocol {
  return {
    version: CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION,
    serializationStrategy: 'provider-projection-v2',
    toolSchemaVersion: CURRENT_PROVIDER_TOOL_SCHEMA_VERSION,
    toolNames: [],
    createdAt: now
  };
}

function normalizeSessionRequestProtocol(value: unknown): SessionRequestProtocol | undefined {
  if (!isRecord(value)) {
    // Missing means a pre-v2 session. Leaving it absent is deliberate: request
    // construction falls back to v1 until a cache-safe migration boundary.
    return undefined;
  }
  const version = normalizePositiveInteger(value.version, 1);
  return {
    version,
    serializationStrategy: version >= PROVIDER_PROJECTION_REQUEST_PROTOCOL_VERSION
      ? 'provider-projection-v2'
      : 'legacy-v1',
    toolSchemaVersion: normalizePositiveInteger(value.toolSchemaVersion, 1),
    toolNames: normalizeStringArray(value.toolNames),
    modelId: typeof value.modelId === 'string' && value.modelId.trim() ? value.modelId.trim() : undefined,
    sourceId: typeof value.sourceId === 'string' && value.sourceId.trim() ? value.sourceId.trim() : undefined,
    providerId: typeof value.providerId === 'string' && value.providerId.trim() ? value.providerId.trim() : undefined,
    baseUrl: typeof value.baseUrl === 'string' && value.baseUrl.trim() ? value.baseUrl.trim() : undefined,
    createdAt: normalizeSessionTimestamp(value.createdAt, new Date().toISOString()),
    lastProviderRequestAt: normalizeOptionalTimestamp(value.lastProviderRequestAt),
    lastDynamicContextHash: typeof value.lastDynamicContextHash === 'string' && value.lastDynamicContextHash.trim()
      ? value.lastDynamicContextHash.trim()
      : undefined
  };
}

function normalizeHistoryArchive(value: unknown): HistoryArchiveEntry[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const entries: HistoryArchiveEntry[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (!isRecord(raw)
      || typeof raw.id !== 'string'
      || typeof raw.messageId !== 'string'
      || typeof raw.content !== 'string'
      || typeof raw.contentHash !== 'string'
      || seen.has(raw.id)) {
      continue;
    }
    const role = raw.role === 'user' || raw.role === 'assistant' || raw.role === 'system' || raw.role === 'tool'
      ? raw.role
      : undefined;
    if (!role) {
      continue;
    }
    seen.add(raw.id);
    entries.push({
      id: raw.id,
      messageId: raw.messageId,
      toolCallId: typeof raw.toolCallId === 'string' ? raw.toolCallId : undefined,
      toolName: typeof raw.toolName === 'string' ? raw.toolName : undefined,
      role,
      content: raw.content,
      contentHash: raw.contentHash,
      createdAt: normalizeSessionTimestamp(raw.createdAt, new Date().toISOString())
    });
  }
  return entries.length ? entries : undefined;
}

function normalizeAgentToolRounds(value: unknown): AgentToolRound[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const rounds = value.map(normalizeAgentToolRound).filter((round): round is AgentToolRound => Boolean(round));
  return rounds.length ? rounds : undefined;
}

function normalizeAgentToolRound(value: unknown): AgentToolRound | undefined {
  if (!isRecord(value) || !Array.isArray(value.toolCalls)) {
    return undefined;
  }
  const toolCalls = value.toolCalls.map(normalizeAgentToolCall).filter((call): call is AgentToolCall => Boolean(call));
  const toolResults = Array.isArray(value.toolResults)
    ? value.toolResults.map(normalizeAgentToolResult).filter((result): result is AgentToolResult => Boolean(result))
    : [];
  if (!toolCalls.length) {
    return undefined;
  }
  return {
    assistantContent: typeof value.assistantContent === 'string' ? value.assistantContent : null,
    reasoningContent: typeof value.reasoningContent === 'string' ? value.reasoningContent : null,
    toolCalls,
    toolResults
  };
}

function normalizeAgentToolCall(value: unknown): AgentToolCall | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.function)) {
    return undefined;
  }
  return {
    id: value.id,
    type: 'function',
    function: {
      name: typeof value.function.name === 'string' ? value.function.name : '',
      arguments: typeof value.function.arguments === 'string' ? value.function.arguments : ''
    }
  };
}

function normalizeAgentToolResult(value: unknown): AgentToolResult | undefined {
  if (!isRecord(value) || typeof value.toolCallId !== 'string' || typeof value.content !== 'string') {
    return undefined;
  }
  return {
    toolCallId: value.toolCallId,
    content: value.content
  };
}

function normalizeRunDetails(value: unknown): ChatMessage['runDetails'] {
  if (!isRecord(value) || typeof value.runId !== 'string' || typeof value.modelId !== 'string') {
    return undefined;
  }
  const status = value.status === 'running'
    || value.status === 'succeeded'
    || value.status === 'waiting'
    || value.status === 'blocked'
    || value.status === 'failed'
    || value.status === 'stopped'
    ? value.status
    : 'failed';
  const modelRequests = isRecord(value.modelRequests) ? value.modelRequests : {};
  return {
    runId: value.runId,
    sessionId: typeof value.sessionId === 'string' ? value.sessionId : undefined,
    assistantMessageId: typeof value.assistantMessageId === 'string' ? value.assistantMessageId : undefined,
    backgroundRunId: typeof value.backgroundRunId === 'string' ? value.backgroundRunId : undefined,
    modelId: value.modelId,
    sourceId: typeof value.sourceId === 'string' ? value.sourceId : undefined,
    provider: typeof value.provider === 'string' ? value.provider : undefined,
    protocol: typeof value.protocol === 'string' ? value.protocol : undefined,
    status,
    startedAt: normalizeSessionTimestamp(value.startedAt, new Date().toISOString()),
    endedAt: normalizeOptionalTimestamp(value.endedAt),
    durationMs: typeof value.durationMs === 'number' ? Math.max(0, value.durationMs) : undefined,
    taskPlan: normalizeRunDetailsTaskPlan(value.taskPlan),
    delegation: normalizeRunDetailsDelegation(value.delegation),
    modelRequests: {
      requestCount: normalizeNonNegativeInteger(modelRequests.requestCount),
      messageCount: normalizeNonNegativeInteger(modelRequests.messageCount),
      exposedToolCount: normalizeNonNegativeInteger(modelRequests.exposedToolCount),
      maxOutputTokens: typeof modelRequests.maxOutputTokens === 'number' ? Math.max(0, modelRequests.maxOutputTokens) : undefined,
      thinkingEnabled: modelRequests.thinkingEnabled === true
    },
    toolCallCount: normalizeNonNegativeInteger(value.toolCallCount ?? (Array.isArray(value.toolCalls) ? value.toolCalls.length : 0)),
    toolCalls: Array.isArray(value.toolCalls)
      ? value.toolCalls.filter(isRecord).slice(0, 80).map((tool, index) => ({
          id: typeof tool.id === 'string' ? tool.id : `tool-${index + 1}`,
          name: typeof tool.name === 'string' ? tool.name : 'unknown_tool',
          startedAt: normalizeSessionTimestamp(tool.startedAt, new Date().toISOString()),
          endedAt: normalizeOptionalTimestamp(tool.endedAt),
          durationMs: typeof tool.durationMs === 'number' ? Math.max(0, tool.durationMs) : undefined,
          status: tool.status === 'succeeded' || tool.status === 'failed' || tool.status === 'denied' ? tool.status : 'running',
          argumentsSummary: typeof tool.argumentsSummary === 'string' ? tool.argumentsSummary.slice(0, 500) : undefined,
          resultSummary: typeof tool.resultSummary === 'string' ? tool.resultSummary.slice(0, 500) : undefined,
          riskLevel: tool.riskLevel === 'low' || tool.riskLevel === 'medium' || tool.riskLevel === 'high' ? tool.riskLevel : undefined,
          scope: typeof tool.scope === 'string' ? tool.scope as NonNullable<ChatMessage['runDetails']>['toolCalls'][number]['scope'] : undefined,
          truncated: tool.truncated === true
        }))
      : [],
    authorizations: Array.isArray(value.authorizations)
      ? value.authorizations.filter(isRecord).slice(0, 80).map((authorization) => ({
          toolName: typeof authorization.toolName === 'string' ? authorization.toolName : 'unknown_tool',
          allowed: authorization.allowed === true,
          riskLevel: authorization.riskLevel === 'low' || authorization.riskLevel === 'medium' ? authorization.riskLevel : 'high',
          scope: typeof authorization.scope === 'string' ? authorization.scope as NonNullable<ChatMessage['runDetails']>['authorizations'][number]['scope'] : 'workspace_write',
          source: normalizeAuthorizationSource(authorization.source),
          reason: typeof authorization.reason === 'string' ? authorization.reason.slice(0, 240) : undefined
        }))
      : [],
    approvalReviews: Array.isArray(value.approvalReviews)
      ? value.approvalReviews.filter(isRecord).slice(0, 100).map((review) => ({
          reviewId: typeof review.reviewId === 'string' ? review.reviewId : '',
          sessionId: typeof review.sessionId === 'string' ? review.sessionId : '',
          rootTaskId: typeof review.rootTaskId === 'string' ? review.rootTaskId : '',
          agentRunId: typeof review.agentRunId === 'string' ? review.agentRunId : '',
          targetId: typeof review.targetId === 'string' ? review.targetId : '',
          actionKind: review.actionKind as import('../approvals/approvalReviewTypes').ApprovalActionKind,
          policyVersion: normalizeNonNegativeInteger(review.policyVersion),
          approvalMode: (review.approvalMode === 'delegate' || review.approvalMode === 'model_review' ? review.approvalMode : undefined) as import('../approvals/approvalReviewTypes').ApprovalReviewDisplay['approvalMode'],
          osIsolation: review.osIsolation === 'none' ? 'none' as const : undefined,
          approvalSource: review.approvalSource as import('../approvals/approvalReviewTypes').ApprovalReviewSource,
          reviewerSourceId: typeof review.reviewerSourceId === 'string' ? review.reviewerSourceId : '',
          reviewerModelId: typeof review.reviewerModelId === 'string' ? review.reviewerModelId : '',
          reviewerProvider: typeof review.reviewerProvider === 'string' ? review.reviewerProvider : '',
          decision: (review.decision === 'approve' || review.decision === 'needs_user' || review.decision === 'deny' ? review.decision : 'unavailable') as import('../approvals/approvalReviewTypes').ApprovalReviewDisplay['decision'],
          risk: (review.risk === 'low' || review.risk === 'medium' || review.risk === 'critical' ? review.risk : 'high') as import('../approvals/approvalReviewTypes').ApprovalReviewRisk,
          rationale: typeof review.rationale === 'string' ? review.rationale.slice(0, 800) : '',
          affectedTargets: Array.isArray(review.affectedTargets)
            ? review.affectedTargets.filter((target): target is string => typeof target === 'string').slice(0, 12).map(target => target.slice(0, 300)) : undefined,
          saferAlternative: typeof review.saferAlternative === 'string' ? review.saferAlternative.slice(0, 1200) : undefined,
          createdAt: normalizeSessionTimestamp(review.createdAt, new Date().toISOString()),
          priorReviewId: typeof review.priorReviewId === 'string' ? review.priorReviewId : undefined,
          userRequestId: typeof review.userRequestId === 'string' ? review.userRequestId : undefined,
          consumedAt: normalizeOptionalTimestamp(review.consumedAt)
        })).filter((review) => Boolean(review.reviewId))
      : undefined,
    changeSets: Array.isArray(value.changeSets)
      ? value.changeSets.filter(isRecord).slice(0, 20).map((changeSet) => ({
          id: typeof changeSet.id === 'string' ? changeSet.id : '',
          fileCount: normalizeNonNegativeInteger(changeSet.fileCount),
          status: normalizeChangeSetStatus(changeSet.status),
          operationSummary: typeof changeSet.operationSummary === 'string'
            ? changeSet.operationSummary.slice(0, 320)
            : undefined,
          labels: normalizeStringArray(changeSet.labels).slice(0, 256),
          files: Array.isArray(changeSet.files)
            ? changeSet.files.filter(isRecord).slice(0, 256).map((file, index) => ({
                id: typeof file.id === 'string' ? file.id : `file-${index + 1}`,
                label: typeof file.label === 'string' ? file.label.slice(0, 240) : `File ${index + 1}`,
                action: normalizeDraftEditAction(file.action),
                status: normalizeChangeSetFileStatus(file.status),
                error: typeof file.error === 'string' ? file.error.slice(0, 500) : undefined
              }))
            : undefined,
          appliedCount: normalizeNonNegativeInteger(changeSet.appliedCount),
          failedCount: normalizeNonNegativeInteger(changeSet.failedCount)
        })).filter((changeSet) => Boolean(changeSet.id))
      : [],
    validations: Array.isArray(value.validations)
      ? value.validations.filter(isRecord).slice(0, 20).map((validation) => ({
          script: validation.script === 'compile' || validation.script === 'lint' || validation.script === 'test' ? validation.script : undefined,
          ok: typeof validation.ok === 'boolean' ? validation.ok : undefined,
          exitCode: typeof validation.exitCode === 'number' ? validation.exitCode : undefined,
          durationMs: typeof validation.durationMs === 'number' ? Math.max(0, validation.durationMs) : undefined,
          errors: typeof validation.errors === 'number' ? Math.max(0, validation.errors) : undefined,
          warnings: typeof validation.warnings === 'number' ? Math.max(0, validation.warnings) : undefined,
          error: typeof validation.error === 'string' ? validation.error.slice(0, 500) : undefined
        }))
      : [],
    contextSources: Array.isArray(value.contextSources)
      ? value.contextSources.filter(isRecord).slice(0, 40).map((source, index) => ({
          id: typeof source.id === 'string' ? source.id : `context-${index + 1}`,
          kind: source.kind === 'project-instructions' || source.kind === 'skill' || source.kind === 'legacy-memory'
            ? source.kind
            : 'skill',
          label: typeof source.label === 'string' ? source.label.slice(0, 160) : 'Context source',
          uri: typeof source.uri === 'string' ? source.uri : undefined,
          source: typeof source.source === 'string' ? source.source.slice(0, 80) : undefined,
          scopeUri: normalizeProjectScopeUri(source.scopeUri),
          order: typeof source.order === 'number' && Number.isSafeInteger(source.order) && source.order >= 0 ? source.order : undefined,
          activation: source.activation === 'explicit' || source.activation === 'session'
            || source.activation === 'workspace-default' || source.activation === 'implicit'
            ? source.activation
            : undefined,
          reason: typeof source.reason === 'string' ? source.reason.slice(0, 240) : undefined,
          characterCount: normalizeNonNegativeInteger(source.characterCount),
          tokenEstimate: normalizeNonNegativeInteger(source.tokenEstimate),
          contentHash: typeof source.contentHash === 'string' ? source.contentHash.slice(0, 128) : '',
          truncated: source.truncated === true,
          scriptsPresent: source.scriptsPresent === true
        }))
      : [],
    contextDiscarded: Array.isArray(value.contextDiscarded)
      ? value.contextDiscarded.filter(isRecord).slice(0, 80).map((source, index) => ({
          id: typeof source.id === 'string' ? source.id : `discarded-context-${index + 1}`,
          kind: source.kind === 'project-instructions' || source.kind === 'skill' || source.kind === 'legacy-memory'
            ? source.kind
            : 'skill',
          uri: typeof source.uri === 'string' ? source.uri : undefined,
          reason: normalizeRunContextDiscardReason(source.reason),
          keptId: typeof source.keptId === 'string' ? source.keptId : undefined
        }))
      : [],
    contextDeduplication: isRecord(value.contextDeduplication)
      ? {
          before: normalizeNonNegativeInteger(value.contextDeduplication.before),
          after: normalizeNonNegativeInteger(value.contextDeduplication.after),
          discarded: normalizeNonNegativeInteger(value.contextDeduplication.discarded),
          truncated: value.contextDeduplication.truncated === true
      }
      : undefined,
    outputBudgets: Array.isArray(value.outputBudgets)
      ? value.outputBudgets.slice(-32).flatMap((item) => { const budget = normalizeRequestBudget(item); return budget ? [budget] : []; }) : undefined,
    outputTruncation: isRecord(value.outputTruncation) && value.outputTruncation.toolsExecuted === 0
      && typeof value.outputTruncation.finishReason === 'string' && typeof value.outputTruncation.requestId === 'string'
      ? { finishReason: value.outputTruncation.finishReason.slice(0, 80), requestId: value.outputTruncation.requestId.slice(0, 256), toolsExecuted: 0 } : undefined,
    cache: normalizeRunDetailsCache(value.cache),
    historySummaries: Array.isArray(value.historySummaries)
      ? value.historySummaries.filter(isRecord).slice(0, 32).map((summary) => ({
          modelId: typeof summary.modelId === 'string' && summary.modelId.trim() ? summary.modelId.trim() : undefined,
          sourceId: typeof summary.sourceId === 'string' && summary.sourceId.trim() ? summary.sourceId.trim() : undefined,
          provider: typeof summary.provider === 'string' && summary.provider.trim() ? summary.provider.trim() : undefined,
          createdAt: normalizeSessionTimestamp(summary.createdAt, new Date().toISOString())
        }))
      : undefined,
    contextEpochs: Array.isArray(value.contextEpochs)
      ? value.contextEpochs.filter(isRecord).slice(0, 128).map((epoch) => ({
          index: normalizeNonNegativeInteger(epoch.index),
          reason: typeof epoch.reason === 'string' ? epoch.reason.slice(0, 120) : 'unknown',
          estimatedPromptTokens: normalizeNonNegativeInteger(epoch.estimatedPromptTokens),
          afterEstimatedPromptTokens: typeof epoch.afterEstimatedPromptTokens === 'number'
            ? normalizeNonNegativeInteger(epoch.afterEstimatedPromptTokens) : undefined,
          actualPromptTokens: typeof epoch.actualPromptTokens === 'number'
            ? normalizeNonNegativeInteger(epoch.actualPromptTokens) : undefined,
          declaredWindowTokens: normalizeNonNegativeInteger(epoch.declaredWindowTokens),
          learnedEffectiveWindowTokens: normalizeNonNegativeInteger(epoch.learnedEffectiveWindowTokens),
          reusablePrefixTokensEstimate: typeof epoch.reusablePrefixTokensEstimate === 'number'
            ? normalizeNonNegativeInteger(epoch.reusablePrefixTokensEstimate) : undefined,
          estimatedCacheResetTokens: typeof epoch.estimatedCacheResetTokens === 'number'
            ? normalizeNonNegativeInteger(epoch.estimatedCacheResetTokens) : undefined,
          summaryKind: epoch.summaryKind === 'model' ? 'model' as const : 'host_fallback' as const
        }))
      : undefined,
    budgetStopReason: typeof value.budgetStopReason === 'string' ? value.budgetStopReason.slice(0, 120) : undefined,
    budgetPause: isRecord(value.budgetPause)
      && value.budgetPause.kind === 'explicit_tool_budget'
      && value.budgetPause.resumable === true
      ? {
          kind: 'explicit_tool_budget' as const,
          resumable: true as const,
          segment: normalizeNonNegativeInteger(value.budgetPause.segment)
        }
      : undefined,
    failureReason: typeof value.failureReason === 'string' ? value.failureReason.slice(0, 500) : undefined,
    traceLogUri: typeof value.traceLogUri === 'string' ? value.traceLogUri : undefined,
    truncated: value.truncated === true
  };
}

function normalizeRunDetailsCache(
  value: unknown
): NonNullable<ChatMessage['runDetails']>['cache'] {
  if (!isRecord(value)) {
    return undefined;
  }
  const providerDataStatus = value.providerDataStatus === 'reported'
    || value.providerDataStatus === 'partial'
    || value.providerDataStatus === 'unavailable'
    ? value.providerDataStatus
    : 'unavailable';
  return {
    cacheHitTokens: typeof value.cacheHitTokens === 'number' && value.cacheHitTokens >= 0
      ? Math.floor(value.cacheHitTokens)
      : undefined,
    cacheMissTokens: typeof value.cacheMissTokens === 'number' && value.cacheMissTokens >= 0
      ? Math.floor(value.cacheMissTokens)
      : undefined,
    hitRate: typeof value.hitRate === 'number' && value.hitRate >= 0
      ? Math.min(100, value.hitRate)
      : undefined,
    providerDataStatus,
    cacheLaneChanged: value.cacheLaneChanged === true,
    cacheMissPossibleReasons: Array.isArray(value.cacheMissPossibleReasons)
      ? value.cacheMissPossibleReasons.filter((reason): reason is string => typeof reason === 'string' && Boolean(reason.trim())).slice(0, 16)
      : []
  };
}

function normalizeRunContextDiscardReason(
  value: unknown
): NonNullable<ChatMessage['runDetails']>['contextDiscarded'][number]['reason'] {
  switch (value) {
    case 'duplicate_uri':
    case 'duplicate_content':
    case 'duplicate_skill':
    case 'ambiguous_name':
    case 'budget_exhausted':
    case 'workspace_untrusted':
    case 'disabled':
    case 'implicit_not_allowed':
    case 'not_matched':
    case 'implicit_limit':
    case 'load_failed':
      return value;
    default:
      return 'load_failed';
  }
}

function normalizeRunDetailsTaskPlan(value: unknown): NonNullable<ChatMessage['runDetails']>['taskPlan'] {
  if (!isRecord(value) || typeof value.goal !== 'string') {
    return undefined;
  }
  const status = value.status === 'running'
    || value.status === 'blocked'
    || value.status === 'completed'
    || value.status === 'failed'
    || value.status === 'stopped'
    ? value.status
    : 'failed';
  return {
    status,
    goal: value.goal.slice(0, 320),
    updateCount: normalizeNonNegativeInteger(value.updateCount),
    completedSteps: normalizeNonNegativeInteger(value.completedSteps),
    totalSteps: normalizeNonNegativeInteger(value.totalSteps),
    blockers: normalizeStringArray(value.blockers).slice(0, 10)
  };
}

function normalizeAuthorizationSource(value: unknown): NonNullable<ChatMessage['runDetails']>['authorizations'][number]['source'] {
  return value === 'low_risk'
    || value === 'run_policy'
    || value === 'configuration'
    || value === 'model_reviewer'
    || value === 'delegated_approver'
    || value === 'explicit_confirmation'
    || value === 'user_denied'
    ? value
    : 'user_denied';
}

function normalizeChangeSetStatus(value: unknown): NonNullable<ChatMessage['runDetails']>['changeSets'][number]['status'] {
  return value === 'pending'
    || value === 'partially_applied'
    || value === 'applied'
    || value === 'partially_failed'
    || value === 'uncertain'
    || value === 'reverted'
    || value === 'superseded'
    || value === 'discarded'
    ? value
    : 'pending';
}

function normalizeChangeSetFileStatus(value: unknown): NonNullable<NonNullable<ChatMessage['runDetails']>['changeSets'][number]['files']>[number]['status'] {
  return value === 'applied'
    || value === 'superseded'
    || value === 'discarded'
    || value === 'apply_failed'
    || value === 'reverted'
    || value === 'revert_failed'
    ? value
    : 'pending';
}

function normalizeDraftEditAction(value: unknown): NonNullable<NonNullable<ChatMessage['runDetails']>['changeSets'][number]['files']>[number]['action'] {
  return value === 'create' || value === 'delete' || value === 'move' ? value : 'modify';
}

function cloneRunDetails(details: NonNullable<ChatMessage['runDetails']>): NonNullable<ChatMessage['runDetails']> {
  return normalizeRunDetails(details) ?? details;
}

function normalizeNonNegativeInteger(value: unknown): number {
  return normalizePositiveInteger(value, 0);
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const normalized = item.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeMessageUsedSkills(value: unknown): ChatMessage['usedSkills'] {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const usedSkills = value
    .filter(isRecord)
    .map((item) => {
      const id = typeof item.id === 'string' ? item.id.trim() : '';
      const name = typeof item.name === 'string' ? item.name.trim() : '';
      const source = item.source === 'workspace'
        || item.source === 'agentsWorkspace'
        || item.source === 'user'
        || item.source === 'agentsUser'
        || item.source === 'admin'
        || item.source === 'builtin'
        || item.source === 'codexPlugin'
        ? item.source
        : undefined;
      return id && name && source ? { id, name, source } : undefined;
    })
    .filter((item): item is NonNullable<ChatMessage['usedSkills']>[number] => Boolean(item));
  return usedSkills.length ? usedSkills : undefined;
}

function normalizeMessageContextMeta(value: unknown): ChatMessageContextMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const isProtected = value.isProtected === true;
  const protectedReason = typeof value.protectedReason === 'string' && value.protectedReason.trim()
    ? value.protectedReason.trim()
    : undefined;
  const displayKind = value.displayKind === 'draft_run_auto_continue'
    || value.displayKind === 'delegated_auto_continue'
    || value.displayKind === 'plan_execution_continuation'
    || value.displayKind === 'budget_auto_continue'
    ? value.displayKind
    : undefined;
  return isProtected || protectedReason || displayKind
    ? {
        isProtected,
        protectedReason,
        displayKind
      }
    : undefined;
}

function normalizeContextCompressionState(value: unknown): ContextCompressionState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const summaries = Array.isArray(value.summaries)
    ? value.summaries.map(normalizeHistorySummary).filter((summary): summary is HistorySummary => Boolean(summary))
    : [];
  const protectedMessageIds = Array.isArray(value.protectedMessageIds)
    ? Array.from(new Set(value.protectedMessageIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))))
    : [];
  const lastCompressedAt = normalizeOptionalTimestamp(value.lastCompressedAt);
  const lastFailureReason = typeof value.lastFailureReason === 'string' && value.lastFailureReason.trim()
    ? value.lastFailureReason.trim()
    : undefined;

  const lifecycle = isRecord(value.protectionState) && value.protectionState.version === 1 ? value.protectionState : undefined;
  const ids = (v: unknown) => Array.isArray(v) ? [...new Set(v.filter((id): id is string => typeof id === 'string' && !!id))] : [];
  const protectionState = lifecycle ? { version: 1 as const, pendingMessageIds: ids(lifecycle.pendingMessageIds), settledMessageIds: ids(lifecycle.settledMessageIds),
    settledFacts: normalizeHistoryWorkFacts(lifecycle.settledFacts) } : undefined;
  const attempt = value.lastCompression;
  const lastCompression = isRecord(attempt) && attempt.version === 1 && typeof attempt.fingerprint === 'string'
    && /^[a-f0-9]{64}$/u.test(attempt.fingerprint)
    && ['beforeTokens', 'afterTokens', 'netReleasedTokens', 'durationMs', 'protectedCount', 'compressibleCount'].every(key => typeof attempt[key] === 'number' && Number.isFinite(attempt[key]))
    ? { version: 1 as const, fingerprint: attempt.fingerprint, beforeTokens: Number(attempt.beforeTokens), afterTokens: Number(attempt.afterTokens),
      netReleasedTokens: Number(attempt.netReleasedTokens), durationMs: Number(attempt.durationMs), protectedCount: Number(attempt.protectedCount),
      compressibleCount: Number(attempt.compressibleCount), costKnown: attempt.costKnown === true } : undefined;
  if (!summaries.length && !protectedMessageIds.length && !lastCompressedAt && !lastFailureReason && !protectionState && !lastCompression) {
    return undefined;
  }

  return {
    version: normalizePositiveInteger(value.version, 1),
    summaries,
    protectedMessageIds,
    lastCompressedAt,
    lastFailureReason,
    protectionState, lastCompression
  };
}

function normalizeRepairLoopState(value: unknown): RepairLoopState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const statuses: RepairLoopState['status'][] = [
    'idle',
    'validation_failed',
    'reading_problems',
    'generating_repair',
    'waiting_for_apply',
    'ready_for_validation',
    'running_validation',
    'completed',
    'blocked'
  ];
  const status = statuses.includes(value.status as RepairLoopState['status'])
    ? value.status as RepairLoopState['status']
    : undefined;
  if (!status) {
    return undefined;
  }
  const scripts = ['compile', 'lint', 'test'];
  const stopReasons: NonNullable<RepairLoopState['stopReason']>[] = [
    'waiting_for_apply',
    'repair_iteration_limit',
    'validation_passed',
    'authorization_denied',
    'repair_discarded'
  ];
  return {
    status,
    iteration: normalizePositiveInteger(value.iteration, 0),
    maxIterations: normalizePositiveInteger(value.maxIterations, 2),
    lastValidationScript: scripts.includes(String(value.lastValidationScript))
      ? value.lastValidationScript as RepairLoopState['lastValidationScript']
      : undefined,
    lastFailureSummary: typeof value.lastFailureSummary === 'string'
      ? value.lastFailureSummary.slice(0, 1000)
      : undefined,
    pendingDraftEditIds: normalizeStringArray(value.pendingDraftEditIds),
    stopReason: stopReasons.includes(value.stopReason as NonNullable<RepairLoopState['stopReason']>)
      ? value.stopReason as RepairLoopState['stopReason']
      : undefined
  };
}

function normalizeHistorySummary(value: unknown): HistorySummary | undefined {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.content !== 'string') {
    return undefined;
  }
  const now = new Date().toISOString();
  const content = value.content.trim();
  if (!content) {
    return undefined;
  }
  return {
    id: value.id,
    content,
    coveredMessageIds: Array.isArray(value.coveredMessageIds)
      ? Array.from(new Set(value.coveredMessageIds.filter((id): id is string => typeof id === 'string' && Boolean(id.trim()))))
      : [],
    createdAt: normalizeSessionTimestamp(value.createdAt, now),
    updatedAt: normalizeSessionTimestamp(value.updatedAt, normalizeSessionTimestamp(value.createdAt, now)),
    tokenEstimate: normalizePositiveInteger(value.tokenEstimate, 0),
    modelId: typeof value.modelId === 'string' && value.modelId.trim() ? value.modelId.trim() : undefined,
    sourceId: typeof value.sourceId === 'string' && value.sourceId.trim() ? value.sourceId.trim() : undefined,
    provider: typeof value.provider === 'string' && value.provider.trim() ? value.provider.trim() : undefined,
    provenance: normalizeSummaryProvenance(value.provenance),
    version: normalizePositiveInteger(value.version, 1)
  };
}

function normalizeSummaryProvenance(value: unknown): HistorySummary['provenance'] {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.messageHashes) || !isRecord(value.summaryHashes)) return undefined;
  const hashes = (input: Record<string, unknown>): Record<string, string> | undefined => {
    const entries = Object.entries(input);
    if (entries.some(([id, hash]) => !id || typeof hash !== 'string' || !/^[a-f0-9]{64}$/u.test(hash))) return undefined;
    return Object.fromEntries(entries) as Record<string, string>;
  };
  const messageHashes = hashes(value.messageHashes);
  const summaryHashes = hashes(value.summaryHashes);
  return messageHashes && summaryHashes ? { version: 1, messageHashes, summaryHashes } : undefined;
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

function normalizeOptionalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  return Number.isFinite(Date.parse(value)) ? value : undefined;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    return fallback;
  }
  return Math.floor(number);
}

function getUriLabel(uri: vscode.Uri): string {
  const path = uri.fsPath || uri.path;
  const normalized = path.replace(/[\\/]+$/u, '');
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return index >= 0 ? normalized.slice(index + 1) : normalized || uri.toString();
}

function normalizeProjectScopeUri(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 8192) return undefined;
  try { const uri = vscode.Uri.parse(value); return uri.scheme === 'file' && uri.path.startsWith('/') ? uri.toString() : undefined; }
  catch { return undefined; }
}

async function measureSessionSelection<T>(stage: string, sessionId: string, work: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const session = createHash('sha256').update(sessionId).digest('hex').slice(0, 12);
  console.info('[KeepSeek] interaction_stage', { stage, session, event: 'begin' });
  try {
    const result = await work();
    console.info('[KeepSeek] interaction_stage', { stage, session, event: 'end', elapsedMs: Math.max(0, performance.now() - started) });
    return result;
  } catch (error) {
    console.info('[KeepSeek] interaction_stage', { stage, session, event: 'failed', elapsedMs: Math.max(0, performance.now() - started) });
    throw error;
  }
}
