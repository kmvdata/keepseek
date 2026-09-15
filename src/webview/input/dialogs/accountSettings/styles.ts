import type { WebviewFragment } from '../../composition';

export const accountSettingsStatusStylesFragment: WebviewFragment = {
  id: 'styles.dialogs.account-settings-status',
  source: `
    .settings-dialog-status {
      flex: 1 1 160px;
      min-width: 0;
      align-self: center;
      margin: 0 auto 0 0;
      padding: 4px 0;
      color: var(--vscode-foreground);
      font-size: 12px;
      line-height: 1.45;
      overflow: hidden;
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      white-space: normal;
      animation: keepseek-settings-status-breath 2.4s ease-in-out infinite;
    }

    @keyframes keepseek-settings-status-breath {
      0%, 100% { opacity: 0.4; }
      50% { opacity: 1; }
    }

`.slice(1)
};

export const accountSettingsStylesFragment: WebviewFragment = {
  id: 'styles.dialogs.account-settings',
  source: `
    .settings-account-workspace {
      display: grid;
      grid-template-columns: minmax(160px, 0.38fr) minmax(240px, 1fr);
      align-items: start;
      gap: 12px;
    }

    .settings-account-sidebar,
    .settings-account-editor {
      min-width: 0;
      padding: 10px;
      border: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
      border-radius: 6px;
      background: var(--vscode-editor-background, transparent);
    }

    .settings-account-section-header,
    .settings-account-editor-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 9px;
    }

    .settings-account-editor-header > div,
    .settings-model-header > div {
      flex: 1 1 140px;
      min-width: 0;
    }

    .settings-section-heading {
      display: block;
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 600;
      line-height: 1.35;
    }

    .settings-account-provider {
      display: block;
      margin-top: 2px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.25;
    }

    .settings-account-create-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 6px;
      margin-bottom: 10px;
    }

    .settings-account-create-row select {
      min-width: 0;
    }

    .settings-account-list {
      display: flex;
      flex-direction: column;
      gap: 3px;
      max-height: 330px;
      overflow-y: auto;
    }

    .settings-account-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      width: 100%;
      min-width: 0;
      padding: 6px 7px;
      border-color: transparent;
      color: var(--vscode-foreground);
      background: transparent;
      text-align: left;
    }

    .settings-account-item:hover {
      background: var(--vscode-list-hoverBackground, var(--vscode-toolbar-hoverBackground));
    }

    .settings-account-item[aria-selected="true"] {
      border-color: var(--vscode-focusBorder, var(--vscode-inputOption-activeBorder));
      background: var(--vscode-list-activeSelectionBackground, var(--vscode-editor-selectionBackground));
      color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground));
    }

    .settings-account-item-identity {
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
    }

    .settings-account-item-logo-box {
      display: inline-flex;
      position: relative;
      flex: 0 0 24px;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      overflow: hidden;
      border: 1px solid rgba(0, 0, 0, 0.12);
      border-radius: 5px;
      background: #fff;
      box-sizing: border-box;
    }

    .settings-account-item-logo {
      display: block;
      width: 18px;
      height: 18px;
      object-fit: contain;
      pointer-events: none;
      user-select: none;
    }

    .settings-account-item-logo[data-provider="deepseek"] {
      position: absolute;
      top: 50%;
      left: 0;
      width: auto;
      max-width: none;
      height: 18px;
      transform: translateY(-50%);
    }

    .settings-account-item-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .settings-account-item-check {
      flex: 0 0 auto;
      width: 14px;
      color: currentColor;
      text-align: center;
    }

    .settings-account-editor[aria-busy="true"],
    .settings-account-sidebar[aria-busy="true"] {
      opacity: 0.78;
    }

    .settings-danger-button {
      flex: 0 0 auto;
      color: var(--vscode-errorForeground);
    }

    .settings-empty-state {
      padding: 10px;
      border: 1px dashed var(--vscode-panel-border, var(--vscode-input-border, transparent));
      border-radius: 4px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.4;
      text-align: center;
    }

    .settings-model-section {
      margin-top: 14px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
    }

    .settings-model-header {
      align-items: flex-start;
    }

    .settings-model-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
      max-height: 238px;
      overflow-y: auto;
    }

    .settings-model-row {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: center;
      gap: 6px;
      padding: 7px;
      border: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
      border-radius: 4px;
    }

    .settings-model-identity {
      min-width: 0;
    }

    .settings-model-identity .settings-field-hint {
      display: block;
      margin-top: 2px;
    }

    .settings-model-capabilities {
      display: flex !important;
      flex-wrap: wrap;
      align-items: center;
      gap: 2px 8px;
    }

    .settings-model-capability {
      display: inline-flex;
      align-items: center;
      min-width: 0;
    }

    .settings-model-context-value {
      min-width: 0;
      padding: 0 1px;
      border: 0;
      border-bottom: 1px dotted currentColor;
      border-radius: 0;
      color: var(--vscode-textLink-foreground, var(--vscode-foreground));
      background: transparent;
      font: inherit;
      line-height: inherit;
      cursor: pointer;
    }

    .settings-model-context-value:hover {
      color: var(--vscode-textLink-activeForeground, var(--vscode-textLink-foreground));
      border-bottom-style: solid;
      background: transparent;
    }

    .settings-model-context-value:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
    }

    .settings-model-context-value:disabled {
      opacity: 0.6;
      cursor: default;
    }

    .settings-model-context-capability.is-editing,
    .settings-model-output-capability.is-editing {
      display: inline-grid;
      grid-template-columns: minmax(56px, 82px) auto auto auto;
      align-items: center;
      gap: 3px;
    }

    .settings-model-context-input {
      width: 100%;
      min-width: 0;
      height: 22px;
      padding: 1px 4px;
      border: 1px solid var(--vscode-focusBorder, var(--vscode-input-border));
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      font: inherit;
    }

    .settings-model-context-unit {
      color: var(--vscode-descriptionForeground);
    }

    .settings-model-context-edit-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: 0;
      border-radius: 3px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font-size: 13px;
      line-height: 1;
    }

    .settings-model-context-edit-action:hover,
    .settings-model-context-edit-action:focus-visible {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
    }

    .settings-model-context-edit-action.is-save {
      color: var(--vscode-testing-iconPassed, var(--vscode-foreground));
    }

    .settings-model-name {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-foreground);
      font-size: 11px;
      font-weight: 500;
    }

    .settings-model-row.is-disabled .settings-model-name {
      color: var(--vscode-descriptionForeground);
      font-weight: 400;
    }

    .settings-model-row.is-disabled .settings-model-capabilities {
      opacity: 0.8;
    }

    .settings-model-actions {
      display: inline-flex;
      align-items: center;
      justify-content: flex-end;
      gap: 6px;
    }

    .settings-model-enable {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      cursor: pointer;
    }

    .settings-model-enable input {
      width: 14px;
      height: 14px;
      margin: 0;
      accent-color: var(--vscode-focusBorder);
      cursor: pointer;
    }

    .settings-model-enable input:disabled {
      cursor: default;
    }

    .settings-model-delete {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      padding: 0;
      border: none;
      border-radius: 4px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      font-size: 14px;
      line-height: 1;
      cursor: pointer;
    }

    .settings-model-delete:hover {
      background: var(--vscode-toolbar-hoverBackground, rgba(128, 128, 128, 0.2));
      color: var(--vscode-errorForeground, var(--vscode-foreground));
    }

    .settings-model-delete:disabled {
      opacity: 0.5;
      cursor: default;
    }

    .settings-manual-model {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      align-items: end;
      gap: 6px;
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
    }

    .settings-manual-model .settings-field {
      margin: 0;
    }

    .settings-manual-model-id {
      grid-column: 1 / -1;
    }

    .settings-manual-model button {
      grid-column: 2;
      justify-self: end;
    }

`.slice(1)
};

export const accountSettingsSecretStylesFragment: WebviewFragment = {
  id: 'styles.dialogs.account-settings-secret',
  source: `

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

`.slice(1)
};

export const accountSettingsResponsiveStylesFragment: WebviewFragment = {
  id: 'styles.dialogs.account-settings-responsive',
  source: `
    @media (max-width: 540px) {
      .settings-account-workspace {
        grid-template-columns: minmax(0, 1fr);
      }

      .settings-account-list {
        max-height: 156px;
      }

      .settings-manual-model {
        grid-template-columns: minmax(0, 1fr);
      }

      .settings-manual-model-id,
      .settings-manual-model button {
        grid-column: 1;
      }

      .settings-model-row button,
      .settings-manual-model button {
        justify-self: end;
      }
    }
`.slice(1)
};

