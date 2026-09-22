# KeepSeek Agent 运行时工作流

> 本文是运行时主线的交接文档：从扩展激活、请求构建、流式工具循环，到审批、副作用、长任务和崩溃恢复。目录职责见 [`keepseek-code-architecture.md`](keepseek-code-architecture.md)，请求字节与上下文容量见 [`cache_keepseek.md`](cache_keepseek.md)，子代理见 [`../SUBAGENTS.md`](../SUBAGENTS.md)。

## 1. 运行时边界

KeepSeek 是 VS Code 扩展，不是独立 Agent 服务。宿主掌握会话、工作区权限、工具执行、审批和持久化；模型只产生文本、工具调用及待审核提议。

```text
VS Code / Webview
  → KeepseekChatViewProvider
  → AgentRequestCoordinator
  → AgentRunner / AgentLoop
  → provider-native projection
  → Provider client + SSE parser
  → Tool / Evidence / Context Epoch
  → AgentResponse
  → session persistence + Webview update
```

最重要的责任边界：

- `extension.ts` 只做激活、注册和接线。
- `KeepseekChatViewProvider` 是 UI、会话和服务协调者，不承载 patch 或进程执行算法。
- `AgentRunner` 编排模型与工具循环，可以生成 DraftEdit/DraftRun，但不能直接写盘或 spawn。
- 文件变更只由 `ChangeSetStore` + `SafeFileEditor` 落盘。
- 命令只由 `DraftRunExecutor` 在消费一次性 permit 后执行。
- Provider 客户端只处理各自协议、认证和流式解析，不复制上下文/审批逻辑。

## 2. 关键模块

| 层 | 主要入口 | 职责 |
| --- | --- | --- |
| 激活与宿主 | `src/extension.ts` | 注册 View、命令、事件和持久化服务 |
| UI 协调 | `src/provider/KeepseekChatViewProvider.ts` | 会话选择、消息分发、状态推送、Apply/Run 入口 |
| 请求协调 | `src/agent/agentRequestCoordinator.ts` | 请求快照、压缩刷新、Runner 生命周期 |
| Agent 循环 | `src/agent/runner.ts`（`AgentLoop` / `AgentRunner`） | 模型调用、工具路由、轮次推进、最终响应 |
| 请求协议 | `src/agent/protocol.ts`、`providerRequestProjection.ts` | system、schema、三协议原生投影 |
| Context | `currentRunContext.ts`、`context/references/*`、`skills/*` | 项目指令、Skill、引用和授权 |
| 长上下文 | `historyProjection.ts`、`historyCompressor.ts`、`evidence/*`、`contextEpoch.ts` | 摘要、结果准入、Evidence、rollover |
| 副作用 | `edits/*`、`runs/*`、`approvals/*` | 草案、审核、应用、执行与恢复 |
| 来源 | `accounts/*`、`agent/providers/*` | 凭据解析、模型发现、协议请求与 SSE |
| 持久化 | `sessions/*`、`runCheckpoint.ts`、`usageLedger.ts` | 会话、checkpoint、用量和诊断 |

共享数据结构优先查 `src/shared/types.ts`；配置只从 `src/shared/config.ts` 读取。

## 3. 扩展启动与状态装配

激活阶段大致按以下顺序完成：

1. 创建账户、模型、会话、ChangeSet、DraftRun、审批、Skill 和 Usage Ledger 等服务。
2. 恢复持久化记录；对重启时仍处于中间态的写入、命令和 Agent run 做保守归一化。
3. 注册 `keepseek.chatView`、工作区命令、右键引用命令与 URI 打开处理。
4. 建立 Provider 与 Webview，推送配置、账户、会话、变更和运行状态。
5. 监听配置、工作区、编辑器和会话变化，更新宿主状态。

Webview 消息的唯一联合类型在 `provider/webviewMessages.ts`。Webview → 扩展的新消息必须同时更新类型、`handleMessage()` 和发送点；扩展主动推送消息不加入该联合类型。

## 4. 一次用户请求

### 4.1 输入规范化与上下文冻结

用户提交后，Provider：

