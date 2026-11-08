# KeepSeek 任务侧栏验收记录

日期：2026-11-08，Asia/Shanghai。Git 基线：`d5f941dfb941f58c14267fdb4a8663e826275e10`，`package.json` 0.5.3。本轮接续时工作树已包含侧栏实现与先前验收记录；逐项核实并保留已有改动，没有将其还原成干净工作树。产品与数据合同见 [项目助手](keepseek-project-assistant.md)，交互/草稿/临时 UI 见 [交互生命周期](keepseek-interaction-lifecycle.md)。本文件区分受控自动化、原生 UI 与真实 Provider 证据，不以 mock/Node DOM 代替原生几何或实际账单。

## 本轮命令与证据

下表记录本轮最终代码的实际复验结果；各专项独立运行，数字不可相加当作全仓统计。最终全量期间没有并行编译或基准测量。

| 检查 | 本轮结果与范围 |
| --- | --- |
| `bun run compile` | 通过，退出码 0 |
| `bun run lint` | 通过，退出码 0 |
| `bun run build:test` | 通过，退出码 0 |
| `bun run test` | 最终退出码 0；共 1512 项，1511 通过、0 失败、1 环境跳过；18 suites，739354.745268ms（约 12 分 19 秒） |
| `git diff --check` | 通过，退出码 0 |
| 时间、排序、24h、恢复及操作身份回归 | 本轮 `projectTasks` 44/44 通过，包含相同依赖等待复查不续期、事务内过期身份拒绝 |
| 快照 producer 身份、lane/revision、旧结果拒绝 | 本轮 `taskUsageSnapshot` 9/9、实际 `projectAssistantViewHost` 7/7 通过；含保存失败、恢复、模型配置往返失效、历史真实结束时间及旧 Host/过期操作拒绝 |
| Webview 草稿、IME 事件、键盘/焦点和节点复用 | 本轮 `projectTaskWebview` 40/40 通过，0 跳过；含普通历史草稿隔离、IME 期间 ACK 延后、tooltip 描述切换、最高层 Escape 与有界状态播报；自动事件不证明真实中文输入法 |
| 静止及运行中 Worker 的请求归因 | 本轮三协议受控 transport 专项 6/6 通过，最终默认全量再次全部通过并更新请求 JSON；侧栏归因请求均为 0 |
| 原生 VS Code | 本轮在 Mac 原生 Extension Development Host、浅色主题和 Restricted Mode 中观察空任务窄栏、展开范围/归档/更多/汇总浮层；一次点击输入关闭后粘贴两行中文草稿，内容与焦点保留、未发送；完整矩阵、可靠几何和真实 IME 待现场 |
| 真实 Provider 缓存命中/账单 | 未安排真实付费调用；不报告改善 |

唯一跳过项是既有 `test/providerNetworkRecovery.test.ts` 中的本地故障服务器测试：绑定监听端口返回 `EPERM`，触发该测试原有的环境跳过分支（“This sandbox disallows binding a local fault server.”）。未删除断言、改为跳过或降低校验；其余三协议网络恢复和流式恢复回归仍执行。

本轮首轮全量与编译、专项及基准重叠，1495 项中 1493 通过、1 失败、1 环境跳过，退出码 1（802452.484746ms）。唯一失败是未修改的 10K 用量账本性能断言：实测 17.35 秒超过原有 15 秒阈值。保留该阈值，在最终代码稳定且不并行编译/基准后重新完整运行，同一测试以 12.22 秒通过。接续前记录的 1493 项全量结果仅为此前证据，不用来替代本轮 1512 项复验。最终全量后仅更新验收文档，生产代码与编译输出保持不变。

本轮原生尝试选择了临时 fixture 的 driver workspace，但未载入其 20 张种子卡，处于 Restricted Mode；没有更改信任状态、执行任务或发送模型请求。展开浮层在真实截图中位于正文区域且止于 composer 之上，但未取得可靠 bounding boxes 或可链接的本地截图文件。原生 Terminal 自动化的应用访问被拒绝，未绕过该限制。先前记录另有 debugger/CLI profile 未使用种子存储、observer 窗口和 DevTools self-XSS 保护阻止自动几何注入的限制，未将这些保护关闭。上述视觉冒烟不证明多任务、各宽度、高度收益或真实中文 IME。

