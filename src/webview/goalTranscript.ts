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
      var explicit = String(goal?.waitingReason || goal?.stopReason || goal?.currentStep || '').trim();
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
        String(goal.modelId || '')
      ].filter(Boolean).forEach(function(value) {
        var item = document.createElement('span');
        item.textContent = value;
        metrics.append(item);
      });

      card.append(header, objective, current, progressRow, metrics);
      return card;
    }

    function refreshGoalTranscriptCard() {
      var existing = transcript.querySelector('[data-goal-transcript-card]');
      var goal = state.goal && typeof state.goal === 'object' ? state.goal : null;
      if (!goal) {
        existing?.remove();
        return;
      }
      var next = createGoalTranscriptCard(goal);
      if (existing) existing.replaceWith(next); else transcript.append(next);
    }
  `.slice(1);
}
