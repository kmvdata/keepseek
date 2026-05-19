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
              <button type="button" class="composer-icon-btn" title="添加上下文" aria-label="添加上下文">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 3.25v9.5M3.25 8h9.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
                </svg>
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
                <span class="command-trigger-glyph" aria-hidden="true">/</span>
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
              <span id="commandModelValue" class="command-row-value">Default (recommended)</span>
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
                max="5"
                step="1"
                value="3"
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
      </div>
    </form>`;
}
