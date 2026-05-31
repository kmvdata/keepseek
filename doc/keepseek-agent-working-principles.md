# KeepSeek Agent 工作原理与本地/云端分工

本文基于 `src/` 当前源码梳理 KeepSeek 作为 VS Code 侧边栏 Agent 的真实运行方式。结论先放在前面：KeepSeek 不是一个在本地持续自主运行的独立智能体，也没有启动 MCP host。它是一个 VS Code 扩展，负责收集上下文、拼装 OpenAI-compatible 请求、执行本地固定工具、保存会话和安全写入；AI API 负责语言理解、推理、决定是否调用工具、生成最终回复或 DraftEdit 内容。

## 一、核心模块地图

KeepSeek 的 Agent 链路主要由这些模块组成：

| 模块 | 主要职责 |
|---|---|
| `extension.ts` | VS Code Webview Provider，接收 Webview 消息，维护 busy 状态、会话状态、引用授权、AbortController，并调用 `AgentRunner` |
| `webview/input/script.ts` | 输入框交互、引用 chip、拖拽、`@` 补全、prompt 序列化、发送/停止按钮 |
| `promptReferences.ts` | 发送前统一展开文件引用和目录引用 |
| `fileReference.ts` | `<path>` / `<path#Lx-Ly>` 文件引用解析、外部文件授权、读取、展开为 Markdown fence |
| `directoryReference.ts` | `<keepseek-dir:path>` 目录引用解析，展开为目录说明和受限清单 |
| `agentRunner.ts` | Agent 请求编排、DeepSeek API 请求、流式响应处理、工具调用循环、预算控制和最终回复整理 |
| `agentProtocol.ts` | system prompt、历史消息拼接、工具 schema 定义、token 估算入口 |
| `deepSeekStreamParser.ts` | SSE 流式响应解析，收集 `content`、`reasoning_content`、streaming `tool_calls` |
| `dsmlToolParser.ts` | 模型没有返回原生 tool_calls、而是在文本里输出 DSML 工具调用时的兜底解析器 |
| `workspaceTools.ts` | 本地只读工作区工具：列文件、列目录、读文件、路径越界和二进制/大文件防护 |
| `draftEditStore.ts` / `safeFileEditor.ts` | DraftEdit 状态管理，用户确认 Apply 后才写入本地文件 |
| `chatSessionStore.ts` / `globalSessionStorage.ts` | 会话按工作区保存到扩展全局存储，历史裁剪和跨项目会话管理 |
| `contextUsage.ts` / `tokenEstimate.ts` | 上下文用量估算，使用简单字符估算而非模型官方 tokenizer |

## 二、一次请求的完整工作流程

### 1. Webview 收集输入和引用

用户在 KeepSeek 输入框中输入文本，或通过右键、快捷键、拖拽、`@` 补全插入文件/目录引用 chip。输入区由 `webview/input/script.ts` 管理。

发送时，`serializePrompt()` 会遍历富文本 DOM：

- 普通文本按原样转成字符串。
- `.rich-file-link` 文件 chip 序列化成 `文件名/行号标签` 加下一行 `<path#Lx-Ly>`。
- 目录 chip 序列化成 `目录名 <keepseek-dir:path>`。
- 同时 `collectPromptFileReferences()` 收集 chip 里的原始路径和 kind，交给扩展端用于外部路径授权。

如果此时 `state.isBusy` 为 true，输入区提交事件不会发送新任务，而是发送 `{ type: 'abortPrompt' }` 来停止当前任务，并清空输入框。这是一个重要 UX 行为：大任务运行中误触发送，可能看起来像 Agent 自己中断。

### 2. Provider 接收消息并准备本地状态

`extension.ts` 的 `handleMessage()` 收到 `sendPrompt` 或 `editUserPrompt` 后调用 `sendPrompt()`。

`sendPrompt()` 会做这些本地工作：

1. 如果当前正在运行任务，则直接返回。
2. 根据模型 id 找到配置模型，合并 Thinking / reasoning effort 设置。
3. 创建 `AbortController`，设置 `isBusy = true`。
4. 收集并记录外部引用授权。
5. 设置状态为 `preparing` 和 `expanding_references`。
6. 调用 `expandPromptReferencesInPrompt()` 展开 prompt 中的引用。
7. 把用户消息写入当前会话，并保存到本地全局存储。
8. 创建一个空的 streaming assistant message，用于实时显示模型流式输出。
9. 调用 `AgentRunner.run()`。

