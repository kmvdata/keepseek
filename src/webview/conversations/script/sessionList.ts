import type { WebviewFragment } from '../../input/composition';

export const conversationsSessionListFragment: WebviewFragment = {
  id: 'conversations.session-list',
  source: `
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

    function getSessionMenuRenderKey(sessions) {
      return JSON.stringify([getLanguage(), state.activeSessionId, activeWorkspaceTab,
        sessionMultiSelectMode, sessionRangeDays, sessionFavoritesOnly, Array.from(selectedSessionIds),
        editingSessionTitleId, sessions, otherWorkspaces, otherWorkspacesError,
        otherWorkspaceSessionErrors[activeWorkspaceTab], hasOtherWorkspaceSessionsCache(activeWorkspaceTab)]);
    }

    function renderSessionMenu() {
      if (!sessionMenu) return;
      sessionMenu.classList.toggle('hidden', !sessionMenuOpen);
      if (!sessionMenuOpen) return;
      sessionMenu.classList.toggle('is-multi-select', sessionMultiSelectMode);
      sessionMenu.classList.toggle('is-other-workspace', !isCurrentWorkspaceTab());
      var sessions = getActiveVisibleSessions();
      pruneSelectedSessionIds(sessions);
      // Readiness and auxiliary result patches only affect the row controls.
      // Preserve the existing editor, focus and scroll when history itself has
      // not changed, including full Host snapshots after Webview ready.
      var renderKey = getSessionMenuRenderKey(sessions);
      if (renderKey === sessionMenuRenderKey) {
        syncSessionTitleRefreshButtons();
        return;
      }
      sessionMenuRenderKey = renderKey;
      sessionMenu.innerHTML = '';
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
        if (currentTab) {
          var titleResult = document.createElement('span');
          titleResult.className = 'session-menu-item-meta session-menu-title-result hidden';
          titleResult.setAttribute('role', 'status');
          titleResult.setAttribute('aria-live', 'polite');
          main.append(titleResult);
        }
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
          var refreshButton = document.createElement('button');
          refreshButton.type = 'button';
          refreshButton.className = 'session-menu-refresh';
          refreshButton.dataset.sessionAction = 'regenerateTitle';
          refreshButton.dataset.sessionId = session.id;
          refreshButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 7a7 7 0 0 1 11.6-2.2L20 7M4 17l2.3 2.2A7 7 0 0 0 17.9 17"/></svg>';
          item.append(refreshButton);
          syncSessionTitleRefreshButton(refreshButton);
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
      if (button.disabled) return;
      var action = button.dataset.sessionAction || '';
      if (action === 'regenerateTitle') {
        requestSessionTitleRegeneration(button.dataset.sessionId || '');
        return;
      }
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
      if (input.dataset.cancelTitleEdit === 'true') {
        editingSessionTitleId = '';
        renderSessionMenu();
        return;
      }
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
      if (!sessionId) {
        renderSessionMenu();
        return;
      }
      input.dataset.originalTitle = title;
      var pendingTitleRequest = state.sessionTitleRegenerations?.[sessionId];
      if (pendingTitleRequest) {
        if (!state.retiredSessionTitleRegenerations) state.retiredSessionTitleRegenerations = {};
        state.retiredSessionTitleRegenerations[sessionId + ':' + pendingTitleRequest] = true;
        delete state.sessionTitleRegenerations[sessionId];
      }
      delete state.sessionTitleRegenerationResults?.[sessionId];
      updateLocalSessionTitle(sessionId, title);
      renderCurrentSessionTitle();
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
    }`.slice(1)
};
