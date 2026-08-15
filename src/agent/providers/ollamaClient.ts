import { DEFAULT_OLLAMA_BASE_URL } from '../../accounts/accountStore';
import { OpenAICompatibleClient } from './openAiCompatibleClient';

/**
 * Ollama 本地部署分支：无需 API Key（空 key 时不发送 Authorization 头），
 * OpenAI 兼容端点固定挂在 /v1 下。Base URL 省略 /v1 时（例如
 * http://host:11434）自动补全，方便用户直接粘贴 Ollama 服务地址。
 */
export class OllamaClient extends OpenAICompatibleClient {
  public constructor() {
    super({
      displayName: 'Ollama',
      defaultBaseUrl: DEFAULT_OLLAMA_BASE_URL
    });
  }

  protected getChatCompletionsUrl(rawBaseUrl: string): string {
    const url = new URL(rawBaseUrl || this.defaultBaseUrl);
    const cleanPath = url.pathname.replace(/\/+$/u, '');

    if (cleanPath.endsWith('/chat/completions')) {
      url.pathname = cleanPath;
      return url.toString();
    }

    const versionedPath = /\/v1$/u.test(cleanPath) ? cleanPath : `${cleanPath || ''}/v1`;
    url.pathname = `${versionedPath}/chat/completions`;
    return url.toString();
  }
}
