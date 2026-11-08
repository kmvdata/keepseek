# KeepSeek 项目助手与并行任务

本页是项目任务、Router、执行拥有者和任务视图的实现入口。协议正文、字节兼容及副作用边界仍分别由 [缓存专题](cache_keepseek.md)、[API payload](keepseek-api-payload-reference.md)、[运行时](keepseek-agent-runtime-workflow.md)、[交互生命周期](keepseek-interaction-lifecycle.md) 和 [SUBAGENTS](../SUBAGENTS.md) 负责。侧栏实施基线为 `d5f941dfb941f58c14267fdb4a8663e826275e10`（0.5.3），2026-11-08，Asia/Shanghai；本轮验证及原生现场缺口见 [任务侧栏验收](keepseek-task-sidebar-verification.md)。

## 产品入口与身份

项目助手、新任务和任务详情共用现有侧边栏及输入组件。新任务直接创建 Worker；任务详情直接向该 Worker 投递；只有项目自由输入进入 Router。普通历史会话保留，通过“关联当前会话”显式增加任务卡关联，既有历史和请求前缀不因关联而重写。

| 身份 | 权威与用途 |
| --- | --- |
| `projectId` | 物理项目规范化身份；不等于 VS Code workspaceKey |
| `taskCardId` | 项目卡片、输入邮箱、依赖和结果事件的关联 |
| `sessionId` | Worker/Router 的完整会话与 Provider conversation |
| `rootTaskId` | 一轮真实用户任务的时间、费用、请求和委派预算 |
| `segmentId` | 一个根任务内的权威执行段；不是 trace runId |
| `generation` | 任务执行回调的代际隔离 |
| `viewGeneration` | 查看事务的代际隔离，不授予执行权限 |
| `epochIndex` | 受控上下文边界；不新建 root、不重置预算 |

新卡拥有新 session 和 root。已完成卡的新问题复用 session、创建新 root。运行中补充使用同 root、新 segment；停止后的“继续原任务”继承原 root 剩余预算。编辑重发继续使用明确历史截断及新 root 合同，并将依赖旧产物的卡标为待复核。

## 左侧任务窄栏与浮层

项目任务位于 Webview 内左侧固定窄栏。窄栏预留约 44px，默认收起；任务竖列独立滚动。打开约 288px 的浮层只覆盖聊天正文，标题栏、输入目标提示和 composer 保持原布局；剩余宽度不足时浮层收缩。开合不调整 transcript 尺寸、滚动锚点、输入高度或执行选择。完整对话、工具记录与审批继续在主区域。

| 原有能力 | 当前入口与行为 |
| --- | --- |
| 项目助手 / Router | 窄栏固定入口；只查看已有 Router 对话 |
| 新 Worker | 窄栏“+”；明确新任务输入，Router 分类请求为 0 |
| 最近 / 全部 / 归档 | 浮层范围与显示归档入口；全部范围不灌入收起窄栏 |
| 关联当前普通会话 | 浮层更多操作；不复制历史、不执行任务、不续期 |
| 停止 / 继续 | 选中任务操作；沿用原身份、权限和恢复检查 |
| 停止全部 | 浮层更多操作；与单任务停止区分 |
| 改动 / 验证 / 结果 / Run Details | 选中任务操作连接现有证据；完整内容留在主对话 |
| 归档 / 恢复 / 删除 | 选中任务操作；归档但仍活动的任务保持可发现、可停止 |
| 项目时间 / Router 用量 | 浮层汇总；项目经过时间、任务有效时间与逐币种费用分别显示 |
| 最新消息 | 主对话入口；只读取本地最新页 |
| 只读 owner 提示 | 主区域紧凑提示，浮层说明；查看可用，执行操作禁用 |
| 审批 / Apply / Discard | 原主任务对话；动作仍绑定原 task/session/root/segment/target/hash/runtime |
| 普通历史 / 标题编辑与刷新 / 设置 | 原标题栏与历史入口；侧栏查看不触发标题请求 |

