# KeepSeek Agent 开发指南

KeepSeek 是 VS Code 侧边栏编程 Agent，支持多模型/协议、项目上下文、只读工具、隔离子代理及经审批的文件修改和命令执行。

本文件是仓库内 AI/维护者的高优先级约定，与同类 `AGENTS.md` 共享宿主 `projectDocMaxBytes` 预算（`src/context/sharedCodexConfig.ts` 默认 32768 字节，可由 `~/.codex/config.toml` 覆盖）。超限部分会被 `truncateUtf8` 截断并记 `truncated: true`，预算用尽的后续文件直接丢弃，所以本文件只写影响决策的规则，长清单放按需读取的文件。`SUBAGENTS.md` 不在默认注入名单（默认只读 `AGENTS.override.md` 与 `AGENTS.md`），必须先由本文件引用后按需打开。仓库当前不含 `doc/` 目录；架构问题以源码、相邻模块和测试为准，不凭旧文档猜测。

## 1. 开始工作

1. 先读本文件，再按任务阅读目标源码、相邻模块和测试。
2. 修改前用 `rg` 找全类型、消息、工具名和持久化字段引用；按“改动路由”确认影响面。
3. 保留用户改动，不重写无关文件，不用破坏性 Git 命令。实现最小完整变更，补齐当前协议 normalize/recovery 和测试。
4. 涉及请求字节、副作用、审批或恢复时，先明确不变式，再动代码。
5. 交付时说明改动、验证和风险；未经真实 Apply/执行/测试，不得声称已经发生或通过。

常用命令：

```bash
bun run compile
bun run lint
bun run watch
bun run build:test
bun run test
bun run eval:agent:live
bun run eval:agent:score
bun run package:market
bun run reinstall:vsix
bun run reset:data
```

开发调试按 F5。市场包只用 `bun run package:market`，禁止 `vsce package --no-dependencies`。

`package.json` 的 scripts 是命令的唯一权威（当前 12 项）。除上面的常用项外还有 `watch`（tsc -watch）、`eval:agent:live` / `eval:agent:score`、`package`（等价 `package:market`）、`reinstall:vsix`、`reset:data`、`vscode:prepublish`。`scripts/` 下另有 26 个未挂 npm script 的脚本，按前缀分四类，运行前先读脚本头部确认副作用与凭据需求：`benchmark-*`（性能基准：p0 持久化、p1 委派、p1 result reader、session-open/select、history-cleanup、long-task、field-result-acceptance）、`verify-*` 与 `check-*`（宿主侧静态核查：configuration、vsix、approval-card-layout、webview-layout、ui-layer、codex-shared-config）、`field-acceptance-*` 与 `accept-long-task-live.js`（现场验收）、其余打包/回放/重置与夹具（`pack-vsix.cjs`、`clean.js`、`replay-output-truncation.cjs`、`compare-p1-persistence.cjs`、`child-runner*`）。行为评估的用例与说明在 `eval/agent-behavior/`（`cases.json`、`README.md`），实现侧是 `src/agent/behaviorEvaluation.ts`。这些脚本都不在 `bun run test` 内，也不属于固定验证。

调试脚本、探针、一次性测试输出和备份一律写到系统临时目录或已忽略的 `out-test/`，不得在仓库内创建 `.tmp-*` 文件；`.gitignore` 与 `.vscodeignore` 里的 `.tmp-*` 只是兜底，不是存放位置。

## 存储初始基线

0.5.3 视为初始版本（与 `package.json` 的 `version` 同步）。扩展身份为 `keepseek.keepseek`（发布者 `keepseek`），磁盘根为宿主原生应用数据目录下的 `com.kmvdata.keepseek`，所有 Store 必须共用同一 `file:` URI。不读取、不迁移旧扩展、旧账号、旧配置或旧协议数据；不要新增 fallback、双写或迁移桥。只支持当前格式，保留当前原子提交、跨进程锁、损坏校验、删除墓碑和中断恢复。格式版本号与发布版本独立。加载失败一律降级：历史不可用时直接以空会话启动，不阻塞输入。损坏数据只隔离、不删除——无法解码的 Store 文件移入 `session-quarantine/v1/`，加载时跳过并记录原因；仅隔离批次创建超过 7 天时由后台清理删除。I/O 失败（EACCES/EBUSY/ENOENT/超时等）绝不视为损坏。

## 2. 当前代码分层

