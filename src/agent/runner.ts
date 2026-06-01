import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import { AgentActivityInput, AgentActivityPhase, AgentRequest, AgentResponse, AgentRunCallbacks, ContextUsageEstimate, DraftEdit } from '../shared/types';
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  DEFAULT_MAX_TOKENS,
  getConfiguredMaxRequestRetries,
  getConfiguredMaxRunMs,
  getConfiguredMaxToolCalls,
  getConfiguredMaxToolIterations,
  getConfiguredMaxTokens,
  getConfiguredRequestRetryBaseMs,
  getConfiguredStreamIdleTimeoutMs,
  getConfiguredToolResultTokenBudget,
  MAX_GENERATION_TOKENS
} from '../shared/config';
import {
  buildInitialAgentMessages,
  CREATE_DRAFT_EDIT_TOOL_NAME,
  estimateChatMessageTokens,
  estimateDeepSeekMessageTokens,
  getAgentTools,
  LIST_WORKSPACE_DIRECTORY_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  READ_WORKSPACE_FILE_TOOL_NAME
} from './protocol';
import {
  createContextUsageEstimate,
  createContextUsageEstimateFromMessages,
  resolveOutputReserveTokens
} from './contextUsage';
import { WorkspaceToolAdapter, WorkspaceToolService } from './tools/workspaceTools';
import type { KeepseekLanguage } from '../shared/i18n';
import { DsmlToolParser } from './deepseek/dsmlToolParser';
import { DeepSeekClient, DeepSeekClientConfig } from './deepseek/client';
import {
  DeepSeekAssistantMessage,
  DeepSeekChatRequestBody,
  DeepSeekFunctionTool,
  DeepSeekMessage,
  DeepSeekStreamResult,
  DeepSeekToolCall
} from './deepseek/types';

export { AGENT_HISTORY_MESSAGE_LIMIT } from '../shared/config';
export { DEFAULT_MAX_TOKENS, MAX_GENERATION_TOKENS };

const CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS = 16_000;
const MAX_LENGTH_CONTINUATION_REQUESTS = 1;

interface AgentRuntimeConfig {
  apiKey: string;
  baseUrl: string;
  maxTokens: number;
  maxToolIterations: number;
  maxToolCalls: number;
  maxRunMs: number;
  toolResultTokenBudget: number;
  streamIdleTimeoutMs: number;
  maxRequestRetries: number;
  requestRetryBaseMs: number;
}

type AgentBudgetFinishReason =
  | 'tool_iterations_exhausted'
  | 'tool_call_limit_exhausted'
  | 'tool_result_budget_exhausted'
  | 'run_time_limit_exhausted';

interface NormalizedAssistantToolCalls {
  assistant: DeepSeekAssistantMessage;
  displayReasoningContent?: string | null;
  source: 'native' | 'dsml';
}

interface EmulatedDsmlToolResult {
  toolCall: DeepSeekToolCall;
  content: string;
}

export class AgentRunAbortedError extends Error {
  public constructor(language: KeepseekLanguage) {
    super(language === 'en' ? 'Agent run was stopped.' : 'Agent 推理已中止。');
    this.name = 'AgentRunAbortedError';
  }
}

export class AgentRunner {
  private readonly dsmlToolParser = new DsmlToolParser();
  private readonly deepSeekClient = new DeepSeekClient();

  public constructor(private readonly workspaceTools: WorkspaceToolAdapter = new WorkspaceToolService()) {}

