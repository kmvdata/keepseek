import { createHash } from 'node:crypto';
import { isReadableTextContent } from '../shared/textFileGuards';
import type {
  FileContentIdentity,
  TextFileEncoding,
  TextPatchHunkV1,
  TextPatchV1
} from '../shared/types';

export type TextPatchErrorCode =
  | 'invalid_grammar'
  | 'invalid_path'
  | 'invalid_utf8'
  | 'binary_text'
  | 'missing_match'
  | 'ambiguous_match'
  | 'range_out_of_bounds'
  | 'overlapping_hunks'
  | 'base_mismatch'
  | 'hunk_mismatch'
  | 'result_mismatch'
  | 'patch_limit';

export class TextPatchError extends Error {
  public constructor(public readonly code: TextPatchErrorCode, message: string) {
    super(message);
    this.name = 'TextPatchError';
  }
}

export interface TextPatchLimits {
  maxPatchBytes: number;
  maxHunks: number;
  maxChangedBytes: number;
  maxInlineBytes: number;
}

export type TextPatchEditInput =
  | { search: string; replace: string }
  | { startLine: number; endLine: number; replace: string }
  | { insertAt: 'start' | 'end'; replace: string };

export interface KeepseekPatchUpdateOperation {
  action: 'update';
  path: string;
  edits: TextPatchEditInput[];
}

export interface KeepseekPatchAddOperation {
  action: 'add';
  path: string;
  content: string;
}

export interface KeepseekPatchDeleteOperation {
  action: 'delete';
  path: string;
}

export interface KeepseekPatchMoveOperation {
  action: 'move';
  path: string;
  to: string;
}

export type KeepseekPatchOperation = KeepseekPatchUpdateOperation | KeepseekPatchAddOperation
  | KeepseekPatchDeleteOperation | KeepseekPatchMoveOperation;

export interface KeepseekPatchDocumentV1 {
  version: 'keepseek_patch_v1';
  operations: KeepseekPatchOperation[];
}

const encoder = new TextEncoder();
const fatalDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Strict v9 wire grammar. The tool accepts one JSON value only:
 * {"version":"keepseek_patch_v1","operations":[...]}. Unknown keys and
 * absolute/traversing paths are rejected before URI resolution.
 */
