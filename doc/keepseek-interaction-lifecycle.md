# KeepSeek 交互状态与异步生命周期

本页定义输入框、会话导航、提交、任务收尾与后台工作的当前合同。目录定位见 [架构地图](keepseek-code-architecture.md)，请求/副作用规则见 [运行时](keepseek-agent-runtime-workflow.md)。实现入口是 `src/provider/interactionState.ts`，Provider 只接线；Webview 只消费宿主能力，底层权限、预算和副作用检查继续独立执行。

## 1. 状态权威与拥有者

真实事实分别表示：主任务/准备/内部续跑、导航事务、当前会话上下文就绪、必要持久化、文件/命令/审批操作。标题、余额和展示统计等后台工作有独立生命周期。可见阶段用于解释当前阻塞，不能取代这些可并存的事实。

统一派生结果 `interaction` 包含 `sessionId/revision/operationId/phase`、`canEdit/canSubmit/canNavigate/canCancel/canChangeContext`、`cancelOperationId`、`blockingReason` 与 `waitingReason`。`waitingReason` 区分模型、会话、操作恢复、项目上下文和必要保存；不能再把模型或恢复等待统一显示为 Skills 加载。导航、上下文准备和必要保存不表示模型正在生成；草稿在这些阶段保持可编辑，提交仍等待正确会话的必要条件。停止仅在宿主有实际可用的取消入口时出现。

| 事实或兼容字段 | 所有权与用途 |
| --- | --- |
| Coordinator 操作 token | 在首个 await 前同步预占，绑定 operation/session/generation；只有匹配拥有者能变更阶段、交接、完成或释放 |
| 导航事务 | 正文/选择保存/必要恢复期间保持串行与重复点击去重；安全屏障后释放导航 owner，上下文继续按会话/generation 准备，不引入多会话主任务并发 |
| `isStartingRun` | 只读派生冲突互斥；不能由分支各自写入，也不能当作“模型运行中” |
| `isBusy` | 兼容真实运行消费者；输入框和导航按统一能力判断，不把各种工作重新 OR 后作为 UI 权威 |
| 上下文/安全就绪 | 当前会话必须恢复正确操作、历史与请求上下文；失败不默认为 ready |
| 后台展示就绪 | 加载中/不完整单独表达，不进入执行预算或主运行状态 |

模型流结束不意味着必要保存已经成功。状态立即转为保存或后续准备；待生效模型切换单独显示准备阶段，完成后再进入必要保存；必要屏障成功后再开放依赖能力。`activeRunSettled`、workspace 切换/退出等待及内部续跑必须遵守相应回答保存屏障；标题的 durable 标记只依赖此前真实用户指令的提交保存屏障，不能拖到回答结束。旧操作 finally 不得清掉后来取得的 token、控制器、settled promise 或提示。

内部审批、计划执行、DraftRun 自动续跑、repair 与恢复交接必须同步转移拥有者；不能先释放互斥再 await 后续入口。根 taskId、计时、预算、幂等记录与审批范围不因交接重置。epoch 是同一任务的受控请求边界，不产生新授权。

## 2. Host 与 Webview 闭环

Webview → Host 消息唯一入口仍是 `provider/webviewMessages.ts`；Host 主动事件不加入该联合类型。现有消息 type、DOM id、引用格式和 fragment 顺序保留。

发送/编辑重发带 `requestId`、目标 `sessionId` 和所见状态 revision。宿主先核对目标、必要就绪和冲突条件，再同步预占，异步屏障后重验身份。旧页面兼容字段只能走相同宿主检查，前端能力不会授予执行权限。

`submissionResult` 使用匹配 requestId/sessionId 返回 `accepted/rejected/failed`。接受表示正文已跨过必要持久化屏障；准备失败不会被当作接受。拒绝/失败必须闭环，包括空输入、未就绪、已有操作、错误会话、来源缺失和恢复失败等提前返回。重复结果幂等，迟到结果不能改变较新请求。

前端 pendingSubmission 仅防止重复点击，不写成宿主 taskRunning。仅匹配接受结果清除该次提交的草稿；拒绝/失败保留或恢复原稿。编辑期间产生的新内容不能被旧接受清空。编辑重发继续遵守历史截断、操作失效和保留前缀字节合同，不自动重发或排队。

