/* Offline controlled comparison, NOT a live Agent/Provider experiment.
 * Reads repository source and uses KeepSeek's actual three-protocol projection,
 * result store and handoff shaping. Responses are deterministic fixtures: this
 * measures context surfaces and local IO, never model quality or actual usage.
 * Run after bun run build:test. No account configuration is read or changed.
 */
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFile, mkdtemp, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const modules = resolve(process.env.KEEPSEEK_BENCH_MODULES || 'out-test');
require(join(modules, 'test/registerVscodeStub'));
const vscode = require(join(modules, 'test/stubs/vscode'));
const { buildProviderRequestProjection, buildProviderPayloadProjection } = require(join(modules, 'src/agent/providerRequestProjection'));
const { estimateTokenCount } = require(join(modules, 'src/agent/tokenEstimate'));
const { createSubagentResultManifest, createParallelHandoff, stableJson } = require(join(modules, 'src/agent/subagents/handoff'));
const { SubagentStore } = require(join(modules, 'src/agent/subagents/store'));
const { acceptSubagentResult } = require(join(modules, 'src/agent/subagents/resultEnvelope'));
const { DelegationTracker } = require(join(modules, 'src/agent/delegation'));
const { resolveSubagentProfile } = require(join(modules, 'src/agent/subagents/profiles'));
const { getChildToolNamesForRuntime, getSubagentSystemPromptForVersion, formatChildContextForVersion } = require(join(modules, 'src/agent/subagents/runtime'));
const { prepareEvidenceEnvelope } = require(join(modules, 'src/agent/evidence/shaping'));

const protocolVersion = 11;
const sourceId = 'offline-fixture-source';
const baseUrl = 'https://offline.invalid';
const parentPrompt = 'Locate the declarations and source identities of resolveSubagentProfile, createParallelHandoff, and readResultPage. Return exact paths and lines, inspect each module independently, then verify each declaration with a narrow reread. This is a source-location audit, not a semantic correctness review.';
const scopes = [
  { path: 'src/agent/subagents/profiles.ts', symbol: 'resolveSubagentProfile' },
  { path: 'src/agent/subagents/handoff.ts', symbol: 'createParallelHandoff' },
  { path: 'src/agent/subagents/store.ts', symbol: 'readResultPage' }
];
const hash = value => createHash('sha256').update(value, 'utf8').digest('hex');
const bytes = value => Buffer.byteLength(typeof value === 'string' ? value : stableJson(value), 'utf8');
const settings = { thinkingEnabled: false, reasoningEffort: 'high', compressionThreshold: 'balanced' };
const profile = resolveSubagentProfile({ requestedId: 'research' });
const childSystem = getSubagentSystemPromptForVersion('en', profile, 1, protocolVersion);
const childContext = formatChildContextForVersion('workspace: offline synthetic fixture', 'Read-only source-location audit. Do not modify files or execute commands.', profile, protocolVersion);

async function readScopes() {
  const started = performance.now();
  const sources = await Promise.all(scopes.map(async scope => {
    const content = await readFile(resolve(scope.path), 'utf8');
    const lines = content.split('\n');
    const index = lines.findIndex(line => line.includes(scope.symbol + '(') && /(?:function|async)/u.test(line));
    assert.ok(index >= 0, `declaration missing: ${scope.symbol}`);
    return { ...scope, content, lines, declaration: lines[index], line: index + 1, sha256: hash(content), bytes: bytes(content) };
  }));
  return { sources, toolFilesystemMs: performance.now() - started };
}

