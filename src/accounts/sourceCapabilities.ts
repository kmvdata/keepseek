import type { ModelSourceProvider } from './types';

export interface ModelSourceCapabilityInput {
  provider: ModelSourceProvider;
  baseUrl: string;
}

/** Billing and balance are supported only by the canonical DeepSeek API host. */
export function isOfficialDeepSeekSource(source: ModelSourceCapabilityInput): boolean {
  if (source.provider !== 'deepseek') {
    return false;
  }
  try {
    return new URL(source.baseUrl).host === 'api.deepseek.com';
  } catch {
    return false;
  }
}

/** Balance and official model discovery for Kimi use only the domestic canonical host. */
export function isOfficialKimiSource(source: ModelSourceCapabilityInput): boolean {
  if (source.provider !== 'kimi') {
    return false;
  }
  try {
    return new URL(source.baseUrl).host === 'api.moonshot.cn';
  } catch {
    return false;
  }
}

/** Official GLM model discovery uses only Zhipu's canonical domestic API host. */
export function isOfficialGlmSource(source: ModelSourceCapabilityInput): boolean {
  if (source.provider !== 'glm') {
    return false;
  }
  try {
    return new URL(source.baseUrl).host === 'open.bigmodel.cn';
  } catch {
    return false;
  }
}

/** Balance/cost preview is available only where a public, stable balance API is documented. */
export function supportsOfficialBillingSource(source: ModelSourceCapabilityInput): boolean {
  return isOfficialDeepSeekSource(source) || isOfficialKimiSource(source);
}

/** Prompt caching and required-key preflight apply only to Anthropic's canonical host. */
export function isOfficialAnthropicSource(source: ModelSourceCapabilityInput): boolean {
  if (source.provider !== 'anthropic-compatible') {
    return false;
  }
  try {
    return new URL(source.baseUrl).host === 'api.anthropic.com';
  } catch {
    return false;
  }
}

/** Canonical hosted endpoints require credentials; local/private compatible gateways may not. */
export function requiresModelSourceApiKey(source: ModelSourceCapabilityInput): boolean {
  return source.provider === 'deepseek'
    || isOfficialKimiSource(source)
    || isOfficialGlmSource(source)
    || isOfficialAnthropicSource(source);
}
