import type {
  ChangeSet,
  RepairLoopState,
  RunDetailsChangeSetSummary,
  RunDetailsStatus,
  RunDetailsSummary,
  RunDetailsToolCallSummary,
  RunContextProjectionMetadata,
  SafeNpmScript,
  TaskPlan,
  ToolAuthorizationDecision
} from '../../shared/types';
import type { InteractionTraceEvent } from './interactionTrace';

const MAX_TOOL_CALLS_IN_SUMMARY = 80;
const MAX_SUMMARY_CHARS = 500;
const MAX_CHANGE_SET_FILES_IN_SUMMARY = 256;
const SENSITIVE_KEY_PATTERN = /(?:api.?key|authorization|bearer|token|password|passwd|secret|private.?key|client.?secret)/iu;

export interface RunDetailsBuilderInput {
  runId: string;
  sessionId?: string;
  assistantMessageId?: string;
  backgroundRunId?: string;
  modelId: string;
  thinkingEnabled: boolean;
  traceLogUri?: string;
  startedAt?: string;
}

export class RunDetailsBuilder {
  private readonly startedAt: string;
  private readonly startedAtMs: number;
  private readonly toolCalls: RunDetailsToolCallSummary[] = [];
  private readonly authorizations: RunDetailsSummary['authorizations'] = [];
  private readonly changeSets: RunDetailsChangeSetSummary[] = [];
  private readonly validations: RunDetailsSummary['validations'] = [];
  private taskPlan: TaskPlan | undefined;
  private taskPlanUpdateCount = 0;
  private requestCount = 0;
  private toolCallCount = 0;
  private messageCount = 0;
  private exposedToolCount = 0;
  private maxOutputTokens: number | undefined;
  private budgetStopReason: string | undefined;
  private failureReason: string | undefined;
  private truncated = false;

  public constructor(private readonly input: RunDetailsBuilderInput) {
    this.startedAt = input.startedAt ?? new Date().toISOString();
    this.startedAtMs = Date.parse(this.startedAt);
  }

  public record(event: InteractionTraceEvent, timestamp = new Date().toISOString()): void {
    switch (event.type) {
      case 'task_plan_update':
        if (isTaskPlan(event.plan)) {
          this.taskPlan = cloneTaskPlan(event.plan);
          this.taskPlanUpdateCount += 1;
        }
        return;
      case 'upstream_request':
        this.recordModelRequest(event.body);
        return;
      case 'tool_call':
        this.recordToolCallEvent(event, timestamp);
        return;
      case 'tool_authorization_decision':
        if (isAuthorizationDecision(event.decision)) {
          this.recordAuthorization(event.decision);
        }
        return;
      case 'change_set_created':
        this.recordChangeSetEvent(event);
        return;
      case 'run_finish':
        if (typeof event.finishReason === 'string') {
          this.budgetStopReason = normalizeBudgetReason(event.finishReason);
        }
        return;
      case 'run_error':
        this.failureReason = readErrorMessage(event.error);
        return;
      default:
        return;
    }
  }

  public recordToolArguments(toolCallId: string, toolName: string, args: Record<string, unknown>): void {
    const tool = this.ensureTool(toolCallId, toolName);
    tool.argumentsSummary = summarizeToolArguments(args);
  }

  public recordToolResult(toolCallId: string, toolName: string, rawResult: string): void {
    const tool = this.ensureTool(toolCallId, toolName);
    const parsed = parseRecord(rawResult);
    tool.endedAt = new Date().toISOString();
    tool.durationMs = Math.max(0, Date.parse(tool.endedAt) - Date.parse(tool.startedAt));
    tool.resultSummary = summarizeToolResult(rawResult);
    tool.truncated = rawResult.length > MAX_SUMMARY_CHARS;
    if (parsed?.errorType === 'authorization_denied') {
      tool.status = 'denied';
    } else {
      tool.status = parsed?.ok === false ? 'failed' : 'succeeded';
    }
    if (toolName === 'keepseek_run_validation') {
      this.validations.push({
        script: isSafeNpmScript(parsed?.script) ? parsed.script : undefined,
        ok: typeof parsed?.ok === 'boolean' ? parsed.ok : undefined,
        exitCode: typeof parsed?.exitCode === 'number' ? parsed.exitCode : undefined,
        durationMs: typeof parsed?.durationMs === 'number' ? parsed.durationMs : undefined,
        errors: readNestedNumber(parsed, 'diagnostics', 'errors'),
        warnings: readNestedNumber(parsed, 'diagnostics', 'warnings'),
        error: compactString(parsed?.error)
      });
    }
  }

