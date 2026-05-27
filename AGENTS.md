# KeepSeek 架构与维护指南

KeepSeek 是一个 VS Code 扩展，在 Secondary Sidebar 中提供 AI 对话面板。扩展负责会话、上下文文件、文件/目录引用展开、DeepSeek/OpenAI 兼容流式请求、只读工作区工具，以及用户确认后的 DraftEdit 写入。

本文档是仓库内 Agent/维护者约定的唯一来源。旧版约定若与本文冲突，以当前源码和本文为准。

## 分层结构

```text
src/
├── extension.ts                 # VS Code 激活入口与 Webview Provider 编排层
├── agentRunner.ts               # Agent 请求编排、工具调用循环、最终响应整理
├── deepSeekTypes.ts             # DeepSeek/OpenAI 兼容协议类型
├── deepSeekStreamParser.ts      # SSE streaming 响应解析
├── dsmlToolParser.ts            # DSML 工具调用兜底解析
├── workspaceTools.ts            # Agent 只读工作区工具与目标路径解析
├── chatSessionStore.ts          # 会话加载、持久化、裁剪与摘要
├── draftEditStore.ts            # DraftEdit 状态、应用、应用后消息记录
├── fileContext.ts               # 用户手动加入的上下文文件管理
├── fileReference.ts             # prompt 内文件引用解析、授权、展开
├── directoryReference.ts        # prompt 内目录引用解析、授权、清单展开
├── promptReferences.ts          # prompt 文件/目录引用统一展开入口
├── fileReferenceOpener.ts       # 点击/双击文件引用后的 VS Code 打开逻辑
├── referenceResources.ts        # @ 文件/目录补全资源列表
├── workspaceDirectory.ts        # 工作区目录枚举共享工具
├── textReferences.ts            # 终端/输出/调试控制台选区落盘为引用文件
├── config.ts                    # keepseek 配置默认值、读取、范围归一化
├── i18n.ts                      # 扩展端与 Webview 端文案
├── webview/
│   ├── html.ts                  # CSP、nonce、logo URI、HTML 拼装
│   ├── styles.ts                # 主 Webview CSS 字符串
│   ├── template.ts              # 主 Webview HTML 骨架字符串
│   ├── script.ts                # 主 Webview JS 字符串
│   ├── richTextShortcuts.ts     # 富文本输入/编辑器共享快捷键与剪贴板桥接
│   └── input/
│       ├── styles.ts            # 输入区 CSS 字符串
│       ├── template.ts          # 输入区 HTML 字符串
│       └── script.ts            # 富文本输入、拖拽、@ 引用、命令菜单
├── keybindings.ts               # 用户 keybindings.json 兼容写入
├── markdown.ts                  # Markdown fence/language 共享工具
├── format.ts                    # 通用格式化
├── errors.ts                    # 错误信息归一化
├── safeFileEditor.ts            # 用户确认后写入 DraftEdit
└── types.ts                     # 跨模块共享领域类型
```

## 核心职责

**表现层**

- `webview/template.ts`、`webview/styles.ts`、`webview/script.ts` 和 `webview/input/*` 只输出字符串。
- `webview/html.ts` 负责 CSP、nonce、logo URI 和三段字符串拼装。
- Webview 通过 `acquireVsCodeApi()` 与 Provider 通信，通过 `vscode.postMessage({ type, ... })` 发送 `WebviewMessage`。
- `webview/richTextShortcuts.ts` 生成共享的 Webview 端快捷键控制器，底部 prompt 输入框和消息编辑输入框都通过它支持 Emacs/macOS 文本快捷键；不要在两个编辑器里复制快捷键实现。

**编排层**

- `extension.ts` 中的 `KeepseekChatViewProvider` 是 VS Code/Webview 的协调者，不再直接持有会话数组或 DraftEdit Map。
- Provider 负责注册/响应消息、调用服务、同步状态、展示 VS Code 通知。
- 不要把可独立测试的纯逻辑继续塞回 Provider；优先放入独立模块。

**业务层**

