import type { WebviewFragment } from '../composition';

export const composerBaseStylesFragment: WebviewFragment = {
  id: 'styles.composer.base',
  source: `
    .composer {
      background: var(--vscode-sideBar-background);
      padding: var(--keepseek-composer-padding, 0);
    }

    .composer-input-wrap {
      position: relative;
      padding: 0;
    }

    .composer-input-inner {
      display: flex;
      flex-direction: column;
      min-height: 116px;
      border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, transparent));
      border-radius: 6px;
      overflow: visible;
      background: var(--vscode-chat-requestBackground, var(--vscode-input-background));
    }

    .composer-input-inner:focus-within {
      border-color: var(--vscode-focusBorder);
    }

`.slice(1)
};

export const composerControlsStylesFragment: WebviewFragment = {
  id: 'styles.composer.controls',
  source: `
    .composer-input-inner .rich-input {
      flex: 0 0 auto;
      min-height: 74px;
      padding: var(--keepseek-input-padding, 4px 4px 2px);
      background: transparent;
    }

    .composer-input-inner .rich-input.is-empty::before {
      top: 4px;
      left: 4px;
      right: 4px;
    }

    .composer-toolbar {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 30px;
      padding: var(--keepseek-toolbar-padding, 0 4px 4px);
    }

    .composer-model-selection-status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      margin: 0 4px 3px;
      padding: 4px 6px;
      border-radius: 5px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textBlockQuote-background, var(--vscode-sideBar-background));
      font-size: 11px;
      line-height: 1.35;
    }

    .composer-model-selection-status > span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .composer-toolbar-left {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      flex: 1;
    }

    .composer-toolbar-right {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
      flex: 0 0 auto;
      margin-left: auto;
    }

    .composer-icon-btn,
    .composer-send-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
      border-radius: 6px;
      cursor: pointer;
    }

    .composer-icon-btn,
    .composer-send-btn {
      width: 26px;
      min-width: 26px;
      height: 26px;
      min-height: 26px;
      padding: 0;
    }

    .composer-icon-btn {
      background: transparent;
      color: var(--vscode-foreground);
    }

    .composer-send-btn {
      background: var(--vscode-button-background, var(--vscode-foreground));
      border-color: var(--vscode-button-background, var(--vscode-foreground));
      color: var(--vscode-button-foreground, var(--vscode-editor-background));
    }

    .composer-reference-btn,
    .composer-command-btn {
      font-weight: 700;
    }

    .composer-reference-btn[aria-expanded="true"],
    .composer-reference-btn.is-active,
    .composer-command-btn[aria-expanded="true"],
    .composer-command-btn.is-active {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground));
    }

    .composer-trigger-glyph,
    .command-trigger-glyph {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      height: 16px;
      font-size: 15px;
      line-height: 16px;
      font-family: var(--vscode-editor-font-family, monospace);
    }

    .composer-icon-btn:hover:not(:disabled) {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder, var(--vscode-panel-border, var(--vscode-input-border, transparent)));
      background: var(--vscode-toolbar-hoverBackground);
    }

    .composer-icon-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .composer-send-btn:hover:not(:disabled) {
      border-color: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      color: var(--vscode-button-foreground, var(--vscode-editor-background));
    }

    .composer-send-btn.is-abort {
      border-color: var(--vscode-errorForeground, var(--vscode-button-background));
      background: var(--vscode-errorForeground, var(--vscode-button-background));
      color: var(--vscode-button-foreground, var(--vscode-editor-background));
    }

    .composer-send-btn.is-abort:hover:not(:disabled) {
      opacity: 0.88;
    }

    .composer-icon-btn:focus-visible,
    .composer-send-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .composer-toolbar-separator {
      width: 1px;
      height: 14px;
      margin: 0 4px;
      background: var(--vscode-panel-border);
      opacity: 0.75;
    }

    .composer-send-btn {
      flex: 0 0 auto;
      margin-left: auto;
    }

`.slice(1)
};

export const composerStatusStylesFragment: WebviewFragment = {
  id: 'styles.composer.status',
  source: `
    .composer-status,
    #status {
      display: block;
      flex: 1 1 auto;
      min-width: 0;
      height: 26px;
      margin-left: 6px;
      font-size: 11px;
      line-height: 26px;
    }

    .composer-status-text {
      display: block;
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      opacity: 0.82;
      transition: opacity 120ms ease;
    }

    .composer-status.is-active .composer-status-text,
    #status.is-active .composer-status-text {
      color: var(--vscode-descriptionForeground);
      opacity: 1;
      animation: keepseek-status-breathe 2.6s ease-in-out infinite;
    }

    .composer-status.is-fading .composer-status-text,
    #status.is-fading .composer-status-text {
      opacity: 0;
      animation: none;
    }

    .composer-status-tooltip {
      position: absolute;
      left: 4px;
      right: 4px;
      bottom: calc(100% + 4px);
      z-index: 40;
      padding: 7px 8px;
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      box-shadow: 0 3px 10px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.24));
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
      font-size: 11px;
      font-weight: 400;
      line-height: 1.45;
      text-align: left;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      opacity: 0;
      visibility: hidden;
      transform: translateY(2px);
      pointer-events: none;
      transition: opacity 100ms ease, transform 100ms ease, visibility 0s linear 100ms;
    }

    .composer-status:hover .composer-status-tooltip {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
      transition-delay: 80ms;
    }

    @keyframes keepseek-status-breathe {
      0%,
      100% {
        color: var(--vscode-descriptionForeground);
        opacity: 0.72;
        text-shadow: 0 0 0 transparent;
      }

      46% {
        color: var(--vscode-foreground);
        opacity: 1;
        text-shadow: 0 0 8px var(--vscode-focusBorder, transparent);
      }
    }

`.slice(1)
};