轻量状态、完整 `state`、`statePatch` 和重新 ready 使用相同会话/revision 规则。导航提交记录进入该会话的 revision 下界；A→B→A 后来自旧一次进入的提交被拒绝，普通同会话状态更新不要求 revision 完全相等。过期快照不覆盖新状态，缺字段 patch 不继承另一个会话的运行提示；流式更新按所属会话和消息接收。`sessionChanged` 清理旧会话的持续提示/轮播/重连计时器，随后显示当前权威快照。

关闭 Webview 不是任务终态。重新 ready 获取宿主实际状态；扩展重启不从旧 `isStreaming/running` 标记恢复活进程或旧 token，也不恢复批准、permit 或执行队列。恢复说明与实际运行能力分别表达。

## 3. 持续状态与短通知

| 显示内容 | 来源、作用域与结束规则 |
| --- | --- |
| 加载会话、准备上下文、准备任务、执行任务、保存必要状态 | 当前有效操作；绑定会话/操作身份，终态同一次渲染立即移除，不依赖普通通知计时器 |
| 模型流/工具活动与重连进度 | 有效运行及取消目标；会话变化、运行终态和 owner 变化停止旧轮播/计时器 |
| 完成、模型选择反馈、保存失败、来源错误 | 短通知或明确错误；保留合理时长和相应会话/全局作用域，不能因空闲一概删除 |

终态或全局错误不能被旧通知 timer 清除；timer 只影响它创建的通知。按钮与持续状态使用同一快照，不出现可以发送却仍显示“处理中”，也不显示无合法取消目标的停止按钮。UI 使用短而准确的中英文，不展示 token/generation/hash 等内部术语。

对保存、执行及必要恢复，超时检测只能记录慢阶段、请求真实取消或权威重同步；它不能证明写入/执行未发生，不能强制释放仍有效的互斥或自行宣告空闲。尚未提交的历史读取按下一节的有界选择规则处理。

## 4. 导航关键路径与预算依据

正文安全可见、接收新任务、展示汇总完成是不同时间点。以下分类按实际消费者划分，不按模块名称猜测。

| 工作 | 安全展示正文 | 接收/继续任务 | 分类依据 |
| --- | --- | --- | --- |
| 初始 summary 索引 / 用户选择后的 lazy session load | 必须完成 | 必须完成 | 生产启动显式 fresh，只读摘要并在内存建立新空白；不读取旧 active shard、不保存占位覆盖历史 |
| 全局审批/ChangeSet/DraftRun 初始化及初始必要恢复 | 导航须等待该屏障 | 必须完成 | 独立 `startupNavigationReadyPromise`，失败不把历史当空白或安全就绪 |
| 模型目录、来源及必要选择保存 | 不阻止导航和正文 | 必须完成 | 模型解析与保存决定实际请求来源；余额磁盘展示不属于此屏障 |
| 内存选择与持久化 activeSessionId | 选择已确定后可显示 | 必须完成 | 页面、内存及持久化选择一致，旧导航不可回写 |
| ChangeSet/DraftRun session load | 可先显示正文，操作入口保持禁用 | 必须完成 | 旧提案、执行结果与历史归属需要复核 |
| pending history truncation 恢复及操作失效 flush | 可显示安全正文/恢复状态 | 必须完成 | 无效操作不得执行，不能丢失截断意图或重复副作用 |
| 当前会话项目指令、Skills、引用上下文 | 可先显示正文、编辑草稿 | 模型请求前必须完成 | 空白会话标记 deferred，可提交后在 task owner 下真实加载；已选非空历史仍在准备完成后开放提交，来源失败不能发模型请求 |
| `userTaskBudgets` / 完整 checkpoint 读取 | 不必挡正文 | 相应继续/恢复前必须完成 | 安全时间、费用、逻辑调用量、委派树与恢复键权威 |
| Usage Ledger 展示重建、参考费用/缓存观测 | 不阻塞 | 不阻塞 | 请求级原始记录单独耐久；这些汇总不是安全预算 |
| 子代理摘要、活动展示恢复 | 不阻塞 | 不阻塞 | `restoreUsage()` 只读 summaries/activities，不恢复 scheduler 预算或调度任务 |
| 标题生成/手动刷新、余额 | 不阻塞 | 不因展示占主任务 | 独立 session/request 所有权；用户指令 durable 后并行 drain，自动与主任务共享根预算预占，手动使用独立小预算；真实用量归目标，首次成功永久停止 |

