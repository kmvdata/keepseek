import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { getExplorerFileUris, getFileReferenceAuthorizationKey, resolveFileReferenceUri } from '../context/references/fileReference';
import { AgentRunAbortedError, AgentRunner } from '../agent/runner';
import { AgentRequestCoordinator, type BackgroundContextCompressionRefreshUpdate } from '../agent/agentRequestCoordinator';
import { HistoryCompressor, type HistoryCompressionRefreshResult } from '../agent/historyCompressor';
import { createProtectedContextMeta } from '../agent/historyProjection';
import {
  archiveContextSourcesBeyondBudget,
  capOversizedFirstUserProviderContent,
  maintainArchivedToolResults
} from '../agent/historyArchive';
import { formatCurrentRunContextForAgent, getAgentToolNamesForPrompt } from '../agent/protocol';
import { FileContextStore } from '../context/fileContextStore';
import { SafeFileEditor } from '../edits/safeFileEditor';
import {
  AgentActivityInput,
  AgentActivityState,
  AgentExecutionLimits,
  AgentResponse,
  AgentSettings,
  ActivatedSkill,
  ChatMessage,
  ChatMessageSkill,
  ChatSession,
  ChangeSet,
  ChangeSetApplyFailure,
  ContextUsageEstimate,
  CurrentRunContext,
  DraftEdit,
  KeepseekExtensionInfo,
  KeepseekModel,
  LegacyProjectMemoryMigrationStateView,
  PromptCacheDiagnostics,
  RepairLoopState,
  SafeNpmScript,
  TaskPlan,
  TurnUsageStats,
  UsageEvent,
  WorkspaceSummary
} from '../shared/types';
import { markTaskPlanReadyForValidation } from '../agent/taskPlan';
import { getConfiguredKeepseekLanguage, getKeepseekLanguageName, localize, normalizeKeepseekLanguage } from '../shared/i18n';
import {
  ChatSessionStore,
  createSessionTitle,
  getCurrentWorkspaceSessionScope,
  getVisibleMessages,
  normalizeProviderReplay
} from '../sessions/chatSessionStore';
import {
  createDisplayedSessionContextUsageEstimate,
  finalizeSessionContextUsageEstimate,
  pickLargerContextUsageEstimate,
  toSessionContextUsageEstimate
} from '../agent/contextUsage';
import { ChangeSetStore, type PendingDeleteTarget } from '../edits/changeSetStore';
import { DraftDiffService } from '../edits/draftDiffService';
import {
  openDirectoryReferenceUri,
  openFileReference,
  revealReferenceInOperatingSystem
} from '../context/references/fileReferenceOpener';
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_HISTORY_RETENTION_DAYS,
  getConfiguredAgentSettings,
  getConfiguredBalanceRefreshIntervalMs,
  getConfiguredBackgroundMaxDurationMs,
  getConfiguredBackgroundMaxRounds,
  getConfiguredBackgroundMaxToolCalls,
  getConfiguredDebugMode,
  getConfiguredHistoryRetentionDays,
  getConfiguredMaxFileBytes,
  getConfiguredPromptCacheTtlMs,
  getConfiguredSkillContextBudgetChars,
  getConfiguredTotalContextBudgetTokens,
  getConfiguredModels,
  getConfiguredModelSelection,
  getConfiguredSlimToolModeEnabled,
  MAX_HISTORY_RETENTION_DAYS,
  MIN_HISTORY_RETENTION_DAYS,
  normalizeAgentSettings,
  normalizeIntegerInRange
} from '../shared/config';
import { getAgentRuntimeProfile } from '../shared/modelProfiles';
import { getErrorMessage } from '../shared/errors';
import { formatBytes } from '../shared/format';
import { expandPromptReferencesInPrompt } from '../context/references/promptReferences';
import { getWorkspaceReferenceResources } from '../context/references/referenceResources';
import { getHtmlForWebview } from '../webview/html';
import { focusView } from './focusView';
import type { DroppedFileReferenceInput, PromptReferenceInput, WebviewMessage } from './webviewMessages';
import { InteractionTraceLogService } from '../agent/logging/interactionTrace';
import { applyChangeSetEventToRunDetails } from '../agent/logging/runDetails';
import { fetchModelSourceBalance } from '../agent/balance';
import { GlobalBalanceStore, type BalanceSourceScope } from '../agent/deepseek/balanceStore';
import {
  addUsageEventToSessionStats,
  addUsageEventToTurnStats,
  addTurnUsageToSessionStats,
  calculateCacheHitRate,
  getCacheMissPossibleReasons
} from '../agent/usageStats';
import { SkillStore } from '../skills/skillStore';
import { SkillCreator } from '../skills/skillCreator';
import {
  copySelectionTextWithClipboardRestore,
  createTextReferenceFileName,
  getDocumentSelectionTextReferenceSource,
  getTextReferenceDocumentName,
  sanitizeDroppedFileName,
  sanitizeTextReferenceFileName,
  TEXT_REFERENCE_STORAGE_DIR,
  type TextReferenceSource
} from '../context/textReferences';
import { ProjectInstructionsResolver } from '../agent/projectInstructions';
import { buildCurrentRunContext } from '../agent/currentRunContext';
import { LegacyProjectMemoryMigration } from '../memory/legacyProjectMemoryMigration';
import { BackgroundRunCoordinator } from '../agent/backgroundRunCoordinator';
import { BackgroundRunStatusBar } from './backgroundRunStatusBar';
import { getAvailableSafeValidationScripts } from '../agent/tools/validationTools';
import {
  CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION,
  CURRENT_PROVIDER_TOOL_SCHEMA_VERSION,
  LEGACY_PROVIDER_REQUEST_PROTOCOL_VERSION
} from '../agent/providerRequestProjection';
import {
  ModelSourceStore
} from '../accounts/accountStore';
import { resolveModelSourceConfig } from '../accounts/accountResolver';
import { probeSourceConnection, refreshSourceModelCache } from '../accounts/modelDiscovery';
import { createModelCatalog, findModelBySelection } from '../accounts/modelCatalog';
import { ModelSourceService } from '../accounts/modelSourceService';
import { isOfficialDeepSeekSource } from '../accounts/sourceCapabilities';
import type {
  ModelSource,
  ModelSourceConfigSnapshot,
  ModelSourceProvider
} from '../accounts/types';

const CHAT_CONTAINER_ID = 'keepseek-sidebar';
const CHAT_VIEW_TYPE = 'keepseek.chat';
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MAX_DELETE_CONFIRMATION_PATHS = 10;

