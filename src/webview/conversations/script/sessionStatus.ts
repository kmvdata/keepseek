import type { WebviewFragment } from '../../input/composition';

/**
 * History-row run-status rendering.
 *
 * The Host projects exactly one status per conversation; this fragment only turns
 * that projection into a marker on the row. It never decides order, selection or
 * capability — the marker is a hint placed beside the favourite star, and the
 * colour mapping is the contract the list relies on: red = failed, orange
 * (flashing) = running, green = completed.
 *
 * It is a separate fragment because the list fragment owns layout, while "what a
 * status looks like" is a rendering concern of its own that must stay out of the
 * ordering rules.
 */
export const conversationsSessionStatusFragment: WebviewFragment = {
  id: 'conversations.session-status',
  source: `
    /**
     * Creation timestamp with the same total order the Host uses. The history list
     * is the record of what the user created, so only \`createdAt\` moves a row:
     * browsing, streaming or saving a conversation must never reorder it.
     */
    function getSessionCreatedTimestamp(session) {
      var timestamp = Date.parse(session.createdAt || session.updatedAt || '');
      if (Number.isFinite(timestamp)) return timestamp;
      return getSessionTimestamp(session);
    }

    function compareSessionsByCreation(a, b) {
      var delta = getSessionCreatedTimestamp(b) - getSessionCreatedTimestamp(a);
      if (delta) return delta;
      var leftId = String(a.id || '');
      var rightId = String(b.id || '');
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    }

    /** One tooltip that explains both why the row sits where it does and when it
     * was last touched. */
    function formatSessionActivityTitle(session) {
      var parts = [];
      var created = formatSessionTime(session.createdAt);
      var lastActive = formatSessionTime(session.updatedAt);
      if (created) parts.push(t('sessionCreatedAt', { time: created }));
      if (lastActive) parts.push(t('sessionLastActiveAt', { time: lastActive }));
      return parts.join(' · ');
    }

    function sessionRunStatusEntry(sessionId) {
      var statuses = state.sessionRunStatuses;
      if (!statuses || typeof statuses !== 'object') return null;
      var entry = statuses[sessionId];
      return entry && typeof entry.kind === 'string' ? entry : null;
    }

    /** Unknown and missing kinds both mean "no run recorded", never a guess. */
    function sessionRunStatusKind(entry) {
      var kind = entry && entry.kind ? entry.kind : '';
      return ['running', 'waiting', 'failed', 'stopped', 'completed'].indexOf(kind) >= 0 ? kind : 'idle';
    }

    function sessionRunStatusLabel(kind) {
      if (kind === 'running') return t('sessionStatusRunning');
      if (kind === 'waiting') return t('sessionStatusWaiting');
      if (kind === 'failed') return t('sessionStatusFailed');
      if (kind === 'stopped') return t('sessionStatusStopped');
      if (kind === 'completed') return t('sessionStatusCompleted');
      return t('sessionStatusIdle');
    }

    function applyRunStatusBadge(badge, entry) {
      var kind = sessionRunStatusKind(entry);
      var label = sessionRunStatusLabel(kind);
      var detail = entry && typeof entry.detail === 'string' ? entry.detail.trim() : '';
      var text = detail ? label + ': ' + detail : label;
      badge.className = 'session-status-badge is-' + kind;
      badge.title = text;
      badge.setAttribute('aria-label', text);
      badge.setAttribute('role', 'img');
      return badge;
    }

    /** Always returns a marker, so the row grid keeps its status column even for
     * a conversation the Host has no observation for. */
    function renderRunStatusBadge(sessionId) {
      var badge = document.createElement('span');
      badge.dataset.sessionStatusId = sessionId;
      return applyRunStatusBadge(badge, sessionRunStatusEntry(sessionId));
    }

    /** Patch the markers in place: a live status change must never rebuild the
     * panel and steal the caret out of a rename input. */
    function syncSessionStatusBadges(sessions) {
      if (!sessionMenu || !sessionMenuOpen) return;
      for (var i = 0; i < sessions.length; i++) {
        var sessionId = sessions[i].id;
        var badge = sessionMenu.querySelector('[data-session-status-id="' + cssEscape(sessionId) + '"]');
        if (badge instanceof HTMLElement) applyRunStatusBadge(badge, sessionRunStatusEntry(sessionId));
      }
    }`.slice(1)
};