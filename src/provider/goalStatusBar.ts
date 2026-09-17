import * as vscode from 'vscode';
import type { GoalViewModel } from '../agent/goals/goalTypes';

export class GoalStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);

  public constructor() {
    this.item.command = 'keepseek.openChat';
    this.item.name = 'KeepSeek Goal';
  }

  public update(goal: GoalViewModel | undefined): void {
    if (!goal) { this.item.hide(); return; }
    const icon = goal.status === 'completed' ? '$(check)'
      : goal.status === 'running' ? '$(play-circle)'
        : goal.status === 'stopped' ? '$(debug-stop)'
          : goal.status === 'failed' || goal.status === 'needs_attention' ? '$(warning)'
            : '$(clock)';
    this.item.text = `${icon} Goal: ${goal.status.replace(/_/gu, ' ')}`;
    this.item.tooltip = goal.waitingReason ?? goal.stopReason ?? goal.objective;
    this.item.show();
  }

  public dispose(): void { this.item.dispose(); }
}
