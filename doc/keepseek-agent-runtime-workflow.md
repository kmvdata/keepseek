# KeepSeek Agent Runtime 工作流程与核心功能说明

本文面向 KeepSeek 的维护者和需要理解运行机制的使用者，梳理 KeepSeek 在重构后作为 VS Code 侧边栏 Agent 的主要工作流程、核心功能边界和关键安全规则。本文以当前源码为准，不沿用旧版假设。

子代理的运行期工具闸门、proposal 路径租约、类型化签收、结果复用、按 profile 模型和脱敏进度/诊断契约见 [子代理运行时安全与兼容性](./subagent-runtime-security.md)。

KeepSeek 的本质是一个 VS Code 扩展内的可恢复 coding agent runtime。扩展端负责会话、上下文、引用展开、Tool Evidence、动态准入、Context Epoch、本地工具、模型请求循环、trace 和安全审批；云端模型负责语言理解、推理、工具选择、参数生成和最终回复生成。

## 1. 总体架构

KeepSeek 的 Agent 链路可以分成四层。

| 层级 | 主要模块 | 职责 |
|---|---|---|
| Webview 表现层 | `src/webview/*`、`src/webview/input/*` | 输入框、消息列表、引用 chip、设置弹窗、活动状态文案、发送/停止交互 |
| Provider 编排层 | `src/provider/KeepseekChatViewProvider.ts` | 接收 Webview 消息、维护 busy 状态、会话接线、引用授权、调用业务服务和 Agent Runtime |
| Agent Runtime 层 | `src/agent/agentRequestCoordinator.ts`、`src/agent/runner.ts`、`src/agent/evidence/*`、`src/agent/toolResultAdmission.ts`、`src/agent/contextEpoch.ts`、`src/agent/providerRequestProjection.ts`、`src/agent/providers/*` | 构造权威协议投影、证据/准入/epoch、上下文压缩与用量估算，流式调用三种 Provider 协议并执行工具循环 |
| 本地能力层 | `src/agent/tools/workspaceTools.ts`、`src/edits/*`、`src/context/*`、`src/sessions/*` | 只读工作区工具、引用展开、DraftEdit 安全写入、上下文文件、会话和压缩状态持久化 |

几个边界很重要：

- Provider 只做协调，不直接承载可独立测试的大块业务逻辑。
- `AgentRunner` 只负责编排模型请求、工具调用循环和最终响应整理。
- 上下文压缩属于 Agent Runtime 层：`AgentRequestCoordinator` 负责压缩刷新调度和 AgentRequest 组装，`HistoryCompressor` 负责摘要刷新，`historyProjection` 负责把真实会话投影成模型请求历史，`contextUsage` 使用同一套投影估算上下文窗口占用。Provider 只触发协调器，Session 存储只负责保存真实消息和 `contextCompression` 状态。
- 工具结果控制不依赖累计预算：`ToolEvidenceStore` 保证先意图、后完整结果、再不可变信封；`ToolResultAdmissionController` 按每次真实请求决定内联量；`contextEpoch` 在同一逻辑任务内滚动 Provider 上下文。
- 工作区工具保持只读，不能写磁盘。
- AI 不能直接修改文件，只能创建 DraftEdit。
- 真正写入磁盘只发生在用户点击 Apply 后，由 `SafeFileEditor` 执行。

## 2. 一次 Agent 请求的完整流程

### 2.1 Webview 收集输入

用户在输入框中输入自然语言，也可以通过这些方式插入上下文引用：

- 当前编辑器文件或选区。
- Explorer 右键 `KeepSeek: Add File to Chat` 添加文件，支持多选去重。
- Explorer 右键 `KeepSeek: Add Folder to Chat` 添加目录。
- 拖拽文件到输入框。
- 终端、输出、Debug Console 选区落盘后引用。
- `@` 文件/目录补全。
- `$` Skill 引用，Skill 可来自工作区 `.agents` 或用户 `~/.codex/skills`。

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
- 全文引用受 `keepseek.maxFileBytes` 的文件系统读取/安全快照上限约束；Provider 内联由 `keepseek.providerInlineResultMaxChars` 独立控制，evidence 持久化由 `keepseek.evidenceMaxBytes` 独立控制。
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
3. 未被摘要覆盖（`coveredMessageIds`）的其余 user/assistant 消息——**append-only**：消息只追加、内容冻结（始终以 `expandedContent ?? content` 原样发送），只有摘要刷新覆盖时才成批移除，这是低频缓存失效点。recent 窗口（`keepRecentTurns`）只用于判定哪些消息可压缩。
4. 当前展开后的用户 prompt。

