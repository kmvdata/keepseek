import { DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL } from '../../accounts/accountStore';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { AgentRunCallbacks } from '../../shared/types';
import type { AgentInteractionTrace } from '../logging/interactionTrace';
import { OpenAICompatibleClient } from './openAiCompatibleClient';
import { AnthropicStreamParser } from './anthropicStreamParser';
import type { AnthropicMessagesStreamResult } from './anthropicTypes';
import type { ProviderClientConfig } from './types';

export class AnthropicMessagesClient extends OpenAICompatibleClient {
  private readonly anthropicStreamParser = new AnthropicStreamParser();

  public constructor() {
    super({
      displayName: 'Anthropic compatible',
      defaultBaseUrl: DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL
    });
  }

  protected getRequestUrl(rawBaseUrl: string): string {
    return getAnthropicMessagesEndpointUrl(rawBaseUrl || this.defaultBaseUrl);
  }

  protected buildRequestHeaders(config: ProviderClientConfig): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Content-Type': 'application/json',
      'anthropic-version': '2023-06-01'
    };
    if (config.apiKey.trim()) {
      headers['x-api-key'] = config.apiKey;
    }
    return headers;
  }

  protected async parseStream(
    body: NonNullable<Response['body']>,
    language: KeepseekLanguage,
    callbacks: AgentRunCallbacks,
    options: {
      trace?: AgentInteractionTrace;
      requestId?: string;
      attempt?: number;
      onStreamActivity?: () => void;
    }
  ): Promise<AnthropicMessagesStreamResult> {
    return await this.anthropicStreamParser.parse(body, language, callbacks, options);
  }
}

export function getAnthropicMessagesEndpointUrl(rawBaseUrl: string): string {
  const url = new URL(rawBaseUrl || DEFAULT_ANTHROPIC_COMPATIBLE_BASE_URL);
  const cleanPath = url.pathname.replace(/\/+$/u, '');
  if (url.host === 'api.anthropic.com' && !cleanPath) {
    url.pathname = '/v1/messages';
    url.hash = '';
    return url.toString();
  }
  if (cleanPath.endsWith('/apps/anthropic')) {
    url.pathname = `${cleanPath}/v1/messages`;
    url.hash = '';
    return url.toString();
  }
  url.pathname = cleanPath.endsWith('/messages')
    ? cleanPath
    : `${cleanPath || ''}/messages`;
  url.hash = '';
  return url.toString();
}
