# KeepSeek Agent Runtime 工作流程与核心功能说明

本文面向 KeepSeek 的维护者和需要理解运行机制的使用者，梳理 KeepSeek 在重构后作为 VS Code 侧边栏 Agent 的主要工作流程、核心功能边界和关键安全规则。本文以当前源码为准，不沿用旧版假设。

KeepSeek 的本质是一个 VS Code 扩展内的轻量 coding agent runtime。扩展端负责会话、上下文、引用展开、本地只读工具、模型请求循环、预算控制、trace 记录和 DraftEdit 待确认写入；云端模型负责语言理解、推理、工具选择、参数生成和最终回复生成。

## 1. 总体架构

KeepSeek 的 Agent 链路可以分成四层。

| 层级 | 主要模块 | 职责 |
|---|---|---|
| Webview 表现层 | `src/webview/*`、`src/webview/input/*` | 输入框、消息列表、引用 chip、设置弹窗、活动状态文案、发送/停止交互 |
| Provider 编排层 | `src/provider/KeepseekChatViewProvider.ts` | 接收 Webview 消息、维护 busy 状态、会话接线、引用授权、调用业务服务和 Agent Runtime |
| Agent Runtime 层 | `src/agent/agentRequestCoordinator.ts`、`src/agent/runner.ts`、`src/agent/protocol.ts`、`src/agent/historyProjection.ts`、`src/agent/historyCompressor.ts`、`src/agent/contextUsage.ts`、`src/agent/deepseek/*` | 构造请求、上下文压缩与历史投影、上下文用量估算、流式调用 DeepSeek/OpenAI-compatible API、执行工具循环、预算控制、结果整理 |
| 本地能力层 | `src/agent/tools/workspaceTools.ts`、`src/edits/*`、`src/context/*`、`src/sessions/*` | 只读工作区工具、引用展开、DraftEdit 安全写入、上下文文件、会话和压缩状态持久化 |

几个边界很重要：

- Provider 只做协调，不直接承载可独立测试的大块业务逻辑。
- `AgentRunner` 只负责编排模型请求、工具调用循环和最终响应整理。
- 上下文压缩属于 Agent Runtime 层：`AgentRequestCoordinator` 负责压缩刷新调度和 AgentRequest 组装，`HistoryCompressor` 负责摘要刷新，`historyProjection` 负责把真实会话投影成模型请求历史，`contextUsage` 使用同一套投影估算上下文窗口占用。Provider 只触发协调器，Session 存储只负责保存真实消息和 `contextCompression` 状态。
- 工作区工具保持只读，不能写磁盘。
- AI 不能直接修改文件，只能创建 DraftEdit。
- 真正写入磁盘只发生在用户点击 Apply 后，由 `SafeFileEditor` 执行。

## 2. 一次 Agent 请求的完整流程

### 2.1 Webview 收集输入

用户在输入框中输入自然语言，也可以通过这些方式插入上下文引用：

- 当前编辑器文件或选区。
- Explorer 右键添加文件。
- Explorer 右键添加目录。
- 拖拽文件到输入框。
- 终端、输出、Debug Console 选区落盘后引用。
- `@` 文件/目录补全。

Webview 内部使用富文本输入框显示引用 chip。发送时，`serializePrompt()` 会把 DOM 里的引用还原成可解析的文本格式：

```text
文件名 (第N-M行) <路径#LN-LM>
目录名/ <keepseek-dir:路径>
```

如果当前 `state.isBusy` 为 true，普通提交不会开启第二个任务，而是提示当前任务运行中。只有用户明确点击停止按钮时，才会发送 `abortPrompt` 中止当前运行。

### 2.2 Provider 准备运行状态

Webview 发送 `{ type: 'sendPrompt', ... }` 后，Provider 的 `handleMessage()` 分发到 `sendPrompt()`。

Provider 会完成这些本地准备：

