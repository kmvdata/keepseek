import { DEFAULT_OPENAI_RESPONSES_BASE_URL } from '../../accounts/accountStore';
import type { KeepseekLanguage } from '../../shared/i18n';
import type { AgentRunCallbacks } from '../../shared/types';
import type { AgentInteractionTrace } from '../logging/interactionTrace';
import { OpenAICompatibleClient } from './openAiCompatibleClient';
import { ResponsesStreamParser } from './responsesStreamParser';
import type { OpenAiResponsesStreamResult } from './responsesTypes';

export class OpenAiResponsesClient extends OpenAICompatibleClient {
  private readonly responsesStreamParser = new ResponsesStreamParser();

  public constructor() {
    super({
      displayName: 'OpenAI Responses compatible',
      defaultBaseUrl: DEFAULT_OPENAI_RESPONSES_BASE_URL
    });
  }

  protected getRequestUrl(rawBaseUrl: string): string {
    return getOpenAiResponsesEndpointUrl(rawBaseUrl || this.defaultBaseUrl);
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
  ): Promise<OpenAiResponsesStreamResult> {
    return await this.responsesStreamParser.parse(body, language, callbacks, options);
  }
}

export function getOpenAiResponsesEndpointUrl(rawBaseUrl: string): string {
  const url = new URL(rawBaseUrl || DEFAULT_OPENAI_RESPONSES_BASE_URL);
  const cleanPath = url.pathname.replace(/\/+$/u, '');
  const chatCompletionsSuffix = '/chat/completions';
  const withoutChatCompletions = cleanPath.endsWith(chatCompletionsSuffix)
    ? cleanPath.slice(0, -chatCompletionsSuffix.length)
    : cleanPath;
  url.pathname = withoutChatCompletions.endsWith('/responses')
    ? withoutChatCompletions
    : `${withoutChatCompletions || ''}/responses`;
  url.hash = '';
  return url.toString();
}
