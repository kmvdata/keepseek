# P1 现场验收、慢点诊断与 P2 决策

2026-11-02，Asia/Shanghai。本阶段完成了当前环境可执行的核验、回归、离线复测与最小诊断，**未完成新 V11 的真实模型/完整 UI/长期使用验收**。不建议立即开展深度 P2。

两个原始问题的当前答案：

- **子代理少**：本轮审计的 21 个历史 child、6 个父会话，123 次物理尝试和 123 次 usage 全部对账；不存在这批记录“调用了却没统计”的证据。现场活跃会话确为 **V10**，请求 schema 精确匹配 V10，没有 V11 的 `keepseek_delegation_checkpoint`。它不能检验 P1 提前评估是否生效。其它任务究竟合理留主、模型未采纳还是门禁拒绝，仍须新 V11 有限样本的实际事件，不能根据绝对调用率判断。
- **后期慢**：一个真实活跃任务的固定观测快照中，墙钟区间 **2,050.64 s**，保存区间并集 **2,003.19 s**，已完成 Provider 区间并集 **56.95 s**，二者重叠 **34.80 s**。该样本主要慢在保存路径。它同时仍写 V3 存储、没有当前源码的 encoding 埋点，宿主精确加载字节未确认；不能把这组慢点归因于当前 P1，更不能断言所有长任务都相同。

## 基线、改动及证据等级

HEAD `be8ae39665a3e1fbed6cf288480cae88a2fbb2c9`，前序 P0 `f313a00`。起始工作区仅 `.vscode/settings.json`、`CHANGELOG.md`、`package.json` 三处用户改动。版本 0.5.0、thinking=true 均保留；settings 和 CHANGELOG 的最终 hash 与起始相同。package.json 本轮仅额外注册一条双语诊断命令，保留用户的版本修改。

本轮未提交、推送、发布、重装扩展、切换来源/审批模式或修改用户全局设置，未改写/迁移日常会话。未提高输出、并发、深度、预算或超时。实际全局网络超时为 28,800,000 ms，child 有效执行上限 300,000 ms；验收脚本额外采用更短的停止条件，不改这些配置。

| 等级 | 本报告含义 |
| --- | --- |
| A | 当前源码证明的行为 |
| B | 本轮真正执行的自动测试/离线基准；VS Code API stub 与 mock SSE 明示 |
| C | 真实 KeepSeek AgentLoop / Provider 链路；必须另辨别只发起传输、收到响应或真正完成任务 |
| D | 本轮实际扩展 UI/宿主现场操作；只观察到已有忙碌窗口，不等于新 UI 通过 |
| E | 既有日常使用记录的本轮只读复核，不是重新执行 |
| F | 未验证或受阻 |

脱敏机器证据（每份有界，无密钥/私人消息正文）：

- [构建、配置、命令、模型冒烟及样本状态](benchmarks/keepseek-field-validation-20261102.json)：起始文件 hash、最终源码集合 hash、关键 out hash、实际模型/配置、失败尝试身份及分级。
- [历史对账和现场性能快照](benchmarks/keepseek-field-record-audit-20261102.json)：child/parent/request-attempt 关联、summary/ledger 数字、首个请求 schema hash、perf 文件尺寸/hash、观测截止时间。
- [本轮离线原始测量和对照](benchmarks/keepseek-field-benchmarks-20261102.json)：P0/P1 同工作量、reader、独立全文采纳校验、三协议投影。
- [独立人工清单和逐任务 JSON 模板](keepseek-p1-field-checklist.md)：可直接执行的目标、停止条件、语义检查与未知值规则。

## A：实际运行对象核验