  public finish(input: {
    taskPlan: TaskPlan;
    repairLoop: RepairLoopState;
    changeSet?: ChangeSet;
    finishReason?: string;
    failureReason?: string;
    stopped?: boolean;
  }): RunDetailsSummary {
    this.taskPlan = cloneTaskPlan(input.taskPlan);
    this.failureReason = input.failureReason ?? this.failureReason;
    this.budgetStopReason = normalizeBudgetReason(input.finishReason) ?? this.budgetStopReason;
    if (input.changeSet) {
      this.upsertChangeSet(toChangeSetSummary(input.changeSet));
    }
    const status = resolveStatus(input);
    return this.build(status);
  }

  public build(status: RunDetailsStatus = this.failureReason ? 'failed' : 'running'): RunDetailsSummary {
    const endedAt = status === 'running' ? undefined : new Date().toISOString();
    const plan = this.taskPlan;
    const summary: RunDetailsSummary = {
      runId: this.input.runId,
      sessionId: this.input.sessionId,
      assistantMessageId: this.input.assistantMessageId,
      backgroundRunId: this.input.backgroundRunId,
      modelId: this.input.modelId,
      status,
      startedAt: this.startedAt,
      endedAt,
      durationMs: endedAt ? Math.max(0, Date.parse(endedAt) - this.startedAtMs) : undefined,
      taskPlan: plan
        ? {
            status: plan.status,
            goal: plan.goal,
            updateCount: this.taskPlanUpdateCount,
            completedSteps: plan.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length,
            totalSteps: plan.steps.length,
            blockers: plan.blockers.slice(0, 10).map((blocker) => blocker.slice(0, 240))
          }
        : undefined,
      modelRequests: {
        requestCount: this.requestCount,
        messageCount: this.messageCount,
        exposedToolCount: this.exposedToolCount,
        maxOutputTokens: this.maxOutputTokens,
        thinkingEnabled: this.input.thinkingEnabled
      },
      toolCallCount: this.toolCallCount,
      toolCalls: this.toolCalls.map((tool) => ({ ...tool })),
      authorizations: this.authorizations.map((authorization) => ({ ...authorization })),
      changeSets: this.changeSets.map(cloneChangeSetSummary),
      validations: this.validations.map((validation) => ({ ...validation })),
      contextSources: this.contextSources.map((source) => ({ ...source })),
      contextDiscarded: this.contextDiscarded.map((source) => ({ ...source })),
      contextDeduplication: this.contextDeduplication ? { ...this.contextDeduplication } : undefined,
      budgetStopReason: this.budgetStopReason,
      failureReason: this.failureReason,
      traceLogUri: this.input.traceLogUri,
      truncated: this.truncated
    };
    return summary;
  }

  private contextSources: RunDetailsSummary['contextSources'] = [];
  private contextDiscarded: RunDetailsSummary['contextDiscarded'] = [];
  private contextDeduplication: RunDetailsSummary['contextDeduplication'];

  public setRunContext(metadata: RunContextProjectionMetadata | undefined): void {
    if (!metadata) {
      this.contextSources = [];
      this.contextDiscarded = [];
      this.contextDeduplication = undefined;
      return;
    }
    this.contextSources = metadata.sources.map((source) => ({ ...source }));
    this.contextDiscarded = metadata.discarded.map((source) => ({ ...source }));
    this.contextDeduplication = {
      before: metadata.beforeDeduplicationCount,
      after: metadata.afterDeduplicationCount,
      discarded: metadata.discarded.length,
      truncated: metadata.truncated
    };
  }

  private recordModelRequest(value: unknown): void {
    this.requestCount += 1;
    if (!isRecord(value)) {
      return;
    }
    this.messageCount = Math.max(this.messageCount, Array.isArray(value.messages) ? value.messages.length : 0);
    this.exposedToolCount = Math.max(this.exposedToolCount, Array.isArray(value.tools) ? value.tools.length : 0);
    if (typeof value.maxTokens === 'number') {
      this.maxOutputTokens = value.maxTokens;
    } else if (typeof value.max_tokens === 'number') {
      this.maxOutputTokens = value.max_tokens;
    }
  }