- `ChatSessionStore` 管理会话生命周期，存储 key 为 `keepseek.chatSessions`，最多保留 50 个有内容会话，活跃空会话会保留。
- `FileContextStore` 管理用户显式加入上下文的文件内容，读取限制来自 `keepseek.maxFileBytes` 和 `keepseek.maxContextFiles`。
- `DraftEditStore` 管理待确认编辑，应用成功后追加一条 assistant 消息，并通过 `SafeFileEditor` 写入。
- `fileReference.ts` 管理 prompt 内的 `<path>` / `<path#Lx-Ly>` 文件引用展开；`directoryReference.ts` 管理 `<keepseek-dir:path>` 目录引用清单展开；外部文件/目录必须先被授权。

**协议与基础设施层**

- `AgentRunner` 只做请求编排：构造 system prompt、拼历史、调用 DeepSeek chat completions、处理工具调用循环、整理最终消息。
- `DeepSeekStreamParser` 只解析 SSE，包括 `content`、`reasoning_content` 和 streaming tool calls。
- `DsmlToolParser` 是模型返回 DSML 文本工具调用时的兜底解析器。
- `WorkspaceToolService` 是 Agent 可用的只读工作区工具边界：列文件、列目录、读文件、拒绝越界/二进制/过大文件。
- `config.ts` 是配置默认值和归一化的唯一来源，避免各模块重复魔法数字。

## 关键通信流

1. Webview 调用 `vscode.postMessage({ type, ... })`。
2. `KeepseekChatViewProvider.handleMessage()` 根据 `type` 分发。
3. Provider 修改业务状态或调用 `AgentRunner`。
4. Provider 调用 `postState()` 或 `postToWebview({ type: 'state', state })`，把当前状态推给 Webview。
5. Webview 全局 `state` 更新后 `render()`。

主动从扩展推到 Webview 的特殊消息不属于 `WebviewMessage` 的 switch 输入：

- `insertFileReference` / `insertDirectoryReference`：Provider 主动插入文件或目录引用 chip。
- `referenceResources`：回应 `@` 文件/目录补全请求。
- `sessionChanged`：通知 Webview 会话切换。
- `showSettingsDialog`：打开设置弹窗。

## 文件与目录引用系统

### 序列化格式

- 行段引用：`文件名 (第N-M行) <路径#LN-LM>`。
- 带列引用：`文件名 (第N行第C-D列) <路径#LNCx-Cy>`。
- 全文引用：`文件名 <路径>`。
- 目录引用：`目录名/ <keepseek-dir:路径>`。
- `startLine: 0, endLine: 0` 是全文引用哨兵值。

发送消息时，Webview 的 `serializePrompt()` 遍历 `.rich-file-link`，先还原为文本格式；Provider 调用 `expandPromptReferencesInPrompt()`，在真正传给 `AgentRunner` 前展开可读文本文件引用和目录引用清单。

文件引用展开格式：

````markdown
文件名 (第N-M行) <路径#LN-LM>
```typescript
引用原文
```
````

全文引用展开时标题行为 `文件名 <路径>`。不可读取、超出大小限制、图片、媒体、归档、常见二进制文件、未授权外部文件会保留原引用，不展开。

目录引用不会直接展开整个目录内容，而是展开为目录锚点、使用说明和受限条目清单；Agent 需要更多细节时应调用 `keepseek_list_workspace_directory` 或 `keepseek_read_workspace_file`。

### 授权规则

- 工作区内文件/目录可展开。
- 外部文件/目录必须先进入授权集合，授权 key 是 `uri.toString()`。
- 授权入口包括编辑器选区、Explorer 文件、外部文件选择、拖拽导入、终端/输出/Debug Console 选区落盘文件。

### 右键菜单：Add Selection to Context

- 命令：`keepseek.addSelectionToContext`
- 触发条件：编辑器中选中文本（`editorHasSelection`）
- 路径：右键 → `KeepSeek: Add Selection to Context`

流程：

