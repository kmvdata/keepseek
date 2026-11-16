// Cross-platform child process helpers for the local packaging scripts.
//
// Windows: Node (>=18.20.2/20.12.2/21.7.3, CVE-2024-27980) and Bun refuse to
// spawn .cmd/.bat shims without a shell and throw EINVAL instead, while
// `shell: true` would join argv without quoting. Route those shims through
// cmd.exe with explicit per-argument quoting so argv stays exact.
//
// macOS and Linux: npm and the `code` CLI are ordinary executables (or
// shebang scripts), so argv is passed through untouched and no shell is ever
// involved.

const path = require('node:path');
const { spawnSync: defaultSpawnSync } = require('node:child_process');

const WINDOWS_SHIM = /\.(?:cmd|bat)$/iu;
const CMD_SPECIAL = /[\s"^&|<>()]/u;
const UNC_PATH = /^[\\/]{2}[^\\/]/u;

function quoteForCmd(value) {
  const text = String(value);
  if (text === '') return '""';
  return CMD_SPECIAL.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function isUncPath(value) {
  return typeof value === 'string' && UNC_PATH.test(value);
}

function buildCommandLine(command, args) {
  return [command, ...args].map(quoteForCmd).join(' ');
}

// `platform` and `commandShell` are injectable so the dispatch rules can be
// exercised on any host OS; production callers use the real defaults.
function createChildRunner(options = {}) {
  const isWindows = (options.platform ?? process.platform) === 'win32';
  const commandShell = options.commandShell ?? process.env.ComSpec ?? 'cmd.exe';
  // Injectable so dispatch can be asserted without launching a process.
  const spawnSync = options.spawnSync ?? defaultSpawnSync;

  // Resolve where a command would be dispatched without spawning anything, so
  // tests can assert the Windows rules while running on macOS or Linux.
  function plan(command, args) {
    if (!isWindows || !WINDOWS_SHIM.test(command)) {
      return { executable: command, argv: [...args], viaCommandShell: false };
    }
    // `cmd /s /c` strips the outer quotes, so each literal inner quote must be
    // doubled for cmd to hand the argument through intact.
    // Node and Bun pass the command line as one argv element without applying
    // cmd.exe's outer-quote stripping, so an extra wrapper would arrive escaped
    // and become part of the program name.
    return {
      executable: commandShell,
      argv: ['/d', '/s', '/c', buildCommandLine(command, args)],
      viaCommandShell: true
    };
  }

  function spawn(command, args, spawnOptions = {}) {
    const target = plan(command, args);
    if (target.viaCommandShell && isUncPath(spawnOptions.cwd)) {
      // cmd.exe cannot start in a UNC directory, so enter it via pushd, which
      // maps the share to a temporary drive for the life of the command.
      const cwd = String(spawnOptions.cwd);
      const { cwd: _ignored, ...rest } = spawnOptions;
      // A compound line is never quote-stripped by `cmd /s /c`, so the shim text
      // is rebuilt without the doubling a simple command needs. `pushd` also
      // takes the UNC path unquoted, since a quoted share is rejected.
      const line = `pushd ${cwd} && ${buildCommandLine(command, args)} && popd`;
      return spawnSync(target.executable, ['/d', '/s', '/c', line], rest);
    }
    return spawnSync(target.executable, target.argv, spawnOptions);
  }

  function run(command, args, spawnOptions = {}) {
    return spawn(command, args, { stdio: 'inherit', ...spawnOptions });
  }

  function runCapture(command, args, spawnOptions = {}) {
    return spawn(command, args, { encoding: 'utf8', ...spawnOptions });
  }

  // These scripts may be started by Bun, but npm-installed toolchains (.bin
  // shims, native modules) expect a real Node binary.
  function nodeExecutable() {
    if (!process.versions.bun) return process.execPath;
    const probe = runCapture('node', ['--version']);
    return !probe.error && probe.status === 0 ? 'node' : process.execPath;
  }

  return { isWindows, commandShell, plan, run, runCapture, nodeExecutable };
}

const defaultRunner = createChildRunner();

module.exports = {
  buildCommandLine,
  createChildRunner,
  nodeExecutable: defaultRunner.nodeExecutable,
  quoteForCmd,
  run: defaultRunner.run,
  runCapture: defaultRunner.runCapture
};