1. 拒绝空输入，并确认工作区、会话和当前 run 状态。
2. 读取当前项目指令、显式/会话/默认/隐式 Skill、Legacy Memory 和授权上下文。
3. 首轮把格式化结果冻结为 `ChatSession.contextInstructions`；后续变化追加到当前真实 user 消息尾部，不回写旧前缀。
4. 按“目录引用 → 文件引用 → Skill”展开输入；外部 URI 先检查精确授权。
5. 持久化原始 `content`、必要时的 `expandedContent`，以及真正发送的 `providerContent`。
6. 建立请求快照与取消控制器，然后交给 `AgentRequestCoordinator`。

项目指令来源只有受信任 workspace root 的 `AGENTS.md`；`.agents/**/AGENTS.md` 属于 Skill，不是全局项目指令。Skill 的脚本只可作为 DraftRun 提议，绝不因激活而执行。

### 4.2 历史与原生请求

Coordinator 先按模型画像刷新摘要，再由 `buildProviderRequestProjection()` 生成实际 lane：

- Chat Completions；
- OpenAI Responses；
- Anthropic Messages。

实际请求、token 估算、工具结果准入和缓存观测共用这一投影。当前 request protocol/tool schema 是 V9；热旧会话只在受控边界迁移。

### 4.3 来源解析

所有凭据必须经 `accounts/accountResolver.ts` 解析。主请求、摘要、模型发现、余额和删除操作不能各自读取 API key/base URL。

- DeepSeek/OpenAI-compatible 使用 Chat Completions lane。
- OpenAI Responses 使用独立 Responses replay。
- Anthropic-compatible 使用 Messages 协议、`x-api-key` 与固定 `anthropic-version`。
- Ollama 只走其兼容对话能力。
- 仅官方 DeepSeek endpoint 启用余额/费用语义；仅官方 Anthropic 默认启用顶层 ephemeral Prompt Caching。

密钥不可写入 workspace、trace、checkpoint 或 Webview payload。

## 5. Agent 工具循环

Runner 反复执行：

```text
构建原生请求
  → 流式读取 assistant 内容/推理/工具参数
  → 原子提交完整工具调用
  → 宿主授权与执行
  → 保存 Evidence 和 provider envelope
  → 继续同一逻辑任务或结束
```

流式中间参数不能执行。只有完整、可解析且当前 schema 允许的工具调用才进入路由。工具调用 ID、结果顺序与协议原生块必须保持配对。

### 5.1 工具族

| 工具族 | 代表能力 | 副作用 |
| --- | --- | --- |
| 工作区读取 | list/read/range/search/diagnostics | 无；限工作区或已授权 URI |
| 语义读取 | symbols/references/definitions/implementations | 无；由 VS Code language service 提供 |
| Git 读取 | status/diff/branch/patch/commit message 建议 | 无；commit/push 不在此工具族 |
| 验证 | compile/lint/test | 仅固定脚本，不接受任意命令 |
| Evidence | `keepseek_read_evidence` | 无；按 task/session 隔离、分页读取 |
| 变更提议 | DraftEdit、incremental edit、apply patch/delete | 只生成待确认 ChangeSet |
| 命令提议 | DraftRun | 只生成待批准命令，不 spawn |
| 子代理 | delegate/parallel | 隔离 child run；详见 `SUBAGENTS.md` |

新增工具时需要同时更新 schema、Runner 路由、授权分类、协议版本策略和测试；实现应放在独立模块，而不是继续扩大 Provider 或 Runner。

### 5.2 Evidence 与交付状态

大结果先完整保存到 task-scoped Evidence，再生成有界 envelope。典型状态为：

```text
pending → executing → completed → envelope_ready → sending → delivered
```

恢复时根据已持久化状态继续交付，不重跑已完成工具。`executing` 状态若无法证明是否发生副作用，必须标记 uncertain 并停止自动恢复。

`keepseek_read_evidence` 只能读取同 session/task 的 evidence，并受分页和大小限制。Evidence 内容与 shell/搜索输出始终视为不可信数据，不能被当作项目指令。

### 5.3 Context Epoch

