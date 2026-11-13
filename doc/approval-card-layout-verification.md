# 授权卡片布局修复与验收（2026-11-03）

## 根因与改动

基线为 `acf4825`（0.5.1），开始时工作区干净。源码确认与既往分析一致：
`appendAutomaticApprovalState()` 将长原因和按钮放在同一个 actions 容器，
380px 以上的 `.draft-run-header` / `.draft-chip` 使用 `minmax(0, 1fr) auto`，
右侧内容参与 auto 列宽度计算，挤压左侧。用途的 `overflow-wrap: anywhere`
进一步将狭窄的文本折成逐字长列。提示还误用了文件图标对应的 24px 左缩进。

- `src/webview/script.ts`：共享函数接收说明容器与按钮容器，两种卡片均按“标题/详情、说明、按钮”排列；原因仍用 `textContent`。
- `src/webview/styles.ts`：两种卡片均采用单列分区，按钮自然换行；独立 `.approval-state-note` 允许长路径及无空格文本换行，不继承文件错误缩进。文件详情和错误原有缩进保留。
- `test/draftRunBatch.test.ts`：扩展原有中英文状态测试，新增整卡结构、准确消息参数、多目标、状态更新、busy/startup/denial、ask 和终态回归。
- `scripts/verify-approval-card-layout.cjs`：离线浏览器验收页生成器，调用完整 `getHtmlForWebview()`，只替换 VS Code Host 为内存消息收集器，提供主题变量与合成状态；没有复制卡片实现或近似 CSS。

审批策略、权限、执行、停止、恢复、消息、持久化、Provider 均未改动；复用现有中英文文案。
未改 `package.json`、`CHANGELOG.md`，未提交 Git。

## 自动检查记录

- `bun run compile`：通过。
- `bun run lint`：通过。
- `bun run build:test`：通过。
- `node --require ./out-test/test/registerVscodeStub.js --test out-test/test/draftRunBatch.test.js`：32/32 通过。
- `bun run test`：871 项，870 通过、0 失败、1 跳过（约 144 秒）；跳过项为已有本地网络故障服务器测试，原因是沙箱不允许监听端口。
- `git diff --check`、验收生成器语法检查：通过。
- 离线 HTML 已实际生成；4 段脚本解析通过，确认包含完整生产 CSS / JS。此项只证明生成与语法，不证明浏览器执行。

**真实布局尚未验证。** 当前执行环境拒绝本地 HTTP 监听（`listen EPERM`）；
内置浏览器安全策略拒绝 `file://` 导航。停止尝试绕过，未获得截图或实际边界框，
未执行真实 VS Code Webview 操作，也未点击用户现有待授权操作。

## 不执行命令的离线浏览器验收

在仓库终端执行：

```bash
bun run build:test
node scripts/verify-approval-card-layout.cjs
```

1. 用本机 Chrome/Edge 打开最后打印的 HTML 路径（可以直接拖入浏览器）。页面明确标注 Synthetic Host。
2. 点击 **Run layout matrix**。矩阵为 6 个宽度 × 2 种语言 × 2 种自动审批模式 × 3 种 CSS zoom × 4 种原因，共 288 个组合、1152 次卡片测量；**这是一份待执行计划，并非本次通过数量**。
3. 每组包含独立命令、同一批次内两个命令、文件修改条目；使用 `npm run lint` / `signal_tracker_spa` 和用户提供的长用途及双语原因。合成 Host 不执行任何命令或文件操作。
4. 断言检查：标题样本单行；标题及说明使用至少 80% 卡片宽度；说明与按钮分区不重叠；卡片、字段、按钮不横向溢出；按钮有边界框并可聚焦；完整命令、cwd、原因保留；提示无 24px 缩进。不会用固定卡片高度断言。
5. 动态检查短原因、processing、failed、denied、needs_authorization，检查说明数量和准确授权目标；授权点击只写入内存消息数组。展开 **Measurements** 查看结果与边界框；若显示 FAIL，记录首个失败及最后通过样本，不能算通过。
6. 用 Width / Language / Reason / CSS zoom 下拉框和 **Preview** 复核截图，至少保存 320、380、600px 样本。CSS zoom 125%/150% 仅为缩放压力样本，不等于 VS Code 原生缩放验收。

