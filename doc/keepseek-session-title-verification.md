# 会话标题生成与验收

当前合同校准：2026-11-10（Asia/Shanghai），本次开发起点 `599cc0249a41ae990904bedbce95eba767418a28`（0.5.2）。标题从用户目的命名：真实用户指令保存成功即准备并行命名，不等待或发送助手回答；首次有效标题共同提交成功后永久停止。标题默认开启，不增加开关或主会话工具。文末旧验证数字仅证明对应历史基线。

## 用户输入触发与目的边界

Host 在真实用户输入正文跨过提交持久化屏障后登记 durable 候选，冻结该次输入的身份与模型/来源。标题是独立辅助请求，可与主 Agent 推理、工具执行和流式回答并行；初次主请求不等待标题响应或标题保存结束，标题也不等待助手最终回答、工程成功、Apply 或前台 owner 释放。必要存储、信任、模型/凭据与预算仍须核验；正文未保存或保存失败时零标题请求。

自动每次只使用本条真实 `user.content`，表达“用户要做什么、想解决什么问题”，不总结 AI 做了什么，不把任务目的写成已经完成的结果。寒暄、含糊或脱敏后没有实质内容可 defer/no_material；模型请求失败、超时、无效或保存失败均等待下一条真实用户输入，不重复请求同一条指令。主回答尚未开始、正在 streaming、后续失败或被取消，不使已保存的用户指令失去命名资格。

真实提交共用 `isSessionTitleUserInput()` / `sessionTitleInputId()` 识别：普通输入优先使用 userTask/origin 身份，legacy 无 userTask 时使用既有真实 user 消息身份，不回填旧记录。用户亲自发送的 no-progress recovery 补充仍是新输入，以该消息 ID 取得独立命名机会；它可以沿用旧执行 root 的预算，因此命名输入身份与 `budgetRootTaskId` 分开冻结，不能因新输入重置或扩大旧额度。审批通知、命令/计划/修复自动续跑、工具返回和纯恢复状态刷新不是新真实输入，不额外命名。标题候选只保存输入身份、消息引用及来源/模型快照，不复制正文或凭据。

同会话仍按已观察的真实提交顺序串行处理标题候选；主请求与该会话标题请求可以并行。尚未取得标题槽位的 busy 不算消费。第一条 defer 后可处理已排队第二条，首次 set 持久化成功立即清空余下自动候选。普通新输入和切换查看不取消依据未变的旧标题请求；队列持有目标会话临时驻留引用，清空/终态时释放。启动、历史加载/刷新、只读诊断和重启不制造候选、不扫描历史补发标题请求。

## 持久状态、提交与恢复

`ChatSession.autoTitle` 仍是唯一标题元数据权威，metadata version 2 与 `stopped: named | manual` 保持原语义。`status` 表达 pending/running/completed，`attempt` / `manualAttempt` 表达独立在途；新输入材料使用独立 basis scope，不以更换触发时机重置成功状态。`attemptedThrough` 记录消费/退休的真实用户输入前缀，常规 Host 串行路径保留最近最多 64 个 `attemptedTaskIds`；legacy 和直接乱序调用的稀疏缺口不能为满足上限而丢弃未消费候选。`lastOutcome` 只供诊断，不代替停止标记。

| 状态/事件 | 后续自动请求 | 保留与恢复语义 |
| --- | --- | --- |
| 尚未成功命名 | 下一条合格真实输入可尝试 | 新会话 pending；失败不永久锁死会话 |
| 自动 attempt 在途 | 同会话排队，不重复派发 | revision、token、session/workspace 与所选用户正文 ID/hash 校验 |
| set 与停止标记共同提交成功 | 永久停止 | 追加、切换、重启、归档、编辑重发或旧依据不可读均不解锁 |
| 手动改名，含提交相同文字 | 立即锁定自动命名 | 推进修订并退休旧请求；用户意图优先 |
| 手动刷新在途 | 退休此前自动候选与请求 | 独立 manual attempt 不清除原标题或原停止状态 |
| 手动刷新成功，含生成同名 | 永久停止 | 可替换自动/自定义标题，新标题与停止状态共同提交 |
| 手动失败、defer 或保存失败 | 保持操作前的停止状态 | 保留 title/customTitle；未命名会话仅下一条新输入可自动尝试 |

只有 title 与停止元数据跨过 staged commit、分片和索引 canonical commit 屏障后才公开标题并通知正确历史行。shard 写成功但 index 失败不构成成功；最多重存同一已生成候选一次，不再次请求模型。通知失败不撤销已提交标题。旧响应、旧保存 await 和旧 finally 只能清理自己的 token，不能覆盖新手动操作或清新 spinner。