当最小 envelope 无法装入、单 epoch 工具阈值到达、软压力持续，或 provider 报 context-too-long 时，`ContextEpochManager` 外置 checkpoint 并切换 replay lane。

rollover 保持原任务、证据、工具幂等、审批、副作用、时间和费用账本，不创建新会话、不伪造 user 消息、不自动执行任何动作。详细容量和缓存规则见缓存文档。

## 6. DraftEdit 写入管线

模型不能直接写文件。规范流程为：

```text
工具调用
  → canonical DraftEdit
  → ChangeSetStore
  → 审批/用户确认
  → SafeFileEditor
  → read-back 校验
  → applied / failed / uncertain
```

### 6.1 DraftEdit 形式

- `text_patch_v1`：局部 byte hunks，绑定 URI、base/result hash、size、编码和 EOL。
- `full_text_v1`：新建或整体替换。
- `delete_v1`：删除；需要额外高风险确认。
- `move_v1`：显式源/目标移动。

原始 unified patch、模型行号和模糊匹配不是 Apply 权威。`keepseek_apply_patch` 必须先归一化为 canonical Patch IR。

### 6.2 Apply 与恢复

SafeFileEditor 在落盘前持久化 prepared journal，核验 base，再使用同目录临时文件、fsync/原子替换并 read-back 校验 result hash。重启后按磁盘的 base/result/unknown 状态恢复；未知副作用不重试。

局部 patch 的回滚保存 inverse patch；delete/full replace 的原始字节进入 global storage 下的 SHA-256 content-addressed blob。大正文不嵌入 ChangeSet、checkpoint 或 Webview。外部 URI、符号链接、脏编辑器、非 file provider 和配额在实际 Apply 时重新检查。

Diff 默认延迟生成，超阈值显示 hunk review。目录、二进制、越界和不满足基线的删除直接拒绝。

## 7. DraftRun 命令管线

任意命令与固定 validation 分离：

```text
keepseek_run_draft
  → immutable pending DraftRun
  → 硬检查 + 审批记录
  → ExecutionPermit(draftRunId, specHash, expiry, one-shot)
  → DraftRunExecutor
  → completed / failed / cancelled / timed_out / interrupted
```

审核面完整展示 executable、argv、cwd、env、用途和风险。执行使用：

```ts
spawn(executable, args, { shell: false })
```

需要 shell 语法时，shell 本身必须作为 executable，原始脚本作为可见 argv。拒绝不能改写命令；要修改只能新建 DraftRun。未受信任工作区、未授权外部 cwd、specHash 不匹配、过期/重复 permit 均硬拒绝。

完成记录可克隆为新的 pending，但必须再次批准。重启时 `approved/running` 只能变为 interrupted，绝不自动重跑。

## 8. 审批模式

项目有三档审批模式，仅 Webview 用户操作可切换，且按目标 workspace 持久化：

| 模式 | 决策者 | 行为 |
| --- | --- | --- |
| `ask` | 用户 | 默认；逐项或批量批准 |
| `model_review` | 隔离 reviewer | 长任务适用；逐 actionHash 审查，可拒绝 |
| `delegate` | 宿主策略 | 不经模型审查，但必须生成 `host_policy` 记录 |

共同规则：

- 所有动作先过确定性硬检查，审批不能绕过工作区信任、URI 授权、基线、脏编辑器或 permit。
- reviewer 是无工具、一次性、关闭 thinking 的独立请求，不注入项目指令/Skill/隐藏推理。
- actionHash 绑定完整 canonical payload；patch 即使只展示有界 hunks，也不能复用变更后的批准。
- 批准记录与 session/run/target/kind/hash/policy/runtime 绑定；重启不恢复审批队列，不复用旧 reviewer 批准。
- 停止或切回 `ask` 会撤销队列和未执行授权。
- 决定与真实结果以固定 user-tail 追加到下一条真实 user 消息，不能插入或改写旧历史。
- 修改失败会阻止依赖它的命令；连续拒绝达到熔断阈值时停止续跑。

模型给出的“低风险”分析只供展示，不能自行改变审批模式。

## 9. 执行模式、验证与修复

执行模式与审批模式正交：

