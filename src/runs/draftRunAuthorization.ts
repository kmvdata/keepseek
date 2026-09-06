import { randomUUID } from 'node:crypto';
import type { DraftRun, ExecutionPermit } from '../shared/types';
import type { ApprovalRecordMatch } from '../approvals/approvalReviewTypes';
import type { ApprovalReviewStore } from '../approvals/approvalReviewStore';

const PERMIT_TTL_MS = 30_000;

export class DraftRunAuthorizationService {
  public constructor(private readonly approvalReviews?: ApprovalReviewStore) {}

  public async createDelegatedPermit(
    draftRun: DraftRun,
    isAuthorized: () => boolean,
    match?: ApprovalRecordMatch
  ): Promise<ExecutionPermit> {
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
    return { ...this.createUserClickPermit(draftRun), source: 'delegated_approver' };
  }

  public createUserClickPermit(draftRun: DraftRun): ExecutionPermit {
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
}
