import type { WebviewFragment } from '../composition';

export const commandMenuReadonlyStylesFragment: WebviewFragment = {
  id: 'styles.command-menu.readonly',
  source: `
    .command-menu {
      position: absolute;
      left: var(--keepseek-edge-padding, 4px);
      right: var(--keepseek-edge-padding, 4px);
      bottom: 34px;
      z-index: 30;
      max-height: min(420px, calc(100vh - 96px));
      overflow-y: auto;
      padding: 4px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      box-shadow: 0 8px 24px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.28));
    }

    .command-menu.is-readonly {
      opacity: 0.95;
    }

    .command-menu.is-readonly .command-row,
    .command-menu.is-readonly .command-skill-create-button,
    .command-menu.is-readonly .command-control-row,
    .command-menu.is-readonly .command-model-option,
    .command-menu.is-readonly .command-compression-tab {
      cursor: default;
    }

    .command-menu.is-readonly .command-row:hover,
    .command-menu.is-readonly .command-row:focus-visible,
    .command-menu.is-readonly .command-row[aria-expanded="true"],
    .command-menu.is-readonly .command-skill-create-button:hover,
    .command-menu.is-readonly .command-skill-create-button:focus-visible,
    .command-menu.is-readonly .command-control-row:hover,
    .command-menu.is-readonly .command-control-row:focus-within,
    .command-menu.is-readonly .command-model-option:hover,
    .command-menu.is-readonly .command-model-option:focus-visible,
    .command-menu.is-readonly .command-model-option[aria-checked="true"],
    .command-menu.is-readonly .command-compression-tab:hover,
    .command-menu.is-readonly .command-compression-tab:focus-visible {
      color: inherit;
      background: transparent;
      outline: none;
    }

    .command-menu.is-readonly .command-row:disabled,
    .command-menu.is-readonly .command-control-row:disabled {
      color: var(--vscode-descriptionForeground);
    }

    .command-menu.is-readonly.allows-model-selection #commandModelSwitch:not(:disabled),
    .command-menu.is-readonly.allows-model-selection .command-model-option:not(:disabled),
    .command-menu.is-readonly.allows-approval-selection #commandApprovalModeSwitch:not(:disabled),
    .command-menu.is-readonly.allows-approval-selection #commandApprovalModeList .command-model-option:not(:disabled) {
      cursor: pointer;
    }

    .command-menu.is-readonly.allows-model-selection #commandModelSwitch:not(:disabled):hover,
    .command-menu.is-readonly.allows-model-selection #commandModelSwitch:not(:disabled):focus-visible,
    .command-menu.is-readonly.allows-model-selection .command-model-option:not(:disabled):hover,
    .command-menu.is-readonly.allows-model-selection .command-model-option:not(:disabled):focus-visible,
    .command-menu.is-readonly.allows-model-selection .command-model-option.is-pending:not(:disabled),
    .command-menu.is-readonly.allows-approval-selection #commandApprovalModeSwitch:not(:disabled):hover,
    .command-menu.is-readonly.allows-approval-selection #commandApprovalModeSwitch:not(:disabled):focus-visible,
    .command-menu.is-readonly.allows-approval-selection #commandApprovalModeSwitch[aria-expanded="true"]:not(:disabled),
    .command-menu.is-readonly.allows-approval-selection #commandApprovalModeList .command-model-option:not(:disabled):hover,
    .command-menu.is-readonly.allows-approval-selection #commandApprovalModeList .command-model-option:not(:disabled):focus-visible {
      color: var(--vscode-list-hoverForeground, var(--vscode-foreground));
      background: var(--vscode-list-hoverBackground);
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

`.slice(1)
};

