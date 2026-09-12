# 子代理运行时安全与兼容性

本文记录 KeepSeek 子代理的当前宿主契约。安全审批链和 DeepSeek 前缀缓存稳定性具有同等优先级；这里的路径租约、结果签收和复用索引都不能替代最终的 `ChangeSetStore`、`SafeFileEditor`、DraftRun action hash 与一次性 permit 检查。

## 1. 运行期工具闸门

子代理 profile 仍负责裁剪发给 Provider 的工具 schema，但真正的授权边界位于 `AgentRunner`。每次请求以实际投影给 Provider 的工具名称集合建立 allowlist；任何工具调用在权限判断、执行、proposal 收集和 validation 之前都要重新检查该集合。

原生 tool call、OpenAI Responses、Anthropic `tool_use`、DSML 兼容解析和 checkpoint 恢复共享同一入口。未暴露工具固定返回 `subagent_tool_not_exposed`，不执行，也不产生 DraftEdit、DraftRun 或 validation。只读 profile 在运行期没有草稿和执行类工具；达到最大深度后，委托工具同样不会被暴露，也不能借异常调用越过检查。

## 2. Proposal 路径租约

`paths` 会先用工作区 URI 规则解析为 `{rootId, segments}`，再进行分段层级判断。解析会处理 `.`、`..`、斜杠、多根工作区、工作区逃逸、目录边界和文件系统大小写语义。多根工作区中的相对路径必须明确根；无法证明归属的路径会被拒绝。

并行 proposal 在任何 child 启动前完成整批原子预检，检查以下冲突：

- 同批兄弟任务；
- 其他活动 proposal；
- 父运行已经持有的 DraftEdit；
- 父子或目录与文件的层级重叠。

具有写能力但没有可靠声明的单个 proposal 保守租用整个工作区；并行 proposal 必须声明路径。可能改变未知路径的 DraftRun 不进入并行 proposal 工具集合。child 完成后，宿主逐项把实际 DraftEdit URI 解析回相同作用域；任何越界产物都会导致结果签收失败，且不会被父运行合并。

## 3. 类型化结果与机械签收

新 child protocol lane 使用类型化 JSON envelope。当前任务尾部带有由原始 `DelegateTaskInput.task` 规范化生成的确定性 `taskHash`，结果必须原样回传该绑定；它不是随机 ID，也不授予权限。其余通用字段为 `status`、`summary`、`evidence` 和 `uncertainties`：

- research 允许灵活叙述，但 complete 结果必须给出明确证据；
- review 额外要求 `verdict`、`reviewedPaths` 和结构化 `findings`；每个 finding 至少包含 severity、标题、证据和影响，并尽量给出路径/行段；
- proposal 的产物数量和路径只由宿主实际收到的 DraftEdit/DraftRun 生成，不信任模型的文字声明。

空答案、通用兜底句、损坏 JSON、缺少必需交付物或越权产物不能成为 completed。格式错误最多触发一次同模型、无工具、关闭 Thinking 的格式修复请求；修复只能重排既有内容，仍失败则保存诊断并返回 failed。失败 checkpoint 中的草稿不会被降级包装为成功。

旧 child protocol 的 system 与 context 字节保持原样；新契约只在新版本追加。类型化 review 报告与 `model_review` 的严格副作用审批 JSON 是两条独立链路，后者的 action hash、拒绝不可重述和 permit 规则没有变化。

## 4. 稳定工作区上下文、continuation 与复用

child context 包含可冻结的工作区清单：稳定根 ID、显示名称、多根关系和相对路径约定，不包含不必要的绝对路径或动态 ID。清单 hash 与本轮精确外部 URI 授权集合都会参与 continuation 和复用兼容性；根结构或权限边界变化会使旧结果失效。父聊天历史、父工具输出和隐藏推理不会重新注入 child。

完成的 research/review 可进入同一父 session 的受限候选索引。自动复用必须同时精确匹配：规范化任务、profile、lane、来源账号和模型、模型配置、system、工具 schema、项目指令及工作区清单。结果还必须具有宿主从成功的精确文件读取中观测到、并在签收时复核内容一致的完整 read-set 指纹；宽范围搜索/目录/Git/语义状态、DSML 轮次、证据缺少路径、文件改变、文件无法读取或旧元数据缺失都会使新鲜度不可证明，此时不能自动视为新鲜。proposal 不自动复用。

复用会创建新的稳定 subagent 引用，并记录来源 subagent、来源父运行和 `fresh` 状态；不会复制私有 transcript、Provider replay 或工具轨迹。`continueSubagentId` 继续执行原有完整兼容性 hash 校验。

## 5. 模型、进度和失败诊断

用户可以在设置中按 workspace + profile 配置 research、review、proposal 模型。解析仍通过 `accountResolver` 的 sourceId + modelId 边界；缺失或不可用时 fail closed，不静默回退。模型只在 child 启动时解析，不改变父 Agent schema 或历史前缀，且子代理 Thinking 保持关闭。

Webview 只接收脱敏进度白名单：状态、阶段、工具类别、深度、profile、排队/运行耗时、父 tool-call 标识和受限诊断引用。允许阶段为 queued、searching、reading、analyzing、preparing_proposal、finalizing、completed、failed、stopped。任务正文、结果正文、完整错误、工具参数、文件内容、toolRounds、Provider replay 和 reasoning 均不会进入进度消息。

失败诊断按 subagent、父运行、trace/checkpoint 和失败类型关联，区分 provider failure、超时、取消、预算耗尽、协议错误、越权工具、结果签收失败和重启中断。诊断正文会做凭据与绝对路径脱敏，并受大小和七天保留期限制。扩展重启后遗留的 queued/running 只能归一为 stopped/interrupted，不会自动重放。

## 6. 用户显式入口

用户可在新消息开头使用 `/research`、`/review`、`/proposal` 或 `/parallel`。该选择保留在可见用户消息中，并只为当前轮追加稳定的选择尾部，引导模型调用已有 `delegate` / `delegate_parallel` 与相应 profile。它不会改写历史，也不会改变项目审批模式、提升工具权限或创建新的后台 job 基础设施。

## 7. 回归验证

相关测试集中在 `test/subagentSafety.test.ts`，并与现有子代理架构、用量统计、启动恢复、审批和协议冻结测试一起运行。任何 provider-visible system、工具 schema、description、字段或顺序变化都必须使用新协议版本，并为旧版本增加字节冻结断言。