```text
editor.selection (0-based) + editor.document.uri.fsPath
  → extension.ts: insertSelectionToInput()  // 行号/列号转为 1-based
    → reveal() 展开面板
    → postMessage({ type: 'insertFileReference', path, startLine, endLine, startColumn, endColumn })
      → webview/input/script.ts: createFileReferenceLink()
      → insertFragmentAtRange() 插入到光标位置
```

Output / Debug Console 文档和 Terminal 选区不是直接引用原 URI，而是通过 `textReferences.ts` 复制或读取选区，写入 `globalStorageUri/text-references/...` 后作为全文文件引用插入。

### 资源管理器右键菜单：Add File to Context

- 命令：`keepseek.addExplorerFileToContext`
- 触发条件：资源管理器中文件右键（`!explorerResourceIsFolder`）
- 路径：Explorer → 文件右键 → `KeepSeek: Add File to Context`

流程：

```text
explorer/context 传入 vscode.Uri
  → extension.ts: insertExplorerFileToInput()
    → reveal() 展开面板
    → postMessage({ type: 'insertFileReference', path, startLine: 0, endLine: 0 })
      → webview/input/script.ts: 插入全文文件引用 chip
```

没有已保存光标时，全文 chip 插入到输入框末尾。

### 资源管理器右键菜单：Add Directory to Context

- 命令：`keepseek.addExplorerDirectoryToContext`
- 触发条件：资源管理器中目录右键（`explorerResourceIsFolder`）
- 路径：Explorer → 目录右键 → `KeepSeek: Add Explorer Folder to Chat`

流程：

```text
explorer/context 传入 vscode.Uri
  → extension.ts: insertExplorerDirectoryToInput()
    → reveal() 展开面板
    → postMessage({ type: 'insertDirectoryReference', path })
      → webview/input/script.ts: 插入目录引用 chip
```

### 拖拽文件到输入框

从 VS Code Explorer 或系统文件管理器拖入文件，会生成 `.rich-file-link`，不含行号，显示高亮文件名，序列化为 `文件名 <路径>`。

实现要点：

- `resolveWebviewView()` 必须设置 `enableDragAndDrop: true`，否则 VS Code Explorer 拖拽事件不会传递到 Webview。
- 拖入的文件内容会导入 `globalStorageUri/dropped-file-references/...`，再作为外部全文引用授权并插入。
- `extractFileReferences()` 处理多种拖拽数据：`dt.files[]`、`dt.items[]`、`text/uri-list`、`application/vnd.code.uri-list`、`text/plain`。
- `createFileReferenceLink()` 检测 `startLine === 0` 时只显示文件名。
- 打开引用逻辑在 `fileReferenceOpener.ts`；`startLine <= 0` 时仅打开文件，不创建选区。

## Agent 与工具

Agent 支持四个工具名：

- `keepseek_list_workspace_files`：列出当前工作区文件，跳过 `.git`、`node_modules`、`dist` 等目录。
- `keepseek_list_workspace_directory`：列出当前工作区内指定目录的文件和子目录，可递归，跳过依赖、构建、覆盖率和 VCS 目录。
- `keepseek_read_workspace_file`：读取工作区内文本文件，拒绝越界、二进制、超限文件。
- `keepseek_create_draft_edit`：创建待确认 DraftEdit，不直接写磁盘。

`AgentRunner.run()` 的输入输出保持在 `types.ts`：

- 输入：`AgentRequest`，包含 prompt、模型、Agent 设置、上下文文件、历史消息、语言。
- 输出：`AgentResponse`，包含最终文本、可选 reasoningContent、DraftEdit 列表。

工具调用预算由 `keepseek.maxToolIterations`（默认 8，范围 0-64）、`keepseek.maxToolCalls`（默认 24，范围 0-256）、`keepseek.maxRunMs`（默认 600000，范围 0-3600000）和 `keepseek.toolResultTokenBudget`（默认 0，自动按模型上下文估算，范围 0-1000000）共同控制。

## 设计原则

