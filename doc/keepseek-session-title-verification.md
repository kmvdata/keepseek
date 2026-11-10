# 会话标题生成与验收

当前合同校准：2026-11-10（Asia/Shanghai），开发起点 `e352508fbb1c7ae33eaf0c877d34638198d8339d`（0.5.2）。本页描述首次有效命名后永久停止、手动最多最近两轮的当前行为；文末旧版本数字只证明对应历史基线。标题默认开启，不增加开关或主会话工具。

## 自动命名与完成边界

一次真实用户输入及其最终可见助手回答是一轮；审批、命令、工具、修复和自动续跑属于原轮的执行段。Host 只从真实 `AgentResponse` 登记完成候选，正文跨过持久化屏障后才设为 durable；在前台操作拥有者正确释放后独立 drain，不以 `scheduleDraftRunAutoContinuation()` 是否准入为前提。项目指令/Skills 错误、`requestContextReady=false` 或无关交互失败，不否决依赖齐全的 durable 候选；会话/存储初始化、信任、身份、模型/凭据与预算仍须核验。

完整回答与工程执行成功分别判断。具体澄清、完整方案和等待用户 Apply 的完整草案可命名，标题不得虚构代码已应用或命令已成功。流式片段、原始错误、仅工具输出、取消的未完成回答及仍须自动续跑的中间段不可命名。可恢复的等待保留候选，取消/失败且不可能形成完整回答的终态退休，避免反复扫描终态。

每个会话按观察到的完成顺序串行处理候选，以真实 task/origin 去重。候选保存身份、最终消息引用与执行段来源/模型，不复制正文或凭据；队列持有目标会话的临时驻留引用，终态/清空时释放，避免历史压缩淘汰未消费目标。同一真实轮的后续执行段更新其最终回答，不增加轮次；尚未取得槽位的 busy 不算消费。第一轮 defer 后可处理已排队第二轮，首次 set 提交成功立即清空其余自动候选。普通新输入不覆盖旧候选、不取消旧在途请求，也不因其不再是会话尾部而废弃。

每轮最多一次物理命名请求，同一次请求返回 set 或 defer。defer、无效、超时、来源/预算不可用和保存失败仅结束本轮；未来新真实轮仍可尝试。不得另发意义判断、格式修复、联网重试或全文摘要请求。启动、历史列表刷新、只读诊断、历史加载和重启不制造候选、不扫描全历史补发。

## 持久状态、提交与恢复

`ChatSession.autoTitle` 是唯一标题元数据权威，新写入 metadata version 2。`status` 保留 pending/running/completed，在此之外以 `stopped: named | manual` 表达永久停止，以 `attempt` / `manualAttempt` 表达独立在途；`attemptedThrough` 保存连续已消费真实 origin 的前缀游标，`attemptedTaskIds` 在正常 Host 串行路径保留最近最多 64 个身份，`lastAttemptTaskId` 保留最近认领身份，`lastOutcome` 只供诊断。旧数组兼容读取后，在下一次可核实认领时压缩；直接乱序调用 Store 时，前方尚未消费的完整轮形成稀疏缺口，相应身份保留到缺口被消费，不能为了满足上限丢弃未尝试候选。

| 状态/事件 | 后续自动请求 | 保留与恢复语义 |
| --- | --- | --- |
| 尚未成功命名 | 新的合格真实轮可尝试 | 新会话从 pending 开始；当前轮失败不锁死会话 |
| 自动 attempt 在途 | 同会话排队，不重复派发 | revision、token、session/workspace 和所选正文 ID/hash 校验提交 |
| set 与停止标记共同提交成功 | 永久停止 | 追加、切换、重启、归档、编辑重发或旧依据不可读均不解锁 |
| 手动改名，含提交相同文字 | 立即锁定自动命名 | 推进修订并退休旧请求；用户命名优先 |
| 手动刷新在途 | 退休此前自动候选与请求 | 单独的 manual attempt 不清除原标题或既有停止状态 |
| 手动刷新成功，含生成同名 | 永久停止 | 可替换自动/自定义标题；原标题与新停止状态一起提交 |
| 手动失败、defer 或保存失败 | 保持操作前的停止状态 | 保留 title/customTitle；未命名会话仅未来新轮可自动尝试 |