圆环弧长固定表示“上下文占用（估算）”，来自 Worker 已有 `ContextUsageEstimate`，不是任务完成度。中间状态用颜色、图标和文字共同表达：queued/preparing/running/waiting/settling/stopping 为橙色，completed 为绿色，failed/cancelled/interrupted 为红色。等待原因静态显示；stopping 必须等待真实结算，不能提前显示已停止。completed 只表示宿主任务终态，不证明验证通过。

悬浮或键盘聚焦显示完整标题、首次时间及来源、状态与必要原因、上下文估算、有效时间和参考费用。tooltip 不读取全量会话、不启动模型，文本使用安全文本节点。任务行按 `taskCardId` 复用，指标更新修改既有文字和圆环，不重建所有行、当前焦点或 transcript。所有任务均可滚动到达。

### 时间来源、排序与最近范围

`createdAt/updatedAt` 保留旧语义。`firstSubmittedAt` 一旦确定即固定，`firstSubmittedAtSource` 解释来源：`user_input` 为可证实首条真实输入，`session_created` 为会话创建时间，`associated` 为加入列表时间，`task_created` 为旧普通卡的保守建卡回退。新普通卡与首条耐久输入同次提交首次时间。关联历史只有完整会话或能证明覆盖会话起点的权威数据才可采用最早 user 时间；中间/尾页不得充当原始首发。缺失旧字段确定性回退，不在查看、迁移或重启时用当前时间补值。

`lastActivityAt` 只记录真实任务输入耐久接收、明确继续/停止以及执行进入、等待、退出、终态等业务边界，不进入通用 `touch()`。旧值从 durable inputs 的 created/incorporated/settled 时间和结果事件等可信记录取最大值；关联建卡时间和普通 `updatedAt` 不能证明执行活动。关闭、恢复、observer reload 不制造新活动。

最近范围使用绝对时间滚动 24 小时（86,400,000ms），跨午夜不清空：

| 状态 | 默认窄栏 / 最近列表 |
| --- | --- |
| queued / preparing / running / waiting / settling / stopping | 始终显示，包括已归档但仍活动的任务 |
| interrupted | 未归档持续显示，等待明确处理；归档后从历史访问 |
| completed / failed / cancelled | 未归档且可靠活动时间距现在小于 24 小时；刚好满 24 小时退出 |
| 当前查看的过期终态 | 未归档时可在原排序位置临时保留并标注“当前查看”；离开后隐藏 |
| 已删除 | 不由查看例外复活 |

前天开始、刚刚结束的长任务从真实结束活动继续保留 24 小时。缺少可靠活动时间的历史任务可从全部任务访问。到期仅改变展示，不停止、删除或归档任务，不更改当前输入目标。改名、标题刷新、统计/快照、查看、hover、归档/恢复、ready 和重连不续期；全部和归档范围保持相同稳定排序。

完整历史关联可采用已记录的完成/等待 `runDetails.endedAt`，不把回答起始时间误当结束；无法区分主动停止与关闭的旧 `stopped` 记录不据此续期。相同等待状态/原因的重复检查不制造新活动。

### 每任务上下文快照

每个 Worker 独立发布轻量上下文估算，即使前台正在查看其他任务。快照在估算产生时捕获 project/card/session/root/segment/generation、Host/runtime、lane/有效上下文配置、projection revision 和 sequence，Host 只接受当前匹配且不倒退的结果。复用 Worker 的新执行段重新捕获身份；接收端不得给旧估算补上当前身份或分母。lane 指纹不含凭据。

有效快照显示原始 used/max token 与百分比；仅画弧限制为 0–100%。真实 0% 与缺失统计分开，无有效分母、负数、NaN/Infinity 或矛盾数据按未知处理。completed 保留最后有效值，不能强制 100%。压缩、epoch 或受控模型/上下文变化允许占用下降；累计预算和逐币种费用不随之下降。旧恢复值显示“上次记录”及时间；新 lane 无估算时不套旧分母。

