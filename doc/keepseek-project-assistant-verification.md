# 项目助手交付与验收证据

日期：2026-11-07，Asia/Shanghai。起始 HEAD：`87ee2bbc29546e575556f2e49aae67136f781e00`，起始工作树干净，版本 0.5.2。本次改动留在工作树；没有提交、打标签、推送、发布或安装扩展，也未修改版本号及 CHANGELOG。

功能权威：[项目助手与并行任务](keepseek-project-assistant.md)。执行锁、真实文件/进程和资源证据：[协调验收](keepseek-project-coordination-verification.md)。

## 交付内容

| 范围 | 已接线行为 |
| --- | --- |
| 项目入口与 Router | 明确新任务及任务内输入直接进入持久邮箱；自由项目消息进入独立 Router session。固定任务工具通过唯一 projection、实际 Runner/Evidence 和三协议客户端执行；dispatch 在耐久入队后返回 handle。普通进度和完成不唤醒 Router。 |
| 独立任务 | 默认两个 Worker，各有固定 session、独立 Provider/Runner、来源/模型和附件快照、Skill 激活、审批、取消、时钟与预算。旧普通入口共用项目 owner、根准入、来源请求池和修改资源；child 逻辑配额也由项目共享，等待嵌套任务或结果时释放并在恢复前重取。 |
| 执行身份 | project/card/session/root、运行时 generation、真实 checkpoint segment 与 epoch 分离。补充及内部审批/命令/repair 的新 assistant 均绑定独立真实 segment；Continue 保留原 checkpoint。 |
| 持久输入与恢复 | V2 task manifest 引用耐久内容对象，兼容 V1。幂等键、原正文、展开/归档意图、消息提交、消费和结果事件可恢复；ACK 后不会丢正文。重启不自动运行旧任务、许可或命令。缺失/损坏 checkpoint 明确失败。 |
| 补充与副作用 | 先耐久接收，当前请求/工具配对完整结清，再以真实 user 同 root 新 segment 继续；旧未执行审批、permit 和资源 scope 失效。已完成工具保留 Evidence，未知副作用不重试。 |
| 查看与本地存储 | 纯查看不修改执行选择/模式；首屏30、旧页50、当前窗口有界。热页、深历史消息锚点、Latest、每目标草稿/引用/光标/滚动与查看位置独立恢复。运行及恢复会话 pin，正文按 dirty/revision 保存，来源字节共享且激活独立。 |
| 资源与多窗口 | 物理项目排他 owner 覆盖路径别名和不同 workspaceKey；只读窗口不回写执行数据。Apply/Run/固定验证进入项目阶段，批准后再获取资源并复核，等待 reviewer/人工/模型前释放。未知结果保留锁和证据。 |
| 费用与标题 | 实际 attempt/usage 逐角色、session、来源、币种记账，Router 单列。缺失 cache/费用未知；partial 不推断另一字段。有效 Router 标题候选复用，用户手动标题/刷新保持优先；查看不发命名请求。 |

## 本次验证状态

最终冻结版本已通过默认验证。[机器可读汇总](benchmarks/keepseek-project-validation-20261107.json) 包含实际 runner 计数、命令退出码及实现文件摘要；专项次数不与全量计数相加。

| 命令 | 状态 |
| --- | --- |
| `bun run compile` | 最终冻结版本通过，exit 0 |
| `bun run lint` | 最终冻结版本通过，exit 0 |
| `bun run build:test` | 最终冻结版本通过，exit 0 |
| `bun run test` | exit 0；1458项中1457通过、0失败、1环境跳过；18 suites，649.161秒 |
| `git diff --check` | 通过，exit 0 |

唯一跳过项为 local fault server，本沙箱禁止绑定监听端口。真实文件/进程、双进程 owner、受控三协议 transport、Host/Runner 集成均已执行；原生 UI/付费 Provider/其他平台的边界另列。最终默认运行的10K账本性能为12.366秒，保留原15秒阈值。

