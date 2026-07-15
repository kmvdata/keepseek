import type { KeepseekLanguage } from '../shared/i18n';
import type { ContextCompressionSettings } from '../shared/modelProfiles';
import type {
  ChatMessage,
  ChatMessageContextMeta,
  ContextCompressionState,
  ContextProjectionMetadata,
  HistorySummary
} from '../shared/types';
import { estimateTokenCount } from './tokenEstimate';

export const CONTEXT_COMPRESSION_VERSION = 1;

export interface HistoryProjectionInput {
  history: ChatMessage[];
  prompt: string;
  language: KeepseekLanguage;
  contextCompression?: ContextCompressionState;
  settings: ContextCompressionSettings;
}

export interface HistoryProjectionResult {
  history: ChatMessage[];
  syntheticSystemMessages: string[];
  metadata: ContextProjectionMetadata;
  protectedMessageIds: string[];
  recentMessageIds: string[];
  compressibleMessageIds: string[];
  usedSummaryIds: string[];
}

interface ProtectionContext {
  index: number;
  firstUserMessageId?: string;
  lastUserMessageId?: string;
  storedProtectedMessageIds: Set<string>;
}

const EXPLICIT_MEMORY_PATTERN = /(?:记住|保留|不要忘记|别忘|以后都按|以后请|始终|总是|偏好|约束|remember|keep this|don't forget|do not forget|always|from now on|preference|constraint)/iu;
const USER_CORRECTION_PATTERN = /(?:不对|不是|纠正|更正|我说的是|刚才说错|actually|correction|to be clear|that's not|that is not|no,)/iu;
const ERROR_MARKER_PATTERN = /(?:stack trace|traceback|assertionerror|typeerror|referenceerror|syntaxerror|npm err!|error:|exception|failed tests?|test failure|测试失败|报错|错误|异常|失败)/iu;
const STACK_FRAME_PATTERN = /(?:^\s*at\s+\S+|\n\s*at\s+\S+|\n\s*File\s+"[^"]+",\s+line\s+\d+)/u;
const DRAFT_RESULT_PATTERN = /(?:Draft edit|pending change|Prepared .*pending|待确认修改|已准备 .*修改|已写入|已删除|Wrote .*\.|Deleted .*|Draft edit created)/iu;

export function buildHistoryProjection(input: HistoryProjectionInput): HistoryProjectionResult {
  const settings = input.settings;
  const agentHistory = input.history.filter((message) => message.role === 'user' || message.role === 'assistant');

  const recentMessageIds = selectRecentTurnMessageIds(agentHistory, settings.keepRecentTurns);
  const protectedMessageIds = selectProtectedMessageIds(agentHistory, input.contextCompression);
  const selectedMessageIds = new Set<string>([...recentMessageIds, ...protectedMessageIds]);
  const compressibleMessages = agentHistory.filter((message) => !selectedMessageIds.has(message.id));
  const summaries = getUsableSummaries(input.contextCompression);
  const summary = summaries[0];
  const syntheticSystemMessages = summary
    ? [formatSyntheticSummaryMessage(summary, input.language)]
    : [];

  const projectedHistory = agentHistory
    .filter((message) => selectedMessageIds.has(message.id))
    .map((message) => recentMessageIds.has(message.id) ? message : externalizeMessageContent(message));

  const metadata: ContextProjectionMetadata = {
    usedSummary: Boolean(summary),
    summaryCount: summary ? 1 : 0,
    protectedMessageCount: protectedMessageIds.size,
    recentMessageCount: recentMessageIds.size,
    fallbackReason: summary || !compressibleMessages.length ? undefined : 'summary_unavailable'
  };

  return {
    history: projectedHistory,
    syntheticSystemMessages,
    metadata,
    protectedMessageIds: Array.from(protectedMessageIds),
    recentMessageIds: Array.from(recentMessageIds),
    compressibleMessageIds: compressibleMessages.map((message) => message.id),
    usedSummaryIds: summary ? [summary.id] : []
  };
}

export function getAutoProtectedMessageIds(
  history: readonly ChatMessage[],
  contextCompression?: ContextCompressionState
): Set<string> {
  return selectProtectedMessageIds(
    history.filter((message) => message.role === 'user' || message.role === 'assistant'),
    contextCompression
  );
}

export function getDurableProtectedMessageIds(
  history: readonly ChatMessage[],
  contextCompression?: ContextCompressionState
): Set<string> {
  const agentHistory = history.filter((message) => message.role === 'user' || message.role === 'assistant');
  const firstUserMessageId = agentHistory.find((message) => message.role === 'user')?.id;
  const lastUserMessageId = [...agentHistory].reverse().find((message) => message.role === 'user')?.id;
  const storedProtectedMessageIds = new Set(contextCompression?.protectedMessageIds ?? []);
  const protectedMessageIds = new Set<string>();

  agentHistory.forEach((message, index) => {
    const reason = getAutoProtectionReason(message, {
      index,
      firstUserMessageId,
      lastUserMessageId,
      storedProtectedMessageIds
    });
    if (reason && reason !== 'latest_user_request') {
      protectedMessageIds.add(message.id);
    }
  });

  return protectedMessageIds;
}

export function getAutoProtectionReason(
  message: ChatMessage,
  context: ProtectionContext
): string | undefined {
  if (message.contextMeta?.isProtected) {
    return message.contextMeta.protectedReason?.trim() || 'stored_message_protection';
  }
  if (context.storedProtectedMessageIds.has(message.id)) {
    return 'stored_session_protection';
  }
  if (message.role === 'user' && message.id === context.firstUserMessageId) {
    return 'first_user_request';
  }
  if (message.role === 'user' && message.id === context.lastUserMessageId) {
    return 'latest_user_request';
  }
  if (message.role === 'user' && EXPLICIT_MEMORY_PATTERN.test(message.content)) {
    return 'explicit_user_retention_request';
  }
  if (message.role === 'user' && USER_CORRECTION_PATTERN.test(message.content)) {
    return 'user_correction';
  }
  if (hasSignificantErrorText(message.content)) {
    return 'important_error_or_test_output';
  }
  if (message.role === 'assistant' && DRAFT_RESULT_PATTERN.test(message.content)) {
    return 'draft_edit_result';
  }
  return undefined;
}

export function createProtectedContextMeta(reason: string): ChatMessageContextMeta {
  return {
    isProtected: true,
    protectedReason: reason
  };
}

export function estimateHistoryProjectionTokens(projection: HistoryProjectionResult): number {
  const summaryTokens = projection.syntheticSystemMessages.reduce(
    (total, content) => total + estimateTokenCount(`system\n${content}`),
    0
  );
  const historyTokens = projection.history.reduce((total, message) => {
    const content = (message.expandedContent ?? message.content).trim();
    return total + estimateTokenCount(`${message.role}\n${content}`);
  }, 0);
  return summaryTokens + historyTokens;
}

function selectProtectedMessageIds(
  history: ChatMessage[],
  contextCompression: ContextCompressionState | undefined
): Set<string> {
  const firstUserMessageId = history.find((message) => message.role === 'user')?.id;
  const lastUserMessageId = [...history].reverse().find((message) => message.role === 'user')?.id;
  const storedProtectedMessageIds = new Set(contextCompression?.protectedMessageIds ?? []);
  const protectedMessageIds = new Set<string>();

  history.forEach((message, index) => {
    const reason = getAutoProtectionReason(message, {
      index,
      firstUserMessageId,
      lastUserMessageId,
      storedProtectedMessageIds
    });
    if (reason) {
      protectedMessageIds.add(message.id);
    }
  });

  return protectedMessageIds;
}

function selectRecentTurnMessageIds(history: ChatMessage[], keepRecentTurns: number): Set<string> {
  const ids = new Set<string>();
  let userTurns = 0;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    ids.add(message.id);
    if (message.role === 'user') {
      userTurns += 1;
      if (userTurns >= keepRecentTurns) {
        break;
      }
    }
  }
  return ids;
}

function getUsableSummaries(contextCompression: ContextCompressionState | undefined): HistorySummary[] {
  return [...(contextCompression?.summaries ?? [])]
    .filter((summary) => summary.content.trim())
    .sort((left, right) => getSummaryTimestamp(right) - getSummaryTimestamp(left));
}

function getSummaryTimestamp(summary: HistorySummary): number {
  const updated = Date.parse(summary.updatedAt);
  if (Number.isFinite(updated)) {
    return updated;
  }
  const created = Date.parse(summary.createdAt);
  return Number.isFinite(created) ? created : 0;
}

function formatSyntheticSummaryMessage(summary: HistorySummary, language: KeepseekLanguage): string {
  const header = language === 'en'
    ? [
        'The following is a compressed summary of earlier KeepSeek conversation history.',
        'It is not a live copy of current workspace files.',
        'When code details matter, use the KeepSeek read-only workspace tools to reread the current files and line ranges mentioned here.'
      ]
    : [
        '以下是 KeepSeek 较早会话历史的压缩摘要。',
        '它不是当前工作区文件内容的实时副本。',
        '当代码细节重要时，请使用 KeepSeek 只读工作区工具重新读取摘要中提到的文件和行段。'
      ];

  return [...header, '', summary.content.trim()].join('\n');
}

function externalizeMessageContent(message: ChatMessage): ChatMessage {
  if (!message.expandedContent) {
    return message;
  }
  return {
    ...message,
    expandedContent: undefined
  };
}

function hasSignificantErrorText(content: string): boolean {
  const normalized = content.trim();
  if (!ERROR_MARKER_PATTERN.test(normalized)) {
    return false;
  }
  return normalized.length > 280 ||
    normalized.split('\n').length >= 3 ||
    normalized.includes('```') ||
    STACK_FRAME_PATTERN.test(normalized);
}
