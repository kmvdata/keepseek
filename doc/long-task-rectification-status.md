# 长任务整改续接记录

本轮起点：`87efb8e63b54fa69851bb103b17f52ba2cd8a8a0`，2026-10-31（Asia/Shanghai）。初始工作区干净。历史报告不计作本轮执行结果。

## 差距表

| 项目 | 当前实现/关键入口 | 已有证据 | 本轮复验 | 确认缺口/下一步 | 状态 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | providerRequestProjection / historyCompressor / requestBudget | 三协议离线回归、历史快照 | 共享payload/校准测量、首轮压缩、393192压力回放通过 | 真实付费Provider输出待现场验证 | 自动复验通过；现场环境阻塞 |
| P0-2 | evidence/store、shaping、runner admission | 分页/恢复回归 | UTF-8/同根/容量/损坏/跨scope/最终payload和恢复回归通过 | 保留已满足实现 | 已复验通过（离线） |
| P0-3 | sessionObjectStore / persistenceSnapshot | V3 迁移与故障测试，历史基准 | 浅冻结/锁异常/取消保留原权威；B/C四档多种增量通过 | Windows/远程/断电待实机；本轮未重做224MB现场冷迁移 | 本地复验通过；部分适用条件不足 |
| P1-1 | historyProtection / contextEpoch | mixed 154 历史回归 | pending/settled、双Epoch、摘要取消及邻近副作用回归通过 | 未进行真实Apply | 自动复验通过；手测阻塞 |
| P1-2 | runner progress / runCheckpoint / child runtime | ABA/child/恢复回归 | 新真实user恢复同task与预算、旧工具不重跑、旧轮不重复发表 | 不完整工具/continuation、历史非尾任务保守拒绝 | 已复验通过（受限恢复条件明确） |
| P1-3 | usageStats / provider flush / performanceTrace | 计数/trace 回归 | incomplete贯穿host view；磁盘失败不空转；flush/close、perf恢复与写放大实测 | 长期生产时间线/真实UI待采集 | 自动复验通过；现场环境阻塞 |
| S7 | longTaskPerformance / benchmark / accept-long-task-live | 120轮、双边界恢复、B/C基准、入口smoke | 最终768项：767通过、1跳过、0失败 | 真实Provider、隔离Webview、socket、Windows/远程边界见报告 | 可执行项通过；外部验收阻塞 |

## 执行记录

- 默认检查进程：工具 session `79383`；compile → lint → build:test → test 顺序执行；日志 `/tmp/keepseek-resume-20261031/{compile,lint,build-test,test}.log`。尚未取得最终退出码。
- 不修改原会话，不安装、不提交、不发布；输出配置、审批、幂等和预算边界保持。
- 下一步：先为用量不完整标志建立行为回归并修复，再检查压缩测量、存储缓存与恢复；稳定后全量验证。

以上执行记录为过程快照，最终状态见下方“本轮交付”。

## 里程碑：基线与首批缺陷

- 起点默认四命令退出 0；757 tests / 756 pass / 1 skip / 0 fail，86.43s。socket 跳过仍由本地端口权限导致。
- 首批定向回归 34/34 通过（10.03s）。后续新增恢复与 trace 故障回归 2/2 通过（3.05s），不是全量最终结果。
- 已改：压缩测量共用 payload builder、来源 fallback、显式校准并在 before-run 加载；摘要取消不采纳新摘要；用量重建保留 incomplete；ledger 写失败不自动 50ms 重试；浅冻结不进入深不可变缓存；no-progress 新真实 user 回到同逻辑任务并保留预算/检测窗口；阻塞尾 checkpoint 保留；perf flush 与 close 分开，临时写故障可有界恢复。
- 基准 B：独立 git archive HEAD 副本 `/tmp/keepseek-resume-20261031/baseline`，编译与 benchmark 已完成；结果 `long-task-perf-resume-start.json`。不重复旧机制 A 的历史测量。
- 当前检查：session 20860（新定向回归）；58357（compile + 隔离 development host 启动）。日志分别 targeted-stage.log、ui-launch.log。后续需确认退出码。
- 尚未闭环：综合容量边界回放、增量多种变更与 >55 规模、新版本基准、迁移可观测性/锁异常、真实 UI 和 Provider 条件及最终全量。

