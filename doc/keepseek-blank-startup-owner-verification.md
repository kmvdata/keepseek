# 空白启动、账号入口与执行所有权（2026-11-08）

调查基线 `beaef7e7c87022eb970ed3bf9e78c3d958ee9cc2`，版本 0.5.3。开发期间出现外部提交 `c9f0190`、`e53e988`，已包含主体改动；本代理未提交本工程、未安装或发布真实扩展，剩余修正以最终工作树为准。此文定义当前合同；此前新建会话、任务侧栏及协调验收中的数值和截图只证明各自历史基线。

## 根因与修复

已由源码确认：v1 锁即使原 PID 已退出仍禁止重新选举；`deactivate()` 不等待清理；observer 的 Host 白名单和账号 Webview 的上下文门禁共同封锁账号；Task 消息包装将用户级账号误路由到 Worker；普通 Store 与 ProjectAssistant 两条初始化链均读取上次历史。不能从锁文件单独判断它由正常退出、崩溃或其它中断留下。

新 activation 使用 `initializeFreshBoot()`，只生成一次内存空 UUID。重复 ready、隐藏重开和同宿主 Webview 重建复用当前目标。默认普通空白目标不加载旧 index、V1/Memento、Router/Worker、草稿、正文、replay、evidence 或远端余额；未使用空目标不进入永久历史。配置、信任与来源 watcher 只标 dirty，当前任务首次准备才消费。用户主动打开历史才导入和合并元数据；选中任务只查看有限页，执行/继续才建立 Worker 并完整恢复执行状态。

`WEBVIEW_MESSAGE_SCOPES` 是穷举类型权威。用户级账号在根 Host 处理，旧客户端多余 taskCardId 也不触发任务路由。账号弹窗先展示本地快照和独立加载状态；添加/保存不隐式测试连接、发现模型或刷新余额。测试/发现显式触发，绑定 requestId/弹窗代次和取消。正在使用的来源禁止冲突修改，其它账号仍可配置。账号事务在内核互斥中读改写并检查版本，避免跨窗口覆盖更新。

输入能力由 `interactionState` 派生；编辑、新空目标、账号和执行分别表达。新目标可接收首次准备，实际请求仍须 owner、模型凭据、当前指令/Skills、安全状态和正文耐久屏障。只有匹配的 accepted 清稿。observer 可以编辑和新建本地空目标，不能执行项目副作用；检查入口可重新竞争，不自动续跑。

普通未发送草稿按 activation/session 保存于 Webview 本地状态，合并既有 UI 字段。同宿主重建恢复引用 markup 和已确认中文/Unicode 输入；新 activation 忽略上次草稿；历史会话草稿可在主动选择对应历史后找回，未进入历史的新空白草稿可经“设置 → 恢复草稿”显式选择。恢复列表只在点击后读取本地 UI 草稿、每页最多 20 项；只向当前空白普通目标复制选中的 markup，不切换旧 session、不恢复批准/Skills/permit、不发 Host 或模型消息。当前输入非空、IME 组合、历史预览、Task/Router 或运行中会拒绝覆盖；列表绑定 activation/session，切换目标或关闭后旧选择失效，原草稿继续保留。activation 切换先清理旧提交与 revision，迟到的旧高 revision 或 accepted 不清新稿。历史元数据刷新保留已有行及编辑/刷新按钮；仅无缓存时显示加载占位，失败与完成绑定本次请求。

## 所有权与操作记录

活跃范围登记使用短全局互斥，阻止父子工程、Git 重分组及原路径更换 inode 后与旧操作重叠；崩溃记录只有在取得旧互斥且其 journal 无活/未知工作后才移除。

`LocalKernelMutex` 连续持有物理项目身份对应的本地 loopback 排他监听，宿主退出由内核释放；磁盘 `.lock` 是身份与兼容审计，不是通过超时/unlink 抢占的互斥。地址冲突、权限拒绝和无法验证的文件系统明确限制执行。选举不依赖 PID 年龄；根 realpath、目录物理身份及 Git scope 仍在每次请求/副作用前复核。没有 TTL 偷锁或定时推理。

