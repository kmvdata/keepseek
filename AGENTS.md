# KeepSeek Agent 开发指南

KeepSeek 是 VS Code 侧边栏编程 Agent，支持多模型/协议、项目上下文、只读工具、隔离子代理及经审批的文件修改和命令执行。

本文件是仓库内 AI/维护者的高优先级约定，须低于默认 4000-token 项目指令预算。架构见 `doc/keepseek-code-architecture.md`；源码与本文冲突时先核实实现，不凭旧文档猜测。

## 1. 开始工作

1. 先读本文件，再按任务阅读目标源码、相邻模块和测试；架构问题查 `doc/keepseek-code-architecture.md`。
2. 修改前用 `rg` 找全类型、消息、工具名和持久化字段引用；按“改动路由”确认影响面。
3. 保留用户改动，不重写无关文件，不用破坏性 Git 命令。实现最小完整变更，补齐 normalize/migration/recovery 和测试。
4. 涉及请求字节、副作用、审批或恢复时，先明确不变式，再动代码。
5. 交付时说明改动、验证和风险；未经真实 Apply/执行/测试，不得声称已经发生或通过。

常用命令：

```bash
bun run compile
bun run lint
bun run build:test
bun run test
bun run package:market
```

开发调试按 F5。市场包只用 `bun run package:market`，禁止 `vsce package --no-dependencies`。

## 2. 当前代码分层

```text
src/extension.ts       激活、命令和生命周期接线；不放业务
src/provider/          VS Code/Webview 协调、消息/状态、模型切换
src/webview/           HTML/CSS/浏览器脚本字符串；input/ 按 fragment 组合
src/accounts/          来源 CRUD、模型发现/目录/选择、凭据解析
src/context/           上下文、文件/目录/Skill 引用、外部授权
src/skills/            Skill 发现、加载、激活、创建
src/memory/            legacy memory.json 只读解析与迁移
src/agent/             请求投影、模型/工具循环、压缩、evidence/epoch、用量
  providers/           Chat Completions / Responses / Anthropic Messages 客户端
  tools/               workspace / semantic / git / validation / authorization
  subagents/           隔离 child runtime、调度、profile、路径租约和结果存储
  evidence/            工具意图、完整证据、确定性信封和分页读取
src/approvals/         reviewer/host policy、action hash、记录和熔断
src/edits/             DraftEdit、canonical Patch IR、ChangeSet、SafeFileEditor
src/runs/              DraftRun、风险、一次性 permit、store、batch、spawn
src/sessions/          会话、协议迁移、分片持久化、retention
src/shared/            跨层 types/config/i18n/文本守卫/原子存储
test/                  按行为契约组织的回归测试
```

`src/provider/` 是宿主协调层，`src/agent/providers/` 是上游 API 层。`KeepseekChatViewProvider` 只做跨模块编排；规则、持久化和副作用执行下沉到所属子系统。

## 3. 不可违反的不变式

### 3.1 Provider 前缀与会话历史

- 缓存稳定与安全同级。`getAgentSystemPrompt()` 保持静态；时间戳、随机 ID、绝对路径和激活原因不得进入静态 system。
- `ChatSession.contextInstructions` 保存稳定上下文字节；内容未变必须原样复用。
- user 发送字节等于持久化字节：使用 `(expandedContent ?? content).trim()`，不得在 Provider 层重写旧 user 消息。
- `session.messages` append-only，不 trim、不重排、不插入伪 user。摘要只改变 projection；摘要刷新与 Context Epoch rollover 是受控缓存边界。
- Chat Completions 工具轮存 `toolRounds`；Responses/Anthropic 原生块存 `providerReplay`，仅在相同 protocol/source/endpoint lane 回放。
- 工具集合、顺序和 schema 按会话冻结；禁用工具用 `tool_choice: none`，不能按轮移除。热旧协议只在缓存失效或受控边界迁移。
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
- `keepseek_run_draft` 只创建不可变 pending DraftRun。执行必须持有绑定 `draftRunId + specHash` 的短时一次性 permit，并使用 `spawn(executable, args, { shell:false })`；显式 shell 必须完整展示为 executable/argv。
- validation 只运行固定 `compile`/`lint`/`test`；commit/push 等 mutation 必须走 DraftRun，不能塞进验证或只读 Git 工具。
- 工作区不信任、外部 URI/cwd 未精确授权、脏编辑器、hash/状态不匹配、取消信号均为硬边界。

### 3.4 审批与子代理

