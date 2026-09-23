# KeepSeek 子代理架构、安全与用量

> 子代理主题的唯一交接入口。本文合并了原 `doc/subagent-runtime-security.md` 与 `doc/subagent-usage-statistics.md`，覆盖当前 V10 的隔离、调度、结果协议、恢复和统计。主 Agent 工作流见 [`doc/keepseek-agent-runtime-workflow.md`](doc/keepseek-agent-runtime-workflow.md)。

## 1. 设计目标

子代理用于把有界研究、审查或方案准备工作交给隔离的 child run。它不是共享父 Agent 全部上下文的“第二个线程”，也不能成为审批和文件/命令边界的旁路。

核心原则：

1. child 只接收自包含任务和最小宿主上下文。
2. 工具白名单由宿主在 schema 与执行时双重约束。
3. child 返回结构化结论与 Evidence 引用，不暴露隐藏推理或完整私有 transcript。
4. proposal 只能产生草案；实际写入和命令仍回到父会话审批管线。
5. 时间、费用和取消属于同一逻辑任务，不能通过委派重置。

当前 `SUBAGENT_PROTOCOL_VERSION` 为 **10**，与 provider request/tool schema V10 对齐。V10 将完整 child 结果留在隔离 run store，只向父 Agent 返回有界 manifest。

## 2. 权威模块

| 关注点 | 模块 |
| --- | --- |
| 调度与生命周期 | `src/agent/subagents/runtime.ts`、`scheduler.ts` |
| profile 与 Skill 适配 | `src/agent/subagents/profiles.ts` |
| 任务/结果协议 | `src/agent/subagents/resultEnvelope.ts`、`types.ts` |
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
- 父 Context Files、会话归档与 Legacy Memory；
- 与任务无关的 Skill 或外部路径授权；
- API key、审批 permit、父 Agent 的可变内部对象。

项目指令和工具输出仍按不可信边界处理；它们不能要求提升工具、审批模式、深度或路径权限。

## 5. 模型选择与设置

子代理设置按 workspace + profile 存储在：

```text
globalStorageUri/subagent-settings/v1/<workspaceHash>.json
```

每个 profile 可选择：

- 跟随主模型；或
- 固定 `sourceId + modelId`。

固定来源/模型不可用时 fail closed，不自动降级到另一个来源。子代理 thinking 始终关闭，以控制私有上下文、成本和结果协议稳定性。

不要再读取旧的账户级 `settings.v1.json`，也不要假定存在 5 分钟或 15 分钟的内置 child 默认超时。child 的显式 `timeoutMs`、profile 限制与父任务 `keepseek.agent.maxExecutionMs` 合并，且共用任务时钟。

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

- V8+ child 使用通用 `keepseek_read_evidence` 读取普通工具证据。
- V10 child 同时使用固定 schema 的 `keepseek_read_subagent_result`，按 result ref 分页读取完整 child 结论；V1–V9 保留原 schema 字节。
- V9 才允许 `keepseek_apply_patch` schema。
- 只有 profile 明确允许、深度小于 2 且 lane 不是 `proposal` 时，才暴露再委派工具。

模型即使伪造未暴露工具名，也会在执行时被拒绝并留下诊断。

## 8. 路径作用域与 proposal 安全

路径规则先按稳定 workspace roots 归一化，再生成作用域和 compatibility hash。禁止用工作目录偶然顺序、相对路径别名或符号链接绕过作用域。

proposal 的宿主检查分两阶段：

1. **批次预检**：在启动并行 proposal 前，检查 sibling tasks、活跃 proposal 与父会话现有 DraftEdit 的作用域冲突；批次要么整体接受，要么整体拒绝。
2. **结果复检**：child 返回后按实际 artifact URI 再检查一次；模型声明的路径只是提示，不能替代宿主验证。

具有写能力但无法可靠声明路径的单个 proposal 保守占用整个 workspace；并行 proposal 必须给出可解析的路径作用域。冲突、越界、未授权外部 URI、目录/二进制限制和基线变化均 fail closed。proposal child 只能把 canonical DraftEdit/DraftRun 放回父会话；应用、执行、审批 hash、SafeFileEditor 和 ExecutionPermit 与主 Agent 完全相同。

## 9. 结构化结果协议

child 必须返回有界 JSON envelope，而不是任意聊天文本。公共字段包括：

- `taskHash`；
- `status`；
- `summary`；
- `evidence` 引用；
- `uncertainties`。

角色扩展：

- review：`verdict`、`reviewedPaths`、结构化 findings；
- proposal：宿主确认过的实际 artifact 数量和引用，而不是模型自报数量。

若结果格式错误，宿主只允许一次“仅修复格式”的无工具请求；仍不合法则 fail closed。解析器不得从自由文本中猜测安全关键字段。

父 Agent 收到 V2 handoff manifest：固定元数据、最多 1024 字符 summary、默认最多 10KB UTF-8 preview，以及 session/tree 受限的 result ref。单结果 manifest 默认总上限 12KB；parallel/fleet 共用 20KB 总预算并先保留每个 child 的状态与引用。完整接受结果只保存在 child run store 的 canonical transcript result，需要时由 `keepseek_read_subagent_result` 以 12KB 默认页、24KB 最大页读取；普通工具证据仍由 `keepseek_read_evidence` 读取。child 私有工具 trace 和隐藏推理不会回传。

## 10. Continuation 与结果复用

continuation token 只在同一父 session 内有效，并绑定以下 compatibility 信息：

- source/model 与来源配置；
- system/request/tool schema 版本；
- profile 与工具集合；
- 项目指令、workspace manifest；
- 外部授权与路径作用域；
- 父任务和 child run 身份。

任一 hash 不匹配都拒绝继续，不能“尽量恢复”。

已完成结果复用仅适用于 research/review，不适用于 proposal。除了 task 与 compatibility 完全一致，还必须证明 read set 仍新鲜；广泛搜索、无法枚举依赖或环境信息不足时，freshness 为 unverified，禁止复用。

复用时创建新的稳定结果引用，不复制旧私有 transcript，也不伪造新的 provider 调用。父 Agent 的接受/读取行为仍按当前任务记录。

## 11. 取消、重启与诊断

- 用户停止、任务预算耗尽、父 Agent 结束或工作区失信会向整棵 child tree 传播取消。
- 扩展重启时 queued/running child 归一化为 stopped/interrupted，不自动重新派发。
- 已有 provider 请求是否执行不明确时不重放；有副作用可能性的 proposal 状态保持 uncertain。
- progress 事件只允许白名单字段，不能夹带 prompt、密钥或任意模型文本。
- child 诊断会裁剪大小并脱敏凭据、环境变量和绝对路径，默认保留 7 天，且受工作区/session/task 隔离。

运行记录存放在：

```text
globalStorageUri/chat-sessions/v1/subagents/<workspaceHash>/<parentSessionId>/
```

当前以统一 `.run.json` 记录为主，并兼容读取旧的拆分格式。迁移只读旧记录，不应把旧的运行中状态恢复成可执行队列。

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
2. 检查 V8/V9/V10 迁移 lane、Evidence reader 与 UTF-8 byte-offset result reader。
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
2. failed/stopped、nested、重复 ID、旧 schema 和币种分组必须覆盖。
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
| `test/subagentUsageStats.test.ts` | schema 迁移、累计/明细、去重、币种和本地估算 |
| `test/subagentUsageRuntime.test.ts` | 实际 usage 归集、失败/停止、nested 去重与 UI 隐私 |

审查子代理改动时，最关键的问题是：**这个 child 是否只获得任务必需的信息和能力，它的结果是否仍必须经过父会话原有的安全边界？**
