import './registerVscodeStub';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hasImageFileExtension, routePickedEntry } from '../src/attachments/attachmentRouting';
import { MAX_IMAGE_ATTACHMENT_BYTES } from '../src/attachments/imageIntake';

/** The merged "add file or image" entry decides per picked item. These cases are
 * the whole decision matrix: folder, image, non-image, oversized image and the
 * misleading extension that must stay a plain file reference. */

test('a picked folder always becomes a directory reference', () => {
  assert.deepEqual(routePickedEntry({ name: 'src', isDirectory: true }), { kind: 'directory' });
  assert.deepEqual(
    routePickedEntry({ name: 'shot.png', isDirectory: true, size: 4 }),
    { kind: 'directory' },
    'a folder name that looks like an image is still a folder'
  );
});

test('only image-looking names are worth a byte probe', () => {
  for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.webp', 'a.gif', 'SHOT.PNG']) {
    assert.equal(hasImageFileExtension(name), true, name);
  }
  for (const name of ['a.ts', 'a.png.txt', 'png', '.png', 'a.svga', '', 'shot.pngx']) {
    assert.equal(hasImageFileExtension(name), false, name);
  }
});

test('an image-sized candidate asks for the magic-byte probe first', () => {
  assert.deepEqual(
    routePickedEntry({ name: 'shot.png', isDirectory: false, size: 1024 }),
    { kind: 'probe_image' }
  );
});

test('the magic bytes decide, not the extension', () => {
  assert.deepEqual(
    routePickedEntry({ name: 'shot.png', isDirectory: false, size: 1024, sniffedMimeType: 'image/png' }),
    { kind: 'image', mimeType: 'image/png' }
  );
  assert.deepEqual(
    routePickedEntry({ name: 'shot.png', isDirectory: false, size: 1024, sniffedMimeType: null }),
    { kind: 'file' },
    'a png name over non-image bytes stays a plain file reference'
  );
});

test('an oversized image is skipped without being read', () => {
  assert.deepEqual(
    routePickedEntry(
      { name: 'huge.png', isDirectory: false, size: MAX_IMAGE_ATTACHMENT_BYTES + 1 },
      { maxImageBytes: MAX_IMAGE_ATTACHMENT_BYTES }
    ),
    { kind: 'image_too_large' }
  );
  assert.deepEqual(
    routePickedEntry(
      { name: 'edge.png', isDirectory: false, size: MAX_IMAGE_ATTACHMENT_BYTES, sniffedMimeType: 'image/png' },
      { maxImageBytes: MAX_IMAGE_ATTACHMENT_BYTES }
    ),
    { kind: 'image', mimeType: 'image/png' },
    'the limit itself is inclusive'
  );
});

test('an unknown size never triggers an unbounded read', () => {
  assert.deepEqual(
    routePickedEntry({ name: 'shot.png', isDirectory: false }),
    { kind: 'file' },
    'without a size the limit cannot be proven, so no probe is requested'
  );
});

test('non-image files never reach the image path', () => {
  assert.deepEqual(routePickedEntry({ name: 'main.ts', isDirectory: false, size: 10 }), { kind: 'file' });
});
