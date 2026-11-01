import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type * as vscode from 'vscode';

export interface LegacyVerifiedRange { offset: number; bytes: number; hash: string; }
/** Remember offsets only, never private transcript text. The initial JSON has
 * already been parsed. Subsequent local reads reverify canonical and binding
 * byte ranges, including changes that preserve mtime/size. */
export function legacyVerifiedRanges(text: string, combined: boolean): LegacyVerifiedRange[] {
  const paths = combined ? [['metadata'], ['transcript', 'metadataId'], ['transcript', 'result'], ['transcript', 'resultRef']]
    : [['metadataId'], ['result'], ['resultRef']];
  return paths.flatMap(path => {
    const range = memberRange(text, path);
    if (!range) return [];
    const offset = Buffer.byteLength(text.slice(0, range[0])), bytes = Buffer.from(text.slice(range[0], range[1]));
    return [{ offset, bytes: bytes.length, hash: digest(bytes) }];
  });
}
export async function verifyLegacyRanges(uri: vscode.Uri, ranges: readonly LegacyVerifiedRange[]): Promise<void> {
  const handle = await open(uri.fsPath, 'r');
  try {
    for (const range of ranges) {
      const bytes = Buffer.alloc(range.bytes);
      let position = 0;
      while (position < bytes.length) {
        const read = await handle.read(bytes, position, bytes.length - position, range.offset + position);
        if (!read.bytesRead) throw new Error('Legacy canonical result changed.');
        position += read.bytesRead;
      }
      if (digest(bytes) !== range.hash) throw new Error('Legacy canonical result integrity mismatch.');
    }
  } finally { await handle.close(); }
}
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function memberRange(text: string, path: readonly string[]): [number, number] | undefined {
  const whitespace = (start: number) => { while (/\s/u.test(text[start] ?? '') && start < text.length) start++; return start; };
  const stringEnd = (start: number) => {
    let cursor = start + 1;
    while (cursor < text.length) {
      const quote = text.indexOf('"', cursor);
      if (quote < 0) break;
      let escapes = 0;
      for (let position = quote - 1; position > start && text[position] === '\\'; position--) escapes++;
      if (escapes % 2 === 0) return quote + 1;
      cursor = quote + 1;
    }
    throw new Error('Invalid legacy JSON string.');
  };
  const valueEnd = (start: number, depth = 0): number => {
    if (depth > 128) throw new Error('Legacy JSON nesting exceeds the reader limit.');
    start = whitespace(start);
    if (text[start] === '"') return stringEnd(start);
    if (text[start] === '{' || text[start] === '[') {
      const closing = text[start] === '{' ? '}' : ']'; let cursor = start + 1;
      while (cursor < text.length) {
        cursor = whitespace(cursor);
        if (text[cursor] === closing) return cursor + 1;
        if (text[cursor] === ',' || text[cursor] === ':') { cursor++; continue; }
        cursor = valueEnd(cursor, depth + 1);
      }
      throw new Error('Invalid legacy JSON container.');
    }
    let cursor = start; while (cursor < text.length && !/[\s,\]}]/u.test(text[cursor]!)) cursor++;
    if (cursor === start) throw new Error('Invalid legacy JSON value.');
    return cursor;
  };
  const find = (start: number, position: number): [number, number] | undefined => {
    start = whitespace(start);
    if (position === path.length) return [start, valueEnd(start)];
    if (text[start] !== '{') return undefined;
    let cursor = start + 1;
    while (cursor < text.length) {
      cursor = whitespace(cursor); if (text[cursor] === '}') return undefined;
      const keyEnd = stringEnd(cursor), key = JSON.parse(text.slice(cursor, keyEnd)) as string;
      cursor = whitespace(keyEnd); if (text[cursor] !== ':') throw new Error('Invalid legacy JSON member.');
      cursor = whitespace(cursor + 1);
      if (key === path[position]) return find(cursor, position + 1);
      cursor = whitespace(valueEnd(cursor)); if (text[cursor] === ',') cursor++;
    }
    return undefined;
  };
  return find(0, 0);
}
