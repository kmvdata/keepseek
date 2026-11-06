# 会话标题生成与验收

基线：2026-11-06（Asia/Shanghai），`d8a3fbf4c81d65c7f1ed032ca7cdf6620639d85f`。这是宿主新增功能，默认开启，不增加主会话工具或专用配置。

## 行为与权威

真实用户逻辑任务可跨审批、命令、修复、计划与恢复执行段。`sendPromptImpl` / `continueAgentTask` 仅从真实返回的 `AgentResponse` 登记候选；外层最终持久化成功才授权该候选进入结束检查。`maybeAutoContinueDraftRun` 的统一收口先处理已有续跑，后台任务则在 `finishBackgroundResponse` 成功落定后检查。普通工具轮、epoch、UI idle、postState、打开历史、重启均不能制造候选。

`sessionTitleCompletion.ts` 检查逻辑任务及最新可见答复、成功状态、流式/截断/预算/恢复状态和审批、命令、修复、后台挂起。ask 模式的完整方案或草案不因未 Apply 而永久阻塞；真正挂起的工具审批与安排好的续跑需要等待。正常澄清回答可触发，再由标题模型判断 defer。

`ChatSession.autoTitle` 是版本 1 宿主元数据：pending → running → completed，保存 revision、最近消费的逻辑任务、attempt token 与依据消息 ID/hash。customTitle 始终锁定自动命名，同文本手动提交也推进修订。只有候选标题及 completed 状态同时持久化成功才发布界面事件；全局存储在索引原子提交中保存标题依据的 canonical hash，分片先写成功、索引失败的结果在重启/孤儿恢复时仍回到 pending，不误判完成；存储失败最多重存同一候选一次，不再请求模型。defer、无效或失败只消费当前轮，未来新轮仍可尝试。

旧会话保留展示标题：有 customTitle 则锁定，其余待命名。重启把 running 视为中断，保留已消费轮次，不重放请求。复制会话保留手动/已完成标题语义并重映射依据，不复制在途 token。删除、失信、工作区切换或销毁清理取消源；普通会话切换允许 A 的合法结果仍只更新 A。

编辑重发复用原 historyTruncation 事务：依据全保留则保持 completed；依据被删/替换则回 pending，并按保留/替换后的有效用户内容显示临时标题。手动标题不重置。新真实用户输入使旧在途结果失效。保留消息正文、contextInstructions、system、工具 schema、replay 及主请求投影均不因标题改写。

## 请求、预算和用量

- 模型复用“子代理模型 → 默认”。fixed 严格匹配，不静默回退；follow-main 使用该执行段捕获的实际主来源/模型快照。凭据经 accountResolver 解析，不保存到命名元数据。
- 独立一次性无工具请求，由模型一次返回 set/title 或 defer/null。无递归、格式修复、网络重试、聊天消息、审批卡或主任务 busy/计时。
- 输入最多约 8,000 个字符的合法 JSON 素材，优先最初有信息的诉求、最近真实用户澄清和最终回答；仅使用已加载的可见 content，清理代码块、邮箱、路径和明显凭据。既不展开附件，也不读取隐藏推理或工具回放。字符上限不是精确 token 预算，另外经过真实协议准入估算。
- 输出最多 256 tokens，仍服从模型更小的额度；独立超时最多 20 秒，并服从配置和所属逻辑任务的剩余时限。恢复原 token/费用预算，物理请求前持久化预占，完成后按增量结算，不创建新额度；无法恢复预算或正费用上限下不可计价时跳过。
- thinking 使用现有来源支持的关闭映射：DeepSeek disabled、Qwen false，Responses/Anthropic 不请求 reasoning/thinking。兼容端点无可靠能力元数据时不能保证供应商不内部推理，仍受小输出和超时限制。
- 真实 attempt、usage、sourceId/modelId 和费用记入 source=subagent、purpose=session_title 账本，稳定 request ID 去重；无 usage 保留未知，不按文本长度估 token。失败、取消、过期的已发生请求也记账。会话删除的账本有同步墓碑与串行清理，不能复活。
- 用量入口显示“会话标题生成（计入子代理）”；费用加入会话总计，不改最新主回复费用。辅助耗时不进入 UserTaskClock。标题与辅助用量不推进会话最后聊天活动时间。

## 自动化验证

默认测试入口包含 sessionTitle、sessionTitleStorage、sessionTitleCompletion、sessionTitleRequest、oneShotTextRequest、sessionTitleWebview，以及生产接线 sessionTitleIntegration、相邻 usage、reference cost、删除恢复与协议回归。

运行命令：

```bash
bun run compile
bun run lint
bun run build:test
bun run test
```

本次实际验证结果（2026-11-06）：

