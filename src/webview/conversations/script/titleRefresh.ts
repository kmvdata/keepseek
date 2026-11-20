import type { WebviewFragment } from '../../input/composition';

export const conversationsTitleRefreshFragment: WebviewFragment = {
  id: 'conversations.title-refresh',
  source: `
    // A background title must leave the composer, open title editor, and
    // transcript intact. Patch only already-known session labels in place.
    function applySessionTitleUpdate(message) {
      if (typeof message.sessionId !== 'string' || typeof message.title !== 'string' || !message.title.trim()) return;
      // The manual title-refresh button is gone, so a regenerated payload can no
      // longer be correlated with a pending request; only background titles
      // patch a label the user has not renamed.
      var known = false;
      (Array.isArray(state.sessionSummaries) ? state.sessionSummaries : []).forEach(function(session) {
        if (session.id === message.sessionId && !session.customTitle) {
          session.title = message.title;
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