  public async run(request: AgentRequest, callbacks: AgentRunCallbacks = {}): Promise<AgentResponse> {
    this.throwIfAborted(request.signal, request.language);
    const emitStatus = this.createStatusEmitter(callbacks);
    const runCallbacks: AgentRunCallbacks = {
      ...callbacks,
      onStatus: emitStatus
    };
    const draftEdit = await this.tryCreateDraftEdit(request.prompt, request.language);
    this.throwIfAborted(request.signal, request.language);
    if (draftEdit) {
      emitStatus({
        base: 'executing',
        phase: 'creating_draft_edit',
        toolName: CREATE_DRAFT_EDIT_TOOL_NAME
      });
      emitStatus({
        base: 'thinking',
        phase: 'finalizing'
      });
      return {
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
      };
    }

    const runtimeConfig = this.getRuntimeConfig(request.language);
    const messages = buildInitialAgentMessages(request);
    const tools = getAgentTools();
    const draftEdits: DraftEdit[] = [];
    const reasoningParts: string[] = [];
    const maxIterations = Math.max(0, runtimeConfig.maxToolIterations);
    const runStartedAt = Date.now();
    const runDeadlineAt = runtimeConfig.maxRunMs > 0 ? runStartedAt + runtimeConfig.maxRunMs : undefined;
    const maxToolResultTokens = runtimeConfig.toolResultTokenBudget > 0
      ? runtimeConfig.toolResultTokenBudget
      : Number.POSITIVE_INFINITY;
    const outputReserveTokens = resolveOutputReserveTokens(runtimeConfig.maxTokens);
    const runtimeUsageBreakdown = {
      ...createContextUsageEstimate({
        model: request.model,
        contextFiles: request.contextFiles,
        messages: request.history,
        language: request.language,
        prompt: request.prompt,
        includeTools: maxIterations > 0,
        outputReserveTokens,
        safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS
      }).breakdown
    };
    const emitUsageEstimate = (toolsForNextRequest: DeepSeekFunctionTool[]) => {
      callbacks.onUsageEstimate?.(createContextUsageEstimateFromMessages({
        model: request.model,
        messages,
        tools: toolsForNextRequest,
        outputReserveTokens,
        safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS,
        breakdown: {
          ...runtimeUsageBreakdown,
          toolSchemaTokensEstimate: undefined
        }
      }));
    };
    let toolCallCount = 0;
    let toolResultTokens = 0;
    let budgetStopReason: AgentBudgetFinishReason | undefined;
    let budgetStopInstructionQueued = false;
    const queueBudgetStopInstruction = () => {
      if (!budgetStopReason || budgetStopInstructionQueued) {
        return;
      }
      const budgetInstructionMessage: DeepSeekMessage = {
        role: 'user',
        content: this.getBudgetStopInstruction(budgetStopReason, request.language)
      };
      messages.push(budgetInstructionMessage);
      runtimeUsageBreakdown.inputTokensEstimate += estimateDeepSeekMessageTokens(budgetInstructionMessage);
      budgetStopInstructionQueued = true;
      emitUsageEstimate([]);
    };

    emitUsageEstimate(maxIterations > 0 ? tools : []);

    for (let turn = 0; turn <= maxIterations; turn += 1) {
      this.throwIfAborted(request.signal, request.language);
      const runTimeStopReason = this.getRunTimeStopReason(runDeadlineAt);
      if (runTimeStopReason) {
        emitStatus({
          base: 'thinking',
          phase: 'finalizing'
        });
        return {
          message: this.getFinalMessage(null, draftEdits, runTimeStopReason, request.language, runtimeConfig),
          reasoningContent: this.formatReasoning(reasoningParts),
          draftEdits
        };
      }

      if (!budgetStopReason && turn >= maxIterations) {
        budgetStopReason = 'tool_iterations_exhausted';
      }
      queueBudgetStopInstruction();
      const toolsForTurn = !budgetStopReason && turn < maxIterations ? tools : [];
      emitUsageEstimate(toolsForTurn);
      const response = await this.createChatCompletion(request, runtimeConfig, messages, toolsForTurn, runCallbacks, runDeadlineAt);
      this.throwIfAborted(request.signal, request.language);
      const normalizedAssistant = this.normalizeAssistantToolCalls(response.message, toolsForTurn.length > 0);
      const assistant = normalizedAssistant.assistant;
      if (!assistant) {
        throw new Error(request.language === 'en'
          ? 'DeepSeek API did not return a usable assistant message.'
          : 'DeepSeek API 没有返回可用的 assistant message。');
      }

      if (normalizedAssistant.displayReasoningContent) {
        reasoningParts.push(normalizedAssistant.displayReasoningContent);
      }

      const toolCalls = assistant.tool_calls?.filter((toolCall) => toolCall.type === 'function') ?? [];
      if (!toolCalls.length) {
        const continuedResponse = await this.tryContinueLengthLimitedResponse({
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
          runtimeUsageBreakdown
        });
        if (continuedResponse) {
          emitStatus({
            base: 'thinking',
            phase: 'finalizing'
          });
          return {
            message: this.getFinalMessage(continuedResponse.content, draftEdits, continuedResponse.finishReason, request.language, runtimeConfig),
            reasoningContent: this.formatReasoning(reasoningParts),
            draftEdits
          };
        }

        emitStatus({
          base: 'thinking',
          phase: 'finalizing'
        });
        const finalFinishReason = response.finishReason === 'length'
          ? response.finishReason
          : budgetStopReason ?? response.finishReason;
        return {
          message: this.getFinalMessage(assistant.content, draftEdits, finalFinishReason, request.language, runtimeConfig),
          reasoningContent: this.formatReasoning(reasoningParts),
          draftEdits
        };
      }

      emitStatus({
        base: 'thinking',
        phase: 'planning_tool'
      });

      const executeToolCall = async (toolCall: DeepSeekToolCall): Promise<string> => {
        this.throwIfAborted(request.signal, request.language);
        if (budgetStopReason) {
          return this.createBudgetToolResult(budgetStopReason, request.language);
        }

        if (runtimeConfig.maxToolCalls > 0 && toolCallCount >= runtimeConfig.maxToolCalls) {
          budgetStopReason = 'tool_call_limit_exhausted';
          return this.createBudgetToolResult(budgetStopReason, request.language, {
            toolCallCount,
            maxToolCalls: runtimeConfig.maxToolCalls
          });
        }

        toolCallCount += 1;
        emitStatus({
          base: 'executing',
          phase: this.getToolActivityPhase(toolCall.function.name),
          toolName: toolCall.function.name
        });
        const rawToolResult = await this.handleToolCall(toolCall, draftEdits, request.language);
        this.throwIfAborted(request.signal, request.language);
        const rawToolMessage: DeepSeekMessage = {
          role: 'tool',
          tool_call_id: toolCall.id,
          content: rawToolResult
        };
        const nextToolResultTokens = estimateDeepSeekMessageTokens(rawToolMessage);
        const nextToolsForRequest = turn + 1 < maxIterations ? tools : [];
        if (toolResultTokens + nextToolResultTokens > maxToolResultTokens) {
          budgetStopReason = 'tool_result_budget_exhausted';
          return this.createBudgetToolResult(budgetStopReason, request.language, {
            usedTokens: toolResultTokens,
            nextTokens: nextToolResultTokens,
            maxTokens: Number.isFinite(maxToolResultTokens) ? maxToolResultTokens : 0
          });
        }

        if (this.getContextWindowBudgetStopReason(request, [...messages, rawToolMessage], nextToolsForRequest, outputReserveTokens)) {
          budgetStopReason = 'tool_result_budget_exhausted';
          const projectedUsage = createContextUsageEstimateFromMessages({
            model: request.model,
            messages: [...messages, rawToolMessage],
            tools: nextToolsForRequest,
            outputReserveTokens,
            safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS
          });
          return this.createBudgetToolResult(budgetStopReason, request.language, {
            usedTokens: projectedUsage.usedTokensEstimate,
            nextTokens: nextToolResultTokens,
            maxTokens: projectedUsage.maxTokensEstimate
          });
        }

        toolResultTokens += nextToolResultTokens;
        budgetStopReason = budgetStopReason ?? this.getRunTimeStopReason(runDeadlineAt);
        return rawToolResult;
      };

      if (normalizedAssistant.source === 'native') {
        const assistantToolCallMessage: DeepSeekMessage = {
          role: 'assistant',
          content: assistant.content ?? null,
          reasoning_content: assistant.reasoning_content ?? null,
          tool_calls: toolCalls
        };
        messages.push(assistantToolCallMessage);
        runtimeUsageBreakdown.toolCallTokensEstimate += estimateChatMessageTokens('assistant', [
          assistant.content ?? '',
          JSON.stringify(toolCalls)
        ].join('\n'));
        if (assistant.reasoning_content) {
          runtimeUsageBreakdown.reasoningTokensEstimate += estimateChatMessageTokens('assistant', assistant.reasoning_content);
        }
        emitUsageEstimate(toolsForTurn);

        for (const toolCall of toolCalls) {
          const toolResult = await executeToolCall(toolCall);
          const toolMessage: DeepSeekMessage = {
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult
          };
          messages.push(toolMessage);
          runtimeUsageBreakdown.toolResultTokensEstimate += estimateDeepSeekMessageTokens(toolMessage);
          emitUsageEstimate(budgetStopReason ? [] : turn + 1 < maxIterations ? tools : []);
          emitStatus({
            base: 'thinking',
            phase: 'reviewing_tool_result',
            toolName: toolCall.function.name
          });
        }
      } else {
        if (assistant.content?.trim()) {
          const assistantTextMessage: DeepSeekMessage = {
            role: 'assistant',
            content: assistant.content.trim()
          };
          messages.push(assistantTextMessage);
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
        runtimeUsageBreakdown.toolResultTokensEstimate += estimateDeepSeekMessageTokens(emulatedToolResultMessage);
        emitUsageEstimate(budgetStopReason ? [] : turn + 1 < maxIterations ? tools : []);
      }

      queueBudgetStopInstruction();
    }

    emitStatus({
      base: 'thinking',
      phase: 'finalizing'
    });
    return {
      message: this.getFinalMessage(null, draftEdits, 'tool_iterations_exhausted', request.language, runtimeConfig),
      reasoningContent: this.formatReasoning(reasoningParts),
      draftEdits
    };
  }

  private async createChatCompletion(
    request: AgentRequest,
    runtimeConfig: AgentRuntimeConfig,
    messages: DeepSeekMessage[],
    tools: DeepSeekFunctionTool[],
    callbacks: AgentRunCallbacks,
    runDeadlineAt?: number,
    options: { allowPartialRecovery?: boolean } = {}
  ): Promise<DeepSeekStreamResult> {
    const body: DeepSeekChatRequestBody = {
      model: request.model.id,
      messages,
      stream: true,
      thinking: {
        type: request.settings.thinkingEnabled ? 'enabled' : 'disabled'
      },
      tools: tools.length ? tools : undefined,
      tool_choice: tools.length ? 'auto' : undefined
    };

    if (request.settings.thinkingEnabled) {
      body.reasoning_effort = request.settings.reasoningEffort;
    }

    if (runtimeConfig.maxTokens > 0) {
      body.max_tokens = runtimeConfig.maxTokens;
    }

    body.stream_options = {
      include_usage: true
    };

    const response = await this.deepSeekClient.createChatCompletion(this.toDeepSeekClientConfig(runtimeConfig), {
      body,
      language: request.language,
      signal: request.signal,
      callbacks,
      runDeadlineAt
    });

    if (response.ok && response.message) {
      return {
        message: response.message,
        finishReason: response.finishReason,
        usage: response.usage
      };
    }

    if (response.failureKind === 'external_abort') {
      throw new AgentRunAbortedError(request.language);
    }
    if (response.failureKind === 'run_time_limit') {
      throw new Error(this.getRunTimeLimitError(runtimeConfig.maxRunMs, request.language));
    }
    if (options.allowPartialRecovery !== false && response.hadPartialOutput && response.message?.content?.trim()) {
      return await this.createContinuationAfterPartialFailure({
        request,
        runtimeConfig,
        messages,
        partialAssistant: response.message,
        failureError: response.error,
        callbacks,
        runDeadlineAt
      });
    }

    throw new Error(response.error ?? (request.language === 'en'
      ? 'DeepSeek API request failed.'
      : 'DeepSeek API 请求失败。'));
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
  }): Promise<{ content: string; finishReason?: string | null } | undefined> {
    if (!this.canContinueLengthLimitedResponse(input)) {
      return undefined;
    }

    let content = input.assistant.content ?? '';
    let finishReason = input.response.finishReason;
    for (let continuationIndex = 0; continuationIndex < MAX_LENGTH_CONTINUATION_REQUESTS; continuationIndex += 1) {
      const assistantMessage: DeepSeekMessage = {
        role: 'assistant',
        content
      };
      const instructionMessage: DeepSeekMessage = {
        role: 'user',
        content: this.getLengthContinuationInstruction(input.request.language)
      };
      const continuationMessages = [
        ...input.messages,
        assistantMessage,
        instructionMessage
      ];

      if (this.getContextWindowBudgetStopReason(input.request, continuationMessages, [], input.outputReserveTokens)) {
        return continuationIndex > 0 ? { content, finishReason } : undefined;
      }

      input.messages.push(assistantMessage, instructionMessage);
      input.runtimeUsageBreakdown.inputTokensEstimate +=
        estimateDeepSeekMessageTokens(assistantMessage) + estimateDeepSeekMessageTokens(instructionMessage);

      const continuationResponse = await this.createChatCompletion(
        input.request,
        input.runtimeConfig,
        input.messages,
        [],
        input.callbacks,
        input.runDeadlineAt,
        { allowPartialRecovery: false }
      );
      const normalizedContinuation = this.normalizeAssistantToolCalls(continuationResponse.message, false);
      if (normalizedContinuation.displayReasoningContent) {
        input.reasoningParts.push(normalizedContinuation.displayReasoningContent);
      }
      const continuationContent = normalizedContinuation.assistant.content ?? '';
      content = this.joinContinuationContent(content, continuationContent);
      finishReason = continuationResponse.finishReason;

      if (finishReason !== 'length' || !continuationContent.trim()) {
        break;
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
  }): boolean {
    if (input.response.finishReason !== 'length') {
      return false;
    }
    if (input.draftEdits.length) {
      return false;
    }
    if (!input.assistant.content?.trim()) {
      return false;
    }
    if (input.assistant.tool_calls?.some((toolCall) => toolCall.type === 'function')) {
      return false;
    }

    const continuationMessages: DeepSeekMessage[] = [
      ...input.messages,
      {
        role: 'assistant',
        content: input.assistant.content
      },
      {
        role: 'user',
        content: this.getLengthContinuationInstruction(input.request.language)
      }
    ];
    return !this.getContextWindowBudgetStopReason(input.request, continuationMessages, [], input.outputReserveTokens);
  }

  private async createContinuationAfterPartialFailure(input: {
    request: AgentRequest;
    runtimeConfig: AgentRuntimeConfig;
    messages: DeepSeekMessage[];
    partialAssistant: DeepSeekAssistantMessage;
    failureError?: string;
    callbacks: AgentRunCallbacks;
    runDeadlineAt?: number;
  }): Promise<DeepSeekStreamResult> {
    const partialContent = input.partialAssistant.content ?? '';
    if (!partialContent.trim()) {
      throw new Error(input.failureError ?? (input.request.language === 'en'
        ? 'DeepSeek streaming connection failed before completion.'
        : 'DeepSeek 流式连接在完成前中断。'));
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
    const outputReserveTokens = resolveOutputReserveTokens(input.runtimeConfig.maxTokens);
    if (this.getContextWindowBudgetStopReason(input.request, continuationMessages, [], outputReserveTokens)) {
      throw new Error(input.failureError ?? (input.request.language === 'en'
        ? 'DeepSeek streaming connection failed before completion, and there was not enough context budget to request a continuation.'
        : 'DeepSeek 流式连接在完成前中断，且上下文预算不足，无法请求续写。'));
    }

    const continuationResponse = await this.createChatCompletion(
      input.request,
      input.runtimeConfig,
      continuationMessages,
      [],
      input.callbacks,
      input.runDeadlineAt,
      { allowPartialRecovery: false }
    );
    const normalizedContinuation = this.normalizeAssistantToolCalls(continuationResponse.message, false);
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

  private toDeepSeekClientConfig(runtimeConfig: AgentRuntimeConfig): DeepSeekClientConfig {
    return {
      apiKey: runtimeConfig.apiKey,
      baseUrl: runtimeConfig.baseUrl,
      streamIdleTimeoutMs: runtimeConfig.streamIdleTimeoutMs,
      maxRequestRetries: runtimeConfig.maxRequestRetries,
      requestRetryBaseMs: runtimeConfig.requestRetryBaseMs
    };
  }

  private throwIfAborted(signal: AbortSignal | undefined, language: KeepseekLanguage): void {
    if (signal?.aborted) {
      throw new AgentRunAbortedError(language);
    }
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
      case READ_WORKSPACE_FILE_TOOL_NAME:
        return 'reading_file';
      case CREATE_DRAFT_EDIT_TOOL_NAME:
        return 'creating_draft_edit';
      default:
        return 'executing_tool';
    }
  }

  private async handleToolCall(toolCall: DeepSeekToolCall, draftEdits: DraftEdit[], language: KeepseekLanguage): Promise<string> {
    try {
      const args = this.parseToolArguments(toolCall.function.arguments);
      switch (toolCall.function.name) {
        case LIST_WORKSPACE_FILES_TOOL_NAME:
          return await this.workspaceTools.listWorkspaceFiles(language);
        case LIST_WORKSPACE_DIRECTORY_TOOL_NAME:
          return await this.workspaceTools.listWorkspaceDirectory(
            this.readRequiredString(args, 'path'),
            this.readOptionalBoolean(args, 'recursive', false),
            this.readOptionalNumber(args, 'maxFiles'),
            language
          );
        case READ_WORKSPACE_FILE_TOOL_NAME:
          return await this.workspaceTools.readWorkspaceFile(this.readRequiredString(args, 'path'), language);
        case CREATE_DRAFT_EDIT_TOOL_NAME:
          return await this.createDraftEdit(args, draftEdits);
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

  private async createDraftEdit(args: Record<string, unknown>, draftEdits: DraftEdit[]): Promise<string> {
    const rawPath = this.readRequiredString(args, 'path');
    const content = this.readRequiredString(args, 'content');
    const reason = this.readRequiredString(args, 'reason');
    const uri = this.workspaceTools.resolveTargetUri(rawPath);
    const draftEdit: DraftEdit = {
      id: randomUUID(),
      uri: uri.toString(),
      label: this.workspaceTools.getLabel(uri),
      action: await this.getDraftEditAction(uri),
      newText: content,
      reason
    };

    draftEdits.push(draftEdit);
    return JSON.stringify({
      ok: true,
      draftEdit: {
        id: draftEdit.id,
        label: draftEdit.label
      },
      message: 'Draft edit created. Tell the user they can review and apply it from the KeepSeek panel.'
    });
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

  private getContextWindowBudgetStopReason(
    request: AgentRequest,
    messages: DeepSeekMessage[],
    tools: DeepSeekFunctionTool[],
    outputReserveTokens: number
  ): AgentBudgetFinishReason | undefined {
    const usage = createContextUsageEstimateFromMessages({
      model: request.model,
      messages,
      tools,
      outputReserveTokens,
      safetyReserveTokens: CONTEXT_BUDGET_SAFETY_RESERVE_TOKENS
    });
    return usage.usedTokensEstimate > usage.maxTokensEstimate ? 'tool_result_budget_exhausted' : undefined;
  }

  private getRunTimeStopReason(runDeadlineAt: number | undefined): AgentBudgetFinishReason | undefined {
    return typeof runDeadlineAt === 'number' && Date.now() >= runDeadlineAt
      ? 'run_time_limit_exhausted'
      : undefined;
  }

  private createBudgetToolResult(
    reason: AgentBudgetFinishReason,
    language: KeepseekLanguage,
    details: Record<string, number> = {}
  ): string {
    return JSON.stringify({
      ok: false,
      error: this.getBudgetToolError(reason, language),
      budgetReason: reason,
      ...details
    });
  }

  private getBudgetToolError(reason: AgentBudgetFinishReason, language: KeepseekLanguage): string {
    switch (reason) {
      case 'tool_call_limit_exhausted':
        return language === 'en'
          ? 'The KeepSeek tool-call budget was reached. Stop calling tools and answer from the available context.'
          : 'KeepSeek 工具调用总数预算已达上限。请停止调用工具，并基于已有上下文回答。';
      case 'tool_result_budget_exhausted':
        return language === 'en'
          ? 'The KeepSeek tool-result token budget was reached. Stop calling tools and answer from the available context.'
          : 'KeepSeek 工具结果 token 预算已达上限。请停止调用工具，并基于已有上下文回答。';
      case 'run_time_limit_exhausted':
        return language === 'en'
          ? 'The KeepSeek total run-time budget was reached. Stop calling tools and answer from the available context.'
          : 'KeepSeek 本次执行总时长预算已达上限。请停止调用工具，并基于已有上下文回答。';
      case 'tool_iterations_exhausted':
      default:
        return language === 'en'
          ? 'The KeepSeek tool-iteration budget was reached. Stop calling tools and answer from the available context.'
          : 'KeepSeek 工具调用轮次预算已达上限。请停止调用工具，并基于已有上下文回答。';
    }
  }

  private getBudgetStopInstruction(reason: AgentBudgetFinishReason, language: KeepseekLanguage): string {
    const error = this.getBudgetToolError(reason, language);
    return language === 'en'
      ? `${error} Do not emit function calls or DSML tool calls in the next response. Provide the best concise result using the information already gathered, and mention any remaining gap.`
      : `${error} 下一次回复不要输出 function call 或 DSML 工具调用。请使用已经收集到的信息给出尽量完整、简洁的结果，并说明仍缺少的信息。`;
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
      return finishReason === 'length'
        ? `${text}\n\n${this.getLengthLimitMessage(language, runtimeConfig?.maxTokens)}`
        : text;
    }

    if (draftEdits.length) {
      if (language === 'en') {
        return draftEdits.length === 1
          ? `Prepared a pending change for ${draftEdits[0].label}.`
          : `Prepared ${draftEdits.length} pending changes.`;
      }
      return draftEdits.length === 1
        ? `已准备 ${draftEdits[0].label} 的待确认修改。`
        : `已准备 ${draftEdits.length} 个待确认修改。`;
    }

    if (finishReason === 'content_filter') {
      return language === 'en'
        ? 'DeepSeek filtered the response because of a safety policy, so no displayable reply was generated.'
        : 'DeepSeek 返回内容被安全策略过滤，未生成可展示回复。';
    }

    if (finishReason === 'length') {
      return this.getLengthLimitMessage(language, runtimeConfig?.maxTokens);
    }

    if (finishReason === 'tool_iterations_exhausted') {
      return language === 'en'
        ? 'The agent reached the tool iteration limit and stopped this run. Increase keepseek.maxToolIterations if this task needs more workspace exploration.'
        : 'Agent 工具调用轮次已达上限，已停止本次执行。若本次任务需要更多工程探索，可以提高 keepseek.maxToolIterations。';
    }

    if (finishReason === 'tool_call_limit_exhausted') {
      return language === 'en'
        ? 'The agent reached the total tool-call limit and stopped this run. Increase keepseek.maxToolCalls if this task needs broader workspace exploration.'
        : 'Agent 工具调用总数已达上限，已停止本次执行。若本次任务需要更大范围的工程探索，可以提高 keepseek.maxToolCalls。';
    }

    if (finishReason === 'tool_result_budget_exhausted') {
      return language === 'en'
        ? 'The agent reached the tool-result token budget and stopped this run. Increase keepseek.toolResultTokenBudget, or leave it at 0 to use the automatic context-window budget.'
        : 'Agent 工具结果 token 预算已达上限，已停止本次执行。可以提高 keepseek.toolResultTokenBudget，或设为 0 使用基于上下文窗口的自动预算。';
    }

    if (finishReason === 'run_time_limit_exhausted') {
      return this.getRunTimeLimitError(0, language);
    }

    return language === 'en' ? 'DeepSeek did not return text content.' : 'DeepSeek 未返回文本内容。';
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

  private getLengthLimitMessage(language: KeepseekLanguage, maxTokens?: number): string {
    const budgetHint = typeof maxTokens === 'number' && maxTokens > 0
      ? (language === 'en' ? ` Current keepseek.maxTokens: ${maxTokens}.` : `当前 keepseek.maxTokens：${maxTokens}。`)
      : (language === 'en' ? ' keepseek.maxTokens is omitted, so the provider default applies.' : '当前未发送 keepseek.maxTokens，使用服务商默认输出预算。');
    return language === 'en'
      ? `DeepSeek returned finish_reason=length, which means the provider considers the generation budget exhausted before the reply was complete. Thinking/reasoning tokens may count toward that budget, so the visible answer can look shorter than expected.${budgetHint} Increase keepseek.maxTokens if the provider supports it, reduce reasoning effort, disable Thinking, or shrink context and try again.`
      : `DeepSeek 返回 finish_reason=length，表示服务商认为本次生成预算已耗尽，回复尚未完整。Thinking/reasoning token 可能也计入这个预算，所以可见正文不一定很长。${budgetHint}如果服务商支持，可以提高 keepseek.maxTokens；也可以降低推理强度、关闭 Thinking，或缩小上下文后重试。`;
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
    allowToolCalls: boolean
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

  private getRuntimeConfig(language: KeepseekLanguage): AgentRuntimeConfig {
    const config = vscode.workspace.getConfiguration('keepseek');
    const apiKey = (config.get<string>('apiKey', '').trim() || process.env.DEEPSEEK_API_KEY || '').trim();
    if (!apiKey) {
      throw new Error(language === 'en'
        ? 'Save a DeepSeek API Key in KeepSeek Settings > Api Key, or set the DEEPSEEK_API_KEY environment variable.'
        : '请先在 KeepSeek 设置 > Api Key 中保存 DeepSeek API Key，或设置 DEEPSEEK_API_KEY 环境变量。');
    }

    return {
      apiKey,
      baseUrl: config.get<string>('baseUrl', DEFAULT_DEEPSEEK_BASE_URL).trim() || DEFAULT_DEEPSEEK_BASE_URL,
      maxTokens: getConfiguredMaxTokens(),
      maxToolIterations: getConfiguredMaxToolIterations(),
      maxToolCalls: getConfiguredMaxToolCalls(),
      maxRunMs: getConfiguredMaxRunMs(),
      toolResultTokenBudget: getConfiguredToolResultTokenBudget(),
      streamIdleTimeoutMs: getConfiguredStreamIdleTimeoutMs(),
      maxRequestRetries: getConfiguredMaxRequestRetries(),
      requestRetryBaseMs: getConfiguredRequestRetryBaseMs()
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
    return {
      id: randomUUID(),
      uri: uri.toString(),
      label: this.workspaceTools.getLabel(uri),
      action: await this.getDraftEditAction(uri),
      newText,
      reason: language === 'en'
        ? 'Draft edit proposed from the KeepSeek chat panel.'
        : '来自 KeepSeek 对话面板的待确认修改。'
    };
  }

  private async getDraftEditAction(uri: vscode.Uri): Promise<DraftEdit['action']> {
    try {
      await vscode.workspace.fs.stat(uri);
      return 'modify';
    } catch {
      return 'create';
    }
  }

}