| 检查 | 结果 |
| --- | --- |
| `bun run compile` | 通过 |
| `bun run lint` | 通过 |
| `bun run build:test` | 通过 |
| `bun run test` | 1,190 通过，0 失败，1 环境跳过；约 509 秒 |
| 最终标题策略、存储、三协议字节稳定专项 | 30/30 通过，含真实临时磁盘故障注入 |
| `git diff --check` | 通过 |

跳过项为已有 local fault server 回归：环境不允许绑定本地故障服务器。三协议字节稳定专项另外核对自动提交前后完整请求投影、静态 system、冻结工具与原生 replay 保持一致。自动化使用可控 deferred promise / mock transport，不等于真实供应商或原生 VS Code 验收。

## 现场验收步骤

1. F5 启动扩展宿主，配置可用主模型与默认子代理。新建会话发送“你好”；回答结束后保留临时标题，不出现“新对话/任务”等自动标题。
2. 下一轮发送“分析 KeepSeek 审批失败原因”；回答完整落定后标题应变短，当前标题与历史同步。用量可见自动标题调用，真实来源为默认子模型。
3. 继续三轮并 Reload Window，再打开历史；已成功标题保持，请求次数不再增长。只浏览旧会话不触发命名。
4. 以慢响应测试端点暂停标题返回，在历史中手动改名（也测提交原名称），再放行响应；手动名称保留，编辑中的输入和焦点不跳动。
5. 标题在途时切换到 B，A 只能更新 A；删除 A 后放行旧响应，A 和账本目录均不复活。立即发送新一轮，旧结果不能覆盖新状态。
6. delegate 模式让一个任务经历工具调用、命令批次、审批续跑与修复；用 Provider 日志核对，仅最终合格轮发生一次 session_title 请求。ask 完整草案可尝试；真实人工工具审批挂起时不尝试。
7. 编辑重发命名依据所在轮：自动标题回临时标题，新回答结束后可重新命名。编辑依据之后的无关轮：原自动标题保持。手动标题两种编辑均保持。检查保留历史请求前缀字节不变。
8. fixed 默认子模型设为不存在、模拟 20 秒超时、HTTP 错误、截断输出或非法 JSON；主回复正常可用，无额外弹窗/气泡。本轮不修复重试，下一合格真实轮仍可尝试。
9. 分别验证 Chat Completions / Responses / Anthropic Messages 的真实端点；请求无 tools / 父历史，输出小额度，usage 与费用归属正确；主任务 loading、“本次时间”、最新主回复用量不重开或改变。

当前环境尚未完成真实供应商、原生 VS Code UI、Windows/Linux 的现场验收；上述步骤须在对应环境执行。没有发布、安装、提交、打标签或改版本号。

## 关键改动位置

| 职责 | 文件 |
| --- | --- |
| 标题合同、素材、Unicode 与结果校验 | `src/sessions/sessionTitle.ts` |
| 在途协调、取消、去重、脱敏诊断 | `src/sessions/sessionTitleCoordinator.ts` |
| 最终逻辑问答判定、来源与预算 | `src/provider/sessionTitleCompletion.ts`、`src/provider/sessionTitleRequest.ts` |
| 轻量三协议传输与审批兼容入口 | `src/agent/oneShotTextRequest.ts`、`src/approvals/oneShotTextRequest.ts` |
| 存储认领/提交、索引提交标记、截断 | `src/sessions/chatSessionStore.ts`、`src/sessions/globalSessionStorage.ts`、`src/sessions/historyTruncation.ts` |
| 事件接线、界面与用量 | `src/provider/KeepseekChatViewProvider.ts`、`src/webview/script.ts`、`src/webview/input/usage/script.ts` |

## 会话导航故障修复（2026-11-06）

排查基线为 `9c28b3b25282e4da66fd742c9be37b345a385be6`。原生 Webview 控制台确认反复抛出 `renderContextProgress is not defined`：计时事件跨作用域调用了输入组件内部函数。现改用已有公开的 `keepseekInputControls.renderUsage()`，并容忍组件尚未挂载或已卸载。

宿主导航另有可控回归确认的失败路径：初始 load 尚未结束就执行新建/历史选择，晚到的 load 会覆盖活动会话；重复“＋”可并发新建；新建成功后上下文刷新失败会漏发切换通知。现在新建与选择均先等待会话加载，同步取得导航锁并在 finally 释放；已经持久化的切换即使后续上下文刷新失败也发布完整状态。内部上下文刷新保留实际执行，外部 Skills 刷新与主运行的 busy 保护保持原规则。启动期提前导航发布状态时，自动续跑仍须等待审批恢复与请求上下文都就绪。普通会话切换不取消自动标题，A 的晚到标题仍只能更新 A。

修前导航回归 6 项中有 4 项失败；修后导航 9 项及计时/标题生产接线合计 24 项通过。测试运行真实 Host、临时 GlobalSessionStorage 与完整生成的 Webview 脚本，使用可控 load/save/标题响应，不依赖长时间 sleep。该结果不能证明上述任一问题是现场所有无法切换现象的唯一原因；标题改动审查未发现占用主任务锁或覆盖活动会话的证据。

