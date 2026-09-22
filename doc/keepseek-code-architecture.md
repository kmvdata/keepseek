# KeepSeek 代码架构交接指南

> 面向后续接手 KeepSeek 的程序员与 AI 智能体。本文从代码目录和依赖边界出发，说明系统如何启动、一次请求如何流经各层、状态保存在哪里，以及不同类型的改动应该落到哪些文件。
>
> 本文按 2026-09-22 的源码整理。架构事实以当前源码为准；安全、缓存和审批不变式以仓库根目录的 [`AGENTS.md`](../AGENTS.md) 为最高优先级维护约定。

## 1. 先建立整体心智模型

KeepSeek 是一个运行在 VS Code Extension Host 中的编程 Agent。它由两部分组成：

- 宿主侧 TypeScript：访问 VS Code API、工作区、持久化存储和模型服务；
- Webview 侧界面：负责输入、消息展示、设置、审批卡片和状态交互，不直接访问文件系统或模型服务。

核心依赖方向如下：

```text
package.json / VS Code activation
                │
                ▼
        src/extension.ts
                │
                ▼
src/provider/KeepseekChatViewProvider.ts
      │         │          │
      │         │          ├── src/sessions/   会话与工作区状态
      │         │          ├── src/accounts/   模型来源与凭据解析
      │         │          ├── src/context/    用户上下文与引用
      │         │          ├── src/skills/     Skill 发现和激活
      │         │          └── src/memory/     旧记忆迁移兼容
      │         │
      │         ├── src/agent/AgentRunner      模型请求与工具循环
      │         │       ├── providers/         三类上游协议
      │         │       ├── tools/             只读/验证工具
      │         │       ├── evidence/          完整工具证据
      │         │       └── subagents/         隔离子代理运行时
      │         │
      │         ├── src/edits/                 DraftEdit → ChangeSet → 安全写盘
      │         ├── src/runs/                  DraftRun → permit → 进程执行
      │         └── src/approvals/             model_review / delegate 审批记录
      │
      └── src/webview/                         HTML/CSS/浏览器脚本字符串
```

最重要的边界是：

1. [`extension.ts`](../src/extension.ts) 只做激活和事件接线；
2. [`KeepseekChatViewProvider.ts`](../src/provider/KeepseekChatViewProvider.ts) 是宿主侧总协调器；
3. [`runner.ts`](../src/agent/runner.ts) 负责模型与工具循环，但不直接应用文件修改，也不直接执行任意命令；
4. 文件副作用只由 `src/edits/` 落地，命令副作用只由 `src/runs/` 落地；
5. Webview 只能发送消息请求宿主操作，不能绕开宿主安全边界。

这里有两个容易混淆的目录：

- `src/provider/` 是 VS Code/Webview 的宿主协调层；
- `src/agent/providers/` 是 DeepSeek、OpenAI Responses、Anthropic Messages 等上游 API 客户端。

## 2. 仓库顶层目录

```text
keepseek/
├── src/                 扩展源码
├── test/                与 src 对应的契约和回归测试
├── doc/                 专题设计与交接文档
├── scripts/             打包、安装和行为评估脚本
├── resources/           扩展图标、模型来源图标
├── images/              README 截图
├── package.json         VS Code contribution、配置项、命令和构建脚本
├── tsconfig.json        正式构建配置，输出到 out/
├── tsconfig.test.json   测试构建配置，输出到 out-test/
├── AGENTS.md            维护不变式和改动影响面
├── SUBAGENTS.md         子代理公开架构说明
└── README*.md           产品、使用和开发入口
```

`out/`、`out-test/` 和 `.vsix` 是生成物，不是源码权威来源。正式入口由 `package.json` 的 `main: ./out/extension.js` 指定。

常用验证命令：

```bash
bun run compile
bun run lint
bun run build:test
bun run test
```

市场包必须使用：

```bash
bun run package:market
```

## 3. 启动与宿主协调层

### 3.1 `src/extension.ts`：扩展入口

[`src/extension.ts`](../src/extension.ts) 的 `activate()` 完成以下工作：

1. 创建启动性能跟踪器；
2. 创建 `GlobalSessionStorage` 和当前工作区的 `ChatSessionStore`；
3. 创建 `KeepseekChatViewProvider`；
4. 尽早注册 Secondary Sidebar Webview Provider；
5. 异步迁移旧 workspaceState 并加载当前工作区会话；
6. 注册命令、配置变更、工作区切换、信任变化和文件变化监听器。

这里不应放业务逻辑。新功能通常只在这里增加：

- VS Code 命令注册；
- 生命周期级事件接线；
- Provider 构造所需的顶层依赖。

### 3.2 `src/provider/`：应用协调器

| 文件 | 职责 |
| --- | --- |
| `KeepseekChatViewProvider.ts` | 创建各服务；处理 Webview 消息；协调会话、模型选择、Agent run、审批、Apply/Discard/Revert、DraftRun 和 UI 状态推送 |
| `webviewMessages.ts` | Webview → Extension Host 消息联合类型的唯一来源 |
| `modelSelection.ts` | 模型切换事务、运行中切换限制、Provider lane 影响分析 |
| `backgroundRunStatusBar.ts` | 后台任务状态栏展示 |
| `focusView.ts` | 打开或聚焦 KeepSeek 侧边栏 |