1. 检查当前是否 busy。
2. 解析模型配置和 Agent 设置。
3. 创建 `AbortController`。
4. 记录 prompt 中外部引用的授权集合。
5. 设置活动状态为 `preparing`、`expanding_references`。
6. 调用 `expandPromptReferencesInPrompt()` 展开文件/目录引用。
7. 将用户消息写入当前会话。
8. best-effort 调用 `AgentRequestCoordinator.refreshContextCompressionBeforeRun()`。只有当前会话没有可用摘要且 raw 历史估算接近上下文窗口时，才会发送前同步刷新摘要；其它可刷新场景会留到本轮完成后的后台刷新。
9. 创建 streaming assistant 消息，用来显示流式输出。
10. 通过 `AgentRequestCoordinator.createAgentRequest()` 组装请求并调用 `AgentRunner.run()`。
11. 本轮完成后，`AgentRequestCoordinator.scheduleBackgroundContextCompressionRefresh()` 可在后台刷新摘要。后台刷新按 session 去重，并在写回前检查消息位置，避免编辑重发或会话变化后用旧摘要覆盖新历史。

Provider 不直接执行模型工具，也不直接管理 DraftEdit 写入细节。它只是把 UI、会话状态和底层服务串起来。

### 2.3 Prompt 引用展开

发送给模型前，Provider 会先展开 prompt 中的引用。

文件引用由 `context/references/fileReference.ts` 处理：

- 支持 `<path>`、`<path#Lx-Ly>`、`<path#LxCy-LmCn>`。
- 工作区内文件可直接展开。
- 外部文件必须先授权。
- 图片、媒体、归档、常见二进制扩展会跳过。
- 全文引用受 `keepseek.maxFileBytes` 限制。
- 行段引用会读取指定行列范围并包装为 Markdown 代码块。

目录引用由 `context/references/directoryReference.ts` 处理：

- 支持 `<keepseek-dir:path>`。
- 不展开整个目录内容。
- 展开为目录锚点、使用说明和受限条目清单。
- 如果模型需要更多细节，应继续调用只读工作区工具。

引用展开的设计目标是：用户显式提供的上下文优先进入模型，但避免把整个目录或不可读文件一次性塞进 prompt。

## 3. AgentRunner 主循环

`AgentRunner.run()` 是 Agent runtime 的核心。它负责把一次用户请求转换为一轮或多轮模型请求。

### 3.1 构造上下文投影与初始 messages

`AgentRunner.run()` 在请求模型前会先调用 `src/agent/historyProjection.ts` 的 `buildHistoryProjection()`。这是上下文压缩进入模型请求的核心边界：真实的 `session.messages` 不会被替换成摘要，也不会因为上下文窗口限制被硬裁剪；Runner 只为本次模型请求构造 projection。

上下文压缩始终启用，projection 由这些部分组成：

1. 可选 synthetic summary system message，来自 `ChatSession.contextCompression.summaries`。
2. protected messages，包括首条用户需求、最近用户请求、显式保留约束、用户纠错、明显报错或测试失败、DraftEdit 关键结果等。
3. 当前模型 / Thinking 自动档位要求保留的最近用户轮次及其后续 assistant 回复。
4. 当前展开后的用户 prompt。

之后 `src/agent/protocol.ts` 的 `buildInitialAgentMessages()` 会把 projection 组装成 DeepSeek/OpenAI-compatible messages：

1. system prompt，包含 Agent 规则和用户显式加入的 context files。
2. synthetic summary system message。
3. projection 选中的历史消息。
4. 当前展开后的用户 prompt，如果它还没有作为最后一条 user message 出现在 projection 中。

system prompt 会告诉模型：

- KeepSeek 是 VS Code 侧边栏 coding agent。
- 可以使用只读工作区工具查看项目。
- 推荐低成本探索：先 search/list 定位，再 range read 读取片段。
- 只有小文件或确实需要完整上下文时才全文 read。
- 修改文件必须调用 DraftEdit 工具。
- 工具只创建待确认修改，不能声称已经写盘。

