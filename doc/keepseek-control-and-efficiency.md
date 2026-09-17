# KeepSeek 可控性与高效性技术特性清单

> 本文基于当前仓库源码（`src/`）与 `doc/` 既有文档整理，回答「KeepSeek 如何确保可控与高效」这一问题，并把相关已支持功能单独列出。文中所涉模块路径与行段以当前仓库为准。
>
> 一句话总结：**可控性**来自「三层审批 + 不可变 Draft 管线 + 多维执行预算 + 持久 Goal 状态机（BDI 风格） + 分布式租约/恢复」；**高效性**来自「前缀缓存字节冻结（第一优先级） + 上下文投影压缩 + Context Epoch 滚动 + 有界并行子代理 + 用量统计与动态窗口校准」。

---

## 一、总体架构映射

| 关注点 | 机制 | 核心模块 |
|---|---|---|
| 写入/执行护栏 | DraftEdit / DraftRun，先批准后生效，绝不提前生效 | `src/edits/`、`src/runs/`、`src/approvals/` |
| 审批模式 | `ask`（逐项人工）/ `model_review`（隔离模型审查）/ `delegate`（宿主策略自动批准） | `src/agent/approvalMode.ts` |
| 执行预算 | 时间、费用（按币种）、模型请求数、Goal 专项预算 | `src/agent/executionPolicy.ts`、`src/agent/goals/` |
| 分层任务分解 | Goal 契约 + 状态机 + TaskPlan + 有界子代理调度 | `src/agent/goals/`、`src/agent/taskPlan.ts`、`src/agent/subagents/` |
| 持久目标（BDI 风格） | 目标契约、验收条件、预算、租约、checkpoint 恢复、完成审查 | `src/agent/goals/` |
| 上下文成本控制 | 前缀缓存字节冻结、append-only 历史、低频摘要、Context Epoch | `src/agent/historyProjection.ts`、`historyCompressor.ts`、`contextEpoch.ts` |
| 模型容量管理 | 工具结果准入、effective window 动态校准、证据不可变分页 | `src/agent/toolResultAdmission.ts`、`contextWindowCalibrationStore.ts`、`src/agent/evidence/` |
| 并行与核算 | 并发信号量、深度/路径声明约束、用量与缓存命中率统计 | `src/agent/subagents/scheduler.ts`、`subagentUsageStats.ts`、`usageStats.ts` |
| 受控验证 | 只运行固定 `compile` / `lint` / `test`，失败后须 Apply 修改方可再验证 | `keepseek_run_validation`（VS Code Tasks API） |

---

## 二、预算与护栏（已支持）

### 2.1 执行时间预算 `ExecutionClock`
- 同一逻辑任务的有效执行毫秒预算，**跨 attempt、Epoch、重启恢复延续**，不清零。
- 父子任务树的活跃时间取**并集**，不累加并行子任务时长；等待授权、Apply、子任务排队**不计费**。
- 使用**单调时钟**、每 250ms 采样；超过 5 秒的宿主停顿（休眠/不可调度）保守排除，不以系统日期跳变判断到期。
- 超限即通过 `AbortController` 中止整条执行链；`0` 表示不限。
- 配置项：`keepseek.agent.maxExecutionMs`、`keepseek.goal.maxActiveExecutionMs`。

### 2.2 费用预算 `ExecutionCostBudget`
- 同一逻辑任务的 Provider 已统计费用上限；按每次 Provider 真实用量与请求时冻结的价格记账。
- **不同币种分别核算、不换算相加**；正值上限对每个币种独立生效。
- **fail-closed**：无法计价的自定义网关不能在正值费用上限下启动；一旦 Provider 已接受请求导致轻微越限，会在下一次模型请求前停止，**绝不重跑工具来“补查”费用**。
- 配置项：`keepseek.agent.maxCost`、`keepseek.goal.maxCost`。

### 2.3 模型请求数预算 `ModelRequestBudget`
- 单调递增的运行时请求账本，跨根任务与全部子孙共享，持久化 checkpoint 恢复计数。
- 主请求、重试、Epoch 摘要、子代理、completion reviewer、model approval reviewer 全部计入。
- 配置项：`keepseek.goal.maxModelRequests`。