生产启动及工作区切换使用 `fresh: true`：仅摘要索引进入内存，新空白不恢复旧 active、对象图、计划或上下文。新建空白、历史超时替换及清理后的空白均将上下文标记为 `deferred`，在会话/安全/模型条件就绪时可提交。第一条任务在首个 await 前占有 task owner，然后真实加载缺失或已变更的项目指令与 Skills，加载失败不得进入模型派发。自动保留刷新只读摘要并保留当前 resident active，不能恢复磁盘旧选择。

新建入口在初始化屏障后检查当前会话是否已有 `role: user` 消息。没有用户指令时复用当前对象和 ID，不触发保存、历史新增、`sessionChanged` 或上下文重置；草稿、引用、Skills、模式和就绪状态保留。Store 同样执行此检查，避免直接调用或重复点击生成空历史。已有用户指令即视为已使用，即使尚无模型回复或请求失败，也保留该会话并按正常屏障新建空白；随后再次新建仍复用这个空白。此规则不自动删除之前生成的空历史。

导航不等待整个 `startupInitializationPromise`。会话及必要安全存储跨过初始化屏障后，即使旧活动会话项目上下文、模型目录或展示工作仍在加载，也可开始目标会话事务。create/select/copy 的目标正文、安全选择保存、操作记录恢复及截断失效 flush 完成后，同步释放导航 owner。对于非空历史，项目上下文继续按目标 session/generation 准备，此时 canEdit=true、canNavigate=true、canSubmit=false；上下文和其它执行必要条件满足后在同次状态更新开放提交。导航方法返回的 Promise 仍可等待上下文完成供调用方收口，但 UI 导航能力不依赖这个 Promise 结算。会话/上下文 generation 变化使旧启动或导航上下文工作的 ready、error 和 finally 失效，A→B→A 也不能把第一次进入 A 的结果赋给第二次 A；旧 finally 不释放新 owner、不重复发布 sessionChanged 抬高新入口 revision 下界。不可取消的读取可继续完成缓存，但不能回写新会话状态。

历史正文选择在 store 内有 15 秒读取上限（`HISTORY_SESSION_LOAD_TIMEOUT_MS`），覆盖 `isSessionDeleted` 检查和正文读取。该读取向存储适配器传递 `readOnly`，不触发迁移或索引修复，防止迟到的旧索引覆盖新选择。超时只放弃尚未提交的选择，不缓存迟到正文、不改 active、不调用保存回调或 persist；Host 只释放该次 owner，随后复用当前非目标的空会话或按新建流程打开空会话，以非阻塞信息提示告知用户。新建会话仍通过正常保存屏障；超时读取本身不写入。开始 active 切换和 persist 后不再计时反转，因为内存已切换时放弃提交会制造不确定态。操作记录、历史截断恢复与项目上下文/Skills 仍 fail-closed，超时不能把这些依赖降级为 ready；真实 I/O 错误保留失败和重试语义。

余额 `refreshFromDisk()` 是按来源读取磁盘展示快照，不是每次启动在线查询。它在模型目录发布与必要选择保存之外完成；结果只在来源与模型刷新 generation 仍匹配时发布，读取失败只影响余额展示，不能锁回输入或回滚新模型选择。来源隔离和原刷新限流继续由现有余额 store 负责。

原始 Provider usage 记录在传输推进前单独持久化。`usageMetrics.displayReadiness` 使用 `loading/ready/incomplete` 表达展示恢复状态。展示重建失败保留内联迁移来源和不完整标记；不能把缺失统计当作 0。后台结果核验所属会话与数据版本，不能选择回旧会话或把展示完成误标为运行就绪。

