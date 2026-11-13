# P1：子代理继承、结果交付与父验收

2026-11-01（Asia/Shanghai）。起点 `f313a00` / 0.3.9，最初工作区干净。本次保留 P0 持久化、用量账本、共享预算、审批和副作用边界；未安装、发布、提交或推送扩展，未修改真实账号或真实会话。

## 行为与验收边界

| 工作线 | 改动与源码权威 | 自动验证 | 现场状态 |
| --- | --- | --- | --- |
| A 受控继承 | `subagents/contextCapsule.ts` 的 V1 宿主投影只含适用项目指令、已激活 profile 身份/内容、稳定 workspace 和精确外部授权；`runtime.ts` 构建独立 child 请求与兼容 hash | `p1SubagentInheritance.test.ts` 使用真实 KeepSeek AgentLoop、临时磁盘和模拟 SSE，走一级/二级、自定义 profile、项目约束、候选登记、委派及父验收；检查父历史、附件、其它 Skill 正文不进入 child Provider 请求 | 未做真实账号、F5 或真实工作区恢复 |
| B 结果与分页 | `resultEnvelope.ts` 接受结构与绑定；`resultIndex.ts` 提交独立 canonical chunks；`store.ts` 按范围验证读取并全量核验父验收正文 | `subagentSafety`、`p1SubagentResultReader` 覆盖 JSON/绑定/大小/partial/failed、损坏/缺失 chunk、UTF-8/EOF/offset、旧布局与引用循环；`p1ProtocolDelivery` 检查实际模拟 Provider 请求正文 | 无真实 Provider 流量或真实旧数据迁移 |
| C 提前评估 | V11 `keepseek_delegation_checkpoint`、`delegation.ts` 和 Runner；候选、依赖、能力声明与父验收持久化至既有 TaskPlan/checkpoint | `p1Delegation.test.ts` 覆盖小任务留主、独立候选、同批依赖/循环拒绝、真实 runtime/store 接线、显式未落实、缺失/partial 阻塞 | 模型会否主动采纳提示是概率行为，尚未现场观测 |
| D 紧凑交付 | V3 单/批清单保留 summary、完成程度、格式、ref 和父待验收标记；按真实 UTF-8/JSON escaping 总预算分配；父只按需读页 | handoff/cache-family、delegation、Run Details、四种 Provider 路径的交付测试；离线同任务对照 | 不以离线 token 估算冒充真实效率或质量改善 |

宿主检查能证明已声明合同、路径/权限、绑定、结构和存储完整性；不能证明任务语义独立或结论正确。证据与验证报告均为模型报告，父模型须结合真实工具结果或实际验证判断。任务 review 的 verdict 不等于副作用审批。

关键源码入口（行号对应本次交付，后续按函数定位）：

- `src/agent/subagents/contextCapsule.ts:21` / `:46`：创建和严格 normalize；`runtime.ts:330`：受控继承、profile 与权限预检。
- `src/agent/subagents/resultEnvelope.ts:74` / `:209`：结果接受与合法大小投影；`handoff.ts`：V2/V3 有界单/批清单。
- `src/agent/subagents/store.ts:198` / `:258`：分页与完整正文验收；`resultIndex.ts:61`：索引校验；`runtime.ts` 的 `saveTerminal()`：终态提交屏障。
- `src/agent/evidence/subagentPage.ts:6`：真实准入后的正文与游标；`contextEpoch.ts` 的 `visibleProgressFingerprint()`：忽略纯 ID、复用计费元数据变化。
- `src/agent/delegation.ts:43` / `:175`：候选与父验收；`protocol.ts:1174`：V11 工具合同；`providerRequestProjection.ts:37`：协议边界。
- `src/agent/logging/subagentDetails.ts:4`：有界 UI 投影；`runDetails.ts`、`webview/script.ts` 与 `shared/i18n.ts`：运行详情、中英文及替代关系。

## 版本、缓存与恢复

