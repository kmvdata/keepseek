#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  fs.rmSync(path.join(root, 'out'), { recursive: true, force: true });

  step('Compiling TypeScript sources');
  run(npmCommand(), ['run', 'compile']);

  step(`Packaging ${vsixName} with runtime dependencies (never --no-dependencies)`);
  run(vsceBin(), ['package', '--dependencies', '--out', vsixName]);

  step(`Verifying ${vsixName} contents`);
  run(process.execPath, [path.join(root, 'scripts', 'verify-vsix.js'), vsixName]);

  const size = fs.statSync(vsixPath).size;
  console.log('');
  console.log(`Market package ready: ${vsixPath}`);
  console.log(`Size: ${formatBytes(size)}`);
  console.log('Upload this file to the marketplace, then confirm it contains extension/node_modules/ignore/.');
}

function assertDependencyInstalled(dependencyName) {
  const dependencyPackageJson = path.join(root, 'node_modules', dependencyName, 'package.json');
  if (!fs.existsSync(dependencyPackageJson)) {
    fail(`Runtime dependency "${dependencyName}" is not installed. Run "npm install" (or "bun install") first.`);
  }
}

function vsceBin() {
  const binName = process.platform === 'win32' ? 'vsce.cmd' : 'vsce';
  const binPath = path.join(root, 'node_modules', '.bin', binName);
  if (!fs.existsSync(binPath)) {
    fail('vsce is not installed. Run "npm install" (or "bun install") first.');
  }
  return binPath;
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
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
