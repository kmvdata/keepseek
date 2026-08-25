import type { ModelSourceBalanceState } from '../../shared/types';

export const KIMI_BALANCE_ENDPOINT_URL = 'https://api.moonshot.cn/v1/users/me/balance';

export interface KimiBalanceRequest {
  apiKey: string;
  signal?: AbortSignal;
}

const BALANCE_FETCH_TIMEOUT_MS = 10_000;

export async function fetchKimiBalance(input: KimiBalanceRequest): Promise<ModelSourceBalanceState> {
  const apiKey = input.apiKey.trim();
  if (!apiKey) {
    return createBalanceError('Missing Kimi API key.');
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), BALANCE_FETCH_TIMEOUT_MS);
    const onExternalAbort = (): void => controller.abort();
    input.signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const response = await fetch(KIMI_BALANCE_ENDPOINT_URL, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        signal: controller.signal
      });
      if (!response.ok) {
        return createBalanceError(`Kimi balance request failed (${response.status}).`);
      }
      return parseKimiBalanceResponse(await response.json());
    } finally {
      clearTimeout(timeout);
      input.signal?.removeEventListener('abort', onExternalAbort);
    }
  } catch (error) {
    return createBalanceError(error instanceof Error ? error.message : String(error));
  }
}

export function parseKimiBalanceResponse(value: unknown): ModelSourceBalanceState {
  const now = new Date().toISOString();
  if (!isRecord(value)) {
    return createBalanceError('Kimi balance response is not a JSON object.', now);
  }
  if (value.code !== 0 || value.status !== true || !isRecord(value.data)) {
    return createBalanceError('Kimi balance response did not report a successful result.', now);
  }

  const totalBalance = readOptionalFiniteNumber(value.data.available_balance);
  if (totalBalance === undefined) {
    return createBalanceError('Kimi balance response did not include available_balance.', now);
  }
  return {
    totalBalance,
    cashBalance: readOptionalFiniteNumber(value.data.cash_balance),
    voucherBalance: readOptionalFiniteNumber(value.data.voucher_balance),
    currency: '¥',
    isAvailable: totalBalance > 0,
    updatedAt: now
  };
}

function createBalanceError(error: string, updatedAt = new Date().toISOString()): ModelSourceBalanceState {
  return { currency: '¥', error, updatedAt };
}

function readOptionalFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
