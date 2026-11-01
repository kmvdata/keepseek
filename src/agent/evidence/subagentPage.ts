import { estimateTokenCount } from '../tokenEstimate';
import type { PreparedEvidenceEnvelope } from './shaping';

/** Admission preserves the canonical result identity. The evidence of this
 * delivery is never substituted for unread canonical bytes. */
export function prepareSubagentResultPage(raw: string, tokens: number, chars: number): PreparedEvidenceEnvelope {
  const wrap = (content: string, completeInline: boolean): PreparedEvidenceEnvelope => ({
    content, completeInline, inlineChars: content.length,
    inlineTokens: estimateTokenCount(content), contentType: 'structured'
  });
  let page: Record<string, unknown>;
  try { page = JSON.parse(raw); }
  catch { return wrap(JSON.stringify({ ok: false, errorType: 'subagent_result_page_invalid', bodyDelivered: false }), false); }
  if (!page || typeof page !== 'object' || Array.isArray(page)) {
    return wrap(JSON.stringify({ ok: false, errorType: 'subagent_result_page_invalid', bodyDelivered: false }), false);
  }
  const fits = (value: string) => value.length <= chars && estimateTokenCount(value) <= tokens;
  if (fits(raw)) return wrap(raw, true);
  const blocked = () => wrap(JSON.stringify({
    ok: false, errorType: 'subagent_result_capacity_blocked', bodyDelivered: false,
    ref: page.ref ?? page.subagentId, resultHash: page.resultHash,
    offsetBytes: page.offsetBytes, offset: page.offset,
    resultStatus: page.resultStatus, formatAccepted: page.formatAccepted,
    strategy: 'Release context at a controlled boundary, then read this same result and offset. No body was delivered.'
  }), false);
  if (page.ok !== true) return wrap(raw, true);
  if (typeof page.content !== 'string') return blocked();
  const byteMode = Number.isSafeInteger(page.offsetBytes) && Number(page.offsetBytes) >= 0;
  const charMode = !byteMode && Number.isSafeInteger(page.offset) && Number(page.offset) >= 0;
  if (!byteMode && !charMode) return blocked();
  const units = Array.from(page.content);
  const candidate = (count: number): string => {
    const content = units.slice(0, count).join('');
    const value: Record<string, unknown> = { ...page, content, bodyDelivered: count > 0, hasMore: true };
    if (byteMode) {
      value.returnedBytes = Buffer.byteLength(content, 'utf8');
      value.nextOffsetBytes = Number(page.offsetBytes) + Number(value.returnedBytes);
    } else {
      value.nextOffset = Number(page.offset) + content.length;
    }
    return JSON.stringify(value);
  };
  let low = 0, high = units.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (fits(candidate(middle))) low = middle;
    else high = middle - 1;
  }
  return low > 0 ? wrap(candidate(low), false) : blocked();
}