安全预算来自 `sessions/userTaskBudget.ts`、`getTaskCheckpoint()` 与 Runner checkpoint：`usedMs/maxExecutionMs/maxCost/usedCostByCurrency/runBudget/budgetLimits/delegationBudget/commandRecoveryKeys`。Runner 用 checkpoint 恢复任务时钟、费用及委派树；审批 reviewer/子代理继承同一上限。展示后台化不修改这些恢复/合并路径，不少计、重复计或归零；正费用上限遇不可计价来源仍 fail-closed。

自动标题在真实用户指令正文提交保存成功后独立准备并行请求，不等待完整助手回答、工程成功或前台 owner 释放；初次主请求也不等待标题响应。自动只用本条 user.content，手动在确认目标时冻结最多最近两条真实 user.content，均不携带助手、工具、展开内容或旧标题；手动仍遵守现有 busy/saving 能力门禁。每 session 串行保留已观察的真实提交候选，自动续跑/审批不新增轮次，普通追加和切换查看不取消有效在途；首次有效标题与停止标记共同提交后永久停止。新 user_inputs_v3 basis 仅核验所选用户正文，助手 streaming/失败或变化不使其过期；只支持当前 `user_inputs_v3` basis。手动改名（含同文本）与刷新优先，旧结果/保存/finally 不覆盖新意图。用户正文保存后、预运行压缩前准备实际 root 活预算，并原对象注入 Runner。费用/token 无有限上限且请求无限或至少剩两次时可先开放标题，保留一次主调用余量；有限额度或仅余一次则等主请求首次预占耐久的短预算门，不等助手回答。用户亲自发送的 recovery 补充用新输入身份命名，同时保留旧执行 root 的已花额度。不能各从旧快照花同一余额或以等待完整标题响应串行阻塞初次主请求；后续同 root 续跑仍可等旧标题结算恢复单一权威。并行标题不重复累计主任务时间、不占输入 owner。完整状态、恢复与验收见[会话标题](keepseek-session-title-verification.md)。

`ChatSessionStore.persist()` 和 `CoalescedWriter` 的等待者仅在其 revision 或包含它的更新完整快照提交成功后完成。可合并普通快照，不可用 debounce、best-effort 或“界面已空闲”替代必要屏障。必要保存失败保留内存状态、明确阻塞及重试范围；展示错误不重新锁住整个输入框，未知副作用不得自动重跑。

## 5. 来源快照与失效

`SharedProjectSources` 复用有界的读取快照，并合并同一来源版本的并发读取。身份考虑真实任务 root/cwd、信任与相关配置/来源版本及受控刷新边界；命中不先完整扫描文件来证明命中。

复用内容限于配置、项目指令和 Skill 清单/读取结果。会话激活、冻结 implicit 集合、外部授权和可变错误不共享。`SkillStore` 的会话选择在读取结果之外处理；普通导航不无故失效热会话的 frozen implicit，也不重写 `contextInstructions`。不同来源版本通过无共享可变结果的 `discoverSnapshot()` 独立扫描并保留各自 diagnostics；旧来源 A 的慢扫描不能让来源 B 排在它后面，A 迟到也不能替换 B 的清单或错误。同一来源版本仍使用现有 cache 和 pending 合并，不新增另一套全局缓存。

创建/删除/修改 AGENTS、配置、Skill 及相关资源通过 watcher dirty 或明确变更通知失效；目录/信任/配置变化重新核验；显式刷新强制新版本。重启从新实例开始。无法证实来源仍有效时不复用旧授权；共享来源始终只读。

缓存与 UI 身份不进入 Provider 静态 system、旧 user、工具 schema 或 replay。未变化的 `contextInstructions` 原样复用；真实来源变化按现有受控边界生效。

## 6. 新后台功能必须声明的依赖

新增异步工作在所属领域模块说明下表内容，并用行为测试保护。不要为了避免建模直接占主任务状态，也不要在 fragment 重拼门禁。

