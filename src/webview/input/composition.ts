import * as composerScript from './composer/script';
import * as editorScript from './composer/editor';
import * as serializationScript from './composer/serialization';
import * as referenceMenu from './references/menu';
import * as referenceMention from './references/mention';
import * as referenceChips from './references/chips';
import * as dragDrop from './references/dragDrop';
import * as referenceCodec from './references/codec';
import * as skillsScript from './skills/script';
import * as commandMenuScript from './commandMenu/script';
import * as commandModels from './commandMenu/models';
import * as commandApproval from './commandMenu/approval';
import * as commandAgentSettings from './commandMenu/agentSettings';
import * as commandSkills from './commandMenu/skills';
import * as usageScript from './usage/script';
import * as usageFormatters from './usage/formatters';
import * as accountSettingsScript from './dialogs/accountSettings/script';
import * as accountSettingsRender from './dialogs/accountSettings/render';
import * as historySettingsScript from './dialogs/historySettings/script';
import * as aboutScript from './dialogs/about/script';
import * as createSkillScript from './dialogs/createSkill/script';
import * as goalDialogScript from './dialogs/goal/script';
import * as composerTemplate from './composer/template';
import * as commandMenuTemplate from './commandMenu/template';
import * as referenceTemplate from './references/template';
import * as usageTemplate from './usage/template';
import * as backgroundRunTemplate from './dialogs/backgroundRun/template';
import * as goalDialogTemplate from './dialogs/goal/template';
import * as accountSettingsTemplate from './dialogs/accountSettings/template';
import * as historySettingsTemplate from './dialogs/historySettings/template';
import * as aboutTemplate from './dialogs/about/template';
import * as createSkillTemplate from './dialogs/createSkill/template';
import * as composerStyles from './composer/styles';
import * as editorStyles from './composer/editorStyles';
import * as referenceStyles from './references/styles';
import * as skillStyles from './skills/styles';
import * as commandMenuStyles from './commandMenu/styles';
import * as usageStyles from './usage/styles';
import * as subagentProgressStyles from './usage/subagentProgressStyles';
import * as dialogStyles from './dialogs/sharedStyles';
import * as accountSettingsStyles from './dialogs/accountSettings/styles';
import * as aboutStyles from './dialogs/about/styles';
import * as goalDialogStyles from './dialogs/goal/styles';

export interface WebviewFragment {
  readonly id: string;
  readonly source: string;
}

// These fragments intentionally share one generated IIFE. The fixed order keeps
// the legacy lexical scope, initialization order, and listener registration order.
export const INPUT_SCRIPT_FRAGMENTS = [
  composerScript.composerOpenFragment,
  dragDrop.dragDropDeclarationFragment,
  referenceChips.referenceButtonDeclarationFragment,
  commandMenuScript.commandMenuDeclarationFragment,
  commandModels.modelSelectorsDeclarationFragment,
  commandApproval.approvalDeclarationFragment,
  commandModels.modelStatusDeclarationFragment,
  commandAgentSettings.agentSettingsDeclarationFragment,
  commandSkills.commandSkillsDeclarationFragment,
  usageScript.usageDeclarationFragment,
  referenceMenu.referenceMenuDeclarationFragment,
  skillsScript.skillsDeclarationFragment,
  commandMenuScript.commandMenuStateFragment,
  commandModels.modelControlsStateFragment,
  commandApproval.approvalStateFragment,
  commandSkills.commandSkillsStateFragment,
  referenceMenu.referenceMenuStateFragment,
  commandAgentSettings.agentSettingsStateFragment,
  composerScript.composerIconStateFragment,
  editorScript.editorControllerFragment,
  usageScript.usageBindingsFragment,
  composerScript.composerSubmitBindingsFragment,
  editorScript.editorBindingsFragment,
  referenceMenu.referenceMenuButtonBindingsFragment,
  commandMenuScript.commandMenuTriggerBindingsFragment,
  commandModels.modelSelectorBindingsFragment,
  commandApproval.approvalBindingsFragment,
  commandModels.subagentAndPendingBindingsFragment,
  commandAgentSettings.compressionBindingsFragment,
  commandSkills.commandSkillsBindingsFragment,
  skillsScript.skillsBarBindingsFragment,
  commandAgentSettings.agentEffortBindingFragment,
  referenceMenu.referenceMenuBindingsFragment,
  commandMenuScript.commandMenuDismissBindingFragment,
  referenceMenu.referenceMenuDismissBindingFragment,
  commandMenuScript.commandMenuEscapeBindingFragment,
  editorScript.editorSelectionBindingFragment,
  referenceChips.referenceChipClickBindingFragment,
  editorScript.editorPasteBindingFragment,
  commandMenuScript.commandMenuImplementationFragment,
  referenceMenu.referenceMenuImplementationFragment,
  composerScript.composerRenderFragment,
  usageScript.usageRenderFragment,
  usageFormatters.usageFormattersFragment,
  commandMenuScript.commandMenuRenderFragment,
  commandModels.modelControlsRenderFragment,
  commandApproval.approvalRenderFragment,
  commandModels.modelControlsLockingFragment,
  commandAgentSettings.agentSettingsRenderFragment,
  commandSkills.commandSkillsImplementationFragment,
  commandModels.modelControlsHelpersFragment,
  commandAgentSettings.agentSettingsHelpersFragment,
  referenceMention.referenceMentionFragment,
  editorScript.editorTextRangeFragment,
  dragDrop.dragDropExtractionFragment,
  referenceCodec.referenceCodecFragment,
  referenceChips.referenceChipFactoriesFragment,
  skillsScript.skillsImplementationFragment,
  referenceChips.referenceInsertionFragment,
  editorScript.editorSelectionFragment,
  dragDrop.dragDropAreaFragment,
  serializationScript.composerSerializationFragment,
  referenceChips.referenceLabelRefreshFragment,
  editorScript.editorVisualStateFragment,
  composerScript.composerStatusFragment,
  accountSettingsScript.accountSettingsDeclarationFragment,
  historySettingsScript.historySettingsDeclarationFragment,
  aboutScript.aboutDeclarationFragment,
  createSkillScript.createSkillDeclarationFragment,
  accountSettingsScript.accountSettingsButtonsFragment,
  historySettingsScript.historySettingsButtonsFragment,
  aboutScript.aboutButtonFragment,
  createSkillScript.createSkillButtonsFragment,
  accountSettingsScript.accountSettingsStateFragment,
  historySettingsScript.historySettingsStateFragment,
  accountSettingsScript.accountSettingsHelpersFragment,
  accountSettingsRender.accountSettingsRenderFragment,
  accountSettingsScript.accountSettingsOpenFragment,
  historySettingsScript.historySettingsOpenFragment,
  aboutScript.aboutOpenFragment,
  createSkillScript.createSkillOpenFragment,
  historySettingsScript.dialogIntegerNormalizerFragment,
  accountSettingsScript.accountSettingsCloseFragment,
  historySettingsScript.historySettingsCloseFragment,
  aboutScript.aboutCloseFragment,
  createSkillScript.createSkillImplementationFragment,
  accountSettingsScript.accountSettingsBindingsFragment,
  historySettingsScript.historySettingsSaveBindingFragment,
  createSkillScript.createSkillSubmitBindingFragment,
  accountSettingsScript.accountSettingsCancelBindingFragment,
  historySettingsScript.historySettingsCancelBindingFragment,
  aboutScript.aboutCloseBindingFragment,
  createSkillScript.createSkillBindingsFragment,
  accountSettingsScript.accountSettingsOverlayBindingsFragment,
  historySettingsScript.historySettingsOverlayBindingsFragment,
  aboutScript.aboutOverlayBindingsFragment,
  createSkillScript.createSkillOverlayBindingsFragment,
  goalDialogScript.goalDialogScriptFragment,
  dragDrop.dragDropBindingsFragment,
  referenceChips.referenceHostMessageFragment,
  composerScript.composerPublicApiFragment
] as const satisfies readonly WebviewFragment[];

