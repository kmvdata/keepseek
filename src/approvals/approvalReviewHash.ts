import { createHash } from 'node:crypto';
import type { DraftEdit, DraftRun } from '../shared/types';
import type { BoundedReviewText } from './approvalReviewTypes';

export const MAX_REVIEW_CHANGE_CHARS = 48_000;

export function hashApprovalValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function hashApprovalText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashDraftEditAction(edit: DraftEdit, originalTextHash = edit.expectedOriginalTextHash ?? ''): string {
  return hashApprovalValue({
    action: edit.action,
    uri: edit.uri,
    newText: edit.newText,
    reason: edit.reason,
    expectedOriginalTextHash: originalTextHash,
    expectedOriginalSize: edit.expectedOriginalSize ?? null
  });
}

export function hashDraftRunAction(draftRun: Pick<DraftRun, 'specHash'>): string {
  return draftRun.specHash;
}

export function createBoundedReviewText(content: string, maxChars = MAX_REVIEW_CHANGE_CHARS): BoundedReviewText {
  // Preserve exact bytes-as-text semantics: line-ending normalization would
  // make contentHash describe a different file from the one being approved.
  const totalChars = content.length;
  if (totalChars <= maxChars) {
    return { content, totalChars, contentHash: hashApprovalText(content), truncated: false };
  }
  const marker = '\n...[deterministically truncated for approval review]...\n';
  const available = Math.max(0, maxChars - marker.length);
  const headChars = Math.ceil(available / 2);
  const tailChars = Math.floor(available / 2);
  return {
    content: content.slice(0, headChars) + marker + content.slice(content.length - tailChars),
    totalChars,
    contentHash: hashApprovalText(content),
    truncated: true
  };
}
