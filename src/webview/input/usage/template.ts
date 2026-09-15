import type { WebviewFragment } from '../composition';

export const usageTemplateFragment: WebviewFragment = {
  id: 'template.usage',
  source: `

    <dialog id="usageDetailsDialog" class="usage-details-dialog" aria-labelledby="usageDetailsTitle" aria-describedby="usageDetailsDescription">
      <div class="usage-details-header">
        <div>
          <h2 id="usageDetailsTitle" data-i18n="usageDetailsTitle">用量详情</h2>
          <p id="usageDetailsDescription" data-i18n="usageDetailsDescription">分别查看 Provider 实际用量与本地上下文估算。</p>
        </div>
        <button id="usageDetailsClose" type="button" class="secondary" data-i18n="close">关闭</button>
      </div>
      <div id="usageDetailsBody" class="usage-details-body" tabindex="0"></div>
    </dialog>
`.slice(1)
};