export function parseKeepseekPatch(text: string, limits: TextPatchLimits): KeepseekPatchDocumentV1 {
  const bytes = encoder.encode(text).byteLength;
  if (bytes < 1 || bytes > limits.maxPatchBytes) {
    throw new TextPatchError('patch_limit', `Patch payload must be between 1 and ${limits.maxPatchBytes} bytes.`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new TextPatchError('invalid_grammar', 'Patch must be valid JSON in the keepseek_patch_v1 grammar.');
  }
  const root = requireRecord(value, 'patch');
  requireExactKeys(root, ['version', 'operations'], 'patch');
  if (root.version !== 'keepseek_patch_v1' || !Array.isArray(root.operations)
    || root.operations.length < 1 || root.operations.length > limits.maxHunks) {
    throw new TextPatchError('invalid_grammar', `Patch must contain 1-${limits.maxHunks} operations.`);
  }
  const operations = root.operations.map((raw, index) => parseOperation(raw, index, limits));
  const hunkCount = operations.reduce((total, operation) => total
    + (operation.action === 'update' ? operation.edits.length : 1), 0);
  if (hunkCount > limits.maxHunks) {
    throw new TextPatchError('patch_limit', `Patch contains ${hunkCount} operations/hunks, exceeding the ${limits.maxHunks}-hunk limit.`);
  }
  const declaredPaths = new Set<string>();
  for (const operation of operations) {
    for (const candidate of operation.action === 'move' ? [operation.path, operation.to] : [operation.path]) {
      if (declaredPaths.has(candidate)) {
        throw new TextPatchError('invalid_path', `Patch path is declared more than once: ${candidate}`);
      }
      declaredPaths.add(candidate);
    }
  }
  return { version: 'keepseek_patch_v1', operations };
}

export function prepareTextPatch(input: {
  targetUri: string;
  baseBytes: Uint8Array;
  edits: readonly TextPatchEditInput[];
  limits: TextPatchLimits;
  normalizeReplacementEol?: boolean;
}): TextPatchV1 {
  const { text, encoding } = decodeExactUtf8(input.baseBytes);
  if (!input.edits.length || input.edits.length > input.limits.maxHunks) {
    throw new TextPatchError('patch_limit', `A text patch must contain 1-${input.limits.maxHunks} hunks.`);
  }
  const base = Buffer.from(input.baseBytes);
  const textStartByte = encoding.bom === 'utf8' ? 3 : 0;
  const lineStarts = collectLineStartBytes(base, textStartByte);
  const defaultEol = chooseReplacementEol(encoding, base);
  const hunks = input.edits.map((edit) => {
    let startByte: number;
    let endByte: number;
    let replacement: string;
    if ('search' in edit) {
      if (!edit.search) throw new TextPatchError('missing_match', 'Patch search text cannot be empty. Use insertAt for insertion.');
      const searchBytes = Buffer.from(encoder.encode(edit.search));
      startByte = base.indexOf(searchBytes);
      if (startByte < 0) throw new TextPatchError('missing_match', 'Patch search text did not match the exact base bytes.');
      if (base.indexOf(searchBytes, startByte + Math.max(1, searchBytes.byteLength)) >= 0) {
        throw new TextPatchError('ambiguous_match', 'Patch search text is ambiguous because it matched more than once.');
      }
      endByte = startByte + searchBytes.byteLength;
      replacement = edit.replace;
    } else if ('insertAt' in edit) {
      startByte = edit.insertAt === 'start' ? textStartByte : base.byteLength;
      endByte = startByte;
      replacement = edit.replace;
    } else {
      if (!Number.isSafeInteger(edit.startLine) || !Number.isSafeInteger(edit.endLine)
        || edit.startLine < 1 || edit.endLine < edit.startLine || edit.endLine > lineStarts.length) {
        throw new TextPatchError('range_out_of_bounds', `Patch line range ${edit.startLine}-${edit.endLine} is outside the base file.`);
      }
      startByte = lineStarts[edit.startLine - 1];
      endByte = edit.endLine >= lineStarts.length ? base.byteLength : lineStarts[edit.endLine];
      replacement = input.normalizeReplacementEol
        ? normalizeEol(edit.replace, defaultEol, endByte < base.byteLength || endsWithEol(base))
        : edit.replace;
    }
    if (input.normalizeReplacementEol && !('startLine' in edit)) {
      replacement = replaceLineEndings(replacement, defaultEol);
    }
    if (startByte < textStartByte) {
      throw new TextPatchError('invalid_grammar', 'Text patches preserve the UTF-8 BOM; use text after the BOM as the exact match.');
    }
    if (replacement && !isReadableTextContent(replacement)) {
      throw new TextPatchError('binary_text', 'Patch replacement contains binary or unsafe text bytes.');
    }
    const oldBytes = base.subarray(startByte, endByte);
    const newBytes = Buffer.from(encoder.encode(replacement));
    if (oldBytes.byteLength > input.limits.maxInlineBytes || newBytes.byteLength > input.limits.maxInlineBytes) {
      throw new TextPatchError('patch_limit', `One patch hunk exceeds the ${input.limits.maxInlineBytes}-byte inline hunk limit.`);
    }
    return createHunk(base, startByte, endByte, oldBytes, newBytes);
  }).sort(compareHunks);
  assertNonOverlappingHunks(hunks);
  assertChangedByteLimit(hunks, input.limits.maxChangedBytes);
  // `text` is decoded here intentionally: exact round-tripping is the text
  // admission gate even though offsets and hashes remain byte based.
  void text;
  const baseIdentity = identity(base);
  const resultIdentity = calculatePatchedIdentity(base, hunks);
  const withoutHash = {
    version: 'text_patch_v1' as const,
    targetUri: input.targetUri,
    base: baseIdentity,
    result: resultIdentity,
    encoding,
    hunks
  };
  const patch = { ...withoutHash, canonicalHash: hashCanonicalPatch(withoutHash) };
  validateCanonicalTextPatch(patch, input.limits);
  return patch;
}

export function validateCanonicalTextPatch(patch: TextPatchV1, limits?: TextPatchLimits): void {
  if (patch.version !== 'text_patch_v1' || !patch.targetUri || !isIdentity(patch.base) || !isIdentity(patch.result)
    || patch.encoding.name !== 'utf-8'
    || !['none', 'utf8'].includes(patch.encoding.bom)
    || !['none', 'lf', 'crlf', 'mixed'].includes(patch.encoding.eol)
    || typeof patch.encoding.finalEol !== 'boolean'
    || !Array.isArray(patch.hunks) || !patch.hunks.length) {
    throw new TextPatchError('invalid_grammar', 'Stored text patch is malformed.');
  }
  const canonical = {
    version: patch.version,
    targetUri: patch.targetUri,
    base: patch.base,
    result: patch.result,
    encoding: patch.encoding,
    hunks: patch.hunks
  };
  if (patch.canonicalHash !== hashCanonicalPatch(canonical)) {
    throw new TextPatchError('hunk_mismatch', 'Stored text patch canonical hash does not match its payload.');
  }
  assertNonOverlappingHunks(patch.hunks);
  for (const hunk of patch.hunks) {
    const oldBytes = encoder.encode(hunk.oldText);
    const newBytes = encoder.encode(hunk.newText);
    if (hunk.oldSizeBytes !== oldBytes.byteLength || hunk.newSizeBytes !== newBytes.byteLength
      || hunk.oldSha256 !== hashBytes(oldBytes) || hunk.newSha256 !== hashBytes(newBytes)
      || !Number.isSafeInteger(hunk.startByte) || !Number.isSafeInteger(hunk.endByte)
      || !Number.isSafeInteger(hunk.startLine) || hunk.startLine < 1
      || hunk.startByte < 0 || hunk.endByte < hunk.startByte || hunk.endByte > patch.base.sizeBytes
      || hunk.endByte - hunk.startByte !== hunk.oldSizeBytes) {
      throw new TextPatchError('hunk_mismatch', 'Stored text patch hunk content or offsets are inconsistent.');
    }
  }
  const resultSize = patch.base.sizeBytes + patch.hunks.reduce(
    (total, hunk) => total + hunk.newSizeBytes - hunk.oldSizeBytes, 0);
  if (resultSize !== patch.result.sizeBytes) {
    throw new TextPatchError('result_mismatch', 'Stored text patch result size is inconsistent with its hunks.');
  }
  if (limits) {
    if (patch.hunks.length > limits.maxHunks) {
      throw new TextPatchError('patch_limit', `Stored patch exceeds the ${limits.maxHunks}-hunk limit.`);
    }
    assertChangedByteLimit(patch.hunks, limits.maxChangedBytes);
    for (const hunk of patch.hunks) {
      if (hunk.oldSizeBytes > limits.maxInlineBytes || hunk.newSizeBytes > limits.maxInlineBytes) {
        throw new TextPatchError('patch_limit', `Stored patch hunk exceeds the ${limits.maxInlineBytes}-byte inline limit.`);
      }
    }
    if (Buffer.byteLength(JSON.stringify(canonicalPatchValue(patch)), 'utf8') > limits.maxPatchBytes) {
      throw new TextPatchError('patch_limit', `Canonical patch exceeds the ${limits.maxPatchBytes}-byte payload limit.`);
    }
  }
}

export function applyTextPatchToBytes(baseBytes: Uint8Array, patch: TextPatchV1): Uint8Array {
  validateCanonicalTextPatch(patch);
  const base = Buffer.from(baseBytes);
  assertIdentity(base, patch.base, 'base_mismatch');
  const parts: Uint8Array[] = [];
  let cursor = 0;
  for (const hunk of patch.hunks) {
    if (hunk.endByte > base.byteLength) throw new TextPatchError('hunk_mismatch', 'Patch hunk exceeds the base file.');
    const actualOld = base.subarray(hunk.startByte, hunk.endByte);
    if (hashBytes(actualOld) !== hunk.oldSha256 || actualOld.byteLength !== hunk.oldSizeBytes) {
      throw new TextPatchError('hunk_mismatch', 'Patch hunk no longer matches the exact base bytes.');
    }
    parts.push(base.subarray(cursor, hunk.startByte), encoder.encode(hunk.newText));
    cursor = hunk.endByte;
  }
  parts.push(base.subarray(cursor));
  const result = Buffer.concat(parts.map((part) => Buffer.from(part)));
  assertIdentity(result, patch.result, 'result_mismatch');
  return result;
}

export function createInverseTextPatch(patch: TextPatchV1): TextPatchV1 {
  validateCanonicalTextPatch(patch);
  let delta = 0;
  const hunks = patch.hunks.map((hunk) => {
    const startByte = hunk.startByte + delta;
    const inverse = {
      startByte,
      endByte: startByte + hunk.newSizeBytes,
      startLine: hunk.startLine,
      oldText: hunk.newText,
      newText: hunk.oldText,
      oldSha256: hunk.newSha256,
      newSha256: hunk.oldSha256,
      oldSizeBytes: hunk.newSizeBytes,
      newSizeBytes: hunk.oldSizeBytes
    };
    delta += hunk.newSizeBytes - hunk.oldSizeBytes;
    return inverse;
  });
  const withoutHash = {
    version: 'text_patch_v1' as const,
    targetUri: patch.targetUri,
    base: patch.result,
    result: patch.base,
    encoding: patch.encoding,
    hunks
  };
  return { ...withoutHash, canonicalHash: hashCanonicalPatch(withoutHash) };
}

export function renderPatchReview(patch: TextPatchV1): string {
  return patch.hunks.map((hunk, index) => [
    `@@ hunk ${index + 1} · byte ${hunk.startByte}-${hunk.endByte} · line ${hunk.startLine} @@`,
    `old-sha256 ${hunk.oldSha256} (${hunk.oldSizeBytes} bytes)`,
    ...prefixLines(hunk.oldText, '-'),
    `new-sha256 ${hunk.newSha256} (${hunk.newSizeBytes} bytes)`,
    ...prefixLines(hunk.newText, '+')
  ].join('\n')).join('\n');
}

export function canonicalPatchPayload(patch: TextPatchV1): Record<string, unknown> {
  validateCanonicalTextPatch(patch);
  return canonicalPatchValue(patch);
}

function canonicalPatchValue(patch: TextPatchV1): Record<string, unknown> {
  return {
    version: patch.version,
    targetUri: patch.targetUri,
    base: { sha256: patch.base.sha256, sizeBytes: patch.base.sizeBytes },
    result: { sha256: patch.result.sha256, sizeBytes: patch.result.sizeBytes },
    encoding: {
      name: patch.encoding.name,
      bom: patch.encoding.bom,
      eol: patch.encoding.eol,
      finalEol: patch.encoding.finalEol
    },
    hunks: patch.hunks.map((hunk) => ({
      startByte: hunk.startByte,
      endByte: hunk.endByte,
      startLine: hunk.startLine,
      oldSha256: hunk.oldSha256,
      newSha256: hunk.newSha256,
      oldSizeBytes: hunk.oldSizeBytes,
      newSizeBytes: hunk.newSizeBytes,
      oldText: hunk.oldText,
      newText: hunk.newText
    })),
    canonicalHash: patch.canonicalHash
  };
}

export function inspectTextEncoding(bytes: Uint8Array): TextFileEncoding {
  return decodeExactUtf8(bytes).encoding;
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function parseOperation(raw: unknown, index: number, limits: TextPatchLimits): KeepseekPatchOperation {
  const record = requireRecord(raw, `operations[${index}]`);
  const action = record.action;
  if (action === 'update') {
    requireExactKeys(record, ['action', 'path', 'edits'], `operations[${index}]`);
    const path = parsePath(record.path);
    if (!Array.isArray(record.edits) || record.edits.length < 1 || record.edits.length > limits.maxHunks) {
      throw new TextPatchError('invalid_grammar', `operations[${index}].edits must contain 1-${limits.maxHunks} items.`);
    }
    return { action, path, edits: record.edits.map((edit, editIndex) => parseEdit(edit, `${index}].edits[${editIndex}`)) };
  }
  if (action === 'add') {
    requireExactKeys(record, ['action', 'path', 'content'], `operations[${index}]`);
    if (typeof record.content !== 'string') throw new TextPatchError('invalid_grammar', `operations[${index}].content must be a string.`);
    return { action, path: parsePath(record.path), content: record.content };
  }
  if (action === 'delete') {
    requireExactKeys(record, ['action', 'path'], `operations[${index}]`);
    return { action, path: parsePath(record.path) };
  }
  if (action === 'move') {
    requireExactKeys(record, ['action', 'path', 'to'], `operations[${index}]`);
    const path = parsePath(record.path);
    const to = parsePath(record.to);
    if (path === to) throw new TextPatchError('invalid_path', 'Move source and target must differ.');
    return { action, path, to };
  }
  throw new TextPatchError('invalid_grammar', `operations[${index}].action is unsupported.`);
}

function parseEdit(raw: unknown, label: string): TextPatchEditInput {
  const record = requireRecord(raw, `operations[${label}]`);
  if (typeof record.replace !== 'string') throw new TextPatchError('invalid_grammar', `${label}].replace must be a string.`);
  if ('search' in record) {
    requireExactKeys(record, ['search', 'replace'], label);
    if (typeof record.search !== 'string' || !record.search) throw new TextPatchError('invalid_grammar', `${label}].search must be non-empty.`);
    return { search: record.search, replace: record.replace };
  }
  if ('insertAt' in record) {
    requireExactKeys(record, ['insertAt', 'replace'], label);
    if (record.insertAt !== 'start' && record.insertAt !== 'end') throw new TextPatchError('invalid_grammar', `${label}].insertAt must be start or end.`);
    return { insertAt: record.insertAt, replace: record.replace };
  }
  requireExactKeys(record, ['startLine', 'endLine', 'replace'], label);
  if (!Number.isSafeInteger(record.startLine) || !Number.isSafeInteger(record.endLine)) {
    throw new TextPatchError('invalid_grammar', `${label}] line range must use integers.`);
  }
  return { startLine: Number(record.startLine), endLine: Number(record.endLine), replace: record.replace };
}

function parsePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.includes('\\')
    || value.startsWith('/') || /^[A-Za-z]:/u.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    throw new TextPatchError('invalid_path', 'Patch paths must be normalized workspace-relative paths.');
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new TextPatchError('invalid_path', `Patch path traverses or escapes its declared target: ${value}`);
  }
  return value;
}

