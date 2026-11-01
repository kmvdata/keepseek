import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import * as vscode from 'vscode';
import { ModelSourceStore } from '../src/accounts/accountStore';
import { createSubagentHostContext, normalizeSubagentHostContext, resolveInheritedSubagentHostContext } from '../src/agent/subagents/contextCapsule';
import { createStableWorkspaceContext } from '../src/agent/subagents/pathScope';
import { SubagentRuntime } from '../src/agent/subagents/runtime';
import { SubagentStore } from '../src/agent/subagents/store';
import { createRunCheckpoint, normalizeRunCheckpoint, recoveryBlocker } from '../src/agent/runCheckpoint';
import type { AgentRequest } from '../src/shared/types';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');

test('nested runtime inherits activated profiles and project constraints without parent or unselected Skill text in Provider payloads', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keepseek-p1-inheritance-'));
  const originalFetch = globalThis.fetch;
  const bodies: Array<{ messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> }> = [];
  globalThis.fetch = (async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const count = bodies.length;
    const boundHash = /taskHash: ([a-f0-9]{64})/.exec(bodies.at(-1)!.messages.find(message => message.role === 'user')?.content ?? '')?.[1];
    const nestedId = /"subagentId"\s*:\s*"(sa_[^"]+)"/.exec(bodies.at(-1)!.messages.filter(message => message.role === 'tool').map(message => message.content).join('\n'))?.[1];
    const delta = count === 1 ? { tool_calls: [{ index: 0, id: 'assess-call', type: 'function', function: {
      name: 'keepseek_delegation_checkpoint', arguments: JSON.stringify({ action: 'assess', trigger: 'initial', decision: 'delegate', reason: 'An independent nested scope needs only read evidence.', candidates: [{ id: 'nested', goal: 'Nested question', scope: ['workspace'], inputs: [], dependsOn: [], capabilities: ['read'], acceptance: ['Cite observed project constraints.'] }] })
    } }, { index: 1, id: 'nested-call', type: 'function', function: {
      name: 'keepseek_delegate_task', arguments: JSON.stringify({ candidateId: 'nested', task: 'Nested question', profile: 'custom-writer' })
    } }] } : count === 3 ? { tool_calls: [{ index: 0, id: 'accept-call', type: 'function', function: {
      name: 'keepseek_delegation_checkpoint', arguments: JSON.stringify({ action: 'accept', decision: 'adopt', subagentId: nestedId, reason: 'The complete result answers the scoped question with constraints and leaves no required work.' })
    } }] } : { content: JSON.stringify({ taskHash: boundHash, status: 'complete',
      summary: 'The isolated scope was inspected with concrete constraints.', evidence: [{ claim: 'Project constraints are present in this request.' }], uncertainties: [] }) };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: count === 1 || count === 3 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'Content-Type': 'text/event-stream' } });
  }) as typeof fetch;
  try {
    const uri = vscode.Uri.file(dir);
    const runtime = new SubagentRuntime({ globalStorageUri: uri, workspaceKey: 'inheritance', sourceStore: new ModelSourceStore(uri) });
    const parent = parentRequest();
    const response = JSON.parse((await runtime.delegateTask({ task: 'Root question', profile: 'custom-read' },
      { parentRequest: parent, parentRunId: 'root-run', language: 'en' })).content);
    assert.equal(response.ok, true);
    assert.equal(bodies.length, 4);
    assert.match(JSON.stringify(bodies[0]), /SELECTED READ PROFILE/);
    assert.doesNotMatch(JSON.stringify(bodies[0]), /SELECTED WRITER PROFILE/);
    assert.match(JSON.stringify(bodies[1]), /SELECTED WRITER PROFILE/);
    for (const body of bodies) {
      assert.match(JSON.stringify(body), /PROJECT CONSTRAINT/);
      assert.doesNotMatch(JSON.stringify(body), /PARENT HISTORY|PARENT STABLE|PARENT ATTACHMENT|UNSELECTED SKILL|fixture-key/);
    }
    const nestedTools = bodies[1].tools.map(tool => tool.function.name);
    for (const name of ['keepseek_delegate_task', 'keepseek_delegate_parallel', 'keepseek_create_draft_edit', 'keepseek_run_draft']) {
      assert.equal(nestedTools.includes(name), false, name);
    }
    assert.equal(nestedTools.includes('keepseek_read_workspace_file'), true);
    const saved = await new SubagentStore(uri, 'inheritance').read('session', response.subagentId);
    assert.ok(saved?.metadata.hostContextHash);
    assert.ok(normalizeSubagentHostContext(saved?.transcript.checkpoint?.request.subagentHostContext));
    const inspection = await runtime.inspectResult(response.subagentId, { parentRequest: parent, parentRunId: 'root-run', language: 'en' });
    assert.equal(inspection?.resultHash, saved?.metadata.resultHash);
    assert.equal(inspection?.formatAccepted, true);
    assert.equal(inspection?.resultStatus, 'complete');
    const nestedStored = saved?.transcript.messages.at(-1)?.toolRounds?.[0]?.toolResults;
    assert.ok(nestedStored?.length, 'private parent child transcript retains bounded nested handoff');
    const continuation = await runtime.delegateTask({ task: 'Root question', continueSubagentId: response.subagentId },
      { parentRequest: parentRequest('CHANGED PROJECT CONSTRAINT'), parentRunId: 'root-next', language: 'en' });
    assert.equal(JSON.parse(continuation.content).errorType, 'subagent_continuation_incompatible');
    assert.equal(bodies.length, 4, 'incompatible continuation makes no Provider request');
  } finally { globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); }
});