- **依赖倒置**：`AgentRunner` 依赖 `WorkspaceToolAdapter`，默认实现是 `WorkspaceToolService`，便于测试替换。
- **组合优于继承**：Provider 组合 `ChatSessionStore`、`DraftEditStore`、`FileContextStore`、`AgentRunner`。
- **协议解析隔离**：SSE 和 DSML 解析独立于请求编排，避免 AgentRunner 继续膨胀。
- **配置集中化**：默认值、范围 clamp、模型归一化都在 `config.ts`。
- **错误边界清晰**：用户可见错误统一通过 `getErrorMessage()` + `localize()` 展示；工具返回 JSON `{ ok, error }`，不把异常直接泄漏给模型。
- **安全写入**：AI 只能生成 DraftEdit。真正写入由用户点击 Apply 后触发。

## 编码规范

- 新增配置：先改 `package.json` 的 `contributes.configuration`，再在 `config.ts` 增加读取/归一化。
- 新增 Webview → 扩展消息：更新 `WebviewMessage` 联合类型、`handleMessage()`、Webview 脚本发送点；剪贴板兜底消息 `requestClipboardText` / `writeClipboardText` 由 `webview/richTextShortcuts.ts` 统一发起。
- 新增扩展 → Webview 主动消息：不要放进 `WebviewMessage`，但要在 Webview message listener 中处理。
- 新增 Agent 工具：更新 `agentRunner.ts` 的工具 schema 和工具路由；工具实现优先放独立模块。
- 修改文件或目录引用格式：同步检查 `fileReference.ts`、`directoryReference.ts`、`webview/input/script.ts`、`webview/script.ts` 的序列化/反序列化/打开逻辑。
- 修改 DraftEdit 应用行为：优先改 `DraftEditStore` / `SafeFileEditor`，不要放进 `AgentRunner`。
- 修改样式只碰 `webview/styles.ts` 或 `webview/input/styles.ts`；修改输入区专属交互只碰 `webview/input/script.ts`；修改 transcript/设置/会话 UI 只碰 `webview/script.ts`；修改富文本通用快捷键、mark/region、剪贴板桥接优先改 `webview/richTextShortcuts.ts`。
- 注释只解释非显而易见的边界、安全规则或协议兼容逻辑。
- 不要复制 Markdown fence、字节格式化、配置读取、错误字符串等公共逻辑；使用 `markdown.ts`、`format.ts`、`config.ts`、`errors.ts`。
- 捕获异常时要么转换成用户可见本地化消息，要么转换成工具 JSON 错误。

## 维护热点

- `extension.ts` 仍是 VS Code Provider 编排中心，新增大功能时优先创建服务模块，再在 Provider 中接线。
- `webview/script.ts` 和 `webview/input/script.ts` 仍是大字符串文件；改动时保持 DOM id、message type、序列化格式兼容，并重点手测输入、拖拽、`@` 引用、编辑重发、Apply/Discard。
- `webview/richTextShortcuts.ts` 同时影响底部 prompt 输入框和消息编辑输入框；修改后必须验证 Emacs 光标移动、mark/region、`Ctrl-K` 剪切行尾、`Ctrl-W` 剪切选区、`Alt-W` 复制、`Ctrl-Y` 粘贴，以及 `Command-A/C/X/V/Z` 系统习惯。
- `safeFileEditor.ts` 当前只做确认后的整文件写入；如果未来增加 diff、冲突检测、备份或权限确认，应在这里扩展，不要放进 AgentRunner。
- `fileReference.ts` / `directoryReference.ts` 是引用格式兼容核心；修改时必须验证全文引用、行段引用、目录引用、外部授权、不可读文件跳过。

## 常用验证

```bash
npm run compile
npm run lint
```

开发调试：用 VS Code 打开仓库，按 F5 启动 Extension Development Host。

重点手测：普通发送、编辑重发、会话切换、上下文文件添加、选区引用、Explorer 文件/目录引用、拖拽引用、`@` 文件/目录补全、引用展开、Agent 读文件/列文件/列目录、DraftEdit Apply/Discard/Apply All、语言切换、API 设置保存、context window 估算显示。
