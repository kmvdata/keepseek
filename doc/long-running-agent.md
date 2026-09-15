# 长任务、连接观察与安全继续

## 默认策略与迁移

主 Agent、子 Agent 和未显式限时的受控后台修复，默认没有本地总时长截止。模型档位仅决定原有上下文、输出与工具能力；原先的 600 秒、子任务 5/15 分钟、后台 30/60 分钟常量不再作为默认截止。未改默认模型或推理强度。

VS Code 设置：

```json
{
  "keepseek.agent.maxExecutionMs": 0,
  "keepseek.agent.maxCost": 0,
  "keepseek.agent.streamIdleTimeoutMs": 0
}
```

- `agent.maxExecutionMs`：同一逻辑任务的有效执行毫秒预算，0 不限时，用户继续任务不清零。模型重试与续写包含在内。
- `agent.maxCost`：同一逻辑任务在每种计费币种下的 Provider 已统计费用上限，0 不限额。主任务、子任务、Context Epoch 与崩溃恢复共享同一账本；不同币种不做汇率换算或相加。正值上限要求来源、模型和响应都能提供可计价用量，否则在继续产生无法核算的费用前安全停止。
- `agent.streamIdleTimeoutMs`：显式开启的无网络数据断开策略，0 表示保守等待。它也覆盖等待响应头；并不声称能识别 DNS/TCP/TLS 阶段。不是另一个默认总时限。
- `background.maxDurationMs`：兼容已存储的旧后台显式值。与统一设置取最小正数；未设置不恢复旧内置 30 分钟值。后台每轮只获得总预算的剩余有效时间。
- 子任务调用参数或 Skill 的显式 `timeoutMs` 与用户设置取最小正数。任务记录保存来源，不再强制限制为 15 分钟。

时间和费用配置都只有数值 0 表示无限；缺失、null、负数、非数字、非有限值归为 0。有限正数合并时忽略 0 并取最小值，避免无限值覆盖更严格的调用级上限。总执行时间不传给 `setTimeout`，超大值不会造成计时器溢出。运行中的设置修改不改变当前任务已冻结的时间或费用预算。

费用按每次 Provider 响应返回的真实用量与请求时冻结的模型价格记账。一次已经被 Provider 接受的请求可能使总额略微越过上限；KeepSeek 会在下一次模型请求之前停止，绝不会为了费用检查重跑工具。无法计价的自定义网关不能在正值费用上限下启动，这比把未知费用误当作零更安全。

有效时间使用单调时钟：同一父子任务树的活跃时间取并集，不累加并行子任务时长。等待授权、Apply、子任务队列不计费于时间预算。扩展每 250ms 采样，超过 5 秒的宿主停顿（休眠或长时间不可调度）保守排除，不以系统日期跳变判断到期。因此它是客户端保守执行时间预算，不是供应商计费硬上限。崩溃可能丢失最后一次定期保存以来最多约 15 秒的计时；重启离线时间不会补扣。

## 持久 Goal

