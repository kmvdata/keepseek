# KeepSeek Webview 布局

## 横向空间

VS Code Webview 的宿主默认样式包含 `body { margin: 0; padding: 0 20px; }`。只清除 margin 或将 KeepSeek 自己的 gutter 设为零，仍会损失左右各 20px。生产样式必须显式清除 html/body 的 margin 和 padding；不要用负 margin、100vw 外壳或全局隐藏横向溢出来抵消。

`src/webview/styles.ts` 是根样式与 gutter 的权威：

- `--keepseek-edge-padding` 默认 6px，视口不超过 360px 时为 4px；double 值从该变量派生。
- header、transcript、context bar、background region 和 composer 各自只消费一次 gutter。transcript 内的卡片不再叠加横向 margin。
- composer 的 `.composer-input-wrap` 已经位于 gutter 内，command/reference menu 相对此节点左右定位为 0。
- 历史菜单相对 `.shell` 使用同一左右 gutter，不设固定宽度上限；随面板铺满可用宽度，并与输入卡片左右边缘对齐。
- 视口不超过 600px 时，长 user 消息与编辑重发框可使用完整正文列；短消息仍右对齐。助手消息始终可使用完整正文列。
- modal 的视口安全边界独立使用 `--keepseek-overlay-inset-double: 12px`，不会随窄屏正文 gutter 变化。
- 按钮点击尺寸、内部可读性留白、键盘焦点和 DOM/消息契约保持原有语义。长代码、表格在自身容器内滚动。

在不计滚动条的 600px Webview 中，正文预期由 560px 增至 588px；320px 时由 280px 增至 312px。原生滚动条宽度须在测量时单列，不计为重复 gutter。

## 纵向空间

纵向尺寸与横向 gutter 分开管理；变窄到 360px 以下时只收紧左右边界，不再连带改变 composer 底部距离。空闲界面的高度由内容自然撑开，不为输入卡片设置固定高度。

| 区域 | 尺寸契约 |
| --- | --- |
| KeepSeek Webview header | 最小高度 30px，上下 padding 各 2px；内部图标按钮保持 24px。这不控制 VS Code 原生容器标题栏 |
| transcript | 顶部 padding 2px、底部 padding 4px；左右继续使用正文 gutter |
| 相邻消息 | 间距 8px；最后一条不追加尾部 margin。消息正文内部的段落、代码和卡片排版不随之整体压缩 |
| composer 外部 | 顶部 padding 0、底部 padding 2px；左右继续使用正文 gutter，底部值不从横向 gutter 推导 |
| composer 输入区 | 最小高度 44px，最大高度仍为 200px；多行文本自动增高，超出后在输入区内部滚动 |
| composer 工具栏 | 最小高度 30px；引用、命令、执行方式、发送/停止按钮保持 26×26px |
| 空态输入卡片 | 无 Skills 条、模型切换状态行和其他附加内容时，由 44px 输入区、30px 工具栏及上下各 1px 边框自然形成约 76px 高度；不是固定高度或额外的父级最小高度 |
| 设置与历史菜单 | 顶部位置为 Webview header 高度 + 2px；不能保留与旧 header 无关的固定 top 值 |
| 命令菜单 | 底部位置为 composer 工具栏高度 + 4px；引用菜单仍在输入卡片上方 6px，两者的纵向锚点不同 |

收紧的对象是外部 padding、重复高度约束与消息之间的空白；字号、行高、输入上限和按钮点击范围保持原值。Skills 条、模型切换提示、引用胶囊及多行草稿出现时，卡片必须自然增高，不能用固定高度或裁切换取紧凑效果。

## 默认右侧容器

`package.json` 仅向 `viewsContainers.secondarySidebar` 贡献 KeepSeek，保留 container `keepseek-sidebar` 和 view `keepseek.chat`。`src/provider/focusView.ts` 仍先打开容器再聚焦 view；命令、文件引用和状态栏入口共用此路径。不新增 Provider，也不增加自动展开、历史恢复或模型请求。

