# 长任务整改续接验收（2026-10-31，Asia/Shanghai）

起点 `87efb8e63b54fa69851bb103b17f52ba2cd8a8a0`，初始工作区干净。本轮未提交、安装、覆盖运行中的扩展或发布。此前报告中的现场快照、224MB 冷迁移和旧机制基准均为历史测量；不是本轮重新执行的结果。

## 差距与处理

| 项目 | 保留实现及本轮确认 | 新修复 | 本轮证据与范围 |
| --- | --- | --- | --- |
| P0-1 最终投影 | 三协议 projection、来源 reasoning 规则、393192 配置输出、lane replay、校准隔离 | 压缩测量和阈值使用共同 payload builder、来源 fallback 与校准；前台/后台规划加载校准。初始已有可压缩历史过满时允许必要 Epoch，避免首轮直接削减实际输出 | historyCompressor、agentRequestCoordinator、toolResultBudget；三协议压力回放实际序列化 body |
| P0-2 正文证据 | 根引用、UTF-8 cursor、范围/hash、零容量阻塞、intent/evidence/envelope durable 与恢复管线保持 | 未重写已通过的 shaping/store | 原有分页、损坏、跨 scope、崩溃恢复和 120 轮最终 payload 回归本轮通过；新增压力场景实际使用 evidence 页 |
| P0-3 存储 | V3、对象先于 manifest、备份、revision、惰性归档、fsync 保持 | 浅冻结不能进入深不可变引用/大小缓存；阻塞尾 checkpoint 不因 canResume=false 立即卸载；锁损坏/空/死 PID 均保留并要求人工检查；迁移通知、阶段进度、提交前取消 | longTaskPerformance；迁移取消后原 shard 逐字节不变，再次迁移成功；3/20/55/80 增量基准 |
| P1-1 保护/Epoch | 154 mixed pending/settled、宿主 facts、baseHistoryEvidenceRef、近期完整历史、原生 lane 保持 | 摘要在 completion 返回时已取消，则不采纳新 summary，仍返回已产生的用量 | historyProjection、historyCompressor、changeSet/approval/DraftRun 既有回归和新增压力回放；未真实 Apply |
| P1-2 进展/恢复 | ABA、有界事实窗口、同范围不算进展、child 完成事件及取消保持 | 普通 Continue 仍拒绝 no_progress_loop；新真实 user 可恢复同 task，保留预算、幂等、已完成事实和检测窗口；仅新轮写入新 assistant。恢复拒绝时尾消息仍带原停止任务 | 三协议停止→新 user→新 Runner；不重跑工具、不重置计数/时间/费用；来源、工作区、执行模式、权限不匹配拒绝 |
| P1-3 用量/诊断 | 主/子聚合、274/256 回归、unknown/下界、计时/缓存名称保持 | 重建保留 inline/ref/损坏 incomplete；flush 失败不形成 50ms 后台重试循环；perf flush 与 close 分开；临时写故障后由后续事件有界重试，索引记录 writeFailures；共享 session 事件明确标记 session_shared | usage host flush、view conversion、interactionTrace、slow disk/drop/rotation 回归；并非任何故障下都保证有日志 |
| S7 综合验收 | 120 工具轮正常增长回放保留 | 新增实际容量边界与中断恢复；多种增量基准；真实入口脚本 smoke | 离线回放与真实文件系统基准通过。真实 Provider/Webview/Windows/远程 FS 未获本轮实机证明 |

没有增加产品固定输出 cap、续写次数或新的产品预算。没有修改旧 user 字节、冻结 schema、审批模式权限、一次性 permit 或未知副作用重试边界。新增内部 API/运行时缓存不要求改变会话版本；现有 optional 字段和旧 checkpoint normalize 回归保留。

## 综合容量回放（本轮，确定性离线）

