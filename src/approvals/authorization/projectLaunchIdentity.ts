import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { isPathInside } from './pathScope';
import { isNodeProgram, isPythonProgram } from './projectLaunchArguments';

export interface ResolvedExecutable {
  path: string;
  launchPath: string;
  identity: string;
  trusted: boolean;
}

export function fileIdentity(info: Stats): string {
  return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
}

/** Stream the on-disk entry without retaining source text or following a
 * replacement link. Identity is checked before and after the read. */
export async function hashRegularFile(target: string, expected: Stats): Promise<string> {
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = await handle.stat();
    const identity = fileIdentity(expected);
    if (!before.isFile() || fileIdentity(before) !== identity) throw launchChanged();
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (fileIdentity(await handle.stat()) !== identity || await realpath(target) !== target
      || fileIdentity(await lstat(target)) !== identity) throw launchChanged();
    return hash.digest('hex');
  } finally { await handle.close(); }
}

export async function isNativeExecutable(target: string, info: Stats): Promise<boolean> {
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const header = Buffer.alloc(4);
    if (fileIdentity(await handle.stat()) !== fileIdentity(info)
      || (await handle.read(header, 0, header.length, 0)).bytesRead !== header.length) return false;
    if (process.platform === 'win32') return header[0] === 0x4d && header[1] === 0x5a;
    if (process.platform === 'linux') return header.readUInt32BE() === 0x7f454c46;
    if (process.platform === 'darwin') return [0xcffaedfe, 0xfeedfacf, 0xcefaedfe, 0xfeedface,
      0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(header.readUInt32BE());
    return false;
  } finally { await handle.close(); }
}

export function installedInterpreter(name: string, resolved: string, home: string | undefined,
  system: boolean, rootOwned: boolean, hostRuntime: boolean): boolean {
  const basename = path.basename(resolved).replace(/\.exe$/iu, '');
  if (isNodeProgram(name) && isNodeProgram(basename)) {
    if (process.platform === 'win32') return hostRuntime || /^[a-z]:\\Program Files(?: \(x86\))?\\nodejs\\node\.exe$/iu.test(resolved);
    return hostRuntime || system || rootOwned && /^\/usr\/local\/bin\/node(?:js|\d{1,2})?$/u.test(resolved)
      || /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/node(?:@\d+)?\/[^/]+\/bin\/node$/u.test(resolved)
      || Boolean(home && path.isAbsolute(home) && isPathInside(path.join(home, '.nvm', 'versions', 'node'), resolved)
        && /^v\d+\.\d+\.\d+[/\\]bin[/\\]node$/u.test(path.relative(path.join(home, '.nvm', 'versions', 'node'), resolved)));
  }
  if (!isPythonProgram(name) || !isPythonProgram(basename)) return false;
  if (process.platform === 'win32') return /^[a-z]:\\Program Files(?: \(x86\))?\\Python\d+(?:\.\d+)*\\python(?:\d+(?:\.\d+)*)?\.exe$/iu.test(resolved)
    || Boolean(home && path.isAbsolute(home) && /^Python\d+\\python\.exe$/iu.test(
      path.relative(path.join(home, 'AppData', 'Local', 'Programs', 'Python'), resolved)));
  // On macOS /usr/bin/python3 is the developer-tools selector. Bind a
  // concrete installed Python instead of trusting its dynamic selection.
  if (system) return !(process.platform === 'darwin' && resolved === '/usr/bin/python3');
  if (rootOwned && /^\/usr\/local\/bin\/python(?:[23](?:\.\d{1,2})?)?$/u.test(resolved)) return true;
  if (process.platform === 'darwin' && /^(?:\/(?:opt\/homebrew|usr\/local)\/Cellar\/python(?:@\d+(?:\.\d+)*)?\/[^/]+\/(?:Frameworks\/Python\.framework\/Versions\/[^/]+\/)?|\/Library\/Frameworks\/Python\.framework\/Versions\/[^/]+\/)bin\/python\d+(?:\.\d+)*$/u.test(resolved)) return true;
  return Boolean(home && path.isAbsolute(home) && ['miniconda3', 'anaconda3', 'miniforge3'].some(distribution =>
    path.dirname(resolved) === path.join(home, distribution, 'bin')));
}