`KeepseekChatViewProvider` 文件很大，但其角色仍然是“协调”，而不是底层实现。它持有以下主要服务：

- 会话：`ChatSessionStore`；
- 模型来源：`ModelSourceStore`、`ModelSourceService`、`DefaultModelStore`；
- Agent：`AgentRequestCoordinator`、`AgentRunner`、`SubagentRuntime`；
- 修改：`ChangeSetStore`、`SafeFileEditor`、`DraftDiffService`；
- 命令：`DraftRunStore`、`DraftRunBatchCoordinator`；
- 审批：`ApprovalReviewStore`、`ApprovalReviewerService`、`DelegatedApprovalQueue`；
- 上下文：`FileContextStore`、`ProjectInstructionsResolver`、`SkillStore`；
- 观察性：`InteractionTraceLogService`、`UsageLedgerStore`、余额 store；
- 长任务：`BackgroundRunCoordinator`、检查点、自动续跑状态。

Provider 中可以做跨模块编排和 UI 状态同步；可独立测试的规则、持久化、协议转换和副作用执行应继续放在对应子系统中。

### 3.3 Webview 启动握手

[`src/webview/html.ts`](../src/webview/html.ts) 生成带 CSP 和 nonce 的完整 HTML。页面最早加载的 bootstrap 脚本会：

1. 获取 VS Code API；
2. 暂存 Extension Host 提前发来的消息；
3. 发送 `{ type: 'ready' }`；
4. 等正式脚本完成初始化后消费暂存消息。

Provider 收到 `ready` 后先发送轻量状态，再异步完成会话、审批恢复、模型来源和当前运行上下文初始化。涉及 Agent 请求或审批写操作的消息，在恢复数据未就绪时会被拒绝。这是启动性能与恢复安全之间的边界。

## 4. `src/webview/`：侧边栏界面

Webview 源码不是独立打包的前端应用，而是由 TypeScript 函数返回 HTML、CSS、JavaScript 字符串，最终在 [`html.ts`](../src/webview/html.ts) 中拼成一个页面。

```text
src/webview/
├── html.ts                 HTML 外壳、CSP、资源 URI、bootstrap
├── template.ts             transcript 和页面主骨架
├── styles.ts               页面主样式聚合
├── script.ts               transcript、会话、状态渲染和主消息监听
├── richTextShortcuts.ts    两个编辑器共享的富文本快捷键
└── input/
    ├── composition.ts      输入区 fragment 的固定拼装顺序
    ├── script.ts           输入脚本兼容入口
    ├── styles.ts           输入样式兼容入口
    ├── template.ts         输入模板兼容入口
    ├── composer/           contenteditable、提交、序列化、视觉状态
    ├── references/         @ 补全、引用 chip、拖拽、编解码和菜单
    ├── commandMenu/        模型、审批、Agent 设置、Skills 命令菜单
    ├── usage/              用量详情和子代理进度
    ├── skills/             Skill 展示与选择
    └── dialogs/            账号、历史、About、创建 Skill、后台任务
```

`input/composition.ts` 中 fragment 的顺序是行为的一部分：所有片段共享同一个生成后的 IIFE、词法作用域和监听器注册顺序。调整文件拆分时不能随意重排 fragment。

Webview 与宿主的契约：

- Webview 发出的消息必须加入 [`provider/webviewMessages.ts`](../src/provider/webviewMessages.ts)；
- Provider 的 `handleMessage()` 必须增加对应分支；
- Extension Host 主动推送的消息由 `webview/script.ts` 或相关 fragment 的 `message` 监听器处理；
- DOM id、消息 type、引用序列化格式属于兼容性接口；
- CSP 只允许由宿主注入 nonce 的脚本，不能引入远程脚本。

功能归属建议：

- transcript、会话列表、设置总状态：`webview/script.ts`；
- 输入框、提交、拖拽和引用：`webview/input/**`；
- 样式：对应 `styles.ts`，不要把样式散落到行为脚本；
- 两个编辑器都需要的快捷键：`richTextShortcuts.ts`。

## 5. `src/accounts/`：模型来源、账号和模型目录

```text
src/accounts/
├── types.ts                    来源和持久化数据结构
├── accountStore.ts             来源 CRUD、规范化、globalStorage 持久化
├── accountResolver.ts          凭据与运行配置的唯一解析入口
├── modelSourceService.ts       面向 Provider/UI 的来源业务操作
├── modelDiscovery.ts           /models 探测、连接测试和缓存刷新
├── modelCatalog.ts             合并来源模型、默认模型和项目选择
├── defaultModelStore.ts        全局默认模型
├── sourceCapabilities.ts       官方来源、计费、API Key 等能力判断
├── subagentSettingsStore.ts    每工作区子代理模型设置
└── subagentModelResolver.ts    子代理运行前解析并冻结模型配置
```

