import { createHash } from 'node:crypto';
import type {
  DeleteDraftEditV1,
  DraftEdit,
  FileContentIdentity,
  FullTextDraftEditV1,
  TextFileEncoding
} from '../shared/types';
import { hashBytes, inspectTextEncoding } from './textPatch';

const encoder = new TextEncoder();

export type DraftEditKind = 'full_text_v1' | 'text_patch_v1' | 'delete_v1' | 'move_v1';

export function getDraftEditKind(edit: DraftEdit): DraftEditKind {
  return edit.kind;
}

export function getDraftEditBase(edit: DraftEdit): FileContentIdentity | undefined {
  if (edit.kind === 'text_patch_v1' || edit.kind === 'delete_v1' || edit.kind === 'move_v1') return edit.kind === 'text_patch_v1' ? edit.patch.base : edit.base;
  if (edit.kind === 'full_text_v1') return edit.base;
  return undefined;
}

export function getDraftEditResult(edit: DraftEdit): FileContentIdentity | undefined {
  if (edit.kind === 'text_patch_v1') return edit.patch.result;
  if (edit.kind === 'full_text_v1') return edit.result;
  return undefined;
}

export function getDraftEditFullText(edit: DraftEdit): string | undefined {
  if (edit.kind === 'full_text_v1') return edit.content;
  return undefined;
}

export function createFullTextDraftEdit(input: {
  id: string;
  uri: string;
  label: string;
  action: 'create' | 'modify';
  content: string;
  reason: string;
  base?: FileContentIdentity;
}): FullTextDraftEditV1 {
  const bytes = encoder.encode(input.content);
  return {
    id: input.id,
    uri: input.uri,
    label: input.label,
    kind: 'full_text_v1',
    action: input.action,
    content: input.content,
    reason: input.reason,
    base: input.base,
    result: { sha256: hashBytes(bytes), sizeBytes: bytes.byteLength },
    encoding: safeEncoding(bytes)
  };
}

export function createDeleteDraftEdit(input: {
  id: string;
  uri: string;
  label: string;
  reason: string;
  baseBytes: Uint8Array;
}): DeleteDraftEditV1 {
  return {
    id: input.id,
    uri: input.uri,
    label: input.label,
    kind: 'delete_v1',
    action: 'delete',
    reason: input.reason,
    base: { sha256: hashBytes(input.baseBytes), sizeBytes: input.baseBytes.byteLength },
    encoding: inspectTextEncoding(input.baseBytes)
  };
}

export function hashTextUtf8(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeEncoding(bytes: Uint8Array): TextFileEncoding {
  try {
    return inspectTextEncoding(bytes);
  } catch {
    return { name: 'utf-8', bom: 'none', eol: 'none', finalEol: false };
  }
}
