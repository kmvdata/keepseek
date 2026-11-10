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
        if (!sessionId) {
          closeSessionMenu();
          return;
        }

        if (sessionId !== state.activeSessionId || item?.dataset.sessionOrigin === 'other') {
          resetLocalContextUsageEstimate();
        }
        closeSessionMenu();
        if (item?.dataset.sessionOrigin === 'other') {
          var workspaceKey = item.dataset.workspaceKey || activeWorkspaceTab;
          if (workspaceKey) {
            vscode.postMessage({
              type: 'copyOtherWorkspaceSession',
              workspaceKey: workspaceKey,
              sessionId: sessionId
            });
          }
        } else {
          vscode.postMessage({ type: 'selectSession', sessionId: sessionId });
        }
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

        if (target.dataset.sessionWorkspace === 'true') {
          switchSessionWorkspace(target.value || 'current');
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
            var keyboardWorkspaceKey = item.dataset.workspaceKey || activeWorkspaceTab;
            if (keyboardSessionId !== state.activeSessionId || item.dataset.sessionOrigin === 'other') {
              resetLocalContextUsageEstimate();
            }
            closeSessionMenu();
            if (item.dataset.sessionOrigin === 'other' && keyboardWorkspaceKey) {
              vscode.postMessage({
                type: 'copyOtherWorkspaceSession',
                workspaceKey: keyboardWorkspaceKey,
                sessionId: keyboardSessionId
              });
            } else {
              vscode.postMessage({ type: 'selectSession', sessionId: keyboardSessionId });
            }
          }
        }
      });
    }`.slice(1)
};

export const conversationsMenuDismissFragment: WebviewFragment = {
  id: 'conversations.menu-dismiss',
  source: `
    document.addEventListener('mousedown', function(event) {
      if (!sessionMenuOpen) return;
      var target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      if ((sessionMenu && sessionMenu.contains(target)) || (historyTab && historyTab.contains(target))) {
        return;
      }
      closeSessionMenu();
    });`.slice(1)
};
