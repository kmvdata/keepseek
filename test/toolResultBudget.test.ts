import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentRunner } from '../src/agent/runner';
import { createContextEpochState, createEpochHostCheckpoint, createEpochSeed, createHostFallbackSummary, createWorkFingerprint, observeNoProgress } from '../src/agent/contextEpoch';
import { ContextWindowCalibrationStore } from '../src/agent/contextWindowCalibrationStore';
import { prepareEvidenceEnvelope } from '../src/agent/evidence/shaping';
import { ToolEvidencePersistenceError, ToolEvidenceStore } from '../src/agent/evidence/store';
import { getAgentTools, READ_EVIDENCE_TOOL_NAME } from '../src/agent/protocol';
import { AgentInterruptedError, checkpointCopy, createRunCheckpoint, migrateLegacyCapacityCheckpoint, recoveryBlocker, type RunCheckpoint } from '../src/agent/runCheckpoint';
import { isContextTooLongError, ToolResultAdmissionController } from '../src/agent/toolResultAdmission';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import { getScript } from '../src/webview/script';
import * as vscode from './stubs/vscode';
import type { AgentRequest, TaskPlan } from '../src/shared/types';
import {
  DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS,
  getAgentRuntimeProfile
} from '../src/shared/modelProfiles';
import { DEEPSEEK_MODEL_IDENTITY_VERSION } from '../src/shared/deepSeekModels';

const LARGE_ASCII = 'const value = 1; // evidence\n'.repeat(8_000);
const LARGE_CJK = '这是不可变的工具证据。\n'.repeat(12_000);

test('tool evidence persists intent, immutable bytes, envelope and delivery phases', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-evidence-'));
  const uri = vscode.Uri.file(root) as unknown as import('vscode').Uri;
  const first = new ToolEvidenceStore(uri, 30_000_000);
  let record = await first.ensureIntent(intent('call-1'));
  assert.equal(record.executionStatus, 'pending');
  record = await first.markExecuting(record);
  assert.equal(record.executionStatus, 'executing');
  record = await first.complete(record, LARGE_CJK);
  assert.equal(record.executionStatus, 'completed');
  assert.equal(record.totalBytes, Buffer.byteLength(LARGE_CJK));
  let duplicate = await first.ensureIntent(intent('call-duplicate'));
  duplicate = await first.complete(duplicate, LARGE_CJK);
  assert.equal(duplicate.blobName, record.blobName, 'content-addressed blobs deduplicate identical evidence in one task');

  const shaped = prepareEvidenceEnvelope({ record, rawContent: LARGE_CJK, inlineTokenAllowance: 900, inlineCharLimit: 4_000 });
  const envelope = JSON.parse(shaped.content) as { evidenceRef: string; completeInline: boolean; read: { tool: string } };
  assert.equal(shaped.completeInline, false);
  assert.equal(envelope.evidenceRef, record.evidenceRef);
  assert.equal(envelope.completeInline, false);
  assert.equal(envelope.read.tool, READ_EVIDENCE_TOOL_NAME);
  record = await first.saveProviderEnvelope(record, shaped.content, false);
  record = await first.markSending(record);

  const recovered = new ToolEvidenceStore(uri, 30_000_000);
  const same = await recovered.findByToolCall('session-a', 'task-a', 'call-1');
  assert.equal(same?.providerEnvelope, shaped.content, 'provider-visible bytes survive restart exactly');
  assert.equal(same?.deliveryStatus, 'sending');
  const delivered = await recovered.markDelivered(same!);
  assert.equal(delivered.deliveryStatus, 'delivered');
  assert.equal(await recovered.readContent(delivered), LARGE_CJK);
  const recoveredMisaligned = await recovered.read({
    sessionId: 'session-a', taskId: 'task-a', evidenceRef: delivered.evidenceRef, cursor: 'b:1', maxChars: 32
  });
  assert.equal(recoveredMisaligned.cursor, 'b:3');
  assert.ok(String(recoveredMisaligned.content).startsWith('是'));
  await assert.rejects(() => recovered.saveProviderEnvelope(delivered, shaped.content + ' ', false), /immutable/u);
  await recovered.deleteSessionEvidence('session-a');
  assert.equal(await new ToolEvidenceStore(uri, 30_000_000).findByRef(delivered.evidenceRef, 'session-a', 'task-a'), undefined);

  const limited = new ToolEvidenceStore(undefined, 16);
  const limitedIntent = await limited.ensureIntent(intent('limited'));
  await assert.rejects(() => limited.complete(limitedIntent, 'too large for evidence storage'),
    (error: unknown) => error instanceof ToolEvidencePersistenceError && error.reason === 'resource_limit');
});

test('20MB evidence is externalized and supports bounded byte, line, item and search reads', async () => {
  const store = new ToolEvidenceStore(undefined, 25_000_000);
  let record = await store.ensureIntent(intent('twenty-megabytes'));
  const twentyMb = '0123456789abcdef\n'.repeat(Math.ceil(20_000_000 / 17)).slice(0, 20_000_000);
  record = await store.complete(record, twentyMb);
  assert.equal(record.totalBytes, 20_000_000);
  const firstPage = await store.read({ sessionId: 'session-a', taskId: 'task-a', evidenceRef: record.evidenceRef, maxChars: 1_024 });
  assert.equal((firstPage.content as string).length, 1_024);
  assert.equal(firstPage.hasMore, true);
  assert.match(String(firstPage.nextCursor), /^b:\d+$/u);
  const secondPage = await store.read({ sessionId: 'session-a', taskId: 'task-a', evidenceRef: record.evidenceRef,
    cursor: String(firstPage.nextCursor), maxChars: 1_024 });
  assert.notEqual(secondPage.content, '');
  const lines = await store.read({ sessionId: 'session-a', taskId: 'task-a', evidenceRef: record.evidenceRef,
    startLine: 2, endLine: 4, maxChars: 1_024 });
  assert.equal(lines.startLine, 2);
  assert.equal(lines.endLine, 4);
  const found = await store.read({ sessionId: 'session-a', taskId: 'task-a', evidenceRef: record.evidenceRef,
    search: 'abcdef', maxChars: 1_024 });
  assert.ok((found.matches as unknown[]).length > 0);
  assert.equal(found.hasMore, true);
  assert.match(String(found.nextCursor), /^s:\d+$/u);
  const moreFound = await store.read({ sessionId: 'session-a', taskId: 'task-a', evidenceRef: record.evidenceRef,
    search: 'abcdef', cursor: String(found.nextCursor), maxChars: 1_024 });
  assert.ok((moreFound.matches as unknown[]).length > 0);
  const denied = await store.read({ sessionId: 'another-session', taskId: 'task-a', evidenceRef: record.evidenceRef });
  assert.equal(denied.errorType, 'evidence_not_found');

  let structured = await store.ensureIntent(intent('items'));
  structured = await store.complete(structured, JSON.stringify({ ok: true, results: Array.from({ length: 5_000 }, (_, id) => ({ id, path: `src/${id}.ts` })) }));
  const items = await store.read({ sessionId: 'session-a', taskId: 'task-a', evidenceRef: structured.evidenceRef,
    itemOffset: 125, itemLimit: 20, maxChars: 8_000 });
  assert.equal(items.itemOffset, 125);
  assert.equal((items.items as Array<{ id: number }>)[0].id, 125);
  assert.equal(items.nextItemOffset, 145);

  let rangedFile = await store.ensureIntent(intent('ranged-file'));
  rangedFile = await store.complete(rangedFile, JSON.stringify({
    ok: true, path: 'src/ranged.ts', startLine: 40, endLine: 42, content: 'alpha\nbeta\ngamma\n'
  }));
  const rangedLines = await store.read({ sessionId: 'session-a', taskId: 'task-a', evidenceRef: rangedFile.evidenceRef,
    startLine: 41, endLine: 42, maxChars: 1_024 });
  assert.equal(rangedLines.field, 'content');
  assert.equal(rangedLines.startLine, 41);
  assert.equal(rangedLines.content, 'beta\ngamma\n');
  const rangedSearch = await store.read({ sessionId: 'session-a', taskId: 'task-a', evidenceRef: rangedFile.evidenceRef,
    search: 'gamma', maxChars: 1_024 });
  assert.equal((rangedSearch.matches as Array<{ line: number }>)[0].line, 42);

  let unicode = await store.ensureIntent(intent('unicode-cursor'));
  const unicodeText = '🙂中文-a\n🙂中文-b\n🙂中文-c';
  unicode = await store.complete(unicode, unicodeText);
  const pages: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await store.read({ sessionId: 'session-a', taskId: 'task-a', evidenceRef: unicode.evidenceRef,
      ...(cursor ? { cursor } : {}), maxChars: 7 });
    pages.push(String(page.content));
    cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
  } while (cursor);
  assert.equal(pages.join(''), unicodeText, 'UTF-8 cursors never split or skip surrogate pairs');
  const normalizedCursor = await store.read({
    sessionId: 'session-a', taskId: 'task-a', evidenceRef: unicode.evidenceRef, cursor: 'b:1', maxChars: 7
  });
  assert.equal(normalizedCursor.cursor, 'b:4', 'a caller cursor inside an emoji advances to the next UTF-8 boundary');
  assert.ok(String(normalizedCursor.content).startsWith('中'));
  assert.notEqual(normalizedCursor.nextCursor, 'b:1');
});

