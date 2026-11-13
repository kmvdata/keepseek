# P0：子代理统计与持久化整改

2026-11-01（Asia/Shanghai）。基线 `9a874e8` / 0.3.9，工作区原先干净；未安装、发布或修改真实账号。

## 证据与口径

只读审计本机 21 个旧 child（20 completed、1 failed）及六个父会话账本：终态摘要和账本均为 123 次有用量响应，账本 123 次尝试，未发现损坏 bucket。未输出任务、聊天、工具或推理正文。这不证明所有历史中断都正确，也不支持“子代理少导致全部长任务变慢”。

确认缺陷：任务数误标为请求数；只有 attempt 时详情消失；终态汇总依赖父回调；去重丢弃 attempt 后来的 usage；flush 扫 256 个 bucket 并额外保存整个会话；child 共用完整记录写入队列；父侧重复复制/编码正文和串行等待小对象。

| 指标 | 权威及语义 |
| --- | --- |
| 已记录委派调用 | 根消息 toolRounds / Run Details，按 message + toolCall ID 去重；并行批次算一次，含准入拒绝；旧明细缺失时只是已记录数 |
| 已接受任务、queued/running/终态 | 隔离 child store 的稳定 ID；批次内每个获准 child 各算一个，排队先落盘 |
| totalCount、completed/failed/stopped | 保留原终态汇总语义；不再与已接受数相加；历史 ID 不足则已接受总数未知 |
| Provider 尝试 | 独立账本 requestId + attemptIndex；进入传输调用，含重试，不承诺服务端已收到；准入前拒绝不计 |
| 有用量响应 | 同账本完整 usage_response；无 usage 保持未知，不合成 token/费用或假零值 |
| 结果复用 | child reusedFrom 信息；新增任务可复用旧结果，不新增模型请求或费用 |
| 回传、分页 | 原有根 handoff ID 去重；按父请求实际接受的工具结果计数，不是 child 再执行 |
| 实际/参考费用 | 不可变价格快照 / 独立显示投影；参考费用不进入真实账本或预算；保留币种及不可计价状态 |
| 上下文隔离 | 原有本地 estimator，不是省钱率或执行效率 |

相同模型不同账号不合并；summary/background/reviewer 不改标为 subagent；nested 继续逐层只上报一次。新可选 subagentId 提供稳定归属；旧记录只使用已有 conversation/profile 证据，无法归因保持未知。

去重允许 attempt → usage 及未报告尝试补 observedUsage，完整 usage 不被迟到弱记录覆盖。重复完整报告保留首个权威，不生成第二笔账单。热索引只在原子 bucket 提交成功后更新；重建与追加共用 session 顺序队列。

## 兼容与恢复

- 父会话读 V2/V3/V4，workspace index 仍为 V2。V4 支持小节点内联和带 hash 的内联 header，大对象仍内容寻址，历史 checkpoint 仍惰性加载。
- V2 迁移核验图并保留 legacy-v2.json 原字节；V3 升级保留 legacy-v3.json 原 manifest 和全部旧对象。revision、writer lock、scope、durable 对象先于 manifest 的屏障保留。
- child 新写 `<id>.state.json` 与对象图；私有静态输入、变化中的 checkpoint 分开引用。无正文的 activity/stats 索引与图原子提交，排队记录单独 durable 保存。
- 兼容旧 combined `.run.json` 及 split `.meta.json` / `.transcript.json`。旧文件不删除；损坏新权威不静默回退旧结果。新索引及 split 元数据无需展开 transcript；旧 combined 恢复仍需每会话一次读取。
- 统计恢复验证 workspace、parent session、child/ref、摘要 hash 及 stats 的 root/parent/model/profile 一致性；queued/running 仅标 interrupted/stopped，不恢复执行队列。
- child 终态已提交、父回调未发生时从索引补汇总，以 counted IDs 幂等合并。无法核实的摘要标不完整，不补计费用、不重执行。
- 回滚旧二进制须停止所有 writer、备份并显式选择保留的旧 manifest/child 记录。旧版不能读 V4；还原旧 manifest 会放弃升级后的进展。不自动降级，不重设计 GC。

## 热路径和可观测性

