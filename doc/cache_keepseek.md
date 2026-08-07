# KeepSeek 缓存命中优化技术与原理

> 面向 KeepSeek 维护者与进阶使用者。本文基于当前仓库源码（`src/` 与 `test/`）整理，详细描述 KeepSeek 为提升 DeepSeek「上下文前缀缓存」命中率所使用的全部技术手段，并解释每一项技术背后的原理。文中行号以当前仓库为准，可能与后续提交有小幅偏移。

## 1. 背景：为什么缓存命中如此重要

### 1.1 DeepSeek 的上下文缓存模型

DeepSeek API 提供服务端上下文缓存（context caching / prompt prefix cache）：当一次请求的 prompt **从 token 0 起**与历史请求**逐字节一致**时，命中的前缀不需要重新计算 KV（key-value）缓存，直接复用上次的注意力计算结果，并大幅降低计费单价。

这里的两个关键限定词是：

- **从 token 0 起**：缓存是按「前缀」组织的。只要第 N 个 token 与上次不同，第 N 个 token 之后的所有 token 全部 miss。
- **逐字节一致**：缓存命中要求字节级精确匹配（服务端按 token 序列做前缀匹配，任何字节差异都会使该位置之后的全部内容失效）。它不是语义相似度匹配。

### 1.2 计费差异：命中与未命中相差 50~120 倍

KeepSeek 默认价格表（`src/shared/config.ts` 的 `DEFAULT_USAGE_PRICING`）：

| 模型 | 缓存命中价（¥/M tokens） | 输入价（¥/M tokens） | 输出价（¥/M tokens） |
|---|---|---|---|
| `deepseek-v4-flash` | 0.02 | 1 | 2 |
| `deepseek-v4-pro` | 0.025 | 3 | 6 |

缓存命中的输入成本只有全价的 **1/50（flash）到 1/120（pro）**。

在 agent 场景下，一次请求的 prompt 由「系统提示 + 稳定上下文 + 历史消息 + 工具定义 + 当前 prompt」构成，其中历史与工具定义往往占据绝大部分 token。因此**多轮会话的每一轮请求，本质上大部分 token 都是重复发送的旧内容**。如果这些旧内容能命中缓存，成本几乎可以忽略；如果命中不了，每一轮都要为全部上下文按全价付费。

这也是 `usageStats` 专门统计 `cacheHitTokens`、计算命中率并做失效归因的原因（`src/agent/usageStats.ts` 的 `normalizeDeepSeekUsage` / `calculateCacheHitRate`）。

### 1.3 缓存命中的核心矛盾

缓存命中的前提是**字节级前缀稳定**：这一轮的请求必须是上一轮请求的前缀（或完全相等）。但 agent 会话天然是「增长的」——每轮都会追加新消息。KeepSeek 面临的核心问题是：

> 如何在**上下文不断增长**（必须追加新内容）和**上下文不断变化**（摘要压缩、技能激活、工具裁剪等都可能改写旧内容）之间，维持一个尽量稳定的前缀？

KeepSeek 的全部缓存优化技术，都是围绕「**制造并守护一个字节稳定的前缀**」展开的。

## 2. 总体设计原则

KeepSeek 的请求组装遵循三个互相配合的原则（实现核心在 `src/agent/protocol.ts` 的 `buildInitialAgentMessages`）：

1. **分层前缀（base-first）**：请求被拆成「极少变化的段」和「只增长的段」。system 系统提示、稳定上下文块、工具定义放在最前；历史消息按追加顺序居中；当前用户 prompt 放在最后。变化频率越低的段越靠前，保证任意一段变化时，被它「带失效」的后续内容尽量少。
2. **Append-only 历史（只增不改）**：历史消息一旦进入投影就只增不改。任何「滑动窗口」「逐轮重打包」机制都会删除或重写中间消息，使第一个变化消息之后的所有内容 miss。
3. **低频失效点（low-frequency invalidation）**：一切需要改写前缀的操作（摘要压缩、技能重激活、上下文块重算、工具集裁剪）都被刻意压低频率，或者做成「字节不变则复用」，把前缀失效的次数压到最少。

请求的最终形态（`buildInitialAgentMessages`，`src/agent/protocol.ts:80-126`）：

