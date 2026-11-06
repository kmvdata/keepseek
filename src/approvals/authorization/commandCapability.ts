import type { DraftRunSpec } from '../../shared/types';
import { analyzeCommand, type CommandSemantics } from './commandSemantics';

/** Change only when the deterministic host grammar/diagnostic contract changes.
 * This is not the tool protocol or an authorization-policy version. */
export const COMMAND_CAPABILITY_VERSION = 1 as const;

export interface CommandCapabilityDiagnostic {
  code: string;
  phase: 'capability';
  /** Static analysis happens before dispatch; never infer this for old results. */
  started: false;
  category: 'capability' | 'invalid_argv';
  argumentIndex?: number;
  token?: string;
  reason: string;
  /** Only a verified, exact semantic equivalent is suggested. Never remove unknown flags. */
  candidateArgs?: string[];
  capabilityVersion: typeof COMMAND_CAPABILITY_VERSION;
  /** Reviewable scope uncertainty is not a deterministic syntax failure. */
  blocking: boolean;
}

export interface CommandCapabilityAnalysis {
  version: typeof COMMAND_CAPABILITY_VERSION;
  semantics: CommandSemantics;
  supported: boolean;
  diagnostics: CommandCapabilityDiagnostic[];
  equivalents: Array<{ argumentIndex: number; token: string; replacement: string }>;
  /** Small relevant grammar slice, never a per-request system prompt manual. */
  supportedForms: string[];
}

/** Persisted diagnostics remain explanation only. In particular, absence of the
 * explicit pre-dispatch fact never becomes started:false during recovery. */
export function normalizeCommandCapabilityDiagnostic(value: unknown): CommandCapabilityDiagnostic | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.phase !== 'capability' || record.started !== false || record.capabilityVersion !== COMMAND_CAPABILITY_VERSION
    || !['capability', 'invalid_argv'].includes(String(record.category)) || typeof record.blocking !== 'boolean'
    || typeof record.code !== 'string' || !/^[a-z][a-z0-9_]{0,127}$/u.test(record.code)
    || typeof record.reason !== 'string' || !record.reason.trim() || record.reason.length > 8_192) return undefined;
  if (record.argumentIndex !== undefined && (!Number.isInteger(record.argumentIndex)
    || (record.argumentIndex as number) < 0 || (record.argumentIndex as number) >= 4_096)) return undefined;
  if (record.token !== undefined && (typeof record.token !== 'string' || record.token.length > 16_384)) return undefined;
  const candidateArgs = record.candidateArgs;
  if (candidateArgs !== undefined && (!Array.isArray(candidateArgs) || candidateArgs.length > 4_096
    || !candidateArgs.every(item => typeof item === 'string' && item.length <= 16_384 && !item.includes('\0'))
    || candidateArgs.reduce((sum: number, item: string) => sum + Buffer.byteLength(item), 0) > 1_048_576)) return undefined;
  return { code: record.code, phase: 'capability', started: false,
    category: record.category as CommandCapabilityDiagnostic['category'],
    argumentIndex: record.argumentIndex as number | undefined, token: record.token as string | undefined,
    reason: record.reason, candidateArgs: (candidateArgs as string[] | undefined)?.slice(),
    capabilityVersion: COMMAND_CAPABILITY_VERSION, blocking: record.blocking };
}

/** One static authority used by proposal, display and execution preflight.
 * It performs no filesystem/process access and cannot grant execution authority. */
export function analyzeCommandCapability(spec: DraftRunSpec): CommandCapabilityAnalysis {
  const semantics = analyzeCommand(spec);
  const diagnostics: CommandCapabilityDiagnostic[] = [];
  for (const reason of semantics.reasons) {
    if (!['unsupported_program', 'unsupported_option', 'missing_option_value', 'invalid_argv', 'git_commit_argv'].includes(reason.code)) continue;
    const invalid = ['missing_option_value', 'invalid_argv', 'git_commit_argv'].includes(reason.code);
    const blocking = reason.code !== 'unsupported_program'
      && !(semantics.program === 'rg' && reason.detail === 'rg recursive search');
    diagnostics.push({
      code: `host_${reason.code}`,
      phase: 'capability', started: false,
      category: invalid ? 'invalid_argv' : 'capability',
      argumentIndex: reason.argumentIndex,
      token: reason.argumentIndex === undefined ? undefined : spec.args[reason.argumentIndex],
      reason: reason.message,
      candidateArgs: semantics.gitReplan?.candidateArgs?.slice(),
      capabilityVersion: COMMAND_CAPABILITY_VERSION, blocking
    });
  }
  // Legacy exact semantic repairs use the same static delivery channel. The
  // original config override is still subject to its normal policy refusal.
  if (semantics.gitReplan && !diagnostics.some(item => item.blocking)) {
    diagnostics.push({ code: semantics.gitReplan.code, phase: 'capability', started: false,
      category: 'invalid_argv', reason: semantics.gitReplan.message,
      candidateArgs: semantics.gitReplan.candidateArgs?.slice(),
      capabilityVersion: COMMAND_CAPABILITY_VERSION, blocking: true });
  }
  const subcommand = semantics.arguments.find(item => item.role === 'subcommand');
  const equivalents = semantics.program === 'git' && subcommand?.value === 'log'
    ? semantics.arguments.filter(item => item.index > subcommand.index && item.role === 'option'
      && ['--no-decorate', '--decorate=no'].includes(item.value)).map(item => ({
      argumentIndex: item.index, token: item.value,
      replacement: item.value === '--no-decorate' ? '--decorate=no' : '--no-decorate'
    })) : [];
  const forms: Record<string, string[]> = {
    'git/log': ['git log --oneline [--no-decorate|--decorate=no] [-n N] [revision|A..B] [-- paths...]'],
    'git/tag': ['git tag --list [pattern]', 'git tag --list --sort=version:refname [pattern]'],
    'git/merge-base': ['git merge-base --is-ancestor commit commit'],
    'git/rev-parse': ['git rev-parse revision[^{commit}|^{tree}] ... (1-16 objects)'],
    'git/rev-list': ['git rev-list --count revision|A..B'],
    head: ['head [-n N] [--] path...'], cat: ['cat [--] path...']
  };
  return { version: COMMAND_CAPABILITY_VERSION, semantics,
    supported: !diagnostics.some(item => item.blocking), diagnostics, equivalents,
    supportedForms: forms[semantics.program + '/' + subcommand?.value] ?? forms[semantics.program] ?? [] };
}
