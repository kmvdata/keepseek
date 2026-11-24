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
        sessionMultiSelectMode, sessionRangeDays, sessionWithRunOnly, sessionFavoritesOnly, Array.from(selectedSessionIds),
        editingSessionTitleId, sessions,
        editingSessionTitleId ? '' : getSessionStatusRenderKey(sessions)]);
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
      // Icon only: the catalogue labels stay behind as the accessible name and
      // the tooltip. The batch glyph is deliberately not the row rename pencil:
      // the strip edits the list, while a pencil inside a row renames exactly one
      // conversation, so a checklist marks 'select several rows' instead.
      multiSelectButton.setAttribute('aria-label', t(sessionMultiSelectMode ? 'sessionExitMultiSelect' : 'sessionMultiSelect'));
      multiSelectButton.title = t(sessionMultiSelectMode ? 'sessionExitMultiSelect' : 'sessionMultiSelect');
      multiSelectButton.innerHTML = sessionMultiSelectMode
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8"/><path d="M13 12h8"/><path d="M13 18h8"/></svg>';

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
      // Favourites is a bookmark, not a move: the switch filters this project's
      // list and never touches the order the rows arrived in.
      var favoritesOnlyButton = document.createElement('button');
      favoritesOnlyButton.type = 'button';
      favoritesOnlyButton.className = 'session-menu-filter session-menu-favorites-toggle'
        + (sessionFavoritesOnly ? ' is-active' : '');
      favoritesOnlyButton.dataset.sessionAction = 'toggleFavoritesOnly';
      favoritesOnlyButton.setAttribute('aria-pressed', sessionFavoritesOnly ? 'true' : 'false');
      // Icon only: the star repeats the row bookmark glyph, so the catalogue
      // labels stay behind as the accessible name and the tooltip.
      favoritesOnlyButton.setAttribute('aria-label', t('sessionFavoritesOnly'));
      favoritesOnlyButton.title = t('sessionFavoritesOnlyHint');
      favoritesOnlyButton.innerHTML = sessionFavoritesOnly
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>';
      trailingControls.append(withRunOnlyButton);
      trailingControls.append(favoritesOnlyButton);
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
        // A switch can empty the list while history still exists, so name the
        // filter instead of claiming there is no history at all. Two switches on
        // means both sets were empty, so neither single-switch wording is true.
        var historyNotEmpty = (Array.isArray(state.sessionSummaries) ? state.sessionSummaries : []).length > 0;
        var emptyKey = 'noHistory';
        if (historyNotEmpty && sessionFavoritesOnly && sessionWithRunOnly) {
          emptyKey = 'sessionFavoritesOrRunOnlyEmpty';
        } else if (historyNotEmpty && sessionFavoritesOnly) {
          emptyKey = 'sessionFavoritesOnlyEmpty';
        } else if (historyNotEmpty && sessionWithRunOnly) {
          emptyKey = 'sessionWithRunOnlyEmpty';
        }
        empty.textContent = t(emptyKey);
        sessionMenu.append(empty);
        return;
      }

      for (var i = 0; i < sessions.length; i++) {
        var session = sessions[i];
        var item = document.createElement('div');
        var isActive = session.id === state.activeSessionId;
        var isFavorite = session.isFavorite === true;
        var isPinned = session.isPinned === true;
        item.className = 'session-menu-item'
          + (isActive ? ' is-active' : '')
          + (isFavorite ? ' is-favorite' : '')
          + (isPinned ? ' is-pinned' : '');
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
        // The stop square leaves the running list. It sits before the rename pencil
        // so the destructive row action reads left of the edit action; a row with no
        // run keeps an inert spacer in that column so the grid never shifts.
        item.append(renderSessionRunStopButton(session.id));
        var pinButton = document.createElement('button');
        pinButton.type = 'button';
        pinButton.className = 'session-menu-pin' + (isPinned ? ' is-active' : '');
        pinButton.dataset.sessionAction = 'togglePin';
        pinButton.dataset.sessionId = session.id;
        pinButton.setAttribute('aria-pressed', isPinned ? 'true' : 'false');
        pinButton.setAttribute('aria-label', t(isPinned ? 'unpinSession' : 'pinSession'));
        pinButton.title = t(isPinned ? 'unpinSession' : 'pinSession');
        // The pin is the only row action that moves a row, so it never writes here:
        // the Host flips the header flag and pushes the order back, which keeps this
        // glyph a request instead of an authority.
        pinButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/></svg>';
        item.append(pinButton);
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
      // Favouriting a row is a bookmark, never a move: 'isFavorite' is not a sort
      // key, so the star leaves the row — and the scroll position around it —
      // exactly where the user clicked it. Only an explicit pin — the one move the
      // user asks for — or a new conversation enters at the top.
      sessions.sort(compareSessionsByCreation);
      return sessions.filter(function(session) {
        // The two switches are switches, not gates: each one admits its own rows
        // and the list shows the union, so turning both on can never hide a row
        // that either switch alone would show.
        var favoritesMatch = sessionFavoritesOnly && session.isFavorite === true;
        var runMatch = sessionWithRunOnly && sessionHasRun(session.id);
        if (sessionFavoritesOnly || sessionWithRunOnly) {
          if (!favoritesMatch && !runMatch) {
            return false;
          }
          if (favoritesMatch) {
            // The star is a bookmark: a followed row stays visible even when the
            // range above would hide it. The range is bypassed, never rewritten,
            // so closing the switch restores its effect unchanged.
            return true;
          }
        }        if (sessionRangeDays <= 0) {
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

      if (action === 'togglePin') {
        // Order only: the Host owns the flag, so nothing here edits the summaries.
        var pinRow = button.closest('.session-menu-item');
        var pinSessionId = button.dataset.sessionId || pinRow?.dataset.sessionId || '';
        if (pinSessionId) {
          vscode.postMessage({ type: 'toggleSessionPinned', sessionId: pinSessionId });
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

      if (action === 'toggleFavoritesOnly') {
        sessionFavoritesOnly = !sessionFavoritesOnly;
        selectedSessionIds.clear();
        renderSessionMenu();
        return;
      }

      if (action === 'dismissSessionRun') {
        // The Host recomputes the kind and owns the confirmation: the glyph only
        // hints at what will happen, so nothing here carries any authority.
        var runStopRow = button.closest('.session-menu-item');
        var runStopSessionId = button.dataset.sessionId || runStopRow?.dataset.sessionId || '';
        if (runStopSessionId) {
          vscode.postMessage({ type: 'dismissSessionRun', sessionId: runStopSessionId });
        }
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
