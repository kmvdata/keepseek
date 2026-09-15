import type { WebviewFragment } from '../../composition';

export const accountSettingsTemplateFragment: WebviewFragment = {
  id: 'template.dialogs.account-settings',
  source: `

    <div id="settingsDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog settings-account-dialog" role="dialog" aria-modal="true" aria-label="KeepSeek 账号管理" data-i18n-aria-label="modelSettingsDialogLabel">
        <div class="settings-dialog-header">
          <span id="settingsDialogTitle" class="settings-dialog-title" data-i18n="modelSettingsDialogTitle">账号管理</span>
        </div>
        <div class="settings-dialog-body">
          <p id="settingsDialogDesc" class="settings-dialog-desc" data-i18n="modelSettingsDialogDesc">添加账号并管理其 API 连接；同一账号的凭证只保存一次。</p>
          <div class="settings-account-workspace">
            <aside class="settings-account-sidebar" aria-labelledby="settingsAccountsTitle">
              <div class="settings-account-section-header">
                <span id="settingsAccountsTitle" class="settings-section-heading" data-i18n="modelsTitle">账号</span>
              </div>
              <div class="settings-account-create-row">
                <button id="settingsCreateAccountBtn" type="button" class="secondary" data-i18n="addAccount">添加账号</button>
              </div>
              <div id="settingsAccountList" class="settings-account-list" role="listbox" aria-label="账号列表" data-i18n-aria-label="modelSourceListLabel"></div>
              <div id="settingsAccountEmpty" class="settings-empty-state hidden" data-i18n="modelSourceListEmpty">暂无账号。点击“添加账号”开始配置。</div>
            </aside>

            <section id="settingsAccountEditor" class="settings-account-editor" aria-labelledby="settingsCurrentAccountTitle">
              <div class="settings-account-editor-header">
                <div>
                  <span id="settingsCurrentAccountTitle" class="settings-section-heading" data-i18n="modelSourceTitle">账号</span>
                  <span id="settingsCurrentProvider" class="settings-account-provider"></span>
                </div>
                <button id="settingsDeleteAccountBtn" type="button" class="secondary settings-danger-button" data-i18n="deleteModelSource">删除账号…</button>
              </div>
              <div id="settingsAccountEditorEmpty" class="settings-empty-state hidden" data-i18n="modelSourceEditorEmpty">选择账号，或添加一个新账号。</div>
              <div id="settingsAccountFields">
                <label class="settings-field">
                  <span id="settingsAccountNameLabel" class="settings-field-label" data-i18n="modelSourceName">账号名称</span>
                  <input id="settingsAccountName" class="settings-input" type="text" autocomplete="off" />
                </label>
                <label class="settings-field">
                  <span class="settings-field-label">Base URL</span>
                  <input id="settingsBaseUrl" class="settings-input" type="text" placeholder="https://api.deepseek.com" autocomplete="off" />
                </label>
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

                <div class="settings-model-section">
                  <div class="settings-account-section-header settings-model-header">
                    <div>
                      <span id="settingsModelsTitle" class="settings-section-heading" data-i18n="modelListTitle">模型</span>
                      <span id="settingsModelsHint" class="settings-field-hint" data-i18n="modelListHint">仅勾选的文本模型会出现在“切换模型”列表中；上下文窗口与最大输出用 K/M tokens 表示，点击数值可修改。图像生成、语音合成资源会保留在清单中，但不适用于文本 Agent。</span>
                    </div>
                    <button id="settingsRefreshModelsBtn" type="button" class="secondary" data-i18n="refreshModels">刷新模型</button>
                    <button id="settingsAddModelBtn" type="button" class="secondary" data-i18n="addModel">添加模型</button>
                  </div>
                  <div id="settingsModelList" class="settings-model-list"></div>
                  <div id="settingsModelEmpty" class="settings-empty-state hidden" data-i18n="modelsEmpty">没有可用模型；非官网来源请手动添加模型 ID。</div>
                  <div class="settings-manual-model hidden">
                    <label class="settings-field settings-manual-model-id">
                      <span id="settingsManualModelIdLabel" class="settings-field-label" data-i18n="manualModelId">模型 ID</span>
                      <input id="settingsManualModelId" class="settings-input" type="text" placeholder="model-id" autocomplete="off" />
                    </label>
                    <label class="settings-field">
                      <span id="settingsManualContextWindowLabel" class="settings-field-label" data-i18n="manualContextWindowTokens">上下文窗口 K tokens（可选）</span>
                      <input id="settingsManualContextWindow" class="settings-input" type="number" min="0.001" max="10000" step="0.001" placeholder="32" autocomplete="off" />
                    </label>
                    <label class="settings-field">
                      <span id="settingsManualMaxOutputLabel" class="settings-field-label" data-i18n="manualMaxOutputTokens">最大输出（可选）</span>
                      <input id="settingsManualMaxOutput" class="settings-input" type="number" min="1" max="1048576" step="1" placeholder="8192" autocomplete="off" />
                    </label>
                    <button id="settingsConfirmAddModelBtn" type="button" class="secondary" data-i18n="confirmAddModel">添加</button>
                  </div>
                </div>
              </div>
            </section>
          </div>
        </div>
        <div class="settings-dialog-footer">
          <div id="settingsDialogStatus" class="settings-dialog-status hidden" role="status" aria-live="polite" tabindex="-1"></div>
          <button id="settingsCancelBtn" type="button" class="secondary" data-i18n="cancel">取消</button>
          <button id="settingsSaveBtn" type="button" data-i18n="save">保存</button>
        </div>
      </div>
    </div>

`.slice(1)
};

