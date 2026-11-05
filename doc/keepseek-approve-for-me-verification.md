# KeepSeek「帮我审批」统一合同与验收

版本：2026-11-05。开发基线：`3bd161c`。本文件替代旧“delegate 全程不转人工”和独立 model_review 的活动合同；旧验收报告保留历史事实。

## 不变式与路由

| 条件 | 路由与真实结果 |
| --- | --- |
| 不可信、受保护目标、无效启动身份、hash/基线冲突、脏编辑器、取消等硬失败 | 阻止启动；人工按钮不能覆盖 |
| 常规项目操作符合宿主规则 | `host_policy` 直批，明确未经模型审查 |
| 精确操作可审查、宿主不能直批 | 独立、一次性、无工具审批模型 |
| approve | 复核配置与范围，消费审批记录，SafeFileEditor 或单次 DraftRun permit 执行 |
| needs_user | 一个精确宿主请求；仅批准本次／拒绝。模式仍是帮我审批 |
| unavailable | 如实记录解析、配置、超时、接口或响应格式失败；可以精确请求用户决定，不能显示成模型安全拒绝 |
| deny | 原操作不得人工强行运行；有实质更安全的路径时在同一任务内有界续跑，无路则停止 |

继续复用既有预检修正、受限 Python 语法校验替代、已授权替代路径、Git 独立诊断和结果核验；共享最多两项修正历史及原任务时间、费用和请求预算。对可以立即作出精确决定的操作，直接呈现必要的单次请求，不为避免人工重复调查、重复送审或无限重建草稿。明确安全拒绝的原 hash 保留；拒绝历史从审计重建，needs_user / unavailable 不计安全拒绝。

进程使用扩展宿主账号权限，没有 OS 沙箱。`shell:false`、绑定 launcher/cwd/env、静态目标检查和 reviewer 均不等于操作系统隔离。

## 模式、模型与迁移

- 仅提供 **请求批准 / Ask for approval**、**帮我审批 / Approve for me**。内部保留 ask / delegate。伪造 `setApprovalMode:model_review` 无效。
- 旧 model_review 当前设置降为 ask，提示旧模式已合并；历史审批来源仍标记“旧版模型审批”，历史消息不重写。已有 delegate 继续使用帮我审批。
- `/` 菜单中，审批模式子菜单仅含 **请求批准 / Ask for approval** 和 **帮我审批 / Approve for me**。**子代理模型 → 审批模型 / Approval model** 与其他类型共用内嵌展开列表、来源分组、选中标记和键盘导航，可跟随主模型或选择固定账号与模型。该项独立保存到用户级审批配置，不继承或修改普通子代理默认值。同名模型按 sourceId 区分。保存后复读确认，失败有确定反馈；忙碌、已有审批或并发选择时不更改。
- 配置键继续为用户级/application `keepseek.autoApprovalReviewer`；工作区值不参与目的地选择。固定模型不可用不会回退到其他模型或普通子代理配置。
- follow-main 优先使用执行段实际主模型及来源的内存快照；恢复后使用该执行段保存的模型身份重新解析，不能跟随后来 UI 选择的另一个模型。
- 普通子代理 default 及 research/review/proposal 原配置均保留；review 显示为“代码审查 / Code review”。只读与仅提案权限不变。审批用量仍为 approval reviewer，不计普通 child 调用。
- 新模式尾注只追加到新 user 消息。新会话和明确启用 delegate 时使用协议/工具描述版本 13；版本 1–12 的 system、工具和已有历史字节保留。三协议仍使用同一 projection 与 native replay。

## 单次人工请求与恢复

请求以随机宿主 token 关联 session、rootTask、segment、target、action kind、actionHash/specHash、范围指纹、必要启动快照与 runtime；Webview 消息不携带可自行解释为授权的命令。宿主同时比对活请求和保存快照，先消费回调，再持久化决定；重复、跨任务、跨会话、旧 runtime 或失配消息无效。

批准后单独记 user_click，并用 priorReviewId / userRequestId 关联原审查或故障，不覆盖原事实。执行前仍检查任务、信任、取消、范围、启动身份、hash、编辑器和基线。文件和命令仍走原执行链，实际结果交回同一逻辑任务；失败或未知副作用不重跑。拒绝不会执行依赖操作，也不会反复询问该操作；可证明独立的获准查询仍可运行。

