# 用户任务计时与归档后审批修复

基线：2026-11-02，`6c5246e`，0.5.0。保留原有 `.vscode/settings.json` 改动；未修改 `package.json`、`CHANGELOG.md`，未提交、安装、打包、发布或操作用户仓库的 tag/remote。

## 根因与修复

1. 原“本次时间”读取最后一个消息的 `runState.usedMs`。自动续跑创建新的 Runner 检查点，界面因此只显示最后一段。旧会话累计按执行 ID 取高水位，并非全部累计失效；缺少的是跨片段的用户任务归属和宿主实际工作时间。
2. `drainPersistence()` 完成持久化后会释放 completed checkpoint。审批入队原先只读 live `taskId`，随后错误回退到物理 `response.runId`；草稿身份校验跳过了操作，仍发送泛化完成续跑。

现在 `executionSegmentId()` 统一读取 live checkpoint 或 archive summary 的逻辑 `taskId`。trace ID 不再作为执行身份。真实草稿仍逐项校验 session、执行片段、actionHash/specHash、运行时审批与一次性 permit；不能可靠关联检查点时停止。归档优化保持开启。

宿主维护用户任务计时，覆盖请求准备、模型、压缩、工具、等待实际执行的子代理、reviewer、Apply、命令和继续分析。自动处理逐项记录 executed / denied / needs_authorization / failed / cancelled / already_processed / identity_mismatch / missing。前置编辑失败会阻止命令；阻塞时不调用模型、不发送“审批处理已完成”。阻塞证据在界面保留，并追加到下一条真实用户消息的尾部。成功续跑仅携带明确决定和真实执行结果。已完成或结果未知的操作都不会自动重跑。

## 计时口径与身份规则

| 项目 | 规则 |
| --- | --- |
| 本次时间 / Current run time | 一项用户任务处于实际自动工作状态的时间区间并集，单位毫秒；界面沿用 hh:mm:ss 与中英文天数格式。任务结束后保留。 |
| 会话累计 / Session total time | 保留会话内每项任务已发生的时间；不因编辑重发或可见历史分页退回。删除整个会话仍使用原有删除语义。 |
| 新任务 | 普通真实输入、编辑重发创建新用户任务，不通过“继续”等文本猜测归属。 |
| 继承任务 | 明确 Continue/恢复、审批续跑、命令/批量命令续跑、修复续跑、批准计划开始实施继承原任务。epoch、重试、输出续接本来就在同一片段内。 |
| 暂停后补充 | 普通停止后的新输入是新任务；Continue 按钮恢复原任务。现有 `no_progress_loop` 的补充输入入口仍是对原检查点的补充恢复，并继承计时和预算。计划修改输入生成新的用户任务；批准该新计划继承其发起消息。 |
| 暂停 | 人工审批/授权对话框、等待补充、停止后的空闲不计。模型审批属于实际工作。父侧等待正在工作的 child 计时，父子重叠只计一次。 |
| 重载 | 只恢复最后可靠保存的累计值，不保存可延续的运行时间戳，不累计离线时间。恢复计时不恢复批准。 |
| 性能 | 活动 scope 引用计数合并区间；1 秒轻量 `taskTiming` 消息刷新 UI，不触发每秒整会话落盘。流式展示不扫描全部消息。 |

展示账本与执行预算分离。增加宿主续跑的轻量预算继承，携带原有限额、已花时间、费用、模型/工具/Token 计数及子代理树额度，不复制旧执行状态、工具结果或批准。后续配置不能扩大已继承的较严格额度。Token、费用和缓存命中率的统计口径未改变。

## 持久化与兼容