- `normal`：可使用当前协议允许的全部工具。
- `plan`：只做分析与计划，限制会产生副作用提议的工具。

`keepseek_run_validation` 仅运行项目定义的 `compile`、`lint`、`test`，不能接受任意 argv。产生 DraftEdit 后，在用户 Apply 前不会假装用未落盘内容验证；Apply 后可进入验证/修复循环。修复仍生成新的 DraftEdit，并重新走审批、基线和 Apply。

验证输出进入 Evidence；失败结果、修复轮次和 `waiting_for_apply` 状态写入 checkpoint，避免恢复后重复或越权。

## 10. 长任务与预算

原 `long-running-agent.md` 的运行时契约已合并到本节。

### 10.1 显式限制

| 配置 | 默认值 | 语义 |
| --- | ---: | --- |
| `keepseek.agent.maxExecutionMs` | `0` | 逻辑任务执行时间上限；0 表示不设显式上限 |
| `keepseek.agent.maxCost` | `0` | 按来源币种的费用上限；0 表示不设显式上限 |
| `keepseek.agent.streamIdleTimeoutMs` | `0` | 流式静默超时；0 表示继续等待 |

旧 `background.maxDurationMs` 仅作兼容输入；与新上限同时存在时取较小的正值。

时间、费用和取消状态属于逻辑任务，不因子代理、Context Epoch 或恢复而重置：

- 主 Agent 与子代理共享任务时钟和费用账本。
- 并行 child 的墙钟时间按区间并集核算，避免简单相加夸大。
- 等待用户批准、Apply 和调度队列的暂停不计入执行时间。
- 使用单调时钟，checkpoint 只保存累计值，不依赖墙钟倒退。
- 费用按币种分别累计，不做隐式汇率换算。
- 设置正费用上限但当前来源无法计价时 fail closed。

有效限制在任务启动时冻结；运行中修改设置不会追溯改变当前任务。Provider 用量只能在响应返回后记账，所以单次已被接受的请求可能略微越过费用线，但下一次请求前必须停止。内部 context capacity、tool step 或 epoch 调度阈值不是用户预算，不能借机重置或扩大显式限制。

### 10.2 流式与重试

网络层区分“收到字节、收到 SSE、得到可消费内容、完成一个 step”。默认允许长时间安静推理；用户设置 idle timeout 后才因静默中止。

安全重试遵循“无法证明请求未执行，就不重发”：

- 模糊 POST 失败、空响应、5xx 不自动重放整个请求。
- 429 只做有界退避，并受剩余时间/费用约束。
- 因长度截断或 provider pause 最多做受控续接；已有部分流式内容时不自动重发原请求。
- KeepSeek 没有 provider job 查询或后台云任务服务；恢复依赖本地 checkpoint，不假设远端可续跑。

### 10.3 Checkpoint 与崩溃恢复

checkpoint 在请求边界、工具意图/结果、审批、Apply、Run、epoch 和重要状态转换处持久化。它保存恢复所需的有限状态，不复制全部私有上下文。

恢复前至少验证：

- session/task、workspace roots 与信任状态；
- source/model、endpoint、请求协议和工具 schema；
- 项目指令、外部授权和必要的 compatibility hash；
- 未完成工具是否可能已有副作用；
- 时间/费用/取消账本是否仍允许继续。

扩展重启后，运行中的 Agent、DraftRun 或 Apply 不会自动继续。确定性只读结果可按 checkpoint 恢复交付；任何 `executing` 副作用若不能证明结果，保持 interrupted/uncertain，交给用户处理。

单个完整模型流和序列化 checkpoint 均有 32 MiB 资源上限；达到上限时停止，不能静默截断必须回放的原生协议数据。关闭 VS Code 不会让任务在后台继续运行。

## 11. 子代理边界

主运行时只负责调度、工具暴露和接收有界结果。子代理拥有独立 AgentLoop、私有 transcript、精确工具白名单、并发/深度限制、路径作用域、continuation token 和独立诊断存储。