| 声明项 | 必须回答的问题 |
| --- | --- |
| 会话与拥有者 | 结果属于哪个 session、request/operation 和数据版本？谁可完成、取消、丢弃？ |
| 交互能力 | 是否真正阻止编辑、提交、导航或取消？具体原因是什么？ |
| 持久化 | 哪个屏障成功才可继续？失败保留什么状态，如何准确重试？ |
| 预算 | 是否产生模型费用/任务时间/委派消耗？合并哪一个根任务权威？ |
| 副作用与恢复 | 能否真实取消，效果未知时如何停止？重启恢复说明还是实际工作？ |
| 迟到结果 | 如何证明不会覆盖其他会话或释放新拥有者？ |
| 诊断 | 关键路径或后台耗时如何区分，怎样观测命中/失效和过期丢弃？ |

`InteractionCoordinator` 的诊断事件为 `begin/phase/finish/stale`，记录操作种类、会话 SHA-256 短标识、阶段和累计耗时。`SharedProjectSources.diagnostics` 与 `SkillStore.sourceDiagnostics` 提供命中、未命中/扫描、合并读取及过期丢弃计数。`interaction_display` 单独记录后台统计恢复的耗时及 ready/incomplete，和前台操作阶段耗时分开。诊断区分关键路径阶段与后台展示状态，阻塞原因来自同一交互快照。`interaction_stage` 分别记录 `source-identity`、`shared-config`、`project-instructions`、`session-body`、`active-selection-save`、`operation-records`、`history-recovery`、`model-catalog`、`model-selection-save`、`balance-display`、`skill-catalog` 和 `skill-bodies`，包含 begin/end/failed/stale、耗时及脱敏身份；来源 cache hit/miss/merged/stale 沿用领域计数。`interaction_publication` 在 Host 发布时记录 bodyPublished、canEdit、canSubmit、phase、waitingReason、atMs，绑定会话/generation/revision；它证明状态已发布，不证明 Webview 已绘制或用户已看见。原生现场的实际可见时间需另采集。不得记录密钥、完整路径、prompt 或文件正文，不按 token 打日志。慢操作记录不授予继续执行的权限。

## 7. 自动化与时序证据

### 2026-11-07：首次历史与标题刷新修复

本次基线为 `ce12f6ec1339b71cf52b94fb258ed70f6bfb4480`（0.5.2）。修前 deferred 回归确认：安全及会话 ready 后，导航仍等待无关启动 promise；余额磁盘读取暂停会使模型目录尚未发布；保持历史展开、仅发送 `startupSettings` 就绪补丁时刷新按钮仍禁用。这些是依赖与渲染证据，不是原生 VS Code 的现场总耗时归因。

本轮另从该 HEAD 导出到临时目录编译，并重新比较安装目录 0.5.2 的六个关键 JS：Provider、interactionState、Webview script、SharedProjectSources、SkillStore、SessionTitleCoordinator，SHA-256 全部一致。因此本轮不能将这六处的故障归因为旧安装包；该检查只描述此次修前基线，不表示本次工作树修复已安装，也不替代原生复验。

本次新增受控证据如下；测试通过总数与命令结果在本次交付报告中记录，下面 2026-11-06 的数字只保留其当时范围。

| 场景 | 修改前失败与修改后证据 |
| --- | --- |
| 旧启动上下文暂停 | 修前导航仍等待无关 startup；修后目标正文/能力已发布、canSubmit=true，旧 A 的失败随后解除仍不能改掉目标就绪；来源计数 hit=1、miss=1 |
| 目标上下文暂停 | 同一依赖替身分别运行修前基线和修后实际编译方法：canEdit 均为 true、canSubmit 均为 false，canNavigate 从 false 变为 true。正式回归另验证后续导航、新建/复制、A→B→A、旧失败、新恢复拥有者与进入 revision 下界 |
| 余额磁盘暂停 | 修前 onResolved=false、models=0；修后不解除余额 gate，onResolved=true、models=1，模型刷新方法已完成 |
| 跨来源 Skill 扫描 | 修前新来源 B 排队等待暂停的 A；修后 B 先完成，A 迟到只计 stale，不替换 B diagnostics；同版本扫描仍合并 |
| 目标上下文暂停与再次导航 | 安全屏障后 create/select/copy 释放导航 owner，草稿和再次导航可用、提交仍禁用；契约回归核对旧上下文成功/失败及 A→B→A 不污染新状态，旧 finally 不释放新 owner 或重复提高入口下界 |
| 必要恢复失败与重试 | 重试重新加载目标操作记录，再恢复历史并开放提交，load 调用总计 2；不把失败降级 ready，不重复执行副作用 |
| 工作区切换及删除活动会话 | 与普通导航相同地恢复新目标操作记录，期间可编辑、不能提交；解除真实屏障后开放 |
| 历史按钮就绪与终态 | 保持列表展开，仅 startupSettings 补丁即可恢复原按钮；当前与非当前目标的 accepted/终态按 requestId 闭环，拒绝和保存失败有可见原因 |