| 字段 | 读取、迁移与恢复 |
| --- | --- |
| `ChatMessage.userTask` v1 | `id`、`originMessageId`、`reason`；宿主元数据，不改正文、expandedContent 或已发送字节。旧消息根据明确的 host continuation marker 或相同权威执行 ID 合并，补充要求保留。 |
| `ChatSession.executionTime` v2 | 保留旧 `byTask` 高水位；增加 `tasks`（origin、usedMs、segments、measured）与 currentTaskId。host measured 时间不再叠加 Runner 快照。重复、乱序和归档快照幂等处理。 |
| `ChatSession.userTaskBudgets` v1 | 保存已消耗预算与限制；需要时按 session/message 的内容寻址 checkpoint 回填。损坏的新限制不成为放宽预算的依据。 |
| `RunCheckpoint.budgetLimits` | 可选的冻结上限快照；旧 checkpoint 无此字段仍可读取，新字段校验有限非负整数。 |
| `ChatSession.approvalProcessing` v1 | 用户任务、执行片段、模式、逐项结果与原因；重载时 processing/pending 转为阻塞/取消，必须明确恢复。 |
| 外部副作用授权 | 仅运行时保存，绑定 session、目标、payload hash、精确 URI；与引用的只读授权分离。Stop、会话/模式切换、新任务及重载不复用待执行批准。 |

旧完整 checkpoint、归档 summary、`executionTime.byTask` 均可读取。可靠历史累计保留；无法确定的关联或缺少宿主时间的历史保留 incomplete 标记，不补造时间。编辑重发的旧耗时保留于会话账本。

主要变更位置：`sessions/userTask.ts`、`executionTimeStats.ts`、`userTaskBudget.ts`、`chatSessionStore.ts`、`globalSessionStorage.ts`；`provider/KeepseekChatViewProvider.ts`；`approvals/approvalProcessing.ts`、`approvalReviewSurface.ts`；`agent/runner.ts`、`runCheckpoint.ts`、`executionPolicy.ts`、`approvalMode.ts`、`tools/workspaceTools.ts`；`runs/draftRunScope.ts`、`draftRunStore.ts`、`draftRunProposal.ts`；`edits/changeSetStore.ts`、`safeFileEditor.ts`；共享 types/i18n、Webview 消息/卡片/用量脚本及相邻回归。

## 审批与外部范围

| 模式 | 项目内行为 | 阻塞行为 |
| --- | --- | --- |
| ask | 保留逐项用户 Apply/执行。草稿工具不新增确认。 | 外部 Apply 另问精确范围；等待不计时。Stop/切换会撤销尚未实施的操作。 |
| delegate | 硬检查后写 host_policy、“未经模型审查”记录再执行，不调用 reviewer；不因 delete、Git mutation 或 risk 标签高而一律退回人工。 | 外部或确实无法确定的命令范围要求用户确认精确操作。 |
| model_review | 使用现有默认子代理模型解析器、accountResolver，隔离一次性无工具 reviewer；approve 后执行。 | deny/unavailable 明确停止，无静默人工/自动降级，无普通按钮绕过 deny。 |

reviewer 使用**默认子代理模型设置**（跟随主模型或固定来源/模型）；菜单现在展示“默认／模型审批”行，方便选择和核对。研究、审查、提案 profile 的专属覆盖只用于对应普通子代理，不是独立审批模型配置。固定来源失效不回退。审核目标取当前用户任务的发起请求与真实补充要求；模型输出和工具 evidence 不作为新增授权。Run Details 展示任务/片段、审批与实际结果；内部 ID 不进入普通主界面。

外部读取需用户按既有引用机制精确授权。移除 delegate 自动加入外部 file URI，以及自动把 external cwd 加入授权的捷径。引用只读授权不能升级为写入或命令执行。文件移动同时检查源与目标；保留 dirty editor、hash、journal、symlink 等硬检查。

命令检查覆盖 cwd、可识别绝对/相对路径、符号链接、环境覆盖、简单显式 shell 和 package script。Git tag/push、网络 URL 不被笼统归为外部文件访问。不能可靠确定的程序需确认精确操作。此检查不是操作系统沙箱，不能证明任意程序、依赖安装钩子或 Git hook 不访问项目外；不作此保证。文件符号链接逃逸仍为硬拒绝，不能用授权弹窗解除。

## 自动化验证