快照仅为展示元数据，单独保存为项目 `task-context-usage.json` v1；常规发布合并为 300ms，轻量原子保存合并为 1000ms，终态/销毁边界收口，不逐 token 重写 Registry。它不成为容量准入、审批、时间或费用预算权威。保存失败只能降低展示可信度并留下诊断，不能改变任务终态、阻止停止或延迟正文耐久 ACK。删除/销毁清理缓存与定时器；Worker 被回收时解绑 runtime，保留值降为上次记录，旧 producer 不再接收。observer 重载以 owner 当前文件为准清除已消失的快照，不能覆盖活 owner 的内存 producer。来源/配置 A→B→A 变化不使旧 A 分母重新生效。缺失请求、token、计价或用量始终显示未知/不完整，不能编造为 0 或免费。

## 模块与真实执行链

| 模块 | 职责 |
| --- | --- |
| `src/tasks/projectTasks.ts` | Registry、卡片、耐久输入/结果、依赖、恢复、默认两个根 Worker 调度 |
| `src/tasks/taskSidebarMetadata.ts` | 纯展示排序与滚动 24h 范围；不改 Registry 或调度 |
| `src/tasks/taskUsageSnapshot.ts` | producer 身份/lane/revision 核验、独立展示快照与恢复归一化 |
| `src/tasks/taskRuntime.ts` | 独立控制器及执行身份；单 runtime 单 writer；补充和定向停止 |
| `src/provider/projectAssistantHost.ts` | 项目入口、每卡 headless Provider、只读查看、草稿、结果事件、Router 接线 |
| `src/provider/KeepseekChatViewProvider.ts` | 原有 Host 执行管线在固定 session 容器内运行；实际 AgentRunner、审批及保存 |
| `src/agent/taskRouter.ts` | Router 固定 persona、固定工具 schema、宿主工具合同和结构化输入校验 |
| `src/agent/runner.ts` | 既有工具循环、Evidence、三协议配对，以及补充安全边界 |
| `src/tasks/projectOwner.ts` | 同物理项目跨进程长期执行所有权 |
| `src/tasks/projectResources.ts` | 有界工作区修改/验证租约、基线失效及校验 |
| `src/tasks/requestAdmission.ts` | 根任务、真实来源请求、Router 有界优先级；请求 permit 不覆盖工具或审批等待 |
| `src/sessions/chatSessionStore.ts` | 执行 session scope、运行 pin、dirty revision 保存、有限查看页与预取 |
| `src/webview/projectTasks.ts` | 窄栏/浮层/tooltip/圆环、keyed 展示、纯 UI 偏好、明确输入目标、热视图、分目标草稿和绘制确认消息 |

TaskRuntime 的 driver 接入独立 headless Provider，而非并发调用同一个可变 Runner。Worker 之间共享经过审查的存储、不可变来源缓存、请求准入和工作区资源协调；不共享审批队列、授权、控制器或可变会话激活门面。查看任务不执行 `selectSession()` 的执行选择事务。

侧栏停止、继续、归档和删除携带点击时的 Host/session/root/segment/generation；Host 拒绝旧窗口或过期目标，任务服务在串行事务内再次核对冻结身份，防止排队期间同卡切段后的迟到操作影响新段。内部既有调用可省略展示身份，但不会复用旧批准或 permit。

Router 使用独立 session 和持久角色 `project-router`，角色/tool schema 版本为 1。Worker 当前 request/tool schema 维度仍是 15，child runtime 协议为 11；新增 Router 不提升或批量迁移 Worker 热 lane。`agentRole` 的归一化与旧会话读取属于会话存储合同。

## 邮箱、补充与崩溃恢复

