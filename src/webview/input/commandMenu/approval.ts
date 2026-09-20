import type { WebviewFragment } from '../composition';

export const approvalDeclarationFragment: WebviewFragment = {
  id: 'command-menu.approval.declaration',
  source: `
      var commandApprovalModeSwitch = document.getElementById('commandApprovalModeSwitch');
      var commandApprovalModeValue = document.getElementById('commandApprovalModeValue');
      var commandApprovalModeList = document.getElementById('commandApprovalModeList');
      var commandApprovalModeDescription = document.getElementById('commandApprovalModeDescription');
`.slice(1)
};

export const approvalStateFragment: WebviewFragment = {
  id: 'command-menu.approval.state',
  source: `
      var commandApprovalModeListOpen = false;
`.slice(1)
};

export const approvalBindingsFragment: WebviewFragment = {
  id: 'command-menu.approval.bindings',
  source: `
        commandApprovalModeSwitch.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (isApprovalModeSelectionLocked()) {
            setComposerStatus(getApprovalModeLockText());
            return;
          }
          commandApprovalModeListOpen = !commandApprovalModeListOpen;
          if (commandApprovalModeListOpen) {
            commandModelListOpen = false;
            commandSubagentModelListOpen = false;
            commandSkillListOpen = false;
          }
          renderCommandMenu();
        });
      }

      if (commandApprovalModeList) {
        commandApprovalModeList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var button = target?.closest('button[data-approval-mode]');
          if (!button || button.disabled) { return; }
          event.preventDefault();
          event.stopPropagation();
          var mode = button.dataset.approvalMode === 'delegate'
            ? 'delegate'
            : button.dataset.approvalMode === 'model_review' ? 'model_review' : 'ask';
          vscode.postMessage({ type: 'setApprovalMode', mode: mode });
          commandApprovalModeListOpen = false;
          renderCommandMenu();
        });
      }

      if (commandSubagentModelList) {
`.slice(1)
};

export const approvalRenderFragment: WebviewFragment = {
  id: 'command-menu.approval.render',
  source: `
      function renderCommandApprovalMode() {
        var currentMode = state.approvalMode === 'delegate'
          ? 'delegate'
          : state.approvalMode === 'model_review' ? 'model_review' : 'ask';
        var readiness = getCommandSettingReadiness('approvalMode');
        var readinessText = readiness === 'error' ? t('approvalModeLoadFailed')
          : readiness === 'loading' ? t('approvalModeRestoring') : '';
        var locked = isApprovalModeSelectionLocked();
        var lockText = readinessText || (locked ? t('modelSettingsReadonlyWhileBusy') : '');
        var currentLabelKey = getApprovalModeLabelKey(currentMode);
        var currentDescriptionKey = getApprovalModeDescriptionKey(currentMode);

        if (commandApprovalModeValue) {
          commandApprovalModeValue.textContent = t(currentLabelKey);
          commandApprovalModeValue.title = t(currentLabelKey);
        }
        if (commandApprovalModeSwitch) {
          commandApprovalModeSwitch.disabled = locked;
          commandApprovalModeSwitch.title = lockText || t(currentDescriptionKey);
          commandApprovalModeSwitch.setAttribute('aria-disabled', locked ? 'true' : 'false');
          commandApprovalModeSwitch.setAttribute('aria-busy', readiness === 'loading' ? 'true' : 'false');
          commandApprovalModeSwitch.setAttribute('aria-expanded', commandApprovalModeListOpen ? 'true' : 'false');
        }
        if (commandApprovalModeDescription) {
          commandApprovalModeDescription.textContent = lockText
            ? lockText
            : t(currentDescriptionKey);
        }
        if (!commandApprovalModeList) { return; }

        commandApprovalModeList.classList.toggle('hidden', !commandApprovalModeListOpen);
        commandApprovalModeList.innerHTML = '';
        [
          { mode: 'ask', labelKey: 'approvalAsk', descriptionKey: 'approvalAskDescription' },
          { mode: 'model_review', labelKey: 'approvalModelReview', descriptionKey: 'approvalModelReviewDescription' },
          { mode: 'delegate', labelKey: 'approvalDelegate', descriptionKey: 'approvalDelegateDescription' }
        ].forEach(function(item) {
          var isSelected = item.mode === currentMode;
          var option = document.createElement('button');
          option.type = 'button';
          option.className = 'command-model-option';
          option.dataset.approvalMode = item.mode;
          option.disabled = locked || (item.mode !== 'ask' && Boolean(state.isBusy));
          option.setAttribute('role', 'menuitemradio');
          option.setAttribute('aria-checked', isSelected ? 'true' : 'false');
          option.setAttribute('aria-label', t(item.labelKey));
          option.title = lockText || t(item.descriptionKey);

          var check = document.createElement('span');
          check.className = 'command-model-check';
          check.textContent = isSelected ? '\\u2713' : '';
          var label = document.createElement('span');
          label.className = 'command-model-name';
          label.textContent = t(item.labelKey);
          var description = document.createElement('span');
          description.className = 'command-approval-option-description';
          description.textContent = t(item.descriptionKey);
          var copy = document.createElement('span');
          copy.className = 'command-approval-option-copy';
          copy.append(label, description);
          option.title = lockText || t(item.descriptionKey);
          option.setAttribute('aria-label', t(item.labelKey) + '. ' + t(item.descriptionKey));
          option.append(check, copy);
          commandApprovalModeList.append(option);
        });
      }

      function getApprovalModeLabelKey(mode) {
        return mode === 'delegate' ? 'approvalDelegate' : mode === 'model_review' ? 'approvalModelReview' : 'approvalAsk';
      }

      function getApprovalModeDescriptionKey(mode) {
        return mode === 'delegate'
          ? 'approvalDelegateDescription'
          : mode === 'model_review' ? 'approvalModelReviewDescription' : 'approvalAskDescription';
      }

`.slice(1)
};
