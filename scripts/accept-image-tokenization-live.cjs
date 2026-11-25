/* Phase 0 probe: DeepSeek Chat Completions image token accounting.
 *
 * Bounded, explicit and self-contained. It reads the exact account file that
 * accountStore.resolveModelSourceConfig reads
 * (<storageRoot>/accounts/deepseek/<selectedSourceId>.json) into memory,
 * validates its identity, and sends a fixed set of locally generated PNGs to
 * the configured endpoint. Only upstream `usage` is observed.
 *
 * Side effects: outbound HTTPS to the configured base URL; one JSON report.
 * No workspace file is modified, no dependency installed, and no provider
 * other than the workspace-selected DeepSeek source is touched.
 *
 * Usage after reading this header:
 *   node scripts/accept-image-tokenization-live.cjs STORAGE_DIR OUT.json [SAMPLE_IDS]
 * SAMPLE_IDS defaults to: color-512,noise-512,noise-512-repeat,anchor-1302
 * The report keeps a cumulative physical request count and refuses to exceed 6.
 * Never pass an API key on the command line.
 */
const fs = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { Buffer } = require('node:buffer');
const { createHash } = require('node:crypto');

const MAX_PHYSICAL_REQUESTS = 6;
const REQUEST_TIMEOUT_MS = 180000;
const ERROR_PREVIEW_CHARS = 800;
const PROBE_TEXT = 'Reply with exactly one word naming the dominant color of this image.';
const DEFAULT_SAMPLE_IDS = ['color-512', 'noise-512', 'noise-512-repeat', 'anchor-1302'];
const DEFAULT_DEEPSEEK_BASE_URL = 'https://api.deepseek.com';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const SAMPLE_PLAN = {
  'color-512': {
    purpose: '纯色小字节图：建立像素计价基线',
    expectation: '按像素计价时 prompt_tokens 接近 184；若明显偏离或直接被拒绝则与像素假设冲突'
  },
  'noise-512': {
    purpose: '噪声大字节图：区分像素计价与文本计价',
    expectation: '按像素计价时与纯色图差值在几十以内；按文本计价时应高出约两个数量级并接近 PNG 字节数×0.3'
  },
  'noise-512-repeat': {
    purpose: '与上一张完全同字节重复：验证图片前缀缓存',
    expectation: 'prompt_cache_hit_tokens 接近上一张 prompt_tokens 即图片可缓存；为 0 或缺失则 no-image-cache'
  },
  'anchor-1302': {
    purpose: '1302×1302 锚点：对照精确网格公式',
    expectation: '公式预测 994；实测落在 384 附近即矛盾，必须停下汇报'
  },
  'clamp-1568': {
    purpose: '1568×1568 限幅探针：验证 1024 token 裁剪',
    expectation: '未裁剪公式值 1484；图片部分约 1024 即裁剪确认，约 1484 即无裁剪，约 652 即先缩放到 1024×1024'
  }
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function encodePng(width, height, raw) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

function solidPng(width, height, rgb) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = rgb[0];
      raw[at + 1] = rgb[1];
      raw[at + 2] = rgb[2];
    }
  }
  return encodePng(width, height, raw);
}

function noisePng(width, height, seed) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  let state = seed >>> 0 || 0x9e3779b9;
  const nextByte = () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state & 0xff;
  };
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      raw[at] = nextByte();
      raw[at + 1] = nextByte();
      raw[at + 2] = nextByte();
    }
  }
  return encodePng(width, height, raw);
}

/** rows/columns are 14 px patches merged 3x3, i.e. a 42 px token grid. */
function deepSeekPixelFormula(width, height) {
  const rows = Math.ceil(height / 42);
  const columns = Math.ceil(width / 42);
  const raw = rows * (columns + 1) + 2;
  return { rows, columns, tokens: Math.min(1024, raw), clamped: raw > 1024 };
}

