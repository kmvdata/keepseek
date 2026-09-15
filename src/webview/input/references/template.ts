import type { WebviewFragment } from '../composition';

export const referenceMenuTemplateFragment: WebviewFragment = {
  id: 'template.references.menu',
  source: `
        <div id="referenceMenu" class="reference-menu hidden" role="listbox" aria-label="引用工程文件" data-i18n-aria-label="referenceWorkspaceFiles"></div>
      </div>
    </form>
`.slice(1)
};
