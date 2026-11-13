import { isRecord } from '../shared/errors';
import type {
  AnthropicMessagesReplayState,
  AnthropicReplayContentBlock,
  AnthropicReplayMessage,
  OpenAiResponsesReplayItem,
  OpenAiResponsesReplayState,
  ProviderReplayState
} from '../shared/types';

// Persisted native replay is accepted atomically; unknown blocks must never be replayed.
const MAX_PROVIDER_REPLAY_BYTES = 2_000_000;
const MAX_PROVIDER_REPLAY_ITEMS = 1_024;
const MAX_PROVIDER_REPLAY_BLOCKS = 4_096;
const OPENAI_RESPONSES_REPLAY_ITEM_TYPES = new Set([
  'message',
  'reasoning',
  'function_call',
  'function_call_output'
]);

export function normalizeProviderReplay(value: unknown): ProviderReplayState | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value.protocol === 'openai-responses'
    ? normalizeOpenAiResponsesReplay(value)
    : value.protocol === 'anthropic-messages'
      ? normalizeAnthropicMessagesReplay(value)
      : undefined;
}

export function normalizeOpenAiResponsesReplay(value: unknown): OpenAiResponsesReplayState | undefined {
  if (!isRecord(value)
    || value.protocol !== 'openai-responses'
    || typeof value.sourceId !== 'string'
    || !value.sourceId.trim()
    || typeof value.baseUrl !== 'string'
    || !value.baseUrl.trim()
    || !Array.isArray(value.items)
    || !value.items.length
    || value.items.length > MAX_PROVIDER_REPLAY_ITEMS) {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value.items);
  } catch {
    return undefined;
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_PROVIDER_REPLAY_BYTES) {
    return undefined;
  }
  let items: OpenAiResponsesReplayItem[];
  try {
    const cloned: unknown = JSON.parse(serialized);
    if (!Array.isArray(cloned) || !cloned.every(isValidOpenAiResponsesReplayItem)) {
      return undefined;
    }
    items = cloned;
  } catch {
    return undefined;
  }
  return {
    protocol: 'openai-responses',
    sourceId: value.sourceId.trim(),
    baseUrl: value.baseUrl.trim(),
    items
  };
}

export function normalizeAnthropicMessagesReplay(
  value: unknown
): AnthropicMessagesReplayState | undefined {
  if (!isRecord(value)
    || value.protocol !== 'anthropic-messages'
    || typeof value.sourceId !== 'string'
    || !value.sourceId.trim()
    || typeof value.baseUrl !== 'string'
    || !value.baseUrl.trim()
    || !Array.isArray(value.messages)
    || !value.messages.length
    || value.messages.length > MAX_PROVIDER_REPLAY_ITEMS) {
    return undefined;
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value.messages);
  } catch {
    return undefined;
  }
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > MAX_PROVIDER_REPLAY_BYTES) {
    return undefined;
  }
  try {
    const cloned: unknown = JSON.parse(serialized);
    if (!Array.isArray(cloned)) {
      return undefined;
    }
    let blockCount = 0;
    const messages: AnthropicReplayMessage[] = [];
    for (const message of cloned) {
      if (!isValidAnthropicReplayMessage(message)) {
        return undefined;
      }
      blockCount += message.content.length;
      if (blockCount > MAX_PROVIDER_REPLAY_BLOCKS) {
        return undefined;
      }
      messages.push(message);
    }
    if (!isValidAnthropicReplaySequence(messages)) {
      return undefined;
    }
    return {
      protocol: 'anthropic-messages',
      sourceId: value.sourceId.trim(),
      baseUrl: value.baseUrl.trim(),
      messages
    };
  } catch {
    return undefined;
  }
}

