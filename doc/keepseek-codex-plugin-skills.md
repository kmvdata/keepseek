# KeepSeek 复用本地 Codex 插件 Skills

**当前状态（2026-11-06）：暂时停用。** 当前只保留独立 Skills；不扫描或展示 Codex 插件 Skills，手输引用、预览、加载、读取工具和旧插件任务恢复均不能重新启用此功能。暂停由内部产品开关统一控制，没有用户设置入口。

新会话使用 V14，不包含插件读取工具。V12/V13 冻结的 system、工具 schema 和历史记录保持原字节，旧工具实际调用返回停用说明。旧会话仍可发起普通任务；已保存的插件消息、快照与 evidence 保留只读审计。下文为历史实现与验收记录，不代表当前启用状态。

实施基线为 KeepSeek `8bad248`，分支 `main`，开始时工作区干净。核对日期为 2026-11-04（Asia/Shanghai）。

## 安装发现

| 来源 | 激活证据 | 歧义与失效处理 |
| --- | --- | --- |
| 本地市场 | 宿主 `CODEX_HOME/config.toml` 的用户启用配置，加上明确的 `local` 缓存槽或本地市场源清单标定的精确版本 | 版本证据冲突时不激活。其他缓存版本保留诊断 |
| 远程安装 | 安装记录中的远程插件标识，唯一版本目录，名称与版本匹配的 manifest，以及 SHA-256 完整性索引 | 标记缺失、版本歧义、完整性记录缺失或不匹配时报告原因 |
| Remote / WSL | 使用运行 KeepSeek 的扩展宿主的 home 或绝对 `CODEX_HOME` | 仅搜索该宿主可见的安装。工作区不可信时停用插件发现和读取 |

本机 Codex Desktop 为 `0.166.0-alpha.6`，另装 CLI `0.133.0`。只读探测确认 Product Design `0.1.56`、Sites `1.1.3` 为远程安装，Browser `26.1029.61003` 及其他本地市场安装由市场清单标定版本。发现适配层确认 10 个声明 Skills 目录的安装包，其中 8 个有可列出的条目。Browser 与 Computer Use 的当前安装中，声明的 Skills 目录为空。另有 6 个声明 Skills 目录的远程包缺少本实现要求的完整性索引，保留诊断。远程标记本身只有安装身份，不能单独确定版本。

