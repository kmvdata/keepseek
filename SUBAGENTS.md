# KeepSeek 子代理：实现细节与改动约束

面向维护本仓库的 AI。通用分层、审批边界、验证方式与改动路由以 [`AGENTS.md`](AGENTS.md) 为唯一权威；本文只保留子代理特有的、改代码时必须知道的常量、路径与契约。**所有数字都以源码为准；改动常量后请同步本文，不要让文档变成第二份常量表。**

## 1. 入口

| 入口 | 位置 |
| --- | --- |
| `keepseek_delegate_task` / `keepseek_delegate_parallel` / `keepseek_delegation_checkpoint` / `keepseek_read_subagent_result` | schema 在 `src/agent/protocol.ts`，路由在 `src/agent/runner.ts` |
| 斜杠命令 `/research` `/review` `/proposal` `/parallel` | Provider 轮次准备 + `src/agent/subagents/runtime.ts` |
| 子代理模型设置（`/` → 子代理模型，review 显示为“代码审查”） | `src/accounts/subagentSettingsStore.ts` |

版本：`SUBAGENT_PROTOCOL_VERSION = CURRENT_AGENT_PROTOCOL_VERSION`（`src/agent/protocol.ts`，当前 15）。子代理自己的合同版本独立演进：结果 envelope `contractVersion: 2`、handoff manifest `version: 3`、继承 capsule V1、child 对象图 `version: 4`、result index V1、`ChatSession.subagentUsageStats` schema v1。

## 2. 模块分工

| 关注点 | 文件 |
| --- | --- |
| child 运行时、生命周期、校验 | `src/agent/subagents/runtime.ts` |
| 并发、树预算、proposal 路径租约 | `src/agent/subagents/scheduler.ts` |
| profile 解析与工具集 | `src/agent/subagents/profiles.ts` |
| handoff manifest / parallel manifest | `src/agent/subagents/handoff.ts` |
| 结果 envelope 校验、read set、分页索引 | `src/agent/subagents/resultEnvelope.ts`、`resultIndex.ts` |
| 宿主继承 capsule | `src/agent/subagents/contextCapsule.ts` |
| 路径作用域归一化与重叠判定 | `src/agent/subagents/pathScope.ts` |
| 持久化、分页读取、删除墓碑 | `src/agent/subagents/store.ts` |
| 类型与预算快照 | `src/agent/subagents/types.ts` |
| 用量归集与本地隔离估算 | `src/agent/subagentUsageStats.ts` |

不要在 Provider 或 Webview 复制调度、工具集或权限判断。

## 3. profile 与工具集（`profiles.ts`）

- `READ_TOOLS`：workspace 列表/目录/搜索/读文件/读行段/诊断 + 语义符号 4 项 + Git 只读 5 项（status、diff、branch、create_patch、suggest_commit_message）。
- `PROPOSAL_TOOLS` = `READ_TOOLS` + `apply_patch`、`create_draft_edit`、`create_incremental_draft_edit`、`delete_workspace_file`、`run_draft`。
- 内置 profile：`research`（lane `research-read`）、`review`（lane `review-read`）均可再委派；`proposal`（lane `proposal`）不可再委派。三者 `resultMaxChars` 均为 120000。
- Skill profile：`metadata.keepseek.tools` 是工具权威；缺省回落 `READ_TOOLS`；未知工具名按 `PROPOSAL_TOOLS` 集合过滤（不是信任声明）；lane 由「是否含写/命令工具」推导；`canDelegate` 只控制再委派，不增减工具。

改工具集必须同时改 §7 的执行时门禁：schema 白名单不是唯一防线。

## 4. 调度与硬上限（`scheduler.ts`）

| 限制 | 常量 | 值 |
| --- | --- | ---: |
| 全局同时运行 child | `DEFAULT_SUBAGENT_TOTAL_CONCURRENCY` | 4 |
| depth=1（root）并发槽 | `DEFAULT_SUBAGENT_ROOT_CONCURRENCY` | 3 |
| depth≥2 并发槽 | 总数减 root | 1 |
| proposal 并发 | `DEFAULT_SUBAGENT_PROPOSAL_CONCURRENCY` | 2 |
| 最大委派深度 | `DEFAULT_SUBAGENT_MAX_DEPTH` | 2 |
| 单 parent 累计派发 | `DEFAULT_SUBAGENT_MAX_CHILDREN_PER_PARENT_RUN` | 8 |
| 单任务树 child 总数 | `DEFAULT_SUBAGENT_MAX_CHILDREN_PER_TREE` | 12 |
| 单批 `keepseek_delegate_parallel` | `MAX_PARALLEL_TASKS`（`runtime.ts`） | 8 |

