import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as vscode from 'vscode';
import { LegacyProjectMemoryMigration } from '../src/memory/legacyProjectMemoryMigration';

describe('LegacyProjectMemoryMigration', () => {
  const workspace = vscode.workspace as unknown as {
    workspaceFolders: Array<{ uri: vscode.Uri; name: string }>;
    workspaceFile?: vscode.Uri;
  };
  let root = '';
  let globalRoot = '';

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'keepseek-legacy-memory-workspace-'));
    globalRoot = await mkdtemp(path.join(os.tmpdir(), 'keepseek-legacy-memory-global-'));
    workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'memory-test' }];
    workspace.workspaceFile = undefined;
    await mkdir(path.join(root, '.keepseek'), { recursive: true });
    await writeFile(path.join(root, '.keepseek', 'memory.json'), JSON.stringify({
      schemaVersion: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
      entries: [
        createEntry('architecture', 'Keep Provider focused on coordination.'),
        createEntry('workflow', 'Run npm run compile, then npm run test.'),
        createEntry('preference', 'Prefer concise explanations.'),
        createEntry('project_note', 'apiKey=sk-example-secret-value-123456789')
      ]
    }), 'utf8');
  });

  afterEach(async () => {
    workspace.workspaceFolders = [];
    workspace.workspaceFile = undefined;
    await rm(root, { recursive: true, force: true });
    await rm(globalRoot, { recursive: true, force: true });
  });

  it('creates only pending DraftEdits and never writes or deletes source and target files', async () => {
    const sourcePath = path.join(root, '.keepseek', 'memory.json');
    const original = await readFile(sourcePath, 'utf8');
    const migration = new LegacyProjectMemoryMigration(
      vscode.Uri.file(globalRoot),
      new MemoryMemento(),
      () => 'workspace-a'
    );

    await migration.refresh();
    const draft = await migration.createDraft();

    assert.equal(migration.getStateView().detected, true);
    assert.equal(draft.edits.length, 2);
    assert.ok(draft.edits.some((edit) => edit.uri.endsWith('/AGENTS.md')));
    assert.ok(draft.edits.some((edit) => edit.uri.endsWith('/SKILL.md')));
    assert.match(draft.exportText, /Suggested personal Codex Skill/u);
    assert.doesNotMatch(draft.exportText, /sk-example-secret/u);
    assert.match(draft.exportText, /credential-shaped legacy entry/u);
    assert.equal(await readFile(sourcePath, 'utf8'), original);
    await assert.rejects(access(path.join(root, 'AGENTS.md')));
    await assert.rejects(access(path.join(root, '.agents', 'skills', 'legacy-project-workflow', 'SKILL.md')));
  });

  it('stops read-only injection only after explicit completion and supports rollback/export', async () => {
    const storage = new MemoryMemento();
    const migration = new LegacyProjectMemoryMigration(vscode.Uri.file(globalRoot), storage, () => 'workspace-a');
    await migration.refresh();

    assert.match(migration.createReadonlyContext('compile the project')?.content ?? '', /Provider|compile/u);
    await migration.markDraftCreated('change-1');
    assert.equal(migration.getStateView().status, 'draft-created');
    await migration.complete();
    assert.equal(migration.createReadonlyContext('compile'), undefined);
    assert.match(await migration.getExportText(), /Legacy KeepSeek Project Memory Export/u);
    await migration.rollback();
    assert.ok(migration.createReadonlyContext('compile'));
    assert.equal(await readFile(path.join(root, '.keepseek', 'memory.json'), 'utf8').then(Boolean), true);
  });
});

class MemoryMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  public keys(): readonly string[] {
    return [...this.values.keys()];
  }

  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }

  public async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

function createEntry(category: string, content: string) {
  return {
    id: `${category}-1`,
    category,
    content,
    source: 'user',
    confidence: 1,
    tags: [],
    enabled: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z'
  };
}
