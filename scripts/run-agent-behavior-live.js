#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const workspaceRoot = path.resolve(__dirname, '..');
if (process.env.KEEPSEEK_EVAL_LIVE !== '1') {
  process.stderr.write('Live evaluation is disabled. Set KEEPSEEK_EVAL_LIVE=1 to opt in.\n');
  process.exitCode = 2;
  return;
}

const protocol = requiredEnv('KEEPSEEK_EVAL_PROTOCOL');
if (!['chat-completions', 'openai-responses', 'anthropic-messages'].includes(protocol)) {
  throw new Error('KEEPSEEK_EVAL_PROTOCOL must be chat-completions, openai-responses, or anthropic-messages.');
}
const provider = requiredEnv('KEEPSEEK_EVAL_PROVIDER');
const baseUrl = requiredEnv('KEEPSEEK_EVAL_BASE_URL');
const apiKey = process.env.KEEPSEEK_EVAL_API_KEY ?? '';
const modelId = requiredEnv('KEEPSEEK_EVAL_MODEL');
const thinkingEnabled = process.env.KEEPSEEK_EVAL_THINKING === 'true';
const toolCapability = ['strong', 'weak'].includes(process.env.KEEPSEEK_EVAL_TOOL_CAPABILITY)
  ? process.env.KEEPSEEK_EVAL_TOOL_CAPABILITY
  : 'unknown';
const maxRounds = clampInteger(process.env.KEEPSEEK_EVAL_MAX_ROUNDS, 1, 20, 8);
const maxOutputTokens = clampInteger(process.env.KEEPSEEK_EVAL_MAX_OUTPUT_TOKENS, 128, 100000, 4096);

const agentProtocol = require(path.join(workspaceRoot, 'out', 'agent', 'protocol.js'));
const tokenEstimate = require(path.join(workspaceRoot, 'out', 'agent', 'tokenEstimate.js'));
const evaluation = require(path.join(workspaceRoot, 'out', 'agent', 'behaviorEvaluation.js'));
const allScenarios = JSON.parse(fs.readFileSync(
  path.join(workspaceRoot, 'eval', 'agent-behavior', 'cases.json'),
  'utf8'
)).filter(evaluation.isBehaviorEvalScenario);
const selectedIds = new Set((process.env.KEEPSEEK_EVAL_SCENARIOS ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean));
const scenarios = selectedIds.size
  ? allScenarios.filter((scenario) => selectedIds.has(scenario.id))
  : allScenarios;
if (!scenarios.length) {
  throw new Error('No matching behavior evaluation scenarios were selected.');
}

const systemPrompt = agentProtocol.getAgentSystemPrompt({ language: 'en' });
const tools = agentProtocol.getAgentTools({ requestProtocolVersion: 3 });

void runAll();

async function runAll() {
  for (const scenario of scenarios) {
    const record = await runScenario(scenario);
    process.stdout.write(`${JSON.stringify(record)}\n`);
  }
}

