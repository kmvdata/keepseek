# KeepSeek 功能保持型重构验收

调查日期：2026-11-05（Asia/Shanghai）。基线为 `76edec65ee60a1639ddf5302507bb8780e96b674`，不是提示词参考的 `0e7b961`。开始时 `git status --porcelain=v1 -uall` 为空；近期审批菜单与审批模型位置已在该 HEAD。全部开发改动留在工作树。

审批路径与现场预期均按下述历史基线阅读。现行步骤见[帮我审批验收](keepseek-approve-for-me-verification.md)。

## 范围与基线

已核查 `src`、`test`、`scripts`、`doc`、根文档、清单/构建/忽略规则、运行依赖与资源的入口和消费者。按职责选择三批源码变更，未对大文件一律拆分。基线副本来自本次起始工作树的已跟踪文件，不含秘密、用户会话或 Git 数据；复用现有工具与依赖，不下载或升级。

实施顺序：入口/契约盘点与基线 → 审批控制流与纯批次规则 → 会话 replay 纯规范化 → Runner 死子图 → 文档/验收脚本 → 整体检查与独立只读复核。默认测试按原 runner 顺序执行，临时 Git/文件/迁移数据由既有 fixture 隔离。

## 清理与保留账目

| 对象 | 调用与兼容证据 | 处理和保护 |
| --- | --- | --- |
| Provider `executeDelegatedApprovals` 的 `automatic` | 同步 `normalizeApprovalMode` 仅返回 ask/delegate；ask 在该方法开头返回，因此后续恒为 delegate | 常量传播，删除恒假分支；保留硬检查、reviewer、人工请求、取消与副作用顺序。审批三组回归及基线特征验证 |
| 批次初始化/已完成判定 | 同一审批方法内的可独立判定规则，与 VS Code API 无关 | 移至现有 `approvals/approvalProcessing.ts` 的 `createApprovalProcessing` / `isCompletedApprovalBatch`；Provider 保留执行编排。新增 denied/hard_blocked 恢复不得执行依赖命令的 Host 回归 |
| Store 的原生 replay normalizer | 闭合的纯验证/深拷贝子图；Store、Provider、Responses/Anthropic 测试有直接消费者 | 移至 `sessions/providerReplayNormalization.ts` 并迁移全部 import；无旧 re-export、无双实现。原常量/函数体原字节保留，保存队列/布局/版本不动 |
| Runner 旧结果裁剪子图 | `shapeToolResult` / `shouldSnipToolResult` 无生产、动态字符串、迁移或测试入口；相关搜索/范围裁剪仅内部互调 | 删除 10 个方法、10 个独占常量、2 个 helper 与唯一 import；84 个存活方法及存活顶层 helper 正文逐字相同。真实交付仍走 intent/evidence/admission/envelope |
| `agent/toolResultShaping.ts` | 其唯一消费者是上述死方法；无独立测试、资源、脚本或文档消费者 | 随死子图删除 33 行模块。活跃 `ShapedToolResult`、`parseToolResultObject`、native token 估算保留 |
| 测试 `legacy_removed` 分支 | 当前测试循环仅 delegate，哨兵比较恒假；分支内点击/执行断言从未运行 | 清除永假断言，保留旧 V1 只读审计、Diff/Discard、ask 与拒绝场景；新增 V2 恢复不授权范围、busy/startup/deny 和 V1 无恢复按钮的可执行生成脚本回归 |
| 布局验收脚本 | 原脚本给 V1/model_review 状态却要求当前恢复按钮，与生产脚本的 delegate/V2 门禁冲突 | 更新为当前 V2 与只读 V1 分场景；ask 状态显式清空旧审批投影。修复验收工具，不改变产品 UI；尚未在浏览器运行几何矩阵 |
| `verify-vsix.js` / `.vscodeignore` | 动态 `${provider}.svg` 由 `html.ts` 生成，旧校验未检查；错误提示引用不存在的 build 命令。包清单还发现无运行消费者的本地编辑器元数据 | 检查当前整个 `resources` 的 SVG/PNG，不再维护第二份 provider 清单；排除并拒绝 `.reasonix/` 元数据，提示指向 `bun run package:market`。此项单列为验收发现的原有打包缺陷修正，未删除本地文件 |
| 旧审批类型/冻结协议 | 历史审计、normalize、受版本门控的 system/schema 及恢复测试仍消费 | 保留 `model_review` 历史读取和旧字节；不恢复旧产品选项，不提升协议版本 |
| 历史报告与 benchmark JSON | `p1ProtocolDelivery.test.ts` 直接读取 frozen JSON；其余历史数据/独立脚本有审计用途 | 原字节与路径保留，文档导航明确历史范围；不按日期、P0/P1 文件名删测 |
| 大型 Webview、Runner 活跃主流程、Store 保存队列 | 共享 IIFE/fragment 顺序、事务/恢复及 revision/manifest/flush 时序存在独有合同 | 保留。此次无足够收益支撑重写这些状态机；输入字节 fixture 继续保护初始化/词法顺序 |
| Store runDetails normalizer | 共用 timestamp/string/number/scope 规则 | 保留，避免增加共享辅助层或重复 normalizer |
| 其他命名相似候选 | `hashStableText` 是 16 位诊断 hash，`hashText` 是完整权威 hash；空 `AgentRunner extends AgentLoop` 有主/child 身份消费者 | 语义不同，保留。`legacyStage`/`legacyAdd` 仍服务有效 Git argv 合同 |
| `scripts/clean.js`、`test/tsconfig.json` | 无默认脚本引用不足以排除独立手动/编辑器消费者 | 保留；独立入口的支持意图未能进一步证明，不制造删除或替代层 |