输入区“/”旁的 `G` 按钮是范围明确、具有可验证停止条件的持久任务入口。没有 Goal 时，按钮读取输入框当前内容，并通过已配置的 `proposal` 子代理模型发起隔离、无工具的表单预填请求；它只生成 1–6 项验收条件、证据要求、工作区相对 include/exclude 范围和当前可用的 `compile | lint | test`，可取消、严格校验 JSON，失败则回退到保守默认项。预填请求只记录会话用量，不创建 Goal、ChatMessage、权限或副作用；用户仍需在精简面板中确认，预算、恢复和证据回退位于折叠的高级设置。生成的 `Goal: <objective>` 可见消息、引用展开结果和确定性 contract tail 随后冻结；Goal Store、lease 和首个 v3 RunCheckpoint 成功写入后，才允许首个正式 Provider 请求。Goal 开始后，聊天 transcript 末尾投影一张独立状态卡，原位刷新状态、当前步骤、验收/验证完成数、有效执行时间、请求数与模型，并可打开管理弹窗；当前 attempt 同时投影为 view-only assistant 消息，复用普通对话的增量文本/推理渲染，但对象只保存在 Extension Host 内存并在状态投影时临时追加，既不追加 `ChatSession.messages`，也不进入三协议 replay。候选审查期间保留已收束的本轮输出，下一 attempt 替换它，最终 completed ChatMessage 落盘前将其移除。已有 Goal 时，鼠标悬浮 `G` 同样显示有界摘要；`preparing` 阶段可以取消，迟到的租约结果不能复活已停止 Goal。显式 Resume 先回传 pending，再复核当前 session/source/model/checkpoint/Trust/授权/不确定副作用和 lease；它不重复 activation recovery，也不会再次清空本次宿主内已经有效的 validation/criterion evidence。错误在管理弹窗内可见，完整状态回传保证按钮重新可用。清理成功后，Provider 必须向 Webview 发送显式 `goal: null`，不能用可能被消息序列化省略的 `undefined`，因此旧状态会在当前或新 AI session 中立即清除并允许创建下一项 Goal。修订不重写原目标或历史，并使旧验证/完成审查失效。

Goal 状态由 `src/agent/goals/goalCoordinator.ts` 单独拥有。一次 `AgentRunner` attempt 没有工具调用时返回 `candidate_final`，不会直接完成 checkpoint 或把候选 assistant 写进聊天历史。宿主先检查 lease、冻结身份、Workspace Trust、授权、TaskPlan、criteria、最后 mutation 之后的验证、ChangeSet/DraftRun/approval/tool/subagent 终态和预算；再调用隔离、无工具、无写入/执行能力的 completion reviewer。reviewer 决定绑定 contract/revision/candidate/evidence manifest/mutation revision，提交 completed 前全部重验。只有纯机器可验证 criteria 才允许 reviewer 不可用 fallback；正费用上限无法对 reviewer 计价时不允许 fallback。manual criterion 必须由用户在 `G` 按钮的管理弹窗中明确确认。

活动 Goal 的 `ask`、`model_review`、`delegate` 与普通任务使用同一安全管线。`ask` 等待真实 Apply/Run；`model_review` 继续使用当前 runtime、精确 actionHash、一次重试和拒绝熔断；`delegate` 仍写入明确的 `host_policy`，没有模型审查。Goal 不改变 Workspace Trust、外部 URI、脏编辑器、base/result hash、删除二次确认、一次性 permit 或显式 shell 规则。拒绝、Discard、Revert、partial Apply、命令失败和 workspace mutation 会使旧证据失效；未知文件提交、未知 DraftRun 终态或 uncertain tool result 永不自动重跑。

Goal Store 位于 extension `globalStorageUri/goals/v1`，使用小型 index、每 Goal 的不可变 content-addressed snapshot 和 append-only journal shard；文件存储通过临时文件 flush/close、原子 rename 和目录 fsync 发布。每次 snapshot/save/append 使用单调 `storageRevision` 做乐观并发校验：正常状态变化可以提交，真正基于旧版本的写入会被拒绝；早期 V1 snapshot 缺失该字段时按 revision 0 兼容读取。损坏的最新 generation 会回退到最后一份同时通过 record hash 与 journal 校验的 snapshot；完全不可验证的数据 fail-closed。workspace lease 使用 owner/heartbeat/expiry 和单调 fencing token：`file:` storage 直接使用 `globalStorageUri.fsPath`；桌面 Node Extension Host 返回其它 URI scheme 时，显式使用同一 `ExtensionContext` 的绝对 `globalStoragePath` 作为 Store guard、lease 与 fence counter 的原子文件根。没有可靠绝对本机路径时仍不运行 Goal。stale takeover 必须超时、复读并确认 Goal 状态，取得调度权不代表旧副作用可重试。Reload 后上一 Host 的 lease 最多还会存活 30 秒；显式 Resume 使用该记录的精确剩余 TTL 做一次可取消等待，再尝试原子接管，不做固定间隔轮询。若另一窗口在等待期间续租，恢复方只报告真实占用，未持有 lease 时不写 Goal snapshot。

