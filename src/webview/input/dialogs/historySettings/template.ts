import type { WebviewFragment } from '../../composition';

export const historySettingsTemplateFragment: WebviewFragment = {
  id: 'template.dialogs.history-settings',
  source: `
    <div id="historySettingsDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog" role="dialog" aria-modal="true" aria-label="历史会话设置" data-i18n-aria-label="historySettingsDialogLabel">
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
          <button id="historySettingsSaveBtn" type="button" data-i18n="save">保存</button>
          <p id="historySettingsSaveStatus" class="settings-field-hint" role="status" aria-live="polite" aria-atomic="true"></p>
          <section class="history-cleanup-section" aria-labelledby="historyCleanupHeading">
            <h3 id="historyCleanupHeading" class="settings-section-title" data-i18n="historyCleanupTitle">清理历史会话</h3>
            <p class="settings-dialog-desc" data-i18n="historyCleanupDescription">手动清理包含收藏会话；使用中的会话会保留。清理前还需确认。</p>
            <div id="historyCleanupForm">
              <label class="settings-field" for="historyCleanupScope">
                <span class="settings-field-label" data-i18n="historyCleanupScopeLabel">清理范围</span>
                <select id="historyCleanupScope" class="settings-input">
                  <option value="current" data-i18n="historyCleanupScopeCurrent">当前项目</option>
                  <option value="all" data-i18n="historyCleanupScopeAll">全部项目</option>
                </select>
              </label>
              <label class="settings-field" for="historyCleanupMode">
                <span class="settings-field-label" data-i18n="historyCleanupModeLabel">清理方式</span>
                <select id="historyCleanupMode" class="settings-input">
                  <option value="olderThan" data-i18n="historyCleanupModeOlder">清理超过指定天数的会话</option>
                  <option value="all" data-i18n="historyCleanupModeAll">全部清除（不限时间）</option>
                </select>
              </label>
              <label id="historyCleanupDaysField" class="settings-field" for="historyCleanupDays">
                <span class="settings-field-label" data-i18n="historyCleanupDaysLabel">距最后更新的天数</span>
                <select id="historyCleanupDays" class="settings-input">
                  <option value="1">1</option><option value="2">2</option><option value="3" selected>3</option>
                  <option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="7">7</option>
                </select>
              </label>
            </div>
            <div id="historyCleanupSummary" class="history-cleanup-summary" role="status" aria-live="polite" aria-atomic="true"></div>
            <p class="settings-field-hint" data-i18n="historyCleanupWarning">会话及其专属运行记录不可恢复，相关回滚历史将不可用；已修改的项目文件不会回滚。</p>
            <div class="history-cleanup-actions">
              <button id="historyCleanupRetryBtn" class="secondary hidden" type="button" data-i18n="historyCleanupRetry">重新预览</button>
              <button id="historyCleanupAgainBtn" class="secondary hidden" type="button" data-i18n="historyCleanupAgain">再次清理</button>
              <button id="historyCleanupSubmitBtn" type="button" disabled data-i18n="historyCleanupAction">清理…</button>
            </div>
          </section>
        </div>
        <div class="settings-dialog-footer">
          <button id="historySettingsCancelBtn" type="button" class="secondary" data-i18n="close">关闭</button>
        </div>
      </div>
    </div>

`.slice(1)
};

