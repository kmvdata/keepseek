import * as path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import * as vscode from 'vscode';
import type { DraftRun } from '../shared/types';

/** A bounded scope preflight, not a sandbox or a claim about arbitrary programs.
 * Network/Git mutation is not itself an external filesystem access. */
export async function inspectDraftRunScope(run: DraftRun): Promise<{ externalUris: string[]; uncertain: boolean; reasons: string[] }> {
  const roots = await Promise.all((vscode.workspace.workspaceFolders ?? []).filter(f => f.uri.scheme === 'file')
    .map(f => canonicalPath(f.uri.fsPath)));
  const cwd = vscode.Uri.parse(run.spec.cwdUri).fsPath;
  const external = new Set<string>();
  const check = async (value: string) => {
    const resolved = await canonicalPath(value);
    if (!roots.some(root => inside(root, resolved))) external.add(vscode.Uri.file(resolved).toString());
  };
  await check(cwd);
  const name = path.basename(run.spec.executable).replace(/\.exe$/iu, '').toLowerCase();
  let uncertain = false;
  const reasons: string[] = [];
  const args = [...run.spec.args];
  const knownCommands = new Set(['git', 'npm', 'pnpm', 'yarn', 'bun', 'ls', 'cat', 'head', 'tail', 'rg', 'grep',
    'pwd', 'wc', 'stat', 'file', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'rmdir', 'echo', 'printf', 'curl', 'wget',
    'cd', 'true', 'false', 'tsc', 'eslint', 'prettier', 'vitest', 'jest']);
  const inspectShell = (code: string) => {
    if (/[$`\n(){}]/u.test(code)) uncertain = true;
    for (const command of code.split(/&&|\|\||[;|]/u)) {
      const executable = command.trim().split(/\s/u)[0];
      if (executable && !knownCommands.has(executable)) uncertain = true;
    }
    args.push(...code.split(/\s*(?:&&|\|\||[;|<>])\s*|\s+/u));
  };
  const interpreter = /^(?:ba|z|k|c)?sh$|^(?:cmd|pwsh|powershell|node|python\d*|ruby|perl)$/u.test(name);
  if (interpreter && !args.every(a => ['--version', '-v', '-V'].includes(a))) {
    const inline = args.findIndex(a => ['-c', '-e', '--eval', '-Command', '/c'].includes(a));
    if (inline >= 0) {
      const code = args[inline + 1] ?? '';
      // Simple shell commands can be checked as argv; expansion/eval and
      // general interpreter programs require an explicit operation grant.
      const simpleShell = /sh$/u.test(name) && !/[$`\n(){}]/u.test(code);
      const printOnly = name === 'node' && /^console\.log\((?:'[^']*'|"[^"]*")\);?$/u.test(code.trim());
      if (simpleShell) inspectShell(code);
      else if (!printOnly) uncertain = true;
    } else uncertain = true;
  }
  if (!knownCommands.has(name) && !interpreter) uncertain = true;
  if (['npm', 'pnpm', 'yarn', 'bun'].includes(name)) {
    const scriptIndex = args[0] === 'run' || args[0] === 'run-script' ? 1 : 0;
    const scriptName = args[scriptIndex];
    if (scriptName && !['install', 'ci', 'add', 'remove', 'update', 'publish', '--version', '-v'].includes(scriptName)) {
      try {
        const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
        for (const key of [`pre${scriptName}`, scriptName, `post${scriptName}`]) {
          const command = pkg.scripts?.[key];
          if (typeof command !== 'string') { if (key === scriptName) uncertain = true; continue; }
          inspectShell(command);
        }
      } catch { uncertain = true; }
    }
  }
  if (args.some(arg => /\.(?:sh|py|js|mjs|cjs|ts|rb|pl|ps1)(?:$|["'])/iu.test(arg)) && !args.every(arg => ['--version', '-v', '-V'].includes(arg))) {
    uncertain = true; // contents of arbitrary programs are not a filesystem sandbox
  }
  for (const raw of args) {
    const arg = raw.replace(/^--[\w-]+=/u, '').replace(/^-[Cof](?=\/|\.\.|\.\/|[A-Za-z]:[\\/])/u, '').replace(/^['"]|['"]$/gu, '');
    if (/^(?:https?|ssh|git):\/\/|^[\w.-]+@[^:]+:/u.test(arg)) continue;
    if (/^~|\$|`/u.test(arg)) { uncertain = true; continue; }
    if (arg.startsWith('file:')) { await check(vscode.Uri.parse(arg).fsPath); continue; }
    if (path.isAbsolute(arg) || /^[A-Za-z]:[\\/]/u.test(arg) || arg.startsWith('../') || arg.startsWith('..\\') || arg.startsWith('./') || arg.includes('/') || arg.includes('\\')) {
      await check(path.resolve(cwd, arg));
    } else if (arg && !arg.startsWith('-') && !/\s/u.test(arg)) {
      // Includes plain filenames that have become symlinks since proposal.
      await check(path.resolve(cwd, arg));
    }
  }
  for (const entry of run.spec.env) {
    if (/^(?:HOME|USERPROFILE|TMPDIR|TEMP|GIT_DIR|GIT_WORK_TREE|NODE_OPTIONS|PYTHONPATH|LD_PRELOAD|PATH)$/iu.test(entry.name)) uncertain = true;
  }
  if (uncertain) reasons.push('Command scope cannot be established statically; authorize this exact operation. / 无法静态确定命令范围，请确认这条精确操作。');
  return { externalUris: [...external].sort(), uncertain, reasons };
}
function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return !relative || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
export async function canonicalPath(value: string): Promise<string> {
  const tail: string[] = [];
  let cursor = path.resolve(value);
  for (;;) {
    try { return path.join(await realpath(cursor), ...tail.reverse()); }
    catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      tail.push(path.basename(cursor)); cursor = parent;
    }
  }
}