外部读取先审 URI 元数据，不预读未授权内容；批准仅提供一次精确文件读取，执行后撤销，不添加永久引用权限，符号链接不能借此扩大目标。外部编辑/命令按操作身份与范围指纹授予内存许可，读授权不能代替写/删除。Git 的一次同意绑定已核实仓库、真实目的地、非强制 argv 与精确 refs，并仅提供该操作所需的查询/推送核验范围，不写入长期 gitReleaseGrants，也不改 SSH 配置。

等待期间暂停有效执行计时和安全执行时钟，保留预算。关闭 Webview 不取消宿主请求，重开可处理；Stop、新任务、会话/模式/配置变化、取消与信任检查使旧请求无效。请求按现有配置的超时上限过期，过期不算用户安全拒绝。

`pendingApproval` v1 只用于解释和恢复；normalize 删除 runtime、完整活请求与回调，并将 waiting 标为 interrupted。`approvalProcessing` v2 的等待恢复为 blocked，经用户主动恢复才重建预检/审查与新请求，不自动消费旧批准。旧 v1 delegate 的中断/等待记录继续转为 stopped，旧 model_review 批次没有恢复执行入口。成功或副作用未知的操作不会因重启重放。

## 可复制现场步骤

以下仅在可丢弃目录执行。开发仓库的提交、标签、远端及用户 SSH 配置均不参与验证。

```bash
acceptance_root=$(mktemp -d)
cd "$acceptance_root"
acceptance_root=$(pwd -P)
mkdir project outside
printf 'external reference\n' > outside/reference.txt
cd project
git init
git config user.name 'KeepSeek Acceptance'
git config user.email 'acceptance@example.invalid'
printf 'initial\n' > sample.txt
git add sample.txt
git commit -m 'acceptance fixture'
git init --bare "$acceptance_root/remote.git"
git remote add origin "$acceptance_root/remote.git"
printf '{"scripts":{"compile":"node --version","lint":"node --version","test":"node --version"}}\n' > package.json
```

1. 开发仓库 `bun run compile` 后 F5 启动 Extension Development Host，打开上述 project 并信任。配置有效主模型，核对首次 ready、设置恢复、中英切换和两种审批模式；菜单键盘展开、返回和焦点应可用。
2. 在子代理模型菜单分别记录 default/research/review/proposal。从该菜单最后的“审批模型”行展开列表，选择具体账号模型或“跟随主模型”，确认勾选、折叠和焦点返回与其他类型一致，不弹出原生选择器；左右方向键可展开/收起。再修改子代理 default 和代码审查模型，确认两套配置不串用。固定审批账号不可用时应显示不可用；用户级配置保持原选择，工作区同名配置无效。展开“审批模式”应仅显示两个选项；切换中英文、收窄侧栏后，审批模型文字仍应横向排列，长名称省略且悬停可见完整值。
3. 请求批准下创建 sample2.txt、准备版本查询，点击前零副作用，逐项批准后执行。帮我审批下进行常规编辑、Git status/diff 和固定 compile/lint/test：正常直批，无 reviewer 和残留确认按钮。
4. 帮我审批下运行无害内联 Node 或显式 shell，创建项目内标记文件。核对独立 reviewer 账号、模型、决定、一次真实结果和自动续跑；同轮子代理记录不能增加一次普通 child 调用。
5. 请求创建 outside/confirmed.txt，或读取未附加的 outside/reference.txt。预期只向 reviewer 提供获准材料和 URI 元数据，出现一次精确授权请求；详情显示实际文件操作、命令/cwd/目标。仅批准本次后只执行一次，模式仍是帮我审批，后续其他外部目标不能继承权限。另一次选择拒绝，目标与依赖操作不执行。
6. 用用户设置暂时填写不存在的固定审批 sourceId/modelId，再提交需要审查的无害操作。预期“自动审查未完成”及真实配置失败信息，零 reviewer 网络请求；用户单次批准后仍按原硬检查执行。恢复有效模型。超时、无效 JSON 和确定 needs_user/deny 的可重复注入见自动化测试，真实模型返回不可人为保证。
7. 人工等待时 Stop、切换 ask、发起新任务或切换会话；旧按钮不能产生副作用。另一次等待时关闭并重开 Webview，原请求仍能处理；重载窗口后旧 token/批准不可用，仅保留中断说明，主动恢复会重新预检并创建新请求。无 Webview 时常规宿主工作继续。
8. 把侧栏收窄至约 220px，使用长中文目标和无空格 URI。确认说明独占可换行区域，操作按钮不把标题挤成逐字列；精确详情可滚动，键盘可访问。
9. 在临时仓库更改 sample.txt，原始回归输入保持：**对当前代码进行一个 git commit 提交，然后发布一个 v0.5.1的tag**。先核对原文的本地与远端意图；未明确远端范围不默认发布。查看分离的 stage/commit/tag 及真实 HEAD/tag 核验，已有目标不能重复创建。再明确要求向临时 origin 推送该精确 tag，测试缺少预授权时的单次同意/拒绝，以及已配置精确 gitReleaseGrants 时的自动非强制推送。查询临时裸远端核对 object/peeled refs；不要使用真实远端。
10. 调用 research、代码审查和 proposal，确认原有模型继承、只读与提案权限及用量来源；proposal 不能自行批准、Apply 或执行。

