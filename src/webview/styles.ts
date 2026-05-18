export function getStyles(): string {
  return `
    :root {
      color-scheme: light dark;
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
    textarea,
    .rich-input {
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

    textarea,
    .rich-input {
      min-height: 56px;
      max-height: 220px;
      padding: 10px 12px 6px;
      line-height: 1.45;
      font-size: 13px;
      border: none;
      background: transparent;
      outline: none;
    }

    textarea {
      resize: none;
    }

    textarea:focus,
    .rich-input:focus {
      outline: none;
    }

    textarea.drag-over,
    .rich-input.drag-over,
    .composer-input-inner.drag-over {
      outline: 2px dashed var(--vscode-focusBorder);
      outline-offset: -2px;
      background: var(--vscode-list-dropBackground, var(--vscode-editor-selectionBackground));
    }

    .rich-input {
      display: block;
      width: 100%;
      flex: 0 0 auto;
      overflow-y: auto;
      color: var(--vscode-input-foreground);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      user-select: text;
      caret-color: var(--vscode-input-foreground);
    }

    .rich-input.is-empty::before {
      content: attr(data-placeholder);
      color: var(--vscode-input-placeholderForeground);
      pointer-events: none;
    }

    .rich-file-link {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      min-height: 20px;
      margin: 0 2px 2px 0;
      padding: 1px 6px;
      border: 1px solid var(--vscode-inputOption-activeBorder, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-chat-slashCommandBackground, var(--vscode-badge-background, var(--vscode-editor-background)));
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      font-size: 12px;
      line-height: 18px;
      vertical-align: baseline;
      white-space: nowrap;
      cursor: pointer;
    }

    .rich-file-link:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-textLink-activeForeground);
    }

    .shell {
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

    .header-tab.active {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-activeBackground);
    }

    /* ---- context bar ---- */

    .context-bar {
      padding: 6px 12px;
      border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border));
      min-height: 28px;
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
      padding: 12px;
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
      font-size: 32px;
      opacity: 0.3;
      margin-bottom: 4px;
    }

    .message {
      margin-bottom: 16px;
    }

    .message:last-child {
      margin-bottom: 0;
    }

    .message-role {
      font-size: 11px;
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--vscode-descriptionForeground);
      text-transform: uppercase;
      letter-spacing: 0.3px;
      padding: 0 2px;
    }

    .message.user .message-role {
      color: var(--vscode-chat-requestColor, var(--vscode-textLink-foreground));
    }

    .message-content {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: 1.55;
      padding: 0 2px;
    }

    .message.user .message-content {
      border-left: 2px solid var(--vscode-chat-requestBorder, var(--vscode-textLink-foreground));
      padding-left: 10px;
    }

    /* ---- composer ---- */

    .composer {
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-sideBar-background);
      padding: 4px 4px;
    }

    .composer-input-wrap {
      padding: 0;
    }

    .composer-input-inner {
      display: flex;
      flex-direction: column;
      min-height: 116px;
      border: 1px solid var(--vscode-chat-requestBorder, var(--vscode-input-border, transparent));
      border-radius: 6px;
      overflow: hidden;
      background: var(--vscode-chat-requestBackground, var(--vscode-input-background));
    }

    .composer-input-inner:focus-within {
      border-color: var(--vscode-focusBorder);
    }

    .composer-input-inner textarea,
    .composer-input-inner .rich-input {
      flex: 0 0 auto;
      min-height: 74px;
      padding: 10px 12px 6px;
      background: transparent;
    }

    .composer-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 32px;
      padding: 0 8px 8px;
    }

    .composer-toolbar-left {
      display: flex;
      align-items: center;
      gap: 2px;
      min-width: 0;
      flex: 1;
    }

    .composer-icon-btn,
    .composer-mode-btn,
    .composer-send-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground));
      cursor: pointer;
    }

    .composer-icon-btn,
    .composer-send-btn {
      width: 24px;
      min-width: 24px;
      height: 24px;
      min-height: 24px;
      padding: 0;
    }

    .composer-mode-btn {
      gap: 4px;
      min-height: 24px;
      padding: 0 6px;
      font-size: 12px;
      color: var(--vscode-foreground);
    }

    .composer-mode-btn::after {
      content: "";
      width: 0;
      height: 0;
      border-left: 3.5px solid transparent;
      border-right: 3.5px solid transparent;
      border-top: 4px solid currentColor;
      opacity: 0.7;
    }

    .composer-icon-btn:hover,
    .composer-mode-btn:hover,
    .composer-send-btn:hover:not(:disabled) {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }

    .composer-icon-btn:focus-visible,
    .composer-mode-btn:focus-visible,
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

    .composer-status,
    #status {
      min-width: 0;
      margin-left: 6px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .hidden {
      display: none !important;
    }
`;
}
