export function getGoalTranscriptScript(): string {
  return `
    function goalTranscriptStatusLabel(value) {
      var key = 'goalStatus_' + String(value || 'preparing');
      var label = t(key);
      return label === key ? String(value || '').replace(/_/gu, ' ') : label;
    }

    function goalTranscriptBudgetValue(value) {
      return Number(value || 0) > 0 ? String(value) : '∞';
    }

    function goalTranscriptExecutionText(goal) {
      var used = Math.floor(Number(goal?.activeExecutionMs || 0) / 1000) + 's';
      var limit = Number(goal?.maxActiveExecutionMs || 0) > 0
        ? Math.floor(Number(goal.maxActiveExecutionMs) / 1000) + 's'
        : '∞';
      return used + ' / ' + limit;
    }

    function goalTranscriptCurrentStep(goal) {
      var explicit = String(goal?.waitingReason || goal?.stopReason || goal?.currentActivity?.text || goal?.currentStep || '').trim();
      if (explicit) return explicit;
      var plan = state.taskPlan && typeof state.taskPlan === 'object' ? state.taskPlan : null;
      var planStep = Array.isArray(plan?.steps)
        ? plan.steps.find(function(step) { return step.id === plan.currentStepId; })
        : null;
      if (planStep?.title) return String(planStep.title);
      if (goal?.status === 'running' && state.isBusy) {
        return getAgentActivityStatusText(normalizeAgentActivity(state.agentActivity)) || t('goalTranscriptWorking');
      }
      return goalTranscriptStatusLabel(goal?.status);
    }

    function restoreGoalProposalFocus(selector) {
      window.setTimeout(function() { document.querySelector(selector)?.focus(); }, 0);
    }

    function createGoalProposalTranscriptCard(pending) {
      var proposal = pending?.proposal;
      if (!proposal) return null;
      var hash = String(proposal.proposalHash || '');
      if (goalProposalSelectionHash !== hash) {
        goalProposalSelectionHash = hash;
        goalProposalSelection = new Set(Array.isArray(pending.selectedWorkItemIds)
          ? pending.selectedWorkItemIds.map(String)
          : (proposal.workItems || []).map(function(item) { return String(item.id || ''); }));
      }
      var card = document.createElement('section'); card.className = 'goal-transcript-card goal-proposal-card';
      card.dataset.goalProposalCard = 'true'; card.setAttribute('aria-label', t('goalProposalReviewTitle'));
      var header = document.createElement('div'); header.className = 'goal-transcript-header';
      var heading = document.createElement('div'); heading.className = 'goal-transcript-heading';
      var title = document.createElement('strong'); title.textContent = t('goalProposalReviewTitle');
      var status = document.createElement('span'); status.className = 'goal-transcript-status';
      status.textContent = t('goalSelectionSummary', { selected: goalProposalSelection.size, total: (proposal.workItems || []).length });
      heading.append(title, status);
      var review = document.createElement('button'); review.type = 'button'; review.className = 'secondary goal-transcript-manage';
      review.textContent = t('goalReviewProposal'); review.addEventListener('click', function() { window.keepseekGoalDialog?.openProposalFromState(); });
      header.append(heading, review); card.append(header);
      var objective = document.createElement('div'); objective.className = 'goal-transcript-objective'; objective.textContent = String(proposal.objective || ''); card.append(objective);
      var items = document.createElement('div'); items.className = 'goal-transcript-proposal-items';
      (proposal.workItems || []).forEach(function(workItem) {
        var id = String(workItem.id || ''); var selected = goalProposalSelection.has(id);
        var label = document.createElement('label'); label.className = 'goal-transcript-proposal-item' + (selected ? '' : ' is-unselected');
        var input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected;
        input.disabled = pending.generationStatus === 'generating';
        input.dataset.goalWorkItemId = id;
        input.setAttribute('aria-label', t('goalWorkItemCheckbox', { title: String(workItem.title || id) }));
        input.addEventListener('change', function() {
          setGoalProposalItemSelected(id, input.checked);
          restoreGoalProposalFocus('[data-goal-proposal-card] input[data-goal-work-item-id="' + id + '"]');
        });
        var copy = document.createElement('span');
        var name = document.createElement('strong'); name.textContent = String(workItem.title || id);
        var detail = document.createElement('span'); detail.textContent = String(workItem.detail || '');
        var criteria = document.createElement('small');
        criteria.textContent = (workItem.acceptanceCriteria || []).map(function(criterion) {
          return String(criterion.text || '');
        }).filter(Boolean).join(' · ');
        var stateText = document.createElement('small'); stateText.textContent = t(selected ? 'goalWorkItemInScope' : 'goalWorkItemOutOfScope');
        copy.append(name, detail, criteria, stateText); label.append(input, copy); items.append(label);
      });
      card.append(items);
      var actions = document.createElement('div'); actions.className = 'goal-transcript-proposal-actions';
      var all = document.createElement('button'); all.type = 'button'; all.className = 'secondary'; all.textContent = t('goalSelectAll');
      all.disabled = pending.generationStatus === 'generating';
      all.dataset.goalProposalAction = 'all';
      all.addEventListener('click', function() {
        goalProposalSelection = new Set((proposal.workItems || []).map(function(item) { return String(item.id || ''); })); refreshGoalTranscriptCard();
        restoreGoalProposalFocus('[data-goal-proposal-card] [data-goal-proposal-action="all"]');
      });
      var none = document.createElement('button'); none.type = 'button'; none.className = 'secondary'; none.textContent = t('goalSelectNone');
      none.disabled = pending.generationStatus === 'generating';
      none.dataset.goalProposalAction = 'none';
      none.addEventListener('click', function() {
        goalProposalSelection.clear(); refreshGoalTranscriptCard();
        restoreGoalProposalFocus('[data-goal-proposal-card] [data-goal-proposal-action="none"]');
      });
      var regenerate = document.createElement('button'); regenerate.type = 'button'; regenerate.className = 'secondary'; regenerate.textContent = t('goalRegenerate');
      regenerate.disabled = pending.generationStatus === 'generating';
      regenerate.addEventListener('click', function() {
        vscode.postMessage({ type: 'generateGoalDraft', objective: String(proposal.objective || ''), sourceId: state.selectedSourceId, modelId: state.selectedModelId });
      });
      var discard = document.createElement('button'); discard.type = 'button'; discard.className = 'secondary'; discard.textContent = t('goalDiscardProposal');
      discard.addEventListener('click', function() { vscode.postMessage({ type: 'discardGoalProposal' }); state.goalProposal = null; refreshGoalTranscriptCard(); goalButton?.focus(); });
      var adopt = document.createElement('button'); adopt.type = 'button'; adopt.textContent = t('goalAdoptSelected');
      adopt.disabled = goalProposalSelection.size < 1 || pending.generationStatus === 'generating' || state.isBusy || !state.startup?.interactiveReady;
      adopt.addEventListener('click', function() { window.keepseekGoalDialog?.adoptFromState(); });
      actions.append(all, none, regenerate, discard, adopt); card.append(actions);
      return card;
    }

    function createGoalTranscriptCard(goal) {
      var card = document.createElement('section');
      card.className = 'goal-transcript-card status-' + String(goal.status || 'preparing').replace(/[^a-z_]/gu, '');
      card.dataset.goalTranscriptCard = 'true';
      card.setAttribute('aria-label', t('goalTranscriptTitle'));

      var header = document.createElement('div');
      header.className = 'goal-transcript-header';
      var heading = document.createElement('div');
      heading.className = 'goal-transcript-heading';
      var dot = document.createElement('span');
      dot.className = 'goal-transcript-dot';
      dot.setAttribute('aria-hidden', 'true');
      var title = document.createElement('strong');
      title.textContent = t('goalTranscriptTitle');
      var status = document.createElement('span');
      status.className = 'goal-transcript-status';
      status.textContent = goalTranscriptStatusLabel(goal.status) + ' · r' + String(goal.revision || 1);
      heading.append(dot, title, status);
      var manage = document.createElement('button');
      manage.type = 'button';
      manage.className = 'goal-transcript-manage secondary';
      manage.textContent = t('goalTranscriptManage');
      manage.addEventListener('click', function() { window.keepseekGoalDialog?.showManager(); });
      header.append(heading, manage);

      var objective = document.createElement('div');
      objective.className = 'goal-transcript-objective';
      objective.textContent = String(goal.objective || '');

      var current = document.createElement('div');
      current.className = 'goal-transcript-current';
      var currentLabel = document.createElement('span');
      currentLabel.className = 'goal-transcript-current-label';
      currentLabel.textContent = t('goalTranscriptCurrentStep');
      var currentText = document.createElement('span');
      currentText.className = 'goal-transcript-current-text';
      currentText.textContent = goalTranscriptCurrentStep(goal);
      current.append(currentLabel, currentText);

      var criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
      var validations = Array.isArray(goal.requiredValidations) ? goal.requiredValidations : [];
      var criteriaDone = criteria.filter(function(item) { return item.status === 'satisfied'; }).length;
      var validationsDone = validations.filter(function(item) { return item.status === 'passed'; }).length;
      var completed = criteriaDone + validationsDone;
      var total = criteria.length + validations.length;

      var progressRow = document.createElement('div');
      progressRow.className = 'goal-transcript-progress-row';
      var progressCopy = document.createElement('span');
      progressCopy.textContent = t('goalTranscriptCriteria', { completed: criteriaDone, total: criteria.length })
        + (validations.length ? ' · ' + t('goalTranscriptValidations', { completed: validationsDone, total: validations.length }) : '');
      var progress = document.createElement('div');
      progress.className = 'goal-transcript-progress';
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', String(Math.max(1, total)));
      progress.setAttribute('aria-valuenow', String(completed));
      var progressFill = document.createElement('span');
      progressFill.style.width = (total > 0 ? Math.min(100, completed / total * 100) : 0) + '%';
      progress.append(progressFill);
      progressRow.append(progressCopy, progress);

      var metrics = document.createElement('div');
      metrics.className = 'goal-transcript-metrics';
      [
        t('goalActiveExecution') + ' ' + goalTranscriptExecutionText(goal),
        t('goalRequests') + ' ' + Number(goal.modelRequests || 0) + '/' + goalTranscriptBudgetValue(goal.maxModelRequests),
        t('goalReviews') + ' ' + Number(goal.completionReviews || 0) + '/' + goalTranscriptBudgetValue(goal.maxCompletionReviews),
        t('goalCost') + ' ' + (Object.entries(goal.costByCurrency || {}).map(function(entry) { return entry[0] + ' ' + Number(entry[1] || 0).toFixed(4); }).join(', ') || '—') + '/' + goalTranscriptBudgetValue(goal.maxCost),
        String(goal.modelId || ''), String(goal.approvalMode || '')
      ].filter(Boolean).forEach(function(value) {
        var item = document.createElement('span');
        item.textContent = value;
        metrics.append(item);
      });

      var details = document.createElement('details'); details.className = 'goal-transcript-details';
      var summary = document.createElement('summary'); summary.textContent = t('goalTranscriptExpand'); details.append(summary);
      var workItems = document.createElement('ol'); workItems.className = 'goal-transcript-work-items';
      (goal.workItems || []).forEach(function(workItem) {
        var item = document.createElement('li'); item.className = 'is-' + String(workItem.status || 'pending');
        item.textContent = String(workItem.title || workItem.id || '') + ' · ' + String(workItem.status || 'pending'); workItems.append(item);
      });
      if (workItems.childElementCount) details.append(workItems);
      card.append(header, objective, current, progressRow, metrics, details);
      return card;
    }

    function refreshGoalTranscriptCard() {
      var existing = transcript.querySelector('[data-goal-transcript-card]');
      var existingProposal = transcript.querySelector('[data-goal-proposal-card]');
      var goal = state.goal && typeof state.goal === 'object' ? state.goal : null;
      var pending = state.goalProposal && typeof state.goalProposal === 'object' ? state.goalProposal : null;
      if (!goal && pending?.proposal) {
        var proposalCard = createGoalProposalTranscriptCard(pending);
        if (proposalCard) {
          if (existingProposal) existingProposal.replaceWith(proposalCard); else transcript.append(proposalCard);
        }
      } else {
        existingProposal?.remove();
      }
      if (!goal) {
        existing?.remove();
        return;
      }
      var next = createGoalTranscriptCard(goal);
      if (existing) existing.replaceWith(next); else transcript.append(next);
    }
  `.slice(1);
}
