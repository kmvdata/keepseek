import { getInputScript } from './input/script';
import { getRichTextShortcutsScript } from './richTextShortcuts';
import { WEBVIEW_TRANSLATIONS } from '../shared/i18n';

export function getScript(): string {
  return `
    const vscode = acquireVsCodeApi();
    const keepseekLogoUri = window.keepseekLogoUri || '';
    const translations = ${JSON.stringify(WEBVIEW_TRANSLATIONS)};
    const state = {
      models: [],
      selectedModelId: '',
      agentSettings: {
        thinkingEnabled: true,
        reasoningEffort: 'high'
      },
      messages: [],
      activeSessionId: '',
      workspaceFolders: [],
      sessionSummaries: [],
      contextFiles: [],
      skills: {
        workspaceTrusted: true,
        items: [],
        activeSkillIds: [],
        workspaceDefaultSkillIds: []
      },
      legacyMemoryMigration: {
        detected: false,
        status: 'pending',
        sourceUris: [],
        entryCount: 0
      },
      backgroundRun: null,
      backgroundAvailableScripts: [],
      backgroundDefaults: {
        maxRounds: 5,
        maxDurationMs: 1800000,
        maxToolCalls: 60
      },
      contextUsageSessionId: '',
      contextUsage: {
        usedTokensEstimate: 0,
        maxTokensEstimate: 1000000,
        remainingTokensEstimate: 1000000,
        usedPercent: 0,
        remainingPercent: 100,
        breakdown: {
          systemTokensEstimate: 0,
          contextFileTokensEstimate: 0,
          historyTokensEstimate: 0,
          inputTokensEstimate: 0,
          toolSchemaTokensEstimate: 0,
          toolCallTokensEstimate: 0,
          toolResultTokensEstimate: 0,
          reasoningTokensEstimate: 0,
          outputReserveTokensEstimate: 0,
          safetyReserveTokensEstimate: 0
        }
      },
      usageMetrics: {
        sessionUsageStats: null,
        lastTurnUsage: null,
        balance: null,
        promptCacheDiagnostics: null,
        turnCount: 0,
        contextPercent: 0,
        contextCompressionTriggerRatio: 0.8,
        contextSoftCompactRatio: 0.5,
        toolResultSnipRatio: 0.6,
        contextCompactForceRatio: 0.9,
        slimToolModeEnabled: true
      },
      taskPlan: null,
      repairLoop: null,
      changeSets: [],
      draftEdits: [],
      isBusy: false,
      agentActivity: {
        base: 'idle',
        phase: 'idle',
        updatedAt: '',
        sequence: 0
      },
      maxFileBytes: 200000,
      historyRetentionDays: 1,
      debugMode: false,
      hasCurrentSessionLog: false,
      extensionInfo: {
        displayName: 'KeepSeek',
        version: '',
        publisher: 'keepseek',
        author: 'kmvdata',
        repositoryUrl: 'https://github.com/kmvdata/keepseek',
        license: 'MIT'
      },
      language: 'zh-CN',
      isMac: false
    };

    function getLanguage() {
      return state.language === 'en' ? 'en' : 'zh-CN';
    }

    function t(key, values) {
      var language = getLanguage();
      var catalog = translations[language] || translations['zh-CN'];
      var fallback = translations['zh-CN'] || {};
      var template = catalog[key] || fallback[key] || key;
      var replacements = values || {};
      return String(template).replace(/\\{(\\w+)\\}/g, function(_match, name) {
        return replacements[name] === undefined ? '' : String(replacements[name]);
      });
    }

    function getActiveSkillIdsForRequest() {
      var skills = state.skills && typeof state.skills === 'object' ? state.skills : {};
      var ids = Array.isArray(skills.activeSkillIds) ? skills.activeSkillIds : [];
      var seen = new Set();
      var result = [];
      ids.forEach(function(id) {
        var normalized = String(id || '').trim();
        if (!normalized || seen.has(normalized)) { return; }
        seen.add(normalized);
        result.push(normalized);
      });
      return result;
    }

    function getSkillItemsForView() {
      var skills = state.skills && typeof state.skills === 'object' ? state.skills : {};
      return Array.isArray(skills.items) ? skills.items : [];
    }

    function getSkillByIdForView(skillId) {
      var items = getSkillItemsForView();
      for (var i = 0; i < items.length; i++) {
        if (items[i].id === skillId) {
          return items[i];
        }
      }
      return null;
    }

    function getSkillByMentionNameForView(name) {
      var normalized = String(name || '').trim().toLocaleLowerCase();
      if (!normalized) { return null; }
      var items = getSkillItemsForView();
      for (var i = 0; i < items.length; i++) {
        if (getSkillMentionNameForView(items[i]).toLocaleLowerCase() === normalized) {
          return items[i];
        }
      }
      return null;
    }

    function getSkillMentionNameForView(skill) {
      var name = String(skill && skill.name || '').trim();
      if (isSafeSkillMentionNameForView(name)) {
        return name;
      }
      var fallback = getSkillDirectoryNameForView(skill);
      if (isSafeSkillMentionNameForView(fallback)) {
        return fallback;
      }
      return 'skill';
    }

    function getSkillPromptTextForView(skill) {
      return '$' + getSkillMentionNameForView(skill);
    }

    function getSkillMarkdownTextForView(skill) {
      return '[' + getSkillPromptTextForView(skill) + '](' + getSkillPathForView(skill) + ')';
    }

    function getSkillPathForView(skill) {
      var skillPath = String(skill && skill.skillPath || '').trim();
      if (skillPath) {
        return skillPath;
      }
      var skillUri = String(skill && skill.skillUri || '').trim();
      if (!skillUri) {
        return '';
      }
      try {
        if (skillUri.indexOf('file:') === 0) {
          var url = new URL(skillUri);
          var pathname = decodeURIComponent(url.pathname || '');
          if (url.hostname) {
            return '//' + url.hostname + pathname;
          }
          if (/^\\/[A-Za-z]:\\//.test(pathname)) {
            return pathname.slice(1);
          }
          return pathname || skillUri;
        }
      } catch (error) {
        return skillUri;
      }
      return skillUri;
    }

    function getSkillByMarkdownReferenceForView(name, href) {
      var skill = getSkillByMentionNameForView(name);
      if (!skill) {
        return null;
      }
      return normalizeSkillPathForView(getSkillPathForView(skill)) === normalizeSkillPathForView(href) ? skill : null;
    }

    function normalizeSkillPathForView(value) {
      return String(value || '').trim();
    }

    function getSkillDirectoryNameForView(skill) {
      var rootUri = String(skill && skill.rootUri || '');
      var rootPath = rootUri;
      try {
        if (rootUri.indexOf('file:') === 0) {
          rootPath = decodeURIComponent(new URL(rootUri).pathname || rootUri);
        }
      } catch (error) {
        rootPath = rootUri;
      }
      var normalized = String(rootPath || '').split(String.fromCharCode(92)).join('/');
      while (normalized.charAt(normalized.length - 1) === '/') {
        normalized = normalized.slice(0, -1);
      }
      var parts = normalized.split('/');
      return parts[parts.length - 1] || normalized || 'skill';
    }

    function isSafeSkillMentionNameForView(value) {
      return /^[A-Za-z0-9_-]+$/u.test(String(value || ''));
    }

    function mergeSkillIdsForRequest() {
      var seen = new Set();
      var result = [];
      for (var listIndex = 0; listIndex < arguments.length; listIndex++) {
        var ids = arguments[listIndex] || [];
        for (var i = 0; i < ids.length; i++) {
          var normalized = String(ids[i] || '').trim();
          if (!normalized || seen.has(normalized)) { continue; }
          seen.add(normalized);
          result.push(normalized);
        }
      }
      return result;
    }

    function createEmptyContextUsage(maxTokensEstimate) {
      var maxTokens = Math.max(1, Math.floor(Number(maxTokensEstimate) || 1000000));
      return {
        usedTokensEstimate: 0,
        maxTokensEstimate: maxTokens,
        remainingTokensEstimate: maxTokens,
        usedPercent: 0,
        remainingPercent: 100,
        breakdown: {
          systemTokensEstimate: 0,
          contextFileTokensEstimate: 0,
          historyTokensEstimate: 0,
          inputTokensEstimate: 0,
          toolSchemaTokensEstimate: 0,
          toolCallTokensEstimate: 0,
          toolResultTokensEstimate: 0,
          reasoningTokensEstimate: 0,
          outputReserveTokensEstimate: 0,
          safetyReserveTokensEstimate: 0
        }
      };
    }

    function resetLocalContextUsageEstimate() {
      state.contextUsage = createEmptyContextUsage(state.contextUsage && state.contextUsage.maxTokensEstimate);
      state.contextUsageSessionId = '';
    }

    function getSendShortcutHint() {
      if (state.isBusy) {
        return t('busyTaskHint');
      }
      return t(state.isMac ? 'sendShortcutHintMac' : 'sendShortcutHint');
    }

    ${getRichTextShortcutsScript()}

    function getLanguageDisplayName(language) {
      return language === 'en'
        ? t('languageValueEn')
        : t('languageValueZh');
    }

    function readNonEmptyString(value, fallback) {
      return typeof value === 'string' && value.trim() ? value.trim() : fallback;
    }

    function getExtensionInfo() {
      var info = state.extensionInfo && typeof state.extensionInfo === 'object' ? state.extensionInfo : {};
      return {
        displayName: readNonEmptyString(info.displayName, 'KeepSeek'),
        version: readNonEmptyString(info.version, ''),
        publisher: readNonEmptyString(info.publisher, 'keepseek'),
        author: readNonEmptyString(info.author, 'kmvdata'),
        repositoryUrl: readNonEmptyString(info.repositoryUrl, 'https://github.com/kmvdata/keepseek'),
        license: readNonEmptyString(info.license, 'MIT')
      };
    }

    function formatExtensionVersion(version) {
      var value = readNonEmptyString(version, '');
      return value ? 'v' + value.replace(/^v/iu, '') : '';
    }

    function normalizeIntegerInRange(value, min, max, fallback) {
      var number = Number(value);
      if (!Number.isFinite(number)) {
        return fallback;
      }
      return Math.min(max, Math.max(min, Math.floor(number)));
    }

    const historyTab = document.getElementById('historyTab');
    const newChatTab = document.getElementById('newChatTab');
    const settingsTab = document.getElementById('settingsTab');
    const settingsMenu = document.getElementById('settingsMenu');
    const settingsApiKeyMenuItem = document.getElementById('settingsApiKeyMenuItem');
    const settingsHistoryMenuItem = document.getElementById('settingsHistoryMenuItem');
    const settingsAboutMenuItem = document.getElementById('settingsAboutMenuItem');
    const settingsAboutVersionValue = document.getElementById('settingsAboutVersionValue');
    const settingsDebugMenuItem = document.getElementById('settingsDebugMenuItem');
    const settingsDebugValue = document.getElementById('settingsDebugValue');
    const settingsDebugModeToggle = document.getElementById('settingsDebugModeToggle');
    const settingsOpenLogMenuItem = document.getElementById('settingsOpenLogMenuItem');
    const settingsLanguageMenuItem = document.getElementById('settingsLanguageMenuItem');
    const settingsLanguageValue = document.getElementById('settingsLanguageValue');
    const settingsLanguageSubmenu = document.getElementById('settingsLanguageSubmenu');
    const sessionMenu = document.getElementById('sessionMenu');
    const backgroundRegion = document.getElementById('backgroundRegion');
    const backgroundLabel = document.getElementById('backgroundLabel');
    const backgroundStatus = document.getElementById('backgroundStatus');
    const backgroundRunDialogOverlay = document.getElementById('backgroundRunDialogOverlay');
    const backgroundScript = document.getElementById('backgroundScript');
    const backgroundMaxRounds = document.getElementById('backgroundMaxRounds');
    const backgroundStart = document.getElementById('backgroundStart');
    const backgroundCancel = document.getElementById('backgroundCancel');
    const backgroundResume = document.getElementById('backgroundResume');
    const backgroundStop = document.getElementById('backgroundStop');
    const backgroundDismiss = document.getElementById('backgroundDismiss');
    const contextBarOuter = document.getElementById('contextBarOuter');
    const contextBar = document.getElementById('contextBar');
    const planRegion = document.getElementById('planRegion');
    const planToggle = document.getElementById('planToggle');
    const planSummary = document.getElementById('planSummary');
    const planCount = document.getElementById('planCount');
    const planBody = document.getElementById('planBody');
    const planGoal = document.getElementById('planGoal');
    const planSteps = document.getElementById('planSteps');
    const planBlockers = document.getElementById('planBlockers');
    const planCompletion = document.getElementById('planCompletion');
    const planContinueRepair = document.getElementById('planContinueRepair');
    const draftRegion = document.getElementById('draftRegion');
    const draftBulkActions = document.getElementById('draftBulkActions');
    const draftApplyAllBtn = document.getElementById('draftApplyAllBtn');
    const draftDiscardAllBtn = document.getElementById('draftDiscardAllBtn');
    const draftList = document.getElementById('draftList');
    const transcript = document.getElementById('transcript');
    const composer = document.getElementById('composer');
    const promptInput = document.getElementById('promptInput');
    const status = document.getElementById('status');
    const sendButton = document.getElementById('sendButton');
    const editReferenceMenu = document.createElement('div');
    let transientStatus = '';
    let transientStatusTimer = 0;
    let agentStatusRotationTimer = 0;
    let agentStatusRotationIndex = 0;
    let agentStatusRotationKey = '';
    let terminalAgentStatusKey = '';
    let planExpanded = false;
    const pendingChangeActions = new Set();
    let settingsMenuOpen = false;
    let backgroundRunDialogOpen = false;
    let dismissedBackgroundRunId = '';
    let sessionMenuOpen = false;
    let sessionMultiSelectMode = false;
    let sessionRangeDays = 1;
    let sessionFavoritesOnly = false;
    let selectedSessionIds = new Set();
    let editingSessionTitleId = '';
    let activeWorkspaceTab = 'current';
    let otherWorkspaces = [];
    let otherWorkspaceSessions = {};
    let otherWorkspaceSessionErrors = {};
    let otherWorkspacesError = '';
    let editingMessageId = '';
    let editingDraftText = '';
    let pendingEditFocusId = '';
    let savedEditRange = null;
    let editReferenceMenuOpen = false;
    let editReferenceEditor = null;
    let editMentionRange = null;
    let editMentionQuery = '';
    let editReferenceIndex = 0;
    let editReferenceResources = [];
    let editReferenceResourcesLoading = false;
    let editReferenceResourcesLoaded = false;
    let editReferenceResourcesError = '';
    let editReferenceResourceRequestSequence = 0;
    let editReferenceResourceRequestId = '';
    const inlineShortcutController = window.keepseekRichTextShortcuts.createController({
      getEditor: function() { return getActiveInlineEditor(); },
      isRangeInside: function(range, editor) { return isRangeInsideInlineEditor(range, editor); },
      isNodeInside: function(node, editor) { return isNodeInsideInlineEditor(node, editor); },
      setSelectionRange: function(editor, range) { setInlineEditorSelectionRange(editor, range); },
      saveSelection: function(editor) { saveEditSelection(editor); },
      restoreSelection: function(editor) { setInlineEditorSelectionRange(editor, getInlineEditorInsertionRange(editor)); },
      getInsertionRange: function(editor) { return getInlineEditorInsertionRange(editor); },
      insertText: function(editor, text) {
        insertInlinePlainText(editor, text);
        refreshInlineEditorAfterEdit(editor);
      },
      onSelectionChanged: function(editor) { syncEditReferenceMenuFromEditor(editor); },
      onEdited: function(editor) { refreshInlineEditorAfterEdit(editor); }
    });
    const AGENT_STATUS_ROTATION_MS = 2600;
    const agentStatusPools = {
      preparing: ['agentStatusPreparingContext', 'agentStatusPreparingRequest'],
      expanding_references: ['agentStatusExpandingReferences', 'agentStatusPreparingRequest'],
      requesting_model: ['agentStatusWaitingModel', 'agentStatusDeepSeekReasoning', 'agentStatusWaitingStream'],
      reasoning: ['agentStatusThinking', 'agentStatusReasoning', 'agentStatusPondering', 'agentStatusSynthesizingClues'],
      planning_tool: ['agentStatusChoosingTools', 'agentStatusPlanningNextStep'],
      executing_tool: ['agentStatusExecutingTool'],
      reading_file: ['agentStatusReadingFile'],
      reading_file_range: ['agentStatusReadingFileRange', 'agentStatusReadingFile'],
      searching_workspace: ['agentStatusSearchingWorkspace', 'agentStatusScanningWorkspace'],
      listing_files: ['agentStatusScanningWorkspace', 'agentStatusListingFiles'],
      listing_directory: ['agentStatusListingDirectory', 'agentStatusScanningWorkspace'],
      creating_draft_edit: ['agentStatusPreparingDraftEdit'],
      reading_diagnostics: ['agentStatusReadingDiagnostics'],
      reading_semantic_context: ['agentStatusReadingSemanticContext'],
      reading_git_state: ['agentStatusReadingGitState'],
      awaiting_authorization: ['agentStatusAwaitingAuthorization'],
      generating_repair: ['agentStatusGeneratingRepair'],
      waiting_for_apply: ['agentStatusWaitingForApply'],
      running_validation: ['agentStatusRunningValidation'],
      reviewing_tool_result: ['agentStatusReviewingToolResults', 'agentStatusContinuingReasoning'],
      generating: ['agentStatusGenerating', 'agentStatusOrganizingResult', 'agentStatusWritingReply'],
      finalizing: ['agentStatusFinalizingResponse'],
      failed: ['agentStatusError']
    };

    editReferenceMenu.className = 'reference-menu message-reference-menu hidden';
    editReferenceMenu.setAttribute('role', 'listbox');
    editReferenceMenu.setAttribute('aria-label', t('referenceWorkspaceFiles'));
    document.body.append(editReferenceMenu);

    transcript.addEventListener('click', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var runButton = target?.closest('button[data-run-action]');
      if (runButton && transcript.contains(runButton)) {
        event.preventDefault();
        event.stopPropagation();
        var runMessage = state.messages.find(function(message) { return message.id === runButton.dataset.messageId; });
        if (!runMessage?.runDetails) return;
        if (runButton.dataset.runAction === 'openTrace') {
          vscode.postMessage({ type: 'openRunTrace', messageId: runMessage.id });
        } else if (runButton.dataset.runAction === 'copySummary') {
          vscode.postMessage({ type: 'writeClipboardText', text: formatRunDetailsSummary(runMessage.runDetails) });
          setTransientStatus(t('copied'));
        }
        return;
      }
      var actionButton = target?.closest('button[data-message-action]');
      if (actionButton && transcript.contains(actionButton)) {
        event.preventDefault();
        event.stopPropagation();
        handleMessageAction(actionButton);
        return;
      }

      var codeCopyButton = target?.closest('button[data-code-action="copy"]');
      if (codeCopyButton && transcript.contains(codeCopyButton)) {
        event.preventDefault();
        event.stopPropagation();
        copyCodeBlockText(codeCopyButton);
        return;
      }

      var inlineEditLink = target?.closest('.message-edit-input a.rich-file-link, .message-edit-input a.rich-skill-link');
      if (inlineEditLink && transcript.contains(inlineEditLink)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      var link = target?.closest('a.message-file-link');
      if (!link || !transcript.contains(link)) return;
      event.preventDefault();
      event.stopPropagation();
    });

    transcript.addEventListener('dblclick', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var skillLink = target?.closest('.message-edit-input a.rich-skill-link');
      if (skillLink && transcript.contains(skillLink)) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      var link = target?.closest('.message-edit-input a.rich-file-link, a.message-file-link');
      if (!link || !transcript.contains(link)) return;
      event.preventDefault();
      event.stopPropagation();
      if (link.dataset.kind === 'directory') {
        vscode.postMessage({
          type: 'openDirectoryReference',
          path: link.dataset.path || ''
        });
        return;
      }
      vscode.postMessage({
        type: 'openFileReference',
        path: link.dataset.path || '',
        startLine: readReferenceInteger(link.dataset.startLine, 0),
        endLine: readReferenceInteger(link.dataset.endLine, 0),
        startColumn: readReferenceInteger(link.dataset.startColumn, 0),
        endColumn: readReferenceInteger(link.dataset.endColumn, 0)
      });
    });

    transcript.addEventListener('submit', function(event) {
      var form = event.target instanceof Element ? event.target.closest('form.message-edit-form') : null;
      if (!form || !transcript.contains(form)) return;
      event.preventDefault();
      submitEditedMessage(form.dataset.messageId || '');
    });

    transcript.addEventListener('input', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var editor = target?.closest('.message-edit-input');
      if (!editor || !transcript.contains(editor)) return;
      refreshInlineEditorAfterEdit(editor);
    });

    transcript.addEventListener('paste', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var editor = target?.closest('.message-edit-input');
      if (!editor || !transcript.contains(editor)) return;

      event.preventDefault();
      var text = event.clipboardData ? event.clipboardData.getData('text/plain') : '';
      if (!text) return;

      insertInlinePlainText(editor, text);
      refreshInlineEditorAfterEdit(editor);
    });

    transcript.addEventListener('keydown', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var editor = target?.closest('.message-edit-input');
      if (!editor || !transcript.contains(editor)) return;

      if (editReferenceMenuOpen && editReferenceEditor === editor) {
        if (event.key === 'Escape') {
          event.preventDefault();
          closeEditReferenceMenu(true);
          return;
        }
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          moveEditReferenceSelection(1);
          return;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          moveEditReferenceSelection(-1);
          return;
        }
        if ((event.key === 'Enter' && !(event.metaKey || event.ctrlKey)) || event.key === 'Tab') {
          event.preventDefault();
          insertActiveEditReferenceResource();
          return;
        }
      }

      if (inlineShortcutController.handleKeydown(event)) {
        return;
      }

      if (event.key === 'Escape') {
        event.preventDefault();
        cancelEditingMessage();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        submitEditedMessage(editor.dataset.messageId || '');
        return;
      }

      if (event.key === 'Enter') {
        setTransientStatus(getSendShortcutHint());
      }
    });

    transcript.addEventListener('keyup', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var editor = target?.closest('.message-edit-input');
      if (!editor || !transcript.contains(editor)) return;
      saveEditSelection(editor);
      syncEditReferenceMenuFromEditor(editor);
    });

    transcript.addEventListener('mouseup', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var editor = target?.closest('.message-edit-input');
      if (!editor || !transcript.contains(editor)) return;
      inlineShortcutController.deactivateMark();
      saveEditSelection(editor);
      syncEditReferenceMenuFromEditor(editor);
    });

    document.addEventListener('selectionchange', function() {
      var editor = getActiveInlineEditor();
      if (!editor) return;
      if (inlineShortcutController.isMarkActive() && !isSelectionInsideInlineEditor(editor)) {
        inlineShortcutController.deactivateMark();
      }
      if (isSelectionInsideInlineEditor(editor)) {
        saveEditSelection(editor);
        if (editReferenceMenuOpen) {
          syncEditReferenceMenuFromEditor(editor);
        }
      }
    });

    editReferenceMenu.addEventListener('mousedown', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      if (target?.closest('button[data-edit-reference-index]')) {
        event.preventDefault();
      }
    });

    editReferenceMenu.addEventListener('click', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var button = target?.closest('button[data-edit-reference-index]');
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      var index = readReferenceInteger(button.dataset.editReferenceIndex, 1) - 1;
      insertEditReferenceResourceAtIndex(index);
    });

    document.addEventListener('mousedown', function(event) {
      if (!editReferenceMenuOpen) return;
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if (editReferenceMenu.contains(target) || (editReferenceEditor && editReferenceEditor.contains(target))) {
        return;
      }
      closeEditReferenceMenu(false);
    });

    window.addEventListener('resize', function() {
      if (editReferenceMenuOpen) {
        positionEditReferenceMenu();
      }
    });

    transcript.addEventListener('scroll', function() {
      if (editReferenceMenuOpen) {
        positionEditReferenceMenu();
      }
    });

    draftList.addEventListener('click', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var button = target?.closest('button[data-edit-id], button[data-change-set-id]');
      if (!button || button.disabled) return;
      var id = button.dataset.editId || button.dataset.changeSetId || '';
      var action = button.dataset.editAction || button.dataset.changeSetAction || '';
      if (!id || !action) return;
      if (action !== 'openDraftDiff') {
        pendingChangeActions.add(action + ':' + id);
        renderDraftEdits();
      }
      vscode.postMessage({ type: action, id: id });
    });

    if (planToggle) {
      planToggle.addEventListener('click', function() {
        planExpanded = !planExpanded;
        renderTaskPlan();
      });
    }

    if (planContinueRepair) {
      planContinueRepair.addEventListener('click', function() {
        if (state.isBusy || state.repairLoop?.status !== 'ready_for_validation') return;
        planContinueRepair.disabled = true;
        vscode.postMessage({ type: 'continueRepair' });
      });
    }

    if (draftApplyAllBtn) {
      draftApplyAllBtn.addEventListener('click', function() {
        if (state.draftEdits.length <= 1) return;
        vscode.postMessage({ type: 'applyAllDraftEdits' });
      });
    }

    if (draftDiscardAllBtn) {
      draftDiscardAllBtn.addEventListener('click', function() {
        if (state.draftEdits.length <= 1) return;
        vscode.postMessage({ type: 'discardAllDraftEdits' });
      });
    }

    if (newChatTab) {
      newChatTab.addEventListener('click', function() {
        if (state.isBusy || isBackgroundActive()) return;
        closeSettingsMenu();
        closeSessionMenu();
        resetLocalContextUsageEstimate();
        clearPromptDraft();
        vscode.postMessage({ type: 'newSession' });
      });
    }

    if (settingsTab) {
      settingsTab.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        if (state.isBusy) return;
        toggleSettingsMenu();
      });
    }

    if (backgroundStart) {
      backgroundStart.addEventListener('click', function() {
        if (state.isBusy || isBackgroundActive()) return;
        var scripts = getBackgroundAvailableScripts();
        var script = normalizeValidationScript(backgroundScript?.value);
        if (scripts.indexOf(script) < 0) return;
        var maxRounds = Math.max(1, Number(state.backgroundDefaults?.maxRounds) || 5);
        closeBackgroundRunDialog(false);
        vscode.postMessage({
          type: 'startBackgroundRun',
          script: script,
          maxRounds: normalizeIntegerInRange(backgroundMaxRounds?.value, 1, maxRounds, maxRounds)
        });
      });
    }

    if (backgroundCancel) {
      backgroundCancel.addEventListener('click', function() {
        closeBackgroundRunDialog(true);
      });
    }

    if (backgroundRunDialogOverlay) {
      backgroundRunDialogOverlay.addEventListener('mousedown', function(event) {
        if (event.target === backgroundRunDialogOverlay) {
          closeBackgroundRunDialog(true);
        }
      });
    }

    if (backgroundResume) {
      backgroundResume.addEventListener('click', function() {
        if (state.isBusy) return;
        vscode.postMessage({ type: 'resumeBackgroundRun' });
      });
    }

    if (backgroundStop) {
      backgroundStop.addEventListener('click', function() {
        vscode.postMessage({ type: 'stopBackgroundRun' });
      });
    }

    if (backgroundDismiss) {
      backgroundDismiss.addEventListener('click', function() {
        var run = state.backgroundRun && typeof state.backgroundRun === 'object' ? state.backgroundRun : null;
        if (!run || isBackgroundActive()) return;
        dismissedBackgroundRunId = String(run.id || '');
        renderBackgroundRun();
      });
    }

    document.addEventListener('keydown', function(event) {
      if (!backgroundRunDialogOpen || event.key !== 'Escape') return;
      event.preventDefault();
      closeBackgroundRunDialog(true);
    });

    window.keepseekOpenBackgroundRunDialog = openBackgroundRunDialog;

    if (settingsApiKeyMenuItem) {
      settingsApiKeyMenuItem.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        closeSettingsMenu();
        vscode.postMessage({ type: 'openApiSettings' });
      });
    }

    if (settingsHistoryMenuItem) {
      settingsHistoryMenuItem.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        closeSettingsMenu();
        vscode.postMessage({ type: 'openHistorySettings' });
      });
    }

    if (settingsAboutMenuItem) {
      settingsAboutMenuItem.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        closeSettingsMenu();
        if (window.keepseekInputControls && window.keepseekInputControls.showAboutDialog) {
          window.keepseekInputControls.showAboutDialog();
        }
      });
    }

    if (settingsDebugMenuItem) {
      settingsDebugMenuItem.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        var item = settingsDebugMenuItem.closest('.settings-debug-item');
        if (item) {
          item.classList.toggle('is-open');
          settingsDebugMenuItem.setAttribute('aria-expanded', item.classList.contains('is-open') ? 'true' : 'false');
        }
      });
    }

    if (settingsDebugModeToggle) {
      settingsDebugModeToggle.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        if (state.isBusy) return;
        state.debugMode = !state.debugMode;
        state.hasCurrentSessionLog = state.debugMode ? state.hasCurrentSessionLog : false;
        renderSettingsControls();
        vscode.postMessage({ type: 'setDebugMode', enabled: state.debugMode });
      });
    }

    if (settingsOpenLogMenuItem) {
      settingsOpenLogMenuItem.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        if (!canRequestCurrentSessionLog()) return;
        closeSettingsMenu();
        vscode.postMessage({ type: 'openCurrentSessionLog' });
      });
    }

    if (settingsLanguageMenuItem) {
      settingsLanguageMenuItem.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        var item = settingsLanguageMenuItem.closest('.settings-language-item');
        if (item) {
          item.classList.toggle('is-open');
          settingsLanguageMenuItem.setAttribute('aria-expanded', item.classList.contains('is-open') ? 'true' : 'false');
        }
      });
    }

    if (settingsLanguageSubmenu) {
      settingsLanguageSubmenu.addEventListener('click', function(event) {
        var target = event.target instanceof Element ? event.target : null;
        var button = target?.closest('button[data-language]');
        if (!button) return;
        event.preventDefault();
        event.stopPropagation();
        var language = button.dataset.language === 'en' ? 'en' : 'zh-CN';
        state.language = language;
        render();
        setTransientStatus(t('languageSaved', { language: getLanguageDisplayName(language) }));
        vscode.postMessage({ type: 'setLanguage', language: language });
      });
    }

    if (historyTab) {
      historyTab.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        if (state.isBusy) return;
        closeSettingsMenu();
        toggleSessionMenu();
      });
    }

    if (sessionMenu) {
      sessionMenu.addEventListener('click', function(event) {
        var target = event.target instanceof Element
          ? event.target
          : event.target instanceof Node
            ? event.target.parentElement
            : null;
        if (!target) return;

        var actionButton = target.closest('button[data-session-action]');
        if (actionButton) {
          event.preventDefault();
          event.stopPropagation();
          handleSessionMenuAction(actionButton);
          return;
        }

        if (target.closest('input, select, button, label')) {
          return;
        }

        var item = target.closest('[data-session-id]');
        var sessionId = item?.dataset.sessionId || '';
        if (!sessionId) {
          closeSessionMenu();
          return;
        }

        if (sessionId !== state.activeSessionId || item?.dataset.sessionOrigin === 'other') {
          resetLocalContextUsageEstimate();
          clearPromptDraft();
        }
        closeSessionMenu();
        if (item?.dataset.sessionOrigin === 'other') {
          var workspaceKey = item.dataset.workspaceKey || activeWorkspaceTab;
          if (workspaceKey) {
            vscode.postMessage({
              type: 'copyOtherWorkspaceSession',
              workspaceKey: workspaceKey,
              sessionId: sessionId
            });
          }
        } else {
          vscode.postMessage({ type: 'selectSession', sessionId: sessionId });
        }
      });

      sessionMenu.addEventListener('change', function(event) {
        var target = event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement ? event.target : null;
        if (!target) return;

        if (target.dataset.sessionRange === 'true') {
          sessionRangeDays = normalizeSessionRangeDays(target.value);
          selectedSessionIds.clear();
          renderSessionMenu();
          return;
        }

        if (target.dataset.sessionWorkspace === 'true') {
          switchSessionWorkspace(target.value || 'current');
          return;
        }

        if (target.dataset.sessionCheck === 'true') {
          if (!sessionMultiSelectMode) {
            return;
          }
          var checkSessionId = target.dataset.sessionId || '';
          if (target.checked) {
            selectedSessionIds.add(checkSessionId);
          } else {
            selectedSessionIds.delete(checkSessionId);
          }
          renderSessionMenu();
          return;
        }

      });

      sessionMenu.addEventListener('focusout', function(event) {
        var target = event.target instanceof HTMLInputElement ? event.target : null;
        if (target?.dataset.sessionTitle === 'true') {
          commitSessionTitle(target);
        }
      });

      sessionMenu.addEventListener('keydown', function(event) {
        var target = event.target instanceof Element ? event.target : null;
        if (!target) return;

        var titleInput = target.closest('input[data-session-title="true"]');
        if (titleInput instanceof HTMLInputElement) {
          if (event.key === 'Enter') {
            event.preventDefault();
            titleInput.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            titleInput.value = titleInput.dataset.originalTitle || '';
            titleInput.blur();
          }
          return;
        }

        if (target.closest('input, select, button')) {
          return;
        }

        var item = target.closest('[data-session-id]');
        if (item && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          var keyboardSessionId = item.dataset.sessionId || '';
          if (keyboardSessionId) {
            var keyboardWorkspaceKey = item.dataset.workspaceKey || activeWorkspaceTab;
            if (keyboardSessionId !== state.activeSessionId || item.dataset.sessionOrigin === 'other') {
              resetLocalContextUsageEstimate();
              clearPromptDraft();
            }
            closeSessionMenu();
            if (item.dataset.sessionOrigin === 'other' && keyboardWorkspaceKey) {
              vscode.postMessage({
                type: 'copyOtherWorkspaceSession',
                workspaceKey: keyboardWorkspaceKey,
                sessionId: keyboardSessionId
              });
            } else {
              vscode.postMessage({ type: 'selectSession', sessionId: keyboardSessionId });
            }
          }
        }
      });
    }

    document.addEventListener('mousedown', function(event) {
      if (!sessionMenuOpen) return;
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if ((sessionMenu && sessionMenu.contains(target)) || (historyTab && historyTab.contains(target))) {
        return;
      }
      closeSessionMenu();
    });

    document.addEventListener('mousedown', function(event) {
      if (!settingsMenuOpen) return;
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if ((settingsMenu && settingsMenu.contains(target)) || (settingsTab && settingsTab.contains(target))) {
        return;
      }
      closeSettingsMenu();
    });

    document.addEventListener('keydown', function(event) {
      if ((!sessionMenuOpen && !settingsMenuOpen) || event.key !== 'Escape') return;
      event.preventDefault();
      closeSessionMenu();
      closeSettingsMenu();
    });

    window.keepseekInlineEditorControls = {
      insertFileReference: insertFileReferenceIntoActiveEditor,
      hasActiveEditor: function() {
        return Boolean(getActiveInlineEditor());
      }
    };

    ${getInputScript()}

    window.addEventListener('message', function(event) {
      var message = event.data;
      if (message.type === 'state') {
        var previousActiveSessionId = state.activeSessionId || '';
        Object.assign(state, message.state);
        pendingChangeActions.clear();
        if (previousActiveSessionId && previousActiveSessionId !== state.activeSessionId) {
          planExpanded = false;
        }
        rememberTerminalAgentActivity(state.agentActivity);
        render();
      } else if (message.type === 'sessionChanged') {
        resetLocalContextUsageEstimate();
        clearPromptDraft();
      } else if (message.type === 'showSettingsDialog') {
        if (window.keepseekInputControls && window.keepseekInputControls.showSettingsDialog) {
          window.keepseekInputControls.showSettingsDialog(message);
        }
      } else if (message.type === 'showHistorySettingsDialog') {
        if (window.keepseekInputControls && window.keepseekInputControls.showHistorySettingsDialog) {
          window.keepseekInputControls.showHistorySettingsDialog(message);
        }
      } else if (message.type === 'skillDraftCreated') {
        if (window.keepseekInputControls && window.keepseekInputControls.onSkillDraftCreated) {
          window.keepseekInputControls.onSkillDraftCreated(message);
        }
      } else if (message.type === 'otherWorkspaces') {
        otherWorkspacesError = message.error || '';
        if (!otherWorkspacesError) {
          otherWorkspaces = Array.isArray(message.workspaces) ? message.workspaces : [];
          if (!isCurrentWorkspaceTab() && !otherWorkspaces.some(function(workspace) {
            return workspace.workspaceKey === activeWorkspaceTab;
          })) {
            activeWorkspaceTab = 'current';
            selectedSessionIds.clear();
          }
        }
        renderSessionMenu();
      } else if (message.type === 'otherWorkspaceSessions') {
        var workspaceKey = String(message.workspaceKey || '');
        if (workspaceKey) {
          if (message.error) {
            otherWorkspaceSessionErrors[workspaceKey] = message.error;
            otherWorkspaceSessions[workspaceKey] = [];
          } else {
            otherWorkspaceSessions[workspaceKey] = Array.isArray(message.sessions) ? message.sessions : [];
            delete otherWorkspaceSessionErrors[workspaceKey];
          }
        }
        renderSessionMenu();
      } else if (message.type === 'otherWorkspaceDeleted') {
        var deletedWorkspaceKey = String(message.workspaceKey || '');
        otherWorkspaces = otherWorkspaces.filter(function(workspace) {
          return workspace.workspaceKey !== deletedWorkspaceKey;
        });
        delete otherWorkspaceSessions[deletedWorkspaceKey];
        delete otherWorkspaceSessionErrors[deletedWorkspaceKey];
        if (activeWorkspaceTab === deletedWorkspaceKey) {
          activeWorkspaceTab = 'current';
          selectedSessionIds.clear();
        }
        renderSessionMenu();
      } else if (message.type === 'referenceResources') {
        handleEditReferenceResourcesMessage(message);
      }
    });

    function render() {
      applyStaticTranslations();
      syncEditingState();
      renderSettingsControls();
      renderSessionControls();
      renderBackgroundRun();
      renderContextChips();
      renderTaskPlan();
      renderDraftEdits();
      renderTranscript();
      renderStatus();
      if (window.keepseekInputControls) {
        window.keepseekInputControls.render();
      }
      sendButton.disabled = !state.isBusy && (
        window.keepseekInputControls && window.keepseekInputControls.isPromptSubmittableEmpty
          ? window.keepseekInputControls.isPromptSubmittableEmpty()
          : promptInput.classList.contains('is-empty')
      );
    }

    function applyStaticTranslations() {
      document.documentElement.lang = getLanguage() === 'en' ? 'en' : 'zh-CN';
      document.querySelectorAll('[data-i18n]').forEach(function(element) {
        element.textContent = t(element.dataset.i18n || '');
      });
      document.querySelectorAll('[data-i18n-title]').forEach(function(element) {
        element.setAttribute('title', t(element.dataset.i18nTitle || ''));
      });
      document.querySelectorAll('[data-i18n-aria-label]').forEach(function(element) {
        element.setAttribute('aria-label', t(element.dataset.i18nAriaLabel || ''));
      });
      document.querySelectorAll('[data-i18n-placeholder]').forEach(function(element) {
        element.setAttribute('data-placeholder', t(element.dataset.i18nPlaceholder || ''));
      });
      editReferenceMenu.setAttribute('aria-label', t('referenceWorkspaceFiles'));
    }

    function renderSettingsControls() {
      if (settingsTab) {
        settingsTab.disabled = state.isBusy;
        settingsTab.classList.toggle('active', settingsMenuOpen);
        settingsTab.setAttribute('aria-expanded', settingsMenuOpen ? 'true' : 'false');
      }
      if (settingsMenu) {
        settingsMenu.classList.toggle('hidden', !settingsMenuOpen);
      }
      if (settingsDebugValue) {
        settingsDebugValue.textContent = t(state.debugMode ? 'on' : 'off');
      }
      if (settingsDebugMenuItem) {
        var debugItem = settingsDebugMenuItem.closest('.settings-debug-item');
        settingsDebugMenuItem.disabled = state.isBusy;
        settingsDebugMenuItem.setAttribute('aria-expanded', debugItem?.classList.contains('is-open') ? 'true' : 'false');
      }
      if (settingsDebugModeToggle) {
        settingsDebugModeToggle.disabled = state.isBusy;
        settingsDebugModeToggle.setAttribute('aria-checked', state.debugMode ? 'true' : 'false');
        settingsDebugModeToggle.title = t(state.debugMode ? 'settingsDebugModeDisable' : 'settingsDebugModeEnable');
      }
      if (settingsOpenLogMenuItem) {
        settingsOpenLogMenuItem.disabled = !canRequestCurrentSessionLog();
        settingsOpenLogMenuItem.title = t(state.debugMode
          ? (state.hasCurrentSessionLog ? 'openCurrentSessionLog' : 'openCurrentSessionLogUnavailable')
          : 'openCurrentSessionLogDebugOff');
      }
      if (settingsLanguageValue) {
        settingsLanguageValue.textContent = getLanguageDisplayName(getLanguage());
      }
      if (settingsAboutVersionValue) {
        settingsAboutVersionValue.textContent = formatExtensionVersion(getExtensionInfo().version);
      }
      if (settingsLanguageSubmenu) {
        var buttons = settingsLanguageSubmenu.querySelectorAll('button[data-language]');
        buttons.forEach(function(button) {
          var isSelected = (button.dataset.language === 'en' ? 'en' : 'zh-CN') === getLanguage();
          button.setAttribute('aria-checked', isSelected ? 'true' : 'false');
        });
      }
    }

    function getBackgroundAvailableScripts() {
      return Array.isArray(state.backgroundAvailableScripts)
        ? state.backgroundAvailableScripts.filter(function(script) {
            return script === 'compile' || script === 'lint' || script === 'test';
          })
        : [];
    }

    function openBackgroundRunDialog() {
      if (!backgroundRunDialogOverlay || state.isBusy || isBackgroundActive()) return;
      if (!getBackgroundAvailableScripts().length) return;
      backgroundRunDialogOpen = true;
      backgroundRunDialogOverlay.classList.remove('hidden');
      if (backgroundMaxRounds) {
        backgroundMaxRounds.value = String(Math.max(1, Number(state.backgroundDefaults?.maxRounds) || 5));
      }
      renderBackgroundRunDialog();
      window.setTimeout(function() {
        backgroundScript?.focus();
      }, 0);
    }

    function closeBackgroundRunDialog(restoreFocus) {
      backgroundRunDialogOpen = false;
      backgroundRunDialogOverlay?.classList.add('hidden');
      if (restoreFocus) {
        promptInput?.focus();
      }
    }

    function renderBackgroundRunDialog() {
      if (!backgroundScript || !backgroundMaxRounds || !backgroundStart) return;
      var scripts = getBackgroundAvailableScripts();
      if (!scripts.length) {
        closeBackgroundRunDialog(false);
        return;
      }
      var previousScript = normalizeValidationScript(backgroundScript.value);
      var preferredScript = state.repairLoop?.lastValidationScript;
      var selectedScript = scripts.indexOf(previousScript) >= 0
        ? previousScript
        : scripts.indexOf(preferredScript) >= 0
          ? preferredScript
          : scripts[0];
      backgroundScript.innerHTML = '';
      scripts.forEach(function(script) {
        var option = document.createElement('option');
        option.value = script;
        option.textContent = script;
        option.selected = script === selectedScript;
        backgroundScript.append(option);
      });
      var maxRounds = Math.max(1, Number(state.backgroundDefaults?.maxRounds) || 5);
      backgroundMaxRounds.max = String(maxRounds);
      var selectedRounds = Number(backgroundMaxRounds.value);
      if (!Number.isFinite(selectedRounds) || selectedRounds < 1 || selectedRounds > maxRounds) {
        backgroundMaxRounds.value = String(maxRounds);
      }
      backgroundStart.disabled = state.isBusy || isBackgroundActive() || scripts.length === 0;
    }

    function renderBackgroundRun() {
      if (!backgroundRegion || !backgroundStatus) return;
      var candidate = state.backgroundRun && typeof state.backgroundRun === 'object' ? state.backgroundRun : null;
      var run = candidate?.sessionId === state.activeSessionId ? candidate : null;
      var active = isBackgroundActive();
      var visible = Boolean(run) && (active || String(run?.id || '') !== dismissedBackgroundRunId);
      backgroundRegion.classList.toggle('hidden', !visible);
      if (backgroundRunDialogOpen) {
        renderBackgroundRunDialog();
      }
      if (!run || !visible) return;
      if (backgroundLabel) {
        backgroundLabel.textContent = t('backgroundRun') + ' · ' + normalizeValidationScript(run.goal?.script);
      }
      var statusKey = 'backgroundStatus_' + run.status;
      var statusLabel = t(statusKey);
      if (statusLabel === statusKey) statusLabel = run.status || t('backgroundIdle');
      statusLabel += ' · ' + t('backgroundProgress', {
        current: Number(run.progress?.round) || 0,
        max: Number(run.limits?.maxRounds) || 0,
        tools: Number(run.progress?.toolCalls) || 0
      });
      if (run.waitingReason || run.stopReason) {
        statusLabel += ' · ' + String(run.waitingReason || run.stopReason);
      }
      backgroundStatus.textContent = statusLabel;
      if (backgroundResume) {
        var canResume = run?.status === 'waiting_for_apply' && state.repairLoop?.status === 'ready_for_validation' && !state.isBusy;
        backgroundResume.classList.toggle('hidden', run?.status !== 'waiting_for_apply');
        backgroundResume.disabled = !canResume;
      }
      if (backgroundStop) {
        backgroundStop.classList.toggle('hidden', !active);
        backgroundStop.disabled = false;
      }
      if (backgroundDismiss) {
        backgroundDismiss.classList.toggle('hidden', active);
      }
    }

    function isBackgroundActive() {
      var statusValue = state.backgroundRun?.status;
      return statusValue === 'running' || statusValue === 'waiting_for_apply' || statusValue === 'waiting_for_authorization';
    }

    function normalizeValidationScript(value) {
      return value === 'test' || value === 'lint' ? value : 'compile';
    }

    function renderSessionControls() {
      if (newChatTab) {
        newChatTab.disabled = state.isBusy || isBackgroundActive();
      }
      if (historyTab) {
        historyTab.disabled = state.isBusy || isBackgroundActive();
        historyTab.classList.toggle('active', sessionMenuOpen);
        historyTab.setAttribute('aria-expanded', sessionMenuOpen ? 'true' : 'false');
      }
      renderSessionMenu();
    }

    function canRequestCurrentSessionLog() {
      return state.debugMode === true;
    }

    function toggleSettingsMenu() {
      if (settingsMenuOpen) {
        closeSettingsMenu();
      } else {
        openSettingsMenu();
      }
    }

    function openSettingsMenu() {
      closeSessionMenu();
      settingsMenuOpen = true;
      renderSettingsControls();
    }

    function closeSettingsMenu() {
      settingsMenuOpen = false;
      if (settingsLanguageMenuItem) {
        settingsLanguageMenuItem.setAttribute('aria-expanded', 'false');
      }
      var languageItem = settingsLanguageMenuItem ? settingsLanguageMenuItem.closest('.settings-language-item') : null;
      if (languageItem) {
        languageItem.classList.remove('is-open');
      }
      if (settingsDebugMenuItem) {
        settingsDebugMenuItem.setAttribute('aria-expanded', 'false');
      }
      var debugItem = settingsDebugMenuItem ? settingsDebugMenuItem.closest('.settings-debug-item') : null;
      if (debugItem) {
        debugItem.classList.remove('is-open');
      }
      renderSettingsControls();
    }

    function toggleSessionMenu() {
      if (sessionMenuOpen) {
        closeSessionMenu();
      } else {
        openSessionMenu();
      }
    }

    function openSessionMenu() {
      activeWorkspaceTab = 'current';
      sessionRangeDays = 1;
      sessionMultiSelectMode = false;
      selectedSessionIds.clear();
      editingSessionTitleId = '';
      sessionMenuOpen = true;
      renderSessionControls();
      vscode.postMessage({ type: 'listOtherWorkspaces' });
    }

    function closeSessionMenu() {
      sessionMenuOpen = false;
      activeWorkspaceTab = 'current';
      sessionMultiSelectMode = false;
      selectedSessionIds.clear();
      editingSessionTitleId = '';
      renderSessionControls();
    }

    function renderSessionMenu() {
      if (!sessionMenu) return;
      sessionMenu.classList.toggle('hidden', !sessionMenuOpen);
      if (!sessionMenuOpen) return;
      sessionMenu.classList.toggle('is-multi-select', sessionMultiSelectMode);
      sessionMenu.classList.toggle('is-other-workspace', !isCurrentWorkspaceTab());
      sessionMenu.innerHTML = '';

      var sessions = getActiveVisibleSessions();
      pruneSelectedSessionIds(sessions);
      var allVisibleSelected = sessions.length > 0 && sessions.every(function(session) {
        return selectedSessionIds.has(session.id);
      });
      var currentTab = isCurrentWorkspaceTab();
      var activeOtherWorkspaceError = currentTab ? '' : (otherWorkspaceSessionErrors[activeWorkspaceTab] || '');
      var activeOtherWorkspaceLoading = !currentTab
        && !hasOtherWorkspaceSessionsCache(activeWorkspaceTab)
        && !activeOtherWorkspaceError;

      var title = document.createElement('div');
      title.className = 'session-menu-title';
      title.textContent = t('sessionHistory');
      sessionMenu.append(title);

      if (otherWorkspacesError) {
        var workspaceError = document.createElement('div');
        workspaceError.className = 'session-menu-empty session-menu-error';
        workspaceError.textContent = t('sessionLoadError') + ': ' + otherWorkspacesError;
        sessionMenu.append(workspaceError);
      }

      var controls = document.createElement('div');
      controls.className = 'session-menu-controls';

      var workspaceSelect = document.createElement('select');
      workspaceSelect.className = 'session-menu-workspace-select';
      workspaceSelect.dataset.sessionWorkspace = 'true';
      workspaceSelect.setAttribute('aria-label', t('sessionProjectSessions'));
      renderWorkspaceOptions(workspaceSelect);

      var rangeSelect = document.createElement('select');
      rangeSelect.className = 'session-menu-range-select';
      rangeSelect.dataset.sessionRange = 'true';
      rangeSelect.setAttribute('aria-label', t('sessionRangeLabel'));
      rangeSelect.title = t('sessionRangeLabel');
      renderSessionRangeOptions(rangeSelect);

      var multiSelectButton = document.createElement('button');
      multiSelectButton.type = 'button';
      multiSelectButton.className = 'session-menu-filter session-menu-edit-toggle' + (sessionMultiSelectMode ? ' is-active' : '');
      multiSelectButton.dataset.sessionAction = 'toggleMultiSelect';
      multiSelectButton.setAttribute('aria-pressed', sessionMultiSelectMode ? 'true' : 'false');
      multiSelectButton.textContent = t(sessionMultiSelectMode ? 'sessionExitMultiSelect' : 'sessionMultiSelect');

      controls.append(workspaceSelect, rangeSelect);
      var favoriteOnlyButton = document.createElement('button');
      favoriteOnlyButton.type = 'button';
      favoriteOnlyButton.className = 'session-menu-filter' + (sessionFavoritesOnly ? ' is-active' : '');
      favoriteOnlyButton.dataset.sessionAction = 'toggleFavoritesOnly';
      favoriteOnlyButton.setAttribute('aria-pressed', sessionFavoritesOnly ? 'true' : 'false');
      favoriteOnlyButton.textContent = t('sessionFavoritesOnly');
      controls.append(favoriteOnlyButton);
      controls.append(multiSelectButton);
      sessionMenu.append(controls);

      if (!currentTab) {
        var deleteWorkspaceButton = document.createElement('button');
        deleteWorkspaceButton.type = 'button';
        deleteWorkspaceButton.className = 'session-menu-delete-workspace';
        deleteWorkspaceButton.dataset.sessionAction = 'deleteWorkspace';
        deleteWorkspaceButton.textContent = t('sessionDeleteWorkspace');
        sessionMenu.append(deleteWorkspaceButton);
      }

      if (sessionMultiSelectMode) {
        var bulk = document.createElement('div');
        bulk.className = 'session-menu-bulk';

        var selectAll = document.createElement('button');
        selectAll.type = 'button';
        selectAll.className = 'secondary';
        selectAll.dataset.sessionAction = 'toggleSelectVisible';
        selectAll.disabled = !sessions.length;
        selectAll.textContent = t(allVisibleSelected ? 'sessionDeselectAll' : 'sessionSelectAll');

        var deleteSelected = document.createElement('button');
        deleteSelected.type = 'button';
        deleteSelected.className = 'session-menu-delete';
        deleteSelected.dataset.sessionAction = 'deleteSelected';
        deleteSelected.disabled = !selectedSessionIds.size;
        deleteSelected.textContent = selectedSessionIds.size
          ? t('sessionDeleteSelected') + ' (' + selectedSessionIds.size + ')'
          : t('sessionDeleteSelected');

        bulk.append(selectAll, deleteSelected);
        sessionMenu.append(bulk);
      }

      if (activeOtherWorkspaceError) {
        var loadError = document.createElement('div');
        loadError.className = 'session-menu-empty session-menu-error';
        loadError.textContent = t('sessionLoadError') + ': ' + activeOtherWorkspaceError;
        sessionMenu.append(loadError);
        return;
      }

      if (activeOtherWorkspaceLoading) {
        var loading = document.createElement('div');
        loading.className = 'session-menu-empty';
        loading.textContent = t('loading') + '...';
        sessionMenu.append(loading);
        return;
      }

      if (!sessions.length) {
        var empty = document.createElement('div');
        empty.className = 'session-menu-empty';
        empty.textContent = t('noHistory');
        sessionMenu.append(empty);
        return;
      }

      for (var i = 0; i < sessions.length; i++) {
        var session = sessions[i];
        var item = document.createElement('div');
        var isActive = session.id === state.activeSessionId;
        var isFavorite = session.isFavorite === true;
        item.className = 'session-menu-item'
          + (currentTab && isActive ? ' is-active' : '')
          + (currentTab && isFavorite ? ' is-favorite' : '')
          + (!currentTab ? ' is-other-workspace' : '');
        item.dataset.sessionId = session.id;
        item.dataset.sessionOrigin = currentTab ? 'current' : 'other';
        if (!currentTab) {
          item.dataset.workspaceKey = activeWorkspaceTab;
        }
        item.tabIndex = 0;
        item.setAttribute('role', currentTab ? 'menuitemradio' : 'menuitem');
        if (currentTab) {
          item.setAttribute('aria-checked', isActive ? 'true' : 'false');
        }

        var main = document.createElement('div');
        main.className = 'session-menu-item-main';

        var itemTitle;
        if (currentTab && editingSessionTitleId === session.id) {
          itemTitle = document.createElement('input');
          itemTitle.className = 'session-menu-item-title';
          itemTitle.type = 'text';
          itemTitle.value = session.title || t('newSession');
          itemTitle.title = itemTitle.value;
          itemTitle.dataset.sessionTitle = 'true';
          itemTitle.dataset.sessionId = session.id;
          itemTitle.dataset.originalTitle = itemTitle.value;
          itemTitle.setAttribute('aria-label', t('renameSessionTitle'));
        } else {
          itemTitle = document.createElement('span');
          itemTitle.className = 'session-menu-item-title';
          itemTitle.textContent = session.title || t('newSession');
          itemTitle.title = itemTitle.textContent;
        }

        var meta = document.createElement('span');
        meta.className = 'session-menu-item-meta';
        meta.textContent = formatSessionMeta(session);

        main.append(itemTitle, meta);
        if (sessionMultiSelectMode) {
          var checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.className = 'session-menu-checkbox';
          checkbox.dataset.sessionCheck = 'true';
          checkbox.dataset.sessionId = session.id;
          checkbox.checked = selectedSessionIds.has(session.id);
          checkbox.setAttribute('aria-label', t('sessionSelectAll'));
          item.append(checkbox);
        }
        if (currentTab) {
          var favoriteButton = document.createElement('button');
          favoriteButton.type = 'button';
          favoriteButton.className = 'session-menu-star' + (isFavorite ? ' is-active' : '');
          favoriteButton.dataset.sessionAction = 'toggleFavorite';
          favoriteButton.dataset.sessionId = session.id;
          favoriteButton.setAttribute('aria-pressed', isFavorite ? 'true' : 'false');
          favoriteButton.setAttribute('aria-label', t(isFavorite ? 'unfavoriteSession' : 'favoriteSession'));
          favoriteButton.title = t(isFavorite ? 'unfavoriteSession' : 'favoriteSession');
          favoriteButton.textContent = isFavorite ? '★' : '☆';
          favoriteButton.addEventListener('click', function(event) {
            event.preventDefault();
            event.stopPropagation();
            var button = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
            var favoriteSessionId = button?.dataset.sessionId || '';
            if (favoriteSessionId) {
              vscode.postMessage({ type: 'toggleSessionFavorite', sessionId: favoriteSessionId });
            }
          });
          item.append(favoriteButton);
        }
        item.append(main);
        if (currentTab) {
          var renameButton = document.createElement('button');
          renameButton.type = 'button';
          renameButton.className = 'session-menu-rename';
          renameButton.dataset.sessionAction = 'startRename';
          renameButton.dataset.sessionId = session.id;
          renameButton.setAttribute('aria-label', t('renameSessionTitle'));
          renameButton.title = t('renameSessionTitle');
          renameButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
          item.append(renameButton);
        }
        sessionMenu.append(item);
      }
    }

    function renderWorkspaceOptions(select) {
      var currentOption = document.createElement('option');
      currentOption.value = 'current';
      currentOption.textContent = t('sessionTabCurrentProject');
      currentOption.title = currentOption.textContent;
      select.append(currentOption);

      otherWorkspaces.forEach(function(workspace) {
        var workspaceKey = String(workspace.workspaceKey || '');
        if (!workspaceKey) return;
        var option = document.createElement('option');
        option.value = workspaceKey;
        option.textContent = formatWorkspaceOptionLabel(workspace);
        option.title = option.textContent;
        select.append(option);
      });

      select.value = activeWorkspaceTab;
      if (select.value !== activeWorkspaceTab) {
        activeWorkspaceTab = 'current';
        select.value = 'current';
      }
    }

    function getCurrentVisibleSessions() {
      var sessions = Array.isArray(state.sessionSummaries) ? state.sessionSummaries.slice() : [];
      sessions.sort(function(a, b) {
        var favoriteDelta = (b.isFavorite === true ? 1 : 0) - (a.isFavorite === true ? 1 : 0);
        if (favoriteDelta) return favoriteDelta;
        return getSessionTimestamp(b) - getSessionTimestamp(a);
      });
      return sessions.filter(function(session) {
        if (sessionFavoritesOnly && session.isFavorite !== true) {
          return false;
        }
        if (sessionRangeDays <= 0) {
          return true;
        }
        var updatedAt = getSessionTimestamp(session);
        if (!Number.isFinite(updatedAt)) {
          return true;
        }
        return updatedAt >= Date.now() - sessionRangeDays * 24 * 60 * 60 * 1000;
      });
    }

    function getVisibleOtherWorkspaceSessions(workspaceKey) {
      var sessions = Array.isArray(otherWorkspaceSessions[workspaceKey])
        ? otherWorkspaceSessions[workspaceKey].slice()
        : [];
      sessions.sort(function(a, b) {
        return getSessionTimestamp(b) - getSessionTimestamp(a);
      });
      return sessions.filter(function(session) {
        if (sessionFavoritesOnly && session.isFavorite !== true) {
          return false;
        }
        if (sessionRangeDays <= 0) {
          return true;
        }
        var updatedAt = getSessionTimestamp(session);
        if (!Number.isFinite(updatedAt)) {
          return true;
        }
        return updatedAt >= Date.now() - sessionRangeDays * 24 * 60 * 60 * 1000;
      });
    }

    function getActiveVisibleSessions() {
      return isCurrentWorkspaceTab()
        ? getCurrentVisibleSessions()
        : getVisibleOtherWorkspaceSessions(activeWorkspaceTab);
    }

    function isCurrentWorkspaceTab() {
      return activeWorkspaceTab === 'current';
    }

    function hasOtherWorkspaceSessionsCache(workspaceKey) {
      return Object.prototype.hasOwnProperty.call(otherWorkspaceSessions, workspaceKey);
    }

    function formatWorkspaceOptionLabel(workspace) {
      var name = String(workspace.workspaceName || t('sessionTabOtherProject'));
      var count = Number(workspace.sessionCount) || 0;
      return name + ' (' + count + ')';
    }

    function renderSessionRangeOptions(select) {
      var options = [1, 2, 5].map(function(days) {
        return { value: String(days), label: t('sessionRangeRecentDays', { count: days }) };
      });
      options.push({ value: 'all', label: t('sessionRangeAll') });
      options.forEach(function(option) {
        var element = document.createElement('option');
        element.value = option.value;
        element.textContent = option.label;
        select.append(element);
      });
      select.value = sessionRangeDays <= 0 ? 'all' : String(sessionRangeDays);
    }

    function normalizeSessionRetentionDays(value) {
      var days = normalizeIntegerInRange(value, 1, 5, 1);
      return days === 2 || days === 5 ? days : 1;
    }

    function normalizeSessionRangeDays(value) {
      if (value === 'all') {
        return 0;
      }
      return normalizeSessionRetentionDays(value);
    }

    function pruneSelectedSessionIds(sessions) {
      var visibleIds = new Set(sessions.map(function(session) { return session.id; }));
      selectedSessionIds.forEach(function(sessionId) {
        if (!visibleIds.has(sessionId)) {
          selectedSessionIds.delete(sessionId);
        }
      });
    }

    function switchSessionWorkspace(workspaceKey) {
      var nextWorkspaceKey = workspaceKey || 'current';
      if (nextWorkspaceKey === activeWorkspaceTab) {
        return;
      }
      activeWorkspaceTab = nextWorkspaceKey;
      selectedSessionIds.clear();
      editingSessionTitleId = '';
      if (!isCurrentWorkspaceTab() && (!hasOtherWorkspaceSessionsCache(activeWorkspaceTab) || otherWorkspaceSessionErrors[activeWorkspaceTab])) {
        delete otherWorkspaceSessionErrors[activeWorkspaceTab];
        delete otherWorkspaceSessions[activeWorkspaceTab];
        vscode.postMessage({ type: 'loadOtherWorkspaceSessions', workspaceKey: activeWorkspaceTab });
      }
      renderSessionMenu();
    }

    function beginSessionTitleEdit(sessionId) {
      editingSessionTitleId = sessionId;
      renderSessionMenu();
      setTimeout(function() {
        var input = sessionMenu?.querySelector('input[data-session-title="true"][data-session-id="' + cssEscape(sessionId) + '"]');
        if (input instanceof HTMLInputElement) {
          input.focus();
          input.select();
        }
      }, 0);
    }

    function cssEscape(value) {
      if (window.CSS && typeof window.CSS.escape === 'function') {
        return window.CSS.escape(value);
      }
      return String(value).replace(/"/g, '\\"');
    }

    function handleSessionMenuAction(button) {
      var action = button.dataset.sessionAction || '';
      if (action === 'switchWorkspaceTab') {
        switchSessionWorkspace(button.dataset.workspaceTab || 'current');
        return;
      }

      if (action === 'toggleFavorite') {
        if (!isCurrentWorkspaceTab()) {
          return;
        }
        var favoriteRow = button.closest('.session-menu-item');
        var favoriteSessionId = button.dataset.sessionId || favoriteRow?.dataset.sessionId || '';
        if (favoriteSessionId) {
          vscode.postMessage({ type: 'toggleSessionFavorite', sessionId: favoriteSessionId });
        }
        return;
      }

      if (action === 'toggleMultiSelect') {
        sessionMultiSelectMode = !sessionMultiSelectMode;
        selectedSessionIds.clear();
        editingSessionTitleId = '';
        renderSessionMenu();
        return;
      }

      if (action === 'toggleFavoritesOnly') {
        sessionFavoritesOnly = !sessionFavoritesOnly;
        selectedSessionIds.clear();
        renderSessionMenu();
        return;
      }

      if (action === 'startRename') {
        if (!isCurrentWorkspaceTab()) {
          return;
        }
        var renameRow = button.closest('.session-menu-item');
        var renameSessionId = button.dataset.sessionId || renameRow?.dataset.sessionId || '';
        if (renameSessionId) {
          beginSessionTitleEdit(renameSessionId);
        }
        return;
      }

      if (action === 'toggleSelectVisible') {
        var visibleSessions = getActiveVisibleSessions();
        var shouldDeselect = visibleSessions.length > 0 && visibleSessions.every(function(session) {
          return selectedSessionIds.has(session.id);
        });
        if (shouldDeselect) {
          visibleSessions.forEach(function(session) {
            selectedSessionIds.delete(session.id);
          });
        } else {
          visibleSessions.forEach(function(session) {
            selectedSessionIds.add(session.id);
          });
        }
        renderSessionMenu();
        return;
      }

      if (action === 'deleteSelected') {
        if (!sessionMultiSelectMode) {
          return;
        }
        var sessionIds = Array.from(selectedSessionIds);
        if (!sessionIds.length) {
          return;
        }
        selectedSessionIds.clear();
        if (isCurrentWorkspaceTab()) {
          vscode.postMessage({ type: 'deleteSessions', sessionIds: sessionIds });
        } else {
          vscode.postMessage({
            type: 'deleteOtherWorkspaceSessions',
            workspaceKey: activeWorkspaceTab,
            sessionIds: sessionIds
          });
        }
        renderSessionMenu();
        return;
      }

      if (action === 'deleteWorkspace') {
        if (isCurrentWorkspaceTab()) {
          return;
        }
        vscode.postMessage({ type: 'deleteOtherWorkspace', workspaceKey: activeWorkspaceTab });
      }
    }

    function commitSessionTitle(input) {
      var sessionId = input.dataset.sessionId || '';
      var originalTitle = input.dataset.originalTitle || '';
      var title = input.value.replace(/\\s+/g, ' ').trim();
      if (!title) {
        input.value = originalTitle || t('newSession');
        editingSessionTitleId = '';
        renderSessionMenu();
        return;
      }
      input.value = title;
      editingSessionTitleId = '';
      if (!sessionId || title === originalTitle) {
        renderSessionMenu();
        return;
      }
      input.dataset.originalTitle = title;
      updateLocalSessionTitle(sessionId, title);
      vscode.postMessage({ type: 'renameSession', sessionId: sessionId, title: title });
      renderSessionMenu();
    }

    function updateLocalSessionTitle(sessionId, title) {
      if (!Array.isArray(state.sessionSummaries)) {
        return;
      }
      state.sessionSummaries.forEach(function(session) {
        if (session.id === sessionId) {
          session.title = title;
          session.customTitle = title;
        }
      });
    }

    function getSessionTimestamp(session) {
      var timestamp = Date.parse(session.updatedAt || session.createdAt || '');
      return Number.isFinite(timestamp) ? timestamp : 0;
    }

    function formatSessionMeta(session) {
      var count = Number(session.messageCount) || 0;
      var countLabel = count > 0 ? t('messageCount', { count: count }) : t('emptySession');
      var timeLabel = formatSessionTime(session.updatedAt || session.createdAt);
      return timeLabel ? timeLabel + ' · ' + countLabel : countLabel;
    }

    function formatSessionTime(value) {
      var time = Date.parse(value || '');
      if (!Number.isFinite(time)) return '';
      return new Date(time).toLocaleString(getLanguage() === 'en' ? 'en' : 'zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }

    function clearPromptDraft() {
      if (window.keepseekInputControls && window.keepseekInputControls.clearPrompt) {
        window.keepseekInputControls.clearPrompt();
      } else if (promptInput) {
        promptInput.innerHTML = '';
        promptInput.classList.add('is-empty');
      }
    }

    function renderStatus() {
      if (!state.isBusy) {
        stopAgentStatusRotation();
        agentStatusRotationKey = '';
        status.textContent = transientStatus;
        status.title = transientStatus;
        status.classList.toggle('is-active', Boolean(transientStatus));
        return;
      }

      var activity = normalizeAgentActivity(state.agentActivity);
      var activityKey = getAgentActivityKey(activity);
      if (activityKey !== agentStatusRotationKey) {
        agentStatusRotationKey = activityKey;
        agentStatusRotationIndex = 0;
      }
      startAgentStatusRotation();

      var statusText = getAgentActivityStatusText(activity) || t('processing');
      status.textContent = statusText;
      status.title = statusText;
      status.classList.toggle('is-active', Boolean(statusText));
    }

    function setTransientStatus(message, durationMs) {
      transientStatus = message;
      renderStatus();
      if (transientStatusTimer) {
        clearTimeout(transientStatusTimer);
      }
      transientStatusTimer = setTimeout(function() {
        transientStatus = '';
        renderStatus();
      }, durationMs || 2200);
    }

    function normalizeAgentActivity(activity) {
      if (!activity || typeof activity !== 'object') {
        return { base: 'idle', phase: 'idle', toolName: '', detail: '', sequence: 0, updatedAt: '' };
      }
      return {
        base: typeof activity.base === 'string' ? activity.base : 'idle',
        phase: typeof activity.phase === 'string' ? activity.phase : 'idle',
        toolName: typeof activity.toolName === 'string' ? activity.toolName : '',
        detail: typeof activity.detail === 'string' ? activity.detail : '',
        sequence: Number(activity.sequence) || 0,
        updatedAt: typeof activity.updatedAt === 'string' ? activity.updatedAt : ''
      };
    }

    function rememberTerminalAgentActivity(activity) {
      var normalized = normalizeAgentActivity(activity);
      if (normalized.base !== 'complete' && normalized.base !== 'error' && normalized.base !== 'stopped') {
        return;
      }
      var key = [normalized.base, normalized.sequence, normalized.updatedAt].join('|');
      if (key === terminalAgentStatusKey) {
        return;
      }
      terminalAgentStatusKey = key;
      setTransientStatus(
        t(normalized.base === 'error' ? 'agentStatusError' : normalized.base === 'stopped' ? 'agentStatusStopped' : 'agentStatusComplete'),
        2600
      );
    }

    function getAgentActivityKey(activity) {
      return [
        getLanguage(),
        activity.base,
        activity.phase,
        activity.toolName,
        activity.detail
      ].join('|');
    }

    function startAgentStatusRotation() {
      if (agentStatusRotationTimer) {
        return;
      }
      agentStatusRotationTimer = setInterval(function() {
        agentStatusRotationIndex += 1;
        renderStatus();
      }, AGENT_STATUS_ROTATION_MS);
    }

    function stopAgentStatusRotation() {
      if (!agentStatusRotationTimer) {
        return;
      }
      clearInterval(agentStatusRotationTimer);
      agentStatusRotationTimer = 0;
      agentStatusRotationIndex = 0;
    }

    function getAgentActivityStatusText(activity) {
      var keys = getAgentActivityStatusKeys(activity);
      if (!keys.length) {
        return '';
      }
      return t(keys[agentStatusRotationIndex % keys.length]);
    }

    function getAgentActivityStatusKeys(activity) {
      if (activity.base === 'idle') {
        return [];
      }
      if (activity.base === 'complete') {
        return ['agentStatusComplete'];
      }
      if (activity.base === 'error') {
        return ['agentStatusError'];
      }
      if (activity.base === 'stopped') {
        return ['agentStatusStopped'];
      }
      if (activity.base === 'waiting') {
        return agentStatusPools.requesting_model;
      }
      if (activity.base === 'executing') {
        return agentStatusPools[activity.phase] || agentStatusPools[getToolPhaseFromName(activity.toolName)] || agentStatusPools.executing_tool;
      }
      return agentStatusPools[activity.phase] || agentStatusPools.preparing;
    }

    function getToolPhaseFromName(toolName) {
      switch (toolName) {
        case 'keepseek_list_workspace_files':
          return 'listing_files';
        case 'keepseek_list_workspace_directory':
          return 'listing_directory';
        case 'keepseek_search_workspace':
          return 'searching_workspace';
        case 'keepseek_read_workspace_file_range':
          return 'reading_file_range';
        case 'keepseek_read_workspace_file':
          return 'reading_file';
        case 'keepseek_create_draft_edit':
          return 'creating_draft_edit';
        default:
          return 'executing_tool';
      }
    }

    function syncEditingState() {
      if (!editingMessageId) return;
      var message = getMessageById(editingMessageId);
      if (state.isBusy || !message || message.role !== 'user') {
        editingMessageId = '';
        editingDraftText = '';
        pendingEditFocusId = '';
        savedEditRange = null;
        inlineShortcutController.deactivateMark();
        closeEditReferenceMenu(false);
      }
    }

    function getMessageById(messageId) {
      for (var i = 0; i < state.messages.length; i++) {
        if (state.messages[i].id === messageId) {
          return state.messages[i];
        }
      }
      return null;
    }

    function handleMessageAction(button) {
      var action = button.dataset.messageAction || '';
      var messageId = button.dataset.messageId || '';
      var message = getMessageById(messageId);
      if (!message) return;

      if (action === 'copy') {
        copyMessageText(message, button);
        return;
      }

      if (action === 'edit' && message.role === 'user' && !state.isBusy) {
        editingMessageId = message.id;
        editingDraftText = String(message.content || '');
        pendingEditFocusId = message.id;
        savedEditRange = null;
        inlineShortcutController.deactivateMark();
        closeEditReferenceMenu(false);
        render();
        return;
      }

      if (action === 'cancel-edit') {
        cancelEditingMessage();
      }
    }

    function copyMessageText(message, button) {
      var text = String(message.content || '');
      copyTextToClipboard(text).then(function() {
        setTransientStatus(t('copied'));
        showMessageCopyFeedback(button);
      }, function() {
        setTransientStatus(t('copyFailed'));
      });
    }

    function showMessageCopyFeedback(button) {
      if (!button) return;
      button.innerHTML = getCheckIconSvg();
      button.title = t('copied');
      button.setAttribute('aria-label', t('copied'));
      button.classList.add('is-copied');
      button.disabled = true;
      setTimeout(function() {
        if (!button.isConnected) return;
        button.innerHTML = getCopyIconSvg();
        button.title = t('copy');
        button.setAttribute('aria-label', t('copy'));
        button.classList.remove('is-copied');
        button.disabled = state.isBusy;
      }, 1200);
    }

    function copyCodeBlockText(button) {
      var block = button.closest('.message-code-block');
      var code = block ? block.querySelector('code') : null;
      var text = code ? code.textContent || '' : '';
      copyTextToClipboard(text).then(function() {
        setTransientStatus(t('copied'));
        showCodeCopyFeedback(button);
      }, function() {
        setTransientStatus(t('copyFailed'));
      });
    }

    function showCodeCopyFeedback(button) {
      button.innerHTML = getCheckIconSvg();
      button.title = t('copied');
      button.setAttribute('aria-label', t('copied'));
      button.classList.add('is-copied');
      button.disabled = true;
      setTimeout(function() {
        if (!button.isConnected) return;
        button.innerHTML = getCopyIconSvg();
        button.title = t('copy');
        button.setAttribute('aria-label', t('copy'));
        button.classList.remove('is-copied');
        button.disabled = false;
      }, 1200);
    }

    function copyTextToClipboard(text) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
      }

      return new Promise(function(resolve, reject) {
        var textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.setAttribute('readonly', 'true');
        textarea.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0';
        document.body.append(textarea);
        textarea.select();
        try {
          var succeeded = document.execCommand('copy');
          textarea.remove();
          succeeded ? resolve() : reject(new Error('copy failed'));
        } catch (error) {
          textarea.remove();
          reject(error);
        }
      });
    }

    function cancelEditingMessage() {
      editingMessageId = '';
      editingDraftText = '';
      pendingEditFocusId = '';
      savedEditRange = null;
      inlineShortcutController.deactivateMark();
      closeEditReferenceMenu(false);
      render();
    }

    function submitEditedMessage(messageId) {
      if (!messageId || messageId !== editingMessageId || state.isBusy) return;
      var editor = getActiveInlineEditor();
      if (editor) {
        sanitizeInlineEditorContent(editor);
        editingDraftText = serializeInlineEditor(editor);
      }
      var prompt = editingDraftText.trim();
      if (!prompt) {
        setTransientStatus(t('enterContent'));
        return;
      }

      vscode.postMessage({
        type: 'editUserPrompt',
        messageId: messageId,
        prompt: editingDraftText,
        modelId: state.selectedModelId,
        settings: getCurrentAgentSettings(),
        references: editor ? collectInlineEditorFileReferences(editor) : [],
        skillIds: mergeSkillIdsForRequest(
          getActiveSkillIdsForRequest(),
          editor ? collectInlineEditorSkillIds(editor) : []
        )
      });
      editingMessageId = '';
      editingDraftText = '';
      pendingEditFocusId = '';
      savedEditRange = null;
      inlineShortcutController.deactivateMark();
      closeEditReferenceMenu(false);
      render();
    }

    function getCurrentAgentSettings() {
      var configured = state.agentSettings || {};
      return {
        thinkingEnabled: typeof configured.thinkingEnabled === 'boolean' ? configured.thinkingEnabled : true,
        reasoningEffort: configured.reasoningEffort === 'max' ? 'max' : 'high'
      };
    }

    function syncEditReferenceMenuFromEditor(editor) {
      if (!editor || editor.dataset.messageId !== editingMessageId) {
        closeEditReferenceMenu(false);
        return;
      }

      var mention = getEditMentionTrigger(editor);
      if (!mention) {
        closeEditReferenceMenu(false);
        return;
      }

      var previousQuery = editMentionQuery;
      editReferenceEditor = editor;
      editMentionRange = mention.range;
      editMentionQuery = mention.query;
      if (previousQuery !== editMentionQuery) {
        editReferenceIndex = 0;
      }

      if (!editReferenceMenuOpen) {
        openEditReferenceMenu(editor);
        return;
      }

      renderEditReferenceMenu();
    }

    function getEditMentionTrigger(editor) {
      if (document.activeElement !== editor) return null;
      var selection = window.getSelection();
      if (!selection || !selection.rangeCount || !selection.isCollapsed) return null;
      var range = selection.getRangeAt(0);
      if (!isRangeInsideInlineEditor(range, editor)) return null;
      if (range.startContainer.nodeType !== Node.TEXT_NODE) return null;
      var textNode = range.startContainer;
      var textBefore = (textNode.nodeValue || '').slice(0, range.startOffset);
      var triggerIndex = findEditMentionTriggerIndex(textBefore);
      if (triggerIndex < 0) return null;
      var mentionRange = document.createRange();
      mentionRange.setStart(textNode, triggerIndex);
      mentionRange.setEnd(textNode, range.startOffset);
      return {
        range: mentionRange,
        query: textBefore.slice(triggerIndex + 1)
      };
    }

    function findEditMentionTriggerIndex(textBefore) {
      for (var i = textBefore.length - 1; i >= 0; i--) {
        var character = textBefore.charAt(i);
        if (character === '@') {
          return i;
        }
        if (isEditMentionTerminator(character)) {
          return -1;
        }
      }
      return -1;
    }

    function isEditMentionTerminator(character) {
      return character === '<' || character === '>' || character === String.fromCharCode(10) || character === String.fromCharCode(13) || isEditWhitespace(character);
    }

    function isEditWhitespace(value) {
      return /\\s/u.test(String(value || ''));
    }

    function openEditReferenceMenu(editor) {
      closeSessionMenu();
      editReferenceEditor = editor;
      editReferenceMenuOpen = true;
      editReferenceMenu.classList.remove('hidden');
      requestEditReferenceResources();
      renderEditReferenceMenu();
    }

    function closeEditReferenceMenu(restoreFocus) {
      var editor = editReferenceEditor;
      editReferenceMenuOpen = false;
      editReferenceEditor = null;
      editMentionRange = null;
      editMentionQuery = '';
      editReferenceIndex = 0;
      editReferenceMenu.classList.add('hidden');
      editReferenceMenu.classList.remove('is-above');
      editReferenceMenu.innerHTML = '';
      if (restoreFocus && editor) {
        editor.focus();
      }
    }

    function requestEditReferenceResources() {
      if (editReferenceResourcesLoading) return;
      editReferenceResourcesLoading = true;
      editReferenceResourcesError = '';
      editReferenceResourceRequestSequence += 1;
      editReferenceResourceRequestId = 'editReferenceResources:' + editReferenceResourceRequestSequence + ':' + Date.now();
      vscode.postMessage({ type: 'requestReferenceResources', requestId: editReferenceResourceRequestId });
    }

    function handleEditReferenceResourcesMessage(message) {
      if (!editReferenceResourceRequestId || message.requestId !== editReferenceResourceRequestId) {
        return;
      }
      editReferenceResourcesLoading = false;
      editReferenceResourcesLoaded = true;
      editReferenceResourcesError = typeof message.error === 'string' ? message.error : '';
      editReferenceResources = Array.isArray(message.resources) ? message.resources : [];
      renderEditReferenceMenu();
    }

    function renderEditReferenceMenu() {
      if (!editReferenceMenuOpen || !editReferenceEditor) return;
      editReferenceMenu.innerHTML = '';

      var header = document.createElement('div');
      header.className = 'reference-menu-header';
      var title = document.createElement('span');
      title.className = 'reference-menu-title';
      title.textContent = t('referenceFilesTitle');
      var count = document.createElement('span');
      count.className = 'reference-menu-count';
      header.append(title, count);
      editReferenceMenu.append(header);

      if (editReferenceResourcesLoading && !editReferenceResourcesLoaded) {
        count.textContent = t('loading');
        appendEditReferenceMenuNotice(t('loadingWorkspaceFiles'));
        positionEditReferenceMenu();
        return;
      }

      if (editReferenceResourcesError) {
        count.textContent = '0';
        appendEditReferenceMenuNotice(editReferenceResourcesError);
        positionEditReferenceMenu();
        return;
      }

      var resources = getFilteredEditReferenceResources();
      count.textContent = String(resources.length);
      if (!resources.length) {
        appendEditReferenceMenuNotice(editMentionQuery ? t('noMatchingFiles') : t('noReferenceFiles'));
        positionEditReferenceMenu();
        return;
      }

      if (editReferenceIndex >= resources.length) {
        editReferenceIndex = resources.length - 1;
      }
      if (editReferenceIndex < 0) {
        editReferenceIndex = 0;
      }

      var list = document.createElement('div');
      list.className = 'reference-menu-list';
      for (var i = 0; i < resources.length; i++) {
        list.append(createEditReferenceResourceButton(resources[i], i));
      }
      editReferenceMenu.append(list);
      positionEditReferenceMenu();
      scrollActiveEditReferenceIntoView();
    }

    function appendEditReferenceMenuNotice(message) {
      var notice = document.createElement('div');
      notice.className = 'reference-menu-empty';
      notice.textContent = message;
      editReferenceMenu.append(notice);
    }

    function createEditReferenceResourceButton(resource, index) {
      var option = document.createElement('button');
      option.type = 'button';
      option.className = 'reference-menu-item' + (resource.kind === 'directory' ? ' is-directory' : '') + (index === editReferenceIndex ? ' is-active' : '');
      option.dataset.editReferenceIndex = String(index + 1);
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', index === editReferenceIndex ? 'true' : 'false');

      var name = document.createElement('span');
      name.className = 'reference-menu-item-name';
      name.textContent = getEditReferenceResourceName(resource);
      name.title = name.textContent;

      var pathLabel = document.createElement('span');
      pathLabel.className = 'reference-menu-item-path';
      pathLabel.textContent = resource.description || resource.path || '';
      pathLabel.title = pathLabel.textContent;

      option.append(name, pathLabel);
      return option;
    }

    function getFilteredEditReferenceResources() {
      var query = normalizeEditReferenceQuery(editMentionQuery);
      if (!query) {
        return editReferenceResources.slice();
      }
      return editReferenceResources.filter(function(resource) {
        return editReferenceResourceMatchesQuery(resource, query);
      });
    }

    function normalizeEditReferenceQuery(value) {
      return String(value || '').trim().toLocaleLowerCase();
    }

    function getEditReferenceResourceName(resource) {
      var name = resource.label || getMessageFileName(resource.path || '') || 'file';
      return resource.kind === 'directory' && name.charAt(name.length - 1) !== '/' ? name + '/' : name;
    }

    function getEditReferenceResourceSearchName(resource) {
      var name = String(resource.label || '').trim();
      if (!name) {
        name = getEditReferencePathBasename(resource.path || resource.uri || resource.description || '');
      }
      while (name.charAt(name.length - 1) === '/' || name.charAt(name.length - 1) === String.fromCharCode(92)) {
        name = name.slice(0, -1);
      }
      return name || 'file';
    }

    function getEditReferencePathBasename(value) {
      var normalized = String(value || '').trim().split(String.fromCharCode(92)).join('/');
      while (normalized.charAt(normalized.length - 1) === '/') {
        normalized = normalized.slice(0, -1);
      }
      var parts = normalized.split('/');
      return parts[parts.length - 1] || normalized || 'file';
    }

    function editReferenceResourceMatchesQuery(resource, query) {
      var normalizedName = normalizeEditReferenceQuery(getEditReferenceResourceSearchName(resource));
      return normalizedName.indexOf(query) >= 0;
    }

    function moveEditReferenceSelection(delta) {
      var resources = getFilteredEditReferenceResources();
      if (!resources.length) return;
      editReferenceIndex = (editReferenceIndex + delta + resources.length) % resources.length;
      renderEditReferenceMenu();
    }

    function insertActiveEditReferenceResource() {
      insertEditReferenceResourceAtIndex(editReferenceIndex);
    }

    function insertEditReferenceResourceAtIndex(index) {
      var editor = editReferenceEditor;
      var resources = getFilteredEditReferenceResources();
      var resource = resources[index];
      if (!editor || !resource) return;

      var referencePath = resource.path || resource.uri || '';
      if (!referencePath) return;

      var reference = {
        path: referencePath,
        kind: resource.kind === 'directory' ? 'directory' : 'file',
        startLine: 0,
        endLine: 0,
        startColumn: 0,
        endColumn: 0
      };
      var range = editMentionRange && isRangeInsideInlineEditor(editMentionRange, editor)
        ? editMentionRange.cloneRange()
        : getInlineEditorInsertionRange(editor);
      insertInlineReferenceAtRange(editor, range, reference);
      editingDraftText = serializeInlineEditor(editor);
      resizeInlineEditor(editor);
      updateInlineEditorSubmitState(editor.closest('form.message-edit-form'));
      closeEditReferenceMenu(false);
      setTransientStatus(reference.kind === 'directory' ? t('insertedDirectoryReference') : t('insertedFileReference'));
    }

    function scrollActiveEditReferenceIntoView() {
      var active = editReferenceMenu.querySelector('.reference-menu-item.is-active');
      if (active && active.scrollIntoView) {
        active.scrollIntoView({ block: 'nearest' });
      }
    }

    function positionEditReferenceMenu() {
      if (!editReferenceMenuOpen || !editReferenceEditor) return;
      var editorRect = editReferenceEditor.getBoundingClientRect();
      if (editorRect.bottom < 0 || editorRect.top > window.innerHeight) {
        closeEditReferenceMenu(false);
        return;
      }

      var caretRect = getInlineEditorCaretRect(editReferenceEditor, editMentionRange || savedEditRange);
      var margin = 4;
      var maxWidth = Math.max(180, window.innerWidth - margin * 2);
      var menuWidth = Math.min(360, Math.max(220, editorRect.width));
      menuWidth = Math.min(menuWidth, maxWidth);
      editReferenceMenu.style.width = menuWidth + 'px';
      editReferenceMenu.style.maxHeight = Math.min(360, Math.max(120, Math.floor(window.innerHeight * 0.5))) + 'px';

      var menuHeight = editReferenceMenu.offsetHeight || 220;
      var below = window.innerHeight - caretRect.bottom - margin;
      var above = caretRect.top - margin;
      var placeAbove = below < Math.min(menuHeight, 160) && above > below;
      var left = Math.min(Math.max(margin, caretRect.left), window.innerWidth - menuWidth - margin);
      var top = placeAbove ? caretRect.top - menuHeight - 8 : caretRect.bottom + 8;
      top = Math.min(Math.max(margin, top), window.innerHeight - menuHeight - margin);

      editReferenceMenu.style.left = left + 'px';
      editReferenceMenu.style.top = top + 'px';
      editReferenceMenu.style.right = 'auto';
      editReferenceMenu.style.bottom = 'auto';
      editReferenceMenu.classList.toggle('is-above', placeAbove);
    }

    function getInlineEditorCaretRect(editor, sourceRange) {
      try {
        var range = sourceRange && isRangeInsideInlineEditor(sourceRange, editor)
          ? sourceRange.cloneRange()
          : getInlineEditorInsertionRange(editor);
        range.collapse(false);
        var rect = range.getBoundingClientRect();
        if (rect && (rect.width || rect.height)) {
          return rect;
        }

        var marker = document.createElement('span');
        marker.textContent = String.fromCharCode(8203);
        range.insertNode(marker);
        var markerRect = marker.getBoundingClientRect();
        marker.remove();
        return markerRect;
      } catch {
        var fallback = editor.getBoundingClientRect();
        return {
          left: fallback.left,
          top: fallback.bottom,
          bottom: fallback.bottom
        };
      }
    }

    function renderContextChips() {
      var existing = contextBar.querySelectorAll('.context-chip');
      existing.forEach(function(el) { el.remove(); });

      if (contextBarOuter) {
        contextBarOuter.classList.toggle('hidden', !state.contextFiles.length);
      }

      if (!state.contextFiles.length) {
        return;
      }

      for (var i = 0; i < state.contextFiles.length; i++) {
        var file = state.contextFiles[i];
        var chip = document.createElement('span');
        chip.className = 'context-chip';

        var label = document.createElement('span');
        label.className = 'context-chip-label';
        label.textContent = file.label;
        label.title = file.fsPath;

        var remove = document.createElement('button');
        remove.className = 'context-chip-remove';
        remove.type = 'button';
        remove.textContent = '\\\\00d7';
        remove.title = (getLanguage() === 'en' ? 'Remove ' : '移除 ') + file.label;
        remove.dataset.uri = file.uri;

        chip.append(label, remove);
        contextBar.append(chip);
      }
    }

    contextBar.addEventListener('click', function(event) {
      var target = event.target instanceof Element ? event.target : null;
      var removeBtn = target?.closest('.context-chip-remove');
      if (!removeBtn) return;
      event.stopPropagation();
      vscode.postMessage({ type: 'removeContextFile', uri: removeBtn.dataset.uri });
    });

    function getDraftEditAction(edit) {
      var action = edit && edit.action;
      if (action === 'create' || action === 'modify' || action === 'delete' || action === 'move') {
        return action;
      }
      return action ? 'unknown' : 'modify';
    }

    function getDraftEditActionLabel(action) {
      switch (action) {
        case 'create':
          return t('draftActionCreate');
        case 'delete':
          return t('draftActionDelete');
        case 'move':
          return t('draftActionMove');
        case 'modify':
          return t('draftActionModify');
        default:
          return t('draftActionUnknown');
      }
    }

    function getDraftEditActionIcon(action) {
      switch (action) {
        case 'create':
          return '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"/></svg>';
        case 'delete':
          return '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.25 4.5h9.5M6.25 4.5V3.2h3.5v1.3M5 6.25l.45 6.1c.05.8.48 1.15 1.22 1.15h2.66c.74 0 1.17-.35 1.22-1.15l.45-6.1" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        case 'move':
          return '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h9.2M8.8 4.6 12.2 8l-3.4 3.4" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        case 'modify':
          return '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.25 11.95 4 9.2l5.9-5.9a1.45 1.45 0 0 1 2.05 2.05l-5.9 5.9-2.8.7Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="m8.95 4.25 2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>';
        default:
          return '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="4.75" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M8 5.35v3.2" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/><circle cx="8" cy="10.9" r=".65" fill="currentColor"/></svg>';
      }
    }

    function createDraftEditActionIcon(edit) {
      var action = getDraftEditAction(edit);
      var label = getDraftEditActionLabel(action);
      var icon = document.createElement('span');
      icon.className = 'draft-chip-action-icon draft-chip-action-icon-' + action;
      icon.title = label;
      icon.setAttribute('aria-label', label);
      icon.setAttribute('role', 'img');
      icon.innerHTML = getDraftEditActionIcon(action);
      return icon;
    }

    function renderTaskPlan() {
      var repairLoop = state.repairLoop && typeof state.repairLoop === 'object' ? state.repairLoop : null;
      var plan = state.taskPlan && typeof state.taskPlan === 'object'
        ? state.taskPlan
        : createRepairFallbackPlan(repairLoop);
      if (!planRegion || !planToggle || !planBody || !planSteps) return;
      planRegion.classList.toggle('hidden', !plan);
      if (!plan) return;

      var steps = Array.isArray(plan.steps) ? plan.steps : [];
      var completed = steps.filter(function(step) { return step.status === 'completed' || step.status === 'skipped'; }).length;
      var current = steps.find(function(step) { return step.id === plan.currentStepId; });
      planToggle.setAttribute('aria-expanded', planExpanded ? 'true' : 'false');
      planBody.classList.toggle('hidden', !planExpanded);
      planRegion.className = 'plan-region plan-status-' + String(plan.status || 'running') + (planExpanded ? ' is-expanded' : '');
      planSummary.textContent = current ? current.title : getPlanStatusLabel(plan.status);
      planCount.textContent = t('planStepsComplete', { completed: completed, total: steps.length });
      planGoal.textContent = String(plan.goal || '');
      planSteps.innerHTML = '';

      steps.forEach(function(step) {
        var item = document.createElement('li');
        item.className = 'plan-step plan-step-' + String(step.status || 'pending');
        if (step.id === plan.currentStepId) {
          item.setAttribute('aria-current', 'step');
        }
        var marker = document.createElement('span');
        marker.className = 'plan-step-marker';
        marker.setAttribute('aria-hidden', 'true');
        marker.textContent = getPlanStepMarker(step.status);
        var copy = document.createElement('span');
        copy.className = 'plan-step-copy';
        var title = document.createElement('span');
        title.className = 'plan-step-title';
        title.textContent = String(step.title || '');
        copy.append(title);
        if (step.detail) {
          var detail = document.createElement('span');
          detail.className = 'plan-step-detail';
          detail.textContent = String(step.detail);
          copy.append(detail);
        }
        item.append(marker, copy);
        planSteps.append(item);
      });

      renderPlanNote(planBlockers, t('planBlockers'), Array.isArray(plan.blockers) ? plan.blockers.join('\\n') : '');
      renderPlanNote(planCompletion, t('planCompletion'), plan.completionSummary || '');
      if (planContinueRepair) {
        var canContinueRepair = state.repairLoop?.status === 'ready_for_validation' && !state.isBusy && !isBackgroundActive();
        planContinueRepair.classList.toggle('hidden', !canContinueRepair);
        planContinueRepair.disabled = !canContinueRepair;
      }
    }

    function createRepairFallbackPlan(repairLoop) {
      if (!repairLoop || ['waiting_for_apply', 'ready_for_validation', 'running_validation', 'blocked'].indexOf(repairLoop.status) < 0) {
        return null;
      }
      var waiting = repairLoop.status === 'waiting_for_apply';
      var ready = repairLoop.status === 'ready_for_validation';
      var running = repairLoop.status === 'running_validation';
      var blocked = repairLoop.status === 'blocked';
      return {
        goal: t('repairProgressGoal'),
        status: blocked || waiting ? 'blocked' : 'running',
        currentStepId: waiting ? 'repair_wait_apply' : 'repair_validate',
        blockers: waiting ? [t('agentStatusWaitingForApply')] : [],
        steps: [
          {
            id: 'repair_generate',
            title: t('repairIterationLabel', { current: Number(repairLoop.iteration) || 0, max: Number(repairLoop.maxIterations) || 0 }),
            status: 'completed'
          },
          {
            id: 'repair_wait_apply',
            title: t('agentStatusWaitingForApply'),
            status: waiting ? 'blocked' : 'completed'
          },
          {
            id: 'repair_validate',
            title: t('continueRepairValidation'),
            status: blocked ? 'blocked' : running || ready ? 'in_progress' : 'pending'
          }
        ]
      };
    }

    function renderPlanNote(element, label, text) {
      if (!element) return;
      var value = String(text || '').trim();
      element.classList.toggle('hidden', !value);
      element.innerHTML = '';
      if (!value) return;
      var heading = document.createElement('span');
      heading.className = 'plan-note-label';
      heading.textContent = label;
      var content = document.createElement('span');
      content.textContent = value;
      element.append(heading, content);
    }

    function getPlanStatusLabel(statusValue) {
      switch (statusValue) {
        case 'blocked': return t('planStatusBlocked');
        case 'completed': return t('planStatusCompleted');
        case 'failed': return t('planStatusFailed');
        case 'stopped': return t('planStatusStopped');
        default: return t('planStatusRunning');
      }
    }

    function getPlanStepMarker(statusValue) {
      switch (statusValue) {
        case 'completed': return '✓';
        case 'blocked': return '!';
        case 'failed': return '×';
        case 'skipped': return '–';
        case 'in_progress': return '•';
        default: return '';
      }
    }

    function renderDraftEdits() {
      draftList.innerHTML = '';
      var changeSets = Array.isArray(state.changeSets) ? state.changeSets : [];
      draftRegion.classList.toggle('hidden', changeSets.length === 0);

      for (var i = 0; i < changeSets.length; i++) {
        var changeSet = changeSets[i];
        var card = document.createElement('section');
        card.className = 'change-set-card change-set-' + String(changeSet.status || 'pending');

        var header = document.createElement('div');
        header.className = 'change-set-header';
        var heading = document.createElement('div');
        heading.className = 'change-set-heading';
        var title = document.createElement('div');
        title.className = 'change-set-title';
        title.textContent = String(changeSet.operationSummary || t('changeSets'));
        title.title = title.textContent;
        var meta = document.createElement('div');
        meta.className = 'change-set-meta';
        meta.textContent = t('changeSetFiles', { count: Number(changeSet.fileCount) || 0 }) + ' · ' + getChangeSetStatusLabel(changeSet.status);
        heading.append(title, meta);

        var setActions = document.createElement('div');
        setActions.className = 'change-set-actions';
        var files = Array.isArray(changeSet.files) ? changeSet.files : [];
        var applicableFiles = files.filter(function(file) { return file.status === 'pending' || file.status === 'apply_failed'; });
        var revertibleFiles = files.filter(function(file) { return file.status === 'applied' || file.status === 'revert_failed'; });
        if (applicableFiles.length) {
          setActions.append(
            createChangeSetActionButton(t('changeSetApplyAll'), 'applyChangeSet', changeSet.id, false),
            createChangeSetActionButton(t('changeSetDiscardAll'), 'discardChangeSet', changeSet.id, true)
          );
        }
        if (revertibleFiles.length) {
          setActions.append(createChangeSetActionButton(t('revertAgentChange'), 'revertChangeSet', changeSet.id, true));
        }
        header.append(heading, setActions);

        var fileList = document.createElement('div');
        fileList.className = 'change-set-files';
        files.forEach(function(edit) {
          fileList.append(createChangeSetFileRow(edit));
        });
        card.append(header, fileList);
        draftList.append(card);
      }
    }

    function createChangeSetFileRow(edit) {
      var chip = document.createElement('div');
      chip.className = 'draft-chip draft-chip-' + String(edit.status || 'pending');
      var content = document.createElement('div');
      content.className = 'draft-chip-content';
      var main = document.createElement('div');
      main.className = 'draft-chip-main';
      var label = document.createElement('span');
      label.className = 'draft-chip-label';
      label.textContent = String(edit.label || '');
      label.title = String(edit.reason || '');
      main.append(createDraftEditActionIcon(edit), label);
      var details = document.createElement('div');
      details.className = 'draft-chip-details';
      details.textContent = getChangeFileStatusLabel(edit.status) + (edit.reason ? ' · ' + edit.reason : '');
      content.append(main, details);
      if (edit.error) {
        var error = document.createElement('div');
        error.className = 'draft-chip-error';
        error.textContent = String(edit.error);
        content.append(error);
      }

      var actions = document.createElement('div');
      actions.className = 'draft-chip-actions';
      if (edit.status !== 'discarded') {
        actions.append(createEditActionButton(t('previewDiff'), 'openDraftDiff', edit.id, true));
      }
      if (edit.status === 'pending' || edit.status === 'apply_failed') {
        actions.append(
          createEditActionButton(t('apply'), 'applyDraftEdit', edit.id, false),
          createEditActionButton(t('discard'), 'discardDraftEdit', edit.id, true)
        );
      } else if (edit.status === 'applied' || edit.status === 'revert_failed') {
        actions.append(createEditActionButton(t('revert'), 'revertDraftEdit', edit.id, true));
      }
      chip.append(content, actions);
      return chip;
    }

    function createEditActionButton(label, action, id, secondary) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.className = secondary ? 'secondary' : '';
      button.dataset.editId = id;
      button.dataset.editAction = action;
      button.disabled = (state.isBusy && action !== 'openDraftDiff') || pendingChangeActions.has(action + ':' + id);
      return button;
    }

    function createChangeSetActionButton(label, action, id, secondary) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.className = secondary ? 'secondary' : '';
      button.dataset.changeSetId = id;
      button.dataset.changeSetAction = action;
      button.disabled = state.isBusy || pendingChangeActions.has(action + ':' + id);
      return button;
    }

    function getChangeSetStatusLabel(statusValue) {
      switch (statusValue) {
        case 'partially_applied': return t('changeSetStatusPartiallyApplied');
        case 'applied': return t('changeSetStatusApplied');
        case 'partially_failed': return t('changeSetStatusPartiallyFailed');
        case 'reverted': return t('changeSetStatusReverted');
        default: return t('changeSetStatusPending');
      }
    }

    function getChangeFileStatusLabel(statusValue) {
      switch (statusValue) {
        case 'applied': return t('changeFileStatusApplied');
        case 'discarded': return t('changeFileStatusDiscarded');
        case 'apply_failed': return t('changeFileStatusApplyFailed');
        case 'reverted': return t('changeFileStatusReverted');
        case 'revert_failed': return t('changeFileStatusRevertFailed');
        default: return t('changeFileStatusPending');
      }
    }

    function renderTranscript() {
      var shouldStick = transcript.scrollTop + transcript.clientHeight >= transcript.scrollHeight - 24;
      transcript.innerHTML = '';

      if (!state.messages.length) {
        var empty = document.createElement('div');
        empty.className = 'transcript-empty';
        var icon = document.createElement('div');
        icon.className = 'transcript-empty-icon';
        if (keepseekLogoUri) {
          var logo = document.createElement('img');
          logo.src = keepseekLogoUri;
          logo.alt = '';
          logo.setAttribute('aria-hidden', 'true');
          icon.append(logo);
        } else {
          icon.textContent = '\\\\2726';
        }
        var line1 = document.createElement('div');
        line1.textContent = t('startChat');
        var line2 = document.createElement('div');
        line2.style.cssText = 'font-size:11px;opacity:0.6';
        line2.textContent = t('emptyTranscriptHint');
        empty.append(icon, line1, line2);
        transcript.append(empty);
      }

      for (var i = 0; i < state.messages.length; i++) {
        var message = state.messages[i];
        var item = document.createElement('article');
        var isEditing = message.role === 'user' && message.id === editingMessageId;
        item.className = 'message ' + message.role + (isEditing ? ' is-editing' : '') + (message.isStreaming ? ' is-streaming' : '');
        item.dataset.messageId = message.id;

        var body = document.createElement('div');
        body.className = 'message-body';

        var role = document.createElement('div');
        role.className = 'message-role';
        role.textContent = message.role === 'user' ? t('you') : 'KeepSeek';

        body.append(role);
        if (message.role === 'assistant' && message.reasoningContent) {
          var reasoning = document.createElement('details');
          reasoning.className = 'reasoning-block';
          reasoning.open = Boolean(message.isStreaming);
          var summary = document.createElement('summary');
          summary.textContent = message.isStreaming ? t('thinkingLive') : t('thinkingLabel');
          var reasoningContent = document.createElement('pre');
          reasoningContent.setAttribute('aria-live', message.isStreaming ? 'polite' : 'off');
          reasoningContent.textContent = message.reasoningContent;
          reasoning.append(summary, reasoningContent);
          body.append(reasoning);
        }
        if (message.role === 'assistant' && Array.isArray(message.usedSkills) && message.usedSkills.length) {
          body.append(createUsedSkillsNotice(message.usedSkills));
        }

        if (isEditing) {
          body.append(createInlineMessageEditor(message));
        } else {
          var shouldShowStreamingPlaceholder = message.role === 'assistant' && message.isStreaming && !message.content && !message.reasoningContent;
          var shouldRenderContent = message.role !== 'assistant' || message.content || shouldShowStreamingPlaceholder || !message.isStreaming;
          if (shouldRenderContent) {
            var content = document.createElement('div');
            content.className = 'message-content' + (shouldShowStreamingPlaceholder ? ' is-placeholder' : '');
            if (shouldShowStreamingPlaceholder) {
              content.textContent = t('processing');
            } else {
              renderMarkdownContent(content, message.content, message.role !== 'assistant', {
                compactReferenceLinks: message.role === 'user'
              });
            }
            body.append(content);
          }
          if (message.role === 'user') {
            body.append(createUserMessageActions(message));
          } else if (message.role === 'assistant' && !message.isStreaming && String(message.content || '').length > 0) {
            body.append(createAssistantMessageActions(message));
          }
        }

        if (message.role === 'assistant' && !message.isStreaming && message.runDetails) {
          body.append(createRunDetailsPanel(message));
        }

        item.append(body);
        transcript.append(item);
      }

      if (shouldStick) {
        transcript.scrollTop = transcript.scrollHeight;
      }
    }

    function createRunDetailsPanel(message) {
      var details = message.runDetails || {};
      var panel = document.createElement('details');
      panel.className = 'run-details';
      var summary = document.createElement('summary');
      summary.textContent = t('runDetailsSummary', {
        status: getRunStatusLabel(details.status),
        duration: formatDuration(details.durationMs)
      });
      var body = document.createElement('div');
      body.className = 'run-details-body';
      var grid = document.createElement('div');
      grid.className = 'run-details-grid';
      appendRunDetailRow(grid, t('runDetailsModel'), details.modelId || '—');
      appendRunDetailRow(grid, t('runDetailsStarted'), formatDateTime(details.startedAt));
      appendRunDetailRow(grid, t('runDetailsEnded'), formatDateTime(details.endedAt));
      appendRunDetailRow(grid, t('runDetailsStatus'), getRunStatusLabel(details.status));
      appendRunDetailRow(grid, t('runDetailsRequests'), [
        String(details.modelRequests?.requestCount || 0),
        'messages=' + String(details.modelRequests?.messageCount || 0),
        'tools=' + String(details.modelRequests?.exposedToolCount || 0),
        details.modelRequests?.maxOutputTokens ? 'max=' + String(details.modelRequests.maxOutputTokens) : ''
      ].filter(Boolean).join(' · '));
      appendRunDetailRow(grid, t('runDetailsTools'), String(Number(details.toolCallCount) || (Array.isArray(details.toolCalls) ? details.toolCalls.length : 0)));
      body.append(grid);

      var contextSources = Array.isArray(details.contextSources) ? details.contextSources : [];
      var projectInstructions = contextSources.filter(function(source) { return source.kind === 'project-instructions'; });
      var activatedSkills = contextSources.filter(function(source) { return source.kind === 'skill'; });
      var legacyMemory = contextSources.filter(function(source) { return source.kind === 'legacy-memory'; });
      if (projectInstructions.length) {
        body.append(createRunTextSection(t('runDetailsProjectInstructions'), projectInstructions.map(formatRunContextSource)));
      }
      if (activatedSkills.length) {
        body.append(createRunTextSection(t('runDetailsSkills'), activatedSkills.map(formatRunContextSource)));
      }
      if (legacyMemory.length) {
        body.append(createRunTextSection(t('runDetailsLegacyMemory'), legacyMemory.map(formatRunContextSource)));
      }
      if (details.contextDeduplication) {
        var discardedContext = Array.isArray(details.contextDiscarded) ? details.contextDiscarded : [];
        body.append(createRunTextSection(t('runDetailsContextDedup'), [[
          String(details.contextDeduplication.before || 0) + ' → ' + String(details.contextDeduplication.after || 0),
          'discarded=' + String(details.contextDeduplication.discarded || 0),
          details.contextDeduplication.truncated ? t('runDetailsTruncated') : ''
        ].filter(Boolean).join(' · ')].concat(discardedContext.map(function(source) {
          return [source.kind, source.id, source.reason, source.uri || '', source.keptId ? 'kept=' + source.keptId : '']
            .filter(Boolean).join(' · ');
        }))));
      }

      if (details.taskPlan) {
        body.append(createRunTextSection(t('runDetailsTaskPlan'), [
          details.taskPlan.goal,
          t('runDetailsPlanProgress', {
            completed: details.taskPlan.completedSteps || 0,
            total: details.taskPlan.totalSteps || 0,
            updates: details.taskPlan.updateCount || 0
          }),
          ...(Array.isArray(details.taskPlan.blockers) ? details.taskPlan.blockers : [])
        ].filter(Boolean)));
      }
      if (details.budgetStopReason) {
        body.append(createRunTextSection(t('runDetailsBudgetStop'), [details.budgetStopReason], 'run-details-error'));
      }
      if (details.failureReason) {
        body.append(createRunTextSection(t('runDetailsFailure'), [details.failureReason], 'run-details-error'));
      }

      var toolCalls = Array.isArray(details.toolCalls) ? details.toolCalls.slice(0, 40) : [];
      if (toolCalls.length) {
        var toolSection = createRunSection(t('runDetailsToolCalls'));
        toolCalls.forEach(function(tool) {
          var item = document.createElement('div');
          item.className = 'run-details-tool' + (tool.status === 'denied' ? ' run-details-denied' : tool.status === 'failed' ? ' run-details-error' : '');
          var title = document.createElement('div');
          title.textContent = String(tool.name || 'tool') + ' · ' + getRunToolStatusLabel(tool.status) + ' · ' + formatDuration(tool.durationMs);
          item.append(title);
          if (tool.argumentsSummary) item.append(createRunDetailText(t('runDetailsArguments') + ': ' + tool.argumentsSummary));
          if (tool.resultSummary) item.append(createRunDetailText(t('runDetailsResult') + ': ' + tool.resultSummary));
          if (tool.truncated) item.append(createRunDetailText(t('runDetailsTruncated')));
          toolSection.append(item);
        });
        if ((details.toolCalls || []).length > toolCalls.length || details.truncated) {
          toolSection.append(createRunDetailText(t('runDetailsTruncated')));
        }
        body.append(toolSection);
      }

      if (Array.isArray(details.validations) && details.validations.length) {
        var validations = details.validations.map(function(validation) {
          return [validation.script || 'validation', validation.ok === true ? t('passed') : validation.ok === false ? t('failed') : '',
            typeof validation.exitCode === 'number' ? 'exit=' + validation.exitCode : '',
            typeof validation.errors === 'number' ? 'errors=' + validation.errors : '',
            validation.error || ''].filter(Boolean).join(' · ');
        });
        body.append(createRunTextSection(t('runDetailsValidation'), validations));
      }

      if (Array.isArray(details.authorizations) && details.authorizations.length) {
        var authorizations = details.authorizations.map(function(record) {
          return [record.toolName, record.allowed ? t('allowed') : t('denied'), record.scope, record.source, record.reason].filter(Boolean).join(' · ');
        });
        body.append(createRunTextSection(t('runDetailsAuthorization'), authorizations,
          details.authorizations.some(function(record) { return !record.allowed; }) ? 'run-details-denied' : ''));
      }

      if (Array.isArray(details.changeSets) && details.changeSets.length) {
        var changes = details.changeSets.map(function(changeSet) {
          return [changeSet.fileCount + ' ' + t('files'), getChangeSetStatusLabel(changeSet.status),
            Array.isArray(changeSet.labels) ? changeSet.labels.join(', ') : '',
            changeSet.appliedCount ? t('runDetailsAppliedCount', { count: changeSet.appliedCount }) : '',
            changeSet.failedCount ? t('runDetailsFailedCount', { count: changeSet.failedCount }) : ''].filter(Boolean).join(' · ');
        });
        body.append(createRunTextSection(t('runDetailsChangeSets'), changes));
      }

      var actions = document.createElement('div');
      actions.className = 'run-details-actions';
      actions.append(
        createRunActionButton(message.id, 'copySummary', t('runDetailsCopy')),
        createRunActionButton(message.id, 'openTrace', t('runDetailsOpenTrace'), !details.traceLogUri)
      );
      body.append(actions);
      panel.append(summary, body);
      return panel;
    }

    function appendRunDetailRow(grid, label, value) {
      var labelElement = document.createElement('div');
      labelElement.className = 'run-details-label';
      labelElement.textContent = label;
      var valueElement = document.createElement('div');
      valueElement.textContent = value || '—';
      grid.append(labelElement, valueElement);
    }

    function createRunSection(titleText) {
      var section = document.createElement('div');
      section.className = 'run-details-section';
      var title = document.createElement('div');
      title.className = 'run-details-section-title';
      title.textContent = titleText;
      section.append(title);
      return section;
    }

    function createRunTextSection(title, lines, className) {
      var section = createRunSection(title);
      if (className) section.classList.add(className);
      lines.slice(0, 20).forEach(function(line) { section.append(createRunDetailText(String(line))); });
      return section;
    }

    function createRunDetailText(text) {
      var element = document.createElement('div');
      element.textContent = text;
      return element;
    }

    function formatRunContextSource(source) {
      return [
        source.label || source.id || '',
        source.source || '',
        source.activation || '',
        source.reason || '',
        source.uri || '',
        String(Number(source.characterCount) || 0) + ' chars',
        String(Number(source.tokenEstimate) || 0) + ' tokens',
        source.scriptsPresent ? t('skillsScriptsPresent') : '',
        source.truncated ? t('runDetailsTruncated') : ''
      ].filter(Boolean).join(' · ');
    }

    function createRunActionButton(messageId, action, label, disabled) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'secondary';
      button.dataset.runAction = action;
      button.dataset.messageId = messageId;
      button.textContent = label;
      button.disabled = Boolean(disabled);
      return button;
    }

    function getRunStatusLabel(statusValue) {
      var key = 'runStatus_' + String(statusValue || 'failed');
      var value = t(key);
      return value === key ? String(statusValue || '') : value;
    }

    function getRunToolStatusLabel(statusValue) {
      var key = 'runToolStatus_' + String(statusValue || 'running');
      var value = t(key);
      return value === key ? String(statusValue || '') : value;
    }

    function formatDuration(value) {
      var duration = Number(value);
      if (!Number.isFinite(duration) || duration < 0) return '—';
      if (duration < 1000) return Math.round(duration) + ' ms';
      return (duration / 1000).toFixed(duration < 10000 ? 1 : 0) + ' s';
    }

    function formatDateTime(value) {
      var timestamp = Date.parse(value || '');
      return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString(getLanguage() === 'en' ? 'en' : 'zh-CN') : '—';
    }

    function formatRunDetailsSummary(details) {
      var lines = [
        'KeepSeek Run ' + String(details.runId || ''),
        t('runDetailsModel') + ': ' + String(details.modelId || ''),
        t('runDetailsStatus') + ': ' + getRunStatusLabel(details.status),
        t('runDetailsStarted') + ': ' + formatDateTime(details.startedAt),
        t('runDetailsEnded') + ': ' + formatDateTime(details.endedAt),
        t('runDetailsTools') + ': ' + String(Number(details.toolCallCount) || (Array.isArray(details.toolCalls) ? details.toolCalls.length : 0))
      ];
      if (details.taskPlan?.goal) lines.push(t('runDetailsTaskPlan') + ': ' + details.taskPlan.goal);
      var contextSources = Array.isArray(details.contextSources) ? details.contextSources : [];
      contextSources.forEach(function(source) {
        var label = source.kind === 'project-instructions'
          ? t('runDetailsProjectInstructions')
          : source.kind === 'skill' ? t('runDetailsSkills') : t('runDetailsLegacyMemory');
        lines.push(label + ': ' + formatRunContextSource(source));
      });
      if (details.contextDeduplication) {
        lines.push(t('runDetailsContextDedup') + ': ' + [
          String(details.contextDeduplication.before || 0) + ' → ' + String(details.contextDeduplication.after || 0),
          'discarded=' + String(details.contextDeduplication.discarded || 0),
          details.contextDeduplication.truncated ? 'truncated' : ''
        ].filter(Boolean).join(' · '));
      }
      (details.contextDiscarded || []).slice(0, 80).forEach(function(source) {
        lines.push('- ' + [source.kind, source.id, source.reason, source.uri, source.keptId ? 'kept=' + source.keptId : '']
          .filter(Boolean).join(' · '));
      });
      if (details.budgetStopReason) lines.push(t('runDetailsBudgetStop') + ': ' + details.budgetStopReason);
      if (details.failureReason) lines.push(t('runDetailsFailure') + ': ' + details.failureReason);
      (details.toolCalls || []).slice(0, 40).forEach(function(tool) {
        lines.push('- ' + [tool.name, getRunToolStatusLabel(tool.status), tool.argumentsSummary, tool.resultSummary].filter(Boolean).join(' · '));
      });
      return lines.join('\\n');
    }

    function createUsedSkillsNotice(usedSkills) {
      var names = [];
      var seen = new Set();
      usedSkills.forEach(function(skill) {
        var name = String(skill && (skill.name || skill.id) || '').trim();
        if (!name || seen.has(name)) { return; }
        seen.add(name);
        names.push(name);
      });
      var notice = document.createElement('div');
      notice.className = 'message-skill-usage';
      notice.textContent = t(names.length === 1 ? 'usedSkill' : 'usedSkills', {
        skills: names.join(' · ')
      });
      return notice;
    }

    function createUserMessageActions(message) {
      var actions = document.createElement('div');
      actions.className = 'message-actions';

      actions.append(
        createMessageActionButton(message, 'copy', t('copy'), getCopyIconSvg()),
        createMessageActionButton(message, 'edit', t('editAndResend'), '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.25 11.95 4 9.2l5.9-5.9a1.45 1.45 0 0 1 2.05 2.05l-5.9 5.9-2.8.7Z" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round"/><path d="m8.95 4.25 2.8 2.8" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>')
      );

      return actions;
    }

    function createAssistantMessageActions(message) {
      var actions = document.createElement('div');
      actions.className = 'message-actions';

      actions.append(
        createMessageActionButton(message, 'copy', t('copy'), getCopyIconSvg())
      );

      return actions;
    }

    function createMessageActionButton(message, action, label, icon) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'message-action-btn';
      button.dataset.messageAction = action;
      button.dataset.messageId = message.id;
      button.title = label;
      button.setAttribute('aria-label', label);
      button.disabled = state.isBusy;
      button.innerHTML = icon;
      return button;
    }

    function getActiveInlineEditor() {
      if (!editingMessageId) return null;
      var editor = transcript.querySelector('.message.is-editing .message-edit-input');
      return editor && editor.dataset.messageId === editingMessageId ? editor : null;
    }

    function refreshInlineEditorAfterEdit(editor) {
      if (!editor) return;
      sanitizeInlineEditorContent(editor);
      if (editor.dataset.messageId === editingMessageId) {
        editingDraftText = serializeInlineEditor(editor);
      }
      resizeInlineEditor(editor);
      updateInlineEditorSubmitState(editor.closest('form.message-edit-form'));
      saveEditSelection(editor);
      syncEditReferenceMenuFromEditor(editor);
    }

    function saveEditSelection(editor) {
      if (!editor || !isSelectionInsideInlineEditor(editor)) return;
      var selection = window.getSelection();
      if (!selection || !selection.rangeCount) return;
      var range = selection.getRangeAt(0);
      if (!isRangeInsideInlineEditor(range, editor)) return;
      savedEditRange = range.cloneRange();
    }

    function isSelectionInsideInlineEditor(editor) {
      var selection = window.getSelection();
      if (!selection || !selection.rangeCount) return false;
      return isRangeInsideInlineEditor(selection.getRangeAt(0), editor);
    }

    function isRangeInsideInlineEditor(range, editor) {
      return Boolean(editor && isNodeInsideInlineEditor(range.commonAncestorContainer, editor));
    }

    function isNodeInsideInlineEditor(node, editor) {
      if (!node || !editor) return false;
      if (node === editor) return true;
      return editor.contains(node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode);
    }

    function renderInlineEditorContent(editor, value) {
      editor.innerHTML = '';
      var text = String(value || '');
      var pattern = /\\[\\$([A-Za-z0-9_-]+)\\]\\(([^)\\n]+)\\)|<([^<>\\n]+)>|\\$([A-Za-z0-9_-]+)/g;
      var cursor = 0;
      var match;

      while ((match = pattern.exec(text)) !== null) {
        var matchText = match[0] || '';
        if (isOffsetInsideMarkdownFence(text, match.index)) {
          continue;
        }
        if (match[1] || matchText.charAt(0) === '$') {
          if (match.index < cursor) {
            continue;
          }
          var skill = match[1]
            ? getSkillByMarkdownReferenceForView(match[1] || '', match[2] || '')
            : getSkillByMentionNameForView(match[4] || '');
          if (!skill) {
            continue;
          }
          appendInlineEditorText(editor, text.slice(cursor, match.index));
          editor.append(createInlineSkillLink(skill));
          cursor = match.index + matchText.length;
          continue;
        }
        var target = (match[3] || '').trim();
        var reference = parseMessageFileReference(target);
        if (!reference) {
          continue;
        }

        var matchEnd = match.index + match[0].length;
        var label = getMessageReferenceLabel(text, match.index, reference);
        if (!label || label.start < cursor || !isStandaloneMessageReferenceLine(text, label.start, matchEnd)) {
          continue;
        }

        appendInlineEditorText(editor, text.slice(cursor, label.start));
        editor.append(createInlineReferenceLink(reference));
        cursor = matchEnd;
      }

      appendInlineEditorText(editor, text.slice(cursor));
      sanitizeInlineEditorContent(editor);
    }

    function appendInlineEditorText(editor, text) {
      if (!text) return;
      editor.append(document.createTextNode(text));
    }

    function createInlineReferenceLink(reference) {
      return reference.kind === 'directory'
        ? createInlineDirectoryReferenceLink(reference)
        : createInlineFileReferenceLink(reference);
    }

    function createInlineFileReferenceLink(reference) {
      return createReferenceLinkElement(reference, { kind: 'file' });
    }

    function createInlineDirectoryReferenceLink(reference) {
      return createReferenceLinkElement(reference, { kind: 'directory' });
    }

    function createInlineSkillLink(skill) {
      var anchor = document.createElement('a');
      anchor.className = 'rich-skill-link';
      anchor.setAttribute('href', getSkillPathForView(skill));
      anchor.setAttribute('contenteditable', 'false');
      anchor.draggable = false;
      anchor.title = skill.description || skill.name || skill.id;
      anchor.textContent = getSkillPromptTextForView(skill);
      anchor.dataset.skillId = skill.id;
      anchor.dataset.skillPath = getSkillPathForView(skill);
      return anchor;
    }

    function sanitizeInlineEditorContent(editor) {
      sanitizeInlineEditorFormatting(editor, editor);
      sanitizeInlineEditorLinks(editor);
    }

    function sanitizeInlineEditorFormatting(root, node) {
      var child = node.firstChild;
      while (child) {
        var next = child.nextSibling;
        if (child.nodeType === Node.COMMENT_NODE) {
          child.remove();
          child = next;
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) {
          child = next;
          continue;
        }

        var element = child;
        if (element.matches('a.rich-file-link') || element.matches('a.rich-skill-link')) {
          child = next;
          continue;
        }
        if (element.tagName === 'BR') {
          clearInlineEditorElementAttributes(element);
          child = next;
          continue;
        }
        if (element !== root && isInlineEditorBlockElement(element)) {
          clearInlineEditorElementAttributes(element);
          sanitizeInlineEditorFormatting(root, element);
          child = next;
          continue;
        }

        sanitizeInlineEditorFormatting(root, element);
        unwrapInlineEditorFormattingElement(element);
        child = next;
      }
    }

    function clearInlineEditorElementAttributes(element) {
      while (element.attributes.length) {
        element.removeAttribute(element.attributes[0].name);
      }
    }

    function unwrapInlineEditorFormattingElement(element) {
      var parent = element.parentNode;
      if (!parent) return;
      while (element.firstChild) {
        parent.insertBefore(element.firstChild, element);
      }
      parent.removeChild(element);
    }

    function sanitizeInlineEditorLinks(editor) {
      var links = editor.querySelectorAll('a.rich-file-link');
      links.forEach(function(link) {
        if (link.dataset.kind === 'directory') {
          var directoryPath = link.dataset.path || '';
          var directoryHref = makeMessageDirectoryHref({ path: directoryPath });
          link.className = 'rich-file-link rich-directory-link';
          link.setAttribute('href', directoryHref);
          link.setAttribute('contenteditable', 'false');
          link.draggable = false;
          renderFileReferenceLinkLabel(link, { path: directoryPath, kind: 'directory', startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 });
          link.dataset.startLine = '0';
          link.dataset.endLine = '0';
          link.dataset.startColumn = '0';
          link.dataset.endColumn = '0';
          return;
        }
        var startLine = readReferenceInteger(link.dataset.startLine, 0);
        var endLine = startLine === 0 ? 0 : Math.max(startLine, readReferenceInteger(link.dataset.endLine, startLine));
        var startColumn = readReferenceInteger(link.dataset.startColumn, 0);
        var endColumn = readReferenceInteger(link.dataset.endColumn, 0);
        var reference = {
          path: link.dataset.path || '',
          startLine: startLine,
          endLine: endLine,
          startColumn: startColumn,
          endColumn: endColumn
        };
        link.className = 'rich-file-link';
        link.dataset.kind = 'file';
        link.setAttribute('href', makeMessageFileHref(reference));
        link.setAttribute('contenteditable', 'false');
        link.draggable = false;
        renderFileReferenceLinkLabel(link, reference);
      });
      var skillLinks = editor.querySelectorAll('a.rich-skill-link');
      skillLinks.forEach(function(link) {
        var skillId = link.dataset.skillId || '';
        var skill = getSkillByIdForView(skillId);
        link.className = 'rich-skill-link';
        link.setAttribute('contenteditable', 'false');
        link.draggable = false;
        if (skill) {
          link.setAttribute('href', getSkillPathForView(skill));
          link.dataset.skillPath = getSkillPathForView(skill);
          link.textContent = getSkillPromptTextForView(skill);
          link.title = skill.description || skill.name || skill.id;
        } else {
          link.setAttribute('href', link.dataset.skillPath || link.getAttribute('href') || '');
        }
      });
    }

    function serializeInlineEditor(editor) {
      var parts = [];
      appendInlineEditorNode(editor, editor, parts);
      return trimInlineEditorText(parts.join(''));
    }

    function appendInlineEditorNode(root, node, parts) {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.nodeValue || '');
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;

      var element = node;
      if (element.matches('a.rich-file-link')) {
        parts.push(inlineFileReferenceLinkToText(element));
        return;
      }
      if (element.matches('a.rich-skill-link')) {
        parts.push(inlineSkillLinkToText(element));
        return;
      }
      if (element.tagName === 'BR') {
        parts.push(String.fromCharCode(10));
        return;
      }

      var isBlock = element !== root && isInlineEditorBlockElement(element);
      if (isBlock && parts.length && !inlinePartsEndWithLineBreak(parts)) {
        parts.push(String.fromCharCode(10));
      }

      var child = element.firstChild;
      while (child) {
        appendInlineEditorNode(root, child, parts);
        child = child.nextSibling;
      }

      if (isBlock && !inlinePartsEndWithLineBreak(parts)) {
        parts.push(String.fromCharCode(10));
      }
    }

    function inlineFileReferenceLinkToText(link) {
      var reference = readInlineFileReferenceLink(link);
      if (reference.kind === 'directory') {
        var directoryLabel = getMessageDirectoryName(reference.path);
        return makeStandaloneInlineReferenceText(directoryLabel + ' <' + makeMessageDirectoryHref(reference) + '>');
      }
      if (reference.startLine > 0 && reference.endLine < reference.startLine) {
        reference.endLine = reference.startLine;
      }
      return makeStandaloneInlineReferenceText(formatFileReferenceTextLabel(reference) + String.fromCharCode(10) + '<' + makeMessageFileHref(reference) + '>');
    }

    function inlineSkillLinkToText(link) {
      var skill = getSkillByIdForView(link.dataset.skillId || '');
      if (skill) {
        return getSkillMarkdownTextForView(skill);
      }
      var text = String(link.textContent || '').trim();
      var label = text.charAt(0) === '$' ? text : '$' + text;
      var skillPath = String(link.dataset.skillPath || link.getAttribute('href') || '').trim();
      return skillPath ? '[' + label + '](' + skillPath + ')' : label;
    }

    function makeStandaloneInlineReferenceText(text) {
      var lineBreak = String.fromCharCode(10);
      return lineBreak + text + lineBreak;
    }

    function collectInlineEditorFileReferences(editor) {
      var references = [];
      if (!editor) return references;
      var links = editor.querySelectorAll('a.rich-file-link');
      links.forEach(function(link) {
        var reference = readInlineFileReferenceLink(link);
        if (reference.path) {
          references.push(reference);
        }
      });
      return references;
    }

    function collectInlineEditorSkillIds(editor) {
      return [];
    }

    function readInlineFileReferenceLink(link) {
      var kind = link.dataset.kind === 'directory' ? 'directory' : 'file';
      return {
        path: link.dataset.path || '',
        kind: kind,
        startLine: readReferenceInteger(link.dataset.startLine, 0),
        endLine: readReferenceInteger(link.dataset.endLine, 0),
        startColumn: readReferenceInteger(link.dataset.startColumn, 0),
        endColumn: readReferenceInteger(link.dataset.endColumn, 0)
      };
    }

    function isInlineEditorBlockElement(element) {
      var tag = element.tagName;
      return tag === 'DIV' || tag === 'P' || tag === 'LI' || tag === 'UL' || tag === 'OL';
    }

    function inlinePartsEndWithLineBreak(parts) {
      if (!parts.length) return false;
      var last = parts[parts.length - 1];
      return last.charAt(last.length - 1) === String.fromCharCode(10);
    }

    function trimInlineEditorText(value) {
      var text = String(value || '');
      while (text.length && isEditWhitespace(text.charAt(0))) {
        text = text.slice(1);
      }
      while (text.length && isEditWhitespace(text.charAt(text.length - 1))) {
        text = text.slice(0, -1);
      }
      return text;
    }

    function getInlineEditorInsertionRange(editor) {
      if (savedEditRange && isRangeInsideInlineEditor(savedEditRange, editor)) {
        return savedEditRange.cloneRange();
      }
      return getInlineEditorEndRange(editor);
    }

    function getInlineEditorEndRange(editor) {
      var range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      return range;
    }

    function setInlineEditorSelectionRange(editor, range) {
      var selection = window.getSelection();
      if (!selection || !range || !isRangeInsideInlineEditor(range, editor)) return;
      selection.removeAllRanges();
      selection.addRange(range);
      savedEditRange = range.cloneRange();
    }

    function insertInlineReferenceAtRange(editor, range, reference) {
      var fragment = document.createDocumentFragment();
      if (isInlineEditorRangeInsideMarkdownFence(editor, range)) {
        appendInlineReferenceBoundarySpace(fragment);
        fragment.append(document.createTextNode(referenceToInlinePlainText(reference)));
        appendInlineReferenceBoundarySpace(fragment);
        insertInlineFragmentAtRange(editor, range, fragment);
        return;
      }
      appendInlineReferenceBoundarySpace(fragment);
      fragment.append(createInlineReferenceLink(reference));
      appendInlineReferenceBoundarySpace(fragment);
      insertInlineFragmentAtRange(editor, range, fragment);
    }

    function appendInlineReferenceBoundarySpace(fragment) {
      fragment.append(document.createTextNode(' '));
    }

    function referenceToInlinePlainText(reference) {
      return '<' + (reference.kind === 'directory' ? makeMessageDirectoryHref(reference) : makeMessageFileHref(reference)) + '>';
    }

    function insertInlineFragmentAtRange(editor, range, fragment) {
      inlineShortcutController.deactivateMark();
      var workingRange = range && isRangeInsideInlineEditor(range, editor) ? range.cloneRange() : getInlineEditorEndRange(editor);
      workingRange.deleteContents();
      var tail = document.createTextNode('');
      fragment.append(tail);
      workingRange.insertNode(fragment);
      var nextRange = document.createRange();
      nextRange.setStartAfter(tail);
      nextRange.collapse(true);
      setInlineEditorSelectionRange(editor, nextRange);
      editor.focus();
      editingDraftText = serializeInlineEditor(editor);
    }

    function insertInlinePlainText(editor, text) {
      var lineBreak = String.fromCharCode(10);
      var normalized = String(text || '')
        .split(String.fromCharCode(13) + lineBreak).join(lineBreak)
        .split(String.fromCharCode(13)).join(lineBreak);
      if (!normalized) return;

      var lines = normalized.split(lineBreak);
      var fragment = document.createDocumentFragment();
      for (var i = 0; i < lines.length; i++) {
        if (i > 0) {
          fragment.append(document.createElement('br'));
        }
        fragment.append(document.createTextNode(lines[i]));
      }

      insertInlineFragmentAtRange(editor, getInlineEditorInsertionRange(editor), fragment);
    }

    function getInlineEditorTextBeforeRange(editor, range) {
      var clone = range.cloneRange();
      clone.selectNodeContents(editor);
      clone.setEnd(range.startContainer, range.startOffset);
      return clone.toString();
    }

    function isInlineEditorRangeInsideMarkdownFence(editor, range) {
      return isMarkdownFenceOpenAtTextEnd(getInlineEditorTextBeforeRange(editor, range));
    }

    function insertFileReferenceIntoActiveEditor(message) {
      var editor = getActiveInlineEditor();
      if (!editor) return false;
      var reference = {
        path: message.path || '',
        kind: message.type === 'insertDirectoryReference' ? 'directory' : 'file',
        startLine: readReferenceInteger(message.startLine, 0),
        endLine: readReferenceInteger(message.endLine, 0),
        startColumn: readReferenceInteger(message.startColumn, 0),
        endColumn: readReferenceInteger(message.endColumn, 0)
      };
      if (!reference.path) return true;
      var range = getInlineEditorInsertionRange(editor);
      insertInlineReferenceAtRange(editor, range, reference);
      resizeInlineEditor(editor);
      updateInlineEditorSubmitState(editor.closest('form.message-edit-form'));
      closeEditReferenceMenu(false);
      setTransientStatus(reference.kind === 'directory' ? t('insertedDirectoryReference') : t('insertedFileReference'));
      return true;
    }

    function createInlineMessageEditor(message) {
      var form = document.createElement('form');
      form.className = 'message-edit-form';
      form.dataset.messageId = message.id;

      var editor = document.createElement('div');
      editor.className = 'message-edit-input';
      editor.dataset.messageId = message.id;
      editor.setAttribute('contenteditable', 'true');
      editor.setAttribute('role', 'textbox');
      editor.setAttribute('aria-multiline', 'true');
      editor.setAttribute('aria-label', t('editMessage'));
      renderInlineEditorContent(editor, editingDraftText);

      var footer = document.createElement('div');
      footer.className = 'message-edit-footer';

      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'secondary';
      cancel.textContent = t('cancel');
      cancel.dataset.messageAction = 'cancel-edit';
      cancel.dataset.messageId = message.id;

      var send = document.createElement('button');
      send.type = 'submit';
      send.className = 'message-edit-send';
      send.textContent = t('send');

      footer.append(cancel, send);
      form.append(editor, footer);

      requestAnimationFrame(function() {
        resizeInlineEditor(editor);
        updateInlineEditorSubmitState(form);
        if (pendingEditFocusId === message.id) {
          pendingEditFocusId = '';
          editor.focus();
          var range = getInlineEditorEndRange(editor);
          setInlineEditorSelectionRange(editor, range);
          saveEditSelection(editor);
        }
      });

      return form;
    }

    function resizeInlineEditor(editor) {
      if (!editor) return;
      editor.style.height = 'auto';
      editor.style.height = Math.min(editor.scrollHeight, 240) + 'px';
    }

    function updateInlineEditorSubmitState(form) {
      if (!form) return;
      var editor = form.querySelector('.message-edit-input');
      var send = form.querySelector('button[type="submit"]');
      if (!send || !editor) return;
      send.disabled = state.isBusy || !serializeInlineEditor(editor).trim();
    }

    function renderMarkdownContent(container, value, hideExpandedReferences, options) {
      container.classList.add('assistant-markdown');
      var renderOptions = options || {};
      var lineBreak = String.fromCharCode(10);
      var text = String(value || '')
        .split(String.fromCharCode(13) + lineBreak).join(lineBreak)
        .split(String.fromCharCode(13)).join(lineBreak);
      if (!text) return;

      var lines = text.split(lineBreak);
      var index = 0;
      while (index < lines.length) {
        if (isMarkdownBlankLine(lines[index])) {
          index += 1;
          continue;
        }

        var collapsedReferenceBlock = hideExpandedReferences ? collectExpandedReferenceMarkdownBlock(lines, index) : null;
        if (collapsedReferenceBlock) {
          appendMarkdownParagraph(container, collapsedReferenceBlock.text, renderOptions);
          index = collapsedReferenceBlock.index;
          continue;
        }

        var fence = parseMarkdownFenceLine(lines[index]);
        if (fence) {
          var codeLines = [];
          index += 1;
          while (index < lines.length) {
            var closingFence = parseMarkdownFenceLine(lines[index]);
            if (closingFence && closingFence.marker === fence.marker && closingFence.length >= fence.length && !closingFence.language) {
              index += 1;
              break;
            }
            codeLines.push(lines[index]);
            index += 1;
          }
          container.append(createMarkdownCodeBlock(fence.language, codeLines.join(lineBreak)));
          continue;
        }

        var heading = parseMarkdownHeadingLine(lines[index]);
        if (heading) {
          appendMarkdownHeading(container, heading.level, heading.text, renderOptions);
          index += 1;
          continue;
        }

        if (isMarkdownRuleLine(lines[index])) {
          container.append(document.createElement('hr'));
          index += 1;
          continue;
        }

        var quote = parseMarkdownQuoteLine(lines[index]);
        if (quote) {
          var quoteLines = [];
          while (index < lines.length) {
            var quoteLine = parseMarkdownQuoteLine(lines[index]);
            if (!quoteLine) break;
            quoteLines.push(quoteLine.text);
            index += 1;
          }
          appendMarkdownBlockquote(container, quoteLines.join(lineBreak), renderOptions);
          continue;
        }

        var listItem = parseMarkdownListItemLine(lines[index]);
        if (listItem) {
          var list = collectMarkdownList(lines, index, listItem.ordered);
          appendMarkdownList(container, list.ordered, list.items, renderOptions);
          index = list.index;
          continue;
        }

        var table = collectMarkdownTable(lines, index);
        if (table) {
          appendMarkdownTable(container, table, renderOptions);
          index = table.index;
          continue;
        }

        var paragraphLines = [];
        while (index < lines.length && !isMarkdownBlankLine(lines[index]) && !isMarkdownBlockStart(lines[index], lines, index)) {
          paragraphLines.push(lines[index]);
          index += 1;
        }
        if (!paragraphLines.length) {
          paragraphLines.push(lines[index]);
          index += 1;
        }
        appendMarkdownParagraph(container, paragraphLines.join(lineBreak), renderOptions);
      }
    }

    function collectExpandedReferenceMarkdownBlock(lines, start) {
      if (!Array.isArray(lines) || start + 1 >= lines.length) {
        return null;
      }
      if (!lineHasMessageFileReference(lines[start])) {
        return null;
      }

      var openingFence = parseMarkdownFenceLine(lines[start + 1]);
      if (!openingFence) {
        return null;
      }

      var index = start + 2;
      while (index < lines.length) {
        var closingFence = parseMarkdownFenceLine(lines[index]);
        if (closingFence && closingFence.marker === openingFence.marker && closingFence.length >= openingFence.length && !closingFence.language) {
          return {
            text: lines[start],
            index: index + 1
          };
        }
        index += 1;
      }

      return null;
    }

    function lineHasMessageFileReference(line) {
      var pattern = /<([^<>\\n]+)>/g;
      var text = String(line || '');
      var match;
      while ((match = pattern.exec(text)) !== null) {
        var reference = parseMessageFileReference((match[1] || '').trim());
        if (!reference) {
          continue;
        }
        var matchEnd = match.index + match[0].length;
        var label = getMessageReferenceLabel(text, match.index, reference);
        if (label && isStandaloneMessageReferenceLine(text, label.start, matchEnd)) {
          return true;
        }
      }
      return false;
    }

    function isMarkdownBlankLine(line) {
      return /^\\s*$/.test(String(line || ''));
    }

    function isMarkdownBlockStart(line, lines, index) {
      return Boolean(
        parseMarkdownFenceLine(line) ||
        parseMarkdownHeadingLine(line) ||
        parseMarkdownQuoteLine(line) ||
        parseMarkdownListItemLine(line) ||
        isMarkdownRuleLine(line) ||
        (lines && typeof index === 'number' && isMarkdownTableStart(lines, index))
      );
    }

    function parseMarkdownFenceLine(line) {
      var text = String(line || '');
      var index = 0;
      while (index < text.length && index < 3 && text.charAt(index) === ' ') {
        index += 1;
      }
      var marker = text.charAt(index);
      var tick = String.fromCharCode(96);
      if (marker !== tick && marker !== '~') {
        return null;
      }

      var length = 0;
      while (text.charAt(index + length) === marker) {
        length += 1;
      }
      if (length < 3) {
        return null;
      }

      var rest = text.slice(index + length).trim();
      return {
        marker: marker,
        length: length,
        language: sanitizeMarkdownCodeLanguage(rest.split(/\\s+/)[0] || '')
      };
    }

    function isMarkdownFenceOpenAtTextEnd(value) {
      var text = String(value || '')
        .split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10))
        .split(String.fromCharCode(13)).join(String.fromCharCode(10));
      var lines = text.split(String.fromCharCode(10));
      var openFence = null;
      for (var i = 0; i < lines.length; i++) {
        var fence = parseMarkdownFenceLine(lines[i]);
        if (!openFence) {
          if (fence) {
            openFence = fence;
          }
          continue;
        }
        if (fence && fence.marker === openFence.marker && fence.length >= openFence.length && !fence.language) {
          openFence = null;
        }
      }
      return Boolean(openFence);
    }

    function isOffsetInsideMarkdownFence(value, offset) {
      var text = String(value || '');
      var position = Math.max(0, Math.min(text.length, Number(offset) || 0));
      var cursor = 0;
      var openFence = null;

      while (cursor <= text.length) {
        var lineEnd = getLineEndIndex(text, cursor);
        var lineNext = getNextLineStart(text, lineEnd);
        var fence = parseMarkdownFenceLine(text.slice(cursor, lineEnd));

        if (openFence) {
          if (position < lineNext) {
            return true;
          }
          if (fence && fence.marker === openFence.marker && fence.length >= openFence.length && !fence.language) {
            openFence = null;
          }
        } else {
          if (fence) {
            if (position < lineNext) {
              return false;
            }
            openFence = fence;
          } else if (position < lineNext) {
            return false;
          }
        }

        if (lineNext <= cursor) {
          break;
        }
        cursor = lineNext;
      }

      return Boolean(openFence);
    }

    function sanitizeMarkdownCodeLanguage(value) {
      var text = String(value || '').trim();
      if (text.indexOf('{.') === 0 && text.charAt(text.length - 1) === '}') {
        text = text.slice(2, -1);
      }
      if (text.charAt(0) === '.') {
        text = text.slice(1);
      }

      var cleaned = '';
      for (var i = 0; i < text.length && cleaned.length < 32; i++) {
        var code = text.charCodeAt(i);
        var isAllowed = (code >= 48 && code <= 57) ||
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122) ||
          text.charAt(i) === '_' ||
          text.charAt(i) === '+' ||
          text.charAt(i) === '.' ||
          text.charAt(i) === '-';
        if (!isAllowed) break;
        cleaned += text.charAt(i);
      }
      return cleaned;
    }

    function parseMarkdownHeadingLine(line) {
      var match = /^ {0,3}(#{1,6})(?:\\s+|$)(.*)$/.exec(String(line || ''));
      if (!match) return null;
      return {
        level: match[1].length,
        text: String(match[2] || '').replace(/\\s+#+\\s*$/, '').trim()
      };
    }

    function isMarkdownRuleLine(line) {
      var text = String(line || '').trim();
      if (text.length < 3) return false;
      var marker = text.charAt(0);
      if (marker !== '-' && marker !== '_' && marker !== '*') return false;
      var count = 0;
      for (var i = 0; i < text.length; i++) {
        var character = text.charAt(i);
        if (character === marker) {
          count += 1;
          continue;
        }
        if (character !== ' ' && character !== '\\t') {
          return false;
        }
      }
      return count >= 3;
    }

    function parseMarkdownQuoteLine(line) {
      var text = String(line || '');
      var index = 0;
      while (index < text.length && index < 3 && text.charAt(index) === ' ') {
        index += 1;
      }
      if (text.charAt(index) !== '>') {
        return null;
      }
      index += 1;
      if (text.charAt(index) === ' ') {
        index += 1;
      }
      return { text: text.slice(index) };
    }

    function parseMarkdownListItemLine(line) {
      var unordered = /^ {0,3}([-+*])\\s+(.*)$/.exec(String(line || ''));
      if (unordered) {
        return { ordered: false, text: unordered[2] || '' };
      }
      var ordered = /^ {0,3}(\\d{1,9})[.)]\\s+(.*)$/.exec(String(line || ''));
      if (ordered) {
        return { ordered: true, text: ordered[2] || '' };
      }
      return null;
    }

    function collectMarkdownList(lines, start, ordered) {
      var items = [];
      var index = start;
      var current = null;
      var lineBreak = String.fromCharCode(10);

      while (index < lines.length) {
        var item = parseMarkdownListItemLine(lines[index]);
        if (item && item.ordered === ordered) {
          current = { text: item.text };
          items.push(current);
          index += 1;
          continue;
        }

        if (current && !isMarkdownBlankLine(lines[index]) && isMarkdownListContinuationLine(lines[index])) {
          current.text += lineBreak + trimMarkdownContinuationLine(lines[index]);
          index += 1;
          continue;
        }

        break;
      }

      return { ordered: ordered, items: items, index: index };
    }

    function isMarkdownListContinuationLine(line) {
      var text = String(line || '');
      return text.indexOf('  ') === 0 || text.charAt(0) === String.fromCharCode(9);
    }

    function trimMarkdownContinuationLine(line) {
      var text = String(line || '');
      var count = 0;
      while (count < text.length && count < 4 && text.charAt(count) === ' ') {
        count += 1;
      }
      if (text.charAt(0) === String.fromCharCode(9)) {
        return text.slice(1);
      }
      return text.slice(count);
    }

    function collectMarkdownTable(lines, start) {
      if (!isMarkdownTableStart(lines, start)) {
        return null;
      }

      var headers = parseMarkdownTableRow(lines[start]);
      var separator = parseMarkdownTableSeparator(lines[start + 1], headers.length);
      var columnCount = headers.length;
      var rows = [];
      var index = start + 2;

      while (index < lines.length) {
        if (isMarkdownBlankLine(lines[index])) {
          break;
        }

        var cells = parseMarkdownTableRow(lines[index]);
        if (!cells) {
          break;
        }

        rows.push(normalizeMarkdownTableRow(cells, columnCount));
        index += 1;
      }

      return {
        headers: normalizeMarkdownTableRow(headers, columnCount),
        alignments: separator.alignments,
        rows: rows,
        index: index
      };
    }

    function isMarkdownTableStart(lines, index) {
      if (!Array.isArray(lines) || index + 1 >= lines.length) {
        return false;
      }

      var headers = parseMarkdownTableRow(lines[index]);
      if (!headers || !hasNonEmptyMarkdownTableCells(headers)) {
        return false;
      }

      return Boolean(parseMarkdownTableSeparator(lines[index + 1], headers.length));
    }

    function parseMarkdownTableSeparator(line, columnCount) {
      var cells = parseMarkdownTableRow(line);
      if (!cells || cells.length !== columnCount) {
        return null;
      }

      var alignments = [];
      for (var i = 0; i < cells.length; i++) {
        var alignment = parseMarkdownTableAlignment(cells[i]);
        if (alignment === null) {
          return null;
        }
        alignments.push(alignment);
      }

      return { alignments: alignments };
    }

    function parseMarkdownTableAlignment(cell) {
      var text = String(cell || '').trim()
        .split(' ').join('')
        .split(String.fromCharCode(9)).join('');
      if (!text) {
        return null;
      }

      var startsWithColon = text.charAt(0) === ':';
      var endsWithColon = text.charAt(text.length - 1) === ':';
      var start = startsWithColon ? 1 : 0;
      var end = endsWithColon ? text.length - 1 : text.length;
      var hyphenCount = 0;

      for (var i = start; i < end; i++) {
        if (text.charAt(i) !== '-') {
          return null;
        }
        hyphenCount += 1;
      }

      if (hyphenCount < 3) {
        return null;
      }

      if (startsWithColon && endsWithColon) {
        return 'center';
      }
      if (endsWithColon) {
        return 'right';
      }
      if (startsWithColon) {
        return 'left';
      }
      return '';
    }

    function parseMarkdownTableRow(line) {
      var text = String(line || '').trim();
      if (!hasMarkdownTablePipe(text)) {
        return null;
      }

      var cells = splitMarkdownTableCells(text);
      return cells.length ? cells : null;
    }

    function splitMarkdownTableCells(line) {
      var text = String(line || '').trim();
      var cells = [];
      var current = '';

      if (text.charAt(0) === '|') {
        text = text.slice(1);
      }
      if (text.length && text.charAt(text.length - 1) === '|' && !isEscapedMarkdownTablePipe(text, text.length - 1)) {
        text = text.slice(0, -1);
      }

      for (var i = 0; i < text.length; i++) {
        var character = text.charAt(i);
        if (character === '|' && !isEscapedMarkdownTablePipe(text, i)) {
          cells.push(cleanMarkdownTableCell(current));
          current = '';
          continue;
        }
        current += character;
      }

      cells.push(cleanMarkdownTableCell(current));
      return cells;
    }

    function hasMarkdownTablePipe(line) {
      var text = String(line || '');
      for (var i = 0; i < text.length; i++) {
        if (text.charAt(i) === '|' && !isEscapedMarkdownTablePipe(text, i)) {
          return true;
        }
      }
      return false;
    }

    function isEscapedMarkdownTablePipe(text, index) {
      var backslash = String.fromCharCode(92);
      var count = 0;
      var cursor = index - 1;
      while (cursor >= 0 && text.charAt(cursor) === backslash) {
        count += 1;
        cursor -= 1;
      }
      return count % 2 === 1;
    }

    function cleanMarkdownTableCell(value) {
      var backslash = String.fromCharCode(92);
      return String(value || '').trim().split(backslash + '|').join('|');
    }

    function hasNonEmptyMarkdownTableCells(cells) {
      for (var i = 0; i < cells.length; i++) {
        if (String(cells[i] || '').trim()) {
          return true;
        }
      }
      return false;
    }

    function normalizeMarkdownTableRow(cells, columnCount) {
      var normalized = [];
      for (var i = 0; i < columnCount; i++) {
        normalized.push(cells[i] === undefined ? '' : cells[i]);
      }
      return normalized;
    }

    function appendMarkdownHeading(container, level, text, options) {
      var heading = document.createElement('h' + Math.min(Math.max(level, 1), 6));
      appendMarkdownInline(heading, text, options);
      container.append(heading);
    }

    function appendMarkdownParagraph(container, text, options) {
      var paragraph = document.createElement('p');
      appendMarkdownInline(paragraph, String(text || '').trim(), options);
      container.append(paragraph);
    }

    function appendMarkdownBlockquote(container, text, options) {
      var blockquote = document.createElement('blockquote');
      var parts = splitMarkdownParagraphs(text);
      for (var i = 0; i < parts.length; i++) {
        appendMarkdownParagraph(blockquote, parts[i], options);
      }
      container.append(blockquote);
    }

    function appendMarkdownList(container, ordered, items, options) {
      var list = document.createElement(ordered ? 'ol' : 'ul');
      list.className = 'message-markdown-list';
      for (var i = 0; i < items.length; i++) {
        var item = document.createElement('li');
        appendMarkdownInline(item, items[i].text, options);
        list.append(item);
      }
      container.append(list);
    }

    function appendMarkdownTable(container, tableData, options) {
      var wrapper = document.createElement('div');
      wrapper.className = 'message-table-wrap';

      var table = document.createElement('table');
      table.className = 'message-markdown-table';

      var thead = document.createElement('thead');
      var headRow = document.createElement('tr');
      for (var i = 0; i < tableData.headers.length; i++) {
        var headerCell = document.createElement('th');
        applyMarkdownTableAlignment(headerCell, tableData.alignments[i]);
        appendMarkdownInline(headerCell, tableData.headers[i], options);
        headRow.append(headerCell);
      }
      thead.append(headRow);
      table.append(thead);

      if (tableData.rows.length) {
        var tbody = document.createElement('tbody');
        for (var rowIndex = 0; rowIndex < tableData.rows.length; rowIndex++) {
          var row = document.createElement('tr');
          for (var columnIndex = 0; columnIndex < tableData.headers.length; columnIndex++) {
            var cell = document.createElement('td');
            applyMarkdownTableAlignment(cell, tableData.alignments[columnIndex]);
            appendMarkdownInline(cell, tableData.rows[rowIndex][columnIndex], options);
            row.append(cell);
          }
          tbody.append(row);
        }
        table.append(tbody);
      }

      wrapper.append(table);
      container.append(wrapper);
    }

    function applyMarkdownTableAlignment(cell, alignment) {
      if (alignment) {
        cell.style.textAlign = alignment;
      }
    }

    function splitMarkdownParagraphs(text) {
      var lineBreak = String.fromCharCode(10);
      var lines = String(text || '').split(lineBreak);
      var parts = [];
      var current = [];
      for (var i = 0; i < lines.length; i++) {
        if (isMarkdownBlankLine(lines[i])) {
          if (current.length) {
            parts.push(current.join(lineBreak));
            current = [];
          }
          continue;
        }
        current.push(lines[i]);
      }
      if (current.length) {
        parts.push(current.join(lineBreak));
      }
      return parts.length ? parts : [''];
    }

    function createMarkdownCodeBlock(language, code) {
      var block = document.createElement('div');
      block.className = 'message-code-block';

      var toolbar = document.createElement('div');
      toolbar.className = 'message-code-toolbar';

      var label = document.createElement('span');
      label.className = 'message-code-language';
      label.textContent = language || t('codeBlock');

      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'message-code-copy';
      copy.dataset.codeAction = 'copy';
      copy.innerHTML = getCopyIconSvg();
      copy.title = t('copy');
      copy.setAttribute('aria-label', t('copy'));

      toolbar.append(label, copy);

      var pre = document.createElement('pre');
      var codeElement = document.createElement('code');
      if (language) {
        codeElement.className = 'language-' + language;
      }
      codeElement.textContent = String(code || '');
      pre.append(codeElement);
      block.append(toolbar, pre);
      return block;
    }

    function getCopyIconSvg() {
      return '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="7" height="8" rx="1.4" fill="none" stroke="currentColor" stroke-width="1.25"/><path d="M4 11H3.4A1.4 1.4 0 0 1 2 9.6V3.4A1.4 1.4 0 0 1 3.4 2h6.2A1.4 1.4 0 0 1 11 3.4V4" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg>';
    }

    function getCheckIconSvg() {
      return '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.15 6.45 11.4 12.9 4.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }

    function appendMarkdownInline(container, text, options) {
      var value = String(text || '');
      var renderOptions = options || {};
      var pattern = /<([^<>\\n]+)>/g;
      var cursor = 0;
      var match;

      while ((match = pattern.exec(value)) !== null) {
        if (isOffsetInsideMarkdownFence(value, match.index)) {
          continue;
        }
        var target = (match[1] || '').trim();
        var reference = parseMessageFileReference(target);
        if (!reference) {
          continue;
        }

        var matchEnd = match.index + match[0].length;
        var label = getMessageReferenceLabel(value, match.index, reference);
        if (!label || label.start < cursor || !isStandaloneMessageReferenceLine(value, label.start, matchEnd)) {
          continue;
        }

        appendMarkdownFormattedText(container, value.slice(cursor, label.start));
        container.append(createMessageFileLink(reference, label.text, {
          compactLabel: Boolean(renderOptions.compactReferenceLinks)
        }));
        cursor = matchEnd;
      }

      appendMarkdownFormattedText(container, value.slice(cursor));
    }

    function appendMarkdownFormattedText(container, text) {
      var value = String(text || '');
      var cursor = 0;
      while (cursor < value.length) {
        var token = findNextMarkdownInlineToken(value, cursor);
        if (!token) {
          appendTextWithSoftBreaks(container, value.slice(cursor));
          return;
        }

        appendTextWithSoftBreaks(container, value.slice(cursor, token.start));
        if (token.type === 'code') {
          var code = document.createElement('code');
          code.className = 'message-inline-code';
          code.textContent = token.text;
          container.append(code);
        } else if (token.type === 'strong') {
          var strong = document.createElement('strong');
          appendMarkdownFormattedText(strong, token.text);
          container.append(strong);
        } else if (token.type === 'emphasis') {
          var emphasis = document.createElement('em');
          appendMarkdownFormattedText(emphasis, token.text);
          container.append(emphasis);
        } else if (token.type === 'file-link') {
          container.append(createCodexMarkdownFileLink(token.reference, token.text, token.href));
        } else if (token.type === 'link') {
          var link = document.createElement('a');
          link.className = 'message-external-link';
          link.href = token.href;
          link.title = token.href;
          link.target = '_blank';
          link.rel = 'noreferrer noopener';
          appendMarkdownFormattedText(link, token.text);
          container.append(link);
        }
        cursor = token.end;
      }
    }

    function findNextMarkdownInlineToken(text, from) {
      var candidates = [
        findNextCodeSpan(text, from),
        findNextMarkdownLink(text, from),
        findNextStrongSpan(text, from),
        findNextEmphasisSpan(text, from)
      ].filter(Boolean);
      if (!candidates.length) {
        return null;
      }
      candidates.sort(function(a, b) {
        return a.start - b.start || a.priority - b.priority;
      });
      return candidates[0];
    }

    function findNextCodeSpan(text, from) {
      var tick = String.fromCharCode(96);
      var start = text.indexOf(tick, from);
      while (start >= 0) {
        var length = 1;
        while (text.charAt(start + length) === tick) {
          length += 1;
        }
        var marker = repeatCharacter(tick, length);
        var end = text.indexOf(marker, start + length);
        if (end >= 0) {
          return {
            type: 'code',
            start: start,
            end: end + length,
            text: text.slice(start + length, end),
            priority: 0
          };
        }
        start = text.indexOf(tick, start + length);
      }
      return null;
    }

    function findNextMarkdownLink(text, from) {
      var start = text.indexOf('[', from);
      while (start >= 0) {
        var labelEnd = text.indexOf(']', start + 1);
        if (labelEnd < 0) return null;
        if (text.charAt(labelEnd + 1) !== '(') {
          start = text.indexOf('[', start + 1);
          continue;
        }
        var urlEnd = findMarkdownLinkUrlEnd(text, labelEnd + 2);
        if (urlEnd < 0) {
          start = text.indexOf('[', start + 1);
          continue;
        }
        var href = text.slice(labelEnd + 2, urlEnd).trim();
        var fileReference = parseCodexMarkdownFileLinkHref(href);
        if (fileReference) {
          return {
            type: 'file-link',
            start: start,
            end: urlEnd + 1,
            text: text.slice(start + 1, labelEnd),
            href: href,
            reference: fileReference,
            priority: 1
          };
        } else if (isSafeMarkdownExternalUrl(href)) {
          return {
            type: 'link',
            start: start,
            end: urlEnd + 1,
            text: text.slice(start + 1, labelEnd),
            href: href,
            priority: 1
          };
        }
        start = text.indexOf('[', start + 1);
      }
      return null;
    }

    function findMarkdownLinkUrlEnd(text, from) {
      for (var i = from; i < text.length; i++) {
        var character = text.charAt(i);
        if (character === String.fromCharCode(10) || character === String.fromCharCode(13)) {
          return -1;
        }
        if (character === ')') {
          return i;
        }
      }
      return -1;
    }

    function isSafeMarkdownExternalUrl(value) {
      var text = String(value || '').trim().toLowerCase();
      return text.indexOf('https://') === 0 || text.indexOf('http://') === 0 || text.indexOf('mailto:') === 0;
    }

    function findNextStrongSpan(text, from) {
      var asterisk = findNextDelimitedSpan(text, from, '**', 'strong', 2);
      var underscore = findNextDelimitedSpan(text, from, '__', 'strong', 2);
      if (!asterisk) return underscore;
      if (!underscore) return asterisk;
      return asterisk.start <= underscore.start ? asterisk : underscore;
    }

    function findNextEmphasisSpan(text, from) {
      var start = text.indexOf('*', from);
      while (start >= 0) {
        if (text.charAt(start + 1) === '*' || text.charAt(start - 1) === '*') {
          start = text.indexOf('*', start + 1);
          continue;
        }
        var end = findClosingSingleAsterisk(text, start + 1);
        if (end >= 0 && end > start + 1) {
          return {
            type: 'emphasis',
            start: start,
            end: end + 1,
            text: text.slice(start + 1, end),
            priority: 3
          };
        }
        start = text.indexOf('*', start + 1);
      }
      return null;
    }

    function findClosingSingleAsterisk(text, from) {
      var end = text.indexOf('*', from);
      while (end >= 0) {
        if (text.charAt(end + 1) !== '*' && text.charAt(end - 1) !== '*') {
          return end;
        }
        end = text.indexOf('*', end + 1);
      }
      return -1;
    }

    function findNextDelimitedSpan(text, from, marker, type, priority) {
      var start = text.indexOf(marker, from);
      while (start >= 0) {
        var end = text.indexOf(marker, start + marker.length);
        if (end > start + marker.length) {
          return {
            type: type,
            start: start,
            end: end + marker.length,
            text: text.slice(start + marker.length, end),
            priority: priority
          };
        }
        start = text.indexOf(marker, start + marker.length);
      }
      return null;
    }

    function appendTextWithSoftBreaks(container, text) {
      var lineBreak = String.fromCharCode(10);
      var parts = String(text || '').split(lineBreak);
      for (var i = 0; i < parts.length; i++) {
        if (i > 0) {
          container.append(document.createElement('br'));
        }
        if (parts[i]) {
          container.append(document.createTextNode(parts[i]));
        }
      }
    }

    function repeatCharacter(character, count) {
      var value = '';
      for (var i = 0; i < count; i++) {
        value += character;
      }
      return value;
    }

    function renderMessageContent(container, value, hideExpandedReferences) {
      var text = String(value || '');
      var pattern = /<([^<>\\n]+)>/g;
      var cursor = 0;
      var match;

      while ((match = pattern.exec(text)) !== null) {
        if (isOffsetInsideMarkdownFence(text, match.index)) {
          continue;
        }
        var target = (match[1] || '').trim();
        var reference = parseMessageFileReference(target);
        if (!reference) {
          continue;
        }

        var matchEnd = match.index + match[0].length;
        var label = getMessageReferenceLabel(text, match.index, reference);
        if (!label || label.start < cursor || !isStandaloneMessageReferenceLine(text, label.start, matchEnd)) {
          continue;
        }

        appendMessageText(container, text.slice(cursor, label.start));
        container.append(createMessageFileLink(reference, label.text, {
          compactLabel: Boolean(hideExpandedReferences)
        }));
        cursor = matchEnd;
        if (hideExpandedReferences) {
          var hiddenBlockEnd = getExpandedReferenceBlockEnd(text, cursor);
          if (hiddenBlockEnd > cursor) {
            cursor = hiddenBlockEnd;
            if (cursor < text.length) {
              appendMessageText(container, String.fromCharCode(10));
            }
          }
        }
      }

      appendMessageText(container, text.slice(cursor));
    }

    function getExpandedReferenceBlockEnd(text, start) {
      var cursor = start;
      if (text.charAt(cursor) === String.fromCharCode(13)) {
        cursor += 1;
      }
      if (text.charAt(cursor) !== String.fromCharCode(10)) {
        return start;
      }
      cursor += 1;

      var fenceLineEnd = getLineEndIndex(text, cursor);
      var fenceLine = text.slice(cursor, fenceLineEnd).trim();
      var fenceMatch = /^(\`{3,}|~{3,})[\\w+.-]*$/.exec(fenceLine);
      if (!fenceMatch) {
        return start;
      }

      var fence = fenceMatch[1];
      cursor = getNextLineStart(text, fenceLineEnd);
      while (cursor < text.length) {
        var lineEnd = getLineEndIndex(text, cursor);
        var line = text.slice(cursor, lineEnd).trim();
        if (line === fence) {
          return getNextLineStart(text, lineEnd);
        }
        cursor = getNextLineStart(text, lineEnd);
      }

      return start;
    }

    function getLineEndIndex(text, start) {
      var lineFeed = text.indexOf(String.fromCharCode(10), start);
      var carriageReturn = text.indexOf(String.fromCharCode(13), start);
      if (lineFeed < 0) return carriageReturn < 0 ? text.length : carriageReturn;
      if (carriageReturn < 0) return lineFeed;
      return Math.min(lineFeed, carriageReturn);
    }

    function getNextLineStart(text, lineEnd) {
      var cursor = lineEnd;
      if (text.charAt(cursor) === String.fromCharCode(13)) {
        cursor += 1;
      }
      if (text.charAt(cursor) === String.fromCharCode(10)) {
        cursor += 1;
      }
      return cursor;
    }

    function appendMessageText(container, text) {
      if (!text) return;
      container.append(document.createTextNode(text));
    }

    function createMessageFileLink(reference, label, options) {
      var isDirectory = reference.kind === 'directory';
      return createReferenceLinkElement(reference, {
        kind: isDirectory ? 'directory' : 'file',
        message: true,
        label: label,
        compactLabel: Boolean(options?.compactLabel)
      });
    }

    function createCodexMarkdownFileLink(reference, label, href) {
      var anchor = createMessageFileLink(reference, formatCodexMarkdownFileLabel(label, reference));
      anchor.classList.add('message-codex-file-link');
      if (href) {
        anchor.setAttribute('href', href);
        anchor.title = href;
        anchor.dataset.markdownHref = href;
      }
      return anchor;
    }

    function formatCodexMarkdownFileLabel(label, reference) {
      var text = stripFileReferenceLabelBrackets(label) || getMessageFileName(reference.path);
      if (reference.startLine <= 0 || codexMarkdownLabelHasLineReference(text, reference)) {
        return text;
      }
      return text + ' (' + formatLineReferenceLabel(
        reference.startLine,
        reference.endLine,
        reference.startColumn,
        reference.endColumn,
        'en'
      ) + ')';
    }

    function codexMarkdownLabelHasLineReference(label, reference) {
      var text = String(label || '').trim().toLowerCase().replace(/\\s+/g, ' ');
      if (!text || reference.startLine <= 0) {
        return false;
      }

      var labels = getLineLabelVariants(
        reference.startLine,
        reference.endLine,
        reference.startColumn,
        reference.endColumn
      ).concat(formatLineReferenceLabel(
        reference.startLine,
        reference.endLine,
        reference.startColumn,
        reference.endColumn,
        'en'
      ));
      for (var i = 0; i < labels.length; i++) {
        var lineLabel = String(labels[i] || '').toLowerCase();
        if (lineLabel && (text.endsWith('(' + lineLabel + ')') || text.endsWith(' ' + lineLabel))) {
          return true;
        }
      }

      var range = reference.startLine === reference.endLine
        ? String(reference.startLine)
        : reference.startLine + '-' + reference.endLine;
      if (text.endsWith(':' + range) || text.endsWith('#' + range)) {
        return true;
      }
      if (reference.startLine === reference.endLine) {
        return text.endsWith('#l' + reference.startLine);
      }
      return text.endsWith('#l' + reference.startLine + '-l' + reference.endLine) ||
        text.endsWith('#l' + reference.startLine + '-' + reference.endLine);
    }

    function parseMessageFileReference(target) {
      var directoryReference = parseMessageDirectoryReference(target);
      if (directoryReference) {
        return directoryReference;
      }
      if (!isSafeMessageFileReferenceTarget(target)) {
        return null;
      }
      if (hasNonFileUriScheme(target)) {
        return null;
      }
      var reference = target.toLowerCase().indexOf('file:') === 0
        ? parseMessageFileUri(target)
        : splitMessageLineReference(target);
      if (!reference || !isLikelyMessageFilePath(reference.path, target)) {
        return null;
      }
      if (reference.startLine > 0 && reference.endLine < reference.startLine) {
        reference.endLine = reference.startLine;
      }
      return reference;
    }

    function isSafeMessageFileReferenceTarget(value) {
      var text = String(value || '').trim();
      if (!text) return false;
      if (text.indexOf('"') >= 0 || text.indexOf("'") >= 0 || text.indexOf(String.fromCharCode(96)) >= 0 || /\\s+\\S+=/.test(text)) {
        return false;
      }
      for (var i = 0; i < text.length; i++) {
        var code = text.charCodeAt(i);
        if (code < 32 || code === 127) return false;
      }
      return true;
    }

    function parseCodexMarkdownFileLinkHref(href) {
      var text = String(href || '').trim();
      if (!text || hasUnsafeMarkdownFileHrefScheme(text)) {
        return null;
      }

      var reference = text.toLowerCase().indexOf('file:') === 0
        ? parseCodexMarkdownFileUriReference(text)
        : splitCodexMarkdownLineReference(text);
      if (!reference || reference.startLine <= 0 || !isLikelyMessageFilePath(reference.path, text)) {
        return null;
      }
      if (reference.endLine < reference.startLine) {
        reference.endLine = reference.startLine;
      }
      return reference;
    }

    function hasUnsafeMarkdownFileHrefScheme(value) {
      var text = String(value || '').trim();
      if (text.indexOf('//') === 0) {
        return true;
      }
      var match = /^([a-z][a-z\\d+.-]*):/i.exec(text);
      if (!match) {
        return false;
      }
      if (match[1].toLowerCase() === 'file') {
        return false;
      }
      return !isMessageWindowsDrivePath(text);
    }

    function parseCodexMarkdownFileUriReference(href) {
      var reference = parseMessageFileUri(href);
      if (!reference) {
        return null;
      }
      if (reference.startLine > 0) {
        return reference;
      }
      return splitCodexMarkdownLineReference(reference.path);
    }

    function splitCodexMarkdownLineReference(value) {
      var text = String(value || '').trim();
      var hashReference = splitMessageLineReference(text);
      if (hashReference.startLine > 0) {
        return hashReference;
      }

      var separator = text.lastIndexOf(':');
      if (separator < 0) {
        return null;
      }
      var parsed = parseMessageLineRange(text.slice(separator + 1));
      if (!parsed.valid) {
        return null;
      }
      var filePath = decodeMarkdownFilePath(text.slice(0, separator));
      if (!filePath) {
        return null;
      }
      return {
        path: filePath,
        startLine: parsed.startLine,
        endLine: parsed.endLine,
        startColumn: parsed.startColumn,
        endColumn: parsed.endColumn
      };
    }

    function decodeMarkdownFilePath(value) {
      var text = String(value || '').trim();
      try {
        return decodeURIComponent(text);
      } catch {
        return text;
      }
    }

    function parseMessageDirectoryReference(target) {
      var text = String(target || '').trim();
      var prefix = 'keepseek-dir:';
      if (text.toLowerCase().indexOf(prefix) !== 0) {
        return null;
      }
      var directoryPath = text.slice(prefix.length).trim();
      if (!directoryPath) {
        return null;
      }
      return {
        path: directoryPath,
        kind: 'directory',
        startLine: 0,
        endLine: 0,
        startColumn: 0,
        endColumn: 0
      };
    }

    function hasNonFileUriScheme(value) {
      var match = /^[a-z][a-z\\d+.-]*:\\/\\//i.exec(String(value || '').trim());
      return Boolean(match && match[0].toLowerCase().indexOf('file:') !== 0);
    }

    function parseMessageFileUri(target) {
      try {
        var url = new URL(target);
        if (url.protocol !== 'file:') {
          return null;
        }
        var parsed = parseMessageLineRange(url.hash ? url.hash.slice(1) : '');
        var pathName = decodeURIComponent(url.pathname);
        var filePath = url.hostname ? '//' + url.hostname + pathName : pathName;
        if (filePath.charAt(0) === '/' && isMessageWindowsDrivePath(filePath.slice(1))) {
          filePath = filePath.slice(1);
        }
        return {
          path: filePath,
          startLine: parsed.valid ? parsed.startLine : 0,
          endLine: parsed.valid ? parsed.endLine : 0,
          startColumn: parsed.valid ? parsed.startColumn : 0,
          endColumn: parsed.valid ? parsed.endColumn : 0
        };
      } catch {
        return splitMessageLineReference(target);
      }
    }

    function splitMessageLineReference(value) {
      var text = String(value || '').trim();
      for (var i = text.length - 1; i >= 0; i--) {
        if (text.charAt(i) !== '#') continue;
        var parsed = parseMessageLineRange(text.slice(i + 1));
        if (parsed.valid) {
          return {
            path: text.slice(0, i),
            startLine: parsed.startLine,
            endLine: parsed.endLine,
            startColumn: parsed.startColumn,
            endColumn: parsed.endColumn
          };
        }
      }
      return { path: text, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
    }

    function parseMessageLineRange(fragment) {
      var text = String(fragment || '').trim();
      if (!text) {
        return { valid: false, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
      }
      if (text.charAt(0).toLowerCase() === 'l') {
        text = text.slice(1);
      }

      var start = readLeadingReferenceInteger(text);
      if (!start.valid) {
        return { valid: false, startLine: 0, endLine: 0, startColumn: 0, endColumn: 0 };
      }

      var startLine = start.value;
      var startColumn = 0;
      var rest = start.rest;

      if (rest.charAt(0).toLowerCase() === 'c') {
        var col = readLeadingReferenceInteger(rest.slice(1));
        if (col.valid) {
          startColumn = col.value;
          rest = col.rest;
        }
      }

      if (rest.charAt(0) !== '-' && rest.charAt(0) !== ',' && rest.charAt(0) !== ':') {
        return { valid: true, startLine: startLine, endLine: startLine, startColumn: startColumn, endColumn: startColumn };
      }

      rest = rest.slice(1);
      var endLine = startLine;
      var endColumn = 0;

      if (rest.charAt(0).toLowerCase() === 'l') {
        var endLineResult = readLeadingReferenceInteger(rest.slice(1));
        if (endLineResult.valid) {
          endLine = endLineResult.value;
          rest = endLineResult.rest;
          if (rest.charAt(0).toLowerCase() === 'c') {
            var endColResult = readLeadingReferenceInteger(rest.slice(1));
            if (endColResult.valid) {
              endColumn = endColResult.value;
            }
          }
        }
      } else if (rest.charAt(0).toLowerCase() === 'c') {
        var sameLineCol = readLeadingReferenceInteger(rest.slice(1));
        if (sameLineCol.valid) {
          endColumn = sameLineCol.value;
        }
      } else {
        var endResult = readLeadingReferenceInteger(rest);
        if (endResult.valid) {
          endLine = endResult.value;
        }
      }

      return {
        valid: true,
        startLine: startLine,
        endLine: Math.max(startLine, endLine),
        startColumn: startColumn,
        endColumn: endColumn
      };
    }

    function readLeadingReferenceInteger(value) {
      var digits = '';
      for (var i = 0; i < value.length; i++) {
        var code = value.charCodeAt(i);
        if (code < 48 || code > 57) break;
        digits += value.charAt(i);
      }
      if (!digits) {
        return { valid: false, value: 0, rest: value };
      }
      return {
        valid: true,
        value: Math.max(1, Number(digits)),
        rest: value.slice(digits.length)
      };
    }

    function getMessageReferenceLabel(text, matchStart, reference) {
      if (reference.kind === 'directory') {
        return getMessageDirectoryReferenceLabel(text, matchStart, reference);
      }

      var bracketLabel = getBracketMessageReferenceLabel(text, matchStart);
      if (bracketLabel) {
        return bracketLabel;
      }

      var fileName = getMessageFileName(reference.path);
      var labels = reference.startLine > 0
        ? getLegacyLineLabelVariants(reference.startLine, reference.endLine, reference.startColumn, reference.endColumn).map(function(label) {
            return fileName + ' (' + label + ')';
          })
        : [];
      labels.push(fileName + ' (' + t('fullFileLabel') + ')', fileName + ' (全文)', fileName + ' (full file)', fileName);

      var prefix = text.slice(0, matchStart);
      for (var i = 0; i < labels.length; i++) {
        var labelWithSpace = labels[i] + ' ';
        if (prefix.endsWith(labelWithSpace)) {
          return {
            start: matchStart - labelWithSpace.length,
            text: labels[i]
          };
        }
      }

      return null;
    }

    function isStandaloneMessageReferenceLine(text, referenceStart, referenceEnd) {
      var value = String(text || '');
      var start = Math.max(0, Number(referenceStart) || 0);
      var end = Math.max(start, Number(referenceEnd) || start);
      var lineStart = getMessageLineStart(value, start);
      var lineEnd = getMessageLineEnd(value, end);
      return !value.slice(lineStart, start).trim() && !value.slice(end, lineEnd).trim();
    }

    function getMessageLineStart(text, index) {
      var before = Math.max(0, index - 1);
      var lineFeed = text.lastIndexOf(String.fromCharCode(10), before);
      var carriageReturn = text.lastIndexOf(String.fromCharCode(13), before);
      return Math.max(lineFeed, carriageReturn) + 1;
    }

    function getMessageLineEnd(text, index) {
      var lineFeed = text.indexOf(String.fromCharCode(10), index);
      var carriageReturn = text.indexOf(String.fromCharCode(13), index);
      if (lineFeed < 0) return carriageReturn < 0 ? text.length : carriageReturn;
      if (carriageReturn < 0) return lineFeed;
      return Math.min(lineFeed, carriageReturn);
    }

    function getBracketMessageReferenceLabel(text, matchStart) {
      var prefix = String(text || '').slice(0, matchStart);
      var trailingWhitespaceMatch = /[ \\t]*(?:\\r?\\n[ \\t]*)?$/.exec(prefix);
      var trailingWhitespace = trailingWhitespaceMatch ? trailingWhitespaceMatch[0] : '';
      var labelEnd = prefix.length - trailingWhitespace.length;
      if (labelEnd <= 0 || prefix.charAt(labelEnd - 1) !== ']') {
        return null;
      }

      var lineStart = Math.max(prefix.lastIndexOf('\\n', labelEnd - 1) + 1, prefix.lastIndexOf('\\r', labelEnd - 1) + 1);
      var labelStart = prefix.lastIndexOf('[', labelEnd - 1);
      if (labelStart < lineStart || labelStart >= labelEnd - 1) {
        return null;
      }
      if (prefix.slice(lineStart, labelStart).trim()) {
        return null;
      }

      return {
        start: labelStart,
        text: prefix.slice(labelStart + 1, labelEnd - 1)
      };
    }

    function getMessageDirectoryReferenceLabel(text, matchStart, reference) {
      var directoryName = getMessageDirectoryName(reference.path);
      var bareName = directoryName.charAt(directoryName.length - 1) === '/'
        ? directoryName.slice(0, -1)
        : directoryName;
      var labels = [
        directoryName,
        bareName + ' (' + t('directoryLabel') + ')',
        bareName + ' (目录)',
        bareName + ' (directory)',
        bareName
      ];
      var prefix = text.slice(0, matchStart);
      for (var i = 0; i < labels.length; i++) {
        var labelWithSpace = labels[i] + ' ';
        if (prefix.endsWith(labelWithSpace)) {
          return {
            start: matchStart - labelWithSpace.length,
            text: labels[i]
          };
        }
      }

      return null;
    }

    function makeMessageFileHref(reference) {
      return makeFileReferenceHref(reference);
    }

    function makeMessageDirectoryHref(reference) {
      return 'keepseek-dir:' + reference.path;
    }

    function getLineLabelVariants(startLine, endLine, startColumn, endColumn) {
      var labels = [
        formatLineReferenceLabel(startLine, endLine, startColumn, endColumn, getLanguage()),
        formatLegacyLineReferenceLabel(startLine, endLine, startColumn, endColumn, getLanguage()),
        formatLegacyLineReferenceLabel(startLine, endLine, startColumn, endColumn, 'zh-CN'),
        formatLegacyLineReferenceLabel(startLine, endLine, startColumn, endColumn, 'en')
      ];
      return labels.filter(function(label, index) {
        return labels.indexOf(label) === index;
      });
    }

    function getLegacyLineLabelVariants(startLine, endLine, startColumn, endColumn) {
      var labels = [
        formatLegacyLineReferenceLabel(startLine, endLine, startColumn, endColumn, getLanguage()),
        formatLegacyLineReferenceLabel(startLine, endLine, startColumn, endColumn, 'zh-CN'),
        formatLegacyLineReferenceLabel(startLine, endLine, startColumn, endColumn, 'en')
      ];
      return labels.filter(function(label, index) {
        return labels.indexOf(label) === index;
      });
    }

    function formatLineReferenceLabel(startLine, endLine, startColumn, endColumn, language) {
      var normalizedEndLine = Math.max(startLine, endLine || startLine);
      var normalizedStartColumn = startColumn > 0 ? startColumn : 1;
      var normalizedEndColumn = endColumn > 0 ? endColumn : normalizedStartColumn;
      var hasColumnDetail = normalizedStartColumn !== 1 || normalizedEndColumn !== 1;

      if (startLine === normalizedEndLine) {
        if (!hasColumnDetail) {
          return 'L' + startLine;
        }
        if (normalizedStartColumn === normalizedEndColumn) {
          return 'L' + startLine + '#C' + normalizedStartColumn;
        }
        return 'L' + startLine + '#C' + normalizedStartColumn + '-L' + normalizedEndLine + '#C' + normalizedEndColumn;
      }

      if (!hasColumnDetail) {
        return 'L' + startLine + '-' + normalizedEndLine;
      }

      return 'L' + startLine + '#C' + normalizedStartColumn + '-L' + normalizedEndLine + '#C' + normalizedEndColumn;
    }

    function formatLegacyLineReferenceLabel(startLine, endLine, startColumn, endColumn, language) {
      if (language === 'en') {
        if (startLine === endLine) {
          if (startColumn > 0) {
            var colEndEn = endColumn > startColumn ? endColumn : 0;
            if (colEndEn > 0) {
              return 'line ' + startLine + ' cols ' + startColumn + '-' + colEndEn;
            }
            return 'line ' + startLine + ' from col ' + startColumn;
          }
          return 'line ' + startLine;
        }
        if (startColumn > 0 || endColumn > 0) {
          var startColEn = startColumn > 0 ? ' col ' + startColumn : '';
          var endColEn = endColumn > 0 ? ' col ' + endColumn : '';
          return 'line ' + startLine + startColEn + '-line ' + endLine + endColEn;
        }
        return 'lines ' + startLine + '-' + endLine;
      }
      if (startLine === endLine) {
        if (startColumn > 0) {
          var colEnd = endColumn > startColumn ? endColumn : 0;
          if (colEnd > 0) {
            return '\\u7b2c' + startLine + '\\u884c\\u7b2c' + startColumn + '-' + colEnd + '\\u5217';
          }
          return '\\u7b2c' + startLine + '\\u884c\\u7b2c' + startColumn + '\\u5217\\u8d77';
        }
        return '\\u7b2c' + startLine + '\\u884c';
      }
      if (startColumn > 0 || endColumn > 0) {
        var startCol = startColumn > 0 ? '\\u7b2c' + startColumn + '\\u5217' : '';
        var endCol = endColumn > 0 ? '\\u7b2c' + endColumn + '\\u5217' : '';
        return '\\u7b2c' + startLine + '\\u884c' + startCol + '-\\u7b2c' + endLine + '\\u884c' + endCol;
      }
      return '\\u7b2c' + startLine + '-' + endLine + '\\u884c';
    }

    function formatFileReferenceLabel(reference) {
      return formatFileReferenceLabelContents(reference);
    }

    function formatFileReferenceTextLabel(reference) {
      return '[' + formatFileReferenceLabelContents(reference) + ']';
    }

    function formatFileReferenceLabelContents(reference) {
      var label = getReferenceChipLabel(reference);
      return label.secondary ? label.primary + ' - ' + label.secondary : label.primary;
    }

    function createReferenceLinkElement(reference, options) {
      var settings = options || {};
      var normalized = normalizeReferenceLinkInput(reference, settings.kind);
      var isDirectory = normalized.kind === 'directory';
      var href = isDirectory ? makeMessageDirectoryHref(normalized) : makeMessageFileHref(normalized);
      var anchor = document.createElement('a');
      anchor.className = isDirectory ? 'rich-file-link rich-directory-link' : 'rich-file-link';
      if (settings.message) {
        anchor.classList.add('message-file-link');
      }
      anchor.setAttribute('href', href);
      anchor.setAttribute('contenteditable', 'false');
      anchor.draggable = false;
      if (settings.compactLabel === false) {
        anchor.title = href;
        anchor.setAttribute('aria-label', href);
        anchor.textContent = getReferenceFallbackLabel(normalized, settings.label);
      } else {
        renderFileReferenceLinkLabel(anchor, normalized);
      }
      writeReferenceLinkDataset(anchor, normalized);
      return anchor;
    }

    function normalizeReferenceLinkInput(reference, kindOverride) {
      var kind = kindOverride || (reference.kind === 'directory' ? 'directory' : 'file');
      var startLine = kind === 'directory' ? 0 : Math.max(0, Number(reference.startLine) || 0);
      return {
        path: reference.path || '',
        kind: kind,
        startLine: startLine,
        endLine: startLine > 0 ? Math.max(startLine, Number(reference.endLine) || startLine) : 0,
        startColumn: kind === 'directory' ? 0 : Math.max(0, Number(reference.startColumn) || 0),
        endColumn: kind === 'directory' ? 0 : Math.max(0, Number(reference.endColumn) || 0)
      };
    }

    function getReferenceFallbackLabel(reference, label) {
      var text = String(label || '').trim();
      if (reference.kind === 'directory') {
        return text || getMessageDirectoryName(reference.path);
      }
      return stripFileReferenceLabelBrackets(text || formatFileReferenceLabel(reference));
    }

    function writeReferenceLinkDataset(anchor, reference) {
      anchor.dataset.path = reference.path;
      anchor.dataset.kind = reference.kind;
      anchor.dataset.startLine = String(reference.startLine);
      anchor.dataset.endLine = String(reference.endLine);
      anchor.dataset.startColumn = String(reference.startColumn || 0);
      anchor.dataset.endColumn = String(reference.endColumn || 0);
    }

    function renderFileReferenceLinkLabel(anchor, reference) {
      var label = getReferenceChipLabel(reference);
      anchor.textContent = '';
      anchor.append(createReferenceChipLabelPart('rich-file-link-primary', label.primary));
      if (label.secondary) {
        anchor.append(createReferenceChipLabelPart('rich-file-link-secondary', label.secondary));
      }
      var title = getReferenceChipTitle(reference);
      anchor.title = title;
      anchor.setAttribute('aria-label', title);
    }

    function createReferenceChipLabelPart(className, text) {
      var span = document.createElement('span');
      span.className = className;
      span.textContent = text;
      return span;
    }

    function getReferenceChipLabel(reference) {
      var isDirectory = reference.kind === 'directory';
      var displayPath = getReferenceDisplayPath(reference.path);
      var targetPath = isDirectory
        ? stripTrailingReferenceSlashes(normalizeReferencePath(displayPath))
        : normalizeReferencePath(displayPath);
      var primary = isDirectory ? getMessageDirectoryName(targetPath) : getMessageFileName(targetPath);
      if (!isDirectory && reference.startLine > 0) {
        primary += ' (' + formatLineReferenceLabel(
          reference.startLine,
          reference.endLine,
          reference.startColumn,
          reference.endColumn,
          getLanguage()
        ) + ')';
      }
      return {
        primary: primary,
        secondary: getCompactReferenceParentPath(targetPath)
      };
    }

    function getReferenceChipTitle(reference) {
      var isDirectory = reference.kind === 'directory';
      var fullPath = getReferenceFullPath(reference.path);
      if (!isDirectory && reference.startLine > 0) {
        return fullPath + ' (' + formatLineReferenceLabel(
          reference.startLine,
          reference.endLine,
          reference.startColumn,
          reference.endColumn,
          getLanguage()
        ) + ')';
      }
      return isDirectory ? ensureTrailingReferenceSlash(fullPath) : fullPath;
    }

    function getReferenceFullPath(filePath) {
      var pathName = getFileReferencePathname(filePath);
      if (isAbsoluteReferencePath(pathName)) {
        return normalizeReferencePath(pathName);
      }
      return normalizeReferencePath(resolveReferencePathToAbsolutePath(pathName) || pathName);
    }

    function getCompactReferenceParentPath(targetPath) {
      var normalizedPath = stripTrailingReferenceSlashes(normalizeReferencePath(targetPath));
      var lastSlash = normalizedPath.lastIndexOf('/');
      if (lastSlash <= 0) {
        return '';
      }
      var parentPath = normalizedPath.slice(0, lastSlash);
      var parts = parentPath.split('/').filter(function(part) { return Boolean(part); });
      if (!parts.length) {
        return '';
      }
      var maxSegments = 3;
      var visibleParts = parts.length > maxSegments ? parts.slice(parts.length - maxSegments) : parts;
      var compactPath = visibleParts.map(compactReferencePathSegment).join('/');
      if (parts.length > maxSegments) {
        return '.../' + compactPath;
      }
      if (parentPath.charAt(0) === '/' && !isMessageWindowsDrivePath(parentPath)) {
        return '/' + compactPath;
      }
      return compactPath;
    }

    function compactReferencePathSegment(segment) {
      var text = String(segment || '');
      if (text.length <= 36) {
        return text;
      }
      return text.slice(0, 18) + '...' + text.slice(-10);
    }

    function ensureTrailingReferenceSlash(value) {
      var text = String(value || '');
      return text.charAt(text.length - 1) === '/' ? text : text + '/';
    }

    function stripFileReferenceLabelBrackets(value) {
      var text = String(value || '').trim();
      if (text.length >= 2 && text.charAt(0) === '[' && text.charAt(text.length - 1) === ']') {
        return text.slice(1, -1);
      }
      return text;
    }

    function makeFileReferenceHref(reference) {
      var href = makeFileReferenceBaseUri(reference.path);
      if (reference.startLine <= 0) {
        return href;
      }
      return href + '#' + formatFileReferenceFragment(reference);
    }

    function formatFileReferenceFragment(reference) {
      var startLine = Math.max(1, Number(reference.startLine) || 1);
      var endLine = Math.max(startLine, Number(reference.endLine) || startLine);
      var startColumn = Math.max(1, Number(reference.startColumn) || 1);
      var endColumn = Math.max(1, Number(reference.endColumn) || startColumn);
      var fragment = 'L' + startLine + 'C' + startColumn;
      if (endLine !== startLine || endColumn !== startColumn) {
        fragment += '-L' + endLine + 'C' + endColumn;
      }
      return fragment;
    }

    function makeFileReferenceBaseUri(filePath) {
      var text = String(filePath || '').trim();
      if (!text) {
        return '';
      }
      if (text.toLowerCase().indexOf('file:') === 0) {
        try {
          var url = new URL(text);
          url.hash = '';
          return url.toString();
        } catch {
          return stripReferenceHash(text);
        }
      }

      var absolutePath = resolveReferencePathToAbsolutePath(text);
      if (absolutePath && isAbsoluteReferencePath(absolutePath)) {
        return pathToFileUri(absolutePath);
      }
      return stripReferenceHash(text);
    }

    function resolveReferencePathToAbsolutePath(filePath) {
      var pathName = getFileReferencePathname(filePath);
      if (isAbsoluteReferencePath(pathName)) {
        return pathName;
      }

      var roots = getWorkspaceFolderPaths();
      if (!roots.length) {
        return pathName;
      }

      var normalizedRoot = stripTrailingReferenceSlashes(normalizeReferencePath(roots[0]));
      var relativePath = normalizeReferencePath(pathName).replace(/^\\.\\//, '');
      return normalizedRoot + '/' + relativePath;
    }

    function getReferenceDisplayPath(filePath) {
      var pathName = getFileReferencePathname(filePath);
      var normalizedPath = normalizeReferencePath(pathName);
      var roots = getWorkspaceFolderPaths();
      var bestRoot = '';

      for (var i = 0; i < roots.length; i++) {
        var root = stripTrailingReferenceSlashes(normalizeReferencePath(getFileReferencePathname(roots[i])));
        if (root && isReferencePathInsideRoot(normalizedPath, root) && root.length > bestRoot.length) {
          bestRoot = root;
        }
      }

      if (bestRoot) {
        var relativePath = normalizedPath.slice(bestRoot.length);
        while (relativePath.charAt(0) === '/') {
          relativePath = relativePath.slice(1);
        }
        return relativePath || getMessageFileName(normalizedPath);
      }

      return normalizedPath || String(filePath || '') || 'file';
    }

    function getWorkspaceFolderPaths() {
      return Array.isArray(state.workspaceFolders)
        ? state.workspaceFolders.filter(function(folder) { return typeof folder === 'string' && folder.trim(); })
        : [];
    }

    function isReferencePathInsideRoot(filePath, rootPath) {
      var normalizedPath = normalizeReferencePath(filePath);
      var normalizedRoot = stripTrailingReferenceSlashes(normalizeReferencePath(rootPath));
      if (!normalizedRoot) {
        return false;
      }
      var comparePath = normalizeReferencePathForCompare(normalizedPath);
      var compareRoot = normalizeReferencePathForCompare(normalizedRoot);
      return comparePath === compareRoot || comparePath.indexOf(compareRoot + '/') === 0;
    }

    function normalizeReferencePathForCompare(filePath) {
      var normalized = normalizeReferencePath(filePath);
      return isMessageWindowsDrivePath(normalized) ? normalized.toLowerCase() : normalized;
    }

    function getFileReferencePathname(value) {
      var text = String(value || '').trim();
      if (text.toLowerCase().indexOf('file:') !== 0) {
        return stripReferenceHash(text);
      }
      try {
        var url = new URL(text);
        var pathName = decodeURIComponent(url.pathname);
        var filePath = url.hostname ? '//' + url.hostname + pathName : pathName;
        if (filePath.charAt(0) === '/' && isMessageWindowsDrivePath(filePath.slice(1))) {
          filePath = filePath.slice(1);
        }
        return filePath;
      } catch {
        return stripReferenceHash(text);
      }
    }

    function pathToFileUri(filePath) {
      var normalized = normalizeReferencePath(filePath);
      if (normalized.indexOf('//') === 0) {
        var uncParts = normalized.slice(2).split('/');
        var host = uncParts.shift() || '';
        return 'file://' + encodeURIComponent(host) + '/' + encodeFileUriPath(uncParts.join('/'));
      }
      if (isMessageWindowsDrivePath(normalized)) {
        return 'file:///' + encodeFileUriPath(normalized);
      }
      if (normalized.charAt(0) !== '/') {
        normalized = '/' + normalized;
      }
      return 'file://' + encodeFileUriPath(normalized);
    }

    function encodeFileUriPath(value) {
      return encodeURI(String(value || '')).replace(/#/g, '%23').replace(/\\?/g, '%3F');
    }

    function normalizeReferencePath(value) {
      return String(value || '').trim().split(String.fromCharCode(92)).join('/');
    }

    function stripTrailingReferenceSlashes(value) {
      var text = String(value || '');
      while (text.length > 1 && text.charAt(text.length - 1) === '/') {
        text = text.slice(0, -1);
      }
      return text;
    }

    function stripReferenceHash(value) {
      var text = String(value || '').trim();
      var hash = text.lastIndexOf('#');
      if (hash < 0) {
        return text;
      }
      var parsed = parseMessageLineRange(text.slice(hash + 1));
      return parsed.valid ? text.slice(0, hash) : text;
    }

    function isAbsoluteReferencePath(value) {
      var text = String(value || '');
      return text.charAt(0) === '/' || text.indexOf('//') === 0 || isMessageWindowsDrivePath(text);
    }

    function getMessageFileName(filePath) {
      var normalized = String(filePath || '').split(String.fromCharCode(92)).join('/');
      var parts = normalized.split('/');
      return parts[parts.length - 1] || normalized || 'file';
    }

    function getMessageDirectoryName(directoryPath) {
      var name = getMessageFileName(directoryPath);
      return name.charAt(name.length - 1) === '/' ? name : name + '/';
    }

    function isLikelyMessageFilePath(path, rawTarget) {
      var value = String(path || '').trim();
      var target = String(rawTarget || '').trim();
      if (!value) return false;
      var last = value.charAt(value.length - 1);
      if (last === '/' || last === String.fromCharCode(92)) return false;
      if (isSingleSegmentClosingTagPath(value)) return false;
      if (target.toLowerCase().indexOf('file:') === 0) return true;
      if (value.charAt(0) === '/' || value.charAt(0) === '~') return true;
      if (value.indexOf('./') === 0 || value.indexOf('../') === 0) return true;
      if (isMessageWindowsDrivePath(value)) return true;
      return value.indexOf('/') >= 0 || value.indexOf(String.fromCharCode(92)) >= 0;
    }

    function isSingleSegmentClosingTagPath(value) {
      var text = String(value || '').trim();
      if (text.charAt(0) !== '/' || text.indexOf('/', 1) >= 0 || text.indexOf('.') >= 0) {
        return false;
      }
      var name = text.slice(1);
      if (!name) return false;
      for (var i = 0; i < name.length; i++) {
        var code = name.charCodeAt(i);
        var allowed = (code >= 48 && code <= 57) ||
          (code >= 65 && code <= 90) ||
          (code >= 97 && code <= 122) ||
          name.charAt(i) === '_' ||
          name.charAt(i) === '-' ||
          name.charAt(i) === ':';
        if (!allowed) return false;
      }
      return true;
    }

    function isMessageWindowsDrivePath(value) {
      if (value.length < 3 || value.charAt(1) !== ':') return false;
      var firstCode = value.charCodeAt(0);
      var isLetter = (firstCode >= 65 && firstCode <= 90) || (firstCode >= 97 && firstCode <= 122);
      var separator = value.charAt(2);
      return isLetter && (separator === '/' || separator === String.fromCharCode(92));
    }

    function readReferenceInteger(value, fallback) {
      var number = Number(value);
      if (!Number.isFinite(number) || number < 1) {
        return fallback;
      }
      return Math.floor(number);
    }

    function formatBytes(bytes) {
      if (bytes < 1024) return bytes + ' B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
      return (bytes / 1024 / 1024).toFixed(1) + ' MB';
    }

    vscode.postMessage({ type: 'ready' });`;
}