`ProjectOperationJournal` 与历史正文分离，持久保存 intent、owner generation、操作 hash、资源范围、派发进程/组及结算。命令/验证先创建无目标载荷的 Node 启动器；PID 持久化及 fence 复核完成后才经 IPC 发送 GO，覆盖 spawn 后来不及写 PID 的崩溃窗口。Apply 沿原 prepared journal、hash 和 read-back 路径执行。已结束但结果未送达的操作留 `result_unknown` 审计，不自动重试；活进程或无法核实的派发保留执行隔离。账号和本地草稿不受隔离影响。

`shutdown():Promise<void>` 幂等停止接单、取消/等待 runtime、flush 必要记录，最后释放根 owner。Worker 不释放共用 owner；extension `deactivate()` 返回同一 Promise。此路径不替代崩溃恢复。

未知结果隔离后，新执行仍被禁止；只有仍持有同一有效存储 fence 的已准入 runtime 可保存匹配结果和关闭审计。observer 晋升同步已有项目/Worker 存储角色。owner 校验失败会撤销进程内待运行准入，后续新任务不带跑旧队列；旧目标须明确继续。关闭等待初始 owner readiness 和已经开始的检查，再释放互斥。

旧 v1 锁没有耐久派发和启动会话身份，不能用缺少记录、父 PID 退出或点击确认推断所有后代已退出。旧 PID 存活或无法核验时，先保持隔离，任何时间比较都不覆盖该守卫。对旧锁或损坏锁，所有权检查在内核互斥下保存与原始字节 SHA-256、同机身份及稳定 OS boot-session ID 绑定的观察记录；首次观察不授权接管。先检查、重启计算机、再检查，只有原始锁字节未变且稳定 boot-session ID 确实改变，才保留旧审计并升级；原操作仍不重试。锁年龄、acquiredAt、mtime 与 OS 启动墙钟时间均不授权接管，避免时钟校正误判重启。Linux 使用内核 boot_id，macOS 使用 kern.bootsessionuuid；Windows 暂无经验证的稳定启动 ID 适配器，其缺证据旧锁的重启恢复明确不可用，新的干净本地 owner 不受此限制。新操作日志保存可选启动 ID；旧字段缺失时保持未知，不用时间戳补证。代码不删除现场真实锁、不批量 kill 未知进程。

显式检查只读投影已有命令、ChangeSet 索引/checkpoint 以及可用的验证日志元数据，返回计数、状态及完整性，不初始化/迁移/修复执行 Store，不返回命令正文、输出、路径或凭据。命令/修改计数是扩展存储范围，不冒充物理项目归属；旧验证缺少独立记录时显示“无法核实”。文件大小/数量有界；partial、missing 和 unavailable 都不是结算证明。

## 存储兼容

普通历史与任务均只查看有限页。普通历史显示“准备继续此会话”，按 session/viewGeneration/requestId 恢复完整操作和上下文，准备本身不调用模型；任务执行/继续才建立 Worker。清理后保留已导入 tombstone，避免 V1 备份使过期历史复活。observer 的显式 Memento 查看使用内存只读投影，不写迁移标记；角色恢复后仍由明确历史操作导入。

首次发送复用现有 canonical SessionObjectStore 分片，发布独立 commit receipt，不读取/覆写旧 workspace 索引。显式历史操作将 receipt 幂等合并进 V2 索引；索引耐久后才删除 receipt。旧 V1/Memento 原件保留，失败不以新局部列表覆盖旧历史。新目标初始 ask，不为继承旧审批偏好扫描 V1 正文。

新会话 DraftRun/审批审计分会话保存，ChangeSet 复用 V4 分片和 session-index receipt；首次新任务不读取旧聚合操作正文。显式恢复合并这些记录，继续禁止旧 permit、批准、队列和已完成工具重跑。旧 user/contextInstructions、三协议 projection/replay/schema 与任务累计预算不因启动改变。

## 验证证据

测试使用临时存储、受控 transport，无付费模型请求。最终全量结果见下文；环境 skip 不等于通过。

### 启动 I/O 与发送时序

原始数值见 [机器可读证据](benchmarks/keepseek-blank-startup-20261108.json)。Node v24.15.0 / darwin，真实 activation、Store、临时文件、Host 与生成 Webview DOM，owner 使用显式受控适配器。夹具为 120 个旧会话、3,600 条消息；这是单次样本，采样位于最终五文件定向测试中，不是原生绘制、p50/p95 或固定性能保证。

