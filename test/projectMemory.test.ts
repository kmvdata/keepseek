import { strict as assert } from 'node:assert';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { ProjectMemoryService, containsSensitiveMaterial } from '../src/memory/projectMemoryService';
import { ProjectMemoryStore } from '../src/memory/projectMemoryStore';

describe('ProjectMemoryService', () => {
  const workspace = vscode.workspace as unknown as {
    workspaceFolders: Array<{ uri: vscode.Uri; name?: string }>;
  };
  let root = '';
  let globalRoot = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-memory-workspace-'));
    globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-memory-global-'));
    workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'memory-test' }];
  });

  afterEach(async () => {
    workspace.workspaceFolders = [];
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(globalRoot, { recursive: true, force: true });
  });

  it('requires a pending confirmation before persisting and injects confirmed memory', async () => {
    const service = new ProjectMemoryService(new ProjectMemoryStore(vscode.Uri.file(globalRoot)));
    await service.initialize();
    const update = service.proposeAdd({
      content: 'Run npm run test before finishing changes.',
      category: 'testing',
      tags: ['test']
    });

    assert.equal(service.getStateView().entries.length, 0);
    assert.equal(service.getStateView().pendingUpdates.length, 1);
    await service.applyUpdate(update.id);

    assert.equal(service.getStateView().entries.length, 1);
    const persisted = JSON.parse(await fs.readFile(path.join(root, '.keepseek', 'memory.json'), 'utf8')) as { schemaVersion: number };
    assert.equal(persisted.schemaVersion, 1);
    const context = service.createContext('Please validate the current change with tests.');
    assert.ok(context?.content.includes('npm run test'));
    assert.equal(context?.entryIds.length, 1);
  });

  it('rejects credential-shaped content and suggests explicit remember requests', async () => {
    const service = new ProjectMemoryService(new ProjectMemoryStore(vscode.Uri.file(globalRoot)));
    await service.initialize();

    assert.equal(containsSensitiveMaterial('apiKey=sk-example-secret-value-123456789'), true);
    assert.throws(() => service.proposeAdd({
      content: 'apiKey=sk-example-secret-value-123456789',
      category: 'project_note'
    }), /cannot store/iu);
    const suggestions = service.suggestFromPrompt('记住：以后都先运行 lint 再运行 test。');
    assert.equal(suggestions.length, 1);
    assert.equal(suggestions[0].action, 'add');
    assert.equal(service.getStateView().entries.length, 0);
  });
});
