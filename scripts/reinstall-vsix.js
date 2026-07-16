#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const codeCommand = process.env.CODE_BIN || (process.platform === 'win32' ? 'code.cmd' : 'code');

main();

function main() {
  const beforePackage = readPackageJson();
  const extensionId = getExtensionId(beforePackage);

  step(`Packaging ${extensionId}...`);
  run(npmCommand, ['run', 'package']);

  const packageJson = readPackageJson();
  const version = readRequiredString(packageJson.version, 'version');
  const vsixPath = path.join(root, `${packageJson.name}-${version}.vsix`);
  if (!fs.existsSync(vsixPath)) {
    fail(`Expected VSIX was not created: ${path.relative(root, vsixPath)}`);
  }

  step(`Uninstalling ${extensionId} from VS Code...`);
  runOptional(codeCommand, ['--uninstall-extension', extensionId]);

  step(`Installing ${path.basename(vsixPath)}...`);
  run(codeCommand, ['--install-extension', vsixPath, '--force']);

  step(`Done. Installed ${extensionId}@${version}. Reload VS Code if the old extension host is still active.`);
}

function readPackageJson() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
}

function getExtensionId(packageJson) {
  const publisher = readRequiredString(packageJson.publisher, 'publisher');
  const name = readRequiredString(packageJson.name, 'name');
  return `${publisher}.${name}`;
}

function readRequiredString(value, fieldName) {
  if (typeof value !== 'string' || !value.trim()) {
    fail(`package.json is missing a valid ${fieldName}.`);
  }
  return value.trim();
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit'
  });

  if (result.error) {
    fail(`Failed to run ${formatCommand(command, args)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function runOptional(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8'
  });

  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.error) {
    fail(`Failed to run ${formatCommand(command, args)}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    console.warn(`Warning: ${formatCommand(command, args)} exited with ${result.status}. Continuing with install.`);
  }
}

function step(message) {
  console.log(`\n==> ${message}`);
}

function formatCommand(command, args) {
  return [command, ...args].join(' ');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
