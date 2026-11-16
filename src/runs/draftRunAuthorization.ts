import { randomUUID } from 'node:crypto';
import type { DraftRun, ExecutionPermit } from '../shared/types';
import { assertValidGitCommitArguments } from '../approvals/authorization/executionBoundary';

const PERMIT_TTL_MS = 30_000;

export class DraftRunAuthorizationService {
  public createUserClickPermit(draftRun: DraftRun): ExecutionPermit {
    if (draftRun.historyInvalidationId || draftRun.historyOriginUnverified) throw new Error('DraftRun was detached by editing its source history.');
    assertValidGitCommitArguments(draftRun.spec);
    return this.createPermit(draftRun, 'user_click');
  }

  private createPermit(draftRun: DraftRun, source: ExecutionPermit['source']): ExecutionPermit {
    return {
      draftRunId: draftRun.id,
      specHash: draftRun.specHash,
      source,
      allowedEffects: [...draftRun.effectAssessment.effects],
      policyVersion: 1,
      expiresAt: Date.now() + PERMIT_TTL_MS,
      nonce: randomUUID()
    };
  }
}