`ProjectTaskService` 使用串行、copy-on-write 的原子 Registry 事务保存卡片、输入正文、幂等键、结果事件及索引。逻辑卡片/输入/事件版本为 1，物理 manifest 写入版本为 2（兼容旧内联 1）：正文、prepared 输入和结果先写不可变对象，再提交 hash/字节引用；不以临时 claim 表示输入已经消费。

输入状态是 `received → durable → queued → incorporated → settled`，失败/取消有独立说明。`durable` 表示输入正文、目标、引用/Skill 和幂等身份已保存；`incorporated` 只表示真实用户消息已进入指定 session 的持久历史，不能解释为模型已经理解。

执行先保存 `prepareInput` 展开意图，再保存 session 真实用户消息，最后标记 incorporated。重新进入时依据 inputId/messageId/preparedContent 判断是否已经纳入，重用原 Provider-visible 字节，不重新展开引用生成不同请求。结果先落 session，再提交 eventId 结果事件；重复结果通知只更新界面，不重新运行 Worker。

运行中补充先耐久入邮箱并撤销旧段尚未派发的审批/自动续跑资格，当前模型请求和已派发操作继续结算。Runner 只在模型步及已派发工具、原生调用/结果完整落盘后交出安全边界，结束旧 assistant segment；Host 随后追加真实 supplement 用户消息，同 root 新 segment 继续。它不会在持续增长的 assistant/toolRounds/providerReplay 中间插入 user，也不会把 supplement 伪装成 recovery。

重新启动时，保存的 queued/running 等任务成为 interrupted。邮箱、结果、依赖及预算仍可见；旧 callback、批准、permit、可执行 DraftRun 队列不复活。用户明确继续后才核对 checkpoint 和实际副作用；unknown 不自动重试，完成工具按既有 Evidence 幂等合同复用。

前端提交按 requestId/目标/草稿 revision 闭环。正文耐久 ACK 前不清稿；接受 ACK 只清除仍匹配的版本，较新编辑不受影响。Webview 本地状态保存尚未收到 ACK 的 requestId；重连按身份查询既有耐久接收结果，不重新投递正文或自动唤醒 Worker。

## 查看、草稿与增量状态

任务视图与执行身份分离。热查看恢复有限消息页、标题、草稿、结构化引用/Skill、光标、滚动及折叠状态；冷查看使用 `SessionViewPage`，完整执行仍加载权威 session。局部页类型不能回写覆盖完整历史或预算。历史工作位置按 `messageId` 恢复居中的有界页，并单独显示还有更早/更新消息；锚点已删除时退回最近页并保留草稿。新保存的 shard4 manifest 含消息 ID 索引，旧 manifest 只投影顶层 ID 定位，不为查看解码远处正文或迁移写回。

查看事件含 project/card/viewGeneration/revision。A→B→A 的迟到页面不会覆盖新视图。每个 headless Provider 的 stateRevision 按其卡片/会话 lane 独立比较，不能用 A 的 revision 阻止 B 或 Router 的首次状态。Host 实例变化另用 hostId 隔离，保留草稿并重新核对未确认输入。

卡片更新只更新任务区域；不重建前台 transcript、不恢复或移动正在编辑的光标。Worker 流式输出仅在该任务被查看时发布正文增量；后台更新真实卡片进展和终态。窄栏与浮层按不可变首次时间升序展示，同毫秒保留 Registry 原 cards 顺序；状态、用量、标题、选中和新 root 都不参与排序。权威 Registry 不为展示原地重排。

草稿使用每窗口、每目标的小型 v1 存储，包含 revision、markup、Skill 选择、光标及滚动。文本先经现有 composer 清洗和引用 codec 恢复。查看状态及草稿不进入 Provider 静态 system、冻结 contextInstructions、旧 user、工具 schema 或已保存 Evidence envelope。

