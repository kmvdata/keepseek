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
        var goalMode = String(state.goalUi?.mode || 'chat');
        if (goalMode !== 'chat' && goalMode !== 'goal_armed') {
          closeCommandMenu();
          closeReferenceMenu(false);
          window.keepseekGoalInterface?.focusCard();
          return;
        }
        if (state.isBusy) {
          closeCommandMenu();
          closeReferenceMenu(false);
          setComposerStatus(t('taskAlreadyRunning'));
          promptInput.focus();
          return;
        }
        sanitizePromptContent();
        var prompt = serializePrompt();
        if (!prompt.trim()) return;
        closeCommandMenu();
        closeReferenceMenu(false);
        if (goalMode === 'goal_armed') {
          vscode.postMessage({
            type: 'prepareGoal', objective: prompt,
            sourceId: state.selectedSourceId, modelId: state.selectedModelId,
            references: collectPromptFileReferences(), skillIds: collectActiveSkillIds()
          });
          state.goalUi = { ...(state.goalUi || {}), mode: 'proposal_generating', composerMode: true };
          // Presentation-only placeholder. The Extension Host replaces it with
          // the authoritative proposal/preparation state on the next revision.
          state.goalProposal = {
            proposal: null,
            conservativeProposal: null,
            visibleOriginalObjective: prompt,
            selectedWorkItemIds: [],
            generationStatus: 'generating',
            generationMessage: t('goalPreparationValidatingInput'),
            generatorModelId: '',
            preparationStage: 'validating_input',
            streamedCharacters: 0
          };
          refreshGoalTranscriptCard();
          renderStatus();
        } else {
          vscode.postMessage({
            type: 'sendPrompt',
            prompt: prompt,
            sourceId: state.selectedSourceId,
            modelId: state.selectedModelId,
            settings: readAgentSettingsFromControls(),
            references: collectPromptFileReferences(),
            skillIds: collectActiveSkillIds()
          });
          state.isBusy = true;
        }
        renderInputControls();
        clearPrompt();
      });

      if (sendButton) {
        sendButton.addEventListener('click', function(event) {
          if (String(state.goalUi?.mode || 'chat') !== 'chat') return;
          if (!state.isBusy) {
            return;
          }
          event.preventDefault();
          event.stopPropagation();
          closeCommandMenu();
          closeReferenceMenu(false);
          vscode.postMessage({ type: 'abortPrompt' });
          setComposerStatus(t('stoppingTask'));
        });
      }

`.slice(1)
};

export const composerRenderFragment: WebviewFragment = {
  id: 'composer.render',
  source: `
      function renderInputControls() {
        refreshPromptFileLinkLabels();
        refreshPromptSkillLinkLabels();
        renderActiveSkillsBar();
        renderContextProgress();
        renderCommandMenu();
        renderReferenceMenuButton();
        renderGoalComposerState();
        window.keepseekGoalDialog?.sync?.();
        renderSendButton();
        setApiKeyVisible(apiKeyVisible, false);
        if (settingsOverlay && !settingsOverlay.classList.contains('hidden')) {
          renderAccountSettings();
        }
      }

      function renderReferenceMenuButton() {
        if (!referenceMenuButton) { return; }
        var goalMode = String(state.goalUi?.mode || 'chat');
        var busy = Boolean(state.isBusy) || (goalMode !== 'chat' && goalMode !== 'goal_armed');
        referenceMenuButton.disabled = busy;
        referenceMenuButton.title = busy ? t('referenceFileDisabledWhileBusy') : t('referenceFileTitle');
        referenceMenuButton.setAttribute('aria-disabled', busy ? 'true' : 'false');
        referenceMenuButton.setAttribute('aria-label', busy ? t('referenceFileDisabledWhileBusy') : t('referenceFile'));
      }

      function renderSendButton(isEmpty) {
        if (!sendButton) { return; }
        var goalMode = String(state.goalUi?.mode || 'chat');
        var goalLocked = goalMode !== 'chat' && goalMode !== 'goal_armed';
        var isAbortMode = Boolean(state.isBusy) && goalMode === 'chat';
        var mode = isAbortMode ? 'abort' : 'send';
        var label = t(isAbortMode ? 'stop' : goalMode === 'goal_armed' ? 'goalPrepareSubmit' : 'send');
        sendButton.disabled = goalLocked || (!isAbortMode && isPromptSubmittableEmpty());
        sendButton.classList.toggle('is-abort', isAbortMode);
        sendButton.title = label;
        sendButton.setAttribute('aria-label', label);
        if (sendButton.dataset.mode !== mode) {
          sendButton.dataset.mode = mode;
          sendButton.innerHTML = isAbortMode ? stopIconSvg : sendIconSvg;
        }
      }

      function renderGoalComposerState() {
        var mode = String(state.goalUi?.mode || 'chat');
        var editable = mode === 'chat' || mode === 'goal_armed';
        composer.classList.toggle('is-goal-mode', mode !== 'chat' && mode !== 'workspace_goal_elsewhere');
        composer.classList.toggle('is-goal-locked', !editable);
        promptInput.setAttribute('contenteditable', editable ? 'true' : 'false');
        promptInput.setAttribute('aria-disabled', editable ? 'false' : 'true');
        var placeholderKey = mode === 'goal_armed' ? 'goalComposerPlaceholder'
          : mode === 'proposal_generating' ? 'goalComposerGenerating'
            : mode === 'proposal_review' ? 'goalComposerReview'
              : mode === 'goal_active' ? 'goalComposerActive'
                : mode === 'goal_terminal' ? 'goalComposerTerminal'
                  : mode === 'workspace_goal_elsewhere' ? 'goalComposerElsewhere'
                    : 'promptPlaceholder';
        promptInput.dataset.placeholder = t(placeholderKey);
      }

`.slice(1)
};

export const composerStatusFragment: WebviewFragment = {
  id: 'composer.status',
  source: `
      function setComposerStatus(message) {
        setTransientStatus(message);
      }

      function clearPrompt() {
        closeCommandMenu();
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
        showAboutDialog: showAboutDialog,
        onSkillDraftCreated: onSkillDraftCreated,
        showStatus: setComposerStatus,
        isPromptSubmittableEmpty: isPromptSubmittableEmpty,
        clearPrompt: clearPrompt
      };
      renderInputControls();
      updatePromptVisualState();
    })();
`.slice(1)
};
