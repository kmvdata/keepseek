# Webview UI 层归属与字节基线

本文件定义 KeepSeek 中「用户能看到的文本、样式、布局」的唯一归属层，作为迁移与守卫测试的判定依据。
源码与契约测试仍是最终权威；本文件只登记归属决定和迁移约束。

## 1. 分层与判定规则

```text
src/webview/browser/   注入 Webview 的 HTML 模板 / CSS / 浏览器脚本字符串（含现有 src/webview/input/）
src/webview/host/      VS Code 原生 UI 适配：状态栏、原生 modal 文案、QuickPick 项、Progress 包装、视图聚焦
src/shared/            跨层数据契约与模型可见文本；不再新增 UI 呈现代码
```

归属判定按下列顺序，命中即归 `src/webview/`：

1. 字符串里出现 HTML 标签、CSS 选择器或 `class`/`data-*` 属性名。
2. 字符串里出现 codicon 记号 `$(name)`。
3. 代码在 `webview.postMessage` / `postToWebview` 路径上组装可见内容。
4. 代码为 `vscode.window.show*`、`withProgress`、`createStatusBarItem`、`showQuickPick` 组装用户可见文案或选项。

不属于上述情形的一律留在原层，特别是：纯数据形状、授权与风险分级、`actionHash`/`specHash`、一次性 permit、
`externalEffectGrants`、持久化字段、模型请求字节相关的格式化。

**只搬字符串，不搬决策。** 所有 `vscode.window.show*` / `withProgress` 的调用点、`await` 与 `try/catch` 边界、
决策分支都留在原模块；`host/` 只导出纯函数（输入参数 → 文案/选项对象），不持有跨调用可变状态，不吞异常。

## 2. 字节不变式

以下输出在迁移前后必须 `sha256` 完全一致，任何一步不等即回退该步：

| 入口 | 冻结来源 |
| --- | --- |
| `getScript()` | 根级 script 字节（含 `JSON.stringify(WEBVIEW_TRANSLATIONS)` 内联文案） |
| `getStyles()` | 根级样式字节 |
| `getTemplate(extensionInfo)` | 根级模板字节 |
| `getInputScript()` | `test/inputComposition.test.ts` 冻结值 `eb823fdf…f25117f` |
| `getInputStyles()` | `test/inputComposition.test.ts` 冻结值 `6868e318…90e8604` |
| `getInputTemplate()` | `test/inputComposition.test.ts` 冻结值 `4ae8bf2c…4b53b1311` |
| `getHtmlForWebview()`（nonce 与 `asWebviewUri` 归一化后） | 组装顺序不得变化 |

复算入口：先 `bun run build:test`，再 `node scripts/verify-ui-layer.cjs`。脚本同时列出 `src/webview/**` 之外
出现 UI 呈现指示符的文件，用于核对本文件的归属表是否漏项。

## 3. 根级插值点（段边界契约）

根级三个入口都是「宿主字符串 + 插值点」的混合体，插值点把内容切成段。迁移后必须保留同样的段边界与段内顺序：

```text
src/webview/script.ts
  段 1   行 1..457      state 初始化、i18n/context 辅助函数（含 JSON.stringify 内联）
  插值   行 458         ${getRichTextShortcutsScript()}
  段 2   行 459..1336   DOM 常量、消息处理、render 主流程
  插值   行 1337        ${getInputScript()}
  插值   行 1338        ${getNewAccountDialogScript()}
  段 3   行 1339..7963  handleKeepseekHostMessage、renderTranscript、markdown、末尾 requestAnimationFrame

src/webview/styles.ts
  段 1   行 1..190      含 .draft-run-batch 补丁（排在 :root 之前）与 :root/基础样式
  插值   行 191         ${getInputStyles()}
  段 3   行 192..2193   .settings-model-default-slot 及其余规则

src/webview/template.ts
  段 1   行 1..157      header / settingsMenu / sessionMenu / contextBar / background / transcript / plan
  插值   行 158         ${getInputTemplate()}
  段 3   行 159         </main> 收尾
```

所有根级 fragment 仍拼接进同一个 IIFE：不得出现重复的顶层 `var`/`let`/`const`/`function` 声明，
`test/webviewDomHarness.ts` 会在 `node:vm` 中真实执行 `getScript()`。

## 4. 归属清单

### 4.1 迁移到 `src/webview/host/`