| 维度 | 新版本 | 兼容规则 |
| --- | --- | --- |
| 主请求 / 新 child 协议及工具 schema | 11 | V1–V10 system/full/slim 工具 SHA256 由隔离 `f313a00` 构建生成 fixture；新会话或已有受控冷边界进入 V11，旧热会话不改写历史或工具集合；V10 不降成 V9 |
| canonical 结果合同 | 2 | 保留原 common/research/review/proposal，增加有界 coverage/missing/verification/nextSteps；旧合同仍可审计读取 |
| 父交付清单 | 3 | V11 才使用新状态合同；V2 读取保留。旧父收到新 partial 时保守 `ok:false`，避免将未完成批次当成功合并 |
| 宿主 capsule | 1 | 严格字段投影/hash/4 MiB 上限；不传 sourceConfig、API 凭据、permit、父历史或可变运行对象。模型只收到当前选中 profile 和必要规则 |
| 结果 reader 索引 | 1 | 放在 V4 state 的 summary 中，受 summaryHash 约束；正文对象在 state 切换前 durable 提交 |
| 委派 / 父验收状态 | 1 | TaskPlan normalize/checkpoint 持久化；有界活动窗口、结果和事件，已采纳窗口可滚动，不重置树级预算 |
| P0 存储 | 仍为 V4 | 不重写框架，保留 V2/V3/V4 父会话与旧 child combined/split/state 审计读取；`CoalescedWriter`、终态屏障和低开销统计继续使用 |

项目、profile、schema、workspace、外部授权和模型来源进入兼容身份。新 child 继承宿主 capsule，但不将全部可用 profile 正文发送给每个模型。相同内容稳定排序，随机 child ID 不进入共享前缀身份。二级仍 `nested-read`、不能再委派，能力取 profile、lane、深度、计划模式及宿主白名单交集。

旧 child 缺 capsule 证明、hash 不兼容、正文/索引损坏时保留审计可读，拒绝执行恢复/continuation/reuse；不自动重跑。续接仅装回对应 child 自己的历史。完成结果复用仍要求 complete、兼容身份和可证明 freshness，广泛搜索未形成闭合 read set 不扩大复用。

## 结果、上限与引用语义

四项事实分开：生命周期 `completed/failed/stopped`；`formatAccepted`；`resultStatus=complete/partial/failed`；父 `adopt/needs_details/investigate/reject`。V3 `ok:true` 表示宿主接受非 failed 资料（可为 partial），不能证明父目标完成；合法 failed 可 `formatAccepted:true` 但 `ok:false`，证据仍可读。P0 completed 统计继续表示运行终态，不改成业务完成次数。

profile 的 `resultMaxChars` 是 canonical 交付硬约束，不是模型输出 token 预算，也不是父 preview 上限。超限结果转换为合法有界 partial，明确 `missing: result_too_large`；不再切 JSON 尾部追加文本。未接受的原始完整正文不提供可读 ref，也不声称仍可恢复。宿主另设 2 MiB canonical 安全上限，超过则拒绝接受；用量保留。合法 failed 报告可保留 bounded canonical、标 failed；损坏原文不作为成功 canonical。

- `resultHash/resultChars/resultBytes`：最终实际可读 canonical 正文 SHA256、UTF-16 字符长度和 UTF-8 字节长度。
- `originalResultHash/originalResultChars`：结构接受并 normalize 后、profile 投影之前的序列化 JSON；不是模型原始 raw text，也不是仍可读取正文的承诺。新格式的被拒绝 raw 输出没有已接受 original，这两项省略，诊断引用另行保存；旧记录保留其原含义。
- `resultTruncated`：profile 完整交付未获接受，新合同的可读正文是合法 partial；旧截断数据明确不可恢复，不伪造完整 JSON。
- `preview`：canonical 前部的有界预览，summary 单独保存；缩减后重算 `hasMore`，预览不是语义精选或完整结果。
- `resultRef`：只读 canonical child 结果。`evidenceRef`：读取该次工具交付的不可变快照。两者不能互相代替。

parallel 按输入顺序组织，在默认 20,480 UTF-8 字节总预算内先保留状态/ref，再公平分配摘要及预览，包含 JSON escaping 开销。partial、failed、损坏结果或提案冲突阻止整个 proposal 批次合并，成功的只读兄弟仍可分页。`failFast` 仍为 reserved flag，没有新增取消调度系统。

只有允许的格式错误进入最多一次无工具修复；taskHash 错配、缺少事实/实际产物、越权和资源超限不能借修复绕过。修复仍计入真实用量、共享时间与费用预算。child 内部存在未验收委派时，最终自报 complete 会降为 partial，不新增隐藏模型轮。

## 分页与读取成本

新记录使用独立、内容寻址的 UTF-8 chunks，每块最多 24,576 字节。每页只加载 state summary 和覆盖该范围的块，并重新核对长度/hash/UTF-8；不解码私有 messages/checkpoint。默认页 12,288、最大页 24,576 字节。父采纳前的 `verifyResult` 有意读取完整 canonical 并校验整体 hash；它不读取 private trace，这个成本与普通小页不同。

