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

test('P1 V11 preserves f313a00 V1–V10 system and full/slim schema bytes', async () => {
  const fixture = JSON.parse(await readFile(join(__dirname, '../../doc/benchmarks/keepseek-p1-frozen-protocol-f313a00.json'), 'utf8'));
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  for (let version = 1; version <= 10; version++) {
    const frozen = fixture.versions[version];
    for (const language of ['en', 'zh'] as const) {
      assert.equal(hash(getAgentSystemPrompt({ language: language === 'zh' ? 'zh-CN' : language, requestProtocolVersion: version })), frozen.system[language], `${language} V${version}`);
    }
    assert.equal(hash(JSON.stringify(getAgentTools({ requestProtocolVersion: version }))), frozen.fullTools, `full V${version}`);
    const names = getAgentToolNamesForPrompt(frozen.slimPrompt, true, version);
    assert.deepEqual(names, frozen.slimNames, `names V${version}`);
    assert.equal(hash(JSON.stringify(getAgentTools({ requestProtocolVersion: version, toolNames: names }))), frozen.slimTools, `slim V${version}`);
  }
  assert.ok(getAgentToolNamesForPrompt('small question', true, 11).includes('keepseek_delegation_checkpoint'));
  const v10 = buildProviderRequestProjection({ ...request('openai-compatible'), agentSettings: request('openai-compatible').settings, requestProtocolVersion: 10 });
  assert.equal(v10.requestProtocolVersion, 10, 'V10 is not silently normalized to V9 or V11');
  assert.equal(v10.tools.some(t => t.function.name === 'keepseek_delegation_checkpoint'), false);
});

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

