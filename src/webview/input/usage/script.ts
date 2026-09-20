import type { WebviewFragment } from '../composition';

export const usageDeclarationFragment: WebviewFragment = {
  id: 'usage.declaration',
  source: `
      var contextProgress = document.getElementById('contextProgress');
      var contextProgressTitle = document.getElementById('contextProgressTitle');
      var contextProgressPercent = document.getElementById('contextProgressPercent');
      var contextProgressTokens = document.getElementById('contextProgressTokens');
      var contextProgressBreakdown = document.getElementById('contextProgressBreakdown');
      var usageDetailsDialog = document.getElementById('usageDetailsDialog');
      var usageDetailsBody = document.getElementById('usageDetailsBody');
      var usageDetailsClose = document.getElementById('usageDetailsClose');
      var usageAnalysisMode = 'source';
      var usageDetailsRenderKey = '';
      var usageDetailsPreviousFocus = null;
`.slice(1)
};

export const usageBindingsFragment: WebviewFragment = {
  id: 'usage.bindings',
  source: `
      if (contextProgress && usageDetailsDialog) {
        contextProgress.addEventListener('keydown', function(event) {
          if ((event.key === 'Enter' || event.key === ' ') && !event.repeat) {
            event.preventDefault();
            contextProgress.click();
          }
        });
        contextProgress.addEventListener('click', function() {
          closeCommandMenu();
          closeReferenceMenu(false);
          usageDetailsPreviousFocus = document.activeElement;
          usageDetailsRenderKey = '';
          renderUsageDetails();
          if (!usageDetailsDialog.open) { usageDetailsDialog.showModal(); }
          contextProgress.setAttribute('aria-expanded', 'true');
          if (usageDetailsClose) { usageDetailsClose.focus(); }
        });
        usageDetailsDialog.addEventListener('cancel', function(event) {
          event.preventDefault();
          usageDetailsDialog.close();
        });
        usageDetailsDialog.addEventListener('keydown', function(event) {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            usageDetailsDialog.close();
          }
        });
        usageDetailsDialog.addEventListener('close', function() {
          contextProgress.setAttribute('aria-expanded', 'false');
          var target = usageDetailsPreviousFocus && usageDetailsPreviousFocus.isConnected
            ? usageDetailsPreviousFocus : contextProgress;
          target.focus();
        });
      }
      if (usageDetailsClose) {
        usageDetailsClose.addEventListener('click', function() { usageDetailsDialog.close(); });
      }
      if (usageDetailsBody) {
        usageDetailsBody.addEventListener('click', function(event) {
          var target = event.target instanceof Element
            ? event.target.closest('button[data-usage-analysis]') : null;
          if (!target || target.disabled) { return; }
          if (target.dataset.usageAnalysis) {
            usageAnalysisMode = target.dataset.usageAnalysis === 'type' ? 'type' : 'source';
          }
          renderUsageDetails();
          var selected = usageDetailsBody.querySelector('button[data-usage-analysis="' + usageAnalysisMode + '"]');
          if (selected) { selected.focus(); }
        });
      }

`.slice(1)
};