export const INPUT_STYLE_FRAGMENTS = [
  editorStyles.editorStylesFragment,
  referenceStyles.referenceChipStylesFragment,
  skillStyles.skillChipStylesFragment,
  composerStyles.composerBaseStylesFragment,
  skillStyles.skillsBarStylesFragment,
  composerStyles.composerControlsStylesFragment,
  usageStyles.usageIndicatorStylesFragment,
  composerStyles.composerStatusStylesFragment,
  commandMenuStyles.commandMenuReadonlyStylesFragment,
  referenceStyles.referenceMenuStylesFragment,
  commandMenuStyles.commandMenuStylesFragment,
  usageStyles.usageDialogStylesFragment,
  dialogStyles.dialogChromeStylesFragment,
  subagentProgressStyles.subagentProgressStylesFragment,
  accountSettingsStyles.accountSettingsStatusStylesFragment,
  accountSettingsStyles.accountSettingsStylesFragment,
  aboutStyles.aboutStylesFragment,
  goalDialogStyles.goalDialogStylesFragment,
  dialogStyles.dialogFieldStylesFragment,
  accountSettingsStyles.accountSettingsSecretStylesFragment,
  dialogStyles.dialogFooterStylesFragment,
  accountSettingsStyles.accountSettingsResponsiveStylesFragment
] as const satisfies readonly WebviewFragment[];

export const INPUT_TEMPLATE_FRAGMENTS = [
  composerTemplate.composerTemplateFragment,
  commandMenuTemplate.commandMenuTemplateFragment,
  referenceTemplate.referenceMenuTemplateFragment,
  usageTemplate.usageTemplateFragment,
  backgroundRunTemplate.backgroundRunTemplateFragment,
  goalDialogTemplate.goalDialogTemplateFragment,
  accountSettingsTemplate.accountSettingsTemplateFragment,
  historySettingsTemplate.historySettingsTemplateFragment,
  aboutTemplate.aboutTemplateFragment,
  createSkillTemplate.createSkillTemplateFragment
] as const satisfies readonly WebviewFragment[];

export function composeWebviewFragments(fragments: readonly WebviewFragment[]): string {
  const seen = new Set<string>();
  return fragments.map((fragment) => {
    if (!fragment.id || seen.has(fragment.id)) {
      throw new Error(`Duplicate or empty Webview fragment id: ${fragment.id}`);
    }
    seen.add(fragment.id);
    return fragment.source;
  }).join('');
}
