import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, test } from 'node:test';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { SubagentSettingsStore } from '../src/accounts/subagentSettingsStore';
import {
  CREATE_DRAFT_EDIT_TOOL_NAME,
  getAgentTools,
  READ_WORKSPACE_FILE_TOOL_NAME,
  RUN_DRAFT_TOOL_NAME,
  RUN_VALIDATION_TOOL_NAME
} from '../src/agent/protocol';
import { AgentLoop, getToolExposureError } from '../src/agent/runner';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import {
  createStableWorkspaceContext,
  resolveProposalPathScope,
  resolveProposalUriScope,
  scopeContains,
  scopesOverlap,
  stableWorkspaceRootId,
  type ProposalPathScope,
  type WorkspaceScopeRoot
} from '../src/agent/subagents/pathScope';
import { resolveSubagentProfile } from '../src/agent/subagents/profiles';
import { acceptSubagentResult } from '../src/agent/subagents/resultEnvelope';
import {
  formatChildContextForVersion,
  getChildToolNamesForRuntime,
  getSubagentSystemPromptForVersion,
  restrictSubagentRuntimeProfile,
  SubagentRuntime,
  validateSubagentArtifacts,
  verifyStoredSubagentFreshness
} from '../src/agent/subagents/runtime';
import { SubagentScheduler } from '../src/agent/subagents/scheduler';
import { SubagentStore } from '../src/agent/subagents/store';
import type { StoredSubagentMetadata } from '../src/agent/subagents/types';
import { toSubagentProgressViewModel } from '../src/agent/subagentUsageStats';
import type { DraftEdit } from '../src/shared/types';
import type { AgentRequest } from '../src/shared/types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async (directory) => {
    await rm(directory, { recursive: true, force: true });
  }));
});

test('runtime exposure gate rejects anomalous calls from every provider lane before effects', () => {
  const exposed = new Set(['keepseek_read_workspace_file']);
  for (const channel of ['native', 'responses', 'anthropic', 'dsml', 'recovery']) {
    const rejected = getToolExposureError(RUN_VALIDATION_TOOL_NAME, exposed);
    assert.ok(rejected, channel);
    assert.deepEqual(JSON.parse(rejected), {
      ok: false,
      errorType: 'subagent_tool_not_exposed',
      error: 'The requested tool was not exposed in this Provider request and was not executed.',
      toolName: RUN_VALIDATION_TOOL_NAME
    });
  }
  assert.equal(getToolExposureError('keepseek_read_workspace_file', exposed), undefined);
});