只有 title 与停止元数据跨过 staged commit、分片和索引 canonical commit 屏障后，公开内存标题并通知正确历史行。分片写成功但索引失败不构成成功；最多重存同一已生成候选一次，不再调用模型。通知失败不撤销已提交标题。旧保存 await、旧结果和旧 finally 只能完成/清理自己的 attempt，不能覆盖新手动操作或结束新 spinner。

标题元数据升级兼容旧 pending/running/completed 与 customTitle。旧索引须先按旧 hash 格式核验分片的真实提交，再迁移停止语义；新提交使用新格式，不能用新 hash 校验旧索引，或先因依据已归档而把旧真实 completed 丢成 pending。确认提交的旧 completed 迁移为永久停止，自定义标题迁移为用户锁定；shard-only、损坏或无可靠提交证明的数据不伪造成功。未完成 running 记录恢复为中断，保留已消费轮次，不恢复 HTTP、队列、permit 或旧 token。

复制会话保留已提交标题及停止语义，重映射会话/消息和普通根任务预算身份，保留已花额度；剔除标题手动辅助预算、去重游标/身份、在途 token 和可执行队列。截断/编辑所选正文使在途依据过期；已提交标题仍保留停止状态。普通后续追加、切换查看其他会话和非破坏性 UI 刷新不使未改动快照过期。删除、失信、workspace 变化及销毁退休对应请求，迟到 usage 继续遵守删除墓碑，不复活目标。

本次只兼容标题元数据，不批量改旧消息正文、不补旧 userTask、不改变默认空白启动或惰性读取。

## 只选一至两个真实完整轮

自动、手动和存储校验共用真实轮识别。优先使用 `userTask.id`、`originMessageId` 和 reason；legacy 无 userTask 时在真实用户边界内匹配最终可见回答，不修改旧记录。第一条用户输入和来自模型的完整草案可带缓存保护标记。displayKind/protectedReason 状态通知、自动 continuation、工具、推理和原始错误不算真实轮。

| 模式 | 末轮边界 | 可发送正文 |
| --- | --- | --- |
| 自动 | 本次 durable 完成候选的轮 | 本轮，加最多前一个完整真实轮 |
| 手动 | Host 接受操作并确认目标时的最新完整轮 | 最近一轮或最近两轮，最多四个片段 |
| 最新真实输入未答完/streaming | 材料未就绪 | busy/no_material，零模型请求；不退取更早两轮 |
| 零完整轮或脱敏后无实质内容 | no_material | 零模型请求 |

只选 `user.content` 与最终 `assistant.content`。禁止带入第三轮以前正文、首问补主题、摘要、旧标题、expandedContent、附件展开、tool/evidence/replay、隐藏推理、项目指令或 Skills；不读取归档或外部文件补主题。最近两轮含糊则 defer、保留旧标题。

先选轮再裁剪，总 JSON 预算最多 8,000 字符。各轮有有界份额，最新轮保留具体主题；超长正文作确定性首尾摘录。敏感凭据、邮箱、URL 与路径脱敏；Unicode/字素安全裁剪后复核 JSON 总长度，不截断 JSON，不用第三轮补足。相同输入与参数生成相同字节；字符上限另受真实协议 token 准入约束。

新 basis 使用 `scope: recent_turns_v2` 明确标识最近轮范围，绑定实际选中最多四条消息 ID/hash、最终回答边界及必要轮身份，不计算全会话 fingerprint。更早无关历史变化不使请求 stale；所选正文改动/删除必须拒绝。旧 whole-history basis 的 conversation hash 保留旧语义读取，不重解释为两轮 hash；legacy 两轮依据有独立匹配路径。

## 请求、来源与预算