## VS Code 现场验收

1. 用 VS Code 打开本仓库，执行 `bun run compile`。按 F5，选择已有 **Run KeepSeek Extension**，在新开的 **Extension Development Host** 中测试，避免误测已安装的 0.5.1。
2. 在开发宿主中打开一个可丢弃的专用测试目录；确认信任状态及模型设置。不要使用生产项目、真实待审批操作或敏感文件。新建 KeepSeek 会话。
3. 先选择 **ask**，让 Agent 只准备命令草稿，检查“运行并继续 / 仅运行 / 拒绝”以及预览、丢弃等按钮仍可见。可直接使用已有待授权卡片做只读布局检查。
4. 要可控地触发精确范围确认，可在新测试会话中选择 **model_review** 或 **delegate**，向 Agent 提交：

   > 仅准备一个 DraftRun，executable 为 node，args 为 ["-e", "process.stdout.write('keepseek-layout-ok')"]，cwd 为当前测试工作区，timeoutMs 为 10000。用途填写：“对修改后的 SPA 源码运行 ESLint，确认删除代码后无语法 / 未使用变量 / 未使用导入类错误。”不要改文件，不要改写命令，不要准备其他命令。由我核对卡片并点击授权。

   这个命令实际只输出测试字符串；用途文案是布局样本，**并不实际运行 ESLint**。
   当前范围检查对这类 Node 内联代码要求精确操作授权。先确认卡片实际 executable/argv/cwd 与上述相符。
   若模型不产生该草稿或 reviewer 拒绝，不改变审批规则，改用离线验收页覆盖布局。
5. 拖动侧栏检查 320、379、380、480、600、920px 附近，特别是 380px 两侧。可打开命令面板 **Developer: Open Webview Developer Tools**，检查所选 `.draft-run-card` / `.draft-chip` 的实际宽度；检查 DOM 中说明与 actions 是相邻节点，actions 内仅有按钮。
6. 标题“待确认命令”应横向可读；用途和长说明自然换行，命令、cwd、超时、风险、审查摘要可读；按钮不重叠、不越界，Tab 可进入按钮。用两个命令的批次和文件修改条目重复检查；长路径/URI/无空格文本用离线矩阵稳定覆盖。
7. 对文件修改按钮，可先在 ask 模式准备测试目录内临时文件的修改，检查预览/丢弃。真实外部范围授权场景仅使用自己创建的可丢弃测试文件；没有此场景时明确记为未验证，勿放宽外部授权。
8. 分别验证中文和英文；通过 **View: Zoom In** 检查 125%/150% 附近的原生缩放，完成后恢复。切换会话或收到状态更新后，说明与按钮不能残留或重复。
9. 若要验证真实执行，**由用户**核对上述无害命令后点击“授权此操作范围”；这一步可能立即触发现有自动审批/执行与接续流程。预期输出 `keepseek-layout-ok`，完成后不残留授权说明。另准备一个同样草稿点“拒绝”，确认它不执行。测试文件也仅在用户核对 diff 后按需点 Apply；布局验收本身无需 Apply。
10. 顺带检查首次 ready、会话切换、设置、输入、拖拽/@、键盘与焦点；不要将本次 VM 回归等同于这些现场操作均已完成。

## 剩余边界

纵向分区也用于宽侧栏及 ask/终态卡片，因而短按钮不再与标题抢占同一行，
部分短卡片会多占一行。这是本次明确的布局取舍。真实字体、主题、原生缩放和
浏览器尺寸矩阵仍需按上述步骤现场验证；安全与执行行为仅由代码差异和已有/新增自动回归验证。