```text
messages = [
  system      ← 固定 agent 系统提示（跨轮字节不变）
  system      ← contextInstructions 稳定上下文块（AGENTS.md/Skills/Legacy Memory/Context Files）
  system*     ← synthetic summary（历史压缩摘要，低频刷新）
  user        ← 历史消息（append-only，逐字节还原）
  assistant   ← 历史消息（toolRounds 展开为 assistant(tool_calls) → tool → assistant）
  ...
  user        ← 当前 prompt（trim 后；与历史末条 user 相同则不重复发送）
]
```

## 3. 技术详解

### 3.1 固定 system 提示（base-first 分层）

**做什么**：`getAgentSystemPrompt`（`src/agent/protocol.ts:249-...`）生成 agent 的固定系统提示，只依赖语言，**不依赖任何上下文、历史或 prompt**。`buildInitialAgentMessages` 把它固定在 `messages[0]`。

**原理**：system[0] 是请求前缀的最开头。只要它不变，前缀的「头」就是稳定的；它后面任何段的变化都不会波及它。把「所有与运行状态无关的指令」全部收进这条固定消息，是缓存稳定性的第一道保险。

**失效时机**：从不（除非改代码或切换语言）。

**测试守护**：`test/cacheByteStability.test.ts` 断言 system prompt 不随 contextInstructions/历史变化。

### 3.2 稳定上下文块 contextInstructions（字节不变则复用）

**做什么**：AGENTS.md 项目指令、激活的 Skills、Legacy Project Memory、Context Files 这些「动态上下文」统一由 `formatCurrentRunContextForAgent`（`src/agent/protocol.ts:212-243`）格式化为**第二条 system 消息**，而不是塞进 user 消息。

在 Provider 侧，格式化结果被持久化为 `ChatSession.contextInstructions`：**每一轮重算一次格式化结果，只有输出字节真的变化（AGENTS.md / Skills / Legacy Memory / Context Files 任一改变）才整体重写会话字段**（`src/provider/KeepseekChatViewProvider.ts:2362-2371`）；字节不变时跨轮复用，缓存代价为零。

**原理**：

- 这些内容放进独立的 system 块，使 system[0] 完全不受它们影响；
- user 消息保持「纯 prompt」，跨轮字节一致——如果把这些内容塞进 user 消息，user 消息的字节会随上下文变化，历史重放时全部 miss；
- 「重算但字节不变则不写」是一个精妙的机制：**计算**是廉价的（每轮做一次字符串格式化），**写入会话**才是昂贵的（会改变后续请求的字节）。把「计算」和「提交」分离，让缓存只在不变量被破坏时才失效。

**失效时机**：仅当 AGENTS.md / Skills / Legacy Memory / Context Files 的真实内容发生变化（此时前缀本来就会在该点之后失效，顺势重写）。

**测试守护**：`test/cacheByteStability.test.ts`（相同输入必得相同输出、不同输入必得不同输出）、`test/protocolCache.test.ts`（context files 只进 system 块、user 消息无包装）。

### 3.3 Append-only 历史投影（historyProjection）

**做什么**：`buildHistoryProjection`（`src/agent/historyProjection.ts:49-111`）决定每一轮请求发送哪些历史消息。它的核心规则是：

1. **投影成员 = 受保护消息 ∪ 所有未被摘要覆盖的消息**。`recentMessageIds`（最近 N 轮）只决定一条消息「是否可被压缩」，**绝不决定它是否留在投影里**。
2. **消息字节终身冻结**：消息在投影中始终以 `(expandedContent ?? content)` 形态出现，序列化字节跨轮不变。
3. **降级兜底**：仅当无摘要可用且投影超 token 预算时，才截断到最近消息（`capProjectionToTokenBudget`）。这是压缩持续失败的罕见失败路径，正常 append-only 路径永不触发。

源码注释（`historyProjection.ts:59-65`）直接写明了设计动机：

> 缓存优先投影：选中的消息是 append-only 的。消息创建即进入投影，只有摘要刷新覆盖它时才离开——这是刻意选定的低频失效点。如果滑动 recent-turn 窗口，每轮都会删除或重写中间消息，使第一个变化消息之后的所有内容都 miss（DeepSeek 前缀缓存要求 token 0 起字节相同）。

**原理**：对比两种方案——

