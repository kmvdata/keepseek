# 会话历史 fragment 搬迁验收记录

日期：2026-11-10（Asia/Shanghai）。搬迁前 HEAD：`bb7e2e66df2b864d014a942850bc379e3aeeb8c2`，工作树干净。

本次仅把会话历史菜单的原文移入 `src/webview/conversations/`，通过原位置、第 0 列的 `${fragment.source}` 拼回。每个 fragment 使用 type-only `WebviewFragment` 导入与 `.slice(1)`，保留原缩进、空行、转义和函数顺序，正文不含末尾换行。B5 整块搬迁，未做可选拆分或额外 composition。

## 范围与文件

核对发现两处与任务参考值不同：`script.ts` 原为 7962 行；B2 的 `if (sessionMenu) {` 原在 1170 行，1171 已是事件绑定。因此实际完整搬迁 B2 1170–1301，共 132 行。其余范围均吻合。

下表“正文”指 fragment 模板内的原文行，不含导出包装；外壳插入点为搬迁后的行号。

| 区块 | 原位置 | 最终文件及正文范围 | 外壳插入点 |
| --- | --- | --- | --- |
| B1：12 个 `let` 状态 | `script.ts:576–587` | [state.ts](../src/webview/conversations/script/state.ts)，6–17 | `script.ts:591` |
| B2：菜单事件绑定 | `script.ts:1170–1301` | [menuBindings.ts](../src/webview/conversations/script/menuBindings.ts)，6–137 | `script.ts:1174` |
| B2b：外部点击关闭 | `script.ts:1303–1311` | 同上，143–151（独立 fragment） | `script.ts:1176` |
| B3：标题刷新 | `script.ts:1673–1805` | [titleRefresh.ts](../src/webview/conversations/script/titleRefresh.ts)，6–138 | `script.ts:1538` |
| B5：完整列表主体 | `script.ts:2034–2632` | [sessionList.ts](../src/webview/conversations/script/sessionList.ts)，6–604 | `script.ts:1767` |
| CSS | `styles.ts:464–741` | [conversations/styles.ts](../src/webview/conversations/styles.ts)，6–283 | `styles.ts:465` |

此外修改 [script.ts](../src/webview/script.ts)、[styles.ts](../src/webview/styles.ts) 的导入和原位插值，并新增本验收记录。未改 `template.ts`、`html.ts`、`src/provider/**`、Webview 消息类型或 `package.json`。

留在脚本外壳中的代码保持原文，原因写在 `getScript()` 前的 TypeScript 注释中，未加入生成脚本：

- `render()`（1443 行起）：主渲染调度。
- `renderSessionControls()`（1718–1728）：同时更新 header 的 `newChatTab` / `historyTab`。
- `historyTab` 点击绑定（1164–1173）：限制搬迁范围。
- Escape 处理器（1188–1193）：同时处理会话和设置菜单。
- 三个 `otherWorkspaces` / `otherWorkspaceSessions` / `otherWorkspaceDeleted` host 分支（1360–1395）：保留完整分支体；未做改变字节的委托。

## 字节证据

以下为实际调用 getter 后按 UTF-8 计算的 SHA-256，包含输入 fragments 和动态序列化配置等完整产物。除哈希外，也将三个最终输出与搬迁前保存的快照通过 `Buffer.equals` 直接比较，全部相同；`new Function(getScript())` 语法检查通过。

| 输出 | 搬迁前 SHA-256 | 搬迁后 SHA-256 | 前后字节数 |
| --- | --- | --- | --- |
| `getScript()` | `57e2c46b33ec08dd489d4d1728c0a7c7b4ab9b92bc6898ae3458de265ae49e8e` | `57e2c46b33ec08dd489d4d1728c0a7c7b4ab9b92bc6898ae3458de265ae49e8e` | 808289 |
| `getStyles()` | `00b7dcf0710a503c10c0e9b452d25ddb8ed3bff46fac5bf1378f773f2f86ff12` | `00b7dcf0710a503c10c0e9b452d25ddb8ed3bff46fac5bf1378f773f2f86ff12` | 144096 |
| `getTemplate()` | `9a56347a3857281e5b6498cad19dd3f348405638610b9be4bb046f3c998eb1df` | `9a56347a3857281e5b6498cad19dd3f348405638610b9be4bb046f3c998eb1df` | 50892 |

