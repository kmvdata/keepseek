# KeepSeek 子代理架构、安全与用量

模型设置位于 `/` → 子代理模型：默认及 research / review / proposal 的覆盖保持独立；review 显示为“代码审查”。同一菜单下的“审批模型”仅使用用户级 `kmvdata.keepseek.autoApprovalReviewer`，默认跟随任务执行段实际主模型，不读取子代理 default。菜单归组不改变两套配置的独立性，父任务选择“帮我审批”不提升任何 child 的权限。

> 子代理主题的唯一交接入口。本文合并了原 `doc/subagent-runtime-security.md` 与 `doc/subagent-usage-statistics.md`，覆盖当前子代理 runtime 协议 V15 的隔离、调度、结果合同、恢复和统计。主 Agent 工作流见 [`doc/keepseek-agent-runtime-workflow.md`](doc/keepseek-agent-runtime-workflow.md)。P1 变更与验证限制见 [`doc/keepseek-p1-subagent-reliability.md`](doc/keepseek-p1-subagent-reliability.md)。

## 1. 设计目标

子代理用于把有界研究、审查或方案准备工作交给隔离的 child run。它不是共享父 Agent 全部上下文的“第二个线程”，也不能成为审批和文件/命令边界的旁路。

核心原则：

1. child 只接收自包含任务和最小宿主上下文。
2. 工具白名单由宿主在 schema 与执行时双重约束。
3. child 返回结构化结论与 Evidence 引用，不暴露隐藏推理或完整私有 transcript。
4. proposal 只能产生草案；实际写入和命令仍回到父会话审批管线。
5. 时间、费用和取消属于同一逻辑任务，不能通过委派重置。