- **滑动窗口方案**：每轮只保留最近 N 轮消息。第 2 轮发送 `[m1, m2]`，第 3 轮变成 `[m2, m3]`——m1 被删、m3 是新的，从 m2 之后全部 miss，而且每轮 miss 一次。缓存几乎永远不命中。
- **append-only 方案**：第 2 轮发送 `[m1, m2]`，第 3 轮发送 `[m1, m2, m3]`——第 2 轮的请求是第 3 轮请求的**完整前缀**，服务端从 token 0 一路命中到上一轮末尾，只有新追加的 m3 需要按全价计费。

净效果：多轮会话中，前缀只**增长**，中间任何字节都不变。命中率随轮次增加而趋于接近 100%（只有最后追加的消息 miss）。

**失效时机**：从不（正常路径）。唯一例外是摘要刷新覆盖旧消息（见 3.5）。

**测试守护**：`test/historyProjection.test.ts`（无摘要时全量保留、前缀只增长）。

### 3.4 受保护消息（Protection）

**做什么**：`getAutoProtectionReason`（`src/agent/historyProjection.ts:167-196`）按内容特征识别「不该被压缩」的消息，并标记为受保护：

- 首条 / 末条 user 消息（会话的起点与当前任务）；
- 显式要求保留的消息（匹配「记住/保留/不要忘记/始终/偏好/约束/remember/always/from now on/preference/constraint」等关键词）；
- 用户纠正类消息（「不对/不是/纠正/actually/correction」等）；
- 重要错误 / 测试输出（含 stack trace、`error:`、`npm err!` 等标记且内容足够长或有代码块）；
- DraftEdit 结果（「待确认修改/已准备…修改」等）。

**原理**：摘要压缩会**删除**被覆盖的消息，而删除任何一条消息都会让该消息之后的全部前缀失效。受保护消息是「业务上不可丢失」的内容——它们被压缩掉会导致模型遗忘关键约束或错误信息。KeepSeek 用内容特征把它们从「可压缩集合」里剔除，**既保护了对话语义，又避免了一次本可避免的压缩触发**（压缩是可压缩消息数量驱动的，保护消息越多，触发越晚）。

**失效时机**：从不（保护是永久的，除非会话被编辑重发）。

### 3.5 低频历史压缩（historyCompressor）——失效点管理的关键

**做什么**：历史压缩（把旧消息替换成一条摘要）是**必须的**——否则会话无限增长会撑爆 100 万 token 的上下文窗口。但每次摘要刷新都会：

- 重写 synthetic summary system 消息（字节变化）；
- 把被覆盖的消息从投影中删除（历史段被改写）。

这两件事都会让前缀从摘要处起全部失效。因此压缩被设计成**低频失效点**（`src/agent/historyCompressor.ts:34-38` 注释：「Deliberately high: every summary refresh rewrites the synthetic summary message and drops covered messages from the projection... Keep refreshes rare (a low-frequency cache-invalidation point) instead of sliding the recent-turn window every turn」）。具体手段：

1. **增量阈值**：已有摘要时，新增可压缩消息 ≥ 48 条（`SUMMARY_INCREMENTAL_MESSAGE_THRESHOLD = 48`，`historyCompressor.ts:38`）且占用比超过 `triggerRatio` 才刷新。普通对话几轮内不会触发。
2. **比率闸门**：原始会话 token 占上下文窗口比例低于 `triggerRatio` 时直接 `fresh_enough` 跳过（`shouldRefreshSummary`）。各模型的 `triggerRatio / forceRatio / summaryBudgetTokens` 见 `src/shared/modelProfiles.ts`（例如 flash 非思考模式：0.58 / 0.72 / 6000 tokens）。
3. **确定性摘要**：摘要请求 `temperature: 0`、关闭 thinking、限制输出 token、短超时（`historyCompressor.ts:347-349`）。摘要刷新时「被覆盖消息的变化」是不可避免的成本，**不能再叠加模型输出的随机字节漂移**——温度 0 保证同一输入得到同一摘要，后续增量刷新时摘要本身不再无故变化。
4. **C3 失败自锁**：上次刷新失败时暂停自动刷新（`shouldRefreshSummary` 中的 `lastFailureReason` 检查），避免「缓存已经受伤」的情况下反复触发可能再次失败的刷新；只有接近/超过强制上限（`forceRatio`）时才允许重试，保护上下文窗口。
5. **分级执行**：超过 `forceRatio` 同步强制压缩（`force_context_limit`）、无摘要且接近上下文上限时同步创建（`missing_summary_near_context_limit`），其余情况走后台刷新（`planRefresh`）——前台请求不被压缩延迟阻塞。

