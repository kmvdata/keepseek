import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  DEFAULT_DEEPSEEK_BASE_URL,
  getConfiguredContextWindowTokens,
  getConfiguredModelUsagePricing,
  getConfiguredRequestRetryBaseMs
} from '../shared/config';
import {
  getDeepSeekV4ContextCompressionSettings,
  type ContextCompressionSettings
} from '../shared/modelProfiles';
import { getErrorMessage } from '../shared/errors';
import type { KeepseekLanguage } from '../shared/i18n';
import type {
  ChatMessage,
  ChatSession,
  ContextCompressionState,
  ContextFile,
  HistorySummary,
  KeepseekModel,
  AgentSettings,
  CurrentRunContext,
  UsageEvent,
  UsageSource
} from '../shared/types';
import { DeepSeekClient, type DeepSeekClientConfig } from './deepseek/client';
import type { DeepSeekChatRequestBody, DeepSeekMessage } from './deepseek/types';
import {
  CONTEXT_COMPRESSION_VERSION,
  buildHistoryProjection,
  getDurableProtectedMessageIds
} from './historyProjection';
import { estimateTokenCount } from './tokenEstimate';
import { buildProviderRequestProjection } from './providerRequestProjection';
import { estimateDeepSeekMessageTokens, estimateDeepSeekToolsTokens } from './protocol';
import { calculateUsageCost, createUsageEvent, normalizeDeepSeekUsage } from './usageStats';

const SUMMARY_MAX_INPUT_CHARS = 90_000;
// Deliberately high: every summary refresh rewrites the synthetic summary message and
// drops covered messages from the projection, which invalidates DeepSeek's prefix
// cache from the summary message onward. Keep refreshes rare (a low-frequency
// cache-invalidation point) instead of sliding the recent-turn window every turn.
const SUMMARY_INCREMENTAL_MESSAGE_THRESHOLD = 48;

export interface HistoryCompressionRefreshInput {
  session: ChatSession;
  prompt: string;
  model: KeepseekModel;
  agentSettings: AgentSettings;
  contextFiles: ContextFile[];
  language: KeepseekLanguage;
  settings?: ContextCompressionSettings;
  signal?: AbortSignal;
  currentRunContext?: CurrentRunContext;
  contextInstructions?: string;
  slimToolNames?: string[];
  requestProtocolVersion?: number;
  usageSource?: Extract<UsageSource, 'summary' | 'background'>;
}

export interface HistoryCompressionRefreshResult {
  state: ContextCompressionState;
  changed: boolean;
  reason: 'created' | 'updated' | 'skipped' | 'failed';
  failureReason?: string;
  usageEvents?: UsageEvent[];
}

export type HistoryCompressionRefreshMode = 'none' | 'sync' | 'background';

export interface HistoryCompressionRefreshPlan {
  state: ContextCompressionState;
  changed: boolean;
  mode: HistoryCompressionRefreshMode;
  reason:
    | 'aborted'
    | 'no_compressible_messages'
    | 'fresh_enough'
    | 'force_context_limit'
    | 'missing_summary_near_context_limit'
    | 'background_refresh';
}

export interface HistorySummaryCompletionResult {
  content: string;
  usageEvent?: UsageEvent;
}

export type HistorySummaryCompletion = (input: {
  model: KeepseekModel;
  messages: DeepSeekMessage[];
  maxTokens: number;
  language: KeepseekLanguage;
  signal?: AbortSignal;
}) => Promise<string | HistorySummaryCompletionResult>;

export class HistoryCompressor {
  private readonly deepSeekClient = new DeepSeekClient();

  public constructor(private readonly completion?: HistorySummaryCompletion) {}