本地 `local` 槽的依据见 [OpenAI 插件打包文档](https://developers.openai.com/plugins/build/plugins)。远程版本切换的实现旁证见 [Codex 插件缓存源码](https://github.com/openai/codex/blob/main/codex-rs/core-plugins/src/store.rs)。

## 操作、任务范围和读取边界

- 在 `/` → Skills 或输入框 `$` 选择插件 Skill。条目显示包名、版本、市场、安装来源和能力状态。打开入口时显示只读预览。插件只为当前任务选用，无工作区默认和关键词隐式激活。
- 可以直接输入 `$product-design:index`，也可以粘贴 `[$product-design:index](/绝对路径/SKILL.md)`。同名时可在菜单用来源区分。链接须匹配当前目录项和限定名称。菜单选项携带安装与入口指纹，同路径的 `local` 槽更新后也会要求重新选择。代码围栏、行内代码、Markdown 引用和单独路径不构成选择。
- 初次交付入口与少量直接引用的公共文本。V12 的 `keepseek_read_plugin_skill` 可以查看已链接文本，或检查并路由到同包已发现且启用的兄弟 Skill。`read` 是说明查看，`route` 返回该工作流的能力状态和执行许可。缺少必需能力时，路由结果带具体阻塞。
- 每个任务最多选择四个插件入口。每个入口最多固定 256 份文本，单文件最多 64 KiB 且服从 KeepSeek 单文件设置，首轮公共引用最多 3 份、共 16 KiB，每个入口在整项任务中最多读取 24 次、共 256 KiB，路径图最多 6 层。真实路径与文件身份复核，远程内容核对索引哈希。脚本、hooks、状态、凭据文件、符号链接和越界引用不进入此读取面。
- 版本和读取进度随逻辑任务固定。工具结果走 intent、evidence、envelope 和分页。已交付的历史字节通过已保存请求和 evidence 复用。安装、信任或禁用策略失效时，后续读取和请求派发停止，并提示刷新。插件选择不会向通用文件工具、子代理、命令 cwd 或写入增加授权。
- 静态提示词及 V1–V11 的工具列表和顺序保持原字节。V12 在新会话或既有的协议切换边界提供读取工具。热旧会话仍可读取显式入口，工作流能力状态会反映路由工具是否可用。当前任务入口放在真实用户消息的已持久化尾部。

## Product Design 现场检查与能力差距

已用本机真实安装包和编译后的 KeepSeek 代码复核 `index`、`communication-protocol.md`、`critical-overrides.md`，并用真实相对链接定位 `../user-context/SKILL.md`。入口 SHA-256 为 `8e9916d9e5dc3b6a394bedcaa38cd9c8833a1f3b0c4538b75647cf9f62f779fc`。能力描述绑定到实查版本与分支正文哈希，未核验版本显示待验证。此次检查使用 VS Code API 测试桩，读取了真实安装文件。

| 流程 | 仍缺能力 | 接口选择 | 后续验收条件 |
| --- | --- | --- | --- |
| Audit / Design QA | 浏览器交互、截图及模型视觉输入 | 新增受控浏览器/截图和视觉输入接口 | 用真实截图核对流程，Run Details 可回溯截图与对照 |
| Ideate | 工作流内图像生成、带视觉参考的请求、用户选图 | 评估复用 KeepSeek 独立图像任务的适配器，补充 Agent 交付和显式选图 | 生成真实候选图，收到用户选择后才继续 |
| URL / Image to Code | URL 捕获或源图视觉输入、浏览器对照和脚本前置检查 | 复用现有文件编辑审批，补充截图、视觉与前置检查接口 | 源图或 URL 与实现截图逐项对照，有实际结果可追溯 |
| Share | Sites 或语义等价的部署连接器 | 新增明确部署操作及用户授权 | 部署返回可访问 URL，并通过打开链接核实 |
| User Context | 插件专属持久化和脚本前置检查 | 评估 KeepSeek 独立状态适配层和经审核的前置检查 | 宿主重启后恢复已授权状态，证据可追溯 |
| Research | 实时网页研究及来源检索 | 新增可审计的检索接口 | 使用实查网页、来源和日期完成报告 |

实际只读路由已确认 Audit 返回浏览器截图及视觉输入缺失，Ideate 返回图像生成及用户选图缺失。两者均阻止工作流进入执行模式。

## 验收步骤

### 1. 用临时文本插件验证可执行闭环

在 KeepSeek 仓库先运行 `bun run compile`，然后在独立临时目录创建夹具。

```bash
keepseek_fixture=$(mktemp -d /tmp/keepseek-plugin-field.XXXXXX)
keepseek_home="$keepseek_fixture/codex"
keepseek_pkg="$keepseek_home/plugins/cache/field/field-text/local"
mkdir -p "$keepseek_fixture/project" "$keepseek_pkg/.codex-plugin" \
  "$keepseek_pkg/skills/entry" "$keepseek_pkg/skills/branch" "$keepseek_pkg/references"
printf '%s\n' '[plugins."field-text@field"]' 'enabled = true' > "$keepseek_home/config.toml"
printf '%s\n' '{"name":"field-text","version":"1.0.0","skills":"./skills/"}' > "$keepseek_pkg/.codex-plugin/plugin.json"
cat > "$keepseek_pkg/skills/entry/SKILL.md" <<'SKILL'
---
name: entry
description: Verify the installed text plugin.
---
Read the [marker](../../references/marker.md).
Route to [branch](../branch/SKILL.md) with keepseek_read_plugin_skill.
Report the two markers.
SKILL
cat > "$keepseek_pkg/skills/branch/SKILL.md" <<'SKILL'
---
name: branch
description: Return the fixture branch marker.
---
Report BRANCH_FIELD_342.
SKILL
printf '%s\n' 'ENTRY_FIELD_927' > "$keepseek_pkg/references/marker.md"
```

1. 在项目按 F5 启动 Extension Development Host，确保该进程继承 `CODEX_HOME="$keepseek_home"`。也可用 `CODEX_HOME="$keepseek_home" code --new-window --user-data-dir "$keepseek_fixture/vscode-profile" --extensionDevelopmentPath="$PWD" "$keepseek_fixture/project"` 启动。信任临时工作区，在 KeepSeek 中配置一个具备函数调用能力的测试模型并新建会话。
2. 用 Skills 菜单选 `field-text:entry`，发送“执行文本夹具并返回两个标记”。在 Run Details 核对安装版本、入口 URI、`keepseek_read_plugin_skill` 的分支路径和哈希。模型应返回 `ENTRY_FIELD_927` 和 `BRANCH_FIELD_342`。再用手输名称、粘贴绝对 Markdown 链接及编辑重发重复。代码围栏中的同一链接应保持普通文本。
3. 保留菜单插入的草稿，改夹具 manifest 版本为 `1.0.1` 后空闲刷新。原菜单引用应提示过期，新选择显示 `1.0.1`。将夹具 `enabled` 改为 `false` 或把夹具包移出 cache，刷新后应显示诊断。对暂停任务复核 Continue 不会自动读入另一个版本。还原夹具后新任务应重新发现可用项。
4. 在临时项目添加一个 `.agents/skills/<name>/SKILL.md`，确认插件卸载或禁用后普通 Skill 仍可选择与运行。切换工作区信任，核对插件选择和读取同时受限。

### 2. 用真实 Product Design 验证复杂包

1. 使用当前真实安装所在的 `CODEX_HOME` 启动开发宿主。新建 KeepSeek 会话，从菜单打开 Product Design 的只读入口。核对真实市场、版本、文件位置和能力。已知验收样本为 `[$product-design:index](/Users/kermit/.codex/plugins/cache/openai-curated-remote/product-design/0.1.56/skills/index/SKILL.md)`，若安装版本不同，从目录中选择当前入口。
2. 发送“用这个入口选择 Audit，对已有页面进行截图审核。先报告实际工具是否可用”。在 Run Details 找到插件读取工具、`skills/audit/SKILL.md`、版本及 `workflow_blocked`。结果应明确缺少浏览器截图和视觉输入。
3. 另起任务发送“用这个入口选择 Ideate，生成并供我选择设计图”。核对 `skills/ideate/SKILL.md` 的 `workflow_blocked` 和缺失的图像生成、选图。两项均以工具结果为证据。可用只读模式查看 `user-context`，避免执行其初始化或更改真实安装。

## 改动与验证记录

| 范围 | 文件 |
| --- | --- |
| 安装识别、菜单目录、固定资源和能力 | `src/skills/codexPluginDiscovery.ts`、`codexPluginResources.ts`、`codexPluginCapabilities.ts`、`skillDiscovery.ts`、`skillTypes.ts`、`skillStore.ts`、`skillLoader.ts`、`skillActivationResolver.ts` |
| 用户输入、显示、只读预览 | `src/context/references/skillReference.ts`、`src/provider/KeepseekChatViewProvider.ts`、`src/webview/input/`、`src/webview/script.ts`、`src/shared/i18n.ts` |
| 任务快照、工具、权限、证据、回放 | `src/agent/pluginSkillRuntime.ts`、`protocol.ts`、`providerRequestProjection.ts`、`runner.ts`、`runCheckpoint.ts`、`evidence/`、`tools/toolAuthorization.ts`、`logging/runDetails.ts`、`subagents/contextCapsule.ts`、`currentRunContext.ts`、`historyArchive.ts`、`src/sessions/chatSessionStore.ts`、`src/shared/types.ts` |
| 回归 | `test/codexPluginDiscovery.test.ts`、`codexPluginResources.test.ts`、`skillReference.test.ts`、`p1ProtocolDelivery.test.ts`、`interactionTrace.test.ts`、`contextEntryPoints.test.ts`、`inputComposition.test.ts` |

| 验证层级 | 结果 |
| --- | --- |
| 源码与真实文件只读探测 | 本地市场及远程安装通过，真实 Product Design 入口、公共引用、路由与阻塞通过 |
| 自动化 | `bun run compile`、`bun run lint`、`bun run build:test` 和 `git diff --check` 均通过。`bun run test` 共 916 项，915 通过、0 失败、1 跳过，约 179 秒 |
| VS Code Webview | 受阻。VS Code 1.144.1 在隔离配置启动时报告 Electron `task_name_for_pid` 错误。直接启动退出 134，无扩展宿主日志 |
| 真实模型 | 未执行。三种协议的 KeepSeek 请求、工具轮、版本与恢复使用真实请求代码和夹具响应验证 |
| Windows、Remote、WSL 实机 | 未验证 |

跳过项为既有的本地故障服务器测试，当前沙箱禁止绑定监听端口。F5 夹具准备脚本已实际运行并验证输出结构。
