import type { WebviewFragment } from '../composition';

export const modelSelectorsDeclarationFragment: WebviewFragment = {
  id: 'command-menu.models.selectors-declaration',
  source: `
      var commandModelSwitch = document.getElementById('commandModelSwitch');
      var commandModelValue = document.getElementById('commandModelValue');
      var commandModelList = document.getElementById('commandModelList');
      var commandModelDescription = document.getElementById('commandModelDescription');
      var commandSubagentModelSwitch = document.getElementById('commandSubagentModelSwitch');
      var commandSubagentModelValue = document.getElementById('commandSubagentModelValue');
      var commandSubagentModelList = document.getElementById('commandSubagentModelList');
      var commandSubagentModelDescription = document.getElementById('commandSubagentModelDescription');
`.slice(1)
};

export const modelStatusDeclarationFragment: WebviewFragment = {
  id: 'command-menu.models.status-declaration',
  source: `
      var commandModelStatus = document.getElementById('commandModelStatus');
      var commandModelStatusText = document.getElementById('commandModelStatusText');
      var commandModelCancelPending = document.getElementById('commandModelCancelPending');
      var composerModelStatus = document.getElementById('composerModelStatus');
      var composerModelStatusText = document.getElementById('composerModelStatusText');
      var composerModelCancelPending = document.getElementById('composerModelCancelPending');
`.slice(1)
};

export const modelControlsStateFragment: WebviewFragment = {
  id: 'command-menu.models.state',
  source: `
      var commandModelListOpen = false;
      var commandSubagentModelListOpen = false;
      var commandSubagentModelProfile = 'research';
`.slice(1)
};

export const modelSelectorBindingsFragment: WebviewFragment = {
  id: 'command-menu.models.selector-bindings',
  source: `
      if (commandModelSwitch) {
        commandModelSwitch.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (isModelSelectionLocked()) {
            setComposerStatus(getMainModelLockText());
            return;
          }
          commandModelListOpen = !commandModelListOpen;
          if (commandModelListOpen) {
            commandSubagentModelListOpen = false;
            commandApprovalModeListOpen = false;
            commandSkillListOpen = false;
          }
          renderCommandMenu();
        });
      }

      if (commandModelList) {
        commandModelList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var button = target?.closest('button[data-model-id]');
          if (!button || isModelSelectionLocked()) { return; }
          event.preventDefault();
          event.stopPropagation();
          var modelId = button.dataset.modelId || '';
          var sourceId = button.dataset.sourceId || '';
          if (sourceId && modelId) {
            vscode.postMessage({
              type: 'setSelectedModel',
              requestId: nextModelSelectionRequestId(),
              sourceId: sourceId,
              modelId: modelId
            });
          }
          commandModelListOpen = false;
          renderCommandMenu();
          setComposerStatus(t('modelSwitchValidating'));
        });
      }

      if (commandSubagentModelSwitch) {
        commandSubagentModelSwitch.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          if (isSubagentModelSelectionLocked()) {
            setComposerStatus(getSubagentModelLockText());
            return;
          }
          commandSubagentModelListOpen = !commandSubagentModelListOpen;
          if (commandSubagentModelListOpen) {
            commandModelListOpen = false;
            commandApprovalModeListOpen = false;
            commandSkillListOpen = false;
          }
          renderCommandMenu();
        });
      }

      if (commandApprovalModeSwitch) {
`.slice(1)
};

