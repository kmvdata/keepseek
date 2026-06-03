export function getInputTemplate(): string {
  return `
    <form id="composer" class="composer">
      <div class="composer-input-wrap">
        <div class="composer-input-inner">
          <div
            id="promptInput"
            class="rich-input is-empty"
            contenteditable="true"
            role="textbox"
            aria-multiline="true"
            data-placeholder="描述要构建的内容"
            data-i18n-placeholder="promptPlaceholder"
          ></div>
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
                title="显示命令菜单 /"
                aria-label="显示命令菜单"
                data-i18n-title="showCommandMenuTitle"
                data-i18n-aria-label="showCommandMenu"
                aria-haspopup="menu"
                aria-expanded="false"
              >
                <span class="composer-trigger-glyph command-trigger-glyph" aria-hidden="true">/</span>
              </button>
              <span id="status" class="composer-status"></span>
            </div>
            <div class="composer-toolbar-right">
              <div id="contextProgress" class="context-progress" role="status" tabindex="0" aria-describedby="contextProgressTooltip" aria-label="背景信息窗口（当前会话上下文估算）：0% 已使用（剩余 100%）。已估算 0 标记，共 1M">
                <span class="context-progress-ring" aria-hidden="true"></span>
                <span id="contextProgressTooltip" class="context-progress-tooltip" role="tooltip">
                  <span id="contextProgressTitle">背景信息窗口（当前会话上下文估算）：</span>
                  <span id="contextProgressPercent">0% 已使用（剩余 100%）</span>
                  <span id="contextProgressTokens">已估算 0 标记，共 1M</span>
                  <span id="contextProgressBreakdown" class="context-progress-breakdown"></span>
                </span>
              </div>
              <button id="sendButton" type="submit" class="composer-send-btn" title="发送" aria-label="发送" data-i18n-title="send" data-i18n-aria-label="send" disabled>
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 12.75V3.75M4.75 7 8 3.75 11.25 7" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </div>
        </div>
        <div id="commandMenu" class="command-menu hidden" role="menu" aria-label="命令菜单" data-i18n-aria-label="commandMenu">
          <div class="command-menu-header">
            <span class="command-menu-title" data-i18n="commandMenu">命令菜单</span>
            <span class="command-menu-shortcut">/</span>
          </div>

          <section class="command-section" aria-label="Model">
            <div class="command-section-label">Model</div>
            <button
              id="commandModelSwitch"
              type="button"
              class="command-row"
              role="menuitem"
              aria-expanded="false"
            >
              <span class="command-row-main">
                <span class="command-row-title" data-i18n="switchModel">Switch model...</span>
                <span class="command-row-description" data-i18n="switchModelDescription">切换 AI 模型</span>
              </span>
              <span id="commandModelValue" class="command-row-value">DeepSeek-V4-Flash</span>
            </button>
            <div id="commandModelList" class="command-model-list hidden" role="group" aria-label="模型列表" data-i18n-aria-label="modelList"></div>
          </section>

          <section class="command-section" aria-label="Reasoning">
            <label class="command-control-row" for="commandEffortSlider">
              <span class="command-row-main">
                <span class="command-row-title">Effort (<span id="commandEffortValue">High</span>)</span>
                <span class="command-row-description" data-i18n="effortDescription">调整生成内容的深度 / 复杂度</span>
              </span>
              <input
                id="commandEffortSlider"
                class="command-effort-slider"
                type="range"
                min="1"
                max="2"
                step="1"
                value="1"
                aria-label="Effort"
              />
            </label>

            <label class="command-control-row command-toggle-row">
              <span class="command-row-main">
                <span class="command-row-title">Thinking</span>
                <span class="command-row-description" data-i18n="thinkingDescription">提升复杂问题的推理质量</span>
              </span>
              <input id="commandThinkingToggle" class="command-toggle-input" type="checkbox" checked aria-label="Thinking" />
              <span class="command-toggle-track" aria-hidden="true"></span>
            </label>
          </section>
        </div>
        <div id="referenceMenu" class="reference-menu hidden" role="listbox" aria-label="引用工程文件" data-i18n-aria-label="referenceWorkspaceFiles"></div>
      </div>
    </form>

    <div id="settingsDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog" role="dialog" aria-label="KeepSeek 设置" data-i18n-aria-label="apiDialogLabel">
        <div class="settings-dialog-header">
          <span class="settings-dialog-title" data-i18n="apiDialogTitle">API Key</span>
        </div>
        <div class="settings-dialog-body">
          <p class="settings-dialog-desc" data-i18n="apiDialogDesc">配置 DeepSeek API Key 和 Base URL。</p>
          <div class="settings-field">
            <label class="settings-field-label" for="settingsApiKey">API Key</label>
            <div class="settings-secret-input">
              <input id="settingsApiKey" class="settings-input" type="password" placeholder="sk-..." autocomplete="off" />
              <button
                id="settingsApiKeyVisibilityBtn"
                class="settings-secret-toggle"
                type="button"
                aria-label="显示 API Key"
                aria-pressed="false"
                title="显示 API Key"
                data-i18n-title="showApiKey"
                data-i18n-aria-label="showApiKey"
              >
                <svg class="settings-secret-icon settings-secret-icon-show" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M1.75 8s2.25-4 6.25-4 6.25 4 6.25 4-2.25 4-6.25 4S1.75 8 1.75 8Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
                  <circle cx="8" cy="8" r="1.75" fill="none" stroke="currentColor" stroke-width="1.3"/>
                </svg>
                <svg class="settings-secret-icon settings-secret-icon-hide" width="15" height="15" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M2.25 2.25l11.5 11.5" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
                  <path d="M6.55 4.28A6.7 6.7 0 0 1 8 4c4 0 6.25 4 6.25 4a10.7 10.7 0 0 1-1.67 2.08M9.42 11.82A6.7 6.7 0 0 1 8 12c-4 0-6.25-4-6.25-4a10.2 10.2 0 0 1 2.8-3.01" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </div>
          <label class="settings-field">
            <span class="settings-field-label">Base URL</span>
            <input id="settingsBaseUrl" class="settings-input" type="text" placeholder="https://api.deepseek.com" autocomplete="off" />
          </label>
        </div>
        <div class="settings-dialog-footer">
          <button id="settingsClearApiKeyBtn" type="button" class="secondary settings-clear-api-key" data-i18n="clearApiKey">清空</button>
          <button id="settingsCancelBtn" type="button" class="secondary" data-i18n="cancel">取消</button>
          <button id="settingsSaveBtn" type="button" data-i18n="save">保存</button>
        </div>
      </div>
    </div>

    <div id="agentBudgetDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog" role="dialog" aria-label="Agent 执行预算" data-i18n-aria-label="agentBudgetDialogLabel">
        <div class="settings-dialog-header">
          <span class="settings-dialog-title" data-i18n="agentBudgetDialogTitle">Agent 执行预算</span>
        </div>
        <div class="settings-dialog-body">
          <p class="settings-dialog-desc" data-i18n="agentBudgetDialogDesc">控制 Agent 输出、工具调用和运行时资源上限。</p>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="settingsMaxTokensLabel">最大输出（KB）</span>
            <input id="agentBudgetMaxTokens" class="settings-input" type="number" min="0" max="384" step="1" inputmode="numeric" autocomplete="off" />
            <span class="settings-field-hint" data-i18n="settingsMaxTokensHint">按 1 KB = 1000 tokens 换算；0 表示使用服务商默认值</span>
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="settingsMaxToolIterationsLabel">最大工具轮次</span>
            <input id="agentBudgetMaxToolIterations" class="settings-input" type="number" min="0" max="64" step="1" inputmode="numeric" autocomplete="off" />
            <span class="settings-field-hint" data-i18n="settingsMaxToolIterationsHint">默认 8；0 表示禁用工具</span>
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="settingsMaxToolCallsLabel">最大工具调用数</span>
            <input id="agentBudgetMaxToolCalls" class="settings-input" type="number" min="0" max="256" step="1" inputmode="numeric" autocomplete="off" />
            <span class="settings-field-hint" data-i18n="settingsMaxToolCallsHint">默认 24；0 表示不启用单独调用数上限</span>
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="settingsMaxRunSecondsLabel">最大运行时间（秒）</span>
            <input id="agentBudgetMaxRunSeconds" class="settings-input" type="number" min="0" max="3600" step="30" inputmode="numeric" autocomplete="off" />
            <span class="settings-field-hint" data-i18n="settingsMaxRunSecondsHint">默认 600 秒（10 分钟）；0 表示不启用总时长上限</span>
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="settingsStreamIdleSecondsLabel">流式空闲超时（秒）</span>
            <input id="agentBudgetStreamIdleSeconds" class="settings-input" type="number" min="0" max="3600" step="30" inputmode="numeric" autocomplete="off" />
            <span class="settings-field-hint" data-i18n="settingsStreamIdleSecondsHint">默认 0，不因 thinking 阶段长时间无数据而主动中断</span>
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="settingsToolResultTokenBudgetLabel">工具结果预算（KB）</span>
            <input id="agentBudgetToolResultTokenBudget" class="settings-input" type="number" min="0" max="1000" step="10" inputmode="numeric" autocomplete="off" />
            <span class="settings-field-hint" data-i18n="settingsToolResultTokenBudgetHint">按 1 KB = 1000 tokens 换算；默认 0，按模型上下文窗口自动估算</span>
          </label>
          <div class="settings-section-title" data-i18n="settingsContextCompressionTitle">上下文压缩</div>
          <label class="settings-field settings-toggle-field">
            <span class="settings-toggle-copy">
              <span class="settings-field-label" data-i18n="settingsContextCompressionEnabledLabel">启用上下文压缩</span>
              <span class="settings-field-hint" data-i18n="settingsContextCompressionEnabledHint">默认开启；关闭后使用旧的最近消息窗口</span>
            </span>
            <input id="agentBudgetContextCompressionEnabled" class="settings-toggle-input" type="checkbox" />
            <span class="settings-toggle-track" aria-hidden="true"></span>
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="settingsContextKeepRecentTurnsLabel">原文保留最近用户轮次</span>
            <input id="agentBudgetContextKeepRecentTurns" class="settings-input" type="number" min="1" max="64" step="1" inputmode="numeric" autocomplete="off" />
            <span class="settings-field-hint" data-i18n="settingsContextKeepRecentTurnsHint">默认 12；这些最近轮次及其 assistant 回复不会进入摘要</span>
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="settingsContextCompressionTriggerPercentLabel">无摘要触发比例（%）</span>
            <input id="agentBudgetContextCompressionTriggerPercent" class="settings-input" type="number" min="10" max="95" step="5" inputmode="decimal" autocomplete="off" />
            <span class="settings-field-hint" data-i18n="settingsContextCompressionTriggerPercentHint">默认 70%；原始对话估算达到上下文窗口该比例时可刷新摘要</span>
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="settingsContextSummaryBudgetLabel">摘要输出预算（KB）</span>
            <input id="agentBudgetContextSummaryBudget" class="settings-input" type="number" min="0.5" max="100" step="0.5" inputmode="decimal" autocomplete="off" />
            <span class="settings-field-hint" data-i18n="settingsContextSummaryBudgetHint">按 1 KB = 1000 tokens 换算；默认 3 KB</span>
          </label>
        </div>
        <div class="settings-dialog-footer">
          <button id="agentBudgetCancelBtn" type="button" class="secondary" data-i18n="cancel">取消</button>
          <button id="agentBudgetSaveBtn" type="button" data-i18n="save">保存</button>
        </div>
      </div>
    </div>

    <div id="historySettingsDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog" role="dialog" aria-label="历史会话设置" data-i18n-aria-label="historySettingsDialogLabel">
        <div class="settings-dialog-header">
          <span class="settings-dialog-title" data-i18n="historySettingsDialogTitle">历史会话</span>
        </div>
        <div class="settings-dialog-body">
          <p class="settings-dialog-desc" data-i18n="historySettingsDialogDesc">设置历史菜单的默认显示范围；会话按最后更新时间全局最多保留 60 天。</p>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="settingsHistoryRetentionDaysLabel">历史菜单默认显示天数</span>
            <input id="historyRetentionDaysInput" class="settings-input" type="number" min="1" max="60" step="1" inputmode="numeric" autocomplete="off" />
            <span class="settings-field-hint" data-i18n="settingsHistoryRetentionDaysHint">1～60 天；只影响菜单默认范围，历史会话仍按 60 天硬上限清理</span>
          </label>
        </div>
        <div class="settings-dialog-footer">
          <button id="historySettingsCancelBtn" type="button" class="secondary" data-i18n="cancel">取消</button>
          <button id="historySettingsSaveBtn" type="button" data-i18n="save">保存</button>
        </div>
      </div>
    </div>`;
}
