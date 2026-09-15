import type { WebviewFragment } from '../composition';

export const usageIndicatorStylesFragment: WebviewFragment = {
  id: 'styles.usage.indicator',
  source: `
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
      border: 0;
      padding: 0;
      background: transparent;
      cursor: pointer;
    }

    .context-progress::before {
      content: "";
      position: absolute;
      inset: 2px;
      z-index: 2;
      border: 1px solid var(--context-progress-color);
      border-radius: 50%;
      opacity: 0;
      transform: scale(1);
      pointer-events: none;
      will-change: opacity, transform;
    }

    .context-progress:hover::before,
    .context-progress:focus-visible::before {
      animation: context-progress-inward-scan 900ms linear infinite;
    }

    @keyframes context-progress-inward-scan {
      0% {
        opacity: 0.62;
        transform: scale(1);
      }
      86% {
        opacity: 0.46;
        transform: scale(0.08);
      }
      94%, 100% {
        opacity: 0;
        transform: scale(0);
      }
    }

    @keyframes context-progress-outer-sync {
      0% {
        opacity: 0.85;
      }
      22% {
        opacity: 0.42;
      }
      45%, 100% {
        opacity: 0;
      }
    }

    .context-progress.is-warning {
      --context-progress-color: var(--vscode-editorWarning-foreground, #cca700);
    }

    .context-progress.is-danger {
      --context-progress-color: var(--vscode-editorError-foreground, #f14c4c);
    }

    .context-progress-ring {
      position: relative;
      z-index: 1;
      display: block;
      width: 18px;
      height: 18px;
      border-radius: 50%;
      background: conic-gradient(
        var(--context-progress-color) var(--context-progress-angle),
        var(--context-progress-track) 0
      );
    }

    .context-progress-ring::before {
      content: "";
      position: absolute;
      inset: 0;
      border: 1px solid var(--context-progress-color);
      border-radius: 50%;
      opacity: 0;
      pointer-events: none;
      will-change: opacity;
    }

    .context-progress:hover .context-progress-ring::before,
    .context-progress:focus-visible .context-progress-ring::before {
      animation: context-progress-outer-sync 900ms linear infinite;
    }

    .context-progress-ring::after {
      content: "";
      position: absolute;
      inset: 4px;
      border-radius: 50%;
      background: var(--vscode-chat-requestBackground, var(--vscode-input-background));
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
      max-width: min(320px, calc(100vw - var(--keepseek-edge-padding-double, 8px)));
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

    #contextProgressTitle {
      text-align: center;
      font-weight: 600;
    }

    .context-progress-breakdown {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 3px 10px;
      margin-top: 5px;
      padding-top: 5px;
      border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
    }

    .context-progress-metric {
      display: grid !important;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 6px;
      align-items: baseline;
      min-width: 0;
    }

    .context-progress-metric-label {
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      white-space: nowrap;
    }

    .context-progress-metric-value {
      color: var(--vscode-foreground);
      text-align: right;
      font-variant-numeric: tabular-nums;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .context-progress:hover .context-progress-tooltip,
    .context-progress:focus-visible .context-progress-tooltip {
      opacity: 1;
      transform: translateY(0);
    }

    .context-progress[aria-expanded="true"] .context-progress-tooltip {
      opacity: 0;
    }

`.slice(1)
};

