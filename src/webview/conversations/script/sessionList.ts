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
      sessionRangeDays = 1;
      sessionMultiSelectMode = false;
      selectedSessionIds.clear();
      editingSessionTitleId = '';
      sessionMenuOpen = true;
      renderSessionControls();
    }

    function closeSessionMenu() {
      sessionMenuOpen = false;
      sessionMultiSelectMode = false;
      selectedSessionIds.clear();
      editingSessionTitleId = '';
      renderSessionControls();
    }

    function getSessionStatusRenderKey(sessions) {
      var statuses = state.sessionRunStatuses && typeof state.sessionRunStatuses === 'object'
        ? state.sessionRunStatuses : {};
      var parts = [];
      for (var i = 0; i < sessions.length; i++) {
        var entry = statuses[sessions[i].id];
        parts.push(sessions[i].id + '=' + sessionRunStatusKind(entry));
      }
      return parts.join(',');
    }

    function getSessionMenuRenderKey(sessions) {
      // A rename input owns the caret while it is open, so the live status key is
      // dropped then: syncSessionStatusBadges patches the marker in place instead
      // of rebuilding the row underneath the editor.
      return JSON.stringify([getLanguage(), state.activeSessionId,
        sessionMultiSelectMode, sessionRangeDays, sessionWithRunOnly, Array.from(selectedSessionIds),
        editingSessionTitleId, sessions,
        editingSessionTitleId ? '' : getSessionStatusRenderKey(sessions)]);
    }

    function queueEntryFor(sessionId) {
      var queue = state.projectQueue;
      if (!queue || !Array.isArray(queue.entries)) return null;
      for (var i = 0; i < queue.entries.length; i++) {
        if (queue.entries[i].sessionId === sessionId) return queue.entries[i];
      }
      return null;
    }

    /** Position and derived mode, shown only for sessions that are in the project queue. */
    function renderQueueBadge(sessionId) {
      var entry = queueEntryFor(sessionId);
      if (!entry) return null;
      var isNormal = entry.mode === 'normal';
      var badge = document.createElement('span');
      badge.className = 'session-queue-badge' + (entry.isHead ? ' is-head' : '') + (isNormal ? ' is-normal' : ' is-plan');
      badge.dataset.queueSessionId = sessionId;
      badge.textContent = '#' + entry.position + ' ' + (isNormal ? 'N' : 'P');
      badge.title = entry.isHead
        ? t('queueHeadHint')
        : t('queuePositionHint', { position: entry.position });
      return badge;
    }

    function renderSessionMenu() {
      if (!sessionMenu) return;
      sessionMenu.classList.toggle('hidden', !sessionMenuOpen);
      if (!sessionMenuOpen) return;
      sessionMenu.classList.toggle('is-multi-select', sessionMultiSelectMode);
      var sessions = getCurrentVisibleSessions();
      pruneSelectedSessionIds(sessions);
      // Readiness and auxiliary result patches only affect the row controls.
      // Preserve the existing editor, focus and scroll when history itself has
      // not changed, including full Host snapshots after Webview ready.
      var renderKey = getSessionMenuRenderKey(sessions);
      if (renderKey === sessionMenuRenderKey) {
        // A live status change must never rebuild the panel: patch the badges only,
        // so a rename input keeps its focus, caret and scroll position.
        syncSessionStatusBadges(sessions);
        return;
      }
      sessionMenuRenderKey = renderKey;
      sessionMenu.innerHTML = '';
      var allVisibleSelected = sessions.length > 0 && sessions.every(function(session) {
        return selectedSessionIds.has(session.id);
      });
      var title = document.createElement('div');
      title.className = 'session-menu-title';
      title.textContent = t('sessionHistory');
      sessionMenu.append(title);

      var controls = document.createElement('div');
      controls.className = 'session-menu-controls';

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

      controls.append(rangeSelect);
      // The date dropdown keeps the leading edge; the switches after it collect
      // in a tail group pushed to the trailing edge, so the icon-only has-run
      // switch is right-aligned instead of drifting beside the range select.
      var trailingControls = document.createElement('div');
      trailingControls.className = 'session-menu-controls-tail';
      // The Host projects a run status for this workspace's rows only, so
      // 'only with a run' filters this project's history and nothing else.
      var withRunOnlyButton = document.createElement('button');
      withRunOnlyButton.type = 'button';
      withRunOnlyButton.className = 'session-menu-filter session-menu-with-run-toggle'
        + (sessionWithRunOnly ? ' is-active' : '');
      withRunOnlyButton.dataset.sessionAction = 'toggleWithRunOnly';
      withRunOnlyButton.setAttribute('aria-pressed', sessionWithRunOnly ? 'true' : 'false');
      // Icon only: 'has not run yet' is a visual state, so the catalogue label
      // becomes the accessible name and the tooltip keeps the explanation.
      withRunOnlyButton.setAttribute('aria-label', t('sessionWithRunOnly'));
      withRunOnlyButton.title = t('sessionWithRunOnlyHint');
      withRunOnlyButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M14.7 8h-2.7l-2 6L6 2l-2 6H1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      trailingControls.append(withRunOnlyButton);
      trailingControls.append(multiSelectButton);
      controls.append(trailingControls);
      sessionMenu.append(controls);

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

      if (!sessions.length) {
        var empty = document.createElement('div');
        empty.className = 'session-menu-empty';
        // The filter can empty the list while history still exists, so name the
        // filter instead of claiming there is no history at all.
        var filteredNothing = sessionWithRunOnly
          && (Array.isArray(state.sessionSummaries) ? state.sessionSummaries : []).length > 0;
        empty.textContent = filteredNothing ? t('sessionWithRunOnlyEmpty') : t('noHistory');
        sessionMenu.append(empty);
        return;
      }

      for (var i = 0; i < sessions.length; i++) {
        var session = sessions[i];
        var item = document.createElement('div');
        var isActive = session.id === state.activeSessionId;
        var isFavorite = session.isFavorite === true;
        item.className = 'session-menu-item'
          + (isActive ? ' is-active' : '')
          + (isFavorite ? ' is-favorite' : '');
        item.dataset.sessionId = session.id;
        item.tabIndex = 0;
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', isActive ? 'true' : 'false');

        var main = document.createElement('div');
        main.className = 'session-menu-item-main';

        var itemTitle;
        if (editingSessionTitleId === session.id) {
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
        var activityTitle = formatSessionActivityTitle(session);
        if (activityTitle) meta.title = activityTitle;
        var queueBadge = renderQueueBadge(session.id);
        if (queueBadge) {
          meta.append(document.createTextNode(' '), queueBadge);
        }

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
        // The run-status marker sits immediately left of the favourite star. It is
        // always rendered so the row grid keeps a stable column, and it stays
        // display-only: it never reorders the row and never expresses a capability.
        item.append(renderRunStatusBadge(session.id));
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
        item.append(main);
        var renameButton = document.createElement('button');
        renameButton.type = 'button';
        renameButton.className = 'session-menu-rename';
        renameButton.dataset.sessionAction = 'startRename';
        renameButton.dataset.sessionId = session.id;
        renameButton.setAttribute('aria-label', t('renameSessionTitle'));
        renameButton.title = t('renameSessionTitle');
        renameButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
        item.append(renameButton);
        sessionMenu.append(item);
      }
    }

    function getCurrentVisibleSessions() {
      var sessions = Array.isArray(state.sessionSummaries) ? state.sessionSummaries.slice() : [];
      sessions.sort(function(a, b) {
        var favoriteDelta = (b.isFavorite === true ? 1 : 0) - (a.isFavorite === true ? 1 : 0);
        if (favoriteDelta) return favoriteDelta;
        return compareSessionsByCreation(a, b);
      });
      return sessions.filter(function(session) {
        if (sessionWithRunOnly && !sessionHasRun(session.id)) {
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
      if (action === 'toggleFavorite') {
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

      if (action === 'toggleWithRunOnly') {
        sessionWithRunOnly = !sessionWithRunOnly;
        selectedSessionIds.clear();
        renderSessionMenu();
        return;
      }

      if (action === 'startRename') {
        var renameRow = button.closest('.session-menu-item');
        var renameSessionId = button.dataset.sessionId || renameRow?.dataset.sessionId || '';
        if (renameSessionId) {
          beginSessionTitleEdit(renameSessionId);
        }
        return;
      }

      if (action === 'toggleSelectVisible') {
        var visibleSessions = getCurrentVisibleSessions();
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
        vscode.postMessage({ type: 'deleteSessions', sessionIds: sessionIds });
        renderSessionMenu();
        return;
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
