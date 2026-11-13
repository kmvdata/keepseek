export function getRichTextContextMenuStyles(): string {
  return `
    .emacs-editor-context-menu {
      position: fixed;
      z-index: 2000;
      min-width: min(240px, calc(100vw - 8px));
      max-width: calc(100vw - 8px);
      max-height: calc(100vh - 8px);
      overflow-y: auto;
      padding: 4px;
      border: 1px solid var(--vscode-menu-border, var(--vscode-widget-border));
      border-radius: 5px;
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      background: var(--vscode-menu-background, var(--vscode-editor-background));
      box-shadow: 0 2px 8px var(--vscode-widget-shadow);
      font-size: 12px;
    }
    .emacs-editor-context-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 20px;
      width: 100%;
      min-height: 27px;
      padding: 4px 8px;
      border: 0;
      border-radius: 3px;
      color: inherit;
      background: transparent;
      text-align: left;
      font: inherit;
      cursor: pointer;
    }
    .emacs-editor-context-item:not(:disabled):hover,
    .emacs-editor-context-item:not(:disabled):focus-visible {
      color: var(--vscode-menu-selectionForeground, var(--vscode-list-activeSelectionForeground));
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-activeSelectionBackground));
      outline: 1px solid var(--vscode-menu-selectionBorder, transparent);
      outline-offset: -1px;
    }
    .emacs-editor-context-item:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .emacs-editor-context-item kbd {
      font: inherit;
      white-space: nowrap;
    }
    .emacs-editor-context-hint {
      margin-top: 3px;
      padding: 5px 8px 2px;
      border-top: 1px solid var(--vscode-menu-separatorBackground, var(--vscode-widget-border));
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }
`;
}