恢复默认是 `manual`。激活时 `running/pausing` 先持久化为 `interrupted`，然后核对 workspace/session、V10 session、首次 user 的精确 `providerContent`、v3 checkpoint、冻结 source/model/provider/endpoint、Trust、外部授权、ChangeSet、DraftRun、approval runtime 和 lease。旧 runtime 的 approval、permit、batch continuation 与内存队列全部丢弃；重启后不能证明文件未变，因此旧 validation 和 completion decision 保守失效。只有 contract 选择 `auto_on_activation`、配置允许、全部上下文匹配且没有审批等待或不确定副作用时才自动恢复。

> Goal 只会在 KeepSeek 的 VS Code Extension Host 运行时推进；VS Code 关闭、Reload 或设备休眠期间不会执行，重新激活后可恢复。

保持 `onView:keepseek.chat` 激活边界：没有外部 daemon、shell scheduler、云 worker 或 `onStartupFinished`。侧栏隐藏不会暂停仍存活的 Extension Host；Host 不存在期间没有 heartbeat、请求或工具执行，也不累计 active execution。

Goal 配置为：

```json
{
  "keepseek.goal.maxActiveExecutionMs": 0,
  "keepseek.goal.maxCost": 0,
  "keepseek.goal.maxModelRequests": 0,
  "keepseek.goal.maxCompletionReviews": 0,
  "keepseek.goal.autoResumeOnActivation": false
}
```

0 表示 unlimited，但创建面板会醒目标注，并以“开始 Goal”作为明确确认。正值 Goal 时间/费用上限与 `agent.maxExecutionMs` / `agent.maxCost` 取更严格者。active execution 是 Provider、活跃工具/子代理和宿主推进/reviewer 阶段的墙钟并集；paused、waiting、Host 停止与检测到的设备休眠不计。模型请求数覆盖主请求、重试、Context Epoch summary、子代理、completion reviewer 和 model approval reviewer。费用继续按币种分别累计，不换算；所有账本跨 attempt、epoch 与激活恢复延续。

Goal 独占 V10 request protocol，但 tools schema version 保持 V9；V10 system prompt 和工具集合/顺序/字节与 V9 完全相同，普通新 session、非 Goal 和 V1–V9 fixture 不变。活动 Goal 的审批结果、工具/副作用结果和 deterministic control item 进入独立 Goal replay，不伪造 `ChatSession.messages` user turn。Chat Completions 保存内部 messages/tool rounds，Responses 保存原生 Items，Anthropic 保存 system/messages blocks；终态 assistant 携带完整 Goal replay，使下一条真实用户消息能从精确 Provider 前缀继续。旧 `repair_until_validation_passes` BackgroundRun 入口只生成预填 Goal contract，不再使用内存轮数协调器。

## 连接状态

分别记录网络字节、已解析 SSE 事件/注释、正文/推理/工具参数、完整工具步骤的时间。界面自己的计时器仅展示静默提示，不充当服务端心跳，不请求模型。

- 正常正文或推理继续输出：继续原请求。
- 只有注释、ping、未知合法事件：显示连接仍有活动，不能据此断言任务有进展。
- 完全静默或还没响应头：显示等待/连接状态待确认，默认不自动断开。
- 断流、错误事件、未完成的协议对象：保留展示文字并中断；不把不完整工具参数、Thinking 签名或 Responses 对象当作完整响应执行/回放。

网络 POST 失败、空流及网关 5xx 无法证明供应商没有受理，因此不静默重发。明确 429 拒绝按原配置有限退避，退避可取消；重试次数持久化。保留原来最多一次的完整 length/pause_turn 续写，并保存续写位置；不再对部分断流自动创建续写请求。当前没有供应商任务查询或后台恢复服务，不声称能恢复供应商内部思考或停止远端计费。

