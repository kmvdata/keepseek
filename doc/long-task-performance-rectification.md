# 长任务性能、上下文与可观测性整改

本地源码变更；没有安装、发布、推送或替换运行中的扩展。实施基线是 `3c8ebb3`（0.3.9），进入任务时工作区无改动；此前输出预算整改 `1896f50` 保留。本文区分真实静态快照、合成文件系统基准、离线 Provider 回放与未验证的线上/UI 行为。

## 权威与安全边界

用户配置的 context/output/压缩阈值保持权威；最终有效输出仍由真实剩余空间、校准和安全余量约束。没有引入固定输出上限或新的续写次数。静态 system、contextInstructions、真实 user 的 `(expandedContent ?? content).trim()`、冻结工具 schema、原生 replay lane 不因本次整改改写。原始消息、审批、DraftEdit/DraftRun、未知副作用及逻辑任务账本仍是审计/恢复依据；投影摘要和宿主事实不授予权限。

## P0/P1 映射

| 项目 | 重新确认的原因与实现 | 关键文件/证据 |
|---|---|---|
| P0-1 最终投影 | 旧兼容来源准入计入不会发送的 reasoning；源历史 fallback、运行时候选结果、预算与发送统一规范化，跨 lane replay 不进入估算；缓存观测用最终 body 的预算 | `providerRequestProjection.ts`、`runner.ts`；三协议既有回归、新的 reasoning/fallback 回归及 120 轮回放 |
| P0-2 正文分页 | 零空间时 reader 也进入普通外置链；现在保留根引用/hash/范围并按 UTF-8/完整结构裁剪，无正文明确失败，不制造新的空引用 | `evidence/shaping.ts`、`store.ts`、`types.ts`；小页、多页、损坏、scope、durable failure/recovery 回归 |
| P0-3 增量存储 | 已结束 run 内嵌历史导致每次全量复制和重写；V3 对象图复用历史，活动状态快照仅复制可变字段，归档不在普通加载中展开 | `sessionObjectStore.ts`、`persistenceSnapshot.ts`、`chatSessionStore.ts`、`globalSessionStorage.ts`；55 checkpoint 基准、旧快照迁移与故障注入 |
| P1-1 保护生命周期 | 历史收据永久保护，与审计保留混在一起；由宿主产物状态推导 pending/settled，保留可用 hash/真实审批事实；Epoch 不重装归档基础历史 | `historyProtection.ts`、`historyProjection.ts`、`historyCompressor.ts`、`contextEpoch.ts`；154 条场景中 4 条受保护、15 条近期、137 条可压缩 |
| P1-2 净收益与进展 | 相邻工具参数/ID 指纹不能识别交替循环；现在跟踪 64 个已交付事实，首次提醒策略调整，持续重复停止；摘要记录净收益，相同无收益状态不重试 | `contextEpoch.ts`、`runner.ts`、`runCheckpoint.ts`；ABA/批次组合/新范围/负收益摘要/恢复测试；live child 事件等待 |
| P1-3 可观测性 | view 转换丢计数，待落盘批次还可能短暂覆盖总量；保留全链路计数和缺失标志，分 source 汇总，批次按增量合并；修正时间/缓存/费用口径，独立滚动性能尾日志 | `usageStats.ts`、`usageLedger.ts`、`subagentUsageStats.ts`、`performanceTrace.ts`、Webview usage 与 i18n |

## 存储结构与一致性

workspace index 仍在现有 V2 目录，session shard 内容为 V3 manifest：`workspaceKey/sessionId/revision/header/messages`。每条 message 引用不可变 body 与可选 checkpoint 根 hash；摘要 metadata 足够列表/UI 使用。旁边 `<shard>.objects/` 保存 SHA-256 节点和大文本。相同 session 内相同历史可共享，跨 session 不借用路径或可变对象。

对象先写、原子 rename、同步落盘，然后切换 manifest。原子存储可选 durable 模式：file scheme 同步文件；非 Windows 同步父目录。远程 filesystem 依赖 provider 的原子 rename/写完成语义，未声称拥有本地 fsync 或跨进程锁保证。单个本地 shard 有 `writer.lock` 与 revision 检查；确认原 PID 不存在才回收锁。独立节点 I/O 最多四路，错误等待在途写结束后返回，不让迟到写提交旧 manifest。

