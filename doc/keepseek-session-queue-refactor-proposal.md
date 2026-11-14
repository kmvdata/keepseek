# KeepSeek 多会话项目队列重构方案

状态：**P0、P1、P2 已实施，P3 完整并行执行已实施**（2026-11-14）；P4–P6 仍为设计。P3 交付：运行中可导航、状态按会话隔离、多会话真正并行执行。

**已确认决策（2026-11-13）**

| 决策 | 结论 | 对方案的影响 |
| --- | --- | --- |
| D1 写权限转移 | **显式交棒**，不做抢占 | 废弃时间片抢占；租约只在持有者到达结束边界、或用户显式交棒/取消时转移；新增“等待交棒”状态与超时策略（见 4.6、5.4） |
| D2 审批 | **彻底移除** ask/delegate 产品能力 | 删除审核、人工批准、审批批次与审批审计流程；**保留** `authorization/` 的路径/启动身份/命令语义等安全边界（见 4.7） |
| D3 执行语义 | **普通提交也先进 plan 排队**（选项 A）+ 同回合递进修正 | `runGate` 对 `submit` 一律先进入只读 plan 态；队首会话可跳过“计划展示”，但“取写权限”仍是显式动作（见 4.8） |

D1 与 D2 合起来产生一个新的安全前提（见 4.6、4.7）：**没有审批之后，写权限的唯一闸门是租约，而模型本来就可以直接调用 Apply/执行工具。** 租约因此必须由宿主在工具路由层强制执行，不能只靠 UI 禁用按钮或提示词约束。


相关：需求与现行约束见 [AGENTS.md](../AGENTS.md)，现行职责见[代码架构地图](keepseek-code-architecture.md)，交互所有权见[交互生命周期](keepseek-interaction-lifecycle.md)，存储基线见[存储基线](keepseek-storage-baseline.md)。

## 1. 对需求的理解

原话：一个工程中同时开多个会话；同一时间只允许一个会话为 normal；其余会话创建时自动为 plan；每个项目维护按创建顺序的会话队列，并允许用户以后调整顺序；不同会话可并行执行；执行 plan 时该会话自动变为 normal，且同一时间整个队列只允许排在第一个位置的会话为 normal。

拆成五条可执行规则：

| # | 规则 | 含义 |
| --- | --- | --- |
| R1 | 多会话并存 | 同一项目（workspace key）内多有会话同时存在并可来回切换；只有看见的会话不阻塞其他会话的模型请求 |
| R2 | 单 normal | 每个项目同一时刻**至多一个**会话 `executionMode === 'normal'`，其余为 `plan` |
| R3 | 派生非存储 | 会话的 normal/plan **由项目队列位置派生**，不作为会话自己可随意写的字段；新建会话默认 plan；只有队首可以成为 normal |
| R4 | 队列可调整 | 项目维护有序队列（记录创建顺序），用户可上移/下移/拖动/置顶；顺序即“谁先拿到写权限” |
| R5 | 执行即晋级 | plan 会话获得「执行计划」确认后，会话变为 normal、队列中该会话移到队首；原先占位者自动回到 plan（并保留其原计划）。队列**不允许出现并列第一**：规则是“成为队首才会 normal”，不是“第一个会话才被允许 normal” |

### 1.1 两个必须先定死的语义（否则实现必然跑偏）

**A. “同一时间只允许一个 normal”是“同一时间”还是“同一时间段”？**

- 解释一（严格串行）：项目内任何时刻最多一个会话处于 normal，且 normal 会话可以一直保持，直到用户显式交棒。问题是“用户让第二个会话执行计划”时，必须先把第一个会话降回 plan；若第一个会话正在跑，强行降级会让写权限中途转移，冲突风险最高。
- 解释二（时间片抢占）：同一时刻仍只一个 normal，但“执行”是会话获得 normal 的方式，先到先得；被抢占者立即回到 plan，其正在进行的写操作必须在**一个原子边界**（工具调用完成、Apply 边界）之后才真正让出，绝不打断已落盘的写、也绝不并发两段写。

**决策 D1：采用解释一（显式交棒），不做抢占。** 写租约（write lease）保证任何时刻真正写工作区的会话只有一个，但租约**不会**因为别的会话想执行而被抢走：行动者必须等当前持有者到达结束边界并显式交棒，或由用户显式取消对方任务。原因是“防写冲突”优先于“尽快轮转”，而抢占在持有者正在执行长任务时会把两段写排在同一个难以解释的边界上。代价是行动者可能需要等待，因此 UI 必须清楚显示“等待 X 交棒”而不是静默卡住（见 5.4）。

**B. “不同会话可以并行执行”与“防止写冲突”如何共存？**

拆成两条通道：

- **plan 通道天然并行**：plan 会话只读（现有 `DIRECT_IMPLEMENTATION_TOOLS` 被禁、子代理只能只读），所以任意多个 plan 会话可以同时发起模型请求、读取、检索、生成计划。
- **normal 通道串行**：normal 绑定写租约，同一项目同一时刻只有一个会话持有租约。租约内允许模型请求、工具、Apply、DraftRun 全程执行；租约外会话只能读。

由此得到核心不变式（实施时必须由测试守住）：

1. **INV-1** 每个项目至多一个会话 `effectiveExecutionMode === 'normal'`，且它必须等于 `queue[0]`。
2. **INV-2** 只有一个会话持有 `writeLease`；只有持有者可以产生文件副作用（Apply/删除/移动/验证/DraftRun/Git mutation）。
3. **INV-3** 非队首会话的写入入口全部被拒绝，且拒绝带可操作原因（“排队中，第 N 位”）。
4. **INV-4** 队列顺序的每次变更都持久化并带 revision；并发修改（两个窗口同时调整顺序）必须以 revision CAS 处理，不静默覆盖。
5. **INV-5** 空间化的会话状态不能被全局单例污染的字段（`isBusy`、`activeDraftRunId`、interaction owner）覆盖其他会话；每个会话独立运行上下文。

## 2. 为什么必须重写（现状根因）

现状不是“缺一个队列”，而是**宿主是单会话单运行**：`KeepseekChatViewProvider`（约 10.5k 行）把“活动会话”当全局唯一状态，导致任何多会话并行都只能是伪并发。

| 现状 | 位置 | 后果 |
| --- | --- | --- |
| 全局 `isBusy` 门禁 | `KeepseekChatViewProvider` 的 `isBusy`、`sendPromptImpl` 首个门槛 | 任何会话在跑都会挡住所有会话提交 |
| 全局导航门禁 | `createNewSessionForNavigation` / `selectSession` 检查 `isBusy \|\| isStartingRun \|\| activeDraftRunId` | 运行中不能切会话，多会话形同虚设 |
| 全局单 owner | `InteractionCoordinator` 只有一个 `active` | 第二个会话无法同时拥有前台操作 |
| 全局运行句柄 | `currentRunAbortController`、`activeTaskScope`、`liveContextUsage`、`liveTurnUsage`、`activeDraftRunId`、`activeChangeActions` | 跨会话互相覆盖、取消错会话 |
| 审批单槽 | `DelegatedApprovalQueue` 用一个 `active` + `isBusy` 判断 | 并行时审批批次串行并互相阻塞 |
| 会话可自由改模式 | `setExecutionMode` 直接写 `session.executionMode` | 无法保证 R2/R3 |
| 计划只是提示词尾巴 | `getPlanWorkflowTail` 拼进 user tail；`getPlanPhaseToolBlockReason` 仅拦少几个工具 | 计划阶段的只读约束靠提示词和少量工具黑名单，不是策略层 |
| 无项目级有序权威 | `getSessionSummaries()` 按 `updatedAt` 排序 | 没有队列，没有顺序持久化 |