之后 `providerRequestProjection.ts` 以 `buildInitialAgentMessages()` 的通用结果为唯一输入，再投影到具体协议。Chat Completions 保留原 messages；Responses 生成原生 Items；Anthropic 把全部 system/context/summary 按原顺序放到顶层 `system` text blocks，只在 `messages` 中保留 user/assistant：

1. 纯静态 system prompt，只依赖界面语言。
2. 会话冻结的 `contextInstructions` system message，包含 AGENTS.md、Skills、Legacy Memory 与 Context Files。
3. synthetic summary system message。
4. projection 选中的历史消息。
5. 当前展开后的用户 prompt，如果它还没有作为最后一条 user message 出现在 projection 中。

system prompt 的职责按固定顺序覆盖：身份与语言、安全和修改授权边界、自适应工作循环、任务类型分支、按证据选择工具、DraftEdit/validation 状态语义、证据/澄清/停止/最终回答契约，以及项目上下文优先级。它不注入模型名、Provider、时间、路径、UUID、上下文窗口或运行时能力。

`TaskPlanTracker` 只跟踪宿主可见的运行状态和 UI 步骤，不会作为消息发给模型，也不能替代 system prompt 中的决策策略。

### 3.2 调用模型

`providers/factory.ts` 按账号冻结的 provider 分派三条独立协议路径。DeepSeek、Kimi、GLM、QwenCloud、Ollama 与 OpenAI compatible 使用 Chat Completions；`openai-responses` 使用 Responses；`anthropic-compatible` 使用原生 Messages，不做 OpenAI→Anthropic 转换。

请求特征：

- 使用 streaming。
- DeepSeek 内置 profile 支持 `deepseek-v4-flash` 和 `deepseek-v4-pro`，保留 Flash / Pro × 非思考 / High / Max 的既有预算；其它账号的模型来自各自 `/models` 或手动模型 ID，并使用 metadata-first 通用画像。
- Thinking 开关和 `high` / `max` reasoning effort 由输入区选择。
- `src/shared/modelProfiles.ts` 是运行画像唯一解析入口。能力优先级为：手动模型显式覆盖 > 最新发现元数据 > DeepSeek 内置元数据 > `modelContextWindowGuesses.ts` 的受控模型家族猜测 > 保守 fallback。已知模型名称可分别猜测 context 与 output；没有公开输出上限或名称未知的模型仍使用 32768 context tokens / 8192 output tokens fallback。
- 账号设置中的上下文窗口与最大输出使用模型领域惯用的紧凑 token 表达，例如 `32768 → 32K tokens`、`1000000 → 1M tokens`。猜测/fallback 会显式标注；点击上下文数值可按 `K tokens` 编辑（例如 1M 输入 `1000`），点击最大输出可按精确 tokens 编辑。保存后写入账号下的精确覆盖，刷新 `/models` 不会覆盖它。
- 名称猜测覆盖 Qwen 3.6/3.7/3.8、GLM 4.5–5.3、DeepSeek V4 与 Qwen Audio Realtime 等已知文本/实时模型。`wan2.7-image`、`wan2.7-image-pro`、`qwen-audio-3.0-tts-plus` 会作为非文本资源保留在账号清单并显示“不适用”，但不会进入文本 Agent 的模型目录，也不能编辑 token 能力。
- 最终输出上限不超过 learned effective context window，工具选择轮和最终回答轮分别使用动态输出预留。Chat Completions、Ollama、Responses、Anthropic 与摘要请求消费同一画像，但各协议只发送自己支持的字段；不再为每次请求僵硬预留完整声明输出上限。
- 自动压缩阈值由命令菜单中的用户档位覆盖 profile 的 `triggerRatio / forceRatio`：提前清理 `0.70 / 0.85`、默认平衡 `0.80 / 0.92`、缓存优先 `0.85 / 0.95`；其他压缩参数仍保留 profile 原值。
- DeepSeek Chat Completions 固定使用 V4 推荐的 `temperature=1.0`、`top_p=1.0`。
- `stream_options.include_usage = true`，用于获取服务商真实 usage。
- epoch 内始终发送会话冻结的 function tools；工具选择轮用 `tool_choice: "auto"`，隐藏摘要/强制收尾用 `none`，不通过删除 schema 改变缓存前缀。

