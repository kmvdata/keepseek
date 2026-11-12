import * as path from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { CommandSemantics } from './commandSemantics';
import { isPathInside } from './pathScope';
import { isExternalNetworkTarget } from './projectLaunchArguments';

const destructiveProgram = /^(?:rm|rmdir|del|erase|unlink|remove-item|rd)(?:\.exe)?$/iu;
const forbiddenProgram = /^(?:sudo|doas|pkexec|runas|su|mkfs(?:\.[\w-]+)?|mke2fs|fdisk|diskutil|format|diskpart|shutdown|reboot|printenv)(?:\.(?:exe|com))?$/iu;
const protectedReference = /(?:^|[/\\])(?:\.ssh|\.aws|\.gnupg|\.kube|\.codex|\.env(?:\.[\w-]+)?|\.npmrc|\.netrc|id_rsa|id_ed25519)(?:[/\\]|$)/iu;
const commandWords = /"[^"]*"|'[^']*'|[^\s;|&(),<>[\]{}"']+/gu;

function visibleWords(code: string): string[] {
  const words = code.match(commandWords) ?? [];
  return words.flatMap(word => {
    const value = word.replace(/^(['"])(.*)\1$/su, '$2');
    const nestedCommand = /^(?:[^\s]+[/\\])?(?:rm|rmdir|del|remove-item|sudo|doas|pkexec|runas|su|mkfs(?:\.[\w-]+)?|diskutil|format)\s/iu.test(value);
    return nestedCommand ? value.match(commandWords) ?? [] : [word];
  });
}

export function assertCommandTarget(target: string, writes: boolean): void {
  if (!writes) return;
  const normalized = path.resolve(target);
  const home = homedir();
  const parentOfHome = home && isPathInside(normalized, home);
  if (normalized === path.parse(normalized).root || parentOfHome) throw new Error(
    'Protected root or home directory target. Nothing executed. / 禁止修改根目录、用户主目录或其上级目录，尚未执行。');
}

/** Extract visible targets from explicit shell and interpreter arguments. This
 * provides concrete denial evidence. Dynamic subprocess effects remain unknown. */
export function inspectVisibleCommandTargets(semantics: CommandSemantics,
  collectNetworkTarget?: (value: string) => void, isolated = false): Array<{ value: string; write: boolean }> {
  const targets: Array<{ value: string; write: boolean }> = [];
  const fail = () => { throw new Error('Protected command or credential target. Nothing executed. / 操作涉及受保护的命令或凭据目标，尚未执行。'); };
  if (forbiddenProgram.test(semantics.program)) fail();
  for (const arg of semantics.arguments) {
    if (arg.role === 'option' && /^(?:powershell|pwsh)$/u.test(semantics.program)
      && /^-(?:e|ec|enc|encodedcommand)$/iu.test(arg.value)) fail();
    if (arg.role === 'text' && !semantics.effects.includes('arbitrary_code')) continue;
    if (arg.role === 'option' || arg.role === 'subcommand' || arg.role === 'revision') continue;
    if (arg.role !== 'inline_code') {
      if (protectedReference.test(arg.value)) fail();
      if (arg.role === 'text') {
        const raw = arg.value.replace(/^--[\w-]+=/u, '');
        if (/^file:/iu.test(raw)) {
          try { targets.push({ value: fileURLToPath(raw), write: false }); }
          catch { fail(); }
          continue;
        }
        const value = arg.value.replace(/^--[\w-]+=/u, '').replace(/^file:(?!\/\/)/iu, '');
        const isCache = /^(?:npm|pnpm|yarn|bun)$/u.test(semantics.program) && arg.value.startsWith('--cache=');
        if (isCache || /^(?:\/[^/]|[A-Za-z]:[/\\]|\\\\|\.\.?[/\\]|~[/\\])/u.test(value)) {
          targets.push({ value: value.startsWith('~') ? path.join(homedir(), value.slice(2)) : value, write: isCache });
        }
      }
      continue;
    }
    const code = arg.value;
    const destructive = /\b(?:rm|rmdir|unlink|rmtree|Remove-Item|rimraf|removeSync)\b/iu.test(code);
    const writes = destructive || /(?:>>?|\b(?:writeFile(?:Sync)?|mkdir|rename|mv|cp|touch|tee)\b|\.write_text\(|\bopen\([^,]+,\s*['"][wax])/u.test(code);
    for (const word of visibleWords(code)) {
      const value = word.replace(/^(['"])(.*)\1$/su, '$2').replace(/^--[\w-]+=/u, '');
      const program = path.win32.basename(path.posix.basename(value));
      if (forbiddenProgram.test(program) || protectedReference.test(value)
        || /^(?:\/etc\/(?:shadow|sudoers)|\/proc\/(?:self|\d+)\/environ)$/u.test(value)) fail();
      if (destructive && /^(?:~|~\/|\$(?:\{HOME\}|HOME|\{USERPROFILE\}|USERPROFILE)(?:[/\\].*)?|%USERPROFILE%(?:[/\\].*)?|\/(?:[*?]+)?|[A-Za-z]:[/\\](?:[*?]+)?)$/iu.test(value)) fail();
      if (/^of=(?:\/dev\/|\\\\\.\\)/iu.test(value) && /\bdd\b/u.test(code)) fail();
      if (isExternalNetworkTarget(value)) collectNetworkTarget?.(value);
      if (/^(?:\/|[A-Za-z]:[/\\]|\\\\|\.\.[/\\]|~[/\\])/u.test(value)) {
        targets.push({ value: value.startsWith('~') ? path.join(homedir(), value.slice(2)) : value, write: writes });
      }
    }
    if (!isolated && (/\bgit\b[^\n;&|]*(?:\b(?:push|fetch|pull|clone|worktree|reset|rebase|filter-branch|commit|config)\b|\s(?:-C|-c|--git-dir|--work-tree|--exec-path)\b)/u.test(code)
      || /\b(?:curl|wget|scp|sftp|ssh)\b[^\n;&|]*(?:https?:\/\/|@)/iu.test(code)
      || /\b(?:npm|pnpm|yarn|bun)\b[^\n;&|]*\bpublish\b|\b(?:socket\.create_connection|child_process\.execSync)\s*\(\s*['"](?:curl|wget|ssh)\b/u.test(code)
      || /\bsocket\.create_connection\s*\(\s*\(\s*['"](?!localhost['"]|127\.0\.0\.1['"]|::1['"])/u.test(code))) fail();
    for (const match of code.matchAll(/\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rmtree|mkdir(?:Sync)?|rmSync|removeSync)\s*\(\s*(['"])([^'"]+)\1/gu)) {
      targets.push({ value: match[2], write: true });
    }
    if (/(?:^|[/\\])(?:bash|sh|zsh|fish|dash|ksh|cmd|powershell|pwsh)$/u.test(semantics.program)) {
      for (const segment of code.split(/[;|&\n]/u)) {
        const command = segment.match(/^\s*(?:command\s+)?(?:[\w/.-]*\/)?(?:rm|rmdir|mkdir|touch|tee)\s+(.+)$/u);
        for (const operand of command?.[1].match(/"[^"]*"|'[^']*'|\S+/gu) ?? []) {
          const value = operand.replace(/^(['"])(.*)\1$/su, '$2');
          if (!/^[-$~*?]|[<>]/u.test(value)) targets.push({ value, write: true });
        }
      }
    }
  }
  if (destructiveProgram.test(semantics.program)) {
    for (const arg of semantics.arguments) if (/^(?:~|~[/\\].*|\$(?:\{HOME\}|HOME)(?:[/\\].*)?)$/u.test(arg.value)) fail();
  }
  return targets;
}
