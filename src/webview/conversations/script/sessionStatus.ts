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
     * is the record of what the user created, so only \`createdAt\` moves a row —
     * except an explicit pin: pinning is the one reorder the user asks for, while
     * browsing, streaming or saving a conversation must never touch the order.
     */
    function getSessionCreatedTimestamp(session) {
      var timestamp = Date.parse(session.createdAt || session.updatedAt || '');
      if (Number.isFinite(timestamp)) return timestamp;
      return getSessionTimestamp(session);
    }

    function compareSessionsByCreation(a, b) {
      var byPinned = (b.isPinned === true ? 1 : 0) - (a.isPinned === true ? 1 : 0);
      if (byPinned) return byPinned;
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

    /** A row has a run when the Host projected a conclusion for it. An unprojected
     * or unknown kind is the hollow idle ring, so it must not claim a run. */
    function sessionHasRun(sessionId) {
      return sessionRunStatusKind(sessionRunStatusEntry(sessionId)) !== 'idle';
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

    /** Only a live run or a session waiting for the user needs a confirmation. */
    function sessionRunStopsLiveWork(sessionId) {
      var kind = sessionRunStatusKind(sessionRunStatusEntry(sessionId));
      return kind === 'running' || kind === 'waiting';
    }

    /** Hollow square: leave a finished run. Solid square: stop a live one first. */
    function applyRunStopButton(button, sessionId) {
      var live = sessionRunStopsLiveWork(sessionId);
      var label = live ? t('sessionRunDismissActive') : t('sessionRunDismissIdle');
      var hint = live ? t('sessionRunDismissActiveHint') : t('sessionRunDismissIdleHint');
      button.dataset.runStopShape = live ? 'solid' : 'hollow';
      button.setAttribute('aria-label', label);
      button.title = hint ? label + ': ' + hint : label;
      button.innerHTML = live
        ? '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="currentColor"/></svg>'
        : '<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>';
      return button;
    }

    /** A row with no run keeps the stop column as an inert spacer: no action,
     * nothing focusable, and the row grid never shifts when a status arrives. */
    function renderSessionRunStopButton(sessionId) {
      if (!sessionHasRun(sessionId)) {
        var spacer = document.createElement('span');
        spacer.className = 'session-menu-run-stop is-empty';
        spacer.setAttribute('aria-hidden', 'true');
        spacer.dataset.sessionStopId = sessionId;
        return spacer;
      }
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'session-menu-run-stop';
      button.dataset.sessionAction = 'dismissSessionRun';
      button.dataset.sessionId = sessionId;
      button.dataset.sessionStopId = sessionId;
      return applyRunStopButton(button, sessionId);
    }

    /** Patch the markers in place: a live status change must never rebuild the
     * panel and steal the caret out of a rename input. */
    function syncSessionStatusBadges(sessions) {
      if (!sessionMenu || !sessionMenuOpen) return;
      for (var i = 0; i < sessions.length; i++) {
        var sessionId = sessions[i].id;
        var badge = sessionMenu.querySelector('[data-session-status-id="' + cssEscape(sessionId) + '"]');
        if (badge instanceof HTMLElement) applyRunStatusBadge(badge, sessionRunStatusEntry(sessionId));
        // The stop square is part of the same live surface: patch its shape and
        // labels instead of rebuilding the row under an open rename input. Idle
        // rows carry a spacer, so the button selector deliberately misses them.
        var stopButton = sessionMenu.querySelector('button[data-session-stop-id="' + cssEscape(sessionId) + '"]');
        if (stopButton instanceof HTMLElement) applyRunStopButton(stopButton, sessionId);
      }
    }`.slice(1)
};