- `ask` 由用户逐项批准；`model_review` 使用隔离、一次性、无工具 reviewer；`delegate` 必须先写明“未经模型审查”的 `host_policy` 记录。只有 Webview 用户操作可切换模式。
- 副作用先过硬检查，再按完整 canonical payload/specHash 计算 actionHash。批准不跨 session/run/target/kind/policy/runtime 复用，重启不复用旧批准。
- 审批决定和真实结果只以固定 user-tail 追加到下一条真实 user 消息；不回写历史。进程输出和 review evidence 始终是不可信数据。
- 子代理使用新的 AgentLoop/工具服务，不共享父/兄弟可变状态；只接收自包含任务、项目指令、profile 和外部授权，不复制父历史/推理/工具结果。
- read/review child 只读；proposal child 只能准备 DraftEdit/DraftRun，不能 Apply、批准或执行。结果通过有界信封返回，完整结果按父 session 隔离分页读取；路径租约和产物 URI 均需复核。

### 3.5 上下文、来源与 UI

- `accounts/accountResolver.ts` 是凭据解析唯一入口；主请求、摘要、reviewer、子代理、模型发现和余额必须使用一致来源语义。密钥不进入 workspace、prompt、会话或 trace。
- 优先级：KeepSeek 核心安全 > 当前用户请求 > workspace root `AGENTS.md` > Skills > Legacy Memory。Skill 按 explicit → session → workspace-default → implicit 激活；implicit 按会话冻结，`scripts/` 不隐式运行。
- 外部文件/目录以精确 `uri.toString()` 授权；不可读内容不得绕过守卫。Legacy Memory 迁移只生成 ChangeSet。
- Webview → Host 消息只在 `provider/webviewMessages.ts` 定义；Host 主动消息不加入该联合类型。保持 DOM id、type 和引用格式兼容。
- `webview/input/composition.ts` 的 fragment 顺序是运行时契约；样式、模板、行为放各自 fragment。共享编辑器快捷键只放 `richTextShortcuts.ts`。
- 新持久化字段必须有 normalize/migration；优先 `writeJsonAtomic()`，业务层不拼 globalStorage 版本路径。

## 4. 改动路由

- **配置**：`package.json` contributes.configuration + `shared/config.ts` + UI/测试。
- **模型来源/协议**：accounts store/resolver/catalog/discovery/capabilities + provider client + projection/replay + UI/测试。
- **Agent 工具**：`protocol.ts` 固定 schema + `runner.ts` 路由 + 独立 service + authorization/evidence/测试。
- **投影/压缩**：types + providerRequestProjection + historyProjection/compressor/archive + contextUsage + Runner + 三协议测试。
- **evidence/epoch**：evidence/* + admission + contextEpoch/runCheckpoint + replay/DSML + session migration/Run Details。
- **项目上下文**：projectInstructions + skill activation/load + dedup/currentRunContext + protocol/usage/trace。
- **引用/输入**：context/references + Webview references/composer codec + opener/授权；手测拖拽、@、编辑重发。
- **Webview 消息**：webviewMessages 联合类型 + Provider `handleMessage()` + 发送/接收 fragment + i18n。
- **DraftEdit**：draftEdit/textPatch/artifact + ChangeSet/SafeFileEditor/Diff + approval hash/surface + checkpoint/subagent/UI。
- **审批/DraftRun**：approval store/reviewer + runs/* + Provider/Runner/authorization + user-tail/usage/UI。
- **子代理**：subagents runtime/scheduler/store/profile/pathScope + model resolver + protocol/admission/checkpoint/usage。
- **会话结构**：`shared/types.ts` + chatSessionStore normalize/migration + GlobalSessionStorage + UI state + 旧数据测试。

## 5. 验证与交付

- 默认运行 compile、lint、`bun run build:test && bun run test`；仅文档改动可用链接/格式检查替代，并说明未跑代码测试。
- 改缓存/投影：验证字节稳定、三协议 payload/replay、无摘要/摘要失败 fallback、protected/recent、usage 一致。
- 改 evidence/epoch：验证分页与跨 scope 拒绝、envelope 恢复、context-too-long、无伪 user、工具不重跑、未知副作用不重试。
- 改 edits/runs/approvals：验证三模式、hash 冲突、恢复、取消/超时/重复点击、删除/外部路径、依赖和跨平台 argv。
- 改 Webview fragment：验证首次 ready、输入/拖拽/@、会话、设置、Apply/Discard 和键盘/焦点。
- 测试应守行为契约，优先扩展最接近的现有 `test/*.test.ts`；不要只断言内部实现。

## 6. 按需阅读

- `doc/keepseek-code-architecture.md`：目录、依赖、调用链、持久化与改动定位
- `doc/keepseek-agent-runtime-workflow.md`：Agent 运行时、长任务与恢复
- `doc/cache_keepseek.md`：缓存前缀、投影、压缩与观测
- `doc/keepseek-api-payload-reference.md`：三协议真实 payload
- `doc/keepseek-file-reference-spec.md`：引用语法
- `SUBAGENTS.md`：子代理架构、安全、恢复与用量