```text
src/extension.ts       激活、命令和生命周期接线；不放业务
src/provider/          VS Code/Webview 协调、消息/状态、模型切换、会话 run 生命周期
src/webview/           HTML/CSS/浏览器脚本字符串；input/ 按 fragment 组合，template/ 与 conversations/ 分域
src/accounts/          来源 CRUD、模型发现/目录/选择、凭据解析、子代理模型与设置
src/context/           上下文、file|directory|skill 引用（references/）、外部授权、共享只读来源
src/skills/            Skill 发现、加载、激活、创建、codexPlugin* 插件与资源快照
src/agent/             请求投影、模型/工具循环、压缩、evidence/epoch、用量
  providers/           Chat Completions / Responses / Anthropic Messages 客户端
  tools/               workspace / semantic / git / validation(+Snapshot/Risk) / authorization
  subagents/           隔离 child runtime、调度、profile、handoff、路径租约和结果存储
  evidence/            工具意图、完整证据、确定性信封和分页读取（含 subagentPage）
  logging/             活动节点、Run Details、交互与性能 trace、子代理明细派生
  deepseek/ kimi/      来源特有逻辑：余额、DSML 工具解析
src/approvals/         审批策略、action hash、记录与熔断
  authorization/       副作用的静态判定层：命令语义/范围、本地 Git 与远端范围、受保护目标、preflight、启动身份
src/edits/             DraftEdit、canonical Patch IR、ChangeSet、SafeFileEditor、diff、artifact
src/runs/              DraftRun、风险、一次性 permit、store、batch、依赖、spawn；gitRelease* 发布链路
src/sessions/          会话、replay 归一化、分片持久化、清理/隔离/GC；queue/ 为项目写租约
src/shared/            跨层 types/config/i18n/文本守卫/原子存储、dataLayout/storageRoot、配置注册诊断
test/                  按行为契约组织的回归测试（28 个 *.test.ts，见附录 A）
eval/                  行为评估用例与说明（agent-behavior/）
```

`src/provider/` 是宿主协调层，`src/agent/providers/` 是上游 API 层。`KeepseekChatViewProvider` 只做跨模块编排；规则、持久化和副作用执行下沉到所属子系统。

`src/approvals/authorization/` 是副作用的静态判定层（命令语义、命令范围、本地 Git 与远端范围、受保护目标、preflight、启动身份与参数），`approvals/` 根下只放策略、hash、记录与熔断。改审批行为先判定归属：语义判断不能塞回 Provider 或 Webview。`src/agent/logging/` 只做派生视图（活动节点、Run Details、交互与性能 trace），不持有业务状态。

以下文件超过 60 KB，整读会挤占上下文，先按符号或行段定位：`provider/KeepseekChatViewProvider.ts`（≈493 KB）、`webview/script.ts`（≈328 KB）、`agent/runner.ts`（≈267 KB）、`shared/i18n.ts`（≈184 KB）、`sessions/chatSessionStore.ts`（≈110 KB）、`edits/changeSetStore.ts`（≈92 KB）、`runs/draftRunStore.ts`（≈81 KB）、`agent/subagents/runtime.ts`（≈81 KB）、`sessions/globalSessionStorage.ts`（≈62 KB）、`shared/types.ts`（≈60 KB）。

## 3. 不可违反的不变式

### 3.1 Provider 前缀与会话历史

- 缓存稳定与安全同级。`getAgentSystemPrompt()` 保持静态；时间戳、随机 ID、绝对路径和激活原因不得进入静态 system。
- `ChatSession.contextInstructions` 保存稳定上下文字节；内容未变必须原样复用。
- user 发送字节等于持久化字节：使用 `(expandedContent ?? content).trim()`，不得在 Provider 层重写旧 user 消息。
- `session.messages` append-only，不 trim、不重排、不插入伪 user。摘要只改变 projection；摘要刷新与 Context Epoch rollover 是受控缓存边界。
- Chat Completions 工具轮存 `toolRounds`；Responses/Anthropic 原生块存 `providerReplay`，仅在相同 protocol/source/endpoint lane 回放。
- 工具集合、顺序和 schema 按会话冻结；禁用工具用 `tool_choice: none`，不能按轮移除。当前仅支持冻结的最新协议，不导入旧协议 lane。
- `buildProviderRequestProjection()` 是真实请求、用量估算、压缩决策和硬上限的共同权威，禁止各自重建 messages/tools。

