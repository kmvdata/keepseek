import * as path from 'node:path';
import type { DraftRunEffect, DraftRunSpec } from '../../shared/types';
import { authorizationReason, type AuthorizationReason } from './reasons';

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
  gitCommit?: { all: boolean; messages: string[] };
  gitReplan?: GitCommandReplan;
  projectScript?: true;
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
  const unsupported = (value: string) => reason('unsupported_option', value,
    'This argument or behavior is outside the supported command grammar; authorize the exact operation.',
    '该参数或行为不在支持的命令语法内；请授权精确操作。');
  const valueAfter = (index: number, role: ArgumentRole): number => {
    arg(index, 'option');
    if (index + 1 >= args.length) {
      reason('missing_option_value', args[index], 'Missing option value.', '缺少选项值。');
      return index;
    }
    arg(index + 1, role);
    return index + 1;
  };
  const helper = (value: string) => {
    effects.add('arbitrary_code');
    reason('external_helper', value, 'This option can invoke an external program.', '该选项可能调用外部程序。');
  };

  // Version queries are still subject to executable identity and environment checks.
  const versionPrograms = new Set(['git', 'node', 'bun', 'npm', 'python', 'python3', 'ruby', 'perl', 'rg', 'grep']);
  if (args.length === 1 && ['--version', '-V'].includes(args[0]) && versionPrograms.has(program)) {
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
      } else {
        arg(i, 'option'); unsupported(token);
        if (['-p', '--paginate'].includes(token) || token.startsWith('--exec-path')) helper(token);
      }
    }
    const subcommand = args[i];
    if (subcommand) arg(i++, 'subcommand');
    const viewing = ['show', 'diff', 'log'].includes(subcommand);
    if (['add', 'apply', 'am', 'branch', 'checkout', 'clean', 'clone', 'commit', 'fetch', 'gc', 'init', 'merge', 'mv',
      'pull', 'push', 'rebase', 'remote', 'reset', 'restore', 'revert', 'rm', 'stash', 'switch', 'tag', 'worktree'].includes(subcommand)) effects.add('git_mutation');
    if (['clone', 'fetch', 'pull', 'push'].includes(subcommand)) effects.add('network');
    const staging = subcommand === 'add';
    const committing = subcommand === 'commit';
    const status = subcommand === 'status';
    if (!viewing && !staging && !committing && !status) unsupported(subcommand ?? 'missing Git subcommand');
    const commitMessages: string[] = [];
    const commitPathspecPositions: number[] = [];
    let commitAll = false;
    let unsupportedCommitOption = false;
    let paths = false;
    let noIndex = false;
    for (; i < args.length; i++) {
      const token = args[i];
      if (!paths && token === '--') { paths = true; arg(i, 'option'); continue; }
      if (committing) {
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
          unsupported(token);
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
      } else if (staging || status) {
        if (!paths && (staging ? ['-A', '--all', '-u', '--update', '--ignore-removal', '--no-all', '-v', '--verbose'].includes(token)
            : /^(?:-s|-b|-sb|-bs|-z|--short|--branch|--porcelain(?:=v[12])?|--long|--no-renames|--untracked-files(?:=(?:no|normal|all))?|-u(?:no|normal|all)?)$/u.test(token))) {
          arg(i, 'option');
        } else if (paths || !token.startsWith('-')) {
          arg(i, 'read_path');
          if (token.startsWith(':') || /[*?[]/u.test(token)) unsupported(token);
        } else {
          arg(i, 'option'); unsupported(token);
        }
      } else if (paths) {
        arg(i, 'read_path');
        if (token.startsWith(':') || /[*?[]/u.test(token)) reason('unsupported_pathspec', token,
          'Git pathspec expansion is not resolved by this preflight.', '此预检不解析 Git pathspec 展开范围。');
      } else if (token === '--output' || token.startsWith('--output=')) {
        effects.add('workspace_write'); unsupported(token);
        if (token === '--output') i = valueAfter(i, 'write_path');
        else arg(i, 'write_path', token.slice('--output='.length));
      } else if (['--ext-diff', '--textconv', '--show-signature'].includes(token)) {
        arg(i, 'option'); helper(token);
      } else if (token === '--remerge-diff' || /^--diff-merges=(?:remerge|r)$/u.test(token)) {
        arg(i, 'option'); effects.add('workspace_write'); unsupported(token);
      } else if (token === '-O' || token.startsWith('-O')) {
        unsupported(token);
        if (token === '-O') i = valueAfter(i, 'read_path');
        else arg(i, 'read_path', token.slice(2));
      } else if (['-n', '--max-count', '-U', '--unified'].includes(token)) {
        i = valueAfter(i, 'option_value');
        if (!/^\d+$/u.test(args[i])) unsupported(args[i]);
      } else if (/^(?:--(?:format|pretty|date|encoding|grep|author|committer)=)/u.test(token)) {
        const value = token.slice(token.indexOf('=') + 1);
        arg(i, 'text', value);
        if (/^--(?:format|pretty)=/u.test(token) && /%G/u.test(value)) helper(token);
      } else if (/^(?:--(?:max-count|unified)=\d+|-[nU]\d+)$/u.test(token)
        || (subcommand === 'log' && /^-\d+$/u.test(token))
        || ['--format', '--pretty', '--oneline', '--stat', '--numstat', '--shortstat', '--name-only', '--name-status',
          '--raw', '-p', '-u', '--patch', '-s', '--no-patch', '--no-ext-diff', '--no-textconv', '--no-color',
          '--color=never', '--cached', '--staged', '--summary', '--check', '--binary', '--full-index', '--no-renames', '--exit-code', '--quiet'].includes(token)) {
        arg(i, 'option');
      } else if (token === '--no-index') {
        arg(i, 'option'); noIndex = true; unsupported(token);
      } else if (token.startsWith('-')) {
        arg(i, 'option'); unsupported(token);
      } else {
        // A bare diff operand may be a revision or a file. Git can
        // implicitly use --no-index when an operand is outside the worktree.
        const obviousRevision = /^(?:HEAD|[a-f0-9]{4,64}|refs\/[a-zA-Z0-9_./-]+)(?:[~^]\d*)?$/u.test(token)
          && !/(?:^|\/)\.\.(?:\/|$)/u.test(token);
        arg(i, noIndex || !obviousRevision ? 'read_path' : 'revision');
      }
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
    // This exact display-only override has an equivalent for captured stdout.
    // Keep the original config override outside the automatic approval grammar.
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
          if (!/^[+-]?\d+$/u.test(args[i])) unsupported(args[i]);
        } else if (['head', 'tail'].includes(program) && /^(?:-[nc][+-]?\d+|--(?:lines|bytes)=[+-]?\d+)$/u.test(token)) {
          arg(i, 'option');
        } else if (['grep', 'rg'].includes(program) && ['-e', '--regexp', '-f', '--file'].includes(token)) {
          patternSeen = true; i = valueAfter(i, ['-f', '--file'].includes(token) ? 'read_path' : 'text');
        } else if (['grep', 'rg'].includes(program) && /^--(?:regexp|file)=/u.test(token)) {
          patternSeen = true; arg(i, token.startsWith('--file=') ? 'read_path' : 'text', token.slice(token.indexOf('=') + 1));
        } else if (shortOptions[program].test(token)) arg(i, 'option');
        else { arg(i, 'option'); unsupported(token); if (/^--(?:pre|hostname-bin)(?:=|$)/u.test(token)) helper(token); }
      } else if (!patternSeen) { arg(i, 'text'); patternSeen = true; }
      else if (program === 'pwd') { arg(i, 'text'); unsupported(token); }
      else arg(i, 'read_path');
    }
    // rg searches directories, ignore/config files and symlinked explicit roots;
    // recursive search isn't bounded just by checking its top-level operands.
    if (program === 'rg') reason('unsupported_option', 'rg recursive search',
      'Recursive search and configuration paths require exact scope authorization.', '递归搜索与配置文件路径需要精确范围授权。');
  } else if (['echo', 'printf', 'true', 'false'].includes(program)) {
    args.forEach((_, i) => arg(i, 'text'));
  } else if (/^(?:(?:ba|z|k|c|fi)?sh|cmd|pwsh|powershell|node|python\d*|ruby|perl|bun|npm|pnpm|yarn)$/u.test(program)) {
    effects.add('shell_interpreter'); effects.add('arbitrary_code');
    if (['npm', 'pnpm', 'yarn', 'bun'].includes(program)
      && ['ci', 'install', 'add', 'remove', 'uninstall', 'update', 'upgrade', 'publish'].includes(args[0])) {
      effects.add('package_install'); effects.add('workspace_write'); effects.add('network');
      if (args[0] === 'publish') effects.add('publish_or_deploy');
    }
    const scriptExtension = /^(?:sh|bash|zsh)$/u.test(program) ? /\.sh$/u
      : /^python\d*$/u.test(program) ? /\.py$/u
        : program === 'node' ? /\.(?:js|mjs|cjs)$/u : undefined;
    if (scriptExtension?.test(args[0] ?? '') && !args[0].startsWith('-')) {
      const operands = args.slice(1).map(value => value.replace(/^--[\w-]+=/u, '')
        .replace(/^-[A-Za-z](?=\/|\.\.?[\\/]|[A-Za-z]:[\\/])/u, ''));
      // The first argv is a file, so later flags are script arguments, not
      // interpreter flags. Explicit URI arguments do not enter this lane.
      result.projectScript = operands.some(value => /^(?:[a-z][a-z\d+.-]*:\/\/|file:|~[\\/])/iu.test(value)) ? undefined : true;
      arg(0, 'script');
      operands.forEach((operand, index) => {
        arg(index + 1, operand.startsWith('-') || /^(?:[a-z][a-z\d+.-]*:\/\/|file:|~[\\/])/iu.test(operand) ? 'text' : 'read_path', operand);
      });
    } else {
      const inline = args.findIndex(a => ['-c', '-e', '--eval', '-Command', '-command', '/c', '/C'].includes(a)
      || (program.endsWith('sh') && /^-[a-z]*c[a-z]*$/u.test(a)));
      let scriptSeen = false;
      const packageManager = ['npm', 'pnpm', 'yarn'].includes(program);
      args.forEach((value, i) => {
        if (inline >= 0) arg(i, i === inline + 1 ? 'inline_code' : i <= inline ? 'option' : 'text');
        else if (packageManager) arg(i, i === 0 ? 'subcommand' : 'text');
        else if (program === 'bun' && i === 0 && ['run', 'install', 'add', 'remove', 'update', 'test', 'build', 'x'].includes(value)) arg(i, 'subcommand');
        else if (value.startsWith('-')) arg(i, 'option');
        else { arg(i, scriptSeen ? 'text' : 'script'); scriptSeen = true; }
      });
      if (inline >= 0) reason('inline_code', program, 'Inline code requires separate approval.', '内联代码需单独审批。');
    }
    if (!result.reasons.some(item => item.code === 'inline_code')) reason('script_execution', program,
      'Script contents, shell syntax and package lifecycle commands are not statically scoped.',
      '脚本内容、shell 语法和包生命周期命令无法静态确定范围。');
  } else {
    const writers = ['rm', 'rmdir', 'del', 'erase', 'unlink', 'truncate', 'mkfs', 'format', 'cp', 'mv', 'mkdir', 'touch', 'install', 'tee', 'patch', 'chmod', 'chown', 'chgrp', 'setfacl'];
    if (writers.includes(program)) effects.add('workspace_write');
    if (['curl', 'wget', 'ssh', 'scp', 'sftp', 'ftp', 'nc', 'ncat', 'telnet'].includes(program)) effects.add('network');
    if (['sudo', 'doas', 'runas', 'pkexec'].includes(program)) effects.add('privilege_escalation');
    if (['printenv', 'env', 'set'].includes(program)) effects.add('credential_access');
    args.forEach((value, i) => {
      // This fallback only identifies explicit path-shaped operands. It never
      // claims unknown arguments/effects are fully covered.
      const operand = value.replace(/^--[\w-]+=/u, '').replace(/^-[Cof](?=\/|\.\.?[\\/]|[A-Za-z]:[\\/])/u, '');
      arg(i, /^(?:https?|ssh|git):\/\//u.test(operand) ? 'text'
        : /[/\\]/u.test(operand) || !value.startsWith('-') ? (writers.includes(program) ? 'write_path' : 'read_path') : 'option', operand);
    });
    reason('unsupported_program', program, 'No bounded argument grammar is available for this program.', '该程序没有受支持的有限参数规则。');
  }
  if (spec.env.length) reason('environment_override', spec.env.map(e => e.name).join(', '),
    'Environment overrides can change execution or configuration lookup.', '环境变量覆盖可能改变执行行为或配置查找。');
  result.effects = [...effects];
  return result;
}