function decodeExactUtf8(bytes: Uint8Array): { text: string; encoding: TextFileEncoding } {
  let text: string;
  try {
    text = fatalDecoder.decode(bytes);
  } catch {
    throw new TextPatchError('invalid_utf8', 'Text patch targets must be exact UTF-8.');
  }
  const roundTrip = encoder.encode(text);
  if (!equalBytes(roundTrip, bytes)) throw new TextPatchError('invalid_utf8', 'Text patch target is not lossless UTF-8.');
  if (!isReadableTextContent(text)) throw new TextPatchError('binary_text', 'Text patch target contains binary or unsafe text bytes.');
  const buffer = Buffer.from(bytes);
  const hasLf = buffer.includes(0x0a);
  let crlf = 0;
  let bareLf = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0x0a) continue;
    if (index > 0 && buffer[index - 1] === 0x0d) crlf += 1;
    else bareLf += 1;
  }
  return {
    text,
    encoding: {
      name: 'utf-8',
      bom: buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf ? 'utf8' : 'none',
      eol: !hasLf ? 'none' : crlf && bareLf ? 'mixed' : crlf ? 'crlf' : 'lf',
      finalEol: buffer.length > 0 && buffer[buffer.length - 1] === 0x0a
    }
  };
}

function createHunk(
  base: Uint8Array,
  startByte: number,
  endByte: number,
  oldBytes: Uint8Array,
  newBytes: Uint8Array
): TextPatchHunkV1 {
  const oldText = fatalDecoder.decode(oldBytes);
  const newText = fatalDecoder.decode(newBytes);
  return {
    startByte,
    endByte,
    startLine: lineAtByte(base, startByte),
    oldText,
    newText,
    oldSha256: hashBytes(oldBytes),
    newSha256: hashBytes(newBytes),
    oldSizeBytes: oldBytes.byteLength,
    newSizeBytes: newBytes.byteLength
  };
}

