import type { WebviewFragment } from '../../input/composition';

/** Selected-task detail panel and its action buttons. */
export const detailStylesFragment: WebviewFragment = {
  id: 'sidebar-detail-styles',
  source: `    .project-task-detail { margin-top: 7px; padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); }
    .project-task-detail h3 { margin: 3px 0; font-size: 12px; overflow-wrap: anywhere; }
    .project-task-actions { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; }
    .project-task-actions button, .project-task-more-menu button { font: inherit; font-size: 11px; padding: 3px 7px; min-height: 25px; }
`
};
