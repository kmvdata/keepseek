import './registerVscodeStub';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import * as vscode from './stubs/vscode';
import { AgentRunner } from '../src/agent/runner';
import { formatActiveSkills, getAgentSystemPrompt, getAgentTools, getAgentToolNamesForPrompt, READ_PLUGIN_SKILL_TOOL_NAME, READ_SUBAGENT_RESULT_TOOL_NAME } from '../src/agent/protocol';
import { buildProviderPayloadProjection, buildProviderRequestProjection, CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION, CURRENT_PROVIDER_TOOL_SCHEMA_VERSION } from '../src/agent/providerRequestProjection';
import { ToolEvidenceStore } from '../src/agent/evidence/store';
import { prepareEvidenceEnvelope } from '../src/agent/evidence/shaping';
import { visibleProgressFingerprint } from '../src/agent/contextEpoch';
import type { AgentRequest } from '../src/shared/types';
import type { SubagentToolAdapter } from '../src/agent/subagents/types';
import { discoverCodexPlugins } from '../src/skills/codexPluginDiscovery';
import { pinCodexPluginSkill, readCodexPluginResource } from '../src/skills/codexPluginResources';
import { CODEX_PLUGIN_SKILLS_UNAVAILABLE } from '../src/skills/codexPluginSupport';
import { toActivatedSkill, type SkillManifest } from '../src/skills/skillTypes';
import { AgentInterruptedError, createRunCheckpoint, normalizeRunCheckpoint } from '../src/agent/runCheckpoint';
import { assertPluginSkillsCurrent, executePluginSkillRead } from '../src/agent/pluginSkillRuntime';

test('canonical child page admission delivers a contiguous UTF-8 prefix, blocking without advancing at zero capacity', async () => {
  const store = new ToolEvidenceStore();
  const text = '中文🙂"\\\n'.repeat(600);
  let offset = 0, delivered = '';
  for (let index = 0; index < 100; index++) {
    const content = Buffer.from(text).subarray(offset).toString('utf8');
    const raw = JSON.stringify({ ok: true, ref: 'sa_root', offsetBytes: offset, content,
      returnedBytes: Buffer.byteLength(content), totalBytes: Buffer.byteLength(text), hasMore: false,
      resultHash: 'immutable-hash', resultStatus: 'complete', formatAccepted: true });
    const record = await store.complete(await store.ensureIntent({ sessionId: 's', taskId: 't', toolCallId: `read-${index}`,
      toolName: READ_SUBAGENT_RESULT_TOOL_NAME, argumentsHash: String(offset), effectKind: 'read' }), raw);
    const blocked = JSON.parse(prepareEvidenceEnvelope({ record, rawContent: raw, inlineTokenAllowance: 0, inlineCharLimit: 1100 }).content);
    assert.equal(blocked.errorType, 'subagent_result_capacity_blocked');
    assert.equal(blocked.bodyDelivered, false); assert.equal(blocked.offsetBytes, offset);
    assert.equal(blocked.nextOffsetBytes, undefined); assert.equal(blocked.ref, 'sa_root');
    assert.equal(blocked.evidenceRef, undefined, 'never reference the read evidence instead of canonical bytes');
    const shaped = prepareEvidenceEnvelope({ record, rawContent: raw, inlineTokenAllowance: 700, inlineCharLimit: 1100 });
    const page = JSON.parse(shaped.content);
    assert.ok(page.content.length > 0); assert.ok(!page.content.includes('\ufffd'));
    assert.equal(page.returnedBytes, Buffer.byteLength(page.content));
    delivered += page.content;
    const fingerprint = visibleProgressFingerprint(READ_SUBAGENT_RESULT_TOOL_NAME, shaped.content);
    assert.ok(fingerprint);
    assert.equal(fingerprint, visibleProgressFingerprint(READ_SUBAGENT_RESULT_TOOL_NAME, JSON.stringify({ ...page, ref: 'different-id' })));
    await store.saveProviderEnvelope(record, shaped.content, shaped.completeInline);
    if (!page.hasMore) break;
    assert.equal(page.nextOffsetBytes, offset + Buffer.byteLength(page.content));
    offset = page.nextOffsetBytes;
  }
  assert.equal(delivered, text);
  assert.equal(visibleProgressFingerprint('keepseek_delegation_checkpoint', '{"ok":true}'), undefined);
  const manifest = { kind: 'subagent_result_manifest', resultHash: 'same', resultStatus: 'complete', formatAccepted: true,
    summary: 'The required symbol is defined at src/a.ts:1.', preview: '', subagentId: 'first', usageSummary: { totalTokens: 100 }, model: { modelId: 'one' } };
  assert.equal(visibleProgressFingerprint('keepseek_delegate_task', JSON.stringify(manifest)),
    visibleProgressFingerprint('keepseek_delegate_task', JSON.stringify({ ...manifest, subagentId: 'reused',
      reusedFromSubagentId: 'first', usageSummary: { totalTokens: 0 }, model: { modelId: 'two' } })));
});

