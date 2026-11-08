import type { WebviewFragment } from '../../input/composition';

/** Task list rows and the open-card typography inside the drawer. */
export const cardStylesFragment: WebviewFragment = {
  id: 'sidebar-card-styles',
  source: `    .project-task-list { display: grid; gap: 4px; margin-top: 6px; }
    .project-task-card { min-width: 0; border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 6px; background: var(--vscode-sideBar-background); }
    .project-task-card.is-selected { border-color: var(--vscode-focusBorder); }
    .project-task-open { appearance: none; display: flex; gap: 7px; align-items: flex-start; border: 0; padding: 0; width: 100%; background: transparent; color: var(--vscode-foreground); text-align: left; font: inherit; cursor: pointer; }
    .project-task-copy { flex: 1; min-width: 0; }
    .project-task-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-weight: 600; overflow-wrap: anywhere; }
    .project-task-phase, .project-task-progress, .project-task-metrics, .project-task-first, .project-task-current { font-size: 11px; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); }
    .project-task-progress { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
    .project-task-current { color: var(--vscode-focusBorder); }
    .project-task-metrics { margin-top: 2px; }
`
};
