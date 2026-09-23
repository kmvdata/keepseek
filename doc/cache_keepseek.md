# KeepSeek 请求缓存与上下文投影

> 面向维护者与接手开发的 AI。本文描述当前实现中的请求字节稳定性、历史投影、Evidence/Context Epoch 与缓存诊断。运行时总流程见 [`keepseek-agent-runtime-workflow.md`](keepseek-agent-runtime-workflow.md)，字段级请求示例见 [`keepseek-api-payload-reference.md`](keepseek-api-payload-reference.md)。

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

当前 provider 请求协议与工具 schema 版本均为 **V10**：

- V5 引入子代理。
- V8 引入通用 Evidence 与 Context Epoch。
- V9 固定加入 `keepseek_apply_patch` 与 canonical Patch IR。
- V10 将子代理 handoff 改为小型 manifest，并把完整结果读取工具升级为 UTF-8 byte paging。

V1–V8 的已存在热会话保持原有 system/schema 字节；只有缓存自然冷却或发生受控 rollover 时才迁移。不同来源、endpoint、wire model、协议版本或原生协议不能共用缓存 lane。

## 4. 字节冻结规则

### 4.1 system 与项目上下文

- `getAgentSystemPrompt()` 只包含协议级静态约束，不放时间戳、随机 ID、绝对路径、临时状态或激活原因。
- 首轮解析出的 `contextInstructions` 持久化到 `ChatSession`，之后逐字节复用。
- AGENTS.md、Skill、Legacy Memory 或 Context Files 在会话中发生变化时，不回写旧前缀；格式化后的变化以稳定的 dynamic context tail 追加到下一条真实 user 消息。
- 未发生变化时不重复追加 tail。项目指令大小和 token 上限仍由 `ProjectInstructionsResolver` 与配置控制。

这意味着“上下文更新”通常只损失新追加部分，而不是让整段历史重新编码。

### 4.2 user 消息

- 原始输入先 `trim()`；存在引用展开时使用 `expandedContent`。
- 真正送往 provider 的内容持久化为 `providerContent`，在当前热前缀内发送与恢复复用同一字符串。
- goal、审批结果、执行结果、动态上下文等宿主信息只追加在当前真实 user 消息尾部。
- 禁止事后为旧 user 消息添加标签、日期、角色说明或重新展开引用。

“编辑并重发”是显式用户操作，会从被替换轮次起截断后续历史，因此是明确的缓存边界，不属于普通 append-only 路径。

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
- 摘要使用当前来源和模型，关闭 thinking、禁用 tools、设置独立输出预算与短超时。
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
