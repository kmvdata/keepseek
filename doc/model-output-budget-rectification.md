# 单次输出预算整改与验收记录

日期：2026-10-30。范围：KeepSeek 仓库源码；没有发布、推送、安装 VSIX、修改生产来源配置或删除历史会话。

## 根因与规则

原链路虽然从模型目录读到 `maxOutputTokens`，Runner 又与工具 8192、回答 16384、续写 8192、修复 4096 的阶段配置取最小值；结果准入还按窗口的 8% / 22% / 4% 限制输出。DeepSeek Thinking 画像、摘要和 reviewer 的固定额度进一步造成不一致。正文续写又把单次输出额度当累计限制，按 tokens × 4 切正文。网络重试复用原请求字节本身是正确行为，但长度截断被归为 protocol 错误，Continue 没有有效的语义策略变化。

能力解析保留 accounts/modelCatalog 的来源隔离：用户手动值 → 来源发现值 → 已知模型内置能力 → 标记为 guessed 的模型家族声明 → 标记为 fallback 的未知能力回退。后两者不伪装成可信发现。sourceId + modelId 是选择键，endpoint/protocol 是校准与恢复 lane 的一部分。推理模式不降低手动值；用户后来修改能力，在下一新模型轮读取，同一网络重试仍保持冻结字节。

统一策略版本为 2：

```text
inputBudget = ceil(完整实际协议输入估算 × 校准估算系数)
actualOutput = min(本次模型有效 maxOutputTokens,
                   min(模型声明窗口, 当前 lane 校准窗口) - inputBudget - safety)
```

安全余量与证据 envelope、分页、存储资源限制各自独立。先尝试压缩/rollover，再重新投影；受保护输入仍无法容纳完整输出时按实际余量降低并记录原因；无合法输出空间时停止。没有阶段百分比、隐藏固定上限或正数保底。模型配置只是声明，供应商仍可能拒绝；原始拒绝和本次快照会保留，明确的输出参数拒绝不写成上下文缩小证据。

| 请求 | 上游字段 | 配额来源 |
| --- | --- | --- |
| Chat Completions / compatible | `max_tokens` | 本次实际模型快照 |
| Responses | `max_output_tokens` | 本次实际模型快照 |
| Anthropic Messages | `max_tokens` | 本次实际模型快照，校验 thinking budget 必须更小 |
| 续写 / 修复 / 子代理 / 摘要 / reviewer | 对应协议字段 | 各自模型，不能继承前一个或主模型额度 |

模型 393192、32768、8192 的工具、回答和续写请求均通过真实 serializer 测试，空间充足时分别发送原值。费用预留仍以声明窗口与价格上界计算，不把输入估算当成计费上界；任务 token、时间、费用、工具次数和模型轮物理请求预算保持独立。

## 改动定位

| 文件/子系统 | 改动 |
| --- | --- |
| `src/shared/outputBudget.ts`、`src/agent/requestBudget.ts` | 统一计算、真实协议输入估算、预算快照、校准加载、协议约束和 normalize |
| `accounts/modelCatalog.ts`（核对，未修改）、`shared/modelProfiles.ts` | 保留来源隔离和能力优先级，移除 Thinking 输出降额 |
| `package.json`、`shared/config.ts` | 四项旧阶段配置标记废弃，去除设置的 65536 上界；兼容 getter 不再被运行时使用，不重写 settings.json |
| `agent/runner.ts`、`toolResultAdmission.ts`、`contextUsage.ts` | 请求、结果准入、预留和显示使用同一额度；新模型轮刷新同源配置；固定网络字节与语义恢复分离 |
| `agent/historyCompressor.ts`、`historyProjection.ts` | 压缩考虑完整输出预留；摘要按自己的模型；失败不丢受保护/近期历史；截断摘要不推进覆盖范围 |
| `agent/providers/{streamParser,responsesStreamParser,anthropicStreamParser,streamErrors,types,openAiCompatibleClient}.ts` | 三协议结构化工具输出截断、整批禁止执行、有界 usage 收尾、不可网络重试 |
| `agent/runCheckpoint.ts`、`usageLedger.ts`、`shared/types.ts` | 策略版本、失败证据、迁移记录、能力快照、续写片段、兼容及损坏数据处理 |
| `approvals/{oneShotTextRequest,approvalReviewer}.ts` | reviewer 取实际模型额度，复用任务预算，截断回答不成为审批决定 |
| `provider/KeepseekChatViewProvider.ts`、`sessions/chatSessionStore.ts` | Continue 校验当前模型、按真实可恢复条件显示，规范化诊断 |
| `agent/logging/runDetails.ts`、`webview/script.ts`、`shared/i18n.ts` | 区分生成截断与执行失败；运行详情显示配置→实际、来源、输入/窗口/余量、结束原因、请求 ID、策略和迁移 hash |
| `test/modelOutputBudget.test.ts`、相关现有测试 | 配置到请求、解析、记账、持久化、恢复的行为集成测试；修正旧隐藏上限和丢受保护历史的断言 |
| `scripts/replay-output-truncation.cjs` | 只读离线回放，不打印原始正文、参数或认证信息 |

现有测试更新包括 accountRuntime、anthropicMessages、historyCompressor、historyProjection、modelProfiles、runBudgetP0、subagentArchitecture、toolResultBudget；入口为 runTests。

## 截断与恢复