- 使用“子代理模型 → 默认”和 `accountResolver`，不借审批 reviewer。fixed 精确匹配且不可用时不回退；follow-main 使用真实执行段可核实来源/模型，缺快照仅从可信记录恢复，无法确认记录 `source_identity_missing`，不猜当前 picker。手动在接受时冻结设置与模型身份。
- 每次一个无工具请求，一次返回严格 set/defer JSON。可容忍 BOM/空白和完整且唯一的 JSON 围栏；拒绝多对象、自然语言猜测、半截 JSON、工具调用和 reasoning 替代正文。`finishReason=length` 单列 `output_truncated`。
- 标题通常中文不超过 16 字、英文不超过 32 显示单位，必要精确专名沿用受控例外；拒绝泛化空标题、敏感内容、控制字符和虚构成功。
- 标题输出最多 512 tokens，同时受模型更小上限和剩余预算约束；自动/手动及底层 clamp 一致。标题超时统一最多 30 秒，再取用户配置、原任务剩余时间/截止期等更小限制。审批 reviewer 的 payload、上限与行为保持原合同。
- 只用已核实的来源能力关闭推理：现有 DeepSeek disabled、Qwen false 映射继续适用；未知兼容网关不盲加字段。供应商仍可能内部推理，输出与时间上限继续生效。
- 自动只恢复本轮真实 root task 的 `userTaskBudgets`/可信 checkpoint 剩余额度，缺失记录 `budget_missing`，耗尽记录 `budget_exhausted`。不得借后续任务预算、新建手动预算或用重启重发恢复额度；正费用上限不可可靠计价仍 fail-closed。
- 手动刷新是显式新辅助操作：预算先持久化，最多一次请求、零工具、上游最多 32,768 tokens，并服从更小用户限制和费用上限。不恢复旧任务 deadline、不进入主任务计时。
- 同 root task 的标题与恢复/续跑必须共用预占准入权威或串行“读最新余额→核验→持久化预占”；增量合并只处理结算，不能替代准入。结算仅释放自身 reservation，不覆盖主任务新计数或另一请求预占。
- 已发失败、超时、取消和过期请求按真实物理请求入账。source=subagent、purpose=session_title，request ID 幂等；无 usage 不编造 token，未知用量保留保守预占。辅助费用计入目标会话，不改最新主回复费用、不接管 UserTaskClock。workspace 切换后晚到用量仍按原 workspace/session 写入账本；目标已不驻留时不要求先加载正文，删除墓碑仍禁止复活。

## 反馈、诊断与主请求不变式

历史行保留编辑按钮左侧的刷新按钮、旋转和防重复点击；不恢复双击标题入口。Host 在首个 await 前占目标 requestId，所有终态释放自己的 spinner；重复同 requestId 重放状态，旧 finally 不清新操作。手动结果通过行内 `aria-live` 提示，中英文保持对应；自动失败不弹窗、不阻塞聊天。非活动会话只更新目标历史行/用量，不改变 activeSessionId、草稿或焦点。

标题能力继续由 `deriveSessionTitleCapability()` 派生，Webview 不重拼 Host 门禁或移除 disabled。runtime diagnostics 只读显示停止状态、候选/在途数量、最近原因及模型解析可用性，查看不发请求。当前标题日志只含哈希化 session/task 标识、固定 reason、elapsedMs，以及协调器已知的 mode、materialRounds、materialChars，按最近原因去重并有界保存；不记录正文、prompt、凭据、绝对路径或原始供应商错误。物理请求次数由专项测试/既有 usage 账本核对，不从日志字段或显示标题推断。

标题修改不改变 `messages`、`contextInstructions`、静态 system、冻结 tools、replay 或三协议主请求投影。持久化计时 reconciliation 使用纯投影，不为 legacy 消息回填 userTask 或改变正文；复制的身份重映射只作用于新副本。独立标题 system/材料可能利用供应商前缀缓存，不能保证复用主聊天缓存、缓存命中或节省金额；以实际 usage 为准。

## 自动化与本轮验证口径

默认入口覆盖 `sessionTitle`、`sessionTitleStorage`、`sessionTitleCompletion`、`sessionTitleRequest`、`sessionTitleRegeneration`、`oneShotTextRequest`、`sessionTitleIntegration`、`sessionTitleWebview` 及相邻预算、导航、用量和三协议字节稳定测试。受控 deferred Promise、假时钟与真实临时磁盘故障注入用于核对实际请求次数、请求材料、提交与恢复状态，不以新增函数存在代替行为。

```bash
bun run compile
bun run lint
bun run build:test
bun run test
```

受控存储回归核对连续 210 个 defer 真实轮恰有 210 次命名请求；重复投递旧轮与重启后旧轮新增 0 次，第 211 个新轮只新增 1 次。该证据同时检查消费游标与常规 64 身份后缀；乱序直接调用保留缺口、以后补消费的回归另行保护，不能把后缀上限解释为允许丢候选。

本轮运行结果以交付报告及执行输出为准。受控模型/存储测试不能证明真实供应商、原生 VS Code、远程扩展宿主或 Windows/Linux 已通过；这些现场验证仍待对应环境执行。本次不安装、发布、提交或对真实历史批量自动命名。

