import { getNewAccountDialogStyles } from './newAccountDialog';

export function getInputStyles(): string {
  return `
    .rich-input {
      position: relative;
      min-height: 56px;
      /* 必须与 updatePromptVisualState() 的 autogrow 上限（200）保持一致：
         不一致时 height='auto' 会被钳到 max-height、随后收缩回固定值，
         导致 scrollTop 被 clamp，滚动条出现后每次输入视口跳动（闪烁）。 */
      max-height: 200px;
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

    .rich-input span,
    .rich-input font,
    .rich-input code,
    .rich-input pre {
      color: inherit !important;
      background: transparent !important;
      font: inherit !important;
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

    .rich-skill-link,
    .skill-pill {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      min-height: 20px;
      margin: 0 2px 2px 0;
      padding: 1px 6px;
      border: 1px solid var(--vscode-inputOption-activeBorder, var(--vscode-panel-border));
      border-radius: 4px;
      background: var(--vscode-inputOption-activeBackground, var(--vscode-editor-background));
      color: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
      text-decoration: none;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 12px;
      line-height: 18px;
      vertical-align: baseline;
      white-space: nowrap;
      cursor: default;
    }

    .rich-skill-link {
      gap: 4px;
      min-width: 0;
      cursor: pointer;
    }

    .rich-skill-link:hover {
      border-color: var(--vscode-focusBorder, var(--vscode-inputOption-activeBorder, var(--vscode-panel-border)));
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-textLink-activeForeground);
    }

    .rich-skill-link:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .rich-skill-link-icon {
      display: inline-flex;
      flex: 0 0 12px;
      width: 12px;
      height: 12px;
      color: currentColor;
    }

    .rich-skill-link-icon img,
    .skill-pill-icon img {
      display: block;
      width: 100%;
      height: 100%;
    }

    .skill-pill-icon {
      display: inline-flex;
      flex: 0 0 12px;
      width: 12px;
      height: 12px;
    }

    .rich-skill-link-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .composer {
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

    .skills-bar {
      display: flex;
      align-items: center;
      gap: 5px;
      min-height: 28px;
      padding: 4px 4px 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.25;
    }

    .skills-bar-label {
      flex: 0 0 auto;
      font-weight: 600;
    }

    .skills-bar-list {
      display: flex;
      flex-wrap: wrap;
      gap: 3px;
      min-width: 0;
    }

    .skill-pill {
      gap: 4px;
      margin: 0;
      padding-right: 3px;
      cursor: pointer;
    }

    .skill-pill:hover {
      border-color: var(--vscode-focusBorder, var(--vscode-inputOption-activeBorder, var(--vscode-panel-border)));
      background: var(--vscode-toolbar-hoverBackground);
      color: var(--vscode-textLink-activeForeground);
    }

    .skill-pill:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .skill-pill-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .skill-pill-remove {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 16px;
      min-width: 16px;
      height: 16px;
      min-height: 16px;
      padding: 0;
      border: none;
      border-radius: 3px;
      background: transparent;
      color: var(--vscode-descriptionForeground);
      line-height: 1;
    }

    .skill-pill-remove:hover,
    .skill-pill-remove:focus-visible {
      color: var(--vscode-foreground);
      background: var(--vscode-toolbar-hoverBackground);
      outline: none;
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
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-height: 30px;
      padding: var(--keepseek-toolbar-padding, 0 4px 4px);
    }

    .composer-model-selection-status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      margin: 0 4px 3px;
      padding: 4px 6px;
      border-radius: 5px;
      color: var(--vscode-descriptionForeground);
      background: var(--vscode-textBlockQuote-background, var(--vscode-sideBar-background));
      font-size: 11px;
      line-height: 1.35;
    }

    .composer-model-selection-status > span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .composer-toolbar-left {
      display: flex;
      align-items: center;
      gap: 4px;
      min-width: 0;
      flex: 1;
    }

    .composer-toolbar-right {
      display: flex;
      align-items: center;
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

    .composer-icon-btn:hover:not(:disabled) {
      color: var(--vscode-foreground);
      border-color: var(--vscode-focusBorder, var(--vscode-panel-border, var(--vscode-input-border, transparent)));
      background: var(--vscode-toolbar-hoverBackground);
    }

    .composer-icon-btn:disabled {
      opacity: 0.4;
      cursor: default;
    }

    .composer-send-btn:hover:not(:disabled) {
      border-color: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      color: var(--vscode-button-foreground, var(--vscode-editor-background));
    }

    .composer-send-btn.is-abort {
      border-color: var(--vscode-errorForeground, var(--vscode-button-background));
      background: var(--vscode-errorForeground, var(--vscode-button-background));
      color: var(--vscode-button-foreground, var(--vscode-editor-background));
    }

    .composer-send-btn.is-abort:hover:not(:disabled) {
      opacity: 0.88;
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

    .composer-status,
    #status {
      display: block;
      flex: 1 1 auto;
      min-width: 0;
      height: 26px;
      margin-left: 6px;
      font-size: 11px;
      line-height: 26px;
    }

    .composer-status-text {
      display: block;
      width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      color: var(--vscode-descriptionForeground);
      opacity: 0.82;
      transition: opacity 120ms ease;
    }

    .composer-status.is-active .composer-status-text,
    #status.is-active .composer-status-text {
      color: var(--vscode-descriptionForeground);
      opacity: 1;
      animation: keepseek-status-breathe 2.6s ease-in-out infinite;
    }

    .composer-status.is-fading .composer-status-text,
    #status.is-fading .composer-status-text {
      opacity: 0;
      animation: none;
    }

    .composer-status-tooltip {
      position: absolute;
      left: 4px;
      right: 4px;
      bottom: calc(100% + 4px);
      z-index: 40;
      padding: 7px 8px;
      border: 1px solid var(--vscode-editorHoverWidget-border, var(--vscode-panel-border));
      border-radius: 6px;
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background));
      box-shadow: 0 3px 10px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.24));
      color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
      font-size: 11px;
      font-weight: 400;
      line-height: 1.45;
      text-align: left;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      opacity: 0;
      visibility: hidden;
      transform: translateY(2px);
      pointer-events: none;
      transition: opacity 100ms ease, transform 100ms ease, visibility 0s linear 100ms;
    }

    .composer-status:hover .composer-status-tooltip {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
      transition-delay: 80ms;
    }

    @keyframes keepseek-status-breathe {
      0%,
      100% {
        color: var(--vscode-descriptionForeground);
        opacity: 0.72;
        text-shadow: 0 0 0 transparent;
      }

      46% {
        color: var(--vscode-foreground);
        opacity: 1;
        text-shadow: 0 0 8px var(--vscode-focusBorder, transparent);
      }
    }

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
    .command-menu.is-readonly .command-control-row,
    .command-menu.is-readonly .command-model-option,
    .command-menu.is-readonly .command-compression-tab {
      cursor: default;
    }

    .command-menu.is-readonly .command-row:hover,
    .command-menu.is-readonly .command-row:focus-visible,
    .command-menu.is-readonly .command-row[aria-expanded="true"],
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

    .command-skill-main:hover:not(:disabled),
    .command-skill-main:focus-visible:not(:disabled) {
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

    .command-skill-status {
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.25;
      text-align: right;
      white-space: nowrap;
    }

    .command-skill-item.is-active .command-skill-status {
      color: var(--vscode-charts-blue, var(--vscode-textLink-foreground));
      font-weight: 600;
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

    .about-details {
      display: grid;
      margin: 0;
      border-top: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
    }

    .about-row {
      display: grid;
      grid-template-columns: minmax(88px, 0.42fr) minmax(0, 1fr);
      align-items: start;
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-input-border, transparent));
    }

    .about-label,
    .about-value {
      min-width: 0;
      font-size: 12px;
      line-height: 1.35;
    }

    .about-label {
      color: var(--vscode-descriptionForeground);
      font-weight: 500;
    }

    .about-value {
      color: var(--vscode-foreground);
      overflow-wrap: anywhere;
      text-align: right;
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
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
      padding: 0 16px 14px;
    }

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
${getNewAccountDialogStyles()}`;
}
