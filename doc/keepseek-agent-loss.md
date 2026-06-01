我看了一圈现有实现后，结论是：KeepSeek 的“中断”主要不是单点 bug，而是轻量 runtime 在复杂任务下缺少“自适应续航能力”。它现在能完成一次对话和几轮工具调用，但还不是一个能长期规划、压缩、恢复、重试的任务执行系统。

**当前执行链路**

一次请求大致是：

1. `extension.ts` 先展开用户显式引用，把用户消息写入会话，再创建一个空的 streaming assistant 消息。
2. `AgentRunner.run()` 构造 system prompt、最近历史、上下文文件和当前 prompt。
3. 在 `0..maxToolIterations` 里循环请求模型，每轮可让模型调用 4 个固定工具。
4. 工具结果以完整 JSON 追加回消息，再进入下一轮模型请求。
5. 如果最终有文本就结束；如果遇到预算、长度、网络、解析、超时等问题，就把错误或停止信息落回 transcript。

关键代码在 [agentRunner.ts](/Users/kermit/Projects/kmvdata/keepseek/src/agentRunner.ts:166)、[extension.ts](/Users/kermit/Projects/kmvdata/keepseek/src/extension.ts:1367)。

**主要原因**

第一类是预算型中断。  
KeepSeek 有默认 8 轮工具迭代、24 次工具调用、10 分钟总运行时间、64k 输出 token、上下文窗口估算和 16k safety reserve。复杂 coding 任务很容易经历“列文件 -> 读多个文件 -> 分析 -> 再读更多 -> 生成完整文件 DraftEdit”，这会快速消耗轮次、调用数、上下文和输出预算。相关默认值在 [config.ts](/Users/kermit/Projects/kmvdata/keepseek/src/config.ts:7)，工具循环和预算判断在 [agentRunner.ts](/Users/kermit/Projects/kmvdata/keepseek/src/agentRunner.ts:221)。

第二类是上下文膨胀。  
工具读文件会返回完整内容，目录/文件列表也以 JSON 原样塞回模型上下文，没有检索索引、摘要缓存、分块读取、符号级检索或旧结果压缩。也就是说，Agent 每探索一步，历史负重就变重一步。上下文估算会把 messages、tool schema、输出预留和 safety reserve 都算进去，超过就停止继续吞工具结果，见 [contextUsage.ts](/Users/kermit/Projects/kmvdata/keepseek/src/contextUsage.ts:100) 和 [agentRunner.ts](/Users/kermit/Projects/kmvdata/keepseek/src/agentRunner.ts:253)。

第三类是工具能力太粗。  
当前工具只有列文件、列目录、读完整文件、创建整文件 DraftEdit。没有 grep、语义检索、AST/symbol 搜索、补丁级编辑、测试运行、诊断读取、git diff、包管理器命令、MCP 工具或 skills。所以模型为了确认一个小事实，往往只能反复 list/read，既慢又占上下文。工具定义在 [agentProtocol.ts](/Users/kermit/Projects/kmvdata/keepseek/src/agentProtocol.ts:130)，实现边界在 [workspaceTools.ts](/Users/kermit/Projects/kmvdata/keepseek/src/workspaceTools.ts:22)。

第四类是输出长度和 DraftEdit 形态。  
`keepseek_create_draft_edit` 要求传“完整新文件内容”，不是 diff。小改动也可能让模型输出整个文件；多文件或大文件修改时，输出 token 很容易触顶，provider 返回 `finish_reason=length`，KeepSeek 只能提示用户调大 `maxTokens` 或缩小上下文。DraftEdit 创建在 [agentRunner.ts](/Users/kermit/Projects/kmvdata/keepseek/src/agentRunner.ts:568)。

第五类是流式连接脆弱。  
KeepSeek 使用 SSE streaming。只要网络、代理、provider、空闲超时或 fetch transport 提前断开，本轮就失败。已有部分正文会保留，但不会自动重连并从断点续写。流解析在 [deepSeekStreamParser.ts](/Users/kermit/Projects/kmvdata/keepseek/src/deepSeekStreamParser.ts:114)，错误处理在 [agentRunner.ts](/Users/kermit/Projects/kmvdata/keepseek/src/agentRunner.ts:476)。

第六类是没有真正的恢复机制。  
Provider 会把 partial output 加上错误文本保存下来，但没有把“已完成哪些工具、哪些文件已读、下一步该做什么”保存成可恢复 task state，也没有自动 retry、continue、resume。错误落盘逻辑在 [extension.ts](/Users/kermit/Projects/kmvdata/keepseek/src/extension.ts:1452)。所以一次流断或预算耗尽后，用户看到的是“停了”，而不是 Agent 自己接着跑。

第七类是记忆只有裁剪，没有压缩。  
发给模型的历史只取最近 24 条，UI 会话最多保留更多消息，但没有 session summary、任务摘要、文件阅读摘要、长期 working memory。历史构造在 [agentProtocol.ts](/Users/kermit/Projects/kmvdata/keepseek/src/agentProtocol.ts:29)，活跃会话裁剪在 [chatSessionStore.ts](/Users/kermit/Projects/kmvdata/keepseek/src/chatSessionStore.ts:296)。这会导致长任务后半段丢失前半段意图，模型要重新探索，进一步放大预算问题。