专项证据覆盖实际 Host/Provider/Runner、临时存储、真实 SafeFileEditor、固定验证和临时进程，Provider 使用明确受控 transport，没有真实付费请求。包括：A/B 并发与第三任务排队；A 等待审批时 B 完成、在 B 查看期间精确处理 A；陈旧基线与重复 Apply；旧发送/编辑/停止/Continue 统一入口；三协议补充配对、旧 system/tools/user 字节；用户正文已提交而 assistant 尚未创建的崩溃恢复；自动三段续跑及重复 native call ID；Router 创建及时返回、失败隔离、人工停止确认的计时；只读、双进程争锁；深历史锚点、草稿 ACK、迟到状态和近期导航安全屏障。

验证中发现并修复了两处旧测试观测入口：导航耐久故障注入由 `saveWorkspace` 改到实际 `saveSessionChanges`；Webview 单调性由全局 revision 改为各 Worker/session lane。原耐久、竞态和安全断言保留。Journal I/O 计数限定到其临时项目，保留变更前至多5次写入、零历史重写、零 GC 扫描的阈值。曾在并发测试负载下出现 10K 用量账本约22秒超过15秒的性能失败；未放宽阈值，隔离复核13/13通过，约14.245秒。最终默认结果另列。

全量验证还捕获了新增冷读合并导致的真实标题竞态：后台标题读取暂停时，用户重命名和执行选择会等待同一个 flight。已将后台标题读取隔离，保留普通同目标冷读合并；迟到读取复用较新驻留对象，不能覆盖手动标题。原有竞态测试和新增并发读取回归共95/95通过，未通过提前释放测试 gate 绕过问题。

最终旧消息入口检查补齐了只读任务窗口的明确回执：发送/编辑拒绝 ACK、标题 requestId 终态、Apply 失败反馈。真实第二 owner 的 Host 回归通过，0 Worker/0 Provider 请求，Registry 和会话原字节不变；普通历史只读 Parent 2/2通过。该回归首次触发原生 `EMFILE`，发现监听器异步 error 会绕过初始化 try/catch，现已报告并降级到 ready/显式本地查看刷新。受控向真实 watcher 注入 error 的复核已通过，不将其混作第二次自然发生的系统错误。

一次较早完整默认回归为1456通过、1失败、1环境跳过，约648.71秒。唯一失败是 Router UI 仍断言旧金额文案 `Project Router: USD`，实际已按参考价合同显示 `Project Router: Reference cost USD`；已更新该断言，并保留未知费用、不完整用量与请求数检查。UI定向16/16通过，随后重新执行完整默认回归，取得上表最终结果；未将较早失败运行记作通过。

## 请求、缓存与费用证据

[实际受控请求/账本 JSON](benchmarks/keepseek-project-request-evidence-20261107.json) 记录协议、角色、session、物理 attempt、请求字节数及 hash、静态前缀/旧 user hash、原始用量状态与账本匹配。它不包含密钥或完整 prompt。

同一独立 A/B 成果分别执行顺序与并行 fixture，直接输入 Router 分类调用为0；另列自由 Router 工具往返、热任务跟进、显式模型/endpoint 边界、三协议补充和崩溃恢复。受控 gate 和本机 I/O 会影响时长，这些时长不构成供应商延迟或并行加速结论。观察到的唯一允许前缀边界是明确切换模型/endpoint；没有重新录制 Worker 冻结协议 fixture。

| 受控场景 | Worker 物理请求 | Router 物理请求 | 标题物理请求 |
| --- | ---: | ---: | ---: |
| 相同两任务顺序执行 | 2 | 0 | 1 |
| 相同两任务并行执行 | 2 | 0 | 1 |
| 热跟进与明确模型边界 | 3 | 0 | 1 |
| 项目自由输入及 Router 故障隔离 | 1 | 3 | 0 |
| 三协议补充（各2次） | 6 | 0 | 0 |
| user 已提交的崩溃继续 | 1 | 0 | 0 |
| 三段自动审批续跑 | 3 | 0 | 1 |
| 跨视图审批与旧基线拒绝 | 3 | 0 | 2 |
| 合计（10个场景） | 21 | 3 | 6 |

