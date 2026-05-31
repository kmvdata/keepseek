# KeepSeek Agent 能力缺口与大任务中断分析

本文讨论 KeepSeek 当前作为 Agent 的不足，以及为什么它面对“大问题”时可能比 Claude/Codex 类客户端更容易中断。分析基于 `src/` 当前源码，不假设外部服务端有额外能力。

## 一、总判断

KeepSeek 当前已经实现了一个可用的轻量级 VS Code Agent：

- 可以和 DeepSeek/OpenAI-compatible Chat Completions 对话。
- 可以流式显示正文和 reasoning。
- 可以让模型调用 4 个固定本地工具。
- 可以把文件/目录/选区/日志显式加入上下文。
- 可以通过 DraftEdit 让 AI 生成待确认文件修改。

但它距离成熟 coding agent 还有明显差距。主要问题不是“模型不够聪明”，而是本地 Agent runtime 仍比较薄：没有 MCP、没有 skills、工具种类少、没有检索/索引/压缩、没有自动续写/重试/恢复，复杂任务一旦触发预算、上下文、输出长度或流式连接问题，就容易中断。

## 二、当前不合格或不足的地方

### 1. 没有实现 MCP

当前源码中没有 MCP client 或 MCP server 实现，也没有发现/加载 MCP server 的配置入口。

KeepSeek 目前的工具机制是 OpenAI-compatible function tools：

- 工具 schema 写死在 `agentProtocol.ts`。
- 工具路由写死在 `agentRunner.ts`。
- 工具实现写死在 `workspaceTools.ts` 和 DraftEdit 相关模块。
- 每次请求把这些固定 schema 发给模型，模型返回 `tool_calls` 后由本地执行。

MCP 通常还需要：

- 读取 MCP server 配置。
- 启动或连接 stdio/http/sse MCP server。
- 列出 server 提供的 tools/resources/prompts。
- 处理工具权限、授权提示、调用超时和错误归一化。
- 把 MCP resources/prompts 纳入上下文。
- 支持多 server、多 transport、多用户授权状态。

这些在当前 KeepSeek 里都没有。

结论：KeepSeek 现在不是“DeepSeek 原生 MCP Agent”，只是“DeepSeek/OpenAI-compatible function calling Agent”。

### 2. 没有 skills 系统

当前源码没有类似 Claude Skills、Codex Skills 或可安装技能包的机制：

- 没有 `SKILL.md` 或技能 manifest。
- 没有按任务选择技能的路由。
- 没有把技能说明、脚本、模板、资源动态注入 Agent。
- 没有技能安装、版本、启用/禁用、权限边界。

所以 KeepSeek 不能做到“遇到文档任务自动加载文档技能”“遇到前端任务自动加载浏览器验证技能”“遇到表格任务自动加载 spreadsheet 工具”这类能力。所有能力主要靠固定 system prompt 和 4 个本地工具。

### 3. 工具太少，且都偏只读

当前模型可用工具只有 4 个：

- 列工作区文件。
- 列工作区目录。
- 读工作区文件。
- 创建 DraftEdit。

缺少成熟 coding agent 常见能力：

- 搜索文本和符号，例如 grep/ripgrep、AST 搜索、引用查找。
- 读文件片段，而不是总是读完整文件。
- 运行测试、编译、lint、类型检查。
- 执行 shell 命令。
- 读取 git diff、git status、commit 历史。
- 应用补丁、局部 diff、冲突检测。
- 浏览器预览和交互测试。
- Web 搜索或文档查询。
- 多文件批量编辑后的验证循环。

这使得大任务必须通过“列目录 -> 读很多完整文件 -> 模型综合”的方式推进，既慢又容易膨胀上下文。

### 4. DraftEdit 是整文件写入，不是 diff/patch

`keepseek_create_draft_edit` 要求模型传入完整新文件内容。`SafeFileEditor` Apply 时直接 `writeFile()`。

优点是安全简单；缺点是：

- 修改大文件时输出 token 压力很大。
- 模型容易因为输出长度限制而给不完整文件。
- 不能表达小范围 patch。
- 没有三方 diff、冲突检测、基于原文件 hash 的防覆盖判断。
- 多文件复杂改动需要生成多个完整文件，成功率会下降。

### 5. 上下文检索和压缩能力弱

KeepSeek 目前主要依赖显式上下文和工具读取，没有代码索引或语义检索。