async function runScenario(scenario) {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const state = createProtocolState(scenario.prompt);
  const toolCalls = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let toolResultTokens = 0;
  let pendingDraftEdits = 0;
  let validationState = 'not_run';
  let finalAnswer = '';
  let budgetReached = false;
  let error;
  let sequence = 0;
  let completedRounds = 0;

  try {
    for (let round = 1; round <= maxRounds; round += 1) {
      completedRounds = round;
      const response = await requestModel(state);
      inputTokens += response.inputTokens;
      outputTokens += response.outputTokens;
      if (!response.toolCalls.length) {
        finalAnswer = response.text.trim();
        break;
      }

      const outputs = [];
      for (const call of response.toolCalls) {
        sequence += 1;
        const toolStartedAt = Date.now();
        const execution = executeFixture(scenario, call, pendingDraftEdits);
        if (execution.pendingDraftCreated) pendingDraftEdits += 1;
        if (execution.validationOutcome) validationState = execution.validationOutcome;
        const result = JSON.stringify(execution.result);
        const resultTokens = tokenEstimate.estimateTokenCount(result);
        toolResultTokens += resultTokens;
        toolCalls.push({
          sequence,
          round,
          name: call.name,
          arguments: call.arguments,
          ok: execution.result.ok === true,
          errorType: typeof execution.result.errorType === 'string' ? execution.result.errorType : undefined,
          resultChars: result.length,
          resultTokens,
          durationMs: Date.now() - toolStartedAt
        });
        outputs.push({ call, result });
      }
      appendToolOutputs(state, response, outputs);
      if (round === maxRounds) {
        budgetReached = true;
        finalAnswer = response.text.trim();
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  return {
    schemaVersion: evaluation.BEHAVIOR_EVAL_SCHEMA_VERSION,
    scenarioId: scenario.id,
    configuration: {
      provider,
      protocol,
      modelId,
      toolCapability,
      thinkingEnabled
    },
    startedAt,
    durationMs: Date.now() - startedMs,
    toolCalls,
    finalAnswer,
    inputTokens,
    outputTokens,
    toolResultTokens,
    toolRounds: toolCalls.length ? Math.max(...toolCalls.map((call) => call.round)) : 0,
    pendingDraftEdits,
    validationState,
    budgetReached,
    error
  };
}

function createProtocolState(prompt) {
  if (protocol === 'chat-completions') {
    return {
      kind: protocol,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]
    };
  }
  if (protocol === 'openai-responses') {
    return {
      kind: protocol,
      input: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ]
    };
  }
  return {
    kind: protocol,
    system: systemPrompt,
    messages: [{ role: 'user', content: prompt }]
  };
}

async function requestModel(state) {
  if (state.kind === 'chat-completions') return await requestChatCompletions(state);
  if (state.kind === 'openai-responses') return await requestResponses(state);
  return await requestAnthropic(state);
}

async function requestChatCompletions(state) {
  const body = {
    model: modelId,
    messages: state.messages,
    tools,
    tool_choice: 'auto',
    stream: false,
    temperature: 0,
    max_tokens: maxOutputTokens,
    ...(provider === 'deepseek'
      ? { thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' } }
      : {})
  };
  const payload = await postJson(endpointFor(baseUrl, 'chat/completions'), body, bearerHeaders());
  const message = payload?.choices?.[0]?.message ?? {};
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return {
    text: typeof message.content === 'string' ? message.content : '',
    toolCalls: calls.map((call, index) => ({
      id: call.id || `call-${index + 1}`,
      name: call.function?.name ?? '',
      arguments: parseArguments(call.function?.arguments)
    })),
    inputTokens: finiteNumber(payload?.usage?.prompt_tokens, estimateBodyTokens(body)),
    outputTokens: finiteNumber(payload?.usage?.completion_tokens, tokenEstimate.estimateTokenCount(JSON.stringify(message))),
    rawAssistant: message
  };
}

async function requestResponses(state) {
  const responseTools = tools.map((tool) => ({
    type: 'function',
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: tool.function.strict === true
  }));
  const body = {
    model: modelId,
    input: state.input,
    tools: responseTools,
    tool_choice: 'auto',
    store: false,
    stream: false,
    max_output_tokens: maxOutputTokens,
    ...(thinkingEnabled ? { reasoning: { effort: 'high' } } : {})
  };
  const payload = await postJson(endpointFor(baseUrl, 'responses'), body, bearerHeaders());
  const output = Array.isArray(payload.output) ? payload.output : [];
  const text = output.flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  const calls = output.filter((item) => item?.type === 'function_call');
  return {
    text,
    toolCalls: calls.map((call, index) => ({
      id: call.call_id || `call-${index + 1}`,
      name: call.name ?? '',
      arguments: parseArguments(call.arguments)
    })),
    inputTokens: finiteNumber(payload?.usage?.input_tokens, estimateBodyTokens(body)),
    outputTokens: finiteNumber(payload?.usage?.output_tokens, tokenEstimate.estimateTokenCount(JSON.stringify(output))),
    rawAssistant: output
  };
}

async function requestAnthropic(state) {
  const anthropicTools = tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
    strict: tool.function.strict === true
  }));
  const thinking = thinkingEnabled ? readAnthropicThinkingConfig() : undefined;
  const body = {
    model: modelId,
    system: state.system,
    messages: state.messages,
    tools: anthropicTools,
    tool_choice: { type: 'auto' },
    max_tokens: maxOutputTokens,
    stream: false,
    ...(thinking ? { thinking } : {})
  };
  const payload = await postJson(endpointFor(baseUrl, 'messages'), body, {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'anthropic-version': '2023-06-01',
    ...(apiKey ? { 'x-api-key': apiKey } : {})
  });
  const content = Array.isArray(payload.content) ? payload.content : [];
  const text = content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
  const calls = content.filter((block) => block?.type === 'tool_use');
  return {
    text,
    toolCalls: calls.map((call, index) => ({
      id: call.id || `call-${index + 1}`,
      name: call.name ?? '',
      arguments: isRecord(call.input) ? call.input : {}
    })),
    inputTokens: finiteNumber(payload?.usage?.input_tokens, estimateBodyTokens(body)),
    outputTokens: finiteNumber(payload?.usage?.output_tokens, tokenEstimate.estimateTokenCount(JSON.stringify(content))),
    rawAssistant: content
  };
}