流式响应由 `DeepSeekClient` 和 `DeepSeekStreamParser` 处理。Parser 会解析：

- `content`：可见回答。
- `reasoning_content`：Thinking 内容。
- streaming `tool_calls`：模型请求的工具名和参数。
- `finish_reason`。
- `usage`。

如果请求在已有 partial output 后失败，Runner 会在同一逻辑任务内恢复。`finish_reason=length` 自动续写，必要时先做 Context Epoch rollover；它不创建新的聊天 user 消息，也没有人为的自动续写次数预算。重复空续写由跨 epoch 无进展检测终止。

Anthropic Messages 使用规范化的原生 Messages endpoint、`x-api-key` 和 `anthropic-version: 2023-06-01`，不发送 Bearer、`stream_options`、`reasoning_effort` 或 Responses 字段。常规 `/v1` base 追加 `/messages`；以 `/apps/anthropic` 结尾的 SDK base 追加 `/v1/messages`。专用 SSE parser 处理任意分块、CRLF、ping、Thinking/signature、redacted thinking、并行 `tool_use` 与 cache usage。模型能力来自 `/models` 元数据：只有明确声明 adaptive/enabled 时才发送 Thinking 参数；不提供模型列表的兼容网关允许保存账号并手动添加模型 ID，其能力可在账号设置中手动填写，否则使用通用保守 fallback。

官方 `api.anthropic.com` 默认发送顶层 `cache_control: {"type":"ephemeral"}`。自定义兼容端点默认不发送，不做失败后删字段重试。Anthropic 摘要请求复用同一不可变 source snapshot，关闭 tools/Thinking，`temperature=0`，并受模型输出上限约束。

### 3.3 工具调用循环

模型可能返回一个或多个 function tool calls。Runner 的工具循环是：

```text
请求模型
  -> 模型返回文本或 tool_calls
  -> 若无工具，整理最终回答
  -> 若有工具，先逐项持久化执行意图，再本地执行
  -> 逐项保存完整结果/hash/终态
  -> 按 prospective Provider 请求动态生成完整结果或 evidence envelope
  -> 以原生协议顺序回灌；必要时在完整批次后 rollover
  -> 再次请求模型
```

`maxToolIterations` 和 `maxToolCalls` 是**单个 epoch 的 rollover 阈值**，不再是逻辑任务终止预算。达到阈值后保留 task、运行时钟、usage、TaskPlan、repair、审批与幂等账本，自动创建下一 provider epoch。工具总结果 tokens 只做 telemetry，累计数百万 tokens 也不会形成停止条件。

并行批次先为每个调用预留最小信封，结果独立持久化。Chat Completions 保持 `tool_call_id` 配对；Responses 保持 function call/output 的 `call_id` 和 Items 原始顺序；Anthropic 把同轮全部 `tool_result` 集中在紧随 `tool_use` 的 user message 开头并保持顺序。若旧 epoch 无法合法容纳整个最小批次，结果仍先保存，再在新 epoch checkpoint 中交付 evidence 引用；绝不重跑原工具。Anthropic 跨 epoch 不复制或伪造 opaque thinking signature/redacted data。

上下文投影上限按 `maxProjectionTokens = contextWindow × forceRatio` 计算。选择 85% 缓存优先档时，`forceRatio=0.95` 会让投影上限增大，从而保留更多原始历史、尽量延后会破坏前缀缓存的摘要刷新；这是预期行为。

