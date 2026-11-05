# KeepSeek 代码架构地图

本页按职责定位当前实现，不保存历史阶段的完整报告。开发约束见 [AGENTS.md](../AGENTS.md)，运行顺序见 [Agent 运行时](keepseek-agent-runtime-workflow.md)，专题与不同版本维度见 [文档导航](README.md)。源码与说明冲突时先追踪调用和测试。

## 1. 启动与依赖方向

KeepSeek 在 VS Code Extension Host 内运行。`package.json` 定义 commands/views/keybindings/menus、配置和 `main: ./out/extension.js`；[extension.ts](../src/extension.ts) 的 `activate()` 创建 `GlobalSessionStorage`、`ChatSessionStore`、`KeepseekChatViewProvider`，尽早注册 `keepseek.chat`，再异步迁移并初始化当前 workspace 会话。配置、工作区、信任与文件事件由这里接线，不在激活入口放业务规则。

```mermaid
flowchart TD
  E["extension.ts"] --> P["KeepseekChatViewProvider"]
  W["Webview 消息与状态"] <--> P
  P --> A["AgentRequestCoordinator / AgentLoop"]
  P --> S["会话、来源、上下文服务"]
  P --> D["审批、文件与命令服务"]
  A --> N["请求投影与协议客户端"]
  A --> T["工具、Evidence 与子代理"]
```

`src/provider/` 是 VS Code/Webview 协调层，`src/agent/providers/` 是上游 API 层。领域规则下沉到所属模块；底层服务不回调整个 Provider，也不另建授权、请求投影或副作用执行权威。

## 2. 宿主与 Webview

| 入口 | 当前职责 | 变更时一起核对 |
| --- | --- | --- |
| [KeepseekChatViewProvider.ts](../src/provider/KeepseekChatViewProvider.ts) | 生命周期、`handleMessage()`、`sendPromptImpl()`、会话和运行协调、审批队列、`postState()` | 对应领域 service、消息联合类型、Host 行为测试 |
| [webviewMessages.ts](../src/provider/webviewMessages.ts) | 唯一 Webview → Host 消息联合类型 | 发送 fragment 与 `handleMessage()`；Host 主动消息不加入此联合 |
| [modelSelection.ts](../src/provider/modelSelection.ts) | 主模型切换事务、运行限制、lane 影响 | catalog、session requestProtocol、replay |
| [requestTimeoutSettings.ts](../src/provider/requestTimeoutSettings.ts) | 统一模型请求超时设置 | config/i18n 与所有模型请求入口 |
| [html.ts](../src/webview/html.ts) | CSP、nonce、资源 URI、首次 ready bootstrap | ready 之前的消息暂存和初始化门禁 |
| [script.ts](../src/webview/script.ts) | transcript、会话、状态/设置渲染、Host 消息监听 | DOM id、状态投影、编辑重发、Apply/Discard |
| [input/composition.ts](../src/webview/input/composition.ts) | 输入模板、样式、脚本 fragment 固定拼装顺序 | 同一 IIFE 的词法依赖和监听顺序；优先保持生成字节 |
| [richTextShortcuts.ts](../src/webview/richTextShortcuts.ts) | 两个编辑器共享快捷键 | 输入框与编辑重发的键盘/焦点行为 |

Webview 是字符串生成的页面，不是独立前端应用。`input/composer/` 管编辑/序列化，`references/` 管引用与拖拽，`commandMenu/` 管菜单，`usage/` 管用量详情，`dialogs/` 管各设置对话框。样式、模板、行为保持各自 fragment 所有权。

首次 `ready` 先获得轻量状态；会话与副作用恢复未就绪时拒绝相关写操作。消息 type、DOM id、引用格式、CSP/转义和公开控制接口都是行为契约。

当前菜单 `/` → 审批模式只有 ask/delegate；`/` → 子代理模型 → 审批模型与其他模型选择共用交互层级，但审批配置单独取用户级 `keepseek.autoApprovalReviewer`。普通子代理 default/research/review/proposal 不为审批 reviewer 提供默认值。

## 3. 来源、上下文与 Skills