默认 runner 是 `test/runTests.ts`。新增专项须接入默认入口，原有三协议 payload/replay、前缀字节、审批、Apply、DraftRun、预算与恢复测试继续运行，不能通过重录冻结 fixture 改写本次结果。

## 变更与存储核对

| 范围 | 核对项 |
| --- | --- |
| 壳层 | 44px 固定窄栏；浮层锚定正文阶段；删除旧顶部最大 45vh 任务布局 |
| 列表 | 首次时间升序，同毫秒 Registry 原序；按 taskCardId 复用节点，无状态优先分组 |
| 时间 | firstSubmittedAt/source 不可变；lastActivityAt 仅真实业务活动，旧数据不使用 updatedAt/恢复 now 续期；相同等待复查不续期，历史长回答采用可证实完成/等待时间，歧义 stopped 不作新活动 |
| 兼容 | 物理 Registry v2 与旧内联 v1 均读取，保持正文对象 hash/scope 校验；不改旧 createdAt 和 Provider 请求字段 |
| 恢复 | owner 保存运行态转 interrupted，不恢复执行；observer 只读保留 owner 运行态；关闭/重启不制造活动 |
| 用量 | 独立 `task-context-usage.json` v1；300ms 合并发布、1000ms 合并轻量原子保存；身份/lane/revision 隔离，恢复显示上次记录，未知与真实 0 分开 |
| UI 偏好 | 项目+窗口状态与旧草稿 expanded 分离；合并 Webview state，不覆盖 pending ACK/引用/markup |
| 权限 | 查看、范围和过期不授权；停止/继续/归档/删除携带 Host/session/root/segment/generation，并在 Registry 事务内复核冻结身份；owner、信任、外部路径、脏编辑器与 permit 硬边界保留 |

