# KeepSeek

KeepSeek 是一款面向 VS Code 的 AI 编程上下文助手。它把 Agent 对话面板放进 VS Code 侧边栏，让你可以把文件、选中代码、终端输出、调试控制台和 Output 面板里的关键内容快速加入上下文，再交给 AI 一起分析、解释和生成修改建议。

当前版本默认接入 DeepSeek OpenAI-compatible Chat Completions，支持 DeepSeek V4 Flash / Pro、Thinking 模式、多轮对话、跨项目 History Session 管理、文件/目录/Skills 引用、只读工作区搜索与行段读取、运行日志引用、用量/费用/余额统计，以及安全的修改草案确认流程。

**KeepSeek 是开源软件**，使用 [MIT 许可证](./LICENSE)。源码托管在 GitHub：**[https://github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek)**

English version is available below: [English](#keepseek-english).

## 适用场景

- 阅读陌生项目：选择入口文件、配置文件和关键代码片段，让 AI 帮你梳理模块关系、执行路径和风险点。
- 调试运行错误：把终端报错、测试失败输出、Debug Console 内容或 Output 面板日志加入上下文，让 AI 基于真实现场分析原因。
- 修改代码前做方案：引用相关文件和行号，让 AI 先解释影响范围，再生成可审阅的修改草案。
- 处理跨文件任务：把多个工作区文件或外部文件加入上下文，围绕同一需求持续对话。
- 延续跨项目排查：从其他项目复制已有 history session 到当前项目，在新的工作区里继续沿用排查思路和上下文线索。
- 沉淀重复工作流：把项目约定、排查步骤或团队提示词写成 KeepSeek Skill，按需加入当前对话。
- 复盘构建和测试：将编译输出、lint 结果、测试日志交给 AI，总结失败点和下一步动作。

## 适合谁

- 独立开发者：在一个轻量侧边栏里完成代码阅读、问题定位和方案讨论。
- 团队工程师：把真实代码和运行输出一并交给 AI，减少来回复制上下文的成本。
- 新加入项目的开发者：快速理解代码结构、约定和关键文件。
- 维护者和 Reviewer：围绕具体文件、行号、日志和修改草案做更精确的审查。
- 使用 DeepSeek V4 或兼容其 OpenAI Chat Completions 接口网关的开发者：可以配置 API base URL。

## 核心功能

- 侧边栏 Agent 对话：KeepSeek 显示在 VS Code Secondary Sidebar 中，适合一边看代码一边对话。
- DeepSeek V4 双模型：固定支持 Flash / Pro，切换模型和 Thinking 档位时自动应用对应的编程 Agent 参数。
- Thinking 模式：支持开启或关闭 Thinking，并选择 `high` / `max` 推理强度。
- History Session 管理：会话按项目保存到全局存储，支持当前项目和其他项目浏览、跨项目复制到当前项目、收藏、重命名、按时间范围过滤、多选删除和项目级清理。
- 文件上下文：添加当前文件、工作区文件、外部文件或目录，也可以手动输入路径。
- 精确文件引用：右键或快捷键添加编辑器选区，保留文件路径、行号和列号。
- 运行现场引用：终端、Output 面板和调试控制台中的选中内容可以作为 `.log` 引用插入输入框，发送前会展开给 AI。
- 拖拽文件引用：从 VS Code Explorer 或系统文件管理器拖入文件，自动生成可点击的引用 chip。
- 运行中止：Agent 正在推理或调用工具时，可以从输入区停止本次执行。
- 回复复制：Assistant 回复支持一键复制，便于保存或转发排查结果。
- 编辑器快捷键：底部输入框和消息编辑框共享 Emacs/macOS 风格文本快捷键。
- KeepSeek Skills：从工作区 `.agents` 和用户 `~/.codex/skills` 发现可复用工作流，支持选择启用、`$` 引用和创建 workspace skill 草案。
- 低成本工作区工具：Agent 可先搜索或列目录，再按行段读取文件，避免为了定位问题读取整份大文件。
- 用量统计：显示本次/会话 tokens、prompt cache 命中率、估算费用、上下文百分比和 DeepSeek 余额。
- 上下文压缩：长对话会使用"历史投影 + 会话摘要 + 关键消息保护 + 文件引用外化"组织模型输入，减少重复发送旧历史和展开后的大段文件正文。
- 调试 trace：可选开启结构化 JSONL 交互日志，便于排查请求、流式响应和工具循环问题。
- 安全修改草案：AI 只能创建待确认的 DraftEdit，用户点击 Apply 后还会经过 VS Code modal 确认再写入文件。
- 基础防护：限制单个上下文文件大小，跳过常见二进制、媒体、归档和不可读文件。

## History Session 管理

- 会话按项目维度写入全局存储。打开不同工作区时，KeepSeek 会自动回到该项目自己的历史会话。
- 历史菜单可以在"当前项目"和"其他项目"之间切换。选择其他项目中的 session 时，会复制出一条新的当前项目会话，原项目记录不会被改动。
- 当前项目会话支持收藏、重命名、按最近 N 天或全部过滤、只看收藏、多选删除；其他项目记录也支持按条删除或删除该项目全部记录。
- `keepseek.historyRetentionDays` 控制历史菜单默认显示的最近天数；存储层会对非当前活动会话执行 60 天硬保留清理。

## 上下文压缩

长对话里最浪费 token 的通常不是最近几句话，而是较早历史中反复出现的文件展开内容、日志片段、代码块和已经讨论过的细节。KeepSeek 的上下文压缩不会把摘要显示成真实聊天消息，而是在发送给模型前构造一个 projection：

- 保留系统提示、当前输入和最近若干用户轮次。
- 自动保护首条需求、最近输入、明确要求保留的约束、重要报错/测试失败、用户纠错和 DraftEdit 结果。
- 把较早、未保护、未进入最近窗口的历史压缩成会话摘要。
- 摘要只保留需求、决策、错误、文件路径、行段、函数名、已完成事项和待办，不保留旧历史里的大段文件正文。
- 当需要代码细节时，模型会通过现有只读工作区工具重新读取当前文件内容。

这带来的好处是：长会话下模型不再只能看到最近 24 条消息；它能同时看到摘要、关键保护消息和最近上下文。token 使用通常会更稳定，尤其是多次引用文件、拖入日志、展开大段代码之后。不过它不是保证每次都更省 token：如果对话本身很短，或没有可压缩的旧历史，KeepSeek 会保持接近原来的请求形态。

## Skills 与用量统计

- Skills 可以来自当前工作区的 `.agents` 或用户目录下的 `~/.codex/skills`。工作区 Skill 会遵守 VS Code Workspace Trust；不可用或被禁用的 Skill 不会进入模型上下文。
- 输入框支持 `/skills` 打开 Skills 列表，也支持 `/create-skill` 创建 `.agents/skills/<name>/SKILL.md` 草案。Skill 内容会作为当前请求上下文注入，但不能覆盖 KeepSeek 的安全规则。
- 当 prompt 中插入 `$` Skill 引用时，KeepSeek 会在发送前展开对应 `SKILL.md`，并保留引用来源，便于模型理解本轮需要遵循的工作流。
- 用量统计来自上游返回的 usage 数据和本地计价配置，显示本次/会话 tokens、cache hit/miss、估算费用、上下文百分比、压缩阈值和 DeepSeek 余额。
- trace 日志默认关闭。开启后会写入扩展全局存储目录，可能包含 prompt、文件内容、reasoning 内容和 DraftEdit 内容，适合调试时短期开启。

## 工作方式

KeepSeek 的核心是"显式上下文"。你选择哪些代码、文件或日志进入上下文，AI 就围绕这些材料回答，而不是猜测整个项目状态。

典型流程：

1. 在编辑器、资源管理器、终端、Output 或 Debug Console 中选择需要的内容。
2. 使用右键菜单或 `Cmd+L` / `Ctrl+L` 添加到 KeepSeek 输入框。
3. 输入问题或任务，例如"解释这个报错为什么发生"或"给出最小修改方案"。
4. AI 回复后，如果包含修改草案，你可以选择 Apply 或 Discard。
5. Apply 时 VS Code 会再次弹窗确认，确认后才写入文件。

## 快捷键

| 快捷键 | 条件 | 命令 |
|--------|------|------|
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 编辑器有选中文本 | `keepseek.addSelectionToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 资源管理器聚焦且选中文件 | `keepseek.addExplorerFileToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 资源管理器聚焦且选中目录 | `keepseek.addExplorerDirectoryToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 终端有选中文本 | `keepseek.addTerminalSelectionToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | 调试控制台聚焦 | `keepseek.addDebugConsoleSelectionToContext` |

扩展激活时会尝试把这些快捷键写入用户的 `keybindings.json`。如果已经存在对应绑定，则会跳过。

## 右键菜单

- 编辑器选区：`KeepSeek: 添加到上下文`
- Explorer 文件：`KeepSeek: Add Explorer File to Chat`
- Explorer 目录：`KeepSeek: Add Explorer Folder to Chat`
- 终端选区：`KeepSeek: 添加到上下文`
- Output 面板选区：`KeepSeek: 添加到上下文`

调试控制台可以使用 `Cmd+L` / `Ctrl+L` 添加当前选区。VS Code 对 Debug Console 原生右键菜单的扩展点较有限，因此快捷键是当前最稳定的入口。

## 配置项

| 配置键 | 默认值 | 说明 |
|--------|--------|------|
| `keepseek.apiKey` | `""` | DeepSeek API Key，也可用 `DEEPSEEK_API_KEY` 环境变量兜底 |
| `keepseek.baseUrl` | `"https://api.deepseek.com"` | OpenAI-compatible API base URL |
| `keepseek.selectedModelId` | `""` | 当前选中模型 id；为空或不可用时使用模型列表第一项 |
| `keepseek.thinkingEnabled` | `true` | 是否开启 Thinking 模式 |
| `keepseek.reasoningEffort` | `"high"` | Thinking 推理强度，支持 `high` 或 `max` |
| `keepseek.maxFileBytes` | `200000` | 单个引用文件或日志片段的最大字节数 |
| `keepseek.maxWorkspaceToolFiles` | `2000` | 只读工作区文件列表工具最多返回的文件数量 |
| `keepseek.usagePricing` | DeepSeek 默认价目 | 按模型配置每百万 token 的 cache hit、输入、输出价格和币种，用于费用估算 |
| `keepseek.balanceEndpointUrl` | `""` | DeepSeek 余额查询接口；为空时从 `baseUrl` 推导 `/user/balance` |
| `keepseek.balanceRefreshIntervalMs` | `60000` | 自动刷新余额的最小间隔 |
| `keepseek.slimToolModeEnabled` | `true` | 默认暴露较小稳定工具 schema，必要时再加入更宽的工作区工具 |
| `keepseek.maxRequestRetries` | `2` | 首个流式 chunk 前遇到可重试错误时的最大自动重试次数 |
| `keepseek.requestRetryBaseMs` | `1000` | 自动重试的指数退避基础延迟（毫秒） |
| `keepseek.trace.enabled` | `false` | 是否开启结构化交互 trace 日志；日志可能包含敏感上下文 |
| `keepseek.trace.level` | `"full"` | trace 级别：`metadata`、`request` 或 `full` |
| `keepseek.trace.logRawStream` | `true` | `trace.level` 为 `full` 时是否记录原始 SSE 流 |
| `keepseek.trace.retentionDays` | `7` | trace 日志保留天数 |
| `keepseek.trace.maxFileBytes` | `20000000` | 单个 trace 日志文件最大字节数 |
| `keepseek.historyRetentionDays` | `7` | 历史菜单默认显示最近天数，范围 1-60；存储记录仍按 60 天硬保留清理 |
| `keepseek.language` | `"zh-CN"` | KeepSeek UI 语言 |

### 自动编程档位

这些值是内部固定档位，不在用户设置中暴露。两款模型都使用 1M 上下文、`temperature=1.0`、`top_p=1.0`，并始终启用上下文压缩；更高 Thinking 档位会预留更多生成与工具空间，因此更早触发压缩。

| 模型 / 模式 | 最大输出 | 工具轮次 / 调用 | 最长运行 | 工具结果 | 最近原文轮次 | 摘要触发 / 强制 | 摘要输出 |
|---|---:|---:|---:|---:|---:|---:|---:|
| Flash / 非思考 | 48K | 16 / 48 | 10 分钟 | 160K | 14 | 58% / 72% | 6K |
| Flash / High | 96K | 24 / 72 | 20 分钟 | 240K | 12 | 54% / 68% | 8K |
| Flash / Max | 192K | 32 / 96 | 30 分钟 | 320K | 10 | 46% / 62% | 10K |
| Pro / 非思考 | 64K | 20 / 64 | 15 分钟 | 200K | 18 | 70% / 84% | 8K |
| Pro / High | 128K | 32 / 96 | 30 分钟 | 320K | 16 | 62% / 78% | 12K |
| Pro / Max | 256K | 48 / 144 | 60 分钟 | 400K | 12 | 50% / 70% | 16K |

## 隐私与安全

- KeepSeek 只读取你明确选择或添加的文件、路径和选区。
- 外部文件和拖拽文件需要经过扩展授权记录后才会在发送前展开。
- 图片、媒体、归档和常见二进制文件不会被展开到 prompt。
- AI 生成的文件修改不会静默写入。所有修改都以 DraftEdit 形式展示，并由用户确认后执行。
- 终端和调试控制台选区会以临时 `.log` 文件形式存储在扩展全局存储目录中，用于复用现有文件引用展开机制。

## 安装与使用

从 VSIX 安装：

```bash
code --install-extension keepseek-0.1.3.vsix
```

VS Code 1.127.0 可能输出 DEP0169 warning，这是 VS Code CLI 内部警告，安装成功不受影响。

安装后在 VS Code 中执行：

```text
KeepSeek: Open Agent Chat
```

配置 API Key：

1. 打开 VS Code Settings。
2. 搜索 `KeepSeek`。
3. 填写 `keepseek.apiKey`。
4. 如需使用代理或兼容网关，修改 `keepseek.baseUrl`。

## 开发

```bash
npm install
npm run compile
npm run lint
```

源码按功能类型组织：

- `src/extension.ts`：VS Code 激活入口、命令注册和 Provider 接线。
- `src/provider/`：WebviewView Provider、Webview 消息类型和视图聚焦工具。
- `src/agent/`：Agent 运行循环、DeepSeek/OpenAI-compatible 协议、SSE/DSML 解析、上下文投影/压缩、上下文用量估算和只读工具。
- `src/skills/`：KeepSeek Skills 的发现、加载、状态管理和 Skill 草案创建。
- `src/sessions/`：当前项目和跨项目 History Session 存储、迁移和保留策略。
- `src/context/`：上下文文件、终端/输出/调试选区引用，以及 prompt 文件/目录/Skill 引用展开。
- `src/edits/`：DraftEdit 状态和用户确认后的安全写入。
- `src/shared/`：配置、类型、国际化、格式化、Markdown 和文本文件判断等共享基础设施。
- `src/webview/`：Webview HTML/CSS/JS 字符串和输入区实现。

在 VS Code 中打开本目录，按 `F5` 启动 Extension Development Host，然后执行：

```text
KeepSeek: Open Agent Chat
```

## 发布准备

当前发布版本为 `0.1.3`。VS Code 扩展的 `package.json` 必须使用 SemVer 格式，所以文件中写作 `0.1.3`，发布标签可以使用 `v0.1.3`。

生成 VSIX：

```bash
npm run package
```

本地检查：

```bash
npm run compile
npm run lint
npx vsce ls
```

发布到 VS Code Marketplace：

```bash
VSCE_PAT=<token> npm run publish:marketplace
```

## 许可证

KeepSeek 使用 [MIT 许可证](./LICENSE)。

```
MIT License

Copyright (c) 2026 kmvdata

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## KeepSeek English

KeepSeek is an AI coding context assistant for VS Code. It adds an Agent chat panel to the VS Code sidebar and makes it easy to send precise development context to AI: files, selected code, terminal output, Debug Console text, and Output panel logs.

The current release connects to DeepSeek OpenAI-compatible Chat Completions by default. It supports DeepSeek V4 Flash / Pro, Thinking mode, multi-turn sessions, cross-project history session management, file/directory/Skill references, read-only workspace search and range reads, runtime log references, usage/cost/balance stats, and a safe draft-edit workflow.

**KeepSeek is open source** under the [MIT license](./LICENSE). Source code is available on GitHub: **[https://github.com/kmvdata/keepseek](https://github.com/kmvdata/keepseek)**

## Use Cases

- Understand unfamiliar repositories: add entry files, configuration files, and selected code so AI can explain structure and execution flow.
- Debug real failures: send terminal errors, failed test output, Debug Console text, or Output logs as context.
- Plan code changes: reference exact files and line ranges before asking for an implementation strategy.
- Work across files: gather related workspace or external files and keep the discussion grounded in the same context.
- Continue across projects: copy a history session from another project into the current workspace and keep using the same investigation thread.
- Reuse workflows: turn project conventions, investigation steps, or team prompts into KeepSeek Skills and add them to a chat when needed.
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
- History session management with project-scoped global storage, current-project and other-project browsing, cross-project copy into the current project, favorites, rename, time-range filtering, multi-select delete, and project-level cleanup.
- File context from the active editor, workspace files, external files, directories, or typed paths.
- Precise file references from editor selections, including path, line, and column metadata.
- Runtime context references from terminal selections, Output panel selections, and Debug Console text.
- Drag-and-drop file references into the prompt composer.
- Abort control for stopping an in-progress Agent run.
- One-click copy for assistant replies.
- Shared Emacs/macOS-style text shortcuts in the prompt composer and message edit boxes.
- KeepSeek Skills discovered from workspace `.agents` and user `~/.codex/skills`, with active selection, `$` references, and workspace skill draft creation.
- Low-cost workspace tools so the Agent can search or list first, then read targeted file ranges instead of full large files.
- Usage stats for turn/session tokens, prompt-cache hit rate, estimated cost, context percentage, and DeepSeek balance.
- Context compression that projects long chat history into summaries, protected messages, recent turns, and file-reference hints instead of repeatedly sending old expanded file bodies.
- Optional structured trace logs for debugging requests, streaming responses, and tool loops.
- Safe DraftEdit workflow where AI proposes changes and the user confirms before writing files.
- Size limits and binary-file filtering to avoid sending unsuitable content.

## History Session Management

- Sessions are stored globally while remaining scoped to each workspace, so reopening a project restores that project's own history.
- The history menu can switch between the current project and other projects. Opening a session from another project copies it into the current workspace as a new session without changing the source project.
- Current-project sessions support favorite, rename, recent-days or all-time filtering, favorites-only filtering, and multi-select deletion. Other-project records can be deleted by session or cleared for the whole project.
- `keepseek.historyRetentionDays` controls the default recent-days range in the menu; stored non-active sessions are hard-pruned after 60 days.

## Context Compression

In long chats, the expensive part is often not the latest question. It is older expanded files, logs, code blocks, and repeated details. KeepSeek compresses context by building a model-only projection before each request; the summary is not inserted into the visible chat transcript.

- Keep the system prompt, current input, and recent user turns.
- Protect the first request, latest input, explicit "remember this" constraints, important errors/test failures, user corrections, and DraftEdit results.
- Summarize older, unprotected messages that no longer fit in the recent window.
- Preserve goals, decisions, errors, file paths, line ranges, symbols, completed work, and todos instead of old expanded file bodies.
- Ask the model to reread current workspace files through KeepSeek's read-only tools when code details matter.

This usually reduces token pressure in long sessions and avoids losing the original goal when the newest-message window moves forward. It does not guarantee fewer tokens for every request: short chats or chats with little compressible history stay close to the original request shape.

## Skills And Usage

- Skills can come from workspace `.agents` or user `~/.codex/skills`. Workspace Skills respect VS Code Workspace Trust; unavailable or disabled Skills are not added to model context.
- Use `/skills` to browse Skills or `/create-skill` to create a `.agents/skills/<name>/SKILL.md` draft. Skill content is injected as current-run context and cannot override KeepSeek safety rules.
- `$` Skill references in the prompt are expanded before send, preserving their source so the model can follow the requested workflow for that run.
- Usage stats combine upstream usage data with local pricing config to show turn/session tokens, cache hit/miss, estimated cost, context percentage, compaction threshold, and DeepSeek balance.
- Trace logs are off by default. When enabled, they are written under extension global storage and may include prompts, file contents, reasoning content, and DraftEdit content.

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
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | Explorer is focused on a directory | `keepseek.addExplorerDirectoryToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | Terminal text is selected | `keepseek.addTerminalSelectionToContext` |
| `Cmd+L` (Mac) / `Ctrl+L` (Windows/Linux) | Debug Console is focused | `keepseek.addDebugConsoleSelectionToContext` |

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `keepseek.apiKey` | `""` | DeepSeek API Key. `DEEPSEEK_API_KEY` can be used as a fallback |
| `keepseek.baseUrl` | `"https://api.deepseek.com"` | OpenAI-compatible API base URL |
| `keepseek.selectedModelId` | `""` | Persisted selected model id; falls back to the first configured model |
| `keepseek.thinkingEnabled` | `true` | Enables Thinking mode |
| `keepseek.reasoningEffort` | `"high"` | Thinking effort, either `high` or `max` |
| `keepseek.maxFileBytes` | `200000` | Maximum bytes for a referenced file or log snippet |
| `keepseek.maxWorkspaceToolFiles` | `2000` | Maximum number of files returned by the read-only workspace file listing tool |
| `keepseek.usagePricing` | DeepSeek defaults | Per-million-token cache-hit, input, output prices and currency by model id |
| `keepseek.balanceEndpointUrl` | `""` | DeepSeek balance endpoint; empty derives `/user/balance` from `baseUrl` |
| `keepseek.balanceRefreshIntervalMs` | `60000` | Minimum automatic balance refresh interval |
| `keepseek.slimToolModeEnabled` | `true` | Exposes a smaller stable tool schema by default and adds broader workspace tools only when needed |
| `keepseek.maxRequestRetries` | `2` | Automatic retry count for replay-safe failures before the first stream chunk |
| `keepseek.requestRetryBaseMs` | `1000` | Exponential backoff base delay in milliseconds |
| `keepseek.trace.enabled` | `false` | Enables structured interaction trace logs; logs may include sensitive context |
| `keepseek.trace.level` | `"full"` | Trace detail level: `metadata`, `request`, or `full` |
| `keepseek.trace.logRawStream` | `true` | Records raw SSE lines when `trace.level` is `full` |
| `keepseek.trace.retentionDays` | `7` | Trace log retention in days |
| `keepseek.trace.maxFileBytes` | `20000000` | Maximum bytes for one trace log file |
| `keepseek.historyRetentionDays` | `7` | Default recent-days range in the history menu, from 1 to 60; stored records still use the 60-day hard retention limit |
| `keepseek.language` | `"zh-CN"` | KeepSeek UI language |

### Automatic coding profiles

These are fixed internal profiles rather than user settings. Both models use a 1M context window, `temperature=1.0`, `top_p=1.0`, and always-on context compression. Higher Thinking modes reserve more generation and tool capacity, so they compact earlier.

| Model / mode | Max output | Tool rounds / calls | Max run | Tool results | Recent verbatim turns | Summary trigger / force | Summary output |
|---|---:|---:|---:|---:|---:|---:|---:|
| Flash / Non-thinking | 48K | 16 / 48 | 10 min | 160K | 14 | 58% / 72% | 6K |
| Flash / High | 96K | 24 / 72 | 20 min | 240K | 12 | 54% / 68% | 8K |
| Flash / Max | 192K | 32 / 96 | 30 min | 320K | 10 | 46% / 62% | 10K |
| Pro / Non-thinking | 64K | 20 / 64 | 15 min | 200K | 18 | 70% / 84% | 8K |
| Pro / High | 128K | 32 / 96 | 30 min | 320K | 16 | 62% / 78% | 12K |
| Pro / Max | 256K | 48 / 144 | 60 min | 400K | 12 | 50% / 70% | 16K |

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

Source code is grouped by feature area:

- `src/extension.ts`: VS Code activation, command registration, and Provider wiring.
- `src/provider/`: WebviewView Provider, Webview message types, and view focus helpers.
- `src/agent/`: Agent run loop, DeepSeek/OpenAI-compatible protocol, SSE/DSML parsing, history projection/compression, context usage estimation, and read-only tools.
- `src/skills/`: KeepSeek Skills discovery, loading, state management, and skill draft creation.
- `src/sessions/`: Current-project and cross-project History Session storage, migration, and retention.
- `src/context/`: Context files, terminal/output/debug references, and prompt file/directory/Skill reference expansion.
- `src/edits/`: DraftEdit state and safe user-confirmed writes.
- `src/shared/`: Shared config, types, i18n, formatting, Markdown, and text-file guards.
- `src/webview/`: Webview HTML/CSS/JS strings and prompt input implementation.

Launch the Extension Development Host with `F5`, then run:

```text
KeepSeek: Open Agent Chat
```

## Packaging

```bash
npm run package
```

Publish to VS Code Marketplace:

```bash
VSCE_PAT=<token> npm run publish:marketplace
```

## License

KeepSeek is open source under the [MIT license](./LICENSE).

```
MIT License

Copyright (c) 2026 kmvdata

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
