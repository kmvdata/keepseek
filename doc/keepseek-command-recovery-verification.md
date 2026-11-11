# 命令能力预检、纠错与批次隔离

## 2026-11-11 当前合同

命令纠错实施基线为 `07d4351fa741bdaf1c9472abc2c6871329801ae9`，KeepSeek 0.5.3，Asia/Shanghai。存储沿用 0.5.2 初始基线，静态能力版本为 v1。合法且可审查的 DraftRun 由当前审批模式授权，见[独立审批审查合同](keepseek-approve-for-me-verification.md)。

### 纠错与恢复

- `commandRecovery.ts` 在根任务中分别保存根因、不可变草稿身份、已接受响应的诊断投递和重复关系。Runner 的工具结果进入真实三协议投影，审批续跑使用已有操作结果通道。只有新草稿所属响应的请求携带同根因具体诊断时才判重复。同回复的兄弟草稿、检查点交接和物理重试各自按已有身份去重。容量紧张时优先投递有界诊断，详情仍由完整证据分页提供。
- `commandRecoveryKeys`、`replanKeys` 和历史停止记录保留。单独的旧 hash 只说明曾观察到错误。已启动只读失败的补证、缺授权和 reviewer 路径继续使用各自的检查。发现重复时，独立的已获准只读步骤按批次和依赖规则继续，累计请求、时间、费用与无进展限制照常生效。
- 用户可在已停止的任务后发送明确续接，例如「继续这个任务，改用……」或 `Correct the previous command …`。新消息作为原任务的用户补充计入累计预算，当前运行重新审批，既有拒绝和终态保留。ask 模式的编辑入口将 argv 带入输入框，提交当前任务的修正时沿用该任务身份，提交后生成的新草稿仍走当前审批。
- 原始命令卡使用「预检拦截 · 命令未启动」。有真实重复记录才增加「此命令的自动修正已停止」，有当前宿主标签证明时显示具体标签和提交。历史卡保留 v1 诊断和完整 argv。无效替代保留其来源指针，原卡可继续接受有效替代。

### Git 查询文法与结果

| 形式 | 允许的参数 |
| --- | --- |
| `git rev-parse <revision>...` | 1–16 个有限本地修订 |
| `git rev-parse --verify [--quiet] [--end-of-options] <revision>` | 按给定顺序，恰好一个有限本地修订，两个可选标志各至多一次 |

`--verify` 等已识别标志的结构错误报 `host_invalid_argv`，未支持的选项报 `host_unsupported_option`。可定位时报告原 argv 的零基索引。通过有限文法后，cwd、可执行文件、仓库配置、外部授权和单次 permit 仍由宿主核对。真实进程收到原 argv，每个 `^{commit}` 后缀随其修订保留在一个字面参数中。成功的 `revision_parse` 输出要求每行一个完整 SHA-1 或 SHA-256，并与修订数量一致。quiet 下的缺失或不匹配仍保留实际进程退出状态，空 stderr 的非零退出可归类为 `git_query_failed`。

