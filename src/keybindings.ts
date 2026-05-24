import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

export function ensureKeybindings(context: vscode.ExtensionContext): void {
  try {
    const storageDir = path.dirname(context.globalStorageUri.fsPath);
    const userDir = path.dirname(storageDir);
    const keybindingsPath = path.join(userDir, 'keybindings.json');

    const contextKey = process.platform === 'darwin' ? 'cmd+l' : 'ctrl+shift+l';
    const bindings = [
      {
        key: contextKey,
        command: 'keepseek.addSelectionToContext',
        when: 'editorHasSelection && editorTextFocus && !inDebugRepl'
      },
      {
        key: contextKey,
        command: 'keepseek.addExplorerFileToContext',
        when: 'explorerViewletFocus && !explorerResourceIsFolder'
      },
      {
        key: contextKey,
        command: 'keepseek.addTerminalSelectionToContext',
        when: 'terminalFocus && terminalTextSelectedInFocused'
      },
      {
        key: contextKey,
        command: 'keepseek.addDebugConsoleSelectionToContext',
        when: 'inDebugRepl'
      }
    ];
    const keepseekCommands = new Set(bindings.map((binding) => binding.command));

    let keybindings: Array<Record<string, unknown>> = [];
    if (fs.existsSync(keybindingsPath)) {
      try {
        const raw = fs.readFileSync(keybindingsPath, 'utf-8');
        const cleaned = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        keybindings = JSON.parse(cleaned) as Array<Record<string, unknown>>;
      } catch {
        keybindings = [];
      }
    }

    if (process.platform !== 'darwin') {
      keybindings = keybindings.filter((entry) => !(
        typeof entry.command === 'string' &&
        keepseekCommands.has(entry.command) &&
        entry.key === 'ctrl+l'
      ));
    }

    const missingBindings = bindings.filter((binding) => !keybindings.some(
      (entry) => entry.command === binding.command && entry.key === binding.key
    ));

    if (!missingBindings.length) {
      return;
    }

    for (const binding of missingBindings) {
      keybindings.push({
        key: binding.key,
        command: binding.command,
        when: binding.when
      });
    }

    fs.mkdirSync(path.dirname(keybindingsPath), { recursive: true });
    fs.writeFileSync(keybindingsPath, JSON.stringify(keybindings, null, 2) + '\n', 'utf-8');
  } catch {
    // The package.json keybinding contribution is the primary mechanism.
  }
}