深历史位置按 messageId 和相对偏移恢复。热页以该锚点为中心保留最多 30 条；冷查看通过对象 manifest 定位锚点所在的有界页，锚点删除时回到最新页。有更新消息未在该历史页内时显示“最新消息”；该操作只读取本地最新页，不请求模型。历史页保持锚点，后台流式尾部继续更新任务卡，用户打开最新消息后恢复正文增量。

`projectTaskPainted` 由双 `requestAnimationFrame` 后发出，且校验目标与代际。它表明渲染端经过绘制机会，不能把 Node DOM harness、Host publication 或两帧回调等同于已测得原生 VS Code 的真实可见绘制时延。原生 UI 的点击、首屏、草稿可编辑等指标必须另外采样。

## 缓存、预算与结果

所有角色仍使用 `buildProviderRequestProjection()` 生成请求和准入估算；Router 的专用 schema 不注入 Worker。明确新建、定向输入和状态按钮的 Router 分类调用为 0；普通进度/完成只发耐久结构化结果，不调用 Router。

hover/focus、浮层开合、范围切换、到期重算、查看、返回项目、展开历史、预取、恢复草稿、ready 和重连不发模型请求，不触发标题/摘要或付费预热。正在运行 Worker 的正常请求单独统计，不以全局请求计数误判视图触发调用。

新任务原子捕获项目来源/模型、root/cwd、审批/执行模式及显式 Skill 快照；缺少有效来源时可见失败并保留输入，不将空模型快照伪装为已开始执行。新默认值只影响新任务；当前 Worker 明确切换模型继续走既有受控 lane 合同。

每 root 的运行时预算继续覆盖 supplement、repair、epoch、审批及恢复。Router 使用独立小预算，不定时推理或保活。物理 request/attempt 仍由 Usage Ledger 入账；重试可能收费多次，不能因逻辑输入幂等而显示免费。缺失 usage/价格为未知或不完整，不显示为 0；正费用上限的既有 fail-closed 合同保留。

卡片显示有效时间和分币种参考费用；项目经过时间与任务有效时间总和是不同口径。项目区域另外显示 Router 请求次数和分币种参考费用，缺失计价显示未知，切到 Worker 也不隐藏调度开销。参考价不冒充实际账单，宿主预算及卡片原始记账不读取 UI 换算后的显示值。正文中的模型输出被标记为任务报告，不能把“测试通过”等模型陈述升级为宿主验证记录。详情的改动、验证和结果入口连接现有 ChangeSet/DraftRun/Run Details 证据。

## 所有权、资源与审批

长期项目所有权独立于 session 短写锁。项目根先 realpath，并向仓库根归一化；锁保存在共享机器本地目录，以原子排他创建取得并核对进程、nonce、inode。心跳或文件年龄不授权抢占。无法证明锁后端、远端 authority 或旧副作用安全时只读，不默认双 owner。

只读窗口可查看卡片/会话和保存本窗口草稿，不能执行 Provider、自动标题、迁移写回或其他旧入口副作用。关闭 Webview 不结束宿主任务；关闭 VS Code 后不承诺继续运行，也不自动恢复进程。

Apply、命令和固定 validation 通过项目资源租约。嵌套服务透传并核验同一 token，避免重复获取造成自锁；真正取得资源后重新核对信任、取消、hash/spec/permit 和基线。等待用户、审批、预算、依赖、Router 或 child 时不持工作区修改租约。外部编辑器/进程不受调度器约束，SafeFileEditor 的脏编辑器、原子写及 read-back 检查仍不可省略。

审批只有 ask/delegate，绑定原 task/session/root/segment/runtime/target/hash。UI 在发出每个旧有操作时附上 taskCardId/sessionId，稍后切换视图不改变原按钮目标。补充/停止撤销未派发资格；已经派发的真实操作先结算，不能仅发出 abort 就宣告无副作用。

## 回归和现场验收

自动回归入口是 `test/runTests.ts`。本功能重点包括：

