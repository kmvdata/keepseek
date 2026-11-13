import * as path from 'node:path';
import type { DraftRunEffect, DraftRunSpec } from '../../shared/types';
import { authorizationReason, type AuthorizationReason } from './reasons';
import { isExplicitUri, isExternalNetworkTarget, isNodeProgram, isPythonProgram, projectFileArgument, projectPackageScript } from './projectLaunchArguments';

export type ArgumentRole = 'subcommand' | 'option' | 'option_value' | 'text' | 'revision'
  | 'read_path' | 'write_path' | 'cwd' | 'repository' | 'script' | 'inline_code';
export interface CommandArgument {
  index: number;
  value: string;
  role: ArgumentRole;
  /** Ordered Git -C operands; each relative to the preceding directory. */
  cwdChanges: string[];
}
export interface CommandSemantics {
  program: string;
  arguments: CommandArgument[];
  effects: DraftRunEffect[];
  reasons: AuthorizationReason[];
  gitStage?: { pathspecs: string[] };
  gitTagQuery?: true;
  gitTagQueryNeedsSort?: true;
  gitLocalQuery?: GitLocalQuery;
  gitTagCreate?: { ref: string; target?: string };
  gitRemote?: GitRemoteCommand;
  gitCommit?: { all: boolean; messages: string[] };
  gitRefMutation?: { name: string; action: 'create' | 'delete' | 'force' };
  gitReplan?: GitCommandReplan;
  projectScript?: true;
  projectExecutable?: true;
  projectPackageScript?: { name: string; index: number };
  networkTargets?: string[];
}

/** Exact finite query grammar. Runtime, repository and helper checks remain mandatory. */
export interface GitLocalQuery {
  kind: 'ancestor' | 'tag_list' | 'revision_parse' | 'revision_count' | 'log';
  revisions: string[];
}

const revParseVerifyOptions = ['--verify', '--quiet', '--end-of-options'];

/** Local refs, bounded ancestry suffixes and explicit object peeling; no reflog,
 * path lookup (revision:path), command substitution or revision-set shortcuts. */
export function isLocalGitRevision(value: string): boolean {
  if (!value || value.length > 512) return false;
  const base = value.replace(/(?:(?:[~^]\d{0,6})|(?:\^\{(?:tree|commit|tag|object)\}))+$/u, '');
  return /^[\p{L}\p{N}_][\p{L}\p{N}_.+/-]*$/u.test(base)
    && !base.includes('..') && !base.includes('//') && !base.endsWith('.') && !base.endsWith('/')
    && base.split('/').every(part => !part.startsWith('.') && !part.endsWith('.lock'));
}

export function isLocalGitRevisionRange(value: string): boolean {
  const parts = value.split('..');
  return parts.length === 2 && parts.every(isLocalGitRevision);
}

export type GitRemoteCommand =
  | { kind: 'query'; remote: string; namespace?: 'tags' | 'heads'; refs: string[] }
  | { kind: 'push'; remote: string; refs: string[]; currentBranch?: true; shortRef?: string; atomic?: true;
      lease?: { ref: string; expected: string } };

export function isGitRemoteAlias(value: string): boolean {
  return /^[\w][\w.-]*$/u.test(value);
}

function isExplicitGitTransport(value: string): boolean {
  return /^(?:https:\/\/|ssh:\/\/|[\w.-]+@[\w.-]+:|\/(?!\/)|[a-z]:[\\/])/iu.test(value)
    && value.length <= 4096 && !/[\p{Cc}]/u.test(value);
}

export function isGitReleaseRef(ref: string): boolean {
  return /^refs\/(?:heads|tags)\/[\w][\w./-]*$/u.test(ref) && !ref.includes('..')
    && ref.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.lock')) && !ref.endsWith('.');
}

function tagQueryRoles(args: readonly string[]): ArgumentRole[] | undefined {
  const roles: ArgumentRole[] = [];
  let list = args.length === 0;
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!literal && token === '--') { literal = true; roles.push('option'); }
    else if (!literal && ['--list', '-l'].includes(token) && !list) { list = true; roles.push('option'); }
    else if (!literal && token === '--sort' && /^-?(?:v|version):refname$/u.test(args[i + 1] ?? '')) {
      roles.push('option', 'option_value'); i++;
    } else if (!literal && /^--sort=-?(?:v|version):refname$/u.test(token)) roles.push('option');
    else if ((literal || !token.startsWith('-')) && /^[\p{L}\p{N}_.+*?@{}=,[\]/-]+$/u.test(token)
      && !token.includes('..') && !token.includes('//')) roles.push('text');
    else return undefined;
  }
  return list ? roles : undefined;
}