function user(prompt) { return { id: 'user-fixture', role: 'user', content: prompt, createdAt: '' }; }
function addRound(history, calls, provider) {
  const id = `turn-${history.length}`;
  const toolCalls = calls.map((call, i) => ({ id: `${id}-${i}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }));
  const toolResults = calls.map((call, i) => ({ toolCallId: toolCalls[i].id, content: call.content }));
  const assistant = { id, role: 'assistant', content: '', createdAt: '', toolRounds: [{ assistantContent: null, reasoningContent: null, toolCalls, toolResults }] };
  if (provider === 'openai-responses') assistant.providerReplay = {
    protocol: 'openai-responses', sourceId, baseUrl,
    items: toolCalls.flatMap((call, i) => [
      { type: 'function_call', call_id: call.id, name: call.function.name, arguments: call.function.arguments },
      { type: 'function_call_output', call_id: call.id, output: toolResults[i].content }
    ])
  };
  if (provider === 'anthropic-compatible') assistant.providerReplay = {
    protocol: 'anthropic-messages', sourceId, baseUrl,
    messages: [
      { role: 'assistant', content: toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })) },
      { role: 'user', content: toolResults.map(result => ({ type: 'tool_result', tool_use_id: result.toolCallId, content: result.content })) }
    ]
  };
  history.push(assistant);
}

function project(history, provider, prompt, child = false) {
  const started = performance.now();
  const projection = buildProviderRequestProjection({
    model: { id: 'offline-fixture-model', label: 'offline', provider, sourceId, contextWindowTokens: 1_024_000, maxOutputTokens: 32_768 },
    agentSettings: settings, contextFiles: [], history, language: 'en', prompt,
    sourceId, baseUrl, provider, requestProtocolVersion: protocolVersion,
    ...(child ? { systemPrompt: childSystem, contextInstructions: childContext, slimToolNames: getChildToolNamesForRuntime(profile, 1, protocolVersion) } : {})
  });
  assert.equal(projection.requestProtocolVersion, protocolVersion, 'Rebuild test modules: this benchmark requires the V11 projection.');
  const body = buildProviderPayloadProjection({
    modelId: 'offline-fixture-model', maxOutputTokens: 32_768, provider,
    messages: projection.messages, tools: projection.tools,
    ...(projection.responses ? { native: { protocol: 'openai-responses', input: projection.responses.input, tools: projection.responses.tools } } : {}),
    ...(projection.anthropic ? { native: { protocol: 'anthropic-messages', system: projection.anthropic.system, messages: projection.anthropic.messages, tools: projection.anthropic.tools } } : {})
  });
  const serialized = JSON.stringify(body);
  return { inputBytes: bytes(serialized), inputTokensEstimate: estimateTokenCount(serialized), requestHash: hash(serialized), projectionMs: performance.now() - started };
}

function rawRead(source) {
  return { name: 'keepseek_read_workspace_file', args: { path: source.path }, content: stableJson({ ok: true, path: source.path, content: source.content, sizeBytes: source.bytes }) };
}
async function rereadDeclarations(sources) {
  const started = performance.now();
  const results = await Promise.all(sources.map(async source => {
    const content = await readFile(resolve(source.path), 'utf8');
    assert.equal(hash(content), source.sha256, 'source changed during benchmark');
    const declaration = content.split('\n')[source.line - 1];
    assert.equal(declaration, source.declaration);
    return { name: 'keepseek_read_workspace_file_range', args: { path: source.path, startLine: source.line, endLine: source.line },
      content: stableJson({ ok: true, path: source.path, startLine: source.line, endLine: source.line, content: declaration }) };
  }));
  return { results, toolFilesystemMs: performance.now() - started };
}
const sum = (values, key) => values.reduce((total, value) => total + value[key], 0);
function projectionTotals(values) {
  return { scriptedRequestCount: values.length, inputBytesTotal: sum(values, 'inputBytes'), inputTokensEstimateTotal: sum(values, 'inputTokensEstimate'), projectionMs: sum(values, 'projectionMs'), requests: values };
}
function outputEstimate(history, finalText) {
  const toolCalls = history.flatMap(message => message.toolRounds ?? []).flatMap(round => round.toolCalls);
  const serializedCalls = toolCalls.map(call => JSON.stringify(call));
  return { outputBytes: bytes(finalText) + sum(serializedCalls.map(value => ({ n: bytes(value) })), 'n'),
    outputTokensEstimate: estimateTokenCount(finalText) + sum(serializedCalls.map(value => ({ n: estimateTokenCount(value) })), 'n'),
    scriptedAssistantToolCallCount: toolCalls.length };
}
function bindTask(task, taskHash) {
  // Same deterministic binding text as runtime.formatBoundSubagentTask. Include
  // its bytes as well as prepare()'s expanded brief in the child projection.
  return [task, '<keepseek-subagent-result-binding-v1>', `taskHash: ${taskHash}`,
    'Copy this exact deterministic taskHash into the final JSON envelope. It does not grant any capability.',
    '</keepseek-subagent-result-binding-v1>'].join('\n\n');
}

async function compare(provider) {
  const directory = await mkdtemp(join(tmpdir(), 'keepseek-p1-delegation-'));
  try {
    const primary = await readScopes();
    const mainHistory = [user(parentPrompt)];
    const mainRequests = [project(mainHistory, provider, parentPrompt)];
    for (const source of primary.sources) {
      addRound(mainHistory, [rawRead(source)], provider);
      mainRequests.push(project(mainHistory, provider, parentPrompt));
    }
    const mainReread = await rereadDeclarations(primary.sources);
    addRound(mainHistory, mainReread.results, provider);
    mainRequests.push(project(mainHistory, provider, parentPrompt));

    const delegated = await readScopes();
    const store = new SubagentStore(vscode.Uri.file(directory), 'offline-benchmark-workspace');
    const tracker = new DelegationTracker(undefined, undefined, () => {});
    const parentHistory = [user(parentPrompt)];
    const parentRequests = [project(parentHistory, provider, parentPrompt)];
    const children = [];
    const manifests = [];
    let localSaveMs = 0, coordinationMs = 0, authorityVerificationMs = 0;
    const candidates = delegated.sources.map((source, index) => ({ id: `candidate-${index}`,
      goal: `Locate the declaration and source identity of ${source.symbol}.`, scope: [source.path],
      inputs: ['Use the current on-disk module; no parent history is available.'], dependsOn: [], capabilities: ['read'],
      acceptance: ['Return the exact declaration path and line plus source SHA256, then let the parent reread that declaration.'] }));
    const assessmentArgs = { action: 'assess', trigger: 'initial', decision: 'delegate',
      reason: 'The three module location checks are independent and have the same narrow acceptance requirement.', evidence: [], candidates };
    let coordinationStarted = performance.now();
    const assessmentResult = tracker.assess(assessmentArgs);
    coordinationMs += performance.now() - coordinationStarted;
    addRound(parentHistory, [{ name: 'keepseek_delegation_checkpoint', args: assessmentArgs, content: assessmentResult }], provider);
    parentRequests.push(project(parentHistory, provider, parentPrompt));
    const briefs = delegated.sources.map((source, index) => ({ candidateId: candidates[index].id,
      task: `Locate ${source.symbol} in ${source.path}, inspect that module only. Return its declaration and source hash. Do not modify or execute.`, profile: 'research', paths: [source.path] }));
    coordinationStarted = performance.now();
    const prepared = tracker.prepare(briefs);
    coordinationMs += performance.now() - coordinationStarted;
    for (let i = 0; i < delegated.sources.length; i++) {
      const source = delegated.sources[i];
      const prompt = prepared[i].task;
      const taskHash = hash(prompt.normalize('NFKC').replace(/\s+/gu, ' ').trim());
      const childHistory = [{ ...user(prompt), providerContent: bindTask(prompt, taskHash) }];
      const requests = [project(childHistory, provider, prompt, true)];
      addRound(childHistory, [rawRead(source)], provider);
      requests.push(project(childHistory, provider, prompt, true));
      const rawResult = stableJson({ taskHash, status: 'complete', summary: `${source.symbol}: ${source.path}:${source.line}`, kind: 'research',
        evidence: [{ claim: `${source.declaration.trim()} (source SHA256 ${source.sha256})`, path: source.path, startLine: source.line, endLine: source.line }],
        uncertainties: ['Offline scripted source-location audit; no semantic model review or runtime behavior verification.'],
        coverage: [source.path], missing: [], nextSteps: ['Parent should verify the declaration location before accepting.'] });
      const acceptance = acceptSubagentResult({ raw: rawResult, lane: 'research-read', expectedTaskHash: taskHash, contractVersion: 2, maxChars: profile.resultMaxChars });
      assert.equal(acceptance.ok, true, JSON.stringify(acceptance.diagnostics));
      const canonical = stableJson(acceptance.envelope);
      const id = `sa_offline_${i}`;
      const metadata = { version: 2, id, treeId: 'offline-tree', parentSessionId: 'offline-session', parentRunId: 'offline-root', rootRunId: 'offline-root',
        depth: 1, profile: 'research', lane: 'research-read', task: prompt, status: 'completed', sourceId, modelId: 'offline-fixture-model', provider,
        sourceConfigHash: hash('offline'), systemPromptHash: hash(childSystem), toolSchemaHash: hash('offline-tools'), profileHash: hash(profile.instructions), projectInstructionsHash: hash(childContext),
        normalizedTaskHash: taskHash, resultStatus: 'complete', resultContractVersion: 2, resultFormatAccepted: true, resultEnvelope: acceptance.envelope,
        readSet: [{ uri: vscode.Uri.file(resolve(source.path)).toString(), contentHash: source.sha256, sizeBytes: source.bytes }], readSetComplete: true,
        resultHash: hash(canonical), resultChars: canonical.length, resultBytes: bytes(canonical),
        createdAt: '', updatedAt: '', completedAt: '' };
      const saveStarted = performance.now();
      await store.save(metadata, { version: 2, metadataId: id, contextInstructions: childContext, messages: childHistory, result: canonical });
      localSaveMs += performance.now() - saveStarted;
      manifests.push(createSubagentResultManifest({ metadata, result: canonical, status: 'completed', ok: true, summary: `${source.symbol}: ${source.path}:${source.line}`,
        maxBytes: 12_288, contractVersion: 2, envelope: acceptance.envelope }));
      assert.equal(manifests.at(-1).formatAccepted, true, 'V3 handoff did not preserve format acceptance');
      children.push({ ...projectionTotals(requests), ...outputEstimate(childHistory, rawResult), preparedBriefBytes: bytes(prompt), boundPromptBytes: bytes(childHistory[0].providerContent),
        canonicalBytes: bytes(canonical), resultHash: hash(canonical), actualUsage: null });
    }
    const handoff = createParallelHandoff({ manifests, accepted: true, draftEditCount: 0, draftRunCount: 0, contractVersion: 2 });
    const shaped = prepareEvidenceEnvelope({ record: { version: 1, id: 'offline-evidence', evidenceRef: 'ev_offline', sessionId: 'offline-session', taskId: 'offline-root',
      toolCallId: 'offline-delegate', toolName: 'keepseek_delegate_parallel', argumentsHash: hash(stableJson(briefs)), effectKind: 'delegation', executionStatus: 'completed', deliveryStatus: 'pending',
      contentHash: hash(handoff), contentType: 'structured', totalChars: handoff.length, totalBytes: bytes(handoff), totalTokensEstimate: estimateTokenCount(handoff), createdAt: '', updatedAt: '' },
      rawContent: handoff, inlineTokenAllowance: 8_000, inlineCharLimit: 20_480 });
    coordinationStarted = performance.now();
    tracker.returned(prepared, handoff);
    coordinationMs += performance.now() - coordinationStarted;
    addRound(parentHistory, [{ name: 'keepseek_delegate_parallel', args: { tasks: briefs }, content: shaped.content }], provider);
    parentRequests.push(project(parentHistory, provider, parentPrompt));
    for (const source of delegated.sources) assert.equal(JSON.stringify(parentHistory).includes(source.content), false, 'private full source reentered parent history');
    const parentReread = await rereadDeclarations(delegated.sources);
    addRound(parentHistory, parentReread.results, provider);
    parentRequests.push(project(parentHistory, provider, parentPrompt));
    const acceptanceCalls = [];
    for (const manifest of manifests) {
      const verificationStarted = performance.now();
      const authority = await store.verifyResult({ parentSessionId: 'offline-session', ref: manifest.resultRef });
      authorityVerificationMs += performance.now() - verificationStarted;
      assert.ok(authority, 'The actual canonical store must verify each result before parent acceptance.');
      const args = { action: 'accept', subagentId: manifest.subagentId, decision: 'adopt',
        reason: 'The declaration was reread at the reported line and its source identity matches the child evidence.' };
      coordinationStarted = performance.now();
      const content = tracker.accept(args, authority);
      coordinationMs += performance.now() - coordinationStarted;
      acceptanceCalls.push({ name: 'keepseek_delegation_checkpoint', args, content });
    }
    // A model may issue the three independent acceptance records in one round.
    // Count the complete round in every subsequent parent payload.
    addRound(parentHistory, acceptanceCalls, provider);
    parentRequests.push(project(parentHistory, provider, parentPrompt));
    assert.equal(tracker.finalize().pending, 0, 'The actual parent tracker must resolve every candidate.');
    assert.equal(parentRequests.length, 5, 'Both V11 assessment and acceptance round trips must be included.');
    for (const source of delegated.sources) {
      assert.equal(primary.sources.find(item => item.symbol === source.symbol).sha256, source.sha256);
      assert.ok(shaped.content.includes(source.symbol), 'handoff omitted a required conclusion');
    }
    const finalAnswer = stableJson(delegated.sources.map(({ path, symbol, line, sha256 }) => ({ path, symbol, line, sha256 })));
    return {
      provider, protocolVersion, task: parentPrompt,
      sources: delegated.sources.map(({ path, symbol, line, sha256, bytes: sizeBytes }) => ({ path, symbol, line, sha256, sizeBytes })),
      primaryOnly: { ...projectionTotals(mainRequests), ...outputEstimate(mainHistory, finalAnswer), parentToolBodyBytes: sum(primary.sources.map(source => ({ n: bytes(rawRead(source).content) })), 'n') + sum(mainReread.results.map(result => ({ n: bytes(result.content) })), 'n'),
        physicalProviderAttempts: 0, actualUsage: null, localIntervalsMs: { provider: 0, summary: 0, tools: primary.toolFilesystemMs + mainReread.toolFilesystemMs, localSave: 0, waiting: 0 },
        fullSourceReads: 3, narrowVerificationReads: 3, supplementaryInvestigations: 0 },
      delegatedThenVerified: { ...projectionTotals(parentRequests), ...outputEstimate(parentHistory, finalAnswer), children,
        parentToolBodyBytes: bytes(assessmentResult) + bytes(shaped.content) + sum(parentReread.results.map(result => ({ n: bytes(result.content) })), 'n') + sum(acceptanceCalls.map(result => ({ n: bytes(result.content) })), 'n'),
        acceptedManifest: JSON.parse(shaped.content), acceptedManifestBytes: bytes(shaped.content), pageReads: 0, pageBodyBytes: 0,
        physicalProviderAttempts: 0, actualUsage: null,
        localIntervalsMs: { provider: 0, summary: 0, tools: delegated.toolFilesystemMs + parentReread.toolFilesystemMs + authorityVerificationMs, localSave: localSaveMs, coordination: coordinationMs, waiting: 0 },
        fullSourceReads: 3, narrowVerificationReads: 3, supplementaryInvestigations: 0,
        scriptedParentAcceptance: { status: 'accepted', basis: 'All three declaration lines were reread and source identities matched; complete compact results needed no additional result pages.', semanticModelAcceptance: false },
        coordination: { assessedCandidates: candidates.length, assessmentArgs, assessmentResult: JSON.parse(assessmentResult),
          preparedBriefs: prepared.map(({ candidateId, task }) => ({ candidateId, task })),
          acceptanceCalls: acceptanceCalls.map(call => ({ arguments: call.args, result: JSON.parse(call.content) })), parentState: tracker.snapshot() },
        taskInputTokensEstimateTotal: sum(parentRequests, 'inputTokensEstimate') + sum(children, 'inputTokensEstimateTotal'),
        taskOutputTokensEstimateTotal: outputEstimate(parentHistory, finalAnswer).outputTokensEstimate + sum(children, 'outputTokensEstimate') },
      controlledQualityCheck: { sameRequiredSourceIdentities: true, sameFinalAnswerHash: hash(finalAnswer), requiredDeclarationsFound: 3, declarationsReread: 3,
        limitations: 'Only source-location facts are deterministically checked. Scripted summaries do not prove real-model delegation, semantic correctness, task completion quality, or end-to-end savings.' }
    };
  } finally { await rm(directory, { recursive: true, force: true }); }
}

(async () => {
  const results = [];
  for (const provider of ['openai-compatible', 'openai-responses', 'anthropic-compatible']) results.push(await compare(provider));
  for (const result of results) assert.deepEqual(result.sources, results[0].sources, 'Source files changed between protocol lanes.');
  process.stdout.write(JSON.stringify({ version: 2, kind: 'offline-scripted-projection-comparison', environment: { node: process.version, platform: process.platform, arch: process.arch,
    filesystem: 'real temporary filesystem and repository source reads via VS Code stub', providerTraffic: false, actualUsageAvailable: false, timingSampleCountPerLane: 1 },
    notes: [
      'Input counts are estimates from final serialized three-protocol context payloads. Sampling/transport-only fields are outside this context comparison.',
      'No real model, tool scheduler, selection probability, network waiting, parent semantic acceptance or live VS Code flow was exercised.',
      'Tool bodies and child results are deterministic fixtures from real source. The parent gets complete compact conclusions plus narrow verification reads; no private child trace is copied back.',
      'V11 assessment, candidate preparation, returned-result tracking, full canonical authority verification and parent acceptance use the real DelegationTracker/store methods. Assessment and batched acceptance tool arguments/results each consume a full additional parent request round.',
      'Every child request includes the complete prepare() brief and deterministic task binding. Output estimates include scripted assistant tool calls as well as final answers; native transport-only output framing remains outside the estimate.',
      'No context, time, token, approval or durability budget was increased. Additional child prefixes and coordination may increase total estimated task input even when the parent projection shrinks.',
      'All small canonical results fit the default previews, so this scenario correctly reads zero extra result pages. Reader paging cost is benchmarked separately.',
      'Single timing samples are observations, never production p95 values. No saving percentage or model quality claim is computed.'
    ], results }, null, 2) + '\n');
})().catch(error => { console.error(error); process.exitCode = 1; });
