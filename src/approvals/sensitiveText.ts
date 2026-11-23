/**
 * Credential-material guards shared by the deterministic side-effect checks.
 * They describe literally visible secret patterns; they are not approval policy.
 *
 * Single definition of the ten patterns, and how each one is disposed of:
 *
 *  #  pattern                         disposition used by the handoff guard
 *  1  -----BEGIN … PRIVATE KEY-----   hard refusal (hasPrivateKeyBlock). The header is a
 *                                     structural marker and the base64 behind it is the key
 *                                     itself, so redacting only the header keeps the secret.
 *  2  AKIA[0-9A-Z]{16}                redact, placeholder exempt (AWS' own EXAMPLE key)
 *  3  AIza[0-9A-Za-z_-]{35}           redact, no placeholder exemption
 *  4  sk-/rk-/pk-…                    redact, placeholder exempt
 *  5  glpat-/xox…                     redact, no placeholder exemption
 *  6  gh[opusr]_…                     redact, placeholder exempt (ghp_xxxx… is a placeholder)
 *  7  JWT (three segments)            redact, no placeholder exemption (risk > benefit)
 *  8  Bearer …                        redact, no placeholder exemption
 *  9  URL user:pass@                  redact, no placeholder exemption
 * 10  key=value (api_key/password/…)  redact, placeholder exempt
 *
 * Any caller that gates delivery refuses on #1 and rewrites the rest. Review-text callers
 * still redact #1 as well, because the alternative is printing a private key in review UI.
 */
interface SecretPattern {
  pattern: RegExp;
  /** Capture group holding the credential body, when it is not the whole match. */
  valueGroup?: number;
  /** Capture group holding the literal prefix that stays readable (`sk-`, `password=`). */
  prefixGroup?: number;
}

const PRIVATE_KEY_BLOCK = /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u;

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { pattern: PRIVATE_KEY_BLOCK },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/u },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/u },
  { pattern: /\b(sk|rk|pk)-([A-Za-z0-9_-]{20,})\b/u, prefixGroup: 1, valueGroup: 2 },
  { pattern: /\b(?:glpat-|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/u },
  { pattern: /\b(gh[opusr]_)([A-Za-z0-9]{20,})\b/u, prefixGroup: 1, valueGroup: 2 },
  { pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u },
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/iu },
  { pattern: /\b(?:https?|ssh|ftp):\/\/[^/\s:@]+:[^/\s@]+@/iu },
  {
    pattern: /((?:api.?key|auth(?:orization)?|client.?secret|access.?token|refresh.?token|cookie|credential|password|passwd|session.?token)\s*[:=]\s*["']?)([A-Za-z0-9._~+/-]{12,})/iu,
    prefixGroup: 1, valueGroup: 2
  }
];

const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/gu;

/** Documentation-shaped values: keep them, they are not credentials. */
const PLACEHOLDER_WORDS = /your|example|sample|dummy|fake|placeholder|changeme|replace|redacted|todo/iu;

function withGlobalFlag(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`);
}

/**
 * Conservative on purpose: only the shapes below may keep their original text. Anything
 * else is rewritten, including sequential digits such as `123456789012`.
 */
function isPlaceholderValue(value: string): boolean {
  const text = value.trim();
  if (!text) return true;
  if (PLACEHOLDER_WORDS.test(text)) return true;
  // xxxx…, 0000…, ****… — a single code point repeated. Sequential digits are not this.
  if (/^(.)\1+$/u.test(text)) return true;
  if (/^<[^<>]*>$/u.test(text) || /^\$\{[^{}]*\}$/u.test(text) || /^\{\{[^{}]*\}\}$/u.test(text)) return true;
  return /\.\.\.$/u.test(text) || /…$/u.test(text);
}

export function hasPrivateKeyBlock(value: string): boolean {
  return PRIVATE_KEY_BLOCK.test(value);
}

export function findSensitiveEvidence(value: string): string | undefined {
  const matched = SECRET_PATTERNS.find(entry => entry.pattern.test(value));
  return matched ? 'suspected_credential_material' : undefined;
}

/**
 * Rewrites every non-PEM credential shape in place, without truncation: callers such as the
 * handoff guard require the full text back. Idempotent, because `[REDACTED]` matches nothing.
 */
export function redactSensitiveMaterial(value: string): string {
  let output = value;
  for (const { pattern, prefixGroup, valueGroup } of SECRET_PATTERNS.slice(1)) {
    output = output.replace(withGlobalFlag(pattern), (...args: unknown[]) => {
      const match = args[0] as string;
      const captured = valueGroup === undefined ? match : (args[valueGroup] as string | undefined) ?? match;
      if (isPlaceholderValue(captured)) return match;
      // Keep only the literal prefix the pattern already matched, never a slice of the value.
      const prefix = prefixGroup === undefined ? '' : (args[prefixGroup] as string | undefined) ?? '';
      return prefix + '[REDACTED]';
    });
  }
  return output;
}

export function redactSensitiveReviewText(value: string, maxLength = 1_200): string {
  // Review UI still hides the key header itself; the base64 body is bounded by maxLength.
  return redactSensitiveMaterial(value.replace(BIDI_CONTROLS, ''))
    .replace(withGlobalFlag(PRIVATE_KEY_BLOCK), '[REDACTED]')
    .slice(0, maxLength);
}