模型、来源、provider 或 base URL 切换只迁移 provider/cache lane，并在这个本来就冷启动的边界升级请求序列化；既有 `contextCompression.summaries` 保留并继续参与 projection。新会话使用 v8。v1–v7 热会话维持旧 provider-visible bytes，直到缓存已冷或首次需要大结果时经受控 rollover 迁移；历史里的旧预算文字不改写。

同一逻辑任务只有真实审批、用户 Stop、Provider/存储失败、显式时间/费用上限、副作用结果不确定、来源/模型安全不匹配或持续无进展才停止。`agent.maxCost` 按计费币种分别统计，主任务、子代理、epoch 与恢复共享同一账本；无法获得可计价用量时正值上限采用 fail-closed。内部容量调度不映射为 blocked，不会追加“继续新一轮”消息。

### 3.4 DSML 工具调用兜底

如果模型没有返回原生 `tool_calls`，但在文本里输出了 DSML 风格的工具调用块，`DsmlToolParser` 会尝试解析并模拟成 function tool call 执行。

这只是 Chat Completions 的兼容兜底，不是 MCP，也不是外部工具运行时。DSML 解析出的调用会进入同一 intent/evidence/admission/epoch 管线，不能绕过幂等或结果大小控制；Anthropic 原生 `tool_use` 不走 DSML。

## 4. 当前可用工具

当前工具 schema 由 `getAgentTools()` 提供，工具路由在 `AgentRunner.handleToolCall()` 中，工作区工具实现主要在 `WorkspaceToolService` 中。

| 工具名 | 类型 | 用途 |
|---|---|---|
| `keepseek_read_evidence` | 只读基础设施 | 按 task-scoped evidenceRef 做字节游标、1-based 行、结构化 item 或搜索分页，始终有界 |
| `keepseek_search_workspace` | 只读 | 搜索工作区文本，返回命中行和前后上下文 |
| `keepseek_list_workspace_files` | 只读 | 列出当前工作区文件 |
| `keepseek_list_workspace_directory` | 只读 | 列出指定工作区目录，可选递归 |
| `keepseek_read_workspace_file_range` | 只读 | 按 1-based inclusive 行号读取文件片段 |
| `keepseek_read_workspace_file` | 只读 | 读取小文件全文 |
| `keepseek_find_symbol` | 只读 | 用 document/workspace symbol provider 定位声明，必要时退化文本搜索 |
| `keepseek_find_references` | 只读 | 用 reference provider 查引用，必要时退化文本搜索 |
| `keepseek_get_document_symbols` | 只读 | 返回单文档语义符号树 |
| `keepseek_get_workspace_symbols` | 只读 | 查询工作区语义符号 |
| `keepseek_search_session_archive` | 只读 | 在本地会话归档中找回被投影省略的完整旧工具结果 |
| `keepseek_read_workspace_diagnostics` | 只读 | 读取当前 VS Code Problems |
| `keepseek_run_validation` | 受控验证 | 只运行 allowlist 中的 compile/lint/test，且只验证已落盘工作区 |
| `keepseek_git_status` | 只读 | 读取 Git 状态 |
| `keepseek_git_current_branch` | 只读 | 读取当前分支和 upstream 元数据 |
| `keepseek_git_diff` | 只读 | 读取受限 Git diff |
| `keepseek_git_create_patch` | 只读 | 返回 patch 内容，不写入也不应用 |
| `keepseek_git_suggest_commit_message` | 只读 | 基于当前变更建议 commit message，不创建 commit |
| `keepseek_create_incremental_draft_edit` | 待确认修改 | 对现有文本文件组合精确小范围修改，生成一个 pending DraftEdit |
| `keepseek_create_draft_edit` | 待确认修改 | 为新/小文件、整体重写或不适合 incremental 的修改创建 DraftEdit |
| `keepseek_delete_workspace_file` | 待确认修改 | 为一个普通可读文件准备非递归 pending delete，不立即删除 |

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