function calculatePatchedIdentity(base: Uint8Array, hunks: readonly TextPatchHunkV1[]): FileContentIdentity {
  const hash = createHash('sha256');
  let cursor = 0;
  let sizeBytes = base.byteLength;
  for (const hunk of hunks) {
    hash.update(base.subarray(cursor, hunk.startByte));
    hash.update(encoder.encode(hunk.newText));
    cursor = hunk.endByte;
    sizeBytes += hunk.newSizeBytes - hunk.oldSizeBytes;
  }
  hash.update(base.subarray(cursor));
  return { sha256: hash.digest('hex'), sizeBytes };
}

function hashCanonicalPatch(patch: Omit<TextPatchV1, 'canonicalHash'>): string {
  return createHash('sha256').update(JSON.stringify({
    version: patch.version,
    targetUri: patch.targetUri,
    base: { sha256: patch.base.sha256, sizeBytes: patch.base.sizeBytes },
    result: { sha256: patch.result.sha256, sizeBytes: patch.result.sizeBytes },
    encoding: {
      name: patch.encoding.name,
      bom: patch.encoding.bom,
      eol: patch.encoding.eol,
      finalEol: patch.encoding.finalEol
    },
    hunks: patch.hunks.map((hunk) => ({
      startByte: hunk.startByte,
      endByte: hunk.endByte,
      startLine: hunk.startLine,
      oldText: hunk.oldText,
      newText: hunk.newText,
      oldSha256: hunk.oldSha256,
      newSha256: hunk.newSha256,
      oldSizeBytes: hunk.oldSizeBytes,
      newSizeBytes: hunk.newSizeBytes
    }))
  }), 'utf8').digest('hex');
}

