import {
  ExecutionClock,
  ExecutionBudgetError,
  ExecutionCostBudget,
  LogicalBudgetExceededError,
  LogicalRunBudget,
  SharedUpstreamTokenBudget,
  abortable,
  mergeCostLimits,
  mergeDurations
} from './executionPolicy';
import { createRunCheckpoint, checkpointCopy, AgentInterruptedError, recoveryBlocker, endpointHash, isCostLimitExhausted, migrateLegacyCapacityCheckpoint } from './runCheckpoint';
import { shapeWorkspaceListingResult } from './toolResultShaping';
import {
  getConfiguredAgentContinuationMaxOutputTokens,
  getConfiguredAgentFinalMaxOutputTokens,
  getConfiguredAgentMaxContextEpochRollovers,
  getConfiguredAgentMaxContinuations,
  getConfiguredAgentMaxCost,
  getConfiguredAgentMaxExecutionMs,
  getConfiguredAgentMaxModelRequests,
  getConfiguredAgentMaxTreeUpstreamTokens,
  getConfiguredAgentRepairMaxOutputTokens,
  getConfiguredAgentToolMaxOutputTokens,
  getConfiguredEvidenceMaxBytes,
  getConfiguredPatchSettings,
  getConfiguredProviderInlineResultMaxChars,
  getConfiguredStreamIdleTimeoutMs,
  getConfiguredSubagentMaxUpstreamTokens
} from '../shared/config';
import { createHash, randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  AgentActivityInput,
  AgentActivityPhase,
  AgentRequest,
  AgentResponse,
  AgentRunCallbacks,
  AgentToolResult,
  AgentToolRound,
  ContextUsageEstimate,
  DraftEdit,
  DraftRunEnvironmentEntry,
  DraftRunProposal,
  PromptCacheDiagnostics,
  RunDetailsSummary,
  SafeNpmScript,
  TaskPlan,
  ToolAuthorizationDecision,
  TurnUsageStats,
  UsageEvent,
  ProviderCacheObservation,
  UsagePriceSnapshot,
  UsageSource
} from '../shared/types';
import type { ProviderReplayState } from '../shared/types';
import {
  getConfiguredMaxRequestRetries,
  getConfiguredMaxRepairIterations,
  getConfiguredMaxValidationRuns,
  getConfiguredModelUsagePricing,
  getConfiguredRequestRetryBaseMs,
  getConfiguredWorkspaceReadMaxBytes
} from '../shared/config';
import { MissingModelSourceApiKeyError, resolveModelSourceConfig } from '../accounts/accountResolver';
import type { ModelSourceProvider } from '../accounts/types';
import {
  isOfficialAnthropicSource,
  requiresModelSourceApiKey
} from '../accounts/sourceCapabilities';
import { formatBytes } from '../shared/format';
import { decodeRollbackSafeUtf8Text } from '../shared/safeTextSnapshot';
import {
  getAgentRuntimeProfile,
  type ContextCompressionSettings
} from '../shared/modelProfiles';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME,
  APPLY_PATCH_TOOL_NAME,
  DELEGATE_PARALLEL_TOOL_NAME,
  DELEGATE_TASK_TOOL_NAME,
  DELETE_WORKSPACE_FILE_TOOL_NAME,
  estimateChatMessageTokens,
  estimateDeepSeekMessageTokens,
  FIND_REFERENCES_TOOL_NAME,
  FIND_SYMBOL_TOOL_NAME,
  GET_DOCUMENT_SYMBOLS_TOOL_NAME,
  GET_WORKSPACE_SYMBOLS_TOOL_NAME,
  GIT_CREATE_PATCH_TOOL_NAME,
  GIT_CURRENT_BRANCH_TOOL_NAME,
  GIT_DIFF_TOOL_NAME,
  GIT_STATUS_TOOL_NAME,
  GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME,
  LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME,
  READ_WORKSPACE_FILE_RANGE_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME,
  READ_SUBAGENT_RESULT_TOOL_NAME,
  READ_EVIDENCE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME,
  SEARCH_SESSION_ARCHIVE_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  isDraftEditPreparationTool,
  isDraftRunPreparationTool
} from './protocol';
import type {
  DelegateTaskInput,
  SubagentLane,
  SubagentToolAdapter
} from './subagents/types';
import { searchHistoryArchive } from './historyArchive';
import { allocateSharedMessageTokens, createAcceptedRootSubagentHandoffEstimate, getSubagentHandoffKind } from './subagentUsageStats';
import { buildProviderRequestProjection, getProviderRequestLane } from './providerRequestProjection';
import {
  calibrateContextUsageEstimate,
  createContextUsageEstimate,
  createContextUsageEstimateFromAnthropic,
  createContextUsageEstimateFromMessages,
  createContextUsageEstimateFromResponses,
  resolveOutputReserveTokens
} from './contextUsage';
import { WorkspaceToolAdapter, WorkspaceToolService } from './tools/workspaceTools';
import { preflightSafeValidation, ValidationToolAdapter, ValidationToolService } from './tools/validationTools';
import { SemanticToolAdapter, SemanticToolService } from './tools/semanticTools';
import { GitToolAdapter, GitToolService } from './tools/gitTools';
import {
  createAuthorizationDeniedToolResult,
  getToolAuthorizationMetadata,
  ToolAuthorizationAdapter,
  ToolAuthorizationService
} from './tools/toolAuthorization';
import type { KeepseekLanguage } from '../shared/i18n';
import { isReadableTextContent, shouldSkipTextUri } from '../shared/textFileGuards';
import {
  createDeleteDraftEdit as createDeleteDraftEditV1,
  createFullTextDraftEdit,
  getDraftEditBase,
  getDraftEditResult
} from '../edits/draftEdit';
import {
  hashBytes,
  inspectTextEncoding,
  parseKeepseekPatch,
  prepareTextPatch,
  type KeepseekPatchOperation,
  type TextPatchEditInput
} from '../edits/textPatch';
import { ChangeArtifactStore } from '../edits/changeArtifactStore';
import { DsmlToolParser } from './deepseek/dsmlToolParser';
import { createProviderClient } from './providers/factory';
import type { ProviderClientConfig } from './providers/types';
import type {
  OpenAiResponsesFunctionTool,
  OpenAiResponsesItem,
  OpenAiResponsesRequestBody
} from './providers/responsesTypes';
import type {
  AnthropicFunctionTool,
  AnthropicMessage,
  AnthropicMessagesRequestBody,
  AnthropicSystemTextBlock,
  AnthropicUserContentBlock
} from './providers/anthropicTypes';
import type { ApprovalReviewerAdapter } from '../approvals/approvalReviewer';
import { toReviewerModelContext } from '../approvals/approvalReviewer';
import { createExternalFileReviewRequest, createValidationReviewRequest } from '../approvals/approvalReviewSurface';
import { toApprovalReviewDisplay } from '../approvals/approvalReviewStore';
import { createBoundedReviewText } from '../approvals/approvalReviewHash';
import {
  AgentInteractionTrace,
  createNoopInteractionTrace,
  formatUnknownError,
  InteractionTraceLogService,
  summarizeDeepSeekMessage,
  summarizeDeepSeekRequestBody,
  summarizeDeepSeekToolCall,
  summarizeText
} from './logging/interactionTrace';
import {
  DeepSeekAssistantMessage,
  DeepSeekChatRequestBody,
  DeepSeekFunctionTool,
  DeepSeekMessage,
  DeepSeekStreamResult,
  DeepSeekToolCall,
  DeepSeekUsage
} from './deepseek/types';
import {
  addUsageEventToTurnStats,
  createUsageEvent,
  normalizeDeepSeekUsage
} from './usageStats';
import {
  createUsageLedgerRecords,
  createUsagePriceSnapshot,
  priceUsageFromSnapshot
} from './usageLedger';
import { createProviderCacheObservation } from './cacheObservation';
import { TaskPlanTracker } from './taskPlan';
import { createChangeSet } from '../edits/changeSet';
import { RepairLoopTracker, RunValidationStateTracker } from './repairLoop';
import { RunDetailsBuilder } from './logging/runDetails';
import { createDraftRunProposal } from '../runs/draftRunProposal';
import { normalizeApprovalMode } from './approvalMode';
import {
  createPlanPhaseBlockedToolResult,
  getPlanPhaseToolBlockReason
} from './executionMode';
import { ToolEvidencePersistenceError, ToolEvidenceStore } from './evidence/store';
import { prepareEvidenceEnvelope, stableStringify } from './evidence/shaping';
import type { ToolEvidence } from './evidence/types';
import { isContextTooLongError, ToolResultAdmissionController } from './toolResultAdmission';
import { ContextWindowCalibrationStore } from './contextWindowCalibrationStore';
import {
  DEEPSEEK_MODEL_IDENTITY_VERSION,
  getCanonicalModelIdentity
} from '../shared/deepSeekModels';
import {
  createContextEpochState,
  createEpochHostCheckpoint,
  createEpochSeed,
  createHostFallbackSummary,
  createTaskPlanProgressHash,
  createWorkFingerprint,
  observeNoProgress,
  shouldRolloverForSoftContextPressure,
  type ContextEpochRolloverReason
} from './contextEpoch';

const CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS = 2_048;
const SEARCH_SHAPED_RESULT_LIMIT = 120;
const SEARCH_SHAPED_RESULTS_PER_FILE_LIMIT = 12;
const SEARCH_SHAPED_TOTAL_CHARS = 50_000;
const SEARCH_SHAPED_LINE_CHARS = 500;
const SEARCH_SNIPPED_RESULT_LIMIT = 60;
const SEARCH_SNIPPED_RESULTS_PER_FILE_LIMIT = 6;
const SEARCH_SNIPPED_TOTAL_CHARS = 20_000;
const SEARCH_SNIPPED_LINE_CHARS = 300;
const RANGE_READ_SHAPED_CONTENT_CHARS = 160_000;
const RANGE_READ_SNIPPED_CONTENT_CHARS = 60_000;

interface AgentRuntimeConfig {
  sourceId: string;
  provider: ModelSourceProvider;
  apiKey: string;
  baseUrl: string;
  supportsBilling: boolean;
  contextWindowTokens: number;
  maxTokens: number;
  maxToolIterations: number;
  maxToolCalls: number;
  maxRunMs: number;
  maxCost: number;
  streamIdleTimeoutMs: number;
  temperature: number;
  topP: number;
  contextCompression: ContextCompressionSettings;
  maxRequestRetries: number;
  requestRetryBaseMs: number;
  maxValidationRuns: number;
  maxRepairIterations: number;
  maxModelRequests: number;
  maxContinuations: number;
  maxContextEpochRollovers: number;
  maxUpstreamTokens: number;
  maxTreeUpstreamTokens: number;
  toolMaxOutputTokens: number;
  finalMaxOutputTokens: number;
  continuationMaxOutputTokens: number;
  repairMaxOutputTokens: number;
}

interface OpenAiResponsesRunState {
  protocol: 'openai-responses';
  input: OpenAiResponsesItem[];
  tools: OpenAiResponsesFunctionTool[];
  replayItems: OpenAiResponsesItem[];
  lane: {
    sourceId: string;
    baseUrl: string;
  };
}

interface AnthropicMessagesRunState {
  protocol: 'anthropic-messages';
  system: AnthropicSystemTextBlock[];
  messages: AnthropicMessage[];
  tools: AnthropicFunctionTool[];
  replayMessages: AnthropicMessage[];
  lane: {
    sourceId: string;
    baseUrl: string;
  };
  thinking?: AnthropicMessagesRequestBody['thinking'];
  outputConfig?: AnthropicMessagesRequestBody['output_config'];
  cacheControl?: AnthropicMessagesRequestBody['cache_control'];
}

export type ProviderNativeRunState = OpenAiResponsesRunState | AnthropicMessagesRunState;

interface NormalizedAssistantToolCalls {
  assistant: DeepSeekAssistantMessage;
  displayReasoningContent?: string | null;
  source: 'native' | 'dsml';
}

interface EmulatedDsmlToolResult {
  toolCall: DeepSeekToolCall;
  content: string;
}

interface ToolResultLedgerEntry {
  toolName: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  estimatedTokens: number;
  rawLength: number;
  shapedLength: number;
  compressible: boolean;
  truncated: boolean;
}

interface ShapedToolResult {
  content: string;
  path?: string;
  startLine?: number;
  endLine?: number;
  rawLength: number;
  shapedLength: number;
  compressible: boolean;
  truncated: boolean;
}

interface LineReplacementRange {
  startLine: number;
  endLine: number;
}

interface DraftEditToolInput {
  rawPath: string;
  content: string;
  reason: string;
  replaceRange?: LineReplacementRange;
}

interface UpstreamUsageTotals {
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens: number;
  cost: number;
  currency: string;
  records: UsageEvent[];
}

export class AgentRunAbortedError extends Error {
  public constructor(language: KeepseekLanguage) {
    super(language === 'en' ? 'Agent run was stopped.' : 'Agent 推理已中止。');
    this.name = 'AgentRunAbortedError';
  }
}

/** Reusable provider/tool loop. A child gets a fresh instance with isolated
 * mutable services; the main extension coordinator uses AgentRunner below. */
export class AgentLoop {
  private readonly dsmlToolParser = new DsmlToolParser();
  private evidenceStore?: ToolEvidenceStore;
  /** Content-free last successful projection by logical usage lane. */
  private readonly previousCacheObservationByScope = new Map<string, ProviderCacheObservation>();

  public constructor(
    private readonly workspaceTools: WorkspaceToolAdapter = new WorkspaceToolService(),
    private readonly traceLogService?: InteractionTraceLogService,
    private readonly validationTools: ValidationToolAdapter = new ValidationToolService(),
    private readonly semanticTools: SemanticToolAdapter = new SemanticToolService(workspaceTools),
    private readonly gitTools: GitToolAdapter = new GitToolService(workspaceTools),
    private readonly toolAuthorization: ToolAuthorizationAdapter = new ToolAuthorizationService(),
    private readonly globalStorageUri?: vscode.Uri,
    private readonly subagentTools?: SubagentToolAdapter,
    private readonly approvalReviewer?: ApprovalReviewerAdapter
  ) {}

  public async run(request: AgentRequest, callbacks: AgentRunCallbacks = {}): Promise<AgentResponse> {
    if (request.checkpoint) {
      const requestCheckpoint = migrateLegacyCapacityCheckpoint(request.checkpoint);
      request = { ...request, checkpoint: requestCheckpoint };
      await this.reconcilePersistedEvidence(requestCheckpoint, request.sessionId ?? request.subagentContext?.parentSessionId ?? requestCheckpoint.taskId);
      if (requestCheckpoint.state?.pending?.executing) {
        throw new AgentInterruptedError('uncertain_tool_result',
          `Uncertain tool result: ${requestCheckpoint.state.pending.executing.name}. Verify before resuming. / 工具结果未知，请先核实后再恢复。`);
      }
      const blocker = recoveryBlocker(requestCheckpoint);
      if (blocker) throw new AgentInterruptedError(
        isCostLimitExhausted(requestCheckpoint) ? 'cost_limit' : 'waiting_for_user',
        blocker
      );
      const source = requestCheckpoint.source;
      if (request.model.id !== source.modelId || (request.sourceConfig && (
        request.sourceConfig.sourceId !== source.sourceId || request.sourceConfig.provider !== source.provider
        || endpointHash(request.sourceConfig.baseUrl) !== source.endpointHash))) throw new Error('Recovery source/model mismatch / 恢复来源或模型不匹配');
      request = { ...request, executionLimits: requestCheckpoint.request.executionLimits };
    }
    const limit = request.checkpoint?.maxExecutionMs ?? mergeDurations(getConfiguredAgentMaxExecutionMs(), request.executionLimits?.maxRunMs);
    const maxCost = request.taskCostBudget?.limit ?? (request.checkpoint
      ? request.checkpoint.maxCost ?? 0
      : mergeCostLimits(getConfiguredAgentMaxCost(), request.executionLimits?.maxCost));
    const cp = request.checkpoint ? checkpointCopy(request.checkpoint) : createRunCheckpoint(request, limit,
      request.executionLimits?.timeLimitSource ?? (request.executionLimits?.maxRunMs ? 'explicit invocation + agent.maxExecutionMs' : 'agent.maxExecutionMs (0 = unlimited)'),
      (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()), maxCost);
    const taskCostBudget = request.taskCostBudget ?? new ExecutionCostBudget(maxCost, cp.usedCostByCurrency);
    if (request.taskCostBudget) taskCostBudget.restoreAtLeast(cp.usedCostByCurrency ?? {});
    let activeRunBudget: LogicalRunBudget | undefined;
    cp.maxCost = taskCostBudget.limit;
    if (!request.subagentContext && cp.delegationBudget) this.subagentTools?.restoreTree?.(cp.taskId, cp.delegationBudget);
    cp.attempt++; cp.status = 'running'; cp.stopReason = undefined; cp.error = undefined;
    const ownClock = new ExecutionClock(limit, cp.usedMs);
    const clocks = request.taskClock ? [ownClock, request.taskClock] : [ownClock];
    let releases: Array<() => void> = [];
    const resumeClock = () => { if (!releases.length) releases = clocks.map((clock) => clock.enter()); };
    const suspendClock = () => { releases.forEach((release) => release()); releases = []; };
    const controller = new AbortController();
    const signals = [request.signal, ...clocks.map((clock) => clock.signal)].filter((signal): signal is AbortSignal => Boolean(signal));
    const abort = () => controller.abort(signals.find((signal) => signal.aborted)?.reason);
    signals.forEach((signal) => signal.addEventListener('abort', abort, { once: true }));
    if (signals.some((signal) => signal.aborted)) abort();
    const persist = async () => {
      if (!request.subagentContext) cp.delegationBudget = this.subagentTools?.snapshotTree?.(cp.taskId) ?? cp.delegationBudget;
      cp.usedMs = ownClock.usedMs;
      cp.usedCostByCurrency = taskCostBudget.snapshot();
      if (activeRunBudget) {
        activeRunBudget.syncUsedMs(cp.usedMs);
        cp.runBudget = activeRunBudget.state;
        cp.modelRequests = activeRunBudget.state.modelRequests;
      }
      cp.updatedAt = new Date().toISOString();
      try { await callbacks.onCheckpoint?.(checkpointCopy(cp)); }
      catch (error) { cp.status = 'blocked'; cp.stopReason = String(error).includes('resource limit') ? 'resource_limit' : 'storage_failure'; cp.error = String(error); controller.abort(error); throw error; }
    };
    resumeClock();
    let checkpointBusy = false;
    const checkpointTimer = setInterval(() => {
      if (checkpointBusy || controller.signal.aborted) return;
      checkpointBusy = true;
      void persist().catch(() => undefined).finally(() => { checkpointBusy = false; });
    }, 15_000);
    checkpointTimer.unref?.();
    try {
      await persist();
      const response = await this.runLoop({ ...request, checkpoint: cp, taskClock: request.taskClock ?? ownClock,
        taskCostBudget, signal: controller.signal }, {
        ...callbacks,
        beforeModelRequest: async () => {
          cp.modelRequests = activeRunBudget?.state.modelRequests ?? cp.modelRequests;
          cp.requestStartedAt = new Date().toISOString();
          cp.lastNetworkAt = undefined; cp.lastEventAt = undefined; cp.lastContentAt = undefined;
          await persist();
        },
        beforeRetry: async () => { cp.retries++; cp.modelStepRetries = (cp.modelStepRetries ?? 0) + 1; await persist(); },
        onTaskPlan: (plan) => { cp.taskPlan = plan; callbacks.onTaskPlan?.(plan); },
        onCheckpoint: async (next) => { cp.state = next.state; await persist(); },
        onActivity: (kind) => {
          const now = new Date().toISOString();
          if (kind === 'network') cp.lastNetworkAt = now;
          if (kind === 'event') cp.lastEventAt = now;
          if (kind === 'content') cp.lastContentAt = now;
          callbacks.onActivity?.(kind);
        },
        onStatus: (status) => {
          if (status.phase === 'awaiting_authorization' || status.phase === 'waiting_for_apply' || status.phase === 'waiting_for_subagent') suspendClock();
          else resumeClock();
          callbacks.onStatus?.(status);
        }
      }, (budget) => { activeRunBudget = budget; });
      cp.finalResponse = response;
      cp.status = response.runDetails.budgetStopReason ? 'blocked' : 'completed';
      cp.stopReason = response.runDetails.budgetStopReason ? 'budget_exhausted'
        : response.runDetails.status === 'waiting' || response.repairLoop.status === 'waiting_for_apply'
          ? 'waiting_for_user' : 'completed';
      await persist();
      return response;
    } catch (error) {
      cp.stopReason ??= clocks.some((clock) => clock.signal.aborted) ? 'time_budget'
        : request.signal?.aborted ? 'user_stop'
          : error instanceof AgentInterruptedError ? error.reason
            : error instanceof ToolEvidencePersistenceError ? error.reason
              : 'connection_interrupted';
      cp.status = ['storage_failure', 'resource_limit'].includes(cp.stopReason) ? 'blocked' : 'interrupted';
      cp.error = error instanceof Error ? error.message : String(error);
      if (cp.stopReason !== 'storage_failure' && cp.stopReason !== 'resource_limit') await persist();
      if (cp.stopReason === 'time_budget') throw new ExecutionBudgetError();
      throw error;
    } finally {
      if (!request.subagentContext) this.subagentTools?.releaseTree?.(cp.taskId);
      clearInterval(checkpointTimer);
      suspendClock(); ownClock.dispose();
      signals.forEach((signal) => signal.removeEventListener('abort', abort));
    }
  }

