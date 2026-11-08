import type { WebviewFragment } from '../../input/composition';

/** 32px blank drawer handle: the single expand button and the live-region sink. */
export const railStylesFragment: WebviewFragment = {
  id: 'sidebar-rail-styles',
  source: `    .project-tasks { flex: 0 0 32px; width: 32px; min-height: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 4px 2px; border-right: 1px solid var(--vscode-panel-border); }
    .project-rail-control { flex: 0 0 28px; width: 28px; height: 28px; padding: 0; display: flex; align-items: center; justify-content: center; color: var(--vscode-foreground); background: transparent; font-size: 15px; border-radius: 5px; }
    .project-rail-control:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .project-task-announcements { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`
};