`doc/keepseek-approval-safety-verification.md` 记录过同类根因（写入期间 `checkBusy()` 锁住交互、单槽审批队列），说明历史修复都是在单会话模型上打补丁。因此本次按需求**彻底替换整条链路**，而不是继续拆函数。

## 3. 目标架构：`src/sessions/` 下的新目录

用户要求“在 src 下创建符合需求含义的全新目录，不复制旧代码”。建议目录名 `src/sessions/queue/`（语义：项目会话队列 + 模式派生 + 写租约 + 并行调度）。

```text
src/sessions/queue/
  types.ts                   队列、租约、运行、视图的纯类型（无 vscode 依赖）
  projectQueue.ts            队列纯函数：插入、移动、置顶、删除、reconcile
  modeGate.ts                模式派生（effectiveMode）与写权限判定（纯函数）
  writeLease.ts              项目写租约：申请/让出/抢占/看门狗（纯状态机）
  queueStore.ts              队列持久化：原子读、revision CAS、损坏校验、墓碑
  queueService.ts            队列用例编排（唯一入口，被 Provider 调用）
  sessionRuntime.ts          每会话运行上下文（取代全局 isBusy/abort/usage 单例）
  sessionRuntimeRegistry.ts  会话 → 运行上下文注册表；并行调度与互斥
  runGate.ts                 提交/执行/续跑的裁决：队列位置 + 租约 + 运行态
  planGate.ts                plan 阶段策略：只读工具白名单 + 越权拦截 + 计划产物
  queueView.ts               面向 Webview 的队列视图投影（不暴露内部句柄）
  diagnostics.ts             队列/租约/并行运行的可观测事件
```

依赖方向：`queue/*` 只依赖 `node:crypto`、`shared/*` 纯类型与现有 `sessions/` 的存储适配器接口；**禁止**反向 import `provider/` 或 `agent/runner.ts`。副作用执行仍然只能由现有 `edits/`、`runs/` 链完成，`queue/` 只发放/收回“现在可以写”的许可，绝不自己写文件或跑命令——这与 AGENTS“Runner/Provider 不得直接写工作区”同级约束一致。

### 3.1 各模块职责与关键接口

**`types.ts`**

```ts
export type SessionExecutionMode = 'normal' | 'plan';

/** 队列里的一项：只保存宿主权威，不复制会话正文。 */
export interface QueueEntry {
  sessionId: string;
  /** 单调递增，创建时分配；用于自定义排序的稳定兜底。 */
  serial: number;
  createdAt: string;
  /** 用户已调整过顺序后为 true；此时不再按 updatedAt 追踪。 */
  userOrdered?: boolean;
}

/** 每个项目一份，是“谁先谁后”的唯一权威。 */
export interface ProjectSessionQueue {
  version: 1;
  workspaceKey: string;
  /** 唯一有意义的顺序；entries[0] 是该项目的 normal 会话。 */
  entries: QueueEntry[];
  /** 每次变更 +1；跨窗口 CAS 的依据。 */
  revision: number;
  /** 当前持有写租约的会话（派生缓存，权威是运行期状态）。 */
  leaseHolderSessionId?: string;
  updatedAt: string;
}

export type LeaseState = 'free' | 'held' | 'revoking';

export interface WriteLeaseSnapshot {
  workspaceKey: string;
  state: LeaseState;
  holderSessionId?: string;
  /** 抢占时排队等待让出点的行动者。 */
  pendingPreemptorSessionId?: string;
  acquiredAt?: string;
  /** 让出点代数；工具/Apply 开始时捕获，结束前核对。 */
  epoch: number;
}
```

**`projectQueue.ts`**（纯函数，可 100% 单测）

- `enqueueNewSession(queue, sessionId, now)`：追加到队尾并分配 `serial`；新建会话因此天然是 plan。
- `moveEntry(queue, sessionId, targetIndex)` / `moveRelative` / `moveToFront` / `moveToBack`：返回**新队列**（不可变），并把 `userOrdered` 置位。
- `removeEntry(queue, sessionId)`：删除会话时出队；若删掉的是队首，下一项自动成为队首。
- `reconcile(queue, liveSessionIds)`：与磁盘会话集合对齐（补进未知会话按 `serial` 追加、剔除已删除会话、去重、修复重复 serial）。
- `effectiveMode(queue, sessionId)`：`entries[0]?.sessionId === sessionId ? 'normal' : 'plan'`。

**`modeGate.ts`**

- `normalizeQueue(queue)`：兑现 INV-1，任何入口拿到的队列都先过它。
- `canWrite(state, sessionId, capability)`：`'edit' | 'command' | 'validation' | 'git-mutation'` 需要 `effectiveMode === 'normal' && lease.holder === sessionId`。
- `describeWriteBlock(...)`：同一处产出 UI 可显示的原因（排队中第 N 位 / 让出中 / 未持有租约）。

**`writeLease.ts`**

- 状态机 `free → held → revoking → free`。
- `request(sessionId)`：空闲即授予；被他人持有则返回 `{ granted: false, position }`。
- `preempt(sessionId)`：当前持有者到达**让出点**（一个工具调用完成、一次 Apply 事务结束、一次 DraftRun 终态）后把租约交给队首；期间持有者不再开启新的写操作。
- `release(sessionId, epoch)`：只有 `epoch` 匹配才能释放，防止“迟到的旧操作把新持有者的租约释放掉”。
- 看门狗：持有者崩溃/超时后租约可被回收，回收同样产出审计事件。

**`queueStore.ts`**

- 位置：与现有 shard 同根，`chat-sessions/v2/workspaces/<hash>/queue.json`，使用 `writeJsonAtomic()`。
- 读取：严格校验 `version/workspaceKey/entries/revision`；损坏时**降级重建**（按现有会话 `createdAt`+`serial` 重建），并记录诊断，不静默丢失用户自定义顺序。
- 写入：`save(queue, expectedRevision)`；revision 不符返回冲突，由 `queueService` 重新读取、重放用户意图后重试（有限次），绝不覆盖式盲写。
- 删除：会话删除时出队写入；与现有删除墓碑/清理流程一致，避免清理后队列残留幽灵条目。

**`sessionRuntime.ts` / `sessionRuntimeRegistry.ts`**

- `SessionRuntime` 持有原本在 Provider 上的会话级字段：`abortController`、`isRunning`、`isStartingRun`、`activeDraftRunId`、`activeChangeActions`、`liveContextUsage`、`liveTurnUsage`、`currentRunContext`、`taskScope`、`lastActivity`。
- `SessionRuntimeRegistry.tryStart(sessionId)`：每个会话**至多一个在跑的前台运行**；跨会话不互斥（这是并行执行的关键）。
- `registry.snapshot()`：一次性给出所有会话的运行相位，供状态投影使用。
- 现有 `InteractionCoordinator` 的单槽语义改为**每会话一个**：可以保留类，但 owner 从全局变为 `Map<sessionId, OwnedOperation>`；如果改动面过大，就在 `queue/` 内实现 `SessionOwnerRegistry`，旧类标记废弃并在下一阶段删除。