没有删除有效测试用例、放宽校验、增加 skip 或重录冻结 fixture。仅不可达测试分支被删除。

## 职责和权威入口

| 关注点 | 之前 | 现在 |
| --- | --- | --- |
| 审批批次纯规则 | Provider 内嵌 | `approvalProcessing.ts` 单一实现；Provider 只调用并继续协调服务 |
| 原生 replay 数据规范化 | `chatSessionStore.ts` 混合纯验证与存储 | `providerReplayNormalization.ts` 单一入口，仅依赖共享类型与纯 `isRecord` 守卫；Store 保留会话/持久化责任 |
| 工具结果交付 | 现用 evidence 管线旁残留无入口裁剪实现 | 仅保留现用 evidence/admission/envelope 权威 |
| 当前文档路由 | 大型旧架构地图与多处“当前 V10/V11” | [文档导航](README.md) → 当前专题；父 request/schema、child、审批、结果合同与存储分别列版本来源 |

文件规模仅辅助审阅：Provider 7947→7920 行，Runner 5829→5618 行，Store 1872→1619 行；新 replay 模块 259 行；架构地图 834→146 行。它们不作为性能收益或正确性的证明。未新增通用 utils、服务定位器、存储层或第二套授权/投影/副作用执行接口。

## 功能/契约矩阵

下列“自动验证”指确定性 fixture、VS Code stub、模拟上游响应和真实临时文件系统/仓库；不代表真实模型或原生 VS Code 验收。

| 合同 | 入口 → 权威实现/数据 | 自动保护与结果 |
| --- | --- | --- |
| 启动、来源/模型、超时和菜单 | package contributions → extension/Provider → accountResolver/modelSelection/config | account/model/config、startupPerformance、contextEntryPoints；默认回归覆盖 |
| 三协议与稳定字节 | AgentLoop → buildProviderRequestProjection → 原生 clients/replay | protocolCache/cacheByteStability、Responses/Anthropic/Kimi/GLM/Qwen、stream/recovery；45 组字节比较一致 |
| 输入、引用、Skills | html/input composition → references、SkillDiscovery/ActivationResolver/Loader | inputComposition/contextEntryPoints、fileReference/referenceResources、skill*；原冻结字节不变 |
| 审批与文件/命令副作用 | Provider → host policy/reviewer/manual → SafeFileEditor/DraftRunExecutor | approvalMode/reviewer/taskApprovalIntegration、applyWorkflow/textPatch/draftRun*；两模式、旧审计、hash/permit/单次/取消/恢复保护 |
| 长任务与子代理 | AgentLoop → evidence/admission/epoch → SubagentRuntime/result store | toolResultBudget、longRunningAgent、p1ProtocolDelivery/subagent*；分页、scope、恢复、未知副作用与任务预算 |
| 存储与恢复 | ChatSessionStore → SessionObjectStore/GlobalSessionStorage/CoalescedWriter | chatSessionStore/longTaskPerformance/p0SubagentPersistence；旧格式、失败/并发保存/manifest/flush |
| 用量与计时 | recordUpstreamUsage → ledger/stats、executionTimeStats/userTask | usage*/executionTimeStats/subagentUsage*；请求幂等、费用预算、逻辑任务与累计时间 |
| 市场包 | package-market → tsc → vsce --dependencies → verify-vsix | 清单、入口、11 个资源与 3 个生产依赖对照；结果见下面打包记录 |

