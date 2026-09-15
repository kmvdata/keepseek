import type { WebviewFragment } from '../../composition';

export const backgroundRunTemplateFragment: WebviewFragment = {
  id: 'template.dialogs.background-run',
  source: `

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
`.slice(1)
};

