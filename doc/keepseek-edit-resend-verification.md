# KeepSeek 编辑并重发：历史归属、恢复与缓存验收

核对日期：2026-11-06（Asia/Shanghai）；开发基线：`003ea1827911cc6b28d2018c2af83b0b699611c7`。本次修改保留在工作树，已有 `.vscode/settings.json` 修改保留；没有提交、打标签、推送、发布或安装扩展，也没有自动撤销已发生的文件或命令副作用。

## 修复原因与行为

原实现截断聊天消息后，只把整个会话的部分 pending 操作改为 rejected/discarded。独立 Store 中其他状态的记录仍被发送到 Webview，失去来源消息后进入「未关联」区；保留历史中的 pending 操作又可能被会话级清理误伤。与此同时，结果交付位置解绑后，来自已删除来源的终态命令也被下一条 user 消息重新收取。

新实现将**历史归属有效性**与**真实执行状态**分开：被截断来源的 DraftRun、ChangeSet 和文件保留原结果及审计，通过 `historyInvalidationId` 退出活动查询、审批、Apply、执行、克隆重试、批次展示和结果 tail。消息来源按完整宿主历史及 checkpoint 的真实执行段 ID 判断，不使用分页 UI、trace run ID 或根任务 ID 代替。已知保留的来源消息优先于共享执行段，避免误清较早记录。

| 记录关系 | 编辑后的处理 |
| --- | --- |
| `messageId` 来源被截断 | 失效退出当前对话；结果不再交付；旧按钮和迟到产物不能重新激活 |
| 来源保留，仅 `resultBoundMessageId` 交付位置被截断 | 保留真实状态，解除旧交付绑定，按现有合同向新 user 消息绑定一次 |
| 已执行命令、已应用文件、未知副作用 | 保留真实结果、journal/blob/checkpoint；不伪造未执行，不自动撤销或重跑 |
| 保留历史、其他会话、合法 `skill:` 来源 | 不因本次截断失效；后续执行仍需当前审批和硬检查 |
| 旧孤儿记录且缺少可核实来源 | 标为 `historyOriginUnverified`，保留审计并隔离活动入口；不据「未关联」外观推定已删除 |

原文不变重发与修改后重发使用相同事务，均生成新的真实 user 消息和用户任务。实际 token、费用账本和任务有效时间保留；截断前先结算 checkpoint 的时间高水位，避免删除可见消息后漏计或重复计时。

## 提交顺序与恢复

宿主先检查输入、目标和忙碌状态，准备完整替换消息与来源作用域。命令、Apply、reviewer、续跑或批次仍在运行时，编辑发送不进入截断；等待其完成或安全停止、结算后再发送，不增加每次编辑的确认流程。

事务顺序由 [`historyTruncation.ts`](../src/sessions/historyTruncation.ts) 负责：

1. 原子持久化会话内 `pendingHistoryTruncation` 意图，保留原历史及完整替换消息。
2. 使相关 Store 记录失效，清理审批队列、人工请求、授权、批次 offers/state/display history，并等待独立 Store 的 durable flush。
3. 持久化合法保留来源的结果交付绑定。
4. 校正摘要、保护状态、动态上下文、计划、修复续跑、活动 archive 与计时；最后替换消息后缀，清除意图并持久化会话。

新模型请求和新副作用在必要提交完成后才开始。任一步写入失败均保留可恢复意图并阻止继续；重载时先幂等完成该事务，不能只恢复旧按钮或 permit。最终会话保存失败时，独立 Store 已经有持久失效标记，因此旧操作不会重新可执行；同进程重试也不会插入两条替换消息。畸形、跨会话或与当前历史不匹配的意图直接拒绝恢复。

Store 在已加载当前会话的完整历史上进行兼容核对。归属充分时恢复或失效；证据不足时只隔离，不删除审计。近期截断作用域有界保留，用于阻挡迟到产物；每条已失效记录自身持久保存标记，不依赖无限增长的会话分支日志。

加载、会话切换及工作区切换均先恢复再开放操作；恢复持有宿主启动锁。跨工作区复制遇到未完成或损坏的截断意图时，要求先在原工作区恢复，避免把旧 session 的意图复制到新 session。迟到 checkpoint、计划、协议迁移、流式更新及缓冲命令事件按完整历史归属重新校验。

## 主要改动位置

