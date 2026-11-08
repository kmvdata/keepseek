import type { WebviewFragment } from '../../input/composition';

/**
 * 32px blank drawer handle. The rail intentionally carries no product controls:
 * only the single expand button at the top plus the live-region sink. New rail
 * buttons are wired through `window.keepseekProjectTasks` instead of new ids.
 */
export const railTemplateFragment: WebviewFragment = {
  id: 'sidebar-rail-template',
  source: `
    <nav id="projectTasks" class="project-tasks hidden" aria-label="Project tasks" data-i18n-aria-label="projectTasksTitle">
      <button id="projectSidebarToggle" type="button" class="project-rail-control" aria-controls="projectTaskSidebar" aria-expanded="false" data-i18n-title="projectOpenTasks" data-i18n-aria-label="projectOpenTasks">☰</button>
      <span id="projectTaskAnnouncements" class="project-task-announcements" role="status" aria-live="polite" aria-atomic="true"></span>
    </nav>`
};