test('canonical page bytes reach actual mocked Chat/Responses/Anthropic/DSML requests after evidence admission', async () => {
  const originalFetch = globalThis.fetch;
  const originalConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = () => ({ get: <T>(key: string, fallback: T): T => key === 'providerInlineResultMaxChars' ? 1200 as T : fallback, update: async () => undefined });
  const content = '只交付必要页🙂"\\\n'.repeat(800);
  const raw = JSON.stringify({ ok: true, ref: 'sa_result', subagentId: 'sa_result', content,
    offsetBytes: 0, returnedBytes: Buffer.byteLength(content), totalBytes: Buffer.byteLength(content),
    hasMore: false, resultHash: 'result-hash', resultStatus: 'complete', formatAccepted: true });
  const call = { id: 'read-page', type: 'function' as const, function: { name: READ_SUBAGENT_RESULT_TOOL_NAME, arguments: '{"ref":"sa_result"}' } };
  try {
    for (const format of ['chat', 'responses', 'anthropic', 'dsml'] as const) {
      const bodies: Record<string, unknown>[] = [];
      globalThis.fetch = (async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return response(format, bodies.length === 1, call);
      }) as typeof fetch;
      let reads = 0;
      const adapter: SubagentToolAdapter = { delegateTask: async () => { throw new Error('Unexpected delegate'); },
        delegateParallel: async () => { throw new Error('Unexpected parallel'); }, readResult: async () => { reads++; return { content: raw }; } };
      const provider = format === 'responses' ? 'openai-responses' : format === 'anthropic' ? 'anthropic-compatible' : 'openai-compatible';
      const result = await new AgentRunner(undefined, undefined, undefined, undefined, undefined, undefined, undefined, adapter).run(request(provider));
      assert.equal(reads, 1, format); assert.equal(bodies.length, 2, format);
      const visibleStrings = strings(bodies[1]);
      const serialized = visibleStrings.find(value => value.includes('"returnedBytes"') && value.includes('sa_result'));
      assert.ok(serialized, format);
      const pageText = format === 'dsml' ? /\{[\s\S]*\}/u.exec(serialized)?.[0] : serialized;
      assert.ok(pageText);
      // DSML wraps tool data in a JSON array. Locate the delivered object from
      // the persisted tool round as the common authority, then match wire bytes.
      const delivered = result.toolRounds?.flatMap(round => round.toolResults)[0]?.content
        ?? serialized.slice(serialized.indexOf('{"ok"'));
      assert.ok(delivered, format); assert.ok(serialized.includes(delivered) || serialized.includes(JSON.stringify(delivered).slice(1, -1)), format);
      const page = JSON.parse(delivered);
      assert.ok(page.content.length > 0 && page.content.length < content.length, format);
      assert.equal(page.nextOffsetBytes, Buffer.byteLength(page.content)); assert.equal(page.hasMore, true);
      assert.equal(page.ref, 'sa_result'); assert.equal(page.evidenceRef, undefined);
      assert.equal(page.resultStatus, 'complete'); assert.equal(page.formatAccepted, true);
    }
  } finally { globalThis.fetch = originalFetch; vscode.workspace.getConfiguration = originalConfiguration; }
});

function request(provider: 'openai-compatible' | 'openai-responses' | 'anthropic-compatible'): AgentRequest {
  return { prompt: 'Read the necessary child detail.', model: { id: 'fixture', label: 'Fixture', sourceId: 'source', provider,
    contextWindowTokens: 64000, maxOutputTokens: 2000 }, settings: { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' },
    history: [], contextFiles: [], language: 'en', sessionId: 's', requestProtocolVersion: 11,
    sourceConfig: { sourceId: 'source', provider, baseUrl: 'https://fixture.invalid/v1', apiKey: 'fixture', supportsBilling: false },
    executionLimits: { maxToolIterations: 2 } };
}
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(strings);
}
function response(format: 'chat' | 'responses' | 'anthropic' | 'dsml', tool: boolean, call: { id: string; function: { name: string; arguments: string } }): Response {
  let events: object[];
  if (format === 'responses') events = [{ type: 'response.completed', response: { status: 'completed', output: tool
    ? [{ type: 'function_call', id: 'fc', call_id: call.id, ...call.function }]
    : [{ type: 'message', id: 'final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.' }] }] } }];
  else if (format === 'anthropic') {
    events = [{ type: 'message_start', message: { usage: { input_tokens: 10 } } }, { type: 'content_block_start', index: 0, content_block: tool
      ? { type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) } : { type: 'text', text: 'Done.' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' } }, { type: 'message_stop' }];
  } else {
    const delta = !tool ? { content: 'Done.' } : format === 'dsml'
      ? { content: `<||DSML||tool_calls><||DSML||invoke name="${call.function.name}"><||DSML||parameter name="ref" string="true">sa_result</||DSML||parameter></||DSML||invoke></||DSML||tool_calls>` }
      : { tool_calls: [{ index: 0, ...call, type: 'function' }] };
    events = [{ choices: [{ delta, finish_reason: tool && format !== 'dsml' ? 'tool_calls' : 'stop' }] }];
  }
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + (format === 'chat' || format === 'dsml' ? 'data: [DONE]\n\n' : ''),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}
