import type { ReasoningEffort } from '../../shared/types';

export type DeepSeekRole = 'system' | 'user' | 'assistant' | 'tool';
export type DeepSeekThinkingType = 'enabled' | 'disabled';

export interface DeepSeekMessage {
  role: DeepSeekRole;
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekToolCall[];
  tool_call_id?: string;
}

export interface DeepSeekFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
      additionalProperties?: boolean;
    };
    strict?: boolean;
  };
}

export interface DeepSeekToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface DeepSeekToolCallDelta {
  index?: number;
  id?: string;
  type?: 'function';
  function?: {
    name?: string;
    arguments?: string;
  };
}

export interface DeepSeekAssistantMessage {
  role?: 'assistant';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekToolCall[] | null;
}

export interface DeepSeekStreamDelta {
  role?: 'assistant';
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: DeepSeekToolCallDelta[] | null;
}

export interface DeepSeekStreamChoice {
  delta?: DeepSeekStreamDelta;
  finish_reason?: string | null;
}

export interface DeepSeekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
    [key: string]: unknown;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface DeepSeekStreamChunk {
  choices?: DeepSeekStreamChoice[];
  usage?: DeepSeekUsage | null;
}

export interface DeepSeekStreamResult {
  message: DeepSeekAssistantMessage;
  finishReason?: string | null;
  usage?: DeepSeekUsage | null;
}

export interface DeepSeekChatRequestBody {
  model: string;
  messages: DeepSeekMessage[];
  stream: true;
  thinking?: {
    type: DeepSeekThinkingType;
  };
  reasoning_effort?: ReasoningEffort;
  tools?: DeepSeekFunctionTool[];
  tool_choice?: 'auto' | 'none';
  max_tokens?: number;
  stream_options?: {
    include_usage?: boolean;
  };
}

export interface ParsedDsmlToolCalls {
  content: string;
  toolCalls: DeepSeekToolCall[];
}
