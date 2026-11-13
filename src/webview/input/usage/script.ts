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

`.slice(1)
};

export const usageRenderFragment: WebviewFragment = {
  id: 'usage.render',
  source: `
      function renderContextProgress() {
        if (!contextProgress) { return; }
        var readiness = state.usageMetrics?.displayReadiness;
        if (readiness === 'loading' || readiness === 'incomplete') {
          var readinessText = t(readiness === 'loading' ? 'usageDisplayLoading' : 'usageDisplayIncomplete');
          contextProgress.style.setProperty('--context-progress-angle', '0deg');
          contextProgress.classList.remove('is-warning', 'is-danger');
          contextProgress.setAttribute('aria-label', readinessText);
          if (contextProgressTitle) contextProgressTitle.textContent = t('usageStatsTitle');
          if (contextProgressPercent) contextProgressPercent.textContent = readinessText;
          if (contextProgressTokens) contextProgressTokens.textContent = '';
          if (contextProgressBreakdown) contextProgressBreakdown.replaceChildren();
          if (usageDetailsDialog?.open) renderUsageDetails();
          return;
        }
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
            ['usageMetricSubagentTokens', subagents.usageUnreportedCount > 0 && !details.session.subagent.requestCount
              ? t('usageNotReported') : formatMetricTokens(details.session.subagent.totalTokens, true)],
            ['usageSubagentTaskCount', subagents.estimatesAvailable ? formatMetricInteger(subagents.totalCount) : t('usageNotRecorded')],
            ['usageIsolatedEstimate', subagents.estimatesAvailable
              ? '≈ ' + formatCompactTokenCount(subagents.isolatedIntermediateTokensEstimate) : t('usageNotRecorded')],
            ['usageMetricSessionCost', costDisplay.available ? costDisplay.amountText
              : formatUsageAvailabilityValue(sessionUsage, 'usageMetricCostUnavailableValue')]
          ];
        }
        var currentMs = metrics.executionTime.currentMs;
        if (Number.isFinite(currentMs)) {
          items.unshift([
            'usageMetricEffectiveExecution',
            formatUsageRuntime(currentMs)
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

      function renderUsageDetails() {
        if (!usageDetailsBody) { return; }
        var readiness = state.usageMetrics?.displayReadiness;
        if (readiness === 'loading' || readiness === 'incomplete') {
          usageDetailsRenderKey = '';
          usageDetailsBody.replaceChildren(usageNode('p', 'usage-note',
            t(readiness === 'loading' ? 'usageDisplayLoading' : 'usageDisplayIncomplete')));
          return;
        }
        var metrics = normalizeUsageMetrics(state.usageMetrics);
        var details = metrics.usageDetails;
        var sessionUsage = metrics.sessionUsageStats;
        var usageGroups = sessionUsage && Array.isArray(sessionUsage.byModelSource)
          ? sessionUsage.byModelSource
          : [];
        var renderKey = JSON.stringify([
          details,
          sessionUsage,
          state.contextUsage,
          metrics.promptCacheDiagnostics,
          metrics.contextCompressionTriggerRatio,
          metrics.executionTime,
          metrics.isOfficialDeepSeek,
          metrics.referenceCostSourceIds,
          getLanguage()
        ]);
        if (renderKey === usageDetailsRenderKey) { return; }
        usageDetailsRenderKey = renderKey;
        var scrollTop = usageDetailsBody.scrollTop;
        usageDetailsBody.replaceChildren();
        if (!details || !details.session) {
          usageDetailsBody.append(createSessionMetricsSection(metrics, { total: metrics.sessionUsageStats || {} }));
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
        usageDetailsBody.append(createUsageAnalysisSection(selected, usageGroups, sessionUsage, details.subagents, details.sessionTitle));
        usageDetailsBody.scrollTop = scrollTop;
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
        var currentMs = metrics.executionTime.currentMs;
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
          ['usageEffectiveRuntime', Number.isFinite(currentMs) ? formatUsageRuntime(currentMs)
            : t(hasSessionUsage ? 'usageMetricUnavailableValue' : 'usagePendingValue'), ''],
          ['usageSessionTotalTime', formatUsageRuntime(metrics.executionTime.totalMs), ''],
          ['usageProviderAttemptCount', hasSessionUsage ? (selected.total.attemptStatsIncomplete && !selected.total.providerAttemptCount ? t('usageMetricUnavailableValue') : (selected.total.attemptStatsIncomplete ? '≥ ' : '') + formatMetricInteger(selected.total.providerAttemptCount)) : t('usagePendingValue'), ''],
          ['usageUsageResponseCount', hasSessionUsage ? (selected.total.attemptStatsIncomplete && !selected.total.usageResponseCount ? t('usageMetricUnavailableValue') : (selected.total.attemptStatsIncomplete ? '≥ ' : '') + formatMetricInteger(selected.total.usageResponseCount)) : t('usagePendingValue'), ''],
          ['usageCumulativeTokens', hasSessionUsage ? formatMetricInteger(selected.total.totalTokens) : t('usagePendingValue'), 'is-wide']
        ];
        if (metrics.supportsBilling) {
          metricsList.push(['usageMetricBalance', formatMetricBalance(metrics.balance), '']);
        }
        metricsList.forEach(function(item) {
          var metric = usageNode('div', 'usage-session-metric ' + item[2]);
          metric.append(createUsageMetricLabel(item[0]), usageNode('strong', '', item[1]));
          grid.append(metric);
        });
        section.append(grid);
        var notes = usageNode('div', 'usage-session-notes');
        notes.append(usageNode('p', '', t('usageTimingScopeNote')));
        if (metrics.executionTime.incomplete) notes.append(usageNode('p', 'usage-warning', t('usageTimeHistoryIncomplete')));
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
          notes.append(usageNode('p', '', t('usageAttemptStatsIncomplete')));
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
          ['usageReusableTokensNotHit', diagnostics.estimatedReusableTokensNotHit],
          ['usageReusablePrefixTokens', diagnostics.reusablePrefixTokens],
          ['usageUnavoidableNewTokens', diagnostics.unavoidableNewTokens],
          ['usageLocalEstimateLowCount', diagnostics.localEstimateLowCount]
        ].forEach(function(item) {
          var metric = usageNode('div', 'usage-session-metric');
          metric.append(usageNode('span', '', t(item[0])), usageNode('strong', '', formatMetricInteger(item[1])));
          grid.append(metric);
        });
        section.append(grid);
        section.append(usageNode('p', 'usage-note', t('usageDiagnosticCacheCoverage', {
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
          return formatMetricCost(boundaryCosts[currency], currency, true);
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
            card.append(usageNode('strong', '', [lane.source, lane.profile, lane.subagentLane, lane.provider, lane.protocol, lane.originalModelId,
              lane.cacheFamilyId ? t('usageCacheFamilyShort', { id: lane.cacheFamilyId }) : '']
              .filter(Boolean).join(' / ')));
            card.append(usageNode('p', '', t('usageRawHitAndReuse', {
              raw: Number.isFinite(lane.rawHitRate) ? formatMetricPercent(lane.rawHitRate) : t('usageMetricCacheUnavailableValue'),
              reuse: Number.isFinite(lane.reuseEfficiency) ? formatMetricPercent(lane.reuseEfficiency) : t('usageMetricCacheUnavailableValue')
            })));
            card.append(usageNode('p', '', t('usageCacheLaneDetails', {
              ceiling: Number.isFinite(lane.expectedRawHitRateCeiling)
                ? formatMetricPercent(lane.expectedRawHitRateCeiling) : t('usageMetricCacheUnavailableValue'),
              reusable: formatMetricInteger(lane.reusablePrefixTokens),
              unavoidable: formatMetricInteger(lane.unavoidableNewTokens),
              requests: formatMetricInteger(lane.requestCount),
              reported: formatMetricInteger(lane.cacheDataResponseCount),
              missing: formatMetricInteger(lane.cacheDataMissingResponseCount)
            })));
            if (lane.source === 'subagent') {
              card.append(usageNode('p', 'usage-note', t('usageSubagentCacheModes', {
                cold: formatMetricInteger(lane.coldRequestCount),
                continued: formatMetricInteger(lane.continuedRequestCount),
                sibling: formatMetricInteger(lane.siblingRequestCount)
              })));
            }
            list.append(card);
          });
          section.append(list);
        }
        return section;
      }

      function createUsageAnalysisSection(selected, usageGroups, sessionUsage, subagents, sessionTitle) {
        var section = createUsageSection('usageAnalysisTitle');
        var sources = (usageGroups || []).filter(hasActualUsage);
        if (sources.length || hasActualUsage(selected.total)) {
          var sourceSection = createUsageAnalysisGroup('usageSourceTitle', 'usage-analysis-source');
          appendSourceAnalysis(sourceSection, sources, sessionUsage, selected.total, subagents);
          section.append(sourceSection);
        }
        var typeItems = [
          { key: 'usageMainSession', usage: selected.mainSession, percent: selected.mainPercent },
          { key: 'usageReviewerLabel', usage: selected.reviewer, percent: selected.reviewerPercent },
          { key: 'usageSubagentLabel', usage: selected.subagent, percent: selected.subagentPercent },
          { key: 'usageUnattributed', usage: selected.unattributed, percent: selected.unattributedPercent }
        ].filter(function(item) { return hasActualUsage(item.usage) || (item.key === 'usageSubagentLabel' && subagents); });
        // A sole main-session slice adds no information. Non-main activity can
        // matter even with zero tokens, unknown usage, or known zero cost.
        if (subagents || typeItems.some(function(item) { return item.key !== 'usageMainSession'; })) {
          var types = createUsageAnalysisGroup('usageTypeTitle', 'usage-analysis-type');
          types.append(usageNode('p', 'usage-note', t('usageResponsibilityScope')));
          appendTypeAnalysis(types, typeItems);
          if (hasActualUsage(sessionTitle)) {
            types.append(usageNode('p', 'usage-note usage-session-title-purpose', t('usageSessionTitlePurpose') + ' · '
              + t('usageAttemptResponseCounts', {
                attempts: sessionTitle.providerAttemptCount || 0, responses: sessionTitle.usageResponseCount || 0
              }) + ' · ' + formatUsageTokens(sessionTitle) + ' Tokens · ' + formatAnalysisCost(sessionTitle)));
          }
          if (subagents) {
            var fallbackModels = (subagents.byModel || []).filter(function(model) {
              return !findSubagentSource(model, sources);
            });
            types.append(createSubagentAnalysisDetails(subagents, fallbackModels));
          }
          section.append(types);
        }
        if (!sources.length && !hasActualUsage(selected.total) && !subagents) {
          section.append(usageNode('p', 'usage-note', t('usageNoProviderData')));
        }
        section.append(createUsageAnalysisFooter(selected.total));
        return section;
      }

      function createUsageAnalysisGroup(titleKey, className) {
        var group = usageNode('section', 'usage-analysis-group ' + className);
        group.setAttribute('aria-label', t(titleKey));
        group.append(usageNode('h4', 'usage-analysis-group-title', t(titleKey)));
        return group;
      }

      function appendSourceAnalysis(section, groups, sessionUsage, total, subagents) {
        // Keep the existing attributed-source denominator, not session totals,
        // request counts, or execution-type attribution.
        var denominator = groups.reduce(function(sum, group) { return sum + group.totalTokens; }, 0);
        var list = usageNode('div', 'usage-analysis-list');
        groups.forEach(function(group) {
          var entry = usageNode('div', 'usage-source-entry');
          var heading = usageNode('div', 'usage-source-heading');
          heading.append(usageNode('strong', 'usage-source-name', getUsageGroupLabel(group)));
          var percent = denominator > 0 && hasReportedUsageTokens(group) ? group.totalTokens / denominator * 100 : undefined;
          heading.append(usageNode('span', 'usage-token-share', formatTokenShare(percent)));
          var bar = usageNode('div', 'usage-source-bar');
          if (Number.isFinite(percent)) {
            bar.setAttribute('role', 'meter');
            bar.setAttribute('aria-label', t('usageTokenShare'));
            bar.setAttribute('aria-valuemin', '0');
            bar.setAttribute('aria-valuemax', '100');
            bar.setAttribute('aria-valuenow', String(percent));
            bar.setAttribute('aria-valuetext', formatTokenShare(percent));
            var fill = usageNode('span', '');
            fill.style.width = percent + '%';
            bar.append(fill);
          } else { bar.setAttribute('aria-hidden', 'true'); }
          entry.append(heading, bar, createSourceMetrics(group));
          appendUsageWarnings(entry, group);
          var subset = group.bySource && group.bySource.subagent;
          if (hasActualUsage(subset)) {
            var onlyChild = isSubagentOnlySource(group);
            var child = usageNode('div', 'usage-source-subagent');
            child.append(usageNode('strong', '', t(onlyChild ? 'usageSourceSubagentOnly' : 'usageSourceSubagentSubset')));
            if (!onlyChild) {
              child.append(usageNode('span', '', formatUsageTokens(subset) + ' Tokens · '
                + t('usageCacheHitRate') + ': ' + formatActualCacheRateOnly(subset) + ' · ' + formatAnalysisCost(subset)));
              appendUsageWarnings(child, subset);
            }
            var models = ((subagents && subagents.byModel) || []).filter(function(model) {
              return findSubagentSource(model, groups) === group;
            });
            models.forEach(function(model) { appendSubagentTaskCounts(child, model); });
            entry.append(child);
          }
          list.append(entry);
        });
        section.append(list);
        var sourceIncomplete = !groups.length
          || groups.some(function(group) { return !group.sourceId || !group.modelId; })
          || denominator < total.totalTokens
          || groups.reduce(function(sum, group) { return sum + group.requestCount; }, 0) < total.requestCount;
        if (sourceIncomplete) {
          section.append(usageNode('p', 'usage-warning usage-source-attribution-note', t('usageSourceAttributionIncomplete')));
        }
      }

      function findSubagentSource(model, sources) {
        if (!model.sourceId || !model.modelId || !model.provider) { return null; }
        var matches = sources.filter(function(source) {
          return source.sourceId === model.sourceId && source.modelId === model.modelId && source.provider === model.provider;
        });
        return matches.length === 1 && hasActualUsage(matches[0].bySource && matches[0].bySource.subagent)
          && hasSameUsageCoverage(matches[0].bySource.subagent, model.usage) ? matches[0] : null;
      }

      function isSubagentOnlySource(source) {
        var slices = source.bySource || {};
        var child = slices.subagent;
        // Identity and the responsibility map establish provenance; coverage
        // checks additionally reject partially attributed historical sources.
        return child
          && Object.keys(slices).filter(function(key) { return hasActualUsage(slices[key]); }).every(function(key) { return key === 'subagent'; })
          && hasSameUsageCoverage(source, child);
      }

      function hasSameUsageCoverage(left, right) {
        return ['totalTokens', 'requestCount', 'pricedRequestCount', 'unpricedRequestCount', 'estimatedRequestCount',
          'cacheDataRequestCount', 'cacheDataMissingRequestCount'].every(function(key) { return (left[key] || 0) === (right[key] || 0); })
          && Object.keys(left.costByCurrency || {}).length === Object.keys(right.costByCurrency || {}).length
          && Object.keys(left.costByCurrency || {}).every(function(currency) { return left.costByCurrency[currency] === right.costByCurrency[currency]; });
      }

      function hasReportedUsageTokens(usage) {
        return Boolean(usage && (usage.requestCount > 0 || usage.usageResponseCount > 0 || usage.totalTokens > 0));
      }

      function formatUsageTokens(usage) {
        return hasReportedUsageTokens(usage) ? formatMetricInteger(usage.totalTokens) : t('usageNotReported');
      }

      function formatAnalysisCost(usage) {
        var cost = formatAccountedCosts(usage);
        // Partial/unpriced explanations belong to the adjacent short warning,
        // once per slice, rather than also being appended to the amount.
        return cost.available ? cost.amountText : formatUsageAvailabilityValue(usage, 'usageMetricCostUnavailableValue');
      }

      function formatTokenShare(percent) {
        return t('usageTokenShare') + ': ' + (Number.isFinite(percent) ? formatUsageSharePercent(percent) : t('usageShareUnavailable'));
      }

      function appendTypeAnalysis(section, items) {
        var list = usageNode('div', 'usage-analysis-list');
        items.forEach(function(item) {
          list.append(createCompactUsageRow(t(item.key), item.usage, undefined,
            hasReportedUsageTokens(item.usage) ? item.percent : undefined));
        });
        section.append(list);
      }

      function createSourceMetrics(usage) {
        var grid = usageNode('div', 'usage-source-metrics');
        [
          ['usageTokensLabel', formatUsageTokens(usage)],
          ['usageCacheHitRate', formatActualCacheRateOnly(usage)],
          ['usageCostLabel', formatAnalysisCost(usage)]
        ].forEach(function(item) {
          var metric = usageNode('div', 'usage-analysis-card-metric');
          metric.append(createUsageMetricLabel(item[0], usage.sourceId), usageNode('strong', '', item[1]));
          grid.append(metric);
        });
        return grid;
      }

      function createCompactUsageRow(label, usage, sourceId, percent) {
        var row = usageNode('div', 'usage-compact-row');
        row.append(usageNode('strong', 'usage-compact-name', label));
        var values = usageNode('div', 'usage-compact-values');
        values.append(usageNode('span', '', hasReportedUsageTokens(usage) ? formatUsageTokens(usage) + ' Tokens' : t('usageNotReported')));
        if (arguments.length > 3) { values.append(usageNode('span', 'usage-token-share', formatTokenShare(percent))); }
        var cost = usageNode('span', 'usage-compact-cost');
        cost.append(createUsageMetricLabel('usageCostLabel', sourceId), usageNode('strong', '', formatAnalysisCost(usage)));
        values.append(cost);
        row.append(values);
        appendUsageWarnings(row, usage);
        return row;
      }

      function appendUsageWarnings(node, usage) {
        if (!usage) { return; }
        var warnings = [];
        if (usage.cacheDataMissingRequestCount > 0) {
          warnings.push(t('usageCacheMissingShort', { count: usage.cacheDataMissingRequestCount }));
        } else if (hasReportedUsageTokens(usage) && !(usage.cacheDataRequestCount > 0)) {
          warnings.push(t('usageCacheCoverageUnknown'));
        }
        var cost = formatAccountedCosts(usage);
        if (cost.partial) { warnings.push(t('usagePricingPartialShort', { count: usage.unpricedRequestCount || 0 })); }
        else if (!cost.available && hasActualUsage(usage)) { warnings.push(t('usagePricingUnknownShort')); }
        if (usage.estimatedRequestCount > 0) { warnings.push(t('usagePricingUpperBoundShort')); }
        if (usage.providerAttemptCount > (usage.usageResponseCount || 0)) {
          warnings.push(t('usageAttemptsWithoutUsageShort', { count: usage.providerAttemptCount - (usage.usageResponseCount || 0) }));
        }
        if (warnings.length) { node.append(usageNode('p', 'usage-warning', warnings.join(' · '))); }
      }

      function appendSubagentTaskCounts(node, group) {
        node.append(usageNode('p', 'usage-note usage-child-counts', group.taskCountsAvailable === false
          ? t('usageTaskCountUnknown') : t('usageTaskCountValue', { count: formatMetricInteger(group.taskCount) })));
        node.append(usageNode('p', 'usage-note', Number.isFinite(group.usage.providerAttemptCount)
          ? t('usageAttemptResponseCounts', { attempts: formatMetricInteger(group.usage.providerAttemptCount), responses: formatMetricInteger(group.usage.usageResponseCount) })
          : t('usageAttemptCountsUnknown')));
      }

      function appendCompactCache(row, usage) {
        row.querySelector('.usage-compact-values').append(usageNode('span', 'usage-slice-cache',
          t('usageCacheHitRate') + ': ' + formatActualCacheRateOnly(usage)));
      }

      function createUsageAnalysisFooter(total) {
        var footer = createUsageAnalysisGroup('usageAnalysisNotesTitle', 'usage-analysis-footer');
        var reported = total.cacheDataRequestCount;
        var missing = total.cacheDataMissingRequestCount;
        var known = Number.isFinite(reported) && Number.isFinite(missing) && reported + missing > 0;
        var coverage = known ? t('usageCacheCoverage', { reported: reported, missing: missing }) : t('usageCacheCoverageUnknown');
        if (known && reported + missing < total.requestCount) { coverage += ' · ' + t('usageCacheCoverageUnknown'); }
        footer.append(usageNode('p', 'usage-note usage-analysis-coverage', coverage));
        footer.append(usageNode('p', 'usage-note usage-analysis-cost-note', t('usageCurrencyExplanation')));
        return footer;
      }

      function createUsageMetricLabel(key, sourceId) {
        var label = usageNode('span', '', t(key));
        if (key !== 'usageCostLabel') return label;
        var metrics = normalizeUsageMetrics(state.usageMetrics);
        var reference = sourceId ? metrics.referenceCostSourceIds.indexOf(sourceId) >= 0
          || (sourceId === state.selectedSourceId && !metrics.isOfficialDeepSeek)
          : metrics.referenceCostSourceIds.length > 0 || !metrics.isOfficialDeepSeek;
        if (reference) {
          label.className = 'usage-cost-label';
          var help = usageNode('span', 'usage-cost-help');
          var hint = usageNode('button', 'usage-cost-help-trigger');
          hint.type = 'button';
          hint.innerHTML = '<svg viewBox="0 0 20 20" aria-hidden="true" focusable="false"><circle cx="10" cy="10" r="8.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7.5 7.5a2.5 2.5 0 0 1 5 0c0 1.8-2.5 1.8-2.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="10" cy="14" r="0.8" fill="currentColor"/></svg>';
          hint.setAttribute('aria-label', t('usageFlashReferencePriceHint'));
          var tooltip = usageNode('span', 'usage-cost-help-tooltip', t('usageFlashReferencePriceHint'));
          tooltip.setAttribute('role', 'tooltip');
          help.append(hint, tooltip);
          label.append(help);
        }
        return label;
      }

      function createSubagentAnalysisDetails(subagents, fallbackModels) {
        var details = usageNode('details', 'usage-subagent-analysis');
        details.open = true;
        var summary = usageNode('summary', '', t('usageSubagentDetailsTitle'));
        details.append(summary);
        var body = usageNode('div', 'usage-subagent-analysis-body');
        body.append(usageNode('p', 'usage-note', t('usageIsolationExplanation')));
        if (subagents.observedInvocations) body.append(usageNode('p', 'usage-note', t('usageObservedDelegationCalls', {
          single: formatMetricInteger(subagents.observedInvocations.delegate), parallel: formatMetricInteger(subagents.observedInvocations.parallel)
        })));
        body.append(usageNode('p', 'usage-note', t('usageSubagentLifecycle', {
          accepted: Number.isFinite(subagents.acceptedTaskCount) ? formatMetricInteger(subagents.acceptedTaskCount) : t('usageNotRecorded'),
          queued: formatMetricInteger(subagents.queuedCount), running: formatMetricInteger(subagents.runningCount),
          reused: formatMetricInteger(subagents.reusedCount), unreported: formatMetricInteger(subagents.usageUnreportedCount),
          interrupted: formatMetricInteger(subagents.interruptedCount)
        })));
        body.append(usageNode('p', 'usage-note', t('usageSubagentHandoffs', {
          results: formatMetricInteger((subagents.handoffCountByKind.delegate || 0) + (subagents.handoffCountByKind.parallel || 0)),
          pages: formatMetricInteger(subagents.handoffCountByKind['read-result'] || 0)
        })));
        if (subagents.summariesIncomplete || subagents.lifecycleIncomplete) body.append(usageNode('p', 'usage-warning', t('usageSubagentReconciliationPending')));
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
          body.append(usageNode('p', 'usage-note', t('usageRunSummaryUnavailable')));
        }
        if (fallbackModels.length) {
          body.append(usageNode('h5', 'usage-subagent-group-title', t('usageSubagentModels')));
          var modelList = usageNode('div', 'usage-analysis-list');
          modelList.className += ' usage-subagent-model-fallback';
          modelList.append(usageNode('p', 'usage-note', t('usageSubagentSourceFallback')));
          fallbackModels.forEach(function(group) {
            var row = createCompactUsageRow(getUsageGroupLabel(group), group.usage, group.sourceId);
            appendCompactCache(row, group.usage);
            appendSubagentTaskCounts(row, group);
            modelList.append(row);
          });
          body.append(modelList);
        }
        if ((subagents.byProfileLane || []).length) {
          body.append(usageNode('h5', 'usage-subagent-group-title', t('usageSubagentWorkTypes')));
          var workTypeList = usageNode('div', 'usage-analysis-list');
          subagents.byProfileLane.forEach(function(group) {
            var row = createCompactUsageRow(formatSubagentWorkType(group), group.usage);
            appendCompactCache(row, group.usage);
            appendSubagentTaskCounts(row, group);
            workTypeList.append(row);
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
              usageNode('p', '', (hasReportedUsageTokens(run.usage) ? formatUsageTokens(run.usage) + ' Tokens' : t('usageNotReported')) + ' · '
                + formatAnalysisCost(run.usage) + ' · ' + formatDuration(run.durationMs))
            );
            appendUsageWarnings(row, run.usage);
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
