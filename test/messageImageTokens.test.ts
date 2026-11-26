import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readImageHeader, readImageHeaderFromDataUrl, sniffImageMimeType } from '../src/attachments/imageHeader';
import { inspectImagePayload } from '../src/attachments/imageIntake';
import {
  appendImagePlaceholders,
  imageBase64Payload,
  projectDeepSeekContentText,
  resolveImageParts,
  toAnthropicUserContent,
  toChatCompletionsContent
} from '../src/agent/multimodal/imageParts';
import { refusesNewImages, resolveImageLaneCapability } from '../src/agent/multimodal/imageCapability';
import { getInputScript } from '../src/webview/input/script';
import { getInputTemplate } from '../src/webview/input/template';
import type { MessageAttachment } from '../src/shared/types';
import {
  estimateAnthropicImageTokens,
  estimateDeepSeekImageTokens,
  estimateImageTokens,
  estimateProjectedTokenCount,
  estimateQwenImageTokens,
  projectImagePayloadsForTokenEstimate
} from '../src/agent/multimodal/imageTokens';

function pngBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  writeUint32BE(bytes, 16, width);
  writeUint32BE(bytes, 20, height);
  return bytes;
}

function jpegBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(29);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10], 0);
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08], 20);
  writeUint16BE(bytes, 25, height);
  writeUint16BE(bytes, 27, width);
  return bytes;
}

function gifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  writeUint16LE(bytes, 6, width);
  writeUint16LE(bytes, 8, height);
  return bytes;
}

function writeUint16BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 8) & 0xff;
  bytes[offset + 1] = value & 0xff;
}

function writeUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function toDataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

test('deepseek image tokens reproduce the measured anchors and clamp conservatively', () => {
  assert.equal(estimateDeepSeekImageTokens(512, 512), 184, 'the 2 KB solid colour and the 787 KB noise probe both measured 184');
  assert.equal(estimateDeepSeekImageTokens(800, 800), 422, 'the brief anchor');
  assert.equal(estimateDeepSeekImageTokens(1302, 1302), 994, 'the 1302x1302 probe measured 994');
  assert.equal(
    estimateDeepSeekImageTokens(1568, 1568),
    1024,
    'the lane measured 994 after downsampling to a 31x31 grid; 1024 is the conservative ceiling and never under-counts'
  );
});

test('qwen tiles follow the 28 px and 32 px variants', () => {
  assert.equal(estimateQwenImageTokens(512, 512, 'qwen2.5-vl-7b'), 363);
  // The brief anchor for the 32 px tile was 66. The brief formula cannot produce
  // it (66 = 8x8 tiles, i.e. a 64 px effective tile), so the formula is
  // implemented exactly as specified and the mismatch is reported instead of
  // being absorbed into a rewritten expectation.
  assert.equal(estimateQwenImageTokens(512, 512, 'qwen3-vl-plus'), 258);
  assert.equal(estimateQwenImageTokens(512, 512), 258, 'an unknown qwen variant keeps the 32 px tile');
});

test('anthropic prices by pixel area and unmeasured lanes stay conservative', () => {
  assert.equal(estimateAnthropicImageTokens(1024, 1024), 1399);
  assert.equal(estimateImageTokens({ width: 512, height: 512, provider: 'glm' }), 1280);
  assert.equal(estimateImageTokens({ width: 0, height: 512, provider: 'deepseek' }), 1280, 'unknown geometry falls back to the conservative allowance');
});

test('provider dispatch picks the matching formula', () => {
  assert.equal(
    estimateImageTokens({ width: 1302, height: 1302, provider: 'deepseek', modelId: 'deepseek-v4.1-flash-1017' }),
    994
  );
  assert.equal(estimateImageTokens({ width: 1024, height: 1024, provider: 'anthropic-compatible' }), 1399);
  assert.equal(estimateImageTokens({ width: 512, height: 512, provider: 'qwencloud', modelId: 'qwen2.5-vl-7b' }), 363);
});

