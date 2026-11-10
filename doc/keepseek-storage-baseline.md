# 0.5.2 初始存储基线

2026-11-10 起，0.5.2 是内测初始版本。此变更有意丢弃旧版本数据兼容：不导入旧会话、账号、设置、审批记录或请求协议。当前格式的损坏校验、中断恢复和副作用幂等仍是运行合同。

## 唯一身份和存储位置

扩展清单身份为 `kmvdata.keepseek`，磁盘命名空间为 `com.kmvdata.keepseek`，设置统一使用 `kmvdata.keepseek.*`。命令及视图继续使用 `keepseek.*`，这是当前产品 API 名称。

| 宿主平台 | 当前磁盘根 |
| --- | --- |
| macOS | `~/Library/Application Support/com.kmvdata.keepseek` |
| Linux | `$XDG_DATA_HOME/com.kmvdata.keepseek`；未指定绝对路径时为 `~/.local/share/com.kmvdata.keepseek` |
| Windows | `%LOCALAPPDATA%/com.kmvdata.keepseek`；未指定绝对路径时为用户目录的 `AppData/Local/com.kmvdata.keepseek` |

`shared/storageRoot.ts` 从 Node 扩展宿主的平台、用户目录和标准环境变量解析路径，然后生成 `Uri.file()`。`extension.ts` 把同一 URI 传给会话和 Provider 的全部 Store。远程工作区使用远程 Node 宿主的数据目录。VS Code FileSystemProvider 的虚拟 URI 不再决定磁盘地址，也不通过改写 scheme 冒充本地路径。扩展只运行在 workspace Node 宿主。

## 当前格式

存储格式版本与扩展发布版本独立，不因“初始版本”重新编号。

| 数据 | 唯一读写格式 |
| --- | --- |
| 工作区索引、全局会话目录 | V2 |
| 会话对象图及 shard manifest | V4 |
| 请求投影、工具 schema | 当前协议 V15 |
| 标题状态 | V2；命名材料仅 `user_inputs_v3` |
| ChangeSet | 当前 V4；编辑为显式 canonical kind |
| 子代理持久化 | V4 对象图，当前 metadata/transcript V2 |
| 账号子代理模型设置 | V2 |
| 执行检查点、计时 | V2 |
| 用量存储 | 当前 V2 分桶账本 |

旧 monolith、Memento 会话导入、V2/V3 shard 转换、ChangeSet V1–V3、子代理散落侧文件、旧标题 provenance、旧请求工具 lane、旧审批模式及旧配置入口均已移除。格式校验失败不可解释成另一种旧格式。现有目录名中的版本号只表示该子系统当前格式，不代表旧发布兼容。

## 启动和清理

启动不扫描旧扩展目录、不迁移历史、不恢复上次会话。生产激活显式调用 `initialize({ fresh: true })`，仅加载当前工作区 summary 索引，在内存创建新的空白会话；不读磁盘 active shard、不展开对象图、不修复孤儿，首次启动也不为了保存占位会话写磁盘。历史由用户选择后惰性加载，工作区切换也进入全新空白。空白会话的项目指令与 Skills 标记为 `deferred`，不阻塞编辑或提交；第一条任务先取得交互拥有者，再读取实际上下文，准备失败不发模型请求。后台自动保留只刷新索引，不能把新空白替换成磁盘旧 active。所有设置读取、写入和配置变更监听只使用 `kmvdata.keepseek` 命名空间；旧 `keepseek.*` 设置在任何用户配置、工作区或文件夹均不被读取。无需首次重置、基线标记或遍历旧项目，新配置直接使用清单默认值。账号从新数据根重新配置。历史索引与关联 Store 使用同一删除权威；预览、确认、执行、占用租约、删除墓碑、日志回收及重启恢复仍按[历史清理合同](keepseek-history-cleanup.md)执行。

`sessionDeletionAuthority.ts` 仍只对原生文件系统提供跨进程锁。此边界保留；生产接线已让全部 Store 使用原生 `file:` 根，解决清理时“当前存储类型暂不支持安全的跨进程历史清理”的存储类型原因。

## 物理清除旧磁盘数据

新身份不读取旧扩展的数据和密钥。开发环境中的修改不等于已安装运行，也不等于已删除用户机器上的旧目录。

关闭所有 VS Code 窗口后，可执行精确的离线重置：

```bash
bun run reset:data
bun run reset:data --apply
```

第一条仅列出目标，第二条执行。自定义 VS Code 用户目录使用 `--user-data-dir /absolute/path`，当前项目设置可用 `--workspace-settings /absolute/path/to/settings.json` 显式指定。脚本只处理明确的 KeepSeek 数据、设置和快捷键；不修改共享 SQLite、系统钥匙串或其他扩展。旧系统凭据由新扩展 ID 隔离，不被导入。项目源代码和共享 `.codex`/Skills 文件不在清理范围。

安装新包时应移除旧 `keepseek.keepseek` 扩展，避免两个 Provider 同时注册。`scripts/reinstall-vsix.js` 包含旧身份清退；开发修复本身不自动执行安装或卸载。

## 验收

1. 打开新版时进入全新空白会话；不扫描或加载旧 shard。
2. 诊断显示扩展 ID 为 `kmvdata.keepseek`、存储 scheme 为 `file`。
3. 重新配置账号并发送指令，重启后能手动加载当前会话。
4. 在“设置 → 历史会话”预览并确认清理，空闲历史被删除，使用中的会话受保护。
5. 另一窗口的迟到保存及重启恢复都不能复活已删除会话。
6. 标题提交中断、桶写失败和未知命令副作用继续按当前恢复规则处理。

自动化验证必须覆盖当前协议的真实性能与故障行为；不得仅删除失败断言来假装当前格式已验证。原生 VS Code UI、真实模型和其他操作系统仍需分别记录现场证据。

## 本次交付验证

2026-11-10，开发起点 `00a60049d20a85adfa6cb14e66719d662bb37f17`，验收时源码 HEAD 为 `a8431d70be23120926d090fd11266f337b53a825`，macOS / Node v24.15.0。本会话未执行 Git 提交或推送。产品源码在完整回归期间保持冻结，打包源码指纹与测试基线一致。

| 检查 | 实际结果 |
| --- | --- |
| `bun run compile` | 通过；市场打包流程再次从清空的 `out/` 编译 |
| `bun run lint` | 通过 |
| `bun run build:test` | 通过 |
| `bun run test` | 1,516 项：1,515 通过、0 失败、0 取消、1 环境跳过；625.36 秒 |
| `node --test scripts/reset-keepseek-data.test.cjs` | 3/3 通过，仅临时目录 |
| `bun run package:market` | 通过，包身份与运行依赖校验通过 |
| `git diff --check` | 通过 |

唯一跳过项为本地故障服务器测试，当前沙箱不允许绑定监听端口；不把它计为通过。真实模型请求、原生 VS Code 界面、Windows/Linux 实机以及扩展安装未执行。跨平台路径解析、三协议 payload/replay、独立进程锁与删除防复活由自动化覆盖，不能替代上述现场验收。

新空白启动的回归验证：启动只读索引、零会话正文读取、零孤儿扫描、零占位会话写入；首次任务在取得交互拥有者后准备上下文；用户明确选择历史后才读取对应正文；后台保留清理不能把空白会话换回磁盘旧 active。

已生成 `keepseek-0.5.2.vsix`。旧扩展的数据目录、共享 VS Code 状态数据库及系统钥匙串未物理擦除；新身份与新配置命名空间不读取这些数据。离线重置仅做过目标预览，真实删除需使用上面的 `reset:data --apply`，且应先关闭 VS Code。
