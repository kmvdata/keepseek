import { isReadableTextContent } from './textFileGuards';

const encoder = new TextEncoder();

/**
 * Returns text only when decoding and re-encoding preserves every source byte.
 * This keeps text-backed deletion checkpoints safe for exact rollback.
 */
export function decodeRollbackSafeUtf8Text(bytes: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!isReadableTextContent(text)) {
      return undefined;
    }
    const encoded = encoder.encode(text);
    if (encoded.byteLength !== bytes.byteLength) {
      return undefined;
    }
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (encoded[index] !== bytes[index]) {
        return undefined;
      }
    }
    return text;
  } catch {
    return undefined;
  }
}