  public planRefresh(input: HistoryCompressionRefreshInput): HistoryCompressionRefreshPlan {
    const settings = input.settings ?? getDeepSeekV4ContextCompressionSettings(input.model, input.agentSettings);
    const protectedState = this.createProtectedState(input.session);

    if (input.signal?.aborted) {
      return {
        state: protectedState.state,
        changed: protectedState.changed,
        mode: 'none',
        reason: 'aborted'
      };
    }

    const summaryInput = this.createSummaryRefreshInput(input, settings, protectedState.state);
    if (!summaryInput.newCompressibleMessages.length) {
      return {
        state: protectedState.state,
        changed: protectedState.changed,
        mode: 'none',
        reason: 'no_compressible_messages'
      };
    }

    if (!this.shouldRefreshSummary({
      input,
      settings,
      hasSummary: protectedState.state.summaries.length > 0,
      newCompressibleMessages: summaryInput.newCompressibleMessages
    })) {
      return {
        state: protectedState.state,
        changed: protectedState.changed,
        mode: 'none',
        reason: 'fresh_enough'
      };
    }

    if (isRawConversationOverForceRatio(input, settings)) {
      return {
        state: protectedState.state,
        changed: protectedState.changed,
        mode: 'sync',
        reason: 'force_context_limit'
      };
    }

    if (!protectedState.state.summaries.length && isRawConversationNearContextWindow(input, settings)) {
      return {
        state: protectedState.state,
        changed: protectedState.changed,
        mode: 'sync',
        reason: 'missing_summary_near_context_limit'
      };
    }

    return {
      state: protectedState.state,
      changed: protectedState.changed,
      mode: 'background',
      reason: 'background_refresh'
    };
  }

  public async refresh(input: HistoryCompressionRefreshInput): Promise<HistoryCompressionRefreshResult> {
    const settings = input.settings ?? getDeepSeekV4ContextCompressionSettings(input.model, input.agentSettings);
    const protectedState = this.createProtectedState(input.session);

    if (input.signal?.aborted) {
      return {
        state: protectedState.state,
        changed: protectedState.changed,
        reason: 'skipped'
      };
    }

    const summaryInput = this.createSummaryRefreshInput(input, settings, protectedState.state);

    if (!this.shouldRefreshSummary({
      input,
      settings,
      hasSummary: protectedState.state.summaries.length > 0,
      newCompressibleMessages: summaryInput.newCompressibleMessages
    })) {
      return {
        state: protectedState.state,
        changed: protectedState.changed,
        reason: 'skipped'
      };
    }

    try {
      const summaryBatch = this.buildSummaryMessages({
        messagesToSummarize: summaryInput.newCompressibleMessages,
        summaryBudgetTokens: settings.summaryBudgetTokens,
        language: input.language
      });
      if (!summaryBatch.includedMessageIds.length) {
        return {
          state: protectedState.state,
          changed: protectedState.changed,
          reason: 'skipped'
        };
      }
      const completion = await this.completeSummary({
        model: input.model,
        messages: summaryBatch.messages,
        maxTokens: settings.summaryBudgetTokens,
        timeoutMs: settings.summaryRequestTimeoutMs,
        language: input.language,
        signal: input.signal,
        usageSource: input.usageSource ?? 'summary'
      });
      const content = completion.content.trim();

      if (!content) {
        throw new Error('Context summary result was empty.');
      }

      const now = new Date().toISOString();
      const summary: HistorySummary = {
        id: randomUUID(),
        content,
        coveredMessageIds: summaryBatch.includedMessageIds,
        createdAt: now,
        updatedAt: now,
        tokenEstimate: estimateTokenCount(content),
        modelId: input.model.id,
        version: CONTEXT_COMPRESSION_VERSION
      };
      return {
        state: {
          version: CONTEXT_COMPRESSION_VERSION,
          summaries: [...protectedState.state.summaries, summary],
          protectedMessageIds: protectedState.state.protectedMessageIds,
          lastCompressedAt: now,
          lastFailureReason: undefined
        },
        changed: true,
        reason: protectedState.state.summaries.length ? 'updated' : 'created',
        usageEvents: completion.usageEvent ? [completion.usageEvent] : undefined
      };
    } catch (error) {
      const failureReason = summarizeFailureReason(error);
      return {
        state: {
          ...protectedState.state,
          lastFailureReason: failureReason
        },
        changed: true,
        reason: 'failed',
        failureReason
      };
    }
  }

  private createProtectedState(session: ChatSession): {
    state: ContextCompressionState;
    changed: boolean;
  } {
    const currentState = createCompressionState(session.contextCompression);
    const protectedMessageIds = getMergedProtectedMessageIds(session.messages, currentState);
    return {
      state: {
        ...currentState,
        protectedMessageIds
      },
      changed: hasProtectedMessageIdsChanged(currentState.protectedMessageIds, protectedMessageIds)
    };
  }

