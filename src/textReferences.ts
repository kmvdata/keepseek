import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

const CLIPBOARD_COPY_SETTLE_MS = 50;

export const TEXT_REFERENCE_STORAGE_DIR = 'text-references';

export type TextReferenceSource = 'terminal' | 'debugConsole' | 'output';

export function getDocumentSelectionTextReferenceSource(document: vscode.TextDocument): TextReferenceSource | undefined {
  if (document.uri.scheme === 'output') {
    return 'output';
  }
  if (document.uri.scheme === 'debug') {
    return 'debugConsole';
  }
  return undefined;
}

export async function copySelectionTextWithClipboardRestore(copyCommand: string): Promise<string> {
  const previousClipboard = await vscode.env.clipboard.readText();
  const sentinel = `__KEEPSEEK_SELECTION_${randomUUID()}__`;

  try {
    await vscode.env.clipboard.writeText(sentinel);
    await vscode.commands.executeCommand(copyCommand);
    await delay(CLIPBOARD_COPY_SETTLE_MS);
    const copiedText = await vscode.env.clipboard.readText();
    return copiedText === sentinel ? '' : copiedText;
  } finally {
    await vscode.env.clipboard.writeText(previousClipboard);
  }
}

export function createTextReferenceFileName(prefix: string, name?: string): string {
  const cleanPrefix = sanitizeTextReferenceFileNameSegment(prefix) || 'selection';
  const cleanName = sanitizeTextReferenceFileNameSegment(name);
  return cleanName ? `${cleanPrefix}-${cleanName}.log` : `${cleanPrefix}.log`;
}

export function getTextReferenceDocumentName(document: vscode.TextDocument): string {
  const uriPath = document.uri.path || document.uri.toString();
  return uriPath.split('/').filter(Boolean).pop() ?? '';
}

export function sanitizeTextReferenceFileName(name: string): string {
  const trimmed = name.trim() || 'selection.log';
  const baseName = trimmed.split(/[\\/]+/u).pop() || 'selection.log';
  const withoutControlCharacters = Array.from(baseName, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 ? '-' : character;
  }).join('');
  const sanitized = withoutControlCharacters
    .replace(/[<>:"/\\|?*]+/gu, '-')
    .replace(/^\.+$/u, 'selection.log')
    .slice(0, 160);
  return sanitized || 'selection.log';
}

export function sanitizeDroppedFileName(name: string): string {
  const rawName = typeof name === 'string' && name.trim() ? name.trim() : 'dropped-file';
  const baseName = rawName.split(/[\\/]+/u).pop() || 'dropped-file';
  const invalidCharacters = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
  const safeCharacters = Array.from(baseName, (character) => {
    const code = character.charCodeAt(0);
    return code < 32 || invalidCharacters.has(character) ? '_' : character;
  }).join('');
  const sanitized = safeCharacters.replace(/^\.+$/u, 'dropped-file').slice(0, 160);
  return sanitized || 'dropped-file';
}

function sanitizeTextReferenceFileNameSegment(value: string | undefined): string {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .replace(/-{2,}/gu, '-')
    .slice(0, 80);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
