# KeepSeek

VS Code 扩展，在 Secondary Sidebar 内嵌 AI 对话面板。当前架构已按编排层、业务层、协议/基础设施层、Webview 表现层拆分；不要再按旧版“所有逻辑都在 `extension.ts` / `agentRunner.ts`”的方式理解或继续堆代码。

更完整的设计背景见 `__SKILLS.md`。若本文与源码或 `__SKILLS.md` 冲突，以当前源码和 `__SKILLS.md` 为准。

## 目录结构

```text
src/
├── extension.ts                 # VS Code 激活入口与 Webview Provider 编排层
├── agentRunner.ts               # Agent 请求编排、工具循环、最终响应整理
├── deepSeekTypes.ts             # DeepSeek/OpenAI 兼容协议类型
├── deepSeekStreamParser.ts      # SSE streaming 响应解析
├── dsmlToolParser.ts            # DSML 工具调用兜底解析
├── workspaceTools.ts            # Agent 只读工作区工具与目标路径解析
├── chatSessionStore.ts          # 会话加载、持久化、裁剪、摘要
├── draftEditStore.ts            # DraftEdit 状态、应用、应用后消息记录
├── fileContext.ts               # 用户手动加入的上下文文件管理
├── fileReference.ts             # prompt 文件引用解析、授权、展开
├── fileReferenceOpener.ts       # 点击/双击文件引用后的 VS Code 打开逻辑
├── referenceResources.ts        # @ 文件补全资源列表
├── textReferences.ts            # 终端/输出/调试控制台选区落盘为引用文件
├── config.ts                    # keepseek 配置默认值、读取、范围归一化
├── i18n.ts                      # 扩展端与 Webview 端文案
├── webview/
│   ├── html.ts                  # CSP、nonce、logo URI、HTML 拼装
│   ├── styles.ts                # 主 Webview CSS 字符串
│   ├── template.ts              # 主 Webview HTML 骨架字符串
│   ├── script.ts                # 主 Webview JS 字符串
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

## 架构边界

- `extension.ts` 只做 VS Code/Webview 编排：注册命令、处理 `WebviewMessage`、调用服务、推送状态、显示通知。
- Provider 不直接管理会话数组或 DraftEdit Map；会话放在 `ChatSessionStore`，DraftEdit 放在 `DraftEditStore`。
- `agentRunner.ts` 只做 Agent 请求编排；SSE 解析在 `DeepSeekStreamParser`，DSML 解析在 `DsmlToolParser`，工作区读写边界在 `WorkspaceToolService`。
- 配置默认值、clamp、模型归一化只放 `config.ts`。不要在业务模块重复魔法数字。
- Markdown fence/language 用 `markdown.ts`，字节显示用 `format.ts`，错误文本用 `errors.ts`。
- AI 只能创建 DraftEdit；真正写文件必须通过用户点击 Apply 后由 `SafeFileEditor` 执行。

## Webview 约定

- `webview/template.ts`、`webview/styles.ts`、`webview/script.ts` 和 `webview/input/*` 都导出纯字符串。
- `webview/html.ts` 通过 `${getStyles()}` / `${getTemplate()}` / `${getScript()}` 组装完整 HTML，并负责 CSP nonce。
- 改样式只碰对应 `styles.ts`；改输入框行为优先碰 `webview/input/script.ts`；改 transcript、会话、设置、DraftEdit UI 优先碰 `webview/script.ts`。
- Webview JS 通过 `acquireVsCodeApi()` 与 Provider 通信。

## 关键通信流

1. Webview JS → `vscode.postMessage({ type, ... })`
2. `extension.ts` → `KeepseekChatViewProvider.handleMessage()`
3. Provider 调用业务/基础设施模块
4. Provider → `postToWebview({ type: 'state', state })`
5. Webview 全局 `state` 更新 → `render()`

### 扩展主动推送消息

这些消息不是 `WebviewMessage` 的输入，不应放进 `handleMessage()` switch：

- `insertFileReference`：Provider 主动把文件引用 chip 插入输入框。
- `referenceResources`：回应 `@` 文件补全请求。
- `sessionChanged`：通知 Webview 会话切换。
- `showSettingsDialog`：打开设置弹窗。

## 文件引用系统

### 序列化格式

- 行段引用：`文件名 (第N-M行) <路径#LN-LM>`
- 带列引用：`文件名 (第N行第C-D列) <路径#LNCx-Cy>`
- 全文引用：`文件名 <路径>`
- `startLine: 0, endLine: 0` 是全文引用哨兵值。

发送消息时，Webview 的 `serializePrompt()` 遍历 `.rich-file-link`，先还原为文本格式；Provider 调用 `expandFileReferencesInPrompt()`，在真正传给 `AgentRunner` 前展开可读文本引用。

发送前展开格式：

````markdown
文件名 (第N-M行) <路径#LN-LM>
```typescript
引用原文
```
````

全文引用展开时标题行为 `文件名 <路径>`。不可读取、超出大小限制、图片、媒体、归档、常见二进制文件、未授权外部文件会保留原引用，不展开。

### 授权规则

- 工作区内文件可展开。
- 外部文件必须先进入授权集合，授权 key 是 `uri.toString()`。
- 授权入口包括编辑器选区、Explorer 文件、外部文件选择、拖拽导入、终端/输出/Debug Console 选区落盘文件。

## 右键菜单：Add Selection to Context

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

## 资源管理器右键菜单：Add File to Context

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

## 拖拽文件到输入框

从 VS Code Explorer 或系统文件管理器拖入文件，会生成 `.rich-file-link`，不含行号，显示高亮文件名，序列化为 `文件名 <路径>`。

实现要点：

- `resolveWebviewView()` 必须设置 `enableDragAndDrop: true`，否则 VS Code Explorer 拖拽事件不会传递到 Webview。
- 拖入的文件内容会导入 `globalStorageUri/dropped-file-references/...`，再作为外部全文引用授权并插入。
- `extractFileReferences()` 处理多种拖拽数据：`dt.files[]`、`dt.items[]`、`text/uri-list`、`application/vnd.code.uri-list`、`text/plain`。
- `createFileReferenceLink()` 检测 `startLine === 0` 时只显示文件名。
- 打开引用逻辑在 `fileReferenceOpener.ts`；`startLine <= 0` 时仅打开文件，不创建选区。

## Agent 工具

Agent 当前支持三个工具名：

- `keepseek_list_workspace_files`
- `keepseek_read_workspace_file`
- `keepseek_create_draft_edit`

`WorkspaceToolService` 只允许读取当前打开工作区内的文本文件，会拒绝越界、二进制、图片/媒体/归档和超限文件。`keepseek_create_draft_edit` 只创建待确认编辑，不写磁盘。

## 修改代码时的规则

- 新增配置：先改 `package.json` 的 `contributes.configuration`，再改 `config.ts`。
- 新增 Webview→扩展消息：更新 `WebviewMessage`、`handleMessage()` 和 Webview 发送点。
- 新增扩展→Webview 主动消息：不要放进 `WebviewMessage`，但要在 Webview message listener 中处理。
- 新增 Agent 工具：更新 `agentRunner.ts` 的工具 schema 和工具路由；工具实现优先放独立模块。
- 修改文件引用格式：同步检查 `fileReference.ts`、`webview/input/script.ts`、`webview/script.ts` 的序列化/反序列化/打开逻辑。
- 修改 DraftEdit 应用行为：优先改 `DraftEditStore` / `SafeFileEditor`，不要放进 `AgentRunner`。
- 大型 UI 脚本仍是热点文件；改动后必须手测输入、拖拽、@ 引用、编辑重发、Apply/Discard。

## 常用验证

```bash
npm run compile
npm run lint
```

重点手测：普通发送、编辑重发、会话切换、上下文文件添加、选区引用、Explorer 引用、拖拽引用、`@` 文件补全、引用展开、Agent 读文件/列文件、DraftEdit Apply/Discard/Apply All、语言切换、API 设置保存。
