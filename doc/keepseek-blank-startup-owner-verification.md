# 空白启动、账号入口与执行所有权（2026-11-08）

基线 `beaef7e7c87022eb970ed3bf9e78c3d958ee9cc2`，版本 0.5.3。本轮代码留在工作树；未提交、安装或发布。此文定义当前合同；此前新建会话、任务侧栏及协调验收中的数值和截图只证明各自历史基线。

## 根因与修复

已由源码确认：v1 锁即使原 PID 已退出仍禁止重新选举；`deactivate()` 不等待清理；observer 的 Host 白名单和账号 Webview 的上下文门禁共同封锁账号；Task 消息包装将用户级账号误路由到 Worker；普通 Store 与 ProjectAssistant 两条初始化链均读取上次历史。不能从锁文件单独判断它由正常退出、崩溃或其它中断留下。

新 activation 使用 `initializeFreshBoot()`，只生成一次内存空 UUID。重复 ready、隐藏重开和同宿主 Webview 重建复用当前目标。默认普通空白目标不加载旧 index、V1/Memento、Router/Worker、草稿、正文、replay、evidence 或远端余额；未使用空目标不进入永久历史。配置、信任与来源 watcher 只标 dirty，当前任务首次准备才消费。用户主动打开历史才导入和合并元数据；选中任务只查看有限页，执行/继续才建立 Worker 并完整恢复执行状态。

`WEBVIEW_MESSAGE_SCOPES` 是穷举类型权威。用户级账号在根 Host 处理，旧客户端多余 taskCardId 也不触发任务路由。账号弹窗先展示本地快照和独立加载状态；添加/保存不隐式测试连接、发现模型或刷新余额。测试/发现显式触发，绑定 requestId/弹窗代次和取消。正在使用的来源禁止冲突修改，其它账号仍可配置。账号事务在内核互斥中读改写并检查版本，避免跨窗口覆盖更新。

输入能力由 `interactionState` 派生；编辑、新空目标、账号和执行分别表达。新目标可接收首次准备，实际请求仍须 owner、模型凭据、当前指令/Skills、安全状态和正文耐久屏障。只有匹配的 accepted 清稿。observer 可以编辑和新建本地空目标，不能执行项目副作用；检查入口可重新竞争，不自动续跑。

## 所有权与操作记录

活跃范围登记使用短全局互斥，阻止父子工程、Git 重分组及原路径更换 inode 后与旧操作重叠；崩溃记录只有在取得旧互斥且其 journal 无活/未知工作后才移除。

`LocalKernelMutex` 连续持有物理项目身份对应的本地 loopback 排他监听，宿主退出由内核释放；磁盘 `.lock` 是身份与兼容审计，不是通过超时/unlink 抢占的互斥。地址冲突、权限拒绝和无法验证的文件系统明确限制执行。选举不依赖 PID 年龄；根 realpath、目录物理身份及 Git scope 仍在每次请求/副作用前复核。没有 TTL 偷锁或定时推理。

`ProjectOperationJournal` 与历史正文分离，持久保存 intent、owner generation、操作 hash、资源范围、派发进程/组及结算。命令/验证先创建无目标载荷的 Node 启动器；PID 持久化及 fence 复核完成后才经 IPC 发送 GO，覆盖 spawn 后来不及写 PID 的崩溃窗口。Apply 沿原 prepared journal、hash 和 read-back 路径执行。已结束但结果未送达的操作留 `result_unknown` 审计，不自动重试；活进程或无法核实的派发保留执行隔离。账号和本地草稿不受隔离影响。

`shutdown():Promise<void>` 幂等停止接单、取消/等待 runtime、flush 必要记录，最后释放根 owner。Worker 不释放共用 owner；extension `deactivate()` 返回同一 Promise。此路径不替代崩溃恢复。

旧 v1 锁没有耐久派发身份，不能用缺少记录或点击确认推断所有后代已退出。诊断展示真实原因和下一步。对同机且旧 acquiredAt 早于可信 OS 启动时间的锁，可证明旧进程不再存活：先保留 v1 审计，再升级；原操作仍不重试。同一次系统启动内缺少进程证据的旧锁继续隔离，需核对记录，或重启计算机后在应用内检查。代码不删除现场真实锁、不批量 kill 未知进程。

## 存储兼容