**原理**：压缩是「用一次大的缓存失效，换取未来很多轮的小前缀」。如果每轮都压缩，等于每轮都失效；如果把压缩推迟到增量 48 条或占用比 58% 才做，那么两次压缩之间可能间隔几十轮请求，期间每一轮都几乎全量命中。这是典型的「批量失效」思想：**让失效次数最小化，而不是让失效内容最小化**。

**失效时机**：每 ≥48 条可压缩消息且超比率（后台）/ 超强制比率（同步）。

### 3.6 工具集 schema 稳定性

**做什么**：工具定义（`tools` 段）位于请求前缀的中前部，其 JSON 字节必须跨轮一致。KeepSeek 用三层手段保证：

1. **完整工具集固定**：默认暴露的 `ALL_AGENT_TOOL_NAMES` 是常量列表（`src/agent/protocol.ts:44-63`），不随 prompt 变化。只要用户不开 slim 模式，每轮请求的工具集完全相同。
2. **schema 规范化**：`getAgentTools` 输出的 tools 经 `canonicalizeDeepSeekTool` 处理（`src/agent/protocol.ts:805-834`）——对象 key 递归排序、`required` 数组排序、补全空 `properties`，保证同一工具集生成的 JSON 逐字节相同（即使内部构造顺序不同）。
3. **slim 模式默认关闭 + per-session 冻结**：`DEFAULT_SLIM_TOOL_MODE_ENABLED = false`（`src/shared/config.ts:23-27`）。slim 模式按 prompt 关键词裁剪工具集（如出现 git 字样才暴露 git 工具），会让 tools 段随 prompt 变化而失效，因此默认关闭。若用户显式开启，工具集在**首次真实请求时确定并冻结**（`slimToolNamesBySession`，`src/provider/KeepseekChatViewProvider.ts:2354-2356`），后续轮次不再按关键词变化；编辑重发时删除冻结、按新 prompt 重新确定（`KeepseekChatViewProvider.ts:2336-2340`）。

**原理**：tools 段是一段很大的 JSON（每个工具的 description、parameters 都很长），位于前缀中部。它一变，其后所有历史消息 + 当前 prompt 全部 miss。工具集「固定 + 规范化」确保：无论模型调用多少次工具、无论代码内部以什么顺序构造工具列表，发出的 JSON 字节都一样。slim 模式本质上是在「更小的 prompt（更少 token，但缓存更容易失效）」和「更大的固定 schema（更多 token，但缓存稳定）」之间做取舍，KeepSeek 默认选择后者。

**失效时机**：会话开始（slim 冻结时）/ 编辑重发 / 切换模型。普通轮次从不。

**测试守护**：`test/protocolCache.test.ts`（tools schema 顺序按工具名规范化、不同输入顺序得到相同 JSON；slim 冻结后 schema 跨轮一致）。

### 3.7 implicit Skill 会话冻结

**做什么**：隐式激活的 Skills（按 prompt 关键词匹配，如 prompt 提到 review 就激活 review skill）会随 prompt 变化而改变 Skills 块字节。KeepSeek 的解法是**会话内冻结**：

- 首次真实请求（prompt 非空）时，把隐式激活结果写回 `session.frozenImplicitSkillIds`（**空集也冻结**，`src/skills/skillStore.ts:185-195`）；
- 之后每轮跳过关键词匹配，只按冻结 id 激活，activation reason 固定为 `'Frozen from the first user request of this chat session.'`（`src/skills/skillActivationResolver.ts:31-35, 59-61, 74-81`）；
- 失效时机被严格限定在「本来就会重写前缀」的事件：刷新 Skills、启用/停用 Skill、编辑重发（`invalidateImplicitSkillSnapshot`，`src/skills/skillStore.ts:239-243`；`KeepseekChatViewProvider.ts:1324, 1373, 1389, 2336-2340`）——此时前缀本来就从该点失效，顺势重算。