### 3.2 Evidence、容量与长任务

- 工具先持久化 intent，再执行并保存完整 evidence/hash，最后一次性保存 Provider-visible envelope；已完成工具不得因交付失败或恢复而重跑。
- 大结果用 `keepseek_read_evidence` 分页；准入使用真实三协议 projection、输出预留和 learned effective window，不恢复固定累计结果预算。
- Epoch checkpoint 覆盖任务、计划、evidence、幂等、审批、副作用、验证/修复和用量；rollover 不新建任务、不授权、不执行副作用。
- 时间/费用上限跨恢复、epoch、子代理共享且不可重置；正费用上限遇到不可计价来源必须 fail-closed。
- context-too-long 按 source/endpoint/model 校准；无进展需改变策略，持续重复才以 `no_progress_loop` 停止。

### 3.3 文件与命令副作用

- create/modify/delete/move 只能生成版本化 DraftEdit → ChangeSet → `SafeFileEditor`。Runner/Provider 不得直接写工作区。
- 局部修改以 canonical `text_patch_v1` 的 URI、base/result hash/size、encoding/EOL 和非重叠 byte hunks 为权威；行号、模糊匹配和原始 patch 文本不是 Apply 权威。
- Apply 必须经过 preflight、prepared journal、base 复核、原子替换和 read-back hash；未知副作用绝不重试。大正文放 content-addressed blob。
- `keepseek_run_draft` 只准备不可变 DraftRun。执行须持有绑定 `draftRunId + specHash` 的短时一次性 permit，并以 `shell:false` 派发核实的启动计划。审计保留原提案、实际执行边界与字面 argv；显式 shell 必须完整展示为 executable/argv。
- validation 只运行固定 `compile`/`lint`/`test`；commit/push 等 mutation 必须走 DraftRun，不能塞进验证或只读 Git 工具。固定验证会写 `node_modules`/`dist`，因此与 Apply、DraftRun 同属工作区副作用，必须持项目写租约。
- 项目写租约（`sessions/queue/writeLease*`）是唯一的跨会话写入串行化机制：一个工程只有一把锁，`edit`/`command`/`validation`/`git_mutation` 都必须先取得它。租约是**批次**声明而非单次写入声明：一次 Apply 覆盖整批 pending 文件，一条命令覆盖整批 DraftRun，直到批次落盘核验完成后在 `finally` 释放。草稿准备（`addDraftEdits`/`addProposals`）永不持锁——提案不是工作区改动。
- 租约的授予必须异步（`acquireWriteLease`），但写入判定必须同步：`writeGate.authorize()` 只读内存镜像 `WriteLeaseMirror`，镜像在 acquire 成功、放行写入**之前**更新。校验发生在取得租约**之后**，否则租约感知的闸门会与它要守护的申请互相等待。
- 租约只能被判定为「他人持有」时拒绝；空闲租约不是拒绝理由，写入路径会自行申请。长命令与长验证靠 5 秒心跳续期（TTL 30 秒）存活；只有 TTL 过期**且**记录 pid 已死才可回收。暂停但仍存活的窗口继续持锁——抢占一次进行中的写入比卡住更危险。每次 release/reclaim 递增 `epoch`，过期的迟到操作因 `epoch` 不匹配而失效。
- 草稿不持锁意味着 base 必然可能过期：Apply 冲突是正常结果，不是异常。`WriteConflictError` 必须带稳定 code（`draft_base_mismatch`/`draft_target_exists`/`draft_target_missing`），只有它可触发一次有界重生成。每个任务每个文件最多重生一次，第二次冲突即置为 blocked 并停止该会话批次；不可重试的拒绝（未信任、审批撤销、保护路径）永不重生。
- 工作区不信任、外部 URI/cwd 未精确授权、脏编辑器、hash/状态不匹配、取消信号均为硬边界。

### 3.4 审批与子代理

