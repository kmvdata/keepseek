# P1 人工验收清单与记录模板

2026-11-02，Asia/Shanghai。状态及本轮证据见 [现场报告](keepseek-p1-field-acceptance.md)。本清单是待执行合同，不代表下列现场样本已通过。

## 先确认执行对象

1. 等正在运行的日常任务安全结束；不要为验收打断它、清理历史或重装日常扩展。
2. 在当前源码上 `bun run compile`，使用现有 F5 开发方式，或使用独立的 Extension Host / 测试存储。开发宿主若没有既有账号就记录受阻，不复制凭据文件，不切换默认账号或审批模式。普通安装、F5、远程/profile 分别登记。
3. 在加载本轮代码的宿主命令面板执行 **KeepSeek: Runtime Diagnostics / 运行诊断**。记录 activationId、extensionUri、extensionMode（1=普通、2=开发、3=测试）、packageVersion、supportedRequestProtocolVersion、supportedToolSchemaSha256。后者是宿主当前默认全工具集合的 hash；合法的会话冻结/slim 工具集合可能有不同 hash。activationDiskSha256 只是激活时磁盘快照，不是 V8 内存证明；缺失 hash 为 null。
4. 新建 KeepSeek 会话再发送 S01；以该次请求实际 schema/协议为准。支持 V11 不代表旧热会话已经 V11。旧热会话只检查既有冷边界迁移，不直接改写。
5. 先完成 S01 和 S03，再按批推进其余任务。每批先声明本次最多物理尝试/总时间，不能把预算 0=不限解释为无限压测；达到现有更紧限制或本批停止条件立即停止。不要降低模型输出配置制造结果。

## 样本与固定质量检查

| sampleId | 可直接使用的用户目标 | 通过条件 | 停止条件 |
| --- | --- | --- | --- |
| S01 | 只读定位 CURRENT_PROVIDER_REQUEST_PROTOCOL_VERSION 与 buildProviderRequestProjection 的关系，给出路径、行号和一句结论，不修改或执行命令。 | 真实读取；常量为 11；不强制委派；请求输出上限遵守原配置。 | 最多 3 次物理尝试或 3 分钟；连接/鉴权失败停止本批。 |
| S02 | 只读追踪 KeepSeek 子代理从分工、隔离请求、结果交付到用量归集，给出各段源码证据与未证实部分。 | 观察 initial/scope_expanded 判断；支线划分及留主理由合理；父定点复核与验收。 | 最多 12 次物理尝试或 5 分钟；未完成如实记 partial/受阻。 |
| S03 | `/research` 只读检查 src/agent/subagents/profiles.ts 的 research 工具与深度限制，给出证据。 | 真实 research child、独立请求、必要摘要/ref；父验收；不能只答复已委派。 | 最多 12 次物理尝试或 5 分钟。 |
| S04 | `/review` 只读审查 src/agent/subagents/resultEnvelope.ts 对超限/partial 的处理，给 verdict、证据和不确定项。 | review child 只读；verdict 与源码一致；与无工具审批 reviewer 分开统计。 | 同上。 |
| S05 | 在测试副本中 `/proposal` 为 note.txt 准备一句说明文字的修改草案，不应用、不执行。 | proposal 只产生 DraftEdit；检查实际产物与引用；磁盘原文件 hash 不变；父采纳不等于 Apply。 | 最多 12 次物理尝试或 5 分钟；出现越权副作用立即停止相关样本。 |
| S06 | `/parallel` 分别只读核查 delegation.ts 候选依赖门禁与 profiles.ts 的 research 权限，综合证据。 | 一批至少两个相互独立 child，每个均有状态/摘要/ref；父逐项验收。同批依赖拒绝另用离线 fixture 覆盖。 | 最多 16 次物理尝试或 8 分钟；不提高并发/深度。 |
| S07 | 用无敏感项目标记和选中 profile 执行一级及二级调查。 | 从真实请求确认项目约束/选中 profile 进入、父历史/兄弟结果/其它 Skill 未进入；二级 nested-read；续接只加载自己历史。 | 先使用离线继承回归；现场最多 12 次尝试或 5 分钟。 |
| S08 | 检查小结果与分页大结果；有缺失时明确 partial，再针对缺失项补查。 | 页游标连续无重叠；零容量明确阻塞；partial 不可 adopt；complete 补查经全文/绑定校验才能 supersede，旧审计保留。 | 造损坏/错配/失败仅用离线 fixture；不得破坏真实记录。 |
| S09 | 已有实际任务：只读核对用量详情中的子代理统计及性能数字的来源。 | 本轮只观察到 V10 活跃任务的保存慢点，不能作为新 V11 通过；后续在重载后的新会话核对同目标。 | 不为验收延长现有任务；不把重复调查当长任务目标。 |
| S10 | 正常工作中只读审查三协议上下文投影、缓存前缀和压缩失败回退，形成证据表。 | 自然多轮、多材料；若发生压缩，登记同口径前后真实投影、保护集与净释放；没触发就记未覆盖。 | 最多 20 次物理尝试或 15 分钟；不要人为反复读取。 |
| S11 | 正常工作中只读审查 evidence 幂等、Epoch 和恢复，形成风险与源码映射。 | 观察父/child 累计输入区别、重复读与协调成本；自然发生的 Epoch 才算现场覆盖。 | 同上；不修改全局阈值、输出、thinking 或任务预算。 |
| S12 | 测试存储中停止、Continue、重载恢复并切换旧/新会话，检查 UI。 | 未验收状态/ref、预算/usage、完成证据不丢、不重复执行；新授权不复用旧 permit。首次 ready、输入焦点、会话切换、用量/委派详情可操作。 | 故障注入仅 fixture；真实副作用不参与；Continue/重载/冷迁移分别记录。 |