test('dynamic admission is request-relative and context capacity self-calibrates', () => {
  for (const declared of [32_000, 1_000_000]) {
    const admission = new ToolResultAdmissionController(declared);
    const early = admission.decide({ estimatedInputTokens: 4_000, configuredMaxOutputTokens: 64_000, phase: 'tool', remainingBatchResults: 3 });
    assert.equal(early.learnedEffectiveWindowTokens, declared);
    assert.ok(early.inlineTokenAllowance > 0);
    admission.observe(10_000, 12_000);
    assert.ok(admission.state.estimatorScale >= 1.2);
    admission.recordContextTooLong(20_000);
    assert.ok(admission.state.learnedEffectiveWindowTokens < declared);
    const pressured = admission.decide({ estimatedInputTokens: 30_000, configuredMaxOutputTokens: 8_000, phase: 'tool', remainingBatchResults: 4 });
    if (declared === 32_000) assert.equal(pressured.shouldRollover, true);
    admission.recordSuccessfulRequest();
    assert.equal(admission.state.contextTooLongCount, 0);
    assert.equal('toolResultTokenBudget' in admission.state, false);
  }
  assert.equal(isContextTooLongError(new Error('context_length_exceeded: prompt is too long')), true);
  assert.equal(isContextTooLongError(new Error('401 unauthorized')), false);
});

test('minimum evidence envelopes remain valid inside the batch reservation', async () => {
  const store = new ToolEvidenceStore();
  let record = await store.ensureIntent(intent('minimum-envelope'));
  const raw = JSON.stringify({ ok: false, path: 'very/'.repeat(1_000), errorType: 'large_diagnostic',
    error: 'detail '.repeat(2_000), diagnostics: Array.from({ length: 2_000 }, (_, index) => ({ index, message: 'failure' })) });
  record = await store.complete(record, raw);
  const shaped = prepareEvidenceEnvelope({ record, rawContent: raw, inlineTokenAllowance: 0, inlineCharLimit: 1_024 });
  const parsed = JSON.parse(shaped.content) as {
    completeInline: boolean; evidenceRef: string; contentHash: string; errorType: string; read: { tool: string }
  };
  assert.equal(parsed.completeInline, false);
  assert.equal(parsed.evidenceRef, record.evidenceRef);
  assert.equal(parsed.contentHash, record.contentHash);
  assert.equal(parsed.errorType, 'large_diagnostic');
  assert.equal(parsed.read.tool, READ_EVIDENCE_TOOL_NAME);
  assert.ok(shaped.inlineTokens <= 320);
  assert.ok(shaped.content.length <= 1_024);

  let proposal = await store.ensureIntent(intent('authoritative-proposal'));
  proposal = await store.complete(proposal, JSON.stringify({ ok: true, draftRun: {
    id: 'draft-run-1', status: 'pending', specHash: 'spec-hash', executable: 'bun',
    args: Array.from({ length: 5_000 }, () => 'large-argument'), env: Array.from({ length: 500 }, () => ({ name: 'A', value: 'B' }))
  } }));
  const proposalEnvelope = JSON.parse(prepareEvidenceEnvelope({
    record: proposal, rawContent: await store.readContent(proposal), inlineTokenAllowance: 0, inlineCharLimit: 1_024
  }).content) as { draftRun: { id: string; status: string; specHash: string }; completeInline: boolean };
  assert.deepEqual(proposalEnvelope.draftRun, {
    id: 'draft-run-1', status: 'pending', specHash: 'spec-hash', executable: 'bun', argCount: 5_000, envCount: 500
  });
  assert.equal(proposalEnvelope.completeInline, false);
});

test('large diff, patch, log and structured-result envelopes keep legal continuation boundaries', async () => {
  const store = new ToolEvidenceStore(undefined, 30_000_000);
  for (const [index, toolName] of ['keepseek_git_diff', 'keepseek_git_create_patch'].entries()) {
    let record = await store.ensureIntent({ ...intent(`line-result-${index}`), toolName });
    const raw = JSON.stringify({ ok: true, path: 'src/large.ts', startLine: 120,
      diff: Array.from({ length: 12_000 }, (_, line) => `+line ${line}\n`).join('') });
    record = await store.complete(record, raw);
    const envelope = JSON.parse(prepareEvidenceEnvelope({
      record, rawContent: raw, inlineTokenAllowance: 12_000, inlineCharLimit: 20_000
    }).content) as { completeInline: boolean; contentType: string; inlineContent: string; inlineStartLine: number;
      inlineEndLine: number; nextStartLine: number; evidenceRef: string };
    assert.equal(envelope.completeInline, false);
    assert.equal(envelope.contentType, 'diff');
    assert.equal(envelope.inlineStartLine, 120);
    assert.ok(envelope.inlineContent.endsWith('\n'), `${toolName} stops after a complete line`);
    assert.equal(envelope.nextStartLine, envelope.inlineEndLine + 1);
    assert.equal(envelope.evidenceRef, record.evidenceRef);
  }

  let logRecord = await store.ensureIntent({ ...intent('large-log'), toolName: 'keepseek_run_validation' });
  const rawLog = JSON.stringify({ ok: false, script: 'test', startLine: 1,
    output: Array.from({ length: 12_000 }, (_, line) => `diagnostic ${line}\n`).join('') });
  logRecord = await store.complete(logRecord, rawLog);
  const logEnvelope = JSON.parse(prepareEvidenceEnvelope({
    record: logRecord, rawContent: rawLog, inlineTokenAllowance: 12_000, inlineCharLimit: 20_000
  }).content) as { completeInline: boolean; field: string; inlineContent: string; nextStartLine: number };
  assert.equal(logEnvelope.completeInline, false);
  assert.equal(logEnvelope.field, 'output');
  assert.ok(logEnvelope.inlineContent.endsWith('\n'));
  assert.ok(logEnvelope.nextStartLine > 1);

  for (const [index, toolName] of [
    'keepseek_search_workspace',
    'keepseek_get_workspace_symbols',
    'keepseek_read_workspace_diagnostics',
    'keepseek_list_workspace_directory'
  ].entries()) {
    let record = await store.ensureIntent({ ...intent(`item-result-${index}`), toolName });
    const raw = JSON.stringify({ ok: true, results: Array.from({ length: 8_000 }, (_, item) => ({
      id: item, path: `src/${item}.ts`, line: item + 1, message: `item-${item}`
    })) });
    record = await store.complete(record, raw);
    const serialized = prepareEvidenceEnvelope({
      record, rawContent: raw, inlineTokenAllowance: 3_000, inlineCharLimit: 8_000
    }).content;
    const envelope = JSON.parse(serialized) as { completeInline: boolean; inlineItems: unknown[]; totalItems: number; itemKey: string };
    assert.equal(envelope.completeInline, false);
    assert.equal(envelope.itemKey, 'results');
    assert.ok(envelope.inlineItems.length > 0 && envelope.inlineItems.length < envelope.totalItems,
      `${toolName} pages whole structured items`);
    assert.equal(envelope.totalItems, 8_000);
    assert.equal(JSON.stringify(JSON.parse(serialized)), serialized, `${toolName} envelope is canonical valid JSON`);
  }
});

