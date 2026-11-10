# 手动清理历史会话

本页是本功能的行为、存储与验收入口；显示设置和自动保留规则仍由原有配置及 `sessionRetention.ts` 负责。本功能不调用模型，不操作项目目录、Git、账号、模型设置、Skills 或 AGENTS。

## 用户行为

在“设置 → 历史会话”的独立清理区域选择“当前项目 / 全部项目”和“超过指定天数 / 全部清除”。每个新表单默认当前项目、3 天；下拉仅提供整数 1–7。保存历史显示范围不会执行清理，也不会更改本次清理参数。清理包含收藏；原有 60 天自动保留仍保护收藏。

按天使用最后更新时间，冻结预览时刻 `now`，截止为 `now - days × 24h`，只清理严格早于截止的会话。等于截止保留；缺少 updatedAt 时才允许可信 createdAt 回退，损坏日期和旧归一化 epoch 不当作真实活动时间。全部清除不限时间，但仍验证身份、归属与使用状态。

预览显示候选、收藏、使用中保护、未知数量和实际本地截止时间/时区。用户点击“清理…”后由宿主显示一次原生 VS Code 模态确认；取消不写删除意图。不可恢复文案说明会话和专属运行记录将删除、回滚历史将不可用，已经修改的工作区文件不会回滚。

执行后结果保留在清理区域，区分完全清理、使用中、预览后变化、无法判断/不可用、提交前失败、已移除但待回收。旧操作恢复时显示其原始规则；“再次清理”才回到默认表单。关闭 Webview 不撤销已经确认的操作。没有后台按 3 天清理任务。

空闲当前会话可被删除，随后建立新的空白容器，保留未发送草稿；不会恢复上一条历史、准备全量上下文或请求模型。独立会话的正文与 Provider 前缀不被改写。

## 模块与权威

| 模块 | 职责 |
| --- | --- |
| `sessions/sessionHistoryCleanup.ts` | 严格参数校验、时间筛选、预览计划、一次性令牌、确认请求拥有者、顺序批次、操作日志与恢复 |
| `provider/historyCleanupController.ts` | Store 接线、使用保护、当前 Memento 定向回收、已删除内存失效 |
| `provider/KeepseekChatViewProvider.ts` | 本地能力、宿主确认、Webview 状态和空白替换接线 |
| `provider/sessionUseLifetime.ts` | 跨排队/续跑/等待/收尾空隙保留原使用租约，真实空闲后释放；不建立项目 owner |
| `sessions/sessionDeletionAuthority.ts` | 跨进程 gate、使用记录、耐久 tombstone、删除后的读写拒绝 |
| `sessions/globalSessionStorage.ts` | 只读原始索引预览、归属校验、最终目标复核、shard/对象/index/V1 回收、迁移防复活 |
| `sessions/sessionObjectStore.ts` | canonical 主 shard 的最终保存与删除共用会话 gate；对象 writer 锁位于内层 |
| `sessions/sessionAssociatedDataCleanup.ts` | 各所属 Store 的定向回收与真实错误聚合 |
| `webview/input/dialogs/historySettings/` | 中英文表单、异步预览、进度/结果、键盘与草稿保留 |

Webview 不传删除路径或权威会话集合，也不能用 confirmed 标记绕过确认。预览令牌绑定 Webview 身份、选项版本和固定候选，默认五分钟有效；重载、选择变化和新预览使旧计划失效。重复消息共享请求拥有者。确认前不持有磁盘锁。

预览直接读取原始 summary，避免 normalize 为损坏日期制造 1970 年时间，不展开会话消息、对象图或 checkpoint，不调用会写 index/manifest 的恢复入口。完整索引身份检查会发现跨项目重复 ID；无法证明归属时不授权删除。缺失索引的孤儿 shard、legacy-only 文件在预览中报告未知，不为计算数量批量展开旧正文。执行逐目标有界读取 shard 身份和 header 更新时间；这是最终删除准入，不是预览 hydrate。

## 存储、锁和恢复

`globalStorage/session-deletions/v1/deleted/<sha256(sessionId)>.json` 保存版本 1 删除记录，含 workspaceKey、sessionId、operationId、确认时间、committed/reclaimed 阶段及无正文原因码。记录位于目标会话目录之外。只有宿主确认后、目标最终身份/版本/使用状态复核通过的目标才能写入记录，且 tombstone 使用耐久原子替换。

同一 `sessionId` 的所有 canonical 主 shard、使用准入和删除提交共享短范围 gate。跨进程 gate 使用唯一参与者文件和 bakery 顺序：进入者先发布 choosing，再冻结序号，按序号和唯一 token 等待。存活由 PID 探测证明；只有 ESRCH 可视为死亡，EPERM/损坏/未知所有权保守保护。不使用 TTL 或过期心跳推定空闲，不删除并重建其他写入者持有的锁路径。

