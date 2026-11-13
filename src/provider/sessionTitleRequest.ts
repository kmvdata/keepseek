import type * as vscode from 'vscode';
import type { ModelSourceStore } from '../accounts/accountStore';
import type { SubagentSettingsStore } from '../accounts/subagentSettingsStore';
import { resolveConfiguredSubagentModel } from '../accounts/subagentModelResolver';
import { abortable, createLogicalRunBudgetState, ExecutionCostBudget, LogicalBudgetExceededError, LogicalRunBudget, SharedUpstreamTokenBudget } from '../agent/executionPolicy';
import type { SubagentModelSetting } from '../agent/subagents/types';
import { OneShotTextRequestError, requestOneShotText } from '../agent/oneShotTextRequest';
import { getConfiguredAgentMaxCost, getConfiguredAgentMaxExecutionMs, getConfiguredAgentMaxTreeUpstreamTokens,
  getConfiguredModelRequestTimeoutMs, getConfiguredSubagentMaxExecutionMs, getConfiguredSubagentMaxUpstreamTokens } from '../shared/config';
import type { KeepseekLanguage } from '../shared/i18n';
import type { AgentRequest, AgentTaskBudgetAuthority, ProviderUsageLedgerRecord } from '../shared/types';
import { SESSION_TITLE_SYSTEM_PROMPT } from '../sessions/sessionTitle';
import type { UserTaskBudget } from '../sessions/userTaskBudget';

export interface SessionTitleRequestInput {
  globalStorageUri: vscode.Uri;
  workspaceKey: string;
  sourceStore: ModelSourceStore;
  settingsStore: SubagentSettingsStore;
  /** Captured from the execution segment or explicit click, never re-read from the picker. */
  parentRequest: Pick<AgentRequest, 'model'> & Partial<Pick<AgentRequest, 'sourceConfig'>>;
  /** Explicit clicks freeze the default subagent selection with the main model. */
  setting?: Pick<SubagentModelSetting, 'mode' | 'sourceId' | 'modelId'>;
  language: KeepseekLanguage;
  sessionId: string;
  taskId: string;
  userPrompt: string;
  token: string;
  signal: AbortSignal;
  taskBudget: UserTaskBudget;
  onUsageLedgerRecord: (record: ProviderUsageLedgerRecord) => Promise<void> | void;
  /** Persist only this task's counters, before dispatch and after settlement. */
  onBudgetChanged?: (next: UserTaskBudget) => Promise<void> | void;
}

/** The running main request and its title reserve against these exact objects.
 * A serialized snapshot is never an admission authority for concurrent work. */
export type SessionTitleLiveBudget = Pick<AgentTaskBudgetAuthority, 'run' | 'cost' | 'snapshot'>;
export type InputSessionTitleRequestInput = Omit<SessionTitleRequestInput, 'taskBudget'> & {
  /** Main-first gate: resolve after its first reservation is durable, or after
   * a no-request shortcut settles. Rejection never grants a fresh allowance. */
  liveBudget: Promise<SessionTitleLiveBudget>;
};

/** An explicit user regeneration is a new, narrowly bounded auxiliary action,
 * not another segment of the old task. Its allowance must not restore an old
 * deadline or grant a full main/child run; the host persists this separate
 * record before dispatch and keeps it out of the main task clock. */
export function createManualSessionTitleBudget(now = Date.now()): UserTaskBudget {
  const maxExecutionMs = Math.min(30_000, getConfiguredModelRequestTimeoutMs(),
    ...[getConfiguredAgentMaxExecutionMs(), getConfiguredSubagentMaxExecutionMs()].filter(value => value > 0));
  const maxTokens = Math.min(32_768, getConfiguredSubagentMaxUpstreamTokens(),
    ...[getConfiguredAgentMaxTreeUpstreamTokens()].filter(value => value > 0));
  return {
    version: 1, usedMs: 0, maxExecutionMs, maxCost: getConfiguredAgentMaxCost(), usedCostByCurrency: {},
    runBudget: createLogicalRunBudgetState({ deadlineAt: new Date(now + maxExecutionMs).toISOString() }),
    budgetLimits: { maxModelRequests: 1, maxToolRounds: 0, maxToolCalls: 0, maxContinuations: 0,
      maxContextEpochRollovers: 0, maxUpstreamTokens: maxTokens, maxTreeUpstreamTokens: maxTokens,
      maxContinuationOutputTokens: 0, maxContinuationOutputChars: 0 }
  };
}

/** Restores the spent root allowance. No fresh task allowance or UI clock is
 * created for naming. Legacy/incomplete budget snapshots fail closed. */