test('native and DSML anomalous calls hit the same runtime gate and cannot collect proposals', async () => {
  for (const format of ['native', 'dsml'] as const) {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      const firstContent = format === 'dsml'
        ? '<||DSML||tool_calls><||DSML||invoke name="keepseek_create_draft_edit"><||DSML||parameter name="targetPath" string="true">src/a.ts</||DSML||parameter><||DSML||parameter name="newContent" string="true">bad</||DSML||parameter><||DSML||parameter name="reason" string="true">bad</||DSML||parameter></||DSML||invoke></||DSML||tool_calls>'
        : undefined;
      const payload = requests === 1
        ? format === 'native'
          ? { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: { name: CREATE_DRAFT_EDIT_TOOL_NAME, arguments: JSON.stringify({ targetPath: 'src/a.ts', newContent: 'bad', reason: 'bad' }) } }] }, finish_reason: 'tool_calls' }] }
          : { choices: [{ delta: { content: firstContent }, finish_reason: 'stop' }] }
        : { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] };
      return chatStream(payload);
    }) as typeof fetch;
    try {
      let rejected = 0;
      const request = childParentRequest();
      request.prompt = `Inspect ${format}`;
      request.slimToolNames = ['keepseek_read_workspace_file'];
      request.requestProtocolVersion = 5;
      request.executionLimits = { maxToolIterations: 2, maxToolCalls: 2 };
      const response = await new AgentLoop().run(request, { onToolRejected: () => { rejected += 1; } });
      assert.equal(response.message, 'done');
      assert.equal(rejected, 1);
      assert.equal(response.draftEdits.length, 0);
      assert.equal(response.draftRuns?.length ?? 0, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('Responses and Anthropic anomalous native calls hit the same runtime exposure gate', async () => {
  for (const provider of ['openai-responses', 'anthropic-compatible'] as const) {
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (provider === 'openai-responses') {
        return responsesStream(requests === 1 ? [
          { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc-bad', call_id: 'call-bad', name: CREATE_DRAFT_EDIT_TOOL_NAME, arguments: '' } },
          { type: 'response.function_call_arguments.done', output_index: 0, call_id: 'call-bad', arguments: '{}' },
          { type: 'response.completed', response: { status: 'completed' } }
        ] : [
          { type: 'response.output_text.delta', delta: 'done' },
          { type: 'response.completed', response: { status: 'completed' } }
        ]);
      }
      return anthropicStream(requests === 1
        ? [
          { type: 'message_start', message: { usage: { input_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call-bad', name: CREATE_DRAFT_EDIT_TOOL_NAME, input: {} } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' }
        ]
        : [
          { type: 'message_start', message: { usage: { input_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
          { type: 'message_stop' }
        ]);
    }) as typeof fetch;
    try {
      let rejected = 0;
      const request = childParentRequest();
      request.model = { ...request.model, provider };
      request.sourceConfig = { ...request.sourceConfig!, provider };
      request.slimToolNames = [READ_WORKSPACE_FILE_TOOL_NAME];
      request.requestProtocolVersion = 5;
      request.executionLimits = { maxToolIterations: 2, maxToolCalls: 2 };
      const response = await new AgentLoop().run(request, { onToolRejected: () => { rejected += 1; } });
      assert.equal(response.message, 'done', provider);
      assert.equal(rejected, 1, provider);
      assert.equal(response.draftEdits.length, 0, provider);
      assert.equal(response.draftRuns?.length ?? 0, 0, provider);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

test('read-only and depth-limited child profiles cannot draft, validate, run, or over-delegate', () => {
  for (const id of ['research', 'review']) {
    const profile = resolveSubagentProfile({ requestedId: id })!;
    const shallow = getChildToolNamesForRuntime(profile, 1);
    for (const forbidden of [CREATE_DRAFT_EDIT_TOOL_NAME, RUN_DRAFT_TOOL_NAME, RUN_VALIDATION_TOOL_NAME]) {
      assert.equal(shallow.includes(forbidden), false, `${id}:${forbidden}`);
      assert.match(getToolExposureError(forbidden, new Set(shallow)) ?? '', /subagent_tool_not_exposed/u);
    }
    const deep = getChildToolNamesForRuntime(profile, 2);
    assert.equal(deep.includes('keepseek_delegate_task'), false);
    assert.equal(deep.includes('keepseek_delegate_parallel'), false);
  }
  const proposal = getChildToolNamesForRuntime(resolveSubagentProfile({ requestedId: 'proposal' })!, 1);
  assert.equal(proposal.includes(CREATE_DRAFT_EDIT_TOOL_NAME), true);
  assert.equal(proposal.includes(RUN_VALIDATION_TOOL_NAME), false);
  assert.equal(proposal.includes('keepseek_delegate_task'), false);
  const nestedProposal = restrictSubagentRuntimeProfile(resolveSubagentProfile({ requestedId: 'proposal' })!, { nested: true, parallel: false });
  assert.equal(nestedProposal.lane, 'nested-read');
  assert.equal(nestedProposal.toolNames.includes(CREATE_DRAFT_EDIT_TOOL_NAME), false);
  assert.equal(nestedProposal.toolNames.includes(RUN_DRAFT_TOOL_NAME), false);
});

test('proposal path scopes normalize URI hierarchy without prefix or multi-root ambiguity', () => {
  const roots = workspaceRoots();
  const normalized = resolveProposalPathScope(['root-a/src/./feature/../a.ts'], roots);
  assert.equal(normalized.ok, true);
  if (!normalized.ok) return;
  assert.deepEqual(normalized.scope, { kind: 'paths', claims: [{ rootId: 'root-a', segments: ['src', 'a.ts'] }] });
  assert.equal(resolveProposalPathScope(['../escape.ts'], [roots[0]]).ok, false);
  assert.equal(resolveProposalPathScope(['file:///workspace/first/%2e%2e/outside.ts'], roots).ok, false);
  const ambiguous = resolveProposalPathScope(['src/a.ts'], roots);
  assert.equal(ambiguous.ok, false);
  if (!ambiguous.ok) assert.equal(ambiguous.errorType, 'subagent_path_ambiguous');
  assert.equal(resolveProposalUriScope(vscode.Uri.file('/outside/a.ts').toString(), roots).ok, false);

  const directory = pathScope('root-a', ['src']);
  const child = pathScope('root-a', ['src', 'a.ts']);
  const similarPrefix = pathScope('root-a', ['src', 'a.tsx']);
  assert.equal(scopesOverlap(directory, child, roots), true);
  assert.equal(scopesOverlap(child, similarPrefix, roots), false);
  assert.equal(scopeContains(directory, child, roots), true);
  assert.equal(scopeContains(child, directory, roots), false);

  const inScopeEdit: DraftEdit = { id: 'in', uri: vscode.Uri.file('/workspace/first/src/a.ts').toString(), label: 'src/a.ts', action: 'modify', newText: '', reason: '' };
  const outOfScopeEdit: DraftEdit = { id: 'out', uri: vscode.Uri.file('/workspace/first/test/a.ts').toString(), label: 'test/a.ts', action: 'modify', newText: '', reason: '' };
  const artifacts = validateSubagentArtifacts({ lane: 'proposal', proposalScope: directory, roots, draftEdits: [inScopeEdit, outOfScopeEdit], draftRuns: [] });
  assert.deepEqual(artifacts.draftEdits.map((edit) => edit.id), ['in']);
  assert.match(artifacts.diagnostics.join(','), /proposal_artifact_scope_rejected/u);

  const caseSensitiveA = pathScope('root-a', ['src', 'A.ts']);
  assert.equal(scopesOverlap(caseSensitiveA, child, roots), false);
  const insensitiveRoots = [{ ...roots[0], caseSensitive: false }];
  assert.equal(scopesOverlap(caseSensitiveA, child, insensitiveRoots), true);
});

test('stable workspace root ids are directly usable by existing workspace tools', () => {
  const originalFolders = vscode.workspace.workspaceFolders;
  const second = vscode.Uri.file('/workspace/second');
  (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: vscode.Uri; name: string }> }).workspaceFolders = [
    { uri: vscode.Uri.file('/workspace/first'), name: 'duplicate' },
    { uri: second, name: 'duplicate' }
  ];
  try {
    const resolved = new WorkspaceToolService().resolveTargetUri(`${stableWorkspaceRootId(second)}/src/a.ts`);
    assert.equal(resolved.toString(), vscode.Uri.file('/workspace/second/src/a.ts').toString());
  } finally {
    (vscode.workspace as unknown as { workspaceFolders: typeof originalFolders }).workspaceFolders = originalFolders;
  }
});

test('parallel proposal reservations preflight atomically against peers and parent edits', () => {
  const roots = workspaceRoots();
  const scheduler = new SubagentScheduler();
  const conflicting = scheduler.reserveBatch([
    reservation('one', pathScope('root-a', ['src']), roots),
    reservation('two', pathScope('root-a', ['src', 'a.ts']), roots)
  ]);
  assert.equal(conflicting.ok, false);
  assert.equal(scheduler.snapshotTree('tree'), undefined, 'failed batch must not reserve its first child');

  const parentConflict = scheduler.reserveBatch([
    { ...reservation('three', pathScope('root-a', ['src', 'a.ts']), roots), conflictingScopes: [pathScope('root-a', ['src'])] }
  ]);
  assert.equal(parentConflict.ok, false);
  assert.equal(scheduler.snapshotTree('tree'), undefined);

  assert.equal(scheduler.reserveBatch([
    reservation('four', pathScope('root-a', ['src', 'a.ts']), roots),
    reservation('five', pathScope('root-a', ['src', 'a.tsx']), roots)
  ]).ok, true);
});

test('typed result envelopes distinguish research, review, proposal, partial, empty, and damaged output', () => {
  const research = JSON.stringify({
    status: 'complete', summary: 'Found the request path.',
    evidence: [{ claim: 'The handler is present.', path: 'src/a.ts', startLine: 4, endLine: 8 }], uncertainties: []
  });
  assert.equal(acceptSubagentResult({ raw: research, lane: 'research-read' }).envelope?.kind, 'research');
  assert.equal(acceptSubagentResult({ raw: research.replace('complete', 'partial'), lane: 'research-read' }).envelope?.status, 'partial');
  assert.equal(acceptSubagentResult({ raw: '', lane: 'research-read' }).ok, false);
  assert.equal(acceptSubagentResult({ raw: '{damaged', lane: 'research-read' }).ok, false);
  assert.deepEqual(acceptSubagentResult({ raw: research, lane: 'research-read', maxChars: 16 }).diagnostics, ['result_too_large']);
  assert.deepEqual(acceptSubagentResult({ raw: research, lane: 'research-read', expectedTaskHash: 'expected' }).diagnostics, ['task_binding_mismatch']);
  assert.equal(acceptSubagentResult({ raw: JSON.stringify({ status: 'complete', summary: 'Done', evidence: [], uncertainties: [] }), lane: 'research-read' }).ok, false);

  const review = acceptSubagentResult({
    raw: JSON.stringify({
      status: 'complete', summary: 'One blocking issue.', evidence: [{ claim: 'Unsafe call.', path: 'src/a.ts' }], uncertainties: [],
      verdict: 'block', reviewedPaths: ['src/a.ts'],
      findings: [{ severity: 'high', title: 'Unsafe call', evidence: 'Direct spawn.', impact: 'Bypasses approval.', path: 'src/a.ts', startLine: 9 }]
    }),
    lane: 'review-read'
  });
  assert.equal(review.ok, true);
  assert.equal(review.envelope?.kind, 'review');
  assert.equal(acceptSubagentResult({ raw: research, lane: 'review-read' }).ok, false);

  const edit: DraftEdit = { id: 'e', uri: 'file:///workspace/src/a.ts', label: 'src/a.ts', action: 'modify', newText: 'x', reason: 'test' };
  const proposal = acceptSubagentResult({ raw: research, lane: 'proposal', draftEdits: [edit], draftRuns: [] });
  assert.equal(proposal.ok, true);
  assert.deepEqual(proposal.envelope?.kind === 'proposal' ? proposal.envelope.artifacts : undefined, {
    draftEditCount: 1, draftRunCount: 0, paths: ['src/a.ts']
  });
  assert.equal(acceptSubagentResult({ raw: research, lane: 'proposal', draftEdits: [], draftRuns: [] }).ok, false);
});

test('malformed child results receive exactly one format-only repair and then fail closed', async () => {
  const directory = await temporaryDirectory('keepseek-subagent-repair-');
  const valid = JSON.stringify({ taskHash: hash('Inspect once'), status: 'complete', summary: 'Reformatted result.', evidence: [{ claim: 'Existing evidence.' }], uncertainties: [] });
  const outputs = ['not json', valid, 'still not json', 'also not json'];
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    const content = outputs[requests++] ?? 'unexpected';
    const event = `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
    return new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode(event)); controller.close(); }
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const runtime = new SubagentRuntime({
      globalStorageUri: vscode.Uri.file(directory), workspaceKey: 'workspace',
      sourceStore: new ModelSourceStore(vscode.Uri.file(directory))
    });
    const first = await runtime.delegateTask({ task: 'Inspect once', profile: 'research' }, {
      parentRequest: childParentRequest(), parentRunId: 'run-one', language: 'en'
    });
    assert.equal(JSON.parse(first.content).ok, true);
    assert.equal(requests, 2);
    const second = await runtime.delegateTask({ task: 'Inspect twice', profile: 'research' }, {
      parentRequest: { ...childParentRequest(), sessionId: 'session-two' }, parentRunId: 'run-two', language: 'en'
    });
    assert.equal(JSON.parse(second.content).errorType, 'subagent_result_rejected');
    assert.equal(requests, 4, 'a damaged result must not trigger an unbounded nudge loop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('v6 child context adds typed contracts while frozen v5 bytes stay exact and workspace changes hash', () => {
  const profile = resolveSubagentProfile({ requestedId: 'research' })!;
  const v5 = getSubagentSystemPromptForVersion('en', profile, 1, 5);
  assert.equal(createHash('sha256').update(v5).digest('hex'), 'f6e0740ce6844692c352244e5a97366a127205bb29a3334aa90fa5f535471e8e');
  const v6 = getSubagentSystemPromptForVersion('en', profile, 1, 6);
  assert.match(v6, /Return exactly one JSON object/u);
  assert.equal(v6.startsWith(v5), true);
  const v5Context = formatChildContextForVersion('', 'PROJECT', profile, 5);
  assert.equal(createHash('sha256').update(v5Context).digest('hex'), '25e26566f3bac7b5c3656c3806e0c96251e3f71b29a651330bf5a5ff5a13196f');
  const v5Tools = JSON.stringify(getAgentTools({
    toolNames: getChildToolNamesForRuntime(profile, 1),
    requestProtocolVersion: 5
  }));
  assert.equal(createHash('sha256').update(v5Tools).digest('hex'), '69b10a5a1f00f5fc264b0a9e2ecef1785f15f19afba2dab826569a6ae4958b3e');
  const roots = workspaceRoots();
  const first = createStableWorkspaceContext(roots);
  const second = createStableWorkspaceContext([...roots, {
    id: 'root-c', name: 'third', uri: vscode.Uri.file('/workspace/third'), caseSensitive: true
  }]);
  assert.notEqual(first.hash, second.hash);
  assert.doesNotMatch(first.text, /\/workspace\//u);
});

test('completed-result index requires exact compatibility, same session, and fresh read fingerprints', async () => {
  const directory = await temporaryDirectory('keepseek-subagent-reuse-');
  const filePath = path.join(directory, 'a.ts');
  await writeFile(filePath, 'stable', 'utf8');
  const store = new SubagentStore(vscode.Uri.file(directory), 'workspace');
  const metadata = reusableMetadata(vscode.Uri.file(filePath).toString(), hash('stable'));
  await store.save(metadata, {
    version: 1, metadataId: metadata.id, contextInstructions: '', messages: [], result: JSON.stringify(metadata.resultEnvelope)
  });
  const query = candidateQuery();
  assert.equal((await store.findCompletedCandidates(query)).length, 1);
  for (const field of ['modelId', 'toolSchemaHash', 'profileHash', 'projectInstructionsHash', 'authorizationContextHash', 'workspaceContextHash'] as const) {
    assert.equal((await store.findCompletedCandidates({ ...query, [field]: `changed-${field}` })).length, 0, field);
  }
  assert.equal((await store.findCompletedCandidates({ ...query, parentSessionId: 'other-session' })).length, 0);
  assert.equal(await verifyStoredSubagentFreshness(metadata), 'fresh');
  await writeFile(filePath, 'changed', 'utf8');
  assert.equal(await verifyStoredSubagentFreshness(metadata), 'stale');
  assert.equal(await verifyStoredSubagentFreshness({ ...metadata, readSetComplete: false }), 'unverified');
});

test('runtime reuses only an exact fresh result and invalidates it after a file change', async () => {
  const directory = await temporaryDirectory('keepseek-subagent-runtime-reuse-');
  const filePath = path.join(directory, 'a.ts');
  await writeFile(filePath, 'stable', 'utf8');
  const originalFolders = vscode.workspace.workspaceFolders;
  const originalFetch = globalThis.fetch;
  (vscode.workspace as unknown as { workspaceFolders: Array<{ uri: vscode.Uri; name: string }> }).workspaceFolders = [
    { uri: vscode.Uri.file(directory), name: 'root' }
  ];
  let requests = 0;
  globalThis.fetch = (async () => {
    requests += 1;
    return requests % 2 === 1
      ? chatStream({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: `read-${requests}`,
        type: 'function',
        function: { name: READ_WORKSPACE_FILE_TOOL_NAME, arguments: JSON.stringify({ path: 'a.ts' }) }
      }] }, finish_reason: 'tool_calls' }] })
      : chatStream({ choices: [{ delta: { content: JSON.stringify({
        taskHash: hash('Read A'), status: 'complete', summary: 'Read A.', evidence: [{ claim: 'A was read.', path: 'a.ts' }], uncertainties: []
      }) }, finish_reason: 'stop' }] });
  }) as typeof fetch;
  try {
    const runtime = new SubagentRuntime({
      globalStorageUri: vscode.Uri.file(directory), workspaceKey: 'workspace',
      sourceStore: new ModelSourceStore(vscode.Uri.file(directory))
    });
    const parent = childParentRequest();
    const first = JSON.parse((await runtime.delegateTask({ task: 'Read A', profile: 'research' }, {
      parentRequest: parent, parentRunId: 'run-one', language: 'en'
    })).content);
    assert.equal(first.kind, 'subagent_result');
    const second = JSON.parse((await runtime.delegateTask({ task: 'Read A', profile: 'research' }, {
      parentRequest: parent, parentRunId: 'run-two', language: 'en'
    })).content);
    assert.equal(second.kind, 'subagent_reused_result');
    assert.equal(second.sourceSubagentId, first.subagentId);
    assert.equal(second.freshness, 'fresh');
    assert.equal(requests, 2);

    await writeFile(filePath, 'changed', 'utf8');
    const third = JSON.parse((await runtime.delegateTask({ task: 'Read A', profile: 'research' }, {
      parentRequest: parent, parentRunId: 'run-three', language: 'en'
    })).content);
    assert.equal(third.kind, 'subagent_result');
    assert.equal(third.reuseCandidate.freshness, 'stale');
    assert.equal(requests, 4);
  } finally {
    globalThis.fetch = originalFetch;
    (vscode.workspace as unknown as { workspaceFolders: typeof originalFolders }).workspaceFolders = originalFolders;
  }
});

test('profile model settings persist per workspace/profile with exact source identity', async () => {
  const directory = await temporaryDirectory('keepseek-subagent-profile-model-');
  const store = new SubagentSettingsStore(vscode.Uri.file(directory), 'workspace-a');
  await store.save({ mode: 'fixed', sourceId: 'cheap-account', modelId: 'same-model' }, 'research');
  await store.save({ mode: 'fixed', sourceId: 'strong-account', modelId: 'same-model' }, 'review');
  assert.equal((await store.load()).mode, 'follow-main');
  assert.equal((await store.load('research')).sourceId, 'cheap-account');
  assert.equal((await store.load('review')).sourceId, 'strong-account');
  assert.equal((await new SubagentSettingsStore(vscode.Uri.file(directory), 'workspace-b').load('research')).mode, 'follow-main');
});

test('progress and diagnostics expose only bounded whitelisted state and restart stops uncertain runs', async () => {
  const view = toSubagentProgressViewModel({
    id: 'sa_safe', parentSessionId: 'session', parentRunId: 'run', parentToolCallId: 'call_1',
    profile: 'research', lane: 'research-read', depth: 1, status: 'failed', phase: 'failed',
    toolCategory: 'analysis', queuedAt: '2026-01-01T00:00:00.000Z', durationMs: 20,
    diagnosticRef: 'PRIVATE DIAGNOSTIC TEXT', summary: 'PRIVATE TASK RESULT ERROR', updatedAt: '2026-01-01T00:00:01.000Z'
  });
  assert.doesNotMatch(JSON.stringify(view), /PRIVATE|summary|reasoning|toolRounds|providerReplay/u);

  const directory = await temporaryDirectory('keepseek-subagent-diagnostic-');
  const store = new SubagentStore(vscode.Uri.file(directory), 'workspace');
  const diagnostic = await store.saveDiagnostic({
    parentSessionId: 'session', subagentId: 'sa_safe', parentRunId: 'run', kind: 'provider_failure',
    reasonCode: 'provider_failure', summary: 'apiKey=VERY_SECRET /Users/person/private/project/file.ts failed\nwith token=OTHER_SECRET'
  });
  assert.ok(diagnostic.sizeBytes < 4_096);
  const diagnosticValue = await store.readDiagnostic({ parentSessionId: 'session', subagentId: 'sa_safe', diagnosticId: diagnostic.id });
  assert.doesNotMatch(JSON.stringify(diagnosticValue), /VERY_SECRET|OTHER_SECRET|\/Users\/person/u);

  const running = { ...reusableMetadata('file:///workspace/a.ts', hash('x')), id: 'sa_running', status: 'running' as const };
  await store.save(running, { version: 1, metadataId: running.id, contextInstructions: '', messages: [], result: '' });
  const interrupted = (await store.read('session', running.id))?.metadata;
  assert.equal(interrupted?.status, 'stopped');
  assert.equal(interrupted?.failureKind, 'interrupted');
  assert.equal(interrupted?.resultStatus, 'failed');
});

function workspaceRoots(): WorkspaceScopeRoot[] {
  return [
    { id: 'root-a', name: 'first', uri: vscode.Uri.file('/workspace/first'), caseSensitive: true },
    { id: 'root-b', name: 'second', uri: vscode.Uri.file('/workspace/second'), caseSensitive: true }
  ];
}

function pathScope(rootId: string, segments: string[]): ProposalPathScope {
  return { kind: 'paths', claims: [{ rootId, segments }] };
}

function reservation(ownerId: string, scope: ProposalPathScope, roots: WorkspaceScopeRoot[]) {
  return { treeId: 'tree', parentRunId: 'parent', ownerId, depth: 1, proposal: true, scope, roots };
}

function reusableMetadata(uri: string, contentHash: string): StoredSubagentMetadata {
  return {
    version: 1,
    id: 'sa_reusable', treeId: 'tree', parentSessionId: 'session', parentRunId: 'run', rootRunId: 'run',
    depth: 1, profile: 'research', lane: 'research-read', task: 'Inspect A', status: 'completed',
    sourceId: 'source', modelId: 'model', provider: 'deepseek', sourceConfigHash: 'source-hash',
    systemPromptHash: 'system-hash', toolSchemaHash: 'tool-hash', profileHash: 'profile-hash',
    projectInstructionsHash: 'project-hash', authorizationContextHash: 'authorization-hash', workspaceContextHash: 'workspace-hash', normalizedTaskHash: 'task-hash',
    resultStatus: 'complete', resultEnvelope: {
      kind: 'research', status: 'complete', summary: 'Inspected A.', evidence: [{ claim: 'A is stable.', path: 'a.ts' }], uncertainties: []
    },
    readSet: [{ uri, contentHash, sizeBytes: 6 }], readSetComplete: true,
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:01:00.000Z', completedAt: '2026-01-01T00:01:00.000Z'
  };
}

function candidateQuery() {
  return {
    parentSessionId: 'session', normalizedTaskHash: 'task-hash', profile: 'research', lane: 'research-read',
    sourceId: 'source', modelId: 'model', sourceConfigHash: 'source-hash', systemPromptHash: 'system-hash',
    toolSchemaHash: 'tool-hash', profileHash: 'profile-hash', projectInstructionsHash: 'project-hash', authorizationContextHash: 'authorization-hash', workspaceContextHash: 'workspace-hash'
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function chatStream(payload: unknown): Response {
  const event = `data: ${JSON.stringify(payload)}\n\ndata: [DONE]\n\n`;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(event)); controller.close(); }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function responsesStream(events: Array<Record<string, unknown>>): Response {
  const text = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function anthropicStream(events: Array<Record<string, unknown>>): Response {
  const text = events.map((event) => `event: ${String(event.type ?? '')}\ndata: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close(); }
  }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function childParentRequest(): AgentRequest {
  return {
    prompt: 'Parent',
    model: { id: 'model', label: 'Model', provider: 'deepseek', sourceId: 'source' },
    settings: { thinkingEnabled: true, reasoningEffort: 'max', compressionThreshold: 'balanced' },
    contextFiles: [], history: [], language: 'en', sessionId: 'session',
    sourceConfig: {
      sourceId: 'source', provider: 'deepseek', apiKey: 'test', baseUrl: 'https://provider.invalid/v1', supportsBilling: false
    }
  };
}