这一层回答三个问题：

1. 用户配置了哪些模型来源和模型？
2. 当前主 Agent / 子代理应该使用哪一个来源与模型？
3. 该来源的凭据、base URL、协议和能力是什么？

`accountResolver.ts` 是运行时取得凭据的唯一入口。主请求、摘要请求、审批 reviewer、子代理、余额查询和模型发现不应各自重新读取 API Key 或重新解释来源语义。

目前 Provider 客户端支持：

- DeepSeek 官方 Chat Completions；
- Kimi、GLM、QwenCloud 官方预设；
- OpenAI-compatible Chat Completions；
- OpenAI Responses；
- Anthropic Messages compatible；
- 本地 Ollama。

“账号/模型来源”与“上游协议实现”分离：账号状态在 `src/accounts/`，真正发请求的客户端在 `src/agent/providers/`。

## 6. `src/context/`、`src/skills/` 和 `src/memory/`：输入上下文

### 6.1 `src/context/`

```text
src/context/
├── fileContextStore.ts             用户附加的上下文文件集合
├── textReferences.ts               终端/Output/Debug 选区临时文本文件
└── references/
    ├── promptReferences.ts         目录 → 文件 → Skill 的统一展开入口
    ├── fileReference.ts            <path#Lx-Ly> 解析、读取、授权
    ├── directoryReference.ts       <keepseek-dir:path> 展开
    ├── skillReference.ts           $skill-name 展开
    ├── referenceSyntax.ts          fence、独立行和危险字符判断
    ├── referenceResources.ts       @ 菜单可用资源
    └── fileReferenceOpener.ts      点击引用后的打开/定位/Reveal
```

一次真实用户输入在发送前会经过 `expandPromptReferencesInPrompt()`。展开顺序固定为目录、文件、Skill；发送与持久化使用同一份 `(expandedContent ?? content).trim()` 字节，不能在 Provider 层再次包装旧 user 消息。

工作区外文件以精确 `uri.toString()` 为授权键。拖入文件、终端选区等临时内容先落到扩展全局存储，再以已授权外部引用参与本轮请求。

### 6.2 `src/skills/`

| 文件 | 职责 |
| --- | --- |
| `skillDiscovery.ts` | 扫描用户、工作区、`.agents` 等来源并解析 frontmatter |
| `skillLoader.ts` | 受限读取 Skill 指令和引用资源 |
| `skillActivationResolver.ts` | 按 explicit → session → workspace-default → implicit 决定激活集合 |
| `skillStore.ts` | 用户选择和默认设置持久化 |
| `skillCreator.ts` | 在工作区 `.agents/skills/` 创建新 Skill |
| `skillTypes.ts` | manifest、来源和视图类型 |

隐式 Skill 在会话首个真实用户请求后冻结为 id 列表，避免后续 prompt 改变导致 system 上下文字节漂移。`runAs: subagent` 的 Skill 不把完整指令注入主 Agent，而是在选中的隔离子代理里加载。

Skill 的 `scripts/` 只表示存在可运行资源，不能在发现或加载时自动执行。

### 6.3 `src/memory/`

`memory/` 只服务旧 `.keepseek/memory.json`：

- `legacyProjectMemoryFormat.ts` 负责只读解析；
- `legacyProjectMemoryMigration.ts` 负责生成迁移到 `AGENTS.md` 或 Skill 的待确认改动。

Legacy Memory 是最低优先级兼容上下文，不是新的可写记忆系统。迁移也必须生成 DraftEdit/ChangeSet，不能直接改工作区。

## 7. `src/agent/`：Agent 运行时核心

`src/agent/` 可以按七个子域理解。

### 7.1 请求编排与主循环

| 文件 | 职责 |
| --- | --- |
| `agentRequestCoordinator.ts` | 从会话快照创建 `AgentRequest`；维护归档和后台摘要刷新 |
| `runner.ts` | `AgentLoop`/`AgentRunner` 主循环、模型调用、工具路由、工具结果准入、最终 `AgentResponse` |
| `protocol.ts` | 静态 system prompt、工具名和 schema、消息拼装、上下文格式化 |
| `providerRequestProjection.ts` | 将同一持久化状态权威投影为三类 Provider 原生请求 |
| `taskPlan.ts` | 任务计划及步骤状态 |
| `repairLoop.ts` | 验证失败后的修复轮次状态机 |
| `executionMode.ts` | normal/plan 模式和计划确认流程 |
| `approvalMode.ts` | ask/model_review/delegate 模式与续轮尾部格式 |
| `backgroundRunCoordinator.ts` | 显式后台任务状态 |

`AgentRunner.run()` 的主要输出是 `AgentResponse`：可见回复、推理展示、DraftEdit、DraftRun proposal、任务计划、修复状态、工具轮原始回放、原生 Provider replay、usage、trace 和 Run Details。

Runner 可以“提出”副作用：

- 创建 `DraftEdit`；
- 创建 `DraftRunProposal`；
- 在 model_review/delegate 流程中生成待处理的审核结果。

Runner 不能：

