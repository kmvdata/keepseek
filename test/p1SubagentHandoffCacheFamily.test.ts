import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import {
  createParallelHandoff,
  createSubagentResultManifest,
  stableJson,
  utf8ByteLength
} from '../src/agent/subagents/handoff';
import { SubagentStore } from '../src/agent/subagents/store';
import type { StoredSubagentMetadata, SubagentResultManifestV2 } from '../src/agent/subagents/types';
import { prepareEvidenceEnvelope } from '../src/agent/evidence/shaping';
import type { ToolEvidence } from '../src/agent/evidence/types';
import {
  createProviderCacheObservation,
  createSubagentCacheFamilyKey
} from '../src/agent/cacheObservation';
import type { DeepSeekChatRequestBody } from '../src/agent/deepseek/types';
import {
  createUsageLedgerRecords,
  createUsagePriceSnapshot,
  normalizeUsageLedgerValue,
  summarizeCacheDiagnostics
} from '../src/agent/usageLedger';
import { getAgentTools, READ_SUBAGENT_RESULT_TOOL_NAME } from '../src/agent/protocol';

const HANDOFF_LIMIT = 12_288;

test('1KB, 120KB and 1MB child results produce the same bounded V2 handoff shape', () => {
  for (const size of [1_024, 120_000, 1_000_000]) {
    const result = `结论-${'x'.repeat(size)}`;
    const manifest = manifestFor(`sa_${size}`, result, 10_240, HANDOFF_LIMIT);
    const serialized = stableJson(manifest);
    assert.ok(utf8ByteLength(serialized) <= HANDOFF_LIMIT, `${size} byte result escaped handoff budget`);
    assert.equal(manifest.kind, 'subagent_result_manifest');
    assert.equal(manifest.resultRef, `sa_${size}`);
    assert.equal(Object.hasOwn(manifest, 'result'), false);
    assert.equal(Object.hasOwn(manifest, 'envelope'), false);
    assert.equal(Object.hasOwn(manifest, 'draftEdits'), false);
    assert.equal(Object.hasOwn(manifest, 'draftRuns'), false);
    assert.ok(manifest.summary.length <= 1_024);
    assert.ok(utf8ByteLength(manifest.preview) <= 10_240);
    assert.equal(manifest.hasMore, utf8ByteLength(result) > utf8ByteLength(manifest.preview));
  }
});

test('parallel handoff reserves every status/ref and fairly shares one 20KB preview budget', () => {
  const manifests = Array.from({ length: 8 }, (_, index) => manifestFor(
    `sa_${index}`,
    index === 0 ? 'A'.repeat(1_000_000) : `${index}`.repeat(120_000),
    10_240,
    HANDOFF_LIMIT,
    index === 6 ? false : true
  ));
  manifests[6] = { ...manifests[6]!, status: 'failed', errorType: 'provider_failure' };
  const serialized = createParallelHandoff({
    manifests,
    accepted: false,
    draftEditCount: 0,
    draftRunCount: 0,
    maxBytes: 20_480,
    errorType: 'subagent_parallel_child_failed',
    failedTasks: [7]
  });
  assert.ok(utf8ByteLength(serialized) <= 20_480);
  const parsed = JSON.parse(serialized) as { results: Array<Record<string, unknown>> };
  assert.equal(parsed.results.length, 8);
  assert.deepEqual(parsed.results.map((item) => item.resultRef), manifests.map((item) => item.resultRef));
  assert.equal(parsed.results[6]?.status, 'failed');
  const previewSizes = parsed.results.map((item) => utf8ByteLength(String(item.preview ?? ''))).filter(Boolean);
  assert.ok(previewSizes.length > 1);
  assert.ok(Math.max(...previewSizes) - Math.min(...previewSizes) <= 8,
    'equally large results receive deterministic fair preview shares');
});

test('subagent-specific evidence shaping preserves identity and both reference roles', () => {
  const manifest = manifestFor('sa_evidence', '正文'.repeat(20_000), 10_240, HANDOFF_LIMIT);
  const raw = stableJson(manifest);
  const shaped = prepareEvidenceEnvelope({
    record: evidenceRecord(raw),
    rawContent: raw,
    inlineTokenAllowance: 400,
    inlineCharLimit: 1_500
  });
  const value = JSON.parse(shaped.content) as Record<string, unknown>;
  for (const key of ['subagentId', 'treeId', 'profile', 'lane', 'depth', 'status', 'resultRef', 'resultHash',
    'resultChars', 'hasMore', 'draftEditCount', 'draftRunCount']) {
    assert.ok(Object.hasOwn(value, key), key);
  }
  assert.equal(value.resultRef, manifest.resultRef);
  assert.equal(value.evidenceRef, 'ev_handoff');
  assert.equal((value.referenceGuide as Record<string, unknown>).resultRef, 'pages the canonical full subagent result');
});