**`runGate.ts`**

- 统一裁决三类入口：`submit`（新任务）、`executePlan`（确认执行计划）、`continue`（审批后续跑/命令纠错/修复续跑）。
- 规则：任意会话可 `submit`（plan 会话提交的是“做计划”）；`executePlan` 必须要求该会话可写（即成为队首并拿到租约）；`continue` 继承发起时的租约与队列位置，位置被抢占时返回“已失去写权限，请等待或重新提交”，由 `queueService` 投影成用户可见状态而不是静默失败。

**`planGate.ts`**

- 把 plan 从“提示词尾巴 + 少量工具黑名单”改为**策略级白名单**：plan 会话只暴露只读工具名集合（读文件/搜索/符号/诊断/git 只读/evidence 读取/只读子代理），写工具在**请求投影阶段**就不出现在工具集合里，而不是调用时再拒绝。
- 计划产物仍落在会话消息里，但由 `planGate` 生成结构化 `PlanDraft { id, goal, steps[], contentHash, status }` 并持久化到会话的 `planWorkflow`；「执行计划」按钮只对这一条 `PlanDraft` 生效（绑定 hash，防篡改）。
- `executePlan(sessionId, planId)`：校验 hash → 调用 `queueService.promote(sessionId)`（移到队首 + 申请租约）→ 会话切 normal → 追加执行续跑提示词（原 `PLAN_EXECUTION_CONTINUATION_PROMPT` 语义保留，但改由 `planGate` 拥有）。

**`queueView.ts`**

- 输出给 Webview 的结构：`{ entries: [{ sessionId, title, position, mode, holdingLease, running, canMoveUp, canMoveDown, blockedReason }], revision }`。
- 本模块只做投影，不做裁决；Webview 的每次移动都回传 `revision`，由 `queueService` 做 CAS。

### 3.2 与旧链路的关系（明确废弃清单）

| 废弃 | 替代 |
| --- | --- |
| `ChatSession.executionMode` 作为可写权威 | 由 `ProjectSessionQueue` 派生；会话字段仅保留为**迁移期只读镜像**，写入忽略 |
| `agent/executionMode.ts` 的 `getPlanWorkflowTail` / `DIRECT_IMPLEMENTATION_TOOLS` 黑名单式拦截 | `planGate` 工具集合白名单 |
| `provider/interactionState.ts` 的全局单 owner | `sessionRuntimeRegistry` + 每会话 owner |
| Provider 全局 `isBusy` / `currentRunAbortController` / `activeDraftRunId` | `SessionRuntime` 会话级字段 |
| `DelegatedApprovalQueue` 单槽 + `isBusy` 门禁 | 每会话独立的运行后继队列（由 `runGate` 驱动） |
| `ChatSessionStore.createNewSession` 里的 `'normal'` 硬编码 | 新建即入队尾；模式由队首派生 |
| `setExecutionMode` 自由切换 | 用户“降回 plan / 交棒”走 `queueService.releaseToPlan()`；不允许把非队首设为 normal |

保留不动（不复制、只在接线处调用）：`edits/`（DraftEdit→ChangeSet→SafeFileEditor）、`runs/`（DraftRun、permit、executor、隔离）、`sessions/` 的 shard 与原子写、`agent/` 的投影与协议、`accounts/`、`context/`、`skills/`。

## 4. 关键流程

### 4.1 新建会话

```text
newSession
  → ensure current session persisted
  → queueService.create(workspaceKey)
      ├─ queue = enqueueNewSession(queue, newId)   // 追加队尾
      └─ persist CAS
  → 该会话 effectiveMode = 'plan'（因为有队首）
  → 只读能力立即可用；写能力显示“排队中，第 N 位”
```

若项目此前没有会话且会话无内容，新建会话经过 `reconcile` 后成为唯一队首，即 normal。

### 4.2 plan 会话执行计划

```text
用户点击「执行计划」(planId)
  → planGate.verify(planId, contentHash, sessionId)
  → runGate.executePlan(sessionId)
      ├─ queueService.promote(sessionId)         // moveToFront + revision++
      ├─ lease.tryAcquire(sessionId)
      │    ├─ free              → granted（旧队首本就不持有租约，直接开始）
      │    ├─ held(自己)        → 复用现有租约
      │    └─ held(其他会话)    → **不抢占**：进入 waiting_for_handoff
      │                          · 通知持有者“队列已变化，请在结束当前边界后交棒”
      │                          · 持有者到达结束边界 → 显式 handoff → granted
      │                          · 持有者无进展 / 用户选择“取消对方任务” → 取消后再 handoff
      │                          · 等待期间行者的写工具从集合中剔除，只读运行不受影响
      ├─ effectiveMode(sessionId) === 'normal'
      └─ 原队首 effectiveMode 回到 'plan'，其 planWorkflow 状态保持，可稍后再次执行
  → planGate 追加执行续跑提示词并启动该会话运行
```

**关键差异（D1）**：被顶下去的会话若正持有租约并运行，**不会**被立即打断；它继续完成当前任务段，只在到达结束边界时交棒。行动者因此可能等待较久，这是“防写冲突优先”的自觉取舍。UI 必须同时显示两件事：行动者在等待谁、持有者预计在什么边界结束（见 5.4）。

### 4.3 并行执行

- 任意会话（含多个 plan 会话）可同时 `submit`：`sessionRuntimeRegistry.tryStart` 按会话互斥、跨会话放行。
- 每次模型会话也都走同一套 `agent/` 投影与工具链，因此前缀缓存、evidence、子代理隔离规则不变。
- 正常跑写流程的只有租约持有者；其余会话的运行如果是“提交后才发现不能写”，`runGate` 在**请求投影前**就把写工具从集合中剔除，并在提示里说明当前是排队只读，避免模型反复尝试被拒。

### 4.4 用户调整顺序

```text
拖动/上移/下移/置顶（Webview 传 revision + sessionId + targetIndex）
  → queueService.move(workspaceKey, revision, sessionId, targetIndex)
      ├─ CAS 失败 → 返回 queue_conflict，Webview 刷新队列后提示重试
      ├─ 若移动导致队首变化：
      │    ├─ 新队首进入 waiting_for_handoff（4.2 的显式交棒流程，不抢占）
      │    └─ 旧队首仍保持 normal 直到实际交棒；交棒后降级为 plan
      └─ 持久化 + 投影 + 通知所有打开的 Webview
```

调整顺序本身**不强制转移**写权限：把某会话置顶只是让它成为下一个交棒候选。真正转移发生在旧持有者到达结束边界交棒，或用户显式执行“立即交棒/取消对方任务”。这样即使误拖动顺序，也不会打断正在进行的写任务。UI 在队首变化时显示“下一个写权限：B（等待 A 交棒）”，并在等待过久时提供显式“取消 A 并交棒”动作。

### 4.5 会话删除 / 归档 / 工作区切换

- 删除会话：出队 → 若删的是租约持有者，租约释放并交给新队首 → 持久化。
- 工作区切换：每个 workspaceKey 独立队列与租约，互不影响。
- 重启恢复：`queueStore` 读取队列并与磁盘会话 `reconcile`；运行期租约**不恢复**（与“重载不得执行已恢复草案”的既有安全取向一致），重启后租约空闲，首个发起写的会话按队列顺序获得。