function createImageFactory() {
  const cache = new Map();
  const build = (width, height, mode) => mode === 'noise'
    ? noisePng(width, height, 0x5eed1234)
    : solidPng(width, height, [32, 96, 160]);
  return (id) => {
    if (cache.has(id)) return cache.get(id);
    const spec = id === 'anchor-1302' ? { width: 1302, height: 1302, mode: 'solid' }
      : id === 'clamp-1568' ? { width: 1568, height: 1568, mode: 'solid' }
        : id === 'color-512' ? { width: 512, height: 512, mode: 'solid' }
          : id === 'noise-512' || id === 'noise-512-repeat' ? { width: 512, height: 512, mode: 'noise' }
            : undefined;
    if (!spec) throw new Error('unknown probe sample: ' + id);
    const bytes = build(spec.width, spec.height, spec.mode);
    const record = {
      width: spec.width,
      height: spec.height,
      mimeType: 'image/png',
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex')
    };
    cache.set(id, record);
    if (id === 'noise-512') cache.set('noise-512-repeat', record);
    return record;
  };
}

function chatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl || DEFAULT_DEEPSEEK_BASE_URL);
  const cleanPath = url.pathname.replace(/\/+$/u, '');
  if (cleanPath.endsWith('/chat/completions')) {
    url.pathname = cleanPath;
    return url.toString();
  }
  const basePath = cleanPath.endsWith('/anthropic')
    ? cleanPath.slice(0, -'/anthropic'.length)
    : cleanPath;
  url.pathname = `${basePath || ''}/chat/completions`;
  return url.toString();
}

async function readSelectedSource(storageDir) {
  const settingsText = await fs.readFile(path.join('.vscode', 'settings.json'), 'utf8');
  const settings = JSON.parse(settingsText);
  const sourceId = settings['kmvdata.keepseek.selectedSourceId'];
  const modelId = settings['kmvdata.keepseek.selectedModelId'];
  if (typeof sourceId !== 'string' || !sourceId.trim() || typeof modelId !== 'string' || !modelId.trim()) {
    throw new Error('workspace settings lack selectedSourceId/selectedModelId');
  }
  const file = path.join(storageDir, 'accounts', 'deepseek', sourceId.trim() + '.json');
  const source = JSON.parse(await fs.readFile(file, 'utf8'));
  if (source.id !== sourceId.trim() || source.provider !== 'deepseek') {
    throw new Error('account file identity mismatch');
  }
  if (source.enabled === false) throw new Error('selected source is disabled');
  const apiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
  if (!apiKey) throw new Error('selected source has no api key');
  const baseUrl = typeof source.baseUrl === 'string' && source.baseUrl.trim()
    ? source.baseUrl.trim()
    : DEFAULT_DEEPSEEK_BASE_URL;
  return {
    sourceId: sourceId.trim(),
    modelId: modelId.trim(),
    apiKey,
    baseUrl,
    modelListed: Array.isArray(source.models) && source.models.some((model) => model && model.id === modelId.trim())
  };
}

async function postImage({ url, apiKey, modelId, dataUrl }) {
  const body = JSON.stringify({
    model: modelId,
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: PROBE_TEXT },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }],
    max_tokens: 8,
    stream: false
  });
  const startedAt = Date.now();
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  });
  const text = await response.text();
  return { ok: response.ok, status: response.status, text, requestBytes: Buffer.byteLength(body), wallMs: Date.now() - startedAt };
}