test('result reader uses UTF-8 byte pages and enforces session/tree/ref boundaries', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-p1-result-'));
  t.after(async () => { await rm(directory, { recursive: true, force: true }); });
  const store = new SubagentStore(vscode.Uri.file(directory), 'workspace-a');
  const result = `${'你'.repeat(5_000)}-done`;
  const metadata = storedMetadata('sa_page', result);
  await store.save(metadata, {
    version: 2,
    metadataId: metadata.id,
    contextInstructions: 'private',
    messages: [{ id: 'private', role: 'assistant', content: 'private transcript', createdAt: metadata.createdAt }],
    result
  });
  const first = await store.readResultPage({ parentSessionId: 'session-a', ref: 'sa_page', limitBytes: 12_288 });
  assert.equal(first.ok, true);
  assert.equal(first.offsetBytes, 0);
  assert.ok(Number(first.returnedBytes) <= 12_288);
  assert.equal(Buffer.from(String(first.content), 'utf8').byteLength, first.returnedBytes);
  assert.equal(String(first.content).includes('\ufffd'), false);
  assert.equal(first.hasMore, true);
  const second = await store.readResultPage({
    parentSessionId: 'session-a', ref: 'sa_page', offsetBytes: Number(first.nextOffsetBytes), limitBytes: 24_576
  });
  assert.equal(second.ok, true);
  assert.equal(`${first.content}${second.content}`, result);
  assert.equal(second.hasMore, false);
  assert.equal((await store.readResultPage({ parentSessionId: 'session-a', ref: 'sa_page', offsetBytes: 1 })).errorType,
    'subagent_result_invalid_utf8_offset');
  assert.equal((await store.readResultPage({ parentSessionId: 'session-a', ref: 'sa_page', offsetBytes: 99_999 })).errorType,
    'subagent_result_offset_out_of_range');
  assert.equal((await store.readResultPage({ parentSessionId: 'session-a', ref: 'sa_page', allowedTreeId: 'other-tree' })).errorType,
    'subagent_result_forbidden');
  assert.equal((await store.readResultPage({ parentSessionId: 'other-session', ref: 'sa_page' })).errorType,
    'subagent_result_not_found');
  assert.equal((await store.readResultPage({ parentSessionId: 'session-a', ref: 'sa_unknown' })).errorType,
    'subagent_result_not_found');
  assert.equal(JSON.stringify(first).includes('private transcript'), false);

  const pending = { ...storedMetadata('sa_pending', ''), status: 'running' as const, resultStatus: undefined };
  await store.save(pending, {
    version: 2, metadataId: pending.id, contextInstructions: '', messages: [], result: ''
  });
  assert.equal((await store.readResultPage({ parentSessionId: 'session-a', ref: pending.id })).errorType,
    'subagent_result_pending');

  const workspaceHash = createHash('sha256').update('workspace-a', 'utf8').digest('hex').slice(0, 24);
  const corruptId = 'sa_corrupt';
  const corruptUri = vscode.Uri.joinPath(vscode.Uri.file(directory), 'chat-sessions', 'v1', 'subagents', workspaceHash,
    'session-a', `${corruptId}.run.json`);
  await vscode.workspace.fs.writeFile(corruptUri, new TextEncoder().encode('{broken'));
  assert.equal((await store.readResultPage({ parentSessionId: 'session-a', ref: corruptId })).errorType,
    'subagent_result_corrupt');
});

test('V10 reader schema is byte-based while frozen V9 schema remains character-based', () => {
  const v9 = getAgentTools({ requestProtocolVersion: 9, toolNames: [READ_SUBAGENT_RESULT_TOOL_NAME] })
    .find((tool) => tool.function.name === READ_SUBAGENT_RESULT_TOOL_NAME)!;
  const v10 = getAgentTools({ requestProtocolVersion: 10, toolNames: [READ_SUBAGENT_RESULT_TOOL_NAME] })
    .find((tool) => tool.function.name === READ_SUBAGENT_RESULT_TOOL_NAME)!;
  assert.deepEqual(v9.function.parameters.required, ['subagentId']);
  assert.deepEqual(v10.function.parameters.required, ['ref']);
  assert.ok(Object.hasOwn(v10.function.parameters.properties, 'offsetBytes'));
  assert.equal(Object.hasOwn(v9.function.parameters.properties, 'offsetBytes'), false);
});

