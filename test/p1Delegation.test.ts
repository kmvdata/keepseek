import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { SubagentRuntime } from '../src/agent/subagents/runtime';
import { WorkspaceToolService } from '../src/agent/tools/workspaceTools';
import { DelegationTracker, normalizeDelegationState, type DelegationCandidate } from '../src/agent/delegation';
import { AgentLoop } from '../src/agent/runner';
import { DELEGATE_TASK_TOOL_NAME, DELEGATE_PARALLEL_TOOL_NAME, DELEGATION_CHECKPOINT_TOOL_NAME } from '../src/agent/protocol';
import type { AgentRequest } from '../src/shared/types';
import type { SubagentToolAdapter } from '../src/agent/subagents/types';

const candidate = (id: string, dependsOn: string[] = []): DelegationCandidate => ({
  id, goal: `Investigate module ${id}`, scope: [`src/${id}.ts`], inputs: [], dependsOn,
  capabilities: ['read'], acceptance: ['Return concrete file evidence, uncertainty and remaining work.']
});
const assess = (candidates: DelegationCandidate[]) => ({ action: 'assess', trigger: 'initial', decision: 'delegate', reason: 'Independent bounded module investigation.', evidence: [], candidates });
const manifest = (id: string, status = 'complete') => ({ version: 3, ok: true, kind: 'subagent_result_manifest', status: 'completed', subagentId: id, resultRef: id,
  resultHash: 'a'.repeat(64), resultStatus: status, formatAccepted: true, profile: 'research', lane: 'research-read', summary: 'Bounded module finding with explicit limitations.', preview: '', hasMore: true });

test('delegation contract rejects dependent parallel branches, cycles and undeclared proposal paths', () => {
  const tracker = new DelegationTracker(undefined, undefined, () => undefined);
  tracker.assess(assess([candidate('a'), candidate('b', ['a'])]));
  assert.throws(() => tracker.prepare([{ task: 'Read a', candidateId: 'a' }, { task: 'Read b', candidateId: 'b' }]), /sequentially/u);
  assert.throws(() => tracker.prepare([{ task: 'Read b', candidateId: 'b' }]), /not been accepted/u);
  assert.throws(() => tracker.prepare([{ task: 'Write', candidateId: 'a', profile: 'proposal' }]), /capability/u);
  assert.throws(() => tracker.prepare([{ task: 'Read a', candidateId: 'a', paths: ['outside.ts'] }]), /scope/u);
  assert.throws(() => tracker.assess(assess([candidate('c', ['d']), candidate('d', ['c'])])), /Cyclic/u);
  assert.throws(() => tracker.assess(assess([candidate('z', ['unknown'])])), /Unknown dependency/u);
  assert.equal(tracker.snapshot().events.at(-1)?.kind, 'host_contract_rejected');
});

test('parent acceptance binds returned identity and canonical hash; partial never satisfies dependency', () => {
  const tracker = new DelegationTracker(undefined, undefined, () => undefined);
  tracker.assess(assess([candidate('a'), candidate('b', ['a'])]));
  tracker.returned([{ task: 'Read a', candidateId: 'a' }], JSON.stringify(manifest('child-a', 'partial')));
  const decision = { subagentId: 'child-a', decision: 'adopt', reason: 'Reviewed the key evidence.' };
  const authority = { subagentId: 'child-a', resultHash: 'a'.repeat(64), resultStatus: 'partial' as const, formatAccepted: true };
  assert.throws(() => tracker.accept(decision, authority), /Partial/u);
  assert.throws(() => tracker.accept({ ...decision, subagentId: 'other' }, authority), /returned/u);
  assert.throws(() => tracker.accept(decision, { ...authority, resultHash: 'b'.repeat(64), resultStatus: 'complete' }), /matching/u);
  tracker.accept({ ...decision, decision: 'investigate' }, authority);
  assert.throws(() => tracker.prepare([{ task: 'Read b', candidateId: 'b' }]), /not been accepted/u);
  assert.equal(tracker.finalize().pending, 2, 'partial a and unreturned dependent b both remain unresolved');
  const restored = new DelegationTracker(JSON.parse(JSON.stringify(tracker.snapshot())), undefined, () => undefined);
  assert.equal(restored.snapshot().results[0]?.resultStatus, 'partial');
  assert.equal(normalizeDelegationState({ ...tracker.snapshot(), version: 77 }), undefined);
  assert.equal(normalizeDelegationState({ ...tracker.snapshot(), results: [{ ...tracker.snapshot().results[0], acceptance: 'adopt' }] }), undefined);
});

