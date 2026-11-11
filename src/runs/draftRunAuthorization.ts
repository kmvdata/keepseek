import { randomUUID } from 'node:crypto';
import type { DraftRun, ExecutionPermit } from '../shared/types';
import { APPROVAL_POLICY_VERSION, type ApprovalRecordMatch } from '../approvals/approvalReviewTypes';
import { hashDraftRunEffect } from '../approvals/approvalReviewHash';
import type { ApprovalReviewStore } from '../approvals/approvalReviewStore';
import { assertValidGitCommitArguments } from '../approvals/authorization/executionBoundary';

const PERMIT_TTL_MS = 30_000;

export class DraftRunAuthorizationService {
  public constructor(private readonly approvalReviews?: ApprovalReviewStore) {}

  public async createDelegatedPermit(
    draftRun: DraftRun,
    isAuthorized: () => boolean,
    match?: ApprovalRecordMatch
  ): Promise<ExecutionPermit> {
    if (draftRun.historyInvalidationId || draftRun.historyOriginUnverified) throw new Error('DraftRun was detached by editing its source history.');
    assertValidGitCommitArguments(draftRun.spec);
    if (!isAuthorized()) throw new Error('Delegated approval was revoked or is no longer authorized.');
    if (!this.approvalReviews || !match) {
      throw new Error('Delegated permit requires a persisted matching approval record.');
    }
    if (match.targetId !== draftRun.id || match.actionHash !== draftRun.specHash
      || match.sessionId !== draftRun.sessionId || match.agentRunId !== draftRun.agentRunId
      || match.actionKind !== 'draft_run_execute') {
      throw new Error('Delegated approval record does not match the immutable DraftRun.');
    }
    await this.approvalReviews.consumeMatchingApproval(match);
    if (!isAuthorized()) throw new Error('Delegated approval was revoked before permit issuance.');
    return { ...this.createUserClickPermit(draftRun), source: match.expectedSource === 'user_click' ? 'user_click' : 'delegated_approver' };
  }

  public createUserClickPermit(draftRun: DraftRun): ExecutionPermit {
    if (draftRun.historyInvalidationId || draftRun.historyOriginUnverified) throw new Error('DraftRun was detached by editing its source history.');
    assertValidGitCommitArguments(draftRun.spec);
    const denial = this.findSafetyDenial(draftRun);
    if (denial) throw new Error(denial.rationale);
    return {
      draftRunId: draftRun.id,
      specHash: draftRun.specHash,
      source: 'user_click',
      allowedEffects: [...draftRun.effectAssessment.effects],
      policyVersion: 1,
      expiresAt: Date.now() + PERMIT_TTL_MS,
      nonce: randomUUID()
    };
  }

  public hasHistoricalUnavailableReview(draftRun: DraftRun): boolean {
    const review = draftRun.approvalReview && this.approvalReviews?.get(draftRun.approvalReview.reviewId);
    return !!review && review.policyVersion < APPROVAL_POLICY_VERSION && review.decision === 'unavailable'
      && review.approvalSource === 'auto_approval_review' && !review.historyInvalidatedBy
      && review.sessionId === draftRun.sessionId && review.agentRunId === draftRun.agentRunId
      && review.targetId === draftRun.id && review.actionKind === 'draft_run_execute'
      && review.actionHash === draftRun.specHash && !this.findSafetyDenial(draftRun);
  }

  private findSafetyDenial(draftRun: DraftRun) {
    return this.approvalReviews?.findSafetyDenial({
      sessionId: draftRun.sessionId, actionKind: 'draft_run_execute', actionHash: draftRun.specHash, effectHash: hashDraftRunEffect(draftRun)
    }) ?? (draftRun.spec.restricted && this.approvalReviews?.findHardRunDenial(draftRun.sessionId, draftRun.spec.restricted.originalSpecHash));
  }
}