test('generic, metadata-backed 1M, and built-in DeepSeek profiles have no fixed result budget', () => {
  for (const model of [
    { id: 'generic-32k', label: 'Generic', provider: 'openai-compatible' as const, contextWindowTokens: 32_000 },
    { id: 'compatible-1m', label: 'Compatible', provider: 'openai-compatible' as const, contextWindowTokens: 1_000_000 },
    { id: 'deepseek-v4-flash', label: 'Flash', provider: 'deepseek' as const },
    { id: 'deepseek-v4-pro', label: 'Pro', provider: 'deepseek' as const }
  ]) {
    const profile = getAgentRuntimeProfile(model, { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' });
    assert.equal('toolResultTokenBudget' in profile, false, model.id);
    assert.equal(
      profile.contextWindowTokens,
      model.contextWindowTokens ?? DEEPSEEK_V4_CONTEXT_WINDOW_TOKENS
    );
  }
});

test('learned effective windows persist by exact source, provider, endpoint and model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-calibration-'));
  const store = new ContextWindowCalibrationStore(vscode.Uri.file(root) as unknown as import('vscode').Uri);
  const key = { sourceId: 'gateway', provider: 'openai-compatible' as const, modelId: 'model', endpointHash: 'endpoint-a' };
  const controller = new ToolResultAdmissionController(1_000_000);
  controller.recordContextTooLong(90_000);
  await store.save(key, controller.state);
  assert.deepEqual(await new ContextWindowCalibrationStore(vscode.Uri.file(root) as unknown as import('vscode').Uri).load(key), controller.state);
  assert.equal(await store.load({ ...key, endpointHash: 'endpoint-b' }), undefined);
});

test('v1 calibration migration is canonical, atomic and retryable after a failed v2 write', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-calibration-v1-'));
  const storage = vscode.Uri.file(root) as unknown as import('vscode').Uri;
  const store = new ContextWindowCalibrationStore(storage);
  const key = {
    sourceId: 'official',
    provider: 'deepseek' as const,
    modelId: 'deepseek-flash',
    canonicalModelId: 'deepseek-v4-flash',
    endpointHash: 'official-endpoint'
  };
  const v1Hash = createHash('sha256').update(JSON.stringify([
    key.provider, key.sourceId, key.modelId, key.endpointHash
  ]), 'utf8').digest('hex');
  const v1Directory = vscode.Uri.joinPath(storage, 'model-calibration', 'v1');
  const v1Uri = vscode.Uri.joinPath(v1Directory, `${v1Hash}.json`);
  await vscode.workspace.fs.createDirectory(v1Directory);
  await vscode.workspace.fs.writeFile(v1Uri, new TextEncoder().encode(JSON.stringify({
    version: 1,
    keyHash: v1Hash,
    state: {
      declaredWindowTokens: 32_768,
      learnedEffectiveWindowTokens: 32_768,
      estimatorScale: 1.31,
      observations: 4,
      contextTooLongCount: 0
    },
    updatedAt: '2026-01-01T00:00:00.000Z'
  })));

  const originalRename = vscode.workspace.fs.rename;
  vscode.workspace.fs.rename = async (source, target, options) => {
    if (target.fsPath.includes('/model-calibration/v2/')) throw new Error('simulated atomic migration failure');
    await originalRename(source, target, options);
  };
  t.after(() => { vscode.workspace.fs.rename = originalRename; });
  const declaration = {
    identity: 'deepseek-v4-flash',
    version: 'deepseek-model-identity-v1:1048576',
    declaredWindowTokens: 1_048_576
  };
  const inMemory = await store.load(key, declaration);
  assert.equal(inMemory?.learnedEffectiveWindowTokens, 1_048_576);
  assert.equal(inMemory?.estimatorScale, 1.31);
  assert.ok((await vscode.workspace.fs.readFile(v1Uri)).byteLength > 0, 'failed migration preserves v1 source');

  vscode.workspace.fs.rename = originalRename;
  const retried = await store.load({ ...key, modelId: 'deepseek-v4.1-flash' }, declaration);
  assert.equal(retried, undefined, 'v1 lookup remains tied to the original wire alias until migration succeeds');
  const migrated = await store.load(key, declaration);
  assert.equal(migrated?.learnedEffectiveWindowTokens, 1_048_576);
  assert.deepEqual(
    await store.load({ ...key, modelId: 'deepseek-v4.1-flash' }, declaration),
    migrated,
    'v2 calibration is shared by canonical model identity'
  );
});