### 4.6 DraftEdit 工具选择

现有大文件的小范围修改优先走 `keepseek_create_incremental_draft_edit`：每个精确 search 必须唯一命中，多个不重叠 edit 在本地组合成一个完整 DraftEdit，继续复用现有 review/checkpoint 安全链。新文件、小文件、整体重写或 incremental 无法安全表达时才用 `keepseek_create_draft_edit`。删除只走 `keepseek_delete_workspace_file`，并保留删除前基线与 Apply 二次确认。

三个工具都只把 pending DraftEdit 交给 ChangeSet/Webview；Apply 前工作区不会变化。

### 4.7 会话归档恢复

历史维护会把较早的超大工具结果保存在 `ChatSession.historyArchive`，投影中只留稳定引用。`keepseek_search_session_archive` 用本地词法/BM25 排名返回受限 excerpt 和稳定 archive id，不联网、不调用模型。旧证据足以回答时避免重新扫描；代码新鲜度重要时仍要重读当前文件。

v8 的 `keepseek_read_evidence` 与旧 session archive 的职责不同：前者是当前逻辑任务中每次工具执行的不可变、授权快照及交付账本，引用只允许同一 session/task 读取；后者是跨聊天轮次的历史检索。evidence 可按 UTF-8 byte cursor、1-based 行范围、结构化 item 或 search 读取，返回 hash、位置、`hasMore` 和下一 cursor。需要“当前文件状态”时应重读源文件，不能把旧 evidence 当作实时视图。

### 4.8 validation 的落盘边界

`keepseek_run_validation` 只能看到当前已经落盘的工作区。创建 DraftEdit 前可以验证，用于复现或建立基线；本 run 任一 DraftEdit 成功后，`RunValidationStateTracker` 会在授权和任务启动前硬性阻止后续 validation，不区分普通 edit 与 repair edit。

Runner 的最终状态装饰会区分未验证、修改前基线、pending/unapplied edit 与 Apply 后验证；没有限定语的虚假“验证通过/失败”段落不会在 pending 状态下保留。repair ChangeSet 全部 Apply 后，Provider 把 repair 状态迁到 `ready_for_validation`，现有“继续验证修复”流程再对真实更新后的工作区运行验证。

### 4.9 工具反馈契约

主要工具结果使用紧凑 JSON：`ok` 表示成功，失败包含稳定 `errorType`，长结果保留 `truncated`，语义/Git/搜索退化保留 `fallback` 或 engine 信息，必要时返回 `suggestedTool` 和最小建议参数。运行时能硬性执行的约束不依赖模型遵守 description。

## 5. Tool Evidence、结构化整形与动态准入

### 5.1 执行与交付状态机

每个工具调用先以 `sessionId + taskId + epochIndex + toolCallId` 创建确定性的 evidence intent，随后依次进入：

```text
pending -> executing -> completed(evidence/hash saved)
                         -> envelope_ready -> sending -> delivered
```

扩展重启后，`pending` 表示未执行；已 `completed` 的工具直接复用相同 evidence ID 和 envelope，不能重跑。处于 `executing` 的只读/纯 proposal 可安全回到 pending；validation、delegate 或其它无法证明副作用终态的调用进入 `uncertain`，要求核实，不自动重放。证据或 checkpoint 持久化失败属于真实停止条件。

不可重建的重要结果保存 content-addressed blob；会话/task 目录和 capability-style evidenceRef 同时校验，跨会话猜测引用返回 `evidence_not_found`。活动 checkpoint 引用的 evidence 不得被清理。正文可能包含敏感数据，普通 telemetry 只写 hash、大小、类型和引用，不写原文。

### 5.2 合法且可继续的结果信封

小结果在动态容量允许时原样内联。大结果按类别整形：

- 文件、range、diff、patch、日志按完整行，保留真实行号和下一范围；
- 搜索、符号、引用、诊断、目录按完整 item 分页；
- JSON 每页保持合法 JSON；
- 子代理只内联权威摘要，全文进入 evidence；
- DraftEdit、ChangeSet、DraftRun、审批/validation 返回权威 ID、状态、hash、目标和必要摘要，不重复大正文；
- 错误保持小型稳定 `errorType`，大结果绝不伪装成失败。