| 观测 | 旧初始化路径 | 当前默认 activation |
| --- | --- | --- |
| 旧存储读取尝试 / 成功 / 字节 | 11 / 5 / 2,120,424 | 0 / 0 / 0 |
| V1 迁移 | 1 | 0 |
| 自动选中旧消息 | 30 | 0 |
| 历史 Worker / 远端请求 | 此对照仅量存储路径 | 0 / 0 |
| 实测阶段 | storage initialize 230.24 ms | 注册 13.51 ms；ready 40.89 ms；账号可操作 88.06 ms |

旧对照只执行此前 activation 的 storage initialize 路径，不能与当前完整激活时长相减宣称端到端提速。当前样本在重复 ready、同宿主重建、空闲、配置/信任 watcher、清理入口之后仍无旧历史读取或远端请求；主动打开历史之后返回新空目标，自动清理也不再扫描旧历史。

首次发送同一夹具的点击相对时间：准备 7.76 ms、准确正文耐久化 251.39 ms、匹配 accepted 251.50 ms、受控请求 1,162.92 ms。耐久化至 accepted 为 0.11 ms，accepted 至实际请求还有 911.42 ms 当前任务准备；这些工作没有被当成耗时消失。该发送只有一次模型/标题 transport 调用，一条 user 消息；首次提交与取消/重试均未读取无关旧正文、未迁移旧索引。保存中取消为 0 请求、草稿保留；明确重试复用已耐久 user tail，只有 1 条 user 和 1 次请求。

### 检查命令

`bun run compile`、`bun run lint`、`bun run build:test`、`git diff --check` 均退出 0。`bun run test` 本轮全量共 1,593 项：1,589 通过、0 失败、4 跳过、0 取消，936,388 ms。跳过为 3 项生产内核互斥/跨进程恢复及 1 项本地故障服务器监听，均由环境拒绝 socket bind 引起。

全量快照之后的末次审查又补强启动身份恢复证据与旧空白草稿的显式找回入口。最终源码的 `inputComposition + freshActivation + sessionTitleWebview + executionTimeStats + interactionState` 五文件定向回归为 66/66 通过、0 跳过，8,485 ms；compile、lint、build:test、diff 检查均退出 0。包含草稿 markup/引用、中文 IME、非空/历史/Task/Router 拒绝覆盖、目标切换/关闭后迟到选择、分页、焦点/Escape、旧缓存历史编辑和实际 activation 的零历史读取/零 Host 消息找回。上述全量快照与这些最终变更的定向覆盖分别记录，不将早先全量计数冒充后续变更的覆盖。

稳定启动身份补强后的 `projectCoordination + legacyOperationDiagnostics` 共 33 项：30 通过、0 失败、3 原生监听权限跳过；包含活 PID/EPERM 优先隔离、首次观察不接管、启动 ID 缺失/损坏/异机拒绝、真正换代、损坏锁字节替换及 readiness/shutdown 竞态。该次 compile、build:test 与 owner/journal lint 均退出 0。

最终源码及固定启动身份夹具重新 build:test 后，受影响 Host/任务/存储组合回归共 246 项：243 通过、0 失败、3 相同原生监听权限跳过、0 取消，224,898 ms。命令为：

```bash
node --require ./out-test/test/registerVscodeStub.js --test --test-concurrency=4 out-test/test/project*.test.js out-test/test/freshBootStorage.test.js out-test/test/freshSafetyStores.test.js out-test/test/chatSessionStore.test.js out-test/test/accountProviderSafety.test.js out-test/test/interactionState.test.js out-test/test/legacyOperationDiagnostics.test.js
```

这组包含真实临时 Store/Host/Worker、Task/Router、账号 observer、角色恢复、消息 scope、队列隔离、正文持久化、三协议任务/补充/继续及旧存储兼容。独立运行需要预加载同一 VS Code stub；诊断夹具固定 boot-session ID，避免把工具环境不可读启动身份混入元数据测试。首次不完整启动已纠正后重新运行，不计作通过。

市场包仅通过 `bun run package:market` 构建，清理 out 后重编译、包含运行依赖并验证包内容；构建不安装、不发布真实扩展。原生平台与付费 Provider 不由该步骤代验。