不可变树缓存只用于生产者替换、不原地修改的字段；mutable journal、计划、预算、pending 等每次隔离。调用方的 durable await 不被心跳合并削弱。保存成功后才卸载已结束或已中断的历史 live checkpoint；最新可恢复状态保留。归档元数据保留 `pendingTool`，保护规则不必展开整个旧树就能保留未完成工具状态；旧归档缺失该字段且未完成时保守保护。对象 hash 或引用损坏会拒绝加载，不能假造恢复状态。完整对象在会话存续期间保留；当前不做对象级 GC，失败迁移的孤儿对象也保留，直到显式会话删除或既有会话 retention 删除。这样不会删掉历史恢复引用，但磁盘上会留存旧版本和旧备份。

V2 迁移先验证新图并保留原字节 `legacy-v2.json`，最后切换 manifest。重复迁移不产生第二套权威；失败仍可读旧文件。迁移是一次性工作，仍有旧巨型 JSON 解析和内存高峰，不能把热保存改善说成冷迁移无成本。一般加载只读消息正文及最后一个未结束 checkpoint，旧 run 的大树按 hash 按需读取。`runCheckpointArchive` 不进入 Webview；复制会话清除旧 session 的 checkpoint 引用。

## 分页、压缩与停止

reader envelope 继续指向同一根 evidence，给出 hash、总大小、范围与下一 cursor。字节页不切断 UTF-8；行/项/搜索保持结构边界。页面放不下时返回 `ok:false/errorType:evidence_capacity_blocked/bodyDelivered:false`。宿主按统一准入完成受控 rollover；无法腾出安全页空间则准确阻塞，不越过硬上限强塞正文。最小错误元数据使用既有 envelope 预留，不是正文预算豁免。

`executionStatus`、`deliveryStatus` 和可重建的 `bodyDelivery` 区分工具事实与模型可见信息。完整 evidence/hash 先于固定 envelope；重启交付已有结果，不重跑原工具。损坏/缺失内容、错误 scope、非法 cursor 不算成功。相同内容不同 ID、相同范围或元数据不产生新进展；不同范围、文件内容或真实结果变化会推进。运行中的已验证 child 用宿主完成事件等待，取消沿用既有 signal；完成后重新校验，不为等待消耗反复模型轮询。

摘要净收益包括新 summary/seed/元数据；无可压缩内容不请求空摘要，负收益摘要不采纳、不改变 covered IDs。重试门槛沿用当前预算的 safety/minimum-envelope 需求与原有软压力滞回，非新建固定上下文额度。无法容纳的保护内容保留并返回容量阻塞。`no_progress_loop` 保留观察窗口/恢复状态；普通 Continue 不清空记录或重置逻辑任务预算。新用户约束/证据通过明确新输入进入工作流；不得据摘要重放副作用。

## 指标和诊断口径

- 会话 Tokens/attempt/usage 是会话累计；面板时钟是最近逻辑任务跨恢复累计，不等于该会话全部历史的墙钟时间。
- attempt 是有物理发送记录的尝试，retry 是后续发送；usage response 是带完整可用计量的响应，并非所有 HTTP 成功响应。失败、无 usage、部分流不能造出零 Token 成功计量。账本可回算时回算；旧数据缺失显示未知或已知下界 `≥`。
- 进程内时长用单调时钟。明确审批/Apply 等暂停不计活动执行；延迟超过五秒不再自动当休眠扣除。无法可靠区分的挂起计时不作精确扣除，可能保守多计；原期限不延长。过去已丢失的间隔无法追溯修正。
- “本地估算可缓存比例”不是供应商严格上界，不截断真实命中率。费用未取得计价数据不表示免费。
- 每个启用 trace 的 run 增加独立 `.perf-0..3.jsonl` 与 `.perf-index.json`，每段 256 KiB；单个在途批次加一个 256 KiB 队列。超量记录 dropped 计数；index 保留轮转/丢弃状态。详细 trace 达到限额后性能尾部仍继续。关闭 trace 则两者关闭；磁盘不可写时日志 best effort，不能承诺仍落盘。
- 轻量事件只记录白名单标量，包含 session/task/run/epoch/request 关联、Provider start/end、首 chunk/首内容增量、tool、checkpoint 快照/编码/提交、projection、compression 净收益、phase、event-loop delay 和停止原因。首内容不是供应商 tokenizer 首 Token 的精确时刻。阶段有嵌套，不能把 span 时长简单相加当总时间占比。

