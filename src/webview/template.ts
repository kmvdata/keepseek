export function getTemplate(): string {
  return `
  <main class="shell">
    <header class="header">
      <span class="header-title">KeepSeek</span>
      <div class="header-actions">
        <button type="button" class="header-tab" id="historyTab" title="Session history">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </button>
        <button type="button" class="header-tab" id="newChatTab" title="New session">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="8" x2="12" y2="14"/>
            <line x1="9" y1="11" x2="15" y2="11"/>
          </svg>
        </button>
      </div>
    </header>

    <div class="context-bar" id="contextBarOuter">
      <div class="context-bar-inner" id="contextBar"></div>
    </div>

    <div id="draftRegion" class="draft-bar hidden">
      <div class="draft-bar-label">待确认修改</div>
      <div id="draftList" class="draft-bar-list"></div>
    </div>

    <section id="transcript" class="transcript">
      <div class="transcript-empty">
        <div class="transcript-empty-icon">&#x2726;</div>
        <div>开始 KeepSeek 对话</div>
        <div style="font-size:11px;opacity:0.6">添加上下文文件后，输入消息并发送</div>
      </div>
    </section>

    <form id="composer" class="composer">
      <div class="composer-input-wrap">
        <div class="composer-input-inner">
          <div
            id="promptInput"
            class="rich-input is-empty"
            contenteditable="true"
            role="textbox"
            aria-multiline="true"
            data-placeholder="输入消息"
          ></div>
        </div>
      </div>
      <div class="composer-footer">
        <div style="display:flex;gap:8px;align-items:center;">
          <span class="composer-shortcut">Ctrl+Enter 发送</span>
          <span id="status"></span>
        </div>
        <button id="sendButton" type="submit" class="composer-send-btn">发送</button>
      </div>
    </form>
  </main>`;
}