### 4.6 显式交棒（D1）

**结束边界**（只有到达以下之处才允许交棒）：

| 边界 | 说明 |
| --- | --- |
| 一次工具调用结束 | 该工具已写 evidence 并返回；下一个工具尚未开始 |
| 一次 Apply 事务结束 | preflight→journal→原子替换→read-back 全部完成 |
| 一次 DraftRun 到达终态 | 已完成/失败/取消/未知已定级 |
| 模型轮结束 | 助手消息已落盘，等待下一轮 |
| 任务段结束 | 用户任务自然完成或显式停止 |

**租约状态机（显式交棒版）**

```text
free ──tryAcquire──> held(owner)
held ──queueChangedAndOwnerBehind──> held(owner, handoffRequested)
held(owner, handoffRequested) ──owner reaches boundary──> handingOff ──> held(newOwner)
held(owner, handoffRequested) ──user cancels owner task──> cancelling ──> handingOff ──> held(newOwner)
held(owner) ──owner finishes/Stops/errors──> releasing ──> free
held(owner) ──heartbeat timeout──> recovering ──> free（审计）
```

- `handoffRequested` 只是**请求**，不改变持有者；持有者在边界处主动调用 `lease.handoff(boundaryEpoch)` 才真正转移。
- `tryAcquire` 遇到 `held(其他)` 时返回 `{ state: 'waiting_for_handoff', waitingFor, position }`，调用方进入等待视图，不排队抢锁、不重试轰炸。
- 等待期间行动者仍可提交只读运行（plan 能力），写能力保持禁用。
- 交棒完成后被降级会话 `effectiveMode` 回到 `plan`，其 `planWorkflow` 与消息历史保持。

### 4.7 审批移除后的安全边界（D2）

**删除（产品流程）**：`approvalMode.ts`（ask/delegate 与 `DelegatedApprovalQueue`）、`approvalPolicy.ts`、`approvalReviewer.ts`、`manualApproval.ts`、`approvalReviewStore.ts`、`approvalCircuitBreaker.ts`、`approvalProcessing.ts`、`approvalReviewSurface.ts`、`oneShotTextRequest.ts`；以及 `ChatSession.approvalMode/pendingApproval/approvalProcessing` 等字段、`webviewMessages` 的审批消息、Webview 审批卡片与“审批模式/审批模型”菜单。

**保留并迁移（安全边界，不是审批）**：`approvals/authorization/` 下的 `protectedTargets`（受保护路径）、`pathScope`（外部精确范围）、`editTargets`（脏编辑器/目标检查）、`projectLaunchIdentity` + `packageLaunch`（实际启动身份）、`commandSemantics` + `commandScope` + `commandEffects`（命令语义与范围）、`executionBoundary`（Git 参数与执行边界）、`localGitScope`/`gitRemoteScope`。这些目前被 `edits/`、`runs/`、`agent/tools/` 广泛引用（见下表），删除会让 SafeFileEditor 与 DraftRun 失去路径和权限校验。

**迁移动作**：把上述模块移出 `approvals/` 语义目录，例如迁到 `src/security/`（或留在原处但重命名目录），并去掉其中残留的 `ApprovalMode` 分支；`approvals/` 目录本身删除。

**必须新增的补偿控制**（因为移除了审批这个“人类确认”层）：

1. **租约即闸门**：Apply/删除/移动/验证/DraftRun 在正式执行前除现有路径校验外，必须校验 `lease.holder === sessionId && effectiveMode === 'normal'`。这是工具路由层的强制检查，不依赖 UI。
2. **危险操作仍需用户确认**：现有 `ToolAuthorizationService` 的高/中风险确认（`confirmHighRiskTool`、`showInformationMessage` modal）属于“执行确认”，与审批模式无关，**保留**；它现在是唯一的用户确认点。
3. **受保护路径不可被租约豁免**：持有租约不等于有权写任意路径，`protectedTargets` 仍然生效。

**依赖安全边界但不能删除的文件**（删除审批流程时必须逐个改 import，否则编译失败）：

| 消费者 | 实际需要的模块 |
| --- | --- |
| `edits/changeSetStore.ts`、`edits/safeFileEditor.ts` | `protectedTargets`、`pathScope`、`editTargets`、`projectLaunchIdentity` |
| `runs/draftRun{Store,Proposal,Executor,Dependencies,BatchCoordinator,Authorization}.ts` | `commandSemantics`、`commandScope`、`commandEffects`、`executionBoundary` |
| `runs/gitRelease*.ts`、`localGitCommit.ts`、`gitTaskIntent.ts` | `commandSemantics`、`localGitScope`、`gitRemoteScope`、`pathScope` |
| `agent/tools/{gitTools,workspaceTools,validationTools,validationSnapshot}.ts` | `pathScope`、`protectedTargets`、`commandScope`、`packageLaunch`、`projectLaunchIdentity` |
| `approvals/approvalReviewHash.ts` 的 hash 工具 | 被 `agent/runner.ts`、`runs/*` 引用；先抽出纯 hash 函数再删除其余部分 |

### 4.8 普通提交的执行语义（D3：选项 A + 同回合递进修正）

**规则**：任何会话的 `submit` 都先进入**只读 plan 态**。差别只在“是否需要把计划呈现给用户确认”：

| 情况 | 行为 |
| --- | --- |
| 会话不是队首（无写权限） | 提交后只读运行；模型生成计划/分析；写工具不在工具集合中；UI 显示“排队中，第 N 位；获得写权限后可执行” |
| 会话是队首且已持有租约 | 提交后进入**同回合递进**：先只读规划，规划产出后**不弹出计划确认卡**，直接在同一回合申请写权限并继续执行 |
| 会话是队首但尚未持有租约（上一个持有者刚结束） | 提交时立即 `lease.tryAcquire`；成功则走上一行；失败（极短窗口）则等同“等待交棒” |
| plan 会话显式「执行计划」 | 走 4.2：先 `queueService.promote` + 交棒，再 normal + 执行 |

**为什么要有同回合递进修正**：否则“改一个错别字”会退化成“先看计划、点确认、再执行”的三段式，普通提交失去存在意义。修正后：

- **不变的部分**：写权限仍然是显式取得的（`tryAcquire` 成功），工具集合仍然从只读切换到可写，切换仍然发生在**一个回合边界**，不引入“回合中途突然获得写权限”的新语义。
- **改变的部分**：队首会话**不需要人工点一次“执行计划”**，因为它在提交的那一刻就已经是队列第一个；计划确认卡只对“需要被提升”的会话有意义。

**与 R2 的一致性检查**：同回合递进不产生第二个 normal。队首会话在 `tryAcquire` 成功前仍是 plan；成功后它已经是队首，旧的 normal 已按 D1 交棒或本就空闲。因此任何时刻仍至多一个会话 `effectiveMode === 'normal'`。

**风险与对应措施**：

1. **模型可能借此跳过计划**：同回合递进允许模型不输出完整计划就直接写。对策：`planGate` 要求进入可写阶段前必须已产出结构化 `PlanDraft`（哪怕很简短），并在 `runGate` 校验；没有计划产物则拒绝进入可写阶段。
2. **队首会话长期霸占写权限**：这不是缺陷，而是 D1（显式交棒）的直接后果；用户可通过调整顺序改变下一个交棒候选，或在队列视图里显式“交棒给下一项”。
3. **用户看不出“为什么没弹确认”**：UI 需明确标注“你是队首，已直接执行”，避免用户以为要求被忽略。