执行本仓库四项标准检查，最终结果见本文件末尾验证记录。核心集成位于 `test/taskApprovalIntegration.test.ts`：真实 GlobalSessionStorage、ChatSessionStore、checkpoint 归档、ChangeSetStore/SafeFileEditor 与 DraftRunStore，通过实际 Provider 的 save/queue/execute 方法；逻辑 ID 故意不同于 trace ID。只有 reviewer 网络响应与普通命令执行器替换为确定性测试适配器。

- 两种自动模式归档后 Apply/命令执行恰好一次；delegate 不调用 reviewer，model_review 解析固定来源并实际走 reviewer 服务。
- 可控时钟：模型 10 秒 + 两次 reviewer 共 2 秒 + 命令 3 秒 + 后续模型 5 秒 = 20 秒；人工空闲 60 秒不计。并行 child 区间并集、停止/恢复、下一任务、重载、乱序高水位、可见历史为空均有回归。
- 错配/缺失、拒绝、Apply 失败、命令失败、重复、取消、预算继承、外部读取与执行授权分离、scope 弹窗期间 Stop、宿主及 Webview 中英文状态覆盖。
- 真实 tag/push 只发生在 `mkdtemp` 项目和同一临时目录的本地 bare remote。未对用户仓库执行这些操作。
- 现有测试继续覆盖三协议字节/replay、evidence 幂等、prepared journal、dirty/hash 冲突、reviewer JSON/重试/凭据与固定模型失败、permit/批量命令和长任务性能。

## 可执行现场验收（尚未现场验证）

本次执行的是自动化测试，未启动真实 VS Code 扩展宿主，未调用真实模型，未验证远程宿主或市场包 UI。以下步骤面向**本地 F5 Extension Development Host**，不能用测试适配器结果替代。

1. 在终端创建隔离验收目录，记录输出，不删除用户资料：

   ```bash
   keepseek_acceptance=$(mktemp -d)
   mkdir -p "$keepseek_acceptance/project" "$keepseek_acceptance/user-data" "$keepseek_acceptance/extensions"
   printf '%s\n' "$keepseek_acceptance"
   ```