function tryJson(text) {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readUsage(parsed) {
  const usage = parsed && parsed.usage && typeof parsed.usage === 'object' ? parsed.usage : undefined;
  if (!usage) return undefined;
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
  const details = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? usage.prompt_tokens_details
    : undefined;
  return {
    promptTokens: num(usage.prompt_tokens),
    completionTokens: num(usage.completion_tokens),
    totalTokens: num(usage.total_tokens),
    promptCacheHitTokens: num(usage.prompt_cache_hit_tokens),
    promptCacheMissTokens: num(usage.prompt_cache_miss_tokens),
    cachedTokens: num(usage.cached_tokens) ?? (details ? num(details.cached_tokens) : undefined)
  };
}

function readErrorMessage(text) {
  const parsed = tryJson(text);
  const message = parsed && parsed.error && typeof parsed.error.message === 'string'
    ? parsed.error.message
    : parsed && typeof parsed.message === 'string' ? parsed.message : text;
  return message.slice(0, ERROR_PREVIEW_CHARS);
}

function classifyStop(status, message) {
  if (status === 401 || status === 403) return 'auth-rejected';
  if (status === 404) return 'endpoint-or-model-missing';
  if (status === 400 || status === 422) {
    if (/image|vision|multimodal/iu.test(message)) return 'image-input-rejected';
    return 'request-rejected';
  }
  return undefined;
}

function classifyRun(run) {
  const byId = new Map(run.samples.map((sample) => [sample.sampleId, sample]));
  const prompt = (sample) => sample && sample.usage ? sample.usage.promptTokens : undefined;
  const color = prompt(byId.get('color-512'));
  const noise = prompt(byId.get('noise-512'));
  const repeat = prompt(byId.get('noise-512-repeat'));
  const repeatHit = byId.get('noise-512-repeat') && byId.get('noise-512-repeat').usage
    ? byId.get('noise-512-repeat').usage.promptCacheHitTokens
    : undefined;
  const anchor = prompt(byId.get('anchor-1302'));
  const observed = {};
  const responded = run.samples.filter((sample) => sample.status === 'responded' && sample.usage);
  if (!responded.length) {
    const rejection = run.samples.find((sample) => sample.status === 'rejected');
    observed.imageAccounting = rejection ? 'rejected-' + rejection.httpStatus : 'no-usage-observed';
  } else if (typeof color === 'number' && typeof noise === 'number') {
    observed.colorPromptTokens = color;
    observed.noisePromptTokens = noise;
    observed.deltaPromptTokens = Math.abs(noise - color);
    observed.pixelBilling = Math.abs(noise - color) <= 64;
    observed.textualBilling = Math.abs(noise - color) > 64 && noise > color;
  } else {
    observed.imageAccounting = 'insufficient-samples';
  }
  if (typeof repeat === 'number') observed.repeatPromptTokens = repeat;
  if (typeof noise === 'number' && typeof repeatHit === 'number') {
    observed.imageCache = repeatHit === 0 ? 'no-cache-hit-observed'
      : repeatHit >= Math.floor(noise * 0.5) ? 'cache-hit-observed' : 'partial-cache-hit-observed';
  }
  if (typeof anchor === 'number') {
    observed.anchorPromptTokens = anchor;
    observed.anchorExpectedPixels = 994;
    observed.anchorDelta = anchor - 994;
    observed.anchor = Math.abs(anchor - 994) <= 64 ? 'consistent-with-formula'
      : Math.abs(anchor - 384) <= 64 ? 'conflicts-with-formula' : 'unexpected-value';
  }
  const overhead = typeof color === 'number' ? color - 184 : undefined;
  const clampSample = prompt(byId.get('clamp-1568'));
  if (typeof clampSample === 'number' && typeof overhead === 'number') {
    const imageTokens = clampSample - overhead;
    observed.clampPromptTokens = clampSample;
    observed.clampImageTokens = imageTokens;
    observed.clamp = Math.abs(imageTokens - 1024) <= 8 ? 'clamp-1024-confirmed'
      : Math.abs(imageTokens - 1484) <= 8 ? 'no-clamp-observed'
        : Math.abs(imageTokens - 652) <= 8 ? 'resized-to-1024-first' : 'unexpected-value';
  }
  const laneTable = [
    { lane: 'deepseek-chat-completions', status: 'measured-this-run', observed },
    { lane: 'qwen-vl-chat-completions', status: '未实测-无来源' },
    { lane: 'anthropic-messages', status: '未实测-无来源' }
  ];
  return { observed, laneTable };
}

async function readReport(file) {
  try {
    const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function writeReport(file, report) {
  const directory = path.dirname(file);
  if (directory && directory !== '.') await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(file, JSON.stringify(report, null, 2) + '\n');
}

async function main() {
  const [storageDir, output, sampleList] = process.argv.slice(2);
  if (!storageDir || !output) throw new Error('Expected STORAGE_DIR OUT.json [SAMPLE_IDS]');
  const sampleIds = (sampleList ? sampleList.split(',') : DEFAULT_SAMPLE_IDS)
    .map((value) => value.trim())
    .filter(Boolean);
  if (!sampleIds.length || new Set(sampleIds).size !== sampleIds.length) {
    throw new Error('SAMPLE_IDS must be a non-empty unique list');
  }
  for (const id of sampleIds) if (!SAMPLE_PLAN[id]) throw new Error('unknown probe sample: ' + id);
  const previous = await readReport(output);
  const used = Number.isInteger(previous && previous.physicalRequestCount) ? previous.physicalRequestCount : 0;
  if (used + sampleIds.length > MAX_PHYSICAL_REQUESTS) {
    throw new Error(`refusing to exceed ${MAX_PHYSICAL_REQUESTS} physical requests; ${used} already recorded`);
  }
  const selected = await readSelectedSource(storageDir);
  const endpoint = chatCompletionsUrl(selected.baseUrl);
  const report = previous || { version: 1, kind: 'image-tokenization-probe', runs: [], physicalRequestCount: 0 };
  report.runs = Array.isArray(report.runs) ? report.runs : [];
  report.physicalRequestCount = used;
  const run = {
    startedAt: new Date().toISOString(),
    transport: 'native fetch, non-streaming chat/completions',
    requestedSamples: sampleIds,
    lane: {
      provider: 'deepseek',
      sourceId: selected.sourceId,
      modelId: selected.modelId,
      endpointHost: new URL(endpoint).host,
      modelListed: selected.modelListed
    },
    samples: [],
    log: []
  };
  report.runs.push(run);
  const imageFor = createImageFactory();
  let stopReason;
  for (const id of sampleIds) {
    const plan = SAMPLE_PLAN[id];
    const image = imageFor(id);
    const predicted = deepSeekPixelFormula(image.width, image.height);
    const line = `[probe] ${id} purpose=${plan.purpose} | expectation=${plan.expectation}`
      + ` | image=${image.width}x${image.height} pngBytes=${image.bytes.length} sha256=${image.sha256}`
      + ` | predictedDeepSeekPixels=${predicted.tokens}`;
    console.log(line);
    run.log.push(line);
    const sample = {
      sampleId: id,
      purpose: plan.purpose,
      expectation: plan.expectation,
      image: {
        width: image.width,
        height: image.height,
        bytes: image.bytes.length,
        sha256: image.sha256,
        mimeType: 'image/png'
      },
      predictedDeepSeekPixels: predicted
    };
    if (stopReason) {
      sample.status = 'skipped';
      sample.skipReason = stopReason;
      run.samples.push(sample);
      await writeReport(output, report);
      continue;
    }
    run.samples.push(sample);
    report.physicalRequestCount += 1;
    await writeReport(output, report);
    const startedAt = Date.now();
    try {
      const response = await postImage({
        url: endpoint,
        apiKey: selected.apiKey,
        modelId: selected.modelId,
        dataUrl: `data:image/png;base64,${image.bytes.toString('base64')}`
      });
      sample.status = response.ok ? 'responded' : 'rejected';
      sample.httpStatus = response.status;
      sample.requestBytes = response.requestBytes;
      sample.wallMs = response.wallMs;
      sample.responseBodyBytes = Buffer.byteLength(response.text);
      if (response.ok) {
        const parsed = tryJson(response.text);
        sample.usage = readUsage(parsed);
        const choices = parsed && Array.isArray(parsed.choices) ? parsed.choices : [];
        sample.finishReason = typeof choices[0]?.finish_reason === 'string' ? choices[0].finish_reason : undefined;
        if (!sample.usage) sample.note = 'response carried no usage object';
      } else {
        sample.errorMessage = readErrorMessage(response.text);
        sample.stopReasonCandidate = classifyStop(response.status, sample.errorMessage);
        if (sample.stopReasonCandidate) stopReason = sample.stopReasonCandidate;
      }
    } catch (error) {
      sample.status = 'transport-error';
      sample.errorName = error && error.name ? error.name : 'Error';
      sample.errorCode = error && error.cause && typeof error.cause === 'object' && error.cause.code
        ? error.cause.code
        : undefined;
      sample.errorMessage = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_PREVIEW_CHARS);
      if (sample.errorName === 'TimeoutError') stopReason = 'request-timeout';
    }
    sample.totalMs = Date.now() - startedAt;
    await writeReport(output, report);
  }
  run.finishedAt = new Date().toISOString();
  run.stopReason = stopReason || null;
  run.conclusion = classifyRun(run);
  report.finishedAt = new Date().toISOString();
  report.laneTable = run.conclusion.laneTable;
  await writeReport(output, report);
  console.log(JSON.stringify({
    output,
    physicalRequestCount: report.physicalRequestCount,
    stopReason: run.stopReason,
    laneTable: run.conclusion.laneTable
  }));
}

main().catch((error) => {
  process.stderr.write('image_tokenization_probe_failed: '
    + (error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});