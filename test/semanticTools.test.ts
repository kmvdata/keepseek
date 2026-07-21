import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { SemanticToolService } from '../src/agent/tools/semanticTools';
import type { WorkspaceToolAdapter } from '../src/agent/tools/workspaceTools';
import * as vscode from './stubs/vscode';

test('uses VS Code document symbol provider and returns structured symbol metadata', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-semantic-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  t.after(() => vscode.clearCommandHandlers());
  const filePath = path.join(root, 'sample.ts');
  await fs.writeFile(filePath, 'export function greet(name: string) { return name; }\n');
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'semantic' }];
  vscode.setCommandHandler('vscode.executeDocumentSymbolProvider', () => [{
    name: 'greet',
    detail: '(name: string)',
    kind: 11,
    range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 52)),
    selectionRange: new vscode.Range(new vscode.Position(0, 16), new vscode.Position(0, 21)),
    children: []
  }]);

  const service = new SemanticToolService(createWorkspaceAdapter(root));
  const result = JSON.parse(await service.getDocumentSymbols({ path: 'sample.ts' }, 'en'));

  assert.equal(result.ok, true);
  assert.equal(result.providerAvailable, true);
  assert.equal(result.fallback, false);
  assert.equal(result.results[0].name, 'greet');
  assert.equal(result.results[0].kind, 'Function');
  assert.deepEqual(result.results[0].selectionRange, {
    startLine: 1,
    startColumn: 17,
    endLine: 1,
    endColumn: 22
  });
  assert.match(result.results[0].preview, /function greet/u);
});

test('marks text-search fallback when a language provider is unavailable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-semantic-fallback-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  t.after(() => vscode.clearCommandHandlers());
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'fallback' }];
  vscode.setCommandHandler('vscode.executeWorkspaceSymbolProvider', () => undefined);
  const adapter = createWorkspaceAdapter(root, JSON.stringify({
    ok: true,
    results: [{
      path: 'src/example.ts',
      uri: vscode.Uri.file(path.join(root, 'src/example.ts')).toString(),
      line: 3,
      startColumn: 7,
      endColumn: 14,
      matchLine: 'class Example {}'
    }],
    truncated: false
  }));

  const result = JSON.parse(await new SemanticToolService(adapter).getWorkspaceSymbols({ query: 'Example' }, 'en'));

  assert.equal(result.ok, true);
  assert.equal(result.providerAvailable, false);
  assert.equal(result.fallback, true);
  assert.match(result.fallbackReason, /no workspace symbol provider/iu);
  assert.equal(result.results[0].name, 'Example');
});

test('uses reference provider and definition provider to exclude declarations', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-references-'));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  t.after(() => vscode.clearCommandHandlers());
  const filePath = path.join(root, 'references.ts');
  await fs.writeFile(filePath, 'function greet() {}\ngreet();\n');
  const uri = vscode.Uri.file(filePath);
  const declarationRange = new vscode.Range(new vscode.Position(0, 9), new vscode.Position(0, 14));
  const referenceRange = new vscode.Range(new vscode.Position(1, 0), new vscode.Position(1, 5));
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name: 'references' }];
  vscode.setCommandHandler('vscode.executeReferenceProvider', () => [
    { uri, range: declarationRange },
    { uri, range: referenceRange }
  ]);
  vscode.setCommandHandler('vscode.executeDefinitionProvider', () => [{ uri, range: declarationRange }]);

  const result = JSON.parse(await new SemanticToolService(createWorkspaceAdapter(root)).findReferences({
    path: 'references.ts',
    line: 2,
    column: 2,
    includeDeclaration: false
  }, 'en'));

  assert.equal(result.providerAvailable, true);
  assert.equal(result.fallback, false);
  assert.equal(result.includeDeclaration, false);
  assert.equal(result.count, 1);
  assert.equal(result.results[0].range.startLine, 2);
});

function createWorkspaceAdapter(root: string, searchResult = JSON.stringify({ ok: true, results: [], truncated: false })): WorkspaceToolAdapter {
  return {
    async listWorkspaceFiles() { return JSON.stringify({ ok: true }); },
    async listWorkspaceDirectory() { return JSON.stringify({ ok: true }); },
    async searchWorkspace() { return searchResult; },
    async readWorkspaceFile() { return JSON.stringify({ ok: true }); },
    async readWorkspaceFileRange() { return JSON.stringify({ ok: true }); },
    resolveTargetUri(targetPath: string) { return vscode.Uri.file(path.join(root, targetPath)); },
    getLabel(uri: import('vscode').Uri) { return path.relative(root, uri.fsPath); }
  } as unknown as WorkspaceToolAdapter;
}