锁顺序为会话 gate → 原有对象 writer 锁。workspace index、manifest、各共享关联 Store 的 gate 独立获取，不在会话 gate 中嵌套获取，宿主确认不占 gate。主保存的临时 use 记录覆盖 shard 到 index 提交；排队、运行、审批、Apply/命令等入口的运行 use 记录由宿主保留到终态。`SessionUseLifetime` 跨排队、续跑、审批等待与收尾之间的局部执行空隙继续持有原租约，由宿主的真实 in-use 判断在空闲后释放；状态检查失败保留保护，关闭 Webview 不把在途命令误判为空闲。物理回收同各 Store 的迟到写入共用对应 gate。

逻辑提交后，读取、resident/summary 合并、孤儿修复、旧来源迁移、延迟 manifest、主 shard 和关联 Store 写入均检查同一删除权威。即使回收失败，已删除 ID 也不重新可见或可执行。删除记录不因物理完成或 20 条结果日志保留上限而删掉，避免旧来源重新导入。操作日志位于 `history-cleanup/v1/operations/`。目录版本保持 v1，当前文件 schema 为 v2，兼容读取旧 v1 全量操作记录。每次确认只持久化一次不可变计划，逐目标写小型结果 delta 与紧凑进度；终态只合并一次，避免每删一个会话重写整个候选计划。只对完全回收的终态记录保留最近 20 条；待回收记录和删除权威不随此上限丢弃。

操作文件均位于该 workspace 的 `<workspaceHash>/` 目录，文件名由 operationId 的 hash 生成，Webview 不提供路径。

| 文件 | schema 与用途 |
| --- | --- |
| `<operationHash>.json` | v2 不可变计划，内含最小化 v1 操作/目标记录 |
| `<operationHash>.results/<index>.json` | v1 单目标结果 delta，绑定 operationId 和目标索引 |
| `<operationHash>.state.json` | v2 紧凑状态，含 operationId、确认时刻、ownerPid 和计数/进度 |
| `<operationHash>.complete.json` | v1 最小终态快照，一次性合并结果；在操作 gate 下回收已合并 delta |
| 同级 `<workspaceHash>.json` | v2 最新操作指针，兼容读取旧版全量记录 |

读取时叠加已写入的 delta，覆盖“结果已写入、紧凑进度尚未更新”时中断的情况。此操作日志不代替每个会话的 tombstone；计划内尚未提交删除权威的项目仍没有重启删除权限。

重启恢复仅重试已经具有相同 operationId 耐久 tombstone 的目标；已确认但尚未完成目标最终复核的计划项不会自动取得删除权限，不重新全局筛选一批候选。当前 workspaceState 旧记录可访问时定向过滤。未打开项目的旧 Memento 无法从当前 ExtensionContext 读取，列为不可访问旧来源；以后项目打开时，迁移入口先定向回收已删除 ID，再处理原有迁移标记。

## 所属数据与保留边界

| 所属数据 | 本次处理 |
| --- | --- |
| 摘要、会话 shard、对象图、对象目录内 legacy 备份、可访问 V1 记录 | 删除目标 ID 的数据并阻止旧快照重新写入 |
| Evidence、子代理结果/诊断/私有历史、用量账本 | 所属 Store 按 session 定向删除，错误不吞掉 |
| DraftRun、审批记录、ChangeSet/回滚记录 | 磁盘与当前内存失效；旧提案不能继续执行、批准、Apply 或回滚 |
| ChangeArtifact 共享 blob | 交给现有全引用 GC，不按单会话 hash 强删 |
| 可证归属的 interaction trace | 定向回收；无法证明归属的旧混合日志报告待处理 |
| 标题候选、任务卡/计划、列表选择、展示/用量缓存 | 取消或失效，迟到结果不能复活删除对象 |
| 无 session owner 的 `dropped-file-references` 缓存 | 可能被多个会话引用，保留；不宣称这些共享/无法归属缓存已物理擦除 |
| 其他会话及共享设置、外部附件原文件、已修改的工作区文件 | 保留 |
| 其他项目不可访问 workspaceState、外部备份 | 不承诺已物理擦除，结果单列限制 |

非 ENOENT 的权限/I/O 错误及损坏 JSON 不作为“已不存在”。提交前失败仍保留会话；提交后失败返回已移除、数据待回收；missing 是幂等成功。共享全局 Store 的删除和写入互斥并保留其他项目及并发新增记录。

## 实测与复现

2026-11-10，macOS（darwin），Node v24.15.0，仅临时目录与合成数据。`test/sessionDeletionAuthority.test.ts` 使用真正 `fork()` 的独立进程验证 gate 互斥、存活使用保护、进程死亡、符号链接父目录拒绝、旧快照迟到保存、删除后的新使用准入和幂等恢复，另覆盖 epoch、损坏路径、跨项目重复 ID、提交前/后 EACCES 故障。相关测试接入默认 runner。