- `projectTasks`：耐久输入、幂等、独立 Worker、补充/停止、依赖、故障与恢复。
- `projectTaskWebview`：实际生成脚本/输入 IIFE 的卡片、明确路由、A→B→A、草稿 ACK、持久草稿、只读、Router 状态及独立 revision。
- `projectAssistantViewHost`：实际 ProjectAssistantHost、项目 owner、session 存储与生成 UI 的有限查看、0 Provider fetch、会话字节不变和草稿重建。
- `observerSessionView`：真实 Parent Provider 的只读普通历史入口，30→80→120 分页、ready 复用、A→B→A 及重叠早页隔离；原活动会话/模式/正文不变，无 Provider 请求和权威存储写入。
- `projectCoordination`：以实际临时目录、进程、文件和请求门禁验证所有权及有序资源。以临时资源和实际门禁验证，不代表其他平台已验收。
- `projectRouter` / `supplementBoundary` / `projectAssistantIntegration`：固定 Router 投影、实际 Runner 安全边界，以及 Host/transport 的集成合同；具体通过项见本次执行结果。
- 原有 `cacheByteStability`、`protocolCache`、`modelLaneMigration`、`p1CacheObservability`、导航、输入、标题、计时、审批、DraftRun 和截断测试继续保护既有合同。

本次项目 owner、资源阶段、真实 SSE 请求 permit 及平台限制见[协调验收记录](keepseek-project-coordination-verification.md)。本地有限页/存储准备时延见[测量 JSON](benchmarks/keepseek-project-view-storage-20261107.json)；这些范围不替代原生绘制或真实 Provider 账单。

默认验证命令：

```bash
bun run compile
bun run lint
bun run build:test
bun run test
git diff --check
```

以下现场操作使用临时工程/存储；真实付费 Provider 仅在明确凭据、授权与预算下执行。

1. F5 打开扩展，创建 A/B 两个明确任务；确认均可执行，Router 分类请求为 0。在 A 执行时查看 B、返回项目并创建 C；C 排队且 A/B 不串写。
2. A 使用 ask 等待精确批准，B 正常执行。切到 B 后处理 A 原审批，核对审计 session/root/segment/target/hash；重复或旧 hash 不执行。
3. 在 A 长模型/工具请求中发送补充，先看到耐久接收，再查看旧 assistant 原生轮次结清、新真实 user 同 root 新 segment；核对完成工具未重跑和费用未重置。
4. 项目自由输入让 Router 建任务；核对真实固定 Router schema、创建返回 handle 的时机、独立账本。普通 Worker 完成时不产生额外 Router 请求。
5. A/B 同时修改临时相同文件并验证；检查资源串行及旧基线冲突。等待人工时另一任务可以取得资源；重新进入后旧验证基线不复用。
6. 切换十次、滚动、输入中文、输入法合成、Enter/@/拖拽、恢复草稿、重新 ready；核对没有视图触发模型请求、没有来源全量重扫，并分别采点击/绘制/编辑/耐久/可执行时点。
7. 确认标题刷新仍有 requestId 终态，手动标题优先；任务切换不触发自动刷新。
8. 在临时工程重启扩展；卡片成为 interrupted，未消费输入保留；旧批准/permit 不复活，点击继续前重新核对 checkpoint、未知副作用及剩余预算。
9. 使用同物理临时工程的双窗口及路径别名；确认只有 owner 执行，另一窗口只读。心跳超时或 stale 文件不得自动接管未核对命令。
10. 原生采样报告注明平台、历史条数、冷热定义、并发、样本数、p50/p95/p99 和内存峰值。三协议传输 payload、角色请求数、缓存 hit/input、未知 usage 与逐币种费用逐项保留；未运行真实 Provider 不报告真实命中或费用改善。

已验证、待现场和未通过必须依据本次执行证据分别记录。Node DOM/受控 transport/临时进程测试只能证明相应合同，不能替代原生 UI、真实 Provider 缓存/账单或其他平台的现场验收。