## 5. 并发与一致性设计

### 5.1 单进程内的互斥

- 队列所有变更经由 `queueService` 一个串行入口（内部 Promise 链或现有存储协调器），避免 Webview、标题刷新、清理任务同时改队列。
- 每会话运行上下文独立，唯一共享的是租约与队列；二者都在 `queueService` 内串行化。

### 5.2 多窗口 / 多进程

现状已支持“并发的多个窗口写入互不影响”（按 shard 隔离 + 跨进程锁）。队列是项目级单文件，必须显式处理多窗口：

- 读改写使用 `revision` CAS；冲突时重新读取→重放意图→有限重试→失败则提示用户。
- 写文件用现有原子写 + 存储协调器锁，避免半写。
- 多窗口同时打开同一项目时，租约仍是单进程事实；跨窗口用 `leaseHolderSessionId` + 心跳判定，陈旧心跳可被回收（记录审计事件）。

### 5.3 让出点（为什么不会有两个写者）

写操作在开始前除校验租约，还捕获 `lease.epoch`：

- 工具执行/Apply/DraftRun 开始时若 `epoch` 已过期，直接拒绝。
- 结束时核对 `epoch`，不匹配视为“已让出”，其结果仍按现有 evidence/journal 规则落盘审计，但**不再发起新的副作用**。

因此显式交棒（D1）天然满足“不会打断一个已开始的原子写事务”：交棒只发生在结束边界。若用户必须中途停止持有者，只能走现有取消路径（其语义是“未知副作用不重试”），不引入新语义。

### 5.4 失败与降级

| 场景 | 行为 |
| --- | --- |
| 队列文件损坏 | 从会话集合重建，保留可见诊断；用户自定义顺序丢失需在 UI 明确告知 |
| revision 冲突 | 重试 + 用户可见提示；不静默覆盖 |
| 行动者长时间等待交棒 | 不自动抢占、不自动杀任务；UI 持续显示等待对象与已等待时长，并提供显式“取消对方任务并交棒”动作 |
| 持有者崩溃/失联 | 心跳超时后租约回收并交给队首；这是唯一的非显式交棒路径，必须留审计 |
| 会话在队列中但已删除 | `reconcile` 剔除 |

## 6. 持久化与数据模型

```text
chat-sessions/v2/
  manifest.json                          （不变）
  workspaces/<hash>/index.json           （不变；去掉 activeSessionId 的“模式”含义）
  workspaces/<hash>/queue.json           （新增：ProjectSessionQueue）
  <sessionId>/manifest... + objects      （不变）
```

`queue.json` 示例：

```json
{
  "version": 1,
  "workspaceKey": "file:///d/project",
  "revision": 7,
  "entries": [
    { "sessionId": "s-3", "serial": 3, "createdAt": "2026-11-13T08:00:00.000Z", "userOrdered": true },
    { "sessionId": "s-1", "serial": 1, "createdAt": "2026-11-13T07:00:00.000Z" },
    { "sessionId": "s-2", "serial": 2, "createdAt": "2026-11-13T07:30:00.000Z" }
  ],
  "leaseHolderSessionId": "s-3",
  "updatedAt": "2026-11-13T09:00:00.000Z"
}
```

- 会话 shard 保持现格式；不新增跨 shard 引用。
- 首次启动若无 `queue.json`：按现有索引的 `createdAt` 生成 `serial`，`userOrdered` 全部为空，`revision: 1`；这是一次纯派生重建，不做旧版本兼容导入（符合“只支持当前格式、不迁移旧数据”的基线取向）。
- 若迁移期需要把历史 `executionMode = 'normal'` 会话保留为队首：取最近有用户消息且为 normal 的会话放到队首（仅一次性、可配置），其余全部 plan。

## 7. 与现有不变式的兼容

实施时必须逐条核对以下既有约定，确保重构不破坏：

1. **前缀缓存**：队列与租约不进入 system/context 字节；plan 只读集合按会话冻结（与工具集合冻结规则一致），不得在轮间变动工具 schema。
2. **请求投影单一权威**：`buildProviderRequestProjection()` 仍是唯一入口；`planGate` 只决定“工具集合”，不另建 messages/tools。
3. **副作用链不变**：DraftEdit→ChangeSet→SafeFileEditor；DraftRun 一次性 permit；`shell:false`；未知副作用不重试。
4. **审批语义（D2：彻底移除）**：`ask`/`delegate` 两种审批模式连同 reviewer、人工批准、审批批次、审批审计一并删除。因此**必须保留并提升** `approvals/authorization/` 中与审批决策无关的安全边界：受保护路径、外部精确范围、启动身份、命令语义、Git 范围。这些不是“审批”，删掉会让 SafeFileEditor/DraftRun 失去路径与权限校验。原“审批后续跑”的需求由**租约 + 显式交棒**承接：写权限只授予租约持有者。
5. **交互所有权**：owner 必须带会话身份，且“首次 await 前取得”；`canSubmit`/`canNavigate` 改为按会话派生。特别地：**运行中允许导航到其他会话**（这是需求“同时开多个会话”的最低要求），但同一会话的运行不被导航打断。
6. **证据与恢复**：`runCheckpoint`/epoch 语义不动；会话级运行上下文的恢复仍走 checkpoint。
7. **存储基线**：仍然只支持当前格式；`queue.json` 是新增当前格式文件，必须有校验、原子写与损坏恢复路径。

## 8. 迁移路径（分阶段、可回退）

写成阶段顺序而非一次切换，每一步都可独立验证并回退：

| 阶段 | 内容 | 验证 | 风险 |
| --- | --- | --- | --- |
| P0 | 只新增 `src/sessions/queue/` 纯逻辑（types/projectQueue/modeGate/writeLease/queueStore/queueView），**不接线** | 新增单测 `test/sessionQueue.test.ts`、`test/sessionQueueStore.test.ts`、`test/writeLease.test.ts` | 零 |
| P1 | 接 `queueStore` 到存储与 `ChatSessionStore` 生命周期（创建/删除/加载），读写顺序；会话视图展示位置与派生模式（只读展示） | `chatSessionStore`、`storageBaseline`、新建 `sessionQueueStorage.test.ts` | 低；仅展示 |
| P2 | 把 `executionMode` 从“可写字段”改为“派生 + 迁移镜像”；`setExecutionMode` 改为 `queueService` 调用 | `executionMode.test.ts` 改写为队列语义；`sessionNavigation` 中模式相关用例 | 中；需同时改 Webview 能力投影 |
| P3 | 引入 `sessionRuntime`/`sessionRuntimeRegistry`，把 Provider 的 `isBusy`、abort、usage、draftRun 句柄下沉到会话级；交互 owner 每会话化 | `sessionNavigation`、`interactionState`、`longTaskPerformance`、`startupPerformance` | 高；这是最关键一步，需单列 PR |
| P4 | `runGate` 接管 `submit`/`executePlan`/`continue`，**`submit` 一律先进只读 plan 态（D3）**；`planGate` 接管 plan 工具集合、结构化计划与“可写阶段前必须有 PlanDraft”的校验；删除 `agent/executionMode.ts` 的提示词式拦截 | `executionMode`、`taskPlan`、`longRunningAgent`、`p1ProtocolDelivery`、`toolResultBudget` | 高；工具集合变化会影响缓存字节，需 `cacheByteStability`/`protocolCache` 对照 |
| P5 | Webview：会话列表显示队列位置/模式徽标/拖拽排序/“执行计划”按钮；“写权限转移”确认 | `inputComposition`、`sessionNavigation`、新增 `sessionQueueWebview.test.ts` | 中 |
| P6 | **删除审批流程**（D2）：移除 ask/delegate、reviewer、人工批准、审批批次与审计、Webview 审批 UI 与消息；把 `authorization/` 安全边界迁出 `approvals/`；同时删除 `DelegatedApprovalQueue` 单槽、全局 `isBusy` 门禁、`setExecutionMode` 直写 | 全量 `bun run test`、`package:market`；编译期 import 完整性是最强的第一道验证 | 高；触及 `edits/`、`runs/`、`agent/tools/` 的安全校验引用 |