test('cache family excludes random ids/tasks and separates model, profile and permissions', () => {
  const common = {
    sourceId: 'source-a', provider: 'deepseek' as const, baseUrl: 'https://api.deepseek.com', modelId: 'model-a',
    profile: 'research', lane: 'research-read', depth: 1, personaVersion: 'subagent-system-v10',
    contextInstructionsHash: hash('context'), toolSchemaVersion: 10,
    toolNames: ['read', 'search'], authorizationContextHash: hash('auth'), workspaceContextHash: hash('workspace'),
    requestProtocolVersion: 10, capabilityBits: ['read-only']
  };
  const first = createSubagentCacheFamilyKey(common);
  const sibling = createSubagentCacheFamilyKey({ ...common });
  assert.equal(first, sibling);
  assert.notEqual(first, createSubagentCacheFamilyKey({ ...common, modelId: 'model-b' }));
  assert.notEqual(first, createSubagentCacheFamilyKey({ ...common, profile: 'review' }));
  assert.notEqual(first, createSubagentCacheFamilyKey({ ...common, toolNames: ['read'] }));
});

test('continued requests prefer strict conversation history while fresh siblings use family common prefix', () => {
  const family = hash('family');
  const first = cacheObservation('one', 'TASK ONE', family);
  const sibling = cacheObservation('two', 'A DIFFERENT TASK', family, undefined, [first]);
  assert.equal(sibling.prefixRelation, 'family_common_prefix');
  assert.equal(sibling.comparisonScope, 'family');
  assert.deepEqual(sibling.stablePrefix, first.stablePrefix,
    'task-specific bytes do not change the byte-level stable-prefix fingerprint');
  assert.notEqual(sibling.providerHistory.hash, first.providerHistory.hash,
    'different task tails remain visible outside the stable prefix');
  assert.ok(sibling.reusablePrefixTokensEstimate > 0);
  assert.equal(sibling.reason, 'family_common_prefix_preserved');
  const continued = cacheObservation('three', 'TASK ONE', family, first);
  assert.equal(continued.prefixRelation, 'strict_prefix');
  assert.equal(continued.comparisonScope, 'conversation');
  assert.notEqual(sibling.prefixRelation, 'strict_prefix');
});

test('cache metrics are token-weighted, keep unreported unknown, and split sources', () => {
  const snapshot = createUsagePriceSnapshot({
    originalModelId: 'model-a', sourceId: 'source-a', provider: 'deepseek', protocol: 'chat-completions', supportsBilling: false
  });
  const cold = cacheObservation('cold', 'cold', hash('cold-family'));
  const base = cacheObservation('base', 'base', hash('executor-family'));
  const executor = cacheObservation('executor', 'base', hash('executor-family'), base);
  const siblingBase = cacheObservation('sub-base', 'child one', hash('sub-family'));
  const sibling = cacheObservation('sub', 'child two', hash('sub-family'), undefined, [siblingBase]);
  const records = [
    ...createUsageLedgerRecords({ requestId: 'cold', attempts: [snapshot], usage: usage(100, 50, 'reported'), source: 'executor', cacheObservations: [cold] }),
    ...createUsageLedgerRecords({ requestId: 'executor', attempts: [snapshot], usage: usage(900, 0, 'reported'), source: 'executor', cacheObservations: [executor] }),
    ...createUsageLedgerRecords({ requestId: 'sub', attempts: [snapshot], usage: usage(500, 0, 'unavailable'), source: 'subagent', cacheObservations: [sibling] })
  ];
  const metrics = summarizeCacheDiagnostics(records);
  assert.equal(metrics.rawHitRate, 5, '50 / (100 + 900), not an average of request percentages');
  assert.equal(metrics.cacheDataMissingResponseCount, 1);
  assert.equal(metrics.bySource.some((item) => item.source === 'subagent' && item.cacheDataMissingResponseCount === 1), true);
  assert.equal(metrics.coldStartRequestCount, 1);
  assert.ok((metrics.unavoidableNewTokens ?? 0) > 0);
  const migrated = normalizeUsageLedgerValue({ version: 1, records: records.map((record) => ({
    ...record,
    cacheObservation: record.cacheObservation ? { ...record.cacheObservation, version: 1, stablePrefix: undefined,
      cacheFamilyKey: undefined, cacheFamilyId: undefined, prefixRelation: 'cold' } : undefined
  })), legacyAggregate: false, incomplete: false });
  assert.equal(migrated?.records.length, 3, 'old observation records remain loadable');
});

