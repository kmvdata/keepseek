import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { access, mkdtemp, open, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { isPathInside } from '../approvals/authorization/pathScope';
import { isProtectedOperationPath } from '../approvals/authorization/protectedTargets';
import { KEEPSEEK_CONFIGURATION_NAMESPACE } from '../shared/identity';
import { getNativeStoragePath } from '../shared/storageRoot';

const exec = promisify(execFile);
const linuxToolRoots = [
  '/bin', '/sbin', '/lib', '/lib32', '/lib64', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/lib32', '/usr/lib64',
  '/usr/libexec', '/usr/share', '/usr/include', '/usr/local/bin', '/usr/local/sbin', '/usr/local/lib',
  '/usr/local/lib64', '/usr/local/libexec', '/usr/local/share', '/usr/local/include', '/nix/store'
];
const macToolRoots = [
  '/bin', '/sbin', '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/libexec', '/usr/share', '/System/Library',
  '/System/Cryptexes/App', '/System/Cryptexes/OS', '/System/Volumes/Preboot/Cryptexes/App/System',
  '/System/Volumes/Preboot/Cryptexes/OS/System', '/private/var/db/timezone',
  '/Library/Apple/System/Library', '/Library/Developer/CommandLineTools', '/Library/Frameworks/Python.framework',
  '/Applications/Xcode.app/Contents/Developer',
  '/usr/local/bin', '/usr/local/sbin', '/usr/local/lib', '/usr/local/include', '/usr/local/share', '/usr/local/Cellar',
  '/usr/local/opt', '/opt/homebrew/bin', '/opt/homebrew/sbin', '/opt/homebrew/lib', '/opt/homebrew/share',
  '/opt/homebrew/include', '/opt/homebrew/Cellar', '/opt/homebrew/opt'
];
const linuxSystemFiles = ['/etc/ld.so.cache', '/etc/localtime', '/etc/passwd', '/etc/group', '/etc/nsswitch.conf'];
const macSystemFiles = ['/dev/null', '/dev/random', '/dev/urandom', '/private/etc/hosts', '/private/etc/localtime',
  '/private/etc/passwd', '/private/etc/group', '/private/etc/shells', '/private/var/db/xcode_select_link'];
const safeEnvKeys = ['LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'COLORTERM', 'CI', 'NO_COLOR', 'NODE_ENV',
  'PYTHONDONTWRITEBYTECODE'];
const containerRoot = '/keepseek/project';
const dockerHost = 'npipe:////./pipe/dockerDesktopLinuxEngine';
const wrapperProbeTimeoutMs = 5_000;
const dockerRemovalRetryMs = 125;
const dockerRemovalWaitMs = 3_000;

export type ProjectExecutionMode = 'isolated' | 'host';

interface ProjectExecutionIdentity {
  root: string;
  cwd: string;
  /** Exact host spelling, including a venv or workspace symlink when applicable. */
  executable: string;
  fingerprint: string;
}

export type ProjectExecutionBoundary = ProjectExecutionIdentity & (
  | { kind: 'host' }
  | PosixExecutionBoundary
  | { kind: 'container'; wrapper: string; image: string; containerCommand: string; containerCommandOverride?: string }
);

interface PosixExecutionBoundary {
  kind: 'seatbelt' | 'bubblewrap';
  wrapper: string;
  toolRoots: readonly string[];
  executableRealPath: string;
}

type PosixBoundary = ProjectExecutionIdentity & PosixExecutionBoundary;

export interface PreparedProjectExecution {
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  extraFds?: readonly number[];
  cleanup?: () => Promise<void>;
}

export class ProjectExecutionUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProjectExecutionUnavailableError';
  }
}

function globalSetting(name: string): unknown {
  return vscode.workspace.getConfiguration(KEEPSEEK_CONFIGURATION_NAMESPACE).inspect?.(name)?.globalValue;
}

export function getProjectExecutionMode(): ProjectExecutionMode {
  return globalSetting('projectExecution') === 'host' ? 'host' : 'isolated';
}

export function isProjectExecutionEnvNameSupported(name: string): boolean {
  return safeEnvKeys.includes(name);
}

function identity(info: Stats): readonly number[] {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs];
}

