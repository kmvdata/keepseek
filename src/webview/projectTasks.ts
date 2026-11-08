/** Project task view chrome. Runtime and session ownership remain entirely in the host. */
export function getProjectTasksTemplate(): string {
  return `
    <nav id="projectTasks" class="project-tasks hidden" aria-label="Project tasks" data-i18n-aria-label="projectTasksTitle">
      <button id="projectSidebarToggle" type="button" class="project-rail-control" aria-controls="projectTaskSidebar" aria-expanded="false" data-i18n-title="projectOpenTasks" data-i18n-aria-label="projectOpenTasks">☰</button>
      <button id="projectAssistantView" type="button" class="project-rail-control" data-i18n-title="projectAssistant" data-i18n-aria-label="projectAssistant">✦</button>
      <button id="projectNewTask" type="button" class="project-rail-control" data-i18n-title="projectNewTask" data-i18n-aria-label="projectNewTask">+</button>
      <div id="projectTaskRailList" class="project-task-rail-list" role="list"></div>
      <button id="projectTaskHistory" type="button" class="project-rail-control" data-i18n-title="projectAllTasks" data-i18n-aria-label="projectAllTasks">◷</button>
      <span id="projectTaskAnnouncements" class="project-task-announcements" role="status" aria-live="polite" aria-atomic="true"></span>
    </nav>`;
}

/** Anchored to the transcript stage; never participates in its flex geometry. */
export function getProjectTasksOverlayTemplate(): string {
  return `
    <aside id="projectTaskSidebar" class="project-task-sidebar hidden" aria-label="Project tasks" data-i18n-aria-label="projectTasksTitle">
      <div class="project-sidebar-header">
        <strong data-i18n="projectTasksTitle">项目任务</strong>
        <button id="projectSidebarClose" type="button" class="secondary" data-i18n-title="projectCloseTasks" data-i18n-aria-label="projectCloseTasks">×</button>
      </div>
      <div class="project-sidebar-ranges">
        <select id="projectTaskScope" data-i18n-aria-label="projectTaskScope" aria-label="Task range">
          <option value="recent" data-i18n="projectRecentTasks">最近24小时</option>
          <option value="all" data-i18n="projectAllTasks">全部任务</option>
        </select>
        <label><input id="projectShowArchived" type="checkbox" /><span data-i18n="projectShowArchived">显示归档</span></label>
        <details id="projectTaskMore" class="project-task-more">
          <summary data-i18n="projectMoreActions">更多</summary>
          <div class="project-task-more-menu">
            <button id="projectAssociateSession" type="button" class="secondary" data-i18n="projectAssociateSession">关联当前会话</button>
            <button id="projectStopAll" type="button" class="secondary" data-i18n="projectStopAll">停止全部</button>
          </div>
        </details>
      </div>
      <div class="project-sidebar-content">
        <div id="projectTiming" class="project-task-metrics hidden"></div>
        <div id="projectRouterUsage" class="project-task-metrics hidden"></div>
        <div id="projectTaskList" class="project-task-list" role="list"></div>
        <div id="projectTaskDetail" class="project-task-detail"></div>
      </div>
    </aside>
    <div id="projectTaskTooltip" class="project-task-tooltip hidden" role="tooltip"></div>`;
}

export function getProjectTasksStyles(): string {
  return `
    .project-workspace { flex: 1; min-height: 0; min-width: 0; display: flex; overflow: hidden; }
    .project-main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
    .project-transcript-stage { position: relative; flex: 1; min-height: 0; min-width: 0; display: flex; flex-direction: column; isolation: isolate; }
    .project-tasks { flex: 0 0 44px; width: 44px; min-height: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 4px 2px; border-right: 1px solid var(--vscode-panel-border); }
    .project-rail-control { flex: 0 0 36px; width: 36px; height: 36px; padding: 0; color: var(--vscode-foreground); background: transparent; font-size: 18px; }
    .project-task-rail-list { flex: 1; min-height: 0; width: 40px; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; }
    .project-task-rail-item { height: 42px; width: 38px; display: flex; align-items: center; justify-content: center; }
    .project-task-announcements { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .project-task-lamp { width: 36px; height: 36px; min-height: 36px; padding: 3px; background: transparent; border-radius: 6px; }
    .project-task-lamp:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .project-task-lamp.is-selected { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .project-task-sidebar { position: absolute; inset: 0 auto 0 0; width: min(288px, 100%); min-width: 0; display: flex; flex-direction: column; z-index: 20; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-right: 1px solid var(--vscode-panel-border); box-shadow: 4px 0 12px var(--vscode-widget-shadow, #0005); }
    .project-sidebar-header { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; gap: 4px; }
    .project-sidebar-header button { padding: 2px 7px; }
    .project-sidebar-ranges { flex: 0 0 auto; display: flex; gap: 5px; flex-wrap: wrap; align-items: center; padding: 3px 8px 6px; font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border); }
    .project-sidebar-ranges select { min-width: 0; max-width: 100%; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); }
    .project-sidebar-ranges label { display: inline-flex; align-items: center; gap: 2px; }
    .project-sidebar-content { min-height: 0; overflow-y: auto; padding: 6px; }
    .project-task-more { position: relative; margin-left: auto; }
    .project-task-more summary { cursor: pointer; }
    .project-task-more:not([open]) .project-task-more-menu { display: none; }
    .project-task-more-menu { position: absolute; top: 100%; right: 0; z-index: 2; display: grid; gap: 3px; min-width: min(130px, calc(100vw - 56px)); max-width: min(230px, calc(100vw - 56px)); padding: 5px; background: var(--vscode-menu-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-panel-border); box-shadow: 0 2px 7px var(--vscode-widget-shadow, #0005); }
    .project-task-list { display: grid; gap: 4px; margin-top: 6px; }
    .project-task-card { min-width: 0; border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 6px; background: var(--vscode-sideBar-background); }
    .project-task-card.is-selected { border-color: var(--vscode-focusBorder); }
    .project-task-open { appearance: none; display: flex; gap: 7px; align-items: flex-start; border: 0; padding: 0; width: 100%; background: transparent; color: var(--vscode-foreground); text-align: left; font: inherit; cursor: pointer; }
    .project-task-copy { flex: 1; min-width: 0; }
    .project-task-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-weight: 600; overflow-wrap: anywhere; }
    .project-task-phase, .project-task-progress, .project-task-metrics, .project-task-first, .project-task-current { font-size: 11px; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); }
    .project-task-progress { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .project-task-current { color: var(--vscode-focusBorder); }
    .project-task-metrics { margin-top: 2px; }
    .project-task-detail { margin-top: 7px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); }
    .project-task-detail h3 { margin: 3px 0; font-size: 12px; overflow-wrap: anywhere; }
    .project-task-actions { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
    .project-task-actions button, .project-task-more-menu button { font: inherit; font-size: 11px; padding: 3px 7px; min-height: 25px; }
    .project-task-ring { --task-status-color: var(--vscode-charts-orange, #c88b36); position: relative; display: inline-flex; flex: 0 0 28px; width: 28px; height: 28px; align-items: center; justify-content: center; vertical-align: middle; }
    .project-task-ring svg { position: absolute; inset: 0; width: 28px; height: 28px; transform: rotate(-90deg); overflow: visible; }
    .project-task-ring-track { fill: none; stroke: var(--vscode-widget-border, var(--vscode-descriptionForeground)); opacity: .4; stroke-width: 2.5; }
    .project-task-ring-arc { fill: none; stroke: var(--vscode-progressBar-background, var(--vscode-focusBorder, #6796e6)); stroke-width: 2.5; }
    .project-task-ring[data-usage-status="unknown"] .project-task-ring-track { stroke-dasharray: 2 3; }
    .project-task-ring[data-state="completed"] { --task-status-color: var(--vscode-charts-green, #388a34); }
    .project-task-ring[data-state="failed"], .project-task-ring[data-state="cancelled"], .project-task-ring[data-state="interrupted"] { --task-status-color: var(--vscode-charts-red, #c94f4f); }
    .project-task-status-icon { width: 19px; height: 19px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: var(--vscode-sideBar-background, #fff); background: var(--task-status-color); font-size: 12px; font-weight: bold; line-height: 1; }
    .project-task-tooltip { position: fixed; z-index: 35; max-width: min(320px, calc(100vw - 12px)); max-height: min(300px, calc(100vh - 12px)); overflow: auto; pointer-events: auto; white-space: pre-line; overflow-wrap: anywhere; padding: 7px 9px; color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, #0005); font-size: 11px; }
    .project-view-status { flex: 0 0 auto; display: flex; align-items: center; gap: 5px; font-size: 11px; }
    .project-view-status:has(> .hidden):not(:has(> :not(.hidden))) { display: none; }
    .project-owner-notice { flex: 1; color: var(--vscode-inputValidation-warningForeground, var(--vscode-descriptionForeground)); padding: 3px 6px; }
    .project-view-status button { font-size: 11px; padding: 2px 6px; }
    .project-input-target { flex: 0 0 auto; font-size: 11px; padding: 3px 6px; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); }
    .project-tasks button:focus-visible, .project-task-sidebar button:focus-visible, .project-task-sidebar select:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    @media (forced-colors: active) { .project-task-status-icon { forced-color-adjust: none; color: Canvas; background: CanvasText; } .project-task-ring-arc { stroke: Highlight; } .project-task-lamp.is-selected { outline: 2px solid Highlight; } }
    @media (prefers-reduced-motion: reduce) { .project-task-ring, .project-task-sidebar { animation: none; transition: none; } }
  `;
}

