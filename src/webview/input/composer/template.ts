import type { WebviewFragment } from '../composition';

export const composerTemplateFragment: WebviewFragment = {
  id: 'template.composer',
  source: `
    <form id="composer" class="composer">
      <div class="composer-input-wrap">
        <div class="composer-input-inner">
          <div id="skillsBar" class="skills-bar hidden" aria-label="Using skills">
            <span class="skills-bar-label" data-i18n="skillsUsing">Using:</span>
            <span id="skillsBarList" class="skills-bar-list"></span>
          </div>
          <div
            id="promptInput"
            class="rich-input is-empty"
            contenteditable="true"
            role="textbox"
            aria-multiline="true"
            data-placeholder="描述要构建的内容"
            data-i18n-placeholder="promptPlaceholder"
          ></div>
          <div id="composerModelStatus" class="composer-model-selection-status hidden" role="status" aria-live="polite">
            <span id="composerModelStatusText"></span>
            <button id="composerModelCancelPending" type="button" class="command-model-cancel" data-i18n="cancelPendingModel">取消待切换</button>
          </div>
          <div class="composer-toolbar" aria-label="Chat input toolbar" data-i18n-aria-label="chatInputToolbar">
            <div class="composer-toolbar-left">
              <button
                id="referenceMenuButton"
                type="button"
                class="composer-icon-btn composer-reference-btn"
                title="引用文件 @"
                aria-label="引用文件"
                data-i18n-title="referenceFileTitle"
                data-i18n-aria-label="referenceFile"
                aria-haspopup="listbox"
                aria-expanded="false"
              >
                <span class="composer-trigger-glyph" aria-hidden="true">+</span>
              </button>
              <button
                id="commandMenuButton"
                type="button"
                class="composer-icon-btn composer-command-btn"
                title="显示命令菜单"
                aria-label="显示命令菜单"
                data-i18n-title="showCommandMenuTitle"
                data-i18n-aria-label="showCommandMenu"
                aria-haspopup="menu"
                aria-expanded="false"
              >
                <span class="composer-trigger-glyph command-trigger-glyph" aria-hidden="true">/</span>
              </button>
              <span class="composer-execution-mode-control">
                <button
                  id="executionModeButton"
                  type="button"
                  class="composer-icon-btn composer-execution-mode-btn"
                  aria-label="执行方式：常规。边分析边推进，适合明确的日常任务"
                  aria-describedby="executionModeTooltip"
                  aria-haspopup="menu"
                  aria-controls="executionModeMenu"
                  aria-expanded="false"
                >
                  <span id="executionModeButtonLabel" aria-hidden="true">N</span>
                </button>
                <span id="executionModeTooltip" class="execution-mode-tooltip" role="tooltip">
                  <span id="executionModeTooltipTitle" class="execution-mode-tooltip-title">执行方式：常规</span>
                  <span id="executionModeTooltipDescription" class="execution-mode-tooltip-description">边分析边推进，适合明确的日常任务</span>
                </span>
                <span id="executionModeMenu" class="execution-mode-menu hidden" role="menu" aria-label="执行方式" data-i18n-aria-label="executionMode">
                  <button type="button" class="execution-mode-option" role="menuitemradio" data-execution-mode="normal" aria-checked="true">
                    <span class="execution-mode-option-check" aria-hidden="true">✓</span>
                    <span class="execution-mode-option-copy">
                      <span class="execution-mode-option-label" data-i18n="executionNormal">常规</span>
                      <span class="execution-mode-option-description" data-i18n="executionNormalDescription">边分析边推进，适合明确的日常任务</span>
                    </span>
                  </button>
                  <button type="button" class="execution-mode-option" role="menuitemradio" data-execution-mode="plan" aria-checked="false">
                    <span class="execution-mode-option-check" aria-hidden="true"></span>
                    <span class="execution-mode-option-copy">
                      <span class="execution-mode-option-label" data-i18n="executionPlan">计划</span>
                      <span class="execution-mode-option-description" data-i18n="executionPlanDescription">先产出实施计划，用户确认后再开始执行</span>
                    </span>
                  </button>
                </span>
              </span>
              <span id="status" class="composer-status" aria-describedby="statusTooltip">
                <span id="statusText" class="composer-status-text"></span>
                <span id="statusTooltip" class="composer-status-tooltip hidden" role="tooltip"></span>
              </span>
            </div>
            <div class="composer-toolbar-right">
              <button id="contextProgress" type="button" class="context-progress" aria-describedby="contextProgressTooltip" aria-label="用量统计" data-i18n-aria-label="usageStatsTitle" aria-haspopup="dialog" aria-controls="usageDetailsDialog" aria-expanded="false">
                <span class="context-progress-ring" aria-hidden="true"></span>
                <span id="contextProgressTooltip" class="context-progress-tooltip" role="tooltip">
                  <span id="contextProgressTitle">背景信息窗口</span>
                  <span id="contextProgressPercent">已用：-</span>
                  <span id="contextProgressTokens">本次 tokens：-</span>
                  <span id="contextProgressBreakdown" class="context-progress-breakdown"></span>
                </span>
              </button>
              <button id="sendButton" type="submit" class="composer-send-btn" title="发送" aria-label="发送" data-i18n-title="send" data-i18n-aria-label="send" disabled>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 12.75V3.75M4.75 7 8 3.75 11.25 7" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
`.slice(1)
};
