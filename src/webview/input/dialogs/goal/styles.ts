import type { WebviewFragment } from '../../composition';

export const goalDialogStylesFragment: WebviewFragment = {
  id: 'styles.dialogs.goal',
  source: `
    .goal-dialog { width: min(620px, calc(100vw - var(--keepseek-edge-padding-double, 8px))); }
    .goal-generation-status { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: 0 0 10px; padding: 8px 10px; border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border)); border-radius: 6px; color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-editor-background) 90%, var(--vscode-textLink-foreground)); font-size: 11px; line-height: 1.4; }
    .goal-generation-status button { flex: 0 0 auto; min-height: 24px; padding: 2px 8px; }
    .goal-generate-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin: -3px 0 8px; }
    .goal-generate-row .settings-dialog-desc { margin: 0; }
    .goal-generate-row button { flex: 0 0 auto; min-height: 25px; padding: 2px 8px; }
    .goal-generated-criteria { display: grid; gap: 5px; margin: -3px 0 10px; }
    .goal-generated-criterion { display: grid; grid-template-columns: minmax(128px, auto) 1fr; gap: 8px; align-items: baseline; padding: 5px 7px; border-radius: 4px; background: var(--vscode-textBlockQuote-background); font-size: 10px; line-height: 1.35; }
    .goal-generated-type { color: var(--vscode-textLink-foreground); }
    .goal-generated-evidence { min-width: 0; color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .goal-proposal-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin: 2px 0 7px; }
    .goal-proposal-toolbar > div { display: flex; gap: 5px; }
    .goal-proposal-toolbar button { min-height: 24px; padding: 2px 7px; font-size: 10px; }
    .goal-proposal-work-items { display: grid; gap: 7px; margin-bottom: 10px; }
    .goal-proposal-item { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 7px; padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
    .goal-proposal-item:focus-within { border-color: var(--vscode-focusBorder); }
    .goal-proposal-item.is-unselected { opacity: .7; border-style: dashed; }
    .goal-proposal-item input { margin-top: 2px; }
    .goal-proposal-copy { display: grid; min-width: 0; gap: 3px; }
    .goal-proposal-copy strong, .goal-proposal-copy span { overflow-wrap: anywhere; }
    .goal-proposal-detail, .goal-proposal-criteria, .goal-proposal-selection-state { color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.4; }
    .goal-proposal-selection-state { color: var(--vscode-textLink-foreground); font-weight: 600; }
    .goal-proposal-item.is-unselected .goal-proposal-selection-state { color: var(--vscode-disabledForeground); }
    .goal-approval-mode-notice { margin: 0 0 10px; padding: 6px 8px; border-radius: 4px; background: var(--vscode-textBlockQuote-background); color: var(--vscode-descriptionForeground); font-size: 10px; }
    .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
    .goal-advanced { margin: 2px 0 8px; border-top: 1px solid var(--vscode-panel-border); border-bottom: 1px solid var(--vscode-panel-border); }
    .goal-advanced > summary { padding: 9px 1px; cursor: pointer; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .goal-advanced-body { display: grid; gap: 0; padding-top: 4px; }
    .goal-budget-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0 10px; }
    .goal-validations { display: flex; flex-wrap: wrap; gap: 10px; margin: 0 0 12px; border: 1px solid var(--vscode-panel-border); border-radius: 5px; font-size: 12px; }
    .goal-validations label { display: flex; align-items: center; gap: 4px; }
    .goal-warning { margin: 8px 0; padding: 8px; border-left: 3px solid var(--vscode-editorWarning-foreground); background: var(--vscode-textBlockQuote-background); font-size: 11px; line-height: 1.4; }
    .goal-message-preview { display: grid; gap: 4px; margin-top: 10px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .goal-message-preview code { display: block; max-height: 90px; overflow: auto; white-space: pre-wrap; color: var(--vscode-foreground); }
    .goal-lifecycle-notice { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; }
    .goal-manage-pane { gap: 14px; }
    .goal-manage-summary { display: grid; gap: 7px; padding: 10px; border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border)); border-radius: 7px; background: color-mix(in srgb, var(--vscode-editor-background) 92%, var(--vscode-textLink-foreground)); }
    .goal-manage-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
    .goal-manage-heading strong { min-width: 0; overflow-wrap: anywhere; }
    .goal-status-pill { flex: 0 0 auto; padding: 2px 6px; border-radius: 999px; color: var(--vscode-descriptionForeground); background: var(--vscode-badge-background); font-size: 10px; white-space: nowrap; }
    .goal-manage-meta, .goal-manage-reason { color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
    .goal-manage-reason { padding-top: 6px; border-top: 1px solid var(--vscode-panel-border); color: var(--vscode-foreground); }
    .goal-manage-reason.is-pending { color: var(--vscode-textLink-foreground); }
    .goal-manage-reason.is-error { color: var(--vscode-errorForeground); }
    .goal-manage-section { display: grid; gap: 6px; }
    .goal-manage-work-items, .goal-manage-criteria, .goal-manage-validations, .goal-manage-traces { display: grid; gap: 5px; margin: 0; padding-left: 20px; font-size: 11px; line-height: 1.4; }
    .goal-manage-work-items li, .goal-manage-criteria li, .goal-manage-validations li, .goal-manage-traces li { overflow-wrap: anywhere; }
    .goal-manage-work-items li.is-completed { color: var(--vscode-testing-iconPassed); }
    .goal-manage-work-items li.is-blocked, .goal-manage-work-items li.is-failed { color: var(--vscode-errorForeground); }
    .goal-manage-traces button { min-height: 23px; padding: 1px 7px; font-size: 10px; }
    .goal-trace-toolbar { display: flex; justify-content: flex-end; margin: 6px 0; }
    .goal-manage-criteria li.is-satisfied, .goal-manage-validations li.is-passed { color: var(--vscode-testing-iconPassed); }
    .goal-manage-criteria li.is-blocked, .goal-manage-validations li.is-failed { color: var(--vscode-errorForeground); }
    .goal-confirm-criterion { min-height: 22px; margin-top: 4px; padding: 1px 6px; font-size: 10px; }
    .goal-manage-controls, .goal-amend-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .goal-manage-controls button { min-height: 26px; padding: 3px 9px; }
    .goal-amend-row input { min-width: 0; flex: 1; border: 1px solid var(--vscode-input-border); border-radius: 4px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); padding: 6px 8px; font-size: 11px; }
    @media (max-width: 420px) {
      .goal-budget-grid { grid-template-columns: 1fr; }
      .goal-manage-heading { display: grid; }
      .goal-status-pill { justify-self: start; }
      .goal-amend-row { align-items: stretch; }
      .goal-amend-row input { flex-basis: 100%; }
      .goal-generated-criterion { grid-template-columns: 1fr; gap: 2px; }
      .goal-generate-row { align-items: flex-start; }
      .goal-proposal-toolbar { align-items: flex-start; flex-direction: column; }
    }
`.slice(1)
};
