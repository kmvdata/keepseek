import type { WebviewFragment } from '../composition';

/**
 * Browser-side transcode for composer image attachments.
 *
 * One image crosses the bridge once, already reduced to PNG or JPEG. The host
 * re-validates magic bytes and geometry, so this module must never claim a mime
 * type the produced bytes do not have. A missing capability returns a displayable
 * rejection code instead of dropping the file silently.
 */
export const attachmentTransformFragment: WebviewFragment = {
  id: 'composer.attachment-transform',
  source: `
      var ATTACHMENT_DEFAULT_MAX_EDGE = 1568;
      var ATTACHMENT_MAX_EDGE_LIMIT = 4096;
      var ATTACHMENT_JPEG_QUALITY = 0.85;
      var ATTACHMENT_MAX_SOURCE_BYTES = 32 * 1024 * 1024;
      var ATTACHMENT_MAX_COUNT = 8;
      var ATTACHMENT_TEXT_DENSITY = 0.06;
      var ATTACHMENT_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
      var ATTACHMENT_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

      /** The host publishes the long edge its lane actually recognises: the
       * composer crops to that range on the way in, so no byte is uploaded that
       * the model would only resample away. */
      function attachmentMaxEdge() {
        var configured = Number(state.attachmentImageMaxEdge);
        if (!Number.isFinite(configured) || configured < 64) { return ATTACHMENT_DEFAULT_MAX_EDGE; }
        return Math.min(Math.round(configured), ATTACHMENT_MAX_EDGE_LIMIT);
      }

      /** Decoded size of a data URL payload, so a chip can show the bytes this
       * composer keeps instead of the size of the source file. */
      function attachmentStoredBytes(dataUrl) {
        var text = String(dataUrl || '');
        var comma = text.indexOf(',');
        if (comma < 0) { return 0; }
        var base64 = text.slice(comma + 1);
        var padding = base64.slice(-2) === '==' ? 2 : (base64.slice(-1) === '=' ? 1 : 0);
        return Math.max(0, Math.floor((base64.length * 3) / 4) - padding);
      }

      function attachmentImageMimeType(file) {
        var declared = String((file && file.type) || '').toLowerCase();
        if (ATTACHMENT_IMAGE_MIME_TYPES.indexOf(declared) >= 0) { return declared; }
        var name = String((file && file.name) || '').toLowerCase();
        for (var i = 0; i < ATTACHMENT_IMAGE_EXTENSIONS.length; i++) {
          var extension = ATTACHMENT_IMAGE_EXTENSIONS[i];
          if (name.length <= extension.length || name.slice(-extension.length) !== extension) { continue; }
          if (extension === '.jpg' || extension === '.jpeg') { return 'image/jpeg'; }
          if (extension === '.webp') { return 'image/webp'; }
          if (extension === '.gif') { return 'image/gif'; }
          return 'image/png';
        }
        return '';
      }

      function attachmentLooksLikeImage(file) {
        return Boolean(attachmentImageMimeType(file));
      }

      function attachmentLongEdgeScale(width, height) {
        var longEdge = Math.max(width, height);
        var maxEdge = attachmentMaxEdge();
        if (!Number.isFinite(longEdge) || longEdge <= 0) { return 1; }
        return longEdge > maxEdge ? maxEdge / longEdge : 1;
      }

      function attachmentHasAlphaChannel(bytes, mimeType) {
        if (mimeType === 'image/gif') { return true; }
        if (mimeType === 'image/png') {
          // IHDR colour type lives at byte 25; types 4 and 6 carry alpha.
          return bytes.length > 25 && (bytes[25] === 4 || bytes[25] === 6);
        }
        if (mimeType === 'image/webp' && bytes.length > 20) {
          var riff = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
          var webp = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
          var chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
          if (riff === 'RIFF' && webp === 'WEBP' && chunk === 'VP8X') {
            return (bytes[20] & 0x10) !== 0;
          }
        }
        return false;
      }

      function attachmentLooksLikeText(bytes, mimeType, width, height) {
        if (mimeType !== 'image/png') { return false; }
        var pixels = Math.max(1, width * height);
        return bytes.length / pixels < ATTACHMENT_TEXT_DENSITY;
      }

      function attachmentDecodeBitmap(file) {
        if (typeof createImageBitmap === 'function') {
          return createImageBitmap(file);
        }
        return new Promise(function(resolve, reject) {
          if (typeof Image !== 'function' || !window.URL || !window.URL.createObjectURL) {
            reject(new Error('decode_unsupported'));
            return;
          }
          var objectUrl = window.URL.createObjectURL(file);
          var image = new Image();
          image.onload = function() {
            window.URL.revokeObjectURL(objectUrl);
            resolve(image);
          };
          image.onerror = function() {
            window.URL.revokeObjectURL(objectUrl);
            reject(new Error('decode_failed'));
          };
          image.src = objectUrl;
        });
      }

      function attachmentReadBytes(file) {
        return file.arrayBuffer().then(function(buffer) { return new Uint8Array(buffer); });
      }

      function attachmentTranscode(file) {
        var declared = attachmentImageMimeType(file);
        if (!declared) { return Promise.resolve({ ok: false, code: 'not_image' }); }
        var sourceBytes = Number(file.size) || 0;
        if (sourceBytes > ATTACHMENT_MAX_SOURCE_BYTES) {
          return Promise.resolve({ ok: false, code: 'image_too_large' });
        }
        var bytes = null;
        return attachmentReadBytes(file).then(function(read) {
          bytes = read;
          return attachmentDecodeBitmap(file);
        }).then(function(bitmap) {
          var width = Number(bitmap.width) || 0;
          var height = Number(bitmap.height) || 0;
          if (!width || !height) { throw new Error('invalid_dimensions'); }
          var keepPng = declared !== 'image/jpeg'
            && (declared === 'image/gif'
              || attachmentHasAlphaChannel(bytes, declared)
              || attachmentLooksLikeText(bytes, declared, width, height));
          var outputMime = keepPng ? 'image/png' : 'image/jpeg';
          var scale = attachmentLongEdgeScale(width, height);
          var targetWidth = Math.max(1, Math.round(width * scale));
          var targetHeight = Math.max(1, Math.round(height * scale));
          var canvas = document.createElement('canvas');
          canvas.width = targetWidth;
          canvas.height = targetHeight;
          var context = canvas.getContext ? canvas.getContext('2d') : null;
          if (!context) { throw new Error('canvas_unsupported'); }
          if (!keepPng) {
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, targetWidth, targetHeight);
          }
          context.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
          if (bitmap.close) { bitmap.close(); }
          var dataUrl = canvas.toDataURL(outputMime, ATTACHMENT_JPEG_QUALITY);
          if (!dataUrl || dataUrl.indexOf('data:' + outputMime) !== 0) {
            outputMime = 'image/png';
            dataUrl = canvas.toDataURL('image/png');
          }
          if (!dataUrl || dataUrl.indexOf('data:' + outputMime) !== 0) {
            throw new Error('encode_failed');
          }
          return {
            ok: true,
            dataUrl: dataUrl,
            mimeType: outputMime,
            bytes: attachmentStoredBytes(dataUrl),
            width: targetWidth,
            height: targetHeight,
            originalBytes: sourceBytes,
            originalWidth: width,
            originalHeight: height,
            sourceName: String(file.name || 'image')
          };
        }).catch(function(error) {
          return { ok: false, code: error && error.message === 'invalid_dimensions'
            ? 'invalid_dimensions' : 'transcode_failed' };
        });
      }
`.slice(1)
};