旧 pending/running/completed、自定义标题以及旧 whole-history/recent-turn basis 继续按旧格式读取。先按原格式核验 canonical commit，再迁移停止语义，不能因旧依据已归档而丢弃真实 completed，也不能把 shard-only/损坏记录伪造成成功。未完成 running 恢复为中断，不恢复 HTTP、队列、permit 或旧 token。旧会话已成功命名/手动锁定时，本次升级不重新主动命名。

复制会话保留标题及停止语义，重映射身份与普通根任务预算并保留已花额度；不复制手动标题辅助预算、去重游标、请求 token 或可执行队列。只在所选用户正文被修改/删除、目标删除、失信、workspace 改变或销毁时退休相应在途请求；助手回答的新增、streaming、修改或失败不参与新 basis 的有效性。已提交停止状态不依赖旧材料是否仍可读。本次不改历史正文、不批量补 userTask、不改默认空白启动与惰性读取。

## 只发送真实用户输入

自动、手动和存储校验共用真实用户识别，不要求相应助手回答存在或完成。第一条真实指令可保留缓存保护标记；displayKind/protectedReason 状态通知及 host continuation 不能成为指令素材。

| 模式 | 冻结边界 | 可发送正文 |
| --- | --- | --- |
| 自动 | 本条正文持久化成功的真实提交 | 仅本条 `user.content`，一个正文片段 |
| 手动 | Host 接受并确认目标时的最新真实输入 | 最近一条或最多两条 `user.content`，最多两个正文片段 |
| 主任务真实运行/保存等现有操作冲突 | 保留 Host 能力门禁 | 手动按钮仍按 busy/saving 反馈，不绕过交互能力 |
| 没有真实用户输入或脱敏后无实质内容 | no_material | 零模型请求，不借早期主题补足 |

禁止携带任何 `assistant.content`、首问补主题、第三条以前用户正文、摘要、旧标题、expandedContent、附件展开、providerContent、tool/evidence/replay、隐藏推理、项目指令或 Skills；不读取归档或外部文件补主题。自动本条过于含糊就 defer，不回退上一条指令；手动最多两条仍不足就 defer，保留旧标题。

先选择用户输入再裁剪：自动单条 JSON 总预算最多 4,000 字符，手动最多两条总预算最多 8,000 字符。手动两条输入各有有界份额，最新一条优先保留具体目的；超长正文使用确定性首尾摘录。凭据、邮箱、URL 与路径脱敏，字素安全裁剪后复核 JSON 总长度；不截断 JSON、不用第三条历史补足。相同输入与参数生成相同字节，实际 token 准入仍可收紧输出。

新 `basis.scope: user_inputs_v3` 只绑定实际所选一至两条 user 消息 ID/hash，`lastMessageId` 是目标用户输入 ID；不会计算全历史 fingerprint，也不绑定助手 ID、最终回答或 runDetails。后续普通追加和助手变化不使快照 stale；选中用户正文变化/删除必须拒绝。旧 `recent_turns_v2` 及 whole-history conversation hash 保留原语义读取，不把旧助手依据重解释为输入依据。输入 basis scope 升级不改变 metadata v2 的永久停止权威。

## 请求、来源与并行预算

