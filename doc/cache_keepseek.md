# KeepSeek 请求缓存与上下文投影

> 面向维护者与接手开发的 AI。本文描述当前实现中的请求字节稳定性、历史投影、Evidence/Context Epoch 与缓存诊断。运行时总流程见 [`keepseek-agent-runtime-workflow.md`](keepseek-agent-runtime-workflow.md)，字段级请求示例见 [`keepseek-api-payload-reference.md`](keepseek-api-payload-reference.md)。当前文档导航、各版本维度与历史证据索引见 [`README.md`](README.md)。

## 1. 核心结论

KeepSeek 的缓存目标不是“尽量少发内容”，而是让同一会话的下一次请求保持稳定前缀，只在尾部追加必要的新内容。对 DeepSeek 等从第 0 个 token 开始匹配前缀的来源，历史中任意较早字节的变化都会使其后的缓存失效。

因此，下列约束与安全边界同级：

1. 在当前热缓存 lane 内，已发送的 system、工具 schema、用户消息、assistant replay 和工具结果不可被重新格式化。
2. 普通会话历史只追加；编辑重发、缓存安全归档、摘要刷新和 Context Epoch rollover 是显式受控边界。
3. 用量估算、压缩判断、容量准入与实际发送必须使用同一个 provider-native projection。
4. 缓存健康按“本可复用的前缀实际复用了多少”判断，不能直接拿原始命中率与固定目标比较。

## 2. 权威实现入口

| 关注点 | 权威模块 |
| --- | --- |
| 静态 system、工具 schema、请求消息拼装 | `src/agent/protocol.ts` |
| 三协议实际请求投影 | `src/agent/providerRequestProjection.ts` |
| 历史选择、摘要和 protected 消息 | `src/agent/historyProjection.ts`、`src/agent/historyCompressor.ts` |
| 用量估算 | `src/agent/contextUsage.ts` |
| 工具结果动态准入 | `src/agent/toolResultAdmission.ts` |
| Evidence 与 provider-visible envelope | `src/agent/evidence/*` |
| Context Epoch checkpoint/rollover | `src/agent/contextEpoch.ts`、`src/agent/runCheckpoint.ts` |
| 请求级缓存观测与聚合 | `src/agent/cacheObservation.ts`、`src/agent/usageLedger.ts` |
| 会话持久化结构 | `src/shared/types.ts`、`src/sessions/chatSessionStore.ts` |

不要在 Provider 客户端、Webview 或统计代码中另造一套消息投影。它们只能消费上述模块的结果。

## 3. 请求由哪些稳定段组成

概念上，一次请求由以下稳定段构成：

```text
system
contextInstructions
tools / tool choice
provider-native history
current user / tool continuation
```

字段在不同协议中的物理位置并不相同，缓存判断以真正交给 transport 的原生请求体为准：

- Chat Completions：`messages`、`tools`、`tool_choice`。
- OpenAI Responses：`instructions`、`input`、`tools`、`tool_choice`。
- Anthropic Messages：`system` blocks、`messages`、`tools`、`tool_choice`。

`buildProviderRequestProjection()` 是这三条 lane 的共同入口。Runner 的实际请求、`contextUsage`、摘要触发判断和工具结果准入都必须基于它，避免“估算看得见、实际没发送”或反过来的分叉。

### 3.1 协议 lane