test('accepted dependency permits a sequential self-contained brief without copying parent state', () => {
  const tracker = new DelegationTracker(undefined, undefined, () => undefined);
  tracker.assess(assess([candidate('a'), candidate('b', ['a'])]));
  tracker.returned([{ task: 'Read a', candidateId: 'a' }], JSON.stringify(manifest('child-a')));
  tracker.accept({ subagentId: 'child-a', decision: 'adopt', reason: 'Read the summary and checked file evidence.' }, {
    subagentId: 'child-a', resultHash: 'a'.repeat(64), resultStatus: 'complete', formatAccepted: true
  });
  const task = tracker.prepare([{ task: 'Inspect exact symbol and state uncertainty.', candidateId: 'b' }])[0]!.task;
  assert.match(task, /Scope: src\/b.ts/u);
  assert.match(task, /Dependencies already accepted: a/u);
  assert.match(task, /Acceptance:/u);
  assert.equal(tracker.finalize().pending, 1, 'the prepared second candidate still needs a returned and accepted result');
  const snapshot = tracker.snapshot();
  snapshot.results[0]!.acceptance = 'reject';
  assert.equal(tracker.snapshot().results[0]?.acceptance, 'adopt', 'caller snapshots never share mutable plan state');
});

test('scope expansion observations are bounded and distinct from model independence judgments', () => {
  const tracker = new DelegationTracker(undefined, undefined, () => undefined);
  for (const name of ['a', 'b', 'c', 'd']) tracker.observeScope('keepseek_read_workspace_file_range', JSON.stringify({ path: name }));
  assert.equal(tracker.snapshot().events.filter((item) => item.kind === 'scope_expanded').length, 1);
  const warned = JSON.parse(tracker.attachScopeNotice(JSON.stringify({ ok: false, error: 'No content obtained.' })));
  assert.match(warned.delegationNotice, /does not establish successful reads/u);
  assert.equal(warned.ok, false);
  assert.equal(tracker.attachScopeNotice('{"ok":true}'), '{"ok":true}', 'the notice is attached once, preserving subsequent bytes');
  assert.equal(tracker.snapshot().assessment, undefined);
  for (let index = 0; index < 70; index++) tracker.assess({ action: 'assess', trigger: 'initial', decision: 'local', reason: 'A small local task.', evidence: [], candidates: [] });
  assert.equal(tracker.snapshot().events.length, 32);
  assert.equal(tracker.finalize().explicitUnfulfilled, false);
});

test('a verified complete follow-up can supersede a partial result without rewriting its audit status', () => {
  const tracker = new DelegationTracker(undefined, undefined, () => undefined);
  tracker.assess(assess([candidate('a'), candidate('b', ['a'])]));
  tracker.returned([{ task: 'Read a', candidateId: 'a' }], JSON.stringify(manifest('partial-a', 'partial')));
  tracker.accept({ subagentId: 'partial-a', decision: 'investigate', reason: 'Key evidence is missing.' }, { subagentId: 'partial-a', resultHash: 'a'.repeat(64), resultStatus: 'partial', formatAccepted: true });
  tracker.returned([{ task: 'Complete the missing evidence for a.', candidateId: 'a' }], JSON.stringify(manifest('complete-a')));
  assert.throws(() => tracker.accept({ subagentId: 'complete-a', decision: 'adopt', reason: '' }, { subagentId: 'complete-a', resultHash: 'a'.repeat(64), resultStatus: 'complete', formatAccepted: true }), /nonempty text/u);
  assert.equal(tracker.snapshot().results[1]?.acceptance, undefined, 'a rejected acceptance call cannot mutate plan completion');
  assert.throws(() => tracker.prepare([{ task: 'Now b', candidateId: 'b' }]), /not been accepted/u);
  tracker.accept({ subagentId: 'complete-a', decision: 'adopt', reason: 'The missing evidence is now provided and checked.' }, { subagentId: 'complete-a', resultHash: 'a'.repeat(64), resultStatus: 'complete', formatAccepted: true });
  assert.equal(tracker.snapshot().results[0]?.resultStatus, 'partial');
  assert.equal(tracker.snapshot().results[0]?.supersededBy, 'complete-a');
  assert.equal(tracker.finalize().pending, 1, 'only unreturned b is pending');
  assert.equal(tracker.prepare([{ task: 'Now b', candidateId: 'b' }])[0]?.candidateId, 'b');
  assert.ok(normalizeDelegationState(tracker.snapshot()));
  const tampered = tracker.snapshot(); tampered.results[0]!.supersededBy = 'partial-a';
  assert.equal(normalizeDelegationState(tampered), undefined);
  tracker.accept({ subagentId: 'complete-a', decision: 'needs_details', reason: 'New uncertainty requires another check.' }, { subagentId: 'complete-a', resultHash: 'a'.repeat(64), resultStatus: 'complete', formatAccepted: true });
  assert.equal(tracker.snapshot().results[0]?.supersededBy, undefined);
  assert.equal(tracker.finalize().pending, 3, 'retracting adoption also retracts supersession proof');
});

