import type { WebviewTemplateFragment } from './composition';

/** 后台任务条容器。 */
export const backgroundRegionFragment: WebviewTemplateFragment = {
  id: 'template.background-region',
  source: `
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
`
};
