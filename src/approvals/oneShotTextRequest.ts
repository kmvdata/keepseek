import { buildOneShotTextProviderBody, requestOneShotText, type OneShotTextRequestInput } from '../agent/oneShotTextRequest';

/** Compatibility boundary: reviewer purpose, output policy and source remain unchanged. */
export const buildApprovalReviewerProviderBody = buildOneShotTextProviderBody;

export function requestApprovalReviewText(input: Omit<OneShotTextRequestInput, 'purpose' | 'requestId' | 'maxOutputTokens' | 'timeoutMs' | 'onBudgetChanged'>): Promise<string> {
  return requestOneShotText({ ...input, purpose: 'approval_review' });
}