test('image headers are read from bytes and from a data url', () => {
  const png = pngBytes(1302, 1302);
  assert.deepEqual(readImageHeader(png), { mimeType: 'image/png', width: 1302, height: 1302 });
  assert.deepEqual(readImageHeaderFromDataUrl(toDataUrl('image/png', png)), {
    mimeType: 'image/png',
    width: 1302,
    height: 1302
  });
  assert.equal(
    readImageHeaderFromDataUrl(toDataUrl('image/jpeg', png)),
    undefined,
    'a declared mime type that disagrees with the signature is rejected'
  );
  assert.deepEqual(readImageHeader(gifBytes(3, 5)), { mimeType: 'image/gif', width: 3, height: 5 });
  assert.deepEqual(readImageHeader(jpegBytes(640, 480)), { mimeType: 'image/jpeg', width: 640, height: 480 });
});

test('base64 image payloads are priced by geometry instead of characters', () => {
  const payload = `${Buffer.from(pngBytes(512, 512)).toString('base64')}${'A'.repeat(120_000)}`;
  const dataUrl = `data:image/png;base64,${payload}`;
  const projection = projectImagePayloadsForTokenEstimate(dataUrl, {
    provider: 'deepseek',
    modelId: 'deepseek-v4.1-flash-1017'
  });
  assert.equal(projection.imageTokens, 184);
  assert.ok(projection.text.length < 64, 'the payload never survives into the counted text');
  const serialized = JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }] }]
  });
  const tokens = estimateProjectedTokenCount(serialized, { provider: 'deepseek' });
  assert.ok(tokens < 300, `a large image must not be counted as base64 characters (got ${tokens})`);
});

test('raw base64 carried by a data field is priced too', () => {
  const payload = `${Buffer.from(pngBytes(1024, 1024)).toString('base64')}${'A'.repeat(400)}`;
  const serialized = JSON.stringify({
    messages: [{
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload } }]
    }]
  });
  const projection = projectImagePayloadsForTokenEstimate(serialized, { provider: 'anthropic-compatible' });
  assert.equal(projection.imageTokens, 1399);
  assert.ok(!projection.text.includes(payload.slice(0, 40)), 'the payload leaves the counted text');
});

function writeUint24LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}

function writeUint32LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
  bytes[offset + 3] = (value >>> 24) & 0xff;
}

function webpVp8xBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  writeUint32LE(bytes, 4, 22);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  writeUint32LE(bytes, 16, 10);
  bytes[20] = 0x10;
  writeUint24LE(bytes, 24, width - 1);
  writeUint24LE(bytes, 27, height - 1);
  return bytes;
}

function webpVp8lBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(25);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  writeUint32LE(bytes, 4, 17);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x4c], 12);
  bytes[20] = 0x2f;
  const bits = ((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14);
  bytes[21] = bits & 0xff;
  bytes[22] = (bits >>> 8) & 0xff;
  bytes[23] = (bits >>> 16) & 0xff;
  bytes[24] = (bits >>> 24) & 0xff;
  return bytes;
}

function webpVp8Bytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  writeUint32LE(bytes, 4, 22);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x20], 12);
  writeUint32LE(bytes, 16, 10);
  bytes[23] = 0x9d;
  bytes[24] = 0x01;
  bytes[25] = 0x2a;
  writeUint16LE(bytes, 26, width);
  writeUint16LE(bytes, 28, height);
  return bytes;
}

function countOccurrences(value: string, needle: string): number {
  let total = 0;
  let index = value.indexOf(needle);
  while (index >= 0) {
    total += 1;
    index = value.indexOf(needle, index + needle.length);
  }
  return total;
}

function sampleAttachment(overrides: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'image-0000',
    kind: 'image',
    scope: 'user',
    sha256: 'a'.repeat(64),
    mimeType: 'image/png',
    bytes: 33,
    width: 8,
    height: 8,
    createdAt: new Date(0).toISOString(),
    sourceName: 'shot.png',
    ...overrides
  };
}