- 直接把 DraftEdit 写入工作区；
- 直接批准或 spawn 任意命令；
- 把验证工具扩展成任意命令后门。

### 7.2 上下文投影、缓存和容量

```text
currentRunContext.ts             合并 AGENTS.md、Skills、Legacy Memory
contextDeduplication.ts          按优先级去重上下文来源
historyProjection.ts             摘要 + 保护消息 + 最近轮次投影
historyCompressor.ts             低频摘要刷新与失败回退
historyArchive.ts                大结果归档、召回与维护
contextUsage.ts                  基于真实投影估算上下文占用
contextUsageCache.ts             UI 用量估算缓存
toolResultAdmission.ts           动态工具结果准入、有效窗口校准
toolResultShaping.ts             在压力下整形部分工具结果
contextEpoch.ts                  同一逻辑任务的 epoch rollover
contextWindowCalibrationStore.ts Provider context-too-long 校准持久化
tokenEstimate.ts                 本地 token 粗估
```

[`providerRequestProjection.ts`](../src/agent/providerRequestProjection.ts) 是请求投影的权威入口。Runner、上下文用量、压缩决策、硬上限和缓存测试都应消费相同投影，不能分别重建一套 messages 或 tools。

缓存稳定依赖四个冻结面：

- 静态 system prompt；
- 持久化的 `ChatSession.contextInstructions`；
- 按会话冻结的工具 schema；
- append-only 的历史回放字节。

摘要刷新与 Context Epoch rollover 是受控缓存边界。有关字节级约束，见 [`cache_keepseek.md`](./cache_keepseek.md)。

### 7.3 Provider 协议层

```text
src/agent/providers/
├── types.ts                    ProviderClient 统一接口
├── factory.ts                  根据来源类型选择无状态客户端
├── deepseekClient.ts           DeepSeek Chat Completions
├── openAiCompatibleClient.ts   OpenAI-compatible，Kimi/GLM/QwenCloud 复用
├── ollamaClient.ts             Ollama 端点差异
├── openAiResponsesClient.ts    OpenAI Responses
├── responsesStreamParser.ts    Responses SSE 解析
├── responsesTypes.ts           Responses 原生类型
├── anthropicMessagesClient.ts  Anthropic Messages
├── anthropicStreamParser.ts    Anthropic SSE 解析
├── anthropicTypes.ts           Anthropic 原生类型
└── streamParser.ts             Chat Completions SSE 解析
```

三类请求 lane：

- `chat-completions`；
- `openai-responses`；
- `anthropic-messages`。

OpenAI Responses 和 Anthropic Messages 的原生工具/推理块保存在 `ChatMessage.providerReplay`。只有来源、端点和协议 lane 一致时才原样回放；跨 lane 只保留可见文本，避免伪造不兼容的原生结构。

`agent/deepseek/` 还包含 DeepSeek 类型、DSML 工具调用兜底和官方余额；`agent/kimi/` 包含 Kimi 官方余额逻辑。

### 7.4 工具实现

```text
src/agent/tools/
├── workspaceTools.ts      文件列表、目录、文本搜索、全文/行段读取
├── semanticTools.ts       symbol、reference、document/workspace symbols
├── gitTools.ts            status、diff、branch、patch、commit message 建议
├── validationTools.ts     固定 compile/lint/test 验证
└── toolAuthorization.ts   风险级别、工作区信任、外部 URI 和授权决策
```

工具 schema 定义在 `protocol.ts`，实现和路由分离：

- 新增工具时，先定义稳定名称/schema；
- 在 `runner.ts` 的工具路由中分发；
- 具体实现放到 `tools/` 或独立子系统；
- 返回完整结果给 evidence，再由准入控制器决定 Provider 可见信封。

Git 工具保持只读。`commit`、`push` 或其他 mutation 只能成为完整可见的 DraftRun，不能加入 `gitTools.ts` 直接执行。

### 7.5 Tool Evidence 与检查点

```text
src/agent/evidence/
├── types.ts       evidence 状态、来源、内容类型和分页输入
├── store.ts       task/session 隔离的完整结果存储和分页读取
└── shaping.ts     确定性信封和 stable stringify
```

工具调用遵循“先意图、后执行、再交付”的顺序：

1. 保存 pending intent；
2. 执行工具；
3. 保存完整结果、hash 和完成状态；
4. 根据当前容量只生成一次 Provider-visible envelope；
5. 需要更多内容时用 `keepseek_read_evidence` 分页读取。

[`runCheckpoint.ts`](../src/agent/runCheckpoint.ts) 保存同一逻辑任务跨恢复/epoch 所需的宿主状态，包括任务计划、evidence、工具幂等、审批、DraftEdit/DraftRun、验证、用量和停止原因。已完成工具不能因为结果交付失败而重跑。

### 7.6 子代理

```text
src/agent/subagents/
├── runtime.ts         为每个 child 创建隔离 AgentLoop，处理续跑和结果合并
├── scheduler.ts       并发、深度、子节点数量和 proposal 槽位
├── profiles.ts        research/review/proposal 及 Skill profile
├── pathScope.ts       proposal 路径租约与冲突判断
├── store.ts           子代理 metadata、transcript、结果分页和诊断
├── resultEnvelope.ts  类型化结果信封与机械签收
└── types.ts           lane、状态、调用上下文和持久化类型
```

