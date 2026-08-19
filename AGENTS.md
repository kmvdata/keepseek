# KeepSeek 架构与维护指南

KeepSeek 是一个 VS Code 扩展：在 Secondary Sidebar 提供 AI 对话面板，负责会话、上下文文件、文件/目录引用展开、DeepSeek/OpenAI 兼容流式请求、只读工作区工具，以及用户确认后的 DraftEdit 写入。本文档是仓库内 Agent/维护者约定的唯一来源，旧版约定若与本文冲突，以当前源码和本文为准。

> **给维护 Agent 的说明**：本文件作为 project instructions 注入每个 Agent run，默认受 `keepseek.projectInstructions.contextBudgetTokens`（4000 token）预算约束。**保持精简是为了完整加载、不被截断**；详细设计在 `doc/` 下，需要时用只读工具按需读取。
> **模型画像**：主力模型 DeepSeek V4 Flash（1M 上下文窗口、Thinking high/max）。1M 窗口让"投影 + 摘要"取代硬裁剪可行；前缀缓存命中价低至 1/30，是产品的经济命脉——因此"字节冻结"是本文档最高优先级不变式。本文档用结构化中文编写，便于逐条引用。

## 一、最高优先级不变式（不可违反）

1. **缓存命中率是第一位的产品行为**（与安全同级，高于"实现简洁性"）：DeepSeek 前缀缓存从请求第 0 个 token 起逐字节匹配，任何历史字节漂移都会使该点之后整段缓存失效。改动若可能改变请求前缀字节，必须证明前缀仍稳定，或明确标注为可接受的缓存代价。
2. **Agent 永不直接写盘**：create/modify/delete 只能生成待确认 DraftEdit → 进入 ChangeSet；只有用户点击 Apply 后 `ChangeSetStore` 才通过 `SafeFileEditor` 落盘。不要声称文件已写入。
3. **只读与 Git 边界**：Agent 只读工具不出工作区；Git 只有只读查询（status/diff/branch/patch/commit message 建议），绝不 push、不自动 commit。
4. **受控验证**：只运行固定 `compile` / `lint` / `test`。验证失败后读取 Problems、准备修复 DraftEdit 并进入 `waiting_for_apply`；修复未应用不得再次验证，修复轮次受 `keepseek.validation.maxRepairIterations` 限制。

## 二、常用命令（bun）

```bash
bun run compile          # src → out/（F5 调试的 preLaunchTask 也会跑）
bun run lint             # ESLint
bun run build:test       # 测试编译 → out-test/
bun run test             # 测试套件（node out-test/test/runTests.js）
bun run package:market   # 发布打包（含安全校验，见"七、发布"）
bun run reinstall:vsix   # 本机一键重装验证：打包 → 卸载旧版 → 安装新版
```

开发调试：用 VS Code 打开仓库，按 F5 启动 Extension Development Host。

## 三、分层结构速览

```text
src/
├── extension.ts                 # 激活入口、命令注册、事件接线（不放业务）
├── provider/
│   ├── KeepseekChatViewProvider.ts # VS Code/Webview 协调者（消息分发/状态推送/服务接线）
│   └── webviewMessages.ts       # Webview → 扩展消息联合类型唯一来源
├── agent/
│   ├── runner.ts                # 请求编排、工具调用循环、最终响应整理
│   ├── protocol.ts              # system prompt、消息拼装、工具 schema、token 估算入口
│   ├── historyProjection.ts     # 模型历史投影（摘要+保护消息+最近轮次）★压缩核心
│   ├── historyCompressor.ts     # 会话摘要刷新与失败回退 ★压缩核心
│   ├── contextUsage.ts          # 用量估算（必须与真实请求共用同一 projection）
│   ├── currentRunContext.ts     # 项目指令/Skills/Legacy 统一投影入口
│   └── tools/                   # workspace / semantic / validation / git / toolAuthorization
├── accounts/                    # 来源 CRUD、accountResolver（凭据唯一入口）、modelDiscovery
├── context/references/          # <path> / <path#Lx-Ly> / <keepseek-dir:> 展开、授权、@ 补全
├── edits/                       # changeSetStore（主管线）、safeFileEditor、draftDiffService
├── sessions/                    # chatSessionStore、globalSessionStorage（摘要/归档存这里）
├── skills/                      # Skill 发现/激活/加载（绝不执行 scripts）
├── memory/                      # legacy memory.json 只读解析与迁移
├── shared/                      # config / types / i18n / markdown / textFileGuards 共享边界
└── webview/                     # html（CSP/拼装）/ styles / script / input / richTextShortcuts（只输出字符串）
```

