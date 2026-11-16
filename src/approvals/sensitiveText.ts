/**
 * Credential-material guards shared by the deterministic side-effect checks.
 * They describe literally visible secret patterns; they are not approval policy.
 */

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bAIza[0-9A-Za-z_-]{35}\b/u,
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{20,}\b/u,
  /\b(?:glpat-|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/u,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/iu,
  /\b(?:https?|ssh|ftp):\/\/[^/\s:@]+:[^/\s@]+@/iu,
  /(?:api.?key|auth(?:orization)?|client.?secret|access.?token|refresh.?token|cookie|credential|password|passwd|session.?token)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{12,}/iu
];

export function findSensitiveEvidence(value: string): string | undefined {
  const matched = SECRET_PATTERNS.find((pattern) => pattern.test(value));
  return matched ? 'suspected_credential_material' : undefined;
}

export function redactSensitiveReviewText(value: string, maxLength = 1_200): string {
  let output = value.replace(/[\u202A-\u202E\u2066-\u2069]/gu, '');
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`), '[REDACTED]');
  }
  return output.slice(0, maxLength);
}