export const subagentAndPendingBindingsFragment: WebviewFragment = {
  id: 'command-menu.models.subagent-bindings',
  source: `
        commandSubagentModelList.addEventListener('click', function(event) {
          var target = event.target instanceof Element ? event.target : null;
          var profileButton = target?.closest('button[data-subagent-profile]');
          if (profileButton && !profileButton.disabled) {
            event.preventDefault();
            event.stopPropagation();
            commandSubagentModelProfile = profileButton.dataset.subagentProfile || 'research';
            renderCommandSubagentModel();
            return;
          }
          var button = target?.closest('button[data-subagent-model-mode]');
          if (!button || isSubagentModelSelectionLocked()) { return; }
          event.preventDefault();
          event.stopPropagation();
          var mode = button.dataset.subagentModelMode || 'follow-main';
          var statusValue = t('subagentModelFollowMain');
          if (mode === 'fixed') {
            var sourceId = button.dataset.sourceId || '';
            var modelId = button.dataset.modelId || '';
            if (!sourceId || !modelId) { return; }
            vscode.postMessage({ type: 'setSubagentModel', mode: 'fixed', sourceId: sourceId, modelId: modelId, profile: commandSubagentModelProfile });
            var model = findModelForSelection(Array.isArray(state.models) ? state.models : [], sourceId, modelId);
            statusValue = getModelDisplayLabel(model);
          } else {
            vscode.postMessage({ type: 'setSubagentModel', mode: 'follow-main', profile: commandSubagentModelProfile });
          }
          commandSubagentModelListOpen = false;
          renderCommandMenu();
          setComposerStatus(t('subagentModelTitle') + ': ' + statusValue);
        });
      }

      if (commandModelCancelPending) {
        commandModelCancelPending.addEventListener('click', function(event) {
          event.preventDefault();
          event.stopPropagation();
          vscode.postMessage({
            type: 'cancelPendingModelSelection',
            requestId: nextModelSelectionRequestId()
          });
        });
      }

      if (composerModelCancelPending) {
        composerModelCancelPending.addEventListener('click', function(event) {
          event.preventDefault();
          vscode.postMessage({
            type: 'cancelPendingModelSelection',
            requestId: nextModelSelectionRequestId()
          });
        });
      }

`.slice(1)
};