先按 request ID 对齐 `upstream_attempt_*`，再看请求间的 `run_phase`、`tool_result_raw`、`checkpoint_store`、`projection_estimate`、`context_epoch_rollover` 和 `event_loop`。`tool_delivery.bodyDelivered` 只说明 envelope 含信息，须结合 deliveryStatus 判断请求交付；不代表模型已理解或任务已完成。不要据缓存命中或新增 Tokens 判断进度。

## 升级、恢复与回退

1. 不在正在运行的任务上热替换。等待停止/完成，关闭同一数据目录的所有写入者，备份完整 KeepSeek globalStorage（含 evidence、ledger、审批、对象目录），再按正常扩展升级流程加载新代码。本次未执行安装。
2. 新版首次成功保存会将已停止的 V2 shard 迁移；旧 running 标志默认 fail closed，避免覆盖旧活动写入者。需要离线恢复时，先 `bun run build:test`，再对一致副本运行 `node scripts/migrate-session-copy.js OLD_SHARD_JSON NEW_EMPTY_DIRECTORY`。该工具只生成/验证副本，将可规范化的 running checkpoint 标为中断，不执行任何任务；发现不合法 checkpoint 就停止，保留原副本。
3. 迁移失败/空间不足先保留原 shard 和 `.objects`。排除问题后重试，或在所有写入者关闭后恢复完整备份。不要手删 writer.lock 来覆盖仍存活的 PID；无法判定锁所有者时需要人工排查。
4. 离线恢复输出经过验证后，停机备份目标数据，再成对替换同名 shard 与 `.objects`；原 workspace index 的 session ID/文件名须对应，相关 evidence/ledger/审批文件须一起保留。恢复后仍重新做信任、lane、hash、权限及预算检查，不自动启动。
5. 旧版不支持 V3 manifest。回退只能在停止写入者后使用升级前完整备份或 `legacy-v2.json` 加原配套数据；后者只含迁移当时状态，不包含升级后的工作。不要混用新 manifest 与旧对象，也不要声称旧版天然兼容。

代码需下一次**加载本地新构建或安装新版本**才生效；不能推断用户原有六小时任务已经提速。

## 验收边界

无真实 Provider 付费请求。本次 120 工具轮为固定 SSE 响应、真实 serializer/AgentLoop/tool/evidence 路径的确定性离线回放，不是六小时线上运行。真实快照分析也没有发出模型请求。

CLI 尝试以独立 user-data/extensions 目录启动 VS Code development host，CLI 返回成功但报 codesign 诊断；UI 自动化连接超时，没有取得可核验界面，隔离目录也未产生启动日志。因此首次 ready、用量面板、会话切换、设置、输入/@/拖拽/焦点、Apply/Discard 的**真实 UI 手测未通过验收**。源码/fragment/hash/键盘与协议自动回归另列，不冒充手测。未查看或复制密钥，未修改当前安装扩展。

Windows fsync/远程文件系统、多窗口旧版本写入者竞争、断电、真实磁盘 ENOSPC 与真实 Provider 速率/首 Token/UI 的现场验收尚未实测；用故障注入、local file 与模拟 remote fs 覆盖可执行部分。本地复制迁移不证明生产环境自动升级无风险。

## 真实静态快照复核

从现有 KeepSeek 数据目录只读取得一次一致副本（复制前后 size/mtime 校验）；分析与迁移均在临时副本。该快照最后状态是 `interrupted/user_stop`，不是正在运行。已安装 0.3.9 的相关构建模块与基线源码构建一致；没有改写或重新安装。

