import type { WebviewFragment } from '../../composition';

export const goalDialogScriptFragment: WebviewFragment = {
  id: 'dialogs.goal.script',
  source: `
      var goalButton = document.getElementById('goalButton');
      var goalHoverHeading = document.getElementById('goalHoverHeading');
      var goalHoverObjective = document.getElementById('goalHoverObjective');
      var goalHoverMeta = document.getElementById('goalHoverMeta');
      var goalHoverReason = document.getElementById('goalHoverReason');
      var goalDialogOverlay = document.getElementById('goalDialogOverlay');
      var goalDialogTitle = document.getElementById('goalDialogTitle');
      var goalCreatePane = document.getElementById('goalCreatePane');
      var goalManagePane = document.getElementById('goalManagePane');
      var goalDraftGenerationStatus = document.getElementById('goalDraftGenerationStatus');
      var goalDraftGenerationText = document.getElementById('goalDraftGenerationText');
      var goalCancelGeneration = document.getElementById('goalCancelGeneration');
      var goalGenerateDraft = document.getElementById('goalGenerateDraft');
      var goalObjective = document.getElementById('goalObjective');
      var goalCriteria = document.getElementById('goalCriteria');
      var goalGeneratedCriteria = document.getElementById('goalGeneratedCriteria');
      var goalCriterionType = document.getElementById('goalCriterionType');
      var goalEvidence = document.getElementById('goalEvidence');
      var goalIncludeScope = document.getElementById('goalIncludeScope');
      var goalExcludeScope = document.getElementById('goalExcludeScope');
      var goalValidationCompile = document.getElementById('goalValidationCompile');
      var goalValidationLint = document.getElementById('goalValidationLint');
      var goalValidationTest = document.getElementById('goalValidationTest');
      var goalMaxActiveExecution = document.getElementById('goalMaxActiveExecution');
      var goalMaxCost = document.getElementById('goalMaxCost');
      var goalMaxRequests = document.getElementById('goalMaxRequests');
      var goalMaxReviews = document.getElementById('goalMaxReviews');
      var goalResumePolicy = document.getElementById('goalResumePolicy');
      var goalVisibleMessage = document.getElementById('goalVisibleMessage');
      var goalLifecycleNotice = document.getElementById('goalLifecycleNotice');
      var goalDialogError = document.getElementById('goalDialogError');
      var goalManageObjective = document.getElementById('goalManageObjective');
      var goalManageStatus = document.getElementById('goalManageStatus');
      var goalManageMeta = document.getElementById('goalManageMeta');
      var goalManageReason = document.getElementById('goalManageReason');
      var goalManageCriteria = document.getElementById('goalManageCriteria');
      var goalManageValidations = document.getElementById('goalManageValidations');
      var goalPause = document.getElementById('goalPause');
      var goalResume = document.getElementById('goalResume');
      var goalStop = document.getElementById('goalStop');
      var goalClear = document.getElementById('goalClear');
      var goalAmendRow = document.getElementById('goalAmendRow');
      var goalAmendInput = document.getElementById('goalAmendInput');
      var goalAmend = document.getElementById('goalAmend');
      var goalStart = document.getElementById('goalStart');
      var goalCancel = document.getElementById('goalCancel');
      var goalClose = document.getElementById('goalClose');
      var goalDraft = null;
      var goalDialogMode = null;
      var goalDraftGenerationActive = false;
      var goalActionFeedback = null;
      var goalActionFeedbackGoalId = '';

      function goalLines(value) { return String(value || '').split(/\\r?\\n/u).map(function(line) { return line.trim(); }).filter(Boolean); }
      function goalNumber(element) { var value = Number(element?.value || 0); return Number.isFinite(value) && value > 0 ? value : 0; }
      function goalStatusLabel(value) {
        var key = 'goalStatus_' + String(value || 'preparing');
        var label = t(key);
        return label === key ? String(value || '').replace(/_/gu, ' ') : label;
      }
      function goalCosts(goal) {
        return Object.entries(goal?.costByCurrency || {}).map(function(entry) {
          return entry[0] + ' ' + Number(entry[1] || 0).toFixed(4);
        }).join(', ') || '—';
      }
      function goalBudgetValue(value, suffix) { return Number(value || 0) > 0 ? String(value) + (suffix || '') : '∞'; }
      function goalExecutionText(goal) {
        return Math.floor(Number(goal?.activeExecutionMs || 0) / 1000) + 's / '
          + (Number(goal?.maxActiveExecutionMs || 0) > 0 ? Math.floor(Number(goal.maxActiveExecutionMs) / 1000) + 's' : '∞');
      }
      function goalCriterionTypeLabel(value) {
        var keys = {
          workspace_state: 'goalCriterionWorkspaceState', validation: 'goalCriterionValidation',
          artifact: 'goalCriterionArtifact', manual: 'goalCriterionManual'
        };
        return t(keys[value] || keys.workspace_state);
      }
      function goalReason(goal) { return String(goal?.waitingReason || goal?.stopReason || goal?.currentStep || ''); }
      function setGoalActionFeedback(status, message) {
        goalActionFeedback = { status: String(status || ''), message: String(message || '') };
        goalActionFeedbackGoalId = String(state.goal?.id || '');
        var goal = state.goal && typeof state.goal === 'object' ? state.goal : null;
        if (goal && goalDialogMode === 'manage') renderGoalManager(goal);
        if (status === 'success') {
          var settledFeedback = goalActionFeedback;
          window.setTimeout(function() {
            if (goalActionFeedback !== settledFeedback) return;
            goalActionFeedback = null; goalActionFeedbackGoalId = '';
            var currentGoal = state.goal && typeof state.goal === 'object' ? state.goal : null;
            if (currentGoal && goalDialogMode === 'manage') renderGoalManager(currentGoal);
          }, 2400);
        }
      }
      function renderGeneratedCriteria() {
        if (!goalGeneratedCriteria) return;
        goalGeneratedCriteria.replaceChildren();
        var lines = goalLines(goalCriteria?.value);
        var generated = Array.isArray(goalDraft?.acceptanceCriteria) ? goalDraft.acceptanceCriteria : [];
        lines.forEach(function(text, index) {
          var source = generated[index];
          var type = source?.text === text ? source.type : goalCriterionType?.value || 'workspace_state';
          var evidence = source?.text === text ? source.evidenceRequirement : String(goalEvidence?.value || '').trim();
          var item = document.createElement('div'); item.className = 'goal-generated-criterion';
          var label = document.createElement('span'); label.className = 'goal-generated-type'; label.textContent = goalCriterionTypeLabel(type);
          var detail = document.createElement('span'); detail.className = 'goal-generated-evidence'; detail.textContent = evidence || t('goalEvidenceDefault');
          item.append(label, detail); goalGeneratedCriteria.append(item);
        });
      }
      function setGoalGenerationState(status, message) {
        goalDraftGenerationActive = status === 'generating';
        if (goalDraftGenerationStatus) goalDraftGenerationStatus.classList.toggle('hidden', status === 'idle');
        if (goalDraftGenerationText) goalDraftGenerationText.textContent = String(message || '');
        if (goalCancelGeneration) goalCancelGeneration.classList.toggle('hidden', !goalDraftGenerationActive);
        if (goalGenerateDraft) goalGenerateDraft.disabled = goalDraftGenerationActive;
        if (goalStart) goalStart.disabled = goalDraftGenerationActive || (!state.startup?.interactiveReady || state.isBusy);
        [goalObjective, goalCriteria, goalCriterionType, goalEvidence, goalIncludeScope, goalExcludeScope,
          goalValidationCompile, goalValidationLint, goalValidationTest, goalMaxActiveExecution, goalMaxCost,
          goalMaxRequests, goalMaxReviews, goalResumePolicy].forEach(function(control) {
            if (control) control.disabled = goalDraftGenerationActive;
          });
      }
      function renderGoalVisibleMessage() {
        if (!goalVisibleMessage) return;
        var objective = String(goalObjective?.value || '').trim();
        goalVisibleMessage.textContent = goalDraft?.visibleMessage && goalDraft.objective === objective
          ? goalDraft.visibleMessage : t('goalVisibleMessagePrefix', { objective: objective });
      }
      function renderGoalControls() {
        if (!goalButton) return;
        var goal = state.goal && typeof state.goal === 'object' ? state.goal : null;
        if (!goal && goalDialogMode === 'manage') {
          goalDialogOverlay?.classList.add('hidden'); goalDialogMode = null;
          window.setTimeout(function() { goalButton?.focus(); }, 0);
        }
        if (goalDialogTitle && goalDialogMode) {
          goalDialogTitle.textContent = t(goalDialogMode === 'manage' ? 'goalManageTitle' : 'goalCreateTitle');
        }
        var unavailable = !goal && (!state.startup?.interactiveReady || state.isBusy);
        if (goal && goalDialogMode === 'create') { showGoalManager(); return; }
        if (goalStart && goalDialogMode === 'create') goalStart.disabled = unavailable || goalDraftGenerationActive;
        var label = goal ? t('goalButtonManage') : t('goalButtonCreate');
        goalButton.disabled = unavailable;
        goalButton.title = unavailable ? t('goalButtonUnavailable') : label;
        goalButton.setAttribute('aria-label', unavailable ? t('goalButtonUnavailable') : label);
        goalButton.setAttribute('aria-expanded', goalDialogMode ? 'true' : 'false');
        goalButton.dataset.goalState = goal ? String(goal.status || 'preparing') : 'none';
        goalButton.classList.toggle('is-active', Boolean(goal));
        if (!goal) {
          if (goalHoverHeading) goalHoverHeading.textContent = t('goalButtonCreate');
          if (goalHoverObjective) goalHoverObjective.textContent = t('goalButtonCreateHint');
          if (goalHoverMeta) goalHoverMeta.textContent = '';
          if (goalHoverReason) { goalHoverReason.textContent = ''; goalHoverReason.classList.add('hidden'); }
          return;
        }
        if (goalHoverHeading) goalHoverHeading.textContent = goalStatusLabel(goal.status) + ' · r' + String(goal.revision || 1);
        if (goalHoverObjective) goalHoverObjective.textContent = String(goal.objective || '');
        if (goalHoverMeta) goalHoverMeta.textContent = t('goalActiveExecution') + ' ' + goalExecutionText(goal)
          + ' · ' + t('goalRequests') + ' ' + Number(goal.modelRequests || 0) + '/' + goalBudgetValue(goal.maxModelRequests);
        var reason = goalReason(goal);
        if (goalHoverReason) { goalHoverReason.textContent = reason; goalHoverReason.classList.toggle('hidden', !reason); }
        if (goalDialogMode === 'manage') renderGoalManager(goal);
      }
      function showGoalDialog(message) {
        if (!goalDialogOverlay) return;
        if (state.goal && typeof state.goal === 'object') { showGoalManager(); return; }
        goalDialogMode = 'create';
        goalDraft = message?.draft || {};
        if (goalDialogTitle) goalDialogTitle.textContent = t('goalCreateTitle');
        goalCreatePane?.classList.remove('hidden'); goalManagePane?.classList.add('hidden');
        goalCancel?.classList.remove('hidden'); goalStart?.classList.remove('hidden'); goalClose?.classList.add('hidden');
        if (goalObjective) goalObjective.value = String(goalDraft.objective || '');
        if (goalCriteria) goalCriteria.value = (Array.isArray(goalDraft.acceptanceCriteria) ? goalDraft.acceptanceCriteria : []).map(function(item) { return item.text || ''; }).join('\\n');
        if (goalCriterionType) goalCriterionType.value = goalDraft.acceptanceCriteria?.[0]?.type || 'workspace_state';
        if (goalEvidence) goalEvidence.value = goalDraft.acceptanceCriteria?.[0]?.evidenceRequirement || '';
        if (goalIncludeScope) goalIncludeScope.value = (goalDraft.includeScope || []).join('\\n');
        if (goalExcludeScope) goalExcludeScope.value = (goalDraft.excludeScope || []).join('\\n');
        var validations = Array.isArray(goalDraft.requiredValidations) ? goalDraft.requiredValidations : [];
        if (goalValidationCompile) goalValidationCompile.checked = validations.indexOf('compile') >= 0;
        if (goalValidationLint) goalValidationLint.checked = validations.indexOf('lint') >= 0;
        if (goalValidationTest) goalValidationTest.checked = validations.indexOf('test') >= 0;
        if (goalMaxActiveExecution) goalMaxActiveExecution.value = String(goalDraft.maxActiveExecutionMs || 0);
        if (goalMaxCost) goalMaxCost.value = String(goalDraft.maxCost || 0);
        if (goalMaxRequests) goalMaxRequests.value = String(goalDraft.maxModelRequests || 0);
        if (goalMaxReviews) goalMaxReviews.value = String(goalDraft.maxCompletionReviews || 0);
        if (goalResumePolicy) goalResumePolicy.value = goalDraft.resumePolicy === 'auto_on_activation' ? 'auto_on_activation' : 'manual';
        if (goalLifecycleNotice) goalLifecycleNotice.textContent = String(goalDraft.lifecycleNotice || '');
        goalDialogError?.classList.add('hidden'); renderGoalVisibleMessage(); renderGeneratedCriteria();
        setGoalGenerationState(String(goalDraft.generationStatus || 'idle'), String(goalDraft.generationMessage || ''));
        goalDialogOverlay.classList.remove('hidden'); renderGoalControls();
        window.setTimeout(function() { (goalDraftGenerationActive ? goalCancelGeneration : goalObjective)?.focus(); }, 0);
      }
      function showGoalManager() {
        var goal = state.goal && typeof state.goal === 'object' ? state.goal : null;
        if (!goal || !goalDialogOverlay) return;
        goalDialogMode = 'manage'; goalDraft = null;
        if (goalDialogTitle) goalDialogTitle.textContent = t('goalManageTitle');
        goalCreatePane?.classList.add('hidden'); goalManagePane?.classList.remove('hidden');
        goalCancel?.classList.add('hidden'); goalStart?.classList.add('hidden'); goalClose?.classList.remove('hidden');
        renderGoalManager(goal); goalDialogOverlay.classList.remove('hidden'); renderGoalControls();
        window.setTimeout(function() {
          var firstAction = [goalPause, goalResume, goalStop, goalClear, goalAmendInput, goalClose].find(function(item) {
            return item && !item.classList.contains('hidden') && !item.disabled;
          });
          firstAction?.focus();
        }, 0);
      }
      function renderGoalManager(goal) {
        if (!goal || goalDialogMode !== 'manage') return;
        if (goalActionFeedbackGoalId && goalActionFeedbackGoalId !== String(goal.id || '')) {
          goalActionFeedback = null; goalActionFeedbackGoalId = '';
        }
        if (goalManageObjective) goalManageObjective.textContent = String(goal.objective || '');
        if (goalManageStatus) goalManageStatus.textContent = goalStatusLabel(goal.status) + ' · r' + String(goal.revision || 1);
        if (goalManageMeta) goalManageMeta.textContent = [
          t('goalActiveExecution') + ': ' + goalExecutionText(goal),
          t('goalRequests') + ': ' + Number(goal.modelRequests || 0) + ' / ' + goalBudgetValue(goal.maxModelRequests),
          t('goalReviews') + ': ' + Number(goal.completionReviews || 0) + ' / ' + goalBudgetValue(goal.maxCompletionReviews),
          t('goalCost') + ': ' + goalCosts(goal) + ' / ' + goalBudgetValue(goal.maxCost),
          String(goal.modelId || ''), String(goal.approvalMode || '')
        ].filter(Boolean).join(' · ');
        var reason = goalActionFeedback?.message || goalReason(goal);
        if (goalManageReason) {
          goalManageReason.textContent = reason;
          goalManageReason.classList.toggle('hidden', !reason);
          goalManageReason.classList.toggle('is-error', goalActionFeedback?.status === 'error');
          goalManageReason.classList.toggle('is-pending', goalActionFeedback?.status === 'pending');
        }
        if (goalManageCriteria) {
          goalManageCriteria.replaceChildren();
          (Array.isArray(goal.criteria) ? goal.criteria : []).forEach(function(criterion) {
            var item = document.createElement('li'); item.className = 'is-' + String(criterion.status || 'pending');
            item.textContent = (criterion.status === 'satisfied' ? '✓ ' : criterion.status === 'blocked' ? '! ' : '○ ')
              + String(criterion.text || '') + ' [' + String(criterion.type || '') + ']';
            if (criterion.type === 'manual' && criterion.status !== 'satisfied' && !goal.canClear) {
              var confirmCriterion = document.createElement('button'); confirmCriterion.type = 'button';
              confirmCriterion.className = 'goal-confirm-criterion secondary'; confirmCriterion.textContent = t('goalConfirmCriterion');
              confirmCriterion.addEventListener('click', function() {
                confirmCriterion.disabled = true;
                vscode.postMessage({ type: 'goalConfirmCriterion', criterionId: String(criterion.id || '') });
              });
              item.append(' ', confirmCriterion);
            }
            goalManageCriteria.append(item);
          });
        }
        if (goalManageValidations) {
          goalManageValidations.replaceChildren();
          (Array.isArray(goal.requiredValidations) ? goal.requiredValidations : []).forEach(function(validation) {
            var item = document.createElement('li'); item.className = 'is-' + String(validation.status || 'pending');
            item.textContent = (validation.status === 'passed' ? '✓ ' : validation.status === 'failed' ? '! ' : '○ ')
              + String(validation.script || ''); goalManageValidations.append(item);
          });
          goalManageValidations.parentElement?.classList.toggle('hidden', !goal.requiredValidations?.length);
        }
        if (goalPause) { goalPause.classList.toggle('hidden', !goal.canPause); goalPause.disabled = state.isBusy && goal.status !== 'running'; }
        if (goalResume) {
          goalResume.classList.toggle('hidden', !goal.canResume);
          goalResume.disabled = state.isBusy || goalActionFeedback?.status === 'pending';
        }
        if (goalStop) { goalStop.classList.toggle('hidden', !goal.canStop); goalStop.disabled = false; }
        if (goalStop) goalStop.textContent = t(goal.status === 'preparing' ? 'goalCancelRunning' : 'goalStop');
        if (goalClear) { goalClear.classList.toggle('hidden', !goal.canClear); goalClear.disabled = false; }
        if (goalAmendRow) goalAmendRow.classList.toggle('hidden', goal.canClear);
      }
      function hideGoalDialog() {
        if (goalDraftGenerationActive) vscode.postMessage({ type: 'cancelGoalDraftGeneration' });
        goalDialogOverlay?.classList.add('hidden'); goalDialogMode = null; goalDraft = null;
        goalDraftGenerationActive = false;
        renderGoalControls(); goalButton?.focus();
      }
      function postGoalAction(button, message) {
        if (button) button.disabled = true;
        if (message?.type === 'goalResume') setGoalActionFeedback('pending', t('goalResumePending'));
        vscode.postMessage(message);
      }

      goalButton?.addEventListener('click', function() {
        closeCommandMenu(); closeReferenceMenu(false);
        if (state.goal && typeof state.goal === 'object') showGoalManager();
        else {
          sanitizePromptContent();
          vscode.postMessage({
            type: 'openGoalDialog', objective: serializePrompt(), sourceId: state.selectedSourceId,
            modelId: state.selectedModelId, references: collectPromptFileReferences(), skillIds: collectActiveSkillIds()
          });
        }
      });
      goalObjective?.addEventListener('input', function() {
        renderGoalVisibleMessage();
        if (goalDraft && String(goalObjective?.value || '').trim() !== String(goalDraft.objective || '').trim()) {
          goalDraft.acceptanceCriteria = [];
          setGoalGenerationState('cancelled', t('goalObjectiveChanged'));
          renderGeneratedCriteria();
        }
      });
      goalCriteria?.addEventListener('input', renderGeneratedCriteria);
      goalCriterionType?.addEventListener('change', renderGeneratedCriteria);
      goalEvidence?.addEventListener('input', renderGeneratedCriteria);
      goalGenerateDraft?.addEventListener('click', function() {
        var objective = String(goalObjective?.value || '').trim();
        if (!objective || objective.length > 20000) {
          if (goalDialogError) { goalDialogError.textContent = t('goalObjectiveRequired'); goalDialogError.classList.remove('hidden'); }
          return;
        }
        vscode.postMessage({
          type: 'generateGoalDraft', objective: objective,
          sourceId: String(goalDraft?.sourceId || state.selectedSourceId || ''),
          modelId: String(goalDraft?.modelId || state.selectedModelId || '')
        });
      });
      goalCancelGeneration?.addEventListener('click', function() { vscode.postMessage({ type: 'cancelGoalDraftGeneration' }); });
      goalCancel?.addEventListener('click', hideGoalDialog); goalClose?.addEventListener('click', hideGoalDialog);
      goalDialogOverlay?.addEventListener('mousedown', function(event) { if (event.target === goalDialogOverlay) hideGoalDialog(); });
      goalDialogOverlay?.addEventListener('keydown', function(event) { if (event.key === 'Escape') { event.preventDefault(); hideGoalDialog(); } });
      goalPause?.addEventListener('click', function() { postGoalAction(goalPause, { type: 'goalPause' }); });
      goalResume?.addEventListener('click', function() { postGoalAction(goalResume, { type: 'goalResume' }); });
      goalStop?.addEventListener('click', function() { postGoalAction(goalStop, { type: 'goalStop' }); });
      goalClear?.addEventListener('click', function() { postGoalAction(goalClear, { type: 'goalClear' }); });
      goalAmend?.addEventListener('click', function() {
        var instruction = String(goalAmendInput?.value || '').trim(); if (!instruction) return;
        postGoalAction(goalAmend, { type: 'goalAmend', instruction: instruction });
        if (goalAmendInput) goalAmendInput.value = '';
      });
      goalAmendInput?.addEventListener('keydown', function(event) {
        if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); goalAmend?.click(); }
      });
      goalStart?.addEventListener('click', function() {
        var objective = String(goalObjective?.value || '').trim(); var criteria = goalLines(goalCriteria?.value);
        if (!objective || objective.length > 20000 || !criteria.length) {
          if (goalDialogError) { goalDialogError.textContent = !criteria.length ? t('goalCriteriaRequired') : t('goalObjectiveRequired'); goalDialogError.classList.remove('hidden'); }
          return;
        }
        var criterionType = ['validation', 'workspace_state', 'artifact', 'manual'].indexOf(goalCriterionType?.value) >= 0 ? goalCriterionType.value : 'workspace_state';
        var evidence = String(goalEvidence?.value || '').trim() || 'Current evidence bound to the complete Goal manifest.';
        var generatedCriteria = Array.isArray(goalDraft?.acceptanceCriteria) ? goalDraft.acceptanceCriteria : [];
        var validations = [];
        if (goalValidationCompile?.checked) validations.push('compile'); if (goalValidationLint?.checked) validations.push('lint'); if (goalValidationTest?.checked) validations.push('test');
        postGoalAction(goalStart, {
          type: 'startGoal', objective: objective,
          acceptanceCriteria: criteria.map(function(text, index) {
            var generated = generatedCriteria[index];
            return generated?.text === text
              ? { text: text, type: generated.type, evidenceRequirement: generated.evidenceRequirement }
              : { text: text, type: criterionType, evidenceRequirement: evidence };
          }),
          includeScope: goalLines(goalIncludeScope?.value), excludeScope: goalLines(goalExcludeScope?.value), requiredValidations: validations,
          maxActiveExecutionMs: goalNumber(goalMaxActiveExecution), maxCost: goalNumber(goalMaxCost),
          maxModelRequests: Math.floor(goalNumber(goalMaxRequests)), maxCompletionReviews: Math.floor(goalNumber(goalMaxReviews)),
          resumePolicy: goalResumePolicy?.value === 'auto_on_activation' ? 'auto_on_activation' : 'manual',
          sourceId: String(goalDraft?.sourceId || state.selectedSourceId || ''), modelId: String(goalDraft?.modelId || state.selectedModelId || '')
        });
      });
      window.keepseekGoalDialog = {
        show: showGoalDialog, showManager: showGoalManager, sync: renderGoalControls,
        setGenerationState: setGoalGenerationState, setActionFeedback: setGoalActionFeedback
      };
`.slice(1)
};
