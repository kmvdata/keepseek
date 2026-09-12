import * as vscode from 'vscode';
import { ensureKeybindings } from './keybindings';
import { KeepseekChatViewProvider } from './provider/KeepseekChatViewProvider';
import { GlobalSessionStorage } from './sessions/globalSessionStorage';
import { ChatSessionStore, getCurrentWorkspaceSessionScope } from './sessions/chatSessionStore';
import { getConfiguredKeepseekLanguage } from './shared/i18n';
import type { KeepseekExtensionInfo } from './shared/types';
import { StartupPerformanceTrace } from './shared/startupPerformance';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const startupTrace = new StartupPerformanceTrace();
  startupTrace.mark('activate-start');

  const globalSessionStorage = new GlobalSessionStorage(context.globalStorageUri, startupTrace);
  const workspaceScope = getCurrentWorkspaceSessionScope();
  const sessionStore = new ChatSessionStore(globalSessionStorage, getConfiguredKeepseekLanguage(), workspaceScope);
  let startSessionInitialization: (() => void) | undefined;
  const sessionInitialization = new Promise<void>((resolve, reject) => {
    startSessionInitialization = () => {
      void startupTrace.measure('current-workspace-sessions-loaded', async () => {
        await globalSessionStorage.migrateLegacyWorkspaceState(context.workspaceState, workspaceScope);
        await sessionStore.initialize();
      }, () => ({ entries: sessionStore.getSessionSummaries().length })).then(resolve, reject);
    };
  });

  const provider = new KeepseekChatViewProvider(
    context.extensionUri,
    sessionStore,
    context.globalStorageUri,
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
  // The package contribution is authoritative; this only performs the legacy
  // user-keybindings migration once and never blocks Provider registration.
  void ensureKeybindings(context);

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
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      void provider.refreshSkills();
      void provider.refreshBackgroundRunAvailability();
    }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      if (/(?:^|\/)package\.json$/u.test(document.uri.path)) {
        void provider.refreshBackgroundRunAvailability();
      }
      if (/(?:^|\/)(?:AGENTS|SKILL)\.md$/u.test(document.uri.path)) {
        void provider.refreshSkills();
      }
      if (/(?:^|\/)\.keepseek\/memory\.json$/u.test(document.uri.path)) {
        void provider.refreshLegacyMemoryMigration();
      }
    }),
    vscode.workspace.onDidCreateFiles((event) => {
      if (event.files.some((uri) => /(?:^|\/)\.keepseek\/memory\.json$/u.test(uri.path))) {
        void provider.refreshLegacyMemoryMigration();
      }
    }),
    vscode.workspace.onDidDeleteFiles((event) => {
      if (event.files.some((uri) => /(?:^|\/)\.keepseek\/memory\.json$/u.test(uri.path))) {
        void provider.refreshLegacyMemoryMigration();
      }
    })
  );
}

export function deactivate(): void {}

function createExtensionInfo(context: vscode.ExtensionContext): KeepseekExtensionInfo {
  const packageJson = context.extension.packageJSON as Record<string, unknown>;
  return {
    displayName: readPackageString(packageJson.displayName, 'KeepSeek'),
    version: readPackageString(packageJson.version, '0.0.0'),
    publisher: readPackageString(packageJson.publisher, 'keepseek'),
    author: 'kmvdata',
    repositoryUrl: 'https://github.com/kmvdata/keepseek',
    license: 'MIT'
  };
}

function readPackageString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}