配置窗口 1,024,000、配置输出 393,192；注入合法的 Provider 拒绝校准窗口 500,000。154 条 mixed audit 包含 settled 与 pending，保留原始字节。每协议 7 个执行请求、3 次原始读取、2 次摘要，读取和分页交替；跨两个必要 Epoch，在第一个边界后中断并以新 Runner 恢复。所有执行 HTTP body 的输出参数保持 393192。不是强制每轮摘要，也不是付费供应商测试。

| 协议 | 第一次 input before → after | 第二次 input before → after | task/已用时间 |
| --- | ---: | ---: | --- |
| Chat Completions | 191793 → 31655 | 97337 → 33060 | 同 task，时间不回退 |
| Responses | 192077 → 31497 | 97377 → 32991 | 同 task，时间不回退 |
| Anthropic | 193120 → 31527 | 97376 → 33022 | 同 task，时间不回退 |

这些是本地估算 input，并非供应商 token usage。语义摘要/工具 HTTP 使用固定 SSE；没有真实摘要费用、首 Token 或生产 Provider/本地阶段占比。原 28%/72% 不作新结果复用。失败摘要、低/负收益、未知副作用、三审批模式、child 延迟/取消、损坏/空间不足等由相邻故障回归组成覆盖矩阵，不声称每个组合都经历实机故障。

## 同机性能 B → C

A=`3c8ebb3` 的旧机制结果保留在原报告，本轮未重复巨型旧基准。B=本轮起点 `87efb8e` 的独立 git archive 副本；C=本轮修改后。两者使用相同脚本、fixture、Node v24.15.0/macOS x64，顺序执行且不与全量测试并行。每档 7 次，nearest-rank P95 等于最大值，不代表高置信度统计。

标准脚本覆盖完整 ChatSessionStore 保存（含索引/manifest flush）：

| checkpoint | 每次写字节 B → C | 保存 P50/P95 ms，B → C | 加载 ms，B → C | event-loop 最大 ms，B → C |
| --- | ---: | --- | --- | --- |
| 3 | 3350 → 3350 | 108.80/110.39 → 107.39/108.83 | 15.41 → 15.42 | 11.43 → 12.30 |
| 20 | 13230 → 13230 | 114.57/116.78 → 111.65/113.73 | 56.79 → 60.47 | 13.93 → 12.64 |
| 55（旧等价约224MB） | 33589 → 33589 | 144.11/150.02 → 129.05/131.51 | 175.90 → 205.70 | 29.74 → 26.62 |

三档每次均 4 次 writeFile，磁盘总量/对象图分别保持 54,390/51,747、891,166/878,644、4,819,300/4,786,420 字节。是合成新会话，不含旧迁移备份。计数不含 lock/OS 元数据和 fsync 的内部物理 I/O。

| checkpoint | C encode/commit P50 ms | C 采样最大 RSS/heapUsed MB | C GC 后 retained heap P50 MB |
| --- | --- | --- | --- |
| 3 | 61.50/40.02 | 59.20/8.43 | 7.71 |
| 20 | 66.22/40.15 | 143.96/27.91 | 10.55 |
| 55 | 80.59/41.26 | 996.28/31.76 | 21.14 |

内存是每次保存结束采样，不是进程绝对高水位；跨档 V8/RSS 可保留早先分配。大档加载变慢，小档仍有约 100ms 固定可靠落盘成本，不能宣称普遍提速。C 本轮重点是边界正确性，B/C 相近和小幅涨跌均如实保留，不把噪声归为修复收益。

新增 mutation 脚本隔离 shard graph，不含 workspace index，与上表不可直接混算。每档每种变更 7 次，先心跳、再追加 user、再追加约39KB 工具正文、再宿主 pending/rejected 状态变化；80 档每消息 12000 chars，与55档23800不同，用于观察 checkpoint 数增加，不能视为相同正文大小。