test('fully adopted windows can advance to new independent scope without granting dependency proof or dropping pending work', () => {
  const tracker = new DelegationTracker(undefined, undefined, () => undefined);
  for (let index = 0; index < 20; index++) {
    const id = `module-${index}`;
    tracker.assess({ ...assess([candidate(id)]), trigger: index ? 'scope_expanded' : 'initial', evidence: index ? [`src/${id}.ts`] : [] });
    tracker.returned([{ task: 'Read exact module.', candidateId: id }], JSON.stringify(manifest(`child-${id}`)));
    tracker.accept({ subagentId: `child-${id}`, decision: 'adopt', reason: 'Checked bounded evidence.' }, {
      subagentId: `child-${id}`, resultHash: 'a'.repeat(64), resultStatus: 'complete', formatAccepted: true
    });
  }
  const state = tracker.snapshot();
  assert.equal(state.candidates.length, 1); assert.equal(state.results.length, 1);
  assert.equal(state.completedWindows, 19); assert.equal(state.adoptedResultCount, 19);
  assert.equal(state.events.length, 32);
  const restored = new DelegationTracker(JSON.parse(JSON.stringify(state)), undefined, () => undefined);
  assert.throws(() => restored.assess({ ...assess([candidate('new', ['module-0'])]), trigger: 'scope_expanded', evidence: ['src/new.ts'] }), /Unknown dependency/u);
  assert.equal(restored.snapshot().results[0]?.subagentId, state.results[0]?.subagentId);
  restored.assess({ ...assess([candidate('pending')]), trigger: 'scope_expanded', evidence: ['src/pending.ts'] });
  restored.returned([{ task: 'Read pending.', candidateId: 'pending' }], JSON.stringify(manifest('child-pending', 'partial')));
  restored.assess({ ...assess([candidate('next')]), trigger: 'scope_expanded', evidence: ['src/next.ts'] });
  assert.ok(restored.snapshot().results.some((item) => item.subagentId === 'child-pending'));
  assert.equal(restored.finalize().pending, 2);
  restored.assess({ action: 'assess', trigger: 'initial', decision: 'local', reason: 'The unrequested next branch will be answered in the parent.', evidence: [], candidates: [] });
  assert.equal(restored.finalize().pending, 1, 'an explicit local decision cannot discard the returned partial result');
});

test('explicit role and parallel mode require matching host-returned facts', () => {
  for (const selection of [{ kind: 'single' as const, profile: 'review' as const }, { kind: 'parallel' as const, profile: 'research' as const }]) {
    const tracker = new DelegationTracker(undefined, selection, () => undefined);
    tracker.assess(assess([candidate('a')]));
    tracker.returned([{ candidateId: 'a', task: 'Read a' }], JSON.stringify(manifest('research-child')));
    assert.equal(tracker.finalize().explicitUnfulfilled, true);
  }
  const matching = new DelegationTracker(undefined, { kind: 'single', profile: 'review' }, () => undefined);
  matching.assess(assess([candidate('a')]));
  matching.returned([{ candidateId: 'a', task: 'Read a' }], JSON.stringify({ ...manifest('review-child'), profile: 'review', lane: 'review-read' }));
  assert.equal(matching.finalize().explicitUnfulfilled, false);
});