## 四、核心不变式

### 4.1 请求前缀字节冻结（缓存第一）

- **system 段纯静态**：`getAgentSystemPrompt()` 不随轮次变化。`contextInstructions`（AGENTS.md / Skills / Legacy Memory / Context Files 的格式化结果）持久化在 `ChatSession.contextInstructions`——字节未变就逐字节复用，禁止每轮重新生成；变化即整体重写（一次可接受的缓存代价）。
- **user 消息"发送字节 == 持久化字节"**：一律以 `(expandedContent ?? content).trim()` 发送，禁止发送时再包装/拼接。动态内容（goal、临时指令、后台任务状态）只追加在 user 消息尾部，绝不改写已发送历史。
- **assistant 消息原样持久化**：工具轮（tool_calls / tool 结果）经 `ChatMessage.toolRounds` 逐字节还原；`reasoning_content` 原样保存。
- **历史投影 append-only**：只追加，不重写、不 trim、不重排；摘要刷新是受控低频缓存重置点（`SUMMARY_INCREMENTAL_MESSAGE_THRESHOLD` 故意调高）。
- **工具 schema 按会话冻结**：集合与顺序跨轮不变；禁用工具用 `tool_choice: none` 而非移除 tools；slim mode 默认关闭。

禁止：把时间戳/随机 UUID/绝对路径/激活 reason 写入 system 段或历史消息；在热会话中重写历史或移除未覆盖消息；让 schema 随 prompt 变化。

### 4.2 上下文压缩与投影

- 模型输入是 projection，不等同于 `session.messages`；摘要存 `ChatSession.contextCompression.summaries`，绝不进入聊天 UI。
- 摘要只留线索（目标、决策、错误、文件路径/行段/函数名、完成项、待办）；文件正文/日志/代码块不保留，模型需要细节时用只读工具**重读当前文件**。
- 自动保护：首条需求、最近输入、显式"记住"、报错/测试失败、用户纠错、DraftEdit 结果——不被摘要覆盖。
- 摘要请求：当前模型、关 thinking、无 tools、限 `contextSummaryBudgetTokens`、短超时；失败只记录 `lastFailureReason`，绝不阻塞用户消息。
- 降级兜底（异常路径）：无可用摘要且投影估算超 `contextWindowTokens × forceRatio` 时，截断为最近消息尾部。
- 配置集中在 `shared/config.ts`；数据结构在 `shared/types.ts`（`contextMeta` / `contextCompression` / `ContextProjectionMetadata`）。

### 4.3 账户与模型来源

- `accounts/accountResolver.ts` 是按来源解析凭证的唯一入口；删除、模型切换、摘要、主请求、余额的来源语义必须一致；密钥不得写入 workspace 或 trace。
- 仅官网 DeepSeek（`provider === 'deepseek' && baseUrl.host === 'api.deepseek.com'`）保留余额/费用能力；其余来源只走 chat completions / SSE / 工具调用 / token 统计。
- 来源持久化在 `globalStorageUri/accounts/<provider>/`；旧 `keepseek.apiKey` / `keepseek.baseUrl` 只复制迁移、不修改；`.initialized` 不含密钥。

### 4.4 安全写入与删除

- `ChangeSetStore` 是待确认修改主管线（Diff/Apply/Discard/Revert/checkpoint）；`SafeFileEditor` 负责单文件写入/删除、脏编辑器保护、删除前基线检查与 checkpoint 回滚。不要把应用行为放进 `AgentRunner`。
- 删除是高风险：授权 modal + Apply 前删除专用 modal；草案后文件被改动则拒绝删除；目录/二进制/超限/越界拒绝。
- 外部文件/目录必须先授权（授权 key = `uri.toString()`）。

### 4.5 Skills 与项目指令

