import { DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS, MODEL_REQUEST_TIMEOUT_PRESETS } from '../../shared/config';
import { escapeTemplateHtml, type WebviewTemplateFragment } from './composition';

/** 设置菜单：含请求超时选项与版本号两处插值。 */
export function createSettingsMenuFragment(versionLabel: string): WebviewTemplateFragment {
  return {
    id: 'template.settings-menu',
    source: `
    <div id="settingsMenu" class="settings-menu hidden" role="dialog" aria-label="设置" data-i18n-aria-label="settingsMenuTitle">
      <div class="settings-menu-header">
        <span class="settings-menu-title" data-i18n="settingsMenuTitle">设置</span>
      </div>
      <button id="settingsApiKeyMenuItem" type="button" class="command-row settings-menu-row">
        <span class="command-row-main">
          <span class="command-row-title" data-i18n="settingsApiKeyTitle">API Key</span>
          <span class="command-row-description" data-i18n="settingsApiKeyDescription">API Key 和 Base URL</span>
        </span>
      </button>
      <div id="settingsRequestTimeoutMenuItem" class="command-row settings-menu-row">
        <label for="settingsRequestTimeoutValue" class="command-row-main">
          <span class="command-row-title" data-i18n="settingsRequestTimeoutTitle">模型请求超时</span>
          <span class="command-row-description" data-i18n="settingsRequestTimeoutDescription">所有账号和模型共用</span>
        </label>
        <select id="settingsRequestTimeoutValue" class="settings-timeout-select">
          ${MODEL_REQUEST_TIMEOUT_PRESETS.map((preset) => `<option value="${preset.seconds}" data-i18n="${preset.labelKey}"${preset.seconds === DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS ? ' selected' : ''}>${preset.label}</option>`).join('\n          ')}
        </select>
      </div>
      <button id="settingsHistoryMenuItem" type="button" class="command-row settings-menu-row">
        <span class="command-row-main">
          <span class="command-row-title" data-i18n="settingsHistoryMenuTitle">历史会话</span>
          <span class="command-row-description" data-i18n="settingsHistoryMenuDescription">默认显示范围与 60 天清理</span>
        </span>
      </button>
      <div class="settings-debug-item">
        <button id="settingsDebugMenuItem" type="button" class="command-row settings-menu-row" aria-haspopup="menu" aria-expanded="false">
          <span class="command-row-main">
            <span class="command-row-title" data-i18n="settingsDebugModeTitle">调试模式</span>
            <span class="command-row-description" data-i18n="settingsDebugModeDescription">记录请求、流式响应和工具循环日志</span>
          </span>
          <span id="settingsDebugValue" class="command-row-value">关闭</span>
        </button>
        <div id="settingsDebugSubmenu" class="settings-submenu settings-debug-submenu" role="menu" aria-label="调试模式" data-i18n-aria-label="settingsDebugModeTitle">
          <button id="settingsDebugModeToggle" type="button" class="settings-submenu-item" role="menuitemcheckbox" aria-checked="false">
            <span class="settings-submenu-check" aria-hidden="true"></span>
            <span data-i18n="settingsDebugModeToggle">调试模式</span>
          </button>
          <button id="settingsOpenLogMenuItem" type="button" class="settings-submenu-item" role="menuitem">
            <span class="settings-submenu-icon" aria-hidden="true"></span>
            <span data-i18n="openCurrentSessionLog">打开当前会话日志</span>
          </button>
        </div>
      </div>
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
      <button id="settingsAboutMenuItem" type="button" class="command-row settings-menu-row settings-about-menu-row">
        <span class="command-row-main">
          <span class="command-row-title" data-i18n="settingsAboutTitle">关于</span>
          <span class="command-row-description" data-i18n="settingsAboutDescription">版本、作者和许可证</span>
        </span>
        <span id="settingsAboutVersionValue" class="command-row-value">${escapeTemplateHtml(versionLabel)}</span>
      </button>
    </div>
`
  };
}