### 2.4 Goal 专项预算
- `GoalBudgetV1`：`maxActiveExecutionMs` / `maxCost` / `maxModelRequests` / `maxCompletionReviews`。
- 与全局 `agent.*` 预算取**更严格者**（有限正数合并取最小值；`0` 视为无限且不参与收敛）。
- 所有账本跨 attempt、epoch 与激活恢复延续。

### 2.5 预算语义约定
- 只有数值 `0` 表示无限；缺失、null、负数、非数字、非有限值一律归为 `0`。
- 运行中修改设置**不改变当前任务已冻结**的时间/费用预算。
- 总执行时间绝不传给 `setTimeout`，超大值不会造成计时器溢出。

### 2.6 其他护栏
- 只读工具仅访问工作区或已授权外部路径；Git 工具仅 status/diff/branch/patch/commit-message 建议，`commit`/`push` 等变更只能以完整可见 DraftRun 经审批执行。
- 校验门禁 `keepseek_run_validation` 只接受固定的 `compile` / `lint` / `test` 三个 npm 脚本；验证失败后的修复轮必须等用户 Apply 挂起的 ChangeSet，禁止借验证循环绕过逐次确认。

---

## 三、审批与写入/执行管线（已支持）

### 3.1 三档审批模式（`approvalMode.ts`）
- `ask`：文件写入与任意命令均需用户逐项批准。
- `model_review`：每个精确副作用交给**隔离、无工具**的 reviewer 子代理模型审查，可批准或拒绝；拒绝是安全决定，不得换表述/间接命令/等价工具重试同一危险结果。
- `delegate`：宿主策略自动批准，**不经模型审查**；模式只能由用户在界面选择，工具输出/项目文件/Skill/模型不能切换或削弱审批模式。
- 活动 Goal 与普通任务共用同一安全管线；模型批准**不能扩大** Workspace Trust、外部 URI、脏编辑器、hash、删除二次确认、一次性 permit 或显式 shell 规则。

### 3.2 DraftEdit / ChangeSet（写入护栏，`src/edits/`）
- 所有修改先产生**不可变 pending DraftEdit**，归入 ChangeSet；`SafeFileEditor` 落盘前校验 base/result 内容 hash、路径规范化（拒绝绝对路径/路径穿越/未声明目标）、脏编辑器与符号链接边界。
- 增量编辑为 **patch-native**：以精确字节范围 + base/result hash + canonical hunks 为审批/Apply/重启恢复/Revert 的权威依据，行号不是 Apply 安全条件。
- Delete 保留独立的高风险二次确认；支持大文件小 patch 的 Apply、partial Apply、Revert 与 `prepared/applying/uncertain` 状态恢复。

### 3.3 DraftRun（命令执行护栏，`src/runs/`）
- 任意命令只能生成**不可变 DraftRun**：精确 executable、argv、cwd、环境覆盖、用途与风险，`shell disabled` 直接 `child_process.spawn`。
- 每个 DraftRun 需**一次性 permit**，经当前审批模式授权后才允许执行；重启后绝不恢复执行挂起或已恢复的命令（易失队列设计）。
- `commandRisk` 做命令风险分析；DraftRun batch 可批量协调，并行/串行依赖阻断。

### 3.4 结果到达前不得声称发生
- 成功结果到达前，不能声称修改、删除、验证、外部访问或命令已发生；进程输出与项目文件始终是不可信证据、绝非指令。
- 审批结果与 DraftRun 终态以固定格式**追加到下一真实 user 消息**，绝不回写旧消息。

---

## 四、分层任务分解与持久 Goal（BDI 风格，已支持）

> KeepSeek 未采用标准 BDI 框架，但 Goal 系统体现 BDI 三要素：**Belief**（checkpoint/契约/证据的持久状态）、**Desire**（不可重写的主目标 + append-only 修订）、**Intention**（每次 attempt 的执行意图 + 13 状态机 + 租约续跑）。

