import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { SkillDiscovery } from '../src/skills/skillDiscovery';

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

  const manifests = await new SkillDiscovery().discover();
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

  const manifests = await new SkillDiscovery().discover();

  assert.deepEqual(manifests, []);
});
