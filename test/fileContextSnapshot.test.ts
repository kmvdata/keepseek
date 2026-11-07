import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { FileContextStore } from '../src/context/fileContextStore';
import type { ContextFile } from '../src/shared/types';

const limits = () => ({ maxFileBytes: 4096, maxContextFiles: 3 });
function file(content = 'const unsaved = "中文";\n', source: ContextFile['source'] = 'workspace'): ContextFile {
  const uri = vscode.Uri.file('/temporary-selected-project/unsaved.ts');
  return { id: uri.toString(), uri: uri.toString(), label: 'unsaved.ts', fsPath: uri.fsPath,
    languageId: 'typescript', content, sizeBytes: Buffer.byteLength(content), source };
}

test('task context snapshot preserves explicitly selected unsaved bytes without filesystem reads or sharing mutable state', () => {
  const selected = file(), snapshot = [selected];
  const workerA = new FileContextStore(limits), workerB = new FileContextStore(limits);
  const originalRead = vscode.workspace.fs.readFile;
  let reads = 0;
  vscode.workspace.fs.readFile = async () => { reads++; throw new Error('Snapshot must not reread disk'); };
  try {
    workerA.restoreSnapshot(snapshot); workerB.restoreSnapshot(snapshot);
    selected.content = 'mutated project selection';
    assert.equal(workerA.getAll()[0].content, 'const unsaved = "中文";\n');
    workerA.getAll()[0].content = 'mutated Worker A';
    workerA.clear();
    assert.equal(workerB.getAll()[0].content, 'const unsaved = "中文";\n');
    assert.equal(reads, 0);
    assert.notEqual(workerB.getAll()[0], selected);
  } finally { vscode.workspace.fs.readFile = originalRead; }
});

test('invalid context snapshot fails before replacing existing selections', () => {
  const store = new FileContextStore(limits), saved = file();
  store.restoreSnapshot([saved]);
  for (const invalid of [
    [{ ...file(), id: 'wrong-key' }],
    [{ ...file(), uri: 'not a uri' }],
    [{ ...file(), fsPath: '/different-target.ts' }],
    [{ ...file(), sizeBytes: 1 }],
    [{ ...file(), sizeBytes: -1 }],
    [{ ...file(), sizeBytes: Infinity }],
    [{ ...file(), content: undefined }],
    [{ ...file(), source: 'model' }],
    [file(), file()],
    [file('x'.repeat(4097))],
    [file(), file(), file(), file()]
  ]) {
    assert.throws(() => store.restoreSnapshot(invalid as ContextFile[]));
    assert.deepEqual(store.getAll(), [saved]);
  }
  store.restoreSnapshot([]);
  assert.deepEqual(store.getAll(), []);
});

test('external snapshot remains data and preserves the exact URI rather than expanding read scope', () => {
  const store = new FileContextStore(limits), selected = file('explicit external body', 'external');
  store.restoreSnapshot([selected]);
  assert.deepEqual(store.getAll(), [selected]);
  assert.equal(store.getAll()[0].uri, selected.uri);
  assert.equal(store.getAll()[0].source, 'external');
});
