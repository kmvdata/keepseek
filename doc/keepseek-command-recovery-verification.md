# 命令能力预检、纠错与批次隔离

实施基线：`92789015021de7a10eca30a935a1b7d28a5c094a`。日期：2026-11-06，Asia/Shanghai。本次工作保留原有 `CHANGELOG.md`、`package.json` 修改，不提交、打标签、推送、打包或发布。

## 最终调用链与边界

1. `commandSemantics` 解析有限 argv、参数角色与效果；`commandCapability` 是版本 1 的静态诊断入口。展示、草稿创建、审批前与启动前使用同一解析权威。静态通过不代表 executable、仓库或权限核验通过。
2. `AgentLoop.createDraftRun` 在原工具循环内返回 `ok:false / needs_replan`、错误码、capability 阶段、`started:false`、argv 索引/token、恢复类别、相关有限能力和确切候选。原提案保留审计；`DraftRunStore` 将已知不可执行提案保存为待调整，避免长期 pending。工具 intent、完整 evidence/hash、固定 envelope 仍按既有顺序持久化。
3. 模型准备新 ID/hash 的草稿；V15 可用 `replacesDraftRun` 明确关联原 ID/hash，并保留所有原 `prerequisites`。替代关系只记录来源，永不移植审批或 permit。旧协议不接收这些字段，异常传入时拒绝整条提案，不会丢弃前置条件后继续执行。
4. `commandRecovery` 将能力/argv 缺口归入既有 `needs_replan`；Provider 使用真实 continuation 回到原任务。键绑定 rootTask、cwd、executable、程序/子命令、阶段、错误根因与环境，不使用新草稿 ID、reason 或轻微 argv 改动。每任务最多两个纠错根因；同根因在模型有机会调整后仍重复则停止。同一响应中的兄弟工具调用合并观察，检查点保存观察身份。时间、费用、请求、纠错计数跨 segment/epoch/恢复保留。
5. ask 的新草稿仍需新的用户批准。delegate 先过宿主硬检查，正常有限查询走 `host_policy`，其他既有可审查操作仍走独立 reviewer/必要的一次性人工决定。普通 Git 查询缺少仓库/启动证据单独归为 `insufficient_launch_evidence`，不把补证当成安全拒绝；原命令仍未获准。真正 deny、外部精确授权、信任、hash、启动身份、保护路径和取消均不因纠错放宽。
6. `draftRunDependencies` 核对 hash、session/rootTask、来源有效性、循环、替代、事实真假与快照；按有限拓扑串行推进。经过实时核验的独立只读检查可在前序局部失败后继续；未知/已启动写操作保持保守。假祖先不能继续同仓库后续 mutation，缺失标签只表示查询结果为空。原 `git_status_pager_override`、`git_commit_*`、tag sort 缺参纳入通用诊断/恢复并保留稳定细分码；Git release、受限 Python AST、commit reconciliation 保留各自的专用证据边界。
7. `DraftRunStore` 在审批前、permit 前后和 dispatch 前重核依赖及执行身份；`SpawnDraftRunExecutor` 继续使用 literal argv、`shell:false`、短时一次性 permit。结果追加到真实结果渠道，不回写旧 user、system、contextInstructions 或 replay 前缀。

## 查询、依赖和执行证据

| 情况 | 宿主结论 |
| --- | --- |
| `log --no-decorate` / `--decorate=no` | 等价参数；不自动改写原 argv |
| `tag --list pattern` 退出 0、空输出 | 查询完成，`predicate:false`；tag 不存在 |
| `merge-base --is-ancestor A B` 退出 0 / 1 | 查询完成，真 / 假；原退出码保留，假不满足前置条件 |
| `rev-parse HEAD^{tree} HEAD tag^{commit}` | 有限本地对象解析，参数是 revision，不是文件 |
| `rev-list --count A..B` | 有限提交范围，空范围计数 0 |
| 无效引用、范围、缺失对象或异常输出 | 查询错误分类保留，不允许自报可接受退出码 |
| 未 dispatch 的预检失败 | `executionStarted:false / not_dispatched`；可按当前授权纠错 |
| 确认启动失败 | `spawn_failed`；不同于进程运行后失败 |
| 已退出 / 执行记录不完整 | `exited` / `result_unknown`；缺字段、超时或 adapter 异常不能推断未启动 |

查询事实绑定实时 scope fingerprint，包括 executable、环境、仓库、HEAD/index/config/hook 和完整有界本地 refs 快照。HEAD、非当前分支或 loose tag 改变会使旧事实失效。refs 快照使用宿主固定只读 probe，4 MiB 上限，超限拒绝，不调用模型生成的 shell。裸 log 参数若实际命中工作区或索引中的路径（含已删除的 tracked 文件），仍过真实路径守卫；不会借 revision 身份读取受保护文件。

已启动只读查询失败仅允许在明确退出、当前语义/范围和预算核验后，回主模型做有界处理；已完成操作不被恢复重跑，写操作结果未知先核验。UI 区分待调整、依赖阻塞、启动失败、执行失败、结果未知与被替代，保留原命令、实际输出和新旧关联。