  private async runLoop(
    request: AgentRequest,
    callbacks: AgentRunCallbacks,
    onBudgetReady?: (budget: LogicalRunBudget) => void
  ): Promise<AgentResponse> {
    this.workspaceTools.setAuthorizedExternalReferenceUris(request.authorizedExternalReferenceUris);
    this.workspaceTools.setDelegatedFileAuthorization?.(request.approvalMode === 'delegate' && !request.persona);
    const checkpoint = request.checkpoint!;
    const restored = checkpoint.state;
    let saveStep: (() => Promise<void>) | undefined;
    const runDetailsBuilderRef: { current?: RunDetailsBuilder } = {};
    const trace = this.traceLogService?.createRunTrace((event, timestamp) => {
      runDetailsBuilderRef.current?.record(event, timestamp);
    }) ?? createNoopInteractionTrace((event, timestamp) => {
      runDetailsBuilderRef.current?.record(event, timestamp);
    });
    checkpoint.attemptIds.push(trace.runId);
    const traceLog = trace.enabled && trace.logUri
      ? {
          runId: trace.runId,
          uri: trace.logUri
        }
      : undefined;
    if (traceLog) {
      callbacks.onTraceLog?.(traceLog);
    }
    runDetailsBuilderRef.current = new RunDetailsBuilder({
      runId: trace.runId,
      sessionId: request.sessionId,
      assistantMessageId: request.assistantMessageId,
      backgroundRunId: request.backgroundRunId,
      modelId: request.model.id,
      sourceId: request.sourceConfig?.sourceId ?? request.model.sourceId,
      provider: request.sourceConfig?.provider ?? request.model.provider,
      protocol: request.sourceConfig
        ? getProviderRequestLane({
            provider: request.sourceConfig.provider,
            sourceId: request.sourceConfig.sourceId,
            baseUrl: request.sourceConfig.baseUrl,
            modelId: request.model.id
          }).protocol
        : undefined,
      thinkingEnabled: request.settings.thinkingEnabled,
      traceLogUri: traceLog?.uri
    });
    runDetailsBuilderRef.current.setRunContext(request.currentRunContext?.metadata);
    const taskPlan = new TaskPlanTracker({
      runId: trace.runId,
      initialPlan: checkpoint.taskPlan,
      sessionId: request.sessionId,
      prompt: request.prompt,
      language: request.language,
      onChange: callbacks.onTaskPlan,
      recordTrace: (event) => trace.record(event)
    });
    const repairLoop = new RepairLoopTracker(
      normalizeRepairIterationLimit(request.executionLimits?.maxRepairIterations),
      (event) => trace.record(event),
      restored?.repairLoop ?? request.repairLoop
    );
    const validationState = new RunValidationStateTracker(
      request.repairLoop?.status === 'running_validation' && request.repairLoop.iteration > 0
        ? 'post_apply'
        : 'workspace_baseline',
      restored?.validationState?.pendingDraftEditIds ?? request.repairLoop?.pendingDraftEditIds,
      restored?.validationState?.validations
    );
    const runAuthorizationPolicy = this.toolAuthorization.createRunPolicy(trace.runId);
    runAuthorizationPolicy.approvalMode = request.persona ? 'ask' : request.approvalMode;
    const toolResultLedger: ToolResultLedgerEntry[] = [];
    // 本 run 内 native 工具轮的原样字节快照（assistant tool_calls + tool 结果），
    // 由调用方持久化到 assistant 消息，跨轮重建时逐字节还原。
    const toolRounds: AgentToolRound[] = structuredClone(restored?.toolRounds ?? []);
    const supportsBilling = request.sourceConfig?.supportsBilling ?? request.model.supportsBilling === true;
    const usagePricing = supportsBilling
      ? getConfiguredModelUsagePricing(request.model.id)
      : undefined;
    const upstreamUsageTotals: UpstreamUsageTotals = {
      requestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cacheHitTokens: 0,
      cacheMissTokens: 0,
      reasoningTokens: 0,
      cost: 0,
      currency: usagePricing?.currency ?? '',
      records: []
    };
    let promptCacheDiagnostics: PromptCacheDiagnostics | undefined;
    let providerRunState: ProviderNativeRunState | undefined;
    trace.record({
      type: 'run_start',
      model: request.model,
      settings: request.settings,
      language: request.language,
      prompt: trace.includesPayload('request') ? request.prompt : summarizeText(request.prompt),
      contextFiles: request.contextFiles.map((file) => ({
        id: file.id,
        label: file.label,
        fsPath: file.fsPath,
        languageId: file.languageId,
        sizeBytes: file.sizeBytes,
        source: file.source,
        content: trace.includesPayload('request') ? file.content : summarizeText(file.content)
      })),
      skills: request.currentRunContext?.skills.map((skill) => ({
        id: skill.id,
        name: skill.name,
        source: skill.source,
        rootUri: skill.rootUri,
        skillUri: skill.skillUri,
        loadedResourceUris: skill.loadedResourceUris,
        activation: skill.activation,
        contentLength: skill.content.length,
        hasScripts: skill.hasScripts
      })),
      history: request.history.map((message) => ({
        id: message.id,
        role: message.role,
        createdAt: message.createdAt,
        modelId: message.modelId,
        contextMeta: message.contextMeta,
        content: trace.includesPayload('request') ? message.content : summarizeText(message.content),
        expandedContent: trace.includesPayload('request') ? message.expandedContent : summarizeText(message.expandedContent),
        reasoningContent: trace.includesPayload('request') ? message.reasoningContent : summarizeText(message.reasoningContent)
      })),
      contextCompression: request.contextCompression
        ? {
            version: request.contextCompression.version,
            summaryCount: request.contextCompression.summaries.length,
            protectedMessageCount: request.contextCompression.protectedMessageIds.length,
            lastCompressedAt: request.contextCompression.lastCompressedAt,
            lastFailureReason: request.contextCompression.lastFailureReason
          }
        : undefined,
      repairLoop: request.repairLoop,
      currentRunContext: request.currentRunContext
        ? {
            precedence: request.currentRunContext.metadata.precedence,
            beforeDeduplicationCount: request.currentRunContext.metadata.beforeDeduplicationCount,
            afterDeduplicationCount: request.currentRunContext.metadata.afterDeduplicationCount,
            totalCharacterCount: request.currentRunContext.metadata.totalCharacterCount,
            totalTokenEstimate: request.currentRunContext.metadata.totalTokenEstimate,
            truncated: request.currentRunContext.metadata.truncated,
            sources: request.currentRunContext.metadata.sources,
            discarded: request.currentRunContext.metadata.discarded,
            possibleConflicts: request.currentRunContext.metadata.possibleConflicts
          }
        : undefined,
      backgroundRunId: request.backgroundRunId,
      executionLimits: request.executionLimits
    });
    const finishRun = (
      response: Omit<AgentResponse, 'runId' | 'taskPlan' | 'changeSet' | 'repairLoop' | 'runDetails'>,
      details: Record<string, unknown> = {}
    ): AgentResponse => {
      const finishReason = typeof details.finishReason === 'string' ? details.finishReason : undefined;
      const isBlocked = Boolean(finishReason && /(?:budget|limit|exhausted)/u.test(finishReason));
      if (isBlocked && finishReason) {
        const timeLimit = finishReason.includes('run_time');
        taskPlan.addBlocker(request.language === 'en'
          ? timeLimit
            ? 'The configured task execution-time limit was reached.'
            : `The logical task safety budget was reached (${finishReason}).`
          : timeLimit
            ? '已达到用户配置的任务执行时长上限。'
            : `已达到逻辑任务安全预算（${finishReason}）。`);
      }
      const repairState = repairLoop.getState();
      const finalMessage = validationState.decorateFinalMessage(
        this.decorateRepairMessage(response.message, repairState, request.language),
        request.language
      );
      const completedPlan = taskPlan.complete(finalMessage, isBlocked);
      const changeSet = createChangeSet({
        runId: trace.runId,
        sessionId: request.sessionId,
        messageId: request.assistantMessageId,
        traceLogUri: traceLog?.uri,
        edits: response.draftEdits,
        operationSummary: completedPlan.goal
      });
      const responseWithUsage = {
        runId: trace.runId,
        ...response,
        draftRuns: response.draftRuns ?? [],
        message: finalMessage,
        taskPlan: completedPlan,
        repairLoop: repairState,
        changeSet,
        usage: response.usage ?? this.toTurnUsageStats(upstreamUsageTotals, request.model.id),
        promptCacheDiagnostics: response.promptCacheDiagnostics ?? promptCacheDiagnostics,
        toolRounds: toolRounds.length ? toolRounds : undefined,
        providerReplay: response.providerReplay ?? this.createProviderReplayState(providerRunState)
      };
      trace.record({
        type: 'run_finish',
        ...details,
        upstreamUsage: this.summarizeUpstreamUsageTotals(upstreamUsageTotals),
        toolResultLedger,
        validationState: validationState.getState(),
        response: trace.includesPayload('request')
          ? responseWithUsage
          : {
              message: summarizeText(responseWithUsage.message),
              reasoningContent: summarizeText(responseWithUsage.reasoningContent),
              usage: responseWithUsage.usage,
              promptCacheDiagnostics: responseWithUsage.promptCacheDiagnostics,
              draftEdits: responseWithUsage.draftEdits.map((edit) => ({
                id: edit.id,
                uri: edit.uri,
                label: edit.label,
                action: edit.action,
                reason: edit.reason,
                kind: edit.kind ?? 'legacy_full_text_v0',
                payloadHash: edit.kind === 'text_patch_v1'
                  ? edit.patch.canonicalHash
                  : edit.kind === 'full_text_v1'
                    ? edit.result.sha256
                    : edit.kind === 'delete_v1' || edit.kind === 'move_v1'
                      ? edit.base.sha256
                      : hashText(edit.newText)
              })),
              draftRuns: responseWithUsage.draftRuns.map((draftRun) => ({
                id: draftRun.id,
                executable: draftRun.spec.executable,
                args: draftRun.spec.args,
                cwd: draftRun.spec.cwdLabel,
                verdict: draftRun.effectAssessment.verdict
              }))
            }
      });
      if (changeSet) {
        trace.record({
          type: 'change_set_created',
          changeSetId: changeSet.id,
          sessionId: changeSet.sessionId,
          messageId: changeSet.messageId,
          fileCount: changeSet.fileCount,
          operationSummary: changeSet.operationSummary,
          files: changeSet.files.map((file) => ({
            id: file.id,
            uri: file.uri,
            label: file.label,
            action: file.action,
            reason: file.reason
          }))
        });
      }
      const runDetails = runDetailsBuilderRef.current?.finish({
        taskPlan: completedPlan,
        repairLoop: repairState,
        changeSet,
        finishReason,
        stopped: details.stopped === true
      }) ?? createFallbackRunDetails(trace.runId, request, completedPlan, traceLog?.uri);
      callbacks.onRunDetails?.(runDetails);
      return traceLog
        ? { ...responseWithUsage, traceLog, runDetails }
        : { ...responseWithUsage, runDetails };
    };

    trace.record({
      type: 'run_authorization_policy',
      policy: runAuthorizationPolicy
    });

    const emitStatus = this.createStatusEmitter(callbacks);
    const draftEdits: DraftEdit[] = structuredClone(restored?.draftEdits ?? []);
    const draftRuns: DraftRunProposal[] = structuredClone(restored?.draftRuns ?? []);
    const reasoningParts: string[] = [...(restored?.reasoningParts ?? [])];

    try {
    this.throwIfAborted(request.signal, request.language);
    const runCallbacks: AgentRunCallbacks = {
      ...callbacks,
      onStatus: emitStatus
    };
    const draftEdit = request.subagentContext && request.subagentContext.lane !== 'proposal'
      ? undefined
      : await this.tryCreateDraftEdit(request.prompt, request.language);
    this.throwIfAborted(request.signal, request.language);
    if (draftEdit) {
      await this.captureDraftBaseline(draftEdit);
      validationState.recordDraftEdit(draftEdit.id);
      taskPlan.beginExecution();
      taskPlan.startTool(CREATE_DRAFT_EDIT_TOOL_NAME);
      emitStatus({
        base: 'executing',
        phase: 'creating_draft_edit',
        toolName: CREATE_DRAFT_EDIT_TOOL_NAME
      });
      taskPlan.finishTool(CREATE_DRAFT_EDIT_TOOL_NAME, JSON.stringify({ ok: true }));
      emitStatus({
        base: 'thinking',
        phase: 'finalizing'
      });
      return finishRun({
        message: request.language === 'en'
          ? [
              `Prepared a pending change for ${draftEdit.label}.`,
              'Click Apply on the change card; VS Code will ask for write permission before anything is written.'
            ].join('\n\n')
          : [
              `已为 ${draftEdit.label} 准备一个待确认修改。`,
              '点击修改卡片上的应用后，扩展会再次弹窗请求写入许可。'
            ].join('\n\n'),
        draftEdits: [draftEdit]
      }, { shortcut: 'draft' });
    }

    const runtimeConfig = await this.getRuntimeConfig(request);
    if (!restored) checkpoint.request.executionLimits = {
      ...request.executionLimits, maxToolIterations: runtimeConfig.maxToolIterations,
      maxToolCalls: runtimeConfig.maxToolCalls, maxRepairIterations: repairLoop.getState().maxIterations,
      maxValidationRuns: runtimeConfig.maxValidationRuns, maxModelRequests: runtimeConfig.maxModelRequests,
      maxContinuations: runtimeConfig.maxContinuations,
      maxContextEpochRollovers: runtimeConfig.maxContextEpochRollovers,
      maxUpstreamTokens: runtimeConfig.maxUpstreamTokens,
      maxTreeUpstreamTokens: runtimeConfig.maxTreeUpstreamTokens
    };
    const parentRunBudget = request.taskRunBudget;
    const sharedTreeBudget = parentRunBudget?.tree ?? new SharedUpstreamTokenBudget(
      runtimeConfig.maxTreeUpstreamTokens,
      checkpoint.runBudget?.treeUpstreamTokens ?? 0
    );
    const logicalBudget = new LogicalRunBudget(checkpoint.runBudget, {
      maxModelRequests: runtimeConfig.maxModelRequests,
      maxToolRounds: runtimeConfig.maxToolIterations,
      maxToolCalls: runtimeConfig.maxToolCalls,
      maxContinuations: runtimeConfig.maxContinuations,
      maxContextEpochRollovers: runtimeConfig.maxContextEpochRollovers,
      maxUpstreamTokens: runtimeConfig.maxUpstreamTokens,
      maxTreeUpstreamTokens: runtimeConfig.maxTreeUpstreamTokens,
      maxContinuationOutputTokens: runtimeConfig.continuationMaxOutputTokens,
      maxContinuationOutputChars: runtimeConfig.continuationMaxOutputTokens * 4
    }, sharedTreeBudget, runtimeConfig.maxRunMs, Date.now(), parentRunBudget?.deadlineAt);
    checkpoint.runBudget = logicalBudget.state;
    checkpoint.modelRequests = logicalBudget.state.modelRequests;
    request = { ...request, taskRunBudget: logicalBudget };
    onBudgetReady?.(logicalBudget);
    taskPlan.beginExecution();
    const buildCurrentProviderProjection = () => buildProviderRequestProjection({
      model: request.model,
      agentSettings: request.settings,
      contextFiles: request.contextFiles,
      currentRunContext: request.currentRunContext,
      contextInstructions: request.contextInstructions,
      history: request.history,
      contextCompression: request.contextCompression,
      language: request.language,
      prompt: request.prompt,
      slimToolNames: request.slimToolNames,
      requestProtocolVersion: request.requestProtocolVersion,
      includeTools: runtimeConfig.maxToolIterations > 0,
      maxProjectionTokens: runtimeConfig.contextWindowTokens
        * runtimeConfig.contextCompression.forceRatio,
      provider: runtimeConfig.provider,
      sourceId: runtimeConfig.sourceId,
      baseUrl: runtimeConfig.baseUrl,
      systemPrompt: request.persona?.systemPrompt
    });
    let providerProjection = buildCurrentProviderProjection();
    const projection = providerProjection.historyProjection;
    runDetailsBuilderRef.current?.setHistorySummaries(
      (request.contextCompression?.summaries ?? []).filter((summary) => (
        projection.usedSummaryIds.includes(summary.id)
      ))
    );
    let messages = structuredClone(restored?.messages ?? providerProjection.messages);
    const createInitialProviderRunState = (): ProviderNativeRunState | undefined => providerProjection.responses
      ? {
          protocol: 'openai-responses',
          input: [...providerProjection.responses.input],
          tools: providerProjection.responses.tools,
          replayItems: [],
          lane: providerProjection.responses.lane
        }
      : providerProjection.anthropic
        ? {
            protocol: 'anthropic-messages',
            system: providerProjection.anthropic.system,
            messages: [...providerProjection.anthropic.messages],
            tools: providerProjection.anthropic.tools,
            replayMessages: [],
            lane: providerProjection.anthropic.lane,
            ...this.createAnthropicThinkingConfig(request, runtimeConfig.maxTokens),
            cacheControl: isOfficialAnthropicSource({
              provider: runtimeConfig.provider,
              baseUrl: runtimeConfig.baseUrl
            }) ? { type: 'ephemeral' } : undefined
          }
        : undefined;
    providerRunState = createInitialProviderRunState();
    if (restored?.provider) providerRunState = structuredClone(restored.provider);
    trace.record({
      type: 'context_projection',
      metadata: projection.metadata,
      protectedMessageIds: projection.protectedMessageIds,
      recentMessageIds: projection.recentMessageIds,
      compressibleMessageCount: projection.compressibleMessageIds.length,
      usedSummaryIds: projection.usedSummaryIds,
      lastCompressionFailureReason: request.contextCompression?.lastFailureReason
    });
    trace.record({
      type: 'active_skills',
      skills: (request.currentRunContext?.skills ?? []).map((skill) => ({
        id: skill.id,
        name: skill.name,
        source: skill.source,
        skillUri: skill.skillUri,
        activation: skill.activation,
        contentLength: skill.content.length,
        hasScripts: skill.hasScripts
      }))
    });
    trace.record({
      type: 'current_run_context',
      metadata: request.currentRunContext?.metadata ?? {
        beforeDeduplicationCount: 0,
        afterDeduplicationCount: 0,
        sources: [],
        discarded: []
      }
    });
    trace.record({
      type: 'agent_messages_initialized',
      messages: formatMessagesForTrace(messages, trace.includesPayload('request'))
    });
    let tools = providerProjection.tools;
    // Runtime authority comes from the exact schema sent to the Provider, not
    // from the runner's wider routing table. This guard is shared by native,
    // Responses, Anthropic, DSML, and checkpoint-replayed tool calls because
    // every lane converges on performToolCall below.
    let exposedToolNames = new Set(tools.map((tool) => tool.function.name));
    let schemaHash = hashText(JSON.stringify(tools));
    if (checkpoint.toolSchemaHash && checkpoint.toolSchemaHash !== schemaHash) throw new Error('Tool schema changed; recovery refused / 工具协议变化，不能继续旧任务');
    checkpoint.toolSchemaHash = schemaHash;
    promptCacheDiagnostics = this.createPromptCacheDiagnostics({
      request,
      messages,
      tools,
      historyCompacted: projection.metadata.usedSummary,
      runtimeConfig,
      responses: providerProjection.responses,
      anthropic: providerProjection.anthropic
    });
    callbacks.onPromptCacheDiagnostics?.(promptCacheDiagnostics);
    trace.record({
      type: 'prompt_cache_diagnostics',
      ...promptCacheDiagnostics,
      exposedToolNames: tools.map((tool) => tool.function.name),
      projectionMetadata: projection.metadata
    });
    draftEdits.forEach((edit) => validationState.recordDraftEdit(edit.id));
    const runDeadlineAt = logicalBudget.deadlineAt;
    const calibrationStore = new ContextWindowCalibrationStore(this.globalStorageUri);
    const calibrationKey = {
      sourceId: runtimeConfig.sourceId,
      provider: runtimeConfig.provider,
      modelId: request.model.id,
      canonicalModelId: getCanonicalModelIdentity(request.model.id),
      endpointHash: endpointHash(runtimeConfig.baseUrl)
    };
    const calibrationDeclaration = {
      identity: getCanonicalModelIdentity(request.model.id),
      version: `${DEEPSEEK_MODEL_IDENTITY_VERSION}:${runtimeConfig.contextWindowTokens}`,
      declaredWindowTokens: runtimeConfig.contextWindowTokens
    };
    const restoredCalibration = restored?.epoch?.calibration
      ?? await calibrationStore.load(calibrationKey, calibrationDeclaration);
    const admission = new ToolResultAdmissionController(
      runtimeConfig.contextWindowTokens,
      restoredCalibration,
      calibrationDeclaration
    );
    if (admission.migration) {
      await calibrationStore.save(calibrationKey, admission.state);
      trace.record({ type: 'stale_capacity_calibration', ...admission.migration });
      runDetailsBuilderRef.current?.recordCapacityAdjustment(admission.migration);
    }
    let lastStaleCalibrationFingerprint = '';
    const decideWithCalibrationRepair = async (
      input: Parameters<ToolResultAdmissionController['decide']>[0]
    ) => {
      let decision = admission.decide(input);
      if (!decision.shouldRollover) return decision;
      const adjustment = admission.reconcileSuccessfulFloor();
      if (!adjustment) return decision;
      const fingerprint = `${input.estimatedInputTokens}:${input.phase}:${input.remainingBatchResults}:${adjustment.beforeWindowTokens}:${adjustment.afterWindowTokens}`;
      if (fingerprint !== lastStaleCalibrationFingerprint) {
        lastStaleCalibrationFingerprint = fingerprint;
        trace.record({ type: 'stale_capacity_calibration', ...adjustment });
        runDetailsBuilderRef.current?.recordCapacityAdjustment(adjustment);
      }
      await calibrationStore.save(calibrationKey, admission.state);
      decision = admission.decide(input);
      return decision;
    };
    const epoch = restored?.epoch
      ? { ...restored.epoch, failures: [...(restored.epoch.failures ?? [])] }
      : createContextEpochState(admission.state);
    const outputReserveTokens = admission.decide({
      estimatedInputTokens: 0,
      configuredMaxOutputTokens: runtimeConfig.maxTokens,
      phase: 'tool',
      remainingBatchResults: 1
    }).outputReserveTokens;
    const evidenceStore = this.getEvidenceStore();
    const evidenceSessionId = request.sessionId ?? request.subagentContext?.parentSessionId ?? checkpoint.taskId;
    const runtimeUsageBreakdown = {
      ...createContextUsageEstimate({
        model: request.model,
        agentSettings: request.settings,
        contextFiles: request.contextFiles,
        currentRunContext: request.currentRunContext,
        contextInstructions: request.contextInstructions,
        messages: request.history,
        contextCompression: request.contextCompression,
        language: request.language,
        prompt: request.prompt,
        includeTools: runtimeConfig.maxToolIterations > 0,
        outputReserveTokens,
        safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS,
        slimToolNames: request.slimToolNames,
        requestProtocolVersion: request.requestProtocolVersion,
        provider: runtimeConfig.provider,
        sourceId: runtimeConfig.sourceId,
        baseUrl: runtimeConfig.baseUrl
      }).breakdown
    };
    // Provider calibration changes the prompt total, not the work already done
    // in this run. Preserve these local-only categories in every notification.
    runCallbacks.onUsageEstimate = (estimate) => callbacks.onUsageEstimate?.({
      ...estimate,
      breakdown: {
        ...estimate.breakdown,
        toolCallTokensEstimate: runtimeUsageBreakdown.toolCallTokensEstimate,
        toolResultTokensEstimate: runtimeUsageBreakdown.toolResultTokensEstimate,
        reasoningTokensEstimate: runtimeUsageBreakdown.reasoningTokensEstimate
      }
    });
    const emitUsageEstimate = (toolsForNextRequest: DeepSeekFunctionTool[]) => {
      const breakdown = {
        ...runtimeUsageBreakdown,
        toolSchemaTokensEstimate: undefined
      };
      callbacks.onUsageEstimate?.(providerRunState?.protocol === 'openai-responses'
        ? createContextUsageEstimateFromResponses({
            model: request.model,
            input: providerRunState.input,
            tools: providerRunState.tools,
            outputReserveTokens,
            safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS,
            breakdown
          })
        : providerRunState?.protocol === 'anthropic-messages'
          ? createContextUsageEstimateFromAnthropic({
              model: request.model,
              system: providerRunState.system,
              messages: providerRunState.messages,
              tools: providerRunState.tools,
              outputReserveTokens,
              safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS,
              breakdown
            })
          : createContextUsageEstimateFromMessages({
            model: request.model,
            messages,
            tools: toolsForNextRequest,
            outputReserveTokens,
            safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS,
            breakdown
          }));
    };
    let toolCallCount = restored?.toolCallCount ?? 0;
    let validationRunCount = restored?.validationRunCount ?? 0;
    let toolResultTokens = restored?.toolResultTokens ?? 0;
    let approvalReviewStopReason: string | undefined;
    let approvalReviewBoundaryReached = false;
    const approvalToolResults: NonNullable<AgentResponse['approvalToolResults']> = [];
    emitUsageEstimate(tools);

    let nextTurn = restored?.turn ?? 0;
    let pending = restored?.pending;
    // Committed projection stays at the start of the current model step. During
    // a tool round only its result journal changes, so replay cannot duplicate
    // already appended tool messages after an interruption.
    let completedReplay = restored?.completedReplay;
    let committedMessages = structuredClone(messages);
    let committedProvider = structuredClone(providerRunState);
    saveStep = async () => {
      for (const edit of draftEdits) await this.captureDraftBaseline(edit);
      checkpoint.state = {
        messages: committedMessages, provider: committedProvider, completedReplay, toolRounds, draftEdits, draftRuns,
        reasoningParts, turn: nextTurn, toolCallCount, validationRunCount, toolResultTokens,
        validationState: validationState.getState(), repairLoop: repairLoop.getState(), epoch: { ...epoch, calibration: { ...admission.state } }, pending
      };
      await callbacks.onCheckpoint?.(checkpoint);
    };
    await saveStep();
    const rolloverEpoch = async (reason: ContextEpochRolloverReason): Promise<void> => {
      let estimated: number;
      let summaryKind: 'model' | 'host_fallback';
      let seed: string;
      let archiveName: string;
      const persistedRollover = epoch.status === 'persisted' && epoch.pendingRollover?.seed
        && epoch.pendingRollover.archiveName && epoch.pendingRollover.summaryKind
        && typeof epoch.pendingRollover.estimatedPromptTokens === 'number'
        ? epoch.pendingRollover
        : undefined;
      if (persistedRollover) {
        reason = persistedRollover.reason;
        estimated = persistedRollover.estimatedPromptTokens!;
        summaryKind = persistedRollover.summaryKind!;
        seed = persistedRollover.seed!;
        archiveName = persistedRollover.archiveName!;
      } else {
        if (!logicalBudget.tryRecordRollover()) {
          throw new LogicalBudgetExceededError('context_epoch_rollover_budget_exhausted');
        }
        epoch.status = 'summarizing';
        epoch.pendingRollover = { reason };
        await saveStep!();
        estimated = this.estimateCurrentProviderInputTokens(request, messages, tools, providerRunState);
        let semanticSummary: string | undefined;
        const rolloverFailures: string[] = [];
        try {
          semanticSummary = await this.createEpochSemanticSummary({
            request, runtimeConfig, messages, tools, providerRunState, callbacks: runCallbacks,
            trace, usageTotals: upstreamUsageTotals, runDeadlineAt
          });
        } catch (error) {
          // A summary timeout is recoverable through the deterministic host
          // checkpoint. An explicit task Stop is not: propagate it immediately
          // instead of persisting a new epoch after cancellation.
          if (request.signal?.aborted) throw error;
          const summaryError = formatUnknownError(error);
          rolloverFailures.push(summaryError instanceof Error ? summaryError.message : stableStringify(summaryError));
          trace.record({ type: 'context_epoch_summary_failed', epochIndex: epoch.index, error: summaryError });
        }
        summaryKind = semanticSummary?.trim() ? 'model' : 'host_fallback';
        semanticSummary = semanticSummary?.trim() || createHostFallbackSummary({
          plan: taskPlan.getPlan(), evidenceRefs: epoch.evidenceRefs, failures: rolloverFailures
        });
        const epochCheckpointInput = {
          protocolVersion: request.requestProtocolVersion ?? 1,
          originalTask: request.prompt,
          taskPlan: taskPlan.getPlan(),
          draftEdits,
          draftRuns,
          repairLoop: repairLoop.getState(),
          validationState: validationState.getState(),
          evidenceRefs: epoch.evidenceRefs,
          idempotency: epoch.idempotency,
          noProgress: epoch.noProgress,
          failures: [...epoch.failures.map((failure) => stableStringify(failure)), ...rolloverFailures],
          nextStep: 'Continue the remaining plan from the strongest unresolved item.',
          runtimeState: {
            taskId: checkpoint.taskId,
            approvalRootTaskId: request.approvalRootTaskId ?? checkpoint.taskId,
            modelRequests: checkpoint.modelRequests,
            totalToolCalls: toolCallCount,
            totalToolResultTokensEstimate: toolResultTokens,
            totalCostByCurrency: request.taskCostBudget?.snapshot(),
            maxCost: request.taskCostBudget?.limit
          },
          approvalResults: approvalToolResults.map(({ toolCallId, toolName, status }) => ({ toolCallId, toolName, status }))
        };
        const hostCheckpoint = createEpochHostCheckpoint(epochCheckpointInput);
        let hostCheckpointEvidence = await evidenceStore.ensureIntent({
          sessionId: evidenceSessionId,
          taskId: checkpoint.taskId,
          epochIndex: epoch.index,
          toolCallId: `__keepseek_context_epoch_host_state_${epoch.index}`,
          toolName: 'keepseek_context_epoch_host_state',
          argumentsHash: hashText(hostCheckpoint),
          effectKind: 'read'
        });
        hostCheckpointEvidence = await evidenceStore.complete(hostCheckpointEvidence, hostCheckpoint, { contentType: 'json' });
        this.upsertEpochEvidenceRef(epoch, hostCheckpointEvidence);
        seed = createEpochSeed({
          ...epochCheckpointInput,
          semanticSummary,
          checkpointEvidence: {
            evidenceRef: hostCheckpointEvidence.evidenceRef,
            contentHash: hostCheckpointEvidence.contentHash!,
            totalChars: hostCheckpointEvidence.totalChars!,
            totalBytes: hostCheckpointEvidence.totalBytes!
          }
        });
        archiveName = await evidenceStore.saveEpochSnapshot(evidenceSessionId, checkpoint.taskId, epoch.index, {
          version: 1, index: epoch.index, messages, provider: providerRunState, seed,
          messageHash: hashText(stableStringify(messages)), providerHash: hashText(stableStringify(providerRunState))
        });
        epoch.status = 'persisted';
        epoch.pendingRollover = {
          reason,
          estimatedPromptTokens: estimated,
          actualPromptTokens: admission.state.lastActualInputTokens,
          summaryKind,
          archiveName,
          seed
        };
        await saveStep!();
      }
      if (reason === 'protocol_migration' && (request.requestProtocolVersion ?? 1) < 8) {
        request = { ...request, requestProtocolVersion: 8 };
        checkpoint.request.requestProtocolVersion = 8;
        providerProjection = buildCurrentProviderProjection();
        tools = providerProjection.tools;
        exposedToolNames = new Set(tools.map((tool) => tool.function.name));
        schemaHash = hashText(JSON.stringify(tools));
        checkpoint.toolSchemaHash = schemaHash;
        await callbacks.onProtocolMigration?.({
          version: 8,
          toolSchemaVersion: 8,
          toolNames: tools.map((tool) => tool.function.name)
        });
      }
      const currentIndex = epoch.index;
      const reusablePrefixTokensBeforeRollover = Math.min(
        estimated,
        admission.state.lastActualInputTokens ?? estimated
      );
      const rolloverNecessity = reason === 'provider_context_too_long' || reason === 'minimum_envelope_unfit'
        ? 'necessary' as const : 'controlled_policy' as const;
      epoch.rollovers.push({
        index: currentIndex,
        reason,
        estimatedPromptTokens: estimated,
        actualPromptTokens: admission.state.lastActualInputTokens,
        declaredWindowTokens: runtimeConfig.contextWindowTokens,
        learnedEffectiveWindowTokens: admission.state.learnedEffectiveWindowTokens,
        reusablePrefixTokensEstimate: reusablePrefixTokensBeforeRollover,
        estimatedCacheResetTokens: reusablePrefixTokensBeforeRollover,
        necessity: rolloverNecessity,
        summaryKind,
        archiveName,
        seedHash: hashText(seed)
      });
      epoch.index += 1;
      epoch.totalRollovers += 1;
      epoch.turnInEpoch = 0;
      epoch.toolCallsInEpoch = 0;
      epoch.status = 'active';
      epoch.pendingRollover = undefined;
      epoch.seed = seed;
      messages = structuredClone(providerProjection.messages);
      providerRunState = createInitialProviderRunState();
      const retainedBaseTokensEstimate = this.estimateCurrentProviderInputTokens(request, messages, tools, providerRunState);
      const seedMessage: DeepSeekMessage = { role: 'user', content: seed };
      messages.push(seedMessage);
      this.appendProviderUserText(providerRunState, seed);
      const afterEstimatedPromptTokens = this.estimateCurrentProviderInputTokens(
        request, messages, tools, providerRunState
      );
      const estimatedCacheResetTokens = reusablePrefixTokensBeforeRollover;
      const rolloverRecord = epoch.rollovers.at(-1);
      if (rolloverRecord) rolloverRecord.afterEstimatedPromptTokens = afterEstimatedPromptTokens;
      completedReplay = undefined;
      committedMessages = structuredClone(messages);
      committedProvider = structuredClone(providerRunState);
      pending = undefined;
      trace.record({
        type: 'context_epoch_rollover', epochIndex: epoch.index, reason,
        estimatedPromptTokens: estimated, actualPromptTokens: admission.state.lastActualInputTokens,
        afterEstimatedPromptTokens,
        declaredWindowTokens: runtimeConfig.contextWindowTokens,
        learnedEffectiveWindowTokens: admission.state.learnedEffectiveWindowTokens,
        reusablePrefixTokensEstimate: reusablePrefixTokensBeforeRollover,
        retainedBaseTokensEstimate,
        estimatedCacheResetTokens, necessity: rolloverNecessity,
        summaryKind, seedHash: hashText(seed), providerProtocol: runDetailsBuilderRef.current?.build().protocol
      });
      runDetailsBuilderRef.current?.recordEpochRollover?.({
        index: epoch.index, reason, estimatedPromptTokens: estimated,
        afterEstimatedPromptTokens,
        actualPromptTokens: admission.state.lastActualInputTokens,
        declaredWindowTokens: runtimeConfig.contextWindowTokens,
        learnedEffectiveWindowTokens: admission.state.learnedEffectiveWindowTokens,
        reusablePrefixTokensEstimate: reusablePrefixTokensBeforeRollover,
        estimatedCacheResetTokens,
        necessity: rolloverNecessity,
        summaryKind
      });
      await saveStep!();
    };

    if (epoch.status !== 'active') {
      await rolloverEpoch(epoch.pendingRollover?.reason ?? 'soft_context_pressure');
    }

    for (let turn = nextTurn; ; turn += 1) {
      this.throwIfAborted(request.signal, request.language);
      const runTimeStopReason = this.getRunTimeStopReason(runDeadlineAt);
      if (runTimeStopReason) {
        emitStatus({
          base: 'thinking',
          phase: 'finalizing'
        });
        return finishRun({
          message: this.getFinalMessage(null, draftEdits, runTimeStopReason, request.language, runtimeConfig),
          reasoningContent: this.formatReasoning(reasoningParts),
          draftEdits,
          draftRuns
        }, { finishReason: runTimeStopReason });
      }

      // The schema is frozen for the whole session/run. When tool calls are no
      // longer allowed, keep the identical tools array and switch tool_choice to
      // none instead of removing the cached schema prefix.
      const toolBudgetExhausted = !logicalBudget.canUseTools();
      const isBudgetFinalization = toolBudgetExhausted;
      if (isBudgetFinalization && !pending) {
        if (!logicalBudget.beginFinalization()) {
          throw new LogicalBudgetExceededError('tool_budget_exhausted');
        }
        await saveStep();
      }
      const allowToolCalls = !toolBudgetExhausted;
      const toolsForTurn = tools;
      const allowTerminalDraftEdit = false;
      emitUsageEstimate(toolsForTurn);
      let response: DeepSeekStreamResult;
      const estimatedInputBeforeRequest = this.estimateCurrentProviderInputTokens(
        request,
        messages,
        toolsForTurn,
        providerRunState
      );
      const requestAdmission = admission.decide({
        estimatedInputTokens: estimatedInputBeforeRequest,
        configuredMaxOutputTokens: allowToolCalls
          ? runtimeConfig.toolMaxOutputTokens
          : runtimeConfig.finalMaxOutputTokens,
        phase: allowToolCalls ? 'tool' : 'final',
        remainingBatchResults: 1
      });
      try {
        const deliveryRecords = await this.getPendingEvidenceDeliveryRecords(evidenceStore, evidenceSessionId, checkpoint.taskId, epoch.evidenceRefs);
        for (const record of deliveryRecords) await evidenceStore.markSending(record);
        response = pending?.response ?? await this.createModelResponse(
          request,
          { ...runtimeConfig, maxTokens: Math.min(
            requestAdmission.outputReserveTokens,
            allowToolCalls ? runtimeConfig.toolMaxOutputTokens : runtimeConfig.finalMaxOutputTokens
          ) },
          messages,
          toolsForTurn,
          runCallbacks,
          runDeadlineAt,
          {
          trace,
          usageTotals: upstreamUsageTotals,
          usageSource: request.subagentContext ? 'subagent'
            : request.backgroundRunId ? 'background' : 'executor',
          toolChoice: allowToolCalls ? 'auto' : 'none',
          providerRunState,
          contextEpochIndex: epoch.index,
          historyCompacted: projection.metadata.usedSummary
          }
        );
        for (const record of deliveryRecords) await evidenceStore.markDelivered(record);
        const actualInput = response.usage?.prompt_tokens;
        const successfulAdjustment = !pending
          ? admission.recordSuccessfulRequest(actualInput)
          : undefined;
        if (successfulAdjustment) {
          trace.record({ type: 'stale_capacity_calibration', ...successfulAdjustment });
          runDetailsBuilderRef.current?.recordCapacityAdjustment(successfulAdjustment);
        }
        if (typeof actualInput === 'number') {
          admission.observe(estimatedInputBeforeRequest, actualInput);
        }
        if (!pending) await calibrationStore.save(calibrationKey, admission.state);
      } catch (error) {
        if (!isContextTooLongError(error)) throw error;
        const attempted = this.estimateCurrentProviderInputTokens(request, messages, toolsForTurn, providerRunState);
        admission.recordContextTooLong(attempted);
        await calibrationStore.save(calibrationKey, admission.state);
        trace.record({ type: 'context_window_adapted', attemptedPromptTokens: attempted,
          learnedEffectiveWindowTokens: admission.state.learnedEffectiveWindowTokens,
          contextTooLongCount: admission.state.contextTooLongCount });
        if (admission.state.contextTooLongCount >= 4 && epoch.turnInEpoch === 0) {
          throw new AgentInterruptedError('provider_error', request.language === 'en'
            ? 'The provider context capacity is too small for the frozen system, tool schema, original request, and minimum recovery checkpoint.'
            : 'Provider 上下文容量不足以容纳冻结 system、工具 schema、原始请求和最小恢复检查点。');
        }
        await rolloverEpoch('provider_context_too_long');
        turn -= 1;
        continue;
      }
      const normalizedAssistant = this.normalizeAssistantToolCalls(
        response.message,
        allowToolCalls || allowTerminalDraftEdit,
        runtimeConfig.provider !== 'anthropic-compatible'
      );
      const assistant = normalizedAssistant.assistant;
      if (!assistant) {
        throw new Error(request.language === 'en'
          ? 'The provider API did not return a usable assistant message.'
          : 'Provider API 没有返回可用的 assistant message。');
      }

      if (normalizedAssistant.displayReasoningContent && !pending) {
        reasoningParts.push(normalizedAssistant.displayReasoningContent);
      }

      const toolCalls = assistant.tool_calls?.filter((toolCall) => toolCall.type === 'function') ?? [];
      const rawToolCalls = response.message.tool_calls?.filter((toolCall) => toolCall.type === 'function') ?? [];
      if (isBudgetFinalization && rawToolCalls.length) {
        throw new LogicalBudgetExceededError('tool_budget_exhausted');
      }
      if (normalizedAssistant.displayReasoningContent) {
        runtimeUsageBreakdown.reasoningTokensEstimate += estimateChatMessageTokens('assistant', normalizedAssistant.displayReasoningContent);
        emitUsageEstimate(toolsForTurn);
      }
      if (toolCalls.length) {
        trace.record({
          type: 'assistant_tool_calls_normalized',
          source: normalizedAssistant.source,
          toolCalls: trace.includesPayload('request') ? toolCalls : toolCalls.map(summarizeDeepSeekToolCall)
        });
      }
      if (!toolCalls.length) {
        pending ??= { response: { message: assistant, finishReason: response.finishReason, usage: response.usage }, results: {} };
        committedProvider = structuredClone(providerRunState);
        await saveStep();
        if (isBudgetFinalization) {
          const finalizationContent = response.finishReason === 'length' || response.finishReason === 'pause_turn'
            ? this.appendBudgetTruncationNotice(assistant.content ?? '', request.language)
            : assistant.content;
          emitStatus({ base: 'thinking', phase: 'finalizing' });
          return finishRun({
            message: this.getFinalMessage(finalizationContent, draftEdits, 'tool_budget_exhausted', request.language, runtimeConfig),
            reasoningContent: this.formatReasoning(reasoningParts),
            draftEdits,
            draftRuns
          }, { finishReason: 'tool_budget_exhausted', stopped: true });
        }
        let continuedResponse: { content: string; finishReason?: string | null } | undefined;
        try {
          continuedResponse = await this.tryContinueLengthLimitedResponse({
            request,
            runtimeConfig,
            messages,
            assistant,
            response,
            draftEdits,
            callbacks: runCallbacks,
            runDeadlineAt,
            outputReserveTokens,
            reasoningParts,
            runtimeUsageBreakdown,
            trace,
            usageTotals: upstreamUsageTotals,
            tools,
            providerRunState
          });
        } catch (error) {
          if (!isContextTooLongError(error)) throw error;
          const attempted = this.estimateCurrentProviderInputTokens(request, messages, tools, providerRunState);
          admission.recordContextTooLong(attempted);
          await calibrationStore.save(calibrationKey, admission.state);
          trace.record({
            type: 'context_window_adapted',
            attemptedPromptTokens: attempted,
            learnedEffectiveWindowTokens: admission.state.learnedEffectiveWindowTokens,
            contextTooLongCount: admission.state.contextTooLongCount,
            during: 'length_continuation'
          });
          await rolloverEpoch('length_continuation');
          turn -= 1;
          continue;
        }
        if (continuedResponse) {
          emitUsageEstimate(toolsForTurn);
          emitStatus({
            base: 'thinking',
            phase: 'finalizing'
          });
          return finishRun({
            message: this.getFinalMessage(continuedResponse.content, draftEdits, continuedResponse.finishReason, request.language, runtimeConfig),
            reasoningContent: this.formatReasoning(reasoningParts),
            draftEdits,
            draftRuns
          }, { finishReason: continuedResponse.finishReason, continued: true });
        }

        emitStatus({
          base: 'thinking',
          phase: 'finalizing'
        });
        const finalFinishReason = response.finishReason;
        return finishRun({
          message: this.getFinalMessage(assistant.content, draftEdits, finalFinishReason, request.language, runtimeConfig),
          reasoningContent: this.formatReasoning(reasoningParts),
          draftEdits,
          draftRuns
        }, { finishReason: finalFinishReason });
      }

      pending ??= { response: { message: assistant, finishReason: response.finishReason, usage: response.usage }, results: {} };
      committedProvider = structuredClone(providerRunState);
      logicalBudget.recordToolRound();
      await saveStep();
      emitStatus({ base: 'thinking', phase: 'planning_tool' });

      const responseFunctionOutputs: OpenAiResponsesItem[] = [];
      const anthropicToolResults: AnthropicUserContentBlock[] = [];
      const acceptedEmulatedHandoffs: Array<{ toolCallId: string; toolName: string }> = [];
      const batchWorkFingerprints: string[] = [];
      let rolloverAfterBatchReason: ContextEpochRolloverReason | undefined;
      let strategyWarningAfterBatch = false;
      let noProgressStopAfterBatch = false;
      const performToolCall = async (toolCall: DeepSeekToolCall): Promise<string> => {
        this.throwIfAborted(request.signal, request.language);
        const exposureError = getToolExposureError(toolCall.function.name, exposedToolNames);
        if (exposureError) {
          const rejected = exposureError;
          callbacks.onToolRejected?.({
            toolName: toolCall.function.name,
            errorType: 'subagent_tool_not_exposed'
          });
          trace.record({
            type: 'tool_result',
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            content: summarizeText(rejected)
          });
          runDetailsBuilderRef.current?.recordToolResult(toolCall.id, toolCall.function.name, rejected);
          return rejected;
        }
        if (Object.hasOwn(pending!.results, toolCall.id)) return pending!.results[toolCall.id];
        if (approvalReviewStopReason) {
          return JSON.stringify({
            ok: false,
            errorType: 'approval_review_stopped',
            error: approvalReviewStopReason
          });
        }
        if (approvalReviewBoundaryReached) {
          return JSON.stringify({
            ok: true,
            status: 'approval_review_deferred',
            message: 'A prior reviewed effect ended this model step. The host will provide its decision and result in the next user message.'
          });
        }
        trace.record({
          type: 'tool_call',
          toolCall: trace.includesPayload('request') ? toolCall : summarizeDeepSeekToolCall(toolCall)
        });
        const argumentsHash = hashText(toolCall.function.arguments || '{}');
        let evidenceRecord = await evidenceStore.ensureIntent({
          sessionId: evidenceSessionId,
          taskId: checkpoint.taskId,
          epochIndex: epoch.index,
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          argumentsHash,
          effectKind: this.getEvidenceEffectKind(toolCall.function.name)
        });
        if (evidenceRecord.executionStatus === 'completed') {
          if (evidenceRecord.providerEnvelope === undefined) {
            const raw = await evidenceStore.readContent(evidenceRecord);
            const decision = admission.decide({
              estimatedInputTokens: this.estimateCurrentProviderInputTokens(request, messages, tools, providerRunState),
              configuredMaxOutputTokens: runtimeConfig.maxTokens,
              phase: 'tool',
              remainingBatchResults: Math.max(1, toolCalls.length)
            });
            const prepared = prepareEvidenceEnvelope({ record: evidenceRecord, rawContent: raw,
              inlineTokenAllowance: decision.inlineTokenAllowance,
              inlineCharLimit: getConfiguredProviderInlineResultMaxChars() });
            evidenceRecord = await evidenceStore.saveProviderEnvelope(evidenceRecord, prepared.content, prepared.completeInline, prepared.source);
          }
          this.upsertEpochEvidenceRef(epoch, evidenceRecord);
          trace.record({ type: 'tool_evidence_reused', toolCallId: toolCall.id, toolName: toolCall.function.name,
            evidenceRef: evidenceRecord.evidenceRef, contentHash: evidenceRecord.contentHash });
          return evidenceRecord.providerEnvelope!;
        }
        if (!logicalBudget.tryRecordToolCall()) {
          return JSON.stringify({
            ok: false,
            errorType: 'tool_call_budget_exhausted',
            error: 'The logical run tool-call budget is exhausted. No tool was executed.'
          });
        }
        toolCallCount = logicalBudget.state.toolCalls;
        epoch.toolCallsInEpoch += 1;
        taskPlan.startTool(toolCall.function.name);
        emitStatus({
          base: 'executing',
          phase: this.getToolActivityPhase(toolCall.function.name),
          toolName: toolCall.function.name
        });
        let rawToolResult: string;
        let toolArgs: Record<string, unknown> = {};
        let authorizationDecision: ToolAuthorizationDecision | undefined;
        let validationExecuted = false;
        try {
          toolArgs = this.parseToolArguments(toolCall.function.arguments);
          runDetailsBuilderRef.current?.recordToolArguments(toolCall.id, toolCall.function.name, toolArgs);
          const planPhaseBlockReason = getPlanPhaseToolBlockReason({
            executionMode: request.executionMode,
            toolName: toolCall.function.name,
            args: toolArgs,
            skills: request.currentRunContext?.skills
          });
          if (planPhaseBlockReason) {
            rawToolResult = createPlanPhaseBlockedToolResult(toolCall.function.name, planPhaseBlockReason);
          } else if (toolCall.function.name === RUN_VALIDATION_TOOL_NAME && validationState.hasPendingDraftEdit()) {
            rawToolResult = validationState.createBlockedValidationResult(request.language);
          } else if (isDraftEditPreparationTool(toolCall.function.name) && !repairLoop.beginRepair()) {
            const state = repairLoop.getState();
            const detail = request.language === 'en'
              ? `The automatic repair limit of ${state.maxIterations} iteration(s) was reached.`
              : `自动修复已达到 ${state.maxIterations} 轮上限。`;
            taskPlan.markRepairLimitReached(detail);
            rawToolResult = JSON.stringify({
              ok: false,
              errorType: 'repair_iteration_limit_exhausted',
              repairLoop: state,
              error: detail
            });
          } else {
            const authorizationMetadata = getToolAuthorizationMetadata(toolCall.function.name, toolArgs);
            if (authorizationMetadata.riskLevel !== 'low') {
              emitStatus({
                base: 'waiting',
                phase: 'awaiting_authorization',
                toolName: toolCall.function.name,
                detail: authorizationMetadata.scope
              });
            }
            authorizationDecision = await this.reviewSideEffectTool({
              toolCall,
              args: toolArgs,
              request,
              agentRunId: trace.runId,
              approvalMode: runAuthorizationPolicy.approvalMode
            }) ?? await abortable(this.toolAuthorization.authorize({
              toolName: toolCall.function.name,
              args: toolArgs,
              language: request.language,
              policy: runAuthorizationPolicy
            }), request.signal);
            if (authorizationDecision.approvalReview) approvalReviewBoundaryReached = true;
            if (authorizationDecision.approvalReview?.decision === 'unavailable') {
              approvalReviewStopReason = authorizationDecision.reason ?? (request.language === 'en'
                ? 'Approval model unavailable; automatic work stopped safely.'
                : '审批模型不可用；自动任务已安全停止。');
            } else if (authorizationDecision.approvalCircuitBreakReason) {
              approvalReviewStopReason = request.language === 'en'
                ? authorizationDecision.approvalCircuitBreakReason === 'consecutive_denials'
                  ? 'Automatic work stopped after three consecutive model-review denials.'
                  : 'Automatic work stopped after ten model-review denials in the latest fifty reviews.'
                : authorizationDecision.approvalCircuitBreakReason === 'consecutive_denials'
                  ? '模型审批连续拒绝三次，自动任务已停止。'
                  : '最近五十次模型审批累计拒绝十次，自动任务已停止。';
            }
            this.throwIfAborted(request.signal, request.language);
            emitStatus({ base: 'executing', phase: this.getToolActivityPhase(toolCall.function.name), toolName: toolCall.function.name });
            trace.record({
              type: 'tool_authorization_decision',
              toolCallId: toolCall.id,
              decision: authorizationDecision,
              runAuthorizedScopes: [...runAuthorizationPolicy.authorizedScopes],
              runDeniedScopes: [...runAuthorizationPolicy.deniedScopes]
            });
            if (!authorizationDecision.allowed) {
              rawToolResult = authorizationDecision.approvalReview
                ? JSON.stringify({
                    ok: true,
                    status: authorizationDecision.approvalReview.decision === 'unavailable'
                      ? 'approval_reviewer_unavailable'
                      : 'approval_denied',
                    executed: false,
                    message: 'The exact operation was not executed. The reviewer decision will be supplied in the next user message.'
                  })
                : createAuthorizationDeniedToolResult(authorizationDecision);
            } else if (toolCall.function.name === RUN_VALIDATION_TOOL_NAME && validationRunCount >= runtimeConfig.maxValidationRuns) {
              rawToolResult = JSON.stringify({
                ok: false,
                errorType: 'validation_run_limit_exhausted',
                error: request.language === 'en'
                  ? `The controlled validation budget of ${runtimeConfig.maxValidationRuns} run(s) was reached.`
                  : `本轮受控验证预算已达到 ${runtimeConfig.maxValidationRuns} 次上限。`,
                budgetReason: 'validation_run_limit_exhausted'
              });
            } else {
              if (toolCall.function.name === RUN_VALIDATION_TOOL_NAME) {
                validationExecuted = true;
                validationRunCount += 1;
                const script = this.readSafeNpmScript(toolArgs, 'script');
                repairLoop.startValidation(script);
                trace.record({
                  type: 'validation_tool_call',
                  toolCallId: toolCall.id,
                  validationRunCount,
                  maxValidationRuns: runtimeConfig.maxValidationRuns,
                  repairIteration: repairLoop.getState().iteration
                });
              }
              pending!.executing = { id: toolCall.id, name: toolCall.function.name, evidenceRef: evidenceRecord.evidenceRef };
              await saveStep!(); // A durable intent is required before validation/delegation or any proposal.
              evidenceRecord = await evidenceStore.markExecuting(evidenceRecord);
              this.throwIfAborted(request.signal, request.language);
              if (getSubagentHandoffKind(toolCall.function.name)) emitStatus({ base: 'waiting', phase: 'waiting_for_subagent', toolName: toolCall.function.name });
              const execution = this.handleToolCall(toolCall, draftEdits, draftRuns, request.language, {
                signal: request.signal,
                runDeadlineAt,
                authorization: authorizationDecision,
                historyArchive: request.historyArchive,
                parentRequest: request,
                parentRunId: trace.runId,
                onUsage: runCallbacks.onUsage,
                onUsageLedgerRecord: runCallbacks.onUsageLedgerRecord,
                getCacheObservationCandidates: runCallbacks.getCacheObservationCandidates,
                onSubagentRunSummary: runCallbacks.onSubagentRunSummary,
                evidenceStore,
                evidenceSessionId,
                evidenceTaskId: checkpoint.taskId
              });
              const cancellableRead = !isDraftEditPreparationTool(toolCall.function.name)
                && !isDraftRunPreparationTool(toolCall.function.name)
                && toolCall.function.name !== RUN_VALIDATION_TOOL_NAME
                && !getSubagentHandoffKind(toolCall.function.name);
              try { rawToolResult = await (cancellableRead ? abortable(execution, request.signal) : execution); }
              catch (error) {
                if (cancellableRead && request.signal?.aborted) {
                  pending!.executing = undefined; // No effects to reconcile; explicit recovery may re-read.
                  await saveStep!();
                }
                throw error;
              }
            }
          }
        } catch (error) {
          if (request.signal?.aborted || checkpoint.stopReason === 'storage_failure' || checkpoint.stopReason === 'resource_limit') throw error;
          rawToolResult = JSON.stringify({
            ok: false,
            errorType: 'tool_execution_failed',
            error: error instanceof Error ? error.message : String(error)
          });
        }
        rawToolResult = this.normalizeToolResultFeedback(toolCall.function.name, rawToolResult);
        evidenceRecord = await evidenceStore.complete(evidenceRecord, rawToolResult);
        if (this.isToolResultError(rawToolResult)) {
          epoch.failures.push({
            toolName: toolCall.function.name,
            toolCallId: toolCall.id,
            contentHash: evidenceRecord.contentHash!,
            errorType: readToolResultErrorType(rawToolResult)
          });
          if (epoch.failures.length > 200) epoch.failures.splice(0, epoch.failures.length - 200);
        }
        if (authorizationDecision?.approvalReview) {
          approvalToolResults.push({
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            status: authorizationDecision.approvalReview.decision === 'unavailable'
              ? 'failed'
              : authorizationDecision.allowed
                ? this.isToolResultError(rawToolResult) ? 'failed' : 'succeeded'
                : 'denied',
            result: createBoundedReviewText(rawToolResult)
          });
        }
        runDetailsBuilderRef.current?.recordToolResult(toolCall.id, toolCall.function.name, rawToolResult);
        taskPlan.finishTool(toolCall.function.name, rawToolResult);
        if (toolCall.function.name === RUN_VALIDATION_TOOL_NAME) {
          if (validationExecuted) {
            validationState.recordValidationResult(rawToolResult);
          }
          // A reviewer denial/unavailability is an approval outcome, not a
          // validation failure. Preserve the legacy repair-loop handling for
          // other blocked or explicitly user-denied validation calls.
          if (validationExecuted || !authorizationDecision?.approvalReview) {
            const repairOutcome = repairLoop.recordValidationResult(rawToolResult);
            if (repairOutcome.failed && repairOutcome.limitReached) {
              taskPlan.markRepairLimitReached(repairOutcome.summary ?? 'Repair iteration limit reached.');
            } else if (repairOutcome.failed) {
              const state = repairLoop.getState();
              taskPlan.beginRepair(state.iteration, state.maxIterations, repairOutcome.summary);
            }
          }
        } else if (toolCall.function.name === READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME) {
          repairLoop.recordProblemsRead();
          taskPlan.markProblemsRead();
        } else if (isDraftEditPreparationTool(toolCall.function.name)) {
          const draftEditIds = readDraftEditIds(rawToolResult);
          if (draftEditIds.length) {
            for (const draftEditId of draftEditIds) validationState.recordDraftEdit(draftEditId);
            if (repairLoop.getState().status === 'generating_repair') {
              for (const draftEditId of draftEditIds) repairLoop.recordDraftEdit(draftEditId);
              const detail = request.language === 'en'
                ? 'Repair prepared. Apply the pending ChangeSet before validation can continue.'
                : '修复已准备。请先应用待确认 ChangeSet，之后才能继续验证。';
              taskPlan.markWaitingForApply(detail);
              emitStatus({ base: 'waiting', phase: 'waiting_for_apply', toolName: toolCall.function.name, detail });
            }
          }
        }
        if (toolCall.function.name === RUN_VALIDATION_TOOL_NAME || toolCall.function.name === READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME) {
          trace.record({
            type: 'validation_tool_result',
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            content: trace.includesPayload('request') ? rawToolResult : summarizeText(rawToolResult)
          });
        }
        if (isGitToolName(toolCall.function.name)) {
          trace.record({
            type: 'git_tool_result',
            toolCallId: toolCall.id,
            toolName: toolCall.function.name,
            content: trace.includesPayload('request') ? rawToolResult : summarizeText(rawToolResult)
          });
        }
        trace.record({
          type: 'tool_result_raw',
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          content: summarizeText(rawToolResult)
        });
        this.throwIfAborted(request.signal, request.language);
        const nextToolsForRequest = tools;
        const providerVisibleToolResult = authorizationDecision?.approvalReview
          ? JSON.stringify({
              ok: true,
              status: 'approval_result_pending',
              message: 'The host will provide the review decision and any execution result in the next user message.'
            })
          : rawToolResult;
        const admissionDecision = await decideWithCalibrationRepair({
          estimatedInputTokens: this.estimateCurrentProviderInputTokens(request, messages, nextToolsForRequest, providerRunState,
            responseFunctionOutputs, anthropicToolResults),
          configuredMaxOutputTokens: runtimeConfig.maxTokens,
          phase: 'tool',
          remainingBatchResults: Math.max(1, toolCalls.length - Object.keys(pending!.results).length)
        });
        if (admissionDecision.shouldRollover) rolloverAfterBatchReason ??= 'minimum_envelope_unfit';
        const remainingBatchResults = Math.max(1, toolCalls.length - Object.keys(pending!.results).length);
        const preparedEnvelope = prepareEvidenceEnvelope({
          record: evidenceRecord,
          rawContent: providerVisibleToolResult,
          // DSML carries a parallel batch in one synthetic user message. A
          // per-result share prevents its earlier pages from consuming the
          // reserve needed for later envelopes; native lanes benefit too.
          inlineTokenAllowance: Math.floor(admissionDecision.inlineTokenAllowance / remainingBatchResults),
          inlineCharLimit: getConfiguredProviderInlineResultMaxChars()
        });
        evidenceRecord = await evidenceStore.saveProviderEnvelope(
          evidenceRecord,
          preparedEnvelope.content,
          preparedEnvelope.completeInline,
          preparedEnvelope.source
        );
        if (!preparedEnvelope.completeInline && providerProjection.requestProtocolVersion < 8) {
          rolloverAfterBatchReason = 'protocol_migration';
        }
        this.upsertEpochEvidenceRef(epoch, evidenceRecord);
        const shapedToolResult: ShapedToolResult = {
          content: evidenceRecord.providerEnvelope!,
          path: evidenceRecord.source?.path,
          startLine: evidenceRecord.source?.startLine,
          endLine: evidenceRecord.source?.endLine,
          rawLength: rawToolResult.length,
          shapedLength: evidenceRecord.providerEnvelope!.length,
          compressible: true,
          truncated: !evidenceRecord.completeInline
        };
        const shapedToolMessage: DeepSeekMessage = {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: shapedToolResult.content
        };
        const nextToolResultTokens = estimateDeepSeekMessageTokens(shapedToolMessage);
        const prospectiveResponseOutput: OpenAiResponsesItem = {
          type: 'function_call_output',
          call_id: toolCall.id,
          output: shapedToolResult.content
        };
        toolResultTokens += nextToolResultTokens;
        const fingerprint = createWorkFingerprint({
          toolName: toolCall.function.name,
          argumentsHash,
          resultHash: evidenceRecord.contentHash!,
          sourceFingerprint: evidenceRecord.source?.fingerprint,
          planProgressHash: createTaskPlanProgressHash(taskPlan.getPlan())
        });
        epoch.idempotency.push(fingerprint);
        if (epoch.idempotency.length > 2_000) epoch.idempotency.splice(0, epoch.idempotency.length - 2_000);
        batchWorkFingerprints.push(fingerprint.fingerprint);
        if (shapedToolResult.content !== rawToolResult) {
          runDetailsBuilderRef.current?.recordToolResult(toolCall.id, toolCall.function.name, shapedToolResult.content, { deliveryOnly: true });
        }
        if (getSubagentHandoffKind(toolCall.function.name) && !request.subagentContext) {
          if (normalizedAssistant.source === 'native') {
            const handoff = createAcceptedRootSubagentHandoffEstimate({
              toolName: toolCall.function.name,
              handoffId: `${trace.runId}:${toolCall.id}`,
              rootRunId: trace.runId,
              tokensEstimate: this.estimateNativeProviderToolResultTokens({
                request,
                providerRunState,
                shapedToolMessage,
                prospectiveResponseOutput,
                responseFunctionOutputs,
                anthropicToolResults
              }),
              accepted: true,
              nested: false
            });
            if (handoff) {
              callbacks.onSubagentHandoffEstimate?.(handoff);
            }
          } else {
            acceptedEmulatedHandoffs.push({
              toolCallId: toolCall.id,
              toolName: toolCall.function.name
            });
          }
        }
        const ledgerEntry: ToolResultLedgerEntry = {
          toolName: toolCall.function.name,
          path: shapedToolResult.path,
          startLine: shapedToolResult.startLine,
          endLine: shapedToolResult.endLine,
          estimatedTokens: nextToolResultTokens,
          rawLength: shapedToolResult.rawLength,
          shapedLength: shapedToolResult.shapedLength,
          compressible: shapedToolResult.compressible,
          truncated: shapedToolResult.truncated
        };
        toolResultLedger.push(ledgerEntry);
        trace.record({
          type: 'tool_result',
          toolCallId: toolCall.id,
          toolName: toolCall.function.name,
          ledgerEntry,
          evidenceRef: evidenceRecord.evidenceRef,
          contentHash: evidenceRecord.contentHash,
          rawBytes: evidenceRecord.totalBytes,
          rawTokensEstimate: evidenceRecord.totalTokensEstimate,
          inlineTokensEstimate: preparedEnvelope.inlineTokens,
          completeInline: preparedEnvelope.completeInline,
          noProgressFingerprint: fingerprint.fingerprint,
          content: trace.includesPayload('request') ? shapedToolResult.content : summarizeText(shapedToolResult.content)
        });
        return shapedToolResult.content;
      };

      const executeToolCall = async (toolCall: DeepSeekToolCall): Promise<string> => {
        const result = await performToolCall(toolCall);
        pending!.results[toolCall.id] = result;
        pending!.executing = undefined;
        checkpoint.lastStepAt = new Date().toISOString();
        await saveStep!();
        this.throwIfAborted(request.signal, request.language);
        return result;
      };

      if (normalizedAssistant.source === 'native') {
        const assistantToolCallMessage: DeepSeekMessage = {
          role: 'assistant',
          content: assistant.content ?? null,
          reasoning_content: assistant.reasoning_content ?? null,
          tool_calls: toolCalls
        };
        messages.push(assistantToolCallMessage);
        trace.record({
          type: 'agent_message_appended',
          reason: 'assistant_tool_call',
          message: trace.includesPayload('request') ? assistantToolCallMessage : summarizeDeepSeekMessage(assistantToolCallMessage)
        });
        runtimeUsageBreakdown.toolCallTokensEstimate += estimateChatMessageTokens('assistant', [
          assistant.content ?? '',
          JSON.stringify(toolCalls)
        ].join('\n'));
        emitUsageEstimate(toolsForTurn);

        const roundToolResults: AgentToolResult[] = [];
        for (const toolCall of toolCalls) {
          const toolResult = await executeToolCall(toolCall);
          const toolMessage: DeepSeekMessage = {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult
          };
          messages.push(toolMessage);
          roundToolResults.push({
            toolCallId: toolCall.id,
            content: toolResult
          });
          responseFunctionOutputs.push({
            type: 'function_call_output',
            call_id: toolCall.id,
            output: toolResult
          });
          anthropicToolResults.push({
            type: 'tool_result',
            tool_use_id: toolCall.id,
            content: toolResult,
            ...(this.isToolResultError(toolResult) ? { is_error: true } : {})
          });
          trace.record({
            type: 'agent_message_appended',
            reason: 'native_tool_result',
            message: trace.includesPayload('request') ? toolMessage : summarizeDeepSeekMessage(toolMessage)
          });
          runtimeUsageBreakdown.toolResultTokensEstimate += estimateDeepSeekMessageTokens(toolMessage);
          emitUsageEstimate(tools);
          emitStatus({
            base: 'thinking',
            phase: 'reviewing_tool_result',
            toolName: toolCall.function.name
          });
        }
        if (providerRunState?.protocol === 'openai-responses' && responseFunctionOutputs.length) {
          // All provider output Items were appended by createModelResponse before
          // execution. Function outputs follow in stable function-call order.
          providerRunState.input.push(...responseFunctionOutputs);
          providerRunState.replayItems.push(...responseFunctionOutputs);
        } else if (providerRunState?.protocol === 'anthropic-messages' && anthropicToolResults.length) {
          const toolResultMessage: AnthropicMessage = {
            role: 'user',
            content: anthropicToolResults
          };
          providerRunState.messages.push(toolResultMessage);
          providerRunState.replayMessages.push(toolResultMessage);
        }
        // 保存本工具轮的原样字节快照，供跨轮重建（toolRounds 展开 == 本轮发送序列）。
        toolRounds.push({
          assistantContent: assistantToolCallMessage.content ?? null,
          reasoningContent: assistantToolCallMessage.reasoning_content ?? null,
          toolCalls,
          toolResults: roundToolResults
        });
      } else {
        runtimeUsageBreakdown.toolCallTokensEstimate += estimateChatMessageTokens('assistant', JSON.stringify(toolCalls));
        if (assistant.content?.trim()) {
          const assistantTextMessage: DeepSeekMessage = {
            role: 'assistant',
            content: assistant.content.trim()
          };
          messages.push(assistantTextMessage);
          trace.record({
            type: 'agent_message_appended',
            reason: 'dsml_assistant_text',
            message: trace.includesPayload('request') ? assistantTextMessage : summarizeDeepSeekMessage(assistantTextMessage)
          });
          runtimeUsageBreakdown.inputTokensEstimate += estimateDeepSeekMessageTokens(assistantTextMessage);
        }

        const emulatedResults: EmulatedDsmlToolResult[] = [];
        for (const toolCall of toolCalls) {
          const toolResult = await executeToolCall(toolCall);
          emulatedResults.push({ toolCall, content: toolResult });
          emitStatus({
            base: 'thinking',
            phase: 'reviewing_tool_result',
            toolName: toolCall.function.name
          });
        }

        const emulatedToolResultMessage: DeepSeekMessage = {
          role: 'user',
          content: this.formatEmulatedDsmlToolResults(emulatedResults, request.language)
        };
        messages.push(emulatedToolResultMessage);
        if (acceptedEmulatedHandoffs.length && !request.subagentContext) {
          const acceptedIds = new Set(acceptedEmulatedHandoffs.map((item) => item.toolCallId));
          const weights = emulatedResults.map((item) => estimateDeepSeekMessageTokens({
            role: 'user',
            content: this.formatEmulatedDsmlToolResults([item], request.language)
          }));
          const allocations = allocateSharedMessageTokens(estimateDeepSeekMessageTokens(emulatedToolResultMessage), weights);
          emulatedResults.forEach((item, index) => {
            if (!acceptedIds.has(item.toolCall.id)) { return; }
            const handoff = createAcceptedRootSubagentHandoffEstimate({
              toolName: item.toolCall.function.name,
              handoffId: `${trace.runId}:${item.toolCall.id}`,
              rootRunId: trace.runId,
              tokensEstimate: allocations[index],
              accepted: true,
              nested: false
            });
            if (handoff) {
              callbacks.onSubagentHandoffEstimate?.(handoff);
            }
          });
        }
        this.appendProviderUserText(providerRunState, emulatedToolResultMessage.content ?? '');
        trace.record({
          type: 'agent_message_appended',
          reason: 'dsml_emulated_tool_results',
          message: trace.includesPayload('request') ? emulatedToolResultMessage : summarizeDeepSeekMessage(emulatedToolResultMessage)
        });
        runtimeUsageBreakdown.toolResultTokensEstimate += estimateDeepSeekMessageTokens(emulatedToolResultMessage);
        emitUsageEstimate(tools);
      }

      // A model has no opportunity to react between parallel calls from the
      // same response. Observe one canonical fingerprint per completed batch,
      // so duplicate calls inside that batch cannot manufacture a warning.
      if (batchWorkFingerprints.length) {
        const batchFingerprint = hashText(stableStringify(batchWorkFingerprints));
        const progress = observeNoProgress(epoch.noProgress, batchFingerprint);
        epoch.noProgress = progress.state;
        strategyWarningAfterBatch = progress.action === 'warn';
        noProgressStopAfterBatch = progress.action === 'stop';
      }

      pending = undefined;
      checkpoint.modelStepRetries = 0;
      completedReplay = this.createProviderReplayState(providerRunState);
      nextTurn = turn + 1;
      epoch.turnInEpoch += 1;
      committedMessages = structuredClone(messages);
      committedProvider = structuredClone(providerRunState);
      checkpoint.lastStepAt = new Date().toISOString();
      await saveStep();
      if (noProgressStopAfterBatch) {
        throw new AgentInterruptedError('no_progress_loop', request.language === 'en'
          ? 'The task stopped because the same tool work and unchanged result repeated after a strategy-change warning.'
          : '任务在策略调整提醒后仍重复相同工具操作和未变化结果，已按无进展循环停止。');
      }
      if (strategyWarningAfterBatch) {
        const warning = request.language === 'en'
          ? 'No-progress warning: the same normalized tool operation produced the same evidence with no TaskPlan progress. Change strategy, use existing evidence, or finish now; do not repeat it again.'
          : '无进展提醒：相同规范化工具操作在 TaskPlan 无进展时产生了相同证据。请改变策略、使用已有证据或立即收尾，不要再次重复。';
        messages.push({ role: 'user', content: warning });
        this.appendProviderUserText(providerRunState, warning);
        committedMessages = structuredClone(messages);
        committedProvider = structuredClone(providerRunState);
        await saveStep();
      }
      const estimatedNextInput = this.estimateCurrentProviderInputTokens(request, messages, tools, providerRunState);
      const nextAdmission = await decideWithCalibrationRepair({
        estimatedInputTokens: estimatedNextInput,
        configuredMaxOutputTokens: runtimeConfig.maxTokens,
        phase: 'tool',
        remainingBatchResults: 1
      });
      if (!rolloverAfterBatchReason && shouldRolloverForSoftContextPressure({
        estimatedPromptTokens: estimatedNextInput,
        learnedEffectiveWindowTokens: admission.state.learnedEffectiveWindowTokens,
        triggerRatio: runtimeConfig.contextCompression.triggerRatio,
        epochIndex: epoch.index,
        turnsInEpoch: epoch.turnInEpoch
      })) {
        rolloverAfterBatchReason = 'soft_context_pressure';
      }
      if (!rolloverAfterBatchReason && nextAdmission.shouldRollover) rolloverAfterBatchReason = 'minimum_envelope_unfit';
      if (rolloverAfterBatchReason) await rolloverEpoch(rolloverAfterBatchReason);
      if (approvalReviewStopReason) {
        emitStatus({ base: 'complete', phase: 'finalizing', detail: approvalReviewStopReason });
        return finishRun({
          message: approvalReviewStopReason,
          reasoningContent: this.formatReasoning(reasoningParts),
          draftEdits,
          draftRuns,
          approvalContinuationRequired: true,
          approvalContinuationStopReason: approvalReviewStopReason,
          approvalToolResults
        }, { finishReason: 'approval_review_stopped', stopped: true });
      }
      if (approvalReviewBoundaryReached) {
        const message = request.language === 'en'
          ? 'Approval processing reached a safe continuation boundary.'
          : '审批处理已到达安全续跑边界。';
        emitStatus({ base: 'complete', phase: 'finalizing', detail: message });
        return finishRun({
          message,
          reasoningContent: this.formatReasoning(reasoningParts),
          draftEdits,
          draftRuns,
          approvalContinuationRequired: true,
          approvalToolResults
        }, { finishReason: 'approval_review_boundary' });
      }
    }

    } catch (error) {
      const budgetReason = error instanceof LogicalBudgetExceededError
        ? error.budgetReason
        : request.signal?.aborted && request.signal.reason instanceof ExecutionBudgetError
          ? 'run_time_limit_exhausted'
          : undefined;
      if (budgetReason) {
        emitStatus({ base: 'thinking', phase: 'finalizing' });
        return finishRun({
          message: this.getBudgetStopMessage(budgetReason, draftEdits, request.language),
          reasoningContent: this.formatReasoning(reasoningParts),
          draftEdits,
          draftRuns
        }, { finishReason: budgetReason, stopped: true });
      }
      let failedPlan;
      if (error instanceof AgentRunAbortedError || request.signal?.aborted) {
        failedPlan = taskPlan.stop(error instanceof Error ? error.message : undefined);
      } else {
        failedPlan = taskPlan.fail(error instanceof Error ? error.message : String(error));
      }
      trace.record({
        type: 'run_error',
        error: formatUnknownError(error)
      });
      callbacks.onRunDetails?.(runDetailsBuilderRef.current?.finish({
        taskPlan: failedPlan,
        repairLoop: repairLoop.getState(),
        finishReason: undefined,
        failureReason: error instanceof Error ? error.message : String(error),
        stopped: error instanceof AgentRunAbortedError || request.signal?.aborted
      }) ?? createFallbackRunDetails(trace.runId, request, failedPlan, traceLog?.uri, error));
      throw error;
    } finally {
      await trace.flush();
    }
  }

