import * as vscode from 'vscode';

export async function focusView(containerId: string, viewType: string): Promise<void> {
  await vscode.commands.executeCommand(`workbench.view.extension.${containerId}`);
  await vscode.commands.executeCommand(`${viewType}.focus`);
}