| checkpoint | 变更 | P50/P95 ms，B → C | C 写字节范围 | C writeFile 次数 |
| --- | --- | --- | ---: | ---: |
| 3 | 心跳 | 101.7/102.8 → 106.5/122.5 | 2561 | 2 |
| 3 | 追加消息 | 142.5/144.6 → 146.5/160.6 | 2754–3211 | 3 |
| 3 | 工具正文 | 461.5/480.2 → 463.3/468.9 | 46739–47189 | 11 |
| 3 | 宿主状态 | 262.4/315.3 → 262.3/308.1 | 3094–4364 | 2–7 |
| 20 | 心跳 | 155.4/214.7 → 114.2/116.3 | 12439 | 2 |
| 20 | 追加消息 | 255.1/282.1 → 154.6/158.5 | 12632–13089 | 3 |
| 20 | 工具正文 | 488.8/883.7 → 478.0/604.3 | 56617–57067 | 11 |
| 20 | 宿主状态 | 270.2/358.1 → 274.9/365.2 | 12972–14242 | 2–7 |
| 55 | 心跳 | 135.4/136.5 → 138.2/154.1 | 32797 | 2 |
| 55 | 追加消息 | 175.7/190.4 → 178.7/194.3 | 32990–33447 | 3 |
| 55 | 工具正文 | 498.4/500.2 → 504.2/515.6 | 76975–77425 | 11 |
| 55 | 宿主状态 | 291.2/341.3 → 312.3/348.4 | 33330–34600 | 2–7 |
| 80 | 心跳 | 138.0/139.2 → 139.3/143.7 | 47347 | 2 |
| 80 | 追加消息 | 176.2/181.4 → 183.5/186.2 | 47540–47997 | 3 |
| 80 | 工具正文 | 498.2/522.7 → 510.8/522.7 | 91525–91975 | 11 |
| 80 | 宿主状态 | 306.5/344.2 → 305.2/358.4 | 47880–49150 | 2–7 |

写入量随 manifest/新正文增长，不重写约224MB归档。工具正文比心跳需要更多对象/屏障，不能用心跳数字概括全部保存。并发/快速保存、过期 revision、manifest 中断和 ENOSPC 为行为回归，非此性能脚本的并发吞吐量。历史冷迁移约208秒和分析进程RSS约2.40GB本轮未复测；新增进度/安全取消改善可观察性，不宣称消除此必要开销。

数据：[B 标准](long-task-perf-resume-start.json)、[C 标准](long-task-perf-resume-final.json)、[B 多种增量](long-task-mutations-resume-start.json)、[C 多种增量](long-task-mutations-resume-final.json)。

perf tail 单独量测：强制50次flush、每批20事件，共1000事件。B/C耗时169/161ms，writeFile字节4,395,823/4,409,052，均100次writeFile，保留文件约173KB。通用workspace-fs方案会重写当前分段，确有约25倍逻辑写放大；本轮没有将其改成失去恢复语义的异步无界append，也不宣称零开销。此测量不含慢盘的长期排队或真实Provider时间；慢盘有界队列和丢弃/故障恢复由故障回归验证。共享session存储事件标记`session_shared`，不能在多个run的日志中重复相加当成各自独占耗时。[原始指标](long-task-perf-tail-resume.json)。

## 验证与受限范围