工具批次遇到输出耗尽时返回 `ProviderToolOutputTruncatedError` / `KEEPSEEK_TOOL_OUTPUT_TRUNCATED`，区分普通 EOF、网络错误、内容过滤和完成后的非法 JSON。即使批次中的某个调用看似完整，也不执行整批；不补括号、不猜参数。已到达的 usage 和请求 ID 被保留，尾部最多等待现有 2 秒边界，取消连接有界；没有 usage 时明确未知，不当免费。

checkpoint 的 `outputFailure` 必须同时证明输出结束原因、工具不完整、本轮零执行、旧请求 hash、来源/model/lane 和旧预算。预算策略升级不取消普通 hash 校验。具备证明时，可以从本轮已提交起点恢复：有效额度增加，或首次附加“较小完整调用”的生成策略。旧/新策略、hash、额度与原因先持久化再发送，原 taskId、已完成 evidence、累计耗时/费用/tokens/请求次数均保留。分解后同额度再次截断则阻止原样 Continue，要求新消息缩小任务范围。不会因此新增 Apply/命令权限。

旧 checkpoint 缺省策略为 1。只有模糊错误文字的旧任务不做语义迁移；损坏/跨来源预算证据不能成为迁移依据。旧网络中断仍尝试正常精确恢复，hash 不一致时拒绝并说明新用户消息边界。原始日志的离线证明不会自动写入或修补用户历史 checkpoint。

正文续写保存累计完整文本和最后追加片段，去掉累计单次额度及字符切片；精确后缀/前缀去重，无进展明确停止。既有 `agent.maxContinuations` / invocation 次数策略保留且明确提示来源。续写压缩仍保留完整正文；独立 checkpoint/流资源边界保留，达到时明确报错，不把未完成内容当完成。

## 两个故障 Run 的实际离线结果

读取了本机 VS Code KeepSeek 的 2026-10-29 原始 interaction JSONL 日志，仅做只读回放；原始日志、提示词和工具参数未复制进仓库。

| Run ID | 原请求上限 | raw SSE 帧数 | 新解析器结果 | 原日志工具调用数 |
| --- | ---: | ---: | --- | ---: |
| `21257aba-ef6a-4262-b4c2-b5db99ac76a7` | 8192 | 2818 | 工具输出截断，finish=`length` | 0 |
| `71f5fbc3-8404-45ce-8d14-33aa16f9eeef` | 8192 | 2692 | 工具输出截断，finish=`length` | 0 |

两份原请求正文 SHA-256 均为 `3366be0ae708ae3d03ab88dfa7b9a9be35bbc7bb335f5696cafe346e96c1ccbb`。对原正文采用用户给定的模型能力 393192 / 1024000，新的完整输入估算为 296312，安全余量 4801，实际输出准入为 **393192**。这验证了本地预算不再压至 8192，并不能证明供应商接受 393192。

两份回放均未得到有效 usage，保持未知。回放不会执行任何工具或向供应商发送请求，也不会修改旧任务。可复现命令：

```bash
bun run build:test
node scripts/replay-output-truncation.cjs 393192 1024000 /path/to/first.jsonl /path/to/second.jsonl
```

## 验证与尚未验收项

最终自动化结果：

| 检查 | 结果 |
| --- | --- |
| `bun run compile` | 通过 |
| `bun run lint` | 通过 |
| `bun run build:test` | 通过 |
| `bun run test` | 741 项，740 通过、0 失败、1 跳过 |
| `git diff --check` | 通过 |
| 两个原始故障日志的只读离线回放 | 通过，结果见上表 |

唯一跳过项是既有本地 fault server/socket 测试，当前沙箱不允许绑定端口；基线也跳过该项。新增预算测试覆盖三协议、三个额度、同 ID 不同来源、发现/内置/fallback 能力到上游字段、独立子代理/摘要/reviewer、冻结重试与下一轮配置更新、混合工具截断零执行、旧策略受控迁移、完成 evidence 复用、损坏数据、长正文和续写压缩。既有网络、审批/副作用、取消、预算、存储和恢复回归已一并运行。

没有配置专用真实接口 opt-in、测试 endpoint 或测试 key，因此未发送新的真实接口请求。未通过 VS Code Extension Host/F5 做交互实测，未构建/安装 VSIX，用户当前运行扩展没有改变。自动化使用真实本地序列化/解析链路加协议 fixture；两份实际历史日志属于离线回放，不能替代线上验证。

正费用限制下，独立的运行前/后台历史摘要因为没有持久任务预留所有者而跳过；历史保留，运行时 epoch 压缩走共享任务账本。该边界明确报出原因，避免另起费用账本绕过累计限制。保护内容、超长正文或既有 32 MiB checkpoint 资源限制仍可能阻止继续，并给出明确原因。

## 更新后的操作

1. 用经验证的新构建更新扩展；如需市场 VSIX，使用 `bun run package:market`。本次未安装或替换运行中的扩展。
2. 在对应来源的模型设置中保留/修改 `maxOutputTokens` 和上下文窗口。无需设置旧四个阶段值；已填写的旧值显示废弃且不生效。
3. 对上述两个旧失败任务，如果 checkpoint 只有旧错误文本，保留当前会话并发送新消息，例如“继续上述任务，按较小的完整修改步骤生成”。这会建立明确的新请求边界；不用删除整个会话。
4. 对新版本保存了结构化截断证据的任务，可点“继续任务”：增加后的有效预算或首次小调用策略必须改变请求。分解仍失败时按提示发送新消息缩小范围，不反复点无效 Continue。
5. 在运行详情核对配置上限、实际额度与限制原因；新接口实测应核对发送 payload 与正常响应，不必故意生成几十万 tokens。若供应商拒绝配置值，按其明确能力修正对应来源模型，系统不会静默降回 8192。