这些依赖、调用次数和状态发布证据来自真实 Host、完整生成脚本、临时存储及 deferred，不是用户设备上的原生性能测量。现场仍须分别记录正文可见、可编辑、可提交与后台完成时间，不能把受控 promise 释放或 Host publication 当 Webview 绘制时刻。尚未获得现场完整分阶段耗时，不能据此宣称用户全部长等待已解释。

本轮实际验证结果：

| 检查 | 结果 |
| --- | --- |
| `bun run compile` / `bun run lint` / `bun run build:test` | 最终代码全部成功，退出码均为 0 |
| 导航、状态、启动、标题、来源缓存、持久化、Apply 与请求字节专项 | 215 项通过、0 失败、0 跳过，约 37.4 秒；使用真实编译方法/完整生成脚本、临时磁盘与受控依赖 |
| `bun run test` 全仓 | 收集 1,332 项：1,331 通过、0 失败、1 环境跳过，约 667.5 秒；跳过原因是当前沙箱不能绑定本地 fault server |
| 安装目录基线核验 | 六个指定 JS 与修前 HEAD 临时编译结果 SHA-256 全部一致；未安装本次修复 |
| `git diff --check` | 通过；未改版本、package.json、CHANGELOG.md，未打包、安装、提交或发布 |
| 原生 VS Code、真实模型、远程扩展宿主、Windows/Linux | 未执行，按下一节现场验收；不以 stub 结果替代 |

全仓收集后又细化了“历史读取期间出现新运行冲突”的终态原因，并新增 1 项测试；最终编译、lint、测试构建及上面的 215 项专项覆盖该末次变更，全仓统计不重复计入这 1 项。实施中发现的旧替身未声明就绪字段、标题测试删除临时目录时与派生 manifest 写入竞态，均已补齐真实状态或等待 storage flush；未用长 sleep、放宽性能阈值或删减断言解决。最终全仓的 10K ledger 性能检查在原 15 秒阈值内通过。

### 2026-11-06：交互生命周期治理历史证据

调查及实现基线为 `f83e9815bc6577c1e7128e520f07b55e0dcc356d`，工作树开始时干净。以下时序来自真实 Host/生成 Webview 脚本、临时存储与 deferred/假时钟；不是原生 VS Code 性能测量。普通通知的 8 秒是代码计时合同，不是用户现场精确等待时间。

