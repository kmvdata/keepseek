# 项目执行所有权、资源阶段与请求准入

> 历史验收档案：下述文件锁与 Windows 限制只对应 2026-11-07 基线。当前 owner 后端、按需启动、平台检查和恢复合同由 [2026-11-08 修复与验收](keepseek-blank-startup-owner-verification.md) 取代；原证据保留。

核验日期：2026-11-07（Asia/Shanghai）。基线 `87ee2bbc29546e575556f2e49aae67136f781e00`，本次工作树实现。本文仅负责物理项目所有权、修改/验证协调、实际请求准入与对应证据；项目助手完整合同见 [项目助手专题](keepseek-project-assistant.md)。

## 源码与不变式

| 入口 | 当前行为 |
| --- | --- |
| `tasks/projectOwner.ts` | realpath、最近 Git 根和物理目录 dev/inode 身份合并路径/大小写/符号链接及 workspaceKey 别名。POSIX 默认锁位于固定 `/tmp/keepseek-project-owners-<uid>`，不随窗口的 TMPDIR 或 workspace storage 改变。原子 `open(wx)` 获取生命周期锁，写入并 fsync owner nonce/pid/root。 |
| `tasks/projectResources.ts` | 每物理项目一个 FIFO 修改/验证阶段；session/root/segment/runtime 身份完整，重入必须透传同一内存 token。同段失效永久记录，迟到回调不能重新获取新租约。scope 通过 AsyncLocalStorage 冻结传递，不能按正在查看的会话写入。 |
| `tasks/requestAdmission.ts` | 根任务逻辑槽（默认 2）、项目共享逻辑 child（depth 1=3、depth 2 保留 1、proposal 子集=2）与实际请求池分开。实际请求默认项目 8、来源 4；来源按 endpoint origin 保守合并别名。Router 有有界优先级，连续两次优先后按 FIFO 防止 Worker 饥饿。 |
| `subagents/scheduler.ts` / `runtime.ts` | 不同 Worker 的实际 Runtime 在 ALS 中共用上述 child 准入；各自保留树预算/路径声明/私有工具及 transcript。委派或等待活跃结果时挂起并归还父 child permit，返回前重新获取；取消不重新获取。持工作区租约等待 child 明确拒绝；实际请求 permit 不跨这些等待持有。 |
| `agent/providers/openAiCompatibleClient.ts` | 每个物理 HTTP attempt 进入共享请求池，直到 SSE/error body 清理结束才释放；重试退避不持有 permit。三种协议使用同一传输基类。序列化正文、endpoint、schema、冻结重试字节不变。真正 fetch 前再次验证执行 owner。 |
| `edits/safeFileEditor.ts` | Apply/Revert 的实际服务获取阶段 token，保留原 preflight/journal/hash/脏编辑器/原子写/read-back；真实写入前复查 owner、租约和授权。 |
| `runs/draftRunExecutor.ts` | 实际 spawn 处获取同一阶段资源，队列后复查一次性 permit、信任和取消。仍为 `spawn(...,{shell:false})`；未决或未知进程结果不产生重试权限。 |
| `agent/tools/validationTools.ts` | 固定 compile/lint/test 使用同一阶段资源。验证输出附宿主 `projectResource`（project/revision/phase/实际 snapshot fingerprint）；后续修改使旧 revision 不再当前有效。 |
| Provider `executeDelegatedApprovals` | 批准耐久后惰性获取阶段，连续 host_policy 操作和相关结果核验持同一 token；进入模型 reviewer、人工等待、预算/恢复或模型续跑前释放，finally 也释放。重新获取时核对准备时资源 revision，编辑还在租约内复核 live actionHash、范围和 preflight；DraftRun 保留完整宿主预检/一次性 permit 链。 |

阶段不能覆盖人工回答、模型 reviewer、child、Router 或模型续跑等待。释放后不再声称旧修改与未来验证始终原子；重新获取必须核对当前基线。外部编辑器和用户进程不受此协调器约束，既有真实文件和运行边界检查继续是必要条件。

