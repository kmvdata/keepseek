import type { ImageMimeType } from './imageHeader';
import { MAX_IMAGE_ATTACHMENT_BYTES } from './imageIntake';

/**
 * Pure routing for the merged "add file or image" entry.
 *
 * The extension-point picker returns files and folders in one list; the caller
 * must decide per item without guessing from the icon the platform showed. The
 * decision is byte based: an extension only decides whether reading the file is
 * worth it, and the magic bytes decide whether the item really is an image.
 *
 * Nothing here performs I/O, so the whole matrix (folder, image, file, oversized
 * image, misleading extension) is unit testable without a VS Code host.
 */
export const IMAGE_FILE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'] as const;

export type PickedEntryRoute =
  | { kind: 'directory' }
  /** An image-sized candidate whose bytes still have to be sniffed. */
  | { kind: 'probe_image' }
  | { kind: 'image'; mimeType: ImageMimeType }
  /** Image-looking, but past the per-image attachment limit: never read. */
  | { kind: 'image_too_large' }
  | { kind: 'file' };

export interface PickedEntryProbe {
  /** Display name (basename) of the picked item. */
  name: string;
  isDirectory: boolean;
  /** Byte length from `stat`; a directory or an unknown size routes as a file. */
  size?: number;
  /**
   * Magic-byte result. `undefined` means the bytes were not read yet; `null`
   * means they were read and are not a supported image, which is exactly the
   * "PNG extension over a text file" case that must stay a plain reference.
   */
  sniffedMimeType?: ImageMimeType | null;
}

export interface PickedEntryRouteOptions {
  maxImageBytes?: number;
}

/** Extension pre-filter only: it decides whether a byte probe is worth a read. */
export function hasImageFileExtension(name: string): boolean {
  const normalized = String(name || '').trim().toLowerCase();
  return IMAGE_FILE_EXTENSIONS.some(
    (extension) => normalized.length > extension.length && normalized.endsWith(extension)
  );
}

export function routePickedEntry(
  entry: PickedEntryProbe,
  options: PickedEntryRouteOptions = {}
): PickedEntryRoute {
  if (entry.isDirectory) {
    return { kind: 'directory' };
  }
  if (!hasImageFileExtension(entry.name)) {
    return { kind: 'file' };
  }
  const size = typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0
    ? entry.size
    : undefined;
  // Without a size the read cannot be proven to stay inside the limit, and an
  // unbounded read is exactly what the limit exists to prevent.
  if (size === undefined) {
    return { kind: 'file' };
  }
  const maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_ATTACHMENT_BYTES;
  if (size > maxImageBytes) {
    return { kind: 'image_too_large' };
  }
  if (entry.sniffedMimeType === undefined) {
    return { kind: 'probe_image' };
  }
  if (entry.sniffedMimeType === null) {
    return { kind: 'file' };
  }
  return { kind: 'image', mimeType: entry.sniffedMimeType };
}