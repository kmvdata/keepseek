import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { KeepseekChatViewProvider } from './KeepseekChatViewProvider';
import type { WebviewMessage } from './webviewMessages';
import { ChatSessionStore, getVisibleMessages } from '../sessions/chatSessionStore';
import { ProjectTaskService, type ProjectTaskCard, type TaskActionIdentity, type TaskDefaultsSnapshot } from '../tasks/projectTasks';
import type { TaskExecutionContext, TaskExecutionDriver } from '../tasks/taskRuntime';
import { ProjectExecutionOwner } from '../tasks/projectOwner';
import { ProjectResourceCoordinator, runProjectExecution } from '../tasks/projectResources';
import type { ProjectTaskRouterHost, ProjectTaskRouterSummary, ProjectTaskRouterContext } from '../agent/taskRouter';
import type { KeepseekExtensionInfo, ChatMessage, ContextUsageEstimate, TaskContextUsageOrigin } from '../shared/types';
import { TaskUsageSnapshotTracker, taskUsageLaneFingerprint } from '../tasks/taskUsageSnapshot';
import { writeJsonAtomic } from '../shared/atomicStorage';
import { ProjectRequestAdmission } from '../tasks/requestAdmission';
import type { SharedProjectSources } from '../context/sharedProjectSources';
import type { SkillStore } from '../skills/skillStore';
import { watch, type FSWatcher } from 'node:fs';
import { isAbsolute } from 'node:path';

export interface ProjectAssistantOptions {
  owner: ProjectExecutionOwner;
  resources: ProjectResourceCoordinator;
  admission: ProjectRequestAdmission;
  windowId?: string;
}

export interface ProjectWorkerBinding {
  taskCardId: string;
  hostId: string;
  runtimeId: string;
  snapshot: TaskDefaultsSnapshot;
  router: boolean;
  onSnapshotChanged?(snapshot: TaskDefaultsSnapshot): Promise<void>;
  sources?: SharedProjectSources;
  skills?: SkillStore;
  hasPendingSupplement(inputId: string, rootTaskId: string): boolean;
  routerEvents?(): { ids: string[]; tail: string };
  consumeEvents?(ids: string[], inputId: string): Promise<void>;
  publish(message: unknown): void;
}

interface DraftRecord {
  targetId: string;
  revision: number;
  markup: string;
  cursor?: unknown;
  scrollTop?: number;
  expanded?: unknown;
  skillIds?: string[];
  scrollAnchor?: unknown;
}

interface HostOptions extends ProjectAssistantOptions {
  extensionUri: vscode.Uri;
  storageUri: vscode.Uri;
  sessionStore: ChatSessionStore;
  skillState: vscode.Memento;
  extensionInfo: KeepseekExtensionInfo;
  defaults(): TaskDefaultsSnapshot;
  publish(message: unknown): void;
  sources: SharedProjectSources;
  skills?: SkillStore;
  legacyBusy?(sessionId: string): boolean;
  stopLegacy?(): Promise<void>;
}

const ACTIVE = new Set(['queued', 'preparing', 'running', 'waiting', 'settling', 'stopping']);
const ACTIONS = new Set(['sendPrompt', 'abortPrompt', 'startBackgroundRun', 'resumeBackgroundRun', 'applyDraftEdit', 'discardDraftEdit', 'applyChangeSet', 'discardChangeSet', 'revertDraftEdit', 'revertChangeSet',
  'applyAllDraftEdits', 'runDraftRun', 'runAllDraftRuns', 'confirmManualToolApproval', 'resolveManualApproval', 'resumeApprovalProcessing',
  'authorizeDraftRunCwd', 'authorizeExternalTool', 'continueAgentTask', 'continueTask', 'executePlan', 'resolvePlanDecision',
  'editUserPrompt', 'openDraftDiff', 'openDraftEditFile', 'loadOlderMessages', 'setApprovalMode', 'setExecutionMode']);

/** Views select a transcript; each driver owns a separate Provider/Runner and a
 * fixed session store. No callback consults the selected view to find its owner. */
export class ProjectAssistantHost {
  readonly tasks: ProjectTaskService;
  private readonly routerTasks: ProjectTaskService;
  private readonly workers = new Map<string, Promise<KeepseekChatViewProvider>>();
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly runtimeId = randomUUID();
  private readonly viewDraftUri: vscode.Uri;
  private draftWriter: Promise<unknown> = Promise.resolve();
  private viewTaskId: string | null = null;
  private viewMode: 'project' | 'new' | 'task' | 'legacy' = 'project';
  private generation = 0;
  private revision = 0;
  private initialized = false;
  private disposed = false;
  private draftTimer?: ReturnType<typeof setTimeout>;
  private readonly metrics: Array<{ stage: string; elapsedMs: number; taskCardId?: string; generation: number }> = [];
  private readonly viewClicks = new Map<number, number>();
  private readonly taskPins = new Map<string, () => void>();
  private projectStore?: ChatSessionStore;
  private readonly sessionStores = new Map<string, Promise<ChatSessionStore>>();
  private observerWatcher?: FSWatcher;
  private observerRefresh?: Promise<void>;
  private readonly storageBase: vscode.Uri;
  private trimming?: Promise<void>;
  private readonly drainingWorkers = new Map<string, Promise<void>>();
  private readonly liveAccounting = new Map<string, { usedMs?: number; costByCurrency?: Record<string, number>; requestCount?: number; incomplete?: boolean }>();
  private viewPage?: { taskCardId: string; generation: number; startIndex: number; totalMessages: number; messages: ChatMessage[] };
  private readonly routerStopRequests = new Map<string, { taskCardId: string; rootTaskId: string; generation: number; finish(approved: boolean): void }>();
  private shutdown?: Promise<void>;
  private readonly contextUsage: TaskUsageSnapshotTracker;
  private readonly contextUsageUri: vscode.Uri;
  private contextUsagePublishTimer?: ReturnType<typeof setTimeout>;
  private contextUsageSaveTimer?: ReturnType<typeof setTimeout>;
  private contextUsageWriter: Promise<void> = Promise.resolve();
  private contextUsageDirty = false;
  private contextUsageDiagnostic?: string;

  constructor(private readonly options: HostOptions) {
    const base = vscode.Uri.joinPath(options.storageUri, 'project-assistant', options.owner.projectId);
    this.storageBase = base;
    this.contextUsage = new TaskUsageSnapshotTracker(options.owner.projectId, this.runtimeId);
    this.contextUsageUri = vscode.Uri.joinPath(base, 'task-context-usage.json');
    // Drafts belong to the window, and never confer project execution rights.
    const windowKey = options.windowId || vscode.env.sessionId || this.runtimeId;
    this.viewDraftUri = vscode.Uri.joinPath(base, 'views', `${windowKey}.json`);
    const service = (router: boolean) => new ProjectTaskService({
      projectId: options.owner.projectId,
      storageUri: router ? vscode.Uri.joinPath(base, 'router') : base,
      maxWorkers: router ? 1 : 2,
      allowQueuedFollowups: router,
      settleFailedInputs: router,
      assertExecutionOwner: () => options.owner.verify(),
      createSession: async (snapshot, sessionId) => {
        const store = await this.storeForSession(sessionId);
        if (await store.loadSessionById(sessionId)) return;
        await store.createDetachedSession({ id: sessionId,
          title: router ? 'KeepSeek' : undefined, approvalMode: snapshot.approvalMode,
          executionMode: snapshot.executionMode, projectScopeUri: snapshot.cwdUri ?? snapshot.rootUri,
          ...(router ? { agentRole: { kind: 'project-router', version: 1, toolSchemaVersion: 1 } as const } : {}) });
      },
      driverFactory: card => this.driver(card, router),
      onChange: () => { if (this.initialized) { this.syncPins(); this.publish(); void this.trimWorkers();
        if (!router && !this.tasks.list().some(card => ACTIVE.has(card.state))) void this.saveContextUsage(); } }
    });
    this.tasks = service(false);
    this.routerTasks = service(true);
    Object.defineProperty(this.routerHost, 'projectId', { get: () => options.owner.projectId });
  }