每个子代理使用新的 AgentLoop 和新的工具服务，不共享父/兄弟的可变运行状态。父会话只收到有界结果信封；完整结果保存在本地并通过分页工具读取。proposal 子代理只能准备 DraftEdit/DraftRun，不能 Apply、批准或执行。

更详细的隔离、调度、结果协议和用量边界统一见 [`SUBAGENTS.md`](../SUBAGENTS.md)。

### 7.7 用量、缓存观测和调试

| 文件 | 职责 |
| --- | --- |
| `usageStats.ts` | Provider usage 归一化、聚合、费用和缓存命中率 |
| `usageLedger.ts` | 不可变请求级账本、价格快照和汇总 |
| `usageLedgerStore.ts` | 按 session 分桶持久化账本 |
| `subagentUsageStats.ts` | 子代理实际用量与上下文隔离估算 |
| `cacheObservation.ts` | 请求前缀指纹、复用关系和失效归因 |
| `logging/interactionTrace.ts` | 脱敏交互 trace |
| `logging/runDetails.ts` | 面向 UI 的任务、工具、审批、修改、验证摘要 |
| `behaviorEvaluation.ts` | Agent 行为评估记录与评分 |

费用上限由共享 `ExecutionCostBudget` 管理，时间上限由 `ExecutionClock` 管理；主 Agent、子代理、恢复和 Context Epoch 不能重置或借用这些账本。

## 8. `src/edits/`：文件修改事务

```text
src/edits/
├── draftEdit.ts          DraftEdit union、构造和身份读取
├── textPatch.ts          patch 文本解析、canonical IR、hash、应用和 inverse
├── changeSet.ts          从一组 DraftEdit 创建 ChangeSet
├── changeSetStore.ts     pending/Apply/Discard/Revert、恢复和持久化主管线
├── safeFileEditor.ts     单文件 preflight、journal、原子写入、read-back 校验
├── changeArtifactStore.ts 大内容和回滚 blob 的 content-addressed 存储
├── draftDiffService.ts   普通 diff 与大文件 hunk-only review 文档
└── draftEditStore.ts     DraftEdit 状态存取辅助
```

修改状态流：

```text
模型工具调用
  → DraftEdit（未落盘）
  → ChangeSet（可审阅、可持久化）
  → 审批/用户 Apply
  → SafeFileEditor preflight
  → prepared journal
  → base hash 再核验
  → 同目录临时文件 + 原子替换
  → read-back result hash
  → applied checkpoint
  → 可选 Revert
```

`DraftEdit` 的权威格式包括：

- `text_patch_v1`：局部修改，canonical byte hunks；
- `full_text_v1`：新建或完整替换；
- `delete_v1`：删除；
- `move_v1`：移动；
- `legacy_full_text_v0`：只用于旧数据兼容。

行号、原始 patch 文本和模糊匹配不是 Apply 权威。Apply 时必须依据 URI、base/result hash、size、encoding、EOL 和非重叠 byte hunks。

不要绕过 `ChangeSetStore` 直接调用 VS Code 文件写 API。否则会丢失审批绑定、冲突检查、重启恢复、Diff、回滚 blob 和不确定态处理。

## 9. `src/runs/`：命令提案与一次性执行

```text
src/runs/
├── draftRunProposal.ts         规范化 executable/argv/cwd/env 并计算 specHash
├── commandRisk.ts              命令效果和验证阻断风险分析
├── draftRunStore.ts            pending/running/terminal 状态、输出和持久化
├── draftRunAuthorization.ts    审批记录 → 一次性 ExecutionPermit
├── draftRunExecutor.ts         shell:false 的 spawn、取消、超时、输出流
└── draftRunBatchCoordinator.ts Ask 模式下一批命令的顺序执行和停止
```

命令状态流：

```text
keepseek_run_draft
  → immutable DraftRunProposal
  → DraftRun(pending)
  → 用户批准或 delegated approval record
  → 绑定 draftRunId + specHash 的短期一次性 permit
  → SpawnDraftRunExecutor
  → completed / failed / cancelled / timed_out / interrupted
```

Executor 必须使用 `spawn(executable, args, { shell: false })`。需要 shell 语法时，shell 本身必须是可见 executable，脚本是可见 argv。扩展重启后，`approved/running` 只能恢复为 interrupted，不能自动重跑。

## 10. `src/approvals/`：模型审批与宿主策略记录

```text
src/approvals/
├── approvalReviewTypes.ts    action、decision、risk、record 类型
├── approvalReviewHash.ts     精确 action hash 和有界 review 文本
├── approvalReviewSurface.ts  DraftEdit/DraftRun/验证/外部 URI 审核面
├── approvalPolicy.ts         reviewer system prompt、JSON 解析、确定性拒绝
├── oneShotTextRequest.ts     隔离、无工具的一次性 reviewer 请求
├── approvalReviewer.ts       reviewer 服务、来源解析和记录
├── approvalReviewStore.ts    append-only 审批记录持久化
└── approvalCircuitBreaker.ts 连续拒绝和累计拒绝熔断
```