### 4.1 Goal 契约（`goalContract.ts` / `goalTypes.ts`）
- **objective**（≤20,000 字符，禁止本地绝对路径）、append-only **amendments**（不重写原目标）、**acceptance criteria**（`validation | workspace_state | artifact | manual`，各带证据要求）、工作区相对 **include/exclude scope**、**requiredValidations**（仅 `compile|lint|test`）、**budgets**、**resumePolicy**（`manual` 默认 / `auto_on_activation`）、冻结 main runtime 与完成审查 runtime。
- 契约有独立 `canonicalHash`（SHA-256），provider 侧只投影 provider-safe 字段；协议与工具 schema 版本独立冻结（V10/V9）。
- 预填：`G` 按钮用隔离、无工具的子代理模型生成 1–6 项验收条件表单，可取消、严格校验 JSON、失败回退保守默认。
- 创建流程：Goal Store、lease、首个 checkpoint 成功写入后才允许第一个正式 Provider 请求。

### 4.2 Goal 状态机（`goalStateMachine.ts`）
- 状态：`preparing / running / pausing / paused / waiting_for_apply / waiting_for_authorization / waiting_for_command / waiting_for_user / needs_attention / interrupted / completed / failed / stopped`。
- 所有转移白名单校验，非法转移抛错；终端态（completed/failed/stopped）不可逆。

### 4.3 分布式租约（`goalLease.ts`）
- 基于文件系统 guard + lease + **单调 fencing token** + 心跳（默认 TTL 30s）防止多窗口/多 Host 竞态。
- stale takeover 必须超时、复读、确认 Goal 状态后才允许，且取得调度权不代表旧副作用可重试。
- 无可靠绝对本机存储路径时**不运行 Goal**（fail-closed）。

### 4.4 checkpoint、恢复与续跑（`goalCoordinator.ts` / `goalRecovery.ts` / `goalReplay.ts` / `runCheckpoint.ts`）
- 每个完整步骤与模型请求前保存 checkpoint，流式与活动最多每 15 秒增量保存；保存失败停止后续调度。
- 激活时 `running/pausing` 先持久化为 `interrupted`，再核对 workspace/session/source/model/checkpoint/Trust/授权/ChangeSet/DraftRun/approval/lease 全部上下文后才可恢复；恢复默认 `manual`。
- 旧 validation 与 completion decision 在重启后**保守失效**（无法证明文件未变）；未知工具结果永不自动重跑。
- 活动 Goal 使用独立 Goal replay lane（V10），不伪造 `ChatSession.messages`，终态 assistant 携带完整三协议 replay，下一条真实 user 消息可从精确 Provider 前缀继续。

### 4.5 完成审查（`goalCompletionReview.ts`）
- 无工具调用返回 `candidate_final` 后，宿主先复核 lease、身份、Trust、授权、TaskPlan、criteria、最后 mutation 之后的验证、所有副作用终态与预算，再调用**隔离、无工具、无写入/执行能力**的 completion reviewer。
- reviewer 决策绑定 contract/revision/candidate/evidence manifest/mutation revision，提交 completed 前全部重验。
- 仅纯机器可验证 criteria 才允许 reviewer 不可用回退；正费用上限下无法计价 reviewer 时不允许回退；`manual` criterion 必须由用户在管理弹窗明确确认。

### 4.6 TaskPlan 运行时任务跟踪（`taskPlan.ts`）
- 每个 run 附带结构化计划（goal + steps），步种类 `inspect / edit / validate`；工具错误转为 blocker，plan 进入 `blocked`，解决后恢复 `running`。
- 步骤状态：`pending / in_progress / completed / blocked`（含 detail），全程可观测。

### 4.7 子代理：分层分解与调度约束（`src/agent/subagents/`）
- 内置 profile：`research`（只读研究）、`review`（只读审查）、`proposal`（只准备 DraftEdit/DraftRun，**永不应用/执行**）；Skill 可注册自定义 subagent profile。
- 调度器信号量：根并发 3、总并发 4、proposal 并发 2；**深度 ≤ 2**、每父 run 子代理 ≤ 8、每棵树 ≤ 12。
- **路径声明（pathScope）**：proposal 子代理必须声明将要修改的工作区相对路径；与父 DraftEdit 或其他活跃子代理的作用域冲突即拒绝，防止并行编辑被静默合并。
- 子代理结果进入隔离证据管线，只返回有界结果；父子历史隔离，任务必须自包含。

---

## 五、高效性：缓存与上下文工程（已支持，第一优先级）

