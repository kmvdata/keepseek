import type { DeepSeekStreamResult } from '../deepseek/types';

export type AnthropicJsonValue =
  | string
  | number
  | boolean
  | null
  | AnthropicJsonValue[]
  | { [key: string]: AnthropicJsonValue };

export type AnthropicAssistantContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: { [key: string]: AnthropicJsonValue } };

export type AnthropicUserContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type AnthropicMessage =
  | { role: 'assistant'; content: AnthropicAssistantContentBlock[] }
  | { role: 'user'; content: AnthropicUserContentBlock[] };

export interface AnthropicSystemTextBlock {
  type: 'text';
  text: string;
}

export interface AnthropicFunctionTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  strict?: boolean;
}

export interface AnthropicMessagesRequestBody {
  model: string;
  system: AnthropicSystemTextBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicFunctionTool[];
  tool_choice?: { type: 'auto' | 'none' };
  stream: true;
  max_tokens: number;
  thinking?:
    | { type: 'adaptive'; display: 'summarized' }
    | { type: 'enabled'; budget_tokens: number };
  output_config?: { effort: 'max' };
  temperature?: number;
  cache_control?: { type: 'ephemeral' };
}

export interface AnthropicMessagesStreamResult extends DeepSeekStreamResult {
  contentBlocks: AnthropicAssistantContentBlock[];
  stopReason?: string | null;
}
