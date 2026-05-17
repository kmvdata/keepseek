# KeepSeek

VSCode 扩展，在侧边栏内嵌 AI 对话面板。

## 目录结构

```
src/
├── extension.ts          # 入口：Provider 类、activate/deactivate、工具函数
├── types.ts              # 共享类型定义
├── agentRunner.ts        # AI 请求封装
├── fileContext.ts        # 上下文文件管理
├── safeFileEditor.ts     # 文件安全写入
└── webview/
    ├── styles.ts         # getStyles() — 所有 CSS
    ├── template.ts       # getTemplate() — HTML 骨架
    └── script.ts         # getScript() — Webview 内运行的 JS（IIFE）
```

## 架构

- `extension.ts` 的 `getHtmlForWebview()` 通过 `${getStyles()}` / `${getTemplate()}` / `${getScript()}` 组装完整 HTML 文档。
- webview 三层文件各自导出纯字符串，互不依赖。改样式只碰 `styles.ts`，改 JS 只碰 `script.ts`，改 HTML 只碰 `template.ts`。
- `script.ts` 输出的是注入 webview 的 JS 代码（字符串形式），通过 `acquireVsCodeApi()` 与 Provider 通信。

## 关键通信流

1. Webview JS → `vscode.postMessage({ type, ... })` → `handleMessage()` 在 `extension.ts`
2. Provider → `postToWebview({ type: 'state', state })` → webview 全局 `state` 更新 → `render()`
3. 消息类型定义见 `WebviewMessage` 联合类型

### 新增扩展→Webview 消息

`insertFileReference`（非 `WebviewMessage`，由 Provider 主动推送，不在 `handleMessage` switch 中处理）：

```
Provider: postToWebview({ type: 'insertFileReference', path, startLine, endLine })
  → script.ts IIFE 内 message listener
    → createFileReferenceLink() 生成 <a.rich-file-link>
    → insertFragmentAtRange() 插入到光标位置
```

## 右键菜单：Add Selection to Context

- 命令：`keepseek.addSelectionToContext`
- 触发条件：编辑器中选中文本（`editorHasSelection`）
- 路径：右键 → `KeepSeek: Add Selection to Context`

**流程：**

```
editor.selection (0-based) + editor.document.uri.fsPath
  → extension.ts: insertSelectionToInput()  // 行号转为 1-based
    → reveal() 展开面板
    → postMessage({ type: 'insertFileReference', path, startLine, endLine })
      → script.ts: 在输入框光标处插入文件引用 chip
```

**序列化格式**（与拖拽/粘贴一致）：`文件名 (第N-M行) <路径#LN-LM>`

发送消息时 `serializePrompt()` 遍历 `.rich-file-link` 元素，调用 `fileReferenceLinkToText()` 先还原为文本格式；`extension.ts` 的 `expandFileReferencesInPrompt()` 会在真正调用 AgentRunner 前读取可文本化的引用文件/行段，并把引用位置展开为 markdown 代码块。

**发送前引用展开格式：**

````markdown
文件名 (第N-M行) <路径#LN-LM>
```typescript
引用原文
```
````

全文引用展开时标题行为 `文件名 <路径>`；不可读取、超出大小限制、图片、媒体、归档和常见二进制文件会保留原引用，不展开。

## 资源管理器右键菜单：Add File to Context

- 命令：`keepseek.addExplorerFileToContext`
- 触发条件：资源管理器中文件右键（`!explorerResourceIsFolder`）
- 路径：Explorer → 文件右键 → `KeepSeek: Add File to Context`

**流程：**

```
explorer/context 传入 vscode.Uri
  → extension.ts: insertExplorerFileToInput()
    → reveal() 展开面板
    → postMessage({ type: 'insertFileReference', path, startLine: 0, endLine: 0 })
      → script.ts: 在输入框光标处插入全文文件引用 chip；没有已保存光标时插入到末尾
```

`startLine: 0, endLine: 0` 表示全文引用，chip 只显示高亮文件名，序列化格式为：`文件名 <路径>`。

## 拖拽文件到输入框

**触发方式：** 从 VSCode 文件资源管理器（或系统文件管理器）直接拖拽文件到输入框。

**行为：**
- 拖入的文件生成为文件引用链接（`.rich-file-link`），不含行号，显示为高亮文件名。
- 双击链接在 VSCode 中打开对应文件（不选中特定行）。
- 序列化格式：`文件名 <路径>`（与带行号的引用不同，没有 `#L` 片段）。

**实现细节：**
- `extension.ts` 的 `resolveWebviewView()` 必须设置 `enableDragAndDrop: true`（采用 `as vscode.WebviewOptions` 类型断言，因 `@types/vscode@1.100.0` 未声明该属性），否则 VSCode 资源管理器的拖拽事件不会传递到 webview。
- `startLine: 0, endLine: 0` 在 script.ts 内部作为"全文引用"的哨兵值。
- `extractFileReferences()` 处理多种拖拽数据格式：
  - `dt.files[].path`（文件系统文件；VSCode Webview 沙箱中可能为 `undefined`，已加判空跳过）
  - `dt.items[]`（DataTransferItemList）
  - `text/uri-list`（VSCode 资源管理器 / 系统拖拽）
  - `application/vnd.code.uri-list`（VSCode 自定义 MIME，资源管理器拖入的主要数据来源）
  - `text/plain`（兜底；`addPlainTextReferences()` 遇到无效条目时 `continue` 而非直接退出）
- `createFileReferenceLink()` 检测 `startLine === 0` 时仅显示文件名。
- `extension.ts` 的 `openFileReference()` 收到 `rawStartLine <= 0` 时仅打开文件，不创建选区。
