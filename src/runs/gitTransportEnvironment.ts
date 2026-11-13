import { lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { GitRemoteCommand } from '../approvals/authorization/commandSemantics';

export interface GitTransportEnvironmentInput {
  env: NodeJS.ProcessEnv;
  gitRemote: GitRemoteCommand;
  args: readonly string[];
  gitObjectDirectory?: string;
  gitObjectIdentity?: string;
}

export async function inspectGitObjectDirectory(repository: string): Promise<{ directory: string; identity: string }> {
  const metadata = path.join(repository, '.git');
  const directory = path.join(metadata, 'objects');
  const [metadataInfo, objectInfo] = await Promise.all([lstat(metadata), lstat(directory)]);
  if (!metadataInfo.isDirectory() || !objectInfo.isDirectory() || await realpath(directory) !== directory
    || /[\r\n\0]/u.test(directory)) throw new Error('Git source object storage is unverified. / Git 来源对象存储尚未核验。');
  const redirected = () => new Error('Git source object storage is redirected. / Git 来源对象存储已重定向。');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw redirected();
    if (!/^(?:[a-f0-9]{2}|info|pack)$/u.test(entry.name)) continue;
    if (!entry.isDirectory()) throw redirected();
    const storage = path.join(directory, entry.name);
    for (const object of await readdir(storage, { withFileTypes: true })) {
      if (entry.name === 'info' && ['alternates', 'http-alternates'].includes(object.name)) throw redirected();
      if (object.isFile()) continue;
      const indexDirectory = entry.name === 'info' && object.name === 'commit-graphs'
        || entry.name === 'pack' && object.name === 'multi-pack-index.d';
      if (!indexDirectory || !object.isDirectory() || (await readdir(path.join(storage, object.name), { withFileTypes: true }))
        .some(index => !index.isFile())) throw redirected();
    }
  }
  return { directory, identity: JSON.stringify([metadataInfo.dev, metadataInfo.ino, objectInfo.dev, objectInfo.ino]) };
}

/** Use private, minimal Git metadata. A repository configuration, hook,
 * template or credential helper must never be loaded with transport credentials. */
export async function prepareGitTransportEnvironment(input: GitTransportEnvironmentInput): Promise<{
  cwd: string; env: NodeJS.ProcessEnv; dispose: () => Promise<void>;
}> {
  const isPush = input.gitRemote.kind === 'push';
  let objectDirectory: string | undefined;
  let objectFormat: 'sha1' | 'sha256' = 'sha1';
  if (isPush) {
    const repository = input.gitObjectDirectory && path.dirname(path.dirname(input.gitObjectDirectory));
    const objects = repository && await inspectGitObjectDirectory(repository);
    if (!objects || objects.directory !== input.gitObjectDirectory || objects.identity !== input.gitObjectIdentity) {
      throw new Error('Git source object storage changed before transport. / 传输前 Git 来源对象存储已变化。');
    }
    objectDirectory = objects.directory;
    const refs = input.gitRemote.refs;
    const sources = input.args.slice(-refs.length);
    const isSource = (length: number) => sources.length === refs.length && refs.length > 0
      && sources.every((source, index) => source.slice(length) === ':' + refs[index]
        && source.slice(0, length).length === length && /^[a-f0-9]+$/u.test(source.slice(0, length)));
    if (isSource(64)) objectFormat = 'sha256';
    else if (!isSource(40)) throw new Error('Git transport requires exact source object IDs. / Git 传输需要精确的来源对象 ID。');
  }

  const cwd = await mkdtemp(path.join(os.tmpdir(), 'keepseek-git-transport-'));
  const dispose = () => rm(cwd, { recursive: true, force: true });
  try {
    await Promise.all([mkdir(path.join(cwd, 'refs')), mkdir(path.join(cwd, 'objects', 'info'), { recursive: true }),
      writeFile(path.join(cwd, 'HEAD'), 'ref: refs/heads/keepseek-transport\n'),
      writeFile(path.join(cwd, 'config'), objectFormat === 'sha256'
        ? '[core]\nrepositoryformatversion = 1\nbare = true\n[extensions]\nobjectformat = sha256\n'
        : '[core]\nrepositoryformatversion = 0\nbare = true\n')]);
    if (objectDirectory) await writeFile(path.join(cwd, 'objects', 'info', 'alternates'),
      objectDirectory.split(path.sep).join('/') + '\n');
    return { cwd, env: { ...input.env, GIT_DIR: cwd, GIT_CONFIG_GLOBAL: path.join(cwd, 'empty-global-config') }, dispose };
  } catch (error) {
    await dispose();
    throw error;
  }
}
