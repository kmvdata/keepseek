# KeepSeek 项目架构与关键实现

## 项目概述

KeepSeek 是一个 VS Code 扩展，在侧边栏中提供一个 AI 聊天 Agent（代码助手）。用户可以通过聊天与 AI 交互，AI 可以读取工作区文件、上下文文件，并生成可审阅的草稿编辑（DraftEdit）。

- **扩展 ID**: `keepseek.keepseek`
- **发布者**: `keepseek`
- **入口文件**: `src/extension.ts`

---

## 文件结构

```
keepseek/
├── src/
│   ├── extension.ts          # 扩展入口 + Webview Provider（核心）
│   ├── agentRunner.ts         # AI 调用运行器
│   ├── fileContext.ts         # 上下文文件管理
│   ├── fileReference.ts       # 文件引用解析、展开
│   ├── safeFileEditor.ts      # 安全的文件编辑（DraftEdit 应用）
│   ├── i18n.ts                # 国际化
│   ├── types.ts               # TypeScript 类型定义
│   ├── webview/
│   │   ├── script.ts          # Webview 前端脚本
│   │   ├── styles.ts          # Webview 样式
│   │   └── template.ts        # Webview HTML 模板
│   └── test/
│       └── ...
├── package.json               # VS Code 扩展清单
├── tsconfig.json
├── eslint.config.mjs
└── __SKILLS.md                # 本文件
```

---

## 核心架构

### 1. 扩展激活 (`extension.ts`)

`activate()` 函数是扩展入口：

