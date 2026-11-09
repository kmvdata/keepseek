import type { WebviewTemplateFragment } from './composition';

/** 会话历史菜单容器。 */
export const sessionMenuFragment: WebviewTemplateFragment = {
  id: 'template.session-menu',
  source: `
    <div id="sessionMenu" class="session-menu hidden" role="menu" aria-label="Session history" data-i18n-aria-label="sessionHistory"></div>
`
};
