import type { WebviewFragment } from '../../input/composition';

/**
 * Hover intent for the session-history menu.
 *
 * The panel is anchored below the header, so moving from the button into the
 * panel crosses a gap where neither element reports hover. A short open delay
 * suppresses accidental sweeps over the button, and the hide grace period plus
 * a live :hover re-check keeps the panel open while the pointer travels into
 * it. renderSessionMenu() only rebuilds the panel's children, never the
 * #sessionMenu container, so these listeners survive a redraw.
 */
export const conversationsMenuHoverFragment: WebviewFragment = {
  id: 'conversations.menu-hover',
  source: `
    var sessionMenuHoverOpenDelayMs = 120;
    var sessionMenuHoverHideDelayMs = 500;
    var sessionMenuHoverOpenTimer = 0;
    var sessionMenuHoverHideTimer = 0;

    function cancelSessionMenuHoverOpen() {
      if (sessionMenuHoverOpenTimer) {
        window.clearTimeout(sessionMenuHoverOpenTimer);
        sessionMenuHoverOpenTimer = 0;
      }
    }

    function cancelSessionMenuHoverHide() {
      if (sessionMenuHoverHideTimer) {
        window.clearTimeout(sessionMenuHoverHideTimer);
        sessionMenuHoverHideTimer = 0;
      }
    }

    function cancelSessionMenuHoverTimers() {
      cancelSessionMenuHoverOpen();
      cancelSessionMenuHoverHide();
    }

    /** A live pointer test: a redraw or a layout change can drop enter/leave events. */
    function isSessionMenuPointerInside() {
      return Boolean((historyTab && historyTab.matches(':hover'))
        || (sessionMenuOpen && sessionMenu && sessionMenu.matches(':hover')));
    }

    /** Focus inside the panel (a rename field, a select) also keeps it open. */
    function sessionMenuKeepsFocus() {
      var active = document.activeElement;
      if (!active || active === document.body) return false;
      return Boolean(sessionMenu && sessionMenu.contains(active));
    }

    function scheduleSessionMenuHoverOpen() {
      if (sessionMenuOpen || sessionMenuHoverOpenTimer) return;
      sessionMenuHoverOpenTimer = window.setTimeout(function() {
        sessionMenuHoverOpenTimer = 0;
        if (sessionMenuOpen || !canNavigateSessions() || !isSessionMenuPointerInside()) return;
        closeSettingsMenu();
        openSessionMenu(false);
      }, sessionMenuHoverOpenDelayMs);
    }

    function scheduleSessionMenuHoverHide() {
      if (!sessionMenuOpen || sessionMenuHoverHideTimer) return;
      sessionMenuHoverHideTimer = window.setTimeout(function() {
        sessionMenuHoverHideTimer = 0;
        if (!sessionMenuOpen) return;
        if (isSessionMenuPointerInside()) return;
        if (sessionMenuKeepsFocus()) return;
        closeSessionMenu();
      }, sessionMenuHoverHideDelayMs);
    }

    if (historyTab) {
      historyTab.addEventListener('mouseenter', function() {
        cancelSessionMenuHoverHide();
        scheduleSessionMenuHoverOpen();
      });
      historyTab.addEventListener('mouseleave', function() {
        cancelSessionMenuHoverOpen();
        scheduleSessionMenuHoverHide();
      });
    }

    if (sessionMenu) {
      sessionMenu.addEventListener('mouseenter', function() {
        cancelSessionMenuHoverHide();
      });
      sessionMenu.addEventListener('mouseleave', function() {
        scheduleSessionMenuHoverHide();
      });
      sessionMenu.addEventListener('focusin', function() {
        cancelSessionMenuHoverHide();
      });
    }`.slice(1)
};
