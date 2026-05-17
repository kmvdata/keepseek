# KeepSeek

KeepSeek 是一个 VS Code Agent 对话插件。目标体验类似 Cursor 的 Agent 面板：用户可以选择模型、持续对话、把当前工程或外部路径的文件加入上下文，并在用户明确允许后由 Agent 修改项目代码。

当前仓库已经搭好一个最小可运行的扩展开发骨架，真实模型调用还没有接入。后续主要开发入口是 [src/agentRunner.ts](src/agentRunner.ts)。

## 功能概览

- VS Code 右侧 Secondary Sidebar 里的 `KeepSeek` Agent 面板；旧版 VS Code 会回退到 Activity Bar。
- Agent 对话 Webview，支持模型下拉选择。
- 多轮对话历史（自动裁剪到最近 80 条消息）。
- 上下文文件管理：当前编辑器文件、工作区文件、外部文件/目录、手动输入路径。
- 文件引用（File Reference）：选中文本、资源管理器文件、拖拽文件到输入框自动生成为可点击的文件引用链接，发送时自动展开为 markdown 代码块。
- 上下文文件数量（默认 32）和单文件大小（默认 200KB）限制，自动跳过二进制文件和常见非文本格式。
- `DraftEdit` 修改草案机制：AI 返回修改建议后，用户点击 Apply → modal 弹窗确认 → 写入文件。
- 快捷键支持：`Cmd+L` / `Ctrl+L` 快速添加选中文本或资源管理器文件到上下文。

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
- Webview 端用原生 DOM 操作渲染，不依赖任何前端框架。`render()` 分别调用 `renderModels()`、`renderContext()`、`renderDraftEdits()`、`renderTranscript()` 更新对应区域。

### 页面布局

Webview UI 使用 CSS Grid 划分为四个区域（从上到下）：

```
┌─────────────────────────┐
│  Header                 │  ← 标题 + 模型选择下拉框
├─────────────────────────┤
│  Context                │  ← 文件选择按钮、路径输入、上下文文件列表、待确认修改卡片
├─────────────────────────┤
│  Transcript             │  ← 聊天消息历史，可滚动，占剩余高度
├─────────────────────────┤
│  Composer               │  ← 文本输入框 + 发送按钮
└─────────────────────────┘
```

对应的 HTML 结构：

- `.header` — `modelSelect` 模型选择器
- `.context` — 工具栏（当前文件 / 工作区 / 外部文件 / 清空）、路径输入行、`contextList` 上下文文件列表、`draftList` 待确认修改列表
- `#transcript` — 对话记录（`.message.user` / `.message.assistant`）
- `#composer` — 输入表单，`Ctrl+Enter` 发送

### 视图容器适配

扩展根据 VS Code 版本自动选择容器：

- **VS Code ≥ 1.106**：使用 Secondary Sidebar（`keepseek-secondary` 容器），和 Codex、Claude Code 同级显示在右侧
- **旧版 VS Code**：回退到 Activity Bar（`keepseek` 容器），点击图标后在侧边栏打开

判断逻辑在 `supportsSecondarySidebar()` 中，通过解析 `vscode.version` 与 `1.106` 比较。两个容器共享同一个 `KeepseekChatViewProvider` 实例，通过 `this.views` Set 维护所有已创建的 WebviewView 引用，`postToWebview()` 遍历全部 view 广播状态。

## 关键通信流

### 1. Webview → Extension（用户操作）

Webview JS 通过 `vscode.postMessage({ type, ... })` 向 Provider 发送消息，由 `handleMessage()` 分发处理。

| type | 载荷 | 说明 |
|------|------|------|
| `ready` | — | Webview 加载完成，请求初始状态 |
| `sendPrompt` | `prompt`, `modelId` | 用户发送消息 |
| `addCurrentFile` | — | 添加当前编辑器文件 |
| `pickWorkspaceFiles` | — | 从工作区选择文件 |
| `pickExternalFiles` | — | 从外部路径选择文件/目录 |
| `readPath` | `path` | 读取指定路径 |
| `removeContextFile` | `uri` | 移除单个上下文文件 |
| `clearContext` | — | 清空全部上下文文件 |
| `applyDraftEdit` | `id` | 确认应用修改草案 |
| `discardDraftEdit` | `id` | 丢弃修改草案 |
| `openFileReference` | `path`, `startLine`, `endLine` | 在编辑器中打开文件引用 |