新建主会话的 request protocol 与 tool schema 当前均为 **15**，分别由 `providerRequestProjection.ts` 的 `CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION` 与 `CURRENT_PROVIDER_TOOL_SCHEMA_VERSION` 定义。它们不代表 child runtime、结果合同或存储格式的版本；各维度见 [版本权威表](README.md#版本维度)。请求协议的演进边界包括：

- V5 引入子代理。
- V8 引入通用 Evidence 与 Context Epoch。
- V9 固定加入 `keepseek_apply_patch` 与 canonical Patch IR。
- V10 将子代理 handoff 改为小型 manifest，并把完整结果读取工具升级为 UTF-8 byte paging。
- V11 增加分工评估、受控继承与父验收合同。
- V12 由 `protocol.ts` 的 `PLUGIN_SKILL_REQUEST_PROTOCOL_VERSION` 门控显式 Codex 插件 Skill 读取工具。
- V13 更新 ask/delegate 审批提示与 DraftRun 工具说明；宿主审批模式不由模型或历史提示切换。
- V14 隐藏已暂停的插件 Skill 读取工具；V12/V13 保留冻结 schema，旧工具实际调用拒绝，历史字节不改写。
- V15 增加有界命令计划字段；V1–V14 的工具字节保持冻结。

受支持的旧热主会话保持各自 system/schema 字节，只有缓存已冷或受控 rollover 才迁移；`subagents/runtime.ts` 的 child 协议仍独立固定为 11。不同来源、endpoint、wire model、协议版本或原生协议不能共用缓存 lane。旧版三审批模式字节属于冻结协议兼容，不是当前设置入口。

### 3.2 项目任务与本地缓存

项目任务的四类本地状态与供应商 Prompt Cache 分开：

| 状态 | 权威与边界 |
| --- | --- |
| 运行会话 | `ChatSessionStore.createSessionScope()` 固定独立执行选择并 pin 原 session；不会复制历史到新 session，也不改全局正在查看的普通会话 |
| 有限首屏 | `SessionViewPage` 是只读展示投影，默认最近 30 条、更早最多 50 条；既有对象 manifest 按所需 message body 读取，不解码全部 checkpoint；深历史按 messageId 索引读居中有界页，锚点丢失退回最近页，不能作为完整 session 保存 |
| 来源快照 | `SharedProjectSources.createSibling()` 共享不可变配置/指令、版本、合并读取和 watcher；各 facade 的 session、选中结果与代际仍独立。`SkillStore.createSibling()` 共享来源 manifest/冻结正文读取，激活、错误与 implicit 集合属于各任务 |
| 草稿与工作位置 | 属于查看目标，独立于执行 session、审批与预算；丢弃视图缓存不丢运行权威 |

普通查看使用 `viewSessionPage()`，不调用 `selectSession()`，不更新模式、来源、活动时间或选择持久化，不触发模型、标题、摘要或付费预热。冷热视图从本地磁盘恢复并不证明上游已命中。Router 的 `agentRole/toolset=1` 是独立维度；Worker request/schema 仍为 15，旧热 lane 不批量迁移。

保存按 dirty session/revision 提交。`GlobalSessionStorage.saveSessionChanges()` 先保存相关对象图，再短事务合并工作区索引；scoped 保存保留全局查看选择。CoalescedWriter 等待者只在包含本次版本的真实提交后完成，失败保留 dirty 状态，标题 staged commit 屏障继续生效。普通同目标冷正文读取继续合并；辅助标题读取使用独立 flight，前台重命名/会话选择不能等待旧标题 I/O。各读取完成后都先复用已经驻留的对象，因此迟到旧读不能覆盖手动标题或 staged commit。运行、未消费输入、审批/恢复、必要保存的 pin 与有限视图 LRU 分开；空排队卡不会因无消息被过滤。

证据：[本地视图/存储测量](benchmarks/keepseek-project-view-storage-20261107.json)，复现脚本 `scripts/benchmark-project-views.cjs`。测量范围是 Host 读入与发布准备时间；原生 Webview 绘制、输入可编辑、Provider 缓存命中和真实费用需要各自现场证据，不能从这份主机测量推定。

## 4. 字节冻结规则

### 4.1 system 与项目上下文

- `getAgentSystemPrompt()` 只包含协议级静态约束，不放时间戳、随机 ID、绝对路径、临时状态或激活原因。
- 首轮解析出的 `contextInstructions` 持久化到 `ChatSession`，之后逐字节复用。
- 共享指令/配置、Skill 或 Context Files 在会话中发生变化时，不回写旧前缀；格式化后的变化以稳定的 dynamic context tail 追加到下一条真实 user 消息。
- 未发生变化时不重复追加 tail。项目指令大小和 token 上限仍由 `ProjectInstructionsResolver` 与配置控制。

这意味着“上下文更新”通常只损失新追加部分，而不是让整段历史重新编码。

### 4.2 user 消息

- 原始输入先 `trim()`；存在引用展开时使用 `expandedContent`。
- 真正送往 provider 的内容持久化为 `providerContent`，在当前热前缀内发送与恢复复用同一字符串。
- 审批结果、执行结果、动态上下文等宿主信息只追加在下一条真实 user 消息尾部，不插入伪 user。
- 禁止事后为旧 user 消息添加标签、日期、角色说明或重新展开引用。

“编辑并重发”是显式用户操作，会从被替换轮次起截断后续历史，因此是受控的后缀边界。它不表示此前公共前缀必然失效：保留消息、稳定上下文、冻结工具和同 lane replay 原字节复用；Skill 按新任务解析。仅有来源与依赖证明、只覆盖保留历史的摘要可复用；跨截断摘要或缺证据的旧摘要整段失效。动态上下文 hash 从实际可见的保留 tail 恢复，必要更新只追加到新 user。操作失效标记不进入请求，删除来源的旧命令结果不再回灌。事务、恢复与三协议字节证明见 [编辑重发验收](keepseek-edit-resend-verification.md)。

编辑首条 user 且没有保留消息时，若旧稳定上下文含已删除任务的隐式 Skill，新上下文字节又确有变化，则按 `context_semantics_changed` 重建稳定上下文，并从活动 archive 排除旧 context 来源；替换内容随截断 journal 提交和恢复。新旧字节相同则保留缓存，不能用后续 tail 抵消旧 system 语义来强行复用。

中间截断同样清理失去活动来源的 `context:*` archive；当前上下文来源或保留请求明确引用的 archive 继续可查。活动 archive ID 记录在截断 journal 中，避免重启恢复后已删除后缀的 Skill 内容重新被搜索交付。

另一个受控例外是 `historyArchive.ts` 的缓存安全维护：Coordinator 已决定同步压缩、旧前缀本就会失效时，才可把超大的首条 providerContent 或陈旧低优先级工具结果替换为稳定 archive 占位符；完整原文按 content hash 留在 `session.historyArchive`，由 `keepseek_search_session_archive` 检索。它不能在热前缀中任意运行。

### 4.3 assistant 与工具轮

- Chat Completions 的 assistant/tool 序列保存在 `ChatMessage.toolRounds`，恢复时按原顺序还原；缓存安全归档只替换旧结果正文，不移除调用/结果配对。
- Responses 与 Anthropic 的同 lane 原生块保存在 `providerReplay`；跨 lane 只投影可见文本，不能伪造原生块。
- Anthropic 的 thinking、signature、redacted data、`tool_use` 和 `tool_result` 必须保持原样及原顺序。
- reasoning 与对应工具调用属于一个原子轮次，不能只保留其中一半。

### 4.4 工具 schema

- schema 的集合、字段和顺序按会话协议版本冻结。
- 用户显式的有限工具预算耗尽时，先向内部 projection 追加 host finalization nudge，再使用 `tool_choice: none`；不临时删除 `tools`，nudge 不进入 `session.messages`。
- no-tools reviewer/format-repair 通过独立的 `toolsEnabled=false` / 空工具集合建模；数值预算的 `0` 始终表示 unlimited，不再兼任“禁用工具”。
- slim mode 默认关闭。新增或改名工具必须升级协议版本并覆盖热会话迁移测试。
- Skill 与能力只影响上下文和运行策略，不得悄悄改写已冻结的 system/schema。

### 4.5 工具结果

工具调用按以下顺序提交：

```text
持久化调用意图
  → 执行工具
  → 保存完整 Evidence 与 hash
  → 按真实剩余容量生成一次 provider-visible envelope
  → 标记发送/交付状态
```

完整结果属于不可变 Evidence；进入模型历史的是保存过的 envelope。恢复时复用该 envelope，不重新读取文件、重跑搜索，更不能重新执行副作用。调用进入未知状态时保持 uncertain，不能以重试“猜测修复”。

## 5. 历史投影与摘要

`session.messages` 是聊天事实记录，provider history 是按容量生成的投影，两者不可混同。

### 5.1 投影结构

投影优先包含：

1. 当前有效摘要；
2. 自动保护的关键消息；
3. 摘要覆盖点之后的消息；
4. 最近完整轮次和当前请求。

自动保护至少覆盖首条需求、最近输入、显式“记住”、错误/测试失败、用户纠错和 DraftEdit 结果。选择单位是完整轮次，不能拆散 assistant/tool 配对。

### 5.2 摘要约束

- 摘要只保存目标、决策、错误、路径/符号线索、完成项和待办，不复制文件正文、长日志或代码块。
- 独立历史摘要使用当前来源和模型，关闭 thinking、禁用 tools；按实际模型的有效输出配置和 `resolveProviderRequestBudget()` 准入，不使用阶段专用固定输出上限。模型请求超时统一取用户级 `keepseek.modelRequestTimeoutSeconds`。正费用上限下，缺少共享任务预留的独立摘要跳过，由运行时按任务账本压缩。
- 已成功摘要持久化后逐字节复用；不要假定同一输入重新请求一定得到相同文本。
- 摘要失败只记录原因，不阻塞用户请求。
- 无可用摘要且投影超过强制阈值时，才退化为保留受保护消息和最近历史。

压缩阈值来自模型画像，而不是散落在 Runner 中：

| 画像 | 开始摘要 | 强制降级 |
| --- | ---: | ---: |
| aggressive | 70% | 85% |
| balanced | 80% | 92% |
| cache | 85% | 95% |

累计新增消息达到增量刷新阈值时也可更新摘要；当前实现阈值为 48 条消息。

## 6. 大工具结果与 Context Epoch

当前统一口径由 `buildProviderRequestProjection()` 及其最终上下文投影 `buildProviderPayloadProjection()` 提供；`measureCompressionProjection()` 同样消费最终 payload，并以 source/endpoint/model 隔离校准窗口。初始历史过满时也可触发必要 epoch，已取消的 completion 不采纳新摘要。源历史在 fallback 容量判断前已排除不发送的 reasoning 和不匹配 lane 的 replay；运行时请求、候选工具结果和 usage 使用同一规范化规则。候选结果与批次最小 envelope 的预留是显式差量。用户配置输出上限、已学习窗口及安全余量不因性能优化而下降。

已结束提案不会永久保护整段工具历史。宿主事实随受控摘要保存，完整审计/evidence 留存；pending、未知副作用和当前约束仍保护。摘要的净释放量包含新 summary/seed/元数据，低收益采用现有预算 safety/minimum-envelope 余量判定，不能超限发送，也不对相同失败指纹反复摘要。详情与实际前后对比见 [长任务整改](long-task-performance-rectification.md)。

“本地估算可缓存比例”取代“理论最高原始命中率”：它不是供应商上界，真实命中率不截断。高命中率不能证明进展；计数、正文交付和阶段跨度须一起看。

KeepSeek 不再用固定的“累计工具结果预算”终止长任务。每次结果准入综合考虑：

- 当前三协议真实 projection；
- 模型声明窗口与 learned effective window；
- 动态输出预留；
- 最小 envelope 大小；
- 当前 epoch 的工具数量和软压力。

完整结果放不下时，模型通过 `keepseek_read_evidence` 分页读取；最小 envelope 也放不下、provider 报 context-too-long，或 epoch 达到受控阈值时，执行 rollover。

rollover 会外置 task-scoped checkpoint，并开始新的 provider replay lane，但保持：

- 同一 session、逻辑 task 和 approval root；
- 原始需求、TaskPlan、Evidence/hash 与工具幂等状态；
- DraftEdit、DraftRun、审批、validation/repair 和未知副作用状态；
- 运行时钟、费用账本、取消/停止状态。

它不会改写 `session.messages`、插入伪 user 消息、创建新聊天，或授权/应用/执行任何副作用。checkpoint 优先使用模型生成的有界摘要，失败时使用宿主确定性摘要。

context-too-long 会按来源、endpoint 和模型校准有效窗口后重建 epoch。只有冻结的 system/schema、原始请求与最小 checkpoint 仍无法装入时，才向用户报告真实容量错误。跨 epoch 的无进展指纹用于阻止重复循环。

“上下文容量维护”和“用户执行预算”必须分开理解：模型 profile 决定窗口、输出与压缩策略，不决定根任务工具轮数；默认根任务不会因 16/32 轮、32 次请求、15 分钟、2M tree token 或 3 次 rollover 被截断。Context Epoch 可以更换 replay lane，但不能重置显式时间/费用/工具预算，也不能为工具预算收尾创建隐藏摘要。显式工具额度到达后的唯一收尾请求保持原 schema 字节稳定；三协议分别追加普通内部 user item/message，并在 Provider 违背 `tool_choice:none` 时保留原生调用/blocked-result 配对而不执行工具。

## 7. 缓存可观测性

`cacheObservation.ts` 从实际 transport 请求生成不含正文的观测记录。它对 system、contextInstructions、tools、provider history 和完整请求分别计算指纹，并在同一 lane 内判断与上一请求的关系：

- `cold`：没有可比较前序请求；
- `strict_prefix`：上一请求是当前请求的严格前缀；
- `identical_retry`：请求未变化的重试；
- `broken`：较早段发生变化，并记录首个变化段。

lane 至少按 usage source、provider、协议、source ID、endpoint identity 和 wire model 隔离。wire alias 或自定义 endpoint 不得混在一起。

### 7.1 正确的健康指标

原始缓存命中率：

```text
cacheHitTokens / inputTokens
```

它会被本轮不可避免的新 token 稀释，不能直接要求达到固定百分比。KeepSeek 先估算：

```text
reusablePrefixTokensEstimate
unavoidableNewTokensEstimate
expectedRawHitRateCeiling
```

只有满足以下条件的请求才进入健康判断：

- 与上次请求是 `strict_prefix`；
- 可复用前缀至少 1024 token；
- 没有摘要、rollover、协议迁移等受控边界；
- provider 返回可用的缓存计量字段。

核心指标是复用效率：

```text
cacheReuseEfficiency = cacheHitTokens / reusablePrefixTokensEstimate
```

当前健康目标为 95%。只有本地已证明前缀稳定、provider 又报告了缓存数据且效率低于目标时，才可标记为可能的 provider eviction；不能把冷启动、正常新增 token 或本地主动边界误报为供应商故障。

### 7.2 归因与隐私

缓存原因分为四类：

- `normal`：冷请求、稳定追加、相同重试；
- `controlled_boundary`：摘要、epoch rollover、协议迁移、context-too-long 重建；
- `provider`：在本地稳定证据充分时推断的缓存逐出；
- `local_anomaly`：system、context、tools 或历史发生非预期变化。

Usage Ledger 保存请求级诊断，并按来源与 lane 聚合命中、可复用前缀、理论上限及本地边界损失。Webview 只接收汇总；endpoint identity、内部 hash、prompt 正文和 ledger 原始记录不得下发。

## 8. 修改前检查

### 改 system、schema 或消息序列化

1. 明确是否需要提升 request/schema protocol version。
2. 同步检查三协议 projection 与原生 replay。
3. 证明普通下一轮仍是严格前缀追加。
4. 验证热旧 lane 不被静默改写。

### 改压缩、估算或模型窗口

1. 同步检查 `shared/types.ts`、`historyProjection`、`historyCompressor`、`contextUsage` 和 Runner。
2. 使用真实 projection，不单独拼一份估算消息。
3. 覆盖无摘要、摘要失败、protected 消息、最近轮次和降级路径。

### 改工具结果或 epoch

1. 保存意图、Evidence、envelope 和交付状态的顺序不可倒置。
2. 覆盖 20MB 分页、跨 session/task 拒绝、恢复字节一致和三协议配对。
3. 验证 rollover 不产生伪 user 消息、不重跑工具、不重置审批/时限/费用。
4. 未知副作用必须 fail closed。

## 9. 回归测试入口

```bash
bun run build:test
bun run test
```

重点测试：

| 测试 | 保护的契约 |
| --- | --- |
| `test/cacheByteStability.test.ts` | system/schema、user/providerContent、toolRounds、Skill 与前缀字节稳定 |
| `test/p1CacheObservability.test.ts` | 三协议观测、lane 隔离、严格前缀、95% 复用效率、隐私与迁移 |
| `test/historyCompressor.test.ts`、`test/historyProjection.test.ts` | 摘要、保护消息、轮次原子性、失败与强制降级 |
| `test/currentRunContext.test.ts` | 用量估算与真实 current-run projection 一致 |
| `test/historyArchive.test.ts` | 缓存安全归档、原文召回与工具调用配对 |
| `test/toolResultBudget.test.ts` | Evidence、动态准入、20MB 分页、epoch、容量校准与恢复 |
| `test/openAiResponses.test.ts`、`test/anthropicMessages.test.ts` | 原生请求形态、replay 配对与 context accounting |

审查缓存相关改动时，最终问题只有两个：**既有字节是否仍原样存在？实际请求、估算与诊断是否观察同一份 projection？**

### 网络恢复与冻结请求

每个模型轮在权威 Provider projection 上构建实际请求，正文一次序列化后在共享 transport 内冻结。在线重连复用同一正文、URL、headers 和配置快照；429、临时 5xx、网络/不完整 EOF 合计最多 5 次重连。退避和重连不重新投影、不变更 tools/tool_choice/thinking、不摘要、不 rollover，不追加失败 partial 或内部续传 user。失败输出仅属当前 attempt 的 UI 临时段，失败即清除；完整响应才追加 providerReplay/toolRounds。

每次物理请求都保留独立 attempt/usage 记录。输入前缀相同可作为 `identical_retry` 观测，但它不等于原生成结果续传，也不保证命中服务商缓存。checkpoint 只保存已用物理次数和请求 hash；重启/Continue 不清零，用 hash 拒绝变化的恢复请求。跨重启的请求字节没有另存 blob，因此第一版精确字节保证限于运行中的自动重连。已完成工具仍复用 evidence/envelope，不因模型重新计算而重跑。

## 参考费用（2026-10-31 核对）

用量面板的费用统一称为“参考费用 / Reference cost”。DeepSeek 官方账号的已知模型使用内置官方人民币价格，不再使用遗留 `usagePricing` 覆盖。真实费用预算对未知模型仍使用显式配置，不凭模型名称推断为 Flash；其它账号的面板展示则统一使用下述 Flash 标准价。Flash 包括 `deepseek-flash`、V4 Flash 兼容名、`deepseek-v4.1-flash` 和 `deepseek-v4.1-flash-1017`。Pro 使用独立的官方 Pro 价格。

Flash 每百万 tokens 的空闲档：缓存命中 0.02 元、未命中 1 元、输出 4 元；高峰档分别为 0.04、2、8 元。每次物理请求开始时，按北京时间选择档位并冻结价格快照，随后以 Provider 返回的 tokens 结算并逐次累计；打开面板或恢复会话不会按查看时刻重新计价。缓存细分缺失时全部输入按未命中计算，并标记费用上界。

周一至周五 09:00（含）—12:00（不含）、14:00（含）—18:00（不含）为高峰；中国节假日优先排除，周末（包括调休上班）全天为空闲。节假日表覆盖国务院公布的 2025、2026 年放假范围；后续年度需随公告维护。在未维护的年份，仍按星期和时间判定，尚不能识别该年的节假日。价格表版本更新为 `keepseek-pricing-2026-10-31`；已有账本保留旧快照，缺少逐请求证据的历史累计不伪造或自动重估。

参考费用仅覆盖模型 token，不包含 Search/Fetch 等独立 API 费用，也不等同于官方账单。所有账号均展示参考费用。DeepSeek 官方账号保留逐请求实际模型价格；其它账号统一按 Flash V4.1 官方标准价生成仅供展示的投影，并在详情页费用旁显示问号说明。混合来源会话合计可能同时包含两种口径，各来源卡片分别标注。该投影不写回真实费用账本、不改变预算准入或费用熔断，也不修改实际 tokens。历史逐请求账本可直接重建，无新增持久化字段；仅剩累计数、缺少请求时间的旧数据保持未计价。

来源：[DeepSeek 官方价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)、[2025 年节假日](https://www.gov.cn/zhengce/zhengceku/202411/content_6986383.htm)、[2026 年节假日](https://www.gov.cn/gongbao/2025/issue_12406/202511/content_7048922.html)。

费用展示统一使用去尾法保留两位小数（例如 12.239 → 12.23、0.009 → 0.00），仅作用于 Webview 格式化，不修改原始金额或累计精度。非官方来源的说明使用正圆小图标；悬停及键盘聚焦显示中英文文字浮层，不使用问号鼠标光标或重复的原生提示。
