import type { WebviewFragment } from '../../composition';

export const accountSettingsRenderFragment: WebviewFragment = {
  id: 'dialogs.account-settings.render',
  source: `
      function populateSettingsAccount(account) {
        if (settingsAccountName) {
          settingsAccountName.value = account ? account.name : '';
        }
        if (settingsApiKey) {
          settingsApiKey.value = account ? account.apiKey : '';
        }
        if (settingsBaseUrl) {
          settingsBaseUrl.value = account
            ? account.baseUrl || getSettingsDefaultBaseUrl(account.provider)
            : 'https://api.deepseek.com';
        }
        if (settingsManualModelId) { settingsManualModelId.value = ''; }
        if (settingsManualContextWindow) { settingsManualContextWindow.value = ''; }
        if (settingsManualMaxOutput) { settingsManualMaxOutput.value = ''; }
        if (settingsManualModelBox) { settingsManualModelBox.classList.add('hidden'); }
        settingsOriginalFormSignature = getSettingsFormSignature();
        settingsDialogDirty = false;
      }

      function renderSettingsAccountList(controlsDisabled) {
        if (!settingsAccountList) { return; }
        settingsAccountList.innerHTML = '';
        settingsSources.forEach(function(account) {
          var button = document.createElement('button');
          var selected = account.id === settingsSelectedSourceId;
          var providerLabel = getSettingsProviderLabel(account.provider);
          button.type = 'button';
          button.className = 'settings-account-item';
          button.dataset.sourceId = account.id;
          button.setAttribute('role', 'option');
          button.setAttribute('aria-selected', selected ? 'true' : 'false');
          button.setAttribute('aria-label', account.name + ', ' + providerLabel);
          button.disabled = controlsDisabled || !account.enabled;
          button.title = account.name + ' · ' + providerLabel;
          var identity = document.createElement('span');
          identity.className = 'settings-account-item-identity';
          var logoBox = document.createElement('span');
          logoBox.className = 'settings-account-item-logo-box';
          logoBox.setAttribute('aria-hidden', 'true');
          var logoUri = getSettingsProviderLogoUri(account.provider);
          if (logoUri) {
            var logo = document.createElement('img');
            logo.className = 'settings-account-item-logo';
            logo.dataset.provider = account.provider;
            logo.src = logoUri;
            logo.alt = '';
            logo.draggable = false;
            logoBox.append(logo);
          }
          var name = document.createElement('span');
          name.className = 'settings-account-item-name';
          name.textContent = account.name + (account.enabled ? '' : ' (' + t('modelSourceDisabled') + ')');
          identity.append(logoBox, name);
          var check = document.createElement('span');
          check.className = 'settings-account-item-check';
          check.setAttribute('aria-hidden', 'true');
          check.textContent = selected ? '\\u2713' : '';
          button.append(identity, check);
          settingsAccountList.append(button);
        });
      }

      function renderSettingsModelContextEditor(container, model) {
        container.innerHTML = '';
        container.classList.add('is-editing');
        var input = document.createElement('input');
        input.type = 'number';
        input.className = 'settings-model-context-input';
        input.min = '0.004';
        input.max = '10000';
        input.step = '0.001';
        input.value = getEditableContextWindowKTokens(model.contextWindowTokens);
        input.setAttribute('aria-label', t('editContextWindowKTokens', { modelId: model.id }));
        var unit = document.createElement('span');
        unit.className = 'settings-model-context-unit';
        unit.textContent = 'K tokens';
        var saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'settings-model-context-edit-action is-save';
        saveBtn.textContent = '\u2713';
        saveBtn.title = t('saveContextWindow');
        saveBtn.setAttribute('aria-label', t('saveContextWindow'));
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'settings-model-context-edit-action';
        cancelBtn.textContent = '\u00d7';
        cancelBtn.title = t('cancel');
        cancelBtn.setAttribute('aria-label', t('cancel'));

        function cancelEdit() {
          renderAccountSettings();
        }

        function saveEdit() {
          if (blockAccountSettingsWhileRunBusy()) { return; }
          var source = getSettingsActiveAccount();
          if (!source || settingsDialogBusyAction) { return; }
          if (blockSettingsActionForUnsavedChanges()) { return; }
          var contextWindowTokens = readOptionalContextWindowKTokens(input);
          if (contextWindowTokens === undefined || contextWindowTokens === null) {
            setSettingsDialogStatus(t('contextWindowKTokensInvalid'));
            input.focus();
            input.select();
            return;
          }
          vscode.postMessage({
            type: 'setModelContextWindow',
            sourceId: source.id,
            modelId: model.id,
            contextWindowTokens: contextWindowTokens
          });
          beginSettingsDialogAction('set-model-context-window', t('updatingContextWindow'));
        }

        saveBtn.addEventListener('click', saveEdit);
        cancelBtn.addEventListener('click', cancelEdit);
        input.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
            return;
          }
          if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            saveEdit();
          }
        });
        container.append(input, unit, saveBtn, cancelBtn);
        input.focus();
        input.select();
      }

      function renderSettingsModelMaxOutputEditor(container, model) {
        container.innerHTML = '';
        container.classList.add('is-editing');
        var input = document.createElement('input');
        input.type = 'number';
        input.className = 'settings-model-context-input';
        input.min = '1';
        input.max = '1048576';
        input.step = '1';
        input.value = String(Math.max(1, Math.round(Number(model.maxOutputTokens) || 0)));
        input.setAttribute('aria-label', t('editMaxOutputTokens', { modelId: model.id }));
        var unit = document.createElement('span');
        unit.className = 'settings-model-context-unit';
        unit.textContent = 'tokens';
        var saveBtn = document.createElement('button');
        saveBtn.type = 'button';
        saveBtn.className = 'settings-model-context-edit-action is-save';
        saveBtn.textContent = '\u2713';
        saveBtn.title = t('saveMaxOutput');
        saveBtn.setAttribute('aria-label', t('saveMaxOutput'));
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'settings-model-context-edit-action';
        cancelBtn.textContent = '\u00d7';
        cancelBtn.title = t('cancel');
        cancelBtn.setAttribute('aria-label', t('cancel'));

        function cancelEdit() {
          renderAccountSettings();
        }

        function saveEdit() {
          if (blockAccountSettingsWhileRunBusy()) { return; }
          var source = getSettingsActiveAccount();
          if (!source || settingsDialogBusyAction) { return; }
          if (blockSettingsActionForUnsavedChanges()) { return; }
          var maxOutputTokens = readOptionalCapabilityInput(input, 1048576);
          if (maxOutputTokens === undefined || maxOutputTokens === null) {
            setSettingsDialogStatus(t('maxOutputTokensInvalid'));
            input.focus();
            input.select();
            return;
          }
          vscode.postMessage({
            type: 'setModelMaxOutput',
            sourceId: source.id,
            modelId: model.id,
            maxOutputTokens: maxOutputTokens
          });
          beginSettingsDialogAction('set-model-max-output', t('updatingMaxOutput'));
        }

        saveBtn.addEventListener('click', saveEdit);
        cancelBtn.addEventListener('click', cancelEdit);
        input.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelEdit();
            return;
          }
          if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey) {
            event.preventDefault();
            saveEdit();
          }
        });
        container.append(input, unit, saveBtn, cancelBtn);
        input.focus();
        input.select();
      }

      function renderSettingsModelList(account, controlsDisabled) {
        if (!settingsModelList) { return; }
        var models = getSettingsAccountModels(account);
        settingsModelList.innerHTML = '';
        var manualModelIds = account && Array.isArray(account.manualModelIds) ? account.manualModelIds : [];
        models.forEach(function(model) {
          var row = document.createElement('div');
          row.className = 'settings-model-row';
          row.dataset.modelId = model.id;
          var identity = document.createElement('div');
          identity.className = 'settings-model-identity';
          identity.title = model.id;
          var name = document.createElement('span');
          name.className = 'settings-model-name';
          name.textContent = model.id;
          identity.append(name);
          var capabilities = document.createElement('span');
          capabilities.className = 'settings-model-capabilities settings-field-hint';
          if (model.agentCompatible === false) {
            var resourceKind = model.nonTextModelKind === 'image-generation'
              ? t('imageGenerationResource')
              : t('speechSynthesisResource');
            var unavailableContext = document.createElement('span');
            unavailableContext.className = 'settings-model-capability settings-model-context-capability';
            unavailableContext.textContent = t('contextWindowTokens') + ': '
              + t('notApplicable') + ' (' + resourceKind + ')';
            var unavailableOutput = document.createElement('span');
            unavailableOutput.className = 'settings-model-capability settings-model-output-capability';
            unavailableOutput.textContent = t('maxOutputTokens') + ': ' + t('notApplicable');
            capabilities.append(unavailableContext, unavailableOutput);
          }
          if (model.contextWindowTokens) {
            var contextCapability = document.createElement('span');
            contextCapability.className = 'settings-model-capability settings-model-context-capability';
            var contextLabel = document.createElement('span');
            var isEstimated = model.contextWindowSource === 'guessed' || model.contextWindowSource === 'fallback';
            contextLabel.textContent = t('contextWindowTokens')
              + (isEstimated ? ' (' + t('estimatedValue') + ')' : '')
              + ': ';
            var contextValue = document.createElement('button');
            contextValue.type = 'button';
            contextValue.className = 'settings-model-context-value';
            contextValue.textContent = formatContextWindowTokens(model.contextWindowTokens);
            contextValue.disabled = controlsDisabled;
            contextValue.title = t('editContextWindowKTokens', { modelId: model.id });
            contextValue.setAttribute('aria-label', contextValue.title);
            contextValue.addEventListener('click', function() {
              if (blockAccountSettingsWhileRunBusy()) { return; }
              if (settingsDialogBusyAction) { return; }
              if (blockSettingsActionForUnsavedChanges()) { return; }
              renderSettingsModelContextEditor(contextCapability, model);
            });
            contextCapability.append(contextLabel, contextValue);
            capabilities.append(contextCapability);
          }
          if (model.maxOutputTokens) {
            var outputCapability = document.createElement('span');
            outputCapability.className = 'settings-model-capability settings-model-output-capability';
            var outputLabel = document.createElement('span');
            var isOutputEstimated = model.maxOutputSource === 'guessed' || model.maxOutputSource === 'fallback';
            outputLabel.textContent = t('maxOutputTokens')
              + (isOutputEstimated ? ' (' + t('estimatedValue') + ')' : '')
              + ': ';
            var outputValue = document.createElement('button');
            outputValue.type = 'button';
            outputValue.className = 'settings-model-context-value settings-model-output-value';
            outputValue.textContent = formatContextWindowTokens(model.maxOutputTokens);
            outputValue.disabled = controlsDisabled;
            outputValue.title = t('editMaxOutputTokens', { modelId: model.id });
            outputValue.setAttribute('aria-label', outputValue.title);
            outputValue.addEventListener('click', function() {
              if (blockAccountSettingsWhileRunBusy()) { return; }
              if (settingsDialogBusyAction) { return; }
              if (blockSettingsActionForUnsavedChanges()) { return; }
              renderSettingsModelMaxOutputEditor(outputCapability, model);
            });
            outputCapability.append(outputLabel, outputValue);
            capabilities.append(outputCapability);
          }
          if (capabilities.childNodes.length) {
            identity.append(capabilities);
          }
          row.append(identity);
          row.classList.toggle('is-disabled', model.enabled === false);
          var actions = document.createElement('div');
          actions.className = 'settings-model-actions';
          var defaultSlot = document.createElement('span');
          defaultSlot.className = 'settings-model-default-slot';
          // Reserve the action's localized width even when displaying the shorter
          // badge or an unavailable row, so adjacent controls never move.
          defaultSlot.dataset.label = t('setAsDefaultModel');
          var isDefault = settingsDefaultModelSelection && account
            && settingsDefaultModelSelection.sourceId === account.id
            && settingsDefaultModelSelection.modelId === model.id;
          if (isDefault) {
            var defaultBadge = document.createElement('span');
            defaultBadge.className = 'settings-model-default-badge';
            defaultBadge.textContent = t('defaultModel');
            defaultSlot.append(defaultBadge);
          } else if (account && account.enabled !== false && model.enabled !== false && model.agentCompatible !== false) {
            var defaultButton = document.createElement('button');
            defaultButton.type = 'button';
            defaultButton.className = 'settings-model-default-action';
            defaultButton.textContent = t('setAsDefaultModel');
            defaultButton.disabled = controlsDisabled;
            defaultButton.setAttribute('aria-label', t('setAsDefaultModel') + ': ' + model.id);
            defaultButton.addEventListener('click', function(event) {
              event.stopPropagation();
              if (blockAccountSettingsWhileRunBusy() || settingsDialogBusyAction) { return; }
              if (blockSettingsActionForUnsavedChanges()) { return; }
              beginSettingsDialogAction('set-default-model', t('savingDefaultModel'));
              vscode.postMessage({ type: 'setDefaultModel', sourceId: account.id, modelId: model.id });
            });
            defaultSlot.append(defaultButton);
          }
          actions.append(defaultSlot);
          var enableLabel = document.createElement('label');
          enableLabel.className = 'settings-model-enable';
          enableLabel.title = model.agentCompatible === false
            ? t('resourceUnavailableToTextAgent')
            : t('enableModel', { modelId: model.id });
          var enableCheckbox = document.createElement('input');
          enableCheckbox.type = 'checkbox';
          enableCheckbox.checked = model.enabled !== false;
          enableCheckbox.disabled = controlsDisabled || model.agentCompatible === false;
          enableCheckbox.setAttribute('aria-label', enableLabel.title);
          enableCheckbox.addEventListener('change', function() {
            var nextEnabled = enableCheckbox.checked;
            function restoreCheckedState() {
              enableCheckbox.checked = !nextEnabled;
            }
            if (blockAccountSettingsWhileRunBusy()) {
              restoreCheckedState();
              return;
            }
            var source = getSettingsActiveAccount();
            if (!source || settingsDialogBusyAction) {
              restoreCheckedState();
              return;
            }
            if (blockSettingsActionForUnsavedChanges()) {
              restoreCheckedState();
              return;
            }
            var disabledModelIds = Array.isArray(source.disabledModelIds)
              ? source.disabledModelIds.slice()
              : [];
            var disabledIndex = disabledModelIds.indexOf(model.id);
            if (nextEnabled && disabledIndex >= 0) {
              disabledModelIds.splice(disabledIndex, 1);
            } else if (!nextEnabled && disabledIndex < 0) {
              disabledModelIds.push(model.id);
            }
            source.disabledModelIds = disabledModelIds;
            vscode.postMessage({
              type: 'setModelEnabled',
              sourceId: source.id,
              modelId: model.id,
              enabled: nextEnabled
            });
            beginSettingsDialogAction('set-model-enabled', t('updatingModelAvailability'));
          });
          enableLabel.append(enableCheckbox);
          actions.append(enableLabel);
          if (manualModelIds.indexOf(model.id) >= 0) {
            var removeBtn = document.createElement('button');
            removeBtn.type = 'button';
            removeBtn.className = 'settings-model-delete';
            removeBtn.disabled = controlsDisabled;
            removeBtn.setAttribute('aria-label', t('deleteModel') + ' ' + model.id);
            removeBtn.title = t('deleteModel');
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', function() {
              if (blockAccountSettingsWhileRunBusy()) { return; }
              var source = getSettingsActiveAccount();
              if (!source || settingsDialogBusyAction) { return; }
              if (blockSettingsActionForUnsavedChanges()) { return; }
              vscode.postMessage({
                type: 'deleteModel',
                sourceId: source.id,
                modelId: model.id
              });
              beginSettingsDialogAction('delete-model', t('deletingModel'));
            });
            actions.append(removeBtn);
          }
          row.append(actions);
          settingsModelList.append(row);
        });
        if (settingsModelEmpty) {
          settingsModelEmpty.classList.toggle('hidden', models.length > 0);
        }
      }

      function renderAccountSettings() {
        var account = getSettingsActiveAccount();
        var operationBusy = Boolean(settingsDialogBusyAction);
        var runBusy = Boolean(state.isBusy || isModelSelectionLocked());
        var controlsDisabled = operationBusy || runBusy;
        if (settingsDialog) {
          settingsDialog.setAttribute('aria-busy', operationBusy ? 'true' : 'false');
        }
        if (settingsAccountSidebar) {
          settingsAccountSidebar.setAttribute('aria-busy', operationBusy ? 'true' : 'false');
          settingsAccountSidebar.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
        }
        if (settingsAccountEditor) {
          settingsAccountEditor.setAttribute('aria-busy', operationBusy ? 'true' : 'false');
          settingsAccountEditor.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
        }
        syncAccountSettingsRunBusyStatus(runBusy, operationBusy);
        if (settingsDialogTitle) { settingsDialogTitle.textContent = t('modelSettingsDialogTitle'); }
        if (settingsDialogDesc) { settingsDialogDesc.textContent = t('modelSettingsDialogDesc'); }
        if (settingsOverlay) { settingsOverlay.querySelector('.settings-dialog')?.setAttribute('aria-label', t('modelSettingsDialogLabel')); }
        if (settingsAccountsTitle) { settingsAccountsTitle.textContent = t('modelsTitle'); }
        if (settingsCreateAccountBtn) {
          settingsCreateAccountBtn.textContent = t('addAccount');
          settingsCreateAccountBtn.disabled = controlsDisabled;
        }
        if (settingsAccountList) {
          settingsAccountList.setAttribute('aria-label', t('modelSourceListLabel'));
          settingsAccountList.setAttribute('aria-disabled', controlsDisabled ? 'true' : 'false');
        }
        if (settingsAccountEmpty) {
          settingsAccountEmpty.textContent = t('modelSourceListEmpty');
          settingsAccountEmpty.classList.toggle('hidden', settingsSources.length > 0);
        }
        if (settingsCurrentAccountTitle) {
          settingsCurrentAccountTitle.textContent = account ? t('modelSourceTitle') : t('addAccount');
        }
        if (settingsCurrentProvider) { settingsCurrentProvider.textContent = account ? getSettingsProviderLabel(account.provider) : ''; }
        if (settingsDeleteAccountBtn) {
          settingsDeleteAccountBtn.textContent = settingsDialogBusyAction === 'delete' ? t('waitingForDeleteConfirmation') : t('deleteModelSource');
          settingsDeleteAccountBtn.disabled = !account || controlsDisabled;
        }
        if (settingsAccountEditorEmpty) { settingsAccountEditorEmpty.classList.add('hidden'); }
        if (settingsAccountFields) { settingsAccountFields.classList.remove('hidden'); }
        if (settingsAccountNameLabel) { settingsAccountNameLabel.textContent = t('modelSourceName'); }
        if (settingsAccountName) {
          var sourceNameField = settingsAccountName.closest('label');
          if (sourceNameField) { sourceNameField.classList.remove('hidden'); }
        }
        if (settingsModelsTitle) { settingsModelsTitle.textContent = t('modelListTitle'); }
        if (settingsModelsHint) { settingsModelsHint.textContent = t('modelListHint'); }
        if (settingsRefreshModelsBtn) {
          settingsRefreshModelsBtn.textContent = settingsDialogBusyAction === 'refresh-models' ? t('refreshingModels') : t('refreshModels');
          settingsRefreshModelsBtn.disabled = !account || controlsDisabled;
        }
        if (settingsModelEmpty) { settingsModelEmpty.textContent = t('modelsEmpty'); }
        if (settingsManualModelIdLabel) { settingsManualModelIdLabel.textContent = t('manualModelId'); }
        if (settingsManualContextWindowLabel) { settingsManualContextWindowLabel.textContent = t('manualContextWindowTokens'); }
        if (settingsManualMaxOutputLabel) { settingsManualMaxOutputLabel.textContent = t('manualMaxOutputTokens'); }
        if (settingsAddModelBtn) {
          settingsAddModelBtn.disabled = !account || controlsDisabled;
        }
        if (settingsConfirmAddModelBtn) {
          settingsConfirmAddModelBtn.disabled = !account || controlsDisabled;
        }
        [settingsAccountName, settingsApiKey, settingsBaseUrl, settingsApiKeyVisibilityBtn, settingsSaveBtn, settingsManualModelId, settingsManualContextWindow, settingsManualMaxOutput, settingsConfirmAddModelBtn].forEach(function(control) {
          if (control) { control.disabled = controlsDisabled; }
        });
        if (settingsSaveBtn) {
          settingsSaveBtn.textContent = settingsSaveCompleted
            ? t('closeWindow')
            : (account ? t('save') : t('addAccount'));
          settingsSaveBtn.disabled = settingsSaveCompleted ? operationBusy : controlsDisabled;
        }
        if (settingsCancelBtn) { settingsCancelBtn.disabled = operationBusy; }
        renderSettingsAccountList(controlsDisabled);
        renderSettingsModelList(account, controlsDisabled);
      }

`.slice(1)
};

