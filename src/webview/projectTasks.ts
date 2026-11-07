/** Project task view chrome. Runtime and session ownership remain entirely in the host. */
export function getProjectTasksTemplate(): string {
  return `
    <section id="projectTasks" class="project-tasks hidden" aria-label="Project tasks" data-i18n-aria-label="projectTasksTitle">
      <div class="project-tasks-toolbar">
        <button id="projectAssistantView" type="button" class="secondary" data-i18n="projectAssistant">项目助手</button>
        <button id="projectNewTask" type="button" data-i18n="projectNewTask">新任务</button>
        <button id="projectStopAll" type="button" class="secondary" data-i18n="projectStopAll">停止全部</button>
        <button id="projectAssociateSession" type="button" class="secondary" data-i18n="projectAssociateSession">关联当前会话</button>
        <button id="projectLatestMessages" type="button" class="secondary hidden" data-i18n="projectLatestMessages">最新消息</button>
        <label class="project-task-metrics"><input id="projectShowArchived" type="checkbox" /><span data-i18n="projectShowArchived">显示归档</span></label>
      </div>
      <div id="projectOwnerNotice" class="project-owner-notice hidden" role="status" data-i18n="projectReadOnly">此窗口为只读，请在执行窗口处理任务。</div>
      <div id="projectTiming" class="project-task-metrics hidden" role="status"></div>
      <div id="projectRouterUsage" class="project-task-metrics hidden" role="status"></div>
      <details id="projectTaskListDetails" open>
        <summary id="projectTaskListSummary" data-i18n="projectTasksTitle">项目任务</summary>
        <div id="projectTaskList" class="project-task-list" role="list"></div>
      </details>
      <div id="projectTaskDetail" class="project-task-detail"></div>
    </section>`;
}

