import type { AgentRunCallbacks } from '../../shared/types';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { AgentInteractionTrace } from '../logging/interactionTrace';
import type {
  DeepSeekAssistantMessage,
  DeepSeekChatRequestBody,
  DeepSeekUsage
} from '../deepseek/types';
import type { OpenAiResponsesItem, OpenAiResponsesRequestBody } from './responsesTypes';
import type { AnthropicAssistantContentBlock, AnthropicMessagesRequestBody } from './anthropicTypes';

export type ProviderClientFailureKind =
  | 'http'
  | 'empty_body'
  | 'empty_stream'
  | 'network'
  | 'stream'
  | 'protocol'
  | 'provider'
  | 'resource_limit'
  | 'external_abort'
  | 'run_time_limit'
  | 'request_timeout'
  | 'stream_idle_timeout';

export interface ProviderClientConfig {
  apiKey: string;
  baseUrl: string;
  streamIdleTimeoutMs: number;
  maxRequestRetries: number;
  requestRetryBaseMs: number;
}

export interface ProviderClientRequest {
  body: DeepSeekChatRequestBody | OpenAiResponsesRequestBody | AnthropicMessagesRequestBody;
  /** Authoritative projection serialized once by the caller, when supplied. */
  serializedBody?: string;
  language: KeepseekLanguage;
  signal?: AbortSignal;
  callbacks?: AgentRunCallbacks;
  runDeadlineAt?: number;
  trace?: AgentInteractionTrace;
  requestId?: string;
  /** Physical sends already dispatched for this logical model round. */
  initialAttemptCount?: number;
  /** Compatibility seed when only reconnects were persisted. */
  initialRetryCount?: number;
  /** Called immediately before each physical fetch, including retries. */
  onAttempt?: (attempt: { requestId: string; attemptIndex: number; startedAt: string }) => Promise<void> | void;
  /** Settles each physical attempt after transport cleanup, before any retry. */
  onAttemptResult?: (attempt: { attemptIndex: number; result: ProviderClientResult }) => Promise<void> | void;
}

export interface ProviderStreamProgress {
  usage?: DeepSeekUsage | null;
  semanticComplete: boolean;
  eventCount: number;
  receivedBytes: number;
  lastActivityAt: number;
  httpComplete: boolean;
  tailInterrupted?: boolean;
}

export interface ProviderStreamParseOptions {
  /** Maximum tail drain after a validated semantic terminal. */
  tailTimeoutMs?: number;
  trace?: AgentInteractionTrace;
  requestId?: string;
  attempt?: number;
  onStreamActivity?: () => void;
  onProgress?: (snapshot: ProviderStreamProgress) => void;
  signal?: AbortSignal;
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
  recoveryExhausted?: boolean;
  nativeOutputItems?: OpenAiResponsesItem[];
  nativeAnthropicContentBlocks?: AnthropicAssistantContentBlock[];
}

/**
 * 上游模型客户端的统一协议边界。每种账号类型（deepseek / kimi / glm /
 * qwencloud / ollama / openai-compatible / openai-responses / anthropic-compatible）
 * 由 factory 分发。
 */
export interface ProviderClient {
  createModelResponse(
    config: ProviderClientConfig,
    request: ProviderClientRequest
  ): Promise<ProviderClientResult>;
}
