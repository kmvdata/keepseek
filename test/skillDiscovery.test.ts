import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import * as vscode from 'vscode';
import { SkillDiscovery } from '../src/skills/skillDiscovery';
import { SkillLoader } from '../src/skills/skillLoader';
import { parseSkillFrontmatter, parseSkillMetadata } from '../src/skills/skillMetadata';
import { loadSharedCodexConfig } from '../src/context/sharedCodexConfig';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const markdown = (name = 'review') => `---\nname: ${name}\ndescription: |\n  Review: changes\n  检查证据\n---\nRead the diff.\n`;
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-shared-skills-'))); roots.push(root);
  const repo = path.join(root, 'project'); const home = path.join(root, 'codex'); const user = path.join(root, 'user/.agents/skills');
  await mkdir(repo); await mkdir(home); await mkdir(user, { recursive: true });
  const folder = { uri: vscode.Uri.file(repo), name: 'project', index: 0 };
  Object.assign(vscode.workspace, { workspaceFolders: [folder], isTrusted: true });
  const config = await loadSharedCodexConfig({ folders: [folder], codexHome: vscode.Uri.file(home), trusted: true });
  const discovery = new SkillDiscovery({ userSkillsUri: vscode.Uri.file(user), includeAdminSkills: false });
  const put = async (name: string, body = markdown(), base = path.join(repo, '.agents/skills')) => {
    const dir = path.join(base, name); await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, 'SKILL.md'), body); return dir;
  };
  return { root, repo, home, user, folder, config, discovery, put };
}
test('standard roots only: no arbitrary .agents, AGENTS.md skill, or old CODEX_HOME skills', async () => {
  const f = await fixture(); await f.put('shared'); await f.put('old', markdown(), path.join(f.repo, '.agents'));
  await f.put('deprecated', markdown(), path.join(f.home, 'skills'));
  const agents = path.join(f.repo, '.agents/skills/agents-only'); await mkdir(agents); await writeFile(path.join(agents, 'AGENTS.md'), markdown());
  const manifests = await f.discovery.discover(f.config);
  assert.equal(manifests.length, 1); assert.equal(manifests[0].enabled, true); assert.equal(manifests[0].allowImplicit, true);
  assert.match(manifests[0].description, /Review: changes\n检查证据/u);
});
test('concurrent discovery snapshots own their manifests and diagnostics while legacy discover remains compatible', async () => {
  const f = await fixture(); await f.put('project', markdown('project'));
  await symlink(f.root, path.join(f.repo, '.agents/skills/escape'));
  const untrusted = await loadSharedCodexConfig({ folders: [f.folder], codexHome: vscode.Uri.file(f.home), trusted: false });
  const [trustedResult, untrustedResult] = await Promise.all([
    f.discovery.discoverSnapshot(f.config), f.discovery.discoverSnapshot(untrusted)
  ]);
  assert.deepEqual(trustedResult.manifests.map(item => item.name), ['project']);
  assert.ok(trustedResult.diagnostics.some(item => item.includes('escape')));
  assert.deepEqual(untrustedResult.manifests, []);
  assert.deepEqual(untrustedResult.diagnostics, []);
  assert.deepEqual(f.discovery.diagnostics, [], 'snapshot reads do not mutate the legacy diagnostic facade');
  await f.discovery.discover(f.config);
  assert.deepEqual(f.discovery.diagnostics, trustedResult.diagnostics);
  assert.deepEqual(untrustedResult.diagnostics, [], 'another read cannot mutate an owned diagnostic snapshot');
});
test('installed Codex plugin Skills stay hidden even with the old discovery opt-in while standalone Skills still load', async () => {
  const f = await fixture();
  await f.put('standalone', markdown('standalone'));
  const bundle = path.join(f.home, 'plugins/cache/fixture/workflow/local');
  await mkdir(path.join(bundle, '.codex-plugin'), { recursive: true });
  await writeFile(path.join(f.home, 'config.toml'), '[plugins."workflow@fixture"]\nenabled = true\n');
  await writeFile(path.join(bundle, '.codex-plugin/plugin.json'), '{"name":"workflow","version":"1.0.0","skills":"./skills/"}');
  await f.put('index', markdown('index'), path.join(bundle, 'skills'));
  for (const includeCodexPlugins of [undefined, true, false]) {
    const discovery = new SkillDiscovery({ userSkillsUri: vscode.Uri.file(f.user), includeAdminSkills: false, includeCodexPlugins });
    const manifests = await discovery.discover(f.config);
    assert.deepEqual(manifests.map(item => item.name), ['standalone']);
    assert.ok(manifests.every(item => !item.pluginInstallation && item.source !== 'codexPlugin'));
    assert.ok(discovery.diagnostics.every(item => !/plugin/iu.test(item)));
    const loaded = await new SkillLoader().loadSkill(manifests[0]);
    assert.match(loaded.content, /Read the diff/u);
  }
});
test('same names retain paths, physical aliases deduplicate, symlink cycles and external targets are rejected', async () => {
  const f = await fixture(); const skill = await f.put('one'); await f.put('two', markdown(), f.user);
  await symlink(skill, path.join(f.repo, '.agents/skills/alias'));
  await symlink(f.root, path.join(f.repo, '.agents/skills/escape'));
  await symlink(path.join(f.repo, '.agents/skills'), path.join(f.repo, '.agents/skills/cycle'));
  const manifests = await f.discovery.discover(f.config);
  assert.equal(manifests.length, 2); assert.notEqual(manifests[0].id, manifests[1].id);
  assert.ok(f.discovery.diagnostics.some(item => item.includes('escape')));
});
test('openai.yaml interface and policy, MCP dependency blocking, and invalid metadata remain inspectable', async () => {
  const f = await fixture(); const dir = await f.put('policy'); await mkdir(path.join(dir, 'agents'));
  await writeFile(path.join(dir, 'agents/openai.yaml'), 'interface:\n  display_name: "显示: 名称"\npolicy:\n  allow_implicit_invocation: false\n');
  let [manifest] = await f.discovery.discover(f.config);
  assert.equal(manifest.allowImplicit, false); assert.equal(manifest.enabled, true); assert.equal(manifest.interface?.display_name, '显示: 名称');
  const fingerprint = manifest.contentFingerprint;
  await writeFile(path.join(dir, 'agents/openai.yaml'), 'dependencies:\n  tools:\n    - type: mcp\n      value: docs\n');
  [manifest] = await f.discovery.discover(f.config);
  assert.equal(manifest.enabled, false); assert.match(manifest.unavailableReason ?? '', /mcp:docs/u); assert.notEqual(fingerprint, manifest.contentFingerprint);
  await writeFile(path.join(dir, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: "false"');
  [manifest] = await f.discovery.discover(f.config); assert.equal(manifest.enabled, false);
  await assert.rejects(new SkillLoader().loadSkill(manifest));
});
test('missing required metadata stays unavailable instead of becoming a valid directory-name fallback', async () => {
  const f = await fixture(); await f.put('missing', '# heading');
  const [manifest] = await f.discovery.discover(f.config); assert.equal(manifest.enabled, false); assert.match(manifest.unavailableReason ?? '', /requires YAML/u);
});
test('a changed policy or replaced symlink cannot be loaded from an old discovery snapshot', async () => {
  const f = await fixture(); const dir = await f.put('changing'); await mkdir(path.join(dir, 'agents'));
  let [manifest] = await f.discovery.discover(f.config);
  await writeFile(path.join(dir, 'agents/openai.yaml'), 'policy:\n  allow_implicit_invocation: false');
  await assert.rejects(new SkillLoader().loadSkill(manifest), /policy changed/u);
  [manifest] = await f.discovery.discover(f.config);
  await rm(path.join(dir, 'SKILL.md'));
  await writeFile(path.join(f.root, 'private.md'), markdown() + 'PRIVATE');
  await symlink(path.join(f.root, 'private.md'), path.join(dir, 'SKILL.md'));
  await assert.rejects(new SkillLoader().loadSkill(manifest), /outside/u);
});
test('admin roots are explicit, linked user roots cannot grant external access, virtual filesystems are unavailable', async () => {
  const f = await fixture(); const admin = path.join(f.root, 'etc/codex/skills'); await f.put('admin', markdown('admin'), admin);
  const discovery = new SkillDiscovery({ includeUserSkills: false, adminSkillsUri: vscode.Uri.file(admin) });
  assert.equal((await discovery.discover(f.config)).find(item => item.name === 'admin')?.source, 'admin');
  await rm(f.user, { recursive: true }); await symlink(admin, f.user);
  assert.equal((await f.discovery.discover(f.config)).length, 0);
  assert.match(f.discovery.diagnostics.join(' '), /unsafe source root/u);
  const virtual = await loadSharedCodexConfig({ cwd: vscode.Uri.parse('vscode-remote://host/work'),
    folders: [{ uri: vscode.Uri.parse('vscode-remote://host/work'), name: 'remote', index: 0 }], trusted: true, codexHome: vscode.Uri.file(f.home) });
  assert.ok(virtual.diagnostics.some(item => item.blocksSkills));
});
test('untrusted workspace does not scan project skill contents; user sources remain available', async () => {
  const f = await fixture(); await f.put('project'); await f.put('personal', markdown('personal'), f.user);
  const config = await loadSharedCodexConfig({ folders: [f.folder], codexHome: vscode.Uri.file(f.home), trusted: false });
  const manifests = await f.discovery.discover(config); assert.deepEqual(manifests.map(item => item.name), ['personal']);
});
test('relative skill resources are read safely, scripts never load, and symlinked external resource gives a diagnostic', async () => {
  const f = await fixture(); const dir = await f.put('resources', markdown() + '\n[ref](references/a.md)\n[script](scripts/a.sh)\n[escape](references/out.md)');
  await mkdir(path.join(dir, 'references')); await mkdir(path.join(dir, 'scripts'));
  await writeFile(path.join(dir, 'references/a.md'), 'REFERENCE_OK'); await writeFile(path.join(dir, 'scripts/a.sh'), 'DO_NOT_EXECUTE');
  await writeFile(path.join(f.root, 'outside.md'), 'EXTERNAL_SECRET'); await symlink(path.join(f.root, 'outside.md'), path.join(dir, 'references/out.md'));
  const [manifest] = await f.discovery.discover(f.config); const loaded = await new SkillLoader().loadSkill(manifest);
  assert.match(loaded.content, /REFERENCE_OK/u); assert.match(loaded.content, /outside authorized boundary/u);
  assert.doesNotMatch(loaded.content, /EXTERNAL_SECRET|DO_NOT_EXECUTE/u);
});
test('safe YAML supports quotes, comments, multiline text and profile arrays; rejects duplicate keys, tags, aliases and invalid types', () => {
  assert.equal(parseSkillFrontmatter(markdown()).name, 'review');
  assert.deepEqual(parseSkillFrontmatter('---\nname: x\ndescription: "x: y" # comment\nmetadata:\n  keepseek:\n    runAs: subagent\n    tools: [read_file, search]\n---\n').tools, ['read_file', 'search']);
  for (const text of ['name: a\nname: b\ndescription: x', 'name: a\ndescription: 42', 'name: a', 'name: !!js/function x\ndescription: x', 'name: &n a\ndescription: *n']) {
    assert.throws(() => parseSkillFrontmatter(`---\n${text}\n---\n`));
  }
  assert.throws(() => parseSkillFrontmatter('---\nname: x\ndescription: '+ 'x'.repeat(70000)+'\n---'));
  assert.equal(parseSkillMetadata().allowImplicit, true);
  assert.equal(parseSkillMetadata('policy:\n  allow_implicit_invocation: false').allowImplicit, false);
  assert.throws(() => parseSkillMetadata('dependencies:\n  tools: nope'));
});