export const usageRenderFragment: WebviewFragment = {
  id: 'usage.render',
  source: `
      function renderContextProgress() {
        if (!contextProgress) { return; }
        var metrics = normalizeUsageMetrics(state.usageMetrics);
        var details = metrics.usageDetails;
        var subagents = details && details.subagents;
        var sessionUsage = metrics.sessionUsageStats;
        var usageGroups = sessionUsage && Array.isArray(sessionUsage.byModelSource)
          ? sessionUsage.byModelSource
          : [];
        var currentUsageGroup = findCurrentUsageGroup(usageGroups);
        var cacheRateUsage = usageGroups.length > 1
          ? currentUsageGroup
          : usageGroups.length === 1 ? usageGroups[0] : sessionUsage;
        var usedPercent = clampNumber(metrics.contextPercent, 0, 100);
        var angle = usedPercent * 3.6;
        var title = t('usageStatsTitle');
        var contextLine = ['usageMetricContextPercent', formatContextPercentValue(usedPercent)];
        var primaryLine = ['usageMetricSessionTokens', formatMetricTokens(
          sessionUsage && sessionUsage.totalTokens,
          hasUsageData(sessionUsage)
        )];
        var turnCacheAvailable = hasCacheUsageData(metrics.lastTurnUsage);
        var items = [
          [turnCacheAvailable ? 'usageMetricTurnHit' : 'usageMetricCacheUnavailable', turnCacheAvailable
            ? formatCacheHitRate(metrics.lastTurnUsage)
            : formatUsageAvailabilityValue(metrics.lastTurnUsage, 'usageMetricCacheUnavailableValue')],
          [usageGroups.length > 1 ? 'usageMetricCurrentModelHit' : 'usageMetricAverageHit', formatCacheHitRate(cacheRateUsage)],
          ['usageMetricTurnTokens', formatMetricTokens(metrics.lastTurnUsage && metrics.lastTurnUsage.totalTokens, hasUsageData(metrics.lastTurnUsage))],
          ['usageMetricTurnCount', metrics.turnCount > 0 ? formatMetricInteger(metrics.turnCount) : t('usagePendingValue')]
        ];
        var costDisplay = formatAccountedCosts(sessionUsage);
        items.splice(2, 0, [
          costDisplay.available
            ? costDisplay.partial ? 'usageMetricAccountedCost' : 'usageMetricSessionCost'
            : 'usageMetricCostUnavailable',
          costDisplay.available ? costDisplay.amountText
            : formatUsageAvailabilityValue(sessionUsage, 'usageMetricCostUnavailableValue')
        ]);
        if (metrics.supportsBilling) {
          items.push(['usageMetricBalance', formatMetricBalance(metrics.balance)]);
        }
        if (subagents && details.session) {
          items = [
            ['usageMainSession', formatMetricTokens(details.session.mainSession.totalTokens, true)],
            ['usageMetricSubagentTokens', formatMetricTokens(details.session.subagent.totalTokens, true)],
            ['usageSubagentTaskCount', subagents.estimatesAvailable ? formatMetricInteger(subagents.totalCount) : t('usageNotRecorded')],
            ['usageIsolatedEstimate', subagents.estimatesAvailable
              ? '≈ ' + formatCompactTokenCount(subagents.isolatedIntermediateTokensEstimate) : t('usageNotRecorded')],
            ['usageMetricSessionCost', costDisplay.available ? costDisplay.amountText
              : formatUsageAvailabilityValue(sessionUsage, 'usageMetricCostUnavailableValue')]
          ];
        }
        var latestRunState = getLatestRunState();
        if (latestRunState) {
          items.unshift([
            'usageMetricEffectiveExecution',
            t('usageMetricEffectiveExecutionValue', {
              seconds: formatMetricInteger(Math.floor(latestRunState.usedMs / 1000))
            })
          ]);
        }
        contextProgress.style.setProperty('--context-progress-angle', angle + 'deg');
        contextProgress.classList.toggle('is-warning', usedPercent >= metrics.contextSoftCompactRatio * 100 && usedPercent < metrics.contextCompactForceRatio * 100);
        contextProgress.classList.toggle('is-danger', usedPercent >= metrics.contextCompactForceRatio * 100);
        contextProgress.setAttribute('aria-label', title);
        if (contextProgressTitle) { contextProgressTitle.textContent = title; }
        if (contextProgressPercent) {
          renderMetricLineInto(contextProgressPercent, t(contextLine[0]), contextLine[1]);
        }
        if (contextProgressTokens) {
          renderMetricLineInto(contextProgressTokens, t(primaryLine[0]), primaryLine[1]);
        }
        if (contextProgressBreakdown) {
          contextProgressBreakdown.innerHTML = '';
          items.forEach(function(item) {
            contextProgressBreakdown.append(createMetricLine(t(item[0]), item[1]));
          });
          contextProgressBreakdown.classList.remove('hidden');
        }
        if (usageDetailsDialog && usageDetailsDialog.open) { renderUsageDetails(); }
      }

      function getLatestRunState() {
        var messages = Array.isArray(state.messages) ? state.messages : [];
        for (var index = messages.length - 1; index >= 0; index -= 1) {
          var runState = messages[index] && messages[index].runState;
          if (runState && Number.isFinite(Number(runState.usedMs)) && Number(runState.usedMs) >= 0) {
            return runState;
          }
        }
        return null;
      }

      function renderUsageDetails() {
        if (!usageDetailsBody) { return; }
        var metrics = normalizeUsageMetrics(state.usageMetrics);
        var details = metrics.usageDetails;
        var sessionUsage = metrics.sessionUsageStats;
        var usageGroups = sessionUsage && Array.isArray(sessionUsage.byModelSource)
          ? sessionUsage.byModelSource
          : [];
        var renderKey = JSON.stringify([
          details,
          usageAnalysisMode,
          sessionUsage,
          state.contextUsage,
          metrics.promptCacheDiagnostics,
          metrics.contextCompressionTriggerRatio,
          getLatestRunState(),
          getLanguage()
        ]);
        if (renderKey === usageDetailsRenderKey) { return; }
        usageDetailsRenderKey = renderKey;
        var scrollTop = usageDetailsBody.scrollTop;
        var focusedControl = document.activeElement && document.activeElement.dataset
          ? document.activeElement.dataset.usageAnalysis || ''
          : '';
        usageDetailsBody.replaceChildren();
        if (!details || !details.session) {
          usageDetailsBody.append(usageNode('p', 'usage-note', t('usageNoProviderData')));
          return;
        }

        var toolbar = usageNode('div', 'usage-details-toolbar');
        toolbar.append(usageNode('span', 'usage-details-eyebrow', t('usageDetailsTitle')));
        usageDetailsBody.append(toolbar);

        var selected = details.session;
        usageDetailsBody.append(createContextWindowSection(metrics));
        usageDetailsBody.append(createSessionMetricsSection(metrics, selected));
        usageDetailsBody.append(createCacheDiagnosticsSection(metrics));
        usageDetailsBody.append(createUsageAnalysisSection(selected, usageGroups, sessionUsage, details.subagents));
        usageDetailsBody.scrollTop = scrollTop;
        if (focusedControl) {
          var control = usageDetailsBody.querySelector('button[data-usage-analysis="' + focusedControl + '"]');
          if (control) { control.focus({ preventScroll: true }); }
        }
      }

      function createContextWindowSection(metrics) {
        var contextUsage = state.contextUsage && typeof state.contextUsage === 'object' ? state.contextUsage : {};
        var breakdown = contextUsage.breakdown && typeof contextUsage.breakdown === 'object'
          ? contextUsage.breakdown : {};
        var maxTokens = Math.max(1, readNonNegativeNumber(contextUsage.maxTokensEstimate, 1));
        var usedTokens = clampNumber(readNonNegativeNumber(contextUsage.usedTokensEstimate, 0), 0, maxTokens);
        var remainingTokens = readNonNegativeNumber(contextUsage.remainingTokensEstimate, maxTokens - usedTokens);
        var usedPercent = clampNumber(readNonNegativeNumber(contextUsage.usedPercent, metrics.contextPercent), 0, 100);
        var compactPercent = clampNumber(metrics.contextCompressionTriggerRatio * 100, 0, 100);
        var compactTokens = Math.floor(maxTokens * metrics.contextCompressionTriggerRatio);
        var distanceToCompact = Math.max(0, compactTokens - usedTokens);
        var outputReserve = readNonNegativeNumber(breakdown.outputReserveTokensEstimate, 0);
        var safetyReserve = readNonNegativeNumber(breakdown.safetyReserveTokensEstimate, 0);
        var requestContext = Math.max(0, usedTokens - outputReserve - safetyReserve);
        var statusKey = usedPercent >= metrics.contextCompactForceRatio * 100
          ? 'usageContextCritical'
          : usedPercent >= compactPercent ? 'usageContextApproaching' : 'usageContextHealthy';
        var section = createUsageSection('usageContextWindowTitle');
        var panel = usageNode('div', 'usage-context-panel');
        var topline = usageNode('div', 'usage-context-topline');
        topline.append(
          usageNode('span', 'usage-context-status ' + (statusKey === 'usageContextHealthy' ? 'is-healthy' : 'is-warning'), t(statusKey)),
          usageNode('strong', 'usage-context-total', formatUsageCompactTokens(usedTokens) + '/' + formatUsageCompactTokens(maxTokens))
        );
        panel.append(topline);

        var progress = usageNode('div', 'usage-context-progress');
        progress.setAttribute('role', 'progressbar');
        progress.setAttribute('aria-valuemin', '0');
        progress.setAttribute('aria-valuemax', '100');
        progress.setAttribute('aria-valuenow', String(Math.round(usedPercent)));
        progress.setAttribute('aria-label', t('usageMetricContextPercent') + ' ' + formatContextPercentValue(usedPercent));
        var currentMarker = usageNode('span', 'usage-context-marker usage-context-current-marker',
          isContextUsagePending(usedPercent) ? t('usagePendingValue') : formatRoundedPercent(usedPercent));
        currentMarker.style.left = usedPercent + '%';
        var thresholdMarker = usageNode('span', 'usage-context-marker usage-context-threshold-marker', formatRoundedPercent(compactPercent));
        thresholdMarker.style.left = compactPercent + '%';
        var track = usageNode('div', 'usage-context-track');
        var fill = usageNode('span', 'usage-context-fill');
        fill.style.width = usedPercent + '%';
        var thresholdLine = usageNode('span', 'usage-context-threshold-line');
        thresholdLine.style.left = compactPercent + '%';
        track.append(fill, thresholdLine);
        progress.append(currentMarker, thresholdMarker, track);
        panel.append(progress);

        var progressLabels = usageNode('div', 'usage-context-progress-labels');
        progressLabels.append(
          usageNode('span', '', t('usageContextUsed')),
          usageNode('span', '', t('usageDistanceToCompact') + ' ' + formatUsageCompactTokens(distanceToCompact))
        );
        panel.append(progressLabels);
        section.append(panel);

        var budget = usageNode('div', 'usage-context-budget');
        budget.append(usageNode('h4', 'usage-context-budget-title', t('usageContextBudgetTitle')));
        var budgetGrid = usageNode('div', 'usage-context-budget-grid');
        [
          ['usageRequestContext', requestContext],
          ['usageOutputReserve', outputReserve],
          ['usagePhysicalRemaining', remainingTokens]
        ].forEach(function(item) {
          var metric = usageNode('div', 'usage-context-budget-metric');
          metric.append(
            usageNode('span', '', t(item[0])),
            usageNode('strong', '', formatUsageCompactTokens(item[1]))
          );
          budgetGrid.append(metric);
        });
        budget.append(budgetGrid);
        var sourceText = t('usageCompactSource') + ' ' + t('usageCurrentModelConfig');
        if (safetyReserve > 0) {
          sourceText += ' · ' + t('usageSafetyReserve') + ' ' + formatUsageCompactTokens(safetyReserve);
        }
        budget.append(usageNode('p', 'usage-context-budget-source', sourceText));
        section.append(budget);

        var cacheReasons = normalizeCacheReasonList(metrics.promptCacheDiagnostics && metrics.promptCacheDiagnostics.cacheMissPossibleReasons);
        if (cacheReasons.length) {
          var diagnostic = usageNode('p', 'usage-context-diagnostic');
          diagnostic.append(
            usageNode('span', '', t('usageCacheAttribution')),
            document.createTextNode(' ' + cacheReasons.map(formatCacheReason).join(' · '))
          );
          section.append(diagnostic);
        }
        return section;
      }

      function createSessionMetricsSection(metrics, selected) {
        var section = createUsageSection('usageSessionMetricsTitle');
        var grid = usageNode('div', 'usage-session-metrics-grid');
        var cost = formatAccountedCosts(selected.total);
        var latestRunState = getLatestRunState();
        var hasSessionUsage = hasUsageData(selected.total);
        var cacheDiagnostics = metrics.sessionUsageStats && metrics.sessionUsageStats.cacheDiagnostics;
        var metricsList = [
          ['usageMainRawHitRate', cacheDiagnostics && Number.isFinite(cacheDiagnostics.mainAgentRawHitRate)
            ? formatMetricPercent(cacheDiagnostics.mainAgentRawHitRate) : t('usageMetricCacheUnavailableValue'), 'is-positive'],
          ['usageAllProviderRawHitRate', cacheDiagnostics && Number.isFinite(cacheDiagnostics.rawHitRate)
            ? formatMetricPercent(cacheDiagnostics.rawHitRate) : formatActualCacheRateOnly(selected.total), 'is-positive'],
          ['usageMainReuseEfficiency', cacheDiagnostics && Number.isFinite(cacheDiagnostics.mainAgentReuseEfficiency)
            ? formatMetricPercent(cacheDiagnostics.mainAgentReuseEfficiency) : t('usageMetricCacheUnavailableValue'), 'is-positive'],
          ['usageExpectedHitCeiling', cacheDiagnostics && Number.isFinite(cacheDiagnostics.mainAgentExpectedRawHitRateCeiling)
            ? formatMetricPercent(cacheDiagnostics.mainAgentExpectedRawHitRateCeiling) : t('usageMetricCacheUnavailableValue'), ''],
          ['usageCacheDataCoverageRate', cacheDiagnostics
            && (cacheDiagnostics.cacheDataResponseCount + cacheDiagnostics.cacheDataMissingResponseCount) > 0
            ? formatMetricPercent(100 * cacheDiagnostics.cacheDataResponseCount
              / (cacheDiagnostics.cacheDataResponseCount + cacheDiagnostics.cacheDataMissingResponseCount))
            : t('usageMetricCacheUnavailableValue'), ''],
          ['usageCostLabel', cost.available ? cost.amountText
            : formatUsageAvailabilityValue(selected.total, 'usageMetricCostUnavailableValue'), ''],
          ['usageEffectiveRuntime', latestRunState ? formatUsageRuntime(latestRunState.usedMs)
            : t(hasSessionUsage ? 'usageMetricUnavailableValue' : 'usagePendingValue'), ''],
          ['usageProviderAttemptCount', hasSessionUsage ? formatMetricInteger(selected.total.providerAttemptCount) : t('usagePendingValue'), ''],
          ['usageUsageResponseCount', hasSessionUsage ? formatMetricInteger(selected.total.usageResponseCount) : t('usagePendingValue'), ''],
          ['usageCumulativeTokens', hasSessionUsage ? formatMetricInteger(selected.total.totalTokens) : t('usagePendingValue'), 'is-wide']
        ];
        if (metrics.supportsBilling) {
          metricsList.push(['usageMetricBalance', formatMetricBalance(metrics.balance), '']);
        }
        metricsList.forEach(function(item) {
          var metric = usageNode('div', 'usage-session-metric ' + item[2]);
          metric.append(usageNode('span', '', t(item[0])), usageNode('strong', '', item[1]));
          grid.append(metric);
        });
        section.append(grid);
        var notes = usageNode('div', 'usage-session-notes');
        if (selected.total.unpricedRequestCount > 0) {
          notes.append(usageNode('p', 'usage-warning', t(selected.total.pricedRequestCount > 0
            ? 'usagePartialPricing' : 'usageAllUnpriced', { count: selected.total.unpricedRequestCount })));
        }
        if (selected.total.estimatedRequestCount > 0) {
          notes.append(usageNode('p', '', t('usageUpperBoundPricing', {
            count: selected.total.estimatedRequestCount
          })));
        }
        var attemptsWithoutUsage = Math.max(0,
          selected.total.providerAttemptCount - selected.total.usageResponseCount);
        if (attemptsWithoutUsage > 0) {
          notes.append(usageNode('p', '', t('usageAttemptsWithoutUsage', {
            count: attemptsWithoutUsage
          })));
        }
        if (selected.total.attemptStatsIncomplete) {
          notes.append(usageNode('p', '', t('usageLegacyAttemptStatsIncomplete')));
        }
        if (!selected.total.providerAttemptCount && !selected.total.requestCount) {
          notes.append(usageNode('p', '', t('usageNoProviderData')));
        }
        section.append(notes);
        return section;
      }

      function createCacheDiagnosticsSection(metrics) {
        var section = createUsageSection('usageCacheDiagnosticsTitle');
        var diagnostics = metrics.sessionUsageStats && metrics.sessionUsageStats.cacheDiagnostics;
        if (!diagnostics) {
          section.append(usageNode('p', 'usage-note', t('usageCacheDiagnosticsUnavailable')));
          return section;
        }
        var grid = usageNode('div', 'usage-session-metrics-grid');
        [
          ['usageHealthyReusableRequests', diagnostics.healthyReusableRequestCount],
          ['usageAnomalousReusableRequests', diagnostics.anomalousReusableRequestCount],
          ['usageColdStarts', diagnostics.coldStartRequestCount],
          ['usageControlledBoundaries', diagnostics.controlledBoundaryRequestCount],
          ['usageProviderEvictionPossible', diagnostics.providerCacheEvictionPossibleCount],
          ['usageReusableTokensNotHit', diagnostics.estimatedReusableTokensNotHit]
        ].forEach(function(item) {
          var metric = usageNode('div', 'usage-session-metric');
          metric.append(usageNode('span', '', t(item[0])), usageNode('strong', '', formatMetricInteger(item[1])));
          grid.append(metric);
        });
        section.append(grid);
        section.append(usageNode('p', 'usage-note', t('usageCacheCoverage', {
          reported: diagnostics.cacheDataResponseCount,
          missing: diagnostics.cacheDataMissingResponseCount
        })));
        if (diagnostics.lastAnomalyReason) {
          section.append(usageNode('p', 'usage-warning', t('usageLastCacheAnomaly') + ' '
            + formatCacheReason(diagnostics.lastAnomalyReason)));
        }
        var boundaryCosts = diagnostics.estimatedLocalBoundaryExtraCostByCurrency
          && typeof diagnostics.estimatedLocalBoundaryExtraCostByCurrency === 'object'
          ? diagnostics.estimatedLocalBoundaryExtraCostByCurrency : {};
        var boundaryCostText = Object.keys(boundaryCosts).filter(function(currency) {
          return Number.isFinite(Number(boundaryCosts[currency])) && Number(boundaryCosts[currency]) > 0;
        }).map(function(currency) {
          return formatMetricCost(boundaryCosts[currency], currency, true, false);
        }).join(' · ');
        if (boundaryCostText) {
          section.append(usageNode('p', 'usage-warning', t('usageEstimatedLocalBoundaryExtraCost', {
            cost: boundaryCostText
          })));
        }
        if (diagnostics.incomplete) {
          section.append(usageNode('p', 'usage-note', t('usageCacheDiagnosticsIncomplete')));
        }
        var lanes = Array.isArray(diagnostics.byLane) ? diagnostics.byLane : [];
        if (lanes.length) {
          var list = usageNode('div', 'usage-analysis-list');
          lanes.forEach(function(lane) {
            var card = usageNode('div', 'usage-analysis-card usage-analysis-card-body');
            card.append(usageNode('strong', '', [lane.source, lane.provider, lane.protocol, lane.originalModelId]
              .filter(Boolean).join(' / ')));
            card.append(usageNode('p', '', t('usageRawHitAndReuse', {
              raw: Number.isFinite(lane.rawHitRate) ? formatMetricPercent(lane.rawHitRate) : t('usageMetricCacheUnavailableValue'),
              reuse: Number.isFinite(lane.reuseEfficiency) ? formatMetricPercent(lane.reuseEfficiency) : t('usageMetricCacheUnavailableValue')
            })));
            list.append(card);
          });
          section.append(list);
        }
        return section;
      }

      function createUsageAnalysisSection(selected, usageGroups, sessionUsage, subagents) {
        var section = createUsageSection('usageAnalysisTitle');
        var controls = usageNode('div', 'usage-segmented-control usage-analysis-controls');
        controls.setAttribute('role', 'group');
        controls.setAttribute('aria-label', t('usageAnalysisTitle'));
        ['source', 'type'].forEach(function(mode) {
          var button = usageNode('button', '', t(mode === 'source' ? 'usageBySource' : 'usageByType'));
          button.type = 'button';
          button.dataset.usageAnalysis = mode;
          button.setAttribute('aria-pressed', usageAnalysisMode === mode ? 'true' : 'false');
          controls.append(button);
        });
        section.querySelector('.usage-section-heading').append(controls);
        if (usageAnalysisMode === 'type') {
          appendTypeAnalysis(section, selected, subagents);
        } else {
          appendSourceAnalysis(section, usageGroups, sessionUsage);
        }
        return section;
      }

      function appendSourceAnalysis(section, groups, sessionUsage) {
        var visibleGroups = (groups || []).filter(hasUsageData);
        if (!visibleGroups.length) {
          section.append(usageNode('p', 'usage-note', t('usageNoProviderData')));
          return;
        }
        var shareItems = visibleGroups.map(function(group, index) {
          return {
            label: getUsageGroupLabel(group),
            value: group.totalTokens,
            color: 'color-' + (index % 5)
          };
        });
        section.append(createUsageSharePanel('usageSourceShare', shareItems));
        var list = usageNode('div', 'usage-analysis-list');
        visibleGroups.forEach(function(group, index) {
          list.append(createSourceAnalysisCard(group, 'color-' + (index % 5)));
        });
        section.append(list);
        if (sessionUsage && sessionUsage.legacyUnattributed) {
          section.append(usageNode('p', 'usage-note', t('usageMetricLegacyUnattributed')));
        }
      }

      function appendTypeAnalysis(section, selected, subagents) {
        var mainSessionOnly = selected.total.totalTokens > 0 && selected.mainPercent >= 100;
        var typeItems = [
          { key: 'usageMainSession', usage: selected.mainSession, percent: selected.mainPercent, color: 'color-0' },
          { key: 'usageReviewerLabel', usage: selected.reviewer, percent: selected.reviewerPercent, color: 'color-1' },
          { key: 'usageSubagentLabel', usage: selected.subagent, percent: selected.subagentPercent, color: 'color-2' },
          { key: 'usageHistoricalUnattributed', usage: selected.unattributed, percent: selected.unattributedPercent, color: 'color-3' }
        ].filter(function(item) { return hasActualUsage(item.usage); });
        if (!mainSessionOnly && typeItems.length > 1) {
          section.append(createUsageSharePanel('usageTypeShare', typeItems.map(function(item) {
            return { label: t(item.key), value: item.usage.totalTokens, color: item.color };
          })));
        }
        var list = usageNode('div', 'usage-analysis-list');
        if (mainSessionOnly) {
          list.append(createActualAnalysisCard('usageSessionTotal', selected.total, 'color-0'));
        } else {
          typeItems.forEach(function(item) {
            list.append(createActualAnalysisCard(item.key, item.usage, item.color));
          });
        }
        section.append(list);
        if (subagents) {
          section.append(createSubagentAnalysisDetails(subagents));
        }
      }

      function createUsageSharePanel(titleKey, items) {
        var panel = usageNode('div', 'usage-analysis-share');
        panel.append(usageNode('h4', '', t(titleKey)));
        var total = items.reduce(function(sum, item) { return sum + readNonNegativeNumber(item.value, 0); }, 0);
        var bar = usageNode('div', 'usage-analysis-share-bar');
        bar.setAttribute('aria-hidden', 'true');
        var legend = usageNode('div', 'usage-analysis-share-legend');
        items.forEach(function(item) {
          var percent = total > 0 ? item.value / total * 100 : 0;
          if (!(percent > 0)) { return; }
          var segment = usageNode('span', item.color);
          segment.style.width = percent + '%';
          bar.append(segment);
          var legendItem = usageNode('span', 'usage-analysis-legend-item');
          legendItem.append(
            usageNode('i', 'usage-analysis-dot ' + item.color),
            document.createTextNode(item.label + ' ' + formatUsageSharePercent(percent))
          );
          legend.append(legendItem);
        });
        panel.append(bar, legend);
        return panel;
      }

      function createSourceAnalysisCard(group, colorClass) {
        return createUsageAnalysisCard(getUsageGroupLabel(group), group, colorClass, group.requestCount);
      }

      function createActualAnalysisCard(labelKey, usage, colorClass) {
        return createUsageAnalysisCard(t(labelKey), usage, colorClass, usage.requestCount);
      }

      function createUsageAnalysisCard(label, usage, colorClass, requestCount) {
        var card = usageNode('div', 'usage-analysis-card');
        var header = usageNode('div', 'usage-analysis-card-header');
        var heading = usageNode('div', 'usage-analysis-card-heading');
        var title = usageNode('div', 'usage-analysis-card-title');
        title.append(usageNode('i', 'usage-analysis-dot ' + colorClass), usageNode('strong', '', label));
        heading.append(title, usageNode('span', 'usage-analysis-request-count', t('usageRequestCountValue', {
          count: formatMetricInteger(requestCount)
        })));
        var metricGrid = usageNode('div', 'usage-analysis-card-grid');
        [
          ['usageTotalTokensLabel', formatMetricInteger(usage.totalTokens)],
          ['usageCacheHitRate', formatActualCacheRateOnly(usage)],
          ['usageCostLabel', formatAccountedCosts(usage).available
            ? formatAccountedCosts(usage).amountText
            : formatUsageAvailabilityValue(usage, 'usageMetricCostUnavailableValue')]
        ].forEach(function(item) {
          var metric = usageNode('div', 'usage-analysis-card-metric');
          metric.append(usageNode('span', '', t(item[0])), usageNode('strong', '', item[1]));
          metricGrid.append(metric);
        });
        header.append(heading, metricGrid);
        card.append(header);
        var body = usageNode('div', 'usage-analysis-card-body');
        body.append(usageNode('p', '', t('usageCacheCoverage', {
          reported: usage.cacheDataRequestCount || 0,
          missing: usage.cacheDataMissingRequestCount || 0
        })));
        var cost = formatAccountedCosts(usage);
        if (cost.partial) {
          body.append(usageNode('p', 'usage-warning', t('usagePartialPricing', {
            count: usage.unpricedRequestCount || 0
          })));
        }
        body.append(usageNode('p', '', t('usageCurrencyExplanation')));
        card.append(body);
        return card;
      }

      function createSubagentAnalysisDetails(subagents) {
        var details = usageNode('details', 'usage-subagent-analysis');
        var summary = usageNode('summary', '', t('usageIsolationTitle'));
        details.append(summary);
        var body = usageNode('div', 'usage-subagent-analysis-body');
        body.append(usageNode('p', 'usage-note', t('usageIsolationExplanation')));
        if (subagents.estimatesAvailable) {
          var grid = usageNode('div', 'usage-subagent-estimate-grid');
          [
            ['usageIsolatedEstimate', '≈ ' + formatMetricInteger(subagents.isolatedIntermediateTokensEstimate)],
            ['usageHandoffEstimate', '≈ ' + formatMetricInteger(subagents.rootHandoffTokensEstimate)],
            ['usageIsolationRate', Number.isFinite(subagents.contextIsolationRate)
              ? '≈ ' + formatMetricPercent(subagents.contextIsolationRate) : t('usageNoRatio')]
          ].forEach(function(item) {
            var metric = usageNode('div', 'usage-analysis-card-metric');
            metric.append(usageNode('span', '', t(item[0])), usageNode('strong', '', item[1]));
            grid.append(metric);
          });
          body.append(grid, usageNode('p', 'usage-note', formatSubagentCounts(subagents.totalCount, subagents)));
        } else {
          body.append(usageNode('p', 'usage-note', t('usageHistoricalEstimateUnavailable')));
        }
        if ((subagents.byModel || []).length) {
          body.append(usageNode('h5', 'usage-subagent-group-title', t('usageSubagentModels')));
          var modelList = usageNode('div', 'usage-analysis-list');
          subagents.byModel.forEach(function(group, index) {
            modelList.append(createUsageAnalysisCard(
              getUsageGroupLabel(group), group.usage, 'color-' + (index % 5), group.taskCount
            ));
          });
          body.append(modelList);
        }
        if ((subagents.byProfileLane || []).length) {
          body.append(usageNode('h5', 'usage-subagent-group-title', t('usageSubagentWorkTypes')));
          var workTypeList = usageNode('div', 'usage-analysis-list');
          subagents.byProfileLane.forEach(function(group, index) {
            workTypeList.append(createUsageAnalysisCard(
              formatSubagentWorkType(group), group.usage, 'color-' + ((index + 1) % 5), group.taskCount
            ));
          });
          body.append(workTypeList);
        }
        if ((subagents.recentRuns || []).length) {
          body.append(usageNode('h5', 'usage-subagent-group-title', t('usageSubagentRecentRun')));
          var recentRuns = usageNode('div', 'usage-subagent-run-list');
          subagents.recentRuns.forEach(function(run) {
            var row = usageNode('div', 'usage-subagent-run');
            var heading = usageNode('div', 'usage-subagent-run-heading');
            heading.append(
              usageNode('span', 'usage-status usage-status-' + run.status, t('subagentStatus_' + run.status)),
              usageNode('strong', '', getUsageGroupLabel(run))
            );
            row.append(
              heading,
              usageNode('p', '', formatSubagentWorkType(run)),
              usageNode('p', '', formatMetricInteger(run.usage.totalTokens) + ' Tokens · '
                + formatUsageCost(run.usage) + ' · ' + formatDuration(run.durationMs))
            );
            recentRuns.append(row);
          });
          body.append(recentRuns, usageNode('p', 'usage-note', t('usageRecentLimit')));
        }
        body.append(usageNode('p', 'usage-note', t('usageSubagentPrivacy')));
        body.append(usageNode('p', 'usage-estimate-disclaimer', t('usageEstimateDisclaimer')));
        details.append(body);
        return details;
      }

`.slice(1)
};