| 验证范围 | 实际证据 |
| --- | --- |
| 修改前固定复现 | `sessionNavigation` 的上下文屏障中 `isBusy` 实际 true、期望 false；`inputComposition` 的 busy→idle 提示实际“处理中...”、期望空字符串；来源同版本并发读取实际 2 次、期望 1 次。保留这些行为断言，修改后通过。 |
| Host 能力、预占、迟到 finally 与提交反馈 | `interactionState` 8 项；`sessionNavigation` 21 项：首 await 前发送/编辑预占，拒绝/错误/重复反馈，导航去重、跨代提交、取消身份、慢保存/失败重试、旧刷新失败、启动安全恢复失败门禁与展示延后。`editUserPrompt` 的真实准备失败检查不提前 accepted、不调用模型。 |
| 真实生成 Webview 脚本与假时钟 | `inputComposition`：同一空闲更新清除持续提示，通知独立计时，旧 timer 不清新提示；导航/保存无虚假 Stop，草稿、编辑重发、乱序反馈及不完整统计。与 `contextEntryPoints/executionTimeStats/sessionTitleWebview` 的 71 项定向检查通过；补充首次启动草稿、最新 Host/导航/存储后，91 项专项检查通过；最终加入模型选择与拥有者领域验证，共 103 项通过。 |
| 导航依赖/读取次数与来源快照 | 安全操作恢复暂停时可以显示正确正文、编辑草稿但不能发送；解除后，即使 ledger 与子代理摘要仍暂停也可提交。来源 A/B 并发和随后 C 热读取总共 1 次指令读取，失效后为 2；相同 Skill 来源仅扫描 1 次。 |
| 预算、持久化、审批/命令与字节稳定回归 | 保留全仓 checkpoint、任务计时/成本、委派树、不可计价 fail-closed、三协议 replay 与旧 user 字节、审批与命令实际次数断言。新增必要保存阶段、临时磁盘 read-back、空 pending 的 storage flush 仍等待在途提交。最终全仓结果见下一行。 |
| compile / lint / build:test / test | `bun run compile`、`bun run lint`、`bun run build:test` 均成功；`bun run test`：1288 项，1287 通过、0 失败、1 跳过（沙箱禁止绑定本地 fault server）；末次 Host/Webview 修订后，六文件 103 项定向回归全部通过。 |
| 原生 VS Code、真实模型、跨平台现场耗时 | 本次未执行，按下一节单独验收 |

| 场景 | 修改前依赖/时序 | 修改后受控证据 |
| --- | --- | --- |
| 新建 | 初始化、选择保存、来源/Skills 全部结束后才发正文；导航呈模型忙碌 | 选择耐久后先发布正文与准备状态；可编辑、不可提交，无 Stop；必要上下文结束即解除 |
| 首次历史 | 选择保存→ledger 延后批次→子代理展示→操作恢复→上下文→完整显示 | 选择保存→正文可见；展示后台读取与必要恢复并行，后者完成即可提交 |
| 同作用域再进入 | 单实例按 session 重新加载，Skill refresh 重新扫描 | A/B/C 使用同版不可变来源；并发合并及后续热读取总计 1 次指令读取、1 次 Skill 扫描 |
| 任务终态 | 内外 starting/busy 与保存混用；旧提示等通知定时清除 | 模型结束→saving，同一快照无 Stop；durability 未完成仍互斥，成功后 idle 同次清提示 |

这些证据不定义跨设备统一毫秒目标。阶段暂停由测试解除，不用实际睡眠 8 秒验证提示。

硬验收不设脱离环境的总毫秒数：已结束操作提示同次状态更新清除；必要条件完成后不额外等通知 timer；无关展示工作不在提交关键路径；必要安全/耐久屏障仍实际阻止执行。

## 8. 原生 VS Code 现场验收

本节是可执行步骤，未在本次受控测试中冒充现场通过。使用开发宿主 F5 和隔离测试 workspace/session 存储；不要读取、破坏或改写真实会话来制造证据。记录平台、扩展基线、场景、阶段、首次安全可见/可编辑/可提交时间与诊断。模型场景仅在另行允许真实模型调用的环境进行。