最终 `compile`、`lint`、`build:test`、`git diff --check` 均通过；`bun run test` 为 1,201 通过、0 失败、1 环境跳过（共 1,202 项，约 507 秒）。唯一跳过项仍为沙箱不允许绑定本地故障服务器。验证期间源码修复由外部操作提交为 `266fa37`，本次未执行 Git 提交。

现场复验：使用本地源码 F5 启动扩展宿主，先在启动加载时点击“＋”，加载结束后应保持新会话；反复点击“＋”不并发创建；打开历史来回选择，标题与消息同步变化；运行一个回答并观察计时，再新建/选择历史，控制台不再出现上述 ReferenceError；标题请求在途时选择 B，返回后仍停留 B。主任务执行中的导航保护保持原行为。

本次自动验证未安装或发布扩展，修复版本的原生 VS Code 现场复验仍待执行。

## 双击手动重建（2026-11-06）

双击顶部会话标题可重新调用“子代理模型 → 默认”，标题获得键盘焦点后 Enter/Space 等效。单击不调用模型。不新增按钮、聊天消息或审批流程。请求期间原标题保留，只禁用该会话的重复重建；输入、新建及历史切换可继续使用。主回答/后台运行执行中或启动尚未就绪时不派发。

这是用户主动请求的例外：已有自动标题或手动名称均可重建，成功后保存新标题并保持 completed，普通后续问答仍不重复自动改名。失败、defer、非法结果或取消保留原名称及手动锁/停止语义。期间再次手动改名（含同名提交）优先；新用户轮、编辑截断、删除和失信使旧结果失效。切换到 B 不取消 A，A 的结果不改 B。Webview 重载从宿主恢复请求关联；晚到旧回调不能取消新请求。

恢复仍以既有索引提交标记核实 completed；若取消与连续索引写入失败叠加，导致分片和索引无法一致核验，则保守恢复为 pending，等待未来真实轮次，不在重启或浏览时重发请求。

手动素材使用已完整加载的会话各轮有效 user/assistant 可见正文，覆盖中间轮，而非自动模式的少量重点摘录。总量能容纳时保留完整可见正文；超过 32,000 字符才按各条消息作有界 Unicode 节选，不悄悄删除整个轮次。材料排除工具回放、隐藏推理、附件展开、宿主续跑提示和敏感片段，不为标题读取工作区或额外历史文件。极端轮数连结构骨架也无法容纳，或实际模型窗口/预算不足时，保留原标题并记录诊断。字符上限不等于精确 token 数。全会话消息边界与 hash 校验用于防止中间轮编辑后提交旧标题。

每次显式请求只有一次 Provider 调用，无格式修复或网络重试，输出仍最多 256 tokens、超时最多 20 秒。它拥有一个独立的小辅助预算（1 次模型请求、上游最多 32,768 tokens，服从已有配置的更小限制和费用上限），以支持旧会话及已经结束/过期的原任务；不重置原任务额度或重开主任务计时。最新辅助预算认领先持久化，所有实际尝试与 usage 继续进入 source=subagent、purpose=session_title 的既有账本。fixed 不回退；follow-main 绑定双击时选择的主模型快照。

缓存采用稳定的独立 system 与按序 JSON 正文；模型输入不带请求 ID、消息 ID、当前标题或时间。相同会话重复重建的输入字节保持一致，正常追加短对话时尽量保留已有前缀；每次显式重建仍实际调用模型。官方 Anthropic 端点复用已有 ephemeral 缓存策略，兼容网关与审批请求不增加该参数；其他协议利用供应商已有的自动前缀缓存。独立标题任务的 system/正文与主聊天不同，不能保证复用主聊天缓存，也不能保证命中或节省特定金额；实际命中以返回 usage 为准。主聊天 system、messages、replay、工具 schema 与请求字节不变。

现场复验：F5 加载源码，在含多轮主题的会话双击标题，确认历史列表同步更新；连续双击只产生一次请求；再次双击成功标题确实发起新请求。以慢响应暂停，分别测试切换 B、手动同名/新名、删除、新一轮输入及 Webview 重载；原标题/手动名称和请求归属按上述规则保持。使用相同来源/模型与未变对话再生成，核对用量中实际缓存读写，不能仅凭输入字节一致宣称缓存已命中。真实供应商缓存和修复版本原生 UI 本次尚未现场验证。

本次验证：新增 43 项回归；标题、导航与计时汇总专项 114/114 通过，最终文案后的完整 Webview 专项 8/8 通过。`bun run compile`、`bun run lint`、`bun run build:test`、`git diff --check` 均通过；`bun run test` 共 1,245 项，1,244 通过、0 失败、1 项环境跳过，约 478 秒。跳过项仍为沙箱禁止绑定本地故障服务器。代码留在工作树，未提交、安装或发布。