test('host capsule is stable, whitelisted, scope-bound and checkpoint recovery fails closed without proof', () => {
  const request = parentRequest();
  const workspace = createStableWorkspaceContext([]);
  const capsule = createSubagentHostContext(request, workspace);
  const reordered = parentRequest();
  reordered.currentRunContext!.skills.reverse();
  assert.deepEqual(createSubagentHostContext(reordered, workspace), capsule);
  assert.doesNotMatch(JSON.stringify(capsule), /fixture-key|PARENT HISTORY|PARENT ATTACHMENT|PARENT STABLE|UNSELECTED SKILL/);
  const nested: AgentRequest = { ...request, currentRunContext: undefined, subagentHostContext: capsule,
    subagentContext: { id: 'child', treeId: 'tree', rootRunId: 'root', parentRunId: 'parent', parentSessionId: 'session', depth: 1, profile: 'custom-read', lane: 'research-read' } };
  assert.ok(resolveInheritedSubagentHostContext(nested, workspace));
  assert.equal(resolveInheritedSubagentHostContext({ ...nested, authorizedExternalReferenceUris: ['file:///extra'] }, workspace), undefined);
  assert.equal(normalizeSubagentHostContext({ ...capsule, profiles: [] }), undefined);
  const cp = createRunCheckpoint(nested, 0, 'test', []);
  assert.ok(normalizeRunCheckpoint(cp));
  delete cp.request.subagentHostContext;
  assert.ok(normalizeRunCheckpoint(cp), 'legacy audit record remains readable');
  assert.match(recoveryBlocker(cp)!, /inheritance|controlled|继承/);
});

