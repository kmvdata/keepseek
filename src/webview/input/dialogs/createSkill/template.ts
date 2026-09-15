import type { WebviewFragment } from '../../composition';

export const createSkillTemplateFragment: WebviewFragment = {
  id: 'template.dialogs.create-skill',
  source: `
    <div id="createSkillDialogOverlay" class="settings-overlay hidden">
      <div class="settings-dialog" role="dialog" aria-label="Create Skill" data-i18n-aria-label="createSkillDialogLabel">
        <div class="settings-dialog-header">
          <span class="settings-dialog-title" data-i18n="createSkillDialogTitle">Create Skill</span>
        </div>
        <div class="settings-dialog-body">
          <p id="createSkillDialogStatus" class="settings-dialog-desc" data-i18n="createSkillDialogDesc">创建 .agents/skills/&lt;name&gt;/SKILL.md 待确认修改。</p>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="createSkillNameLabel">Skill name</span>
            <input id="createSkillNameInput" class="settings-input" type="text" autocomplete="off" />
          </label>
          <label class="settings-field">
            <span class="settings-field-label" data-i18n="createSkillDescriptionLabel">Description</span>
            <textarea id="createSkillDescriptionInput" class="settings-input settings-textarea" rows="4"></textarea>
          </label>
          <label class="settings-field settings-toggle-field">
            <span class="settings-toggle-copy">
              <span class="settings-field-label" data-i18n="createSkillAllowAutoLabel">Allow Auto</span>
            </span>
            <input id="createSkillAllowImplicitInput" class="settings-toggle-input" type="checkbox" />
            <span class="settings-toggle-track" aria-hidden="true"></span>
          </label>
          <label class="settings-field settings-toggle-field">
            <span class="settings-toggle-copy">
              <span class="settings-field-label" data-i18n="createSkillUserInvocableLabel">User Invocable</span>
            </span>
            <input id="createSkillUserInvocableInput" class="settings-toggle-input" type="checkbox" checked />
            <span class="settings-toggle-track" aria-hidden="true"></span>
          </label>
        </div>
        <div class="settings-dialog-footer">
          <button id="createSkillCancelBtn" type="button" class="secondary" data-i18n="cancel">取消</button>
          <button id="createSkillCreateBtn" type="button" data-i18n="createSkillCreateDraft">Create Draft</button>
        </div>
      </div>
    </div>
`.slice(1)
};

