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
    if (!viewing) unsupported(subcommand ?? 'missing Git subcommand');
    let paths = false;
    let noIndex = false;
    for (; i < args.length; i++) {
      const token = args[i];
      if (!paths && token === '--') { paths = true; arg(i, 'option'); continue; }
      if (paths) {
        arg(i, 'read_path');
        if (token.startsWith(':') || /[*?[]/u.test(token)) reason('unsupported_pathspec', token,
          'Git pathspec expansion is not resolved by this preflight.', '此预检不解析 Git pathspec 展开范围。');
      } else if (token === '--output' || token.startsWith('--output=')) {
        effects.add('workspace_write');
        if (token === '--output') i = valueAfter(i, 'write_path');
        else arg(i, 'write_path', token.slice('--output='.length));
      } else if (['--ext-diff', '--textconv', '--show-signature'].includes(token)) {
        arg(i, 'option'); helper(token);
      } else if (token === '--remerge-diff' || /^--diff-merges=(?:remerge|r)$/u.test(token)) {
        arg(i, 'option'); effects.add('workspace_write'); unsupported(token);
      } else if (token === '-O' || token.startsWith('-O')) {
        if (token === '-O') i = valueAfter(i, 'read_path');
        else arg(i, 'read_path', token.slice(2));
      } else if (['-n', '--max-count', '-U', '--unified'].includes(token)) {
        i = valueAfter(i, 'option_value');
        if (!/^\d+$/u.test(args[i])) unsupported(args[i]);
      } else if (/^(?:--(?:format|pretty|date|encoding|grep|author|committer)=)/u.test(token)) {
        arg(i, 'text', token.slice(token.indexOf('=') + 1));
      } else if (/^(?:--(?:max-count|unified)=\d+|-[nU]\d+)$/u.test(token)
        || ['--format', '--pretty', '--oneline', '--stat', '--numstat', '--shortstat', '--name-only', '--name-status',
          '--raw', '-p', '-u', '--patch', '-s', '--no-patch', '--no-ext-diff', '--no-textconv', '--no-color',
          '--color=never', '--cached', '--staged', '--binary', '--full-index', '--no-renames', '--exit-code', '--quiet'].includes(token)) {
        arg(i, 'option');
      } else if (token === '--no-index') {
        arg(i, 'option'); noIndex = true;
      } else if (token.startsWith('-')) {
        arg(i, 'option'); unsupported(token);
      } else {
        arg(i, noIndex ? 'read_path' : 'revision');
        // Bare operands in supported views are revisions. No suffix or keyword
        // can turn a revision/format/path into an executed command.
      }
    }
    // The ordinary DraftRun executor inherits HOME and reads repository config.
    // Even --no-ext-diff/--no-textconv cannot bound include files, fsmonitor,
    // pager overrides, lazy fetch or repository indirection. Do not silently
    // rewrite persisted specs or use the advisory read-only classification as authority.
    reason('git_runtime', subcommand ?? 'git',
      'Git configuration, repository indirection and helper behavior are not constrained by this DraftRun; authorize the exact operation.',
      '此 DraftRun 未约束 Git 配置、仓库重定向及外部程序行为；请授权精确操作。');
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
    reason(inline >= 0 ? 'inline_code' : 'script_execution', program,
      'Script contents, shell syntax and package lifecycle commands are not statically scoped.',
      '脚本内容、shell 语法和包生命周期命令无法静态确定范围。');
  } else {
    const writers = ['rm', 'rmdir', 'del', 'erase', 'unlink', 'truncate', 'mkfs', 'format', 'cp', 'mv', 'mkdir', 'touch', 'install', 'tee', 'patch'];
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
