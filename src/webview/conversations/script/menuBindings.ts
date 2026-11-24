import type { WebviewFragment } from '../../input/composition';

export const conversationsMenuBindingsFragment: WebviewFragment = {
  id: 'conversations.menu-bindings',
  source: `
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
        if (!canNavigateSessions()) return;

        var item = target.closest('[data-session-id]');
        var sessionId = item?.dataset.sessionId || '';
        // The panel doubles as a dashboard: a click on its own blank chrome keeps
        // it open, so only the header button toggles visibility.
        if (!sessionId) return;

        if (sessionId !== state.activeSessionId) {
          resetLocalContextUsageEstimate();
        }
        closeSessionMenu();
        vscode.postMessage({ type: 'selectSession', sessionId: sessionId });
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
            titleInput.dataset.cancelTitleEdit = 'true';
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
          if (!canNavigateSessions()) return;
          var keyboardSessionId = item.dataset.sessionId || '';
          if (keyboardSessionId) {
            if (keyboardSessionId !== state.activeSessionId) {
              resetLocalContextUsageEstimate();
            }
            closeSessionMenu();
            vscode.postMessage({ type: 'selectSession', sessionId: keyboardSessionId });
          }
        }
      });
    }`.slice(1)
};