| 文件 | 职责 |
| --- | --- |
| [`historyTruncation.ts`](../src/sessions/historyTruncation.ts) | 归属计划、写前意图、提交顺序、恢复及幂等守卫 |
| [`KeepseekChatViewProvider.ts`](../src/provider/KeepseekChatViewProvider.ts) | 编辑重发编排、忙碌拒绝、恢复入口、迟到回调和旧按钮守卫 |
| [`draftRunStore.ts`](../src/runs/draftRunStore.ts)、[`draftRunBatchCoordinator.ts`](../src/runs/draftRunBatchCoordinator.ts) | 命令归属、结果交付、批次及活动查询；授权与执行器同步拒绝失效记录 |
| [`changeSetStore.ts`](../src/edits/changeSetStore.ts) | 文件记录失效、运行态/历史态过滤、journal 与 artifact 保留 |
| [`approvalProcessing.ts`](../src/approvals/approvalProcessing.ts)、[`approvalReviewStore.ts`](../src/approvals/approvalReviewStore.ts)、[`approvalMode.ts`](../src/agent/approvalMode.ts) | 精确操作及执行段的人工请求、队列和批准失效 |
| [`historyTruncationContext.ts`](../src/sessions/historyTruncationContext.ts)、[`historyCompressor.ts`](../src/agent/historyCompressor.ts)、[`cacheObservation.ts`](../src/agent/cacheObservation.ts) | 摘要来源证明、动态上下文与前缀诊断 |
| [`types.ts`](../src/shared/types.ts)、[`chatSessionStore.ts`](../src/sessions/chatSessionStore.ts)、[`agentRequestCoordinator.ts`](../src/agent/agentRequestCoordinator.ts) | 宿主私有字段、兼容归一化、复制和请求快照 |

## 缓存保护与证据边界

[`historyTruncationContext.ts`](../src/sessions/historyTruncationContext.ts) 只修正派生状态，不重写保留消息。稳定 `contextInstructions`、原有工具集合/顺序/schema、`providerContent`、`expandedContent`、`content`、`toolRounds` 和同 lane 原生 replay 按原字节复用。Skill 按新任务重新解析，冻结工具不因 Skill 快照刷新而无条件清空；新任务身份与截断标记不进入 system 或工具 schema。

| 情况 | 请求前缀处理 |
| --- | --- |
| 来源、endpoint、模型、协议和能力相同，仅删除历史后缀 | 复用实际保留的公共前缀；新请求可能比上一请求短，不要求完整继承上一请求 |
| 编辑首条 user 且没有任何保留消息，原稳定上下文仍含已删除任务的隐式 Skill | 仅在新上下文字节不同且语义需要时重新建立稳定上下文，记录 `context_semantics_changed`；移除不再活动的 context archive。字节相同则继续复用 |
| 摘要来源消息 hash 与全部摘要依赖均有效，且仅覆盖保留历史 | 复用摘要原文；同步过滤已删除的 protection state |
| 摘要跨越截断点、依赖被污染、来源变化或旧摘要缺证明 | 整段失效，不能只改 coverage 掩盖已删除语义；之后按既有容量维护路径处理 |
| 动态上下文 tail 来源被删或被摘要隐藏 | 从仍实际可见的宿主 tail 证明恢复 hash；证据不足时重新追加本轮上下文，不回写旧消息 |
| `context:*` archive 来源不再活动，且保留请求没有对应 archive 引用 | 从活动 archive 排除，防止中间截断后旧 Skill 经搜索回灌；当前来源或保留稳定上下文/消息明确引用的 archive 继续保留 |
| 模型/来源/lane、必要能力或安全语义变化 | 按现有受控边界调整，不以缓存为理由保留错误能力或旧授权 |

原工具集合能服务新输入时原样保留；确有缺失的工具能力时才扩充，并在本地 `historyRewriteReason` 记录 `tool_capability_changed`。摘要失效原因也记录到本地边界说明。编辑后的只读外部引用授权从本次明确选择重新计算，旧任务的授权不会在后续普通发送时回来。

新摘要保存宿主私有 provenance，明确原消息 hash 和摘要依赖；当前摘要只消费新增原消息，依赖集合为空。新 user 消息仅在实际追加动态上下文 tail 时记录宿主私有 `dynamicContextHash`，防止已删除后缀的 hash 抑制必要更新。每次截断的活动 context archive ID 随同 journal 持久化；首条重发需要移除旧稳定上下文的任务语义时，替换上下文也随同提交和恢复，不以缓存为由把旧 Skill 留在 system，再靠后续 tail 抵消。

回归使用 `buildProviderRequestProjection()` 与最终 `buildProviderPayloadProjection()`，比较 Chat Completions、Responses、Anthropic 的真实保留项、工具及原生 reasoning/tool replay。`edit_user_prompt` 是本地受控边界，不表示上游命中为零：诊断仅采用自身有独立 hash/长度证明的稳定 system/context/tools 段，不从整个历史 hash 猜测较短公共历史长度。该请求不参与严格前缀健康目标判断，服务商返回的真实 cache 计量仍保留。

