/**
 * Pure byte-level image header reading.
 *
 * No I/O and no dependency: the same module serves host intake validation
 * (`imageIntake`) and image token estimation. Width/height never come from the
 * model or the clipboard: they are read from the encoded file header and then
 * cross-checked against whatever the sender reported.
 */
export type ImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface ImageHeader {
  mimeType: ImageMimeType;
  width: number;
  height: number;
}

/** Bytes kept after the header probe. Enough for PNG IHDR, a JPEG SOF segment
 * inside the first segments, and every WebP variant header. */
const HEADER_PROBE_BYTES = 96;
const MAX_IMAGE_DIMENSION = 65_535;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff] as const;
const GIF_SIGNATURE = [0x47, 0x49, 0x46, 0x38] as const;

export function sniffImageMimeType(bytes: Uint8Array): ImageMimeType | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    return 'image/png';
  }
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    return 'image/jpeg';
  }
  if (startsWith(bytes, GIF_SIGNATURE)) {
    return 'image/gif';
  }
  return isWebp(bytes) ? 'image/webp' : undefined;
}

export function readImageHeader(bytes: Uint8Array): ImageHeader | undefined {
  const mimeType = sniffImageMimeType(bytes);
  if (!mimeType) {
    return undefined;
  }
  const size = mimeType === 'image/png'
    ? readPngSize(bytes)
    : mimeType === 'image/jpeg'
      ? readJpegSize(bytes)
      : mimeType === 'image/webp'
        ? readWebpSize(bytes)
        : readGifSize(bytes);
  if (!size) {
    return undefined;
  }
  const width = normalizeDimension(size.width);
  const height = normalizeDimension(size.height);
  return width && height ? { mimeType, width, height } : undefined;
}

/** Same check against a `data:<mime>;base64,<payload>` URL. The declared mime
 * type must match the sniffed one, otherwise the header is not trusted. */
export function readImageHeaderFromDataUrl(dataUrl: string): ImageHeader | undefined {
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/u.exec(dataUrl.trim());
  if (!match) {
    return undefined;
  }
  const header = readImageHeader(decodeBase64Prefix(match[2]));
  return header && header.mimeType === match[1] ? header : undefined;
}

/** Decodes only the header window of a base64 payload. Callers that need the
 * whole file decode it themselves; this stays allocation bounded. */
export function decodeBase64Prefix(payload: string, maxBytes: number = HEADER_PROBE_BYTES): Uint8Array {
  const chunk = payload.slice(0, Math.ceil(Math.max(1, maxBytes) / 3) * 4);
  const aligned = chunk.slice(0, chunk.length - (chunk.length % 4));
  return new Uint8Array(Buffer.from(aligned, 'base64'));
}

function readPngSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || readAscii(bytes, 12, 4) !== 'IHDR') {
    return undefined;
  }
  return { width: readUint32BE(bytes, 16), height: readUint32BE(bytes, 20) };
}

function readJpegSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  let offset = 2;
  while (offset + 1 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    let markerOffset = offset + 1;
    while (markerOffset < bytes.length && bytes[markerOffset] === 0xff) {
      markerOffset += 1;
    }
    const marker = bytes[markerOffset];
    if (marker === undefined) {
      return undefined;
    }
    const segmentOffset = markerOffset + 1;
    // Standalone markers carry no payload length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset = segmentOffset;
      continue;
    }
    if (segmentOffset + 2 > bytes.length) {
      return undefined;
    }
    const segmentLength = readUint16BE(bytes, segmentOffset);
    if (segmentLength < 2) {
      return undefined;
    }
    if (isStartOfFrame(marker)) {
      if (segmentOffset + 7 > bytes.length) {
        return undefined;
      }
      return {
        height: readUint16BE(bytes, segmentOffset + 3),
        width: readUint16BE(bytes, segmentOffset + 5)
      };
    }
    offset = segmentOffset + segmentLength;
  }
  return undefined;
}

function readWebpSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const chunk = readAscii(bytes, 12, 4);
  if (chunk === 'VP8X') {
    if (bytes.length < 30) {
      return undefined;
    }
    return { width: readUint24LE(bytes, 24) + 1, height: readUint24LE(bytes, 27) + 1 };
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25 || bytes[20] !== 0x2f) {
      return undefined;
    }
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (bytes.length < 30 || bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
      return undefined;
    }
    return {
      width: readUint16LE(bytes, 26) & 0x3fff,
      height: readUint16LE(bytes, 28) & 0x3fff
    };
  }
  return undefined;
}

function readGifSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 10) {
    return undefined;
  }
  return { width: readUint16LE(bytes, 6), height: readUint16LE(bytes, 8) };
}

function isStartOfFrame(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

function isWebp(bytes: Uint8Array): boolean {
  return readAscii(bytes, 0, 4) === 'RIFF' && readAscii(bytes, 8, 4) === 'WEBP';
}

function normalizeDimension(value: number): number | undefined {
  return Number.isSafeInteger(value) && value > 0 && value <= MAX_IMAGE_DIMENSION ? value : undefined;
}

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) {
    return false;
  }
  return signature.every((byte, index) => bytes[index] === byte);
}

function readAscii(bytes: Uint8Array, offset: number, length: number): string {
  if (offset + length > bytes.length) {
    return '';
  }
  let text = '';
  for (let index = 0; index < length; index += 1) {
    text += String.fromCharCode(bytes[offset + index]);
  }
  return text;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readUint24LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}
