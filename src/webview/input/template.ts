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
          ></div>
          <div class="composer-toolbar" aria-label="Chat input toolbar">
            <div class="composer-toolbar-left">
              <button
                id="referenceMenuButton"
                type="button"
                class="composer-icon-btn composer-reference-btn"
                title="引用文件 @"
                aria-label="引用文件"
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
                aria-haspopup="menu"
                aria-expanded="false"
              >
                <span class="composer-trigger-glyph command-trigger-glyph" aria-hidden="true">/</span>
              </button>
              <span id="status" class="composer-status"></span>
            </div>
            <button id="sendButton" type="submit" class="composer-send-btn" title="发送" aria-label="发送" disabled>
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 12.75V3.75M4.75 7 8 3.75 11.25 7" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </button>
          </div>
        </div>
        <div id="commandMenu" class="command-menu hidden" role="menu" aria-label="命令菜单">
          <div class="command-menu-header">
            <span class="command-menu-title">命令菜单</span>
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
                <span class="command-row-title">Switch model...</span>
                <span class="command-row-description">切换 AI 模型</span>
              </span>
              <span id="commandModelValue" class="command-row-value">DeepSeek-V4-Flash</span>
            </button>
            <div id="commandModelList" class="command-model-list hidden" role="group" aria-label="模型列表"></div>
          </section>

          <section class="command-section" aria-label="Reasoning">
            <label class="command-control-row" for="commandEffortSlider">
              <span class="command-row-main">
                <span class="command-row-title">Effort (<span id="commandEffortValue">High</span>)</span>
                <span class="command-row-description">调整生成内容的深度 / 复杂度</span>
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
                <span class="command-row-description">提升复杂问题的推理质量</span>
              </span>
              <input id="commandThinkingToggle" class="command-toggle-input" type="checkbox" checked aria-label="Thinking" />
              <span class="command-toggle-track" aria-hidden="true"></span>
            </label>
          </section>

          <section class="command-section" aria-label="Account">
            <button id="commandApiKeyButton" type="button" class="command-row" role="menuitem">
              <span class="command-row-main">
                <span class="command-row-title">Api Key</span>
                <span class="command-row-description">账户 API key 设置</span>
              </span>
            </button>
          </section>
        </div>
        <div id="referenceMenu" class="reference-menu hidden" role="listbox" aria-label="引用工程文件"></div>
      </div>
    </form>

    <div id="settingsDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog" role="dialog" aria-label="DeepSeek API 设置">
        <div class="settings-dialog-header">
          <span class="settings-dialog-title">DeepSeek API 设置</span>
        </div>
        <div class="settings-dialog-body">
          <p class="settings-dialog-desc">请输入 DeepSeek 官方申请的 API Key。</p>
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
          <button id="settingsCancelBtn" type="button" class="secondary">取消</button>
          <button id="settingsSaveBtn" type="button">保存</button>
        </div>
      </div>
    </div>`;
}