普通历史与任务均只查看有限页。普通历史显示“准备继续此会话”，按 session/viewGeneration/requestId 恢复完整操作和上下文，准备本身不调用模型；任务执行/继续才建立 Worker。清理后保留已导入 tombstone，避免 V1 备份使过期历史复活。observer 的显式 Memento 查看使用内存只读投影，不写迁移标记；角色恢复后仍由明确历史操作导入。

首次发送复用现有 canonical SessionObjectStore 分片，发布独立 commit receipt，不读取/覆写旧 workspace 索引。显式历史操作将 receipt 幂等合并进 V2 索引；索引耐久后才删除 receipt。旧 V1/Memento 原件保留，失败不以新局部列表覆盖旧历史。新目标初始 ask，不为继承旧审批偏好扫描 V1 正文。

新会话 DraftRun/审批审计分会话保存，ChangeSet 复用 V4 分片和 session-index receipt；首次新任务不读取旧聚合操作正文。显式恢复合并这些记录，继续禁止旧 permit、批准、队列和已完成工具重跑。旧 user/contextInstructions、三协议 projection/replay/schema 与任务累计预算不因启动改变。

## 验证证据

最终命令、计数与样本在本轮完成后填写；环境 skip 不等于通过。测试使用临时存储、受控 transport，无付费模型请求。

当前工具沙箱拒绝 TCP 及 Unix socket 监听（EPERM）。默认 Store/Host/Webview 行为套件使用测试注册器显式安装的受控互斥后端，仍操作真实临时文件和进程；这验证编排/耐久/身份合同，不证明生产内核后端跨进程互斥。native-only 后端测试绕过替身，按环境实际结果报告。

## 原生验收（待验证）

本轮已在 macOS 原生 VS Code 打开临时 smoke 工作区，并为调试指定临时工程、独立 user-data-dir 和 extensions-dir。F5 显示“是否信任此工作区中的文件的作者”，已取消，未更改工作区信任，也未启动该开发宿主。因此本轮新代码没有原生界面通过证据；临时配置可在用户处理信任后继续以下步骤。

1. 使用临时工程和隔离 VS Code profile，以本仓库编译结果启动 Extension Development Host；不要重装真实扩展。准备 V2 长历史、V1、Memento、Task/Router 和草稿副本。
2. 新宿主打开 KeepSeek：默认普通空白，可编辑；记录 activate、Provider 注册、首状态、输入、账号弹窗时间及存储/请求计数。保持空闲并触发测试 watcher，旧历史读取与远端请求应持续为零。
3. 无账号和错误 endpoint 时打开账号：可添加第一个来源、手填 model ID、保存。observer、Task、Router 和暂停历史恢复时重复；不创建 Worker，不自动发现/测试。显式测试断网、超时、取消、重复点击、关闭后迟到；表单草稿保留且 pending 结束。
4. 配置受控来源并发送：记录准备、正文持久化、accepted、请求的顺序。暂停保存/取消/双击/切目标，不能提前清稿或双发；缺少模型和保存错误必须匹配请求并保留草稿。
5. 同宿主隐藏重开/重复 ready 保留当前输入和目标；Reload Window 是新 activation，应再次空白。未发送不积累空历史。主动打开历史才读取；查看旧任务不发模型、不建 Worker，继续才走安全恢复。
6. 同物理工程与路径别名开双窗口：只允许一个 owner。关闭 owner 后 observer 点击检查取得角色并同步存储/UI/任务能力，不自动续跑。测试故障只使用临时锁及受控子进程。
7. 测试 SIGKILL 干净宿主、新日志有活 detached 子进程、intent/派发窗口和旧 v1 锁。活/未知隔离；有结束证据后可继续独立新工作，但不重跑原操作；v1 reboot 证据保留旧审计。
8. 检查中文 IME、拖拽、@、Skills、引用、编辑重发、Apply/Discard、快捷键和焦点；设置不受无关执行门禁控制，原信任/外部路径/hash/取消边界保持。

macOS 原生 VS Code、Windows/Linux 原生及真实 Provider/缓存账单均不能由 Node DOM 或受控 transport 的通过替代。远端跨主机协调没有实现，远端只限制执行；Windows 仅在本地固定 NTFS/ReFS 卷及后端检查成功时启用，UNC/映射网络卷不当成本地。进程组可核对已记录后代；任意命令主动 setsid 并关闭继承流时，不能提供原生容器级的所有后代存活证明，这是当前剩余边界。本地后端与各平台后代治理仍须真实验证。端口碰撞失败会给出执行不可用原因，不授权第二个 writer。