每个阶段结束都必须通过：`bun run compile`、`bun run lint`、`bun run build:test && bun run test`。涉及工具集合与投影的阶段（P4）额外跑 `cacheByteStability` 与三协议 payload 对照，证明没有意外改变 system/tool 字节。

## 9. 验收清单（行为契约）

必须新增或改造以下行为测试，全部以行为而非实现为准：

1. 新建第二个会话即 plan；第一个会话保持 normal。
2. 删除队首会话后，下一项自动 normal；被删会话的租约被释放。
3. 移动非队首到队首后：新队首 normal、旧队首 plan；revision 递增。
4. plan 会话无法产生任何文件副作用（写工具不在工具集合内；强行调用返回明确拒绝）。
5. 「执行计划」使会话 normal 并移到队首，原 normal 会话回到 plan 且保留自己的 planWorkflow。
6. 两个会话同时提交：都能拿到模型响应（并行），但只有 normal 会话能 Apply/执行命令。
7. 抢占时租约持有者正在写：写入完成前不掉租约；完成后新持有者获得；不出现两个持有者同时通过 `canWrite`。
8. 让出点在工具/Apply 事务中途不被打破；epoch 过期后不再发起新副作用。
9. 并发窗口调整顺序：CAS 冲突可被检出并对用户可见，不静默覆盖用户顺序。
10. `queue.json` 损坏：重建后项目可继续使用，UI 明确提示顺序丢失。
11. 重启后租约是空的；已有队列顺序与派生模式从磁盘正确恢复；不会自动执行任何恢复的草案。
12. 运行中导航到其他会话：导航成功，且原会话运行不被打断、结果仍回写原会话。
13. 配额/预算：每会话的 token/费用预算互不串用（现有 `userTaskBudgets` 语义保持）。
14. **D3**：队首会话普通提交在同一回合内完成“规划→取写权限→写入”，不出现计划确认卡，且切换发生在回合边界。
15. **D3**：非队首会话普通提交后不能写入；UI 显示排队位置，且其只读运行不受影响。
16. **D3**：没有 `PlanDraft` 的回合不得进入可写阶段（防止借同回合递进跳过计划）。

## 10. 待确认的开放问题

实施前需要用户拍板，否则容易返工：

**已解决（原开放问题）**

| 原问题 | 决策 |
| --- | --- |
| 抢占还是显式交棒 | **显式交棒**（D1）。不抢占；行动者等待持有者到达结束边界交棒，或由用户显式“取消对方任务”。 |
| 审批模式的去留 | **彻底移除**（D2）。ask/delegate、reviewer、人工批准、审批批次与审计全部删除；保留 authorization 安全边界。 |
| “执行”的语义边界 | **选项 A**（D3）。普通提交也先进 plan 排队；队首会话可跳过计划确认，走同回合递进（见 4.8）。 |
| 空会话是否占队列位置 | **不占**（D4）。空会话不进入队列、不占队首、不写入历史；空会话全局唯一，不能重复创建（见 §13）。 |

**仍需你确认**
1. **被降级会话正在进行的工作**（D1 下已部分回答）：持有者到达结束边界即交棒，还是允许它跑完整个原任务再交棒？
2. **无内容会话**：新建但还没发消息的空会话是否占队列位置（会占住队首进而占住 normal）？
3. **favorite/收藏**是否影响队列顺序，还是仅影响展示分组？
4. **多根工作区**：队列按 workspace key（多根一个 key），还是按单个文件夹？需与 `getCurrentWorkspaceSessionScope()` 的真实 key 语义对齐。
5. **跨窗口**：同一项目在两个 VS Code 窗口打开时，是否要求队列实时同步（广播），还是只做 CAS？显式交棒在多窗口下如何呈现？

## 11. 结论

- 需求本质是把“会话模式”从会话自身字段提升为**项目级有序队列 + 写租约**，并把宿主的单会话运行态下沉为**每会话运行上下文**。
- 与旧代码的关系：**新增** `src/sessions/queue/` 作为唯一权威；**废弃**旧的 `executionMode` 直写、提示词式 plan 拦截、全局 `isBusy` 与单槽审批队列；`edits/`、`runs/`、`sessions/` 存储、`agent/` 协议按原样被调用。
- 建议先完成 P0/P1（纯逻辑 + 持久化），再以 P3（运行态下沉）作为独立高风险里程碑，最后 P4/P5 收敛用户可见行为。
- 两项决策已固定：**显式交棒**（不抢占，写权限只在结束边界转移）与**彻底移除审批**（但保留 `authorization/` 安全边界，并把租约提升为工具路由层的强制闸门）。审批移除后，“危险操作的用户确认”只剩 `ToolAuthorizationService` 的高/中风险 modal，这是必须显式保留的补偿控制。
- 三项决策已固定：**显式交棒**（D1，写权限只在结束边界转移）、**彻底移除审批**（D2，但保留 `authorization/` 安全边界并把租约提升为工具路由层的强制闸门）、**普通提交也先进 plan 排队**（D3，队首会话走同回合递进，避免把改错别字变成三段式）。
- 本文未实施任何代码；`src/` 目前没有任何改动。

## 12. 实施进度

### P0 已完成

新增目录 `src/sessions/queue/`，全部不依赖 `vscode` 的纯逻辑与一个存储适配器：

| 文件 | 职责 |
| --- | --- |
| `types.ts` | `QueueEntry` / `ProjectSessionQueue` / `SessionExecutionMode` |
| `projectQueue.ts` | 不可变队列操作：入队、移动、置顶、删除、`effectiveMode`、`reconcile` |
| `modeGate.ts` | 写权限唯一判定 `checkWritePermission`；四类写能力统一受控 |
| `writeLease.ts` | 显式交棒状态机（free/held/handoff_requested）、`epoch` 防迟到操作、`reclaim` 审计回收 |
| `queueStore.ts` | 当前格式严格校验、`revision` CAS、损坏重建、`saveQueueWithRebase` |
| `queueView.ts` | Webview 只读投影（位置/模式/移动可用性） |

新增测试 48 项，全部通过：`sessionQueue`(17)、`sessionQueueModeGate`(7)、`sessionQueueStore`(7)、`sessionQueueService`(6)、`writeLease`(11)。

### P1 已完成