### 2. Extension → Webview（状态同步）

Provider 通过 `postToWebview({ type: 'state', state })` 全量推送状态，webview 收到后更新全局 `state` 并调用 `render()` 重渲染。

| type | 载荷 | 说明 |
|------|------|------|
| `state` | `models`, `selectedModelId`, `messages`, `contextFiles`, `draftEdits`, `isBusy` | 全量状态推送 |

### 3. Extension → Webview（主动推送）

`insertFileReference` 不属于 `WebviewMessage` 联合类型，由 Provider 主动推送，不在 `handleMessage` switch 中处理：

```
Provider: postToWebview({ type: 'insertFileReference', path, startLine, endLine })
  → script.ts IIFE 内 message listener
    → createFileReferenceLink() 生成 <a.rich-file-link>
    → insertFragmentAtRange() 插入到光标位置
```

## 数据流

```
用户操作 (Webview)
    │  vscode.postMessage({ type, ... })
    ▼
KeepseekChatViewProvider.handleMessage()
    │  根据 message.type 分发
    ├── sendPrompt ───────────────► AgentRunner.run()
    ├── addCurrentFile ──────────► FileContextStore.addCurrentEditor()
    ├── pickWorkspaceFiles ──────► FileContextStore.pickWorkspaceFiles()
    ├── pickExternalFiles ───────► FileContextStore.pickExternalFiles()
    ├── readPath ────────────────► FileContextStore.addPath()
    ├── applyDraftEdit ──────────► SafeFileEditor.applyDraftEdit()
    └── removeContextFile/clearContext ──► FileContextStore.remove()/clear()
         │
         ▼
    this.postState()
         │  webview.postMessage({ type: 'state', state: {...} })
         ▼
    window.addEventListener('message') → Object.assign(state) → render()
```

## 命令

| 命令 | 说明 |
|------|------|
| `KeepSeek: Open Agent Chat` | 打开 Agent 聊天面板 |
| `KeepSeek: Add Current File to Context` | 将当前编辑器文件加入上下文 |
| `KeepSeek: Pick Workspace Files for Context` | 从工作区选择文件加入上下文 |
| `KeepSeek: Pick External Files for Context` | 从外部路径选择文件/目录加入上下文 |
| `KeepSeek: Add Selection to Context` | 将编辑器选中文本作为文件引用插入输入框 |
| `KeepSeek: Add File to Context` | 将资源管理器中的文件作为引用插入输入框 |

## 配置项

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `keepseek.models` | `[{ "id": "keepseek-default", "label": "KeepSeek Default", "provider": "custom" }, { "id": "deepseek-chat", "label": "DeepSeek Chat", "provider": "deepseek" }, { "id": "custom-model", "label": "Custom Model", "provider": "custom" }]` | 聊天面板中显示的模型列表 |
| `keepseek.maxFileBytes` | `200000` | 单个上下文文件最大字节数（最小 1000） |
| `keepseek.maxContextFiles` | `32` | 上下文最大文件数（最小 1） |

## 快捷键

| 快捷键 | 条件 | 命令 |
|--------|------|------|
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 编辑器有选中文本 | `keepseek.addSelectionToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 资源管理器聚焦且选中文件 | `keepseek.addExplorerFileToContext` |

扩展激活时会自动将快捷键写入用户的 `keybindings.json`，若已存在则跳过。

## 文件引用机制

### 右键菜单：Add Selection to Context

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

### 资源管理器右键菜单：Add File to Context

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

### 拖拽文件到输入框

从 VSCode 文件资源管理器（或系统文件管理器）直接拖拽文件到输入框：

- 拖入的文件生成为文件引用链接（`.rich-file-link`），不含行号，显示为高亮文件名。
- 双击链接在 VSCode 中打开对应文件（不选中特定行）。
- 序列化格式：`文件名 <路径>`（与带行号的引用不同，没有 `#L` 片段）。