| 链条 | 状态 | 证据与边界 |
| --- | --- | --- |
| 仓库/提交/用户差异 | 已确认 A/B | 当前 KeepSeek 仓库、上述 HEAD；脏树有文件 hash，不用 SHA 单独代表构建。 |
| 初始 out 与普通安装 | 已确认 B | delegation.js、providerRequestProjection.js、subagents/runtime.js 三个文件，初始 hash 分别一致；普通安装目录名仍 0.3.9，不能据此断言包旧。 |
| 本轮编译 | 已确认 B | compile/build:test 成功；最终关键 out hash 与源码集合 hash 已保存。新增诊断尚未进入普通安装。 |
| VSIX | 未使用 F | 没有为验收构建/安装 VSIX；没有运行 reinstall:vsix。 |
| 活跃扩展宿主加载位置/字节 | 部分确认 D/E/F | 现场为 Code 的 keepseek 窗口；exthost 日志记 2026-10-31 23:33:45 激活、pid 24869。没有该旧宿主的激活构建身份，不能证明精确内存字节或排除其它 profile/宿主。 |
| 活跃会话协议 | 已确认 E | session `0734f10e-ea0a-4b7a-90bf-ab392dec651d` 的已校验 header 为 request/tool V10；存储 manifest 为 V3，观测 revision 356。 |
| 活跃实际请求 | 已确认 C/E | run `987040fb-3621-44a6-8ebe-cd025f1071d7` 首次请求 26 工具，schema hash `9289fe9aedf8e148c6f8a520787166ba3ed584ed91a5d3de0fed6621709858cc`，只匹配当前冻结 V10 定义；max_tokens=393192。 |
| 新 V11 会话/真实模型 | 受阻 C/F | 隔离 AgentLoop 冒烟使用 V11 与生产账号解析，DNS `ENOTFOUND`，未收到 Provider 响应。不能证明新会话 UI、自然分工或语义完成。 |
| 隔离 Extension Host/UI | 受阻 D/F | 已尝试独立 user-data/extensions 目录与 extensionDevelopmentPath；进程报告 `task_name_for_pid: (os/kern) failure (5)`，未观察到新窗口或隔离日志。没有干扰日常任务或扩大权限重试。 |

V10 热会话冻结本身是设计，不是 bug。V3 持续写入、缺少 `checkpoint_encoding`、旧激活时间共同支持“宿主尚未加载当前 P0/P1 字节”的判断，但这是有证据的推断，精确加载身份仍未知。应先在任务安全结束后核实重载与新会话，而非修改调度器。

新增最小诊断：