## 里程碑：容量回放与存储故障

- 全量四命令退出 0：767 tests / 766 pass / 1 skip / 0 fail，99.87s。此后补了恢复拒绝时保留原 checkpoint 的尾消息保护，需最终复验。
- 容量回放不是原 120 轮：154 mixed audit，1,024,000/393,192，已校准窗口 500,000，三协议各 7 执行请求 / 3 原始读取 / 2 摘要，跨两次必要 Epoch，中途停止后用新 Runner 恢复；原 audit 字节不变。
- 新发现首轮 epoch.turnInEpoch=0 会跳过可压缩历史，提前削减实际输出；已允许初始可压缩集合进行一次必要边界。回放实际 HTTP body 保持 393192。
- 迁移新增通知与阶段回调；提交前取消保留旧 shard；锁空/损坏/死 PID 不自动 unlink。原有 208 秒/2.40GB 是历史单次分析，不计本轮新测量。
- 本轮 UI：隔离 CLI 启动日志 ui-launch.log 报 task_name_for_pid (os/kern failure 5)，指定 ui-data 未创建；CUA 可读取原有 VS Code 窗口，但不是隔离宿主。没有操作原窗口，不计本轮 UI 手测。
- 基准 C session 84365，final-perf.log 已完成小中大，final-mutations.log 正在 80 checkpoint 阶段；基准 B 已完成全部 16 组 × 7 样本。基准与全量测试不重叠。
- 新增 accept-long-task-live.js：实际 resolver/catalog/Runner/serializer，要求显式 opt-in、来源/模型、隔离空目录和正费用/时长/请求数预算。默认拒绝运行已实测，未使用真实凭据或付费调用。正在补离线传输的入口 smoke，不冒充真实 Provider。

## 本轮交付

- 完整报告：`doc/long-task-rectification-resume-report.md`。起点HEAD未改变；未commit/push/package/install。
- 最终命令（session 12790）全部退出0：`bun run compile`、`bun run lint`、`bun run build:test`、入口离线smoke、`bun run test`。日志为 `/tmp/keepseek-resume-20261031/verified-{compile,lint,build-test,test}.log` 与 `accept-entry.log`。
- 最终768项：767通过、1跳过、0失败；测试101.99秒。入口smoke1项通过，1.41秒；compile/lint/build:test未单独采集精确耗时，不能以日志mtime当作精确运行时间。
- 基准B/C各完整退出0：标准小/中/55与多种增量3/20/55/80各7样本。已保存四份JSON；独立perf tail写放大量测另有JSON。没有与全量测试同时运行基准。
- 默认live入口未opt-in退出1（预期安全拒绝），node --check 三个新增/修改脚本退出0。真实Provider没有运行；明确来源、正费用预算和隔离目录条件未提供，未试探真实密钥。
- 无本轮长命令仍在运行。session 84365、12790已收取退出0。临时基线、日志和UI启动路径见本文件，不靠聊天文字恢复。
- 下一步仅为外部复验：按报告命令提供已有来源标识/正预算运行真实入口；在能成功创建独立VS Code user-data目录的环境按首次ready/用量/会话/设置/@/拖拽/焦点/Apply/Discard矩阵手测；Windows/远程/断电另需现场。不要用原有VS Code窗口冒充新构建验收。
- 升级前必须停止同一目录所有写入者并完整备份；旧版不能读取V3，legacy备份不含升级后的工作；未知/死PID锁均不自动删除。未修改原会话或替换安装扩展。
