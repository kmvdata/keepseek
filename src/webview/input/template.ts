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
              <button type="button" class="composer-icon-btn" title="附加文件" aria-label="附加文件">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M6.2 9.8 9.8 6.2a1.9 1.9 0 0 1 2.69 2.69l-4.6 4.6a3.15 3.15 0 0 1-4.46-4.46l4.95-4.95a2.55 2.55 0 0 1 3.61 0" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <span class="composer-toolbar-separator" aria-hidden="true"></span>
              <button type="button" class="composer-mode-btn" title="模式" aria-label="模式">
                <span>Auto</span>
              </button>
              <button type="button" class="composer-icon-btn" title="工具" aria-label="工具">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M3 4.5h10M3 11.5h10M6 2.75v3.5M10 9.75v3.5" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/>
                  <circle cx="6" cy="4.5" r="1.35" fill="none" stroke="currentColor" stroke-width="1.1"/>
                  <circle cx="10" cy="11.5" r="1.35" fill="none" stroke="currentColor" stroke-width="1.1"/>
                </svg>
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
      </div>
    </form>`;
}
