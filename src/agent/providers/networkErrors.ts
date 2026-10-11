const transientCodes = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  'ENETDOWN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'KEEPSEEK_HEADERS_TIMEOUT'
]);

/** Bounded traversal also handles fetch's nested causes and AggregateError. */
export function isRecoverableNetworkError(error: unknown): boolean {
  const pending: Array<{ value: unknown; depth: number }> = [{ value: error, depth: 0 }];
  const seen = new Set<object>();
  let recoverable = false;
  let count = 0;
  while (pending.length && count++ < 24) {
    const { value, depth } = pending.shift()!;
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    const record = value as { name?: unknown; message?: unknown; code?: unknown; cause?: unknown; errors?: unknown };
    const name = typeof record.name === 'string' ? record.name : '';
    const code = typeof record.code === 'string' ? record.code : '';
    const message = typeof record.message === 'string' ? record.message.toLowerCase() : '';
    if (name === 'AbortError' || name === 'ProviderStreamProtocolError' || name === 'ProviderStreamProviderError'
      || /CERT|TLS|SSL|ERR_INVALID|ENOTFOUND|EACCES|EPERM/u.test(code)
      || /resource limit|资源上限|certificate|self.signed|invalid url|unsupported protocol|cannot parse|无法解析/u.test(message)) return false;
    if (name === 'ProviderIncompleteStreamError' || transientCodes.has(code)) recoverable = true;
    if (name === 'TypeError' && /fetch failed|terminated|socket|network/u.test(message)) recoverable = true;
    if (code && !transientCodes.has(code) && name !== 'ProviderIncompleteStreamError') return false;
    if (depth < 4) {
      if (record.cause !== undefined) pending.push({ value: record.cause, depth: depth + 1 });
      if (Array.isArray(record.errors)) for (const inner of record.errors.slice(0, 8)) pending.push({ value: inner, depth: depth + 1 });
    }
  }
  return recoverable;
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_147_483_647, Math.ceil(seconds * 1000));
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, Math.min(2_147_483_647, timestamp - now)) : undefined;
}
