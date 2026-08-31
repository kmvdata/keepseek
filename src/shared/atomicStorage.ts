import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';

/** Same-directory replacement: a failed write keeps the previous valid record. */
export async function writeJsonAtomic(uri: vscode.Uri, value: unknown): Promise<void> {
  const parent = vscode.Uri.joinPath(uri, '..');
  const temporary = vscode.Uri.joinPath(parent, `.keepseek-${randomUUID()}.tmp`);
  await vscode.workspace.fs.createDirectory(parent);
  try {
    await vscode.workspace.fs.writeFile(temporary, new TextEncoder().encode(JSON.stringify(value)));
    await vscode.workspace.fs.rename(temporary, uri, { overwrite: true });
  } finally {
    await Promise.resolve(vscode.workspace.fs.delete(temporary, { useTrash: false })).catch(() => undefined);
  }
}
