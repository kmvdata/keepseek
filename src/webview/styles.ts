import { getInputStyles } from './input/styles';

export function getStyles(): string {
  return `
    :root {
      color-scheme: light dark;

      /* ---- input 区域边距变量（修改这些值即可调整间距） ---- */
      --keepseek-composer-padding: 0;
      --keepseek-input-padding: 4px 4px 2px;
      --keepseek-toolbar-padding: 0 4px 4px;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-chat-font-family, var(--vscode-font-family));
      font-size: var(--vscode-chat-font-size, 13px);
      line-height: 1.5;
    }

    button,
    input,
    select,
    textarea {
      font: inherit;
    }

    button {
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      padding: 4px 10px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      cursor: pointer;
      min-height: 26px;
      font-size: 12px;
    }

    button:hover {
      background: var(--vscode-button-hoverBackground);
    }

    button.secondary {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
    }

    button.secondary:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    button.icon {
      min-width: 20px;
      padding: 2px 4px;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font-size: 14px;
      line-height: 1;
    }

    button.icon:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }

    button:disabled {
      cursor: default;
      opacity: 0.45;
    }

    select {
      width: 100%;
      border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
      border-radius: 4px;
      color: var(--vscode-dropdown-foreground, var(--vscode-input-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      outline-color: var(--vscode-focusBorder);
      min-height: 26px;
      padding: 2px 24px 2px 8px;
      font-size: 12px;
      cursor: pointer;
      appearance: none;
      -webkit-appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
    }

    select:focus {
      border-color: var(--vscode-focusBorder);
    }

    input,
    textarea {
      width: 100%;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      outline-color: var(--vscode-focusBorder);
    }

    input {
      min-height: 26px;
      padding: 2px 8px;
      font-size: 12px;
    }

    textarea {
      min-height: 56px;
      max-height: 220px;
      padding: 10px 12px 6px;
      line-height: 1.45;
      font-size: 13px;
      border: none;
      background: transparent;
      outline: none;
      resize: none;
    }

    textarea:focus {
      outline: none;
    }

    textarea.drag-over {
      outline: 2px dashed var(--vscode-focusBorder);
      outline-offset: -2px;
      background: var(--vscode-list-dropBackground, var(--vscode-editor-selectionBackground));
    }

    ${getInputStyles()}

    .shell {
      position: relative;
      display: flex;
      flex-direction: column;
      height: 100vh;
      min-height: 0;
    }

    /* ---- header ---- */

    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      min-height: 36px;
    }

    .header-title {
      font-weight: 600;
      font-size: 13px;
      user-select: none;
    }

    .header-actions {
      display: flex;
      gap: 6px;
      align-items: center;
    }

    .header-tab {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      cursor: pointer;
      padding: 4px;
      border-radius: 4px;
      min-width: 24px;
      min-height: 24px;
    }

    .header-tab:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }

    .header-tab:disabled,
    .header-tab:disabled:hover {
      cursor: default;
      opacity: 0.45;
      color: var(--vscode-descriptionForeground);
      background: transparent;
    }

    .header-tab.active {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-activeBackground);
    }

    .session-menu {
      position: absolute;
      top: 36px;
      left: 8px;
      z-index: 40;
      width: min(320px, calc(100% - 16px));
      max-height: min(420px, calc(100vh - 72px));
      overflow-y: auto;
      padding: 6px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
    }

    .session-menu-title {
      padding: 4px 6px 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
    }

    .session-menu-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
      width: 100%;
      min-height: 42px;
      padding: 7px 8px;
      border: none;
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
    }

    .session-menu-item:hover,
    .session-menu-item:focus-visible {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .session-menu-item.is-active {
      background: var(--vscode-list-activeSelectionBackground, var(--vscode-toolbar-activeBackground));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    }

    .session-menu-item-title,
    .session-menu-item-meta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-menu-item-title {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.25;
    }

    .session-menu-item-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.25;
    }

    .session-menu-item.is-active .session-menu-item-meta {
      color: inherit;
      opacity: 0.78;
    }

    .session-menu-empty {
      padding: 12px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-align: center;
    }

    /* ---- context bar ---- */

    .context-bar {
      padding: 4px 12px 2px;
      min-height: 0;
    }

    .context-bar-inner {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
    }

    .context-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      max-width: 200px;
      padding: 2px 6px 2px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 12px;
      background: var(--vscode-badge-background, var(--vscode-editor-background));
      color: var(--vscode-badge-foreground, var(--vscode-descriptionForeground));
      font-size: 11px;
      line-height: 1.6;
    }

    .context-chip-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .context-chip-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      border: none;
      border-radius: 50%;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 12px;
      line-height: 1;
      padding: 0;
      opacity: 0.6;
      flex-shrink: 0;
    }

    .context-chip-remove:hover {
      opacity: 1;
      background: var(--vscode-list-hoverBackground);
    }

    .draft-bar {
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border));
      background: var(--vscode-editor-background);
    }

    .draft-bar-label {
      font-size: 11px;
      font-weight: 600;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .draft-bar-list {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }

    .draft-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 4px 8px;
      border: 1px solid var(--vscode-focusBorder);
      border-radius: 6px;
      font-size: 12px;
      background: var(--vscode-sideBar-background);
    }

    .draft-chip-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 160px;
    }

    .draft-chip-actions {
      display: flex;
      gap: 4px;
    }

    .draft-chip-actions button {
      font-size: 11px;
      padding: 2px 8px;
      min-height: 20px;
      border-radius: 3px;
    }

    /* ---- transcript ---- */

    .transcript {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 8px 12px 12px;
      background: transparent;
    }

    .transcript-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: var(--vscode-descriptionForeground);
      font-size: 13px;
      text-align: center;
      padding: 24px;
      gap: 8px;
    }

    .transcript-empty-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
      font-size: 32px;
      opacity: 0.78;
      margin-bottom: 4px;
    }

    .transcript-empty-icon img {
      display: block;
      width: 100%;
      height: 100%;
      object-fit: contain;
    }

    .message {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      margin-bottom: 18px;
    }

    .message.user {
      align-items: flex-end;
    }

    .message:last-child {
      margin-bottom: 0;
    }

    .message-body {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      min-width: 0;
      max-width: min(88%, 680px);
    }

    .message.user .message-body {
      align-items: flex-end;
    }

    .message.is-editing .message-body {
      width: min(88%, 680px);
    }

    .message-role {
      width: 100%;
      font-size: 10px;
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0;
      padding: 0 2px;
    }

    .message.user .message-role {
      color: var(--vscode-chat-requestColor, var(--vscode-textLink-foreground));
      text-align: right;
    }

    .message-content {
      width: 100%;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.55;
      padding: 0 2px;
    }

    .message-file-link {
      margin: 0 3px 2px;
      vertical-align: text-bottom;
    }

    .message.user .message-content {
      width: auto;
      max-width: 100%;
      padding: 7px 9px;
      border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-inputOption-activeBorder, var(--vscode-panel-border)));
      border-radius: 8px 8px 2px 8px;
      color: var(--vscode-chat-requestForeground, var(--vscode-foreground));
      background: var(--vscode-chat-requestBackground, var(--vscode-inputOption-activeBackground, var(--vscode-editor-background)));
      text-align: left;
    }

    .message-actions {
      display: flex;
      justify-content: flex-end;
      gap: 4px;
      width: 100%;
      min-height: 22px;
      margin-top: 4px;
    }

    .message-action-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      min-width: 22px;
      min-height: 22px;
      padding: 0;
      border: none;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
    }

    .message-action-btn:hover:not(:disabled),
    .message-action-btn:focus-visible {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
      outline: none;
    }

    .message-edit-form {
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: min(100%, 520px);
      min-width: min(100%, 240px);
      padding: 8px;
      border: 1px solid var(--vscode-focusBorder, var(--vscode-panel-border));
      border-radius: 8px 8px 2px 8px;
      background: var(--vscode-input-background, var(--vscode-editor-background));
    }

    .message-edit-input {
      display: block;
      width: 100%;
      min-height: 58px;
      max-height: 240px;
      padding: 0;
      border: none;
      border-radius: 0;
      color: var(--vscode-input-foreground, var(--vscode-foreground));
      background: transparent;
      outline: none;
      resize: none;
      overflow-y: auto;
      line-height: 1.5;
      font-size: 13px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
      caret-color: var(--vscode-input-foreground, var(--vscode-foreground));
    }

    .message-edit-footer {
      display: flex;
      justify-content: flex-end;
      gap: 6px;
    }

    .message-edit-footer button {
      min-height: 24px;
      padding: 2px 10px;
      font-size: 12px;
    }

    .message-reference-menu {
      position: fixed;
      left: 8px;
      right: auto;
      top: 8px;
      bottom: auto;
      z-index: 80;
      width: min(360px, calc(100vw - 16px));
      max-height: min(50vh, 360px);
    }

    .reasoning-block {
      margin: 0 0 8px;
      padding: 6px 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
    }

    .reasoning-block summary {
      cursor: pointer;
      font-weight: 600;
    }

    .reasoning-block pre {
      margin: 6px 0 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      line-height: 1.45;
    }

    .hidden {
      display: none !important;
    }
`;
}
