#!/usr/bin/env node
// Packages the already-compiled out/ into a VSIX without invoking npm.
//
// `vsce package` always runs the vscode:prepublish script through `npm`, and
// every npm path that shells out inherits a current directory. On a UNC checkout
// cmd.exe refuses that directory, npm falls back to C:\Windows and reads the
// wrong package.json, so `vsce package` exits non-zero while the previous VSIX
// stays on disk. A later "package ready" message then points at stale code,
// which is how an old binary kept being reinstalled.
//
// This entry point calls vsce's programmatic `pack()` instead:
//   - no prepublish/npm spawn, so it works on any checkout location;
//   - dependency discovery mirrors vsce's npm path, which lists the project
//     root plus every production dependency directory and globs each one with
//     `ignore: node_modules/**`. That glob is why `dependencies: 'none'` must
//     not be used: it globs only the root, dependency files never become
//     candidates, and no `!node_modules/...` rule in .vscodeignore can add them
//     back. The result was a VSIX with no runtime dependencies at all.
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

/** The same directory list vsce's npm path obtains from `npm list --parseable`. */
function dependencyDirectories(cwd, manifest) {
  const directories = [cwd];
  for (const name of Object.keys(manifest.dependencies || {})) {
    const directory = path.join(cwd, 'node_modules', name);
    if (!fs.existsSync(path.join(directory, 'package.json'))) {
      throw new Error(`Runtime dependency "${name}" is not installed. Run "npm install" (or "bun install") first.`);
    }
    directories.push(directory);
  }
  return directories;
}

async function main() {
  const manifest = require(path.join(root, 'package.json'));
  const vsix = `${manifest.name}-${manifest.version}.vsix`;
  const vsixPath = path.join(root, vsix);
  // A stale package must never be mistaken for this run's output.
  fs.rmSync(vsixPath, { force: true });

  const npm = require(path.join(root, 'node_modules', 'vsce', 'out', 'npm.js'));
  const { pack } = require(path.join(root, 'node_modules', 'vsce', 'out', 'package.js'));
  npm.getDependencies = async (cwd) => dependencyDirectories(cwd, manifest);

  const result = await pack({ cwd: root, packagePath: vsix });
  if (!result || !fs.existsSync(vsixPath)) throw new Error('vsce produced no package');
  if (!fs.statSync(vsixPath).size) throw new Error('vsce produced an empty package');
  const hasEntry = result.files.some(file => file.path === 'extension/out/extension.js');
  const dependencies = result.files.filter(file => file.path.includes('node_modules/')).length;
  if (!hasEntry) throw new Error('the package is missing out/extension.js');
  if (!dependencies) throw new Error('the package contains no runtime dependencies');
  console.log(vsixPath);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
