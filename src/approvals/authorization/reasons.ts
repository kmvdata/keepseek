/** Derived diagnostics only: never persisted authority or model-supplied permission. */
export interface AuthorizationReason {
  code: 'unsupported_program' | 'unsupported_option' | 'missing_option_value' | 'script_execution'
    | 'inline_code' | 'git_runtime' | 'git_configuration' | 'external_helper' | 'unsupported_pathspec'
    | 'environment_override' | 'executable_identity' | 'foreign_path' | 'path_resolution';
  detail: string;
  message: string;
}

export function authorizationReason(code: AuthorizationReason['code'], detail: string, en: string, zh: string): AuthorizationReason {
  return { code, detail, message: `${en} / ${zh}${detail ? ` (${detail})` : ''}` };
}