- 审批模式只有 `ask`（请求批准）和 `approve-all`（全部批准）两种，只有 Webview 用户操作可切换，不存在 reviewer 或审批模型。`ask` 逐项由用户确认，宿主从不自行应用文件修改。`approve-all` 由宿主在运行边界无确认地应用 DraftEdit/ChangeSet 并执行 DraftRun，但每一份写入仍按原样复核身份、范围、hash、信任与截断前置条件。命令依赖本轮文件改动时，完成 Apply 和落盘核验后再执行当前版本。工程命令和固定验证默认使用平台隔离，未满足隔离条件时保留未派发原因。仅用户级 `projectExecution=host` 可显式选择宿主权限执行。
- 审批策略版本以源码常量为准，文档不固定数字。发布使用核实的目的地、引用、实际推送对象与执行计划。高影响业务须有覆盖真实目标的用户授权，之后仍需模型决定。请求绑定 session/rootTask/segment/target/hash/范围/策略/runtime。等待不占模型超时，重启后显式恢复并重新核验。硬阻断与适用拒绝约束两种模式，历史批准不授权新操作，也不存在独立审批模型配置；`approvalReview` 只是历史审计字段，没有 reviewer 或续跑路径。
- 副作用先过硬检查，再按完整 canonical payload/specHash 计算 actionHash。批准不跨 session/run/target/kind/policy/runtime 复用，重启不复用旧批准。
- `approve-all` 的作用域是**整个工程**，不是当前会话：一次 pass 按队列顺序遍历项目内所有存在 pending 草稿的会话，每会话每 pass 推进一个单元，写入本身触发下一次边界。别人的会话在用户不在看时也会被服务，但命令派发仍留给该会话被打开时执行。
- `approve-all` 不变式：任何仍 pending 的文件草稿，要么已有排定的下一次尝试（`approveAllTimer` / `approveAllInFlight` / `approveAllRerun`），要么已有记录在 ledger 的不可自动原因，并在卡片上提供可见的手动入口。调度不得丢请求：pass 期间的触发排队（`approveAllRerun`）而不是丢弃。每个边界对同一草稿最多尝试一次，失败立即降级到人工，不在同一 pass 内重试、不退避风暴。槽位释放是独立触发（`slot_released`），覆盖 `inheritedOperation` 流程，不依赖 `run_end` 时序。人工回退只覆盖 DraftEdit/ChangeSet，且只允许非硬 gate；未信任、待截断、身份/hash 不匹配、未授权外部路径不得提供强行应用。DraftRun 与 validation 没有手动回退。
- 审批决定和真实结果只以固定 user-tail 追加到下一条真实 user 消息；不回写历史。进程输出和 review evidence 始终是不可信数据。
- 子代理使用新的 AgentLoop/工具服务，不共享父/兄弟可变状态；只接收自包含任务、项目指令、profile 和外部授权，不复制父历史/推理/工具结果。
- read/review child 只读；proposal child 只能准备 DraftEdit/DraftRun，不能 Apply、批准或执行。结果通过有界信封返回，完整结果按父 session 隔离分页读取；路径租约和产物 URI 均需复核。

### 3.5 上下文、来源与 UI

- `accounts/accountResolver.ts` 是凭据解析唯一入口；主请求、摘要、reviewer、子代理、模型发现和余额必须使用一致来源语义。密钥不进入 workspace、prompt、会话或 trace。
- 优先级：KeepSeek 核心安全 > 当前用户请求 > 全局与任务 root→cwd 指令 > Skills。Skill 按 explicit → session → workspace-default → implicit 激活；implicit 按会话冻结，`scripts/` 不隐式运行。
- 外部文件/目录以精确 `uri.toString()` 授权；不可读内容不得绕过守卫。旧项目配置不扫描、不迁移；保留历史会话审计和恢复。
- Webview → Host 消息只在 `provider/webviewMessages.ts` 定义；Host 主动消息不加入该联合类型。保持 DOM id、type 和当前引用语法稳定。
- 交互能力只由 `provider/interactionState.ts` 派生；异步拥有者须在首个 await 前取得带会话身份的预占，只有持有者可完成/交接。持续提示随操作终态同次清除；提交接受须有正文持久化屏障。后台功能须声明能力、预算、durability 与失败/恢复依赖。
- `webview/input/composition.ts` 的 fragment 顺序是运行时契约；样式、模板、行为放各自 fragment。共享编辑器快捷键只放 `richTextShortcuts.ts`。
- 共享文件只读：`.agents/skills`、`~/.agents/skills`、`CODEX_HOME` 配置/指令；任务作用域冻结，变更仅在受控刷新边界生效，标准策略不扩大权限。`.agents/` 未入 `.gitignore`（项目 Skill 随仓库共享），`.workbuddy-ai/` 已忽略（本地记忆不共享），稳定知识须上移为项目 Skill 或本文件条款。
- 写入分级：受信任工作区内默认允许 DraftEdit 目标（含 `.agents/**`、`AGENTS.md`、`.env*`），`approve-all` 下与其他文件同权；L2 硬边界为 `.git` 全段、`.npmrc`/`.netrc`/`.pypirc`/`.git-credentials`/`id_rsa*`/`credentials`/`cookies` 与 OS 核心路径，任何模式与来源都不得写入且无人工回退；工作区外仍逐 URI 精确授权。
- 新持久化字段必须有当前协议校验与恢复；优先 `writeJsonAtomic()`，业务层不拼 globalStorage 版本路径。