  private createSummaryRefreshInput(
    input: HistoryCompressionRefreshInput,
    settings: ContextCompressionSettings,
    state: ContextCompressionState
  ): {
    newCompressibleMessages: ChatMessage[];
  } {
    const projection = buildHistoryProjection({
      history: input.session.messages,
      prompt: input.prompt,
      language: input.language,
      contextCompression: state,
      settings,
      requestProtocolVersion: input.requestProtocolVersion
    });
    const newCompressibleMessages = input.session.messages.filter((message) => (
      projection.compressibleMessageIds.includes(message.id)
    ));
    return {
      newCompressibleMessages
    };
  }

  private shouldRefreshSummary(input: {
    input: HistoryCompressionRefreshInput;
    settings: ContextCompressionSettings;
    hasSummary: boolean;
    newCompressibleMessages: ChatMessage[];
  }): boolean {
    if (!input.newCompressibleMessages.length) {
      return false;
    }

    const ratio = estimateRawConversationRatio(input.input);
    if (ratio < input.settings.triggerRatio) {
      return false;
    }

    // C3 失败自锁：上次摘要刷新失败时暂停自动刷新，避免在缓存已受伤的情况下
    // 反复触发可能再次失败的刷新（每次成功刷新都会重写前缀）。只有接近/超过
    // 强制上限时才允许重试，保护上下文窗口。
    if (input.input.session.contextCompression?.lastFailureReason && ratio < input.settings.forceRatio) {
      return false;
    }

    if (input.hasSummary && ratio < input.settings.forceRatio) {
      return input.newCompressibleMessages.length >= Math.max(
        SUMMARY_INCREMENTAL_MESSAGE_THRESHOLD,
        input.settings.keepRecentTurns
      );
    }

    return true;
  }

  private buildSummaryMessages(input: {
    messagesToSummarize: ChatMessage[];
    summaryBudgetTokens: number;
    language: KeepseekLanguage;
  }): { messages: DeepSeekMessage[]; includedMessageIds: string[] } {
    const formatted = formatMessagesForSummary(input.messagesToSummarize, input.language);
    return {
      messages: [
      {
        role: 'system',
        content: getSummarySystemPrompt(input.language)
      },
      {
        role: 'user',
        content: buildSummaryUserPrompt({
          ...input,
          formattedMessages: formatted.content
        })
      }
      ],
      includedMessageIds: formatted.includedMessageIds
    };
  }

  private async completeSummary(input: {
    model: KeepseekModel;
    messages: DeepSeekMessage[];
    maxTokens: number;
    timeoutMs: number;
    language: KeepseekLanguage;
    signal?: AbortSignal;
    usageSource: Extract<UsageSource, 'summary' | 'background'>;
  }): Promise<HistorySummaryCompletionResult> {
    if (this.completion) {
      const result = await this.completion(input);
      return typeof result === 'string' ? { content: result } : result;
    }

    const abort = createTimeoutAbortSignal(input.signal, input.timeoutMs);
    try {
      const body: DeepSeekChatRequestBody = {
        model: input.model.id,
        messages: input.messages,
        stream: true,
        thinking: {
          type: 'disabled'
        },
        // Deterministic summaries: a stable completion reduces unrelated byte drift
        // between refreshes (the covered-message change is the unavoidable part).
        temperature: 0,
        max_tokens: input.maxTokens,
        stream_options: {
          include_usage: true
        }
      };
      const response = await this.deepSeekClient.createChatCompletion(getSummaryClientConfig(input.timeoutMs), {
        body,
        language: input.language,
        signal: abort.signal,
        runDeadlineAt: Date.now() + input.timeoutMs
      });

      if (!response.ok) {
        throw new Error(abort.timedOut()
          ? 'Context summary request timed out.'
          : response.error ?? 'Context summary request failed.');
      }

      const normalizedUsage = normalizeDeepSeekUsage(response.usage);
      const pricing = getConfiguredModelUsagePricing(input.model.id);
      return {
        content: response.message?.content ?? '',
        usageEvent: normalizedUsage
          ? createUsageEvent({
              usage: normalizedUsage,
              cost: calculateUsageCost(normalizedUsage, pricing),
              currency: pricing.currency,
              modelId: input.model.id,
              requestId: randomUUID(),
              source: input.usageSource
            })
          : undefined
      };
    } finally {
      abort.dispose();
    }
  }
}