function manifestFor(
  id: string,
  result: string,
  previewBytes: number,
  maxBytes: number,
  ok = true
): SubagentResultManifestV2 {
  return createSubagentResultManifest({
    metadata: {
      id, treeId: 'tree-a', profile: 'research', lane: 'research-read', depth: 1,
      sourceId: 'source-a', modelId: 'model-a', resultHash: hash(result), resultChars: result.length,
      resultBytes: utf8ByteLength(result)
    },
    result,
    status: ok ? 'completed' : 'failed',
    ok,
    summary: 'summary '.repeat(500),
    usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12, cacheHitTokens: 0, cacheMissTokens: 10,
      cacheDataStatus: 'reported', requestCount: 2, cost: 0, currency: '', costByCurrency: {} },
    previewBytes,
    maxBytes,
    draftEditCount: 0,
    draftRunCount: 0
  });
}

function storedMetadata(id: string, result: string): StoredSubagentMetadata {
  return {
    version: 2, id, treeId: 'tree-a', parentSessionId: 'session-a', parentRunId: 'run-a', rootRunId: 'run-a',
    depth: 1, profile: 'research', lane: 'research-read', task: 'task', status: 'completed', resultStatus: 'complete',
    sourceId: 'source-a', modelId: 'model-a', provider: 'deepseek', sourceConfigHash: hash('source'),
    systemPromptHash: hash('system'), toolSchemaHash: hash('tools'), profileHash: hash('profile'),
    projectInstructionsHash: hash('project'), resultHash: hash(result), resultChars: result.length,
    resultBytes: utf8ByteLength(result), createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z', completedAt: '2026-01-01T00:01:00.000Z'
  };
}

function evidenceRecord(raw: string): ToolEvidence {
  return {
    version: 1, id: 'e', evidenceRef: 'ev_handoff', sessionId: 'session-a', taskId: 'task-a', toolCallId: 'call-a',
    toolName: 'keepseek_delegate_task', argumentsHash: hash('args'), effectKind: 'delegation', executionStatus: 'completed',
    deliveryStatus: 'pending', contentHash: hash(raw), contentType: 'structured', totalChars: raw.length,
    totalBytes: utf8ByteLength(raw), totalTokensEstimate: Math.ceil(raw.length / 4),
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z'
  };
}

function cacheObservation(
  requestId: string,
  task: string,
  family: string,
  conversationPrevious?: ReturnType<typeof createProviderCacheObservation>,
  familyCandidates: ReturnType<typeof createProviderCacheObservation>[] = []
) {
  const history: DeepSeekChatRequestBody['messages'] = [
    { role: 'system', content: `SYSTEM-${'s'.repeat(8_000)}` },
    { role: 'system', content: 'PROJECT' },
    ...(conversationPrevious ? [
      { role: 'user' as const, content: 'TASK ONE' },
      { role: 'assistant' as const, content: 'prior answer' }
    ] : []),
    { role: 'user', content: task }
  ];
  return createProviderCacheObservation({
    requestId, attemptIndex: 0, source: 'subagent', sourceId: 'source-a', provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com', body: {
      model: 'model-a', messages: history, tools: [{ type: 'function', function: {
        name: 'read', description: 'read', parameters: { type: 'object', properties: {}, additionalProperties: false }
      } }], tool_choice: 'auto', stream: true, stream_options: { include_usage: true }
    },
    contextInstructions: 'PROJECT', requestProtocolVersion: 10, estimatedPromptTokens: 5_000,
    cacheFamilyKey: family, subagentProfile: 'research', subagentLane: 'research-read', subagentDepth: 1,
    conversationPrevious, familyCandidates
  });
}

function usage(promptTokens: number, cacheHitTokens: number, status: 'reported' | 'unavailable') {
  return {
    promptTokens, completionTokens: 10, totalTokens: promptTokens + 10, cacheHitTokens,
    cacheMissTokens: status === 'reported' ? promptTokens - cacheHitTokens : 0, cacheDataStatus: status
  } as const;
}

function hash(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }
