import { inflate } from 'node:zlib';

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/webp';
export interface ImageMetadata { mime: ImageMime; byteLength: number; width: number; height: number; }
export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_MAX_PIXELS = 40_000_000;
export const IMAGE_MAX_DIMENSION = 16_384;

export class ImageAssetError extends Error {
  public constructor(public readonly code: 'image_invalid' | 'image_too_large' | 'asset_missing' | 'asset_corrupt' | 'asset_forbidden' | 'asset_quota' | 'asset_busy' | 'asset_storage_scheme', message: string) {
    super(message); this.name = 'ImageAssetError';
  }
}

/** Bounded container inspection; never allocates from untrusted image dimensions. */
export function validateImageBytes(input: Uint8Array, expectedMime?: string, maxBytes = IMAGE_MAX_BYTES): ImageMetadata {
  if (!input.byteLength || input.byteLength > maxBytes) throw new ImageAssetError('image_too_large', 'Image byte limit exceeded.');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let info: { mime: ImageMime; width: number; height: number };
  if (bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) info = inspectPng(bytes);
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) info = inspectJpeg(bytes);
  else if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') info = inspectWebp(bytes);
  else throw invalid('Only PNG, JPEG and WebP raster images are accepted.');
  if (expectedMime && expectedMime !== info.mime) throw invalid('Image MIME does not match its bytes.');
  if (!Number.isSafeInteger(info.width) || !Number.isSafeInteger(info.height) || info.width < 1 || info.height < 1) throw invalid('Invalid image dimensions.');
  if (info.width > IMAGE_MAX_DIMENSION || info.height > IMAGE_MAX_DIMENSION || info.width * info.height > IMAGE_MAX_PIXELS) throw new ImageAssetError('image_too_large', 'Image dimensions or pixel limit exceeded.');
  return { ...info, byteLength: input.byteLength };
}

/** Validate PNG compressed scanline bounds off the Extension Host event loop. Other
 * formats are structurally inspected and bounded before any native/UI decoder. */
export async function verifyImageContainer(bytes: Uint8Array, metadata: ImageMetadata): Promise<void> {
  if (metadata.mime !== 'image/png') return;
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const depth = b[24], color = b[25], interlace = b[28];
  // Adam7 has a different row layout. Keep the first release narrow and explicit.
  if (interlace !== 0) throw invalid('Interlaced PNG input is not supported.');
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color];
  const rowBytes = Math.ceil(metadata.width * channels * depth / 8);
  const expected = (rowBytes + 1) * metadata.height;
  if (expected > 160 * 1024 * 1024) throw new ImageAssetError('image_too_large', 'Decoded PNG exceeds the memory safety limit.');
  const data: Buffer[] = [];
  for (let p = 8; p < b.length;) {
    const length = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') data.push(b.subarray(p + 8, p + 8 + length));
    p += length + 12;
  }
  const decoded = await new Promise<Buffer>((resolve, reject) => {
    inflate(Buffer.concat(data), { maxOutputLength: expected }, (error, result) => error ? reject(invalid('Invalid or oversized PNG compressed data.')) : resolve(result));
  });
  if (decoded.length !== expected) throw invalid('PNG scanline length mismatch.');
  for (let p = 0; p < decoded.length; p += rowBytes + 1) if (decoded[p] > 4) throw invalid('Invalid PNG row filter.');
}

function inspectPng(b: Buffer): { mime: ImageMime; width: number; height: number } {
  if (b.length < 45 || b.readUInt32BE(8) !== 13 || b.toString('ascii', 12, 16) !== 'IHDR') throw invalid('Invalid PNG header.');
  const depth = b[24], color = b[25];
  const allowed: Record<number, number[]> = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
  if (!allowed[color]?.includes(depth) || b[26] !== 0 || b[27] !== 0 || b[28] > 1) throw invalid('Unsupported PNG coding.');
  let seenData = false, ended = false, seenPalette = false, dataEnded = false;
  for (let p = 8; p < b.length;) {
    if (p + 12 > b.length) throw invalid('Truncated PNG chunk.');
    const length = b.readUInt32BE(p);
    if (length > b.length - p - 12) throw invalid('Truncated PNG chunk body.');
    const type = b.toString('ascii', p + 4, p + 8);
    if (!/^[A-Za-z]{4}$/u.test(type)) throw invalid('Invalid PNG chunk name.');
    if (crc32(b.subarray(p + 4, p + 8 + length)) !== b.readUInt32BE(p + 8 + length)) throw invalid('PNG chunk checksum mismatch.');
    if (type === 'acTL') throw invalid('Animated images are not supported.');
    if (type === 'IHDR' && p !== 8) throw invalid('Duplicate PNG header.');
    if (type === 'PLTE') {
      if (seenPalette || seenData || !length || length % 3 || length > 768 || color === 0 || color === 4) throw invalid('Invalid PNG palette.');
      seenPalette = true;
    }
    if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !seenPalette)) throw invalid('Invalid PNG image data order.');
      seenData = true;
    } else if (seenData) dataEnded = true;
    if (type[0] === type[0].toUpperCase() && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) throw invalid('Unknown critical PNG chunk.');
    if (type === 'IEND') { if (length || p + 12 !== b.length) throw invalid('Invalid PNG end.'); ended = true; break; }
    p += length + 12;
  }
  if (!seenData || !ended) throw invalid('Incomplete PNG.');
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function inspectJpeg(b: Buffer): { mime: ImageMime; width: number; height: number } {
  if (b.length < 12 || b[b.length - 2] !== 0xff || b[b.length - 1] !== 0xd9) throw invalid('Incomplete JPEG.');
  let width = 0, height = 0, seenScan = false;
  for (let p = 2; p + 1 < b.length;) {
    if (b[p++] !== 0xff) throw invalid('Invalid JPEG marker.');
    while (b[p] === 0xff) p++;
    const marker = b[p++];
    if (marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (p + 2 > b.length) throw invalid('Truncated JPEG segment.');
    const length = b.readUInt16BE(p);
    if (length < 2 || p + length > b.length) throw invalid('Invalid JPEG segment length.');
    if ([0xc0,0xc1,0xc2].includes(marker)) {
      if (length < 8 || b[p + 2] !== 8) throw invalid('Unsupported JPEG frame.');
      height = b.readUInt16BE(p + 3); width = b.readUInt16BE(p + 5);
    }
    p += length;
    if (marker === 0xda) { seenScan = true; break; }
  }
  if (!width || !height || !seenScan) throw invalid('JPEG frame or scan missing.');
  return { mime: 'image/jpeg', width, height };
}

function inspectWebp(b: Buffer): { mime: ImageMime; width: number; height: number } {
  if (b.length < 30 || b.readUInt32LE(4) + 8 !== b.length) throw invalid('Invalid WebP container.');
  let width = 0, height = 0, seenFrame = false;
  for (let p = 12; p < b.length;) {
    if (p + 8 > b.length) throw invalid('Truncated WebP chunk.');
    const type = b.toString('ascii', p, p + 4), length = b.readUInt32LE(p + 4), start = p + 8;
    if (length > b.length - start) throw invalid('Truncated WebP data.');
    if (type === 'ANIM' || type === 'ANMF') throw invalid('Animated images are not supported.');
    if (type === 'VP8X') {
      if (length !== 10 || (b[start] & 2)) throw invalid('Unsupported WebP extended flags.');
      width = b.readUIntLE(start + 4, 3) + 1; height = b.readUIntLE(start + 7, 3) + 1;
    } else if (type === 'VP8 ') {
      if (length < 10 || (b[start] & 1) || !b.subarray(start + 3, start + 6).equals(Buffer.from([0x9d,0x01,0x2a]))) throw invalid('Invalid WebP frame.');
      const w = b.readUInt16LE(start + 6) & 0x3fff, h = b.readUInt16LE(start + 8) & 0x3fff;
      if (width && (width !== w || height !== h)) throw invalid('WebP canvas mismatch.');
      width = w; height = h; seenFrame = true;
    } else if (type === 'VP8L') {
      if (length < 5 || b[start] !== 0x2f) throw invalid('Invalid lossless WebP frame.');
      const bits = b.readUInt32LE(start + 1), w = (bits & 0x3fff) + 1, h = ((bits >>> 14) & 0x3fff) + 1;
      if ((bits >>> 29) !== 0 || (width && (width !== w || height !== h))) throw invalid('Invalid lossless WebP dimensions.');
      width = w; height = h; seenFrame = true;
    }
    p = start + length + (length & 1);
    if (p > b.length) throw invalid('Invalid WebP padding.');
  }
  if (!seenFrame) throw invalid('WebP frame missing.');
  return { mime: 'image/webp', width, height };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(bytes: Uint8Array): number { let c = 0xffffffff; for (const b of bytes) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function invalid(message: string): ImageAssetError { return new ImageAssetError('image_invalid', message); }