Git 可以把裸的完整 OID 原样返回，也可在同名引用歧义或全名回退时返回一个对象。需要对象存在或提交类型时分别检查 `^{object}` 或 `^{commit}`。标签证明另外从宿主只读快照精确匹配完整 `refs/tags/...`，以该 ref 读取的对象 ID 解引用。已有同仓库、同任务提交和当前对象匹配的证据复用 `peeled ?? object`。缺少或不匹配时执行有界固定补证并核对快照。普通查询可以用无通配的 `git tag --list <name>` 后精确比较返回的标签名。参考 [git-rev-parse](https://git-scm.com/docs/git-rev-parse) 和 [gitrevisions](https://git-scm.com/docs/gitrevisions)。

### 本地验证记录（命令纠错实施基线）

环境为 macOS x86_64、Apple Git 2.50.1、Node 24.15.0、Bun 1.3.12。真实 Git 写入和 ref 变化均在隔离的临时仓库构造。下表的进程计数为业务 DraftRun 启动，宿主执行身份与 ref 快照的固定只读探针独立计量。

| 场景 | 实测 |
| --- | --- |
| 基线首次拦截 | 2 次受控模型请求，0 次审批续跑，0 次业务进程启动，审批层错误显示重复 |
| 修复后首次拦截 | 2 次受控模型请求，1 次审批续跑入口，0 次业务进程启动 |
| 跨段真实重复和独立查询 | 4 次受控模型请求，1 次审批续跑，独立只读进程启动 1 次，两条受阻草稿启动 0 次 |
| 有效标签证据与已移动标签 | 各 0 次业务进程启动。有效证据增加 0 次审批续跑，移动后增加 1 次受控续跑入口 |
| 有限文法及真实 Git spawn | 21 次业务进程启动，含 9 次 `--verify`，20 次 delegate、1 次显式 ask，历史终态启动 0 次 |
| 原生三协议、容量与恢复 | Chat Completions、Responses、Anthropic 的各定向场景实际发出受控请求。传输重连场景 4 次物理发送、3 次逻辑响应，恢复的旧工具 intent 未再次执行 |
| 历史卡与界面 | DOM 与宿主消息回归验证双语和历史参数复制，历史卡重开、复制及伪造批准时业务进程和模型请求均为 0 次 |

`bun run compile`、`bun run lint`、`bun run build:test` 和 `git diff --check` 均通过。最终全量 `bun run test` 共 1,582 项，1,581 通过、0 失败、1 跳过，耗时约 873 秒。跳过项为当前执行环境禁止绑定端口的本地网络故障服务器测试。

macOS 隔离 VS Code 开发宿主未能启动。原生 F5 和 Windows、Linux 实机仍需执行以下步骤。模型验收使用受控传输，未连接线上模型。

### 现场验收步骤

1. F5 启动扩展开发宿主并使用专用临时仓库。创建两个提交、一个 annotated tag 和一个 lightweight tag，记录 `show-ref`、索引和工作区状态。用新的会话依次选择 ask 与 delegate。
2. 准备 `['rev-parse', '--verify', '--quiet', '--end-of-options', 'v0.5.3^{commit}']`，核对 ask 等待当前批准，delegate 审查通过后记录 `auto_approval_review`，原 argv 字面传入且 stdout 仅一行完整 ID。查询一个不存在的标签，核对 exit 1、`exited` 及无成功事实。Windows、macOS、Linux 各记录一次实际 argv。
3. 用 `--unknown-fixture` 触发预检，核对原卡保留诊断且进程未启动。用受控模型在收到诊断后换草稿 ID、理由和选项附值，并在同轮准备独立只读查询，核对重复提示只出现在对应卡，独立查询完成，依赖写操作保持阻塞。
4. 在同一任务中取得提交和标签证据，使用隔离测试数据打开历史 `--verify` 终态，核对标签结果的复用、移动标签后的补证，以及重开与点击时的执行计数。另准备新合法草稿并核对新的审批记录。检查仓库的 refs、索引及工作区无额外变化。

## 2026-11-06 历史实施与验收

实施基线：`92789015021de7a10eca30a935a1b7d28a5c094a`。日期：2026-11-06，Asia/Shanghai。本次工作保留原有 `CHANGELOG.md`、`package.json` 修改，不提交、打标签、推送、打包或发布。

## 最终调用链与边界

1. `commandSemantics` 解析有限 argv、参数角色与效果；`commandCapability` 是版本 1 的静态诊断入口。展示、草稿创建、审批前与启动前使用同一解析权威。静态通过不代表 executable、仓库或权限核验通过。
2. `AgentLoop.createDraftRun` 在原工具循环内返回 `ok:false / needs_replan`、错误码、capability 阶段、`started:false`、argv 索引/token、恢复类别、相关有限能力和确切候选。原提案保留审计；`DraftRunStore` 将已知不可执行提案保存为待调整，避免长期 pending。工具 intent、完整 evidence/hash、固定 envelope 仍按既有顺序持久化。
3. 模型准备新 ID/hash 的草稿；V15 可用 `replacesDraftRun` 明确关联原 ID/hash，并保留所有原 `prerequisites`。替代关系只记录来源，永不移植审批或 permit。旧协议不接收这些字段，异常传入时拒绝整条提案，不会丢弃前置条件后继续执行。
4. `commandRecovery` 将能力/argv 缺口归入既有 `needs_replan`；Provider 使用真实 continuation 回到原任务。键绑定 rootTask、cwd、executable、程序/子命令、阶段、错误根因与环境，不使用新草稿 ID、reason 或轻微 argv 改动。同根因在模型有机会调整后仍重复则停止；不同根因不共用纠错次数配额，继续受任务的时间、费用及请求预算约束。同一响应中的兄弟工具调用合并观察，检查点保存观察身份。时间、费用、请求及根因记录跨 segment/epoch/恢复保留。
5. ask 的新草稿仍需新的用户批准。delegate 先过宿主硬检查，正常有限查询走 `host_policy`，其他既有可审查操作仍走独立 reviewer/必要的一次性人工决定。普通 Git 查询缺少仓库/启动证据单独归为 `insufficient_launch_evidence`，不把补证当成安全拒绝；原命令仍未获准。真正 deny、外部精确授权、信任、hash、启动身份、保护路径和取消均不因纠错放宽。
6. `draftRunDependencies` 核对 hash、session/rootTask、来源有效性、循环、替代、事实真假与快照；按有限拓扑串行推进。经过实时核验的独立只读检查可在前序局部失败后继续；未知/已启动写操作保持保守。假祖先不能继续同仓库后续 mutation，缺失标签只表示查询结果为空。原 `git_status_pager_override`、`git_commit_*`、tag sort 缺参纳入通用诊断/恢复并保留稳定细分码；Git release、受限 Python AST、commit reconciliation 保留各自的专用证据边界。
7. `DraftRunStore` 在审批前、permit 前后和 dispatch 前重核依赖及执行身份；`SpawnDraftRunExecutor` 继续使用 literal argv、`shell:false`、短时一次性 permit。结果追加到真实结果渠道，不回写旧 user、system、contextInstructions 或 replay 前缀。

## 查询、依赖和执行证据

| 情况 | 宿主结论 |
| --- | --- |
| `log --no-decorate` / `--decorate=no` | 等价参数；不自动改写原 argv |
| `log -S <value>` / `-G <value>`（也支持短选项附值） | 只读模式值，不是路径或修订；值须非空、无 NUL，最多 4096 UTF-8 字节；`-S` 可用 `--pickaxe-regex` |
| `git --no-pager log -p --oneline -- <path>` | 可验证的只读替代，用于检查路径的补丁历史；不自动替换原命令 |
| `tag --list pattern` 退出 0、空输出 | 查询完成，`predicate:false`；tag 不存在 |
| `merge-base --is-ancestor A B` 退出 0 / 1 | 查询完成，真 / 假；原退出码保留，假不满足前置条件 |
| `rev-parse HEAD^{tree} HEAD tag^{commit}` | 有限本地对象解析，参数是 revision，不是文件 |
| `rev-list --count A..B` | 有限提交范围，空范围计数 0 |
| 无效引用、范围、缺失对象或异常输出 | 查询错误分类保留，不允许自报可接受退出码 |
| 未 dispatch 的预检失败 | `executionStarted:false / not_dispatched`；可按当前授权纠错 |
| 确认启动失败 | `spawn_failed`；不同于进程运行后失败 |
| 已退出 / 执行记录不完整 | `exited` / `result_unknown`；缺字段、超时或 adapter 异常不能推断未启动 |

查询事实绑定实时 scope fingerprint，包括 executable、环境、仓库、HEAD/index/config/hook 和完整有界本地 refs 快照。HEAD、非当前分支或 loose tag 改变会使旧事实失效。refs 快照使用宿主固定只读 probe，4 MiB 上限，超限拒绝，不调用模型生成的 shell。裸 log 参数若实际命中工作区或索引中的路径（含已删除的 tracked 文件），仍过真实路径守卫；不会借 revision 身份读取受保护文件。

已启动只读查询失败仅允许在明确退出、当前语义/范围和预算核验后，回主模型做有界处理；已完成操作不被恢复重跑，写操作结果未知先核验。UI 区分待调整、依赖阻塞、启动失败、执行失败、结果未知与被替代，保留原命令、实际输出和新旧关联。明确记录为未派发的终态卡显示「未执行 · 已终结 · 无进程输出」，正常待批准卡仍显示预期风险。「请求批准」下可把受阻草稿的参数复制到输入框修正，原草稿仍是终态，复制不会提交请求。「帮我审批」不会出现此入口；只有确实可恢复的中断会显示原有的继续处理按钮。能力版本保留 v1：pickaxe 只扩展有限语法，既有诊断字段和拦截判定不变，历史 v1 卡继续展示原错误码和参数位置。

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
