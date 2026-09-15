import type { WebviewFragment } from '../composition';

export const subagentProgressStylesFragment: WebviewFragment = {
  id: 'styles.usage.subagent-progress',
  source: `
    .subagent-progress-panel {
      display: grid;
      gap: 6px;
      margin: 8px var(--keepseek-edge-padding, 0px);
      padding: 8px;
      border: 1px solid var(--vscode-panel-border, transparent);
      border-radius: 6px;
      background: var(--vscode-editor-background, transparent);
    }

    .subagent-progress-title,
    .subagent-progress-heading {
      font-size: 11px;
      font-weight: 600;
    }

    .subagent-progress-row {
      display: grid;
      gap: 2px;
      padding: 5px 6px;
      border-left: 2px solid var(--vscode-progressBar-background, var(--vscode-focusBorder));
      background: var(--vscode-list-hoverBackground, transparent);
    }

    .subagent-progress-heading {
      display: flex;
      justify-content: space-between;
      gap: 8px;
    }

    .subagent-progress-depth,
    .subagent-progress-summary {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .subagent-progress-row.status-failed,
    .subagent-progress-row.status-stopped {
      border-left-color: var(--vscode-errorForeground);
    }

    .subagent-diagnostic-button {
      width: fit-content;
      padding: 2px 6px;
      border: 0;
      color: var(--vscode-textLink-foreground);
      background: transparent;
      font: inherit;
      cursor: pointer;
    }

    .subagent-diagnostic-button:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

`.slice(1)
};