所有权锁与短 session 写锁不同。owner 文件时间戳、心跳过期、甚至 `ESRCH` 都不会触发抢占：旧宿主退出并不能证明 detached 命令已退出。正常释放要求被跟踪的执行/实际服务/请求已经结算。未知进程结果、输出流未结清或不确定文件修改会锁住后续修改阶段，并保留 owner 锁供人工核对；不自动重跑，也没有自动清理旧锁的后台任务。

## 本机证据

平台：macOS Darwin 25.5.0、x64、Node v24.15.0、APFS（`statfs.type=26`）。所有项目、Git 标记、存储、锁和文件均是临时 fixture；没有修改真实项目文件作为执行证据，没有调用付费 Provider。

| 验证 | 结果与边界 |
| --- | --- |
| 双进程所有权 | 已验证：独立 Node 进程拒绝已有 live owner；两个真实进程并发原子争锁最多一个 owner；退出后的旧 owner 锁保留。符号链接、Git 根/子目录、不同 workspace 标识归同物理项目。 |
| 锁故障 | 已验证：截断/不可读身份、owner 文件替换与 unsupported remote authority fail closed。已运行的操作/未知副作用不能正常释放生命周期锁。 |
| 物理项目范围变化 | 每次实际派发前同时复核原始选择路径的根分组、root dev/inode/realpath 和 `.git` marker 的 link/target 身份。目录改名/替换、选择别名被改指、Git marker 删除/替换或新增祖先 Git 根使旧 owner 失效并保留锁；只检查有限路径祖先，不扫描项目内容或来源。身份变化不改写已保存的 projectId 或请求字节。 |
| 阶段协调 | 已验证：FIFO、取消排队、token 重入、跨 task 拒绝、旧段失效不能再次获取、新修改使旧 validation revision 失效、未知副作用阻止排队及新修改。 |
| 真实文件冲突 | 已验证：两个实际 SafeFileEditor 修改相同旧基线；第二个等待资源后被旧 hash 拒绝，第一个文件结果保留。没有用模拟文件写入代替 Apply。 |
| 实际客户端准入 | 已验证：真实 OpenAICompatibleClient 的受控 fetch/SSE 完整解析；source concurrency=1 时第二请求等待第一个 body 结束，释放后才发送；两个序列化正文与提供字节完全相同，attemptCount 各为 1，permit 结清。此项不是供应商缓存或真实网络计费证据。 |
| Provider 批次接线 | 已验证：两个真实 ChangeSet/Apply 在同一阶段完成，另一任务排队到批次之后；token 相同，模型续跑前无活动租约。另一个实际 Host 批次先 Apply 再进入受控 reviewer/人工等待，等待期间另一任务可获取资源。 |
| 项目共享逻辑 child | 两个真实 SubagentRuntime 各委派 3 个 child，使用真实 AgentLoop/Provider 客户端及受控 fetch/SSE；来源容量设置 8，仍只有 3 个 depth 1 child 同时准入，其余在同一项目排队，共实际完成 6 个绑定结果。另测 3 个已准入父同时委派真实 nested child，父名额归还、nested 保留槽按 1 运行，其他 Worker 可运行；取消无泄漏，持修改租约的 child 等待被拒绝。没有用替身 TaskRuntime 代替接线。 |

本次已执行针对分组的命令：

```bash
bun run compile
bun run build:test
node --test --test-name-pattern='approved host batch|approval batch releases' out-test/test/taskApprovalIntegration.test.js
```

最后一条结果为 2/2 通过，0 跳过，约 3.61 秒；它调用真实 Provider 方法、真实 Session/ChangeSet 持久化和 SafeFileEditor，reviewer 使用明确受控输入，不是付费模型。