export function installedBunPath(resolved: string, home: string, system: boolean, rootOwned: boolean): boolean {
  if (process.platform === 'win32') return resolved === path.join(home, '.bun', 'bin', 'bun.exe')
    || /^[a-z]:\\Program Files\\bun\\bun\.exe$/iu.test(resolved);
  return system && path.basename(resolved) === 'bun' || rootOwned && resolved === '/usr/local/bin/bun'
    || /^\/(?:opt\/homebrew|usr\/local)\/Cellar\/bun\/[^/]+\/bin\/bun$/u.test(resolved)
    || resolved === path.join(home, '.bun', 'bin', 'bun');
}

/** A named PATH shim must not gain installed-interpreter authority just by
 * resolving to a binary. Keep legitimate installation and OS aliases. */
export async function installedLaunchPath(launcher: ResolvedExecutable, home: string | undefined,
  directory?: string): Promise<boolean> {
  directory ??= await realpath(path.dirname(launcher.launchPath));
  if (directory === path.dirname(launcher.path)) return true;
  if (process.platform === 'win32') return false;
  if (['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].includes(directory)) return true;
  return process.platform === 'darwin' && (directory.startsWith('/Library/Frameworks/Python.framework/Versions/')
    || /^\/(?:opt\/homebrew|usr\/local)\/(?:Cellar|opt)\/(?:python|node)/u.test(directory))
    || Boolean(home && path.isAbsolute(home) && ['miniconda3', 'anaconda3', 'miniforge3'].some(distribution =>
      directory === path.join(home, distribution, 'bin')));
}

/** A direct project executable may be native or a script with an exact,
 * verified shebang. A wrapper or unbound interpreter does not qualify. */
export async function inspectProjectExecutable(
  launcher: ResolvedExecutable,
  cwd: string,
  env: NodeJS.ProcessEnv,
  resolve: (executable: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<ResolvedExecutable | undefined>
): Promise<{ interpreter?: ResolvedExecutable } | undefined> {
  const info = await stat(launcher.path);
  if (info.nlink !== 1 || fileIdentity(info) !== launcher.identity) return undefined;
  if (await isNativeExecutable(launcher.path, info)) return {};
  if (process.platform === 'win32') return undefined;
  const handle = await open(launcher.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const header = Buffer.alloc(256);
  try {
    if (fileIdentity(await handle.stat()) !== launcher.identity) return undefined;
    await handle.read(header, 0, header.length, 0);
    if (fileIdentity(await handle.stat()) !== launcher.identity) return undefined;
  } finally { await handle.close(); }
  const line = header.toString('utf8').split('\n', 1)[0];
  const match = /^#![ \t]*(\/[^ \t\0]+)(?:[ \t]+([^ \t\0]+))?[ \t]*$/u.exec(line);
  if (!match) return undefined;
  let executable = match[1];
  if (executable === '/usr/bin/env') {
    if (!match[2] || (!isNodeProgram(match[2]) && !isPythonProgram(match[2]))) return undefined;
    executable = match[2];
  } else if (match[2]) return undefined;
  let interpreter = await resolve(executable, cwd, env);
  if (interpreter && !interpreter.trusted && ['/bin/sh', '/usr/bin/sh'].includes(executable)
    && /^\/(?:usr\/)?bin\/(?:sh|dash|bash)$/u.test(interpreter.path)) {
    // The system's sh alias is meaningful to the shell. Bind its actual
    // binary while preserving the path the kernel uses from the shebang.
    const actual = await resolve(interpreter.path, cwd, env);
    if (actual?.trusted) interpreter = { ...interpreter, trusted: true };
  }
  return interpreter?.trusted && await installedLaunchPath(interpreter, env.HOME) ? { interpreter } : undefined;
}

export async function inspectPythonVenv(
  launcher: ResolvedExecutable,
  projectRoot: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  resolve: (executable: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<ResolvedExecutable | undefined>
): Promise<{ config: string; fingerprint: unknown[] } | undefined> {
  const windows = process.platform === 'win32';
  const suppliedDir = path.dirname(path.resolve(launcher.launchPath));
  const launcherDir = await realpath(suppliedDir);
  if (path.basename(suppliedDir).toLowerCase() !== (windows ? 'scripts' : 'bin')
    || path.basename(launcherDir).toLowerCase() !== (windows ? 'scripts' : 'bin')) return undefined;
  const venv = path.dirname(launcherDir);
  if (path.basename(venv).toLowerCase() !== '.venv' || !isPathInside(projectRoot, venv)) return undefined;
  if (await realpath(path.dirname(suppliedDir)) !== venv) return undefined;
  const config = path.join(venv, 'pyvenv.cfg');
  const configInfo = await lstat(config).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!configInfo?.isFile() || configInfo.nlink !== 1 || configInfo.size > 16_384) return undefined;
  const file = await open(config, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  let contents: string;
  try {
    if (fileIdentity(await file.stat()) !== fileIdentity(configInfo)) throw launchChanged();
    const bytes = Buffer.alloc(configInfo.size);
    if ((await file.read(bytes, 0, bytes.length, 0)).bytesRead !== bytes.length
      || fileIdentity(await file.stat()) !== fileIdentity(configInfo)
      || await realpath(config) !== config || fileIdentity(await lstat(config)) !== fileIdentity(configInfo)) throw launchChanged();
    contents = bytes.toString('utf8');
  } finally { await file.close(); }
  const homes = [...contents.matchAll(/^home\s*=[\t ]*(.+?)\s*$/gimu)];
  const home = homes[0]?.[1];
  if (homes.length !== 1 || !home || !path.isAbsolute(home) || /[\r\n\0]/u.test(home)) return undefined;
  const candidates = new Set([path.basename(launcher.launchPath), path.basename(launcher.path), windows ? 'python.exe' : 'python3']);
  let base: ResolvedExecutable | undefined;
  for (const filename of candidates) {
    const candidate = await resolve(path.join(home, filename), cwd, env);
    if (candidate?.trusted && !isPathInside(projectRoot, candidate.path)
      && await installedLaunchPath(candidate, env.HOME ?? env.USERPROFILE)) { base = candidate; break; }
  }
  if (!base) return undefined;
  if (launcher.path !== base.path) {
    // A copy-mode venv or Windows redirector is accepted only if it matches
    // the installed interpreter or its distributed venv launcher byte for byte.
    const info = await stat(launcher.path);
    if (!isPathInside(venv, launcher.path) || info.nlink !== 1 || info.size > 32 * 1024 * 1024
      || !await isNativeExecutable(launcher.path, info)) return undefined;
    const expected = [base.path, ...(windows ? ['python.exe', 'venvlauncher.exe'].map(name =>
      path.join(path.dirname(base.path), 'Lib', 'venv', 'scripts', 'nt', name)) : [])];
    const digest = await hashRegularFile(launcher.path, info);
    let matches = false;
    for (const file of expected) {
      const installed = await lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (installed?.isFile() && installed.size === info.size && await hashRegularFile(file, installed) === digest) {
        matches = true;
        break;
      }
    }
    if (!matches) return undefined;
  }
  return { config, fingerprint: [fileIdentity(configInfo), createHash('sha256').update(contents).digest('hex'), base] };
}

function launchChanged(): Error {
  return new Error('Command launch files changed while being verified. Nothing executed. / 启动文件在核验期间已改变，尚未执行。');
}