export const modelControlsRenderFragment: WebviewFragment = {
  id: 'command-menu.models.render',
  source: `
      function renderCommandModel() {
        var models = Array.isArray(state.models) ? state.models : [];
        var selected = getSelectedModel(models);
        var readiness = getCommandSettingReadiness('mainModel');
        var readinessText = readiness === 'error' ? t('mainModelLoadFailed')
          : readiness === 'loading' ? t('mainModelLoading') : '';
        var selectionState = state.modelSelection && typeof state.modelSelection === 'object'
          ? state.modelSelection
          : {};
        var pending = selectionState.pending && typeof selectionState.pending === 'object'
          ? selectionState.pending
          : null;
        var currentRun = selectionState.currentRun && typeof selectionState.currentRun === 'object'
          ? selectionState.currentRun
          : null;
        var lockedByBackground = selectionState.lockedByBackground === true;
        var locked = readiness !== 'ready' || lockedByBackground;
        var lockText = readinessText || (lockedByBackground ? t('modelSelectionLockedByBackground') : '');
        if (commandModelValue) {
          var currentModelValue = selected
            ? getModelSourceLabel(selected.model) + ' / ' + getModelDisplayLabel(selected.model)
            : readinessText || t('addModel');
          commandModelValue.innerHTML = '';
          if (selected) {
            var currentLogo = createCommandModelProtocolLogo(selected.model.provider);
            if (currentLogo) {
              commandModelValue.append(currentLogo);
            }
          }
          var currentModelText = document.createElement('span');
          currentModelText.className = 'command-model-current-text';
          currentModelText.textContent = currentModelValue;
          commandModelValue.append(currentModelText);
          commandModelValue.title = selected && selected.model.id ? selected.model.id : commandModelValue.textContent;
        }

        if (commandModelSwitch) {
          commandModelSwitch.disabled = locked;
          commandModelSwitch.title = lockText || t('switchModelDescription');
          commandModelSwitch.setAttribute('aria-disabled', locked ? 'true' : 'false');
          commandModelSwitch.setAttribute('aria-busy', readiness === 'loading' ? 'true' : 'false');
          commandModelSwitch.setAttribute('aria-expanded', commandModelListOpen ? 'true' : 'false');
        }
        if (commandModelDescription) {
          commandModelDescription.textContent = lockText
            ? lockText
            : state.isBusy ? t('modelSelectForNextTurn') : t('switchModelDescription');
        }
        if (commandModelStatus && commandModelStatusText && commandModelCancelPending) {
          var pendingModel = pending ? findModelForSelection(models, pending.sourceId, pending.modelId) : null;
          var currentRunModel = currentRun ? findModelForSelection(models, currentRun.sourceId, currentRun.modelId) : selected?.model;
          var pendingText = pending
            ? t('modelPendingStatus', {
                current: getModelDisplayLabel(currentRunModel),
                target: pendingModel ? getModelDisplayLabel(pendingModel) : String(pending.modelId || '')
              })
            : lockedByBackground ? t('modelSelectionLockedByBackground') : '';
          commandModelStatus.classList.toggle('hidden', !pendingText);
          commandModelStatusText.textContent = pendingText;
          commandModelCancelPending.classList.toggle('hidden', !pending || locked);
          commandModelCancelPending.disabled = !pending || locked;
        }
        if (composerModelStatus && composerModelStatusText && composerModelCancelPending) {
          var composerPendingModel = pending ? findModelForSelection(models, pending.sourceId, pending.modelId) : null;
          var composerCurrentRunModel = currentRun ? findModelForSelection(models, currentRun.sourceId, currentRun.modelId) : selected?.model;
          var composerPendingText = pending
            ? t('modelPendingStatus', {
                current: getModelDisplayLabel(composerCurrentRunModel),
                target: composerPendingModel ? getModelDisplayLabel(composerPendingModel) : String(pending.modelId || '')
              })
            : '';
          composerModelStatus.classList.toggle('hidden', !composerPendingText);
          composerModelStatusText.textContent = composerPendingText;
          composerModelStatus.title = composerPendingText;
          composerModelCancelPending.disabled = !pending || locked;
        }
        if (!commandModelList) { return; }

        commandModelList.classList.toggle('hidden', !commandModelListOpen);
        commandModelList.innerHTML = '';
        if (!models.length) {
          var empty = document.createElement('div');
          empty.className = 'command-model-option command-model-empty';
          empty.textContent = readinessText || t('modelsEmpty');
          commandModelList.append(empty);
          return;
        }

        var previousSourceId = '';
        for (var i = 0; i < models.length; i++) {
          var model = models[i];
          if (model.sourceId !== previousSourceId) {
            var groupLabel = document.createElement('div');
            groupLabel.className = 'command-model-source';
            var groupLogo = createCommandModelProtocolLogo(model.provider);
            if (groupLogo) {
              groupLabel.append(groupLogo);
            }
            var groupName = document.createElement('span');
            groupName.className = 'command-model-source-name';
            groupName.textContent = getModelSourceLabel(model);
            groupLabel.append(groupName);
            commandModelList.append(groupLabel);
            previousSourceId = model.sourceId || '';
          }
          var option = document.createElement('button');
          var isSelected = model.sourceId === state.selectedSourceId
            && model.id === state.selectedModelId;
          var isPending = Boolean(pending && model.sourceId === pending.sourceId && model.id === pending.modelId);
          option.type = 'button';
          option.className = 'command-model-option';
          option.dataset.sourceId = model.sourceId || '';
          option.dataset.modelId = model.id;
          option.disabled = locked;
          option.setAttribute('role', 'menuitemradio');
          option.setAttribute('aria-checked', isSelected ? 'true' : 'false');
          option.setAttribute('aria-label', isPending
            ? t('modelPendingOption', { model: getModelDisplayLabel(model) })
            : getModelDisplayLabel(model));
          option.classList.toggle('is-pending', isPending);

          var check = document.createElement('span');
          check.className = 'command-model-check';
          check.textContent = isSelected ? '\\u2713' : isPending ? '\\u2192' : '';

          var label = document.createElement('span');
          label.className = 'command-model-name';
          label.textContent = getModelDisplayLabel(model);
          label.title = model.id || getModelDisplayLabel(model);
          option.title = lockText
            ? lockText
            : isPending ? t('modelPendingOption', { model: getModelDisplayLabel(model) }) : model.id || getModelDisplayLabel(model);

          option.append(check, label);
          commandModelList.append(option);
        }
      }

      function renderCommandSubagentModel() {
        var models = Array.isArray(state.models) ? state.models : [];
        var settingReadiness = getCommandSettingReadiness('subagentModel');
        var modelReadiness = getCommandSettingReadiness('mainModel');
        var readiness = settingReadiness === 'error' || modelReadiness === 'error'
          ? 'error'
          : settingReadiness === 'ready' && modelReadiness === 'ready' ? 'ready' : 'loading';
        var readinessText = settingReadiness === 'error' ? t('subagentModelLoadFailed')
          : modelReadiness === 'error' ? t('mainModelLoadFailed')
            : settingReadiness === 'loading' ? t('subagentModelLoading')
              : modelReadiness === 'loading' ? t('mainModelLoading') : '';
        var allSettings = state.subagentModelSettings && typeof state.subagentModelSettings === 'object'
          ? state.subagentModelSettings
          : { default: state.subagentModelSetting, profiles: {} };
        var rawSetting = allSettings.profiles && allSettings.profiles[commandSubagentModelProfile]
          ? allSettings.profiles[commandSubagentModelProfile]
          : allSettings.default && typeof allSettings.default === 'object' ? allSettings.default : { mode: 'follow-main' };
        var isFixed = rawSetting.mode === 'fixed';
        var sourceId = isFixed && typeof rawSetting.sourceId === 'string' ? rawSetting.sourceId : '';
        var modelId = isFixed && typeof rawSetting.modelId === 'string' ? rawSetting.modelId : '';
        var selectedModel = isFixed ? findModelForSelection(models, sourceId, modelId) : null;
        var locked = readiness !== 'ready' || state.isBusy || isModelSelectionLocked();
        var lockText = readinessText || (locked ? getSubagentModelLockText() : '');
        var currentText = isFixed
          ? selectedModel
            ? getModelSourceLabel(selectedModel) + ' / ' + getModelDisplayLabel(selectedModel)
            : t('subagentModelUnavailable')
          : t('subagentModelFollowMain');

        if (commandSubagentModelValue) {
          commandSubagentModelValue.innerHTML = '';
          if (selectedModel) {
            var currentLogo = createCommandModelProtocolLogo(selectedModel.provider);
            if (currentLogo) {
              commandSubagentModelValue.append(currentLogo);
            }
          }
          var currentModelText = document.createElement('span');
          currentModelText.className = 'command-model-current-text';
          currentModelText.textContent = currentText;
          commandSubagentModelValue.append(currentModelText);
          commandSubagentModelValue.title = isFixed ? sourceId + ' / ' + modelId : currentText;
        }
        if (commandSubagentModelSwitch) {
          commandSubagentModelSwitch.disabled = locked;
          commandSubagentModelSwitch.title = lockText || t('subagentModelHint');
          commandSubagentModelSwitch.setAttribute('aria-disabled', locked ? 'true' : 'false');
          commandSubagentModelSwitch.setAttribute('aria-busy', readiness === 'loading' ? 'true' : 'false');
          commandSubagentModelSwitch.setAttribute('aria-expanded', commandSubagentModelListOpen ? 'true' : 'false');
        }
        if (commandSubagentModelDescription) {
          commandSubagentModelDescription.textContent = lockText || t('subagentModelHint');
        }
        if (!commandSubagentModelList) { return; }

        commandSubagentModelList.classList.toggle('hidden', !commandSubagentModelListOpen);
        commandSubagentModelList.innerHTML = '';

        var profileGroup = document.createElement('div');
        profileGroup.className = 'command-subagent-profile-group';
        profileGroup.setAttribute('role', 'group');
        profileGroup.setAttribute('aria-label', t('subagentProfileModelScope'));
        ['research', 'review', 'proposal'].forEach(function(profile) {
          var profileOption = document.createElement('button');
          profileOption.type = 'button';
          profileOption.className = 'command-model-option command-subagent-profile-option';
          profileOption.dataset.subagentProfile = profile;
          profileOption.disabled = locked;
          profileOption.setAttribute('aria-pressed', profile === commandSubagentModelProfile ? 'true' : 'false');
          profileOption.textContent = t('subagentProfile_' + profile);
          profileGroup.append(profileOption);
        });
        commandSubagentModelList.append(profileGroup);

        var followOption = document.createElement('button');
        followOption.type = 'button';
        followOption.className = 'command-model-option';
        followOption.dataset.subagentModelMode = 'follow-main';
        followOption.disabled = locked;
        followOption.setAttribute('role', 'menuitemradio');
        followOption.setAttribute('aria-checked', isFixed ? 'false' : 'true');
        followOption.title = lockText || t('subagentModelFollowMain');
        var followCheck = document.createElement('span');
        followCheck.className = 'command-model-check';
        followCheck.textContent = isFixed ? '' : '\u2713';
        var followLabel = document.createElement('span');
        followLabel.className = 'command-model-name';
        followLabel.textContent = t('subagentModelFollowMain');
        followOption.append(followCheck, followLabel);
        commandSubagentModelList.append(followOption);

        var previousSourceId = '';
        for (var i = 0; i < models.length; i++) {
          var model = models[i];
          if (model.sourceId !== previousSourceId) {
            var groupLabel = document.createElement('div');
            groupLabel.className = 'command-model-source';
            var groupLogo = createCommandModelProtocolLogo(model.provider);
            if (groupLogo) {
              groupLabel.append(groupLogo);
            }
            var groupName = document.createElement('span');
            groupName.className = 'command-model-source-name';
            groupName.textContent = getModelSourceLabel(model);
            groupLabel.append(groupName);
            commandSubagentModelList.append(groupLabel);
            previousSourceId = model.sourceId || '';
          }
          var option = document.createElement('button');
          var isSelected = isFixed && model.sourceId === sourceId && model.id === modelId;
          option.type = 'button';
          option.className = 'command-model-option';
          option.dataset.subagentModelMode = 'fixed';
          option.dataset.sourceId = model.sourceId || '';
          option.dataset.modelId = model.id;
          option.disabled = locked;
          option.setAttribute('role', 'menuitemradio');
          option.setAttribute('aria-checked', isSelected ? 'true' : 'false');
          option.setAttribute('aria-label', getModelDisplayLabel(model));
          option.title = lockText || model.id || getModelDisplayLabel(model);

          var check = document.createElement('span');
          check.className = 'command-model-check';
          check.textContent = isSelected ? '\u2713' : '';
          var label = document.createElement('span');
          label.className = 'command-model-name';
          label.textContent = getModelDisplayLabel(model);
          label.title = model.id || getModelDisplayLabel(model);
          option.append(check, label);
          commandSubagentModelList.append(option);
        }
      }

`.slice(1)
};