**实现细节：**

- `resolveWebviewView()` 必须设置 `enableDragAndDrop: true`（采用 `as vscode.WebviewOptions` 类型断言，因 `@types/vscode@1.100.0` 未声明该属性），否则 VSCode 资源管理器的拖拽事件不会传递到 webview。
- `startLine: 0, endLine: 0` 在 script.ts 内部作为"全文引用"的哨兵值。
- `extractFileReferences()` 处理多种拖拽数据格式：
  - `dt.files[].path`（文件系统文件）
  - `dt.items[]`（DataTransferItemList）
  - `text/uri-list`（VSCode 资源管理器 / 系统拖拽）
  - `application/vnd.code.uri-list`（VSCode 自定义 MIME，资源管理器拖入的主要数据来源）
  - `text/plain`（兜底）
- `createFileReferenceLink()` 检测 `startLine === 0` 时仅显示文件名。

### 发送前引用展开

发送消息时 `serializePrompt()` 遍历 `.rich-file-link` 元素，调用 `fileReferenceLinkToText()` 先还原为文本格式；`extension.ts` 的 `expandFileReferencesInPrompt()` 会在真正调用 AgentRunner 前读取可文本化的引用文件/行段，并把引用位置展开为 markdown 代码块。

**带行号的引用展开格式：**

````markdown
文件名 (第N-M行) <路径#LN-LM>
```typescript
引用原文
```
````

**全文引用展开格式：** 标题行为 `文件名 <路径>`，正文为文件全部内容。

不可读取、超出大小限制、图片、媒体、归档和常见二进制文件会保留原引用，不展开。

### 自动跳过的文件类型

以下扩展名的文件不会被展开为内容（保留原引用）：

`.3gp`, `.7z`, `.aac`, `.ai`, `.avi`, `.avif`, `.bmp`, `.bz2`, `.class`, `.dll`, `.dmg`, `.doc`, `.docx`, `.dylib`, `.eot`, `.exe`, `.fig`, `.flac`, `.flv`, `.gif`, `.gz`, `.heic`, `.heif`, `.icns`, `.ico`, `.jar`, `.jpeg`, `.jpg`, `.m4a`, `.mkv`, `.mov`, `.mp3`, `.mp4`, `.ogg`, `.otf`, `.pdf`, `.png`, `.psd`, `.rar`, `.sketch`, `.so`, `.svg`, `.tar`, `.tif`, `.tiff`, `.ttf`, `.wasm`, `.wav`, `.webm`, `.webp`, `.wmv`, `.woff`, `.woff2`, `.xz`, `.zip`

另外，包含 null 字节或异常控制字符超过 3% 的文件也会被判定为二进制文件并跳过。

## AgentRunner 调用链

`AgentRequest` 包含 `prompt`、`model`、`contextFiles`、`history`，当前 mock 实现做了两件事：

1. 检查是否以 `/draft <path>` 开头 → 生成 `DraftEdit`
2. 否则返回占位回复，列出已携带的上下文文件

后续接入真实模型只需替换 `AgentRunner.run()` 的实现，对外接口（`AgentRequest` / `AgentResponse`）保持不变。

## 安全写文件流程

```
AgentRunner 生成 DraftEdit
    → Webview 显示修改卡片（Apply / Discard）
    → 用户点击 Apply
    → handleMessage('applyDraftEdit')
    → SafeFileEditor.applyDraftEdit()
        → vscode.window.showWarningMessage({ modal: true })  弹窗确认
        → workspace.fs.writeFile()                           写入
        → window.showTextDocument()                          打开文件
```

确认弹窗标注了"修改"还是"创建"，并展示文件路径和修改原因。

## 临时开发指令