- 仍使用“子代理模型 → 默认”和 `accountResolver`，不借审批 reviewer。接受时冻结设置与来源身份；fixed 不可用不回退，follow-main 不猜后续 picker。来源无法确认给出 `source_identity_missing`。
- 每次一个无工具请求，一次返回严格 set/defer JSON；意义判断与命名不分成两次。容忍 BOM/空白及完整唯一 JSON 围栏；拒绝多对象、自然语言猜测、半截 JSON、tool call 和 reasoning 替代正文。`finishReason=length` 单列 `output_truncated`。
- 标题简短且目的导向：通常中文不超过 16 字、英文不超过 32 显示单位，必要精确专名保留受控例外；拒绝泛化空标题、敏感内容、控制字符和虚构成功。
- 标题输出最多 512 tokens，同时受模型更小上限和剩余预算约束；超时最多 30 秒，再取用户配置及 root 剩余时间/截止期的更小限制。只按已核实能力关闭推理，不给未知网关添加字段。reviewer payload、上限与行为不变。
- 自动沿用冻结执行 root 的时间、费用、token 和物理请求额度，不新建手动预算，不借后续任务。在用户正文保存后、预运行压缩之前，`prepareAgentTaskBudget()` 建立/恢复实际根预算；同一 `LogicalRunBudget` / `ExecutionCostBudget` 对象临时注入 Runner 并原样复用，不能从快照重建第二份额度。标题模型解析与材料可提前准备；两者每次预占均须在各自 POST 前持久化。具体开放策略见下表。
- 没有费用上限、没有 token 上限，且请求次数不设上限或至少剩余两次时，标题可在预运行压缩前开放，保留主请求所需的一次调用余量。存在有限费用/token 上限或只余一次调用时，标题等待主请求首次预占已耐久的短准入门，随后按共享余额准入；它等待的是预算门，不是助手回答。初次主请求绝不能等待整个标题响应或保存；后续同 root 的恢复/续跑可以等旧标题结算后恢复最新账本，避免两个执行段建立不同活权威。
- 并行标题不单独累计一份与主请求重叠的执行时间，不接管 UserTaskClock；仍受同一 root 的绝对截止期约束。共享费用/token/请求计数按实际物理调用结算，每次只释放自己的 reservation，不覆盖主任务新计数或其他预占；无 usage 不编造 token，已发未知用量保留保守预占。正费用上限遇不可计价来源仍 fail-closed。
- 手动刷新继续是新的显式窄辅助预算：先持久化，最多一次请求、零工具、上游最多 32,768 tokens，服从用户更小限制与费用上限；不恢复旧任务 deadline、不进入主计时。
- 用量仍记为 source=subagent、purpose=session_title，以原 session/requestId 幂等入账；不改最新主回复费用。workspace 切换后的迟到用量仍写原 session 账本，不要求加载正文；删除墓碑禁止复活目标。

| 根预算条件 | 标题开放时机 | 主请求与恢复边界 |
| --- | --- | --- |
| maxCost=0、无有限 token 限额，请求无限或剩余至少两次 | 用户正文保存且实际 root authority 耐久后，可在预运行压缩前发出 | 保留一次主请求余量；主请求不等标题传输结束 |
| 有限费用或 token 限额，或仅余一次调用 | 主请求首次预占并持久化后，核验同一活余额 | 仅够一次时主请求优先，标题不额外发 POST |
| 主任务在首次派发前失败/取消 | 预算门须有界结算，不留永久等待 | 有效输入不等于无条件网络准入；缺/耗尽预算给明确终态 |
| 真正用户 recovery 补充，复用旧执行 root | 按新输入身份尝试，仍使用原 root 已花额度与限制 | 不生成新执行额度，不把内部自动续跑当用户输入 |

## 反馈、诊断与主请求不变式

保留历史行编辑按钮左侧的刷新按钮、旋转、防重复点击和中英文行内 `aria-live` 终态；不恢复双击标题入口。手动仍消费 `deriveSessionTitleCapability()`，不删除 disabled 或绕过 Host；自动命名不取得主输入/任务 owner，不因主回答正在运行而等待完成。

Host 在首个 await 前取得目标 session/request 所有权；相同 requestId 重放状态，旧 finally 不能结束新 spinner。自动失败不弹窗、不阻塞聊天；非活动会话只更新目标历史行/用量，不选择回 active，也不覆盖草稿或焦点。只读 runtime diagnostics 和日志不产生模型请求，日志仅记录有界哈希身份、固定原因、模式、材料数量/字符数和耗时，不记录正文、prompt、凭据、路径或供应商原始错误。

标题只修改标题元数据与辅助账本，不改变主聊天 messages、contextInstructions、静态 system、冻结 tools、replay 或三协议请求投影字节。持久化计时 reconciliation 保持纯投影，不为 legacy 消息回填 userTask。删除助手长回答使标题输入 token 通常下降，实际费用和供应商缓存命中仍以 usage 为准，不能仅凭材料变短保证节省金额。

## 自动化与本次验证口径

默认入口覆盖 `sessionTitle`、`sessionTitleStorage`、`sessionTitleCompletion`、`sessionTitleRequest`、`sessionTitleRegeneration`、`oneShotTextRequest`、`sessionTitleIntegration`、`sessionTitleWebview`、`sessionTitleBudgetConcurrency` 及相邻预算/导航/计时/投影测试。采用可控 deferred Promise、假时钟和真实临时存储故障，检查物理 POST 次数、材料范围、提交状态与恢复，不以函数存在代替行为。

```bash
bun run compile
bun run lint
bun run build:test
bun run test
```

2026-11-10 本次输入触发升级的最终验证：`compile`、`lint`、`build:test` 通过；默认 `bun run test` 共 1,401 项，1,400 通过、0 失败、1 环境跳过，约 572 秒。测试前后源码与测试文件哈希一致，未通过重录冻结 payload fixture 掩盖主请求变化。