test('profile inheritance cannot enable inactive profiles, undeclared proposal capability, planning writes or untrusted delegation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'keepseek-p1-inheritance-gates-'));
  const originalFetch = globalThis.fetch;
  const workspace = vscode.workspace as unknown as { isTrusted: boolean; workspaceFolders: typeof vscode.workspace.workspaceFolders };
  const previousTrust = workspace.isTrusted;
  const previousFolders = workspace.workspaceFolders;
  workspace.workspaceFolders = [];
  let providerCalls = 0;
  globalThis.fetch = (async () => { providerCalls++; throw new Error('Preflight must reject before Provider dispatch'); }) as typeof fetch;
  try {
    const uri = vscode.Uri.file(dir);
    const runtime = new SubagentRuntime({ globalStorageUri: uri, workspaceKey: 'inheritance-gates', sourceStore: new ModelSourceStore(uri) });
    const invoke = async (request: AgentRequest, profile: string, assessedCapabilities?: Array<'read' | 'review' | 'proposal'>) => JSON.parse((await runtime.delegateTask(
      { task: 'Bounded task', profile, assessedCapabilities }, { parentRequest: request, parentRunId: 'root', language: 'en' })).content);
    const nested = parentRequest();
    nested.subagentHostContext = createSubagentHostContext(nested, createStableWorkspaceContext([]));
    nested.currentRunContext = undefined;
    nested.subagentContext = { id: 'child', treeId: 'tree', rootRunId: 'root', parentRunId: 'parent', parentSessionId: 'session', depth: 1, profile: 'custom-read', lane: 'research-read' };
    assert.equal((await invoke(nested, 'inactive-profile')).errorType, 'subagent_profile_not_found');
    assert.equal((await invoke({ ...nested, subagentHostContext: undefined }, 'research')).errorType, 'subagent_context_incompatible');
    assert.equal((await invoke({ ...parentRequest(), executionMode: 'plan' }, 'custom-writer')).errorType, 'plan_phase_implementation_blocked');
    assert.equal((await invoke(parentRequest(), 'custom-writer', ['read'])).errorType, 'delegation_capability_mismatch');
    workspace.isTrusted = false;
    assert.equal((await invoke(parentRequest(), 'research')).errorType, 'workspace_untrusted');
    assert.equal(providerCalls, 0);
  } finally { workspace.isTrusted = previousTrust; workspace.workspaceFolders = previousFolders; globalThis.fetch = originalFetch; await rm(dir, { recursive: true, force: true }); }
});

function parentRequest(projectText = 'PROJECT CONSTRAINT'): AgentRequest {
  return { prompt: 'Parent goal', model: { id: 'model', label: 'Model', provider: 'deepseek', sourceId: 'source', contextWindowTokens: 64000, maxOutputTokens: 2000 },
    settings: { thinkingEnabled: true, reasoningEffort: 'max', compressionThreshold: 'balanced' }, contextFiles: [],
    contextInstructions: 'PARENT STABLE', history: [{ id: 'parent-message', role: 'user', content: 'PARENT HISTORY', createdAt: '2026-11-01' }],
    language: 'en', sessionId: 'session', sourceConfig: { sourceId: 'source', provider: 'deepseek', apiKey: 'fixture-key', baseUrl: 'https://provider.invalid/v1', supportsBilling: false },
    currentRunContext: { projectInstructions: [{ id: 'rules', uri: 'file:///AGENTS.md', workspaceFolder: 'workspace', content: projectText, contentHash: hash(projectText), characterCount: projectText.length, tokenEstimate: 5, truncated: false }],
      skills: [
        { id: 'read-skill', name: 'Custom reader', source: 'workspace', rootUri: 'file:///reader', skillUri: 'file:///reader/SKILL.md', content: 'SELECTED READ PROFILE', runAs: 'subagent', subagentProfile: { id: 'custom-read', canDelegate: true } },
        { id: 'writer-skill', name: 'Custom writer', source: 'workspace', rootUri: 'file:///writer', skillUri: 'file:///writer/SKILL.md', content: 'SELECTED WRITER PROFILE', runAs: 'subagent', subagentProfile: { id: 'custom-writer', tools: ['keepseek_read_workspace_file', 'keepseek_create_draft_edit', 'keepseek_run_draft'] } },
        { id: 'unselected-skill', name: 'Other', source: 'workspace', rootUri: 'file:///other', skillUri: 'file:///other/SKILL.md', content: 'UNSELECTED SKILL' }
      ], metadata: { precedence: [], beforeDeduplicationCount: 0, afterDeduplicationCount: 0, totalCharacterCount: 0, totalTokenEstimate: 0, truncated: false, sources: [], discarded: [], possibleConflicts: [] } } };
}