2026-11-10 本轮检查：compile、lint、build:test 通过；完整复跑 1,378 通过、0 失败、1 环境跳过（约 699 秒）。对并行写入后合并的截断游标，以及最终补齐的旧历史有界消费、claim 保存期间正文变化，重新编译并执行标题、存储、Completion、Host、三协议 one-shot、预算竞争、Webview、计时、截断与编辑重发专项，最终 230/230 通过（约 45 秒）。该增量复核明确区别于完整复跑的快照，不把两次计数相加。

首次全量曾为 1,369 通过、2 失败、1 跳过；两项分别是全局文件系统计数受到其他 ChangeSet fixture 的延迟 GC 干扰、10K 账本基准超过 15 秒阈值。未修改相关生产代码或放宽断言：原始 HEAD 的单独检查 2/2、自然 ChangeSet 前缀 14/14 通过；对该原始基线增加 2.2 秒 I/O 延迟可复现 GC 计数污染，目录扫描均来自其他 fixture。完整复跑中两项均通过。

交付核对又保留了并行写入的两处增量：标题拒绝只有 tool-call finish reason 而没有完整调用块的响应，协议错误归为 invalid；ChangeSet I/O 测试仅计数自己的临时根目录，并要求真实写入次数大于零，避免其他 fixture 的后台扫描污染。后者保留原有零扫描与写入上限断言，未修改生产 GC 行为。两处通过末次 compile、lint、build:test 及默认 runner 中筛选标题/one-shot/ChangeSet I/O 的 98/98 回归（约 14 秒）；末次源码哈希核对无变化。

自动化测试在替换后的 fetch 边界计数 POST，保留真实协议构造、准入、结算和恢复路径。定向测试观察到，预占落盘期间取消、或派发意图落盘失败时，POST 数为 0，其他操作已占的额度完整保留。已调用 POST 后取消且没有 usage 时，请求数为 1，账本保留未知用量。编辑重发截掉第 100 至 211 轮后，重复提交已消费的第 1 轮仍新增 0 次请求。

最终工作树通过 `bun run compile`、`bun run lint`、`bun run build:test` 与 `git diff --check`。定向验证覆盖标题、三协议请求、用量、计时和 ChangeSet，210/210 通过。全量 `bun run test` 共 1,381 项，1,380 通过、0 失败、1 跳过，耗时 536.45 秒。跳过项需要绑定本地故障服务器端口。10,000 条账本性能测试在原 15 秒上限内完成，用时 13.11 秒。Apply 热路径测试只统计本 fixture 存储目录内的 I/O，避免其他 fixture 的延迟 GC 混入计数；仍要求变更前有持久写入、最多 5 次写入、0 次目录扫描。

本机曾通过独立临时 profile、空工作区与开发扩展路径尝试启动 VS Code。进程收到 SIGABRT，未执行到激活和打开视图的测试断言。以下步骤留作原生现场验收。

## 原生验收步骤与证据

在隔离 workspace/存储中 F5，配置可用主模型和默认普通子模型。使用测试端点/代理或既有账本核对 `purpose=session_title` 的物理 POST 次数与来源身份；标题显示不变不能证明零请求。素材只采集脱敏的轮数、消息范围标识及字符数，不记录真实正文。