test('V11 deterministic Provider route assesses, dispatches, verifies and adopts without reading all result pages', async () => {
  let dispatched = 0, inspected = 0, readPages = 0;
  const inputs: string[] = [];
  const adapter: SubagentToolAdapter = {
    delegateTask: async (input) => { dispatched++; inputs.push(input.task); return { content: JSON.stringify(manifest('child-a')) }; },
    delegateParallel: async () => { throw new Error('Unexpected parallel'); },
    readResult: async () => { readPages++; throw new Error('Unexpected full result read'); },
    inspectResult: async (id) => { inspected++; return { subagentId: id, resultHash: 'a'.repeat(64), resultStatus: 'complete', formatAccepted: true }; }
  };
  const { response, bodies } = await runModelSequence([
    tool(DELEGATION_CHECKPOINT_TOOL_NAME, assess([candidate('a')])),
    tool(DELEGATE_TASK_TOOL_NAME, { candidateId: 'a', task: 'Read the requested module.', profile: 'research' }),
    tool(DELEGATION_CHECKPOINT_TOOL_NAME, { action: 'accept', subagentId: 'child-a', decision: 'adopt', reason: 'The bounded evidence answers this branch; no missing detail affects this goal.' }),
    { content: 'Integrated the bounded finding.' }
  ], adapter);
  assert.equal(dispatched, 1); assert.equal(inspected, 1); assert.equal(readPages, 0);
  assert.match(inputs[0]!, /Scope: src\/a.ts/u);
  assert.equal(response.taskPlan.status, 'completed');
  assert.equal(response.taskPlan.delegation?.results[0]?.acceptance, 'adopt');
  assert.ok(bodies.some((body) => body.includes('Bounded module finding')));
  assert.doesNotMatch(inputs[0]!, /PARENT_PRIVATE_HISTORY/u);
});

test('V11 deterministic route refuses same-batch dependencies before invoking child runtime', async () => {
  let calls = 0;
  const adapter: SubagentToolAdapter = {
    delegateTask: async () => { calls++; return { content: '{}' }; },
    delegateParallel: async () => { calls++; return { content: '{}' }; }, readResult: async () => ({ content: '{}' })
  };
  const { response } = await runModelSequence([
    tool(DELEGATION_CHECKPOINT_TOOL_NAME, assess([candidate('a'), candidate('b', ['a'])])),
    tool(DELEGATE_PARALLEL_TOOL_NAME, { tasks: [{ candidateId: 'a', task: 'Read a' }, { candidateId: 'b', task: 'Use a to read b' }] }),
    { content: 'Keep these steps sequential.' }
  ], adapter);
  assert.equal(calls, 0);
  assert.ok(response.taskPlan.delegation?.events.some((event) => event.kind === 'host_contract_rejected'));
  assert.match(JSON.stringify(response.toolRounds), /sequentially/u);
});