## 验证证据

默认检查和本地市场包已完成，无已知新行为回归；包清单发现的编辑器元数据排除已复验通过。完整默认 runner 当前显式导入 89 个 TypeScript 测试文件；独立 audit 脚本另行运行。

| 检查 | 原基线 | 重构后 |
| --- | --- | --- |
| `bun run compile` | 通过，8.912s | 通过，10.560s |
| `bun run lint` | 通过，8.159s | 通过，8.641s |
| `bun run build:test` | 通过，13.381s | 通过，16.056s |
| `bun run test` | 1017 总项：1016 pass、0 fail、1 环境 skip；552.218s | 1021 总项：1020 pass、0 fail、同一环境 skip；469.831s |
| `bun run package:market` | 通过，21.522s | 通过，21.497s；完整性检查通过 |
| 审批特征 / 相关回归 | 加新特征后 88/88 | 127/127 |
| replay/Store/原生协议相关回归 | 新 Store 特征移动前 10/10 | 42/42 |
| Runner/evidence/协议相关回归 | 冻结原方法用于逐字比较 | 74/74 |
| V2 卡片恢复新增特征 | 1/1 | 1/1 |
| `node --test scripts/field-acceptance-audit.test.cjs` | 独立既有入口 | 2/2 |

基线环境 skip 是 `providerNetworkRecovery.test.ts` 的本地故障服务器：沙箱禁止 bind（EPERM）。没有添加、删除或放宽此 skip。首次集成 build:test 曾因清理后的测试 mode 推断成 string 报错，已以 `as const` 修正测试类型并通过重跑；未修改产品逻辑。

字节与兼容证据：

- 两种语言 × V1–V13 的静态 system、13 份完整工具 schema、6 份 Webview/input 生成正文，共 45 组；前后 hash/字节数全部相同。输入 fixture 未刷新。
- replay 的原常量和函数体搬迁比较 SHA256：`4e2d6d4d58c3849670eda5f18c891bb60c4eb5f9c5355a6c8761fc058c703e1b`。原生密文/签名、user/expandedContent、未知块原子丢弃及 Webview 隐藏的特征测试先在原实现通过。
- package/lock、protocol/projection、审批交付协议、输出预算、usage ledger、executionTimeStats、SessionObjectStore/CoalescedWriter、冻结 JSON 与 CHANGELOG 共 13 个关键文件原字节不变；不存在存储或协议版本升级。
- 本次仅移出纯规则和删除不可达代码，未改变持久化或请求热路径算法；没有以单次 wall time 或 LOC 下降声称性能提升。

隔离副本初次打包因整目录符号链接让 npm 把依赖当作 linked packages、继续枚举其开发依赖而失败；改为硬链接复用现有生产依赖/类型声明、链接现有 CLI 后，同一原始 `package:market` 流程通过。未复制依赖缓存、安装、改依赖或锁文件。原始运行日志与隔离基线保存在本次临时 evidence 目录，最终报告保留结果、HEAD 和可重复命令。实际环境为 Bun 1.3.12、Node v24.15.0；当前 macOS x64 宿主。以上耗时来自并发负载下各次运行，不作性能对比。真实 token/账单、付费模型、原生 VS Code、Windows/Linux 均未现场验证。

## 包清单与故障校验

同一 `package:market` 流程的包快照为：

| 对照 | 原基线 | 重构后 |
| --- | --- | --- |
| VSIX 字节 | 4,985,710 | 4,983,331 |
| entry 数 | 824 | 826 |
| 资源 | 11 | 11，全部原字节一致 |
| 生产依赖文件 | 265 | 265，路径与字节全部一致 |