所有非完整信封明确包含 `completeInline:false`、`evidenceRef`、`contentHash`、字符/字节/token 估算和 `keepseek_read_evidence` 读取方法。信封以规范 key 顺序序列化、持久化一次；恢复不得重新整形。

V8 子代理的完整签收结果也先交给同一 evidence/admission 管线，新子代理 lane 不再使用独立分页。根 schema 中的 `keepseek_read_subagent_result` 只作为 V1–V7 已存结果迁移桥；桥接页本身仍进入通用 evidence/admission 管线。这样单子代理、并行子代理、DSML 与原生工具没有独立的当前任务分页预算或恢复账本，同时旧结果不会在迁移边界失联。

### 5.3 动态 Tool Result Admission

不存在固定累计 `toolResultTokenBudget`。每个批次根据当前协议的 prospective request 计算：

```text
inlineAllowance = learnedEffectiveWindow
  - currentProviderProjection
  - phaseSpecificOutputReserve
  - protocolEnvelopeOverhead
  - remainingBatchMinimumEnvelopes
  - adaptiveEstimatorSafety
```

Responses 计算原生 Items，Anthropic 计算 system/Messages/tool blocks，Chat Completions/DSML 计算实际 messages。Provider 返回的真实 prompt/input usage 校准估算倍率；没有可靠 tokenizer 时用保守字符估算和动态误差因子。完整结果放不下就使用 evidence envelope；连最小信封放不下则在完整批次后 rollover，不能结束任务。

`maxFileBytes` 仅控制文件系统读取/安全快照，`providerInlineResultMaxChars` 控制单次模型可见结果，`evidenceMaxBytes` 控制证据持久化。`toolResultTokens` 和旧 ledger 字段仅是 telemetry。

## 6. Context Epoch、容量自校准与 usage

### 6.1 rollover 检查点

Context Epoch 是一条用户请求内部的 Provider 上下文分段。rollover 保持 `sessionId`、`taskId`、`approvalRootTaskId`、原始 user 请求、TaskPlan、DraftEdit/ChangeSet/DraftRun、repair/validation、已消费 permit、幂等账本、运行时钟、usage/cost、Stop 与子代理关系不变，不创建聊天消息、不重新授权或执行副作用。

旧 epoch 在请求新模型之前完整持久化；完整宿主状态另存为 task-scoped、可分页的 checkpoint evidence，新 seed 携带其 ref/hash、最近证据与有界恢复状态，避免长期任务让最小 seed 无限增长。它覆盖原始任务、计划完成/未完成项、事实线索、evidence/hash、幂等指纹、草案/审批/validation/repair 状态、失败和下一步。优先调用当前模型生成隔离的无工具语义摘要；失败、超时、空或错误格式时使用宿主确定性摘要。`summarizing`、`persisted` 和新 epoch 尚未请求三个崩溃点都可恢复，已保存 seed 原样复用。

### 6.2 Provider 容量自校准

容量状态按 source/provider/规范 endpoint/model 隔离保存，不进入 system 或历史。真实 input usage 更新本地估算比例；识别 context-too-long 后降低 learned effective window，以更小 inline allowance 重建新 epoch，只重发模型请求、不重跑工具。后续成功可保守回升并带阻尼。只有 system、冻结 schema、原始请求和最小 checkpoint 本身仍无法容纳时，才报告真实 provider 容量/配置错误。

### 6.3 usage 与原生 lane

真实 usage 由各协议 parser 归一化。Chat Completions 使用 `stream_options.include_usage`；Responses 读取 input/output usage；Anthropic 按 `input + cache_creation + cache_read` 计算 prompt，cache read 计 hit。Runner 汇总 request、prompt/completion/total、cache hit/miss、reasoning、cost 与来源，跨 epoch 连续累计。