  async initialize(): Promise<void> {
    this.projectStore = await this.options.sessionStore.createWorkspaceScope({ key: `project:${this.options.owner.projectId}`,
      name: 'KeepSeek', folderUris: [isAbsolute(this.options.owner.canonicalRoot)
        ? vscode.Uri.file(this.options.owner.canonicalRoot).toString() : this.options.owner.canonicalRoot] });
    await Promise.all([this.tasks.initialize({ readOnly: !this.options.owner.isOwner }), this.routerTasks.initialize({ readOnly: !this.options.owner.isOwner })]);
    await this.loadContextUsage();
    try {
      const raw = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.viewDraftUri))) as { version: number; drafts: DraftRecord[]; viewTaskId?: string; viewMode?: string };
      if (raw.version === 1 && Array.isArray(raw.drafts)) for (const draft of raw.drafts) {
        if (typeof draft.targetId === 'string' && typeof draft.markup === 'string' && Number.isSafeInteger(draft.revision)) this.drafts.set(draft.targetId, draft);
      }
      if (raw.viewMode === 'task' && raw.viewTaskId && this.tasks.get(raw.viewTaskId)) { this.viewTaskId = raw.viewTaskId; this.viewMode = 'task'; }
      else if (raw.viewMode === 'new' || raw.viewMode === 'legacy') this.viewMode = raw.viewMode;
    } catch (error) { if (!isMissing(error)) this.options.publish({ type: 'projectTaskError', reason: errorText(error) }); }
    this.initialized = true;
    this.syncPins(); this.publish();
    void this.showView().catch(error => this.options.publish({ type: 'projectTaskError', reason: errorText(error) }));
    const recent = this.tasks.list().filter(card => !card.archived).slice(-2).map(card => card.sessionId);
    void Promise.all(recent.map(async id => (await this.storeForSession(id)).prefetchSessionPages([id]))).catch(() => undefined);
    if (!this.options.owner.isOwner && this.storageBase.scheme === 'file') {
      try {
        const watcher = watch(this.storageBase.fsPath, { recursive: false }, () => { void this.refreshObserver(); });
        this.observerWatcher = watcher;
        watcher.on('error', error => {
          watcher.close();
          if (this.observerWatcher === watcher) this.observerWatcher = undefined;
          if (!this.disposed) this.options.publish({ type: 'projectTaskError', reason: errorText(error) });
        });
      }
      catch { /* ready/explicit view still refreshes read-only snapshots */ }
    }
  }

  get viewingTask(): boolean { return this.viewMode !== 'legacy'; }
  get selectedTaskId(): string | null { return this.viewTaskId; }
  isTaskSession(sessionId: string): boolean { return this.tasks.list().some(card => card.sessionId === sessionId); }
  revokeSource(sourceId: string): void {
    for (const [service, cards] of [[this.tasks, this.tasks.list()], [this.routerTasks, this.routerTasks.list()]] as const) {
      for (const card of cards) if (card.snapshot.sourceId === sourceId) {
        if (service === this.tasks) {
          this.contextUsage.invalidate(card.taskCardId); this.contextUsageDirty = true;
          this.scheduleContextUsage();
        }
        void this.workers.get(card.taskCardId)?.then(worker => worker.invalidateProjectSource(sourceId));
        if (this.options.owner.isOwner) void service.stop(card.taskCardId).catch(error => this.options.publish({ type: 'projectTaskError', reason: errorText(error) }));
      }
    }
  }

  async handleMessage(message: WebviewMessage): Promise<boolean> {
    const data = message as WebviewMessage & Record<string, unknown>;
    if (data.projectId && data.projectId !== this.options.owner.projectId) return true;
    if (message.type === 'ready') { if (this.initialized) { await this.refreshObserver(); this.publish(); await this.showView(); } return false; }
    if (['selectSession', 'createSession', 'newSession'].includes(message.type)) {
      const card = this.tasks.list().find(card => card.sessionId === data.sessionId);
      if (card) { await this.selectView(card.taskCardId, 'task'); return true; }
      this.viewMode = 'legacy'; this.viewTaskId = null; this.publish(); return false;
    }
    if (!message.type.startsWith('project')) {
      if (message.type === 'loadOlderMessages' && this.viewingTask) { await this.loadEarlierView(); return true; }
      if (['saveModelSource', 'deleteModelSource', 'refreshSourceModels', 'testSourceConnection', 'setLanguage', 'saveHistorySettings',
        'setDefaultModel', 'setModelEnabled', 'setModelContextWindow', 'setModelMaxOutput'].includes(message.type)) return false;
      const explicitCard = typeof data.sessionId === 'string' ? this.tasks.list().find(card => card.sessionId === data.sessionId) : undefined;
      if (explicitCard && ['regenerateSessionTitle', 'renameSession'].includes(message.type)) {
        if (!this.options.owner.isOwner) { this.rejectReadOnlyAction(data, explicitCard); return true; }
        await this.inExecution(explicitCard, async () => (await this.worker(explicitCard, false)).handleProjectMessage(message));
        if (message.type === 'renameSession' && typeof data.title === 'string') await this.tasks.rename(explicitCard.taskCardId, data.title);
        return true;
      }
      if (message.type === 'deleteSessions' && Array.isArray(data.sessionIds) && data.sessionIds.some(id => this.tasks.list().some(card => card.sessionId === id))) {
        this.options.publish({ type: 'projectTaskError', reason: 'Delete an associated session from its task card after stopping it. / 请先停止任务，再从任务卡永久删除关联会话。' });
        return true;
      }
      if ((this.viewMode === 'task' || data.taskCardId) && (ACTIONS.has(message.type) || data.taskCardId)) {
        const cardId = typeof data.taskCardId === 'string' ? data.taskCardId : this.viewTaskId;
        const card = cardId ? this.tasks.get(cardId) : undefined;
        // Buttons bind their originating task/session. A late click cannot act
        // on the newly viewed card. Legacy unstamped mutation buttons fail closed.
        if (!card || data.sessionId && data.sessionId !== card.sessionId || isMutation(message.type) && !data.taskCardId) {
          if (message.type === 'sendPrompt' || message.type === 'editUserPrompt') this.options.publish({ type: 'submissionResult',
            requestId: data.requestId, sessionId: data.sessionId ?? card?.sessionId, status: 'rejected',
            reason: 'Task target is missing or stale. Reopen the task and send again. / 任务目标缺失或已过期，请重新打开任务后发送。' });
          else this.options.publish({ type: 'projectTaskError', reason: 'Task target is missing or stale. / 任务目标缺失或已过期。' });
          return true;
        }
        if (!this.options.owner.isOwner) { this.rejectReadOnlyAction(data, card); return true; }
        if (['startBackgroundRun', 'resumeBackgroundRun'].includes(message.type)) {
          this.options.publish({ type: 'projectTaskError', reason: 'Use a task card for project execution. / 请使用任务卡执行项目工作。' });
          return true;
        }
        if (message.type === 'abortPrompt') { await this.tasks.stop(card.taskCardId); return true; }
        if (message.type === 'continueAgentTask') { await this.tasks.resume(card.taskCardId); return true; }
        if (message.type === 'sendPrompt') {
          const running = ACTIVE.has(card.state);
          try {
            if (typeof data.prompt !== 'string' || running && data.rootTaskId !== card.rootTaskId) throw new Error('Reopen this task before sending to its current run. / 请重新打开此任务，再向当前运行发送输入。');
            await this.tasks.submitInput(card.taskCardId, { requestId: String(data.requestId ?? ''), content: data.prompt,
              kind: running ? 'supplement' : 'followup', rootTaskId: running ? card.rootTaskId : undefined,
              references: Array.isArray(data.references) ? data.references : [], skillIds: Array.isArray(data.skillIds) ? data.skillIds as string[] : undefined });
            this.options.publish({ type: 'submissionResult', requestId: data.requestId, sessionId: card.sessionId, status: 'accepted' });
          } catch (error) { this.options.publish({ type: 'submissionResult', requestId: data.requestId, sessionId: card.sessionId, status: 'rejected', reason: errorText(error) }); }
          return true;
        }
        if (message.type === 'editUserPrompt') {
          try {
            const requestId = typeof data.requestId === 'string' ? data.requestId : '';
            if (typeof data.messageId !== 'string' || typeof data.prompt !== 'string') throw new Error('Invalid edit target');
            await this.tasks.submitInput(card.taskCardId, { requestId, content: data.prompt, kind: 'followup',
              replaceMessageId: data.messageId, references: Array.isArray(data.references) ? data.references : [],
              skillIds: Array.isArray(data.skillIds) ? data.skillIds as string[] : undefined });
            await this.tasks.markDependentsStale(card.taskCardId);
            this.options.publish({ type: 'submissionResult', requestId, sessionId: card.sessionId, status: 'accepted',
              projectId: this.options.owner.projectId, taskCardId: card.taskCardId });
          } catch (error) {
            this.options.publish({ type: 'submissionResult', requestId: data.requestId, sessionId: card.sessionId,
              status: 'failed', reason: errorText(error), projectId: this.options.owner.projectId, taskCardId: card.taskCardId });
          }
          return true;
        }
        const worker = await this.worker(card, false);
        await this.inExecution(card, () => worker.handleProjectMessage(message));
        return true;
      }
      return false;
    }
    if (!this.initialized) return true;
    if (data.projectId && data.projectId !== this.options.owner.projectId) return true;
    try {
      switch (message.type) {
        case 'projectTaskView':
          await this.refreshObserver();
          await this.selectView(typeof data.taskCardId === 'string' ? data.taskCardId : null,
            data.mode === 'new' ? 'new' : typeof data.taskCardId === 'string' ? 'task' : 'project', Number(data.viewGeneration)); return true;
        case 'projectTaskLatest':
          if ((data.taskCardId ?? null) === this.viewTaskId && Number(data.viewGeneration) === this.generation) {
            const targetId = this.viewTaskId ?? '$project';
            const draft = this.drafts.get(targetId);
            if (draft) this.drafts.set(targetId, { ...draft, scrollAnchor: null, scrollTop: 0 });
            await this.persistDrafts(); await this.showView(true);
          }
          return true;
        case 'projectTaskDraft':
          await this.saveDraft(data); return true;
        case 'projectTaskPrefetch': {
          const card = typeof data.taskCardId === 'string' ? this.tasks.get(data.taskCardId) : undefined;
          if (card) void this.storeForSession(card.sessionId).then(store => store.prefetchSessionPages([card.sessionId])).catch(() => undefined);
          return true;
        }
        case 'projectTaskPainted': {
          const generation = Number(data.viewGeneration);
          if (generation === this.generation && data.taskCardId === this.viewTaskId) {
            const start = this.viewClicks.get(generation);
            if (start !== undefined) this.record('first_paint', performance.now() - start, this.viewTaskId ?? undefined);
          }
          return true;
        }
        case 'projectTaskCreate': case 'projectTaskSubmit': case 'projectAssistantSubmit':
          await this.submit(data); return true;
        case 'projectTaskReconcile': {
          const targetId = String(data.targetId ?? '$project');
          const candidate = targetId === '$project' ? this.routerTasks.findInputByRequestId(String(data.requestId)) : this.tasks.findInputByRequestId(String(data.requestId));
          const input = candidate && (targetId === candidate.taskCardId || targetId === '$project' || targetId === '$new' && candidate.kind === 'new') ? candidate : undefined;
          this.options.publish({ type: 'projectTaskSubmissionResult', projectId: this.options.owner.projectId,
            requestId: data.requestId, targetId, status: input ? 'accepted' : 'failed', taskCardId: input?.taskCardId,
            reason: input ? undefined : 'Input was not durably accepted. Review the draft before sending. / 输入尚未耐久接收，请核对草稿后发送。' });
          return true;
        }
        case 'projectTaskStop': {
          const card = this.tasks.get(requiredId(data));
          if (!card) throw new Error('Task unavailable / 任务不存在');
          const identity = this.taskActionIdentity(data, card);
          await this.tasks.stop(identity.taskCardId, identity);
          for (const request of [...this.routerStopRequests.values()]) if (request.taskCardId === card.taskCardId
            && request.rootTaskId === card.rootTaskId && request.generation === card.generation) request.finish(true);
          return true;
        }
        case 'projectTaskStopAll': await Promise.all([this.tasks.stopAll(), this.routerTasks.stopAll(), this.options.stopLegacy?.()]); return true;
        case 'projectTaskResume': {
          const identity = this.taskActionIdentity(data, this.tasks.get(requiredId(data)));
          await this.tasks.resume(identity.taskCardId, identity); return true;
        }
        case 'projectTaskArchive': {
          const identity = this.taskActionIdentity(data, this.tasks.get(requiredId(data)));
          await this.tasks.archive(identity.taskCardId, data.archived !== false, identity); return true;
        }
        case 'projectTaskDelete': {
          if (this.options.owner.hasUncertainOperations) throw new Error('Inspect unknown operations before deleting task evidence. / 请先核对未知操作，再删除任务记录。');
          const card = this.tasks.get(requiredId(data));
          if (!card) throw new Error('Task unavailable / 任务不存在');
          const identity = this.taskActionIdentity(data, card);
          await this.tasks.delete(identity.taskCardId, identity);
          const worker = this.workers.get(card.taskCardId);
          if (worker) { this.workers.delete(card.taskCardId); await (await worker).drainProjectRuntime(); }
          await (await this.storeForSession(card.sessionId)).deleteSessions([card.sessionId]);
          this.liveAccounting.delete(card.taskCardId);
          this.contextUsage.remove(card.taskCardId); this.contextUsageDirty = true; void this.saveContextUsage();
          if (this.viewTaskId === card.taskCardId) await this.selectView(null, 'project'); return true;
        }
        case 'projectTaskAssociate': {
          await this.options.owner.verify();
          const session = await this.options.sessionStore.loadSessionById(String(data.sessionId));
          if (!session) throw new Error('Session unavailable / 会话不存在');
          if (this.options.legacyBusy?.(session.id)) throw new Error('Wait for this session to settle before associating it. / 请先等待该会话当前操作结束，再关联任务。');
          if (session.agentRole) throw new Error('A Router session cannot become a Worker.');
          await this.options.sessionStore.persistSession(session.id, 'task_association');
          this.sessionStores.set(session.id, Promise.resolve(this.options.sessionStore));
          const card = await this.tasks.associateSession({ sessionId: session.id, title: session.title,
            ...associationTimes(session),
            snapshot: this.snapshotForSession(session), requestId: `associate:${session.id}` });
          await this.selectView(card.taskCardId, 'task'); return true;
        }
        default: return true;
      }
    } catch (error) {
      if (data.requestId) this.ack(data, 'failed', errorText(error));
      else this.options.publish({ type: 'projectTaskError', reason: errorText(error) });
      return true;
    }
  }

  /** New sidebar actions carry their emission-time Host and full card/run
   * identity. Legacy callers remain readable, and every accepted action still
   * rechecks the captured current identity inside its Registry transaction. */
  private taskActionIdentity(data: Record<string, unknown>, card: ProjectTaskCard | undefined): TaskActionIdentity {
    const expired = () => new Error('The task run changed; reopen it before acting. / 任务运行已变化，请重新打开后操作。');
    if (!card || data.hostId !== undefined && data.hostId !== this.runtimeId) throw expired();
    const identity: TaskActionIdentity = { projectId: card.projectId, taskCardId: card.taskCardId,
      sessionId: card.sessionId, rootTaskId: card.rootTaskId, segmentId: card.segmentId, generation: card.generation };
    for (const key of ['sessionId', 'rootTaskId', 'segmentId', 'generation'] as const) {
      if (data[key] !== undefined && data[key] !== identity[key]) throw expired();
    }
    if (data.hostId !== undefined && (data.sessionId !== card.sessionId || data.rootTaskId !== card.rootTaskId
      || data.segmentId !== card.segmentId || data.generation !== card.generation)) throw expired();
    return identity;
  }

  private async submit(data: Record<string, unknown>): Promise<void> {
    await this.options.owner.verify();
    const requestId = String(data.requestId ?? '');
    const content = typeof data.prompt === 'string' ? data.prompt : '';
    const values = { requestId, content, references: Array.isArray(data.references) ? data.references : [],
      skillIds: Array.isArray(data.skillIds) ? data.skillIds.filter((id): id is string => typeof id === 'string') : undefined };
    const start = performance.now();
    if (data.type === 'projectTaskCreate') {
      const receipt = await this.tasks.createTask({ ...values, snapshot: this.options.defaults() });
      this.ack(data, 'accepted', undefined, receipt.card.taskCardId);
    } else if (data.type === 'projectTaskSubmit') {
      const taskCardId = requiredId(data);
      const card = this.tasks.get(taskCardId);
      if (!card) throw new Error('Task target unavailable / 任务不存在');
      const kind = data.inputKind === 'supplement' ? 'supplement' : 'followup';
      await this.tasks.submitInput(taskCardId, { ...values, kind, rootTaskId: typeof data.rootTaskId === 'string' ? data.rootTaskId : undefined });
      this.ack(data, 'accepted');
    } else {
      let router = this.routerTasks.list()[0];
      if (!router) {
        const snapshot = { ...this.options.defaults(), skillIds: [], approvalMode: 'ask' as const, executionMode: 'normal' as const,
          configuration: { ...this.options.defaults().configuration, role: 'router' } };
        router = (await this.routerTasks.createTask({ ...values, snapshot })).card;
      } else {
        await this.routerTasks.submitInput(router.taskCardId, { ...values,
          kind: 'followup' });
      }
      this.ack(data, 'accepted');
    }
    this.record('input_durable', performance.now() - start, typeof data.taskCardId === 'string' ? data.taskCardId : undefined);
  }

  private ack(data: Record<string, unknown>, status: 'accepted' | 'failed' | 'rejected', reason?: string, taskCardId?: string): void {
    const targetId = data.type === 'projectTaskCreate' ? '$new' : data.type === 'projectAssistantSubmit' ? '$project' : String(data.taskCardId ?? '');
    this.options.publish({ type: 'projectTaskSubmissionResult', projectId: this.options.owner.projectId, requestId: data.requestId,
      targetId, status, reason, taskCardId, draftRevision: data.draftRevision });
  }

  private driver(card: Readonly<ProjectTaskCard>, router: boolean): TaskExecutionDriver {
    return {
      execute: async context => {
        const permit = router ? undefined : await this.options.admission.acquireRoot(context.signal);
        try {
          const worker = await this.worker(card, router);
          return await this.inExecution(card, () => worker.executeProjectInput(context, router ? this.routerHost : undefined), context);
        } finally { permit?.release(); }
      },
      requestBoundary: async () => { (await this.worker(card, router)).requestProjectSupplementBoundary(); },
      revokePendingActions: async (identity, reason) => {
        this.options.resources.invalidate({ sessionId: identity.sessionId, rootTaskId: identity.rootTaskId,
          segmentId: identity.segmentId, runtimeId: `${this.runtimeId}:${identity.generation}` });
        const worker = this.workers.get(card.taskCardId);
        if (worker) (await worker).revokeProjectActions(reason);
      }
    };
  }

  private async worker(card: Readonly<ProjectTaskCard>, router: boolean): Promise<KeepseekChatViewProvider> {
    let existing = this.workers.get(card.taskCardId);
    if (!existing) {
      if (this.disposed) throw new Error('Project task host is closing. / 项目任务宿主正在关闭。');
      existing = (async () => {
        await this.drainingWorkers.get(card.taskCardId);
        const store = await (await this.storeForSession(card.sessionId)).createSessionScope(card.sessionId);
        const runtimeId = randomUUID();
        this.contextUsage.bindWorker(card.taskCardId, runtimeId);
        return new KeepseekChatViewProvider(this.options.extensionUri, store, this.options.storageUri, this.options.skillState,
          this.options.extensionInfo, Promise.resolve(), undefined, this.options, {
            taskCardId: card.taskCardId, hostId: this.runtimeId, runtimeId, snapshot: card.snapshot, router,
            onSnapshotChanged: async snapshot => {
              const service = router ? this.routerTasks : this.tasks;
              const previous = service.get(card.taskCardId);
              if (!router && previous && taskUsageLaneFingerprint(previous.snapshot) !== taskUsageLaneFingerprint(snapshot)) {
                // Invalidate before Registry publication. Switching A → B → A
                // without another estimate must not resurrect the old A ring.
                this.contextUsage.invalidate(card.taskCardId); this.contextUsageDirty = true;
                this.scheduleContextUsage();
              }
              await service.updateSnapshot(card.taskCardId, snapshot);
            },
            sources: this.options.sources.createSibling(),
            skills: this.options.skills?.createSibling(this.options.skillState),
            hasPendingSupplement: (inputId, rootTaskId) => (router ? this.routerTasks : this.tasks).inputs(card.taskCardId)
              .some(input => input.inputId !== inputId && input.rootTaskId === rootTaskId && input.kind === 'supplement' && ['durable', 'queued'].includes(input.state)),
            ...(router ? { routerEvents: () => this.getRouterEvents(), consumeEvents: (ids: string[], inputId: string) => this.consumeRouterEvents(ids, inputId) } : {}),
            publish: event => this.receiveWorkerEvent(card.taskCardId, router, event)
          });
      })();
      this.workers.set(card.taskCardId, existing);
      void existing.catch(() => { if (this.workers.get(card.taskCardId) === existing) this.workers.delete(card.taskCardId); });
    }
    return existing;
  }

  private inExecution<T>(card: Readonly<ProjectTaskCard>, work: () => T, context?: TaskExecutionContext): T {
    return runProjectExecution({ owner: this.options.owner, resources: this.options.resources,
      scope: { sessionId: card.sessionId, rootTaskId: context?.identity.rootTaskId ?? card.rootTaskId,
        segmentId: context?.identity.segmentId ?? card.segmentId ?? `view:${card.taskCardId}`, runtimeId: `${this.runtimeId}:${context?.identity.generation ?? card.generation}` }, signal: context?.signal,
      admission: this.options.admission, requestRole: card.snapshot.configuration?.role === 'router' ? 'router' : 'worker' }, work);
  }

  private receiveWorkerEvent(taskCardId: string, router: boolean, event: unknown): void {
    if (this.disposed) return;
    let value = event as Record<string, unknown>;
    if (value.type === 'taskContextUsageStart' || value.type === 'taskContextUsage') {
      const card = !router && this.tasks.get(taskCardId);
      if (!card) return;
      const origin = value.origin as TaskContextUsageOrigin;
      if (value.type === 'taskContextUsageStart') {
        if (this.contextUsage.begin(origin, card)) { this.contextUsageDirty = true; this.scheduleContextUsage(); }
      }
      else if (this.contextUsage.accept(origin, Number(value.sequence), value.usage as ContextUsageEstimate, card, String(value.recordedAt))) {
        this.contextUsageDirty = true;
        this.scheduleContextUsage();
      }
      return;
    }
    const state = value.state as { usageMetrics?: { executionTime?: { totalMs?: number; incomplete?: boolean }; sessionUsageStats?: { costByCurrency?: Record<string, number>; requestCount?: number; pricingStatus?: string } } } | undefined;
    const timing = value.type === 'taskTiming' ? value.executionTime as { totalMs?: number; incomplete?: boolean } : state?.usageMetrics?.executionTime;
    const usage = value.type === 'sessionTitleUsageUpdated' ? value.sessionUsageStats as { costByCurrency?: Record<string, number>; requestCount?: number; pricingStatus?: string } : state?.usageMetrics?.sessionUsageStats;
    const accounting = value.projectAccounting as { usedMs?: number; costByCurrency?: Record<string, number>; requestCount?: number; incomplete?: boolean } | undefined;
    if (accounting || timing || usage) {
      const prior = this.liveAccounting.get(taskCardId) ?? {};
      this.liveAccounting.set(taskCardId, accounting ? { ...prior, ...accounting } : { usedMs: timing?.totalMs ?? prior.usedMs,
        costByCurrency: usage?.costByCurrency ?? prior.costByCurrency, requestCount: usage?.requestCount ?? prior.requestCount,
        incomplete: timing?.incomplete || usage?.pricingStatus === 'partial' || usage?.pricingStatus === 'unavailable' });
      if (accounting) { value = { ...value }; delete value.projectAccounting; }
      if (value.type === 'taskTiming' || value.type === 'sessionTitleUsageUpdated') this.publish();
    }
    if (value.type === 'sessionTitleUpdated' && typeof value.title === 'string' && !router) {
      void this.tasks.rename(taskCardId, value.title, value.regenerated === true).catch(() => undefined);
    }
    if (value.state && typeof value.state === 'object') {
      const state = value.state as Record<string, unknown>;
      if (state.sessionSummaries) {
        const summaries = [...this.options.sessionStore.getSessionSummaries(), ...(this.projectStore?.getSessionSummaries() ?? [])];
        value = { ...value, state: { ...state, sessionSummaries: [...new Map(summaries.map(item => [item.id, item])).values()] } };
      }
      if (this.viewPage?.taskCardId === taskCardId && this.viewPage.generation === this.generation
        && this.viewPage.startIndex + this.viewPage.messages.length < this.viewPage.totalMessages) {
        const controls = { ...value.state as Record<string, unknown> };
        delete controls.messages; delete controls.hasOlderMessages;
        value = { ...value, state: controls };
      }
    }
    if (['sessionTitleRegeneration', 'sessionTitleUpdated', 'sessionTitleUsageUpdated', 'changeActionFeedback', 'submissionResult',
      'draftRunCloneFeedback', 'draftRunBatchFeedback', 'draftRunActionFeedback'].includes(String(value.type))) {
      this.options.publish({ ...value, hostId: this.runtimeId, projectId: this.options.owner.projectId, taskCardId });
      return;
    }
    if ((!router && this.viewMode === 'task' && this.viewTaskId === taskCardId) || (router && this.viewMode === 'project')) {
      this.options.publish({ ...value, hostId: this.runtimeId, projectId: this.options.owner.projectId, taskCardId, viewGeneration: this.generation });
    }
  }

  private async selectView(taskCardId: string | null, mode: 'task' | 'new' | 'project', requestedGeneration?: number): Promise<void> {
    const start = performance.now();
    if (taskCardId && !this.tasks.get(taskCardId)) throw new Error('Task unavailable / 任务不存在');
    this.generation = Math.max(this.generation + 1, Number.isSafeInteger(requestedGeneration) ? requestedGeneration! : 0);
    this.viewTaskId = taskCardId; this.viewMode = mode;
    this.viewPage = undefined;
    this.viewClicks.set(this.generation, start);
    this.record('click_feedback', performance.now() - start, taskCardId ?? undefined);
    this.publish(); // Small card/title/draft snapshot before any cold body read.
    void this.persistDrafts().catch(error => this.options.publish({ type: 'projectTaskError', reason: errorText(error) }));
    await this.showView();
  }

  private async showView(forceLatest = false): Promise<void> {
    if (this.disposed) return;
    const generation = this.generation;
    const card = this.viewMode === 'task' && this.viewTaskId ? this.tasks.get(this.viewTaskId)
      : this.viewMode === 'project' ? this.routerTasks.list()[0] : undefined;
    if (!card) { this.publish([]); return; }
    const store = await this.storeForSession(card.sessionId);
    const draft = this.drafts.get(this.viewMode === 'task' ? card.taskCardId : '$project');
    const anchor = draft?.scrollAnchor as { messageId?: unknown } | undefined;
    const page = !forceLatest && typeof anchor?.messageId === 'string'
      ? await store.viewSessionPageAtAnchor(card.sessionId, anchor.messageId) : await store.viewSessionPage(card.sessionId);
    if (this.disposed || generation !== this.generation) return;
    if (page) {
      this.viewPage = { taskCardId: card.taskCardId, generation, startIndex: page.startIndex, totalMessages: page.totalMessages, messages: [...page.messages] };
      this.publish(getVisibleMessages([...page.messages], []), page.startIndex > 0, page.startIndex + page.messages.length < page.totalMessages);
    }
    const worker = this.workers.get(card.taskCardId);
    if (worker) (await worker).publishProjectView();
    else if (this.options.owner.isOwner && this.viewMode === 'task') {
      // Safety records load after the finite transcript. This local preparation
      // performs no model request or project-source scan.
      void this.worker(card, false).then(worker => this.inExecution(card, () => worker.prepareProjectView())).catch(error => {
        if (generation === this.generation) this.options.publish({ type: 'projectTaskError', reason: errorText(error) });
      });
    }
    const start = this.viewClicks.get(generation);
    if (start !== undefined) this.record('host_body_publication', performance.now() - start, card.taskCardId);
  }

  private async loadEarlierView(): Promise<void> {
    const current = this.viewPage;
    if (!current || current.generation !== this.generation || current.startIndex <= 0) return;
    const card = this.tasks.get(current.taskCardId) ?? this.routerTasks.get(current.taskCardId);
    if (!card) return;
    const page = await (await this.storeForSession(card.sessionId)).viewSessionPage(card.sessionId, { before: current.startIndex, limit: 50 });
    if (!page || this.viewPage !== current || this.generation !== current.generation) return;
    const messages = [...page.messages, ...current.messages].slice(0, 200);
    this.viewPage = { ...current, messages, startIndex: page.startIndex };
    this.publish(getVisibleMessages(messages, []), page.startIndex > 0, page.startIndex + messages.length < page.totalMessages);
  }

  private publish(messages?: unknown[], hasOlderMessages?: boolean, hasNewerMessages?: boolean): void {
    if (!this.initialized || this.disposed) return;
    const targetId = this.viewMode === 'task' ? this.viewTaskId! : this.viewMode === 'new' ? '$new' : '$project';
    this.contextUsage.prune(this.tasks.list());
    const cards = this.tasks.list().map(card => {
      const live = this.liveAccounting.get(card.taskCardId);
      const contextUsageSnapshot = this.contextUsage.get(card);
      return live ? { ...card, contextUsageSnapshot, currentEffectiveMs: live.usedMs, usedMs: live.usedMs ?? card.usedMs,
        costByCurrency: live.costByCurrency ?? card.costByCurrency, requestCount: live.requestCount,
        usageIncomplete: card.usageIncomplete || live.incomplete === true } : { ...card, contextUsageSnapshot };
    });
    const start = Math.min(...cards.map(card => Date.parse(card.createdAt)));
    const last = Math.max(...cards.map(card => Date.parse(card.updatedAt)));
    const end = cards.some(card => ACTIVE.has(card.state)) ? Date.now() : last;
    this.options.publish({ type: 'projectTasksState', projectId: this.options.owner.projectId,
      hostId: this.runtimeId,
      contextUsageDiagnostic: this.contextUsageDiagnostic,
      cards, viewTaskId: this.viewTaskId, viewMode: this.viewMode,
      timing: { projectElapsedMs: cards.length ? Math.max(0, end - start) : 0,
        totalEffectiveMs: cards.reduce((sum, card) => sum + card.usedMs, 0),
        incomplete: cards.some(card => card.usageIncomplete || ACTIVE.has(card.state) && !this.liveAccounting.has(card.taskCardId)) },
      routerUsage: this.routerTasks.list().map(card => ({ taskCardId: card.taskCardId, sessionId: card.sessionId,
        ...this.liveAccounting.get(card.taskCardId), costByCurrency: this.liveAccounting.get(card.taskCardId)?.costByCurrency ?? card.costByCurrency })),
      enabled: this.viewMode !== 'legacy',
      viewGeneration: this.generation, revision: ++this.revision, readOnly: !this.options.owner.isOwner,
      reason: this.options.owner.reason, draft: this.drafts.get(targetId) ?? { targetId, revision: 0, markup: '' },
      sessionId: this.viewTaskId ? this.tasks.get(this.viewTaskId)?.sessionId : this.routerTasks.list()[0]?.sessionId,
      ...(messages ? { messages, hasOlderMessages: hasOlderMessages === true, hasNewerMessages: hasNewerMessages === true } : {}), results: this.tasks.events().slice(-20), metrics: this.metrics.slice(-8) });
  }

  private async saveDraft(data: Record<string, unknown>): Promise<void> {
    const targetId = String(data.targetId);
    if (targetId !== '$project' && targetId !== '$new' && !this.tasks.get(targetId)) throw new Error('Invalid draft target');
    const revision = Number(data.revision);
    if (!Number.isSafeInteger(revision) || revision <= (this.drafts.get(targetId)?.revision ?? -1)) return;
    if (typeof data.markup !== 'string' || Buffer.byteLength(data.markup) > 1024 * 1024) throw new Error('Draft exceeds local limit');
    this.drafts.set(targetId, { targetId, revision, markup: data.markup, cursor: data.cursor,
      scrollTop: Number(data.scrollTop) || 0, expanded: data.expanded,
      scrollAnchor: data.scrollAnchor,
      skillIds: Array.isArray(data.skillIds) ? data.skillIds.filter((id): id is string => typeof id === 'string') : [] });
    clearTimeout(this.draftTimer);
    this.draftTimer = setTimeout(() => { void this.persistDrafts().catch(error => this.options.publish({ type: 'projectTaskError', reason: errorText(error) })); }, 100);
  }

  private persistDrafts(): Promise<void> {
    const snapshot = { version: 1, viewTaskId: this.viewTaskId, viewMode: this.viewMode, drafts: [...this.drafts.values()] };
    const operation = this.draftWriter.catch(() => undefined).then(() => writeJsonAtomic(this.viewDraftUri, snapshot));
    this.draftWriter = operation; return operation;
  }

  private scheduleContextUsage(): void {
    if (!this.contextUsagePublishTimer) this.contextUsagePublishTimer = setTimeout(() => {
      this.contextUsagePublishTimer = undefined; this.publish();
    }, 300);
    if (!this.contextUsageSaveTimer) this.contextUsageSaveTimer = setTimeout(() => {
      this.contextUsageSaveTimer = undefined; void this.saveContextUsage();
    }, 1000);
  }

  private async loadContextUsage(): Promise<void> {
    try {
      const value = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(this.contextUsageUri))) as { version?: number; projectId?: string; snapshots?: unknown[] };
      if (value.version !== 1 || value.projectId !== this.options.owner.projectId || !Array.isArray(value.snapshots)) throw new Error('Invalid task context usage metadata');
      this.contextUsage.restore(value.snapshots.slice(0, this.tasks.list().length), this.tasks.list());
    } catch (error) {
      if (!isMissing(error)) this.contextUsageDiagnostic = errorText(error);
    }
  }

  /** Independent lightweight atomic metadata. A failed display save never
   * rejects a submission ACK, stop, execution result or Registry transaction. */
  private saveContextUsage(): Promise<void> {
    clearTimeout(this.contextUsageSaveTimer); this.contextUsageSaveTimer = undefined;
    if (!this.contextUsageDirty || !this.options.owner.isOwner) return this.contextUsageWriter;
    const value = { version: 1, projectId: this.options.owner.projectId, snapshots: this.contextUsage.records(this.tasks.list()) };
    this.contextUsageDirty = false;
    this.contextUsageWriter = this.contextUsageWriter.catch(() => undefined).then(async () => {
      await this.options.owner.verify();
      await writeJsonAtomic(this.contextUsageUri, value);
      this.contextUsageDiagnostic = undefined;
    }).catch(error => {
      this.contextUsageDirty = true;
      this.contextUsageDiagnostic = errorText(error);
      console.warn('[KeepSeek] task context usage save failed', this.contextUsageDiagnostic);
    });
    return this.contextUsageWriter;
  }

  private syncPins(): void {
    for (const card of [...this.tasks.list(), ...this.routerTasks.list()]) {
      const pin = !['completed', 'cancelled'].includes(card.state) || this.tasks.inputs(card.taskCardId).some(input => ['durable', 'queued', 'incorporated'].includes(input.state));
      if (pin && !this.taskPins.has(card.sessionId)) void this.storeForSession(card.sessionId).then(store => {
        if (!this.disposed && !this.taskPins.has(card.sessionId)) this.taskPins.set(card.sessionId, store.pinSession(card.sessionId, 'project_task'));
      }).catch(() => undefined);
      if (!pin && this.taskPins.has(card.sessionId)) { this.taskPins.get(card.sessionId)!(); this.taskPins.delete(card.sessionId); }
    }
  }

  private async storeForSession(sessionId: string): Promise<ChatSessionStore> {
    let store = this.sessionStores.get(sessionId);
    if (!store) {
      store = (async () => {
        const scope = await this.options.sessionStore.findSessionScope(sessionId);
        if (!scope || scope.key === this.projectStore?.workspaceKey) return this.projectStore!;
        if (scope.key === this.options.sessionStore.workspaceKey) return this.options.sessionStore;
        return this.options.sessionStore.createWorkspaceScope(scope);
      })();
      this.sessionStores.set(sessionId, store);
    }
    return store;
  }

  private trimWorkers(): Promise<void> {
    if (this.trimming || this.disposed) return this.trimming ?? Promise.resolve();
    this.trimming = (async () => {
      const idle = this.tasks.list().filter(card => ['completed', 'cancelled'].includes(card.state) && card.taskCardId !== this.viewTaskId
        && this.workers.has(card.taskCardId)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      for (const card of idle.slice(2)) {
        const worker = this.workers.get(card.taskCardId);
        if (!worker) continue;
        // Remove before awaiting so a new input builds a fresh isolated facade.
        // The session writer pin remains until all auxiliary saves settle.
        this.workers.delete(card.taskCardId);
        this.contextUsage.unbindWorker(card.taskCardId);
        const drain = worker.then(worker => worker.drainProjectRuntime());
        this.drainingWorkers.set(card.taskCardId, drain);
        try { await drain; }
        finally { if (this.drainingWorkers.get(card.taskCardId) === drain) this.drainingWorkers.delete(card.taskCardId); }
      }
    })().catch(error => this.options.publish({ type: 'projectTaskError', reason: errorText(error) }))
      .finally(() => { this.trimming = undefined; });
    return this.trimming;
  }

  private snapshotForSession(session: import('../shared/types').ChatSession): TaskDefaultsSnapshot {
    const lane = session.requestProtocol;
    if (!lane?.modelId || !lane.sourceId) return { ...this.options.defaults(),
      approvalMode: session.approvalMode ?? 'ask', executionMode: session.executionMode ?? 'normal' };
    const previous = [...session.messages].reverse().find(message => message.runCheckpoint)?.runCheckpoint?.request.model;
    const model = previous ?? { id: lane.modelId, label: lane.modelId, provider: lane.providerId ?? 'openai' };
    return { sourceId: lane.sourceId, modelId: lane.modelId, wireModel: lane.modelId, protocol: lane.providerId, endpoint: lane.baseUrl,
      approvalMode: session.approvalMode ?? 'ask', executionMode: session.executionMode ?? 'normal', rootUri: session.workspaceFolders?.[0],
      cwdUri: session.projectScopeUri, skillIds: [], configuration: { model } };
  }

  private refreshObserver(): Promise<void> {
    if (this.options.owner.isOwner || !this.initialized) return Promise.resolve();
    return this.observerRefresh ??= Promise.all([this.tasks.reload(), this.routerTasks.reload()]).then(async changes => {
      await this.loadContextUsage();
      this.publish();
      if (changes.some(Boolean)) {
        for (const card of [...this.tasks.list(), ...this.routerTasks.list()]) (await this.storeForSession(card.sessionId)).invalidateSessionView(card.sessionId);
        this.publish(); await this.showView();
      }
    }).catch(error => this.options.publish({ type: 'projectTaskError', reason: errorText(error) })).finally(() => { this.observerRefresh = undefined; });
  }

  private rejectReadOnlyAction(message: Record<string, unknown>, card: Readonly<ProjectTaskCard>): void {
    const reason = this.options.owner.reason ?? 'This window is read-only. / 此窗口为只读。';
    const identity = { hostId: this.runtimeId, projectId: this.options.owner.projectId,
      taskCardId: card.taskCardId, sessionId: card.sessionId, requestId: message.requestId };
    if (message.type === 'sendPrompt' || message.type === 'editUserPrompt') {
      this.options.publish({ ...identity, type: 'submissionResult', status: 'rejected', reason });
    } else if (message.type === 'regenerateSessionTitle') {
      this.options.publish({ ...identity, type: 'sessionTitleRegeneration', running: false, outcome: 'unavailable', reason });
    } else if (message.requestId) {
      this.options.publish({ ...identity, type: 'changeActionFeedback', action: message.type,
        id: message.id, phase: 'failed', detail: reason });
    }
    this.options.publish({ ...identity, type: 'projectReadOnly', reason });
  }

  private record(stage: string, elapsedMs: number, taskCardId?: string): void {
    this.metrics.push({ stage, elapsedMs, taskCardId, generation: this.generation });
    if (this.metrics.length > 256) this.metrics.shift();
  }

  private readonly routerHost: ProjectTaskRouterHost = {
    get projectId() { return ''; }, // replaced below by the scoped accessor
    list: async ({ limit, cursor }) => {
      const cards = this.tasks.list().filter(card => !card.archived);
      const start = cursor ? cards.findIndex(card => card.taskCardId === cursor) + 1 : 0;
      const page = cards.slice(start, start + limit);
      return { tasks: page.map(summary), nextCursor: start + limit < cards.length ? page.at(-1)?.taskCardId : undefined };
    },
    read: async ({ taskCardId, maxChars }) => {
      const card = this.tasks.get(taskCardId); if (!card) throw new Error('Task not in this project');
      const result = this.tasks.events().filter(event => event.taskCardId === taskCardId).at(-1)?.content;
      return { task: summary(card), result: result?.slice(0, maxChars), truncated: !!result && result.length > maxChars };
    },
    create: async ({ content, title, requestId, dependsOn }) => {
      const snapshot = this.options.defaults();
      if (title) snapshot.configuration = { ...snapshot.configuration, initialTitleCandidate: title };
      return summary((await this.tasks.createTask({ requestId, content, title, dependencies: dependsOn, snapshot })).card);
    },
    deliver: async ({ taskCardId, content, requestId }) => {
      const card = this.tasks.get(taskCardId); if (!card) throw new Error('Task not in this project');
      const receipt = await this.tasks.submitInput(taskCardId, { requestId, content,
        kind: ACTIVE.has(card.state) ? 'supplement' : 'followup', rootTaskId: card.rootTaskId });
      return { inputId: receipt.input.inputId, status: receipt.input.state };
    },
    setDependencies: async ({ taskCardId, dependsOn }) => { await this.tasks.setDependencies(taskCardId, dependsOn); return { taskCardId, dependsOn }; },
    stop: async ({ taskCardId }) => { await this.tasks.stop(taskCardId); return summary(this.tasks.get(taskCardId)!); },
    requestStopAuthorization: (input, context) => this.requestRouterStopAuthorization(input, context)
  };

  private async requestRouterStopAuthorization(input: { taskCardId: string; requestId: string }, context: ProjectTaskRouterContext): Promise<boolean> {
    await this.options.owner.verify();
    const card = this.tasks.get(input.taskCardId);
    if (!card || context.projectId !== this.options.owner.projectId || context.signal?.aborted || this.disposed
      || ['completed', 'cancelled', 'failed'].includes(card.state) || this.routerStopRequests.has(input.requestId)) return false;
    return new Promise<boolean>(resolve => {
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, 60_000); timer.unref?.();
      const finish = (approved: boolean) => {
        if (!this.routerStopRequests.has(input.requestId)) return;
        this.routerStopRequests.delete(input.requestId); clearTimeout(timer); context.signal?.removeEventListener('abort', cancel);
        const current = this.tasks.get(card.taskCardId);
        resolve(approved && !context.signal?.aborted && !!current && current.rootTaskId === card.rootTaskId && current.generation === card.generation);
      };
      this.routerStopRequests.set(input.requestId, { taskCardId: card.taskCardId, rootTaskId: card.rootTaskId, generation: card.generation, finish });
      context.signal?.addEventListener('abort', cancel, { once: true });
      this.options.publish({ type: 'projectTaskStopAuthorization', projectId: this.options.owner.projectId,
        taskCardId: card.taskCardId, title: card.title, requestId: input.requestId });
      if (context.signal?.aborted) cancel();
    });
  }

  getRouterEvents(): { ids: string[]; tail: string } {
    const events = this.tasks.events({ unconsumed: true }).slice(0, 12);
    return { ids: events.map(event => event.eventId), tail: events.length ? `\n\n<keepseek-task-results>${JSON.stringify(events.map(event => ({
      eventId: event.eventId, taskCardId: event.taskCardId, state: event.state, content: event.content.slice(0, 1500)
    })))}</keepseek-task-results>` : '' };
  }
  async consumeRouterEvents(ids: string[], inputId: string): Promise<void> { await this.tasks.consumeEvents(ids, inputId); }

  dispose(): Promise<void> { return this.shutdown ??= this.disposeRuntime(); }

  private async disposeRuntime(): Promise<void> {
    this.disposed = true; clearTimeout(this.draftTimer);
    clearTimeout(this.contextUsagePublishTimer); clearTimeout(this.contextUsageSaveTimer);
    for (const request of [...this.routerStopRequests.values()]) request.finish(false);
    this.observerWatcher?.close();
    const failures: unknown[] = [];
    try { await this.persistDrafts(); } catch (error) { failures.push(error); }
    const tasks = await Promise.allSettled([this.tasks.dispose(), this.routerTasks.dispose()]);
    for (const result of tasks) if (result.status === 'rejected') failures.push(result.reason);
    await this.trimming;
    const drained = await Promise.allSettled([...this.drainingWorkers.values(), ...[...this.workers.values()].map(async worker => (await worker).drainProjectRuntime())]);
    for (const result of drained) if (result.status === 'rejected') failures.push(result.reason);
    await this.saveContextUsage(); this.contextUsage.clear();
    for (const release of this.taskPins.values()) release();
    if (failures.length) throw new AggregateError(failures, 'Project shutdown did not finish all saves. / 项目关闭时有保存未完成。');
  }
}

