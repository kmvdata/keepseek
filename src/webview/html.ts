import * as vscode from 'vscode';
import type { KeepseekLanguage } from '../i18n';
import { getScript } from './script';
import { getStyles } from './styles';
import { getTemplate } from './template';

export function getHtmlForWebview(input: {
  webview: vscode.Webview;
  extensionUri: vscode.Uri;
  language: KeepseekLanguage;
}): string {
  const nonce = getNonce();
  const keepseekLogoUri = input.webview.asWebviewUri(vscode.Uri.joinPath(input.extensionUri, 'resources', 'keepseek.svg'));
  return `<!DOCTYPE html>
<html lang="${input.language === 'en' ? 'en' : 'zh-CN'}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${input.webview.cspSource} data:; style-src ${input.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>KeepSeek</title>
  <style>
${getStyles()}
  </style>
</head>
<body ondragover="event.preventDefault();event.dataTransfer.dropEffect='copy';return false;" ondrop="event.preventDefault();return false;">
${getTemplate()}
  <script nonce="${nonce}">
window.keepseekLogoUri = ${JSON.stringify(String(keepseekLogoUri))};
${getScript()}
  </script>
</body>
</html>`;
}

function getNonce(): string {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i += 1) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