test('epoch seed is canonical and no-progress detection survives rollovers', () => {
  const state = createContextEpochState(new ToolResultAdmissionController(32_000).state);
  const plan = planFixture();
  const options = {
    originalTask: 'Complete this exact task.', semanticSummary: 'One read completed.', taskPlan: plan,
    draftEdits: [], draftRuns: [], repairLoop: { status: 'idle' as const, iteration: 0, maxIterations: 2, pendingDraftEditIds: [] as string[] },
    evidenceRefs: [{ evidenceRef: 'ev_ref', contentHash: 'hash', toolName: 'keepseek_read_workspace_file', toolCallId: 'call' }],
    idempotency: [], failures: [], nextStep: 'Use the evidence.'
  };
  const seed = createEpochSeed(options);
  assert.equal(createEpochSeed(structuredClone(options)), seed);
  const parsed = JSON.parse(seed) as { originalTask: string; protocolVersion: number; hostState: { evidence: unknown[] } };
  assert.equal(parsed.protocolVersion, 8);
  assert.equal(parsed.originalTask, options.originalTask);
  assert.equal(parsed.hostState.evidence.length, 1);
  assert.match(createHostFallbackSummary({ plan, evidenceRefs: options.evidenceRefs, failures: ['summary timeout'] }), /summary timeout/u);

  const manyEvidence = Array.from({ length: 500 }, (_, index) => ({
    evidenceRef: `ev_${index}.cap`, contentHash: `hash-${index}`,
    toolName: 'keepseek_read_workspace_file', toolCallId: `call-${index}`
  }));
  const fullHostCheckpoint = createEpochHostCheckpoint({ ...options, evidenceRefs: manyEvidence });
  assert.equal(createEpochHostCheckpoint({ ...options, evidenceRefs: structuredClone(manyEvidence) }), fullHostCheckpoint);
  assert.equal((JSON.parse(fullHostCheckpoint) as { evidence: unknown[] }).evidence.length, 500);
  const compactSeed = createEpochSeed({
    ...options,
    evidenceRefs: manyEvidence,
    checkpointEvidence: { evidenceRef: 'ev_manifest.cap', contentHash: 'manifest-hash', totalChars: fullHostCheckpoint.length, totalBytes: fullHostCheckpoint.length }
  });
  const compact = JSON.parse(compactSeed) as { hostState: { evidence: unknown[]; evidenceCount: number; evidenceIndex: { evidenceRef: string } } };
  assert.equal(compact.hostState.evidence.length, 24);
  assert.equal(compact.hostState.evidenceCount, 500);
  assert.equal(compact.hostState.evidenceIndex.evidenceRef, 'ev_manifest.cap');
  assert.ok(compactSeed.length < fullHostCheckpoint.length / 3, 'provider seed stays bounded while full host authority is externalized');

  const work = createWorkFingerprint({ toolName: 'read', argumentsHash: 'a', resultHash: 'r', planProgressHash: 'p' });
  const initial = observeNoProgress(state.noProgress, work.fingerprint);
  const warned = observeNoProgress(initial.state, work.fingerprint);
  const stopped = observeNoProgress(warned.state, work.fingerprint);
  assert.equal(initial.action, 'none');
  assert.equal(warned.action, 'warn');
  assert.equal(stopped.action, 'stop');
});

test('protocol v8 freezes the evidence tool while v7 stays unchanged', () => {
  const v7a = JSON.stringify(getAgentTools({ requestProtocolVersion: 7 }));
  const v7b = JSON.stringify(getAgentTools({ requestProtocolVersion: 7 }));
  const v8a = getAgentTools({ requestProtocolVersion: 8 });
  const v8b = getAgentTools({ requestProtocolVersion: 8 });
  assert.equal(v7a, v7b);
  assert.equal(JSON.stringify(v8a), JSON.stringify(v8b));
  assert.equal(JSON.parse(v7a).some((tool: { function: { name: string } }) => tool.function.name === READ_EVIDENCE_TOOL_NAME), false);
  assert.equal(v8a.some((tool) => tool.function.name === READ_EVIDENCE_TOOL_NAME), true);
  assert.equal(v8a.find((tool) => tool.function.name === 'keepseek_read_subagent_result')?.function.description.includes('Legacy migration bridge'), true);
  assert.deepEqual(v8a.map((tool) => tool.function.name), [...v8a.map((tool) => tool.function.name)].sort());
});

test('large results complete in one logical task for all three provider protocols', async () => {
  for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as const) {
    const result = await runLargeResult(provider);
    assert.equal(result.response.message, 'Done.');
    assert.equal(result.response.runDetails.budgetStopReason, undefined);
    assert.equal(result.checkpoint.status, 'completed');
    assert.equal(result.readCount, 1);
    assert.equal(result.bodies.length, 2);
    const toolResult = result.response.toolRounds![0].toolResults[0].content;
    const envelope = JSON.parse(toolResult) as { completeInline: boolean; evidenceRef: string; totalChars: number };
    assert.equal(envelope.completeInline, false);
    assert.ok(envelope.evidenceRef);
    assert.equal(envelope.totalChars, JSON.stringify({ ok: true, path: 'large.ts', content: LARGE_ASCII }).length);
    assert.ok(result.bodies[1].includes(JSON.stringify(toolResult)), `${provider} sends persisted envelope bytes`);
    const first = JSON.parse(result.bodies[0]);
    const second = JSON.parse(result.bodies[1]);
    assert.deepEqual(second.tools, first.tools, `${provider} freezes the v8 schema`);
    if (provider === 'openai-responses') assert.deepEqual(second.input.slice(0, first.input.length), first.input);
    else if (provider === 'anthropic-compatible') {
      assert.deepEqual(second.system, first.system);
      assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    } else assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
    assert.equal(second.tools.some((tool: { name?: string; function?: { name?: string } }) =>
      tool.name === READ_EVIDENCE_TOOL_NAME || tool.function?.name === READ_EVIDENCE_TOOL_NAME), true);
  }
});

test('tool round thresholds roll over internally without a synthetic visible turn', async () => {
  const workspace = new WorkspaceToolService();
  let reads = 0;
  workspace.readWorkspaceFile = async () => { reads += 1; return JSON.stringify({ ok: true, path: 'a.ts', content: LARGE_ASCII }); };
  const bodies: string[] = [];
  let checkpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = String(init?.body);
    bodies.push(body);
    if (body.includes('Create a concise semantic checkpoint')) return modelResponse('openai-compatible', undefined, 'Read completed; evidence retained.');
    return bodies.length === 1
      ? modelResponse('openai-compatible', { id: 'read-once', name: 'keepseek_read_workspace_file', args: '{"path":"a.ts"}' })
      : modelResponse('openai-compatible');
  }) as typeof fetch;
  try {
    const input = request('openai-compatible');
    input.executionLimits = { maxToolIterations: 1 };
    const response = await new AgentRunner(workspace).run(input, { onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); } });
    assert.equal(response.message, 'Done.');
    assert.equal(reads, 1);
    assert.equal(checkpoint.request.approvalRootTaskId ?? checkpoint.taskId, checkpoint.taskId);
    assert.equal(checkpoint.state?.epoch?.totalRollovers, 1);
    assert.equal(response.runDetails.contextEpochs?.length, 1);
    assert.equal(input.history.length, 0);
    assert.ok(bodies.some((body) => body.includes('keepseek_context_epoch_checkpoint')));
    const first = JSON.parse(bodies[0]);
    const nextEpoch = JSON.parse(bodies.at(-1)!);
    assert.deepEqual(nextEpoch.tools, first.tools);
    assert.deepEqual(nextEpoch.messages.slice(0, first.messages.length), first.messages,
      'rollover reuses the stable system/session/original-user prefix');
    assert.equal(bodies.some((body) => body.includes('budget_auto_continue')), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('a hot v7 lane migrates only after its first externalized result and then exposes evidence paging', async () => {
  const workspace = new WorkspaceToolService();
  let reads = 0;
  workspace.readWorkspaceFile = async () => { reads += 1; return JSON.stringify({ ok: true, path: 'legacy.ts', content: LARGE_ASCII }); };
  const bodies: Array<Record<string, unknown>> = [];
  const migrations: Array<{ version: number; toolSchemaVersion: number; toolNames: string[] }> = [];
  const visibleDeltas: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    if (JSON.stringify(body).includes('Create a concise semantic checkpoint')) {
      return modelResponse('openai-compatible', undefined, 'internal summary');
    }
    return bodies.length === 1
      ? modelResponse('openai-compatible', { id: 'legacy-read', name: 'keepseek_read_workspace_file', args: '{"path":"legacy.ts"}' })
      : modelResponse('openai-compatible');
  }) as typeof fetch;
  try {
    const input = request('openai-compatible');
    input.requestProtocolVersion = 7;
    const response = await new AgentRunner(workspace).run(input, {
      onProtocolMigration: async (protocol) => { migrations.push(protocol); },
      onDelta: (event) => { if (event.type === 'content') visibleDeltas.push(event.delta); }
    });
    assert.equal(response.message, 'Done.');
    assert.equal(reads, 1);
    assert.equal(bodies.length, 3);
    assert.equal(hasEvidenceTool(bodies[0]), false);
    assert.equal(hasEvidenceTool(bodies[1]), false);
    assert.equal(hasEvidenceTool(bodies[2]), true);
    assert.equal(JSON.stringify(bodies[2]).includes('keepseek_context_epoch_checkpoint'), true);
    assert.equal(visibleDeltas.join(''), 'Done.', 'hidden epoch summaries never enter the transcript');
    assert.equal(migrations.length, 1);
    assert.equal(migrations[0].version, 8);
  } finally { globalThis.fetch = originalFetch; }
});