  private async createModelResponse(
    request: AgentRequest,
    runtimeConfig: AgentRuntimeConfig,
    messages: DeepSeekMessage[],
    tools: DeepSeekFunctionTool[],
    callbacks: AgentRunCallbacks,
    runDeadlineAt?: number,
    options: {
      allowPartialRecovery?: boolean;
      trace?: AgentInteractionTrace;
      usageTotals?: UpstreamUsageTotals;
      toolChoice?: 'auto' | 'none';
      usageSource?: UsageSource;
      providerRunState?: ProviderNativeRunState;
      contextEpochIndex?: number;
      historyCompacted?: boolean;
      protocolMigration?: boolean;
    } = {}
  ): Promise<DeepSeekStreamResult> {
    const trace = options.trace ?? createNoopInteractionTrace();
    this.throwIfCostLimitReached(request);
    let body: DeepSeekChatRequestBody | OpenAiResponsesRequestBody | AnthropicMessagesRequestBody;
    if (runtimeConfig.provider === 'openai-responses') {
      const responsesState = options.providerRunState;
      if (responsesState?.protocol !== 'openai-responses') {
        throw new Error('OpenAI Responses request projection is unavailable.');
      }
      body = {
        model: request.model.id,
        input: responsesState.input,
        stream: true,
        store: false,
        tools: responsesState.tools.length ? responsesState.tools : undefined,
        tool_choice: responsesState.tools.length ? options.toolChoice ?? 'auto' : undefined,
        max_output_tokens: runtimeConfig.maxTokens > 0 ? runtimeConfig.maxTokens : undefined,
        // KeepSeek's `max` is a DeepSeek-only setting. The Responses protocol
        // uses its portable supported level instead of emitting a pseudo value.
        include: request.settings.thinkingEnabled
          ? ['reasoning.encrypted_content']
          : undefined,
        reasoning: request.settings.thinkingEnabled
          ? { effort: 'high' }
          : undefined,
        temperature: runtimeConfig.temperature,
        top_p: runtimeConfig.topP
      };
    } else if (runtimeConfig.provider === 'anthropic-compatible') {
      const anthropicState = options.providerRunState;
      if (anthropicState?.protocol !== 'anthropic-messages') {
        throw new Error('Anthropic Messages request projection is unavailable.');
      }
      body = {
        model: request.model.id,
        system: anthropicState.system,
        messages: anthropicState.messages,
        tools: anthropicState.tools.length ? anthropicState.tools : undefined,
        tool_choice: anthropicState.tools.length
          ? { type: options.toolChoice ?? 'auto' }
          : undefined,
        stream: true,
        max_tokens: runtimeConfig.maxTokens,
        thinking: anthropicState.thinking,
        output_config: anthropicState.outputConfig,
        temperature: runtimeConfig.temperature,
        cache_control: anthropicState.cacheControl
      };
    } else {
      // This object and its field order are intentionally unchanged: DeepSeek's
      // request prefix and existing compatible-provider fixtures are cache state.
      body = {
        model: request.model.id,
        // Keep DeepSeek's exact message objects for prefix-cache stability. Strict
        // OpenAI-compatible endpoints reject DeepSeek's reasoning_content field,
        // including null values on assistant tool-call turns.
        messages: runtimeConfig.provider === 'deepseek'
          ? messages
          : messages.map(withoutDeepSeekReasoningContent),
        stream: true,
        thinking: runtimeConfig.provider === 'deepseek'
          ? { type: request.settings.thinkingEnabled ? 'enabled' : 'disabled' }
          : undefined,
        temperature: runtimeConfig.temperature,
        top_p: runtimeConfig.topP,
        tools: tools.length ? tools : undefined,
        tool_choice: tools.length ? options.toolChoice ?? 'auto' : undefined
      };

      if (runtimeConfig.provider === 'deepseek' && request.settings.thinkingEnabled) {
        body.reasoning_effort = request.settings.reasoningEffort;
      }

      if (runtimeConfig.maxTokens > 0) {
        body.max_tokens = runtimeConfig.maxTokens;
      }

      body.stream_options = {
        include_usage: true
      };
    }

    const upstreamRequestId = randomUUID();
    const requestProtocol = getProviderRequestLane({
      provider: runtimeConfig.provider,
      sourceId: runtimeConfig.sourceId,
      baseUrl: runtimeConfig.baseUrl,
      modelId: request.model.id
    }).protocol;
    const createAttemptSnapshot = (startedAt: string): UsagePriceSnapshot => createUsagePriceSnapshot({
      originalModelId: request.model.id,
      sourceId: runtimeConfig.sourceId,
      provider: runtimeConfig.provider,
      protocol: requestProtocol,
      supportsBilling: runtimeConfig.supportsBilling,
      requestStartedAt: startedAt
    });
    // Freeze a fallback before dispatch for defensive compatibility, but do
    // not count it unless the transport reports a physical attempt. The exact
    // per-attempt callback normally replaces every such fallback.
    const fallbackSnapshot = createAttemptSnapshot(new Date().toISOString());
    const attemptSnapshots: UsagePriceSnapshot[] = [];
    const attemptCacheObservations: ProviderCacheObservation[] = [];
    const usageSource = options.usageSource ?? 'executor';
    const observationTaskId = request.checkpoint?.taskId
      ?? (usageSource === 'background' ? request.backgroundRunId : undefined);
    const cacheScope = [
      request.sessionId ?? request.subagentContext?.parentSessionId ?? request.checkpoint?.taskId ?? 'unknown-session',
      usageSource === 'subagent' ? request.subagentContext?.id ?? observationTaskId ?? ''
        : usageSource === 'background' ? observationTaskId ?? '' : '',
      usageSource
    ].join('\u0000');
    const conversationId = usageSource === 'subagent'
      ? request.subagentContext?.id
      : usageSource === 'background' ? observationTaskId : undefined;
    const candidateContext = await callbacks.getCacheObservationCandidates?.({
      sessionId: request.sessionId ?? request.subagentContext?.parentSessionId ?? 'unknown-session',
      source: usageSource,
      conversationId: request.subagentContext?.previousConversationId ?? conversationId,
      cacheFamilyKey: request.subagentContext?.cacheFamilyKey
    });
    const previousCacheObservation = this.previousCacheObservationByScope.get(cacheScope)
      ?? candidateContext?.conversationPrevious
      ?? await callbacks.getPreviousCacheObservation?.({
        sessionId: request.sessionId ?? request.subagentContext?.parentSessionId ?? 'unknown-session',
        source: usageSource,
        taskId: request.subagentContext?.previousConversationId ?? observationTaskId
      });
    const estimatedPromptTokens = this.estimateCurrentProviderInputTokens(
      request,
      messages,
      tools,
      options.providerRunState
    );
    const createAttemptObservation = (attemptIndex: number): ProviderCacheObservation => createProviderCacheObservation({
      requestId: upstreamRequestId,
      attemptIndex,
      source: usageSource,
      sourceId: runtimeConfig.sourceId,
      provider: runtimeConfig.provider,
      baseUrl: runtimeConfig.baseUrl,
      body,
      taskId: observationTaskId,
      conversationId,
      runId: trace.runId,
      contextEpochIndex: options.contextEpochIndex,
      requestProtocolVersion: request.requestProtocolVersion,
      contextInstructions: request.contextInstructions,
      estimatedPromptTokens,
      conversationPrevious: attemptIndex > 0 ? attemptCacheObservations[0] ?? previousCacheObservation : previousCacheObservation,
      familyCandidates: candidateContext?.familyCandidates,
      cacheFamilyKey: request.subagentContext?.cacheFamilyKey,
      subagentProfile: request.subagentContext?.profile,
      subagentLane: request.subagentContext?.lane,
      subagentDepth: request.subagentContext?.depth,
      historyCompacted: options.historyCompacted,
      historyRewriteReason: request.historyRewriteReason,
      protocolMigration: options.protocolMigration
    });
    trace.record({
      type: 'upstream_request',
      requestId: upstreamRequestId,
      body: formatRequestBodyForTrace(body, trace.includesPayload('request'))
    });

    const requestReservations: Array<ReturnType<LogicalRunBudget['reservePhysicalRequest']>> = [];
    const physicalCallbacks: AgentRunCallbacks = {
      ...callbacks,
      beforeModelRequest: async () => {
        const reservation = request.taskRunBudget?.reservePhysicalRequest(
          estimatedPromptTokens,
          runtimeConfig.maxTokens
        );
        if (reservation) requestReservations.push(reservation);
        await callbacks.beforeModelRequest?.();
      }
    };
    const response = await createProviderClient(runtimeConfig.provider).createModelResponse(this.toProviderClientConfig(runtimeConfig), {
      body,
      language: request.language,
      signal: request.signal,
      callbacks: physicalCallbacks,
      runDeadlineAt,
      trace,
      requestId: upstreamRequestId,
      onAttempt: ({ attemptIndex, startedAt }) => {
        attemptSnapshots[attemptIndex] = createAttemptSnapshot(startedAt);
        attemptCacheObservations[attemptIndex] = createAttemptObservation(attemptIndex);
      }
    });
    const lastReservation = requestReservations.at(-1);
    if (lastReservation) request.taskRunBudget?.settlePhysicalRequest(lastReservation, response.usage ?? undefined);
    if (request.checkpoint && requestReservations.length) {
      request.checkpoint.runBudget = request.taskRunBudget?.state;
      request.checkpoint.modelRequests = request.taskRunBudget?.state.modelRequests ?? request.checkpoint.modelRequests;
      await callbacks.onCheckpoint?.(request.checkpoint);
    }

    const retryCount = response.retryCount ?? 0;
    while (attemptSnapshots.length < (response.attemptCount ?? retryCount + 1)) {
      const attemptIndex = attemptSnapshots.length;
      attemptSnapshots.push(attemptSnapshots.length === 0
        ? fallbackSnapshot
        : createAttemptSnapshot(new Date().toISOString()));
      attemptCacheObservations[attemptIndex] = createAttemptObservation(attemptIndex);
    }
    const normalizedUsageForLedger = normalizeDeepSeekUsage(response.usage);
    const ledgerRecords = createUsageLedgerRecords({
      requestId: upstreamRequestId,
      attempts: attemptSnapshots,
      usage: normalizedUsageForLedger,
      source: usageSource,
      cacheObservations: attemptCacheObservations
    });
    if (response.ok && normalizedUsageForLedger) {
      const successfulObservation = ledgerRecords.find((record) => record.kind === 'usage_response')?.cacheObservation;
      if (successfulObservation) this.previousCacheObservationByScope.set(cacheScope, successfulObservation);
    }
    for (const record of ledgerRecords) callbacks.onUsageLedgerRecord?.(record);
    trace.record({ type: 'upstream_usage_ledger', requestId: upstreamRequestId, records: ledgerRecords });

    // Usage can be reported before a failed/stopped stream. Observe it even
    // when no usable final assistant message is available.
    const usageEvent = this.recordUpstreamUsage(
      response.usage,
      options.usageTotals,
      trace,
      upstreamRequestId,
      request.model.id,
      runtimeConfig.sourceId,
      runtimeConfig.provider,
      runtimeConfig.baseUrl,
      runtimeConfig.supportsBilling,
      options.usageSource ?? 'executor',
      attemptSnapshots.at(-1),
      attemptSnapshots.length,
      request.subagentContext?.id
    );
    if (usageEvent?.pricingStatus === 'priced' || usageEvent?.pricingStatus === 'estimated_upper_bound') {
      request.taskCostBudget?.record(usageEvent.cost, usageEvent.currency);
      if (request.checkpoint) request.checkpoint.usedCostByCurrency = request.taskCostBudget?.snapshot() ?? {};
    }
    if (usageEvent) callbacks.onUsage?.(usageEvent);
    if ((request.taskCostBudget?.limit ?? 0) > 0
      && usageEvent?.pricingStatus !== 'priced'
      && usageEvent?.pricingStatus !== 'estimated_upper_bound') {
      throw new AgentInterruptedError('provider_error', request.language === 'en'
        ? 'The configured Provider cost limit cannot be enforced because this response did not include priceable usage.'
        : '本次响应没有提供可计费用量，无法安全执行用户配置的 Provider 费用上限。');
    }
    if (response.ok && response.message) {
      if (usageEvent) {
        callbacks.onUsageEstimate?.(calibrateContextUsageEstimate(
          options.providerRunState?.protocol === 'openai-responses'
            ? createContextUsageEstimateFromResponses({
                model: request.model,
                input: options.providerRunState.input,
                tools: options.providerRunState.tools,
                outputReserveTokens: resolveOutputReserveTokens(runtimeConfig.maxTokens),
                safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS
              })
            : options.providerRunState?.protocol === 'anthropic-messages'
              ? createContextUsageEstimateFromAnthropic({
                  model: request.model,
                  system: options.providerRunState.system,
                  messages: options.providerRunState.messages,
                  tools: options.providerRunState.tools,
                  outputReserveTokens: resolveOutputReserveTokens(runtimeConfig.maxTokens),
                  safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS
                })
              : createContextUsageEstimateFromMessages({
                model: request.model,
                messages,
                tools,
                outputReserveTokens: resolveOutputReserveTokens(runtimeConfig.maxTokens),
                safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS
              }),
          usageEvent.usage.promptTokens
        ));
      }
      if (options.providerRunState?.protocol === 'openai-responses' && response.nativeOutputItems?.length) {
        // response.output is authoritative and must precede all local function
        // outputs in the next stateless Responses request.
        options.providerRunState.input.push(...response.nativeOutputItems);
        options.providerRunState.replayItems.push(...response.nativeOutputItems);
      } else if (options.providerRunState?.protocol === 'anthropic-messages'
        && response.nativeAnthropicContentBlocks?.length) {
        const nativeMessage: AnthropicMessage = {
          role: 'assistant',
          content: response.nativeAnthropicContentBlocks
        };
        options.providerRunState.messages.push(nativeMessage);
        options.providerRunState.replayMessages.push(nativeMessage);
      }
      trace.record({
        type: 'upstream_response_message',
        requestId: upstreamRequestId,
        finishReason: response.finishReason,
        usage: response.usage,
        message: trace.includesPayload('request') ? response.message : summarizeDeepSeekMessage(response.message)
      });
      return {
        message: response.message,
        finishReason: response.finishReason,
        usage: response.usage,
        nativeOutputItems: response.nativeOutputItems,
        nativeAnthropicContentBlocks: response.nativeAnthropicContentBlocks
      };
    }

    if (response.failureKind === 'external_abort') {
      trace.record({
        type: 'upstream_request_failed',
        requestId: upstreamRequestId,
        failureKind: response.failureKind,
        retryable: response.retryable,
        hadPartialOutput: response.hadPartialOutput,
        error: response.error
      });
      throw new AgentRunAbortedError(request.language);
    }
    if (response.failureKind === 'run_time_limit') {
      trace.record({
        type: 'upstream_request_failed',
        requestId: upstreamRequestId,
        failureKind: response.failureKind,
        retryable: response.retryable,
        hadPartialOutput: response.hadPartialOutput,
        error: response.error
      });
      throw new LogicalBudgetExceededError('run_time_limit_exhausted');
    }
    trace.record({
      type: 'upstream_request_failed',
      requestId: upstreamRequestId,
      failureKind: response.failureKind,
      status: response.status,
      retryable: response.retryable,
      hadPartialOutput: response.hadPartialOutput,
      error: response.error
    });

    throw new AgentInterruptedError(response.error?.includes('resource limit') ? 'resource_limit' : response.failureKind === 'http' ? 'provider_error' : 'connection_interrupted', response.error ?? (request.language === 'en'
      ? 'The provider API request failed.'
      : 'Provider API 请求失败。'));
  }

