import type { WebviewFragment } from '../../composition';

export const createSkillDeclarationFragment: WebviewFragment = {
  id: 'dialogs.create-skill.declaration',
  source: `
      var createSkillOverlay = document.getElementById('createSkillDialogOverlay');
      var createSkillDialogStatus = document.getElementById('createSkillDialogStatus');
      var createSkillNameInput = document.getElementById('createSkillNameInput');
      var createSkillDescriptionInput = document.getElementById('createSkillDescriptionInput');
      var createSkillAllowImplicitInput = document.getElementById('createSkillAllowImplicitInput');
      var createSkillUserInvocableInput = document.getElementById('createSkillUserInvocableInput');
`.slice(1)
};

export const createSkillButtonsFragment: WebviewFragment = {
  id: 'dialogs.create-skill.buttons',
  source: `
      var createSkillCreateBtn = document.getElementById('createSkillCreateBtn');
      var createSkillCancelBtn = document.getElementById('createSkillCancelBtn');
`.slice(1)
};

export const createSkillOpenFragment: WebviewFragment = {
  id: 'dialogs.create-skill.open',
  source: `
      function showCreateSkillDialog() {
        var disabledReason = getCreateSkillDisabledReason();
        if (disabledReason) {
          setComposerStatus(disabledReason);
          return;
        }
        if (!createSkillOverlay) { return; }
        if (createSkillNameInput) {
          createSkillNameInput.value = '';
        }
        if (createSkillDescriptionInput) {
          createSkillDescriptionInput.value = '';
        }
        if (createSkillAllowImplicitInput) {
          createSkillAllowImplicitInput.checked = false;
        }
        if (createSkillUserInvocableInput) {
          createSkillUserInvocableInput.checked = true;
        }
        setCreateSkillDialogStatus(t('createSkillDialogDesc'));
        createSkillOverlay.classList.remove('hidden');
        if (createSkillNameInput) {
          createSkillNameInput.focus();
        }
      }

      function setCreateSkillDialogStatus(message) {
        if (createSkillDialogStatus) {
          createSkillDialogStatus.textContent = message || t('createSkillDialogDesc');
        }
      }

`.slice(1)
};

export const createSkillImplementationFragment: WebviewFragment = {
  id: 'dialogs.create-skill.implementation',
  source: `
      function hideCreateSkillDialog(shouldFocusPrompt) {
        if (!createSkillOverlay) { return; }
        createSkillOverlay.classList.add('hidden');
        if (shouldFocusPrompt !== false) {
          promptInput.focus();
        }
      }

      function submitCreateSkillDraft() {
        if (state.isBusy) {
          setCreateSkillDialogStatus(t('commandMenuReadonlyWhileBusy'));
          return;
        }
        var disabledReason = getCreateSkillDisabledReason();
        if (disabledReason) {
          setCreateSkillDialogStatus(disabledReason);
          setComposerStatus(disabledReason);
          return;
        }
        var name = createSkillNameInput ? createSkillNameInput.value.trim() : '';
        var description = createSkillDescriptionInput ? createSkillDescriptionInput.value.trim() : '';
        if (!name) {
          setCreateSkillDialogStatus(t('createSkillNameRequired'));
          if (createSkillNameInput) { createSkillNameInput.focus(); }
          return;
        }
        if (/[\\\\x00-\\\\x1f\\\\x7f]/u.test(name) || name.indexOf('..') >= 0 || name.indexOf('/') >= 0 || name.indexOf('\\\\\\\\') >= 0) {
          setCreateSkillDialogStatus(t('createSkillNameInvalid'));
          if (createSkillNameInput) { createSkillNameInput.focus(); }
          return;
        }
        var normalizedName = name.replace(/\\\\s+/gu, '-').replace(/-+/gu, '-').toLowerCase();
        if (!/^[a-z0-9_-]+$/u.test(normalizedName) || !/[a-z0-9]/u.test(normalizedName)) {
          setCreateSkillDialogStatus(t('createSkillNameInvalid'));
          if (createSkillNameInput) { createSkillNameInput.focus(); }
          return;
        }
        if (!description) {
          setCreateSkillDialogStatus(t('createSkillDescriptionRequired'));
          if (createSkillDescriptionInput) { createSkillDescriptionInput.focus(); }
          return;
        }
        vscode.postMessage({
          type: 'createSkillDraft',
          name: name,
          description: description,
          allowImplicit: createSkillAllowImplicitInput ? createSkillAllowImplicitInput.checked : false,
          userInvocable: createSkillUserInvocableInput ? createSkillUserInvocableInput.checked : true
        });
        setCreateSkillDialogStatus(t('createSkillDraftRequested'));
        setComposerStatus(t('createSkillDraftRequested'));
      }

      function onSkillDraftCreated(message) {
        var label = message && typeof message.label === 'string' ? message.label : '';
        hideCreateSkillDialog();
        setComposerStatus(t('createSkillDraftCreatedStatus', { label: label }));
      }
`.slice(1)
};

export const createSkillSubmitBindingFragment: WebviewFragment = {
  id: 'dialogs.create-skill.submit-binding',
  source: `
      if (createSkillCreateBtn) {
        createSkillCreateBtn.addEventListener('click', function() {
          submitCreateSkillDraft();
        });
      }

`.slice(1)
};

export const createSkillBindingsFragment: WebviewFragment = {
  id: 'dialogs.create-skill.bindings',
  source: `
      if (createSkillCancelBtn) {
        createSkillCancelBtn.addEventListener('click', function() {
          hideCreateSkillDialog();
        });
      }

      [createSkillNameInput, createSkillDescriptionInput].forEach(function(input) {
        if (!input) { return; }
        input.addEventListener('input', function() {
          setCreateSkillDialogStatus(t('createSkillDialogDesc'));
        });
      });

`.slice(1)
};

export const createSkillOverlayBindingsFragment: WebviewFragment = {
  id: 'dialogs.create-skill.overlay-bindings',
  source: `
      if (createSkillOverlay) {
        createSkillOverlay.addEventListener('click', function(event) {
          if (event.target === createSkillOverlay) {
            hideCreateSkillDialog();
          }
        });

        createSkillOverlay.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            hideCreateSkillDialog();
          } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submitCreateSkillDraft();
          }
        });
      }

`.slice(1)
};

