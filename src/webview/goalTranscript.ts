export function getGoalTranscriptScript(): string {
  return `
    var goalCardRegion = document.getElementById('goalCardRegion');
    var goalCardSelection = new Set();
    var goalCardSelectionHash = '';
    var goalDiscardArmed = false;
    var goalClearArmed = false;
    var goalCardFeedback = null;
    var goalCardIdentity = '';

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
        ? Math.floor(Number(goal.maxActiveExecutionMs) / 1000) + 's' : '∞';
      return used + ' / ' + limit;
    }
    function goalTranscriptCurrentStep(goal) {
      var explicit = String(goal?.waitingReason || goal?.stopReason || goal?.interruption?.reason || goal?.currentActivity?.text || goal?.currentStep || '').trim();
      if (explicit) return explicit;
      var plan = state.taskPlan && typeof state.taskPlan === 'object' ? state.taskPlan : null;
      var planStep = Array.isArray(plan?.steps) ? plan.steps.find(function(step) { return step.id === plan.currentStepId; }) : null;
      if (planStep?.title) return String(planStep.title);
      if (goal?.status === 'running' && state.isBusy) return getAgentActivityStatusText(normalizeAgentActivity(state.agentActivity)) || t('goalTranscriptWorking');
      return goalTranscriptStatusLabel(goal?.status);
    }
    function goalDefaultSettings() {
      return {
        includeScope: state.goalProposal?.proposal?.includeScope || [],
        excludeScope: state.goalProposal?.proposal?.excludeScope || [],
        requiredValidations: state.goalProposal?.proposal?.requiredValidations || [],
        maxActiveExecutionMs: Number(state.goalDefaults?.maxActiveExecutionMs || 0),
        maxCost: Number(state.goalDefaults?.maxCost || 0),
        maxModelRequests: Number(state.goalDefaults?.maxModelRequests || 0),
        maxCompletionReviews: Number(state.goalDefaults?.maxCompletionReviews || 0),
        resumePolicy: state.goalDefaults?.autoResumeOnActivation ? 'auto_on_activation' : 'manual',
        sourceId: state.selectedSourceId,
        modelId: state.selectedModelId
      };
    }
    function restoreGoalCardFocus(selector) {
      window.setTimeout(function() { goalCardRegion?.querySelector(selector)?.focus(); }, 0);
    }
    function syncGoalCardSelection(pending) {
      var proposal = pending?.proposal;
      var hash = String(proposal?.proposalHash || '');
      var dialogSelection = window.keepseekGoalDialog?.getSelection?.(hash);
      if (goalCardSelectionHash !== hash || Array.isArray(dialogSelection)) {
        goalCardSelectionHash = hash;
        goalCardSelection = new Set(Array.isArray(dialogSelection) ? dialogSelection.map(String)
          : Array.isArray(pending?.selectedWorkItemIds) ? pending.selectedWorkItemIds.map(String)
            : (proposal?.workItems || []).map(function(item) { return String(item.id || ''); }));
      }
      if (pending) pending.selectedWorkItemIds = Array.from(goalCardSelection);
    }
    function setGoalCardItemSelected(pending, id, selected) {
      var proposal = pending?.proposal;
      var items = proposal?.workItems || [];
      var byId = new Map(items.map(function(item) { return [String(item.id || ''), item]; }));
      if (!byId.has(id)) return;
      function selectWithDependencies(itemId) {
        if (!byId.has(itemId) || goalCardSelection.has(itemId)) return;
        goalCardSelection.add(itemId);
        (byId.get(itemId).dependsOn || []).forEach(function(dependency) { selectWithDependencies(String(dependency)); });
      }
      function unselectWithDependents(itemId) {
        goalCardSelection.delete(itemId);
        items.filter(function(item) { return (item.dependsOn || []).map(String).includes(itemId); })
          .forEach(function(item) { unselectWithDependents(String(item.id || '')); });
      }
      if (selected) {
        selectWithDependencies(id);
      } else {
        unselectWithDependents(id);
      }
      pending.selectedWorkItemIds = Array.from(goalCardSelection);
      refreshGoalTranscriptCard();
    }
    function goalCardButton(labelKey, className, onClick) {
      var button = document.createElement('button'); button.type = 'button'; button.className = className || '';
      button.textContent = t(labelKey); button.addEventListener('click', onClick); return button;
    }
    function goalPreparationStageLabel(pending) {
      switch (String(pending?.preparationStage || '')) {
        case 'validating_input': return t('goalPreparationValidatingInput');
        case 'resolving_model': return t('goalPreparationResolvingModel');
        case 'waiting_model': return t('goalPreparationWaitingModel');
        case 'streaming': return t('goalPreparationStreaming');
        case 'ready': return t('goalPreparationReady');
        case 'error': return t('goalPreparationFailed');
        case 'cancelled': return t('goalPreparationCancelled');
        default: return t('goalAssessmentPending');
      }
    }
    function appendGoalPreparationSkeleton(card) {
      var skeleton = document.createElement('div'); skeleton.className = 'goal-preparation-skeleton'; skeleton.setAttribute('aria-hidden', 'true');
      for (var index = 0; index < 3; index += 1) {
        var row = document.createElement('span'); row.style.width = String(92 - index * 13) + '%'; skeleton.append(row);
      }
      card.append(skeleton);
    }
    function createGoalProposalTranscriptCard(pending) {
      var proposal = pending?.proposal;
      var generating = pending?.generationStatus === 'generating';
      var assessment = pending?.assessment;
      if (proposal) syncGoalCardSelection(pending);
      var card = document.createElement('section'); card.className = 'goal-transcript-card goal-proposal-card status-' + String(pending?.generationStatus || 'generating');
      card.dataset.goalProposalCard = 'true'; card.tabIndex = -1; card.setAttribute('aria-label', t('goalProposalReviewTitle'));
      var header = document.createElement('div'); header.className = 'goal-transcript-header';
      var heading = document.createElement('div'); heading.className = 'goal-transcript-heading';
      var title = document.createElement('strong'); title.textContent = t(generating ? 'goalProposalGeneratingTitle' : 'goalProposalReviewTitle');
      var status = document.createElement('span'); status.className = 'goal-transcript-status';
      status.textContent = generating || !proposal ? goalPreparationStageLabel(pending)
        : t('goalSelectionSummary', { selected: goalCardSelection.size, total: proposal.workItems.length });
      heading.append(title, status); header.append(heading); card.append(header);

      if (pending?.generationMessage) {
        var generation = document.createElement('div'); generation.className = 'goal-card-notice' + (pending.generationStatus === 'error' ? ' is-error' : '');
        generation.textContent = String(pending.generationMessage); card.append(generation);
      }
      if (!proposal) {
        var pendingObjective = document.createElement('div'); pendingObjective.className = 'goal-transcript-objective';
        pendingObjective.textContent = String(pending?.visibleOriginalObjective || ''); card.append(pendingObjective);
        if (generating) appendGoalPreparationSkeleton(card);
        var pendingMeta = document.createElement('div'); pendingMeta.className = 'goal-transcript-metrics';
        var pendingModel = document.createElement('span'); pendingModel.textContent = t('goalPreparationModel') + ' ' + String(pending?.generatorModelId || state.subagentModelSettings?.profiles?.proposal?.modelId || '—');
        var received = document.createElement('span'); received.textContent = t('goalPreparationCharacters', { count: Number(pending?.streamedCharacters || 0) });
        pendingMeta.append(pendingModel, received); card.append(pendingMeta);
        var pendingActions = document.createElement('div'); pendingActions.className = 'goal-transcript-proposal-actions';
        if (generating) {
          pendingActions.append(goalCardButton('goalCancelGeneration', '', function() {
            vscode.postMessage({ type: 'cancelGoalDraftGeneration' });
          }));
        } else {
          pendingActions.append(goalCardButton('goalRegenerate', '', function() {
            vscode.postMessage({ type: 'generateGoalDraft', objective: String(pending?.visibleOriginalObjective || ''), sourceId: state.selectedSourceId, modelId: state.selectedModelId });
          }));
        }
        var pendingDiscard = goalCardButton(goalDiscardArmed ? 'goalDiscardConfirm' : 'goalDiscardProposal', 'secondary', function() {
          if (!goalDiscardArmed) { goalDiscardArmed = true; refreshGoalTranscriptCard(); restoreGoalCardFocus('[data-goal-discard]'); return; }
          vscode.postMessage({ type: 'discardGoalProposal' });
        });
        pendingDiscard.dataset.goalDiscard = 'true'; pendingActions.append(pendingDiscard); card.append(pendingActions);
        return card;
      }
      var assessmentGrid = document.createElement('div'); assessmentGrid.className = 'goal-assessment-grid';
      var verdict = document.createElement('div'); verdict.className = 'goal-assessment-verdict';
      var verdictLabel = document.createElement('strong'); verdictLabel.textContent = t('goalAssessmentVerdict');
      var verdictText = document.createElement('span'); verdictText.textContent = assessment
        ? t(assessment.verdict === 'ready' ? 'goalAssessmentReady' : 'goalAssessmentNormalized')
        : t(generating ? 'goalAssessmentPending' : 'goalAssessmentFallback');
      verdict.append(verdictLabel, verdictText);
      var reason = document.createElement('div'); reason.className = 'goal-assessment-reason';
      var reasonLabel = document.createElement('strong'); reasonLabel.textContent = t('goalAssessmentReason');
      var reasonText = document.createElement('span'); reasonText.textContent = String(assessment?.reason || pending.generationMessage || t('goalAssessmentFallbackReason'));
      reason.append(reasonLabel, reasonText); assessmentGrid.append(verdict, reason); card.append(assessmentGrid);

      var diff = document.createElement('div'); diff.className = 'goal-objective-diff';
      var original = document.createElement('div');
      var originalLabel = document.createElement('strong'); originalLabel.textContent = t('goalOriginalObjective');
      var originalText = document.createElement('div'); originalText.textContent = String(pending.visibleOriginalObjective || assessment?.originalObjective || proposal.objective || '');
      original.append(originalLabel, originalText);
      var normalized = document.createElement('div');
      var normalizedLabel = document.createElement('strong'); normalizedLabel.textContent = t('goalNormalizedObjective');
      var normalizedText = document.createElement('div'); normalizedText.textContent = String(assessment?.normalizedObjective || proposal.objective || '');
      normalized.append(normalizedLabel, normalizedText); diff.append(original, normalized); card.append(diff);

      var meta = document.createElement('div'); meta.className = 'goal-transcript-metrics';
      var model = document.createElement('span'); model.textContent = t('goalPreparationModel') + ' ' + String(pending.generatorModelId || state.subagentModelSettings?.profiles?.proposal?.modelId || '—');
      var selected = document.createElement('span'); selected.textContent = t('goalSelectionSummary', { selected: goalCardSelection.size, total: proposal.workItems.length });
      meta.append(model, selected); card.append(meta);

      var items = document.createElement('div'); items.className = 'goal-transcript-proposal-items';
      proposal.workItems.forEach(function(workItem) {
        var id = String(workItem.id || ''); var checked = goalCardSelection.has(id);
        var label = document.createElement('label'); label.className = 'goal-transcript-proposal-item' + (checked ? '' : ' is-unselected');
        var input = document.createElement('input'); input.type = 'checkbox'; input.checked = checked; input.disabled = generating;
        input.dataset.goalWorkItemId = id; input.addEventListener('change', function() {
          setGoalCardItemSelected(pending, id, input.checked);
          restoreGoalCardFocus('input[data-goal-work-item-id="' + id + '"]');
        });
        var copy = document.createElement('span'); var name = document.createElement('strong'); name.textContent = String(workItem.title || id);
        var detail = document.createElement('span'); detail.textContent = String(workItem.detail || '');
        var criteria = document.createElement('small'); criteria.textContent = (workItem.acceptanceCriteria || []).map(function(item) { return item.text; }).join(' · ');
        copy.append(name, detail, criteria); label.append(input, copy); items.append(label);
      });
      card.append(items);

      var selectionActions = document.createElement('div'); selectionActions.className = 'goal-card-selection-actions';
      var all = goalCardButton('goalSelectAll', 'secondary', function() {
        goalCardSelection = new Set(proposal.workItems.map(function(item) { return String(item.id || ''); }));
        pending.selectedWorkItemIds = Array.from(goalCardSelection); refreshGoalTranscriptCard();
      });
      var none = goalCardButton('goalSelectNone', 'secondary', function() {
        goalCardSelection.clear(); pending.selectedWorkItemIds = []; refreshGoalTranscriptCard();
      });
      all.disabled = generating; none.disabled = generating; selectionActions.append(all, none); card.append(selectionActions);

      var actions = document.createElement('div'); actions.className = 'goal-transcript-proposal-actions';
      if (generating) {
        var cancelGeneration = goalCardButton('goalCancelGeneration', '', function() {
          vscode.postMessage({ type: 'cancelGoalDraftGeneration' });
        });
        actions.append(cancelGeneration);
      }
      var adopt = goalCardButton('goalAdoptSuggested', '', function() {
        vscode.postMessage({ type: 'adoptGoalProposal', proposalHash: String(proposal.proposalHash || ''),
          selectedWorkItemIds: Array.from(goalCardSelection), ...goalDefaultSettings() });
      });
      adopt.disabled = generating || goalCardSelection.size < 1 || state.isBusy || !state.startup?.interactiveReady;
      var originalButton = goalCardButton('goalCreateFromOriginal', 'secondary', function() {
        vscode.postMessage({ type: 'adoptGoalOriginal', ...goalDefaultSettings() });
      });
      originalButton.disabled = generating || !pending?.conservativeProposal || state.isBusy || !state.startup?.interactiveReady;
      var edit = goalCardButton('goalEditAdvanced', 'secondary', function() { window.keepseekGoalDialog?.openProposalFromState(); });
      edit.disabled = generating;
      var regenerate = goalCardButton('goalRegenerate', 'secondary', function() {
        vscode.postMessage({ type: 'generateGoalDraft', objective: String(pending.visibleOriginalObjective || assessment?.originalObjective || proposal.objective || ''), sourceId: state.selectedSourceId, modelId: state.selectedModelId });
      });
      regenerate.disabled = generating;
      var discard = goalCardButton(goalDiscardArmed ? 'goalDiscardConfirm' : 'goalDiscardProposal', 'secondary', function() {
        if (!goalDiscardArmed) { goalDiscardArmed = true; refreshGoalTranscriptCard(); restoreGoalCardFocus('[data-goal-discard]'); return; }
        vscode.postMessage({ type: 'discardGoalProposal' });
      });
      discard.dataset.goalDiscard = 'true';
      actions.append(adopt, originalButton, edit, regenerate, discard); card.append(actions);
      return card;
    }

    function createGoalTranscriptCard(goal) {
      var card = document.createElement('section');
      card.className = 'goal-transcript-card status-' + String(goal.status || 'preparing').replace(/[^a-z_]/gu, '');
      card.dataset.goalTranscriptCard = 'true'; card.tabIndex = -1; card.setAttribute('aria-label', t('goalTranscriptTitle'));
      var header = document.createElement('div'); header.className = 'goal-transcript-header';
      var heading = document.createElement('div'); heading.className = 'goal-transcript-heading';
      var dot = document.createElement('span'); dot.className = 'goal-transcript-dot'; dot.setAttribute('aria-hidden', 'true');
      var title = document.createElement('strong'); title.textContent = t('goalTranscriptTitle');
      var status = document.createElement('span'); status.className = 'goal-transcript-status'; status.textContent = goalTranscriptStatusLabel(goal.status) + ' · r' + String(goal.revision || 1);
      heading.append(dot, title, status); header.append(heading); card.append(header);
      var objective = document.createElement('div'); objective.className = 'goal-transcript-objective'; objective.textContent = String(goal.objective || ''); card.append(objective);
      var current = document.createElement('div'); current.className = 'goal-transcript-current';
      var currentLabel = document.createElement('span'); currentLabel.className = 'goal-transcript-current-label'; currentLabel.textContent = t('goalTranscriptCurrentStep');
      var currentText = document.createElement('span'); currentText.className = 'goal-transcript-current-text'; currentText.textContent = goalTranscriptCurrentStep(goal);
      current.append(currentLabel, currentText); card.append(current);
      var reasons = [goal.waitingReason, goal.stopReason, goal.interruption?.reason]
        .map(function(value) { return String(value || '').trim(); })
        .filter(function(value, index, values) { return value && values.indexOf(value) === index; });
      if (reasons.length) {
        var reasonList = document.createElement('div'); reasonList.className = 'goal-card-state-reasons';
        reasons.forEach(function(value) { var reason = document.createElement('div'); reason.textContent = value; reasonList.append(reason); });
        card.append(reasonList);
      }
      if (goalCardFeedback?.message) {
        var feedback = document.createElement('div'); feedback.className = 'goal-card-notice is-' + String(goalCardFeedback.status || '');
        feedback.textContent = goalCardFeedback.message; card.append(feedback);
      }
      var criteria = Array.isArray(goal.criteria) ? goal.criteria : [];
      var validations = Array.isArray(goal.requiredValidations) ? goal.requiredValidations : [];
      var criteriaDone = criteria.filter(function(item) { return item.status === 'satisfied'; }).length;
      var validationsDone = validations.filter(function(item) { return item.status === 'passed'; }).length;
      var workItems = Array.isArray(goal.workItems) ? goal.workItems : [];
      var workDone = workItems.filter(function(item) { return item.status === 'completed'; }).length;
      var completed = criteriaDone + validationsDone; var total = criteria.length + validations.length;
      var progressRow = document.createElement('div'); progressRow.className = 'goal-transcript-progress-row';
      var progressCopy = document.createElement('span'); progressCopy.textContent = t('goalWorkItemProgress', { completed: workDone, total: workItems.length })
        + ' · ' + t('goalTranscriptCriteria', { completed: criteriaDone, total: criteria.length })
        + (validations.length ? ' · ' + t('goalTranscriptValidations', { completed: validationsDone, total: validations.length }) : '');
      var progress = document.createElement('div'); progress.className = 'goal-transcript-progress'; progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-valuemin', '0'); progress.setAttribute('aria-valuemax', String(Math.max(1, total))); progress.setAttribute('aria-valuenow', String(completed));
      var fill = document.createElement('span'); fill.style.width = (total ? Math.min(100, completed / total * 100) : 0) + '%'; progress.append(fill); progressRow.append(progressCopy, progress); card.append(progressRow);
      var metrics = document.createElement('div'); metrics.className = 'goal-transcript-metrics';
      [t('goalActiveExecution') + ' ' + goalTranscriptExecutionText(goal),
        t('goalRequests') + ' ' + Number(goal.modelRequests || 0) + '/' + goalTranscriptBudgetValue(goal.maxModelRequests),
        t('goalReviews') + ' ' + Number(goal.completionReviews || 0) + '/' + goalTranscriptBudgetValue(goal.maxCompletionReviews),
        t('goalCost') + ' ' + (Object.entries(goal.costByCurrency || {}).map(function(entry) { return entry[0] + ' ' + Number(entry[1] || 0).toFixed(4); }).join(', ') || '—') + '/' + goalTranscriptBudgetValue(goal.maxCost),
        String(goal.modelId || ''), String(goal.approvalMode || '')].filter(Boolean).forEach(function(value) {
          var item = document.createElement('span'); item.textContent = value; metrics.append(item);
        });
      card.append(metrics);

      var actions = document.createElement('div'); actions.className = 'goal-progress-actions';
      if (goal.canPause) actions.append(goalCardButton('goalPause', 'secondary', function() { vscode.postMessage({ type: 'goalPause' }); }));
      if (goal.canResume) {
        var resume = goalCardButton('goalResume', '', function() {
          goalCardFeedback = { action: 'resume', status: 'pending', message: t('goalResumePending') }; refreshGoalTranscriptCard();
          vscode.postMessage({ type: 'goalResume' });
        });
        resume.disabled = state.isBusy || goalCardFeedback?.status === 'pending'; actions.append(resume);
      }
      if (goal.canStop) actions.append(goalCardButton('goalStop', 'secondary', function() { vscode.postMessage({ type: 'goalStop' }); }));
      if (goal.canClear) {
        var clear = goalCardButton(goalClearArmed ? 'goalClearConfirm' : 'goalClear', 'secondary', function() {
          if (!goalClearArmed) { goalClearArmed = true; refreshGoalTranscriptCard(); restoreGoalCardFocus('[data-goal-clear]'); return; }
          goalCardFeedback = { action: 'clear', status: 'pending', message: t('goalClearPending') }; refreshGoalTranscriptCard();
          vscode.postMessage({ type: 'goalClear' });
        });
        clear.dataset.goalClear = 'true'; clear.disabled = goalCardFeedback?.action === 'clear' && goalCardFeedback?.status === 'pending'; actions.append(clear);
      }
      var debug = goalCardButton(state.debugMode ? 'goalDisableDebug' : 'goalEnableDebug', 'secondary', function() {
        state.debugMode = !state.debugMode; vscode.postMessage({ type: 'setDebugMode', enabled: state.debugMode }); refreshGoalTranscriptCard();
      });
      debug.setAttribute('aria-pressed', state.debugMode ? 'true' : 'false'); actions.append(debug); card.append(actions);

      if (!goal.canClear) {
        var amend = document.createElement('div'); amend.className = 'goal-amend-row';
        var amendInput = document.createElement('input'); amendInput.type = 'text'; amendInput.maxLength = 20000; amendInput.placeholder = t('goalAmendPlaceholder');
        var amendButton = goalCardButton('goalAmend', 'secondary', function() {
          var instruction = amendInput.value.trim(); if (!instruction) return;
          vscode.postMessage({ type: 'goalAmend', instruction: instruction }); amendInput.value = '';
        });
        amendInput.addEventListener('keydown', function(event) { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); amendButton.click(); } });
        amend.append(amendInput, amendButton); card.append(amend);
      }

      var details = document.createElement('details'); details.className = 'goal-transcript-details';
      var summary = document.createElement('summary'); summary.textContent = t('goalTranscriptExpand'); details.append(summary);
      if (workItems.length) {
        var workHeading = document.createElement('strong'); workHeading.textContent = t('goalWorkItemsProgress');
        var workList = document.createElement('ol'); workList.className = 'goal-transcript-work-items';
        workItems.forEach(function(workItem) { var item = document.createElement('li'); item.className = 'is-' + String(workItem.status || 'pending'); item.textContent = String(workItem.title || workItem.id || '') + ' · ' + goalTranscriptStatusLabel(workItem.status || 'pending'); workList.append(item); });
        details.append(workHeading, workList);
      }
      var criterionHeading = document.createElement('strong'); criterionHeading.textContent = t('goalCriteriaProgress');
      var criterionList = document.createElement('ol'); criterionList.className = 'goal-transcript-work-items';
      criteria.forEach(function(criterion) {
        var item = document.createElement('li'); item.className = 'is-' + String(criterion.status || 'pending'); item.append(document.createTextNode(String(criterion.text || '') + ' · ' + String(criterion.status || 'pending')));
        if (criterion.type === 'manual' && criterion.status !== 'satisfied' && !goal.canClear) {
          var confirm = goalCardButton('goalConfirmCriterion', 'secondary goal-confirm-criterion', function() { confirm.disabled = true; vscode.postMessage({ type: 'goalConfirmCriterion', criterionId: String(criterion.id || '') }); });
          item.append(' ', confirm);
        }
        criterionList.append(item);
      });
      details.append(criterionHeading, criterionList);
      if (validations.length) {
        var validationHeading = document.createElement('strong'); validationHeading.textContent = t('goalValidationProgress');
        var validationList = document.createElement('ul'); validationList.className = 'goal-transcript-work-items';
        validations.forEach(function(validation) { var item = document.createElement('li'); item.className = 'is-' + String(validation.status || 'pending'); item.textContent = String(validation.script || '') + ' · ' + String(validation.status || 'pending'); validationList.append(item); });
        details.append(validationHeading, validationList);
      }
      var traceHeading = document.createElement('strong'); traceHeading.textContent = t('goalTraceLogs');
      var traceList = document.createElement('div'); traceList.className = 'goal-trace-list';
      (goal.traces || []).forEach(function(trace) {
        traceList.append(goalCardButton('goalOpenTrace', 'secondary', function() { vscode.postMessage({ type: 'openGoalTrace', traceId: String(trace.id || '') }); }));
        traceList.lastElementChild.textContent = t('goalOpenTrace', { kind: String(trace.kind || 'attempt'), attempt: Number(trace.attempt || 0) });
      });
      if (!(goal.traces || []).length) { var empty = document.createElement('span'); empty.textContent = t('goalTraceEmpty'); traceList.append(empty); }
      details.append(traceHeading, traceList); card.append(details);
      return card;
    }

    function refreshGoalTranscriptCard() {
      if (!goalCardRegion) return;
      var mode = String(state.goalUi?.mode || 'chat');
      var nextIdentity = (mode === 'proposal_generating' || mode === 'proposal_review')
        ? 'proposal:' + String(state.goalProposal?.proposal?.proposalHash || '')
        : (mode === 'goal_active' || mode === 'goal_terminal')
          ? 'goal:' + String(state.goal?.id || '')
          : mode;
      if (nextIdentity !== goalCardIdentity) {
        goalCardIdentity = nextIdentity;
        goalDiscardArmed = false;
        goalClearArmed = false;
        goalCardFeedback = null;
      }
      goalCardRegion.replaceChildren();
      var card = null;
      if (mode === 'proposal_generating' || mode === 'proposal_review') card = createGoalProposalTranscriptCard(state.goalProposal);
      else if ((mode === 'goal_active' || mode === 'goal_terminal') && state.goal) card = createGoalTranscriptCard(state.goal);
      if (card) goalCardRegion.append(card);
      goalCardRegion.classList.toggle('hidden', !card);
      window.keepseekGoalInterface?.renderComposer?.();
    }

    window.keepseekGoalInterface = {
      focusCard: function() {
        var card = goalCardRegion?.querySelector('[data-goal-proposal-card], [data-goal-transcript-card]');
        card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); card?.focus();
      },
      setActionFeedback: function(action, status, message) {
        goalCardFeedback = { action: String(action || ''), status: String(status || ''), message: String(message || '') };
        refreshGoalTranscriptCard();
      },
      render: refreshGoalTranscriptCard
    };
  `.slice(1);
}
