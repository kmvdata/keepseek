// Legacy fixed-script validation policy; not arbitrary DraftRun authorization.
const VALIDATION_BLOCKING_PATTERN = /(?:\b(?:npm|pnpm|yarn|bun)\s+(?:install|add|publish|deploy)\b|\bgit\s+push\b|\brm\s+(?:-[^\s]+\s+)*|\b(?:curl|wget)\b|\b(?:deploy|publish)\b)/iu;

export function hasValidationBlockingRisk(command: string): boolean {
  return VALIDATION_BLOCKING_PATTERN.test(command);
}
