export { analyzeCommand, inspectGitCommandReplan, type GitCommandReplan, type GitLocalQuery } from './commandSemantics';
export { analyzeCommandCapability, normalizeCommandCapabilityDiagnostic, COMMAND_CAPABILITY_VERSION,
  type CommandCapabilityAnalysis, type CommandCapabilityDiagnostic } from './commandCapability';
export { analyzeDraftRunEffects } from './commandEffects';
export { inspectDraftRunScope } from './commandScope';
export { ExactOperationGrants } from './exactOperationGrants';
export { draftRunIdentity, inspectAutomaticRunAuthorization, evaluateAutomaticRunAuthorization,
  assertAutomaticRunAuthorization, inspectAutomaticEditAuthorization } from './preflight';
export { checkDraftRunApprovalBoundary, validateDraftRunBeforeApproval, InvalidGitCommitError } from './executionBoundary';
