# KeepSeek 开发文档导航

当前发布以 **0.5.2 为初始数据基线**；旧版本导入与兼容已移除。身份、原生存储位置、离线重置和验收见[存储基线](keepseek-storage-baseline.md)。本页历史证据中的迁移说明不再作为当前运行合同。

本文是定位入口。当前行为以源码与契约测试为准，开发要求见 [AGENTS.md](../AGENTS.md)。下表的专题各负责一个范围；历史验收只证明其记录的基线与环境，不代表当前版本已经现场验收。

## 当前专题

| 要解决的问题 | 唯一专题入口 | 首要源码与保护测试 |
| --- | --- | --- |
| 从哪里修改、状态由谁负责 | [代码架构地图](keepseek-code-architecture.md) | `src/extension.ts`、`src/provider/`；`startupPerformance`、`contextEntryPoints` |
| 工程执行隔离、独立模型审批、精确远端授权与恢复 | [帮我审批](keepseek-approve-for-me-verification.md) | `approvalReviewer.ts`、`projectExecutionIsolation.ts`、`authorization/`；`approvalReviewer`、`taskApprovalIntegration` |
| 请求、工具、副作用、续跑与恢复的顺序 | [Agent 运行时](keepseek-agent-runtime-workflow.md) | `agentRequestCoordinator.ts`、`runner.ts`、`runCheckpoint.ts`；`longRunningAgent`、`taskApprovalIntegration` |
| 稳定前缀、投影、压缩、容量与缓存 | [缓存与上下文投影](cache_keepseek.md) | `providerRequestProjection.ts`、`historyProjection.ts`；`cacheByteStability`、`protocolCache`、`modelOutputBudget` |
| 编辑重发、历史操作归属、持久化恢复与前缀保护 | [编辑重发验收](keepseek-edit-resend-verification.md) | `sessions/historyTruncation*`、DraftRun/ChangeSet Store；`editUserPrompt`、`historyTruncation`、`historyTruncationContext` |
| 命令能力诊断、纠错、依赖与执行证据 | [命令纠错与验收](keepseek-command-recovery-verification.md) | `commandCapability.ts`、`commandRecovery.ts`、`draftRunDependencies.ts`；`commandCapabilityRuntime`、`draftRunQueryIntegration` |
| 三协议 payload 与 replay lane | [API Payload](keepseek-api-payload-reference.md) | `agent/providers/`；`openAiResponses`、`anthropicMessages`、`kimiGlmProviders`、`qwenCloudProvider` |
| 子代理隔离、结果合同、分页与父验收 | [SUBAGENTS](../SUBAGENTS.md) | `agent/subagents/`、`delegation.ts`；`subagentSafety`、`p1Delegation`、`p1ProtocolDelivery` |
| 共享指令、配置子集与普通 Skills | [共享 Codex 配置](keepseek-codex-shared-config.md) | `context/shared*`、`projectInstructions.ts`、`skills/`；`projectInstructions`、`skillDiscovery`、`skillActivationResolver` |
| 已暂停的 Codex 插件 Skills 与历史读取边界 | [插件 Skills](keepseek-codex-plugin-skills.md) | `codexPluginSupport.ts`、`pluginSkillRuntime.ts`；`skillDiscovery`、`skillActivationResolver`、`p1ProtocolDelivery` |
| 引用语法、授权与打开 | [文件引用规范](keepseek-file-reference-spec.md) | `context/references/`；`fileReference`、`fileReferenceOpener`、`referenceResources` |
| 首次加载、输入框状态、会话导航、提交与异步拥有者 | [交互生命周期](keepseek-interaction-lifecycle.md) | `provider/interactionState.ts`、Host/Webview 状态入口、`sharedProjectSources.ts`；`sessionNavigation`、`startupPerformance`、`interactionState`、`inputComposition` |
| 输入、fragment、消息、快捷键 | [架构地图的 Host/Webview 入口](keepseek-code-architecture.md#2-宿主与-webview) | `webview/input/composition.ts`、`richTextShortcuts.ts`；`inputComposition`、`richTextShortcuts` |
| 横向空间、菜单边界与默认右侧容器 | [Webview 布局](keepseek-webview-layout.md) | `webview/styles.ts`、input 样式、`package.json`；`contextEntryPoints`、`scripts/verify-webview-layout.cjs` |
| Markdown 列表连续编号、嵌套结构与复制原文 | [Markdown 列表渲染](keepseek-markdown-rendering.md) | `webview/script.ts`、`webview/styles.ts`；`markdownRendering` |
| 本次任务与会话累计有效计时 | [计时口径](execution-time-statistics.md) | `sessions/executionTimeStats.ts`、`userTask.ts`；`executionTimeStats`、`usageStats` |
| 手动按天/全部清理、使用保护、删除日志与恢复 | [历史清理](keepseek-history-cleanup.md) | `sessions/sessionHistoryCleanup.ts`、`sessionDeletionAuthority.ts`、所属 Store；`sessionHistoryCleanup`、`sessionDeletionAuthority` |
| 用户指令保存后并行命名、首次有效标题永久停止与手动最近两条输入 | [会话标题](keepseek-session-title-verification.md) | `sessions/sessionTitle*`、`provider/sessionTitle*`；`sessionTitle`、`sessionTitleStorage`、`sessionTitleCompletion`、`sessionTitleRequest`、`sessionTitleWebview`、`sessionTitleRegeneration` |

表中的测试名对应 `test/<name>.test.ts`，默认入口是 [test/runTests.ts](../test/runTests.ts)。独立脚本是否需要执行由任务决定，不以未接入默认 runner 判定其无效。共享配置与插件专题内的版本探测、已通过项和限制保留其原始核验日期。[Composer 复刻规格](keepseek-composer-spec.md) 和 [移植骨架](keepseek-composer-porting-guide.md) 是面向其他技术栈的参考设计，不是当前 KeepSeek 的源码目录或 Host 消息规范。

## 版本维度

以下是 2026-11-11 当前源码合同。改动时先查符号，不把一个维度的数字批量替换到其他维度。

| 维度 | 当前写入/选择 | 源码权威 | 校验与冻结规则 |
| --- | --- | --- | --- |
| 父会话 request protocol | 15 | [providerRequestProjection.ts](../src/agent/providerRequestProjection.ts) 的 `CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION` | 仅接受当前协议，保存 `requestProtocol`；当前 lane 的前缀逐字节冻结 |
| 父会话 tool schema | 15 | 同文件 `CURRENT_PROVIDER_TOOL_SCHEMA_VERSION`，schema 正文在 [protocol.ts](../src/agent/protocol.ts) | 仅当前 schema；工具集合与排序按会话冻结 |
| 委托审批交付协议 | 13 | [approvalMode.ts](../src/agent/approvalMode.ts) 的 `DELEGATED_APPROVAL_PROTOCOL_VERSION` | 仅当前 ask/delegate；批准绑定当前策略与 runtime |
| 审批策略 | 9 | [approvalReviewTypes.ts](../src/approvals/approvalReviewTypes.ts) 的 `APPROVAL_POLICY_VERSION` | 新授权仅用当前策略与 runtime，旧策略保留审计与适用的安全拒绝 |
| 审批审计存储 | 1 | [approvalReviewStore.ts](../src/approvals/approvalReviewStore.ts) 的 `approval-reviews.json` | 容器沿用当前格式，记录的策略版本单独校验 |
| child runtime 协议 | 15 | [subagents/runtime.ts](../src/agent/subagents/runtime.ts) 的私有 `SUBAGENT_PROTOCOL_VERSION` | 与父会话共用当前协议常量，child 的上下文与状态仍独立 |
| child 结果合同与 handoff | 合同 2、manifest 3 | [resultEnvelope.ts](../src/agent/subagents/resultEnvelope.ts)、[handoff.ts](../src/agent/subagents/handoff.ts)、[types.ts](../src/agent/subagents/types.ts) | 仅当前合同与 manifest；结果生命周期、结构验收和父采纳分别记录 |
| 宿主 capsule / 结果索引 | 均为 1 | [contextCapsule.ts](../src/agent/subagents/contextCapsule.ts)、[resultIndex.ts](../src/agent/subagents/resultIndex.ts) | capsule hash/scope 核验；索引保存 canonical 结果，不为读取一页解码私有 transcript |
| workspace 索引、全局 manifest | 均为 2 | [globalSessionStorage.ts](../src/sessions/globalSessionStorage.ts) 的对应接口 | 存储目录 `chat-sessions/v2` 不表示 shard 内容仅为 V2 |
| session shard / 对象图 | 仅 4 | [sessionObjectStore.ts](../src/sessions/sessionObjectStore.ts) 的 `SessionManifest` 与 `save()` | hash/scope/revision/锁及对象先于 manifest 提交，不读取旧 shard |
| 请求用量账本存储 | 2 | [usageLedgerStore.ts](../src/agent/usageLedgerStore.ts) 的 `USAGE_LEDGER_STORE_SCHEMA_VERSION` | 请求级幂等，按 session 分桶；不随 Provider 协议提升 |

内部移动或控制流简化不构成协议升级理由，也不能重录 system/tool/payload 冻结 fixture 来掩盖字节变化。

## 历史证据

以下记录按各自日期、HEAD、fixture 与验证环境阅读。当前审批行为由运行时专题和源码描述；旧“自动审批”“模型审批”报告不能作为恢复旧产品入口的依据。

| 历史主题 | 证据入口 | 当前阅读边界 |
| --- | --- | --- |
| 审批迭代 | [审批安全](keepseek-approval-safety-verification.md)、[全自动审批](keepseek-zero-click-approval-verification.md)、[帮我审批交付](keepseek-approve-for-me-verification.md) | 前两份记录旧模式；最后一份含 v9 当前合同和分列的历史验证 |
| 长任务整改与续接 | [整改](long-task-performance-rectification.md)、[续接](long-task-rectification-resume-report.md)、[输出预算整改](model-output-budget-rectification.md) | 故障、测量与限制保留；最新状态机查 runtime/checkpoint/projection |
| 子代理 P0/P1 | [P0 持久化](keepseek-p0-subagent-persistence.md)、[P1 可靠性](keepseek-p1-subagent-reliability.md)、[现场验收](keepseek-p1-field-acceptance.md) | 不将历史 V11 父协议说明当作当前父协议常量 |
| 布局与计时修复 | [审批卡片](approval-card-layout-verification.md)、[计时与审批](keepseek-task-timing-approval-fix-20261102.md) | 保留当时截图/观察；当前菜单及计时口径查对应当前入口 |
| 功能保持型重构 | [重构验收](keepseek-refactor-verification.md) | 基线、清理账目、当前范围与真实验证；不替代上面的专题合同 |

旧协议冻结 fixture 已退出当前测试合同；历史基准仅作为历史证据。当前协议仅验证 V15。其余 JSON 先核脚本与测试消费者，再决定保留或归档；文件日期不构成删除证据。

## 验证入口

```bash
bun run compile
bun run lint
bun run build:test
bun run test
bun run package:market
```

市场包脚本清理 `out/`、重新编译、带运行依赖并执行 `verify-vsix.js`；本地打包不等于发布或安装。真实模型、原生 VS Code UI 和其他平台的现场验证必须另列证据，不能由 stub 回归推定通过。