30次物理请求均能对应耐久账本；有 usage 的28次和未报告 usage 的2次分别保留。Router 的两个语义输入实际产生3次调用，其中首轮工具往返2次，另一个失败请求1次；没有把语义回合报告成单次 API。新增 Worker 冷请求和标题开销在表中独立可见。普通完成未唤醒 Router，直接输入的分类请求为0。

所有 fixture 缓存计量不可用时保留 unavailable；Anthropic 部分 native 字段保留 partial，明确 0 才是已报告零。缓存写入独立计数而不重复加入输入总量。没有运行授权付费 Provider，因此真实命中率、条件95%健康目标和真实费用改善均为待现场，不能将公共前缀估计或 fixture token 数当上游命中/账单。

## 性能证据与边界

[同机存储基线 JSON](benchmarks/keepseek-project-view-storage-20261107.json) 与 [复现脚本](../scripts/benchmark-project-views.cjs) 比较起始 HEAD 的 ChatSessionStore 执行选择链和当前纯视图路径，两者共用当前 GlobalSessionStorage/对象后端。这是控制变量的本地路径对照，未运行整套旧版扩展原生 A/B。fixture 为两个各100条消息的临时 session，每组30次；包含平台、Node、编译 hash、p50/p95/p99、冷/热定义、末尾内存样本及同进程峰值。冷读取的 OS 文件缓存保持温热，峰值包含基线和当前路径，不能称为两 Worker 的隔离峰值。

最终无其他测试负载的采样：macOS Darwin/x64、Node24.15.0、Intel i9-9880H。单位为毫秒，每行n=30，视图触发模型请求为0。

| 本地路径 | p50 | p95 | p99 |
| --- | ---: | ---: | ---: |
| 基线热执行选择 | 92.733 | 144.018 | 144.203 |
| 当前热纯查看 | 0.182 | 0.232 | 0.915 |
| 基线冷执行选择 | 119.306 | 158.055 | 161.883 |
| 当前冷有限页 | 7.851 | 14.962 | 18.048 |

同一基线/当前混合 benchmark 进程峰值RSS为219,693,056字节，末尾RSS为219,029,504字节。它没有运行并发Worker，不作为双Worker内存峰值或生产内存上限。

该证据测量 Host 读取/准备，不等于真实点击、可见绘制或草稿可编辑时延。`projectTaskPainted` 是 renderer 双 rAF 后确认，并核对 project/card/generation/revision；Node DOM 测试不能代替原生可见绘制。原生热反馈 p95≤100ms、首屏/草稿≤200ms、冷首屏≤1s及实际双 Worker 内存峰值尚待现场，不以调宽阈值或略过安全恢复认定达标。

## 未运行、限制与现场步骤

- 原生隔离 UI 验收未完成。电脑控制工具拒绝访问 Terminal，未用该路径启动独立 profile 的开发宿主；现有 Code 窗口含真实运行与会话，未操作其数据。没有安装或替换扩展。现场使用独立 user-data/extensions/storage、临时 workspace，按功能专题的10步执行并采集真实绘制与输入法/拖拽/键盘证据。
- 未运行付费 Provider；现场需明确凭据、来源及预算，再比较同成果单任务、热继续、A/B/Router 交错和顺序/并行，逐角色记录 attempt、cache read/write/miss/output、币种和真实账单。
- macOS APFS 已进行原生双进程/真实文件/进程验证。Linux列明本地后端仍需现场；Windows、remote authority、网络及未知文件系统当前只读，尚未提供已核实的所有权 adapter。
- 沙箱禁止本地监听端口，一项 local fault-server 验证跳过；受控 fetch/SSE 覆盖实际三协议客户端，不能把它报告成已完成原生 socket 验证。
- 生命周期 owner 在未知进程/文件结果时保留锁，必须先核对真实副作用；没有按心跳自动接管或后台常驻 daemon。
- 删除任务移除权威索引及会话，未在本次引入不可变孤立对象 GC。任务 registry 初始化仍加载邮箱/结果对象；极大任务集的冷启动和内存上限需进一步现场量测。完整 session 执行历史和有限视图始终分开。

本次不包括自动 worktree、后台 daemon、云执行、外部触发或定时 LLM 轮询。上述边界不代替本次实际接线和回归证据。
