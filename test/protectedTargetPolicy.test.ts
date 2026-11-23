import './registerVscodeStub';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { inspectDraftEditTarget } from '../src/approvals/authorization/editTargets';
import {
  HARD_DENIAL_MESSAGE,
  assertHardProtectedPath,
  isHardProtectedPath
} from '../src/approvals/authorization/protectedTargets';
import { createFullTextDraftEdit } from '../src/edits/draftEdit';
import { SafeFileEditor } from '../src/edits/safeFileEditor';
import * as vscode from './stubs/vscode';

/** D2: the only blacklist inside a trusted workspace folder. */
const BLOCKED = [
  '/',
  '/etc/passwd',
  '/private/etc/hosts',
  '/System/Library/CoreServices',
  '/Library/Preferences/example.plist',
  '/usr/bin/env',
  '/bin/sh',
  '/sbin/mount',
  '/dev/null',
  '/proc/self/environ',
  '/sys/kernel/notes',
  '/boot/vmlinuz',
  'C:/Windows/System32/drivers/etc/hosts',
  'C:/Program Files/KeepSeek/app.asar',
  'C:/Program Files (x86)/KeepSeek/app.asar',
  '.git',
  '.git/config',
  '.git/hooks/pre-commit',
  '.git/info/exclude',
  '.git/refs/heads/main',
  '.git/objects/ab/cdef',
  'repo/.git',
  'nested/.git/HEAD',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.git-credentials',
  'id_rsa',
  'id_ed25519',
  'credentials',
  'cookies',
  'home/.ssh/id_rsa'
];

/** D1/D4/D5: ordinary content writes stay open inside the workspace. */
const ALLOWED = [
  '.github/workflows/ci.yml',
  '.gitignore',
  '.gitattributes',
  '.gitmodules',
  '.agents/skills/demo/SKILL.md',
  '.agents/skills/demo/agents/openai.yaml',
  '.agents/skills/demo/scripts/run.sh',
  'AGENTS.md',
  '.env',
  '.env.local',
  '.env.production',
  'src/index.ts',
  'docs/guide.md',
  '.ssh/fixtures/known_hosts',
  '.codex/notes.md',
  '.aws/fixtures/config',
  'git/config',
  'my.git/notes.md'
];

interface WorkspaceFixture {
  root: string;
  uri: vscode.Uri;
  editor: SafeFileEditor;
  setTrust(value: boolean): void;
  dispose(): Promise<void>;
}

