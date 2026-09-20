import type { WebviewFragment } from './composition';

export const executionModeStylesFragment: WebviewFragment = {
  id: 'styles.execution-mode',
  source: `
    .composer-execution-mode-control {
      position: relative;
      display: inline-flex;
      flex: 0 0 auto;
    }

    .composer-execution-mode-btn {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 15px;
      font-weight: 500;
      line-height: 1;
    }

    .composer-execution-mode-btn[aria-expanded="true"],
    .composer-execution-mode-btn.is-active {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground));
    }

    .execution-mode-tooltip {
      position: absolute;
      left: -60px;
      bottom: calc(100% + 6px);
      z-index: 42;
      display: flex;
      flex-direction: column;
      gap: 3px;
      width: max-content;
      max-width: min(280px, calc(100vw - 24px));
      padding: 7px 8px;
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
      border-radius: 6px;
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      box-shadow: 0 3px 10px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.24));
      font-family: var(--vscode-font-family);
      font-size: 11px;
      font-weight: 400;
      line-height: 1.4;
      text-align: left;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      opacity: 0;
      visibility: hidden;
      transform: translateY(2px);
      pointer-events: none;
      transition: opacity 100ms ease, transform 100ms ease, visibility 0s linear 100ms;
    }

    .execution-mode-tooltip-title {
      font-weight: 600;
    }

    .execution-mode-tooltip-description {
      color: var(--vscode-descriptionForeground);
    }

    .composer-execution-mode-control:hover .execution-mode-tooltip,
    .composer-execution-mode-btn:focus-visible + .execution-mode-tooltip {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
      transition-delay: 80ms;
    }

    .composer-execution-mode-btn[aria-expanded="true"] + .execution-mode-tooltip,
    .execution-mode-tooltip[aria-hidden="true"] {
      opacity: 0;
      visibility: hidden;
      transition-delay: 0s;
    }

    .execution-mode-menu {
      position: absolute;
      left: -60px;
      bottom: calc(100% + 6px);
      z-index: 41;
      display: flex;
      flex-direction: column;
      width: min(286px, calc(100vw - 24px));
      padding: 4px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px;
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
    }

    .execution-mode-menu.hidden {
      display: none;
    }

    .execution-mode-option {
      display: grid;
      grid-template-columns: 18px minmax(0, 1fr);
      align-items: start;
      gap: 6px;
      width: 100%;
      padding: 7px 8px;
      border: none;
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
      cursor: pointer;
    }

    .execution-mode-option:hover,
    .execution-mode-option:focus-visible,
    .execution-mode-option[aria-checked="true"] {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .execution-mode-option-check {
      color: var(--vscode-textLink-foreground, currentColor);
      font-size: 12px;
      line-height: 1.35;
      text-align: center;
    }

    .execution-mode-option-copy {
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 2px;
    }

    .execution-mode-option-label {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.3;
    }

    .execution-mode-option-description {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
    }

`.slice(1)
};
