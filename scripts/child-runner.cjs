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
//
// UNC workspaces: cmd.exe refuses a UNC working directory, warns "UNC paths are
// not supported" and then runs from C:\Windows, where npm finds neither
// package.json nor node_modules/.bin. Every command from a UNC cwd therefore
// enters the share with pushd first, which maps it to a drive for the life of
// that cmd instance.

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

// Quotes for a line that `cmd /s /c` will not strip. Unlike quoteForCmd, a
// literal `"` stays single: doubling is only needed when cmd removes the
// outermost pair of a simple command.
function quoteForPlainLine(value) {
  const text = String(value);
  if (text === '') return '""';
  return CMD_SPECIAL.test(text) ? `"${text}"` : text;
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
    if (!isUncPath(spawnOptions.cwd)) {
      return spawnSync(target.executable, target.argv, spawnOptions);
    }
    // cmd.exe cannot start in a UNC directory and would silently fall back to
    // C:\Windows, where npm finds neither package.json nor node_modules/.bin.
    // Enter the share with pushd and run the command on the drive cmd maps for
    // it; pushd takes the share unquoted, and the mapping dies with this
    // instance, so entering the share has to be the same line. A plain
    // executable needs cmd.exe here only to hold that mapping.
    // The line names the original command rather than the planned one: a .cmd
    // target is already planned as `cmd.exe /d /s /c <line>`, and nesting that
    // would pass the wrapper on as the program name.
    const { cwd, ...rest } = spawnOptions;
    const line = `pushd ${String(cwd)} && ${[command, ...args].map(quoteForPlainLine).join(' ')}`;
    // Start cmd.exe outside the share: a UNC working directory makes it warn
    // and fall back to C:\Windows before pushd runs, and a local start also
    // keeps cmd from inheriting the share as its launch directory.
    const localCwd = options.uncFallbackCwd ?? process.env.SystemRoot ?? process.env.windir ?? 'C:';
    return spawnSync(commandShell, ['/d', '/s', '/c', line], { ...rest, cwd: localCwd });
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