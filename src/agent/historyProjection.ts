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
  /** Optional fallback cap: when no summary is available (refreshes keep failing)
   *  and the projection exceeds this token budget, truncate to the recent window
   *  instead of growing without bound. Omit on normal paths. */
  maxProjectionTokens?: number;
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
  const summaries = getUsableSummaries(input.contextCompression);
  const summary = summaries[0];
  const coveredMessageIds = new Set(summary?.coveredMessageIds ?? []);

  // Cache-first projection: selected messages are append-only. A message enters the
  // projection when it is created and leaves only when a summary refresh covers it —
  // a deliberately low-frequency cache-invalidation point. Sliding a recent-turn
  // window would drop or rewrite mid-history messages every turn, invalidating
  // DeepSeek's prefix cache (byte-identical prefix from token 0) for everything
  // after the first changed message. recentMessageIds therefore only decides
  // compressibility, never projection membership.
  const selectedMessageIds = new Set<string>(protectedMessageIds);
  for (const message of agentHistory) {
    if (!coveredMessageIds.has(message.id)) {
      selectedMessageIds.add(message.id);
    }
  }
  const compressibleMessages = agentHistory.filter((message) => (
    !protectedMessageIds.has(message.id) &&
    !recentMessageIds.has(message.id) &&
    !coveredMessageIds.has(message.id)
  ));
  const syntheticSystemMessages = summary
    ? [formatSyntheticSummaryMessage(summary, input.language)]
    : [];

  // Messages keep their (expandedContent ?? content) form for their whole life in
  // the projection so their serialized bytes never change between turns.
  const projectedHistory = agentHistory.filter((message) => selectedMessageIds.has(message.id));

  // Degraded-mode fallback: if no summary exists (compression refreshes keep
  // failing) and the projection would exceed the caller's token budget, keep only
  // the most recent messages instead of growing without bound until the request
  // exceeds the model context window. This truncation is a rare failure path, not
  // the normal cache-friendly append-only path.
  const history = !summary && input.maxProjectionTokens && projectedHistory.length
    ? capProjectionToTokenBudget(projectedHistory, input.maxProjectionTokens)
    : projectedHistory;

  const metadata: ContextProjectionMetadata = {
    usedSummary: Boolean(summary),
    summaryCount: summary ? 1 : 0,
    protectedMessageCount: protectedMessageIds.size,
    recentMessageCount: recentMessageIds.size,
    fallbackReason: summary || !compressibleMessages.length ? undefined : 'summary_unavailable'
  };

  return {
    history,
    syntheticSystemMessages,
    metadata,
    protectedMessageIds: Array.from(protectedMessageIds),
    recentMessageIds: Array.from(recentMessageIds),
    compressibleMessageIds: compressibleMessages.map((message) => message.id),
    usedSummaryIds: summary ? [summary.id] : []
  };
}

function capProjectionToTokenBudget(messages: ChatMessage[], maxTokens: number): ChatMessage[] {
  // Keeps only the most recent tail. In this degraded mode even protected messages
  // may be dropped: staying inside the model context window wins over protection
  // when compression has been failing and the conversation would otherwise exceed
  // the window. Normal (append-only) projection never takes this path.
  let tokenCount = 0;
  const capped: ChatMessage[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const content = (message.expandedContent ?? message.content).trim();
    tokenCount += estimateTokenCount(`${message.role}\n${content}`);
    if (tokenCount > maxTokens && capped.length) {
      break;
    }
    capped.unshift(message);
  }
  return capped;
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