最低 VS Code 提高到 `^1.106.0`，因为该版本起 Secondary Side Bar contribution 正式稳定。参见 [1.106 发布说明](https://code.visualstudio.com/updates/v1_106#_view-containers-in-secondary-side-bar)。

新安装及无位置自定义记录的用户采用新默认位置。VS Code 会记住用户手动移动的位置；已有自定义布局可能覆盖新默认。需要归位时，只针对 KeepSeek 使用原生 Move To / Reset Location，不重置其他视图，不修改 VS Code 状态数据库。Secondary Side Bar 始终位于 Primary Side Bar 对侧；通常主侧栏在左，因此 KeepSeek 位于右侧。参见 [VS Code 布局说明](https://code.visualstudio.com/docs/configure/custom-layout#_secondary-side-bar)。

## 验证

默认执行 `bun run compile`、`bun run lint`、`bun run build:test && bun run test`。`contextEntryPoints` 验证单个 Secondary 容器、没有 Activity Bar 贡献及打开后聚焦的顺序。

真实布局使用 `node scripts/verify-webview-layout.cjs` 生成临时浏览器 fixture。fixture 使用完整生产 HTML/CSS/脚本、注入宿主默认 20px padding、提供无副作用 Host，避免普通网页遗漏宿主样式。打开输出地址并运行 matrix，检查根 padding、单层 gutter、窄屏消息/编辑、菜单边界、局部滚动、对话框、点击尺寸与焦点。缩放预览通过缩小 iframe 的真实 CSS 视口再放大外层表面模拟，不对内部 html 设置 CSS zoom，以免 vw/vh 和媒体查询产生假失败；此模拟仍不能代替原生 VS Code 缩放验收。模拟 DOM 的固定尺寸不能代替浏览器几何测量。

原生验收：

1. 用空白 VS Code profile 加载开发扩展，确认左侧 Activity Bar 没有 KeepSeek 默认入口，Secondary Side Bar 有 KeepSeek 标签。
2. 隐藏右侧后运行 `KeepSeek: Open Chat`；确认右侧显示并聚焦，首次仍为空白就绪界面。
3. 将面板拖到 320/380/480/600px，检查标题、正文和输入框对齐；以 100%/125%/150% 缩放、中英文、深浅主题复核。
4. 检查输入、拖拽、@、斜杠菜单、历史、账号设置、编辑重发、Apply/Discard 及焦点描边；菜单不被裁切，整页不出现横向滚动。
5. 在有手动位置记录的 profile 中确认保留自定义位置，可通过原生操作单次归位，其他视图不移动。
6. 空白草稿时量取 Webview header、输入卡片和底部留白；依次输入一行、多行和超过 200px 的草稿，再显示 Skills 条与模型切换提示，确认卡片自然增高、长输入内部滚动且工具栏完整可用。
7. 打开设置、历史与命令菜单，确认前两者紧接 header 下方，命令菜单位于工具栏上方；窄面板和缩放后均无裁切。检查多条相邻消息的间距，不以首尾 padding 代替消息间距验收。

浏览器 fixture 只证明生产 Webview 的渲染与合成 Host 交互；真实扩展安装、原生容器和真实模型请求须分别记录，不能由 fixture 推定。

## 2026-11-10 横向空间与默认容器验证记录

本节记录横向布局与默认容器调整当时的证据，不自动覆盖后续纵向尺寸修改。

| 检查 | 结果 |
| --- | --- |
| `bun run compile` | 通过 |
| `bun run lint` | 通过 |
| `bun run build:test` | 通过 |
| `bun run test` | 1334 项：1333 通过、1 跳过、0 失败；约 553 秒。跳过项为需要绑定本地故障服务器的网络测试，受当前沙箱限制 |
| 输入拼装字节基线 | 有意更新 CSS hash；脚本与模板原有 hash 断言通过 |
| `git diff --check`、本文与导航的本地链接 | 通过 |
| 浏览器 fixture | 语法检查与生成通过；72 组合未运行 |

在本机 VS Code 1.145.2 的现有 Extension Development Host 重新加载构建后，通过原生界面观察到：

- 标题、助手正文与输入框的横向留白明显收紧；拖窄右侧面板后仍对齐，没有可见的整页横向滚动。
- 斜杠菜单和引用菜单与输入框左右边界对齐；窄面板的设置菜单、账号管理弹层可正常打开并取消。
- 窄面板的编辑重发框占满正文列；打开后取消，没有发送或修改历史消息。
- 粘贴临时草稿后发送按钮可用；草稿已清空，没有调用模型。
- 隐藏辅助侧栏后执行 `KeepSeek: Open Chat`，原来的右侧 KeepSeek 视图重新显示。检查结束恢复面板原有宽度。

以上是现有开发窗口的界面观察，未测量精确 CSS 像素，未执行新 profile 安装或 Windows/Linux 原生验收。自动浏览器矩阵尚未执行：内置浏览器拒绝本地 file URL，当前 shell 也不允许绑定本地 HTTP 端口。脚本已通过语法检查并成功生成 fixture，不能将此记作 72 组合通过。

## 2026-11-10 纵向紧凑调整验证记录

本轮采用上文的纵向尺寸契约。验证结果须在实际执行后追加；前一节的通过记录属于横向调整，不能作为本轮验证结论。

| 检查 | 本轮状态 |
| --- | --- |
| `bun run compile`、`bun run lint`、`bun run build:test` | 通过 |
| `bun run test` 完整回归 | 1334 项：1333 通过、1 项受本地端口限制跳过、0 失败；约 540 秒。此轮在下述尾 margin 收尾补丁前执行 |
| 尾 margin 补丁后的相关回归 | 重新通过 compile、lint、build:test；输入拼装、入口、标题、导航、计时、Apply、DraftRun 批次、启动性能共 175 项通过、0 失败 |
| header、transcript、消息间距、composer 与菜单几何矩阵 | 已扩展生产 HTML fixture；语法检查与生成通过，72 组合未执行 |
| 原生 VS Code 空态、单行、多行输入 | 已观察输入框收紧、单行可发送、长输入自然增高并局部滚动，清空立即缩回 |
| 原生 VS Code 窄面板、放大与菜单焦点 | 已检查窄面板及一级放大，设置/历史/@/斜杠菜单与焦点正常；检查后恢复缩放与面板宽度 |
| Skills/model 切换提示行 | 保留自然撑高规则；本轮未在原生窗口触发这些状态 |
| 脚本与模板输出字节 | getScript/getTemplate/getInputScript/getInputTemplate 的 hash 保持；仅有意更新输入 CSS 基线 |

本轮在现有 Extension Development Host 重载生产构建后执行原生检查：输入临时单行及 35 行文字，滚动至末端继续编辑，再清空；同时检查长输入时的命令菜单、紧凑输入时的引用菜单，以及标题栏的设置/历史菜单。输入均未发送，没有调用模型或改动历史；最终草稿已清空。上述为原生界面观察，未测量精确 CSS 像素，也不代表完整缩放矩阵、其他平台或附加状态行已验收。浏览器矩阵仍受前述本地访问限制，不能将脚本生成记作矩阵通过。

收尾审查另外修正了尾部空白：transcript 总会保留隐藏的 `#unlinkedChangeSetRegion`，因此最后一条消息未必满足 `:last-child`。新增精确的相邻隐藏区域条件，清除这时的消息尾 margin，让无审批卡时的正文尾部只剩 4px padding；审批区域可见或后面还有其他卡片时仍保留消息间距。脚本和模板字节不变。此纯 CSS 补丁后的原生重验未完成：重载后当前可见窗口切回主工程窗口，未继续干扰该窗口；未将其记为原生通过。

相关回归单独运行时须与默认 runner 一样预加载 VS Code stub：`node --require ./out-test/test/registerVscodeStub.js --test ...`；未预加载时 Apply/DraftRun 测试会因找不到 `vscode` 模块而不能启动，并非产品断言失败。