- `reserveBatch()` 在 staged 副本上预演整批（深度、parent 计数、树计数、proposal scope），任一失败整批拒绝，不会半批启动。
- proposal 预检同时对比父会话现有 DraftEdit scope 与其他 active owner 的 claim；`activeProposalClaims` 按 owner 记录，重启后由 `snapshotTree`/`restoreTree` 恢复。中断的树保留计数与路径 claim，直到逻辑任务完成或放弃才 `releaseTree`。
- step 派生：父 `executionLimits.maxToolIterations` 未配置时按 10 计；child 上限 = `max(5, floor(parent / 2))`，请求值（工具参数或 `profile.maxSteps`）再 clamp 到 1–32；`maxToolCalls = max(steps, steps * 2)`，`maxRunMs = timeoutMs`。

## 5. 时间、请求、token 与费用

| 配置键（命名空间 `kmvdata.keepseek.`） | 默认 | 作用 |
| --- | ---: | --- |
| `agent.subagentMaxExecutionMs` | 300000 | 单 child 有效执行时长上限，仍受根任务限制 |
| `agent.maxExecutionMs` | 0（不限） | 根逻辑任务共享时钟，跨 epoch/恢复/child |
| `agent.subagentMaxModelRequests` | 12 | 单 child 物理 Provider 请求数上限 |
| `agent.subagentMaxUpstreamTokens` | 500000 | 单 child 上游 token 上限，仍受树级限制 |
| `agent.maxTreeUpstreamTokens` | 0（不限） | 根任务 + 全部 child 合计上限 |
| `agent.maxCost` | 0（不限） | 按币种计费上限，child 与恢复共享；正值遇到不可计价来源 fail-closed |
| `subagent.handoffPreviewBytes` | 10240 | 单个 manifest 预览 UTF-8 字节（1024–24576） |
| `subagent.parallelHandoffBytes` | 20480 | 一次并行 handoff 总预算（16384–65536），先保留状态/引用 |

`modelRequestTimeoutSeconds`（application 级）是单次网络请求超时，与上述执行预算不可混用。正数限制取更严格值，且不能通过重试、continuation、epoch rollover 或委派重置。

Skill frontmatter（`src/skills/skillMetadata.ts` 的 `parseSkillFrontmatter`）字段越界即拒绝解析：`runAs` 仅 `subagent`、`profile` ≤80、`tools` ≤64 项、`maxSteps` 1–32、`timeoutMs` 1000–900000、`resultMaxChars` 1000–500000、`canDelegate` 布尔。SKILL.md 另有 YAML 边界：≤64 KiB、禁 anchor/alias/重复键，`name` ≤64、`description` ≤1024。

## 6. 输入隔离

注入：自包含 brief 与稳定 task hash、项目指令受控投影、workspace root manifest 与信任状态、profile/工具/路径作用域、完成任务所需的外部 URI 授权、共享时间/费用/取消账本引用。

禁止：父历史与隐藏推理、父工具结果正文、父 Context Files/归档/Memory、未选中 Skill 正文、API key、审批 permit、父 Agent 可变对象。

`contextCapsule.ts` 的 capsule V1 供宿主解析与恢复，保留项目指令原字节、workspace manifest、已激活 subagent profile 身份/版本与精确外部授权；整包不发给模型。一级与二级 child 都能解析已授权 profile，但模型只收到当前 profile 与适用项目约束。capsule hash 进入 compatibility family，缺失或变化时拒绝旧 continuation/reuse。

## 7. 工具暴露与执行时门禁

```text
provider tool call
  → schema/参数解析
  → 当前 child 工具集合校验（projected tool names）
  → task/path/authorization 校验
  → 工具执行或 fail closed
```

规则：

