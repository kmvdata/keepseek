import { KEEPSEEK_CONFIGURATION_NAMESPACE, KEEPSEEK_PUBLISHER } from './shared/identity';
import * as vscode from 'vscode';
import { KeepseekChatViewProvider } from './provider/KeepseekChatViewProvider';
import { GlobalSessionStorage } from './sessions/globalSessionStorage';
import { ChatSessionStore, getCurrentWorkspaceSessionScope } from './sessions/chatSessionStore';
import { getConfiguredKeepseekLanguage } from './shared/i18n';
import type { KeepseekExtensionInfo } from './shared/types';
import { StartupPerformanceTrace } from './shared/startupPerformance';
import { getRuntimeIdentity, initializeRuntimeIdentity } from './shared/runtimeIdentity';
import { getNativeStorageUri } from './shared/storageRoot';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const startupTrace = new StartupPerformanceTrace();
  startupTrace.mark('activate-start');
  initializeRuntimeIdentity({ extensionUri: context.extensionUri, extensionMode: context.extensionMode,
    version: readPackageString(context.extension.packageJSON.version, '0.0.0'), remoteName: vscode.env.remoteName });

  const storageUri = getNativeStorageUri();
  const globalSessionStorage = new GlobalSessionStorage(storageUri, startupTrace);
  const workspaceScope = getCurrentWorkspaceSessionScope();
  const sessionStore = new ChatSessionStore(globalSessionStorage, getConfiguredKeepseekLanguage(), workspaceScope);
  let startSessionInitialization: (() => void) | undefined;
  const sessionInitialization = new Promise<void>((resolve, reject) => {
    startSessionInitialization = () => {
      void startupTrace.measure('current-workspace-sessions-loaded', async () => {
        await sessionStore.initialize({ fresh: true });
      }, () => ({ entries: sessionStore.getSessionSummaries().length })).then(resolve, reject);
    };
  });

  const provider = new KeepseekChatViewProvider(
    context.extensionUri,
    sessionStore,
    storageUri,
    context.globalState,
    createExtensionInfo(context),
    sessionInitialization,
    startupTrace
  );
  const webviewProvider = vscode.window.registerWebviewViewProvider(KeepseekChatViewProvider.viewType, provider, {
    webviewOptions: {
      retainContextWhenHidden: true
    }
  });
  startupTrace.mark('provider-registered');
  startSessionInitialization?.();

  context.subscriptions.push(
    provider,
    webviewProvider,
    vscode.commands.registerCommand('keepseek.showRuntimeDiagnostics', async () => {
      const document = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify({
        ...getRuntimeIdentity(), sessionTitle: provider.getSessionTitleDiagnostics(), historyCleanup: provider.getHistoryCleanupDiagnostics()
      }, null, 2) });
      await vscode.window.showTextDocument(document, { preview: true });
    }),
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
      if (event.affectsConfiguration(KEEPSEEK_CONFIGURATION_NAMESPACE)) {
        provider.refreshConfiguration();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void provider.refreshWorkspaceScope();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void provider.refreshSkills();
      void provider.refreshBackgroundRunAvailability();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (/(?:^|\/)package\.json$/u.test(document.uri.path)) {
        void provider.refreshBackgroundRunAvailability();
      }
      provider.notifySharedSourcesChanged([document.uri]);
    }),
    vscode.workspace.onDidCreateFiles(event => provider.notifySharedSourcesChanged(event.files)),
    vscode.workspace.onDidDeleteFiles(event => provider.notifySharedSourcesChanged(event.files)),
    vscode.workspace.onDidRenameFiles(event => provider.notifySharedSourcesChanged(event.files.flatMap(file => [file.oldUri, file.newUri]))),
    vscode.commands.registerCommand('keepseek.selectProjectScope', () => provider.selectProjectScope())
  );
}

export function deactivate(): void {}

function createExtensionInfo(context: vscode.ExtensionContext): KeepseekExtensionInfo {
  const packageJson = context.extension.packageJSON as Record<string, unknown>;
  return {
    displayName: readPackageString(packageJson.displayName, 'KeepSeek'),
    version: readPackageString(packageJson.version, '0.0.0'),
    publisher: readPackageString(packageJson.publisher, KEEPSEEK_PUBLISHER),
    author: 'kmvdata',
    repositoryUrl: 'https://github.com/kmvdata/keepseek',
    license: 'MIT'
  };
}

function readPackageString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