entry 差异仅为新增 `doc/README.md`、本报告、`out/sessions/providerReplayNormalization.js/.map`，删除 `out/agent/toolResultShaping.js/.map`。`package.json`、main/icon、所有模型 SVG、ignore/yaml/confbox 保持；入口与新模块均存在，无陈旧已删模块。包大小仅记录实测，未将其微小变化解释为性能提升。快照采样在源码/打包规则定稿后、结果写回本报告之前。

原包曾混入 4 个无运行消费者的 `.reasonix/` 本地编辑器元数据文件；现只排除、不删除这些文件。最终包无此类条目。三个临时损坏包分别移除 qwencloud.svg、移除 yaml/package.json、插入合成元数据，`verify-vsix` 均以 exit 1 拒绝并指出相应条目；真实包以 exit 0 通过。没有使用 `--no-dependencies` 或 reinstall，没有安装/发布扩展。

## 文档、Skills 与独立复核

[doc/README.md](README.md) 是专题导航；[架构地图](keepseek-code-architecture.md) 管当前职责；runtime、cache、API、SUBAGENTS、共享配置/插件、引用各保留唯一专题。中英文 README 已修正两模式、项目级持久化、审批模型菜单层级与用户级独立配置；旧截图标为历史。历史报告不追加新的当前规范、不搬移 JSON。

10 份当前文档（含本报告）的 179 个本地链接/锚点及代码围栏检查通过；AGENTS 按项目 token 估算规则为 3832，低于默认 4000 预算。

本次核查 `.agents` 下没有现有项目 Skill 文件。源码 `sharedConfigPaths.projectSkillsUri` 确认标准项目路径是 `.agents/skills/<name>`，`skillMetadata` 缺 YAML 时确实默认允许 implicit；既有 discovery/loader/activation 测试保护 `policy.allow_implicit_invocation: false`。审批、Provider 长上下文、Webview 工作流均有重复验证价值，但本会话权限将 `.agents` 设为只读，因此未创建、安装或换路径放置 Skill，也不宣称客户端发现了新 Skill。先由当前文档导航提供路由，未设置 workspace-default 或隐式激活。

两轮独立只读复核未发现尚未处理的产品行为回归。实质意见是布局 fixture 的 ask 场景必须显式清空 `approvalProcessing`：生产状态处理用 Object.assign，省略属性会保留旧状态。已改为 null；此修正只影响合成验收工具。兼容读取、单一权威、测试接线及版本表均核查。

## 现场验收与边界

1. F5 启动开发宿主，新会话检查 `/` → 审批模式仅两项；`/` → 子代理模型 → 审批模型与其他模型选择交互一致，普通子代理设置独立；检查中英文和键盘焦点。
2. 临时工作区用 ask 准备文件/命令，验证 Apply/Discard 与逐条批准；用 delegate 验证 host_policy、独立 reviewer、单次人工等待/拒绝/停止，重复点击不重复执行。仅使用测试来源或另获授权的真实模型。
3. 用复制的旧会话分别检查冷启动、热 lane、历史 model_review 展示；重启不恢复批准、permit 或自动副作用。不得用真实用户数据作迁移试验。
4. `bun run build:test` 后运行 `node scripts/verify-approval-card-layout.cjs /tmp/keepseek-approval-card-layout.html`，在浏览器打开 HTML，点击 Run layout matrix；检查 current V2、legacy V1、ask、宽度/CSS zoom 与焦点。生成和语法检查已通过，浏览器矩阵未运行，CSS zoom 也不等于原生 VS Code zoom。
5. 在原生 Webview 手测首次 ready、输入/拖拽/@/编辑重发、会话/设置、Apply/Discard 和键盘/焦点。三个原生 Provider 的真实 endpoint 与其他操作系统需独立现场验证。

## 工作树与授权边界

最终工作树共 24 个变更路径：10 份文档（含导航和本报告）、6 个源码路径（含 1 个新增与 1 个删除）、5 个测试、2 个验收脚本及 1 个打包忽略规则。无全仓格式化；89 个测试文件仍全部由原 runner 显式导入。初始工作树干净；本次未触及 CHANGELOG、package 产品身份/版本/发布元数据或锁文件。未自动提交、打标签、推送、发布、安装扩展，未改真实用户存储、账号、SSH 或用户配置，未调用付费真实模型。
