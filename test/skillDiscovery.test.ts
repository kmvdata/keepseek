import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { parseSkillFrontmatter, SkillDiscovery } from '../src/skills/skillDiscovery';

type MutableWorkspaceStub = {
  workspaceFolders: Array<{ uri: vscode.Uri; name?: string }>;
  isTrusted: boolean;
};

test('discovers workspace skills directly under .agents with AGENTS.md instructions', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-agents-skills-'));
  const skillPath = path.join(workspacePath, '.agents', 'review-flow');
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(skillPath, 'AGENTS.md'),
    [
      '---',
      'name: review-flow',
      'description: Review changes before sending them.',
      '---',
      '',
      '# Review Flow',
      '',
      'Read the diff and call out risks.'
    ].join('\n'),
    'utf8'
  );

  const workspace = vscode.workspace as unknown as MutableWorkspaceStub;
  workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath), name: 'project' }];
  workspace.isTrusted = true;

  const manifests = await new SkillDiscovery({ includeCodexSkills: false }).discover();
  const manifest = manifests.find((item) => item.name === 'review-flow');

  assert.ok(manifest);
  assert.equal(manifest.description, 'Review changes before sending them.');
  assert.equal(manifest.source, 'agentsWorkspace');
  assert.equal(path.basename(manifest.skillUri.fsPath), 'AGENTS.md');
});

test('returns no skills when .agents is missing', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-no-agents-skills-'));
  const workspace = vscode.workspace as unknown as MutableWorkspaceStub;
  workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath), name: 'project' }];
  workspace.isTrusted = true;

  const manifests = await new SkillDiscovery({ includeCodexSkills: false }).discover();

  assert.deepEqual(manifests, []);
});

test('discovers Codex home skills recursively from SKILL.md frontmatter', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-workspace-skills-'));
  const codexSkillsPath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-codex-skills-'));
  const skillPath = path.join(codexSkillsPath, 'optimize-ui-interactions');
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(skillPath, 'SKILL.md'),
    [
      '---',
      'name: optimize-ui-interactions',
      'description: Optimize page-level UI interactions.',
      '---',
      '',
      '# Optimize UI Interactions'
    ].join('\n'),
    'utf8'
  );

  const workspace = vscode.workspace as unknown as MutableWorkspaceStub;
  workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath), name: 'project' }];
  workspace.isTrusted = true;

  const manifests = await new SkillDiscovery({
    codexSkillsUri: vscode.Uri.file(codexSkillsPath)
  }).discover();
  const manifest = manifests.find((item) => item.name === 'optimize-ui-interactions');

  assert.ok(manifest);
  assert.equal(manifest.description, 'Optimize page-level UI interactions.');
  assert.equal(manifest.source, 'agentsUser');
  assert.equal(manifest.sourceLabel, 'Codex skills');
  assert.equal(manifest.skillUri.fsPath, path.join(skillPath, 'SKILL.md'));
});

test('discovers skills bundled in a repo-scoped Codex plugin', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-workspace-plugin-'));
  const pluginPath = path.join(workspacePath, 'plugins', 'review-plugin');
  const skillPath = path.join(pluginPath, 'skills', 'review-flow');
  await mkdir(path.join(pluginPath, '.codex-plugin'), { recursive: true });
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(pluginPath, '.codex-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'review-plugin',
      version: '1.0.0',
      description: 'Review workflows.',
      skills: './skills/'
    }),
    'utf8'
  );
  await writeFile(
    path.join(skillPath, 'SKILL.md'),
    [
      '---',
      'name: review-flow',
      'description: Review repository changes.',
      '---',
      '',
      '# Review Flow'
    ].join('\n'),
    'utf8'
  );

  const workspace = vscode.workspace as unknown as MutableWorkspaceStub;
  workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath), name: 'project' }];
  workspace.isTrusted = true;

  const manifests = await new SkillDiscovery({ includeCodexSkills: false }).discover();
  const manifest = manifests.find((item) => item.name === 'review-flow');

  assert.ok(manifest);
  assert.equal(manifest.source, 'agentsWorkspace');
  assert.equal(manifest.sourceLabel, 'project Codex plugins');
  assert.equal(manifest.skillUri.fsPath, path.join(skillPath, 'SKILL.md'));
});

test('discovers skills bundled in the personal Codex plugins directory', async () => {
  const workspacePath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-workspace-plugins-'));
  const codexPluginsPath = await mkdtemp(path.join(os.tmpdir(), 'keepseek-codex-plugins-'));
  const skillPath = path.join(codexPluginsPath, 'context-plugin', 'skills', 'context-flow');
  await mkdir(skillPath, { recursive: true });
  await writeFile(
    path.join(skillPath, 'SKILL.md'),
    [
      '---',
      'name: context-flow',
      'description: Maintain prompt context references.',
      '---',
      '',
      '# Context Flow'
    ].join('\n'),
    'utf8'
  );

  const workspace = vscode.workspace as unknown as MutableWorkspaceStub;
  workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath), name: 'project' }];
  workspace.isTrusted = true;

  const manifests = await new SkillDiscovery({
    includeCodexSkills: false,
    includeCodexPlugins: true,
    codexPluginsUri: vscode.Uri.file(codexPluginsPath)
  }).discover();
  const manifest = manifests.find((item) => item.name === 'context-flow');

  assert.ok(manifest);
  assert.equal(manifest.source, 'agentsUser');
  assert.equal(manifest.sourceLabel, 'Codex plugins');
  assert.equal(manifest.skillUri.fsPath, path.join(skillPath, 'SKILL.md'));
});

test('parses Codex skill frontmatter name and description', () => {
  const parsed = parseSkillFrontmatter([
    '---',
    'name: optimize-ui-interactions',
    'description: Optimize page-level UI interactions.',
    'metadata:',
    '  keepseek:',
    '    allowImplicit: true',
    '    userInvocable: false',
    '---',
    '',
    '# Body'
  ].join('\n'));

  assert.deepEqual(parsed, {
    name: 'optimize-ui-interactions',
    description: 'Optimize page-level UI interactions.',
    allowImplicit: true,
    userInvocable: false
  });
});
