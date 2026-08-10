import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import {
  WorkspaceToolService,
  type WorkspaceSearchExecutionOptions,
  type WorkspaceSearchInput
} from '../src/agent/tools/workspaceTools';
import * as vscode from './stubs/vscode';

interface ParsedSearchResult {
  ok: boolean;
  query?: string;
  results?: Array<{
    path: string;
    uri: string;
    line: number;
    startColumn: number;
    endColumn: number;
    matchLine: string;
    before: Array<{ line: number; text: string }>;
    after: Array<{ line: number; text: string }>;
  }>;
  count?: number;
  truncated?: boolean;
  engine?: 'vscode' | 'fallback';
  candidateFilesTruncated?: boolean;
  skippedFiles?: {
    unreadable: number;
    oversized: number;
    unsupported: number;
  };
  error?: string;
}

test('workspace search finds literal text case-insensitively and returns line context', async (t) => {
  const root = await createWorkspace(t, 'literal');
  await writeWorkspaceFile(root, 'src/example.ts', [
    'first context line',
    'second context line',
    'const Needle = 1;',
    'first trailing line',
    'second trailing line',
    'last line'
  ].join('\n'));

  const result = await search({ query: 'needle' });

  assert.equal(result.ok, true);
  assertSearchMetadata(result);
  assert.equal(result.count, 1);
  assert.equal(result.results?.[0]?.path, 'src/example.ts');
  assert.equal(result.results?.[0]?.line, 3);
  assert.equal(result.results?.[0]?.startColumn, 7);
  assert.equal(result.results?.[0]?.endColumn, 13);
  assert.equal(result.results?.[0]?.matchLine, 'const Needle = 1;');
  assert.deepEqual(result.results?.[0]?.before, [
    { line: 1, text: 'first context line', truncated: false },
    { line: 2, text: 'second context line', truncated: false }
  ]);
  assert.deepEqual(result.results?.[0]?.after, [
    { line: 4, text: 'first trailing line', truncated: false },
    { line: 5, text: 'second trailing line', truncated: false }
  ]);

  const caseSensitiveMiss = await search({ query: 'needle', matchCase: true });
  assert.equal(caseSensitiveMiss.ok, true);
  assert.equal(caseSensitiveMiss.count, 0);
});

test('range reads expose a stable continuation cursor within the output budget', async (t) => {
  const root = await createWorkspace(t, 'range-cursor');
  await writeWorkspaceFile(root, 'src/large.ts', Array.from({ length: 200 }, (_value, index) => (
    `line ${index + 1} ${'x'.repeat(40)}`
  )).join('\n'));
  const service = new WorkspaceToolService();
  const first = JSON.parse(await service.readWorkspaceFileRange({
    path: 'src/large.ts',
    startLine: 1,
    endLine: 100,
    maxBytes: 500
  }, 'en')) as { ok: boolean; endLine: number; totalLines: number; truncated: boolean; hasMore: boolean; nextStartLine?: number };

  assert.equal(first.ok, true);
  assert.equal(first.truncated, true);
  assert.equal(first.hasMore, true);
  assert.equal(first.nextStartLine, first.endLine);
  const second = JSON.parse(await service.readWorkspaceFileRange({
    path: 'src/large.ts',
    startLine: first.nextStartLine!,
    endLine: first.nextStartLine! + 10,
    maxBytes: 2_000
  }, 'en')) as { ok: boolean; startLine: number };
  assert.equal(second.ok, true);
  assert.equal(second.startLine, first.nextStartLine);
});

test('workspace search supports regex, path and include scopes while excluding generated directories', async (t) => {
  const root = await createWorkspace(t, 'scope');
  await writeWorkspaceFile(root, 'src/one.ts', 'export const Needle = 42;\n');
  await writeWorkspaceFile(root, 'other/two.ts', 'export const Needle = 7;\n');
  await writeWorkspaceFile(root, 'other/two.js', 'export const Needle = 9;\n');
  await writeWorkspaceFile(root, 'assets/hidden.png', 'export const Needle = 8;\n');
  await writeWorkspaceFile(root, 'node_modules/hidden.ts', 'export const Needle = 10;\n');
  await writeWorkspaceFile(root, 'dist/generated.ts', 'export const Needle = 11;\n');

  const regexResult = await search({
    query: 'Needle\\s*=\\s*\\d+',
    path: 'src',
    isRegex: true,
    matchCase: true
  });
  assert.deepEqual(regexResult.results?.map((item) => item.path), ['src/one.ts']);

  const includeResult = await search({ query: 'Needle', include: 'other/**/*.ts' });
  assert.deepEqual(includeResult.results?.map((item) => item.path), ['other/two.ts']);

  const unscopedResult = await search({ query: 'Needle' });
  assert.deepEqual(
    unscopedResult.results?.map((item) => item.path).sort(),
    ['other/two.js', 'other/two.ts', 'src/one.ts']
  );
  assert.equal(unscopedResult.skippedFiles?.unsupported, 1);
});

