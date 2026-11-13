import type { WebviewTemplateFragment } from './composition';

/** 上下文 chip 工具条容器。 */
export const contextBarFragment: WebviewTemplateFragment = {
  id: 'template.context-bar',
  source: `
    <div class="context-bar hidden" id="contextBarOuter">
      <div class="context-bar-inner" id="contextBar"></div>
    </div>
`
};