Responses epoch 内 replay Items 原样有序；rollover 不把孤立 output 拼进新 lane。Anthropic epoch 内原样保存 Thinking/signature/redacted data/tool blocks；跨 lane 只继承合法可见文本、checkpoint 和 evidence 引用。原生 replay 不发送到 Webview，lane 仍要求 protocol/sourceId/规范 endpoint 完全匹配。

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

用户点击 Apply 后，Provider 调用 `ChangeSetStore`，再由 `SafeFileEditor` 执行写入。

写入前会检查：

- 目标文件是否有未保存 dirty editor/tab。
- 目标 URI 是否可写。
- DraftEdit action 是 create/modify/delete/move 中的哪一种。

确认后的 create/modify/delete 都由 ChangeSet checkpoint 和 `SafeFileEditor` 保护。后续写入行为应优先扩展 `edits/changeSetStore.ts` 与 `edits/safeFileEditor.ts`，不要把应用逻辑放进 `AgentRunner`。

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

日志事件的 `ts` 使用扩展运行所在操作系统的本地时区，格式为带毫秒与明确偏移的 ISO 8601，例如 `2026-09-04T16:04:03.123+08:00`。日期目录、文件名、后续追加事件和截断标记使用同一规则；夏令时按事件发生时间计算。旧日志不回写，嵌套的请求/响应 payload 与历史消息时间字段保持原样，避免破坏原始证据和请求缓存字节。

内部容量调度不再生产 `tool_result_budget_exhausted`、工具次数耗尽或 `context_window_exhausted` blocked 状态。旧 enum/字段只用于读取历史 checkpoint；恢复时转换为同一 task 的 v8 epoch 迁移，不生成自动 user 消息，也不显示继续按钮。

trace 对每个 evidence 记录 raw/inline chars、bytes、token 估算、`evidenceRef`、hash、是否分页及协议；对每次 rollover 记录 epoch index、reason、前后估算/真实 prompt tokens、declared/learned window、summary/fallback、context-too-long 自适应和缓存边界成本；无进展仅记录不可逆 hash 指纹。普通 telemetry 不含 evidence 正文、凭证或可避免的绝对路径。

真实停止原因使用精确状态：用户 Stop、等待审批、Provider 鉴权/服务失败、来源/模型/工作区变化导致不可安全恢复、checkpoint/evidence 存储失败、显式时间/费用上限、副作用结果不确定或 `no_progress_loop`。无进展检测对工具名、规范参数、结果 hash、源 fingerprint 和 TaskPlan 进度生成跨 epoch 指纹；第一次重复给模型策略调整机会，持续重复才停止，绝不描述成 token 或工具预算耗尽。

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
- evidence admission、delivery 与 Context Epoch rollover。

trace level 控制 payload 细节：

- `metadata`：主要记录生命周期和大小。
- `request`：记录请求和组装后的响应消息 payload。
- `full`：还可记录 raw stream。

Evidence 管线启用后，大型 raw payload 不会写入普通 trace；只有显式 payload 级别才允许受保护地记录模型可见 envelope，正文仍以会话/task 隔离的证据存储为权威来源。

## 10. 推荐的 Agent 工作方式

KeepSeek 使用“识别任务类型 → 解决下一个关键不确定性 → 根据证据调整”的自适应工作模式，而不是固定菜谱。

### 10.1 理想探索流程

```text
用户提出任务
  -> 不依赖工作区：直接回答
  -> 已知路径/符号/错误/diff：从该强线索开始
  -> 选择能解决下一个关键不确定性的最窄工具
  -> 证据仍不足时才扩大范围
  -> 按只读或修改授权完成，并准确汇报修改/验证状态
```

这比“列出全项目文件，再读取一堆完整文件”更省 token；即使证据量很大，运行时也会外置并自动整理上下文，而不是中断用户任务。

### 10.2 工具选择提示

- 已知声明/符号关系：semantic tool。
- 已知精确字符串、错误文案、配置 key：限定范围 search。
- 已知路径：直接 range/full read，不先列全仓库。
- 本地变更审查：优先 Git diff，再读必要上下文。
- 较早工具证据被省略：优先 session archive。