test('old plugin checkpoints remain readable but activation, recovery and direct reads stop before Provider dispatch', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'keepseek-plugin-suspension-')));
  const home = join(root, 'codex');
  const bundle = join(home, 'plugins/cache/fixture/workflow/local');
  const originalFetch = globalThis.fetch;
  const previousWorkspace = { isTrusted: vscode.workspace.isTrusted, workspaceFolders: vscode.workspace.workspaceFolders };
  const put = async (file: string, content: string) => {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content, 'utf8');
  };
  const paused = (error: unknown) => error instanceof Error && error.message === CODEX_PLUGIN_SKILLS_UNAVAILABLE;
  const interrupted = (error: unknown) => error instanceof AgentInterruptedError
    && error.reason === 'waiting_for_user' && error.message.includes(CODEX_PLUGIN_SKILLS_UNAVAILABLE);
  try {
    Object.assign(vscode.workspace, { isTrusted: true, workspaceFolders: [] });
    await put(join(home, 'config.toml'), '[plugins."workflow@fixture"]\nenabled = true\n');
    await put(join(bundle, '.codex-plugin/plugin.json'), '{"name":"workflow","version":"1.0.0","skills":"./skills/"}');
    const entryText = '---\nname: index\ndescription: Fixture entry\n---\nEntry marker 927. [Branch](../branch/SKILL.md)\n';
    const branchText = '---\nname: branch\ndescription: Fixture branch\n---\nBranch marker 342. Return the marker.\n';
    await put(join(bundle, 'skills/index/SKILL.md'), entryText);
    await put(join(bundle, 'skills/branch/SKILL.md'), branchText);
    // Build an authentic legacy snapshot with the retained low-level reader;
    // live SkillDiscovery/SkillLoader must no longer activate this package.
    const installations = await discoverCodexPlugins(vscode.Uri.file(home) as unknown as import('vscode').Uri);
    const installation = installations.plugins[0];
    assert.ok(installation);
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const makeManifest = (name: string, content: string): SkillManifest => {
      const rootUri = vscode.Uri.file(join(bundle, 'skills', name)) as unknown as import('vscode').Uri;
      return { id: `codexPlugin:workflow:${name}`, name, description: 'Fixture workflow', source: 'codexPlugin', sourceLabel: 'fixture',
        rootUri, skillUri: vscode.Uri.file(join(rootUri.fsPath, 'SKILL.md')) as unknown as import('vscode').Uri,
        enabled: true, allowImplicit: false, hasAssets: false, hasScripts: false, hasReferences: false,
        pluginInstallation: installation, pluginQualifiedName: `workflow:${name}`, documentHash: hash(content), metadataHash: hash('') };
    };
    const manifest = makeManifest('index', entryText);
    const branch = makeManifest('branch', branchText);
    const readContext = { isTrusted: true, routingAvailable: true, availableTools: [READ_PLUGIN_SKILL_TOOL_NAME],
      validateInstallation: async () => true };
    const initial = await pinCodexPluginSkill(installation, manifest, [manifest, branch], readContext);
    const previousRoute = await readCodexPluginResource(initial.snapshot, { mode: 'route', reference: '../branch/SKILL.md' }, readContext);
    assert.match(previousRoute.content ?? '', /Branch marker 342/u);
    const skill = { ...toActivatedSkill(manifest, initial.content), pluginSnapshot: initial.snapshot,
      activation: { source: 'explicit' as const, reason: 'legacy user selection' } };
    const prompt = '$workflow:index Run the branch.';
    const userBytes = `${prompt}\n\n${formatActiveSkills({ skills: [skill], language: 'en', requestProtocolVersion: 12 })}`.trim();
    const context = { projectInstructions: [], skills: [skill], metadata: {
      precedence: [], beforeDeduplicationCount: 1, afterDeduplicationCount: 1, totalCharacterCount: skill.content.length,
      totalTokenEstimate: 200, truncated: false, sources: [], discarded: [], possibleConflicts: []
    } };
    await rm(bundle, { force: true, recursive: true });
    let dispatches = 0;
    const call = { id: 'never-executed-plugin-reader', function: { name: READ_PLUGIN_SKILL_TOOL_NAME, arguments: '{}' } };
    for (const [format, provider] of [
      ['chat', 'openai-compatible'], ['responses', 'openai-responses'], ['anthropic', 'anthropic-compatible']
    ] as const) {
      globalThis.fetch = (async () => { dispatches++; return response(format, false, call); }) as typeof fetch;
      const run: AgentRequest = { ...request(provider), requestProtocolVersion: 12, prompt,
        history: [{ id: 'user-fixture', role: 'user', content: prompt, providerContent: userBytes, createdAt: new Date().toISOString() }],
        currentRunContext: context };
      const legacy = createRunCheckpoint(run, 0, 'legacy fixture', []);
      legacy.status = 'interrupted';
      legacy.pluginSkillProgress = [{ skillId: skill.id, progress: previousRoute.snapshot.progress }];
      const checkpoint = normalizeRunCheckpoint(JSON.parse(JSON.stringify(legacy)));
      assert.ok(checkpoint, format);
      assert.equal(checkpoint.request.history[0].providerContent, userBytes, format);
      assert.equal(checkpoint.request.currentRunContext?.skills[0].pluginSnapshot?.entryPath, 'skills/index/SKILL.md');
      assert.ok(checkpoint.pluginSkillProgress?.[0].progress.seen.includes('route:skills/branch/SKILL.md'));
      await assert.rejects(assertPluginSkillsCurrent(checkpoint.request.currentRunContext?.skills ?? [], [READ_PLUGIN_SKILL_TOOL_NAME], checkpoint), interrupted);
      const runner = new AgentRunner();
      await assert.rejects(runner.run(run), interrupted);
      await assert.rejects(runner.run({ ...run, checkpoint }), interrupted);
      await assert.rejects(executePluginSkillRead({ ...run, checkpoint },
        { skillId: skill.id, mode: 'read', reference: '../branch/SKILL.md' }, [READ_PLUGIN_SKILL_TOOL_NAME]), paused);
      assert.equal(dispatches, 0, 'paused plugin tasks must stop before any Provider request');
    }
    await assert.rejects(executePluginSkillRead(undefined, {}, []), paused);
    await assertPluginSkillsCurrent([], []);
    // Old instructions remain historical bytes; a fresh task can use the same
    // conversation without reactivating its old plugin selection.
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response('chat', false, call); }) as typeof fetch;
    const ordinary = await new AgentRunner().run({ ...request('openai-compatible'), requestProtocolVersion: 14,
      prompt: 'Continue with an ordinary task.',
      history: [{ id: 'legacy-user', role: 'user', content: prompt, providerContent: userBytes, createdAt: new Date().toISOString() }] });
    assert.match(ordinary.message, /Done/u);
    assert.equal(bodies.length, 1);
    assert.ok(strings(bodies[0]).includes(userBytes));
    assert.ok(!strings(bodies[0].tools).includes(READ_PLUGIN_SKILL_TOOL_NAME));
  } finally {
    globalThis.fetch = originalFetch;
    Object.assign(vscode.workspace, previousWorkspace);
    await rm(root, { force: true, recursive: true });
  }
});

