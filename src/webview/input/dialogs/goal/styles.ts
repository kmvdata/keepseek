import type { WebviewFragment } from '../../composition';

export const goalDialogStylesFragment: WebviewFragment = {
  id: 'styles.dialogs.goal',
  source: `
    .goal-dialog { width: min(620px, calc(100vw - var(--keepseek-edge-padding-double, 8px))); }
    .goal-budget-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 10px; }
    .goal-validations { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 12px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; font-size: 12px; }
    .goal-validations label { display: flex; align-items: center; gap: 4px; }
    .goal-warning { margin: 8px 0; padding: 8px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); font-size: 11px; line-height: 1.4; }
    .goal-command-preview { display: grid; gap: 4px; margin-top: 10px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .goal-command-preview code { display: block; max-height: 90px; overflow: auto; white-space: pre-wrap; color: var(--vscode-foreground); }
    .goal-lifecycle-notice { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
    @media (max-width: 420px) { .goal-budget-grid { grid-template-columns: 1fr; } }
`.slice(1)
};