  private async tryContinueLengthLimitedResponse(input: {
    request: AgentRequest;
    runtimeConfig: AgentRuntimeConfig;
    messages: DeepSeekMessage[];
    assistant: DeepSeekAssistantMessage;
    response: DeepSeekStreamResult;
    draftEdits: DraftEdit[];
    callbacks: AgentRunCallbacks;
    runDeadlineAt?: number;
    outputReserveTokens: number;
    reasoningParts: string[];
    runtimeUsageBreakdown: ContextUsageEstimate['breakdown'];
    trace: AgentInteractionTrace;
    usageTotals: UpstreamUsageTotals;
    tools: DeepSeekFunctionTool[];
    providerRunState?: ProviderNativeRunState;
  }): Promise<{ content: string; finishReason?: string | null } | undefined> {
    if (!this.canContinueLengthLimitedResponse(input)) {
      return undefined;
    }

    const saved = input.request.checkpoint?.state;
    let content = saved?.continuation?.content ?? input.assistant.content ?? '';
    let finishReason = saved?.continuation?.finishReason ?? input.response.finishReason;
    for (let continuationIndex = saved?.continuation?.requests ?? 0; ; continuationIndex += 1) {
      if (!input.request.taskRunBudget?.beginContinuation()) {
        return {
          content: this.appendBudgetTruncationNotice(content, input.request.language),
          finishReason: 'continuation_budget_exhausted'
        };
      }
      const assistantMessage: DeepSeekMessage = {
        role: 'assistant',
        content
      };
      const instructionMessage: DeepSeekMessage = {
        role: 'user',
        content: this.getLengthContinuationInstruction(input.request.language)
      };
      const isAnthropicPause = input.providerRunState?.protocol === 'anthropic-messages'
        && finishReason === 'pause_turn';
      const anthropicContinuationMessage: AnthropicMessage = {
        role: 'user',
        content: [{ type: 'text', text: instructionMessage.content ?? '' }]
      };
      if (!saved?.continuation?.inFlight) {
      input.messages.push(assistantMessage, instructionMessage);
      if (input.providerRunState?.protocol === 'openai-responses') {
        const responseInstruction: OpenAiResponsesItem = {
          role: 'user',
          content: instructionMessage.content ?? ''
        };
        input.providerRunState.input.push(responseInstruction);
        input.providerRunState.replayItems.push(responseInstruction);
      } else if (input.providerRunState?.protocol === 'anthropic-messages' && !isAnthropicPause) {
        input.providerRunState.messages.push(anthropicContinuationMessage);
        input.providerRunState.replayMessages.push(anthropicContinuationMessage);
      }
      input.trace.record({
        type: 'agent_message_appended',
        reason: 'length_continuation_partial_assistant',
        message: input.trace.includesPayload('request') ? assistantMessage : summarizeDeepSeekMessage(assistantMessage)
      });
      input.trace.record({
        type: 'agent_message_appended',
        reason: 'length_continuation_instruction',
        message: input.trace.includesPayload('request') ? instructionMessage : summarizeDeepSeekMessage(instructionMessage)
      });
      input.runtimeUsageBreakdown.inputTokensEstimate +=
        estimateDeepSeekMessageTokens(assistantMessage) + estimateDeepSeekMessageTokens(instructionMessage);
      }
      if (saved) {
        saved.messages = structuredClone(input.messages);
        saved.provider = structuredClone(input.providerRunState);
        saved.continuation = {
          content,
          finishReason,
          requests: input.request.taskRunBudget?.state.continuations ?? continuationIndex + 1,
          inFlight: true
        };
        await input.callbacks.onCheckpoint?.(input.request.checkpoint!);
      }


      const continuationResponse = await this.createModelResponse(
        input.request,
        { ...input.runtimeConfig, maxTokens: input.runtimeConfig.continuationMaxOutputTokens },
        input.messages,
        input.tools,
        input.callbacks,
        input.runDeadlineAt,
        {
          allowPartialRecovery: false,
          trace: input.trace,
          usageTotals: input.usageTotals,
          toolChoice: 'none',
          usageSource: 'continuation',
          providerRunState: input.providerRunState
        }
      );
      const normalizedContinuation = this.normalizeAssistantToolCalls(continuationResponse.message, false, false);
      if (continuationResponse.message.tool_calls?.some((toolCall) => toolCall.type === 'function')) {
        return {
          content: this.appendBudgetTruncationNotice(content, input.request.language),
          finishReason: 'continuation_budget_exhausted'
        };
      }
      if (normalizedContinuation.displayReasoningContent) {
        input.reasoningParts.push(normalizedContinuation.displayReasoningContent);
        input.runtimeUsageBreakdown.reasoningTokensEstimate += estimateChatMessageTokens('assistant', normalizedContinuation.displayReasoningContent);
      }
      const continuationContent = normalizedContinuation.assistant.content ?? '';
      const continuationCharLimit = input.request.taskRunBudget?.limits.maxContinuationOutputChars ?? 0;
      const continuationCharsUsed = input.request.taskRunBudget?.state.continuationOutputChars ?? 0;
      const remainingContinuationChars = continuationCharLimit > 0
        ? Math.max(0, continuationCharLimit - continuationCharsUsed)
        : continuationContent.length;
      const boundedContinuationContent = continuationContent.slice(0, remainingContinuationChars);
      content = this.joinContinuationContent(content, boundedContinuationContent);
      finishReason = continuationResponse.finishReason;
      const continuationTokens = continuationResponse.usage?.completion_tokens
        ?? estimateChatMessageTokens('assistant', continuationContent);
      const withinOutputBudget = input.request.taskRunBudget?.recordContinuationOutput(
        continuationTokens,
        continuationContent.length
      ) !== false && boundedContinuationContent.length === continuationContent.length;
      if (saved) {
        saved.continuation = {
          content,
          finishReason,
          requests: input.request.taskRunBudget?.state.continuations ?? continuationIndex + 1,
          inFlight: false
        };
        saved.provider = structuredClone(input.providerRunState);
        saved.pending = { response: { message: { ...normalizedContinuation.assistant, content }, finishReason }, results: {} };
        await input.callbacks.onCheckpoint?.(input.request.checkpoint!);
      }

      if (!withinOutputBudget) {
        return {
          content: this.appendBudgetTruncationNotice(content, input.request.language),
          finishReason: 'continuation_budget_exhausted'
        };
      }
      if ((finishReason !== 'length' && finishReason !== 'pause_turn')) break;
      if (!continuationContent.trim()) {
        throw new AgentInterruptedError('no_progress_loop', input.request.language === 'en'
          ? 'The provider repeatedly returned a length stop without additional content.'
          : 'Provider 连续因长度停止且没有产生新增内容，已按无进展循环停止。');
      }
    }

    return { content, finishReason };
  }