旧记录缺少 executionStarted/phase 时按未知展示和读取；不把历史 hard_blocked 批量迁为可恢复。重启只恢复说明/结果，运行中记录变为中断未知，不恢复队列、审批或 permit。关闭 Webview、切换会话/模式、取消和编辑重发继续走原生命周期边界。

V15 仅增加有限计划字段及其工具描述。静态 system 不变；V1–V14 schema、V14 归一化、三协议 toolRounds/providerReplay 和旧 user 字节由回归保护。热会话沿用冻结版本，按原有冷边界升级。V1–V14 的静态失败在建立持久化草稿前返回诊断，原 argv 留在工具 evidence 中，避免未关联失败草稿阻塞已修正的命令；V15 才保留可显式关联的新旧草稿。

## 验证记录

- 原始五条 argv：临时仓库含 `0.5.0` 及后续两次提交，经 KeepSeek scope → host policy → permit → store → 真实 spawn，业务 DraftRun 实际启动 5 次，reviewer/人工各 0 次；该计数不包含宿主固定只读 scope 探针。
- 结果语义及新鲜度：完整查询用例业务 DraftRun 实际启动 12 次；假祖先、被移动的 loose tag、变化的 HEAD 对应的三次依赖写操作启动 0 次。
- 受控能力缺口：真实 AgentRunner 的 Chat/Responses/Anthropic 传输 stub 均验证当轮诊断 → 新草稿 → 新检查；完整 intent/evidence/hash/envelope 可恢复，旧 user 字节和工具集合稳定。stub 不代表真实线上模型。
- Provider 受控适配器测试另使用真实临时 `head`/`cat` 进程验证失败隔离、同任务续跑及审批身份；不以本次开发 Agent 自身执行成功作为产品验收。

| 最终检查 | 结果 |
| --- | --- |
| `bun run compile` | 通过 |
| `bun run lint` | 通过 |
| `bun run build:test` | 通过 |
| `bun run test` | 共 1123 项；1122 通过、0 失败、1 跳过，耗时约 459.5 秒 |
| `git diff --check`、文档导航链接 | 通过 |

唯一跳过项是本地网络故障服务器测试：当前执行沙箱禁止绑定其监听端口。不是命令能力/纠错测试跳过。所有新增回归均进入默认 runner。

整合期间修正了旧测试中未声明模拟进程启动事实、默认所有命令形成顺序依赖和将缺仓库证据视为硬拒绝的期望；这些变化对应本任务的新行为合同。缺少真实启动事实的旧数据仍保守读取，没有修改生产结论来迎合夹具。早期并行套件中的账本性能超时在最终独立全量运行中未复现，账本实现未改动。

- 未验证：真实线上模型、原生 VS Code Webview、Windows/Linux 实机。本次验证使用临时模型 Store/传输 stub，未连接真实 Extension Host/Webview 或发起线上模型验收；跨平台 literal argv 和 mock DOM 回归不能代替实机结果。

## VS Code 现场验收

1. F5 启动扩展开发宿主，打开专用临时仓库。初始化两次以上提交并给首个提交打 `0.5.0` tag；只在此临时仓库操作。新建会话以使用 V15，选择“帮我审批”。
2. 要求准备并运行原始五条查询：`git log --oneline --no-decorate 0.5.0..HEAD`、`git tag --list 0.5.0`、`git merge-base --is-ancestor 0.5.0 HEAD`、`git rev-parse HEAD^{tree} HEAD 0.5.0^{commit}`、`git rev-list --count 0.5.0..HEAD`。检查实际终端 argv、查询输出和审批审计为 host_policy；不得把引号塞入 argv。
3. 准备 `head`、argv `['-n']` 的能力错误以及独立的 `cat README.md` 检查。确认前者“尚未执行，待调整”，后者可完成；按诊断生成 `head -n 1 README.md` 新提案，确认新 ID/hash、替代关联和新的审批记录。原命令不启动、不消失。
4. 切换“请求批准”，重复修正场景。新草稿在点击前不执行，旧批准不能批准新草稿；重复点击、取消及切换模式不多启动。
5. 在临时仓库构造假祖先，并准备依赖其为真的写操作和独立查询。确认写操作未启动；空 tag 查询不能被当作 tag 存在。移动既有 tag 或 HEAD 后，旧事实不能继续授权写入，须重新查询。
6. 将能力错误重复提案，或改变 reason/轻微 argv 后重复。确认预算有界且 task/time/cost/request 计数不重置。模拟已启动写操作结果丢失时，只能先核验，不自动重跑。
7. 关闭/重开 Webview、重启扩展、切换会话以及编辑重发来源消息。确认卡片保留审计且没有旧队列、批准或 permit 复活；旧历史请求前缀不因展示变化被重写。

该方案保留有限命令语法，不开放任意 Git 选项、网络、helper、配置覆盖或仓库重定向。快照检查与 dispatch 之间仍受外部进程并发修改的一般竞态限制；本次通过临近 dispatch 重核缩小窗口，不宣称跨进程事务锁。