协议依据：[OpenAI 流式响应](https://developers.openai.com/api/docs/guides/streaming-responses)、[Anthropic 流式 Messages](https://platform.claude.com/docs/en/build-with-claude/streaming)、[DeepSeek 保活说明](https://api-docs.deepseek.com/quick_start/rate_limit/)。对于自定义网关只以实际事件为证，不推断统一心跳周期。

## 检查点与恢复边界

沿用全局会话 Store 保存版本化检查点，包含任务/尝试关联、冻结输入（排除凭据）、来源指纹、时间与费用账本、完整工具轮、每个工具的结果和执行意图、草案、计划以及原生协议状态。子任务使用原有子任务 Store，同目录临时文件后原子替换为包含 metadata/transcript 的单条记录，兼容旧两文件读取。

每个完整步骤和模型请求前保存，流式展示与活动最多每 15 秒增量检查点保存一次，不按 Token 重写整个会话。命令提议和修改提议先可靠保存，再允许任务宣布完成。保存失败停止后续调度。恢复入口检查原模型、来源端点/协议、工具 schema、工作区、信任与外部授权；修改草案保留基线，Apply 仍检查文件变化和脏编辑器。

“继续任务”重用当前完整模型响应及已完成工具结果。未完成模型步骤会发起新请求，可能产生新用量。工具执行意图已保存、结果却未知时，入口阻止直接恢复并提示核实；本版不提供“忽略未知结果”按钮。请检查工具/命令实际状态后重新提问，不会自动重跑未知操作。已有新聊天消息、来源变化或文件基线变化也会阻止原位继续，避免重写已发送历史。

扩展重启后 `running` 检查点标为中断。没有自动恢复、自动 Apply、命令自动重跑或一次性许可复活。单个模型流及完整检查点各限 32 MiB；达到边界停止，必须回放的协议数据不静默截断。运行状态不进入 system、历史或工具 schema；兼容恢复不主动重置缓存，也不定时压缩历史。模型未完成步骤重新生成的新增后缀可能不同，这是重新请求的预期缓存/用量代价。

继续保留工具次数、验证次数、修复轮数、单命令超时、子任务并发/数量/深度与路径冲突限制。调度记录仅按任务生命周期释放，恢复时载入保存的树预算，不按存活时间清除。全局仍只运行原有允许的一项主任务；浏览/收起面板不更改运行所属会话，工作区切换先取消并等待旧任务保存。

## 验证

自动测试使用模拟流和可控单调时钟，不真实等待数十分钟：

```text
bun run compile
bun run lint
bun run build:test
bun run test
```

`test/longRunningAgent.test.ts` 覆盖两小时默认执行、有限预算、暂停计时范围、休眠/时钟倒退、队列取消与资源释放、长期路径保护、协议不完整/心跳、有限重试与静默取消、工具结果恢复、原生字节稳定以及保存失败前禁止工具执行。现有缓存、上下文估算、原生协议、DraftEdit/ChangeSet/DraftRun 和子任务用量回归继续运行。

人工验证（本次未执行真实扩展宿主/供应商长时验证）：

1. F5 启动扩展宿主，以 0 默认预算发起长推理。只收到推理或心跳时检查活动显示；完全静默应提示不确定，原请求数不增加。
2. 在主任务、子任务排队、授权弹窗和流式响应中点击停止，确认没有新请求/新工具启动，队列不再执行。收起重开面板不能中断原任务。
3. 生成草案后，在后续模型步骤断网或停止；检查草案、完整工具结果仍存在。“继续任务”应复用完成步骤，出现新尝试编号。连续点击只能开始一个尝试。
4. 在调试宿主运行时重载窗口，检查显示中断；原 DraftRun 不自动重跑。使用原来源/模型继续；切换来源、修改草案目标文件后应被拒绝。
5. 配置显式有效预算，等待授权/Apply 不消耗该预算；耗尽后“继续任务”不能清零绕过。验证/命令自身的超时继续有效。
6. 将全局存储置于不可写状态，确认停止后续执行并提示保存失败；恢复权限后检查上一份完整检查点。不要用生产工作区测试破坏性命令。

真实网关的心跳、限流、超时和计费行为需分别验证；本地停止不保证远端立即停止计费。关闭 VS Code 不会继续执行。