  private canContinueLengthLimitedResponse(input: {
    request: AgentRequest;
    messages: DeepSeekMessage[];
    assistant: DeepSeekAssistantMessage;
    response: DeepSeekStreamResult;
    draftEdits: DraftEdit[];
    outputReserveTokens: number;
    tools: DeepSeekFunctionTool[];
    providerRunState?: ProviderNativeRunState;
  }): boolean {
    const isLength = input.response.finishReason === 'length';
    const isAnthropicPause = input.response.finishReason === 'pause_turn'
      && input.providerRunState?.protocol === 'anthropic-messages';
    if (!isLength && !isAnthropicPause) {
      return false;
    }
    if (input.draftEdits.length) {
      return false;
    }
    if (input.assistant.tool_calls?.some((toolCall) => toolCall.type === 'function')) {
      return false;
    }

    return true;
  }

  private async createContinuationAfterPartialFailure(input: {
    request: AgentRequest;
    runtimeConfig: AgentRuntimeConfig;
    messages: DeepSeekMessage[];
    partialAssistant: DeepSeekAssistantMessage;
    failureError?: string;
    callbacks: AgentRunCallbacks;
    runDeadlineAt?: number;
    trace: AgentInteractionTrace;
    usageTotals?: UpstreamUsageTotals;
    tools: DeepSeekFunctionTool[];
    providerRunState?: ProviderNativeRunState;
  }): Promise<DeepSeekStreamResult> {
    const partialContent = input.partialAssistant.content ?? '';
    if (!partialContent.trim()) {
      throw new Error(input.failureError ?? (input.request.language === 'en'
        ? 'The provider streaming connection failed before completion.'
        : 'Provider 流式连接在完成前中断。'));
    }

    const continuationMessages: DeepSeekMessage[] = [
      ...input.messages,
      {
        role: 'assistant',
        content: partialContent
      },
      {
        role: 'user',
        content: this.getPartialFailureContinuationInstruction(input.request.language)
      }
    ];
    if (input.providerRunState?.protocol === 'openai-responses') {
      const partialMessage: OpenAiResponsesItem = { role: 'assistant', content: partialContent };
      const instructionItem: OpenAiResponsesItem = {
        role: 'user',
        content: this.getPartialFailureContinuationInstruction(input.request.language)
      };
      input.providerRunState.input.push(partialMessage, instructionItem);
      input.providerRunState.replayItems.push(partialMessage, instructionItem);
    } else if (input.providerRunState?.protocol === 'anthropic-messages') {
      const partialMessage: AnthropicMessage = {
        role: 'assistant',
        content: [{ type: 'text', text: partialContent }]
      };
      const instructionMessage: AnthropicMessage = {
        role: 'user',
        content: [{ type: 'text', text: this.getPartialFailureContinuationInstruction(input.request.language) }]
      };
      input.providerRunState.messages.push(partialMessage, instructionMessage);
      input.providerRunState.replayMessages.push(partialMessage, instructionMessage);
    }
    input.trace.record({
      type: 'partial_failure_continuation_messages',
      failureError: input.failureError,
      messages: input.trace.includesPayload('request')
        ? continuationMessages
        : continuationMessages.map(summarizeDeepSeekMessage)
    });
    const continuationResponse = await this.createModelResponse(
      input.request,
      { ...input.runtimeConfig, maxTokens: input.runtimeConfig.repairMaxOutputTokens },
      continuationMessages,
      input.tools,
      {
        ...input.callbacks,
        // Epoch summaries are an internal lane. Their streamed text must not
        // become part of the single user-visible assistant response.
        onDelta: undefined,
        onStatus: undefined,
        onUsageEstimate: undefined
      },
      input.runDeadlineAt,
      {
        allowPartialRecovery: false,
        trace: input.trace,
        usageTotals: input.usageTotals,
        toolChoice: 'none',
        usageSource: 'continuation',
        providerRunState: input.providerRunState
      }
    );
    const normalizedContinuation = this.normalizeAssistantToolCalls(continuationResponse.message, false, false);
    return {
      message: {
        ...normalizedContinuation.assistant,
        content: this.joinContinuationContent(partialContent, normalizedContinuation.assistant.content ?? ''),
        tool_calls: null
      },
      finishReason: continuationResponse.finishReason,
      usage: continuationResponse.usage
    };
  }

  private getLengthContinuationInstruction(language: KeepseekLanguage): string {
    return language === 'en'
      ? 'Continue the previous answer from exactly where it was cut off. Do not repeat earlier text. Do not call tools.'
      : '继续上一条回答，从截断处继续，不要重复前文。不要调用工具。';
  }

  private getPartialFailureContinuationInstruction(language: KeepseekLanguage): string {
    return language === 'en'
      ? 'The previous streaming response was interrupted after partial visible output. Continue from exactly where it stopped. Do not repeat earlier text. Do not call tools.'
      : '上一条流式回答在输出部分可见内容后中断。请从刚才停止的位置继续，不要重复前文。不要调用工具。';
  }

  private joinContinuationContent(left: string, right: string): string {
    if (!left) {
      return right;
    }
    if (!right) {
      return left;
    }
    return `${left}${right}`;
  }

  private toProviderClientConfig(runtimeConfig: AgentRuntimeConfig): ProviderClientConfig {
    return {
      apiKey: runtimeConfig.apiKey,
      baseUrl: runtimeConfig.baseUrl,
      streamIdleTimeoutMs: runtimeConfig.streamIdleTimeoutMs,
      maxRequestRetries: runtimeConfig.maxRequestRetries,
      requestRetryBaseMs: runtimeConfig.requestRetryBaseMs
    };
  }

  private createProviderReplayState(
    state: ProviderNativeRunState | undefined
  ): ProviderReplayState | undefined {
    if (state?.protocol === 'openai-responses' && state.replayItems.length) {
      return {
        protocol: 'openai-responses',
        sourceId: state.lane.sourceId,
        baseUrl: state.lane.baseUrl,
        items: state.replayItems
      };
    }
    if (state?.protocol === 'anthropic-messages' && state.replayMessages.length) {
      return {
        protocol: 'anthropic-messages',
        sourceId: state.lane.sourceId,
        baseUrl: state.lane.baseUrl,
        messages: state.replayMessages
      };
    }
    return undefined;
  }

  private recordUpstreamUsage(
    usage: DeepSeekUsage | null | undefined,
    totals: UpstreamUsageTotals | undefined,
    trace: AgentInteractionTrace,
    requestId: string,
    modelId: string,
    sourceId: string,
    provider: ModelSourceProvider,
    baseUrl: string,
    supportsBilling: boolean,
    source: UsageSource,
    priceSnapshot: UsagePriceSnapshot | undefined,
    providerAttemptCount = 1,
    subagentId?: string
  ): UsageEvent | undefined {
    if (!usage || !totals) {
      return undefined;
    }

    const normalizedUsage = normalizeDeepSeekUsage(usage);
    if (!normalizedUsage) {
      return undefined;
    }

    const snapshot = priceSnapshot ?? createUsagePriceSnapshot({
      originalModelId: modelId,
      sourceId,
      provider,
      protocol: getProviderRequestLane({ provider, sourceId, baseUrl, modelId }).protocol,
      supportsBilling,
      requestStartedAt: new Date().toISOString()
    });
    const priced = priceUsageFromSnapshot(normalizedUsage, snapshot);
    const usageEvent: UsageEvent = {
      ...createUsageEvent({
      usage: normalizedUsage,
      cost: priced.cost,
      currency: priced.currency,
      sourceId,
      modelId,
      provider,
      protocol: getProviderRequestLane({ provider, sourceId, baseUrl, modelId }).protocol,
      pricingStatus: priced.pricingStatus,
      unpricedReason: priced.unpricedReason,
      ledgerRecorded: true,
      providerAttemptCount,
      requestId,
      source
      }),
      ...(subagentId ? { subagentId } : {})
    };
    totals.requestCount += 1;
    totals.promptTokens += normalizedUsage.promptTokens;
    totals.completionTokens += normalizedUsage.completionTokens;
    totals.totalTokens += normalizedUsage.totalTokens;
    totals.cacheHitTokens += normalizedUsage.cacheHitTokens;
    totals.cacheMissTokens += normalizedUsage.cacheMissTokens;
    totals.reasoningTokens += normalizedUsage.reasoningTokens ?? 0;
    totals.cost += usageEvent.cost;
    totals.currency = usageEvent.currency;
    totals.records.push(usageEvent);
    trace.record({
      type: 'upstream_usage',
      requestId,
      usage,
      normalizedUsage,
      usageEvent,
      totals: this.summarizeUpstreamUsageTotals(totals)
    });
    return usageEvent;
  }

  private summarizeUpstreamUsageTotals(totals: UpstreamUsageTotals): Record<string, unknown> {
    return {
      requestCount: totals.requestCount,
      promptTokens: totals.promptTokens,
      completionTokens: totals.completionTokens,
      totalTokens: totals.totalTokens,
      cacheHitTokens: totals.cacheHitTokens,
      cacheMissTokens: totals.cacheMissTokens,
      reasoningTokens: totals.reasoningTokens,
      cost: totals.cost,
      currency: totals.currency,
      records: totals.records
    };
  }

  private createPromptCacheDiagnostics(input: {
    request: AgentRequest;
    messages: DeepSeekMessage[];
    tools: DeepSeekFunctionTool[];
    historyCompacted: boolean;
    runtimeConfig: AgentRuntimeConfig;
    responses?: {
      input: OpenAiResponsesItem[];
      tools: OpenAiResponsesFunctionTool[];
      lane: { sourceId: string; baseUrl: string };
    };
    anthropic?: {
      system: AnthropicSystemTextBlock[];
      messages: AnthropicMessage[];
      tools: AnthropicFunctionTool[];
      lane: { sourceId: string; baseUrl: string };
    };
  }): PromptCacheDiagnostics {
    if (input.anthropic) {
      return {
        systemPromptHash: hashStableText(JSON.stringify(input.anthropic.system)),
        toolsSchemaHash: hashStableText(JSON.stringify(input.anthropic.tools)),
        historyPrefixHash: hashStableText(JSON.stringify(input.anthropic.messages)),
        modelId: input.request.model.id,
        protocol: 'anthropic-messages',
        sourceId: input.anthropic.lane.sourceId,
        baseUrl: input.anthropic.lane.baseUrl,
        historyCompacted: input.historyCompacted,
        historyRewriteReason: input.request.historyRewriteReason,
        updatedAt: new Date().toISOString()
      };
    }
    if (input.responses) {
      const systemItems = input.responses.input.filter((item) => item.role === 'system');
      const historyItems = input.responses.input.filter((item) => item.role !== 'system');
      return {
        systemPromptHash: hashStableText(JSON.stringify(systemItems)),
        toolsSchemaHash: hashStableText(JSON.stringify(input.responses.tools)),
        historyPrefixHash: hashStableText(JSON.stringify(historyItems)),
        modelId: input.request.model.id,
        protocol: 'openai-responses',
        sourceId: input.responses.lane.sourceId,
        baseUrl: input.responses.lane.baseUrl,
        historyCompacted: input.historyCompacted,
        historyRewriteReason: input.request.historyRewriteReason,
        updatedAt: new Date().toISOString()
      };
    }
    const systemMessages = input.messages.filter((message) => message.role === 'system');
    const systemPrompt = systemMessages.map((message) => message.content ?? '').join('\n');
    const toolsSchema = JSON.stringify(input.tools);
    // 历史前缀指纹：system 段之后的所有消息（含 tool_calls / reasoning_content）。
    // 该指纹跨轮不变即前缀缓存可命中；变化则归因为 history_prefix_changed。
    const historyPrefixHash = hashStableText(JSON.stringify(
      input.messages
        .filter((message) => message.role !== 'system')
        .map((message) => ({
          role: message.role,
          content: message.content ?? null,
          reasoning_content: message.reasoning_content ?? null,
          tool_calls: message.tool_calls ?? null,
          tool_call_id: message.tool_call_id ?? null
        }))
    ));
    return {
      systemPromptHash: hashStableText(systemPrompt),
      toolsSchemaHash: hashStableText(toolsSchema),
      historyPrefixHash,
      modelId: input.request.model.id,
      protocol: getProviderRequestLane({
        provider: input.runtimeConfig.provider,
        sourceId: input.runtimeConfig.sourceId,
        baseUrl: input.runtimeConfig.baseUrl,
        modelId: input.request.model.id
      }).protocol,
      sourceId: input.runtimeConfig.sourceId,
      baseUrl: getProviderRequestLane({
        provider: input.runtimeConfig.provider,
        sourceId: input.runtimeConfig.sourceId,
        baseUrl: input.runtimeConfig.baseUrl,
        modelId: input.request.model.id
      }).endpointLane,
      historyCompacted: input.historyCompacted,
      historyRewriteReason: input.request.historyRewriteReason,
      updatedAt: new Date().toISOString()
    };
  }

  private toTurnUsageStats(totals: UpstreamUsageTotals, modelId: string): TurnUsageStats | undefined {
    if (!totals.requestCount) {
      return undefined;
    }

    let stats: TurnUsageStats | undefined;
    for (const record of totals.records) {
      stats = addUsageEventToTurnStats(stats, record);
    }
    return stats ? { ...stats, modelId } : undefined;
  }

  private throwIfAborted(signal: AbortSignal | undefined, language: KeepseekLanguage): void {
    if (signal?.aborted) {
      throw new AgentRunAbortedError(language);
    }
  }

  private throwIfCostLimitReached(request: AgentRequest): void {
    const exhausted = request.taskCostBudget?.exhausted;
    if (!exhausted) return;
    const cost = Number(exhausted.cost.toFixed(8));
    const limit = Number(exhausted.limit.toFixed(8));
    throw new AgentInterruptedError('cost_limit', request.language === 'en'
      ? `Configured Provider cost limit reached (${exhausted.currency}${cost} / ${exhausted.currency}${limit}).`
      : `已达到用户配置的 Provider 费用上限（${exhausted.currency}${cost} / ${exhausted.currency}${limit}）。`);
  }

  private createStatusEmitter(callbacks: AgentRunCallbacks): (status: AgentActivityInput) => void {
    let lastStatusKey = '';
    return (status) => {
      const nextStatusKey = [
        status.base,
        status.phase,
        status.toolName ?? '',
        status.detail ?? ''
      ].join('\u0000');
      if (nextStatusKey === lastStatusKey) {
        return;
      }
      lastStatusKey = nextStatusKey;
      callbacks.onStatus?.(status);
    };
  }

  private getToolActivityPhase(toolName: string): AgentActivityPhase {
    switch (toolName) {
      case LIST_WORKSPACE_FILES_TOOL_NAME:
        return 'listing_files';
      case LIST_WORKSPACE_DIRECTORY_TOOL_NAME:
        return 'listing_directory';
      case SEARCH_WORKSPACE_TOOL_NAME:
        return 'searching_workspace';
      case READ_WORKSPACE_FILE_RANGE_TOOL_NAME:
        return 'reading_file_range';
      case READ_WORKSPACE_FILE_TOOL_NAME:
        return 'reading_file';
      case CREATE_DRAFT_EDIT_TOOL_NAME:
      case CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME:
      case APPLY_PATCH_TOOL_NAME:
      case DELETE_WORKSPACE_FILE_TOOL_NAME:
        return 'creating_draft_edit';
      case RUN_DRAFT_TOOL_NAME:
        return 'creating_draft_run';
      case READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME:
        return 'reading_diagnostics';
      case FIND_SYMBOL_TOOL_NAME:
      case FIND_REFERENCES_TOOL_NAME:
      case GET_DOCUMENT_SYMBOLS_TOOL_NAME:
      case GET_WORKSPACE_SYMBOLS_TOOL_NAME:
        return 'reading_semantic_context';
      case GIT_STATUS_TOOL_NAME:
      case GIT_DIFF_TOOL_NAME:
      case GIT_CURRENT_BRANCH_TOOL_NAME:
      case GIT_CREATE_PATCH_TOOL_NAME:
      case GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME:
        return 'reading_git_state';
      case DELEGATE_TASK_TOOL_NAME:
      case DELEGATE_PARALLEL_TOOL_NAME:
      case READ_SUBAGENT_RESULT_TOOL_NAME:
      case READ_EVIDENCE_TOOL_NAME:
        return 'delegating';
      case RUN_VALIDATION_TOOL_NAME:
        return 'running_validation';
      default:
        return 'executing_tool';
    }
  }

  private async reviewSideEffectTool(input: {
    toolCall: DeepSeekToolCall;
    args: Record<string, unknown>;
    request: AgentRequest;
    agentRunId: string;
    approvalMode: AgentRequest['approvalMode'];
  }): Promise<ToolAuthorizationDecision | undefined> {
    const normalizedMode = normalizeApprovalMode(input.approvalMode);
    if (input.request.persona || normalizedMode === 'ask') return undefined;
    const mode = normalizedMode;
    const deny = (
      scope: 'workspace_read' | 'validation_compile_lint' | 'validation_test',
      reason: string,
      approvalReview?: ToolAuthorizationDecision['approvalReview'],
      approvalCircuitBreakReason?: ToolAuthorizationDecision['approvalCircuitBreakReason']
    ): ToolAuthorizationDecision => ({
      allowed: false,
      toolName: input.toolCall.function.name,
      riskLevel: scope === 'workspace_read' ? 'low' : 'medium',
      scope,
      source: mode === 'model_review' ? 'model_reviewer' : 'user_denied',
      requiresExplicitConfirmation: false,
      reason,
      approvalReview,
      approvalCircuitBreakReason
    });

    if (input.toolCall.function.name === READ_WORKSPACE_FILE_TOOL_NAME
      || input.toolCall.function.name === READ_WORKSPACE_FILE_RANGE_TOOL_NAME) {
      const rawPath = typeof input.args.path === 'string' ? input.args.path : '';
      const uri = rawPath ? this.workspaceTools.getReviewableExternalUri?.(rawPath) : undefined;
      if (!uri) return undefined;
      if (!this.approvalReviewer) return deny('workspace_read', 'Approval reviewer is unavailable; exact external access was not granted.');
      const reviewRequest = createExternalFileReviewRequest({
        request: input.request,
        agentRunId: input.agentRunId,
        targetId: `${input.toolCall.id}:${uri}`,
        uri,
        access: 'read',
        purpose: `Read the exact external file for tool ${input.toolCall.function.name}.`
      });
      const outcome = mode === 'model_review'
        ? await this.approvalReviewer.review(reviewRequest, toReviewerModelContext(input.request), input.request.signal)
        : await this.approvalReviewer.createHostPolicyApproval(reviewRequest);
      if (outcome.status === 'unavailable') return deny('workspace_read', outcome.record.rationale, toApprovalReviewDisplay(outcome.record), outcome.circuitBreakReason);
      if (outcome.record.decision !== 'approve') {
        return deny('workspace_read', formatReviewerDenial(outcome.record.rationale, outcome.record.saferAlternative, input.request.language), toApprovalReviewDisplay(outcome.record), outcome.circuitBreakReason);
      }
      await this.approvalReviewer.consumeApproval(outcome.record, mode);
      this.workspaceTools.authorizeReviewedExternalUri?.(uri);
      return {
        allowed: true,
        toolName: input.toolCall.function.name,
        riskLevel: 'low',
        scope: 'workspace_read',
        source: mode === 'model_review' ? 'model_reviewer' : 'delegated_approver',
        requiresExplicitConfirmation: false,
        reason: outcome.record.rationale,
        approvalReview: toApprovalReviewDisplay(outcome.record)
      };
    }

    if (input.toolCall.function.name !== RUN_VALIDATION_TOOL_NAME) return undefined;
    const script = this.readSafeNpmScript(input.args, 'script');
    const workspaceFolder = this.readOptionalString(input.args, 'workspaceFolder');
    const scope = script === 'test' ? 'validation_test' : 'validation_compile_lint';
    const preflight = await preflightSafeValidation({ script, workspaceFolder, language: input.request.language });
    if (!preflight.ok || !preflight.workspaceRootId) return deny(scope, preflight.error ?? 'Validation preflight failed.');
    if (!this.approvalReviewer) return deny(scope, 'Approval reviewer is unavailable; validation was not run.');
    const reviewRequest = createValidationReviewRequest({
      request: input.request,
      agentRunId: input.agentRunId,
      targetId: input.toolCall.id,
      script,
      workspaceRootId: preflight.workspaceRootId
    });
    const outcome = mode === 'model_review'
      ? await this.approvalReviewer.review(reviewRequest, toReviewerModelContext(input.request), input.request.signal)
      : await this.approvalReviewer.createHostPolicyApproval(reviewRequest);
    if (outcome.status === 'unavailable') return deny(scope, outcome.record.rationale, toApprovalReviewDisplay(outcome.record), outcome.circuitBreakReason);
    if (outcome.record.decision !== 'approve') {
      return deny(scope, formatReviewerDenial(outcome.record.rationale, outcome.record.saferAlternative, input.request.language), toApprovalReviewDisplay(outcome.record), outcome.circuitBreakReason);
    }
    await this.approvalReviewer.consumeApproval(outcome.record, mode);
    return {
      allowed: true,
      toolName: input.toolCall.function.name,
      riskLevel: 'medium',
      scope,
      source: mode === 'model_review' ? 'model_reviewer' : 'delegated_approver',
      requiresExplicitConfirmation: false,
      reason: outcome.record.rationale,
      approvalReview: toApprovalReviewDisplay(outcome.record)
    };
  }

