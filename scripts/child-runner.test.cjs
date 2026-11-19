const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCommandLine,
  createChildRunner,
  nodeExecutable,
  quoteForCmd,
  runCapture
} = require('./child-runner.cjs');

test('quoteForCmd only quotes tokens cmd.exe would split or expand', () => {
  assert.equal(quoteForCmd('run'), 'run');
  assert.equal(quoteForCmd('keep seek.vsix'), '"keep seek.vsix"');
  assert.equal(quoteForCmd('a&b'), '"a&b"');
  assert.equal(quoteForCmd(''), '""');
});

test('buildCommandLine keeps argv exact for .cmd shims', () => {
  assert.equal(buildCommandLine('npm.cmd', ['run', 'package:market']), 'npm.cmd run package:market');
  assert.equal(
    buildCommandLine('code.cmd', ['--install-extension', 'D:\\a b\\keepseek-0.5.3.vsix', '--force']),
    'code.cmd --install-extension "D:\\a b\\keepseek-0.5.3.vsix" --force'
  );
});

test('Windows dispatch wraps .cmd shims in cmd.exe and runs binaries directly', () => {
  const runner = createChildRunner({ platform: 'win32', commandShell: 'cmd.exe' });
  assert.equal(runner.isWindows, true);

  assert.deepEqual(runner.plan('npm.cmd', ['run', 'package:market']), {
    executable: 'cmd.exe',
    argv: ['/d', '/s', '/c', 'npm.cmd run package:market'],
    viaCommandShell: true
  });
  assert.deepEqual(runner.plan('code.cmd', ['--install-extension', 'D:\\a b\\keepseek-0.5.3.vsix']), {
    executable: 'cmd.exe',
    argv: ['/d', '/s', '/c', 'code.cmd --install-extension "D:\\a b\\keepseek-0.5.3.vsix"'],
    viaCommandShell: true
  });
  assert.deepEqual(runner.plan('C:\\Program Files\\nodejs\\node.exe', ['scripts/verify-vsix.js']), {
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    argv: ['scripts/verify-vsix.js'],
    viaCommandShell: false
  });
});

test('macOS and Linux dispatch never uses a shell', () => {
  for (const platform of ['darwin', 'linux']) {
    const runner = createChildRunner({ platform });
    assert.equal(runner.isWindows, false);

    assert.deepEqual(runner.plan('npm', ['run', 'compile']), {
      executable: 'npm',
      argv: ['run', 'compile'],
      viaCommandShell: false
    });
    assert.deepEqual(runner.plan('code', ['--install-extension', '/tmp/a b/keepseek-0.5.3.vsix', '--force']), {
      executable: 'code',
      argv: ['--install-extension', '/tmp/a b/keepseek-0.5.3.vsix', '--force'],
      viaCommandShell: false
    });
    // A Windows-style name must not smuggle cmd.exe onto macOS or Linux.
    assert.equal(runner.plan('npm.cmd', ['run', 'compile']).viaCommandShell, false);
  }
});

test('a UNC working directory enters the share through pushd', () => {
  const calls = [];
  const runner = createChildRunner({
    platform: 'win32',
    commandShell: 'cmd.exe',
    uncFallbackCwd: 'C:\\Windows',
    spawnSync: (command, argv, options) => {
      calls.push({ command, argv, options });
      return { status: 0 };
    }
  });

  // A quoted share is rejected by pushd, so the share is entered unquoted.
  // The .cmd target stays a plain command in the line: plan() would already
  // wrap it in cmd.exe, and nesting that would pass the wrapper as a name.
  runner.run('npm.cmd', ['run', 'compile', 'D:\\a b\\x.vsix'], { cwd: '\\\\server\\share\\repo' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'cmd.exe');
  assert.deepEqual(calls[0].argv, ['/d', '/s', '/c',
    'pushd \\\\server\\share\\repo && npm.cmd run compile "D:\\a b\\x.vsix"']);
  // cmd.exe refuses a UNC working directory, so it starts outside the share
  // and pushd maps it instead.
  assert.equal(calls[0].options.cwd, 'C:\\Windows');
  assert.equal(calls[0].options.stdio, 'inherit');
});

test('a plain executable from a UNC working directory still enters the share', () => {
  const calls = [];
  const runner = createChildRunner({
    platform: 'win32',
    commandShell: 'cmd.exe',
    uncFallbackCwd: 'C:\\Windows',
    spawnSync: (command, argv, options) => {
      calls.push({ command, argv, options });
      return { status: 0 };
    }
  });

  // cmd.exe falls back to C:\Windows for a UNC cwd, so even a program that
  // would run without a shell must be started after pushd maps the share.
  const result = runner.runCapture('C:\\Program Files\\nodejs\\node.exe', ['scripts/verify-vsix.js'], {
    cwd: '\\\\server\\share\\repo'
  });

  assert.equal(result.status, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'cmd.exe');
  assert.deepEqual(calls[0].argv, ['/d', '/s', '/c',
    'pushd \\\\server\\share\\repo && "C:\\Program Files\\nodejs\\node.exe" scripts/verify-vsix.js']);
  assert.equal(calls[0].options.cwd, 'C:\\Windows');
  assert.equal(calls[0].options.encoding, 'utf8');
});

test('a local working directory spawns the planned shim unchanged', () => {
  const calls = [];
  const runner = createChildRunner({
    platform: 'win32',
    commandShell: 'cmd.exe',
    spawnSync: (command, argv, options) => {
    calls.push({ command, argv, options });
      return { status: 0 };
    }
  });

  runner.run('npm.cmd', ['run', 'compile'], { cwd: 'K:\\keepseek' });

  assert.deepEqual(calls[0].argv, ['/d', '/s', '/c', 'npm.cmd run compile']);
  assert.equal(calls[0].options.cwd, 'K:\\keepseek');
});

test('runCapture executes a node script through nodeExecutable', () => {
  const result = runCapture(nodeExecutable(), ['-e', 'process.stdout.write("keepseek")']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'keepseek');
});