| 模块 | 权威职责 |
| --- | --- |
| [accountStore.ts](../src/accounts/accountStore.ts)、[modelSourceService.ts](../src/accounts/modelSourceService.ts) | 来源 CRUD、缓存与面向 UI 的来源操作 |
| [accountResolver.ts](../src/accounts/accountResolver.ts) | 凭据、endpoint、协议与来源语义的唯一运行时解析入口；主请求、摘要、reviewer、child、发现和余额共用 |
| [modelCatalog.ts](../src/accounts/modelCatalog.ts)、[defaultModelStore.ts](../src/accounts/defaultModelStore.ts) | sourceId+modelId 身份、能力、全局默认与项目选择 |
| [subagentSettingsStore.ts](../src/accounts/subagentSettingsStore.ts)、[subagentModelResolver.ts](../src/accounts/subagentModelResolver.ts) | 普通子代理设置和运行前冻结 |
| [sharedConfigPaths.ts](../src/context/sharedConfigPaths.ts)、[sharedCodexConfig.ts](../src/context/sharedCodexConfig.ts) | 宿主路径/Git scope、有界读取、TOML 白名单和来源诊断 |
| [SharedProjectSources](../src/context/sharedProjectSources.ts)、[projectInstructions.ts](../src/agent/projectInstructions.ts) | 全局与任务 root→cwd 指令、普通 Skills 和配置的受控快照 |
| [promptReferences.ts](../src/context/references/promptReferences.ts) | 目录→文件→Skill 的展开顺序；外部精确 URI 授权 |
| [currentRunContext.ts](../src/agent/currentRunContext.ts)、[contextDeduplication.ts](../src/agent/contextDeduplication.ts) | 当前上下文拼装与去重，稳定 `contextInstructions` |
| [skillDiscovery.ts](../src/skills/skillDiscovery.ts)、[skillMetadata.ts](../src/skills/skillMetadata.ts) | 标准 `.agents/skills` 根发现、YAML 元数据和策略 |
| [skillActivationResolver.ts](../src/skills/skillActivationResolver.ts)、[skillLoader.ts](../src/skills/skillLoader.ts) | explicit→session→workspace-default→implicit；有界读取与隐式冻结 |
| [codexPluginSupport.ts](../src/skills/codexPluginSupport.ts)、[codexPluginDiscovery.ts](../src/skills/codexPluginDiscovery.ts)、[codexPluginResources.ts](../src/skills/codexPluginResources.ts)、[pluginSkillRuntime.ts](../src/agent/pluginSkillRuntime.ts) | 插件 Skills 暂停开关；安装/资源底层和历史数据保留，当前不发现、不加载、不执行或恢复插件任务 |

任务目录来自用户选择或单根默认，不随焦点/附件变化。共享文件只读；发现/加载 Skill 不执行 scripts。普通项目 Skill 创建只准备 `SKILL.md` 与 `agents/openai.yaml` 的 ChangeSet，实际落盘仍走文件审批。插件入口不扩大通用文件、cwd、child 或写入授权。

旧 `.keepseek/memory.json` 当前扫描、迁移和注入已移除；历史 `legacy-memory` 审计、旧 `contextInstructions` 与冻结 system 里的旧措辞仍需保留。不能按当前没有产品入口误删兼容读取。

共享子集与版本差异查 [共享配置](keepseek-codex-shared-config.md)，插件安装与能力边界查 [插件 Skills](keepseek-codex-plugin-skills.md)，引用语法查 [文件引用](keepseek-file-reference-spec.md)。

## 4. 请求、循环与长任务