- 本轮起点 compile/lint/build:test/test 全部退出0：757项，756通过、1跳过，86.43秒。
- 首轮修改后全量四命令退出0：767项，766通过、1跳过，99.87秒。
- 最终 compile/lint/build:test/test 全部退出0：768项，767通过、1跳过、0失败，101.99秒；`git diff --check`退出0。新增真实验收入口已用离线传输单独 smoke 通过（1项，约1.41秒），实际经过来源解析、模型目录、Runner、工作区正文读取、HTTP serializer 和计价/用量链，保持393192。该 smoke 的网络是 fixture，不能算真实 Provider。
- socket 跳过原因仍为沙箱不允许绑定本地监听端口。没有改为假通过。
- 真实 Provider：本轮没有选定的隔离来源/明确正费用预算，未读取或输出真实密钥、未发付费请求。不能用旧 eval 脚本的4096默认/100000 clamp证明生产预算。
- 真实 Webview：指定隔离 data/extensions/workspace 启动 CLI 后报 `task_name_for_pid: (os/kern) failure (5)`，指定 ui-data 未生成。CUA 可读原有 VS Code 窗口，但没有操作它，不能充当本轮隔离开发宿主。首次ready/设置/@/拖拽/焦点/Apply/Discard仅自动回归，真实鼠标键盘验收未完成。
- Windows/远程FS、真实断电/磁盘耗尽、跨版本并发热迁移未实机验收；本地故障注入不替代这些现场条件。
- 没有取得此前Codex客户端停留12小时期间的进程/日志证据，不能将其归因于KeepSeek内部性能问题。本轮用可轮询进程、独立日志和仓库续接记录降低中断损失，没有调查或终止原有客户端/任务。

## 安全升级与复验入口

停止同一数据目录的所有写入者，完整备份 globalStorage（包括 evidence/ledger/审批/对象和旧备份）。首次迁移会显示阶段进度；取消只在 manifest 提交前生效，提交开始后等待完成。取消/失败保留原权威，孤儿对象不自动清除。锁无法确认或死PID锁需先停写、备份、核实锁所有者后人工处理；不自动回收，避免并发删除新锁。

新锁不能约束旧进程，检查旧 shard 未变与原子替换之间仍须靠停写前提，不能宣称热迁移安全。V3旧版不能直接读；回退要用升级前完整备份。legacy-v2.json只含迁移当时，不含升级后工作，不默认删除。对象级GC仍未启用，retention/显式会话删除承担整个会话及对象目录清理。

普通 Continue 不解除无进展停止；在同一会话补充真实输入会尝试同 task 恢复。需要原来源/端点/模型、执行方式、工作区和精确外部权限，时间/费用/逻辑预算仍有效；存在不完整工具或 continuation 时保守拒绝。旧历史任务不跨越后来消息进行盲目原样恢复。

复现离线与性能：

```bash
bun run compile
bun run lint
bun run build:test
bun run test
node --expose-gc scripts/benchmark-long-task.js LABEL
node --expose-gc scripts/benchmark-long-task-mutations.js LABEL
node scripts/migrate-session-copy.js CONSISTENT_OLD_SHARD NEW_EMPTY_DIRECTORY
```

真实模型入口（自行提供已选来源标识和预算，不在命令行/报告中放密钥）：

```bash
KEEPSEEK_LIVE_ACCEPT=1 \
KEEPSEEK_ACCEPT_SOURCE_STORAGE=/path/to/read-only-existing-globalStorage \
KEEPSEEK_ACCEPT_SOURCE_ID=SELECTED_SOURCE_ID \
KEEPSEEK_ACCEPT_MODEL=SELECTED_MODEL_ID \
KEEPSEEK_ACCEPT_MAX_COST=EXPLICIT_POSITIVE_COST \
KEEPSEEK_ACCEPT_MAX_MS=EXPLICIT_POSITIVE_MILLISECONDS \
KEEPSEEK_ACCEPT_MAX_REQUESTS=EXPLICIT_POSITIVE_REQUEST_COUNT \
KEEPSEEK_ACCEPT_OUTPUT=/path/to/new-empty-isolated-output \
node scripts/accept-long-task-live.js
```

入口使用实际 accountResolver/catalog/Runner/serializer，但VS Code采用隔离文件系统facade；不是实际Webview。正费用预算在不可计价来源仍 fail-closed。只暴露 fixture 读取/证据工具，不执行 Apply/命令；结果、checkpoint、evidence、ledger、trace留在隔离目录。只有verifiedBody和实际计量/日志通过才算验收，HTTP200不够。

本轮源码须下次加载新构建或正常安装新版本后生效；用户原有任务没有被重启、替换或加速。