这里还没有调用 AI API 之前，本地已经完成了引用授权、引用展开、会话写入、上下文估算和 UI 状态同步。

### 3. 发送前引用展开

`promptReferences.ts` 先展开目录引用，再展开文件引用。

目录引用：

- 识别 `<keepseek-dir:path>`。
- 只允许工作区内目录，或已授权的外部目录。
- 不展开整个目录内容，只展开目录说明和最多 100 个直接条目。
- 提醒模型后续可以调用 `keepseek_list_workspace_directory` 和 `keepseek_read_workspace_file` 获取更多细节。

文件引用：

- 识别 `<path>`、`<path#Lx-Ly>`、`<path#LxCy-LmCn>`。
- 必须独立成行，且不能在 Markdown fence 内。
- 工作区内文件可展开；外部文件必须先进入授权集合。
- 图片、媒体、归档、常见二进制扩展会跳过。
- 全文引用受 `keepseek.maxFileBytes` 限制。
- 行段引用会按 VS Code 文档读取具体范围，然后包装成 Markdown 代码块。

这一步完全在本地完成。AI API 不会自己读取你磁盘上的文件，除非本地扩展把内容展开进 prompt，或之后模型请求本地工具读取工作区文件。

### 4. AgentRunner 构造模型请求

`AgentRunner.run()` 先检查一个特殊本地快捷命令：如果 prompt 形如：

```text
/draft path/to/file
完整文件内容
```

它会直接创建 DraftEdit，不调用 AI API。

普通请求则进入 Agent 循环。`agentProtocol.ts` 会构造消息：

- system prompt：说明 KeepSeek 是 VS Code 侧边栏 coding agent，可以使用固定工具，修改文件必须创建 DraftEdit。
- 用户加入的 context files：作为 system prompt 的上下文块附加进去。
- 最近历史消息：最多 `AGENT_HISTORY_MESSAGE_LIMIT = 24` 条用户/助手消息。
- 当前展开后的 prompt。

然后 `getAgentTools()` 提供 4 个 OpenAI-compatible function tools：

| 工具名 | 模型看到的能力 | 本地实际执行 |
|---|---|---|
| `keepseek_list_workspace_files` | 列出当前 VS Code 工作区文件 | `vscode.workspace.findFiles`，跳过 `.git`、`node_modules`、`dist` 等 |
| `keepseek_list_workspace_directory` | 列出工作区内某个目录 | 本地解析路径、检查目录、返回目录项，可递归但有深度和数量限制 |
| `keepseek_read_workspace_file` | 读取工作区内文本文件 | 本地检查路径必须在当前工作区内，拒绝过大、二进制、图片、媒体、归档 |
| `keepseek_create_draft_edit` | 创建安全待确认文件修改 | 本地生成 DraftEdit 对象，只进入待确认列表，不写磁盘 |

### 5. 调用 DeepSeek/OpenAI-compatible API

`createChatCompletion()` 发送 POST 请求到：

```text
{keepseek.baseUrl}/chat/completions
```

请求体主要包含：

```json
{
  "model": "配置模型 id",
  "messages": [],
  "stream": true,
  "thinking": { "type": "enabled 或 disabled" },
  "reasoning_effort": "high 或 max",
  "tools": [],
  "tool_choice": "auto",
  "max_tokens": 64000
}
```

当工具预算为 0 或预算已经耗尽时，`tools` 和 `tool_choice` 会被省略。

这一步由云端 AI API 完成的事情是：

- 阅读 system prompt、历史、引用展开内容和 context files。
- 进行自然语言理解和推理。
- 生成 streaming `reasoning_content` 和 `content`。
- 选择是否返回 `tool_calls`，并为工具生成 JSON 参数。
- 返回 `finish_reason`，例如 `length`、`content_filter` 等。

本地扩展不会在模型内部推理，也不会替模型决定该读哪个文件。它只是提供工具 schema、执行工具调用、再把结果喂回模型。

### 6. 本地解析 SSE 流

