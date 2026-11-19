#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { nodeExecutable, run: runChild } = require('./child-runner.cjs');

const root = path.resolve(__dirname, '..');
const packageJson = require(path.join(root, 'package.json'));
const vsixName = `${packageJson.name}-${packageJson.version}.vsix`;
const vsixPath = path.join(root, vsixName);

main();

function main() {
  const dependencies = Object.keys(packageJson.dependencies || {});

  if (dependencies.length === 0) {
    step('No runtime dependencies declared in package.json.');
  } else {
    step(`Checking runtime dependencies are installed: ${dependencies.join(', ')}`);
    for (const dependency of dependencies) {
      assertDependencyInstalled(dependency);
    }
  }

  step('Cleaning out/ so no stale build output can leak into the VSIX');
  removeBuildOutput(path.join(root, 'out'));

  step('Compiling TypeScript sources');
  runCompile();

  step(`Packaging ${vsixName} with runtime dependencies (never --no-dependencies)`);
  const vsce = vsceCommand();
  run(vsce.executable, [...vsce.args, 'package', '--dependencies', '--out', vsixName]);

  step(`Verifying ${vsixName} contents`);
  run(nodeCommand(), [path.join(root, 'scripts', 'verify-vsix.js'), vsixName]);

  const size = fs.statSync(vsixPath).size;
  console.log('');
  console.log(`Market package ready: ${vsixPath}`);
  console.log(`Size: ${formatBytes(size)}`);
  console.log('Upload this file to the marketplace, then confirm it contains extension/node_modules/ignore/.');
}

// A network share can report ENOTEMPTY or EBUSY while another handle is still
// closing, even though nothing is reading the directory. fs.rmSync would then
// abort the whole package, so a stale-looking clean is retried and verified
// instead of trusted.
function removeBuildOutput(target) {
  const transient = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (error) {
      if (!transient.has(error?.code) || attempt === 5) throw error;
    }
    if (!fs.existsSync(target)) return;
    if (attempt < 5) sleep(150 * attempt);
  }
  // Never package stale output: a directory that survives the retries is fatal.
  fail(`Could not remove ${target}. Close anything using out/ and retry.`);
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function assertDependencyInstalled(dependencyName) {
  const dependencyPackageJson = path.join(root, 'node_modules', dependencyName, 'package.json');
  if (!fs.existsSync(dependencyPackageJson)) {
    fail(`Runtime dependency "${dependencyName}" is not installed. Run "npm install" (or "bun install") first.`);
  }
}

// vsce is started through its entry script rather than a node_modules/.bin
// shim: bun writes .exe launchers and npm writes .cmd ones, but a checkout
// installed by a non-Windows tool only has POSIX symlinks, and .cmd/.bat files
// cannot be spawned directly on Windows (CVE-2024-27980). Running the entry
// script with the Node binary works for every installer.
function vsceCommand() {
  const entry = path.join(root, 'node_modules', 'vsce', 'out', 'main.js');
  if (!fs.existsSync(entry)) {
    fail('vsce is not installed. Run "npm install" (or "bun install") first.');
  }
  return { executable: nodeCommand(), args: [entry] };
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

// cmd.exe runs the command line of a UNC workspace as a compound line, where a
// quoted program path that contains spaces cannot be passed reliably. `node`
// resolves from PATH instead, so the absolute path never has to be quoted.
function nodeCommand() {
  return process.platform === 'win32' ? 'node' : nodeExecutable();
}

// tsc creates its output directories as it emits. On a network share that
// mkdir can fail with ENOENT/ENOTEMPTY while the server settles, which aborts
// the whole run even though a retry succeeds. Only those transient codes are
// retried, and a real type error still fails on the first attempt.
function runCompile() {
  const transient = /error TS5033|ENOENT|ENOTEMPTY|EBUSY/u;
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = runCaptured(npmCommand(), ['run', 'compile']);
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.status === 0) return;
    if (!transient.test(`${result.stdout ?? ''}${result.stderr ?? ''}`) || attempt === attempts) {
      process.exit(result.status || 1);
    }
    step(`Retrying the compile (attempt ${attempt + 1}/${attempts}) after a transient output error`);
    sleep(250 * attempt);
  }
}

function runCaptured(command, args) {
  const result = runChild(command, args, { cwd: root, encoding: 'utf8' });
  if (result.error) {
    fail(`Failed to run ${formatCommand(command, args)}: ${result.error.message}`);
  }
  return result;
}

function run(command, args) {
  // Windows .cmd shims (npm.cmd, vsce.cmd) cannot be spawned directly by Node
  // or Bun; child-runner routes them through cmd.exe with exact argv quoting.
  const result = runChild(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) {
    fail(`Failed to run ${formatCommand(command, args)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function formatBytes(value) {
  return `${(value / 1024).toFixed(1)} KB`;
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function step(message) {
  console.log(`\n==> ${message}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
