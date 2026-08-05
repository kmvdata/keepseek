import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  openDirectoryReferenceUri,
  openFileReference,
  revealReferenceInOperatingSystem
} from '../src/context/references/fileReferenceOpener';
import * as vscode from './stubs/vscode';

test('opens directories outside the workspace in Finder or Windows Explorer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-reference-external-directory-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => vscode.clearCommandHandlers());
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  const workspacePath = path.join(root, 'workspace');
  const externalPath = path.join(root, 'external');
  await fs.mkdir(workspacePath);
  await fs.mkdir(externalPath);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspacePath), name: 'workspace' }];
  const revealed: vscode.Uri[] = [];
  let explorerCount = 0;
  vscode.setCommandHandler('revealInExplorer', () => {
    explorerCount += 1;
  });
  vscode.setCommandHandler('revealFileInOS', (uri) => {
    revealed.push(uri as vscode.Uri);
  });

  await openFileReference(createOpenInput(externalPath));

  assert.equal(revealed.length, 1);
  assert.equal(revealed[0]?.fsPath, externalPath);
  assert.equal(explorerCount, 0);
});

test('opens workspace directories in the VS Code Explorer first', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-reference-workspace-directory-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => vscode.clearCommandHandlers());
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  const firstWorkspacePath = path.join(root, 'first-workspace');
  const secondWorkspacePath = path.join(root, 'second-workspace');
  const directoryPath = path.join(secondWorkspacePath, 'src');
  await fs.mkdir(firstWorkspacePath);
  await fs.mkdir(secondWorkspacePath);
  await fs.mkdir(directoryPath);
  vscode.workspace.workspaceFolders = [
    { uri: vscode.Uri.file(firstWorkspacePath), name: 'first' },
    { uri: vscode.Uri.file(secondWorkspacePath), name: 'second' }
  ];
  const opened: vscode.Uri[] = [];
  let nativeCount = 0;
  vscode.setCommandHandler('revealInExplorer', (uri) => {
    opened.push(uri as vscode.Uri);
  });
  vscode.setCommandHandler('revealFileInOS', () => {
    nativeCount += 1;
  });

  await openFileReference(createOpenInput(directoryPath));

  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.fsPath, directoryPath);
  assert.equal(nativeCount, 0);
});

test('falls back to Finder or Windows Explorer when VS Code Explorer cannot reveal a workspace directory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-reference-directory-fallback-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => vscode.clearCommandHandlers());
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  const directoryPath = path.join(root, 'src');
  await fs.mkdir(directoryPath);
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'workspace' }];
  const attempts: string[] = [];
  vscode.setCommandHandler('revealInExplorer', () => {
    attempts.push('vscode');
    throw new Error('Explorer unavailable');
  });
  vscode.setCommandHandler('revealFileInOS', () => {
    attempts.push('os');
  });

  await openFileReference(createOpenInput(directoryPath));

  assert.deepEqual(attempts, ['vscode', 'os']);
});

test('opens whole files in VS Code before using the operating-system fallback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-reference-file-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => vscode.clearCommandHandlers());
  const filePath = path.join(root, 'image.png');
  await fs.writeFile(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const opened: vscode.Uri[] = [];
  let revealCount = 0;
  vscode.setCommandHandler('vscode.open', (uri) => {
    opened.push(uri as vscode.Uri);
  });
  vscode.setCommandHandler('revealFileInOS', () => {
    revealCount += 1;
  });

  await openFileReference(createOpenInput(filePath));

  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.fsPath, filePath);
  assert.equal(revealCount, 0);
});

test('reveals a local file when VS Code cannot open it', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-reference-fallback-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => vscode.clearCommandHandlers());
  const filePath = path.join(root, 'unsupported.bin');
  await fs.writeFile(filePath, Buffer.from([0x00, 0x01]));
  let revealCount = 0;
  vscode.setCommandHandler('vscode.open', () => {
    throw new Error('No registered editor');
  });
  vscode.setCommandHandler('revealFileInOS', () => {
    revealCount += 1;
  });

  await openFileReference(createOpenInput(filePath));

  assert.equal(revealCount, 1);
});

test('does not send external non-file URIs to either file manager', async (t) => {
  t.after(() => vscode.clearCommandHandlers());
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  vscode.workspace.workspaceFolders = [];
  let revealCount = 0;
  let explorerCount = 0;
  vscode.setCommandHandler('revealFileInOS', () => {
    revealCount += 1;
  });
  vscode.setCommandHandler('revealInExplorer', () => {
    explorerCount += 1;
  });

  const remoteUri = vscode.Uri.parse('https://example.com/reference') as unknown as import('vscode').Uri;
  const revealed = await revealReferenceInOperatingSystem(remoteUri);
  const opened = await openDirectoryReferenceUri(remoteUri);

  assert.equal(revealed, false);
  assert.equal(opened, false);
  assert.equal(revealCount, 0);
  assert.equal(explorerCount, 0);
});

function createOpenInput(targetPath: string) {
  return {
    path: targetPath,
    startLine: 0,
    endLine: 0,
    startColumn: 0,
    endColumn: 0,
    language: 'en' as const
  };
}
