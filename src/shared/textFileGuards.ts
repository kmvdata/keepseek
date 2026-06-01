import * as path from 'node:path';
import * as vscode from 'vscode';

const SKIPPED_TEXT_EXTENSIONS = new Set([
  '.3gp',
  '.7z',
  '.aac',
  '.ai',
  '.avi',
  '.avif',
  '.bmp',
  '.bz2',
  '.class',
  '.dll',
  '.dmg',
  '.doc',
  '.docx',
  '.dylib',
  '.eot',
  '.exe',
  '.fig',
  '.flac',
  '.flv',
  '.gif',
  '.gz',
  '.heic',
  '.heif',
  '.icns',
  '.ico',
  '.jar',
  '.jpeg',
  '.jpg',
  '.m4a',
  '.mkv',
  '.mov',
  '.mp3',
  '.mp4',
  '.ogg',
  '.otf',
  '.pdf',
  '.png',
  '.psd',
  '.rar',
  '.sketch',
  '.so',
  '.svg',
  '.tar',
  '.tif',
  '.tiff',
  '.ttf',
  '.wasm',
  '.wav',
  '.webm',
  '.webp',
  '.wmv',
  '.woff',
  '.woff2',
  '.xz',
  '.zip'
]);

export function shouldSkipTextUri(uri: vscode.Uri): boolean {
  return SKIPPED_TEXT_EXTENSIONS.has(path.extname(uri.fsPath || uri.path).toLowerCase());
}

export function isReadableTextContent(content: string): boolean {
  const sample = content.slice(0, 8192);
  if (!sample) {
    return true;
  }

  let suspiciousCharacters = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0 || code === 0xfffd || (code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13)) {
      suspiciousCharacters += 1;
    }
  }

  return suspiciousCharacters / sample.length < 0.03;
}
