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