旧 state 使用对象图字段投影，每次核验必要对象及完整 canonical 字符串，不展开兄弟 transcript/checkpoint。旧 combined/split 首次仍需读/解析其布局；file URI 的已验证结果及绑定原始字节范围进入 scope 与源身份隔离的有界缓存（8 项、4 MiB），热读重新校验相关原始字节范围，不能靠未变化的 stat 掩盖正文损坏。非 file provider 没有范围 API 时安全全读；旧布局成本单独列在 reader benchmark，未宣称旧 combined 全面流式化。新权威损坏不回退旧文件。引用链有上限、循环检测与 session/来源任务/hash 复核。

分页经 evidence/admission 后只交付实际可容纳前缀，游标只跨过真正进入请求的原始字节；容量为零返回 `subagent_result_capacity_blocked`、`bodyDelivered:false` 和原 offset。不会生成新的 evidence 引用替代未交付正文。重复页以 canonical hash、范围和正文识别，不因换 ref 视为新进展。活跃 pending 继续等待真实宿主事件且可取消。

## 委派和父验收

初始计划及有证据的范围扩大时，模型使用 assess 简短登记判断；普通小任务可直接本地完成。候选合同包括目标、范围、必要输入、依赖、能力和验收标准。主模型保留目标、硬约束、架构取舍、审批及综合，child 处理适合隔离的大量中间调查。

宿主拒绝同批依赖、循环、未获父采纳的前置结果、不兼容 profile、未声明 proposal 能力、越界路径和原有预算/权限失败。显式 `/research`、`/review`、`/proposal`、`/parallel` 仍由真实 user-tail 进入，不复制父聊天、不改变审批模式。没有匹配实际返回时记录“显式委派未落实”，不推测预算或权限原因。宿主观察的多路径事件仅表示请求范围，不宣称已经取得正文。

父侧先看摘要与缺失项，必要时读指定页或定点复核，再记录验收。adopt 绑定当前父计划真正返回的 child ID/hash，并要求完整正文通过存储核验、格式获接受、完成程度 complete。尚未返回的候选可用有理由的 local 判断撤销；已返回结果仍需处理。同候选的完整补查结果通过真实核验及父采纳后，可用受校验的 `supersededBy` 解除旧 partial 的活跃阻塞；旧状态与审计不删改。未验收支线不会直接完成相关计划。新分页显示当前父计划验收状态，已交付的旧清单仍保持原字节。父采纳不等于 Apply 或执行命令；待确认提案继续进入既有审批管线。

每个评估最多 8 个候选，活动窗口最多 16 个结果、32 个事件；已全部采纳的窗口可在范围扩大后滚动，完整工具审计仍保留。没有每轮额外 router/reviewer，也没有提高并发、深度、超时或 token 配额。

## 验证与性能证据

最终正式检查如下。测试和 benchmark 均使用临时目录、真实文件系统及 VS Code stub；SSE 是确定性模拟，不能证明真实模型选择概率或语义质量。

| 实际执行命令 | 最终退出状态 | 结果 |
| --- | ---: | --- |
| `bun run compile` | 0 | 正式源码 TypeScript 构建 |
| `bun run lint` | 0 | `src/` ESLint |
| `bun run build:test` | 0 | 全部测试构建 |
| `bun run test` | 0 | 829 项：828 通过、0 失败、1 跳过；15 suites；133.142 秒 |
| `git diff --check` | 0 | 补丁格式检查 |
| 三个新增 benchmark/compare 脚本 `node --check` | 0 | 脚本语法 |
| 原 P0 脚本，两版各 3 轮及比较脚本 | 0 | 相同 durable 条件和工作量 |
| reader 脚本，两版同场景 | 0 | 同量实际正文交付 |
| 离线分工对照脚本 | 0 | 包含评估/验收协调成本的三协议投影 |

跳过项仍是本地 HTTP 故障服务端口测试：沙箱不允许 bind；其它模拟传输、三协议、审批/permit、恢复、P0 持久化与用量回归均进入本次全量运行。中间全量曾检出新增继承测试依赖其它测试遗留 workspace roots 的夹具问题；显式设置并恢复测试工作区后重新构建、完整复跑通过，未放宽生产权限检查。验收计数另存 `doc/benchmarks/keepseek-p1-validation-20261101.json`。

