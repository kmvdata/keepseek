import type { MessageAttachment } from '../../shared/types';
import type { DeepSeekContentPart } from '../deepseek/types';
import type { AnthropicUserContentBlock } from '../providers/anthropicTypes';
import { IMAGE_TOKEN_PLACEHOLDER } from './imageTokens';

/**
 * Deterministic assembly of the two wire shapes that may carry image bytes.
 *
 * The only base64 produced here is assigned to `image_url.url` (Chat
 * Completions) or split into Anthropic's `source.data`. It must never enter a
 * content string, a system block, `contextInstructions` or a `tool_result`:
 * those positions are text, so bytes there would both leak the payload and
 * destroy the cache prefix.
 */
export interface ResolvedImagePart {
  sha256: string;
  mimeType: string;
  dataUrl: string;
}

export interface ImagePartResolution {
  /** Attachments whose bytes are available and may be sent inline. */
  images: ResolvedImagePart[];
  /** Attachments that must degrade to placeholder text. */
  missing: MessageAttachment[];
}

/** Text-only lanes and text-only turns must keep the exact string content. */
export function toDataUrl(mimeType: string, bytes: Uint8Array): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;
}

/** Splits a data URL into the raw base64 payload Anthropic expects. Returns
 * undefined for anything that is not a base64 image data URL. */
export function imageBase64Payload(dataUrl: string): string | undefined {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/iu.exec(dataUrl);
  return match ? match[1] : undefined;
}

/** Resolves attachments against the already-loaded hash map. A hash the runner
 * could not load becomes placeholder text instead of a dropped image. */
export function resolveImageParts(
  attachments: readonly MessageAttachment[] | undefined,
  dataUrlByHash: ReadonlyMap<string, string> | undefined
): ImagePartResolution {
  const images: ResolvedImagePart[] = [];
  const missing: MessageAttachment[] = [];
  for (const attachment of attachments ?? []) {
    const dataUrl = dataUrlByHash?.get(attachment.sha256);
    if (!dataUrl) {
      missing.push(attachment);
      continue;
    }
    images.push({ sha256: attachment.sha256, mimeType: attachment.mimeType, dataUrl });
  }
  return { images, missing };
}

/** `[image: <sourceName> (<w>×<h>)]`, with `image` when the name is unknown. */
export function formatImagePlaceholder(attachment: MessageAttachment): string {
  const name = attachment.sourceName?.trim() || 'image';
  return `[image: ${name} (${attachment.width}×${attachment.height})]`;
}

/** Deterministic degradation text: same attachment, same bytes, every turn.
 * The caller decides which attachments degrade, so one turn can never render
 * both an inline image and its placeholder. */
export function appendImagePlaceholders(
  text: string,
  attachments: readonly MessageAttachment[] | undefined
): string {
  if (!attachments?.length) {
    return text;
  }
  const placeholders = attachments.map(formatImagePlaceholder).join('\n');
  return text ? `${text}\n${placeholders}` : placeholders;
}

/**
 * Text projection of a Chat Completions `content` field.
 *
 * Trace, recovery, compression and token-estimate paths are text-only. Widening
 * `DeepSeekMessage.content` to a part array made them accept a value they can
 * only ever handle as text, so they project through here: part arrays degrade to
 * their text plus one `[image]` placeholder, and a base64 payload is never read
 * as text, counted or logged.
 */
export function projectDeepSeekContentText(
  content: string | DeepSeekContentPart[] | null | undefined
): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content.map((part) => (part.type === 'text' ? part.text : IMAGE_TOKEN_PLACEHOLDER)).join('\n');
}

/** Chat Completions content. A text-only message keeps a plain string; only a
 * message that really carries images becomes an ordered part array. */
export function toChatCompletionsContent(
  text: string,
  images: readonly ResolvedImagePart[]
): string | DeepSeekContentPart[] {
  if (!images.length) {
    return text;
  }
  const parts: DeepSeekContentPart[] = [];
  if (text) {
    parts.push({ type: 'text', text });
  }
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
  }
  return parts;
}

/** Anthropic Messages user content. `source.data` is the raw base64 body. */
export function toAnthropicUserContent(
  text: string,
  images: readonly ResolvedImagePart[]
): AnthropicUserContentBlock[] {
  const blocks: AnthropicUserContentBlock[] = [];
  if (text) {
    blocks.push({ type: 'text', text });
  }
  for (const image of images) {
    const data = imageBase64Payload(image.dataUrl);
    if (!data) {
      continue;
    }
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: image.mimeType, data }
    });
  }
  return blocks;
}