- [`captureRuntimeIdentity()`](../src/shared/runtimeIdentity.ts#L12) 每次激活只计算四个磁盘文件 hash 和执行中的协议函数 schema hash，保存 activationId、路径、mode、版本、pid、remoteName。没有每轮全库扫描。
- [`activate()`](../src/extension.ts#L14) 初始化一次；`keepseek.showRuntimeDiagnostics` 打开本地 JSON 诊断。中英文命令名在同一 contribution，无新 Webview 消息/持久化结构。
- [`InteractionTraceLogService.attachRuntimeIdentity()`](../src/agent/logging/interactionTrace.ts#L75) 在启用日志的 trace 头写 `run_runtime`；perf 仅白名单标量。Runner `run_start` 额外记录**该次** requestProtocolVersion，与宿主支持版本分开。
- 磁盘 hash 明确只是激活时快照，不声称是 V8 内存 hash；后改磁盘不会回写身份。不向 prompt/history/schema 注入诊断，不提高协议版本，不新增模型调用。无需 normalize/migration：这些是宿主瞬态身份与可选 trace 字段。

## B：任务、物理调用与用量对账

| 父 session 后缀 | child 数 | 终态 summary 尝试/usage | ledger 尝试/usage | 结果 |
| --- | ---: | ---: | ---: | --- |
| 9f745b0e | 3 | 17 / 17 | 17 / 17 | 一致 |
| 86027512 | 1 | 7 / 7 | 7 / 7 | 一致 |
| 96330d83 | 4 | 21 / 21 | 21 / 21 | 一致 |
| 20920122 | 2 | 15 / 15 | 15 / 15 | 一致 |
| 408198b0 | 4 | 23 / 23 | 23 / 23 | 一致 |
| e39b15b5 | 7 | 40 / 40 | 40 / 40 | 一致 |
| 合计 | 21 | 123 / 123 | 123 / 123 | 20 completed、1 failed；无损坏 bucket/index |

这些历史记录尚无新 subagentId 字段，但 123 条都有 conversationId，均能一对一归属现有 child；逐 child 计数也一致。合计上游实际 tokens 2,528,516。completed 是生命周期，不保证 complete/格式通过/父 adopt。旧记录缺少的 P1 状态保持未知，不补造候选评估、语义验收或复用。

| 对象 | 权威与总计规则 |
| --- | --- |
| 候选评估 | DelegationTracker / TaskPlan；旧 V10 无此工具时是不可观测，不是零候选。 |
| 委派调用/批次 | 根消息工具 call ID；一次 parallel 可创建多个 child，拒绝也可能有调用事件。 |
| child 任务 | child store 稳定 ID；新执行、continuation、result reuse 分开。复用不生成物理请求。 |
| 物理尝试/usage | UsageLedgerStore 的 requestId + attemptIndex 去重，attempt 可升级 usage；无 usage 保持未知。进入传输不保证服务端收到。 |
| 角色与用途 | 任务 review 是 subagent + review profile；无工具审批 reviewer 独立。child 内调用根归属仍为 subagent；如 cacheObservation 保留摘要等用途，只作切片，不把同一物理身份再加进总计。 |
| token/费用 | 父输入、child 输入、全任务累计输入分开；cacheHit 不等于省下总 token。真实费用依赖上游 usage/价格快照，参考费用仅显示估算，不进入真实预算。该批不从 token 补造实际费用。 |
| UI | usage/script.ts 的 `createSubagentAnalysisDetails()` 与分角色卡展示任务/attempt/usage/复用/未报告；本轮有源码和 UI 合同回归，无新 UI 视觉通过结论。 |

依据：`usageLedgerStore.ts::recordIdentity/appendMany`、`usageLedger.ts::summarizeUsageLedger`、`runtime.ts::recordChildLedger/restoreUsage`、`subagentUsageStats.ts`。本轮回归覆盖失败/超时/取消/no-usage、重试、重复事件、父回调前恢复、账本升级、共享预算和嵌套只归集一次。

“没有调用”须有对应 run 工具/ledger 记录；“被门禁拒绝”须有真实 host rejection；“模型留主”须有明确评估或局部任务证据；“显示缺失”须源记录与 UI 对照。本轮未发现可证明的显示漏计，不能据此宣布所有历史/UI 都无缺陷。

## C：实际样本、回归与未完成部分

12 个代表性目标/验收点已整理为独立清单及模板。真正执行状况在 validation JSON 逐项列明：S01 为真实传输失败；S09 为既有现场记录；S07/S08/S12 等有离线合同覆盖；S02–S06 的新真实自然/显式分工未执行。S10/S11 长任务目标待正常工作观察，没有人工空转、修改阈值或制造重复读取。

有效 S01：sourceId `f8e9db79-b30c-4ed9-b9e2-ef97d8680d5e`，qwencloud / Chat Completions，model `deepseek-v4.1-flash-1017`，上下文 1,024,000，输出 393,192，thinking=true/high。session `field-e43d6e26-e8fc-4f9b-9741-c57c9e375542`、task `d02fe6e9-08d7-4ad5-9411-a048d9c1e037`、request `69b5a3c5-455d-4d05-8cf4-92d5d8bce54d` / attempt 0。约 393.53 ms 后 DNS 失败，账本 1 attempt、0 usage，actualTokens/actualCost=null。追踪关闭时没有可用的新 trace runId，不伪造它；session/task/request 身份足以关联临时 checkpoint 与 ledger。

首次 harness 设置路径漏读全局配置时也发起过一次 DNS 失败的预检，未作为合格样本；已修正路径，核实实际 8 小时网络超时后只复核一次。本轮合计 **2 次新传输尝试、0 个 Provider 响应、0 个 usage 响应、0 个新 child**，随后停止。错误不能归因为账号无效，也不能假定账单为零。凭据始终经 accountResolver 在内存解析，没有写入脚本/配置/报告。

| 本轮命令 | 结果 |
| --- | --- |
| `bun run compile` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run build:test` | exit 0 |
| `bun run test` | exit 0；830 项，829 pass / 0 fail / 1 skip；145985 ms |
| `node --test scripts/field-acceptance-audit.test.cjs` | 2 pass；重叠区间、缺失计数、legacy identity 和不泄漏正文 |
| 三个新增脚本 `node --check` | exit 0 |
| 基线独立构建、P0 两版基准、compare、reader、全文采纳、三协议 delegation | exit 0；均离线 |
| `git diff --check` | exit 0 |

全量唯一跳过为本地 HTTP 故障服务，沙箱禁止 bind。三协议 payload/replay、冻结 V1–V10、V11、profile/capsule、只读/proposal、依赖门禁、partial/failed/超限、分页 UTF-8/零容量/篡改、父验收绑定及 supersede、预算/permit/恢复、压缩失败/保护集/Epoch/no-progress 等实际进入本轮回归。SSE/固定结论只能证明合同，不能证明模型语义质量。`eval:agent:live` 重新核实仍为 V3 + executeFixture + 环境变量构造来源，没有用它冒充验收。

## D：耗时归因和上下文净收益

S09 观测截止 **2026-11-02 03:10:57 +08:00**，不是任务终态。perf index 无 droppedEvents/writeFailures；按 seq 去重读取到 1207，部分 segment 已轮换但该快照仍有起始事件。日常任务活跃，数据为非原子只读快照。

| 指标 | 本轮观测 | 口径与限制 |
| --- | ---: | --- |
| 墙钟观测区间 | 2050.64 s | run_start 至最后观测事件，未结束。 |
| checkpoint_store 区间并集 | 2003.19 s | 176 次，单次 3.34–40.79 s；不是“墙钟减 Provider”。 |
| checkpoint_save 回调 | 单次 4.00–56.54 s | 包含等待 store/队列，不能再加到上一行。 |
| Provider 完成尝试区间并集 | 56.95 s | 12 次尝试均已配对，和 ledger 12 usage 一致；首内容 11 次。 |
| Provider/保存重叠 | 34.80 s | 并发区间不可重复加总；未归因部分保留 unknown。 |
| 单次输入估算 | 57,502–133,750 tokens | 当前协议真实 projection 的估算；不是窗口内累计 1,051,575 输入。 |
| 上游 usage 累计 | 输入 1,051,575，输出 6,300 | 总 1,057,875；cacheHit 936,448。高命中仍可能反复带大输入。 |
| 压缩/Epoch | 未自然观察到 | 无净释放事件，不拿“没有摘要”证明摘要慢，也不声称真实 Epoch 已验收。 |
| 有效时间/用户等待/审批/分页/父采纳 | 未按该 trace 可靠拆分 | 保存 null，不补假零。event-loop 窗口最大值有 1940.91 ms；不能据此解释 40 秒保存根因。 |

该活跃宿主缺少当前源码的 `checkpoint_encoding` 节点/hash/objectIo 指标。旧 encodeMs 含异步 I/O，不是纯 CPU；当前证据能定位到保存路径，不能进一步把它全叫 JSON 编码。也没有新 V11 证据支持“父验收慢”“压缩无净收益”或“模型 token/s 低”是本例根因。

同口径离线持久化复测：原 P0 脚本、三轮、同样 durable 条件和保存数；基线 f313a00 单独 archive/编译，不切换当前仓库。构建/测试/基准串行，OS 缓存和用户已有宿主后台负载未控制，顺序为基线后当前。只报告中位数观察，不推导生产节省率/p95。

| 工作量 | f313a00 总 ms | 当前总 ms | f313a00 热 ms | 当前热 ms |
| --- | ---: | ---: | ---: | ---: |
| short | 424.06 | 496.67 | 321.16 | 318.87 |
| long / 55 checkpoints | 13468.61 | 12822.20 | 605.86 | 692.16 |
| single child | 762.13 | 718.15 | 408.73 | 470.39 |
| parallel child | 1229.69 | 1085.05 | 775.76 | 686.32 |
| ledger | 327.19 | 329.81 | 218.51 | 236.35 |

读写次数相同，single/parallel 的结果索引仍多 2,562/7,686 bytes。先前 long 总 +7.60%、热 +0.50% 没有作为稳定组合复现；本轮热保存波动不能忽略，但不足以宣称生产退化或整体提速，不据此重写存储。

独立测量父采纳：120,176-byte canonical + 4 MB synthetic private history，三轮中位数如下。使用真实 `verifyResult()`，不降低完整正文校验。

| 当前存储操作 | 读取 bytes | 耗时 ms |
| --- | ---: | ---: |
| V4 小页首次 | 27,746 | 1.104 |
| V4 页后全文核验 | 123,346 | 4.252 |
| V4 热页 | 27,746 | 1.499 |
| V4 热全文核验 | 123,346 | 4.466 |
| legacy combined 首次页 | 4,121,410 | 20.426 |
| legacy 页后全文核验 | 121,219 | 4.373 |

新 V4 采纳没有读取 private graph，但有必要的 canonical 全读成本。旧 combined 首次全量读/解析仍存在；当前局部毫秒样本不能证明它是现场数十秒慢点。未知文件系统的安全全读回退由相邻回归覆盖，没有现场跨文件系统数据。

三协议离线同任务投影再次得到 Chat 父独立累计输入 **102,353**、委派后父 **64,201**、含 child **121,189**；Responses 为 101,613 / 63,470 / 119,938；Anthropic 为 101,117 / 62,775 / 118,762。评估/验收往返和 child 输入已计入；physicalAttempts=0、actualUsage=null。它证明父压力降低可伴随全任务输入增加，不是真实账单或语义质量/提速证明。

## E：缺陷与本轮最小修复

| 现象 → 复现条件 | 根因/不确定点 | 本轮处理 | 验证/风险 |
| --- | --- | --- | --- |
| 磁盘文件一致仍不能识别活跃宿主；热会话 V10、V3 慢写 | 旧宿主没有 activation 身份；精确字节未知 | 新只读诊断命令 + trace 头 + 每次 run 的协议字段 | 新增 activation 快照/前缀不变/隐私白名单回归，compile/lint/全量通过；新命令尚无 Extension Host 现场执行证明。 |
| 架构运行时文档仍称当前 V10 | 说明落后于新会话 V11 | 更新该处说明，保留热旧兼容规则 | 文档链接检查；无协议/历史改写。 |
| 21 个历史 child 是否漏统计 | 可逐 child 和物理身份复核 | 已对账，无业务修复 | 123/123 一致；不可推广所有历史。 |
| 本例保存非常慢 | 真实观测成立，但旧宿主与当前实现不一致 | 保存证据，不改调度/阈值/配额，不强制迁移 | 先重载后同目标比较；若当前 V4 仍慢，再用节点/hash/I/O/队列埋点定点修复。 |

新增验收工具的首次全局配置路径和计数投影问题均在交付前修正；它们不冒充 KeepSeek 产品缺陷。未发现本范围可证实的安全/错误采纳/账本业务错误，因此没有为制造改动重新实施 P1。

## F：P2 决策

| 候选 | 应有触发证据 | 本轮发现 | 收益/风险 | 决策 | 下一验收门槛 |
| --- | --- | --- | --- | --- | --- |
| 独立摘要模型 | 摘要时间/费用显著且保真可检验 | 活跃样本无自然摘要/Epoch，无法归因 | 可能分担摘要；也会重传材料、窗口更小/缓存冷、质量下降 | 暂不需要开发 | 至少两个新构建真实目标确认摘要为主要成本；后续方案须默认跟主模型、显式来源/模型选择、统一 resolver、失败回退、用户输出配置/共享预算、保真验收。若保护集/投影导致净释放差先修它。 |
| 更强委派策略 | 合格独立支线持续漏评估、显式落实差或父验收遗漏 | 现场是 V10；新模型样本受 DNS 阻塞 | 针对性提示/门禁可改善；常驻路由/强分派会增加往返 | 先核实加载，继续观察 | S02–S06 新 V11 的声明/实际返回/host拒绝/父验收对照；小任务留主允许，不以比例为目标。 |
| 大结果交付 | result_too_large 的真实发生率与重查成本明显 | 源码/离线已确认超限变 partial；本轮无发生率 | 有界存储/分块可能减少重查；放宽配额可能破坏父准入 | 继续观察 | 连续真实任务记录缺失/重复调查成本；先收窄任务与组织结论。未保留超限原文不能声称 resultRef 可读。 |
| 旧布局首次读取/迁移 | 旧读/恢复占关键路径主要成本 | combined 首次仍全读约 4.12 MB/20 ms；非现场主因证据 | 可减首次读；迁移与FS/hash风险较高 | 暂缓 | 同任务当前 trace 显示此阶段主导后才试流式/可恢复迁移；保留 UTF-8/hash/scope/未知FS回退，不批改真实数据。 |
| 大账本/缓存诊断增量 | 实际规模增长导致读/聚合主导 | 123 次历史对账正常；旧场景已有增量路径，10k 回归通过 | 可减热点；全面重写增加去重/恢复风险 | 暂不需要 | 新构建实际大账本测得明显成本；保留 no-usage、终态屏障、恢复与去重。 |
| P1 协调/全文采纳/存储 | 同口径持续往返/全文核验或冷启动异常 | 必要全文核验约4ms；三轮热保存波动，无稳定生产退化 | 消除重复工作可能有益；削弱采纳校验不可接受 | 继续观察，若成立先局部小修 | 新宿主下同目标记录父验收次数、实际全文 bytes、queue/flush、hash/I/O；必要成本与重复工作分开。 |

优先下一步只有三件：确认重载后的构建身份与新 V11；跑一个简单任务和一次 `/research`，通过后再做自然多模块调查；在正常工作中积累两三个有业务目标的长任务记录。出现错误采纳、越权副作用、完成工具重跑或恢复重复账单须立即反馈，不等待观察期。无需让本 AI Session 空等数天。
