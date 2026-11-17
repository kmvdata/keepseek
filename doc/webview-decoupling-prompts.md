# KeepSeek Webview 解耦提示词包（P0–P5，已按当前仓库核实重写）

> 这是一份**可直接复制到全新 AI session** 的提示词包。六个提示词彼此独立、自包含，含背景事实、硬约束、验收命令、交付格式。
>
> 与上一版相比，本版基于**实测**消掉了 9 处会导致会话返工的错误假设（见文末「本次核实修正清单」），并补上了仓库当前已有的等价护栏，避免重复造轮子。

---

## 0. 使用约定（每次新会话前必读）

1. **必须串行执行**：P0 → P1 → P2 → P3 → P4 → P5。不可并行、不可跨批续做。每个会话独立，不共享上下文。
2. 每个会话开始前先 `git status` 确认工作树干净；若某会话中途失败，**回滚该批次全部改动后再重开**，不要在其上半途续做（切片顺序契约会错乱）。
3. 每个会话结束时执行 `git add -A && git commit -m "P<N>: <概括>"`，只做本地提交，**禁止 push、禁止 rebase/reset --hard/checkout --**。
4. **`resources/` 与 `images/` 是最高保护级目录**：禁止删除、改名、移动、覆盖其中任何文件（含 `.DS_Store`、`keepseek.png`）；禁止修改 [html.ts](../src/webview/html.ts) 里 `resources/*.svg` 的拼接逻辑；禁止修改 [verify-vsix.js](../scripts/verify-vsix.js) 里遍历 `resources/` 的逻辑。任何批次都没有正当理由触碰它们。
5. 临时脚本/探针/输出只写系统临时目录或已忽略的 `out-test/`，不得在仓库建 `.tmp-*`。
6. 不引入新依赖、不引入打包器（没有 esbuild/vite），不拆成多个 `<script>`，不引入 ESM。

### 0.1 本机执行注意（实测）

- 仓库可能位于 **UNC 网络路径**（如 `\\192.168.0.115\...`）。此时 `bun run <script>` 无法解析 `node_modules/.bin`，报 `bun: command not found: tsc`。等价的可靠写法：
  ```bash
  node node_modules/typescript/bin/tsc -p tsconfig.json      # = bun run compile
  node node_modules/typescript/bin/tsc -p tsconfig.test.json # = bun run build:test
  node out-test/test/runTests.js                             # = bun run test
  node node_modules/eslint/bin/eslint.js src/                # = bun run lint
  ```
  用 `bun run ...` 能跑通就用它；跑不通就用上面等价命令，并在交付里说明用的是哪一种。
- `bun run test` **会在 `draftRunBatch.test.ts` 的两个用例处挂死**（进程 CPU 归零、无输出）。这是本机环境既有问题（UNC 路径上临时目录/文件系统行为导致），与 Webview 重构无关。所以：
  - 跑测试时**不要用管道**（`| Select-Object -Last N` 会缓冲到进程退出，挂死时拿不到任何输出）。
  - 用文件重定向 + 后台进程，然后轮询文件大小判断是否跑完：
    ```bash
    node out-test/test/runTests.js > /tmp/keepseek-test-<batch>.log 2>&1 &
    ```
    （Windows PowerShell：`Start-Process node -ArgumentList 'out-test/test/runTests.js' -RedirectStandardOutput $log -RedirectStandardError $err -PassThru -NoNewWindow`）
  - TAP 报告更可靠：`node --test-reporter=tap out-test/test/runTests.js > log`，失败项以 `^not ok` 开头、子测试名以 `# Subtest:` 开头，可用它统计通过/失败数，并据最后一个 `# Subtest:` 判断卡在哪个用例。
- **开工前先记录一份「环境既有失败清单」**：跑一次全量测试（或 TAP），把与本批次无关的失败（已知：`behaviorEvaluation` 的 live acceptance 子进程在 UNC 上失败、`changeSet` 的两条 Windows 路径断言、`draftRunQueryIntegration` 的 git config 检查、`draftRunStore` 的 revoked-click 断言）记下来。交付时只需证明**没有新增失败**，不要为了凑绿去改这些断言。

---

## P0 — 建立护栏与基线（无功能改动）