async function createFixture(): Promise<WorkspaceFixture> {
  const root = await mkdtemp(path.join(tmpdir(), 'keepseek-protected-target-'));
  const uri = vscode.Uri.file(root);
  const previousFolders = vscode.workspace.workspaceFolders;
  const previousTrust = vscode.workspace.isTrusted;
  (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders =
    [{ uri, name: 'protected-target', index: 0 }];
  (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = true;
  return {
    root,
    uri,
    editor: new SafeFileEditor(),
    setTrust(value: boolean) {
      (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = value;
    },
    async dispose() {
      (vscode.workspace as unknown as { workspaceFolders: unknown[] }).workspaceFolders = previousFolders;
      (vscode.workspace as unknown as { isTrusted: boolean }).isTrusted = previousTrust;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try { await rm(root, { recursive: true, force: true }); break; }
        catch { await new Promise(resolve => setTimeout(resolve, 25)); }
      }
    }
  };
}

test('the L2 hard boundary rejects authority-bearing paths only', () => {
  for (const value of BLOCKED) {
    assert.equal(isHardProtectedPath(value), true, `must block ${value}`);
    assert.throws(() => assertHardProtectedPath(value),
      (error: unknown) => error instanceof Error && error.message === HARD_DENIAL_MESSAGE,
      `must deny ${value}`);
  }
  for (const value of ALLOWED) {
    assert.equal(isHardProtectedPath(value), false, `must allow ${value}`);
  }
});

test('a workspace folder allows content writes and keeps .git closed', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const skill = vscode.Uri.file(path.join(fixture.root, '.agents', 'skills', 'demo', 'SKILL.md'));
  assert.equal((await inspectDraftEditTarget(skill, true)).root, fixture.uri.toString());
  await assert.rejects(inspectDraftEditTarget(vscode.Uri.file(path.join(fixture.root, '.git', 'config')), true));
  await mkdir(path.join(fixture.root, '.git', 'hooks'), { recursive: true });
  await symlink(path.join(fixture.root, '.git'), path.join(fixture.root, 'linked'), 'dir');
  await assert.rejects(
    inspectDraftEditTarget(vscode.Uri.file(path.join(fixture.root, 'linked', 'hooks', 'pre-commit')), true),
    (error: unknown) => error instanceof Error && error.message === HARD_DENIAL_MESSAGE);
});

test('inside .env opens while outside targets keep the exact-grant policy', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  await inspectDraftEditTarget(vscode.Uri.file(path.join(fixture.root, '.env')), true);
  await inspectDraftEditTarget(vscode.Uri.file(path.join(fixture.root, '.env.local')), true);
  const outside = await mkdtemp(path.join(tmpdir(), 'keepseek-protected-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await assert.rejects(inspectDraftEditTarget(vscode.Uri.file(path.join(outside, '.env')), true));
  await assert.rejects(inspectDraftEditTarget(
    vscode.Uri.file(path.join(outside, '.agents', 'skills', 'outside', 'SKILL.md')), true));
  await inspectDraftEditTarget(vscode.Uri.file(path.join(outside, 'notes.md')), true);
});

test('SafeFileEditor writes workspace skill content and still refuses .git', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  const skillPath = path.join(fixture.root, '.agents', 'skills', 'demo', 'SKILL.md');
  const createdContent = '---\nname: demo\ndescription: demo skill\n---\n\n# demo\n';
  const createEdit = createFullTextDraftEdit({
    id: 'skill-create',
    uri: vscode.Uri.file(skillPath).toString(),
    label: '.agents/skills/demo/SKILL.md',
    action: 'create',
    content: createdContent,
    reason: 'protected target policy fixture'
  });
  await fixture.editor.applyDraftEdit(createEdit);
  assert.equal(await readFile(skillPath, 'utf8'), createdContent);

  const updatedContent = '---\nname: demo\ndescription: demo skill\n---\n\n# demo updated\n';
  const modifyEdit = createFullTextDraftEdit({
    id: 'skill-modify',
    uri: vscode.Uri.file(skillPath).toString(),
    label: '.agents/skills/demo/SKILL.md',
    action: 'modify',
    content: updatedContent,
    reason: 'protected target policy fixture',
    base: createEdit.result
  });
  await fixture.editor.applyDraftEdit(modifyEdit);
  assert.equal(await readFile(skillPath, 'utf8'), updatedContent);

  const hookPath = path.join(fixture.root, '.git', 'hooks', 'pre-commit');
  const hookEdit = createFullTextDraftEdit({
    id: 'hook-create',
    uri: vscode.Uri.file(hookPath).toString(),
    label: '.git/hooks/pre-commit',
    action: 'create',
    content: '#!/bin/sh\nexit 0\n',
    reason: 'protected target policy fixture'
  });
  await assert.rejects(fixture.editor.applyDraftEdit(hookEdit),
    (error: unknown) => error instanceof Error && error.message === HARD_DENIAL_MESSAGE);
  await assert.rejects(readFile(hookPath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
});

test('an untrusted workspace still refuses workspace content writes', async t => {
  const fixture = await createFixture();
  t.after(() => fixture.dispose());
  fixture.setTrust(false);
  const agentsPath = path.join(fixture.root, 'AGENTS.md');
  const edit = createFullTextDraftEdit({
    id: 'agents-create',
    uri: vscode.Uri.file(agentsPath).toString(),
    label: 'AGENTS.md',
    action: 'create',
    content: '# instructions\n',
    reason: 'protected target policy fixture'
  });
  await assert.rejects(fixture.editor.applyDraftEdit(edit),
    (error: unknown) => error instanceof Error && error.message === 'DraftEdit requires a trusted workspace.');
  await assert.rejects(readFile(agentsPath),
    (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
});