| 指标 | 本次实测 |
|---|---:|
| 原 shard / message / checkpoint | 224,105,270 字节 / 165 / 55 |
| 内嵌 checkpoint 合计 | 220,278,445 字节 |
| checkpoint.request.history 合计 | 114,216,104 字节 |
| V3 manifest / 去重对象 | 71,032 字节 / 6,484 个、9,139,621 字节 |
| 保留的原始备份 | 224,105,270 字节（未删除） |
| 普通加载 | 766.86 ms，1 个活跃恢复 checkpoint + 54 个 archive 引用 |
| 修改 updatedAt 的增量写入 | 72,920 字节 |
| 冷迁移 | 207,605.83 ms，迁移段 event-loop 最大延迟 2,061.50 ms |
| 迁移后 RSS 采样 | 2,397,745,152 字节；包含分析程序仍保留的原始 bytes/解析数据，不是扩展常驻内存 |

冷迁移仅采样一次，不给 P95。开发中第一版顺序对象同步写入为 309,147 ms、迁移后 RSS 2,571,988,992 字节；最终有界 I/O 与提前释放第二棵旧 JSON 树后得到上表结果。最终首次迁移仍慢，必须预留时间和空间；这是明确剩余开销。新结构加旧备份的总磁盘量暂时大于 224 MB，不能宣称升级当刻磁盘占用只剩 9 MB。此次没有删除任何审计数据来换取改善。

同一 checkpoint、同一模型配置（1024000 / 393192），已安装旧 Runner 的准入估算为 **678899**，新版准入和最终发送 body 预算均为 **570110**，无需压缩，有效输出仍为 **393192**。差异来自未发送 reasoning 的统一剔除。本次不是原提示中 678586/569797 的原时点重跑；不把两组数字混为同一记录。候选工具结果、未来 envelope 和安全余量仍另有明确准入预留，不能据此要求所有阶段数字无条件相等。

此快照的持久化统计是 **282 attempts / 264 usage responses**；旧 view 转换均为缺失（随后 UI 变成假零），新版转换为 **282 / 264**。与此前 274/256 样本各多 8，不能用此前时点数值替换本次实测。274/256 另作为回归 fixture 验证。

结果：[long-task-field-snapshot.json](long-task-field-snapshot.json)；脚本：[analyze-long-task-snapshot.js](../scripts/analyze-long-task-snapshot.js)。未重新执行原任务、工具、副作用或模型请求。没有可比较的生产 Provider/本地阶段新时间线，也没有真实模型摘要 token/成本与首 Token 延迟测量；此前 28%/72% 时间占比仅为排查线索，不列作新验收结果。新增滚动日志用于下一次运行后采集这些指标。

## 同机前后性能对比

每档 7 次小增量（只增加活动 checkpoint 的 usedMs），配置均为 1024000 context / 393192 output。初次构造/落盘不计热保存；保存包含快照、序列化、对象 I/O、manifest commit。基线、新版分开顺序运行，没有同时跑测试。P95 用 nearest-rank，7 次样本中等于最大值，只用于复现本次分布，不宣称统计置信区间。S0 初测和最终基线复跑都保留；以下使用最终复跑，JSON 记录原始写入量数组。

| 规模（checkpoint 数） | 旧等价 shard 字节 | 每次实际写入字节，前 → 后 | 保存 P50 ms，前 → 后 | 保存 P95 ms，前 → 后 | 单次调用的 writeFile 次数，前 → 后 |
|---|---:|---:|---:|---:|---:|
| 小（3） | 95,769 | 96,306 → 3,350 | 4.86 → 105.19 | 5.47 → 156.70 | 2（一次 3）→ 4 |
| 中（20） | 15,936,717 | 15,937,258 → 13,230 | 148.33 → 110.94 | 187.94 → 111.84 | 2 → 4 |
| 大（55） | 224,445,672 | 224,446,215 → 33,589 | 2,284.95 → 149.96 | 2,318.53 → 197.21 | 2 → 4 |

