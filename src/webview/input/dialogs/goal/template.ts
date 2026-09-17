import type { WebviewFragment } from '../../composition';

export const goalDialogTemplateFragment: WebviewFragment = {
  id: 'template.dialogs.goal',
  source: `
    <div id="goalDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog goal-dialog" role="dialog" aria-modal="true" aria-labelledby="goalDialogTitle">
        <div class="settings-dialog-header"><span id="goalDialogTitle" class="settings-dialog-title" data-i18n="goalCreateTitle">创建持久 Goal</span></div>
        <div id="goalCreatePane" class="settings-dialog-body">
          <p class="settings-dialog-desc" data-i18n="goalCreateDescription">KeepSeek 会用已配置的子代理模型从输入目标生成必填项；确认后才会开始 Goal。</p>
          <div id="goalDraftGenerationStatus" class="goal-generation-status hidden" role="status" aria-live="polite"><span id="goalDraftGenerationText"></span><button id="goalCancelGeneration" type="button" class="secondary" data-i18n="goalCancelGeneration">取消生成</button></div>
          <label class="settings-field"><span class="settings-field-label" data-i18n="goalObjective">目标</span><textarea id="goalObjective" class="settings-input settings-textarea" maxlength="20000"></textarea></label>
          <div class="goal-generate-row"><span class="settings-dialog-desc" data-i18n="goalGeneratedHint">验收条件、证据要求、范围和验证项可由子代理模型自动生成。</span><button id="goalGenerateDraft" type="button" class="secondary" data-i18n="goalRegenerate">重新生成</button></div>
          <div class="goal-proposal-toolbar"><span id="goalProposalSelectionSummary" class="settings-field-label" aria-live="polite"></span><div><button id="goalSelectAll" type="button" class="secondary" data-i18n="goalSelectAll">全选</button><button id="goalSelectNone" type="button" class="secondary" data-i18n="goalSelectNone">取消全选</button></div></div>
          <div id="goalProposalWorkItems" class="goal-proposal-work-items" role="group" aria-labelledby="goalProposalSelectionSummary"></div>
          <div id="goalProposalLive" class="sr-only" role="status" aria-live="polite"></div>
          <div id="goalApprovalModeNotice" class="goal-approval-mode-notice"></div>
          <label class="settings-field hidden"><span class="settings-field-label" data-i18n="goalCriteria">验收条件（每行一项）</span><textarea id="goalCriteria" class="settings-input settings-textarea"></textarea></label>
          <div id="goalGeneratedCriteria" class="goal-generated-criteria hidden"></div>
          <fieldset class="goal-validations"><legend data-i18n="goalValidations">Required validations</legend><label><input id="goalValidationCompile" type="checkbox"> compile</label><label><input id="goalValidationLint" type="checkbox"> lint</label><label><input id="goalValidationTest" type="checkbox"> test</label></fieldset>
          <details class="goal-advanced">
            <summary data-i18n="goalAdvancedSettings">高级设置：证据回退、范围、预算与恢复</summary>
            <div class="goal-advanced-body">
              <label class="settings-field"><span class="settings-field-label" data-i18n="goalCriterionType">新增或已编辑条件的证据类型</span><select id="goalCriterionType" class="settings-input"><option value="workspace_state" data-i18n="goalCriterionWorkspaceState">工作区状态（workspace_state）</option><option value="validation" data-i18n="goalCriterionValidation">验证结果（validation）</option><option value="artifact" data-i18n="goalCriterionArtifact">产物（artifact）</option><option value="manual" data-i18n="goalCriterionManual">人工确认（manual）</option></select></label>
              <label class="settings-field"><span class="settings-field-label" data-i18n="goalEvidence">新增或已编辑条件的证据要求</span><input id="goalEvidence" class="settings-input" type="text"></label>
              <label class="settings-field"><span class="settings-field-label" data-i18n="goalIncludeScope">Include 范围（工作区相对路径，每行一项）</span><textarea id="goalIncludeScope" class="settings-input settings-textarea"></textarea></label>
              <label class="settings-field"><span class="settings-field-label" data-i18n="goalExcludeScope">Exclude 范围（工作区相对路径，每行一项）</span><textarea id="goalExcludeScope" class="settings-input settings-textarea"></textarea></label>
              <div class="goal-budget-grid">
                <label class="settings-field"><span class="settings-field-label" data-i18n="goalActiveBudget">有效执行 ms</span><input id="goalMaxActiveExecution" class="settings-input" type="number" min="0"></label>
                <label class="settings-field"><span class="settings-field-label" data-i18n="goalCostBudget">费用/币种</span><input id="goalMaxCost" class="settings-input" type="number" min="0" step="any"></label>
                <label class="settings-field"><span class="settings-field-label" data-i18n="goalRequestBudget">模型请求数</span><input id="goalMaxRequests" class="settings-input" type="number" min="0"></label>
                <label class="settings-field"><span class="settings-field-label" data-i18n="goalReviewBudget">完成审查数</span><input id="goalMaxReviews" class="settings-input" type="number" min="0"></label>
              </div>
              <label class="settings-field"><span class="settings-field-label" data-i18n="goalResumePolicy">恢复策略</span><select id="goalResumePolicy" class="settings-input"><option value="manual">manual</option><option value="auto_on_activation">auto_on_activation</option></select></label>
              <div class="goal-warning" data-i18n="goalUnlimitedWarning">任一预算为 0 表示不限额；点击“开始 Goal”即明确确认这些上限。</div>
              <div class="goal-message-preview"><span data-i18n="goalVisibleMessage">将创建的可见消息</span><code id="goalVisibleMessage"></code></div>
              <p id="goalLifecycleNotice" class="goal-lifecycle-notice"></p>
            </div>
          </details>
          <div id="goalDialogError" class="goal-warning hidden"></div>
        </div>
        <div id="goalManagePane" class="settings-dialog-body goal-manage-pane hidden">
          <div class="goal-manage-summary">
            <div class="goal-manage-heading"><strong id="goalManageObjective"></strong><span id="goalManageStatus" class="goal-status-pill"></span></div>
            <div id="goalManageMeta" class="goal-manage-meta"></div>
            <div id="goalManageReason" class="goal-manage-reason hidden"></div>
          </div>
          <div class="goal-manage-section">
            <span class="settings-field-label" data-i18n="goalWorkItemsProgress">工作项</span>
            <ol id="goalManageWorkItems" class="goal-manage-work-items"></ol>
          </div>
          <div class="goal-manage-section">
            <span class="settings-field-label" data-i18n="goalCriteriaProgress">验收条件</span>
            <ol id="goalManageCriteria" class="goal-manage-criteria"></ol>
          </div>
          <div class="goal-manage-section">
            <span class="settings-field-label" data-i18n="goalTraceLogs">Goal 调试日志</span>
            <div class="goal-trace-toolbar"><button id="goalToggleDebug" type="button" class="secondary" data-i18n="goalEnableDebug">为后续 attempt 开启调试</button></div>
            <ol id="goalManageTraces" class="goal-manage-traces"></ol>
            <div id="goalTraceEmpty" class="settings-dialog-desc" data-i18n="goalTraceEmpty">当前 Goal 还没有可查看的日志。</div>
          </div>
          <div class="goal-manage-section">
            <span class="settings-field-label" data-i18n="goalValidationProgress">必需验证</span>
            <ul id="goalManageValidations" class="goal-manage-validations"></ul>
          </div>
          <div class="goal-manage-section">
            <span class="settings-field-label" data-i18n="goalActions">Goal 操作</span>
            <div class="goal-manage-controls">
              <button id="goalPause" type="button" class="secondary" data-i18n="goalPause">暂停</button>
              <button id="goalResume" type="button" data-i18n="goalResume">恢复 Goal</button>
              <button id="goalStop" type="button" class="secondary" data-i18n="goalStop">停止</button>
              <button id="goalClear" type="button" class="secondary" data-i18n="goalClear">清理</button>
            </div>
          </div>
          <div id="goalAmendRow" class="goal-amend-row"><input id="goalAmendInput" type="text" maxlength="20000" data-i18n-placeholder="goalAmendPlaceholder" placeholder="追加修订（不重写原目标）"><button id="goalAmend" type="button" class="secondary" data-i18n="goalAmend">修订</button></div>
        </div>
        <div class="settings-dialog-footer">
          <button id="goalCancel" type="button" class="secondary" data-i18n="goalDiscardProposal">放弃提案</button>
          <button id="goalClose" type="button" class="secondary hidden" data-i18n="close">关闭</button>
          <button id="goalStart" type="button" data-i18n="goalAdoptSelected">采纳所选项并开始</button>
        </div>
      </div>
    </div>
`.slice(1)
};