function binding(...values: unknown[]): string {
  return createHash('sha256').update(JSON.stringify([2, ...values])).digest('hex');
}

function isUsablePath(value: string): boolean {
  return path.isAbsolute(value) && Array.from(value).every(character => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
}

function isVolumeRoot(value: string): boolean {
  return path.parse(value).root === value
    || (process.platform === 'linux' && /^\/mnt\/[A-Za-z]$/u.test(value))
    || (process.platform === 'darwin' && (value.toLowerCase() === '/volumes' || path.dirname(value).toLowerCase() === '/volumes'));
}

function isProtectedProjectRoot(value: string, home: string, temporary: string): boolean {
  value = protectionPath(value);
  home = protectionPath(home);
  temporary = protectionPath(temporary);
  if (isVolumeRoot(value) || isPathInside(value, home) || [temporary, '/tmp', '/private/tmp'].includes(value)
    || isProtectedOperationPath(value, true)) return true;
  const related = (protectedPath: string) => isPathInside(value, protectedPath) || isPathInside(protectedPath, value);
  if (process.platform === 'darwin') {
    return ['/applications', '/private/etc', '/private/var/db', '/private/var/root', '/opt/homebrew',
      path.join(home, 'library', 'launchagents')].some(related);
  }
  if (process.platform === 'linux') {
    return ['/etc', '/boot', '/run', '/nix/store', path.join(home, '.config', 'autostart')].some(related);
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    return Boolean(appData && isUsablePath(appData)
      && related(protectionPath(path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup'))));
  }
  return false;
}

function protectionPath(value: string): string {
  // macOS realpath preserves caller casing on a case-insensitive volume.
  return process.platform === 'darwin' || process.platform === 'win32' ? value.normalize('NFC').toLowerCase() : value;
}

const ready = new Map<string, Promise<void>>();

async function checkWrapper(key: string, check: () => Promise<void>): Promise<void> {
  let pending = ready.get(key);
  if (!pending) {
    if (ready.size >= 8) ready.clear();
    pending = check();
    ready.set(key, pending);
  }
  try { await pending; }
  catch (error) {
    if (ready.get(key) === pending) ready.delete(key);
    throw error;
  }
}

async function findWrapper(candidates: readonly string[]): Promise<{ file: string; info: Stats } | undefined> {
  for (const candidate of candidates) {
    try {
      const file = await realpath(candidate);
      const info = await stat(file);
      await access(file, constants.X_OK);
      if (info.isFile() && (process.platform === 'win32' || info.uid === 0 && !(info.mode & 0o022))) return { file, info };
    } catch {
      // Missing or untrusted installations are unavailable, never PATH fallbacks.
    }
  }
  return undefined;
}

function toolRootsFor(executable: string, root: string, home = homedir()): string[] {
  const roots = process.platform === 'darwin' ? macToolRoots : linuxToolRoots;
  const relative = path.relative(home, executable).replace(/\\/gu, '/');
  const installed = /^(\.nvm\/versions\/node\/[^/]+|\.pyenv\/versions\/[^/]+|\.bun\/bin|(?:miniconda3|anaconda3|miniforge3)\/bin)\//u.exec(relative)?.[1];
  const installationRoot = installed?.endsWith('/bin') && installed !== '.bun/bin' ? path.dirname(installed) : installed;
  return [...roots, ...(installationRoot ? [path.join(home, installationRoot)] : [])]
    .filter(candidate => !isPathInside(root, candidate));
}

export async function inspectProjectExecution(root: string, cwd: string, executable: string,
  options: { containerCommand?: string } = {}): Promise<ProjectExecutionBoundary> {
  if (!isUsablePath(root) || !isUsablePath(cwd)) throw new ProjectExecutionUnavailableError(
    'Project execution requires local absolute paths. / 工程执行需要本地绝对路径。');
  const [projectRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(cwd)]);
  const [rootInfo, cwdInfo] = await Promise.all([stat(projectRoot), stat(canonicalCwd)]);
  const storagePath = getNativeStoragePath();
  const [storage, home, temporary] = await Promise.all([
    realpath(storagePath).catch(() => storagePath),
    realpath(homedir()).catch(() => homedir()),
    realpath(tmpdir()).catch(() => tmpdir())
  ]);
  const protectedRoot = protectionPath(projectRoot);
  const protectedStorage = protectionPath(storage);
  if (!rootInfo.isDirectory() || !cwdInfo.isDirectory() || !isPathInside(projectRoot, canonicalCwd)
    || isProtectedProjectRoot(projectRoot, home, temporary)
    || isPathInside(protectedRoot, protectedStorage) || isPathInside(protectedStorage, protectedRoot)) {
    throw new ProjectExecutionUnavailableError('Project execution requires a verified project directory. / 工程执行需要已核实的工程目录。');
  }
  const location = [projectRoot, rootInfo.dev, rootInfo.ino, canonicalCwd, cwdInfo.dev, cwdInfo.ino];
  const base = { root: projectRoot, cwd: canonicalCwd, executable };
  if (getProjectExecutionMode() === 'host') {
    const executableRealPath = isUsablePath(executable) ? await realpath(executable) : '';
    if (!executableRealPath) throw new ProjectExecutionUnavailableError('Host execution needs an exact executable. / 宿主执行需要确切的启动器。');
    return { ...base, kind: 'host', fingerprint: binding('host', location, executable, executableRealPath,
      identity(await stat(executableRealPath))) };
  }

  if (process.platform === 'win32') return await inspectContainer(base, location, options.containerCommand);
  if (!isUsablePath(executable)) throw new ProjectExecutionUnavailableError(
    'Isolated execution needs an exact executable. / 隔离执行需要确切的启动器。');
  const executableRealPath = await realpath(executable);
  const executableInfo = await stat(executableRealPath);
  if (!executableInfo.isFile()) throw new ProjectExecutionUnavailableError('Invalid execution entry. / 执行入口无效。');
  const toolRoots = toolRootsFor(executableRealPath, projectRoot, home);
  const kind = process.platform === 'darwin' ? 'seatbelt' : process.platform === 'linux' ? 'bubblewrap' : undefined;
  const wrapper = await findWrapper(kind === 'seatbelt' ? ['/usr/bin/sandbox-exec']
    : kind === 'bubblewrap' ? ['/usr/bin/bwrap', '/bin/bwrap'] : []);
  if (!kind || !wrapper) throw new ProjectExecutionUnavailableError(
    'The platform isolation backend is unavailable. / 当前平台的工程隔离后端不可用。');
  if (kind === 'bubblewrap') {
    if (!['x64', 'arm64'].includes(process.arch)) throw new ProjectExecutionUnavailableError(
      'Linux socket isolation is unavailable on this architecture. / 此 Linux 架构不支持套接字隔离。');
    await assertNoNestedMounts([projectRoot, ...toolRoots]);
  }
  const wrapperKey = binding(kind, wrapper.file, identity(wrapper.info));
  await checkWrapper(wrapperKey, () => probePosixBoundary(kind, wrapper.file));
  return { ...base, kind, wrapper: wrapper.file, toolRoots, executableRealPath,
    fingerprint: binding(wrapperKey, location, executable, executableRealPath, identity(executableInfo), toolRoots) };
}

function containerPath(root: string, value: string): string {
  return path.posix.join(containerRoot, path.relative(root, value).split(path.sep).join('/'));
}

function dockerEnvironment(config: string): NodeJS.ProcessEnv {
  const { SystemRoot, WINDIR } = process.env;
  return { SystemRoot, WINDIR, DOCKER_CONFIG: config };
}

async function inspectContainer(base: Omit<ProjectExecutionIdentity, 'fingerprint'>, location: unknown,
  override?: string): Promise<ProjectExecutionBoundary> {
  const image = globalSetting('projectExecutionContainerImage');
  if (typeof image !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(image)) throw new ProjectExecutionUnavailableError(
    'Configure an installed Docker Desktop Linux image by immutable sha256 ID. / 请配置 Docker Desktop 中已安装的 Linux 镜像 sha256 ID。');
  if (!/^[A-Za-z]:[\\/]/u.test(base.root) || /[",]/u.test(base.root)) throw new ProjectExecutionUnavailableError(
    'Docker isolation requires a local drive path without a comma or quote. / Docker 隔离需要不含逗号或引号的本地盘符路径。');
  const programFiles = process.env.ProgramFiles;
  const wrapper = await findWrapper(programFiles ? [path.join(programFiles, 'Docker', 'Docker', 'resources', 'bin', 'docker.exe')] : []);
  if (!wrapper || !programFiles || !isPathInside(await realpath(programFiles), wrapper.file)) throw new ProjectExecutionUnavailableError(
    'Docker Desktop could not be verified. / 无法核实 Docker Desktop。');
  const projectExecutable = isUsablePath(base.executable) && isPathInside(base.root, base.executable);
  const resolvedEntry = projectExecutable ? await realpath(base.executable) : undefined;
  if (resolvedEntry && !isPathInside(base.root, resolvedEntry)) throw new ProjectExecutionUnavailableError(
    'The project entry resolves outside the mounted project. / 工程入口解析到挂载工程之外。');
  const entryIdentity = resolvedEntry ? identity(await stat(resolvedEntry)) : undefined;
  const command = override ?? (projectExecutable ? containerPath(base.root, base.executable)
    : path.basename(base.executable).replace(/\.(?:exe|cmd|bat)$/iu, ''));
  if (command.includes('=') || ((!projectExecutable || override) && !/^[A-Za-z0-9][A-Za-z0-9_.+-]*$/u.test(command))) {
    throw new ProjectExecutionUnavailableError('The container command could not be bound. / 无法绑定容器执行命令。');
  }
  const wrapperKey = binding('container', wrapper.file, identity(wrapper.info), image);
  await checkWrapper(wrapperKey, async () => {
    const config = await mkdtemp(path.join(tmpdir(), 'keepseek-docker-'));
    try {
      const result = await exec(wrapper.file, ['--host', dockerHost, 'image', 'inspect', '--format', '{{.Id}} {{.Os}}', image], {
        env: dockerEnvironment(config), timeout: wrapperProbeTimeoutMs, windowsHide: true, maxBuffer: 4_096
      });
      if (result.stdout.trim() !== `${image} linux`) throw new Error('Image identity or platform differs.');
    } catch { throw new ProjectExecutionUnavailableError(
      'The pinned Linux image is unavailable on the local Docker Desktop engine. / 本机 Docker Desktop 引擎中没有指定的 Linux 镜像。'); }
    finally { await rm(config, { recursive: true, force: true }); }
  });
  return { ...base, kind: 'container', wrapper: wrapper.file, image, containerCommand: command, containerCommandOverride: override,
    fingerprint: binding(wrapperKey, location, base.executable, command, resolvedEntry, entryIdentity) };
}

function isolatedEnvironment(env: NodeJS.ProcessEnv, temporary: string, toolRoots: readonly string[],
  launcherBin?: string): NodeJS.ProcessEnv {
  const locale = Object.fromEntries(safeEnvKeys.filter(key => env[key] !== undefined).map(key => [key, env[key]]));
  const searchPath = new Set([...(launcherBin ? [launcherBin] : []), ...toolRoots.filter(root => /\/(?:s?bin)$/u.test(root))]);
  return { ...locale, PATH: [...searchPath].join(':'), HOME: temporary, TMPDIR: temporary, TMP: temporary, TEMP: temporary,
    XDG_CACHE_HOME: temporary, XDG_CONFIG_HOME: temporary, XDG_DATA_HOME: temporary, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' };
}

function posixEnvironment(boundary: PosixBoundary, env: NodeJS.ProcessEnv, temporary: string): NodeJS.ProcessEnv {
  const launcherDir = path.dirname(boundary.executable);
  const venv = isPathInside(boundary.root, launcherDir) && /\/\.venv\/bin$/u.test(launcherDir);
  const installed = /\/bin$/u.test(launcherDir) && boundary.toolRoots.some(root => isPathInside(root, launcherDir));
  return isolatedEnvironment(env, temporary, boundary.toolRoots, venv || installed ? launcherDir : undefined);
}

function seatbeltArgs(boundary: PosixBoundary,
  temporary: string, args: readonly string[]): string[] {
  const writableRoots = [boundary.root, temporary];
  const readableRoots = [...writableRoots, ...boundary.toolRoots];
  const readableFiles = [...macSystemFiles, boundary.executableRealPath, boundary.executable];
  const ancestors = new Set<string>();
  for (const candidate of [...readableRoots, ...readableFiles]) {
    let parent = path.dirname(candidate);
    while (!ancestors.has(parent)) {
      ancestors.add(parent);
      parent = path.dirname(parent);
    }
  }
  const predicates = (scope: 'subpath' | 'literal', locations: Iterable<string>) => Array.from(locations,
    location => `(${scope} ${JSON.stringify(location)})`).join(' ');
  const readable = `${predicates('subpath', readableRoots)} ${predicates('literal', readableFiles)}`;
  const profile = [
    '(version 1)', '(deny default)', '(allow process-fork)', '(allow signal (target same-sandbox))',
    '(allow process-info* (target same-sandbox))', '(allow sysctl-read)', '(allow ipc-posix-sem)',
    '(allow mach-lookup (global-name "com.apple.system.opendirectoryd.libinfo"))',
    `(allow file-read-metadata ${predicates('literal', ancestors)})`,
    `(allow file-read* file-map-executable process-exec ${readable})`,
    '(deny process-exec (literal "/usr/bin/open") (literal "/usr/bin/osascript") (literal "/bin/launchctl"))',
    `(allow file-write* ${predicates('subpath', writableRoots)})`,
    '(allow file-write-data (require-all (literal "/dev/null") (vnode-type CHARACTER-DEVICE)))',
    '(deny file-write-setugid file-write-mount file-write-unmount)'
  ].join('\n');
  return ['-p', profile, boundary.executable, ...args];
}

function bubblewrapArgs(boundary: PosixBoundary,
  args: readonly string[]): string[] {
  const readonlyMounts = [...boundary.toolRoots, ...linuxSystemFiles, boundary.executableRealPath, boundary.executable]
    .filter(value => !isPathInside(boundary.root, value));
  return ['--unshare-all', '--unshare-user', '--disable-userns', '--die-with-parent', '--new-session', '--cap-drop', 'ALL', '--seccomp', '3',
    '--proc', '/proc', '--dev', '/dev',
    '--tmpfs', '/tmp', ...[...new Set(readonlyMounts)].flatMap(p => ['--ro-bind-try', p, p]),
    '--bind', boundary.root, boundary.root, '--chdir', boundary.cwd, '--', boundary.executable, ...args];
}

async function assertNoNestedMounts(roots: readonly string[]): Promise<void> {
  const table = await readFile('/proc/self/mountinfo', 'utf8');
  for (const line of table.split('\n')) {
    const mountedAt = line.split(' ')[4]?.replace(/\\([0-7]{3})/gu, (_, value: string) => String.fromCharCode(parseInt(value, 8)));
    if (mountedAt && roots.some(root => root !== mountedAt && isPathInside(root, mountedAt))) {
      throw new ProjectExecutionUnavailableError('A project or toolchain has nested host mounts. / 工程或工具链包含宿主嵌套挂载。');
    }
  }
}

function linuxSocketFilter(): Buffer {
  // A mount namespace hides host paths but a socket under a shared project
  // bind can still reach a host service. Deny creation of sockets and io_uring
  // while keeping socketpair available for subprocess IPC.
  const x64 = process.arch === 'x64';
  const architecture = x64 ? 0xc000003e : 0xc00000b7;
  const socket = x64 ? 41 : 198;
  const load = 0x20, equal = 0x15, atLeast = 0x35, result = 0x06;
  const kill = 0x80000000, allow = 0x7fff0000, operationNotPermitted = 0x00050001;
  const instructions = [
    [load, 0, 0, 4], [equal, 1, 0, architecture], [result, 0, 0, kill],
    [load, 0, 0, 0], [atLeast, 2, 0, 0x40000000], [equal, 1, 0, socket], [equal, 0, 1, 425],
    [result, 0, 0, operationNotPermitted], [result, 0, 0, allow]
  ];
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([op, yes, no, value], index) => {
    const offset = index * 8;
    bytes.writeUInt16LE(op, offset);
    bytes.writeUInt8(yes, offset + 2);
    bytes.writeUInt8(no, offset + 3);
    bytes.writeUInt32LE(value, offset + 4);
  });
  return bytes;
}

async function prepareBubblewrap(boundary: PosixBoundary,
  args: readonly string[], env: NodeJS.ProcessEnv): Promise<PreparedProjectExecution> {
  const temporary = await mkdtemp(path.join(tmpdir(), 'keepseek-seccomp-'));
  const file = path.join(temporary, 'filter');
  try {
    await writeFile(file, linuxSocketFilter(), { mode: 0o600, flag: 'wx' });
    const handle = await open(file, 'r');
    return { executable: boundary.wrapper, args: bubblewrapArgs(boundary, args), cwd: boundary.cwd,
      env: posixEnvironment(boundary, env, '/tmp'), extraFds: [handle.fd],
      cleanup: async () => {
        try { await handle.close(); }
        finally { await rm(temporary, { recursive: true, force: true }); }
      } };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

async function prepareSeatbelt(boundary: PosixBoundary, args: readonly string[],
  env: NodeJS.ProcessEnv): Promise<PreparedProjectExecution> {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'keepseek-execution-')));
  return { executable: boundary.wrapper, args: seatbeltArgs(boundary, temporary, args), cwd: boundary.cwd,
    env: posixEnvironment(boundary, env, temporary), cleanup: () => rm(temporary, { recursive: true, force: true }) };
}

async function probePosixBoundary(kind: PosixExecutionBoundary['kind'], wrapper: string): Promise<void> {
  const project = await realpath(await mkdtemp(path.join(tmpdir(), 'keepseek-isolation-probe-')));
  let launch: PreparedProjectExecution | undefined;
  try {
    const executable = '/usr/bin/true';
    const executableRealPath = await realpath(executable);
    const boundary = { kind, wrapper, executable, executableRealPath, root: project, cwd: project,
      toolRoots: toolRootsFor(executableRealPath, project), fingerprint: '' };
    launch = kind === 'seatbelt' ? await prepareSeatbelt(boundary, [], {}) : await prepareBubblewrap(boundary, [], {});
    await runPosixProbe(launch);
  } catch {
    throw new ProjectExecutionUnavailableError(kind === 'seatbelt'
      ? 'macOS Seatbelt could not create an isolated process. / macOS Seatbelt 无法创建隔离进程。'
      : 'Bubblewrap could not create an isolated process. / Bubblewrap 无法创建隔离进程。');
  } finally {
    try { await launch?.cleanup?.(); }
    finally { await rm(project, { recursive: true, force: true }); }
  }
}

async function runPosixProbe(launch: PreparedProjectExecution): Promise<void> {
  return await new Promise((resolve, reject) => {
    const child = spawn(launch.executable, launch.args, {
      cwd: launch.cwd, env: launch.env, shell: false, timeout: wrapperProbeTimeoutMs, killSignal: 'SIGKILL',
      stdio: ['ignore', 'ignore', 'ignore', ...(launch.extraFds ?? [])]
    });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error('The isolation probe failed.')));
  });
}

async function prepareContainer(boundary: Extract<ProjectExecutionBoundary, { kind: 'container' }>, args: readonly string[],
  env: NodeJS.ProcessEnv, timeoutMs: number, signal?: AbortSignal): Promise<PreparedProjectExecution> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > Number.MAX_SAFE_INTEGER) {
    throw new ProjectExecutionUnavailableError('The container needs a finite execution deadline. / 容器执行需要有限的截止时间。');
  }
  const name = `keepseek-${randomUUID()}`;
  const config = await mkdtemp(path.join(tmpdir(), 'keepseek-docker-'));
  const dockerEnv = dockerEnvironment(config);
  const commandEnv = {
    ...isolatedEnvironment(env, '/tmp', ['/usr/local/bin', '/usr/bin', '/bin']),
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: containerRoot
  };
  const fixed = { env: dockerEnv, timeout: 10_000, windowsHide: true, maxBuffer: 4_096 };
  let container = name;
  let removal: Promise<void> | undefined;
  const removeContainer = async () => {
    const deadline = Date.now() + dockerRemovalWaitMs;
    for (;;) {
      try {
        await exec(boundary.wrapper, ['--host', dockerHost, 'container', 'rm', '--force', container], fixed);
        return;
      } catch (error) {
        const stderr = (error as { stderr?: string }).stderr ?? '';
        if (/No such container/iu.test(stderr)) return;
        // The daemon may already be auto-removing the container after exit.
        if (!/removal of container .* is already in progress/iu.test(stderr) || Date.now() >= deadline) {
          throw new ProjectExecutionUnavailableError('The isolated container could not be removed. / 无法清理隔离容器。');
        }
        await delay(dockerRemovalRetryMs);
      }
    }
  };
  const cleanup = () => removal ??= removeContainer().finally(() => rm(config, { recursive: true, force: true }));
  try {
    const result = await exec(boundary.wrapper, ['--host', dockerHost, 'container', 'create', '--pull=never', '--rm',
      '--name', name, '--network=none', '--ipc=none', '--cgroupns=private', '--init', '--read-only', '--cap-drop=ALL', '--log-driver=none',
      '--security-opt=no-new-privileges', '--pids-limit=512', '--user=1000:1000', '--no-healthcheck', '--stop-timeout=1',
      '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777,size=512m',
      '--mount', `type=bind,source=${boundary.root},target=${containerRoot},bind-recursive=disabled`,
      '--workdir', containerPath(boundary.root, boundary.cwd), '--entrypoint=/usr/bin/env', boundary.image, '-i', '--',
      ...Object.entries(commandEnv).map(([key, value]) => `${key}=${value}`),
      '/usr/bin/timeout', '--signal=TERM', '--kill-after=2s', '--', `${(Math.ceil(timeoutMs) / 1000).toFixed(3)}s`,
      boundary.containerCommand, ...args
    ], fixed);
    if (!/^[a-f0-9]{64}$/u.test(result.stdout.trim())) throw new Error('Docker returned no exact container identity.');
    container = result.stdout.trim();
    signal?.throwIfAborted();
  } catch (error) {
    await cleanup();
    if (signal?.aborted) throw error;
    throw new ProjectExecutionUnavailableError('Docker could not prepare the isolated process. / Docker 无法准备隔离进程。');
  }
  return { executable: boundary.wrapper, args: ['--host', dockerHost, 'container', 'start', '--attach', container],
    cwd: boundary.cwd, env: dockerEnv, cleanup };
}

