import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { expandPromptReferencesInPrompt } from '../src/context/references/promptReferences';
import type { SkillManifest } from '../src/skills/skillTypes';

test('expands allowed Codex skill Markdown reference', async () => {
  const skillRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-skill-reference-'));
  await mkdir(path.join(skillRoot, 'references'), { recursive: true });
  const skillUri = vscode.Uri.file(path.join(skillRoot, 'SKILL.md'));
  await writeFile(
    skillUri.fsPath,
    [
      '---',
      'name: optimize-ui-interactions',
      'description: Optimize page-level UI interactions.',
      '---',
      '',
      '# Optimize UI Interactions',
      '',
      'Inspect the target page and improve interaction states.',
      '',
      'Read [interaction checklist](references/checklist.md) before editing.'
    ].join('\n'),
    'utf8'
  );
  await writeFile(
    path.join(skillRoot, 'references', 'checklist.md'),
    'Check keyboard focus and empty states.\n',
    'utf8'
  );

  const manifest = createSkillManifest(skillRoot, skillUri);
  const prompt = `使用 [$optimize-ui-interactions](${skillUri.fsPath}) 优化输入框交互。`;

  const expanded = await expandPromptReferencesInPrompt(prompt, {
    skillManifests: [manifest],
    language: 'zh-CN'
  });

  assert.match(expanded, /\[\$optimize-ui-interactions\]/u);
  assert.match(expanded, /Codex skill 引用/u);
  assert.match(expanded, /# Optimize UI Interactions/u);
  assert.match(expanded, /Inspect the target page/u);
  assert.match(expanded, /Loaded relative skill resources/u);
  assert.match(expanded, /Check keyboard focus/u);
});

test('does not expand skill Markdown links outside allowed skill sources', async () => {
  const allowedRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-allowed-skill-'));
  const allowedSkillUri = vscode.Uri.file(path.join(allowedRoot, 'SKILL.md'));
  await writeFile(allowedSkillUri.fsPath, '# Allowed Skill\n', 'utf8');

  const forbiddenRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-forbidden-skill-'));
  const forbiddenSkillUri = vscode.Uri.file(path.join(forbiddenRoot, 'SKILL.md'));
  await writeFile(forbiddenSkillUri.fsPath, 'hidden skill content\n', 'utf8');

  const prompt = `[$optimize-ui-interactions](${forbiddenSkillUri.fsPath})`;
  const expanded = await expandPromptReferencesInPrompt(prompt, {
    skillManifests: [createSkillManifest(allowedRoot, allowedSkillUri)],
    language: 'zh-CN'
  });

  assert.equal(expanded, prompt);
});

function createSkillManifest(rootPath: string, skillUri: vscode.Uri): SkillManifest {
  const rootUri = vscode.Uri.file(rootPath);
  return {
    id: `agentsUser:${encodeURIComponent(rootUri.toString())}`,
    name: 'optimize-ui-interactions',
    description: 'Optimize page-level UI interactions.',
    source: 'agentsUser',
    sourceLabel: 'Codex skills',
    rootUri,
    skillUri,
    enabled: true,
    allowImplicit: false,
    userInvocable: true,
    hasReferences: false,
    hasAssets: false,
    hasScripts: false
  };
}