test('V12 exposes only the new plugin reader beyond V11 while preserving the system prompt', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    assert.equal(getAgentSystemPrompt({ language, requestProtocolVersion: 12 }), getAgentSystemPrompt({ language, requestProtocolVersion: 11 }));
  }
  const v11 = getAgentTools({ requestProtocolVersion: 11 });
  const v12 = getAgentTools({ requestProtocolVersion: 12 });
  assert.equal(v12.length, v11.length + 1);
  assert.deepEqual(v12.filter(tool => tool.function.name !== READ_PLUGIN_SKILL_TOOL_NAME), v11);
  const projection = buildProviderRequestProjection({ ...request('openai-compatible'),
    agentSettings: request('openai-compatible').settings, requestProtocolVersion: 11 });
  assert.equal(projection.requestProtocolVersion, 11);
  assert.ok(!projection.tools.some(tool => tool.function.name === READ_PLUGIN_SKILL_TOOL_NAME));
});

test('V14 hides the suspended reader in all three payload lanes and preserves V12/V13 frozen schemas', () => {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  for (const baseline of [
    { version: 12, full: '73f7d52b8f89ddfb78057d0a3dc643006318ebc950f7b33657636321e58be5e6',
      slim: '0519027d3becc5499e0086fb7d2b2a6d4cd11b0509c08af414c0ded951607269',
      system: '5ce7ea12bed2baf17c6efc2865136b1cffa4d7cf04f96843d2a112678a519c14' },
    { version: 13, full: '360f15c2d092c834a3e5aa18ff0bb1c92a159d4be2868254df464511b3ac4ca7',
      slim: '6a36f889decb634d4034eeeab056faa61983a24c3fb285802464f556e1aaad6b',
      system: '1d715e5a53fa6e3a33c09efafd77a519b8ff9986c42dddf0fb47c91ce7d77104' }
  ]) {
    const options = { requestProtocolVersion: baseline.version };
    const names = getAgentToolNamesForPrompt('small question', true, baseline.version);
    assert.equal(sha(JSON.stringify(getAgentTools(options))), baseline.full);
    assert.equal(sha(JSON.stringify(getAgentTools({ ...options, toolNames: names }))), baseline.slim);
    assert.equal(sha(getAgentSystemPrompt({ language: 'en', ...options })), baseline.system);
    assert.ok(names.includes(READ_PLUGIN_SKILL_TOOL_NAME));
  }
  assert.equal(CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION, 15);
  assert.equal(CURRENT_PROVIDER_TOOL_SCHEMA_VERSION, 15);
  for (const language of ['en', 'zh-CN'] as const) {
    assert.equal(getAgentSystemPrompt({ language, requestProtocolVersion: 14 }), getAgentSystemPrompt({ language, requestProtocolVersion: 13 }));
  }
  assert.deepEqual(getAgentTools({ requestProtocolVersion: 14 }),
    getAgentTools({ requestProtocolVersion: 13 }).filter(tool => tool.function.name !== READ_PLUGIN_SKILL_TOOL_NAME));
  for (const slim of [false, true]) {
    assert.ok(!getAgentToolNamesForPrompt('small question', slim, 14).includes(READ_PLUGIN_SKILL_TOOL_NAME));
  }
  for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible'] as const) {
    const run = request(provider);
    // An explicitly supplied obsolete allow-list also cannot expose the reader.
    for (const slimToolNames of [undefined, getAgentToolNamesForPrompt('small question', true, 13)]) {
      const projection = buildProviderRequestProjection({ ...run, agentSettings: run.settings,
        requestProtocolVersion: 14, slimToolNames, sourceId: 'source', baseUrl: 'https://fixture.invalid/v1' });
      const body = buildProviderPayloadProjection({ modelId: run.model.id, maxOutputTokens: projection.runtimeProfile.maxTokens,
        provider, messages: projection.messages, tools: projection.tools,
        native: projection.responses ? { protocol: 'openai-responses', ...projection.responses }
          : projection.anthropic ? { protocol: 'anthropic-messages', ...projection.anthropic } : undefined });
      assert.ok(!projection.tools.some(tool => tool.function.name === READ_PLUGIN_SKILL_TOOL_NAME), provider);
      assert.ok(!strings(body.tools).includes(READ_PLUGIN_SKILL_TOOL_NAME), provider);
      assert.ok(strings(body.tools).includes('keepseek_read_evidence'), provider);
    }
  }
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