test('workspace search rejects invalid regex and paths or globs outside the workspace', async (t) => {
  const root = await createWorkspace(t, 'boundaries');
  await writeWorkspaceFile(root, 'inside.ts', 'needle\n');
  const outsideRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-search-outside-'));
  t.after(async () => await fs.rm(outsideRoot, { recursive: true, force: true }));
  await writeWorkspaceFile(outsideRoot, 'outside.ts', 'needle\n');

  const invalidRegex = await search({ query: '[', isRegex: true });
  assert.equal(invalidRegex.ok, false);
  assert.match(invalidRegex.error ?? '', /invalid/iu);

  const outsidePath = await searchFailure({ query: 'needle', path: path.join(outsideRoot, 'outside.ts') });
  assert.equal(outsidePath.ok, false);
  assert.match(outsidePath.error ?? '', /inside|workspace/iu);

  const traversingInclude = await searchFailure({ query: 'needle', include: '../**/*.ts' });
  assert.equal(traversingInclude.ok, false);
  assert.match(traversingInclude.error ?? '', /outside|traverse/iu);

  const ambiguousScope = await searchFailure({ query: 'needle', path: '.', include: '**/*.ts' });
  assert.equal(ambiguousScope.ok, false);
  assert.match(ambiguousScope.error ?? '', /path.*include|include.*path/iu);
});

test('workspace search stops before scanning when its signal is already aborted', async (t) => {
  const root = await createWorkspace(t, 'abort');
  await writeWorkspaceFile(root, 'inside.ts', 'needle\n');
  const controller = new AbortController();
  controller.abort();

  const result = await searchFailure({ query: 'needle' }, { signal: controller.signal });

  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /stop|abort/iu);
});

test('workspace search honors the result limit and reports truncation', async (t) => {
  const root = await createWorkspace(t, 'limit');
  await writeWorkspaceFile(root, 'many.txt', 'needle needle needle\nneedle\n');

  const result = await search({ query: 'needle', maxResults: 2 });

  assert.equal(result.ok, true);
  assert.equal(result.count, 2);
  assert.equal(result.results?.length, 2);
  assert.equal(result.truncated, true);
});

test('workspace search returns root-qualified paths in a multi-root workspace', async (t) => {
  const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-search-first-'));
  const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'keepseek-search-second-'));
  t.after(async () => await fs.rm(firstRoot, { recursive: true, force: true }));
  t.after(async () => await fs.rm(secondRoot, { recursive: true, force: true }));
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  vscode.workspace.workspaceFolders = [
    { uri: vscode.Uri.file(firstRoot), name: 'first' },
    { uri: vscode.Uri.file(secondRoot), name: 'second' }
  ];
  await writeWorkspaceFile(firstRoot, 'same.ts', 'const sharedNeedle = 1;\n');
  await writeWorkspaceFile(secondRoot, 'same.ts', 'const sharedNeedle = 2;\n');

  const result = await search({ query: 'sharedNeedle' });

  assert.equal(result.ok, true);
  assertSearchMetadata(result);
  assert.deepEqual(
    result.results?.map((item) => item.path).sort(),
    ['first/same.ts', 'second/same.ts']
  );
  assert.equal(new Set(result.results?.map((item) => item.uri)).size, 2);
});

async function createWorkspace(t: TestContext, name: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `keepseek-search-${name}-`));
  t.after(async () => await fs.rm(root, { recursive: true, force: true }));
  t.after(() => { vscode.workspace.workspaceFolders = []; });
  vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(root), name }];
  return root;
}

async function writeWorkspaceFile(root: string, relativePath: string, content: string): Promise<void> {
  const filePath = path.join(root, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function search(
  input: WorkspaceSearchInput,
  options?: WorkspaceSearchExecutionOptions
): Promise<ParsedSearchResult> {
  return JSON.parse(await new WorkspaceToolService().searchWorkspace(input, 'en', options)) as ParsedSearchResult;
}

async function searchFailure(
  input: WorkspaceSearchInput,
  options?: WorkspaceSearchExecutionOptions
): Promise<ParsedSearchResult> {
  try {
    return await search(input, options);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function assertSearchMetadata(result: ParsedSearchResult): void {
  assert.ok(result.engine === 'vscode' || result.engine === 'fallback');
  assert.equal(typeof result.candidateFilesTruncated, 'boolean');
  assert.equal(typeof result.skippedFiles?.unreadable, 'number');
  assert.equal(typeof result.skippedFiles?.oversized, 'number');
  assert.equal(typeof result.skippedFiles?.unsupported, 'number');
}
