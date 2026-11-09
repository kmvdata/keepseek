import { getInputTemplate } from './input/template';
import type { KeepseekExtensionInfo } from '../shared/types';
import { composeWebviewTemplate } from './template/composition';
import { shellOpenFragment } from './template/header';
import { createSettingsMenuFragment } from './template/settingsMenu';
import { sessionMenuFragment } from './template/sessionMenu';
import { contextBarFragment } from './template/contextBar';
import { backgroundRegionFragment } from './template/backgroundRegion';
import { transcriptOpenFragment, transcriptEmptyFragment } from './template/transcript';
import { planRegionFragment } from './template/planRegion';
import { unlinkedChangeSetFragment } from './template/unlinkedChangeSet';

/** 外壳模板入口；fragment 顺序是 DOM 顺序契约。 */
export function getTemplate(extensionInfo?: Pick<KeepseekExtensionInfo, 'version'>): string {
  const versionLabel = formatVersionLabel(extensionInfo?.version);
  return composeWebviewTemplate([
    shellOpenFragment,
    createSettingsMenuFragment(versionLabel),
    sessionMenuFragment,
    contextBarFragment,
    backgroundRegionFragment,
    transcriptOpenFragment,
    planRegionFragment,
    transcriptEmptyFragment,
    unlinkedChangeSetFragment,
    { id: 'template.input', source: `\n    ${getInputTemplate()}\n  </main>` }
  ]);
}

function formatVersionLabel(version: string | undefined): string {
  const value = typeof version === 'string' ? version.trim() : '';
  return value ? `v${value.replace(/^v/iu, '')}` : '';
}