| 关注点 | 权威入口 | 数据与边界 |
| --- | --- | --- |
| 请求快照 | [AgentRequestCoordinator](../src/agent/agentRequestCoordinator.ts) | 会话快照、归档与摘要刷新；送入 Runner |
| 主循环 | [runner.ts](../src/agent/runner.ts) 的 `AgentLoop` / `AgentRunner` | 模型轮、工具路由、容量/epoch、输出接续；只生成 DraftEdit/DraftRun |
| 静态字节 | [protocol.ts](../src/agent/protocol.ts) | system、工具名称/排序/schema、持久化 user 展开字节 |
| 三协议投影 | [providerRequestProjection.ts](../src/agent/providerRequestProjection.ts) 的 `buildProviderRequestProjection()` | 实际 payload、token 估算、压缩、准入与硬上限共用；禁止分别重建 messages/tools |
| 历史投影 | [historyProjection.ts](../src/agent/historyProjection.ts)、[historyCompressor.ts](../src/agent/historyCompressor.ts)、[historyArchive.ts](../src/agent/historyArchive.ts) | 摘要与保护/近期消息只改变 projection；UI 历史 append-only |
| 容量与输出 | [outputBudget.ts](../src/shared/outputBudget.ts)、[requestBudget.ts](../src/agent/requestBudget.ts)、[toolResultAdmission.ts](../src/agent/toolResultAdmission.ts) | 用户模型输出上限、真实投影、来源隔离有效窗口；不恢复固定累计结果预算 |
| context-too-long | [contextWindowCalibrationStore.ts](../src/agent/contextWindowCalibrationStore.ts) | 按 source/endpoint/model 校准；无进展要改变策略 |
| Evidence | [evidence/store.ts](../src/agent/evidence/store.ts)、[shaping.ts](../src/agent/evidence/shaping.ts) | intent→执行→完整 evidence/hash→一次固定 Provider-visible envelope；分页/作用域复核 |
| epoch/恢复 | [contextEpoch.ts](../src/agent/contextEpoch.ts)、[runCheckpoint.ts](../src/agent/runCheckpoint.ts) | 同 task 保留计划、幂等、审批、副作用、验证和用量；已完成工具不重跑、未知副作用不重试 |
| 执行控制 | [executionMode.ts](../src/agent/executionMode.ts)、[executionPolicy.ts](../src/agent/executionPolicy.ts)、[repairLoop.ts](../src/agent/repairLoop.ts)、[backgroundRunCoordinator.ts](../src/agent/backgroundRunCoordinator.ts) | normal/plan 与审批正交，预算 grant、修复和显式后台任务 |

`providers/factory.ts` 根据来源选择客户端；Chat Completions、OpenAI Responses、Anthropic Messages 各有请求/流解析实现。`toolRounds` 保存 Chat Completions 工具轮，`providerReplay` 保存 Responses/Anthropic 原生块；仅同 protocol/source/endpoint lane 回放。Ollama 与官方预设的差异留在客户端/能力层。

`agent/tools/` 负责 workspace/semantic/Git 读取和固定 compile/lint/test 验证。schema 在 `protocol.ts`，Runner 负责分发，独立 service 负责具体实现；Git mutation 只能生成 DraftRun。

调用链：真实 user → 引用展开与同字节持久化 → Coordinator → Runner → 唯一请求投影 → 原生客户端 → 工具事务/Evidence → `AgentResponse` → Provider 保存消息/replay/用量并推送状态。摘要刷新与 epoch 是受控缓存边界，不是新任务或授权。

## 5. 审批与副作用

| 子系统 | 当前职责 |
| --- | --- |
| [approvalMode.ts](../src/agent/approvalMode.ts) | ask/delegate 归一化、稳定 user-tail、易失性 `DelegatedApprovalQueue` |
| [approvalReviewTypes.ts](../src/approvals/approvalReviewTypes.ts)、[approvalReviewHash.ts](../src/approvals/approvalReviewHash.ts)、[approvalReviewSurface.ts](../src/approvals/approvalReviewSurface.ts) | 精确 action、完整 canonical hash、有界 review 面 |
| [authorization/](../src/approvals/authorization/index.ts) | 信任、外部精确范围、实际程序/环境身份、command effects、实时 preflight 和最终复核 |
| [approvalPolicy.ts](../src/approvals/approvalPolicy.ts)、[approvalReviewer.ts](../src/approvals/approvalReviewer.ts)、[oneShotTextRequest.ts](../src/approvals/oneShotTextRequest.ts) | 宿主策略/独立无工具 reviewer、JSON 决定、来源解析与真实记录 |
| [manualApproval.ts](../src/approvals/manualApproval.ts)、[approvalProcessing.ts](../src/approvals/approvalProcessing.ts) | runtime 绑定的单次人工生命周期；`createApprovalProcessing()` / `isCompletedApprovalBatch()` 管批次初始化与幂等判定、依赖及有界补规划状态 |
| [approvalReviewStore.ts](../src/approvals/approvalReviewStore.ts)、[approvalCircuitBreaker.ts](../src/approvals/approvalCircuitBreaker.ts) | append-only 审计、消费绑定、拒绝熔断 |
| [draftEdit.ts](../src/edits/draftEdit.ts)、[textPatch.ts](../src/edits/textPatch.ts) | 版本化 DraftEdit 与 canonical byte hunks；URI/base/result hash/size/encoding/EOL 是 Apply 权威 |
| [changeSetStore.ts](../src/edits/changeSetStore.ts)、[safeFileEditor.ts](../src/edits/safeFileEditor.ts) | ChangeSet 状态、preflight、prepared journal、base 复核、原子替换与 read-back；大内容由 artifact store 寻址 |
| [draftRunProposal.ts](../src/runs/draftRunProposal.ts)、[draftRunStore.ts](../src/runs/draftRunStore.ts) | immutable executable/argv/cwd/env/specHash、pending/运行/终态与输出 |
| [draftRunAuthorization.ts](../src/runs/draftRunAuthorization.ts)、[draftRunExecutor.ts](../src/runs/draftRunExecutor.ts) | draftRunId+specHash 绑定的短时单次 permit；`spawn(..., { shell:false })`、取消/超时 |
| [gitReleaseBatch.ts](../src/runs/gitReleaseBatch.ts)、[gitReleaseAuthorization.ts](../src/runs/gitReleaseAuthorization.ts)、[localGitCommit.ts](../src/runs/localGitCommit.ts) | Git 本地提交/发布的精确任务意图、依赖批次、证据与范围；不成为另一条执行通道 |

