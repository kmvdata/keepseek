import type { WebviewFragment } from '../../input/composition';

/** Custom context-usage ring / status badge used by rail lamps and list cards. */
export const ringStylesFragment: WebviewFragment = {
  id: 'sidebar-ring-styles',
  source: `    .project-task-ring { --task-status-color: var(--vscode-charts-orange, #c88b36); position: relative; display: inline-flex; flex: 0 0 28px; width: 28px; height: 28px; align-items: center; justify-content: center; vertical-align: middle; }
    .project-task-ring svg { position: absolute; inset: 0; width: 28px; height: 28px; transform: rotate(-90deg); overflow: visible; }
    .project-task-ring-track { fill: none; stroke: var(--vscode-widget-border, var(--vscode-descriptionForeground)); opacity: .4; stroke-width: 2.5; }
    .project-task-ring-arc { fill: none; stroke: var(--vscode-progressBar-background, var(--vscode-focusBorder, #6796e6)); stroke-width: 2.5; }
    .project-task-ring[data-usage-status="unknown"] .project-task-ring-track { stroke-dasharray: 2 3; }
    .project-task-ring[data-state="completed"] { --task-status-color: var(--vscode-charts-green, #388a34); }
    .project-task-ring[data-state="failed"], .project-task-ring[data-state="cancelled"], .project-task-ring[data-state="interrupted"] { --task-status-color: var(--vscode-charts-red, #c94f4f); }
    .project-task-status-icon { width: 19px; height: 19px; display: inline-flex; align-items: center; justify-content: center; border-radius: 50%; color: var(--vscode-sideBar-background, #fff); background: var(--task-status-color); font-size: 12px; font-weight: bold; line-height: 1; }
`
};