父 Agent 只能获得结构化结果和 Evidence 引用，不能读取 child 隐藏推理。proposal child 只能提出 DraftEdit/DraftRun，真实副作用仍回到父会话的审批管线。安全模型、结果协议、复用条件和用量统计统一维护在 [`SUBAGENTS.md`](../SUBAGENTS.md)，不要在本文复制第二套规则。

## 12. 会话、用量与 UI

### 12.1 会话事实与派生状态

- `ChatSession.messages` 保存用户可见事实，普通请求按消息 append-only；只有编辑重发或已进入缓存安全压缩边界的归档维护会改写旧 provider 内容。
- `contextCompression`、`providerReplay`、`toolRounds`、subagent stats 和 checkpoint 是派生/恢复状态，不应污染 transcript。
- 摘要不进入聊天 UI；Evidence 大正文也不进入 session JSON。
- 归档搜索只读全局会话存储，不改变当前会话上下文。

### 12.2 用量

Usage Ledger 记录每个实际 provider 请求的来源、模型、输入/输出、缓存字段、费用和诊断。主请求、摘要、reviewer、子代理必须用不同 usage source 分类；缺失的 provider 计量是 unknown，不得当作 0。

会话/UI 只接收必要汇总。API key、endpoint identity hash、原始 prompt、私有 child transcript 和内部审批证据不得下发。

### 12.3 Run Details

Run Details 用于解释当前上下文来源、工具、Skill、审批、Evidence、epoch、用量和停止原因。它是诊断视图，不是另一个执行入口，也不能把不可信工具输出提升为指令。

## 13. 改动影响面

| 改动 | 必查模块 |
| --- | --- |
| 新增配置 | `package.json` contributes.configuration、`shared/config.ts`、配置测试 |
| 来源/模型/余额 | accountStore、accountResolver、modelDiscovery、Runner、Compressor、Provider、balanceStore |
| system/schema/协议 | protocol、projection、三 Provider replay、缓存观测、协议迁移测试 |
| 压缩/容量 | shared types、historyProjection、historyCompressor、contextUsage、toolResultAdmission、Runner |
| Evidence/Epoch | evidence/*、contextEpoch、runCheckpoint、三协议配对、Run Details |
| DraftEdit | Patch IR、draftEdit、artifact/blob、ChangeSet、SafeFileEditor、Diff、审批 hash、Webview |
| DraftRun/审批 | approvals/*、runs/*、toolAuthorization、Provider、消息类型、i18n、usage |
| 子代理 | runtime、scheduler、profiles、path scope、result protocol、storage、stats、四组测试 |
| Webview 消息 | webviewMessages 联合类型、Provider handler、发送/接收点 |

## 14. 验证矩阵

基础验证：

```bash
bun run compile
bun run lint
bun run build:test
bun run test
```

按改动追加重点：

- 请求/缓存：`cacheByteStability`、`protocolCache`、`p1CacheObservability`、`openAiResponses`、`anthropicMessages`。
- 压缩/Epoch：`historyCompressor`、`historyProjection`、`currentRunContext`、`toolResultBudget`。
- 写入：ChangeSet、SafeFileEditor、patch/delete/move、重启与 Revert。
- 命令/审批：三模式、actionHash、permit 单次消费、取消/超时/重启、Windows/POSIX argv。
- 子代理：`subagentArchitecture`、`subagentSafety`、`subagentUsageStats`、`subagentUsageRuntime`。
- Webview 大字符串：输入、拖拽、`@` 引用、编辑重发、Apply/Discard 手测。

发布前使用 `bun run package:market`；不要用 `vsce package --no-dependencies` 绕过依赖和 VSIX 内容校验。

## 15. 维护判断准则

遇到跨层改动时，依次确认：

1. 是否改写了已发送请求字节或拆散了原生协议轮次？
2. 是否让模型绕过 DraftEdit/DraftRun、审批或一次性 permit？
3. 是否把未授权路径、密钥、私有 transcript 或不可信输出带入了错误边界？
4. 是否能从 checkpoint 区分“未发生”“已完成”和“可能发生过”？
5. 是否让主请求、摘要、reviewer、子代理或不同 provider lane 的用量混算？

只要其中一项答案不明确，就应先补齐状态模型与回归测试，再继续实现。
