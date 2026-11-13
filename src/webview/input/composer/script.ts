import type { WebviewFragment } from '../composition';

export const composerOpenFragment: WebviewFragment = {
  id: 'composer.open',
  source: `
    let savedPromptRange = null;

    (function setupRichPromptInput() {
`.slice(1)
};

export const composerIconStateFragment: WebviewFragment = {
  id: 'composer.icon-state',
  source: `
      var sendIconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 12.75V3.75M4.75 7 8 3.75 11.25 7" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      var stopIconSvg = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="4.25" y="4.25" width="7.5" height="7.5" rx="1.2" fill="currentColor"/></svg>';
`.slice(1)
};

export const composerSubmitBindingsFragment: WebviewFragment = {
  id: 'composer.submit-bindings',
  source: `
      composer.addEventListener('submit', function(event) {
        event.preventDefault();
        if (!canSubmitPrompt()) {
          closeCommandMenu();
          closeExecutionModeMenu(false);
          closeReferenceMenu(false);
          setComposerStatus(t(state.isBusy ? 'taskAlreadyRunning' : 'submissionNotReady'));
          promptInput.focus();
          return;
        }
        sanitizePromptContent();
        if (hasStalePluginSkillInPrompt()) {
          setComposerStatus(t('pluginSkillStale'));
          return;
        }
        var prompt = serializePrompt();
        if (!prompt.trim()) return;
        var requestId = beginPromptSubmission('composer', prompt);
        if (!requestId) return;
        closeCommandMenu();
        closeExecutionModeMenu(false);
        closeReferenceMenu(false);
        vscode.postMessage({
          type: 'sendPrompt',
          requestId: requestId,
          sessionId: state.activeSessionId,
          stateRevision: currentInteraction()?.revision || lastStateRevision,
          prompt: prompt,
          sourceId: state.selectedSourceId,
          modelId: state.selectedModelId,
          settings: readAgentSettingsFromControls(),
          references: collectPromptFileReferences(),
          skillIds: collectActiveSkillIds()
        });
        renderInputControls();
        syncSendButtonAvailability();
      });

      if (sendButton) {
        sendButton.addEventListener('click', function(event) {
          if (!canCancelPrompt()) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          closeCommandMenu();
          closeExecutionModeMenu(false);
          closeReferenceMenu(false);
          vscode.postMessage({ type: 'abortPrompt', operationId: currentInteraction()?.cancelOperationId });
        });
      }

`.slice(1)
};

export const composerRenderFragment: WebviewFragment = {
  id: 'composer.render',
  source: `
      function renderInputControls() {
        var interaction = currentInteraction();
        promptInput.setAttribute('contenteditable', interaction?.canEdit === false ? 'false' : 'true');
        refreshPromptFileLinkLabels();
        refreshPromptSkillLinkLabels();
        renderActiveSkillsBar();
        renderContextProgress();
        renderCommandMenu();
        renderExecutionModeControl();
        renderReferenceMenuButton();
        if (referenceMenuOpen && referenceMenuSource === 'skill') {
          renderReferenceMenu();
        }
        renderSendButton();
        setApiKeyVisible(apiKeyVisible, false);
        if (settingsOverlay && !settingsOverlay.classList.contains('hidden')) {
          renderAccountSettings();
        }
      }

      function renderReferenceMenuButton() {
        if (!referenceMenuButton) { return; }
        var busy = !canChangeContext();
        referenceMenuButton.disabled = busy;
        referenceMenuButton.title = busy ? t('referenceFileDisabledWhileBusy') : t('referenceFileTitle');
        referenceMenuButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
        referenceMenuButton.setAttribute('aria-label', busy ? t('referenceFileDisabledWhileBusy') : t('referenceFile'));
      }

      function renderSendButton(isEmpty) {
        if (!sendButton) { return; }
        var isAbortMode = canCancelPrompt();
        var mode = isAbortMode ? 'abort' : 'send';
        var label = t(isAbortMode ? 'stop' : 'send');
        sendButton.disabled = !isAbortMode && (!canSubmitPrompt() || isPromptSubmittableEmpty());
        sendButton.classList.toggle('is-abort', isAbortMode);
        sendButton.title = label;
        sendButton.setAttribute('aria-label', label);
        if (sendButton.dataset.mode !== mode) {
          sendButton.dataset.mode = mode;
          sendButton.innerHTML = isAbortMode ? stopIconSvg : sendIconSvg;
        }
      }

`.slice(1)
};

export const composerStatusFragment: WebviewFragment = {
  id: 'composer.status',
  source: `
      function setComposerStatus(message, scope) {
        setTransientStatus(message, false, scope);
      }

      function clearPrompt() {
        promptShortcutController.invalidateYank();
        promptShortcutController.closeContextMenu();
        closeCommandMenu();
        closeExecutionModeMenu(false);
        closeReferenceMenu(false);
        promptInput.innerHTML = '';
        promptShortcutController.deactivateMark();
        savedPromptRange = null;
        updatePromptVisualState();
      }

`.slice(1)
};

export const composerPublicApiFragment: WebviewFragment = {
  id: 'composer.public-api',
  source: `

      window.keepseekInputControls = {
        render: renderInputControls,
        renderUsage: renderContextProgress,
        showSettingsDialog: showSettingsDialog,
        showHistorySettingsDialog: showHistorySettingsDialog,
        onHistoryCleanupMessage: onHistoryCleanupMessage,
        onHistorySettingsSaved: onHistorySettingsSaved,
        showAboutDialog: showAboutDialog,
        onSkillDraftCreated: onSkillDraftCreated,
        showStatus: setComposerStatus,
        isPromptSubmittableEmpty: isPromptSubmittableEmpty,
        clearPrompt: clearPrompt
        ,acceptSubmission: function(prompt) {
          if (serializePrompt() === prompt) clearPrompt();
        }
        ,restoreDraft: function(markup) {
          promptInput.innerHTML = markup;
          sanitizePromptContent();
          updatePromptVisualState();
        }
      };
      renderInputControls();
      updatePromptVisualState();
    })();
`.slice(1)
};
