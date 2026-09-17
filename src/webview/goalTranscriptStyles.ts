export function getGoalTranscriptStyles(): string {
  return `
    .goal-transcript-card {
      --goal-state-color: var(--vscode-textLink-foreground);
      display: grid;
      gap: 9px;
      width: 100%;
      box-sizing: border-box;
      margin: 2px 0 18px;
      padding: 11px 12px;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-left: 3px solid var(--goal-state-color);
      border-radius: 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      color: var(--vscode-foreground);
    }

    .goal-transcript-card.status_completed {
      --goal-state-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green));
    }

    .goal-proposal-card {
      --goal-state-color: var(--vscode-textLink-foreground);
    }

    .goal-transcript-proposal-items {
      display: grid;
      gap: 5px;
    }

    .goal-transcript-proposal-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 7px;
      padding: 6px 7px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 5px;
      cursor: pointer;
    }

    .goal-transcript-proposal-item:focus-within {
      border-color: var(--vscode-focusBorder);
    }

    .goal-transcript-proposal-item.is-unselected {
      opacity: .68;
      border-style: dashed;
    }

    .goal-transcript-proposal-item > span {
      display: grid;
      gap: 2px;
      min-width: 0;
    }

    .goal-transcript-proposal-item strong,
    .goal-transcript-proposal-item > span > span,
    .goal-transcript-proposal-item small {
      overflow-wrap: anywhere;
    }

    .goal-transcript-proposal-item > span > span,
    .goal-transcript-proposal-item small {
      color: var(--vscode-descriptionForeground);
    }

    .goal-transcript-proposal-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 5px;
    }

    .goal-transcript-proposal-actions button {
      min-height: 24px;
      padding: 2px 7px;
      font-size: 10px;
    }

    .goal-transcript-card.status_failed,
    .goal-transcript-card.status_needs_attention,
    .goal-transcript-card.status_interrupted {
      --goal-state-color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground));
    }

    .goal-transcript-card.status_paused,
    .goal-transcript-card.status_stopped,
    .goal-transcript-card.status_waiting_for_apply,
    .goal-transcript-card.status_waiting_for_authorization,
    .goal-transcript-card.status_waiting_for_command,
    .goal-transcript-card.status_waiting_for_user {
      --goal-state-color: var(--vscode-notificationsWarningIcon-foreground, var(--vscode-editorWarning-foreground));
    }

    .goal-transcript-header,
    .goal-transcript-heading,
    .goal-transcript-current,
    .goal-transcript-progress-row,
    .goal-transcript-metrics {
      display: flex;
      align-items: center;
      min-width: 0;
    }

    .goal-transcript-details {
      border-top: 1px solid var(--vscode-panel-border);
      padding-top: 6px;
      font-size: 10px;
    }

    .goal-transcript-details > summary {
      cursor: pointer;
      color: var(--vscode-descriptionForeground);
    }

    .goal-transcript-work-items {
      display: grid;
      gap: 3px;
      margin: 7px 0 0;
      padding-left: 18px;
    }

    .goal-transcript-work-items .is-completed { color: var(--vscode-testing-iconPassed); }
    .goal-transcript-work-items .is-blocked,
    .goal-transcript-work-items .is-failed { color: var(--vscode-errorForeground); }

    .goal-transcript-header {
      justify-content: space-between;
      gap: 8px;
    }

    .goal-transcript-heading {
      gap: 7px;
      flex-wrap: wrap;
      font-size: 12px;
    }

    .goal-transcript-dot {
      width: 7px;
      height: 7px;
      flex: none;
      border-radius: 50%;
      background: var(--goal-state-color);
    }

    .goal-transcript-status {
      color: var(--goal-state-color);
      font-size: 11px;
      font-weight: 600;
    }

    .goal-transcript-manage {
      flex: none;
      min-height: 24px;
      padding: 2px 8px;
      font-size: 11px;
    }

    .goal-transcript-objective {
      display: -webkit-box;
      overflow: hidden;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
      overflow-wrap: anywhere;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.45;
    }

    .goal-transcript-current {
      align-items: flex-start;
      gap: 7px;
      padding: 7px 8px;
      border-radius: 5px;
      background: var(--vscode-textBlockQuote-background, var(--vscode-editor-inactiveSelectionBackground));
      font-size: 11px;
      line-height: 1.4;
    }

    .goal-transcript-current-label {
      flex: none;
      color: var(--vscode-descriptionForeground);
    }

    .goal-transcript-current-text {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .goal-transcript-progress-row {
      justify-content: space-between;
      gap: 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
    }

    .goal-transcript-progress {
      width: min(34%, 120px);
      height: 4px;
      flex: none;
      overflow: hidden;
      border-radius: 999px;
      background: var(--vscode-progressBar-background, var(--vscode-panel-border));
      opacity: 0.48;
    }

    .goal-transcript-progress > span {
      display: block;
      height: 100%;
      border-radius: inherit;
      background: var(--goal-state-color);
      opacity: 1;
    }

    .goal-transcript-metrics {
      flex-wrap: wrap;
      gap: 4px 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
    }

    @media (max-width: 360px) {
      .goal-transcript-header,
      .goal-transcript-progress-row {
        align-items: flex-start;
      }

      .goal-transcript-progress-row {
        flex-direction: column;
        gap: 5px;
      }

      .goal-transcript-progress {
        width: 100%;
      }
    }
  `.slice(1);
}
