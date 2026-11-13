import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import * as vscode from 'vscode';
import { discoverCodexPlugins, refreshCodexPluginInstallation } from '../src/skills/codexPluginDiscovery';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-codex-plugins-')));
  roots.push(root);
  const home = path.join(root, 'codex');
  const cache = path.join(home, 'plugins/cache');
  await mkdir(cache, { recursive: true });
  Object.assign(vscode.workspace, { isTrusted: true });
  const write = async (file: string, contents: string | object) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  };
  const bundle = async (market: string, name: string, version: string, options: {
    slot?: string; remoteId?: string; manifest?: object; badHash?: boolean;
  } = {}) => {
    const plugin = path.join(cache, market, name);
    const packageRoot = path.join(plugin, options.slot ?? version);
    const manifest = JSON.stringify(options.manifest ?? { name, version, skills: './skills/' });
    await write(path.join(packageRoot, '.codex-plugin/plugin.json'), manifest);
    await write(path.join(packageRoot, 'skills/entry/SKILL.md'), '# Fixture');
    if (options.remoteId) {
      await write(path.join(plugin, '.codex-remote-plugin-install.json'), { schema_version: 1, remote_plugin_id: options.remoteId });
      await write(path.join(packageRoot, 'integrity.json'), { schema_version: 1, hash_algorithm: 'sha256', files: [
        { path: '.codex-plugin/plugin.json', sha256: options.badHash ? '0'.repeat(64) : createHash('sha256').update(manifest).digest('hex') }
      ] });
    }
    return packageRoot;
  };
  const userConfig = (contents: string) => write(path.join(home, 'config.toml'), contents);
  const discover = () => discoverCodexPlugins(vscode.Uri.file(home));
  return { root, home, cache, write, bundle, userConfig, discover };
}

test('local market evidence selects the exact version and leaves a higher stale cache unused', async () => {
  const f = await fixture();
  const source = path.join(f.root, 'market');
  await f.write(path.join(source, '.agents/plugins/marketplace.json'), { name: 'fixtures', plugins: [
    { name: 'sample', source: { source: 'local', path: './plugins/sample' } }
  ] });
  await f.write(path.join(source, 'plugins/sample/.codex-plugin/plugin.json'), { name: 'sample', version: '1.2.0' });
  await f.userConfig(`[marketplaces.fixtures]\nsource_type = "local"\nsource = ${JSON.stringify(source)}\n[plugins."sample@fixtures"]\nenabled = true\n`);
  const selected = await f.bundle('fixtures', 'sample', '1.2.0');
  await f.bundle('fixtures', 'sample', '9.9.9');
  await f.bundle('fixtures', 'stray', '1.2.0');
  const { plugins, diagnostics } = await f.discover();
  assert.deepEqual(plugins.map(plugin => [plugin.id, plugin.version, plugin.source, plugin.realRootPath]),
    [['sample@fixtures', '1.2.0', 'local', selected]]);
  assert.match(diagnostics.join('\n'), /Ignored other cached versions/u);
  assert.match(diagnostics.join('\n'), /stray@fixtures: No supported installation/u);
});

test('the explicit user local slot remains stable across version changes and is subject to project disables', async () => {
  const f = await fixture();
  await f.bundle('personal', 'sample', '1.0.0', { slot: 'local' });
  await f.bundle('personal', 'sample', '99.0.0');
  await f.userConfig('[plugins."sample@personal"]\nenabled = true\n');
  const [first] = (await f.discover()).plugins;
  assert.equal(first.version, '1.0.0');
  await f.bundle('personal', 'sample', '1.1.0', { slot: 'local' });
  const [updated] = (await f.discover()).plugins;
  assert.equal(updated.id, first.id);
  assert.notEqual(updated.installationHash, first.installationHash);
  assert.equal((await refreshCodexPluginInstallation(vscode.Uri.file(f.home), first))?.installationHash, updated.installationHash);
  const work = path.join(f.root, 'work');
  await f.write(path.join(work, '.codex/config.toml'), '[plugins."sample@personal"]\nenabled = false\n');
  const dir = vscode.Uri.file(work);
  const blocked = await discoverCodexPlugins(vscode.Uri.file(f.home), { cwd: dir, root: dir, chain: [dir], trusted: true });
  assert.deepEqual(blocked.plugins, []);
  assert.match(blocked.diagnostics.join('\n'), /Disabled by Codex/u);
  assert.equal(await refreshCodexPluginInstallation(vscode.Uri.file(f.home), first, { cwd: dir, root: dir, chain: [dir], trusted: true }), undefined);
});

