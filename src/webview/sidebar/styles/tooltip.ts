import type { WebviewFragment } from '../../input/composition';

/** Fixed-position hover/focus tooltip anchored to a rail lamp or list card. */
export const tooltipStylesFragment: WebviewFragment = {
  id: 'sidebar-tooltip-styles',
  source: `    .project-task-tooltip { position: fixed; z-index: 35; max-width: min(320px, calc(100vw - 12px)); max-height: min(300px, calc(100vh - 12px)); overflow: auto; pointer-events: auto; white-space: pre-line; overflow-wrap: anywhere; padding: 7px 9px; color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground)); background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background)); border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border)); box-shadow: 0 2px 8px var(--vscode-widget-shadow, #0005); font-size: 11px; }
`
};