父正文通过字段比较复用不可变快照；可变嵌套元数据仍检查/复制。未变正文不重新编码，消息索引和必要元数据扫描仍随条目数增长。pending journal、预算和计划没有按可变对象身份缓存。

小对象打包，最多四个消息 worker；对象 I/O gate 仍为四。父历史继续共享正文对象；child 私有静态输入打包一次，后续只提交变化的 journal/元数据。hash 校验、原子提交和旧权威保留不退化。

每个 child 独立顺序提交，最多一个 in-flight、一个最新 pending snapshot。旧屏障仅在自身或更新的完整快照提交后完成；兄弟 child 不互等。失败不定时重试。合并不代替关键落盘等待。

原始账本显式 durable；首次访问/显式 rebuild 扫盘，热追加只读涉及 bucket，实际和参考费用统计增量更新。缓存诊断、分页和显式校验仍可能全量扫描，不声称全部统计都是常数成本。派生 flush 不再额外保存整个会话。尝试先落盘、usage 升级再落盘是保留的可靠性开销。独立后台压缩也等待账本提交，失败时保留可迁移内联记录；旧未归因聚合继续累计新 usage，账本权威会话不会由重复 usage 事件再次加总。

有界、脱敏 PerformanceTrace 增加 snapshot/queue/processing、节点访问、序列化/哈希和对象 I/O 指标。encodeMs 含异步 I/O；hashMs 只覆盖 put 序列化和哈希，不是全部编码 CPU；objectIoMs 为本 store I/O 区间并集。child 有 child/task 归属，父共享保存仍标 session_shared。父屏障超过 250ms 显示“正在保存任务状态”，无虚假百分比。

## 复现与验收

```sh
bun run compile
bun run lint
bun run build:test
bun run test
node scripts/benchmark-p0-persistence.cjs > /tmp/keepseek-after.json
KEEPSEEK_BENCH_MODULES=/tmp/keepseek-p0-baseline-9a874e8 \
  node scripts/benchmark-p0-persistence.cjs > /tmp/keepseek-before.json
```

基线是修改前通过 build:test 生成的临时编译副本，不切换当前工作区。若临时副本已清理，可在仓库根目录用以下命令重建（仅导出 Git 已有内容）：

```sh
benchmark_base=$(mktemp -d /tmp/keepseek-p0-base.XXXXXX)
git archive 9a874e8 | tar -x -C "$benchmark_base"
ln -s "$PWD/node_modules" "$benchmark_base/node_modules"
./node_modules/.bin/tsc -p "$benchmark_base/tsconfig.test.json"
KEEPSEEK_BENCH_MODULES="$benchmark_base/out-test" \
  node scripts/benchmark-p0-persistence.cjs > /tmp/keepseek-before.json
```

脚本对两版强制相同 durable atomic replacement（旧 child/ledger 没有 fsync），保证比较不靠降低可靠性。

每场景三轮、每轮全新临时目录，首屏障为逻辑冷启动，后五次为热运行；OS cache 未清空。真实本地文件系统 + VS Code API stub，无 Provider 流量，Provider 区间为 0。短会话四条消息；长历史 165 条正文、55 个固定历史 checkpoint、一个活动 checkpoint；child 有 165 条私有输入。单 child 六个屏障，并发三个 child 十八个屏障；账本六次追加。保存后另行读取核对，校验 I/O 不计样本。

结果及原始数据见 `benchmarks/keepseek-p0-persistence-20261101.json` 和下方实测表。queueMs/processingMs 是操作工作量，不能跨兄弟相加当壁钟；localPersistenceUnionMs 才是存储区间并集。基线缺埋点为 null，不填 0。字节含 manifest；写次数为 fs API 调用数，不是系统调用/fsync 次数。

最后补充的统计、迁移与审批定向回归：42/42 通过；compile、lint、build:test 均成功。

回归覆盖 attempt 升级/重复、活动可见、账号分组、父回调前恢复、旧布局、摘要和 manifest 故障、可变 journal/预算、正文复用、child 队列、存储失败不触发 POST。全量回归覆盖三协议字节/replay、evidence 不重跑、未知副作用不重试、审批/permit、proposal 边界及 Webview DOM/脚本/快捷键。