export const modelControlsLockingFragment: WebviewFragment = {
  id: 'command-menu.models.locking',
  source: `
      function nextModelSelectionRequestId() {
        modelSelectionRequestSequence += 1;
        return 'model-selection-' + String(modelSelectionRequestSequence);
      }

      function isModelSelectionLocked() {
        return getCommandSettingReadiness('mainModel') !== 'ready'
          || Boolean(state.modelSelection && state.modelSelection.lockedByBackground === true);
      }

      function isSubagentModelSelectionLocked() {
        return getCommandSettingReadiness('subagentModel') !== 'ready'
          || Boolean(state.isBusy || isModelSelectionLocked());
      }

      function isApprovalModeSelectionLocked() {
        return getCommandSettingReadiness('approvalMode') !== 'ready'
          || Boolean(state.isBusy && state.approvalMode === 'ask');
      }

      function getCommandSettingReadiness(key) {
        var readiness = state.commandSettingsReadiness && typeof state.commandSettingsReadiness === 'object'
          ? state.commandSettingsReadiness[key]
          : 'loading';
        return readiness === 'ready' || readiness === 'error' ? readiness : 'loading';
      }

      function getMainModelLockText() {
        var readiness = getCommandSettingReadiness('mainModel');
        return t(readiness === 'error'
          ? 'mainModelLoadFailed'
          : readiness === 'loading' ? 'mainModelLoading' : 'modelSelectionLockedByBackground');
      }

      function getApprovalModeLockText() {
        var readiness = getCommandSettingReadiness('approvalMode');
        return t(readiness === 'error'
          ? 'approvalModeLoadFailed'
          : readiness === 'loading' ? 'approvalModeRestoring' : 'modelSettingsReadonlyWhileBusy');
      }

      function getSubagentModelLockText() {
        var readiness = getCommandSettingReadiness('subagentModel');
        if (readiness !== 'ready') {
          return t(readiness === 'error' ? 'subagentModelLoadFailed' : 'subagentModelLoading');
        }
        var mainReadiness = getCommandSettingReadiness('mainModel');
        if (mainReadiness !== 'ready') {
          return t(mainReadiness === 'error' ? 'mainModelLoadFailed' : 'mainModelLoading');
        }
        return t(isModelSelectionLocked() ? 'modelSelectionLockedByBackground' : 'modelSettingsReadonlyWhileBusy');
      }

      function findModelForSelection(models, sourceId, modelId) {
        for (var i = 0; i < models.length; i++) {
          if (models[i].sourceId === sourceId && models[i].id === modelId) {
            return models[i];
          }
        }
        return null;
      }

`.slice(1)
};