## 4. 改动路由

- **配置**：`package.json` contributes.configuration + `shared/config.ts` + UI/测试。
- **模型来源/协议**：accounts store/resolver/catalog/discovery/capabilities + provider client + projection/replay + UI/测试。
- **Agent 工具**：`protocol.ts` 固定 schema + `runner.ts` 路由 + 独立 service + authorization/evidence/测试。
- **投影/压缩**：types + providerRequestProjection + historyProjection/compressor/archive + contextUsage + Runner + 三协议测试。
- **evidence/epoch**：evidence/* + admission + contextEpoch/runCheckpoint + replay/DSML + session migration/Run Details。
- **项目上下文**：projectInstructions + skill activation/load + dedup/currentRunContext + protocol/usage/trace。
- **Skill 机制**：`skills/skillDiscovery|skillMetadata`（frontmatter 与 `metadata.keepseek` 解析、YAML 守卫）+ `skillCreator`/`skillStore` + `codexPlugin*`（插件 Skill 与资源快照）+ Webview Skill 菜单/`$` 选择 + 当前协议测试。
- **引用/输入**：context/references + Webview references/composer codec + opener/授权；手测拖拽、@、编辑重发。
- **Webview 消息**：webviewMessages 联合类型 + Provider `handleMessage()` + 发送/接收 fragment + i18n。
- **DraftEdit**：draftEdit/textPatch/artifact + ChangeSet/SafeFileEditor/Diff + approval hash/surface + checkpoint/subagent/UI。
- **审批/DraftRun**：approvalProcessing 批次规则 + store/reviewer + runs/* + Provider/Runner/authorization + user-tail/usage/UI。
- **项目写租约/并行会话**：`sessions/queue/writeLease*`（记录/镜像/协调器）+ `modeGate`/`writeGate` + ChangeSet/DraftRun/validation 的批次边界 + `test/writeLease.test.ts`。判定必须同步、授予必须异步，两者不可互换。
- **子代理**：subagents runtime/scheduler/store/profile/pathScope + model resolver + protocol/admission/checkpoint/usage。
- **会话结构**：`shared/types.ts` + chatSessionStore normalize + GlobalSessionStorage + UI/当前协议测试；原生 replay 归一化由 `sessions/providerReplayNormalization.ts` 负责。
- **活动节点/运行详情**：`agent/logging/activityNodes|runDetails|interactionTrace|performanceTrace|subagentDetails` + Webview 明细视图 + `test/activityNodes.test.ts`（时长只取记录、结果正文不进派生视图、节点数有上限）。
- **审批静态判定**：`approvals/authorization/*`（`commandSemantics`、`commandScope`、`localGitScope`、`gitRemoteScope`、`protectedTargets`、`preflight`、`packageLaunch`、`projectLaunchIdentity`、`exactOperationGrants`、`editTargets`、`executionBoundary`）+ `test/commandCapabilityGrammar.test.ts`、`test/protectedTargetPolicy.test.ts`。
- **Git 发布链路**：`runs/gitReleaseAuthorization|gitReleaseBatch|gitReleaseEvidence|gitTaskIntent|commandRecovery`；发布必须核实目的地、引用与实际推送对象。
- **行为评估**：`agent/behaviorEvaluation.ts` + `eval/agent-behavior/cases.json` + `scripts/run-agent-behavior-live.js`、`scripts/score-agent-behavior.js`（`bun run eval:agent:*`），不属于固定验证。
- **来源特有逻辑**：`agent/deepseek/*`（`balance`、`balanceStore`、`dsmlToolParser`）、`agent/kimi/balance.ts`；余额与凭据同样只经 `accounts/accountResolver.ts`。
- **配置注册**：命名空间来自 `shared/identity.ts` 的 `KEEPSEEK_CONFIGURATION_NAMESPACE`，读取在 `shared/config.ts`，声明在 `package.json` contributes.configuration。新增或改名配置键必须三处同步，否则运行时报 “not a registered configuration”（诊断帮助在 `shared/configurationRegistration.ts`）。

## 5. 验证与交付

- 默认运行 compile、lint、`bun run build:test && bun run test`；仅文档改动可用链接/格式检查替代，并说明未跑代码测试。
- 改缓存/投影：验证字节稳定、三协议 payload/replay、无摘要/摘要失败 fallback、protected/recent、usage 一致。
- 改 evidence/epoch：验证分页与跨 scope 拒绝、envelope 恢复、context-too-long、无伪 user、工具不重跑、未知副作用不重试。
- 改 edits/runs/approvals：验证两模式与非法审计拒绝、人工请求生命周期、hash 冲突、恢复、取消/超时/重复点击、删除/外部路径、依赖和跨平台 argv。
- 改 approve-all 调度/边界：验证 pass 期间触发排队不丢、每个边界只尝试一次、槽位释放后同一草稿被应用、失败原因在 ledger 与视图模型中精确可读、blocked 草稿跨重启可见且人工入口可用、未信任/待截断仍是硬阻断。
- 改写租约/串行化：验证两窗口同工程只出一个写者、TTL 过期但 pid 存活不被抢占、pid 死亡后可回收、epoch 过期操作失效、嵌套批次释放不提前放锁、空闲租约不被闸门拒绝、冲突只重生一次后转 blocked，且草稿生成全程不持锁。
- 改 Webview fragment：验证首次 ready、输入/拖拽/@、会话、设置、Apply/Discard 和键盘/焦点。
- 改 Webview fragment/样式：验证 fragment 顺序、顶层标识符唯一、根级 DOM id 唯一、getStyles() 选择器相对顺序，且 new Function(getScript()) 可编译。
- 测试应守行为契约，优先扩展最接近的现有 `test/*.test.ts`；不要只断言内部实现。
- `test/` 现有 28 个 `*.test.ts`，全部已在 `test/runTests.ts` 登记；按改动区域挑最接近的既有契约，文件级索引见附录 A。
- `scripts/verify-*`、`scripts/check-*`、`scripts/benchmark-*`、`scripts/field-acceptance-*` 是宿主侧手工核查或基准，不在 `bun run test` 内，也不属于固定验证；需要时先读脚本确认副作用。
- 新增或迁移测试必须在 `test/runTests.ts` 追加 `import`；未登记的用例 `bun run test` 静默不跑。
- 保留原文件行尾：仓库为 mixed CRLF/LF——`test/runTests.ts` 含 CRLF 行，`AGENTS.md` 与 `SUBAGENTS.md` 当前为 LF。局部修改沿用相邻行行尾，禁止整文件重写制造全量 diff。

## 6. 按需阅读

- `SUBAGENTS.md`：子代理架构、安全、恢复与用量
- `eval/agent-behavior/README.md`：行为评估用例格式、评分方式与运行前提

## 附录 A. 测试文件索引

`test/*.test.ts` 共 28 个，全部已在 `test/runTests.ts` 登记。按覆盖面分组（契约细节以文件内 describe/it 为准）：

- 会话与持久化：`sessionStartupStorageContracts`、`sessionOpenLazy`、`sessionObjectGc`、`sessionQuarantine`、`sessionAbsentTombstone`、`sessionMissingRecordShapes`、`sessionHistoryOrderAndStatus`、`sessionRunDismissal`、`sessionMenuToggle`、`startupContextFailure`、`accountEditorStartupFailure`
- 编辑/审批/命令：`changeSetBatchAdmission`、`approveAllBoundary`、`approveAllExecution`、`validationBarrier`、`validationAuthorization`、`runValidationReconciliation`、`commandCapabilityGrammar`、`protectedTargetPolicy`、`writeLease`
- Agent 与投影：`builtinGenPrompt`、`genPromptTurn`、`handoffGuardCorpus`、`handoffPromptBlock`
- 子代理：`subagentProfileCapability`
- Webview：`composerReadinessGate`、`webviewHelperResolution`
- 派生视图：`activityNodes`

`test/stubs/`、`sessionFixtures.ts`、`sessionUseFixture.ts`、`registerVscodeStub.ts` 是夹具与 stub，不是用例。调度、结果合同、continuation、子代理 store 恢复与用量归集仍无专属用例。