function isValidAnthropicReplaySequence(messages: AnthropicReplayMessage[]): boolean {
  const seenToolUseIds = new Set<string>();
  let pendingToolUseIds: string[] = [];
  for (const message of messages) {
    if (message.role === 'assistant') {
      if (pendingToolUseIds.length) {
        return false;
      }
      pendingToolUseIds = message.content
        .filter((block): block is Extract<AnthropicReplayContentBlock, { type: 'tool_use' }> => block.type === 'tool_use')
        .map((block) => block.id);
      if (pendingToolUseIds.some((id) => seenToolUseIds.has(id))) {
        return false;
      }
      pendingToolUseIds.forEach((id) => seenToolUseIds.add(id));
      continue;
    }

    const resultIds = message.content
      .filter((block): block is Extract<AnthropicReplayContentBlock, { type: 'tool_result' }> => block.type === 'tool_result')
      .map((block) => block.tool_use_id);
    if (resultIds.length) {
      const firstTextIndex = message.content.findIndex((block) => block.type === 'text');
      const lastResultIndex = message.content.reduce(
        (last, block, index) => block.type === 'tool_result' ? index : last,
        -1
      );
      if (firstTextIndex >= 0 && firstTextIndex < lastResultIndex) {
        return false;
      }
      if (resultIds.length !== pendingToolUseIds.length
        || resultIds.some((id, index) => id !== pendingToolUseIds[index])) {
        return false;
      }
      pendingToolUseIds = [];
    } else if (pendingToolUseIds.length) {
      return false;
    }
  }
  return pendingToolUseIds.length === 0;
}

function isValidAnthropicReplayMessage(value: unknown): value is AnthropicReplayMessage {
  if (!isRecord(value)
    || (value.role !== 'user' && value.role !== 'assistant')
    || !Array.isArray(value.content)
    || !value.content.length) {
    return false;
  }
  return value.role === 'assistant'
    ? value.content.every((block) => isValidAnthropicReplayBlock(block, 'assistant'))
    : value.content.every((block) => isValidAnthropicReplayBlock(block, 'user'));
}

function isValidAnthropicReplayBlock(
  value: unknown,
  role: AnthropicReplayMessage['role']
): value is AnthropicReplayContentBlock {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string';
    case 'thinking':
      return role === 'assistant'
        && typeof value.thinking === 'string'
        && typeof value.signature === 'string'
        && Boolean(value.signature);
    case 'redacted_thinking':
      return role === 'assistant' && typeof value.data === 'string' && Boolean(value.data);
    case 'tool_use':
      return role === 'assistant'
        && typeof value.id === 'string' && Boolean(value.id)
        && typeof value.name === 'string' && Boolean(value.name)
        && isRecord(value.input) && isJsonSafeValue(value.input);
    case 'tool_result':
      return role === 'user'
        && typeof value.tool_use_id === 'string' && Boolean(value.tool_use_id)
        && typeof value.content === 'string'
        && (value.is_error === undefined || typeof value.is_error === 'boolean');
    default:
      return false;
  }
}

function isJsonSafeValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonSafeValue);
  return isRecord(value) && Object.values(value).every(isJsonSafeValue);
}

function isValidOpenAiResponsesReplayItem(value: unknown): value is OpenAiResponsesReplayItem {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === undefined) {
    return (value.role === 'user' || value.role === 'assistant' || value.role === 'system')
      && typeof value.content === 'string';
  }
  if (typeof value.type !== 'string' || !OPENAI_RESPONSES_REPLAY_ITEM_TYPES.has(value.type)) {
    return false;
  }
  switch (value.type) {
    case 'message':
      return (value.role === 'assistant' || value.role === 'user' || value.role === 'system')
        && isValidOpenAiResponsesMessageContent(value.content);
    case 'reasoning':
      return true;
    case 'function_call':
      return typeof value.call_id === 'string'
        && Boolean(value.call_id)
        && typeof value.name === 'string'
        && typeof value.arguments === 'string';
    case 'function_call_output':
      return typeof value.call_id === 'string'
        && Boolean(value.call_id)
        && typeof value.output === 'string';
    default:
      return false;
  }
}

function isValidOpenAiResponsesMessageContent(value: unknown): boolean {
  if (typeof value === 'string') {
    return true;
  }
  return Array.isArray(value) && value.every((part) => isRecord(part) && (
    (part.type === 'output_text' && typeof part.text === 'string')
    || (part.type === 'refusal' && typeof part.refusal === 'string')
  ));
}

