import type { AgentRunCallbacks } from '../../shared/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { AgentInteractionTrace } from '../logging/interactionTrace';
import type {
  DeepSeekAssistantMessage,
  DeepSeekChatRequestBody,
  DeepSeekUsage
} from '../deepseek/types';
import type { OpenAiResponsesItem, OpenAiResponsesRequestBody } from './responsesTypes';

export type ProviderClientFailureKind =
  | 'http'
  | 'empty_body'
  | 'empty_stream'
  | 'network'
  | 'stream'
  | 'external_abort'
  | 'run_time_limit'
  | 'stream_idle_timeout';

export interface ProviderClientConfig {
  apiKey: string;
  baseUrl: string;
  streamIdleTimeoutMs: number;
  maxRequestRetries: number;
  requestRetryBaseMs: number;
}

export interface ProviderClientRequest {
  body: DeepSeekChatRequestBody | OpenAiResponsesRequestBody;
  language: KeepseekLanguage;
  signal?: AbortSignal;
  callbacks?: AgentRunCallbacks;
  runDeadlineAt?: number;
  trace?: AgentInteractionTrace;
  requestId?: string;
}

export interface ProviderClientResult {
  ok: boolean;
  finishReason?: string | null;
  message?: DeepSeekAssistantMessage;
  usage?: DeepSeekUsage | null;
  hadPartialOutput: boolean;
  retryable: boolean;
  error?: string;
  failureKind?: ProviderClientFailureKind;
  status?: number;
  attemptCount?: number;
  retryCount?: number;
  nativeOutputItems?: OpenAiResponsesItem[];
}

/**
 * 上游模型客户端的统一协议边界。每种账号类型（deepseek / ollama /
 * openai-compatible / openai-responses）由 providers/factory 按类型分发。
 */
export interface ProviderClient {
  createModelResponse(
    config: ProviderClientConfig,
    request: ProviderClientRequest
  ): Promise<ProviderClientResult>;
}
