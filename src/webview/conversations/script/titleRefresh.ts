import type { WebviewFragment } from '../../input/composition';

export const conversationsTitleRefreshFragment: WebviewFragment = {
  id: 'conversations.title-refresh',
  source: `
    function canRegenerateSessionTitle(sessionId) {
      return !!sessionId && state.titleRegenerationCapability?.available === true
        && (Array.isArray(state.sessionSummaries) ? state.sessionSummaries : []).some(function(session) { return session.id === sessionId; })
        && !state.sessionTitleRegenerations?.[sessionId]
        && editingSessionTitleId !== sessionId;
    }

    function sessionTitleRefreshDisabledReason(sessionId) {
      if (state.sessionTitleRegenerations?.[sessionId]) return t('regeneratingSessionTitle');
      if (editingSessionTitleId === sessionId) return t('titleRefreshEditing');
      if (state.titleRegenerationCapability?.available !== true) {
        var reason = state.titleRegenerationCapability?.reason;
        return t(['loading_sessions', 'recovering', 'model_unavailable', 'untrusted', 'busy', 'saving', 'unavailable'].includes(reason)
          ? 'titleRefreshReason_' + reason : 'titleRefreshUnavailable');
      }
      return '';
    }

    function syncSessionTitleRefreshButton(button) {
      var sessionId = button.dataset.sessionId || '';
      var pending = !!state.sessionTitleRegenerations?.[sessionId];
      button.disabled = !canRegenerateSessionTitle(sessionId);
      button.classList.toggle('is-regenerating', pending);
      button.setAttribute('aria-busy', pending ? 'true' : 'false');
      button.setAttribute('aria-disabled', button.disabled ? 'true' : 'false');
      var label = t(pending ? 'regeneratingSessionTitle' : 'regenerateSessionTitle');
      var reason = button.disabled ? sessionTitleRefreshDisabledReason(sessionId) : '';
      var description = reason && reason !== label ? label + ': ' + reason : label;
      button.setAttribute('aria-label', description);
      button.title = description;
      var result = button.closest('.session-menu-item')?.querySelector('.session-menu-title-result');
      if (result) {
        var feedback = state.sessionTitleRegenerationResults?.[sessionId];
        result.textContent = pending ? t('regeneratingSessionTitle') : feedback?.reason || '';
        result.classList.toggle('hidden', !result.textContent);
      }
    }

    function syncSessionTitleRefreshButtons(sessionId) {
      if (!sessionMenu) return;
      sessionMenu.querySelectorAll('button[data-session-action="regenerateTitle"]').forEach(function(button) {
        if (!sessionId || button.dataset.sessionId === sessionId) syncSessionTitleRefreshButton(button);
      });
    }

    function requestSessionTitleRegeneration(sessionId) {
      if (!isCurrentWorkspaceTab() || !canRegenerateSessionTitle(sessionId)) return;
      // This UI correlation ID never enters model input or the main request.
      var requestId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
      if (!state.sessionTitleRegenerations) state.sessionTitleRegenerations = {};
      state.sessionTitleRegenerations[sessionId] = requestId;
      delete state.sessionTitleRegenerationResults?.[sessionId];
      syncSessionTitleRefreshButtons(sessionId);
      vscode.postMessage({ type: 'regenerateSessionTitle', sessionId: sessionId, requestId: requestId });
    }

    function applySessionTitleRegeneration(message) {
      if (typeof message.sessionId !== 'string' || typeof message.requestId !== 'string' || !message.requestId) return;
      var retiredKey = message.sessionId + ':' + message.requestId;
      if (state.retiredSessionTitleRegenerations?.[retiredKey]) return;
      // A newly mounted Webview learns Host-owned in-flight requests before
      // receiving its first session state. Ordinary status events cannot create
      // or replace a locally correlated request.
      if (message.restored === true && message.running === true && !state.sessionTitleRegenerations?.[message.sessionId]) {
        if (!state.sessionTitleRegenerations) state.sessionTitleRegenerations = {};
        state.sessionTitleRegenerations[message.sessionId] = message.requestId;
      }
      if (state.sessionTitleRegenerations?.[message.sessionId] !== message.requestId) return;
      if (message.running === false) {
        delete state.sessionTitleRegenerations[message.sessionId];
        if (!state.sessionTitleRegenerationResults) state.sessionTitleRegenerationResults = {};
        state.sessionTitleRegenerationResults[message.sessionId] = {
          requestId: message.requestId, outcome: message.outcome,
          reason: typeof message.reason === 'string' && message.reason.trim() ? message.reason : t('titleRefreshUnavailable')
        };
        if (!state.retiredSessionTitleRegenerations) state.retiredSessionTitleRegenerations = {};
        state.retiredSessionTitleRegenerations[retiredKey] = true;
      }
      syncSessionTitleRefreshButtons(message.sessionId);
    }

    // A background title must leave the composer, open title editor, and
    // transcript intact. Patch only already-known session labels in place.
    function applySessionTitleUpdate(message) {
      if (typeof message.sessionId !== 'string' || typeof message.title !== 'string' || !message.title.trim()) return;
      var regenerated = message.regenerated === true;
      if (regenerated && (typeof message.requestId !== 'string'
        || state.sessionTitleRegenerations?.[message.sessionId] !== message.requestId)) return;
      var known = false;
      (Array.isArray(state.sessionSummaries) ? state.sessionSummaries : []).forEach(function(session) {
        if (session.id === message.sessionId && (!session.customTitle || regenerated)) {
          session.title = message.title;
          if (regenerated) session.customTitle = undefined;
          known = true;
        }
      });
      if (!known) return;
      if (state.activeSessionId === message.sessionId) renderCurrentSessionTitle();
      if (!sessionMenu || !sessionMenuOpen) return;
      if (editingSessionTitleId !== message.sessionId) {
        sessionMenu.querySelectorAll('.session-menu-item').forEach(function(row) {
          if (row.dataset.sessionOrigin !== 'current' || row.dataset.sessionId !== message.sessionId) return;
          var label = row.querySelector('span.session-menu-item-title');
          if (label) { label.textContent = message.title; label.title = message.title; }
        });
      }
      // A title patch changes neither history membership nor date sorting.
      // Advance the rendered snapshot too, so its matching Host full state does
      // not rebuild this row or another row's unfinished title editor.
      sessionMenuRenderKey = getSessionMenuRenderKey(getActiveVisibleSessions());
    }

    function applySessionTitleUsageUpdate(message) {
      if (message.sessionId !== state.activeSessionId || !state.usageMetrics) return;
      var metrics = state.usageMetrics;
      if (message.sessionUsageStats && typeof message.sessionUsageStats === 'object') {
        metrics.sessionUsageStats = message.sessionUsageStats;
      }
      var incoming = message.usageDetails;
      if (incoming && typeof incoming === 'object') {
        metrics.usageDetails = Object.assign({}, metrics.usageDetails || {}, {
          session: incoming.session,
          sessionTitle: incoming.sessionTitle,
          subagents: incoming.subagents
        });
      }
      if (Array.isArray(message.referenceCostSourceIds)) {
        metrics.referenceCostSourceIds = message.referenceCostSourceIds;
      }
      // Only redraw usage surfaces; keep the latest main reply, task clock,
      // cache diagnostics, composer and manual-title editor untouched.
      if (window.keepseekInputControls?.renderUsage) window.keepseekInputControls.renderUsage();
    }`.slice(1)
};