test('provider context metadata errors downshift the learned window and rebuild the same task', async () => {
  const bodies: string[] = [];
  let checkpoint!: RunCheckpoint;
  const taskIds = new Set<string>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = String(init?.body);
    bodies.push(body);
    if (bodies.length === 1) return new Response(JSON.stringify({ error: {
      code: 'context_length_exceeded', message: 'maximum context length is smaller than declared'
    } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    if (body.includes('Create a concise semantic checkpoint')) return modelResponse('openai-compatible', undefined, 'Capacity retry checkpoint.');
    return modelResponse('openai-compatible');
  }) as typeof fetch;
  try {
    const input = request('openai-compatible');
    input.model.contextWindowTokens = 1_000_000;
    const response = await new AgentRunner().run(input, { onCheckpoint: async (cp) => {
      checkpoint = checkpointCopy(cp); taskIds.add(cp.taskId);
    } });
    assert.equal(response.message, 'Done.');
    assert.equal(taskIds.size, 1);
    assert.equal(checkpoint.state?.epoch?.rollovers[0].reason, 'provider_context_too_long');
    assert.ok((checkpoint.state?.epoch?.calibration.learnedEffectiveWindowTokens ?? 1_000_000) < 1_000_000);
    assert.equal(response.runDetails.contextEpochs?.[0].reason, 'provider_context_too_long');
    assert.equal(bodies.length, 3);
    assert.equal(input.history.length, 0, 'rollover does not create a visible history message');
  } finally { globalThis.fetch = originalFetch; }
});

test('a successful 40K prompt repairs stale 32K calibration without an epoch rollover storm', async () => {
  const workspace = new WorkspaceToolService();
  workspace.readWorkspaceFile = async () => JSON.stringify({ ok: true, path: 'small.ts', content: 'export {};' });
  const input = request('openai-compatible');
  input.model.contextWindowTokens = 1_000_000;
  const checkpoint = epochRecoveryCheckpoint(input, 'task-stale-capacity');
  checkpoint.state!.epoch!.calibration = {
    ...checkpoint.state!.epoch!.calibration,
    declaredWindowTokens: 1_000_000,
    declaredIdentity: 'custom-model',
    declaredVersion: `${DEEPSEEK_MODEL_IDENTITY_VERSION}:1000000`,
    learnedEffectiveWindowTokens: 32_768,
    estimatorScale: 1.37,
    successfulInputFloorTokens: 0,
    lastAdjustmentSource: 'declared'
  };
  input.checkpoint = checkpoint;
  const bodies: string[] = [];
  let finalCheckpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1
      ? toolCallResponseWithUsage(40_960)
      : chatResponseWithUsage('Done.', 42_000);
  }) as typeof fetch;
  try {
    const response = await new AgentRunner(workspace).run(input, {
      onCheckpoint: async (cp) => { finalCheckpoint = checkpointCopy(cp); }
    });
    assert.equal(response.message, 'Done.');
    assert.equal(bodies.length, 2);
    assert.equal(bodies.some((body) => body.includes('Create a concise semantic checkpoint')), false);
    assert.equal(finalCheckpoint.state?.epoch?.totalRollovers, 0);
    assert.equal(finalCheckpoint.state?.epoch?.calibration.learnedEffectiveWindowTokens, 1_000_000);
    assert.equal(response.runDetails.capacityAdjustments?.length, 1);
    assert.equal(response.runDetails.capacityAdjustments?.[0]?.reason, 'stale_capacity_calibration');
  } finally { globalThis.fetch = originalFetch; }
});

test('epoch summary failure falls back to deterministic host state without stopping the task', async () => {
  const workspace = new WorkspaceToolService();
  let reads = 0;
  workspace.readWorkspaceFile = async () => { reads += 1; return JSON.stringify({ ok: true, path: 'fallback.ts', content: 'small' }); };
  const bodies: string[] = [];
  let checkpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = String(init?.body);
    bodies.push(body);
    if (bodies.length === 1) return modelResponse('openai-compatible', {
      id: 'fallback-read', name: 'keepseek_read_workspace_file', args: '{"path":"fallback.ts"}'
    });
    if (body.includes('Create a concise semantic checkpoint')) return new Response(JSON.stringify({ error: {
      code: 'invalid_request', message: 'summary lane unavailable'
    } }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    return modelResponse('openai-compatible');
  }) as typeof fetch;
  try {
    const input = request('openai-compatible');
    input.executionLimits = { maxToolIterations: 1 };
    const response = await new AgentRunner(workspace).run(input, { onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); } });
    assert.equal(response.message, 'Done.');
    assert.equal(reads, 1);
    assert.equal(checkpoint.state?.epoch?.rollovers[0].summaryKind, 'host_fallback');
    assert.equal(response.runDetails.contextEpochs?.[0].summaryKind, 'host_fallback');
    assert.ok(bodies.some((body) => body.includes('keepseek_context_epoch_checkpoint')));
  } finally { globalThis.fetch = originalFetch; }
});