test('real KeepSeek runtime and durable store verify a returned child before parent adoption', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'keepseek-p1-parent-acceptance-'));
  const uri = vscode.Uri.file(directory);
  const runtime = new SubagentRuntime({ globalStorageUri: uri, workspaceKey: 'acceptance', sourceStore: new ModelSourceStore(uri) });
  const originalFetch = globalThis.fetch;
  let calls = 0, childId = '';
  globalThis.fetch = (async (_url, init) => {
    calls++;
    const body = JSON.parse(String(init?.body));
    let delta: object;
    if (calls === 1) delta = tool(DELEGATION_CHECKPOINT_TOOL_NAME, assess([candidate('a')]));
    else if (calls === 2) delta = tool(DELEGATE_TASK_TOOL_NAME, { candidateId: 'a', task: 'State the exact bounded result and its evidence limitations.', profile: 'research' });
    else if (calls === 3) {
      const task = body.messages.find((message: { role: string }) => message.role === 'user')?.content ?? '';
      const taskHash = /taskHash: ([a-f0-9]{64})/u.exec(task)?.[1];
      assert.ok(taskHash, 'child task uses its own exact host binding');
      assert.doesNotMatch(JSON.stringify(body), /PARENT_PRIVATE_HISTORY/u);
      delta = { content: JSON.stringify({ taskHash, status: 'complete', summary: 'The bounded scope is described with explicit evidence limitations.',
        evidence: [{ claim: 'The host supplied an exact bounded task; no workspace content was claimed as verified.' }], uncertainties: [] }) };
    } else if (calls === 4) {
      const content = body.messages.filter((message: { role: string }) => message.role === 'tool').map((message: { content: string }) => message.content).join('\n');
      childId = /"subagentId"\s*:\s*"(sa_[^"]+)"/u.exec(content)?.[1] ?? '';
      assert.ok(childId, 'parent receives the committed runtime result reference');
      delta = tool(DELEGATION_CHECKPOINT_TOOL_NAME, { action: 'accept', subagentId: childId, decision: 'adopt', reason: 'The exact scoped answer and reported limitations satisfy this narrow branch.' });
    } else if (calls === 5) delta = tool('keepseek_read_subagent_result', { ref: childId, offsetBytes: 0, limitBytes: 128 });
    else if (calls === 6) delta = { content: 'Integrated the scoped result; no file or command effects were requested.' };
    else throw new Error('Unexpected extra Provider request.');
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const request = createRequest();
    const response = await new AgentLoop(undefined, undefined, undefined, undefined, undefined, undefined, undefined, runtime).run(request);
    assert.equal(calls, 6);
    assert.equal(response.taskPlan.status, 'completed');
    assert.equal(response.taskPlan.delegation?.results[0]?.acceptance, 'adopt');
    const authority = await runtime.inspectResult(childId, { parentRequest: request, parentRunId: response.runId, language: 'en' });
    assert.equal(authority?.resultStatus, 'complete');
    assert.equal(authority?.formatAccepted, true);
    assert.equal(authority?.resultHash, response.taskPlan.delegation?.results[0]?.resultHash);
    const tools = response.toolRounds?.flatMap((round) => round.toolResults.map((result) => JSON.parse(result.content))) ?? [];
    const initialManifest = tools.find((result) => result.kind === 'subagent_result_manifest');
    assert.equal(initialManifest?.parentAcceptance, 'pending', 'already-delivered handoff bytes retain their original observation');
    const acceptedPage = tools.find((result) => result.ref === childId && typeof result.content === 'string');
    assert.equal(acceptedPage?.parentAcceptance, 'accepted', 'a new scoped page reflects the current parent plan acceptance');
    assert.equal(acceptedPage?.resultHash, authority?.resultHash);
    const page = JSON.parse((await runtime.readResult({ ref: childId, limitBytes: 24_576 }, { parentRequest: request, parentRunId: response.runId, language: 'en' })).content);
    assert.equal(createHash('sha256').update(page.content).digest('hex'), authority?.resultHash);
    assert.equal(response.draftEdits.length, 0);
    assert.equal(response.draftRuns?.length, 0);
  } finally { globalThis.fetch = originalFetch; await rm(directory, { recursive: true, force: true }); }
});

test('small V11 tasks directly finish; explicit unmet delegation is reported without invented rejection reason', async () => {
  const small = await runModelSequence([{ content: 'A concise direct answer.' }]);
  assert.equal(small.response.taskPlan.status, 'completed');
  assert.equal(small.bodies.length, 1);
  const explicit = await runModelSequence([{ content: 'A direct answer without dispatch.' }], undefined, true);
  assert.equal(explicit.response.taskPlan.status, 'blocked');
  assert.equal(explicit.response.taskPlan.steps.find((step) => step.id === 'respond')?.status, 'blocked');
  assert.equal(explicit.response.taskPlan.delegation?.explicitUnfulfilled, true);
  assert.match(explicit.response.message, /explicit delegation selection was not fulfilled/u);
  assert.doesNotMatch(explicit.response.message, /budget exhausted|permission denied/u);
});

