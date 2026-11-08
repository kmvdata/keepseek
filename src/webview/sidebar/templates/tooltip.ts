import type { WebviewFragment } from '../../input/composition';

/** Fixed-position tooltip sink; content is filled lazily on hover/focus. */
export const tooltipTemplateFragment: WebviewFragment = {
  id: 'sidebar-tooltip-template',
  source: `    <div id="projectTaskTooltip" class="project-task-tooltip hidden" role="tooltip"></div>`
};
