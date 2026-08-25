# KeepSeek Agent 行为评测

这套评测用于比较不同 Provider、工具调用能力等级和 Thinking 模式下的 Agent 行为。它与单元测试分工明确：单元测试守护确定性的 prompt、schema、投影与安全状态机；这里衡量模型是否真的选择了合适的工具、完成任务并准确汇报状态。

## 文件与运行方式

- `cases.json`：离线场景、期望工具边界、完成/证据信号和确定性模拟工具结果。
- `src/agent/behaviorEvaluation.ts`：记录格式、验证器和评分规则。
- `scripts/run-agent-behavior-live.js`：显式 opt-in 的可选 live runner；使用当前编译产物中的真实 system prompt 与 v3 工具 schema，工具执行由只读 fixture 模拟，绝不写工作区。
- `scripts/score-agent-behavior.js`：读取 JSONL 记录，按 Provider / 模型 / 工具能力等级 / Thinking 配置聚合比较。

离线契约测试不联网、不读取密钥：

```bash
bun run build:test
bun run test
```

Live 评测必须显式设置 `KEEPSEEK_EVAL_LIVE=1`，凭据只从进程环境读取且不会写入记录。示例：

```bash
bun run compile
KEEPSEEK_EVAL_LIVE=1 \
KEEPSEEK_EVAL_PROTOCOL=chat-completions \
KEEPSEEK_EVAL_PROVIDER=openai-compatible \
KEEPSEEK_EVAL_BASE_URL=https://provider.example/v1 \
KEEPSEEK_EVAL_API_KEY=... \
KEEPSEEK_EVAL_MODEL=model-id \
KEEPSEEK_EVAL_TOOL_CAPABILITY=strong \
KEEPSEEK_EVAL_THINKING=false \
node scripts/run-agent-behavior-live.js > /tmp/keepseek-eval.jsonl

node scripts/score-agent-behavior.js /tmp/keepseek-eval.jsonl
```

可用 `KEEPSEEK_EVAL_SCENARIOS=id-1,id-2` 限定场景。协议支持 `chat-completions`、`openai-responses` 与 `anthropic-messages`；Anthropic Thinking 的具体请求对象通过 `KEEPSEEK_EVAL_ANTHROPIC_THINKING_JSON` 显式提供，避免猜测网关能力。

## 记录和评分

每条 JSONL 记录都包含配置、工具调用顺序、成功/错误类型、pending DraftEdit 数、验证状态、输入/输出/工具结果 token、工具轮次、耗时和预算停止状态。评分总分 100：任务完成 25、证据 15、修改授权 15、写盘/验证声明准确性 15、工具效率 10、澄清行为 10、预算后部分结果 10。

评分器另外直接报告：错误 DraftEdit、虚假写盘/验证声明、无效与重复工具调用、无目的全仓库扫描、不必要澄清、token、轮次、耗时和部分结果质量。不同模型配置应重复运行多次并保留原始 JSONL；不要把单次采样当成稳定结论。

Live runner 不会应用 DraftEdit，也不会执行真实 validation。它返回与 KeepSeek 状态机一致的确定性 fixture，并把 DraftEdit 后的 validation 尝试标为 `pending_changes_require_apply`。因此它适合比较模型决策行为，不替代扩展内的端到端安全测试。