### 3.2 调用模型

`createChatCompletion()` 负责发送 DeepSeek/OpenAI-compatible Chat Completions 请求。

请求特征：

- 使用 streaming。
- 仅支持 `deepseek-v4-flash` 和 `deepseek-v4-pro`。
- Thinking 开关和 `high` / `max` reasoning effort 由输入区选择。
- `max_tokens`、工具上限、运行时长与压缩阈值来自 `src/shared/modelProfiles.ts` 中对应的模型 / Thinking 自动档位。
- 固定使用 DeepSeek V4 推荐的 `temperature=1.0`、`top_p=1.0`。
- `stream_options.include_usage = true`，用于获取服务商真实 usage。
- 有工具预算时发送 function tools 和 `tool_choice: "auto"`。

流式响应由 `DeepSeekClient` 和 `DeepSeekStreamParser` 处理。Parser 会解析：

- `content`：可见回答。
- `reasoning_content`：Thinking 内容。
- streaming `tool_calls`：模型请求的工具名和参数。
- `finish_reason`。
- `usage`。

如果请求在已有 partial output 后失败，Runner 会尝试发起续写恢复。如果模型返回 `finish_reason=length` 且满足条件，Runner 会请求一次受限续写。

### 3.3 工具调用循环

模型可能返回一个或多个 function tool calls。Runner 的工具循环是：

```text
请求模型
  -> 模型返回文本或 tool_calls
  -> 若无工具，整理最终回答
  -> 若有工具，本地执行工具
  -> 对工具结果做 shaping
  -> 将 shaped result 作为 role=tool 消息加入 messages
  -> 再次请求模型
```

循环上限由 `src/shared/modelProfiles.ts` 的 6 个自动档位控制（Flash / Pro × 非思考 / High / Max）。更强的模型和推理档位允许更多工具轮次、调用数、运行时间及工具结果；这些值不暴露为用户配置。两款模型的上下文窗口都固定按 1M tokens 估算。

如果自动安全上限耗尽，Runner 会追加一条本地用户消息，要求模型停止调用工具，基于已获得的信息给出最终回答并说明缺口。

### 3.4 DSML 工具调用兜底

如果模型没有返回原生 `tool_calls`，但在文本里输出了 DSML 风格的工具调用块，`DsmlToolParser` 会尝试解析并模拟成 function tool call 执行。

这只是兼容兜底，不是 MCP，也不是外部工具运行时。优先路径仍然是 OpenAI-compatible function calling。

## 4. 当前可用工具

当前工具 schema 由 `getAgentTools()` 提供，工具路由在 `AgentRunner.handleToolCall()` 中，工作区工具实现主要在 `WorkspaceToolService` 中。

| 工具名 | 类型 | 用途 |
|---|---|---|
| `keepseek_search_workspace` | 只读 | 搜索工作区文本，返回命中行和前后上下文 |
| `keepseek_list_workspace_files` | 只读 | 列出当前工作区文件 |
| `keepseek_list_workspace_directory` | 只读 | 列出指定工作区目录，可选递归 |
| `keepseek_read_workspace_file_range` | 只读 | 按 1-based inclusive 行号读取文件片段 |
| `keepseek_read_workspace_file` | 只读 | 读取小文件全文 |
| `keepseek_create_draft_edit` | 待确认修改 | 创建 DraftEdit，不直接写磁盘 |

### 4.1 `keepseek_search_workspace`

搜索工具的目标是低成本定位相关代码。

参数：

| 参数 | 说明 |
|---|---|
| `query` | 必填，搜索文本或正则 |
| `path` | 可选，限定到工作区内文件或目录 |
| `include` | 可选，工作区相对 glob，例如 `src/**/*.ts` |
| `isRegex` | 可选，默认 false |
| `matchCase` | 可选，默认 false |
| `maxResults` | 可选，默认 50，内部上限 200 |

实现原则：