**原理**：与 slim 冻结同理。implicit skill 的匹配对象是「当前 prompt」，而 prompt 每轮都变；如果不冻结，几乎每轮都会出现「某个 skill 被移出/加入激活集」，Skills 块字节随之变化，其后全部 miss。冻结后，激活集在会话内恒定——**用「首轮可能不是最优的技能组合」换取「整个会话的字节稳定」**。同时「空集也冻结」很关键：否则第一轮没有技能、第二轮 prompt 匹配到技能，第二轮就要重写前缀。

**失效时机**：会话开始（首次真实请求）/ 编辑重发 / Skills 显式变更。

**测试守护**：`test/cacheByteStability.test.ts`（冻结后 skills 块字节稳定、请求序列保持字节前缀）。

### 3.8 上下文去重与确定性规范化

**做什么**：`deduplicateContextSources`（`src/agent/contextDeduplication.ts:26-84`）在把 AGENTS.md / Skills / Context Files 组装进上下文块前做去重：

- **URI 规范化**：`normalizeUri` 统一反斜杠、尾斜杠、win32 盘符大小写（`src/agent/projectInstructions.ts`），同一文件不会以不同 URI 出现两次；
- **内容 hash 去重**：`hashContent` 对 `\r\n` 归一化后做 sha256，相同内容跨来源只保留一份；
- **确定性排序**：候选按优先级稳定排序（project 30 / explicit 40 / session 45 / workspace-default 50 / implicit 60 / legacy 70，`src/agent/currentRunContext.ts`），Skills 内容按字符预算截断并 CRLF 归一化。

**原理**：去重有两个缓存收益——（1）**减少 prompt 体积**，体积越小，每轮全价计费的部分越少；（2）**保证字节确定性**，同一文件经不同路径（如 `C:\a` 与 `c:/a`）进入上下文时，若 URI 不同会被视为不同来源，可能重复注入；排序不稳定则相同内容在不同轮次可能顺序不同，直接破坏字节稳定。CRLF 归一化则防止「同一文件在 git 检出换行风格变化时」造成无谓的字节漂移。

**失效时机**：从不（相同状态下输出确定）。

### 3.9 工具输出字节确定性

**做什么**：`tool` 角色的消息（工具调用结果）也参与前缀。KeepSeek 对工具输出做确定性处理，保证「工作区状态相同则输出字节相同」：

- 文件列表确定性排序（`files.sort` localeCompare，`src/agent/tools/workspaceTools.ts`）；
- CRLF 统一归一化为 `\n`；
- 固定截断边界：搜索结果每行 500 字符加 `...`（`shapeSearchLine`，`workspaceTools.ts:1092-1099`）、范围读取行数 clamp、UTF-8 字节二分截断（`truncateToUtf8Bytes`）；
- git 输出固定上限与 preview 截断（`src/agent/tools/gitTools.ts`）。

**原理**：工具输出是历史中体积最大、最容易「不稳定」的部分。同一个 `keepseek_list_workspace_files` 结果，如果两次调用返回的文件顺序不同（取决于文件系统枚举顺序）或换行风格不同，字节就不同，从该 tool 消息之后全部 miss。确定性排序 + 归一化 + 固定截断把「同一状态的输出」钉死在同一个字节序列上。

**失效时机**：从不（工作区状态不变时）；工作区文件变化时输出自然变化，这是真实信息变化，缓存失效是合理代价。

### 3.10 并发与顺序控制

**做什么**：前缀稳定性还要求「同一时刻只有一个东西在改这段会话」：

- **单飞**：普通聊天与后台运行互斥，同一工作区同时最多一个后台 run（`src/provider/KeepseekChatViewProvider.ts`、`src/agent/backgroundRunCoordinator.ts`）；
- **压缩串行化**：per-session 后台压缩用 Map 去重，前台刷新前先 await 后台刷新（`src/agent/agentRequestCoordinator.ts`），避免并发压缩改写 history 段；
- **后台轮次不破坏前缀**：后台 run 复用同一 session 与同一发送路径，只在该会话消息上 append，后台 prompt 是固定模板，字节稳定。

**原理**：前缀稳定是「全局不变量」。如果两个并发流程同时改写同一会话（例如后台压缩正在把旧消息换成摘要、前台请求同时基于旧投影发送），即使各自逻辑正确，也会产生「互相覆盖」的中间状态，导致请求字节不可预测。单飞 + 串行化保证每次字节变更都是确定性的、可复现的。

