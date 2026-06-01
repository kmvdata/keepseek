import * as vscode from 'vscode';
import { ensureKeybindings } from './keybindings';
import { KeepseekChatViewProvider } from './provider/KeepseekChatViewProvider';
import { GlobalSessionStorage } from './sessions/globalSessionStorage';
import { ChatSessionStore, getCurrentWorkspaceSessionScope } from './sessions/chatSessionStore';
import { getConfiguredKeepseekLanguage } from './shared/i18n';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ensureKeybindings(context);

  const globalSessionStorage = new GlobalSessionStorage(context.globalStorageUri);
  const workspaceScope = getCurrentWorkspaceSessionScope();
  await globalSessionStorage.migrateLegacyWorkspaceState(context.workspaceState, workspaceScope);
  const sessionStore = new ChatSessionStore(globalSessionStorage, getConfiguredKeepseekLanguage(), workspaceScope);
  await sessionStore.initialize();
  await sessionStore.cleanupExpiredSessions();

  const provider = new KeepseekChatViewProvider(context.extensionUri, sessionStore, context.globalStorageUri);
  const webviewProvider = vscode.window.registerWebviewViewProvider(KeepseekChatViewProvider.viewType, provider, {
    webviewOptions: {
      retainContextWhenHidden: true
    }
  });

  context.subscriptions.push(
    provider,
    webviewProvider,
    vscode.commands.registerCommand('keepseek.openChat', () => provider.reveal()),
    vscode.commands.registerCommand('keepseek.addCurrentFileToContext', () => provider.addCurrentFileToContext()),
    vscode.commands.registerCommand('keepseek.pickWorkspaceFilesToContext', () => provider.pickWorkspaceFilesToContext()),
    vscode.commands.registerCommand('keepseek.pickExternalFilesToContext', () => provider.pickExternalFilesToContext()),
    vscode.commands.registerCommand('keepseek.addSelectionToContext', () => provider.insertSelectionToInput()),
    vscode.commands.registerCommand('keepseek.addTerminalSelectionToContext', () => provider.insertTerminalSelectionToInput()),
    vscode.commands.registerCommand('keepseek.addDebugConsoleSelectionToContext', () => provider.insertDebugConsoleSelectionToInput()),
    vscode.commands.registerCommand(
      'keepseek.addExplorerFileToContext',
      (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => provider.insertExplorerFileToInput(uri, selectedUris)
    ),
    vscode.commands.registerCommand(
      'keepseek.addExplorerDirectoryToContext',
      (uri?: vscode.Uri, selectedUris?: vscode.Uri[]) => provider.insertExplorerDirectoryToInput(uri, selectedUris)
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('keepseek')) {
        provider.refreshConfiguration();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void provider.refreshWorkspaceScope();
    })
  );
}

export function deactivate(): void {}