聊天输入支持一个临时草稿指令，便于验证写文件确认流程：

```text
/draft notes/hello.md
# Hello KeepSeek

This file was proposed by KeepSeek.
```

发送后面板会出现待确认修改卡片。点击 `Apply` 时，VS Code 会再次弹窗请求写入许可。

## 开发调试

```bash
npm install
npm run compile
npm run lint
```

在 VS Code 中打开本目录，按 `F5` 启动 Extension Development Host，然后执行命令：

```text
KeepSeek: Open Agent Chat
```

也可以在右侧 Secondary Sidebar 的视图菜单中勾选 `KeepSeek`，它会和 Codex、Claude Code 一样显示为可打开的 Agent 聊天窗口。若 VS Code 版本不支持 Secondary Sidebar 扩展贡献，则会回退到 Activity Bar 中的 KeepSeek 图标。

## 打包 VSIX

生成可安装的 VSIX：

```bash
npx vsce package --no-dependencies --out /private/tmp/keepseek-test.vsix
```

确认文件存在：

```bash
ls /private/tmp/keepseek-test.vsix
```

## 安装 VSIX 测试

### 命令行安装

如果本机已经有 `code` 命令：

```bash
code --install-extension /private/tmp/keepseek-test.vsix
```

安装后在 VS Code 中执行：

```text
Developer: Reload Window
```

然后执行：

```text
KeepSeek: Open Agent Chat
```

### 安装 code 命令

如果终端报错 `zsh: command not found: code`，在 VS Code 中执行：

```text
Shell Command: Install 'code' command in PATH
```

然后关闭当前终端，重新打开终端再执行安装命令。

### 从 VS Code 图形界面安装

1. 打开 Extensions 面板。
2. 点击右上角 `...`。
3. 选择 `Install from VSIX...`。
4. 选择 `/private/tmp/keepseek-test.vsix`。
5. 执行 `Developer: Reload Window`。

### 重新安装新版本

如果已经安装过旧版本，可以先卸载再安装：

```bash
code --uninstall-extension keepseek.keepseek
code --install-extension /private/tmp/keepseek-test.vsix
```

当前扩展 ID 来自 `publisher.name`，即 `keepseek.keepseek`。

## 需求草案

### 1. Agent 对话

- 支持多轮对话历史。
- 支持模型选择。
- 支持流式输出。
- 支持停止生成、重试、复制回复。
- 支持把上下文文件列表随请求提交给模型服务。

### 2. 模型接入

模型列表由 `keepseek.models` 配置项驱动。建议后续把模型调用抽象为 Provider：

- OpenAI-compatible API。
- DeepSeek API。
- 本地模型或本地网关。
- 用户自定义 endpoint。

所有真实调用可以先从 [src/agentRunner.ts](src/agentRunner.ts) 开始替换。

### 3. 文件上下文

KeepSeek 需要读取用户明确选择的文件：

- 当前编辑器文件。
- 工作区文件。
- 外部绝对路径文件。
- 外部目录中的文本文件。

默认跳过 `.git`、`.vscode-test`、`node_modules`、`dist`、`build`、`out`、`coverage` 等目录。后续可以增加 `.gitignore` 解析、二进制识别增强、token 预算裁剪和文件摘要缓存。

### 4. 安全修改代码

Agent 不应该静默写文件。推荐流程：

1. 模型返回结构化修改草案。
2. KeepSeek 将草案渲染为可确认的修改卡片。
3. 用户点击 Apply。
4. VS Code 再弹出 modal 确认。
5. 确认后写入文件并打开对应文档。

当前的 [src/safeFileEditor.ts](src/safeFileEditor.ts) 已经实现了第 4 和第 5 步。

### 5. 后续路线

- 接入真实模型调用和 API key 配置。
- 支持流式回复。
- 增加 diff 预览，而不是直接展示 Apply。
- 支持 workspace edit 批量修改。
- 支持读取终端输出、诊断信息、Git diff。
- 增加测试和打包发布流程。
