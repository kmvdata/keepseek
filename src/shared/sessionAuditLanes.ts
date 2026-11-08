import { createHash } from 'node:crypto';
import * as vscode from 'vscode';

/** A new session publishes only its own audit snapshot. Historical aggregates
 * stay cold and unchanged until an explicit history/recovery entry. */
export function sessionAuditLaneUri(directory: vscode.Uri, sessionId: string): vscode.Uri {
  if (!sessionId.trim()) throw new Error('Session audit lane requires a session identity.');
  return vscode.Uri.joinPath(directory, `${createHash('sha256').update(sessionId).digest('hex').slice(0, 32)}.json`);
}

export async function readSessionAuditLanes(directory: vscode.Uri): Promise<Array<{ sessionId: string; [key: string]: unknown }>> {
  let files: Array<[string, vscode.FileType]>;
  try { files = await vscode.workspace.fs.readDirectory(directory); } catch { return []; }
  const records: Array<{ sessionId: string; [key: string]: unknown }> = [];
  for (const [name, kind] of files) {
    if (kind !== vscode.FileType.File || !/^[a-f0-9]{32}\.json$/u.test(name)) continue;
    try {
      const value = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, name))));
      if (value?.version === 1 && typeof value.sessionId === 'string'
        && sessionAuditLaneUri(directory, value.sessionId).toString() === vscode.Uri.joinPath(directory, name).toString()) records.push(value);
    } catch { /* Invalid audit data never grants authority. The source stays intact. */ }
  }
  return records;
}
