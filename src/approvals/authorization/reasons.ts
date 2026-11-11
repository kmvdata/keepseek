/** Derived diagnostics only: never persisted authority or model-supplied permission. */
export interface AuthorizationReason {
  code: 'unsupported_program' | 'unsupported_option' | 'missing_option_value' | 'script_execution'
    | 'inline_code' | 'git_runtime' | 'git_configuration' | 'external_helper' | 'unsupported_pathspec'
    | 'environment_override' | 'executable_identity' | 'interpreter_identity' | 'script_entry_unverified' | 'foreign_path' | 'path_resolution'
    | 'git_commit_argv' | 'git_ref_mutation' | 'invalid_argv';
  detail: string;
  message: string;
  /** Zero-based position in the immutable argv, when a concrete token caused the diagnosis. */
  argumentIndex?: number;
  /** Bounded parser classification for command recovery, independent of user text. */
  invalidArgvKind?: 'missing_revision' | 'too_many_revisions' | 'invalid_revision'
    | 'missing_required_option' | 'misplaced_option' | 'option_value';
  /** Canonical option recognized by the parser, without its value. */
  optionIdentity?: string;
}

export function authorizationReason(code: AuthorizationReason['code'], detail: string, en: string, zh: string): AuthorizationReason {
  return { code, detail, message: `${en} / ${zh}${detail ? ` (${detail})` : ''}` };
}