  private async handleToolCall(
    toolCall: DeepSeekToolCall,
    draftEdits: DraftEdit[],
    draftRuns: DraftRunProposal[],
    language: KeepseekLanguage,
    options: {
      signal?: AbortSignal;
      runDeadlineAt?: number;
      authorization?: ToolAuthorizationDecision;
      historyArchive?: AgentRequest['historyArchive'];
      parentRequest?: AgentRequest;
      parentRunId?: string;
      onUsage?: AgentRunCallbacks['onUsage'];
      onUsageLedgerRecord?: AgentRunCallbacks['onUsageLedgerRecord'];
      getCacheObservationCandidates?: AgentRunCallbacks['getCacheObservationCandidates'];
      onSubagentRunSummary?: AgentRunCallbacks['onSubagentRunSummary'];
      evidenceStore?: ToolEvidenceStore;
      evidenceSessionId?: string;
      evidenceTaskId?: string;
    } = {}
  ): Promise<string> {
    try {
      const args = this.parseToolArguments(toolCall.function.arguments);
      switch (toolCall.function.name) {
        case READ_EVIDENCE_TOOL_NAME:
          if (!options.evidenceStore || !options.evidenceSessionId || !options.evidenceTaskId) {
            throw new Error('Tool evidence store is unavailable.');
          }
          return stableStringify(await options.evidenceStore.read({
            evidenceRef: this.readRequiredString(args, 'evidenceRef'),
            sessionId: options.evidenceSessionId,
            taskId: options.evidenceTaskId,
            cursor: this.readOptionalString(args, 'cursor'),
            offset: this.readOptionalNumber(args, 'offset'),
            startLine: this.readOptionalNumber(args, 'startLine'),
            endLine: this.readOptionalNumber(args, 'endLine'),
            itemOffset: this.readOptionalNumber(args, 'itemOffset'),
            itemLimit: this.readOptionalNumber(args, 'itemLimit'),
            search: this.readOptionalString(args, 'search'),
            maxChars: this.readOptionalNumber(args, 'maxChars')
          }));
        case DELEGATE_TASK_TOOL_NAME: {
          const context = this.getSubagentInvocationContext(language, options, toolCall.id, draftEdits);
          const result = await this.subagentTools!.delegateTask(this.readDelegateTaskInput(args), context);
          return this.mergeSubagentProposals(result, draftEdits, draftRuns);
        }
        case DELEGATE_PARALLEL_TOOL_NAME: {
          const context = this.getSubagentInvocationContext(language, options, toolCall.id, draftEdits);
          const rawTasks = args.tasks;
          if (!Array.isArray(rawTasks)) {
            throw new Error('Tool argument "tasks" must be an array.');
          }
          const result = await this.subagentTools!.delegateParallel({
            tasks: rawTasks.map((task, index) => {
              if (!this.isRecord(task)) {
                throw new Error(`Tool argument "tasks[${index}]" must be an object.`);
              }
              return this.readDelegateTaskInput(task);
            }),
            failFast: this.readOptionalBoolean(args, 'failFast', false)
          }, context);
          return this.mergeSubagentProposals(result, draftEdits, draftRuns);
        }
        case READ_SUBAGENT_RESULT_TOOL_NAME:
          return (await this.subagentTools!.readResult({
            ref: this.readOptionalString(args, 'ref'),
            subagentId: this.readOptionalString(args, 'subagentId'),
            offsetBytes: this.readOptionalNumber(args, 'offsetBytes'),
            limitBytes: this.readOptionalNumber(args, 'limitBytes'),
            offset: this.readOptionalNumber(args, 'offset'),
            maxChars: this.readOptionalNumber(args, 'maxChars')
          }, this.getSubagentInvocationContext(language, options))).content;
        case SEARCH_SESSION_ARCHIVE_TOOL_NAME:
          return JSON.stringify({
            ok: true,
            query: this.readRequiredString(args, 'query'),
            results: searchHistoryArchive(
              options.historyArchive,
              this.readRequiredString(args, 'query'),
              {
                maxResults: this.readOptionalNumber(args, 'maxResults'),
                maxChars: this.readOptionalNumber(args, 'maxChars')
              }
            )
          });
        case LIST_WORKSPACE_FILES_TOOL_NAME:
          return await this.workspaceTools.listWorkspaceFiles(language);
        case LIST_WORKSPACE_DIRECTORY_TOOL_NAME:
          return await this.workspaceTools.listWorkspaceDirectory(
            this.readRequiredString(args, 'path'),
            this.readOptionalBoolean(args, 'recursive', false),
            this.readOptionalNumber(args, 'maxFiles'),
            language
          );
        case SEARCH_WORKSPACE_TOOL_NAME:
          return await this.workspaceTools.searchWorkspace({
            query: this.readRequiredString(args, 'query'),
            path: this.readOptionalString(args, 'path'),
            include: this.readOptionalString(args, 'include'),
            isRegex: this.readOptionalBoolean(args, 'isRegex', false),
            matchCase: this.readOptionalBoolean(args, 'matchCase', false),
            maxResults: this.readOptionalNumber(args, 'maxResults')
          }, language, {
            signal: options.signal,
            runDeadlineAt: options.runDeadlineAt
          });
        case READ_WORKSPACE_FILE_RANGE_TOOL_NAME:
          return await this.workspaceTools.readWorkspaceFileRange({
            path: this.readRequiredString(args, 'path'),
            startLine: this.readRequiredNumber(args, 'startLine'),
            endLine: this.readRequiredNumber(args, 'endLine'),
            maxBytes: this.readOptionalNumber(args, 'maxBytes')
          }, language);
        case READ_WORKSPACE_FILE_TOOL_NAME:
          return await this.workspaceTools.readWorkspaceFile(this.readRequiredString(args, 'path'), language);
        case READ_WORKSPACE_DIAGNOSTICS_TOOL_NAME:
          return await this.validationTools.readWorkspaceDiagnostics(language);
        case FIND_SYMBOL_TOOL_NAME:
          return await this.semanticTools.findSymbol({
            query: this.readRequiredString(args, 'query'),
            path: this.readOptionalString(args, 'path'),
            maxResults: this.readOptionalNumber(args, 'maxResults')
          }, language);
        case FIND_REFERENCES_TOOL_NAME:
          return await this.semanticTools.findReferences({
            path: this.readRequiredString(args, 'path'),
            line: this.readRequiredNumber(args, 'line'),
            column: this.readRequiredNumber(args, 'column'),
            includeDeclaration: this.readOptionalBoolean(args, 'includeDeclaration', false),
            maxResults: this.readOptionalNumber(args, 'maxResults')
          }, language);
        case GET_DOCUMENT_SYMBOLS_TOOL_NAME:
          return await this.semanticTools.getDocumentSymbols({
            path: this.readRequiredString(args, 'path'),
            maxResults: this.readOptionalNumber(args, 'maxResults')
          }, language);
        case GET_WORKSPACE_SYMBOLS_TOOL_NAME:
          return await this.semanticTools.getWorkspaceSymbols({
            query: this.readRequiredString(args, 'query'),
            maxResults: this.readOptionalNumber(args, 'maxResults')
          }, language);
        case GIT_STATUS_TOOL_NAME:
          return await this.gitTools.getStatus({ workspaceFolder: this.readOptionalString(args, 'workspaceFolder') }, language);
        case GIT_CURRENT_BRANCH_TOOL_NAME:
          return await this.gitTools.getCurrentBranch({ workspaceFolder: this.readOptionalString(args, 'workspaceFolder') }, language);
        case GIT_DIFF_TOOL_NAME:
          return await this.gitTools.getDiff({
            workspaceFolder: this.readOptionalString(args, 'workspaceFolder'),
            staged: this.readOptionalBoolean(args, 'staged', false),
            path: this.readOptionalString(args, 'path'),
            maxChars: this.readOptionalNumber(args, 'maxChars')
          }, language);
        case GIT_CREATE_PATCH_TOOL_NAME:
          return await this.gitTools.createPatch({
            workspaceFolder: this.readOptionalString(args, 'workspaceFolder'),
            staged: this.readOptionalBoolean(args, 'staged', false),
            path: this.readOptionalString(args, 'path')
          }, language);
        case GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME:
          return await this.gitTools.suggestCommitMessage({ workspaceFolder: this.readOptionalString(args, 'workspaceFolder') }, language);
        case RUN_VALIDATION_TOOL_NAME:
          if (!options.authorization) {
            return JSON.stringify({
              ok: false,
              errorType: 'authorization_denied',
              error: 'Validation requires a ToolAuthorizationDecision.'
            });
          }
          return await this.validationTools.runSafeNpmScript({
            script: this.readSafeNpmScript(args, 'script'),
            workspaceFolder: this.readOptionalString(args, 'workspaceFolder'),
            language,
            signal: options.signal,
            runDeadlineAt: options.runDeadlineAt,
            authorization: options.authorization
          });
        case RUN_DRAFT_TOOL_NAME:
          return await this.createDraftRun(args, draftRuns);
        case CREATE_DRAFT_EDIT_TOOL_NAME:
          return await this.createDraftEdit(args, draftEdits, language);
        case CREATE_INCREMENTAL_DRAFT_EDIT_TOOL_NAME:
          return await this.createIncrementalDraftEdit(args, draftEdits, language);
        case APPLY_PATCH_TOOL_NAME:
          return await this.createPatchDraftEdits(args, draftEdits, language);
        case DELETE_WORKSPACE_FILE_TOOL_NAME:
          return await this.createDeleteDraftEdit(args, draftEdits, language);
        default:
          return JSON.stringify({
            ok: false,
            error: `Unsupported tool: ${toolCall.function.name}`
          });
      }
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private getSubagentInvocationContext(
    language: KeepseekLanguage,
    options: {
      signal?: AbortSignal;
      parentRequest?: AgentRequest;
      parentRunId?: string;
      onUsage?: AgentRunCallbacks['onUsage'];
      onUsageLedgerRecord?: AgentRunCallbacks['onUsageLedgerRecord'];
      getCacheObservationCandidates?: AgentRunCallbacks['getCacheObservationCandidates'];
      onSubagentRunSummary?: AgentRunCallbacks['onSubagentRunSummary'];
    },
    parentToolCallId?: string,
    parentDraftEdits: readonly DraftEdit[] = []
  ): import('./subagents/types').SubagentInvocationContext {
    if (!this.subagentTools || !options.parentRequest || !options.parentRunId) {
      throw new Error('Subagent runtime is unavailable for this Agent runner.');
    }
    return {
      parentRequest: options.parentRequest,
      parentRunId: options.parentRunId,
      parentToolCallId,
      parentDraftEditUris: parentDraftEdits.map((edit) => edit.uri),
      language,
      signal: options.signal,
      onUsage: options.onUsage,
      onUsageLedgerRecord: options.onUsageLedgerRecord,
      getCacheObservationCandidates: options.getCacheObservationCandidates,
      onRunSummary: options.onSubagentRunSummary
    };
  }

  private mergeSubagentProposals(
    result: import('./subagents/types').SubagentToolExecution,
    draftEdits: DraftEdit[],
    draftRuns: DraftRunProposal[]
  ): string {
    const conflicts: string[] = [];
    for (const edit of result.draftEdits ?? []) {
      if (draftEdits.some((existing) => existing.uri === edit.uri)) {
        conflicts.push(edit.label);
        continue;
      }
      draftEdits.push(edit);
    }
    draftRuns.push(...(result.draftRuns ?? []));
    if (!conflicts.length) {
      return result.content;
    }
    let base: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(result.content);
      base = this.isRecord(parsed) ? parsed : { result: parsed };
    } catch {
      base = { result: result.content };
    }
    return JSON.stringify({
      ...base,
      ok: false,
      errorType: 'subagent_proposal_conflict',
      conflicts,
      error: 'A child proposal overlapped an edit already collected by the parent run. The conflicting child edit was omitted.'
    });
  }

  private readDelegateTaskInput(args: Record<string, unknown>): DelegateTaskInput {
    const lane = this.readOptionalString(args, 'lane');
    if (lane && !isSubagentLane(lane)) {
      throw new Error('Tool argument "lane" is not a supported subagent lane.');
    }
    const rawPaths = args.paths;
    if (rawPaths !== undefined && (!Array.isArray(rawPaths) || !rawPaths.every((value) => typeof value === 'string'))) {
      throw new Error('Tool argument "paths" must be an array of strings.');
    }
    return {
      task: this.readRequiredString(args, 'task'),
      profile: this.readOptionalString(args, 'profile'),
      lane: lane as SubagentLane | undefined,
      paths: rawPaths?.map((value) => String(value).trim()).filter(Boolean),
      continueSubagentId: this.readOptionalString(args, 'continueSubagentId'),
      maxSteps: this.readOptionalNumber(args, 'maxSteps'),
      timeoutMs: this.readOptionalNumber(args, 'timeoutMs')
    };
  }

  private async createDraftRun(
    args: Record<string, unknown>,
    draftRuns: DraftRunProposal[]
  ): Promise<string> {
    const rawArgs = args.args;
    if (!Array.isArray(rawArgs) || !rawArgs.every((value) => typeof value === 'string')) {
      throw new Error('Tool argument "args" must be an array of strings.');
    }
    const rawEnv = args.env;
    let env: DraftRunEnvironmentEntry[] | undefined;
    if (rawEnv !== undefined) {
      if (!Array.isArray(rawEnv)) {
        throw new Error('Tool argument "env" must be an array.');
      }
      env = rawEnv.map((value, index) => {
        if (!this.isRecord(value) || typeof value.name !== 'string' || typeof value.value !== 'string') {
          throw new Error(`Tool argument "env[${index}]" must contain string name and value fields.`);
        }
        return { name: value.name, value: value.value };
      });
    }
    const draftRun = await createDraftRunProposal({
      executable: this.readRequiredString(args, 'executable'),
      args: rawArgs,
      reason: this.readRequiredString(args, 'reason'),
      workspaceFolder: this.readOptionalString(args, 'workspaceFolder'),
      cwd: this.readOptionalString(args, 'cwd'),
      timeoutMs: this.readOptionalNumber(args, 'timeoutMs'),
      env
    });
    draftRuns.push(draftRun);
    return JSON.stringify({
      ok: true,
      draftRun: {
        id: draftRun.id,
        status: 'pending',
        specHash: draftRun.specHash,
        executable: draftRun.spec.executable,
        args: draftRun.spec.args,
        cwd: draftRun.spec.cwdLabel,
        timeoutMs: draftRun.spec.timeoutMs,
        env: draftRun.spec.env,
        reason: draftRun.spec.reason,
        effectAssessment: draftRun.effectAssessment
      },
      message: 'DraftRun prepared only; no process was started. The user must review and explicitly approve this single execution in the KeepSeek panel.'
    });
  }

  private async captureDraftBaseline(edit: DraftEdit): Promise<void> {
    if (edit.kind === 'text_patch_v1' || edit.kind === 'delete_v1' || edit.kind === 'move_v1' || edit.action === 'create') return;
    if (edit.kind === 'full_text_v1' && edit.base) return;
    if (!edit.kind && edit.expectedOriginalTextHash) return;
    const uri = vscode.Uri.parse(edit.uri);
    const stat = await vscode.workspace.fs.stat(uri);
    const limit = edit.kind === 'full_text_v1'
      ? getConfiguredPatchSettings().maxBackupBytes
      : getConfiguredWorkspaceReadMaxBytes();
    if (stat.type !== vscode.FileType.File || stat.size > limit) throw new AgentInterruptedError('resource_limit', 'Draft baseline is not a bounded text file / 草案基线不是允许大小内的文本文件');
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > limit) throw new AgentInterruptedError('resource_limit', 'Draft baseline resource limit / 草案基线超出资源上限');
    if (edit.kind === 'full_text_v1') {
      edit.base = { sha256: hashBytes(bytes), sizeBytes: bytes.byteLength };
    } else {
      edit.expectedOriginalTextHash = hashText(new TextDecoder().decode(bytes));
      edit.expectedOriginalSize = bytes.byteLength;
    }
  }

  private async createDraftEdit(args: Record<string, unknown>, draftEdits: DraftEdit[], language: KeepseekLanguage): Promise<string> {
    const input = this.readDraftEditToolInput(args);
    const uri = this.workspaceTools.resolveTargetUri(input.rawPath);
    const conflict = this.findDraftEditConflict(uri, draftEdits);
    if (conflict) {
      return this.createDraftEditConflictResult(uri, conflict, language);
    }
    const action = await this.getDraftEditAction(uri);
    let draftEdit: DraftEdit;
    if (input.replaceRange) {
      if (action !== 'modify') throw new Error('Line-range replacement requires an existing text file.');
      const bytes = await vscode.workspace.fs.readFile(uri);
      const patch = prepareTextPatch({
        targetUri: uri.toString(),
        baseBytes: bytes,
        edits: [{ startLine: input.replaceRange.startLine, endLine: input.replaceRange.endLine, replace: input.content }],
        limits: this.getTextPatchLimits(),
        normalizeReplacementEol: true
      });
      draftEdit = {
        id: randomUUID(), uri: uri.toString(), label: this.workspaceTools.getLabel(uri),
        kind: 'text_patch_v1', action: 'modify', patch, reason: input.reason
      };
    } else {
      draftEdit = await this.createFullTextDraft({
        id: randomUUID(), uri: uri.toString(), label: this.workspaceTools.getLabel(uri),
        action, content: input.content, reason: input.reason
      });
    }

    draftEdits.push(draftEdit);
    return JSON.stringify({
      ok: true,
      draftEdit: {
        id: draftEdit.id,
        label: draftEdit.label,
        replaceRange: input.replaceRange
      },
      message: 'DraftEdit added to this run. KeepSeek groups all DraftEdits from the same Agent run into one pending ChangeSet, where the user can review files separately or use Accept all after the run finishes.'
    });
  }

