export function getInputTemplate(): string {
  return `
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
              <span id="status" class="composer-status"></span>
            </div>
            <div class="composer-toolbar-right">
              <div id="contextProgress" class="context-progress" role="status" tabindex="0" aria-describedby="contextProgressTooltip" aria-label="背景信息窗口：用量统计">
                <span class="context-progress-ring" aria-hidden="true"></span>
                <span id="contextProgressTooltip" class="context-progress-tooltip" role="tooltip">
                  <span id="contextProgressTitle">背景信息窗口</span>
                  <span id="contextProgressPercent">已用：-</span>
                  <span id="contextProgressTokens">本次 tokens：-</span>
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
          </div>

          <section class="command-section" aria-label="Skills">
            <div class="command-section-label">Skills</div>
            <button
              id="commandSkillsButton"
              type="button"
              class="command-row"
              role="menuitem"
              aria-expanded="false"
            >
              <span class="command-row-main">
                <span class="command-row-title">/skills</span>
                <span class="command-row-description" data-i18n="skillsDescription">选择可复用工作流</span>
              </span>
              <span id="commandSkillsValue" class="command-row-value">0</span>
            </button>
            <div id="commandSkillList" class="command-skill-list hidden" role="group" aria-label="Skills 列表" data-i18n-aria-label="skillsList"></div>
            <button
              id="commandCreateSkillButton"
              type="button"
              class="command-row"
              role="menuitem"
            >
              <span class="command-row-main">
                <span class="command-row-title" data-i18n="createSkill">/create-skill</span>
                <span class="command-row-description" data-i18n="createSkillDescription">通过 DraftEdit 创建 workspace skill</span>
              </span>
            </button>
          </section>

          <section id="commandBackgroundRunSection" class="command-section hidden" aria-label="Background task" data-i18n-aria-label="backgroundRun">
            <div class="command-section-label">Agent</div>
            <button
              id="commandBackgroundRunButton"
              type="button"
              class="command-row"
              role="menuitem"
            >
              <span class="command-row-main">
                <span class="command-row-title">/background-run</span>
                <span class="command-row-description" data-i18n="backgroundCommandDescription">有限轮验证与修复，修改仍需审核</span>
              </span>
              <span id="commandBackgroundRunValue" class="command-row-value"></span>
            </button>
          </section>

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

    <div id="backgroundRunDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog background-run-dialog" role="dialog" aria-modal="true" aria-label="启动后台任务" data-i18n-aria-label="backgroundDialogLabel">
        <div class="settings-dialog-header">
          <span class="settings-dialog-title" data-i18n="backgroundDialogTitle">启动后台任务</span>
        </div>
        <div class="settings-dialog-body">
          <p class="settings-dialog-desc" data-i18n="backgroundDialogDescription">在有限轮次内持续验证并修复；ChangeSet 和授权仍需你确认。</p>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="backgroundScriptLabel">验证方式</span>
            <select id="backgroundScript" class="settings-input" aria-label="验证方式" data-i18n-aria-label="backgroundScriptLabel"></select>
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="backgroundMaxRoundsLabel">最多轮数</span>
            <input id="backgroundMaxRounds" class="settings-input" type="number" min="1" max="10" value="5" inputmode="numeric" autocomplete="off">
            <span class="settings-field-hint" data-i18n="backgroundMaxRoundsHint">达到轮数、时间或工具调用上限后会自动停止。</span>
          </label>
        </div>
        <div class="settings-dialog-footer">
          <button id="backgroundCancel" type="button" class="secondary" data-i18n="cancel">取消</button>
          <button id="backgroundStart" type="button" data-i18n="backgroundStart">启动</button>
        </div>
      </div>
    </div>

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
    </div>

    <div id="aboutDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog" role="dialog" aria-label="关于 KeepSeek" data-i18n-aria-label="aboutDialogLabel">
        <div class="settings-dialog-header">
          <span class="settings-dialog-title" data-i18n="aboutDialogTitle">关于 KeepSeek</span>
        </div>
        <div class="settings-dialog-body">
          <p class="settings-dialog-desc" data-i18n="aboutDialogDesc">KeepSeek 是一款面向 VS Code 的 AI 编程上下文助手，强调显式上下文、文件引用和安全修改草案。</p>
          <div class="about-details">
            <div class="about-row">
              <span class="about-label" data-i18n="aboutProductLabel">产品</span>
              <span id="aboutProductValue" class="about-value">KeepSeek</span>
            </div>
            <div class="about-row">
              <span class="about-label" data-i18n="aboutVersionLabel">版本</span>
              <span id="aboutVersionValue" class="about-value">v0.0.0</span>
            </div>
            <div class="about-row">
              <span class="about-label" data-i18n="aboutAuthorLabel">作者 / 维护者</span>
              <span id="aboutAuthorValue" class="about-value">kmvdata</span>
            </div>
            <div class="about-row">
              <span class="about-label" data-i18n="aboutLicenseLabel">许可证</span>
              <span id="aboutLicenseValue" class="about-value">MIT</span>
            </div>
            <div class="about-row">
              <span class="about-label" data-i18n="aboutRepositoryLabel">源码</span>
              <span id="aboutRepositoryValue" class="about-value">https://github.com/kmvdata/keepseek</span>
            </div>
            <div class="about-row">
              <span class="about-label" data-i18n="aboutCopyrightLabel">版权</span>
              <span id="aboutCopyrightValue" class="about-value">Copyright (c) 2026 kmvdata</span>
            </div>
          </div>
        </div>
        <div class="settings-dialog-footer">
          <button id="aboutCloseBtn" type="button" data-i18n="close">关闭</button>
        </div>
      </div>
    </div>

    <div id="createSkillDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog" role="dialog" aria-label="Create Skill" data-i18n-aria-label="createSkillDialogLabel">
        <div class="settings-dialog-header">
          <span class="settings-dialog-title" data-i18n="createSkillDialogTitle">Create Skill</span>
        </div>
        <div class="settings-dialog-body">
          <p id="createSkillDialogStatus" class="settings-dialog-desc" data-i18n="createSkillDialogDesc">创建 .agents/skills/&lt;name&gt;/SKILL.md 待确认修改。</p>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="createSkillNameLabel">Skill name</span>
            <input id="createSkillNameInput" class="settings-input" type="text" autocomplete="off" />
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="createSkillDescriptionLabel">Description</span>
            <textarea id="createSkillDescriptionInput" class="settings-input settings-textarea" rows="4"></textarea>
          </label>
          <label class="settings-field settings-toggle-field">
            <span class="settings-toggle-copy">
              <span class="settings-field-label" data-i18n="createSkillAllowAutoLabel">Allow Auto</span>
            </span>
            <input id="createSkillAllowImplicitInput" class="settings-toggle-input" type="checkbox" />
            <span class="settings-toggle-track" aria-hidden="true"></span>
          </label>
          <label class="settings-field settings-toggle-field">
            <span class="settings-toggle-copy">
              <span class="settings-field-label" data-i18n="createSkillUserInvocableLabel">User Invocable</span>
            </span>
            <input id="createSkillUserInvocableInput" class="settings-toggle-input" type="checkbox" checked />
            <span class="settings-toggle-track" aria-hidden="true"></span>
          </label>
        </div>
        <div class="settings-dialog-footer">
          <button id="createSkillCancelBtn" type="button" class="secondary" data-i18n="cancel">取消</button>
          <button id="createSkillCreateBtn" type="button" data-i18n="createSkillCreateDraft">Create Draft</button>
        </div>
      </div>
    </div>`;
}
