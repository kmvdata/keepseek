import type { DeepSeekBalanceState } from '../../shared/types';

export interface DeepSeekBalanceRequest {
  apiKey: string;
  endpointUrl: string;
  signal?: AbortSignal;
}

export async function fetchDeepSeekBalance(input: DeepSeekBalanceRequest): Promise<DeepSeekBalanceState> {
  const apiKey = input.apiKey.trim();
  const endpointUrl = input.endpointUrl.trim();
  if (!apiKey) {
    return {
      currency: '¥',
      error: 'Missing DeepSeek API key.',
      updatedAt: new Date().toISOString()
    };
  }
  if (!endpointUrl) {
    return {
      currency: '¥',
      error: 'Missing DeepSeek balance endpoint URL.',
      updatedAt: new Date().toISOString()
    };
  }

  try {
    const response = await fetch(endpointUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      signal: input.signal
    });

    if (!response.ok) {
      return createBalanceError(`DeepSeek balance request failed (${response.status}).`);
    }

    const parsed: unknown = await response.json();
    return parseDeepSeekBalanceResponse(parsed);
  } catch (error) {
    return createBalanceError(error instanceof Error ? error.message : String(error));
  }
}

export function parseDeepSeekBalanceResponse(value: unknown): DeepSeekBalanceState {
  const now = new Date().toISOString();
  if (!isRecord(value)) {
    return {
      currency: '¥',
      error: 'DeepSeek balance response is not a JSON object.',
      updatedAt: now
    };
  }

  const balanceInfos = Array.isArray(value.balance_infos) ? value.balance_infos.filter(isRecord) : [];
  const selected = balanceInfos.find((item) => normalizeCurrencyCode(item.currency) === 'CNY') ?? balanceInfos[0];
  if (!selected) {
    return {
      currency: '¥',
      isAvailable: value.is_available === true,
      error: 'DeepSeek balance response did not include balance_infos.',
      updatedAt: now
    };
  }

  const totalBalance = readOptionalFiniteNumber(selected.total_balance);
  if (totalBalance === undefined) {
    return {
      currency: toDisplayCurrency(selected.currency),
      isAvailable: value.is_available === true,
      error: 'DeepSeek balance response did not include total_balance.',
      updatedAt: now
    };
  }

  return {
    totalBalance,
    currency: toDisplayCurrency(selected.currency),
    isAvailable: value.is_available === true,
    updatedAt: now
  };
}

function createBalanceError(error: string): DeepSeekBalanceState {
  return {
    currency: '¥',
    error,
    updatedAt: new Date().toISOString()
  };
}

function normalizeCurrencyCode(value: unknown): string {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function toDisplayCurrency(value: unknown): string {
  const normalized = normalizeCurrencyCode(value);
  if (normalized === 'CNY') {
    return '¥';
  }
  return normalized || '¥';
}

function readOptionalFiniteNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