1. 新会话先寒暄使模型 defer，再问具体问题；首次 set 后追加至少三轮、切换会话、Reload Window、打开/刷新历史及只读诊断。保存停止状态，后续自动请求增量必须为 0。
2. 暂停第一轮标题响应，完成第二/三轮。第一轮 set 时只发 1 次并清队列；第一轮 defer、第二轮 invalid、第三轮 set 时按顺序共 3 次，重复 flush 不增。普通新轮不取消第一请求。
3. 在早期完整轮放主题 A，最后两轮放唯一主题 B 标记；手动刷新请求只含 B 两轮最多四片段。另测只有一轮、零轮、最新 streaming、含糊追问和 legacy 无 userTask；材料不足不回退 A，不带 expandedContent、工具或推理。
4. 用审批/工具/命令/修复/计划续跑组成一真实轮，最终只允许一次自动命名。完整澄清、方案与等待 Apply 草案可命名；未完流式、错误通知、中间续跑不命名。暂停 Skills 或注入无关上下文错误，durable 标题仍可派发；失信/存储未就绪不可派发。
5. 在自动请求/保存 await 期间手动改名（也提交同文本）或刷新；再放行旧返回/旧保存。旧结果不得覆盖用户意图或清新 spinner，已发用量仍记账。手动返回同标题也停止自动；失败/defer/超时/保存失败保留旧 title/customTitle 和原锁状态。
6. 分别在 claim、预算、shard、index 保存注入失败；模型至多请求一次，同候选最多重存一次。重启不把 shard-only 当成功，旧真实 committed 即使依据已归档也保持停止；分别验证旧/新 commit hash、孤儿恢复与副本身份。
7. 成功命名后编辑重发/截断旧依据、归档、重载与复制，已提交标题及停止状态保持。在途时修改所选正文则拒绝，修改更早未选中历史不使两轮快照过期。复制不带 attempt token；删除目标后不复活会话/账本。
8. fixed 不可用、follow-main 身份缺失、自动预算缺失/耗尽、正费用上限不可计价均给出稳定原因，不新建自动额度。相同 root task 余额只够一次时并发标题/续跑，真实 POST 最多 1 次；取消/无 usage 不释放他人消耗。
9. 逐一验证 Chat Completions/Responses/Anthropic：512 输出/30 秒上限及更小限制，无 tools/父历史、不采 reasoning，完整唯一围栏 JSON 可用，多对象/半截/length 不可用；审批 reviewer payload 与主聊天投影字节不变。
10. 非活动历史行点击、重复 requestId、SVG/键盘触发、关闭重开列表/Webview，确认旋转与终态归属准确，activeSessionId、草稿、焦点、输入能力和主任务计时保持正确。真实供应商缓存仅按返回 usage 验证。

## 历史证据（不替代当前合同）

以下结果保留原基线与日期，仅描述当时运行。旧版“新输入取消”“依据截断回 pending”“手动全历史/32,000 字符”“256 tokens/20 秒”已经被本页当前合同替代，不能作为本轮验收依据。

| 历史阶段 | 既有证据及范围 |
| --- | --- |
| 2026-11-06 首次自动标题，`d8a3fbf4c81d65c7f1ed032ca7cdf6620639d85f` | compile/lint/build:test 通过；全仓 1,190 通过、0 失败、1 环境跳过（约 509 秒）；标题策略/存储/三协议专项 30/30 |
| 2026-11-06 导航修复，调查起点 `9c28b3b25282e4da66fd742c9be37b345a385be6` | 原生控制台曾确认 `renderContextProgress is not defined`，改用公开 renderUsage；修后导航与计时/标题接线 24 项通过；全仓 1,201 通过、0 失败、1 环境跳过（约 507 秒）。该旧故障不是所有现场导航故障的唯一归因 |
| 2026-11-06 手动重建初版 | 新增 43 项；标题/导航/计时专项 114/114、最终 Webview 8/8；全仓 1,244 通过、0 失败、1 环境跳过（约 478 秒） |
| 历史行刷新入口，`a9bcc6e` | 界面/计时 19/19、标题/导航/存储 88/88；全仓 1,251 通过、0 失败、1 环境跳过（约 482 秒） |
| 2026-11-07 首次加载/刷新，调查起点 `ce12f6ec1339b71cf52b94fb258ed70f6bfb4480` | compile/lint/build:test 通过；全仓 1,331 通过、0 失败、1 环境跳过；最后反馈细化由 215 项定向检查覆盖。安装目录六个指定 JS 与修前基线一致，不能据此归因旧包 |

历史环境跳过为本地故障服务器端口绑定受限。历史验证没有安装/发布本轮改动；原生可见时间、真实供应商费用/缓存和跨平台结果仍须单列。相关历史时序范围见[交互生命周期](keepseek-interaction-lifecycle.md#7-自动化与时序证据)。

## 改动定位

| 职责 | 文件 |
| --- | --- |
| 元数据、真实轮识别、两轮素材、Unicode/结果校验 | `src/sessions/sessionTitle.ts` |
| 请求协调、抢占、提交回调和终态 | `src/sessions/sessionTitleCoordinator.ts` |
| 完成分类、来源冻结与预算恢复 | `src/provider/sessionTitleCompletion.ts`、`src/provider/sessionTitleRequest.ts` |
| 轻量三协议传输及 reviewer 兼容 | `src/agent/oneShotTextRequest.ts`、`src/approvals/oneShotTextRequest.ts` |
| claim/staged commit、旧新 hash、截断/复制/恢复 | `src/sessions/chatSessionStore.ts`、`src/sessions/globalSessionStorage.ts` |
| 候选 drain、手动 requestId、状态和用量接线 | `src/provider/KeepseekChatViewProvider.ts` |