1. **冷启动立即进入历史**：F5 打开 KeepSeek，立即展开历史并选择一条目标会话，输入多行草稿。记录会话初始化、目标正文、安全恢复、模型、上下文及后台各阶段时间，以及正文可见/可编辑/可提交时间。仅模型暂停时显示模型等待，操作恢复与保存也有对应文案；目标条件满足后不再等待旧活动会话上下文或通知 timer。
2. **新建与长历史**：准备隔离的空白及长历史会话，多次点击新建、重复选同一项并 A→B→A。检查正文/内存/持久化选择一致；新空白不读项目上下文即可提交；显式选择非空历史并暂停其上下文，在安全恢复/保存完成后无需等上下文即可再次导航，期间仍不能提交。分别放行旧成功/失败并 A→B→A，确认只有当前 generation 可改变就绪及错误，旧 finally 不重复触发切换或清新 owner。原有主任务运行时导航限制不变。
3. **慢展示与慢安全读取**：开发替身分别暂停 ledger/subagent 展示读取、ChangeSet/DraftRun、历史恢复和项目上下文。前两项显示统计加载中但不阻止就绪；后几项可编辑草稿、不可执行过期动作，解除后无需等待 8 秒通知。
4. **提交竞态与草稿**：在受控来源准备屏障重复 Enter/点击发送，同时触发导航；最多接收一个冲突请求。注入拒绝/失败/迟到反馈，检查不丢草稿、不跨会话发送、不自动重试；编辑重发保留历史截断与缓存前缀合同。
5. **任务结束、错误、取消**：在可控 Runner 替身中验证正常返回、错误和中止，检查持续提示立即结束；慢必要保存显示保存阶段且无虚假 Stop；普通错误/完成通知保留合理时长。
6. **保存失败与恢复**：向临时存储注入确定性保存失败。检查未持久化数据保留、依赖能力保持阻塞、原因与重试范围明确；解除故障后仅重试必要保存，不重跑副作用。
7. **历史展开等待就绪与辅助任务**：保持历史列表展开，只用 `startupSettings` 将标题能力从不可用改为可用；无需重开列表即可点击编辑按钮左侧刷新。分别刷新当前与另一历史行，检查立即旋转、相同标题/无材料/失败反馈及可重试。暂停余额磁盘或标题替身时，已就绪输入及导航继续可用；标题不选回目标、不重开主计时。
8. **关闭重开与重启**：任务运行和等待人工两种状态下分别关闭/重新打开页面，确认重新 ready 获取真实宿主状态；重启仅恢复说明，不复活旧 token/批准/permit/执行队列。
9. **输入与操作冒烟**：中英文切换，发送/停止、Enter/快捷键、输入法、焦点、拖拽、@、引用、编辑重发、设置与 Apply/Discard；确认统一能力未绕过宿主硬检查。
10. **来源复用与失效**：同作用域往返导航，记录命中与扫描次数；创建/修改/删除 AGENTS/Skill、切换信任/目录、显式刷新，确认正确失效。热会话保留冻结集合及旧请求字节，新任务在受控边界读取新来源。
11. **历史读取超时**：在隔离测试存储中分别门控 `isSessionDeleted` 与 `loadSession` 超过 15 秒，选择目标历史，确认打开可用空会话（已有非目标空会话时复用）、仅显示中英文信息提示；解除旧读取后不切回、不重复发布 `sessionChanged`。15 秒前解除时正常选中；单独门控选择保存、操作恢复及 Skills 时仍等待真实屏障，不因读取上限强制就绪。检查 `interaction_stage` 的 timeout 事件只有会话短哈希，无正文或路径。

## 9. 改动与兼容边界

- 领域规则在 `provider/interactionState.ts`；Provider 将导航、提交、继续、计划/审批/DraftRun/repair 交接、文件操作、来源变更及必要保存接入同一拥有者。来源刷新错误的迟到完成不得改写较新刷新。
- `webviewMessages.ts` 集中增加可选 request/session/revision 与取消身份，增加显式 retry；Host 反馈独立。旧消息仍经宿主检查；新运行状态全部为进程内瞬态，无会话磁盘 schema 迁移、无旧运行租约恢复。
- `sharedProjectSources.ts/skillStore.ts` 只缓存来源读取；`webview/**`、`shared/i18n.ts` 管呈现和中英文。`GlobalSessionStorage.flush()` 即使 pending 为空也跨已有 coordinator 屏障，等待已转移的在途提交。
- `isBusy` 剩余消费者是实际模型用量/流、模型切换策略、运行审计和旧 Webview 兼容回退。`isStartingRun` 是 Coordinator 的只读互斥投影，供来源修改、设置和续跑门禁使用。标题另由 `deriveSessionTitleCapability()` 区分导航上下文准备与真实运行/保存冲突；两者均不负责重新拼装输入框能力。
- `dispose()` 仍同步发出取消；突然退出依赖现有 checkpoint、prepared journal 与逐项耐久记录恢复，不能将页面关闭或进程退出解释成所有工作已成功保存。本次未做原生退出现场验证。
- 本次未改审批模式、权限、预算口径、三协议请求合同、package.json、CHANGELOG.md、依赖与设置；改动留在工作树，未提交或发布。