三种模式的区别：

- `ask`：用户逐项点击批准；
- `model_review`：隔离 reviewer 针对精确 actionHash 审查；
- `delegate`：宿主策略自动批准，但仍需写入明确的 `host_policy` 记录。

无论哪种模式，底层确定性硬检查始终生效。模型判断不能关闭工作区信任、路径授权、base hash、脏编辑器、specHash、一次性 permit 或取消检查。

审批结果和真实副作用结果通过新的 user-tail 追加到下一轮，不能回写历史消息。

## 11. `src/sessions/`：会话模型与持久化

```text
src/sessions/
├── chatSessionStore.ts       当前工作区会话 CRUD、规范化、协议迁移
├── globalSessionStorage.ts   globalStorage 中按工作区/会话分片存储
└── sessionRetention.ts       过期清理和保留策略
```

`ChatSessionStore` 是内存中的当前工作区会话门面；`GlobalSessionStorage` 是持久化 adapter。V2 持久化使用小型 workspace index 加每会话一个原子文件，避免启动时加载所有历史消息。

`ChatSession` 中值得特别关注的字段：

- `messages`：UI 历史的权威记录；
- `requestProtocol`：冻结的协议版本、工具 schema 和 lane；
- `contextInstructions`：稳定的 AGENTS/Skills/Legacy/Context Files 块；
- `contextCompression`、`historyArchive`：模型投影状态，不等于 UI 历史；
- `usageLedgerRef`、`usageStats`、`subagentUsageStats`：用量和统计；
- `repairLoop`：验证修复状态；
- `approvalMode`、`executionMode`、`planWorkflows`：工作流控制；
- `lastTraceLogUri`、`promptCacheDiagnostics`：调试与缓存观测。

`ChatMessage` 除可见 `content` 外，还可能保存：

- `expandedContent` / `providerContent`；
- `reasoningContent`；
- 通用 Chat Completions 的 `toolRounds`；
- Responses/Anthropic 的 `providerReplay`；
- `runCheckpoint` / `runState`；
- `runDetails`、`contextMeta` 和本轮 Skills。

会话投影必须 append-only。压缩状态只影响发给模型的 projection，不得删除或改写用户在 UI 中看到的 `session.messages`。

## 12. `src/shared/` 和 `src/workspace/`：横切基础设施

### 12.1 `src/shared/`

| 文件 | 职责 |
| --- | --- |
| `types.ts` | 跨目录核心领域类型的中心定义 |
| `config.ts` | `package.json` 配置的读取、默认值和范围归一化 |
| `modelProfiles.ts` | 模型运行画像、上下文和工具上限 |
| `modelContextWindowGuesses.ts` | 未显式发现时的窗口猜测 |
| `deepSeekModels.ts` | DeepSeek 模型身份规范化 |
| `atomicStorage.ts` | JSON 同目录临时文件原子替换 |
| `textFileGuards.ts` | 文本/二进制/扩展名安全判断 |
| `safeTextSnapshot.ts` | 可回滚文本快照解码 |
| `markdown.ts` | Markdown fence 等公共解析 |
| `i18n.ts` | 中英文文案和语言选择 |
| `errors.ts`、`format.ts` | 公共错误与格式化 |
| `startupPerformance.ts` | 启动阶段测量 |

新增跨层状态前，先判断是否应进入 `shared/types.ts`；不要在 Provider、Runner 和 Webview 各复制一份相似结构。新增配置必须同时修改 `package.json` 和 `shared/config.ts`。

### 12.2 `src/workspace/`

- `workspaceDirectory.ts`：工作区目录枚举、忽略目录和资源路径；
- `gitIgnore.ts`：`.gitignore` 规则支持。

这是工作区遍历的底层公共层。新的文件搜索/列表能力应复用这里的路径和 ignore 语义。

## 13. 一次请求的端到端调用链

### 13.1 普通对话与只读工具

```text
Webview composer
  → postMessage(sendPrompt)
  → KeepseekChatViewProvider.handleMessage()
  → sendPromptImpl()
  → 展开文件/目录/Skill 引用
  → 刷新 CurrentRunContext，冻结 contextInstructions/tool schema/source config
  → AgentRequestCoordinator.createAgentRequest()
  → AgentRunner.run()
  → buildProviderRequestProjection()
  → providers/factory.ts 选择 ProviderClient
  → 流式响应 / tool call
  → Workspace/Semantic/Git 工具
  → EvidenceStore 保存完整结果
  → ToolResultAdmissionController 选择信封或触发 epoch rollover
  → 下一次模型请求
  → AgentResponse
  → Provider 持久化 assistant message、toolRounds/providerReplay、usage、trace
  → postState() 更新 Webview
```

### 13.2 文件修改

