import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentRequest, AgentResponse, DraftEdit } from './types';
import { formatBytes } from './fileContext';

export class AgentRunner {
  public async run(request: AgentRequest): Promise<AgentResponse> {
    const draftEdit = this.tryCreateDraftEdit(request.prompt);
    if (draftEdit) {
      return {
        message: [
          `已为 ${draftEdit.label} 准备一个待确认修改。`,
          '点击修改卡片上的 Apply 后，扩展会再次弹窗请求写入许可。'
        ].join('\n\n'),
        draftEdits: [draftEdit]
      };
    }

    const contextSummary = request.contextFiles.length
      ? request.contextFiles
          .map((file) => `- ${file.label} (${file.languageId}, ${formatBytes(file.sizeBytes)})`)
          .join('\n')
      : '- No context files selected.';

    return {
      message: [
        `当前选择的模型是 ${request.model.label}。真实模型调用还没有接入，入口在 src/agentRunner.ts。`,
        '这次请求已经带上以下上下文文件：',
        contextSummary,
        '下一步可以在这里接入 OpenAI-compatible API、DeepSeek、本地模型，或你自己的网关，并把模型返回的编辑草案转成 DraftEdit。'
      ].join('\n\n'),
      draftEdits: []
    };
  }

  private tryCreateDraftEdit(prompt: string): DraftEdit | undefined {
    const match = /^\/draft\s+([^\n]+)\n([\s\S]+)$/u.exec(prompt.trimEnd());
    if (!match) {
      return undefined;
    }

    const targetPath = match[1]?.trim();
    const newText = match[2] ?? '';
    if (!targetPath || !newText) {
      return undefined;
    }

    const uri = this.resolveTargetUri(targetPath);
    return {
      id: randomUUID(),
      uri: uri.toString(),
      label: this.getLabel(uri),
      newText,
      reason: 'Draft edit proposed from the KeepSeek chat panel.'
    };
  }

  private resolveTargetUri(targetPath: string): vscode.Uri {
    if (path.isAbsolute(targetPath)) {
      return vscode.Uri.file(targetPath);
    }

    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!workspaceRoot) {
      return vscode.Uri.file(path.resolve(targetPath));
    }

    return vscode.Uri.joinPath(workspaceRoot, ...targetPath.split(/[\\/]+/).filter(Boolean));
  }

  private getLabel(uri: vscode.Uri): string {
    if (vscode.workspace.getWorkspaceFolder(uri)) {
      return vscode.workspace.asRelativePath(uri, false);
    }
    return uri.fsPath;
  }
}
