import { randomUUID } from 'node:crypto';
import type { DraftRun, ExecutionPermit } from '../shared/types';

const PERMIT_TTL_MS = 30_000;

export class DraftRunAuthorizationService {
  public createDelegatedPermit(draftRun: DraftRun, isAuthorized: () => boolean): ExecutionPermit {
    if (!isAuthorized()) throw new Error('Delegated approval is no longer authorized.');
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
