import { getInputStyles } from './input/styles';

export function getStyles(): string {
  return `
    :root {
      color-scheme: light dark;

      --keepseek-edge-padding: 0px;
      --keepseek-edge-padding-double: 0px;

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
      padding: 8px var(--keepseek-edge-padding);
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

    .settings-menu {
      position: absolute;
      top: 36px;
      right: var(--keepseek-edge-padding);
      z-index: 45;
      width: min(300px, calc(100% - var(--keepseek-edge-padding-double)));
      padding: 4px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
    }

    .settings-menu-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 4px 6px 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.2;
    }

    .settings-menu-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .settings-menu-row {
      min-height: 42px;
    }

    .settings-about-menu-row {
      margin-top: 4px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
      border-radius: 0 0 6px 6px;
    }

    .settings-language-item,
    .settings-debug-item {
      position: relative;
    }

    .settings-submenu {
      position: absolute;
      top: 4px;
      right: var(--keepseek-edge-padding);
      z-index: 50;
      display: none;
      width: 132px;
      padding: 4px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      box-shadow: 0 8px 20px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
    }

    .settings-language-item:hover .settings-submenu,
    .settings-language-item:focus-within .settings-submenu,
    .settings-language-item.is-open .settings-submenu,
    .settings-debug-item:hover .settings-submenu,
    .settings-debug-item:focus-within .settings-submenu,
    .settings-debug-item.is-open .settings-submenu {
      display: grid;
      gap: 2px;
    }

    .settings-submenu-item {
      display: grid;
      grid-template-columns: 14px minmax(0, 1fr);
      align-items: center;
      gap: 6px;
      width: 100%;
      min-height: 28px;
      padding: 4px 8px;
      border: none;
      border-radius: 5px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
    }

    .settings-submenu-item:hover,
    .settings-submenu-item:focus-visible {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .settings-submenu-check {
      color: var(--vscode-textLink-foreground);
      font-size: 12px;
      line-height: 1;
      text-align: center;
    }

    .settings-submenu-item[aria-checked="true"] .settings-submenu-check::before {
      content: "\\2713";
    }

    .settings-submenu-icon::before {
      content: "\\21B1";
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1;
    }

    .session-menu {
      position: absolute;
      top: 36px;
      left: var(--keepseek-edge-padding);
      z-index: 40;
      width: min(380px, calc(100% - var(--keepseek-edge-padding-double)));
      max-height: min(520px, calc(100vh - 72px));
      overflow-y: auto;
      padding: 4px;
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

    .session-menu-controls,
    .session-menu-bulk {
      display: flex;
      gap: 6px;
      padding: 4px;
    }

    .session-menu-controls {
      align-items: center;
      flex-wrap: nowrap;
    }

    .session-menu-bulk {
      align-items: stretch;
    }

    .session-menu-workspace-select,
    .session-menu-range-select {
      height: 26px;
      min-width: 0;
      border: 1px solid var(--vscode-input-border, var(--vscode-widget-border));
      border-radius: 4px;
      color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
      background: var(--vscode-dropdown-background, var(--vscode-input-background));
      font: inherit;
    }

    .session-menu-workspace-select {
      flex: 1 1 33%;
      max-width: 33%;
      min-width: 72px;
      text-overflow: ellipsis;
    }

    .session-menu-range-select {
      flex: 0 0 auto;
      max-width: 86px;
    }

    .session-menu-filter,
    .session-menu-bulk button,
    .session-menu-delete-workspace {
      min-height: 26px;
      padding: 3px 7px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 4px;
      color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
      background: var(--vscode-button-secondaryBackground, transparent);
      font-size: 11px;
      line-height: 1.2;
      white-space: nowrap;
    }

    .session-menu-delete-workspace {
      display: block;
      width: calc(100% - 8px);
      margin: 2px 4px 4px;
      min-width: 0;
      color: var(--vscode-errorForeground, var(--vscode-button-secondaryForeground, var(--vscode-foreground)));
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .session-menu-delete-workspace:hover,
    .session-menu-delete-workspace:focus-visible {
      color: var(--vscode-errorForeground, var(--vscode-button-foreground));
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .session-menu-filter.is-active {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
    }

    .session-menu-edit-toggle {
      margin-left: auto;
    }

    .session-menu-bulk button {
      flex: 1 1 0;
      min-width: 0;
    }

    .session-menu-bulk button:disabled {
      opacity: 0.55;
    }

    .session-menu-delete:not(:disabled) {
      color: var(--vscode-errorForeground, var(--vscode-button-foreground));
    }

    .session-menu-item {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr) 28px;
      align-items: center;
      gap: 6px;
      width: 100%;
      min-height: 48px;
      padding: 6px 7px;
      border: none;
      border-radius: 6px;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
      cursor: pointer;
    }

    .session-menu.is-multi-select .session-menu-item {
      grid-template-columns: 18px 24px minmax(0, 1fr) 28px;
    }

    .session-menu-item.is-other-workspace {
      grid-template-columns: minmax(0, 1fr);
    }

    .session-menu.is-multi-select .session-menu-item.is-other-workspace {
      grid-template-columns: 18px minmax(0, 1fr);
    }

    .session-menu-item:hover,
    .session-menu-item:focus-visible {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .session-menu-item-title,
    .session-menu-item-meta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .session-menu-item-title {
      display: block;
      width: 100%;
      padding: 1px 3px;
      border: 1px solid transparent;
      border-radius: 3px;
      color: inherit;
      background: transparent;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.25;
    }

    .session-menu-item-title:focus {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      outline: none;
    }

    .session-menu-item-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.25;
    }

    .session-menu-item.is-favorite {
      box-shadow: inset 2px 0 0 var(--vscode-textLink-foreground);
    }

    .session-menu-checkbox {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: var(--vscode-textLink-foreground);
    }

    .session-menu-star {
      display: grid;
      place-items: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font-size: 15px;
      line-height: 1;
    }

    .session-menu-star:hover,
    .session-menu-star:focus-visible {
      color: var(--vscode-textLink-foreground);
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .session-menu-star.is-active {
      color: var(--vscode-textLink-foreground);
    }

    .session-menu-rename {
      display: grid;
      place-items: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: none;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      opacity: 0;
      transform: translateX(6px);
      transition: opacity 120ms ease, transform 120ms ease, background-color 120ms ease, color 120ms ease;
    }

    .session-menu-item:hover .session-menu-rename,
    .session-menu-item:focus-within .session-menu-rename {
      opacity: 1;
      transform: translateX(0);
    }

    .session-menu-rename:hover,
    .session-menu-rename:focus-visible {
      color: var(--vscode-textLink-foreground);
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .session-menu-item-main {
      display: grid;
      min-width: 0;
      gap: 3px;
    }

    .session-menu-empty {
      padding: 12px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      text-align: center;
    }

    .session-menu-error {
      color: var(--vscode-errorForeground, var(--vscode-descriptionForeground));
    }

    /* ---- context bar ---- */

    .context-bar {
      padding: 4px var(--keepseek-edge-padding) 2px;
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

    .usage-stats-bar {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
      padding: 4px var(--keepseek-edge-padding) 3px;
      border-top: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
      color: var(--vscode-descriptionForeground);
      background: color-mix(in srgb, var(--vscode-sideBar-background) 92%, var(--vscode-editor-background));
      font-size: 10.5px;
      line-height: 1.35;
    }

    .usage-stat {
      display: inline-flex;
      align-items: baseline;
      gap: 3px;
      min-width: 0;
      max-width: 100%;
      white-space: nowrap;
    }

    .usage-stat-label {
      color: var(--vscode-descriptionForeground);
      opacity: 0.78;
    }

    .usage-stat-value {
      color: var(--vscode-foreground);
      font-variant-numeric: tabular-nums;
    }

    .usage-stat::after {
      content: "·";
      color: var(--vscode-descriptionForeground);
      opacity: 0.45;
      padding-left: 1px;
    }

    .usage-stat:last-child::after {
      content: "";
      padding-left: 0;
    }

    .draft-bar {
      margin: 8px var(--keepseek-edge-padding) 0;
      padding: 10px;
      border: 1px solid #d8dee4;
      border-radius: 8px;
      background: #ffffff;
      color: #1f2328;
    }

    .draft-bar-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 8px;
    }

    .draft-bar-label {
      font-size: 11px;
      font-weight: 600;
      color: #57606a;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .draft-bulk-actions {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 6px;
      flex-shrink: 0;
      margin-left: auto;
    }

    .draft-bulk-actions button {
      font-size: 11px;
      padding: 2px 8px;
      min-height: 22px;
      border-radius: 4px;
    }

    .draft-bar-list {
      display: grid;
      gap: 6px;
    }

    .draft-chip {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
      gap: 8px;
      width: 100%;
      padding: 7px 8px;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      font-size: 12px;
      background: #f8fafc;
    }

    .draft-chip-main {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      min-width: 0;
    }

    .draft-chip-action-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 18px;
      width: 18px;
      height: 18px;
      margin-top: -1px;
      border: 1px solid #d0d7de;
      border-radius: 4px;
      color: #57606a;
      background: #ffffff;
    }

    .draft-chip-action-icon svg {
      display: block;
      width: 13px;
      height: 13px;
    }

    .draft-chip-action-icon-create {
      color: var(--vscode-gitDecoration-addedResourceForeground, #1a7f37);
    }

    .draft-chip-action-icon-modify {
      color: var(--vscode-charts-blue, #0969da);
    }

    .draft-chip-action-icon-delete {
      color: var(--vscode-errorForeground, #cf222e);
    }

    .draft-chip-action-icon-move {
      color: var(--vscode-charts-purple, #8250df);
    }

    .draft-chip-label {
      min-width: 0;
      overflow-wrap: anywhere;
      white-space: normal;
    }

    .draft-chip-actions {
      display: flex;
      justify-content: flex-end;
      flex-wrap: wrap;
      gap: 4px;
    }

    .draft-chip-actions button {
      font-size: 11px;
      padding: 2px 8px;
      min-height: 20px;
      border-radius: 3px;
    }

    @media (min-width: 300px) {
      .draft-chip {
        grid-template-columns: minmax(0, 1fr) auto;
      }
    }

    /* ---- transcript ---- */

    .transcript {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 8px var(--keepseek-edge-padding) 12px;
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

    .message.assistant .message-body {
      width: 100%;
      max-width: 100%;
    }

    .message.user .message-body {
      align-items: flex-end;
    }

    .message.assistant .message-role,
    .message.assistant .message-content {
      padding-left: 0;
      padding-right: 0;
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

    .message-content.is-placeholder {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }

    .message-content.assistant-markdown {
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .assistant-markdown > :first-child {
      margin-top: 0;
    }

    .assistant-markdown > :last-child {
      margin-bottom: 0;
    }

    .assistant-markdown p {
      margin: 0 0 8px;
    }

    .assistant-markdown h1,
    .assistant-markdown h2,
    .assistant-markdown h3,
    .assistant-markdown h4,
    .assistant-markdown h5,
    .assistant-markdown h6 {
      margin: 10px 0 6px;
      line-height: 1.3;
      font-weight: 650;
    }

    .assistant-markdown h1 {
      font-size: 17px;
    }

    .assistant-markdown h2 {
      font-size: 15px;
    }

    .assistant-markdown h3,
    .assistant-markdown h4,
    .assistant-markdown h5,
    .assistant-markdown h6 {
      font-size: 13px;
    }

    .assistant-markdown .message-markdown-list {
      margin: 0 0 8px;
      padding-left: 20px;
    }

    .assistant-markdown li {
      margin: 2px 0;
      padding-left: 1px;
    }

    .assistant-markdown .message-table-wrap {
      width: 100%;
      max-width: 100%;
      margin: 8px 0;
      overflow-x: auto;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
    }

    .assistant-markdown .message-markdown-table {
      width: 100%;
      border-collapse: collapse;
      border-spacing: 0;
      font-size: 12px;
      line-height: 1.45;
    }

    .assistant-markdown .message-markdown-table th,
    .assistant-markdown .message-markdown-table td {
      min-width: 72px;
      padding: 6px 8px;
      border-right: 1px solid var(--vscode-panel-border);
      border-bottom: 1px solid var(--vscode-panel-border);
      color: var(--vscode-foreground);
      text-align: left;
      vertical-align: top;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .assistant-markdown .message-markdown-table th {
      font-weight: 600;
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    }

    .assistant-markdown .message-markdown-table th:last-child,
    .assistant-markdown .message-markdown-table td:last-child {
      border-right: none;
    }

    .assistant-markdown .message-markdown-table tbody tr:last-child td {
      border-bottom: none;
    }

    .assistant-markdown blockquote {
      margin: 8px 0;
      padding: 2px 0 2px 10px;
      border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border));
      color: var(--vscode-textBlockQuote-foreground, var(--vscode-descriptionForeground));
    }

    .assistant-markdown hr {
      width: 100%;
      height: 1px;
      margin: 10px 0;
      border: none;
      background: var(--vscode-panel-border);
    }

    .assistant-markdown .message-file-link {
      margin: 0 3px 2px;
      transform: translateY(-1px);
      vertical-align: middle;
    }

    .message-skill-usage {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      margin: 0 0 6px;
      padding: 2px 6px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: var(--vscode-editor-background);
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .assistant-markdown .message-codex-file-link {
      border-color: var(--vscode-inputOption-activeBorder, var(--vscode-focusBorder, var(--vscode-panel-border)));
      background: var(--vscode-inputOption-activeBackground, var(--vscode-chat-slashCommandBackground, var(--vscode-badge-background, var(--vscode-editor-background))));
      color: var(--vscode-textLink-foreground);
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.92em;
      font-weight: 600;
    }

    .assistant-markdown .message-codex-file-link:hover,
    .assistant-markdown .message-codex-file-link:focus-visible {
      border-color: var(--vscode-focusBorder, var(--vscode-inputOption-activeBorder, var(--vscode-panel-border)));
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-textLink-activeForeground);
      outline: 1px solid var(--vscode-focusBorder, transparent);
      outline-offset: 1px;
    }

    .message-external-link {
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
    }

    .message-external-link:hover,
    .message-external-link:focus-visible {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
      outline: none;
    }

    .message-inline-code {
      padding: 1px 4px;
      border-radius: 4px;
      color: var(--vscode-textPreformat-foreground, var(--vscode-editor-foreground));
      background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background));
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.94em;
      white-space: break-spaces;
    }

    .message-code-block {
      width: 100%;
      max-width: 100%;
      margin: 8px 0;
      overflow: hidden;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: transparent;
    }

    .message-code-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 28px;
      padding: 3px 4px 3px 8px;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
    }

    .message-code-language {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.2;
    }

    .message-code-copy {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 auto;
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

    .message-code-copy:hover:not(:disabled),
    .message-code-copy:focus-visible {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
      outline: none;
    }

    .message-code-copy.is-copied {
      color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    }

    .message-code-block pre {
      margin: 0;
      max-height: 420px;
      overflow: auto;
      padding: 10px 12px;
      color: var(--vscode-editor-foreground);
      background: transparent;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: var(--vscode-editor-font-size, 12px);
      line-height: 1.5;
      white-space: pre;
    }

    .message-code-block code {
      color: inherit;
      background: transparent;
      font-family: inherit;
      font-size: inherit;
      line-height: inherit;
      white-space: pre;
    }

    .message.user .message-content .message-file-link {
      margin: 0 3px;
      padding: 2px 6px;
      transform: none;
      vertical-align: text-top;
      flex-direction: column;
      align-items: flex-start;
      justify-content: center;
      max-width: 100%;
      min-height: 22px;
      max-height: 38px;
      line-height: 15px;
      white-space: normal;
      overflow-wrap: anywhere;
    }

    .message.user .message-content .message-file-link-primary,
    .message.user .message-content .message-file-link-secondary {
      display: block;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .message.user .message-content .message-file-link-secondary {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 14px;
      opacity: 0.85;
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

    .message-action-btn.is-copied {
      color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
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

    .message-edit-input span,
    .message-edit-input font,
    .message-edit-input code,
    .message-edit-input pre {
      color: inherit !important;
      background: transparent !important;
      font: inherit !important;
    }

    .message-edit-input .rich-file-link-primary {
      font-size: 12px !important;
      line-height: 15px !important;
    }

    .message-edit-input .rich-file-link-secondary {
      color: var(--vscode-descriptionForeground) !important;
      font-size: 11px !important;
      line-height: 14px !important;
      opacity: 0.85;
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
      left: var(--keepseek-edge-padding);
      right: auto;
      top: var(--keepseek-edge-padding);
      bottom: auto;
      z-index: 80;
      width: min(360px, calc(100vw - var(--keepseek-edge-padding-double)));
      max-height: min(50vh, 360px);
    }

    .reasoning-block {
      width: 100%;
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

    .message.is-streaming .reasoning-block {
      border-color: var(--vscode-focusBorder, var(--vscode-panel-border));
    }

    .hidden {
      display: none !important;
    }
`;
}