export class KeepseekChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = CHAT_VIEW_TYPE;

  private readonly fileContext = new FileContextStore();
  private readonly agentRunner: AgentRunner;
  private readonly agentRequestCoordinator: AgentRequestCoordinator;
  private readonly sourceStore: ModelSourceStore;
  private readonly modelSourceService: ModelSourceService;
  private readonly traceLogService: InteractionTraceLogService;
  private readonly changeSets: ChangeSetStore;
  private readonly draftDiffService: DraftDiffService;
  private readonly skillStore: SkillStore;
  private readonly skillCreator = new SkillCreator();
  private readonly projectInstructionsResolver = new ProjectInstructionsResolver();
  private readonly legacyMemoryMigration: LegacyProjectMemoryMigration;
  private readonly backgroundRunCoordinator: BackgroundRunCoordinator;
  private readonly backgroundRunStatusBar = new BackgroundRunStatusBar();
  private readonly sessionTraceLogUris = new Map<string, string>();
  private readonly taskPlansBySession = new Map<string, TaskPlan>();
  private readonly repairLoopsBySession = new Map<string, RepairLoopState>();
  private readonly currentRunContextsBySession = new Map<string, CurrentRunContext>();
  /** 会话冻结的 slim 工具集（首轮确定后跨轮复用，保证 tools schema 前缀稳定） */
  private readonly slimToolNamesBySession = new Map<string, string[]>();
  private readonly authorizedExternalReferenceUris = new Set<string>();
  private readonly views = new Set<vscode.WebviewView>();
  private backgroundAvailableScripts: SafeNpmScript[] = [];
  private modelSources: ModelSource[] = [];
  private modelSourceStateRefreshGeneration = 0;
  private modelSourceStateRefreshPromise: Promise<void> | undefined;
  private availableModels: KeepseekModel[] = [];
  private selectedSourceId = '';
  private selectedModelId = '';
  private agentSettings = getConfiguredAgentSettings();
  private language = getConfiguredKeepseekLanguage();
  private isBusy = false;
  private currentRunAbortController: AbortController | undefined;
  private liveContextUsage: ContextUsageEstimate | undefined;
  private liveTurnUsage: TurnUsageStats | undefined;
  /** 防并发：同一 Provider 同时只允许一个余额刷新流程；限流按来源全局共享。 */
  private balanceRefreshPromise: Promise<void> | undefined;
  /** 来源隔离的全局余额 store：同一来源跨 workspace/window 共享快照与限流。 */
  private readonly balanceStore: GlobalBalanceStore;
  private agentActivitySequence = 0;
  private agentActivity: AgentActivityState = {
    base: 'idle',
    phase: 'idle',
    updatedAt: new Date().toISOString(),
    sequence: 0
  };
  private readonly sessionCleanupTimer: ReturnType<typeof setInterval>;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessionStore: ChatSessionStore,
    private readonly globalStorageUri: vscode.Uri,
    skillState: vscode.Memento,
    private readonly extensionInfo: KeepseekExtensionInfo
  ) {
    this.traceLogService = new InteractionTraceLogService(this.globalStorageUri);
    this.skillStore = new SkillStore(skillState);
    this.sourceStore = new ModelSourceStore(this.globalStorageUri);
    this.modelSourceService = new ModelSourceService(this.sourceStore);
    this.agentRequestCoordinator = new AgentRequestCoordinator(
      new HistoryCompressor(undefined, this.globalStorageUri)
    );
    // 余额快照与限流时间戳落在 globalStorageUri 下，并按 provider/source 隔离。
    this.balanceStore = new GlobalBalanceStore(this.globalStorageUri);
    this.legacyMemoryMigration = new LegacyProjectMemoryMigration(
      this.globalStorageUri,
      skillState,
      () => this.sessionStore.workspaceKey
    );
    this.backgroundRunCoordinator = new BackgroundRunCoordinator((run) => {
      this.backgroundRunStatusBar.update(run);
      this.postState();
    });
    this.agentRunner = new AgentRunner(
      undefined,
      this.traceLogService,
      undefined,
      undefined,
      undefined,
      undefined,
      this.globalStorageUri
    );
    this.draftDiffService = new DraftDiffService();
    this.changeSets = new ChangeSetStore(
      new SafeFileEditor((key, values) => this.t(key, values)),
      this.draftDiffService,
      this.sessionStore,
      this.globalStorageUri,
      (key, values) => this.t(key, values),
      (changeSet, event) => {
        this.updateRunDetailsForChangeSet(changeSet.messageId, event, changeSet);
        void this.traceLogService.appendRunEvent(
          changeSet.traceLogUri
            ? { runId: changeSet.runId, uri: changeSet.traceLogUri }
            : undefined,
          event.type ? event as { type: string; [key: string]: unknown } : { type: 'change_set_event', ...event }
        );
      }
    );
    void this.cleanupExpiredSessions({ post: false });
    this.sessionCleanupTimer = setInterval(() => {
      void this.cleanupExpiredSessions();
    }, SESSION_CLEANUP_INTERVAL_MS);
  }

  public dispose(): void {
    clearInterval(this.sessionCleanupTimer);
    this.draftDiffService.dispose();
    this.backgroundRunStatusBar.dispose();
  }

  public refreshConfiguration(): void {
    this.syncConfiguredState();
    void this.cleanupExpiredSessions();
    this.postState();
    void this.refreshModelSourceState().then(() => this.postState()).catch(() => undefined);
    void this.refreshCurrentRunContext(this.sessionStore.getActiveSession(), '').then(() => this.postState()).catch(() => undefined);
  }

  public async refreshWorkspaceScope(): Promise<void> {
    if (!(await this.sessionStore.setWorkspaceScope(getCurrentWorkspaceSessionScope()))) {
      return;
    }

    this.clearSessionTransientState();
    this.abortPrompt();
    this.backgroundRunCoordinator.clear();
    this.currentRunContextsBySession.clear();
    this.slimToolNamesBySession.clear();
    await this.legacyMemoryMigration.refresh();
    await this.refreshSkills({ post: false });
    await this.refreshBackgroundRunAvailability({ post: false });
    await this.sessionStore.persist();
    await this.cleanupExpiredSessions({ post: false });
    this.postToWebview({ type: 'sessionChanged' });
    this.postState();
  }

  public async refreshLegacyMemoryMigration(): Promise<void> {
    await this.legacyMemoryMigration.refresh();
    await this.refreshCurrentRunContext(this.sessionStore.getActiveSession(), '');
    this.postState();
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.views.add(webviewView);
    webviewView.webview.options = {
      enableScripts: true,
      enableDragAndDrop: true,
      localResourceRoots: [this.extensionUri]
    } as vscode.WebviewOptions;
    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
    webviewView.onDidDispose(() => {
      this.views.delete(webviewView);
    });
  }

  public async reveal(): Promise<void> {
    await focusView(CHAT_CONTAINER_ID, CHAT_VIEW_TYPE);
  }

  public async addCurrentFileToContext(): Promise<void> {
    await this.runContextAction(async () => {
      const file = await this.fileContext.addCurrentEditor();
      vscode.window.showInformationMessage(this.t('addedFile', { label: file.label }));
    });
  }

  public async pickWorkspaceFilesToContext(): Promise<void> {
    await this.runContextAction(async () => {
      const files = await this.fileContext.pickWorkspaceFiles();
      if (files.length) {
        vscode.window.showInformationMessage(this.t('addedWorkspaceFiles', { count: files.length }));
      }
    });
  }

  public async insertSelectionToInput(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    if (editor.selection.isEmpty) {
      vscode.window.showWarningMessage(this.t('selectTextToAdd'));
      return;
    }

    const documentSelectionSource = getDocumentSelectionTextReferenceSource(editor.document);
    if (documentSelectionSource) {
      await this.insertDocumentSelectionReferenceToInput(editor, documentSelectionSource);
      return;
    }

    const startLine = editor.selection.start.line + 1;
    const endLine = editor.selection.end.line + 1;
    const startColumn = editor.selection.start.character + 1;
    const endColumn = editor.selection.end.character + 1;
    const path = editor.document.uri.fsPath;

    await this.reveal();
    this.authorizeExternalReferenceUri(editor.document.uri);
    this.postToWebview({ type: 'insertFileReference', path, startLine, endLine, startColumn, endColumn });
  }

  public async insertTerminalSelectionToInput(): Promise<void> {
    if (!vscode.window.activeTerminal) {
      vscode.window.showWarningMessage(this.t('selectTerminalTextToAdd'));
      return;
    }

    await this.insertClipboardSelectionReferenceToInput({
      copyCommand: 'workbench.action.terminal.copySelection',
      fileName: createTextReferenceFileName('terminal-selection', vscode.window.activeTerminal.name),
      emptySelectionMessageKey: 'selectTerminalTextToAdd',
      errorMessageKey: 'cannotAddTerminalSelection'
    });
  }

  public async insertDebugConsoleSelectionToInput(): Promise<void> {
    await this.insertClipboardSelectionReferenceToInput({
      copyCommand: 'debug.replCopy',
      fileName: createTextReferenceFileName('debug-console-selection'),
      emptySelectionMessageKey: 'selectDebugConsoleTextToAdd',
      errorMessageKey: 'cannotAddDebugConsoleSelection'
    });
  }

  public async insertExplorerFileToInput(uri?: vscode.Uri, selectedUris?: vscode.Uri[]): Promise<void> {
    let targetUris = getExplorerFileUris(uri, selectedUris);
    if (!targetUris.length) {
      // Keybinding invocation — no context-menu arguments. Fall back to the active editor's file,
      // which matches the Explorer selection when the user single-clicked it (preview mode).
      const editor = vscode.window.activeTextEditor;
      if (editor && editor.document.uri.scheme !== 'output' && editor.document.uri.scheme !== 'debug') {
        targetUris = [editor.document.uri];
      }
    }
    if (!targetUris.length) {
      vscode.window.showWarningMessage(this.t('chooseFileToAdd'));
      return;
    }

    try {
      const files: vscode.Uri[] = [];
      for (const targetUri of targetUris) {
        const stat = await vscode.workspace.fs.stat(targetUri);
        if (stat.type === vscode.FileType.File) {
          files.push(targetUri);
        }
      }

      if (!files.length) {
        vscode.window.showWarningMessage(this.t('canOnlyInsertExplorerFiles'));
        return;
      }

      await this.reveal();
      for (const file of files) {
        this.authorizeExternalReferenceUri(file);
        this.postToWebview({
          type: 'insertFileReference',
          path: file.fsPath,
          startLine: 0,
          endLine: 0
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotAddFileReference', { message: getErrorMessage(error) }));
    }
  }

  public async insertExplorerDirectoryToInput(uri?: vscode.Uri, selectedUris?: vscode.Uri[]): Promise<void> {
    const targetUris = getExplorerFileUris(uri, selectedUris);
    if (!targetUris.length) {
      vscode.window.showWarningMessage(this.t('chooseDirectoryToAdd'));
      return;
    }

    try {
      const directories: vscode.Uri[] = [];
      for (const targetUri of targetUris) {
        const stat = await vscode.workspace.fs.stat(targetUri);
        if (stat.type === vscode.FileType.Directory) {
          directories.push(targetUri);
        }
      }

      if (!directories.length) {
        vscode.window.showWarningMessage(this.t('canOnlyInsertExplorerDirectories'));
        return;
      }

      await this.reveal();
      for (const directory of directories) {
        this.authorizeExternalReferenceUri(directory);
        this.postToWebview({
          type: 'insertDirectoryReference',
          path: directory.fsPath
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotAddDirectoryReference', { message: getErrorMessage(error) }));
    }
  }

  public async pickExternalFilesToContext(): Promise<void> {
    await this.runContextAction(async () => {
      const files = await this.fileContext.pickExternalFiles();
      if (files.length) {
        vscode.window.showInformationMessage(this.t('addedExternalFiles', { count: files.length }));
      }
    });
  }

  public async pickExternalFileReferencesToInput(): Promise<void> {
    try {
      const picked = await vscode.window.showOpenDialog({
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: true,
        openLabel: this.t('addExternalFilesLabel')
      });

      if (!picked?.length) {
        return;
      }

      const files: vscode.Uri[] = [];
      let skipped = 0;
      for (const uri of picked) {
        try {
          const stat = await vscode.workspace.fs.stat(uri);
          if (stat.type === vscode.FileType.File) {
            files.push(uri);
          } else {
            skipped += 1;
          }
        } catch {
          skipped += 1;
        }
      }

      if (!files.length) {
        vscode.window.showWarningMessage(this.t('canOnlyInsertFileReferencesForFiles'));
        return;
      }
      if (skipped > 0) {
        vscode.window.showWarningMessage(this.t('skippedUnreadableItems', { count: skipped }));
      }

      for (const file of files) {
        this.authorizeExternalReferenceUri(file);
        this.postToWebview({
          type: 'insertFileReference',
          path: file.fsPath,
          startLine: 0,
          endLine: 0
        });
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotAddExternalFileReference', { message: getErrorMessage(error) }));
    }
  }

  public async insertDroppedFileReferencesToInput(files: DroppedFileReferenceInput[]): Promise<void> {
    if (!Array.isArray(files) || !files.length) {
      return;
    }

    try {
      const maxBytes = getConfiguredMaxFileBytes();
      const dropDir = vscode.Uri.joinPath(this.globalStorageUri, 'dropped-file-references', randomUUID());
      await vscode.workspace.fs.createDirectory(dropDir);

      let inserted = 0;
      let skipped = 0;

      for (const file of files) {
        if (!file || typeof file.dataBase64 !== 'string') {
          skipped += 1;
          continue;
        }

        const declaredSize = typeof file.size === 'number' ? file.size : undefined;
        const maxBase64Length = Math.ceil(maxBytes / 3) * 4 + 4;
        if ((declaredSize !== undefined && declaredSize > maxBytes) || file.dataBase64.length > maxBase64Length) {
          skipped += 1;
          continue;
        }

        const bytes = Buffer.from(file.dataBase64, 'base64');
        const expectedSize = declaredSize ?? bytes.byteLength;
        if (!bytes.byteLength && expectedSize > 0) {
          skipped += 1;
          continue;
        }
        if (bytes.byteLength > maxBytes || expectedSize > maxBytes) {
          skipped += 1;
          continue;
        }

        const fileName = sanitizeDroppedFileName(file.name);
        const fileDir = vscode.Uri.joinPath(dropDir, randomUUID());
        await vscode.workspace.fs.createDirectory(fileDir);
        const fileUri = vscode.Uri.joinPath(fileDir, fileName);
        await vscode.workspace.fs.writeFile(fileUri, bytes);
        this.authorizeExternalReferenceUri(fileUri);
        this.postToWebview({
          type: 'insertFileReference',
          path: fileUri.fsPath,
          startLine: 0,
          endLine: 0
        });
        inserted += 1;
      }

      if (skipped > 0) {
        vscode.window.showWarningMessage(this.t('skippedDroppedFiles', { count: skipped }));
      }
      if (!inserted && skipped === 0) {
        vscode.window.showWarningMessage(this.t('didNotFindDroppedFiles'));
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotImportDroppedFile', { message: getErrorMessage(error) }));
    }
  }

  private async insertDocumentSelectionReferenceToInput(editor: vscode.TextEditor, source: TextReferenceSource): Promise<void> {
    if (editor.selection.isEmpty) {
      vscode.window.showWarningMessage(this.t('selectTextToAdd'));
      return;
    }

    try {
      const fileName = createTextReferenceFileName(`${source === 'output' ? 'output' : 'debug-console'}-selection`, getTextReferenceDocumentName(editor.document));
      await this.insertTextReferenceToInput(editor.document.getText(editor.selection), fileName);
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotAddTextSelection', { message: getErrorMessage(error) }));
    }
  }

  private async insertClipboardSelectionReferenceToInput(options: {
    copyCommand: string;
    fileName: string;
    emptySelectionMessageKey: string;
    errorMessageKey: string;
  }): Promise<void> {
    try {
      const selectionText = await copySelectionTextWithClipboardRestore(options.copyCommand);
      if (!selectionText.trim()) {
        vscode.window.showWarningMessage(this.t(options.emptySelectionMessageKey));
        return;
      }

      await this.insertTextReferenceToInput(selectionText, options.fileName);
    } catch (error) {
      vscode.window.showErrorMessage(this.t(options.errorMessageKey, { message: getErrorMessage(error) }));
    }
  }

  private async insertTextReferenceToInput(content: string, fileName: string): Promise<void> {
    const normalizedContent = content.replace(/\r\n?/gu, '\n');
    if (!normalizedContent.trim()) {
      vscode.window.showWarningMessage(this.t('selectTextToAdd'));
      return;
    }

    const bytes = new TextEncoder().encode(normalizedContent);
    const maxBytes = getConfiguredMaxFileBytes();
    if (bytes.byteLength > maxBytes) {
      vscode.window.showWarningMessage(this.t('selectedTextTooLarge', { limit: formatBytes(maxBytes) }));
      return;
    }

    const referenceDir = vscode.Uri.joinPath(this.globalStorageUri, TEXT_REFERENCE_STORAGE_DIR, randomUUID());
    await vscode.workspace.fs.createDirectory(referenceDir);
    const fileUri = vscode.Uri.joinPath(referenceDir, sanitizeTextReferenceFileName(fileName));
    await vscode.workspace.fs.writeFile(fileUri, bytes);

    await this.reveal();
    this.authorizeExternalReferenceUri(fileUri);
    this.postToWebview({
      type: 'insertFileReference',
      path: fileUri.fsPath,
      startLine: 0,
      endLine: 0
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        await this.changeSets.initialize();
        await this.legacyMemoryMigration.refresh();
        await this.refreshModelSourceState();
        this.syncConfiguredState();
        await this.refreshSkills({ post: false });
        await this.refreshBackgroundRunAvailability({ post: false });
        await this.cleanupExpiredSessions({ post: false });
        this.postState();
        void this.refreshBalance();
        return;
      case 'refreshBalance':
        // 用量统计界面弹出时触发:不 force,遵守 60s 限流,1 分钟内只真正请求一次。
        void this.refreshBalance({ force: false });
        return;
      case 'sendPrompt':
        await this.sendPrompt(message.prompt, message.sourceId, message.modelId, message.settings, { references: message.references, skillIds: message.skillIds });
        return;
      case 'editUserPrompt':
        await this.sendPrompt(message.prompt, message.sourceId, message.modelId, message.settings, { replaceMessageId: message.messageId, references: message.references, skillIds: message.skillIds });
        return;
      case 'abortPrompt':
        this.abortPrompt();
        return;
      case 'continueRepair':
        await this.continueRepair();
        return;
      case 'newSession':
        await this.createNewSession();
        return;
      case 'selectSession':
        await this.selectSession(message.sessionId);
        return;
      case 'toggleSessionFavorite':
        if (await this.sessionStore.toggleSessionFavorite(message.sessionId)) {
          this.postState();
        }
        return;
      case 'renameSession':
        if (await this.sessionStore.renameSession(message.sessionId, message.title)) {
          this.postState();
        }
        return;
      case 'deleteSessions':
        await this.deleteSessions(message.sessionIds);
        return;
      case 'listOtherWorkspaces':
        await this.postOtherWorkspaces();
        return;
      case 'loadOtherWorkspaceSessions':
        await this.postOtherWorkspaceSessions(message.workspaceKey);
        return;
      case 'copyOtherWorkspaceSession':
        await this.copyOtherWorkspaceSession(message.workspaceKey, message.sessionId);
        return;
      case 'deleteOtherWorkspaceSessions':
        await this.deleteOtherWorkspaceSessions(message.workspaceKey, message.sessionIds);
        return;
      case 'deleteOtherWorkspace':
        await this.deleteOtherWorkspace(message.workspaceKey);
        return;
      case 'setSelectedModel':
        await this.setSelectedModel(message.sourceId, message.modelId);
        return;
      case 'setAgentSettings':
        await this.setAgentSettings(message.settings);
        return;
      case 'setDebugMode':
        await this.setDebugMode(message.enabled);
        return;
      case 'openCurrentSessionLog':
        await this.openCurrentSessionLog();
        return;
      case 'openRunTrace':
        await this.openRunTrace(message.messageId);
        return;
      case 'createLegacyMemoryMigrationDraft':
        await this.createLegacyMemoryMigrationDraft();
        return;
      case 'exportLegacyMemory':
        await this.exportLegacyMemory();
        return;
      case 'completeLegacyMemoryMigration':
        await this.completeLegacyMemoryMigration();
        return;
      case 'rollbackLegacyMemoryMigration':
        await this.rollbackLegacyMemoryMigration();
        return;
      case 'startBackgroundRun':
        await this.startBackgroundRun(message.script, message.maxRounds);
        return;
      case 'resumeBackgroundRun':
        await this.resumeBackgroundRun();
        return;
      case 'stopBackgroundRun':
        await this.stopBackgroundRun();
        return;
      case 'openApiSettings': {
        await this.refreshModelSourceState();
        this.postModelSettingsDialog();
        return;
      }
      case 'openHistorySettings': {
        this.postToWebview({
          type: 'showHistorySettingsDialog',
          historyRetentionDays: getConfiguredHistoryRetentionDays()
        });
        return;
      }
      case 'addModel': {
        await this.addModel(message);
        return;
      }
      case 'saveModelSource': {
        await this.saveModelSource(message);
        return;
      }
      case 'deleteModel': {
        await this.deleteModel(message);
        return;
      }
      case 'setModelEnabled': {
        await this.setModelEnabled(message);
        return;
      }
      case 'setModelContextWindow': {
        await this.setModelContextWindow(message);
        return;
      }
      case 'setModelMaxOutput': {
        await this.setModelMaxOutput(message);
        return;
      }
      case 'deleteModelSource': {
        await this.deleteModelSource(message.sourceId);
        return;
      }
      case 'refreshSourceModels': {
        await this.refreshSourceModels(message.sourceId);
        return;
      }
      case 'testSourceConnection': {
        const probeResult = await probeSourceConnection({
          provider: message.provider,
          apiKey: message.apiKey,
          baseUrl: message.baseUrl
        });
        this.postToWebview({
          type: 'sourceConnectionTestResult',
          ok: probeResult.ok,
          status: probeResult.status,
          error: probeResult.error,
          modelDiscoveryUnavailable: probeResult.modelDiscoveryUnavailable === true
        });
        return;
      }
      case 'saveHistorySettings': {
        const config = vscode.workspace.getConfiguration('keepseek');
        const historyRetentionDays = normalizeIntegerInRange(
          message.historyRetentionDays,
          MIN_HISTORY_RETENTION_DAYS,
          MAX_HISTORY_RETENTION_DAYS,
          DEFAULT_HISTORY_RETENTION_DAYS
        );
        await config.update('historyRetentionDays', historyRetentionDays, vscode.ConfigurationTarget.Global);
        await this.cleanupExpiredSessions({ post: false });
        this.postState();
        vscode.window.showInformationMessage(this.t('historySettingsSaved'));
        return;
      }
      case 'setLanguage': {
        const language = normalizeKeepseekLanguage(message.language);
        const config = vscode.workspace.getConfiguration('keepseek');
        await config.update('language', language, vscode.ConfigurationTarget.Global);
        this.language = language;
        await this.sessionStore.relocalizeEmptySessionTitles(language);
        this.postState();
        vscode.window.showInformationMessage(
          this.t('languageSaved', { language: getKeepseekLanguageName(language, language) })
        );
        return;
      }
      case 'addCurrentFile':
        await this.addCurrentFileToContext();
        return;
      case 'pickWorkspaceFiles':
        await this.pickWorkspaceFilesToContext();
        return;
      case 'pickExternalFiles':
        await this.pickExternalFilesToContext();
        return;
      case 'pickExternalFileReferences':
        await this.pickExternalFileReferencesToInput();
        return;
      case 'insertDroppedFileReferences':
        await this.insertDroppedFileReferencesToInput(message.files);
        return;
      case 'requestReferenceResources':
        await this.postReferenceResources(message.requestId);
        return;
      case 'requestSkills':
        await this.refreshSkills();
        return;
      case 'useSkill':
        await this.useSkill(message.skillId);
        return;
      case 'removeActiveSkill':
        await this.removeActiveSkill(message.skillId);
        return;
      case 'openSkill':
        await this.openSkill(message.skillId);
        return;
      case 'setSkillEnabled':
        await this.setSkillEnabled(message.skillId, message.enabled);
        return;
      case 'setSkillAllowImplicit':
        await this.setSkillAllowImplicit(message.skillId, message.allowImplicit);
        return;
      case 'setSkillWorkspaceDefault':
        await this.setSkillWorkspaceDefault(message.skillId, message.enabled);
        return;
      case 'createSkillDraft':
        await this.createSkillDraft(message);
        return;
      case 'requestClipboardText':
        await this.postClipboardText(message.requestId);
        return;
      case 'writeClipboardText':
        await this.writeClipboardText(message.text);
        return;
      case 'readPath':
        await this.readPathToContext(message.path);
        return;
      case 'openFileReference':
        await openFileReference({
          path: message.path,
          startLine: message.startLine,
          endLine: message.endLine,
          startColumn: message.startColumn,
          endColumn: message.endColumn,
          language: this.language
        });
        return;
      case 'openDirectoryReference':
        await this.openDirectoryReference(message.path);
        return;
      case 'removeContextFile':
        this.fileContext.remove(message.uri);
        this.postState();
        return;
      case 'clearContext':
        this.fileContext.clear();
        this.postState();
        return;
      case 'applyDraftEdit':
        {
          if (this.isBusy) {
            return;
          }
          const deleteTargets = this.changeSets.getPendingDeleteTargetsForEdit(message.id);
          if (!(await this.confirmDeleteApply(deleteTargets))) {
            return;
          }
          const result = await this.changeSets.applyEdit(message.id);
          if (result?.appliedEditIds.length) {
            await this.refreshSkills({ post: false });
            await this.handleAppliedRepairEdits(result.appliedEditIds);
          }
          this.showChangeSetFailures(result?.failed);
          this.postState();
        }
        return;
      case 'discardDraftEdit':
        if (this.isBusy) {
          return;
        }
        this.changeSets.discardEdit(message.id);
        await this.markActiveRepairDiscarded(message.id);
        this.postState();
        return;
      case 'openDraftDiff':
        try {
          await this.changeSets.openDiff(message.id);
        } catch (error) {
          vscode.window.showErrorMessage(getErrorMessage(error));
        }
        return;
      case 'openDraftEditFile':
        try {
          await this.changeSets.openEditFile(message.id);
        } catch (error) {
          vscode.window.showErrorMessage(getErrorMessage(error));
        }
        return;
      case 'applyChangeSet':
        {
          if (this.isBusy) {
            return;
          }
          const deleteTargets = this.changeSets.getPendingDeleteTargetsForChangeSet(message.id);
          if (!(await this.confirmDeleteApply(deleteTargets))) {
            return;
          }
          const result = await this.changeSets.applyAll(message.id);
          if (result?.appliedEditIds.length) {
            await this.refreshSkills({ post: false });
            await this.handleAppliedRepairEdits(result.appliedEditIds);
          }
          this.showChangeSetFailures(result?.failed);
          this.postState();
        }
        return;
      case 'discardChangeSet':
        if (this.isBusy) {
          return;
        }
        this.changeSets.discardAll(message.id);
        await this.markActiveRepairDiscarded();
        this.postState();
        return;
      case 'revertDraftEdit':
        {
          if (this.isBusy) {
            return;
          }
          const result = await this.changeSets.revertEdit(message.id);
          if (result?.revertedEditIds.length) {
            await this.refreshSkills({ post: false });
          }
          this.showChangeSetFailures(result?.failed);
          this.postState();
        }
        return;
      case 'revertChangeSet':
        {
          if (this.isBusy) {
            return;
          }
          const result = await this.changeSets.revertAll(message.id);
          if (result?.revertedEditIds.length) {
            await this.refreshSkills({ post: false });
          }
          this.showChangeSetFailures(result?.failed);
          this.postState();
        }
        return;
      case 'applyAllDraftEdits': {
        if (this.isBusy) {
          return;
        }
        const changeSetId = this.changeSets.getLatestChangeSetId(this.sessionStore.activeSessionId);
        const deleteTargets = changeSetId
          ? this.changeSets.getPendingDeleteTargetsForChangeSet(changeSetId)
          : [];
        if (!(await this.confirmDeleteApply(deleteTargets))) {
          return;
        }
        const result = changeSetId ? await this.changeSets.applyAll(changeSetId) : undefined;
        if (result?.appliedEditIds.length) {
          await this.refreshSkills({ post: false });
          await this.handleAppliedRepairEdits(result.appliedEditIds);
        }
        this.showChangeSetFailures(result?.failed);
        this.postState();
        return;
      }
      case 'discardAllDraftEdits':
        {
          if (this.isBusy) {
            return;
          }
          const changeSetId = this.changeSets.getLatestChangeSetId(this.sessionStore.activeSessionId);
          if (changeSetId) {
            this.changeSets.discardAll(changeSetId);
            await this.markActiveRepairDiscarded();
          }
        }
        this.postState();
        return;
    }
  }

  private get messages(): ChatMessage[] {
    return this.sessionStore.messages;
  }

  private clearSessionTransientState(): void {
    this.fileContext.clear();
    this.authorizedExternalReferenceUris.clear();
    this.liveContextUsage = undefined;
  }

  private showChangeSetFailures(failures: readonly ChangeSetApplyFailure[] | undefined): void {
    if (!failures?.length) {
      return;
    }
    const details = failures
      .slice(0, 3)
      .map((failure) => `${failure.label}: ${failure.error}`)
      .join('\n');
    vscode.window.showWarningMessage(this.t('changeSetOperationFailed', {
      count: failures.length,
      details
    }));
  }

  private async confirmDeleteApply(targets: readonly PendingDeleteTarget[]): Promise<boolean> {
    if (!targets.length) {
      return true;
    }

    const confirmAction = this.t('deleteDraftApplyConfirmAction');
    const visibleTargets = targets.slice(0, MAX_DELETE_CONFIRMATION_PATHS);
    const hiddenCount = targets.length - visibleTargets.length;
    const detail = targets.length > 1
      ? [
          ...visibleTargets.map((target) => target.label),
          ...(hiddenCount > 0
            ? [this.t('deleteDraftApplyAdditionalTargets', { count: hiddenCount })]
            : [])
        ].join('\n')
      : undefined;
    const selected = await vscode.window.showWarningMessage(
      targets.length === 1
        ? this.t('deleteDraftApplyConfirm', { label: targets[0]?.label ?? '' })
        : this.t('deleteChangeSetApplyConfirm', { count: targets.length }),
      { modal: true, detail },
      confirmAction
    );
    return selected === confirmAction;
  }

  private updateActiveSessionContextUsage(usage: ContextUsageEstimate | undefined): void {
    if (!usage) {
      return;
    }
    const activeSession = this.sessionStore.getActiveSession();
    activeSession.contextUsage = pickLargerContextUsageEstimate(
      activeSession.contextUsage,
      finalizeSessionContextUsageEstimate(usage)
    );
  }

  private applyUsageEvent(
    session: ChatSession,
    currentTurnUsage: TurnUsageStats | undefined,
    event: UsageEvent
  ): TurnUsageStats {
    const nextTurnUsage = addUsageEventToTurnStats(currentTurnUsage, event);
    session.lastTurnUsage = nextTurnUsage;
    session.usageStats = addUsageEventToSessionStats(session.usageStats, event, nextTurnUsage.updatedAt);
    session.updatedAt = nextTurnUsage.updatedAt ?? new Date().toISOString();
    return nextTurnUsage;
  }

  private applyTurnUsage(session: ChatSession, turnUsage: TurnUsageStats): TurnUsageStats {
    const normalizedTurnUsage: TurnUsageStats = {
      ...turnUsage,
      updatedAt: turnUsage.updatedAt ?? new Date().toISOString()
    };
    session.lastTurnUsage = normalizedTurnUsage;
    session.usageStats = addTurnUsageToSessionStats(session.usageStats, normalizedTurnUsage, normalizedTurnUsage.updatedAt);
    session.updatedAt = normalizedTurnUsage.updatedAt ?? new Date().toISOString();
    return normalizedTurnUsage;
  }

  private applyPromptCacheDiagnostics(
    session: ChatSession,
    diagnostics: PromptCacheDiagnostics | undefined,
    previousDiagnostics: PromptCacheDiagnostics | undefined,
    previousTurnUsage: TurnUsageStats | undefined,
    currentTurnUsage: TurnUsageStats | undefined
  ): void {
    if (!diagnostics) {
      return;
    }

    const cacheMissPossibleReasons = getCacheMissPossibleReasons({
      previousDiagnostics,
      diagnostics,
      previousTurnUsage,
      currentTurnUsage
    });
    session.promptCacheDiagnostics = {
      ...diagnostics,
      cacheMissPossibleReasons
    };

    if (cacheMissPossibleReasons.length) {
      console.debug('[KeepSeek] Provider prefix cache hit rate dropped.', {
        reasons: cacheMissPossibleReasons,
        previousDiagnostics,
        diagnostics,
        previousHitRate: previousTurnUsage ? calculateCacheHitRate(previousTurnUsage) : undefined,
        currentHitRate: currentTurnUsage ? calculateCacheHitRate(currentTurnUsage) : undefined
      });
    }
  }

  private createCurrentSessionContextUsage(model = this.getSelectedModel()): ContextUsageEstimate {
    const activeSession = this.sessionStore.getActiveSession();
    return createDisplayedSessionContextUsageEstimate({
      model,
      agentSettings: this.agentSettings,
      contextFiles: this.fileContext.getAll(),
      currentRunContext: this.currentRunContextsBySession.get(activeSession.id),
      contextInstructions: activeSession.contextInstructions,
      messages: this.messages,
      contextCompression: activeSession.contextCompression,
      language: this.language,
      slimToolNames: activeSession.requestProtocol?.toolNames.length
        ? activeSession.requestProtocol.toolNames
        : this.slimToolNamesBySession.get(activeSession.id),
      requestProtocolVersion: activeSession.requestProtocol?.version,
      provider: model.provider === 'openai-responses' || model.provider === 'anthropic-compatible'
        ? model.provider
        : undefined,
      sourceId: activeSession.requestProtocol?.sourceId ?? model.sourceId,
      baseUrl: activeSession.requestProtocol?.baseUrl
    });
  }

  private resolveSessionToolNames(
    session: ChatSession,
    prompt: string,
    model: KeepseekModel,
    sourceConfig: ModelSourceConfigSnapshot
  ): string[] {
    let protocol = session.requestProtocol;
    const baseUrl = sourceConfig.baseUrl || DEFAULT_DEEPSEEK_BASE_URL;
    const modelChanged = Boolean(protocol?.modelId && protocol.modelId !== model.id);
    const sourceChanged = Boolean(protocol?.sourceId && protocol.sourceId !== sourceConfig.sourceId);
    const providerChanged = Boolean(protocol?.providerId && protocol.providerId !== sourceConfig.provider);
    const baseUrlChanged = Boolean(protocol?.baseUrl && protocol.baseUrl !== baseUrl);
    const lastProviderRequestAt = Date.parse(protocol?.lastProviderRequestAt ?? session.updatedAt);
    const cacheCold = session.messages.length > 0
      && Number.isFinite(lastProviderRequestAt)
      && Date.now() - lastProviderRequestAt >= getConfiguredPromptCacheTtlMs();
    const canMigrateProtocol = modelChanged || sourceChanged || providerChanged || baseUrlChanged || cacheCold;
    if (canMigrateProtocol && (!protocol || protocol.version < CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION
      || modelChanged || sourceChanged || providerChanged || baseUrlChanged)) {
      // The previous cache lane is unusable anyway, so this is a safe migration
      // boundary for the current serialization and tool schema.
      protocol = {
        version: CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION,
        serializationStrategy: 'provider-projection-v2',
        toolSchemaVersion: CURRENT_PROVIDER_TOOL_SCHEMA_VERSION,
        toolNames: [],
        modelId: model.id,
        sourceId: sourceConfig.sourceId,
        providerId: sourceConfig.provider,
        baseUrl,
        createdAt: new Date().toISOString()
      };
      session.requestProtocol = protocol;
    }

    if (!protocol) {
      // A pre-upgrade session stays on v1 until a cold/compaction boundary.
      // Persisting the explicit metadata freezes its tool set across restarts
      // without changing any provider-visible bytes.
      protocol = {
        version: LEGACY_PROVIDER_REQUEST_PROTOCOL_VERSION,
        serializationStrategy: 'legacy-v1',
        toolSchemaVersion: 1,
        toolNames: [],
        modelId: model.id,
        sourceId: sourceConfig.sourceId,
        providerId: sourceConfig.provider,
        baseUrl,
        createdAt: session.createdAt
      };
      session.requestProtocol = protocol;
    }

    protocol.modelId = protocol.modelId ?? model.id;
    protocol.sourceId = protocol.sourceId ?? sourceConfig.sourceId;
    protocol.providerId = protocol.providerId ?? model.provider;
    protocol.baseUrl = protocol.baseUrl ?? baseUrl;
    if (cacheCold) {
      // The provider prefix has already expired, so stale successful tool output
      // may be pruned without sacrificing a live cache entry.
      maintainArchivedToolResults(session, 'prune', 4);
      capOversizedFirstUserProviderContent(session);
    }
    if (!protocol.toolNames.length) {
      protocol.toolNames = getAgentToolNamesForPrompt(
        prompt,
        getConfiguredSlimToolModeEnabled(),
        protocol.version
      );
    }
    return [...protocol.toolNames];
  }

  private getSelectedModel(): KeepseekModel {
    const models = this.availableModels;
    const selected = findModelBySelection(models, {
      sourceId: this.selectedSourceId,
      modelId: this.selectedModelId
    }) ?? models[0];
    this.selectedSourceId = selected?.sourceId ?? '';
    this.selectedModelId = selected?.id ?? '';
    return selected ?? getConfiguredModels()[0];
  }

  private async createNewSession(): Promise<void> {
    if (this.isBusy || this.hasActiveBackgroundRun()) {
      return;
    }

    this.clearSessionTransientState();
    await this.sessionStore.createNewSession(this.language);
    await this.refreshSkills({ post: false });
    await this.cleanupExpiredSessions({ post: false });
    this.postToWebview({ type: 'sessionChanged' });
    this.postState();
  }

  private async selectSession(sessionId: string): Promise<void> {
    if (this.isBusy || this.hasActiveBackgroundRun()) {
      return;
    }

    const wasActiveSession = sessionId === this.sessionStore.activeSessionId;
    const session = await this.sessionStore.selectSession(sessionId);
    if (!session) {
      return;
    }

    if (!wasActiveSession) {
      this.clearSessionTransientState();
      await this.refreshCurrentRunContext(session, '');
      this.postToWebview({ type: 'sessionChanged' });
    }
    this.postState();
  }

  private async copyOtherWorkspaceSession(workspaceKey: string, sessionId: string): Promise<void> {
    if (this.isBusy || this.hasActiveBackgroundRun()) {
      return;
    }

    const session = await this.sessionStore.copyOtherWorkspaceSession(workspaceKey, sessionId);
    if (!session) {
      return;
    }

    this.clearSessionTransientState();
    await this.refreshCurrentRunContext(session, '');
    this.postToWebview({ type: 'sessionChanged' });
    this.postState();
  }

  private async deleteSessions(sessionIds: string[]): Promise<void> {
    if (this.isBusy || this.hasActiveBackgroundRun()) {
      return;
    }

    const uniqueSessionIds = Array.from(new Set(sessionIds.filter((sessionId) => typeof sessionId === 'string' && sessionId.trim())));
    if (!uniqueSessionIds.length) {
      return;
    }

    const confirmAction = this.t('deleteSessionsConfirmAction');
    const confirmed = await vscode.window.showWarningMessage(
      this.t('deleteSessionsConfirm', { count: uniqueSessionIds.length }),
      { modal: true },
      confirmAction
    );
    if (confirmed !== confirmAction) {
      return;
    }

    const result = await this.sessionStore.deleteSessions(uniqueSessionIds);
    if (!result.deletedCount) {
      return;
    }
    for (const sessionId of uniqueSessionIds) {
      this.changeSets.clearSession(sessionId);
      this.taskPlansBySession.delete(sessionId);
    }

    if (result.activeSessionChanged) {
      this.clearSessionTransientState();
      this.postToWebview({ type: 'sessionChanged' });
    }
    this.postState();
  }

  private async postOtherWorkspaces(): Promise<void> {
    try {
      this.postToWebview({
        type: 'otherWorkspaces',
        workspaces: await this.getOtherWorkspaceSummaries()
      });
    } catch (error) {
      this.postToWebview({
        type: 'otherWorkspaces',
        workspaces: [],
        error: getErrorMessage(error)
      });
    }
  }

  private async postOtherWorkspaceSessions(workspaceKey: string): Promise<void> {
    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.sessionStore.workspaceKey) {
      return;
    }

    try {
      this.postToWebview({
        type: 'otherWorkspaceSessions',
        workspaceKey: normalizedWorkspaceKey,
        sessions: await this.sessionStore.getOtherWorkspaceSessionSummaries(normalizedWorkspaceKey)
      });
    } catch (error) {
      this.postToWebview({
        type: 'otherWorkspaceSessions',
        workspaceKey: normalizedWorkspaceKey,
        sessions: [],
        error: getErrorMessage(error)
      });
    }
  }

  private async deleteOtherWorkspaceSessions(workspaceKey: string, sessionIds: string[]): Promise<void> {
    if (this.isBusy) {
      return;
    }

    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.sessionStore.workspaceKey) {
      return;
    }

    const uniqueSessionIds = Array.from(new Set(sessionIds.filter((sessionId) => typeof sessionId === 'string' && sessionId.trim())));
    if (!uniqueSessionIds.length) {
      return;
    }

    const confirmAction = this.t('deleteSessionsConfirmAction');
    const confirmed = await vscode.window.showWarningMessage(
      this.t('deleteSessionsConfirm', { count: uniqueSessionIds.length }),
      { modal: true },
      confirmAction
    );
    if (confirmed !== confirmAction) {
      return;
    }

    try {
      await this.sessionStore.deleteOtherWorkspaceSessions(normalizedWorkspaceKey, uniqueSessionIds);
      await this.postOtherWorkspaceSessions(normalizedWorkspaceKey);
      await this.postOtherWorkspaces();
    } catch (error) {
      const message = getErrorMessage(error);
      this.postToWebview({
        type: 'otherWorkspaceSessions',
        workspaceKey: normalizedWorkspaceKey,
        sessions: [],
        error: message
      });
      vscode.window.showErrorMessage(`${this.t('errorPrefix')}: ${message}`);
    }
  }

  private async deleteOtherWorkspace(workspaceKey: string): Promise<void> {
    if (this.isBusy) {
      return;
    }

    const normalizedWorkspaceKey = workspaceKey.trim();
    if (!normalizedWorkspaceKey || normalizedWorkspaceKey === this.sessionStore.workspaceKey) {
      return;
    }

    try {
      const summary = (await this.getOtherWorkspaceSummaries())
        .find((workspace) => workspace.workspaceKey === normalizedWorkspaceKey);
      if (!summary) {
        this.postToWebview({ type: 'otherWorkspaceDeleted', workspaceKey: normalizedWorkspaceKey });
        await this.postOtherWorkspaces();
        return;
      }

      const confirmAction = this.t('sessionDeleteWorkspaceConfirmAction');
      const confirmed = await vscode.window.showWarningMessage(
        this.t('sessionDeleteWorkspaceConfirm', {
          name: summary.workspaceName || normalizedWorkspaceKey,
          count: summary.sessionCount
        }),
        { modal: true },
        confirmAction
      );
      if (confirmed !== confirmAction) {
        return;
      }

      await this.sessionStore.deleteOtherWorkspace(normalizedWorkspaceKey);
      this.postToWebview({ type: 'otherWorkspaceDeleted', workspaceKey: normalizedWorkspaceKey });
      await this.postOtherWorkspaces();
    } catch (error) {
      const message = getErrorMessage(error);
      this.postToWebview({
        type: 'otherWorkspaceSessions',
        workspaceKey: normalizedWorkspaceKey,
        sessions: [],
        error: message
      });
      vscode.window.showErrorMessage(`${this.t('errorPrefix')}: ${message}`);
    }
  }

  private async getOtherWorkspaceSummaries(): Promise<WorkspaceSummary[]> {
    return (await this.sessionStore.getAllWorkspaceSummaries())
      .filter((workspace) => workspace.workspaceKey !== this.sessionStore.workspaceKey)
      .sort((a, b) => getWorkspaceSummaryTimestamp(b) - getWorkspaceSummaryTimestamp(a));
  }

  private async readPathToContext(inputPath: string): Promise<void> {
    await this.runContextAction(async () => {
      const files = await this.fileContext.addPath(inputPath);
      if (files.length) {
        vscode.window.showInformationMessage(this.t('addedFiles', { count: files.length }));
      }
    });
  }

  private async postReferenceResources(requestId: string): Promise<void> {
    try {
      this.postToWebview({
        type: 'referenceResources',
        requestId,
        resources: await getWorkspaceReferenceResources()
      });
    } catch (error) {
      this.postToWebview({
        type: 'referenceResources',
        requestId,
        resources: [],
        error: getErrorMessage(error)
      });
    }
  }

  public async refreshSkills(options: { post?: boolean } = {}): Promise<void> {
    await this.skillStore.refresh();
    const session = this.sessionStore.getActiveSession();
    this.skillStore.invalidateImplicitSkillSnapshot(session);
    await this.refreshCurrentRunContext(session, '');
    if (options.post !== false) {
      this.postState();
    }
  }

  private async refreshCurrentRunContext(
    session: ChatSession,
    prompt: string,
    explicitSkillIds?: readonly string[]
  ): Promise<{ context: CurrentRunContext; failures: Array<{ id: string; name: string; error: string }> }> {
    const [projectInstructions, activeSkillResult] = await Promise.all([
      this.projectInstructionsResolver.resolve(),
      this.skillStore.resolveAndLoadSkills({
        session,
        prompt,
        explicitSkillIds
      })
    ]);
    const context = buildCurrentRunContext({
      projectInstructions,
      skills: activeSkillResult.skills,
      skillActivationSkips: activeSkillResult.activation?.skipped,
      legacyMemory: this.legacyMemoryMigration.createReadonlyContext(prompt),
      skillCharacterBudget: getConfiguredSkillContextBudgetChars()
    });
    this.currentRunContextsBySession.set(session.id, context);
    return { context, failures: activeSkillResult.failures };
  }

  public async refreshBackgroundRunAvailability(options: { post?: boolean } = {}): Promise<void> {
    this.backgroundAvailableScripts = await getAvailableSafeValidationScripts();
    if (options.post !== false) {
      this.postState();
    }
  }

  private async useSkill(skillId: string): Promise<void> {
    if (this.isBusy) {
      return;
    }
    const activeSession = this.sessionStore.getActiveSession();
    if (!(await this.skillStore.useSkill(activeSession, skillId))) {
      this.postState();
      return;
    }
    activeSession.contextUsage = undefined;
    activeSession.updatedAt = new Date().toISOString();
    this.skillStore.invalidateImplicitSkillSnapshot(activeSession);
    await this.refreshCurrentRunContext(activeSession, '');
    await this.sessionStore.persist();
    this.postState();
  }

  private async removeActiveSkill(skillId: string): Promise<void> {
    if (this.isBusy) {
      return;
    }
    const activeSession = this.sessionStore.getActiveSession();
    if (!this.skillStore.removeActiveSkill(activeSession, skillId)) {
      return;
    }
    activeSession.contextUsage = undefined;
    activeSession.updatedAt = new Date().toISOString();
    this.skillStore.invalidateImplicitSkillSnapshot(activeSession);
    await this.refreshCurrentRunContext(activeSession, '');
    await this.sessionStore.persist();
    this.postState();
  }

  private async openSkill(skillId: string): Promise<void> {
    const manifest = this.skillStore.getManifest(skillId);
    if (!manifest) {
      return;
    }
    try {
      const document = await vscode.workspace.openTextDocument(manifest.skillUri);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      try {
        if (await revealReferenceInOperatingSystem(manifest.skillUri)) {
          return;
        }
      } catch (fallbackError) {
        vscode.window.showErrorMessage(this.t('cannotOpenFileReference', { message: getErrorMessage(fallbackError) }));
        return;
      }
      vscode.window.showErrorMessage(this.t('cannotOpenFileReference', { message: getErrorMessage(error) }));
    }
  }

  private async setSkillEnabled(skillId: string, enabled: boolean): Promise<void> {
    if (this.isBusy) {
      return;
    }
    const activeSession = this.sessionStore.getActiveSession();
    if (!(await this.skillStore.setSkillEnabled(activeSession, skillId, enabled))) {
      return;
    }
    activeSession.contextUsage = undefined;
    activeSession.updatedAt = new Date().toISOString();
    await this.refreshCurrentRunContext(activeSession, '');
    await this.sessionStore.persist();
    this.postState();
  }

  private async setSkillAllowImplicit(skillId: string, allowImplicit: boolean): Promise<void> {
    if (this.isBusy) {
      return;
    }
    if (!(await this.skillStore.setSkillAllowImplicit(skillId, allowImplicit))) {
      return;
    }
    await this.refreshCurrentRunContext(this.sessionStore.getActiveSession(), '');
    this.postState();
  }

  private async setSkillWorkspaceDefault(skillId: string, enabled: boolean): Promise<void> {
    if (this.isBusy) {
      return;
    }
    if (!(await this.skillStore.setSkillWorkspaceDefault(skillId, enabled))) {
      return;
    }
    const activeSession = this.sessionStore.getActiveSession();
    activeSession.contextUsage = undefined;
    activeSession.updatedAt = new Date().toISOString();
    await this.refreshCurrentRunContext(activeSession, '');
    await this.sessionStore.persist();
    this.postState();
  }

  private appendChangeSetTimelineMessage(content: string): ChatMessage {
    const activeSession = this.sessionStore.getActiveSession();
    const message: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
      contextMeta: createProtectedContextMeta('draft_edit_result')
    };
    activeSession.messages.push(message);
    activeSession.updatedAt = message.createdAt;
    return message;
  }

  private async createSkillDraft(message: Extract<WebviewMessage, { type: 'createSkillDraft' }>): Promise<void> {
    if (!vscode.workspace.isTrusted) {
      vscode.window.showErrorMessage(this.t('createSkillWorkspaceUntrusted'));
      return;
    }

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage(this.t('createSkillWorkspaceRequired'));
      return;
    }

    try {
      const draft = this.skillCreator.createDraft({
        workspaceFolder,
        rawName: message.name,
        description: message.description,
        allowImplicit: message.allowImplicit,
        userInvocable: message.userInvocable,
        language: this.language
      });

      if (await this.uriExists(draft.targetUri)) {
        vscode.window.showErrorMessage(this.t('createSkillAlreadyExists', { label: draft.label }));
        return;
      }

      const edit: DraftEdit = {
        id: randomUUID(),
        uri: draft.targetUri.toString(),
        label: draft.label,
        action: 'create',
        newText: draft.content,
        reason: draft.reason
      };
      const timelineMessage = this.appendChangeSetTimelineMessage(
        this.t('createSkillDraftCreated', { label: draft.label })
      );
      this.changeSets.addDraftEdits({
        edits: [edit],
        sessionId: this.sessionStore.activeSessionId,
        messageId: timelineMessage.id,
        operationSummary: draft.reason
      });
      await this.sessionStore.persist();
      this.postState();
      this.postToWebview({ type: 'skillDraftCreated', label: draft.label });
      vscode.window.showInformationMessage(this.t('createSkillDraftCreated', { label: draft.label }));
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotCreateSkillDraft', { message: getErrorMessage(error) }));
    }
  }

  private async uriExists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  private async postClipboardText(requestId: string): Promise<void> {
    try {
      this.postToWebview({
        type: 'clipboardText',
        requestId,
        text: await vscode.env.clipboard.readText()
      });
    } catch (error) {
      this.postToWebview({
        type: 'clipboardText',
        requestId,
        text: '',
        error: getErrorMessage(error)
      });
    }
  }

  private async writeClipboardText(text: string): Promise<void> {
    try {
      await vscode.env.clipboard.writeText(text);
    } catch {
      // Clipboard writes are best-effort for shortcut compatibility.
    }
  }

  private async openDirectoryReference(inputPath: string): Promise<void> {
    try {
      if (!inputPath.trim()) {
        throw new Error(this.t('directoryReferenceNoPath'));
      }

      const uri = resolveFileReferenceUri(inputPath);
      if (!uri) {
        throw new Error(this.t('directoryReferenceInvalidPath'));
      }

      const stat = await vscode.workspace.fs.stat(uri);
      if ((stat.type & vscode.FileType.Directory) === 0) {
        throw new Error(this.t('directoryReferenceInvalidPath'));
      }

      if (!(await openDirectoryReferenceUri(uri))) {
        throw new Error(this.t('directoryReferenceInvalidPath'));
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('cannotOpenDirectoryReference', { message: getErrorMessage(error) }));
    }
  }

  private async refreshModelSourceState(): Promise<void> {
    const generation = ++this.modelSourceStateRefreshGeneration;
    const refreshPromise = (async () => {
      const modelSources = await this.sourceStore.listSources();
      const availableModels = createModelCatalog(modelSources);
      const selection = getConfiguredModelSelection(availableModels);
      const selectedModel = findModelBySelection(availableModels, selection);
      if (selectedModel?.sourceId && selectedModel.supportsBilling) {
        await this.balanceStore.refreshFromDisk(this.getBalanceSourceScope(selectedModel.sourceId));
      }
      if (generation !== this.modelSourceStateRefreshGeneration) {
        return;
      }
      this.modelSources = modelSources;
      this.availableModels = availableModels;
      this.selectedSourceId = selectedModel?.sourceId ?? '';
      this.selectedModelId = selectedModel?.id ?? '';
      if (selectedModel?.sourceId) {
        this.balanceStore.selectSource(this.getBalanceSourceScope(selectedModel.sourceId));
      }
    })();
    this.modelSourceStateRefreshPromise = refreshPromise;

    // Callers that triggered an older refresh wait through the newest refresh
    // before posting state, so a config event cannot make them publish stale UI.
    let pending = refreshPromise;
    while (true) {
      try {
        await pending;
      } catch (error) {
        if (this.modelSourceStateRefreshPromise === pending) {
          throw error;
        }
      }
      const latest = this.modelSourceStateRefreshPromise;
      if (!latest || latest === pending) {
        return;
      }
      pending = latest;
    }
  }

  private getBalanceSourceScope(sourceId: string): BalanceSourceScope {
    const source = this.modelSources.find((candidate) => candidate.id === sourceId);
    return {
      provider: source?.provider ?? 'deepseek',
      sourceId
    };
  }

  private postModelSettingsDialog(): void {
    this.postToWebview({
      type: 'showSettingsDialog',
      selectedSourceId: this.selectedSourceId,
      sources: this.modelSources.map((source) => ({
        ...source,
        models: source.models.map((model) => ({ ...model })),
        disabledModelIds: source.disabledModelIds ? [...source.disabledModelIds] : [],
        modelCache: source.modelCache
          ? {
              fetchedAt: source.modelCache.fetchedAt,
              models: source.modelCache.models.map((model) => ({ ...model }))
            }
          : undefined,
        availableModels: createModelCatalog([source], { includeDisabledModels: true }).map((model) => ({
          id: model.id,
          name: model.fetchedName ?? model.label,
          contextWindowTokens: model.contextWindowTokens,
          contextWindowSource: model.contextWindowSource,
          maxOutputTokens: model.maxOutputTokens,
          maxOutputSource: model.maxOutputSource,
          agentCompatible: model.agentCompatible !== false,
          nonTextModelKind: model.nonTextModelKind,
          supportsBilling: model.supportsBilling === true
        })),
        isOfficialDeepSeek: isOfficialDeepSeekSource(source)
      }))
    });
  }

  private async waitForBalanceRefresh(): Promise<void> {
    if (this.balanceRefreshPromise) {
      await this.balanceRefreshPromise;
    }
  }

  private rejectModelSourceMutationWhileBusy(): boolean {
    if (!this.isBusy) {
      return false;
    }
    void vscode.window.showInformationMessage(this.t('modelSettingsReadonlyWhileBusy'));
    this.postModelSettingsDialog();
    return true;
  }

  private async addModel(input: {
    sourceId?: string;
    provider: ModelSourceProvider;
    name?: string;
    apiKey: string;
    baseUrl: string;
    modelId?: string;
    contextWindowTokens?: number;
    maxOutputTokens?: number;
  }): Promise<void> {
    if (this.rejectModelSourceMutationWhileBusy()) {
      return;
    }
    try {
      await this.waitForBalanceRefresh();
      const result = await this.modelSourceService.addModel(input);
      await this.refreshModelSourceState();
      const selected = findModelBySelection(this.availableModels, {
        sourceId: result.source.id,
        modelId: input.modelId?.trim()
      }) ?? this.availableModels.find((model) => model.sourceId === result.source.id);
      if (selected?.sourceId) {
        await this.persistModelSelection(selected.sourceId, selected.id);
      }
      this.postState();
      this.postModelSettingsDialog();
      this.postToWebview({
        type: 'addModelResult',
        ok: true,
        reusedSource: result.reusedSource
      });
      if (result.modelDiscoveryUnavailable) {
        vscode.window.showWarningMessage(this.language === 'en'
          ? 'The account was saved, but this Anthropic-compatible endpoint does not provide a model list. Add a model ID manually in account settings.'
          : '账号已保存，但此 Anthropic 兼容端点不提供模型列表。请在账号设置中手动添加模型 ID。');
      } else if (result.discovery?.status === 'failed') {
        vscode.window.showWarningMessage(this.language === 'en'
          ? 'The model was saved, but automatic model discovery failed. You can refresh it manually.'
          : '模型已保存，但自动获取模型失败；可稍后手动刷新。');
      }
      void this.refreshBalance({ force: true });
    } catch (error) {
      const errorMessage = getErrorMessage(error);
      vscode.window.showErrorMessage(this.t('modelOperationFailed', { message: errorMessage }));
      this.postToWebview({
        type: 'addModelResult',
        ok: false,
        error: errorMessage
      });
    }
  }

  private async deleteModel(input: { sourceId: string; modelId: string }): Promise<void> {
    if (this.rejectModelSourceMutationWhileBusy()) {
      return;
    }
    try {
      await this.waitForBalanceRefresh();
      const source = await this.sourceStore.getSource(input.sourceId);
      if (!source) {
        throw new Error(this.t('modelSourceNotFound'));
      }
      const modelId = input.modelId.trim();
      await this.modelSourceService.removeModel(input.sourceId, modelId);
      await this.refreshModelSourceState();
      if (this.selectedSourceId === input.sourceId && this.selectedModelId === modelId) {
        const fallback = this.availableModels.find((model) => model.sourceId === input.sourceId);
        if (fallback?.sourceId) {
          await this.persistModelSelection(fallback.sourceId, fallback.id);
        }
      }
      this.postState();
      this.postModelSettingsDialog();
    } catch (error) {
      vscode.window.showErrorMessage(this.t('modelOperationFailed', { message: getErrorMessage(error) }));
      this.postModelSettingsDialog();
    }
  }

  private async setModelEnabled(input: {
    sourceId: string;
    modelId: string;
    enabled: boolean;
  }): Promise<void> {
    if (this.rejectModelSourceMutationWhileBusy()) {
      return;
    }
    try {
      await this.waitForBalanceRefresh();
      await this.modelSourceService.setModelEnabled(
        input.sourceId,
        input.modelId,
        input.enabled
      );
      await this.refreshModelSourceState();
      await this.persistModelSelection(this.selectedSourceId, this.selectedModelId);
      this.postState();
      this.postModelSettingsDialog();
    } catch (error) {
      vscode.window.showErrorMessage(this.t('modelOperationFailed', { message: getErrorMessage(error) }));
      this.postModelSettingsDialog();
    }
  }

  private async setModelContextWindow(input: {
    sourceId: string;
    modelId: string;
    contextWindowTokens: number;
  }): Promise<void> {
    if (this.rejectModelSourceMutationWhileBusy()) {
      return;
    }
    try {
      await this.waitForBalanceRefresh();
      await this.modelSourceService.setModelContextWindowTokens(
        input.sourceId,
        input.modelId,
        input.contextWindowTokens
      );
      await this.refreshModelSourceState();
      this.postState();
      this.postModelSettingsDialog();
    } catch (error) {
      vscode.window.showErrorMessage(this.t('modelOperationFailed', { message: getErrorMessage(error) }));
      this.postModelSettingsDialog();
    }
  }

  private async setModelMaxOutput(input: {
    sourceId: string;
    modelId: string;
    maxOutputTokens: number;
  }): Promise<void> {
    if (this.rejectModelSourceMutationWhileBusy()) {
      return;
    }
    try {
      await this.waitForBalanceRefresh();
      await this.modelSourceService.setModelMaxOutputTokens(
        input.sourceId,
        input.modelId,
        input.maxOutputTokens
      );
      await this.refreshModelSourceState();
      this.postState();
      this.postModelSettingsDialog();
    } catch (error) {
      vscode.window.showErrorMessage(this.t('modelOperationFailed', { message: getErrorMessage(error) }));
      this.postModelSettingsDialog();
    }
  }

  private async saveModelSource(input: {
    sourceId: string;
    name?: string;
    apiKey: string;
    baseUrl: string;
  }): Promise<void> {
    if (this.rejectModelSourceMutationWhileBusy()) {
      return;
    }
    try {
      const source = await this.sourceStore.getSource(input.sourceId);
      if (!source) {
        throw new Error(this.t('modelSourceNotFound'));
      }
      await this.waitForBalanceRefresh();
      const result = await this.modelSourceService.saveSource(input);
      if (result.connectionChanged) {
        await this.balanceStore.clear({ provider: source.provider, sourceId: source.id });
      }
      await this.refreshModelSourceState();
      this.postState();
      this.postModelSettingsDialog();
      if (result.discovery?.status === 'failed') {
        vscode.window.showWarningMessage(this.language === 'en'
          ? 'The source was saved, but automatic model discovery failed. You can refresh it manually.'
          : '来源已保存，但自动获取模型失败；可稍后手动刷新。');
      }
      if (this.selectedSourceId === source.id) {
        void this.refreshBalance({ force: result.connectionChanged });
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('modelOperationFailed', { message: getErrorMessage(error) }));
      this.postModelSettingsDialog();
    }
  }

  private async deleteModelSource(sourceId: string): Promise<void> {
    if (this.rejectModelSourceMutationWhileBusy()) {
      return;
    }
    const source = await this.sourceStore.getSource(sourceId);
    if (!source) {
      this.postModelSettingsDialog();
      return;
    }
    const deleteAction = this.t('deleteModelSourceConfirmAction');
    const confirmed = await vscode.window.showWarningMessage(
      this.t('deleteModelSourceConfirm', { name: source.name }),
      { modal: true },
      deleteAction
    );
    if (confirmed !== deleteAction) {
      this.postModelSettingsDialog();
      return;
    }

    let sourceRemoved = false;
    try {
      await this.waitForBalanceRefresh();
      await this.balanceStore.deleteSource({ provider: source.provider, sourceId: source.id });
      await this.sourceStore.deleteSource(source.id);
      sourceRemoved = true;
      this.scrubDeletedModelSourceFromMemory(source.id);
      await this.refreshModelSourceState();
      this.postState();
      this.postModelSettingsDialog();
      void this.refreshBalance({ force: true });
    } catch (error) {
      try {
        await this.refreshModelSourceState();
      } catch {
        if (sourceRemoved) {
          this.scrubDeletedModelSourceFromMemory(source.id);
        }
      }
      vscode.window.showErrorMessage(this.t('modelOperationFailed', { message: getErrorMessage(error) }));
      this.postState();
      this.postModelSettingsDialog();
    }
  }

  private scrubDeletedModelSourceFromMemory(sourceId: string): void {
    // Invalidate any refresh that captured this source before its file was
    // deleted; otherwise that stale read could re-publish the removed key.
    this.modelSourceStateRefreshGeneration += 1;
    this.modelSources = this.modelSources.filter((source) => source.id !== sourceId);
    this.availableModels = createModelCatalog(this.modelSources);
    const selected = findModelBySelection(this.availableModels, getConfiguredModelSelection(this.availableModels));
    this.selectedSourceId = selected?.sourceId ?? '';
    this.selectedModelId = selected?.id ?? '';
  }

  private async refreshSourceModels(sourceId: string): Promise<void> {
    if (this.rejectModelSourceMutationWhileBusy()) {
      return;
    }
    try {
      const result = await refreshSourceModelCache(this.sourceStore, sourceId, { force: true });
      await this.refreshModelSourceState();
      this.postState();
      this.postModelSettingsDialog();
      if (result.status === 'failed') {
        vscode.window.showWarningMessage(this.language === 'en'
          ? 'Model discovery failed. The previous model list was kept.'
          : '获取模型失败，已保留原模型列表。');
      }
    } catch (error) {
      vscode.window.showErrorMessage(this.t('modelOperationFailed', { message: getErrorMessage(error) }));
      this.postModelSettingsDialog();
    }
  }

  private async setSelectedModel(sourceId: string, modelId: string): Promise<void> {
    if (this.isBusy) {
      return;
    }
    const model = findModelBySelection(this.availableModels, { sourceId, modelId });
    if (!model?.sourceId) {
      return;
    }
    await this.persistModelSelection(model.sourceId, model.id);
    this.balanceStore.selectSource(this.getBalanceSourceScope(model.sourceId));
    void this.refreshBalance({ force: false });
    this.postState();
  }

  private async persistModelSelection(sourceId: string, modelId: string): Promise<void> {
    this.selectedSourceId = sourceId;
    this.selectedModelId = modelId;
    const config = vscode.workspace.getConfiguration('keepseek');
    await Promise.all([
      config.update('selectedSourceId', sourceId, vscode.ConfigurationTarget.Workspace),
      config.update('selectedModelId', modelId, vscode.ConfigurationTarget.Workspace)
    ]);
  }

  private syncConfiguredState(): void {
    const selected = findModelBySelection(this.availableModels, getConfiguredModelSelection(this.availableModels));
    this.selectedSourceId = selected?.sourceId ?? '';
    this.selectedModelId = selected?.id ?? '';
    this.agentSettings = getConfiguredAgentSettings();
    this.language = getConfiguredKeepseekLanguage();
    this.sessionStore.setLanguage(this.language);
  }

  private async setAgentSettings(settings: Partial<AgentSettings>): Promise<void> {
    this.agentSettings = normalizeAgentSettings(settings, this.agentSettings);
    const config = vscode.workspace.getConfiguration('keepseek');
    await Promise.all([
      config.update('thinkingEnabled', this.agentSettings.thinkingEnabled, vscode.ConfigurationTarget.Workspace),
      config.update('reasoningEffort', this.agentSettings.reasoningEffort, vscode.ConfigurationTarget.Workspace),
      config.update('compressionThreshold', this.agentSettings.compressionThreshold, vscode.ConfigurationTarget.Workspace)
    ]);
    this.postState();
  }

  private async setDebugMode(enabled: boolean): Promise<void> {
    if (this.isBusy) {
      return;
    }

    const debugMode = enabled === true;
    const config = vscode.workspace.getConfiguration('keepseek');
    await config.update('trace.enabled', debugMode, vscode.ConfigurationTarget.Global);
    this.postState();
    vscode.window.showInformationMessage(this.t(debugMode ? 'debugModeEnabled' : 'debugModeDisabled'));
  }

  private async openCurrentSessionLog(): Promise<void> {
    if (!getConfiguredDebugMode()) {
      vscode.window.showWarningMessage(this.t('debugModeRequiredForLogs'));
      this.postState();
      return;
    }

    const activeSession = this.sessionStore.getActiveSession();
    const logUriText = activeSession.lastTraceLogUri?.trim()
      || this.sessionTraceLogUris.get(activeSession.id)?.trim();
    if (!logUriText) {
      vscode.window.showWarningMessage(this.t('currentSessionLogUnavailable'));
      this.postState();
      return;
    }

    try {
      const logUri = vscode.Uri.parse(logUriText);
      const stat = await vscode.workspace.fs.stat(logUri);
      if (stat.type !== vscode.FileType.File) {
        throw new Error(this.t('currentSessionLogInvalid'));
      }

      const document = await vscode.workspace.openTextDocument(logUri);
      activeSession.lastTraceLogUri = logUriText;
      this.sessionTraceLogUris.set(activeSession.id, logUriText);
      await vscode.window.showTextDocument(document, { preview: false });
    } catch (error) {
      activeSession.lastTraceLogUri = undefined;
      this.sessionTraceLogUris.delete(activeSession.id);
      await this.sessionStore.persist();
      this.postState();
      vscode.window.showErrorMessage(this.t('cannotOpenCurrentSessionLog', { message: getErrorMessage(error) }));
    }
  }

  private async refreshBalance(options: { force?: boolean; post?: boolean } = {}): Promise<void> {
    if (this.balanceRefreshPromise) {
      await this.balanceRefreshPromise;
      return;
    }

    const refresh = this.performBalanceRefresh(options).finally(() => {
      if (this.balanceRefreshPromise === refresh) {
        this.balanceRefreshPromise = undefined;
      }
    });
    this.balanceRefreshPromise = refresh;
    await refresh;
  }

  private async performBalanceRefresh(options: { force?: boolean; post?: boolean }): Promise<void> {
    const selectedModel = findModelBySelection(this.availableModels, {
      sourceId: this.selectedSourceId,
      modelId: this.selectedModelId
    });
    if (!selectedModel?.sourceId || !selectedModel.supportsBilling) {
      if (options.post !== false) {
        this.postState();
      }
      return;
    }
    const source = await resolveModelSourceConfig(selectedModel.sourceId, this.globalStorageUri, {
      sourceStore: this.sourceStore,
      language: this.language,
      requireApiKey: false
    });
    if (!source.supportsBilling) {
      if (options.post !== false) {
        this.postState();
      }
      return;
    }
    const scope = this.getBalanceSourceScope(source.sourceId);
    this.balanceStore.selectSource(scope);

    const apiKey = source.apiKey.trim();
    if (!apiKey) {
      // 无 API key：保留当前来源余额快照，只刷新 UI。
      if (options.post !== false) {
        this.postState();
      }
      return;
    }

    const now = Date.now();
    // 每个来源独立共享限流时间戳；同来源跨窗口仍只发一份请求节奏。
    if (!(await this.balanceStore.claimRefresh(
      now,
      getConfiguredBalanceRefreshIntervalMs(),
      options.force,
      scope
    ))) {
      if (options.post !== false) {
        // 未到期：不请求，但把磁盘上的最新共享记录同步进内存并推给 UI。
        this.postState();
      }
      return;
    }

    try {
      const balance = await fetchModelSourceBalance({
        provider: source.provider,
        apiKey,
        baseUrl: source.baseUrl
      });
      await this.balanceStore.update(balance, Date.now(), scope);
      if (options.post !== false) {
        this.postState();
      }
    } finally {
      this.balanceStore.releaseRefreshClaim(scope);
    }
  }

  private async runContextAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      this.postState();
    } catch (error) {
      vscode.window.showErrorMessage(getErrorMessage(error));
      this.postState();
    }
  }

  private collectAuthorizedExternalReferenceUris(references: PromptReferenceInput[] | undefined): Set<string> {
    const authorized = new Set(this.authorizedExternalReferenceUris);
    if (!references?.length) {
      return authorized;
    }

    for (const reference of references) {
      if (!reference || typeof reference.path !== 'string') {
        continue;
      }
      const uri = resolveFileReferenceUri(reference.path);
      if (!uri || vscode.workspace.getWorkspaceFolder(uri)) {
        continue;
      }
      const key = getFileReferenceAuthorizationKey(uri);
      this.authorizedExternalReferenceUris.add(key);
      authorized.add(key);
    }

    return authorized;
  }

  private authorizeExternalReferenceUri(uri: vscode.Uri): void {
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return;
    }
    this.authorizedExternalReferenceUris.add(getFileReferenceAuthorizationKey(uri));
  }

  private setAgentActivity(
    activity: AgentActivityInput,
    options: { post?: boolean; schedulePost?: () => void } = {}
  ): boolean {
    const normalizedActivity: AgentActivityInput = {
      base: activity.base,
      phase: activity.phase,
      toolName: activity.toolName?.trim() || undefined,
      detail: activity.detail?.trim() || undefined
    };
    if (
      this.agentActivity.base === normalizedActivity.base &&
      this.agentActivity.phase === normalizedActivity.phase &&
      this.agentActivity.toolName === normalizedActivity.toolName &&
      this.agentActivity.detail === normalizedActivity.detail
    ) {
      return false;
    }

    this.agentActivitySequence += 1;
    this.agentActivity = {
      ...normalizedActivity,
      updatedAt: new Date().toISOString(),
      sequence: this.agentActivitySequence
    };

    if (options.post === false) {
      return true;
    }
    if (options.schedulePost) {
      options.schedulePost();
    } else {
      this.postState();
    }
    return true;
  }

  private abortPrompt(): void {
    if (!this.isBusy || !this.currentRunAbortController || this.currentRunAbortController.signal.aborted) {
      return;
    }
    this.currentRunAbortController.abort();
    this.setAgentActivity({
      base: 'waiting',
      phase: 'finalizing'
    });
  }

  private async handleAppliedRepairEdits(appliedEditIds: readonly string[]): Promise<void> {
    const sessionId = this.sessionStore.activeSessionId;
    const activeSession = this.sessionStore.getActiveSession();
    const repairLoop = this.repairLoopsBySession.get(sessionId) ?? activeSession.repairLoop;
    if (!repairLoop || repairLoop.status !== 'waiting_for_apply') {
      return;
    }
    const applied = new Set(appliedEditIds);
    const pendingDraftEditIds = repairLoop.pendingDraftEditIds.filter((id) => !applied.has(id));
    if (pendingDraftEditIds.length === repairLoop.pendingDraftEditIds.length) {
      return;
    }
    const next: RepairLoopState = {
      ...repairLoop,
      pendingDraftEditIds,
      status: pendingDraftEditIds.length ? 'waiting_for_apply' : 'ready_for_validation',
      stopReason: pendingDraftEditIds.length ? 'waiting_for_apply' : undefined
    };
    this.repairLoopsBySession.set(sessionId, next);
    activeSession.repairLoop = next;
    if (!pendingDraftEditIds.length) {
      const plan = this.taskPlansBySession.get(sessionId);
      if (plan) {
        this.taskPlansBySession.set(sessionId, markTaskPlanReadyForValidation(plan, this.language));
        this.appendRepairTrace(plan, {
          type: 'repair_loop_ready_for_validation',
          iteration: next.iteration,
          appliedEditIds
        });
      }
    }
    await this.sessionStore.persist();
  }

  private async markActiveRepairDiscarded(editId?: string): Promise<void> {
    const sessionId = this.sessionStore.activeSessionId;
    const activeSession = this.sessionStore.getActiveSession();
    const repairLoop = this.repairLoopsBySession.get(sessionId) ?? activeSession.repairLoop;
    if (!repairLoop || repairLoop.status !== 'waiting_for_apply') {
      return;
    }
    if (editId && !repairLoop.pendingDraftEditIds.includes(editId)) {
      return;
    }
    const next: RepairLoopState = {
      ...repairLoop,
      status: 'blocked',
      pendingDraftEditIds: editId
        ? repairLoop.pendingDraftEditIds.filter((id) => id !== editId)
        : [],
      stopReason: 'repair_discarded'
    };
    this.repairLoopsBySession.set(sessionId, next);
    activeSession.repairLoop = next;
    const plan = this.taskPlansBySession.get(sessionId);
    if (plan) {
      const detail = this.language === 'en'
        ? 'The pending repair was discarded. Start a new repair request to continue.'
        : '待确认修复已被放弃。请发起新的修复请求后继续。';
      this.taskPlansBySession.set(sessionId, {
        ...plan,
        status: 'blocked',
        currentStepId: undefined,
        blockers: [...plan.blockers.filter((blocker) => !/apply|应用/iu.test(blocker)), detail],
        updatedAt: new Date().toISOString()
      });
      this.appendRepairTrace(plan, { type: 'repair_loop_stopped', reason: 'repair_discarded', editId });
    }
    const backgroundRun = this.backgroundRunCoordinator.getActiveRun();
    if (backgroundRun?.sessionId === sessionId && backgroundRun.status === 'waiting_for_apply') {
      const failed = this.backgroundRunCoordinator.fail(this.language === 'en'
        ? 'The pending background repair ChangeSet was discarded.'
        : '后台修复任务的待确认 ChangeSet 已被丢弃。');
      await this.appendBackgroundOutcomeMessage(failed.stopReason ?? 'The pending repair was discarded.');
    }
    await this.sessionStore.persist();
  }

  private async continueRepair(): Promise<void> {
    if (this.isBusy) {
      return;
    }
    const sessionId = this.sessionStore.activeSessionId;
    const activeSession = this.sessionStore.getActiveSession();
    const repairLoop = this.repairLoopsBySession.get(sessionId) ?? activeSession.repairLoop;
    if (!repairLoop || repairLoop.status !== 'ready_for_validation') {
      return;
    }
    const next: RepairLoopState = {
      ...repairLoop,
      status: 'running_validation',
      pendingDraftEditIds: [],
      stopReason: undefined
    };
    this.repairLoopsBySession.set(sessionId, next);
    activeSession.repairLoop = next;
    const script = next.lastValidationScript ?? 'compile';
    const prompt = this.language === 'en'
      ? `Continue the controlled repair loop. The user applied the previous repair ChangeSet. First run keepseek_run_validation with script "${script}" against the real workspace. If it still fails, read Problems and prepare another ChangeSet only if the remaining repair budget allows it.`
      : `继续受控修复闭环。用户已经应用上一个修复 ChangeSet。请先对真实工作区运行 keepseek_run_validation，script 为“${script}”。如果仍然失败，请读取 Problems，并且只在剩余修复轮次允许时准备新的 ChangeSet。`;
    const plan = this.taskPlansBySession.get(sessionId);
    if (plan) {
      this.appendRepairTrace(plan, { type: 'repair_loop_resumed', iteration: next.iteration, script });
    }
    await this.sendPrompt(prompt, this.selectedSourceId, this.selectedModelId, this.agentSettings, { repairLoop: next });
    const latest = this.repairLoopsBySession.get(sessionId) ?? activeSession.repairLoop;
    if (latest?.status === 'running_validation') {
      const ready: RepairLoopState = { ...latest, status: 'ready_for_validation' };
      this.repairLoopsBySession.set(sessionId, ready);
      activeSession.repairLoop = ready;
      await this.sessionStore.persist();
      this.postState();
    }
  }

  private appendRepairTrace(plan: TaskPlan, event: { type: string; [key: string]: unknown }): void {
    const session = this.sessionStore.getActiveSession();
    void this.traceLogService.appendRunEvent(
      session.lastTraceLogUri ? { runId: plan.runId, uri: session.lastTraceLogUri } : undefined,
      event
    );
  }

  private appendLegacyMemoryTrace(event: { type: string; [key: string]: unknown }): void {
    const session = this.sessionStore.getActiveSession();
    const latestDetails = [...session.messages].reverse().find((message) => message.runDetails)?.runDetails;
    const uri = latestDetails?.traceLogUri ?? session.lastTraceLogUri;
    void this.traceLogService.appendRunEvent(
      uri && latestDetails?.runId ? { runId: latestDetails.runId, uri } : undefined,
      event
    );
  }

  private async createLegacyMemoryMigrationDraft(): Promise<void> {
    if (this.isBusy || !this.legacyMemoryMigration.getStateView().canCreateDraft) {
      return;
    }
    try {
      const draft = await this.legacyMemoryMigration.createDraft();
      const timelineMessage = draft.edits.length
        ? this.appendChangeSetTimelineMessage(
            this.t('legacyMemoryMigrationDraftCreated', { count: draft.edits.length })
          )
        : undefined;
      const changeSet = this.changeSets.addDraftEdits({
        edits: draft.edits,
        sessionId: this.sessionStore.activeSessionId,
        messageId: timelineMessage?.id,
        operationSummary: this.t('legacyMemoryMigrationDraftReason')
      });
      await this.legacyMemoryMigration.markDraftCreated(changeSet?.id);
      if (timelineMessage) {
        await this.sessionStore.persist();
      }
      this.appendLegacyMemoryTrace({
        type: 'legacy_memory_migration_draft_created',
        sourceUris: draft.sourceUris,
        entryCount: draft.entryCount,
        changeSetId: changeSet?.id,
        editCount: draft.edits.length
      });
      if (!draft.edits.length && draft.exportText) {
        await vscode.env.clipboard.writeText(draft.exportText);
        vscode.window.showInformationMessage(this.t('legacyMemoryExportCopied'));
      } else {
        vscode.window.showInformationMessage(this.t('legacyMemoryMigrationDraftCreated', { count: draft.edits.length }));
      }
      this.postState();
    } catch (error) {
      vscode.window.showErrorMessage(getErrorMessage(error));
    }
  }

  private async exportLegacyMemory(): Promise<void> {
    try {
      const content = await this.legacyMemoryMigration.getExportText();
      if (!content) {
        return;
      }
      await vscode.env.clipboard.writeText(content);
      this.appendLegacyMemoryTrace({ type: 'legacy_memory_export_copied' });
      vscode.window.showInformationMessage(this.t('legacyMemoryExportCopied'));
    } catch (error) {
      vscode.window.showErrorMessage(getErrorMessage(error));
    }
  }

  private async completeLegacyMemoryMigration(): Promise<void> {
    const state = this.legacyMemoryMigration.getStateView();
    if (state.status !== 'draft-created' || !state.detected) {
      return;
    }
    if (state.lastDraftChangeSetId) {
      if (!this.changeSets.isChangeSetFullyApplied(state.lastDraftChangeSetId)) {
        vscode.window.showWarningMessage(this.t('legacyMemoryApplyBeforeComplete'));
        return;
      }
    }
    await this.legacyMemoryMigration.complete();
    await this.refreshCurrentRunContext(this.sessionStore.getActiveSession(), '');
    this.appendLegacyMemoryTrace({ type: 'legacy_memory_migration_completed' });
    this.postState();
  }

  private async rollbackLegacyMemoryMigration(): Promise<void> {
    if (!this.getLegacyMemoryMigrationStateView().canRollback) {
      return;
    }
    await this.legacyMemoryMigration.rollback();
    await this.refreshCurrentRunContext(this.sessionStore.getActiveSession(), '');
    this.appendLegacyMemoryTrace({ type: 'legacy_memory_migration_rolled_back' });
    this.postState();
  }

  private async openRunTrace(messageId: string): Promise<void> {
    const message = this.messages.find((item) => item.id === messageId);
    const uri = message?.runDetails?.traceLogUri;
    if (!uri) {
      vscode.window.showInformationMessage(this.language === 'en'
        ? 'This run does not have a raw trace log. Enable Debug Mode for future raw logs.'
        : '本次运行没有原始 trace log。可开启调试模式以记录后续运行。');
      return;
    }
    try {
      await vscode.commands.executeCommand('vscode.open', vscode.Uri.parse(uri));
    } catch (error) {
      vscode.window.showErrorMessage(getErrorMessage(error));
    }
  }

  private async startBackgroundRun(script: SafeNpmScript, requestedMaxRounds: number): Promise<void> {
    if (this.isBusy) {
      return;
    }
    const safeScript: SafeNpmScript = script === 'test' || script === 'lint' ? script : 'compile';
    await this.refreshBackgroundRunAvailability({ post: false });
    if (!this.backgroundAvailableScripts.includes(safeScript)) {
      this.postState();
      vscode.window.showInformationMessage(this.language === 'en'
        ? `The current workspace does not define an available safe "${safeScript}" npm script.`
        : `当前工作区没有可用的安全 npm 脚本“${safeScript}”。`);
      return;
    }
    const configuredMaxRounds = getConfiguredBackgroundMaxRounds();
    const maxRounds = normalizeIntegerInRange(requestedMaxRounds, 1, configuredMaxRounds, configuredMaxRounds);
    try {
      this.backgroundRunCoordinator.start({
        sessionId: this.sessionStore.activeSessionId,
        workspaceKey: this.sessionStore.workspaceKey,
        goal: {
          kind: 'repair_until_validation_passes',
          script: safeScript,
          description: this.language === 'en'
            ? `Repair until ${safeScript} passes, with review between ChangeSets.`
            : `持续修复直到 ${safeScript} 通过，每个 ChangeSet 仍需用户审核。`
        },
        limits: {
          maxRounds,
          maxDurationMs: getConfiguredBackgroundMaxDurationMs(),
          maxToolCalls: getConfiguredBackgroundMaxToolCalls()
        }
      });
      await this.executeBackgroundRound(false);
    } catch (error) {
      vscode.window.showErrorMessage(getErrorMessage(error));
    }
  }

  private hasActiveBackgroundRun(): boolean {
    const status = this.backgroundRunCoordinator.getActiveRun()?.status;
    return status === 'running' || status === 'waiting_for_apply' || status === 'waiting_for_authorization';
  }

  private async resumeBackgroundRun(): Promise<void> {
    if (this.isBusy) {
      return;
    }
    const run = this.backgroundRunCoordinator.getActiveRun();
    if (!run || run.status !== 'waiting_for_apply' || run.sessionId !== this.sessionStore.activeSessionId) {
      return;
    }
    const repairLoop = this.repairLoopsBySession.get(run.sessionId) ?? this.sessionStore.getActiveSession().repairLoop;
    if (repairLoop?.status !== 'ready_for_validation') {
      vscode.window.showInformationMessage(this.language === 'en'
        ? 'Apply the complete pending repair ChangeSet before resuming the background task.'
        : '请先完整应用待确认修复 ChangeSet，再继续后台任务。');
      return;
    }
    await this.executeBackgroundRound(true);
  }

  private async executeBackgroundRound(resume: boolean): Promise<void> {
    const started = this.backgroundRunCoordinator.beginRound();
    if (started.status === 'failed') {
      await this.appendBackgroundOutcomeMessage(started.stopReason ?? 'Background task limit reached.');
      return;
    }
    const activeSession = this.sessionStore.getActiveSession();
    if (started.sessionId !== activeSession.id) {
      const failed = this.backgroundRunCoordinator.fail('The active chat session changed.');
      await this.appendBackgroundOutcomeMessage(failed.stopReason ?? 'The active chat session changed.');
      return;
    }
    const currentRepair = this.repairLoopsBySession.get(started.sessionId) ?? activeSession.repairLoop;
    const repairLoop = resume && currentRepair
      ? { ...currentRepair, status: 'running_validation' as const, pendingDraftEditIds: [], stopReason: undefined }
      : undefined;
    if (repairLoop) {
      this.repairLoopsBySession.set(started.sessionId, repairLoop);
      activeSession.repairLoop = repairLoop;
    }
    const script = started.goal.script;
    const prompt = resume
      ? this.language === 'en'
        ? `Continue the visible background repair task after the user applied the previous ChangeSet. Run keepseek_run_validation with script "${script}". If it fails, read Problems and prepare one reviewed repair ChangeSet. Do not bypass authorization or apply edits automatically.`
        : `用户已应用上一轮 ChangeSet，继续当前可见后台修复任务。运行 keepseek_run_validation，script 为“${script}”。若失败，读取 Problems 并准备一个需审核的修复 ChangeSet。不得绕过授权或自动应用修改。`
      : this.language === 'en'
        ? `Start a controlled background repair task. Run keepseek_run_validation with script "${script}". If it fails, read Problems and prepare one reviewed repair ChangeSet. Stop when validation passes or user review is required. Never bypass authorization or apply edits automatically.`
        : `启动受控后台修复任务。运行 keepseek_run_validation，script 为“${script}”。若失败，读取 Problems 并准备一个需审核的修复 ChangeSet。验证通过或需要用户审核时停止。不得绕过授权或自动应用修改。`;
    const response = await this.sendPrompt(prompt, this.selectedSourceId, this.selectedModelId, this.agentSettings, {
      repairLoop,
      executionLimits: this.backgroundRunCoordinator.getRemainingExecutionLimits(),
      backgroundRunId: started.id
    });
    const current = this.backgroundRunCoordinator.getActiveRun();
    if (!current || current.status === 'stopped') {
      return;
    }
    if (!response) {
      const failed = this.backgroundRunCoordinator.fail('The background Agent run ended without a result.');
      await this.appendBackgroundOutcomeMessage(failed.stopReason ?? 'Background Agent run failed.');
      return;
    }
    this.backgroundRunCoordinator.recordRun(response.runDetails);
    if (response.repairLoop.status === 'waiting_for_apply' || response.changeSet?.status === 'pending') {
      this.backgroundRunCoordinator.waitForApply(this.language === 'en'
        ? 'Review and apply the pending ChangeSet, then choose Resume.'
        : '请审核并应用待确认 ChangeSet，然后点击继续。');
      return;
    }
    if (response.repairLoop.stopReason === 'validation_passed' || response.repairLoop.status === 'completed') {
      const completed = this.backgroundRunCoordinator.complete(this.language === 'en'
        ? `${script} passed.`
        : `${script} 已通过。`);
      await this.appendBackgroundOutcomeMessage(completed.stopReason ?? `${script} passed.`);
      return;
    }
    if (response.repairLoop.stopReason === 'authorization_denied') {
      const failed = this.backgroundRunCoordinator.fail(this.language === 'en'
        ? 'The required validation authorization was denied.'
        : '所需验证授权已被拒绝。');
      await this.appendBackgroundOutcomeMessage(failed.stopReason ?? 'Authorization denied.');
      return;
    }
    const stopReason = response.runDetails.budgetStopReason
      ?? response.runDetails.failureReason
      ?? response.taskPlan.blockers[0]
      ?? (this.language === 'en' ? 'The task stopped before validation passed.' : '任务在验证通过前停止。');
    const failed = this.backgroundRunCoordinator.fail(stopReason);
    await this.appendBackgroundOutcomeMessage(failed.stopReason ?? stopReason);
  }

  private async stopBackgroundRun(): Promise<void> {
    const run = this.backgroundRunCoordinator.getActiveRun();
    if (!run || run.status === 'completed' || run.status === 'failed' || run.status === 'stopped') {
      return;
    }
    if (this.isBusy) {
      this.abortPrompt();
    }
    const stopped = this.backgroundRunCoordinator.stop(this.language === 'en'
      ? 'Stopped by the user.'
      : '已由用户停止。');
    if (!this.isBusy) {
      await this.appendBackgroundOutcomeMessage(stopped.stopReason ?? 'Stopped by the user.');
    }
  }

  private async appendBackgroundOutcomeMessage(reason: string): Promise<void> {
    const session = this.sessionStore.getActiveSession();
    session.messages.push({
      id: randomUUID(),
      role: 'assistant',
      content: this.language === 'en'
        ? `Background task update: ${reason}`
        : `后台任务状态：${reason}`,
      createdAt: new Date().toISOString(),
      contextMeta: createProtectedContextMeta('background_run_result')
    });
    session.updatedAt = new Date().toISOString();
    await this.sessionStore.persist();
    this.postState();
  }

  private updateRunDetailsForChangeSet(
    messageId: string,
    event: Record<string, unknown>,
    changeSet: ChangeSet
  ): void {
    const message = this.messages.find((item) => item.id === messageId);
    if (!message?.runDetails) {
      return;
    }
    message.runDetails = applyChangeSetEventToRunDetails(message.runDetails, event, changeSet);
    void this.sessionStore.persist();
  }

  private getLegacyMemoryMigrationStateView(): LegacyProjectMemoryMigrationStateView {
    const state = this.legacyMemoryMigration.getStateView();
    if (!state.lastDraftChangeSetId) {
      return state;
    }
    const changeSetStatus = this.changeSets.getChangeSetStatus(state.lastDraftChangeSetId);
    if (state.status === 'completed') {
      const canRollback = changeSetStatus === 'reverted';
      return {
        ...state,
        canRollback,
        rollbackDisabledReason: canRollback ? undefined : this.t('legacyMemoryRevertBeforeRollback')
      };
    }
    if (state.status !== 'draft-created') {
      return state;
    }
    const canComplete = this.changeSets.isChangeSetFullyApplied(state.lastDraftChangeSetId);
    return {
      ...state,
      canComplete,
      canRollback: state.canRollback || changeSetStatus === 'discarded' || changeSetStatus === 'reverted',
      completeDisabledReason: canComplete ? undefined : this.t('legacyMemoryApplyBeforeComplete')
    };
  }

  private async sendPrompt(
    prompt: string,
    sourceId: string,
    modelId: string,
    settings?: Partial<AgentSettings>,
    options?: {
      replaceMessageId?: string;
      references?: PromptReferenceInput[];
      skillIds?: string[];
      repairLoop?: RepairLoopState;
      executionLimits?: AgentExecutionLimits;
      backgroundRunId?: string;
    }
  ): Promise<AgentResponse | undefined> {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || this.isBusy) {
      return;
    }
    const backgroundRun = this.backgroundRunCoordinator.getActiveRun();
    if (!options?.backgroundRunId && backgroundRun
      && (backgroundRun.status === 'running'
        || backgroundRun.status === 'waiting_for_apply'
        || backgroundRun.status === 'waiting_for_authorization')) {
      vscode.window.showInformationMessage(this.language === 'en'
        ? 'Stop or finish the current background task before starting another Agent run.'
        : '请先停止或完成当前后台任务，再启动新的 Agent 运行。');
      return;
    }

    const replaceMessageId = options?.replaceMessageId;
    if (replaceMessageId) {
      const targetIndex = this.sessionStore.getActiveSession().messages.findIndex((message) => message.id === replaceMessageId && message.role === 'user');
      if (targetIndex < 0) {
        return;
      }
    }

    // Re-resolve immediately before model validation so a configuration change
    // can never pair the previous source's model view with different credentials.
    await this.refreshModelSourceState();
    this.agentSettings = normalizeAgentSettings(settings, this.agentSettings);
    const models = this.availableModels;
    const model = findModelBySelection(models, { sourceId, modelId })
      ?? findModelBySelection(models, {
        sourceId: this.selectedSourceId,
        modelId: this.selectedModelId
      })
      ?? models[0];
    if (!model?.sourceId) {
      vscode.window.showWarningMessage(this.t('modelRequired'));
      return;
    }
    this.selectedSourceId = model.sourceId;
    this.selectedModelId = model.id;
    const resolvedSource = await resolveModelSourceConfig(model.sourceId, this.globalStorageUri, {
      sourceStore: this.sourceStore,
      language: this.language,
      requireApiKey: false
    });
    const sourceConfig: ModelSourceConfigSnapshot = Object.freeze({
      sourceId: resolvedSource.sourceId,
      provider: resolvedSource.provider,
      apiKey: resolvedSource.apiKey,
      baseUrl: resolvedSource.baseUrl,
      supportsBilling: resolvedSource.supportsBilling
    });

    const abortController = new AbortController();
    this.currentRunAbortController = abortController;
    this.isBusy = true;
    this.liveContextUsage = undefined;
    this.liveTurnUsage = undefined;
    this.setAgentActivity({
      base: 'thinking',
      phase: 'preparing'
    });

    let assistantMessage: ChatMessage | undefined;
    let currentTurnUsage: TurnUsageStats | undefined;
    let previousTurnUsage: TurnUsageStats | undefined;
    let previousPromptCacheDiagnostics: PromptCacheDiagnostics | undefined;
    let completedResponse: AgentResponse | undefined;
    let liveStateTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleLiveState = () => {
      if (liveStateTimer) {
        return;
      }
      liveStateTimer = setTimeout(() => {
        liveStateTimer = undefined;
        this.postState();
      }, 80);
    };
    const flushLiveState = () => {
      if (liveStateTimer) {
        clearTimeout(liveStateTimer);
        liveStateTimer = undefined;
      }
      this.postState();
    };

    try {
      const authorizedExternalReferenceUris = this.collectAuthorizedExternalReferenceUris(options?.references);
      this.setAgentActivity({
        base: 'thinking',
        phase: 'expanding_references'
      });
      const expandedPrompt = await expandPromptReferencesInPrompt(trimmedPrompt, {
        authorizedExternalReferenceUris,
        skillManifests: this.skillStore.getManifests(),
        expandSkillContents: false,
        language: this.language
      });
      if (abortController.signal.aborted) {
        this.setAgentActivity({
          base: 'stopped',
          phase: 'finalizing'
        }, { post: false });
        return;
      }
      const activeSession = this.sessionStore.getActiveSession();
      if (!options?.repairLoop) {
        this.repairLoopsBySession.delete(activeSession.id);
        activeSession.repairLoop = undefined;
      }
      previousTurnUsage = activeSession.lastTurnUsage;
      previousPromptCacheDiagnostics = activeSession.promptCacheDiagnostics;
      activeSession.lastTurnUsage = undefined;
      if (replaceMessageId) {
        // 编辑重发：历史将被 splice（前缀本来就从该点失效），按新 prompt 重新确定
        // implicit skill 集合与 slim 工具集，避免沿用旧请求的冻结状态。
        this.skillStore.invalidateImplicitSkillSnapshot(activeSession);
        this.slimToolNamesBySession.delete(activeSession.id);
        if (activeSession.requestProtocol) {
          activeSession.requestProtocol.toolNames = [];
        }
      }
      const runContextResult = await this.refreshCurrentRunContext(
        activeSession,
        expandedPrompt,
        normalizeSkillIds(options?.skillIds)
      );
      if (runContextResult.failures.length) {
        vscode.window.showWarningMessage(this.t('skillLoadFailed', {
          skill: runContextResult.failures.map((failure) => failure.name).join(', ')
        }));
      }
      const currentRunContext = runContextResult.context;
      const activeSkills = currentRunContext.skills;
      // 会话冻结的 slim 工具集：首轮请求确定后跨轮复用，保证 tools schema 前缀稳定
      const slimToolNames = this.resolveSessionToolNames(
        activeSession,
        expandedPrompt,
        model,
        sourceConfig
      );
      this.slimToolNamesBySession.set(activeSession.id, slimToolNames);
      const now = new Date().toISOString();
      const replacementIndex = replaceMessageId
        ? activeSession.messages.findIndex((message) => message.id === replaceMessageId && message.role === 'user')
        : -1;

      // 稳定上下文块：字节不变时跨轮复用（system 段前缀稳定），只有
      // AGENTS.md/Skills/Legacy Memory/Context Files 真正变化才整体重写。
      const contextFiles = this.fileContext.getAll();
      const totalContextBudgetCharacters = getConfiguredTotalContextBudgetTokens() * 4;
      archiveContextSourcesBeyondBudget(activeSession, [
        ...currentRunContext.projectInstructions.map((instruction) => ({
          id: instruction.id,
          kind: 'project-instructions',
          content: instruction.content
        })),
        ...contextFiles.map((file) => ({ id: file.id, kind: 'context-file', content: file.content })),
        ...currentRunContext.skills.map((skill) => ({ id: skill.id, kind: 'skill', content: skill.content })),
        ...(currentRunContext.legacyMemory ? [{
          id: 'legacy-project-memory',
          kind: 'legacy-memory',
          content: currentRunContext.legacyMemory.content
        }] : [])
      ], totalContextBudgetCharacters);
      const computedContextInstructions = formatCurrentRunContextForAgent({
        contextFiles,
        currentRunContext,
        language: this.language,
        totalBudgetCharacters: totalContextBudgetCharacters
      });
      let dynamicContextTail = '';
      if (activeSession.contextInstructions === undefined) {
        activeSession.contextInstructions = computedContextInstructions;
        if (activeSession.requestProtocol) {
          activeSession.requestProtocol.lastDynamicContextHash = hashContextInstructions(computedContextInstructions);
        }
      } else {
        const computedHash = hashContextInstructions(computedContextInstructions);
        const appliedHash = activeSession.requestProtocol?.lastDynamicContextHash
          ?? hashContextInstructions(activeSession.contextInstructions);
        if (computedHash !== appliedHash) {
          dynamicContextTail = formatDynamicContextTail(computedContextInstructions, this.language);
          if (activeSession.requestProtocol) {
            activeSession.requestProtocol.lastDynamicContextHash = computedHash;
          }
        }
      }
      const contextInstructions = activeSession.contextInstructions;

      if (replaceMessageId) {
        if (replacementIndex < 0) {
          return;
        }
        activeSession.messages.splice(replacementIndex);
        activeSession.contextUsage = undefined;
        activeSession.contextCompression = undefined;
        this.changeSets.discardPendingForSession(activeSession.id);
        this.taskPlansBySession.delete(activeSession.id);
        if (replacementIndex === 0 && !activeSession.customTitle) {
          activeSession.title = createSessionTitle(trimmedPrompt, this.language);
        }
      } else if (!activeSession.messages.length) {
        if (!activeSession.customTitle) {
          activeSession.title = createSessionTitle(trimmedPrompt, this.language);
        }
        activeSession.createdAt = now;
      }

      const userMessage: ChatMessage = {
        id: randomUUID(),
        role: 'user',
        content: trimmedPrompt,
        createdAt: now,
        modelId: model.id,
        usedSkills: toChatMessageSkills(activeSkills),
        contextMeta: activeSession.messages.some((message) => message.role === 'user')
          ? undefined
          : createProtectedContextMeta('first_user_request')
      };
      if (expandedPrompt !== trimmedPrompt) {
        userMessage.expandedContent = expandedPrompt;
      }
      if (dynamicContextTail) {
        userMessage.providerContent = `${expandedPrompt.trim()}\n\n${dynamicContextTail}`;
      }
      activeSession.lastTraceLogUri = undefined;
      this.sessionTraceLogUris.delete(activeSession.id);
      this.messages.push(userMessage);
      if ((activeSession.requestProtocol?.version ?? 1) >= CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION) {
        capOversizedFirstUserProviderContent(activeSession);
      }
      activeSession.updatedAt = now;
      this.postState();
      await this.refreshContextCompressionBeforeRun(
        activeSession,
        expandedPrompt,
        model,
        sourceConfig,
        abortController.signal
      );
      await this.sessionStore.persist();
      if (abortController.signal.aborted) {
        this.setAgentActivity({
          base: 'stopped',
          phase: 'finalizing'
        }, { post: false });
        return;
      }
      this.postState();

      const agentHistory = [...this.messages];
      assistantMessage = {
        id: randomUUID(),
        role: 'assistant',
        content: '',
        reasoningContent: '',
        createdAt: new Date().toISOString(),
        modelId: model.id,
        usedSkills: toChatMessageSkills(activeSkills),
        isStreaming: true
      };
      this.messages.push(assistantMessage);
      this.setAgentActivity({
        base: 'thinking',
        phase: 'requesting_model'
      }, { post: false });
      this.postState();

      const response = await this.agentRunner.run(this.agentRequestCoordinator.createAgentRequest({
        prompt: expandedPrompt,
        model,
        settings: this.agentSettings,
        contextFiles: this.fileContext.getAll(),
        currentRunContext,
        contextInstructions,
        slimToolNames,
        requestProtocolVersion: activeSession.requestProtocol?.version,
        historyArchive: activeSession.historyArchive,
        history: agentHistory,
        authorizedExternalReferenceUris: [...authorizedExternalReferenceUris],
        contextCompression: activeSession.contextCompression,
        historyRewriteReason: replaceMessageId ? 'edit_user_prompt' : undefined,
        language: this.language,
        sessionId: activeSession.id,
        assistantMessageId: assistantMessage.id,
        repairLoop: options?.repairLoop,
        executionLimits: options?.executionLimits,
        backgroundRunId: options?.backgroundRunId,
        sourceConfig,
        signal: abortController.signal
      }), {
        onStatus: (activity) => {
          if (options?.backgroundRunId) {
            if (activity.phase === 'awaiting_authorization') {
              this.backgroundRunCoordinator.waitForAuthorization(activity.detail ?? activity.toolName ?? 'Waiting for authorization.');
            } else if (this.backgroundRunCoordinator.getActiveRun()?.status === 'waiting_for_authorization') {
              this.backgroundRunCoordinator.markRunning();
            }
          }
          this.setAgentActivity(activity);
        },
        onDelta: (event) => {
          if (!assistantMessage) {
            return;
          }
          if (event.type === 'reasoning') {
            this.setAgentActivity({
              base: 'thinking',
              phase: 'reasoning'
            }, { schedulePost: scheduleLiveState });
            assistantMessage.reasoningContent = `${assistantMessage.reasoningContent ?? ''}${event.delta}`;
          } else {
            this.setAgentActivity({
              base: 'thinking',
              phase: 'generating'
            }, { schedulePost: scheduleLiveState });
            assistantMessage.content = `${assistantMessage.content}${event.delta}`;
          }
          activeSession.updatedAt = new Date().toISOString();
          scheduleLiveState();
        },
        onUsageEstimate: (usage) => {
          this.liveContextUsage = toSessionContextUsageEstimate(usage);
          this.updateActiveSessionContextUsage(this.liveContextUsage);
          scheduleLiveState();
        },
        onUsage: (event) => {
          currentTurnUsage = this.applyUsageEvent(activeSession, currentTurnUsage, event);
          this.liveTurnUsage = currentTurnUsage;
          scheduleLiveState();
        },
        onTraceLog: (traceLog) => {
          activeSession.lastTraceLogUri = traceLog.uri;
          this.sessionTraceLogUris.set(activeSession.id, traceLog.uri);
          activeSession.updatedAt = new Date().toISOString();
          scheduleLiveState();
        },
        onTaskPlan: (taskPlan) => {
          this.taskPlansBySession.set(activeSession.id, taskPlan);
          scheduleLiveState();
        },
        onRunDetails: (runDetails) => {
          if (assistantMessage) {
            assistantMessage.runDetails = runDetails;
          }
          scheduleLiveState();
        }
      });
      completedResponse = response;
      if (activeSession.requestProtocol) {
        activeSession.requestProtocol.lastProviderRequestAt = new Date().toISOString();
      }

      this.setAgentActivity({
        base: 'thinking',
        phase: 'finalizing'
      }, { post: false });
      const traceLogUri = response.traceLog?.uri ?? this.traceLogService.getLastRunTraceLogUri();
      if (traceLogUri) {
        activeSession.lastTraceLogUri = traceLogUri;
        this.sessionTraceLogUris.set(activeSession.id, traceLogUri);
      }
      this.taskPlansBySession.set(activeSession.id, response.taskPlan);
      this.repairLoopsBySession.set(activeSession.id, response.repairLoop);
      activeSession.repairLoop = response.repairLoop;
      if (response.changeSet) {
        this.changeSets.add(response.changeSet);
      } else if (response.draftEdits.length) {
        this.changeSets.addDraftEdits({
          edits: response.draftEdits,
          runId: response.runId,
          sessionId: activeSession.id,
          messageId: assistantMessage?.id,
          traceLogUri
        });
      }
      if (!currentTurnUsage && response.usage) {
        currentTurnUsage = this.applyTurnUsage(activeSession, response.usage);
        this.liveTurnUsage = currentTurnUsage;
      }
      this.applyPromptCacheDiagnostics(
        activeSession,
        response.promptCacheDiagnostics,
        previousPromptCacheDiagnostics,
        previousTurnUsage,
        currentTurnUsage
      );

      if (assistantMessage) {
        assistantMessage.content = response.message;
        assistantMessage.reasoningContent = response.reasoningContent;
        if (response.draftEdits.length) {
          assistantMessage.contextMeta = createProtectedContextMeta('draft_edit_result');
        }
        // 持久化工具轮原样字节，跨轮重建时逐字节还原（缓存前缀稳定）。
        if (response.toolRounds?.length) {
          assistantMessage.toolRounds = response.toolRounds;
        }
        const providerReplay = normalizeProviderReplay(response.providerReplay);
        if (providerReplay) {
          assistantMessage.providerReplay = providerReplay;
        }
        delete assistantMessage.isStreaming;
        assistantMessage.runDetails = response.runDetails;
      }
      this.updateActiveSessionContextUsage(this.createCurrentSessionContextUsage(model));
      this.scheduleContextCompressionRefresh(activeSession, expandedPrompt, model, sourceConfig);
      this.setAgentActivity({
        base: 'complete',
        phase: 'finalizing'
      }, { post: false });
    } catch (error) {
      if (error instanceof AgentRunAbortedError || abortController.signal.aborted) {
        if (assistantMessage) {
          const hasPartialOutput = Boolean(assistantMessage.content.trim() || assistantMessage.reasoningContent?.trim());
          const assistantMessageId = assistantMessage.id;
          delete assistantMessage.isStreaming;
          if (!hasPartialOutput && assistantMessage.runDetails) {
            assistantMessage.content = this.language === 'en'
              ? 'Agent run stopped by the user.'
              : 'Agent 运行已由用户停止。';
          } else if (!hasPartialOutput) {
            const assistantIndex = this.messages.findIndex((message) => message.id === assistantMessageId);
            if (assistantIndex >= 0) {
              this.messages.splice(assistantIndex, 1);
            }
            assistantMessage = undefined;
          }
        }
        this.setAgentActivity({
          base: 'stopped',
          phase: 'finalizing'
        }, { post: false });
        return;
      }

      const activeSession = this.sessionStore.getActiveSession();
      if (!activeSession.messages.length) {
        const now = new Date().toISOString();
        if (!activeSession.customTitle) {
          activeSession.title = createSessionTitle(trimmedPrompt, this.language);
        }
        activeSession.createdAt = now;
      }
      if (assistantMessage) {
        const errorText = `${this.t('errorPrefix')}: ${getErrorMessage(error)}`;
        const hasPartialOutput = Boolean(assistantMessage.content.trim() || assistantMessage.reasoningContent?.trim());
        assistantMessage.content = hasPartialOutput
          ? [assistantMessage.content.trimEnd(), errorText].filter(Boolean).join('\n\n')
          : errorText;
        delete assistantMessage.isStreaming;
      } else {
        this.messages.push({
          id: randomUUID(),
          role: 'assistant',
          content: `${this.t('errorPrefix')}: ${getErrorMessage(error)}`,
          createdAt: new Date().toISOString(),
          modelId: model.id
        });
      }
      this.updateActiveSessionContextUsage(this.createCurrentSessionContextUsage(model));
      this.setAgentActivity({
        base: 'error',
        phase: 'failed'
      }, { post: false });
    } finally {
      if (this.currentRunAbortController === abortController) {
        this.currentRunAbortController = undefined;
      }
      this.updateActiveSessionContextUsage(this.liveContextUsage);
      this.liveContextUsage = undefined;
      this.liveTurnUsage = undefined;
      this.sessionStore.getActiveSession().updatedAt = new Date().toISOString();
      this.isBusy = false;
      // Push UI state (changeSets, idle status) before session persistence so a
      // slow or failing persist() can never leave the webview stuck on
      // "finalizing" without showing the pending changes.
      flushLiveState();
      this.setAgentActivity({
        base: 'idle',
        phase: 'idle'
      }, { post: false });
      this.postState();
      try {
        await this.sessionStore.persist();
      } catch (error) {
        // Persistence is best-effort here; it must never block or break the UI flow.
        console.warn('[KeepSeek] Failed to persist session after Agent run:', getErrorMessage(error));
      }
      void this.refreshBalance();
    }
    return completedResponse;
  }

  private async refreshContextCompressionBeforeRun(
    activeSession: ChatSession,
    prompt: string,
    model: KeepseekModel,
    sourceConfig: ModelSourceConfigSnapshot,
    signal: AbortSignal
  ): Promise<void> {
    try {
      const result = await this.agentRequestCoordinator.refreshContextCompressionBeforeRun({
        session: activeSession,
        prompt,
        model,
        agentSettings: this.agentSettings,
        contextFiles: this.fileContext.getAll(),
        currentRunContext: this.currentRunContextsBySession.get(activeSession.id),
        contextInstructions: activeSession.contextInstructions,
        slimToolNames: activeSession.requestProtocol?.toolNames,
        requestProtocolVersion: activeSession.requestProtocol?.version,
        language: this.language,
        sourceConfig,
        signal
      });
      this.applyContextCompressionRefreshResult(activeSession, result);
    } catch {
      // Context compression is best-effort and must never block the normal request path.
    }
  }

  private scheduleContextCompressionRefresh(
    activeSession: ChatSession,
    prompt: string,
    model: KeepseekModel,
    sourceConfig: ModelSourceConfigSnapshot
  ): void {
    this.agentRequestCoordinator.scheduleBackgroundContextCompressionRefresh({
      session: activeSession,
      prompt,
      model,
      agentSettings: this.agentSettings,
      contextFiles: this.fileContext.getAll(),
      currentRunContext: this.currentRunContextsBySession.get(activeSession.id),
      contextInstructions: activeSession.contextInstructions,
      slimToolNames: activeSession.requestProtocol?.toolNames,
      requestProtocolVersion: activeSession.requestProtocol?.version,
      language: this.language,
      sourceConfig
    }, (update) => this.applyBackgroundContextCompressionRefresh(activeSession, update));
  }

  private async applyBackgroundContextCompressionRefresh(
    session: ChatSession,
    update: BackgroundContextCompressionRefreshUpdate
  ): Promise<void> {
    if (session.id !== update.sessionId || !this.canApplyBackgroundContextCompressionRefresh(session, update)) {
      return;
    }
    if (!this.applyContextCompressionRefreshResult(session, update.result)) {
      return;
    }

    await this.sessionStore.persist();
    if (session.id === this.sessionStore.activeSessionId) {
      this.postState();
    }
  }

  private canApplyBackgroundContextCompressionRefresh(
    session: ChatSession,
    update: BackgroundContextCompressionRefreshUpdate
  ): boolean {
    if (session.messages.length < update.expectedMessageCount) {
      return false;
    }
    const expectedLastMessage = session.messages[update.expectedMessageCount - 1];
    return expectedLastMessage?.id === update.expectedLastMessageId;
  }

  private applyContextCompressionRefreshResult(
    session: ChatSession,
    result: HistoryCompressionRefreshResult | undefined
  ): boolean {
    if (!result?.changed) {
      return false;
    }

    session.contextCompression = result.state;
    if ((result.reason === 'created' || result.reason === 'updated') && session.requestProtocol) {
      session.requestProtocol.version = CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION;
      session.requestProtocol.serializationStrategy = 'provider-projection-v2';
      session.requestProtocol.toolSchemaVersion = CURRENT_PROVIDER_TOOL_SCHEMA_VERSION;
      session.requestProtocol.toolNames = [];
    }
    for (const usageEvent of result.usageEvents ?? []) {
      session.usageStats = addUsageEventToSessionStats(session.usageStats, usageEvent);
    }
    session.contextUsage = undefined;
    session.updatedAt = new Date().toISOString();
    return true;
  }

  private async cleanupExpiredSessions(options: { post?: boolean } = {}): Promise<void> {
    const changed = await this.sessionStore.cleanupExpiredSessions();
    if (changed && options.post !== false) {
      this.postState();
    }
  }

  private postState(): void {
    const models = this.availableModels;
    const selectedCatalogModel = findModelBySelection(models, {
      sourceId: this.selectedSourceId,
      modelId: this.selectedModelId
    }) ?? models[0];
    this.selectedSourceId = selectedCatalogModel?.sourceId ?? '';
    this.selectedModelId = selectedCatalogModel?.id ?? '';
    const selectedModel = selectedCatalogModel ?? getConfiguredModels()[0];
    const contextFiles = this.fileContext.getAll();
    const activeSession = this.sessionStore.getActiveSession();
    const currentRunContext = this.currentRunContextsBySession.get(activeSession.id);
    const computedContextUsage = createDisplayedSessionContextUsageEstimate({
      model: selectedModel,
      agentSettings: this.agentSettings,
      contextFiles,
      currentRunContext,
      contextInstructions: activeSession.contextInstructions,
      messages: this.messages,
      contextCompression: activeSession.contextCompression,
      language: this.language,
      slimToolNames: activeSession.requestProtocol?.toolNames,
      requestProtocolVersion: activeSession.requestProtocol?.version,
      provider: selectedModel.provider === 'openai-responses' || selectedModel.provider === 'anthropic-compatible'
        ? selectedModel.provider
        : undefined,
      sourceId: activeSession.requestProtocol?.sourceId ?? selectedModel.sourceId,
      baseUrl: activeSession.requestProtocol?.baseUrl
    });
    const contextUsage = pickLargerContextUsageEstimate(
      pickLargerContextUsageEstimate(activeSession.contextUsage, computedContextUsage),
      this.isBusy ? this.liveContextUsage : undefined
    ) ?? computedContextUsage;
    const contextCompression = getAgentRuntimeProfile(selectedModel, this.agentSettings).contextCompression;
    const lastTurnUsage = this.isBusy ? this.liveTurnUsage ?? activeSession.lastTurnUsage : activeSession.lastTurnUsage;
    const contextPercent = contextUsage.usedPercent;

    const webviewChangeSets = this.changeSets.toWebviewState(activeSession.id);
    this.postToWebview({
      type: 'state',
      state: {
        models,
        selectedSourceId: this.selectedSourceId,
        selectedModelId: this.selectedModelId,
        agentSettings: this.agentSettings,
        messages: getVisibleMessages(this.messages),
        activeSessionId: this.sessionStore.activeSessionId,
        workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath || folder.uri.toString()),
        sessionSummaries: this.sessionStore.getSessionSummaries(),
        contextFiles: contextFiles.map(({ content: _content, ...file }) => file),
        skills: this.skillStore.getStateView(activeSession),
        legacyMemoryMigration: this.getLegacyMemoryMigrationStateView(),
        backgroundRun: this.backgroundRunCoordinator.getActiveRun(),
        backgroundAvailableScripts: this.backgroundAvailableScripts,
        backgroundDefaults: {
          maxRounds: getConfiguredBackgroundMaxRounds(),
          maxDurationMs: getConfiguredBackgroundMaxDurationMs(),
          maxToolCalls: getConfiguredBackgroundMaxToolCalls()
        },
        contextUsage,
        contextUsageSessionId: this.sessionStore.activeSessionId,
        usageMetrics: {
          sessionUsageStats: activeSession.usageStats,
          lastTurnUsage,
          supportsBilling: selectedCatalogModel?.supportsBilling === true,
          balance: selectedCatalogModel?.supportsBilling && selectedCatalogModel.sourceId
            ? this.balanceStore.getBalance(this.getBalanceSourceScope(selectedCatalogModel.sourceId))
            : undefined,
          promptCacheDiagnostics: activeSession.promptCacheDiagnostics,
          turnCount: activeSession.messages.filter((message) => message.role === 'user').length,
          contextPercent,
          contextCompressionTriggerRatio: contextCompression.triggerRatio,
          contextSoftCompactRatio: contextCompression.softCompactRatio,
          toolResultSnipRatio: contextCompression.toolResultSnipRatio,
          contextCompactForceRatio: contextCompression.forceRatio,
          slimToolModeEnabled: getConfiguredSlimToolModeEnabled()
        },
        taskPlan: this.taskPlansBySession.get(activeSession.id),
        repairLoop: this.repairLoopsBySession.get(activeSession.id) ?? activeSession.repairLoop,
        changeSets: webviewChangeSets,
        isBusy: this.isBusy,
        agentActivity: this.agentActivity,
        maxFileBytes: getConfiguredMaxFileBytes(),
        historyRetentionDays: getConfiguredHistoryRetentionDays(),
        debugMode: getConfiguredDebugMode(),
        hasCurrentSessionLog: Boolean(
          activeSession.lastTraceLogUri?.trim()
          || this.sessionTraceLogUris.get(activeSession.id)?.trim()
        ),
        extensionInfo: this.extensionInfo,
        language: this.language,
        isMac: process.platform === 'darwin'
      }
    });
  }

  private t(key: string, values?: Record<string, string | number>): string {
    return localize(this.language, key, values);
  }

  private postToWebview(message: unknown): void {
    for (const view of this.views) {
      void view.webview.postMessage(message);
    }
  }

  private getHtmlForWebview(webview: vscode.Webview): string {
    return getHtmlForWebview({
      webview,
      extensionUri: this.extensionUri,
      language: this.language,
      extensionInfo: this.extensionInfo
    });
  }
}

function getWorkspaceSummaryTimestamp(workspace: WorkspaceSummary): number {
  const timestamp = Date.parse(workspace.updatedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function hashContextInstructions(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function formatDynamicContextTail(value: string, language: 'en' | 'zh-CN'): string {
  const content = value.trim();
  const header = language === 'en'
    ? 'Session context update for this turn and later turns (appended here to preserve the cached stable prefix):'
    : '本轮及后续轮次的会话上下文更新（追加在此处以保护已缓存的稳定前缀）：';
  const empty = language === 'en'
    ? 'The previously appended dynamic context is no longer active; use only the stable session context above.'
    : '先前追加的动态上下文已不再生效；仅使用上方稳定会话上下文。';
  return `<keepseek-dynamic-context>\n${header}\n\n${content || empty}\n</keepseek-dynamic-context>`;
}

function normalizeSkillIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') {
      continue;
    }
    const id = item.trim();
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function toChatMessageSkills(skills: ActivatedSkill[]): ChatMessageSkill[] | undefined {
  if (!skills.length) {
    return undefined;
  }
  return skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    source: skill.source
  }));
}