**失效时机**：不适用（它防止的是「意外失效」）。

### 3.11 历史字节还原与当前 prompt 去重（B1/B4 契约）

**做什么**：历史重发时的字节路径与首次发送时完全一致，这是缓存命中的直接守护：

- **user 消息**：一律取 `(expandedContent ?? content).trim()`（`src/agent/protocol.ts` 的 `getMessageContentForAgent`）。引用展开（`<path#L1-L5>`）在首次发送时就写进 `expandedContent` 并原样保存，重发时不再重新展开——否则「首次以 prompt 身份发送、之后以历史身份重发」会得到不同字节。
- **assistant 消息**：按 `toolRounds` 还原为 `assistant(tool_calls) → tool → assistant(最终文本)` 的完整序列（`appendHistoryMessage`，`protocol.ts:128-160`），`reasoning_content` 与 `tool_call_id` 一并保留。上一轮请求中「模型发起的工具调用 + 工具结果」在下一轮必须以完全相同的字节重现。
- **当前 prompt 去重**：若当前 prompt 与历史最后一条 user 消息内容相同，则不重复追加（`findCurrentPromptMessage`，`protocol.ts:779-791`）——否则「上轮刚问过、这轮再点一次发送」会白白追加一条重复 user 消息，且字节上还会多出这条消息导致其后内容错位。

**原理**：缓存命中的前提是「上一轮的请求字节 ⊑ 这一轮的请求字节」。如果历史消息在重发时经过不同的处理路径（比如首次发送时做了引用展开、重发时没做），同一逻辑消息就会产生不同字节，前缀在第一条历史消息处就断了。B1/B4 契约的本质是：**每一条消息只允许有一种字节形态**。

**测试守护**：`test/cacheByteStability.test.ts` 的 B1 契约（第一轮完整请求是第二轮请求的字节前缀）、expandedContent 跨轮原样、B4 契约（toolRounds 跨轮重建与上一轮发送序列逐字节一致）、带工具调用前缀契约。

## 4. 命中率的度量、指纹与失效归因

光有「稳定的前缀」还不够——如果服务端缓存被逐出（LRU、容量、时间），命中率也会掉。KeepSeek 需要能区分「**KeepSeek 自己改了前缀**」与「**服务端把缓存逐出了**」。为此它做了三层监控：

### 4.1 usage 归一化与命中率

