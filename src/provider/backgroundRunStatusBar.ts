import * as vscode from 'vscode';
import type { BackgroundRun } from '../shared/types';

export class BackgroundRunStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);

  public constructor() {
    this.item.command = 'keepseek.openChat';
    this.item.name = 'KeepSeek Background Agent';
  }

  public update(run: BackgroundRun | undefined): void {
    if (!run) {
      this.item.hide();
      return;
    }
    const icon = run.status === 'running'
      ? '$(sync~spin)'
      : run.status === 'waiting_for_apply' || run.status === 'waiting_for_authorization'
        ? '$(clock)'
        : run.status === 'completed'
          ? '$(check)'
          : run.status === 'stopped'
            ? '$(debug-stop)'
            : '$(error)';
    this.item.text = `${icon} KeepSeek ${run.status.replace(/_/gu, ' ')} ${run.progress.round}/${run.limits.maxRounds}`;
    this.item.tooltip = run.waitingReason ?? run.stopReason ?? run.goal.description;
    this.item.show();
  }

  public dispose(): void {
    this.item.dispose();
  }
}