- 旧 V1–V10 协议冻结 fixture 已随 0.5.2 初始基线移除；当前仅验证 V15。
- `doc/benchmarks/keepseek-p1-p0-baseline-20261101.json`：原 P0 benchmark 在 `f313a00` 上的 3 轮重新实测，不沿用 `9a874e8` 改善率。
- `doc/benchmarks/keepseek-p1-result-reader-20261101.json`：比较小/大 canonical、相同结果加大量私有历史、冷/热/不同页/重复页与并发 child 的时间、读取对象/字节和内存口径。
- `doc/benchmarks/keepseek-p1-delegation-20261101.json`：同一源码定位任务的离线单主与委派对照。三协议使用同一投影口径，包含 child 输入及整个任务估算；真实 usage 为 null，实际 Provider 尝试为 0，不提供虚构节省比例。

原 P0 脚本重新测量，3 个样本的中位数如下（完整 min/median/max、IO、队列与内存限制见 JSON）。两版 durable 条件、工作量和保存次数一致；测试、构建及两类基准串行执行。

| 原 P0 工作量 | f313a00 总耗时 ms | P1 总耗时 ms | f313a00 热保存 ms | P1 热保存 ms |
| --- | ---: | ---: | ---: | ---: |
| short | 414.79 | 424.12 | 309.81 | 304.64 |
| long | 11555.54 | 12433.66 | 590.17 | 593.14 |
| single child | 490.06 | 481.26 | 317.04 | 313.61 |
| parallel child | 973.31 | 1009.45 | 705.12 | 676.57 |
| ledger | 271.44 | 266.70 | 205.18 | 203.15 |

所有读写次数相同，single/parallel child 分别多 2,562 / 7,686 字节索引。long 总时间观测增加 7.60%，热保存增加 0.50%；不能宣传全面提速。数据：`keepseek-p1-persistence-{current,comparison}-20261101.json`。

reader 每场景 3 个逻辑冷样本、15 个热页样本，不刷新 OS 缓存。以下每 child 均实际交付 1,023 字节；内存仅抽样差值，不是峰值或生产 p95。

| reader 场景 | f313a00 → P1 读取字节 | f313a00 → P1 耗时中位数 ms |
| --- | ---: | ---: |
| V4 state，120 KB canonical + 4 MB private，热页 | 4,132,233 → 27,764 | 27.579 → 0.820 |
| 相同场景，3 child 并发，热页合计 | 12,396,699 → 83,292 | 84.090 → 1.534 |
| 1 KB canonical、无 private，冷页 | 3,250 → 4,893 | 1.243 → 1.363 |
| legacy combined，120 KB + 4 MB private，首次 | 4,131,228 → 4,131,228 | 11.136 → 23.497 |
| 相同 legacy，热页 | 4,131,228 → 131,042 | 12.477 → 2.231 |

新 state 页不加载 private graph；旧布局首次仍更慢。父验收全量正文校验另计，不用这些小页数字冒充验收成本。

离线同源码任务 A 为父独立调查 3 模块并定点核对；B 为候选评估、3 独立 child、父定点核对及 3 次采纳，评估/采纳参数与往返均计入投影。A/B 父均 5 个 scripted 请求投影，B 另有每 child 2 个。这个短定位任务不适合据此宣称委派更省，结果恰好体现协调成本：

| 同口径估算输入 tokens | A 父及任务合计 | B 父 | B 含 child 任务合计 |
| --- | ---: | ---: | ---: |
| Chat Completions | 102,353 | 64,201 | 121,189 |
| Responses | 101,613 | 63,470 | 119,938 |
| Anthropic | 101,117 | 62,775 | 118,762 |

父工具正文 A 为 61,467 字节，B 为 5,023 字节（其中 manifest 3,972）；本例 canonical 小，无追加分页。B 三个采纳均走真实 store 校验与 tracker 绑定，但结论是确定性脚本给定，非真实模型语义验收。三处 source hash/声明行核对一致；没有摘要或额外调查，Provider 时间为零、等待为零仅表示离线没有这些工作。真实模型会否增加修订/调查及整个任务实际费用、质量，仍需现场实验。

单次网络超时 `modelRequestTimeoutSeconds`、child 有效执行上限 `agent.subagentMaxExecutionMs`（默认 5 分钟）、根逻辑任务共享预算是不同约束，均未在本次提高。

待现场验证：真实 Provider 是否采纳提前分工、真实长任务的完成质量与端到端区间/用量、F5 首次 ready/交互焦点与详情展示、真实旧会话迁移/停止重启。本轮未使用真实账号或启动扩展调试宿主；这些项目尚未执行，不把自动测试或平台子代理的成功当作现场验收，也不推测未经检查的环境或凭据故障。