存在的问题：

- `keepseek_list_workspace_files` 可能返回最多 2000 个文件，文件列表本身就会吃掉上下文。
- `keepseek_read_workspace_file` 返回完整文件内容，不能只读匹配片段。
- 工具结果会不断追加到 messages，每轮请求都重新发送。
- 没有自动总结旧工具结果。
- 没有把长历史压缩成摘要。
- token 估算是字符级启发式，不是 DeepSeek 官方 tokenizer。

大任务里，模型读的文件越多，请求越大，后续每轮越慢，也越容易被服务商上下文限制、输出限制或网络连接影响。

### 6. 没有自动重试、自动续写和恢复

`AgentRunner` 对一次模型请求使用单个 `fetch()` 和 SSE stream。失败后会把错误写进会话，但不会自动：

- 重新连接 SSE。
- 从 partial output 继续。
- 在 `finish_reason=length` 后自动发“继续”。
- 把长任务拆成多个阶段。
- 保存工具调用 checkpoint 并恢复。
- 对临时 429/5xx/网络断开做指数退避重试。

Claude/Codex 类成熟客户端通常会有更厚的运行时保护层，所以同样的模型和 API，在不同客户端里稳定性可能差很多。

### 7. Provider 兼容性比较乐观

KeepSeek 发送的是 DeepSeek 风格的 OpenAI-compatible 请求，但并没有针对不同网关做 capability profile。

风险包括：

- 一些 OpenAI-compatible 网关不支持 `thinking`。
- 一些网关不支持 `reasoning_effort`，或支持的枚举不同。
- 一些网关不完整支持 streaming `tool_calls`。
- 一些网关不支持 `strict: true` tool schema。
- 一些网关返回的错误格式不同。
- 一些网关实际最大 `max_tokens` 低于 KeepSeek 默认的 64000。
- base URL 自动拼 `/chat/completions`，对特殊网关可能不够灵活。

如果你“用 Claude 配置 DeepSeek”时中间有 Claude/Anthropic 风格客户端或网关，它可能已经处理了这些兼容性差异，而 KeepSeek 目前是直接自己拼请求。

### 8. DSML 兜底是自定义兼容层，不是标准协议

`dsmlToolParser.ts` 能从文本里解析 DSML 样式工具调用，这是对模型输出异常的一种兜底。

它的局限：

- 只支持非常有限的标签结构。
- malformed DSML 可能解析失败。
- 参数解析不如原生 tool_calls 稳定。
- 它不能替代标准 function calling，更不能替代 MCP。

### 9. Busy 状态下再次发送会触发中止

输入区提交逻辑里，如果 `state.isBusy` 为 true，会发送 `abortPrompt`，清空输入框，而不是排队新请求。

这意味着：

- 大任务运行时，如果用户习惯继续打字然后按发送，当前任务会被中止。
- 用户可能以为是模型中断，实际是本地 UI 把“发送”解释成“停止”。
- 对长任务来说，这个交互需要更明确，例如按钮显式变成 stop，或禁止输入提交，或提供排队/另开会话。

## 三、大问题经常中断的可能原因

下面按“本地预算、服务商限制、网络流式、上下文膨胀、模型工具循环、用户交互”分类。

### 1. 达到本地总时长限制

默认 `keepseek.maxRunMs = 600000`，也就是 10 分钟。

大任务常见流程是：

```text
模型思考 -> 列文件 -> 读文件 -> 模型再思考 -> 再读文件 -> 生成长回答或 DraftEdit
```

每一次模型请求和工具执行都计入总时长。达到上限后，本地会 abort 当前请求或要求模型停止工具调用并总结。用户看到的可能是“达到总时长上限”或一次错误消息。

排查建议：

- 如果任务经常超过 10 分钟，把 `keepseek.maxRunMs` 调高，或设为 0 禁用本地总时长上限。
- 更推荐把任务拆小，例如先让它梳理结构，再针对某个模块深入。

### 2. 达到工具轮次或工具调用数限制

默认：

- `keepseek.maxToolIterations = 8`
- `keepseek.maxToolCalls = 24`

复杂问题很容易触发：

- 先列文件。
- 读入口文件。
- 再读引用文件。
- 再列子目录。
- 再读配置和测试。

如果模型探索范围太大，24 次工具调用并不多。达到上限后，KeepSeek 会阻止继续调用工具，让模型基于已有信息回答。回答可能不完整，用户会感觉任务“半路停了”。