test('restart while an epoch summary is in flight safely regenerates the checkpoint in the same task', async () => {
  const input = request('openai-compatible');
  input.sessionId = 'session-summary-restart';
  const checkpoint = epochRecoveryCheckpoint(input, 'task-summary-restart');
  checkpoint.state!.epoch!.status = 'summarizing';
  checkpoint.state!.epoch!.pendingRollover = { reason: 'soft_context_pressure' };
  input.checkpoint = checkpoint;
  const bodies: string[] = [];
  const taskIds = new Set<string>();
  let finalCheckpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = String(init?.body);
    bodies.push(body);
    return body.includes('Create a concise semantic checkpoint')
      ? modelResponse('openai-compatible', undefined, 'Recovered semantic summary.')
      : modelResponse('openai-compatible');
  }) as typeof fetch;
  try {
    const response = await new AgentRunner().run(input, { onCheckpoint: async (cp) => {
      finalCheckpoint = checkpointCopy(cp); taskIds.add(cp.taskId);
    } });
    assert.equal(response.message, 'Done.');
    assert.equal(taskIds.size, 1);
    assert.deepEqual([...taskIds], ['task-summary-restart']);
    assert.equal(bodies.length, 2);
    assert.equal(bodies.filter((body) => body.includes('Create a concise semantic checkpoint')).length, 1);
    assert.ok(bodies[1].includes('keepseek_context_epoch_checkpoint'));
    assert.equal(finalCheckpoint.state?.epoch?.totalRollovers, 1);
    assert.equal(input.history.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('restart after a new epoch seed is persisted sends its exact bytes without regenerating the summary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-epoch-persisted-'));
  const uri = vscode.Uri.file(root) as unknown as import('vscode').Uri;
  const input = request('openai-compatible');
  input.sessionId = 'session-persisted-epoch';
  const checkpoint = epochRecoveryCheckpoint(input, 'task-persisted-epoch');
  const epoch = checkpoint.state!.epoch!;
  const seed = createEpochSeed({
    originalTask: input.prompt,
    semanticSummary: 'The previous epoch was durably checkpointed.',
    taskPlan: checkpoint.taskPlan!,
    draftEdits: [],
    draftRuns: [],
    repairLoop: checkpoint.state!.repairLoop,
    validationState: checkpoint.state!.validationState,
    evidenceRefs: [],
    idempotency: [],
    failures: [],
    nextStep: 'Return the final answer.',
    runtimeState: {
      taskId: checkpoint.taskId,
      approvalRootTaskId: checkpoint.taskId,
      modelRequests: checkpoint.modelRequests,
      totalToolCalls: 0,
      totalToolResultTokensEstimate: 0
    }
  });
  const archiveName = await new ToolEvidenceStore(uri).saveEpochSnapshot(
    input.sessionId,
    checkpoint.taskId,
    0,
    { version: 1, index: 0, messages: checkpoint.state!.messages, seed }
  );
  epoch.status = 'persisted';
  epoch.pendingRollover = {
    reason: 'soft_context_pressure',
    estimatedPromptTokens: 12_345,
    summaryKind: 'model',
    archiveName,
    seed
  };
  input.checkpoint = checkpoint;
  const bodies: string[] = [];
  let finalCheckpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    return modelResponse('openai-compatible');
  }) as typeof fetch;
  try {
    const response = await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined, uri).run(input, {
      onCheckpoint: async (cp) => { finalCheckpoint = checkpointCopy(cp); }
    });
    assert.equal(response.message, 'Done.');
    assert.equal(bodies.length, 1, 'the persisted phase does not repeat the hidden summary request');
    assert.ok(bodies[0].includes(JSON.stringify(seed)), 'the provider receives the exact persisted seed bytes');
    assert.equal(bodies[0].includes('Create a concise semantic checkpoint'), false);
    assert.equal(finalCheckpoint.taskId, checkpoint.taskId);
    assert.equal(finalCheckpoint.state?.epoch?.totalRollovers, 1);
    assert.equal(finalCheckpoint.state?.epoch?.rollovers[0].seedHash, sha256(seed));
  } finally { globalThis.fetch = originalFetch; }
});

test('no-progress fingerprints survive epoch rollover and stop only after a strategy warning', async () => {
  const workspace = new WorkspaceToolService();
  let reads = 0;
  workspace.readWorkspaceFile = async () => { reads += 1; return JSON.stringify({ ok: true, path: 'loop.ts', content: 'unchanged' }); };
  let mainRequests = 0;
  let checkpoint!: RunCheckpoint;
  const taskIds = new Set<string>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = String(init?.body);
    if (body.includes('Create a concise semantic checkpoint')) return modelResponse('openai-compatible', undefined, 'No plan progress.');
    mainRequests += 1;
    return modelResponse('openai-compatible', {
      id: `loop-${mainRequests}`, name: 'keepseek_read_workspace_file', args: '{"path":"loop.ts"}'
    });
  }) as typeof fetch;
  try {
    const input = request('openai-compatible');
    input.executionLimits = { maxToolIterations: 1 };
    await assert.rejects(
      () => new AgentRunner(workspace).run(input, { onCheckpoint: async (cp) => {
        checkpoint = checkpointCopy(cp); taskIds.add(cp.taskId);
      } }),
      (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'no_progress_loop'
    );
    assert.equal(reads, 3);
    assert.equal(mainRequests, 3);
    assert.equal(taskIds.size, 1);
    assert.equal(checkpoint.state?.epoch?.totalRollovers, 2);
    assert.equal(checkpoint.state?.epoch?.noProgress?.strategyWarningIssued, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('many results can cumulatively exceed two million tokens across one logical task', async () => {
  const workspace = new WorkspaceToolService();
  let reads = 0;
  workspace.readWorkspaceFile = async (path) => {
    reads += 1;
    return JSON.stringify({ ok: true, path, content: `${path}:` + '中'.repeat(45_000) });
  };
  let mainRequests = 0;
  let checkpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    const body = String(init?.body);
    if (body.includes('Create a concise semantic checkpoint')) return modelResponse('openai-compatible', undefined, 'Continue remaining reads.');
    mainRequests += 1;
    return mainRequests <= 48
      ? modelResponse('openai-compatible', { id: `many-${mainRequests}`, name: 'keepseek_read_workspace_file',
          args: JSON.stringify({ path: `file-${mainRequests}.ts` }) })
      : modelResponse('openai-compatible');
  }) as typeof fetch;
  try {
    const input = request('openai-compatible');
    input.model.contextWindowTokens = 1_000_000;
    input.executionLimits = { maxToolIterations: 2 };
    const response = await new AgentRunner(workspace).run(input, { onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); } });
    assert.equal(response.message, 'Done.');
    assert.equal(reads, 48);
    assert.ok((checkpoint.state?.toolResultTokens ?? 0) > 2_000_000);
    assert.ok((checkpoint.state?.epoch?.totalRollovers ?? 0) >= 23);
    assert.equal(response.runDetails.budgetStopReason, undefined);
  } finally { globalThis.fetch = originalFetch; }
});