  private recordToolCallEvent(event: InteractionTraceEvent, timestamp: string): void {
    this.toolCallCount += 1;
    const toolCall = isRecord(event.toolCall) ? event.toolCall : undefined;
    const fn = toolCall && isRecord(toolCall.function) ? toolCall.function : undefined;
    const id = typeof toolCall?.id === 'string'
      ? toolCall.id
      : typeof event.toolCallId === 'string' ? event.toolCallId : `tool-${this.toolCalls.length + 1}`;
    const name = typeof fn?.name === 'string'
      ? fn.name
      : typeof event.toolName === 'string' ? event.toolName : 'unknown_tool';
    const tool = this.ensureTool(id, name, timestamp);
    if (typeof fn?.arguments === 'string' && fn.arguments.length <= 4_000) {
      const parsed = parseRecord(fn.arguments);
      if (parsed) {
        tool.argumentsSummary = summarizeToolArguments(parsed);
      }
    }
  }

  private ensureTool(id: string, name: string, timestamp = new Date().toISOString()): RunDetailsToolCallSummary {
    const existing = this.toolCalls.find((tool) => tool.id === id);
    if (existing) {
      return existing;
    }
    if (this.toolCalls.length >= MAX_TOOL_CALLS_IN_SUMMARY) {
      this.truncated = true;
      return this.toolCalls[this.toolCalls.length - 1];
    }
    const tool: RunDetailsToolCallSummary = {
      id,
      name,
      startedAt: timestamp,
      status: 'running'
    };
    this.toolCalls.push(tool);
    return tool;
  }

  private recordAuthorization(decision: ToolAuthorizationDecision): void {
    this.authorizations.push({
      toolName: decision.toolName,
      allowed: decision.allowed,
      riskLevel: decision.riskLevel,
      scope: decision.scope,
      source: decision.source,
      reason: decision.reason ? redactSensitiveText(decision.reason).slice(0, 240) : undefined
    });
    const tool = [...this.toolCalls].reverse().find((item) => item.name === decision.toolName && item.status === 'running');
    if (tool) {
      tool.riskLevel = decision.riskLevel;
      tool.scope = decision.scope;
      if (!decision.allowed) {
        tool.status = 'denied';
      }
    }
  }

  private recordChangeSetEvent(event: InteractionTraceEvent): void {
    if (typeof event.changeSetId !== 'string') {
      return;
    }
    const files = Array.isArray(event.files) ? event.files.filter(isRecord) : [];
    this.upsertChangeSet({
      id: event.changeSetId,
      fileCount: typeof event.fileCount === 'number' ? event.fileCount : files.length,
      status: 'pending',
      operationSummary: compactString(event.operationSummary),
      labels: files.map((file) => compactString(file.label)).filter((label): label is string => Boolean(label)).slice(0, MAX_CHANGE_SET_FILES_IN_SUMMARY),
      files: files.slice(0, MAX_CHANGE_SET_FILES_IN_SUMMARY).map((file, index) => ({
        id: compactString(file.id) ?? `file-${index + 1}`,
        label: compactString(file.label) ?? `File ${index + 1}`,
        action: normalizeDraftEditAction(file.action),
        status: 'pending'
      })),
      appliedCount: 0,
      failedCount: 0
    });
  }

  private upsertChangeSet(changeSet: RunDetailsChangeSetSummary): void {
    const index = this.changeSets.findIndex((item) => item.id === changeSet.id);
    if (index >= 0) {
      this.changeSets[index] = changeSet;
    } else {
      this.changeSets.push(changeSet);
    }
  }
}

export function summarizeToolArguments(args: Record<string, unknown>): string {
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args).slice(0, 20)) {
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      summary[key] = '[redacted]';
    } else if (key === 'content' || key === 'newText' || key === 'patch') {
      summary[key] = typeof value === 'string' ? { chars: value.length } : '[omitted]';
    } else if (typeof value === 'string') {
      summary[key] = redactSensitiveText(value).slice(0, 180);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      summary[key] = value;
    } else if (Array.isArray(value)) {
      summary[key] = { items: value.length };
    } else if (isRecord(value)) {
      summary[key] = { keys: Object.keys(value).slice(0, 12) };
    }
  }
  return JSON.stringify(summary).slice(0, MAX_SUMMARY_CHARS);
}

export function summarizeToolResult(rawResult: string): string {
  const parsed = parseRecord(rawResult);
  if (!parsed) {
    return redactSensitiveText(rawResult).replace(/\s+/gu, ' ').slice(0, MAX_SUMMARY_CHARS);
  }
  const summary: Record<string, unknown> = {};
  for (const key of ['ok', 'errorType', 'error', 'path', 'script', 'exitCode', 'durationMs', 'timedOut', 'total', 'count', 'truncated']) {
    const value = parsed[key];
    if (typeof value === 'string') summary[key] = redactSensitiveText(value).slice(0, 240);
    else if (typeof value === 'number' || typeof value === 'boolean') summary[key] = value;
  }
  if (isRecord(parsed.diagnostics)) {
    summary.diagnostics = {
      errors: parsed.diagnostics.errors,
      warnings: parsed.diagnostics.warnings,
      total: parsed.diagnostics.total,
      truncated: parsed.diagnostics.truncated
    };
  }
  if (!Object.keys(summary).length) {
    summary.result = { chars: rawResult.length, keys: Object.keys(parsed).slice(0, 16) };
  }
  return JSON.stringify(summary).slice(0, MAX_SUMMARY_CHARS);
}