/** Revalidate the reviewed environment before constructing the exact literal launch. */
export async function prepareProjectExecution(boundary: ProjectExecutionBoundary, executable: string, args: readonly string[],
  env: NodeJS.ProcessEnv, signal?: AbortSignal, timeoutMs = 120_000): Promise<PreparedProjectExecution> {
  signal?.throwIfAborted();
  if ((boundary.kind === 'host') !== (getProjectExecutionMode() === 'host')) throw new ProjectExecutionUnavailableError(
    'The reviewed execution mode changed. / 已审批的执行模式发生变化。');
  const live = await inspectProjectExecution(boundary.root, boundary.cwd, executable,
    { containerCommand: boundary.kind === 'container' ? boundary.containerCommandOverride : undefined });
  if (live.fingerprint !== boundary.fingerprint || live.executable !== boundary.executable) throw new ProjectExecutionUnavailableError(
    'The reviewed execution environment changed. / 已审批的执行环境发生变化。');
  signal?.throwIfAborted();
  if (live.kind === 'host') return { executable, args, cwd: live.cwd, env };
  if (live.kind === 'container') {
    const launch = await prepareContainer(live, args, env, timeoutMs, signal);
    try {
      const after = await inspectProjectExecution(live.root, live.cwd, executable, { containerCommand: live.containerCommandOverride });
      if (after.fingerprint !== live.fingerprint) throw new ProjectExecutionUnavailableError(
        'The reviewed container mount or runtime changed. / 已审批的容器挂载或运行时发生变化。');
      signal?.throwIfAborted();
      return launch;
    } catch (error) {
      await launch.cleanup?.();
      throw error;
    }
  }
  return live.kind === 'bubblewrap' ? await prepareBubblewrap(live, args, env) : await prepareSeatbelt(live, args, env);
}