独立性能脚本：先 `bun run build:test`，再 `node scripts/benchmark-history-cleanup.cjs`。脚本只建立/删除临时合成存储，没有模型客户端。本次最终实测如下；耗时为本环境观察值，不设跨设备性能阈值。

| 操作 | 数量 | 耗时 | 会话 shard 读取 | 模型请求 | 最大并发 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 只读摘要预览 | 1,000 | 1,397.13 ms | 0 | 0 | 1 |
| 只读摘要预览 | 10,000 | 10,805.77 ms | 0 | 0 | 1 |
| 存储自身回收 | 25 | 3,068.06 ms | 25 | 0 | 1 |

25 项存储回收均如实返回 removedPendingCleanup：此脚本没有运行关联 Store/Memento 回收，因此不能写为“完全清理”。其读取是最终身份校验。原始记录见 [合成基准数据](benchmarks/keepseek-history-cleanup-20261110.json)。基准不等于原生 UI 就绪耗时；UI/输入行为由 Host/Webview 回归覆盖，原生体验仍需现场验收。

逐目标进度日志另以 1,000 个合成目标、真实临时磁盘测量：最终完整回归中总写入 1,168,717 字节、5,010 次，耗时 132.06 秒。不可变计划只写一次，之后提交目标增量与小型状态，终态合并一次；这验证写入量随目标数增长，不代表耐久 fsync 很快。中断回归覆盖增量已落盘而状态尚未提交、原子临时文件残留及只恢复已确认删除身份。

Host 回归以 120 条非当前会话验证清理不逐项保存幸存会话或发布完整正文；列表失效按 250 ms 合并，当前会话草稿捕获仍立即发布。实际 Store/controller/Memento 集成回归验证当前本地会话能够完全回收，跨项目不可访问旧来源保持真实待处理分类，且旧快照无法重新写回删除 ID。

## 最终验证记录

2026-11-10，基线 HEAD `c98c651078b73e1290f8f3cbc753bb369d124900`，开发改动保留在工作树。最终统一验证如下：

| 命令 | 实际结果 |
| --- | --- |
| `bun run compile` | 通过 |
| `bun run lint` | 通过 |
| `bun run build:test` | 通过 |
| `bun run test` | 1,471 项：1,470 通过、0 失败、1 跳过；耗时 903.56 秒 |
| `git diff --check` | 通过 |

唯一跳过项为既有网络故障服务器测试：当前沙箱不允许绑定本地监听端口，未把它记为通过。完整测试包含真实独立子进程竞争、提交前/后 I/O 故障、会话与关联 Store 回收、旧快照/标题/账本/子代理迟到写入、共享资源保留、真实 controller/Memento 集成、1,000 目标耐久日志，以及三协议请求/回放与既有功能回归。原生模态确认由 Host stub 拦截验证，界面由 DOM harness 验证；两者均不代表原生 VS Code 已现场通过。

全部测试只使用临时项目、临时存储和合成会话。未删除用户真实历史，未提交、打标签、推送、发布、打包或安装扩展。

## 现场验收与能力限制

原生 VS Code UI、Windows/Linux、远程 URI、多平台账号配置为待现场验证；stub/DOM 测试不代表原生通过。当前本地 file 存储的同版本独立进程已实测。非 file 存储继续保留原有发送/保存能力，但本功能不能证明跨进程互斥，清理返回不可用。旧版本并行写入者不遵守新 gate/use/tombstone 协议，不能承诺跨版本安全；已知 legacy writer 锁和未知所有权保守跳过。用户应关闭旧版本窗口后使用本功能，不创建长期项目 owner 或只读窗口模式。

现场使用临时测试项目/独立测试扩展存储，至少验证：

1. 深浅主题及小窗口打开历史设置，默认当前项目/3 天；切换范围、天数、全部选项，旧预览不覆盖新选择；0 候选不能点击清理。
2. 收藏、当前空闲、正在运行及另一个窗口使用的会话混合预览；确认模态展示范围、截止时区、数量和不可逆说明；ESC/取消后历史不变。
3. 清理期间关闭重开，看到原操作真实进度/结果；部分故障不显示全部成功；再次清理重新默认。
4. 删除当前空闲会话后保留输入草稿并立即可编辑；模型/账号条件满足时正常发送，不恢复旧历史，不长时间显示加载会话。
5. Tab 焦点、ESC 返回焦点、读屏进度、中英文和 Ctrl/Cmd+Enter 原有保存行为；快捷键不能触发删除。
6. 两个同版本宿主窗口验证使用保护与删除后旧窗口发送/Apply 拒绝；关闭并重启只恢复已经提交的意图，不恢复审批/permit/运行队列。
