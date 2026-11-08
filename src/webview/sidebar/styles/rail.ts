import type { WebviewFragment } from '../../input/composition';

/** 44px left rail: control buttons, active-task lamps and the live-region sink. */
export const railStylesFragment: WebviewFragment = {
  id: 'sidebar-rail-styles',
  source: `    .project-tasks { flex: 0 0 44px; width: 44px; min-height: 0; display: flex; flex-direction: column; align-items: center; gap: 3px; padding: 4px 2px; border-right: 1px solid var(--vscode-panel-border); }
    .project-rail-control { flex: 0 0 36px; width: 36px; height: 36px; padding: 0; color: var(--vscode-foreground); background: transparent; font-size: 18px; }
    .project-task-rail-list { flex: 1; min-height: 0; width: 40px; overflow-y: auto; overflow-x: hidden; scrollbar-width: thin; }
    .project-task-rail-item { height: 42px; width: 38px; display: flex; align-items: center; justify-content: center; }
    .project-task-announcements { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    .project-task-lamp { width: 36px; height: 36px; min-height: 36px; padding: 3px; background: transparent; border-radius: 6px; }
    .project-task-lamp:hover { background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground)); }
    .project-task-lamp.is-selected { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
`
};
