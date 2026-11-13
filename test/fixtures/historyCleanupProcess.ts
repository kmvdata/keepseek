import '../registerVscodeStub';
import * as vscode from '../stubs/vscode';
import { appendFile } from 'node:fs/promises';
import { SessionDeletionAuthority } from '../../src/sessions/sessionDeletionAuthority';
import { GlobalSessionStorage } from '../../src/sessions/globalSessionStorage';

const [root, action, workspaceKey, sessionId, events] = process.argv.slice(2);
const uri = vscode.Uri.file(root) as never;
const authority = new SessionDeletionAuthority(uri);
async function main(): Promise<void> {
  if (action === 'lease') {
    const lease = await authority.acquireUse(workspaceKey, sessionId);
    process.send?.('ready');
    process.once('message', () => { void lease.release().then(() => process.exit(0)); });
  } else if (action === 'gate') {
    await authority.withSessionGate(workspaceKey, sessionId, async () => {
      await appendFile(events, `start:${process.pid}\n`);
      process.send?.('ready');
      await new Promise(resolve => setTimeout(resolve, 80));
      await appendFile(events, `end:${process.pid}\n`);
    });
  } else if (action === 'snapshot') {
    const storage = new GlobalSessionStorage(uri);
    const sessions = await storage.loadWorkspaceSessions(workspaceKey);
    process.send?.('ready');
    process.once('message', () => { void storage.saveWorkspace({ key: workspaceKey, name: 'Fixture', folderUris: [] },
      { activeSessionId: sessionId, sessions }).then(() => process.exit(0)); });
  } else throw new Error('Unknown fixture action');
}
void main().catch(error => { process.send?.({ error: String(error) }); process.exit(1); });