/** loadSessionById returns a complete authoritative session, unlike view pages.
 * Association itself is not execution activity; a legacy session with no real
 * user input has no activity timestamp. */
function associationTimes(session: import('../shared/types').ChatSession): { firstSubmittedAt?: string; firstSubmittedAtSource?: 'user_input' | 'session_created'; lastActivityAt?: string } {
  const users = session.messages.filter(message => message.role === 'user' && (message.expandedContent ?? message.content).trim() && Number.isFinite(Date.parse(message.createdAt)));
  const first = users.map(message => message.createdAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const activityTimes = users.length ? session.messages.flatMap(message => {
    if (message.role !== 'user' && message.role !== 'assistant') return [];
    const times = (message.expandedContent ?? message.content).trim() && Number.isFinite(Date.parse(message.createdAt)) ? [message.createdAt] : [];
    const details = message.runDetails;
    // A long answer starts before its last real completion/wait boundary.
    // Legacy 'stopped' cannot distinguish user Stop from extension shutdown.
    if (details?.endedAt && ['succeeded', 'failed', 'waiting', 'blocked'].includes(details.status)
      && Number.isFinite(Date.parse(details.endedAt))) times.push(details.endedAt);
    return times;
  }) : [];
  const activity = activityTimes.sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return { ...(first ? { firstSubmittedAt: first, firstSubmittedAtSource: 'user_input' as const }
    : Number.isFinite(Date.parse(session.createdAt)) ? { firstSubmittedAt: session.createdAt, firstSubmittedAtSource: 'session_created' as const } : {}),
    ...(activity ? { lastActivityAt: activity } : {}) };
}

function summary(card: Readonly<ProjectTaskCard>): ProjectTaskRouterSummary {
  return { taskCardId: card.taskCardId, sessionId: card.sessionId, status: card.state, title: card.title,
    progress: card.progress, resultEventId: card.resultEventId };
}
function requiredId(value: Record<string, unknown>): string { if (typeof value.taskCardId !== 'string') throw new Error('Task target required'); return value.taskCardId; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isMissing(error: unknown): boolean { return !!error && typeof error === 'object' && 'code' in error && ['ENOENT', 'FileNotFound'].includes(String(error.code)); }
function isMutation(type: string): boolean { return !['openDraftDiff', 'openDraftEditFile', 'loadOlderMessages'].includes(type); }