ask 由用户逐项/批量批准；delegate 对符合宿主规则的常规操作先写 `host_policy`，其余可核实动作自动交独立 reviewer。approve、needs_user、deny、unavailable 含义不同；有界补证后仍无法判断时，仅宿主创建绑定 session/root task/segment/target/hash/scope/runtime 的单次人工请求。安全拒绝不能被人工强行放行。人工批准保持模式，不扩大永久权限，执行前仍复核。

所有路径保留信任、外部 URI/cwd、脏编辑器、hash/状态、取消等硬检查。进程使用扩展宿主账号权限，无操作系统沙箱。重启只恢复说明与可证明状态，不恢复队列、批准或 permit；关闭 Webview 保留人工等待。决定和真实结果只追加到下一条真实 user 的固定 tail。

文件链：模型草案 → ChangeSet → 审批/Apply → SafeFileEditor → journal/hash/原子写/read-back → 真实结果。命令链：模型草案 → pending DraftRun → 审批 → 单次 permit → executor → 终态。Runner/Provider 不直接写工作区；shell 语法必须以 shell executable 与完整 argv 可见。

## 6. 子代理与用量

`SubagentRuntime` 为每个 child 创建新的 AgentLoop/工具服务。`scheduler.ts` 管深度、并发、数量和 proposal 槽位；`profiles.ts` 管研究/代码审查/提案能力；`pathScope.ts` 管路径租约。child 接收自包含任务、项目/profile 和精确授权，不复制父历史、推理或兄弟可变状态；proposal 只准备，不 Apply/批准/执行。

`delegation.ts` 保存候选/依赖/父采纳；`contextCapsule.ts` 保存宿主继承证明；`resultEnvelope.ts` 做结构签收，`handoff.ts` 交付有界 manifest，`resultIndex.ts` 保存 canonical 结果与 UTF-8 分页，`store.ts` 管持久化与恢复。`resultRef` 指 canonical 结果，`evidenceRef` 指不可变交付快照。完整权限与父验收见 [SUBAGENTS](../SUBAGENTS.md)。

用量权威分层：`usageLedger.ts` / `usageLedgerStore.ts` 保存请求级幂等账本；`usageStats.ts` 聚合官方/参考费用与缓存数据；`subagentUsageStats.ts` 归集 child；`cacheObservation.ts` 记录前缀指纹。`ExecutionClock` / `ExecutionCostBudget` 与 `sessions/userTaskBudget.ts` 保护跨 child、续跑、恢复、epoch 的根任务上限；逻辑任务有效计时由 `sessions/executionTimeStats.ts`、`userTask.ts` 管理，UI 投影不能重定义口径。正费用上限遇不可计价来源 fail-closed。

## 7. 会话、持久化与数据权威