所以本质上，中断来自三件事叠加：探索效率低、上下文不可持续增长、失败后不能自动恢复。模型越强，只是能在单轮里做得更好；但没有 MCP/skills/检索/压缩/续写/重试这些 runtime 能力时，复杂 coding 任务仍然会被预算、连接和状态管理卡住。




## MCP 实现原理



可以这样理解一半，但关键要拆开：

**MCP Server 不是 Agent**
MCP server 通常只是“工具/资源/Prompt 提供者”，不是完整 Agent。它一般不负责和大模型对话，也不负责规划任务。真正的 Agent 仍然可以是 KeepSeek：KeepSeek 调 DeepSeek/OpenAI-compatible 模型，模型决定调用工具，KeepSeek 再把工具调用转发给 MCP server。

官方架构里也把角色分成 MCP Host、MCP Client、MCP Server：Host 是 AI 应用，Client 负责连接某个 server，Server 提供 context、tools、resources、prompts。MCP server 可以本地运行，也可以远程运行。参考 MCP 架构说明：<https://modelcontextprotocol.io/docs/learn/architecture>

所以更准确的关系是：

```text
KeepSeek = MCP Host + MCP Client + Agent Runtime
DeepSeek = LLM
MCP Server = 外部工具/资源提供者
```

而不是：

```text
另一个完整 Agent 应用负责干活
KeepSeek 只是辅助
```

**是否需要独立写一个应用？**

看你要接入什么能力。

最常见的 MCP server 是一个独立进程，比如 Node/Python CLI：

```text
KeepSeek 启动 server 子进程
  -> stdio JSON-RPC
  -> tools/list
  -> tools/call
```

这时候你确实会有一个“独立程序”，但它不是另一个 Agent，只是工具服务。官方 MCP transport 也明确支持 `stdio`，由 client 启动 server 子进程；也支持 Streamable HTTP，用于远程 server。参考 transport 规范：<https://modelcontextprotocol.io/specification/2025-06-18/basic/transports>

比如：

```text
KeepSeek
  -> mcp-server-playwright
  -> browser automation tools

KeepSeek
  -> github-mcp-server
  -> issues / PR / repo tools

KeepSeek
  -> local-code-index-mcp
  -> search / symbol / references
```

**能不能完全以 VS Code 插件形式提供？**

可以，但有两层含义。

第一种：VS Code 插件“注册/附带”一个 MCP server。  
VS Code 现在支持 MCP server，可以通过 `.vscode/mcp.json`、用户配置、自动发现、命令行、或者扩展注册 server definition。VS Code 文档也说扩展可以用 `vscode.lm.registerMcpServerDefinitionProvider` 注册 MCP server。参考 VS Code MCP 开发指南：<https://code.visualstudio.com/api/extension-guides/ai/mcp>

但这只代表“VS Code/Copilot 的 MCP 系统能看到它”。KeepSeek 不会自动获得这些工具，除非 KeepSeek 也接入 VS Code 的 MCP registry/API，或者自己读取同一份 MCP 配置并启动/连接这些 server。

第二种：你直接把工具写成 VS Code extension API。  
这可以深度集成 VS Code，但它不一定是 MCP。VS Code 文档也区分了 MCP servers、built-in tools、extension-contributed tools。对 KeepSeek 来说，如果不走 MCP，你仍然要给 KeepSeek 做一层工具注册和路由。

**对 KeepSeek 最合适的理解**

KeepSeek 不需要把自己降级成另一个 Agent 的壳。更自然的路线是：

```text
KeepSeek 继续做 Agent
增加 MCP client runtime
把 MCP tools 动态转换成 OpenAI-compatible function tools
模型 tool_call 时由 KeepSeek 转发到对应 MCP server
MCP result 再回填给模型
```

这样 KeepSeek 仍然掌握：

- 模型选择
- 会话
- 上下文
- 工具权限
- DraftEdit 安全写入
- 流式显示
- 错误归一化
- 预算控制

MCP 只是把“固定 4 个工具”扩展成“可配置、可发现、可复用的一组外部工具”。

**我会建议的方向**

优先做 KeepSeek 内置 MCP client，而不是另写完整 Agent。第一版可以只支持：

1. 读取 `.vscode/mcp.json` 或 `keepseek.mcpServers`
2. 支持 stdio server
3. initialize + tools/list + tools/call
4. MCP tool 转 OpenAI function tool
5. 工具名 namespacing，例如 `mcp__github__searchIssues`
6. 每个 server/tool 的用户授权和超时
7. 默认禁止高风险写操作，和 KeepSeek 现有 DraftEdit 安全模型保持一致

这样 KeepSeek 会从“固定本地工具 Agent”进化成“能接 MCP 工具生态的 Agent”，而不是变成另一个应用的附属 UI。