import type { WebviewTemplateFragment } from './composition';

/** 未关联 ChangeSet 区域，并闭合对话区。 */
export const unlinkedChangeSetFragment: WebviewTemplateFragment = {
  id: 'template.unlinked-change-set',
  source: `
      <aside id="unlinkedChangeSetRegion" class="draft-bar hidden" aria-labelledby="unlinkedChangeSetLabel">
        <div class="draft-bar-header">
          <div id="unlinkedChangeSetLabel" class="draft-bar-label" data-i18n="unlinkedChangeSets">未关联的待处理修改</div>
        </div>
        <div id="unlinkedChangeSetList" class="draft-bar-list"></div>
      </aside>
    </section>
`
};