## 关键代码

| 文件 | 改动 |
| --- | --- |
| `src/agent/approvalMode.ts`、`shared/types.ts`、会话存储 | 两模式、旧设置降为 ask、版本 13 边界 |
| `src/approvals/approvalPolicy.ts`、`approvalReviewer.ts`、`approvalReviewTypes.ts` | 单一 reviewer、严格三决定协议、故障区分、统一分流 |
| `src/approvals/manualApproval.ts`、`approvalProcessing.ts`、Provider | 精确单次请求、状态/计时、撤销、重启解释与主动恢复 |
| `src/agent/runner.ts`、`agent/tools/workspaceTools.ts` | 固定验证与一次外部读取的真实审批/执行交接 |
| `src/runs/gitReleaseAuthorization.ts`、授权 preflight | 精确远端单次同意，保留原发布检查和结果核验 |
| `src/webview/input/commandMenu/approval.ts`、`commandMenu/models.ts`、`webview/script.ts`、i18n | 两模式、子代理菜单中的独立审批模型、真实等待和审计来源 |
| `test/approval*.test.ts`、`taskApprovalIntegration.test.ts` 及相邻测试 | 回归与真实临时工作区/仓库/远端验证 |

## 验证边界与记录

自动化使用真实 Provider/Runner/审批存储、SafeFileEditor、DraftRun 执行器和临时 Git 仓库/裸远端；reviewer 网络响应可注入。验证旧审计读取、模式/菜单/脚本、真实文件副作用、Git 发布、拒绝、故障、计时、一次性消费、取消和恢复。测试真实执行不等于真实模型或 F5 图形验收。

本次实际环境：macOS / Darwin x86_64，Node v24.15.0，Bun 1.3.12。

| 检查 | 结果 |
| --- | --- |
| `bun run compile` | 通过 |
| `bun run lint` | 通过 |
| `bun run build:test` | 通过 |
| `bun run test` | 1015 项，1014 通过、0 失败、1 跳过，约 391 秒 |
| 最终审阅后的定向复核 | 审批/模型/卡片/Runner 87 项通过；原始中文 Git 意图回归 1 项通过 |
| `git diff --check` | 通过 |
| 基线逐字节比较 | 中英文 system、工具定义，版本 1–12 全部与 HEAD 基线一致 |
| 复制执行本文临时验收夹具 | 通过；临时仓库、本地身份、规范裸远端路径及三项脚本有效，验证后清理 |

跳过的是既有本地故障服务器网络恢复测试：执行环境禁止监听本地端口，并非审批功能失败。最终全量运行包含精确人工请求、伪造/重复消息、计时、Stop、模式/任务/会话/信任/配置/基线/脏编辑器变化、关闭界面、重启、reviewer 超时/无效 JSON/固定配置失效、单次过期、安全拒绝后的更安全路径、普通子代理与审批模型独立，以及真实 Git 发布链。另对原始中文 Git 回归输入核实：本地 commit/tag 意图成立，未授予远端 push。

未发现阻塞本次实现交付的剩余项。真实付费模型、图形 F5（含真实几何布局和焦点）、Windows/Linux 现场未执行，仍须按上面步骤验证。静态范围分析及动态代码传递效果仍受既有能力限制，保留项目级信任和独立审查；未新增 OS 沙箱。本次没有修改 CHANGELOG.md，没有对开发仓库提交、打标签、推送、发布包或修改 SSH 配置，开发 HEAD 保持 `3bd161c`。
