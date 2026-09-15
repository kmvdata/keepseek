import { createHash } from 'node:crypto';
import type { DraftEdit, DraftRun } from '../shared/types';
import type { BoundedReviewText } from './approvalReviewTypes';
import { canonicalPatchPayload } from '../edits/textPatch';

export const MAX_REVIEW_CHANGE_CHARS = 48_000;

export function hashApprovalValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

export function hashApprovalText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hashDraftEditAction(edit: DraftEdit, originalTextHash = ''): string {
  if (edit.kind === 'text_patch_v1') {
    return hashApprovalValue({
      payloadVersion: edit.kind,
      uri: edit.uri,
      action: edit.action,
      reason: edit.reason,
      base: { sha256: edit.patch.base.sha256, sizeBytes: edit.patch.base.sizeBytes },
      result: { sha256: edit.patch.result.sha256, sizeBytes: edit.patch.result.sizeBytes },
      patch: canonicalPatchPayload(edit.patch)
    });
  }
  if (edit.kind === 'full_text_v1') {
    return hashApprovalValue({
      payloadVersion: edit.kind,
      uri: edit.uri,
      action: edit.action,
      reason: edit.reason,
      base: edit.base ?? null,
      result: edit.result,
      contentBlobHash: edit.contentBlobHash ?? null
    });
  }
  if (edit.kind === 'delete_v1') {
    return hashApprovalValue({ payloadVersion: edit.kind, uri: edit.uri, action: edit.action, reason: edit.reason, base: edit.base });
  }
  if (edit.kind === 'move_v1') {
    return hashApprovalValue({
      payloadVersion: edit.kind, uri: edit.uri, targetUri: edit.targetUri,
      sourceUri: edit.sourceUri, action: edit.action, reason: edit.reason,
      base: edit.base, result: edit.base
    });
  }
  return hashApprovalValue({
    action: edit.action,
    uri: edit.uri,
    newText: edit.newText,
    reason: edit.reason,
    expectedOriginalTextHash: originalTextHash || edit.expectedOriginalTextHash || '',
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
