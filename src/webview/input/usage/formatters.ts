import type { WebviewFragment } from '../composition';

export const usageFormattersFragment: WebviewFragment = {
  id: 'usage.formatters',
  source: `
      function createUsageSection(titleKey) {
        var section = usageNode('section', 'usage-section');
        var header = usageNode('div', 'usage-section-heading');
        header.append(usageNode('h3', '', t(titleKey)));
        section.append(header);
        return section;
      }

      function formatActualCacheRateOnly(usage) {
        if (!hasUsageData(usage)) {
          return t('usagePendingValue');
        }
        if (!(usage.cacheDataRequestCount > 0 || hasCacheUsageData(usage))) {
          return t('usageMetricCacheUnavailableValue');
        }
        var rate = Number.isFinite(usage.cacheHitRate) ? usage.cacheHitRate : calculateHitRate(usage);
        return Number.isFinite(rate) ? formatMetricPercent(rate) : t('usageMetricCacheUnavailableValue');
      }

      function formatRoundedPercent(value) {
        var number = Number(value);
        return Number.isFinite(number) ? Math.round(number) + '%' : t('usagePendingValue');
      }

      function formatUsageSharePercent(value) {
        var number = Number(value);
        if (!Number.isFinite(number)) { return t('usagePendingValue'); }
        return number > 0 && number < 1 ? '<1%' : Math.round(number) + '%';
      }

      function formatUsageRuntime(value) {
        var totalSeconds = Math.max(0, Math.floor(Number(value) / 1000));
        if (!Number.isFinite(totalSeconds)) { return t('usagePendingValue'); }
        var minutes = Math.floor(totalSeconds / 60);
        var seconds = totalSeconds % 60;
        return minutes > 0
          ? t('usageRuntimeMinutesSeconds', { minutes: minutes, seconds: seconds })
          : t('usageRuntimeSeconds', { seconds: seconds });
      }

      function formatUsageCompactTokens(value) {
        var tokens = Math.max(0, Math.floor(Number(value) || 0));
        if (tokens >= 1000000) {
          var millions = tokens / 1000000;
          return (millions >= 10 || Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)) + 'M';
        }
        if (tokens >= 1000) {
          var thousands = tokens / 1000;
          return (thousands >= 100 || Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)) + 'K';
        }
        return String(tokens);
      }

      function formatSubagentCounts(count, value) {
        return t('usageSubagentStatusCounts', {
          total: count, completed: value.completedCount, failed: value.failedCount, stopped: value.stoppedCount
        });
      }

      function formatSubagentWorkType(value) {
        var profiles = { research: 'usageProfileResearch', review: 'usageProfileReview', proposal: 'usageProfileProposal' };
        var lanes = {
          'research-read': 'usageLaneResearch', 'review-read': 'usageLaneReview',
          'proposal': 'usageLaneProposal', 'nested-read': 'usageLaneNested'
        };
        var profile = profiles[value.profile] ? t(profiles[value.profile]) : String(value.profile || '');
        var lane = lanes[value.lane] ? t(lanes[value.lane]) : String(value.lane || '');
        return profile + ' / ' + lane;
      }

      function formatActualCache(usage) {
        if (!hasUsageData(usage)) {
          return t('usagePendingValue');
        }
        if (!(usage.cacheDataRequestCount > 0)) {
          return t('usageCacheUnavailableCoverage', { missing: usage ? usage.cacheDataMissingRequestCount : 0 });
        }
        var rate = Number.isFinite(usage.cacheHitRate)
          ? formatMetricPercent(usage.cacheHitRate) : t('usageMetricCacheUnavailableValue');
        return rate + ' · ' + t('usageCacheCoverage', {
          reported: usage.cacheDataRequestCount, missing: usage.cacheDataMissingRequestCount
        });
      }

      function formatUsageCost(usage) {
        var value = formatAccountedCosts(usage);
        if (value.available) { return value.text; }
        if (!hasUsageData(usage)) { return t('usagePendingValue'); }
        return usage.unpricedRequestCount > 0
          ? t('usageUnpriced', { count: usage.unpricedRequestCount }) : t('usageMetricCostUnavailableValue');
      }

      function formatUsageAvailabilityValue(usage, unavailableKey) {
        return hasUsageData(usage) ? t(unavailableKey) : t('usagePendingValue');
      }

      function hasActualUsage(usage) {
        return Boolean(usage && (usage.totalTokens > 0 || usage.requestCount > 0
          || usage.providerAttemptCount > 0
          || Object.keys(usage.costByCurrency || {}).some(function(currency) { return usage.costByCurrency[currency] > 0; })));
      }

      function usageNode(tag, className, text) {
        var element = document.createElement(tag);
        if (className) { element.className = className; }
        if (text !== undefined) { element.textContent = text; }
        return element;
      }

      function createMetricLine(labelText, valueText) {
        var row = document.createElement('span');
        row.className = 'context-progress-metric';

        var label = document.createElement('span');
        label.className = 'context-progress-metric-label';
        label.textContent = labelText;

        var value = document.createElement('span');
        value.className = 'context-progress-metric-value';
        value.textContent = valueText;

        row.append(label, value);
        return row;
      }

      function renderMetricLineInto(container, labelText, valueText) {
        container.innerHTML = '';
        container.append(createMetricLine(labelText, valueText));
      }

      function normalizeUsageMetrics(value) {
        var metrics = value && typeof value === 'object' ? value : {};
        return {
          sessionUsageStats: normalizeUsageStats(metrics.sessionUsageStats, 'sessionCost'),
          lastTurnUsage: normalizeUsageStats(metrics.lastTurnUsage, 'cost'),
          usageDetails: metrics.usageDetails && typeof metrics.usageDetails === 'object' ? metrics.usageDetails : null,
          supportsBilling: metrics.supportsBilling === true,
          balance: normalizeBalance(metrics.balance),
          promptCacheDiagnostics: metrics.promptCacheDiagnostics || null,
          turnCount: readNonNegativeNumber(metrics.turnCount, 0),
          contextPercent: readNonNegativeNumber(metrics.contextPercent, 0),
          contextCompressionTriggerRatio: readRatio(metrics.contextCompressionTriggerRatio, 0.8),
          contextSoftCompactRatio: readRatio(metrics.contextSoftCompactRatio, 0.5),
          toolResultSnipRatio: readRatio(metrics.toolResultSnipRatio, 0.6),
          contextCompactForceRatio: readRatio(metrics.contextCompactForceRatio, 0.9),
          slimToolModeEnabled: metrics.slimToolModeEnabled !== false
        };
      }

      function normalizeUsageStats(value, costKey) {
        if (!value || typeof value !== 'object') {
          return null;
        }
        var normalized = {
          promptTokens: readNonNegativeNumber(value.promptTokens, 0),
          completionTokens: readNonNegativeNumber(value.completionTokens, 0),
          totalTokens: readNonNegativeNumber(value.totalTokens, 0),
          cacheHitTokens: readNonNegativeNumber(value.cacheHitTokens, 0),
          cacheMissTokens: readNonNegativeNumber(value.cacheMissTokens, 0),
          cacheDataStatus: value.cacheDataStatus === 'reported' || value.cacheDataStatus === 'partial'
            ? value.cacheDataStatus
            : 'unavailable',
          cacheDataRequestCount: readNonNegativeNumber(value.cacheDataRequestCount, 0),
          cacheDataMissingRequestCount: readNonNegativeNumber(value.cacheDataMissingRequestCount, 0),
          requestCount: readNonNegativeNumber(value.requestCount, 0),
          providerAttemptCount: readNonNegativeNumber(value.providerAttemptCount, 0),
          usageResponseCount: readNonNegativeNumber(value.usageResponseCount, 0),
          cost: readNonNegativeNumber(value[costKey], 0),
          sessionCost: readNonNegativeNumber(value.sessionCost, 0),
          currency: typeof value.currency === 'string' ? value.currency.trim() : '',
          pricingStatus: value.pricingStatus === 'priced' || value.pricingStatus === 'partial'
            || value.pricingStatus === 'estimated_upper_bound'
            ? value.pricingStatus
            : 'unavailable',
          pricedRequestCount: readNonNegativeNumber(value.pricedRequestCount, 0),
          unpricedRequestCount: readNonNegativeNumber(value.unpricedRequestCount, 0),
          estimatedRequestCount: readNonNegativeNumber(value.estimatedRequestCount, 0),
          costByCurrency: normalizeCostByCurrency(value.costByCurrency),
          sourceId: typeof value.sourceId === 'string' ? value.sourceId : '',
          modelId: typeof value.modelId === 'string' ? value.modelId : '',
          provider: typeof value.provider === 'string' ? value.provider : '',
          protocol: typeof value.protocol === 'string' ? value.protocol : '',
          legacyUnattributed: value.legacyUnattributed === true,
          attemptStatsIncomplete: value.attemptStatsIncomplete === true
            || value.providerAttemptCount === undefined || value.usageResponseCount === undefined,
          cacheDiagnostics: normalizeCacheDiagnosticsForView(value.cacheDiagnostics),
          byModelSource: []
        };
        normalized.byModelSource = Array.isArray(value.byModelSource)
          ? value.byModelSource.map(function(group) { return normalizeUsageStats(group, 'cost'); }).filter(Boolean)
          : [];
        return normalized;
      }

      function normalizeCacheDiagnosticsForView(value) {
        if (!value || typeof value !== 'object') { return null; }
        function metricList(items, includeLane) {
          return Array.isArray(items) ? items.filter(function(item) {
            return item && typeof item === 'object';
          }).map(function(item) {
            var result = {
              source: typeof item.source === 'string' ? item.source : 'executor',
              rawHitRate: readOptionalMetricNumber(item.rawHitRate),
              expectedRawHitRateCeiling: readOptionalMetricNumber(item.expectedRawHitRateCeiling),
              reuseEfficiency: readOptionalMetricNumber(item.reuseEfficiency),
              cacheDataResponseCount: readNonNegativeNumber(item.cacheDataResponseCount, 0),
              cacheDataMissingResponseCount: readNonNegativeNumber(item.cacheDataMissingResponseCount, 0),
              comparableRequestCount: readNonNegativeNumber(item.comparableRequestCount, 0),
              healthyReusableRequestCount: readNonNegativeNumber(item.healthyReusableRequestCount, 0),
              anomalousReusableRequestCount: readNonNegativeNumber(item.anomalousReusableRequestCount, 0),
              requestCount: readNonNegativeNumber(item.requestCount, 0),
              promptTokens: readNonNegativeNumber(item.promptTokens, 0),
              reusablePrefixTokens: readNonNegativeNumber(item.reusablePrefixTokens, 0),
              unavoidableNewTokens: readNonNegativeNumber(item.unavoidableNewTokens, 0),
              localEstimateLowCount: readNonNegativeNumber(item.localEstimateLowCount, 0)
            };
            if (includeLane) {
              result.sourceId = typeof item.sourceId === 'string' ? item.sourceId : '';
              result.provider = typeof item.provider === 'string' ? item.provider : '';
              result.protocol = typeof item.protocol === 'string' ? item.protocol : '';
              result.originalModelId = typeof item.originalModelId === 'string' ? item.originalModelId : '';
              result.cacheFamilyId = typeof item.cacheFamilyId === 'string' ? item.cacheFamilyId : '';
              result.profile = typeof item.profile === 'string' ? item.profile : '';
              result.subagentLane = typeof item.subagentLane === 'string' ? item.subagentLane : '';
              result.coldRequestCount = readNonNegativeNumber(item.coldRequestCount, 0);
              result.continuedRequestCount = readNonNegativeNumber(item.continuedRequestCount, 0);
              result.siblingRequestCount = readNonNegativeNumber(item.siblingRequestCount, 0);
            }
            return result;
          }) : [];
        }
        return {
          rawHitRate: readOptionalMetricNumber(value.rawHitRate),
          mainAgentRawHitRate: readOptionalMetricNumber(value.mainAgentRawHitRate),
          expectedRawHitRateCeiling: readOptionalMetricNumber(value.expectedRawHitRateCeiling),
          mainAgentExpectedRawHitRateCeiling: readOptionalMetricNumber(value.mainAgentExpectedRawHitRateCeiling),
          reuseEfficiency: readOptionalMetricNumber(value.reuseEfficiency),
          mainAgentReuseEfficiency: readOptionalMetricNumber(value.mainAgentReuseEfficiency),
          cacheDataResponseCount: readNonNegativeNumber(value.cacheDataResponseCount, 0),
          cacheDataMissingResponseCount: readNonNegativeNumber(value.cacheDataMissingResponseCount, 0),
          coldStartRequestCount: readNonNegativeNumber(value.coldStartRequestCount, 0),
          controlledBoundaryRequestCount: readNonNegativeNumber(value.controlledBoundaryRequestCount, 0),
          comparableRequestCount: readNonNegativeNumber(value.comparableRequestCount, 0),
          healthyReusableRequestCount: readNonNegativeNumber(value.healthyReusableRequestCount, 0),
          anomalousReusableRequestCount: readNonNegativeNumber(value.anomalousReusableRequestCount, 0),
          providerCacheEvictionPossibleCount: readNonNegativeNumber(value.providerCacheEvictionPossibleCount, 0),
          estimatedReusableTokensNotHit: readNonNegativeNumber(value.estimatedReusableTokensNotHit, 0),
          estimatedLocalBoundaryLossTokens: readNonNegativeNumber(value.estimatedLocalBoundaryLossTokens, 0),
          reusablePrefixTokens: readNonNegativeNumber(value.reusablePrefixTokens, 0),
          unavoidableNewTokens: readNonNegativeNumber(value.unavoidableNewTokens, 0),
          localEstimateLowCount: readNonNegativeNumber(value.localEstimateLowCount, 0),
          estimatedLocalBoundaryExtraCostByCurrency: normalizeCostByCurrency(value.estimatedLocalBoundaryExtraCostByCurrency),
          lastAnomalyReason: typeof value.lastAnomalyReason === 'string' ? value.lastAnomalyReason : '',
          bySource: metricList(value.bySource, false),
          byLane: metricList(value.byLane, true),
          incomplete: value.incomplete === true
        };
      }

      function readOptionalMetricNumber(value) {
        var number = Number(value);
        return value === null || value === undefined || value === '' || !Number.isFinite(number) ? null : number;
      }

      function normalizeCostByCurrency(value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          return {};
        }
        var result = {};
        Object.keys(value).forEach(function(currency) {
          var cost = Number(value[currency]);
          if (currency.trim() && Number.isFinite(cost) && cost >= 0) {
            result[currency.trim()] = cost;
          }
        });
        return result;
      }

      function normalizeBalance(value) {
        if (!value || typeof value !== 'object') {
          return null;
        }
        var totalBalance = Number(value.totalBalance);
        return {
          totalBalance: Number.isFinite(totalBalance) ? totalBalance : null,
          currency: typeof value.currency === 'string' && value.currency.trim() ? value.currency.trim() : '¥',
          error: typeof value.error === 'string' ? value.error : ''
        };
      }

      function hasUsageData(usage) {
        return Boolean(usage && (usage.requestCount > 0 || usage.totalTokens > 0
          || usage.providerAttemptCount > 0));
      }

      function calculateHitRate(usage) {
        if (!hasCacheUsageData(usage)) {
          return null;
        }
        var denominator = Math.max(0, usage.cacheHitTokens) + Math.max(0, usage.cacheMissTokens);
        return denominator > 0 ? (Math.max(0, usage.cacheHitTokens) / denominator) * 100 : null;
      }

      function formatCacheHitRate(usage) {
        if (!hasUsageData(usage)) {
          return t('usagePendingValue');
        }
        if (!hasCacheUsageData(usage)) {
          return t('usageMetricCacheUnavailableValue');
        }
        var rate = formatMetricPercent(calculateHitRate(usage));
        return usage.cacheDataStatus === 'partial'
          ? rate + ' · ' + t('usageMetricCachePartialValue')
          : rate;
      }

      function hasCacheUsageData(usage) {
        return Boolean(usage && (
          usage.cacheDataStatus === 'reported'
          || usage.cacheDataStatus === 'partial'
          || usage.cacheDataRequestCount > 0
        ));
      }

      function findCurrentUsageGroup(groups) {
        for (var i = 0; i < groups.length; i++) {
          if (groups[i].sourceId === state.selectedSourceId && groups[i].modelId === state.selectedModelId) {
            return groups[i];
          }
        }
        return null;
      }

      function getUsageGroupLabel(group) {
        var models = Array.isArray(state.models) ? state.models : [];
        var model = findModelForSelection(models, group.sourceId, group.modelId);
        if (model) {
          return getModelSourceLabel(model) + ' / ' + getModelDisplayLabel(model);
        }
        return [group.sourceId || t('summarySourceUnknown'), group.modelId || 'Model'].join(' / ');
      }

      function formatAccountedCosts(usage) {
        if (!usage) {
          return { available: false, partial: false, amountText: '', text: '' };
        }
        var costs = usage.costByCurrency && typeof usage.costByCurrency === 'object'
          ? usage.costByCurrency
          : {};
        var currencies = Object.keys(costs).filter(function(currency) {
          return Number.isFinite(Number(costs[currency]));
        });
        if (!currencies.length && (usage.pricingStatus === 'priced'
          || usage.pricingStatus === 'estimated_upper_bound') && Number.isFinite(Number(usage.cost))) {
          currencies = usage.currency ? [usage.currency] : [];
          if (currencies.length) { costs = { [usage.currency]: Number(usage.cost) }; }
        }
        if (!currencies.length) {
          return { available: false, partial: false, amountText: '', text: '' };
        }
        var partial = usage.pricingStatus === 'partial' || usage.unpricedRequestCount > 0;
        var truncateToCents = usesOfficialDeepSeekCostFormat(usage);
        var amountText = currencies.map(function(currency) {
          return formatMetricCost(costs[currency], currency, true, truncateToCents);
        }).join(' · ');
        var textValue = amountText;
        if (partial) {
          textValue += ' · ' + t('usagePartialPricing', { count: usage.unpricedRequestCount || 0 });
        }
        return { available: true, partial: partial, amountText: amountText, text: textValue };
      }

      function usesOfficialDeepSeekCostFormat(usage) {
        if (usage.provider === 'deepseek'
          && (usage.pricedRequestCount > 0 || usage.estimatedRequestCount > 0)) {
          return true;
        }
        var pricedGroups = Array.isArray(usage.byModelSource)
          ? usage.byModelSource.filter(function(group) { return group.pricedRequestCount > 0; })
          : [];
        return pricedGroups.length > 0
          && pricedGroups.every(function(group) { return group.provider === 'deepseek'; });
      }

      function normalizeCacheReasonList(value) {
        return Array.isArray(value)
          ? value.filter(function(reason) { return typeof reason === 'string' && Boolean(reason.trim()); }).slice(0, 12)
          : [];
      }

      function formatCacheReason(reason) {
        var normalized = String(reason || '');
        if (normalized.indexOf('history_rewrite:') === 0) {
          var rewriteReason = normalized.slice('history_rewrite:'.length);
          var rewriteKey = 'cacheReason_history_rewrite_' + rewriteReason;
          var rewriteLabel = t(rewriteKey);
          return rewriteLabel === rewriteKey
            ? t('cacheReason_history_rewrite')
            : t('cacheReason_history_rewrite') + ' (' + rewriteLabel + ')';
        }
        var key = 'cacheReason_' + normalized;
        var localized = t(key);
        return localized === key ? normalized : localized;
      }

      // 上下文“已用”百分比：会话还没有开始（会被格式化成 0.00%）时一律显示占位，
      // 用 -- 表达“还没有开始”，不再赘述没有信息量的 0.00%。
      function isContextUsagePending(value) {
        return formatMetricPercent(clampNumber(value, 0, 100)) === '0.00%';
      }

      function formatContextPercentValue(value) {
        return isContextUsagePending(value)
          ? t('usagePendingValue')
          : formatMetricPercent(clampNumber(value, 0, 100));
      }

      function formatMetricPercent(value) {
        if (value === null || value === undefined || value === '') {
          return t('usagePendingValue');
        }
        var number = Number(value);
        return Number.isFinite(number) ? number.toFixed(2) + '%' : t('usagePendingValue');
      }

      function formatMetricTokens(value, hasData) {
        if (!hasData) {
          return t('usagePendingValue');
        }
        return formatCompactTokenCount(readNonNegativeNumber(value, 0));
      }

      function formatCompactTokenCount(value) {
        var tokens = Math.max(0, Math.floor(Number(value) || 0));
        if (tokens >= 1000000) {
          var millions = Math.floor(tokens / 10000) / 100;
          return millions.toFixed(2) + 'm';
        }
        if (tokens >= 1000) {
          return Math.floor(tokens / 1000) + 'k';
        }
        return String(tokens);
      }

      function formatMetricInteger(value) {
        return Math.max(0, Math.floor(Number(value) || 0)).toLocaleString();
      }

      function formatMetricCost(value, currency, hasData, truncateToCents) {
        if (!hasData) {
          return t('usagePendingValue');
        }
        var number = Number(value);
        if (!Number.isFinite(number)) {
          return t('usagePendingValue');
        }
        if (truncateToCents) {
          var nonNegative = Math.max(0, number);
          number = Math.floor((nonNegative + Number.EPSILON * Math.max(1, nonNegative)) * 100) / 100;
        } else if (number > 0 && number < 0.000001) {
          return (currency || '') + '<0.000001';
        }
        return (currency || '') + number.toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: truncateToCents ? 2 : 6
        });
      }

      function formatMetricBalance(balance) {
        if (!balance || balance.totalBalance === null) {
          return balance && balance.error
            ? t('usageMetricUnavailableValue') : t('usagePendingValue');
        }
        return (balance.currency || '¥') + Number(balance.totalBalance).toLocaleString(undefined, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2
        });
      }

      function getUsageCurrency(primary, fallback) {
        return primary && primary.currency ? primary.currency : fallback && fallback.currency ? fallback.currency : '¥';
      }

      function readNonNegativeNumber(value, fallback) {
        var number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : fallback;
      }

      function readRatio(value, fallback) {
        var number = Number(value);
        return Number.isFinite(number) && number >= 0 ? number : fallback;
      }

      function clampNumber(value, min, max) {
        return Math.min(max, Math.max(min, Number(value) || 0));
      }

`.slice(1)
};
