import type { WebviewFragment } from '../../input/composition';

/** Drawer frame, its header/ranges/content rows and the "more" popup. */
export const drawerStylesFragment: WebviewFragment = {
  id: 'sidebar-drawer-styles',
  source: `    .project-task-sidebar { position: absolute; inset: 0 auto 0 0; width: min(180px, 100%); min-width: 0; display: flex; flex-direction: column; z-index: 20; background: var(--vscode-sideBar-background, var(--vscode-editor-background)); border-right: 1px solid var(--vscode-panel-border); box-shadow: 4px 0 12px var(--vscode-widget-shadow, #0005); }
    .project-sidebar-header { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; gap: 4px; }
    .project-sidebar-header button { padding: 2px 7px; }
    .project-sidebar-ranges { flex: 0 0 auto; display: flex; gap: 5px; flex-wrap: wrap; align-items: center; padding: 3px 8px 6px; font-size: 11px; border-bottom: 1px solid var(--vscode-panel-border); }
    .project-sidebar-ranges select { min-width: 0; max-width: 100%; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border)); }
    .project-sidebar-ranges label { display: inline-flex; align-items: center; gap: 2px; }
    .project-sidebar-content { min-height: 0; overflow-y: auto; padding: 6px; }
    .project-task-more { position: relative; margin-left: auto; }
    .project-task-more summary { cursor: pointer; }
    .project-task-more:not([open]) .project-task-more-menu { display: none; }
    .project-task-more-menu { position: absolute; top: 100%; right: 0; z-index: 2; display: grid; gap: 3px; min-width: min(130px, calc(100vw - 56px)); max-width: min(230px, calc(100vw - 56px)); padding: 5px; background: var(--vscode-menu-background, var(--vscode-sideBar-background)); border: 1px solid var(--vscode-panel-border); box-shadow: 0 2px 7px var(--vscode-widget-shadow, #0005); }
`
};