### 5.1 前缀缓存字节冻结（最高优先不变式）
- DeepSeek 前缀缓存从 token 0 起逐字节匹配：命中价 1/50（flash）～1/120（pro）。任何历史字节漂移都会使该点之后整段缓存失效。
- 约束：system 段纯静态；user 消息“发送字节 == 持久化字节”；assistant 消息原样持久化；历史投影 **append-only**；工具 schema 按会话冻结（禁用用 `tool_choice: none` 而非移除 tools）；工具结果按实际请求容量保存一次 provider-visible envelope、恢复时逐字节复用。
- 禁止：时间戳/随机 UUID/绝对路径/激活 reason 写入 system 或历史；热会话重写历史；schema 随 prompt 变化。

### 5.2 分层前缀 + 低频失效点（`protocol.ts` / `cache_keepseek.md`）
- 请求布局 base-first：固定 system → contextInstructions（AGENTS.md/Skills/Legacy/Context Files，字节不变则逐字节复用）→ synthetic summary（低频刷新）→ append-only 历史 → 当前 prompt。
- 摘要压缩、技能重激活、工具集裁剪等改写前缀的操作刻意低频；运行中变化的上下文追加到新 user 消息尾部，不回写旧前缀。

### 5.3 历史压缩与回退（`historyCompressor.ts` / `historyProjection.ts`）
- 摘要只留线索（目标、决策、错误、文件路径/行段/函数、完成项、待办），不保留文件正文；需要细节时重读当前文件。
- 自动保护：首条需求、最近输入、显式“记住”、报错/测试失败、用户纠错、DraftEdit 结果不被摘要覆盖。
- 摘要增量阈值 48 条消息，刻意压低刷新频率（低频缓存失效点）。
- 多级回退：摘要失败只记录原因不阻塞 → 无摘要且投影超 `forceRatio` 时截断为最近消息尾部。

### 5.4 Context Epoch 滚动（`contextEpoch.ts`）
- 同一逻辑任务内的受控 provider 上下文滚动：软压力 / 最小信封放不下 / 工具轮阈值 / provider context-too-long / 续写 / 协议迁移等触发。
- rollover 完整宿主状态外置为 task-scoped checkpoint evidence，只切换 replay lane 并追加有界 seed；不改写 `ChatSession.messages`、不插入伪 user 消息、不创建新任务。
- 保存工具幂等指纹（toolName + args/result hash + source fingerprint）与 no-progress 检测，已完成工具不因交付失败而重跑。

### 5.5 工具结果准入与窗口校准（`toolResultAdmission.ts` / `contextWindowCalibrationStore.ts`）
- 单次准入使用真实三协议 projection、动态输出预留与 learned effective window；正在运行的任务不受固定累计工具结果预算约束。
- 放不下时保存完整 evidence/hash，通过 `keepseek_read_evidence` 分页读取；最小信封放不下时自动 rollover。
- 上下文窗根据实际命中情况动态校准，而非只信模型声明值。

### 5.6 证据不可变与分页复用（`src/agent/evidence/`）
- 大型工具结果保存为任务隔离的不可变证据信封（`evidenceRef`、`contentHash`、总量、分页说明），同一任务内按需分页读取，不重复执行原工具。

---

## 六、高效性：并行与核算（已支持）

### 6.1 并行子代理（`scheduler.ts` / `runtime.ts`）
- 有界并发执行真正独立的子任务（`keepseek_delegate_parallel` 批量校验后整体预留），结果按输入顺序返回；一个失败不影响已完成同胞结果。
- 嵌套只读/审查 lane 与 proposal lane 分离，防止不可信提案在审查读路径上乱跑。

### 6.2 用量统计与缓存命中率（`usageStats.ts` / `subagentUsageStats.ts`）
- 分来源（executor/summary/retry/continuation/background/reviewer/subagent/retrieval/router）、按币种核算成本，统计 `cacheHitRate` 与失效归因。
- 子代理用量独立估算并按树汇总，供调度与费用上限共用；`keepseek.agent.streamIdleTimeoutMs` 提供显式断开策略。

---

## 七、已支持功能速查清单

