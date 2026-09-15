import type { WebviewFragment } from '../composition';

export const referenceChipStylesFragment: WebviewFragment = {
  id: 'styles.references.chips',
  source: `
    .rich-file-link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      max-width: 100%;
      min-height: 20px;
      margin: 0 2px 2px 0;
      padding: 1px 6px;
      border: 1px solid var(--vscode-inputOption-activeBorder, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-chat-slashCommandBackground, var(--vscode-badge-background, var(--vscode-editor-background)));
      color: var(--vscode-textLink-foreground);
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 12px;
      line-height: 18px;
      vertical-align: baseline;
      white-space: nowrap;
      cursor: pointer;
    }

    .rich-input .rich-file-link,
    .message-edit-input .rich-file-link {
      max-width: 100%;
      min-height: 22px;
      padding: 1px 6px;
      line-height: 18px;
      white-space: nowrap;
    }

    .rich-file-link-primary {
      display: block;
      min-width: 0;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .rich-reference-link-icon {
      display: inline-flex;
      flex: 0 0 14px;
      width: 14px;
      height: 14px;
    }

    .rich-reference-link-icon svg {
      display: block;
      width: 100%;
      height: 100%;
    }

    .rich-file-link:hover {
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-textLink-activeForeground);
    }

    .rich-file-link:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .rich-directory-link {
      color: var(--vscode-charts-green, var(--vscode-textLink-foreground));
    }

`.slice(1)
};

export const referenceMenuStylesFragment: WebviewFragment = {
  id: 'styles.references.menu',
  source: `
    .reference-menu {
      position: absolute;
      left: var(--keepseek-edge-padding, 4px);
      right: var(--keepseek-edge-padding, 4px);
      bottom: calc(100% + 6px);
      z-index: 35;
      display: flex;
      flex-direction: column;
      max-height: min(50vh, 420px);
      min-height: 72px;
      overflow: hidden;
      padding: 4px;
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

    .reference-menu-group {
      padding: 7px 8px 3px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-weight: 600;
      line-height: 1.2;
      text-transform: uppercase;
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

    .reference-menu-item.is-skill {
      grid-template-columns: 18px minmax(0, 1fr);
      align-items: center;
      column-gap: 7px;
    }

    .reference-menu-item-icon {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
    }

    .reference-menu-skill-icon img {
      display: block;
      width: 13px;
      height: 18px;
    }

    .reference-menu-item-body {
      display: grid;
      gap: 1px;
      min-width: 0;
    }

    .reference-menu-item:hover,
    .reference-menu-item:focus-visible,
    .reference-menu-item.is-active {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .reference-menu-item:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .reference-menu-item:disabled:hover,
    .reference-menu-item:disabled:focus-visible,
    .reference-menu-item:disabled.is-active {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: transparent;
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

    .reference-menu-item.is-directory .reference-menu-item-name {
      color: var(--vscode-charts-green, var(--vscode-textLink-foreground));
    }

    .reference-menu-item.is-skill .reference-menu-item-name {
      color: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
      font-family: var(--vscode-editor-font-family, monospace);
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

`.slice(1)
};

