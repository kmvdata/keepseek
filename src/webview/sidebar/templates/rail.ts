import type { WebviewFragment } from '../../input/composition';

/** 44px left rail: view switches plus the active-task lamp list. */
export const railTemplateFragment: WebviewFragment = {
  id: 'sidebar-rail-template',
  source: `
    <nav id="projectTasks" class="project-tasks hidden" aria-label="Project tasks" data-i18n-aria-label="projectTasksTitle">
      <button id="projectSidebarToggle" type="button" class="project-rail-control" aria-controls="projectTaskSidebar" aria-expanded="false" data-i18n-title="projectOpenTasks" data-i18n-aria-label="projectOpenTasks">☰</button>
      <button id="projectAssistantView" type="button" class="project-rail-control" data-i18n-title="projectAssistant" data-i18n-aria-label="projectAssistant">✦</button>
      <button id="projectNewTask" type="button" class="project-rail-control" data-i18n-title="projectNewTask" data-i18n-aria-label="projectNewTask">+</button>
      <div id="projectTaskRailList" class="project-task-rail-list" role="list"></div>
      <button id="projectTaskHistory" type="button" class="project-rail-control" data-i18n-title="projectAllTasks" data-i18n-aria-label="projectAllTasks">◷</button>
      <span id="projectTaskAnnouncements" class="project-task-announcements" role="status" aria-live="polite" aria-atomic="true"></span>
    </nav>`
};