本次 package:market 退出 0，生成 `keepseek-0.5.3.vsix`，900 个条目、5,437,758 字节。另核对 10 个关键编译模块与包内字节一致，`ignore/yaml/confbox` 三个运行依赖均存在；五份当前入口/架构/生命周期/项目/验收文档的本地链接均有效。包 SHA-256：`8a413651990f229b7a6924ab3afe6b7d0e984c426692121318ebf640abfd5649`。

当前工具沙箱拒绝 TCP 及 Unix socket 监听（EPERM）。默认 Store/Host/Webview 行为套件使用测试注册器显式安装的受控互斥后端，仍操作真实临时文件和进程；这验证编排/耐久/身份合同，不证明生产内核后端跨进程互斥。native-only 后端测试绕过替身，按环境实际结果报告。

当前工具进程调用真实 macOS 启动身份适配器返回 unavailable；稳定启动身份换代测试使用带平台/主机命名空间的受控 UUID，不能替代原生重启实测。缺少该证据时执行隔离保持，界面说明无法核实，不使用时间戳或用户确认兜底。

## 原生验收（待验证）

本轮已在 macOS 原生 VS Code 打开临时 smoke 工作区，并为调试指定临时工程、独立 user-data-dir 和 extensions-dir。F5 显示“是否信任此工作区中的文件的作者”，已取消，未更改工作区信任，也未启动该开发宿主。因此本轮新代码没有原生界面通过证据；临时配置可在用户处理信任后继续以下步骤。

1. 使用临时工程和隔离 VS Code profile，以本仓库编译结果启动 Extension Development Host；不要重装真实扩展。准备 V2 长历史、V1、Memento、Task/Router 和草稿副本。
2. 新宿主打开 KeepSeek：默认普通空白，可编辑；记录 activate、Provider 注册、首状态、输入、账号弹窗时间及存储/请求计数。保持空闲并触发测试 watcher，旧历史读取与远端请求应持续为零。
3. 无账号和错误 endpoint 时打开账号：可添加第一个来源、手填 model ID、保存。observer、Task、Router 和暂停历史恢复时重复；不创建 Worker，不自动发现/测试。显式测试断网、超时、取消、重复点击、关闭后迟到；表单草稿保留且 pending 结束。
4. 配置受控来源并发送：记录准备、正文持久化、accepted、请求的顺序。暂停保存/取消/双击/切目标，不能提前清稿或双发；缺少模型和保存错误必须匹配请求并保留草稿。
5. 同宿主隐藏重开/重复 ready 保留当前输入和目标；Reload Window 是新 activation，应再次空白。未发送不积累空历史。新 activation 后从“设置 → 恢复草稿”找回旧空白未发送内容；确认原稿保留、没有 Host/模型请求、非空输入/IME/切目标时不覆盖。主动打开历史才读取；查看旧任务不发模型、不建 Worker，继续才走安全恢复。
6. 同物理工程与路径别名开双窗口：只允许一个 owner。关闭 owner 后 observer 点击检查取得角色并同步存储/UI/任务能力，不自动续跑。测试故障只使用临时锁及受控子进程。
7. 测试 SIGKILL 干净宿主、新日志有活 detached 子进程、intent/派发窗口和旧 v1 锁。活/未知隔离；有结束证据后可继续独立新工作，但不重跑原操作；v1 reboot 证据保留旧审计。
8. 检查中文 IME、拖拽、@、Skills、引用、编辑重发、Apply/Discard、快捷键和焦点；设置不受无关执行门禁控制，原信任/外部路径/hash/取消边界保持。

macOS 原生 VS Code、Windows/Linux 原生及真实 Provider/缓存账单均不能由 Node DOM 或受控 transport 的通过替代。远端跨主机协调没有实现，远端只限制执行；Windows 仅在本地固定 NTFS/ReFS 卷及后端检查成功时启用，UNC/映射网络卷不当成本地。进程组可核对已记录后代；任意命令主动 setsid 并关闭继承流时，不能提供原生容器级的所有后代存活证明，这是当前剩余边界。本地后端与各平台后代治理仍须真实验证。端口碰撞失败会给出执行不可用原因，不授权第二个 writer。