1. **注册 Webview Provider**：`KeepseekChatViewProvider`，支持主侧边栏 (`keepseek.chatView`) 和副侧边栏 (`keepseek.chatSecondaryView`，VS Code ≥ 1.106）。
2. **注册命令**：
   - `keepseek.openChat` — 打开聊天窗口
   - `keepseek.addCurrentFileToContext` — 将当前编辑器文件添加上下文
   - `keepseek.pickWorkspaceFilesToContext` — 从工作区选取文件
   - `keepseek.pickExternalFilesToContext` — 从外部选取文件
   - `keepseek.addSelectionToContext` — 将选区作为文件引用插入输入框（快捷键 Ctrl+L / Cmd+L）
   - `keepseek.addExplorerFileToContext` — 从资源管理器插入文件引用
3. **快捷键注册** (`ensureKeybindings`)：自动在 `keybindings.json` 中注册 Ctrl+L / Cmd+L 快捷键。

### 2. Webview Provider (`KeepseekChatViewProvider`)

这是整个扩展的核心类，管理：

| 职责 | 关键属性/方法 |
|------|---------------|
| Webview 生命周期 | `resolveWebviewView()`, `views: Set<WebviewView>` |
| 会话管理 | `sessions: ChatSession[]`, `activeSessionId`, `loadSessions()`, `persistSessions()`, `createNewSession()`, `selectSession()` |
| 消息处理 | `handleMessage()` — 处理前端发来的所有消息 |
| 上下文文件 | `fileContext: FileContextStore` |
| AI 运行 | `agentRunner: AgentRunner` |
| 草稿编辑 | `safeFileEditor: SafeFileEditor`, `draftEdits: Map<string, DraftEdit>` |
| 状态同步 | `postState()` — 将完整状态推送到 Webview |

### 3. 消息流（前端 ↔ 后端）

前端通过 `vscode.webview.postMessage()` 发送消息，后端在 `handleMessage()` 中处理。消息类型定义在 `WebviewMessage` 联合类型中：

**用户操作类**：
- `ready` — Webview 准备好，触发初始状态推送
- `sendPrompt` — 发送聊天消息
- `editUserPrompt` — 编辑已发送的用户消息（重新发送）
- `newSession` / `selectSession` — 会话管理

**设置类**：
- `setSelectedModel` / `setAgentSettings` — 模型和代理设置
- `openSettings` / `saveSettings` — API Key / Base URL 配置
- `setLanguage` — 语言切换（中文/英文）

**文件操作类**：
- `addCurrentFile` / `pickWorkspaceFiles` / `pickExternalFiles` — 添加上下文文件
- `pickExternalFileReferences` — 添加外部文件引用
- `insertDroppedFileReferences` — 拖放文件引用
- `readPath` — 读取路径到上下文
- `removeContextFile` / `clearContext` — 移除/清除上下文文件
- `requestReferenceResources` — 请求工作区文件列表（用于 `@` 补全）

**文件引用类**：
- `openFileReference` — 在编辑器中打开文件引用并定位到指定行列

**草稿编辑类**：
- `applyDraftEdit` / `discardDraftEdit` — 应用或丢弃 AI 生成的草稿编辑

后端通过 `postState()` 统一推送状态，消息类型为 `'state'`，包含：
- `models` — 可用模型列表
- `selectedModelId` — 当前选中模型
- `agentSettings` — Agent 设置（thinkingEnabled, reasoningEffort）
- `messages` — 当前会话消息（不含 expandedContent）
- `activeSessionId` / `sessionSummaries` — 会话信息
- `contextFiles` — 上下文文件列表（不含文件内容）
- `draftEdits` — 待处理的草稿编辑列表（不含 newText）
- `isBusy` — 是否正在处理请求
- `maxFileBytes` — 文件大小上限
- `language` — 当前语言

### 4. AI 调用 (`agentRunner.ts`)

`AgentRunner.run()` 方法：

**输入**：
- `prompt` — 用户提示词（已展开文件引用）
- `model` — 模型信息（id, label, provider）
- `settings` — Agent 设置（thinkingEnabled, reasoningEffort）
- `contextFiles` — 上下文文件（含内容）
- `history` — 历史消息
- `language` — 界面语言

**流程**：
1. 构造消息：system prompt（包含上下文文件内容、语言指令、工具使用说明）+ 历史消息 + 用户提示
2. 调用 DeepSeek API（OpenAI 兼容格式），支持 streaming
3. 解析响应中的 `reasoning_content`（思考过程）和 `content`（正式回答）
4. 解析 AI 返回的 `__draft_edit` 工具调用，生成 `DraftEdit` 对象

**输出**：
```typescript
{
  message: string;           // AI 回答文本
  reasoningContent?: string; // 思考过程
  draftEdits: DraftEdit[];   // 草稿编辑列表
}
```

### 5. 草稿编辑机制 (`safeFileEditor.ts`)

AI 通过特殊格式生成草稿编辑：

- **格式**：`__draft_edit("path", startLine, endLine) ... __draft_edit_end`
- `DraftEdit` 包含：`id`, `path`, `label`, `originalText`, `newText`, `startLine`, `endLine`
- 前端显示为可展开的 diff 卡片，用户可选择 **Apply** 或 **Discard**
- **Apply** 时调用 `safeFileEditor.applyDraftEdit()`，会：
  1. 检查是否在 `.git` 中（安全）
  2. 检查是否有未提交更改（安全）
  3. 写入文件

### 6. 文件引用系统 (`fileReference.ts`)

**文件引用格式**：用户在提示中使用 `@path:startLine-endLine` 引用文件。

- `expandFileReferencesInPrompt()` — 解析提示中的 `@` 引用，替换为文件内容
- `resolveFileReferenceUri()` — 将路径字符串解析为 VS Code URI
- `getExplorerFileUris()` — 从资源管理器获取选中文件
- 授权机制：外部文件引用需授权后才能读取（`authorizedExternalReferenceUris`）

### 7. 上下文文件管理 (`fileContext.ts`)

`FileContextStore` 类管理对话的上下文文件：

- `addCurrentEditor()` — 添加当前编辑器文件
- `pickWorkspaceFiles()` — 通过文件选择器添加工作区文件
- `pickExternalFiles()` — 添加外部文件
- `addPath()` — 通过路径添加文件
- `remove()` / `clear()` — 移除/清除上下文
- `getAll()` — 获取所有上下文文件（含内容）

### 8. 国际化 (`i18n.ts`)

- 支持 `zh-CN` 和 `en` 两种语言
- `localize(language, key, values?)` — 获取本地化字符串
- `getConfiguredKeepseekLanguage()` — 从配置读取语言
- 语言可通过设置面板切换

### 9. 类型定义 (`types.ts`)

关键类型：

```typescript
ChatMessage        — { id, role, content, expandedContent?, reasoningContent?, createdAt, modelId? }
ChatSession        — { id, title, messages, createdAt, updatedAt }
ChatSessionSummary — { id, title, createdAt, updatedAt, messageCount }
KeepseekModel      — { id, label, provider }
AgentSettings      — { thinkingEnabled, reasoningEffort }
DraftEdit          — { id, path, label, originalText, newText, startLine, endLine }
ReferenceResource  — { uri, path, label, description, workspaceFolder, kind }
ContextFile        — { uri, path, label, description, content }
```

### 10. 会话持久化

- 存储在 `context.workspaceState`（VS Code 工作区状态）
- Key: `keepseek.chatSessions`
- 最多保存 50 个会话
- 自动清理空会话（当前活跃会话除外）
- 历史消息最多保留 80 条

---

## 配置项 (`package.json` contributes.configuration)

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `keepseek.apiKey` | string | `""` | API Key |
| `keepseek.baseUrl` | string | `"https://api.deepseek.com"` | API Base URL |
| `keepseek.models` | array | DeepSeek-V4-Flash/V4-Pro | 可用模型列表 |
| `keepseek.thinkingEnabled` | boolean | `true` | 是否启用思考模式 |
| `keepseek.reasoningEffort` | string | `"high"` | 推理强度 (high/max) |
| `keepseek.language` | string | 默认语言 | 界面语言 (zh-CN/en) |
| `keepseek.maxFileBytes` | number | `200000` | 文件大小上限 |

---

## 调试与安装

### 开发调试

```bash
npm install
npm run compile
npm run lint
```

用 VS Code 打开本目录，按 `F5` 启动 Extension Development Host。

### 打包 VSIX

```bash
npx vsce package --no-dependencies --out /private/tmp/keepseek-test.vsix
```

### 安装 VSIX

```bash
code --install-extension /private/tmp/keepseek-test.vsix
```

安装后执行 `Developer: Reload Window`，然后执行 `KeepSeek: Open Agent Chat`。

### 重新安装

```bash
code --uninstall-extension keepseek.keepseek
code --install-extension /private/tmp/keepseek-test.vsix
```

---

## 改进与扩展指南

当需要修改此项目时，请参考以下关键文件：

1. **添加新命令** → 修改 `extension.ts` 的 `activate()` 和 `handleMessage()`
2. **修改 AI 行为** → 修改 `agentRunner.ts` 的 system prompt 和工具解析
3. **添加新的前端功能** → 修改 `src/webview/script.ts`、`styles.ts`、`template.ts`
4. **修改类型** → 修改 `src/types.ts`
5. **添加/修改配置项** → 修改 `package.json` 的 `contributes.configuration` 和 `extension.ts` 中的读取逻辑
6. **修改国际化** → 修改 `src/i18n.ts`
7. **修改文件引用行为** → 修改 `src/fileReference.ts`
8. **修改上下文文件管理** → 修改 `src/fileContext.ts`
9. **修改草稿编辑逻辑** → 修改 `src/safeFileEditor.ts`