test('a remote ID-only record needs one verified bundle and respects disablement, ambiguity, and removal', async () => {
  const f = await fixture();
  await f.bundle('remote', 'visual', '2.0.0', { remoteId: 'Plugin_fixture' });
  await f.bundle('remote', 'damaged', '2.0.0', { remoteId: 'Plugin_damaged', badHash: true });
  const noIntegrity = await f.bundle('remote', 'no-integrity', '2.0.0', { remoteId: 'Plugin_no_integrity' });
  await rm(path.join(noIntegrity, 'integrity.json'));
  await f.bundle('remote', 'unmarked', '2.0.0');
  let result = await f.discover();
  assert.deepEqual(result.plugins.map(plugin => [plugin.id, plugin.version, plugin.source]),
    [['visual@remote#Plugin_fixture', '2.0.0', 'remote']]);
  assert.match(result.diagnostics.join('\n'), /damaged@remote: Remote plugin manifest integrity mismatch/u);
  assert.match(result.diagnostics.join('\n'), /no-integrity@remote: Remote bundle integrity record unavailable/u);
  assert.match(result.diagnostics.join('\n'), /unmarked@remote: No supported installation/u);
  const old = await f.bundle('remote', 'visual', '1.0.0');
  result = await f.discover();
  assert.deepEqual(result.plugins, []);
  assert.match(result.diagnostics.join('\n'), /version is missing or ambiguous/u);
  await rm(old, { recursive: true });
  await f.userConfig('[plugins."visual@remote"]\nenabled = false\n');
  result = await f.discover();
  assert.deepEqual(result.plugins, []);
  assert.match(result.diagnostics.join('\n'), /visual@remote: Disabled by Codex/u);
  await f.userConfig('');
  await rm(path.join(f.cache, 'remote/visual/.codex-remote-plugin-install.json'));
  assert.deepEqual((await f.discover()).plugins, []);
});

test('a malformed package or symlink does not hide valid packages in the same marketplace', async () => {
  const f = await fixture();
  const valid = await f.bundle('personal', 'valid', '1.0.0', { slot: 'local' });
  await f.bundle('personal', 'escape', '1.0.0', { slot: 'local', manifest: { name: 'escape', skills: './../skills' } });
  await f.write(path.join(f.cache, 'personal/broken/local/.codex-plugin/plugin.json'), 'invalid json');
  await mkdir(path.join(f.cache, 'personal/link'), { recursive: true });
  await symlink(valid, path.join(f.cache, 'personal/link/local'), 'junction');
  await f.userConfig(['valid', 'escape', 'broken', 'link'].map(name => `[plugins."${name}@personal"]\nenabled = true\n`).join('\n'));
  const { plugins, diagnostics } = await f.discover();
  assert.deepEqual(plugins.map(plugin => plugin.name), ['valid']);
  for (const name of ['broken', 'escape', 'link']) assert.ok(diagnostics.some(line => line.startsWith(`${name}@personal:`)));
  Object.assign(vscode.workspace, { isTrusted: false });
  assert.match((await f.discover()).diagnostics.join('\n'), /trusted workspace/u);
  Object.assign(vscode.workspace, { isTrusted: true });
});