`subagents/runtime.ts` 的 `SUBAGENT_PROTOCOL_VERSION` 与父会话共同取 `CURRENT_AGENT_PROTOCOL_VERSION`，当前仅为 **15**。child 使用结果合同 V2、handoff manifest V3、宿主继承 capsule V1 和结果索引 V1；会话对象存储 V4、审批策略及审批交付协议是独立维度。仅读取当前格式，见[版本权威表](doc/README.md#版本维度)。

## 2. 权威模块

| 关注点 | 模块 |
| --- | --- |
| 调度与生命周期 | `src/agent/subagents/runtime.ts`、`scheduler.ts` |
| profile 与 Skill 适配 | `src/agent/subagents/profiles.ts` |
| 任务/结果协议 | `src/agent/subagents/resultEnvelope.ts`、`types.ts` |
| 委派候选与父验收 | `src/agent/delegation.ts`、`taskPlan.ts`、`runner.ts` |
| 宿主继承投影 | `src/agent/subagents/contextCapsule.ts` |
| 有界回传与独立结果对象 | `src/agent/subagents/handoff.ts`、`resultIndex.ts` |
| 工具白名单与 child loop | `src/agent/subagents/runtime.ts`、`src/agent/runner.ts` |
| 路径作用域与冲突检查 | `src/agent/subagents/pathScope.ts`、`scheduler.ts`、`runtime.ts` |
| continuation/reuse | `src/agent/subagents/runtime.ts`、`store.ts` |
| 持久化与诊断 | `src/agent/subagents/store.ts` |
| 模型设置 | `src/accounts/subagentSettingsStore.ts`、`subagentModelResolver.ts` |
| 用量归集与估算 | `src/agent/subagentUsageStats.ts`、`runtime.ts`、Provider |
| UI 设置与入口 | `src/provider/KeepseekChatViewProvider.ts`、`src/webview/*` |

共享常量和数据结构以源码为准，不要在 Provider 或 Webview 复制调度与权限判断。

## 3. 用户入口与内置角色

显式斜杠命令：

- `/research <task>`：只读调查和证据收集。
- `/review <task>`：只读审查，返回 verdict、路径和 findings。
- `/proposal <task>`：准备 DraftEdit/DraftRun 提议，不应用、不执行。
- `/parallel`：并行派发同一批有界任务。

模型也可调用 `keepseek_delegate_task` / `keepseek_delegate_parallel`，但是否暴露这些工具由当前协议、profile、深度和 lane 决定。

斜杠选择保留在可见 user 消息中，并只为当前轮追加稳定选择尾部；它不会切换审批模式、提升工具权限或创建新的后台服务。

当前协议在初始计划和有证据的调查范围扩大时，引导主模型通过 `keepseek_delegation_checkpoint(action=assess)` 记录简短分工判断与候选合同：目标、范围、必要输入、依赖、所需能力和验收标准。小任务可以留在主 Agent，不强迫委派或额外 router 调用。宿主预检声明的依赖、profile、权限、路径、能力和预算；它不证明任务语义独立。同批有依赖或存在依赖环时拒绝并行，必须等待前置结果被父模型采纳后顺序推进。只读 child 不能运行 shell/Python/验证，proposal 也只能准备命令草案。

显式选择必须由主模型准备自包含 brief 再调用工具。宿主记录选择、请求、拒绝、返回、复用与父验收；未执行或类型不匹配时显示未落实，只有真实记录才能归因为预算或权限。模型判断与宿主事实分别标明，记录不含隐藏推理。`failFast` 继续是保留参数，不承诺新增批次取消策略。

| profile | 典型用途 | 工具能力 | 可再委派 |
| --- | --- | --- | --- |
| `research` | 定位代码、查证事实 | 只读、语义、Git 读取、Evidence | 是；仅 depth < 2 的较小只读任务 |
| `review` | 代码/方案审查 | 只读、语义、Git 读取、Evidence | 是；仅 depth < 2 的较小只读任务 |
| `proposal` | 生成修改或命令草案 | 只读 + DraftEdit/DraftRun 提议 | 否 |
| Skill profile | workspace 特定任务 | 取 profile 与 Skill 声明的交集 | 显式允许且未超深度 |

并行 proposal lane 会移除可能引入未知路径副作用的 DraftRun 能力；嵌套 child 只获得 `nested-read` 级别能力，不能无限递归委派。

## 4. Child 输入隔离

每个 child 使用新的 AgentLoop、取消控制器、请求历史和诊断记录。允许注入：

- 自包含 task brief 与稳定 task hash；
- 当前项目指令的受控投影；
- workspace root manifest 与信任状态；
- profile、允许工具和路径作用域；
- 完成任务所需的精确外部 URI 授权；
- 共享逻辑任务的时间/费用/取消账本引用。

默认禁止注入：

- 父聊天完整历史、隐藏推理和工具结果正文；
- 父 Context Files、会话归档和历史 Memory 内容；
- 未选中 Skill 的模型可见正文、未经父侧授权的外部路径；
- API key、审批 permit、父 Agent 的可变内部对象。

项目指令和工具输出仍按不可信边界处理；它们不能要求提升工具、审批模式、深度或路径权限。

capsule V1 仅供宿主解析与恢复，保留适用项目指令原字节、稳定 workspace manifest、根运行已激活的 subagent profile 身份/版本与精确外部 URI 授权；不把整个 capsule 发给模型。一级与二级 child 都能解析这些已授权 profile，但模型只收到当前选中 profile 和适用项目约束。二级继续是 `nested-read`、不可再委派；自定义 proposal profile 也不能借继承获得写能力。capsule hash 进入 compatibility/cache family，缺少证明或内容变化时拒绝旧 continuation/reuse，保留审计资料。

## 5. 模型选择与设置

子代理设置按 workspace + profile 存储在：

```text
nativeStorageRoot/subagent-settings/v2/<workspaceHash>.json
```

每个 profile 可选择：

- 跟随主模型；或
- 固定 `sourceId + modelId`。

固定来源/模型不可用时 fail closed，不自动降级到另一个来源。子代理 thinking 始终关闭，以控制私有上下文、成本和结果协议稳定性。

设置仅从当前 workspace V2 快照读取。`modelRequestTimeoutSeconds` 是所有来源共用的单次网络请求超时；`kmvdata.keepseek.agent.subagentMaxExecutionMs` 默认 300000 ms（5 分钟），限制 child 的有效执行；`kmvdata.keepseek.agent.maxExecutionMs` 是根逻辑任务共享时钟的另一层上限。child 还受调用 `timeoutMs` 与 profile 限制，正数限制取更严格值；这三层不能混为同一个超时，也不能通过重试、续接或委派重置。

## 6. 调度与上限

当前宿主硬边界：

| 限制 | 值 |
| --- | ---: |
| 全局同时运行 child | 4 |
| 单 root 同时运行 child | 3 |
| proposal 同时运行 | 2 |
| 最大委派深度 | 2 |
| 单 parent 的 direct children | 8 |
| 单任务树 child 总数 | 12 |

每个 child 的 step 上限从父任务派生，通常为父上限的一半，并限制在 1–32；当前默认下限为 5。队列等待不计入执行时间，但取消、停止、工作区失信或预算耗尽会传播到排队和运行中的 child。

并行不改变安全边界：调度器只能决定何时运行，不能扩展工具、路径、预算或批准。

## 7. 工具暴露与执行时门禁

schema 白名单不是唯一防线。Runner 在实际处理每个 native/Responses/Anthropic/DSML 工具调用时，再与该 child 的 projected tool names 比对：

```text
provider tool call
  → schema/参数解析
  → 当前 child 工具集合校验
  → task/path/authorization 校验
  → 工具执行或 fail closed
```

协议规则：

- child 使用通用 `keepseek_read_evidence` 读取普通工具证据。
- child 同时使用固定 schema 的 `keepseek_read_subagent_result`，按 result ref 分页读取完整 child 结论。
- `keepseek_apply_patch` 只在允许提案的 profile/lane 中暴露。
- 只有 profile 明确允许、深度小于 2 且 lane 不是 `proposal` 时，才暴露再委派工具。
- 可再委派的 child 同时使用 checkpoint 工具登记候选与验收二级结果；它不增加读写权限或委派深度。

模型即使伪造未暴露工具名，也会在执行时被拒绝并留下诊断。

## 8. 路径作用域与 proposal 安全

路径规则先按稳定 workspace roots 归一化，再生成作用域和 compatibility hash。禁止用工作目录偶然顺序、相对路径别名或符号链接绕过作用域。

proposal 的宿主检查分两阶段：

1. **批次预检**：在启动并行 proposal 前，检查 sibling tasks、活跃 proposal 与父会话现有 DraftEdit 的作用域冲突；批次要么整体接受，要么整体拒绝。
2. **结果复检**：child 返回后按实际 artifact URI 再检查一次；模型声明的路径只是提示，不能替代宿主验证。

具有写能力但无法可靠声明路径的单个 proposal 保守占用整个 workspace；并行 proposal 必须给出可解析的路径作用域。冲突、越界、未授权外部 URI、目录/二进制限制和基线变化均 fail closed。proposal child 只能把 canonical DraftEdit/DraftRun 放回父会话；应用、执行、审批 hash、SafeFileEditor 和 ExecutionPermit 与主 Agent 完全相同。

## 9. 结构化结果协议

child 必须返回合法 JSON envelope，而不是任意聊天文本。公共字段包括：

- `taskHash`；
- `status`；
- `summary`；
- `evidence` 引用；
- `uncertainties`。

结果合同 V2 可补充实际覆盖 `coverage`、缺失项 `missing`、必要下一步 `nextSteps` 和模型自报验证 `verification`。证据 claim 与自报验证标为未独立核验，非空字符串不代表宿主确认事实。生命周期 `completed/failed/stopped`、结构/绑定接受 `formatAccepted`、子任务完成程度 `resultStatus=complete/partial/failed` 和父主任务验收分别记录；`ok` 表示交付结构可接受，不能证明用户目标完成。

角色扩展：

- review：`verdict`、`reviewedPaths`、结构化 findings；
- proposal：宿主确认过的实际 artifact 数量和引用，而不是模型自报数量。

若结果格式错误，宿主只允许一次“仅修复格式”的无工具请求；仍不合法则 fail closed。解析器不得从自由文本中猜测安全关键字段。

父 Agent 收到 V3 handoff manifest：固定状态/引用、最多 1024 字符 summary、默认最多 10240 字节 UTF-8 preview。单结果默认总上限 12288 字节；parallel 共用 20480 字节总预算，先保留各项状态与引用，再公平分配 summary/preview，并按 JSON escaping 后的实际字节约束。每项都保留 summary 与完成程度；缩减 preview 后重算 `hasMore`。只接受当前 manifest。

profile `resultMaxChars` 是 accepted canonical 交付的硬字符限制，不是模型输出 token 限制或父 preview 上限。超限时生成合法、有界且明确 `partial` 的 canonical，记录 `missing: ["result_too_large"]`、原始 hash/字符数；原始正文不提供可读引用，`resultRef` 只读该 partial。安全存储上限为 2 MiB；超过宿主资源上限拒绝接受，不能用截断 JSON 或不存在的正文引用假装完整结果。hash/size 指向已接受 canonical，`originalResultHash/originalResultChars` 仅说明被拒绝的原始规范化结果；preview 缩减不代表 canonical 被截断。

`resultRef` 经 `keepseek_read_subagent_result` 读取隔离存储中的 canonical child 结果；`evidenceRef` 经 `keepseek_read_evidence` 读取某次不可变工具交付快照，二者不能互相替代。默认页 12288 字节、最大 24576 字节，UTF-8 byte offset 不跳过中文/emoji，最终页还要经过 evidence/admission 与三协议投影；只有实际交付正文的范围才能推进游标。容量不足时明确阻塞，不自动读取全部剩余页，也不返回私有 trace/checkpoint。

父模型先审摘要、完成程度、关键证据和缺失项，再按需读详情或定点核验，并通过 checkpoint `action=accept` 记录 `adopt/needs_details/investigate/reject` 与简短理由。宿主核对结果作用域、绑定、完整性和完成程度，语义正确性仍需父模型与真实验证判断。信封接收不等于采纳，partial、损坏或缺少验收的结果不能自动完成计划；采纳不是审批许可，也不代表提案已 Apply/执行。

## 10. Continuation 与结果复用

continuation token 只在同一父 session 内有效，并绑定以下 compatibility 信息：

- source/model 与来源配置；
- system/request/tool schema 版本；
- profile 与工具集合；
- 项目指令、workspace manifest；
- 外部授权与路径作用域；
- 父任务和 child run 身份。

任一 hash 不匹配都拒绝继续，不能“尽量恢复”。当前记录必须有有效 capsule 继承证明；缺少证明时拒绝恢复执行。

已完成结果复用仅适用于完整、未截断且格式获接受的 research/review，不适用于 proposal、partial 或损坏结果。除了 task 与 compatibility 完全一致，还必须证明 read set 仍新鲜；广泛搜索、无法枚举依赖或环境信息不足时，freshness 为 unverified，禁止复用。

复用时创建新的稳定结果引用，不复制旧私有 transcript，也不伪造新的 provider 调用。父 Agent 的接受/读取行为仍按当前任务记录。

## 11. 取消、重启与诊断

- 用户停止、任务预算耗尽、父 Agent 结束或工作区失信会向整棵 child tree 传播取消。
- 扩展重启时 queued/running child 归一化为 stopped/interrupted，不自动重新派发。
- 已有 provider 请求是否执行不明确时不重放；有副作用可能性的 proposal 状态保持 uncertain。
- progress 事件只允许白名单字段，不能夹带 prompt、密钥或任意模型文本。
- child 诊断会裁剪大小并脱敏凭据、环境变量和绝对路径，默认保留 7 天，且受工作区/session/task 隔离。

运行记录存放在：

```text
nativeStorageRoot/chat-sessions/v1/subagents/<workspaceHash>/<parentSessionId>/
```

当前只写 `<id>.state.json` 与 V4 对象图，summaryHash 绑定活动/统计索引；每 child 有界 CoalescedWriter 与必要持久化屏障保持。在同一原子提交前写入独立 canonical 结果对象与 result index V1，分页只读取元数据和请求范围相关 chunk 并核对 hash，不解码私有 transcript/checkpoint。终态正文和元数据提交成功后才回调父侧。损坏新权威不能静默回退旧文件。

不读取 combined `.run.json`、split `.meta.json/.transcript.json` 等旧布局。当前记录须通过格式、hash 和作用域校验；损坏结果不能触发 child 重执行。引用链受 workspace/session/tree/lineage 和循环检查约束。

## 12. 用量归集

### 12.1 Provider 实际用量

child 每个真实请求以 `usageSource = subagent` 写入共享 Usage Ledger。规则：

- 主会话侧只汇总 executor、retry、continuation、summary、background、retrieval、router；reviewer 与 subagent 分开，无法归因的差额继续显示为 unattributed。
- failed/stopped child 已发生的 provider 用量仍要计入。
- nested child 用量逐层上报一次，不能父子重复累计。
- 实际 token 只取 provider usage，不用字符数补算；固定子模型按 `sourceId + modelId` 分组，不把同名模型的不同账号合并。
- provider 未返回某字段时记为 unknown，不得填 0。
- 不同币种分别累计，不做汇率换算。

会话级 `ChatSession.subagentUsageStats` 当前为 schema v1。它保留累计 totals 与已归集 ID，用最近 50 条运行记录作为 UI 明细窗口；明细滚动不能丢失累计值，也不能导致旧 run 再次计费。

### 12.2 本地上下文隔离估算

UI 可展示本地估算，帮助判断委派是否减少父上下文占用：

```text
isolated = delegate tool call + child-private tool results + child-private reasoning
returned = 父 Agent 实际接纳的 root child result envelope
isolationRate = isolated / (isolated + returned)
```

约束：

- `returned` 使用整形/准入后的实际父侧内容，不用 child 原始输出。
- nested child 不直接算作 root 返回内容，避免重复。
- system/schema、任务输入、继承历史和输出安全预留不属于 `isolated`；continuation 只统计新增的 child 私有工作。
- 分母为 0 时不显示百分比。
- 这是 `local-context-v1` 估算，不是 provider 账单节省，也不是缓存命中率。

Provider 实际用量与本地估算必须在 UI 上明确分开。

### 12.3 隐私

Webview 只接收汇总：次数、状态、token/费用分类和本地估算。不得下发：

- child prompt、完整结果或私有 transcript；
- 隐藏推理、工具结果正文；
- API key、endpoint identity、内部 compatibility hash；
- Usage Ledger 原始记录。

## 13. 修改检查清单

### 改 profile、工具或协议

1. 同步 schema 白名单和 Runner 执行时门禁。
2. 检查当前 V15 schema 字节稳定、Evidence reader 与 UTF-8 byte-offset result reader。
3. 确认嵌套与 proposal lane 没有获得额外副作用能力。
4. 更新 compatibility hash 与 continuation 测试。

### 改调度、超时或预算

1. 保持父子共享逻辑任务时钟、费用和取消状态。
2. 并行时间按区间并集核算。
3. 队列不能绕过全局/root/proposal/depth/tree 上限。
4. 不得重新引入隐式默认超时或预算重置。

### 改 proposal

1. 批次预检和返回后的实际 URI 复检都要保留。
2. 产物数量以宿主记录为准。
3. DraftEdit/DraftRun 必须回到父审批管线。
4. 崩溃和不确定副作用 fail closed。

### 改统计

1. 实际 provider 用量与本地隔离估算分开。
2. failed/stopped、nested、重复 ID、非法 schema 拒绝和币种分组必须覆盖。
3. UI payload 做隐私测试。

## 14. 回归测试

```bash
bun run build:test
bun run test
```

重点测试：

| 测试 | 契约 |
| --- | --- |
| `test/subagentArchitecture.test.ts` | profile、调度、协议、结果、continuation 与持久化 |
| `test/subagentSafety.test.ts` | 输入隔离、工具门禁、路径作用域、proposal 冲突与 fail-closed |
| `test/subagentUsageStats.test.ts` | 当前 schema 校验、累计/明细、去重、币种和本地估算 |
| `test/subagentUsageRuntime.test.ts` | 实际 usage 归集、失败/停止、nested 去重与 UI 隐私 |
| `test/p1Delegation.test.ts` | 候选合同、依赖门禁、显式选择与父验收路由 |
| `test/runDetails.test.ts` | 生命周期/完成程度/父判断的有界展示与持久化 |

审查子代理改动时，最关键的问题是：**这个 child 是否只获得任务必需的信息和能力，它的结果是否仍必须经过父会话原有的安全边界？**

## 长任务进展与结果等待

父运行的进展按已交付内容/范围与真实宿主状态判断，不按新的 child/evidence ID 判断。`readResult` 对本 runtime 中确实 queued/running、且 parent session 匹配的 child，等待完成事件；不不断请求模型轮询。取消沿用 invocation signal，完成后再次通过 store 校验 lineage、scope 和结果完整性。磁盘上中断的 child 不冒充活跃操作。检查点引用按 session 独立，复制会话不继承旧 session 的可执行 checkpoint/归档引用。费用、时间与用量归属保持现有共享逻辑任务规则。

共享项目指令按全局→仓库根→任务 cwd 的顺序传入隔离 capsule，不按路径重新排序。标准 Skill 不需要 KeepSeek profile；可选 `metadata.keepseek.runAs/profile` 类能力属于 KeepSeek 扩展（实际 profile 字段见源码与共享配置报告），不会因文件声明而增加权限。