2. 在源码窗口运行 `bun run compile`。使用 `.vscode/launch.json` 的 `Run KeepSeek Extension`；在本地调试配置临时添加参数 `--user-data-dir=<上面目录>/user-data`、`--extensions-dir=<上面目录>/extensions` 以及 `<上面目录>/project`，保持 `--extensionDevelopmentPath=${workspaceFolder}`。不要提交这些本地验收参数。按 F5，在开发宿主打开并信任该临时 project。只在该隔离宿主配置验收模型凭据。
3. 在源码 `KeepseekChatViewProvider.sendPrompt` 设置断点，发起简单请求，确认命中本仓库源码；`Developer: Show Running Extensions` 确认是本地开发的 keepseek.keepseek。检查调试器 `this.globalStorageUri.fsPath` 确实位于隔离 user-data。若实际加载已安装旧扩展或 remote host，停止验收并更正入口。
4. **ask**：要求“创建 sample.txt，随后修改它，并准备 node --version”。逐项检查草稿未提前写盘/执行；卡片显示等待用户批准。等待一分钟，本次时间不增加；逐项批准后有真实结果。
5. **delegate**：新建会话，用户切到自动批准。要求“一项任务内创建 result.txt，准备 node --version，执行后继续分析结果”。应自动 Apply 和执行，无逐项确认；工具回执明确“尚未执行”，结果回来才声称完成。跨模型、Apply、命令及续跑观察本次时间单调不减，停止后保留。
6. **model_review**：在默认子代理设置固定一个可用、可区别于主模型的模型，切到模型审批，重复文件/命令任务。检查真实供应商请求或调试日志和 Run Details 的来源、模型、决定及用量。批准后自动执行。用与请求不符的草稿检查拒绝；固定模型断开凭据检查 unavailable；两者均停止且给原因，不变回人工审批。真实模型可能不会对某个指定测试提示必然拒绝，必须以实际记录判定，不能预填结果。
7. **第二项任务**：同一会话完成第一项后发送不同的新问题。本次从零起，会话累计保留第一项。第二项 reviewer 的 originalGoalSummary 应是第二项；对第一项消息编辑重发同样开始新任务，累计不退回。
8. **外部路径**：只使用上述临时目录，要求读取 project 外的 sample 文件，先观察精确引用授权要求；引用后可读。再请求修改它或在外部 cwd 执行命令，必须另问副作用范围。确认后按当前模式处理；移动时检查源和目标均显示。测试 project 内指向外部的 symlink，硬拒绝仍生效。检查停止授权弹窗后再确认不会执行。
9. **Stop/恢复/重载**：模型或临时命令运行时 Stop，待取消收尾后等待一分钟，计时不再增加；使用 Continue 恢复同一任务。保留一个 pending 草稿并 Reload Window，不能自动执行或复用批准。手动点击“恢复当前模式处理”，才重新校验身份、范围并按当前模式审核。未知结果必须先人工核实，不能重跑。切回 ask 撤销排队自动操作；忙碌时其他模式不可切换。
10. **真实归档**：在 `executeDelegatedApprovals` 入口设断点，在 `saveAgentCheckpoint` 已完成 `sessionStore.persist()` 之后检查对应 assistant：`runCheckpoint === undefined`，`runCheckpointArchive.summary.taskId` 存在且与草稿 runId/agentRunId 相同，与 `response.runId` 不同。记下真实 globalStorage 路径和 archive.objectHash，核对该 session 的对象/manifest 持久化引用。继续运行，确认实际写盘/命令、审批记录及续跑各一次。只在 live checkpoint 尚在时通过不算本项通过。
11. 按需要切换中文/英文、检查输入/拖拽/@、会话切换、设置、Apply/Discard、键盘和焦点，确认 fragment 装配未回归。需验收市场包时仅运行 `bun run package:market`，由验收人员在隔离宿主手动加载；本次未运行该命令。

现有 pending 草稿：单纯加载只恢复状态；有可靠 session/message/checkpoint 关联的草稿可由用户显式恢复后处理。缺失/错配的旧草稿不强行改属，也不猜测 trace ID；应核实现状并重新准备。已执行/未知结果不自动重做。

## 明确限制

- 系统休眠、宿主阻塞无法全部精确区分，活跃 scope 内无法确认的挂起未作虚构扣除。
- 崩溃只恢复已保存时间；最后一次可靠保存以后的短暂活动可能丢失，离线时长不会补算。
- 老历史缺少宿主计时或可靠任务关联时只能保留已知高水位并标记不完整。
- 当前只有最后一批 approvalProcessing 的摘要；既有 Run Details/审批记录保留各操作的审查证据。
- 静态命令范围检查有上述边界；真实模型、真实 VS Code UI、远程宿主及发布包仍需按清单现场验证。

## 验证记录

2026-11-02 实际执行：

| 检查 | 结果 |
| --- | --- |
| `bun run compile` | 通过 |
| `bun run lint` | 通过 |
| `bun run build:test` | 通过 |
| `bun run test` | 全量 868 项：867 通过、0 失败、1 跳过；约 144 秒 |
| 补充的冷启动真实存储回归 | 编译后独立执行 1 项，通过；重新创建 session、edit、run、approval store 后，加载不执行，显式恢复执行一次 |
| `git diff --check` | 通过 |

唯一跳过项为本地故障 HTTP 服务器测试：当前沙箱禁止绑定监听端口。未删除测试或将该项宣称通过。补充测试命令：

```bash
node --require ./out-test/test/registerVscodeStub.js --test \
  --test-name-pattern='reloaded pending drafts' \
  out-test/test/taskApprovalIntegration.test.js
```

全量测试运行后仅增加了上述冷启动测试（产品代码未再变化），并重新执行 `bun run build:test` 与该单项。真实模型、F5 UI、远程宿主、市场包均未现场验证。不要将测试中的固定 reviewer 网络适配器当作真实模型调用成功。