function assertNonOverlappingHunks(hunks: readonly TextPatchHunkV1[]): void {
  for (let index = 1; index < hunks.length; index += 1) {
    const previous = hunks[index - 1];
    const current = hunks[index];
    if (current.startByte < previous.endByte
      || (current.startByte === previous.startByte && current.endByte === current.startByte && previous.endByte === previous.startByte)) {
      throw new TextPatchError('overlapping_hunks', 'Text patch hunks overlap or insert at the same byte offset.');
    }
  }
}

function assertChangedByteLimit(hunks: readonly TextPatchHunkV1[], limit: number): void {
  const changed = hunks.reduce((total, hunk) => total + hunk.oldSizeBytes + hunk.newSizeBytes, 0);
  if (changed > limit) throw new TextPatchError('patch_limit', `Patch changes ${changed} bytes, exceeding the ${limit}-byte limit.`);
}

function assertIdentity(bytes: Uint8Array, expected: FileContentIdentity, code: 'base_mismatch' | 'result_mismatch'): void {
  if (bytes.byteLength !== expected.sizeBytes || hashBytes(bytes) !== expected.sha256) {
    throw new TextPatchError(code, code === 'base_mismatch'
      ? 'Current file no longer matches the patch base identity.'
      : 'Generated content does not match the canonical patch result identity.');
  }
}

