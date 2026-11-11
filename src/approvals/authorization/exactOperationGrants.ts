export interface OperationIdentity {
  sessionId: string;
  runId: string;
  targetId: string;
  kind: 'command' | 'edit';
  actionHash: string;
}
export interface OperationScope {
  externalUris: readonly string[];
  fingerprint?: string;
}

/** Process-local scope consent, distinct from approval and a one-shot permit.
 * Never serialized: restart, Stop, mode/session changes revoke it. */
export class ExactOperationGrants {
  private readonly grants = new Map<string, string>();

  public grant(identity: OperationIdentity, scope: OperationScope): void {
    this.grants.set(identityKey(identity), scopeKey(scope));
  }
  public matches(identity: OperationIdentity, scope: OperationScope): boolean {
    return this.grants.get(identityKey(identity)) === scopeKey(scope);
  }
  public revoke(identity: OperationIdentity, scope: OperationScope): void {
    if (this.matches(identity, scope)) this.grants.delete(identityKey(identity));
  }
  public clear(): void { this.grants.clear(); }
}

function scopeKey(scope: OperationScope): string {
  return JSON.stringify({ uris: [...new Set(scope.externalUris)].sort(), fingerprint: scope.fingerprint ?? '' });
}

function identityKey(identity: OperationIdentity): string {
  return JSON.stringify([identity.sessionId, identity.runId, identity.targetId, identity.kind, identity.actionHash]);
}