临时门禁 `test/conversationsRelocation.test.ts` 曾加入默认 runner。搬迁前先实测基线，再临时向 `getScript()` 中非搬迁区域增加一个空格；门禁按预期以 `getScript bytes changed` 失败，还原后通过。CSS、B1、B2、B2b、B3、B5 每步均重新 `build:test` 并单独运行门禁，全部通过。门禁及其 runner import 已按建议删除，避免未来有意 UI 变更必须重录这次历史基线。最终构建仍与搬迁前快照做了直接字节比对。

独立源码审查还将六个 fragment 的模板原文分别与 HEAD 原区块比较，并将占位展开后的完整 `return` 模板与 HEAD 比较，均完全相同。状态声明位置、共享词法作用域、监听注册顺序、三个 host 分支及标题测试的文本切片顺序均保留。

| 外壳文件 | 搬迁前行数 / 字节 | 搬迁后行数 / 字节 | 减少 |
| --- | --- | --- | --- |
| `src/webview/script.ts` | 7962 / 336734 | 7097 / 300748 | 865 行 / 35986 字节 |
| `src/webview/styles.ts` | 2192 / 55576 | 1916 / 47896 | 276 行 / 7680 字节 |

脚本搬走原文共 885 行，五处占位减少 880 行，再增加导入和外壳注释，净减少 865 行。样式搬走 278 行，换成一行占位并增加一行导入，净减少 276 行。`script.ts` 实测仍约 301 KB（294 KiB），任务中约 240 KB 的体积预估偏小；未为达到体积预估扩大范围。

## 验证状态

| 验证 | 搬迁前 | 最终工作树 |
| --- | --- | --- |
| `bun run compile` | 通过 | 通过 |
| `bun run lint` | 通过 | 通过 |
| `bun run build:test && bun run test` | 1334 项，1333 通过、1 跳过、0 失败，约 525.56 秒（含临时门禁） | 1333 项，1332 通过、1 跳过、0 失败，约 515.69 秒（门禁已删除） |
| 三个 getter 的 SHA-256 / 直接字节比对 | 基线已保存 | 全部相同 |
| 生成脚本语法 / 源码展开复原 / `git diff --check` | — | 通过 |

完整测试 runner 包含 `sessionTitleWebview`、`inputComposition`、`sessionNavigation`、`executionTimeStats`、`applyWorkflow`、`draftRunBatch`、`startupPerformance`。`sessionTitleWebview` 的 7 次 `between()` 继续读取完整生成结果，不依赖 fragment 的物理文件位置。

前后同一跳过项为 `local fault server exercises delayed headers, disconnection, delayed EOF and healthy connection reuse`：测试报告当前沙箱不允许绑定本地故障服务器端口。此项未执行，不计为通过；本次未修改测试或绕过其条件。

未进行原生 VS Code UI 手测，不能把 DOM stub 测试称为原生验收。现有自动化覆盖菜单点击开关、其它项目选择、历史会话切换和后台标题刷新（去重、旋转、焦点与编辑草稿保持）。以下观感和原生事件链仍待 F5 抽查：菜单开关、Escape、外部点击关闭、切换其它项目、时间范围与收藏筛选、多选批量删除、重命名 Enter/Escape/失焦、后台标题刷新。

## 明确的代价

本次没有模块封装边界。Fragments 仍共享同一运行时词法作用域，均可读写 `state`、`promptInput` 等状态，B1 仍使用 `let` 并保持 TDZ 顺序。

三个生成产物字节相同，因此 Webview 运行代码与行为不变，按构造没有前端运行性能收益。未做性能优化或宣称局部更新收益，也没有引入 memo 缓存。`script.ts` 仍是总外壳；如果以后要会话列表局部更新或性能契约，需要另行进行组件化设计并采用不同于本次字节冻结的验收方式。
