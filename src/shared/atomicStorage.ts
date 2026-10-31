import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import * as vscode from 'vscode';

const storageQueues = new Map<string, Promise<void>>();
const MAX_RENAME_ATTEMPTS = 3;

/** Process-wide keyed coordinator shared by every storage instance. */
export async function withStorageCoordinator<T>(key: vscode.Uri | string, work: () => Promise<T>): Promise<T> {
  const normalizedKey = typeof key === 'string' ? key : key.toString();
  const previous = storageQueues.get(normalizedKey) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const queued = previous.catch(() => undefined).then(() => gate);
  storageQueues.set(normalizedKey, queued);
  await previous.catch(() => undefined);
  try {
    return await work();
  } finally {
    release();
    if (storageQueues.get(normalizedKey) === queued) storageQueues.delete(normalizedKey);
  }
}

/** Same-directory replacement: a failed write keeps the previous valid record. */
export async function writeJsonAtomic(uri: vscode.Uri, value: unknown, options?: { durable?: boolean }): Promise<void> {
  return writeBytesAtomic(uri, new TextEncoder().encode(JSON.stringify(value)), options);
}

export async function writeBytesAtomic(uri: vscode.Uri, bytes: Uint8Array, options?: { durable?: boolean }): Promise<void> {
  await withStorageCoordinator(uri, async () => {
    const parent = vscode.Uri.joinPath(uri, '..');
    const temporary = vscode.Uri.joinPath(parent, `.keepseek-${randomUUID()}.tmp`);
    await vscode.workspace.fs.createDirectory(parent);
    try {
      await vscode.workspace.fs.writeFile(temporary, bytes);
      if (options?.durable && uri.scheme === 'file') await syncLocal(temporary);
      let lastError: unknown;
      for (let attempt = 0; attempt < MAX_RENAME_ATTEMPTS; attempt += 1) {
        try {
          await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
          if (options?.durable && uri.scheme === 'file' && process.platform !== 'win32') await syncLocal(parent);
          return;
        } catch (error) {
          lastError = error;
          if (!isRecoverableRenameRace(error)) throw error;
          const [temporaryExists, targetMatches] = await Promise.all([
            exists(temporary),
            fileMatches(uri, bytes)
          ]);
          // Some vscode-userdata providers report FileNotFound after the
          // replacement already committed. Verify bytes before accepting it.
          if (targetMatches && !temporaryExists) return;
          if (!temporaryExists || attempt + 1 >= MAX_RENAME_ATTEMPTS) throw error;
        }
      }
      throw lastError;
    } finally {
      await Promise.resolve(vscode.workspace.fs.delete(temporary, { useTrash: false })).catch(() => undefined);
    }
  });
}

async function syncLocal(uri: vscode.Uri): Promise<void> {
  const handle = await open(uri.fsPath, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function deleteStorageUri(uri: vscode.Uri, options: { recursive?: boolean } = {}): Promise<void> {
  await withStorageCoordinator(uri, async () => {
    try {
      await vscode.workspace.fs.delete(uri, { recursive: options.recursive, useTrash: false });
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
    }
  });
}

function isRecoverableRenameRace(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'FileNotFound' || code === 'ENOENT' || code === 'FileExists' || code === 'EEXIST';
}

function isFileNotFoundError(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'FileNotFound' || code === 'ENOENT';
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try { await vscode.workspace.fs.stat(uri); return true; }
  catch (error) { if (isFileNotFoundError(error)) return false; throw error; }
}

async function fileMatches(uri: vscode.Uri, expected: Uint8Array): Promise<boolean> {
  try {
    const actual = await vscode.workspace.fs.readFile(uri);
    if (actual.byteLength !== expected.byteLength) return false;
    return actual.every((byte, index) => byte === expected[index]);
  } catch (error) {
    if (isFileNotFoundError(error)) return false;
    throw error;
  }
}