export const usageDialogStylesFragment: WebviewFragment = {
  id: 'styles.usage.dialog',
  source: `
    .usage-details-dialog {
      position: relative;
      width: min(540px, calc(100vw - 12px));
      max-width: calc(100vw - 12px);
      max-height: calc(100vh - 16px);
      padding: 0;
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 12px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, var(--vscode-editor-background));
      box-shadow: 0 12px 32px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.36));
    }

    .usage-details-dialog[open] { display: flex; flex-direction: column; }
    .usage-details-dialog::backdrop { background: rgba(0, 0, 0, 0.5); }
    .usage-details-header {
      position: absolute;
      top: 0;
      right: 0;
      z-index: 3;
      padding: 5px 7px;
    }
    .usage-details-header h2,
    .usage-details-header p {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .usage-details-header button { min-height: 24px; padding: 2px 8px; }
    .usage-details-body { min-height: 0; overflow-y: auto; padding: 0 7px 7px; }
    .usage-details-body:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .usage-details-toolbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      min-height: 35px;
      margin: 0 -7px 8px;
      padding: 5px 52px 5px 9px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .usage-details-eyebrow { font-size: 12px; font-weight: 600; }
    .usage-segmented-control {
      display: inline-flex;
      align-items: center;
      gap: 1px;
      padding: 2px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    }
    .usage-segmented-control button {
      min-width: 0;
      min-height: 24px;
      padding: 2px 9px;
      border: 0;
      border-radius: 5px;
      color: var(--vscode-descriptionForeground);
      background: transparent;
      font: inherit;
      font-size: 11px;
      cursor: pointer;
    }
    .usage-segmented-control button:hover:not(:disabled) { color: var(--vscode-foreground); }
    .usage-segmented-control button[aria-pressed="true"] {
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground, var(--vscode-list-hoverBackground));
      box-shadow: 0 1px 3px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.2));
      font-weight: 600;
    }
    .usage-segmented-control button:focus-visible,
    .usage-analysis-summary:focus-visible,
    .usage-subagent-analysis > summary:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .usage-segmented-control button:disabled { opacity: 0.45; cursor: default; }
    .usage-section {
      margin-bottom: 9px;
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 9px;
      background: var(--vscode-editor-background, transparent);
    }
    .usage-section:last-child { margin-bottom: 0; }
    .usage-section-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 9px;
    }
    .usage-section-heading h3 { margin: 0; font-size: 13px; line-height: 1.4; }
    .usage-context-panel {
      padding: 10px;
      border: 1px solid color-mix(in srgb, var(--vscode-charts-green, #2fa89a) 42%, var(--vscode-panel-border));
      border-radius: 8px;
      background: color-mix(in srgb, var(--vscode-charts-green, #2fa89a) 4%, var(--vscode-editor-background));
    }
    .usage-context-topline { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .usage-context-status {
      padding: 2px 9px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 999px;
      font-size: 11px;
      line-height: 1.4;
    }
    .usage-context-status.is-healthy {
      border-color: color-mix(in srgb, var(--vscode-charts-green, #2fa89a) 40%, transparent);
      color: var(--vscode-charts-green, #2fa89a);
      background: color-mix(in srgb, var(--vscode-charts-green, #2fa89a) 12%, transparent);
    }
    .usage-context-status.is-warning {
      border-color: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 45%, transparent);
      color: var(--vscode-editorWarning-foreground, #cca700);
      background: color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 12%, transparent);
    }
    .usage-context-total { font-size: 13px; font-variant-numeric: tabular-nums; }
    .usage-context-progress { position: relative; margin-top: 27px; padding-top: 1px; }
    .usage-context-marker {
      position: absolute;
      top: -22px;
      z-index: 1;
      min-width: 28px;
      padding: 1px 5px;
      border-radius: 999px;
      text-align: center;
      font-size: 10px;
      line-height: 16px;
      font-variant-numeric: tabular-nums;
      transform: translateX(-50%);
      white-space: nowrap;
    }
    .usage-context-current-marker {
      color: var(--vscode-button-foreground, #fff);
      background: var(--vscode-charts-orange, #ff6b4a);
    }
    .usage-context-threshold-marker {
      color: var(--vscode-foreground);
      background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background));
      box-shadow: 0 1px 4px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.22));
    }
    .usage-context-track {
      position: relative;
      height: 8px;
      overflow: hidden;
      border-radius: 999px;
      background: var(--vscode-progressBar-background, var(--vscode-panel-border));
    }
    .usage-context-fill { display: block; height: 100%; border-radius: inherit; background: var(--vscode-charts-orange, #ff6b4a); }
    .usage-context-threshold-line {
      position: absolute;
      top: -2px;
      bottom: -2px;
      width: 1px;
      background: var(--vscode-foreground);
      opacity: 0.55;
    }
    .usage-context-progress-labels {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-top: 7px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-variant-numeric: tabular-nums;
    }
    .usage-context-budget {
      margin-top: 12px;
      padding: 10px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: color-mix(in srgb, var(--vscode-editorWidget-background, var(--vscode-editor-background)) 80%, transparent);
    }
    .usage-context-budget-title { margin: 0 0 9px; color: var(--vscode-descriptionForeground); font-size: 11px; font-weight: 500; }
    .usage-context-budget-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .usage-context-budget-metric { min-width: 0; }
    .usage-context-budget-metric span,
    .usage-analysis-card-metric span { display: block; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .usage-context-budget-metric strong,
    .usage-analysis-card-metric strong {
      display: block;
      margin-top: 2px;
      overflow-wrap: anywhere;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .usage-context-budget-source,
    .usage-context-diagnostic,
    .usage-session-notes p,
    .usage-analysis-card-body p {
      margin: 9px 0 0;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .usage-context-diagnostic span { color: var(--vscode-foreground); font-weight: 500; }
    .usage-session-metrics-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .usage-session-metric {
      min-width: 0;
      padding: 8px 0 8px 10px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    .usage-session-metric:nth-child(odd) { padding-left: 0; padding-right: 10px; border-right: 1px solid var(--vscode-panel-border); }
    .usage-session-metric.is-wide { grid-column: 1 / -1; padding-left: 0; border-right: 0; }
    .usage-session-metric span { display: block; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .usage-session-metric strong {
      display: block;
      margin-top: 2px;
      overflow-wrap: anywhere;
      font-size: 16px;
      line-height: 1.3;
      font-variant-numeric: tabular-nums;
    }
    .usage-session-metric.is-positive strong { color: var(--vscode-charts-green, #2fa89a); }
    .usage-session-notes { padding-top: 1px; }
    .usage-session-notes .usage-warning,
    .usage-analysis-card-body .usage-warning { color: var(--vscode-editorWarning-foreground, #cca700); }
    .usage-analysis-controls { margin-left: auto; }
    .usage-analysis-share {
      margin-bottom: 8px;
      padding: 9px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 7px;
      background: var(--vscode-editorWidget-background, transparent);
    }
    .usage-analysis-share h4 { margin: 0 0 8px; font-size: 11px; }
    .usage-analysis-share-bar { display: flex; height: 6px; overflow: hidden; border-radius: 999px; background: var(--vscode-panel-border); }
    .usage-analysis-share-bar span { display: block; height: 100%; }
    .usage-analysis-share-legend { display: flex; flex-wrap: wrap; gap: 5px 12px; margin-top: 7px; }
    .usage-analysis-legend-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      color: var(--vscode-descriptionForeground);
      font-size: 9px;
      overflow-wrap: anywhere;
    }
    .usage-analysis-dot { display: inline-block; flex: none; width: 7px; height: 7px; border-radius: 50%; }
    .usage-analysis-share-bar .color-0, .usage-analysis-dot.color-0 { background: var(--vscode-charts-green, #2fa89a); }
    .usage-analysis-share-bar .color-1, .usage-analysis-dot.color-1 { background: var(--vscode-charts-blue, #3794ff); }
    .usage-analysis-share-bar .color-2, .usage-analysis-dot.color-2 { background: var(--vscode-descriptionForeground, #8b949e); }
    .usage-analysis-share-bar .color-3, .usage-analysis-dot.color-3 { background: var(--vscode-charts-purple, #b180d7); }
    .usage-analysis-share-bar .color-4, .usage-analysis-dot.color-4 { background: var(--vscode-charts-orange, #ff9d45); }
    .usage-analysis-list { display: grid; gap: 7px; }
    .usage-analysis-card,
    .usage-subagent-analysis { border: 1px solid var(--vscode-panel-border); border-radius: 7px; background: var(--vscode-editor-background, transparent); }
    .usage-analysis-summary { padding: 9px; cursor: pointer; }
    .usage-analysis-summary::marker,
    .usage-subagent-analysis > summary::marker { color: var(--vscode-descriptionForeground); font-size: 10px; }
    .usage-analysis-card-title { display: inline-flex; align-items: center; gap: 6px; max-width: calc(100% - 60px); vertical-align: middle; }
    .usage-analysis-card-title strong { overflow-wrap: anywhere; font-size: 11px; }
    .usage-analysis-request-count { float: right; color: var(--vscode-descriptionForeground); font-size: 10px; font-variant-numeric: tabular-nums; }
    .usage-analysis-card-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-top: 9px; }
    .usage-analysis-expand { display: block; margin-top: 7px; color: var(--vscode-descriptionForeground); font-size: 9px; }
    .usage-analysis-card[open] .usage-analysis-expand { display: none; }
    .usage-analysis-card-body { padding: 0 9px 9px; border-top: 1px solid var(--vscode-panel-border); }
    .usage-subagent-analysis { margin-top: 8px; }
    .usage-subagent-analysis > summary { padding: 9px; cursor: pointer; font-size: 11px; font-weight: 600; }
    .usage-subagent-analysis-body { padding: 0 9px 9px; }
    .usage-subagent-estimate-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
    .usage-subagent-group-title { margin: 12px 0 6px; font-size: 10px; }
    .usage-subagent-run-list { display: grid; gap: 6px; }
    .usage-subagent-run { padding: 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
    .usage-subagent-run-heading { display: flex; align-items: center; gap: 6px; min-width: 0; }
    .usage-subagent-run-heading strong { min-width: 0; overflow-wrap: anywhere; font-size: 10px; }
    .usage-subagent-run p { margin: 5px 0 0; color: var(--vscode-descriptionForeground); font-size: 9px; line-height: 1.45; }
    .usage-status { flex: none; padding: 1px 5px; border: 1px solid var(--vscode-panel-border); border-radius: 4px; font-size: 9px; }
    .usage-status-failed { color: var(--vscode-errorForeground, #f14c4c); }
    .usage-status-stopped { color: var(--vscode-editorWarning-foreground, #cca700); }
    .usage-note { margin: 7px 0; color: var(--vscode-descriptionForeground); font-size: 10px; line-height: 1.55; overflow-wrap: anywhere; }
    .usage-warning { margin: 7px 0; color: var(--vscode-editorWarning-foreground, #cca700); font-size: 10px; line-height: 1.5; }
    .usage-estimate-disclaimer { margin: 8px 0 0; padding: 8px; border-left: 2px solid var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background, transparent); font-size: 10px; line-height: 1.55; }
    @media (max-width: 420px) {
      .usage-details-dialog { max-height: calc(100vh - 8px); }
      .usage-details-header { padding: 5px 6px; }
      .usage-details-body { padding: 0 6px 6px; }
      .usage-details-toolbar { margin: 0 -6px 7px; }
      .usage-section { padding: 9px; }
      .usage-context-budget-grid,
      .usage-analysis-card-grid,
      .usage-subagent-estimate-grid { gap: 5px; }
      .usage-context-budget-metric strong,
      .usage-analysis-card-metric strong { font-size: 11px; }
    }

`.slice(1)
};

