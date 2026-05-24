export function getInputStyles(): string {
  return `
    .rich-input {
      position: relative;
      min-height: 56px;
      max-height: 220px;
      padding: 10px 12px 6px;
      line-height: 1.45;
      font-size: 13px;
      border: none;
      background: transparent;
      outline: none;
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

    .rich-input:focus {
      outline: none;
    }

    .rich-input.is-empty::before {
      content: attr(data-placeholder);
      position: absolute;
      top: 10px;
      left: 12px;
      right: 12px;
      color: var(--vscode-input-placeholderForeground);
      pointer-events: none;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .rich-input.drag-over,
    .composer-input-inner.drag-over {
      outline: 2px dashed var(--vscode-focusBorder);
      outline-offset: -2px;
      background: var(--vscode-list-dropBackground, var(--vscode-editor-selectionBackground));
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

    .composer {
      border-top: 1px solid var(--vscode-panel-border);
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
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 8px;
      min-height: 30px;
      padding: var(--keepseek-toolbar-padding, 0 4px 4px);
    }

    .composer-toolbar-left {
      display: flex;
      align-items: flex-end;
      gap: 4px;
      min-width: 0;
      flex: 1;
    }

    .composer-toolbar-right {
      display: flex;
      align-items: flex-end;
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

    .composer-icon-btn:hover {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder, var(--vscode-panel-border, var(--vscode-input-border, transparent)));
      background: var(--vscode-toolbar-hoverBackground);
    }

    .composer-send-btn:hover:not(:disabled) {
      border-color: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      color: var(--vscode-button-foreground, var(--vscode-editor-background));
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

    .context-progress {
      --context-progress-angle: 0deg;
      --context-progress-color: var(--vscode-focusBorder, var(--vscode-progressBar-background));
      --context-progress-track: var(--vscode-panel-border, rgba(127, 127, 127, 0.28));
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 26px;
      min-width: 26px;
      height: 26px;
      min-height: 26px;
      border-radius: 50%;
      color: var(--vscode-foreground);
      outline: none;
      cursor: default;
    }

    .context-progress.is-warning {
      --context-progress-color: var(--vscode-editorWarning-foreground, #cca700);
    }

    .context-progress.is-danger {
      --context-progress-color: var(--vscode-editorError-foreground, #f14c4c);
    }

    .context-progress-ring {
      position: relative;
      display: block;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: conic-gradient(
        var(--context-progress-color) var(--context-progress-angle),
        var(--context-progress-track) 0
      );
    }

    .context-progress-ring::after {
      content: "";
      position: absolute;
      inset: 4px;
      border-radius: 50%;
      background: var(--vscode-chat-requestBackground, var(--vscode-input-background));
    }

    .context-progress:hover .context-progress-ring,
    .context-progress:focus-visible .context-progress-ring {
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }

    .context-progress:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .context-progress-tooltip {
      position: absolute;
      right: -32px;
      bottom: calc(100% + 8px);
      z-index: 45;
      display: block;
      width: max-content;
      max-width: min(260px, calc(100vw - 18px));
      padding: 7px 9px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
      font-size: 11px;
      line-height: 1.45;
      white-space: normal;
      opacity: 0;
      transform: translateY(2px);
      pointer-events: none;
      transition: opacity 80ms ease, transform 80ms ease;
    }

    .context-progress-tooltip::after {
      content: "";
      position: absolute;
      right: 38px;
      bottom: -5px;
      width: 8px;
      height: 8px;
      border-right: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      transform: rotate(45deg);
    }

    .context-progress-tooltip span {
      display: block;
    }

    .context-progress:hover .context-progress-tooltip,
    .context-progress:focus-visible .context-progress-tooltip {
      opacity: 1;
      transform: translateY(0);
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

    .command-menu {
      position: absolute;
      left: 6px;
      right: 6px;
      bottom: 34px;
      z-index: 30;
      max-height: min(420px, calc(100vh - 96px));
      overflow-y: auto;
      padding: 6px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
    }

    .reference-menu {
      position: absolute;
      left: 6px;
      right: 6px;
      bottom: calc(100% + 6px);
      z-index: 35;
      display: flex;
      flex-direction: column;
      max-height: min(50vh, 420px);
      min-height: 72px;
      overflow: hidden;
      padding: 6px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
    }

    .reference-menu-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      flex: 0 0 auto;
      padding: 4px 6px 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.2;
    }

    .reference-menu-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .reference-menu-count {
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
    }

    .reference-menu-list {
      display: grid;
      gap: 2px;
      min-height: 0;
      overflow-y: auto;
    }

    .reference-menu-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 1px;
      width: 100%;
      min-height: 36px;
      padding: 5px 8px;
      border: none;
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
      cursor: pointer;
    }

    .reference-menu-item:hover,
    .reference-menu-item:focus-visible,
    .reference-menu-item.is-active {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .reference-menu-item-name,
    .reference-menu-item-path {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .reference-menu-item-name {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.3;
    }

    .reference-menu-item-path {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.25;
    }

    .reference-menu-action .reference-menu-item-name {
      color: var(--vscode-textLink-foreground);
    }

    .reference-menu-empty {
      padding: 12px 8px 14px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-align: center;
    }

    .command-menu-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 6px 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.2;
    }

    .command-menu-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .command-menu-shortcut {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border: 1px solid var(--vscode-keybindingLabel-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-keybindingLabel-background, var(--vscode-editor-background));
      color: var(--vscode-keybindingLabel-foreground, var(--vscode-foreground));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      font-weight: 700;
    }

    .command-section {
      padding: 6px 0;
      border-top: 1px solid var(--vscode-panel-border);
    }

    .command-section:first-of-type {
      border-top: none;
      padding-top: 0;
    }

    .command-section-label {
      padding: 2px 6px 5px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0;
      text-transform: uppercase;
    }

    .command-row,
    .command-control-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 38px;
      padding: 6px 8px;
      border: none;
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
    }

    .command-row {
      cursor: pointer;
    }

    .command-row:hover,
    .command-row:focus-visible,
    .command-model-option:hover,
    .command-model-option:focus-visible {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .command-row-main {
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 1px;
    }

    .command-row-title,
    .command-row-description,
    .command-row-value {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .command-row-title {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.3;
    }

    .command-row-description {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.25;
    }

    .command-row-value {
      max-width: 42vw;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.25;
      text-align: right;
    }

    .command-model-list {
      display: grid;
      gap: 2px;
      padding: 2px 0 4px 12px;
    }

    .command-model-option {
      display: grid;
      grid-template-columns: 14px minmax(0, 1fr);
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 4px 8px;
      border: none;
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
      cursor: pointer;
    }

    .command-model-check {
      color: var(--vscode-textLink-foreground);
      font-size: 12px;
      line-height: 1;
      text-align: center;
    }

    .command-model-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 12px;
    }

    .command-effort-slider {
      width: 88px;
      min-width: 72px;
      accent-color: var(--vscode-progressBar-background, var(--vscode-textLink-foreground));
      cursor: pointer;
    }

    .command-effort-slider:disabled {
      cursor: default;
      opacity: 0.45;
    }

    .command-toggle-row {
      position: relative;
      grid-template-columns: minmax(0, 1fr) 34px;
      cursor: pointer;
    }

    .command-toggle-input {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      opacity: 0;
      pointer-events: none;
    }

    .command-toggle-track {
      position: relative;
      width: 34px;
      height: 18px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 999px;
      background: var(--vscode-input-background);
      transition: background 120ms ease, border-color 120ms ease;
    }

    .command-toggle-track::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 12px;
      height: 12px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
      transition: transform 120ms ease, background 120ms ease;
    }

    .command-toggle-input:checked + .command-toggle-track {
      border-color: var(--vscode-textLink-foreground);
      background: var(--vscode-textLink-foreground);
    }

    .command-toggle-input:checked + .command-toggle-track::after {
      transform: translateX(16px);
      background: var(--vscode-button-foreground);
    }

    .command-toggle-input:focus-visible + .command-toggle-track {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }

    .settings-overlay {
      position: fixed;
      inset: 0;
      z-index: 100;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(0, 0, 0, 0.45);
    }

    .settings-dialog {
      width: min(360px, calc(100vw - 32px));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 10px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      box-shadow: 0 12px 32px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
    }

    .settings-dialog-header {
      display: flex;
      align-items: center;
      padding: 14px 16px 0;
    }

    .settings-dialog-title {
      font-size: 14px;
      font-weight: 600;
    }

    .settings-dialog-body {
      padding: 10px 16px 16px;
    }

    .settings-dialog-desc {
      margin: 0 0 14px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }

    .settings-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin-bottom: 12px;
    }

    .settings-field:last-of-type {
      margin-bottom: 0;
    }

    .settings-field-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--vscode-descriptionForeground);
    }

    .settings-input {
      width: 100%;
      min-height: 28px;
      padding: 4px 8px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-size: 12px;
      outline-color: var(--vscode-focusBorder);
    }

    .settings-secret-input {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 28px;
      align-items: center;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-input-background);
    }

    .settings-secret-input:focus-within {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .settings-secret-input .settings-input {
      min-width: 0;
      border: none;
      background: transparent;
      outline: none;
    }

    .settings-secret-toggle {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      min-width: 28px;
      height: 28px;
      padding: 0;
      border: none;
      border-left: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 0 3px 3px 0;
      background: transparent;
      color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground));
      cursor: pointer;
    }

    .settings-secret-toggle:hover {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
    }

    .settings-secret-toggle:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .settings-secret-icon-hide,
    .settings-secret-toggle.is-visible .settings-secret-icon-show {
      display: none;
    }

    .settings-secret-toggle.is-visible .settings-secret-icon-hide {
      display: block;
    }

    .settings-dialog-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      padding: 0 16px 14px;
    }

    .settings-clear-api-key {
      margin-right: auto;
    }
`;
}