function createCompressionState(state: ContextCompressionState | undefined): ContextCompressionState {
  return {
    version: CONTEXT_COMPRESSION_VERSION,
    summaries: [...(state?.summaries ?? [])]
      .filter((summary) => summary.content.trim())
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt)),
    protectedMessageIds: Array.from(new Set(state?.protectedMessageIds ?? [])),
    lastCompressedAt: state?.lastCompressedAt,
    lastFailureReason: state?.lastFailureReason
  };
}

function getMergedProtectedMessageIds(
  messages: readonly ChatMessage[],
  state: ContextCompressionState
): string[] {
  return Array.from(new Set([
    ...state.protectedMessageIds,
    ...getDurableProtectedMessageIds(messages, state)
  ]));
}

function hasProtectedMessageIdsChanged(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return true;
  }
  const leftIds = new Set(left);
  return right.some((id) => !leftIds.has(id));
}

function estimateRawConversationTokens(input: HistoryCompressionRefreshInput): number {
  const projection = buildProviderRequestProjection({
    model: input.model,
    agentSettings: input.agentSettings,
    contextFiles: input.contextFiles,
    currentRunContext: input.currentRunContext,
    contextInstructions: input.contextInstructions,
    history: input.session.messages,
    contextCompression: input.session.contextCompression,
    language: input.language,
    prompt: input.prompt,
    slimToolNames: input.slimToolNames,
    requestProtocolVersion: input.requestProtocolVersion
  });
  return projection.messages.reduce((total, message) => total + estimateDeepSeekMessageTokens(message), 0)
    + estimateDeepSeekToolsTokens(projection.tools);
}

function estimateRawConversationRatio(input: HistoryCompressionRefreshInput): number {
  const maxTokens = getConfiguredContextWindowTokens(input.model);
  return estimateRawConversationTokens(input) / maxTokens;
}

function isRawConversationNearContextWindow(
  input: HistoryCompressionRefreshInput,
  settings: ContextCompressionSettings
): boolean {
  return estimateRawConversationRatio(input) >= settings.triggerRatio;
}

function isRawConversationOverForceRatio(
  input: HistoryCompressionRefreshInput,
  settings: ContextCompressionSettings
): boolean {
  return estimateRawConversationRatio(input) >= settings.forceRatio;
}

function getSummarySystemPrompt(language: KeepseekLanguage): string {
  if (language === 'en') {
    return [
      'You summarize earlier KeepSeek chat history for a coding agent.',
      'Do not invent file contents, decisions, errors, or user preferences.',
      'Compress large code blocks into file paths, symbols, line ranges, intent, and unresolved questions.',
      'Preserve user constraints, confirmed decisions, important errors/test failures, completed work, blockers, and paths that should be reread with workspace tools.',
      'Return structured plain text only.'
    ].join('\n');
  }

  return [
    '你负责为 KeepSeek 代码 Agent 压缩较早的对话历史。',
    '不要编造文件内容、决策、错误信息或用户偏好。',
    '把大段代码压缩成文件路径、符号、行段、关注点和未解决问题。',
    '必须保留用户约束、已确认决策、重要错误/测试失败、已完成事项、阻塞项，以及需要用工作区工具重新读取的路径线索。',
    '只输出结构化纯文本。'
  ].join('\n');
}

function buildSummaryUserPrompt(input: {
  messagesToSummarize: ChatMessage[];
  summaryBudgetTokens: number;
  language: KeepseekLanguage;
  formattedMessages: string;
}): string {
  const headings = input.language === 'en'
    ? [
        'User goals',
        'Confirmed decisions and constraints',
        'Important errors or test failures',
        'Relevant files, symbols, directories, and line ranges',
        'Completed work',
        'Current blockers and todos',
        'Paths or references to reread with KeepSeek tools'
      ]
    : [
        '用户核心需求',
        '已确认决策与约束',
        '重要错误或测试失败',
        '相关文件、符号、目录与行段',
        '已完成事项',
        '当前阻塞项与待办',
        '需要用 KeepSeek 工具重新读取的路径或引用'
      ];
  const instruction = input.language === 'en'
    ? `Update the conversation summary. Keep it near ${input.summaryBudgetTokens} tokens or less. Use these headings:\n${headings.map((heading) => `- ${heading}`).join('\n')}`
    : `请更新会话摘要，尽量控制在 ${input.summaryBudgetTokens} token 以内。使用这些标题：\n${headings.map((heading) => `- ${heading}`).join('\n')}`;
  return [instruction, input.formattedMessages].filter(Boolean).join('\n\n');
}