| 模块/数据 | 权威与边界 |
| --- | --- |
| [chatSessionStore.ts](../src/sessions/chatSessionStore.ts) | 当前 workspace 会话门面、内存状态、选择与保存协调；除原生 replay 外的 normalize/migration 仍在此 |
| [providerReplayNormalization.ts](../src/sessions/providerReplayNormalization.ts) | 原生 Responses/Anthropic replay 的纯完整校验、容量限制和复制；Store/Provider 共用，禁止接受部分非法 replay |
| [globalSessionStorage.ts](../src/sessions/globalSessionStorage.ts) | 按 workspace/session 分片的持久化 adapter，索引/全局 manifest V2 |
| [sessionObjectStore.ts](../src/sessions/sessionObjectStore.ts) | session shard V4 对象图、hash/scope/revision/写锁、对象先于 manifest 提交；兼容 V3 与旧 V2 迁移 |
| [persistenceSnapshot.ts](../src/sessions/persistenceSnapshot.ts)、[coalescedWriter.ts](../src/sessions/coalescedWriter.ts) | 不可变复用/可变状态复制、保存队列与失败/flush 语义；不能替换为普通 debounce |
| [sessionRetention.ts](../src/sessions/sessionRetention.ts) | 过期清理、保留策略与状态审计 |
| `ChatSession.messages` | UI 持久历史，append-only；`contextCompression` / `historyArchive` 仅是请求投影状态 |
| `requestProtocol` / `contextInstructions` | 冻结 lane/工具 schema 与稳定上下文字节；normalizer 不反写旧前缀 |
| `runCheckpoint` / `runCheckpointArchive` | 当前可恢复状态与归档引用；普通加载仅展开最新未结束 checkpoint，UI 不接收完整对象图 |

默认存储由各 Store 通过 `globalStorageUri` 解析。来源/子代理设置、`chat-sessions/v2` 索引及 shard、兼容 `chat-sessions/v1` evidence/child、`usage-ledger/v2`、`change-sets/v4`、DraftRun 和审批文件各由所属 Store 管理。业务层不拼版本路径，也不在项目仓库保存密钥或真实会话。JSON 优先 `writeJsonAtomic()`；未知副作用不自动重试，迁移与恢复在副本验证。

## 8. 改动与测试路由

| 改动 | 首要入口 | 必须联查的现有回归 |
| --- | --- | --- |
| 配置/来源/模型 | package contributions、`shared/config.ts`、`accounts/` | `config`、`accountResolver`、`modelCatalog`、`modelSelection` |
| Provider payload/replay/预算 | `providerRequestProjection.ts`、`protocol.ts`、`providers/` | `cacheByteStability`、`protocolCache`、`modelLaneMigration`、三协议测试、`modelOutputBudget` |
| 工具/evidence/epoch | `protocol.ts`、Runner 路由、独立 service | `toolResultBudget`、`p1ProtocolDelivery`、`longRunningAgent`、恢复测试 |
| 审批/文件/命令 | `approvals/`、`edits/`、`runs/` | `approvalMode`、`approvalReviewer`、`taskApprovalIntegration`、`toolAuthorization`、`applyWorkflow`、`draftRun*` |
| 子代理 | `subagents/`、resolver、delegation | `subagentSafety`、`p1Delegation`、`p1SubagentInheritance`、`p1SubagentResultReader`、`subagentUsageRuntime` |
| 引用/Skills/输入 | `context/references/`、`skills/`、`webview/input/` | `fileReference`、`skill*`、`codexPlugin*`、`inputComposition`、`richTextShortcuts` |
| 会话结构/保存 | `shared/types.ts`、`sessions/`、checkpoint | `chatSessionStore`、`longTaskPerformance`、`p0SubagentPersistence`、`executionTimeStats` |
| 用量/观测 | ledger、usage、logging | `usageStats`、`subagentUsageStats`、`interactionTrace`、`runDetails` |
| 打包/资源 | `.vscodeignore`、`scripts/package-market.js`、`verify-vsix.js` | 市场包入口/依赖/动态 SVG 清单及包内容比较 |

测试文件统一位于 `test/<name>.test.ts`，默认执行清单在 `test/runTests.ts`。缓存冻结 JSON、不同协议/scope/故障时序与历史迁移不是因文件名相似即可删去的重复测试。独立脚本保留各自使用入口；运行前检查网络、报告写入和文件副作用。

默认验证：compile、lint、build:test、test、package:market；变更前先搜索全引用和消息/工具字符串，明确不变式，选择最接近的行为回归。真实模型、原生 UI 与跨平台验证应单列现场证据。历史记录及适用范围统一从 [文档导航](README.md#历史证据) 按需进入。