关键受控证据：主回答为空且仍 streaming 时标题已提交；暂停运行前压缩时标题已提交而主请求仍为 0 POST，放行后主请求执行，根预算累计 2 次；已有 2 次消耗的 no-progress root 接受真实补充后累计 4 次，没有新建额度。自动正文仅当前一条用户指令，手动最多两条用户指令，均没有助手正文。标题登记意外抛错时主请求仍为 1 POST、标题为 0 POST，输入及最终回答均保留。

首次全量中的 17 项编辑重发失败来自无构造器测试宿主缺少新标题队列集合。补齐夹具初始化、保留原业务断言，并增加标题登记异常与主任务隔离的生产守卫后，编辑重发 23/23、相关合并专项 73/73 及上述最终完整回归均通过。其他阶段的 206/206、预算/请求/运行时 54/54 等专项存在覆盖重叠，不与全量计数相加。

以下历史结果不自动继承。受控 fetch/存储测试不能证明真实供应商、原生 VS Code、远程扩展宿主或 Windows/Linux 已通过。本次不安装、发布、提交或对真实历史批量自动改名。

## 原生验收步骤与证据

在隔离 workspace/存储中 F5，配置可用主模型和默认普通子模型。用测试端点/代理或账本核对 `purpose=session_title` 的真实 POST 次数、输入范围和来源；不能凭标题不变推断零请求。只记录脱敏的输入数量、消息范围标识、字符数与请求时序，不记录真实正文。

1. 主回答用可控服务器暂停，在用户指令保存成功后放行标题响应：标题应在主回答结束前提交显示，主请求不等待标题。对调两条响应的先后次序，均不影响各自完成与计时。
2. 新会话先发送寒暄使标题 defer，再发送具体目的；失败/invalid/defer 只在下一条真实输入后再尝试。首次 set 后追加至少三条指令、切换、Reload Window、展开/刷新历史和只读诊断，自动请求增量必须为 0。
3. 自动请求正文应只含本条用户指令标记，不含任何旧输入、长助手回答、streaming/工具标记、附件、expandedContent、摘要或旧标题。主任务后续失败/取消仍允许该已保存指令的标题提交；输入保存失败时零标题请求。
4. 早期用户主题 A、最新两条用户输入主题 B，且助手输出含完全不同主题 C；手动刷新最多使用 B 的两个 user 片段，不含 A/C。仅一条时可命名；零输入或纯敏感信息 no_material；主任务运行/必要保存冲突仍显示原 busy/saving 反馈。
5. 自动续跑、审批、工具、修复和计划执行属于原提交，不新增标题请求。另测用户亲自发送 no-progress recovery 补充：新消息可以命名，旧执行 root 的已花预算不归零。默认无限费用/token 场景暂停预运行压缩，标题仍可先提交；有限预算场景验证仅等主预占门，不等主回答。失信、存储未就绪与预算不足仍阻止派发。
6. 标题请求/保存 await 期间手动改名（含同文本）或手动刷新，放行旧返回/旧保存：旧结果和 finally 不覆盖新意图或 spinner，已发用量仍入账。手动同名成功锁自动；失败保留原 title/customTitle/停止状态。
7. 在 claim、预算、shard、index 保存注入失败：每条输入模型至多请求一次，同候选最多重存一次。重启不把 shard-only 当成功；旧真实 committed 即使助手或依据归档仍停止，复制保留标题并重映射身份。
8. 修改/删除所选用户正文使在途结果 stale；追加/修改/删除助手文本和更早未选中用户历史不影响新输入 basis。已提交标题在编辑重发、截断与归档后不解锁。
9. 余额仅够一次物理调用时，同时准备主请求和标题：主请求优先且合计最多一个 POST；额度足够时两者可以同时在途。预派发取消只释放自己的预占，已发且无 usage 不返还消耗或编造 token；正费用上限无法计价时 fail-closed。
10. Chat Completions/Responses/Anthropic 分别验证 512 输出/30 秒或更小限制、严格 JSON、拒绝 length/tool call/reasoning-only、reviewer payload 和主投影字节不变。非活动行刷新不改 active、草稿、焦点，真实缓存/费用仅按供应商 usage 核对。

## 历史证据（不替代当前合同）

以下结果保留原基线与日期，仅描述当时运行。旧版“等待完整助手回答”“手动 user/assistant 两轮正文”“新输入取消”“依据截断回 pending”“手动全历史/32,000 字符”“256 tokens/20 秒”已经被本页当前合同替代，不能作为本轮验收依据。