test('webp headers resolve for the vp8x, vp8l and lossy vp8 chunks', () => {
  assert.deepEqual(readImageHeader(webpVp8xBytes(1302, 901)), {
    mimeType: 'image/webp',
    width: 1302,
    height: 901
  });
  assert.deepEqual(readImageHeader(webpVp8lBytes(300, 200)), {
    mimeType: 'image/webp',
    width: 300,
    height: 200
  });
  assert.deepEqual(readImageHeader(webpVp8Bytes(64, 48)), {
    mimeType: 'image/webp',
    width: 64,
    height: 48
  });
  assert.equal(sniffImageMimeType(webpVp8xBytes(4, 4)), 'image/webp');
  assert.equal(
    readImageHeaderFromDataUrl(toDataUrl('image/jpeg', webpVp8lBytes(8, 8))),
    undefined,
    'a webp payload declared as jpeg is not trusted'
  );
});

test('a declared mime type that disagrees with the magic bytes never reaches the store', () => {
  const png = pngBytes(8, 8);
  const mismatched = inspectImagePayload({ bytes: png, declaredMimeType: 'image/webp' });
  assert.equal(mismatched.ok, false);
  if (!mismatched.ok) {
    assert.equal(mismatched.code, 'mime_type_mismatch');
  }
  const fromDataUrl = inspectImagePayload({ dataUrl: toDataUrl('image/jpeg', png) });
  assert.equal(fromDataUrl.ok, false);
  if (!fromDataUrl.ok) {
    assert.equal(fromDataUrl.code, 'mime_type_mismatch');
  }
  const notAnImage = inspectImagePayload({ bytes: new Uint8Array([1, 2, 3, 4]), declaredMimeType: 'image/png' });
  assert.equal(notAnImage.ok, false);
  if (!notAnImage.ok) {
    assert.equal(notAnImage.code, 'unsupported_format');
  }
  assert.equal(inspectImagePayload({ bytes: png, declaredMimeType: 'application/pdf' }).ok, false);
});

test('base64 appears only in image_url.url and anthropic source.data', () => {
  const attachment = sampleAttachment();
  const dataUrl = toDataUrl('image/png', pngBytes(8, 8));
  const payload = imageBase64Payload(dataUrl);
  assert.ok(payload, 'the sample data url is a base64 image url');
  const resolution = resolveImageParts([attachment], new Map([[attachment.sha256, dataUrl]]));
  assert.equal(resolution.images.length, 1);

  const chatContent = toChatCompletionsContent('describe this', resolution.images);
  assert.notEqual(typeof chatContent, 'string', 'a message carrying an image is a part array');
  const chatBody = JSON.stringify({ messages: [{ role: 'user', content: chatContent }] });
  assert.equal(countOccurrences(chatBody, 'base64,'), 1, 'exactly one base64 payload in the chat body');
  assert.ok(
    chatBody.includes(`"image_url":{"url":"${dataUrl}"`),
    'the payload sits in image_url.url and nowhere else'
  );
  assert.ok(!projectDeepSeekContentText(chatContent).includes(payload!.slice(0, 24)),
    'the text projection never carries the payload');

  const anthropicBlocks = toAnthropicUserContent('describe this', resolution.images);
  assert.deepEqual(anthropicBlocks, [
    { type: 'text', text: 'describe this' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: payload } }
  ]);
  const anthropicBody = JSON.stringify({ messages: [{ role: 'user', content: anthropicBlocks }] });
  const textBlocks = anthropicBlocks.filter((block) => block.type === 'text');
  assert.ok(textBlocks.every((block) => block.type === 'text' && !block.text.includes(payload!)),
    'no text block carries bytes');
  assert.equal(countOccurrences(anthropicBody, 'base64,'), 0,
    'anthropic carries the raw payload, never a data url');

  assert.equal(toChatCompletionsContent('plain text', []), 'plain text',
    'a text-only message keeps the exact string content');
  assert.equal(typeof toChatCompletionsContent('plain text', []), 'string');
});