排查建议：

- 如果错误文案提到工具轮次或工具调用数，提高 `maxToolIterations` / `maxToolCalls`。
- 给 prompt 明确范围，例如“只分析 src/agentRunner.ts 和 workspaceTools.ts”。
- 优先引用目录或关键文件，减少模型盲目列文件。

### 3. 工具结果 token 预算或上下文窗口估算触顶

默认 `keepseek.toolResultTokenBudget = 0`，表示本地按上下文窗口自动估算工具结果预算。自动估算依赖 `keepseek.contextWindowTokens`，默认是 1000000。

这里有两个相反风险：

- 如果 `contextWindowTokens` 设得过小，本地会过早停止工具调用。
- 如果 `contextWindowTokens` 设得过大，但服务商真实上下文更小，本地以为还没超，实际 API 可能报 context length 错误或断流。

此外，KeepSeek 的 token 估算是字符级启发式，无法完全等于服务商真实 tokenizer。

排查建议：

- 把 `keepseek.contextWindowTokens` 设置成所用模型/网关真实可用上下文，而不是盲目保留 1000000。
- 如果工具结果预算触顶，可以提高 `toolResultTokenBudget`，但更好的改法是增加“搜索/片段读取/摘要压缩”能力。

### 4. `finish_reason=length` 导致回答截断

KeepSeek 默认 `keepseek.maxTokens = 64000`。如果服务商认为生成预算耗尽，会返回 `finish_reason=length`。

Thinking/reasoning token 可能也消耗生成预算，所以肉眼看到的正文不一定很长，仍可能被截断。

当前 KeepSeek 的行为是：

- 在已有文本后追加一段提示，说明 DeepSeek 返回了 `finish_reason=length`。
- 不会自动继续发一轮“请从截断处继续”。

排查建议：

- 提高 `keepseek.maxTokens`，前提是服务商支持。
- 或设为 0，让服务商使用默认输出预算。
- 降低 reasoning effort 或关闭 Thinking。
- 要求模型“先给提纲，不要一次生成完整实现”。

### 5. SSE 流式连接被网络、代理或服务商关闭

`createChatCompletion()` 使用 streaming fetch。如果连接中途失败，错误会被归一化成“DeepSeek 流式连接在完成前中断”。任何已经收到的 partial output 会保留在会话里。

可能原因：

- 本地网络波动。
- 代理或公司网关关闭长连接。
- 服务商对长时间 streaming 请求有限制。
- 模型长时间 reasoning 没有输出 chunk，某些网关误判为空闲。
- Node/VS Code fetch 底层连接出现 `terminated`、`socket`、`network` 类错误。

`keepseek.streamIdleTimeoutMs` 默认是 0，也就是本地不启用空闲超时。但如果用户设置了非 0，长时间无 chunk 会被本地中止。

排查建议：

- 确认 `streamIdleTimeoutMs` 是否被设置过。如果经常因 idle 中止，设为 0 或调大。
- 尽量避免单次超长请求。
- 后续可以在代码里加自动重试和断点续写。

### 6. 请求体超过服务商真实限制

KeepSeek 会把以下内容一起发给模型：

- system prompt。
- context files。
- 最近 24 条历史消息。
- 当前 prompt 展开后的文件/目录引用。
- 工具 schema。
- 已有工具调用和工具结果。
- 输出保留预算和安全保留预算只用于本地估算，不会减少真实请求体。

如果用户一次引用大量文件，或历史里有很大的 `expandedContent`，请求体可能超过服务商真实上下文限制。

排查建议：

- 清空不必要的 context files。
- 新开会话处理大任务。
- 少用全文引用，多用行段引用或目录引用。
- 降低单次读取范围，后续需要工具层支持 read range/search。

### 7. 模型陷入工具调用循环

模型可能反复：

- 读不关键的文件。
- 列同一个目录。
- 因工具错误继续尝试。
- 不给最终回答，一直请求工具。

KeepSeek 用工具轮次和调用数限制兜底，但兜底本身会让任务提前结束。

根因通常是：

- system prompt 对“大任务探索策略”约束不足。
- 工具太粗，只能读完整文件，模型难以快速定位。
- 缺少 grep/search。
- 缺少阶段化 planner，不能先列计划再按最短路径读取。

### 8. Tool schema 与模型/网关不兼容