不以 child 数量或比例评分。S02、S10、S11 的语义检查至少包含：目标是否回答、每项源码是否支持结论、反例/未完成项是否披露、父是否核验重要事实、是否重复取证。hash/JSON 接受不能代替这些检查。

## 可执行工具

从仓库根目录执行；真实模型脚本只读取已有账号并通过 accountResolver 在内存解析，不接受密钥环境变量，不保存账号文件。模型、thinking、输出等来自现有 workspace + user 配置；独立 timebox 是额外停止条件，不修改配置。它使用真实 AgentLoop/Provider/SubagentRuntime/工具/临时存储，但 VS Code API 为 stub，未走完整 Webview/Provider 协调入口。slash 字段由 harness 传入，不能证明 UI 解析生效。

```sh
bun run build:test
node scripts/field-acceptance-live.cjs \
  "$HOME/Library/Application Support/Code/User/globalStorage/keepseek.keepseek" \
  smoke /tmp/keepseek-smoke.json
```

检查 smoke 的状态、实际答案与 usage 后才执行下一批；网络/鉴权失败不要机械重试。以下两批各限制 12 次传输，追加合计最多 24 次；总计达到 15 分钟也应停止。仅在确实需要且在既有预算内分开执行：

```sh
node scripts/field-acceptance-live.cjs \
  "$HOME/Library/Application Support/Code/User/globalStorage/keepseek.keepseek" \
  investigation /tmp/keepseek-investigation.json 12
node scripts/field-acceptance-live.cjs \
  "$HOME/Library/Application Support/Code/User/globalStorage/keepseek.keepseek" \
  roles /tmp/keepseek-roles.json 12
```

脚本将本轮新测试答案与 checkpoint 存在返回的临时目录，供语义核对；公开报告只取脱敏数字、身份与 hash。现有私人历史不进入该脚本。每个批次另建隔离存储；这不是续接/重启验收。

离线 / 只读工具：

```sh
node --test scripts/field-acceptance-audit.test.cjs
node scripts/field-acceptance-audit.cjs STORAGE_DIR /tmp/keepseek-audit.json TRACE_BASE
node scripts/benchmark-field-result-acceptance.cjs > /tmp/keepseek-result-acceptance.json
```

TRACE_BASE 是明确指定的 `run-....jsonl` 路径。audit 只读 child summary/父账本、perf sidecars，以及首个请求的 schema 投影；不导出消息正文或私有 child graph。现有旧 combined 为取得旧摘要仍需解析布局。数据正在变化时是非原子快照，不声称停机一致性。

## 每任务记录模板

复制以下 JSON，一项任务一份；未知一律 null，未执行写 `not_run`，勿填假零。

```json
{
  "sampleId": "Sxx",
  "goal": "可判定完成的目标",
  "acceptanceChecks": [],
  "environment": {
    "host": "installed|F5|isolated|headless-stub",
    "activationId": null,
    "extensionUri": null,
    "buildSourceHash": null,
    "head": null,
    "dirtyDiffHash": null,
    "requestProtocolVersion": null,
    "toolSchemaSha256": null,
    "mainSourceId": null,
    "mainModelId": null,
    "childModels": [],
    "thinking": null,
    "maxOutputTokens": null,
    "requestTimeoutMs": null
  },
  "identity": {"sessionId": null, "taskId": null, "runIds": [], "childIds": [], "requestAttemptPairs": []},
  "limits": {"existingBudget": null, "sampleMaxAttempts": null, "sampleMaxMs": null, "stopCondition": ""},
  "delegation": {"assessed": null, "candidates": null, "batches": null, "newChildren": null, "continued": null, "reused": null, "gateRejections": [], "parentDecisions": []},
  "quality": {"goalSatisfied": null, "sourceChecks": [], "missing": [], "semanticReview": "not_run"},
  "timeMs": {"wall": null, "active": null, "sessionActive": null, "userWait": null, "approvalWait": null, "providerUnion": null, "storageUnion": null, "providerStorageOverlap": null, "fullAcceptance": null},
  "context": {"inputBefore": null, "inputAfter": null, "netReleased": null, "protectedMessages": null, "epochActuallyObserved": false},
  "usage": {"physicalAttempts": null, "usageResponses": null, "missingUsage": null, "parentInput": null, "childInput": null, "taskCumulativeInput": null, "output": null, "cacheHit": null, "actualCost": null, "referenceCost": null},
  "evidencePaths": [],
  "evidenceLevels": [],
  "result": "not_run|pass|fail|blocked|partial",
  "blockers": [],
  "nextAction": ""
}
```

时长并集不能相加成总时长；特别是父等待包含 child Provider 时间。累计输入不是单次窗口；参考费用不是实际费用。没有 usage 的尝试保持未知。

立即反馈：错误 adopt/错误完成、越权修改或执行、完成工具重复执行、恢复后重复账单或预算归零、结果越 scope 可读、hash 损坏仍采纳。性能反馈优先附 activationId、新旧协议、runId、perf-index 与脱敏账本计数；不要贴密钥或完整私人 trace。