小档有一次基线写入为 96,605 字节，来自既有索引定时写入；新版每轮相同。写入量不含 OS 元数据、lock 文件和 fsync 的内部物理 I/O，统计的是 VS Code fs.writeFile 的 payload 字节及调用次数。每档逻辑 persist 次数相同，均为 7；不是靠减少 durable 屏障次数获得改善。manifest 仍随消息条数增长，但不再随所有归档历史正文的总字节增长。

| 规模 | 磁盘总字节，前 → 后 | 新版对象图字节 / 总文件数 | checkpoint 快照 P50 ms，前 → 后 | 普通加载 ms，前 → 后 | event-loop 最大延迟 ms，前 → 后 |
|---|---:|---:|---:|---:|---:|
| 小 | 96,605 → 54,390 | 51,747 / 52 | 0.160 → 0.179 | 6.10 → 14.79 | 12.51 → 54.56 |
| 中 | 15,937,557 → 891,166 | 878,644 / 316 | 5.290 → 0.152 | 87.12 → 57.12 | 157.81 → 12.49 |
| 大 | 224,446,514 → 4,819,300 | 4,786,420 / 841 | 25.132 → 0.196 | 1,308.03 → 184.09 | 1,974.47 → 29.25 |

这是新建合成会话，不含旧文件迁移备份；真实迁移必须额外保留原 224 MB。新版 encode（含对象 I/O 和锁）P50 为 60.81 / 65.17 / 86.84 ms，commit 为 39.81 / 40.35 / 42.08 ms。旧实现没有同粒度阶段事件，不能将总保存时间当作旧序列化独占耗时。

| 规模 | 采样最大 RSS MB，前 → 后 | 采样最大 heapUsed MB，前 → 后 | GC 后 retained heap P50 MB，前 → 后 |
|---|---:|---:|---:|
| 小 | 55.31 → 58.08 | 7.92 → 8.41 | 7.24 → 7.72 |
| 中 | 257.49 → 141.60 | 19.79 → 27.92 | 9.78 → 10.56 |
| 大 | 1,379.53 → 999.44 | 366.53 → 31.58 | 18.72 → 20.95 |

MB 均为十进制。RSS/heap 是每轮结束采样中的最大值，**不是连续采样的绝对进程高水位**；同进程先跑小中大，V8 分配器可能保留早先内存。大档热保存 heap 峰值明显降低，但 GC 后 retained heap 没有降低；不可据此宣称常驻内存降低相同比例。

小会话保存反而增加约 100 ms，主要是新增可靠落盘屏障；本次没有为改善数字关闭 fsync。小档 P95 与 event-loop 最大值有长尾，无法据单个样本归因于某个宿主进程。普通加载也存在对象读取成本，小档有回退。当前收益目标是消除归档历史线性重写，代价包括更多小文件和固定提交开销。一次运行的 wall time 改善不能外推为 Provider 请求延迟改善。

数据：[S0 初始基线](long-task-perf-before.json)、[最终基线复跑](long-task-perf-before-repeat.json)、[新版](long-task-perf-after.json)。脚本：[benchmark-long-task.js](../scripts/benchmark-long-task.js)。

## 行为验收矩阵

以下均为本地自动回归；HTTP/SSE 由确定性 fixture 驱动，不能视作真实供应商验收。