| # | 功能 | 状态 | 入口/依据 |
|---|---|---|---|
| 1 | 三层审批 ask / model_review / delegate | ✅ | `src/agent/approvalMode.ts` |
| 2 | DraftEdit 不可变草稿 + ChangeSet + hash 校验落盘 | ✅ | `src/edits/` |
| 3 | 大文件小 patch、Apply/Revert/partial、uncertain 恢复 | ✅ | `src/edits/safeFileEditor.ts`、`changeSetStore.ts` |
| 4 | DraftRun 一次性 permit 命令执行（shell disabled） | ✅ | `src/runs/` |
| 5 | 执行时间预算（单调时钟、按树种并集、重启延续） | ✅ | `src/agent/executionPolicy.ts` |
| 6 | 费用预算（按币种、fail-closed） | ✅ | 同上 |
| 7 | 模型请求数预算 | ✅ | 同上 |
| 8 | Goal 专项四维预算 + 与全局取更严 | ✅ | `src/agent/goals/goalTypes.ts` |
| 9 | 持久 Goal：契约/验收条件/scope/修订 append-only | ✅ | `src/agent/goals/goalContract.ts` |
| 10 | Goal 13 状态机（含 waiting_for_user/needs_attention） | ✅ | `src/agent/goals/goalStateMachine.ts` |
| 11 | Goal 租约 + fencing token + 心跳 + stale takeover | ✅ | `src/agent/goals/goalLease.ts` |
| 12 | 每步/每请求 checkpoint，15s 增量保存 | ✅ | `src/agent/runCheckpoint.ts`、`goalCoordinator.ts` |
| 13 | 崩溃/重启恢复（默认 manual，auto_on_activation 可选） | ✅ | `src/agent/goals/goalRecovery.ts` |
| 14 | 隔离完成审查 reviewer + 证据清单 | ✅ | `src/agent/goals/goalCompletionReview.ts` |
| 15 | Goal 独立 replay lane（V10，不伪造 chat 历史） | ✅ | `src/agent/goals/goalReplay.ts` |
| 16 | TaskPlan 步骤/blocker 可视化跟踪 | ✅ | `src/agent/taskPlan.ts` |
| 17 | 子代理 research/review/proposal 三档 profile | ✅ | `src/agent/subagents/profiles.ts` |
| 18 | 子代理并发/深度/每父/每树上限 | ✅ | `src/agent/subagents/scheduler.ts` |
| 19 | proposal 路径声明冲突检测（防并行编辑覆盖） | ✅ | `src/agent/subagents/pathScope.ts` |
| 20 | 受控验证仅 compile/lint/test | ✅ | `keepseek_run_validation` |
| 21 | 前缀缓存字节冻结（第一优先级） | ✅ | `doc/cache_keepseek.md`、`src/agent/protocol.ts` |
| 22 | append-only 历史投影、动态内容追加尾部 | ✅ | `src/agent/historyProjection.ts` |
| 23 | 历史摘要压缩（低频刷新 + 多级回退 + 保护消息） | ✅ | `src/agent/historyCompressor.ts` |
| 24 | Context Epoch 滚动（六类触发、checkpoint 证据） | ✅ | `src/agent/contextEpoch.ts` |
| 25 | 工具结果准入 + effective window 动态校准 | ✅ | `src/agent/toolResultAdmission.ts` |
| 26 | 证据不可变信封 + 分页读取复用 | ✅ | `src/agent/evidence/` |
| 27 | 用量/缓存命中率统计、按来源与币种核算 | ✅ | `src/agent/usageStats.ts`、`subagentUsageStats.ts` |
| 28 | 长任务仅随 Extension Host 推进，无外部 daemon | ✅ | `doc/long-running-agent.md` |

---

## 八、边界与刻意不做的事

- 不是标准 BDI 框架：无显式 Belief/Desire/Intention 本体，改用 Goal 契约 + 状态机 + 租约 + checkpoint 表达同等能力。
- 无外部 daemon / 云 worker / `onStartupFinished`：Goal 只在 VS Code Extension Host 存活时推进，关闭/休眠即停，重新激活可恢复。
- 不静默重发网络请求：POST 失败、空流、网关 5xx 无法证明供应商未受理；429 才允许可取消的有限退避。
- 不自动重跑未完成/不确定副作用：未知工具结果必须人工核实后才继续。
- 自定义网关在正值费用上限下拒绝启动（无法计价 → fail-closed）。