| 现状 | 内容 | 迁移边界 |
| --- | --- | --- |
| `src/provider/backgroundRunStatusBar.ts` | `BackgroundRunStatusBar`、codicon 映射、状态栏文本与 tooltip | 整体迁移；`getBackgroundRunStatusIcon(status)` 抽成纯函数供单测 |
| `src/provider/focusView.ts` | `focusView(containerId, viewType)` | 整体迁移，行为不变 |
| `src/agent/tools/toolAuthorization.ts` 行 227–337 | `getHighRiskToolConfirmationPrompt`、`getMediumRiskPrompt`、`formatHighRiskArgument` | 只迁文案函数；`authorize()`、`createDecision()`、风险分级、`createAuthorizationDeniedToolResult()` 留在原文件，并 re-export 保持既有 import 路径 |
| `src/provider/KeepseekChatViewProvider.ts` 行 1887 / 4506 | 外部范围授权 `approvalExternalPrompt` detail 组装 | 只抽字符串组装；`showWarningMessage`、`externalEffectGrants` 写入、授权判定留在原处 |
| 同上 行 2100–2124 | 批量 ChangeSet 删除确认与失败汇总 | 同上；`showChangeSetFailures` / `confirmDeleteApply` 的调用与 `await` 留在原处 |
| 同上 行 2722–2724 / 2823–2825 | 批量删除会话确认 | 同上 |
| 同上 行 2868–2870 | 删除整个工作区会话确认 | 同上 |
| 同上 行 8810 | `draftDependencyLabel()` | 纯呈现标签，整体迁入 `host/drafts/labels.ts` |
| 同上 其余 `show*Message` 文案 | `this.t(key, values)` 组装的大量通知文本 | 按阶段逐步收敛到 `host/notifications.ts`；本阶段只登记，不批量改动 |
| `src/context/fileContextStore.ts` 行 107 | `showQuickPick` 的 items 与 options 组装 | 只抽 items/options 构造；`findFiles`、`addUri`、`await` 留在原处 |
| `src/context/references/fileReferenceOpener.ts` 行 56 | `cannotOpenFileReference` 提示 | 只抽文案；`try/catch` 与打开语义留在原处 |
| `src/edits/draftEditStore.ts` 行 51 / 78 | 应用失败的错误提示 | 只抽文案；`applyDraftEdit` 与持久化顺序留在原处 |
| `src/sessions/sessionObjectStore.ts` 行 334 | `withProgress` 的 `location`/`title` 常量 | 只抽 Progress 选项；`saveGraph` 与迁移判定留在原处 |
| `src/shared/i18n.ts` 的 `WEBVIEW_TRANSLATIONS` | 直接 `JSON.stringify` 进 script 字节的 UI 文案 | 迁到 `src/webview/i18n.ts`，保持 key 顺序与字符串逐字节不变，`shared/i18n.ts` re-export |

### 4.2 明确保留在原处

| 现状 | 保留理由 |
| --- | --- |
| `package.json` 的 `contributes`（views / menus / keybindings / commands 的 icon 与 title）、根 `icon` | VS Code 清单契约，改动即改变扩展注册与打包内容 |
| `resources/*.svg` / `*.png` | 受 `extensionUri` 拼接、CSP `img-src` 与 VSIX 打包路径约束 |
| `src/shared/types.ts`、`src/shared/config.ts` | 跨层数据契约，`config.ts` 对应 `package.json` 配置 schema |
| `src/shared/i18n.ts` 的 `localize()` 及进入系统提示、会话标题、请求字节的文案 | 参与模型请求与持久化字节，不是纯呈现 |
| `src/shared/format.ts` 的 `formatLocalTimestamp()` | 参与请求/日志时间语义 |
| `src/shared/format.ts` 的 `formatBytes()` | 宿主侧唯一实现，被 `selectedTextTooLarge` 等提示使用；浏览器侧另有一份必需副本（见 4.3） |
| `src/shared/markdown.ts` | `getMarkdownFence()` / `getMarkdownLanguage()` 被 `agent/protocol.ts` 用于把上下文文件包进模型可见 markdown，属请求字节契约 |
| `src/provider/interactionState.ts` 的 `InteractionCoordinator` / `deriveInteractionState` / `deriveSessionTitleCapability` | AGENTS.md 指定的唯一派生权威；拆分会产生第二套判定源 |
| `src/provider/webviewMessages.ts`、`modelSelection.ts`、`requestTimeoutSettings.ts` | Webview→Host 消息联合类型与选择/配置契约，不是呈现 |
| `src/webview/richTextShortcuts.ts` | 已在 `src/webview/` 之下，满足归属目标；不移动可避免改动 AGENTS.md §3.5 原文与 29KB 正文搬运的字节风险 |
| `src/agent/protocol.ts:518-519` 对 markdown 辅助函数的调用语义 | 请求字节一部分，可 re-export 但不得改输出 |

### 4.3 已知的受控重复

`formatBytes()` 在宿主侧（`src/shared/format.ts`）与浏览器侧（script 内联实现）各有一份。浏览器脚本是注入的
字符串，无法 `import` 宿主模块，也不允许为它新增 `window.*` 全局，因此两份实现是必需的。约束：两份输出必须
完全一致（`B` / `KB` / `MB`，一位小数），由测试对同一批取样值断言相等。

### 4.4 决策记录：快捷键只由清单贡献

0.5.2 是全新数据基线。`src/keybindings.ts` 及激活时写用户 `keybindings.json` 的旧迁移已删除；
当前默认快捷键仅取 `package.json` 的 `contributes.keybindings`。离线重置脚本只移除 KeepSeek 历史快捷键，
不在启动时扫描或改写用户快捷键文件。

### 4.5 明确不做

- 不引入 UI 框架、构建步骤或模板引擎，保持模板字符串 + `WebviewFragment` 形态。
- 不改变 HTML 结构、DOM id、class 名、`data-*` 属性、CSS 选择器名、i18n key 名。
- 不重排 `.draft-run-batch` 补丁与 `:root` 的层叠顺序（该顺序是当前真实层叠位置，前移或后移都会改变字节）。
- 不改审批策略、运行行为、依赖版本与版本号。

## 5. 守卫测试引用

`test/webviewUiOwnership.test.ts` 以第 4.2 节为显式 allowlist：`src/webview/**` 之外出现 HTML 标签、CSS 规则块、
`$(codicon)` 或 `class=` 字面量即失败，保留项必须在此登记。