- `GlobalSessionStorage.getProjectQueueUri()`：队列落在 `chat-sessions/v2/workspaces/<hash>/queue.json`。
- `ProjectQueueService`：每 workspace 串行化的唯一读写入口；`ensureLoaded` 幂等、`enqueue`/`remove`/`mutate`/`sync` 全部走 CAS。
- `ChatSessionStore`：新增可选 `projectQueue` 依赖，接入 `load()`（对齐）、`createNewSession()`（入队尾）、`deleteSessions()`（出队）；新增 `getProjectQueue`、`getDerivedExecutionMode`、`getProjectQueueView`、`moveSessionInQueue`、`promoteSessionInQueue`。
- `extension.ts`：激活时构造并注入 `ProjectQueueService`。
- `KeepseekChatViewProvider`：状态投影新增只读 `projectQueue` 字段。

P1 有意**不改变**运行时权威：`ChatSession.executionMode` 仍是运行行为的依据，队列派生模式只用于展示。这保证 P1 不改变任何现有行为（见下方验证）。

### 验证结果

| 检查 | 结果 |
| --- | --- |
| `tsc -p tsconfig.json` | 通过 |
| `tsc -p tsconfig.test.json` | 通过 |
| `eslint src/` | 通过 |
| 新增 48 项测试 | 通过 |
| 全量测试 | **444 通过 / 17 失败；与 HEAD 基线逐项相同，零回归**（2026-11-13 复跑：当面重建 HEAD 基线，通过 444=444、失败 17=17，清单逐项一致） |

环境说明：本机为 Windows + UNC 网络工作区。该环境下存在两类**与本次改动无关的既存问题**，已用基线对照证实：

1. 17 项测试失败源于宿主 Git 配置（`diff.astextplain.textconv`）与 UNC 路径下的 `Uri.joinPath` 拼接缺陷；用 HEAD 版本跑同一套件得到**完全相同的 17 项**。
2. `draftRunStore.test` 之后套件不再自然退出（遗留句柄）。用两个**从未被本次改动触及**的原有测试文件（`draftRunStore` → `draftRunBatch`）可复现同样现象。因此全量套件需设超时或忽略退出码读取统计。

### 未完成（P2–P6）

### P2 已完成

`executionMode` 的权威从「会话字段」迁移到「项目队列」。

| 改动 | 位置 | 语义 |
| --- | --- | --- |
| `executionMode` getter | `chatSessionStore.ts` | 优先用队列派生模式；队列未加载时回落到存储字段（兼容） |
| `resolveExecutionMode()` | `chatSessionStore.ts` | 单一的「队列优先、字段兜底」解析点 |
| `setExecutionMode()` | `chatSessionStore.ts` | 改为**操作队列**：请求 normal = 提升到队首；请求 plan = 移到队尾 |
| `demoteSessionInQueue()` | `chatSessionStore.ts` | 让出写位置的实现（移到队尾） |
| 模式派生镜像 | `ensureActiveSession()` | 每次取活动会话时把派生模式写回字段，保证 Runner 与 Webview 读到的字段不落后于队列 |
| 模式切换消息 | `KeepseekChatViewProvider.ts` | 改走 `sessionStore.setExecutionMode()`，不再直接写字段 |
| 「执行计划」 | `KeepseekChatViewProvider.ts` | `start_execution` 时 `promoteSessionInQueue()`，会话因此获得 normal |

**为什么需要镜像**：`ChatSession.executionMode` 字段仍被 Runner（`request.executionMode`）和 Webview 状态投影直接读取。只改 getter 会造成「getter 说 plan、字段说 normal」的分裂——这一点在实施中确实复现过（`selectSession` 返回的会话字段仍是旧值），因此必须在 `ensureActiveSession()` 统一镜像。

**契约变更**：原测试 `execution mode defaults to normal and is restored independently for each session` 验证的是「每个会话各自持有 normal」，与新的单 normal 不变式直接冲突，已重写为 `the project queue decides normal/plan instead of a per-session flag`（创建顺序决定队首、提升/让出、跨重启保持）。

**新增测试**：`test/sessionQueueAuthority.test.ts` 8 项，覆盖「只有队首是 normal」「提升使原队首变 plan」「任意提升序列后恒有一个 normal」「非队首即使持有租约也不能写」等。


## 13. 空会话规则（D4）

用户确认的三条规则：**空会话不占用队列位置；空会话是特殊存在，不能重复创建；空会话不能放入历史会话**。

### 现状与本轮改动

| 规则 | 原实现 | 本轮处理 |
| --- | --- | --- |
| 空会话不入历史 | 已满足：`persist()` 只序列化 `messages.length > 0` 的会话；`getSessionSummaries()` 同样过滤 | 保持不变，并新增测试钉住 |
| 空会话不能重复创建 | 已满足：`createNewSession()` 在 `!hasUserMessages` 时直接复用当前活动会话 | 保持不变，并新增测试钉住 |
| 空会话不占队列位置 | **原先不满足**：`createNewSession()` 无条件把新会话入队，`queueSeeds()` 也把空会话计入 | **已修复**（见下） |

### 修复点

1. `queueSeeds()` 只把 `messages.length > 0` 的会话作为队列种子。空会话因此既不会入队，也不会在 `reconcile` 中被补进队列。
2. `createNewSession()` 不再入队。空会话是一个临时 composer，拿到首条用户消息后由 `persist()` 触发的队列同步入队（追加到队尾，因此派生 `plan`，不会抢占队首）。
3. `persist()` 结束后调用 `syncProjectQueue()`，让队列与「有内容的会话集合」保持一致；同步失败不影响会话保存（队列保持建议性）。

### 由此得到的性质

- 项目里只有空会话时，队列为空、没有队首，因此没有任何会话是 `normal`。
- 空会话收到首条用户消息后才会入队，且落在队尾，不会打断当前 normal 会话。
- 判空以 `messages.length` 为准（与既有 `hasUserMessages` 口径一致），不看标题或其他元数据。

### 验证

新增 `test/sessionQueueBlank.test.ts` 共 6 项，覆盖：空会话不占位、空会话不能抢队首、空会话获得首条消息后入队尾、会话重新变空后出队、全空项目无队首、空会话不进入队列视图。全部通过。

## 14. P3 路线 B：运行中可导航（2026-11-14）

### 为什么先做 B 而不是完整 P3

完整 P3 需要把约 290 处全局运行状态引用（`interactions` 102、`isBusy` 56、`activeDraftRunId` 41、`isStartingRun` 39、`currentRunAbortController` 29 等）下沉到每会话，并重写导航/交互状态机。用户当前的实际阻塞是「命令执行中新会话按钮点不了」，因此先交付可验证的最小闭环。

### 改动

| 改动 | 位置 | 作用 |
| --- | --- | --- |
| `canNavigate` 派生 | `interactionState.ts` | 主运行不再阻断导航；`backgroundRunning`、`actionRunning`、进行中的导航仍阻断 |
| 导航与任务双槽位 | `interactionState.ts` | `InteractionCoordinator` 增加 `navigation` 槽位，任务 owner 存活时仍可发起导航；`owns`/`update`/`finish`/`snapshot`/`whenSettled` 统一经 `owned()` 解析两个槽位 |
| 导航门禁放宽 | `KeepseekChatViewProvider.ts` | `createNewSessionForNavigation` 与 `selectSession` 去掉 `isBusy` / `isStartingRun`，保留背景任务、上下文刷新、变更动作屏障 |
| 结果写入固定 | `KeepseekChatViewProvider.ts` | `sendPromptImpl` 的 user/assistant 消息写入从 `this.messages`（活动会话）改为 `activeSession.messages`（准入时捕获的会话） |
| 中止回滚固定 | `KeepseekChatViewProvider.ts` | 无输出中止时删除占位消息改用 `failedSession.messages`，避免误删当前活动会话的消息 |