- 优先调用 VS Code 运行时的 `workspace.findTextInFiles`。
- 不引入 ripgrep 或 npm 依赖。
- 搜索范围必须在当前工作区内。
- 跳过 `.git`、`node_modules`、`dist`、`coverage` 等目录。
- 结果上下文默认前后各 2 行。
- 长行会截断并标记。
- 返回结果总字符数有上限，避免把搜索结果撑爆上下文。

返回结果包含：

```json
{
  "ok": true,
  "query": "xxx",
  "results": [
    {
      "path": "src/example.ts",
      "uri": "file:///...",
      "line": 12,
      "startColumn": 5,
      "endColumn": 18,
      "matchLine": "命中所在行",
      "matchLineTruncated": false,
      "before": [{ "line": 10, "text": "...", "truncated": false }],
      "after": [{ "line": 13, "text": "...", "truncated": false }]
    }
  ],
  "count": 1,
  "limit": 50,
  "truncated": false,
  "excluded": [".git", "node_modules"]
}
```

### 4.2 `keepseek_read_workspace_file_range`

范围读取工具用于在定位后读取相关片段，尤其适合大文件。

参数：

| 参数 | 说明 |
|---|---|
| `path` | 必填，工作区内路径 |
| `startLine` | 必填，1-based inclusive |
| `endLine` | 必填，1-based inclusive |
| `maxBytes` | 可选，返回内容字节上限 |

实现原则：

- 复用工作区内路径解析和越界校验。
- 复用文本/二进制保护规则。
- `startLine >= 1`，`endLine >= startLine`。
- 对最大行数和返回字节数做内部限制。
- 本地 `file` scheme 优先流式扫描，避免为了读片段而整文件载入内存。
- 非 `file` scheme 使用保守 fallback，文件过大时拒绝。
- 不因为整个文件大于 `keepseek.maxFileBytes` 就拒绝，只控制返回内容大小。

返回结果包含：

```json
{
  "ok": true,
  "path": "src/example.ts",
  "uri": "file:///...",
  "languageId": "typescript",
  "content": "指定行段内容",
  "startLine": 100,
  "endLine": 180,
  "requestedStartLine": 100,
  "requestedEndLine": 220,
  "totalLines": 560,
  "truncated": true,
  "sizeBytes": 123456
}
```

### 4.3 `keepseek_read_workspace_file`

全文读取工具仍然保留，但策略已经变成“只适合小文件或确实需要完整上下文时使用”。

它会拒绝：

- 工作区外路径。
- 非普通文件。
- 图片、媒体、归档、常见二进制扩展。
- 看起来不是可读文本的内容。
- 超过 `keepseek.maxFileBytes` 的全文读取。

当文件超过全文读取上限时，返回结构化错误，并建议模型改用范围读取：

```json
{
  "ok": false,
  "path": "src/large.ts",
  "sizeBytes": 500000,
  "limitBytes": 200000,
  "suggestedTool": "keepseek_read_workspace_file_range",
  "suggestedRange": {
    "path": "src/large.ts",
    "startLine": 1,
    "endLine": 200
  }
}
```

### 4.4 `keepseek_list_workspace_files`

文件列表工具用于快速了解项目文件分布。它通过 VS Code `workspace.findFiles` 实现，并跳过常见依赖、构建、覆盖率和 VCS 目录。

结果包括：

- `path`
- `label`
- `workspaceFolder`
- `sizeBytes`
- `size`
- `extension`
- `count`
- `limit`
- `truncated`
- `excluded`

### 4.5 `keepseek_list_workspace_directory`

目录列表工具用于在用户引用目录或 search 命中目录后进一步探索。

特点：

- 路径必须在当前工作区内。
- 可选递归。
- 递归深度和返回条目数有限制。
- 跳过 `.git`、`node_modules`、`dist` 等目录。
- 返回文件和目录两类 entry。

### 4.6 `keepseek_create_draft_edit`