export function applyChangeSetEventToRunDetails(
  summary: RunDetailsSummary,
  event: Record<string, unknown>,
  changeSet?: ChangeSet
): RunDetailsSummary {
  const changeSetId = typeof event.changeSetId === 'string'
    ? event.changeSetId
    : isRecord(event.result) && typeof event.result.changeSetId === 'string'
      ? event.result.changeSetId
      : undefined;
  if (!changeSetId) {
    return summary;
  }
  const changeSets = summary.changeSets.map(cloneChangeSetSummary);
  const target = changeSets.find((item) => item.id === changeSetId);
  if (!target) {
    return summary;
  }
  if (changeSet?.id === changeSetId) {
    changeSets[changeSets.indexOf(target)] = toChangeSetSummary(changeSet);
    return { ...summary, changeSets };
  }
  const result = isRecord(event.result) ? event.result : undefined;
  const applied = Array.isArray(result?.appliedEditIds) ? result.appliedEditIds.length : undefined;
  const reverted = Array.isArray(result?.revertedEditIds) ? result.revertedEditIds.length : undefined;
  const failures = Array.isArray(result?.failed) ? result.failed.length : 0;
  if (event.type === 'change_set_apply_result') {
    updateSummaryFileStatuses(target, result, 'applied', 'apply_failed');
    if (target.files?.length) {
      updateChangeSetSummaryCounts(target);
    } else {
      target.appliedCount = applied ?? target.appliedCount;
      target.failedCount = failures;
      target.status = failures ? 'partially_failed' : target.appliedCount >= target.fileCount ? 'applied' : 'partially_applied';
    }
  } else if (event.type === 'change_set_revert_result') {
    updateSummaryFileStatuses(target, result, 'reverted', 'revert_failed');
    if (target.files?.length) {
      updateChangeSetSummaryCounts(target);
    } else {
      target.failedCount = failures;
      target.status = failures ? 'partially_failed' : (reverted ?? 0) >= target.fileCount ? 'reverted' : 'partially_applied';
    }
  } else if (event.type === 'change_set_discarded') {
    target.files?.forEach((file) => {
      if (file.status === 'pending' || file.status === 'apply_failed') file.status = 'discarded';
    });
    if (target.files?.length) {
      updateChangeSetSummaryCounts(target);
    } else {
      target.status = 'discarded';
    }
  } else if (event.type === 'change_set_file_discarded' && typeof event.editId === 'string') {
    const file = target.files?.find((item) => item.id === event.editId);
    if (file) {
      file.status = 'discarded';
      file.error = undefined;
      updateChangeSetSummaryCounts(target);
    }
  }
  return { ...summary, changeSets };
}

function updateSummaryFileStatuses(
  target: RunDetailsChangeSetSummary,
  result: Record<string, unknown> | undefined,
  succeededStatus: 'applied' | 'reverted',
  failedStatus: 'apply_failed' | 'revert_failed'
): void {
  if (!target.files || !result) return;
  const succeededKey = succeededStatus === 'applied' ? 'appliedEditIds' : 'revertedEditIds';
  const succeededIds = new Set(Array.isArray(result[succeededKey])
    ? result[succeededKey].filter((id): id is string => typeof id === 'string')
    : []);
  const failures = new Map<string, string>();
  if (Array.isArray(result.failed)) {
    for (const failure of result.failed) {
      if (!isRecord(failure) || typeof failure.editId !== 'string') continue;
      failures.set(failure.editId, compactString(failure.error) ?? 'Operation failed.');
    }
  }
  for (const file of target.files) {
    if (succeededIds.has(file.id)) {
      file.status = succeededStatus;
      file.error = undefined;
    } else if (failures.has(file.id)) {
      file.status = failedStatus;
      file.error = failures.get(file.id)?.slice(0, 500);
    }
  }
}

