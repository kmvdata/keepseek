import { getInputTemplate } from './input/template';

export function getTemplate(): string {
  return `
  <main class="shell">
    <header class="header">
      <span class="header-title">KeepSeek</span>
      <div class="header-actions">
        <button type="button" class="header-tab" id="settingsTab" title="设置" aria-label="设置" aria-haspopup="dialog" aria-expanded="false" data-i18n-title="settings" data-i18n-aria-label="settings">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.05a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.05A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.05a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.05A1.7 1.7 0 0 0 19.4 15Z"/>
          </svg>
        </button>
        <button type="button" class="header-tab" id="historyTab" title="Session history" aria-label="Session history" aria-haspopup="menu" aria-expanded="false" data-i18n-title="sessionHistory" data-i18n-aria-label="sessionHistory">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="12 6 12 12 16 14"/>
          </svg>
        </button>
        <button type="button" class="header-tab" id="newChatTab" title="New session" aria-label="New session" data-i18n-title="newSession" data-i18n-aria-label="newSession">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
            <line x1="12" y1="8" x2="12" y2="14"/>
            <line x1="9" y1="11" x2="15" y2="11"/>
          </svg>
        </button>
      </div>
    </header>

    <div id="settingsMenu" class="settings-menu hidden" role="dialog" aria-label="设置" data-i18n-aria-label="settingsMenuTitle">
      <div class="settings-menu-header">
        <span class="settings-menu-title" data-i18n="settingsMenuTitle">设置</span>
      </div>
      <button id="settingsApiKeyMenuItem" type="button" class="command-row settings-menu-row">
        <span class="command-row-main">
          <span class="command-row-title" data-i18n="settingsApiKeyTitle">Api Key</span>
          <span class="command-row-description" data-i18n="settingsApiKeyDescription">账户 API key 设置</span>
        </span>
      </button>
      <div class="settings-language-item">
        <button id="settingsLanguageMenuItem" type="button" class="command-row settings-menu-row" aria-haspopup="menu" aria-expanded="false">
          <span class="command-row-main">
            <span class="command-row-title" data-i18n="settingsLanguageTitle">语言</span>
            <span class="command-row-description" data-i18n="settingsLanguageDescription">界面说明和提示语言</span>
          </span>
          <span id="settingsLanguageValue" class="command-row-value">中文</span>
        </button>
        <div id="settingsLanguageSubmenu" class="settings-submenu" role="menu" aria-label="语言" data-i18n-aria-label="settingsLanguageTitle">
          <button type="button" class="settings-submenu-item" role="menuitemradio" data-language="zh-CN" aria-checked="true">
            <span class="settings-submenu-check" aria-hidden="true"></span>
            <span data-i18n="languageChinese">中文</span>
          </button>
          <button type="button" class="settings-submenu-item" role="menuitemradio" data-language="en" aria-checked="false">
            <span class="settings-submenu-check" aria-hidden="true"></span>
            <span data-i18n="languageEnglish">English</span>
          </button>
        </div>
      </div>
    </div>

    <div id="sessionMenu" class="session-menu hidden" role="menu" aria-label="Session history" data-i18n-aria-label="sessionHistory"></div>

    <div class="context-bar hidden" id="contextBarOuter">
      <div class="context-bar-inner" id="contextBar"></div>
    </div>

    <section id="transcript" class="transcript">
      <div class="transcript-empty">
        <div class="transcript-empty-icon">&#x2726;</div>
        <div data-i18n="startChat">开始 KeepSeek 对话</div>
        <div style="font-size:11px;opacity:0.6" data-i18n="emptyTranscriptHint">添加上下文文件后，输入消息并发送</div>
      </div>
    </section>

    <div id="draftRegion" class="draft-bar hidden">
      <div class="draft-bar-label" data-i18n="pendingEdits">待确认修改</div>
      <div id="draftList" class="draft-bar-list"></div>
    </div>

    ${getInputTemplate()}
  </main>`;
}