export function getProjectTasksStyles(): string {
  return `
    .project-tasks { flex: 0 0 auto; min-height: 0; max-height: 45vh; overflow: auto; padding: 6px; border-bottom: 1px solid var(--vscode-panel-border); }
    .project-tasks-toolbar, .project-task-actions { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
    .project-tasks-toolbar button, .project-task-actions button { font: inherit; font-size: 11px; padding: 3px 7px; min-height: 25px; }
    .project-tasks summary { cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 11px; padding: 5px 0; }
    .project-task-list { max-height: 184px; overflow: auto; display: grid; gap: 4px; }
    .project-task-card { min-width: 0; border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 6px 8px; background: var(--vscode-sideBar-background); }
    .project-task-card.is-selected { border-color: var(--vscode-focusBorder); }
    .project-task-open { appearance: none; border: 0; padding: 0; width: 100%; background: transparent; color: var(--vscode-foreground); text-align: left; font: inherit; cursor: pointer; }
    .project-task-heading { display: flex; gap: 6px; align-items: baseline; }
    .project-task-title { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .project-task-phase { flex: 0 0 auto; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .project-task-progress, .project-task-metrics, .project-task-result { font-size: 11px; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); }
    .project-task-progress { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .project-task-metrics { margin-top: 2px; }
    .project-task-detail { margin-top: 5px; max-height: 180px; overflow: auto; }
    .project-task-detail h3 { margin: 3px 0; font-size: 12px; }
    .project-task-result { white-space: pre-wrap; margin: 6px 0; max-height: 100px; overflow: auto; }
    .project-input-target { flex: 0 0 auto; font-size: 11px; padding: 3px 6px; color: var(--vscode-descriptionForeground); }
    .project-owner-notice { color: var(--vscode-inputValidation-warningForeground, var(--vscode-descriptionForeground)); padding: 4px 0; }
    .project-task-open:focus-visible, .project-tasks button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
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
      var saved = vscode.getState ? (vscode.getState() || {}) : {};
      saved.projectTaskDrafts = Array.from(projectDrafts.entries());
      saved.projectTaskPendingInputs = Array.from(projectPendingInputs.entries());
      saved.projectTaskView = { projectId: projectTasks.projectId, targetId: projectTargetId(), viewGeneration: projectViewGeneration };
      vscode.setState(saved);
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
      var scrollTop = awaitingLatest ? 0 : Number(transcript.scrollTop) || 0, scrollAnchor = awaitingLatest ? null : projectScrollAnchor(), expanded = document.getElementById('projectTaskListDetails')?.open !== false;
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
        var details = document.getElementById('projectTaskListDetails'); if (details && typeof local.expanded === 'boolean') details.open = local.expanded;
      }
      projectSaveLocalDrafts();
    }

    function projectRememberHotView() {
      if (!projectTasks) return;
      var draft = projectDrafts.get(projectDraftKey(projectTargetId())), messages = state.messages;
      var anchorIndex = draft?.scrollAnchor?.messageId ? messages.findIndex(function(message) { return message.id === draft.scrollAnchor.messageId; }) : -1;
      var start = anchorIndex >= 0 ? Math.max(0, Math.min(messages.length - 30, anchorIndex - 15)) : Math.max(0, messages.length - 30);
      var end = Math.min(messages.length, start + 30);
      projectHotViews.set(projectDraftKey(projectTargetId()), { messages: messages.slice(start, end),
        hasOlderMessages: state.hasOlderMessages || start > 0, hasNewerMessages: state.hasNewerMessages || end < messages.length,
        sessionId: state.activeSessionId, stateRevision: lastStateRevision, changeSets: state.changeSets, draftRuns: state.draftRuns, taskPlan: state.taskPlan, repairLoop: state.repairLoop, planWorkflows: state.planWorkflows });
      if (projectHotViews.size > 8) projectHotViews.delete(projectHotViews.keys().next().value);
    }

    function projectSelectView(taskCardId, mode) {
      if (!projectTasks) return;
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
      if (!message.projectId || message.hostId && projectRetiredHosts.has(message.projectId + ':' + message.hostId)) return;

      var hostChanged = !!message.hostId && !!projectTasks && message.hostId !== projectTasks.hostId;
      if (hostChanged && projectTasks.hostId) projectRetiredHosts.add(projectTasks.projectId + ':' + projectTasks.hostId);
      var first = !projectTasks || projectTasks.projectId !== message.projectId || hostChanged;
      if (first) {
        projectTasks = { projectId: message.projectId, hostId: message.hostId, cards: [], viewTaskId: null, readOnly: false, revision: 0 };
        projectHotViews.clear(); projectPendingInputs.clear();
        if (hostChanged) { projectStateRevisions.clear(); lastStateRevision = 0; }
        projectViewMode = 'project'; projectViewGeneration = 0;
        var saved = vscode.getState ? vscode.getState() : null;
        if (Array.isArray(saved?.projectTaskDrafts)) saved.projectTaskDrafts.forEach(function(entry) { if (Array.isArray(entry) && entry.length === 2) projectDrafts.set(entry[0], entry[1]); });
        if (Array.isArray(saved?.projectTaskPendingInputs)) saved.projectTaskPendingInputs.forEach(function(entry) {
          if (Array.isArray(entry) && entry.length === 2 && entry[1]?.projectId === message.projectId) projectPendingInputs.set(entry[0], entry[1]);
        });
        projectPendingInputs.forEach(function(pending) { vscode.postMessage({ type: 'projectTaskReconcile', projectId: message.projectId, targetId: pending.targetId, requestId: pending.requestId }); });
      }
      if (message.enabled === false) {
        projectFlushDraft(); projectRememberHotView(); projectViewMode = 'legacy';
        projectTasks.viewTaskId = null; lastStateRevision = projectStateRevisions.get('$legacy') || 0;
        if (Array.isArray(message.cards)) projectTasks.cards = message.cards;
        projectTasks.readOnly = message.readOnly === true;
        render(); return;
      }
      var revision = Number(message.revision) || 0;
      if (revision && revision < (projectTasks.revision || 0)) return;
      if (Array.isArray(message.cards)) projectTasks.cards = message.cards;
      if (Array.isArray(message.results)) projectTasks.results = message.results;
      if (Array.isArray(message.routerUsage)) projectTasks.routerUsage = message.routerUsage;
      if (message.timing) projectTasks.timing = message.timing;
      projectTasks.readOnly = message.readOnly === true;
      if (revision) projectTasks.revision = revision;
      var generation = Number(message.viewGeneration) || 0;
      if (first || generation >= projectViewGeneration) {
        var viewChanged = first || generation > projectViewGeneration || (Object.prototype.hasOwnProperty.call(message, 'viewTaskId') && message.viewTaskId !== projectTasks.viewTaskId);
        if (generation > projectViewGeneration || (Object.prototype.hasOwnProperty.call(message, 'viewTaskId') && message.viewTaskId !== projectTasks.viewTaskId)) {
          if (!first) { projectFlushDraft(); projectRememberHotView(); }
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
        if (viewChanged || (!projectCompositionActive && message.draft && (!localDraft || message.draft.revision > localDraft.revision))) projectRestoreDraft(projectTargetId(), message.draft);
        else if (Array.isArray(message.messages)) projectRestoreScroll(localDraft);
        if (Array.isArray(message.messages) && projectLatestPendingTarget === projectDraftKey(projectTargetId())) {
          projectLatestPendingTarget = ''; transcript.scrollTop = transcript.scrollHeight;
          projectFlushDraft();
        }
      }
      renderProjectTasks(); window.keepseekInputControls?.render(); syncSendButtonAvailability(); projectConfirmPaint();
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
      vscode.postMessage(Object.assign({ type: type, projectId: projectTasks.projectId, taskCardId: projectCardId(card), rootTaskId: card.rootTaskId }, extra || {}));
    }
    function projectButton(labelKey, listener, disabled) {
      var button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = t(labelKey); button.disabled = !!disabled;
      button.addEventListener('click', listener); return button;
    }
    function renderProjectTasks() {
      var region = document.getElementById('projectTasks'); if (!region) return;
      region.classList.toggle('hidden', !projectTasks); if (!projectTasks) return;
      var readOnly = projectTasks.readOnly, list = document.getElementById('projectTaskList');
      document.getElementById('projectLatestMessages').classList.toggle('hidden', !projectTaskUiActive() || !state.hasNewerMessages);
      var timing = projectTasks.timing, timingNode = document.getElementById('projectTiming');
      timingNode.classList.toggle('hidden', !timing);
      if (timing) timingNode.textContent = t('projectElapsedTime') + ': ' + projectFormatTime(timing.projectElapsedMs)
        + ' · ' + t('projectEffectiveTotal') + ': ' + (timing.incomplete ? '≥ ' : '') + projectFormatTime(timing.totalEffectiveMs);
      var routerUsage = projectTasks.routerUsage || [], routerNode = document.getElementById('projectRouterUsage');
      routerNode.classList.toggle('hidden', !routerUsage.length);
      routerNode.textContent = routerUsage.map(function(usage) {
        var currencies = Object.keys(usage.costByCurrency || {});
        var cost = currencies.length ? currencies.map(function(currency) { return currency + ' ' + Number(usage.costByCurrency[currency]).toFixed(4); }).join(' · ') : t('projectCostUnknown');
        return t('usageRouterLabel') + ': ' + (currencies.length ? t('projectReferenceCost') + ' ' : '') + cost + (Number.isFinite(usage.requestCount) ? ' · ' + t('usageRequestCountValue', { count: usage.requestCount }) : '')
          + (usage.incomplete ? ' · ' + t('projectUsageIncomplete') : '');
      }).join(' · ');
      document.getElementById('projectOwnerNotice').classList.toggle('hidden', !readOnly);
      ['projectNewTask', 'projectStopAll', 'projectAssociateSession'].forEach(function(id) { document.getElementById(id).disabled = readOnly; });
      var cards = projectTasks.cards.filter(function(card) { return (!card.archived || document.getElementById('projectShowArchived')?.checked) && !card.deleted; });
      // Stable domain order wins within each phase; token progress never changes ordering.
      function priority(card) { var phase = card.state || card.status || card.phase; return phase === 'waiting' || phase === 'interrupted' ? 0 : projectCardIsActive(card) ? 1 : 2; }
      cards = cards.map(function(card, index) { return { card: card, index: index }; }).sort(function(a, b) { return priority(a.card) - priority(b.card) || a.index - b.index; }).map(function(item) { return item.card; });
      list.replaceChildren();
      cards.forEach(function(card) {
        var id = projectCardId(card), node = document.createElement('article'); node.className = 'project-task-card'; node.dataset.taskCardId = id; node.setAttribute('role', 'listitem');
        node.classList.toggle('is-selected', projectTasks.viewTaskId === id && projectViewMode === 'task');
        var open = document.createElement('button'); open.type = 'button'; open.className = 'project-task-open'; open.setAttribute('aria-pressed', projectTasks.viewTaskId === id ? 'true' : 'false');
        var heading = document.createElement('span'); heading.className = 'project-task-heading';
        var title = document.createElement('span'); title.className = 'project-task-title'; title.textContent = card.title || t('projectUntitledTask');
        var phase = document.createElement('span'); phase.className = 'project-task-phase'; phase.textContent = projectPhase(card); heading.append(title, phase); open.append(heading);
        var progress = document.createElement('div'); progress.className = 'project-task-progress'; progress.textContent = projectProgress(card); open.append(progress);
        var metrics = document.createElement('div'); metrics.className = 'project-task-metrics';
        var currencies = Object.keys(card.costByCurrency || {});
        var cost = card.costLabel || (currencies.length ? currencies.map(function(currency) { return currency + ' ' + Number(card.costByCurrency[currency]).toFixed(4); }).join(' · ') : typeof card.cost === 'number' ? String(card.cost) : t('projectCostUnknown'));
        metrics.textContent = (projectCardIsActive(card) && !Number.isFinite(card.currentEffectiveMs) ? '≥ ' : '') + projectFormatTime(Number.isFinite(card.currentEffectiveMs) ? card.currentEffectiveMs : card.usedMs || card.effectiveMs) + ' · ' + (currencies.length ? t('projectReferenceCost') + ' ' : '') + cost + (card.usageIncomplete ? ' · ' + t('projectUsageIncomplete') : ''); open.append(metrics);
        open.addEventListener('click', function() { projectSelectView(id, 'task'); });
        open.addEventListener('focus', function() { vscode.postMessage({ type: 'projectTaskPrefetch', projectId: projectTasks.projectId, taskCardId: id }); });
        open.addEventListener('mouseenter', function() { vscode.postMessage({ type: 'projectTaskPrefetch', projectId: projectTasks.projectId, taskCardId: id }); });
        node.append(open); list.append(node);
      });
      if (!cards.length) { var empty = document.createElement('div'); empty.className = 'project-task-progress'; empty.textContent = t('projectNoTasks'); list.append(empty); }
      var card = projectCurrentCard(), detail = document.getElementById('projectTaskDetail'); detail.replaceChildren();
      if (projectViewMode === 'task' && card) {
        var title = document.createElement('h3'); title.textContent = card.title || t('projectUntitledTask'); detail.append(title);
        var actions = document.createElement('div'); actions.className = 'project-task-actions';
        if (projectCardIsActive(card)) actions.append(projectButton('projectStopTask', function() { projectTaskAction('projectTaskStop', card); }, readOnly || (card.state || card.status || card.phase) === 'stopping'));
        if (['interrupted', 'cancelled', 'failed', 'waiting'].includes(card.state || card.status || card.phase)) actions.append(projectButton('projectResumeTask', function() { projectTaskAction('projectTaskResume', card); }, readOnly));
        actions.append(projectButton('projectTaskResult', function() { transcript.scrollTop = transcript.scrollHeight; transcript.focus(); }));
        actions.append(projectButton('projectTaskChanges', function() { var changes = transcript.querySelector('.change-set-card, .draft-run-card'); if (changes) changes.scrollIntoView({ block: 'nearest' }); else setTransientStatus(t('projectNoChanges')); }));
        actions.append(projectButton('projectTaskValidation', function() {
          var validated = state.messages.slice().reverse().find(function(message) { return message.runDetails?.validations?.length; });
          if (validated) vscode.postMessage({ type: 'openRunTrace', messageId: validated.id }); else setTransientStatus(t('projectNoValidation'));
        }));
        actions.append(projectButton(card.archived ? 'projectRestoreTask' : 'projectArchiveTask', function() { projectTaskAction('projectTaskArchive', card, { archived: !card.archived }); }, readOnly));
        actions.append(projectButton('projectDeleteTask', function() { projectTaskAction('projectTaskDelete', card); }, readOnly));
        detail.append(actions);
        if (card.result || card.resultText) { var result = document.createElement('div'); result.className = 'project-task-result'; result.textContent = typeof card.result === 'string' ? card.result : card.resultText || card.result?.summary || ''; detail.append(result); }
      }
      var resultEvents = Array.isArray(projectTasks.results) ? projectTasks.results : [];
      if (projectViewMode === 'task' && card && !(card.result || card.resultText)) {
        var latestResult = resultEvents.filter(function(item) { return item.taskCardId === projectCardId(card); }).slice(-1)[0];
        if (latestResult) { var report = document.createElement('div'); report.className = 'project-task-result'; report.textContent = t('projectTaskReport') + '\\n' + String(latestResult.content || ''); detail.append(report); }
      } else if (projectViewMode === 'project') {
        resultEvents.slice(-5).reverse().forEach(function(item) {
          var resultCard = projectTasks.cards.find(function(candidate) { return projectCardId(candidate) === item.taskCardId; });
          var entry = document.createElement('div'); entry.className = 'project-task-result';
          var source = projectButton('projectTaskReport', function() { projectSelectView(item.taskCardId, 'task'); });
          source.textContent = (resultCard?.title || t('projectUntitledTask')) + ' · ' + t('projectTaskReport');
          var body = document.createElement('div'); body.textContent = String(item.content || ''); entry.append(source, body); detail.append(entry);
        });
      }
      var targetName = projectViewMode === 'new' ? t('projectNewTask') : card && projectViewMode === 'task' ? (card.title || t('projectUntitledTask')) : t('projectAssistant');
      document.getElementById('projectInputTarget').classList.toggle('hidden', !projectTaskUiActive());
      document.getElementById('projectInputTarget').textContent = t(projectPendingInputs.has(projectTargetId()) ? 'projectSavingTarget' : projectCardIsActive(card) && projectViewMode === 'task' ? 'projectSupplementTarget' : 'projectSendTarget', { target: targetName });
      if (projectTaskUiActive()) { currentSessionTitle.textContent = targetName; currentSessionTitle.title = targetName; }
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

    document.getElementById('projectShowArchived')?.addEventListener('change', function() { renderProjectTasks(); });
    document.getElementById('projectAssistantView')?.addEventListener('click', function() { projectSelectView(null, 'project'); });
    document.getElementById('projectNewTask')?.addEventListener('click', function() { projectSelectView(null, 'new'); });
    document.getElementById('projectStopAll')?.addEventListener('click', function() { if (!projectTasks || projectTasks.readOnly) return; vscode.postMessage({ type: 'projectTaskStopAll', projectId: projectTasks.projectId }); });
    document.getElementById('projectAssociateSession')?.addEventListener('click', function() { if (!projectTasks || projectTasks.readOnly) return; vscode.postMessage({ type: 'projectTaskAssociate', projectId: projectTasks.projectId, sessionId: state.activeSessionId }); });
    document.getElementById('projectLatestMessages')?.addEventListener('click', projectShowLatestMessages);
    promptInput.addEventListener('compositionstart', function() { projectCompositionActive = true; });
    promptInput.addEventListener('compositionend', function() { projectCompositionActive = false; projectFlushDraft(); });
    promptInput.addEventListener('input', function() {
      if (!projectTaskUiActive() || projectRestoreInProgress) return;
      projectCaptureDraft(true);
      if (!projectCompositionActive) { if (projectDraftTimer) clearTimeout(projectDraftTimer); projectDraftTimer = setTimeout(projectFlushDraft, 150); }
    });
    document.addEventListener('click', function() { if (projectTaskUiActive() && !projectCompositionActive) { if (projectDraftTimer) clearTimeout(projectDraftTimer); projectDraftTimer = setTimeout(projectFlushDraft, 150); } });
    promptInput.addEventListener('blur', function() { if (!projectCompositionActive) projectFlushDraft(); });
    transcript.addEventListener('scroll', function() { if (projectTasks) { projectCaptureDraft(false); if (projectDraftTimer) clearTimeout(projectDraftTimer); projectDraftTimer = setTimeout(projectFlushDraft, 200); } });
    document.getElementById('projectTaskListDetails')?.addEventListener('toggle', function() { projectFlushDraft(); });
  `;
}
