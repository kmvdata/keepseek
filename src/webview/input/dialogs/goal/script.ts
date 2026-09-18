import type { WebviewFragment } from '../../composition';

export const goalDialogScriptFragment: WebviewFragment = {
  id: 'dialogs.goal.script',
  source: `
      var goalDialogOverlay = document.getElementById('goalDialogOverlay');
      var goalDialogTitle = document.getElementById('goalDialogTitle');
      var goalObjective = document.getElementById('goalObjective');
      var goalDraftGenerationStatus = document.getElementById('goalDraftGenerationStatus');
      var goalDraftGenerationText = document.getElementById('goalDraftGenerationText');
      var goalCancelGeneration = document.getElementById('goalCancelGeneration');
      var goalGenerateDraft = document.getElementById('goalGenerateDraft');
      var goalProposalWorkItems = document.getElementById('goalProposalWorkItems');
      var goalProposalSelectionSummary = document.getElementById('goalProposalSelectionSummary');
      var goalProposalLive = document.getElementById('goalProposalLive');
      var goalSelectAll = document.getElementById('goalSelectAll');
      var goalSelectNone = document.getElementById('goalSelectNone');
      var goalApprovalModeNotice = document.getElementById('goalApprovalModeNotice');
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
      var goalCancel = document.getElementById('goalCancel');
      var goalStart = document.getElementById('goalStart');
      var goalDraft = null;
      var goalProposalSelection = new Set();
      var goalProposalSelectionHash = '';
      var goalDraftGenerationActive = false;
      var goalObjectiveEdited = false;
      var goalLastInvalidatedObjective = '';
      var goalAvailableValidations = [];

      function goalDialogInteger(value) {
        var parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
      }
      function goalDialogNumber(value) {
        var parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
      }
      function goalDialogLines(value) {
        return String(value || '').split(/\\r?\\n/gu).map(function(item) { return item.trim(); }).filter(Boolean);
      }
      function currentGoalProposal() {
        return state.goalProposal?.proposal && typeof state.goalProposal.proposal === 'object'
          ? state.goalProposal.proposal : goalDraft?.proposal || null;
      }
      function currentGoalSettings() {
        return {
          includeScope: goalDialogLines(goalIncludeScope?.value),
          excludeScope: goalDialogLines(goalExcludeScope?.value),
          requiredValidations: [
            goalValidationCompile?.checked ? 'compile' : '',
            goalValidationLint?.checked ? 'lint' : '',
            goalValidationTest?.checked ? 'test' : ''
          ].filter(Boolean),
          maxActiveExecutionMs: goalDialogInteger(goalMaxActiveExecution?.value),
          maxCost: goalDialogNumber(goalMaxCost?.value),
          maxModelRequests: goalDialogInteger(goalMaxRequests?.value),
          maxCompletionReviews: goalDialogInteger(goalMaxReviews?.value),
          resumePolicy: goalResumePolicy?.value === 'auto_on_activation' ? 'auto_on_activation' : 'manual',
          sourceId: String(goalDraft?.sourceId || state.selectedSourceId || ''),
          modelId: String(goalDraft?.modelId || state.selectedModelId || '')
        };
      }
      function renderGoalVisibleMessage() {
        if (goalVisibleMessage) goalVisibleMessage.textContent = t('goalVisibleMessagePrefix', {
          objective: String(goalObjective?.value || '').trim()
        });
      }
      function renderGeneratedCriteria() {
        if (!goalGeneratedCriteria) return;
        var proposal = currentGoalProposal();
        var criteria = (proposal?.workItems || []).flatMap(function(item) { return item.acceptanceCriteria || []; });
        goalGeneratedCriteria.replaceChildren();
        criteria.forEach(function(criterion) {
          var row = document.createElement('div'); row.className = 'goal-generated-criterion';
          var text = document.createElement('strong'); text.textContent = String(criterion.text || '');
          var detail = document.createElement('span'); detail.textContent = String(criterion.type || '') + ' · ' + String(criterion.evidenceRequirement || '');
          row.append(text, detail); goalGeneratedCriteria.append(row);
        });
        goalGeneratedCriteria.classList.toggle('hidden', !criteria.length);
      }
      function setGoalProposalItemSelected(id, selected) {
        var proposal = currentGoalProposal();
        if (!proposal) return;
        var items = proposal.workItems || [];
        var byId = new Map(items.map(function(item) { return [String(item.id || ''), item]; }));
        if (!byId.has(id)) return;
        function selectWithDependencies(itemId) {
          if (!byId.has(itemId) || goalProposalSelection.has(itemId)) return;
          goalProposalSelection.add(itemId);
          (byId.get(itemId).dependsOn || []).forEach(function(dependency) { selectWithDependencies(String(dependency)); });
        }
        function unselectWithDependents(itemId) {
          goalProposalSelection.delete(itemId);
          items.filter(function(item) { return (item.dependsOn || []).map(String).includes(itemId); })
            .forEach(function(item) { unselectWithDependents(String(item.id || '')); });
        }
        if (selected) {
          selectWithDependencies(id);
        } else {
          unselectWithDependents(id);
        }
        renderGoalProposalWorkItems();
        refreshGoalTranscriptCard();
      }
      function renderGoalProposalWorkItems() {
        if (!goalProposalWorkItems) return;
        var proposal = currentGoalProposal();
        var hash = String(proposal?.proposalHash || '');
        if (hash && goalProposalSelectionHash !== hash) {
          goalProposalSelectionHash = hash;
          goalProposalSelection = new Set(Array.isArray(state.goalProposal?.selectedWorkItemIds)
            ? state.goalProposal.selectedWorkItemIds.map(String)
            : (proposal?.workItems || []).map(function(item) { return String(item.id || ''); }));
        }
        goalProposalWorkItems.replaceChildren();
        (proposal?.workItems || []).forEach(function(workItem) {
          var id = String(workItem.id || '');
          var label = document.createElement('label'); label.className = 'goal-proposal-work-item';
          var checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = goalProposalSelection.has(id);
          checkbox.disabled = goalDraftGenerationActive; checkbox.dataset.goalWorkItemId = id;
          checkbox.addEventListener('change', function() { setGoalProposalItemSelected(id, checkbox.checked); });
          var copy = document.createElement('span');
          var title = document.createElement('strong'); title.textContent = String(workItem.title || id);
          var detail = document.createElement('span'); detail.textContent = String(workItem.detail || '');
          copy.append(title, detail); label.append(checkbox, copy); goalProposalWorkItems.append(label);
        });
        if (goalProposalSelectionSummary) goalProposalSelectionSummary.textContent = t('goalSelectionSummary', {
          selected: goalProposalSelection.size, total: (proposal?.workItems || []).length
        });
        if (goalStart) goalStart.disabled = goalDraftGenerationActive || (!goalObjectiveEdited && goalProposalSelection.size < 1);
      }
      function setGoalGenerationState(status, message) {
        goalDraftGenerationActive = status === 'generating';
        if (goalDraftGenerationText) goalDraftGenerationText.textContent = String(message || '');
        goalDraftGenerationStatus?.classList.toggle('hidden', !message && !goalDraftGenerationActive);
        goalCancelGeneration?.classList.toggle('hidden', !goalDraftGenerationActive);
        if (goalGenerateDraft) goalGenerateDraft.disabled = goalDraftGenerationActive;
        [[goalValidationCompile, 'compile'], [goalValidationLint, 'lint'], [goalValidationTest, 'test']]
          .forEach(function(entry) {
            if (entry[0]) entry[0].disabled = goalDraftGenerationActive
              || (!entry[0].checked && !goalAvailableValidations.includes(entry[1]));
          });
        renderGoalProposalWorkItems();
      }
      function populateGoalDialog(draft) {
        goalDraft = draft || {};
        var proposal = state.goalProposal?.proposal || goalDraft.proposal || null;
        goalObjectiveEdited = false;
        goalLastInvalidatedObjective = '';
        if (goalDialogTitle) goalDialogTitle.textContent = t('goalCreateTitle');
        if (goalObjective) goalObjective.value = String(proposal?.objective || goalDraft.objective || '');
        if (goalCriteria) goalCriteria.value = '';
        if (goalCriterionType) goalCriterionType.value = 'workspace_state';
        if (goalEvidence) goalEvidence.value = '';
        if (goalIncludeScope) goalIncludeScope.value = (proposal?.includeScope || goalDraft.includeScope || []).join('\\n');
        if (goalExcludeScope) goalExcludeScope.value = (proposal?.excludeScope || goalDraft.excludeScope || []).join('\\n');
        var validations = proposal?.requiredValidations || goalDraft.requiredValidations || [];
        goalAvailableValidations = Array.isArray(goalDraft.availableValidations)
          ? goalDraft.availableValidations.map(String)
          : (Array.isArray(state.backgroundAvailableScripts) ? state.backgroundAvailableScripts.map(String) : []);
        if (goalValidationCompile) goalValidationCompile.checked = validations.includes('compile');
        if (goalValidationLint) goalValidationLint.checked = validations.includes('lint');
        if (goalValidationTest) goalValidationTest.checked = validations.includes('test');
        if (goalMaxActiveExecution) goalMaxActiveExecution.value = String(goalDraft.maxActiveExecutionMs ?? state.goalDefaults?.maxActiveExecutionMs ?? 0);
        if (goalMaxCost) goalMaxCost.value = String(goalDraft.maxCost ?? state.goalDefaults?.maxCost ?? 0);
        if (goalMaxRequests) goalMaxRequests.value = String(goalDraft.maxModelRequests ?? state.goalDefaults?.maxModelRequests ?? 0);
        if (goalMaxReviews) goalMaxReviews.value = String(goalDraft.maxCompletionReviews ?? state.goalDefaults?.maxCompletionReviews ?? 0);
        if (goalResumePolicy) goalResumePolicy.value = goalDraft.resumePolicy || (state.goalDefaults?.autoResumeOnActivation ? 'auto_on_activation' : 'manual');
        if (goalApprovalModeNotice) goalApprovalModeNotice.textContent = t('goalApprovalModeNotice', { mode: state.approvalMode || 'ask' });
        if (goalLifecycleNotice) goalLifecycleNotice.textContent = String(goalDraft.lifecycleNotice || '');
        goalDialogError?.classList.add('hidden');
        renderGoalVisibleMessage(); renderGoalProposalWorkItems(); renderGeneratedCriteria();
        setGoalGenerationState(String(state.goalProposal?.generationStatus || goalDraft.generationStatus || 'idle'), String(state.goalProposal?.generationMessage || goalDraft.generationMessage || ''));
      }
      function showGoalDialog(message) {
        if (!goalDialogOverlay) return;
        populateGoalDialog(message?.draft || {});
        goalDialogOverlay.classList.remove('hidden');
        window.setTimeout(function() { goalObjective?.focus(); }, 0);
      }
      function openGoalProposalFromState() {
        var pending = state.goalProposal;
        if (!pending?.proposal) return;
        showGoalDialog({ draft: {
          objective: String(pending.proposal.objective || ''), proposal: pending.proposal,
          includeScope: pending.proposal.includeScope || [], excludeScope: pending.proposal.excludeScope || [],
          requiredValidations: pending.proposal.requiredValidations || [],
          availableValidations: state.backgroundAvailableScripts || [],
          maxActiveExecutionMs: state.goalDefaults?.maxActiveExecutionMs || 0,
          maxCost: state.goalDefaults?.maxCost || 0,
          maxModelRequests: state.goalDefaults?.maxModelRequests || 0,
          maxCompletionReviews: state.goalDefaults?.maxCompletionReviews || 0,
          resumePolicy: state.goalDefaults?.autoResumeOnActivation ? 'auto_on_activation' : 'manual',
          sourceId: state.selectedSourceId, modelId: state.selectedModelId,
          generationStatus: pending.generationStatus, generationMessage: pending.generationMessage
        } });
      }
      function hideGoalDialog() {
        if (goalDraftGenerationActive) vscode.postMessage({ type: 'cancelGoalDraftGeneration' });
        goalDialogOverlay?.classList.add('hidden');
        goalDraft = null; goalDraftGenerationActive = false;
      }
      function postGoalProposalAdoption() {
        var proposal = currentGoalProposal();
        var settings = currentGoalSettings();
        if (!proposal || goalProposalSelection.size < 1) return false;
        vscode.postMessage({
          type: 'adoptGoalProposal', proposalHash: String(proposal.proposalHash || ''),
          selectedWorkItemIds: Array.from(goalProposalSelection), ...settings
        });
        hideGoalDialog(); return true;
      }

      goalObjective?.addEventListener('input', function() {
        renderGoalVisibleMessage();
        var objective = String(goalObjective.value || '').trim();
        var bound = String(currentGoalProposal()?.objective || '').trim();
        if (objective && objective !== bound && objective !== goalLastInvalidatedObjective) {
          goalObjectiveEdited = true; goalLastInvalidatedObjective = objective;
          goalProposalSelection.clear();
          vscode.postMessage({ type: 'invalidateGoalProposal', objective: objective });
          setGoalGenerationState('cancelled', t('goalObjectiveChanged'));
        }
      });
      goalGenerateDraft?.addEventListener('click', function() {
        var objective = String(goalObjective?.value || '').trim();
        if (!objective || objective.length > 20000) {
          if (goalDialogError) { goalDialogError.textContent = t('goalObjectiveRequired'); goalDialogError.classList.remove('hidden'); }
          return;
        }
        goalObjectiveEdited = false;
        vscode.postMessage({ type: 'generateGoalDraft', objective: objective, sourceId: state.selectedSourceId, modelId: state.selectedModelId });
      });
      goalCancelGeneration?.addEventListener('click', function() { vscode.postMessage({ type: 'cancelGoalDraftGeneration' }); });
      goalSelectAll?.addEventListener('click', function() {
        goalProposalSelection = new Set((currentGoalProposal()?.workItems || []).map(function(item) { return String(item.id || ''); }));
        renderGoalProposalWorkItems(); refreshGoalTranscriptCard();
      });
      goalSelectNone?.addEventListener('click', function() { goalProposalSelection.clear(); renderGoalProposalWorkItems(); refreshGoalTranscriptCard(); });
      goalCancel?.addEventListener('click', hideGoalDialog);
      goalDialogOverlay?.addEventListener('mousedown', function(event) { if (event.target === goalDialogOverlay) hideGoalDialog(); });
      goalDialogOverlay?.addEventListener('keydown', function(event) { if (event.key === 'Escape') { event.preventDefault(); hideGoalDialog(); } });
      goalStart?.addEventListener('click', function() {
        var objective = String(goalObjective?.value || '').trim();
        if (!objective || objective.length > 20000) return;
        if (goalObjectiveEdited) {
          vscode.postMessage({ type: 'adoptGoalOriginal', ...currentGoalSettings() });
          hideGoalDialog();
        } else postGoalProposalAdoption();
      });

      window.keepseekGoalDialog = {
        show: showGoalDialog,
        sync: function() {
          if (!goalDialogOverlay || goalDialogOverlay.classList.contains('hidden')) return;
          if (state.goalProposal?.proposal && !goalObjectiveEdited) {
            goalDraft = { ...(goalDraft || {}), proposal: state.goalProposal.proposal };
            setGoalGenerationState(state.goalProposal.generationStatus, state.goalProposal.generationMessage);
            renderGoalProposalWorkItems(); renderGeneratedCriteria();
          }
        },
        openProposalFromState: openGoalProposalFromState,
        setSelection: setGoalProposalItemSelected,
        getSelection: function(hash) { return hash === goalProposalSelectionHash ? Array.from(goalProposalSelection) : null; },
        adoptFromState: postGoalProposalAdoption,
        setGenerationState: setGoalGenerationState,
        setActionFeedback: function() {}
      };
`.slice(1)
};