test('scope expansion notice reaches the Provider once through immutable tool evidence', async () => {
  class ReadTools extends WorkspaceToolService {
    public override async readWorkspaceFile(rawPath: string): Promise<string> {
      return JSON.stringify({ ok: true, path: rawPath, content: `Scoped content for ${rawPath}` });
    }
  }
  const { response, bodies } = await runModelSequence([
    tool('keepseek_read_workspace_file', { path: 'src/a.ts' }),
    tool('keepseek_read_workspace_file', { path: 'src/b.ts' }),
    tool('keepseek_read_workspace_file', { path: 'src/c.ts' }),
    tool(DELEGATION_CHECKPOINT_TOOL_NAME, { action: 'assess', trigger: 'scope_expanded', decision: 'local', reason: 'These three short files are one dependent chain; a child would duplicate coordination.', evidence: ['src/a.ts', 'src/b.ts', 'src/c.ts'], candidates: [] }),
    { content: 'The dependent chain was inspected locally.' }
  ], undefined, false, new ReadTools());
  const contents = response.toolRounds?.flatMap((round) => round.toolResults.map((result) => result.content)) ?? [];
  assert.equal(contents.filter((content) => content.includes('delegationNotice')).length, 1);
  assert.ok(bodies[3]?.includes('delegationNotice'), 'the next actual Provider request receives the scope notice');
  assert.match(contents[2]!, /Scoped content for src\/c.ts/u, 'scope guidance preserves the requested body');
  assert.equal(response.taskPlan.delegation?.assessment?.decision, 'local');
  assert.equal(response.taskPlan.status, 'completed');
});

test('an ended partial child cannot be adopted or silently complete the parent plan', async () => {
  const adapter: SubagentToolAdapter = {
    delegateTask: async () => ({ content: JSON.stringify(manifest('child-partial', 'partial')) }),
    delegateParallel: async () => ({ content: '{}' }), readResult: async () => ({ content: '{}' }),
    inspectResult: async (id) => ({ subagentId: id, resultHash: 'a'.repeat(64), resultStatus: 'partial', formatAccepted: true })
  };
  const { response } = await runModelSequence([
    tool(DELEGATION_CHECKPOINT_TOOL_NAME, assess([candidate('a')])),
    tool(DELEGATE_TASK_TOOL_NAME, { candidateId: 'a', task: 'Read the module.' }),
    tool(DELEGATION_CHECKPOINT_TOOL_NAME, { action: 'accept', subagentId: 'child-partial', decision: 'adopt', reason: 'Try to mark it done.' }),
    { content: 'A partial result remains.' }
  ], adapter);
  assert.equal(response.taskPlan.status, 'blocked');
  assert.equal(response.taskPlan.steps.find((step) => step.id === 'respond')?.status, 'blocked');
  assert.equal(response.taskPlan.delegation?.results[0]?.acceptance, undefined);
  assert.match(JSON.stringify(response.toolRounds), /Partial, failed/u);
});

function tool(name: string, args: unknown): object {
  return { tool_calls: [{ index: 0, id: `call-${name}-${createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 12)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
}
async function runModelSequence(deltas: object[], adapter?: SubagentToolAdapter, explicit = false, workspaceTools?: WorkspaceToolService) {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(String(init?.body));
    const delta = deltas[bodies.length - 1];
    if (!delta) throw new Error('Unexpected extra Provider request.');
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  const request = createRequest();
  if (explicit) request.explicitSubagentSelection = { kind: 'single', profile: 'research' };
  try { return { response: await new AgentLoop(workspaceTools, undefined, undefined, undefined, undefined, undefined, undefined, adapter).run(request), bodies }; }
  finally { globalThis.fetch = originalFetch; }
}
function createRequest(): AgentRequest {
  return {
    prompt: 'Investigate the requested bounded module.',
    model: { id: 'model-main', label: 'Main', sourceId: 'account-main', provider: 'openai-compatible', contextWindowTokens: 64_000, maxOutputTokens: 2_000 },
    settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    history: [{ id: 'private', role: 'user', content: 'PARENT_PRIVATE_HISTORY', createdAt: new Date().toISOString() }],
    contextFiles: [], language: 'en', sessionId: 'session-one', requestProtocolVersion: 11,
    sourceConfig: { sourceId: 'account-main', provider: 'openai-compatible', baseUrl: 'https://provider.invalid/v1', apiKey: 'test-key', supportsBilling: false },
    executionLimits: { maxToolIterations: 6 }
  };
}