export function getProjectTasksScript(): string {
  return `
    var projectTasks = null;
    var projectViewMode = 'project';
    var projectViewGeneration = 0;
    var projectPendingInputs = new Map();
    var projectDrafts = new Map();
    var projectHotViews = new Map();
    var projectDraftTimer = null;
    var projectCompositionActive = false;
    var projectRestoreInProgress = false;
    var projectLastPaintKey = '';
    var projectStateRevisions = new Map();
    var projectRetiredHosts = new Set();
    var projectLatestPendingTarget = '';
    var projectSidebarOpen = false;
    var projectSidebarScope = 'recent';
    var projectSidebarPreferences = {};
    var projectRailNodes = new Map();
    var projectRowNodes = new Map();
    var projectTooltipTarget = null;
    var projectTooltipHideTimer = null;
    var projectExpiryTimer = null;
    var projectDeferredView = null;
    var projectDeferredNavigation = null;
    var projectDeferredHostState = null;
    var projectDeferredSubmissionResults = new Map();
    var projectLegacyDraftRestorePending = false;
    var projectCompositionTimer = null;
    var projectDetailKey = '';
    var projectSidebarScroll = 0;
    var projectSidebarDisposed = false;
    var projectAnnouncedStates = new Map();
    var projectPendingAnnouncements = new Map();
    var projectAnnouncementTimer = null;

    function projectStateRevisionKey(message) {
      if (!projectTaskUiActive()) return '$legacy';
      return '$task:' + String(message?.taskCardId || projectTasks.viewTaskId || '$router');
    }

    function projectTaskUiActive() { return !!projectTasks && projectViewMode !== 'legacy'; }

    function projectTargetId() {
      if (!projectTasks) return '';
      return projectViewMode === 'new' ? '$new' : (projectTasks.viewTaskId || '$project');
    }

    function projectDraftKey(targetId) { return String(projectTasks?.projectId || '') + ':' + targetId; }
    function projectCurrentCard() {
      return (projectTasks?.cards || []).find(function(card) { return card.id === projectTasks.viewTaskId || card.taskCardId === projectTasks.viewTaskId; });
    }
    function projectCardId(card) { return String(card.id || card.taskCardId || ''); }
    function projectCardIsActive(card) { return ['queued', 'preparing', 'running', 'waiting', 'settling', 'stopping'].includes(card?.state || card?.status || card?.phase); }
    function projectCanSubmit() {
      return !!projectTasks && !projectTasks.readOnly && !projectPendingInputs.has(projectTargetId())
        && (projectViewMode !== 'task' || !!projectCurrentCard()) && (projectCurrentCard()?.state || projectCurrentCard()?.status || projectCurrentCard()?.phase) !== 'stopping';
    }

    function projectSaveLocalDrafts() {
      if (!vscode.setState || !projectTasks) return;
      try {
      var saved = vscode.getState ? (vscode.getState() || {}) : {};
      saved.projectTaskDrafts = Array.from(projectDrafts.entries());
      saved.projectTaskPendingInputs = Array.from(projectPendingInputs.entries());
      saved.projectTaskView = { projectId: projectTasks.projectId, targetId: projectTargetId(), viewGeneration: projectViewGeneration };
      vscode.setState(saved);
      } catch (_error) { /* Local UI storage failure never changes durable input authority. */ }
    }

    function projectCursorOffsets() {
      var selection = window.getSelection();
      if (!selection?.rangeCount || !promptInput.contains(selection.anchorNode)) return null;
      try {
        var range = selection.getRangeAt(0), before = range.cloneRange();
        before.selectNodeContents(promptInput); before.setEnd(range.startContainer, range.startOffset);
        var start = before.toString().length;
        return { start: start, end: start + range.toString().length };
      } catch (_error) { return null; }
    }

    function projectScrollAnchor() {
      var viewport = transcript.getBoundingClientRect();
      var row = Array.from(transcript.querySelectorAll('.message[data-message-id]')).find(function(item) { return item.getBoundingClientRect().bottom >= viewport.top; });
      return row ? { messageId: row.dataset.messageId, offset: row.getBoundingClientRect().top - viewport.top } : null;
    }
    function projectRestoreScroll(draft) {
      if (!draft) return;
      if (typeof draft.scrollTop === 'number') transcript.scrollTop = draft.scrollTop;
      var anchor = draft.scrollAnchor;
      if (anchor?.messageId) {
        var row = Array.from(transcript.querySelectorAll('.message[data-message-id]')).find(function(item) { return item.dataset.messageId === anchor.messageId; });
        if (row) transcript.scrollTop += row.getBoundingClientRect().top - transcript.getBoundingClientRect().top - (Number(anchor.offset) || 0);
      }
    }

    function projectCaptureDraft(increment) {
      if (!projectTaskUiActive() || projectRestoreInProgress) return null;
      var targetId = projectTargetId(), key = projectDraftKey(targetId);
      var previous = projectDrafts.get(key);
      var markup = promptInput.innerHTML, cursor = projectCursorOffsets(), skillIds = getActiveSkillIdsForRequest();
      var awaitingLatest = projectLatestPendingTarget === key;
      var scrollTop = awaitingLatest ? 0 : Number(transcript.scrollTop) || 0, scrollAnchor = awaitingLatest ? null : projectScrollAnchor();
      // Old details state remains audit-compatible; sidebar preference is window/project UI.
      var expanded = typeof previous?.expanded === 'boolean' ? previous.expanded : true;
      var changed = !previous || previous.markup !== markup || previous.scrollTop !== scrollTop || previous.expanded !== expanded
        || JSON.stringify(previous.scrollAnchor) !== JSON.stringify(scrollAnchor) || JSON.stringify(previous.cursor) !== JSON.stringify(cursor) || JSON.stringify(previous.skillIds || []) !== JSON.stringify(skillIds);
      var draft = { targetId: targetId, revision: (previous?.revision || 0) + (changed ? 1 : 0),
        markup: markup, skillIds: skillIds, cursor: cursor, scrollTop: scrollTop, scrollAnchor: scrollAnchor, expanded: expanded };
      if (!draft.revision) draft.revision = 1;
      projectDrafts.set(key, draft); projectSaveLocalDrafts();
      return draft;
    }

    function projectFlushDraft() {
      if (projectDraftTimer) { clearTimeout(projectDraftTimer); projectDraftTimer = null; }
      var draft = projectCaptureDraft(true);
      if (draft) vscode.postMessage(Object.assign({ type: 'projectTaskDraft', projectId: projectTasks.projectId }, draft));
    }

    function projectRestoreCursor(cursor) {
      if (!cursor || !document.createTreeWalker) return;
      try {
        var walker = document.createTreeWalker(promptInput, NodeFilter.SHOW_TEXT), node, offset = 0, start = null, end = null;
        while ((node = walker.nextNode())) {
          var length = String(node.textContent || '').length;
          if (!start && cursor.start <= offset + length) start = { node: node, offset: Math.max(0, cursor.start - offset) };
          if (!end && cursor.end <= offset + length) end = { node: node, offset: Math.max(0, cursor.end - offset) };
          offset += length;
        }
        if (start && end) {
          var range = document.createRange(); range.setStart(start.node, start.offset); range.setEnd(end.node, end.offset);
          var selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }
      } catch (_error) { /* A stale caret does not alter the durable draft. */ }
    }

    function projectRestoreDraft(targetId, supplied) {
      var key = projectDraftKey(targetId), local = projectDrafts.get(key);
      if (supplied && supplied.targetId === targetId && (!local || supplied.revision > local.revision)) {
        local = supplied; projectDrafts.set(key, supplied);
      }
      projectRestoreInProgress = true;
      state.skills = Object.assign({}, state.skills, { activeSkillIds: Array.isArray(local?.skillIds) ? local.skillIds : [] });
      if (window.keepseekInputControls?.restoreDraft) window.keepseekInputControls.restoreDraft(local?.markup || '');
      else promptInput.innerHTML = local?.markup || '';
      projectRestoreInProgress = false;
      if (local) {
        projectRestoreScroll(local);
        projectRestoreCursor(local.cursor);
        // local.expanded belongs to the removed details control, never the sidebar.
      }
      projectSaveLocalDrafts();
    }

    function projectRememberHotView() {
      if (!projectTaskUiActive()) return;
      var draft = projectDrafts.get(projectDraftKey(projectTargetId())), messages = state.messages;
      var anchorIndex = draft?.scrollAnchor?.messageId ? messages.findIndex(function(message) { return message.id === draft.scrollAnchor.messageId; }) : -1;
      var start = anchorIndex >= 0 ? Math.max(0, Math.min(messages.length - 30, anchorIndex - 15)) : Math.max(0, messages.length - 30);
      var end = Math.min(messages.length, start + 30);
      projectHotViews.set(projectDraftKey(projectTargetId()), { messages: messages.slice(start, end),
        hasOlderMessages: state.hasOlderMessages || start > 0, hasNewerMessages: state.hasNewerMessages || end < messages.length,
        sessionId: state.activeSessionId, stateRevision: lastStateRevision, changeSets: state.changeSets, draftRuns: state.draftRuns, taskPlan: state.taskPlan, repairLoop: state.repairLoop, planWorkflows: state.planWorkflows });
      if (projectHotViews.size > 8) projectHotViews.delete(projectHotViews.keys().next().value);
    }

    function projectDeferNavigation(message) {
      projectDeferredView = null;
      projectDeferredNavigation = { message: Object.assign({}, message), projectId: projectTasks?.projectId, hostId: projectTasks?.hostId, sourceTarget: projectTargetId(), sourceMode: projectViewMode, generation: projectViewGeneration };
    }
    function projectSelectView(taskCardId, mode) {
      if (!projectTasks) return;
      if (taskCardId && !(projectTasks.cards || []).some(function(card) { return projectCardId(card) === taskCardId && !card.deleted; })) return;
      if (projectCompositionActive || projectCompositionTimer) {
        projectDeferredNavigation = null;
        projectDeferredView = { projectId: projectTasks.projectId, hostId: projectTasks.hostId, sourceTarget: projectTargetId(), generation: projectViewGeneration, taskCardId: taskCardId || null, mode: mode };
        return;
      }
      projectDeferredView = null; projectDeferredNavigation = null; projectDeferredHostState = null;
      projectSetSidebarOpen(false, false);
      if (projectViewMode === 'legacy' && state.activeSessionId) sessionPromptDrafts.set(state.activeSessionId, promptInput.innerHTML);
      projectFlushDraft(); projectRememberHotView();
      projectTasks.viewTaskId = taskCardId || null;
      projectViewMode = mode || (taskCardId ? 'task' : 'project');
      projectViewGeneration += 1;
      var targetId = projectTargetId(), hot = projectHotViews.get(projectDraftKey(targetId));
      state.messages = hot?.messages || []; state.hasOlderMessages = !!hot?.hasOlderMessages;
      state.hasNewerMessages = !!hot?.hasNewerMessages;
      lastStateRevision = hot?.stateRevision || 0;
      state.activeSessionId = hot?.sessionId || projectCurrentCard()?.sessionId || '';
      state.changeSets = hot?.changeSets || []; state.draftRuns = hot?.draftRuns || []; state.taskPlan = hot?.taskPlan || null;
      state.repairLoop = hot?.repairLoop || null; state.planWorkflows = hot?.planWorkflows || [];
      state.draftRunBatchSnapshots = []; state.draftRunBatch = null; state.activeDraftRunId = '';
      state.isBusy = false; delete state.interaction;
      render(); projectRestoreDraft(targetId); renderProjectTasks();
      vscode.postMessage({ type: 'projectTaskView', projectId: projectTasks.projectId, taskCardId: taskCardId || null,
        mode: projectViewMode, viewGeneration: projectViewGeneration });
      projectConfirmPaint();
      promptInput.focus();
    }

    function projectShowLatestMessages() {
      if (!projectTaskUiActive()) return;
      projectFlushDraft();
      var key = projectDraftKey(projectTargetId()), draft = projectDrafts.get(key);
      if (draft) {
        draft = Object.assign({}, draft, { scrollAnchor: null, scrollTop: 0, revision: draft.revision + 1 });
        projectDrafts.set(key, draft);
        vscode.postMessage(Object.assign({ type: 'projectTaskDraft', projectId: projectTasks.projectId }, draft));
      }
      projectLatestPendingTarget = key; state.hasNewerMessages = false;
      projectHotViews.delete(key); projectSaveLocalDrafts(); renderProjectTasks();
      vscode.postMessage({ type: 'projectTaskLatest', projectId: projectTasks.projectId, taskCardId: projectTasks.viewTaskId || null,
        viewGeneration: projectViewGeneration });
    }

    function projectBeginSubmission(prompt) {
      if (!projectCanSubmit()) return null;
      projectFlushDraft();
      var targetId = projectTargetId(), draft = projectDrafts.get(projectDraftKey(targetId));
      var requestId = 'task-input-' + Date.now().toString(36) + '-' + (++submissionSequence);
      projectPendingInputs.set(targetId, { requestId: requestId, prompt: prompt, draftRevision: draft?.revision || 1,
        projectId: projectTasks.projectId, targetId: targetId });
      projectSaveLocalDrafts();
      setTransientStatus(t('projectSavingInput'));
      return requestId;
    }

    function postPromptMessage(message) {
      if (!projectTaskUiActive() || message.type !== 'sendPrompt') { vscode.postMessage(message); return; }
      var targetId = projectTargetId(), pending = projectPendingInputs.get(targetId), card = projectCurrentCard();
      if (!pending || pending.requestId !== message.requestId) return;
      var type = targetId === '$new' ? 'projectTaskCreate' : targetId === '$project' ? 'projectAssistantSubmit' : 'projectTaskSubmit';
      vscode.postMessage(Object.assign({}, message, { type: type, projectId: projectTasks.projectId,
        targetId: targetId, taskCardId: card ? projectCardId(card) : undefined, rootTaskId: card?.rootTaskId,
        inputKind: projectCardIsActive(card) ? 'supplement' : 'followup', draftRevision: pending.draftRevision,
        viewGeneration: projectViewGeneration }));
      renderProjectTasks();
    }

    function projectApplySubmissionResult(message) {
      if (!projectTasks || message.projectId !== projectTasks.projectId) return;
      var targetId = String(message.targetId || ''), pending = projectPendingInputs.get(targetId);
      if (!pending || pending.requestId !== message.requestId || !['accepted', 'rejected', 'failed'].includes(message.status)) return;
      if (message.status === 'accepted' && targetId === projectTargetId() && (projectCompositionActive || projectCompositionTimer)) {
        projectDeferredSubmissionResults.set(message.requestId, message); return;
      }
      projectPendingInputs.delete(targetId);
      var key = projectDraftKey(targetId), draft = projectDrafts.get(key);
      if (message.status === 'accepted') {
        // ACK can clear only the exact submitted revision, even after a view switch.
        if (draft && draft.revision === pending.draftRevision) {
          draft = Object.assign({}, draft, { markup: '', cursor: null, revision: draft.revision + 1 }); projectDrafts.set(key, draft);
          if (projectTargetId() === targetId) {
            projectRestoreInProgress = true;
            window.keepseekInputControls?.acceptSubmission(pending.prompt);
            projectRestoreInProgress = false;
          }
          vscode.postMessage(Object.assign({ type: 'projectTaskDraft', projectId: projectTasks.projectId }, draft));
        }
        if (projectTargetId() === targetId) setTransientStatus(t('projectInputAccepted'));
      } else {
        var failure = String(message.reason || t('submissionNotAccepted'));
        var failedCard = projectTasks.cards.find(function(card) { return projectCardId(card) === targetId; });
        var failedTarget = targetId === '$new' ? t('projectNewTask') : targetId === '$project' ? t('projectAssistant') : failedCard?.title || t('projectUntitledTask');
        setTransientStatus(projectTargetId() === targetId ? failure : t('projectInputFailedTarget', { target: failedTarget, reason: failure }), false, 'global');
      }
      projectSaveLocalDrafts();
      renderProjectTasks(); window.keepseekInputControls?.render(); syncSendButtonAvailability();
    }

    function projectApplyState(message) {
      var previousControlsKey = projectControlsKey();
      var previousWasProjectView = projectTaskUiActive();
      if (!message.projectId || message.hostId && projectRetiredHosts.has(message.projectId + ':' + message.hostId)) return;

      var hostChanged = !!message.hostId && !!projectTasks && message.hostId !== projectTasks.hostId;
      if ((projectCompositionActive || projectCompositionTimer) && projectTasks && (hostChanged || message.projectId !== projectTasks.projectId)) {
        projectDeferredView = null; projectDeferredNavigation = null; projectDeferredHostState = message; return;
      }
      if (hostChanged && projectTasks.hostId) projectRetiredHosts.add(projectTasks.projectId + ':' + projectTasks.hostId);
      var first = !projectTasks || projectTasks.projectId !== message.projectId || hostChanged;
      if (first) {
        if (projectViewMode === 'legacy' && state.activeSessionId) sessionPromptDrafts.set(state.activeSessionId, promptInput.innerHTML);
        projectTasks = { projectId: message.projectId, hostId: message.hostId, cards: [], viewTaskId: null, readOnly: false, revision: 0 };
        projectHotViews.clear(); projectPendingInputs.clear();
        projectDeferredSubmissionResults.clear();
        if (hostChanged) { projectStateRevisions.clear(); lastStateRevision = 0; }
        projectViewMode = 'project'; projectViewGeneration = 0;
        var saved = null; try { saved = vscode.getState ? vscode.getState() : null; } catch (_error) { /* UI preference failure does not lock input. */ }
        projectSidebarPreferences = saved?.projectTaskSidebar && typeof saved.projectTaskSidebar === 'object' ? saved.projectTaskSidebar : {};
        var preference = projectSidebarPreferences[message.projectId];
        projectSidebarOpen = preference?.open === true;
        projectSidebarScope = preference?.scope === 'all' ? 'all' : 'recent';
        projectSidebarScroll = Number.isFinite(preference?.scrollTop) ? Math.max(0, preference.scrollTop) : 0;
        document.getElementById('projectTaskScope').value = projectSidebarScope;
        document.getElementById('projectShowArchived').checked = preference?.showArchived === true;
        projectRailNodes.forEach(function(node) { node.remove(); }); projectRailNodes.clear();
        projectRowNodes.forEach(function(node) { node.remove(); }); projectRowNodes.clear();
        projectAnnouncedStates.clear(); projectPendingAnnouncements.clear();
        if (projectAnnouncementTimer) { clearTimeout(projectAnnouncementTimer); projectAnnouncementTimer = null; }
        projectSetText(document.getElementById('projectTaskAnnouncements'), '');
        projectDetailKey = ''; projectHideTooltip(); projectDeferredView = null; projectDeferredNavigation = null; projectDeferredHostState = null;
        if (Array.isArray(saved?.projectTaskDrafts)) saved.projectTaskDrafts.forEach(function(entry) { if (Array.isArray(entry) && entry.length === 2) projectDrafts.set(entry[0], entry[1]); });
        if (Array.isArray(saved?.projectTaskPendingInputs)) saved.projectTaskPendingInputs.forEach(function(entry) {
          if (Array.isArray(entry) && entry.length === 2 && entry[1]?.projectId === message.projectId) projectPendingInputs.set(entry[0], entry[1]);
        });
        projectPendingInputs.forEach(function(pending) { vscode.postMessage({ type: 'projectTaskReconcile', projectId: message.projectId, targetId: pending.targetId, requestId: pending.requestId }); });
      }
      var revision = Number(message.revision) || 0;
      if (revision && revision < (projectTasks.revision || 0)) return;
      var generation = Number(message.viewGeneration) || 0;
      var acceptsView = first || generation >= projectViewGeneration;
      if (message.enabled === false) {
        var enteringLegacy = acceptsView && projectViewMode !== 'legacy';
        if (enteringLegacy && (projectCompositionActive || projectCompositionTimer)) { projectDeferredHostState = message; return; }
        if (enteringLegacy) {
          projectFlushDraft(); projectRememberHotView(); projectViewMode = 'legacy';
          projectLegacyDraftRestorePending = previousWasProjectView;
          projectTasks.viewTaskId = null; lastStateRevision = projectStateRevisions.get('$legacy') || 0;
        }
        if (Array.isArray(message.cards)) projectTasks.cards = message.cards;
        if (Array.isArray(message.results)) projectTasks.results = message.results;
        if (Array.isArray(message.routerUsage)) projectTasks.routerUsage = message.routerUsage;
        if (message.timing) projectTasks.timing = message.timing;
        if (Object.prototype.hasOwnProperty.call(message, 'readOnly')) projectTasks.readOnly = message.readOnly === true;
        if (revision) projectTasks.revision = revision;
        if (acceptsView && projectViewMode === 'legacy') projectViewGeneration = Math.max(projectViewGeneration, generation);
        // Ordinary history remains its own view. Background task metadata cannot
        // rebuild its transcript, menus, composer or an active IME composition.
        if (enteringLegacy) render();
        else {
          renderProjectTasks();
          if (previousControlsKey !== projectControlsKey()) window.keepseekInputControls?.render();
          syncSendButtonAvailability();
        }
        return;
      }
      if (Array.isArray(message.cards)) projectTasks.cards = message.cards;
      if (Array.isArray(message.results)) projectTasks.results = message.results;
      if (Array.isArray(message.routerUsage)) projectTasks.routerUsage = message.routerUsage;
      if (message.timing) projectTasks.timing = message.timing;
      if (Object.prototype.hasOwnProperty.call(message, 'readOnly')) projectTasks.readOnly = message.readOnly === true;
      if (revision) projectTasks.revision = revision;
      if ((projectCompositionActive || projectCompositionTimer) && !first && generation >= projectViewGeneration &&
        (generation > projectViewGeneration || Object.prototype.hasOwnProperty.call(message, 'viewTaskId') && message.viewTaskId !== projectTasks.viewTaskId)) {
        projectDeferredHostState = message; renderProjectTasks(); return;
      }
      if (first || generation >= projectViewGeneration) {
        var viewChanged = first || generation > projectViewGeneration || (Object.prototype.hasOwnProperty.call(message, 'viewTaskId') && message.viewTaskId !== projectTasks.viewTaskId);
        if (first || generation > projectViewGeneration || (Object.prototype.hasOwnProperty.call(message, 'viewTaskId') && message.viewTaskId !== projectTasks.viewTaskId)) {
          if (!first) {
            if (projectViewMode === 'legacy' && state.activeSessionId) sessionPromptDrafts.set(state.activeSessionId, promptInput.innerHTML);
            projectFlushDraft(); projectRememberHotView();
          }
          projectTasks.viewTaskId = message.viewTaskId || null;
          projectViewMode = message.viewMode || (message.viewTaskId ? 'task' : 'project');
        }
        projectViewGeneration = Math.max(projectViewGeneration, generation);
        if (Array.isArray(message.messages)) {
          state.messages = message.messages; state.hasOlderMessages = !!message.hasOlderMessages; state.hasNewerMessages = !!message.hasNewerMessages;
        }
        if (message.sessionId) state.activeSessionId = message.sessionId;
        if (first && !Array.isArray(message.messages)) { state.messages = []; state.hasOlderMessages = false; state.hasNewerMessages = false; }
        if (viewChanged) lastStateRevision = projectStateRevisions.get(projectStateRevisionKey()) || 0;
        if (viewChanged || Array.isArray(message.messages)) render();
        var localDraft = projectDrafts.get(projectDraftKey(projectTargetId()));
        if (viewChanged || (!projectCompositionActive && !projectCompositionTimer && message.draft && (!localDraft || message.draft.revision > localDraft.revision))) projectRestoreDraft(projectTargetId(), message.draft);
        else if (Array.isArray(message.messages)) projectRestoreScroll(localDraft);
        if (Array.isArray(message.messages) && projectLatestPendingTarget === projectDraftKey(projectTargetId())) {
          projectLatestPendingTarget = ''; transcript.scrollTop = transcript.scrollHeight;
          projectFlushDraft();
        }
      }
      renderProjectTasks(); if (first) document.querySelector('.project-sidebar-content').scrollTop = projectSidebarScroll; if (previousControlsKey !== projectControlsKey()) window.keepseekInputControls?.render(); syncSendButtonAvailability(); projectConfirmPaint();
    }

    function projectFormatTime(milliseconds) {
      var total = Math.max(0, Math.floor((Number(milliseconds) || 0) / 1000));
      var days = Math.floor(total / 86400), hours = Math.floor(total / 3600) % 24, minutes = Math.floor(total / 60) % 60;
      var value = [hours, minutes, total % 60].map(function(part) { return String(part).padStart(2, '0'); }).join(':');
      return days ? days + ' ' + value : value;
    }
    function projectProgress(card) {
      var progress = String(card.error || card.progress || card.lastProgress || card.lastError || '');
      if (progress === 'idle') return '';
      var pool = agentStatusPools[progress];
      return pool?.length ? t(pool[0]) : progress === 'reconnecting' ? t('projectReconnecting') : progress;
    }
    function projectPhase(card) {
      var phase = String(card.state || card.status || card.phase || 'queued');
      var reason = String(card.waitingReason || ''), key = 'projectWaiting_' + reason;
      if (reason.startsWith('dependency:')) { var dependency = projectTasks.cards.find(function(item) { return projectCardId(item) === reason.slice(11); }); return t('projectPhase_' + phase) + ' · ' + t('projectWaitingDependency', { target: dependency?.title || t('projectUntitledTask') }); }
      return t('projectPhase_' + phase) + (reason ? ' · ' + (t(key) !== key ? t(key) : reason) : '');
    }
    function projectTaskAction(type, card, extra) {
      if (!projectTasks || projectTasks.readOnly) return;
      projectFlushDraft();
      vscode.postMessage(Object.assign({ type: type, projectId: projectTasks.projectId, hostId: projectTasks.hostId,
        taskCardId: projectCardId(card), sessionId: card.sessionId, rootTaskId: card.rootTaskId,
        segmentId: card.segmentId, generation: card.generation }, extra || {}));
    }
    function projectButton(labelKey, listener, disabled) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = t(labelKey); button.disabled = !!disabled;
      button.addEventListener('click', listener); return button;
    }
    function projectControlsKey() { return projectTasks ? [projectTasks.projectId, projectViewMode, projectTasks.viewTaskId || '', projectViewGeneration, projectTasks.readOnly, projectCanSubmit()].join('|') : ''; }
    function projectSetText(node, value) { if (node.textContent !== value) node.textContent = value; }
    function projectTaskTitle(card) { return String(card.customTitle || card.title || t('projectUntitledTask')); }
    function projectDate(value) { var parsed = typeof value === 'string' ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : null; }
    function projectFirstTime(card) {
      var key = { user_input: 'projectFirstSubmitted', session_created: 'projectSessionCreated', associated: 'projectJoinedList', task_created: 'projectTaskCreated' }[card.firstSubmittedAtSource] || 'projectTaskCreated';
      var value = projectDate(card.firstSubmittedAt) ?? projectDate(card.createdAt);
      return t(key) + ': ' + (value === null ? t('projectTimeUnknown') : new Date(value).toLocaleString(state.language || undefined));
    }
    function projectOrderedCards() {
      // Registry order is the persisted tie-break. Sort a projection, never authority.
      return (projectTasks?.cards || []).map(function(card, index) { return { card: card, index: index, time: projectDate(card.firstSubmittedAt) ?? projectDate(card.createdAt) ?? 0 }; })
        .filter(function(item) { return !item.card.deleted; })
        .sort(function(a, b) { return a.time - b.time || a.index - b.index || projectCardId(a.card).localeCompare(projectCardId(b.card)); })
        .map(function(item) { return item.card; });
    }
    function projectRecentCard(card, now, keepCurrent) {
      if (projectCardIsActive(card)) return true;
      if (card.archived) return false;
      if ((card.state || card.status || card.phase) === 'interrupted') return true;
      var activity = projectDate(card.lastActivityAt);
      if (activity !== null && now - activity < 86400000) return true;
      return !!keepCurrent && projectViewMode === 'task' && projectTasks.viewTaskId === projectCardId(card);
    }
    function projectUsage(card) {
      var snapshot = card.contextUsageSnapshot, usage = snapshot?.usage;
      if (!usage || !Number.isFinite(usage.usedPercent) || usage.usedPercent < 0 || !Number.isFinite(usage.usedTokensEstimate) || usage.usedTokensEstimate < 0 || !Number.isFinite(usage.maxTokensEstimate) || usage.maxTokensEstimate <= 0) return null;
      var ratio = usage.usedTokensEstimate / usage.maxTokensEstimate * 100;
      if (!Number.isFinite(ratio)) return null;
      if (Math.abs(usage.usedPercent - ratio) > 1 && !(usage.usedPercent === 100 && ratio > 100)) return null;
      return snapshot;
    }
    function projectUsageText(card) {
      var snapshot = projectUsage(card); if (!snapshot) return t('projectContextUsage') + ': ' + t('projectUsageUnknown');
      var usage = snapshot.usage, text = t('projectContextUsage') + ': ' + Math.round(usage.usedPercent * 10) / 10 + '% (' + Math.round(usage.usedTokensEstimate).toLocaleString() + ' / ' + Math.round(usage.maxTokensEstimate).toLocaleString() + ')';
      if (usage.usedTokensEstimate > usage.maxTokensEstimate) text += ' · ' + t('projectUsageOverLimit');
      if (snapshot.status !== 'current') text += ' · ' + t('projectUsageLastKnown') + (projectDate(snapshot.recordedAt) !== null ? ' ' + new Date(snapshot.recordedAt).toLocaleString(state.language || undefined) : '');
      return text;
    }
    function projectMetrics(card) {
      var ms = Number.isFinite(card.currentEffectiveMs) ? card.currentEffectiveMs : Number.isFinite(card.usedMs) ? card.usedMs : card.effectiveMs;
      var time = Number.isFinite(ms) && ms >= 0 ? (projectCardIsActive(card) && !Number.isFinite(card.currentEffectiveMs) ? '≥ ' : '') + projectFormatTime(ms) : t('projectTimeUnknown');
      var currencies = Object.keys(card.costByCurrency || {}).filter(function(currency) { return Number.isFinite(card.costByCurrency[currency]) && card.costByCurrency[currency] >= 0; });
      var cost = currencies.length ? t('projectReferenceCost') + ' ' + currencies.map(function(currency) { return currency + ' ' + Number(card.costByCurrency[currency]).toFixed(4); }).join(' · ') : t('projectCostUnknown');
      var counts = Number.isFinite(card.requestCount) ? ' · ' + t('usageRequestCountValue', { count: card.requestCount }) : '';
      if (Number.isFinite(card.totalTokens)) counts += ' · ' + card.totalTokens.toLocaleString() + ' tokens';
      return t('projectEffectiveTime') + ': ' + time + ' · ' + cost + counts + (card.usageIncomplete ? ' · ' + t('projectUsageIncomplete') : '');
    }
    function projectCreateRing() {
      var ring = document.createElement('span'); ring.className = 'project-task-ring';
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 28 28'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
      var track = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); track.setAttribute('cx', '14'); track.setAttribute('cy', '14'); track.setAttribute('r', '12'); track.setAttribute('class', 'project-task-ring-track');
      var arc = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); arc.setAttribute('cx', '14'); arc.setAttribute('cy', '14'); arc.setAttribute('r', '12'); arc.setAttribute('class', 'project-task-ring-arc');
      arc.setAttribute('pathLength', '100'); svg.append(track, arc);
      var icon = document.createElement('span'); icon.className = 'project-task-status-icon'; icon.setAttribute('aria-hidden', 'true'); ring.append(svg, icon);
      ring._arc = arc; ring._icon = icon; return ring;
    }
    function projectUpdateRing(ring, card) {
      var snapshot = projectUsage(card), phase = card.state || card.status || card.phase || 'queued';
      var signature = JSON.stringify([state.language, phase, snapshot ? [snapshot.status, snapshot.usage, snapshot.status === 'current' ? null : snapshot.recordedAt] : null]);
      if (ring._displaySignature === signature) return; ring._displaySignature = signature;
      ring.dataset.state = phase; ring.dataset.usageStatus = snapshot ? snapshot.status === 'current' ? 'current' : 'last_known' : 'unknown';
      ring._icon.textContent = ({ queued: '◷', preparing: '◇', running: '▶', waiting: 'Ⅱ', settling: '…', stopping: '■', completed: '✓', failed: '×', cancelled: '■', interrupted: '!' })[phase] || '?';
      ring.setAttribute('aria-label', projectUsageText(card));
      if (snapshot) {
        var percent = Math.max(0, Math.min(100, snapshot.usage.usedPercent));
        ring.setAttribute('role', 'progressbar'); ring.setAttribute('aria-valuemin', '0'); ring.setAttribute('aria-valuemax', '100'); ring.setAttribute('aria-valuenow', String(percent)); ring.setAttribute('aria-valuetext', projectUsageText(card));
        ring._arc.setAttribute('stroke-dasharray', percent + ' 100');
      } else {
        ring.setAttribute('role', 'img'); ['aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'].forEach(function(name) { ring.removeAttribute(name); });
        ring._arc.setAttribute('stroke-dasharray', '0 100');
      }
    }
    function projectTooltipText(card) { return [projectTaskTitle(card), projectFirstTime(card), projectPhase(card), projectUsageText(card), projectMetrics(card)].join('\\n'); }
    function projectHideTooltip() {
      if (projectTooltipHideTimer) { clearTimeout(projectTooltipHideTimer); projectTooltipHideTimer = null; }
      if (projectTooltipTarget?.button) projectTooltipTarget.button.removeAttribute('aria-describedby');
      projectTooltipTarget = null; document.getElementById('projectTaskTooltip')?.classList.add('hidden');
    }
    function projectShowTooltip(button, card) {
      if (projectTooltipHideTimer) { clearTimeout(projectTooltipHideTimer); projectTooltipHideTimer = null; }
      var tooltip = document.getElementById('projectTaskTooltip'); if (!tooltip) return;
      if (projectTooltipTarget?.button && projectTooltipTarget.button !== button) projectTooltipTarget.button.removeAttribute('aria-describedby');
      projectTooltipTarget = { button: button, id: projectCardId(card) }; projectSetText(tooltip, projectTooltipText(card)); tooltip.classList.remove('hidden'); button.setAttribute('aria-describedby', 'projectTaskTooltip');
      var anchor = button.getBoundingClientRect(), stage = document.querySelector('.project-transcript-stage')?.getBoundingClientRect();
      var width = window.innerWidth || document.documentElement.clientWidth, height = window.innerHeight || document.documentElement.clientHeight;
      var top = stage && stage.bottom > stage.top ? Math.max(6, stage.top + 3) : 6;
      var bottom = stage && stage.bottom > stage.top ? Math.min(height - 6, stage.bottom - 3) : height - 6;
      tooltip.style.maxHeight = Math.max(20, bottom - top) + 'px';
      var box = tooltip.getBoundingClientRect();
      tooltip.style.left = Math.max(6, Math.min(anchor.right + 6, width - box.width - 6)) + 'px';
      tooltip.style.top = Math.max(top, Math.min(anchor.top, bottom - box.height)) + 'px';
    }
    function projectScheduleTooltipHide() { if (projectTooltipHideTimer) clearTimeout(projectTooltipHideTimer); projectTooltipHideTimer = setTimeout(projectHideTooltip, 100); }
    function projectAttachTooltip(button) {
      button.addEventListener('mouseenter', function() { if (button._card) projectShowTooltip(button, button._card); });
      button.addEventListener('focus', function() { if (button._card) projectShowTooltip(button, button._card); });
      button.addEventListener('mouseleave', projectScheduleTooltipHide); button.addEventListener('blur', projectScheduleTooltipHide);
    }
    function projectCreateTaskNode(card, rail) {
      var id = projectCardId(card), node = document.createElement('article'); node.dataset.taskCardId = id; node.setAttribute('role', 'listitem'); node.className = rail ? 'project-task-rail-item' : 'project-task-card';
      var button = document.createElement('button'); button.type = 'button'; button.className = rail ? 'project-task-lamp' : 'project-task-open';
      var ring = projectCreateRing(); button.append(ring); node._ring = ring; node._button = button;
      if (!rail) {
        var copy = document.createElement('span'); copy.className = 'project-task-copy';
        ['title', 'phase', 'first', 'progress', 'metrics', 'current'].forEach(function(field) { var text = document.createElement('span'); text.className = 'project-task-' + field; text.style.display = field === 'title' || field === 'progress' ? '' : 'block'; node['_' + field] = text; copy.append(text); }); button.append(copy);
      }
      button.addEventListener('click', function(event) { if (event.isComposing || event.keyCode === 229) return; projectHideTooltip(); projectSelectView(id, 'task'); });
      projectAttachTooltip(button); node.append(button); return node;
    }
    function projectUpdateTaskNode(node, card, rail, now) {
      var id = projectCardId(card), selected = projectViewMode === 'task' && projectTasks.viewTaskId === id;
      node._button._card = card;
      var signature = JSON.stringify([state.language, selected, selected && !projectRecentCard(card, now, false), card.customTitle, card.title, card.state, card.status, card.phase, card.waitingReason, card.progress, card.error, card.lastProgress, card.lastError, card.firstSubmittedAt, card.firstSubmittedAtSource, card.createdAt, card.usedMs, card.currentEffectiveMs, card.effectiveMs, card.costByCurrency, card.requestCount, card.totalTokens, card.usageIncomplete, card.contextUsageSnapshot ? [card.contextUsageSnapshot.status, card.contextUsageSnapshot.usage, card.contextUsageSnapshot.status === 'current' ? null : card.contextUsageSnapshot.recordedAt] : null]);
      if (node._displaySignature === signature) return; node._displaySignature = signature;
      node.classList.toggle('is-selected', selected); node._button.classList.toggle('is-selected', selected); node._button._card = card;
      node._button.setAttribute('aria-pressed', selected ? 'true' : 'false'); node._button.setAttribute('aria-label', projectTooltipText(card) + (selected && !projectRecentCard(card, now, false) && !card.archived ? '\\n' + t('projectCurrentlyViewing') : ''));
      projectUpdateRing(node._ring, card);
      if (!rail) { projectSetText(node._title, projectTaskTitle(card)); projectSetText(node._phase, projectPhase(card)); projectSetText(node._first, projectFirstTime(card)); projectSetText(node._progress, projectProgress(card)); projectSetText(node._metrics, projectMetrics(card)); projectSetText(node._current, selected && !projectRecentCard(card, now, false) && !card.archived ? t('projectCurrentlyViewing') : ''); }
      if (projectTooltipTarget?.button === node._button) projectShowTooltip(node._button, card);
    }
    function projectSyncNodes(parent, cards, cache, rail, now) {
      var wanted = new Set(cards.map(projectCardId));
      cache.forEach(function(node, id) { if (!wanted.has(id)) { if (projectTooltipTarget?.button === node._button) projectHideTooltip(); node.remove(); cache.delete(id); } });
      var empty = parent.querySelector('.project-task-empty'); if (empty) empty.remove();
      var nextNode = parent.firstChild;
      cards.forEach(function(card) {
        var id = projectCardId(card), node = cache.get(id); if (!node) { node = projectCreateTaskNode(card, rail); cache.set(id, node); }
        projectUpdateTaskNode(node, card, rail, now);
        // Walk the existing sibling chain once. Do not recreate a live children
        // collection per row or move an already correctly positioned focus node.
        if (nextNode !== node) parent.insertBefore(node, nextNode || null);
        nextNode = node.nextSibling;
      });
      if (!cards.length) { var hint = document.createElement('span'); hint.className = 'project-task-empty project-task-progress'; hint.textContent = rail ? '' : t('projectNoTasks'); hint.setAttribute('aria-label', t('projectNoTasks')); parent.append(hint); }
    }
    function projectSaveSidebar() {
      if (!projectTasks || !vscode.setState) return;
      try {
        var saved = vscode.getState ? vscode.getState() || {} : {};
        var preferences = Object.assign({}, saved.projectTaskSidebar || {});
        preferences[projectTasks.projectId] = { open: projectSidebarOpen, scope: projectSidebarScope, showArchived: document.getElementById('projectShowArchived').checked, scrollTop: document.querySelector('.project-sidebar-content')?.scrollTop || 0 };
        saved.projectTaskSidebar = preferences; vscode.setState(saved); projectSidebarPreferences = preferences;
      } catch (_error) { /* Optional UI preferences cannot affect execution or drafts. */ }
    }
    function projectSetSidebarOpen(open, keyboard) {
      projectSidebarOpen = !!open; projectHideTooltip();
      document.getElementById('projectTaskSidebar').classList.toggle('hidden', !projectSidebarOpen || !projectTasks);
      document.getElementById('projectSidebarToggle').setAttribute('aria-expanded', projectSidebarOpen ? 'true' : 'false');
      if (!projectSidebarOpen) document.getElementById('projectTaskMore').open = false;
      projectSaveSidebar(); if (projectSidebarOpen) renderProjectTasks();
      if (keyboard) (projectSidebarOpen ? document.getElementById('projectSidebarClose') : document.getElementById('projectSidebarToggle')).focus();
    }
    function projectRenderDetail(card, readOnly) {
      var detail = document.getElementById('projectTaskDetail');
      var key = [projectViewMode, card ? projectCardId(card) : '', card?.rootTaskId || '', card?.segmentId || '', card?.generation || 0, card?.state || card?.status || card?.phase || '', !!card?.archived, readOnly, state.activeSessionId].join('|');
      if (key === projectDetailKey) return; projectDetailKey = key;
      while (detail.firstChild) detail.firstChild.remove();
      if (projectViewMode !== 'task' || !card) { detail.classList.add('hidden'); return; } detail.classList.remove('hidden');
      var title = document.createElement('h3'); title.textContent = t('projectSelectedTask'); detail.append(title);
      var actions = document.createElement('div'); actions.className = 'project-task-actions';
      if (projectCardIsActive(card)) actions.append(projectButton('projectStopTask', function() { projectTaskAction('projectTaskStop', card); }, readOnly || (card.state || card.status || card.phase) === 'stopping'));
      if (['interrupted', 'cancelled', 'failed', 'waiting'].includes(card.state || card.status || card.phase)) actions.append(projectButton('projectResumeTask', function() { projectTaskAction('projectTaskResume', card); }, readOnly));
      actions.append(projectButton('projectTaskResult', function() { projectSetSidebarOpen(false, false); transcript.scrollTop = transcript.scrollHeight; transcript.focus(); }));
      actions.append(projectButton('projectTaskChanges', function() { projectSetSidebarOpen(false, false); var changes = transcript.querySelector('.change-set-card, .draft-run-card'); if (changes) changes.scrollIntoView({ block: 'nearest' }); else setTransientStatus(t('projectNoChanges')); }));
      actions.append(projectButton('projectTaskValidation', function() { var validated = state.messages.slice().reverse().find(function(message) { return message.runDetails?.validations?.length; }); if (validated) vscode.postMessage({ type: 'openRunTrace', messageId: validated.id }); else setTransientStatus(t('projectNoValidation')); }));
      actions.append(projectButton('projectTaskRunDetails', function() { var recorded = state.messages.slice().reverse().find(function(message) { return message.runDetails; }); if (recorded) vscode.postMessage({ type: 'openRunTrace', messageId: recorded.id }); else setTransientStatus(t('projectNoValidation')); }));
      actions.append(projectButton(card.archived ? 'projectRestoreTask' : 'projectArchiveTask', function() { projectTaskAction('projectTaskArchive', card, { archived: !card.archived }); }, readOnly));
      actions.append(projectButton('projectDeleteTask', function() { projectTaskAction('projectTaskDelete', card); }, readOnly)); detail.append(actions);
    }
    function projectAnnounceTaskStates(cards) {
      var ids = new Set();
      cards.forEach(function(card) {
        var id = projectCardId(card), phase = card.state || card.status || card.phase || 'queued'; ids.add(id);
        var key = phase + (phase === 'waiting' ? ':' + String(card.waitingReason || '') : '');
        var previous = projectAnnouncedStates.get(id); projectAnnouncedStates.set(id, key);
        if (!['waiting', 'interrupted', 'completed', 'failed', 'cancelled'].includes(phase)) projectPendingAnnouncements.delete(id);
        else if (previous !== undefined && previous !== key) projectPendingAnnouncements.set(id, card);
      });
      projectAnnouncedStates.forEach(function(_value, id) { if (!ids.has(id)) { projectAnnouncedStates.delete(id); projectPendingAnnouncements.delete(id); } });
      if (!projectPendingAnnouncements.size || projectAnnouncementTimer || projectSidebarDisposed) return;
      projectAnnouncementTimer = setTimeout(function() {
        projectAnnouncementTimer = null;
        var updates = Array.from(projectPendingAnnouncements.values()); projectPendingAnnouncements.clear();
        var text = updates.slice(0, 3).map(function(card) { return projectTaskTitle(card).slice(0, 80) + ': ' + projectPhase(card); });
        if (updates.length > 3) text.push(t('projectMoreTaskUpdates', { count: updates.length - 3 }));
        projectSetText(document.getElementById('projectTaskAnnouncements'), text.join('; '));
      }, 500);
    }
    function renderProjectTasks() {
      var region = document.getElementById('projectTasks'); if (!region) return;
      region.classList.toggle('hidden', !projectTasks); if (!projectTasks) return;
      var readOnly = projectTasks.readOnly, now = Date.now(), ordered = projectOrderedCards();
      projectAnnounceTaskStates(ordered);
      document.getElementById('projectTaskSidebar').classList.toggle('hidden', !projectSidebarOpen);
      document.getElementById('projectSidebarToggle').setAttribute('aria-expanded', projectSidebarOpen ? 'true' : 'false');
      document.getElementById('projectLatestMessages').classList.toggle('hidden', !projectTaskUiActive() || !state.hasNewerMessages);
      document.getElementById('projectOwnerNotice').classList.toggle('hidden', !readOnly);
      ['projectNewTask', 'projectStopAll', 'projectAssociateSession'].forEach(function(id) { document.getElementById(id).disabled = readOnly; });
      projectSyncNodes(document.getElementById('projectTaskRailList'), ordered.filter(function(card) { return projectRecentCard(card, now, true); }), projectRailNodes, true, now);
      if (projectSidebarOpen) {
        var cards = ordered.filter(function(card) { return projectSidebarScope === 'all' ? !card.archived || document.getElementById('projectShowArchived').checked || projectCardIsActive(card) : projectRecentCard(card, now, true) || document.getElementById('projectShowArchived').checked && card.archived; });
        projectSyncNodes(document.getElementById('projectTaskList'), cards, projectRowNodes, false, now);
        var timing = projectTasks.timing, timingNode = document.getElementById('projectTiming'); timingNode.classList.toggle('hidden', !timing);
        if (timing) projectSetText(timingNode, t('projectElapsedTime') + ': ' + projectFormatTime(timing.projectElapsedMs) + ' · ' + t('projectEffectiveTotal') + ': ' + (timing.incomplete ? '≥ ' : '') + projectFormatTime(timing.totalEffectiveMs));
        var routerUsage = projectTasks.routerUsage || [], routerNode = document.getElementById('projectRouterUsage'); routerNode.classList.toggle('hidden', !routerUsage.length);
        projectSetText(routerNode, routerUsage.map(function(usage) { var currencies = Object.keys(usage.costByCurrency || {}); var cost = currencies.length ? currencies.map(function(currency) { return currency + ' ' + Number(usage.costByCurrency[currency]).toFixed(4); }).join(' · ') : t('projectCostUnknown'); return t('usageRouterLabel') + ': ' + (currencies.length ? t('projectReferenceCost') + ' ' : '') + cost + (Number.isFinite(usage.requestCount) ? ' · ' + t('usageRequestCountValue', { count: usage.requestCount }) : '') + (usage.incomplete ? ' · ' + t('projectUsageIncomplete') : ''); }).join(' · '));
        projectRenderDetail(projectCurrentCard(), readOnly);
      }
      var card = projectCurrentCard(), targetName = projectViewMode === 'new' ? t('projectNewTask') : card && projectViewMode === 'task' ? projectTaskTitle(card) : t('projectAssistant');
      document.getElementById('projectInputTarget').classList.toggle('hidden', !projectTaskUiActive());
      projectSetText(document.getElementById('projectInputTarget'), t(projectPendingInputs.has(projectTargetId()) ? 'projectSavingTarget' : projectCardIsActive(card) && projectViewMode === 'task' ? 'projectSupplementTarget' : 'projectSendTarget', { target: targetName }));
      if (projectTaskUiActive()) { projectSetText(currentSessionTitle, targetName); currentSessionTitle.title = targetName; }
      if (projectExpiryTimer) clearTimeout(projectExpiryTimer);
      var next = 60000; ordered.forEach(function(item) { var activity = projectDate(item.lastActivityAt); if (!projectCardIsActive(item) && activity !== null && activity + 86400000 > now) next = Math.min(next, Math.max(1, activity + 86400000 - now)); });
      if (!projectSidebarDisposed) projectExpiryTimer = setTimeout(function() { projectExpiryTimer = null; renderProjectTasks(); }, next);
    }

    function projectConfirmPaint() {
      if (!projectTasks) return;
      var projectId = projectTasks.projectId, hostId = projectTasks.hostId, generation = projectViewGeneration, targetId = projectTargetId();
      var revision = projectTasks.revision || 0, key = [projectId, hostId || '', targetId, generation, revision].join('|');
      if (key === projectLastPaintKey) return; projectLastPaintKey = key;
      // Two animation frames confirm the browser has had a paint opportunity.
      requestAnimationFrame(function() { requestAnimationFrame(function() {
        if (!projectTasks || projectTasks.projectId !== projectId || projectTasks.hostId !== hostId || projectViewGeneration !== generation || projectTargetId() !== targetId) return;
        vscode.postMessage({ type: 'projectTaskPainted', projectId: projectId, taskCardId: projectTasks.viewTaskId || null,
          targetId: targetId, viewGeneration: generation, revision: revision, paintedAt: performance.now() });
      }); });
    }

    document.getElementById('projectShowArchived')?.addEventListener('change', function() { projectSaveSidebar(); renderProjectTasks(); });
    document.getElementById('projectTaskScope')?.addEventListener('change', function() { projectSidebarScope = document.getElementById('projectTaskScope').value === 'all' ? 'all' : 'recent'; projectSaveSidebar(); renderProjectTasks(); });
    document.getElementById('projectSidebarToggle')?.addEventListener('click', function() { projectSetSidebarOpen(!projectSidebarOpen, false); });
    document.getElementById('projectSidebarClose')?.addEventListener('click', function() { projectSetSidebarOpen(false, false); });
    document.getElementById('projectTaskHistory')?.addEventListener('click', function() { projectSidebarScope = 'all'; document.getElementById('projectTaskScope').value = 'all'; projectSetSidebarOpen(true, false); });
    document.getElementById('projectAssistantView')?.addEventListener('click', function() { projectSelectView(null, 'project'); });
    document.getElementById('projectNewTask')?.addEventListener('click', function() { projectSelectView(null, 'new'); });
    document.getElementById('projectStopAll')?.addEventListener('click', function() { if (!projectTasks || projectTasks.readOnly) return; vscode.postMessage({ type: 'projectTaskStopAll', projectId: projectTasks.projectId }); });
    document.getElementById('projectAssociateSession')?.addEventListener('click', function() { if (!projectTasks || projectTasks.readOnly) return; vscode.postMessage({ type: 'projectTaskAssociate', projectId: projectTasks.projectId, sessionId: state.activeSessionId }); });
    document.getElementById('projectLatestMessages')?.addEventListener('click', projectShowLatestMessages);
    document.querySelector('.project-sidebar-content')?.addEventListener('scroll', function() { projectHideTooltip(); projectSaveSidebar(); });
    document.getElementById('projectTaskRailList')?.addEventListener('scroll', projectHideTooltip);
    document.getElementById('projectTaskTooltip')?.addEventListener('mouseenter', function() { if (projectTooltipHideTimer) { clearTimeout(projectTooltipHideTimer); projectTooltipHideTimer = null; } });
    document.getElementById('projectTaskTooltip')?.addEventListener('mouseleave', projectScheduleTooltipHide);
    document.addEventListener('mousedown', function(event) {
      if (!projectSidebarOpen || !projectTasks) return;
      var target = event.target instanceof Element ? event.target : null;
      if (!target || document.getElementById('projectTaskSidebar').contains(target) || document.getElementById('projectSidebarToggle').contains(target) || document.getElementById('projectTaskTooltip').contains(target)) return;
      // No backdrop, preventDefault or synthetic click: the original target works once.
      projectSetSidebarOpen(false, false);
    });
    document.addEventListener('keydown', function(event) {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || projectCompositionActive) return;
      var tooltip = document.getElementById('projectTaskTooltip');
      // Menus/dialogs own Escape before this lower layer. Inspect visible UI in capture phase.
      var topLayer = Array.from(document.querySelectorAll('dialog, [role="dialog"], [aria-modal="true"]')).some(function(node) {
        return !node.closest('.hidden') && (node.tagName !== 'DIALOG' || node.open);
      });
      if (topLayer) return;
      if (typeof editReferenceMenuOpen !== 'undefined' && editReferenceMenuOpen) return;
      if (typeof sessionMenuOpen !== 'undefined' && sessionMenuOpen || typeof settingsMenuOpen !== 'undefined' && settingsMenuOpen) return;
      var transientIds = ['commandMenu', 'referenceMenu', 'executionModeMenu', 'backgroundRunDialogOverlay', 'newAccountDialogOverlay'];
      if (transientIds.some(function(id) { var node = document.getElementById(id); return node && !node.classList.contains('hidden') && !node.closest('.hidden'); })) return;
      if (tooltip && !tooltip.classList.contains('hidden')) { projectHideTooltip(); event.preventDefault(); event.stopImmediatePropagation(); return; }
      if (!projectSidebarOpen) return;
      var more = document.getElementById('projectTaskMore'); if (more.open) { more.open = false; event.preventDefault(); event.stopImmediatePropagation(); return; }
      projectSetSidebarOpen(false, true); event.preventDefault(); event.stopImmediatePropagation();
    }, true);
    promptInput.addEventListener('compositionstart', function() { projectCompositionActive = true; if (projectCompositionTimer) { clearTimeout(projectCompositionTimer); projectCompositionTimer = null; } });
    promptInput.addEventListener('compositionend', function() {
      projectCompositionActive = false;
      projectCompositionTimer = setTimeout(function() {
        projectCompositionTimer = null; if (projectCompositionActive) return;
        projectFlushDraft();
        var acknowledgements = Array.from(projectDeferredSubmissionResults.values()); projectDeferredSubmissionResults.clear(); acknowledgements.forEach(projectApplySubmissionResult);
        var pending = projectDeferredView, navigation = projectDeferredNavigation; projectDeferredView = null; projectDeferredNavigation = null;
        if (navigation && navigation.projectId === projectTasks?.projectId && navigation.hostId === projectTasks?.hostId && navigation.sourceTarget === projectTargetId() && navigation.sourceMode === projectViewMode && navigation.generation === projectViewGeneration) {
          projectRememberHotView(); projectSetSidebarOpen(false, false); projectDeferredHostState = null; vscode.postMessage(navigation.message);
        } else if (pending && projectTasks && pending.projectId === projectTasks.projectId && pending.hostId === projectTasks.hostId && pending.sourceTarget === projectTargetId() && pending.generation === projectViewGeneration) projectSelectView(pending.taskCardId, pending.mode);
        else if (projectDeferredHostState) { var update = projectDeferredHostState; projectDeferredHostState = null; projectApplyState(update); }
      }, 0);
    });
    promptInput.addEventListener('input', function() {
      if (!projectTaskUiActive() || projectRestoreInProgress) return;
      projectCaptureDraft(true);
      if (!projectCompositionActive) { if (projectDraftTimer) clearTimeout(projectDraftTimer); projectDraftTimer = setTimeout(projectFlushDraft, 150); }
    });
    document.addEventListener('click', function() { if (projectTaskUiActive() && !projectCompositionActive) { if (projectDraftTimer) clearTimeout(projectDraftTimer); projectDraftTimer = setTimeout(projectFlushDraft, 150); } });
    promptInput.addEventListener('blur', function() { if (!projectCompositionActive) projectFlushDraft(); });
    transcript.addEventListener('scroll', function() { if (projectTasks) { projectCaptureDraft(false); if (projectDraftTimer) clearTimeout(projectDraftTimer); projectDraftTimer = setTimeout(projectFlushDraft, 200); } });
    window.addEventListener('focus', function() { if (projectTasks && !projectSidebarDisposed) renderProjectTasks(); });
    window.addEventListener('resize', projectHideTooltip);
    window.addEventListener('pagehide', function() {
      projectSidebarDisposed = true; projectHideTooltip();
      if (projectExpiryTimer) clearTimeout(projectExpiryTimer); if (projectDraftTimer) clearTimeout(projectDraftTimer); if (projectCompositionTimer) clearTimeout(projectCompositionTimer);
      if (projectAnnouncementTimer) clearTimeout(projectAnnouncementTimer); projectPendingAnnouncements.clear(); projectAnnouncedStates.clear();
      projectRailNodes.clear(); projectRowNodes.clear(); projectHotViews.clear(); projectDeferredView = null; projectDeferredNavigation = null; projectDeferredHostState = null;
      projectDeferredSubmissionResults.clear();
    });
  `;
}
