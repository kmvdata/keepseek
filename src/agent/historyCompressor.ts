import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import {
  AGENT_HISTORY_MESSAGE_LIMIT,
  DEFAULT_DEEPSEEK_BASE_URL,
  getConfiguredContextCompressionSettings,
  getConfiguredContextWindowTokens,
  getConfiguredRequestRetryBaseMs,
  getConfiguredStreamIdleTimeoutMs,
  type ContextCompressionSettings
} from '../shared/config';
import { getErrorMessage } from '../shared/errors';
import type { KeepseekLanguage } from '../shared/i18n';
import type {
  ChatMessage,
  ChatSession,
  ContextCompressionState,
  ContextFile,
  HistorySummary,
  KeepseekModel
} from '../shared/types';
import { DeepSeekClient, type DeepSeekClientConfig } from './deepseek/client';
import type { DeepSeekChatRequestBody, DeepSeekMessage } from './deepseek/types';
import {
  CONTEXT_COMPRESSION_VERSION,
  buildHistoryProjection,
  getDurableProtectedMessageIds
} from './historyProjection';
import { estimateTokenCount } from './tokenEstimate';

const SUMMARY_REQUEST_TIMEOUT_MS = 8_000;
const SUMMARY_MAX_MESSAGE_CHARS = 4_000;
const SUMMARY_MAX_INPUT_CHARS = 90_000;
const SUMMARY_INCREMENTAL_MESSAGE_THRESHOLD = 12;

export interface HistoryCompressionRefreshInput {
  session: ChatSession;
  prompt: string;
  model: KeepseekModel;
  contextFiles: ContextFile[];
  language: KeepseekLanguage;
  settings?: ContextCompressionSettings;
  signal?: AbortSignal;
}

export interface HistoryCompressionRefreshResult {
  state: ContextCompressionState;
  changed: boolean;
  reason: 'created' | 'updated' | 'skipped' | 'failed';
  failureReason?: string;
}

export type HistorySummaryCompletion = (input: {
  model: KeepseekModel;
  messages: DeepSeekMessage[];
  maxTokens: number;
  language: KeepseekLanguage;
  signal?: AbortSignal;
}) => Promise<string>;

export class HistoryCompressor {
  private readonly deepSeekClient = new DeepSeekClient();

  public constructor(private readonly completion?: HistorySummaryCompletion) {}

  public async refresh(input: HistoryCompressionRefreshInput): Promise<HistoryCompressionRefreshResult> {
    const settings = input.settings ?? getConfiguredContextCompressionSettings();
    const currentState = createCompressionState(input.session.contextCompression);
    const protectedMessageIds = getMergedProtectedMessageIds(input.session.messages, currentState);
    const stateWithProtection = {
      ...currentState,
      protectedMessageIds
    };

    if (!settings.enabled || input.signal?.aborted) {
      return {
        state: stateWithProtection,
        changed: hasProtectedMessageIdsChanged(currentState.protectedMessageIds, protectedMessageIds),
        reason: 'skipped'
      };
    }

    const projection = buildHistoryProjection({
      history: input.session.messages,
      prompt: input.prompt,
      language: input.language,
      contextCompression: stateWithProtection,
      settings
    });
    const previousSummary = stateWithProtection.summaries[0];
    const coveredMessageIds = new Set(previousSummary?.coveredMessageIds ?? []);
    const newCompressibleMessages = input.session.messages.filter((message) => (
      projection.compressibleMessageIds.includes(message.id) && !coveredMessageIds.has(message.id)
    ));

    if (!this.shouldRefreshSummary({
      input,
      settings,
      hasSummary: Boolean(previousSummary),
      newCompressibleMessages
    })) {
      return {
        state: stateWithProtection,
        changed: hasProtectedMessageIdsChanged(currentState.protectedMessageIds, protectedMessageIds),
        reason: 'skipped'
      };
    }

    try {
      const summaryMessages = this.buildSummaryMessages({
        messagesToSummarize: newCompressibleMessages,
        previousSummary,
        summaryBudgetTokens: settings.summaryBudgetTokens,
        language: input.language
      });
      const content = (await this.completeSummary({
        model: input.model,
        messages: summaryMessages,
        maxTokens: settings.summaryBudgetTokens,
        language: input.language,
        signal: input.signal
      })).trim();

      if (!content) {
        throw new Error('Context summary result was empty.');
      }

      const now = new Date().toISOString();
      const nextCoveredMessageIds = Array.from(new Set([
        ...(previousSummary?.coveredMessageIds ?? []),
        ...newCompressibleMessages.map((message) => message.id)
      ]));
      const summary: HistorySummary = {
        id: previousSummary?.id ?? randomUUID(),
        content,
        coveredMessageIds: nextCoveredMessageIds,
        createdAt: previousSummary?.createdAt ?? now,
        updatedAt: now,
        tokenEstimate: estimateTokenCount(content),
        modelId: input.model.id,
        version: CONTEXT_COMPRESSION_VERSION
      };
      return {
        state: {
          version: CONTEXT_COMPRESSION_VERSION,
          summaries: [summary],
          protectedMessageIds,
          lastCompressedAt: now,
          lastFailureReason: undefined
        },
        changed: true,
        reason: previousSummary ? 'updated' : 'created'
      };
    } catch (error) {
      const failureReason = summarizeFailureReason(error);
      return {
        state: {
          ...stateWithProtection,
          lastFailureReason: failureReason
        },
        changed: true,
        reason: 'failed',
        failureReason
      };
    }
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

    if (input.hasSummary) {
      return input.newCompressibleMessages.length >= Math.max(
        SUMMARY_INCREMENTAL_MESSAGE_THRESHOLD,
        input.settings.keepRecentTurns
      );
    }

    if (input.input.session.messages.length > AGENT_HISTORY_MESSAGE_LIMIT) {
      return true;
    }

    const estimatedTokens = estimateRawConversationTokens(input.input);
    const maxTokens = getConfiguredContextWindowTokens(input.input.model);
    return estimatedTokens / maxTokens >= input.settings.triggerRatio;
  }

