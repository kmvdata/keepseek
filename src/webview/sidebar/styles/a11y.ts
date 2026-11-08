import type { WebviewFragment } from '../../input/composition';

/** Focus rings plus forced-colors and reduced-motion fallbacks for the sidebar. */
export const a11yStylesFragment: WebviewFragment = {
  id: 'sidebar-a11y-styles',
  source: `    .project-tasks button:focus-visible, .project-task-sidebar button:focus-visible, .project-task-sidebar select:focus-visible { outline: 2px solid var(--vscode-focusBorder); outline-offset: -2px; }
    @media (forced-colors: active) { .project-task-status-icon { forced-color-adjust: none; color: Canvas; background: CanvasText; } .project-task-ring-arc { stroke: Highlight; } }
    @media (prefers-reduced-motion: reduce) { .project-task-ring, .project-task-sidebar { animation: none; transition: none; } }
  `
};
