import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  openFileReference,
  revealReferenceInOperatingSystem
} from '../src/context/references/fileReferenceOpener';
import * as vscode from './stubs/vscode';

test('opens local directories in Finder or Windows Explorer', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-reference-directory-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => vscode.clearCommandHandlers());
  const revealed: vscode.Uri[] = [];
  vscode.setCommandHandler('revealFileInOS', (uri) => {
    revealed.push(uri as vscode.Uri);
  });

  await openFileReference(createOpenInput(root));

  assert.equal(revealed.length, 1);
  assert.equal(revealed[0]?.fsPath, root);
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

test('does not send non-file URIs to the operating-system file manager', async (t) => {
  t.after(() => vscode.clearCommandHandlers());
  let revealCount = 0;
  vscode.setCommandHandler('revealFileInOS', () => {
    revealCount += 1;
  });

  const remoteUri = vscode.Uri.parse('https://example.com/reference') as unknown as import('vscode').Uri;
  const revealed = await revealReferenceInOperatingSystem(remoteUri);

  assert.equal(revealed, false);
  assert.equal(revealCount, 0);
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