后续相邻回归运行中：协调领域最终 **14/14** 通过（约 1.05 秒；新增项目范围改名/替换、Git marker/祖先分组变化和选择别名改指），实际 DraftRun 执行器 **9/9**、SafeFileEditor **11/11**、验证可用性 **1/1** 通过。协调领域包含独立 Node 双进程测试、真实 Apply 冲突及受控完整 SSE。单独启动旧 `providerNetworkRecovery` 测试曾碰到已有的 OpenAICompatibleClient→runtimeIdentity→projection→Responses 导入顺序环，因此该次组合命令整体是 32 通过、1 失败，不能记为全绿；默认 runner 的正常模块初始化会先载入 projection，使用相同预加载方式单独重跑后为 **14 通过、0 失败、1 跳过**（约 4.36 秒）。跳过项是本沙箱禁止监听端口的 local fault server，未将其计作通过。

```bash
node --require ./out-test/test/registerVscodeStub.js --require ./out-test/src/agent/providerRequestProjection.js --test out-test/test/providerNetworkRecovery.test.js
```

本领域源码和 Provider 的定向 ESLint、`git diff --check` 均通过。完整本次默认 runner 结果以主验收报告为准。测试运行时长不是界面绘制或用户切换 p95。

共享 child 准入追加验证：`bun run compile`、`bun run build:test` 与相关源码 ESLint 通过；`node --test out-test/test/projectChildAdmission.test.js` 最终 **4/4** 通过（约 7.37 秒），0 跳过。该测试调用两个真实 Runtime、真实 child AgentLoop/Provider 请求投影、完整受控 SSE 及耐久结果链，6 个独立 child 和 3 个 nested child 均完成；另验证不同 Worker 调度器共用 proposal=2 子集名额、挂起取消无泄漏。它们是本地调度/传输证据，不是付费上游缓存或费用改善证据。协议维度仍为父 15、child 11；未迁移热 lane 或修改冻结 fixture。

## 限制与现场步骤

当前经过本地 backend 检查的范围是 macOS APFS/HFS 与列明的 Linux 本地文件系统（ext、tmpfs、xfs、btrfs、overlay、zfs）。Linux 跨发行版尚待现场。Windows 未提供已核实的 volume identity/locking adapter；remote authority、网络或未知文件系统保持只读并显示原因。不能把这一限制写成已完成 Windows/远端并行执行。

本环境绑定 `127.0.0.1` 监听端口被拒绝（`listen EPERM`），因此传输行为改用受控 fetch/SSE 捕获；没有把本机 socket 或真实 Provider 验证记为通过。真实供应商命中、费用和原生 VS Code UI/多窗口绘制仍需现场预算与环境。

现场在临时项目按以下顺序核验：

1. 同一物理 Git 项目通过两个窗口、符号链接与子目录 workspace 打开，确认只有一个执行 owner；另一窗口能查看任务/草稿，不能调用标题模型、Apply、命令、验证或自动续跑。
2. owner 启动一个有界长命令，在另一窗口等待；关闭 Webview 不结束执行。命令未结算时不得接管；关闭 VS Code 后任务显示 interrupted，旧锁不得因时间过去被自动抢占。
3. 两张卡同时修改同一基线，确认第二张等待并核对最新 hash；一批已批准本地编辑与验证之间没有别的 Worker 写入。需要 reviewer/人工等待时租约释放，继续前重验并显示基线失效。
4. 接受真实 supplement 后核对旧 segment 的等待审批、permit、资源 scope 失效；已经派发的操作先返回真实结果，新 supplement 使用同 root 的新 segment，不重跑已完成操作。
5. 故障注入到命令未知终态或文件 read-back 失败，确认新写操作被阻止，旧 owner 锁保留；先确认所有实际进程/文件结果，再按人工维护流程处理锁，不能通过 UI 伪造执行许可。

这些步骤尚未运行的部分应明确标待现场；本专题不声称真实供应商缓存永不逐出，也不以本地公共前缀候选代替上游 cache hit。