function tagCreateArguments(args: readonly string[]): { ref: string; target?: string; roles: ArgumentRole[] } | undefined {
  const roles: ArgumentRole[] = [];
  const operands: string[] = [];
  let annotated = false;
  let message = false;
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    if (!literal && token === '--') { literal = true; roles.push('option'); }
    else if (!literal && ['-a', '--annotate'].includes(token)) { annotated = true; roles.push('option'); }
    else if (!literal && ['-m', '--message'].includes(token)) {
      if (!args[i + 1]?.trim()) return undefined;
      message = true;
      roles.push('option', 'text'); i++;
    } else if (!literal && /^(?:-m|--message=)/u.test(token)) {
      if (!token.slice(token.startsWith('--') ? '--message='.length : 2).trim()) return undefined;
      message = true;
      roles.push('text');
    } else if (!token.startsWith('-')) {
      operands.push(token); roles.push('revision');
    } else return undefined;
  }
  const [name, target] = operands;
  const ref = 'refs/tags/' + name;
  return name && operands.length <= 2 && (!annotated || message) && isGitReleaseRef(ref)
    && (target === undefined || /^(?:HEAD|[a-f0-9]{40}|[a-f0-9]{64})$/u.test(target)) ? { ref, target, roles } : undefined;
}

function parseGitRemote(subcommand: string, operands: string[]): GitRemoteCommand | undefined {
  if (operands.length > 130) return undefined;
  const args = operands.slice();
  let namespace: 'tags' | 'heads' | undefined;
  let atomic = false;
  let lease: { ref: string; expected: string } | undefined;
  if (subcommand === 'ls-remote') {
    if (args[0] === '--tags' || args[0] === '--heads') namespace = args.shift() === '--tags' ? 'tags' : 'heads';
  } else if (subcommand === 'push') {
    while (args[0] && args[0] !== '--' && args[0].startsWith('-')) {
      const option = args.shift()!;
      if (option === '--atomic' && !atomic) { atomic = true; continue; }
      const match = /^--force-with-lease=(refs\/heads\/[^:]+):([a-f0-9]{40}|[a-f0-9]{64})$/u.exec(option);
      if (!match || lease || !isGitReleaseRef(match[1])) return undefined;
      lease = { ref: match[1], expected: match[2] };
    }
    if (!args.length && !lease) return { kind: 'push', remote: '', refs: [], currentBranch: true, ...(atomic && { atomic: true }) };
  } else return undefined;
  if (args[0] === '--') args.shift();
  const remote = args.shift();
  if (!remote || !isGitRemoteAlias(remote) && !isExplicitGitTransport(remote)) return undefined;
  if (subcommand === 'ls-remote') {
    if ((!namespace && !args.length) || !args.every(ref => isGitReleaseRef(ref)
      && (!namespace || ref.startsWith('refs/' + namespace + '/')))) return undefined;
    return { kind: 'query', remote, namespace, refs: args };
  }
  if (!args.length && !lease) return { kind: 'push', remote, refs: [], currentBranch: true, ...(atomic && { atomic: true }) };
  const refs = args.map(value => {
    const [source, target = source, ...extra] = value.split(':');
    return !extra.length && source === target && isGitReleaseRef(source) ? source : '';
  });
  if (!lease && args.length === 1 && !refs[0]) {
    const [source, target = source, ...extra] = args[0].split(':');
    if (!extra.length && source === target && !source.startsWith('refs/') && isGitReleaseRef('refs/heads/' + source)) {
      return { kind: 'push', remote, refs: [], shortRef: source, ...(atomic && { atomic: true }) };
    }
  }
  return refs.length > 0 && (refs.length === 1 || atomic) && refs.every(Boolean) && new Set(refs).size === refs.length
    && (!lease || refs.length === 1 && refs[0] === lease.ref)
    ? { kind: 'push', remote, refs, ...(atomic && { atomic: true }), ...(lease && { lease }) } : undefined;
}

export interface GitCommandReplan {
  code: 'git_status_pager_override' | 'git_commit_missing_message_value'
    | 'git_commit_all_with_pathspec' | 'git_commit_missing_message';
  message: string;
  candidateArgs?: string[];
}

export function inspectGitCommandReplan(spec: DraftRunSpec): GitCommandReplan | undefined {
  return analyzeCommand(spec).gitReplan;
}

/** Bounded argv grammar, NOT a shell parser or an executable trust decision.
 * Basenames are used only for advisory semantics; commandScope verifies the
 * actual executable resolution before granting automatic scope. */