export function restoreSessionTitleBudget(budget: UserTaskBudget, now = Date.now()): {
  cost: ExecutionCostBudget;
  run: LogicalRunBudget;
  timeoutMs: number;
} {
  if (!budget?.runBudget || !budget.budgetLimits) {
    throw new OneShotTextRequestError('budget_missing', 'Session title task budget is unavailable / 会话标题任务预算不可用');
  }
  const run = new LogicalRunBudget(budget.runBudget, budget.budgetLimits,
    new SharedUpstreamTokenBudget(budget.budgetLimits.maxTreeUpstreamTokens, budget.runBudget.treeUpstreamTokens),
    budget.maxExecutionMs, now);
  return { cost: new ExecutionCostBudget(budget.maxCost ?? 0, budget.usedCostByCurrency), run,
    timeoutMs: sessionTitleBudgetTimeout(budget, run, now) };
}

function sessionTitleBudgetTimeout(budget: UserTaskBudget, run: LogicalRunBudget, now = Date.now()): number {
  const remainingMs = budget.maxExecutionMs > 0 ? budget.maxExecutionMs - budget.usedMs : Number.POSITIVE_INFINITY;
  const deadlineMs = run.deadlineAt === undefined ? Number.POSITIVE_INFINITY : run.deadlineAt - now;
  const timeoutMs = Math.min(30_000, getConfiguredModelRequestTimeoutMs(), remainingMs, deadlineMs);
  if (!(timeoutMs > 0)) {
    throw new OneShotTextRequestError('budget_exhausted', 'Session title task time budget is exhausted / 会话标题任务时间预算已用尽');
  }
  try { run.assertCanDispatch(); }
  catch (error) {
    if (!(error instanceof LogicalBudgetExceededError)) throw error;
    throw new OneShotTextRequestError('budget_exhausted', error.message);
  }
  return timeoutMs;
}

/** Merge this auxiliary request's delta into the latest task record. Callers
 * advance `previous` only after applying each callback, so settlement can undo
 * its own reservation without overwriting later task work or other metadata. */
export function mergeSessionTitleTaskBudget(
  current: UserTaskBudget,
  previous: UserTaskBudget,
  next: UserTaskBudget
): UserTaskBudget {
  const merged = structuredClone(current);
  merged.usedMs = Math.max(0, current.usedMs + next.usedMs - previous.usedMs);
  merged.usedCostByCurrency = { ...current.usedCostByCurrency };
  for (const currency of new Set([...Object.keys(previous.usedCostByCurrency ?? {}), ...Object.keys(next.usedCostByCurrency ?? {})])) {
    merged.usedCostByCurrency[currency] = Math.max(0, (current.usedCostByCurrency?.[currency] ?? 0)
      + (next.usedCostByCurrency?.[currency] ?? 0) - (previous.usedCostByCurrency?.[currency] ?? 0));
  }
  if (current.runBudget && previous.runBudget && next.runBudget) {
    const counters = ['modelRequests', 'promptTokens', 'completionTokens', 'reasoningTokens',
      'upstreamTokens', 'treeUpstreamTokens', 'usedMs'] as const;
    for (const key of counters) {
      merged.runBudget![key] = Math.max(0, current.runBudget[key] + next.runBudget[key] - previous.runBudget[key]);
    }
    const deadlines = [current.runBudget.deadlineAt, next.runBudget.deadlineAt]
      .filter((value): value is string => !!value && Number.isFinite(Date.parse(value)));
    if (deadlines.length) merged.runBudget!.deadlineAt = deadlines.reduce((a, b) => Date.parse(a) <= Date.parse(b) ? a : b);
  }
  return merged;
}

export function requestSessionTitle(input: SessionTitleRequestInput): Promise<string> {
  return requestSessionTitleInternal(input);
}

/** Input naming prepares its model immediately, independently of the main
 * response, then admits against the same live root allowance as that request. */
export function requestInputSessionTitle(input: InputSessionTitleRequestInput): Promise<string> {
  return requestSessionTitleInternal(input);
}