test('an unmeasured lane refuses new images and degrades deterministically', () => {
  const unverified = resolveImageLaneCapability({
    provider: 'anthropic-compatible',
    protocol: 'anthropic-messages',
    baseUrl: 'https://api.example.test',
    modelId: 'claude-lane'
  });
  assert.equal(unverified.capability, 'unverified');
  assert.ok(unverified.reason.zh.length > 0 && unverified.reason.en.length > 0,
    'a refusal always has displayable copy in both languages');
  assert.equal(refusesNewImages(unverified, true), true);
  assert.equal(refusesNewImages(unverified, false), false, 'history-only turns still run');

  const measured = resolveImageLaneCapability({
    provider: 'deepseek',
    protocol: 'deepseek',
    baseUrl: 'https://token-plan.maas.qwencloudapi.com/v1',
    modelId: 'deepseek-v4.1-flash-1017'
  });
  assert.equal(measured.capability, 'supported');
  assert.equal(refusesNewImages(measured, true), false);

  const unsupported = resolveImageLaneCapability({
    provider: 'openai-responses',
    protocol: 'openai-responses',
    baseUrl: 'https://api.example.test',
    modelId: 'gpt-lane'
  });
  assert.equal(unsupported.capability, 'unsupported');
  assert.equal(refusesNewImages(unsupported, true), true);

  const attachment = sampleAttachment();
  const degraded = resolveImageParts([attachment], new Map());
  assert.equal(degraded.images.length, 0, 'an unloadable hash never renders an image');
  assert.equal(degraded.missing.length, 1);
  const first = appendImagePlaceholders('hello', degraded.missing);
  const second = appendImagePlaceholders('hello', degraded.missing);
  assert.equal(first, second, 'degradation is byte identical on every turn');
  assert.equal(first, 'hello\n[image: shot.png (8×8)]');

  const rendered = resolveImageParts([attachment], new Map([
    [attachment.sha256, toDataUrl('image/png', pngBytes(8, 8))]
  ]));
  assert.equal(appendImagePlaceholders('hello', rendered.missing), 'hello',
    'a rendered image never also emits its placeholder');
});

test('one 100 KB image adds far less than 3000 estimated tokens', () => {
  const plainTokens = estimateProjectedTokenCount(
    JSON.stringify({ messages: [{ role: 'user', content: 'look at this' }] }),
    { provider: 'deepseek' }
  );
  const noisyPayload = `${Buffer.from(pngBytes(1302, 1302)).toString('base64')}${'A'.repeat(136_000)}`;
  const withImage = estimateProjectedTokenCount(
    JSON.stringify({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${noisyPayload}` } }
        ]
      }]
    }),
    { provider: 'deepseek' }
  );
  const delta = withImage - plainTokens;
  assert.ok(delta > 0, 'the image is not free');
  assert.ok(delta <= 3000, `a ~100 KB image must stay under the 3000-token allowance (got ${delta})`);
});

test('one merged entry adds a reference or an image attachment', () => {
  const template = getInputTemplate();
  const script = getInputScript();

  // The local file control is gone: the host picker is the only entry, so no
  // webview file control ever reads bytes on its own.
  assert.equal(countOccurrences(template, 'composerAttachmentInput'), 0,
    'the hidden attachment file input is removed');
  assert.equal(countOccurrences(script, 'pickPromptImageFromMenu'), 0,
    'the local image picker entry point is removed');

  // One action row, routed by the host after it sniffs the picked bytes.
  assert.ok(script.includes("kind: 'fileOrImagePicker'"),
    'the menu exposes exactly one file-or-image action entry');
  assert.equal(countOccurrences(script, "'imagePicker'"), 0,
    'the separate image entry is gone');

  // The host bridge feeds the same attachment pipeline as paste and drop, so a
  // picked image can never turn into a file reference at the caret.
  assert.ok(script.includes("msg.type !== 'insertComposerImage'"),
    'the composer handles the host image bridge');
  assert.ok(script.includes('attachmentAddFiles([file])'),
    'a bridged image joins the identical transcode path');

  // Numbering is presentation only and follows the visible order.
  assert.ok(template.includes('composer-attachment-index'), 'a chip carries its ordinal badge');
  assert.ok(script.includes("t('imageAttachmentOrdinal'"), 'the chip names its ordinal');
  assert.ok(script.includes('attachmentCreateChip(visibleEntries[i], i)'),
    'chips are numbered by their position in the visible list');

  assert.doesNotThrow(() => new Function(script), 'the composed input script still compiles');
});