- 激活顺序：explicit → session → workspace-default → implicit；`allowImplicit: false` 不可隐式激活；未受信任工作区不自动加载项目 Skill。
- `ProjectInstructionsResolver` 只读各受信任 workspace root 的 `AGENTS.md`（`.agents/**/AGENTS.md` 属于 Skill，不作为全局项目指令）；受文件大小与 token 预算约束。
- Skill 的 `scripts/` 只在清单与 Run Details 中标记存在，**绝不执行**；workspace 默认只持久化 Skill URI 引用，不复制内容。
- Legacy `memory.json` 只读、最低优先级注入；迁移只能生成待确认 ChangeSet，不删除旧文件。不使用 `window.prompt()` / `window.alert()` / `window.confirm()`。

## 五、改动影响面清单（改前必查）

- **新增配置**：先改 `package.json` 的 contributes.configuration，再改 `shared/config.ts`。
- **模型来源/发现/余额**：同步检查 accountStore、accountResolver、modelDiscovery、runner、historyCompressor、balanceStore、Provider；任何请求路径不得重新直读 apiKey/baseUrl。
- **压缩相关**：同步检查 shared/types.ts、historyProjection、historyCompressor、contextUsage、runner——真实请求与 usage 估算必须共用同一 projection。
- **项目指令/Skill/Legacy**：同步检查 projectInstructions、skillActivationResolver、contextDeduplication、currentRunContext、contextUsage、protocol、Run Details/trace；不要在 Provider 内复制匹配或优先级逻辑。
- **Webview → 扩展消息**：更新 webviewMessages.ts 的联合类型 + Provider `handleMessage()` + webview 发送点；剪贴板兜底消息由 richTextShortcuts 统一发起。
- **扩展 → Webview 主动消息**：不进 `WebviewMessage`，在 webview message listener 中处理。
- **新增 Agent 工具**：更新 protocol.ts 的 schema + runner 的工具路由；实现放独立模块。
- **引用格式**：同步检查 fileReference、directoryReference、webview/input/script.ts、webview/script.ts 的序列化/反序列化/打开逻辑。
- **DraftEdit/ChangeSet 行为**：优先改 ChangeSetStore / SafeFileEditor。
- **UI 归属**：样式只碰 styles.ts；输入区只碰 input/script.ts；transcript/设置/会话只碰 script.ts；通用快捷键碰 richTextShortcuts.ts（两个编辑器共用，勿复制实现）。
- **公共逻辑复用**：Markdown fence、字节格式化、配置读取、错误字符串、文本文件判断用 shared/*，勿复制。

## 六、测试与手测

- 单测：`bun run build:test && bun run test`（重点覆盖：缓存字节稳定、压缩 fallback、引用展开、ChangeSet、授权、Skill 激活）。
- 改压缩核心后必须验证：压缩关闭 fallback、无摘要 fallback、摘要失败 fallback、protected 消息、最近轮次、context usage 估算一致。
- 改引用/输入后手测：全文/行段/目录引用、外部授权、不可读文件跳过、拖拽（多数据源 + 判空）、`@` 补全、编辑重发。
- 改 edits 后手测：Apply/Discard/Apply All、删除 modal、删除前文件变化冲突、脏编辑器拒绝。
- 大字符串文件（webview/script.ts、webview/input/script.ts）改动后保持 DOM id / message type / 序列化格式兼容，并手测输入、拖拽、`@` 引用、Apply/Discard。

## 七、发布

```bash
bun run package:market
```

`package:market`（scripts/package-market.js）：检查运行时依赖已安装 → 清理 `out/` → 编译 → `vsce package --dependencies` → `verify-vsix.js` 校验（确认含 `node_modules/ignore` 与 main 入口、无旧扁平 `out/*.js` 产物）。**绝不**裸跑 `npx vsce package --no-dependencies`（市场版会缺依赖、激活失败）。`bun run reinstall:vsix` 用于本地一键重装验证。

## 八、详细设计文档

- `doc/cache_keepseek.md`：缓存命中优化技术详解（维护者/进阶）
- `doc/keepseek-agent-runtime-workflow.md`：Agent 运行时工作流
- `doc/keepseek-api-payload-reference.md`：API payload 参考
- `doc/keepseek-file-reference-spec.md`：文件引用规范（序列化格式、右键菜单、拖拽流程等细节）
