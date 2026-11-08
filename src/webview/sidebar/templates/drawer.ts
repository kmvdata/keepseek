import type { WebviewFragment } from '../../input/composition';

/**
 * Drawer frame anchored over the transcript stage. The fragment intentionally
 * omits a trailing newline: the overlay template joins it with the tooltip.
 */
export const drawerTemplateFragment: WebviewFragment = {
  id: 'sidebar-drawer-template',
  source: `
    <aside id="projectTaskSidebar" class="project-task-sidebar hidden" aria-label="Project tasks" data-i18n-aria-label="projectTasksTitle">
      <div class="project-sidebar-header">
        <strong data-i18n="projectTasksTitle">项目任务</strong>
        <button id="projectSidebarClose" type="button" class="secondary" data-i18n-title="projectCloseTasks" data-i18n-aria-label="projectCloseTasks">×</button>
      </div>
      <div class="project-sidebar-ranges">
        <select id="projectTaskScope" data-i18n-aria-label="projectTaskScope" aria-label="Task range">
          <option value="recent" data-i18n="projectRecentTasks">最近24小时</option>
          <option value="all" data-i18n="projectAllTasks">全部任务</option>
        </select>
        <label><input id="projectShowArchived" type="checkbox" /><span data-i18n="projectShowArchived">显示归档</span></label>
        <details id="projectTaskMore" class="project-task-more">
          <summary data-i18n="projectMoreActions">更多</summary>
          <div class="project-task-more-menu">
            <button id="projectAssociateSession" type="button" class="secondary" data-i18n="projectAssociateSession">关联当前会话</button>
            <button id="projectStopAll" type="button" class="secondary" data-i18n="projectStopAll">停止全部</button>
          </div>
        </details>
      </div>
      <div class="project-sidebar-content">
        <div id="projectTiming" class="project-task-metrics hidden"></div>
        <div id="projectRouterUsage" class="project-task-metrics hidden"></div>
        <div id="projectTaskList" class="project-task-list" role="list"></div>
        <div id="projectTaskDetail" class="project-task-detail"></div>
      </div>
    </aside>`
};
