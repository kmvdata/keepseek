import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { fileIdentity, installedLaunchPath, type ResolvedExecutable } from './projectLaunchIdentity';

const MANIFEST_LIMIT = 1_048_576;

/** Recognize a single literal command only. Shell pipelines, interpolation,
 * assignments and compound shell syntax remain review context. */
export function parseLiteralLifecycleArgv(value: string): string[] | undefined {
  if (/[\r\n]/u.test(value)) return undefined;
  const argv: string[] = [];
  const word = /(?:"([^"$\\\x60\r\n]*)"|'([^'\r\n]*)'|([^\s"'\\\x60$;&|()<>*?[\]{}!]+))(?=\s|$)/gyu;
  let index = 0;
  while (index < value.length) {
    const whitespace = /^\s+/u.exec(value.slice(index))?.[0];
    if (whitespace) index += whitespace.length;
    if (index === value.length) break;
    word.lastIndex = index;
    const token = word.exec(value);
    if (!token) return undefined;
    argv.push(token[1] ?? token[2] ?? token[3]);
    index = word.lastIndex;
  }
  return argv.length && argv[0] && !argv[0].includes('=') ? argv : undefined;
}

export async function inspectPackageLaunch(
  program: string,
  name: string,
  cwd: string,
  executable: ResolvedExecutable,
  env: NodeJS.ProcessEnv,
  resolve: (executable: string, cwd: string, env: NodeJS.ProcessEnv) => Promise<ResolvedExecutable | undefined>
) {
  // POSIX npm uses an installed npm-cli.js with a Node shebang. Bun can
  // be bound to its native executable. Other managers and Windows shims
  // retain their usual exact-operation review.
  if (process.platform === 'win32' || !['npm', 'bun'].includes(program)) return undefined;
  const info = await stat(executable.path);
  if (fileIdentity(info) !== executable.identity || (info.mode & 0o022) !== 0
    || (info.uid !== 0 && info.uid !== process.getuid?.())) return undefined;
  const runtime = program === 'npm' ? await inspectInstalledNpmRuntime(executable, env, await resolve('node', cwd, env)) : undefined;
  if (program === 'npm' ? !runtime : !executable.trusted || !await installedLaunchPath(executable, env.HOME)) return undefined;
  // These configs can alter script selection or load user content. Probe
  // metadata only. A custom config retains the general command path.
  const configs = program === 'npm'
    ? [path.join(cwd, '.npmrc'), ...(env.HOME ? [path.join(env.HOME, '.npmrc')] : []),
        path.join(path.dirname(path.dirname(runtime!.node.path)), 'etc', 'npmrc'),
        path.join(path.dirname(path.dirname(executable.path)), 'npmrc')]
    : [path.join(cwd, 'bunfig.toml'), ...['.env', '.env.local', '.env.development', '.env.production', '.env.test',
        '.env.development.local', '.env.production.local', '.env.test.local'].map(file => path.join(cwd, file)),
        ...(env.HOME ? [path.join(env.HOME, '.bunfig.toml'), path.join(env.HOME, '.config', '.bunfig.toml')] : [])];
  if ((await Promise.all(configs.map(metadata))).some(Boolean)) return undefined;
  const manifest = path.join(cwd, 'package.json');
  const manifestInfo = await metadata(manifest);
  if (!manifestInfo?.isFile() || manifestInfo.nlink !== 1 || manifestInfo.size > MANIFEST_LIMIT) return undefined;
  const contents = await readBoundFile(manifest, manifestInfo, manifestInfo.size);
  if (!contents) return undefined;
  let scripts: unknown;
  try { scripts = (JSON.parse(contents.toString('utf8').replace(/^\uFEFF/u, '')) as { scripts?: unknown } | null)?.scripts; }
  catch { return undefined; }
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts) || !Object.hasOwn(scripts, name)) return undefined;
  const entries = scripts as Record<string, unknown>;
  if (typeof entries[name] !== 'string' || !(entries[name] as string).trim()) return undefined;
  const lifecycle = ['pre' + name, name, 'post' + name].flatMap(key => {
    const value = Object.hasOwn(entries, key) && entries[key];
    return typeof value === 'string' && value ? [value] : [];
  });
  return { manifest, fileIdentity: fileIdentity(manifestInfo), sizeBytes: manifestInfo.size,
    sha256: createHash('sha256').update(contents).digest('hex'), lifecycle, runtime };
}

export async function inspectInstalledNpmRuntime(
  executable: ResolvedExecutable,
  env: NodeJS.ProcessEnv,
  node: ResolvedExecutable | undefined
) {
  if (!node?.trusted || !await installedLaunchPath(node, env.HOME)
    || (env.PATH ?? '').split(path.delimiter).some(directory => !path.isAbsolute(directory))) return undefined;
  const launcherDir = await realpath(path.dirname(executable.launchPath));
  const installedCli = /^\/(?:usr\/(?:local\/lib\/node_modules|share\/nodejs)|(?:opt\/homebrew|usr\/local)\/Cellar\/node(?:@\d+)?\/[^/]+\/lib\/node_modules)\/npm\/bin\/npm-cli\.js$/u.test(executable.path)
    && ['/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'].includes(launcherDir);
  const adjacentCli = launcherDir === path.dirname(node.path)
    && executable.path === path.resolve(launcherDir, '../lib/node_modules/npm/bin/npm-cli.js');
  if (!installedCli && !adjacentCli) return undefined;
  const info = await stat(executable.path);
  if (fileIdentity(info) !== executable.identity || (info.mode & 0o022) !== 0
    || (info.uid !== 0 && info.uid !== process.getuid?.())) return undefined;
  const header = await readBoundFile(executable.path, info, Math.min(128, info.size));
  if (!header?.toString('utf8').startsWith('#!/usr/bin/env node\n')) return undefined;
  return { node };
}

async function metadata(target: string) {
  return await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
}

async function readBoundFile(target: string, info: NonNullable<Awaited<ReturnType<typeof metadata>>>, bytes: number) {
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const expected = fileIdentity(info);
    if (fileIdentity(await handle.stat()) !== expected) return undefined;
    const buffer = Buffer.alloc(bytes);
    if ((await handle.read(buffer, 0, buffer.length, 0)).bytesRead !== buffer.length
      || fileIdentity(await handle.stat()) !== expected || await realpath(target) !== target
      || fileIdentity(await lstat(target)) !== expected) return undefined;
    return buffer;
  } finally { await handle.close(); }
}
