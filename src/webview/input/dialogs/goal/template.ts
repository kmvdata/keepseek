import type { WebviewFragment } from '../../composition';

export const goalDialogTemplateFragment: WebviewFragment = {
  id: 'template.dialogs.goal',
  source: `
    <div id="goalDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog goal-dialog" role="dialog" aria-modal="true" aria-labelledby="goalDialogTitle">
        <div class="settings-dialog-header"><span id="goalDialogTitle" class="settings-dialog-title" data-i18n="goalCreateTitle">创建持久 Goal</span></div>
        <div class="settings-dialog-body">
          <p class="settings-dialog-desc" data-i18n="goalCreateDescription">确认范围、停止条件和预算后才会开始；开始前不会创建消息或请求模型。</p>
          <label class="settings-field"><span class="settings-field-label" data-i18n="goalObjective">目标</span><textarea id="goalObjective" class="settings-input settings-textarea" maxlength="20000"></textarea></label>
          <label class="settings-field"><span class="settings-field-label" data-i18n="goalCriteria">验收条件（每行一项）</span><textarea id="goalCriteria" class="settings-input settings-textarea"></textarea></label>
          <label class="settings-field"><span class="settings-field-label" data-i18n="goalCriterionType">验收证据类型</span><select id="goalCriterionType" class="settings-input"><option value="workspace_state">workspace_state</option><option value="validation">validation</option><option value="artifact">artifact</option><option value="manual">manual</option></select></label>
          <label class="settings-field"><span class="settings-field-label" data-i18n="goalEvidence">证据要求</span><input id="goalEvidence" class="settings-input" type="text"></label>
          <label class="settings-field"><span class="settings-field-label" data-i18n="goalIncludeScope">Include 范围（工作区相对路径，每行一项）</span><textarea id="goalIncludeScope" class="settings-input settings-textarea"></textarea></label>
          <label class="settings-field"><span class="settings-field-label" data-i18n="goalExcludeScope">Exclude 范围（工作区相对路径，每行一项）</span><textarea id="goalExcludeScope" class="settings-input settings-textarea"></textarea></label>
          <fieldset class="goal-validations"><legend data-i18n="goalValidations">Required validations</legend><label><input id="goalValidationCompile" type="checkbox"> compile</label><label><input id="goalValidationLint" type="checkbox"> lint</label><label><input id="goalValidationTest" type="checkbox"> test</label></fieldset>
          <div class="goal-budget-grid">
            <label class="settings-field"><span class="settings-field-label" data-i18n="goalActiveBudget">有效执行 ms</span><input id="goalMaxActiveExecution" class="settings-input" type="number" min="0"></label>
            <label class="settings-field"><span class="settings-field-label" data-i18n="goalCostBudget">费用/币种</span><input id="goalMaxCost" class="settings-input" type="number" min="0" step="any"></label>
            <label class="settings-field"><span class="settings-field-label" data-i18n="goalRequestBudget">模型请求数</span><input id="goalMaxRequests" class="settings-input" type="number" min="0"></label>
            <label class="settings-field"><span class="settings-field-label" data-i18n="goalReviewBudget">完成审查数</span><input id="goalMaxReviews" class="settings-input" type="number" min="0"></label>
          </div>
          <label class="settings-field"><span class="settings-field-label" data-i18n="goalResumePolicy">恢复策略</span><select id="goalResumePolicy" class="settings-input"><option value="manual">manual</option><option value="auto_on_activation">auto_on_activation</option></select></label>
          <div class="goal-warning" data-i18n="goalUnlimitedWarning">任一预算为 0 表示不限额；点击“开始 Goal”即明确确认这些上限。</div>
          <div class="goal-command-preview"><span data-i18n="goalVisibleMessage">将创建的可见消息</span><code id="goalVisibleCommand"></code></div>
          <p id="goalLifecycleNotice" class="goal-lifecycle-notice"></p><div id="goalDialogError" class="goal-warning hidden"></div>
        </div>
        <div class="settings-dialog-footer"><button id="goalCancel" type="button" class="secondary" data-i18n="cancel">取消</button><button id="goalStart" type="button" data-i18n="goalStart">开始 Goal</button></div>
      </div>
    </div>
`.slice(1)
};
