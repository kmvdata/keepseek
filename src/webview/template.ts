import { getInputTemplate } from './input/template';
import { getProjectTasksTemplate, getProjectTasksOverlayTemplate } from './projectTasks';
import type { KeepseekExtensionInfo } from '../shared/types';
import { DEFAULT_MODEL_REQUEST_TIMEOUT_SECONDS, MODEL_REQUEST_TIMEOUT_PRESETS } from '../shared/config';

export function getTemplate(extensionInfo?: Pick<KeepseekExtensionInfo, 'version'>): string {
  const versionLabel = formatVersionLabel(extensionInfo?.version);
  return `
  <main class="shell">
    <header class="header">
      <span class="header-title" id="currentSessionTitle" title="">新会话</span>
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
      <button id="settingsRecoverDraftMenuItem" type="button" class="command-row settings-menu-row" aria-haspopup="dialog" aria-controls="ordinaryDraftRecoveryMenu">
        <span class="command-row-main">
          <span class="command-row-title" data-i18n="recoverOrdinaryDraft">恢复草稿</span>
          <span class="command-row-description" data-i18n="recoverOrdinaryDraftDescription">手动找回此窗口保存的未发送输入</span>
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
        <span id="settingsAboutVersionValue" class="command-row-value">${escapeHtml(versionLabel)}</span>
      </button>
    </div>

    <div id="sessionMenu" class="session-menu hidden" role="menu" aria-label="Session history" data-i18n-aria-label="sessionHistory"></div>
    <div id="ordinaryDraftRecoveryMenu" class="session-menu hidden" role="dialog" aria-label="恢复草稿" data-i18n-aria-label="recoverOrdinaryDraft">
      <div class="session-menu-title" data-i18n="recoverOrdinaryDraft">恢复草稿</div>
      <div id="ordinaryDraftRecoveryStatus" class="session-menu-empty" role="status"></div>
      <div id="ordinaryDraftRecoveryEntries"></div>
      <div class="session-menu-controls">
        <button id="ordinaryDraftRecoveryPrevious" type="button" class="secondary" data-i18n="recoverDraftPrevious">上一页</button>
        <button id="ordinaryDraftRecoveryNext" type="button" class="secondary" data-i18n="recoverDraftNext">下一页</button>
        <button id="ordinaryDraftRecoveryClose" type="button" class="secondary" data-i18n="cancel">取消</button>
      </div>
    </div>

    <div class="context-bar hidden" id="contextBarOuter">
      <div class="context-bar-inner" id="contextBar"></div>
    </div>

    <section id="backgroundRegion" class="background-region hidden" aria-label="后台任务" data-i18n-aria-label="backgroundRun">
      <div class="background-main">
        <span id="backgroundLabel" class="background-label" data-i18n="backgroundRun">后台任务</span>
        <button id="backgroundDismiss" type="button" class="background-dismiss secondary hidden" data-i18n="backgroundDismiss">收起</button>
      </div>
      <span id="backgroundStatus" class="background-status"></span>
      <div class="background-controls">
        <button id="backgroundResume" type="button" class="hidden" data-i18n="backgroundResume">继续</button>
        <button id="backgroundStop" type="button" class="secondary hidden" data-i18n="backgroundStop">停止</button>
      </div>
    </section>

    <div class="project-workspace">
      ${getProjectTasksTemplate()}
      <div class="project-main">
        <div class="project-view-status">
          <div id="projectOwnerNotice" class="project-owner-notice hidden" role="status"><span id="projectOwnerReason" data-i18n="projectReadOnly">项目执行暂不可用，账号和草稿仍可使用。</span> <button id="projectOwnerCheck" type="button" class="secondary" data-i18n="projectOwnerCheck">检查与恢复</button></div>
          <button id="projectLatestMessages" type="button" class="secondary hidden" data-i18n="projectLatestMessages">最新消息</button>
        </div>
        <div id="historyPreviewNotice" class="project-owner-notice hidden" role="status"><span id="historyPreviewReason"></span> <button id="historyPrepareContinue" type="button" class="secondary" data-i18n="historyPreviewPrepare">准备继续此会话</button></div>
        <div class="project-transcript-stage">
    <section id="transcript" class="transcript">
      <section id="planRegion" class="plan-region hidden" aria-label="计划 / 进度" data-i18n-aria-label="planProgress">
        <button id="planToggle" type="button" class="plan-toggle" aria-expanded="false" aria-controls="planBody">
          <span class="plan-toggle-main">
            <span class="plan-status-dot" aria-hidden="true"></span>
            <span class="plan-toggle-label" data-i18n="planProgress">计划 / 进度</span>
            <span id="planSummary" class="plan-summary"></span>
          </span>
          <span id="planCount" class="plan-count"></span>
          <span class="plan-chevron" aria-hidden="true">⌄</span>
        </button>
        <div id="planBody" class="plan-body hidden">
          <div id="planGoal" class="plan-goal"></div>
          <ol id="planSteps" class="plan-steps"></ol>
          <div id="planBlockers" class="plan-note hidden"></div>
          <div id="planCompletion" class="plan-note hidden"></div>
          <button id="planContinueRepair" type="button" class="plan-continue-repair hidden" data-i18n="continueRepairValidation">继续验证修复</button>
        </div>
      </section>

      <div class="transcript-empty">
        <div class="transcript-empty-icon">&#x2726;</div>
        <div data-i18n="startChat">开始 KeepSeek 对话</div>
        <div style="font-size:11px;opacity:0.6" data-i18n="emptyTranscriptHint">添加上下文文件后，输入消息并发送</div>
      </div>

      <aside id="unlinkedChangeSetRegion" class="draft-bar hidden" aria-labelledby="unlinkedChangeSetLabel">
        <div class="draft-bar-header">
          <div id="unlinkedChangeSetLabel" class="draft-bar-label" data-i18n="unlinkedChangeSets">未关联的待处理修改</div>
        </div>
        <div id="unlinkedChangeSetList" class="draft-bar-list"></div>
      </aside>
    </section>

        ${getProjectTasksOverlayTemplate()}
        </div>
    <div id="projectInputTarget" class="project-input-target hidden" role="status" aria-live="polite"></div>
    ${getInputTemplate()}
      </div>
    </div>
  </main>`;
}

function formatVersionLabel(version: string | undefined): string {
  const value = typeof version === 'string' ? version.trim() : '';
  return value ? `v${value.replace(/^v/iu, '')}` : '';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}
