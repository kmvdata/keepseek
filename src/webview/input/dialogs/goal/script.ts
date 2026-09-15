import type { WebviewFragment } from '../../composition';

export const goalDialogScriptFragment: WebviewFragment = {
  id: 'dialogs.goal.script',
  source: `
      var goalDialogOverlay = document.getElementById('goalDialogOverlay');
      var goalObjective = document.getElementById('goalObjective');
      var goalCriteria = document.getElementById('goalCriteria');
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
      var goalVisibleCommand = document.getElementById('goalVisibleCommand');
      var goalLifecycleNotice = document.getElementById('goalLifecycleNotice');
      var goalDialogError = document.getElementById('goalDialogError');
      var goalStart = document.getElementById('goalStart');
      var goalCancel = document.getElementById('goalCancel');
      var goalDraft = null;

      function goalLines(value) { return String(value || '').split(/\\r?\\n/u).map(function(line) { return line.trim(); }).filter(Boolean); }
      function goalNumber(element) { var value = Number(element?.value || 0); return Number.isFinite(value) && value > 0 ? value : 0; }
      function renderGoalVisibleCommand() {
        if (!goalVisibleCommand) return;
        var objective = String(goalObjective?.value || '').trim();
        goalVisibleCommand.textContent = goalDraft?.visibleCommand && goalDraft.objective === objective ? goalDraft.visibleCommand : '/goal ' + objective;
      }
      function showGoalDialog(message) {
        if (!goalDialogOverlay) return;
        goalDraft = message?.draft || {};
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
        goalDialogError?.classList.add('hidden'); renderGoalVisibleCommand(); goalDialogOverlay.classList.remove('hidden');
        window.setTimeout(function() { goalObjective?.focus(); }, 0);
      }
      function hideGoalDialog() { goalDialogOverlay?.classList.add('hidden'); goalDraft = null; promptInput?.focus(); }
      goalObjective?.addEventListener('input', renderGoalVisibleCommand);
      goalCancel?.addEventListener('click', hideGoalDialog);
      goalDialogOverlay?.addEventListener('mousedown', function(event) { if (event.target === goalDialogOverlay) hideGoalDialog(); });
      goalDialogOverlay?.addEventListener('keydown', function(event) { if (event.key === 'Escape') { event.preventDefault(); hideGoalDialog(); } });
      goalStart?.addEventListener('click', function() {
        var objective = String(goalObjective?.value || '').trim(); var criteria = goalLines(goalCriteria?.value);
        if (!objective || objective.length > 20000 || !criteria.length) {
          if (goalDialogError) { goalDialogError.textContent = !criteria.length ? t('goalCriteriaRequired') : t('goalObjectiveRequired'); goalDialogError.classList.remove('hidden'); }
          return;
        }
        var criterionType = ['validation', 'workspace_state', 'artifact', 'manual'].indexOf(goalCriterionType?.value) >= 0 ? goalCriterionType.value : 'workspace_state';
        var evidence = String(goalEvidence?.value || '').trim() || 'Current evidence bound to the complete Goal manifest.';
        var validations = [];
        if (goalValidationCompile?.checked) validations.push('compile'); if (goalValidationLint?.checked) validations.push('lint'); if (goalValidationTest?.checked) validations.push('test');
        vscode.postMessage({
          type: 'startGoal', objective: objective,
          acceptanceCriteria: criteria.map(function(text) { return { text: text, type: criterionType, evidenceRequirement: evidence }; }),
          includeScope: goalLines(goalIncludeScope?.value), excludeScope: goalLines(goalExcludeScope?.value), requiredValidations: validations,
          maxActiveExecutionMs: goalNumber(goalMaxActiveExecution), maxCost: goalNumber(goalMaxCost),
          maxModelRequests: Math.floor(goalNumber(goalMaxRequests)), maxCompletionReviews: Math.floor(goalNumber(goalMaxReviews)),
          resumePolicy: goalResumePolicy?.value === 'auto_on_activation' ? 'auto_on_activation' : 'manual',
          sourceId: String(goalDraft?.sourceId || state.selectedSourceId || ''), modelId: String(goalDraft?.modelId || state.selectedModelId || '')
        });
        hideGoalDialog();
      });
      window.keepseekGoalDialog = { show: showGoalDialog };
`.slice(1)
};