  private buildSummaryMessages(input: {
    messagesToSummarize: ChatMessage[];
    previousSummary?: HistorySummary;
    summaryBudgetTokens: number;
    language: KeepseekLanguage;
  }): DeepSeekMessage[] {
    return [
      {
        role: 'system',
        content: getSummarySystemPrompt(input.language)
      },
      {
        role: 'user',
        content: buildSummaryUserPrompt(input)
      }
    ];
  }

  private async completeSummary(input: {
    model: KeepseekModel;
    messages: DeepSeekMessage[];
    maxTokens: number;
    language: KeepseekLanguage;
    signal?: AbortSignal;
  }): Promise<string> {
    if (this.completion) {
      return await this.completion(input);
    }

    const abort = createTimeoutAbortSignal(input.signal, SUMMARY_REQUEST_TIMEOUT_MS);
    try {
      const body: DeepSeekChatRequestBody = {
        model: input.model.id,
        messages: input.messages,
        stream: true,
        thinking: {
          type: 'disabled'
        },
        max_tokens: input.maxTokens,
        stream_options: {
          include_usage: true
        }
      };
      const response = await this.deepSeekClient.createChatCompletion(getSummaryClientConfig(), {
        body,
        language: input.language,
        signal: abort.signal,
        runDeadlineAt: Date.now() + SUMMARY_REQUEST_TIMEOUT_MS
      });

      if (!response.ok) {
        throw new Error(abort.timedOut()
          ? 'Context summary request timed out.'
          : response.error ?? 'Context summary request failed.');
      }

      return response.message?.content ?? '';
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
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 1),
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
  const historyTokens = input.session.messages.reduce((total, message) => {
    const content = (message.expandedContent ?? message.content).trim();
    return total + estimateTokenCount(`${message.role}\n${content}`);
  }, 0);
  const prompt = input.prompt.trim();
  const lastUserMessage = [...input.session.messages].reverse().find((message) => message.role === 'user');
  const lastUserContent = lastUserMessage
    ? (lastUserMessage.expandedContent ?? lastUserMessage.content).trim()
    : '';
  const promptTokens = prompt && prompt !== lastUserContent ? estimateTokenCount(`user\n${prompt}`) : 0;
  const contextFileTokens = input.contextFiles.reduce((total, file) => total + estimateTokenCount(file.content), 0);
  return historyTokens + promptTokens + contextFileTokens;
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
  previousSummary?: HistorySummary;
  summaryBudgetTokens: number;
  language: KeepseekLanguage;
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
  const previous = input.previousSummary?.content.trim()
    ? [
        input.language === 'en' ? 'Existing summary to update:' : '需要更新的既有摘要：',
        input.previousSummary.content.trim()
      ].join('\n\n')
    : '';
  const messages = formatMessagesForSummary(input.messagesToSummarize, input.language);
  return [instruction, previous, messages].filter(Boolean).join('\n\n');
}

function formatMessagesForSummary(messages: ChatMessage[], language: KeepseekLanguage): string {
  const header = language === 'en'
    ? 'New older messages to compress. Prefer original file/reference text over expanded file bodies:'
    : '需要压缩的新增较早消息。优先保留原始文件/目录引用文本，不要保留展开后的大段文件正文：';
  const blocks: string[] = [];
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
    totalChars += block.length;
  }

  return [header, ...blocks].join('\n\n');
}

function formatMessageForSummary(message: ChatMessage): string {
  const content = truncateForSummary(message.content.replace(/\r\n?/gu, '\n'));
  const referenceHints = message.expandedContent && message.expandedContent !== message.content
    ? extractReferenceHints(message.expandedContent)
    : [];
  return [
    `Message ${message.id}`,
    `Role: ${message.role}`,
    `Created: ${message.createdAt}`,
    message.modelId ? `Model: ${message.modelId}` : '',
    'Content:',
    content,
    referenceHints.length ? `Reference hints:\n${referenceHints.join('\n')}` : ''
  ].filter(Boolean).join('\n');
}

function truncateForSummary(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= SUMMARY_MAX_MESSAGE_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, SUMMARY_MAX_MESSAGE_CHARS)}\n[message content truncated]`;
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

function getSummaryClientConfig(): DeepSeekClientConfig {
  const config = vscode.workspace.getConfiguration('keepseek');
  const apiKey = (config.get<string>('apiKey', '').trim() || process.env.DEEPSEEK_API_KEY || '').trim();
  if (!apiKey) {
    throw new Error('Missing DeepSeek API key for context summary.');
  }
  const configuredIdleTimeout = getConfiguredStreamIdleTimeoutMs();
  return {
    apiKey,
    baseUrl: config.get<string>('baseUrl', DEFAULT_DEEPSEEK_BASE_URL).trim() || DEFAULT_DEEPSEEK_BASE_URL,
    streamIdleTimeoutMs: configuredIdleTimeout > 0
      ? Math.min(configuredIdleTimeout, SUMMARY_REQUEST_TIMEOUT_MS)
      : SUMMARY_REQUEST_TIMEOUT_MS,
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