`normalizeDeepSeekUsage`（`src/agent/usageStats.ts:14-43`）兼容两类计数字段：新版 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` 与旧版 `prompt_tokens_details.cached_tokens`，归一化为 `cacheHitTokens / cacheMissTokens`，并据此计算命中率（`calculateCacheHitRate`）与成本（`calculateUsageCost` 使用 `cacheHitPrice`）。命中率与成本在会话/轮次粒度持久化，webview 展示命中率百分比。

### 4.2 请求前缀指纹

`createPromptCacheDiagnostics`（`src/agent/runner.ts:1487-1518`）在每轮请求发出前记录三类指纹：

- `systemPromptHash`：所有 system 消息拼接的 sha256；
- `toolsSchemaHash`：tools JSON 的 sha256；
- `historyPrefixHash`：system 段之后全部消息（含 `tool_calls` / `reasoning_content`）的 sha256。

指纹跨轮不变即前缀缓存可命中；指纹变化则说明是 KeepSeek 自己改了前缀。

### 4.3 失效归因

`getCacheMissPossibleReasons`（`src/agent/usageStats.ts:161-198`）按证据强弱归因：

- **无条件归因**：system 提示变化、tools schema 变化、模型切换——这是前缀整段失效的直接证据，不依赖命中率门槛；
- **历史重写**：`historyCompacted`（用了摘要）、`historyRewriteReason`（如编辑重发）直接上报；
- **带门槛归因**：history 段在 append-only 投影下每轮追加新消息、`historyPrefixHash` 逐轮变化是**预期行为**；只有当命中率从 ≥60% 跌 ≥30 个百分点时，才把 history 变化（`history_prefix_changed`）或 provider 缓存逐出（`prefix_changed_or_provider_cache_evicted`）列为候选原因。

归因结果写入会话的 `promptCacheDiagnostics` 并在扩展侧 `console.debug` 告警，用于判断「是 KeepSeek 改了前缀还是服务端逐出了缓存」。

## 5. 契约测试守护

缓存稳定性由一组「字节契约」测试守护（`test/cacheByteStability.test.ts`、`test/protocolCache.test.ts`、`test/historyProjection.test.ts`、`test/historyCompressor.test.ts`），任何破坏前缀稳定的改动都会红：

| 契约 | 测试 | 验证内容 |
|---|---|---|
| B1 | `cacheByteStability.test.ts` | 同一 user 消息以 prompt / 历史两种身份发送字节一致；第一轮请求是第二轮请求的字节前缀 |
| 引用展开 | `cacheByteStability.test.ts` | `expandedContent` 跨轮原样，不因发送时机改变 |
| B4 | `cacheByteStability.test.ts` | `toolRounds` 跨轮重建与上一轮发送序列逐字节一致 |
| 带工具前缀 | `cacheByteStability.test.ts` | 带 `tool_calls`+`tool` 消息的请求序列是下一轮请求的字节前缀 |
| contextInstructions | `cacheByteStability.test.ts` | 相同输入必得相同输出，不同输入必得不同输出 |
| system 稳定 | `cacheByteStability.test.ts` | system[0] 不随上下文/历史变化 |
| 冻结 + append-only | `cacheByteStability.test.ts` | Skills 冻结后块字节稳定，请求序列保持字节前缀 |
| context files 位置 | `protocolCache.test.ts` | context files 只进稳定 system 块，user 消息是纯 prompt |
| 工具 schema 规范化 | `protocolCache.test.ts` | tools 按名排序、JSON 相等 |
| slim 冻结 | `protocolCache.test.ts` | 冻结后同一工具集 schema 跨轮一致 |
| 压缩低频 | `historyCompressor.test.ts` | 低于比率不刷新（`fresh_enough`）、超强制比率同步刷新 |
| 投影 append-only | `historyProjection.test.ts` | 无摘要时全量保留、前缀只增长 |

这些测试用 `JSON.stringify` 级别的字节比较而不是语义比较——因为它们守护的正是「字节」这个缓存命中的唯一契约。

## 6. 设计权衡总结

| 机制 | 缓存收益 | 代价 | 失效点频率 |
|---|---|---|---|
| system 提示分层 | system[0] 永不变 | 代码结构约束 | 从不 |
| contextInstructions 字节复用 | 上下文块只在真实变化时重写 | 每轮重算一次格式化 | 内容变化时 |
| append-only 历史投影 | 前缀只增长不重写 | 无法逐轮裁剪中间消息（靠压缩兜底） | 从不（正常路径） |
| 受保护消息 | 防止重要消息被压缩删除 | 保护消息占用上下文 | 从不 |
| 低频摘要压缩 | 摘要刷新次数被压到最低（≥48 条/超比率） | 旧消息以摘要形式驻留，丢失细节 | 每 ≥48 条可压缩消息 / 超比率 |
| 工具集固定 + 规范化 | tools 段跨轮字节不变 | 完整工具集占用较多 token | 会话开始 / 编辑重发 |
| slim 冻结 | slim 模式也不会中途失效 | slim 模式无法中途增减工具 | 会话开始 / 编辑重发 |
| implicit skill 冻结 | Skills 块跨轮不变 | 后续 prompt 不再激活新隐式技能 | 会话开始 / 编辑重发 |
| 上下文去重 | 更小且确定的上下文块 | 需要 hash 计算 | 从不 |
| 确定性工具输出 | tool 消息字节稳定 | 需要固定排序与截断边界 | 从不 |
| 并发串行化 | 避免并发改写前缀 | 单飞限制吞吐 | 不适用 |
| 当前 prompt 去重 | 避免重复消息导致错位 | 依赖内容比对 | 从不 |

## 7. 结语

一句话总结：**KeepSeek 把「请求前缀」当成一种需要刻意维护的稳定资源**——用分层消息（base-first）、append-only 历史投影、低频失效点（阈值化压缩、per-session 冻结、字节不变复用）与确定性输出（schema 规范化、排序、截断、CRLF 归一化）来制造字节级稳定的前缀；用 usage 归一化、前缀指纹与命中率归因来监控它；用字节契约测试来守护它。最终效果是：多轮 agent 会话中，每一轮请求的大部分 token 都能以 1/50~1/120 的价格命中缓存，只有每轮新追加的消息按全价计费。