export const commandMenuStylesFragment: WebviewFragment = {
  id: 'styles.command-menu.main',
  source: `
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
    .command-row[aria-expanded="true"],
    .command-control-row:hover,
    .command-control-row:focus-within,
    .command-model-option:hover,
    .command-model-option:focus-visible,
    .command-model-option[aria-checked="true"] {
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

    .command-skills-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 10px;
      width: 100%;
      min-height: 38px;
      padding: 6px 8px;
      border-radius: 6px;
      min-width: 0;
    }

    .command-skills-row:focus-within {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-hoverBackground));
    }

    .command-skills-main-button {
      display: flex;
      align-self: stretch;
      align-items: center;
      min-width: 0;
      padding: 0;
      border: none;
      color: inherit;
      background: transparent;
      text-align: left;
    }

    .command-skills-main-button:hover:not(:disabled),
    .command-skills-main-button:focus-visible:not(:disabled) {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: transparent;
      outline: none;
    }

    .command-skills-actions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 2px;
    }

    .command-skill-filter-control {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      max-width: 26px;
      overflow: hidden;
      transition: max-width 140ms ease;
    }

    .command-skill-filter-control.is-open {
      max-width: calc(clamp(88px, 34vw, 140px) + 28px);
    }

    .command-skill-filter-input {
      flex: 0 0 auto;
      width: 0;
      min-width: 0;
      height: 24px;
      min-height: 24px;
      margin: 0;
      padding: 0;
      border: 0 solid transparent;
      border-radius: 4px;
      opacity: 0;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font-size: 11px;
      line-height: 22px;
      pointer-events: none;
      transform: translateX(4px);
      transition: width 140ms ease, padding 140ms ease, opacity 100ms ease, transform 140ms ease;
    }

    .command-skill-filter-control.is-open .command-skill-filter-input {
      width: clamp(88px, 34vw, 140px);
      margin-right: 2px;
      padding: 1px 6px;
      border-width: 1px;
      border-color: var(--vscode-input-border, transparent);
      opacity: 1;
      pointer-events: auto;
      transform: translateX(0);
    }

    .command-skill-filter-input:focus {
      border-color: var(--vscode-focusBorder);
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .command-skill-filter-button[aria-expanded="true"] {
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
    }

    .command-skill-icon-button {
      display: inline-flex;
      flex: 0 0 26px;
      align-items: center;
      justify-content: center;
      width: 26px;
      height: 26px;
      padding: 0;
      border: none;
      border-radius: 5px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      cursor: pointer;
    }

    .command-skill-icon-button:hover:not(:disabled),
    .command-skill-icon-button:focus-visible:not(:disabled) {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      outline: none;
    }

    .command-skills-chevron {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      color: var(--vscode-descriptionForeground);
      transition: transform 120ms ease;
    }

    .command-skills-toggle-button[aria-expanded="true"] .command-skills-chevron {
      transform: rotate(90deg);
    }

    .command-model-current {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 5px;
      min-width: 0;
    }

    .command-model-current-text,
    .command-model-source-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .command-model-list {
      display: grid;
      gap: 2px;
      padding: 2px 0 4px 12px;
    }

    .command-subagent-menu {
      display: grid;
      gap: 2px;
      padding: 2px 0 4px 12px;
    }

    .command-subagent-menu-chevron,
    .command-subagent-profile-chevron {
      display: inline-flex;
      flex: 0 0 14px;
      align-items: center;
      justify-content: center;
      width: 14px;
      height: 14px;
      color: var(--vscode-descriptionForeground);
      transition: transform 120ms ease;
    }

    #commandSubagentModelSwitch[aria-expanded="true"] .command-subagent-menu-chevron,
    .command-subagent-model-trigger[aria-expanded="true"] .command-subagent-profile-chevron {
      transform: rotate(90deg);
    }

    .command-subagent-profile-section {
      min-width: 0;
      border-radius: 5px;
    }

    .command-subagent-profile-section + .command-subagent-profile-section {
      border-top: 1px solid var(--vscode-widget-border, transparent);
    }

    .command-subagent-profile-row {
      display: grid;
      grid-template-columns: minmax(68px, 0.65fr) minmax(0, 1.35fr);
      align-items: center;
      gap: 8px;
      min-height: 34px;
      padding: 3px 4px 3px 8px;
    }

    .command-subagent-profile-label {
      min-width: 0;
      font-size: 11px;
      font-weight: 600;
      line-height: 1.25;
    }

    .command-subagent-model-trigger {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 5px;
      min-width: 0;
      min-height: 26px;
      padding: 3px 5px 3px 7px;
      border: 1px solid transparent;
      border-radius: 5px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font: inherit;
      font-size: 11px;
      line-height: 1.25;
      text-align: right;
      cursor: pointer;
    }

    .command-subagent-model-trigger:hover:not(:disabled),
    .command-subagent-model-trigger:focus-visible:not(:disabled),
    .command-subagent-model-trigger[aria-expanded="true"]:not(:disabled) {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: var(--vscode-quickInputList-focusBackground, var(--vscode-list-hoverBackground));
      border-color: var(--vscode-focusBorder, transparent);
      outline: none;
    }

    .command-subagent-model-trigger:disabled {
      color: var(--vscode-disabledForeground, var(--vscode-descriptionForeground));
      cursor: default;
    }

    .command-subagent-profile-dropdown {
      display: grid;
      gap: 2px;
      margin: 0 4px 4px 8px;
      padding: 2px 0 2px 8px;
      border-left: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
    }

    .command-model-source {
      display: flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      min-height: 26px;
      padding: 4px 8px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      font-weight: 600;
      line-height: 1.25;
    }

    .command-model-protocol-logo-box {
      display: inline-flex;
      flex: 0 0 18px;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      overflow: hidden;
      border: 1px solid rgba(0, 0, 0, 0.12);
      border-radius: 4px;
      background: #fff;
      box-sizing: border-box;
    }

    .command-model-protocol-logo {
      display: block;
      width: 14px;
      height: 14px;
      object-fit: contain;
      pointer-events: none;
      user-select: none;
    }

    .command-skill-list {
      display: grid;
      gap: 3px;
      padding: 2px 0 4px 10px;
    }

    .command-skill-item {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 5px;
      padding: 6px 8px;
      border-radius: 6px;
      background: transparent;
    }

    .command-skill-item.is-disabled {
      opacity: 0.72;
    }

    .command-skill-item:focus-within {
      background: var(--vscode-list-hoverBackground, transparent);
    }

    .command-skill-main {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      width: 100%;
      min-height: 30px;
      padding: 0;
      border: none;
      background: transparent;
      color: var(--vscode-foreground);
      text-align: left;
    }

    .command-skill-main:hover,
    .command-skill-main:focus-within {
      color: var(--vscode-quickInputList-focusForeground, var(--vscode-foreground));
      background: transparent;
      outline: none;
    }

    .command-skill-name,
    .command-skill-description,
    .command-skill-meta {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .command-skill-name {
      font-size: 12px;
      font-weight: 650;
      line-height: 1.3;
    }

    .command-skill-description,
    .command-skill-meta {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.25;
    }

    .command-skill-checkbox {
      flex: 0 0 auto;
      width: 16px;
      height: 16px;
      margin: 0;
      accent-color: var(--vscode-focusBorder);
      cursor: pointer;
    }

    .command-skill-checkbox:disabled {
      cursor: default;
    }

    .command-skill-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
    }

    .command-skill-action {
      min-height: 22px;
      padding: 2px 6px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .command-skill-action:hover:not(:disabled),
    .command-skill-action:focus-visible:not(:disabled) {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
      outline: none;
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

    .command-model-empty {
      display: block;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      cursor: default;
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

    .command-model-option[aria-checked="true"] .command-model-name {
      font-weight: 600;
    }

    .command-approval-option-copy {
      display: flex;
      flex-direction: column;
      min-width: 0;
      gap: 1px;
    }

    .command-approval-option-description {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.25;
      white-space: normal;
    }

    .command-compression-row {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 6px;
      padding-top: 7px;
      padding-bottom: 8px;
    }

    .command-compression-tabs {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 3px;
      width: 100%;
      padding: 2px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-input-background, transparent);
    }

    .command-compression-tab {
      min-width: 0;
      min-height: 27px;
      padding: 4px 3px;
      overflow: hidden;
      border: 1px solid transparent;
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font-size: 10px;
      line-height: 1.25;
      text-align: center;
      text-overflow: ellipsis;
      white-space: nowrap;
      cursor: pointer;
    }

    .command-compression-tab:hover:not(:disabled),
    .command-compression-tab:focus-visible:not(:disabled) {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, var(--vscode-list-hoverBackground));
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .command-compression-tab[aria-selected="true"] {
      color: var(--vscode-button-foreground, var(--vscode-foreground));
      border-color: var(--vscode-focusBorder, var(--vscode-button-background));
      background: var(--vscode-button-background, var(--vscode-list-activeSelectionBackground));
      font-weight: 600;
    }

    .command-compression-tab:disabled {
      opacity: 0.62;
      cursor: default;
    }

    .command-effort-control {
      display: grid;
      gap: 2px;
      width: 132px;
      min-width: 120px;
    }

    .command-effort-slider {
      width: 100%;
      min-width: 0;
      height: 22px;
      margin: 0;
      padding: 0;
      accent-color: var(--vscode-progressBar-background, var(--vscode-textLink-foreground));
      cursor: pointer;
    }

    .command-effort-slider:disabled {
      cursor: default;
      opacity: 0.45;
    }

    .command-effort-scale {
      display: flex;
      justify-content: space-between;
      padding: 0 2px;
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      line-height: 1;
      pointer-events: none;
      user-select: none;
    }

`.slice(1)
};