入口迁移表在 [项目助手：左侧任务窄栏与浮层](keepseek-project-assistant.md#左侧任务窄栏与浮层)。原顶部布局移除后，项目助手、新任务、停止/继续/停止全部、关联/归档/恢复/删除、证据、Router 统计和普通历史均须按该表实际可达。

主要修改文件按职责列出，完整差异以工作树为准：

| 文件 | 改动 |
| --- | --- |
| `src/tasks/projectTasks.ts`、新增 `taskSidebarMetadata.ts` | 时间字段、旧 Registry 归一化、真实活动边界、稳定展示排序和最近范围 |
| 新增 `src/tasks/taskUsageSnapshot.ts`、`src/shared/types.ts` | 展示快照类型、来源/版本校验与恢复 |
| `src/agent/runner.ts`、`src/provider/KeepseekChatViewProvider.ts` | 估算开始时捕获真实执行与投影身份；不改请求正文 |
| `src/provider/projectAssistantHost.ts`、`webviewMessages.ts` | 每卡轻量快照、合并发布、独立原子保存、历史时间证据、Host 与事务内操作身份核验 |
| `src/webview/projectTasks.ts`、`template.ts`、`script.ts`、`src/shared/i18n.ts` | 固定窄栏、正文浮层、圆环、tooltip、键控节点、草稿/IME/legacy 和双语文案 |
| `test/projectTasks.test.ts`、新增 `taskUsageSnapshot.test.ts` | 时间、兼容、等待复查、用量来源与迟到事件 |
| `test/projectTaskWebview.test.ts`、`webviewDomHarness.ts` | 受控时钟、Webview 行为与节点身份、临时 UI 层级及 IME 结算 |
| `test/projectAssistantViewHost.test.ts`、`projectTaskEntryPoints.test.ts`、`runTests.ts` | 真实 Host、保存失败、有限查看、请求归因、不同模型窗口及默认入口 |
| 新增 `scripts/benchmark-task-sidebar.cjs`、`prepare-task-sidebar-native.cjs` | 可重复离线测量与临时原生验收数据准备 |
| `doc/keepseek-project-assistant.md`、`keepseek-interaction-lifecycle.md`、`README.md`、本记录及两份 `doc/benchmarks/keepseek-task-sidebar-*.json` | 产品/开发合同、F5 步骤、实际证据与限制 |

## 请求与性能证据的解释

[受控请求记录](benchmarks/keepseek-task-sidebar-requests-20261108.json) 来自实际 Host/Provider/Runner 经受控 fetch，未调用付费 Provider。每项包含开合、最近/全部/归档、hover/focus、A→B→A、恢复草稿、最新本地页、返回项目、ready/重连及到期重算。请求逐条保留 card/session/root/segment/runtime/role 和 payload/system/有序 tools/首条真实 user 的字节 hash。

| 场景 | 操作前 → 最后结算 | 正常推进与侧栏归因 |
| --- | --- | --- |
| Chat Completions 静止任务 | 4 → 4 | 原两项 Worker 与两项完成标题；侧栏新增 0 |
| Chat Completions 后台 Worker 正常继续 | 3 → 5 | 增加 1 项正常 Worker 续跑与 1 项完成标题；侧栏新增 0 |
| Responses 静止任务 | 4 → 4 | 原两项 Worker 与两项完成标题；侧栏新增 0 |
| Responses 后台 Worker 正常继续 | 3 → 5 | 增加 1 项正常 Worker 续跑与 1 项完成标题；侧栏新增 0 |
| Anthropic 静止任务 | 4 → 4 | 原两项 Worker 与两项完成标题；侧栏新增 0 |
| Anthropic 后台 Worker 正常继续 | 3 → 5 | 增加 1 项正常 Worker 续跑与 1 项完成标题；侧栏新增 0 |

六项场景 Router/reviewer/summary/child 均为 0。运行中续跑原卡/root 不变，静态 system、有序 tools 与首条真实 user hash 保持，完整 payload 因正常续跑而合法增加历史。静止场景还逐字节比较操作前后的持久化完整历史，包括 native replay。不能将正常完成标题归成侧栏调用。请求记录来自真实 Host/Provider/Runner 的三种协议序列化与受控 fetch，补充默认三协议旧字节/replay 回归；不是上游真实账单或缓存命中证据。

请求专项可重复执行：

```bash
bun run build:test
KEEPSEEK_SIDEBAR_REQUEST_EVIDENCE_PATH=/tmp/keepseek-sidebar-request-evidence.json node --test --test-name-pattern='sidebar gestures|sidebar display gestures' out-test/test/projectTaskEntryPoints.test.js
```

同一受控 transport 场景还通过真实 Provider → Host 发布链验证了不同模型窗口的圆环数据，未用前台全局用量填卡。A/B 的 project/card/session/root/segment/generation/Host、独立 runtime/lane/config 均逐项核对；详情在请求记录 JSON 的 settled 快照中。

| Worker | 分子 / 分母 | 上下文占用估算 |
| --- | --- | --- |
| A（entry-model） | 2484 / 64000 | 3.88125% |
| B（entry-wide） | 2484 / 128000 | 1.940625% |

三个协议的受控模型链路均得到上述独立快照；不是原生绘制、真实付费模型或实际账单证据。本轮只为补强证据扩展测试，不改冻结协议或 fixture。

实际 Host 的另一个受控测试在 100 次同步用量事件期间记录 `registryWritesDuringSamples=0`、`fullSessionReadsDuringSamples=0`，直到终态合计发布 5 次。独立用量元数据共 2 次写入尝试：第一次故意注入保存失败，第二次成功重试；不得表述成 2 次成功写入。该测试同时验证保存失败不破坏任务 completed、耐久 ACK 或停止边界，以及模型配置 A→B→A 不复活旧分母。计数来自 `projectAssistantViewHost.test.ts` 的实际 Host/文件系统/存储方法拦截，不由 DOM 指标推断。

[本轮 DOM 测量](benchmarks/keepseek-task-sidebar-20261108.json) 与 `scripts/benchmark-task-sidebar.cjs` 记录 Darwin 25.5.0 x64、Node v24.15.0、Intel i9-9880H 环境下完整生成脚本的 Node VM harness 前后样本；当前浮层打开，基线为原顶部任务区域，每种规模 3 次、每次 50 次卡片更新。基线产品源码直接只读取自 Git `d5f941d…`，当前产品源码取自工作树；两侧使用相同当前 harness，JSON 记录源码及生成脚本/模板 SHA-256。本轮检查确认 harness hash 相同、当前 `projectTasks.ts` hash 与采样源码一致；不通过切换工作树或重写编译输出伪造基线。

| 卡数 | 修前每样本创建节点 / 列表清空 | 修后创建节点 / 列表清空 | 修后保留行身份 | 修前 / 修后同步耗时范围 |
| --- | --- | --- | --- | --- |
| 10 | 6,700 / 50 | 0 / 0 | 列表 10/10，窄栏 10/10 | 430.640–662.203ms / 617.623–642.110ms |
| 100 | 38,200 / 50 | 0 / 0 | 列表 100/100，窄栏 100/100 | 952.704–1068.042ms / 2442.336–2630.819ms |

修前后所有样本 transcript 清空均为 0。证据支持节点复用；该 fake DOM 的同步耗时反而增加，不能宣称提速。该耗时不包含原生布局/绘制，也不据此报告原生 p95 或聊天高度收益。Registry 写入/会话全文读取不能由 DOM 指标推断。

复验命令（依次运行，不并行计时）：

```bash
bun run build:test
node scripts/benchmark-task-sidebar.cjs baseline d5f941dfb941f58c14267fdb4a8663e826275e10
node scripts/benchmark-task-sidebar.cjs current
```

## 可重复 F5 原生验收

使用新建的临时工程和隔离开发宿主存储。先执行默认编译和测试，再用仓库已有 `Run KeepSeek Extension` 启动配置按 F5。不要把生产会话、用户工程或系统时钟作为 fixture。需要状态/时间/lane 注入时使用受控 fixture/transport；没有该原生数据接线时记录相应场景待验证，不额外调用付费模型获取截图。

可选离线原生数据准备入口：

```bash
bun run compile
bun run build:test
node scripts/prepare-task-sidebar-native.cjs
```

脚本在 OS 临时目录创建分离的 driver/目标工程、profile 和扩展存储，预置 20 张状态/不同窗口/未知与 0%/过期卡和本地历史，无模型凭据或可执行队列。优先在外部终端执行输出的 `launchCommand`（macOS/Linux 包含 `env -u VSCODE_IPC_HOOK_CLI code …`）启动独立实例，再执行 `KeepSeek: Open Chat`。核对实际 profile/storagePath：浮层切到全部任务后应有 20 张预置卡，默认最近窄栏应有 19 张（E 已过期且尚未查看）。未载入时停止把该窗口当作种子验收环境。

F5 备选路径是打开输出的 `Task_Sidebar_QA.code-workspace`，选择 `Offline KeepSeek sidebar QA`。本机尝试中 debugger/CLI 未如预期使用种子 profile，不能承诺 F5 隔离已成功；须先核对启动参数和实际存储。fixture 可以供布局、查看、草稿与 last-known 展示验证，不能证明真实执行或实时快照。**不要对展示 fixture 点继续或提交**；执行/审批使用另外的受控临时任务。每次运行生成新隔离目录，不修改系统时钟或现有会话。

每组记录 VS Code/平台/主题、工作树基线、Webview CSS 像素宽高、任务数、历史消息数、composer 行数、冷热定义、样本量及截图。打开 `Developer: Open Webview Developer Tools`，选择 KeepSeek iframe 执行测量。仅原生执行下列 DOM 读取才是几何证据：

```js
function taskSidebarGeometry() {
  const rect = selector => {
    const node = document.querySelector(selector);
    if (!node) return null;
    const b = node.getBoundingClientRect();
    return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom };
  };
  const transcript = document.getElementById('transcript');
  return {
    viewport: { width: innerWidth, height: innerHeight },
    header: rect('.header'), rail: rect('#projectTasks'),
    transcript: rect('#transcript'), stage: rect('.project-transcript-stage'),
    target: rect('#projectInputTarget'), input: rect('#promptInput'),
    sidebar: rect('#projectTaskSidebar'),
    scrollTop: transcript?.scrollTop,
    firstVisibleMessage: [...(transcript?.querySelectorAll('[data-message-id]') || [])]
      .find(node => node.getBoundingClientRect().bottom > transcript.getBoundingClientRect().top)
      ?.getAttribute('data-message-id'),
    horizontalOverflow: document.documentElement.scrollWidth > innerWidth
  };
}
// 保存手动打开前/后的返回值；点击真实按钮，不通过脚本合成鼠标行为。
console.log(taskSidebarGeometry());
```

1. **几何和动态输入**：把面板调为 300、380、600px；每种宽度再测低高度、空输入、多行输入、引用/Skills 芯片。正文滚到中间，分别打开/关闭浮层各 5 次，记录上面数据和截图。header/transcript/input 的 x/y/width/height、scrollTop 与可见消息锚点应保持；浮层上缘不越过正文 stage，下缘止于输入目标提示，宽度不超过剩余区，无横向溢出。窄栏预留宽度与移除旧顶部任务区释放的高度分别记录，不能只比较整个窗口大小。
2. **任务顺序和状态**：受控创建 A/B，再新建 C。依次令 A running→waiting→completed，B failed/cancelled/interrupted，C queued；任务相对顺序始终按首次时间。检查所有状态的颜色、图标、tooltip、waiting reason 和 stopping 结算。归档仍运行的任务必须继续显示并可停止；终态完成不得让环变 100%。超过高度时滚到最后一项，Tab 也能达到。
3. **独立用量**：A/B 使用不同来源/窗口的受控估算，在前台只查看 B 时更新 A；两环仅接受自身快照。交错投递旧 Host/generation/segment/lane/revision，确认不倒退覆盖。新 epoch/压缩后允许占用下降；无估算显示未知，真实 0 显示 0，超限在详情保留原始值；重建显示上次记录及时间。
4. **范围和恢复**：用受控时钟/存储数据构造 24h 前后边界、跨午夜、长期 queued/waiting、长任务刚结束、缺失活动和旧历史关联。只查看的过期终态留在原位置并标当前查看；离开后隐藏。全部/归档可访问历史；到期不切输入目标、不删除审计。标题、统计、ready、归档/恢复和重启不能续期。
5. **草稿和普通历史**：A 留多行草稿、引用、Skills、选区和旧消息锚点，切 B 再回 A；检查内容和位置。先发送再编辑较新草稿，迟到旧 ACK 不清新稿。普通历史、新普通会话和 legacy sendPrompt 显示正确目标，后台任务继续；历史标题编辑/刷新反馈保留，侧栏查看不触发刷新。
6. **真实中文 IME**：使用系统中文输入法在 A 输入未确认拼音/候选；保持合成时点击 B，再确认候选。最终文字留在 A，目标在 compositionend 后切 B，过时选择不生效，无误发送。重复候选 Enter/Escape、开合、后台更新；输入法优先且无内容丢失。自动 composition 事件回归只作补充。
7. **临时 UI 和外部点击**：浮层打开时点击输入框一次即可定位，点击设置一次即可打开，点击发送一次只提交一次；浮层内部/tooltip/更多菜单不误关。分别打开命令、@、更多与设置，Escape 每次只关最高层；键盘关闭可回触发按钮，鼠标关闭不抢焦点。
8. **原有编辑与动作**：验证拖拽、@ 引用、Skills、编辑重发、历史分页/最新消息、Run Details、停止/继续、审批、Apply/Discard。所有文件/命令副作用只在临时工程执行。A 操作发出后切 B，审计和真实副作用仍属于 A 的原 session/root/segment/target/hash/runtime。
9. **owner/observer 与重启**：同一临时项目开双窗口；observer 可查看/保存自身草稿，不能停止/继续/归档/删除/Apply 或调用模型；读取 owner running 时不能本地改 interrupted。关闭 Webview 再开不停止宿主任务；关闭/重启扩展仅恢复中断说明，旧批准/permit/队列不复活，活动时间不变。
10. **主题和无障碍**：深、浅、高对比主题和减少动画分别测。仅键盘完成展开、任务查看、范围、关闭；未知环不出现假的 aria-valuenow，SVG 无额外焦点，状态可从文字/图标辨认，终态通知有界且不逐 token 播报。检查标题/进度/错误中 `<script>` 等测试文本只显示文字。
11. **请求与性能复验**：静止与受控后台推进各跑 hover/开合/范围/查看/返回/最新/ready 序列。按 card/root/role 归因，记录请求/账本和 payload 摘要。原生测量开合/切换时间时列全部样本；样本不足不报告 p95。截图与实测记录保留到本报告链接，受控 transport 结果不证明真实账单或上游缓存命中。

## 交付状态与限制

代码与文档留在工作树交付；本任务不提交、不打标签、不推送、不提升版本、不安装或发布市场包。原生 UI、真实中文 IME、真实 Provider、Windows/Linux/远程宿主只按实际证据标记；未执行项保留为待现场验证，不能因默认测试通过而删除。