```text
你是一位资深 VS Code 扩展维护者。仓库：KeepSeek（TypeScript，VS Code 侧边栏 Agent）。当前工作分支干净，先执行 git status 确认。

## 目标
在不改变任何生成产物的前提下，为后续 Webview 解耦重构补齐缺失的测试护栏与基线记录。本批次只新增测试与一处文档，不搬迁生产代码。

## 已核实的背景事实（已按当前仓库核实，直接采信）
- `src/webview/script.ts`（7329 行）导出 `getScript()`，返回一个巨型模板字符串，在 Webview 里作为**单个内联 <script nonce>** 执行（CSP 见 `src/webview/html.ts` 第 27 行）。浏览器侧不能 import，所有 fragment 共享同一个词法作用域。
- `src/webview/script.ts` 顶部已有若干"仍是巨型字符串"的插值：`${getRichTextShortcutsScript()}`（L484）、`${conversationsStateFragment.source}`（L603）、`${conversationsMenuBindingsFragment.source}`（L1225）、`${conversationsMenuDismissFragment.source}`（L1227）、`${getInputScript()}` + `${getNewAccountDialogScript()}`（L1253-1254）、`${conversationsTitleRefreshFragment.source}`（L1663）、`${conversationsSessionListFragment.source}`（L1891）。fragment 源码用 `` `...`.slice(1) `` 去掉开头换行以保持生成字节不变，见 `src/webview/conversations/script/sessionList.ts` 第 665 行。
- `src/webview/styles.ts`（2047 行）导出 `getStyles()`：全局 CSS 字符串，含三处插值——`${getInputStyles()}`（L212）、`${getRichTextContextMenuStyles()}`（L213）、`${conversationsStylesFragment.source}`（L488，独占一行、行首无缩进，同样 `.slice(1)`）。现有分区注释只有三处：第 292 行 `/* ---- header ---- */`、第 490 行 `/* ---- context bar ---- */`、第 1250 行 `/* ---- transcript ---- */`（L69 还有一条 input 间距变量注释）。
- `src/webview/template.ts`（33 行）导出 `getTemplate(extensionInfo?)`，用 `composeWebviewTemplate([...])` 固定顺序拼接；根级模板 fragment 在 `src/webview/template/*.ts`，契约在 `src/webview/template/composition.ts`（`WebviewTemplateFragment`、`composeWebviewTemplate`，重复 id 抛错）。
- fragment 契约定义在 `src/webview/input/composition.ts`：`WebviewFragment { id, source }`、`composeWebviewFragments()`（重复 id 抛错，**只校验 id，不校验标识符**），以及 `INPUT_SCRIPT_FRAGMENTS` / `INPUT_STYLE_FRAGMENTS` / `INPUT_TEMPLATE_FRAGMENTS` 三个固定顺序数组（注释明确"These fragments intentionally share one generated IIFE. The fixed order keeps the shared lexical scope, initialization order, and listener registration order."）。
- 已有 hash 锁：`test/inputComposition.test.ts` 第 342-349 行冻结 `getInputScript()` / `getInputStyles()` / `getInputTemplate()` 的 sha256（当前值分别为 6b6f9f1c…、c5a2b88b…、dc733222…）。`getScript()` / `getStyles()` / `getTemplate()` **没有任何字节锁**——这是本批次要补的护栏之一，但**不要**给它们加固定 hash（样式微调会被误伤），改为补行为级护栏。
- **已存在的等价护栏（不要重复实现）**：
  - `test/inputComposition.test.ts` 第 351-354 行已在检查 `getInputTemplate()` 的 DOM id 唯一性；第 401-402 行已有 `assert.doesNotThrow(() => new Function(getScript()))`。
  - `test/contextEntryPoints.test.ts` 第 1216 行已断言根级模板中 `<section id="transcript">` → `<section id="planRegion">` → `<aside id="unlinkedChangeSetRegion">` 的嵌套顺序；第 1217 行断言 `renderTranscript` 内 `planRegion.remove()` → `unlinkedChangeSetRegion.remove()` → `transcript.append(planRegion)` → `transcript.append(unlinkedChangeSetRegion)` → `renderUnlinkedChangeSets` 的先后顺序；第 1196-1205 行断言 ChangeSet 相关字面量与"不得出现 function renderDraftEdits"。
  - `test/reasoningPanel.test.ts` 第 162-167 行已有 `.reasoning-dots` 等关键样式的顺序/内容断言。
- 测试用精确字符串切片定位生产代码：`test/contextEntryPoints.test.ts` 的 `getGeneratedSection(source, startMarker, endMarker)`（第 1258 行）依赖 4 空格缩进与 `function name(` 形式，例如第 945、976-982、1149 行；`test/reasoningPanel.test.ts` 的 `extractFunction` 用 `    function ${name}(` 定位。
- `test/runTests.ts`（145 行）是显式 import 清单，**新增测试文件必须在此登记**，否则不会执行。
- `tsconfig.json` 的 `rootDir` 为 `src`；`tsconfig.test.json` 的 include 已覆盖 `src/**/*.ts` 与 `test/**/*.ts`。新增目录无需改配置。
- `.vscodeignore` 已排除 `src/**` 与 `test/**`，新增源码不会进入发布包，**不要修改 `.vscodeignore`**。
- 已确认的性能契约：`test/startupPerformance.test.ts` 断言 `getScript()` 中必须出现 `incomingRevision <= lastStateRevision`、`sideEffectsReady`、`syncSendButtonAvailability` 等，且不得出现 `postMessage({ type: 'ready' })`。
- `resources/` 现有 12 项（8 个 `MODEL_SOURCE_PROVIDERS` 图标 + `keepseek.svg` + `plugin.svg` + `keepseek.png` + `.DS_Store`）；`scripts/verify-vsix.js` 会遍历整个目录，把所有 `.svg`/`.png` 当必需打包项。

## 硬约束
1. **绝对禁止删除、改名、移动、覆盖 `resources/` 下任何文件（含 `.DS_Store`、`keepseek.png`），禁止动 `images/`**。不得修改 `src/webview/html.ts` 中 `resources/${provider}.svg` 的拼接，不得修改 `scripts/verify-vsix.js` 遍历 `resources/` 的逻辑。
2. 不得修改任何生产代码（`src/**`）——本批次只加测试与一处文档。
3. 不得放宽、删除、skip 任何既有断言。
4. 所有临时脚本、基线文件、调试输出必须写到**系统临时目录**或已忽略的 `out-test/`，不得在仓库创建 `.tmp-*` 文件。
5. 不得引入新的运行时或开发依赖（没有 esbuild/vite，不要引入打包器）。
6. 生产字节必须零改动；若 `getScript()` 输出与改动前不同，说明你改错了，必须回退。
7. 本机 `bun run test` 会在 `draftRunBatch` 用例处挂死且管道输出被缓冲，务必按「用法 0.1」用文件重定向 + 后台进程 + 轮询跑测试，并先记录环境既有失败清单。

## 具体任务
1. **记录基线（只记录，不入库）**：在系统临时目录写一次性脚本，计算并记录 `getScript()`、`getStyles()`、`getTemplate()` 的长度与 sha256，以及 `getInputScript()` / `getInputStyles()` / `getInputTemplate()` 的 sha256（后三者必须等于 `test/inputComposition.test.ts` 里的常量）。记录起点（本批次开工前，2026-11-17 实测）：script=`b91a43cba68e08a8705723bd71f8b26777ddca7507f77616994c658cd26c42ff`（长度 859920）、styles=`aceac48aed48f654f7cef30dc1fe70cec6e9d9a01b8176747e3bc78a8793675f`（150025）、template=`c2d0b4364548352529f18f3627e9a927bedb5fa71635676d08924a34cc71b5a1`（51671）。若你的起点不同，说明仓库已变化，以你的实测为准并在交付里说明。
2. **新增根级组合契约测试** `test/webviewRootComposition.test.ts`（**与既有断言不重复，只补缺口**）：
   - `getTemplate()` 长度 > 0，且包含 `<section id="transcript"`、`id="unlinkedChangeSetRegion"`、`id="planRegion"`、`id="settingsMenu"`、`id="sessionMenu"`、`id="composer"`。
   - 从 `getTemplate()` 用正则提取全部 DOM id（注意只匹配模板 HTML，不要误伤内联脚本里的字符串），断言**无重复**（针对根级模板；`getInputTemplate()` 已有等价检查）。
   - `assert.doesNotThrow(() => new Function(getTemplate()))` 不适用；真正要验的是 `getStyles()` 长度 > 0 且包含 `.transcript`、`.composer-input-inner`、`.draft-bar`、`.change-set-actions`。
   - 断言 `getScript()` 非空，并且 `new Function(getScript())` 可编译（**这是补 `inputComposition` 已有断言之外的有效性**：在 root 组合层面再确认一次，成本很低）。
3. **新增符号唯一性测试**（放同一文件）：fragment 共用一个词法作用域，`composeWebviewFragments` 只校验 id 不校验标识符，重名会产生静默覆盖或 SyntaxError。
   - 从 `getScript()` 抽取所有**顶层**声明：`/^    function ([A-Za-z_$][\w$]*)\(/gmu` 与 `/^    (?:var|let|const) ([A-Za-z_$][\w$]*)/gmu`（恰好 4 空格缩进的行；IIFE 内部函数体从 6 空格起，天然被排除。不要用 `\s` 匹配缩进——`\s` 会跨行吃到 5/6 空格的行，先实测这一点再定正则）。
   - 断言同一名字不会既以 `function` 又以 `var/let/const` 形式出现在顶层（重复 `function` 声明在 sloppy 模式下是合法的、后一个生效，因此**不是**本测试要拦的对象；真正要拦的是搬迁/拼接造成的同名不同义）。若现状已存在同名，精确冻结当前允许的重复名单并在测试里注释原因，**不要放宽断言**。
   - 断言 `getScript()` 整体能被 `new Function` 编译（重名导致的语法错误由它兜底）。
   - 该测试的价值在**后续批次**：P1–P4 搬迁后它必须继续通过。
4. **新增 CSS 顶层选择器顺序快照测试**（放同一文件）：
   - 从 `getStyles()` 用 `/^\s{4}(\.[a-zA-Z][\w-]*)/gmu` 按出现顺序提取选择器序列，存成数组。
   - 断言关键区域的相对先后稳定，至少覆盖：`.transcript` 在 `.message-code-block` 之前；`.session-menu` 在 `.context-bar` 之前；`.draft-bar` 在 `.change-set-actions` 之前（以实测现状为准，先跑到通过再冻结）。
   - **不要**把整个数组硬编码成快照文件（每次样式微调都要重录）；只断言"相对顺序"这一层。
5. 把新测试文件登记到 `test/runTests.ts`（建议紧跟在 `import './inputComposition.test';` 之后）。
6. 在 `AGENTS.md` **第 5 节「验证与交付」**末尾追加一条（保持现有条目风格，一行）：
   `- 改 Webview fragment/样式：验证 fragment 顺序、顶层标识符唯一、根级 DOM id 唯一、getStyles() 选择器相对顺序，且 new Function(getScript()) 可编译。`

## 验收（必须逐条实际执行并贴出结果）
```bash
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/eslint/bin/eslint.js src/
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node out-test/test/runTests.js   # 用文件重定向 + 后台进程，勿用管道
```
（若 `bun run compile/lint/build:test/test` 在该环境可用，换成 bun 版等价命令并说明。）
要求：全部通过；**新增测试在未改动生产代码的仓库上通过**；与开工前的环境既有失败清单相比**没有新增失败**。

## 交付格式
1. 变更文件列表（新增/修改），每个文件行数。
2. 每条验收命令的真实输出摘要（通过/失败 + 用例计数，注明用的 bun 还是 node 等价命令）。
3. 基线 hash 与长度（说明只作本次会话记录、未入库），并给出开工前后 `getScript()` sha256 必须相等的证据。
4. 你为「符号唯一性」选择的抽取规则与去重策略，以及为什么它能描述现状（贴出被冻结的允许重复名单，如有）。
5. 明确声明：`resources/` 与 `images/` 完全未改动（贴 `git status --porcelain resources images` 的空输出）。
6. 用 `git diff --stat` 证明改动只含：一个新增 test 文件、`test/runTests.ts` 一行 import、`AGENTS.md` 第 5 节一条。
```

---

## P1 — 搬走非 UI 逻辑与纯展示函数

```text
你是一位资深 VS Code 扩展维护者。仓库：KeepSeek（TypeScript）。先 git status 确认工作树干净。

## 目标
把 `src/webview/script.ts` 中**不属于 UI 的纯逻辑**与**零状态纯展示函数**抽成独立 fragment 模块，缩小该文件，同时保持 Webview 生成字节**尽可能**不变（本批次目标是字节完全相同）。

## 已核实的背景事实
- `src/webview/script.ts`（约 7300 行）导出 `getScript()`，返回单个巨型模板字符串，作为 Webview 内唯一内联 `<script>` 执行。所有 fragment 共享同一词法作用域，**不能 import、不能拆多个 <script>**（CSP 只允许 nonce 内联脚本）。
- 已有成功先例（照它的写法做）：`src/webview/conversations/script/sessionList.ts` 用
  ```ts
  import type { WebviewFragment } from '../../input/composition';
  export const conversationsSessionListFragment: WebviewFragment = { id: 'conversations.session-list', source: `\n    function ... {...}`.slice(1) };
  ```
  末尾 `` `.slice(1) `` 去掉开头换行，保证插值位置的行首缩进与原来完全一致。**其他 conversations fragment 结尾没有 `.slice(1)`，插值处也就没有行首缩进**——两种写法在仓库里并存，说明"是否 slice"取决于插值写在哪一行。搬新 fragment 时，请让插值写法与「字节完全相同」目标自洽，并在交付里说明你选的写法。
- `WebviewFragment` 与 `composeWebviewFragments()` 定义在 `src/webview/input/composition.ts`（重复 id 抛错，不校验标识符）。
- 待搬迁对象（行号仅供定位，**请以符号名定位**；均为 `function name(` 形式，当前 4 空格缩进）：
  - 路径/URI 纯计算（约 L7170–L7318，注意**这一段在文件尾部、彼此相邻**，`test/contextEntryPoints.test.ts` 第 945/976/977 行正用 `getGeneratedSection` 从 `function makeMessageFileHref` 切到 `function isLikelyMessageFilePath`、从 `function isMessageWindowsDrivePath` 切到 `function readReferenceInteger`）：`getWorkspaceFolderPaths`(7187)、`isReferencePathInsideRoot`(7176)、`normalizeReferencePathForCompare`(7187 附近)、`getFileReferencePathname`(7192)、`pathToFileUri`(7210)、`encodeFileUriPath`(7226)、`normalizeReferencePath`(7230)、`stripTrailingReferenceSlashes`(7234)、`stripReferenceHash`(7242)、`isAbsoluteReferencePath`(7252)、`getMessageFileName`(7257)、`getMessageDirectoryName`(7263)、`isLikelyMessageFilePath`(7268)、`isSingleSegmentClosingTagPath`(7282)、`isMessageWindowsDrivePath`(7302)、`readReferenceInteger`(7310)、`formatBytes`(7318)
  - 命令展示：`formatShellCommand`(L3593)、`formatShellWord`(L3603)
  - 格式化：`formatExtensionVersion`(L508)、`formatRunTokenCount`(L4556)、`formatDuration`(L4590)、`formatDelegationDetails`(L4597)、`formatDateTime`(L4638)
  - 图标构造：`createReferenceTypeIcon`(L314)、`createSkillReferenceIcon`(L323)、`renderSkillReferenceContent`(L335)，以及 `var fileReferenceIconTemplate`(L308) / `var directoryReferenceIconTemplate`(L311) 两个初始化语句（它们调用 `document.createElement`，属于 DOM，**不要**搬进纯 TS 模块，只能搬进 fragment）
  - 纯数据投影：`buildChangeSetTimelineProjection`(L2873)、`buildDraftRunTimelineProjection`(L2919)
- 关键测试约束（**动之前逐条确认**）：
  - `test/inputComposition.test.ts` 第 342-349 行冻结 `getInputScript()` / `getInputStyles()` / `getInputTemplate()` 的 sha256 —— **这三者输出必须一字节不变**。
  - `test/draftRunBatch.test.ts` 第 628-633 行用 `source.indexOf('    function ' + name + '(')` 到其后第一个 `'\n    function '` 切片，函数名列表在第 618-627 行（44 个），其中包含 `formatShellCommand`、`formatShellWord`、`buildDraftRunTimelineProjection`。**这些函数搬走后必须仍以 `    function name(` 出现在 `getScript()` 里，且从该函数到下一个 `\n    function ` 之间不能掺入非函数声明行**（否则切片会静默多吞内容）。
  - `test/reasoningPanel.test.ts` 第 76-89 行的 `extractFunction` 用 `    function ${name}(` + 花括号配平，比上面更稳。
  - `test/runDetails.test.ts` 第 129-132 行与第 192-194 行：`script.indexOf('    function formatDelegationDetails(')` 切到 `script.indexOf('    function formatDateTime(', start)`。**`formatDelegationDetails` 必须继续紧邻出现在 `formatDateTime` 之前**（中间只允许其他函数的完整声明）。
  - `test/contextEntryPoints.test.ts` 第 945、976-977 行用 `getGeneratedSection(getScript(), 'function makeMessageFileHref', 'function isLikelyMessageFilePath')` 与 `('function isMessageWindowsDrivePath', 'function readReferenceInteger')` 切片（注意这里是**不带缩进的 `function x(`**，所以同一对符号之间的相对顺序不能变）。
  - `test/runDetails.test.ts` 全文**没有** `new Set(ids)` 断言（已核实）；不要为它做任何改动。
- `test/runTests.ts` 是显式 import 清单，新测试文件必须登记。

## 硬约束
1. **绝对禁止删除、改名、移动、覆盖 `resources/` 下任何文件（含 `.DS_Store`、`keepseek.png`），禁止动 `images/`**。不得修改 `src/webview/html.ts` 的 `resources/*.svg` 拼接与 `scripts/verify-vsix.js` 的 `resources` 遍历。
2. **保持 DOM id、CSS 选择器、Webview→Host 消息 type、fragment id 全部不变。**
3. **不改任何交互状态机**：`currentInteraction`、`canSubmitPrompt`、`canNavigateSessions`、`canChangeContext`、`canCancelPrompt`、`beginPromptSubmission`、`applySubmissionResult`、`changeVisibleSession`、`lastStateRevision` 一个字节都不许动。
4. **不重写解析/渲染逻辑**，只做位置搬迁。函数体原字节保留，最多改缩进以适配新容器。
5. 新模块内的辅助函数名要足够特异（例如 `readRefInteger` 而非 `readInteger`），因为所有 fragment 共享同一作用域，`composeWebviewFragments` 只校验 fragment id。P0 的符号唯一性测试必须继续通过。
6. 临时文件只写系统临时目录或 `out-test/`，不在仓库建 `.tmp-*`。
7. 不引入新依赖，不引入打包器。
8. 本机 `bun run test` 会在 `draftRunBatch` 处挂死、管道会被缓冲：按「用法 0.1」用文件重定向 + 后台进程跑测试，并与开工前的既有失败清单对比。

## 纯实现共享方案（必须先选定并说明，禁止双份漂移）

**唯一允许的方案：单一真相在 fragment 字符串里。** 即实现只写一次，写在 fragment 的 `source` 模板字符串中（也就是 Webview 真正执行的那份代码）；TS 侧**不**另外再写一份等价实现。

- 禁止用 `Function.prototype.toString()` 把 TS 函数注入 fragment：闭包、箭头函数、对外部常量的引用都会失效，且会形成"TS 一份、字符串一份"的双份漂移。仓库现有 fragment 也都不这么做。
- 单测方式：像 `test/reasoningPanel.test.ts` 第 76-89 行那样，用 `    function ${name}(` + 花括号配平从 `getScript()` 里切出函数，拼成 `new Script(...)` / `new Function(...)` 执行后断言。这样测的**就是交付字节**，不存在第二份实现。
- 时间线投影 `buildChangeSetTimelineProjection()` / `buildDraftRunTimelineProjection()` 会读 `state`：**不要改签名、不要改成显式传参**——`test/draftRunBatch.test.ts` 第 634-665 行靠 `state` 变量在沙箱 context 里注入，改签名会让它的渲染矩阵失去覆盖。仍按上面的方式搬迁。
- 如果你认为某个函数**确实**更适合做纯 TS 模块（无 DOM、无 `state`、调用点可安全改为显式传参），**必须先停下来在交付里说明**：它会改变 `getScript()` 字节，与"字节完全相同"的验收冲突，需要用户决定；不要自行改签名。

## 具体任务
### 第一部分：fragment 搬迁
新建 `src/webview/transcript/` 目录（后续批次复用）：
- `src/webview/transcript/format.ts` → `WebviewFragment`，id `transcript.format`：`formatExtensionVersion`、`formatRunTokenCount`、`formatDuration`、`formatDelegationDetails`、`formatDateTime`（**`formatDelegationDetails` 必须紧邻在 `formatDateTime` 之前**）、`formatBytes`、`formatShellCommand`、`formatShellWord`。若它们原先不相邻，请把它们**各自留在原插入位置**（即拆成多个 fragment 或用多个插值点），以"函数在 `getScript()` 中的相对顺序完全不变"为最高优先，而不是为了合并成一个文件去移动函数。
- `src/webview/transcript/icons.ts` → id `transcript.icons`：`var fileReferenceIconTemplate` / `var directoryReferenceIconTemplate` 两个初始化语句 + `createReferenceTypeIcon`、`createSkillReferenceIcon`、`renderSkillReferenceContent`（它们调用 `document.createElement`，属于 DOM，只能进 fragment，不能进"纯 TS 模块"）。
- `src/webview/transcript/projection.ts` → id `transcript.projection`：`buildChangeSetTimelineProjection`、`buildDraftRunTimelineProjection`。
- `src/webview/references/script.ts` → id `references.path`：整段路径/URI 函数（L7170–L7318 那一段），顺序原样保留，因为 `test/contextEntryPoints.test.ts` 第 945/976/977 行的 `getGeneratedSection` 依赖 `makeMessageFileHref → isLikelyMessageFilePath`、`isMessageWindowsDrivePath → readReferenceInteger` 这两对相邻关系。

要求：
1. 在 `src/webview/script.ts` 的**原插入位置**用 `${xxxFragment.source}` 替换；**函数声明顺序与原来完全一致**（`var` 提升、`const` TDZ、调用顺序都依赖它）。
2. fragment 内保持 **4 空格缩进 + `function name(`** 形式；fragment 内不得插入任何非函数声明行（注释也会污染 `draftRunBatch` 的切片）。
3. 若某函数搬迁后无人调用，**不要删除**，先保留并在交付中列出。

### 第二部分：测试
新增 `test/webviewTranscriptFragments.test.ts`（登记到 `test/runTests.ts`）：
- 从 `getScript()` 切片取出 `formatShellCommand` / `formatShellWord` / `formatDateTime` / `formatDuration` / `formatBytes` 等，在 `new Function` 里执行并断言若干真实输入输出（例如 `formatBytes(0)`、`formatBytes(1536)`、`formatShellWord('a b')`、`formatDuration(59000)`），任务是从**现状**取值冻结，不是重新设计行为。
- 断言 `getScript()` 中 `formatDelegationDetails` 出现在 `formatDateTime` 之前，且二者相邻（用 `indexOf` 校验区间内只有合法函数声明）。
- 断言 `resources/` 目录条目数量与文件名集合未被本批次改变（读目录即可，不写入）。

## 验收（必须逐条实际执行并贴出结果）
1. 搬迁前后各算一次 `getScript()` 的 sha256（脚本放系统临时目录）。**本批次目标：字节完全相同**。若无法完全相同，逐项列出差异原因（插值处多/少换行等），并确认差异不改变任何 DOM/行为。
2. `getInputScript()` / `getInputStyles()` / `getInputTemplate()` 的 sha256 必须与 `test/inputComposition.test.ts` 第 344-348 行的常量完全一致。
3. 全部通过（本机用等价命令 + 文件重定向 + 后台进程）：
```bash
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/eslint/bin/eslint.js src/
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node out-test/test/runTests.js
```
重点关注这些文件全绿：`applyWorkflow`、`draftRunBatch`、`draftRunBatchDisplay`、`contextEntryPoints`、`reasoningPanel`、`runDetails`、`executionMode`、`startupPerformance`、`markdownRendering`、`inputComposition`、`subagentUsageStats`、`sessionTitleWebview`、`longRunningAgent`。其余失败必须落在开工前的既有失败清单内。

## 交付格式
1. 新增/修改文件清单，每个文件行数。
2. `getScript()` 搬迁前后 sha256 对比与差异逐项说明（含 `.slice(1)` 的选择依据）。
3. 全部验收命令的真实输出摘要（注明 bun 版还是 node 等价命令）。
4. 用 `grep -rn` 证明每个已搬迁函数在仓库里**只有一处实现**（fragment 字符串内），并列出你为此排除了哪些候选做法（例如 `Function.prototype.toString()` 注入）。
5. `git status --porcelain resources images` 空输出，证明两目录未改动。
```

---

## P2 — 抽离 Markdown 渲染子系统

```text
你是一位资深 VS Code 扩展维护者。仓库：KeepSeek（TypeScript）。先 git status 确认工作树干净。

## 目标
把 `src/webview/script.ts` 中的 Markdown 渲染簇抽成 `src/webview/transcript/markdown/` 下的独立 fragment 模块，建立单向依赖，不改渲染行为。

## 已核实的背景事实
- `getScript()` 是单内联脚本字符串，所有 fragment 共享同一词法作用域（一个大 IIFE），**不能 import、不能拆多脚本**（CSP 只允许 nonce 内联）。
- 已有同类先例：`src/webview/conversations/script/*.ts`、`src/webview/input/**` 均以 `WebviewFragment { id, source }` 导出，由 `src/webview/input/composition.ts` 的 `INPUT_SCRIPT_FRAGMENTS` 固定顺序装配；`WebviewFragment` 类型就定义在 `src/webview/input/composition.ts`。
- 待搬迁的 Markdown 渲染函数及其**当前真实行号**（请以符号名为准）：
  - `renderMarkdownContent(container, value, hideExpandedReferences, options)`（L5305）
  - `renderMarkdownBlocks(container, lines, hideExpandedReferences, renderOptions, depth)`（L5317）
  - `appendMarkdownHeading(container, level, text, options)`（L5896）
  - `appendMarkdownParagraph(container, text, options)`（L5902）
  - `appendMarkdownBlockquote(container, text, options)`（L5908）
  - `appendMarkdownList(container, listData, hideExpandedReferences, options, depth)`（L5917）
  - `appendMarkdownTable(container, tableData, options)`（L5929）
  - `splitMarkdownParagraphs(text)`（L5972）
  - `createMarkdownCodeBlock(language, code)`（L5993）
  - `appendMarkdownInline(container, text, options)`（L6033）
  - `appendMarkdownFormattedText(container, text)`（L6066）
  - `repeatCharacter(character, count)`（L6302）
  - `renderMessageContent(container, value, hideExpandedReferences)`（L6310）
- 行为契约由 `test/markdownRendering.test.ts` 守护，并通过 `test/webviewDomHarness.ts`（第 182 行解析 `getTemplate()` 建 DOM，第 204 行 `new Script(getScript())`）真实执行验证 DOM 结构。
- `test/contextEntryPoints.test.ts` 第 1149 行用 `getGeneratedSection(getScript(), 'function applyAgentRunStreamPatch(message)', "window.removeEventListener('message'")` 切片——**注意这个切口跨了很大的区间**；第 945/976-982 行的切片在 Markdown 簇之外。
- `test/runTests.ts` 是显式 import 清单。

## 硬约束
1. **绝对禁止删除、改名、移动、覆盖 `resources/` 下任何文件（含 `.DS_Store`、`keepseek.png`），禁止动 `images/`**。不得修改 `src/webview/html.ts` 的 `resources/*.svg` 拼接与 `scripts/verify-vsix.js` 的 `resources` 遍历。
2. **不修改 Markdown 解析/渲染逻辑**，只做位置搬迁与依赖方向整理。函数体逐字保留（缩进可适配）。
3. 不改变任何 CSS 类名、DOM 结构、`data-*` 属性；`test/markdownRendering.test.ts` 依赖 `.message-content`、`ol`/`li`/`strong`/`ul` 层级。
4. 不改变 `renderMarkdownContent(...)` 与 `renderMessageContent(...)` 的外部可见签名，避免影响 `renderTranscript` 等调用点。
5. 建立**单向依赖**：`inline` ← `blocks` ← `renderMarkdownContent`；允许 `codeBlock` 被 `blocks` 使用。禁止反向调用、禁止循环。
6. 所有 fragment 共享同一作用域，标识符不得冲突；`composeWebviewFragments` 只校验 fragment id。函数名保持原样（P0 的符号唯一性测试需继续通过）。
7. 临时文件只写系统临时目录或 `out-test/`。不引入新依赖/打包器。
8. 本机 `bun run test` 会在 `draftRunBatch` 处挂死、管道会被缓冲：按「用法 0.1」用文件重定向 + 后台进程跑测试，并与既有失败清单对比。

## 具体任务
新建 `src/webview/transcript/markdown/`（复用 P1 已建的 `src/webview/transcript/`），每文件导出 `WebviewFragment`：
- `inline.ts` → id `transcript.markdown.inline`：`appendMarkdownInline`、`appendMarkdownFormattedText` 及其独占的行内解析辅助
- `blocks.ts` → `transcript.markdown.blocks`：`renderMarkdownBlocks`、`appendMarkdownHeading`、`appendMarkdownParagraph`、`appendMarkdownBlockquote`、`splitMarkdownParagraphs`、`repeatCharacter`
- `lists.ts` → `transcript.markdown.lists`：`appendMarkdownList`
- `tables.ts` → `transcript.markdown.tables`：`appendMarkdownTable`
- `codeBlock.ts` → `transcript.markdown.code`：`createMarkdownCodeBlock`
- `renderMarkdownContent.ts` → `transcript.markdown.entry`：`renderMarkdownContent`、`renderMessageContent`

要求：
1. 每个 fragment 的 `source` 内保持 **4 空格缩进 + `function name(`**，且**不得插入非函数声明行**（会污染 `draftRunBatch` 的切片，见 P1 说明）。
2. 在 `src/webview/script.ts` 中删除原实现，改为在**原插入位置**用 `${xxxFragment.source}` 插值，**函数声明顺序必须与原来一致**（`var` 提升、`const` TDZ、调用点顺序都依赖它）。
3. 为 `renderMarkdownContent` 的 `options` 参数补一段注释式结构说明（`compactReferenceLinks` 以及你实际观察到的其他字段），写在 fragment `source` **之外**的 TS 注释里——**不要**改成 TypeScript 类型（它在字符串里），也**不要**把注释塞进 `source`。
4. 若有函数搬迁后无人调用，**不要删除**，先保留并在交付中列出。

## 验收（必须逐条实际执行并贴出结果）
1. `getScript()` 搬迁前后 sha256 对比，逐项说明差异原因（允许仅空白/换行差异）。`getInputScript()` / `getInputStyles()` / `getInputTemplate()` 的 sha256 必须与 `test/inputComposition.test.ts` 常量一致。
2. 全部通过（本机等价命令 + 文件重定向 + 后台进程）：
```bash
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/eslint/bin/eslint.js src/
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node out-test/test/runTests.js
```
3. 特别确认 `test/markdownRendering.test.ts` 全部用例通过（不是"未运行"），给出通过用例数；以及 `contextEntryPoints`、`inputComposition` 中所有 `getGeneratedSection` / `new Function(getScript())` 相关断言通过。与既有失败清单相比无新增失败。

## 交付格式
1. 新增/修改文件清单与行数。
2. `getScript()` sha256 前后对比与差异逐项说明。
3. 全部验收命令真实输出摘要，明确列出 `markdownRendering` 的通过用例数。
4. 依赖方向图（谁调用谁），证明无循环。
5. 搬迁后变成无调用者的函数清单（如有）。
6. `git status --porcelain resources images` 空输出。
```

---

## P3 — 抽离消息卡片与运行详情面板

```text
你是一位资深 VS Code 扩展维护者。仓库：KeepSeek（TypeScript）。先 git status 确认工作树干净。

## 目标
把 `src/webview/script.ts` 中「单条消息内的小卡片 / 操作条 / 运行详情面板」的构造逻辑抽成独立 fragment 模块，让 `renderTranscript` 只保留编排职责。

## 已核实的背景事实
- `getScript()` 是单内联脚本字符串，所有 fragment 共享同一词法作用域（大 IIFE），不能 import、不能拆多脚本（CSP 见 `src/webview/html.ts`）。
- `renderTranscript(changeSetProjection, draftRunProjection)`（L3952）是渲染协调器，必须**留在 `script.ts`**。
- 待搬迁函数及**当前真实行号**（以符号名为准）：
  - 消息内卡片：`getReasoningKey`(L4139)、`createReasoningBlock`(L4143)、`syncReasoningLive`(L4170)、`createRunStatePanel`(L4232)、`createUsedSkillsNotice`(L4713)、`createUserMessageActions`(L4730)、`createAssistantMessageActions`(L4742)、`createMessageActionButton`(L4753)
  - 运行详情：`createRunDetailsPanel`(L4255)、`appendRunDetailRow`(L4486)、`createRunSection`(L4495)、`createRunTextSection`(L4505)、`createRunDetailText`(L4512)、`formatRunContextSource`(L4518)、`createRunActionButton`(L4535)、`formatCacheReasonForView`(L4563)、`formatRunDetailsSummary`(L4643)
  - 复制/反馈：`copyMessageText`(L2182)、`showMessageCopyFeedback`(L2192)、`copyCodeBlockText`(L2209)、`showCodeCopyFeedback`(L2221)、`copyTextToClipboard`(L2237)
  - **注意**：`formatDelegationDetails`(L4597) 与 `formatDateTime`(L4638) 已在 P1 搬入 `src/webview/transcript/format.ts` 的 `transcript.format` fragment。`test/runDetails.test.ts` 第 129-132、192-194 行要求 `    function formatDelegationDetails(` 之后紧跟 `    function formatDateTime(`。**搬迁前先实测该断言是否仍然通过**：若 P1 已让它们同处一个 fragment 且相邻，则本批次只要不拆动 `transcript.format` 即可保持成立；若已失效，**必须显式报告并给出方案，不要改断言**。
- **关键测试约束（硬契约）**：
  - `test/reasoningPanel.test.ts` 第 46-49、76-89 行：从 `getScript()` 用 `    function ${name}(` + 花括号配平切出 `getReasoningKey`、`createReasoningBlock`、`syncReasoningLive` 后在 `new Script` 里执行。**这三个函数的名字、4 空格缩进、`function name(` 形式必须保留。**
  - `test/applyWorkflow.test.ts` 用 `extractFunction` 切 `handleChangeSetActionClick`、`handleChangeActionFeedback`、`createEditActionButton`（这些本批次**不搬**）。
  - `test/draftRunBatch.test.ts` 第 618-633 行：44 个函数名的 `indexOf('    function ' + name + '(')` 到下一个 `'\n    function '` 切片；其中 `createApprovalSourceSummary` 属于**本批次要搬**的范围（按 P4 规划它在 approval-display 里，但 P3 请先不要动它，留给 P4；若你决定搬，必须保证切片假设仍成立并说明）。本批次实际会碰到对方沙箱注入的标识符包括 `createAssistantMessageActions`、`createUserMessageActions`（第 658-659 行以 context 属性注入）——**函数名不能变**。
  - `test/subagentUsageStats.test.ts` 断言 `getScript()` 含正则 `/if \(run\.status === 'running' \|\| run\.status === 'completed'\) return null/u`（来自 `createRunStatePanel`）——搬走后必须仍在。
  - `test/startupPerformance.test.ts`、`test/longRunningAgent.test.ts` 会 `new Function(getScript())`。
  - `test/runDetails.test.ts` 全文**没有** `new Set(ids)` 断言（已核实：`grep -rn "new Set(ids)" test/` 只命中 `inputComposition.test.ts:354`，那是 `getInputTemplate()` 的检查）。不要为它做任何改动。
- `test/runTests.ts` 是显式 import 清单。

## 硬约束
1. **绝对禁止删除、改名、移动、覆盖 `resources/` 下任何文件（含 `.DS_Store`、`keepseek.png`），禁止动 `images/`**。不得修改 `src/webview/html.ts` 的 `resources/*.svg` 拼接与 `scripts/verify-vsix.js` 的 `resources` 遍历。
2. **不改交互状态机与副作用入口**：`renderTranscript` 保留在 `script.ts` 作为编排器；`handleMessageAction`、`handleChangeSetActionClick`、`handleDraftRunActionClick`、`handleChangeActionFeedback`、`handleDraftRunCloneFeedback`、`captureDraftRunActionFocus`、`findDraftRunActionFocus`、`transcript.addEventListener(...)` 的注册位置与顺序**一律不动**。
3. `reasoningExpandedKeys` 这个 `Set` 与 `getReasoningKey` 的 key 格式（`sessionId + '|' + messageId`）不得改变——它跨全量重渲染保存折叠状态。
4. 不改变任何 CSS 类名、`data-*`、`aria-*`、`role`。`running`/`completed` 状态下 `createRunStatePanel` 必须返回 `null` 的行为不变。
5. 所有 fragment 共享同一作用域；标识符不得冲突。P0 的符号唯一性测试必须继续通过。
6. 不重写逻辑，只搬迁。函数体逐字保留（缩进可适配）。fragment `source` 内不得插入非函数声明行。
7. 临时文件只写系统临时目录或 `out-test/`。不引入新依赖/打包器。
8. 本机 `bun run test` 会在 `draftRunBatch` 处挂死、管道会被缓冲：按「用法 0.1」用文件重定向 + 后台进程跑测试，并与既有失败清单对比。

## 具体任务
在 `src/webview/transcript/` 下新增：
- `messageCard.ts` → id `transcript.message-card`：`getReasoningKey`、`createReasoningBlock`、`syncReasoningLive`、`createRunStatePanel`、`createUsedSkillsNotice`、`createUserMessageActions`、`createAssistantMessageActions`、`createMessageActionButton`
- `runDetailsPanel.ts` → id `transcript.run-details`：`createRunDetailsPanel`、`appendRunDetailRow`、`createRunSection`、`createRunTextSection`、`createRunDetailText`、`formatRunContextSource`、`createRunActionButton`、`formatCacheReasonForView`、`formatRunDetailsSummary`
- `clipboard.ts` → `transcript.clipboard`：`copyMessageText`、`showMessageCopyFeedback`、`copyCodeBlockText`、`showCodeCopyFeedback`、`copyTextToClipboard`

要求：
1. 在 `src/webview/script.ts` 的**原插入位置**用 `${xxxFragment.source}` 替换，**逐函数保持原声明顺序**。
2. `renderTranscript` 内调用点**一行都不改**（函数名与参数保持原样），确保字符串断言如 `body.append(createChangeSetCard(changeSet))` 继续成立。
3. 对 `formatDelegationDetails` / `formatDateTime` 的切片约束：先实测，再决定是否动 `transcript.format`，并在交付中明确回答。

## 验收（必须逐条实际执行并贴出结果）
1. `getScript()` sha256 前后对比与差异说明。`getInputScript()` / `getInputStyles()` / `getInputTemplate()` 的 sha256 必须与 `test/inputComposition.test.ts` 常量一致。
2. 全部通过（本机等价命令 + 文件重定向 + 后台进程）：
```bash
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/eslint/bin/eslint.js src/
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node out-test/test/runTests.js
```
3. 逐项确认这些文件全绿：`reasoningPanel`、`runDetails`、`applyWorkflow`、`contextEntryPoints`、`startupPerformance`、`subagentUsageStats`、`longRunningAgent`、`draftRunBatch`、`draftRunBatchDisplay`、`sessionTitleWebview`、`inputComposition`。与既有失败清单相比无新增失败。

## 交付格式
1. 新增/修改文件清单与行数。
2. `getScript()` sha256 前后对比与差异逐项说明。
3. 全部验收命令真实输出摘要。
4. 明确回答：`formatDelegationDetails` 与 `formatDateTime` 的切片约束是否仍成立；若不成立你做了什么（不得删断言）。
5. 明确回答：`test/runDetails.test.ts` 是否存在 `new Set(ids)` 断言（给出你的实测命令与输出）。
6. `git status --porcelain resources images` 空输出。
```

---

## P4 — 抽离 ChangeSet 与 DraftRun 卡片（最高风险，最后做）

```text
你是一位资深 VS Code 扩展维护者，熟悉"审批 / 文件与命令副作用"的展示层契约。仓库：KeepSeek（TypeScript）。先 git status 确认工作树干净。

## 目标
把 `src/webview/script.ts` 中 ChangeSet（DraftEdit）与 DraftRun（待确认命令）卡片的构造与动作按钮逻辑抽成独立 fragment 模块，不改任何审批语义与 DOM 契约。

## 已核实的背景事实
- 这是本项目**最敏感**的 UI 区域：卡片上的 Apply / Discard / Run / Cancel 按钮直接决定用户看到什么、能点什么。`doc/keepseek-refactor-verification.md` 第 27 行明确记录过「大型 Webview …… 保留。此次无足够收益支撑重写这些状态机」。**因此本批次只允许位置搬迁，禁止任何逻辑重写、禁止合并/简化分支。**
- `getScript()` 是单内联脚本字符串，所有 fragment 共享同一词法作用域，不能 import、不能拆多脚本（CSP 见 `src/webview/html.ts`）。
- 待搬迁函数及**当前真实行号**（以符号名为准；`buildChangeSetTimelineProjection`/`buildDraftRunTimelineProjection` 已在 P1 搬走，**不要重复搬**）：
  - ChangeSet：`createDraftEditActionIcon`(L2738)、`createHistoricalChangeSet`(L3063)、`getHistoricalFileStatus`(L3094)、`renderUnlinkedChangeSets`(L3105)、`createChangeSetCard`(L3655)、`createChangeSetFileRow`(L3707)、`createEditActionButton`(L3880)、`createEditOpenFileButton`(L3896)、`createChangeSetActionButton`(L3908)、`getChangeSetStatusLabel`(L3923)、`getChangeFileStatusLabel`(L3936)、`isChangeSetActionable`(L3645)
  - DraftRun：`isDraftRunBatchActive`(L3027)、`getDraftRunBatchMembers`(L3032)、`renderDraftRunItems`(L3040)、`createDraftRunTimelineItem`(L3046)、`createDraftRunCard`(L3116)、`appendDraftRunBatchControls`(L3358)、`formatApprovalDependency`(L3445)、`appendApprovalStateNote`(L3451)、`appendDraftRunActions`(L3459)、`createDraftRunActionButton`(L3502)、`getDraftRunTitle`(L3530)、`appendDraftRunField`(L3554)、`createDraftRunPreflightDetails`(L3567)、`formatDraftRunProcessResult`(L3610)、`getDraftRunStatusLabel`(L3616)、`getDraftRunEffectLabel`(L3641)
  - 审批展示：`getApprovalTarget`(L3413)、`isHeldDraftRunApproval`(L3418)、`getApprovalWaitingLabel`(L3422)、`getApprovalDisplayReason`(L3429)、`createApprovalReviewSummary`(L3762)、`formatApprovalReviewDetails`(L3770)、`createApprovalSourceSummary`(L3797)、`getApprovalSourceLabel`(L3804)、`isApprovalSafetyDenied`(L3814)、`getApprovalDecisionLabel`(L3837)、`getApprovalRiskLabel`(L3854)
- **最关键测试约束**：`test/draftRunBatch.test.ts` 第 614-633 行的 `renderHarness()` 用 **44 个函数名**逐个 `source.indexOf('    function ' + name + '(')`，再切到其后第一个 `'\n    function '`，拼起来在 `new Script(...)` 沙箱里执行。函数名清单（第 618-627 行，原样抄录）：
  `getApprovalTarget, isHeldDraftRunApproval, getApprovalWaitingLabel, getApprovalDisplayReason, formatApprovalDependency, appendApprovalStateNote, createDraftRunCard, appendDraftRunBatchControls, appendDraftRunActions, createDraftRunActionButton, isDraftRunBatchActive, getDraftRunBatchMembers, createDraftRunTimelineItem, renderDraftRunItems, captureDraftRunActionFocus, findDraftRunActionFocus, renderTranscript, handleDraftRunActionClick, handleChangeSetActionClick, createApprovalReviewSummary, formatApprovalReviewDetails, getApprovalSourceLabel, getApprovalDecisionLabel, getApprovalRiskLabel, isApprovalSafetyDenied, getDraftRunTitle, appendDraftRunField, createDraftRunPreflightDetails, formatShellCommand, formatShellWord, formatDraftRunProcessResult, getDraftRunStatusLabel, getDraftRunEffectLabel, createChangeSetCard, createChangeSetFileRow, createEditActionButton, createEditOpenFileButton, createChangeSetActionButton, getChangeSetStatusLabel, getChangeFileStatusLabel, isChangeSetActionable, renderUnlinkedChangeSets, buildDraftRunTimelineProjection, handleDraftRunCloneFeedback`（共 44 个；`buildDraftRunTimelineProjection` 与 `formatShellCommand`/`formatShellWord` 已在 P1 搬走但仍在 `getScript()` 里，所以仍会被切片）。
  该沙箱还会以 context 属性直接注入：`formatDuration: String`（**注意：沙箱把 formatDuration 替换成 String，因此 fragment 内不得依赖 formatDuration 的原始实现做关键分支**）、`createDraftEditActionIcon`、`createApprovalSourceSummary`、`getEditApprovalSourceLabel: String`、`pendingManualApprovalIds`、`pendingDraftRunActions`、`pendingDraftRunApprovals`、`pendingChangeActions`、`changeActionRequestSequence`、`renderMarkdownContent`、`createAssistantMessageActions`、`createUserMessageActions`。
  **陷阱**：切片规则会在函数之间插入任何 `const`/注释/空行外的内容时把内容并进前一个切片，静默改变沙箱执行内容；注释行以 4 空格开头同样会被并入。因此每个被列名函数必须保持 `    function name(` 形式，且**函数之间不得插入任何非函数声明行**。
- 其它约束：
  - `test/contextEntryPoints.test.ts` 第 1196-1205 行断言 `getScript()` 必须包含 `buildChangeSetTimelineProjection`、`changeSet\.messageId`、`body\.append\(createChangeSetCard\(changeSet\)\)`、`message\.role === 'assistant' && !message\.isStreaming`、`liveChangeSetFileIds\.has\(String\(file\.id\)\)`、`t\('changeSetBatchHint'\)`、`t\('changeSetApplyAll', \{ count: applicableFiles\.length \}\)`，且**不得**包含 `function renderDraftEdits`。
  - 第 1216 行断言 `getTemplate()` 的 `<section id="transcript">` 内含 `planRegion` → `unlinkedChangeSetRegion` 嵌套顺序；第 1217 行断言 `renderTranscript` 内 `planRegion.remove()` → `unlinkedChangeSetRegion.remove()` → `transcript.append(planRegion)` → `transcript.append(unlinkedChangeSetRegion)` → `renderUnlinkedChangeSets` 的先后顺序。
  - `test/applyWorkflow.test.ts` 用 `extractFunction` 切 `handleChangeSetActionClick`、`handleChangeActionFeedback`、`createEditActionButton` 并在 `new Function` 里执行，要求按钮生成 "Checking…" / `aria-busy` / disabled 等终态反馈。
  - `test/draftRunBatchDisplay.test.ts`、`test/executionMode.test.ts`、`test/approvalMode.test.ts`、`test/taskApprovalIntegration.test.ts` 涉及审批/执行模式展示，一并跑通。
- `test/runTests.ts` 是显式 import 清单。

## 硬约束
1. **绝对禁止删除、改名、移动、覆盖 `resources/` 下任何文件（含 `.DS_Store`、`keepseek.png`），禁止动 `images/`**。不得修改 `src/webview/html.ts` 的 `resources/*.svg` 拼接与 `scripts/verify-vsix.js` 的 `resources` 遍历。
2. **禁止逻辑重写**。不合并分支、不抽取新抽象、不改判定条件、不改文案 key、不改 `t('...')` 的字符串。只搬迁。
3. **不改审批/执行语义**：`handleChangeSetActionClick`、`handleDraftRunActionClick`、`handleChangeActionFeedback`、`handleDraftRunCloneFeedback`、`pendingChangeActions`、`pendingDraftRunActions`、`changeActionRequestSequence`、`approvalMode` 判定、`isApprovalSafetyDenied`、`canSubmitPrompt`/`canCancelPrompt` 一律不动。这些 handler 本身**留在 script.ts 原位置**，本批次只搬它们调用的展示构造器。
4. **`renderTranscript` 留在 `src/webview/script.ts`**，其内部调用顺序一字不改。
5. 每个被 `test/draftRunBatch.test.ts` 列名的函数，搬走后必须仍满足「`    function name(` 开头 + 4 空格缩进 + 到下一个 `\n    function ` 之间只有它自己」。若某个 helper 是 `const`/箭头函数而非 `function` 声明，**保持原样**，不要改写形式。
6. 所有 fragment 共享同一作用域；标识符不得冲突。P0 的符号唯一性测试必须继续通过。
7. 临时文件只写系统临时目录或 `out-test/`。不引入新依赖/打包器。
8. 本机 `bun run test` 会在 `draftRunBatch` 处挂死、管道会被缓冲：按「用法 0.1」用文件重定向 + 后台进程跑测试，并与既有失败清单对比。

## 具体任务
在 `src/webview/transcript/` 下新增（复用 P1–P3 已建目录）：
- `changeSetCard.ts` → id `transcript.change-set-card`：上面 ChangeSet 一节全部函数 + `createDraftEditActionIcon`
- `draftRunCard.ts` → id `transcript.draft-run-card`：`createDraftRunCard`、`createDraftRunTimelineItem`、`appendDraftRunActions`、`createDraftRunActionButton`、`getDraftRunTitle`、`appendDraftRunField`、`createDraftRunPreflightDetails`、`formatDraftRunProcessResult`、`getDraftRunStatusLabel`、`getDraftRunEffectLabel`
- `draftRunBatch.ts` → id `transcript.draft-run-batch`：`isDraftRunBatchActive`、`getDraftRunBatchMembers`、`renderDraftRunItems`、`appendDraftRunBatchControls`
- `approvalDisplay.ts` → id `transcript.approval-display`：`getApprovalTarget`、`isHeldDraftRunApproval`、`getApprovalWaitingLabel`、`getApprovalDisplayReason`、`formatApprovalDependency`、`appendApprovalStateNote`、`createApprovalReviewSummary`、`formatApprovalReviewDetails`、`createApprovalSourceSummary`、`getApprovalSourceLabel`、`isApprovalSafetyDenied`、`getApprovalDecisionLabel`、`getApprovalRiskLabel`

要求：
1. 在 `src/webview/script.ts` 的**原插入位置**用 `${xxxFragment.source}` 替换，**逐函数保持原声明顺序**。
2. 每个 fragment 的 `source` 内不得插入任何非函数声明行（注释也不行——4 空格开头的注释会被并入切片）。注释写到 fragment 之间或 `source` 之外的 TS 注释里。
3. 搬完后跑自查脚本（系统临时目录）：解析 `getScript()`，对上面 44 个函数名逐个验证 `indexOf('    function ' + name + '(')` 命中，且从该位置到下一个 `'\n    function '` 的区间内**只包含这一个函数**（花括号配平校验），输出 `命中数/44` 与失败项。

## 验收（必须逐条实际执行并贴出结果）
1. `getScript()` sha256 前后对比与差异逐项说明。`getInputScript()` / `getInputStyles()` / `getInputTemplate()` 的 sha256 必须与 `test/inputComposition.test.ts` 常量一致。
2. 全部通过（本机等价命令 + 文件重定向 + 后台进程）：
```bash
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/eslint/bin/eslint.js src/
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node out-test/test/runTests.js
```
3. 逐项确认这些文件全绿：`draftRunBatch`、`draftRunBatchDisplay`、`applyWorkflow`、`contextEntryPoints`、`executionMode`、`approvalMode`、`taskApprovalIntegration`、`changeSet`、`textPatch`、`draftRunRisk`、`draftRunStore`、`startupPerformance`、`inputComposition`。既有失败清单内的项（如 `changeSet` 的 Windows 路径断言、`draftRunStore` 的 revoked-click 断言）保持原状即可，不得新增失败。
4. 贴出第 3 条自查脚本的输出（44/44 命中且区间内单函数）。

## 交付格式
1. 新增/修改文件清单与行数。
2. `getScript()` sha256 前后对比与差异逐项说明。
3. 44 个被切片函数的自查结果（命中数 / 失败项）。
4. 全部验收命令真实输出摘要。
5. 明确声明：未修改任何审批判定、未修改任何 `t('...')` key、未修改 `handleChangeSetActionClick` / `handleDraftRunActionClick` / `renderTranscript` 内部逻辑。
6. `git status --porcelain resources images` 空输出。
```

---

## P5 — 样式分区与文档收口

```text
你是一位资深 VS Code 扩展维护者。仓库：KeepSeek（TypeScript）。先 git status 确认工作树干净。

## 目标
把 `src/webview/styles.ts` 按 UI 区域拆成 fragment，并把本次解耦的结论写入架构文档与开发约束，完成收口。

## 已核实的背景事实
- `src/webview/styles.ts`（2047 行）导出 `getStyles()`：一个模板字符串，含**三处插值，位置各不相同**：
  - L212 `${getInputStyles()}`（4 空格缩进）、L213 `${getRichTextContextMenuStyles()}`（4 空格缩进）——两者**相邻**，并在 L214 之后继续有全局规则（例如 `.settings-model-default-slot`）。
  - L488 `${conversationsStylesFragment.source}` —— **独占一行、行首无缩进**；对应 `src/webview/conversations/styles.ts`（286 行，`source: \`...\`.slice(1)`）。
  - 现有分区注释只有 4 条：L69（input 间距变量）、L292 `/* ---- header ---- */`、L490 `/* ---- context bar ---- */`、L1250 `/* ---- transcript ---- */`。settings 菜单、draft-run、change-set、run-details、reasoning、markdown **没有分区注释**。
- CSS **没有作用域**；`INPUT_STYLE_FRAGMENTS` 的注释明确「fragment order defines the CSS cascade」，所以拆样式必须保持选择器**相对顺序不变**。
- 已有成功先例：`src/webview/input/composition.ts` 的 `INPUT_STYLE_FRAGMENTS` 数组 + `composeWebviewFragments`（重复 fragment id 即抛错）。
- 现有样式断言在 `test/contextEntryPoints.test.ts`：
  - L1212-1225：`getGeneratedSection(styles, '    .draft-bar {', '\n    .draft-bar-header')`、`(styles, '    .draft-run-output {', '\n    .change-set-partially_failed')`、`(styles, '    .message-code-block pre {', '\n    .message-code-block code')`，以及 `.transcript { ... overflow-y: auto }`、`.draft-bar` 的 `max-height: none` + `overflow-y: visible`、`.draft-run-output` 不得含 `max-height|overflow-y: auto`、`.message-code-block pre` 必须 `overflow-y: visible`。**这些切片要求被切的两段仍在同一个字符串里、且相邻**——拆 fragment 时 `.draft-bar {` 与 `.draft-bar-header`、`.draft-run-output {` 与 `.change-set-partially_failed`、`.message-code-block pre {` 与 `.message-code-block code` 必须留在**同一个 fragment**内。
  - L1231-1234：`.change-set-actions` 的 `flex-wrap: wrap`、`.draft-chip-actions` 的 `flex-wrap: wrap`、`@media (min-width: 380px)` 存在、`.change-set-actions button` 的 `max-width: 100%`。
  - L20-28：`.session-menu` 的 `left/right/width` 与 `.session-menu-controls` 的 `flex-wrap: wrap`（这些在 `conversations.styles` fragment 里）。
- `test/inputComposition.test.ts` 第 351-399 行断言 `getInputStyles()` 的 sha256 为固定值，并断言其包含 `.composer-input-inner`、`.rich-file-link`、`.reference-menu`、`.skills-bar`、`.command-menu`、`.command-model-option`、`.context-progress`、`.usage-details-dialog`、`.settings-overlay`、`.settings-account-workspace`、`.about-details`、`.new-account-provider-menu`。
- `test/reasoningPanel.test.ts` L162-167 用正则断言 `.reasoning-dots`、`.reasoning-block.is-live .reasoning-dots`、`.reasoning-block[open] .reasoning-dots`、`@keyframes reasoning-dots-pulse`、`@media (prefers-reduced-motion: reduce)` 与 `.reasoning-dots` 的相对关系——**跨 fragment 的正则仍能匹配，但被拆到不同 fragment 且顺序改变时会失效**。
- `scripts/verify-vsix.js` 会遍历 `resources/` 目录，把所有 `.svg`/`.png` 当作必需打包项；`bun run package:market` 会 typedef 调用 `scripts/package-market.js`（清理 out/ → compile → vsce package --dependencies → verify-vsix）。
- `doc/keepseek-code-architecture.md` 第 2 节「宿主与 Webview」有一张表格（L24-35，当前 6 行：`KeepseekChatViewProvider.ts`、`interactionState.ts`、`webviewMessages.ts`、`modelSelection.ts`、`requestTimeoutSettings.ts`、`html.ts`、`script.ts`、`input/composition.ts`、`richTextShortcuts.ts`、`richTextContextMenu*.ts`），L37 写明「Webview 是字符串生成的页面，不是独立前端应用」。
- `AGENTS.md` 第 5 节是「验证与交付」（P0 会在此追加一条 fragment 护栏条目）。

## 硬约束
1. **绝对禁止删除、改名、移动、覆盖 `resources/` 下任何文件（含 `.DS_Store`、`keepseek.png`），禁止动 `images/`**。不得修改 `src/webview/html.ts` 中对 `resources/keepseek.svg`、`resources/plugin.svg`、`resources/${provider}.svg` 的引用，不得修改 `scripts/verify-vsix.js` 遍历 `resources/` 的逻辑。**本批次没有任何正当理由触碰 `resources/`**——若你发现自己要改它，说明方案错了。
2. **拆分样式必须保持选择器相对顺序**。只能"切块并保持顺序"，不能重排、不能合并规则、不能改选择器、不能改声明值。
3. 不得改变 `getInputStyles()` 的输出（sha256 必须与 `test/inputComposition.test.ts` 常量一致）。
4. 不得删除任何 `!important`、`@media`、CSS 变量或注释。
5. 临时文件只写系统临时目录或 `out-test/`。不引入新依赖/打包器。
6. 本机 `bun run test` 会在 `draftRunBatch` 处挂死、管道会被缓冲：按「用法 0.1」用文件重定向 + 后台进程跑测试，并与既有失败清单对比。

## 具体任务
### 第一部分：样式分区
1. 复用 `composeWebviewFragments`（`src/webview/input/composition.ts`），新建 `src/webview/stylesComposition.ts` 定义 `ROOT_STYLE_FRAGMENTS` 固定顺序数组；样式 fragment 放在与 P1–P4 的 TS 目录对齐的位置（例如 `src/webview/transcript/styles.ts`、`src/webview/transcript/markdown/styles.ts`、`src/webview/changeSet/styles.ts`、`src/webview/draftRun/styles.ts`、`src/webview/runDetails/styles.ts`、`src/webview/settings/styles.ts`），目录名可按现有约定微调但**必须在交付里说明**，避免一个区域散落在两处。
2. 在 `src/webview/styles.ts` 中把原 CSS 按块搬走，`getStyles()` 改为按 `ROOT_STYLE_FRAGMENTS` 拼接，**三处原有插值的相对位置必须与原来一致**：`${getInputStyles()}` 与 `${getRichTextContextMenuStyles()}` 的处理要特别小心——它们原先位于同一个全局字符串**中间**（L212-213），且 L488 的 `conversationsStylesFragment` 独占一行。
   建议做法：先保留 `styles.ts` 里这三处插值原样不动，只把**它们之外的全局 CSS 连续区段**切成若干 fragment，分别插回原位置（例如「transcript 之前」与「transcript 之后」两段、或按 L292/L490/L1250 三条分区注释切四段），这样能保证插值相对位置和 CSS 级联完全不变。**不要**把所有 fragment 都挪到插值后面再拼接。
3. 每搬一个区域后立刻比对 `getStyles()`：给出前后**选择器顺序数组**（用 `/^\s{4}(\.[a-zA-Z][\w-]*)/gmu` 提取）并证明顺序完全一致；字节差异只允许空白/换行。
4. 已知切片约束：`.draft-bar {` 与 `.draft-bar-header`、`.draft-run-output {` 与 `.change-set-partially_failed`、`.message-code-block pre {` 与 `.message-code-block code` 这三对必须留在**同一 fragment 且相邻**。

### 第二部分：文档
5. 更新 `doc/keepseek-code-architecture.md` 第 2 节表格，加入 P1–P5 新建的目录与职责，并明确写清：**"组件"指的是同作用域 fragment 渲染模块，不是独立作用域/独立生命周期的前端组件**；不得引入 ESM、打包器或多 `<script>`。
6. 在 `doc/keepseek-code-architecture.md` 补充一段「fragment 契约」说明：id 唯一、顺序即契约（词法作用域 TDZ、监听注册顺序、CSS 级联、DOM 顺序）、标识符唯一（`composeWebviewFragments` 不校验）、4 空格缩进与 `function name(` 形式的测试依赖、`source` 内不得插入非函数声明行（会污染 `draftRunBatch` 切片）、`.slice(1)` 的换行约定。
7. 在 `AGENTS.md` 第 5 节补充 Webview fragment 改动的验证清单（P0 已加一条则不重复，只补遗漏项）。
8. 在 `doc/README.md` 的文档导航中，如新增了专题页则登记；不新增页面可跳过。

### 第三部分：可选自查
9. 若判断有价值，新增 `test/webviewStyleOrder.test.ts` 固化关键区域的选择器相对顺序（与 P0 的根级顺序测试互补即可，不要重复），并登记到 `test/runTests.ts`。

## 验收（必须逐条实际执行并贴出结果）
1. `getInputStyles()` 的 sha256 与 `test/inputComposition.test.ts` 常量一致。
2. `getStyles()` 搬迁前后：输出选择器顺序数组（用 `/^\s{4}(\.[a-zA-Z][\w-]*)/gmu` 提取）并比对，要求**顺序完全一致**；字节差异只允许空白/换行。
3. 全部通过（本机等价命令 + 文件重定向 + 后台进程）：
```bash
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/eslint/bin/eslint.js src/
node node_modules/typescript/bin/tsc -p tsconfig.test.json
node out-test/test/runTests.js
```
4. 逐项确认全绿：`contextEntryPoints`、`inputComposition`、`markdownRendering`、`reasoningPanel`、`runDetails`、`draftRunBatch`、`draftRunBatchDisplay`、`applyWorkflow`、`executionMode`、`startupPerformance`。与既有失败清单相比无新增失败。
5. 打包完整性（确认资源未受影响），本机用 `node scripts/package-market.js`：
   要求通过（`Verified <vsix> (N entries).`），并明确说明 VSIX 内 `resources/` 的 **12 个条目**全部存在（8 个 provider 图标 + `keepseek.svg` + `plugin.svg` + `keepseek.png`；`.DS_Store` 被 `.vscodeignore` 排除，不要求打包）且字节未变。

## 交付格式
1. 新增/修改文件清单与行数。
2. 选择器顺序比对结果（前后数组，或"完全一致"结论 + 抽样）。
3. `getStyles()` 字节差异说明。
4. 全部验收命令真实输出摘要，含 `package:market` 结果与 `resources/` 条目核对结果。
5. 文档改动摘要（`doc/keepseek-code-architecture.md`、`AGENTS.md` 各改了什么）。
6. `git status --porcelain resources images` 与 `git diff --stat -- resources/ images/` 空输出。
```

---

## 本次核实修正清单（相对上一版提示词包的 9 处错误假设）

| # | 上一版假设 | 当前仓库事实 | 影响 |
|---|---|---|---|
| 1 | P0 只说要"建立护栏"，未说明仓库已有哪些等价护栏 | 根级模板 fragment 在 `src/webview/template/*.ts`，契约在 `src/webview/template/composition.ts`；`test/contextEntryPoints.test.ts:1216` **已存在** `<section id="transcript">` → `planRegion` → `unlinkedChangeSetRegion` 的嵌套断言 | P0 改为"只补缺口"，不再重复断言三个 id |
| 2 | P0 要求新增「根级 DOM id 唯一」测试，暗示 `getTemplate()` 完全没有此类锁 | `test/inputComposition.test.ts:351-354` **已有** `getInputTemplate()` 的 DOM id 唯一性断言；缺的只是根级模板这一层 | 测试必须限定为根级模板，并在交付里说明与既有断言的关系 |
| 3 | P0 要求新增 `assert.doesNotThrow(() => new Function(getScript()))` | `test/inputComposition.test.ts:401-402` **已有** | 改为"在 root 组合层再确认一次"，写清理由 |
| 4 | P1–P4 都提到「纯 TS 模块 + fragment 双写方案之外的方式」这类自相矛盾的表述 | 正确做法只有一种：单一真相在 fragment 字符串里，测试从 `getScript()` 切片执行 | P1 新增整节，明确禁止 `toString()` 注入与双份实现 |
| 5 | P3/P4 说 `test/runDetails.test.ts` 有 `new Set(ids)` 断言且"之前核查未命中" | **全文没有**该断言；`grep -rn "new Set(ids)" test/` 只命中 `inputComposition.test.ts:354`（那是 `getInputTemplate()` 的检查） | 删除"先实测确认"这类返工任务 |
| 6 | P1–P5 行号多处偏差 | 实测：`formatDuration` L4590、`formatRunTokenCount` L4556、`formatDelegationDetails` L4597、`formatDateTime` L4638、`formatBytes` L7318、`renderMessageContent` L6310（非 6303）、`getReasoningKey` L4139、`createReasoningBlock` L4143、`syncReasoningLive` L4170、`appendDraftRunField` L3554、`createDraftRunPreflightDetails` L3567、`formatDraftRunProcessResult` L3610、`formatApprovalDependency` L3445、`isDraftRunBatchActive` L3027、`createHistoricalChangeSet` L3063、`renderUnlinkedChangeSets` L3105、`createChangeSetCard` L3655、`createChangeSetFileRow` L3707、`createEditActionButton` L3880、`createEditOpenFileButton` L3896、`createChangeSetActionButton` L3908 | 全部改为以符号名定位，行号只作参考 |
| 7 | `test/draftRunBatch.test.ts` 有 **45** 个函数名 | 第 618-627 行实测 **44** 个（`getApprovalSourceLabel`/`getApprovalDecisionLabel`/`getApprovalRiskLabel`/`isApprovalSafetyDenied` 在第 622 行；`captureDraftRunActionFocus`/`findDraftRunActionFocus` 在第 621 行；`renderTranscript` 也在其中） | 自查脚本目标改为 44/44 |
| 8 | `src/webview/styles.ts` 的三处插值都在尾部、相邻 | 实际是 L212 `${getInputStyles()}` 与 L213 `${getRichTextContextMenuStyles()}` 相邻于**全局字符串中间**（L214 之后仍有全局规则），L488 `${conversationsStylesFragment.source}` 独占一行、行首无缩进 | P5 必须保留插值相对位置，否则 CSS 级联会变 |
| 9 | 未提及本机执行环境问题 | UNC 路径下 `bun run` 找不到 `node_modules/.bin/tsc`（报 `bun: command not found: tsc`，需改用 `node node_modules/typescript/bin/tsc`）；`bun run test` 在 `draftRunBatch` 的两个用例处**挂死**（CPU 归零）；管道输出会被缓冲到进程退出，挂死时拿不到任何日志；已实测 4 类环境性失败（`behaviorEvaluation` 的 live 子进程、`changeSet` 的两条 Windows 路径断言、`draftRunQueryIntegration` 的 git config 检查、`draftRunStore` 的 revoked-click 断言） | 新增「用法 0.1」：node 等价命令 + 文件重定向 + 后台进程 + TAP，并先记录既有失败清单 |

### 另一个未经实测、但仍建议保留的护栏

`test/draftRunBatch.test.ts` 用 `indexOf('    function ' + name + '(') → indexOf('\n    function ', start+1)` 切片。P4 里的自查脚本（花括号配平 + 区间内单函数）**建议在 P0 就落地**成一个小测试（从 `test/draftRunBatch.test.ts` 的源码里读出函数名数组，或直接内联同一份清单），这样 P1–P4 每一步搬迁都能立刻发现"fragment 边界吃掉了下一个函数"这类静默失效。若 P0 时间紧张，至少要在 P4 前完成。