export function analyzeCommand(spec: DraftRunSpec): CommandSemantics {
  const program = path.win32.basename(path.posix.basename(spec.executable)).replace(/\.exe$/iu, '').toLowerCase();
  const result: CommandSemantics = { program, arguments: [], effects: [], reasons: [] };
  const effects = new Set<DraftRunEffect>();
  const args = spec.args;
  const cwdChanges: string[] = [];
  const arg = (index: number, role: ArgumentRole, value = args[index]) => {
    result.arguments.push({ index, role, value, cwdChanges: [...cwdChanges] });
    if (['read_path', 'repository', 'script'].includes(role)) effects.add('workspace_read');
    if (role === 'write_path') effects.add('workspace_write');
  };
  const reason = (code: AuthorizationReason['code'], detail: string, en: string, zh: string) => {
    result.reasons.push(authorizationReason(code, detail, en, zh));
  };
  const unsupported = (value: string, argumentIndex?: number, optionIdentity?: string) => {
    reason('unsupported_option', value, 'This argument or behavior is outside the host command grammar.',
      '该参数或行为不在宿主命令语法内。');
    const item = result.reasons.at(-1)!;
    if (argumentIndex !== undefined) item.argumentIndex = argumentIndex;
    if (optionIdentity) item.optionIdentity = optionIdentity;
  };
  const invalid = (kind: NonNullable<AuthorizationReason['invalidArgvKind']>, detail: string, argumentIndex?: number,
    en = 'Invalid or incomplete arguments for this supported query.', zh = '此受支持查询的参数无效或不完整。', optionIdentity?: string) => {
    reason('invalid_argv', detail, en, zh);
    const item = result.reasons.at(-1)!;
    item.invalidArgvKind = kind;
    if (argumentIndex !== undefined) item.argumentIndex = argumentIndex;
    if (optionIdentity) item.optionIdentity = optionIdentity;
  };
  const valueAfter = (index: number, role: ArgumentRole, stopAtSeparator = false): number => {
    arg(index, 'option');
    if (index + 1 >= args.length || (stopAtSeparator && args[index + 1] === '--')) {
      reason('missing_option_value', args[index], 'Missing option value.', '缺少选项值。');
      result.reasons.at(-1)!.argumentIndex = index;
      return index;
    }
    arg(index + 1, role);
    return index + 1;
  };
  const helper = (value: string) => {
    effects.add('arbitrary_code');
    reason('external_helper', value, 'This option can invoke an external program.', '该选项可能调用外部程序。');
  };
  const isOutputArgument = (index: number) => /^--(?:output|out|dest|destination|target-dir|write-to)=/u.test(args[index])
    || /^--(?:output|out|dest|destination|target-dir|write-to)$/u.test(args[index - 1] ?? '');
  const scriptArg = (index: number) => {
    const raw = args[index];
    const operand = raw.replace(/^--[\w-]+=/u, '')
      .replace(/^-[A-Za-z](?=\/|\.\.?[\\/]|[A-Za-z]:[\\/])/u, '');
    if (isExternalNetworkTarget(operand)) {
      effects.add('network');
      (result.networkTargets ??= []).push(operand);
    }
    // Scope the path-shaped operands without interpreting unknown script
    // flags or expanding argv. Visible URLs and tilde paths are separate.
    const pathOperand = !operand.startsWith('-') && !isExplicitUri(operand) && !/^~[\\/]/u.test(operand)
      && (/[\\/]/u.test(operand) || operand.startsWith('.') || /\.[\p{L}\p{N}]{1,12}$/u.test(operand));
    arg(index, isOutputArgument(index) && (pathOperand || /^file:|^~[\\/]/iu.test(operand)) ? 'write_path'
      : pathOperand ? 'read_path' : 'text', operand);
  };

  // Version queries are still subject to executable identity and environment checks.
  const versionPrograms = new Set(['git', 'node', 'bun', 'npm', 'python', 'python3', 'ruby', 'perl', 'rg', 'grep']);
  if (args.length === 1 && ['--version', '-V'].includes(args[0]) && (versionPrograms.has(program)
    || isPythonProgram(program) || isNodeProgram(program))) {
    arg(0, 'option');
  } else if (program === 'git') {
    effects.add('workspace_read');
    let i = 0;
    for (; i < args.length && args[i].startsWith('-'); i++) {
      const token = args[i];
      if (['--no-pager', '-P', '--no-replace-objects', '--no-lazy-fetch', '--no-optional-locks', '--literal-pathspecs'].includes(token)) {
        arg(i, 'option');
      } else if (token === '-C' || token.startsWith('-C')) {
        if (token === '-C') { i = valueAfter(i, 'cwd'); if (args[i] === '-C') continue; }
        else arg(i, 'cwd', token.slice(2));
        cwdChanges.push(token === '-C' ? args[i] : token.slice(2));
      } else if (/^--(?:git-dir|work-tree)(?:=|$)/u.test(token)) {
        if (token.includes('=')) arg(i, 'repository', token.slice(token.indexOf('=') + 1));
        else i = valueAfter(i, 'repository');
        reason('git_configuration', token, 'Git repository location is overridden.', 'Git 仓库位置被覆盖。');
      } else if (token === '-c' || token.startsWith('-c') || token.startsWith('--config-env')) {
        if (token === '-c' || token === '--config-env') i = valueAfter(i, 'option_value');
        else arg(i, 'option_value');
        reason('git_configuration', token, 'Git configuration is overridden.', 'Git 配置被覆盖。');
      } else if (token.startsWith('--exec-path=')) {
        arg(i, 'read_path', token.slice('--exec-path='.length));
        unsupported(token, i, '--exec-path');
        helper('--exec-path');
      } else {
        arg(i, 'option'); unsupported(token, i);
        if (['-p', '--paginate'].includes(token) || token.startsWith('--exec-path')) helper(token);
      }
    }
    const subcommandIndex = i;
    const subcommand = args[i];
    if (subcommand) arg(i++, 'subcommand');
    const operands = args.slice(i);
    const tagRoles = subcommand === 'tag' ? tagQueryRoles(operands) : undefined;
    const listingTags = Boolean(tagRoles);
    if (listingTags) result.gitTagQuery = true;
    else if (subcommand === 'tag' && operands.at(-1) === '--sort' && tagQueryRoles(operands.slice(0, -1))?.length) {
      result.gitTagQueryNeedsSort = true;
    }
    result.gitRemote = parseGitRemote(subcommand, operands);
    const tagWrite = subcommand === 'tag' && !listingTags ? tagCreateArguments(operands) : undefined;
    if (tagWrite) result.gitTagCreate = { ref: tagWrite.ref, target: tagWrite.target };
    const refAction = ['-d', '--delete'].includes(operands[0]) ? 'delete'
      : ['-f', '--force'].includes(operands[0]) ? 'force' : 'create';
    const refOperands = refAction === 'create' ? operands : operands.slice(1);
    const boundedRef = result.gitTagCreate || ['tag', 'branch'].includes(subcommand) && !listingTags
      && refOperands.length >= 1 && refOperands.length <= (refAction === 'delete' ? 1 : 2)
      && refOperands.every(token => /^(?![.-]|.*(?:\.\.|\/\.))[\w][\w./-]*$/u.test(token));
    if (boundedRef) {
      result.gitRefMutation = { name: tagWrite ? tagWrite.ref.slice('refs/tags/'.length) : refOperands[0], action: refAction };
      if (refAction !== 'create') reason('git_ref_mutation', refAction,
        'Changing an existing local reference needs task-specific review.',
        '修改已有本地引用需要结合当前任务审查。');
    }
    const viewing = ['show', 'diff', 'log'].includes(subcommand);
    if (['add', 'apply', 'am', 'branch', 'checkout', 'clean', 'clone', 'commit', 'fetch', 'gc', 'init', 'merge', 'mv',
      'pull', 'push', 'rebase', 'remote', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag', 'worktree'].includes(subcommand)
      && !listingTags && !result.gitTagQueryNeedsSort) effects.add('git_mutation');
    if (['clone', 'fetch', 'pull', 'push', 'ls-remote'].includes(subcommand)) effects.add('network');
    const staging = subcommand === 'add';
    const committing = subcommand === 'commit';
    const status = subcommand === 'status';
    const listFiles = subcommand === 'ls-files';
    const localQuery = ['merge-base', 'rev-parse', 'rev-list'].includes(subcommand);
    if (!viewing && !staging && !committing && !status && !listFiles && !listingTags && !boundedRef && !result.gitRemote && !localQuery) unsupported(subcommand ?? 'missing Git subcommand', subcommand ? subcommandIndex : undefined);
    let query: GitLocalQuery | undefined;
    if (subcommand === 'rev-parse') {
      const verify = operands[0] === '--verify';
      let firstRevision = verify ? 1 : 0;
      if (verify && operands[firstRevision] === '--quiet') firstRevision++;
      const literal = verify && operands[firstRevision] === '--end-of-options';
      if (literal) firstRevision++;
      const revisions = operands.slice(firstRevision);
      const maximum = verify ? 1 : 16;
      const bad = revisions.findIndex(token => !isLocalGitRevision(token));
      if (bad >= 0) {
        const token = revisions[bad];
        const index = i + firstRevision + bad;
        const option = token.split('=', 1)[0];
        if (!literal && revParseVerifyOptions.includes(option) && option === token) {
          invalid('misplaced_option', option, index,
            'Use this option once in the supported --verify option order, before the revision.',
            '请在修订参数之前，按受支持的 --verify 选项顺序使用此选项一次。', option);
        } else if (!literal && revParseVerifyOptions.includes(option)) {
          invalid('option_value', option, index, 'This rev-parse option takes no value.', '此 rev-parse 选项不接受附值。', option);
        } else if (!literal && token.startsWith('-')) unsupported(token, index);
        else invalid('invalid_revision', '', index, 'This argument must be a supported local Git revision.', '此参数必须是受支持的本地 Git 修订。');
      } else if (!revisions.length || revisions.length > maximum) {
        invalid(revisions.length ? 'too_many_revisions' : 'missing_revision', '',
          revisions.length ? i + firstRevision + maximum : undefined,
          verify ? 'rev-parse --verify requires exactly one local revision.' : 'rev-parse requires one to sixteen local revisions.',
          verify ? 'rev-parse --verify 要求恰好一个本地修订。' : 'rev-parse 要求一到十六个本地修订。');
      } else query = { kind: 'revision_parse', revisions };
    } else if (localQuery) {
      const ancestor = subcommand === 'merge-base';
      const revisions = operands.slice(1);
      const option = ancestor ? '--is-ancestor' : '--count';
      const arity = ancestor ? 2 : 1;
      const validRevision = (token: string) => isLocalGitRevision(token) || !ancestor && isLocalGitRevisionRange(token);
      if (operands[0] === option && revisions.length === arity && revisions.every(validRevision)) {
        query = { kind: ancestor ? 'ancestor' : 'revision_count', revisions };
      } else {
        const bad = operands.findIndex((token, offset) => offset === 0 ? token !== option : !validRevision(token));
        if (bad >= 0 && operands[bad].startsWith('-')) unsupported(operands[bad], i + bad);
        else {
          const kind = operands[0] !== option ? 'missing_required_option' : bad >= 0 ? 'invalid_revision'
            : revisions.length < arity ? 'missing_revision' : 'too_many_revisions';
          const detail = bad >= 0 ? operands[bad]
            : `${subcommand} requires ${ancestor ? '--is-ancestor and two revisions' : '--count and one revision or A..B range'}`;
          invalid(kind, detail, bad >= 0 ? i + bad : undefined);
        }
      }
    }
    const commitMessages: string[] = [];
    const commitPathspecPositions: number[] = [];
    let commitAll = false;
    let unsupportedCommitOption = false;
    let paths = false;
    let noIndex = false;
    for (; i < args.length; i++) {
      const token = args[i];
      if (localQuery) {
        arg(i, token.startsWith('-') ? 'option' : 'revision');
      } else if (!paths && token === '--') { paths = true; arg(i, 'option'); continue; }
      else if (tagRoles) {
        arg(i, tagRoles[i - (args.length - operands.length)]);
      } else if (result.gitRemote) {
        arg(i, token.startsWith('-') ? 'option' : 'text');
      } else if (tagWrite) {
        arg(i, tagWrite.roles[i - (args.length - operands.length)]);
      } else if (boundedRef) {
        arg(i, token.startsWith('-') ? 'option' : 'revision');
      } else if (committing) {
        if (!paths && ['-m', '-am', '--message'].includes(token)) {
          commitAll ||= token === '-am';
          if (i + 1 === args.length) {
            result.gitReplan = {
              code: 'git_commit_missing_message_value',
              message: `Git commit argument ${i + 1} (${token}) needs a complete message argument. Nothing executed. / Git commit 的第 ${i + 1} 个参数（${token}）需要一个完整的提交说明参数。原命令未启动。`
            };
          } else {
            commitMessages.push(args[i + 1]);
          }
          i = valueAfter(i, 'text');
        } else if (!paths && /^(?:--message=|-a?m)/u.test(token)) {
          commitAll ||= token.startsWith('-am');
          const message = token.slice(token.startsWith('--') ? '--message='.length : token.startsWith('-am') ? 3 : 2);
          arg(i, 'text', message);
          commitMessages.push(message);
        } else if (!paths && ['-a', '--all', '--quiet', '-q'].includes(token)) {
          arg(i, 'option');
          commitAll ||= token === '-a' || token === '--all';
        } else if (paths || !token.startsWith('-') || token === '-') {
          arg(i, 'read_path');
          commitPathspecPositions.push(i + 1);
        } else {
          unsupportedCommitOption = true;
          unsupported(token, i, /^-[Ft]/u.test(token) ? token.slice(0, 2) : undefined);
          if (['-F', '--file', '-t', '--template', '--pathspec-from-file'].includes(token)) {
            i = valueAfter(i, 'read_path');
          } else if (/^(?:--(?:file|template|pathspec-from-file)=|-[Ft].)/su.test(token)) {
            arg(i, 'read_path', token.slice(token.startsWith('--') ? token.indexOf('=') + 1 : 2));
          } else if (['-C', '-c', '--reuse-message', '--reedit-message', '--fixup', '--squash'].includes(token)) {
            i = valueAfter(i, 'revision');
          } else {
            arg(i, 'option');
          }
        }
      } else if (staging || status || listFiles) {
        const knownOption = staging ? ['-A', '--all', '-u', '--update', '--ignore-removal', '--no-all', '-v', '--verbose'].includes(token)
          : listFiles ? ['-s', '--stage', '-z', '--error-unmatch'].includes(token)
            : /^(?:-s|-b|-sb|-bs|-z|--short|--branch|--porcelain(?:=v[12])?|--long|--no-renames|--untracked-files(?:=(?:no|normal|all))?|-u(?:no|normal|all)?)$/u.test(token);
        if (!paths && knownOption) {
          arg(i, 'option');
        } else if (paths || !token.startsWith('-')) {
          arg(i, 'read_path');
          if (token.startsWith(':') || /[*?[]/u.test(token)) unsupported(token, i);
        } else {
          arg(i, 'option'); unsupported(token, i);
        }
      } else if (paths) {
        arg(i, 'read_path');
        if (token.startsWith(':') || /[*?[]/u.test(token)) reason('unsupported_pathspec', token,
          'Git pathspec expansion is not resolved by this preflight.', '此预检不解析 Git pathspec 展开范围。');
      } else if (token === '--output' || token.startsWith('--output=')) {
        effects.add('workspace_write'); unsupported(token, i, '--output');
        if (token === '--output') i = valueAfter(i, 'write_path');
        else arg(i, 'write_path', token.slice('--output='.length));
      } else if (['--ext-diff', '--textconv', '--show-signature'].includes(token)) {
        arg(i, 'option'); helper(token);
      } else if (token === '--remerge-diff' || /^--diff-merges=(?:remerge|r)$/u.test(token)) {
        arg(i, 'option'); effects.add('workspace_write'); unsupported(token, i);
      } else if (token === '-O' || token.startsWith('-O')) {
        unsupported(token, i, '-O');
        if (token === '-O') i = valueAfter(i, 'read_path');
        else arg(i, 'read_path', token.slice(2));
      } else if (subcommand === 'log' && (token.startsWith('-S') || token.startsWith('-G'))) {
        // Pickaxe patterns are text option values, never revisions/pathspecs.
        // Bound the raw UTF-8 value without changing the argv sent to Git.
        const optionIndex = i;
        const attached = token.length > 2;
        if (attached) arg(i, 'option_value', token.slice(2));
        else i = valueAfter(i, 'option_value', true);
        if (attached || i !== optionIndex) {
          const value = attached ? token.slice(2) : args[i];
          if (!value.trim() || value.includes('\0') || Buffer.byteLength(value, 'utf8') > 4_096) {
            reason('invalid_argv', token.slice(0, 2),
              'Git pickaxe requires a nonblank pattern of at most 4096 UTF-8 bytes without NUL.',
              'Git pickaxe 的模式不能为空白、不能含 NUL，且不能超过 4096 个 UTF-8 字节。');
            result.reasons.at(-1)!.argumentIndex = i;
            result.reasons.at(-1)!.invalidArgvKind = 'option_value';
          }
        }
      } else if (subcommand === 'log' && ['--pickaxe-regex', '--all'].includes(token)) {
        arg(i, 'option');
      } else if (['-n', '--max-count', '-U', '--unified'].includes(token)) {
        i = valueAfter(i, 'option_value');
        if (!/^\d+$/u.test(args[i])) invalid('option_value', args[i] ?? token, i);
      } else if (/^(?:--(?:format|pretty|date|encoding|grep|author|committer)=)/u.test(token)) {
        const value = token.slice(token.indexOf('=') + 1);
        arg(i, 'text', value);
        if (/^--(?:format|pretty)=/u.test(token) && /%G/u.test(value)) helper(token);
      } else if (/^(?:--(?:max-count|unified)=\d+|-[nU]\d+)$/u.test(token)
        || (subcommand === 'log' && /^-\d+$/u.test(token))
        || (subcommand === 'log' && /^(?:--no-decorate|--decorate(?:=(?:short|full|auto|no))?)$/u.test(token))
        || ['--format', '--pretty', '--oneline', '--stat', '--numstat', '--shortstat', '--name-only', '--name-status',
          '--raw', '-p', '-u', '--patch', '-s', '--no-patch', '--no-ext-diff', '--no-textconv', '--no-color',
          '--color=never', '--cached', '--staged', '--summary', '--check', '--binary', '--full-index', '--no-renames', '--exit-code', '--quiet'].includes(token)) {
        arg(i, 'option');
      } else if (token === '--no-index') {
        arg(i, 'option'); noIndex = true; unsupported(token, i);
      } else if (token.startsWith('-')) {
        arg(i, 'option'); unsupported(token, i);
      } else {
        // A bare diff operand may be a revision or a file. Git can
        // implicitly use --no-index when an operand is outside the worktree.
        const obviousRevision = isLocalGitRevisionRange(token) || isLocalGitRevision(token)
          && (subcommand === 'log' || /^(?:HEAD|[a-f0-9]{4,64}|refs\/)/u.test(token) || /\^\{(?:tree|commit|tag|object)\}$/u.test(token));
        arg(i, noIndex || !obviousRevision ? 'read_path' : 'revision');
      }
    }
    if (staging && !result.reasons.length) {
      result.gitStage = { pathspecs: result.arguments.filter(item => item.role === 'read_path').map(item => item.value) };
    }
    if (committing && !unsupportedCommitOption && !result.gitReplan) {
      if (commitAll && commitPathspecPositions.length) {
        const positions = commitPathspecPositions.join(', ');
        result.gitReplan = {
          code: 'git_commit_all_with_pathspec',
          message: `Git commit -a conflicts with positional arguments ${positions}. Nothing executed. If these are message paragraphs, use a single complete message argument or repeat -m for each paragraph. / Git commit 的 -a 与第 ${positions} 个位置参数冲突。原命令未启动。若这些是提交说明，请使用一个完整的说明参数，或为每个段落显式添加 -m。`
        };
      } else if (!commitMessages.some(message => message.trim())) {
        result.gitReplan = {
          code: 'git_commit_missing_message',
          message: 'Git commit needs an explicit nonempty message passed to -m. Nothing executed. / Git commit 需要通过 -m 提供非空的提交说明。原命令未启动。'
        };
      } else if (commitPathspecPositions.length) {
        unsupported('commit pathspec');
      } else {
        result.gitCommit = { all: commitAll, messages: commitMessages };
      }
    }
    if (result.gitReplan) {
      result.reasons.push({ code: 'git_commit_argv', detail: result.gitReplan.code, message: result.gitReplan.message });
    }
    if (!result.reasons.some(item => ['unsupported_option', 'missing_option_value', 'invalid_argv', 'external_helper', 'git_configuration'].includes(item.code))) {
      if (query) result.gitLocalQuery = query;
      else if (listingTags) result.gitLocalQuery = { kind: 'tag_list', revisions: [] };
      else if (subcommand === 'log' && !effects.has('workspace_write')) result.gitLocalQuery = {
        kind: 'log', revisions: result.arguments.filter(item => item.role === 'revision').map(item => item.value)
      };
    }
    // Keep the equivalent for ask-mode corrections and historical diagnostics.
    // Delegate can review the exact display-only override after repository checks.
    if (args.length === 4 && args[0] === '-c' && args[1] === 'core.pager=cat'
      && args[2] === 'status' && args[3] === '--porcelain=v1' && spec.env.length === 0) {
      result.gitReplan = {
        code: 'git_status_pager_override',
        message: 'Use the same status format with --no-pager and --no-optional-locks. Nothing executed. / 请使用 --no-pager 和 --no-optional-locks 读取相同格式的 Git 状态。原命令未启动。',
        candidateArgs: ['--no-pager', '--no-optional-locks', 'status', '--porcelain=v1']
      };
    }
    // A syntactically local Git operation still needs live repository scope.
    reason('git_runtime', subcommand ?? 'git',
      'Git configuration, repository location and helpers must be checked before automatic approval.',
      '自动批准前需要核对 Git 配置、仓库位置及外部程序。');
  } else if (['cat', 'head', 'tail', 'wc', 'pwd', 'ls', 'grep', 'rg'].includes(program)) {
    effects.add('workspace_read');
    const shortOptions: Record<string, RegExp> = {
      cat: /^-[AbBenstTuvE]+$/u, head: /^-[qv]+$/u, tail: /^-[qv]+$/u,
      wc: /^-[clmwL]+$/u, pwd: /^-[LP]+$/u, ls: /^-[aAldhinrstSF1]+$/u,
      grep: /^-[EFivnclHhoqs]+$/u, rg: /^-[FivnclHoqs]+$/u
    };
    let paths = false;
    let patternSeen = !['grep', 'rg'].includes(program);
    for (let i = 0; i < args.length; i++) {
      const token = args[i];
      if (!paths && token === '--') { paths = true; arg(i, 'option'); continue; }
      if (!paths && token.startsWith('-') && token !== '-') {
        if (['head', 'tail'].includes(program) && ['-n', '-c', '--lines', '--bytes'].includes(token)) {
          i = valueAfter(i, 'option_value');
          if (!/^[+-]?\d+$/u.test(args[i])) invalid('option_value', args[i] ?? token, i);
        } else if (['head', 'tail'].includes(program) && /^(?:-[nc][+-]?\d+|--(?:lines|bytes)=[+-]?\d+)$/u.test(token)) {
          arg(i, 'option');
        } else if (['grep', 'rg'].includes(program) && ['-e', '--regexp', '-f', '--file'].includes(token)) {
          patternSeen = true; i = valueAfter(i, ['-f', '--file'].includes(token) ? 'read_path' : 'text');
        } else if (['grep', 'rg'].includes(program) && /^--(?:regexp|file)=/u.test(token)) {
          patternSeen = true; arg(i, token.startsWith('--file=') ? 'read_path' : 'text', token.slice(token.indexOf('=') + 1));
        } else if (shortOptions[program].test(token)) arg(i, 'option');
        else { arg(i, 'option'); unsupported(token, i); if (/^--(?:pre|hostname-bin)(?:=|$)/u.test(token)) helper(token); }
      } else if (!patternSeen) { arg(i, 'text'); patternSeen = true; }
      else if (program === 'pwd') { arg(i, 'text'); unsupported(token, i); }
      else arg(i, 'read_path');
    }
    // rg searches directories, ignore/config files and symlinked explicit roots;
    // recursive search isn't bounded just by checking its top-level operands.
    if (program === 'rg') reason('unsupported_option', 'rg recursive search',
      'Recursive search and configuration paths require exact scope authorization.', '递归搜索与配置文件路径需要精确范围授权。');
  } else if (['echo', 'printf', 'true', 'false'].includes(program)) {
    args.forEach((_, i) => arg(i, 'text'));
  } else if (/^(?:(?:ba|z|k|c|fi)?sh|cmd|pwsh|powershell|ruby|perl|bun|npm|pnpm|yarn)$/u.test(program)
    || isNodeProgram(program) || isPythonProgram(program)) {
    effects.add('shell_interpreter'); effects.add('arbitrary_code');
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)
      && ['ci', 'install', 'add', 'remove', 'uninstall', 'update', 'upgrade', 'publish'].includes(args[0])) {
      effects.add('package_install'); effects.add('workspace_write'); effects.add('network');
      if (args[0] === 'publish') effects.add('publish_or_deploy');
    }
    const entryIndex = projectFileArgument(program, args);
    const packageScript = projectPackageScript(program, args);
    if (entryIndex !== undefined) {
      result.projectScript = true;
      for (let index = 0; index < entryIndex; index++) arg(index, 'option');
      arg(entryIndex, 'script');
      for (let index = entryIndex + 1; index < args.length; index++) scriptArg(index);
    } else if (packageScript) {
      result.projectPackageScript = packageScript;
      arg(0, 'subcommand');
      arg(1, 'text');
      if (args.length > 2) arg(2, 'option');
      for (let index = 3; index < args.length; index++) scriptArg(index);
    } else {
      const inline = args.findIndex(a => ['-c', '-e', '--eval', '-Command', '-command', '/c', '/C'].includes(a)
      || (program.endsWith('sh') && /^-[a-z]*c[a-z]*$/u.test(a)));
      let scriptSeen = false;
      let preloadValue = false;
      const packageManager = ['npm', 'pnpm', 'yarn', 'bun'].includes(program);
      const directoryOption = /^(?:--prefix|--cwd|--dir|--cache|-C)$/u;
      args.forEach((value, i) => {
        const attachedDirectory = /^(?:--(?:prefix|cwd|dir|cache)=|-C(?=\/|\.|[a-z]:))(.*)$/iu.exec(value);
        const preload = isNodeProgram(program) ? /^(?:-r|--(?:require|import|loader|experimental-loader|env-file|env-file-if-exists|experimental-config-file|experimental-policy))(?:=(.*))?$/u.exec(value) : undefined;
        if (preloadValue) { scriptArg(i); preloadValue = false; }
        else if (preload && (inline < 0 || i < inline)) {
          if (preload[1] === undefined) { arg(i, 'option'); preloadValue = true; }
          else scriptArg(i);
          reason('external_helper', value, 'This option can load additional code before the script entry.', '此选项可在脚本入口之前加载额外代码。');
        } else if (isPythonProgram(program) && /^-c.+/su.test(value) && !scriptSeen) {
          arg(i, 'inline_code', value.slice(2));
          reason('inline_code', program, 'Inline code requires separate approval.', '内联代码需单独审批。');
          scriptSeen = true;
        } else if (inline >= 0) arg(i, i === inline + 1 ? 'inline_code' : i <= inline ? 'option' : 'text');
        else if (packageManager && attachedDirectory) arg(i, 'write_path', attachedDirectory[1]);
        else if (packageManager && directoryOption.test(args[i - 1] ?? '')) arg(i, 'write_path');
        else if (packageManager && isExternalNetworkTarget(value.replace(/^--[\w-]+=/u, ''))) scriptArg(i);
        else if (packageManager) arg(i, i === 0 && !value.startsWith('-') ? 'subcommand' : value.startsWith('-') ? 'option' : 'text');
        else if (value.startsWith('-')) arg(i, 'option');
        else { arg(i, scriptSeen ? 'text' : 'script'); scriptSeen = true; }
      });
      if (inline >= 0) reason('inline_code', program, 'Inline code requires separate approval.', '内联代码需单独审批。');
    }
    if (!result.reasons.some(item => item.code === 'inline_code')) reason('script_execution', program,
      'Script contents, shell syntax and package lifecycle commands are not statically scoped.',
      '脚本内容、shell 语法和包生命周期命令无法静态确定范围。');
  } else {
    const writers = ['rm', 'rmdir', 'del', 'erase', 'unlink', 'truncate', 'mkfs', 'format', 'dd', 'cp', 'mv', 'mkdir', 'touch', 'install', 'tee', 'patch', 'chmod', 'chown', 'chgrp', 'setfacl'];
    if (writers.includes(program)) effects.add('workspace_write');
    if (['curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'telnet'].includes(program)) effects.add('network');
    if (['sudo', 'doas', 'runas', 'pkexec'].includes(program)) effects.add('privilege_escalation');
    if (['printenv', 'env', 'set'].includes(program)) effects.add('credential_access');
    if (!effects.size && /[/\\]/u.test(spec.executable)) {
      result.projectExecutable = true;
      effects.add('arbitrary_code');
      args.forEach((_, i) => scriptArg(i));
      reason('script_execution', program, 'The explicit executable can run project code.', '显式可执行文件可运行项目代码。');
    } else args.forEach((value, i) => {
      if (program === 'dd' && /^(?:if|of)=/u.test(value)) {
        arg(i, value.startsWith('of=') ? 'write_path' : 'read_path', value.slice(3));
        return;
      }
      // This fallback only identifies explicit path-shaped operands. It never
      // claims unknown arguments/effects are fully covered.
      const operand = value.replace(/^--[\w-]+=/u, '').replace(/^-[Cof](?=\/|\.\.?[\\/]|[A-Za-z]:[\\/])/u, '');
      const remoteTarget = isExternalNetworkTarget(operand);
      if (remoteTarget || /^(?:https?|ssh|git):\/\//u.test(operand)) {
        if (remoteTarget) {
          effects.add('network');
          (result.networkTargets ??= []).push(operand);
        }
        arg(i, 'text', operand);
      } else {
        const output = isOutputArgument(i) || program === 'curl'
          && (args[i - 1] === '-o' || /^-o(?:\/|\.\.?[\\/]|[A-Za-z]:[\\/])/u.test(value));
        arg(i, output ? 'write_path' : /[/\\]/u.test(operand) || !value.startsWith('-')
          ? (writers.includes(program) ? 'write_path' : 'read_path') : 'option', operand);
      }
    });
    if (!result.projectExecutable) reason('unsupported_program', program, 'No bounded argument grammar is available for this program.', '该程序没有受支持的有限参数规则。');
  }
  if (spec.env.length) reason('environment_override', spec.env.map(e => e.name).join(', '),
    'Environment overrides can change execution or configuration lookup.', '环境变量覆盖可能改变执行行为或配置查找。');
  result.effects = [...effects];
  return result;
}