真实用户数据只读；未执行真实迁移、Apply、Provider 请求或 VS Code F5 验收。尚需在后续实际长任务观察请求间隙、取消/关闭/重启、用量窗口视觉和键盘状态；模拟验证不等于现场闭环。

P1/P2：二级指令/profile 继承、超限结果/完成语义、完整私有结果读取成本、旧 combined 文件流式元数据和极大账本 bucket/缓存诊断成本。本次未提高委派频率、并发/深度、超时、输出预算或修改压缩/Epoch。

## 实测结果

环境：Node v24.15.0，darwin / x64。三轮中位数，单位 ms；尾部为三轮最大值，样本不足以声明生产 p95。Provider 区间全部为 0；保存次数分别为 6、6、6、18、6。

| 场景 | 总耗时 前 → 后 | 首次冷保存 前 → 后 | 后五次热保存 前 → 后 | 总耗时最大值 前 → 后 |
| --- | ---: | ---: | ---: | ---: |
| 短会话 | 805.12 → 430.64 | 302.69 → 109.57 | 502.05 → 314.94 | 811.21 → 433.43 |
| 长历史 + 55 个历史 checkpoint | 19818.88 → 11491.54 | 18714.33 → 10899.95 | 1104.55 → 591.59 | 19951.44 → 12409.52 |
| 单 child | 513.35 → 480.57 | 86.97 → 168.92 | 426.39 → 310.47 | 530.51 → 481.56 |
| 三个并发 child | 1715.27 → 908.79 | 248.50 → 274.03 | 1466.78 → 625.78 | 1745.04 → 916.13 |
| 账本 | 453.46 → 270.60 | 82.05 → 63.45 | 375.47 → 207.82 | 508.07 → 280.30 |

| 场景 | 总写入 bytes 前 → 后 | 热写入 bytes 前 → 后 | fs 写次数 前 → 后 | fs 读次数 前 → 后 |
| --- | ---: | ---: | ---: | ---: |
| 短会话 | 5704 → 5562 | 3735 → 3640 | 17 → 10 | 17 → 10 |
| 长历史 + 55 个历史 checkpoint | 3618006 → 3685263 | 184505 → 185715 | 473 → 454 | 473 → 454 |
| 单 child | 39740004 → 3329924 | 33116670 → 15820 | 6 → 7 | 0 → 8 |
| 三个并发 child | 119220012 → 9989772 | 99350010 → 47460 | 18 → 21 | 0 → 24 |
| 账本 | 5680 → 5680 | 4734 → 4734 | 6 → 6 | 1542 → 262 |

| 场景 | 保存区间并集 前 → 后 | 后版排队累计 / 处理累计 | 后版队列峰值（单 child） | 后版 writeFile 并发峰值 |
| --- | ---: | ---: | ---: | ---: |
| 短会话 | 802.53 → 427.23 | N/A / N/A | N/A | 4 |
| 长历史 + 55 个历史 checkpoint | 19748.52 → 11441.16 | N/A / N/A | N/A | 4 |
| 单 child | N/A → 480.00 | 0.51 / 469.94 | 1 | 1 |
| 三个并发 child | N/A → 908.55 | 4.39 / 2557.76 | 1 | 3 |
| 账本 | N/A → 269.85 | 0.04 / 269.80 | N/A | 1 |

长历史首次格式元数据使总字节从 3.62 MB 小幅增至 3.69 MB；child 首次建立图会多一次对象提交，不能只宣传减少写次数。单 child 冷保存与旧整文件写相比可能更慢，收益主要在后续屏障及兄弟隔离。并发 child 的累计处理时间可大于总壁钟，表中没有将它们相加。旧版 child 和账本缺少存储埋点，并集用 N/A/null 表示未观测而不是没有 I/O，不能用于宣称缩短全部现场等待。

## 最终检查结果

`bun run compile`、`bun run lint`、`bun run build:test`、`bun run test` 均退出 0。最终全量 794 项：793 通过、0 失败、1 跳过（沙箱禁止绑定本地 HTTP 故障服务端口）；耗时 117438 ms。最后定向 42 项全部通过。`git diff --check` 通过。三协议及网络恢复中的 Provider 为模拟输入；未运行真实账号请求或 VS Code F5/安装验收。
