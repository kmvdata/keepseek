import type { ModelSourceProvider } from '../accounts/types';
import type { ModelSourceBalanceState } from '../shared/types';
import { getConfiguredBalanceEndpointUrl } from '../shared/config';
import {
  isOfficialDeepSeekSource,
  isOfficialKimiSource
} from '../accounts/sourceCapabilities';
import { fetchDeepSeekBalance } from './deepseek/balance';
import { fetchKimiBalance } from './kimi/balance';

export interface ModelSourceBalanceRequest {
  provider: ModelSourceProvider;
  apiKey: string;
  baseUrl: string;
  signal?: AbortSignal;
}

/** Dispatches balance requests without mixing provider-specific response schemas. */
export async function fetchModelSourceBalance(
  input: ModelSourceBalanceRequest
): Promise<ModelSourceBalanceState> {
  if (isOfficialDeepSeekSource(input)) {
    return fetchDeepSeekBalance({
      apiKey: input.apiKey,
      endpointUrl: getConfiguredBalanceEndpointUrl(input.baseUrl),
      signal: input.signal
    });
  }
  if (isOfficialKimiSource(input)) {
    return fetchKimiBalance({ apiKey: input.apiKey, signal: input.signal });
  }
  return {
    currency: '¥',
    error: `Balance preview is unavailable for provider ${input.provider}.`,
    updatedAt: new Date().toISOString()
  };
}
