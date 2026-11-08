import type { WebviewFragment } from '../../input/composition';

/** Owner-notice status strip and composer target label owned by the project view. */
export const viewStatusStylesFragment: WebviewFragment = {
  id: 'sidebar-view-status-styles',
  source: `    .project-view-status { flex: 0 0 auto; display: flex; align-items: center; gap: 5px; font-size: 11px; }
    .project-view-status:has(> .hidden):not(:has(> :not(.hidden))) { display: none; }
    .project-owner-notice { flex: 1; color: var(--vscode-inputValidation-warningForeground, var(--vscode-descriptionForeground)); padding: 3px 6px; }
    .project-view-status button { font-size: 11px; padding: 2px 6px; }
    .project-input-target { flex: 0 0 auto; font-size: 11px; padding: 3px 6px; overflow-wrap: anywhere; color: var(--vscode-descriptionForeground); }
`
};