- child 用通用 `keepseek_read_evidence` 读普通工具证据，用固定 schema 的 `keepseek_read_subagent_result` 按 result ref 分页读完整结论。
- `keepseek_apply_patch` 只在允许提案的 profile/lane 暴露。
- 再委派工具只在 profile `canDelegate`、depth < 2 且 lane 不是 `proposal` 时暴露；嵌套 child 为 `nested-read` 级别，不能再派发。
- 并行 proposal lane 会移除可能引入未知路径副作用的 `run_draft` 能力。
- 伪造未暴露的工具名会执行时被拒绝并留下诊断。

## 8. 结果合同与 handoff

envelope 公共字段：`taskHash`、`status`、`summary`、`evidence`、`uncertainties`；contract V2 追加 `coverage`、`missing`、`nextSteps`、`verification`。review 追加 `verdict`/`reviewedPaths`/findings；proposal 的产物数量以宿主统计为准。

- 格式错误只允许一次“仅修复格式”的无工具请求，仍不合法则 fail closed；解析器不得从自由文本猜安全字段。
- 超过 `profile.resultMaxChars` 时生成合法、有界的 `partial` canonical，记 `missing: ["result_too_large"]` 与原始 hash/字符数；序列化后 >2 MiB 直接拒绝接受。preview 缩减不等于 canonical 被截断。
- 四层状态分开记录：生命周期 `status`、结构接受 `formatAccepted`、完成程度 `resultStatus`、父验收 `parentAcceptance`。`ok` 只表示交付结构可接受。

`handoff.ts` 边界（改这里必须同步测试）：`version: 3`；summary 压成单行且 ≤1024 字符；preview 默认 10240 字节；单结果 manifest 默认总上限 12288 字节；parallel manifest 至少 16384、默认 20480 字节。单结果超限时按 preview → summary/error 截到 160 字符 → 清空 `keyEvidence`/`uncertainties` 的顺序降级，并对实际字节重算 `hasMore`。并行按 JSON escaping 后的真实字节公平分配，先保留 status 与 resultRef。

`resultRef` 用 `keepseek_read_subagent_result` 读（默认 12288、最大 24576 字节 UTF-8 分页），`evidenceRef` 用 `keepseek_read_evidence` 读，二者不可互替。父侧先审摘要/完成程度/缺失项，再用 checkpoint `action=accept` 记录 `adopt|needs_details|investigate|reject`；采纳不是审批许可。

## 9. proposal 路径安全

两阶段检查：批次启动前按 sibling tasks、活跃 proposal、父会话现有 DraftEdit 校验 scope，整批接受或整批拒绝；child 返回后按实际 artifact URI 复检一次。模型声明的路径只是提示。无 scope/roots、越界、未授权外部 URI、目录/二进制、基线变化一律 fail closed。产物只能回到父审批管线，Apply/执行/审批 hash/`SafeFileEditor`/`ExecutionPermit` 与主 Agent 完全相同。

## 10. Continuation 与复用

continuation 只在同一父 session 内有效，绑定 source/model、system/request/tool schema 版本、profile 与工具集、项目指令、workspace manifest、外部授权与路径作用域、父任务与 child run 身份。任一 hash 不匹配即拒绝，不“尽量恢复”，并且必须有有效 capsule 继承证明。

已完成结果复用仅限完整、未截断、格式获接受的 research/review；proposal、partial、损坏结果不复用。除 task 与 compatibility 一致外还要证明 read set 仍新鲜：广泛搜索、依赖无法枚举或环境信息不足时 freshness 视为 unverified，禁止复用。复用生成新的稳定引用，不复制旧 transcript，也不伪造 provider 调用。

## 11. 取消、重启与存储

用户停止、预算耗尽、父 Agent 结束、工作区失信都会向整棵 child 树传播取消；排队中的 child 也会被取消。扩展重启时 queued/running 归一化为 stopped/interrupted，不自动重派；provider 请求是否已发出不明确时不重放，可能产生副作用的 proposal 保持 uncertain。progress 事件只允许白名单字段。child 诊断裁剪大小并脱敏凭据、环境变量与绝对路径。

```text
nativeStorageRoot/chat-sessions/v1/subagents/<workspaceHash>/<parentSessionId>/
  <childId>.state.json        # 对象图 version 4 + summary v1（含 summaryHash、resultIndex v1）
  <childId>.activity.json     # 活动/统计索引
```

