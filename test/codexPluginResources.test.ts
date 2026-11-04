import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { link, mkdir, mkdtemp, realpath, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import * as vscode from 'vscode';
import type { CodexPluginInstallation } from '../src/skills/codexPluginDiscovery';
import {
  describeCodexPluginCapability, normalizeCodexPluginSnapshot, normalizeCodexPluginTraversalState,
  pinCodexPluginSkill, readCodexPluginResource, validateCodexPluginSnapshot,
  type CodexPluginReadContext
} from '../src/skills/codexPluginResources';
import type { SkillManifest } from '../src/skills/skillTypes';

function hash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function fixture(t: TestContext, entryBody: string) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'keepseek-plugin-resources-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, 'plugin');
  const installation: CodexPluginInstallation = { id: 'fixture@market', marketplace: 'market', source: 'local',
    name: 'fixture', version: '1', rootPath: packageRoot, realRootPath: packageRoot, skillsPath: path.join(packageRoot, 'skills'),
    codexHomePath: root, manifestHash: hash('manifest'), installationHash: hash('install') };
  const put = async (relative: string, content: string) => {
    const target = path.join(packageRoot, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    return target;
  };
  const putSkill = async (name: string, body: string, settings: Partial<SkillManifest> = {}): Promise<SkillManifest> => {
    const content = `---\nname: ${name}\ndescription: Fixture Skill\n---\n${body}`;
    const target = await put(`skills/${name}/SKILL.md`, content);
    return { id: `fixture:${name}`, name, description: 'Fixture Skill', source: 'codexPlugin', sourceLabel: 'market',
      rootUri: vscode.Uri.file(path.dirname(target)), skillUri: vscode.Uri.file(target), enabled: true, allowImplicit: false,
      hasAssets: false, hasScripts: false, hasReferences: false, pluginQualifiedName: `fixture:${name}`,
      documentHash: hash(content), metadataHash: hash(''), ...settings };
  };
  const entry = await putSkill('index', entryBody);
  const revoked = new Set<string>();
  const revokedNames = new Set<string>();
  const context: CodexPluginReadContext = { isTrusted: true, routingAvailable: true, availableTools: [],
    validateInstallation: async (current, file, name) => current.installationHash === installation.installationHash
      && !revoked.has(file) && (!name || !revokedNames.has(name)) };
  return { root, packageRoot, installation, context, entry, put, putSkill, revoked, revokedNames };
}

test('pins the entry, includes common references, and reads same-package branches and resources on demand', async t => {
  const f = await fixture(t, '[shared](../../references/common.md#usage)\n[$branch](../branch/SKILL.md)\n[disabled](../blocked/SKILL.md)');
  const branch = await f.putSkill('branch', '[branch details](references/branch%20details.md#tip)\n[parent](../index/SKILL.md)');
  const blocked = await f.putSkill('blocked', 'BLOCKED', { enabled: false });
  await f.put('references/common.md', 'PUBLIC-COMMON');
  await f.put('skills/branch/references/branch details.md', 'BRANCH-DETAIL');
  const entry = await pinCodexPluginSkill(f.installation, f.entry, [f.entry, branch, blocked], f.context);
  assert.match(entry.content, /PUBLIC-COMMON/u);
  assert.doesNotMatch(entry.content, /BRANCH-DETAIL|BLOCKED/u);
  assert.equal(entry.resources.length, 2);
  assert.equal(entry.capability.status, 'unverified');
  const recovered = normalizeCodexPluginSnapshot(JSON.parse(JSON.stringify(entry.snapshot)));
  assert.ok(recovered);
  assert.equal(recovered.progress.reads, 2);
  const route = await readCodexPluginResource(recovered, { mode: 'route', reference: '$fixture:branch' }, f.context);
  assert.equal(route.kind, 'skill');
  assert.match(route.content ?? '', /branch details/u);
  assert.equal(route.hash, branch.documentHash);
  assert.equal(route.snapshot.progress.reads, 3);
  assert.equal(recovered.progress.reads, 2);
  assert.ok(normalizeCodexPluginTraversalState(route.snapshot.progress, recovered));
  const linked = await readCodexPluginResource(route.snapshot, { mode: 'read', from: route.path, reference: 'references/branch%20details.md#tip' }, f.context);
  assert.equal(linked.content, 'BRANCH-DETAIL');
  await assert.rejects(readCodexPluginResource(linked.snapshot, { mode: 'route', from: route.path, reference: '../index/SKILL.md' }, f.context), /cyclic/u);
  await assert.rejects(readCodexPluginResource(linked.snapshot, { mode: 'route', reference: '../blocked/SKILL.md' }, f.context), /enabled/u);
  await assert.rejects(readCodexPluginResource(linked.snapshot, { mode: 'read', reference: '../blocked/SKILL.md' }, f.context), /enabled/u);
  f.revokedNames.add('branch');
  await assert.rejects(validateCodexPluginSnapshot(linked.snapshot, f.context), /disabled/u);
  f.revokedNames.clear();
  f.revoked.add(branch.skillUri.fsPath);
  await assert.rejects(validateCodexPluginSnapshot(linked.snapshot, f.context), /disabled/u);
});

test('rejects external links, escaped traversal, scripts, sensitive paths, links and late replacements', async t => {
  const f = await fixture(t, [
    '[branch](../branch/SKILL.md)',
    '[escape](../../../outside.md)',
    '[absolute](/tmp/outside.md)',
    '[encoded](..%2F../references/hidden.md)',
    '[remote](https://example.test/a.md)',
    '[script](../../scripts/bootstrap.txt)',
    '[secret](../../credentials.md)',
    '[alias](../../references/symlink.md)',
    '[hardlink](../../references/hardlink.md)',
    '```md',
    '[example](../../references/example.md)',
    '```'
  ].join('\n'));
  const branch = await f.putSkill('branch', '[replace](references/replaced.md)\n[add](references/late.md)');
  await f.put('scripts/bootstrap.txt', 'SCRIPT');
  await f.put('credentials.md', 'CREDENTIAL');
  await f.put('references/example.md', 'EXAMPLE-ONLY');
  await f.put('references/hidden.md', 'ENCODED');
  const outside = path.join(f.root, 'outside.md');
  await writeFile(outside, 'EXTERNAL');
  await symlink(outside, path.join(f.packageRoot, 'references/symlink.md'));
  await link(outside, path.join(f.packageRoot, 'references/hardlink.md'));
  const replaced = await f.put('skills/branch/references/replaced.md', 'old');
  const oldTime = new Date('2020-01-01T00:00:00Z');
  await utimes(replaced, oldTime, oldTime);
  const pinned = await pinCodexPluginSkill(f.installation, f.entry, [f.entry, branch], f.context);
  assert.doesNotMatch(pinned.content, /SCRIPT|CREDENTIAL|EXAMPLE-ONLY|ENCODED|EXTERNAL/u);
  const route = await readCodexPluginResource(pinned.snapshot, { mode: 'route', reference: 'fixture:branch' }, f.context);
  await writeFile(replaced, 'new');
  await utimes(replaced, oldTime, oldTime);
  await f.put('skills/branch/references/late.md', 'NEW FILE');
  await assert.rejects(readCodexPluginResource(route.snapshot, { mode: 'read', from: route.path, reference: 'references/replaced.md' }, f.context), /changed/u);
  await assert.rejects(readCodexPluginResource(route.snapshot, { mode: 'read', from: route.path, reference: 'references/late.md' }, f.context), /pinned/u);
  for (const reference of ['/tmp/outside.md', '..%2f../references/hidden.md', '../../../outside.md', 'https://example.test/a.md',
    '../../references/example.md', '../../scripts/bootstrap.txt', '../../credentials.md']) {
    await assert.rejects(readCodexPluginResource(route.snapshot, { mode: 'read', reference }, f.context), /Undeclared/u);
  }
  for (const reference of ['../../references/symlink.md', '../../references/hardlink.md']) {
    await assert.rejects(readCodexPluginResource(route.snapshot, { mode: 'read', reference }, f.context), /pinned/u);
  }
  await assert.rejects(readCodexPluginResource(route.snapshot, { mode: 'read', reference: 'fixture:branch' }, { ...f.context, isTrusted: false }), /trusted/u);
});

test('declared tool gaps block workflow execution while preserving a separate read-only inspection mode', async t => {
  const f = await fixture(t, '[review](../review/SKILL.md)');
  const review = await f.putSkill('review', 'READ-ONLY-BODY', { dependencies: [{ type: 'mcp', value: 'browser' }] });
  const { snapshot } = await pinCodexPluginSkill(f.installation, f.entry, [f.entry, review], f.context);
  const blocked = await readCodexPluginResource(snapshot, { mode: 'route', reference: 'fixture:review' }, f.context);
  assert.equal(blocked.content, undefined);
  assert.equal(blocked.capability?.status, 'missing');
  assert.equal(blocked.capability?.requirements[0].id, 'mcp:browser');
  const inspected = await readCodexPluginResource(blocked.snapshot, { mode: 'read', reference: 'fixture:review' }, f.context);
  assert.match(inspected.content ?? '', /READ-ONLY-BODY/u);
  assert.equal(inspected.capability?.status, 'missing');
  await assert.rejects(readCodexPluginResource(inspected.snapshot, { mode: 'read', reference: 'fixture:review' }, f.context), /already delivered/u);
});

test('Product Design descriptors report observed audit and ideation gaps only for the matched version and hash', async t => {
  const f = await fixture(t, 'fixture');
  const installation = { ...f.installation, marketplace: 'openai-curated-remote', name: 'product-design', version: '0.1.56' };
  const auditPath = path.join(installation.skillsPath, 'audit/SKILL.md');
  const auditHash = '087f798c3fe02e91b4cca18cc0f42c358a4dc2c02ccf37a348b476fb19b64aa3';
  const audit = describeCodexPluginCapability(installation, auditPath, [], f.context, auditHash);
  assert.equal(audit.status, 'missing');
  assert.ok(audit.requirements.some(item => item.id === 'browser' && item.required && item.status === 'missing'));
  const ideate = describeCodexPluginCapability(installation, path.join(installation.skillsPath, 'ideate/SKILL.md'), [], f.context,
    '649e8782ca93d5aece712964fae5be2b111cc3143577e1507b98df7f9d8e6bde');
  assert.ok(ideate.requirements.some(item => item.id === 'imageGen' && item.required && item.status === 'missing'));
  assert.ok(ideate.requirements.some(item => item.id === 'visualChoice' && item.required && item.status === 'missing'));
  assert.equal(describeCodexPluginCapability(installation, auditPath, [], f.context, hash('edited')).status, 'unverified');
  assert.equal(describeCodexPluginCapability({ ...installation, version: '0.1.57' }, auditPath, [], f.context, auditHash).status, 'unverified');
});

test('enforces bounded route depth and rejects corrupted recovery state', async t => {
  const f = await fixture(t, '[step](../step1/SKILL.md)');
  const skills = [f.entry];
  for (let index = 1; index <= 7; index++) {
    skills.push(await f.putSkill(`step${index}`, `[next](../step${index + 1}/SKILL.md)`));
  }
  let { snapshot } = await pinCodexPluginSkill(f.installation, f.entry, skills, f.context);
  let from = snapshot.entryPath;
  for (let index = 1; index <= 6; index++) {
    const result = await readCodexPluginResource(snapshot, { mode: 'route', from, reference: `../step${index}/SKILL.md` }, f.context);
    snapshot = result.snapshot;
    from = result.path;
  }
  await assert.rejects(readCodexPluginResource(snapshot, { mode: 'route', from, reference: '../step7/SKILL.md' }, f.context), /depth limit/u);
  assert.equal(normalizeCodexPluginSnapshot({ ...snapshot, progress: { ...snapshot.progress, reads: 9999 } }), undefined);
  assert.equal(normalizeCodexPluginSnapshot({ ...snapshot, files: { ...snapshot.files, '../escape.md': '1:2:3:4:5' } }), undefined);
});

test('remote integrity index fixes allowed bytes and canonical package paths across host aliases', async t => {
  const f = await fixture(t, '[verified](../../references/verified.md)\n[extra](../../references/extra.md)');
  await f.put('references/verified.md', 'VERIFIED');
  await f.put('references/extra.md', 'EXTRA');
  const integrity = JSON.stringify({ schema_version: 1, hash_algorithm: 'sha256', files: [
    { path: 'skills/index/SKILL.md', sha256: f.entry.documentHash },
    { path: 'references/verified.md', sha256: hash('VERIFIED') }
  ] });
  await f.put('integrity.json', integrity);
  const alias = path.join(f.root, 'alias');
  await symlink(f.packageRoot, alias, 'junction');
  const installation: CodexPluginInstallation = { ...f.installation, source: 'remote', rootPath: alias, integrityHash: hash(integrity) };
  const entry = await pinCodexPluginSkill(installation, f.entry, [f.entry], f.context);
  assert.ok(entry.resources.some(item => item.uri.endsWith('/plugin/references/verified.md')));
  assert.doesNotMatch(entry.content, /EXTRA/u);
  assert.ok(normalizeCodexPluginSnapshot(JSON.parse(JSON.stringify(entry.snapshot))));
  await f.put('references/verified.md', 'MODIFIED');
  await assert.rejects(pinCodexPluginSkill(installation, f.entry, [f.entry], f.context), /changed/u);
});

test('applies the task byte limit to on-demand files and does not grant new budget after restoration', async t => {
  const f = await fixture(t, Array.from({ length: 6 }, (_, index) =>
    `[file ${index}](../../references/doc-${index}.md)`).join('\n'));
  for (let index = 0; index < 6; index++) {
    await f.put(`references/doc-${index}.md`, 'x'.repeat(50 * 1024));
  }
  let { snapshot } = await pinCodexPluginSkill(f.installation, f.entry, [f.entry], f.context);
  for (let index = 0; index < 5; index++) {
    const result = await readCodexPluginResource(snapshot, { mode: 'read', reference: `../../references/doc-${index}.md` }, f.context);
    snapshot = result.snapshot;
  }
  const restored = normalizeCodexPluginSnapshot(JSON.parse(JSON.stringify(snapshot)));
  assert.ok(restored);
  assert.equal(restored.progress.reads, 6);
  await assert.rejects(readCodexPluginResource(restored, { mode: 'read', reference: '../../references/doc-5.md' }, f.context), /budget/u);
});
