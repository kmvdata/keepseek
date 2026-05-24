# KeepSeek

KeepSeek 是一款面向 VS Code 的 AI 编程上下文助手。它把 Agent 对话面板放进 VS Code 侧边栏，让你可以把文件、选中代码、终端输出、调试控制台和 Output 面板里的关键内容快速加入上下文，再交给 AI 一起分析、解释和生成修改建议。

当前版本默认接入 DeepSeek OpenAI-compatible Chat Completions，支持 DeepSeek V4 Flash / Pro、Thinking 模式、多轮对话、文件引用、运行日志引用和安全的修改草案确认流程。

English version is available below: [English](#keepseek-english).

## 适用场景

- 阅读陌生项目：选择入口文件、配置文件和关键代码片段，让 AI 帮你梳理模块关系、执行路径和风险点。
- 调试运行错误：把终端报错、测试失败输出、Debug Console 内容或 Output 面板日志加入上下文，让 AI 基于真实现场分析原因。
- 修改代码前做方案：引用相关文件和行号，让 AI 先解释影响范围，再生成可审阅的修改草案。
- 处理跨文件任务：把多个工作区文件或外部文件加入上下文，围绕同一需求持续对话。
- 复盘构建和测试：将编译输出、lint 结果、测试日志交给 AI，总结失败点和下一步动作。

## 适合谁

- 独立开发者：在一个轻量侧边栏里完成代码阅读、问题定位和方案讨论。
- 团队工程师：把真实代码和运行输出一并交给 AI，减少来回复制上下文的成本。
- 新加入项目的开发者：快速理解代码结构、约定和关键文件。
- 维护者和 Reviewer：围绕具体文件、行号、日志和修改草案做更精确的审查。
- 使用 DeepSeek 或兼容 OpenAI API 网关的开发者：可以通过配置替换模型列表和 API base URL。

## 核心功能

- 侧边栏 Agent 对话：KeepSeek 显示在 VS Code Secondary Sidebar 中，适合一边看代码一边对话。
- 多模型配置：默认提供 DeepSeek V4 Flash / Pro，也支持通过 `keepseek.models` 配置模型列表。
- Thinking 模式：支持开启或关闭 Thinking，并选择 `high` / `max` 推理强度。
- 多轮会话历史：保留最近对话，支持切换历史会话。
- 文件上下文：添加当前文件、工作区文件、外部文件或目录，也可以手动输入路径。
- 精确文件引用：右键或快捷键添加编辑器选区，保留文件路径、行号和列号。
- 运行现场引用：终端、Output 面板和调试控制台中的选中内容可以作为 `.log` 引用插入输入框，发送前会展开给 AI。
- 拖拽文件引用：从 VS Code Explorer 或系统文件管理器拖入文件，自动生成可点击的引用 chip。
- 安全修改草案：AI 只能创建待确认的 DraftEdit，用户点击 Apply 后还会经过 VS Code modal 确认再写入文件。
- 基础防护：限制单个上下文文件大小，跳过常见二进制、媒体、归档和不可读文件。

## 工作方式

KeepSeek 的核心是“显式上下文”。你选择哪些代码、文件或日志进入上下文，AI 就围绕这些材料回答，而不是猜测整个项目状态。

典型流程：

1. 在编辑器、资源管理器、终端、Output 或 Debug Console 中选择需要的内容。
2. 使用右键菜单或 `Cmd+L` / `Ctrl+L` 添加到 KeepSeek 输入框。
3. 输入问题或任务，例如“解释这个报错为什么发生”或“给出最小修改方案”。
4. AI 回复后，如果包含修改草案，你可以选择 Apply 或 Discard。
5. Apply 时 VS Code 会再次弹窗确认，确认后才写入文件。

## 快捷键

| 快捷键 | 条件 | 命令 |
|--------|------|------|
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 编辑器有选中文本 | `keepseek.addSelectionToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 资源管理器聚焦且选中文件 | `keepseek.addExplorerFileToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 终端有选中文本 | `keepseek.addTerminalSelectionToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 调试控制台聚焦 | `keepseek.addDebugConsoleSelectionToContext` |

扩展激活时会尝试把这些快捷键写入用户的 `keybindings.json`。如果已经存在对应绑定，则会跳过。

## 右键菜单

- 编辑器选区：`KeepSeek: 添加到上下文`
- Explorer 文件：`KeepSeek: Add Explorer File to Chat`
- 终端选区：`KeepSeek: 添加到上下文`
- Output 面板选区：`KeepSeek: 添加到上下文`

调试控制台可以使用 `Cmd+L` / `Ctrl+L` 添加当前选区。VS Code 对 Debug Console 原生右键菜单的扩展点较有限，因此快捷键是当前最稳定的入口。

## 配置项

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `keepseek.apiKey` | `""` | DeepSeek API Key，也可用 `DEEPSEEK_API_KEY` 环境变量兜底 |
| `keepseek.baseUrl` | `"https://api.deepseek.com"` | OpenAI-compatible API base URL |
| `keepseek.models` | DeepSeek V4 Flash / Pro | 聊天面板中显示的模型列表 |
| `keepseek.thinkingEnabled` | `true` | 是否开启 Thinking 模式 |
| `keepseek.reasoningEffort` | `"high"` | Thinking 推理强度，支持 `high` 或 `max` |
| `keepseek.maxFileBytes` | `200000` | 单个引用文件或日志片段的最大字节数 |

## 隐私与安全

- KeepSeek 只读取你明确选择或添加的文件、路径和选区。
- 外部文件和拖拽文件需要经过扩展授权记录后才会在发送前展开。
- 图片、媒体、归档和常见二进制文件不会被展开到 prompt。
- AI 生成的文件修改不会静默写入。所有修改都以 DraftEdit 形式展示，并由用户确认后执行。
- 终端和调试控制台选区会以临时 `.log` 文件形式存储在扩展全局存储目录中，用于复用现有文件引用展开机制。

## 安装与使用

从 VSIX 安装：

```bash
code --install-extension keepseek-0.0.6.vsix
```

安装后在 VS Code 中执行：

```text
KeepSeek: Open Agent Chat
```

配置 API Key：

1. 打开 VS Code Settings。
2. 搜索 `KeepSeek`。
3. 填写 `keepseek.apiKey`。
4. 如需使用代理或兼容网关，修改 `keepseek.baseUrl` 和 `keepseek.models`。

## 开发

```bash
npm install
npm run compile
npm run lint
```

在 VS Code 中打开本目录，按 `F5` 启动 Extension Development Host，然后执行：

```text
KeepSeek: Open Agent Chat
```

## 发布准备

当前发布版本为 `0.0.6`。VS Code 扩展的 `package.json` 必须使用 SemVer 格式，所以文件中写作 `0.0.6`，发布标签可以使用 `v0.0.6`。

生成 VSIX：

```bash
npm run compile
npx vsce package --no-dependencies
```

本地检查：

```bash
npm run lint
npx vsce ls
```

## KeepSeek English

KeepSeek is an AI coding context assistant for VS Code. It adds an Agent chat panel to the VS Code sidebar and makes it easy to send precise development context to AI: files, selected code, terminal output, Debug Console text, and Output panel logs.

The current release connects to DeepSeek OpenAI-compatible Chat Completions by default. It supports DeepSeek V4 Flash / Pro, Thinking mode, multi-turn sessions, rich file references, runtime log references, and a safe draft-edit workflow.

## Use Cases

- Understand unfamiliar repositories: add entry files, configuration files, and selected code so AI can explain structure and execution flow.
- Debug real failures: send terminal errors, failed test output, Debug Console text, or Output logs as context.
- Plan code changes: reference exact files and line ranges before asking for an implementation strategy.
- Work across files: gather related workspace or external files and keep the discussion grounded in the same context.
- Review build and test output: ask AI to summarize failures and suggest the next step.

## Who It Is For

- Independent developers who want a lightweight AI assistant inside VS Code.
- Engineering teams that need to share precise code and runtime context with AI.
- Developers joining a new project who need to understand code structure quickly.
- Maintainers and reviewers who want line-aware context and reviewable draft edits.
- Users of DeepSeek or OpenAI-compatible model gateways.

## Features

- Sidebar Agent chat inside VS Code Secondary Sidebar.
- Configurable model list with DeepSeek V4 Flash / Pro defaults.
- Thinking mode with `high` and `max` reasoning effort.
- Multi-turn chat history and session switching.
- File context from the active editor, workspace files, external files, directories, or typed paths.
- Precise file references from editor selections, including path, line, and column metadata.
- Runtime context references from terminal selections, Output panel selections, and Debug Console text.
- Drag-and-drop file references into the prompt composer.
- Safe DraftEdit workflow where AI proposes changes and the user confirms before writing files.
- Size limits and binary-file filtering to avoid sending unsuitable content.

## How It Works

KeepSeek is built around explicit context. You decide which files, selections, and logs AI can see.

1. Select code, files, terminal output, Output text, or Debug Console text.
2. Use the context menu or `Cmd+L` / `Ctrl+L` to insert it into the KeepSeek prompt.
3. Ask a question or request a change.
4. Review the response and any proposed DraftEdit.
5. Apply changes only after confirming them in VS Code.

## Shortcuts

| Shortcut | Condition | Command |
|----------|-----------|---------|
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | Editor text is selected | `keepseek.addSelectionToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | Explorer is focused on a file | `keepseek.addExplorerFileToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | Terminal text is selected | `keepseek.addTerminalSelectionToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | Debug Console is focused | `keepseek.addDebugConsoleSelectionToContext` |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `keepseek.apiKey` | `""` | DeepSeek API Key. `DEEPSEEK_API_KEY` can be used as a fallback |
| `keepseek.baseUrl` | `"https://api.deepseek.com"` | OpenAI-compatible API base URL |
| `keepseek.models` | DeepSeek V4 Flash / Pro | Models shown in the chat panel |
| `keepseek.thinkingEnabled` | `true` | Enables Thinking mode |
| `keepseek.reasoningEffort` | `"high"` | Thinking effort, either `high` or `max` |
| `keepseek.maxFileBytes` | `200000` | Maximum bytes for a referenced file or log snippet |

## Privacy And Safety

- KeepSeek reads only files, paths, and selections you explicitly add.
- External and dropped files are authorized before they can be expanded into a prompt.
- Common binary, media, image, and archive files are not expanded.
- AI-generated edits are shown as drafts and require user confirmation before writing.
- Terminal and Debug Console selections are stored as temporary `.log` files in the extension global storage directory so they can use the same reference expansion pipeline as files.

## Development

```bash
npm install
npm run compile
npm run lint
```

Launch the Extension Development Host with `F5`, then run:

```text
KeepSeek: Open Agent Chat
```

## Packaging

```bash
npm run compile
npx vsce package --no-dependencies
```