async function requestSessionTitleInternal(input: SessionTitleRequestInput | InputSessionTitleRequestInput): Promise<string> {
  // Subscribe before even the cancellation check: a rejected main preparation
  // must not leave an abandoned unhandled Promise after a title is retired.
  const pendingLive = 'liveBudget' in input ? input.liveBudget.then(
    value => ({ ok: true as const, value }), error => ({ ok: false as const, error })) : undefined;
  if (input.signal.aborted) throw new OneShotTextRequestError('cancelled', 'Session title cancelled / 会话标题已取消');
  // Snapshot before any settings/credential await. follow-main cannot observe a
  // picker mutation while the auxiliary request is being prepared.
  const parentRequest = { model: { ...input.parentRequest.model },
    sourceConfig: input.parentRequest.sourceConfig && { ...input.parentRequest.sourceConfig, apiKey: '' } };
  const capturedSetting = input.setting && { ...input.setting };
  const original = 'taskBudget' in input ? structuredClone(input.taskBudget) : undefined;
  let restored = original ? restoreSessionTitleBudget(original) : undefined;
  let resolved: Awaited<ReturnType<typeof resolveConfiguredSubagentModel>>;
  try {
    const setting = capturedSetting ?? { ...await input.settingsStore.load() };
    // An explicit execution source may be re-resolved through accountResolver;
    // an absent identity must never select the current/global picker source.
    const sourceId = parentRequest.sourceConfig?.sourceId ?? parentRequest.model.sourceId;
    if (setting.mode === 'follow-main' && (!sourceId
      || parentRequest.model.sourceId && parentRequest.model.sourceId !== sourceId)) {
      throw new OneShotTextRequestError('source_identity_missing',
        'Completed task source identity is unavailable / 已完成任务的来源身份不可核实');
    }
    resolved = await resolveConfiguredSubagentModel({
      globalStorageUri: input.globalStorageUri, workspaceKey: input.workspaceKey,
      sourceStore: input.sourceStore, settingsStore: input.settingsStore,
      // Captured snapshots identify a source, but never supply reusable keys.
      // Resolve its current credentials exclusively through accountResolver.
      parentRequest: setting.mode === 'follow-main'
        ? { model: { ...parentRequest.model, sourceId }, sourceConfig: undefined } : parentRequest,
      language: input.language, setting
    });
    if (setting.mode === 'follow-main' && (resolved.sourceConfig.provider !== parentRequest.model.provider
      || parentRequest.sourceConfig && (resolved.sourceConfig.sourceId !== parentRequest.sourceConfig.sourceId
        || resolved.sourceConfig.provider !== parentRequest.sourceConfig.provider
        || resolved.sourceConfig.baseUrl !== parentRequest.sourceConfig.baseUrl))) {
      throw new OneShotTextRequestError('source_identity_missing',
        'Completed task source identity has changed / 已完成任务的来源身份已改变');
    }
  } catch (error) {
    if (input.signal.aborted) throw new OneShotTextRequestError('cancelled', 'Session title cancelled / 会话标题已取消');
    if (error instanceof OneShotTextRequestError) throw error;
    throw new OneShotTextRequestError('model_unavailable',
      'The selected title model is missing, disabled, or unavailable / 标题模型已缺失、被禁用或不可用');
  }
  if (input.signal.aborted) throw new OneShotTextRequestError('cancelled', 'Session title cancelled / 会话标题已取消');
  let live: SessionTitleLiveBudget | undefined;
  if (pendingLive) {
    try {
      const ready = await abortable(pendingLive, input.signal);
      if (!ready.ok) throw ready.error;
      live = ready.value;
      const snapshot = live.snapshot();
      if (!snapshot.runBudget || !snapshot.budgetLimits) throw new Error('Missing root allowance');
      restored = { cost: live.cost, run: live.run, timeoutMs: sessionTitleBudgetTimeout(snapshot, live.run) };
    } catch (error) {
      if (input.signal.aborted) throw new OneShotTextRequestError('cancelled', 'Session title cancelled / 会话标题已取消');
      if (error instanceof OneShotTextRequestError) throw error;
      throw new OneShotTextRequestError('budget_missing', 'Input title root budget unavailable / 输入标题所属任务预算不可用');
    }
  }
  if (!restored) throw new OneShotTextRequestError('budget_missing', 'Session title task budget is unavailable / 会话标题任务预算不可用');
  const activeBudget = restored;
  const startedAt = performance.now();
  const publishBudget = async () => {
    // Concurrent work has one clock and one admission ledger. Sampling its
    // authority preserves main/child reservations and never double-adds time.
    const next = live ? live.snapshot() : structuredClone(original!);
    if (!live) {
      next.usedMs = original!.usedMs + Math.max(0, Math.floor(performance.now() - startedAt));
      next.usedCostByCurrency = activeBudget.cost.snapshot();
      activeBudget.run.syncUsedMs(next.usedMs);
      next.runBudget = { ...activeBudget.run.state };
    }
    await input.onBudgetChanged?.(next);
  };
  try {
    return await requestOneShotText({
      purpose: 'session_title', requestId: `session_title_${input.token}`,
      model: resolved.model, sourceConfig: resolved.sourceConfig,
      systemPrompt: SESSION_TITLE_SYSTEM_PROMPT, userPrompt: input.userPrompt,
      language: input.language, sessionId: input.sessionId, taskId: input.taskId,
      globalStorageUri: input.globalStorageUri, signal: input.signal,
      maxOutputTokens: 512, timeoutMs: activeBudget.timeoutMs,
      taskCostBudget: activeBudget.cost, taskRunBudget: activeBudget.run,
      onUsageLedgerRecord: input.onUsageLedgerRecord,
      onBudgetChanged: publishBudget
    });
  } catch (error) {
    if (error instanceof LogicalBudgetExceededError) {
      throw new OneShotTextRequestError('budget_exhausted', error.message);
    }
    throw error;
  } finally {
    // Covers admission/transport failures before the one-shot cleanup hook too.
    await publishBudget();
  }
}