`deepSeekStreamParser.ts` 负责解析 `text/event-stream`：

- 按 SSE event 拆分 `data:` 行。
- JSON parse 每个 chunk。
- 收集 `delta.reasoning_content`。
- 收集 `delta.content`。
- 收集 streaming `delta.tool_calls`，按 index 拼回完整工具名和参数。
- 把内容增量回调给 Webview 显示。

它还有一个 `StreamingDsmlDisplayFilter`，用来在 UI 上隐藏模型文本里的 DSML 工具调用块，避免用户看到内部兜底协议。

### 7. 工具调用循环

一次 `AgentRunner.run()` 不是只请求一次模型。它会执行多轮：

1. 请求模型。
2. 如果模型没有 tool calls，返回最终回复。
3. 如果模型返回 tool calls，本地执行这些工具。
4. 把工具结果作为 `role: "tool"` 消息追加到 messages。
5. 再请求模型，让模型基于工具结果继续推理。
6. 直到模型给出最终文本，或预算耗尽。

当前预算主要包括：

| 配置 | 默认值 | 影响 |
|---|---:|---|
| `keepseek.maxToolIterations` | 8 | 最大工具轮次，0 表示禁用工具 |
| `keepseek.maxToolCalls` | 24 | 单次运行最大工具调用数，0 表示不启用单独调用数上限 |
| `keepseek.maxRunMs` | 600000 | 单次运行最大总时长，默认 10 分钟 |
| `keepseek.toolResultTokenBudget` | 0 | 工具结果 token 预算，0 表示按上下文窗口自动估算 |
| `keepseek.maxTokens` | 64000 | 单次模型生成预算，0 表示不传 `max_tokens` |
| `keepseek.contextWindowTokens` | 1000000 | 本地上下文窗口估算值，不一定等于服务商真实限制 |

如果工具预算耗尽，KeepSeek 不会继续允许模型调用工具。它会追加一条本地用户消息，要求模型停止调用工具，基于已获得的信息给出尽量完整的答案。

### 8. DSML 兜底工具调用

DeepSeek 或兼容网关有时可能没有按 OpenAI tool_calls 结构返回工具调用，而是在文本里输出类似 DSML 的工具调用块。`dsmlToolParser.ts` 会尝试解析：

```text
<|DSML|tool_calls>
<|DSML|invoke name="keepseek_read_workspace_file">
<|DSML|parameter name="path">src/agentRunner.ts</|DSML|parameter>
</|DSML|invoke>
</|DSML|tool_calls>
```

解析成功后，本地把它模拟成 function tool call 执行。解析失败则按普通模型文本处理。

这只是兼容兜底，不是 MCP，也不是 DeepSeek 官方的外部工具运行时。

### 9. 最终回复和 DraftEdit

当模型返回最终文本，`AgentRunner.run()` 输出：

- `message`：最终回复文本。
- `reasoningContent`：收集到的推理内容。
- `draftEdits`：模型通过 `keepseek_create_draft_edit` 创建的待确认修改。

`extension.ts` 会把这些写入当前会话，保存到本地存储，并推送 Webview 更新。

如果有 DraftEdit，`DraftEditStore` 只把元信息给 Webview 展示，`newText` 不直接暴露到状态里。用户点击 Apply 后，才进入 `SafeFileEditor.applyDraftEdit()`。

### 10. Apply DraftEdit 才真正写磁盘

AI API 永远不直接写本地文件。真正写入发生在用户点击 Apply 之后：

1. `draftEditStore.ts` 找到对应 DraftEdit。
2. `safeFileEditor.ts` 检查目标文件是否有未保存的 dirty editor/tab。
3. 对 create/modify 执行 `vscode.workspace.fs.writeFile()`。
4. 打开写入后的文件。
5. 记录一条 assistant 消息，说明文件已写入。

如果目标文件有未保存修改，Apply 会失败，避免覆盖用户本地未保存内容。

## 三、哪些事情由 AI API 自动完成

AI API 自动完成的是模型能力部分：