function appendToolOutputs(state, response, outputs) {
  if (state.kind === 'chat-completions') {
    state.messages.push({ role: 'assistant', ...response.rawAssistant });
    for (const output of outputs) {
      state.messages.push({ role: 'tool', tool_call_id: output.call.id, content: output.result });
    }
    return;
  }
  if (state.kind === 'openai-responses') {
    state.input.push(...response.rawAssistant);
    for (const output of outputs) {
      state.input.push({ type: 'function_call_output', call_id: output.call.id, output: output.result });
    }
    return;
  }
  state.messages.push({ role: 'assistant', content: response.rawAssistant });
  state.messages.push({
    role: 'user',
    content: outputs.map((output) => ({
      type: 'tool_result',
      tool_use_id: output.call.id,
      content: output.result,
      ...(JSON.parse(output.result).ok === false ? { is_error: true } : {})
    }))
  });
}

function executeFixture(scenario, call, pendingDraftEdits) {
  if (['keepseek_create_draft_edit', 'keepseek_create_incremental_draft_edit', 'keepseek_delete_workspace_file'].includes(call.name)) {
    return {
      pendingDraftCreated: true,
      result: {
        ok: true,
        draftEdit: { id: `eval-draft-${pendingDraftEdits + 1}`, label: String(call.arguments.path ?? 'fixture-file') },
        message: 'Pending DraftEdit prepared by the evaluation fixture; no file was written.'
      }
    };
  }
  if (call.name === 'keepseek_run_validation') {
    if (pendingDraftEdits > 0) {
      return {
        result: {
          ok: false,
          errorType: 'pending_changes_require_apply',
          pendingDraftEditIds: Array.from({ length: pendingDraftEdits }, (_, index) => `eval-draft-${index + 1}`),
          error: 'Validation checks only the on-disk workspace; apply pending changes first.'
        }
      };
    }
    const fixture = cloneFixture(scenario.toolFixtures[call.name]) ?? {
      ok: true,
      script: String(call.arguments.script ?? 'compile'),
      authorized: true,
      exitCode: 0,
      durationMs: 1
    };
    return {
      validationOutcome: fixture.ok === true ? 'baseline_passed' : 'baseline_failed',
      result: fixture
    };
  }
  const fixture = cloneFixture(scenario.toolFixtures[call.name]);
  return fixture
    ? { result: fixture }
    : {
        result: {
          ok: false,
          errorType: 'fixture_missing',
          error: `No deterministic evaluation fixture exists for ${call.name}.`
        }
      };
}

async function postJson(url, body, headers) {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Provider request failed with HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Provider returned invalid JSON: ${text.slice(0, 500)}`);
  }
}

function bearerHeaders() {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
  };
}

function endpointFor(rawBaseUrl, suffix) {
  const url = new URL(rawBaseUrl);
  const normalizedPath = url.pathname.replace(/\/+$/u, '');
  const knownSuffix = /\/(?:chat\/completions|responses|messages)$/u;
  url.pathname = knownSuffix.test(normalizedPath)
    ? normalizedPath.replace(knownSuffix, `/${suffix}`)
    : `${normalizedPath}/${suffix}`.replace(/\/+/gu, '/');
  url.hash = '';
  return url.toString();
}

function readAnthropicThinkingConfig() {
  const raw = process.env.KEEPSEEK_EVAL_ANTHROPIC_THINKING_JSON;
  if (!raw) {
    throw new Error('Thinking is enabled for Anthropic; set KEEPSEEK_EVAL_ANTHROPIC_THINKING_JSON explicitly.');
  }
  const value = JSON.parse(raw);
  if (!isRecord(value)) {
    throw new Error('KEEPSEEK_EVAL_ANTHROPIC_THINKING_JSON must be a JSON object.');
  }
  return value;
}

function parseArguments(value) {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return {};
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return { _invalidJson: value.slice(0, 1000) };
  }
}

function estimateBodyTokens(body) {
  return tokenEstimate.estimateTokenCount(JSON.stringify(body));
}

function cloneFixture(value) {
  return isRecord(value) ? JSON.parse(JSON.stringify(value)) : undefined;
}

function finiteNumber(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