本地字节一致不能保证上游命中；服务商缓存块大小、有效期、路由与返回计量仍会影响结果。此次未以真实 API 命中率或收费变化作为通过证明。

## 自动化证据

所有副作用及持久化故障测试使用临时工作区、临时存储或 fake/stub，未对真实用户文件和全局会话存储做破坏性测试。

本次实际检查结果：

| 检查 | 结果 |
| --- | --- |
| `bun run compile` | 通过 |
| `bun run lint` | 通过 |
| `bun run build:test` | 通过 |
| `bun run test` | 总计 1094 项：1093 通过、1 跳过、0 失败；约 407.6 秒 |
| 最终截断、上下文与宿主链路定向回归（三份新增测试） | 53/53 通过，包含最后的归档清理调整 |
| `git diff --check` | 通过 |

跳过项是本地故障服务器测试，原因是当前执行环境禁止监听本地端口。曾有一次重叠测试期间的 10,000 条账本性能用例耗时约 16.1 秒，超过原 15 秒门限；停止重叠测试后，全量复跑该项约 12.0 秒，通过原门限。没有修改门限或删除失败断言。

真实 VS Code Webview、真实供应商 API/cache hit 以及 Windows/Linux 现场行为未验证。主要回归入口如下：

| 测试 | 保护行为 |
| --- | --- |
| `editUserPrompt` | 真实 Provider 编排，ask/delegate，首条/中间/最近 user，改文/原文，来源与交付区分，费用/副作用保留，旧回调及忙碌拒绝 |
| `historyTruncation` | 完整历史作用域、共享执行段、持久化阶段故障、重启/同进程恢复、重复提交与非法 journal |
| `draftRunStore`、`draftRunBatch`、`changeSet` | 各状态退出活动集合、保留历史不误清、批次壳清理、旧入口拒绝、审计与持久化保留 |
| `historyTruncationContext` | 三协议真实 payload/replay 公共前缀、摘要来源/依赖链、动态 tail、归一化和缓存诊断 |
| `contextEntryPoints`、审批、用量、计时及既有 projection/replay 邻近测试 | 原有合同与恢复回归 |

常规检查：`bun run compile`、`bun run lint`、`bun run build:test`、`bun run test`。本任务不要求市场包验证或发布。

## 最简现场验收

以下为**待执行的真实 VS Code UI 验收**，自动化 stub 不替代这些步骤。使用独立 VS Code 用户数据目录及临时工程，再 F5 启动 Extension Development Host，确认数据路径属于临时环境后操作；勿把真实全局会话或生产仓库作为验收数据。

1. 打开 KeepSeek，检查首次 ready、会话切换、设置和模型选择；在输入框测试文字、拖拽、`@` 引用和键盘/焦点，正常发送一条任务。
2. 在同一临时会话创建三轮任务，每轮准备临时文件修改及至少两条命令，包含未审批、正常完成和故意非零退出；先在 ask 下保留前轮待处理卡片。另用临时文件实际测试 Apply/Discard，记录已应用文件和已执行命令的内容/结果。
3. 编辑中间 user 消息发送修改文本：后缀消息、对应文件/命令及批次卡片消失，「未关联」区不出现它们；更早卡片保持状态，已发生的临时文件内容不回退。后续新任务正常运行，模型请求没有已删除来源的旧结果。
4. 分别重复原文不变重发、首条和最近一条重发；切换到 delegate 重复。加载更早消息后编辑，确认分页未加载的保留消息不被当成删除。检查合法 Skill 对话框来源不受影响。
5. 在命令/Apply/reviewer/批次运行时尝试编辑：此次编辑不提交；结束或停止并结算后再发送。旧人工按钮或旧卡片事件不能批准/执行被截断操作，重复点击不产生重复任务或结果。
6. 重载开发宿主并切换会话返回：被截断卡片和批次壳不复活；保留历史仍存在；累计 token/费用/有效时间保留，新重发有独立本次计时。再次检查编辑输入、发送、取消、键盘和焦点。
7. 需要真实缓存核对时，分别使用三种协议的测试来源观察实际请求及服务商返回计量；将本地公共前缀与实际 cache hit 分开记录。不要仅凭命中率判定清理语义或前缀是否正确。

运行环境未实际覆盖的 VS Code UI、真实 API 和 Windows/Linux 行为必须单列为未现场验证，不能由当前平台的临时 fake 执行推定。