```text
模型调用 edit/patch/delete tool
  → Runner 构造 DraftEdit，不落盘
  → createChangeSet()
  → Provider 将 ChangeSet 注册到 ChangeSetStore
  → UI 展示 Diff/Apply/Discard
  → ask：用户点击；model_review/delegate：生成绑定审批记录
  → ChangeSetStore 调 SafeFileEditor
  → journal + hash + 原子写入 + read-back
  → UI、Run Details、trace、下一轮 user-tail 同步真实结果
```

### 13.3 任意命令

```text
模型调用 keepseek_run_draft
  → Runner 仅创建 DraftRunProposal
  → Provider/DraftRunStore 注册 pending DraftRun
  → UI 展示完整 spec 和风险
  → 用户或 delegated approval 生成一次性 permit
  → DraftRunStore 调 Executor
  → stdout/stderr 流式写入终端和有界 transcript
  → terminal state 持久化
  → 根据依赖关系决定是否自动续轮
```

### 13.4 子代理

```text
主模型调用 delegate_task / delegate_parallel
  → Runner 把调用上下文交给 SubagentRuntime
  → Scheduler 检查深度、数量、并发和路径租约
  → 解析并冻结子代理模型与 profile
  → 为 child 创建隔离 AgentLoop 和工具服务
  → child 结果存入 SubagentStore
  → 有界 result envelope 返回父 Runner
  → 父模型需要更多内容时 read_subagent_result 分页读取
```

## 14. 持久化布局

以下均位于 VS Code 为扩展提供的 `globalStorageUri`，不应写入项目仓库：

```text
globalStorageUri/
├── accounts/                         模型来源、密钥、模型缓存、余额记录
├── subagent-settings/v1/             按工作区保存的子代理模型设置
├── chat-sessions/v2/                 会话 manifest、workspace index、会话分片
├── chat-sessions/v1/evidence/        工具证据 blob
├── chat-sessions/v1/subagents/       子代理运行记录（现有兼容布局）
├── usage-ledger/v2/                  按 session 分桶的请求级用量账本
├── model-calibration/v*/             Provider 有效上下文窗口校准
├── change-sets/v4/                   ChangeSet index、runtime、history、checkpoints
├── change-artifacts/v1/blobs/        大内容回滚 blob
├── draft-runs.json                   DraftRun 状态
├── approval-reviews.json             审批记录
├── interaction-logs/                 脱敏运行 trace
├── project-memory/                   Legacy Memory 兼容快照
├── text-references/                  终端/Output/Debug 选区临时文件
└── dropped-file-references/          Webview 拖入文件的临时副本
```

具体版本目录可能随迁移变化，读取时应通过 Store，不要让业务层拼接这些路径。

原子性和恢复原则：

- JSON 持久化优先复用 `writeJsonAtomic()`；
- 大内容以 hash 寻址，状态文件只保存引用；
- pending、executing、completed/uncertain 分开记录；
- 重启后只恢复可证明的状态，未知副作用不重试；
- 密钥不进入 workspace、trace、prompt 或会话正文。

## 15. 常见改动应该从哪里进入

| 需求 | 首要修改点 | 必须同步检查 |
| --- | --- | --- |
| 新增 VS Code 配置 | `package.json` | `shared/config.ts`、UI、测试 |
| 新增 Webview → Host 动作 | `provider/webviewMessages.ts` | Provider `handleMessage()`、发送 fragment、状态反馈 |
| 新增 Agent 工具 | `agent/protocol.ts` | `runner.ts` 路由、具体 service、tool authorization、缓存协议测试 |
| 新增模型来源 | `accounts/types.ts`、`accountStore.ts` | resolver、catalog、discovery、factory、能力、余额、UI、测试 |
| 改 Provider payload | `providerRequestProjection.ts` | 三类 replay、contextUsage、historyProjection、缓存字节测试 |
| 改历史压缩 | `historyProjection.ts`、`historyCompressor.ts` | types、contextUsage、Runner fallback、保护消息测试 |
| 改 evidence/epoch | `evidence/**`、`contextEpoch.ts` | checkpoint、admission、三协议配对、恢复、Run Details |
| 改文件引用 | `context/references/**` | Webview codec/chip/拖拽/打开逻辑、外部授权测试 |
| 改 DraftEdit | `edits/draftEdit.ts`、`textPatch.ts` | ChangeSet、SafeFileEditor、diff、hash、approval、checkpoint、Webview |
| 改命令执行 | `runs/**` | approval、Provider、Webview、重启/取消/超时测试 |
| 改审批模式 | `agent/approvalMode.ts`、`approvals/**` | Provider、runs/edits、user-tail、熔断、协议冻结测试 |
| 改子代理 | `agent/subagents/**` | account resolver、protocol、usage、checkpoint、父结果准入、安全测试 |
| 改输入区 UI | `webview/input/**` | `composition.ts` 顺序、DOM id、序列化、双编辑器行为 |
| 改会话结构 | `shared/types.ts`、`sessions/chatSessionStore.ts` | normalize/migration、GlobalSessionStorage、Webview 状态、旧数据测试 |

## 16. 维护时不可跨越的架构红线

### 16.1 缓存红线