test('finish_reason length continues inside the same logical task without a visible user turn', async () => {
  const bodies: string[] = [];
  const visible: string[] = [];
  const taskIds = new Set<string>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1 ? chatTextResponse('first-', 'length') : chatTextResponse('second', 'stop');
  }) as typeof fetch;
  try {
    const input = request('openai-compatible');
    const response = await new AgentRunner().run(input, {
      onDelta: (event) => { if (event.type === 'content') visible.push(event.delta); },
      onCheckpoint: async (cp) => { taskIds.add(cp.taskId); }
    });
    assert.equal(response.message, 'first-second');
    assert.equal(visible.join(''), 'first-second');
    assert.equal(bodies.length, 2);
    assert.equal(taskIds.size, 1);
    assert.ok(bodies[1].includes('Continue the previous answer'));
    assert.equal(input.history.length, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('legacy capacity checkpoints migrate in place and UI has no new-turn action', () => {
  const legacy = {
    version: 1, id: 'checkpoint', taskId: 'task', approvalRootTaskId: 'task', createdAt: '', updatedAt: '', attempt: 1,
    status: 'blocked', stopReason: 'budget_exhausted', usedMs: 1, maxExecutionMs: 0, modelStepRetries: 0, workspaceUris: [],
    source: { sourceId: 'source', provider: 'openai-compatible', modelId: 'model', endpointHash: 'hash' },
    request: { prompt: 'original', history: [], contextFiles: [], language: 'en', model: { id: 'model', label: 'Model', sourceId: 'source', provider: 'openai-compatible' }, settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' }, executionLimits: {} },
    state: { messages: [], toolRounds: [], draftEdits: [], draftRuns: [], reasoningParts: [], turn: 1, toolCallCount: 1,
      validationRunCount: 0, toolResultTokens: 99, validationState: {}, repairLoop: { status: 'idle', iteration: 0, maxIterations: 2, pendingDraftEditIds: [] },
      budgetStopReason: 'tool_result_budget_exhausted' },
    finalResponse: { message: 'Old budget text', draftEdits: [], draftRuns: [], toolRounds: [], repairLoop: { status: 'idle', iteration: 0, maxIterations: 2, pendingDraftEditIds: [] },
      runDetails: { id: 'details', startedAt: '', endedAt: '', status: 'blocked', protocol: 'Chat Completions', requestCount: 1, toolCalls: [], timeline: [], budgetStopReason: 'tool_result_budget_exhausted' } }
  } as unknown as RunCheckpoint;
  const migrated = migrateLegacyCapacityCheckpoint(legacy);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.status, 'interrupted');
  assert.equal(migrated.stopReason, 'extension_restart');
  assert.equal(migrated.state?.budgetStopReason, undefined);
  assert.equal(recoveryBlocker(migrated), undefined);
  assert.equal(JSON.stringify(legacy).includes('tool_result_budget_exhausted'), true);
  const source = getScript();
  for (const removed of ['continueAgentTaskInNewTurn', 'continueTaskInNewTurn', 'runContinueInNewTurn', 'runNewTurnNotice']) {
    assert.equal(source.includes(removed), false, removed);
  }
});

test('crash recovery distinguishes pending, replayable, completed and uncertain tool executions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'keepseek-evidence-recovery-'));
  const uri = vscode.Uri.file(root) as unknown as import('vscode').Uri;
  const scenarios = [
    { name: 'intent-not-started', status: 'pending' as const, complete: false, envelope: false, expectedReads: 1 },
    { name: 'read-result-unknown', status: 'executing' as const, complete: false, envelope: false, expectedReads: 1 },
    { name: 'evidence-no-envelope', status: 'executing' as const, complete: true, envelope: false, expectedReads: 0 },
    { name: 'envelope-not-sent', status: 'executing' as const, complete: true, envelope: true, expectedReads: 0 },
    { name: 'envelope-sending', status: 'executing' as const, complete: true, envelope: true, sending: true, expectedReads: 0 }
  ];
  const originalFetch = globalThis.fetch;
  try {
    for (const scenario of scenarios) {
      const input = request('openai-compatible');
      input.sessionId = `session-${scenario.name}`;
      const args = '{"path":"recovery.ts"}';
      const checkpoint = recoveryCheckpoint(input, `task-${scenario.name}`, 'recovery-call', 'keepseek_read_workspace_file', args);
      const store = new ToolEvidenceStore(uri, 30_000_000);
      let evidence = await store.ensureIntent({ sessionId: input.sessionId, taskId: checkpoint.taskId, epochIndex: 0,
        toolCallId: 'recovery-call', toolName: 'keepseek_read_workspace_file', argumentsHash: sha256(args), effectKind: 'read' });
      if (scenario.status === 'executing') evidence = await store.markExecuting(evidence);
      if (scenario.complete) evidence = await store.complete(evidence, JSON.stringify({ ok: true, path: 'recovery.ts', content: LARGE_ASCII }));
      if (scenario.envelope) {
        const prepared = prepareEvidenceEnvelope({ record: evidence, rawContent: await store.readContent(evidence),
          inlineTokenAllowance: 500, inlineCharLimit: 2_000 });
        evidence = await store.saveProviderEnvelope(evidence, prepared.content, prepared.completeInline);
      }
      if (scenario.sending) evidence = await store.markSending(evidence);
      checkpoint.state!.pending!.executing!.evidenceRef = evidence.evidenceRef;
      input.checkpoint = checkpoint;
      let reads = 0;
      const workspace = new WorkspaceToolService();
      workspace.readWorkspaceFile = async () => { reads += 1; return JSON.stringify({ ok: true, path: 'recovery.ts', content: LARGE_ASCII }); };
      const bodies: string[] = [];
      globalThis.fetch = (async (_url, init) => { bodies.push(String(init?.body)); return modelResponse('openai-compatible'); }) as typeof fetch;
      const response = await new AgentRunner(workspace, undefined, undefined, undefined, undefined, undefined, uri).run(input);
      assert.equal(response.message, 'Done.', scenario.name);
      assert.equal(reads, scenario.expectedReads, scenario.name);
      assert.equal(bodies.length, 1, scenario.name);
      const recovered = await new ToolEvidenceStore(uri, 30_000_000).findByRef(evidence.evidenceRef, input.sessionId, checkpoint.taskId);
      assert.equal(recovered?.deliveryStatus, 'delivered', scenario.name);
      assert.ok(bodies[0].includes(JSON.stringify(recovered!.providerEnvelope!)), scenario.name);
    }

    const input = request('openai-compatible');
    input.sessionId = 'session-uncertain';
    const args = '{"script":"test"}';
    const checkpoint = recoveryCheckpoint(input, 'task-uncertain', 'validation-call', 'keepseek_run_validation', args);
    const store = new ToolEvidenceStore(uri);
    let evidence = await store.ensureIntent({ sessionId: input.sessionId, taskId: checkpoint.taskId, epochIndex: 0,
      toolCallId: 'validation-call', toolName: 'keepseek_run_validation', argumentsHash: sha256(args), effectKind: 'validation' });
    evidence = await store.markExecuting(evidence);
    checkpoint.state!.pending!.executing!.evidenceRef = evidence.evidenceRef;
    input.checkpoint = checkpoint;
    assert.equal(recoveryBlocker(checkpoint), undefined,
      'the UI lets the runner reconcile evidence before deciding that a side effect is uncertain');
    await assert.rejects(
      () => new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined, uri).run(input),
      (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'uncertain_tool_result'
    );
    assert.equal((await new ToolEvidenceStore(uri).findByRef(evidence.evidenceRef, input.sessionId, checkpoint.taskId))?.executionStatus, 'uncertain');
  } finally { globalThis.fetch = originalFetch; }
});

test('an explicit task cost ceiling survives tool delivery and stops before another Provider request', async () => {
  const workspace = new WorkspaceToolService();
  let toolCalls = 0;
  workspace.listWorkspaceFiles = async () => {
    toolCalls += 1;
    return JSON.stringify({ ok: true, files: ['src/index.ts'] });
  };
  const input: AgentRequest = {
    prompt: 'Inspect the workspace and finish.', history: [], contextFiles: [], language: 'en',
    sessionId: 'session-cost-limit', requestProtocolVersion: 8,
    model: { id: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', sourceId: 'deepseek-source',
      provider: 'deepseek', contextWindowTokens: 1_000_000, maxOutputTokens: 4_000 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    sourceConfig: { sourceId: 'deepseek-source', provider: 'deepseek', apiKey: 'secret',
      baseUrl: 'https://api.deepseek.com', supportsBilling: true },
    executionLimits: { maxToolIterations: 8, maxToolCalls: 24, maxCost: 0.000_001 }
  };
  let providerRequests = 0;
  let checkpoint: RunCheckpoint | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    providerRequests += 1;
    return pricedToolCallResponse();
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => new AgentRunner(workspace).run(input, { onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); } }),
      (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'cost_limit'
    );
    assert.equal(providerRequests, 1, 'the exhausted task never starts a second Provider request');
    assert.equal(toolCalls, 1, 'the accepted tool call still completes exactly once');
    assert.equal(checkpoint?.stopReason, 'cost_limit');
    assert.equal(checkpoint?.maxCost, 0.000_001);
    assert.ok((checkpoint?.usedCostByCurrency?.['¥'] ?? 0) >= 0.000_001);
    assert.equal(checkpoint?.state?.toolRounds.some((round) =>
      round.toolResults.some((result) => result.toolCallId === 'cost-tool')), true,
    'the completed tool result is durable before the cost stop');
  } finally { globalThis.fetch = originalFetch; }
});