| 历史阶段 | 既有证据及范围 |
| --- | --- |
| 2026-11-06 首次自动标题，`d8a3fbf4c81d65c7f1ed032ca7cdf6620639d85f` | compile/lint/build:test 通过；全仓 1,190 通过、0 失败、1 环境跳过（约 509 秒）；标题策略/存储/三协议专项 30/30 |
| 2026-11-06 导航修复，调查起点 `9c28b3b25282e4da66fd742c9be37b345a385be6` | 原生控制台曾确认 `renderContextProgress is not defined`，改用公开 renderUsage；修后导航与计时/标题接线 24 项通过；全仓 1,201 通过、0 失败、1 环境跳过（约 507 秒）。该旧故障不是所有现场导航故障的唯一归因 |
| 2026-11-06 手动重建初版 | 新增 43 项；标题/导航/计时专项 114/114、最终 Webview 8/8；全仓 1,244 通过、0 失败、1 环境跳过（约 478 秒） |
| 历史行刷新入口，`a9bcc6e` | 界面/计时 19/19、标题/导航/存储 88/88；全仓 1,251 通过、0 失败、1 环境跳过（约 482 秒） |
| 2026-11-07 首次加载/刷新，调查起点 `ce12f6ec1339b71cf52b94fb258ed70f6bfb4480` | compile/lint/build:test 通过；全仓 1,331 通过、0 失败、1 环境跳过；最后反馈细化由 215 项定向检查覆盖。安装目录六个指定 JS 与修前基线一致，不能据此归因旧包 |

历史环境跳过为本地故障服务器端口绑定受限。历史验证没有安装/发布本轮改动；原生可见时间、真实供应商费用/缓存和跨平台结果仍须单列。相关历史时序范围见[交互生命周期](keepseek-interaction-lifecycle.md#7-自动化与时序证据)。

### 2026-11-10：回答完成后命名的前版证据

下列记录属于本次输入触发升级之前的 `e352508f` → `599cc024` 阶段，不能证明新提交时机或 user-only 材料已经验收，也不把分阶段计数相加。

| 前版阶段 | 记录的结果与范围 |
| --- | --- |
| 首次完整运行及复核 | 首次 1,369 通过、2 失败、1 跳过；完整复跑 1,378 通过、0 失败、1 跳过（约 699 秒），之后增量 230/230（约 45 秒）及相关检查 98/98（约 14 秒） |
| 前版最终工作树 | compile/lint/build:test/diff 检查通过；标题/三协议/用量/计时/ChangeSet 定向 210/210；全量 1,380 通过、0 失败、1 端口环境跳过（共 1,381，536.45 秒），10K 账本基准 13.11 秒，保留原 15 秒阈值 |
| 请求计数与持久化 | 210 个 defer 真实完成轮恰好 210 次，重复/重启旧轮零新增，新轮 211 仅加一次；截断第 100–211 轮后旧第 1 轮仍零新增；派发前取消/意图保存失败零 POST，已发且无 usage 保留未知用量 |
| ChangeSet 计数隔离 | 原基线自然前缀 14/14；在目标 checkpoint 人为延迟 2.2 秒可重现其他 fixture 延迟 GC 污染；测试最后仅计数本临时根目录，保留变更前真实持久写入、最多 5 次写入、0 次扫描，未改生产 GC |
| 原生 VS Code 尝试 | 独立临时 profile、空 workspace、开发扩展路径启动时 SIGABRT；未执行到激活/视图断言，不能算原生通过 |

## 改动定位

| 职责 | 文件 |
| --- | --- |
| 标题元数据、真实用户识别、user-only 材料及新旧 basis | `src/sessions/sessionTitle.ts` |
| 请求协调、抢占、提交回调和终态 | `src/sessions/sessionTitleCoordinator.ts` |
| 真实输入分类、来源冻结和辅助请求预算 | `src/provider/sessionTitleCompletion.ts`、`src/provider/sessionTitleRequest.ts` |
| 实际根预算准备、Runner 复用与主请求准入通知 | `src/agent/taskBudget.ts`、`src/agent/runner.ts`、`src/agent/runCheckpoint.ts` |
| 轻量三协议传输及 reviewer 兼容 | `src/agent/oneShotTextRequest.ts`、`src/approvals/oneShotTextRequest.ts` |
| claim/staged commit、旧新 hash、截断/复制/恢复 | `src/sessions/chatSessionStore.ts`、`src/sessions/globalSessionStorage.ts` |
| 提交屏障、早期实际根预算、并行候选 drain、手动 requestId 与用量接线 | `src/provider/KeepseekChatViewProvider.ts` |