- system、contextInstructions、tools schema 和已发送历史必须保持字节稳定；
- 不能为方便实现而在每轮重排工具、重写旧消息或追加动态 system 内容；
- 时间戳、随机 UUID、绝对路径和运行原因不能进入静态 system 段；
- 用量估算和真实请求必须共用 `buildProviderRequestProjection()`。

### 16.2 副作用红线

- 文件写入必须是 DraftEdit → ChangeSet → SafeFileEditor；
- 任意命令必须是 DraftRun → permit → Executor；
- reviewer 不写文件、不启动进程；
- Runner 只准备副作用，不成为副作用执行器；
- validation 只能运行固定 `compile`、`lint`、`test`。

### 16.3 恢复红线

- 完成的工具不因传输失败重跑；
- 不确定的文件/进程副作用不能自动重试；
- 时间、费用、审批 root 和 permit 消费状态跨恢复连续；
- Context Epoch 只能更换 Provider replay lane，不能创建伪 user 消息或新任务。

### 16.4 权限红线

- 未信任工作区不能自动加载项目 Skill 或执行副作用；
- 外部文件/cwd 按精确 URI 授权；
- `model_review` 和 `delegate` 不得绕过宿主硬检查；
- Git mutation 不能伪装成只读 Git 工具。

## 17. 给接手者的推荐阅读顺序

### 17.1 第一次理解项目

1. [`AGENTS.md`](../AGENTS.md)：先掌握不可违反的约束；
2. [`src/extension.ts`](../src/extension.ts)：理解激活入口；
3. `KeepseekChatViewProvider` 的 constructor、`handleMessage()`、`sendPromptImpl()` 和状态推送部分；
4. [`agentRequestCoordinator.ts`](../src/agent/agentRequestCoordinator.ts)；
5. [`providerRequestProjection.ts`](../src/agent/providerRequestProjection.ts)；
6. [`runner.ts`](../src/agent/runner.ts) 的 `run()`、`runLoop()`、`createModelResponse()`、`handleToolCall()`；
7. 根据任务选择 `edits/`、`runs/`、`approvals/`、`subagents/` 或 `sessions/` 深读；
8. 阅读相应 `test/*.test.ts`，确认真实契约和兼容行为。

### 17.2 AI 智能体开始改代码前

1. 用目录归属判断修改应落在哪一层；
2. 搜索目标类型/消息/工具名的所有引用，而不是只改首个命中文件；
3. 检查 `AGENTS.md` 的“改动影响面清单”；
4. 对可能改变 Provider 字节的修改，先明确缓存边界；
5. 对可能产生副作用的修改，先明确 Draft/审批/执行边界；
6. 检查对应 normalize、migration、store 和重启恢复路径；
7. 增加或更新最接近该契约的测试；
8. 至少运行 compile、lint 和相关测试，范围足够时运行完整测试套件。

## 18. 测试目录如何映射架构

`test/` 基本按行为契约而不是源码文件一一命名：

- 缓存与投影：`cacheByteStability`、`protocolCache`、`historyProjection`、`historyCompressor`、`modelLaneMigration`；
- Provider：`openAiResponses`、`anthropicMessages`、`kimiGlmProviders`、`qwenCloudProvider`；
- 编辑：`textPatch`、`changeSet`、`safeFileEditor`、`applyWorkflow`、`deleteDraftEdit`；
- 命令与审批：`draftRun*`、`approvalMode`、`approvalReviewer`、`toolAuthorization`；
- 长任务：`longRunningAgent`、`repairLoop`、`runnerValidationState`、`toolResultBudget`；
- 上下文：`fileReference`、`referenceResources`、`currentRunContext`、`projectInstructions`、`skill*`；
- 子代理：`subagentArchitecture`、`subagentSafety`、`subagentUsage*`；
- 状态与观测：`chatSessionStore`、`usageStats`、`interactionTrace`、`runDetails`、`startupPerformance`。

改动时应优先找到最接近的现有契约测试扩展断言，而不是另起一套只覆盖实现细节的测试。

## 19. 专题文档索引

- [`keepseek-agent-runtime-workflow.md`](./keepseek-agent-runtime-workflow.md)：Agent 请求、工具、副作用、长任务和恢复；
- [`keepseek-api-payload-reference.md`](./keepseek-api-payload-reference.md)：三类 Provider 的真实 payload 与引用展开；
- [`cache_keepseek.md`](./cache_keepseek.md)：缓存前缀、压缩、投影和指纹；
- [`keepseek-file-reference-spec.md`](./keepseek-file-reference-spec.md)：文件引用语法；
- [`SUBAGENTS.md`](../SUBAGENTS.md)：子代理架构、profile、安全、恢复与用量。

## 20. 一句话总结

KeepSeek 的架构核心不是“一个会调用模型的 Webview”，而是一组明确隔离的状态机：会话负责持久历史，投影层负责稳定字节，Runner 负责模型与工具循环，evidence/epoch 负责大结果和长任务，edits/runs 负责受审批的副作用，Provider 负责把这些状态协调成用户可见且可恢复的完整工作流。
