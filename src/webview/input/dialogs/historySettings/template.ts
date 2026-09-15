import type { WebviewFragment } from '../../composition';

export const historySettingsTemplateFragment: WebviewFragment = {
  id: 'template.dialogs.history-settings',
  source: `
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

`.slice(1)
};