### 不变式

- 运行结果只写入准入时捕获的会话，切换会话不会让结果串到别处。
- 导航不会取消正在运行的会话，也不会释放其 owner。
- 导航进行中不能再发起另一个导航（保留原有串行语义）。
- 背景任务、上下文刷新、进行中的变更动作仍是硬屏障。

### 契约变更

- `sessionNavigation`：`session navigation retains the main-run busy guard` 重写为 `a running task does not block opening or switching sessions`，验证运行中切换会话成功。
- `interactionState`：`run.canNavigate` 与 `context.canNavigate` 由 `false` 改为 `true`；导航进行中仍为 `false`（新增该断言的说明）。

### 验证

| 检查 | 结果 |
| --- | --- |
| `tsc` ×2、`eslint src/` | 通过 |
| 协调器行为直测 | 任务 owner 存活时可发起导航；两者 owner 独立；结束导航后任务 owner 仍存活；`canNavigate` 主运行放行、背景任务阻断 |
| 与 HEAD 基线逐文件对照 | `interactionState` 12 通过，无新增回归；`sessionNavigation` 差异仅为上述契约重写 |

**环境限制**：本机 UNC 工作区下 `sessionNavigation` 整文件 44 项失败（与基线一致，基线同为 44），因此该文件的断言无法在此环境可靠执行；核心逻辑改用独立脚本直测验证。

### 未做（完整 P3）

多会话同时提交仍受全局单运行限制（`isBusy`、`currentRunAbortController`、`activeDraftRunId` 等），因此**尚未实现真正的并行执行**。

### 补充修复：运行状态按会话隔离（2026-11-14）

**现象**：新建会话后，新会话没有消息也没有输入，但状态栏仍显示另一个任务的推理过程。

**根因**：运行态（`agentActivity`、`isBusy`、`liveUsage`）仍是 Provider 上的全局单例，且被无条件推送给当前查看的会话。导航放开后，新会话就「继承了」旧任务的运行投影。

**修复**：

| 改动 | 位置 | 作用 |
| --- | --- | --- |
| 记录运行所属会话 | `KeepseekChatViewProvider.ts` | 两处 `isBusy = true` 前写入 `runningSessionId`，三处 `isBusy = false` 后清除 |
| `runBelongsToViewed()` | `KeepseekChatViewProvider.ts` | 判断在飞的运行是否属于当前查看的会话 |
| 交互投影 | `interactionSnapshot()` | `mainRunning` 改为按所属会话判定，新会话保持 `idle` 且可输入 |
| 状态投影 | `postStateNow()` 等 | `isBusy` 与 `agentActivity` 仅在所属会话显示，其余会话显示空闲 |

**验证**：会话 A 运行中、切到会话 B 时，B 得到 `phase=idle, canSubmit=true, canCancel=false`；A 仍为 `running`。compile/lint/build 通过；`startupPerformance` 与 HEAD 基线同为 11 通过 / 8 失败（既存环境问题）。

**仍然存在的限制**：`agentActivity`、`isBusy` 等物理上仍是全局单例，只是**投影**按会话隔离。因此同一时刻仍只能有一个任务真正运行；新会话可以输入并提交，但提交后仍需等待当前任务结束。真正的并行执行属于完整 P3。


## 15. P3 完整实施：并行执行（2026-11-14）

### 目标

在 P3-B（运行中可导航 + 状态隔离）基础上，让**多个会话的模型请求真正同时运行**。

### 核心改动

| 改动 | 位置 | 作用 |
| --- | --- | --- |
| `SessionRunRegistry` | `src/provider/sessionRunRegistry.ts`（新增） | 按会话登记运行；同会话不可重复，跨会话可并行；`tryStart`/`release` 带 token 防迟到释放 |
| `sessionRuns` 注册表 | `KeepseekChatViewProvider.ts` | Provider 持有并查询运行归属 |
| `isBusy` 改为按会话 | `KeepseekChatViewProvider.ts` | 访问器：先查注册表（真实运行），再回退显式 override/字段；跨会话不再互相阻塞 |
| 准入判定 | `sendPromptImpl` | `isBusyFor(admissionSessionId)`：仅拒绝**同一会话**的重复运行 |
| 运行登记/释放 | 两处启动、三处结束 | 显式按会话 `tryStart` / `forceRelease`，不再依赖“当前查看会话” |
| abort 控制器按会话 | `runAbortControllers` Map + `abortControllerFor`/`setAbortController` | 并行会话各自持有控制器；`currentRunAbortController` 保留为普通字段供投影与测试注入 |
| 命令运行归属 | `activeDraftRunSessionId` | 记录执行命令的会话；门禁改为 `activeDraftRunSessionId === admissionSessionId` |
| `runBelongsToViewed` | `KeepseekChatViewProvider.ts` | 改为查注册表，支持多会话同时运行 |

### 不变式

- 同一会话同一时刻只有一个运行；不同会话可同时运行。
- 运行结果只写入准入时捕获的会话（P3-B 已确立）。
- 取消只作用于目标会话的控制器，不波及并行会话。
- 写权限仍由项目队列与写租约决定，与“能否并行跑”正交：并行的是模型与只读工作，写仍按队列排队。

### 实施中纠正的两个设计错误

1. **`isBusy` 改成纯访问器破坏了可注入性**：`Object.assign` 无法覆盖访问器属性，导致 Host 测试桩的 `isBusy: false` 静默失效，进而让计划决策等路径提前返回。改为「注册表优先 + override/字段兜底」。
2. **`currentRunAbortController` 同样改成访问器造成回归**：`startupPerformance` 的流式发布测试直接赋值该属性，被静默忽略。已恢复为普通字段，并用 `abortControllerFor`/`setAbortController` 承担按会话逻辑。

这两个问题的共同教训：**在 10k 行、满是 Host 测试桩的类上，把可注入字段改成访问器是高风险操作**。

### 验证

| 检查 | 结果 |
| --- | --- |
| `tsc` ×2、`eslint src/` | 通过 |
| 注册表行为直测 | A、B 可同时启动；A 重复启动被拒；释放互不影响 |
| `executionMode` | 9 通过 / 0 失败（与 HEAD 基线一致） |
| `interactionState` | 12 通过 / 0 失败 |
| `longRunningAgent` | 16 通过 / 0 失败 |
| `startupPerformance` | 11 通过 / 8 失败（与 HEAD 基线**逐项一致**，8 项为 UNC 环境既存问题） |
| `chatSessionStore` | 25 通过 / 2 失败（2 项为 UNC 环境既存问题） |
| 队列测试 | 30 通过 / 0 失败 |
| `sessionNavigation` | 44 项失败，与基线完全一致（该文件在本机 UNC 工作区整体无法运行） |

### 仍未实现（P4–P6）

plan 阶段工具白名单（P4）、Webview 队列排序交互（P5）、审批移除（P6）均未开始。