### 10.3 读取与修改粒度

- search 命中后读取上下文。
- 大文件中只需要某个函数或配置段。
- 模型需要继续读取某段之前或之后的内容。
- 全文 read 返回 `suggestedTool` 时。
- 小文件或真正的整体问题才全文读取。
- 大文件局部改动用 incremental DraftEdit；新/小文件或整体重写用完整 DraftEdit。

## 11. 当前边界和后续扩展方向

当前版本已经具备轻量 Agent runtime 的核心能力：

- 流式模型请求。
- 工具调用循环。
- 只读工作区工具。
- 搜索和范围读取。
- semantic、Git、diagnostics、validation 与 session archive 只读能力。
- 自动模型 / Thinking 档位、动态结果准入与 learned effective window。
- 通用 Tool Evidence、20MB 级有界分页、不可变 provider envelope 与崩溃恢复账本。
- 同一逻辑任务内的 Context Epoch、摘要 fallback、三协议/DSML 合法续跑与跨 epoch 无进展检测。
- 历史投影、会话摘要和后台上下文压缩刷新。
- incremental/full/delete DraftEdit、ChangeSet 与 Apply 后安全写入。
- 普通/repair pending DraftEdit 的统一 validation 硬阻断与 Apply 后继续验证。
- trace 和 usage 记录。
- 离线行为评测契约和显式 opt-in live runner。

仍未覆盖的方向：

- 队列 prompt。
- MCP。
- 任意 shell 或非 allowlist 命令执行。
- Git commit/push/remote 修改。
- MCP 与外部 server tools。
- 更丰富的 provider capability 元数据与多模态输入。

这些能力后续可以逐步扩展，但应继续遵守当前分层：Provider 只编排，evidence/admission/epoch 保持独立抽象，工作区工具保持只读，写入仍只走 DraftEdit。

模型/Provider、Thinking、声明上下文窗口和最大输出继续由模型选择器与设置页展示和配置；learned window 只存在校准存储/Run Details，不进入静态 system/history。显式时间/费用上限仍由宿主强制；内部工具轮、调用次数和结果累计量只触发 epoch 调度，不是停止预算。

## Ask 模式下的有限命令批量批准

- 同一 `sessionId + agentRunId` 至少有两条 pending DraftRun 时，首张相关命令卡片提供“全部批准（N）”；展示顺序沿用 Store 顺序，不按 UUID 排序。Transcript 与未关联回复区域复用同一渲染入口。
- `DraftRunBatchCoordinator` 保存宿主展示快照和独立 operationId；点击只提交 snapshotId、会话/来源批次及有序 ID/hash。接收时消费快照，首次持久化后再次比对完整列表。后续新增/克隆命令不加入授权。
- 整批运行保持 Provider 忙碌锁；逐条走 Store → Authorization → Executor，前一条结果保存后才执行下一条。每条命令在自己的最终检查、审批状态持久化完成后签发 30 秒单次 user_click permit。首次仅检查全部命令的信任/哈希/精确 cwd 授权边界，逐条执行前才检查 cwd 实际存在。
- 失败或停止撤销余下授权，剩余命令仍 pending。全局停止、当前命令停止及“停止本批”均取消整批续跑；进度、快照和续跑意图只存在当前宿主内存，重启不恢复。
- 全部成功后独立认领一次续跑，沿用新 user 消息、结果 user-tail、保护消息及请求投影。待确认修改、其他未终结命令、修复流程及后台任务继续阻塞并显示原因；停止、新用户输入、会话/审批模式/信任变化取消旧意图，来源或模型不匹配则明确停止续跑，不回退模型。
- DraftEdit 的 ChangeSet 级“全部采纳 / 全部取消”仅在实际可处理项（pending / apply_failed）至少两条时显示；ChangeSet 级回滚同样仅在实际可回滚项至少两条时显示。单条修改只保留文件行内动作，不改变采纳、删除确认、冲突检查或回滚流程。命令与修改分别计数。
- 未改动 system prompt、协议版本、工具 schema 或已发送消息字节；批量进度不写入模型历史。