  private async createIncrementalDraftEdit(
    args: Record<string, unknown>,
    draftEdits: DraftEdit[],
    language: KeepseekLanguage
  ): Promise<string> {
    const rawPath = this.readRequiredString(args, 'path');
    const reason = this.readRequiredString(args, 'reason');
    const uri = this.workspaceTools.resolveTargetUri(rawPath);
    const conflict = this.findDraftEditConflict(uri, draftEdits);
    if (conflict) {
      return this.createDraftEditConflictResult(uri, conflict, language);
    }
    if (shouldSkipTextUri(uri)) {
      throw new Error('Incremental edits require an existing readable text file.');
    }
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      throw new Error('Incremental edits require an existing regular file.');
    }
    const originalBytes = await vscode.workspace.fs.readFile(uri);
    const edits = this.readIncrementalEditOperations(args.edits);
    const patch = prepareTextPatch({
      targetUri: uri.toString(),
      baseBytes: originalBytes,
      edits,
      limits: this.getTextPatchLimits(),
      normalizeReplacementEol: true
    });
    const draftEdit: DraftEdit = {
      id: randomUUID(),
      uri: uri.toString(),
      label: this.workspaceTools.getLabel(uri),
      kind: 'text_patch_v1',
      action: 'modify',
      patch,
      reason
    };
    draftEdits.push(draftEdit);
    return JSON.stringify({
      ok: true,
      draftEdit: { id: draftEdit.id, label: draftEdit.label, editCount: edits.length },
      message: 'Incremental edits were canonicalized into one patch-native pending DraftEdit. KeepSeek groups it with every other DraftEdit from this Agent run in one ChangeSet for individual review or Accept all.'
    });
  }

  private readIncrementalEditOperations(
    value: unknown
  ): TextPatchEditInput[] {
    const maxHunks = getConfiguredPatchSettings().maxHunks;
    if (!Array.isArray(value) || value.length < 1 || value.length > maxHunks) {
      throw new Error(`Tool argument "edits" must contain between 1 and ${maxHunks} edits.`);
    }
    return value.map((raw, index) => {
      if (!this.isRecord(raw)) {
        throw new Error(`edits[${index}] must be an object.`);
      }
      if (typeof raw.replace !== 'string') {
        throw new Error(`edits[${index}].replace must be a string.`);
      }
      const hasSearch = typeof raw.search === 'string';
      const hasRange = raw.replaceRange !== undefined;
      if (hasSearch === hasRange) {
        throw new Error(`edits[${index}] must provide exactly one of search or replaceRange.`);
      }
      if (hasSearch) {
        const search = raw.search as string;
        if (!search) {
          throw new Error(`edits[${index}].search cannot be empty.`);
        }
        return { search, replace: raw.replace as string };
      }
      const range = this.parseLineReplacementRange(raw.replaceRange, `edits[${index}].replaceRange`);
      return { startLine: range.startLine, endLine: range.endLine, replace: raw.replace as string };
    });
  }

  private async createDeleteDraftEdit(
    args: Record<string, unknown>,
    draftEdits: DraftEdit[],
    language: KeepseekLanguage
  ): Promise<string> {
    const rawPath = this.readRequiredString(args, 'path');
    const reason = this.readRequiredString(args, 'reason');
    const uri = this.workspaceTools.resolveTargetUri(rawPath);
    const conflict = this.findDraftEditConflict(uri, draftEdits);
    if (conflict) {
      return this.createDraftEditConflictResult(uri, conflict, language);
    }

    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (error) {
      if (!isFileNotFoundError(error)) {
        throw error;
      }
      return JSON.stringify({
        ok: false,
        errorType: 'delete_target_missing',
        path: this.workspaceTools.getLabel(uri),
        error: language === 'en'
          ? 'The file requested for deletion does not exist.'
          : '请求删除的文件不存在。'
      });
    }
    if (stat.type !== vscode.FileType.File) {
      return JSON.stringify({
        ok: false,
        errorType: 'delete_target_not_file',
        path: this.workspaceTools.getLabel(uri),
        error: language === 'en'
          ? 'Only regular files can be prepared for deletion. Directory deletion is not supported.'
          : '只能为普通文件准备删除；当前不支持目录删除。'
      });
    }
    const label = this.workspaceTools.getLabel(uri);
    if (shouldSkipTextUri(uri)) {
      return JSON.stringify({
        ok: false,
        errorType: 'delete_target_unreadable',
        path: label,
        error: language === 'en'
          ? 'Only readable UTF-8 text files can be prepared for safe deletion and rollback.'
          : '安全删除与回滚仅支持可读的 UTF-8 文本文件。'
      });
    }
    const maxBytes = getConfiguredPatchSettings().maxBackupBytes;
    if (stat.size > maxBytes) {
      return JSON.stringify({
        ok: false,
        errorType: 'delete_target_oversized',
        path: label,
        sizeBytes: stat.size,
        limitBytes: maxBytes,
        error: language === 'en'
          ? `The file exceeds the ${formatBytes(maxBytes)} safe deletion and rollback limit.`
          : `文件超过安全删除与回滚上限 ${formatBytes(maxBytes)}。`
      });
    }
    const originalBytes = await vscode.workspace.fs.readFile(uri);
    if (originalBytes.byteLength > maxBytes) {
      return JSON.stringify({
        ok: false,
        errorType: 'delete_target_oversized',
        path: label,
        sizeBytes: originalBytes.byteLength,
        limitBytes: maxBytes,
        error: language === 'en'
          ? `The file exceeds the ${formatBytes(maxBytes)} safe deletion and rollback limit.`
          : `文件超过安全删除与回滚上限 ${formatBytes(maxBytes)}。`
      });
    }
    if (decodeRollbackSafeUtf8Text(originalBytes) === undefined) {
      return JSON.stringify({
        ok: false,
        errorType: 'delete_target_unreadable',
        path: label,
        error: language === 'en'
          ? 'The file is not exact, rollback-safe UTF-8 text.'
          : '该文件不是可无损回滚的 UTF-8 文本。'
      });
    }

    const draftEdit: DraftEdit = createDeleteDraftEditV1({
      id: randomUUID(), uri: uri.toString(), label, reason, baseBytes: originalBytes
    });
    draftEdits.push(draftEdit);
    return JSON.stringify({
      ok: true,
      draftEdit: {
        id: draftEdit.id,
        label: draftEdit.label,
        action: draftEdit.action
      },
      message: language === 'en'
        ? 'Pending deletion added to this run. The file has not been deleted. KeepSeek groups it with the run\'s other DraftEdits in one ChangeSet for individual review or Accept all.'
        : '待确认删除已加入本轮修改，文件尚未删除。KeepSeek 会把它与本轮其它 DraftEdit 合并到同一个 ChangeSet，可逐个审核或全部采纳。'
    });
  }

  private findDraftEditConflict(uri: vscode.Uri, draftEdits: readonly DraftEdit[]): DraftEdit | undefined {
    const key = uri.toString();
    return draftEdits.find((edit) => edit.uri === key || (edit.kind === 'move_v1' && edit.targetUri === key));
  }

  private getTextPatchLimits() {
    const settings = getConfiguredPatchSettings();
    return {
      maxPatchBytes: settings.maxPayloadBytes,
      maxHunks: settings.maxHunks,
      maxChangedBytes: settings.maxChangedBytes,
      maxInlineBytes: settings.maxInlineBytes
    };
  }

  private async createPatchDraftEdits(
    args: Record<string, unknown>,
    draftEdits: DraftEdit[],
    language: KeepseekLanguage
  ): Promise<string> {
    const reason = this.readRequiredString(args, 'reason');
    const document = parseKeepseekPatch(this.readRequiredString(args, 'patch'), this.getTextPatchLimits());
    const staged: DraftEdit[] = [];
    for (const operation of document.operations) {
      const created = await this.createPatchOperationDraft(operation, reason, [...draftEdits, ...staged], language);
      staged.push(created);
    }
    const changedBytes = staged.reduce((total, edit) => {
      if (edit.kind === 'text_patch_v1') {
        return total + edit.patch.hunks.reduce((sum, hunk) => sum + hunk.oldSizeBytes + hunk.newSizeBytes, 0);
      }
      if (edit.kind === 'move_v1') return total;
      return total + (getDraftEditBase(edit)?.sizeBytes ?? 0) + (getDraftEditResult(edit)?.sizeBytes ?? 0);
    }, 0);
    const changedLimit = getConfiguredPatchSettings().maxChangedBytes;
    if (changedBytes > changedLimit) {
      throw new Error(`Patch changes ${changedBytes} bytes across files, exceeding the configured ${changedLimit}-byte limit.`);
    }
    draftEdits.push(...staged);
    return JSON.stringify({
      ok: true,
      draftEditIds: staged.map((edit) => edit.id),
      status: 'pending',
      files: staged.map((edit) => ({
        id: edit.id,
        label: edit.label,
        action: edit.action,
        kind: edit.kind,
        hash: edit.kind === 'text_patch_v1'
          ? edit.patch.canonicalHash
          : edit.kind === 'full_text_v1'
            ? edit.result.sha256
            : edit.kind === 'delete_v1' || edit.kind === 'move_v1'
              ? edit.base.sha256
              : hashText(edit.newText)
      }))
    });
  }

  private async createPatchOperationDraft(
    operation: KeepseekPatchOperation,
    reason: string,
    existing: readonly DraftEdit[],
    language: KeepseekLanguage
  ): Promise<DraftEdit> {
    const uri = this.workspaceTools.resolveTargetUri(operation.path);
    const conflict = this.findDraftEditConflict(uri, existing);
    if (conflict) {
      throw new Error(JSON.parse(this.createDraftEditConflictResult(uri, conflict, language)).error as string);
    }
    const label = this.workspaceTools.getLabel(uri);
    if (operation.action === 'add') {
      if (await this.getDraftEditAction(uri) !== 'create') throw new Error(`Patch add target already exists: ${label}`);
      return await this.createFullTextDraft({
        id: randomUUID(), uri: uri.toString(), label, action: 'create', content: operation.content, reason
      });
    }
    if (operation.action === 'move') {
      const targetUri = this.workspaceTools.resolveTargetUri(operation.to);
      if (this.findDraftEditConflict(targetUri, existing)) throw new Error('Patch move target conflicts with another declared target.');
      const source = await this.readExistingPatchTarget(uri, label);
      try {
        await vscode.workspace.fs.stat(targetUri);
        throw new Error(`Patch move target already exists: ${this.workspaceTools.getLabel(targetUri)}`);
      } catch (error) {
        if (!isFileNotFoundError(error)) throw error;
      }
      return {
        id: randomUUID(), uri: uri.toString(), label, kind: 'move_v1', action: 'move', reason,
        sourceUri: uri.toString(), targetUri: targetUri.toString(),
        base: { sha256: hashBytes(source), sizeBytes: source.byteLength }
      };
    }
    const bytes = await this.readExistingPatchTarget(uri, label);
    if (operation.action === 'delete') {
      if (bytes.byteLength > getConfiguredPatchSettings().maxBackupBytes) {
        throw new Error(`Delete target exceeds the configured rollback backup limit: ${label}`);
      }
      return createDeleteDraftEditV1({ id: randomUUID(), uri: uri.toString(), label, reason, baseBytes: bytes });
    }
    const patch = prepareTextPatch({
      targetUri: uri.toString(), baseBytes: bytes, edits: operation.edits,
      limits: this.getTextPatchLimits(), normalizeReplacementEol: false
    });
    return {
      id: randomUUID(), uri: uri.toString(), label, kind: 'text_patch_v1', action: 'modify', reason, patch
    };
  }

  private async readExistingPatchTarget(uri: vscode.Uri, label: string): Promise<Uint8Array> {
    if (shouldSkipTextUri(uri)) throw new Error(`Patch target is not an allowed text file: ${label}`);
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) throw new Error(`Patch target is not a regular file: ${label}`);
    const providerLimit = getConfiguredPatchSettings().maxProviderBufferBytes;
    if (uri.scheme !== 'file' && stat.size > providerLimit) {
      throw new Error(`Non-file patch target exceeds the configured ${providerLimit}-byte buffer limit: ${label}`);
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (uri.scheme !== 'file' && bytes.byteLength > providerLimit) {
      throw new Error(`Non-file patch target exceeds the configured ${providerLimit}-byte buffer limit: ${label}`);
    }
    inspectTextEncoding(bytes);
    return bytes;
  }

  private async createFullTextDraft(input: Parameters<typeof createFullTextDraftEdit>[0]): Promise<DraftEdit> {
    const edit = createFullTextDraftEdit(input);
    const bytes = new TextEncoder().encode(input.content);
    if (bytes.byteLength > getConfiguredPatchSettings().maxInlineBytes && this.globalStorageUri) {
      edit.contentBlobHash = await new ChangeArtifactStore(this.globalStorageUri).putBlob(bytes);
      edit.content = undefined;
    }
    return edit;
  }

  private createDraftEditConflictResult(
    uri: vscode.Uri,
    conflict: DraftEdit,
    language: KeepseekLanguage
  ): string {
    return JSON.stringify({
      ok: false,
      errorType: 'draft_edit_conflict',
      path: this.workspaceTools.getLabel(uri),
      existingDraftEdit: {
        id: conflict.id,
        action: conflict.action,
        label: conflict.label
      },
      error: language === 'en'
        ? 'A pending edit for this file already exists in the current Agent run.'
        : '当前 Agent 运行中已经存在该文件的待确认修改。'
    });
  }

  private readDraftEditToolInput(args: Record<string, unknown>): DraftEditToolInput {
    return {
      rawPath: this.readDraftEditStringArgument(args, ['path', 'targetPath'], {
        label: 'path'
      }),
      content: this.readDraftEditStringArgument(args, ['content', 'newContent'], {
        label: 'content',
        preserveWhitespace: true,
        allowEmpty: true
      }),
      reason: this.readDraftEditStringArgument(args, ['reason'], {
        label: 'reason'
      }),
      replaceRange: this.readOptionalLineReplacementRange(args)
    };
  }

  private readDraftEditStringArgument(
    args: Record<string, unknown>,
    keys: string[],
    options: { label: string; preserveWhitespace?: boolean; allowEmpty?: boolean }
  ): string {
    for (const key of keys) {
      const value = args[key];
      if (value === undefined) {
        continue;
      }
      if (typeof value !== 'string') {
        throw new Error(`Tool argument "${key}" must be a string.`);
      }

      const normalized = options.preserveWhitespace ? value : value.trim();
      if (!options.allowEmpty && !normalized.trim()) {
        throw new Error(`Tool argument "${key}" cannot be empty.`);
      }
      return normalized;
    }

    const aliases = keys.length > 1 ? ` (${keys.join(' or ')})` : '';
    throw new Error(`Tool argument "${options.label}"${aliases} must be a string.`);
  }

  private readOptionalLineReplacementRange(args: Record<string, unknown>): LineReplacementRange | undefined {
    const value = args.replaceRange ?? args.range;
    if (value !== undefined) {
      return this.parseLineReplacementRange(value, 'replaceRange');
    }

    if (args.startLine !== undefined || args.endLine !== undefined) {
      const startLine = this.readLineNumberArgument(args.startLine, 'startLine');
      const endLine = args.endLine === undefined
        ? startLine
        : this.readLineNumberArgument(args.endLine, 'endLine');
      return this.normalizeLineReplacementRange(startLine, endLine, 'replaceRange');
    }

    return undefined;
  }

  private parseLineReplacementRange(value: unknown, argumentName: string): LineReplacementRange {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      const match = /(?:^|[^\d])#?L?(\d+)\b(?:\s*(?:-|–|—|:|,|to|到|至)\s*#?L?(\d+)\b)?/iu.exec(trimmed);
      if (!match) {
        throw new Error(`Tool argument "${argumentName}" must be a line range like "42-57".`);
      }
      const startLine = Number(match[1]);
      const endLine = match[2] === undefined ? startLine : Number(match[2]);
      return this.normalizeLineReplacementRange(startLine, endLine, argumentName);
    }

    if (this.isRecord(value)) {
      const startValue = value.startLine ?? value.start ?? value.from;
      const endValue = value.endLine ?? value.end ?? value.to ?? startValue;
      return this.normalizeLineReplacementRange(
        this.readLineNumberArgument(startValue, `${argumentName}.startLine`),
        this.readLineNumberArgument(endValue, `${argumentName}.endLine`),
        argumentName
      );
    }

    throw new Error(`Tool argument "${argumentName}" must be a string or object.`);
  }

  private readLineNumberArgument(value: unknown, argumentName: string): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return Math.floor(value);
    }

    if (typeof value === 'string' && /^\d+$/u.test(value.trim())) {
      return Number(value.trim());
    }

    throw new Error(`Tool argument "${argumentName}" must be a positive line number.`);
  }

  private normalizeLineReplacementRange(startLine: number, endLine: number, argumentName: string): LineReplacementRange {
    if (!Number.isFinite(startLine) || !Number.isFinite(endLine) || startLine < 1 || endLine < 1) {
      throw new Error(`Tool argument "${argumentName}" must contain positive line numbers.`);
    }
    if (endLine < startLine) {
      throw new Error(`Tool argument "${argumentName}" end line must be greater than or equal to the start line.`);
    }
    return {
      startLine: Math.floor(startLine),
      endLine: Math.floor(endLine)
    };
  }

  private async createRangeReplacedDraftContent(
    uri: vscode.Uri,
    replacementContent: string,
    replaceRange: LineReplacementRange,
    language: KeepseekLanguage
  ): Promise<string> {
    if (shouldSkipTextUri(uri)) {
      throw new Error(language === 'en'
        ? 'Cannot apply replaceRange to a file type KeepSeek does not read as text.'
        : '无法对 KeepSeek 不会作为文本读取的文件类型应用 replaceRange。');
    }

    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.File) {
      throw new Error(language === 'en'
        ? 'replaceRange can only be applied to an existing regular file.'
        : 'replaceRange 只能应用到已存在的普通文件。');
    }

    const originalContent = new TextDecoder('utf-8', { fatal: false }).decode(await vscode.workspace.fs.readFile(uri));
    if (!isReadableTextContent(originalContent)) {
      throw new Error(language === 'en'
        ? 'Cannot apply replaceRange because the existing file does not look like readable text.'
        : '无法应用 replaceRange，因为现有文件不像可读文本。');
    }

    return this.replaceWholeLines(originalContent, replacementContent, replaceRange);
  }

  private replaceWholeLines(originalContent: string, replacementContent: string, replaceRange: LineReplacementRange): string {
    const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
    const normalizedOriginal = originalContent.replace(/\r\n?/gu, '\n');
    const normalizedReplacementBase = replacementContent.replace(/\r\n?/gu, '\n');
    const lineStarts = this.getLineStartOffsets(normalizedOriginal);
    const lineCount = this.getNormalizedLineCount(normalizedOriginal, lineStarts);
    if (lineCount === 0) {
      throw new Error('replaceRange cannot be applied to an empty file.');
    }
    if (replaceRange.endLine > lineCount) {
      throw new Error(`replaceRange ${replaceRange.startLine}-${replaceRange.endLine} exceeds file length ${lineCount}.`);
    }

    const startOffset = lineStarts[replaceRange.startLine - 1] ?? normalizedOriginal.length;
    const endOffset = replaceRange.endLine >= lineCount
      ? normalizedOriginal.length
      : lineStarts[replaceRange.endLine] ?? normalizedOriginal.length;
    let normalizedReplacement = normalizedReplacementBase;
    const shouldAppendLineBreak = Boolean(normalizedReplacement)
      && !normalizedReplacement.endsWith('\n')
      && (endOffset < normalizedOriginal.length || normalizedOriginal.endsWith('\n'));
    if (shouldAppendLineBreak) {
      normalizedReplacement = `${normalizedReplacement}\n`;
    }

    const replaced = `${normalizedOriginal.slice(0, startOffset)}${normalizedReplacement}${normalizedOriginal.slice(endOffset)}`;
    return newline === '\n' ? replaced : replaced.replace(/\n/gu, newline);
  }

  private getLineStartOffsets(content: string): number[] {
    const offsets = [0];
    for (let index = 0; index < content.length; index += 1) {
      if (content.charAt(index) === '\n') {
        offsets.push(index + 1);
      }
    }
    return offsets;
  }

  private getNormalizedLineCount(content: string, lineStarts: number[]): number {
    if (!content) {
      return 0;
    }
    return content.endsWith('\n') ? Math.max(1, lineStarts.length - 1) : lineStarts.length;
  }

  private estimateNativeProviderToolResultTokens(input: {
    request: AgentRequest;
    providerRunState?: ProviderNativeRunState;
    shapedToolMessage: DeepSeekMessage;
    prospectiveResponseOutput: OpenAiResponsesItem;
    responseFunctionOutputs: OpenAiResponsesItem[];
    anthropicToolResults: AnthropicUserContentBlock[];
  }): number {
    if (input.providerRunState?.protocol === 'openai-responses') {
      const before = createContextUsageEstimateFromResponses({
        model: input.request.model,
        input: [...input.providerRunState.input, ...input.responseFunctionOutputs],
        outputReserveTokens: 0,
        safetyReserveTokens: 0
      });
      const after = createContextUsageEstimateFromResponses({
        model: input.request.model,
        input: [...input.providerRunState.input, ...input.responseFunctionOutputs, input.prospectiveResponseOutput],
        outputReserveTokens: 0,
        safetyReserveTokens: 0
      });
      return Math.max(0, after.usedTokensEstimate - before.usedTokensEstimate);
    }
    if (input.providerRunState?.protocol === 'anthropic-messages') {
      const beforeMessages: AnthropicMessage[] = input.anthropicToolResults.length
        ? [...input.providerRunState.messages, { role: 'user', content: input.anthropicToolResults }]
        : input.providerRunState.messages;
      const nextBlock: AnthropicUserContentBlock = {
        type: 'tool_result',
        tool_use_id: input.shapedToolMessage.tool_call_id ?? '',
        content: input.shapedToolMessage.content ?? '',
        ...(this.isToolResultError(input.shapedToolMessage.content ?? '') ? { is_error: true } : {})
      };
      const afterMessages: AnthropicMessage[] = [
        ...input.providerRunState.messages,
        { role: 'user', content: [...input.anthropicToolResults, nextBlock] }
      ];
      const before = createContextUsageEstimateFromAnthropic({
        model: input.request.model,
        system: input.providerRunState.system,
        messages: beforeMessages,
        outputReserveTokens: 0,
        safetyReserveTokens: 0
      });
      const after = createContextUsageEstimateFromAnthropic({
        model: input.request.model,
        system: input.providerRunState.system,
        messages: afterMessages,
        outputReserveTokens: 0,
        safetyReserveTokens: 0
      });
      return Math.max(0, after.usedTokensEstimate - before.usedTokensEstimate);
    }
    return estimateDeepSeekMessageTokens(input.shapedToolMessage);
  }

  private shapeToolResult(toolName: string, rawContent: string, snipForContextPressure: boolean): ShapedToolResult {
    const rawLength = rawContent.length;
    const parsed = this.parseToolResultObject(rawContent);
    let shapedContent = rawContent;

    if ((toolName === LIST_WORKSPACE_FILES_TOOL_NAME || toolName === LIST_WORKSPACE_DIRECTORY_TOOL_NAME) && parsed) {
      shapedContent = shapeWorkspaceListingResult(parsed, snipForContextPressure);
    } else if (toolName === SEARCH_WORKSPACE_TOOL_NAME && parsed) {
      shapedContent = this.shapeSearchToolResult(parsed, snipForContextPressure);
    } else if (toolName === READ_WORKSPACE_FILE_RANGE_TOOL_NAME && parsed) {
      shapedContent = this.shapeRangeReadToolResult(parsed, snipForContextPressure);
    }

    const shapedMetadata = this.getToolResultMetadata(this.parseToolResultObject(shapedContent));
    return {
      content: shapedContent,
      path: shapedMetadata.path,
      startLine: shapedMetadata.startLine,
      endLine: shapedMetadata.endLine,
      rawLength,
      shapedLength: shapedContent.length,
      compressible: this.isCompressibleToolResult(toolName),
      truncated: shapedMetadata.truncated || shapedContent.length < rawContent.length
    };
  }

  private normalizeToolResultFeedback(toolName: string, rawContent: string): string {
    const parsed = this.parseToolResultObject(rawContent);
    if (!parsed || parsed.ok !== false || typeof parsed.errorType === 'string') {
      return rawContent;
    }
    const budgetReason = typeof parsed.budgetReason === 'string' ? parsed.budgetReason : undefined;
    return JSON.stringify({
      ...parsed,
      errorType: budgetReason
        ?? (toolName === RUN_VALIDATION_TOOL_NAME ? 'validation_failed' : 'tool_execution_failed')
    });
  }

  private shouldSnipToolResult(
    request: AgentRequest,
    messages: DeepSeekMessage[],
    tools: DeepSeekFunctionTool[],
    outputReserveTokens: number,
    providerRunState?: ProviderNativeRunState,
    pendingResponseFunctionOutputs: OpenAiResponsesItem[] = [],
    pendingAnthropicToolResults: AnthropicUserContentBlock[] = []
  ): boolean {
    const settings = getAgentRuntimeProfile(request.model, request.settings).contextCompression;
    const usage = providerRunState?.protocol === 'openai-responses'
      ? createContextUsageEstimateFromResponses({
          model: request.model,
          input: [...providerRunState.input, ...pendingResponseFunctionOutputs],
          tools: providerRunState.tools,
          outputReserveTokens,
          safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS
        })
      : providerRunState?.protocol === 'anthropic-messages'
        ? createContextUsageEstimateFromAnthropic({
            model: request.model,
            system: providerRunState.system,
            messages: pendingAnthropicToolResults.length
              ? [...providerRunState.messages, { role: 'user', content: pendingAnthropicToolResults }]
              : providerRunState.messages,
            tools: providerRunState.tools,
            outputReserveTokens,
            safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS
          })
        : createContextUsageEstimateFromMessages({
          model: request.model,
          messages,
          tools,
          outputReserveTokens,
          safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS
        });
    return usage.usedPercent / 100 >= settings.toolResultSnipRatio;
  }

  private shapeSearchToolResult(parsed: Record<string, unknown>, snipForContextPressure: boolean): string {
    const rawResults = Array.isArray(parsed.results) ? parsed.results : [];
    const shapedResults: unknown[] = [];
    const perFileCounts = new Map<string, number>();
    let totalChars = 0;
    let truncated = parsed.truncated === true;
    const resultLimit = snipForContextPressure ? SEARCH_SNIPPED_RESULT_LIMIT : SEARCH_SHAPED_RESULT_LIMIT;
    const resultsPerFileLimit = snipForContextPressure ? SEARCH_SNIPPED_RESULTS_PER_FILE_LIMIT : SEARCH_SHAPED_RESULTS_PER_FILE_LIMIT;
    const totalCharLimit = snipForContextPressure ? SEARCH_SNIPPED_TOTAL_CHARS : SEARCH_SHAPED_TOTAL_CHARS;
    const lineCharLimit = snipForContextPressure ? SEARCH_SNIPPED_LINE_CHARS : SEARCH_SHAPED_LINE_CHARS;

    for (const rawResult of rawResults) {
      if (!this.isRecord(rawResult)) {
        continue;
      }
      if (shapedResults.length >= resultLimit) {
        truncated = true;
        break;
      }

      const resultPath = typeof rawResult.path === 'string' ? rawResult.path : '';
      const fileCount = perFileCounts.get(resultPath) ?? 0;
      if (fileCount >= resultsPerFileLimit) {
        truncated = true;
        continue;
      }

      const shapedResult = this.shapeSearchResult(rawResult, lineCharLimit);
      const shapedChars = JSON.stringify(shapedResult).length;
      if (totalChars + shapedChars > totalCharLimit) {
        truncated = true;
        break;
      }

      totalChars += shapedChars;
      perFileCounts.set(resultPath, fileCount + 1);
      shapedResults.push(shapedResult);
    }

    return JSON.stringify({
      ...parsed,
      results: shapedResults,
      count: shapedResults.length,
      limit: Math.min(readFiniteNumber(parsed.limit, resultLimit), resultLimit),
      truncated: truncated || shapedResults.length < rawResults.length,
      perFileLimit: resultsPerFileLimit,
      totalCharLimit,
      snippedForContextPressure: snipForContextPressure || undefined
    });
  }

  private shapeSearchResult(result: Record<string, unknown>, lineCharLimit: number): Record<string, unknown> {
    return {
      ...result,
      matchLine: this.shapeSearchText(typeof result.matchLine === 'string' ? result.matchLine : '', lineCharLimit),
      matchLineTruncated: result.matchLineTruncated === true || this.isSearchTextTruncated(result.matchLine, lineCharLimit),
      before: this.shapeSearchContextLines(result.before, lineCharLimit),
      after: this.shapeSearchContextLines(result.after, lineCharLimit)
    };
  }

  private shapeSearchContextLines(value: unknown, lineCharLimit: number): unknown[] {
    if (!Array.isArray(value)) {
      return [];
    }
    return value.map((item) => {
      if (!this.isRecord(item)) {
        return item;
      }
      return {
        ...item,
        text: this.shapeSearchText(typeof item.text === 'string' ? item.text : '', lineCharLimit),
        truncated: item.truncated === true || this.isSearchTextTruncated(item.text, lineCharLimit)
      };
    });
  }

  private shapeSearchText(value: string, lineCharLimit: number): string {
    return value.length <= lineCharLimit
      ? value
      : `${value.slice(0, lineCharLimit)}...`;
  }

  private isSearchTextTruncated(value: unknown, lineCharLimit: number): boolean {
    return typeof value === 'string' && value.length > lineCharLimit;
  }

  private shapeRangeReadToolResult(parsed: Record<string, unknown>, snipForContextPressure: boolean): string {
    const content = typeof parsed.content === 'string' ? parsed.content : '';
    const contentCharLimit = snipForContextPressure ? RANGE_READ_SNIPPED_CONTENT_CHARS : RANGE_READ_SHAPED_CONTENT_CHARS;
    if (content.length <= contentCharLimit) {
      return JSON.stringify(parsed);
    }

    return JSON.stringify({
      ...parsed,
      content: content.slice(0, contentCharLimit),
      truncated: true,
      shapedContentCharLimit: contentCharLimit,
      snippedForContextPressure: snipForContextPressure || undefined
    });
  }

  private parseToolResultObject(content: string): Record<string, unknown> | undefined {
    try {
      const parsed: unknown = JSON.parse(content);
      return this.isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private getToolResultMetadata(parsed: Record<string, unknown> | undefined): {
    path?: string;
    startLine?: number;
    endLine?: number;
    truncated: boolean;
  } {
    if (!parsed) {
      return { truncated: false };
    }

    return {
      path: typeof parsed.path === 'string' ? parsed.path : undefined,
      startLine: readOptionalFiniteNumber(parsed.startLine),
      endLine: readOptionalFiniteNumber(parsed.endLine),
      truncated: parsed.truncated === true
    };
  }

  private isCompressibleToolResult(toolName: string): boolean {
    return toolName !== READ_WORKSPACE_FILE_TOOL_NAME
      && !isDraftEditPreparationTool(toolName)
      && !isDraftRunPreparationTool(toolName);
  }

  private parseToolArguments(rawArguments: string): Record<string, unknown> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArguments || '{}');
    } catch {
      throw new Error('Tool arguments are not valid JSON.');
    }

    if (!this.isRecord(parsed)) {
      throw new Error('Tool arguments must be a JSON object.');
    }

    return parsed;
  }

  private readRequiredString(args: Record<string, unknown>, key: string): string {
    const value = args[key];
    if (typeof value !== 'string') {
      throw new Error(`Tool argument "${key}" must be a string.`);
    }

    if (key !== 'content' && !value.trim()) {
      throw new Error(`Tool argument "${key}" cannot be empty.`);
    }

    return key === 'content' ? value : value.trim();
  }

  private readOptionalString(args: Record<string, unknown>, key: string): string | undefined {
    const value = args[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'string') {
      throw new Error(`Tool argument "${key}" must be a string.`);
    }
    const trimmed = value.trim();
    return trimmed || undefined;
  }

  private readRequiredNumber(args: Record<string, unknown>, key: string): number {
    const value = args[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Tool argument "${key}" must be a finite number.`);
    }
    return value;
  }

  private readOptionalBoolean(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
    const value = args[key];
    if (value === undefined) {
      return fallback;
    }
    if (typeof value !== 'boolean') {
      throw new Error(`Tool argument "${key}" must be a boolean.`);
    }
    return value;
  }

  private readOptionalNumber(args: Record<string, unknown>, key: string): number | undefined {
    const value = args[key];
    if (value === undefined) {
      return undefined;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Tool argument "${key}" must be a number.`);
    }
    return value;
  }

  private readSafeNpmScript(args: Record<string, unknown>, key: string): SafeNpmScript {
    const value = this.readRequiredString(args, key);
    if (value === 'compile' || value === 'lint' || value === 'test') {
      return value;
    }
    throw new Error(`Tool argument "${key}" must be one of: compile, lint, test.`);
  }

  private getRunTimeStopReason(runDeadlineAt: number | undefined): 'run_time_limit_exhausted' | undefined {
    return typeof runDeadlineAt === 'number' && Date.now() >= runDeadlineAt
      ? 'run_time_limit_exhausted'
      : undefined;
  }

  private getFinalMessage(
    content: string | null | undefined,
    draftEdits: DraftEdit[],
    finishReason: string | null | undefined,
    language: KeepseekLanguage,
    runtimeConfig?: AgentRuntimeConfig
  ): string {
    const text = (content ?? '').trim();
    if (text) {
      return text;
    }

    if (draftEdits.length) {
      if (language === 'en') {
        if (draftEdits.length === 1 && draftEdits[0].action === 'delete') {
          return `Prepared a pending deletion for ${draftEdits[0].label}. The file has not been deleted yet.`;
        }
        return draftEdits.length === 1
          ? `Prepared a pending change for ${draftEdits[0].label}.`
          : `Prepared ${draftEdits.length} pending changes in one ChangeSet. Review files separately or use Accept all.`;
      }
      if (draftEdits.length === 1 && draftEdits[0].action === 'delete') {
        return `已为 ${draftEdits[0].label} 准备待确认删除，文件尚未删除。`;
      }
      return draftEdits.length === 1
        ? `已准备 ${draftEdits[0].label} 的待确认修改。`
        : `已准备 ${draftEdits.length} 个待确认修改，并已合并到同一个 ChangeSet；可逐个审核或全部采纳。`;
    }

    if (finishReason === 'content_filter') {
      return language === 'en'
        ? 'DeepSeek filtered the response because of a safety policy, so no displayable reply was generated.'
        : 'DeepSeek 返回内容被安全策略过滤，未生成可展示回复。';
    }

    if (finishReason === 'length') throw new AgentInterruptedError('no_progress_loop', language === 'en'
      ? 'The provider stopped for length without returning resumable content.'
      : 'Provider 因长度停止且未返回可续写内容。');

    if (finishReason === 'run_time_limit_exhausted') {
      return this.getRunTimeLimitError(runtimeConfig?.maxRunMs ?? 0, language);
    }

    return language === 'en' ? 'DeepSeek did not return text content.' : 'DeepSeek 未返回文本内容。';
  }

  private appendBudgetTruncationNotice(content: string, language: KeepseekLanguage): string {
    const notice = language === 'en'
      ? '[Truncated because the automatic output/continuation budget was reached.]'
      : '[由于自动输出/续写预算已达到上限，内容已截断。]';
    return [content.trim(), notice].filter(Boolean).join('\n\n');
  }

  private getBudgetStopMessage(reason: string, draftEdits: DraftEdit[], language: KeepseekLanguage): string {
    const prepared = draftEdits.length
      ? language === 'en'
        ? ` ${draftEdits.length} pending change(s) were preserved for review.`
        : ` 已保留 ${draftEdits.length} 个待审核修改。`
      : '';
    return language === 'en'
      ? `The logical task stopped at its safety budget (${reason}). Completed tool evidence and proposals were preserved.${prepared}`
      : `逻辑任务已在安全预算边界停止（${reason}）。已完成的工具证据和提案均已保留。${prepared}`;
  }

  private decorateRepairMessage(
    message: string,
    state: ReturnType<RepairLoopTracker['getState']>,
    language: KeepseekLanguage
  ): string {
    const text = message.trim();
    if (state.status === 'waiting_for_apply') {
      const notice = language === 'en'
        ? 'Validation is paused. Review and apply the pending ChangeSet, then use “Continue repair validation” to test the real updated workspace.'
        : '验证已暂停。请审核并应用待确认 ChangeSet，然后点击“继续验证修复”，对真实更新后的工作区进行验证。';
      return text.includes(notice) ? text : [text, notice].filter(Boolean).join('\n\n');
    }
    if (state.stopReason === 'repair_iteration_limit') {
      const failure = state.lastFailureSummary ? ` ${state.lastFailureSummary}` : '';
      const notice = language === 'en'
        ? `Automatic repair stopped after reaching the ${state.maxIterations}-iteration limit.${failure}`
        : `自动修复达到 ${state.maxIterations} 轮上限，已停止。${failure}`;
      return [text, notice].filter(Boolean).join('\n\n');
    }
    return text;
  }

  private getRunTimeLimitError(maxRunMs: number, language: KeepseekLanguage): string {
    const seconds = maxRunMs > 0 ? Math.round(maxRunMs / 1000) : 0;
    if (language === 'en') {
      return seconds > 0
        ? `The agent reached the total run-time limit (${seconds} seconds) and stopped this run.`
        : 'The agent reached the total run-time limit and stopped this run.';
    }
    return seconds > 0
      ? `Agent 本次执行达到总时长上限（${seconds} 秒），已停止本次执行。`
      : 'Agent 本次执行达到总时长上限，已停止本次执行。';
  }

  private formatReasoning(parts: string[]): string | undefined {
    const cleaned = parts.map((part) => part.trim()).filter(Boolean);
    if (!cleaned.length) {
      return undefined;
    }

    if (cleaned.length === 1) {
      return cleaned[0];
    }

    return cleaned.map((part, index) => `Step ${index + 1}\n${part}`).join('\n\n');
  }

  private normalizeAssistantToolCalls(
    assistant: DeepSeekAssistantMessage,
    allowToolCalls: boolean,
    allowDsml = true
  ): NormalizedAssistantToolCalls {
    const displayReasoningContent = assistant.reasoning_content;

    if (!allowToolCalls) {
      return {
        assistant: {
          ...assistant,
          tool_calls: null
        },
        displayReasoningContent,
        source: 'native'
      };
    }

    const structuredToolCalls = assistant.tool_calls?.filter((toolCall) => toolCall.type === 'function') ?? [];
    if (structuredToolCalls.length) {
      return { assistant, displayReasoningContent, source: 'native' };
    }

    if (!allowDsml) {
      return { assistant, displayReasoningContent, source: 'native' };
    }

    const parsedDsml = this.dsmlToolParser.parse(assistant.content ?? '');
    if (!parsedDsml?.toolCalls.length) {
      const parsedReasoningDsml = this.dsmlToolParser.parse(assistant.reasoning_content ?? '');
      if (!parsedReasoningDsml?.toolCalls.length) {
        return { assistant, displayReasoningContent, source: 'native' };
      }

      return {
        assistant: {
          ...assistant,
          tool_calls: parsedReasoningDsml.toolCalls
        },
        displayReasoningContent: parsedReasoningDsml.content,
        source: 'dsml'
      };
    }

    return {
      assistant: {
        ...assistant,
        content: parsedDsml.content,
        tool_calls: parsedDsml.toolCalls
      },
      displayReasoningContent,
      source: 'dsml'
    };
  }

  private formatEmulatedDsmlToolResults(results: EmulatedDsmlToolResult[], language: KeepseekLanguage): string {
    const header = language === 'en'
      ? [
          'KeepSeek executed the DSML tool requests emitted in the previous assistant message.',
          'Use these tool results to continue answering the original user request. Do not emit DSML in your next response; use native tool calls if more workspace context is needed.'
        ].join(' ')
      : [
          'KeepSeek 已执行上一条 assistant 消息中输出的 DSML 工具请求。',
          '请使用这些工具结果继续回答用户最初的问题。下一次回复不要输出 DSML；如果还需要更多工作区上下文，请使用原生 tool_calls。'
        ].join('');

    const blocks = results.map((result, index) => [
      `Tool result ${index + 1}: ${result.toolCall.function.name}`,
      `Arguments: ${result.toolCall.function.arguments || '{}'}`,
      'Result:',
      result.content
    ].join('\n'));

    return [header, ...blocks].join('\n\n');
  }

  private appendProviderUserText(state: ProviderNativeRunState | undefined, content: string): void {
    if (state?.protocol === 'openai-responses') {
      const item: OpenAiResponsesItem = { role: 'user', content };
      state.input.push(item);
      state.replayItems.push(item);
    } else if (state?.protocol === 'anthropic-messages') {
      const message: AnthropicMessage = {
        role: 'user',
        content: [{ type: 'text', text: content }]
      };
      state.messages.push(message);
      state.replayMessages.push(message);
    }
  }

  private isToolResultError(content: string): boolean {
    try {
      const parsed: unknown = JSON.parse(content);
      return this.isRecord(parsed) && parsed.ok === false;
    } catch {
      return false;
    }
  }

  private createAnthropicThinkingConfig(
    request: AgentRequest,
    maxTokens: number
  ): Pick<AnthropicMessagesRunState, 'thinking' | 'outputConfig'> {
    if (!request.settings.thinkingEnabled) {
      return {};
    }
    const capabilities = request.model.anthropicCapabilities;
    if (capabilities?.thinking === 'adaptive') {
      return {
        thinking: { type: 'adaptive', display: 'summarized' },
        outputConfig: request.settings.reasoningEffort === 'max'
          && capabilities.effort?.includes('max')
          ? { effort: 'max' }
          : undefined
      };
    }
    if (capabilities?.thinking === 'enabled') {
      const maximumBudget = Math.floor(maxTokens) - 1;
      if (maximumBudget < 1_024) {
        return {};
      }
      const target = request.settings.reasoningEffort === 'max' ? 32_768 : 8_192;
      return {
        thinking: {
          type: 'enabled',
          budget_tokens: Math.min(target, maximumBudget)
        }
      };
    }
    return {};
  }

  private getEvidenceStore(): ToolEvidenceStore {
    this.evidenceStore ??= new ToolEvidenceStore(this.globalStorageUri, getConfiguredEvidenceMaxBytes());
    return this.evidenceStore;
  }

  private async reconcilePersistedEvidence(checkpoint: import('./runCheckpoint').RunCheckpoint, sessionId: string): Promise<void> {
    const executing = checkpoint.state?.pending?.executing;
    if (!executing || !checkpoint.state?.pending) return;
    const store = this.getEvidenceStore();
    const evidence = executing.evidenceRef
      ? await store.findByRef(executing.evidenceRef, sessionId, checkpoint.taskId)
      : await store.findByToolCall(sessionId, checkpoint.taskId, executing.id, checkpoint.state.epoch?.index ?? 0);
    if (!evidence) return;
    if (evidence.executionStatus === 'pending') {
      // The durable intent exists but execution never started.
      checkpoint.state.pending.executing = undefined;
      return;
    }
    if (evidence.executionStatus === 'completed') {
      if (checkpoint.state.epoch) this.upsertEpochEvidenceRef(checkpoint.state.epoch, evidence);
      if (evidence.providerEnvelope !== undefined) checkpoint.state.pending.results[executing.id] = evidence.providerEnvelope;
      checkpoint.state.pending.executing = undefined;
      return;
    }
    if (evidence.effectKind === 'read' || evidence.effectKind === 'proposal') {
      await store.resetReplayableIntent(evidence);
      checkpoint.state.pending.executing = undefined;
      return;
    }
    await store.markUncertain(evidence);
    // executing/uncertain is deliberately left in place. Side effects cannot
    // be proven absent and therefore are never replayed automatically.
  }

  private estimateCurrentProviderInputTokens(
    request: AgentRequest,
    messages: DeepSeekMessage[],
    tools: DeepSeekFunctionTool[],
    providerRunState?: ProviderNativeRunState,
    additionalResponsesItems: OpenAiResponsesItem[] = [],
    additionalAnthropicToolResults: AnthropicUserContentBlock[] = []
  ): number {
    if (providerRunState?.protocol === 'openai-responses') {
      return createContextUsageEstimateFromResponses({
        model: request.model,
        input: [...providerRunState.input, ...additionalResponsesItems],
        tools: providerRunState.tools,
        outputReserveTokens: 0,
        safetyReserveTokens: 0
      }).usedTokensEstimate;
    }
    if (providerRunState?.protocol === 'anthropic-messages') {
      return createContextUsageEstimateFromAnthropic({
        model: request.model,
        system: providerRunState.system,
        messages: additionalAnthropicToolResults.length
          ? [...providerRunState.messages, { role: 'user', content: additionalAnthropicToolResults }]
          : providerRunState.messages,
        tools: providerRunState.tools,
        outputReserveTokens: 0,
        safetyReserveTokens: 0
      }).usedTokensEstimate;
    }
    return createContextUsageEstimateFromMessages({
      model: request.model,
      messages,
      tools,
      outputReserveTokens: 0,
      safetyReserveTokens: 0
    }).usedTokensEstimate;
  }

  private async getPendingEvidenceDeliveryRecords(
    store: ToolEvidenceStore,
    sessionId: string,
    taskId: string,
    refs: Array<{ evidenceRef: string }>
  ): Promise<ToolEvidence[]> {
    const records = await Promise.all(refs.map(async (item) => await store.findByRef(item.evidenceRef, sessionId, taskId)));
    return records.filter((item): item is ToolEvidence => Boolean(item?.providerEnvelope)
      && item!.deliveryStatus !== 'delivered');
  }

  private upsertEpochEvidenceRef(
    epoch: import('./contextEpoch').ContextEpochState,
    evidence: ToolEvidence
  ): void {
    if (!evidence.contentHash) return;
    const item = { evidenceRef: evidence.evidenceRef, contentHash: evidence.contentHash,
      toolName: evidence.toolName, toolCallId: evidence.toolCallId,
      source: evidence.source ? { ...evidence.source } : undefined };
    const index = epoch.evidenceRefs.findIndex((entry) => entry.evidenceRef === evidence.evidenceRef);
    if (index >= 0) epoch.evidenceRefs[index] = item;
    else epoch.evidenceRefs.push(item);
    // Older inventories remain reachable through prior host-state evidence.
    // Bound the live checkpoint itself so durable recovery cannot be defeated
    // by an otherwise healthy task that runs for thousands of tool calls.
    if (epoch.evidenceRefs.length > 4_096) {
      epoch.evidenceRefs.splice(0, epoch.evidenceRefs.length - 4_096);
    }
  }

  private getEvidenceEffectKind(toolName: string): ToolEvidence['effectKind'] {
    if (isDraftEditPreparationTool(toolName) || isDraftRunPreparationTool(toolName)) return 'proposal';
    if (toolName === RUN_VALIDATION_TOOL_NAME) return 'validation';
    if (getSubagentHandoffKind(toolName)) return 'delegation';
    return 'read';
  }

  private async createEpochSemanticSummary(input: {
    request: AgentRequest;
    runtimeConfig: AgentRuntimeConfig;
    messages: DeepSeekMessage[];
    tools: DeepSeekFunctionTool[];
    providerRunState?: ProviderNativeRunState;
    callbacks: AgentRunCallbacks;
    trace: AgentInteractionTrace;
    usageTotals: UpstreamUsageTotals;
    runDeadlineAt?: number;
  }): Promise<string | undefined> {
    const instruction = input.request.language === 'en'
      ? 'Create a concise semantic checkpoint for this same task: objective, completed and remaining work, confirmed facts with paths/lines, evidenceRefs and hashes, failures, and the next best step. Do not call tools. Return plain text only.'
      : '为同一任务生成简洁语义检查点：目标、已完成和未完成工作、带路径/行号的已确认事实、evidenceRef 与 hash、失败尝试和最佳下一步。不要调用工具，只返回纯文本。';
    const summaryMessages = structuredClone(input.messages);
    summaryMessages.push({ role: 'user', content: instruction });
    const summaryProvider = structuredClone(input.providerRunState);
    this.appendProviderUserText(summaryProvider, instruction);
    const summaryAbort = new AbortController();
    const abortFromParent = () => summaryAbort.abort(input.request.signal?.reason);
    if (input.request.signal?.aborted) abortFromParent();
    else input.request.signal?.addEventListener('abort', abortFromParent, { once: true });
    const timeout = setTimeout(() => summaryAbort.abort(new Error('Context Epoch summary timed out.')), 12_000);
    timeout.unref?.();
    try {
      const response = await this.createModelResponse(
        { ...input.request, signal: summaryAbort.signal },
        { ...input.runtimeConfig, maxTokens: Math.min(2_048, input.runtimeConfig.repairMaxOutputTokens) },
        summaryMessages,
        input.tools,
        {
          ...input.callbacks,
          // This is a hidden provider lane. Only its usage/trace is observable;
          // streamed checkpoint prose must never leak into the final transcript.
          onDelta: undefined,
          onStatus: undefined,
          onUsageEstimate: undefined
        },
        input.runDeadlineAt,
        {
          trace: input.trace,
          usageTotals: input.usageTotals,
          usageSource: 'summary',
          toolChoice: 'none',
          providerRunState: summaryProvider
        }
      );
      const content = response.message.content?.trim();
      return content ? content.slice(0, 16_000) : undefined;
    } finally {
      clearTimeout(timeout);
      input.request.signal?.removeEventListener('abort', abortFromParent);
    }
  }

  private async getRuntimeConfig(request: AgentRequest): Promise<AgentRuntimeConfig> {
    const sourceConfig = request.sourceConfig ?? await resolveModelSourceConfig(
      request.model.sourceId,
      this.globalStorageUri,
      {
        language: request.language,
        requireApiKey: false
      }
    );
    // Local/private compatible endpoints may omit keys. Canonical hosted APIs do not.
    if (!sourceConfig.apiKey.trim() && requiresModelSourceApiKey(sourceConfig)) {
      throw new MissingModelSourceApiKeyError(request.language);
    }
    const profile = getAgentRuntimeProfile(request.model, request.settings);
    const maxCost = request.taskCostBudget?.limit ?? mergeCostLimits(
      getConfiguredAgentMaxCost(),
      request.executionLimits?.maxCost
    );
    if (maxCost > 0 && (!sourceConfig.supportsBilling || !getConfiguredModelUsagePricing(request.model.id))) {
      throw new AgentInterruptedError('provider_error', request.language === 'en'
        ? 'The configured Provider cost limit requires a source and model with available usage pricing.'
        : '用户配置的 Provider 费用上限要求当前来源和模型具有可用的用量价格。');
    }

    return {
      sourceId: sourceConfig.sourceId,
      provider: sourceConfig.provider,
      apiKey: sourceConfig.apiKey,
      baseUrl: sourceConfig.baseUrl,
      supportsBilling: sourceConfig.supportsBilling,
      contextWindowTokens: profile.contextWindowTokens,
      maxTokens: profile.maxTokens,
      maxToolIterations: clampRunLimit(profile.maxToolIterations, request.executionLimits?.maxToolIterations),
      maxToolCalls: clampRunLimit(profile.maxToolCalls, request.executionLimits?.maxToolCalls),
      maxRunMs: request.checkpoint?.maxExecutionMs ?? mergeDurations(getConfiguredAgentMaxExecutionMs(), request.executionLimits?.maxRunMs),
      maxCost,
      streamIdleTimeoutMs: getConfiguredStreamIdleTimeoutMs(),
      temperature: profile.temperature,
      topP: profile.topP,
      contextCompression: profile.contextCompression,
      maxRequestRetries: Math.max(0, getConfiguredMaxRequestRetries() - (request.checkpoint?.modelStepRetries ?? 0)),
      requestRetryBaseMs: getConfiguredRequestRetryBaseMs(),
      maxValidationRuns: clampRunLimit(getConfiguredMaxValidationRuns(), request.executionLimits?.maxValidationRuns),
      maxRepairIterations: getConfiguredMaxRepairIterations(),
      maxModelRequests: clampConfiguredLimit(
        getConfiguredAgentMaxModelRequests(Boolean(request.subagentContext)),
        request.executionLimits?.maxModelRequests
      ),
      maxContinuations: clampConfiguredLimit(
        getConfiguredAgentMaxContinuations(), request.executionLimits?.maxContinuations, true),
      maxContextEpochRollovers: clampConfiguredLimit(
        getConfiguredAgentMaxContextEpochRollovers(), request.executionLimits?.maxContextEpochRollovers, true),
      maxUpstreamTokens: clampConfiguredLimit(
        request.subagentContext ? getConfiguredSubagentMaxUpstreamTokens() : getConfiguredAgentMaxTreeUpstreamTokens(),
        request.executionLimits?.maxUpstreamTokens
      ),
      maxTreeUpstreamTokens: clampConfiguredLimit(
        getConfiguredAgentMaxTreeUpstreamTokens(), request.executionLimits?.maxTreeUpstreamTokens),
      toolMaxOutputTokens: Math.min(profile.maxTokens, getConfiguredAgentToolMaxOutputTokens()),
      finalMaxOutputTokens: Math.min(profile.maxTokens, getConfiguredAgentFinalMaxOutputTokens()),
      continuationMaxOutputTokens: Math.min(profile.maxTokens, getConfiguredAgentContinuationMaxOutputTokens()),
      repairMaxOutputTokens: Math.min(profile.maxTokens, getConfiguredAgentRepairMaxOutputTokens())
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  private async tryCreateDraftEdit(prompt: string, language: KeepseekLanguage): Promise<DraftEdit | undefined> {
    const match = /^\/draft\s+([^\n]+)\n([\s\S]+)$/u.exec(prompt.trimEnd());
    if (!match) {
      return undefined;
    }

    const targetPath = match[1]?.trim();
    const newText = match[2] ?? '';
    if (!targetPath || !newText) {
      return undefined;
    }

    const uri = this.workspaceTools.resolveTargetUri(targetPath);
    return await this.createFullTextDraft({
      id: randomUUID(),
      uri: uri.toString(),
      label: this.workspaceTools.getLabel(uri),
      action: await this.getDraftEditAction(uri),
      content: newText,
      reason: language === 'en'
        ? 'Draft edit proposed from the KeepSeek chat panel.'
        : '来自 KeepSeek 对话面板的待确认修改。'
    });
  }

  private async getDraftEditAction(uri: vscode.Uri): Promise<'create' | 'modify'> {
    try {
      await vscode.workspace.fs.stat(uri);
      return 'modify';
    } catch {
      return 'create';
    }
  }

}

export function getToolExposureError(toolName: string, exposedToolNames: ReadonlySet<string>): string | undefined {
  if (exposedToolNames.has(toolName)) return undefined;
  return JSON.stringify({
    ok: false,
    errorType: 'subagent_tool_not_exposed',
    error: 'The requested tool was not exposed in this Provider request and was not executed.',
    toolName
  });
}

/** Stable main-agent entry point retained for provider and test call sites. */
export class AgentRunner extends AgentLoop {}

function withoutDeepSeekReasoningContent(message: DeepSeekMessage): DeepSeekMessage {
  const compatibleMessage = { ...message };
  delete compatibleMessage.reasoning_content;
  return compatibleMessage;
}

function formatReviewerDenial(reason: string, saferAlternative: string | undefined, language: KeepseekLanguage): string {
  return [
    language === 'en'
      ? `The approval reviewer denied this exact operation: ${reason}`
      : `审批模型拒绝了这项精确操作：${reason}`,
    saferAlternative ? (language === 'en' ? `Safer direction: ${saferAlternative}` : `更安全的方向：${saferAlternative}`) : '',
    language === 'en'
      ? 'Do not pursue the same dangerous result through a variant command, indirect execution, or another tool. Submit only a materially safer new operation with a new action hash, or stop and explain if none exists.'
      : '不得通过变体命令、间接执行或其它工具追求相同危险结果。只能提交 actionHash 不同且实质更安全的新操作；没有安全替代方案时应停止并说明。'
  ].filter(Boolean).join(' ');
}

function readFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readDraftEditIds(rawResult: string): string[] {
  try {
    const parsed: unknown = JSON.parse(rawResult);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return [];
    }
    const record = parsed as Record<string, unknown>;
    if (Array.isArray(record.draftEditIds)) {
      return record.draftEditIds.filter((id): id is string => typeof id === 'string' && Boolean(id));
    }
    const draftEdit = record.draftEdit;
    if (!draftEdit || typeof draftEdit !== 'object' || Array.isArray(draftEdit)) {
      return [];
    }
    const id = (draftEdit as Record<string, unknown>).id;
    return typeof id === 'string' && id ? [id] : [];
  } catch {
    return [];
  }
}