export const modelControlsHelpersFragment: WebviewFragment = {
  id: 'command-menu.models.helpers',
  source: `
      function getSelectedModel(models) {
        if (!models.length) { return null; }
        for (var i = 0; i < models.length; i++) {
          if (models[i].sourceId === state.selectedSourceId && models[i].id === state.selectedModelId) {
            return { model: models[i], index: i };
          }
        }
        return { model: models[0], index: 0 };
      }

      function getModelDisplayLabel(model) {
        if (!model) { return 'DeepSeek-V4-Flash'; }
        return model.fetchedName || model.label || model.id || 'Model';
      }

      function getModelSourceLabel(model) {
        if (!model) { return 'Model'; }
        return model.sourceName || (model.provider === 'anthropic-compatible' ? t('anthropicMessagesCompatible')
          : model.provider === 'openai-responses' ? t('openAiResponsesCompatible')
          : model.provider === 'kimi' ? t('kimiOfficial')
          : model.provider === 'glm' ? t('glmOfficial')
          : model.provider === 'qwencloud' ? t('qwenCloud')
          : model.provider === 'openai-compatible' ? 'OpenAI Compatible'
          : model.provider === 'ollama' ? 'Ollama'
          : 'DeepSeek');
      }

      function createCommandModelProtocolLogo(provider) {
        var normalizedProvider = normalizeSettingsProvider(provider);
        var logoUri = getModelProtocolLogoUri(normalizedProvider);
        if (!logoUri) { return null; }
        var logoBox = document.createElement('span');
        logoBox.className = 'command-model-protocol-logo-box';
        logoBox.setAttribute('aria-hidden', 'true');
        var logo = document.createElement('img');
        logo.className = 'command-model-protocol-logo';
        logo.dataset.provider = normalizedProvider;
        logo.src = logoUri;
        logo.alt = '';
        logo.draggable = false;
        logoBox.append(logo);
        return logoBox;
      }

`.slice(1)
};