function updateChangeSetSummaryCounts(target: RunDetailsChangeSetSummary): void {
  if (!target.files) return;
  const statuses = target.files.map((file) => file.status);
  target.appliedCount = statuses.filter((status) => status === 'applied').length;
  target.failedCount = statuses.filter((status) => status === 'apply_failed' || status === 'revert_failed').length;
  if (statuses.every((status) => status === 'discarded')) {
    target.status = 'discarded';
  } else if (statuses.every((status) => status === 'reverted' || status === 'discarded')) {
    target.status = 'reverted';
  } else if (statuses.every((status) => status === 'applied' || status === 'discarded')) {
    target.status = 'applied';
  } else if (target.failedCount > 0) {
    target.status = 'partially_failed';
  } else if (statuses.some((status) => status === 'applied' || status === 'reverted')) {
    target.status = 'partially_applied';
  } else {
    target.status = 'pending';
  }
}

function toChangeSetSummary(changeSet: ChangeSet): RunDetailsChangeSetSummary {
  return {
    id: changeSet.id,
    fileCount: changeSet.fileCount,
    status: changeSet.status,
    operationSummary: changeSet.operationSummary.slice(0, 320),
    labels: changeSet.files.map((file) => file.label).slice(0, MAX_CHANGE_SET_FILES_IN_SUMMARY),
    files: changeSet.files.slice(0, MAX_CHANGE_SET_FILES_IN_SUMMARY).map((file) => ({
      id: file.id,
      label: file.label.slice(0, 240),
      action: file.action,
      status: file.status,
      error: file.error?.slice(0, 500)
    })),
    appliedCount: changeSet.files.filter((file) => file.status === 'applied').length,
    failedCount: changeSet.files.filter((file) => file.status === 'apply_failed' || file.status === 'revert_failed').length
  };
}

function cloneChangeSetSummary(changeSet: RunDetailsChangeSetSummary): RunDetailsChangeSetSummary {
  return {
    ...changeSet,
    labels: [...changeSet.labels],
    files: changeSet.files?.map((file) => ({ ...file }))
  };
}

function normalizeDraftEditAction(value: unknown): ChangeSet['files'][number]['action'] {
  return value === 'create' || value === 'delete' || value === 'move' ? value : 'modify';
}

function resolveStatus(input: {
  taskPlan: TaskPlan;
  repairLoop: RepairLoopState;
  failureReason?: string;
  stopped?: boolean;
}): RunDetailsStatus {
  if (input.stopped || input.taskPlan.status === 'stopped') return 'stopped';
  if (input.failureReason || input.taskPlan.status === 'failed') return 'failed';
  if (input.repairLoop.status === 'waiting_for_apply' || input.repairLoop.status === 'ready_for_validation') return 'waiting';
  if (input.taskPlan.status === 'blocked') return 'blocked';
  return 'succeeded';
}

function normalizeBudgetReason(value: unknown): string | undefined {
  return typeof value === 'string' && /(?:budget|limit|exhausted|tool_iterations|run_time)/u.test(value)
    ? value.slice(0, 120)
    : undefined;
}

function readErrorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') return redactSensitiveText(value).slice(0, 500);
  if (!isRecord(value)) return undefined;
  return compactString(value.message) ?? compactString(value.error);
}

function compactString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim()
    ? redactSensitiveText(value).replace(/\s+/gu, ' ').trim().slice(0, MAX_SUMMARY_CHARS)
    : undefined;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(api[_ -]?key|authorization|bearer|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|private[_ -]?key|client[_ -]?secret)(\s*[:=]\s*)\S+/giu, '$1$2[redacted]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[opsu]_[A-Za-z0-9]{16,}|AKIA[A-Z0-9]{12,})\b/gu, '[redacted]');
}

function readNestedNumber(record: Record<string, unknown> | undefined, parent: string, key: string): number | undefined {
  const nested = record && isRecord(record[parent]) ? record[parent] : undefined;
  return typeof nested?.[key] === 'number' ? nested[key] : undefined;
}

function parseRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTaskPlan(value: unknown): value is TaskPlan {
  return isRecord(value) && typeof value.id === 'string' && Array.isArray(value.steps);
}

function isAuthorizationDecision(value: unknown): value is ToolAuthorizationDecision {
  return isRecord(value)
    && typeof value.toolName === 'string'
    && typeof value.allowed === 'boolean'
    && typeof value.riskLevel === 'string'
    && typeof value.scope === 'string'
    && typeof value.source === 'string';
}

function isSafeNpmScript(value: unknown): value is SafeNpmScript {
  return value === 'compile' || value === 'lint' || value === 'test';
}

function cloneTaskPlan(plan: TaskPlan): TaskPlan {
  return { ...plan, steps: plan.steps.map((step) => ({ ...step })), blockers: [...plan.blockers] };
}
