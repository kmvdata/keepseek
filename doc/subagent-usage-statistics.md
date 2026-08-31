# 主会话与子代理用量统计

## 使用方式

输入框右侧的上下文圆环保留 hover/focus 快速提示。使用过子代理的会话会显示会话实际 Tokens、主会话侧、子代理、任务数、隔离中间上下文估算及已计价费用；没有子代理时保留原有简洁用量展示。

点击圆环或按 Enter/Space 打开“用量详情”，Esc 或关闭按钮退出并恢复焦点。窄侧栏使用单列卡片，详情独立滚动。界面提供中英文：

1. **实际用量**：可切换本次与本会话累计；主会话侧/子代理/历史未归因拆分、占比、请求、缓存数据覆盖、各币种费用。
2. **主会话上下文减负**：隔离中间上下文、回传主会话、上下文隔离率，以及完成/失败/停止任务数。
3. **子代理明细**：按模型与账号来源、工作类型（profile）与通道（lane）汇总；最近 50 次运行的状态、模型、Token、费用和耗时。不展示私有工作内容。

完成统计在子代理终态更新；运行中的 Provider 用量先实时进入实际用量。旧会话没有运行摘要时，任务数和上下文估算显示“未记录”，不伪造零消耗或节省值。

## Provider 实际数据

- 会话总计取已有 Provider usage 汇总。
- 主会话侧仅累加已归因的 executor、retry、continuation、summary、background、retrieval、router。
- 子代理仅取 `bySource.subagent`，不能用会话总量减去子代理来推断主会话侧。
- 历史未归因是会话总量减去所有已知来源的非负差额。Token、请求、缓存和各币种费用分别处理；费用差额也可能独立于 Token 归因存在。
- 实际 Token 绝不由字符数补算；没有收到 Provider usage 的请求不能推断为免费。失败/停止前已收到的 Provider usage 仍保留。
- 请求次数统计收到 Provider usage 的调用；仅知道发生过的重试尝试仍保留在原运行记录中，不伪造成一笔零 Token 的实际用量。若失败响应附带 usage，也会被观察并保留。
- 费用使用请求时已有的计价能力与 Provider Token 用量。CNY、USD 等在 `costByCurrency` 中独立累加、分别显示，不做汇率换算，不跨币种求和。没有可用价格的请求保持不可计价；部分请求未计价时明确提示费用不完整。小额费用显示最多六位小数，正数小于该精度显示上界而非零。
- 缓存命中率仅基于报告过的命中/未命中 Token；同时显示有数据和缺失数据的请求数。没有缓存信息不能显示为 0% 命中。旧的来源级标量费用仅在所属币种唯一时继承，无法区分币种的旧费用保持未归因。

固定子模型按 `sourceId + modelId` 聚合。不同账号即使 `modelId` 相同也不合并；不会拿主模型当前价格倒算子模型费用。

## 本地上下文估算

每次子代理使用最后一次有效 `onUsageEstimate` 的本次新增分类：

```text
隔离中间上下文 = Σ(toolCallTokensEstimate + toolResultTokensEstimate + reasoningTokensEstimate)
回传主会话 = Σ(根主代理实际接受的三个子代理工具结果估算)
上下文隔离率 = 隔离中间上下文 / (隔离中间上下文 + 回传主会话)
```

system prompt、工具 schema、任务输入、继承历史和输出/安全预留不属于隔离中间上下文。继续运行已有子代理时，只统计新一轮内部工作。Provider 校准通知保留本次分类计数，不会清零；final/continuation 的本地可见推理也属于内部工作。估算器版本为 `local-context-v1`。

回传观察点位于 `shapeToolResult` 和工具结果 Token/上下文窗口预算检查之后。Chat Completions 估算最终 tool message；Responses/Anthropic 估算实际原生输出投影的增量；DSML 兼容通道计入实际接受结果的包装，混合批次仅分配子代理部分。首次委派、并行包装和后续分页都会计入，嵌套子代理向上一级子代理回传不算根主会话回传。预算拒绝的原结果不计入。

所有估算显示 `≈`，分母为零不显示百分比。界面明确说明：

> 这是对子代理内部中间工作与主会话实际回传内容的本地估算，不等于账单 Token 节省值。

不展示禁用子代理的反事实 Token、净节省、按未来轮数放大的节省或“便宜子模型节省金额”。这些指标没有对照实验与历史价格快照支持。Provider 未暴露的内部推理量也不能由本地文字精确还原。

## 持久化与隐私边界

- `src/agent/subagentUsageStats.ts` 集中纯函数：拆分、公式、归一化、幂等更新和安全视图模型；Webview 只格式化和渲染。
- `ChatSession.subagentUsageStats` 为可选 schema-v1 字段；`chatSessionStore.ts` 使用白名单归一化，旧会话缺失字段可正常打开。
- 子代理每个 Provider 事件先在本地累积，再统一生成 completed/failed/stopped 摘要。嵌套事件向根转发，但不重复计入上一级子代理自身摘要。
- Provider 协调者同步读取最新会话统计后应用更新，无跨 await 的旧快照覆盖；同一 `subagentId` 重复回调不重复累计。
- 明细上限 50；累计模型/工作类型/状态/估算不因裁剪减少。ID-only 账本保留幂等性，裁剪后的终态被视为不可变；同 ID 的迟到重复回调忽略。
- `StoredSubagentMetadata.stats` 只含统计，不改变工具结果的既有 usage 序列化。Webview 的进度白名单排除 task/result/error 摘要，消息投影排除 `toolRounds` 与 Provider replay；子代理私有上下文仍仅存在独立本地存储中。
- 协议 v1-v5 历史兼容，`SUBAGENT_PROTOCOL_VERSION`、三个工具 schema、system prompt、Provider 请求内容和缓存前缀不变。

## 验证

`test/subagentUsageStats.test.ts` 覆盖分币种/旧数据/缓存完整性、真实来源拆分、模型账号分组、幂等并发、明细裁剪、估算公式、安全持久化/视图、翻译与脚本语法。

`test/subagentUsageRuntime.test.ts` 使用模拟 Provider 验证实际接受边界、分页/并行、嵌套排除、预算拒绝、失败/停止已发生用量、嵌套事件不重复计费、最后有效估算及观察回调不改变请求字节。原有协议/缓存、模型设置和存储测试仍全量运行。

```sh
npm run compile
npm run build:test
npm test
```
