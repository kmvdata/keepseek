import type { WebviewFragment } from '../composition';

export const dialogChromeStylesFragment: WebviewFragment = {
  id: 'styles.dialogs.chrome',
  source: `
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
      width: min(420px, calc(100vw - var(--keepseek-edge-padding-double, 8px)));
      max-height: min(720px, calc(100vh - 24px));
      display: flex;
      flex-direction: column;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 10px;
      background: var(--vscode-quickInput-background, var(--vscode-editorWidget-background, var(--vscode-sideBar-background)));
      color: var(--vscode-quickInput-foreground, var(--vscode-foreground));
      box-shadow: 0 12px 32px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
    }

    .settings-account-dialog {
      width: min(720px, calc(100vw - var(--keepseek-edge-padding-double, 8px)));
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
      overflow-y: auto;
    }

    .settings-dialog-desc {
      margin: 0 0 14px;
      font-size: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.45;
    }

`.slice(1)
};

export const dialogFieldStylesFragment: WebviewFragment = {
  id: 'styles.dialogs.fields',
  source: `
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

    .settings-field-hint {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.35;
    }

    .settings-section-title {
      margin: 16px 0 10px;
      padding-top: 12px;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
      color: var(--vscode-foreground);
      font-size: 12px;
      font-weight: 600;
    }

    .settings-toggle-field {
      position: relative;
      display: grid;
      grid-template-columns: minmax(0, 1fr) 34px;
      align-items: center;
      gap: 10px;
      cursor: pointer;
    }

    .settings-toggle-copy {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }

    .settings-toggle-input {
      position: absolute;
      inline-size: 1px;
      block-size: 1px;
      opacity: 0;
      pointer-events: none;
    }

    .settings-toggle-track {
      position: relative;
      width: 34px;
      height: 18px;
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
      border-radius: 999px;
      background: var(--vscode-input-background);
      transition: background 120ms ease, border-color 120ms ease;
    }

    .settings-toggle-track::after {
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

    .settings-toggle-input:checked + .settings-toggle-track {
      border-color: var(--vscode-textLink-foreground);
      background: var(--vscode-textLink-foreground);
    }

    .settings-toggle-input:checked + .settings-toggle-track::after {
      transform: translateX(16px);
      background: var(--vscode-button-foreground);
    }

    .settings-toggle-input:focus-visible + .settings-toggle-track {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 2px;
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

    .settings-input:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }

    .settings-textarea {
      min-height: 82px;
      resize: vertical;
      line-height: 1.4;
      font-family: var(--vscode-font-family);
    }
`.slice(1)
};

export const dialogFooterStylesFragment: WebviewFragment = {
  id: 'styles.dialogs.footer',
  source: `
    .settings-dialog-footer {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      padding: 0 16px 14px;
    }

`.slice(1)
};

