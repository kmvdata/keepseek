// Read-only, content-free diagnostic replay. Build first: bun run build:test
// node scripts/replay-output-truncation.cjs 393192 1024000 /path/to/run.jsonl [...]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
require(path.join(root, 'out-test/test/registerVscodeStub.js'));
const { StreamParser } = require(path.join(root, 'out-test/src/agent/providers/streamParser.js'));
const { resolveProviderRequestBudget } = require(path.join(root, 'out-test/src/agent/requestBudget.js'));

async function main() {
  const [outputValue, windowValue, ...files] = process.argv.slice(2);
  const maxOutputTokens = Number(outputValue);
  const contextWindowTokens = Number(windowValue);
  if (!files.length || ![maxOutputTokens, contextWindowTokens].every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new Error('Usage: node scripts/replay-output-truncation.cjs MODEL_OUTPUT CONTEXT_WINDOW LOG.jsonl [...]');
  }
  for (const file of files) {
    const events = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const requests = events.filter((event) => event.type === 'upstream_request');
    if (requests.length !== 1 || !Array.isArray(requests[0].body?.messages)) {
      throw new Error('Replay requires exactly one captured Chat Completions request per log.');
    }
    const body = requests[0].body;
    const chunks = events.filter((event) => event.type === 'upstream_sse_data');
    if (!chunks.length) throw new Error('Log has no captured raw SSE frames.');
    const stream = new Response(chunks.map((event) => `data: ${event.data}\n\n`).join('')).body;
    let progress;
    let failure;
    try {
      await new StreamParser().parse(stream, 'en', {}, { onProgress: (value) => { progress = value; } });
    } catch (error) {
      // Never print arbitrary error/body/tool content from private logs.
      failure = { name: error.name, code: error.code, finishReason: error.finishReason };
    }
    const budget = resolveProviderRequestBudget({ model: { id: body.model, label: body.model, provider: 'openai-compatible',
      sourceId: 'redacted', maxOutputTokens, contextWindowTokens, maxOutputSource: 'manual', contextWindowSource: 'manual' },
      provider: 'openai-compatible', body });
    console.log(JSON.stringify({ runId: path.basename(file).match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/u)?.[0],
      originalRequestHash: crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      originalOutput: body.max_tokens, recordedToolCalls: events.filter((event) => event.type === 'tool_call').length,
      rawFrames: chunks.length, replayError: failure, observedUsage: progress?.usage ?? null,
      newAdmission: { configured: budget.modelMaxOutputTokens, actual: budget.actualMaxOutputTokens,
        estimatedInput: budget.estimatedInputTokens, inputBudget: budget.inputBudgetTokens,
        window: budget.effectiveWindowTokens, safety: budget.safetyTokens } }));
  }
}
main().catch((error) => { console.error(error instanceof SyntaxError ? 'Invalid JSON log' : error.message); process.exitCode = 1; });