工具 schema 使用 `strict: true`，并且 `keepseek_list_workspace_directory` 的 `required` 包含 `path`、`recursive`、`maxFiles`。

如果某些兼容网关没有很好遵守 strict tool schema，可能出现：

- tool arguments 不是合法 JSON。
- `maxFiles` 缺失。
- `recursive` 类型不对。
- streaming tool call 参数拼接不完整。

KeepSeek 会把这些变成 JSON 错误结果给模型，但模型可能继续尝试，直到预算耗尽。

### 9. Apply DraftEdit 失败被误认为 Agent 中断

文件真正写入时，`SafeFileEditor` 会拒绝覆盖 dirty open editor/tab。

如果模型已经生成 DraftEdit，但用户 Apply 时目标文件有未保存修改，Apply 会失败。这不是模型中断，而是本地安全保护。

排查建议：

- 保存或关闭目标文件未保存修改后再 Apply。
- 后续可做 diff 预览和冲突检测，减少“整文件覆盖”的风险。

## 四、为什么 Claude 配置 DeepSeek 可能更不容易中断

即使用的是同一个 DeepSeek 模型，客户端运行时也会显著影响稳定性。

Claude/Codex 类工具可能具备 KeepSeek 当前缺少的能力：

- 更长或更合理的默认运行超时。
- 自动重试 429/5xx/网络断流。
- `finish_reason=length` 后自动续写。
- 更成熟的工具选择和工具结果压缩。
- 更丰富的本地工具，例如 grep、读片段、shell、git、测试。
- MCP server 接入，工具能力不是写死的 4 个函数。
- Skills 机制，按任务注入专门 instructions 和脚本。
- 长上下文自动摘要和会话压缩。
- Provider capability profile，不同网关走不同请求字段。
- 更清楚的 stop/send UI，不容易误触中止。

所以差异不一定是 DeepSeek 模型本身，而是 Agent runtime 的工程能力差异。

## 五、如何定位一次中断属于哪类问题

优先看 assistant 消息或错误文案：

| 现象/文案 | 高概率原因 | 优先检查 |
|---|---|---|
| `工具调用轮次已达上限` | `maxToolIterations` 太小或模型探索过散 | 调高轮次，缩小任务范围 |
| `工具调用总数已达上限` | `maxToolCalls` 太小 | 调高调用数，增加搜索工具 |
| `工具结果 token 预算已达上限` | 读了太多/太大的文件 | 减少全文读取，调整预算或上下文窗口 |
| `达到总时长上限` | `maxRunMs` 超时 | 调高或禁用，拆分任务 |
| `finish_reason=length` | 生成预算耗尽 | 调高 maxTokens、关闭/降低 Thinking、自动续写 |
| `流式连接在完成前中断` | 网络/代理/服务商 SSE 断流 | 检查代理和 idle timeout，增加重试 |
| `API request failed (400/413/422)` | 请求字段或上下文过大 | 检查网关兼容性、contextWindowTokens、maxTokens |
| 空回复或只剩错误 | 服务商过滤、无 chunk、解析失败 | 看具体错误和 `finish_reason` |
| 运行中再次按发送后停止 | UI busy submit 触发 abort | 避免运行时提交，后续改 UI |

## 六、短期配置建议

如果你主要想减少大任务中断，可以先试这些配置：

| 配置 | 建议 |
|---|---|
| `keepseek.maxRunMs` | 调到 1800000 或 0，避免 10 分钟上限 |
| `keepseek.maxToolIterations` | 从 8 调到 16 或 24 |
| `keepseek.maxToolCalls` | 从 24 调到 64 或 128 |
| `keepseek.maxTokens` | 服务商支持时调高；如果网关不支持大值，设为 0 用默认值 |
| `keepseek.streamIdleTimeoutMs` | 保持 0；如果必须设置，至少给长 reasoning 留足时间 |
| `keepseek.contextWindowTokens` | 设成当前模型/网关真实上下文，不要只看默认 1000000 |
| `keepseek.maxWorkspaceToolFiles` | 大仓库可适当降低，减少一次 list files 返回过大 |

同时，prompt 层面建议：

- 把大任务拆成“理解结构 -> 定位问题 -> 给方案 -> 生成修改”。
- 优先引用目标目录或关键文件，不要一次塞很多全文文件。
- 明确要求“先列计划，缺文件再读，不要遍历全仓库”。
- 修改大文件时先让模型给 patch 思路，再让它生成 DraftEdit。