| 行为 | 回归位置及验收内容 |
|---|---|
| 三协议最终 payload/budget/replay | `protocolCache.test.ts`、`toolResultBudget.test.ts`、`longTaskPerformance.test.ts`；静态前缀、user 字节、工具顺序、原生 lane 和实际序列化 body |
| 来源转换与输出权威 | `qwenCloudProvider.test.ts`、`accountProviderSafety.test.ts`、`toolResultBudget.test.ts`；剔除不发送的 reasoning，source/model/endpoint 校准隔离，保持 393192 配置输出 |
| evidence 正文与权限 | `toolResultBudget.test.ts`、`longTaskPerformance.test.ts`；零空间明确阻塞，UTF-8/极小页/连续 cursor、根引用不变、scope 拒绝、损坏内容拒绝 |
| 旧 checkpoint 迁移与存储 | `longTaskPerformance.test.ts`、`chatSessionStore.test.ts`；55 个 checkpoint、准确旧字节备份、惰性归档、中断 run 卸载后 pending 保护与旧字段兼容、重复迁移、stale writer、活跃锁、manifest 中断及 ENOSPC 注入 |
| 工具恢复 durable 屏障 | `toolResultBudget.test.ts`、`longRunningAgent.test.ts`；intent/完成/evidence/envelope、未知结果不重试、恢复已完成工具不重跑 |
| 审批与副作用 | `approvalMode.test.ts`、`approvalReviewer.test.ts`、`draftRunExecutor.test.ts`、`draftRunStore.test.ts` 及现有安全编辑测试；三模式、hash、permit、取消、重复执行、恢复 |
| 保护与摘要 | `historyProjection.test.ts`、`historyCompressor.test.ts`、`longTaskPerformance.test.ts`；154 条历史、pending/settled/未知、摘要失败、负收益不采纳、不改原历史、同指纹不重复摘要 |
| 跨轮进展 | `toolResultBudget.test.ts`、`longTaskPerformance.test.ts`、`subagentUsageRuntime.test.ts`；ABA、批次组合、同内容新 ID、不同范围/文件、child 完成事件与取消；恢复检测窗口 |
| 用量、计时 | `subagentUsageStats.test.ts`、`subagentUsageRuntime.test.ts`、`longRunningAgent.test.ts`；274/256 不丢失、未知旧数据、重复与 pending delta、flush 期间到达新记录、长间隔计时和明确暂停 |
| 持续性能尾日志 | `interactionTrace.test.ts`、`longTaskPerformance.test.ts`；详细 trace 截断后继续、分段轮转、慢磁盘有界队列、dropped 状态、不记录工具正文 |
| Webview 兼容 | `inputComposition.test.ts` 及现有 input/消息测试；fragment 字节基准、DOM/type、首次 ready 相关脚本契约、键盘输入契约。仅自动化，不覆盖实际鼠标和渲染手测 |

120 轮离线回放：每协议 40 个工具轮（20 次原始读取 + 20 次正文分页），第 20 轮中断并用新 Runner 恢复；每协议 41 个执行请求，20 页均实际进入发送 body，摘要 0 次、Epoch 0 次、原始读取总数仍为 20。工具 schema 保持一致，task ID 和已用时间跨恢复保留。这个场景证明正常历史增长不制造空引用/无谓摘要，容量压力和低收益循环另由预算/摘要回归覆盖，不能外推任意六小时负载。

独立执行 `migrate-session-copy.js` 的实际检查也通过：原 shard 和 legacy backup 逐字节相同，running → interrupted/extension_restart，usedMs=5000、maxExecutionMs=10000、modelRequests=7 均保留；重复使用非空输出目录被拒绝。未恢复到生产目录。

## 实际执行的验证

环境：同一台 macOS x64 宿主、Node v24.15.0、Bun 1.3.12。源码基线先单独执行测试：741 项，740 通过，1 跳过，0 失败。最终源码执行：

```bash
bun run compile
bun run lint
bun run build:test
bun run test
git diff --check
```

最终执行全部退出 0。最终测试 757 项、756 通过、1 跳过、0 失败，耗时 88.23 秒。开发中新增恢复测试曾因 fixture 缺少 RepairLoopState 字段导致 build:test 失败，补齐后重新执行上述全部命令。跳过的是 `local fault server exercises delayed headers, disconnection, delayed EOF and healthy connection reuse`：当前沙箱禁止绑定本地监听端口，基线也同样跳过。其余 stream/retry/error 路径有离线 fixture 覆盖，但不替代该真实 socket 测试。没有运行市场打包、安装、发布或推送。

性能复现：`bun run build:test` 后运行 `node --expose-gc scripts/benchmark-long-task.js after`。基线使用 `git archive 3c8ebb3` 的独立临时源码与同一 benchmark 脚本、相同依赖构建后运行 `before-repeat`，不回滚工作区。现场副本分析用 `node --expose-gc scripts/analyze-long-task-snapshot.js SNAPSHOT OLD_EXTENSION_OUT`；只写独立临时复制，不访问模型网络、不输出会话正文。对应 JSON 是可复核测量结果，不是生产监控数据。

