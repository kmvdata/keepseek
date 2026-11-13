import type { WebviewTemplateFragment } from './composition';

/** 任务计划与进度区域模板。 */
export const planRegionFragment: WebviewTemplateFragment = {
  id: 'template.plan-region',
  source: `      <section id="planRegion" class="plan-region hidden" aria-label="计划 / 进度" data-i18n-aria-label="planProgress">
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
`
};