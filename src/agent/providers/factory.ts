import type { AccountApiType } from '../../accounts/types';
import { DeepSeekClient } from './deepseekClient';
import { OllamaClient } from './ollamaClient';
import { OpenAICompatibleClient } from './openAiCompatibleClient';
import { OpenAiResponsesClient } from './openAiResponsesClient';
import { AnthropicMessagesClient } from './anthropicMessagesClient';
import type { ProviderClient } from './types';

// 客户端是无状态的，按 provider 复用单例。
const deepSeekClient = new DeepSeekClient();
const ollamaClient = new OllamaClient();
const openAiCompatibleClient = new OpenAICompatibleClient({ displayName: 'OpenAI Compatible' });
const openAiResponsesClient = new OpenAiResponsesClient();
const anthropicMessagesClient = new AnthropicMessagesClient();

/**
 * 按账号类型返回对应的上游客户端实现：
 * - deepseek → DeepSeek 官方协议分支
 * - ollama → Ollama 分支（免 API Key、/v1 端点补全）
 * - openai-compatible → Chat Completions 兼容分支
 * - openai-responses → Responses API 兼容分支
 * - anthropic-compatible → Anthropic Messages 兼容分支
 */
export function createProviderClient(provider: AccountApiType): ProviderClient {
  switch (provider) {
    case 'deepseek':
      return deepSeekClient;
    case 'ollama':
      return ollamaClient;
    case 'openai-compatible':
      return openAiCompatibleClient;
    case 'openai-responses':
      return openAiResponsesClient;
    case 'anthropic-compatible':
      return anthropicMessagesClient;
    default:
      return openAiCompatibleClient;
  }
}