只写这两类文件；不读 combined `.run.json`、split `.meta.json/.transcript.json` 等旧布局。加载时校验 `version`、`workspaceKey`、`sessionId`、`summary.version` 与 `summaryHash`，损坏结果不能触发 child 重执行，也不能静默回退旧文件。分页只解码元数据与请求范围相关 chunk 并核对 hash，不暴露私有 transcript/checkpoint。引用链受 workspace/session/tree/lineage 与循环检查约束。

## 12. 用量归集

- 每个真实 child 请求以 `usageSource = 'subagent'` 写入共享 Usage Ledger；failed/stopped 的已发生用量仍计入；nested 用量逐层上报一次，不重复累计。
- 实际 token 只取 provider usage，字段缺失记 unknown（不填 0）；固定子模型按 `sourceId + modelId` 分组；不同币种分别累计，不做汇率换算。
- 会话级 `subagentUsageStats`（schema v1）保留累计 totals 与已归集 ID，UI 明细窗口 `MAX_RECENT_SUBAGENT_RUNS = 50`；明细滚动不能丢累计值，也不能让旧 run 重复计费。
- 本地隔离估算 `SUBAGENT_USAGE_ESTIMATOR_VERSION = 'local-context-v1'`：`isolated = delegate 调用 + child 私有工具结果 + child 私有推理`，`returned = 父侧实际接纳的 root child envelope`，`isolationRate = isolated / (isolated + returned)`；分母为 0 不显示百分比；这是估算，不是账单节省或缓存命中。
- Webview 只接收汇总。`toSubagentProgressViewModel()` 是 progress 白名单；不得下发 prompt、完整结果、transcript、隐藏推理、endpoint 身份、内部 hash 或 ledger 原始记录。

## 13. 改子代理时的检查清单

1. 改 profile/工具/协议：schema 白名单与 Runner 执行时门禁同步；确认嵌套与 proposal lane 未获得额外副作用能力；V15 schema 字节稳定，Evidence 与 UTF-8 byte-offset result reader 行为不变。
2. 改调度/时间/预算：父子共享逻辑任务时钟、费用与取消不可重置；并行时间按区间并集核算；队列不能绕过全局/root/proposal/depth/tree 上限；不得重新引入隐式默认预算。
3. 改 proposal：批次预检与返回后实际 URI 复检都要保留；产物数量取宿主记录；DraftEdit/DraftRun 必须回到父审批管线。
4. 改 handoff/store：preview 缩减不得改变 canonical、`hasMore` 必须按实际交付字节重算、损坏或越界一律拒绝而不是降级读取。
5. 改统计：provider 实际用量与本地估算分开；覆盖 failed/stopped、nested、重复 ID、非法 schema、币种分组，并对 UI payload 做隐私断言。

## 14. 回归测试

```bash
bun run build:test
bun run test
```

新增测试文件必须在 `test/runTests.ts` 追加 `import`，否则 `bun run test` 静默不跑。

| 测试 | 契约 |
| --- | --- |
| `test/subagentProfileCapability.test.ts` | 内置与自定义 profile 的工具集合、`canDelegate` 与 lane 推导 |
| `test/handoffGuardCorpus.test.ts` | handoff/委派边界语料与守卫 |
| `test/changeSetBatchAdmission.test.ts` | ChangeSet 批次准入与路径租约 |
| `test/approveAllBoundary.test.ts`、`test/approveAllExecution.test.ts` | approve-all 边界、ledger 与真实执行 |
| `test/validationBarrier.test.ts`、`test/validationAuthorization.test.ts`、`test/runValidationReconciliation.test.ts` | 验证屏障、授权与结果对账 |
| `test/writeLease.test.ts` | 项目写租约：单一写者、TTL+pid 回收、epoch、嵌套深度 |

调度、结果合同、continuation、store 恢复与用量归集目前**没有专属用例**；改动这些区域时须自行补断言，并优先扩展上表最接近的既有契约。

审查子代理改动时最关键的问题是：**这个 child 是否只获得任务必需的信息和能力，它的结果是否仍必须经过父会话原有的安全边界？**