function identity(bytes: Uint8Array): FileContentIdentity {
  return { sha256: hashBytes(bytes), sizeBytes: bytes.byteLength };
}

function isIdentity(value: FileContentIdentity): boolean {
  return Boolean(value) && /^[a-f0-9]{64}$/u.test(value.sha256)
    && Number.isSafeInteger(value.sizeBytes) && value.sizeBytes >= 0;
}

function collectLineStartBytes(bytes: Uint8Array, textStartByte = 0): number[] {
  const starts = [textStartByte];
  for (let index = 0; index < bytes.byteLength; index += 1) if (bytes[index] === 0x0a) starts.push(index + 1);
  if (starts.length > 1 && starts[starts.length - 1] === bytes.byteLength) starts.pop();
  return starts;
}

function lineAtByte(bytes: Uint8Array, byteOffset: number): number {
  let line = 1;
  for (let index = 0; index < byteOffset; index += 1) if (bytes[index] === 0x0a) line += 1;
  return line;
}

function chooseReplacementEol(encoding: TextFileEncoding, bytes: Uint8Array): '\n' | '\r\n' {
  if (encoding.eol === 'crlf') return '\r\n';
  if (encoding.eol === 'mixed') {
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] === 0x0a) return index > 0 && bytes[index - 1] === 0x0d ? '\r\n' : '\n';
    }
  }
  return '\n';
}

function normalizeEol(value: string, eol: '\n' | '\r\n', shouldEndWithEol: boolean): string {
  let normalized = replaceLineEndings(value, eol);
  if (normalized && shouldEndWithEol && !normalized.endsWith(eol)) normalized += eol;
  return normalized;
}

function replaceLineEndings(value: string, eol: '\n' | '\r\n'): string {
  return value.replace(/\r\n?|\n/gu, eol);
}

function endsWithEol(bytes: Uint8Array): boolean {
  return bytes.byteLength > 0 && bytes[bytes.byteLength - 1] === 0x0a;
}

function compareHunks(left: TextPatchHunkV1, right: TextPatchHunkV1): number {
  return left.startByte - right.startByte || left.endByte - right.endByte;
}

function prefixLines(value: string, prefix: '-' | '+'): string[] {
  if (!value) return [`${prefix}[empty]`];
  return value.split(/(?<=\n)/u).map((line) => `${prefix}${line.replace(/\n$/u, '↵')}`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TextPatchError('invalid_grammar', `${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TextPatchError('invalid_grammar', `${label} contains missing or unknown fields.`);
  }
}