test('a positive cost ceiling fails closed before using an unpriced source', async () => {
  const input = request('openai-compatible');
  input.executionLimits = { ...input.executionLimits, maxCost: 1 };
  let providerRequests = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    providerRequests += 1;
    return modelResponse('openai-compatible');
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => new AgentRunner().run(input),
      (error: unknown) => error instanceof AgentInterruptedError && error.reason === 'provider_error'
    );
    assert.equal(providerRequests, 0);
  } finally { globalThis.fetch = originalFetch; }
});

async function runLargeResult(provider: Provider) {
  const workspace = new WorkspaceToolService();
  let readCount = 0;
  workspace.readWorkspaceFile = async () => { readCount += 1; return JSON.stringify({ ok: true, path: 'large.ts', content: LARGE_ASCII }); };
  const bodies: string[] = [];
  let checkpoint!: RunCheckpoint;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    return bodies.length === 1
      ? modelResponse(provider, { id: 'large-call', name: 'keepseek_read_workspace_file', args: '{"path":"large.ts"}' })
      : modelResponse(provider);
  }) as typeof fetch;
  try {
    const response = await new AgentRunner(workspace).run(request(provider), { onCheckpoint: async (cp) => { checkpoint = checkpointCopy(cp); } });
    return { response, checkpoint, bodies, readCount };
  } finally { globalThis.fetch = originalFetch; }
}

type Provider = 'openai-compatible' | 'openai-responses' | 'anthropic-compatible';

function request(provider: Provider): AgentRequest {
  return { prompt: 'Read the large file and finish.', history: [], contextFiles: [], language: 'en', sessionId: 'session-runner', requestProtocolVersion: 8,
    model: { id: 'custom-model', label: 'Custom', sourceId: 'source', provider, contextWindowTokens: 32_000, maxOutputTokens: 4_000 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    sourceConfig: { sourceId: 'source', provider, apiKey: '', baseUrl: 'https://gateway.invalid/v1', supportsBilling: false },
    executionLimits: { maxToolIterations: 8, maxToolCalls: 24 } };
}

function modelResponse(provider: Provider, call?: { id: string; name: string; args: string }, text = 'Done.'): Response {
  let events: unknown[];
  if (provider === 'openai-responses') {
    events = [{ type: 'response.completed', response: { status: 'completed', output: call
      ? [{ type: 'function_call', call_id: call.id, name: call.name, arguments: call.args }]
      : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }] } }];
  } else if (provider === 'anthropic-compatible') {
    events = [{ type: 'message_start', message: {} }, { type: 'content_block_start', index: 0, content_block: call
      ? { type: 'tool_use', id: call.id, name: call.name, input: JSON.parse(call.args) } : { type: 'text', text } },
    { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: call ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }];
  } else {
    events = [{ choices: [{ delta: call
      ? { tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: call.args } }] }
      : { content: text }, finish_reason: call ? 'tool_calls' : 'stop' }] }];
  }
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    + (provider === 'openai-compatible' ? 'data: [DONE]\n\n' : ''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function chatTextResponse(text: string, finishReason: 'length' | 'stop'): Response {
  return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: finishReason }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function pricedToolCallResponse(): Response {
  return new Response(`data: ${JSON.stringify({
    choices: [{
      delta: { tool_calls: [{ index: 0, id: 'cost-tool', type: 'function', function: {
        name: 'keepseek_list_workspace_files', arguments: '{}'
      } }] },
      finish_reason: 'tool_calls'
    }],
    usage: {
      prompt_tokens: 1_000,
      completion_tokens: 10,
      total_tokens: 1_010,
      prompt_cache_hit_tokens: 0,
      prompt_cache_miss_tokens: 1_000
    }
  })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function toolCallResponseWithUsage(promptTokens: number): Response {
  return new Response(`data: ${JSON.stringify({
    choices: [{
      delta: { tool_calls: [{ index: 0, id: 'stale-read', type: 'function', function: {
        name: 'keepseek_read_workspace_file', arguments: '{"path":"small.ts"}'
      } }] },
      finish_reason: 'tool_calls'
    }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 20, total_tokens: promptTokens + 20 }
  })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function chatResponseWithUsage(text: string, promptTokens: number): Response {
  return new Response(`data: ${JSON.stringify({
    choices: [{ delta: { content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 }
  })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function intent(toolCallId: string) {
  return { sessionId: 'session-a', taskId: 'task-a', toolCallId, toolName: 'keepseek_read_workspace_file',
    argumentsHash: `args-${toolCallId}`, effectKind: 'read' as const };
}

function recoveryCheckpoint(input: AgentRequest, taskId: string, callId: string, toolName: string, args: string): RunCheckpoint {
  const checkpoint = createRunCheckpoint(input, 0, 'test', []);
  checkpoint.taskId = taskId;
  checkpoint.status = 'interrupted';
  checkpoint.stopReason = 'extension_restart';
  checkpoint.state = {
    messages: [{ role: 'user', content: input.prompt }], toolRounds: [], draftEdits: [], draftRuns: [], reasoningParts: [],
    turn: 0, toolCallCount: 0, validationRunCount: 0, toolResultTokens: 0,
    validationState: { pendingDraftEditIds: [], validations: [] },
    repairLoop: { status: 'idle', iteration: 0, maxIterations: 2, pendingDraftEditIds: [] },
    epoch: createContextEpochState(new ToolResultAdmissionController(input.model.contextWindowTokens ?? 32_000).state),
    pending: {
      response: { message: { role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function',
        function: { name: toolName, arguments: args } }] } },
      results: {}, executing: { id: callId, name: toolName }
    }
  };
  return checkpoint;
}

function epochRecoveryCheckpoint(input: AgentRequest, taskId: string): RunCheckpoint {
  const checkpoint = createRunCheckpoint(input, 0, 'test', []);
  checkpoint.taskId = taskId;
  checkpoint.status = 'interrupted';
  checkpoint.stopReason = 'extension_restart';
  checkpoint.taskPlan = planFixture();
  checkpoint.state = {
    messages: [{ role: 'user', content: input.prompt }],
    toolRounds: [],
    draftEdits: [],
    draftRuns: [],
    reasoningParts: [],
    turn: 0,
    toolCallCount: 0,
    validationRunCount: 0,
    toolResultTokens: 0,
    validationState: { pendingDraftEditIds: [], validations: [] },
    repairLoop: { status: 'idle', iteration: 0, maxIterations: 2, pendingDraftEditIds: [] },
    epoch: createContextEpochState(new ToolResultAdmissionController(input.model.contextWindowTokens ?? 32_000).state)
  };
  return checkpoint;
}

function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

function planFixture(): TaskPlan {
  return { id: 'plan', runId: 'run', goal: 'Finish', status: 'running', steps: [
    { id: 'one', title: 'Read', status: 'completed', updatedAt: 'stable' },
    { id: 'two', title: 'Finish', status: 'pending', updatedAt: 'stable' }
  ], blockers: [], createdAt: 'stable', updatedAt: 'stable' };
}

function hasEvidenceTool(body: Record<string, unknown>): boolean {
  return (body.tools as Array<{ name?: string; function?: { name?: string } }>).some((tool) =>
    tool.name === READ_EVIDENCE_TOOL_NAME || tool.function?.name === READ_EVIDENCE_TOOL_NAME);
}
