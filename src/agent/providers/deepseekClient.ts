import { DEFAULT_DEEPSEEK_BASE_URL } from '../../shared/config';
import { OpenAICompatibleClient } from './openAiCompatibleClient';

/**
 * DeepSeek 官方账号分支：OpenAI 兼容传输 + DeepSeek 官方端点。
 * 官方专属能力（余额 / 用量 / DSML 工具解析）由 src/agent/deepseek/
 * 下的模块承载，这里只负责上游对话请求。
 */
export class DeepSeekClient extends OpenAICompatibleClient {
  public constructor() {
    super({
      displayName: 'DeepSeek',
      defaultBaseUrl: DEFAULT_DEEPSEEK_BASE_URL
    });
  }
}