function formatMessagesForSummary(messages: ChatMessage[], language: KeepseekLanguage): {
  content: string;
  includedMessageIds: string[];
} {
  const header = language === 'en'
    ? 'New older messages to compress. Prefer original file/reference text over expanded file bodies:'
    : '需要压缩的新增较早消息。优先保留原始文件/目录引用文本，不要保留展开后的大段文件正文：';
  const blocks: string[] = [];
  const includedMessageIds: string[] = [];
  let totalChars = header.length;

  for (const message of messages) {
    const block = formatMessageForSummary(message);
    if (totalChars + block.length > SUMMARY_MAX_INPUT_CHARS) {
      blocks.push(language === 'en'
        ? '[Summary input truncated to stay within the compression prompt budget.]'
        : '[摘要输入已截断，以控制压缩 prompt 预算。]');
      break;
    }
    blocks.push(block);
    includedMessageIds.push(message.id);
    totalChars += block.length;
  }

  return {
    content: [header, ...blocks].join('\n\n'),
    includedMessageIds
  };
}

function formatMessageForSummary(message: ChatMessage): string {
  const content = message.content.replace(/\r\n?/gu, '\n').trim();
  const referenceHints = message.expandedContent && message.expandedContent !== message.content
    ? extractReferenceHints(message.expandedContent)
    : [];
  const toolRounds = (message.toolRounds ?? []).map((round, index) => [
    `Tool round ${index + 1} assistant reasoning:`,
    round.reasoningContent ?? '',
    `Tool calls: ${JSON.stringify(round.toolCalls)}`,
    ...round.toolResults.map((result) => `Tool result ${result.toolCallId}:\n${result.content}`)
  ].filter(Boolean).join('\n')).join('\n\n');
  return [
    `Message ${message.id}`,
    `Role: ${message.role}`,
    `Created: ${message.createdAt}`,
    message.modelId ? `Model: ${message.modelId}` : '',
    'Content:',
    content,
    toolRounds,
    referenceHints.length ? `Reference hints:\n${referenceHints.join('\n')}` : ''
  ].filter(Boolean).join('\n');
}

function extractReferenceHints(content: string): string[] {
  const hints = new Set<string>();
  const pattern = /[^\n<>]{0,120}<[^>\n]+>/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) && hints.size < 20) {
    hints.add(match[0].trim());
  }
  return Array.from(hints);
}

function getSummaryClientConfig(timeoutMs: number): DeepSeekClientConfig {
  const config = vscode.workspace.getConfiguration('keepseek');
  const apiKey = (config.get<string>('apiKey', '').trim() || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Missing DeepSeek API key for context summary.');
  }
  return {
    apiKey,
    baseUrl: config.get<string>('baseUrl', DEFAULT_DEEPSEEK_BASE_URL).trim() || DEFAULT_DEEPSEEK_BASE_URL,
    streamIdleTimeoutMs: timeoutMs,
    maxRequestRetries: 0,
    requestRetryBaseMs: getConfiguredRequestRetryBaseMs()
  };
}

function createTimeoutAbortSignal(parentSignal: AbortSignal | undefined, timeoutMs: number): {
  signal: AbortSignal;
  timedOut(): boolean;
  dispose(): void;
} {
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (parentSignal?.aborted) {
    controller.abort();
  } else {
    parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  }

  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timeout);
      parentSignal?.removeEventListener('abort', abortFromParent);
    }
  };
}

function summarizeFailureReason(error: unknown): string {
  const message = getErrorMessage(error).replace(/\s+/gu, ' ').trim();
  return message.length > 500 ? `${message.slice(0, 500)}...` : message;
}