DraftEdit 工具是唯一和“写文件”相关的模型工具，但它本身不写磁盘。

模型需要提供：

| 参数 | 说明 |
|---|---|
| `path` | 目标文件路径 |
| `content` | 完整的新文件内容 |
| `reason` | 展示给用户的简短原因 |

Runner 创建 DraftEdit 后，会把它交给 Provider/Webview 展示。用户点击 Apply 前，本地文件不会被修改。

## 5. 工具结果控制

为了避免工具结果吞掉上下文，Runner 在工具结果进入 messages 前会做 deterministic shaping。

### 5.1 shaping 发生的位置

工具执行后先得到 raw result。Runner 会：

1. 记录 raw result 的摘要到 trace，避免重复写入大型 payload。
2. 对部分工具结果做 shaping。
3. 使用 shaped result 估算 token 预算。
4. 将 shaped result 作为 `role: "tool"` 消息追加到 messages。

因此，模型实际看到的是 shaped result，而不是未经控制的 raw payload。

### 5.2 search result shaping

搜索结果会限制：

- 总命中数。
- 每个文件代表性命中数。
- 单行字符数。
- 总字符数。

返回中会保留：

- `limit`
- `truncated`
- `perFileLimit`
- `totalCharLimit`

这样模型知道结果可能被截断，可以继续缩小 query 或 path 后搜索。

### 5.3 range read shaping

范围读取本身已经按字节控制返回内容。Runner 还会对进入消息的内容做字符上限保护，并保留：

- `startLine`
- `endLine`
- `requestedStartLine`
- `requestedEndLine`
- `totalLines`
- `truncated`

模型可以据此继续读取下一段或更精确的范围。

### 5.4 full read 不随意压缩

全文读取工具只面向小文件。小文件全文结果保持精确返回，不做随意压缩。这对后续生成 DraftEdit 很重要，因为模型可能需要完整原文来构造完整新文件。

## 6. Tool Result Ledger 与 usage

Runner 内部维护第一版 `toolResultLedger`。它不改变对外 `AgentResponse` 类型，只写入 trace。

每条 ledger 记录：

- `toolName`
- `path`
- `startLine`
- `endLine`
- `estimatedTokens`
- `rawLength`
- `shapedLength`
- `compressible`
- `truncated`

这用于调试和后续校准工具结果预算。

真实 usage 也只做小步接入。因为请求已设置 `stream_options.include_usage = true`，Parser 能拿到 provider 返回的 usage。Runner 会汇总：

- request count
- prompt tokens
- completion tokens
- total tokens
- 原始 usage records

这些记录只进入 trace，不改变 Webview 的上下文估算模型。当前上下文 UI 仍使用本地轻量估算，不引入 `tiktoken`。

## 7. DraftEdit 安全写入流程

KeepSeek 的写入安全边界是它区别于普通自动写文件 agent 的关键部分。

### 7.1 创建 DraftEdit

模型调用 `keepseek_create_draft_edit` 时，Runner 只创建内存中的 `DraftEdit`：

```ts
{
  id,
  uri,
  label,
  action,
  newText,
  reason
}
```

这个 DraftEdit 会显示在 Webview 的 pending changes 区域。此时磁盘没有变化。

### 7.2 用户确认 Apply

用户点击 Apply 后，Provider 调用 `DraftEditStore`，再由 `SafeFileEditor` 执行写入。

写入前会检查：

- 目标文件是否有未保存 dirty editor/tab。
- 目标 URI 是否可写。
- DraftEdit action 是 create/modify/delete/move 中的哪一种。

当前主要行为是确认后的整文件写入。未来如果要做 diff、冲突检测、备份或权限确认，应优先扩展 `edits/safeFileEditor.ts` 和 `edits/draftEditStore.ts`，不要把写入逻辑放进 `AgentRunner`。

### 7.3 用户可见语义

模型和最终回答必须遵守这个语义：

