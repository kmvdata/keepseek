import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from './stubs/vscode';
import { SubagentStore } from '../src/agent/subagents/store';
import { SubagentRuntime } from '../src/agent/subagents/runtime';
import { MAX_CANONICAL_SUBAGENT_BYTES } from '../src/agent/subagents/resultIndex';
import type { StoredSubagentMetadata, SubagentInvocationContext } from '../src/agent/subagents/types';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const meta = (id: string, result: string): StoredSubagentMetadata => ({ version: 2, id, treeId: 'tree', parentSessionId: 'parent',
  parentRunId: 'run', rootRunId: 'run', depth: 1, profile: 'research', lane: 'research-read', task: 'Task', status: 'completed',
  resultStatus: 'complete', resultContractVersion: 2, resultFormatAccepted: true, sourceId: 'source', modelId: 'model', provider: 'deepseek',
  sourceConfigHash: hash('source'), systemPromptHash: hash('system'), toolSchemaHash: hash('tools'), profileHash: hash('profile'),
  projectInstructionsHash: hash('project'), normalizedTaskHash: hash('Task'), resultHash: hash(result), resultChars: result.length,
  resultBytes: Buffer.byteLength(result), createdAt: '', updatedAt: '' });
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-p1-reader-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'chat-sessions', 'v1', 'subagents', hash('workspace').slice(0, 24), 'parent');
  return { root, directory, store: new SubagentStore(vscode.Uri.file(root) as never, 'workspace') };
}
async function save(store: SubagentStore, metadata: StoredSubagentMetadata, result: string, privateSize = 0) {
  return store.save(metadata, { version: 2, metadataId: metadata.id, contextInstructions: 'private instructions',
    messages: [{ id: 'private', role: 'assistant', content: 'PRIVATE'.repeat(privateSize), createdAt: '' }], result });
}
test('P1 reader reads only result chunks and verifies every page without private transcript decoding', async t => {
  const { store, directory } = await fixture(t), result = '中文😀𐐷\\\"\n'.repeat(10_000);
  await save(store, meta('child', result), result, 100_000);
  const original = vscode.workspace.fs.readFile, reads: string[] = [];
  vscode.workspace.fs.readFile = async uri => { reads.push(uri.fsPath); return original(uri); };
  try {
    let offset = 0, reconstructed = '';
    do {
      const page = await store.readResultPage({ parentSessionId: 'parent', ref: 'child', allowedTreeId: 'tree', offsetBytes: offset, limitBytes: 5_003 });
      assert.equal(page.ok, true); assert.equal(page.resultStatus, 'complete'); assert.equal(page.formatAccepted, true);
      assert.equal(page.parentAcceptance, 'pending'); assert.equal(Buffer.byteLength(String(page.content)), page.returnedBytes);
      assert.ok(Number(page.returnedBytes) <= 5_003); assert.equal(String(page.content).includes('\ufffd'), false);
      reconstructed += page.content; offset += Number(page.returnedBytes);
      if (!page.hasMore) break;
      assert.equal(page.nextOffsetBytes, offset);
    } while (offset < Buffer.byteLength(result));
    assert.equal(reconstructed, result);
    assert.equal(reads.some(path => path.includes('.state.json.objects')), false);
    assert.ok(reads.every(path => path.endsWith('.state.json') || path.includes('result-objects')));
    const eof = await store.readResultPage({ parentSessionId: 'parent', ref: 'child', offsetBytes: offset });
    assert.equal(eof.content, ''); assert.equal(eof.hasMore, false);
    for (const offsetBytes of [-1, 1, 1.5, offset + 1]) assert.equal((await store.readResultPage({ parentSessionId: 'parent', ref: 'child', offsetBytes })).ok, false);
    const manifest = JSON.parse(await readFile(join(directory, 'child.state.json'), 'utf8'));
    const chunkPath = join(directory, 'result-objects', manifest.summary.resultIndex.canonical.chunks[0].hash + '.bin');
    const bytes = await readFile(chunkPath); bytes[0] ^= 1; await writeFile(chunkPath, bytes);
    assert.equal((await store.readResultPage({ parentSessionId: 'parent', ref: 'child' })).errorType, 'subagent_result_corrupt');
  } finally { vscode.workspace.fs.readFile = original; }
});
test('P1 result index corruption is authoritative and does not fall back to legacy records', async t => {
  const { store, directory } = await fixture(t), result = '完整😀';
  await save(store, meta('child', result), result);
  const path = join(directory, 'child.state.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(join(directory, 'child.run.json'), JSON.stringify({ metadata: meta('child', result), transcript: {
    version: 2, metadataId: 'child', contextInstructions: '', messages: [], result } }));
  manifest.summary.resultIndex.canonical.bytes++;
  manifest.summaryHash = hash(JSON.stringify(manifest.summary));
  await writeFile(path, JSON.stringify(manifest));
  assert.equal((await store.readResultPage({ parentSessionId: 'parent', ref: 'child' })).errorType, 'subagent_result_corrupt');
  assert.equal((await store.readResultPage({ parentSessionId: 'parent', ref: 'child', allowedTreeId: 'other' })).ok, false);
  assert.equal((await new SubagentStore(vscode.Uri.file(directory) as never, 'other-workspace').readResultPage({ parentSessionId: 'parent', ref: 'child' })).ok, false);
});
test('P1 parent acceptance verifies tail chunks and refuses missing or corrupt unread details', async t => {
  const { store, directory } = await fixture(t), result = 'a'.repeat(24_576) + 'b'.repeat(24_576) + 'tail';
  await save(store, meta('child', result), result, 100_000);
  const runtime = Object.assign(Object.create(SubagentRuntime.prototype), { store }) as SubagentRuntime;
  const context = { parentRequest: { sessionId: 'parent' }, parentRunId: 'run', language: 'en' } as SubagentInvocationContext;
  assert.equal((await store.verifyResult({ parentSessionId: 'parent', ref: 'child' }))?.resultStatus, 'complete');
  assert.equal((await runtime.inspectResult('child', context))?.resultStatus, 'complete');
  const manifest = JSON.parse(await readFile(join(directory, 'child.state.json'), 'utf8'));
  const chunks = manifest.summary.resultIndex.canonical.chunks;
  const tail = join(directory, 'result-objects', chunks[chunks.length - 1].hash + '.bin');
  await writeFile(tail, 'FAIL');
  assert.equal((await store.readResultPage({ parentSessionId: 'parent', ref: 'child', limitBytes: 4 })).ok, true);
  assert.equal(await store.verifyResult({ parentSessionId: 'parent', ref: 'child' }), undefined);
  assert.equal(await runtime.inspectResult('child', context), undefined);
  await rm(tail);
  assert.equal(await store.verifyResult({ parentSessionId: 'parent', ref: 'child' }), undefined);
});
test('P1 missing result indexes fail closed without decoding private objects', async t => {
  const { store, directory } = await fixture(t), result = '旧正文😀'.repeat(20_000);
  await save(store, meta('child', result), result, 100_000);
  const path = join(directory, 'child.state.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  delete manifest.summary.resultIndex; manifest.summaryHash = hash(JSON.stringify(manifest.summary));
  await writeFile(path, JSON.stringify(manifest));
  const original = vscode.workspace.fs.readFile, readBytes: number[] = [];
  vscode.workspace.fs.readFile = async uri => { const bytes = await original(uri); readBytes.push(bytes.length); return bytes; };
  try {
    const page = await store.readResultPage({ parentSessionId: 'parent', ref: 'child', limitBytes: 20 });
    assert.equal(page.ok, false); assert.equal(page.errorType, 'subagent_result_corrupt');
    assert.ok(Math.max(...readBytes) < 650_000, 'private message object should not be loaded');
  } finally { vscode.workspace.fs.readFile = original; }
});
test('P1 retired combined results are unavailable and never decoded', async t => {
  const { store, directory } = await fixture(t);
  await save(store, meta('bootstrap', ''), '');
  await writeFile(join(directory, 'old.run.json'), JSON.stringify({ metadata: meta('old', 'old'),
    transcript: { version: 1, metadataId: 'old', contextInstructions: '', messages: [], result: 'old' } }));
  assert.equal((await store.readResultPage({ parentSessionId: 'parent', ref: 'old' })).errorType, 'subagent_result_not_found');
  assert.equal(await store.read('parent', 'old'), undefined);
});
test('P1 canonical capacity and reuse-chain integrity fail closed, partial is readable with explicit status', async t => {
  const { store, directory } = await fixture(t), result = 'source complete';
  await assert.rejects(save(store, meta('huge', 'x'.repeat(MAX_CANONICAL_SUBAGENT_BYTES + 1)), 'x'.repeat(MAX_CANONICAL_SUBAGENT_BYTES + 1)), /capacity/u);
  await save(store, meta('source', result), result);
  const reused = { ...meta('reused', result), treeId: 'new-tree', parentRunId: 'new-run', rootRunId: 'new-run',
    reusedFromSubagentId: 'source', reusedFromParentRunId: 'run' };
  await store.save(reused, { version: 2, metadataId: 'reused', contextInstructions: '', messages: [], result: '', resultRef: 'source' });
  assert.equal((await store.readResultPage({ parentSessionId: 'parent', ref: 'reused', allowedTreeId: 'new-tree' })).content, result);
  const path = join(directory, 'reused.state.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
  manifest.summary.resultIndex.resultRef = 'reused'; manifest.summary.resultIndex.metadata.reusedFromSubagentId = 'reused';
  manifest.summaryHash = hash(JSON.stringify(manifest.summary)); await writeFile(path, JSON.stringify(manifest));
  assert.equal((await store.readResultPage({ parentSessionId: 'parent', ref: 'reused' })).errorType, 'subagent_result_corrupt');
  await save(store, { ...meta('partial', '{}'), resultStatus: 'partial', resultTruncated: true }, '{}');
  const partial = await store.readResultPage({ parentSessionId: 'parent', ref: 'partial' });
  assert.equal(partial.ok, true); assert.equal(partial.resultStatus, 'partial'); assert.equal(partial.formatAccepted, true);
  await save(store, { ...meta('failed', '{}'), status: 'failed', resultStatus: 'failed', resultFormatAccepted: false }, '{}');
  const rejected = await store.verifyResult({ parentSessionId: 'parent', ref: 'failed' });
  assert.equal(rejected?.resultStatus, 'failed'); assert.equal(rejected?.formatAccepted, false);
  await save(store, { ...meta('truncated', '{broken'), resultStatus: 'partial', resultTruncated: true }, '{broken');
  assert.equal((await store.readResultPage({ parentSessionId: 'parent', ref: 'truncated' })).resultStatus, 'partial');
});