## 七、代码层改进路线

### P0：先提升稳定性

1. 给 API 请求增加 retry：
   - 对 429、5xx、fetch terminated、socket/network 做指数退避。
   - retry 前保留已收到 partial output。

2. 支持自动续写：
   - 当 `finish_reason=length` 时，自动追加“从上次截断处继续，不要重复已输出内容”。
   - 设置最大续写次数，避免无限循环。

3. 改 busy submit 行为：
   - 运行中发送按钮明确变成 stop。
   - 用户在运行中输入新内容时，不要回车就 abort。
   - 可选：排队新请求或提示“当前任务运行中”。

4. 增加更明确的错误分类：
   - 在 UI 中区分本地预算、服务商 finish_reason、网络断流、用户手动停止。

### P1：补齐代码 Agent 必需工具

1. 增加 `keepseek_search_workspace`：
   - 用 ripgrep 或 VS Code workspace search 搜索文本。
   - 返回匹配文件、行号、上下文片段。

2. 增加 `keepseek_read_workspace_file_range`：
   - 按行范围读取文件片段。
   - 避免读完整大文件。

3. 增加 `keepseek_get_workspace_symbols` 或文件大纲：
   - 让模型先看结构再决定读哪些块。

4. 增加安全命令工具：
   - 初期只允许白名单命令，例如 `npm run compile`、`npm run lint`。
   - 每次执行有超时和输出截断。

5. 增加 git 工具：
   - `git status --short`
   - `git diff`
   - `git show`
   - 只读优先。

### P2：改进编辑能力

1. DraftEdit 从整文件扩展到 patch/hunk。
2. Apply 前记录原文件 hash，检测用户改动。
3. 提供 diff preview。
4. 多 DraftEdit apply 时做事务式失败报告。
5. 对大文件修改优先要求模型输出局部 patch。

### P3：引入 MCP

MCP 可以作为独立能力层，不应混进 `AgentRunner` 太深。建议新增：

- `mcpConfig.ts`：读取 MCP server 配置。
- `mcpClient.ts`：连接 stdio/http/sse MCP server。
- `mcpToolRegistry.ts`：把 MCP tools 转成 DeepSeek/OpenAI-compatible tool schema。
- `mcpResourceStore.ts`：管理 MCP resources/prompts。
- `mcpPermissionStore.ts`：记录工具权限和用户确认策略。

然后 `AgentRunner` 继续依赖抽象 tool adapter，而不是直接知道所有 MCP 细节。

### P4：引入 skills

可以设计 KeepSeek 自己的轻量 skills：

```text
skills/
  code-review/
    SKILL.md
    scripts/
  frontend-debug/
    SKILL.md
  vscode-extension/
    SKILL.md
```

需要能力：

- skill manifest。
- skill 选择器。
- skill prompt 注入。
- 可选脚本/模板。
- 权限声明。
- 与 MCP/tools 的关联。

这样 KeepSeek 可以根据任务类型加载不同工作流，而不是所有任务都只靠一个通用 system prompt。

### P5：上下文压缩和任务分解

1. 工具结果摘要：
   - 读大文件后先在本地或模型侧生成摘要。
   - 后续轮次只保留摘要和必要片段。

2. 分阶段 planner：
   - 大任务先生成计划。
   - 每阶段限制工具调用范围。
   - 阶段结束保存 checkpoint。

3. 历史压缩：
   - 超过阈值后把旧对话压缩成 session summary。
   - 保留关键文件、结论、未完成事项。

4. 更准确 token 估算：
   - 对 DeepSeek/OpenAI-compatible 模型使用更接近真实 tokenizer 的估算。
   - 至少按模型配置区分上下文和输出预算。

## 八、推荐优先级

如果目标是“先让大问题少中断”，建议优先顺序：

1. 改 busy submit 的中止行为。
2. 增加 API retry 和 `finish_reason=length` 自动续写。
3. 增加搜索工具和按行读取工具。
4. 改善工具结果压缩，减少完整文件读入。
5. 把运行预算 UI 里增加“推荐长任务设置”。
6. 再考虑 MCP。
7. 再考虑 skills。

MCP 和 skills 能显著扩展能力，但它们不是解决“大任务中断”的第一刀。真正最先影响稳定性的，是请求恢复、续写、搜索/片段读取、上下文压缩和 UX 防误停。