function readToolResultErrorType(rawResult: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawResult);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const value = (parsed as Record<string, unknown>).errorType;
    return typeof value === 'string' && value ? value.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

function isGitToolName(toolName: string): boolean {
  return toolName === GIT_STATUS_TOOL_NAME
    || toolName === GIT_DIFF_TOOL_NAME
    || toolName === GIT_CURRENT_BRANCH_TOOL_NAME
    || toolName === GIT_CREATE_PATCH_TOOL_NAME
    || toolName === GIT_SUGGEST_COMMIT_MESSAGE_TOOL_NAME;
}

function hashStableText(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function hashText(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function isFileNotFoundError(error: unknown): boolean {
  if (error instanceof vscode.FileSystemError) {
    return error.code === 'FileNotFound';
  }
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  return code === 'ENOENT' || code === 'FileNotFound';
}

function clampRunLimit(profileLimit: number, requestedLimit: number | undefined): number {
  if (typeof requestedLimit !== 'number' || !Number.isFinite(requestedLimit)) {
    return profileLimit;
  }
  return Math.max(0, Math.min(profileLimit, Math.floor(requestedLimit)));
}

function clampConfiguredLimit(configuredLimit: number, requestedLimit: number | undefined, allowZero = false): number {
  if (typeof requestedLimit !== 'number' || !Number.isFinite(requestedLimit)) return configuredLimit;
  const normalized = Math.floor(requestedLimit);
  if (allowZero && normalized === 0) return 0;
  return normalized > 0 ? Math.min(configuredLimit, normalized) : configuredLimit;
}

function normalizeRepairIterationLimit(requestedLimit: number | undefined): number {
  if (typeof requestedLimit !== 'number' || !Number.isFinite(requestedLimit)) {
    return getConfiguredMaxRepairIterations();
  }
  return Math.max(0, Math.min(10, Math.floor(requestedLimit)));
}

function createFallbackRunDetails(
  runId: string,
  request: AgentRequest,
  taskPlan: TaskPlan,
  traceLogUri?: string,
  error?: unknown
): RunDetailsSummary {
  const now = new Date().toISOString();
  const stopped = error instanceof AgentRunAbortedError || request.signal?.aborted;
  return {
    runId,
    sessionId: request.sessionId,
    assistantMessageId: request.assistantMessageId,
    backgroundRunId: request.backgroundRunId,
    modelId: request.model.id,
    status: stopped ? 'stopped' : error ? 'failed' : taskPlan.status === 'blocked' ? 'blocked' : 'succeeded',
    startedAt: taskPlan.createdAt,
    endedAt: now,
    durationMs: Math.max(0, Date.parse(now) - Date.parse(taskPlan.createdAt)),
    taskPlan: {
      status: taskPlan.status,
      goal: taskPlan.goal,
      updateCount: 0,
      completedSteps: taskPlan.steps.filter((step) => step.status === 'completed' || step.status === 'skipped').length,
      totalSteps: taskPlan.steps.length,
      blockers: [...taskPlan.blockers]
    },
    modelRequests: {
      requestCount: 0,
      messageCount: 0,
      exposedToolCount: 0,
      thinkingEnabled: request.settings.thinkingEnabled
    },
    toolCallCount: 0,
    toolCalls: [],
    authorizations: [],
    changeSets: [],
    validations: [],
    contextSources: request.currentRunContext?.metadata.sources.map((source) => ({ ...source })) ?? [],
    contextDiscarded: request.currentRunContext?.metadata.discarded.map((source) => ({ ...source })) ?? [],
    contextDeduplication: request.currentRunContext
      ? {
          before: request.currentRunContext.metadata.beforeDeduplicationCount,
          after: request.currentRunContext.metadata.afterDeduplicationCount,
          discarded: request.currentRunContext.metadata.discarded.length,
          truncated: request.currentRunContext.metadata.truncated
        }
      : undefined,
    failureReason: error instanceof Error ? error.message : error ? String(error) : undefined,
    traceLogUri,
    truncated: false
  };
}

function formatMessagesForTrace(
  messages: DeepSeekMessage[],
  includeRequestPayload: boolean
): Array<DeepSeekMessage | Record<string, unknown>> {
  if (!includeRequestPayload) {
    return messages.map(summarizeDeepSeekMessage);
  }
  return messages.map((message) => isCurrentRunContextEnvelope(message.content)
    ? summarizeDeepSeekMessage(message)
    : message);
}

function formatRequestBodyForTrace(
  body: DeepSeekChatRequestBody | OpenAiResponsesRequestBody | AnthropicMessagesRequestBody,
  includeRequestPayload: boolean
): DeepSeekChatRequestBody | OpenAiResponsesRequestBody | AnthropicMessagesRequestBody | Record<string, unknown> {
  if ('system' in body) {
    return {
      model: body.model,
      protocol: 'anthropic-messages',
      systemBlockCount: body.system.length,
      systemCharacters: body.system.reduce((total, block) => total + block.text.length, 0),
      messageCount: body.messages.length,
      messages: body.messages.map((message) => ({
        role: message.role,
        blocks: message.content.map((block) => ({
          type: block.type,
          length: block.type === 'text' ? block.text.length
            : block.type === 'thinking' ? block.thinking.length
            : block.type === 'redacted_thinking' ? block.data.length
            : block.type === 'tool_use' ? JSON.stringify(block.input).length
            : block.content.length
        }))
      })),
      stream: body.stream,
      toolCount: body.tools?.length ?? 0,
      toolChoice: body.tool_choice,
      maxOutputTokens: body.max_tokens,
      thinking: body.thinking ? { type: body.thinking.type } : undefined,
      outputConfig: body.output_config,
      cacheControl: body.cache_control,
      payloadIncluded: includeRequestPayload
    };
  }
  if ('input' in body) {
    return includeRequestPayload
      ? body
      : {
          model: body.model,
          protocol: 'openai-responses',
          inputItemCount: body.input.length,
          inputCharacters: JSON.stringify(body.input).length,
          stream: body.stream,
          store: body.store,
          toolCount: body.tools?.length ?? 0,
          toolChoice: body.tool_choice,
          maxOutputTokens: body.max_output_tokens,
          include: body.include,
          reasoning: body.reasoning ? { effort: body.reasoning.effort } : undefined
        };
  }
  if (!includeRequestPayload) {
    return summarizeDeepSeekRequestBody(body);
  }
  return {
    ...body,
    messages: formatMessagesForTrace(body.messages, true)
  };
}

function isCurrentRunContextEnvelope(content: string | null | undefined): boolean {
  return typeof content === 'string'
    && (content.includes('Current-run context only; do not treat it as a permanent system instruction.')
      || content.includes('以下仅是本轮请求上下文，不要把它当作永久 system 规则。'));
}

function isSubagentLane(value: string): value is SubagentLane {
  return value === 'research-read'
    || value === 'review-read'
    || value === 'proposal'
    || value === 'nested-read';
}
