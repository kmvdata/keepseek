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
    argv: ['/d', '/s', '/c', '"npm.cmd run package:market"'],
    viaCommandShell: true
  });
  assert.deepEqual(runner.plan('code.cmd', ['--install-extension', 'D:\\a b\\keepseek-0.5.3.vsix']), {
    executable: 'cmd.exe',
    argv: ['/d', '/s', '/c', '"code.cmd --install-extension ""D:\\a b\\keepseek-0.5.3.vsix"""'],
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

test('runCapture executes a node script through nodeExecutable', () => {
  const result = runCapture(nodeExecutable(), ['-e', 'process.stdout.write("keepseek")']);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'keepseek');
});