| 类别 | AI API 做什么 |
|---|---|
| 自然语言理解 | 理解用户问题、引用内容、历史对话、system prompt |
| 推理 | Thinking/reasoning、分析代码关系、规划下一步 |
| 工具选择 | 决定是否调用 `keepseek_list_workspace_files`、`keepseek_read_workspace_file` 等 |
| 参数生成 | 为工具调用生成 JSON 参数，例如 `{ "path": "src/agentRunner.ts" }` |
| 结果综合 | 读取本地工具返回的 JSON 后继续分析 |
| 内容生成 | 生成最终回答、解释、建议、修改后的完整文件内容 |
| DraftEdit 内容 | 通过工具参数提供目标路径、完整新内容和修改原因 |
| 停止原因 | 返回 `finish_reason`，例如 `length`、`content_filter` |

需要注意：AI API 只“请求”工具调用，不会自己访问本地文件系统。工具调用是否执行、如何执行、能读哪些文件，全部由本地扩展控制。

## 四、哪些事情在本地完成

本地扩展完成的是运行时和安全边界部分：

| 类别 | 本地做什么 |
|---|---|
| UI | Webview 输入、消息渲染、设置弹窗、DraftEdit 卡片、上下文用量显示 |
| VS Code 集成 | 右键菜单、快捷键、Explorer 文件/目录、终端/Output/Debug Console 选区 |
| prompt 序列化 | 富文本 chip 转成文本引用语法 |
| 引用展开 | 读取本地文件/目录，把可读内容展开进 prompt |
| 外部授权 | 只有用户显式添加的外部文件/目录才允许展开 |
| 会话存储 | 当前工作区和其他工作区会话写入 `globalStorageUri` |
| API 请求 | 拼 JSON、设置 headers、调用 fetch、处理 AbortController |
| SSE 解析 | 解析 streaming 响应、增量显示、拼接 tool_calls |
| 工具执行 | 用 VS Code API 列文件、列目录、读文件、创建 DraftEdit |
| 安全限制 | 路径越界、文件大小、二进制、常见媒体归档过滤 |
| 预算控制 | 工具轮次、工具调用数、运行总时长、工具结果 token 预算 |
| 写入文件 | 仅用户 Apply 后由 `SafeFileEditor` 写入 |

## 五、KeepSeek 当前 Agent 的真实边界

KeepSeek 当前更准确的定位是：

```text
VS Code Webview UI
  -> Provider 本地编排
    -> 引用展开和会话持久化
      -> OpenAI-compatible chat/completions
        -> 模型返回文本或工具调用
          -> 本地固定工具执行
            -> 工具结果回填模型
              -> 最终回复或 DraftEdit
```

它不是：

- 不是 MCP client。
- 不是 MCP server。
- 不是 Claude Desktop 那类可发现外部 MCP 工具的运行时。
- 不是带 skills manifest、skills 安装、skills 路由的技能系统。
- 不是能直接运行 shell、测试、git、浏览器、数据库的通用 Agent。
- 不是自动把整个仓库建索引后检索的代码搜索 Agent。

它的安全性和可控性不错：默认只读工作区，写文件必须 DraftEdit + 用户 Apply。但它的 Agent 能力也因此比较窄，复杂任务容易受工具数量、上下文、生成长度、网络流式连接和运行时预算影响。

## 六、读这套代码时最容易误解的点

### 误解 1：AI 能直接读取本地文件

不能。AI 只能看到本地扩展放进 prompt 的内容，或工具调用返回的内容。`keepseek_read_workspace_file` 的实际读取发生在本地 `workspaceTools.ts`。

### 误解 2：目录引用会把目录下所有文件发给 AI

不会。目录引用只展开受限清单，默认最多 100 个条目，不递归展开内容。模型需要更多细节时必须调用目录或读文件工具。

### 误解 3：DraftEdit 已经修改了文件

没有。DraftEdit 只是待确认修改。只有用户 Apply 后，本地才执行写入。

### 误解 4：`contextWindowTokens = 1000000` 等于模型真实上下文

不一定。这个值只是 KeepSeek 本地估算和预算判断使用的配置。如果服务商或网关真实上下文更小，仍然可能 API 报错或提前截断。

### 误解 5：KeepSeek 的工具就是 MCP

不是。KeepSeek 使用的是 OpenAI-compatible function tools。MCP 需要一个独立的协议层，用于发现 server、列 tools/resources/prompts、建立连接、权限控制和调用。当前源码没有 MCP 相关模块。

