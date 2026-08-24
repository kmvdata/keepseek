import type { OpenAiResponsesReplayItem } from '../../shared/types';
import type { DeepSeekAssistantMessage, DeepSeekUsage } from '../deepseek/types';

/** JSON-safe Responses item retained byte-for-byte within one provider lane. */
export type OpenAiResponsesItem = OpenAiResponsesReplayItem;

export interface OpenAiResponsesFunctionTool {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  strict: boolean;
}

export interface OpenAiResponsesRequestBody {
  model: string;
  input: OpenAiResponsesItem[];
  stream: true;
  store: false;
  tools?: OpenAiResponsesFunctionTool[];
  tool_choice?: 'auto' | 'none';
  max_output_tokens?: number;
  include?: ['reasoning.encrypted_content'];
  reasoning?: {
    effort: 'high';
  };
  temperature?: number;
  top_p?: number;
}

export interface OpenAiResponsesStreamResult {
  message: DeepSeekAssistantMessage;
  finishReason?: string | null;
  usage?: DeepSeekUsage | null;
  outputItems: OpenAiResponsesItem[];
}
