import type { WebviewFragment } from '../input/composition';

export const conversationsStylesFragment: WebviewFragment = {
  id: 'conversations.styles',
  source: `
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
      grid-template-columns: 24px minmax(0, 1fr) 26px 28px;
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
      grid-template-columns: 18px 24px minmax(0, 1fr) 26px 28px;
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

    .session-menu-rename,
    .session-menu-refresh {
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
    .session-menu-item:focus-within .session-menu-rename,
    .session-menu-item:hover .session-menu-refresh,
    .session-menu-item:focus-within .session-menu-refresh,
    .session-menu-refresh.is-regenerating {
      opacity: 1;
      transform: translateX(0);
    }

    .session-menu-rename:hover,
    .session-menu-rename:focus-visible,
    .session-menu-refresh:hover,
    .session-menu-refresh:focus-visible {
      color: var(--vscode-textLink-foreground);
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .session-menu-refresh:disabled { cursor: default; }
    .session-menu-refresh.is-regenerating svg {
      animation: session-title-refresh-spin 900ms linear infinite;
      transform-origin: center;
    }
    @keyframes session-title-refresh-spin { to { transform: rotate(360deg); } }

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
    }`.slice(1)
};
