import * as path from 'node:path';

/** Host targets that cannot be authorized through a draft or reference grant. */
export function isWorkspaceSkillScaffoldPath(value: string): boolean {
  return /(?:^|\/)\.agents\/skills\/[a-z0-9-]+\/(?:SKILL\.md|agents\/openai\.yaml)$/u.test(value.replace(/\\/gu, '/'));
}

/** Git may version project skills as repository content. Direct edits and
 * skills outside this repository still use the shared-resource guard. */
export function isGitProjectSkillPath(repository: string, target: string): boolean {
  return /^(?:\.agents[/\\]skills)(?:[/\\]|$)/u.test(path.relative(repository, target));
}

/** Authority-bearing paths: blocked for every author and every approval mode,
 * regardless of where they sit. / 权力载体：与位置无关地阻断。 */
const GIT_INTERNAL = /(?:^|\/)\.git(?:\/|$)/u;
const CREDENTIAL_BEARERS = /(?:^|\/)(?:\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_rsa|id_ed25519|credentials|cookies)$/iu;
const OS_CORE = /^(?:\/(?:etc|private\/etc|System|Library|usr|bin|sbin|dev|proc|sys|boot)(?:\/|$)|[A-Z]:\/(?:Windows|Program Files(?: \(x86\))?)(?:\/|$))/iu;

export const HARD_DENIAL_MESSAGE = 'Protected credential, shared configuration or system target. Nothing executed. / 目标涉及受保护的凭据、共享配置或系统资源，尚未执行。';

/** L2: authority-bearing paths for DraftEdit writes inside a workspace folder. */
export function isHardProtectedPath(value: string): boolean {
  const normalized = value.replace(/\\/gu, '/');
  return normalized === '/'
    || GIT_INTERNAL.test(normalized)
    || CREDENTIAL_BEARERS.test(normalized)
    || OS_CORE.test(normalized);
}

/** L2 guard. No approval mode and no author can bypass it. */
export function assertHardProtectedPath(value: string): void {
  if (isHardProtectedPath(value)) throw new Error(HARD_DENIAL_MESSAGE);
}

/** L3 guard: exact-grant targets outside a workspace folder plus command scope. */
export function isProtectedOperationPath(value: string, systemWrite = false, skillScaffold = false): boolean {
  const normalized = value.replace(/\\/gu, '/');
  if (/(?:^|\/)(?:\.aws|\.ssh|\.gnupg|\.kube|\.codex)(?:\/|$)/iu.test(normalized)
    || (!skillScaffold && /(?:^|\/)\.agents\/skills(?:\/|$)/iu.test(normalized))
    || /(?:^|\/)(?:\.env(?:\.[^/]+)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|id_rsa|id_ed25519|credentials?|cookies?)$/iu.test(normalized)
    || /(?:^|\/)\.git\/(?:hooks|config|config\.worktree)(?:\/|$)/iu.test(normalized)
    || /^(?:\/(?:etc|private\/etc)\/(?:shadow|sudoers(?:\.d)?|ssl\/private)|\/proc\/(?:self|\d+)\/environ)(?:\/|$)/u.test(normalized)) return true;
  if (!systemWrite) return false;
  return normalized === '/' || /^(?:\/(?:etc|private\/etc|System|Library|usr|bin|sbin|dev|proc|sys|boot)(?:\/|$)|[A-Z]:\/(?:Windows|Program Files(?: \(x86\))?)(?:\/|$))/iu.test(normalized)
    || /^(?:\.gitconfig|\.bashrc|\.zshrc|\.profile|\.zprofile)$/iu.test(path.posix.basename(normalized));
}

export function assertOperationPath(value: string, systemWrite = false, skillScaffold = false): void {
  if (isProtectedOperationPath(value, systemWrite, skillScaffold)
    || (skillScaffold && !isWorkspaceSkillScaffoldPath(value))) {
    throw new Error(HARD_DENIAL_MESSAGE);
  }
}