- 可以说“已准备待确认修改”。
- 不能说“已写入文件”。
- 只有用户 Apply 成功后，扩展端才会追加“已写入”的 assistant 消息。

## 8. 活动状态与 UI 反馈

Agent runtime 会通过 `AgentRunCallbacks.onStatus` 向 Provider 报告活动状态。Provider 再把状态推给 Webview。

主要 phase 包括：

| phase | 含义 |
|---|---|
| `preparing` | 准备请求 |
| `expanding_references` | 展开引用 |
| `requesting_model` | 等待模型响应 |
| `reasoning` | 接收 Thinking |
| `generating` | 接收可见正文 |
| `planning_tool` | 模型准备调用工具 |
| `searching_workspace` | 执行搜索工具 |
| `listing_files` | 列文件 |
| `listing_directory` | 列目录 |
| `reading_file_range` | 读取文件片段 |
| `reading_file` | 读取完整文件 |
| `creating_draft_edit` | 创建 DraftEdit |
| `reviewing_tool_result` | 工具结果回灌后继续推理 |
| `finalizing` | 整理最终回答 |
| `failed` | 失败 |

Webview 会把 phase 映射成中英文状态文案，例如“搜索工作区...”和“读取文件片段...”。

## 9. Trace 与调试

开启 `keepseek.trace.enabled` 后，`InteractionTraceLogService` 会在全局存储下写 JSONL 日志。

trace 记录包括：

- run start / finish / error。
- 初始化后的 agent messages。
- 上游请求摘要。
- 上游响应 message。
- usage 和 usage totals。
- tool call。
- raw tool result 摘要。
- shaped tool result 或摘要。
- toolResultLedger。

trace level 控制 payload 细节：

- `metadata`：主要记录生命周期和大小。
- `request`：记录请求和组装后的响应消息 payload。
- `full`：还可记录 raw stream。

工具结果控制后，大型 raw payload 不会被无脑重复写入 trace 的 raw/result 两处，降低日志膨胀风险。

## 10. 推荐的 Agent 工作方式

重构后的 KeepSeek 更适合采用“先定位、再读取、再修改”的工作模式。

### 10.1 理想探索流程

```text
用户提出任务
  -> search_workspace 搜关键词/符号/文件名线索
  -> list_workspace_directory 查看相关目录结构
  -> read_workspace_file_range 读取命中片段和附近实现
  -> 必要时读取小文件全文
  -> 生成解释、方案或 DraftEdit
```

这比“列出全项目文件，再读取一堆完整文件”更省 token，也更不容易触发上下文或工具结果预算。

### 10.2 适合 search 的场景

- 查函数、类、配置 key、错误文案。
- 查某个 message type 或工具名。
- 查 CSS class、DOM id、命令 id。
- 查 TODO、测试名、导出符号。

### 10.3 适合 range read 的场景

- search 命中后读取上下文。
- 大文件中只需要某个函数或配置段。
- 模型需要继续读取某段之前或之后的内容。
- 全文 read 返回 `suggestedTool` 时。

### 10.4 适合 full read 的场景

- 小文件。
- 修改时确实需要完整文件内容。
- 生成完整 DraftEdit 前需要完整原文。

## 11. 当前边界和后续扩展方向

当前版本已经具备轻量 Agent runtime 的核心能力：

- 流式模型请求。
- 工具调用循环。
- 只读工作区工具。
- 搜索和范围读取。
- 工具预算和结果 shaping。
- DraftEdit 安全写入。
- trace 和 usage 记录。

仍未覆盖的方向：

- Session summary。
- 模型辅助摘要。
- 队列 prompt。
- MCP。
- shell/test/lint/git 工具。
- 局部 diff/patch 写入。
- 自动测试验证循环。
- 更细的 provider capability profile。

这些能力后续可以逐步扩展，但应继续遵守当前分层：Provider 只编排，AgentRunner 管请求循环，工作区工具保持只读，写入仍只走 DraftEdit。
